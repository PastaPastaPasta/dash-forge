//! The daemon: discover the repos with hooks addressed to this relay, poll their documents,
//! translate, and deliver (PRD 05). Stateless across restarts: cursors live in memory and
//! are re-baselined on startup ([`crate::ingest`]).
//!
//! Each cycle:
//! 1. every `refresh_cycles` cycles, re-run discovery ([`crate::subscriptions`]): hooks
//!    appear, move to another relay, get disabled, or lose their writer's maintainer role;
//!    repos with no hook left are dropped, new ones are added (baselined at their earliest
//!    hook's `$createdAt`, so nothing written after the hook is missed);
//! 2. for each repo, read every stream past its cursor and deliver each new document to the
//!    repo's hooks that want its event. A stream whose read fails keeps its cursor and is
//!    retried next cycle; one flaky query never blocks the other streams.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use forge_core::platform::{
    decode_identifier, FetchedDocument, FieldValue, LoadedContract, PlatformClient, QueryFilter,
    QueryOrder,
};
use forge_core::rules::v2::Visibility;
use forge_core::scope::RepoRef;

use crate::config::RelayConfig;
use crate::deliver::{DeliverConfig, Deliverer};
use crate::error::{RelayError, Result};
use crate::ingest::{
    self, poll_stream, Baseline, Cursor, TargetInfo, DOC_AUTHOR_EVENT, DOC_CHECK_RUN, DOC_COMMENT,
    DOC_EVENT, DOC_ISSUE, DOC_PATCH, DOC_PROTECTED_REF_UPDATE, DOC_REF_UPDATE, DOC_RELEASE,
    DOC_REVIEW,
};
use crate::payload::{RepositoryMeta, WebhookEvent};
use crate::subscriptions::{self, RelayIdentity, WebhookSub};

/// Deliveries in flight at once for one event across its hooks (each also bounded per host,
/// [`crate::deliver::MAX_IN_FLIGHT_PER_HOST`], and by the per-delivery overall timeout).
const MAX_CONCURRENT_DELIVERIES: usize = 8;

/// The two forge-v2 contracts.
struct Contracts {
    core: LoadedContract,
    collab: LoadedContract,
}

/// One served repository and its stream cursors.
struct RepoState {
    meta: RepositoryMeta,
    /// This repo's hooks (Platform and static).
    subs: Vec<WebhookSub>,
    /// Where streams that did not exist yet start.
    baseline: Baseline,
    /// Cursor per stream key (`refUpdate`, `comment:<targetId>`, `checkRun:<oid>`, ...).
    cursors: BTreeMap<String, Cursor>,
    /// Issues and PRs by `$id` (for event/comment/review translation).
    targets: BTreeMap<String, TargetInfo>,
    /// Head oids seen on pushes and PRs (hex): the `checkRun` streams.
    heads: BTreeSet<String>,
}

/// Everything the loop holds between cycles.
struct Relay {
    client: Arc<PlatformClient>,
    contracts: Contracts,
    identity: Option<RelayIdentity>,
    deliverer: Deliverer,
    /// `--repos`, resolved to repo ids (empty = every repo with a hook).
    repo_filter: BTreeSet<String>,
    /// Static webhooks with their repo resolved.
    statics: Vec<WebhookSub>,
    repos: BTreeMap<String, RepoState>,
    cfg: RelayConfig,
}

