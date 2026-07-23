//! Collaboration services — issues, pull requests, reviews, releases, labels, and the
//! registry social graph (stars / follows).
//!
//! These are the document-write + fold-read APIs the `dg` CLI and forge-web drive on top
//! of a repo contract (issues/PRs/comments/events/reviews/releases/labels) and the global
//! registry contract (stars/follows). Everything SDK-shaped is reached through
//! [`crate::platform`]; state resolution (issue/PR open-vs-closed, actor authorization) is
//! delegated to [`crate::rules`] — this module only fetches the raw documents and hands
//! them in (data-contracts §4).
//!
//! * [`IssueService`] — un-gated issue create (optimistic `number` = max+1 with
//!   unique-index retry), comment, append-only `event` log (close/reopen/label/assign),
//!   and state via [`crate::rules::fold_issue_state`].
//! * [`PullRequestService`] — `patch` create pointing at a fork contract, review verdicts,
//!   merge events, and state via [`crate::rules::fold_pr_state`].
//! * [`ReleaseService`] / [`LabelService`] — MAINTAIN-gated, append-only newest-wins.
//! * [`SocialService`] — registry star / unstar / follow / unfollow + O(1) count-tree
//!   totals.

use std::collections::BTreeMap;

use crate::backends::sha256;
use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::platform::{
    self, FieldValue, LoadedContract, LoadedIdentity, PlatformClient, QueryFilter, QueryOrder,
    WriteEngine,
};
use crate::rules::{self, AuthzResolver, Event, EventKind, IssueState, PrState};
use crate::tokens::TokenService;

// Repo-contract document types.
const DOC_ISSUE: &str = "issue";
const DOC_PATCH: &str = "patch";
const DOC_COMMENT: &str = "comment";
const DOC_EVENT: &str = "event";
const DOC_REVIEW: &str = "review";
const DOC_LABEL: &str = "label";
const DOC_RELEASE: &str = "release";
const DOC_REF_UPDATE: &str = "refUpdate";
const DOC_PROTECTED_REF_UPDATE: &str = "protectedRefUpdate";
// Registry-contract document types.
const DOC_STAR: &str = "star";
const DOC_FOLLOW: &str = "follow";

/// Max attempts to allocate an optimistic `number` before giving up (each retry bumps the
/// number past the collision the previous attempt hit).
const MAX_NUMBER_ATTEMPTS: u32 = 8;

/// Build a HIGH-key document write/delete engine over `client` for `identity`.
///
/// Document create/delete accept a HIGH auth key (S0.7); only token admin needs CRITICAL.
fn doc_engine<'a>(
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
) -> Result<WriteEngine<'a>> {
    WriteEngine::new(client, identity, bridge.doc_op_key()?)
}

/// Fail fast on a text field that exceeds its contract `maxLength`, before spending a
/// broadcast on a create consensus will reject. Counts Unicode scalar values (the
/// client-side approximation; consensus is authoritative).
fn check_len(field: &str, value: &str, max: usize) -> Result<()> {
    let len = value.chars().count();
    if len > max {
        return Err(Error::Config(format!(
            "{field} too long: {len} chars (max {max})"
        )));
    }
    Ok(())
}

/// Importer provenance (the `imported` object on `issue` / `patch` / `comment` / `review`
/// documents, data-contracts §2.3): the original author login, the original creation time
/// (unix seconds), and the source URL. Recorded because Platform `$createdAt` is consensus
/// time, not the original artifact's time — clients render this provenance for migrated
/// docs and (via the gist-claim flow, PRD 06) can later attribute a placeholder `author`
/// login to a real Dash identity.
#[derive(Debug, Clone, Default)]
pub struct Imported {
    /// Original author handle (e.g. a GitHub login), ≤ 120 chars.
    pub author: String,
    /// Original creation time, unix seconds.
    pub created_at: u64,
    /// Source URL of the original artifact, ≤ 300 chars.
    pub url: String,
}

impl Imported {
    /// Build the nested `imported` object field, validating the string lengths.
    fn to_field(&self) -> Result<FieldValue> {
        check_len("imported author", &self.author, 120)?;
        check_len("imported url", &self.url, 300)?;
        let mut map = BTreeMap::new();
        if !self.author.is_empty() {
            map.insert("author".to_string(), FieldValue::text(&self.author));
        }
        // Full-width u64: `createdAt` is an unbounded nested-object integer that Drive stores
        // as U64; a minimal-width encoding fails proof verification (see FieldValue::Uint64).
        map.insert("createdAt".to_string(), FieldValue::uint64(self.created_at));
        if !self.url.is_empty() {
            map.insert("url".to_string(), FieldValue::text(&self.url));
        }
        Ok(FieldValue::Object(map))
    }
}

/// Insert the `imported` provenance object into `props` when present (no-op for `None`).
fn insert_imported(
    props: &mut BTreeMap<String, FieldValue>,
    imported: Option<&Imported>,
) -> Result<()> {
    if let Some(i) = imported {
        props.insert("imported".to_string(), i.to_field()?);
    }
    Ok(())
}

/// Map a [`crate::rules::EventKind`] to its stored numeric `kind` (data-contracts §2.3).
fn event_kind_to_u64(kind: EventKind) -> u64 {
    match kind {
        EventKind::Close => 1,
        EventKind::Reopen => 2,
        EventKind::Merge => 3,
        EventKind::LabelAdd => 4,
        EventKind::LabelRemove => 5,
        EventKind::Assign => 6,
        EventKind::Unassign => 7,
        EventKind::Retarget => 8,
        EventKind::Draft => 9,
        EventKind::Ready => 10,
    }
}

/// Map a stored numeric `kind` back to a [`crate::rules::EventKind`] (unknown → `None`).
fn u64_to_event_kind(kind: u64) -> Option<EventKind> {
    Some(match kind {
        1 => EventKind::Close,
        2 => EventKind::Reopen,
        3 => EventKind::Merge,
        4 => EventKind::LabelAdd,
        5 => EventKind::LabelRemove,
        6 => EventKind::Assign,
        7 => EventKind::Unassign,
        8 => EventKind::Retarget,
        9 => EventKind::Draft,
        10 => EventKind::Ready,
        _ => return None,
    })
}

/// The next optimistic `number` for a numbered type (`issue` / `patch`): newest number + 1,
/// or 1 for the first. A concurrent create can still collide on the unique `number` index —
/// the caller retries, incrementing.
async fn next_number(
    client: &PlatformClient,
    contract: &LoadedContract,
    doc_type: &str,
) -> Result<u64> {
    let docs = client
        .query_documents(
            contract,
            doc_type,
            &[],
            &[QueryOrder::desc("number")],
            1,
            None,
        )
        .await?;
    Ok(docs
        .into_iter()
        .next()
        .and_then(|d| d.field_u64("number"))
        .map_or(1, |n| n + 1))
}

