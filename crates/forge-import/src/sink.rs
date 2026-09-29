//! Write a [`SrcCollab`] into a forge-v2 repository: diff against what the chain already
//! holds, write only the difference, and charge every write to the [`Budget`] before it is
//! signed.
//!
//! **Idempotency lives on chain, not in a state file.** An item is already mirrored when the
//! destination holds a document written by the signer whose `imported.url` is the item's
//! key: an issue or PR at the same number, a comment or review on it. State (open, closed,
//! merged, draft, labels) is compared with the fold of the target's events. A re-run with
//! nothing new writes nothing and costs nothing, whatever happened to the machine (or the
//! state file) of the last run.
//!
//! A dry run walks the same path with every write replaced by a count and an estimate.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;

use anyhow::{Context, Result};

use forge_core::collab::v2::{Collab, Numbered, PatchInput, PrBase, Target, TargetKind};
use forge_core::collab::{ReleaseInput, Verdict};
use forge_core::history::Freshness;
use forge_core::platform::PlatformClient;
use forge_core::rules::v2::{fold_issue_state_v2, fold_pr_state_v2, Visibility};
use forge_core::rules::{EventKind, MergeBaseTips};
use forge_core::scope::RepoRef;

use crate::budget::{collab_doc_credits, Budget, CollabDoc};
use crate::gitsync::ProofRepo;
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
    /// Bases this write phase read from the network already. The process's synced copy of
    /// the history may be the dry run's, from before this run's push: a base's first read
    /// here asks the network (`Freshness::Now`), later ones reuse that copy.
    fresh_read: BTreeSet<String>,
}

/// Pauses (ms) between re-reads of a base's history that does not show this run's push yet
/// (read-after-write lag across nodes): about 20 s in all.
const BASE_LAG_WAITS: &[u64] = &[1_500, 3_000, 5_000, 10_000];

/// Attempts at finding a free number for one item.
const MAX_NUMBER_TRIES: usize = 4;

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
        "number above",
    ];
    e.chain()
        .any(|c| match c.downcast_ref::<forge_core::Error>() {
            Some(forge_core::Error::DuplicateUniqueIndex(_)) => true,
            Some(forge_core::Error::Config(why)) => ITEM.iter().any(|m| why.contains(m)),
            _ => false,
        })
}

/// The state of a target as its events fold today.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Current {
    open: bool,
    merged: bool,
    draft: bool,
    labels: BTreeSet<String>,
}