/// Run the relay daemon until the process is stopped.
pub async fn run(cfg: RelayConfig) -> Result<()> {
    let forge = cfg.target.v2.clone().ok_or_else(|| {
        RelayError::Config(format!(
            "forge-v2 is not deployed on {}; the relay serves forge-v2 repositories only \
             (v1 repositories are read-only and have no webhooks)",
            cfg.target.network
        ))
    })?;
    let client = Arc::new(PlatformClient::connect(cfg.target.clone()).await?);
    let contracts = Contracts {
        core: client.fetch_contract(&forge.core).await?,
        collab: client.fetch_contract(&forge.collab).await?,
    };

    let identity = match &cfg.identity_path {
        Some(path) if cfg.use_platform_webhooks => {
            let id = RelayIdentity::load(&client, path, &forge.collab).await?;
            tracing::info!(relay_identity = %id.id, encryption_keys = ?id.key_ids(), "loaded relay identity");
            Some(id)
        }
        _ => {
            tracing::warn!("no relay identity (or use-platform-webhooks = false): serving static webhooks only");
            None
        }
    };

    let mut repo_filter = BTreeSet::new();
    for r in &cfg.repos {
        repo_filter.insert(resolve_repo(&client, r).await?.id().to_string());
    }
    let mut statics = Vec::new();
    for w in &cfg.static_webhooks {
        let repo = resolve_repo(&client, &w.repo).await?;
        statics.push(subscriptions::static_subscription(repo.id(), w));
    }
    if identity.is_none() && statics.is_empty() {
        return Err(RelayError::Config(
            "nothing to serve: pass --identity <relay identity file> (webhooks come from \
             Platform) or add [[webhook]] blocks to the config"
                .into(),
        ));
    }

    if let Some(addr) = cfg.listen.clone() {
        tokio::spawn(async move {
            if let Err(e) = crate::health::serve(&addr).await {
                tracing::error!(error = %e, "health listener stopped");
            }
        });
    }

    let mut relay = Relay {
        client,
        contracts,
        identity,
        deliverer: Deliverer::new(DeliverConfig {
            allow_private: cfg.allow_private,
            ..Default::default()
        }),
        repo_filter,
        statics,
        repos: BTreeMap::new(),
        cfg,
    };
    tracing::info!(
        network = %relay.cfg.target.network,
        poll_interval_s = relay.cfg.poll_interval.as_secs(),
        refresh_cycles = relay.cfg.refresh_cycles,
        allow_private = relay.cfg.allow_private,
        "relay started"
    );

    let mut ticker = tokio::time::interval(relay.cfg.poll_interval);
    let mut cycle: u64 = 0;
    loop {
        ticker.tick().await;
        if cycle.is_multiple_of(relay.cfg.refresh_cycles) {
            if let Err(e) = relay.refresh(cycle == 0).await {
                tracing::warn!(error = %e, "webhook discovery failed; keeping the current set");
            }
        }
        cycle = cycle.wrapping_add(1);
        let ids: Vec<String> = relay.repos.keys().cloned().collect();
        for id in ids {
            relay.poll_repo(&id).await;
        }
    }
}

/// `owner/name` or a repo id → the forge-v2 repo.
async fn resolve_repo(client: &PlatformClient, r: &str) -> Result<RepoRef> {
    let repo = match r.split_once('/') {
        Some((owner, name)) => forge_core::resolve::resolve_named(client, owner, name).await?,
        None => forge_core::resolve::resolve_id(client, r).await?,
    };
    if repo.is_v1() {
        return Err(RelayError::Config(format!(
            "{r} is a forge-v1 repository; the relay serves forge-v2 repositories only"
        )));
    }
    Ok(repo)
}

impl Relay {
    /// Re-run discovery and reconcile the served repos with it.
    async fn refresh(&mut self, startup: bool) -> Result<()> {
        let mut subs = self.statics.clone();
        let mut failed = BTreeSet::new();
        if let Some(identity) = &self.identity {
            let found = subscriptions::platform_subscriptions(
                &self.client,
                identity,
                &self.contracts.collab.id(),
                &self.repo_filter,
            )
            .await?;
            subs.extend(found.subs);
            failed = found.failed;
        }
        let wanted = subscriptions::repos_of(&subs);
        let before: BTreeSet<String> = self.repos.keys().cloned().collect();

        // A repo whose hooks could not be read this pass keeps its state and previous hooks.
        self.repos
            .retain(|id, _| wanted.contains_key(id) || failed.contains(id));
        for (repo_id, earliest) in &wanted {
            if !self.repos.contains_key(repo_id) {
                let baseline = if startup {
                    Baseline::Tail {
                        lookback: self.cfg.lookback,
                    }
                } else {
                    Baseline::Since(*earliest)
                };
                match self.init_repo(repo_id, baseline).await {
                    Ok(state) => {
                        self.repos.insert(repo_id.clone(), state);
                    }
                    Err(e) => {
                        tracing::warn!(repo = %repo_id, error = %e, "cannot serve repo this cycle");
                    }
                }
            }
            if let Some(state) = self.repos.get_mut(repo_id) {
                let mut fresh: Vec<WebhookSub> = subs
                    .iter()
                    .filter(|s| &s.repo_id == repo_id)
                    .cloned()
                    .collect();
                if failed.contains(repo_id) {
                    // Keep the Platform hooks read last time; only the static ones are fresh.
                    fresh.extend(
                        state
                            .subs
                            .iter()
                            .filter(|s| s.document_id.is_some())
                            .cloned(),
                    );
                }
                state.subs = fresh;
            }
        }
        let after: BTreeSet<String> = self.repos.keys().cloned().collect();
        if before != after || startup {
            tracing::info!(
                repos = after.len(),
                hooks = subs.len(),
                added = ?after.difference(&before).collect::<Vec<_>>(),
                removed = ?before.difference(&after).collect::<Vec<_>>(),
                "webhook subscriptions refreshed"
            );
        }
        Ok(())
    }