// ===========================================================================
// Issues
// ===========================================================================

/// An issue document, flattened.
#[derive(Debug, Clone)]
pub struct Issue {
    /// The issue number (unique within the repo).
    pub number: u64,
    /// Document `$id`.
    pub document_id: String,
    /// Author `$ownerId` (base58).
    pub author: String,
    /// Title.
    pub title: String,
    /// Body (may be empty).
    pub body: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// An issue with its resolved [`crate::rules::IssueState`] (open/closed + labels/assignees).
#[derive(Debug, Clone)]
pub struct IssueWithState {
    /// The issue document.
    pub issue: Issue,
    /// The event-fold state.
    pub state: IssueState,
}

/// Filter for [`IssueService::list_issues`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateFilter {
    /// Every issue.
    All,
    /// Only open issues.
    Open,
    /// Only closed issues.
    Closed,
}

/// Optional review/inline anchor for a [`IssueService::comment`].
#[derive(Debug, Clone, Default)]
pub struct CommentAnchor {
    /// Parent comment `$id` (a threaded reply).
    pub reply_to: Option<String>,
    /// Anchored commit oid.
    pub commit_oid: Option<Vec<u8>>,
    /// Anchored file path.
    pub path: Option<String>,
    /// Anchored line.
    pub line: Option<u64>,
    /// Diff side (0/1).
    pub side: Option<u64>,
}

/// The issue service, bound to one acting identity and its keys.
pub struct IssueService<'a> {
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
}

impl<'a> IssueService<'a> {
    /// Bind the service.
    pub fn new(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
    ) -> Self {
        Self {
            client,
            identity,
            bridge,
        }
    }

    /// Create an issue (un-gated — §2.2). `number` is optimistically `max+1`, retried on a
    /// unique-index collision (a concurrent create took the number). Returns the [`Issue`].
    pub async fn create_issue(
        &self,
        repo_contract_id: &str,
        title: &str,
        body: &str,
    ) -> Result<Issue> {
        self.create_issue_imported(repo_contract_id, title, body, None)
            .await
    }

    /// Create an issue carrying importer [`Imported`] provenance (PRD 06). Identical to
    /// [`IssueService::create_issue`] but records the original author / creation time / URL
    /// in the doc's `imported` object. `imported = None` is exactly [`create_issue`].
    pub async fn create_issue_imported(
        &self,
        repo_contract_id: &str,
        title: &str,
        body: &str,
        imported: Option<&Imported>,
    ) -> Result<Issue> {
        check_len("issue title", title, 256)?;
        check_len("issue body", body, 5120)?;
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let engine = doc_engine(self.client, self.identity, self.bridge)?;

        let mut number = next_number(self.client, &contract, DOC_ISSUE).await?;
        for _ in 0..MAX_NUMBER_ATTEMPTS {
            let mut props = BTreeMap::new();
            props.insert("number".to_string(), FieldValue::integer(number));
            props.insert("title".to_string(), FieldValue::text(title));
            if !body.is_empty() {
                props.insert("body".to_string(), FieldValue::text(body));
            }
            insert_imported(&mut props, imported)?;
            match engine.create_document(&contract, DOC_ISSUE, props).await {
                Ok(document_id) => {
                    return Ok(Issue {
                        number,
                        document_id,
                        author: self.identity.id(),
                        title: title.to_string(),
                        body: body.to_string(),
                        created_at: 0,
                    });
                }
                // Every collision retries with the next number; only after exhausting all
                // attempts do we surface the friendly "exhausted" error (the final-attempt
                // duplicate must not leak the raw DuplicateUniqueIndex).
                Err(Error::DuplicateUniqueIndex(_)) => {
                    number += 1;
                    tracing::warn!(number, "issue number collision; retrying with next number");
                }
                Err(e) => return Err(e),
            }
        }
        Err(Error::Platform(
            "exhausted issue-number allocation attempts".into(),
        ))
    }

