//! Write a [`SrcCollab`] into a forge-v2 repository: diff against what the chain already
//! holds, write only the difference, and charge every write to the [`Budget`] before it is
//! signed.
//!
//! **Idempotency lives on chain, not in a state file.** An item is already mirrored when the
//! destination holds a document written by the signer (or a member) whose `imported.url` is
//! the item's key: an issue or PR carrying its source number as `upstreamNumber`, a comment
//! or review on it. State (open, closed, merged, draft) is compared with the target's state
//! code (the sum of its `transition`s), labels with the fold of its events. A re-run with
//! nothing new writes nothing and costs nothing, whatever happened to the machine (or the
//! state file) of the last run.
//!
//! **Numbers are dense.** Forge numbers issues and PRs together, each at the repo's count + 1
//! (the contract's `dense` rule), so items are created in source order (GitHub numbers issues
//! and PRs in one sequence; GitLab's are merged by creation time) and a fresh mirror of a
//! source with no deleted items numbers identically. Each keeps its source number as
//! `upstreamNumber`. An earlier item cannot be placed after later ones, so an incremental run
//! that finds one missing refuses to start ([`Sink::check_order`]).
//!
//! **Pipelined.** The creates stay one strict sequence; each item's other writes (its thread,
//! labels and state) run in up to `lanes` parallel lanes once the item is confirmed
//! ([`crate::pipeline`]). Every lane charges the same budget, and every write is admitted
//! under the ledger's lock ([`Budget::reserve`]).
//!
//! A dry run walks the same path with every write replaced by a count and an estimate.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

use forge_core::collab::v2::{ImportedTarget, PatchInput, PrBase, Provenance, Target, TargetKind};
use forge_core::collab::{CommentAnchor, Imported, ReleaseInput};
use forge_core::history::Freshness;
use forge_core::platform::PlatformClient;
use forge_core::repo::credits_to_dash;
use forge_core::rules::v2::{
    next_transition, Actor, ClosedAs, StateAction, TransitionMove, TransitionTarget, Visibility,
};
use forge_core::rules::{EventKind, MergeBaseTips};
use forge_core::scope::RepoRef;

use crate::budget::{collab_doc_credits, Budget, CollabDoc};
use crate::chain::{Chain, Current};
use crate::gitsync::{ProofRepo, Unfetched};
use crate::model::{
    same_item, same_item_renamed, SrcCloseReason, SrcCollab, SrcComment, SrcLabel, SrcRelease,
    SrcReview, SrcTarget,
};
use crate::pipeline::{lock, Progress, Stop};
use crate::sealed_release::ReleaseStorage;
use crate::summary::Counts;

/// The run's accounting: budget, counts, warnings.
pub struct Ledger<'a> {
    client: Option<&'a PlatformClient>,
    signer: Option<String>,
    dry_run: bool,
    /// The spend ledger.
    pub budget: Budget,
    /// What was (or, in a dry run, would be) written.
    pub counts: Counts,
    /// Things the user should know that did not stop the run.
    pub warnings: Vec<String>,
    /// Items (`(tk, source number)`) the destination refused this run: a content error, so
    /// retrying the same item cannot help ([`crate::state::SyncState::refused`]).
    pub refused: BTreeSet<(u8, u32)>,
    /// Something was mirrored without part of it (a release's asset it could not seal or list):
    /// the run ends `partial` and its state does not advance, so the next run tries again (as
    /// [`crate::model::SrcCollab::incomplete`] does for what the source refused to list).
    pub incomplete: bool,
}

impl<'a> Ledger<'a> {
    /// A ledger for `signer`'s writes (`None` only in a dry run without an identity).
    pub fn new(
        client: &'a PlatformClient,
        signer: Option<String>,
        dry_run: bool,
        budget: Budget,
    ) -> Self {
        Self::with_client(Some(client), signer, dry_run, budget)
    }

    /// A ledger that reads no balance itself: its sink measures through its [`Chain`].
    pub fn detached(signer: Option<String>, dry_run: bool, budget: Budget) -> Self {
        Self::with_client(None, signer, dry_run, budget)
    }

    /// A ledger with no Platform client and no signer, for the unit tests: nothing it does
    /// reads the network.
    #[cfg(test)]
    pub(crate) fn offline(dry_run: bool) -> Self {
        Self::detached(None, dry_run, Budget::new(None))
    }

    /// Whether this is a dry run (every write replaced by a count and an estimate).
    pub(crate) fn dry_run(&self) -> bool {
        self.dry_run
    }

    fn with_client(
        client: Option<&'a PlatformClient>,
        signer: Option<String>,
        dry_run: bool,
        budget: Budget,
    ) -> Self {
        Self {
            client,
            signer,
            dry_run,
            budget,
            counts: Counts::default(),
            warnings: Vec::new(),
            refused: BTreeSet::new(),
            incomplete: false,
        }
    }

    /// Record a warning (also logged). Redacted: warnings are published (the Action's job
    /// summary), and some quote URLs or errors from the source.
    pub fn warn(&mut self, msg: impl Into<String>) {
        let msg = forge_core::user_error::redact(&msg.into());
        tracing::warn!("{msg}");
        self.warnings.push(msg);
    }

    /// An item that could not be mirrored this run (its number is held by someone else,
    /// or the destination refused it): warned about, counted, never fatal to the run.
    pub fn skip(&mut self, msg: impl Into<String>) {
        self.counts.skipped += 1;
        self.warn(msg);
    }

    /// A release write that failed: one that concerns this release only (`item`: the
    /// destination refusing its content, or a rule such as `oneLive` after a concurrent
    /// publish) skips it, uncounted as written; spend-cap and network errors stop the run.
    pub(crate) fn refused_release(
        &mut self,
        tag: &str,
        e: anyhow::Error,
        item: bool,
    ) -> Result<()> {
        if !item {
            return Err(e);
        }
        self.counts.releases = self.counts.releases.saturating_sub(1);
        self.skip(format!("release {tag} not mirrored this run: {e:#}"));
        Ok(())
    }

    /// An optional git push skipped this run ([`crate::summary::Counts::git_skipped`]).
    pub fn skip_git(&mut self, msg: impl Into<String>) {
        self.counts.git_skipped += 1;
        self.warn(msg);
    }

    /// One write outside the pipeline (a sealed release: one at a time, before any issue or
    /// PR): charged to the budget first (refused past the cap, before anything is signed),
    /// counted, executed unless this is a dry run, then reconciled with the measured balance so
    /// an estimate that ran low stops the NEXT write.
    pub async fn write<T, F, Fut>(
        &mut self,
        what: String,
        credits: u64,
        count: fn(&mut Counts),
        f: F,
    ) -> Result<Option<T>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = forge_core::Result<T>>,
    {
        self.budget.charge(credits, what.clone())?;
        count(&mut self.counts);
        if self.dry_run {
            return Ok(None);
        }
        let before = self.traced_balance().await;
        let out = f().await.with_context(|| format!("writing {what}"))?;
        self.reconcile().await;
        self.trace_cost(&what, credits, before).await;
        Ok(Some(out))
    }

    /// The signer's balance, read only when the per-write cost trace is on
    /// (`RUST_LOG=forge_import::cost=debug`): it costs a query per write.
    pub async fn traced_balance(&self) -> Option<u64> {
        if !cost_traced() {
            return None;
        }
        self.balance(self.signer.as_deref()?).await
    }

    /// Log one write's estimate against its measured balance drop (calibration).
    pub async fn trace_cost(&self, what: &str, estimated: u64, before: Option<u64>) {
        trace_cost(what, estimated, before, || self.traced_balance()).await;
    }

    /// Pull the measured balance drop into the budget; whether the balance could be read.
    pub async fn reconcile(&mut self) -> bool {
        let mark = self.budget.mark();
        if let (Some(client), Some(signer)) = (self.client, &self.signer) {
            if let Ok(balance) = client.get_balance(signer).await {
                self.budget.measured(balance, mark);
                return true;
            }
        }
        false
    }

    /// `identity`'s balance now, when it can be read.
    pub async fn balance(&self, identity: &str) -> Option<u64> {
        self.client?.get_balance(identity).await.ok()
    }
}

/// Whether the per-write cost trace is on (`RUST_LOG=forge_import::cost=debug`). It reads the
/// balance around each write, which writes in flight together would blur: a traced run
/// writes one at a time.
pub fn cost_traced() -> bool {
    tracing::enabled!(target: "forge_import::cost", tracing::Level::DEBUG)
}

/// Log one write's estimate against its measured balance drop (calibration). Nodes can answer
/// from a height before the write landed, so the balance is re-read (up to ~10 s, `read`)
/// until it moves; every write costs something.
async fn trace_cost<F, Fut>(what: &str, estimated: u64, before: Option<u64>, read: F)
where
    F: Fn() -> Fut,
    Fut: Future<Output = Option<u64>>,
{
    let Some(before) = before else { return };
    let mut after = read().await;
    for _ in 0..10 {
        if after.is_some_and(|a| a != before) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        after = read().await;
    }
    if let Some(after) = after {
        tracing::debug!(
            target: "forge_import::cost",
            what,
            estimated,
            measured = before.saturating_sub(after),
            "write cost"
        );
    }
}

/// How often lanes in flight together read the balance for the spend guard: at most once in
/// this long across all of them (each read is a DAPI request). Their reservations cover the
/// writes that finished since ([`Budget::spent`]). One lane reads after every write.
const MEASURE_EVERY: Duration = Duration::from_secs(2);

/// How often the write phase logs its progress.
const PROGRESS_EVERY: Duration = Duration::from_secs(30);