    /// Resolve a repo's metadata and preload its issue/PR index.
    async fn init_repo(&self, repo_id: &str, baseline: Baseline) -> Result<RepoState> {
        let repo = forge_core::resolve::resolve_id(&self.client, repo_id).await?;
        let RepoRef::V2 {
            owner_id,
            name,
            visibility,
            ..
        } = &repo
        else {
            return Err(RelayError::Config(format!(
                "{repo_id} is not a forge-v2 repo"
            )));
        };
        if *visibility == Visibility::Private {
            // A private repo's content is encrypted to its members; the relay is not one.
            return Err(RelayError::Config(format!(
                "{repo_id} is a private repository; the relay does not serve private repositories"
            )));
        }
        let repo_doc = self
            .client
            .fetch_document(&self.contracts.core, "repo", repo_id)
            .await?;
        let config = self
            .client
            .query_documents(
                &self.contracts.core,
                "config",
                &[repo_filter(repo_id)?],
                &[QueryOrder::desc("$createdAt")],
                1,
                None,
            )
            .await?;
        let default_branch = config
            .first()
            .and_then(|d| d.field_str("defaultBranch"))
            .or_else(|| repo_doc.as_ref().and_then(|d| d.field_str("defaultBranch")))
            .map_or_else(
                || "main".to_string(),
                |b| b.trim_start_matches("refs/heads/").to_string(),
            );

        // Every existing issue and PR, so events on old threads translate. Their comment and
        // review streams start where the repo's streams do.
        let mut targets = BTreeMap::new();
        for (doc_type, is_pr) in [(DOC_ISSUE, false), (DOC_PATCH, true)] {
            for d in self
                .client
                .query_all_documents(
                    &self.contracts.collab,
                    doc_type,
                    &[repo_filter(repo_id)?],
                    &[QueryOrder::asc("$createdAt")],
                )
                .await?
            {
                let t = if is_pr {
                    TargetInfo::from_patch(&d, baseline)
                } else {
                    TargetInfo::from_issue(&d, baseline)
                };
                targets.insert(d.id.clone(), t);
            }
        }
        tracing::info!(repo = %repo_id, name = %name, owner = %owner_id, targets = targets.len(), ?baseline, "serving repo");
        Ok(RepoState {
            meta: RepositoryMeta {
                repo_id: repo_id.to_string(),
                owner_id: owner_id.clone(),
                name: name.clone(),
                default_branch,
                web_base_url: self.cfg.web_base_url.clone(),
            },
            subs: Vec::new(),
            baseline,
            cursors: BTreeMap::new(),
            targets,
            heads: BTreeSet::new(),
        })
    }

    /// Read one stream of `repo_id` past its cursor, committing the cursor only on success.
    async fn stream(
        &mut self,
        repo_id: &str,
        key: String,
        doc_type: &str,
        collab: bool,
        prefix: Vec<QueryFilter>,
        baseline: Baseline,
    ) -> Vec<FetchedDocument> {
        let contract = if collab {
            &self.contracts.collab
        } else {
            &self.contracts.core
        };
        let Some(state) = self.repos.get_mut(repo_id) else {
            return Vec::new();
        };
        let mut cursor = state
            .cursors
            .get(&key)
            .cloned()
            .unwrap_or_else(|| Cursor::new(baseline));
        match poll_stream(&self.client, contract, doc_type, &prefix, &mut cursor).await {
            Ok(docs) => {
                state.cursors.insert(key, cursor);
                docs
            }
            Err(e) => {
                tracing::warn!(repo = %repo_id, stream = %key, error = %e, "stream read failed; retrying next cycle");
                Vec::new()
            }
        }
    }