    /// Fetch a single issue by number.
    pub async fn get_issue(&self, repo_contract_id: &str, number: u64) -> Result<Option<Issue>> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let docs = self
            .client
            .query_documents(
                &contract,
                DOC_ISSUE,
                &[QueryFilter::eq("number", FieldValue::integer(number))],
                &[],
                1,
                None,
            )
            .await?;
        Ok(docs.into_iter().next().map(|d| issue_from_doc(&d)))
    }

    /// List issues, newest first, folding each one's `event` log into its state and
    /// filtering by `filter`. `limit` (0 = server default ~100) and `start_after` (a base58
    /// issue `$id`) paginate the underlying `issue` query — the state fold runs per page.
    pub async fn list_issues(
        &self,
        repo_contract_id: &str,
        filter: StateFilter,
        limit: u32,
        start_after: Option<&str>,
    ) -> Result<Vec<IssueWithState>> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let docs = self
            .client
            .query_documents(
                &contract,
                DOC_ISSUE,
                &[],
                &[QueryOrder::desc("$createdAt")],
                limit,
                start_after,
            )
            .await?;

        // One AuthzResolver for the page (token history is repo-wide, not per-issue).
        let authz = self.authz(repo_contract_id).await?;

        let mut out = Vec::new();
        for d in &docs {
            let issue = issue_from_doc(d);
            let events = self.fetch_events(&contract, &issue.document_id).await?;
            let state = rules::fold_issue_state(&events, &issue.author, &authz);
            let keep = match filter {
                StateFilter::All => true,
                StateFilter::Open => state.open,
                StateFilter::Closed => !state.open,
            };
            if keep {
                out.push(IssueWithState { issue, state });
            }
        }
        Ok(out)
    }

    /// Post a comment on an issue/PR (`target_id` = its base58 `$id`). Un-gated. Returns the
    /// comment document id.
    pub async fn comment(
        &self,
        repo_contract_id: &str,
        target_id: &str,
        body: &str,
        anchor: Option<&CommentAnchor>,
    ) -> Result<String> {
        self.comment_imported(repo_contract_id, target_id, body, anchor, None)
            .await
    }

    /// Post a comment carrying importer [`Imported`] provenance (PRD 06). `imported = None`
    /// is exactly [`IssueService::comment`].
    pub async fn comment_imported(
        &self,
        repo_contract_id: &str,
        target_id: &str,
        body: &str,
        anchor: Option<&CommentAnchor>,
        imported: Option<&Imported>,
    ) -> Result<String> {
        check_len("comment body", body, 5120)?;
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let engine = doc_engine(self.client, self.identity, self.bridge)?;

        let mut props = BTreeMap::new();
        insert_imported(&mut props, imported)?;
        props.insert(
            "targetId".to_string(),
            FieldValue::identifier(platform::decode_identifier(target_id)?),
        );
        props.insert("body".to_string(), FieldValue::text(body));
        if let Some(a) = anchor {
            if let Some(reply_to) = &a.reply_to {
                props.insert(
                    "replyTo".to_string(),
                    FieldValue::identifier(platform::decode_identifier(reply_to)?),
                );
            }
            if let Some(oid) = &a.commit_oid {
                props.insert("commitOid".to_string(), FieldValue::bytes(oid.clone()));
            }
            if let Some(path) = &a.path {
                props.insert("path".to_string(), FieldValue::text(path));
            }
            if let Some(line) = a.line {
                props.insert("line".to_string(), FieldValue::integer(line));
            }
            if let Some(side) = a.side {
                props.insert("side".to_string(), FieldValue::integer(side));
            }
        }
        engine.create_document(&contract, DOC_COMMENT, props).await
    }

    /// Append an `event` to the append-only state log (close/reopen/label/assign/…). The
    /// event is authoritative only if the fold deems the actor authorized as-of its
    /// `$createdAt` (§4) — a stranger's event lands on-chain but is inert. Returns the
    /// event document id.
    pub async fn add_event(
        &self,
        repo_contract_id: &str,
        target_id: &str,
        kind: EventKind,
        value: Option<&str>,
        oid: Option<&[u8]>,
    ) -> Result<String> {
        // Injection defense (write-side, mirrors repo.rs's refUpdate guard): a `Retarget`
        // event's `value` is a base ref name written into un-gated event data, so a
        // token-less identity could plant a newline/NUL/leading-dash name that spoofs a
        // ref-advertisement line once a client renders it. Reject illegal names up front.
        if matches!(kind, EventKind::Retarget) {
            match value {
                Some(v) if rules::is_legal_ref_name(v) => {}
                _ => {
                    return Err(Error::Config(format!(
                        "illegal retarget base ref name {value:?}: must be non-empty, no \
                         leading '-', no whitespace/control characters"
                    )))
                }
            }
        }
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let engine = doc_engine(self.client, self.identity, self.bridge)?;
        post_event(&engine, &contract, target_id, kind, value, oid).await
    }

    /// Convenience: close an issue/PR.
    pub async fn close(&self, repo_contract_id: &str, target_id: &str) -> Result<String> {
        self.add_event(repo_contract_id, target_id, EventKind::Close, None, None)
            .await
    }

    /// Convenience: reopen an issue/PR.
    pub async fn reopen(&self, repo_contract_id: &str, target_id: &str) -> Result<String> {
        self.add_event(repo_contract_id, target_id, EventKind::Reopen, None, None)
            .await
    }

    /// The O(1) total issue count (`documentsCountable` primary tree, §3).
    pub async fn issue_count(&self, repo_contract_id: &str) -> Result<u64> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        self.client.count_documents(&contract, DOC_ISSUE, &[]).await
    }

    /// Resolve one issue's state (fetch + fold), or `None` if the issue does not exist.
    pub async fn issue_state(
        &self,
        repo_contract_id: &str,
        number: u64,
    ) -> Result<Option<IssueWithState>> {
        let Some(issue) = self.get_issue(repo_contract_id, number).await? else {
            return Ok(None);
        };
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let events = self.fetch_events(&contract, &issue.document_id).await?;
        let authz = self.authz(repo_contract_id).await?;
        let state = rules::fold_issue_state(&events, &issue.author, &authz);
        Ok(Some(IssueWithState { issue, state }))
    }

    // --- internal ---

    /// Build the as-of-time authorization resolver from the repo's token history.
    async fn authz(&self, repo_contract_id: &str) -> Result<AuthzResolver> {
        let records = TokenService::new(self.client, self.identity, self.bridge)
            .token_history(repo_contract_id)
            .await?;
        Ok(AuthzResolver::new(records))
    }

    /// Fetch every `event` for a target, flattened to [`crate::rules::Event`].
    async fn fetch_events(&self, contract: &LoadedContract, target_id: &str) -> Result<Vec<Event>> {
        fetch_events(self.client, contract, target_id).await
    }
}

/// Build an [`Issue`] from a fetched document.
fn issue_from_doc(d: &platform::FetchedDocument) -> Issue {
    Issue {
        number: d.field_u64("number").unwrap_or_default(),
        document_id: d.id.clone(),
        author: d.owner_id.clone(),
        title: d.field_str("title").unwrap_or_default(),
        body: d.field_str("body").unwrap_or_default(),
        created_at: d.created_at.unwrap_or(0),
    }
}

/// Fetch every `event` for `target_id` (base58) in `contract`, as [`crate::rules::Event`]s.
async fn fetch_events(
    client: &PlatformClient,
    contract: &LoadedContract,
    target_id: &str,
) -> Result<Vec<Event>> {
    let target_bytes = platform::decode_identifier(target_id)?;
    // Paginate to exhaustion: event create is UN-GATED, so a stranger can post >100
    // throwaway events to bury real close/merge/label events past the ≤100-row page cap
    // and freeze the folded state forever. Every event must reach the fold.
    let docs = client
        .query_all_documents(
            contract,
            DOC_EVENT,
            &[QueryFilter::eq(
                "targetId",
                FieldValue::identifier(target_bytes),
            )],
            &[QueryOrder::asc("$createdAt")],
        )
        .await?;
    let mut events = Vec::new();
    for d in &docs {
        let Some(kind) = d.field_u64("kind").and_then(u64_to_event_kind) else {
            continue;
        };
        events.push(Event {
            id: d.id.clone(),
            target_id: target_id.to_string(),
            kind,
            actor: d.owner_id.clone(),
            value: d.field_str("value"),
            oid: d.field_hex("oid"),
            created_at: d.created_at.unwrap_or(0),
        });
    }
    Ok(events)
}

/// Post an `event` document (shared by issue + PR services).
async fn post_event(
    engine: &WriteEngine<'_>,
    contract: &LoadedContract,
    target_id: &str,
    kind: EventKind,
    value: Option<&str>,
    oid: Option<&[u8]>,
) -> Result<String> {
    let mut props = BTreeMap::new();
    props.insert(
        "targetId".to_string(),
        FieldValue::identifier(platform::decode_identifier(target_id)?),
    );
    props.insert(
        "kind".to_string(),
        FieldValue::integer(event_kind_to_u64(kind)),
    );
    if let Some(v) = value {
        props.insert("value".to_string(), FieldValue::text(v));
    }
    if let Some(o) = oid {
        props.insert("oid".to_string(), FieldValue::bytes(o.to_vec()));
    }
    engine.create_document(contract, DOC_EVENT, props).await
}

