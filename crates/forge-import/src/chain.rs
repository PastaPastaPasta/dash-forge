//! What the [`crate::sink::Sink`] reads from and writes to the destination, as one trait: the
//! production [`CollabChain`] over forge-core's `Collab`, and an in-memory chain in the tests
//! (`crate::sink_tests`), so the importer's diff, resume and pipelining run offline.
//!
//! Every method is one of `Collab`'s (or the client's), narrowed to what the sink uses: a
//! target's state as the sink compares it ([`Current`]), and a thread's comments and reviews
//! as who wrote them and which source item each copies ([`Written`]).

use std::collections::BTreeSet;

use forge_core::collab::v2::{
    Collab, Created, ImportedRow, ImportedTarget, Provenance, Target, TargetKind,
};
use forge_core::collab::{CommentAnchor, Imported, Label, Release, ReleaseInput, Verdict};
use forge_core::history::Freshness;
use forge_core::platform::PlatformClient;
use forge_core::rules::v2::{issue_state_v2, pr_state_v2, ClosedAs, TransitionMove, Visibility};
use forge_core::rules::{EventKind, MergeBaseTips};
use forge_core::scope::RepoRef;
use forge_core::Result;

use crate::model::SrcRelease;
use crate::sealed_release::{CollabDest, ReleaseStorage, ReleaseTargets};
use crate::sink::Ledger;

/// A target's state on chain: its state code (the sum of its transitions) and its labels.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Current {
    /// The state code.
    pub code: i64,
    /// The labels, as every reader folds the target's events.
    pub labels: BTreeSet<String>,
}

/// A comment or review already on a target: who wrote it and which source item it copies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Written {
    /// Its document `$id` (what a reply's `replyTo` and a review comment's `reviewId` name).
    pub id: String,
    /// Its author (a review's reviewer).
    pub author: String,
    /// Its `imported.url`, when it was imported.
    pub url: Option<String>,
}

/// The destination operations the sink needs. Async methods on `&self`: the pipelined write
/// phase calls them from several lanes at once.
#[allow(async_fn_in_trait)] // used through generics only, never boxed or sent
pub trait Chain {
    /// The `kind` documents of `repo` whose `upstreamNumber` is `n`.
    async fn upstream_targets(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        n: u32,
    ) -> Result<Vec<ImportedRow>>;
    /// The `kind` documents carrying an `upstreamNumber`, highest first: one page, or `all`.
    async fn upstream_numbered(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        all: bool,
    ) -> Result<Vec<ImportedRow>>;
    /// Every issue and PR of `repo` with its provenance.
    async fn imported_targets(&self, repo: &RepoRef) -> Result<Vec<ImportedRow>>;
    /// `target`'s state code and labels.
    async fn current(&self, repo: &RepoRef, target: &Target) -> Result<Current>;
    /// The comments on `target_id`.
    async fn comments(&self, repo: &RepoRef, target_id: &str) -> Result<Vec<Written>>;
    /// The reviews of `patch_id`.
    async fn reviews(&self, repo: &RepoRef, patch_id: &str) -> Result<Vec<Written>>;
    /// The destination's members (maintainers and writers).
    async fn members(&self, repo: &RepoRef) -> Result<BTreeSet<String>>;
    /// The label definitions.
    async fn labels(&self, repo: &RepoRef) -> Result<Vec<Label>>;
    /// The release of each live tag.
    async fn releases(&self, repo: &RepoRef) -> Result<Vec<Release>>;
    /// The tips a merge into `base_ref` (of a PR opened at `opened_at`) is checked against.
    async fn merge_base(
        &self,
        repo: &RepoRef,
        base_ref: &str,
        opened_at: u64,
        freshness: Freshness,
    ) -> Result<MergeBaseTips>;
    /// Forget cached ref updates (this process pushed since they were read).
    fn refs_changed(&self);
    /// `identity`'s balance now, when it can be read.
    async fn balance(&self, identity: &str) -> Option<u64>;

