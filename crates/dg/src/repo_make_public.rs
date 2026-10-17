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
//! 0. The check (`--check` stops here, signing nothing): the network can do it, the key and
//!    repair checks, the mode and the refs, what becomes public (with Everything, the counts), a
//!    secret scan of all of it, environments still holding values saved in the old format (E812,
//!    Everything only), what stays private, the oldest Forge that can clone it, and the cost.
//! 1. The confirmation: `make <repo> public` typed (or `--yes`).
//! 2. The seal-off rotation, while the repository is still private: a fresh key that is never
//!    published, so nothing written during or after the conversion can be published by it. With
//!    Everything the check runs again right after it, over what is now final, and before the flip.
//! 3. The flip (the owner): the point of no return.
//! 4. The first public settings, carried from the private ones (any maintainer).
//! 5. The code: one push of the published refs through `git-remote-dash`, from a work repository
//!    built from the private-era packs with the member's own keys (any maintainer, for what the
//!    owner chose).
//! 6. Notifications: nothing is signed; Forge apps tell members (and, with Everything, the people
//!    whose words become public) from the flip and the published keys.
//! 7. With Everything, the history (the owner): make-public bundles of the keys of every epoch
//!    before the seal-off rotation.
//!
//! The run's choices (the mode, the refs and their tips, the seal-off epoch) and the work
//! repository are kept under `$XDG_STATE_HOME/dash-forge/make-public/<repo id>/` (mode 0700):
//! the work repository holds the code written while private, so it is removed after a check and
//! after a run that finishes.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead as _, Read as _, Write as _};
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
    epoch_key_bundles, history_cutoff, Conversion, CONVERTED_REPO_MIN_CLIENT_VERSION,
};
use forge_core::private::EpochKey;
use forge_core::repo::{visibility_frozen, CurrentConfig, RepoService};
use forge_core::rules::v2::{Role, Visibility};
use forge_core::rules::{tip_of, RefState};
use forge_core::scope::RepoRef;
use forge_core::user_error::{codes, UserError};

use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, plural, plural_with, safe, short};
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
    /// The mode's name in the dialog.
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
        None => {
            PathBuf::from(std::env::var_os("HOME").context("HOME is not set")?).join(".local/state")
        }
    };
    Ok(base.join("dash-forge/make-public").join(&repo.repo_id))
}

/// Create `dir` readable by this user alone.
fn private_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("restricting {}", dir.display()))?;
    }
    Ok(())
}

impl Saved {
    /// The record of an earlier run on this computer. One that cannot be read is an error, never
    /// "no record": a run that forgot its seal-off rotation would rotate again.
    fn load(dir: &Path, repo: &RepoRef) -> Result<Option<Self>> {
        let path = dir.join("state.json");
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        let saved: Self = serde_json::from_str(&text).with_context(|| {
            format!(
                "{} can't be read; if no run is under way, delete it",
                path.display()
            )
        })?;
        Ok((saved.repo_id == repo.repo_id).then_some(saved))
    }

    /// Keep the record in `dir`, replacing an earlier one whole.
    fn save(&self, dir: &Path) -> Result<()> {
        private_dir(dir)?;
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
    /// An environment whose old-format values this reader can't tell apart (E812 too).
    old_format_unreadable: bool,
    /// Stored copies of the private era's code that could not be fetched, so were not scanned.
    unfetched: usize,
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
#[allow(clippy::too_many_lines)] // where the run stands, then the check, then the steps
pub async fn run(ctx: &Ctx, a: &MakePublicArgs) -> Result<()> {
    let s = Session::open(ctx, &a.repo).await?;
    let dir = state_dir(&s.repo)?;
    let saved = Saved::load(&dir, &s.repo)?;
    let me = s.identity.id();
    let owner = s.repo.owner_id.as_str();
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
    if !is_maintainer(&kr, &me, owner) {
        return Err(not_the_owner(&s, &a.repo).await);
    }
    // a run that started Everything (some history published) finishes as Everything
    let history_started = match &conversion {
        Some(c) => !history_bundles(
            &s,
            &public_view(&s.repo),
            &kr,
            history_cutoff(c.seal_off_epoch, saved.as_ref().and_then(|sv| sv.seal_off)),
        )
        .await?
        .is_empty(),
        None => false,
    };
    if history_started && flag_mode == Some(Mode::CodeOnly) {
        return Err(UserError::new(
            codes::USAGE,
            format!("{} is being made public with everything", safe(&a.repo)),
        )
        .cause("its history is published already; Code only can't follow Everything")
        .fix(format!(
            "finish it: dg repo make-public {} --resume --everything",
            safe(&a.repo)
        ))
        .note("nothing was written")
        .into());
    }
    let mode = flag_mode
        .or(saved.as_ref().map(|s| s.mode))
        .or(history_started.then_some(Mode::Everything));
    // what the owner chose on this computer, when this run continues it
    let chosen = saved
        .as_ref()
        .filter(|sv| Some(sv.mode) == mode && a.refs.is_empty())
        .map(|sv| sv.refs.clone());
    let check = Box::pin(preflight(
        &s,
        &psvc,
        &kr,
        &private,
        conversion.as_ref(),
        a,
        mode,
        chosen.as_deref(),
    ))
    .await?;
    if a.check || (mode.is_none() && conversion.is_none()) {
        if a.check || !ctx.json {
            print_check(
                ctx,
                &s.repo,
                &a.repo,
                &check,
                mode,
                &kr,
                conversion.as_ref(),
            );
        }
        // the work repository holds the private era's code: not kept after a check
        let _ = std::fs::remove_dir_all(dir.join("work.git"));
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
            format!(
                "{} was made public; say which mode to finish",
                safe(&a.repo)
            ),
        )
        .fix(format!(
            "dg repo make-public {} --resume --code-only (or --everything)",
            safe(&a.repo)
        ))
        .note("this computer has no record of the run that started it")
        .into());
    };
    Box::pin(convert(
        Run {
            ctx,
            s: &s,
            svc: &svc,
            psvc: &psvc,
            kr: &kr,
            private: &private,
            conversion,
            saved,
            mode,
            history_started,
            a,
            dir: &dir,
        },
        check,
    ))
    .await
}

