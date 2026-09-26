//! forge-v2 webhooks: the forge-collab `webhook` document (`docs/contracts/forge-v2.md` §2).
//!
//! A webhook asks a relay identity to POST GitHub-shaped events for one repository to a URL.
//! It is a document `{repoId, hookId, url, events, relayIdentityId, relayKeyId, senderKeyId,
//! secret, disabled}`:
//!
//! * **Gate**: only a current maintainer of `repoId` can create one (consensus
//!   `ownerRefersTo` → `maintainer`).
//! * **Secret**: the HMAC key the relay signs deliveries with, `encryptedFor` the relay
//!   identity's `ENCRYPTION` key `relayKeyId`, from the writer's `ENCRYPTION` key `senderKeyId`
//!   ([`crate::envelope`]). Consensus checks both keys exist, are enabled and are encryption
//!   keys, and that the bytes have the scheme's shape. It cannot check the plaintext, and the
//!   scheme has no tag, so a secret must be [`SECRET_MIN_LEN`]..=[`SECRET_MAX_LEN`] bytes of
//!   printable ASCII ([`check_secret`]): a wrong key that slips past the padding check (about
//!   1 in 256) yields random bytes, and 32 random bytes are all printable with probability
//!   about 10^-14. (The length alone proves nothing: it is fixed by the ciphertext.)
//! * **Resolution**: newest per `(repoId, hookId)` by `($createdAt, $id)` wins; a newest
//!   document with `disabled` stops the hook. A maintainer removes a hook by writing a newer
//!   disabled document when any other maintainer's document for it would otherwise still be
//!   current, then deleting their own (a document can only be deleted by its owner).
//! * **URL**: public on chain, so it must not carry credentials; `dg webhook add` refuses a
//!   query string or userinfo unless forced.
//!
//! [`WebhookReader`] reads them (by repo, or by the relay they are addressed to, through the
//! `relay` index); [`WebhookService`] writes them, signed by a maintainer.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::envelope::{self, PrivateKey, SecretBytes};
use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::members::MemberReader;
use crate::platform::{
    self, FetchedDocument, FieldValue, IdentityKeyInfo, LoadedContract, LoadedIdentity,
    PlatformClient, QueryFilter, QueryOrder, WriteEngine,
};
use crate::rules::v2::Role;
use crate::scope::RepoRef;

/// The forge-collab document type.
pub const DOC_WEBHOOK: &str = "webhook";

/// The shortest secret accepted: a short HMAC key is weak, and the printable-ASCII check that
/// catches a wrong key needs enough bytes to mean something.
pub const SECRET_MIN_LEN: usize = 32;

/// The longest secret: the schema caps the ciphertext at 128 bytes, which holds at most 111
/// plaintext bytes; 96 is a round bound below that.
pub const SECRET_MAX_LEN: usize = 96;

/// The longest `url` the schema allows.
pub const URL_MAX_LEN: usize = 300;

/// The most `events` the schema allows, and each event name's maximum length.
pub const EVENTS_MAX: usize = 16;
const EVENT_NAME_MAX_LEN: usize = 30;

/// A `webhook` document, decoded (the secret still encrypted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Webhook {
    /// The document `$id` (base58).
    pub document_id: String,
    /// The writer (`$ownerId`, base58): a maintainer of the repo when it was written.
    pub owner_id: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// The repo (`repo` document id, base58).
    pub repo_id: String,
    /// The hook id (32 bytes; stable across supersessions).
    pub hook_id: [u8; 32],
    /// The delivery URL.
    pub url: String,
    /// The subscribed GitHub event names; empty means all.
    pub events: Vec<String>,
    /// The relay identity the hook is addressed to (base58).
    pub relay_identity_id: String,
    /// The relay's key the secret is encrypted to.
    pub relay_key_id: u32,
    /// The writer's key the secret is encrypted from.
    pub sender_key_id: u32,
    /// The encrypted secret.
    pub secret: Vec<u8>,
    /// Whether the hook is switched off.
    pub disabled: bool,
}

