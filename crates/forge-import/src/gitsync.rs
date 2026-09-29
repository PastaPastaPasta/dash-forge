//! Git data through the ordinary remote helper: pushing a bare mirror to `dash://…`.
//!
//! No special path (PRD 06): the helper's pack pipeline, storage policy (`dash.storage`,
//! `dash.replicas`, ...), resumable chunk journal and idempotency all apply. A ref already at
//! its tip is not pushed and a pack already recorded is not stored again, so re-running a
//! sync with nothing new costs nothing.
//!
//! **The cap reaches into the push.** A push is first priced with a dry run (the helper
//! builds the pack and estimates, storing nothing); that estimate is charged to the run's
//! budget, and only then is the real push made, with the helper's own cost guard set to what
//! the budget had left before the charge, in the helper's own units (its price, without what the
//! importer adds for a push the helper did not price: an armed Platform fallback's chunks,
//! refs moving alone), and `dash.confirm=refuse`: the helper
//! never asks, even on a terminal, and refuses above the threshold before storing anything.
//! The importer reads the helper's JSON progress events (`GIT_DASH_JSON=1`) for what each
//! push planned and charged.
//!
//! Branches and tags are one push; the heads of **open** PRs (`refs/mirror/pull/<n>/head`)
//! are a second, optional one, so a stranger's large PR can fail only its own push, never the
//! mirror of branches, tags and issues. It prunes the heads of PRs that closed.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;

use forge_core::network::NetworkTarget;

use forge_core::cost::push_fees;

/// What one push sends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refs {
    /// Branches and tags (forced, so a force-push upstream is mirrored as one); deletions
    /// come from `--prune`.
    Code,
    /// The heads of these open PRs, as `refs/mirror/pull/<n>/head` (checkoutable).
    PullHeads(Vec<u64>),
}

impl Refs {
    fn refspecs(&self) -> Vec<String> {
        match self {
            Refs::Code => vec![
                "+refs/heads/*:refs/heads/*".into(),
                "+refs/tags/*:refs/tags/*".into(),
            ],
            // One wildcard over the mirror's local `refs/mirror/pull/*`, which
            // [`sync_pull_heads`] keeps to exactly the open PRs, so `--prune` deletes the
            // heads of PRs that closed (also when none is open any more: the push then only
            // deletes).
            Refs::PullHeads(_) => vec!["+refs/mirror/pull/*:refs/mirror/pull/*".into()],
        }
    }

    /// `for-each-ref` patterns of what this push sends (the fresh estimate).
    fn local_patterns(&self) -> Vec<String> {
        match self {
            Refs::Code => vec!["refs/heads/".into(), "refs/tags/".into()],
            Refs::PullHeads(_) => vec!["refs/mirror/pull/".into()],
        }
    }
}

/// What a push did (or would do), from the helper's progress events.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PushReport {
    /// Refs git updated (created, moved or deleted).
    pub refs: u64,
    /// Packs stored.
    pub packs: u64,
    /// Bytes in them.
    pub pack_bytes: u64,
    /// The estimate of what it stores (credits): the helper's price plus what it did not
    /// price ([`price_helper_estimate`]).
    pub est_credits: u64,
    /// The helper's own price for it: what its cost guard compares
    /// `dash.costWarnThreshold` against.
    pub helper_credits: u64,
    /// Documents the helper said it writes (chunks + manifests + ref updates), when it
    /// reported them.
    pub docs: u64,
    /// Of [`Self::docs`], the Platform `chunk` documents (0: the pack goes to your own
    /// storage, and only manifests and ref updates are written on chain).
    pub chunks: u64,
    /// Of [`Self::docs`], the `packManifest` documents.
    pub manifests: u64,
    /// Of [`Self::docs`], the `refUpdate` documents.
    pub ref_updates: u64,
    /// Objects in the packs.
    pub objects: u64,
    /// Of [`Self::est_credits`], the Platform chunks an armed `dash.platformFallback` would
    /// store: the helper's guard weighs them itself when it falls back, so they are not taken
    /// off its threshold.
    pub fallback_credits: u64,
    /// Why the push left its browse index unpublished, with the fix (the helper's
    /// `indexSkipped` event, D-920): the repository clones but the web cannot browse it.
    pub index_skipped: Option<String>,
}

impl PushReport {
    /// Count one pack of `bytes` bytes and `objects` objects.
    fn add_pack(&mut self, bytes: u64, objects: u64) {
        self.packs += 1;
        self.pack_bytes += bytes;
        self.objects += objects;
    }

    /// What [`Self::est_credits`] adds on top of the helper's price that the helper's guard
    /// does not weigh (the fallback chunks excluded: it weighs those when it falls back).
    pub fn overhead(&self) -> u64 {
        self.est_credits
            .saturating_sub(self.helper_credits)
            .saturating_sub(self.fallback_credits)
    }
}

/// Fold the helper's JSON events (`stderr`, one object per line) and git's porcelain
/// (`stdout`) into a [`PushReport`].
pub fn parse_push(stdout: &str, stderr: &str) -> PushReport {
    let mut r = PushReport::default();
    for v in events(stderr) {
        let num = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
        match v.get("event").and_then(Value::as_str) {
            Some("plan") if num("objects") > 0 => r.add_pack(num("bytes"), num("objects")),
            // A dry run found the pack already recorded by the pusher: a push stores only
            // the refs (the `platform` event that follows prices just those).
            Some("recorded") => {
                r.packs = r.packs.saturating_sub(1);
                (r.pack_bytes, r.objects) = (0, 0);
            }
            Some("platform") => {
                r.chunks += num("chunks");
                r.manifests += num("manifests");
                r.ref_updates += num("refUpdates");
                r.docs += num("chunks") + num("manifests") + num("refUpdates");
                r.est_credits += num("estCredits");
                r.helper_credits += num("estCredits");
            }
            _ => {}
        }
    }
    // Porcelain: `<flag>\t<from>:<to>\t<summary>`; `=` is up to date, `!` rejected.
    r.refs = stdout
        .lines()
        .filter(|l| l.contains('\t'))
        .filter(|l| matches!(l.chars().next(), Some(' ' | '+' | '-' | '*')))
        .count() as u64;
    r
}