// ===========================================================================
// Pull requests
// ===========================================================================

/// Input for [`PullRequestService::create_pr`].
#[derive(Debug, Clone)]
pub struct PullRequestInput {
    /// PR title.
    pub title: String,
    /// PR body.
    pub body: String,
    /// Base ref name in the target repo, e.g. `refs/heads/main`.
    pub base_ref_name: String,
    /// The fork listing `$id` (registry), if known.
    pub source_listing_id: Option<String>,
    /// The fork **contract** id (base58) — where the PR's objects live.
    pub source_contract_id: String,
    /// The source ref name in the fork, e.g. `refs/heads/feature`.
    pub source_ref_name: Option<String>,
    /// Head commit oid (the PR tip).
    pub head_oid: Vec<u8>,
    /// `patchManifest` hash in the fork contract (32 bytes), if published.
    pub patch_manifest_hash: Option<[u8; 32]>,
}

/// A pull-request (`patch`) document, flattened.
#[derive(Debug, Clone)]
pub struct PullRequest {
    /// PR number (unique within the repo; independent of issue numbering).
    pub number: u64,
    /// Document `$id`.
    pub document_id: String,
    /// Author `$ownerId` (base58).
    pub author: String,
    /// Title.
    pub title: String,
    /// Body.
    pub body: String,
    /// Base ref name.
    pub base_ref_name: String,
    /// Head oid (hex).
    pub head_oid: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// A PR with its resolved [`crate::rules::PrState`].
#[derive(Debug, Clone)]
pub struct PullRequestWithState {
    /// The PR document.
    pub pr: PullRequest,
    /// The event-fold state.
    pub state: PrState,
}

/// The pull-request service.
pub struct PullRequestService<'a> {
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
}

impl<'a> PullRequestService<'a> {
    /// Bind the service.
    pub fn new(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
    ) -> Self {
        Self {
            client,
            identity,
            bridge,
        }
    }

    /// Create a `patch` (PR) in the **base** repo, un-gated, pointing at the fork contract
    /// (§2.3, §5.5). `number` is optimistic `max+1` with unique-index retry.
    pub async fn create_pr(
        &self,
        repo_contract_id: &str,
        input: &PullRequestInput,
    ) -> Result<PullRequest> {
        self.create_pr_imported(repo_contract_id, input, None).await
    }

    /// Create a `patch` (PR) carrying importer [`Imported`] provenance (PRD 06). This is the
    /// path forge-import uses for both open PRs and closed-PR archived metadata (title/diff/
    /// state, not full packs — §06). `imported = None` is exactly [`create_pr`].
    pub async fn create_pr_imported(
        &self,
        repo_contract_id: &str,
        input: &PullRequestInput,
        imported: Option<&Imported>,
    ) -> Result<PullRequest> {
        check_len("PR title", &input.title, 256)?;
        check_len("PR body", &input.body, 5120)?;
        // Injection defense (write-side, mirrors repo.rs's refUpdate guard): base/source
        // ref names are written into un-gated patch data, so an illegal name (newline/NUL/
        // leading-dash) could spoof a ref-advertisement line when rendered. Reject up front.
        if !rules::is_legal_ref_name(&input.base_ref_name) {
            return Err(Error::Config(format!(
                "illegal PR base ref name {:?}: must be non-empty, no leading '-', no \
                 whitespace/control characters",
                input.base_ref_name
            )));
        }
        if let Some(source_ref) = &input.source_ref_name {
            if !rules::is_legal_ref_name(source_ref) {
                return Err(Error::Config(format!(
                    "illegal PR source ref name {source_ref:?}: must be non-empty, no leading \
                     '-', no whitespace/control characters"
                )));
            }
        }
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let engine = doc_engine(self.client, self.identity, self.bridge)?;

        let base_ref_hash = sha256(input.base_ref_name.as_bytes());
        let source_contract = platform::decode_identifier(&input.source_contract_id)?;

        let mut number = next_number(self.client, &contract, DOC_PATCH).await?;
        for _ in 0..MAX_NUMBER_ATTEMPTS {
            let mut props = BTreeMap::new();
            props.insert("number".to_string(), FieldValue::integer(number));
            props.insert("title".to_string(), FieldValue::text(&input.title));
            if !input.body.is_empty() {
                props.insert("body".to_string(), FieldValue::text(&input.body));
            }
            props.insert(
                "baseRefNameHash".to_string(),
                FieldValue::bytes32(base_ref_hash),
            );
            props.insert(
                "baseRefName".to_string(),
                FieldValue::text(&input.base_ref_name),
            );
            props.insert(
                "sourceContractId".to_string(),
                FieldValue::identifier(source_contract),
            );
            if let Some(listing) = &input.source_listing_id {
                props.insert(
                    "sourceListingId".to_string(),
                    FieldValue::identifier(platform::decode_identifier(listing)?),
                );
            }
            if let Some(source_ref) = &input.source_ref_name {
                props.insert(
                    "sourceRefNameHash".to_string(),
                    FieldValue::bytes32(sha256(source_ref.as_bytes())),
                );
                props.insert("sourceRefName".to_string(), FieldValue::text(source_ref));
            }
            props.insert(
                "headOid".to_string(),
                FieldValue::bytes(input.head_oid.clone()),
            );
            if let Some(manifest) = input.patch_manifest_hash {
                props.insert(
                    "patchManifestHash".to_string(),
                    FieldValue::bytes32(manifest),
                );
            }
            insert_imported(&mut props, imported)?;

            match engine.create_document(&contract, DOC_PATCH, props).await {
                Ok(document_id) => {
                    return Ok(PullRequest {
                        number,
                        document_id,
                        author: self.identity.id(),
                        title: input.title.clone(),
                        body: input.body.clone(),
                        base_ref_name: input.base_ref_name.clone(),
                        head_oid: hex::encode(&input.head_oid),
                        created_at: 0,
                    });
                }
                Err(Error::DuplicateUniqueIndex(_)) => {
                    number += 1;
                    tracing::warn!(number, "PR number collision; retrying with next number");
                }
                Err(e) => return Err(e),
            }
        }
        Err(Error::Platform(
            "exhausted PR-number allocation attempts".into(),
        ))
    }

