//! Webhook subscriptions — read from Platform `webhook` docs (PRD 05 §4) or from static
//! config, resolved into a uniform [`WebhookSub`] the ingest loop delivers against.
//!
//! ## Interchangeable instances (the load-bearing M2 property)
//!
//! Subscriptions live on Platform, not in the relay: each repo contract carries `webhook`
//! docs (`hookId`, `url`, `events`, `relayIdentityId`, `encryptedSecret`, `disabled`,
//! newest-per-`hookId` wins — data-contracts §2.4). A relay only delivers for the docs
//! whose `relayIdentityId` equals *its own* identity, so "kill relay A, point the repo at
//! relay B" is a single `webhook` doc update (re-encrypt the secret to B's identity, set
//! `relayIdentityId = B`) with no other repo-side change.
//!
//! ## Secret resolution — encrypted path vs M2 config fallback
//!
//! Production stores the HMAC secret **encrypted to the relay identity's ENCRYPTION key**
//! in `encryptedSecret`, decrypted only in relay memory. That is ECIES to a secp256k1 key
//! — heavy, and deferred: [`decrypt_secret`] is a stub that returns
//! [`RelayError::SecretUnavailable`]. For M2 the secret is provided out-of-band via the
//! config `secrets` map (keyed by `hookId` hex or delivery `url`), which still preserves
//! full instance-interchangeability of the *routing* (url/events/relayIdentityId all live
//! on Platform) — only the secret is provisioned to the operator. This is exactly the
//! "config-file secret per webhook for M2" the spec permits.

use std::collections::BTreeMap;

use forge_core::platform::{
    encode_identifier, FetchedDocument, LoadedContract, PlatformClient, QueryOrder,
};

use crate::config::{RelayConfig, StaticWebhook};
use crate::error::{RelayError, Result};

/// The `webhook` document type name in the repo contract.
const DOC_WEBHOOK: &str = "webhook";

/// A resolved, deliverable webhook subscription.
#[derive(Debug, Clone)]
pub struct WebhookSub {
    /// Repo contract id (base58) this subscription belongs to.
    pub repo: String,
    /// Stable hook id (hex of the `hookId` byteArray, or the static hook id / url).
    pub hook_id: String,
    /// Delivery URL.
    pub url: String,
    /// Subscribed event names; empty = all.
    pub events: Vec<String>,
    /// The resolved HMAC secret.
    pub secret: Vec<u8>,
}

impl WebhookSub {
    /// Whether this subscription wants `event` (empty filter = all events).
    pub fn wants(&self, event: &str) -> bool {
        self.events.is_empty() || self.events.iter().any(|e| e == event)
    }
}

/// Stub for the production encrypted-secret path (ECIES to the relay ENCRYPTION key).
///
/// Not implemented for M2 — returns [`RelayError::SecretUnavailable`] so the caller falls
/// back to the config `secrets` map. Documented as the production path in the module docs.
fn decrypt_secret(_encrypted: &[u8]) -> Result<Vec<u8>> {
    Err(RelayError::SecretUnavailable(
        "on-Platform encryptedSecret decryption (ECIES to relay ENCRYPTION key) is the \
         production path and is not implemented in M2 — provide the secret via the config \
         `secrets` map keyed by hookId or url"
            .into(),
    ))
}

/// Resolve every deliverable subscription for one repo contract by reading its `webhook`
/// docs, filtering to `this_relay_id`, applying newest-per-`hookId` supersession and the
/// `disabled` flag, and resolving each secret.
///
/// Docs whose secret cannot be resolved are skipped with a warning (they cannot be signed,
/// so they cannot be delivered) rather than failing the whole repo.
pub async fn platform_subscriptions(
    client: &PlatformClient,
    repo_contract: &LoadedContract,
    this_relay_id: &str,
    secrets: &BTreeMap<String, String>,
) -> Result<Vec<WebhookSub>> {
    let docs = client
        .query_all_documents(
            repo_contract,
            DOC_WEBHOOK,
            &[],
            &[QueryOrder::asc("$createdAt")],
        )
        .await?;

    // Newest-per-hookId wins ((createdAt, id) total order; §2.2).
    let mut newest: BTreeMap<String, FetchedDocument> = BTreeMap::new();
    for d in docs {
        let hook_key = d.field_hex("hookId").unwrap_or_else(|| d.id.clone());
        match newest.get(&hook_key) {
            Some(existing) if (existing.created_at, &existing.id) >= (d.created_at, &d.id) => {}
            _ => {
                newest.insert(hook_key, d);
            }
        }
    }

    let mut subs = Vec::new();
    for (hook_id, d) in newest {
        if d.field_bool("disabled") {
            continue;
        }
        // Interchangeability filter: only deliver for docs addressed to THIS relay.
        let relay_id = d
            .field_bytes("relayIdentityId")
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .map(encode_identifier);
        if relay_id.as_deref() != Some(this_relay_id) {
            continue;
        }
        let Some(url) = d.field_str("url") else {
            tracing::warn!(hook_id, "webhook doc missing url; skipping");
            continue;
        };
        let events = d
            .field_str("events")
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default();

        // Secret: config map (by hookId hex, then by url) first, else the encrypted path.
        let Some(secret) = resolve_secret(&hook_id, &url, &d, secrets) else {
            continue;
        };

        subs.push(WebhookSub {
            repo: repo_contract.id(),
            hook_id,
            url,
            events,
            secret,
        });
    }
    Ok(subs)
}