/// The helper's JSON events in `stderr` (one object per line; other lines skipped).
fn events(stderr: &str) -> impl Iterator<Item = Value> + '_ {
    stderr
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
}

/// What a FAILED push still wrote, from the helper's `stored` and `refUpdate` events (each
/// emitted the moment its document landed). A push can store its pack and move some refs,
/// then fail at a later ref or at the read-back: those writes are paid for and on chain, and
/// the run must say so rather than report nothing (D-601).
pub fn parse_landed(stderr: &str) -> PushReport {
    let mut r = PushReport::default();
    for v in events(stderr) {
        let num = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
        match v.get("event").and_then(Value::as_str) {
            Some("stored") => r.add_pack(num("bytes"), num("objects")),
            Some("refUpdate") => r.refs += 1,
            // The push left its browse index unpublished (D-920): the helper's own message,
            // which names the fix.
            Some("indexSkipped") => {
                let text = |k: &str| v.get(k).and_then(Value::as_str);
                r.index_skipped = text("message").map(str::to_string).or_else(|| {
                    // An older helper sent no `message`: build one from its parts.
                    text("reason").map(|why| match text("fix") {
                        Some(fix) => format!(
                            "the pack was stored but its browse index was not published ({why}); \
                             run `{fix}`"
                        ),
                        None => format!(
                            "the pack was stored but its browse index was not published ({why})"
                        ),
                    })
                });
            }
            _ => {}
        }
    }
    r
}

/// A push that failed, with what it still wrote before failing ([`parse_landed`]).
#[derive(Debug)]
pub struct PushFailed {
    /// What landed on chain before the failure.
    pub landed: PushReport,
    /// Why it failed.
    pub error: anyhow::Error,
}

impl std::fmt::Display for PushFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:#}", self.error)
    }
}

impl std::error::Error for PushFailed {}

/// Pushes a bare mirror to a `dash://` remote through `git-remote-dash`.
pub struct GitPusher {
    /// The bare mirror.
    pub git_dir: PathBuf,
    /// `dash://owner/name`.
    pub url: String,
    /// The signing identity source (a file path or an inline `dfk1:` key).
    pub key: PathBuf,
    /// The network (its env vars are handed to the helper).
    pub network: NetworkTarget,
    /// What to push.
    pub refs: Refs,
    /// The storage policy may fall back to Platform (`dash.platformFallback`): the helper's
    /// dry run prices the pack on your storage, but a real push can store it as chunks.
    pub fallback: bool,
}

/// Turn the helper's dry-run price into the estimate charged to the budget. The helper
/// prices what it will write with the measured fees ([`push_fees::estimate_push`], an upper
/// bound), so its price stands, with additions for what it did not price: refs moving alone
/// (no pack, so no `platform` event); a pack from a helper that reports no `platform` event
/// (priced as the worst case, sealed on Platform); and, with `fallback` armed and no chunks
/// priced, the pack's Platform chunks (a push whose storage fails stores them, and the
/// helper's own guard weighs them then: [`PushReport::fallback_credits`]).
pub fn price_helper_estimate(mut r: PushReport, fallback: bool) -> PushReport {
    if r.docs == 0 && r.packs == 0 {
        // Only refs move (a branch or tag at a commit already stored): each ref update is
        // one document.
        r.est_credits = r
            .est_credits
            .saturating_add(push_fees::estimate_ref_updates(r.refs));
        return r;
    }
    // Sealed and on Platform: the most a pack of this size can cost (a private repository
    // seals it; a fallback or a Platform policy stores it as chunks).
    let worst = |r: &PushReport| {
        push_fees::estimate_push(&push_fees::PushShape {
            pack_bytes: r.pack_bytes,
            objects: r.objects,
            index_objects: r.objects,
            refs: r.refs,
            external_targets: 0,
            platform_bytes: true,
            sealed: true,
        })
    };
    if r.docs == 0 {
        // A helper that reported the pack but no `platform` event: price the worst case.
        r.est_credits = r.est_credits.max(worst(&r).total());
        return r;
    }
    if fallback && r.chunks == 0 && r.pack_bytes > 0 {
        let chunks = worst(&r).chunk_credits;
        r.est_credits = r.est_credits.saturating_add(chunks);
        r.fallback_credits = chunks;
    }
    r
}