/// What the sink caches while it runs (read once, or kept from what it wrote).
#[derive(Default)]
struct Caches {
    /// Every imported issue and PR in the destination, `(imported.url, target)`, whoever
    /// wrote it; loaded on the first miss of a point lookup.
    index: Option<Vec<(String, Target)>>,
    /// The destination's members (maintainers and writers), read once: an imported item by
    /// a member is an earlier mirror's copy; one by anyone else is a squatter.
    members: Option<BTreeSet<String>>,
    /// Each destination PR's base as the readers fold it, by target `$id`. Filled wherever
    /// a patch is read.
    opened: BTreeMap<String, PrBase>,
    /// Bases already re-read for read-after-write lag this run ([`BASE_LAG_WAITS`]): the lag
    /// is waited out once, not once per PR.
    lag_waited: BTreeSet<String>,
    /// PRs (destination `$id`) whose base was not a branch on chain when they were mirrored:
    /// no merge into it ever counts (D-501), so a later run cannot prove them either.
    never_provable: BTreeSet<String>,
    /// Bases this write phase has read from the network. The process's synced copy of the
    /// history may be the dry run's, from before this run's push: until a base's first read
    /// here has come back, reads ask the network (`Freshness::Now`), later ones reuse that
    /// copy.
    fresh_read: BTreeSet<String>,
    /// Each source item looked up this run, by `(tk, source number)`: its copy, or `None`
    /// when it has none (yet).
    known: BTreeMap<(u8, u32), Option<Target>>,
    /// The first source item stored at a number other than its own ([`Sink::create`]):
    /// numbers diverge from there on, said once.
    diverged: bool,
}

/// An item placed on chain (created, or found) whose other writes are still to do: a lane's
/// job ([`crate::pipeline`]).
struct Job<'s> {
    index: usize,
    t: &'s SrcTarget,
    target: Target,
    fresh: bool,
}

/// The destination and its accounting. Its methods take `&self`: the pipelined write phase
/// runs several at once, over state behind locks that are never held across an await.
pub struct Sink<'a, C: Chain> {
    chain: C,
    /// `None` only in a dry run whose destination does not exist yet.
    repo: Option<RepoRef>,
    /// Budget, counts, warnings.
    ledger: Mutex<Ledger<'a>>,
    /// The signer (copied from the ledger: read on every item).
    signer: Option<String>,
    dry_run: bool,
    /// The git data a merge commit's ancestry is checked in, when this run has any (see
    /// [`Sink::merge_proof`]).
    mirror: Option<ProofRepo>,
    caches: Mutex<Caches>,
    /// Lanes for the items' dependent writes (1: one write at a time).
    lanes: usize,
    stop: Stop,
    /// When lanes last read the balance ([`MEASURE_EVERY`]).
    measured_at: Mutex<Option<Instant>>,
    /// Held by the lane waiting out a base's read-after-write lag ([`Sink::merge_proof`]).
    lag_gate: futures::lock::Mutex<()>,
    /// Where a private destination's sealed release files and asset lists go (`None`: the
    /// storage policy names no storage of your own).
    release_storage: Option<ReleaseStorage>,
}

/// Pauses (ms) between re-reads of a base's history that does not show this run's push yet
/// (read-after-write lag across nodes): about 20 s in all.
const BASE_LAG_WAITS: &[u64] = &[1_500, 3_000, 5_000, 10_000];

/// Whether `e` concerns one item only (the destination refused its content), so the run
/// can skip it and carry on. Only the content checks of one document qualify (a field too
/// long, an illegal ref name, a malformed oid, a required field missing, a duplicate); a
/// run-level `Config` error (no identity, not a forge-v2 repo, ...) still fails the run.
fn item_error(e: &anyhow::Error) -> bool {
    const ITEM: [&str; 7] = [
        "too long",
        "illegal PR",
        "illegal retarget",
        "head oid must be",
        "is required",
        "needs a body",
        "a merge names",
    ];
    e.chain()
        .any(|c| match c.downcast_ref::<forge_core::Error>() {
            // A duplicate, a rule of the type refusing this one document (a state move the
            // target's transitions no longer allow: another client moved it first), or a value
            // of this item that does not fit (an empty title, a text over its limit).
            Some(
                forge_core::Error::DuplicateUniqueIndex(_)
                | forge_core::Error::RuleRefused { .. }
                | forge_core::Error::InvalidInput(_),
            ) => true,
            Some(forge_core::Error::Config(why)) => ITEM.iter().any(|m| why.contains(m)),
            _ => false,
        })
}

/// Whether an item error is a refusal of the item's own content (a field too long, an illegal
/// ref name, a rule of the issue / PR / comment / review type), which the same item would get
/// again: not a transition refused by a state rule after a concurrent change, a number another
/// create took, or a duplicate.
fn content_error(e: &anyhow::Error) -> bool {
    e.chain()
        .any(|c| match c.downcast_ref::<forge_core::Error>() {
            Some(forge_core::Error::RuleRefused {
                document_type,
                rule,
                ..
            }) => document_type != "transition" && rule != forge_core::rules::v2::DENSE_RULE,
            Some(forge_core::Error::Config(_) | forge_core::Error::InvalidInput(_)) => {
                item_error(e)
            }
            _ => false,
        })
}

/// The warning for a PR the source merged without naming its merge commit, when it is written
/// closed (a merge transition records an oid, D-9 names the upstream sha).
fn merged_without_sha_note(t: &SrcTarget, code: i64) -> Option<String> {
    (t.merged_without_sha && t.merged_oid.is_none() && code != 2).then(|| {
        format!(
            "{} was merged, but the source names no merge commit; recorded as closed",
            t.imported.url
        )
    })
}

/// Whether an item's state (close, reopen, merge, labels) is written after its thread: always
/// once the thread is written, and also when the destination refused a comment or review (an
/// item error: the item is skipped, and must not also be left open). Not after a spend-cap or
/// network error, which stops the run (L-46: the state comes after the thread it follows).
fn state_after(thread: &Result<()>) -> bool {
    thread.as_ref().err().is_none_or(item_error)
}

/// The state code `t` has at the source: an issue open (0) or closed (1); a PR open (0),
/// closed (1), merged (2), and a draft adds 8 unless merged.
pub(crate) fn wanted_code(t: &SrcTarget) -> i64 {
    let closed = i64::from(t.closed || t.merged_oid.is_some());
    match t.kind {
        TargetKind::Issue => closed,
        TargetKind::Patch if t.merged_oid.is_some() => 2,
        TargetKind::Patch => closed + if t.draft { 8 } else { 0 },
    }
}

/// The shortest run of transitions a member writes to take a `target` of state `from` to
/// `to` (breadth first over the legal moves, [`next_transition`]); empty when it already is
/// there, or cannot get there (a merged PR is terminal). A merge is only a step when `to` is
/// merged.
pub(crate) fn state_path(
    target: TransitionTarget,
    from: i64,
    to: i64,
    number: u32,
) -> Vec<TransitionMove> {
    use std::collections::VecDeque;
    const ACTIONS: [StateAction; 5] = [
        StateAction::Close,
        StateAction::Reopen,
        StateAction::Draft,
        StateAction::Ready,
        StateAction::Merge,
    ];
    let mut back: BTreeMap<i64, (i64, TransitionMove)> = BTreeMap::new();
    let mut queue = VecDeque::from([from]);
    while let Some(code) = queue.pop_front() {
        if code == to {
            let mut path = Vec::new();
            let mut at = to;
            while at != from {
                let (prev, mv) = back[&at];
                path.push(mv);
                at = prev;
            }
            path.reverse();
            return path;
        }
        for action in ACTIONS {
            if action == StateAction::Merge && to != 2 {
                continue;
            }
            if let Some(mv) = next_transition(target, code, action, Actor::Member, number) {
                if mv.after != from && !back.contains_key(&mv.after) {
                    back.insert(mv.after, (code, mv));
                    queue.push_back(mv.after);
                }
            }
        }
    }
    Vec::new()
}

/// The highest upstream number among `rows` written by a trusted writer (`trusted(author)`:
/// the signer or a member). A stranger may set any `upstreamNumber`, so theirs never count.
fn highest_trusted(
    rows: &[forge_core::collab::v2::ImportedRow],
    trusted: impl Fn(&str) -> bool,
) -> Option<u32> {
    rows.iter()
        .filter(|r| trusted(&r.target.author))
        .filter_map(|r| r.upstream_number)
        .max()
}

/// Whether the order check refuses the run: an incremental one that finds an earlier item
/// missing. A full run creates the missing items at the next numbers and warns.
fn order_refuses(incremental: bool, missing: &[u32]) -> bool {
    incremental && !missing.is_empty()
}

/// The source numbers among `below` (items under the highest one held, each with whether the
/// destination has its copy) that have none.
pub(crate) fn missing_below(below: &[(u32, bool)]) -> Vec<u32> {
    below
        .iter()
        .filter(|(_, has)| !has)
        .map(|(n, _)| *n)
        .collect()
}

/// The label events that take `current` to `t`'s labels.
fn label_events(t: &SrcTarget, current: &Current) -> Vec<StateEvent> {
    let add = t
        .labels
        .difference(&current.labels)
        .map(|l| (EventKind::LabelAdd, l));
    let remove = current
        .labels
        .difference(&t.labels)
        .map(|l| (EventKind::LabelRemove, l));
    add.chain(remove).map(|(k, l)| (k, l.clone())).collect()
}

/// Whether a destination document keyed `url` is the mirrored copy of the source item
/// `wanted`: the same kind, and either the signer's own (a renamed source repo still
/// matches) or a member's for the exact same repository and item. Anyone else's is a
/// squatter: its number is taken, the item is created elsewhere.
fn copy_rule(same_kind: bool, mine: bool, member: bool, url: &str, wanted: &str) -> bool {
    same_kind
        && if mine {
            same_item_renamed(url, wanted)
        } else {
            member && same_item(url, wanted)
        }
}

/// The note for the first item stored at a number other than its own.
fn diverged_note(noun: &str, t: &SrcTarget, stored: u32) -> String {
    format!(
        "upstream {noun} #{} is #{stored} here: Forge numbers issues and PRs densely, so \
         numbers differ from the source from here on (a deleted or skipped upstream item); each \
         keeps its source number as its upstream number: {}",
        t.number, t.imported.url
    )
}

/// A member label event to write: kind and label.
type StateEvent = (EventKind, String);

fn need(repo: Option<&RepoRef>) -> forge_core::Result<&RepoRef> {
    repo.ok_or_else(|| forge_core::Error::Config("no destination repository".into()))
}