impl Webhook {
    /// Decode a fetched `webhook` document; `None` when a required field is missing or
    /// malformed (consensus would not have admitted one, so this is a defensive skip).
    pub fn from_doc(d: &FetchedDocument) -> Option<Self> {
        Some(Self {
            document_id: d.id.clone(),
            owner_id: d.owner_id.clone(),
            created_at: d.created_at.unwrap_or(0),
            repo_id: platform::encode_identifier(d.field_bytes32("repoId")?),
            hook_id: d.field_bytes32("hookId")?,
            url: d.field_str("url")?,
            events: d
                .fields
                .get("events")
                .and_then(FieldValue::as_text_list)
                .unwrap_or_default(),
            relay_identity_id: platform::encode_identifier(d.field_bytes32("relayIdentityId")?),
            relay_key_id: u32::try_from(d.field_u64("relayKeyId")?).ok()?,
            sender_key_id: u32::try_from(d.field_u64("senderKeyId")?).ok()?,
            secret: d.field_bytes("secret")?,
            disabled: d.field_bool("disabled"),
        })
    }

    /// The hook id as lowercase hex.
    pub fn hook_id_hex(&self) -> String {
        hex::encode(self.hook_id)
    }

    /// The `(repoId, hookId)` key resolution groups by.
    pub fn key(&self) -> (String, [u8; 32]) {
        (self.repo_id.clone(), self.hook_id)
    }

    /// Whether this hook wants GitHub event `event` ([`wants_event`]).
    pub fn wants(&self, event: &str) -> bool {
        wants_event(&self.events, event)
    }
}

/// Whether an event filter admits GitHub event `event`: an empty list or `*` means all.
pub fn wants_event(events: &[String], event: &str) -> bool {
    events.is_empty() || events.iter().any(|e| e == event || e == "*")
}

/// The GitHub-style `X-Hub-Signature-256` value (`sha256=<hex>`) of `body` under `secret`.
pub fn sign_body(secret: &[u8], body: &[u8]) -> String {
    use hmac::Mac;
    let mut mac =
        hmac::Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(body);
    format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
}

/// Constant-time check of a `sha256=<hex>` signature over `body` under `secret`: what a
/// webhook consumer runs before trusting a delivery.
pub fn verify_signature(secret: &[u8], body: &[u8], signature_header: &str) -> bool {
    use hmac::Mac;
    let Some(expected) = signature_header
        .strip_prefix("sha256=")
        .and_then(|h| hex::decode(h).ok())
    else {
        return false;
    };
    let mut mac =
        hmac::Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(body);
    mac.verify_slice(&expected).is_ok()
}

/// Newest document per `(repoId, hookId)` by `($createdAt, $id)`: the current state of each
/// hook, disabled ones included. Output is sorted by `(repoId, hookId)`.
pub fn newest_per_hook(hooks: impl IntoIterator<Item = Webhook>) -> Vec<Webhook> {
    let mut newest: BTreeMap<(String, [u8; 32]), Webhook> = BTreeMap::new();
    for h in hooks {
        match newest.get(&h.key()) {
            Some(cur) if (cur.created_at, &cur.document_id) >= (h.created_at, &h.document_id) => {}
            _ => {
                newest.insert(h.key(), h);
            }
        }
    }
    newest.into_values().collect()
}

/// The hooks that deliver: [`newest_per_hook`] without the disabled ones.
pub fn active_hooks(hooks: impl IntoIterator<Item = Webhook>) -> Vec<Webhook> {
    newest_per_hook(hooks)
        .into_iter()
        .filter(|h| !h.disabled)
        .collect()
}

/// A hook id derived from a user label, so re-adding a hook under the same name supersedes it.
pub fn hook_id_for_label(label: &str) -> [u8; 32] {
    Sha256::digest(label.as_bytes()).into()
}

/// A fresh random hook id.
pub fn random_hook_id() -> [u8; 32] {
    let mut id = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut id);
    id
}

/// A fresh webhook secret: 32 random bytes as 64 lowercase hex characters. The HMAC key is
/// the string's bytes, so the receiver configures exactly the printed string (as GitHub's
/// webhook secret field works).
pub fn generate_secret() -> SecretBytes {
    let mut raw = zeroize::Zeroizing::new([0u8; 32]);
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut raw[..]);
    SecretBytes::new(hex::encode(&raw[..]).into_bytes())
}