    /// Create an imported issue or PR at the dense next number.
    async fn create_imported(
        &self,
        repo: &RepoRef,
        what: ImportedTarget<'_>,
        from: Provenance<'_>,
    ) -> Result<Created>;
    /// Comment on `target_id`.
    async fn comment(
        &self,
        repo: &RepoRef,
        target_id: &str,
        body: &str,
        anchor: Option<&CommentAnchor>,
        imported: &Imported,
    ) -> Result<String>;
    /// Review `patch_id` (always a comment verdict: see [`crate::sink`]), announcing the
    /// `comment_count` comments that name it.
    async fn review(
        &self,
        repo: &RepoRef,
        patch_id: &str,
        commit_oid: &[u8],
        body: &str,
        comment_count: Option<u16>,
        imported: &Imported,
    ) -> Result<String>;
    /// A member label event on `target`.
    async fn post_event(
        &self,
        repo: &RepoRef,
        target: &Target,
        kind: EventKind,
        value: &str,
    ) -> Result<String>;
    /// The state transition `mv` on `target`, with an issue close's reason (`closed`).
    async fn write_transition(
        &self,
        repo: &RepoRef,
        target: &Target,
        mv: &TransitionMove,
        merge_oid: Option<&[u8]>,
        closed: Option<&ClosedAs>,
    ) -> Result<String>;
    /// Define a label.
    async fn create_label(
        &self,
        repo: &RepoRef,
        name: &str,
        color: &str,
        description: &str,
    ) -> Result<String>;
    /// Publish a release.
    async fn create_release(&self, repo: &RepoRef, input: &ReleaseInput) -> Result<String>;
    /// A private destination's releases, sealed ([`crate::sealed_release::sync`]), their files
    /// and asset lists stored on `storage`.
    async fn sync_sealed_releases(
        &self,
        ledger: &mut Ledger<'_>,
        repo: &RepoRef,
        releases: &[SrcRelease],
        storage: Option<&ReleaseStorage>,
    ) -> anyhow::Result<()>;
}

/// The destination on Dash Platform, through forge-core's `Collab`.
pub struct CollabChain<'a> {
    collab: Collab<'a>,
    client: &'a PlatformClient,
}

impl<'a> CollabChain<'a> {
    /// The destination read (and, with a signer, written) through `collab`.
    pub fn new(client: &'a PlatformClient, collab: Collab<'a>) -> Self {
        Self { collab, client }
    }
}

