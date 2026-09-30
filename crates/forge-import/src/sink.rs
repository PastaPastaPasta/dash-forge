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
//! A dry run walks the same path with every write replaced by a count and an estimate.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::Path;

use anyhow::{Context, Result};

use forge_core::collab::v2::{
    Collab, ImportedTarget, PatchInput, PrBase, Provenance, Target, TargetKind,
};
use forge_core::collab::{ReleaseInput, Verdict};
use forge_core::history::Freshness;
use forge_core::platform::PlatformClient;
use forge_core::rules::v2::{
    issue_state_v2, next_transition, pr_state_v2, Actor, StateAction, TransitionMove,
    TransitionTarget, Visibility,
};
use forge_core::rules::{EventKind, MergeBaseTips};
use forge_core::scope::RepoRef;

use crate::budget::{collab_doc_credits, Budget, CollabDoc};
use crate::gitsync::{ProofRepo, Unfetched};
use crate::model::{same_item, same_item_renamed, SrcCollab, SrcLabel, SrcRelease, SrcTarget};
use crate::summary::Counts;

/// The run's accounting: budget, counts, warnings.
pub struct Ledger<'a> {
    client: &'a PlatformClient,
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
}

impl<'a> Ledger<'a> {
    /// A ledger for `signer`'s writes (`None` only in a dry run without an identity).
    pub fn new(
        client: &'a PlatformClient,
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

    /// An optional git push skipped this run ([`crate::summary::Counts::git_skipped`]).
    pub fn skip_git(&mut self, msg: impl Into<String>) {
        self.counts.git_skipped += 1;
        self.warn(msg);
    }

    /// One write: charged to the budget first (refused past the cap, before anything is
    /// signed), counted, executed unless this is a dry run, then reconciled with the
    /// measured balance so an estimate that ran low stops the NEXT write.
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
        if !tracing::enabled!(target: "forge_import::cost", tracing::Level::DEBUG) {
            return None;
        }
        self.balance(self.signer.as_deref()?).await
    }