/// Make the mirror's local `refs/mirror/pull/<n>/head` exactly the heads of the `open` PRs
/// it fetched (`<source_prefix><n>/head`: `refs/pull/` on GitHub, `refs/merge-requests/` on
/// GitLab); a PR whose head was not fetched is left out.
pub fn sync_pull_heads(git_dir: &Path, open: &[u64], source_prefix: &str) -> Result<()> {
    use std::fmt::Write as _;
    let git = |args: &[&str]| -> Result<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(git_dir)
            .args(args)
            .output()
            .context("running git")?;
        if !out.status.success() {
            bail!(
                "git {} failed: {}",
                args.first().unwrap_or(&""),
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    };
    let mut script = String::new();
    let mut keep = std::collections::BTreeSet::new();
    for n in open {
        let src = format!("{source_prefix}{n}/head");
        if let Ok(oid) = git(&["rev-parse", "--verify", "--quiet", &src]) {
            let dst = format!("refs/mirror/pull/{n}/head");
            let _ = writeln!(script, "update {dst} {}", oid.trim());
            keep.insert(dst);
        }
    }
    for name in git(&["for-each-ref", "--format=%(refname)", "refs/mirror/pull/"])?.lines() {
        if !keep.contains(name) {
            let _ = writeln!(script, "delete {name}");
        }
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(git_dir)
        .args(["update-ref", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .context("running git update-ref")?;
    {
        use std::io::Write as _;
        child
            .stdin
            .take()
            .expect("piped")
            .write_all(script.as_bytes())?;
    }
    if !child.wait()?.success() {
        bail!("git update-ref failed in {}", git_dir.display());
    }
    Ok(())
}

/// The git data a run proves merged PRs against (D-602, [`crate::sink::Sink::with_mirror`]).
#[derive(Debug, Clone)]
pub struct ProofRepo {
    /// A bare repository holding the base branches' commits.
    pub dir: PathBuf,
    /// This run pushes its branches from `dir` (`--sync code`): its own tip of a base is what
    /// the chain is about to show. Otherwise nothing is pushed, and `dir` only answers
    /// ancestry questions for the base tips already on chain.
    pub pushed: bool,
    /// Bases [`fetch_proof_bases`] could not fetch, and why.
    pub unfetched: BTreeMap<String, Unfetched>,
}

/// Why a base branch is not in a [`ProofRepo`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unfetched {
    /// The source has no such branch any more (git: "couldn't find remote ref"): a merge into
    /// it can never be proved, whatever a later run does.
    Gone,
    /// The fetch failed another way (network, auth): a later run may succeed.
    Failed,
}

/// Where [`fetch_proof_bases`] keeps a base branch: never pushed (the pushes send only
/// `refs/heads/*`, `refs/tags/*` and `refs/mirror/pull/*`), never pruned by `sync_mirror`.
pub const PROOF_PREFIX: &str = "refs/forge-import/proof/";

/// Fetch the base branches `bases` (`refs/heads/<b>`) from `url` into the bare repository
/// at `git_dir` (created when missing), under [`PROOF_PREFIX`]: the commits a merged PR's
/// merge commit is checked against when this run syncs no `code` (D-602 without a push).
///
/// `treeless` fetches commits only (`--filter=tree:0`, a few MB even for dashpay/dash):
/// ancestry needs no trees. Only for a repository made for the proof: a filtered fetch into
/// a full mirror would make it a partial clone, and a later push of it would lack trees. The
/// fetch leaves `url` recorded as a promisor remote; that is removed again, so reading the
/// repository never fetches a missing object from the network ([`is_ancestor`] also turns
/// lazy fetches off, on git 2.45 and later).
///
/// Each base is fetched on its own, so one deleted at the source (a merge into a branch
/// that is gone) does not stop the others. Returns the bases that could not be fetched.
pub fn fetch_proof_bases(
    git_dir: &Path,
    url: &str,
    bases: &[String],
    treeless: bool,
    auth: Option<&(String, String)>,
) -> Result<BTreeMap<String, Unfetched>> {
    if !git_dir.join("HEAD").exists() {
        std::fs::create_dir_all(git_dir)?;
        let init = Command::new("git")
            .args(["init", "--bare", "--quiet"])
            .arg(git_dir)
            .status()
            .context("running git")?;
        if !init.success() {
            bail!("git init failed in {}", git_dir.display());
        }
    }
    let mut missing = BTreeMap::new();
    for base in bases {
        let outcome = match base.strip_prefix("refs/heads/") {
            Some(branch) => fetch_proof_base(git_dir, url, base, branch, treeless, auth)?,
            None => Some(Unfetched::Gone),
        };
        if let Some(why) = outcome {
            missing.insert(base.clone(), why);
        }
    }
    if treeless {
        forget_promisor(git_dir, url);
    }
    Ok(missing)
}

/// One base of [`fetch_proof_bases`]: `None` when it was fetched.
fn fetch_proof_base(
    git_dir: &Path,
    url: &str,
    base: &str,
    branch: &str,
    treeless: bool,
    auth: Option<&(String, String)>,
) -> Result<Option<Unfetched>> {
    let mut cmd = Command::new("git");
    if let Some((k, v)) = auth {
        crate::github::append_git_config(&mut cmd, k, v);
    }
    cmd.arg("-C")
        .arg(git_dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .args(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head"]);
    if treeless {
        cmd.arg("--filter=tree:0");
    }
    let out = cmd
        .arg("--")
        .arg(url)
        .arg(format!("+{base}:{PROOF_PREFIX}heads/{branch}"))
        .output()
        .context("running git")?;
    Ok(if out.status.success() {
        None
    } else if String::from_utf8_lossy(&out.stderr).contains("couldn't find remote ref") {
        Some(Unfetched::Gone)
    } else {
        Some(Unfetched::Failed)
    })
}

/// Drop the promisor remote a filtered fetch of `url` recorded, so git never goes back to it
/// for an object the proof repository lacks (a missing object is then just missing).
fn forget_promisor(git_dir: &Path, url: &str) {
    for key in ["promisor", "partialclonefilter"] {
        let _ = Command::new("git")
            .arg("-C")
            .arg(git_dir)
            .args(["config", "--unset-all", &format!("remote.{url}.{key}")])
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// `git -C <git_dir>` for a read that must never reach the network: no lazy fetch of a
/// missing object from a promisor remote (`GIT_NO_LAZY_FETCH`, git 2.45+; older gits are
/// covered by [`forget_promisor`]), no credential prompt, nothing on stdin.
fn local_git(git_dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(git_dir)
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null());
    cmd
}

/// Whether commit `ancestor` is reachable from `tip` in the mirror at `git_dir` (itself
/// included). `false` when either is missing locally.
pub fn is_ancestor(git_dir: &Path, ancestor: &str, tip: &str) -> bool {
    ancestor == tip
        || local_git(git_dir)
            .args(["merge-base", "--is-ancestor", ancestor, tip])
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
}

/// The commit `ref_name` points at in the mirror, if it exists there.
pub fn local_tip(git_dir: &Path, ref_name: &str) -> Option<String> {
    let out = local_git(git_dir)
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("{ref_name}^{{commit}}"))
        .output()
        .ok()?;
    let oid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !oid.is_empty()).then_some(oid)
}

/// The tips of the mirror's refs matching `patterns`.
fn local_tips(git_dir: &Path, patterns: &[String]) -> Result<Vec<String>> {
    if patterns.is_empty() {
        return Ok(Vec::new());
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(git_dir)
        .args(["for-each-ref", "--format=%(objectname)"])
        .args(patterns)
        .output()
        .context("listing the mirror's refs")?;
    if !out.status.success() {
        bail!("git for-each-ref failed in {}", git_dir.display());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

/// Where the helper will store a push's pack, as far as its price goes: decided by the
/// same git config the helper reads (`dash.storage`, `dash.platformFallback`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackStorage {
    /// Platform `chunk` documents hold the pack (and its browse index): the default, and
    /// also the price of a policy that lists `platform` or may fall back to it.
    Platform {
        /// External targets the manifests also name (a mixed policy, or a fallback's own
        /// storage): each adds its URIs.
        external_targets: u64,
    },
    /// Only your own storage holds it: the chain gets the manifests and ref updates.
    External {
        /// External targets the manifests name (each adds its URIs to them).
        targets: u64,
    },
}

impl PackStorage {
    /// Platform alone: `dash.storage` unset or `platform`.
    pub const PLATFORM: Self = Self::Platform {
        external_targets: 0,
    };

    /// `policy` (read with [`storage_policy`]) resolved against `profiles`. An unknown
    /// profile or a bad value is an error here, as it would be for the push.
    pub fn resolve(
        policy: &forge_core::storage::StoragePolicy,
        profiles: &forge_core::storage::StorageProfiles,
    ) -> Result<Self> {
        let resolved = policy.resolve(profiles)?;
        let external_targets = resolved.external.len() as u64;
        Ok(if resolved.platform || resolved.platform_fallback {
            // A fallback may store the pack on Platform: price that, so the estimate stays
            // an upper bound.
            Self::Platform { external_targets }
        } else {
            Self::External {
                targets: external_targets,
            }
        })
    }
}

/// The storage policy in `git_dir`'s git config (`dash.storage`, `dash.replicas`,
/// `dash.platformFallback`, any scope), as the helper reads it.
pub fn storage_policy(git_dir: &Path) -> Result<forge_core::storage::StoragePolicy> {
    use forge_core::storage::policy::{git_config_scoped_with, run_git_config};
    let dir = git_dir
        .to_str()
        .ok_or_else(|| anyhow!("{} is not a UTF-8 path", git_dir.display()))?;
    let get = |key: &str| {
        git_config_scoped_with(key, |args| {
            let mut all = vec!["-C", dir];
            all.extend_from_slice(args);
            run_git_config(&all)
        })
        .map(|(_, v)| v)
    };
    Ok(forge_core::storage::StoragePolicy::from_git_values(
        get("dash.storage").as_deref(),
        get("dash.replicas").as_deref(),
        get("dash.platformFallback").as_deref(),
    )?)
}

/// Price the first push into a repository that does not exist yet (so the helper cannot
/// be asked): build the pack locally and price what `storage` writes on chain (the caller
/// reads it with [`storage_policy`] and [`PackStorage::resolve`]). The PR heads' pack leaves out what the
/// branches and tags already carry (it is pushed after them).
pub fn estimate_fresh(git_dir: &Path, refs: &Refs, storage: PackStorage) -> Result<PushReport> {
    let tips = local_tips(git_dir, &refs.local_patterns())?;
    let refs_n = tips.len() as u64;
    if tips.is_empty() {
        return Ok(PushReport::default());
    }
    let mut unique: Vec<&str> = tips.iter().map(String::as_str).collect();
    unique.sort_unstable();
    unique.dedup();
    let bases = match refs {
        Refs::Code => Vec::new(),
        Refs::PullHeads(_) => local_tips(git_dir, &Refs::Code.local_patterns())?,
    };
    let bases: Vec<&str> = bases.iter().map(String::as_str).collect();
    let pack =
        forge_core::pack::build_pack(git_dir, &unique, &bases).context("sizing the first push")?;
    let bytes = pack.bytes.len() as u64;
    let est = fresh_push_credits(bytes, pack.parsed.object_count() as u64, refs_n, storage);
    Ok(PushReport {
        refs: refs_n,
        packs: 1,
        pack_bytes: bytes,
        est_credits: est,
        // No helper price for a repo that does not exist yet; the estimate stands in.
        helper_credits: est,
        ..PushReport::default()
    })
}

/// What a push of one `bytes`-byte pack of `objects` objects and `refs` ref updates writes
/// on chain, credits, priced as the helper will price it ([`push_fees::estimate_push`]): with
/// Platform storage, the pack and its browse index as chunks plus their two manifests and
/// the refs; with your own storage, only the manifests (carrying each target's URIs) and
/// the refs.
pub fn fresh_push_credits(bytes: u64, objects: u64, refs: u64, storage: PackStorage) -> u64 {
    let (external_targets, platform_bytes) = match storage {
        PackStorage::Platform { external_targets } => (external_targets, true),
        PackStorage::External { targets } => (targets, false),
    };
    push_fees::estimate_push(&push_fees::PushShape {
        pack_bytes: bytes,
        objects,
        index_objects: objects,
        refs,
        external_targets,
        platform_bytes,
        // forge-import creates public repositories; an existing private one is priced by
        // its helper, which seals.
        sealed: false,
    })
    .total()
}

impl GitPusher {
    /// Price the push: the helper builds the pack and estimates, storing nothing. The
    /// estimate never counts fewer ref updates than git reports.
    pub fn estimate(&self) -> Result<PushReport> {
        let r = self.run(true, None)?;
        Ok(price_helper_estimate(r, self.fallback))
    }

    /// Push for real. The caller has already charged [`Self::estimate`] to its budget.
    /// `max_credits` (in the helper's units: the budget left before that charge, less the
    /// estimate's additions to the helper's price) arms the helper's cost guard: a push the helper prices
    /// above it is refused before anything is stored.
    pub fn push(&self, max_credits: Option<u64>) -> Result<PushReport> {
        self.run(false, max_credits)
    }

    fn run(&self, dry_run: bool, max_credits: Option<u64>) -> Result<PushReport> {
        let spec = self.refs.refspecs();
        if spec.is_empty() {
            return Ok(PushReport::default());
        }
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&self.git_dir);
        match max_credits {
            // Never a prompt (even on a terminal): above the threshold the helper refuses
            // (E801), below it proceeds.
            Some(max) => cmd.args([
                "-c".to_string(),
                "dash.confirm=refuse".to_string(),
                "-c".to_string(),
                format!("dash.costWarnThreshold={}", threshold_dash(max)),
            ]),
            None => cmd.args(["-c", "dash.confirm=never"]),
        };
        cmd.args(["push", "--porcelain", "--prune"]);
        if dry_run {
            cmd.arg("--dry-run");
        }
        cmd.arg(&self.url).args(&spec);
        cmd.env("PATH", helper_path()?)
            .env("DASH_FORGE_KEY", &self.key)
            .env("GIT_DASH_JSON", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .envs(self.network.env_vars());
        let out = cmd.output().context("running git")?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !out.status.success() {
            let why: Vec<&str> = stderr
                .lines()
                .filter(|l| !l.trim_start().starts_with('{'))
                .collect();
            let error = anyhow!(
                "pushing to {}{} failed:\n{}",
                self.url,
                if dry_run { " (dry run)" } else { "" },
                why.join("\n").trim()
            );
            return Err(PushFailed {
                landed: parse_landed(&stderr),
                error,
            }
            .into());
        }
        let mut report = parse_push(&stdout, &stderr);
        if !dry_run {
            // Packs actually stored (`stored` events), not packs planned: a pack an earlier
            // run already recorded is planned again but never stored twice.
            let landed = parse_landed(&stderr);
            (report.packs, report.pack_bytes, report.objects) =
                (landed.packs, landed.pack_bytes, landed.objects);
            report.index_skipped = landed.index_skipped;
        }
        Ok(report)
    }
}

/// Whether a push error is the helper's cost guard refusing before it stored anything
/// (E801 with its "nothing was stored or paid for" note).
pub fn refused_before_storing(e: &anyhow::Error) -> bool {
    let text = format!("{e:#}");
    text.contains("E801") && text.contains("nothing was stored or paid for")
}

/// A credit amount as the DASH string `dash.costWarnThreshold` takes, rounded DOWN (to
/// 10⁻⁸ DASH) so the guard never admits more than the budget.
fn threshold_dash(credits: u64) -> String {
    let units = credits / 1_000; // 1 DASH = 10¹¹ credits = 10⁸ units of 10³ credits
    format!("{}.{:08}", units / 100_000_000, units % 100_000_000)
}

/// `PATH` with the directory of this binary first, so the `git-remote-dash` shipped next
/// to it is the one git runs.
fn helper_path() -> Result<String> {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .ok_or_else(|| anyhow!("cannot locate this binary's directory"))?;
    let path = std::env::var("PATH").unwrap_or_default();
    Ok(format!("{}:{path}", dir.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_events_and_porcelain_fold_into_a_report() {
        let stderr = r#"{"event":"plan","repo":"o/r","refs":["main"],"tip":"ab","objects":3,"bytes":900}
{"event":"targets","estCredits":5}
{"event":"platform","chunks":1,"manifests":2,"refUpdates":2,"estCredits":1234}
{"event":"done","chargedCredits":1100,"charge":"measured","remainingCredits":9}
dash: some human line"#;
        let stdout = "To dash://o/r\n*\trefs/heads/main:refs/heads/main\t[new branch]\n=\trefs/tags/v1:refs/tags/v1\t[up to date]\n-\t:refs/heads/old\t[deleted]\nDone\n";
        assert_eq!(
            parse_push(stdout, stderr),
            PushReport {
                refs: 2,
                packs: 1,
                pack_bytes: 900,
                est_credits: 1234,
                helper_credits: 1234,
                docs: 5,
                chunks: 1,
                manifests: 2,
                ref_updates: 2,
                objects: 3,
                fallback_credits: 0,
                index_skipped: None,
            }
        );
    }

    /// D-920: the dashpay/dash import stored an 18,452-chunk pack whose browse index was
    /// never published, and its summary said nothing. The helper's `indexSkipped` event now
    /// reaches the report, with the fix, whether the push then succeeded or failed.
    #[test]
    fn a_skipped_browse_index_reaches_the_report() {
        let stderr = r#"{"event":"stored","packHash":"cd","bytes":900,"objects":3}
{"event":"indexSkipped","message":"the pack was stored but its browse index was not published (not listed yet); the web cannot browse the new commits until `dg repo reindex o/r` publishes it","reason":"not listed yet","fix":"dg repo reindex o/r"}
{"event":"refUpdate","ref":"refs/heads/main","newOid":"1fe5ecd3"}"#;
        let w = parse_landed(stderr).index_skipped.expect("reported");
        assert!(w.contains("browse index was not published"), "{w}");
        assert!(w.contains("not listed yet"), "{w}");
        assert!(w.contains("`dg repo reindex o/r`"), "{w}");
        // Without `message` (an older helper), the reason and fix still reach the report.
        let w = parse_landed(
            r#"{"event":"indexSkipped","reason":"lagging node","fix":"dg repo reindex o/r"}"#,
        )
        .index_skipped
        .expect("reported");
        assert!(
            w.contains("lagging node") && w.contains("`dg repo reindex o/r`"),
            "{w}"
        );
        // A push that published its index says nothing.
        assert_eq!(
            parse_landed(r#"{"event":"stored","packHash":"cd","bytes":9,"objects":1}"#)
                .index_skipped,
            None
        );
    }

    /// D-601: a push that stored its pack and moved two refs, then failed, reported "0 ref
    /// updates". The helper's `stored` / `refUpdate` events say what landed.
    #[test]
    fn a_failed_push_still_reports_what_landed() {
        let stderr = r#"{"event":"plan","repo":"o/r","refs":["main","feature"],"tip":"ab","objects":3,"bytes":900}
{"event":"platform","chunks":1,"manifests":2,"refUpdates":3,"estCredits":1234}
{"event":"stored","packHash":"cd","bytes":900,"objects":3}
{"event":"refUpdate","ref":"refs/heads/feature","newOid":null}
{"event":"refUpdate","ref":"refs/heads/main","newOid":"1fe5ecd3"}
dash: push failed: ref did not converge to pushed tip"#;
        let landed = parse_landed(stderr);
        assert_eq!(
            (landed.refs, landed.packs, landed.pack_bytes, landed.objects),
            (2, 1, 900, 3)
        );
        // Nothing landed (refused before storing): nothing reported.
        assert_eq!(
            parse_landed(r#"{"event":"plan","objects":3,"bytes":9}"#),
            PushReport::default()
        );
    }

    /// D-601: a retry of a push whose pack is already recorded by the pusher is priced for
    /// its refs only, and a real push counts only the packs it actually stored.
    #[test]
    fn a_recorded_pack_is_not_priced_or_counted_again() {
        let dry = r#"{"event":"plan","repo":"o/r","refs":["main"],"tip":"ab","objects":3,"bytes":900}
{"event":"recorded","packHash":"cd"}
{"event":"platform","chunks":0,"manifests":0,"refUpdates":1,"estCredits":55}"#;
        let r = parse_push("*\trefs/heads/main:refs/heads/main\t[new branch]\n", dry);
        assert_eq!(
            (r.packs, r.pack_bytes, r.manifests, r.ref_updates),
            (0, 0, 0, 1)
        );
        let priced = price_helper_estimate(r, false);
        assert_eq!(priced.est_credits, 55, "the refs only, never a pack");
    }

    #[test]
    fn an_up_to_date_push_reports_nothing() {
        let r = parse_push(
            "=\trefs/heads/main:refs/heads/main\t[up to date]\nDone\n",
            "",
        );
        assert_eq!(r, PushReport::default());
    }

    #[test]
    fn code_and_open_pr_heads_are_separate_pushes() {
        let code = Refs::Code.refspecs();
        assert!(code.iter().all(|s| !s.contains("pull")));
        assert_eq!(
            Refs::PullHeads(vec![3, 7]).refspecs(),
            vec!["+refs/mirror/pull/*:refs/mirror/pull/*"]
        );
        // No PR open: still pushed, so the last closed head is pruned.
        assert_eq!(Refs::PullHeads(Vec::new()).refspecs().len(), 1);
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn local_pull_heads_follow_the_open_prs_only() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git(d, &["init", "-q"]);
        git(d, &["commit", "-q", "--allow-empty", "-m", "a"]);
        let oid = git(d, &["rev-parse", "HEAD"]);
        for n in ["1", "2", "3"] {
            git(d, &["update-ref", &format!("refs/pull/{n}/head"), &oid]);
        }
        sync_pull_heads(d, &[1, 2, 9], "refs/pull/").unwrap();
        let heads = || {
            git(
                d,
                &["for-each-ref", "--format=%(refname)", "refs/mirror/pull/"],
            )
        };
        assert_eq!(heads(), "refs/mirror/pull/1/head\nrefs/mirror/pull/2/head");
        // PR 1 closed: its head leaves the local namespace, so `--prune` deletes it.
        sync_pull_heads(d, &[2], "refs/pull/").unwrap();
        assert_eq!(heads(), "refs/mirror/pull/2/head");
    }

    /// C1 (review): the proof repository is a treeless partial clone. Asking it about an
    /// object it lacks must never fetch from the source (a promisor remote pointing at a
    /// dead address here would hang or prompt): the answer is `false`, at once.
    #[test]
    fn the_proof_repo_never_fetches_a_missing_object() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir(&src).unwrap();
        git(&src, &["init", "-q", "-b", "main"]);
        std::fs::write(src.join("f"), "x").unwrap();
        git(&src, &["add", "f"]);
        git(&src, &["commit", "-q", "-m", "a"]);
        let tip = git(&src, &["rev-parse", "HEAD"]);
        git(&src, &["config", "uploadpack.allowFilter", "true"]);
        let proof = tmp.path().join("proof.git");
        let url = format!("file://{}", src.display());
        let missing =
            fetch_proof_bases(&proof, &url, &["refs/heads/main".to_string()], true, None).unwrap();
        assert!(missing.is_empty(), "{missing:?}");
        // The promisor remote the filtered fetch recorded is gone again.
        let config = std::fs::read_to_string(proof.join("config")).unwrap();
        assert!(!config.contains("promisor"), "{config}");
        // Even if a promisor were configured (an older forge-import's proof repo), reads stay
        // local: point one at an address that can never answer.
        git(
            &proof,
            &["config", "remote.dead.url", "https://192.0.2.1/x.git"],
        );
        git(&proof, &["config", "remote.dead.promisor", "true"]);
        git(&proof, &["config", "extensions.partialClone", "dead"]);
        let started = std::time::Instant::now();
        let absent = "ab".repeat(20);
        assert!(!is_ancestor(&proof, &absent, &tip));
        assert!(is_ancestor(&proof, &tip, &tip));
        assert_eq!(local_tip(&proof, "refs/heads/nope"), None);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        // A branch the source does not have is `Gone`, not a failure.
        let gone =
            fetch_proof_bases(&proof, &url, &["refs/heads/nope".to_string()], true, None).unwrap();
        assert_eq!(gone.get("refs/heads/nope"), Some(&Unfetched::Gone));
        let failed = fetch_proof_bases(
            &proof,
            &format!("file://{}/nowhere", tmp.path().display()),
            &["refs/heads/main".to_string()],
            true,
            None,
        )
        .unwrap();
        assert_eq!(failed.get("refs/heads/main"), Some(&Unfetched::Failed));
    }

    /// D-602: the importer names a pushed base tip that contains the merge commit; this is
    /// the ancestry test it relies on (git's own, over the local mirror).
    #[test]
    fn a_merge_commit_is_contained_in_later_base_tips_only() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git(d, &["init", "-q", "-b", "main"]);
        git(d, &["commit", "-q", "--allow-empty", "-m", "base"]);
        let base = git(d, &["rev-parse", "HEAD"]);
        git(d, &["checkout", "-q", "-b", "feature"]);
        git(d, &["commit", "-q", "--allow-empty", "-m", "work"]);
        git(d, &["checkout", "-q", "main"]);
        git(d, &["commit", "-q", "--allow-empty", "-m", "other"]);
        git(
            d,
            &["merge", "-q", "--no-ff", "feature", "-m", "Merge PR #1"],
        );
        let merge = git(d, &["rev-parse", "HEAD"]);
        git(d, &["commit", "-q", "--allow-empty", "-m", "later"]);
        let later = git(d, &["rev-parse", "HEAD"]);
        assert_eq!(
            local_tip(d, "refs/heads/main").as_deref(),
            Some(later.as_str())
        );
        assert_eq!(local_tip(d, "refs/heads/gone"), None);
        assert!(
            is_ancestor(d, &merge, &later),
            "a later tip contains the merge"
        );
        assert!(is_ancestor(d, &merge, &merge), "the merge itself counts");
        assert!(!is_ancestor(d, &merge, &base), "an earlier tip does not");
        assert!(
            !is_ancestor(d, &"ab".repeat(20), &later),
            "a commit not in the mirror"
        );
    }

    /// A repository with ~200 KiB of incompressible history, like the one in F-9.
    fn repo_with_history(d: &Path) {
        git(d, &["init", "-q", "-b", "main"]);
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        let noise: Vec<u8> = (0..200 * 1024)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x.to_le_bytes()[0]
            })
            .collect();
        std::fs::write(d.join("blob.bin"), noise).unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-q", "-m", "a"]);
        git(d, &["tag", "v1"]);
    }

    /// F-9: with the pack going to your own bucket, the first push into a new repository
    /// was priced as if Platform chunks held it (~3x the real cost), so `--max-spend`
    /// refused imports it could afford. It is priced by the policy the helper will apply.
    #[test]
    fn a_fresh_push_is_priced_by_the_storage_policy() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        repo_with_history(d);
        // Profiles injected, not read from the user's config.
        let profiles = forge_core::storage::StorageProfiles::parse(
            "[profiles.bucket]\nkind = \"s3\"\nendpoint = \"https://s3.example.com\"\n\
             bucket = \"b\"\npublic_url = \"https://pub.example.com\"\n",
        )
        .unwrap();
        // The repo-local policy (it outranks any global `dash.*` of whoever runs the test).
        let storage = || {
            let policy = storage_policy(d).unwrap();
            PackStorage::resolve(&policy, &profiles)
        };
        // Every key the policy reads is set here, so a tester's global `dash.*` is ignored.
        git(d, &["config", "dash.storage", "bucket"]);
        git(d, &["config", "dash.replicas", "1"]);
        git(d, &["config", "dash.platformFallback", "false"]);
        assert_eq!(storage().unwrap(), PackStorage::External { targets: 1 });

        let platform = estimate_fresh(d, &Refs::Code, PackStorage::PLATFORM).unwrap();
        let byo = estimate_fresh(d, &Refs::Code, storage().unwrap()).unwrap();
        assert_eq!(
            (byo.refs, byo.pack_bytes),
            (platform.refs, platform.pack_bytes)
        );
        assert!(
            byo.est_credits < platform.est_credits,
            "own storage {} vs Platform {}",
            byo.est_credits,
            platform.est_credits
        );
        // Manifests and refs only.
        assert_eq!(
            byo.est_credits,
            fresh_push_credits(0, 0, 2, PackStorage::External { targets: 1 })
        );
        // A fallback to Platform keeps the Platform price (an upper bound).
        git(d, &["config", "dash.platformFallback", "true"]);
        assert_eq!(
            storage().unwrap(),
            PackStorage::Platform {
                external_targets: 1
            }
        );
        // A policy listing platform too.
        git(d, &["config", "dash.platformFallback", "false"]);
        git(d, &["config", "dash.storage", "bucket,platform"]);
        assert_eq!(
            storage().unwrap(),
            PackStorage::Platform {
                external_targets: 1
            }
        );
        // An unknown profile fails here, as the push would.
        git(d, &["config", "dash.storage", "nope"]);
        assert!(storage().is_err());
    }

    /// Traced pushes to your own storage (RustFS) on moutai, 2026-09-27, each with the
    /// measured balance drop. Both the fresh estimate and the helper-priced one must be upper
    /// bounds, within 25% for a first push into a new repository (the case the first-write
    /// fees price). (Before F-9 the fresh estimate for the first run was 0.0798 DASH, 23x what
    /// it paid.)
    #[test]
    fn own_storage_estimates_cover_recorded_pushes() {
        // refs (= ref updates), paid, first push into a new repository?
        const RUNS: &[(u64, u64, bool)] = &[
            (2, 347_730_120, true), // backports-validation-script import
            (3, 414_490_700, true), // dash-faucet import
            (1, 282_141_000, true), // one branch, `git push` into a new repo
            (1, 282_116_960, true),
            (1, 214_147_900, false), // one new commit on an existing branch
            (1, 136_108_920, false),
            (1, 214_148_780, false),
        ];
        for &(refs, paid, first) in RUNS {
            let fresh = fresh_push_credits(0, 0, refs, PackStorage::External { targets: 1 });
            let helper = fresh_push_credits(4_000, 3, refs, PackStorage::External { targets: 1 });
            let priced = price_helper_estimate(
                PushReport {
                    refs,
                    packs: 1,
                    pack_bytes: 4_000,
                    objects: 3,
                    est_credits: helper,
                    helper_credits: helper,
                    docs: 2 + refs,
                    manifests: 2,
                    ref_updates: refs,
                    chunks: 0,
                    fallback_credits: 0,
                    index_skipped: None,
                },
                false,
            )
            .est_credits;
            assert_eq!(fresh, priced, "the two prices agree");
            assert!(priced >= paid, "estimate {priced} under paid {paid}");
            if first {
                assert!(
                    priced <= paid + paid / 4,
                    "estimate {priced} vs paid {paid}"
                );
            }
        }
        // A push that only creates a ref (no pack, no `platform` event): paid 66,744,380.
        let ref_only = price_helper_estimate(
            PushReport {
                refs: 1,
                ..PushReport::default()
            },
            false,
        );
        assert!(ref_only.est_credits >= 66_744_380);
    }

    /// e2e scenario 32 live on moutai (drive 4.2.0-beta.5, 2026-09-28, `sindresorhus/is-wsl`,
    /// 10 refs, packs on Platform): the importer's estimate before each push never comes out
    /// below what the push was charged. `objects` is left at 0: the browse index only adds to
    /// an estimate, so these are the lowest the estimates could be.
    #[test]
    fn import_estimates_cover_scenario_32() {
        // Push 1: a 19,066-byte pack, failing before any ref. Charged at most 1,316,787,700
        // (the run's spend, the repository's creation included).
        let first = fresh_push_credits(19_066, 0, 10, PackStorage::PLATFORM);
        assert!(first >= 1_316_787_700, "{first}");
        // Push 2: the pack already recorded, so the refs alone; one landed for 89,014,700.
        assert!(push_fees::estimate_ref_updates(1) >= 89_014_700);
        // Push 3: the other 9 refs and a 1,183-byte pack: the balance fell 942,227,520.
        let last = fresh_push_credits(1_183, 0, 9, PackStorage::PLATFORM);
        assert!(last >= 942_227_520, "{last}");
    }

    /// The showcase rebuild on moutai beta.6 (2026-09-28): 15 first imports into new public
    /// repositories, packs on Platform, one identity each, in the order they landed. Each run
    /// charged the repository's creation, one push, and its releases and labels; what it paid
    /// is the identity's balance drop. dashpay/dash (19,107 chunks) paid 97.901210 DASH against
    /// an estimate of 97.339809: each chunk cost ~98M beyond its bytes, not the 94M priced,
    /// because every chunk insert rewrites its ancestors in forge-core's network-wide chunk
    /// tree ([`push_fees::CHUNK_PER_LEVEL`]). Every estimate must cover its charge.
    #[test]
    fn import_estimates_cover_the_beta6_showcase_imports() {
        // (pack bytes, objects, refs, releases+labels estimate, paid), all credits but bytes.
        #[rustfmt::skip]
        const RUNS: &[(u64, u64, u64, u64, u64)] = &[
            (2_492_980, 712, 5, 420_500_000, 83_408_472_560),              // dashpay/dips
            (13_808_506, 26_871, 169, 3_905_400_000, 504_183_680_440),     // psf/requests
            (20_900_383, 50_301, 623, 32_583_100_000, 815_318_105_360),    // preactjs/preact
            (5_934_182, 14_063, 288, 14_105_500_000, 244_509_209_840),     // BurntSushi/ripgrep
            (2_583_839, 8_762, 54, 9_958_000_000, 109_445_328_060),        // sharkdp/fd
            (8_456_787, 11_862, 38, 5_498_400_000, 308_048_112_020),       // jqlang/jq
            (2_085_947, 5_682, 53, 5_532_200_000, 85_874_938_920),         // sharkdp/hyperfine
            (8_795_952, 20_496, 193, 21_524_400_000, 355_049_116_060),     // junegunn/fzf
            (3_239_305, 4_407, 36, 6_485_000_000, 124_701_199_440),        // charmbracelet/glow
            (10_547_811, 4_521, 12, 471_600_000, 372_312_999_100),         // dashpay/docs-platform
            (1_174_452, 3_850, 106, 10_818_800_000, 58_204_447_320),       // dtolnay/anyhow
            (3_218_916, 9_147, 183, 19_194_400_000, 133_173_374_760),      // serde-rs/json
            (1_622_200, 3_458, 2, 336_200_000, 57_038_991_760),            // sindresorhus/awesome
            (3_240_199, 11_860, 13, 635_900_000, 129_369_646_160),         // github/gitignore
            (271_210_607, 268_021, 604, 33_291_800_000, 9_790_121_010_320), // dashpay/dash
        ];
        for &(bytes, objects, refs, collab, paid) in RUNS {
            let git = fresh_push_credits(bytes, objects, refs, PackStorage::PLATFORM);
            let estimate = crate::dest::REPO_CREATE_CREDITS + git + collab;
            #[allow(clippy::cast_precision_loss)]
            let ratio = estimate as f64 / paid as f64;
            assert!(
                estimate >= paid && ratio <= 1.35,
                "{bytes} B: estimate {estimate} vs paid {paid} ({ratio:.4})"
            );
        }
    }

    /// With `dash.platformFallback` armed, the helper's dry run prices the pack on your
    /// storage, but a push whose storage fails stores it as chunks: the estimate includes
    /// them, so the cap still holds.
    #[test]
    fn an_armed_fallback_prices_the_chunks() {
        let r = PushReport {
            refs: 1,
            packs: 1,
            pack_bytes: 200_000,
            objects: 50,
            est_credits: 320_000_000,
            helper_credits: 320_000_000,
            docs: 3,
            manifests: 2,
            ref_updates: 1,
            chunks: 0,
            fallback_credits: 0,
            index_skipped: None,
        };
        let plain = price_helper_estimate(r.clone(), false);
        let armed = price_helper_estimate(r, true);
        assert!(
            armed.est_credits >= plain.est_credits + push_fees::chunks(200_000),
            "{} vs {}",
            armed.est_credits,
            plain.est_credits
        );
        // Review M6: the helper's guard weighs the fallback chunks itself when it falls
        // back, so they are not taken off its threshold (the threshold is the budget left).
        assert_eq!(plain.overhead(), 0);
        assert_eq!(armed.overhead(), 0);
    }

    /// Review M5: a pack from a helper that reports no `platform` event is priced as the
    /// worst case (sealed, on Platform), never left at the helper's own figure.
    #[test]
    fn a_pack_without_a_platform_event_is_priced_as_the_worst_case() {
        let r = PushReport {
            refs: 2,
            packs: 1,
            pack_bytes: 50_000,
            objects: 40,
            ..PushReport::default()
        };
        let priced = price_helper_estimate(r, false);
        let public_platform = fresh_push_credits(50_000, 40, 2, PackStorage::PLATFORM);
        assert!(
            priced.est_credits > public_platform,
            "{}",
            priced.est_credits
        );
    }

    /// Review L5: a mixed policy (Platform and a bucket) names the bucket's URIs in its
    /// manifests too.
    #[test]
    fn a_mixed_policy_prices_its_external_uris() {
        let mixed = fresh_push_credits(
            1_000,
            3,
            1,
            PackStorage::Platform {
                external_targets: 2,
            },
        );
        assert_eq!(
            mixed,
            fresh_push_credits(1_000, 3, 1, PackStorage::PLATFORM)
                + 2 * 2 * push_fees::URIS_PER_TARGET
        );
    }

    #[test]
    fn the_guard_threshold_never_rounds_up_past_the_budget() {
        assert_eq!(threshold_dash(123_456_789), "0.00123456");
        assert_eq!(threshold_dash(0), "0.00000000");
    }
}
