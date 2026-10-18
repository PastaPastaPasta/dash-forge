//! `dg repo make-public`: a private repository made public, once, by its owner (mixed-visibility
//! DESIGN §4.10, D36, D45; §10 "Make this repo public").
//!
//! Two modes, and nothing is chosen for the owner:
//!
//! * **Code only** (`--code-only`): a fresh public copy of the code of the branches and tags the
//!   owner picks (by default the default branch and the tags on it). Issues, pull requests,
//!   reviews and other branches stay members-only.
//! * **Everything** (`--everything`): every live branch and tag, and the keys of everything
//!   members could read before the publication boundary, published last. Code only can become Everything later (run
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
//!
//! The seal-off epoch is the run's boundary, fixed when its rotation first lands: nothing at or
//! after it is ever published. Every conversion client reads the owner's sealed marker from the
//! chain, including on a fresh device. The lowest boundary still in force is kept;
//! the newest private epoch remains an upper bound after the flip. The flip happens only while
//! the run's own seal-off key is the current one. Once another rotation follows it, the run can
//! no longer be finished with that boundary ([`SealOff::Passed`]): it never rotates again (that
//! would move the boundary later), and only a new run the owner starts on purpose
//! (`--start-over`) can make the repo public.

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
    epoch_key_bundles, history_cutoff, ActiveSealOff, Conversion, SealOffMarker, SealOffMode,
    CONVERTED_REPO_MIN_CLIENT_VERSION,
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
    /// Everything: everything members could read before the publication boundary, every branch
    /// and tag included.
    #[arg(long)]
    pub everything: bool,
    /// With --code-only: a branch or tag to publish (repeat it for more).
    #[arg(long = "ref", value_name = "REF", requires = "code_only")]
    pub refs: Vec<String>,
    /// Finish a run that stopped: any maintainer once the repo is public, the owner for the rest.
    #[arg(long)]
    pub resume: bool,
    /// Start a new run instead of the one this computer recorded, which can't be finished: the
    /// repo's key changed after it began. The new run's own key change is the new boundary, so
    /// with Everything what members wrote since then becomes public too. Only while the repo is
    /// still private.
    #[arg(long, conflicts_with = "resume")]
    pub start_over: bool,
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

    /// The mode's flag.
    fn flag(self) -> &'static str {
        match self {
            Mode::CodeOnly => "--code-only",
            Mode::Everything => "--everything",
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
    /// The current epoch when the seal-off rotation began, kept before it is signed: a rotation
    /// that landed but whose answer was lost is then found again ([`recorded_seal_off`]),
    /// never made a second time.
    #[serde(default)]
    seal_off_from: Option<u32>,
    #[serde(default)]
    conversion_id: Option<String>,
    #[serde(default)]
    started_at_ms: Option<u64>,
    /// Retained until marker confirmation, including an interrupted start-over follow-up.
    #[serde(default)]
    replaces_epoch: Option<u32>,
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
pub(crate) fn private_dir(dir: &Path) -> Result<()> {
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
    /// The adopted or clamped cutoff used by this check and the publication steps.
    below: Option<u32>,
    /// What stops the run before anything is signed.
    blockers: Vec<UserError>,
    /// What the owner should know.
    notes: Vec<String>,
    /// The refs Code only publishes, with their tips.
    code_refs: Vec<(String, String)>,
    /// Refs of the owner's earlier choice left out: their recorded tip is not the tip they had
    /// before the run's boundary, nor an earlier commit of it.
    dropped: Vec<String>,
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
    let mut saved = Saved::load(&dir, &s.repo)?;
    let me = s.identity.id();
    let owner = s.repo.owner_id.as_str();
    let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
    let conversion = if s.repo.visibility == Visibility::Public {
        match svc.anchored_conversion(&s.repo).await? {
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
    let mut kr = psvc.keyring(&private).await?;
    if !is_maintainer(&kr, &me, owner) {
        return Err(not_the_owner(&s, &a.repo).await);
    }
    // This computer's record of a run not made public yet: continued while its seal-off key is
    // the current one, never once another rotation followed it, and set aside only on purpose.
    let label = safe(&a.repo).into_owned();
    // A node behind the run's rotation is waited for a few seconds first (a rotation that
    // landed unrecorded shows as `from + 1`); one that landed but was never recorded is then
    // found again: only ever earlier.
    let (mut current, mut burned) = (
        kr.resolution().current_epoch,
        kr.resolution().burned.clone(),
    );
    let mut active = kr.active_seal_off(&forge_core::platform::decode_identifier(owner)?);
    if active == ActiveSealOff::Unknown {
        return Err(repair_marker_keys(&label));
    }
    let target = saved
        .as_ref()
        .and_then(|sv| wait_target(sv.seal_off, sv.seal_off_from))
        .or(active.epoch());
    if conversion.is_none() && !a.check && target.is_some() && current < target {
        (current, burned) = current_epoch_after(&s, &private, target).await?;
    }
    // A confirmed start-over can land its rotation before its follow-up is confirmed.
    // Finish that marker before applying the ordinary lower-boundary rule.
    if conversion.is_none() && !a.check && !a.start_over && me == owner {
        if let Some((sv, epoch)) = saved.as_mut().and_then(|sv| {
            pending_replacement(sv, &active, current, &burned).map(|epoch| (sv, epoch))
        }) {
            let mode = sv.mode;
            let marker = marker_for_record(sv, mode, epoch, None)?;
            sv.save(&dir)?;
            forge_core::keyring::ensure_seal_off_marker(
                &crate::keys::signer(&s),
                &private,
                &marker,
            )
            .await?;
            let fresh = RepoService::new(&s.client, &s.identity, &s.bridge);
            kr = fresh.keyring(&private).await?;
            active = kr.active_seal_off(&forge_core::platform::decode_identifier(owner)?);
            if active == ActiveSealOff::Unknown {
                return Err(repair_marker_keys(&label));
            }
            current = kr.resolution().current_epoch;
            burned.clone_from(&kr.resolution().burned);
        }
    }
    let marked = active.epoch();
    let local_boundary = saved
        .as_ref()
        .and_then(|sv| recorded_seal_off(sv.seal_off, sv.seal_off_from, current, &burned));
    if let Some(sv) = saved.as_mut() {
        sv.seal_off = active.boundary(recorded_seal_off(
            sv.seal_off,
            sv.seal_off_from,
            current,
            &burned,
        ));
    }
    if let (Some(local), Some(marker)) = (local_boundary, marked) {
        if local != marker && !ctx.json {
            println!("The local record and the owner marker differ; publishing stops below key epoch {}.", active.boundary(local_boundary).expect("a marker exists"));
        }
    }
    let mut passed_here = None;
    let mut start_over = None;
    let saved = if conversion.is_some() {
        if a.start_over {
            return Err(start_over_refused(
                &label,
                format!("{label} is public already: its run can only be finished"),
            ));
        }
        saved
    } else {
        let state = seal_off_state(saved.as_ref().and_then(|sv| sv.seal_off), &active, current);
        match keep_record(state, a.start_over) {
            // said before the check and the confirmation, not after them
            Ok(true) if matches!(state, SealOff::Behind(_)) && !a.check && me == owner => {
                return Err(platform_behind(&label));
            }
            Ok(true) => saved,
            Ok(false) => {
                if let SealOff::Passed(e) = state {
                    start_over = Some(StartOver {
                        epoch: e,
                        replaces_epoch: active.replacement_epoch(local_boundary).unwrap_or(e),
                        height: kr.resolution().anchors.get(&e).map(|an| an.height),
                        ref_updates: psvc.ref_updates_sealed_from(&private, e).await?,
                    });
                }
                None
            }
            // a check signs nothing, and anyone but the owner is refused before any step
            Err(SealOff::Passed(e)) if a.check || me != owner => {
                passed_here = Some(e);
                saved
            }
            Err(SealOff::Unknown) => return Err(repair_marker_keys(&label)),
            Err(SealOff::Passed(_)) => {
                let m = flag_mode
                    .or(saved.as_ref().map(|sv| sv.mode))
                    .unwrap_or(Mode::Everything);
                return Err(seal_off_passed(&label, m));
            }
            Err(_) if saved.is_none() => {
                return Err(UserError::new(
                    codes::USAGE,
                    format!("this computer has no run making {label} public to start over"),
                )
                .fix(format!(
                    "make it public: dg repo make-public {label} --code-only (or --everything)"
                ))
                .note("nothing was written")
                .into())
            }
            Err(_) => {
                return Err(start_over_refused(
                    &label,
                    format!("the run making {label} public can still be finished"),
                ))
            }
        }
    };
    if start_over.is_some_and(|so| current < Some(so.replaces_epoch)) {
        return Err(platform_behind(&label));
    }
    let boundary = if start_over.is_some() {
        None
    } else {
        history_cutoff(saved.as_ref().and_then(|sv| sv.seal_off), marked)
    };
    // a run that started Everything (some history published) finishes as Everything
    let history_started = match &conversion {
        Some(c) => !history_bundles(
            &s,
            &public_view(&s.repo),
            &kr,
            history_cutoff(c.seal_off_epoch, boundary),
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
    let chosen_mode = flag_mode
        .or(saved.as_ref().map(|s| s.mode))
        .or(history_started.then_some(Mode::Everything));
    let public_refs = if chosen_mode.is_none() && a.resume && conversion.is_some() {
        public_state(&svc, &public_view(&s.repo)).await?.0
    } else {
        BTreeMap::new()
    };
    let (mode, inferred_mode) =
        resume_mode(chosen_mode, conversion.is_some(), a.resume, &public_refs);
    // what the owner chose on this computer, when this run continues it
    let chosen = saved
        .as_ref()
        .filter(|sv| Some(sv.mode) == mode && a.refs.is_empty())
        .map(|sv| sv.refs.clone());
    // what the run publishes stops at its boundary: the check reads only what was sealed below it
    // (a check of a record whose boundary is passed shows what a new run would publish)
    let recorded = boundary.filter(|_| passed_here.is_none());
    let below = match &conversion {
        Some(c) => history_cutoff(c.seal_off_epoch, recorded),
        None => recorded,
    };
    let mut check = Box::pin(preflight(
        &s,
        &psvc,
        &kr,
        &private,
        conversion.as_ref(),
        a,
        mode,
        chosen.as_deref(),
        below,
    ))
    .await?;
    if passed_here.is_some() {
        check.notes.push(format!(
            "The run this computer recorded can't be finished: the repo's key changed after its own key change. To make the repo public, start a new run: dg repo make-public {label} --start-over (with --code-only or --everything)."
        ));
    }
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
    let mode = mode_to_finish(mode, &a.repo)?;
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
            inferred_mode,
            history_started,
            start_over,
            checked_below: below,
            boundary,
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

/// Where a run that is not public yet stands with its seal-off rotation (step 2), from this
/// computer's record of it and the repository's current key epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SealOff {
    /// No seal-off rotation recorded: the run makes one.
    Rotate,
    /// The recorded rotation is the current key: kept, never made again.
    Keep(u32),
    /// A node doesn't show the recorded rotation yet: never rotate again, wait for it.
    Behind(u32),
    /// Another rotation followed the recorded one. The run's boundary stays where it is, so this
    /// run can't be finished: flipping now would state a later boundary.
    Passed(u32),
    /// An owner config could not be opened: repair keys before continuing.
    Unknown,
}

/// The run's seal-off epoch: the one recorded, else, when a rotation began from epoch `from` and
/// its answer was lost, the first epoch after `from` that is not burned, once the key read now
/// (`current`) shows one. That can only be the run's own rotation or an earlier boundary than
/// it. `None` while none shows: the rotation is made (or resumed, with the same key).
fn recorded_seal_off(
    recorded: Option<u32>,
    from: Option<u32>,
    current: Option<u32>,
    burned: &BTreeSet<u32>,
) -> Option<u32> {
    recorded.or_else(|| {
        let (from, current) = (from?, current?);
        (from.checked_add(1)?..=current).find(|e| !burned.contains(e))
    })
}

/// The key epoch a read waits a few seconds for before deciding (a node may be a block behind):
/// the recorded seal-off epoch, else `from + 1`, which a rotation that landed unrecorded shows as.
fn wait_target(seal_off: Option<u32>, from: Option<u32>) -> Option<u32> {
    seal_off.or(from.and_then(|f| f.checked_add(1)))
}

/// What step 2 does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step2 {
    /// The recorded seal-off rotation is the current key: kept.
    Keep(u32),
    /// No seal-off rotation yet: make it.
    Rotate,
    /// Stop: a node is behind, or the run's boundary is passed.
    Stop(SealOff),
}

/// Step 2 for the run's seal-off epoch `seal_off` ([`recorded_seal_off`]) and the key epoch
/// `current` read now.
fn step2(seal_off: Option<u32>, current: Option<u32>) -> Step2 {
    match seal_off_state(seal_off, &ActiveSealOff::None, current) {
        SealOff::Keep(e) => Step2::Keep(e),
        SealOff::Rotate => Step2::Rotate,
        st => Step2::Stop(st),
    }
}

/// Whether the flip may go ahead: the key read right before it (`now`) is still the run's own
/// seal-off key, so the boundary the flip states is the run's.
fn may_flip(seal_off: Option<u32>, now: Option<u32>) -> Result<(), SealOff> {
    match seal_off_state(seal_off, &ActiveSealOff::None, now) {
        SealOff::Keep(_) => Ok(()),
        st => Err(st),
    }
}

/// [`SealOff`] for the seal-off epoch `recorded` (this computer's record) and the key epoch
/// `current` read now, after applying any owner replacement.
fn seal_off_state(recorded: Option<u32>, active: &ActiveSealOff, current: Option<u32>) -> SealOff {
    use forge_core::private::convert::{seal_off_decision, SealOffDecision};
    match seal_off_decision(recorded, active, current, false, None) {
        SealOffDecision::New => SealOff::Rotate,
        SealOffDecision::Adopt(e) => SealOff::Keep(e),
        SealOffDecision::Passed(e) => SealOff::Passed(e),
        SealOffDecision::Lagging(e) => SealOff::Behind(e),
        SealOffDecision::Unknown => SealOff::Unknown,
        SealOffDecision::Public(_) => unreachable!("private decision"),
    }
}

/// What `run` does with the record of a run not made public yet, where it stands at `state`:
/// keep it (`Ok(true)`), set it aside for a new run (`Ok(false)`: `--start-over`, only once the
/// record's boundary is passed; a record whose rotation may have landed is never set aside), or
/// refuse (`Err`: a passed record without `--start-over`, or
/// `--start-over` while the run can still be finished).
fn keep_record(state: SealOff, start_over: bool) -> Result<bool, SealOff> {
    match (state, start_over) {
        (SealOff::Passed(_), true) => Ok(false),
        (SealOff::Passed(_) | SealOff::Unknown, false) | (_, true) => Err(state),
        (_, false) => Ok(true),
    }
}

/// The refusal of a run whose seal-off rotation another rotation followed ([`SealOff::Passed`]).
fn seal_off_passed(label: &str, mode: Mode) -> anyhow::Error {
    UserError::new(
        codes::ROTATION_PENDING,
        format!("{label}'s key changed again after this run's key change"),
    )
    .cause(match mode {
        Mode::Everything => "another maintainer changed the key since; finishing this run would publish what members wrote after it began, which is meant to stay members-only",
        Mode::CodeOnly => "another maintainer changed the key since; finishing this run would let a later Everything publish what members wrote after it began, which is meant to stay members-only",
    })
    .fix(format!(
        "to make it public with that included, start a new run: dg repo make-public {label} {} --start-over",
        mode.flag()
    ))
    .note("the repo is still private")
    .into()
}

/// The refusal of a run whose seal-off rotation a node doesn't show yet ([`SealOff::Behind`]).
fn platform_behind(label: &str) -> anyhow::Error {
    UserError::new(
        codes::ROTATION_PENDING,
        "Platform hasn't caught up with this run's key change yet",
    )
    .fix(format!(
        "run it again in a minute: dg repo make-public {label} --resume"
    ))
    .note("the repo is still private")
    .into()
}

/// Whether the check a run made can't stand for its boundary `seal_off`: it ran below another
/// one, or before a rotation that was begun earlier (`resumed`) was found. A fresh run's own
/// rotation comes after its check, so everything its check saw was written before it.
fn checked_before_boundary(checked: Option<u32>, seal_off: Option<u32>, resumed: bool) -> bool {
    seal_off != checked && (resumed || checked.is_some())
}

/// The refusal of a run that found its boundary only after its check ([`checked_before_boundary`]).
fn run_again(label: &str) -> anyhow::Error {
    UserError::new(
        codes::ROTATION_PENDING,
        format!("this run found its own key change for {label} only after its check"),
    )
    .fix(format!(
        "run it again, to check what becomes public below it: dg repo make-public {label} --resume"
    ))
    .note("the repo is still private")
    .into()
}

/// The owner marker changed while this run was checking or confirming its boundary.
fn marker_changed(label: &str) -> anyhow::Error {
    UserError::new(
        codes::ROTATION_PENDING,
        "the owner marker's boundary changed during this run",
    )
    .fix(format!(
        "run it again to check what becomes public below that boundary: dg repo make-public {label} --resume"
    ))
    .note("the repo is still private")
    .into()
}

/// The refusal of a run stopped at `st` before the flip: its boundary is passed, or a node is
/// behind.
fn stopped(label: &str, mode: Mode, st: SealOff) -> anyhow::Error {
    match st {
        SealOff::Passed(_) => seal_off_passed(label, mode),
        SealOff::Unknown => repair_marker_keys(label),
        _ => platform_behind(label),
    }
}

/// `--start-over` refused (`message`): the repo is public already, or the run can still be
/// finished.
fn start_over_refused(label: &str, message: String) -> anyhow::Error {
    UserError::new(codes::USAGE, message)
        .fix(format!("finish it: dg repo make-public {label} --resume"))
        .note("nothing was written")
        .into()
}

/// `private`'s current key epoch and its burned epochs, read fresh, giving a node a block behind
/// a few seconds to show `seal_off`.
async fn current_epoch_after(
    s: &Session,
    private: &RepoRef,
    seal_off: Option<u32>,
) -> Result<(Option<u32>, BTreeSet<u32>)> {
    let kr = keyring_after(s, private, seal_off).await?;
    Ok((
        kr.resolution().current_epoch,
        kr.resolution().burned.clone(),
    ))
}

/// Read one coherent marker/key snapshot, allowing the same bounded node lag as rotation recovery.
async fn keyring_after(
    s: &Session,
    private: &RepoRef,
    seal_off: Option<u32>,
) -> Result<std::sync::Arc<Keyring>> {
    let mut kr = RepoService::new(&s.client, &s.identity, &s.bridge)
        .keyring(private)
        .await?;
    for _ in 1..5 {
        if kr.resolution().current_epoch >= seal_off {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        kr = RepoService::new(&s.client, &s.identity, &s.bridge)
            .keyring(private)
            .await?;
    }
    Ok(kr)
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
/// choice of refs, when this run continues it. `below` is the run's boundary once it has one
/// (its seal-off epoch, or once public [`history_cutoff`]): the refs and the code are read from
/// what was sealed below it alone, as the web reads them, so nothing written during or after
/// the conversion is published.
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
    below: Option<u32>,
) -> Result<Check> {
    let below = history_cutoff(conversion.and_then(|c| c.seal_off_epoch), below);
    let mut out = Check {
        below,
        ..Check::default()
    };
    let res = kr.resolution();
    let repo_label = safe(&a.repo).into_owned();
    // the network: the live contracts keep a repository's visibility as created
    if conversion.is_none() && !psvc.can_make_public(private).await? {
        out.blockers.push(visibility_frozen());
    }
    if conversion.is_none() && below.is_none() {
        let active =
            kr.active_seal_off(&forge_core::platform::decode_identifier(s.repo.owner_id())?);
        let marker = SealOffMarker {
            mode: match mode {
                Some(Mode::Everything) => SealOffMode::Everything,
                _ => SealOffMode::CodeOnly,
            },
            conversion_id: [0; 16],
            boundary_epoch: res.current_epoch.unwrap_or(0).saturating_add(1),
            started_at_ms: 0,
            replaces_epoch: active.replacement_epoch(None),
        };
        if let Err(e) = forge_core::keyring::preflight_seal_off(
            &forge_core::platform::decode_identifier(&s.repo.repo_id)?,
            forge_core::platform::decode_identifier(s.repo.owner_id())?,
            &forge_core::keyring::AnchorSettings::current(kr.config()),
            &marker,
        ) {
            if let forge_core::Error::User(e) = e {
                out.blockers.push(*e);
            } else {
                return Err(e.into());
            }
        }
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
    let published_below = below
        .or(conversion.and_then(|c| c.seal_off_epoch))
        .or(res.current_epoch.map(|e| e + 1))
        .unwrap_or(0);
    if (0..published_below)
        .any(|e| res.anchors.contains_key(&e) && !kr.readable_epochs().contains(&e))
    {
        out.notes.push(
            "Some history written while private can't be published: nobody holds its key any more. It stays unreadable to everyone.".into(),
        );
    }
    // the private era's refs and settings
    for (name, state) in &psvc.read_refs_below(private, below).await? {
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
    let (work, unfetched) = work_repo(psvc, private, &out.all_refs, below).await?;
    out.unfetched = unfetched;
    // Code only: the refs the owner chose, the refs picked, or the default branch and its tags
    out.code_refs = if let Some(chosen) = chosen {
        // a recorded choice holds only what the refs were before the boundary
        let (kept, dropped) = within_boundary(chosen, &out.all_refs, |a, b| {
            git::is_ancestor(&work, &peeled(&work, a), &peeled(&work, b))
        });
        out.dropped = dropped;
        kept
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
            .make_public_census(private, conversion.and_then(|c| c.marker_height), below)
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

/// The refs of `chosen` (an earlier choice, with the tips it recorded) that `all_refs` (the refs
/// as they were before the run's boundary) still holds at that tip or a later one
/// (`is_ancestor(recorded, tip)`), and the names of the rest: a recorded tip written at or after
/// the boundary is never published.
fn within_boundary(
    chosen: &[(String, String)],
    all_refs: &[(String, String)],
    is_ancestor: impl Fn(&str, &str) -> bool,
) -> (Vec<(String, String)>, Vec<String>) {
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    for (name, tip) in chosen {
        let ok = all_refs
            .iter()
            .any(|(n, t)| n == name && (t == tip || is_ancestor(tip, t)));
        if ok {
            kept.push((name.clone(), tip.clone()));
        } else {
            dropped.push(name.clone());
        }
    }
    (kept, dropped)
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
/// a bare repository holding every private-era pack this member opens (sealed below `below`,
/// when given) (so Everything's scan sees
/// every old object, deleted branches included) and the live refs. A run that could not fetch
/// some reads them all again.
async fn work_repo(
    psvc: &RepoService<'_>,
    private: &RepoRef,
    refs: &[(String, String)],
    below: Option<u32>,
) -> Result<(PathBuf, usize)> {
    let state = state_dir(private)?;
    private_dir(&state)?;
    work_repo_at(psvc, private, refs, below, &state.join("work.git")).await
}

/// Load private-era packs into an explicitly chosen repository. A keep clone never shares
/// objects with the below-boundary repository used for public publication.
pub(crate) async fn work_repo_at(
    psvc: &RepoService<'_>,
    private: &RepoRef,
    refs: &[(String, String)],
    below: Option<u32>,
    dir: &Path,
) -> Result<(PathBuf, usize)> {
    if !dir.join("HEAD").exists() && !dir.join(".git/HEAD").exists() {
        std::fs::create_dir_all(dir)?;
        git::git(dir, &["init", "-q", "--bare"], &[])?;
    }
    let marker = dir.join("make-public-packs");
    // "<opened> <unfetched>" of the last read; a read that missed some is done again
    let unfetched_before = std::fs::read_to_string(&marker)
        .ok()
        .and_then(|t| t.split_whitespace().nth(1)?.parse::<usize>().ok());
    let missing = refs.iter().any(|(_, t)| !git::has_object(dir, t));
    let unfetched = if missing || unfetched_before.is_none_or(|n| n > 0) {
        let read = psvc
            .open_git_packs(private, below, |bytes| {
                index_pack(dir, bytes).map_err(|e| forge_core::Error::Io(format!("{e:#}")))
            })
            .await?;
        std::fs::write(&marker, format!("{} {}\n", read.opened, read.unfetched))?;
        read.unfetched
    } else {
        0
    };
    for (name, tip) in refs {
        if git::has_object(dir, tip) {
            git::git(dir, &["update-ref", name, tip], &[])?;
        }
    }
    Ok((dir.to_path_buf(), unfetched))
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
pub(crate) fn pack_size(dir: &Path, tips: &[String]) -> Result<(u64, u64)> {
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
pub(crate) fn short_ref(name: &str) -> &str {
    name.strip_prefix("refs/heads/")
        .or_else(|| name.strip_prefix("refs/tags/"))
        .unwrap_or(name)
}

/// The publication scope shown before Everything's census.
fn everything_scope(below: Option<u32>) -> String {
    let until = if below.is_some() {
        "before the existing publication boundary"
    } else {
        "until now"
    };
    format!("Everything members could ever read {until}: every issue, pull request, comment and review, every earlier edit, deleted and hidden comments, every branch ever pushed, old settings, imported authors and links, and requests sent to bots. Releases made while the repo was private stay hidden.")
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
                println!("    {}", everything_scope(check.below));
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
                "Stays private: {}, {}, and {}.",
                plural_with(c.letters, "message to specific people", "messages to specific people"),
                plural(check.environments, "environment"),
                if check.below.is_some() { "everything members wrote from the existing publication boundary on" } else { "everything members write from now on" }
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
    /// Inferred solely to keep branches; never authorizes publishing any code.
    inferred_mode: bool,
    history_started: bool,
    /// `--start-over` in place of a recorded run whose boundary was passed: what it replaces.
    start_over: Option<StartOver>,
    /// The boundary the check ran below (none: everything up to now).
    checked_below: Option<u32>,
    boundary: Option<u32>,
    a: &'r MakePublicArgs,
    dir: &'r Path,
}

/// The recorded run a `--start-over` replaces: its seal-off epoch, that epoch's anchor's block
/// height, and how many ref updates were sealed under it or later (what a new run's boundary
/// adds).
#[derive(Debug, Clone, Copy)]
struct StartOver {
    epoch: u32,
    replaces_epoch: u32,
    height: Option<u64>,
    ref_updates: usize,
}

impl StartOver {
    fn json(self) -> Value {
        json!({ "replacedSealOffEpoch": self.epoch, "replacesEpoch": self.replaces_epoch, "blockHeight": self.height, "refUpdatesSince": self.ref_updates })
    }

    /// What starting over adds, said before the confirmation (with `--yes` too).
    fn line(self, mode: Mode) -> String {
        let at = self
            .height
            .map_or_else(String::new, |h| format!(", block {h}"));
        let adds = match mode {
            Mode::Everything => "With Everything, what members wrote since then becomes public too",
            Mode::CodeOnly => "With Code only it stays members-only for now, but a later Everything would make it public",
        };
        format!(
            "This starts over: the earlier run's key change (key epoch {}{at}) no longer marks where publishing stops. {adds}: about {} since then (posts aren't counted).",
            self.epoch,
            plural_with(self.ref_updates, "branch or tag update", "branch and tag updates"),
        )
    }
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
        inferred_mode,
        history_started,
        start_over,
        checked_below,
        boundary,
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
    let local_choice = saved.as_ref().filter(|sv| sv.mode == mode);
    let saved_here = local_choice.is_some();
    let recorded_refs = local_choice.map_or(0, |sv| sv.refs.len());
    let (public_refs, members_only) = if flipped {
        public_state(svc, &public).await?
    } else {
        (BTreeMap::new(), BTreeSet::new())
    };
    let keep_only = inferred_mode
        || keep_only_resume(
            flipped,
            a.resume,
            mode,
            recorded_refs,
            a.code_only,
            &a.refs,
            &public_refs,
        );
    let mut wanted = publication_refs(&check, mode, keep_only);
    if flipped
        && !is_owner
        && mode == Mode::CodeOnly
        && !saved_here
        && a.refs.is_empty()
        && !keep_only
    {
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
    let todo = unpublished_refs(&wanted, &public_refs, &members_only);
    let left_out: Vec<String> = wanted
        .iter()
        .filter(|(n, _)| members_only.contains(n) && !public_refs.contains_key(n))
        .map(|(n, _)| n.clone())
        .collect();
    if !ctx.json {
        for n in &check.dropped {
            println!(
                "Not published: {}: it changed after this run's key change.",
                safe(short_ref(n))
            );
        }
    }
    let dropped = check.dropped.clone();

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
        match start_over {
            Some(so) => {
                // said with --yes too: what a new boundary adds is never skipped (on stderr under
                // --json, which reports it as `startOver`)
                if ctx.json {
                    eprintln!("{}", so.line(mode));
                } else {
                    println!("{}", so.line(mode));
                }
                typed_words(ctx, &format!("start over making {} public", a.repo))
                    .map_err(discard)?;
            }
            None => typed_confirmation(ctx, &a.repo).map_err(discard)?,
        }
    } else if !keep_only {
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
        seal_off: boundary,
        seal_off_from: None,
        conversion_id: None,
        started_at_ms: None,
        replaces_epoch: start_over.map(|so| so.replaces_epoch),
    });
    if let ActiveSealOff::Active {
        marker: Some(marker),
        ..
    } = kr.active_seal_off(&forge_core::platform::decode_identifier(s.repo.owner_id())?)
    {
        if saved.seal_off == Some(marker.boundary_epoch) {
            saved.conversion_id = Some(hex::encode(marker.conversion_id));
            saved.started_at_ms = Some(marker.started_at_ms);
        }
    }
    saved.mode = mode;
    saved.refs.clone_from(&wanted);
    saved.save(dir)?;
    // 2. seal off, 3. flip
    if flipped {
        steps.push(json!({ "step": "sealOff", "status": "done" }));
        steps.push(json!({ "step": "flip", "status": "done" }));
    } else {
        // The recorded seal-off rotation is this run's boundary for good: kept while it is the
        // current key, and never replaced by a second one (the key is read again: the check
        // and the confirmation can take minutes). One that landed unrecorded is found again.
        // a rotation that landed unrecorded shows as `from + 1`: a node behind is waited for
        let mut resumed = saved.seal_off.is_none() && saved.seal_off_from.is_some();
        let (current, burned) = current_epoch_after(
            s,
            private,
            wait_target(saved.seal_off, saved.seal_off_from)
                .or(start_over.map(|so| so.replaces_epoch)),
        )
        .await?;
        if start_over.is_some_and(|so| current < Some(so.replaces_epoch)) {
            return Err(platform_behind(&label));
        }
        saved.seal_off = recorded_seal_off(saved.seal_off, saved.seal_off_from, current, &burned);
        let fresh = RepoService::new(&s.client, &s.identity, &s.bridge);
        let fresh_kr = fresh.keyring(private).await?;
        let marker_now =
            fresh_kr.active_seal_off(&forge_core::platform::decode_identifier(s.repo.owner_id())?);
        if marker_now == ActiveSealOff::Unknown {
            return Err(repair_marker_keys(&label));
        }
        resumed |= start_over.is_none() && saved.seal_off.is_none() && marker_now.epoch().is_some();
        if start_over.is_some_and(|so| {
            marker_now
                .replacement_epoch(None)
                .is_some_and(|e| e > so.replaces_epoch)
        }) {
            return Err(marker_changed(&label));
        }
        // An intentional start-over replaces the earlier marker only with its new marked rotation.
        if start_over.is_none() {
            saved.seal_off = marker_now.boundary(saved.seal_off);
        }
        match step2(saved.seal_off, current) {
            Step2::Keep(e) => {
                if marker_now.epoch() != Some(e) {
                    let marker = marker_for_record(
                        &mut saved,
                        mode,
                        e,
                        start_over.map(|so| so.replaces_epoch),
                    )?;
                    saved.save(dir)?;
                    forge_core::keyring::ensure_seal_off_marker(
                        &crate::keys::signer(s),
                        private,
                        &marker,
                    )
                    .await?;
                }
                saved.save(dir)?;
                if !ctx.json {
                    println!("Everything members write from now on stays members-only unless the owner starts the conversion over.");
                }
                steps.push(json!({ "step": "sealOff", "status": "done", "epoch": e }));
            }
            Step2::Rotate => {
                // kept before signing: an answer lost after the rotation lands is found again
                saved.seal_off_from = current;
                saved.save(dir)?;
                let marker =
                    marker_for_record(&mut saved, mode, 1, start_over.map(|so| so.replaces_epoch))?;
                saved.save(dir)?;
                let rotation =
                    forge_core::keyring::rotate_seal_off(&crate::keys::signer(s), private, marker)
                        .await?;
                forge_core::keyring::test_fault("make-public-before-seal-off-record")?;
                saved.seal_off = Some(rotation.epoch);
                saved.save(dir)?;
                if !ctx.json {
                    println!("Everything members write from now on stays members-only unless the owner starts the conversion over.");
                }
                steps.push(
                    json!({ "step": "sealOff", "status": "written", "epoch": rotation.epoch }),
                );
            }
            Step2::Stop(st) => return Err(stopped(&label, mode, st)),
        }
        // The check ran before the run knew its boundary (a rotation that landed unrecorded,
        // found only now): what it chose may hold refs written at or after it. The next run
        // checks below it.
        if checked_before_boundary(checked_below, saved.seal_off, resumed) {
            saved.save(dir)?;
            return Err(if checked_below.is_some() {
                marker_changed(&label)
            } else {
                run_again(&label)
            });
        }
        forge_core::keyring::test_fault("make-public-after-seal-off")?;
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
        let active =
            fresh_kr.active_seal_off(&forge_core::platform::decode_identifier(s.repo.owner_id())?);
        if active == ActiveSealOff::Unknown {
            return Err(repair_marker_keys(&label));
        }
        let bound = active.boundary(saved.seal_off);
        if bound != saved.seal_off {
            return Err(marker_changed(&label));
        }
        if let Err(st) = may_flip(bound, fresh_kr.resolution().current_epoch) {
            return Err(stopped(&label, mode, st));
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
                saved.seal_off,
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
        // The second check can take minutes: a rotation by another maintainer meanwhile would make
        // the flip state a later boundary than this run's, so the key is read again, last.
        let last_kr = keyring_after(s, private, saved.seal_off).await?;
        let last_marker =
            last_kr.active_seal_off(&forge_core::platform::decode_identifier(s.repo.owner_id())?);
        if last_marker == ActiveSealOff::Unknown {
            return Err(repair_marker_keys(&label));
        }
        if last_marker.boundary(saved.seal_off) != saved.seal_off {
            return Err(marker_changed(&label));
        }
        let now = last_kr.resolution().current_epoch;
        if let Err(st) = may_flip(saved.seal_off, now) {
            return Err(stopped(&label, mode, st));
        }
        forge_core::keyring::test_fault("make-public-before-flip")?;
        svc.make_repo_public(&s.repo, default_branch).await?;
        if !ctx.json {
            println!("{label} is public now. It can never be private again.");
        }
        steps.push(json!({ "step": "flip", "status": "written" }));
    }
    // 4. the first public settings
    let fresh = RepoService::new(&s.client, &s.identity, &s.bridge);
    let stated = fresh.anchored_conversion(&public).await?;
    let marker = stated.and_then(|c| c.marker_height);
    let stated = stated.and_then(|c| c.seal_off_epoch);
    // The boundary the repo states is not this run's own (a key change landed right before the
    // flip, or this computer's record is not the run's): the history this computer publishes
    // still stops at the lower one, and the record is kept so a later run here does too.
    let keep_boundary = saved.seal_off.is_some() && stated != saved.seal_off;
    if keep_boundary {
        eprintln!(
            "note: {label}'s settings state another boundary (key epoch {}) than this run's own key change (key epoch {}). The history published from this computer stops at the lower one; finish the run here, and check the result with dg repo make-public {label} --check",
            stated.map_or_else(|| "none".into(), |e| e.to_string()),
            saved.seal_off.map_or_else(|| "none".into(), |e| e.to_string()),
        );
    }
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
        let (work, _) = work_repo(
            psvc,
            private,
            &wanted,
            history_cutoff(stated, saved.seal_off),
        )
        .await?;
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
    // 5b. Keep withheld branches using this run's already-clamped boundary. The preflight
    // service cached keys before the rotation; a new private view must open the withheld epoch.
    let keep_service = RepoService::new(&s.client, &s.identity, &s.bridge);
    let kept = crate::make_public_keep::keep_for_members(
        ctx,
        s,
        &keep_service,
        private,
        &public,
        history_cutoff(stated, saved.seal_off),
        dir,
        keep_only,
    )
    .await;
    let kept_report = crate::make_public_keep::report(ctx, &label, kept);
    let kept_for_members = &kept_report.plan;
    // 6. notifications: Forge apps read them from the flip and the published keys
    steps.push(json!({ "step": "notify", "status": "done" }));
    // 7. the history
    let mut finished = kept_for_members.is_some();
    if mode == Mode::Everything {
        let c = fresh
            .anchored_conversion(&public)
            .await?
            .unwrap_or(Conversion {
                seal_off_epoch: saved.seal_off,
                marker_height: None,
            });
        let history_kr = RepoService::new(&s.client, &s.identity, &s.bridge)
            .keyring(private)
            .await?;
        let active = history_kr
            .active_seal_off(&forge_core::platform::decode_identifier(s.repo.owner_id())?);
        if active == ActiveSealOff::Unknown {
            return Err(repair_marker_keys(&label));
        }
        let seal_off =
            history_cutoff_for_run(c.seal_off_epoch, &active, saved.seal_off).unwrap_or(0);
        let held = history_kr.epoch_keys_below(seal_off);
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
        cleanup_finished_run(dir, keep_boundary);
    }
    ctx.emit(
        json!({
            "status": if finished { "public" } else { "in_progress" },
            "repo": s.repo.display(),
            "mode": (!inferred_mode).then_some(mode),
            "keepOnly": keep_only,
            "steps": steps,
            "keptForMembers": kept_for_members,
            "keptForMembersError": kept_report.error,
            "notKeptForMembers": kept_report.not_kept,
            "notPublished": left_out.iter().chain(&dropped).collect::<Vec<_>>(),
            "startOver": start_over.map(StartOver::json),
            "boundaryKept": keep_boundary,
            "cost": cost_json(spent, price),
        }),
        || {
            if finished {
                if keep_only {
                    println!("This run published nothing; it only kept branches for members. To publish more, use --resume --code-only --ref <each> or --everything.");
                } else {
                    println!(
                        "{label} is public ({}). Members and the people whose words became public see it in their notifications.",
                        mode.label()
                    );
                }
            }
            println!("  cost: {}", cost_line(spent, price));
        },
    );
    Ok(())
}

/// Post-completion cleanup is best-effort. In particular, never delete a directory whose
/// keeper is still active just because acquiring the sweep lock failed.
fn cleanup_finished_run(dir: &Path, keep_boundary: bool) {
    if let Err(e) = crate::make_public_keep::sweep_keep_dirs(dir) {
        eprintln!(
            "warning: could not clean up the completed conversion: {}",
            safe(&format!("{e:#}"))
        );
    } else if keep_boundary {
        // Keep the boundary record alone; work.git holds private-era plaintext.
        let _ = std::fs::remove_dir_all(dir.join("work.git"));
    } else {
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn publication_refs(check: &Check, mode: Mode, keep_only: bool) -> Vec<(String, String)> {
    if keep_only {
        Vec::new()
    } else {
        match mode {
            Mode::CodeOnly => check.code_refs.clone(),
            Mode::Everything => check.all_refs.clone(),
        }
    }
}

/// A bare resume can infer a placeholder only when there is public code already. It never
/// recovers the owner's publication choice from a different computer.
fn resume_mode(
    chosen: Option<Mode>,
    flipped: bool,
    resume: bool,
    public: &BTreeMap<String, String>,
) -> (Option<Mode>, bool) {
    let inferred = chosen.is_none() && flipped && resume && !public.is_empty();
    (chosen.or(inferred.then_some(Mode::CodeOnly)), inferred)
}

fn mode_to_finish(mode: Option<Mode>, label: &str) -> Result<Mode> {
    mode.ok_or_else(|| {
        UserError::new(
            codes::USAGE,
            format!("{} was made public; say which mode to finish", safe(label)),
        )
        .fix(format!(
            "dg repo make-public {} --resume --code-only (or --everything)",
            safe(label)
        ))
        .note("this computer has no record of the run that started it")
        .into()
    })
}

/// A finished Code-only conversion needs no repeated publication choice just to keep branches.
fn keep_only_resume(
    flipped: bool,
    resume: bool,
    mode: Mode,
    recorded_refs: usize,
    explicit_code_only: bool,
    refs: &[String],
    public: &BTreeMap<String, String>,
) -> bool {
    flipped
        && resume
        && mode == Mode::CodeOnly
        && (recorded_refs == 0 || explicit_code_only)
        && refs.is_empty()
        && !public.is_empty()
}

/// The history step keeps the boundary checked by this run, including after an owner replacement.
fn history_cutoff_for_run(
    stated: Option<u32>,
    active: &ActiveSealOff,
    checked: Option<u32>,
) -> Option<u32> {
    history_cutoff(history_cutoff(stated, active.boundary(checked)), checked)
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
    let args = public_push_args(repo, todo, allowed);
    let push: Vec<&str> = args.iter().map(String::as_str).collect();
    git::git_dash(work, &push, &git::dash_env_signing(ctx)?)
        .context("pushing the published branches and tags")?;
    Ok(())
}

/// Arguments for the below-boundary publication; each tip has its own explicit override.
fn public_push_args(
    repo: &RepoRef,
    todo: &[&(String, String)],
    allowed: &BTreeSet<String>,
) -> Vec<String> {
    // Step 1's typed confirmation already covered the cost, and the flip cannot be undone: the
    // helper's cost guard must not stop this push with E801 (or wait on a terminal) now.
    let mut args: Vec<String> = vec![
        "-c".into(),
        "dash.confirm=never".into(),
        "push".into(),
        "-o".into(),
        "public".into(),
    ];
    for (_, tip) in todo {
        args.push("-o".into());
        args.push(format!("publish-private={tip}"));
    }
    for f in allowed {
        args.push("-o".into());
        args.push(format!("{}={f}", forge_secrets::ALLOW_PUSH_OPTION));
    }
    args.push(repo.remote_url());
    for (n, t) in todo {
        args.push(format!("{t}:{n}"));
    }
    args
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
    typed_words(ctx, &format!("make {repo} public"))
}

/// The owner types `words` (or passes `--yes`).
fn typed_words(ctx: &Ctx, words: &str) -> Result<()> {
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

fn marker_for_record(
    saved: &mut Saved,
    mode: Mode,
    epoch: u32,
    replaces_epoch: Option<u32>,
) -> Result<SealOffMarker> {
    saved.replaces_epoch = saved.replaces_epoch.or(replaces_epoch);
    let started_at = saved.started_at_ms.unwrap_or_else(|| {
        u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        )
        .unwrap_or(u64::MAX)
    });
    let mut marker = SealOffMarker::new(
        match mode {
            Mode::CodeOnly => SealOffMode::CodeOnly,
            Mode::Everything => SealOffMode::Everything,
        },
        started_at,
        saved.replaces_epoch,
    )?;
    marker.boundary_epoch = epoch;
    if let Some(id) = saved.conversion_id.as_ref() {
        marker.conversion_id = hex::decode(id)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid conversion id in local record"))?;
    }
    saved.conversion_id = Some(hex::encode(marker.conversion_id));
    saved.started_at_ms = Some(marker.started_at_ms);
    Ok(marker)
}

/// Only the locally confirmed replacement whose rotation is now current can finish its marker.
fn pending_replacement(
    saved: &Saved,
    active: &ActiveSealOff,
    current: Option<u32>,
    burned: &std::collections::BTreeSet<u32>,
) -> Option<u32> {
    let replaced = saved.replaces_epoch?;
    saved.conversion_id.as_ref()?;
    let landed = recorded_seal_off(saved.seal_off, saved.seal_off_from, current, burned)?;
    (active
        .replacement_epoch(None)
        .is_some_and(|e| e <= replaced)
        && landed > replaced
        && current == Some(landed))
    .then_some(landed)
}

fn repair_marker_keys(label: &str) -> anyhow::Error {
    UserError::new(
        codes::ROTATION_PENDING,
        "an owner config cannot be opened; repair keys before making this repo public",
    )
    .fix(format!("dg repo keys repair {label}"))
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adopted_boundary_confirmation_describes_the_scope_it_will_publish() {
        let below = history_cutoff(Some(4), Some(1));
        let scope = everything_scope(below);
        assert!(scope.contains("before the existing publication boundary"));
        assert!(!scope.contains("until now"));
        assert!(everything_scope(None).contains("until now"));
    }

    #[test]
    fn an_owner_without_a_record_cannot_infer_publication_choices() {
        // The owner selected topic or Everything elsewhere; the flip landed before step 5.
        let (mode, inferred) = resume_mode(None, true, true, &BTreeMap::new());
        assert!(!inferred);
        let error = mode_to_finish(mode, "owner/repo").unwrap_err();
        assert!(error
            .to_string()
            .contains("was made public; say which mode to finish"));
        assert_eq!(
            resume_mode(None, false, true, &BTreeMap::new()),
            (None, false)
        );
    }

    #[test]
    fn an_inferred_keep_only_resume_publishes_nothing() {
        let public = BTreeMap::from([("refs/heads/topic".into(), "a".into())]);
        let (mode, inferred) = resume_mode(None, true, true, &public);
        assert!(inferred);
        let mode = mode_to_finish(mode, "owner/repo").unwrap();
        let check = Check {
            code_refs: vec![("refs/heads/main".into(), "b".into())],
            all_refs: vec![("refs/heads/topic".into(), "a".into())],
            ..Check::default()
        };
        assert!(publication_refs(&check, mode, inferred).is_empty());
        // An explicit mode keeps its normal publication choice.
        assert_eq!(
            resume_mode(Some(Mode::Everything), true, true, &public),
            (Some(Mode::Everything), false)
        );
        assert_eq!(
            publication_refs(&check, Mode::Everything, false),
            check.all_refs
        );
        let args = public_push_args(
            &RepoRef {
                repo_id: "r".into(),
                owner_id: "o".into(),
                name: "n".into(),
                visibility: Visibility::Public,
                forge: forge_core::network::ForgeIds::test_forge_meta(),
            },
            &[],
            &BTreeSet::new(),
        );
        assert!(!args.iter().any(|a| a.contains("refs/heads/")));
    }

    #[test]
    fn a_maintainer_can_resume_a_finished_code_only_conversion_to_keep_branches() {
        let public = BTreeMap::from([("refs/heads/main".into(), "a".into())]);
        assert!(keep_only_resume(
            true,
            true,
            Mode::CodeOnly,
            0,
            false,
            &[],
            &public
        ));
        assert!(!keep_only_resume(
            true,
            false,
            Mode::CodeOnly,
            0,
            false,
            &[],
            &public
        ));
        assert!(!keep_only_resume(
            true,
            true,
            Mode::CodeOnly,
            0,
            false,
            &[],
            &BTreeMap::new()
        ));
        assert!(!keep_only_resume(
            true,
            true,
            Mode::CodeOnly,
            0,
            false,
            &["topic".into()],
            &public
        ));
    }

    #[test]
    fn an_explicit_owner_keep_only_resume_does_not_resume_recorded_publication() {
        let public = BTreeMap::from([("refs/heads/topic".into(), "a".into())]);
        assert!(keep_only_resume(
            true,
            true,
            Mode::CodeOnly,
            1,
            true,
            &[],
            &public
        ));
        assert!(!keep_only_resume(
            true,
            true,
            Mode::CodeOnly,
            1,
            false,
            &[],
            &public
        ));
        assert!(!keep_only_resume(
            true,
            true,
            Mode::CodeOnly,
            1,
            true,
            &["topic".into()],
            &public
        ));
        // A retry of a failed keep-only run has a local record but no selected public refs.
        assert!(keep_only_resume(
            true,
            true,
            Mode::CodeOnly,
            0,
            false,
            &[],
            &public
        ));
    }

    #[test]
    fn completed_conversion_cleanup_is_nonfatal_and_preserves_busy_state() {
        let parent = tempfile::tempdir().unwrap();
        let invalid = parent.path().join("not-a-directory");
        std::fs::write(&invalid, "state").unwrap();
        cleanup_finished_run(&invalid, false);
        assert!(invalid.is_file());
        let dir = parent.path().join("conversion");
        private_dir(&dir).unwrap();
        std::fs::write(dir.join("state.json"), "{}").unwrap();
        std::fs::create_dir(dir.join("work.git")).unwrap();
        std::fs::create_dir(dir.join("keep-interrupted")).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join(".keep.lock"))
            .unwrap();
        lock.lock().unwrap();
        cleanup_finished_run(&dir, false);
        assert!(dir.join("keep-interrupted").exists());
        drop(lock);
        cleanup_finished_run(&dir, true);
        assert!(dir.join("state.json").exists());
        assert!(!dir.join("work.git").exists());
        assert!(!dir.join("keep-interrupted").exists());
        cleanup_finished_run(&dir, false);
        assert!(!dir.exists());
    }

    #[test]
    fn a_code_only_ref_choice_then_everything_authorizes_each_below_boundary_tip() {
        let repo = RepoRef {
            repo_id: "r".into(),
            owner_id: "o".into(),
            name: "n".into(),
            visibility: Visibility::Public,
            forge: forge_core::network::ForgeIds::test_forge_meta(),
        };
        let main = ("refs/heads/main".into(), "a".repeat(40));
        let topic = ("refs/heads/topic".into(), "b".repeat(40));
        let first = public_push_args(&repo, &[&topic], &BTreeSet::new());
        assert!(first.contains(&format!("publish-private={}", topic.1)));
        let upgrade = public_push_args(&repo, &[&main, &topic], &BTreeSet::new());
        for r in [&main, &topic] {
            assert!(upgrade.contains(&format!("publish-private={}", r.1)));
            assert!(upgrade.contains(&format!("{}:{}", r.1, r.0)));
        }
    }

    #[test]
    fn interrupted_start_over_keeps_its_replacement_marker_identity() {
        let mut saved: Saved = serde_json::from_value(json!({
            "repoId": "R", "mode": "codeOnly", "refs": [], "sealOff": null,
            "sealOffFrom": 2, "conversionId": "ab".repeat(16),
            "startedAtMs": 123, "replacesEpoch": 1
        }))
        .unwrap();
        let marker = marker_for_record(&mut saved, Mode::CodeOnly, 3, None).unwrap();
        assert_eq!(marker.replaces_epoch, Some(1));
        assert_eq!(marker.conversion_id, [0xab; 16]);
        assert_eq!(marker.started_at_ms, 123);
        let active = ActiveSealOff::Active {
            epoch: 1,
            height: 10,
            highest_epoch: 1,
            replaces_through: None,
            marker: None,
        };
        assert_eq!(
            pending_replacement(&saved, &active, Some(3), &BTreeSet::new()),
            Some(3)
        );
        assert_eq!(
            pending_replacement(&saved, &active, Some(4), &BTreeSet::new()),
            None
        );
        assert_eq!(
            pending_replacement(&saved, &ActiveSealOff::Unknown, Some(3), &BTreeSet::new()),
            None
        );
        assert_eq!(serde_json::to_value(saved).unwrap()["replacesEpoch"], 1);
    }

    #[test]
    fn an_unknown_marker_refuses_with_the_repair_error() {
        let state = seal_off_state(Some(3), &ActiveSealOff::Unknown, Some(3));
        for start_over in [false, true] {
            assert!(keep_record(state, start_over).is_err());
        }
        assert!(stopped("owner/repo", Mode::Everything, state)
            .to_string()
            .contains("repair keys"));
    }

    #[test]
    fn marker_changes_and_late_discovery_have_distinct_messages() {
        let changed = marker_changed("owner/repo").to_string();
        assert!(changed.contains("owner marker's boundary changed"));
        assert!(run_again("owner/repo")
            .to_string()
            .contains("only after its check"));
        assert_ne!(changed, run_again("owner/repo").to_string());
    }

    #[test]
    fn marker_decisions_use_the_shared_vectors() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../forge-contracts/vectors");
        let mut count = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if !path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("seal_off_marker__")
            {
                continue;
            }
            let v: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            let inp = &v["input"];
            if inp["op"] != "decision"
                || inp["flipped"] == true
                || inp["active"]["kind"] == "unknown"
            {
                continue;
            }
            let epoch = |v: &Value| v.as_u64().map(|n| u32::try_from(n).unwrap());
            let active = epoch(&inp["active"]["epoch"]).map_or(ActiveSealOff::None, |e| {
                ActiveSealOff::Active {
                    epoch: e,
                    height: 0,
                    marker: None,
                    highest_epoch: epoch(&inp["active"]["highestEpoch"]).unwrap(),
                    replaces_through: epoch(&inp["active"]["replacesThrough"]),
                }
            });
            let boundary = active.boundary(epoch(&inp["recorded"]));
            let now = epoch(&inp["current"]);
            let expected_epoch = epoch(&v["expected"]["epoch"]);
            let state = seal_off_state(epoch(&inp["recorded"]), &active, now);
            match v["expected"]["kind"].as_str().unwrap() {
                "new" => {
                    assert_eq!(state, SealOff::Rotate);
                    assert_eq!(step2(boundary, now), Step2::Rotate);
                }
                "adopt" => {
                    assert_eq!(state, SealOff::Keep(expected_epoch.unwrap()));
                    assert!(may_flip(boundary, now).is_ok());
                }
                "lagging" => {
                    assert_eq!(state, SealOff::Behind(expected_epoch.unwrap()));
                    assert!(may_flip(boundary, now).is_err());
                }
                "passed" => {
                    assert_eq!(state, SealOff::Passed(expected_epoch.unwrap()));
                    assert!(keep_record(state, false).is_err());
                    assert_eq!(keep_record(state, true), Ok(false));
                }
                _ => panic!("decision"),
            }
            count += 1;
        }
        assert_eq!(count, 11);
    }

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
            seal_off_from: None,
            conversion_id: None,
            started_at_ms: None,
            replaces_epoch: None,
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

    #[test]
    fn a_recorded_seal_off_is_kept_waited_for_or_passed_never_replaced() {
        assert_eq!(
            seal_off_state(None, &ActiveSealOff::None, Some(4)),
            SealOff::Rotate
        );
        assert_eq!(
            seal_off_state(None, &ActiveSealOff::None, None),
            SealOff::Rotate
        );
        assert_eq!(
            seal_off_state(Some(4), &ActiveSealOff::None, Some(4)),
            SealOff::Keep(4)
        );
        assert_eq!(
            seal_off_state(Some(4), &ActiveSealOff::None, Some(3)),
            SealOff::Behind(4)
        );
        assert_eq!(
            seal_off_state(Some(4), &ActiveSealOff::None, None),
            SealOff::Behind(4)
        );
        assert_eq!(
            seal_off_state(Some(4), &ActiveSealOff::None, Some(5)),
            SealOff::Passed(4)
        );
        assert_eq!(
            seal_off_state(Some(4), &ActiveSealOff::None, Some(9)),
            SealOff::Passed(4)
        );
        // the record: kept, set aside only by --start-over once passed, else refused
        assert_eq!(keep_record(SealOff::Keep(4), false), Ok(true));
        assert_eq!(keep_record(SealOff::Behind(4), false), Ok(true));
        assert_eq!(keep_record(SealOff::Rotate, false), Ok(true));
        assert_eq!(
            keep_record(SealOff::Passed(4), false),
            Err(SealOff::Passed(4))
        );
        assert_eq!(keep_record(SealOff::Passed(4), true), Ok(false));
        assert_eq!(keep_record(SealOff::Rotate, true), Err(SealOff::Rotate));
        assert_eq!(keep_record(SealOff::Keep(4), true), Err(SealOff::Keep(4)));
        assert_eq!(
            keep_record(SealOff::Behind(4), true),
            Err(SealOff::Behind(4))
        );
    }

    /// A record written before `seal_off_from` existed reads as none.
    #[test]
    fn an_older_record_reads_without_the_rotation_start() {
        let old = r#"{"repoId":"R","mode":"everything","refs":[],"sealOff":2}"#;
        let saved: Saved = serde_json::from_str(old).unwrap();
        assert_eq!((saved.seal_off, saved.seal_off_from), (Some(2), None));
    }

    #[test]
    fn a_rotation_that_landed_unrecorded_is_found_again_never_later() {
        let none = BTreeSet::new();
        // recorded: kept whatever the key reads
        assert_eq!(recorded_seal_off(Some(3), Some(1), Some(9), &none), Some(3));
        // not anchored yet: the rotation is resumed
        assert_eq!(recorded_seal_off(None, Some(2), Some(2), &none), None);
        assert_eq!(recorded_seal_off(None, None, Some(2), &none), None);
        // it landed: the first epoch after the start, even after more rotations
        assert_eq!(recorded_seal_off(None, Some(2), Some(3), &none), Some(3));
        assert_eq!(recorded_seal_off(None, Some(2), Some(5), &none), Some(3));
        // a burned epoch carries nothing: the first one that isn't
        let burned = BTreeSet::from([3]);
        assert_eq!(recorded_seal_off(None, Some(2), Some(4), &burned), Some(4));
        assert_eq!(recorded_seal_off(None, Some(2), Some(3), &burned), None);
        // step 2 and the flip
        assert_eq!(step2(Some(3), Some(3)), Step2::Keep(3));
        assert_eq!(step2(None, Some(3)), Step2::Rotate);
        assert_eq!(step2(Some(3), Some(4)), Step2::Stop(SealOff::Passed(3)));
        assert_eq!(step2(Some(3), Some(2)), Step2::Stop(SealOff::Behind(3)));
        assert_eq!(may_flip(Some(3), Some(3)), Ok(()));
        assert_eq!(may_flip(Some(3), Some(4)), Err(SealOff::Passed(3)));
        assert_eq!(may_flip(None, Some(4)), Err(SealOff::Rotate));
        // a check made before a resumed rotation was found, or below another boundary, can't
        // stand; a fresh run's own rotation comes after its check
        assert!(checked_before_boundary(None, Some(3), true));
        assert!(checked_before_boundary(Some(2), Some(3), false));
        assert!(!checked_before_boundary(Some(3), Some(3), true));
        assert!(!checked_before_boundary(None, Some(3), false));
    }

    #[test]
    fn a_recorded_choice_holds_only_what_the_refs_were_before_the_boundary() {
        let r = |n: &str, t: &str| (n.to_string(), t.to_string());
        let all = [r("refs/heads/main", "b"), r("refs/tags/v1", "t")];
        // b's history is a, b; c came after the boundary
        let ancestor = |x: &str, y: &str| (x, y) == ("a", "b");
        let chosen = [
            r("refs/heads/main", "a"),
            r("refs/tags/v1", "t"),
            r("refs/heads/late", "z"),
        ];
        let (kept, dropped) = within_boundary(&chosen, &all, ancestor);
        assert_eq!(kept, [r("refs/heads/main", "a"), r("refs/tags/v1", "t")]);
        assert_eq!(dropped, ["refs/heads/late"]);
        let (kept, dropped) = within_boundary(&[r("refs/heads/main", "c")], &all, ancestor);
        assert!(kept.is_empty());
        assert_eq!(dropped, ["refs/heads/main"]);
    }

    /// The seal-off boundary across a concurrent key rotation and resumes, over a chain held in
    /// memory: the configs each rotation states (what readers and every client derive the
    /// boundary from, [`Conversion::of`]) and the current epoch. A run decides through the same
    /// functions as [`run`] and [`convert`]: [`recorded_seal_off`] and [`keep_record`] at the
    /// start, [`step2`], what others do meanwhile, [`may_flip`], then the history below
    /// [`history_cutoff`].
    mod boundary {
        use super::*;
        use forge_core::private::convert::ConfigStamp;

        struct Chain {
            stamps: Vec<ConfigStamp>,
            current: u32,
            public: bool,
            /// The epochs whose keys the owner published.
            published: BTreeSet<u32>,
            /// Every push: the ref, its new tip, the epoch it was sealed under.
            pushes: Vec<(String, String, u32)>,
            /// The refs and tips this computer's record holds (Code only's choice).
            chosen: Option<Vec<(String, String)>>,
            active: ActiveSealOff,
            /// An owner start-over lands after the final pre-flip read.
            start_over_before_flip: Option<u32>,
            /// The refs the flip published, with their tips.
            code: BTreeMap<String, String>,
        }

        impl Chain {
            /// A private repo at epoch 0.
            fn new() -> Self {
                let mut c = Self {
                    stamps: Vec::new(),
                    current: 0,
                    public: false,
                    published: BTreeSet::new(),
                    pushes: Vec::new(),
                    chosen: None,
                    active: ActiveSealOff::None,
                    start_over_before_flip: None,
                    code: BTreeMap::new(),
                };
                c.state(0);
                c
            }

            /// A member pushes `tip` to `name`, sealed under the current epoch.
            fn push(&mut self, name: &str, tip: &str) {
                self.pushes.push((name.into(), tip.into(), self.current));
            }

            /// Each ref's newest tip sealed below `below` (every push, with none).
            fn refs_below(&self, below: Option<u32>) -> Vec<(String, String)> {
                let mut out: BTreeMap<String, String> = BTreeMap::new();
                for (n, t, e) in &self.pushes {
                    if below.is_none_or(|b| *e < b) {
                        out.insert(n.clone(), t.clone());
                    }
                }
                out.into_iter().collect()
            }

            /// `a` was pushed to the same ref as `b`, no later.
            fn is_ancestor(&self, a: &str, b: &str) -> bool {
                let at = |t: &str| self.pushes.iter().position(|(_, p, _)| p == t);
                match (at(a), at(b)) {
                    (Some(i), Some(j)) => i <= j && self.pushes[i].0 == self.pushes[j].0,
                    _ => false,
                }
            }

            /// Whether `tip` was pushed at epoch `from` or later.
            fn pushed_from(&self, tip: &str, from: u32) -> bool {
                self.pushes.iter().any(|(_, t, e)| t == tip && *e >= from)
            }

            fn state(&mut self, epoch: u32) {
                let n = u8::try_from(self.stamps.len()).unwrap();
                self.stamps.push(ConfigStamp {
                    id: [n; 32],
                    epoch: Some(epoch),
                    private: !self.public,
                    height: u64::from(n) + 1,
                });
            }

            /// A key rotation (anyone's): its anchor is stamped as the repo is.
            fn rotate(&mut self) -> u32 {
                self.current += 1;
                self.state(self.current);
                self.current
            }

            fn conversion(&self) -> Option<Conversion> {
                Conversion::of(self.public, &self.stamps, |e| e <= self.current)
            }
        }

        /// One computer's record: the seal-off epoch, and the epoch its rotation began from.
        #[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
        struct Rec {
            seal_off: Option<u32>,
            from: Option<u32>,
        }

        impl Rec {
            fn sealed(e: u32) -> Self {
                Self {
                    seal_off: Some(e),
                    from: None,
                }
            }
        }

        #[derive(Debug, PartialEq, Eq)]
        enum Outcome {
            /// Refused before anything more was signed.
            Refused(SealOff),
            /// Not the owner: refused while private.
            NotOwner,
            /// The seal-off rotation landed, but its answer was lost.
            Lost,
            /// The run found its boundary only after its check: run it again.
            RunAgain,
            /// Public, the history published below the cutoff (the owner) or left to them.
            Public { cutoff: u32 },
        }

        /// How a run goes.
        #[derive(Clone, Copy, Default)]
        #[allow(clippy::struct_excessive_bools)] // independent switches of the model
        struct Opts {
            owner: bool,
            start_over: bool,
            /// The rotation lands, then its answer is lost.
            lose_answer: bool,
            /// A node a block behind answers the first read of each step.
            lag: bool,
            /// A node behind answers the run's first read even after the wait.
            stale_start: bool,
            /// The owner names the refs again (`--ref`) rather than continuing the record's.
            named: bool,
        }

        const OWNER: Opts = Opts {
            owner: true,
            start_over: false,
            lose_answer: false,
            lag: false,
            stale_start: false,
            named: false,
        };

        /// The key epoch a step reads: a node behind shows the one before, until the read waits
        /// for [`wait_target`] and gets the chain's.
        fn read(chain: &Chain, rec: Rec, lag: bool) -> u32 {
            let shown = if lag {
                chain.current.saturating_sub(1)
            } else {
                chain.current
            };
            match wait_target(rec.seal_off, rec.from) {
                Some(t) if shown < t => chain.current,
                _ => shown,
            }
        }

        /// One run on a computer whose record is `rec`; `between` is what others do after step 2
        /// and before the flip.
        fn run_once(
            chain: &mut Chain,
            rec: &mut Rec,
            o: Opts,
            between: impl FnOnce(&mut Chain),
        ) -> Outcome {
            let none = BTreeSet::new();
            if !chain.public {
                if !o.owner {
                    return Outcome::NotOwner;
                }
                // `run`: the record found again and checked against the key read at the start
                let now = Some(if o.stale_start {
                    chain.current.saturating_sub(1)
                } else {
                    read(chain, *rec, o.lag)
                });
                rec.seal_off = recorded_seal_off(rec.seal_off, rec.from, now, &none);
                match keep_record(
                    seal_off_state(rec.seal_off, &ActiveSealOff::None, now),
                    o.start_over,
                ) {
                    Ok(true) => {}
                    Ok(false) => *rec = Rec::default(),
                    Err(st) => return Outcome::Refused(st),
                }
                // the check: below the boundary known now; a recorded choice within it
                let checked = rec.seal_off;
                let all = chain.refs_below(checked);
                let wanted = match chain.chosen.clone().filter(|_| !o.named) {
                    Some(c) => within_boundary(&c, &all, |a, b| chain.is_ancestor(a, b)).0,
                    None => all,
                };
                chain.chosen = Some(wanted.clone());
                let resumed = rec.seal_off.is_none() && rec.from.is_some();
                // `convert` step 2
                let now = Some(read(chain, *rec, o.lag));
                rec.seal_off = recorded_seal_off(rec.seal_off, rec.from, now, &none);
                match step2(rec.seal_off, now) {
                    Step2::Keep(_) => {}
                    Step2::Rotate => {
                        rec.from = Some(chain.current);
                        let e = chain.rotate();
                        if o.lose_answer {
                            return Outcome::Lost;
                        }
                        rec.seal_off = Some(e);
                    }
                    Step2::Stop(st) => return Outcome::Refused(st),
                }
                if checked_before_boundary(checked, rec.seal_off, resumed) {
                    return Outcome::RunAgain;
                }
                between(chain);
                if let Err(st) = may_flip(rec.seal_off, Some(chain.current)) {
                    return Outcome::Refused(st);
                }
                if let Some(through) = chain.start_over_before_flip.take() {
                    let epoch = chain.rotate();
                    chain.active = ActiveSealOff::Active {
                        epoch,
                        height: u64::from(epoch),
                        marker: None,
                        highest_epoch: epoch,
                        replaces_through: Some(through),
                    };
                }
                chain.public = true;
                chain.code = wanted.into_iter().collect();
            }
            // step 7: the history, below the lower of the stated and the recorded seal-off
            let stated = chain.conversion().unwrap().seal_off_epoch;
            let cutoff = history_cutoff_for_run(stated, &chain.active, rec.seal_off).unwrap();
            if o.owner {
                chain.published.extend(0..cutoff);
            }
            Outcome::Public { cutoff }
        }

        #[test]
        fn replacement_after_the_final_read_keeps_this_runs_checked_history_cutoff() {
            let mut chain = Chain::new();
            for _ in 0..4 {
                chain.rotate();
            }
            let mut rec = Rec::default();
            chain.start_over_before_flip = Some(5);
            let out = run_once(&mut chain, &mut rec, OWNER, |_| {});
            assert_eq!(chain.conversion().unwrap().seal_off_epoch, Some(6));
            assert_eq!(chain.active.boundary(rec.seal_off), Some(6));
            assert_eq!(rec.seal_off, Some(5));
            assert_eq!(out, Outcome::Public { cutoff: 5 });
            assert_eq!(chain.published, (0..5).collect());
            sealed_from(&chain, 5);
        }

        /// Nothing at or after `boundary` was published.
        fn sealed_from(chain: &Chain, boundary: u32) {
            assert!(
                chain.published.iter().all(|&e| e < boundary),
                "published {:?}, boundary {boundary}",
                chain.published
            );
        }

        /// Lost answer, a node behind at the start, a member push after the boundary, then Code
        /// only resumes: nothing pushed at or after the boundary is published.
        #[test]
        fn a_check_made_before_the_boundary_was_found_is_never_published() {
            let mut chain = Chain::new();
            chain.push("refs/heads/main", "a0");
            let mut rec = Rec::default();
            let lose = Opts {
                lose_answer: true,
                ..OWNER
            };
            assert_eq!(run_once(&mut chain, &mut rec, lose, |_| {}), Outcome::Lost);
            // members push under the run's own key change (epoch 1)
            chain.push("refs/heads/main", "a1");
            chain.push("refs/heads/feature", "f1");
            // the owner names the refs again; a node behind answers the first read
            let named = Opts {
                stale_start: true,
                named: true,
                ..OWNER
            };
            assert_eq!(
                run_once(&mut chain, &mut rec, named, |_| {}),
                Outcome::RunAgain
            );
            assert_eq!((rec.seal_off, chain.public), (Some(1), false));
            // the record kept that check's choice; a resume drops what it can't stand for
            let out = run_once(&mut chain, &mut rec, OWNER, |_| {});
            assert_eq!(out, Outcome::Public { cutoff: 1 });
            assert!(
                chain.code.values().all(|t| !chain.pushed_from(t, 1)),
                "published {:?}",
                chain.code
            );
            // named again on a fresh copy: what main was before the boundary
            let mut again = Chain::new();
            again.push("refs/heads/main", "a0");
            let mut r = Rec::default();
            let _ = run_once(&mut again, &mut r, lose, |_| {});
            again.push("refs/heads/main", "a1");
            let _ = run_once(&mut again, &mut r, named, |_| {});
            let renamed = Opts {
                named: true,
                ..OWNER
            };
            assert_eq!(
                run_once(&mut again, &mut r, renamed, |_| {}),
                Outcome::Public { cutoff: 1 }
            );
            assert_eq!(
                again.code,
                BTreeMap::from([("refs/heads/main".to_string(), "a0".to_string())])
            );
        }

        #[test]
        fn resume_after_a_concurrent_rotation_keeps_the_original_boundary() {
            let mut chain = Chain::new();
            let mut rec = Rec::default();
            // the run seals off at 1; another maintainer rotates to 2 before the flip
            let first = run_once(&mut chain, &mut rec, OWNER, |c| {
                c.rotate();
            });
            assert_eq!(first, Outcome::Refused(SealOff::Passed(1)));
            assert_eq!(rec.seal_off, Some(1));
            // the resume neither rotates again nor flips: the boundary stays 1
            let resumed = run_once(&mut chain, &mut rec, OWNER, |_| {});
            assert_eq!(resumed, Outcome::Refused(SealOff::Passed(1)));
            assert_eq!(
                (rec.seal_off, chain.current, chain.public),
                (Some(1), 2, false)
            );
            sealed_from(&chain, 1);
            // only a new run the owner starts on purpose makes it public, with its own boundary
            let again = Opts {
                start_over: true,
                ..OWNER
            };
            let fresh = run_once(&mut chain, &mut rec, again, |_| {});
            assert_eq!(fresh, Outcome::Public { cutoff: 3 });
        }

        #[test]
        fn two_clients_resuming_never_publish_past_the_original_boundary() {
            let mut chain = Chain::new();
            let mut here = Rec::default();
            let mut elsewhere = Rec::default();
            let first = run_once(&mut chain, &mut here, OWNER, |c| {
                c.rotate();
            });
            assert_eq!(first, Outcome::Refused(SealOff::Passed(1)));
            // a maintainer can't continue it while private, and the owner here can't either
            let maint = Opts {
                owner: false,
                ..OWNER
            };
            assert_eq!(
                run_once(&mut chain, &mut elsewhere, maint, |_| {}),
                Outcome::NotOwner
            );
            assert_eq!(
                run_once(&mut chain, &mut here, OWNER, |_| {}),
                Outcome::Refused(SealOff::Passed(1))
            );
            assert!(!chain.public);
            sealed_from(&chain, 1);
            // start-over is refused while this computer's run can still be finished
            let mut kept = Rec::sealed(chain.rotate());
            let again = Opts {
                start_over: true,
                ..OWNER
            };
            let st = run_once(&mut chain, &mut kept, again, |_| {});
            assert_eq!(st, Outcome::Refused(SealOff::Keep(3)));
        }

        #[test]
        fn an_interrupted_run_after_a_second_rotation_never_moves_its_boundary() {
            let mut chain = Chain::new();
            let mut rec = Rec::default();
            // interrupted right after its seal-off at 1 (the key read before the flip never came)
            assert_eq!(step2(rec.seal_off, Some(chain.current)), Step2::Rotate);
            rec = Rec::sealed(chain.rotate());
            // two more rotations by others
            chain.rotate();
            chain.rotate();
            for _ in 0..2 {
                let out = run_once(&mut chain, &mut rec, OWNER, |_| {});
                assert_eq!(out, Outcome::Refused(SealOff::Passed(1)));
            }
            assert_eq!(
                (rec.seal_off, chain.current, chain.public),
                (Some(1), 3, false)
            );
            sealed_from(&chain, 1);
            // a node that doesn't show the run's rotation yet: wait, never rotate again
            let mut ahead = Rec::sealed(4);
            let out = run_once(&mut chain, &mut ahead, OWNER, |_| {});
            assert_eq!(out, Outcome::Refused(SealOff::Behind(4)));
            assert_eq!(chain.current, 3);
        }

        #[test]
        fn a_client_resuming_from_the_chain_alone_reads_the_original_boundary() {
            // a concurrent rotation, then the resume: never flipped, so the chain states no
            // later boundary for any client to read
            let mut concurrent = Chain::new();
            let mut r = Rec::default();
            let _ = run_once(&mut concurrent, &mut r, OWNER, |c| {
                c.rotate();
            });
            let _ = run_once(&mut concurrent, &mut r, OWNER, |_| {});
            assert!(
                concurrent.conversion().is_none(),
                "flipped past its boundary"
            );

            // a run sealed off at 1 and flipped, interrupted before the history
            let mut chain = Chain::new();
            let rec = Rec::sealed(chain.rotate());
            assert_eq!(may_flip(rec.seal_off, Some(chain.current)), Ok(()));
            chain.public = true;
            // members rotate after the flip: public anchors never move the stated boundary
            chain.rotate();
            chain.rotate();
            assert_eq!(chain.conversion().unwrap().seal_off_epoch, Some(1));
            // a third client with no record (a maintainer), then the owner on another computer
            let mut none = Rec::default();
            let maint = Opts {
                owner: false,
                ..OWNER
            };
            assert_eq!(
                run_once(&mut chain, &mut none, maint, |_| {}),
                Outcome::Public { cutoff: 1 }
            );
            assert!(chain.published.is_empty(), "the history is the owner's");
            assert_eq!(
                run_once(&mut chain, &mut none, OWNER, |_| {}),
                Outcome::Public { cutoff: 1 }
            );
            assert_eq!(chain.published, BTreeSet::from([0]));
            sealed_from(&chain, 1);
        }

        #[test]
        fn a_seal_off_that_landed_but_was_never_recorded_is_never_made_twice() {
            let mut chain = Chain::new();
            let mut rec = Rec::default();
            let lose = Opts {
                lose_answer: true,
                ..OWNER
            };
            // the rotation to 1 lands, then its answer is lost
            assert_eq!(run_once(&mut chain, &mut rec, lose, |_| {}), Outcome::Lost);
            assert_eq!((rec.seal_off, rec.from, chain.current), (None, Some(0), 1));
            // the resume finds it again: no second rotation, the boundary is 1
            let out = run_once(&mut chain, &mut rec, OWNER, |_| {});
            assert_eq!(out, Outcome::Public { cutoff: 1 });
            assert_eq!(chain.current, 1);
            sealed_from(&chain, 1);

            // lost, and a node a block behind answers the resume: it is waited for, never
            // rotated around
            let mut chain = Chain::new();
            let mut rec = Rec::default();
            assert_eq!(run_once(&mut chain, &mut rec, lose, |_| {}), Outcome::Lost);
            let behind = Opts { lag: true, ..OWNER };
            let out = run_once(&mut chain, &mut rec, behind, |_| {});
            assert_eq!(out, Outcome::Public { cutoff: 1 });
            assert_eq!(chain.current, 1);

            // lost, then another maintainer rotates: the boundary is still the run's own
            let mut chain = Chain::new();
            let mut rec = Rec::default();
            assert_eq!(run_once(&mut chain, &mut rec, lose, |_| {}), Outcome::Lost);
            chain.rotate();
            let out = run_once(&mut chain, &mut rec, OWNER, |_| {});
            assert_eq!(out, Outcome::Refused(SealOff::Passed(1)));
            assert_eq!(
                (rec.seal_off, chain.current, chain.public),
                (Some(1), 2, false)
            );
        }
    }
}