/// Whether the signer is the owner or a maintainer (the steps a run signs are theirs).
fn is_maintainer(kr: &Keyring, me: &str, owner: &str) -> bool {
    me == owner
        || kr
            .members()
            .iter()
            .any(|m| m.identity_id == me && m.role == Role::Maintainer)
}

/// DESIGN §10 "Non-owner": "Only the owner (@carol) can make this repo public."
async fn not_the_owner(s: &Session, repo: &str) -> anyhow::Error {
    let owner = s.repo.owner_id.as_str();
    let named = s
        .client
        .dpns_first_names([owner])
        .await
        .get(owner)
        .map_or_else(|| owner.to_string(), |n| format!("@{n}"));
    UserError::new(
        codes::NOT_A_WRITER,
        format!(
            "only the owner ({}) can make {} public",
            safe(&named),
            safe(repo)
        ),
    )
    .note("nothing was written")
    .into()
}

/// The `packHash`es of the make-public bundles (kind 7) the owner of `public` recorded: what a
/// run already published. Read from the manifests alone, so a bundle whose bytes a host doesn't
/// serve right now still counts, and a failed read is an error, never "none yet".
async fn owner_bundles(s: &Session, public: &RepoRef) -> Result<BTreeSet<[u8; 32]>> {
    let kind = u64::from(forge_core::pack::KIND_MAKE_PUBLIC);
    Ok(RepoService::reader(&s.client)
        .read_pack_manifests(public)
        .await?
        .into_iter()
        .filter(|m| m.kind == kind && m.owner_id == public.owner_id)
        .map(|m| m.pack_hash)
        .collect())
}

/// The refusal of a run whose seal-off key is no longer the repository's current one.
fn key_changed(label: &str) -> anyhow::Error {
    UserError::new(
        codes::ROTATION_PENDING,
        format!("{label}'s key changed while this ran"),
    )
    .cause("another maintainer changed the key after this run's change")
    .fix(format!(
        "run it again: dg repo make-public {label} --resume"
    ))
    .note("the repo is still private")
    .into()
}

/// `private`'s current key epoch, read fresh, giving a node a block behind a few seconds to show
/// `seal_off`.
async fn current_epoch_after(
    s: &Session,
    private: &RepoRef,
    seal_off: Option<u32>,
) -> Result<Option<u32>> {
    let mut current = None;
    for i in 0..5 {
        if i > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        current = RepoService::new(&s.client, &s.identity, &s.bridge)
            .keyring(private)
            .await?
            .resolution()
            .current_epoch;
        if current >= seal_off {
            break;
        }
    }
    Ok(current)
}

/// The history bundles (DESIGN §4.10 step 7) the owner of `public` recorded: those of its kind-7
/// manifests whose `packHash` is one of the bundles of the keys `kr` holds below `seal_off`, as
/// every run builds them. A bundle making single posts public (§4.6) is kind 7 too and never
/// counts, so an owner who made one comment public has not started publishing the history.
async fn history_bundles(
    s: &Session,
    public: &RepoRef,
    kr: &Keyring,
    seal_off: Option<u32>,
) -> Result<BTreeSet<[u8; 32]>> {
    let Some(seal_off) = seal_off else {
        return Ok(BTreeSet::new());
    };
    let repo_id = forge_core::platform::decode_identifier(&public.repo_id)?;
    let mut expected = BTreeSet::new();
    for b in epoch_key_bundles(&repo_id, &kr.epoch_keys_below(seal_off))? {
        expected.insert(forge_core::backends::PackMeta::for_bytes(&b).pack_hash_bytes()?);
    }
    Ok(owner_bundles(s, public)
        .await?
        .intersection(&expected)
        .copied()
        .collect())
}

/// The make-public bundles of the keys the owner holds below the seal-off epoch that are not
/// recorded yet (bundles are built the same way every run, so a recorded one has the same hash).
fn bundles_to_store(
    repo_id: &[u8; 32],
    held: &BTreeMap<u32, EpochKey>,
    recorded: &BTreeSet<[u8; 32]>,
) -> Result<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    for b in epoch_key_bundles(repo_id, held)? {
        let hash = forge_core::backends::PackMeta::for_bytes(&b).pack_hash_bytes()?;
        if !recorded.contains(&hash) {
            out.push(b);
        }
    }
    Ok(out)
}

/// `repo` as it is once made public: what the published keys and refs are read through.
fn public_view(repo: &RepoRef) -> RepoRef {
    RepoRef {
        visibility: Visibility::Public,
        ..repo.clone()
    }
}

