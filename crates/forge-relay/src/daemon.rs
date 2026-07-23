//! The daemon orchestration: connect, resolve watched repos, and run the poll → translate
//! → deliver loop (PRD 05). Stateless across restarts — cursors live in memory and are
//! re-baselined to "now" (or a configured lookback) on startup.

use std::sync::Arc;

use forge_core::keystore::BridgeIdentity;
use forge_core::platform::{decode_identifier, FieldValue, PlatformClient, QueryFilter};

use crate::config::RelayConfig;
use crate::deliver::{DeliverConfig, Deliverer};
use crate::error::{RelayError, Result};
use crate::ingest::{
    self, build_repo_meta, poll_new_filtered, preload_targets, RepoContext, DOC_CHECK_RUN,
    DOC_COMMENT, DOC_EVENT, DOC_ISSUE, DOC_PATCH, DOC_PROTECTED_REF_UPDATE, DOC_REF_UPDATE,
};
use crate::payload::WebhookEvent;
use crate::subscriptions::{self, WebhookSub};

/// Run the relay daemon until the process is stopped.
pub async fn run(cfg: RelayConfig) -> Result<()> {
    if cfg.repos.is_empty() {
        return Err(RelayError::Config(
            "no repos to watch — pass --repos <ids>, add a [[webhook]] block, or set `repos` in the config"
                .into(),
        ));
    }

    let client = Arc::new(
        PlatformClient::connect(cfg.network)
            .await
            .map_err(RelayError::Core)?,
    );

    // The relay identity id (for the Platform webhook-doc interchangeability filter). The
    // relay only READS on-chain, so no keys are needed for delivery — the identity id is
    // enough; if no identity file is configured, only static webhooks are used.
    let relay_identity_id = if let Some(path) = &cfg.identity_path {
        let bridge = BridgeIdentity::load_from_file(path)?;
        tracing::info!(relay_identity = %bridge.identity_id, "loaded relay identity");
        Some(bridge.identity_id)
    } else {
        tracing::warn!(
            "no relay identity configured; Platform webhook docs disabled (static webhooks only)"
        );
        None
    };

    let deliverer = Deliverer::new(DeliverConfig {
        allow_private: cfg.allow_private,
        ..Default::default()
    })?;

    // Resolve each watched repo's static context once.
    let mut repos: Vec<RepoContext> = Vec::new();
    for repo_id in &cfg.repos {
        match init_repo(&client, repo_id, &cfg).await {
            Ok(ctx) => {
                tracing::info!(
                    repo = %ctx.contract.id(),
                    name = %ctx.meta.name,
                    owner = %ctx.meta.owner_id,
                    targets = ctx.targets.len(),
                    "watching repo"
                );
                repos.push(ctx);
            }
            Err(e) => tracing::error!(repo = %repo_id, error = %e, "failed to init repo; skipping"),
        }
    }
    if repos.is_empty() {
        return Err(RelayError::Config("no watchable repos resolved".into()));
    }

    // Optional health listener.
    if let Some(addr) = cfg.listen.clone() {
        tokio::spawn(async move {
            if let Err(e) = crate::health::serve(&addr).await {
                tracing::error!(error = %e, "health listener stopped");
            }
        });
    }

    tracing::info!(
        poll_interval_s = cfg.poll_interval.as_secs(),
        allow_private = cfg.allow_private,
        "relay started; entering poll loop"
    );

    let mut ticker = tokio::time::interval(cfg.poll_interval);
    loop {
        ticker.tick().await;
        for ctx in &mut repos {
            if let Err(e) =
                poll_cycle(&client, &deliverer, ctx, relay_identity_id.as_deref(), &cfg).await
            {
                tracing::error!(repo = %ctx.contract.id(), error = %e, "poll cycle error");
            }
        }
    }
}

/// Resolve the static context (contract, metadata, target index) for one repo.
async fn init_repo(
    client: &PlatformClient,
    repo_id: &str,
    cfg: &RelayConfig,
) -> Result<RepoContext> {
    let contract = client.fetch_contract(repo_id).await?;
    let meta = build_repo_meta(client, &contract, &cfg.web_base_url).await?;
    let targets = preload_targets(client, &contract).await?;
    Ok(RepoContext {
        contract,
        meta,
        cursors: std::collections::BTreeMap::new(),
        targets,
        head_oids: std::collections::BTreeSet::new(),
        subs: Vec::new(),
        cycle: 0,
    })
}

