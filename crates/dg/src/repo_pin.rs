//! `dg repo pin | unpin` (`docs/design/pin-and-fork-copies.md`): keep a copy of a public
//! repository's packs on your own storage and record a `packMirror` for each, so readers fall
//! back to your copy when the repository's own storage fails. `--follow` adds the repository
//! to `pins.toml`; `dg repo pin --all` copies what is new in every followed repository.

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context as _, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use forge_core::own_copy::{pin_profile_problem, OwnCopy};
use forge_core::pack_mirror::{
    delete_mirror, mirrors_by, record_mirror, require_support, DOC_PACK_MIRROR,
};
use forge_core::repo::RepoService;
use forge_core::rules::v2::Visibility;
use forge_core::storage::policy::git_config_scoped;
use forge_core::storage::{human_bytes, ExternalTarget, Profile, StoragePolicy, StorageProfiles};
use forge_core::user_error::{codes, UserError};

use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, plural, safe};

/// One `packMirror` with its `repo` reference (73.6M measured on sakura, 2026-10-05).
const MIRROR_CREDITS: u64 = 75_000_000;

/// The self-host guide, for a user with no storage of their own yet.
pub const SELF_HOST_GUIDE: &str =
    "https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/self-host.md";

/// `dg repo pin` arguments.
#[derive(Debug, Clone, Default, clap::Args)]
pub struct RepoPinArgs {
    /// The repository (`owner/name`).
    #[arg(required_unless_present = "all", conflicts_with = "all")]
    pub repo: Option<String>,
    /// The storage profile to keep the copy on (default: the first one in your storage
    /// policy that others can read).
    #[arg(long, value_name = "PROFILE")]
    pub storage: Option<String>,
    /// Also copy what is pushed later, whenever `dg repo pin --all` runs (from cron or a
    /// timer).
    #[arg(long)]
    pub follow: bool,
    /// Copy what is new in every followed repository, without asking.
    #[arg(long)]
    pub all: bool,
    /// Show what would be copied and recorded, without doing it.
    #[arg(long)]
    pub dry_run: bool,
}

/// Dispatch `dg repo pin`.
pub async fn pin(ctx: &Ctx, args: &RepoPinArgs) -> Result<()> {
    if args.all {
        return Box::pin(refresh_all(ctx, args.dry_run)).await;
    }
    let repo = args.repo.as_deref().context("repository required")?;
    let done = Box::pin(pin_one(
        ctx,
        repo,
        args.storage.as_deref(),
        args.dry_run,
        false,
    ))
    .await?;
    if args.follow && !args.dry_run {
        let entry = Followed {
            network: ctx.network_label(),
            signer: done.signer.clone(),
            repo_id: done.repo_id.clone(),
            repo: done.display.clone(),
            storage: done.storage.clone(),
            last_run: now(),
            last_error: done.failed.first().cloned(),
        };
        update_pins(&pins_path()?, |file| file.upsert(entry))?;
    }
    let mut body = done.json();
    body["following"] = json!(args.follow && !args.dry_run);
    if !done.failed.is_empty() {
        return Err(crate::errors::reported(
            UserError::new(codes::PARTIAL, "some packs could not be pinned")
                .fix("run the same command again to retry them"),
            body,
        ));
    }
    let follow = args.follow && !args.dry_run;
    ctx.emit(body, || {
        if follow {
            println!("Following: `dg repo pin --all` copies what is pushed later (run it from cron or a timer).");
        }
    });
    Ok(())
}

/// What one pin did.
struct Pinned {
    signer: String,
    repo_id: String,
    display: String,
    storage: String,
    copied: usize,
    already: usize,
    bytes: u64,
    spent: u64,
    failed: Vec<String>,
    dry_run: bool,
    planned: usize,
    estimate: u64,
    price: crate::fmt::Price,
}

impl Pinned {
    fn json(&self) -> Value {
        json!({
            "status": if self.dry_run { "planned" } else if self.failed.is_empty() { "pinned" } else { "partial" },
            "packsPlanned": self.planned,
            "estimate": cost_json(self.estimate, self.price),
            "repo": self.display,
            "repoId": self.repo_id,
            "storage": self.storage,
            "packsCopied": self.copied,
            "packsAlready": self.already,
            "bytes": self.bytes,
            "failed": self.failed,
            "cost": cost_json(self.spent, self.price),
        })
    }
}