impl Current {
    fn new_target() -> Self {
        Self {
            open: true,
            merged: false,
            draft: false,
            labels: BTreeSet::new(),
        }
    }
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

/// What [`Sink::create`] ended with.
enum Created {
    /// Written now.
    New(Target),
    /// Already mirrored at another number (found once its source number was taken).
    Found(Target),
    /// Every candidate number was taken.
    NoNumber,
}

/// A member event to write: kind, `value`, `oid`.
type StateEvent = (EventKind, Option<String>, Option<Vec<u8>>);

fn need(repo: Option<&RepoRef>) -> forge_core::Result<&RepoRef> {
    repo.ok_or_else(|| forge_core::Error::Config("no destination repository".into()))
}

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
            fresh_read: BTreeSet::new(),
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
            (&t.merged_oid, &t.patch, self.mirror.clone())
        else {
            return Ok(None);
        };
        let merged = hex::encode(merged);
        let base = &patch.base_ref_name;
        let local = pushed_tip(&proof, base, &merged);
        let contains = |tips: &MergeBaseTips| chain_tip_containing(&proof, tips, &merged);
        let mut tips = self.base_tips(target_id, base, Freshness::Synced).await?;
        // A PR opened against a base that did not exist then has no tips, and no merge into
        // it ever counts (D-501); naming one would be re-posted, and paid for, every run.
        let base_counts = tips.tip.is_some() || !self.opened.contains_key(target_id);
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
        for t in &src.targets {
            self.sync_target(t).await?;
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
    /// follows the releases' own order; readers order by version anyway (L-14).
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
                .0
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
            if r.tag_name.is_empty() || r.tag_name.len() > 63 {
                self.ledger.warn(format!(
                    "release tag {:?} does not fit the 63 bytes a release holds; skipped",
                    r.tag_name
                ));
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
            prepared.push((r, assets_in));
        }
        for (r, mut assets_in) in prepared.into_iter().rev() {
            if dry {
                // Priced, not fetched: an asset a real run would hash changes the release.
                for a in assets_in.iter_mut().filter(|a| a.sha256.is_empty()) {
                    a.sha256 = "0".repeat(64);
                }
            }
            let before = assets_in.len();
            let assets_in = crate::model::fit_assets(assets_in);
            let dropped = r.dropped + before - assets_in.len();
            let total = r.dropped + before;
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
            let notes = crate::model::notes_with_footer(&r.notes, dropped, total, &r.source_url);
            let assets = serde_json::to_string(&assets_in).unwrap_or_default();
            if existing.get(&r.tag_name) == Some(&fingerprint(&r.name, &notes, &assets)) {
                continue;
            }
            let credits = collab_doc_credits(
                CollabDoc::Release,
                (r.tag_name.len() + r.name.len() + notes.len() + assets.len() + 40) as u64,
            );
            let input = ReleaseInput {
                tag_name: r.tag_name.clone(),
                name: r.name.clone(),
                notes,
                yanked: false,
                assets: assets_in,
            };
            let (collab, repo) = (&self.collab, self.repo.as_ref());
            let input = &input;
            self.ledger
                .write(
                    format!("release {}", r.tag_name),
                    credits,
                    |c| c.releases += 1,
                    || async move { collab.create_release(need(repo)?, input).await },
                )
                .await?;
        }
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
                Ok(())
            }
            other => other,
        }
    }

    async fn sync_target_inner(&mut self, t: &SrcTarget) -> Result<()> {
        let noun = t.kind.noun();
        let (target, fresh) = match self.existing(t).await? {
            Some(target) => (target, false),
            None => match self.create(t, noun).await? {
                Created::New(target) => {
                    if let Some(idx) = &mut self.index {
                        idx.push((t.imported.url.clone(), target.clone()));
                    }
                    (target, true)
                }
                Created::Found(target) => (target, false),
                Created::NoNumber => {
                    self.ledger.skip(format!(
                        "{noun} #{} could not get a number (every candidate was taken); {} \
                         not mirrored this run",
                        t.number, t.imported.url
                    ));
                    return Ok(());
                }
            },
        };
        if !fresh && !self.ledger.is_mine(&target.author) {
            // A member mirrored this item (an earlier mirror identity, or a second mirror):
            // writing to it, or recreating it at a new number, would duplicate it. (A
            // non-member's claim never gets here: it is a squatter, and the item is created
            // at another number.)
            self.ledger.skip(format!(
                "{noun} #{} is already mirrored by {} (as #{}); not mirrored again",
                t.number, target.author, target.number
            ));
            return Ok(());
        }
        let current = if fresh {
            Current::new_target()
        } else {
            self.current(t, &target).await?
        };
        self.sync_state(t, &target, &current).await?;
        self.sync_comments(t, &target, fresh).await?;
        if t.kind == TargetKind::Patch {
            self.sync_reviews(t, &target, fresh).await?;
        }
        Ok(())
    }

    /// Every imported issue and PR already in the destination, by its `imported.url` key:
    /// each `issue` / `patch` of the repo that carries provenance, whoever wrote it. One
    /// complete read per kind, so an item is found wherever it landed (its source number, or
    /// an allocated one when that was taken).
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
            for (target, imported, base) in targets {
                if let Some(b) = base {
                    self.opened.insert(target.id.clone(), b);
                }
                if let Some(i) = imported.filter(|i| !i.url.is_empty()) {
                    index.push((i.url, target));
                }
            }
        }
        self.index = Some(index);
        Ok(())
    }

    /// The existing mirrored target for `t`, if any (tolerating a renamed source repo). A
    /// point lookup at the source number first (the common case: one read); the full index
    /// only when that number holds something else.
    async fn existing(&mut self, t: &SrcTarget) -> Result<Option<Target>> {
        if self.index.is_none() {
            let Some(repo) = self.repo.as_ref() else {
                return Ok(None);
            };
            let at = match t.kind {
                TargetKind::Issue => self
                    .collab
                    .issue(repo, t.number)
                    .await?
                    .map(|i| (i.target(), i.imported)),
                TargetKind::Patch => {
                    let p = self.collab.patch(repo, t.number).await?;
                    if let Some(p) = &p {
                        self.opened.insert(p.document_id.clone(), p.base());
                    }
                    p.map(|p| (p.target(), p.imported))
                }
            };
            match at {
                // Nothing there: new, unless it landed elsewhere (a taken number) earlier —
                // `create` finds out when this number is taken, so skip the full read now.
                None => return Ok(None),
                Some((target, Some(i))) if self.is_copy(&i.url, &target, t).await? => {
                    return Ok(Some(target));
                }
                Some(_) => {}
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

    /// Create `t`: at its source number when free, else at the next free number (the body's
    /// header keeps the source number, and `imported.url` finds it again next run). A
    /// squatter on a number therefore costs the mirror nothing but the number. In a dry run
    /// the returned target is a placeholder (nothing reads it).
    async fn create(&mut self, t: &SrcTarget, noun: &str) -> Result<Created> {
        let mut number = t.number;
        for _ in 0..MAX_NUMBER_TRIES {
            match self.create_at(t, noun, number).await? {
                Ok(target) => return Ok(Created::New(target)),
                Err(why) => {
                    // Mirrored earlier at another number: the full index (loaded on the
                    // taken number) finds it.
                    if let Some(found) = self.indexed(t).await? {
                        return Ok(Created::Found(found));
                    }
                    tracing::info!(number, %why, "{noun} number taken; allocating another");
                    let repo = need(self.repo.as_ref())?;
                    number = self.collab.next_number(repo, t.kind).await?;
                }
            }
        }
        Ok(Created::NoNumber)
    }

    /// Create `t` at `number`. `Err(why)` when the number is taken.
    async fn create_at(
        &mut self,
        t: &SrcTarget,
        noun: &str,
        number: u32,
    ) -> Result<std::result::Result<Target, String>> {
        let placeholder = Target {
            kind: t.kind,
            id: String::new(),
            number,
            author: self.ledger.signer.clone().unwrap_or_default(),
        };
        let credits = collab_doc_credits(
            CollabDoc::Target,
            text_doc(&t.title) + t.body.len() as u64 + t.imported.url.len() as u64 + 90,
        );
        let (collab, repo) = (&self.collab, self.repo.as_ref());
        let what = format!("{noun} #{}", t.number);
        let out = match (t.kind, &t.patch) {
            (TargetKind::Patch, Some(p)) => {
                let input = PatchInput {
                    title: t.title.clone(),
                    body: t.body.clone(),
                    base_ref_name: p.base_ref_name.clone(),
                    source_repo_id: repo.map(|r| r.id().to_string()).unwrap_or_default(),
                    source_ref_name: p.source_ref_name.clone(),
                    head_oid: p.head_oid.clone(),
                    patch_manifest_hash: None,
                    draft: false,
                };
                let input = &input;
                self.ledger
                    .write(
                        what,
                        credits,
                        |_| {},
                        || async move {
                            collab
                                .create_patch_numbered(
                                    need(repo)?,
                                    number,
                                    input,
                                    Some(&t.imported),
                                )
                                .await
                        },
                    )
                    .await?
            }
            _ => {
                self.ledger
                    .write(
                        what,
                        credits,
                        |_| {},
                        || async move {
                            collab
                                .create_issue_numbered(
                                    need(repo)?,
                                    number,
                                    &t.title,
                                    &t.body,
                                    Some(&t.imported),
                                )
                                .await
                        },
                    )
                    .await?
            }
        };
        let created = |c: &mut Counts| match t.kind {
            TargetKind::Issue => c.issues += 1,
            TargetKind::Patch => c.prs += 1,
        };
        Ok(match out {
            None => {
                created(&mut self.ledger.counts);
                Ok(placeholder)
            }
            Some(Numbered::Created { document_id }) => {
                created(&mut self.ledger.counts);
                Ok(Target {
                    id: document_id,
                    ..placeholder
                })
            }
            Some(Numbered::Taken {
                existing_id,
                existing_author,
            }) => {
                // Nothing was stored (refused before the write, or by consensus, which
                // charges no storage); the reconcile keeps any fee actually taken.
                self.ledger.budget.refund(credits);
                // The number is held by someone else: the full index finds where this
                // item may already live before another number is allocated.
                self.load_index().await?;
                Err(format!(
                    "by {} ({})",
                    existing_author.unwrap_or_default(),
                    existing_id.unwrap_or_default()
                ))
            }
        })
    }

    /// `target`'s state as every reader folds it: a PR's merge counts only if its oid has
    /// been a valid tip of the base it was opened against ([`pr_base_tips`]), exactly the
    /// predicate forge-web and `dg` use, so "merged" here is "shown merged".
    async fn current(&mut self, t: &SrcTarget, target: &Target) -> Result<Current> {
        let repo = need(self.repo.as_ref())?;
        let log = self.collab.target_log(repo, &target.id).await?;
        Ok(match target.kind {
            TargetKind::Issue => {
                let s = fold_issue_state_v2(&log.events, &log.author_events, &target.author);
                Current {
                    open: s.open,
                    merged: false,
                    draft: false,
                    labels: s.labels,
                }
            }
            TargetKind::Patch => {
                let base = t
                    .patch
                    .as_ref()
                    .map_or("refs/heads/main", |p| p.base_ref_name.as_str());
                let tips = self.base_tips(&target.id, base, Freshness::Synced).await?;
                let s = fold_pr_state_v2(
                    &log.events,
                    &log.author_events,
                    &target.author,
                    tips.tip.as_deref(),
                    |oid, _| tips.contains(oid),
                    false,
                );
                Current {
                    open: s.open,
                    merged: s.merged,
                    draft: s.draft,
                    labels: s.labels,
                }
            }
        })
    }

    /// The member events that take `current` to `t`'s state, in order. `merge_proof` is the
    /// oid a merge event names ([`Sink::merge_proof`]): a pushed base tip containing the
    /// source's merge commit, which every reader counts; `None` when there is none.
    ///
    /// A PR the source merged gets a merge event when it can be proved, and otherwise a close
    /// (a merge into a base that is not mirrored, or no longer there): readers then show it
    /// closed, never open. Never both: a close after a counted merge would be delivered by
    /// the relay as a second, unmerged `closed`. A PR that reads closed but not merged (an
    /// older import, or a base pushed since) still takes a merge event, which the fold
    /// applies after a close, so a re-run repairs it. A merged PR is never reopened.
    fn state_events(
        t: &SrcTarget,
        current: &Current,
        merge_proof: Option<Vec<u8>>,
    ) -> Vec<StateEvent> {
        let mut out = Vec::new();
        for l in t.labels.difference(&current.labels) {
            out.push((EventKind::LabelAdd, Some(l.clone()), None));
        }
        for l in current.labels.difference(&t.labels) {
            out.push((EventKind::LabelRemove, Some(l.clone()), None));
        }
        if t.kind == TargetKind::Patch && t.draft != current.draft && !current.merged {
            out.push((
                if t.draft {
                    EventKind::Draft
                } else {
                    EventKind::Ready
                },
                None,
                None,
            ));
        }
        if current.merged {
            return out;
        }
        let closed = t.closed || t.merged_oid.is_some();
        if t.merged_oid.is_some() && merge_proof.is_some() {
            out.push((EventKind::Merge, None, merge_proof));
        } else if closed && current.open {
            out.push((EventKind::Close, None, None));
        } else if !closed && !current.open {
            out.push((EventKind::Reopen, None, None));
        }
        out
    }

    async fn sync_state(
        &mut self,
        t: &SrcTarget,
        target: &Target,
        current: &Current,
    ) -> Result<()> {
        let mut proof = None;
        if t.merged_oid.is_some() && !current.merged {
            proof = self.merge_proof(t, &target.id).await?;
            if proof.is_none() {
                let base = t.patch.as_ref().map_or("?", |p| p.base_ref_name.as_str());
                self.ledger.counts.unproved_merges += 1;
                self.ledger.warn(format!(
                    "{} was merged, but {}; recorded as closed",
                    t.imported.url,
                    no_proof_reason(self.mirror.as_ref(), base)
                ));
            }
        }
        let (collab, repo) = (&self.collab, self.repo.as_ref());
        for (kind, value, oid) in Self::state_events(t, current, proof) {
            let credits = collab_doc_credits(
                CollabDoc::Event,
                120 + value.as_deref().map_or(0, str::len) as u64,
            );
            let what = format!("{kind:?} event on #{}", t.number);
            let (value, oid) = (value.as_deref(), oid.as_deref());
            self.ledger
                .write(
                    what,
                    credits,
                    |c| c.events += 1,
                    || async move {
                        collab
                            .post_event(need(repo)?, target, kind, value, oid)
                            .await
                    },
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
fn chain_tip_containing(proof: &ProofRepo, tips: &MergeBaseTips, merged: &str) -> Option<String> {
    tips.historical
        .iter()
        .rev()
        .find(|tip| crate::gitsync::is_ancestor(&proof.dir, merged, tip))
        .cloned()
}

/// Why a merged PR into `base` has no merge proof, for its warning.
fn no_proof_reason(proof: Option<&ProofRepo>, base: &str) -> String {
    match proof {
        None => "this run has no git data to check the merge commit against (the base \
                 branches could not be fetched; see the warnings)"
            .into(),
        Some(p) if p.unfetched.contains(base) => {
            format!("its base {base} is no longer at the source")
        }
        Some(p) if p.pushed => format!(
            "no mirrored tip of its base {base} contains the merge commit (the base is not \
             mirrored, or was deleted)"
        ),
        Some(_) => format!(
            "no tip of its base {base} on chain contains the merge commit (this run syncs no \
             `code`: push the code first, then re-run the sync without --state)"
        ),
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
            labels: BTreeSet::new(),
            draft: false,
            patch: None,
            comments: Vec::new(),
            reviews: Vec::new(),
        }
    }

    fn kinds(v: &[StateEvent]) -> Vec<EventKind> {
        v.iter().map(|e| e.0).collect()
    }

    #[test]
    fn an_unchanged_target_needs_no_events() {
        let t = target(TargetKind::Issue);
        assert!(Sink::state_events(&t, &Current::new_target(), None).is_empty());
    }

    #[test]
    fn closing_labels_and_reopening_are_diffed() {
        let mut t = target(TargetKind::Issue);
        t.closed = true;
        t.labels = ["bug".to_string()].into();
        let mut cur = Current::new_target();
        cur.labels = ["old".to_string()].into();
        assert_eq!(
            kinds(&Sink::state_events(&t, &cur, None)),
            vec![
                EventKind::LabelAdd,
                EventKind::LabelRemove,
                EventKind::Close
            ]
        );
        // Closed on chain, open at the source again: reopen.
        let t = target(TargetKind::Issue);
        cur = Current {
            open: false,
            ..Current::new_target()
        };
        assert_eq!(
            kinds(&Sink::state_events(&t, &cur, None)),
            vec![EventKind::Reopen]
        );
    }

    /// D-602: the merge event names a base tip that contains the merge commit (every
    /// reader counts it), with no close after it (the relay delivered that as a second,
    /// unmerged `closed`). Without such a tip the PR is recorded closed.
    #[test]
    fn a_provable_merge_is_one_merge_event_and_an_unprovable_one_a_close() {
        let mut t = target(TargetKind::Patch);
        t.closed = true;
        t.merged_oid = Some(vec![1; 20]);
        let tip = vec![9; 20];
        let events = Sink::state_events(&t, &Current::new_target(), Some(tip.clone()));
        assert_eq!(kinds(&events), vec![EventKind::Merge]);
        assert_eq!(
            events[0].2.as_deref(),
            Some(&tip[..]),
            "the base tip, not the merge commit"
        );
        // Base not mirrored (or deleted): closed, never left open.
        assert_eq!(
            kinds(&Sink::state_events(&t, &Current::new_target(), None)),
            vec![EventKind::Close]
        );
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
        assert_eq!(missing, vec!["refs/heads/gone".to_string()]);
        let proof = ProofRepo {
            dir: proof_dir,
            pushed: false,
            unfetched: missing.into_iter().collect(),
        };
        let tips = MergeBaseTips {
            historical: vec![old_tip.clone(), pushed_tip_on_chain.clone()],
            tip: Some(pushed_tip_on_chain.clone()),
            current: Some(pushed_tip_on_chain.clone()),
        };
        assert_eq!(
            chain_tip_containing(&proof, &tips, &merge).as_deref(),
            Some(pushed_tip_on_chain.as_str()),
            "the chain's tip that contains the merge is named"
        );
        // Nothing is pushed without `code`: the fetched tip never stands in for the chain's.
        assert_eq!(pushed_tip(&proof, "refs/heads/main", &merge), None);
        // A chain that only shows the old tip cannot prove it: recorded closed, and said why.
        let old_only = MergeBaseTips {
            historical: vec![old_tip.clone()],
            tip: Some(old_tip.clone()),
            current: Some(old_tip),
        };
        assert_eq!(chain_tip_containing(&proof, &old_only, &merge), None);
        assert!(no_proof_reason(Some(&proof), "refs/heads/main").contains("push the code first"));
        assert!(
            no_proof_reason(Some(&proof), "refs/heads/gone").contains("no longer at the source")
        );
        assert!(no_proof_reason(None, "refs/heads/main").contains("could not be fetched"));

        // With `code`, the mirror's own tip counts (a dry run prices before the push).
        let pushed = ProofRepo {
            dir: src.clone(),
            pushed: true,
            unfetched: std::collections::BTreeSet::new(),
        };
        assert!(pushed_tip(&pushed, "refs/heads/main", &merge).is_some());
    }

    /// An earlier import left the PR closed-but-not-merged (the D-602 data): a re-run adds
    /// the merge event, which the fold applies after the close.
    #[test]
    fn a_closed_unmerged_import_is_repaired_by_a_merge_event() {
        let mut t = target(TargetKind::Patch);
        t.closed = true;
        t.merged_oid = Some(vec![1; 20]);
        let closed = Current {
            open: false,
            ..Current::new_target()
        };
        assert_eq!(
            kinds(&Sink::state_events(&t, &closed, Some(vec![9; 20]))),
            vec![EventKind::Merge]
        );
        // Still unprovable: nothing more to write (it already reads closed).
        assert!(Sink::state_events(&t, &closed, None).is_empty());
    }

    #[test]
    fn a_merged_pr_takes_no_more_state_events() {
        let mut t = target(TargetKind::Patch);
        t.closed = true;
        t.merged_oid = Some(vec![1; 20]);
        let done = Current {
            open: false,
            merged: true,
            ..Current::new_target()
        };
        assert!(Sink::state_events(&t, &done, Some(vec![9; 20])).is_empty());
        // Never reopened, whatever the source says; labels still follow the source.
        t.closed = false;
        t.merged_oid = None;
        t.labels = ["bug".to_string()].into();
        assert_eq!(
            kinds(&Sink::state_events(&t, &done, None)),
            vec![EventKind::LabelAdd]
        );
    }

    #[test]
    fn draft_changes_become_draft_and_ready_events() {
        let mut t = target(TargetKind::Patch);
        t.draft = true;
        assert_eq!(
            kinds(&Sink::state_events(&t, &Current::new_target(), None)),
            vec![EventKind::Draft]
        );
        t.draft = false;
        let cur = Current {
            draft: true,
            ..Current::new_target()
        };
        assert_eq!(
            kinds(&Sink::state_events(&t, &cur, None)),
            vec![EventKind::Ready]
        );
    }
}