/// Step 0: everything the dialog shows, read without signing. `chosen` is the owner's earlier
/// choice of refs, when this run continues it.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
async fn preflight(
    s: &Session,
    psvc: &RepoService<'_>,
    kr: &Keyring,
    private: &RepoRef,
    conversion: Option<&Conversion>,
    a: &MakePublicArgs,
    mode: Option<Mode>,
    chosen: Option<&[(String, String)]>,
) -> Result<Check> {
    let mut out = Check::default();
    let res = kr.resolution();
    let repo_label = safe(&a.repo).into_owned();
    // the network: the live contracts keep a repository's visibility as created
    if conversion.is_none() && !psvc.can_make_public(private).await? {
        out.blockers.push(visibility_frozen());
    }
    // the keys: the current one held, nothing pending
    match res.current_epoch {
        Some(e) if kr.readable_epochs().contains(&e) => {}
        _ => out.blockers.push(
            UserError::new(
                codes::NOT_A_KEY_HOLDER,
                "you don't hold this repo's current key",
            )
            .fix(format!(
                "ask a maintainer to share it: dg repo keys repair {repo_label}"
            ))
            .note("nothing was written"),
        ),
    }
    if let Some(r) = &res.repair {
        if r.rotate || !r.missing_wraps.is_empty() {
            out.blockers.push(
                UserError::new(
                    codes::ROTATION_PENDING,
                    "this repo's key needs a repair first",
                )
                .fix(format!(
                    "dg repo keys repair {repo_label}, then run this again"
                ))
                .note("nothing was written"),
            );
        }
    }
    let below = conversion
        .and_then(|c| c.seal_off_epoch)
        .or(res.current_epoch.map(|e| e + 1))
        .unwrap_or(0);
    if (0..below).any(|e| res.anchors.contains_key(&e) && !kr.readable_epochs().contains(&e)) {
        out.notes.push(
            "Some history written while private can't be published: nobody holds its key any more. It stays unreadable to everyone.".into(),
        );
    }
    // the private era's refs and settings
    for (name, state) in &psvc.read_refs(private).await? {
        match tip_of(state) {
            Some(tip) => out.all_refs.push((name.clone(), tip)),
            None if *state == RefState::Unborn => out.deleted += 1,
            None => {}
        }
    }
    out.forced = forced_updates(s, psvc, private).await?;
    let cfg = psvc.current_config(private).await?;
    let default_ref = git::full_ref(&cfg.default_branch);
    out.config = Some(cfg);
    // the work repository: every private-era pack this member opens
    let (work, unfetched) = work_repo(psvc, private, &out.all_refs).await?;
    out.unfetched = unfetched;
    // Code only: the refs the owner chose, the refs picked, or the default branch and its tags
    out.code_refs = if let Some(chosen) = chosen {
        chosen.to_vec()
    } else if a.refs.is_empty() {
        default_code_refs(&work, &out.all_refs, &default_ref)
    } else {
        named_code_refs(&out.all_refs, &a.refs, &repo_label)?
    };
    if mode == Some(Mode::CodeOnly) && conversion.is_none() && out.code_refs.is_empty() {
        out.blockers.push(
            UserError::new(codes::USAGE, "Code only would publish no code")
                .cause(format!(
                    "{} has no default branch with commits",
                    safe(&a.repo)
                ))
                .fix("name what to publish with --ref, or choose --everything")
                .note("nothing was written"),
        );
    }
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
    // environments: E812 over every one still holding old-format values, or whose latest version
    // this reader can't open (it can't tell which are marked changed)
    let book = forge_core::env::service::Environments::new(&s.client, &s.identity, &s.bridge)
        .read(private)
        .await?;
    out.environments = book.resolution.environments.len() + book.resolution.hidden.len();
    for e in &book.resolution.environments {
        let Some(old) = book.old_format_of(&e.env) else {
            continue;
        };
        let head_opens = e.heads.last().is_some_and(|h| book.snapshot(h).is_some());
        if old.needs_attention() || !head_opens {
            out.old_format.push(e.env.clone());
        }
    }
    let named: BTreeSet<&String> = book
        .resolution
        .environments
        .iter()
        .flat_map(|e| e.snapshots.iter())
        .collect();
    out.old_format_unreadable = book.old_format.iter().any(|id| !named.contains(id));
    // the fresh pack of what the mode publishes
    let pack_tips: Vec<String> = match mode {
        Some(Mode::Everything) => out.all_refs.iter().map(|(_, t)| t.clone()).collect(),
        _ => tips,
    };
    (out.pack_bytes, out.objects) = pack_size(&work, &pack_tips)?;
    Ok(out)
}

/// Code only's default: the default branch (`default_ref`) and the tags on it, from `all_refs`.
fn default_code_refs(
    work: &Path,
    all_refs: &[(String, String)],
    default_ref: &str,
) -> Vec<(String, String)> {
    let mut picked: Vec<(String, String)> = all_refs
        .iter()
        .filter(|(n, _)| n == default_ref)
        .cloned()
        .collect();
    if let Some((_, tip)) = picked.first().cloned() {
        for (n, t) in all_refs {
            if n.starts_with("refs/tags/") && git::is_ancestor(work, &peeled(work, t), &tip) {
                picked.push((n.clone(), t.clone()));
            }
        }
    }
    picked
}

/// Code only's refs as the owner named them (`--ref`), each a branch or tag of `all_refs`.
fn named_code_refs(
    all_refs: &[(String, String)],
    named: &[String],
    repo_label: &str,
) -> Result<Vec<(String, String)>> {
    named
        .iter()
        .map(|r| {
            let full = candidates(r);
            all_refs
                .iter()
                .find(|(n, _)| full.contains(n))
                .cloned()
                .ok_or_else(|| {
                    crate::errors::not_found(
                        format!("{} is not a branch or tag of {repo_label}", safe(r)),
                        format!("`dg repo make-public {repo_label} --check` lists them"),
                    )
                })
        })
        .collect()
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

/// The full names `r` may mean: itself when it is one, else the branch, then the tag.
fn candidates(r: &str) -> Vec<String> {
    if r.starts_with("refs/") {
        vec![r.to_string()]
    } else {
        vec![git::full_ref(r), format!("refs/tags/{r}")]
    }
}

/// The commit `oid` (a tag object's target) points at.
fn peeled(dir: &Path, oid: &str) -> String {
    git::git(dir, &["rev-parse", &format!("{oid}^{{commit}}")], &[])
        .map_or_else(|_| oid.to_string(), |s| s.trim().to_string())
}

/// The work repository, and how many stored copies of the private era's code it could not fetch:
/// a bare repository holding every private-era pack this member opens (so Everything's scan sees
/// every old object, deleted branches included) and the live refs. A run that could not fetch
/// some reads them all again.
async fn work_repo(
    psvc: &RepoService<'_>,
    private: &RepoRef,
    refs: &[(String, String)],
) -> Result<(PathBuf, usize)> {
    let state = state_dir(private)?;
    private_dir(&state)?;
    let dir = state.join("work.git");
    if !dir.join("HEAD").exists() {
        std::fs::create_dir_all(&dir)?;
        git::git(&dir, &["init", "-q", "--bare"], &[])?;
    }
    let marker = dir.join("make-public-packs");
    // "<opened> <unfetched>" of the last read; a read that missed some is done again
    let unfetched_before = std::fs::read_to_string(&marker)
        .ok()
        .and_then(|t| t.split_whitespace().nth(1)?.parse::<usize>().ok());
    let missing = refs.iter().any(|(_, t)| !git::has_object(&dir, t));
    let unfetched = if missing || unfetched_before.is_none_or(|n| n > 0) {
        let read = psvc
            .open_git_packs(private, |bytes| {
                index_pack(&dir, bytes).map_err(|e| forge_core::Error::Io(format!("{e:#}")))
            })
            .await?;
        std::fs::write(&marker, format!("{} {}\n", read.opened, read.unfetched))?;
        read.unfetched
    } else {
        0
    };
    for (name, tip) in refs {
        if git::has_object(&dir, tip) {
            git::git(&dir, &["update-ref", name, tip], &[])?;
        }
    }
    Ok((dir, unfetched))
}

/// Index one plaintext pack into `dir`.
fn index_pack(dir: &Path, bytes: &[u8]) -> Result<()> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["index-pack", "--stdin", "--fix-thin"])
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

