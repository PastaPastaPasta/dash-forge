//! Webhook subscriptions: the forge-v2 `webhook` documents addressed to this relay (PRD 05
//! §4), plus static ones from the config for local testing, resolved into [`WebhookSub`]s.
//!
//! ## Discovery
//!
//! 1. Query forge-collab `webhook` by the `relay` index (`relayIdentityId == me`), complete:
//!    the repos that have ever pointed a hook at this relay.
//! 2. For each such repo, read **all** of its `webhook` documents (the `list` index) and
//!    resolve newest per `(repoId, hookId)` by `($createdAt, $id)`. Resolution must see the
//!    documents addressed to other relays too: a hook re-pointed from relay A to relay B is a
//!    newer document addressed to B, and A must stop. A newest document that is `disabled`
//!    stops the hook.
//! 3. Keep the hooks whose newest document is addressed to this relay.
//! 4. **Writer still a maintainer.** Consensus admitted the document because its writer was a
//!    maintainer when it was written. The relay also requires the writer to be a maintainer
//!    *now*: a revoked maintainer's hook stops delivering (their URL and secret are no longer
//!    vouched for by anyone with authority over the repo). The check runs after resolution,
//!    so a revoked maintainer's newer document never lets an older one resurface: that hook
//!    is simply silent until a current maintainer writes a newer document for it.
//! 5. Decrypt the secret: the relay's `ENCRYPTION` private key named by `relayKeyId` (which
//!    must be one of the relay's enabled on-chain keys, with the private key in the identity
//!    file) and the writer's `ENCRYPTION` public key named by `senderKeyId` (which must still
//!    be enabled). The plaintext must be 32..=96 bytes of printable ASCII: the scheme has no
//!    tag, so this is what rejects a wrong key (`forge_core::webhooks::decrypt_secret`).
//!
//! A hook that fails any check is skipped with a warning naming the hook and the reason,
//! never the secret. Discovery is re-run every `refresh_cycles` poll cycles.

use std::collections::{BTreeMap, BTreeSet};

use forge_core::envelope::{EncryptionKeyFile, PrivateKey, SecretBytes};
use forge_core::members::MemberReader;
use forge_core::platform::{IdentityKeyInfo, PlatformClient};
use forge_core::rules::v2::Role;
use forge_core::scope::RepoRef;
use forge_core::webhooks::{
    active_hooks, decrypt_secret, held_encryption_keys, wants_event, Webhook, WebhookReader,
};

use crate::config::StaticWebhook;
use crate::error::{RelayError, Result};

/// A resolved, deliverable webhook subscription.
///
/// `Debug` is hand-written to redact `secret` and the URL's query.
#[derive(Clone)]
pub struct WebhookSub {
    /// The forge-v2 repo id (base58).
    pub repo_id: String,
    /// Stable hook id: the `hookId` hex (Platform) or the static hook id / url.
    pub hook_id: String,
    /// Delivery URL.
    pub url: String,
    /// Subscribed event names; empty = all.
    pub events: Vec<String>,
    /// The HMAC secret.
    pub secret: SecretBytes,
    /// The document's `$createdAt` (0 for a static hook).
    pub created_at: u64,
    /// The `webhook` document id, for logs (`None` for a static hook).
    pub document_id: Option<String>,
}

impl WebhookSub {
    /// Whether this subscription wants `event` (empty filter or `*` = all events).
    pub fn wants(&self, event: &str) -> bool {
        wants_event(&self.events, event)
    }
}

impl std::fmt::Debug for WebhookSub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhookSub")
            .field("repo_id", &self.repo_id)
            .field("hook_id", &self.hook_id)
            .field("url", &crate::ssrf::redact(&self.url))
            .field("events", &self.events)
            .field("secret", &self.secret)
            .field("document_id", &self.document_id)
            .finish_non_exhaustive()
    }
}

/// The relay identity: its id and the `ENCRYPTION` private keys it holds that match enabled
/// `ENCRYPTION` keys of the identity on chain.
pub struct RelayIdentity {
    /// Base58 identity id.
    pub id: String,
    keys: BTreeMap<u32, PrivateKey>,
}

