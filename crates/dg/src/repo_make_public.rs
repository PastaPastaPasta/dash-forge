//! `dg repo make-public`: a private repository made public, once, by its owner (mixed-visibility
//! DESIGN §4.10, D36, D45; §10 "Make this repo public").
//!
//! Two modes, and nothing is chosen for the owner:
//!
//! * **Code only** (`--code-only`): a fresh public copy of the code of the branches and tags the
//!   owner picks (by default the default branch and the tags on it). Issues, pull requests,
//!   reviews and other branches stay members-only.
//! * **Everything** (`--everything`): every live branch and tag, and the keys of everything
//!   members could read until now, published last. Code only can become Everything later (run
//!   it again with `--everything`), never the reverse.
//!
//! The steps, each reading state first so a run that stops can be finished (`--resume`):
//!
//! 0. The check (`--check` stops here, signing nothing): the key and repair checks, the mode and
//!    the refs, what becomes public (with Everything, the counts), a secret scan of all of it,
//!    environments still holding values saved in the old format (E812, Everything only), what
//!    stays private, the oldest Forge that can clone it, and the cost.
//! 1. The confirmation: `make <repo> public` typed (or `--yes`).
//! 2. The seal-off rotation, while the repository is still private: a fresh key that is never
//!    published, so nothing written during or after the conversion can be published by it.
//! 3. The flip (the owner): the point of no return.
//! 4. The first public settings, carried from the private ones (any maintainer).
//! 5. The code: one push of the published refs through `git-remote-dash`, from a work repository
//!    built from the private-era packs with the member's own keys (any maintainer).
//! 6. Notifications: nothing is signed; Forge apps tell members (and, with Everything, the people
//!    whose words become public) from the flip and the published keys.
//! 7. With Everything, the history (the owner): make-public bundles of the keys of every epoch
//!    before the seal-off rotation.
//!
//! The work repository and the run's choices (the mode, the refs and their tips, the seal-off
//! epoch) are kept under `$XDG_STATE_HOME/dash-forge/make-public/<repo id>/`; nothing secret is
//! written there beyond the code the repository already shares with its members.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use forge_core::collab::v2::Census;
use forge_core::cost::push_fees::{self, PushShape};
use forge_core::keyring::Keyring;
use forge_core::platform::{FetchedDocument, QueryFilter, QueryOrder};
use forge_core::private::convert::{
    epoch_key_bundles, unpublished_epochs, Conversion, CONVERTED_REPO_MIN_CLIENT_VERSION,
};
use forge_core::repo::{CurrentConfig, RepoService};
use forge_core::rules::v2::{Role, Visibility};
use forge_core::rules::{tip_of, RefState};
use forge_core::scope::RepoRef;
use forge_core::user_error::{codes, UserError};

use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, plural, safe, short};
use crate::git;

/// About what the flip (a replace of the `repo` document) costs: DESIGN §4.10's 0.0004 DASH.
pub const FLIP_ESTIMATE_CREDITS: u64 = 40_000_000;
/// About what the first public `config` costs: DESIGN §4.10's 0.0004 DASH.
pub const CONFIG_ESTIMATE_CREDITS: u64 = 40_000_000;

/// `dg repo make-public` arguments.
#[derive(Debug, clap::Args)]
#[allow(clippy::struct_excessive_bools)] // independent flags, as clap takes them
pub struct MakePublicArgs {
    /// The repository (`owner/name`).
    pub repo: String,
    /// Only show what would become public, what stays private and the cost. Signs nothing.
    #[arg(long)]
    pub check: bool,
    /// Code only: publish the code of the branches and tags you pick (`--ref`; by default the
    /// default branch and the tags on it). Issues, pull requests, reviews and other branches
    /// stay members-only. You can make everything public later.
    #[arg(long, conflicts_with = "everything")]
    pub code_only: bool,
    /// Everything: everything members could ever read until now, every branch and tag included.
    #[arg(long)]
    pub everything: bool,
    /// With --code-only: a branch or tag to publish (repeat it for more).
    #[arg(long = "ref", value_name = "REF", requires = "code_only")]
    pub refs: Vec<String>,
    /// Finish a run that stopped: any maintainer once the repo is public, the owner for the rest.
    #[arg(long)]
    pub resume: bool,
    /// Publish a possible secret the check found anyway (its fingerprint; repeat it for more).
    #[arg(long = "allow-secret", value_name = "FINGERPRINT")]
    pub allow_secret: Vec<String>,
}

/// What becomes public.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Mode {
    /// The code of the refs the owner picks.
    CodeOnly,
    /// Every live ref, and the keys of everything written before the seal-off rotation.
    Everything,
}

impl Mode {
    fn label(self) -> &'static str {
        match self {
            Mode::CodeOnly => "Code only",
            Mode::Everything => "Everything",
        }
    }
}

/// The run's choices, kept between runs ([`state_dir`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    repo_id: String,
    mode: Mode,
    /// The refs to publish and their tips, as the check found them.
    refs: Vec<(String, String)>,
    /// The epoch the seal-off rotation created (step 2), once it ran.
    seal_off: Option<u32>,
}

/// Where a run keeps its choices and its work repository.
fn state_dir(repo: &RepoRef) -> Result<PathBuf> {
    let base = match std::env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()) {
        Some(s) => PathBuf::from(s),
        None => PathBuf::from(std::env::var_os("HOME").context("HOME is not set")?)
            .join(".local/state"),
    };
    Ok(base.join("dash-forge/make-public").join(&repo.repo_id))
}