    /// Fetch a single PR by number.
    pub async fn get_pr(&self, repo_contract_id: &str, number: u64) -> Result<Option<PullRequest>> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let docs = self
            .client
            .query_documents(
                &contract,
                DOC_PATCH,
                &[QueryFilter::eq("number", FieldValue::integer(number))],
                &[],
                1,
                None,
            )
            .await?;
        Ok(docs.into_iter().next().map(|d| pr_from_doc(&d)))
    }

    /// List PRs, newest first (no state fold — cheap listing).
    pub async fn list_prs(
        &self,
        repo_contract_id: &str,
        limit: u32,
        start_after: Option<&str>,
    ) -> Result<Vec<PullRequest>> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let docs = self
            .client
            .query_documents(
                &contract,
                DOC_PATCH,
                &[],
                &[QueryOrder::desc("$createdAt")],
                limit,
                start_after,
            )
            .await?;
        Ok(docs.iter().map(pr_from_doc).collect())
    }

    /// Resolve one PR's [`crate::rules::PrState`] by folding its `event` log.
    ///
    /// ## Merge reachability (monotonic)
    ///
    /// `fold_pr_state` validates a `merge` event by `is_ancestor(merge_oid, base_tip)`.
    /// forge-core has no commit graph, so a naive reflexive `|a,b| a==b` stand-in is
    /// **wrong and non-monotonic**: it only accepts the merge while `base_tip == merge_oid`,
    /// so the instant any later commit advances the base ref the merge event is rejected and
    /// `merged` flips permanently back to `open`. Instead we approximate reachability with
    /// the **set of every oid that was ever a tip of the base ref** (walked from the base
    /// `refUpdate`/`protectedRefUpdate` history). That set only grows, so a merge whose oid
    /// was ever a valid base tip stays merged forever — the correct on-platform monotonic
    /// approximation. (A full git-backed ancestry predicate is strictly better but needs an
    /// object store; the historical-tips set is sound for the merged/open decision.)
    ///
    /// `base_tip` (hex) may be supplied by a caller that has resolved the current tip; when
    /// `None` the newest historical tip is used so the merge arm can fire.
    pub async fn pr_state(
        &self,
        repo_contract_id: &str,
        number: u64,
        base_tip: Option<&str>,
    ) -> Result<Option<PullRequestWithState>> {
        let Some(pr) = self.get_pr(repo_contract_id, number).await? else {
            return Ok(None);
        };
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let events = fetch_events(self.client, &contract, &pr.document_id).await?;
        let records = TokenService::new(self.client, self.identity, self.bridge)
            .token_history(repo_contract_id)
            .await?;
        let authz = AuthzResolver::new(records);

        let (historical_tips, newest_tip) =
            self.base_ref_tips(&contract, &pr.base_ref_name).await?;
        let effective_base_tip = base_tip.map(str::to_string).or(newest_tip);
        let state = rules::fold_pr_state(
            &events,
            &pr.author,
            &authz,
            effective_base_tip.as_deref(),
            |oid, _tip| historical_tips.contains(oid),
        );
        Ok(Some(PullRequestWithState { pr, state }))
    }

    /// Collect every oid that was ever a tip of `base_ref_name` (the monotonic merge-
    /// reachability set) plus the newest such tip. Walks the full `refUpdate` +
    /// `protectedRefUpdate` history for the ref (paginated), taking every non-null `newOid`.
    async fn base_ref_tips(
        &self,
        contract: &LoadedContract,
        base_ref_name: &str,
    ) -> Result<(std::collections::BTreeSet<String>, Option<String>)> {
        let ref_name_hash = sha256(base_ref_name.as_bytes());
        let mut tips: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut newest: Option<(u64, String, String)> = None; // (created_at, id, oid)
        for doc_type in [DOC_REF_UPDATE, DOC_PROTECTED_REF_UPDATE] {
            let docs = self
                .client
                .query_all_documents(
                    contract,
                    doc_type,
                    &[QueryFilter::eq(
                        "refNameHash",
                        FieldValue::bytes32(ref_name_hash),
                    )],
                    &[QueryOrder::asc("$createdAt")],
                )
                .await?;
            for d in &docs {
                let Some(oid) = d.field_hex("newOid") else {
                    continue;
                };
                if oid.is_empty() || oid.bytes().all(|b| b == b'0') {
                    continue; // null oid = ref deletion, never a reachable tip
                }
                tips.insert(oid.clone());
                let created_at = d.created_at.unwrap_or(0);
                let candidate = (created_at, d.id.clone(), oid);
                let better = match &newest {
                    None => true,
                    Some(n) => (n.0, &n.1) < (candidate.0, &candidate.1),
                };
                if better {
                    newest = Some(candidate);
                }
            }
        }
        Ok((tips, newest.map(|(_, _, oid)| oid)))
    }

    /// Post a `review` verdict on a PR (`1` approve, `2` request-changes, `3` comment).
    pub async fn review(
        &self,
        repo_contract_id: &str,
        patch_id: &str,
        verdict: u64,
        commit_oid: &[u8],
        body: &str,
    ) -> Result<String> {
        self.review_imported(repo_contract_id, patch_id, verdict, commit_oid, body, None)
            .await
    }

    /// Post a `review` verdict carrying importer [`Imported`] provenance (PRD 06).
    /// `imported = None` is exactly [`PullRequestService::review`].
    pub async fn review_imported(
        &self,
        repo_contract_id: &str,
        patch_id: &str,
        verdict: u64,
        commit_oid: &[u8],
        body: &str,
        imported: Option<&Imported>,
    ) -> Result<String> {
        check_len("review body", body, 5120)?;
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let engine = doc_engine(self.client, self.identity, self.bridge)?;
        let mut props = BTreeMap::new();
        insert_imported(&mut props, imported)?;
        props.insert(
            "patchId".to_string(),
            FieldValue::identifier(platform::decode_identifier(patch_id)?),
        );
        props.insert("verdict".to_string(), FieldValue::integer(verdict));
        props.insert(
            "commitOid".to_string(),
            FieldValue::bytes(commit_oid.to_vec()),
        );
        if !body.is_empty() {
            props.insert("body".to_string(), FieldValue::text(body));
        }
        engine.create_document(&contract, DOC_REVIEW, props).await
    }

    /// Post a `merge` event with the merge-commit `oid` (the actual git merge is done by the
    /// caller). Authoritative only if the fold accepts it (holder + reachable oid, §4).
    pub async fn merge_event(
        &self,
        repo_contract_id: &str,
        target_id: &str,
        merge_oid: &[u8],
    ) -> Result<String> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let engine = doc_engine(self.client, self.identity, self.bridge)?;
        post_event(
            &engine,
            &contract,
            target_id,
            EventKind::Merge,
            None,
            Some(merge_oid),
        )
        .await
    }

    /// The O(1) total PR count (`documentsCountable` primary tree, §3).
    pub async fn pr_count(&self, repo_contract_id: &str) -> Result<u64> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        self.client.count_documents(&contract, DOC_PATCH, &[]).await
    }
}