/// Refuse a secret that is not [`SECRET_MIN_LEN`]..=[`SECRET_MAX_LEN`] bytes of printable
/// ASCII (`0x21..=0x7e`). Enforced when writing and when the relay decrypts: it is what tells
/// a wrong key from the right one (see the module docs). Never names the secret's bytes.
pub fn check_secret(secret: &[u8]) -> Result<()> {
    let len = secret.len();
    if !(SECRET_MIN_LEN..=SECRET_MAX_LEN).contains(&len) {
        return Err(Error::Config(format!(
            "a webhook secret must be {SECRET_MIN_LEN}..={SECRET_MAX_LEN} bytes, not {len}"
        )));
    }
    if !secret.iter().all(|b| (0x21..=0x7e).contains(b)) {
        return Err(Error::Config(
            "a webhook secret must be printable ASCII without spaces".into(),
        ));
    }
    Ok(())
}

/// Check a hook's `url` and `events` against the schema (and require http(s)), so a write
/// fails here with a message instead of at consensus. With `allow_credentials` false, a URL
/// with a query string or userinfo is refused: the URL is public on chain, and those are
/// where tokens usually hide.
pub fn check_url_and_events(url: &str, events: &[String], allow_credentials: bool) -> Result<()> {
    if url.is_empty() || url.len() > URL_MAX_LEN {
        return Err(Error::Config(format!(
            "a webhook url must be 1..={URL_MAX_LEN} bytes"
        )));
    }
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(Error::Config(
            "a webhook url must be http:// or https://".into(),
        ));
    }
    let authority = url.split_once("://").map_or("", |(_, rest)| {
        rest.split(['/', '?', '#']).next().unwrap_or("")
    });
    if !allow_credentials && (url.contains('?') || authority.contains('@')) {
        return Err(Error::Config(
            "the webhook url has a query string or user:password@ — it is stored publicly on \
             chain, so it must not carry credentials (authenticate deliveries with the secret; \
             pass --force if the query holds nothing secret)"
                .into(),
        ));
    }
    if events.len() > EVENTS_MAX {
        return Err(Error::Config(format!(
            "at most {EVENTS_MAX} events per webhook"
        )));
    }
    let mut seen = std::collections::BTreeSet::new();
    for e in events {
        if e.is_empty() || e.len() > EVENT_NAME_MAX_LEN || !seen.insert(e) {
            return Err(Error::Config(format!(
                "invalid or repeated webhook event {e:?} (1..={EVENT_NAME_MAX_LEN} bytes, unique)"
            )));
        }
    }
    Ok(())
}

/// The key of `keys` a secret should be encrypted to: the enabled `ECDSA_SECP256K1`
/// `ENCRYPTION` key with the highest id (unbound, or bound to `contract_id`).
pub fn select_recipient_key<'k>(
    keys: &'k [IdentityKeyInfo],
    contract_id: &str,
) -> Option<&'k IdentityKeyInfo> {
    keys.iter()
        .filter(|k| k.is_usable_encryption_key(contract_id))
        .max_by_key(|k| k.id)
}

/// The given `ENCRYPTION` private keys (key id → key) whose public key is a usable on-chain
/// `ENCRYPTION` key of the identity (`on_chain`): the keys this identity can really encrypt
/// from or decrypt with. A key that does not match its on-chain key is left out.
pub fn held_encryption_keys(
    keys: Vec<(u32, PrivateKey)>,
    on_chain: &[IdentityKeyInfo],
    contract_id: &str,
) -> BTreeMap<u32, PrivateKey> {
    keys.into_iter()
        .filter(|(id, private)| {
            on_chain.iter().any(|k| {
                k.id == *id
                    && k.is_usable_encryption_key(contract_id)
                    && k.public_key.as_slice() == private.public_key().as_slice()
            })
        })
        .collect()
}

/// Why a hook's secret could not be read, for the relay's log (never the secret itself).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SecretError {
    /// The hook names a relay key this relay does not hold (or that is disabled on chain).
    #[error("relay key {0} is not an enabled encryption key this relay holds")]
    RelayKeyNotHeld(u32),
    /// The writer's key the hook names is missing, disabled or not an encryption key.
    #[error("sender key {0} of the writer is missing, disabled or not an encryption key")]
    SenderKeyUnusable(u32),
    /// Decryption failed, or produced something that is not a secret (a wrong key).
    #[error("the secret does not decrypt with these keys ({0})")]
    Undecryptable(String),
}