impl Chain for CollabChain<'_> {
    async fn upstream_targets(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        n: u32,
    ) -> Result<Vec<ImportedRow>> {
        self.collab.upstream_targets(repo, kind, n).await
    }

    async fn upstream_numbered(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        all: bool,
    ) -> Result<Vec<ImportedRow>> {
        self.collab.upstream_numbered(repo, kind, all).await
    }

    async fn imported_targets(&self, repo: &RepoRef) -> Result<Vec<ImportedRow>> {
        // through Collab: a private destination's provenance is sealed (§7)
        self.collab.imported_targets(repo).await
    }

    async fn current(&self, repo: &RepoRef, target: &Target) -> Result<Current> {
        let log = self.collab.target_log(repo, &target.id).await?;
        let code = log.state_code();
        let labels = match target.kind {
            TargetKind::Issue => issue_state_v2(code, &log.events).labels,
            TargetKind::Patch => pr_state_v2(code, None, &log.events, None, |_, _| false).labels,
        };
        Ok(Current { code, labels })
    }

    async fn comments(&self, repo: &RepoRef, target_id: &str) -> Result<Vec<Written>> {
        Ok(self
            .collab
            .comments(repo, target_id)
            .await?
            .into_iter()
            .map(|c| Written {
                id: c.document_id,
                author: c.author,
                url: c.imported.map(|i| i.url),
            })
            .collect())
    }

    async fn reviews(&self, repo: &RepoRef, patch_id: &str) -> Result<Vec<Written>> {
        Ok(self
            .collab
            .reviews(repo, patch_id)
            .await?
            .into_iter()
            .map(|r| Written {
                id: r.document_id,
                author: r.reviewer,
                url: r.imported.map(|i| i.url),
            })
            .collect())
    }

    async fn members(&self, repo: &RepoRef) -> Result<BTreeSet<String>> {
        Ok(forge_core::members::MemberReader::new(self.client)
            .list(repo)
            .await?
            .into_iter()
            .map(|m| m.identity_id)
            .collect())
    }

    async fn labels(&self, repo: &RepoRef) -> Result<Vec<Label>> {
        self.collab.labels(repo).await
    }

    async fn releases(&self, repo: &RepoRef) -> Result<Vec<Release>> {
        Ok(self.collab.releases(repo).await?.current)
    }

    async fn merge_base(
        &self,
        repo: &RepoRef,
        base_ref: &str,
        opened_at: u64,
        freshness: Freshness,
    ) -> Result<MergeBaseTips> {
        // A private repo's ref names are sealed: Collab reads (and caches) its updates.
        if repo.visibility == Visibility::Private {
            return self.collab.base_ref_tips(repo, base_ref, opened_at).await;
        }
        let core = self.client.fetch_contract(&repo.forge().core).await?;
        forge_core::refs::read_merge_base(
            self.client,
            &core,
            &repo.scope()?,
            base_ref,
            opened_at,
            freshness,
        )
        .await
    }

    fn refs_changed(&self) {
        self.collab.refs_changed();
    }

    async fn balance(&self, identity: &str) -> Option<u64> {
        self.client.get_balance(identity).await.ok()
    }

    async fn create_imported(
        &self,
        repo: &RepoRef,
        what: ImportedTarget<'_>,
        from: Provenance<'_>,
    ) -> Result<Created> {
        self.collab.create_imported(repo, what, from).await
    }

    async fn comment(
        &self,
        repo: &RepoRef,
        target_id: &str,
        body: &str,
        anchor: Option<&CommentAnchor>,
        imported: &Imported,
    ) -> Result<String> {
        self.collab
            .comment(repo, target_id, body, anchor, Some(imported))
            .await
    }

    async fn review(
        &self,
        repo: &RepoRef,
        patch_id: &str,
        commit_oid: &[u8],
        body: &str,
        comment_count: Option<u16>,
        imported: &Imported,
    ) -> Result<String> {
        self.collab
            .review(
                repo,
                patch_id,
                Verdict::Comment,
                commit_oid,
                body,
                comment_count,
                Some(imported),
            )
            .await
    }

    async fn post_event(
        &self,
        repo: &RepoRef,
        target: &Target,
        kind: EventKind,
        value: &str,
    ) -> Result<String> {
        self.collab
            .post_event(repo, target, kind, Some(value), None)
            .await
    }

    async fn write_transition(
        &self,
        repo: &RepoRef,
        target: &Target,
        mv: &TransitionMove,
        merge_oid: Option<&[u8]>,
        closed: Option<&ClosedAs>,
    ) -> Result<String> {
        self.collab
            .write_transition(repo, target, mv, merge_oid, closed)
            .await
    }

    async fn create_label(
        &self,
        repo: &RepoRef,
        name: &str,
        color: &str,
        description: &str,
    ) -> Result<String> {
        self.collab
            .create_label(repo, name, color, description, false)
            .await
    }

    async fn create_release(&self, repo: &RepoRef, input: &ReleaseInput) -> Result<String> {
        self.collab.create_release(repo, input).await
    }

    async fn sync_sealed_releases(
        &self,
        ledger: &mut Ledger<'_>,
        repo: &RepoRef,
        releases: &[SrcRelease],
        storage: Option<&ReleaseStorage>,
    ) -> anyhow::Result<()> {
        use anyhow::Context as _;
        let targets = storage
            .map(ReleaseStorage::targets)
            .transpose()
            .context("opening the release storage")?;
        let dest = CollabDest {
            collab: &self.collab,
            repo,
            store: targets.as_ref().map(ReleaseTargets::store),
        };
        let fetch = crate::assets::Https::default();
        crate::sealed_release::sync(ledger, &dest, releases, &fetch).await
    }
}