impl std::fmt::Debug for RelayIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayIdentity")
            .field("id", &self.id)
            .field("key_ids", &self.keys.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl RelayIdentity {
    /// Load the key file (a full bridge identity file, or a minimal one holding only the
    /// ENCRYPTION key: `forge_core::envelope::EncryptionKeyFile`) and match its keys against the
    /// identity on chain. An identity with no usable key is an error: it could decrypt nothing.
    pub async fn load(
        client: &PlatformClient,
        path: &std::path::Path,
        collab_id: &str,
    ) -> Result<Self> {
        let file = EncryptionKeyFile::load(path)?;
        let on_chain = client.fetch_identity(&file.identity_id).await?;
        let keys = held_encryption_keys(file.keys, &on_chain.public_keys(), collab_id);
        if keys.is_empty() {
            return Err(RelayError::Config(format!(
                "relay identity {} has no ENCRYPTION key in {} matching an enabled on-chain \
                 ENCRYPTION key; it cannot decrypt webhook secrets",
                file.identity_id,
                path.display()
            )));
        }
        Ok(Self {
            id: file.identity_id,
            keys,
        })
    }

    /// The key ids this relay can decrypt with.
    pub fn key_ids(&self) -> Vec<u32> {
        self.keys.keys().copied().collect()
    }
}

/// Step 2-3: the current hooks of one repo addressed to `relay_id` (all of the repo's
/// documents in, whatever relay they name).
pub fn hooks_for_relay(repo_docs: Vec<Webhook>, relay_id: &str) -> Vec<Webhook> {
    active_hooks(repo_docs)
        .into_iter()
        .filter(|h| h.relay_identity_id == relay_id)
        .collect()
}

/// The result of one discovery pass.
#[derive(Debug, Default)]
pub struct Discovery {
    /// The deliverable subscriptions of the repos that were read completely.
    pub subs: Vec<WebhookSub>,
    /// Repos whose hooks could not be read this pass (a transient node error). The caller
    /// keeps serving them with their previous hooks: dropping and re-adding a repo would
    /// re-deliver its history, and one bad repo must not stall discovery for the rest.
    pub failed: BTreeSet<String>,
}

/// Every deliverable Platform subscription addressed to `relay` (module docs, steps 1-5).
/// `repo_filter`, when non-empty, limits discovery to those repo ids. Fails only when the
/// `relay` index itself cannot be read; a per-repo failure lands in [`Discovery::failed`].
pub async fn platform_subscriptions(
    client: &PlatformClient,
    relay: &RelayIdentity,
    collab_id: &str,
    repo_filter: &BTreeSet<String>,
) -> Result<Discovery> {
    let reader = WebhookReader::new(client);
    let repos: BTreeSet<String> = reader
        .for_relay(&relay.id)
        .await?
        .into_iter()
        .map(|h| h.repo_id)
        .filter(|r| repo_filter.is_empty() || repo_filter.contains(r))
        .collect();

    let mut writer_keys: BTreeMap<String, Vec<IdentityKeyInfo>> = BTreeMap::new();
    let mut out = Discovery::default();
    for repo_id in repos {
        match repo_subscriptions(client, relay, collab_id, &repo_id, &mut writer_keys).await {
            Ok(mut subs) => out.subs.append(&mut subs),
            Err(e) => {
                tracing::warn!(repo = %repo_id, error = %e, "reading this repo's webhooks failed; keeping its previous hooks");
                out.failed.insert(repo_id);
            }
        }
    }
    Ok(out)
}

/// Steps 2-5 for one repo.
async fn repo_subscriptions(
    client: &PlatformClient,
    relay: &RelayIdentity,
    collab_id: &str,
    repo_id: &str,
    writer_keys: &mut BTreeMap<String, Vec<IdentityKeyInfo>>,
) -> Result<Vec<WebhookSub>> {
    let reader = WebhookReader::new(client);
    let members = MemberReader::new(client);
    let mut subs = Vec::new();
    let hooks = hooks_for_relay(reader.for_repo(repo_id).await?, &relay.id);
    if !hooks.is_empty() {
        let repo = forge_core::resolve::resolve_id(client, repo_id).await?;
        for h in hooks {
            let hook = h.hook_id_hex();
            if !is_maintainer(&members, &repo, &h.owner_id).await? {
                tracing::warn!(repo = %repo_id, hook, writer = %h.owner_id, "skipping webhook: its writer is no longer a maintainer of the repo");
                continue;
            }
            if !writer_keys.contains_key(&h.owner_id) {
                let keys = client.fetch_identity(&h.owner_id).await?.public_keys();
                writer_keys.insert(h.owner_id.clone(), keys);
            }
            match decrypt_secret(&h, &relay.keys, &writer_keys[&h.owner_id], collab_id) {
                Ok(secret) => subs.push(WebhookSub {
                    repo_id: repo_id.to_string(),
                    hook_id: hook,
                    url: h.url,
                    events: h.events,
                    secret,
                    created_at: h.created_at,
                    document_id: Some(h.document_id),
                }),
                Err(e) => {
                    tracing::warn!(repo = %repo_id, hook, document = %h.document_id, reason = %e, "skipping webhook: cannot read its secret");
                }
            }
        }
    }
    Ok(subs)
}

async fn is_maintainer(members: &MemberReader<'_>, repo: &RepoRef, identity: &str) -> Result<bool> {
    Ok(members
        .role_doc(repo, identity, Role::Maintainer)
        .await?
        .is_some())
}

/// A static webhook as a subscription of `repo_id` (its `repo` already resolved). Without a
/// configured `hook_id`, the id is the hex SHA-256 of the URL: stable, and it does not carry
/// a token from the URL's query into logs or the `X-GitHub-Hook-ID` header.
pub fn static_subscription(repo_id: &str, w: &StaticWebhook) -> WebhookSub {
    WebhookSub {
        repo_id: repo_id.to_string(),
        hook_id: w.hook_id.clone().unwrap_or_else(|| {
            hex::encode(<sha2::Sha256 as sha2::Digest>::digest(w.url.as_bytes()))
        }),
        url: w.url.clone(),
        events: w.events.clone(),
        secret: SecretBytes::new(w.secret.clone().into_bytes()),
        created_at: 0,
        document_id: None,
    }
}

/// The repo ids with at least one subscription, and the earliest `$createdAt` among each
/// repo's hooks (0 when a static hook serves it).
pub fn repos_of(subs: &[WebhookSub]) -> BTreeMap<String, u64> {
    let mut out: BTreeMap<String, u64> = BTreeMap::new();
    for s in subs {
        out.entry(s.repo_id.clone())
            .and_modify(|t| *t = (*t).min(s.created_at))
            .or_insert(s.created_at);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::platform::encode_identifier;

    const ME: [u8; 32] = [9; 32];
    const OTHER: [u8; 32] = [8; 32];

    fn doc(id: &str, hook: u8, at: u64, relay: [u8; 32], disabled: bool) -> Webhook {
        Webhook {
            document_id: id.into(),
            owner_id: "MAINT".into(),
            created_at: at,
            repo_id: encode_identifier([1; 32]),
            hook_id: [hook; 32],
            url: "https://ci.example/h".into(),
            events: vec![],
            relay_identity_id: encode_identifier(relay),
            relay_key_id: 4,
            sender_key_id: 4,
            secret: vec![0; 64],
            disabled,
        }
    }

    #[test]
    fn only_hooks_whose_newest_document_names_this_relay_deliver() {
        let me = encode_identifier(ME);
        let docs = vec![
            // Hook 1: addressed to me, then re-pointed to another relay → not mine any more.
            doc("a", 1, 10, ME, false),
            doc("b", 1, 20, OTHER, false),
            // Hook 2: another relay's, then re-pointed to me → mine.
            doc("c", 2, 10, OTHER, false),
            doc("d", 2, 20, ME, false),
            // Hook 3: mine, then disabled → silent.
            doc("e", 3, 10, ME, false),
            doc("f", 3, 20, ME, true),
            // Hook 4: mine, two documents → the newest.
            doc("g", 4, 10, ME, false),
            doc("h", 4, 30, ME, false),
        ];
        let got: Vec<_> = hooks_for_relay(docs, &me)
            .into_iter()
            .map(|h| h.document_id)
            .collect();
        assert_eq!(got, ["d", "h"]);
    }

    #[test]
    fn static_hooks_and_repo_baselines() {
        let w = StaticWebhook {
            repo: "owner/x".into(),
            url: "http://127.0.0.1:9/h?token=abc".into(),
            events: vec!["push".into()],
            secret: "s3cr3t-value".into(),
            hook_id: None,
        };
        let s = static_subscription("R1", &w);
        assert_eq!(s.hook_id.len(), 64);
        assert_eq!(s.hook_id, static_subscription("R1", &w).hook_id, "stable");
        assert!(s.wants("push") && !s.wants("issues"));
        let dumped = format!("{s:?}");
        assert!(!dumped.contains("s3cr3t"), "{dumped}");
        assert!(!dumped.contains("token"), "{dumped}");

        let mut late = s.clone();
        late.repo_id = "R2".into();
        late.created_at = 50;
        let mut later = late.clone();
        later.created_at = 70;
        let repos = repos_of(&[s, later, late]);
        assert_eq!(repos["R1"], 0);
        assert_eq!(repos["R2"], 50, "earliest hook of the repo");
    }
}