/// Decrypt `hook`'s secret for the relay holding `relay_keys` (from [`held_encryption_keys`]),
/// given the writer's on-chain keys. Checks that the named relay key is held, that the named
/// sender key is an enabled `ENCRYPTION` key of the writer, and that the plaintext passes
/// [`check_secret`] (the scheme has no tag, see [`crate::envelope`]).
pub fn decrypt_secret(
    hook: &Webhook,
    relay_keys: &BTreeMap<u32, PrivateKey>,
    writer_keys: &[IdentityKeyInfo],
    contract_id: &str,
) -> std::result::Result<SecretBytes, SecretError> {
    let relay_key = relay_keys
        .get(&hook.relay_key_id)
        .ok_or(SecretError::RelayKeyNotHeld(hook.relay_key_id))?;
    let sender = writer_keys
        .iter()
        .find(|k| k.id == hook.sender_key_id && k.is_usable_encryption_key(contract_id))
        .ok_or(SecretError::SenderKeyUnusable(hook.sender_key_id))?;
    let secret = envelope::decrypt(relay_key, &sender.public_key, &hook.secret)
        .map_err(|e| SecretError::Undecryptable(e.to_string()))?;
    check_secret(secret.expose()).map_err(|e| SecretError::Undecryptable(e.to_string()))?;
    Ok(secret)
}

/// The forge-collab contract of `client`'s network.
async fn collab(client: &PlatformClient) -> Result<LoadedContract> {
    let forge = client
        .target()
        .v2
        .as_ref()
        .ok_or_else(|| Error::V2NotDeployed {
            network: client.network().key(),
        })?;
    client.fetch_contract(&forge.collab).await
}

/// Read access to `webhook` documents.
pub struct WebhookReader<'a> {
    client: &'a PlatformClient,
}

impl<'a> WebhookReader<'a> {
    /// A reader over `client`.
    pub fn new(client: &'a PlatformClient) -> Self {
        Self { client }
    }

    async fn read(&self, filters: &[QueryFilter]) -> Result<Vec<Webhook>> {
        let contract = collab(self.client).await?;
        Ok(self
            .client
            .query_all_documents(
                &contract,
                DOC_WEBHOOK,
                filters,
                &[QueryOrder::asc("$createdAt")],
            )
            .await?
            .iter()
            .filter_map(Webhook::from_doc)
            .collect())
    }

    /// Every `webhook` document of repo `repo_id` (the `list` index), complete, oldest first.
    pub async fn for_repo(&self, repo_id: &str) -> Result<Vec<Webhook>> {
        let id = platform::decode_identifier(repo_id)?;
        self.read(&[QueryFilter::eq("repoId", FieldValue::identifier(id))])
            .await
    }

    /// Every document of one hook (the `hook` index), complete, oldest first. The last one is
    /// the hook's current state, whichever relay it is addressed to.
    pub async fn history(&self, repo_id: &str, hook_id: [u8; 32]) -> Result<Vec<Webhook>> {
        let id = platform::decode_identifier(repo_id)?;
        self.read(&[
            QueryFilter::eq("repoId", FieldValue::identifier(id)),
            QueryFilter::eq("hookId", FieldValue::bytes32(hook_id)),
        ])
        .await
    }

    /// Every `webhook` document addressed to `relay_identity_id` (the `relay` index),
    /// complete, oldest first, across all repos.
    pub async fn for_relay(&self, relay_identity_id: &str) -> Result<Vec<Webhook>> {
        let id = platform::decode_identifier(relay_identity_id)?;
        self.read(&[QueryFilter::eq(
            "relayIdentityId",
            FieldValue::identifier(id),
        )])
        .await
    }
}