/// The profile a pin stores on: `name`, else the first in the storage policy others can read,
/// else the only such profile.
fn pin_storage(name: Option<&str>) -> Result<(String, Profile)> {
    let profiles = StorageProfiles::load()?;
    if let Some(name) = name {
        let profile = profiles.get(name).ok_or_else(|| {
            UserError::new(
                codes::STORAGE_CONFIG,
                format!("no storage profile {name:?}"),
            )
            .fix("`dg storage list` lists yours")
        })?;
        if let Some(why) = pin_profile_problem(&profile) {
            bail!(UserError::new(
                codes::STORAGE_CONFIG,
                format!("cannot pin to {name}: {why}")
            ));
        }
        return Ok((name.to_string(), profile));
    }
    if let Some(found) = policy_external(&profiles)
        .into_iter()
        .find(|(_, p)| pin_profile_problem(p).is_none())
    {
        return Ok(found);
    }
    let usable: Vec<(&String, &Profile)> = profiles
        .profiles
        .iter()
        .filter(|(_, p)| pin_profile_problem(p).is_none())
        .collect();
    match usable.as_slice() {
        [(name, profile)] => Ok(((*name).clone(), (*profile).clone())),
        [] => bail!(
            UserError::new(codes::NO_STORAGE, "set up storage of your own to pin to")
                .fix("`dg ipfs up` runs an IPFS node on this machine")
                .fix("or `dg storage add` adds a bucket or a node you run elsewhere")
                .note(format!("to run one on a NAS or server: {SELF_HOST_GUIDE}"))
        ),
        many => bail!(
            UserError::new(codes::USAGE, "choose the storage to pin to").fix(format!(
                "pass --storage with one of: {}",
                many.iter()
                    .map(|(n, _)| n.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        ),
    }
}

/// The external profiles of the storage policy in effect here, in policy order.
fn policy_external(profiles: &StorageProfiles) -> Vec<(String, Profile)> {
    let list = git_config_scoped("dash.storage").map(|(_, v)| v);
    StoragePolicy::from_git_values(list.as_deref(), None, None)
        .ok()
        .filter(|p| !p.is_platform_only())
        .and_then(|p| p.resolve(profiles).ok())
        .map(|r| r.external)
        .unwrap_or_default()
}

/// The profile a fork copies its parent's packs to: `name`, else the first external one in the
/// storage policy that others can read; `None` to fork by reference.
pub fn fork_storage(name: Option<&str>, no_copy: bool) -> Result<Option<(String, Profile)>> {
    if no_copy {
        return Ok(None);
    }
    if name.is_some() {
        return pin_storage(name).map(Some);
    }
    let profiles = StorageProfiles::load()?;
    Ok(policy_external(&profiles)
        .into_iter()
        .find(|(_, p)| pin_profile_problem(p).is_none()))
}

/// The profile whose public address the first copy of one of `owner`'s `manifests` is at: where
/// a fork's earlier packs were copied, so a sync copies the new ones there too.
pub fn storage_holding(
    manifests: &[forge_core::repo::PackManifestInfo],
    owner: &str,
) -> Option<(String, Profile)> {
    let profiles = StorageProfiles::load().ok()?;
    let firsts: Vec<&str> = manifests
        .iter()
        .filter(|m| m.owner_id == owner)
        .filter_map(|m| m.uris.first().map(String::as_str))
        .collect();
    profiles
        .profiles
        .into_iter()
        .filter(|(_, p)| pin_profile_problem(p).is_none())
        .find(|(_, p)| {
            let base = match p {
                Profile::S3(s) => s.public_url.as_deref(),
                _ => p.public_gateway(),
            };
            base.is_some_and(|b| {
                let b = format!("{}/", b.trim_end_matches('/'));
                firsts.iter().any(|u| u.starts_with(&b))
            })
        })
}

/// An [`ExternalTarget`] for the named profile.
pub fn target(name: &str, profile: &Profile) -> Result<ExternalTarget> {
    Ok(ExternalTarget::from_profile(
        name,
        profile,
        &forge_core::storage::http_client(),
    )?)
}

#[allow(clippy::too_many_lines)]
async fn pin_one(
    ctx: &Ctx,
    repo: &str,
    storage: Option<&str>,
    dry_run: bool,
    unattended: bool,
) -> Result<Pinned> {
    let (storage, profile) = pin_storage(storage)?;
    let s = Session::open(ctx, repo).await?;
    if s.repo.visibility == Visibility::Private {
        bail!(UserError::new(
            codes::PRIVATE_UNSUPPORTED,
            format!(
                "{} is private: readers never use pinned copies of it",
                s.repo.display()
            )
        )
        .fix(format!(
            "a member can keep a backup on an IPFS node: `dg ipfs pin {}`",
            s.repo.display()
        )));
    }
    let mirrors = s
        .client
        .fetch_contract(s.repo.forge().home(DOC_PACK_MIRROR))
        .await?;
    require_support(&mirrors)?;
    let me = s.identity.id();
    let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
    let manifests = svc.read_pack_manifests(&s.repo).await?;
    let roles = svc
        .copy_roles(&s.repo)
        .await
        .context("reading the repository's members")?;
    let mine: std::collections::BTreeSet<String> = mirrors_by(&s.client, &mirrors, &me)
        .await?
        .into_iter()
        .filter(|m| m.repo_id == s.repo.id())
        .map(|m| m.pack_hash)
        .collect();
    let all = forge_core::own_copy::pin_groups(&manifests, &roles);
    let (already, todo): (Vec<_>, Vec<_>) = all
        .into_iter()
        .partition(|copies| mine.contains(&hex::encode(copies[0].pack_hash)));
    let bytes: u64 = todo.iter().map(|c| c[0].size_bytes).sum();
    let estimate = MIRROR_CREDITS * todo.len() as u64;
    let price = ctx.fiat_price();
    let display = s.repo.display();
    let mut out = Pinned {
        signer: me.clone(),
        repo_id: s.repo.id().to_string(),
        display: display.clone(),
        storage: storage.clone(),
        copied: 0,
        already: already.len(),
        bytes,
        spent: 0,
        failed: Vec::new(),
        dry_run,
        planned: todo.len(),
        estimate,
        price,
    };
    if !ctx.json && (!unattended || !todo.is_empty()) {
        println!(
            "Pin {} on {storage}: {} ({}) to copy, {} already pinned · {}",
            safe(&display),
            plural(todo.len(), "pack"),
            human_bytes(bytes),
            already.len(),
            cost_line(estimate, price)
        );
    }
    if todo.is_empty() || dry_run {
        return Ok(out);
    }
    if !unattended {
        ctx.confirm_or_cancel(&format!("Pin {display}?"))?;
    }
    let copier = OwnCopy::new(
        &svc,
        &s.repo,
        &manifests,
        roles,
        target(&storage, &profile)?,
    )
    .await?;
    let engine = forge_core::profile::engine(&s.client, &s.identity, &s.bridge)?;
    let before = s.balance().await;
    for (i, copies) in todo.iter().enumerate() {
        let hash = hex::encode(copies[0].pack_hash);
        let short = &hash[..12];
        let step = async {
            let (stored, from) = copier.copy(copies).await?;
            let uris = copier
                .recordable(&stored, &hash, copies[0].size_bytes)
                .await
                .ok_or_else(|| anyhow::anyhow!("{storage} returned no address others can read"))?;
            record_mirror(&engine, &mirrors, &s.repo, &hash, &uris).await?;
            anyhow::Ok((from, uris))
        };
        match step.await {
            Ok((from, uris)) => {
                out.copied += 1;
                if !ctx.json {
                    println!(
                        "  [{}/{}] {short} {} · from {} → {}",
                        i + 1,
                        todo.len(),
                        human_bytes(copies[0].size_bytes),
                        safe(&from),
                        safe(&uris.join(", "))
                    );
                }
            }
            Err(e) => {
                let why = said(&e);
                if !ctx.json {
                    eprintln!("  [{}/{}] {short} failed: {why}", i + 1, todo.len());
                }
                out.failed.push(format!("{short}: {why}"));
            }
        }
    }
    out.spent = s.spent_since(before).await;
    if !ctx.json {
        println!(
            "✓ pinned {} of {} on {storage} · {}",
            plural(out.copied, "pack"),
            safe(&display),
            cost_line(out.spent, price)
        );
    }
    Ok(out)
}

/// An error in one line with anything secret-shaped redacted, for the terminal and `pins.toml`.
fn said(e: &anyhow::Error) -> String {
    forge_core::user_error::redact(&forge_core::user_error::one_line(&format!("{e:#}")))
}

/// The signing identity's id, without opening a session.
fn signer_id(ctx: &Ctx) -> Result<String> {
    Ok(match ctx.identity_id_hint() {
        Some(id) => id,
        None => ctx.load_bridge()?.identity_id,
    })
}

/// `dg repo pin --all`: every repository this identity follows on this network, unattended
/// (or, with `dry_run`, what that would copy and cost).
async fn refresh_all(ctx: &Ctx, dry_run: bool) -> Result<()> {
    let path = pins_path()?;
    let network = ctx.network_label();
    let me = signer_id(ctx)?;
    let (followed, others): (Vec<Followed>, Vec<Followed>) = read_pins(&path)?
        .repo
        .into_iter()
        .filter(|r| r.network == network)
        .partition(|r| r.signer == me);
    if !others.is_empty() && !ctx.json {
        eprintln!(
            "note: {} followed by another identity (or before followers were recorded) {} skipped; `dg repo pin <repo> --follow` as this identity follows them here",
            plural(others.len(), "repository"),
            if others.len() == 1 { "is" } else { "are" }
        );
    }
    let mut repos = Vec::new();
    let mut failed = 0;
    for f in followed {
        let result = Box::pin(pin_one(ctx, &f.repo_id, Some(&f.storage), dry_run, true)).await;
        let (error, body) = match result {
            Ok(done) => (done.failed.first().cloned(), done.json()),
            Err(e) => {
                let why = said(&e);
                if !ctx.json {
                    eprintln!("{}: {why}", safe(&f.repo));
                }
                (
                    Some(why.clone()),
                    json!({"repo": f.repo, "status": "failed", "detail": why}),
                )
            }
        };
        failed += usize::from(error.is_some());
        if !dry_run {
            update_pins(&path, |file| {
                if let Some(r) = file.repo.iter_mut().find(|r| r.same(&f)) {
                    r.last_run = now();
                    r.last_error.clone_from(&error);
                }
            })?;
        }
        repos.push(body);
    }
    let body = json!({"status": if dry_run { "planned" } else { "refreshed" }, "repos": repos, "failed": failed});
    if failed > 0 {
        return Err(crate::errors::reported(
            UserError::new(
                codes::PARTIAL,
                "some followed repositories could not be pinned",
            ),
            body,
        ));
    }
    ctx.emit(body, || {
        if !dry_run {
            println!(
                "✓ {} up to date",
                plural(repos.len(), "followed repository")
            );
        }
    });
    Ok(())
}

/// `dg repo unpin`: delete your mirror records for the repository and stop following it. The
/// copies stay on your storage.
pub async fn unpin(ctx: &Ctx, repo: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let mirrors = s
        .client
        .fetch_contract(s.repo.forge().home(DOC_PACK_MIRROR))
        .await?;
    let mine: Vec<_> = mirrors_by(&s.client, &mirrors, &s.identity.id())
        .await?
        .into_iter()
        .filter(|m| m.repo_id == s.repo.id())
        .collect();
    let display = s.repo.display();
    if !mine.is_empty() {
        ctx.confirm_or_cancel(&format!(
            "Remove your {} of {display}? (refunds most of their storage fee; the files stay on your storage)",
            plural(mine.len(), "pin record")
        ))?;
    }
    // Stop following first, so a refresh cannot pay to put back a record deleted here.
    let network = ctx.network_label();
    let me = s.identity.id();
    let id = s.repo.id().to_string();
    update_pins(&pins_path()?, |file| {
        file.repo
            .retain(|r| r.network != network || r.repo_id != id || r.signer != me);
    })?;
    let engine = forge_core::profile::engine(&s.client, &s.identity, &s.bridge)?;
    for (i, m) in mine.iter().enumerate() {
        if let Err(e) = delete_mirror(&engine, &mirrors, &m.id).await {
            return Err(crate::errors::reported(
                UserError::new(
                    codes::PARTIAL,
                    format!("unpinned partly: {} of {} records removed", i, mine.len()),
                )
                .cause(said(&e.into()))
                .fix(format!(
                    "run `dg repo unpin {display}` again to remove the rest"
                ))
                .note("the repository is no longer followed"),
                json!({"status": "partial", "repo": display, "recordsRemoved": i, "recordsLeft": mine.len() - i}),
            ));
        }
    }
    ctx.emit(
        json!({"status": "unpinned", "repo": display, "recordsRemoved": mine.len()}),
        || {
            println!(
                "✓ unpinned {} ({} removed)",
                safe(&display),
                plural(mine.len(), "record")
            );
        },
    );
    Ok(())
}

/// `pins.toml`: the repositories `dg repo pin --all` refreshes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PinsFile {
    #[serde(default)]
    pub repo: Vec<Followed>,
    /// The storage each fork copies its parent's packs to (`dg repo fork --storage`).
    #[serde(default)]
    pub fork: Vec<ForkStorage>,
}

/// Where one fork's copies go.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForkStorage {
    pub network: String,
    pub signer: String,
    pub repo_id: String,
    pub storage: String,
}

/// The profile `signer` copied the fork `repo_id`'s packs to, when it still exists and others
/// can read it.
pub fn fork_storage_recorded(
    network: &str,
    signer: &str,
    repo_id: &str,
) -> Option<(String, Profile)> {
    let name = read_pins(&pins_path().ok()?)
        .ok()?
        .fork
        .into_iter()
        .find(|f| f.network == network && f.signer == signer && f.repo_id == repo_id)?
        .storage;
    let profile = StorageProfiles::load().ok()?.get(&name)?;
    pin_profile_problem(&profile)
        .is_none()
        .then_some((name, profile))
}

/// Remember that `signer` copies the fork `repo_id`'s packs to `storage`.
pub fn record_fork_storage(
    network: &str,
    signer: &str,
    repo_id: &str,
    storage: &str,
) -> Result<()> {
    update_pins(&pins_path()?, |file| {
        file.fork
            .retain(|f| !(f.network == network && f.signer == signer && f.repo_id == repo_id));
        file.fork.push(ForkStorage {
            network: network.into(),
            signer: signer.into(),
            repo_id: repo_id.into(),
            storage: storage.into(),
        });
    })
}

/// One followed repository.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Followed {
    pub network: String,
    /// The identity that followed it, and pays for its refreshes.
    #[serde(default)]
    pub signer: String,
    pub repo_id: String,
    /// `owner/name` when it was followed (for messages).
    pub repo: String,
    pub storage: String,
    #[serde(default)]
    pub last_run: u64,
    #[serde(default)]
    pub last_error: Option<String>,
}