/// Run `git -C dir <args>` with `input` on stdin, returning its stdout (fails on a non-zero exit).
fn git_with_input(dir: &Path, args: &[&str], input: String) -> Result<Vec<u8>> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("running git {}", args.join(" ")))?;
    let mut stdin = child.stdin.take().expect("piped");
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let out = child.wait_with_output()?;
    writer
        .join()
        .map_err(|_| anyhow::anyhow!("writing to git {}", args.join(" ")))??;
    if !out.status.success() {
        anyhow::bail!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(out.stdout)
}

/// The on-disk size and object count of everything reachable from `tips`: about what a pack of
/// them takes.
fn pack_size(dir: &Path, tips: &[String]) -> Result<(u64, u64)> {
    if tips.is_empty() {
        return Ok((0, 0));
    }
    let input = tips.join("\n") + "\n";
    let bytes = git_with_input(
        dir,
        &["rev-list", "--objects", "--disk-usage", "--stdin"],
        input.clone(),
    )?;
    let objects = git_with_input(dir, &["rev-list", "--objects", "--stdin"], input)?;
    let size = String::from_utf8_lossy(&bytes).trim().parse().unwrap_or(0);
    let count = String::from_utf8_lossy(&objects).lines().count() as u64;
    Ok((size, count))
}

/// A scan finding `f` in `place`, as the check reports it.
fn secret_of(f: &forge_secrets::Finding, place: String) -> Secret {
    Secret {
        place,
        rule: format!("{:?}", f.rule),
        fingerprint: f.fingerprint.clone(),
        refuses: forge_secrets::verdict(f, false).severity == forge_secrets::Severity::Refuse,
    }
}

/// `oid path` lines of `git rev-list --objects` over `revs`: each object's first path.
fn object_paths(dir: &Path, revs: &[String]) -> Result<BTreeMap<String, String>> {
    let mut paths = BTreeMap::new();
    if revs.is_empty() {
        return Ok(paths);
    }
    let out = git_with_input(
        dir,
        &["rev-list", "--objects", "--stdin"],
        revs.join("\n") + "\n",
    )?;
    for line in String::from_utf8_lossy(&out).lines() {
        if let Some((oid, path)) = line.split_once(' ') {
            paths
                .entry(oid.to_string())
                .or_insert_with(|| path.to_string());
        }
    }
    Ok(paths)
}

/// Possible secrets in the blobs reachable from `tips` and, with `every`, in every object of the
/// work repository (what the published keys open: deleted and force-pushed-away ones too, named
/// by the paths any commit in the repository gives them). Blobs too large to scan are judged by
/// their names alone, as the push helper does.
fn scan_objects(dir: &Path, tips: &[String], every: bool) -> Result<Vec<Secret>> {
    let all = all_objects(dir)?;
    let paths = if every {
        let commits: Vec<String> = all
            .iter()
            .filter(|(_, (t, _))| t == "commit")
            .map(|(o, _)| o.clone())
            .collect();
        object_paths(dir, &commits)?
    } else {
        object_paths(dir, tips)?
    };
    let blobs: Vec<(&String, u64)> = all
        .iter()
        .filter(|(o, (t, _))| t == "blob" && (every || paths.contains_key(*o)))
        .map(|(o, (_, size))| (o, *size))
        .collect();
    let place = |oid: &str| {
        paths
            .get(oid)
            .cloned()
            .unwrap_or_else(|| format!("(an old object no commit names) {}", short(oid)))
    };
    let mut out = Vec::new();
    let mut readable = Vec::new();
    for (oid, size) in blobs {
        if usize::try_from(size).is_ok_and(|n| n <= forge_secrets::MAX_SCAN_BYTES) {
            readable.push(oid.clone());
        } else {
            let p = place(oid);
            out.extend(
                forge_secrets::scan_unread(&p, oid)
                    .iter()
                    .map(|f| secret_of(f, f.location())),
            );
        }
    }
    each_blob(dir, &readable, |oid, bytes| {
        let p = place(oid);
        let found = if forge_secrets::is_scannable(bytes) {
            forge_secrets::scan_file(&p, bytes)
        } else {
            forge_secrets::scan_unread(&p, &forge_secrets::git_blob_id(bytes))
        };
        out.extend(found.iter().map(|f| secret_of(f, f.location())));
    })?;
    Ok(out)
}

/// Every object of the work repository: its type and size, by id.
fn all_objects(dir: &Path) -> Result<BTreeMap<String, (String, u64)>> {
    let out = git::git(
        dir,
        &[
            "cat-file",
            "--batch-all-objects",
            "--batch-check=%(objectname) %(objecttype) %(objectsize)",
        ],
        &[],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let mut f = l.split(' ');
            let (oid, t, size) = (f.next()?, f.next()?, f.next()?.parse().ok()?);
            Some((oid.to_string(), (t.to_string(), size)))
        })
        .collect())
}