    /// One cycle for one repo.
    async fn poll_repo(&mut self, repo_id: &str) {
        let Ok(rf) = repo_filter(repo_id) else { return };
        let Some(base) = self.repos.get(repo_id).map(|s| s.baseline) else {
            return;
        };

        // Pushes (both ref-update types), then releases (forge-core).
        for doc_type in [DOC_REF_UPDATE, DOC_PROTECTED_REF_UPDATE] {
            let docs = self
                .stream(
                    repo_id,
                    doc_type.into(),
                    doc_type,
                    false,
                    vec![rf.clone()],
                    base,
                )
                .await;
            for d in &docs {
                if !ingest::is_ref_deletion(d) {
                    if let (Some(oid), Some(s)) =
                        (d.field_hex("newOid"), self.repos.get_mut(repo_id))
                    {
                        s.heads.insert(oid);
                    }
                }
                self.emit(repo_id, d, ingest::translate_ref_update).await;
            }
        }
        for d in &self
            .stream(
                repo_id,
                DOC_RELEASE.into(),
                DOC_RELEASE,
                false,
                vec![rf.clone()],
                base,
            )
            .await
        {
            self.emit(repo_id, d, ingest::translate_release).await;
        }

        // New issues and PRs: deliver, and add them as targets whose comment/review streams
        // start at the beginning (everything on them is new).
        for (doc_type, is_pr) in [(DOC_ISSUE, false), (DOC_PATCH, true)] {
            for d in &self
                .stream(
                    repo_id,
                    doc_type.into(),
                    doc_type,
                    true,
                    vec![rf.clone()],
                    base,
                )
                .await
            {
                if let Some(s) = self.repos.get_mut(repo_id) {
                    let t = if is_pr {
                        if let Some(oid) = d.field_hex("headOid") {
                            s.heads.insert(oid);
                        }
                        TargetInfo::from_patch(d, Baseline::Beginning)
                    } else {
                        TargetInfo::from_issue(d, Baseline::Beginning)
                    };
                    s.targets.insert(d.id.clone(), t);
                }
                let translate = if is_pr {
                    ingest::translate_patch
                } else {
                    ingest::translate_issue
                };
                self.emit(repo_id, d, translate).await;
            }
        }

        // State changes by members and by authors (the repo feed of both types).
        for doc_type in [DOC_EVENT, DOC_AUTHOR_EVENT] {
            for d in &self
                .stream(
                    repo_id,
                    doc_type.into(),
                    doc_type,
                    true,
                    vec![rf.clone()],
                    base,
                )
                .await
            {
                self.emit_with_targets(repo_id, d, ingest::translate_event)
                    .await;
            }
        }

        self.poll_threads(repo_id).await;
        self.poll_check_runs(repo_id, &rf).await;
    }

    /// Whether any hook of the repo wants `event`: the per-target and per-head streams cost a
    /// query each per cycle, so they are read only for a hook that wants them.
    fn wanted(&self, repo_id: &str, event: &str) -> bool {
        self.repos
            .get(repo_id)
            .is_some_and(|s| s.subs.iter().any(|h| h.wants(event)))
    }

    /// Comments (per issue/PR) and reviews (per PR): their indexes lead with the target.
    async fn poll_threads(&mut self, repo_id: &str) {
        let comments = self.wanted(repo_id, "issue_comment");
        let reviews = self.wanted(repo_id, "pull_request_review");
        if !comments && !reviews {
            return;
        }
        let targets: Vec<(String, bool, Baseline)> = self
            .repos
            .get(repo_id)
            .map(|s| {
                s.targets
                    .iter()
                    .map(|(id, t)| (id.clone(), t.is_pr, t.baseline))
                    .collect()
            })
            .unwrap_or_default();
        for (tid, is_pr, tbase) in targets {
            let Ok(bytes) = decode_identifier(&tid) else {
                continue;
            };
            if comments {
                let key = format!("{DOC_COMMENT}:{tid}");
                let by_target = vec![QueryFilter::eq("targetId", FieldValue::identifier(bytes))];
                for d in &self
                    .stream(repo_id, key, DOC_COMMENT, true, by_target, tbase)
                    .await
                {
                    self.emit_with_targets(repo_id, d, ingest::translate_comment)
                        .await;
                }
            }
            if is_pr && reviews {
                let key = format!("{DOC_REVIEW}:{tid}");
                let by_patch = vec![QueryFilter::eq("patchId", FieldValue::identifier(bytes))];
                for d in &self
                    .stream(repo_id, key, DOC_REVIEW, true, by_patch, tbase)
                    .await
                {
                    self.emit_with_targets(repo_id, d, ingest::translate_review)
                        .await;
                }
            }
        }
    }