impl Followed {
    fn same(&self, other: &Self) -> bool {
        self.network == other.network
            && self.repo_id == other.repo_id
            && self.signer == other.signer
    }
}

impl PinsFile {
    fn upsert(&mut self, entry: Followed) {
        match self.repo.iter_mut().find(|r| r.same(&entry)) {
            Some(r) => *r = entry,
            None => self.repo.push(entry),
        }
    }
}

fn pins_path() -> Result<PathBuf> {
    Ok(crate::config::config_dir()?.join("pins.toml"))
}

fn read_pins(path: &Path) -> Result<PinsFile> {
    match fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).with_context(|| format!("reading {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PinsFile::default()),
        Err(e) => Err(e.into()),
    }
}

fn update_pins(path: &Path, change: impl FnOnce(&mut PinsFile)) -> Result<()> {
    let dir = path.parent().context("pins file has no directory")?;
    fs::create_dir_all(dir)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("pins.lock"))?;
    lock.lock()?;
    let mut file = read_pins(path)?;
    change(&mut file);
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(toml::to_string_pretty(&file)?.as_bytes())?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(repo_id: &str, storage: &str) -> Followed {
        Followed {
            network: "testnet".into(),
            signer: "me".into(),
            repo_id: repo_id.into(),
            repo: "o/r".into(),
            storage: storage.into(),
            last_run: 0,
            last_error: None,
        }
    }

    #[test]
    fn following_twice_keeps_one_entry_with_the_newest_storage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pins.toml");
        update_pins(&path, |f| f.upsert(entry("A", "nas"))).unwrap();
        update_pins(&path, |f| f.upsert(entry("A", "r2"))).unwrap();
        update_pins(&path, |f| f.upsert(entry("B", "nas"))).unwrap();
        let file = read_pins(&path).unwrap();
        assert_eq!(file.repo, vec![entry("A", "r2"), entry("B", "nas")]);
    }
}