/// Build a [`PullRequest`] from a fetched document.
fn pr_from_doc(d: &platform::FetchedDocument) -> PullRequest {
    PullRequest {
        number: d.field_u64("number").unwrap_or_default(),
        document_id: d.id.clone(),
        author: d.owner_id.clone(),
        title: d.field_str("title").unwrap_or_default(),
        body: d.field_str("body").unwrap_or_default(),
        base_ref_name: d.field_str("baseRefName").unwrap_or_default(),
        head_oid: d.field_hex("headOid").unwrap_or_default(),
        created_at: d.created_at.unwrap_or(0),
    }
}

// ===========================================================================
// Releases
// ===========================================================================

/// A release asset (serialized into the `assets` JSON-string field, §0/§2.3).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReleaseAsset {
    /// Asset file name.
    pub name: String,
    /// Hex SHA-256 of the asset.
    pub sha256: String,
    /// Size in bytes.
    pub size_bytes: u64,
    /// Mirror URIs (≤ 4).
    pub uris: Vec<String>,
}

/// Input for [`ReleaseService::create_release`].
#[derive(Debug, Clone)]
pub struct ReleaseInput {
    /// Tag name (the logical key; newest doc per tag wins).
    pub tag_name: String,
    /// Display name.
    pub name: String,
    /// Release notes.
    pub notes: String,
    /// Whether this release is yanked.
    pub yanked: bool,
    /// Assets.
    pub assets: Vec<ReleaseAsset>,
}

/// A release document, flattened (newest per `tagName`).
#[derive(Debug, Clone)]
pub struct Release {
    /// Document `$id`.
    pub document_id: String,
    /// Tag name.
    pub tag_name: String,
    /// Display name.
    pub name: String,
    /// Notes.
    pub notes: String,
    /// Yanked flag.
    pub yanked: bool,
    /// Assets (parsed from the `assets` JSON-string field).
    pub assets: Vec<ReleaseAsset>,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// The release service (MAINTAIN-gated create; the owner holds MAINTAIN via `baseSupply`).
pub struct ReleaseService<'a> {
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
}

impl<'a> ReleaseService<'a> {
    /// Bind the service.
    pub fn new(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
    ) -> Self {
        Self {
            client,
            identity,
            bridge,
        }
    }

    /// Create (or supersede) a release for a tag. MAINTAIN-gated; append-only newest-wins
    /// (an edit / yank is a fresh doc, never a mutation of the old one, §2.2). Returns the
    /// document id.
    pub async fn create_release(
        &self,
        repo_contract_id: &str,
        input: &ReleaseInput,
    ) -> Result<String> {
        check_len("release tagName", &input.tag_name, 63)?;
        check_len("release name", &input.name, 120)?;
        check_len("release notes", &input.notes, 5120)?;
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let engine = doc_engine(self.client, self.identity, self.bridge)?;
        let mut props = BTreeMap::new();
        props.insert("tagName".to_string(), FieldValue::text(&input.tag_name));
        if !input.name.is_empty() {
            props.insert("name".to_string(), FieldValue::text(&input.name));
        }
        if !input.notes.is_empty() {
            props.insert("notes".to_string(), FieldValue::text(&input.notes));
        }
        props.insert("yanked".to_string(), FieldValue::boolean(input.yanked));
        if !input.assets.is_empty() {
            let json = serde_json::to_string(&input.assets)
                .map_err(|e| Error::Config(format!("serializing release assets: {e}")))?;
            props.insert("assets".to_string(), FieldValue::text(json));
        }
        engine.create_document(&contract, DOC_RELEASE, props).await
    }

    /// List releases, newest doc per `tagName` (newest-wins supersede resolution, §2.2),
    /// ordered newest first.
    pub async fn list_releases(&self, repo_contract_id: &str) -> Result<Vec<Release>> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let docs = self
            .client
            .query_documents(
                &contract,
                DOC_RELEASE,
                &[],
                &[QueryOrder::desc("$createdAt")],
                0,
                None,
            )
            .await?;

        // Keep the newest doc per tag ((createdAt, id) total order; docs already desc).
        let mut newest: BTreeMap<String, Release> = BTreeMap::new();
        for d in &docs {
            let release = release_from_doc(d);
            newest
                .entry(release.tag_name.clone())
                .and_modify(|existing| {
                    if (release.created_at, &release.document_id)
                        > (existing.created_at, &existing.document_id)
                    {
                        *existing = release.clone();
                    }
                })
                .or_insert(release);
        }
        let mut out: Vec<Release> = newest.into_values().collect();
        out.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.document_id.cmp(&a.document_id))
        });
        Ok(out)
    }
}

/// Build a [`Release`] from a fetched document.
fn release_from_doc(d: &platform::FetchedDocument) -> Release {
    let assets = d
        .field_str("assets")
        .and_then(|s| serde_json::from_str::<Vec<ReleaseAsset>>(&s).ok())
        .unwrap_or_default();
    Release {
        document_id: d.id.clone(),
        tag_name: d.field_str("tagName").unwrap_or_default(),
        name: d.field_str("name").unwrap_or_default(),
        notes: d.field_str("notes").unwrap_or_default(),
        yanked: d.field_bool("yanked"),
        assets,
        created_at: d.created_at.unwrap_or(0),
    }
}

// ===========================================================================
// Labels
// ===========================================================================

/// A label definition (newest per `name`).
#[derive(Debug, Clone)]
pub struct Label {
    /// Document `$id`.
    pub document_id: String,
    /// Label name (the logical key).
    pub name: String,
    /// Hex color (e.g. `#ff0000`).
    pub color: String,
    /// Description.
    pub description: String,
    /// Retired flag.
    pub retired: bool,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// The label service (MAINTAIN-gated create; append-only newest-wins).
pub struct LabelService<'a> {
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
}

impl<'a> LabelService<'a> {
    /// Bind the service.
    pub fn new(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
    ) -> Self {
        Self {
            client,
            identity,
            bridge,
        }
    }

    /// Create (or supersede) a label. MAINTAIN-gated; newest doc per `name` wins. Returns
    /// the document id.
    pub async fn create_label(
        &self,
        repo_contract_id: &str,
        name: &str,
        color: &str,
        description: &str,
        retired: bool,
    ) -> Result<String> {
        check_len("label name", name, 30)?;
        check_len("label color", color, 7)?;
        check_len("label description", description, 200)?;
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let engine = doc_engine(self.client, self.identity, self.bridge)?;
        let mut props = BTreeMap::new();
        props.insert("name".to_string(), FieldValue::text(name));
        if !color.is_empty() {
            props.insert("color".to_string(), FieldValue::text(color));
        }
        if !description.is_empty() {
            props.insert("description".to_string(), FieldValue::text(description));
        }
        props.insert("retired".to_string(), FieldValue::boolean(retired));
        engine.create_document(&contract, DOC_LABEL, props).await
    }