impl Saved {
    fn load(dir: &Path, repo: &RepoRef) -> Option<Self> {
        let text = std::fs::read_to_string(dir.join("state.json")).ok()?;
        serde_json::from_str::<Self>(&text)
            .ok()
            .filter(|s| s.repo_id == repo.repo_id)
    }

    fn save(&self, dir: &Path) -> Result<()> {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        let tmp = dir.join("state.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(&tmp, dir.join("state.json"))?;
        Ok(())
    }
}

/// One possible secret in what becomes public.
#[derive(Debug, Clone)]
struct Secret {
    place: String,
    rule: String,
    fingerprint: String,
    /// A high-confidence finding: it needs `--allow-secret` before anything is signed.
    refuses: bool,
}

/// What the check found.
#[derive(Debug, Default)]
struct Check {
    /// What stops the run before anything is signed.
    blockers: Vec<UserError>,
    /// What the owner should know.
    notes: Vec<String>,
    /// The refs Code only publishes, with their tips.
    code_refs: Vec<(String, String)>,
    /// Every live ref written while private, with its tip (what Everything publishes).
    all_refs: Vec<(String, String)>,
    /// Branches deleted while private, and force-pushes (published with Everything).
    deleted: usize,
    forced: usize,
    /// The discussion (Everything).
    census: Census,
    /// Authors who are no longer members (Everything).
    former: BTreeSet<String>,
    /// Environments, and those still holding old-format values (E812).
    environments: usize,
    old_format: Vec<String>,
    /// Possible secrets, in the code and (Everything) in the discussion and every old object.
    code_secrets: Vec<Secret>,
    everything_secrets: Vec<Secret>,
    /// The fresh pack's size and objects, for the mode chosen.
    pack_bytes: u64,
    objects: u64,
    /// The settings carried into the first public config.
    config: Option<CurrentConfig>,
}

/// `dg repo make-public <repo>`.
pub async fn run(ctx: &Ctx, a: &MakePublicArgs) -> Result<()> {
    let s = Session::open(ctx, &a.repo).await?;
    let dir = state_dir(&s.repo)?;
    let saved = Saved::load(&dir, &s.repo);
    let me = s.identity.id();
    let owner = s.repo.owner_id.clone();
    let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
    let conversion = if s.repo.visibility == Visibility::Public {
        match svc.conversion(&s.repo).await? {
            Some(c) => Some(c),
            None => {
                return Err(UserError::new(
                    codes::USAGE,
                    format!("{} is public already", safe(&a.repo)),
                )
                .note("nothing was written")
                .into())
            }
        }
    } else {
        None
    };
    let flag_mode = if a.everything {
        Some(Mode::Everything)
    } else if a.code_only {
        Some(Mode::CodeOnly)
    } else {
        None
    };
    // The keys and the private era, read with the member's own keys.
    let private = s.repo.private_view();
    let psvc = RepoService::new(&s.client, &s.identity, &s.bridge);
    let kr = psvc.keyring(&private).await?;
    if !is_maintainer(&kr, &me, &owner) {
        return Err(not_the_owner(&a.repo, &owner));
    }
    // a run that started Everything (some history published) finishes as Everything
    let history_started = match &conversion {
        Some(c) => !published_keys(&s, &public_view(&s.repo), c).await.is_empty(),
        None => false,
    };
    let mode = flag_mode
        .or(saved.as_ref().map(|s| s.mode))
        .or(history_started.then_some(Mode::Everything));
    let check = Box::pin(preflight(ctx, &s, &psvc, &kr, &private, conversion.as_ref(), a, mode)).await?;
    if a.check || (mode.is_none() && conversion.is_none()) {
        if a.check || !ctx.json {
            print_check(ctx, &s.repo, &a.repo, &check, mode, &kr, &owner, conversion.is_some());
        }
        if !a.check {
            return Err(UserError::new(
                codes::USAGE,
                "choose what becomes public: --code-only or --everything",
            )
            .cause("nothing is chosen for you")
            .note("nothing was written")
            .into());
        }
        return Ok(());
    }
    let Some(mode) = mode else {
        return Err(UserError::new(
            codes::USAGE,
            format!("{} was made public; say which mode to finish", safe(&a.repo)),
        )
        .fix(format!(
            "dg repo make-public {} --resume --code-only (or --everything)",
            safe(&a.repo)
        ))
        .note("this computer has no record of the run that started it")
        .into());
    };
    Box::pin(convert(ctx, &s, &svc, &psvc, &kr, &private, conversion, saved, mode, check, a, &dir)).await
}

/// Whether the signer is the owner or a maintainer (the steps a run signs are theirs).
fn is_maintainer(kr: &Keyring, me: &str, owner: &str) -> bool {
    me == owner
        || kr
            .members()
            .iter()
            .any(|m| m.identity_id == me && m.role == Role::Maintainer)
}

/// DESIGN §10 "Non-owner".
fn not_the_owner(repo: &str, owner: &str) -> anyhow::Error {
    UserError::new(
        codes::NOT_A_WRITER,
        format!("only the owner ({}) can make {} public", safe(owner), safe(repo)),
    )
    .note("nothing was written")
    .into()
}

/// The keys readers already honour for epochs below the seal-off epoch of `public` (read with a
/// fresh service: the published keys are cached per service).
async fn published_keys(
    s: &Session,
    public: &RepoRef,
    c: &Conversion,
) -> BTreeMap<u32, forge_core::private::EpochKey> {
    RepoService::new(&s.client, &s.identity, &s.bridge)
        .public_keys(public)
        .await
        .map(|kr| kr.epoch_keys_below(c.seal_off_epoch.unwrap_or(0)))
        .unwrap_or_default()
}

fn public_view(repo: &RepoRef) -> RepoRef {
    RepoRef {
        visibility: Visibility::Public,
        ..repo.clone()
    }
}

/// Step 0: everything the dialog shows, read without signing.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
async fn preflight(
    ctx: &Ctx,
    s: &Session,
    psvc: &RepoService<'_>,
    kr: &Keyring,
    private: &RepoRef,
    conversion: Option<&Conversion>,
    a: &MakePublicArgs,
    mode: Option<Mode>,
) -> Result<Check> {
    let _ = ctx;
    let mut out = Check::default();
    let res = kr.resolution();
    let repo_label = safe(&a.repo).into_owned();
    // the keys: the current one held, nothing pending
    match res.current_epoch {
        Some(e) if kr.readable_epochs().contains(&e) => {}
        _ => out.blockers.push(
            UserError::new(codes::NOT_A_KEY_HOLDER, "you don't hold this repo's current key")
                .fix(format!("ask a maintainer to share it: dg repo keys repair {repo_label}"))
                .note("nothing was written"),
        ),
    }
    if let Some(r) = &res.repair {
        if r.rotate || !r.missing_wraps.is_empty() {
            out.blockers.push(
                UserError::new(codes::ROTATION_PENDING, "this repo's key needs a repair first")
                    .fix(format!("dg repo keys repair {repo_label}, then run this again"))
                    .note("nothing was written"),
            );
        }
    }
    let below = conversion
        .and_then(|c| c.seal_off_epoch)
        .or(res.current_epoch.map(|e| e + 1))
        .unwrap_or(0);
    let unreadable: Vec<u32> = (0..below)
        .filter(|e| res.anchors.contains_key(e) && !kr.readable_epochs().contains(e))
        .collect();
    if !unreadable.is_empty() {
        out.notes.push(
            "Some history written while private can't be published: nobody holds its key any more. It stays unreadable to everyone.".into(),
        );
    }
    // the private era's refs and settings
    let private_refs = psvc.read_refs(private).await?;
    for (name, state) in &private_refs {
        match tip_of(state) {
            Some(tip) => out.all_refs.push((name.clone(), tip)),
            None if *state == RefState::Unborn => out.deleted += 1,
            None => {}
        }
    }
    out.forced = forced_updates(s, psvc, private).await.unwrap_or(0);
    let cfg = psvc.current_config(private).await?;
    let default_ref = git::full_ref(&cfg.default_branch);
    out.config = Some(cfg);
    // the work repository: every private-era pack this member opens
    let work = work_repo(s, psvc, private, &out.all_refs).await?;
    // Code only: the refs picked, or the default branch and the tags on it
    out.code_refs = if a.refs.is_empty() {
        let mut picked: Vec<(String, String)> = out
            .all_refs
            .iter()
            .filter(|(n, _)| *n == default_ref)
            .cloned()
            .collect();
        if let Some((_, tip)) = picked.first().cloned() {
            for (n, t) in &out.all_refs {
                if n.starts_with("refs/tags/") && git::is_ancestor(&work, &peeled(&work, t), &tip) {
                    picked.push((n.clone(), t.clone()));
                }
            }
        }
        picked
    } else {
        let mut picked = Vec::new();
        for r in &a.refs {
            let full = full_ref_any(r);
            match out.all_refs.iter().find(|(n, _)| *n == full) {
                Some(found) => picked.push(found.clone()),
                None => {
                    return Err(crate::errors::not_found(
                        format!("{} is not a branch or tag of {repo_label}", safe(r)),
                        format!("`dg repo make-public {repo_label} --check` lists them"),
                    ))
                }
            }
        }
        picked
    };
    // secrets in the code the mode publishes, and (Everything) in every object and every post
    let tips: Vec<String> = out.code_refs.iter().map(|(_, t)| t.clone()).collect();
    out.code_secrets = scan_objects(&work, &tips, false)?;
    let census_wanted = mode != Some(Mode::CodeOnly) || conversion.is_none();
    if census_wanted {
        out.census = s
            .collab()
            .make_public_census(private, conversion.and_then(|c| c.marker_height))
            .await?;
        let members: BTreeSet<String> = kr
            .members()
            .iter()
            .map(|m| m.identity_id.clone())
            .chain(std::iter::once(s.repo.owner_id.clone()))
            .collect();
        out.former = out.census.authors.difference(&members).cloned().collect();
        let all_tips: Vec<String> = out.all_refs.iter().map(|(_, t)| t.clone()).collect();
        out.everything_secrets = scan_objects(&work, &all_tips, true)?;
        for t in &out.census.texts {
            for f in forge_secrets::scan_file(&t.place, t.text.as_bytes()) {
                out.everything_secrets.push(secret_of(&f, t.place.clone()));
            }
        }
    }
    // environments: E812 over every one still holding old-format values
    let book = forge_core::env::service::Environments::new(&s.client, &s.identity, &s.bridge)
        .read(private)
        .await?;
    out.environments = book.resolution.environments.len() + book.resolution.hidden.len();
    for e in &book.resolution.environments {
        if book
            .old_format_of(&e.env)
            .is_some_and(|o| o.needs_attention())
        {
            out.old_format.push(e.env.clone());
        }
    }
    let named: BTreeSet<&String> = book
        .resolution
        .environments
        .iter()
        .flat_map(|e| e.snapshots.iter())
        .collect();
    if book.old_format.iter().any(|id| !named.contains(id)) {
        out.old_format.push("(an environment you can't read)".into());
    }
    // the fresh pack of what the mode publishes
    let pack_tips: Vec<String> = match mode {
        Some(Mode::Everything) => out.all_refs.iter().map(|(_, t)| t.clone()).collect(),
        _ => tips,
    };
    (out.pack_bytes, out.objects) = pack_size(&work, &pack_tips)?;
    Ok(out)
}

/// How many ref updates written while private were force-pushes.
async fn forced_updates(s: &Session, psvc: &RepoService<'_>, private: &RepoRef) -> Result<usize> {
    let contract = psvc.repo_contract(private).await?;
    let scope = private.scope()?;
    let mut n = 0;
    for t in ["refUpdate", "protectedRefUpdate"] {
        let docs: Vec<FetchedDocument> = s
            .client
            .query_all_documents(
                &contract,
                t,
                &[QueryFilter::eq(
                    "repoId",
                    forge_core::platform::FieldValue::identifier(scope.repo_id),
                )],
                &[QueryOrder::asc("$createdAt")],
            )
            .await?;
        n += docs
            .iter()
            .filter(|d| d.field_str("vis").as_deref() == Some("private") && d.field_bool("force"))
            .count();
    }
    Ok(n)
}

/// `refs/heads/x` for `x`, a tag's full name for `refs/tags/x` or `v1` when only a tag has it.
fn full_ref_any(r: &str) -> String {
    if r.starts_with("refs/") {
        r.to_string()
    } else {
        git::full_ref(r)
    }
}

/// The commit `oid` (a tag object's target) points at.
fn peeled(dir: &Path, oid: &str) -> String {
    git::git(dir, &["rev-parse", &format!("{oid}^{{commit}}")], &[])
        .map_or_else(|_| oid.to_string(), |s| s.trim().to_string())
}

/// The work repository: a bare repository holding every private-era pack this member opens
/// (so Everything's scan sees every old object, deleted branches included) and the live refs.
async fn work_repo(
    s: &Session,
    psvc: &RepoService<'_>,
    private: &RepoRef,
    refs: &[(String, String)],
) -> Result<PathBuf> {
    let _ = s;
    let dir = state_dir(private)?.join("work.git");
    if !dir.join("HEAD").exists() {
        std::fs::create_dir_all(&dir)?;
        git::git(&dir, &["init", "-q", "--bare"], &[])?;
    }
    let missing = refs.iter().any(|(_, t)| !git::has_object(&dir, t));
    if missing || !dir.join("make-public-packs").exists() {
        let (packs, skipped) = psvc.open_git_packs(private).await?;
        for p in &packs {
            index_pack(&dir, p)?;
        }
        std::fs::write(dir.join("make-public-packs"), format!("{} {skipped}\n", packs.len()))?;
    }
    for (name, tip) in refs {
        if git::has_object(&dir, tip) {
            git::git(&dir, &["update-ref", name, tip], &[])?;
        }
    }
    Ok(dir)
}

/// Index one plaintext pack into `dir`.
fn index_pack(dir: &Path, bytes: &[u8]) -> Result<()> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["index-pack", "--stdin", "--fix-thin", "-q"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("running git index-pack")?;
    child
        .stdin
        .take()
        .expect("piped")
        .write_all(bytes)
        .context("writing a pack to git index-pack")?;
    let out = child.wait_with_output()?;
    if !out.status.success() {
        anyhow::bail!(
            "git index-pack: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

/// The size and object count of a pack of everything reachable from `tips`.
fn pack_size(dir: &Path, tips: &[String]) -> Result<(u64, u64)> {
    if tips.is_empty() {
        return Ok((0, 0));
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["pack-objects", "--stdout", "--revs", "-q"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("running git pack-objects")?;
    {
        let mut stdin = child.stdin.take().expect("piped");
        for t in tips {
            writeln!(stdin, "{t}")?;
        }
    }
    let out = child.wait_with_output()?;
    let objects = out
        .stdout
        .get(8..12)
        .map_or(0, |b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    Ok((out.stdout.len() as u64, u64::from(objects)))
}

fn secret_of(f: &forge_secrets::Finding, place: String) -> Secret {
    Secret {
        place,
        rule: format!("{:?}", f.rule),
        fingerprint: f.fingerprint.clone(),
        refuses: forge_secrets::verdict(f, false).severity == forge_secrets::Severity::Refuse,
    }
}

/// Possible secrets in the blobs reachable from `tips` and, with `every`, in every object of the
/// work repository (what the published keys open: deleted and force-pushed-away ones too).
fn scan_objects(dir: &Path, tips: &[String], every: bool) -> Result<Vec<Secret>> {
    let mut paths: BTreeMap<String, String> = BTreeMap::new();
    if !tips.is_empty() {
        let mut args = vec!["rev-list", "--objects"];
        args.extend(tips.iter().map(String::as_str));
        for line in git::git(dir, &args, &[])?.lines() {
            if let Some((oid, path)) = line.split_once(' ') {
                paths.entry(oid.to_string()).or_insert_with(|| path.to_string());
            }
        }
    }
    let blobs: Vec<String> = if every {
        git::git(
            dir,
            &[
                "cat-file",
                "--batch-all-objects",
                "--batch-check=%(objectname) %(objecttype)",
            ],
            &[],
        )?
        .lines()
        .filter_map(|l| l.strip_suffix(" blob").map(str::to_string))
        .collect()
    } else {
        let wanted: Vec<String> = paths.keys().cloned().collect();
        object_types(dir, &wanted)?
            .into_iter()
            .filter(|(_, t)| t == "blob")
            .map(|(o, _)| o)
            .collect()
    };
    let mut out = Vec::new();
    for (oid, bytes) in read_blobs(dir, &blobs)? {
        let path = paths
            .get(&oid)
            .cloned()
            .unwrap_or_else(|| format!("(an old object no branch holds now) {}", short(&oid)));
        let scannable =
            bytes.len() <= forge_secrets::MAX_SCAN_BYTES && forge_secrets::is_scannable(&bytes);
        let found = if scannable {
            forge_secrets::scan_file(&path, &bytes)
        } else {
            forge_secrets::scan_unread(&path, &forge_secrets::git_blob_id(&bytes))
        };
        out.extend(found.iter().map(|f| secret_of(f, f.location())));
    }
    Ok(out)
}

/// `git cat-file --batch` over `oids`: each object's id and bytes.
fn read_blobs(dir: &Path, oids: &[String]) -> Result<Vec<(String, Vec<u8>)>> {
    if oids.is_empty() {
        return Ok(Vec::new());
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("running git cat-file")?;
    let mut stdin = child.stdin.take().expect("piped");
    let input = oids.join("\n") + "\n";
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let out = child.wait_with_output()?;
    writer
        .join()
        .map_err(|_| anyhow::anyhow!("git cat-file input"))??;
    let mut rest = &out.stdout[..];
    let mut objects = Vec::new();
    while let Some(nl) = rest.iter().position(|&b| b == b'\n') {
        let header = String::from_utf8_lossy(&rest[..nl]).into_owned();
        rest = &rest[nl + 1..];
        let mut f = header.split(' ');
        let (Some(oid), Some(_), Some(size)) = (f.next(), f.next(), f.next()) else {
            continue; // "<oid> missing"
        };
        let size: usize = size.parse().context("git cat-file size")?;
        let body = rest.get(..size).context("git cat-file output ended early")?;
        objects.push((oid.to_string(), body.to_vec()));
        rest = rest.get(size + 1..).unwrap_or_default();
    }
    Ok(objects)
}

/// `(oid, type)` of each of `oids`.
fn object_types(dir: &Path, oids: &[String]) -> Result<Vec<(String, String)>> {
    if oids.is_empty() {
        return Ok(Vec::new());
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["cat-file", "--batch-check=%(objectname) %(objecttype)"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("running git cat-file")?;
    let mut stdin = child.stdin.take().expect("piped");
    let input = oids.join("\n") + "\n";
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let out = child.wait_with_output()?;
    writer
        .join()
        .map_err(|_| anyhow::anyhow!("git cat-file input"))??;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.split_once(' '))
        .map(|(o, t)| (o.to_string(), t.to_string()))
        .collect())
}

/// What the mode's secret scan found: the code's, plus everything else's with Everything.
fn secrets_of(check: &Check, mode: Mode) -> Vec<&Secret> {
    let mut v: Vec<&Secret> = check.code_secrets.iter().collect();
    if mode == Mode::Everything {
        v.extend(check.everything_secrets.iter());
    }
    let mut seen = BTreeSet::new();
    v.retain(|s| seen.insert((s.place.clone(), s.fingerprint.clone())));
    v
}

/// The estimate of a run in `mode`: the seal-off rotation (while private), the flip, the
/// config, the push (its metadata, and its chunks when Platform stores the code) and, with
/// Everything, the history. `(credits, storage credits)`.
fn estimate(check: &Check, kr: &Keyring, mode: Mode, converted: bool) -> (u64, u64) {
    let refs = match mode {
        Mode::CodeOnly => check.code_refs.len(),
        Mode::Everything => check.all_refs.len(),
    } as u64;
    let push = push_fees::estimate_push(&PushShape {
        pack_bytes: check.pack_bytes,
        objects: check.objects,
        index_objects: check.objects,
        refs,
        external_targets: 0,
        platform_bytes: true,
        sealed: false,
    });
    let mut credits = push.metadata_credits;
    if !converted {
        credits += crate::keys::rotation_cost(kr, crate::keys::distinct_members(kr.members())).0
            + FLIP_ESTIMATE_CREDITS
            + CONFIG_ESTIMATE_CREDITS;
    }
    if mode == Mode::Everything {
        let n = kr.readable_epochs().len() as u64;
        credits += push_fees::long_body(7 + 69 * n + 64, false, 0, true);
    }
    (credits, push.chunk_credits)
}

/// The check, as the dialog shows it (DESIGN §10 "Make this repo public").
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn print_check(
    ctx: &Ctx,
    repo: &RepoRef,
    label: &str,
    check: &Check,
    mode: Option<Mode>,
    kr: &Keyring,
    owner: &str,
    converted: bool,
) {
    let price = ctx.usd_price();
    let modes: Vec<Mode> = match mode {
        Some(m) => vec![m],
        None => vec![Mode::CodeOnly, Mode::Everything],
    };
    let c = &check.census;
    let tags = check.code_refs.iter().filter(|(n, _)| n.starts_with("refs/tags/")).count();
    let branches: Vec<&str> = check
        .code_refs
        .iter()
        .filter(|(n, _)| n.starts_with("refs/heads/"))
        .map(|(n, _)| n.trim_start_matches("refs/heads/"))
        .collect();
    let estimates: Vec<Value> = modes
        .iter()
        .map(|&m| {
            let (credits, storage) = estimate(check, kr, m, converted);
            json!({ "mode": m, "cost": cost_json(credits, price), "storage": cost_json(storage, price) })
        })
        .collect();
    let refs_json = |v: &[(String, String)]| -> Value {
        v.iter()
            .map(|(n, t)| json!({ "name": n, "oid": t }))
            .collect()
    };
    let secrets_json = |m: Mode| -> Value {
        secrets_of(check, m)
            .iter()
            .map(|s| json!({ "place": s.place, "rule": s.rule, "fingerprint": s.fingerprint, "needsAllow": s.refuses }))
            .collect()
    };
    ctx.emit(
        json!({
            "status": "check",
            "repo": repo.display(),
            "owner": owner,
            "mode": mode,
            "made": converted,
            "blockers": check.blockers.iter().map(ToString::to_string).collect::<Vec<_>>(),
            "notes": check.notes,
            "codeOnly": { "refs": refs_json(&check.code_refs), "secrets": secrets_json(Mode::CodeOnly) },
            "everything": {
                "refs": refs_json(&check.all_refs),
                "issues": c.issues, "pullRequests": c.prs, "comments": c.comments, "reviews": c.reviews,
                "earlierEdits": c.revisions, "deletedBranches": check.deleted, "forcePushes": check.forced,
                "hidden": c.hidden, "releases": c.releases, "botRequests": c.bot_requests,
                "unread": c.unread,
                "importedAuthors": c.imported.len(),
                "importedHosts": c.imported_hosts().into_iter().collect::<Vec<_>>(),
                "authors": c.authors.len(),
                "formerMembers": check.former.iter().collect::<Vec<_>>(),
                "oldFormatEnvironments": check.old_format,
                "secrets": secrets_json(Mode::Everything),
            },
            "staysPrivate": { "letters": c.letters, "environments": check.environments },
            "minClientVersion": CONVERTED_REPO_MIN_CLIENT_VERSION,
            "estimates": estimates,
        }),
        || {
            println!("Make {} public?", safe(label));
            println!("Everyone will be able to see what you choose below. This can't be undone: the repo can never be private again.");
            println!();
            println!("What becomes public (choose one)");
            if modes.contains(&Mode::CodeOnly) {
                println!("  Code only (--code-only)");
                println!(
                    "    {}{}",
                    if branches.is_empty() { "no branch".to_string() } else { branches.join(", ") },
                    if tags > 0 { format!(" and {}", plural(tags, "tag")) } else { String::new() }
                );
                let others = check.all_refs.len().saturating_sub(check.code_refs.len());
                if others > 0 {
                    println!("    Not chosen: {} (--ref picks them)", plural(others, "other branch or tag"));
                }
                println!("    Issues, pull requests, reviews and other branches stay members-only. You can make them public later.");
                print_secrets(&secrets_of(check, Mode::CodeOnly));
            }
            if modes.contains(&Mode::Everything) {
                println!("  Everything (--everything)");
                println!(
                    "    Everything members could ever read until now: {}, {}, {} and {}, {} earlier edits, hidden comments, every branch ever pushed ({}, including {} deleted), {} force-pushes, {}, old settings{}{}.",
                    plural(c.issues, "issue"),
                    plural(c.prs, "pull request"),
                    plural(c.comments, "comment"),
                    plural(c.reviews, "review"),
                    c.revisions,
                    plural(check.all_refs.len(), "live branch or tag"),
                    check.deleted,
                    check.forced,
                    plural(c.releases, "release"),
                    if c.imported.is_empty() {
                        String::new()
                    } else {
                        format!(
                            ", imported authors and links ({} from {})",
                            plural(c.imported.len(), "person"),
                            c.imported_hosts().into_iter().collect::<Vec<_>>().join(", ")
                        )
                    },
                    if c.bot_requests == 0 { String::new() } else { format!(", and {} sent to bots", plural(c.bot_requests, "request")) },
                );
                if c.unread > 0 {
                    println!("    Also {} you can't read, which become public too.", plural(c.unread, "post"));
                }
                println!(
                    "    Words by {}{} become public.",
                    plural(c.authors.len(), "person"),
                    if check.former.is_empty() { String::new() } else { format!(", including {}", plural(check.former.len(), "former member")) }
                );
                print_secrets(&secrets_of(check, Mode::Everything));
                for env in &check.old_format {
                    println!("    Blocked (E812): environment {} has values saved in the old format, which would become public. Fix: dg env resave --env {env}, change every listed value where it's used, then dg env mark-changed --env {env}", safe(env));
                }
            }
            println!();
            println!(
                "Stays private: {}, {}, and everything members write from now on.",
                plural(c.letters, "message to specific people"),
                plural(check.environments, "environment")
            );
            println!("Members-only content keeps working afterwards, without a pause.");
            println!("People on Forge older than {CONVERTED_REPO_MIN_CLIENT_VERSION} can't clone it until they update.");
            for m in &modes {
                let (credits, storage) = estimate(check, kr, *m, converted);
                println!(
                    "{}: costs {}, plus storing the code: {} on Platform, or nothing extra with your own storage.",
                    m.label(),
                    cost_line(credits, price),
                    cost_line(storage, price)
                );
            }
            for n in &check.notes {
                println!("Note: {n}");
            }
            for b in &check.blockers {
                println!("Blocked: {b}");
            }
        },
    );
}

fn print_secrets(found: &[&Secret]) {
    if found.is_empty() {
        println!("    No secrets found in what you're publishing.");
        return;
    }
    for s in found {
        println!(
            "    Possible secret in {}{}",
            safe(&s.place),
            if s.refuses { format!(" (publish anyway: --allow-secret {})", s.fingerprint) } else { String::new() }
        );
    }
}

/// Steps 1–7.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
async fn convert(
    ctx: &Ctx,
    s: &Session,
    svc: &RepoService<'_>,
    psvc: &RepoService<'_>,
    kr: &Keyring,
    private: &RepoRef,
    conversion: Option<Conversion>,
    saved: Option<Saved>,
    mode: Mode,
    check: Check,
    a: &MakePublicArgs,
    dir: &Path,
) -> Result<()> {
    let label = safe(&a.repo).into_owned();
    let price = ctx.usd_price();
    let me = s.identity.id();
    let owner = s.repo.owner_id.clone();
    let is_owner = me == owner;
    let flipped = conversion.is_some();
    let published = match &conversion {
        Some(c) => published_keys(s, &public_view(&s.repo), c).await,
        None => BTreeMap::new(),
    };
    // what this run would publish: the refs (the saved ones on a resume) and, with
    // Everything, the history
    let wanted: Vec<(String, String)> = match (&saved, mode) {
        (Some(sv), m) if sv.mode == m && a.refs.is_empty() => sv.refs.clone(),
        (_, Mode::CodeOnly) => check.code_refs.clone(),
        (_, Mode::Everything) => check.all_refs.clone(),
    };
    let publishes_history = mode == Mode::Everything && is_owner;
    let new_publication = !flipped || (publishes_history && published.is_empty());
    // before anything is signed: who may, what blocks, what was acknowledged
    if !flipped && !is_owner {
        return Err(not_the_owner(&a.repo, &owner));
    }
    if let Some(b) = check.blockers.first() {
        if !flipped {
            return Err(b.clone().into());
        }
    }
    if mode == Mode::Everything && !check.old_format.is_empty() && (new_publication || publishes_history) {
        let env = &check.old_format[0];
        return Err(UserError::new(
            codes::MAKE_PUBLIC_BLOCKED,
            format!("can't make everything public: environment {} has values saved in the old format, which would become public", safe(env)),
        )
        .fix(format!("dg env resave --env {env}, change every listed value where it's used, then dg env mark-changed --env {env}"))
        .fix(format!("or make only the code public: dg repo make-public {label} --code-only"))
        .note("nothing was written")
        .into());
    }
    let allowed: BTreeSet<String> = a.allow_secret.iter().map(|f| f.to_ascii_lowercase()).collect();
    if new_publication {
        let blocking: Vec<&Secret> = secrets_of(&check, mode)
            .into_iter()
            .filter(|s| s.refuses && !allowed.contains(&s.fingerprint))
            .collect();
        if let Some(first) = blocking.first() {
            let mut e = UserError::new(
                codes::SECRET_IN_PUSH,
                format!("this would publish a possible secret in {}", safe(&first.place)),
            );
            for s in &blocking {
                e = e.fix(format!(
                    "if {} is not a secret: --allow-secret {}",
                    safe(&s.place),
                    s.fingerprint
                ));
            }
            return Err(e.note("nothing was written").into());
        }
    }
    let (credits, storage) = estimate(&check, kr, mode, flipped);
    // the typed confirmation, unless this computer's record of an earlier run shows it was given
    if new_publication && !(a.resume && saved.is_some()) {
        if !ctx.json {
            print_check(ctx, &s.repo, &a.repo, &check, Some(mode), kr, &owner, flipped);
        }
        typed_confirmation(ctx, &a.repo)?;
    } else {
        ctx.confirm_or_cancel(&format!(
            "Continue making {label} public ({}): about {}?",
            mode.label(),
            cost_line(credits + storage, price)
        ))?;
    }
    let before = s.balance().await;
    let mut steps: Vec<Value> = Vec::new();
    let mut saved = saved.unwrap_or(Saved {
        repo_id: s.repo.repo_id.clone(),
        mode,
        refs: wanted.clone(),
        seal_off: None,
    });
    saved.mode = mode;
    saved.refs.clone_from(&wanted);
    saved.save(dir)?;
    // 2. seal off, 3. flip
    if flipped {
        steps.push(json!({ "step": "sealOff", "status": "done" }));
        steps.push(json!({ "step": "flip", "status": "done" }));
    } else {
        let current = kr.resolution().current_epoch;
        if saved.seal_off.is_some() && saved.seal_off == current {
            steps.push(json!({ "step": "sealOff", "status": "done", "epoch": current }));
        } else {
            let signer = crate::keys::signer(s);
            let r = forge_core::keyring::rotate(&signer, private, &[]).await?;
            saved.seal_off = Some(r.epoch);
            saved.save(dir)?;
            if !ctx.json {
                println!("Sealed off: everything written from now on stays members-only.");
            }
            steps.push(json!({ "step": "sealOff", "status": "written", "epoch": r.epoch }));
        }
        let default_branch = check
            .config
            .as_ref()
            .map_or_else(|| "main".to_string(), |c| c.default_branch.clone());
        svc.make_repo_public(&s.repo, &default_branch).await?;
        if !ctx.json {
            println!("{label} is public now. It can never be private again.");
        }
        steps.push(json!({ "step": "flip", "status": "written" }));
    }
    let public = public_view(&s.repo);
    // 4. the first public settings
    let fresh = RepoService::new(&s.client, &s.identity, &s.bridge);
    let marker = fresh.conversion(&public).await?.and_then(|c| c.marker_height);
    if marker.is_none() {
        let cfg = check.config.clone().unwrap_or_default();
        fresh.write_converted_config(&public, &cfg).await?;
        steps.push(json!({ "step": "config", "status": "written" }));
    } else {
        steps.push(json!({ "step": "config", "status": "done" }));
    }
    // 5. the code
    let public_refs: BTreeMap<String, String> = fresh
        .read_refs(&public)
        .await?
        .into_iter()
        .filter_map(|(n, st)| tip_of(&st).map(|t| (n, t)))
        .collect();
    let members_only: BTreeSet<String> = match fresh.read_members_refs(&public).await {
        Ok(Some(m)) => m
            .refs
            .iter()
            .filter(|r| r.members_only)
            .map(|r| r.name.clone())
            .collect(),
        _ => BTreeSet::new(),
    };
    let skipped: Vec<&String> = wanted
        .iter()
        .filter(|(n, _)| members_only.contains(n) && !public_refs.contains_key(n))
        .map(|(n, _)| n)
        .collect();
    let todo: Vec<&(String, String)> = wanted
        .iter()
        .filter(|(n, _)| !public_refs.contains_key(n) && !members_only.contains(n))
        .collect();
    if todo.is_empty() {
        steps.push(json!({ "step": "code", "status": "done" }));
    } else {
        let work = work_repo(s, psvc, private, &wanted).await?;
        let mut args: Vec<String> = vec!["push".into(), "-o".into(), "public".into()];
        for f in &allowed {
            args.push("-o".into());
            args.push(format!("{}={f}", forge_secrets::ALLOW_PUSH_OPTION));
        }
        args.push(s.repo.remote_url());
        for (n, t) in &todo {
            args.push(format!("{t}:{n}"));
        }
        let push: Vec<&str> = args.iter().map(String::as_str).collect();
        git::git_dash(&work, &push, &git::dash_env_signing(ctx)?)
            .context("pushing the published branches and tags")?;
        steps.push(json!({ "step": "code", "status": "written", "refs": todo.iter().map(|(n, _)| n).collect::<Vec<_>>() }));
    }
    for n in &skipped {
        if !ctx.json {
            println!(
                "Not published: {}: members-only commits were pushed to it after the repo was made public.",
                safe(n.trim_start_matches("refs/heads/"))
            );
        }
    }
    // 6. notifications: Forge apps read them from the flip and the published keys
    steps.push(json!({ "step": "notify", "status": "done" }));
    // 7. the history
    let mut finished = true;
    if mode == Mode::Everything {
        let c = fresh.conversion(&public).await?.unwrap_or(Conversion {
            seal_off_epoch: saved.seal_off,
            marker_height: None,
        });
        let held = psvc
            .keyring(private)
            .await?
            .epoch_keys_below(c.seal_off_epoch.unwrap_or(0));
        let published = published_keys(s, &public, &c).await;
        let left = unpublished_epochs(&held, &published);
        if left.is_empty() {
            steps.push(json!({ "step": "history", "status": "done" }));
        } else if !is_owner {
            finished = false;
            steps.push(json!({ "step": "history", "status": "owner" }));
            if !ctx.json {
                println!(
                    "The owner publishes the history: they run dg repo make-public {label} --resume"
                );
            }
        } else {
            let repo_id = forge_core::platform::decode_identifier(&s.repo.repo_id)?;
            for b in epoch_key_bundles(&repo_id, &left)? {
                fresh.store_make_public_bundle(&public, &b).await?;
            }
            steps.push(json!({ "step": "history", "status": "written" }));
        }
    }
    let spent = s.spent_since(before).await;
    if finished {
        let _ = std::fs::remove_dir_all(dir);
    }
    ctx.emit(
        json!({
            "status": if finished { "public" } else { "in_progress" },
            "repo": s.repo.display(),
            "mode": mode,
            "steps": steps,
            "notPublished": skipped,
            "cost": cost_json(spent, price),
        }),
        || {
            if finished {
                println!(
                    "{label} is public ({}). Members and the people whose words became public see it in their notifications.",
                    mode.label()
                );
            }
            println!("  cost: {}", cost_line(spent, price));
        },
    );
    Ok(())
}

/// Step 1: the owner types `make <repo> public` (or passes `--yes`).
fn typed_confirmation(ctx: &Ctx, repo: &str) -> Result<()> {
    let words = format!("make {repo} public");
    if ctx.yes {
        return Ok(());
    }
    if !ctx.interactive() {
        return Err(UserError::new(
            codes::CONFIRMATION_REQUIRED,
            format!("making a repo public needs \"{words}\" typed"),
        )
        .fix("run it in a terminal, or pass --yes")
        .note("nothing was written")
        .into());
    }
    eprint!("Type \"{words}\" to continue: ");
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .context("reading confirmation")?;
    if line.trim() == words {
        Ok(())
    } else {
        Err(crate::errors::cancelled())
    }
}