/// A stand-in for a duplicate's canonical issue at the source, for [`Sink::lookup`]: its kind,
/// source number and key are all a lookup reads.
fn canonical_stub(upstream: u32, url: &str) -> SrcTarget {
    SrcTarget {
        kind: TargetKind::Issue,
        number: upstream,
        title: String::new(),
        body: String::new(),
        imported: Imported {
            url: url.to_string(),
            ..Imported::default()
        },
        closed: false,
        close_reason: None,
        merged_oid: None,
        merged_without_sha: false,
        labels: BTreeSet::new(),
        draft: false,
        patch: None,
        comments: Vec::new(),
        reviews: Vec::new(),
    }
}

/// The key [`Sink::known`] holds `t` under.
fn key_of(t: &SrcTarget) -> (u8, u32) {
    (t.kind.transition_target().code(), t.number)
}

/// A `transition`'s own property bytes (target id, number, kind, delta, asAuthor, framing),
/// before a merge's oid.
const TRANSITION_BYTES: u64 = 90;

/// Estimated bytes of a comment/review/issue document around `text`.
fn text_doc(text: &str) -> u64 {
    text.len() as u64 + 160
}

impl<'a, C: Chain> Sink<'a, C> {
    /// A sink for `repo` (see [`Ledger`]), writing one item at a time until
    /// [`Self::with_lanes`].
    pub fn new(chain: C, repo: Option<RepoRef>, ledger: Ledger<'a>) -> Self {
        Self {
            chain,
            repo,
            signer: ledger.signer.clone(),
            dry_run: ledger.dry_run,
            ledger: Mutex::new(ledger),
            mirror: None,
            caches: Mutex::new(Caches::default()),
            lanes: 1,
            stop: Stop::default(),
            measured_at: Mutex::new(None),
            lag_gate: futures::lock::Mutex::new(()),
            release_storage: None,
        }
    }

    /// Store a private destination's sealed release files and asset lists on `storage`.
    #[must_use]
    pub fn with_release_storage(mut self, storage: Option<ReleaseStorage>) -> Self {
        self.release_storage = storage;
        self
    }

    /// Check merge commits against the git data in `proof` (see [`Sink::merge_proof`]).
    #[must_use]
    pub fn with_mirror(mut self, proof: Option<ProofRepo>) -> Self {
        self.mirror = proof;
        self
    }

    /// Run the items' dependent writes in up to `lanes` lanes (1..=[`crate::pipeline::MAX_LANES`];
    /// 1 when a per-write cost trace is on, this crate's or forge-core's
    /// `DASH_FORGE_COST_TRACE=1`, which read the balance around each write).
    #[must_use]
    pub fn with_lanes(mut self, lanes: usize) -> Self {
        self.lanes = if cost_traced() || forge_core::backends::platform::pipeline_window() == 1 {
            1
        } else {
            lanes.clamp(1, crate::pipeline::MAX_LANES)
        };
        self
    }

    /// The ledger, once the sink is done.
    pub fn into_ledger(self) -> Ledger<'a> {
        self.ledger
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn ledger(&self) -> MutexGuard<'_, Ledger<'a>> {
        lock(&self.ledger)
    }