    /// List labels, newest doc per `name` (newest-wins), skipping none — the `retired` flag
    /// is carried so callers can hide retired labels.
    pub async fn list_labels(&self, repo_contract_id: &str) -> Result<Vec<Label>> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let docs = self
            .client
            .query_documents(
                &contract,
                DOC_LABEL,
                &[],
                &[QueryOrder::desc("$createdAt")],
                0,
                None,
            )
            .await?;
        let mut newest: BTreeMap<String, Label> = BTreeMap::new();
        for d in &docs {
            let label = label_from_doc(d);
            newest
                .entry(label.name.clone())
                .and_modify(|existing| {
                    if (label.created_at, &label.document_id)
                        > (existing.created_at, &existing.document_id)
                    {
                        *existing = label.clone();
                    }
                })
                .or_insert(label);
        }
        Ok(newest.into_values().collect())
    }
}

/// Build a [`Label`] from a fetched document.
fn label_from_doc(d: &platform::FetchedDocument) -> Label {
    Label {
        document_id: d.id.clone(),
        name: d.field_str("name").unwrap_or_default(),
        color: d.field_str("color").unwrap_or_default(),
        description: d.field_str("description").unwrap_or_default(),
        retired: d.field_bool("retired"),
        created_at: d.created_at.unwrap_or(0),
    }
}

// ===========================================================================
// Social graph (registry)
// ===========================================================================

/// The registry social service (stars / follows) over the global registry contract.
pub struct SocialService<'a> {
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
    registry_contract_id: String,
}

impl<'a> SocialService<'a> {
    /// Bind the service to the default testnet registry
    /// ([`crate::repo::TESTNET_REGISTRY_CONTRACT_ID`]).
    pub fn new(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
    ) -> Self {
        Self::with_registry(
            client,
            identity,
            bridge,
            crate::repo::TESTNET_REGISTRY_CONTRACT_ID,
        )
    }

    /// Bind the service to an explicit registry contract id (mainnet / devnet).
    pub fn with_registry(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
        registry_contract_id: &str,
    ) -> Self {
        Self {
            client,
            identity,
            bridge,
            registry_contract_id: registry_contract_id.to_string(),
        }
    }

    /// Star a repo listing (`listing_id` = the `repoListing` `$id`, base58). Returns the
    /// star document id.
    ///
    /// Idempotent: a re-star collides on the unique `($ownerId, listingId)` index; that
    /// [`Error::DuplicateUniqueIndex`] is caught and the caller's existing star id is
    /// returned instead of an error (mirroring [`crate::tokens::TokenService::grant`]).
    pub async fn star(&self, listing_id: &str) -> Result<String> {
        let registry = self
            .client
            .fetch_contract(&self.registry_contract_id)
            .await?;
        let engine = doc_engine(self.client, self.identity, self.bridge)?;
        let mut props = BTreeMap::new();
        props.insert(
            "listingId".to_string(),
            FieldValue::identifier(platform::decode_identifier(listing_id)?),
        );
        match engine.create_document(&registry, DOC_STAR, props).await {
            Ok(id) => Ok(id),
            Err(Error::DuplicateUniqueIndex(_)) => {
                // Already starred — resolve and return the existing star id.
                self.find_own(&registry, DOC_STAR, "listingId", listing_id)
                    .await?
                    .ok_or_else(|| {
                        Error::Platform("star collided but no existing star found".into())
                    })
            }
            Err(e) => Err(e),
        }
    }

    /// Unstar (delete the caller's own `star` for `listing_id`). No-op if not starred.
    ///
    /// Resolves the star via the caller's own `star($ownerId, …)` index and filters by
    /// `listingId` client-side. (A two-clause `($ownerId, listingId)` query collides with
    /// the countable `listing` index and fails proof verification on the deployed registry
    /// — "wrong element type" — so the single-field owner query is used instead.)
    pub async fn unstar(&self, listing_id: &str) -> Result<()> {
        let registry = self
            .client
            .fetch_contract(&self.registry_contract_id)
            .await?;
        let Some(doc) = self
            .find_own(&registry, DOC_STAR, "listingId", listing_id)
            .await?
        else {
            return Ok(());
        };
        let engine = doc_engine(self.client, self.identity, self.bridge)?;
        engine.delete_document(&registry, DOC_STAR, &doc).await
    }

    /// The star count for a listing (`star(listingId)`, §3).
    ///
    /// Prefers the O(1) count-tree; falls back to a paginated row count when the deployed
    /// registry's `listing` index is a compound `(listingId, $createdAt)` countable index
    /// (the SDK count-proof helper requires the where-clause fields to *exactly* match a
    /// countable index's properties, so a single-field `listingId` count is rejected until
    /// the registry carries a single-property `(listingId)` countable index — a
    /// data-contract reconciliation item).
    pub async fn star_count(&self, listing_id: &str) -> Result<u64> {
        self.social_count(
            DOC_STAR,
            QueryFilter::eq(
                "listingId",
                FieldValue::identifier(platform::decode_identifier(listing_id)?),
            ),
        )
        .await
    }

    /// The identities (base58 `$ownerId`) that starred a listing, newest first.
    pub async fn list_stars(
        &self,
        listing_id: &str,
        limit: u32,
        start_after: Option<&str>,
    ) -> Result<Vec<String>> {
        let registry = self
            .client
            .fetch_contract(&self.registry_contract_id)
            .await?;
        let docs = self
            .client
            .query_documents(
                &registry,
                DOC_STAR,
                &[QueryFilter::eq(
                    "listingId",
                    FieldValue::identifier(platform::decode_identifier(listing_id)?),
                )],
                &[QueryOrder::desc("$createdAt")],
                limit,
                start_after,
            )
            .await?;
        Ok(docs.into_iter().map(|d| d.owner_id).collect())
    }

    /// Follow an identity (`identity_id`, base58). Returns the follow document id.
    pub async fn follow(&self, identity_id: &str) -> Result<String> {
        let registry = self
            .client
            .fetch_contract(&self.registry_contract_id)
            .await?;
        let engine = doc_engine(self.client, self.identity, self.bridge)?;
        let mut props = BTreeMap::new();
        props.insert(
            "identityId".to_string(),
            FieldValue::identifier(platform::decode_identifier(identity_id)?),
        );
        engine.create_document(&registry, DOC_FOLLOW, props).await
    }