/// Resolve a webhook's HMAC secret: the config `secrets` map (by `hook_id` hex, then by
/// `url`) wins for M2; otherwise the on-Platform `encryptedSecret` is attempted via the
/// (stubbed) production decrypt path. Returns `None` (with a warning) when no secret can be
/// resolved — that hook cannot be signed, so it is skipped.
fn resolve_secret(
    hook_id: &str,
    url: &str,
    d: &FetchedDocument,
    secrets: &BTreeMap<String, String>,
) -> Option<Vec<u8>> {
    if let Some(s) = secrets.get(hook_id).or_else(|| secrets.get(url)) {
        return Some(s.clone().into_bytes());
    }
    let Some(enc) = d.field_bytes("encryptedSecret") else {
        tracing::warn!(hook_id, %url, "webhook has no config secret and no encryptedSecret; skipping");
        return None;
    };
    match decrypt_secret(&enc) {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!(hook_id, %url, error = %e, "cannot resolve webhook secret; skipping delivery for this hook");
            None
        }
    }
}

/// Convert the static config webhooks for `repo` into [`WebhookSub`]s.
pub fn static_subscriptions(repo: &str, webhooks: &[StaticWebhook]) -> Vec<WebhookSub> {
    webhooks
        .iter()
        .filter(|w| w.repo == repo)
        .map(|w| WebhookSub {
            repo: repo.to_string(),
            hook_id: w.hook_id.clone().unwrap_or_else(|| w.url.clone()),
            url: w.url.clone(),
            events: w.events.clone(),
            secret: w.secret.clone().into_bytes(),
        })
        .collect()
}

/// Resolve all subscriptions for a repo: Platform docs (when enabled) plus static config.
pub async fn resolve_for_repo(
    client: &PlatformClient,
    repo_contract: &LoadedContract,
    this_relay_id: Option<&str>,
    cfg: &RelayConfig,
) -> Result<Vec<WebhookSub>> {
    let mut subs = static_subscriptions(&repo_contract.id(), &cfg.static_webhooks);
    if cfg.use_platform_webhooks {
        if let Some(relay_id) = this_relay_id {
            match platform_subscriptions(client, repo_contract, relay_id, &cfg.secrets).await {
                Ok(mut platform) => subs.append(&mut platform),
                Err(e) => {
                    tracing::warn!(repo = %repo_contract.id(), error = %e, "reading Platform webhook docs failed; using static webhooks only this cycle");
                }
            }
        } else {
            tracing::debug!("no relay identity configured; skipping Platform webhook docs");
        }
    }
    Ok(subs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::StaticWebhook;

    #[test]
    fn static_sub_filters_by_repo_and_maps_fields() {
        let hooks = vec![
            StaticWebhook {
                repo: "RepoA".into(),
                url: "http://127.0.0.1:9000/a".into(),
                events: vec!["push".into()],
                secret: "sa".into(),
                hook_id: Some("hookA".into()),
            },
            StaticWebhook {
                repo: "RepoB".into(),
                url: "http://127.0.0.1:9000/b".into(),
                events: vec![],
                secret: "sb".into(),
                hook_id: None,
            },
        ];
        let a = static_subscriptions("RepoA", &hooks);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].hook_id, "hookA");
        assert_eq!(a[0].secret, b"sa");
        assert!(a[0].wants("push"));
        assert!(!a[0].wants("issues"));

        let b = static_subscriptions("RepoB", &hooks);
        assert_eq!(b.len(), 1);
        // No hook_id → defaults to url.
        assert_eq!(b[0].hook_id, "http://127.0.0.1:9000/b");
        // Empty events → wants everything.
        assert!(b[0].wants("check_run"));
    }

    #[test]
    fn encrypted_path_is_unavailable_stub() {
        assert!(matches!(
            decrypt_secret(b"whatever"),
            Err(RelayError::SecretUnavailable(_))
        ));
    }
}
