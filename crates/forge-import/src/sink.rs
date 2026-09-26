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

use forge_core::collab::v2::{
    issue_from_doc, patch_from_doc, Collab, Numbered, PatchInput, Target, TargetKind,
};
use forge_core::collab::{ReleaseInput, Verdict};
use forge_core::platform::{FieldValue, PlatformClient, QueryFilter, QueryOrder};
use forge_core::rules::v2::{fold_issue_state_v2, fold_pr_state_v2};
use forge_core::rules::EventKind;
use forge_core::scope::RepoRef;

use crate::budget::{collab_doc_credits, Budget};
use crate::model::{same_item, SrcCollab, SrcLabel, SrcRelease, SrcTarget};
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
        let out = f().await.with_context(|| format!("writing {what}"))?;
        self.reconcile().await;
        Ok(Some(out))
    }

    /// Pull the measured balance drop into the budget.
    pub async fn reconcile(&mut self) {
        if let Some(signer) = &self.signer {
            if let Ok(balance) = self.client.get_balance(signer).await {
                self.budget.reconcile(balance);
            }
        }
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
    /// The mirror's own issues and PRs in the destination, `(imported.url, target)`;
    /// loaded on first use.
    index: Option<Vec<(String, Target)>>,
}

/// Attempts at finding a free number for one item.
const MAX_NUMBER_TRIES: usize = 4;