    /// Unfollow (delete the caller's own `follow` of `identity_id`). No-op if not following.
    /// Same single-field owner-query strategy as [`SocialService::unstar`].
    pub async fn unfollow(&self, identity_id: &str) -> Result<()> {
        let registry = self
            .client
            .fetch_contract(&self.registry_contract_id)
            .await?;
        let Some(doc) = self
            .find_own(&registry, DOC_FOLLOW, "identityId", identity_id)
            .await?
        else {
            return Ok(());
        };
        let engine = doc_engine(self.client, self.identity, self.bridge)?;
        engine.delete_document(&registry, DOC_FOLLOW, &doc).await
    }

    /// Find the caller's own `doc_type` document whose identifier field `target_field`
    /// equals `target` (base58), by paging the caller's `$ownerId`-scoped documents and
    /// filtering client-side. Returns the document `$id`, if any.
    async fn find_own(
        &self,
        registry: &LoadedContract,
        doc_type: &str,
        target_field: &str,
        target: &str,
    ) -> Result<Option<String>> {
        let target_bytes = platform::decode_identifier(target)?;
        let mut start_after: Option<String> = None;
        loop {
            let page = self
                .client
                .query_documents(
                    registry,
                    doc_type,
                    &[QueryFilter::eq(
                        "$ownerId",
                        FieldValue::identifier(platform::decode_identifier(&self.identity.id())?),
                    )],
                    &[QueryOrder::asc("$createdAt")],
                    100,
                    start_after.as_deref(),
                )
                .await?;
            let n = page.len();
            if let Some(found) = page
                .iter()
                .find(|d| d.field_bytes(target_field).as_deref() == Some(target_bytes.as_slice()))
            {
                return Ok(Some(found.id.clone()));
            }
            if n < 100 {
                return Ok(None);
            }
            start_after = page.last().map(|d| d.id.clone());
        }
    }

    /// The follower count of an identity (`follow(identityId)`, §3). Count-tree with a
    /// paginated fallback (see [`SocialService::star_count`]).
    pub async fn follower_count(&self, identity_id: &str) -> Result<u64> {
        self.social_count(
            DOC_FOLLOW,
            QueryFilter::eq(
                "identityId",
                FieldValue::identifier(platform::decode_identifier(identity_id)?),
            ),
        )
        .await
    }

    /// The following count of an identity (`follow($ownerId)`, §3). Count-tree with a
    /// paginated fallback (see [`SocialService::star_count`]).
    pub async fn following_count(&self, owner_id: &str) -> Result<u64> {
        self.social_count(
            DOC_FOLLOW,
            QueryFilter::eq(
                "$ownerId",
                FieldValue::identifier(platform::decode_identifier(owner_id)?),
            ),
        )
        .await
    }

    /// Count `doc_type` documents matching `filter`: try the O(1) count-tree, and on the
    /// registry's compound-countable-index rejection fall back to a paginated row count.
    async fn social_count(&self, doc_type: &str, filter: QueryFilter) -> Result<u64> {
        let registry = self
            .client
            .fetch_contract(&self.registry_contract_id)
            .await?;
        match self
            .client
            .count_documents(&registry, doc_type, std::slice::from_ref(&filter))
            .await
        {
            Ok(n) => Ok(n),
            Err(Error::Platform(msg)) if msg.contains("countable") => {
                tracing::warn!(
                    doc_type,
                    "count-tree unavailable (compound countable index on the deployed \
                     registry); falling back to a paginated row count"
                );
                self.count_rows(&registry, doc_type, &filter).await
            }
            Err(e) => Err(e),
        }
    }

    /// Count matching documents by paging through them (the fallback when the count-tree
    /// index shape is not servable). Bounded by the real row count.
    async fn count_rows(
        &self,
        registry: &LoadedContract,
        doc_type: &str,
        filter: &QueryFilter,
    ) -> Result<u64> {
        let mut total: u64 = 0;
        let mut start_after: Option<String> = None;
        loop {
            let page = self
                .client
                .query_documents(
                    registry,
                    doc_type,
                    std::slice::from_ref(filter),
                    &[QueryOrder::asc("$createdAt")],
                    100,
                    start_after.as_deref(),
                )
                .await?;
            let n = page.len();
            total += n as u64;
            if n < 100 {
                break;
            }
            start_after = page.last().map(|d| d.id.clone());
        }
        Ok(total)
    }
}

#[cfg(test)]
mod tests {
    use super::{event_kind_to_u64, u64_to_event_kind};
    use crate::rules::EventKind;

    #[test]
    fn event_kind_numbering_round_trips() {
        for (kind, n) in [
            (EventKind::Close, 1),
            (EventKind::Reopen, 2),
            (EventKind::Merge, 3),
            (EventKind::LabelAdd, 4),
            (EventKind::LabelRemove, 5),
            (EventKind::Assign, 6),
            (EventKind::Unassign, 7),
            (EventKind::Retarget, 8),
            (EventKind::Draft, 9),
            (EventKind::Ready, 10),
        ] {
            assert_eq!(event_kind_to_u64(kind), n);
            assert_eq!(u64_to_event_kind(n), Some(kind));
        }
        assert_eq!(u64_to_event_kind(0), None);
        assert_eq!(u64_to_event_kind(11), None);
    }

    #[test]
    fn imported_builds_nested_object_field() {
        use super::Imported;
        use crate::platform::FieldValue;

        let imp = Imported {
            author: "octocat".to_string(),
            created_at: 1_577_934_245,
            url: "https://github.com/o/r/issues/1".to_string(),
        };
        let FieldValue::Object(map) = imp.to_field().unwrap() else {
            panic!("imported must serialize to a nested object");
        };
        assert_eq!(
            map.get("author").and_then(FieldValue::as_str),
            Some("octocat")
        );
        assert_eq!(
            map.get("createdAt").and_then(FieldValue::as_u64),
            Some(1_577_934_245)
        );
        assert!(map.contains_key("url"));

        // Empty author/url are omitted; createdAt always present.
        let bare = Imported {
            author: String::new(),
            created_at: 42,
            url: String::new(),
        };
        let FieldValue::Object(map) = bare.to_field().unwrap() else {
            panic!("object");
        };
        assert!(!map.contains_key("author"));
        assert!(!map.contains_key("url"));
        assert_eq!(map.get("createdAt").and_then(FieldValue::as_u64), Some(42));

        // Over-length author is rejected up front (before any broadcast).
        let too_long = Imported {
            author: "x".repeat(121),
            created_at: 1,
            url: String::new(),
        };
        assert!(too_long.to_field().is_err());
    }
}