/// What to create: see [`WebhookService::create`].
#[derive(Debug, Clone)]
pub struct NewWebhook {
    /// The hook id ([`hook_id_for_label`] or [`random_hook_id`]).
    pub hook_id: [u8; 32],
    /// The delivery URL.
    pub url: String,
    /// The GitHub event names; empty means all.
    pub events: Vec<String>,
    /// The relay identity (base58) to address the hook to.
    pub relay_identity_id: String,
    /// The HMAC secret (plaintext; encrypted before it leaves this process).
    pub secret: SecretBytes,
    /// Write the hook switched off (a tombstone superseding other maintainers' documents).
    pub disabled: bool,
    /// Accept a URL with a query string or userinfo (`dg webhook add --force`).
    pub allow_credentials_in_url: bool,
}

/// A signed, ready-to-send webhook document: its properties and the key ids it names.
#[derive(Debug, Clone)]
pub struct PreparedWebhook {
    /// The document properties (the secret already encrypted).
    pub properties: BTreeMap<String, FieldValue>,
    /// The relay key the secret is encrypted to.
    pub relay_key_id: u32,
    /// The writer's key it is encrypted from.
    pub sender_key_id: u32,
    /// The serialized size estimate the cost quote uses, in bytes.
    pub approx_bytes: u64,
}

/// What [`WebhookService::remove`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoveReport {
    /// The caller's documents for the hook that were deleted.
    pub deleted: Vec<String>,
    /// A disabled document written to supersede other maintainers' documents, if needed.
    pub tombstone: Option<String>,
}

/// Webhook writes, signed by a maintainer of the repo.
pub struct WebhookService<'a> {
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
}

impl<'a> WebhookService<'a> {
    /// Bind to the signing identity and its keys.
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

    /// Fail early (with a message rather than consensus code 40120) when the signer is not a
    /// maintainer of `repo`. Advisory: consensus is the authority.
    pub async fn require_maintainer(&self, repo: &RepoRef) -> Result<()> {
        repo.require_v2()?;
        let me = self.identity.id();
        if MemberReader::new(self.client)
            .role_doc(repo, &me, Role::Maintainer)
            .await?
            .is_none()
        {
            return Err(Error::Config(format!(
                "{me} is not a maintainer of {}; only maintainers can manage its webhooks",
                repo.display()
            )));
        }
        Ok(())
    }

    /// Build the document for `input` on `repo`: pick the relay's encryption key and the
    /// signer's, and encrypt the secret between them. Nothing is sent.
    pub async fn prepare(&self, repo: &RepoRef, input: &NewWebhook) -> Result<PreparedWebhook> {
        let forge = repo.require_v2()?;
        check_url_and_events(&input.url, &input.events, input.allow_credentials_in_url)?;
        check_secret(input.secret.expose())?;

        let relay = self
            .client
            .fetch_identity(&input.relay_identity_id)
            .await
            .map_err(|e| match e {
                Error::NotFound => Error::Config(format!(
                    "relay {} is not an identity on this network",
                    input.relay_identity_id
                )),
                other => other,
            })?;
        let relay_keys = relay.public_keys();
        let recipient = select_recipient_key(&relay_keys, &forge.collab).ok_or_else(|| {
            Error::Config(format!(
                "relay {} has no enabled ECDSA_SECP256K1 ENCRYPTION key to encrypt the secret to",
                input.relay_identity_id
            ))
        })?;
        let mine = held_encryption_keys(
            envelope::encryption_keys(self.bridge),
            &self.identity.public_keys(),
            &forge.collab,
        );
        let (sender_key_id, sender) = mine.iter().next_back().ok_or_else(|| {
            Error::Config(
                "the identity file has no ENCRYPTION key matching an enabled on-chain \
                 ENCRYPTION key of the identity; the webhook secret must be encrypted from one"
                    .into(),
            )
        })?;
        let ciphertext = envelope::encrypt(sender, &recipient.public_key, input.secret.expose())?;

        let repo_id = platform::decode_identifier(repo.id())?;
        let relay_id = platform::decode_identifier(&input.relay_identity_id)?;
        let mut properties = BTreeMap::from([
            ("repoId".to_string(), FieldValue::identifier(repo_id)),
            ("hookId".to_string(), FieldValue::bytes32(input.hook_id)),
            ("url".to_string(), FieldValue::text(input.url.clone())),
            (
                "relayIdentityId".to_string(),
                FieldValue::identifier(relay_id),
            ),
            (
                "relayKeyId".to_string(),
                FieldValue::integer(u64::from(recipient.id)),
            ),
            (
                "senderKeyId".to_string(),
                FieldValue::integer(u64::from(*sender_key_id)),
            ),
            ("secret".to_string(), FieldValue::bytes(ciphertext.clone())),
        ]);
        if !input.events.is_empty() {
            properties.insert(
                "events".to_string(),
                FieldValue::text_list(input.events.iter().cloned()),
            );
        }
        if input.disabled {
            properties.insert("disabled".to_string(), FieldValue::boolean(true));
        }
        // Ids, key ids and the ciphertext, the text fields, and ~100 bytes of document and
        // index overhead.
        let approx_bytes = (32 * 3 + 8 + ciphertext.len() + input.url.len() + 100) as u64
            + input.events.iter().map(|e| e.len() as u64 + 2).sum::<u64>();
        Ok(PreparedWebhook {
            properties,
            relay_key_id: recipient.id,
            sender_key_id: *sender_key_id,
            approx_bytes,
        })
    }