    fn caches(&self) -> MutexGuard<'_, Caches> {
        lock(&self.caches)
    }

    fn is_mine(&self, author: &str) -> bool {
        self.signer.as_deref().is_none_or(|s| s == author)
    }

    fn warn(&self, msg: impl Into<String>) {
        self.ledger().warn(msg);
    }

    /// One write: charged to the budget first (refused past the cap, before anything is
    /// signed; reserved while other lanes write), counted, executed unless this is a dry run,
    /// then reconciled with the measured balance so an estimate that ran low stops a later
    /// write. Refused once the run is stopping ([`Stop`]).
    async fn write<T, F, Fut>(
        &self,
        what: String,
        credits: u64,
        count: fn(&mut Counts),
        f: F,
    ) -> Result<Option<T>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = forge_core::Result<T>>,
    {
        self.stop.check()?;
        {
            let mut ledger = self.ledger();
            if self.dry_run {
                ledger.budget.charge(credits, what.clone())?;
            } else {
                ledger.budget.reserve(credits, what.clone())?;
            }
            count(&mut ledger.counts);
        }
        if self.dry_run {
            return Ok(None);
        }
        let before = self.traced_balance().await;
        let out = f().await;
        self.ledger().budget.finish(credits);
        self.measure(false).await;
        let out = out.with_context(|| format!("writing {what}"))?;
        trace_cost(&what, credits, before, || self.traced_balance()).await;
        Ok(Some(out))
    }

    /// The signer's balance, when the per-write cost trace is on (lanes are 1 then).
    async fn traced_balance(&self) -> Option<u64> {
        if !cost_traced() {
            return None;
        }
        self.chain.balance(self.signer.as_deref()?).await
    }

    /// Pull the measured balance drop into the budget: after every write with one lane; with
    /// more, at most every [`MEASURE_EVERY`] across them, unless `now`.
    async fn measure(&self, now: bool) {
        let Some(signer) = self.signer.as_deref() else {
            return;
        };
        if self.lanes > 1 && !now {
            let mut at = lock(&self.measured_at);
            if at.is_some_and(|t| t.elapsed() < MEASURE_EVERY) {
                return;
            }
            *at = Some(Instant::now());
        }
        let mark = self.ledger().budget.mark();
        if let Some(balance) = self.chain.balance(signer).await {
            self.ledger().budget.measured(balance, mark);
        }
    }

    /// The base tips a reader checks PR `target_id`'s merge against: the base it was opened
    /// against, at its `$createdAt` ([`pr_base_tips`], as `Collab::patch_view` folds it). A PR
    /// this run has not read was opened now (after this run's push). None without a
    /// destination (a dry run of a repo not created yet).
    async fn base_tips(
        &self,
        target_id: &str,
        base_ref: &str,
        freshness: Freshness,
    ) -> Result<MergeBaseTips> {
        let PrBase {
            ref_name: base_ref,
            opened_at,
        } = self
            .caches()
            .opened
            .get(target_id)
            .cloned()
            .unwrap_or(PrBase {
                ref_name: base_ref.to_string(),
                opened_at: u64::MAX,
            });
        let Some(repo) = self.repo.as_ref() else {
            return Ok(MergeBaseTips::default());
        };
        // One read of the repo's git history per process (`Synced`), shared by every PR of
        // the run; `Now` when this run's own push may not show yet, and for a base's first
        // read in a write phase (the synced copy may predate this run's push). Lanes that ask
        // before that first read has come back ask the network too.
        let first_write_read = !self.dry_run && !self.caches().fresh_read.contains(&base_ref);
        let freshness = if first_write_read {
            Freshness::Now
        } else {
            freshness
        };
        let tips = self
            .chain
            .merge_base(repo, &base_ref, opened_at, freshness)
            .await?;
        if first_write_read {
            self.caches().fresh_read.insert(base_ref);
        }
        Ok(tips)
    }

    /// The oid a merge event for `t` names so that every reader counts it (D-602), or `None`
    /// when no such oid can be shown.
    ///
    /// Readers count a merge whose `oid` has been a valid tip of the PR's base (the
    /// monotonic membership rule, `forge-v2.md` §3, [`pr_base_tips`]); they walk no commit
    /// graph. The source's merge commit (GitHub's `merge_commit_sha`, GitLab's merge or
    /// squash commit) is almost never a tip the mirror pushed: the base moved on before the
    /// next sync. So the importer, which has the commits, names instead the newest pushed
    /// base tip that CONTAINS the merge commit (`git merge-base --is-ancestor` in the local
    /// mirror): the membership rule then proves "reachable from the base tip" exactly. A merge
    /// into a base that is not mirrored, or deleted, or whose history dropped the merge commit
    /// has no such tip; the caller then records a close instead.
    ///
    /// A dry run is priced before this run's push, so the mirror's own base tip (which the
    /// push is about to record) stands in for the chain's newest one.
    ///
    /// A run without `code` pushes nothing: the git data is the base branches fetched for the
    /// proof ([`crate::gitsync::fetch_proof_bases`]), and only tips already on chain count.
    async fn merge_proof(&self, t: &SrcTarget, target_id: &str) -> Result<Option<Vec<u8>>> {
        let (Some(merged), Some(patch), Some(proof)) =
            (&t.merged_oid, &t.patch, self.mirror.as_ref())
        else {
            return Ok(None);
        };
        let merged = hex::encode(merged);
        let base = &patch.base_ref_name;
        if proof.unfetched.contains_key(base) {
            // Not fetched: nothing to check the merge against.
            return Ok(None);
        }
        let local = pushed_tip(proof, base, &merged);
        let (dir, pushed) = (proof.dir.clone(), proof.pushed);
        let contains = |tips: &MergeBaseTips| chain_tip_containing(&dir, tips, &merged);
        let proven = |tips: &MergeBaseTips| contains(tips).and_then(|tip| hex::decode(tip).ok());
        let mut tips = self.base_tips(target_id, base, Freshness::Synced).await?;
        let opened = self.caches().opened.get(target_id).cloned();
        // A PR opened against a base that did not exist then has no tips, and no merge into
        // it ever counts (D-501); naming one would be re-posted, and paid for, every run.
        let base_counts = tips.tip.is_some() || opened.is_none();
        // Never provable: the PR was opened against a base with no tip on chain (read from
        // chain), or this run pushes nothing and the base never had a tip, so the PR it just
        // created is opened against a base that is no branch (D-501).
        if !base_counts || (!pushed && tips.historical.is_empty()) {
            self.caches().never_provable.insert(target_id.to_string());
        }
        if self.dry_run {
            return Ok(contains(&tips)
                .or(local.filter(|_| base_counts))
                .and_then(|tip| hex::decode(tip).ok()));
        }
        // The node answering the base's history may not have seen this run's push yet: when
        // the mirror's tip contains the merge but the chain does not show that tip, re-read
        // for a while before settling for a close (which, under --state, is never revisited).
        // Only where the wait can help: a base readers count for this PR, and the same ref
        // the destination PR folds against (a PR retargeted at the source keeps its original
        // base on chain); and once per base per run.
        let settled = |tips: &MergeBaseTips| {
            contains(tips).is_some() || local.as_ref().is_none_or(|l| tips.contains(l))
        };
        if settled(&tips) {
            return Ok(proven(&tips));
        }
        // One lane waits at a time. A lane that finds another waiting reads, once that one is
        // done, the copy it brought up to date (`Synced`), as the next PR of a sequential run
        // would, instead of settling for what it read before the wait.
        let _gate = self.lag_gate.lock().await;
        tips = self.base_tips(target_id, base, Freshness::Synced).await?;
        let folded = opened
            .as_ref()
            .map_or(base.as_str(), |b| b.ref_name.as_str());
        let may_lag =
            base_counts && folded == base && !self.caches().lag_waited.contains(base.as_str());
        let waits = if may_lag { BASE_LAG_WAITS } else { &[] };
        for wait in waits {
            if settled(&tips) {
                break;
            }
            // Marked only when a wait happens: a PR whose merge the mirror lacks (no `local`)
            // must not use up the one wait a later PR on the same base may need.
            self.caches().lag_waited.insert(base.clone());
            tokio::time::sleep(Duration::from_millis(*wait)).await;
            self.chain.refs_changed();
            tips = self.base_tips(target_id, base, Freshness::Now).await?;
        }
        Ok(proven(&tips))
    }

    /// Whether `author` may have mirrored an item: the signer, or a member of the
    /// destination. Issues and PRs are ungated, so anyone else's `imported` is a claim, not a
    /// copy.
    async fn trusted(&self, author: &str) -> Result<bool> {
        if self.is_mine(author) {
            return Ok(true);
        }
        if let Some(members) = &self.caches().members {
            return Ok(members.contains(author));
        }
        let members = match &self.repo {
            Some(repo) => self
                .chain
                .members(repo)
                .await
                .context("reading the destination's members")?,
            None => BTreeSet::new(),
        };
        let trusted = members.contains(author);
        self.caches().members = Some(members);
        Ok(trusted)
    }

    /// Whether the document `target` (key `url`) is the mirrored copy of `t`: the same
    /// source item, written by the signer (a renamed source repo still matches) or by a
    /// member of the destination (exact repository only).
    async fn is_copy(&self, url: &str, target: &Target, t: &SrcTarget) -> Result<bool> {
        let mine = self.is_mine(&target.author);
        // Membership is read only when it can change the answer.
        let member = !mine
            && target.kind == t.kind
            && same_item(url, &t.imported.url)
            && self.trusted(&target.author).await?;
        Ok(copy_rule(
            target.kind == t.kind,
            mine,
            member,
            url,
            &t.imported.url,
        ))
    }

    /// Mirror everything in `src`: label definitions, releases, then issues and PRs.
    pub async fn sync(&self, src: &SrcCollab) -> Result<()> {
        if let Some(labels) = &src.labels {
            self.sync_labels(labels).await?;
        }
        if let Some(releases) = &src.releases {
            let private = self.repo.as_ref().map(|r| r.visibility) == Some(Visibility::Private);
            if private {
                self.sync_sealed_releases(releases).await?;
            } else {
                self.sync_releases(releases).await?;
            }
        }
        self.check_order(src).await?;
        self.sync_targets(&src.targets).await
    }

    /// Every issue and PR: created (or found) strictly in order, the rest of each item's
    /// writes pipelined behind ([`crate::pipeline::run`]).
    async fn sync_targets(&self, targets: &[SrcTarget]) -> Result<()> {
        let progress = Progress::new(targets.len(), PROGRESS_EVERY);
        let progress = &progress;
        let result = crate::pipeline::run(
            targets.iter().enumerate(),
            self.lanes,
            &self.stop,
            |(index, t)| async move {
                let job = self.open_target(index, t).await;
                if let Ok(job) = &job {
                    progress.placed(t.number);
                    if job.is_none() {
                        progress.completed(index, t.number);
                    }
                }
                self.say(progress, false);
                job
            },
            |job: Job<'_>| async move {
                self.finish_target(&job).await?;
                progress.completed(job.index, job.t.number);
                self.say(progress, false);
                Ok(())
            },
        )
        .await;
        if self.lanes > 1 && !self.dry_run {
            // What the lanes wrote since their last read.
            self.measure(true).await;
        }
        self.say(progress, true);
        result
    }

    /// Log the write phase's progress when a line is due.
    fn say(&self, progress: &Progress, last: bool) {
        let (written, spent) = {
            let l = self.ledger();
            (l.counts.item_documents(), l.budget.spent())
        };
        let spent = (!self.dry_run).then(|| credits_to_dash(spent));
        if let Some(line) = progress.line(last, written, spent) {
            eprintln!("{line}");
        }
    }

    /// The highest source number of `kind` the destination holds from a trusted writer (the
    /// signer or a member), or 0. A stranger can set any `upstreamNumber`, so theirs are
    /// skipped; one page usually settles it, else every one is read.
    async fn held_upstream(&self, kind: TargetKind) -> Result<u32> {
        let Some(repo) = self.repo.clone() else {
            return Ok(0);
        };
        // The first page (highest first); when it holds rows but none from a trusted writer,
        // every one. Not "a full page": unreadable rows are dropped before this sees them.
        for all in [false, true] {
            let rows = self
                .chain
                .upstream_numbered(&repo, kind, all)
                .await
                .context("reading the destination's upstream numbers")?;
            // An empty first page may be a page of unreadable rows only: read every one then.
            if rows.is_empty() && all {
                break;
            }
            let mut trusted = BTreeSet::new();
            for author in rows.iter().map(|r| r.target.author.as_str()) {
                if !trusted.contains(author) && self.trusted(author).await? {
                    trusted.insert(author.to_string());
                }
            }
            if let Some(n) = highest_trusted(&rows, |a| trusted.contains(a)) {
                return Ok(n);
            }
        }
        Ok(0)
    }

    /// Refuse, before anything is written, an incremental run (`--state`) that would create
    /// an item below one the destination already holds: numbers are dense, so it would land
    /// after later items and the mirror's numbers would stop following the source's, and the
    /// run could not tell whether other earlier items are missing too. A full run creates
    /// such an item at the next number and says so.
    ///
    /// An item the destination refused before ([`SrcCollab::refused`]) is not called missing:
    /// the same content error would refuse it again, and it must not stop every later run.
    ///
    /// The check is per kind: GitHub numbers issues and PRs in one sequence, but a new issue
    /// below the highest mirrored PR (or the reverse) is not caught here; it takes the next
    /// number, and its upstream number stays with it.
    async fn check_order(&self, src: &SrcCollab) -> Result<()> {
        for kind in [TargetKind::Issue, TargetKind::Patch] {
            let held = self.held_upstream(kind).await?;
            let mut below = Vec::new();
            for t in src
                .targets
                .iter()
                .filter(|t| t.kind == kind && t.number < held)
            {
                if !src.refused.contains(&key_of(t)) {
                    below.push((t.number, self.existing(t).await?.is_some()));
                }
            }
            let missing = missing_below(&below);
            let Some(first) = missing.first() else {
                continue;
            };
            let noun = kind.noun();
            if order_refuses(src.incremental, &missing) {
                anyhow::bail!(
                    "refusing this incremental run: upstream {noun} #{first} (and {} more) is \
                     not mirrored, but #{held} already is. Forge numbers issues and PRs \
                     densely, so an earlier item cannot be placed before later ones, and an \
                     incremental run cannot tell what else is missing. Run once without \
                     --state (a full scan): it mirrors every missing item at the next number, \
                     keeping its source number as its upstream number",
                    missing.len() - 1
                );
            }
            self.warn(format!(
                "{} upstream {noun}(s) from #{first} are mirrored after #{held}: Forge \
                 numbers densely, so they take the next numbers (each keeps its source number \
                 as its upstream number)",
                missing.len()
            ));
        }
        Ok(())
    }

    // --- labels and releases -----------------------------------------------------------

    async fn sync_labels(&self, labels: &[SrcLabel]) -> Result<()> {
        let existing: BTreeMap<String, (String, String, bool)> = match &self.repo {
            Some(repo) => self
                .chain
                .labels(repo)
                .await
                .context("reading the destination's labels")?
                .into_iter()
                .map(|l| {
                    let c = l.color.to_ascii_lowercase();
                    (l.name, (c, l.description, l.retired))
                })
                .collect(),
            None => BTreeMap::new(),
        };
        let (chain, repo) = (&self.chain, self.repo.as_ref());
        // Two source labels that clip to the same name would rewrite one definition on every
        // run; the first wins.
        let mut seen = BTreeSet::new();
        for l in labels.iter().filter(|l| seen.insert(l.name.clone())) {
            if existing.get(&l.name) == Some(&(l.color.clone(), l.description.clone(), false)) {
                continue;
            }
            let credits = collab_doc_credits(
                CollabDoc::Label,
                (l.name.len() + l.color.len() + l.description.len() + 60) as u64,
            );
            self.write(
                format!("label {}", l.name),
                credits,
                |c| c.labels += 1,
                || async move {
                    chain
                        .create_label(need(repo)?, &l.name, &l.color, &l.description)
                        .await
                },
            )
            .await?;
        }
        Ok(())
    }

    /// Mirror the releases. Each asset records the SHA-256 readers verify it against: the
    /// source's digest, the hash already recorded for the same file, or one computed from
    /// its bytes ([`crate::assets`], D-517). A release recorded by an older import with no
    /// hash is therefore republished once, with it.
    ///
    /// Hashed newest first, so a run's hashing budget goes to the releases people download;
    /// written oldest first (sources list newest first), so the documents' `$createdAt`
    /// follows the releases' own order; readers order by version anyway (L-14). Every release is
    /// hashed (up to [`crate::assets::RUN_BYTES`] downloaded) before the first is written, so a
    /// run interrupted while hashing writes none; the next run finds the same work to do.
    ///
    /// A release listing more assets than its 4096-byte field holds keeps the checksum files,
    /// signatures and common platform builds first ([`crate::model::fit_assets`]), and its
    /// notes end with a line saying how many are not mirrored, linking the source release
    /// ([`crate::model::notes_with_footer`]), which readers show.
    async fn sync_releases(&self, releases: &[SrcRelease]) -> Result<()> {
        let mut known = crate::assets::Known::default();
        let existing: BTreeMap<String, String> = match &self.repo {
            Some(repo) => self
                .chain
                .releases(repo)
                .await
                .context("reading the destination's releases")?
                .into_iter()
                .map(|r| {
                    known.add(&r.tag_name, &r.assets);
                    let assets = serde_json::to_string(&r.assets).unwrap_or_default();
                    (r.tag_name, fingerprint(&r.name, &r.notes, &assets))
                })
                .collect(),
            None => BTreeMap::new(),
        };
        let fetch = crate::assets::Https::default();
        let mut budget = crate::assets::RUN_BYTES;
        let dry = self.dry_run;
        // Newest first (the source's order): the hashing budget goes to the newest releases.
        let mut prepared = Vec::with_capacity(releases.len());
        for r in releases {
            // A tag the destination would refuse (over 63 bytes, or outside the git ref
            // grammar the contract enforces, `@{` included) skips that release, not the run.
            if let Err(e) = forge_core::collab::v2::check_tag_name(&r.tag_name) {
                self.ledger().skip(format!("release not mirrored: {e}"));
                continue;
            }
            let mut assets_in = r.assets.clone();
            for w in crate::assets::fill_hashes(
                &r.tag_name,
                &mut assets_in,
                &known,
                &fetch,
                !dry,
                &mut budget,
            )
            .await
            {
                self.warn(w);
            }
            if dry {
                // Priced, not fetched: an asset a real run would hash changes the release.
                for a in assets_in.iter_mut().filter(|a| a.sha256.is_empty()) {
                    a.sha256 = "0".repeat(64);
                }
            }
            prepared.push((r, assets_in));
        }
        for (r, assets_in) in prepared.into_iter().rev() {
            let total = r.omitted.len() + assets_in.len();
            let assets_in = crate::model::fit_assets(assets_in);
            let dropped = total - assets_in.len();
            let notes = crate::model::notes_with_footer(&r.notes, dropped, total, &r.source_url);
            let assets = serde_json::to_string(&assets_in).unwrap_or_default();
            if existing.get(&r.tag_name) == Some(&fingerprint(&r.name, &notes, &assets)) {
                continue;
            }
            // Counted and warned for the releases this run writes (a re-run that finds them
            // unchanged says nothing again).
            let unhashed = assets_in.iter().filter(|a| a.sha256.is_empty()).count();
            {
                let mut ledger = self.ledger();
                ledger.counts.assets_omitted += dropped as u64;
                ledger.counts.assets_unhashed += unhashed as u64;
            }
            if dropped > 0 {
                self.warn(format!(
                    "release {}: {dropped} of its {total} assets do not fit the 4096 bytes a \
                     release lists; left out (kept first: checksum files, signatures, the \
                     common platform builds; its notes link the source release)",
                    r.tag_name
                ));
            }
            let credits = collab_doc_credits(
                CollabDoc::Release,
                (r.tag_name.len() + r.name.len() + notes.len() + assets.len() + 40) as u64,
            );
            let input = ReleaseInput {
                tag_name: r.tag_name.clone(),
                name: r.name.clone(),
                notes,
                yanked: Some(false),
                assets: assets_in,
                ..ReleaseInput::default()
            };
            let (chain, repo) = (&self.chain, self.repo.as_ref());
            let input = &input;
            let written = self
                .write(
                    format!("release {}", r.tag_name),
                    credits,
                    |c| c.releases += 1,
                    || async move { chain.create_release(need(repo)?, input).await },
                )
                .await;
            if let Err(e) = written {
                let item = item_error(&e);
                self.ledger().refused_release(&r.tag_name, e, item)?;
            }
        }
        Ok(())
    }

    /// A private destination's releases, sealed ([`crate::sealed_release`]), their files and
    /// asset lists stored on the run's release storage. They are written before any issue or
    /// PR, one at a time, so the ledger is taken out of its lock for them and put back after.
    async fn sync_sealed_releases(&self, releases: &[SrcRelease]) -> Result<()> {
        let Some(repo) = self.repo.as_ref() else {
            return Ok(());
        };
        let placeholder = Ledger::detached(self.signer.clone(), self.dry_run, Budget::new(None));
        let mut ledger = std::mem::replace(&mut *self.ledger(), placeholder);
        let result = self
            .chain
            .sync_sealed_releases(&mut ledger, repo, releases, self.release_storage.as_ref())
            .await;
        *self.ledger() = ledger;
        result
    }

    // --- issues and pull requests --------------------------------------------------------

    /// An error that only concerns item `t` (the destination refused its content) skips it
    /// with a warning instead of failing the run, so one bad item cannot stop every future
    /// run; spend-cap and network errors still stop the run.
    fn item_skipped(&self, t: &SrcTarget, e: anyhow::Error) -> Result<()> {
        if !item_error(&e) {
            return Err(e);
        }
        let mut ledger = self.ledger();
        ledger.skip(format!("{} not mirrored this run: {e:#}", t.imported.url));
        // Only a refusal of the item's own content is final for it; a state move a
        // concurrent change beat (a `c*` rule) or a taken number is retried next run.
        if content_error(&e) {
            ledger.refused.insert(key_of(t));
        }
        Ok(())
    }

    /// The head's part of item `t` (number `index` in the run): find its copy, or create it at
    /// the dense next number. `None` when nothing more is written for it.
    async fn open_target<'s>(&self, index: usize, t: &'s SrcTarget) -> Result<Option<Job<'s>>> {
        self.open_target_inner(index, t)
            .await
            .or_else(|e| self.item_skipped(t, e).map(|()| None))
    }

    async fn open_target_inner<'s>(
        &self,
        index: usize,
        t: &'s SrcTarget,
    ) -> Result<Option<Job<'s>>> {
        let noun = t.kind.noun();
        let (target, fresh) = if let Some(target) = self.existing(t).await? {
            (target, false)
        } else {
            let target = self.create(t, noun).await?;
            let mut caches = self.caches();
            if let Some(idx) = &mut caches.index {
                idx.push((t.imported.url.clone(), target.clone()));
            }
            caches.known.insert(key_of(t), Some(target.clone()));
            (target, true)
        };
        if !fresh && !self.is_mine(&target.author) {
            // A member mirrored this item (an earlier mirror identity, or a second mirror):
            // writing to it, or recreating it at a new number, would duplicate it. (A
            // non-member's claim never gets here: it is a squatter, and the item is created
            // at another number.) Settled: the member's copy is permanent, so it does not hold
            // the sync state (a mirror identity rotated would otherwise hold it for good).
            self.warn(format!(
                "{noun} #{} is already mirrored by {} (as #{}); not mirrored again",
                t.number, target.author, target.number
            ));
            return Ok(None);
        }
        Ok(Some(Job {
            index,
            t,
            target,
            fresh,
        }))
    }

    /// A lane's part of an item: its thread, then its state.
    async fn finish_target(&self, job: &Job<'_>) -> Result<()> {
        self.finish_target_inner(job)
            .await
            .or_else(|e| self.item_skipped(job.t, e))
    }

    async fn finish_target_inner(&self, job: &Job<'_>) -> Result<()> {
        let Job {
            t, target, fresh, ..
        } = job;
        let current = if *fresh {
            Current::default()
        } else {
            self.current(target).await?
        };
        // The thread first, then the state: readers order a target's timeline by `$createdAt`,
        // and at the source a close (or merge) comes after the comments that led to it (L-46).
        // A comment or review the destination refuses (an item error, which skips this item)
        // still lets the state be written, as it was before this order: a skip must not also
        // leave the item open.
        let thread = self.sync_thread(t, target, *fresh).await;
        if state_after(&thread) {
            self.sync_state(t, target, &current).await?;
        }
        thread
    }

    /// An item's comments and (a PR's) reviews, as one stream in source time order
    /// ([`thread_order`]): a review just before the first of its comments, so each comment can
    /// name it (`reviewId`), and a reply after the comment it replies to (`replyTo`).
    async fn sync_thread(&self, t: &SrcTarget, target: &Target, fresh: bool) -> Result<()> {
        let reviews: &[SrcReview] = if t.kind == TargetKind::Patch {
            &t.reviews
        } else {
            &[]
        };
        if t.comments.is_empty() && reviews.is_empty() {
            return Ok(());
        }
        // What this signer already wrote on the thread, by source URL: skipped, and (by its
        // `$id`) what a later comment names.
        let (mut comment_ids, mut review_ids) = (Vec::new(), Vec::new());
        if !fresh {
            let repo = need(self.repo.as_ref())?;
            if !t.comments.is_empty() {
                comment_ids = self.done_by_me(self.chain.comments(repo, &target.id).await?);
            }
            if !reviews.is_empty() {
                review_ids = self.done_by_me(self.chain.reviews(repo, &target.id).await?);
            }
        }
        for step in thread_order(&t.comments, reviews) {
            match step {
                Step::Review(r) => {
                    if find_id(&review_ids, &r.imported.url).is_some() {
                        continue;
                    }
                    // The comments that will name it: those not on chain yet (one written
                    // before this review cannot name it).
                    let count = t
                        .comments
                        .iter()
                        .filter(|c| c.review_key.as_deref() == Some(r.imported.url.as_str()))
                        .filter(|c| find_id(&comment_ids, &c.imported.url).is_none())
                        .count();
                    let count = u16::try_from(count).unwrap_or(u16::MAX);
                    if let Some(id) = self.write_review(t, target, r, count).await? {
                        review_ids.push((r.imported.url.clone(), id));
                    }
                }
                Step::Comment(c) => {
                    if find_id(&comment_ids, &c.imported.url).is_some() {
                        continue;
                    }
                    let mut anchor = c.anchor.clone();
                    let reply_to = c
                        .reply_key
                        .as_deref()
                        .and_then(|k| find_id(&comment_ids, k));
                    let review_id = c
                        .review_key
                        .as_deref()
                        .and_then(|k| find_id(&review_ids, k));
                    if reply_to.is_some() || review_id.is_some() {
                        let a = anchor.get_or_insert_with(CommentAnchor::default);
                        a.reply_to = reply_to.map(str::to_string);
                        a.review_id = review_id.map(str::to_string);
                    }
                    if let Some(id) = self.write_comment(t, target, c, anchor.as_ref()).await? {
                        comment_ids.push((c.imported.url.clone(), id));
                    }
                }
            }
        }
        Ok(())
    }

    /// Every imported issue and PR already in the destination, by its `imported.url` key:
    /// each `issue` / `patch` of the repo that carries provenance, whoever wrote it. One
    /// complete read per kind, so an item is found wherever it landed; read only when its
    /// upstream number is held by a document that is not its copy.
    async fn load_index(&self) -> Result<()> {
        if self.caches().index.is_some() {
            return Ok(());
        }
        let mut index = Vec::new();
        let mut opened = Vec::new();
        if let Some(repo) = &self.repo {
            let targets = self
                .chain
                .imported_targets(repo)
                .await
                .context("reading the destination's issues and pull requests")?;
            for row in targets {
                if let Some(b) = row.base {
                    opened.push((row.target.id.clone(), b));
                }
                if let Some(i) = row.imported.filter(|i| !i.url.is_empty()) {
                    index.push((i.url, row.target));
                }
            }
        }
        let mut caches = self.caches();
        caches.opened.extend(opened);
        caches.index = Some(index);
        Ok(())
    }

    /// The existing mirrored target for `t`, if any (tolerating a renamed source repo),
    /// looked up once per run. The `upstream (repoId, upstreamNumber)` index first (one read);
    /// the full `imported.url` index only when that number is held by something that is not
    /// its copy (a stranger can write any `upstreamNumber`).
    async fn existing(&self, t: &SrcTarget) -> Result<Option<Target>> {
        if let Some(k) = self.caches().known.get(&key_of(t)) {
            return Ok(k.clone());
        }
        let found = self.lookup(t).await?;
        self.caches().known.insert(key_of(t), found.clone());
        Ok(found)
    }

    async fn lookup(&self, t: &SrcTarget) -> Result<Option<Target>> {
        if self.caches().index.is_none() {
            let Some(repo) = self.repo.as_ref() else {
                return Ok(None);
            };
            let rows = self.chain.upstream_targets(repo, t.kind, t.number).await?;
            if rows.is_empty() {
                return Ok(None);
            }
            for row in rows {
                if let Some(b) = &row.base {
                    self.caches()
                        .opened
                        .insert(row.target.id.clone(), b.clone());
                }
                if let Some(i) = row.imported.filter(|i| !i.url.is_empty()) {
                    if self.is_copy(&i.url, &row.target, t).await? {
                        return Ok(Some(row.target));
                    }
                }
            }
        }
        self.load_index().await?;
        self.indexed(t).await
    }

    /// `t` in the full index (when loaded): the first entry that is its copy.
    async fn indexed(&self, t: &SrcTarget) -> Result<Option<Target>> {
        let candidates: Vec<(String, Target)> = self
            .caches()
            .index
            .as_ref()
            .map(|idx| {
                idx.iter()
                    .filter(|(url, target)| {
                        target.kind == t.kind && same_item_renamed(url, &t.imported.url)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        for (url, target) in candidates {
            if self.is_copy(&url, &target, t).await? {
                return Ok(Some(target));
            }
        }
        Ok(None)
    }

    /// Create `t` at the repo's dense next number ([`Collab::create_imported`]: it counts
    /// again when another create took the number first), with its provenance and its source
    /// number as `upstreamNumber`. In a dry run the returned target is a placeholder at the
    /// source number (nothing reads it).
    async fn create(&self, t: &SrcTarget, noun: &str) -> Result<Target> {
        let placeholder = Target {
            kind: t.kind,
            id: String::new(),
            number: t.number,
            author: self.signer.clone().unwrap_or_default(),
        };
        let credits = collab_doc_credits(
            CollabDoc::Target,
            text_doc(&t.title) + t.body.len() as u64 + t.imported.url.len() as u64 + 100,
        );
        let (chain, repo) = (&self.chain, self.repo.as_ref());
        let what = format!("{noun} #{}", t.number);
        let from = Provenance {
            imported: Some(&t.imported),
            upstream_number: Some(t.number),
        };
        let input = t.patch.as_ref().map(|p| PatchInput {
            title: t.title.clone(),
            body: t.body.clone(),
            base_ref_name: p.base_ref_name.clone(),
            source_repo_id: repo.map(|r| r.id().to_string()).unwrap_or_default(),
            source_ref_name: p.source_ref_name.clone(),
            head_oid: p.head_oid.clone(),
            patch_manifest_hash: None,
            draft: false,
        });
        let doc = match (t.kind, &input) {
            (TargetKind::Patch, Some(input)) => ImportedTarget::Patch(input),
            _ => ImportedTarget::Issue {
                title: &t.title,
                body: &t.body,
            },
        };
        let count: fn(&mut Counts) = match t.kind {
            TargetKind::Issue => |c| c.issues += 1,
            TargetKind::Patch => |c| c.prs += 1,
        };
        let out = self
            .write(what, credits, count, || async move {
                chain.create_imported(need(repo)?, doc, from).await
            })
            .await?;
        let Some(created) = out else {
            return Ok(placeholder);
        };
        if created.number != t.number {
            let first = !std::mem::replace(&mut self.caches().diverged, true);
            if first {
                self.warn(diverged_note(noun, t, created.number));
            }
        }
        Ok(Target {
            id: created.document_id,
            number: created.number,
            ..placeholder
        })
    }

    /// `target`'s state on chain: its state code (the sum of its transitions; "merged" is the
    /// chain fact, D-9) and its labels as every reader folds them.
    async fn current(&self, target: &Target) -> Result<Current> {
        let repo = need(self.repo.as_ref())?;
        Ok(self.chain.current(repo, target).await?)
    }

    /// The commit a merge transition for `t` names: a pushed base tip containing the source's
    /// merge commit when there is one ([`Sink::merge_proof`]), so readers find it on the base;
    /// else the source's merge commit itself. A merge is recorded either way (D-9: "merged"
    /// is what a member recorded); readers label one whose commit is not on the base.
    async fn merge_oid(&self, t: &SrcTarget, target: &Target) -> Result<Vec<u8>> {
        let upstream = t.merged_oid.clone().unwrap_or_default();
        if let Some(tip) = self.merge_proof(t, &target.id).await? {
            return Ok(tip);
        }
        let base = t.patch.as_ref().map_or("?", |p| p.base_ref_name.as_str());
        let never_provable = self.caches().never_provable.contains(&target.id);
        let reason = if never_provable {
            format!(
                "its base {base} was not a branch on chain when it was mirrored (forge-v2 §6, \
                 D-501: push the code before the issues and PRs)"
            )
        } else {
            no_proof_reason(self.mirror.as_ref(), base)
        };
        let mut ledger = self.ledger();
        ledger.counts.unproved_merges += 1;
        ledger.warn(format!(
            "{} was merged; recorded as merged with the source's merge commit {}, which readers \
             label as not found on the base: {reason}",
            t.imported.url,
            hex::encode(&upstream)
        ));
        Ok(upstream)
    }

    /// Bring `target` to `t`'s state: label events for the labels that differ, then the
    /// transitions ([`state_path`]) from its state code to the source's ([`wanted_code`]).
    /// Idempotent: a target already in that state takes nothing, and a merged one is final.
    async fn sync_state(&self, t: &SrcTarget, target: &Target, current: &Current) -> Result<()> {
        let moves = state_path(
            t.kind.transition_target(),
            current.code,
            wanted_code(t),
            target.number,
        );
        if let Some(note) = merged_without_sha_note(t, current.code) {
            self.warn(note);
        }
        let merges = moves
            .iter()
            .any(|m| m.kind == forge_core::rules::transition::PR_MERGE);
        let merge_oid = if merges {
            Some(self.merge_oid(t, target).await?)
        } else {
            None
        };
        let (chain, repo) = (&self.chain, self.repo.as_ref());
        for (kind, value) in label_events(t, current) {
            let credits = collab_doc_credits(CollabDoc::Event, 120 + value.len() as u64);
            let what = format!("{kind:?} event on #{}", t.number);
            let value = value.as_str();
            self.write(
                what,
                credits,
                |c| c.events += 1,
                || async move { chain.post_event(need(repo)?, target, kind, value).await },
            )
            .await?;
        }
        // The close that ends the path says why (QW-069): an issue's closing move.
        let has_close = moves
            .iter()
            .any(|m| m.kind == forge_core::rules::transition::ISSUE_CLOSE);
        let reason = match &t.close_reason {
            Some(r) if has_close => Some(self.closed_as(t, target, r).await?),
            _ => None,
        };
        for mv in moves {
            let oid = (mv.kind == forge_core::rules::transition::PR_MERGE)
                .then_some(merge_oid.as_deref())
                .flatten();
            let closed = reason
                .as_ref()
                .filter(|_| mv.kind == forge_core::rules::transition::ISSUE_CLOSE);
            let reason_bytes =
                closed.map_or(0, |c| 2 + if c.duplicate_of.is_some() { 5 } else { 0 });
            let credits = collab_doc_credits(
                CollabDoc::Transition,
                TRANSITION_BYTES + oid.map_or(0, <[u8]>::len) as u64 + reason_bytes,
            );
            let what = format!("kind-{} transition on #{}", mv.kind, t.number);
            self.write(
                what,
                credits,
                |c| c.transitions += 1,
                || async move {
                    chain
                        .write_transition(need(repo)?, target, &mv, oid, closed)
                        .await
                },
            )
            .await?;
        }
        Ok(())
    }

    /// `t`'s close reason as the mirror records it: a duplicate's canonical as its number in
    /// the destination, when its copy is there (this run's, or an earlier one's); otherwise a
    /// duplicate without one, and the run says so. Items are created in source order, so a
    /// canonical numbered after its duplicate is not there yet on a first import, and the
    /// close (immutable) never names it: a rare shape (a duplicate usually names an older issue)
    /// kept over leaving the item open until a later run.
    async fn closed_as(
        &self,
        t: &SrcTarget,
        target: &Target,
        r: &SrcCloseReason,
    ) -> Result<ClosedAs> {
        let Some((upstream, url)) = &r.duplicate_of else {
            return Ok(ClosedAs {
                reason: r.reason,
                duplicate_of: None,
            });
        };
        let key = (TargetKind::Issue.transition_target().code(), *upstream);
        let known = self.caches().known.get(&key).cloned().flatten();
        let canonical = match known {
            Some(c) => Some(c),
            None if self.repo.is_some() => self.lookup(&canonical_stub(*upstream, url)).await?,
            None => None,
        };
        let duplicate_of = canonical
            .filter(|c| c.kind == TargetKind::Issue && c.number != target.number)
            .map(|c| c.number);
        if duplicate_of.is_none() && !self.dry_run {
            self.warn(format!(
                "{} was closed as a duplicate of {url}, which is not mirrored (yet): it is \
                 recorded as a duplicate without naming it",
                t.imported.url
            ));
        }
        Ok(ClosedAs {
            reason: r.reason,
            duplicate_of,
        })
    }

    /// The documents already on a thread written by the signer: `(source URL, $id)`.
    fn done_by_me(&self, written: Vec<crate::chain::Written>) -> Vec<(String, String)> {
        written
            .into_iter()
            .filter(|w| self.is_mine(&w.author))
            .filter_map(|w| Some((w.url?, w.id)))
            .collect()
    }

    /// Write one comment of `t`'s thread (`anchor`: its own, with the reply and review the
    /// sink found); its `$id`, `None` in a dry run.
    async fn write_comment(
        &self,
        t: &SrcTarget,
        target: &Target,
        c: &SrcComment,
        anchor: Option<&CommentAnchor>,
    ) -> Result<Option<String>> {
        let (chain, repo) = (&self.chain, self.repo.as_ref());
        let hunk = anchor
            .and_then(|a| a.diff_hunk.as_ref())
            .map_or(0, |h| h.len() as u64 + 3);
        let ids = anchor.map_or(0, |a| {
            32 * (u64::from(a.reply_to.is_some()) + u64::from(a.review_id.is_some()))
        });
        let credits = collab_doc_credits(
            CollabDoc::Comment,
            text_doc(&c.body) + c.imported.url.len() as u64 + hunk + ids,
        );
        self.write(
            format!("comment on #{}", t.number),
            credits,
            |n| n.comments += 1,
            || async move {
                chain
                    .comment(need(repo)?, &target.id, &c.body, anchor, &c.imported)
                    .await
            },
        )
        .await
    }

    /// Write one review of `t`, announcing the `count` comments that name it; its `$id`,
    /// `None` in a dry run.
    async fn write_review(
        &self,
        t: &SrcTarget,
        target: &Target,
        r: &SrcReview,
        count: u16,
    ) -> Result<Option<String>> {
        let (chain, repo) = (&self.chain, self.repo.as_ref());
        let credits = collab_doc_credits(
            CollabDoc::Review,
            text_doc(&r.body) + r.imported.url.len() as u64 + 40 + if count > 0 { 3 } else { 0 },
        );
        let count = (count > 0).then_some(count);
        self.write(
            format!("review on #{}", t.number),
            credits,
            |n| n.reviews += 1,
            // Always a comment verdict ([`Chain::review`]): the mirror identity is a member,
            // and a member's approve / request-changes counts (§6); a source reviewer's
            // verdict must not become one. It is in the body.
            || async move {
                chain
                    .review(
                        need(repo)?,
                        &target.id,
                        &r.commit_oid,
                        &r.body,
                        count,
                        &r.imported,
                    )
                    .await
            },
        )
        .await
    }
}

/// One write of a thread, in [`thread_order`].
enum Step<'t> {
    Comment(&'t SrcComment),
    Review(&'t SrcReview),
}

/// The `$id` of the document already written for source key `url` (a renamed source repo still
/// matches).
fn find_id<'w>(written: &'w [(String, String)], url: &str) -> Option<&'w str> {
    written
        .iter()
        .find(|(u, _)| same_item_renamed(u, url))
        .map(|(_, id)| id.as_str())
}

/// A thread's comments and reviews in the order they are written: by source time, a review
/// placed just before the first of its comments (a pending review's comments predate its
/// submission), and at the same time a review with comments first, then the comments (each
/// reply after the root it names, which GitHub dates earlier), then the reviews without any.
/// The comments keep their source order among themselves.
fn thread_order<'t>(comments: &'t [SrcComment], reviews: &'t [SrcReview]) -> Vec<Step<'t>> {
    let mut steps: Vec<(u64, u8, usize, Step<'t>)> = comments
        .iter()
        .enumerate()
        .map(|(i, c)| (c.imported.created_at, 1, i, Step::Comment(c)))
        .collect();
    for (i, r) in reviews.iter().enumerate() {
        let first = comments
            .iter()
            .filter(|c| c.review_key.as_deref() == Some(r.imported.url.as_str()))
            .map(|c| c.imported.created_at)
            .min();
        let (at, rank) = match first {
            Some(f) => (f.min(r.imported.created_at), 0),
            None => (r.imported.created_at, 2),
        };
        steps.push((at, rank, i, Step::Review(r)));
    }
    // Comments are in source order already: only the reviews move.
    steps.sort_by_key(|&(at, rank, i, _)| (at, rank, i));
    steps.into_iter().map(|(_, _, _, s)| s).collect()
}

/// The mirror's own tip of `base` when it contains `merged`: a run that pushes (`code`) puts
/// it on chain (a dry run is priced before that push, so it stands in for the chain's newest
/// tip there). `None` for a run that pushes nothing: only tips already on chain count then.
fn pushed_tip(proof: &ProofRepo, base: &str, merged: &str) -> Option<String> {
    if !proof.pushed {
        return None;
    }
    crate::gitsync::local_tip(&proof.dir, base)
        .filter(|tip| crate::gitsync::is_ancestor(&proof.dir, merged, tip))
}

/// The newest base tip on chain that contains `merged`, by ancestry in `proof`'s git data:
/// the oid a merge event names so that every reader counts it (D-602).
fn chain_tip_containing(dir: &Path, tips: &MergeBaseTips, merged: &str) -> Option<String> {
    tips.historical
        .iter()
        .rev()
        .find(|tip| crate::gitsync::is_ancestor(dir, merged, tip))
        .cloned()
}

/// Why a merged PR into `base` has no merge proof, for its warning.
fn no_proof_reason(proof: Option<&ProofRepo>, base: &str) -> String {
    match proof {
        None => "this run has no git data to check the merge commit against (the base \
                 branches could not be fetched; see the warnings)"
            .into(),
        Some(p) => match p.unfetched.get(base) {
            Some(Unfetched::Gone) => format!("its base {base} is no longer at the source"),
            Some(Unfetched::Failed) => format!(
                "its base {base} could not be fetched from the source this run (a later run \
                 tries again)"
            ),
            None if p.pushed => format!(
                "no mirrored tip of its base {base} contains the merge commit (the base is not \
                 mirrored, or was deleted)"
            ),
            None => format!(
                "no tip of its base {base} on chain contains the merge commit (this run syncs \
                 no `code`: push the code first; the next run tries again)"
            ),
        },
    }
}

fn fingerprint(name: &str, notes: &str, assets: &str) -> String {
    format!("{name}\0{notes}\0{assets}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stranger_squatting_an_imported_url_is_not_the_mirror_copy() {
        let ours = "https://github.com/o/r/issues/12";
        // A non-member's document claiming our item (even the exact URL) is a squatter.
        assert!(!copy_rule(true, false, false, ours, ours));
        // A member's copy of the same repository's item counts; another repo's #12 does not.
        assert!(copy_rule(true, false, true, ours, ours));
        assert!(!copy_rule(
            true,
            false,
            true,
            "https://github.com/attacker/x/issues/12",
            ours
        ));
        // The signer's own copy survives a renamed source repository.
        assert!(copy_rule(
            true,
            true,
            false,
            "https://github.com/old/name/issues/12",
            ours
        ));
        // Never across kinds.
        assert!(!copy_rule(false, true, true, ours, ours));
    }
    use forge_core::collab::Imported;

    fn target(kind: TargetKind) -> SrcTarget {
        SrcTarget {
            kind,
            number: 1,
            title: "t".into(),
            body: "b".into(),
            imported: Imported::default(),
            closed: false,
            close_reason: None,
            merged_oid: None,
            merged_without_sha: false,
            labels: BTreeSet::new(),
            draft: false,
            patch: None,
            comments: Vec::new(),
            reviews: Vec::new(),
        }
    }

    #[test]
    fn state_follows_the_thread_even_past_a_refused_comment() {
        assert!(state_after(&Ok(())));
        let refused =
            anyhow::Error::from(forge_core::Error::Config("comment body too long".into()));
        assert!(state_after(&Err(refused)));
        let stop = anyhow::anyhow!("--max-spend reached");
        assert!(!state_after(&Err(stop)));
    }

    fn git(dir: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
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

    /// The showcase rebuild (beta.6): a `--sync issues,prs,labels` pass after the code import
    /// recorded every merged PR as closed, because the sink had no git data without `code`.
    /// Now it is given the base branch fetched from the source (treeless, as the importer does
    /// with no `--work-dir` mirror) and names the tip on chain that contains the merge.
    #[test]
    fn merge_proof_without_the_code_class_uses_the_fetched_base() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir(&src).unwrap();
        git(&src, &["init", "-q", "-b", "main"]);
        git(&src, &["commit", "-q", "--allow-empty", "-m", "base"]);
        let old_tip = git(&src, &["rev-parse", "HEAD"]);
        git(&src, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(src.join("f"), "x").unwrap();
        git(&src, &["add", "f"]);
        git(&src, &["commit", "-q", "-m", "work"]);
        git(&src, &["checkout", "-q", "main"]);
        git(
            &src,
            &["merge", "-q", "--no-ff", "feature", "-m", "Merge PR #1"],
        );
        let merge = git(&src, &["rev-parse", "HEAD"]);
        git(&src, &["commit", "-q", "--allow-empty", "-m", "later"]);
        let pushed_tip_on_chain = git(&src, &["rev-parse", "HEAD"]);
        // The code import pushed `later`; the source moved on since.
        git(&src, &["commit", "-q", "--allow-empty", "-m", "newer"]);

        let proof_dir = tmp.path().join("proof.git");
        let url = format!("file://{}", src.display());
        let bases = vec!["refs/heads/main".to_string(), "refs/heads/gone".to_string()];
        let missing =
            crate::gitsync::fetch_proof_bases(&proof_dir, &url, &bases, true, None).unwrap();
        assert_eq!(
            missing,
            [(
                "refs/heads/gone".to_string(),
                crate::gitsync::Unfetched::Gone
            )]
            .into()
        );
        let proof = ProofRepo {
            dir: proof_dir,
            pushed: false,
            unfetched: missing,
        };
        let tips = MergeBaseTips {
            historical: vec![old_tip.clone(), pushed_tip_on_chain.clone()],
            tip: Some(pushed_tip_on_chain.clone()),
            current: Some(pushed_tip_on_chain.clone()),
        };
        assert_eq!(
            chain_tip_containing(&proof.dir, &tips, &merge).as_deref(),
            Some(pushed_tip_on_chain.as_str()),
            "the chain's tip that contains the merge is named"
        );
        // Nothing is pushed without `code`: the fetched tip never stands in for the chain's.
        assert_eq!(pushed_tip(&proof, "refs/heads/main", &merge), None);
        // A chain that only shows the old tip cannot prove it: recorded with the source's merge
        // commit (D-9), and said why.
        let old_only = MergeBaseTips {
            historical: vec![old_tip.clone()],
            tip: Some(old_tip.clone()),
            current: Some(old_tip),
        };
        assert_eq!(chain_tip_containing(&proof.dir, &old_only, &merge), None);
        assert!(no_proof_reason(Some(&proof), "refs/heads/main").contains("push the code first"));
        assert!(
            no_proof_reason(Some(&proof), "refs/heads/gone").contains("no longer at the source")
        );
        assert!(no_proof_reason(None, "refs/heads/main").contains("could not be fetched"));

        // With `code`, the mirror's own tip counts (a dry run prices before the push).
        let pushed = ProofRepo {
            dir: src.clone(),
            pushed: true,
            unfetched: BTreeMap::new(),
        };
        assert!(pushed_tip(&pushed, "refs/heads/main", &merge).is_some());
        let failed = ProofRepo {
            unfetched: [("refs/heads/x".to_string(), Unfetched::Failed)].into(),
            ..pushed
        };
        assert!(no_proof_reason(Some(&failed), "refs/heads/x").contains("could not be fetched"));
    }

    /// The transitions an importer writes for each upstream state, from a fresh target and
    /// from what the chain already says.
    fn kinds(from: i64, t: &SrcTarget) -> Vec<u8> {
        state_path(t.kind.transition_target(), from, wanted_code(t), 7)
            .iter()
            .map(|m| {
                assert_eq!(m.as_author, 0, "the mirror writes as a member");
                m.kind
            })
            .collect()
    }

    #[test]
    fn each_upstream_state_is_its_transitions_from_a_new_target() {
        let issue = target(TargetKind::Issue);
        assert!(kinds(0, &issue).is_empty(), "open: nothing to write");
        let mut closed = issue.clone();
        closed.closed = true;
        assert_eq!(kinds(0, &closed), vec![1]);

        let pr = target(TargetKind::Patch);
        assert!(kinds(0, &pr).is_empty());
        let mut draft = pr.clone();
        draft.draft = true;
        assert_eq!(kinds(0, &draft), vec![14]);
        let mut closed_pr = pr.clone();
        closed_pr.closed = true;
        assert_eq!(kinds(0, &closed_pr), vec![11]);
        let mut closed_draft = draft.clone();
        closed_draft.closed = true;
        assert_eq!(kinds(0, &closed_draft), vec![14, 16]);
        // Merged: one merge (D-9: recorded whether or not the base is mirrored), never a
        // close beside it; a merged draft upstream is just merged.
        let mut merged = pr.clone();
        merged.closed = true;
        merged.merged_oid = Some(vec![1; 20]);
        assert_eq!(kinds(0, &merged), vec![13]);
        let mut merged_draft = merged.clone();
        merged_draft.draft = true;
        assert_eq!(kinds(0, &merged_draft), vec![13]);
    }

    /// Idempotent against the chain's current state code: nothing when it already matches,
    /// the shortest legal path when it does not, and nothing ever after a merge.
    #[test]
    fn transitions_follow_the_current_code_and_a_merge_is_final() {
        let mut pr = target(TargetKind::Patch);
        for code in [0, 1, 2, 8, 9] {
            // what the source says, as a code
            let (closed, draft, merged) = (code & 1 == 1, code & 8 == 8, code == 2);
            pr.closed = closed || merged;
            pr.draft = draft;
            pr.merged_oid = merged.then(|| vec![1; 20]);
            assert!(kinds(code, &pr).is_empty(), "already {code}");
        }
        // Closed on chain, reopened upstream: reopen.
        pr.closed = false;
        pr.draft = false;
        pr.merged_oid = None;
        assert_eq!(kinds(1, &pr), vec![12]);
        // A closed PR the source merged since (an older import): reopen, then merge.
        pr.merged_oid = Some(vec![1; 20]);
        pr.closed = true;
        assert_eq!(kinds(1, &pr), vec![12, 13]);
        // A draft readied upstream, and a draft that was merged.
        let mut ready = target(TargetKind::Patch);
        assert_eq!(kinds(8, &ready), vec![15]);
        ready.merged_oid = Some(vec![1; 20]);
        assert_eq!(kinds(8, &ready), vec![15, 13]);
        // Merged on chain: nothing, whatever the source says now.
        for (closed, draft) in [(false, false), (true, false), (false, true)] {
            let mut t = target(TargetKind::Patch);
            t.closed = closed;
            t.draft = draft;
            assert!(kinds(2, &t).is_empty());
        }
        // An issue closed then reopened upstream.
        let issue = target(TargetKind::Issue);
        assert_eq!(kinds(1, &issue), vec![2]);
    }

    #[test]
    fn labels_are_diffed_against_the_fold() {
        let mut t = target(TargetKind::Issue);
        t.labels = ["bug".to_string()].into();
        let cur = Current {
            code: 0,
            labels: ["old".to_string()].into(),
        };
        assert_eq!(
            label_events(&t, &cur),
            vec![
                (EventKind::LabelAdd, "bug".to_string()),
                (EventKind::LabelRemove, "old".to_string())
            ]
        );
        assert!(label_events(
            &t,
            &Current {
                code: 0,
                labels: t.labels.clone()
            }
        )
        .is_empty());
    }

    #[test]
    fn a_diverging_item_names_its_upstream_number_and_url() {
        let mut t = target(TargetKind::Issue);
        t.number = 7762;
        t.imported.url = "https://github.com/dashpay/dash/issues/7762".into();
        let note = diverged_note("issue", &t, 16);
        assert!(
            note.starts_with("upstream issue #7762 is #16 here"),
            "{note}"
        );
        assert!(note.ends_with("https://github.com/dashpay/dash/issues/7762"));
    }

    /// A merge the source names no commit for imports closed, with a warning; one with a
    /// commit, or one already merged on chain, says nothing.
    #[test]
    fn a_merge_without_a_sha_is_closed_and_said() {
        let mut t = target(TargetKind::Patch);
        t.closed = true;
        t.merged_without_sha = true;
        assert_eq!(wanted_code(&t), 1);
        assert!(merged_without_sha_note(&t, 0).is_some_and(|n| n.contains("no merge commit")));
        assert!(merged_without_sha_note(&t, 2).is_none());
        t.merged_oid = Some(vec![1; 20]);
        assert!(merged_without_sha_note(&t, 0).is_none());
    }

    /// Only the item's own content makes it refused for later runs.
    #[test]
    fn only_content_refusals_are_final_for_an_item() {
        let rule = |doc: &str, rule: &str| {
            anyhow::Error::from(forge_core::Error::RuleRefused {
                document_type: doc.into(),
                rule: rule.into(),
                detail: String::new(),
            })
        };
        assert!(content_error(&rule("issue", "hasTitle")));
        assert!(content_error(&anyhow::Error::from(
            forge_core::Error::Config("title too long: 300 chars (max 256)".into())
        )));
        assert!(!content_error(&rule("transition", "c1_closedAfter")));
        assert!(!content_error(&rule("issue", "dense")));
        assert!(!content_error(&anyhow::Error::from(
            forge_core::Error::DuplicateUniqueIndex("number".into())
        )));
        assert!(!content_error(&anyhow::Error::from(
            forge_core::Error::Config("no destination repository".into())
        )));
    }

    /// A stranger's high `upstreamNumber` does not move the order check; the signer's and a
    /// member's do.
    #[test]
    fn only_trusted_upstream_numbers_are_held() {
        let row = |author: &str, n: u32| forge_core::collab::v2::ImportedRow {
            target: Target {
                kind: TargetKind::Issue,
                id: format!("d{n}"),
                number: n,
                author: author.into(),
            },
            imported: None,
            upstream_number: Some(n),
            base: None,
        };
        let rows = [row("stranger", 9000), row("mirror", 40), row("member", 41)];
        let trusted = |a: &str| a == "mirror" || a == "member";
        assert_eq!(highest_trusted(&rows, trusted), Some(41));
        assert_eq!(highest_trusted(&rows[..1], trusted), None);
        assert_eq!(highest_trusted(&[], trusted), None);
    }

    /// An incremental run that finds an earlier item missing is refused; a full run is not
    /// (it warns and places the items at the next numbers); nothing missing is fine.
    #[test]
    fn the_order_check_refuses_only_an_incremental_run() {
        assert!(order_refuses(true, &[3]));
        assert!(!order_refuses(false, &[3]));
        assert!(!order_refuses(true, &[]));
    }
}