/// How often (in poll cycles) to re-read the on-Platform `webhook` subscriptions. Between
/// refreshes the cached set is reused so the hot push/issue polls are not gated behind a
/// webhook-doc read every cycle.
const SUBS_REFRESH_CYCLES: u64 = 12;

/// One poll cycle for one repo: resolve subscriptions, poll each doc type, translate, and
/// deliver to every matching subscription.
async fn poll_cycle(
    client: &PlatformClient,
    deliverer: &Deliverer,
    ctx: &mut RepoContext,
    relay_identity_id: Option<&str>,
    cfg: &RelayConfig,
) -> Result<()> {
    // Refresh cached subscriptions periodically (not every cycle — see SUBS_REFRESH_CYCLES).
    if ctx.cycle % SUBS_REFRESH_CYCLES == 0 || ctx.subs.is_empty() {
        match subscriptions::resolve_for_repo(client, &ctx.contract, relay_identity_id, cfg).await {
            Ok(s) => ctx.subs = s,
            Err(e) => {
                tracing::warn!(repo = %ctx.contract.id(), error = %e, "subscription refresh failed; reusing cached set");
            }
        }
    }
    ctx.cycle = ctx.cycle.wrapping_add(1);
    let subs = ctx.subs.clone();
    if subs.is_empty() {
        tracing::debug!(repo = %ctx.contract.id(), "no active webhook subscriptions this cycle");
        return Ok(());
    }

    // Each doc type is polled independently: a transient node error on one type (testnet
    // nodes throw connection-resets / stale-height frequently) must NOT abort the others,
    // or one flaky query would block every later event type for the whole cycle. So every
    // section fetches new docs, and on error logs and moves on — the cursor for a failed
    // type simply is not advanced, so it retries next cycle (at-least-once holds).

    // Push (both ref-update types). Collect each push's newOid as a checkRun key.
    for doc_type in [DOC_REF_UPDATE, DOC_PROTECTED_REF_UPDATE] {
        for d in &fetch_new(client, ctx, doc_type, cfg.lookback).await {
            if ingest::is_ref_deletion(d) {
                tracing::debug!(repo = %ctx.contract.id(), source = %d.id, "ingested a branch deletion (all-zero newOid)");
            } else if let Some(oid) = d.field_hex("newOid") {
                ctx.head_oids.insert(oid);
            }
            if let Some(event) = ingest::translate_ref_update(&ctx.meta, d) {
                dispatch(deliverer, &subs, &event).await;
            }
        }
    }

    // Issues (also feed the target index for later comment/event translation).
    for d in &fetch_new(client, ctx, DOC_ISSUE, cfg.lookback).await {
        ctx.targets
            .insert(d.id.clone(), ingest::target_info_from_issue(d));
        if let Some(event) = ingest::translate_issue(&ctx.meta, d) {
            dispatch(deliverer, &subs, &event).await;
        }
    }

    // Patches / PRs (also feed the target index and the checkRun head-oid keys).
    for d in &fetch_new(client, ctx, DOC_PATCH, cfg.lookback).await {
        ctx.targets
            .insert(d.id.clone(), ingest::target_info_from_patch(d));
        if let Some(oid) = d.field_hex("headOid") {
            ctx.head_oids.insert(oid);
        }
        if let Some(event) = ingest::translate_patch(&ctx.meta, d) {
            dispatch(deliverer, &subs, &event).await;
        }
    }

    // Events → issues/pull_request actions (`event` has a standalone `$createdAt` feed index).
    for d in &fetch_new(client, ctx, DOC_EVENT, cfg.lookback).await {
        if let Some(event) = ingest::translate_event(&ctx.meta, d, &ctx.targets) {
            dispatch(deliverer, &subs, &event).await;
        }
    }

    // Comments → issue_comment. `comment` is only indexed by `(targetId, $createdAt)`, so
    // poll per known issue/PR target with a per-target cursor rather than globally.
    let target_ids: Vec<String> = ctx.targets.keys().cloned().collect();
    for tid in target_ids {
        let Ok(target_bytes) = decode_identifier(&tid) else {
            continue;
        };
        let key = format!("{DOC_COMMENT}:{tid}");
        let filter = [QueryFilter::eq(
            "targetId",
            FieldValue::identifier(target_bytes),
        )];
        for d in &fetch_new_keyed(client, ctx, DOC_COMMENT, &key, &filter, cfg.lookback).await {
            if let Some(event) = ingest::translate_comment(&ctx.meta, d, &ctx.targets) {
                dispatch(deliverer, &subs, &event).await;
            }
        }
    }

    // Check runs → check_run. `checkRun` is only indexed by `(headOid, $createdAt)`, so poll
    // per head-oid the relay has seen (from pushes/PRs) with a per-oid cursor.
    let oids: Vec<String> = ctx.head_oids.iter().cloned().collect();
    for oid in oids {
        let Ok(oid_bytes) = hex::decode(&oid) else {
            continue;
        };
        let key = format!("{DOC_CHECK_RUN}:{oid}");
        let filter = [QueryFilter::eq("headOid", FieldValue::bytes(oid_bytes))];
        for d in &fetch_new_keyed(client, ctx, DOC_CHECK_RUN, &key, &filter, cfg.lookback).await {
            if let Some(event) = ingest::translate_check_run(&ctx.meta, d) {
                dispatch(deliverer, &subs, &event).await;
            }
        }
    }

    Ok(())
}