    /// Check runs, per head oid seen on a push or PR.
    async fn poll_check_runs(&mut self, repo_id: &str, rf: &QueryFilter) {
        if !self.wanted(repo_id, "check_run") {
            return;
        }
        let heads: Vec<String> = self
            .repos
            .get(repo_id)
            .map(|s| s.heads.iter().cloned().collect())
            .unwrap_or_default();
        for oid in heads {
            let Ok(bytes) = hex::decode(&oid) else {
                continue;
            };
            let key = format!("{DOC_CHECK_RUN}:{oid}");
            let by_head = vec![
                rf.clone(),
                QueryFilter::eq("headOid", FieldValue::bytes(bytes)),
            ];
            // A head's runs are all new once the head itself was seen.
            for d in &self
                .stream(
                    repo_id,
                    key,
                    DOC_CHECK_RUN,
                    true,
                    by_head,
                    Baseline::Beginning,
                )
                .await
            {
                self.emit(repo_id, d, ingest::translate_check_run).await;
            }
        }
    }

    /// Translate a document that needs no other context, and deliver.
    async fn emit(
        &self,
        repo_id: &str,
        d: &FetchedDocument,
        translate: fn(&RepositoryMeta, &FetchedDocument) -> Option<WebhookEvent>,
    ) {
        if let Some(s) = self.repos.get(repo_id) {
            if let Some(event) = translate(&s.meta, d) {
                dispatch(&self.deliverer, &s.subs, &event).await;
            }
        }
    }

    /// Translate with the repo's target index, and deliver.
    async fn emit_with_targets(
        &self,
        repo_id: &str,
        d: &FetchedDocument,
        translate: fn(
            &RepositoryMeta,
            &FetchedDocument,
            &BTreeMap<String, TargetInfo>,
        ) -> Option<WebhookEvent>,
    ) {
        if let Some(s) = self.repos.get(repo_id) {
            if let Some(event) = translate(&s.meta, d, &s.targets) {
                dispatch(&self.deliverer, &s.subs, &event).await;
            }
        }
    }
}

/// `repoId == repo_id`, the pinned prefix of every repo-scoped stream.
fn repo_filter(repo_id: &str) -> Result<QueryFilter> {
    Ok(QueryFilter::eq(
        "repoId",
        FieldValue::identifier(decode_identifier(repo_id)?),
    ))
}

/// Deliver one event to every subscription that wants it, concurrently (bounded), so a slow
/// or dead target cannot hold up the others. Logs (dead-letters) exhausted deliveries; never
/// logs the secret, the body, or the URL's query.
async fn dispatch(deliverer: &Deliverer, subs: &[WebhookSub], event: &WebhookEvent) {
    use futures::stream::StreamExt;

    futures::stream::iter(subs.iter().filter(|s| s.wants(event.event)))
        .for_each_concurrent(MAX_CONCURRENT_DELIVERIES, |sub| async move {
            let url = crate::ssrf::redact(&sub.url);
            match deliverer
                .deliver(&sub.url, sub.secret.expose(), &sub.hook_id, event)
                .await
            {
                Ok(receipt) => tracing::info!(
                    repo = %sub.repo_id,
                    hook = %sub.hook_id,
                    %url,
                    event = event.event,
                    action = event.action.unwrap_or("-"),
                    delivery_id = %receipt.delivery_id,
                    status = receipt.status,
                    attempts = receipt.attempts,
                    source = %event.source_doc_id,
                    "delivered webhook"
                ),
                Err(e) => tracing::error!(
                    repo = %sub.repo_id,
                    hook = %sub.hook_id,
                    %url,
                    event = event.event,
                    source = %event.source_doc_id,
                    error = %e,
                    "DEAD-LETTER: webhook delivery failed (at-least-once: not retried across cycles)"
                ),
            }
        })
        .await;
}