    /// Write a prepared webhook document; returns its id.
    pub async fn send(&self, repo: &RepoRef, prepared: &PreparedWebhook) -> Result<String> {
        let forge = repo.require_v2()?;
        let contract = self.client.fetch_contract(&forge.collab).await?;
        WriteEngine::new(self.client, self.identity, self.bridge.doc_op_key()?)?
            .create_document(&contract, DOC_WEBHOOK, prepared.properties.clone())
            .await
    }

    /// Remove hook `hook_id` of `repo`.
    ///
    /// If another maintainer's document would still be current once the signer's own are gone
    /// (only its writer can delete it), first write a newer **disabled** document, addressed to
    /// the signer's own identity and encryption key (no relay can read its secret, and the
    /// hook's relay stops because the newest document no longer names it). Writing it first
    /// means there is no moment in which the other maintainer's document is current again.
    /// Then delete every other document of the hook the signer wrote.
    pub async fn remove(&self, repo: &RepoRef, hook_id: [u8; 32]) -> Result<RemoveReport> {
        let forge = repo.require_v2()?;
        let contract = self.client.fetch_contract(&forge.collab).await?;
        let me = self.identity.id();
        let history = WebhookReader::new(self.client)
            .history(repo.id(), hook_id)
            .await?;
        let mut report = RemoveReport::default();
        let others: Vec<Webhook> = history
            .iter()
            .filter(|h| h.owner_id != me)
            .cloned()
            .collect();
        if let Some(current) = active_hooks(others).into_iter().next() {
            let prepared = self
                .prepare(
                    repo,
                    &NewWebhook {
                        hook_id,
                        url: current.url,
                        events: current.events,
                        relay_identity_id: me.clone(),
                        secret: generate_secret(),
                        disabled: true,
                        allow_credentials_in_url: true,
                    },
                )
                .await?;
            report.tombstone = Some(self.send(repo, &prepared).await?);
        }
        let engine = WriteEngine::new(self.client, self.identity, self.bridge.doc_op_key()?)?;
        for h in history.into_iter().filter(|h| h.owner_id == me) {
            engine
                .delete_document(&contract, DOC_WEBHOOK, &h.document_id)
                .await?;
            report.deleted.push(h.document_id);
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook(doc: &str, repo: u8, hook: u8, at: u64, disabled: bool) -> Webhook {
        Webhook {
            document_id: doc.into(),
            owner_id: "OWNER".into(),
            created_at: at,
            repo_id: platform::encode_identifier([repo; 32]),
            hook_id: [hook; 32],
            url: format!("https://ci.example/{doc}"),
            events: vec![],
            relay_identity_id: platform::encode_identifier([9; 32]),
            relay_key_id: 4,
            sender_key_id: 4,
            secret: vec![0; 64],
            disabled,
        }
    }

    #[test]
    fn newest_per_hook_wins_by_created_at_then_id() {
        let hooks = vec![
            hook("a", 1, 1, 10, false),
            hook("b", 1, 1, 20, false),
            hook("c", 1, 2, 5, false),
            // Same timestamp: the larger $id wins.
            hook("e", 2, 1, 7, false),
            hook("d", 2, 1, 7, false),
        ];
        let newest = newest_per_hook(hooks);
        let ids: Vec<_> = newest.iter().map(|h| h.document_id.as_str()).collect();
        assert_eq!(ids, ["b", "c", "e"]);
    }

    #[test]
    fn a_newest_disabled_document_stops_the_hook() {
        let hooks = vec![
            hook("a", 1, 1, 10, false),
            hook("b", 1, 1, 20, true),
            hook("c", 1, 2, 5, true),
            hook("d", 1, 2, 6, false),
        ];
        let active = active_hooks(hooks);
        let ids: Vec<_> = active.iter().map(|h| h.document_id.as_str()).collect();
        // Hook 1's newest is disabled; hook 2 was re-enabled by a newer document.
        assert_eq!(ids, ["d"]);
    }

    #[test]
    fn event_filters() {
        let mut h = hook("a", 1, 1, 1, false);
        assert!(h.wants("push"));
        h.events = vec!["push".into()];
        assert!(h.wants("push") && !h.wants("issues"));
        h.events = vec!["*".into()];
        assert!(h.wants("release"));
    }

    #[test]
    fn decodes_a_fetched_document() {
        let d = FetchedDocument {
            id: "doc".into(),
            owner_id: "OWNER".into(),
            created_at: Some(5),
            fields: BTreeMap::from([
                ("repoId".into(), FieldValue::identifier([1; 32])),
                ("hookId".into(), FieldValue::bytes32([2; 32])),
                ("url".into(), FieldValue::text("https://x.example/h")),
                ("events".into(), FieldValue::text_list(["push", "issues"])),
                ("relayIdentityId".into(), FieldValue::identifier([3; 32])),
                ("relayKeyId".into(), FieldValue::integer(4)),
                ("senderKeyId".into(), FieldValue::integer(4)),
                ("secret".into(), FieldValue::bytes(vec![7; 80])),
            ]),
        };
        let h = Webhook::from_doc(&d).unwrap();
        assert_eq!(h.hook_id, [2; 32]);
        assert_eq!(h.events, ["push", "issues"]);
        assert_eq!(h.relay_identity_id, platform::encode_identifier([3; 32]));
        assert!(!h.disabled);
        // Missing the secret: skipped.
        let mut bad = d.clone();
        bad.fields.remove("secret");
        assert!(Webhook::from_doc(&bad).is_none());
    }

    #[test]
    fn url_event_and_secret_checks() {
        let check = |url: &str, events: &[String]| check_url_and_events(url, events, false);
        assert!(check("https://x.example/h", &["push".into()]).is_ok());
        assert!(check("ftp://x", &[]).is_err());
        assert!(check(&format!("https://{}", "a".repeat(300)), &[]).is_err());
        assert!(check("https://x", &["push".into(), "push".into()]).is_err());
        assert!(check("https://x", &vec!["e".to_string(); 17]).is_err());
        // Credentials in a public URL: refused unless forced.
        for url in ["https://x/h?token=1", "https://u:p@x/h", "https://u@x/h"] {
            assert!(check(url, &[]).is_err(), "{url}");
            assert!(check_url_and_events(url, &[], true).is_ok(), "{url}");
        }
        assert!(
            check("https://x/a@b", &[]).is_ok(),
            "an @ in the path is not userinfo"
        );

        assert!(check_secret(&[b'a'; 31]).is_err());
        assert!(check_secret(&[b'a'; 32]).is_ok());
        assert!(check_secret(&[b'~'; 96]).is_ok());
        assert!(check_secret(&[b'a'; 97]).is_err());
        let mut spaced = [b'a'; 40];
        spaced[3] = b' ';
        assert!(check_secret(&spaced).is_err());
        assert!(check_secret(&[0xc3; 40]).is_err(), "non-ASCII");
        // The largest secret still fits the schema's 128-byte ciphertext.
        assert!(envelope::ciphertext_len(SECRET_MAX_LEN) <= 128);
        let s = generate_secret();
        assert_eq!(s.len(), 64);
        assert!(s.expose().iter().all(u8::is_ascii_hexdigit));
        assert_eq!(hook_id_for_label("ci"), hook_id_for_label("ci"));
        assert_ne!(random_hook_id(), random_hook_id());
    }

    fn key_info(id: u32, private: &PrivateKey, purpose: &str, disabled: bool) -> IdentityKeyInfo {
        IdentityKeyInfo {
            id,
            purpose: purpose.into(),
            security_level: "MEDIUM".into(),
            key_type: "ECDSA_SECP256K1".into(),
            public_key: private.public_key().to_vec(),
            disabled,
            bound_to: None,
        }
    }

    #[test]
    fn the_relay_decrypts_what_a_maintainer_encrypted_and_checks_every_key() {
        let maint = PrivateKey::from_slice(&[0x21; 32]).unwrap();
        let relay = PrivateKey::from_slice(&[0x42; 32]).unwrap();
        let secret = generate_secret();
        let mut h = hook("a", 1, 1, 1, false);
        h.sender_key_id = 4;
        h.relay_key_id = 4;
        h.secret = envelope::encrypt(&maint, &relay.public_key(), secret.expose()).unwrap();
        let writer_keys = vec![key_info(4, &maint, "ENCRYPTION", false)];
        let relay_keys = BTreeMap::from([(4, PrivateKey::from_slice(&[0x42; 32]).unwrap())]);

        let got = decrypt_secret(&h, &relay_keys, &writer_keys, "C").unwrap();
        assert_eq!(got.expose(), secret.expose());

        // A relay key id this relay does not hold.
        let mut other = h.clone();
        other.relay_key_id = 5;
        assert_eq!(
            decrypt_secret(&other, &relay_keys, &writer_keys, "C"),
            Err(SecretError::RelayKeyNotHeld(5))
        );
        // The writer's key disabled since, or not an encryption key.
        for keys in [
            vec![key_info(4, &maint, "ENCRYPTION", true)],
            vec![key_info(4, &maint, "AUTHENTICATION", false)],
            vec![],
        ] {
            assert_eq!(
                decrypt_secret(&h, &relay_keys, &keys, "C"),
                Err(SecretError::SenderKeyUnusable(4))
            );
        }
        // Other relays' keys: always refused, including the ~1/256 whose padding passes
        // (their random plaintext is not printable ASCII).
        for scalar in 0x43..=0xfeu8 {
            let stranger = BTreeMap::from([(4, PrivateKey::from_slice(&[scalar; 32]).unwrap())]);
            assert!(matches!(
                decrypt_secret(&h, &stranger, &writer_keys, "C"),
                Err(SecretError::Undecryptable(_))
            ));
        }
    }

    #[test]
    fn signatures_round_trip_and_match_githubs_published_value() {
        let sig = sign_body(b"It's a Secret to Everybody", b"Hello, World!");
        assert_eq!(
            sig,
            "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
        );
        assert!(verify_signature(
            b"It's a Secret to Everybody",
            b"Hello, World!",
            &sig
        ));
        assert!(!verify_signature(b"guess", b"Hello, World!", &sig));
        assert!(!verify_signature(
            b"It's a Secret to Everybody",
            b"Hello",
            &sig
        ));
        assert!(!verify_signature(b"k", b"b", "sha256=zz"));
        assert!(!verify_signature(b"k", b"b", "nope"));
    }

    #[test]
    fn key_selection_uses_only_matching_enabled_encryption_keys() {
        let a = PrivateKey::from_slice(&[0x21; 32]).unwrap();
        let b = PrivateKey::from_slice(&[0x22; 32]).unwrap();
        let mut bound = key_info(6, &b, "ENCRYPTION", false);
        bound.bound_to = Some("ELSEWHERE".into());
        let keys = vec![
            key_info(1, &a, "AUTHENTICATION", false),
            key_info(4, &a, "ENCRYPTION", false),
            key_info(5, &b, "ENCRYPTION", true),
            bound,
        ];
        assert_eq!(select_recipient_key(&keys, "C").map(|k| k.id), Some(4));
        let mut bound_here = key_info(7, &b, "ENCRYPTION", false);
        bound_here.bound_to = Some("C".into());
        let keys = [keys, vec![bound_here]].concat();
        assert_eq!(select_recipient_key(&keys, "C").map(|k| k.id), Some(7));
        assert!(select_recipient_key(&[], "C").is_none());
    }
}