/// Whether `e` concerns one item only (the destination refused its content), so the run
/// can skip it and carry on.
fn item_error(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        matches!(
            c.downcast_ref::<forge_core::Error>(),
            Some(forge_core::Error::Config(_) | forge_core::Error::DuplicateUniqueIndex(_))
        )
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
        }
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

    async fn sync_releases(&mut self, releases: &[SrcRelease]) -> Result<()> {
        let existing: BTreeMap<String, String> = match &self.repo {
            Some(repo) => self
                .collab
                .releases(repo)
                .await
                .context("reading the destination's releases")?
                .0
                .into_iter()
                .map(|r| {
                    let assets = serde_json::to_string(&r.assets).unwrap_or_default();
                    (r.tag_name, fingerprint(&r.name, &r.notes, &assets))
                })
                .collect(),
            None => BTreeMap::new(),
        };
        let (collab, repo) = (&self.collab, self.repo.as_ref());
        for r in releases {
            if r.tag_name.is_empty() || r.tag_name.len() > 63 {
                self.ledger.warn(format!(
                    "release tag {:?} does not fit the 63 bytes a release holds; skipped",
                    r.tag_name
                ));
                continue;
            }
            let assets = serde_json::to_string(&r.assets).unwrap_or_default();
            if existing.get(&r.tag_name) == Some(&fingerprint(&r.name, &r.notes, &assets)) {
                continue;
            }
            let input = ReleaseInput {
                tag_name: r.tag_name.clone(),
                name: r.name.clone(),
                notes: r.notes.clone(),
                yanked: false,
                assets: r.assets.clone(),
            };
            let credits = collab_doc_credits(
                (r.tag_name.len() + r.name.len() + r.notes.len() + assets.len() + 40) as u64,
            );
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
        let (target, fresh) = if let Some(target) = self.existing(t).await? {
            (target, false)
        } else if let Some(target) = self.create(t, noun).await? {
            if let Some(idx) = &mut self.index {
                idx.push((t.imported.url.clone(), target.clone()));
            }
            (target, true)
        } else {
            self.ledger.skip(format!(
                "{noun} #{} could not get a number (every candidate was taken); {} not \
                 mirrored this run",
                t.number, t.imported.url
            ));
            return Ok(());
        };
        let current = if fresh {
            Current::new_target()
        } else {
            self.current(&target).await?
        };
        self.sync_state(t, &target, &current).await?;
        self.sync_comments(t, &target, fresh).await?;
        if t.kind == TargetKind::Patch {
            self.sync_reviews(t, &target, fresh).await?;
        }
        Ok(())
    }

    /// The mirror's own imported issues and PRs already in the destination, by their
    /// `imported.url` key: every `issue` / `patch` of the repo written by the signer (by
    /// anyone in a dry run without one) that carries provenance. One complete read per kind,
    /// so an item is found wherever it landed (its source number, or an allocated one when
    /// that was taken).
    async fn load_index(&mut self) -> Result<()> {
        if self.index.is_some() {
            return Ok(());
        }
        let mut index = Vec::new();
        if let Some(repo) = &self.repo {
            let forge = repo.require_v2()?;
            let client = self.ledger.client;
            let collab = client.fetch_contract(&forge.collab).await?;
            let repo_id =
                FieldValue::identifier(forge_core::platform::decode_identifier(repo.id())?);
            for kind in [TargetKind::Issue, TargetKind::Patch] {
                let docs = client
                    .query_all_documents(
                        &collab,
                        kind.doc_type(),
                        &[QueryFilter::eq("repoId", repo_id.clone())],
                        &[QueryOrder::asc("$createdAt")],
                    )
                    .await
                    .with_context(|| format!("reading the destination's {}s", kind.noun()))?;
                for d in &docs {
                    let (target, imported) = match kind {
                        TargetKind::Issue => {
                            let i = issue_from_doc(d);
                            (i.target(), i.imported)
                        }
                        TargetKind::Patch => {
                            let p = patch_from_doc(d);
                            (p.target(), p.imported)
                        }
                    };
                    match imported {
                        Some(i) if !i.url.is_empty() && self.ledger.is_mine(&target.author) => {
                            index.push((i.url, target));
                        }
                        _ => {}
                    }
                }
            }
        }
        self.index = Some(index);
        Ok(())
    }

    /// The mirror's existing target for `t`, if any (tolerating a renamed source repo).
    async fn existing(&mut self, t: &SrcTarget) -> Result<Option<Target>> {
        self.load_index().await?;
        Ok(self.index.as_ref().and_then(|idx| {
            idx.iter()
                .find(|(url, target)| target.kind == t.kind && same_item(url, &t.imported.url))
                .map(|(_, target)| target.clone())
        }))
    }

    /// Create `t`: at its source number when free, else at the next free number (the body's
    /// header keeps the source number, and `imported.url` finds it again next run). A
    /// squatter on a number therefore costs the mirror nothing but the number. In a dry run
    /// the returned target is a placeholder (nothing reads it).
    async fn create(&mut self, t: &SrcTarget, noun: &str) -> Result<Option<Target>> {
        let mut number = t.number;
        for _ in 0..MAX_NUMBER_TRIES {
            match self.create_at(t, noun, number).await? {
                Ok(target) => return Ok(Some(target)),
                Err(why) => {
                    tracing::info!(number, %why, "{noun} number taken; allocating another");
                    let repo = need(self.repo.as_ref())?;
                    number = self.collab.next_number(repo, t.kind).await?;
                }
            }
        }
        Ok(None)
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
                };
                let input = &input;
                self.ledger
                    .write(
                        what,
                        credits,
                        |c| c.prs += 1,
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
                        |c| c.issues += 1,
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
        Ok(match out {
            None => Ok(placeholder),
            Some(Numbered::Created { document_id }) => Ok(Target {
                id: document_id,
                ..placeholder
            }),
            Some(Numbered::Taken {
                existing_id,
                existing_author,
            }) => Err(format!(
                "by {} ({})",
                existing_author.unwrap_or_default(),
                existing_id.unwrap_or_default()
            )),
        })
    }

    async fn current(&self, target: &Target) -> Result<Current> {
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
                // `merged`: whether a merge was RECORDED (so it is never written twice).
                // `open`: what a reader that cannot prove the merge reachable shows — an
                // imported merge commit was never a tip of the mirror's base branch, so
                // such readers ignore it, and the mirror also records a close.
                let fold = |reachable: bool| {
                    fold_pr_state_v2(
                        &log.events,
                        &log.author_events,
                        &target.author,
                        Some(""),
                        |_, _| reachable,
                    )
                };
                let (recorded, strict) = (fold(true), fold(false));
                Current {
                    open: strict.open,
                    merged: recorded.merged,
                    draft: strict.draft,
                    labels: strict.labels,
                }
            }
        })
    }

    /// The member events that take `current` to `t`'s state, in order.
    fn state_events(t: &SrcTarget, current: &Current) -> Vec<StateEvent> {
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
        if let (Some(oid), false) = (&t.merged_oid, current.merged) {
            out.push((EventKind::Merge, None, Some(oid.clone())));
        }
        // A merged PR is closed too: readers that cannot prove an imported merge reachable
        // (it was never a tip of the mirror's base) then show it closed, not open; exact
        // readers still show it merged (a close after a merge changes nothing for them).
        let closed = t.closed || t.merged_oid.is_some();
        if closed && current.open {
            out.push((EventKind::Close, None, None));
        } else if !closed && !current.open && !current.merged {
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
        let (collab, repo) = (&self.collab, self.repo.as_ref());
        for (kind, value, oid) in Self::state_events(t, current) {
            let credits = collab_doc_credits(120 + value.as_deref().map_or(0, str::len) as u64);
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
            .filter(|c| !done.iter().any(|u| same_item(u, &c.imported.url)))
        {
            let credits = collab_doc_credits(text_doc(&c.body) + c.imported.url.len() as u64);
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
            .filter(|r| !done.iter().any(|u| same_item(u, &r.imported.url)))
        {
            let credits = collab_doc_credits(text_doc(&r.body) + r.imported.url.len() as u64 + 40);
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

fn fingerprint(name: &str, notes: &str, assets: &str) -> String {
    format!("{name}\0{notes}\0{assets}")
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(Sink::state_events(&t, &Current::new_target()).is_empty());
    }

    #[test]
    fn closing_labels_and_reopening_are_diffed() {
        let mut t = target(TargetKind::Issue);
        t.closed = true;
        t.labels = ["bug".to_string()].into();
        let mut cur = Current::new_target();
        cur.labels = ["old".to_string()].into();
        assert_eq!(
            kinds(&Sink::state_events(&t, &cur)),
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
            kinds(&Sink::state_events(&t, &cur)),
            vec![EventKind::Reopen]
        );
    }

    #[test]
    fn a_merge_is_written_once_with_a_close_for_strict_readers() {
        let mut t = target(TargetKind::Patch);
        t.closed = true;
        t.merged_oid = Some(vec![1; 20]);
        assert_eq!(
            kinds(&Sink::state_events(&t, &Current::new_target())),
            vec![EventKind::Merge, EventKind::Close]
        );
        // Merge recorded, but a strict reader still sees it open (the first run was
        // interrupted between the two): only the close is missing.
        let recorded_open = Current {
            merged: true,
            ..Current::new_target()
        };
        assert_eq!(
            kinds(&Sink::state_events(&t, &recorded_open)),
            vec![EventKind::Close]
        );
        let done = Current {
            open: false,
            merged: true,
            ..Current::new_target()
        };
        assert!(Sink::state_events(&t, &done).is_empty());
        // A merged PR is never reopened, whatever the source says.
        t.closed = false;
        t.merged_oid = None;
        assert!(Sink::state_events(&t, &done).is_empty());
    }

    #[test]
    fn draft_changes_become_draft_and_ready_events() {
        let mut t = target(TargetKind::Patch);
        t.draft = true;
        assert_eq!(
            kinds(&Sink::state_events(&t, &Current::new_target())),
            vec![EventKind::Draft]
        );
        t.draft = false;
        let cur = Current {
            draft: true,
            ..Current::new_target()
        };
        assert_eq!(kinds(&Sink::state_events(&t, &cur)), vec![EventKind::Ready]);
    }
}