/// `git cat-file --batch` over `oids`, handing each object's id and bytes to `each` as it is read.
fn each_blob(dir: &Path, oids: &[String], mut each: impl FnMut(&str, &[u8])) -> Result<()> {
    if oids.is_empty() {
        return Ok(());
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
    let mut reader = std::io::BufReader::new(child.stdout.take().expect("piped"));
    let mut header = String::new();
    let mut body = Vec::new();
    loop {
        header.clear();
        if reader.read_line(&mut header)? == 0 {
            break;
        }
        let mut f = header.trim_end().split(' ');
        let (Some(oid), Some(_), Some(size)) = (f.next(), f.next(), f.next()) else {
            continue; // "<oid> missing"
        };
        let size: usize = size.parse().context("git cat-file size")?;
        body.resize(size + 1, 0); // the object, then its newline
        reader
            .read_exact(&mut body)
            .context("git cat-file output ended early")?;
        each(oid, &body[..size]);
    }
    writer
        .join()
        .map_err(|_| anyhow::anyhow!("git cat-file input"))??;
    let status = child.wait()?;
    anyhow::ensure!(status.success(), "git cat-file --batch failed");
    Ok(())
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

/// What stops publishing in `mode` before anything is signed, beyond the check's blockers: a
/// possible secret not allowed, and with Everything, old-format environments (E812) and code
/// that could not be fetched (so was not scanned).
fn gate(check: &Check, mode: Mode, allowed: &BTreeSet<String>, label: &str) -> Result<()> {
    if mode == Mode::Everything {
        if let Some(env) = check.old_format.first() {
            return Err(UserError::new(
                codes::MAKE_PUBLIC_BLOCKED,
                format!("can't make everything public: environment {} has values saved in the old format, which would become public", safe(env)),
            )
            .fix(format!("dg env resave --env {env}, change every listed value where it's used, then dg env mark-changed --env {env}"))
            .fix(format!("or make only the code public: dg repo make-public {label} --code-only"))
            .note("nothing was written")
            .into());
        }
        if check.old_format_unreadable {
            return Err(UserError::new(
                codes::MAKE_PUBLIC_BLOCKED,
                "can't make everything public: an environment you can't read has values saved in the old format, which would become public",
            )
            .fix("ask the maintainers it was saved for to save it again and mark its values changed")
            .fix(format!("or make only the code public: dg repo make-public {label} --code-only"))
            .note("nothing was written")
            .into());
        }
        if check.unfetched > 0 {
            return Err(UserError::new(
                codes::PACKS_UNREADABLE,
                format!(
                    "can't make everything public: {} of the code written while private couldn't be fetched, so it wasn't checked for secrets",
                    plural_with(check.unfetched, "stored copy", "stored copies")
                ),
            )
            .fix("run it again; a copy that is back is read then")
            .note("nothing was written")
            .into());
        }
    }
    let blocking: Vec<&Secret> = secrets_of(check, mode)
        .into_iter()
        .filter(|s| s.refuses && !allowed.contains(&s.fingerprint))
        .collect();
    if let Some(first) = blocking.first() {
        let mut e = UserError::new(
            codes::SECRET_IN_PUSH,
            format!(
                "this would publish a possible secret in {}",
                safe(&first.place)
            ),
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
    Ok(())
}

/// The estimate of a run in `mode`: the seal-off rotation and the flip (while private), the
/// config (until it exists), the push (its metadata, and its chunks when Platform stores the code)
/// and, with Everything, the history. `(credits, storage credits)`.
fn estimate(
    check: &Check,
    kr: &Keyring,
    mode: Mode,
    conversion: Option<&Conversion>,
) -> (u64, u64) {
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
    if conversion.is_none() {
        credits += crate::keys::rotation_cost(kr, crate::keys::distinct_members(kr.members())).0
            + FLIP_ESTIMATE_CREDITS;
    }
    if conversion.is_none_or(|c| c.marker_height.is_none()) {
        credits += CONFIG_ESTIMATE_CREDITS;
    }
    if mode == Mode::Everything {
        let n = kr.readable_epochs().len() as u64;
        credits += push_fees::long_body(7 + 69 * n + 64, false, 0, true);
    }
    (credits, push.chunk_credits)
}

/// "1 person", "3 people".
fn people(n: usize) -> String {
    plural_with(n, "person", "people")
}

/// `refs/heads/x` and `refs/tags/x` as `x`.
fn short_ref(name: &str) -> &str {
    name.strip_prefix("refs/heads/")
        .or_else(|| name.strip_prefix("refs/tags/"))
        .unwrap_or(name)
}

/// What Everything makes readable, counted: the non-zero counts, in the dialog's order.
fn everything_counts(check: &Check) -> String {
    let c = &check.census;
    let parts: Vec<String> = [
        (c.issues, "issue", "issues"),
        (c.prs, "pull request", "pull requests"),
        (c.comments, "comment", "comments"),
        (c.reviews, "review", "reviews"),
        (c.revisions, "earlier edit", "earlier edits"),
        (c.hidden, "hidden item", "hidden items"),
        (
            check.all_refs.len(),
            "live branch or tag",
            "live branches and tags",
        ),
        (check.deleted, "deleted branch", "deleted branches"),
        (check.forced, "force-push", "force-pushes"),
        (
            c.bot_requests,
            "request sent to bots",
            "requests sent to bots",
        ),
    ]
    .iter()
    .filter(|(n, _, _)| *n > 0)
    .map(|(n, one, many)| plural_with(*n, one, many))
    .chain((!c.imported.is_empty()).then(|| {
        format!(
            "imported posts by {} from {}",
            people(c.imported.len()),
            c.imported_hosts()
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ")
        )
    }))
    .collect();
    if parts.is_empty() {
        "nothing written yet".into()
    } else {
        parts.join(", ")
    }
}

/// The check, as the dialog shows it (DESIGN §10 "Make this repo public").
#[allow(clippy::too_many_lines)]
fn print_check(
    ctx: &Ctx,
    repo: &RepoRef,
    label: &str,
    check: &Check,
    mode: Option<Mode>,
    kr: &Keyring,
    conversion: Option<&Conversion>,
) {
    let price = ctx.usd_price();
    let modes: Vec<Mode> = match mode {
        Some(m) => vec![m],
        None => vec![Mode::CodeOnly, Mode::Everything],
    };
    let c = &check.census;
    let tags = check
        .code_refs
        .iter()
        .filter(|(n, _)| n.starts_with("refs/tags/"))
        .count();
    let branches: Vec<&str> = check
        .code_refs
        .iter()
        .filter(|(n, _)| n.starts_with("refs/heads/"))
        .map(|(n, _)| short_ref(n))
        .collect();
    let estimates: Vec<Value> = modes
        .iter()
        .map(|&m| {
            let (credits, storage) = estimate(check, kr, m, conversion);
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
    let mut old_format = check.old_format.clone();
    if check.old_format_unreadable {
        old_format.push("(an environment you can't read)".into());
    }
    ctx.emit(
        json!({
            "status": "check",
            "repo": repo.display(),
            "owner": repo.owner_id,
            "mode": mode,
            "made": conversion.is_some(),
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
                "oldFormatEnvironments": old_format,
                "unfetched": check.unfetched,
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
                let others: Vec<&str> = check
                    .all_refs
                    .iter()
                    .filter(|r| !check.code_refs.contains(r))
                    .map(|(n, _)| short_ref(n))
                    .collect();
                if !others.is_empty() {
                    println!("    Not chosen: {} (--ref picks branches and tags)", others.join(", "));
                }
                println!("    Issues, pull requests, reviews and other branches stay members-only. You can make them public later.");
                print_secrets(&secrets_of(check, Mode::CodeOnly), false);
            }
            if modes.contains(&Mode::Everything) {
                println!("  Everything (--everything)");
                println!("    Everything members could ever read until now: every issue, pull request, comment and review, every earlier edit, deleted and hidden comments, every branch ever pushed, old settings, imported authors and links, and requests sent to bots. Releases made while the repo was private stay hidden.");
                println!("    That is {}.", everything_counts(check));
                if c.unread > 0 {
                    println!("    {} you can't read yourself aren't counted.", plural(c.unread, "post"));
                }
                if !c.authors.is_empty() {
                    println!(
                        "    Words by {}{} become public.",
                        people(c.authors.len()),
                        if check.former.is_empty() { String::new() } else { format!(", including {}", plural(check.former.len(), "former member")) }
                    );
                }
                print_secrets(&secrets_of(check, Mode::Everything), true);
                for env in &check.old_format {
                    println!("    Blocked (E812): environment {} has values saved in the old format, which would become public. Fix: dg env resave --env {env}, change every listed value where it's used, then dg env mark-changed --env {env}", safe(env));
                }
                if check.old_format_unreadable {
                    println!("    Blocked (E812): an environment you can't read has values saved in the old format, which would become public. Ask the maintainers it was saved for to save it again and mark its values changed.");
                }
                if check.unfetched > 0 {
                    println!("    Blocked: {} of the code written while private couldn't be fetched, so it wasn't checked for secrets. Run it again.", plural_with(check.unfetched, "stored copy", "stored copies"));
                }
            }
            println!();
            println!(
                "Stays private: {}, {}, and everything members write from now on.",
                plural_with(c.letters, "message to specific people", "messages to specific people"),
                plural(check.environments, "environment")
            );
            println!("Members-only content keeps working afterwards, without a pause.");
            println!("People on Forge older than {CONVERTED_REPO_MIN_CLIENT_VERSION} can't clone it until they update.");
            for m in &modes {
                let (credits, storage) = estimate(check, kr, *m, conversion);
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

/// The scan line: the possible secrets, or that none was found (with Everything, saying what it
/// doesn't look at).
fn print_secrets(found: &[&Secret], everything: bool) {
    if found.is_empty() {
        if everything {
            println!("    No secrets found in the code and the posts as they read now. Earlier edits, deleted comments and long posts kept in storage aren't checked.");
        } else {
            println!("    No secrets found in what you're publishing.");
        }
        return;
    }
    for s in found {
        println!(
            "    Possible secret in {}{}",
            safe(&s.place),
            if s.refuses {
                format!(" (publish anyway: --allow-secret {})", s.fingerprint)
            } else {
                String::new()
            }
        );
    }
}

/// One run's context, for [`convert`].
struct Run<'r> {
    ctx: &'r Ctx,
    s: &'r Session,
    svc: &'r RepoService<'r>,
    psvc: &'r RepoService<'r>,
    kr: &'r Keyring,
    private: &'r RepoRef,
    conversion: Option<Conversion>,
    saved: Option<Saved>,
    mode: Mode,
    history_started: bool,
    a: &'r MakePublicArgs,
    dir: &'r Path,
}

/// Steps 1–7.
#[allow(clippy::too_many_lines)]
async fn convert(r: Run<'_>, mut check: Check) -> Result<()> {
    let Run {
        ctx,
        s,
        svc,
        psvc,
        kr,
        private,
        conversion,
        saved,
        mode,
        history_started,
        a,
        dir,
    } = r;
    let label = safe(&a.repo).into_owned();
    let price = ctx.usd_price();
    let is_owner = s.identity.id() == s.repo.owner_id;
    let flipped = conversion.is_some();
    let public = public_view(&s.repo);
    // A run that stops before signing anything, with no earlier run to continue, leaves no
    // plaintext of the private era behind.
    let fresh_start = !flipped && saved.is_none();
    let discard = |e: anyhow::Error| {
        if fresh_start {
            let _ = std::fs::remove_dir_all(dir.join("work.git"));
        }
        e
    };
    // only the owner flips, and only the owner chooses Everything
    if !is_owner && (!flipped || (mode == Mode::Everything && !history_started)) {
        return Err(discard(not_the_owner(s, &a.repo).await));
    }
    if !flipped {
        if let Some(b) = check.blockers.first() {
            return Err(discard(b.clone().into()));
        }
    }
    // the refs this run publishes: the owner's earlier choice on this computer, else the
    // check's; a maintainer finishing someone else's run names them
    let saved_here = saved.as_ref().is_some_and(|sv| sv.mode == mode);
    let mut wanted: Vec<(String, String)> = match mode {
        Mode::CodeOnly => check.code_refs.clone(),
        Mode::Everything => check.all_refs.clone(),
    };
    if flipped && !is_owner && mode == Mode::CodeOnly && !saved_here && a.refs.is_empty() {
        return Err(UserError::new(
            codes::USAGE,
            format!("say which branches and tags the owner chose for {label}"),
        )
        .cause("this computer has no record of the run that made it public")
        .fix(format!(
            "dg repo make-public {label} --resume --code-only --ref main (one --ref for each)"
        ))
        .note("nothing was written")
        .into());
    }
    // what is public already, and what members continued after the flip (never published)
    let (public_refs, members_only) = if flipped {
        public_state(svc, &public).await?
    } else {
        (BTreeMap::new(), BTreeSet::new())
    };
    let todo = unpublished_refs(&wanted, &public_refs, &members_only);
    let left_out: Vec<String> = wanted
        .iter()
        .filter(|(n, _)| members_only.contains(n) && !public_refs.contains_key(n))
        .map(|(n, _)| n.clone())
        .collect();
    let publishes_history = mode == Mode::Everything && is_owner;
    let recorded = if flipped && publishes_history {
        history_bundles(
            s,
            &public,
            kr,
            history_cutoff(
                conversion.as_ref().and_then(|c| c.seal_off_epoch),
                saved.as_ref().and_then(|sv| sv.seal_off),
            ),
        )
        .await?
    } else {
        BTreeSet::new()
    };
    // a publication this computer has no confirmation of: refs not public yet, or the history
    let new_publication = !flipped
        || (!todo.is_empty() && !saved_here)
        || (publishes_history && recorded.is_empty() && !saved_here);
    let allowed: BTreeSet<String> = a
        .allow_secret
        .iter()
        .map(|f| f.to_ascii_lowercase())
        .collect();
    if new_publication || publishes_history {
        gate(&check, mode, &allowed, &label).map_err(discard)?;
    }
    let (credits, storage) = estimate(&check, kr, mode, conversion.as_ref());
    if new_publication && !(a.resume && saved_here) {
        if !ctx.json {
            print_check(
                ctx,
                &s.repo,
                &a.repo,
                &check,
                Some(mode),
                kr,
                conversion.as_ref(),
            );
        }
        typed_confirmation(ctx, &a.repo).map_err(discard)?;
    } else {
        ctx.confirm_or_cancel(&format!(
            "Continue making {label} public ({}): about {}, plus storing the code ({} on Platform)?",
            mode.label(),
            cost_line(credits, price),
            cost_line(storage, price)
        ))
        .map_err(discard)?;
    }
    let before = s.balance().await;
    let mut steps: Vec<Value> = Vec::new();
    let mut saved = saved.unwrap_or(Saved {
        repo_id: s.repo.repo_id.clone(),
        mode,
        refs: Vec::new(),
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
            let rotation =
                forge_core::keyring::rotate(&crate::keys::signer(s), private, &[]).await?;
            saved.seal_off = Some(rotation.epoch);
            saved.save(dir)?;
            if !ctx.json {
                println!("Everything members write from now on stays members-only.");
            }
            steps.push(json!({ "step": "sealOff", "status": "written", "epoch": rotation.epoch }));
        }
        // What Everything publishes is final now (everything below the seal-off rotation): check
        // it again, since members may have written or pushed since the first check.
        let mut fresh_psvc = RepoService::new(&s.client, &s.identity, &s.bridge);
        let mut fresh_kr = fresh_psvc.keyring(private).await?;
        // a node a block behind may not show the rotation yet
        for _ in 0..5 {
            if fresh_kr.resolution().current_epoch >= saved.seal_off {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            fresh_psvc = RepoService::new(&s.client, &s.identity, &s.bridge);
            fresh_kr = fresh_psvc.keyring(private).await?;
        }
        if fresh_kr.resolution().current_epoch != saved.seal_off {
            return Err(key_changed(&label));
        }
        if mode == Mode::Everything {
            let again = Box::pin(preflight(
                s,
                &fresh_psvc,
                &fresh_kr,
                private,
                None,
                a,
                Some(mode),
                Some(wanted.as_slice()),
            ))
            .await?;
            if let Err(e) = gate(&again, mode, &allowed, &label) {
                eprintln!("note: checked again after this run's key change: the repo is still private, and the run can be finished with --resume");
                return Err(e);
            }
            wanted.clone_from(&again.all_refs);
            saved.refs.clone_from(&wanted);
            saved.save(dir)?;
            check = again;
        }
        let default_branch = check
            .config
            .as_ref()
            .map_or("main", |c| c.default_branch.as_str());
        // The second check can take minutes: a rotation by another maintainer meanwhile would put
        // the run's own seal-off key below the stated cutoff, so the key is read again, last.
        if current_epoch_after(s, private, saved.seal_off).await? != saved.seal_off {
            return Err(key_changed(&label));
        }
        svc.make_repo_public(&s.repo, default_branch).await?;
        if !ctx.json {
            println!("{label} is public now. It can never be private again.");
        }
        steps.push(json!({ "step": "flip", "status": "written" }));
    }
    // 4. the first public settings
    let fresh = RepoService::new(&s.client, &s.identity, &s.bridge);
    let marker = fresh
        .conversion(&public)
        .await?
        .and_then(|c| c.marker_height);
    if marker.is_none() {
        let cfg = check.config.unwrap_or_default();
        fresh.write_converted_config(&public, &cfg).await?;
        steps.push(json!({ "step": "config", "status": "written" }));
    } else {
        steps.push(json!({ "step": "config", "status": "done" }));
    }
    // 5. the code
    let (public_refs, members_only) = public_state(&fresh, &public).await?;
    let todo = unpublished_refs(&wanted, &public_refs, &members_only);
    if todo.is_empty() {
        steps.push(json!({ "step": "code", "status": "done" }));
    } else {
        let (work, _) = work_repo(psvc, private, &wanted).await?;
        push_public(ctx, &s.repo, &work, &todo, &allowed)?;
        steps.push(json!({ "step": "code", "status": "written", "refs": todo.iter().map(|(n, _)| n).collect::<Vec<_>>() }));
    }
    if !ctx.json {
        for n in &left_out {
            println!(
                "Not published: {}: members-only commits were pushed to it after the repo was made public.",
                safe(short_ref(n))
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
        let seal_off = history_cutoff(c.seal_off_epoch, saved.seal_off).unwrap_or(0);
        let held = RepoService::new(&s.client, &s.identity, &s.bridge)
            .keyring(private)
            .await?
            .epoch_keys_below(seal_off);
        let repo_id = forge_core::platform::decode_identifier(&s.repo.repo_id)?;
        let left = bundles_to_store(&repo_id, &held, &owner_bundles(s, &public).await?)?;
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
            for b in &left {
                fresh.store_make_public_bundle(&public, b).await?;
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
            "notPublished": left_out,
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

/// The refs of `wanted` still to publish: not public yet, and not continued by members after the
/// flip.
fn unpublished_refs<'w>(
    wanted: &'w [(String, String)],
    public_refs: &BTreeMap<String, String>,
    members_only: &BTreeSet<String>,
) -> Vec<&'w (String, String)> {
    wanted
        .iter()
        .filter(|(n, _)| !public_refs.contains_key(n) && !members_only.contains(n))
        .collect()
}

/// Step 5's push: `todo` from the work repository `work` to `repo` as public refs, through
/// `git-remote-dash`, passing along the secrets the owner allowed.
fn push_public(
    ctx: &Ctx,
    repo: &RepoRef,
    work: &Path,
    todo: &[&(String, String)],
    allowed: &BTreeSet<String>,
) -> Result<()> {
    let mut args: Vec<String> = vec!["push".into(), "-o".into(), "public".into()];
    for f in allowed {
        args.push("-o".into());
        args.push(format!("{}={f}", forge_secrets::ALLOW_PUSH_OPTION));
    }
    args.push(repo.remote_url());
    for (n, t) in todo {
        args.push(format!("{t}:{n}"));
    }
    let push: Vec<&str> = args.iter().map(String::as_str).collect();
    git::git_dash(work, &push, &git::dash_env_signing(ctx)?)
        .context("pushing the published branches and tags")?;
    Ok(())
}

/// The public refs of `public` (name -> tip) and the refs members continued after the flip, which
/// are never published (their newest update is members-only).
async fn public_state(
    svc: &RepoService<'_>,
    public: &RepoRef,
) -> Result<(BTreeMap<String, String>, BTreeSet<String>)> {
    let public_refs = svc
        .read_refs(public)
        .await?
        .into_iter()
        .filter_map(|(n, st)| tip_of(&st).map(|t| (n, t)))
        .collect();
    let members_only = match svc.read_members_refs(public).await? {
        Some(m) => m
            .refs
            .iter()
            .filter(|r| r.members_only)
            .map(|r| r.name.clone())
            .collect(),
        None => BTreeSet::new(),
    };
    Ok((public_refs, members_only))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    /// Everything's widened scan reads an object no live branch holds (a branch deleted while
    /// private), under the path its own commit gives it, so path rules (`.env`) still fire; the
    /// scan of the published tips alone does not see it.
    #[test]
    fn the_widened_scan_reads_deleted_history_by_its_paths() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        git(d, &["init", "-q", "-b", "main"]);
        std::fs::write(d.join("README.md"), "hello\n").unwrap();
        git(d, &["add", "README.md"]);
        git(d, &["commit", "-q", "-m", "main"]);
        let main = git(d, &["rev-parse", "HEAD"]);
        git(d, &["checkout", "-q", "-b", "gone"]);
        std::fs::write(d.join(".env"), "API_TOKEN=s3cr3t-value-here\n").unwrap();
        git(d, &["add", ".env"]);
        git(d, &["commit", "-q", "-m", "a secret"]);
        git(d, &["checkout", "-q", "main"]);
        git(d, &["branch", "-q", "-D", "gone"]);

        let tips = vec![main];
        assert!(scan_objects(d, &tips, false).unwrap().is_empty());
        let every = scan_objects(d, &tips, true).unwrap();
        assert!(
            every
                .iter()
                .any(|s| s.place.starts_with(".env") && s.refuses),
            "{every:?}"
        );
        // a pack-size estimate of the published tips counts their objects
        let (bytes, objects) = pack_size(d, &tips).unwrap();
        assert!(bytes > 0);
        assert_eq!(objects, 3); // the commit, its tree and README.md
    }

    #[test]
    fn a_short_ref_name_means_the_branch_then_the_tag() {
        assert_eq!(
            candidates("v1"),
            vec!["refs/heads/v1".to_string(), "refs/tags/v1".to_string()]
        );
        assert_eq!(candidates("refs/tags/v1"), vec!["refs/tags/v1".to_string()]);
        assert_eq!(short_ref("refs/heads/a/b"), "a/b");
        assert_eq!(short_ref("refs/tags/v1"), "v1");
        assert_eq!(people(1), "1 person");
        assert_eq!(people(3), "3 people");
    }

    #[test]
    fn a_record_that_cant_be_read_is_an_error_not_no_record() {
        let dir = tempfile::tempdir().unwrap();
        let repo = RepoRef {
            forge: forge_core::network::ForgeIds::test_forge_meta(),
            repo_id: "R".into(),
            owner_id: "O".into(),
            name: "n".into(),
            visibility: Visibility::Private,
        };
        assert!(Saved::load(dir.path(), &repo).unwrap().is_none());
        std::fs::write(dir.path().join("state.json"), "{not json").unwrap();
        assert!(Saved::load(dir.path(), &repo).is_err());
        let saved = Saved {
            repo_id: "R".into(),
            mode: Mode::CodeOnly,
            refs: vec![("refs/heads/main".into(), "ab".repeat(20))],
            seal_off: Some(3),
        };
        saved.save(dir.path()).unwrap();
        let back = Saved::load(dir.path(), &repo).unwrap().unwrap();
        assert_eq!((back.mode, back.seal_off), (Mode::CodeOnly, Some(3)));
        // another repository's record is not this one's
        let other = RepoRef {
            repo_id: "X".into(),
            ..repo
        };
        assert!(Saved::load(dir.path(), &other).unwrap().is_none());
    }
}