    /// Log one write's estimate against its measured balance drop (calibration). Nodes can
    /// answer from a height before the write landed, so the balance is re-read (up to ~10 s)
    /// until it moves; every write costs something.
    pub async fn trace_cost(&self, what: &str, estimated: u64, before: Option<u64>) {
        let Some(before) = before else { return };
        let mut after = self.traced_balance().await;
        for _ in 0..10 {
            if after.is_some_and(|a| a != before) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            after = self.traced_balance().await;
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

    /// Pull the measured balance drop into the budget; whether the balance could be read.
    pub async fn reconcile(&mut self) -> bool {
        if let Some(signer) = &self.signer {
            if let Ok(balance) = self.client.get_balance(signer).await {
                self.budget.reconcile(balance);
                return true;
            }
        }
        false
    }

    /// `identity`'s balance now, when it can be read.
    pub async fn balance(&self, identity: &str) -> Option<u64> {
        self.client.get_balance(identity).await.ok()
    }

    fn is_mine(&self, author: &str) -> bool {
        self.signer.as_deref().is_none_or(|s| s == author)
    }
}

/// The destination and its accounting.
pub struct Sink<'a> {
    collab: Collab<'a>,
    /// `None` only in a dry run whose destination does not exist yet.
    repo: Option<RepoRef>,
    /// Budget, counts, warnings.
    pub ledger: Ledger<'a>,
    /// Every imported issue and PR in the destination, `(imported.url, target)`, whoever
    /// wrote it; loaded on the first miss of a point lookup.
    index: Option<Vec<(String, Target)>>,
    /// The destination's members (maintainers and writers), read once: an imported item by
    /// a member is an earlier mirror's copy; one by anyone else is a squatter.
    members: Option<BTreeSet<String>>,
    /// The git data a merge commit's ancestry is checked in, when this run has any (see
    /// [`Sink::merge_proof`]).
    mirror: Option<ProofRepo>,
    /// Each destination PR's base as the readers fold it, by target `$id`. Filled wherever
    /// a patch is read.
    opened: BTreeMap<String, PrBase>,
    /// Bases already re-read for read-after-write lag this run ([`BASE_LAG_WAITS`]): the lag
    /// is waited out once, not once per PR.
    lag_waited: BTreeSet<String>,
    /// PRs (destination `$id`) whose base was not a branch on chain when they were mirrored:
    /// no merge into it ever counts (D-501), so a later run cannot prove them either.
    never_provable: BTreeSet<String>,
    /// Bases this write phase read from the network already. The process's synced copy of
    /// the history may be the dry run's, from before this run's push: a base's first read
    /// here asks the network (`Freshness::Now`), later ones reuse that copy.
    fresh_read: BTreeSet<String>,
    /// Each source item looked up this run, by `(tk, source number)`: its copy, or `None`
    /// when it has none (yet).
    known: BTreeMap<(u8, u32), Option<Target>>,
    /// The first source item stored at a number other than its own ([`Sink::create`]):
    /// numbers diverge from there on, said once.
    diverged: bool,
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
            // A duplicate, or a rule of the type refusing this one document (a state move the
            // target's transitions no longer allow: another client moved it first).
            Some(
                forge_core::Error::DuplicateUniqueIndex(_) | forge_core::Error::RuleRefused { .. },
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
            Some(forge_core::Error::Config(_)) => item_error(e),
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

/// A target's state on chain: its state code (the sum of its transitions) and its labels.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Current {
    code: i64,
    labels: BTreeSet<String>,
}

/// The state code `t` has at the source: an issue open (0) or closed (1); a PR open (0),
/// closed (1), merged (2), and a draft adds 8 unless merged.
fn wanted_code(t: &SrcTarget) -> i64 {
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
fn state_path(target: TransitionTarget, from: i64, to: i64, number: u32) -> Vec<TransitionMove> {
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

impl<'a> Sink<'a> {
    /// A sink for `repo` (see [`Ledger`]).
    pub fn new(collab: Collab<'a>, repo: Option<RepoRef>, ledger: Ledger<'a>) -> Self {
        Self {
            collab,
            repo,
            ledger,
            index: None,
            members: None,
            mirror: None,
            opened: BTreeMap::new(),
            lag_waited: BTreeSet::new(),
            never_provable: BTreeSet::new(),
            fresh_read: BTreeSet::new(),
            known: BTreeMap::new(),
            diverged: false,
        }
    }

    /// Check merge commits against the git data in `proof` (see [`Sink::merge_proof`]).
    #[must_use]
    pub fn with_mirror(mut self, proof: Option<ProofRepo>) -> Self {
        self.mirror = proof;
        self
    }

    /// The base tips a reader checks PR `target_id`'s merge against: the base it was opened
    /// against, at its `$createdAt` ([`pr_base_tips`], as `Collab::patch_view` folds it). A PR
    /// this run has not read was opened now (after this run's push). None without a
    /// destination (a dry run of a repo not created yet).
    async fn base_tips(
        &mut self,
        target_id: &str,
        base_ref: &str,
        freshness: Freshness,
    ) -> Result<MergeBaseTips> {
        let PrBase {
            ref_name: base_ref,
            opened_at,
        } = self.opened.get(target_id).cloned().unwrap_or(PrBase {
            ref_name: base_ref.to_string(),
            opened_at: u64::MAX,
        });
        let Some(repo) = self.repo.as_ref() else {
            return Ok(MergeBaseTips::default());
        };
        // A private repo's ref names are sealed: Collab reads (and caches) its updates.
        if repo.visibility == Visibility::Private {
            return Ok(self
                .collab
                .base_ref_tips(repo, &base_ref, opened_at)
                .await?);
        }
        // One read of the repo's git history per process (`Synced`), shared by every PR of
        // the run; `Now` when this run's own push may not show yet, and for a base's first
        // read in a write phase (the synced copy may predate this run's push).
        let first_write_read = !self.ledger.dry_run && self.fresh_read.insert(base_ref.clone());
        let freshness = if first_write_read {
            Freshness::Now
        } else {
            freshness
        };
        let client = self.ledger.client;
        let core = client.fetch_contract(&repo.forge().core).await?;
        Ok(forge_core::refs::read_merge_base(
            client,
            &core,
            &repo.scope()?,
            &base_ref,
            opened_at,
            freshness,
        )
        .await?)
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
    async fn merge_proof(&mut self, t: &SrcTarget, target_id: &str) -> Result<Option<Vec<u8>>> {
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
        let mut tips = self.base_tips(target_id, base, Freshness::Synced).await?;
        // A PR opened against a base that did not exist then has no tips, and no merge into
        // it ever counts (D-501); naming one would be re-posted, and paid for, every run.
        let base_counts = tips.tip.is_some() || !self.opened.contains_key(target_id);
        // Never provable: the PR was opened against a base with no tip on chain (read from
        // chain), or this run pushes nothing and the base never had a tip, so the PR it just
        // created is opened against a base that is no branch (D-501).
        if !base_counts || (!pushed && tips.historical.is_empty()) {
            self.never_provable.insert(target_id.to_string());
        }
        if self.ledger.dry_run {
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
        let folded = self
            .opened
            .get(target_id)
            .map_or(base.as_str(), |b| b.ref_name.as_str());
        let may_lag = base_counts && folded == base && !self.lag_waited.contains(base);
        let waits = if may_lag { BASE_LAG_WAITS } else { &[] };
        for wait in waits {
            let seen = local.as_ref().is_none_or(|l| tips.contains(l));
            if contains(&tips).is_some() || seen {
                break;
            }
            // Marked only when a wait happens: a PR whose merge the mirror lacks (no `local`)
            // must not use up the one wait a later PR on the same base may need.
            self.lag_waited.insert(base.clone());
            tokio::time::sleep(std::time::Duration::from_millis(*wait)).await;
            self.collab.refs_changed();
            tips = self.base_tips(target_id, base, Freshness::Now).await?;
        }
        Ok(contains(&tips).and_then(|tip| hex::decode(tip).ok()))
    }

    /// Whether `author` may have mirrored an item: the signer, or a member of the
    /// destination. Issues and PRs are ungated, so anyone else's `imported` is a claim, not a
    /// copy.
    async fn trusted(&mut self, author: &str) -> Result<bool> {
        if self.ledger.is_mine(author) {
            return Ok(true);
        }
        if self.members.is_none() {
            let members = match &self.repo {
                Some(repo) => forge_core::members::MemberReader::new(self.ledger.client)
                    .list(repo)
                    .await
                    .context("reading the destination's members")?
                    .into_iter()
                    .map(|m| m.identity_id)
                    .collect(),
                None => BTreeSet::new(),
            };
            self.members = Some(members);
        }
        Ok(self.members.as_ref().is_some_and(|m| m.contains(author)))
    }

    /// Whether the document `target` (key `url`) is the mirrored copy of `t`: the same
    /// source item, written by the signer (a renamed source repo still matches) or by a
    /// member of the destination (exact repository only).
    async fn is_copy(&mut self, url: &str, target: &Target, t: &SrcTarget) -> Result<bool> {
        let mine = self.ledger.is_mine(&target.author);
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
    pub async fn sync(&mut self, src: &SrcCollab) -> Result<()> {
        if let Some(labels) = &src.labels {
            self.sync_labels(labels).await?;
        }
        if let Some(releases) = &src.releases {
            self.sync_releases(releases).await?;
        }
        self.check_order(src).await?;
        for t in &src.targets {
            self.sync_target(t).await?;
        }
        Ok(())
    }

    /// The highest source number of `kind` the destination holds from a trusted writer (the
    /// signer or a member), or 0. A stranger can set any `upstreamNumber`, so theirs are
    /// skipped; one page usually settles it, else every one is read.
    async fn held_upstream(&mut self, kind: TargetKind) -> Result<u32> {
        let Some(repo) = self.repo.clone() else {
            return Ok(0);
        };
        // The first page (highest first); when it holds rows but none from a trusted writer,
        // every one. Not "a full page": unreadable rows are dropped before this sees them.
        for all in [false, true] {
            let rows = self
                .collab
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
    async fn check_order(&mut self, src: &SrcCollab) -> Result<()> {
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
            self.ledger.warn(format!(
                "{} upstream {noun}(s) from #{first} are mirrored after #{held}: Forge \
                 numbers densely, so they take the next numbers (each keeps its source number \
                 as its upstream number)",
                missing.len()
            ));
        }
        Ok(())
    }

    // --- labels and releases -----------------------------------------------------------

    async fn sync_labels(&mut self, labels: &[SrcLabel]) -> Result<()> {
        let existing: BTreeMap<String, (String, String, bool)> = match &self.repo {
            Some(repo) => self
                .collab
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
        let (collab, repo) = (&self.collab, self.repo.as_ref());
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
            self.ledger
                .write(
                    format!("label {}", l.name),
                    credits,
                    |c| c.labels += 1,
                    || async move {
                        collab
                            .create_label(need(repo)?, &l.name, &l.color, &l.description, false)
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
    async fn sync_releases(&mut self, releases: &[SrcRelease]) -> Result<()> {
        let mut known = crate::assets::Known::default();
        let existing: BTreeMap<String, String> = match &self.repo {
            Some(repo) => self
                .collab
                .releases(repo)
                .await
                .context("reading the destination's releases")?
                .current
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
        let dry = self.ledger.dry_run;
        // Newest first (the source's order): the hashing budget goes to the newest releases.
        let mut prepared = Vec::with_capacity(releases.len());
        for r in releases {
            // A tag the destination would refuse (over 63 bytes, or outside the git ref
            // grammar the contract enforces, `@{` included) skips that release, not the run.
            if let Err(e) = forge_core::collab::v2::check_tag_name(&r.tag_name) {
                self.ledger.skip(format!("release not mirrored: {e}"));
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
                self.ledger.warn(w);
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
            let total = r.dropped + assets_in.len();
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
            self.ledger.counts.assets_omitted += dropped as u64;
            self.ledger.counts.assets_unhashed += unhashed as u64;
            if dropped > 0 {
                self.ledger.warn(format!(
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
            let (collab, repo) = (&self.collab, self.repo.as_ref());
            let input = &input;
            let written = self
                .ledger
                .write(
                    format!("release {}", r.tag_name),
                    credits,
                    |c| c.releases += 1,
                    || async move { collab.create_release(need(repo)?, input).await },
                )
                .await;
            if let Err(e) = written {
                self.refused_release(&r.tag_name, e)?;
            }
        }
        Ok(())
    }

    /// A release write that failed: the destination refusing this release (its content, or a
    /// rule such as `oneLive` after a concurrent publish) skips it, uncounted as written;
    /// spend-cap and network errors stop the run.
    fn refused_release(&mut self, tag: &str, e: anyhow::Error) -> Result<()> {
        if !item_error(&e) {
            return Err(e);
        }
        self.ledger.counts.releases = self.ledger.counts.releases.saturating_sub(1);
        self.ledger
            .skip(format!("release {tag} not mirrored this run: {e:#}"));
        Ok(())
    }

    // --- issues and pull requests --------------------------------------------------------

    /// Mirror one issue or PR. An error that only concerns this item (the destination
    /// refused its content) skips it with a warning instead of failing the run, so one bad
    /// item cannot stop every future run; spend-cap and network errors still stop the run.
    async fn sync_target(&mut self, t: &SrcTarget) -> Result<()> {
        match self.sync_target_inner(t).await {
            Err(e) if item_error(&e) => {
                self.ledger
                    .skip(format!("{} not mirrored this run: {e:#}", t.imported.url));
                // Only a refusal of the item's own content is final for it; a state move a
                // concurrent change beat (a `c*` rule) or a taken number is retried next run.
                if content_error(&e) {
                    self.ledger.refused.insert(key_of(t));
                }
                Ok(())
            }
            other => other,
        }
    }

    async fn sync_target_inner(&mut self, t: &SrcTarget) -> Result<()> {
        let noun = t.kind.noun();
        let (target, fresh) = if let Some(target) = self.existing(t).await? {
            (target, false)
        } else {
            let target = self.create(t, noun).await?;
            if let Some(idx) = &mut self.index {
                idx.push((t.imported.url.clone(), target.clone()));
            }
            self.known.insert(key_of(t), Some(target.clone()));
            (target, true)
        };
        if !fresh && !self.ledger.is_mine(&target.author) {
            // A member mirrored this item (an earlier mirror identity, or a second mirror):
            // writing to it, or recreating it at a new number, would duplicate it. (A
            // non-member's claim never gets here: it is a squatter, and the item is created
            // at another number.) Settled: the member's copy is permanent, so it does not hold
            // the sync state (a mirror identity rotated would otherwise hold it for good).
            self.ledger.warn(format!(
                "{noun} #{} is already mirrored by {} (as #{}); not mirrored again",
                t.number, target.author, target.number
            ));
            return Ok(());
        }
        let current = if fresh {
            Current::default()
        } else {
            self.current(&target).await?
        };
        // The thread first, then the state: readers order a target's timeline by `$createdAt`,
        // and at the source a close (or merge) comes after the comments that led to it (L-46).
        // A comment or review the destination refuses (an item error, which skips this item)
        // still lets the state be written, as it was before this order: a skip must not also
        // leave the item open.
        let thread = self.sync_thread(t, &target, fresh).await;
        if state_after(&thread) {
            self.sync_state(t, &target, &current).await?;
        }
        thread
    }

    /// An item's comments, then (a PR's) reviews.
    async fn sync_thread(&mut self, t: &SrcTarget, target: &Target, fresh: bool) -> Result<()> {
        self.sync_comments(t, target, fresh).await?;
        if t.kind == TargetKind::Patch {
            self.sync_reviews(t, target, fresh).await?;
        }
        Ok(())
    }

    /// Every imported issue and PR already in the destination, by its `imported.url` key:
    /// each `issue` / `patch` of the repo that carries provenance, whoever wrote it. One
    /// complete read per kind, so an item is found wherever it landed; read only when its
    /// upstream number is held by a document that is not its copy.
    async fn load_index(&mut self) -> Result<()> {
        if self.index.is_some() {
            return Ok(());
        }
        let mut index = Vec::new();
        if let Some(repo) = &self.repo {
            // through Collab: a private destination's provenance is sealed (§7)
            let targets = self
                .collab
                .imported_targets(repo)
                .await
                .context("reading the destination's issues and pull requests")?;
            for row in targets {
                if let Some(b) = row.base {
                    self.opened.insert(row.target.id.clone(), b);
                }
                if let Some(i) = row.imported.filter(|i| !i.url.is_empty()) {
                    index.push((i.url, row.target));
                }
            }
        }
        self.index = Some(index);
        Ok(())
    }

    /// The existing mirrored target for `t`, if any (tolerating a renamed source repo),
    /// looked up once per run. The `upstream (repoId, upstreamNumber)` index first (one read);
    /// the full `imported.url` index only when that number is held by something that is not
    /// its copy (a stranger can write any `upstreamNumber`).
    async fn existing(&mut self, t: &SrcTarget) -> Result<Option<Target>> {
        if let Some(k) = self.known.get(&key_of(t)) {
            return Ok(k.clone());
        }
        let found = self.lookup(t).await?;
        self.known.insert(key_of(t), found.clone());
        Ok(found)
    }

    async fn lookup(&mut self, t: &SrcTarget) -> Result<Option<Target>> {
        if self.index.is_none() {
            let Some(repo) = self.repo.as_ref() else {
                return Ok(None);
            };
            let rows = self.collab.upstream_targets(repo, t.kind, t.number).await?;
            if rows.is_empty() {
                return Ok(None);
            }
            for row in rows {
                if let Some(b) = &row.base {
                    self.opened.insert(row.target.id.clone(), b.clone());
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
    async fn indexed(&mut self, t: &SrcTarget) -> Result<Option<Target>> {
        let candidates: Vec<(String, Target)> = self
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
    async fn create(&mut self, t: &SrcTarget, noun: &str) -> Result<Target> {
        let placeholder = Target {
            kind: t.kind,
            id: String::new(),
            number: t.number,
            author: self.ledger.signer.clone().unwrap_or_default(),
        };
        let credits = collab_doc_credits(
            CollabDoc::Target,
            text_doc(&t.title) + t.body.len() as u64 + t.imported.url.len() as u64 + 100,
        );
        let (collab, repo) = (&self.collab, self.repo.as_ref());
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
            .ledger
            .write(what, credits, count, || async move {
                collab.create_imported(need(repo)?, doc, from).await
            })
            .await?;
        let Some(created) = out else {
            return Ok(placeholder);
        };
        if created.number != t.number && !self.diverged {
            self.diverged = true;
            self.ledger.warn(diverged_note(noun, t, created.number));
        }
        Ok(Target {
            id: created.document_id,
            number: created.number,
            ..placeholder
        })
    }

    /// `target`'s state on chain: its state code (the sum of its transitions; "merged" is the
    /// chain fact, D-9) and its labels as every reader folds them.
    async fn current(&mut self, target: &Target) -> Result<Current> {
        let repo = need(self.repo.as_ref())?;
        let log = self.collab.target_log(repo, &target.id).await?;
        let code = log.state_code();
        let labels = match target.kind {
            TargetKind::Issue => issue_state_v2(code, &log.events).labels,
            TargetKind::Patch => pr_state_v2(code, None, &log.events, None, |_, _| false).labels,
        };
        Ok(Current { code, labels })
    }

    /// The commit a merge transition for `t` names: a pushed base tip containing the source's
    /// merge commit when there is one ([`Sink::merge_proof`]), so readers find it on the base;
    /// else the source's merge commit itself. A merge is recorded either way (D-9: "merged"
    /// is what a member recorded); readers label one whose commit is not on the base.
    async fn merge_oid(&mut self, t: &SrcTarget, target: &Target) -> Result<Vec<u8>> {
        let upstream = t.merged_oid.clone().unwrap_or_default();
        if let Some(tip) = self.merge_proof(t, &target.id).await? {
            return Ok(tip);
        }
        let base = t.patch.as_ref().map_or("?", |p| p.base_ref_name.as_str());
        self.ledger.counts.unproved_merges += 1;
        let reason = if self.never_provable.contains(&target.id) {
            format!(
                "its base {base} was not a branch on chain when it was mirrored (forge-v2 §6, \
                 D-501: push the code before the issues and PRs)"
            )
        } else {
            no_proof_reason(self.mirror.as_ref(), base)
        };
        self.ledger.warn(format!(
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
    async fn sync_state(
        &mut self,
        t: &SrcTarget,
        target: &Target,
        current: &Current,
    ) -> Result<()> {
        let moves = state_path(
            t.kind.transition_target(),
            current.code,
            wanted_code(t),
            target.number,
        );
        if let Some(note) = merged_without_sha_note(t, current.code) {
            self.ledger.warn(note);
        }
        let merges = moves
            .iter()
            .any(|m| m.kind == forge_core::rules::transition::PR_MERGE);
        let merge_oid = if merges {
            Some(self.merge_oid(t, target).await?)
        } else {
            None
        };
        let (collab, repo) = (&self.collab, self.repo.as_ref());
        for (kind, value) in label_events(t, current) {
            let credits = collab_doc_credits(CollabDoc::Event, 120 + value.len() as u64);
            let what = format!("{kind:?} event on #{}", t.number);
            let value = value.as_str();
            self.ledger
                .write(
                    what,
                    credits,
                    |c| c.events += 1,
                    || async move {
                        collab
                            .post_event(need(repo)?, target, kind, Some(value), None)
                            .await
                    },
                )
                .await?;
        }
        for mv in moves {
            let oid = (mv.kind == forge_core::rules::transition::PR_MERGE)
                .then_some(merge_oid.as_deref())
                .flatten();
            let credits = collab_doc_credits(
                CollabDoc::Transition,
                TRANSITION_BYTES + oid.map_or(0, <[u8]>::len) as u64,
            );
            let what = format!("kind-{} transition on #{}", mv.kind, t.number);
            self.ledger
                .write(
                    what,
                    credits,
                    |c| c.transitions += 1,
                    || async move { collab.write_transition(need(repo)?, target, &mv, oid).await },
                )
                .await?;
        }
        Ok(())
    }

    async fn sync_comments(&mut self, t: &SrcTarget, target: &Target, fresh: bool) -> Result<()> {
        if t.comments.is_empty() {
            return Ok(());
        }
        let done: BTreeSet<String> = if fresh {
            BTreeSet::new()
        } else {
            let repo = need(self.repo.as_ref())?;
            self.collab
                .comments(repo, &target.id)
                .await?
                .into_iter()
                .filter(|c| self.ledger.is_mine(&c.author))
                .filter_map(|c| c.imported.map(|i| i.url))
                .collect()
        };
        let (collab, repo) = (&self.collab, self.repo.as_ref());
        for c in t
            .comments
            .iter()
            .filter(|c| !done.iter().any(|u| same_item_renamed(u, &c.imported.url)))
        {
            let credits = collab_doc_credits(
                CollabDoc::Comment,
                text_doc(&c.body) + c.imported.url.len() as u64,
            );
            self.ledger
                .write(
                    format!("comment on #{}", t.number),
                    credits,
                    |n| n.comments += 1,
                    || async move {
                        collab
                            .comment(
                                need(repo)?,
                                &target.id,
                                &c.body,
                                c.anchor.as_ref(),
                                Some(&c.imported),
                            )
                            .await
                    },
                )
                .await?;
        }
        Ok(())
    }

    async fn sync_reviews(&mut self, t: &SrcTarget, target: &Target, fresh: bool) -> Result<()> {
        if t.reviews.is_empty() {
            return Ok(());
        }
        let done: BTreeSet<String> = if fresh {
            BTreeSet::new()
        } else {
            let repo = need(self.repo.as_ref())?;
            self.collab
                .reviews(repo, &target.id)
                .await?
                .into_iter()
                .filter(|r| self.ledger.is_mine(&r.reviewer))
                .filter_map(|r| r.imported.map(|i| i.url))
                .collect()
        };
        let (collab, repo) = (&self.collab, self.repo.as_ref());
        for r in t
            .reviews
            .iter()
            .filter(|r| !done.iter().any(|u| same_item_renamed(u, &r.imported.url)))
        {
            let credits = collab_doc_credits(
                CollabDoc::Review,
                text_doc(&r.body) + r.imported.url.len() as u64 + 40,
            );
            self.ledger
                .write(
                    format!("review on #{}", t.number),
                    credits,
                    |n| n.reviews += 1,
                    || async move {
                        collab
                            .review(
                                need(repo)?,
                                &target.id,
                                // Always a comment: the mirror identity is a member, and a
                                // member's approve / request-changes counts (§6); a source
                                // reviewer's verdict must not become one. It is in the body.
                                Verdict::Comment,
                                &r.commit_oid,
                                &r.body,
                                None,
                                Some(&r.imported),
                            )
                            .await
                    },
                )
                .await?;
        }
        Ok(())
    }
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