/// Poll new documents of `doc_type` (cursor key = `doc_type`), advancing the cursor. On a
/// transient error this logs and returns an empty vec (cursor left unadvanced → retried
/// next cycle) rather than aborting the whole poll cycle.
async fn fetch_new(
    client: &PlatformClient,
    ctx: &mut RepoContext,
    doc_type: &str,
    lookback: u32,
) -> Vec<forge_core::platform::FetchedDocument> {
    fetch_new_keyed(client, ctx, doc_type, doc_type, &[], lookback).await
}

/// Like [`fetch_new`] but with an explicit `cursor_key` (so one doc type can have many
/// independent cursors — e.g. `comment` per target) and an index `filters` prefix.
async fn fetch_new_keyed(
    client: &PlatformClient,
    ctx: &mut RepoContext,
    doc_type: &str,
    cursor_key: &str,
    filters: &[QueryFilter],
    lookback: u32,
) -> Vec<forge_core::platform::FetchedDocument> {
    let mut cursor = ctx.cursor(cursor_key).clone();
    match poll_new_filtered(
        client,
        &ctx.contract,
        doc_type,
        filters,
        &mut cursor,
        lookback,
    )
    .await
    {
        Ok(docs) => {
            *ctx.cursor(cursor_key) = cursor;
            docs
        }
        Err(e) => {
            tracing::warn!(repo = %ctx.contract.id(), doc_type, cursor_key, error = %e, "polling doc type failed this cycle; will retry next cycle");
            Vec::new()
        }
    }
}

/// Deliver one event to every subscription that wants it, logging (dead-lettering) any
/// exhausted deliveries. At-least-once: consumers dedupe on the delivery id.
async fn dispatch(deliverer: &Deliverer, subs: &[WebhookSub], event: &WebhookEvent) {
    for sub in subs {
        if !sub.wants(event.event) {
            continue;
        }
        match deliverer
            .deliver(&sub.url, &sub.secret, &sub.hook_id, event)
            .await
        {
            Ok(receipt) => tracing::info!(
                repo = %sub.repo,
                url = %sub.url,
                event = event.event,
                action = event.action.unwrap_or("-"),
                delivery_id = %receipt.delivery_id,
                status = receipt.status,
                attempts = receipt.attempts,
                source = %event.source_doc_id,
                "delivered webhook"
            ),
            Err(e) => tracing::error!(
                repo = %sub.repo,
                url = %sub.url,
                event = event.event,
                source = %event.source_doc_id,
                error = %e,
                "DEAD-LETTER: webhook delivery failed permanently (at-least-once — will not auto-retry across cycles)"
            ),
        }
    }
}
