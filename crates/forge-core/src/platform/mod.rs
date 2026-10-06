//! Platform client and the idempotent write engine.
//!
//! This is the one module allowed to touch rs-sdk / rs-dpp (style guide §B: "SDK
//! touched only inside `forge-core::platform`"). Everything the rest of the workspace
//! needs is re-exposed here through SDK-free types (`Network`, `String` ids, the opaque
//! [`LoadedContract`] / [`LoadedIdentity`] handles, the journal structs), so binaries
//! never name a Platform type directly.
//!
//! - [`PlatformClient`] — a `dash_sdk::Sdk` wrapper connected to testnet/mainnet/a devnet with a
//!   trusted HTTP context provider (proof-verified reads; the only path that works
//!   without a Core RPC node — spike S0.3). Read helpers: [`PlatformClient::fetch_contract`],
//!   [`PlatformClient::fetch_identity`], [`PlatformClient::get_balance`],
//!   [`PlatformClient::get_identity_contract_nonce`] (DIP-30 masked).
//! - [`WriteEngine`] — document create/delete against a contract, signing with a
//!   keystore key. **Sign-once / idempotent re-broadcast**: the state transition is
//!   built and signed exactly once ([`WriteEngine::prepare_create`] /
//!   [`WriteEngine::prepare_delete`], capturing a fixed nonce + entropy into a
//!   [`SignedTransition`]); [`WriteEngine::execute`] broadcasts those exact bytes and,
//!   on a retryable failure, RE-broadcasts the *same* bytes. A duplicate landing
//!   ("already exists") is reported as [`BroadcastOutcome::AlreadyExists`], never a fresh
//!   write — so a killed-mid-push retry cannot double-spend or duplicate. A consumed nonce is
//!   [`BroadcastOutcome::NonceConsumed`]: the write landed earlier OR another write took the
//!   nonce, and the create/delete helpers confirm which with a proved read.
//!   The SDK's `broadcast_and_wait` works on NATIVE Rust — the `waitForResponse` panic
//!   in the spikes is WASM-only (`time not implemented`); native tokio has a timer.
//! - [`PushJournal`] / [`WriteIntent`] / [`JournalStore`] — the resumable-push record +
//!   durable idempotent-retry intent that lets an interrupted push re-broadcast the same
//!   signed bytes without re-paying (`.git/dash/journal/<packHash>.json`).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::num::NonZeroUsize;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use dapi_grpc::platform::v0::get_documents_request::get_documents_request_v0::Start;
use dash_sdk::dapi_client::{Address, AddressList, CanRetry};
use dash_sdk::dpp::block::extended_epoch_info::ExtendedEpochInfo;
use dash_sdk::dpp::consensus::basic::BasicError;
use dash_sdk::dpp::consensus::state::state_error::StateError;
use dash_sdk::dpp::consensus::ConsensusError;
use dash_sdk::dpp::dashcore::secp256k1::rand::{rngs::StdRng, Rng, SeedableRng};
use dash_sdk::dpp::dashcore::Network as DashcoreNetwork;
use dash_sdk::dpp::data_contract::accessors::v0::DataContractV0Getters;
use dash_sdk::dpp::document::{
    Document, DocumentV0, DocumentV0Getters, DocumentV0Setters, INITIAL_REVISION,
};
use dash_sdk::dpp::identity::accessors::IdentityGettersV0;
use dash_sdk::dpp::identity::identity_nonce::MergeIdentityNonceResult;
use dash_sdk::dpp::identity::identity_public_key::accessors::v0::IdentityPublicKeyGettersV0;
use dash_sdk::dpp::identity::signer::Signer;
use dash_sdk::dpp::identity::{KeyType, Purpose, SecurityLevel};
use dash_sdk::dpp::platform_value::string_encoding::Encoding;
use dash_sdk::dpp::platform_value::Value;
use dash_sdk::dpp::serialization::{PlatformDeserializableUntrusted, PlatformSerializable};
use dash_sdk::dpp::state_transition::batch_transition::methods::v0::DocumentsBatchTransitionMethodsV0;
use dash_sdk::dpp::state_transition::batch_transition::BatchTransition;
use dash_sdk::dpp::state_transition::proof_result::StateTransitionProofResult;
use dash_sdk::dpp::state_transition::StateTransition;
use dash_sdk::drive::query::{OrderClause, SelectProjection, WhereClause, WhereOperator};
use dash_sdk::platform::contract_groups::ContractGroupMembershipsForContract;
use dash_sdk::platform::documents::document_query::DocumentQuery;
use dash_sdk::platform::fetch_current_no_parameters::FetchCurrent;
use dash_sdk::platform::transition::broadcast::BroadcastStateTransition;
use dash_sdk::platform::{DataContract, Fetch, FetchMany, Identifier, Identity, IdentityPublicKey};
use dash_sdk::{RequestSettings, Sdk, SdkBuilder};
use drive_proof_verifier::{
    DocumentCount, DocumentSplitCounts, DocumentSplitSums, SplitCountEntry, SplitSumEntry,
};
use rs_sdk_trusted_context_provider::TrustedHttpContextProvider;
use simple_signer::single_key_signer::SingleKeySigner;

use crate::error::{Error, Result};
use crate::keystore::IdentityKey;

/// DIP-30 identity-contract-nonce mask: the low 40 bits. Raw nonce reads carry high
/// bits (revision/version markers); mask them off before reporting or deriving the next
/// nonce, or a pipelined batch desyncs (spike S0.1 / DIP-30).
pub const NONCE_MASK: u64 = (1 << 40) - 1;

/// Maximum broadcast attempts for a single signed transition. Each retry re-broadcasts
/// the *identical* signed bytes (same nonce + entropy), so extra attempts can only make
/// the write land once — never twice.
const MAX_BROADCAST_ATTEMPTS: u32 = 4;

/// The `propertyConstraints` rules that read a total (`countOf` / `sumOf`), by document type: a
/// `packManifest`'s chunks, a release tag's revisions, an issue or PR number's predecessors, a
/// thread's transitions, a repo's topics. A node one block behind the documents that feed the
/// total (the writer's own chunks, a revision just published) judges it without them and refuses
/// a correct write (10422). At CheckTx that refusal comes before the nonce is spent, so the same
/// signed bytes can be sent again once the node has caught up ([`MAX_LAG_RETRIES`]). Every one
/// of these rules is judged by whichever node answers: a real refusal is final after the
/// retries, a few seconds later.
pub(crate) const TOTAL_READING_RULES: [(&str, &str); 13] = [
    ("packManifest", "platformChunks"),
    ("release", "oneLive"),
    ("topic", "atMost20"),
    ("issue", "dense"),
    ("patch", "dense"),
    ("transition", "c1_closedAfter"),
    ("transition", "c2_openAfter"),
    ("transition", "c3_mergedAfter"),
    ("transition", "c4_draftAfter"),
    ("transition", "c5_draftClosedAfter"),
    ("transition", "c6_lockedAfter"),
    ("comment", "lockGate"),
    ("review", "lockGate"),
];

/// Waits for a transition whose nonce was too far ahead of the identity's landed writes
/// ([`WriteFailure::NonceAhead`]): 4, 8, 16 and 32 s, about a minute in all.
const MAX_AHEAD_RETRIES: u32 = 4;

/// Re-broadcasts of a transition a total-reading rule refused ([`TOTAL_READING_RULES`]): after
/// about one block, then two (1.5 and 3 times the retry backoff: 3 s and 6 s). A refusal that
/// outlasts them is the rule's answer, not lag.
const MAX_LAG_RETRIES: u32 = 2;

/// Whether `rule` of `document_type` reads a total that lags behind the writer's own writes.
pub(crate) fn reads_a_total(document_type: &str, rule: &str) -> bool {
    TOTAL_READING_RULES.contains(&(document_type, rule))
}

/// How long one `waitForStateTransitionResult` may take, on one node, before the write loop
/// re-broadcasts instead.
///
/// A transition that a node accepted can still never produce a result. The common case is
/// two writers (two processes, or the CLI and the web app) signing with the same identity's
/// contract nonce at once: both pass CheckTx, the block takes one, and Tenderdash quietly
/// drops the other from its mempool on recheck, so no result event ever comes. The SDK's
/// own wait read that silence as a dead node and tried 7 nodes × 30 s (and banned each one):
/// a write that hung for about 3.5 minutes, then recovered. A re-broadcast of the same bytes
/// answers at once instead — "already in mempool/chain" (wait again) or a consumed nonce
/// (the caller checks what landed and re-signs) — so one bounded wait per broadcast is enough.
/// Blocks land in seconds; 20 s leaves plenty of room for a slow one.
const WAIT_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Hard deadline around one wait, proof verification included (a quorum fetch for the
/// proof's signature is a separate HTTP call with its own 30 s client timeout).
const WAIT_DEADLINE: std::time::Duration = std::time::Duration::from_secs(45);

/// Maximum attempts for one proof-verified read. The SDK already rotates across DAPI nodes
/// within an attempt; this outer loop covers the case where that rotation runs out (every
/// node it tried was banned, or kept serving unverifiable proofs) by backing off and
/// starting a fresh rotation.
const MAX_READ_ATTEMPTS: u32 = 4;

/// TCP connect timeout for a DAPI node. The SDK default is none, which leaves an
/// unreachable node to the OS connect timeout — about two minutes on Linux. Every request
/// that lands on a dead node pays that in full, the node's ban lapses after a minute so it
/// is picked again, and each `git-remote-dash` process starts with no ban list. One dead
/// node on testnet was enough to push a partial clone past its command timeout.
const DAPI_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Per-request retries inside the SDK (each retry lands on a different, unbanned node).
/// The SDK default is 3. A testnet with some unreachable or behind nodes exhausts that
/// quickly, and a connect timeout is now cheap enough to allow more.
const DAPI_RETRIES: usize = 6;

pub use crate::network::{Network, NetworkTarget};

pub mod identity_keys;
mod quorum;
pub mod wrap;

pub mod core_chain;
pub mod identity;

/// The `dashcore` network the SDK and its context provider use for `network`.
pub(crate) fn to_dashcore(network: &Network) -> DashcoreNetwork {
    match network {
        Network::Testnet => DashcoreNetwork::Testnet,
        Network::Mainnet => DashcoreNetwork::Mainnet,
        Network::Devnet { .. } => DashcoreNetwork::Devnet,
    }
}

/// An opaque handle to a loaded on-chain data contract.
///
/// Wraps the SDK's `Arc<DataContract>` so the SDK type never appears in a `forge-core`
/// public signature (style guide §B). Obtain one from [`PlatformClient::fetch_contract`]
/// and pass it back to the read/write methods.
#[derive(Clone)]
pub struct LoadedContract(Arc<DataContract>);

/// How a property's where-clause operand is typed ([`LoadedContract::property_kind`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropertyKind {
    /// An identifier: base58 text.
    Identifier,
    /// A byte array: hex (or base64) text.
    Bytes,
    /// An integer (a date included).
    Integer,
    /// A string.
    Text,
    /// A boolean.
    Bool,
    /// An object, an array or a float: not a query operand here.
    Other,
}

impl LoadedContract {
    /// The contract's base58 id.
    pub fn id(&self) -> String {
        self.0.id().to_string(Encoding::Base58)
    }

    /// The contract owner's base58 identity id.
    pub fn owner_id(&self) -> String {
        self.0.owner_id().to_string(Encoding::Base58)
    }

    /// The contract's version (1 at registration, +1 per in-place update). Caches of the
    /// contract's documents are keyed by it.
    pub fn version(&self) -> u32 {
        self.0.version()
    }

    /// Whether the contract declares a document type named `name`. Used to feature-detect
    /// template additions (e.g. the template-v2 `packMirror` type) so a client can fall
    /// back gracefully on a contract instantiated from an older template.
    pub fn has_document_type(&self, name: &str) -> bool {
        self.0.has_document_type_for_name(name)
    }

    /// Whether `document_type` declares a top-level `property`: feature-detects an optional
    /// property a build flag adds (the RC2 riders' `transition.reason`, `comment.diffHunk`), so a
    /// client writes it only where the registered contract has it. `false` for an unknown type.
    pub fn has_property(&self, document_type: &str, property: &str) -> bool {
        use dash_sdk::dpp::data_contract::document_type::accessors::DocumentTypeV0Getters;
        self.0
            .document_type_for_name(document_type)
            .is_ok_and(|t| t.properties().contains_key(property))
    }

    /// The document types the contract declares, by name.
    pub fn document_type_names(&self) -> Vec<String> {
        use dash_sdk::dpp::data_contract::accessors::v0::DataContractV0Getters;
        self.0.document_types().keys().cloned().collect()
    }

    /// How a where-clause operand for `property` of `document_type` is typed: a system field
    /// (`$id`, `$ownerId`, `$createdAt`, …) or a declared property, dotted for a nested one
    /// (`records.identity`). `None` for an unknown type or property.
    pub fn property_kind(&self, document_type: &str, property: &str) -> Option<PropertyKind> {
        use dash_sdk::dpp::data_contract::document_type::accessors::DocumentTypeV0Getters;
        use dash_sdk::dpp::data_contract::document_type::DocumentPropertyType as T;
        match property {
            "$id" | "$ownerId" | "$creatorId" => return Some(PropertyKind::Identifier),
            "$createdAt"
            | "$updatedAt"
            | "$transferredAt"
            | "$createdAtBlockHeight"
            | "$updatedAtBlockHeight"
            | "$createdAtCoreBlockHeight"
            | "$updatedAtCoreBlockHeight"
            | "$revision" => return Some(PropertyKind::Integer),
            _ => {}
        }
        let t = self.0.document_type_for_name(document_type).ok()?;
        let p = t.flattened_properties().get(property)?;
        Some(match &p.property_type {
            T::Identifier | T::IdentifierWithReference(_) => PropertyKind::Identifier,
            T::ByteArray(_) => PropertyKind::Bytes,
            T::String(_) => PropertyKind::Text,
            T::Boolean => PropertyKind::Bool,
            T::U128
            | T::I128
            | T::U64
            | T::I64
            | T::U32
            | T::I32
            | T::U16
            | T::I16
            | T::U8
            | T::I8
            | T::Date
            | T::KeyIdWithReference(_) => PropertyKind::Integer,
            _ => PropertyKind::Other,
        })
    }

    /// Whether `document_type` lists `property` in `immutable` with a condition (Platform v5;
    /// `v5:packages/rs-dpp/src/data_contract/document_type/accessors/v2/mod.rs:136-143`): a
    /// replace that changes it while the condition holds is refused with 40128. `false` for an
    /// unknown type, and for an unconditionally immutable or a mutable property.
    pub fn freezes_when(&self, document_type: &str, property: &str) -> bool {
        use dash_sdk::dpp::data_contract::document_type::accessors::DocumentTypeV2Getters;
        self.0
            .document_type_for_name(document_type)
            .is_ok_and(|t| t.immutable_field_conditions().contains_key(property))
    }
}

#[cfg(test)]
impl LoadedContract {
    /// `contract` as a fetch would load it, for tests.
    pub(crate) fn for_tests(contract: DataContract) -> Self {
        Self(Arc::new(contract))
    }
}

impl std::fmt::Debug for LoadedContract {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoadedContract")
            .field("id", &self.id())
            .finish()
    }
}

/// An opaque handle to a fetched on-chain identity.
///
/// Wraps the SDK's `Identity` so the SDK type never appears in a `forge-core` public
/// signature. Obtain one from [`PlatformClient::fetch_identity`].
#[derive(Clone)]
pub struct LoadedIdentity(pub(crate) Identity);

impl LoadedIdentity {
    /// The identity's base58 id.
    pub fn id(&self) -> String {
        self.0.id().to_string(Encoding::Base58)
    }

    /// The identity's spendable credit balance.
    pub fn balance(&self) -> u64 {
        self.0.balance()
    }

    /// The identity's public keys as SDK-free [`IdentityKeyInfo`]s, ordered by key id.
    pub fn public_keys(&self) -> Vec<IdentityKeyInfo> {
        use dash_sdk::dpp::identity::contract_bounds::ContractBounds;
        self.0
            .public_keys()
            .values()
            .map(|k| IdentityKeyInfo {
                id: k.id(),
                // The names a bridge identity file uses, spelled out (not rs-dpp's Debug).
                purpose: purpose_name(k.purpose()).to_string(),
                security_level: level_name(k.security_level()).to_string(),
                key_type: match k.key_type() {
                    KeyType::ECDSA_SECP256K1 => "ECDSA_SECP256K1",
                    KeyType::BLS12_381 => "BLS12_381",
                    KeyType::ECDSA_HASH160 => "ECDSA_HASH160",
                    KeyType::BIP13_SCRIPT_HASH => "BIP13_SCRIPT_HASH",
                    KeyType::EDDSA_25519_HASH160 => "EDDSA_25519_HASH160",
                }
                .to_string(),
                public_key: k.data().to_vec(),
                disabled: k.is_disabled(),
                bound_to: k.contract_bounds().map(|b| match b {
                    ContractBounds::SingleContract { id }
                    | ContractBounds::SingleContractDocumentType { id, .. } => {
                        id.to_string(Encoding::Base58)
                    }
                    ContractBounds::ContractGroup { .. } => "contract-group".to_string(),
                }),
                bounds: k.contract_bounds().map(|b| match b {
                    ContractBounds::SingleContract { id } => KeyBounds::Contract {
                        id: id.to_string(Encoding::Base58),
                        document_type: None,
                    },
                    ContractBounds::SingleContractDocumentType {
                        id,
                        document_type_name,
                    } => KeyBounds::Contract {
                        id: id.to_string(Encoding::Base58),
                        document_type: Some(document_type_name.clone()),
                    },
                    ContractBounds::ContractGroup { id } => KeyBounds::ContractGroup {
                        id: id.to_string(Encoding::Base58),
                    },
                }),
            })
            .collect()
    }

    /// The protocol-14 limits of key `key_id`: its total budget (credits) and expiry
    /// (block time, ms). `None` when the identity has no such key; both fields `None` for a
    /// key without limits.
    pub fn key_limits(&self, key_id: u32) -> Option<KeyLimits> {
        use dash_sdk::dpp::identity::identity_public_key::accessors::v1::IdentityPublicKeyGettersV1;
        self.0.public_keys().get(&key_id).map(|k| KeyLimits {
            total_budget: k.total_budget(),
            expires_at: k.expires_at(),
        })
    }
}

/// A key purpose as a bridge identity file spells it.
pub(crate) fn purpose_name(p: Purpose) -> &'static str {
    match p {
        Purpose::AUTHENTICATION => "AUTHENTICATION",
        Purpose::ENCRYPTION => "ENCRYPTION",
        Purpose::DECRYPTION => "DECRYPTION",
        Purpose::TRANSFER => "TRANSFER",
        Purpose::SYSTEM => "SYSTEM",
        Purpose::VOTING => "VOTING",
        Purpose::OWNER => "OWNER",
    }
}

/// A security level as a bridge identity file spells it.
pub(crate) fn level_name(l: SecurityLevel) -> &'static str {
    match l {
        SecurityLevel::MASTER => "MASTER",
        SecurityLevel::CRITICAL => "CRITICAL",
        SecurityLevel::HIGH => "HIGH",
        SecurityLevel::MEDIUM => "MEDIUM",
    }
}

/// One public key of an identity, SDK-free ([`LoadedIdentity::public_keys`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityKeyInfo {
    /// The key id.
    pub id: u32,
    /// `AUTHENTICATION`, `ENCRYPTION`, `DECRYPTION`, `TRANSFER`, ...
    pub purpose: String,
    /// `MASTER`, `CRITICAL`, `HIGH` or `MEDIUM`.
    pub security_level: String,
    /// `ECDSA_SECP256K1`, `BLS12_381`, ...
    pub key_type: String,
    /// The key data (a 33-byte compressed point for `ECDSA_SECP256K1`).
    pub public_key: Vec<u8>,
    /// Whether the key is disabled.
    pub disabled: bool,
    /// The contract (base58) the key is bound to, `contract-group` for a group bound key,
    /// `None` for an unbound key. [`IdentityKeyInfo::bounds`] has the group's id and the
    /// document type.
    pub bound_to: Option<String>,
    /// What the key is bound to, in full; `None` for an unbound key.
    pub bounds: Option<KeyBounds>,
}

/// What a contract-bound key may sign for ([`IdentityKeyInfo::bounds`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyBounds {
    /// One contract (base58), and one of its document types when the key is bound to one.
    Contract {
        /// The contract id.
        id: String,
        /// The document type, for a key bound to one.
        document_type: Option<String>,
    },
    /// A contract group (base58): the contracts it holds when the key signs.
    ContractGroup {
        /// The group id.
        id: String,
    },
}

impl IdentityKeyInfo {
    /// An enabled `ECDSA_SECP256K1` key of purpose `ENCRYPTION`, usable for the
    /// `ecdh-secp256k1-aes256-cbc` scheme (`crate::envelope`), unbound or bound to
    /// `contract_id`.
    pub fn is_usable_encryption_key(&self, contract_id: &str) -> bool {
        !self.disabled
            && self.purpose == "ENCRYPTION"
            && self.key_type == "ECDSA_SECP256K1"
            && self.bound_to.as_deref().is_none_or(|b| b == contract_id)
    }
}

/// A key's protocol-14 usage limits ([`LoadedIdentity::key_limits`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyLimits {
    /// Credits the key may ever spend, when it has a budget.
    pub total_budget: Option<u64>,
    /// When the key stops signing (ms), when it expires.
    pub expires_at: Option<u64>,
}

impl std::fmt::Debug for LoadedIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoadedIdentity")
            .field("id", &self.id())
            .field("balance", &self.0.balance())
            .finish()
    }
}

/// The Platform chain's height and block time, from a proof-verified response's metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainTip {
    /// Platform block height.
    pub height: u64,
    /// Block time (ms since the Unix epoch).
    pub time_ms: u64,
}

/// An rs-sdk-backed Platform client: a connected `Sdk` plus the network it targets and the
/// forge-v2 contracts deployed there.
///
/// Construct with [`PlatformClient::connect`]. Proof verification is always on (the
/// trusted context provider supplies quorum public keys over HTTPS); there is no
/// trustless-without-Core path, matching spike S0.3.
pub struct PlatformClient {
    sdk: Sdk,
    target: NetworkTarget,
    /// Contracts fetched (or read from the disk cache) in this process, by base58 id: a
    /// contract is fetched at most once per process (it was re-fetched by nearly every read,
    /// the dominant cost of `dg pr list`, D-500).
    contracts: Mutex<HashMap<String, LoadedContract>>,
    /// DPNS name resolutions in this process, keyed by the homograph-safe label
    /// (`resolve_dpns_name`'s label, without `.dash`): `Some(id)` when registered, `None`
    /// when a proved read found no such name. A repository lookup that spells its owner as a
    /// name (`dash://alice/project`) resolves it again on every reference otherwise.
    dpns_cache: Mutex<HashMap<String, Option<String>>>,
    /// Set once the network refused a composite query: [`Self::query_batch`] then reads one
    /// by one for the rest of the process.
    no_composite: AtomicBool,
    /// The append-only history copies ([`crate::history`]).
    history: crate::history::HistoryStore,
    /// A handle to the same context provider the SDK holds (it is `Clone` over shared
    /// inner state). The trusted provider only serves user data contracts from its
    /// known-contracts cache — it has no SDK-refetch path — so every contract we fetch
    /// must be registered here or the proof verifier rejects writes against it with
    /// "unknown contract".
    context_provider: TrustedHttpContextProvider,
}

/// A contract as the disk cache keeps it: the serialized contract (hex) with the protocol
/// version it was serialized at, its contract version, and when that version was last
/// confirmed on chain.
#[derive(Serialize, Deserialize)]
struct CachedContract {
    version: u32,
    protocol_version: u32,
    checked_at_ms: u64,
    contract: String,
}

impl CachedContract {
    fn write(&self, path: &std::path::Path) {
        if let Ok(json) = serde_json::to_vec(self) {
            crate::cache::write(path, &json);
        }
    }
}

impl std::fmt::Debug for PlatformClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlatformClient")
            .field("target", &self.target)
            .finish_non_exhaustive()
    }
}

impl PlatformClient {
    /// Connect to `target.network`, wiring in the trusted HTTP context provider so proofs
    /// verify without a local Core RPC node.
    ///
    /// Testnet and mainnet use the SDK's built-in seed lists. A devnet uses its configured
    /// DAPI addresses; when it has none they are discovered from the devnet's quorum
    /// service (`/masternodes`), the same trusted source the quorum keys come from.
    ///
    /// A network with no forge-v2 deployment still connects (identity/balance reads work);
    /// repository operations fail with [`Error::V2NotDeployed`] when they need it.
    pub async fn connect(target: NetworkTarget) -> Result<Self> {
        let network = &target.network;
        let dashcore_network = to_dashcore(network);
        let cache_size = NonZeroUsize::new(100).expect("cache size is non-zero");

        // Proofs are checked against quorum keys from a quorum service: the network's, or one
        // the user chose (`target.quorum_url`). The SDK takes quorum keys from nowhere else
        // (rs-sdk-trusted-context-provider `TrustedHttpContextProvider::new_with_url`, which
        // also refuses a plain-http URL on testnet and mainnet).
        let context_provider = TrustedHttpContextProvider::new_with_url(
            dashcore_network,
            target.checked_quorum_base_url()?,
            cache_size,
        )
        .map_err(|e| Error::Platform(format!("building context provider for {network}: {e}")))?;

        let builder = match network {
            Network::Testnet => SdkBuilder::new_testnet(),
            Network::Mainnet => SdkBuilder::new_mainnet(),
            Network::Devnet { dapi_addresses, .. } => {
                let addresses = if dapi_addresses.is_empty() {
                    context_provider
                        .fetch_masternode_addresses()
                        .await
                        .map_err(|e| {
                            Error::Config(format!(
                                "devnet {network} has no DAPI addresses configured and \
                                 discovery from {} failed ({e}); pass --dapi-addresses \
                                 (or set dash.dapiAddresses / DASH_FORGE_DAPI_ADDRESSES)",
                                target.quorum_base_url()
                            ))
                        })?
                        .iter()
                        .map(ToString::to_string)
                        .collect()
                } else {
                    dapi_addresses.clone()
                };
                SdkBuilder::new(parse_address_list(&addresses)?).with_network(dashcore_network)
            }
        };

        // Only the connect timeout and the retry count are set. A per-request `timeout`
        // here would also override the SDK's longer per-method deadlines (30 s for
        // waitForStateTransitionResult, 5 min for streams), because client settings are
        // applied after them.
        let sdk = builder
            .with_settings(RequestSettings {
                connect_timeout: Some(DAPI_CONNECT_TIMEOUT),
                retries: Some(DAPI_RETRIES),
                ..RequestSettings::default()
            })
            .with_context_provider(context_provider.clone())
            .build()
            .map_err(|e| Error::Platform(format!("building SDK: {e}")))?;
        // A quorum rotation the quorum service lags gets every node banned for proofs no node
        // could have made verifiable: the retries unban them ([`quorum`]).
        quorum::register(sdk.address_list(), &context_provider);

        Ok(Self {
            sdk,
            target,
            contracts: Mutex::default(),
            dpns_cache: Mutex::default(),
            no_composite: AtomicBool::new(std::env::var_os("DASH_FORGE_NO_COMPOSITE").is_some()),
            history: crate::history::HistoryStore::default(),
            context_provider,
        })
    }

    /// Connect to `network` with the contracts its embedded deployment records. For callers
    /// without a config layer of their own — tests and examples.
    pub async fn connect_network(network: Network) -> Result<Self> {
        Self::connect(NetworkTarget::for_network(network)?).await
    }

    /// The network this client targets.
    pub fn network(&self) -> &Network {
        &self.target.network
    }

    /// The append-only history copies this client reads through ([`crate::history`]).
    /// `git-remote-dash` points them at the repository's `.git/dash/history`.
    pub fn history(&self) -> &crate::history::HistoryStore {
        &self.history
    }

    /// The resolved network + forge-v2 contracts this client was connected with.
    pub fn target(&self) -> &NetworkTarget {
        &self.target
    }

    /// The Platform protocol version the SDK currently encodes and verifies with.
    ///
    /// The SDK starts at its per-network floor (13 for testnet/mainnet, 14 for a devnet)
    /// and ratchets upward only from the metadata of a *proof-verified* response, so this
    /// is the network's real version only after at least one proved query has succeeded.
    /// Call [`Self::refresh_protocol_version`] first when nothing has been fetched yet.
    pub fn protocol_version(&self) -> u32 {
        self.sdk.protocol_version_number()
    }

    /// The protocol version the network reports in the metadata of a proof-verified
    /// response (the current epoch). Fails when no proved response could be had.
    ///
    /// Unlike `Sdk::refresh_protocol_version`, a failed refresh is not reported as success
    /// with the SDK's per-network floor. A caller that shows the version, or relies on it
    /// being the network's, needs to know whether it was proved. The proved response also
    /// ratchets the SDK's own version, so later writes use it.
    pub async fn refresh_protocol_version(&self) -> Result<u32> {
        let (_epoch, metadata) = ExtendedEpochInfo::fetch_current_with_metadata(&self.sdk)
            .await
            .map_err(|e| Error::Platform(format!("proved protocol-version read failed: {e}")))?;
        Ok(metadata.protocol_version)
    }

    /// The Platform block height and block time (ms) from the metadata of a proof-verified
    /// response (the current epoch): "as of" for a snapshot of reads, such as a mirror's
    /// manifest. Fails when no proved response could be had.
    pub async fn chain_tip(&self) -> Result<ChainTip> {
        let (_epoch, metadata) = ExtendedEpochInfo::fetch_current_with_metadata(&self.sdk)
            .await
            .map_err(|e| Error::Platform(format!("proved chain-tip read failed: {e}")))?;
        Ok(ChainTip {
            height: metadata.height,
            time_ms: metadata.time_ms,
        })
    }

    /// The base58 ids of the contract groups `contract_id` belongs to as a whole
    /// (proof-verified `getContractGroupsForContract`, protocol 14+). Empty when it belongs
    /// to none. Memberships through individual document types or tokens are not included.
    pub async fn contract_groups_of(&self, contract_id: &str) -> Result<Vec<String>> {
        let id = parse_id(contract_id, "contract id")?;
        let memberships = retry_transient_read("fetch contract groups", || {
            ContractGroupMembershipsForContract::fetch(&self.sdk, id)
        })
        .await
        .map_err(|e| Error::Platform(format!("fetching the groups of {contract_id}: {e}")))?;
        Ok(memberships
            .map(|m| {
                m.contract
                    .iter()
                    .map(|g| g.to_string(Encoding::Base58))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// The underlying SDK handle. Kept crate-visible so [`WriteEngine`] can drive it
    /// without re-exporting SDK types across the crate boundary.
    pub(crate) fn sdk(&self) -> &Sdk {
        &self.sdk
    }

    /// A data contract by base58 id: from this process's memo, else the disk cache
    /// ([`crate::cache`], re-validated against the on-chain version at most once per
    /// [`crate::cache::CONTRACT_RECHECK`] with one proved `getDataContractsLatestVersions`),
    /// else a proved `getDataContract`.
    pub async fn fetch_contract(&self, contract_id: &str) -> Result<LoadedContract> {
        if let Some(c) = self.memo().get(contract_id) {
            return Ok(c.clone());
        }
        let id = parse_id(contract_id, "contract id")?;
        let contract = if let Some(c) = self.cached_contract(contract_id, id).await {
            c
        } else {
            let contract =
                retry_transient_read("fetch contract", || DataContract::fetch(&self.sdk, id))
                    .await
                    .map_err(|e| {
                        self.read_error(
                            contract_id,
                            &e,
                            &format!("fetching contract {contract_id}"),
                        )
                    })?
                    .ok_or_else(|| {
                        self.forge_contract_missing(contract_id, "Platform proved it absent")
                            .unwrap_or(Error::NotFound)
                    })?;
            self.store_contract(contract_id, &contract);
            contract
        };
        Ok(self.remember(contract_id.to_string(), contract))
    }

    /// Register a proof-verified contract with the context provider (so proof verification
    /// of later writes against it can resolve it, see field docs) and this process's memo.
    fn remember(&self, contract_id: String, contract: DataContract) -> LoadedContract {
        self.context_provider.add_known_contract(contract.clone());
        let loaded = LoadedContract(Arc::new(contract));
        self.memo().insert(contract_id, loaded.clone());
        loaded
    }

    /// The contract to build a query of `contract` with: `contract` itself, or the newer
    /// version of it this process has refreshed to since ([`Self::refreshed_after`]). A caller
    /// may hold a [`LoadedContract`] for as long as it likes (a daemon holds one for days).
    fn current(&self, contract: &LoadedContract) -> Arc<DataContract> {
        match self.memo().get(&contract.id()) {
            Some(held) if held.version() > contract.version() => Arc::clone(&held.0),
            _ => Arc::clone(&contract.0),
        }
    }

    /// After a read of `contracts` failed with `e`: when `e` is a document written under a newer
    /// version of one of them than the read was built with ([`is_stale_contract`]: an in-place
    /// contract update gave its type a property), refresh each ([`Self::refresh_contract`]) and
    /// say whether any moved on, so the read may be retried once. Anything else is `false`,
    /// without a request.
    async fn refreshed_after<'c>(
        &self,
        contracts: impl IntoIterator<Item = &'c LoadedContract>,
        e: &Error,
    ) -> bool {
        if !matches!(e, Error::Platform(m) if is_stale_contract(m)) {
            return false;
        }
        let mut seen = BTreeSet::new();
        let mut moved = false;
        for contract in contracts {
            let id = contract.id();
            if seen.insert(id.clone()) {
                // The version the failed read was built with ([`Self::current`]), which may
                // already be newer than the caller's after an earlier update.
                let used = self.current(contract).version();
                moved |= self.refresh_contract(&id, used).await;
            }
        }
        moved
    }

    /// When the network holds a newer version of contract `contract_id` than `held` (one proved
    /// version read decides), fetch it (proved), past this process's memo and the disk cache,
    /// and keep it in both. True when the version now held is newer than `held` (also when
    /// another read of this process refreshed it first).
    pub(crate) async fn refresh_contract(&self, contract_id: &str, held: u32) -> bool {
        if self
            .memo()
            .get(contract_id)
            .is_some_and(|c| c.version() > held)
        {
            return true;
        }
        let Ok(id) = parse_id(contract_id, "contract id") else {
            return false;
        };
        if !matches!(self.latest_contract_version(id).await, Ok(Some(v)) if v > held) {
            return false;
        }
        let fetched =
            retry_transient_read("fetch contract", || DataContract::fetch(&self.sdk, id)).await;
        let Ok(Some(contract)) = fetched else {
            return false;
        };
        let newer = contract.version() > held;
        if newer {
            tracing::info!(
                contract_id,
                from = held,
                to = contract.version(),
                "the contract was updated in place; reading with the new version"
            );
            self.store_contract(contract_id, &contract);
            self.remember(contract_id.to_string(), contract);
        }
        newer
    }

    /// [`Self::refresh_contract`] the contract of a write's `transition` from the version this
    /// process holds: after the write's proof held a document newer than that version.
    pub(crate) async fn refresh_contract_of(&self, transition: &StateTransition) {
        use dash_sdk::dpp::state_transition::batch_transition::accessors::DocumentsBatchTransitionAccessorsV0;
        let StateTransition::Batch(batch) = transition else {
            return;
        };
        let Some(first) = batch.first_transition() else {
            return;
        };
        let contract_id = first.data_contract_id().to_string(Encoding::Base58);
        let held = self
            .memo()
            .get(&contract_id)
            .map_or(0, LoadedContract::version);
        self.refresh_contract(&contract_id, held).await;
    }

    fn memo(&self) -> std::sync::MutexGuard<'_, HashMap<String, LoadedContract>> {
        crate::history::lock(&self.contracts)
    }

    /// Where the disk cache keeps contract `contract_id` of this network.
    fn contract_cache_path(&self, contract_id: &str) -> Option<std::path::PathBuf> {
        crate::cache::dir().map(|d| {
            d.join("contracts")
                .join(crate::cache::component(&self.target.network.key()))
                .join(format!("{}.json", crate::cache::component(contract_id)))
        })
    }

    /// The disk-cached contract, when present, decodable and still current. A copy checked
    /// within [`crate::cache::CONTRACT_RECHECK`] is used as is; an older one costs one proved
    /// version read and is dropped when the network holds another version.
    async fn cached_contract(&self, contract_id: &str, id: Identifier) -> Option<DataContract> {
        use dash_sdk::dpp::serialization::PlatformDeserializableWithPotentialValidationFromVersionedStructureUntrusted as _;
        let path = self.contract_cache_path(contract_id)?;
        let entry: CachedContract = serde_json::from_slice(&crate::cache::read(&path)?).ok()?;
        let version = dash_sdk::dpp::version::PlatformVersion::get(entry.protocol_version).ok()?;
        let bytes = hex::decode(&entry.contract).ok()?;
        let contract =
            DataContract::versioned_deserialize_untrusted(&bytes, false, version).ok()?;
        if contract.id() != id || contract.version() != entry.version {
            return None;
        }
        // A check time in the future (a clock that moved back) is not trusted as fresh.
        let now = crate::cache::now_ms();
        let fresh = entry.checked_at_ms <= now
            && u128::from(now - entry.checked_at_ms) < crate::cache::CONTRACT_RECHECK.as_millis();
        if fresh {
            return Some(contract);
        }
        match self.latest_contract_version(id).await {
            Ok(Some(v)) if v == entry.version => {
                CachedContract {
                    checked_at_ms: crate::cache::now_ms(),
                    ..entry
                }
                .write(&path);
                Some(contract)
            }
            _ => None,
        }
    }

    /// The current on-chain version of contract `id` (proved; on protocol 14 from its
    /// version item, a few hundred bytes rather than the contract).
    async fn latest_contract_version(&self, id: Identifier) -> Result<Option<u32>> {
        use dash_sdk::platform::data_contracts_latest_versions::DataContractLatestVersion;
        let versions = retry_transient_read("contract versions", || {
            DataContractLatestVersion::fetch_many(&self.sdk, vec![id])
        })
        .await
        .map_err(|e| Error::Platform(format!("reading the contract version: {e}")))?;
        Ok(versions.version_of(&id))
    }

    /// Keep a proof-verified contract in the disk cache.
    fn store_contract(&self, contract_id: &str, contract: &DataContract) {
        use dash_sdk::dpp::serialization::PlatformSerializableWithPlatformVersion as _;
        let Some(path) = self.contract_cache_path(contract_id) else {
            return;
        };
        let version = self.sdk.version();
        let Ok(bytes) = contract.serialize_to_bytes_with_platform_version(version) else {
            return;
        };
        CachedContract {
            version: contract.version(),
            protocol_version: version.protocol_version,
            checked_at_ms: crate::cache::now_ms(),
            contract: hex::encode(bytes),
        }
        .write(&path);
    }

    /// A failed read of `contract_id` as a crate error: [`Error::ContractsMissing`] when
    /// Platform refused it because that contract, one of this build's forge contracts, does
    /// not exist on the network (Drive's `contract not found`: a devnet that was reset);
    /// otherwise the SDK's error under `what`.
    fn read_error(&self, contract_id: &str, e: &dash_sdk::Error, what: &str) -> Error {
        if is_contract_missing(e) {
            if let Some(missing) = self.forge_contract_missing(contract_id, &e.to_string()) {
                return missing;
            }
        }
        Error::Platform(format!("{what}: {e}"))
    }

    /// [`Error::ContractsMissing`] for `contract_id` when it is one of the forge contracts this
    /// build records for the network; `None` for any other contract (a repository's own).
    fn forge_contract_missing(&self, contract_id: &str, detail: &str) -> Option<Error> {
        let forge = self.target.v2.as_ref()?;
        if !forge.contains(contract_id) {
            return None;
        }
        let network = &self.target.network;
        Some(Error::ContractsMissing {
            network: network
                .devnet_name()
                .map_or_else(|| network.key(), |name| format!("devnet {name}")),
            detail: format!("contract {contract_id}: {detail}"),
        })
    }

    /// Fetch an identity by base58 id.
    pub async fn fetch_identity(&self, identity_id: &str) -> Result<LoadedIdentity> {
        let id = parse_id(identity_id, "identity id")?;
        let identity = retry_transient_read("fetch identity", || Identity::fetch(&self.sdk, id))
            .await
            .map_err(|e| Error::Platform(format!("fetching identity {identity_id}: {e}")))?
            .ok_or(Error::NotFound)?;
        Ok(LoadedIdentity(identity))
    }

    /// Fetch the identity `bridge` signs for. When this network has none, the error is
    /// [`Error::IdentityNotFound`] (E304), naming this network and the one the key records.
    pub async fn fetch_signer(
        &self,
        bridge: &crate::keystore::BridgeIdentity,
    ) -> Result<LoadedIdentity> {
        match self.fetch_identity(&bridge.identity_id).await {
            Err(Error::NotFound) => Err(Error::IdentityNotFound {
                identity_id: bridge.identity_id.clone(),
                network: self.network().key(),
                key_network: crate::network::full_network_key(&bridge.network),
            }),
            r => r,
        }
    }

    /// The identity's spendable credit balance.
    pub async fn get_balance(&self, identity_id: &str) -> Result<u64> {
        Ok(self.fetch_identity(identity_id).await?.balance())
    }

    /// The identity-contract nonce, DIP-30 masked to the low 40 bits.
    ///
    /// This reads the *current* nonce (no bump) for reporting/diagnostics; the write
    /// path fetches its own bumped nonce inside [`WriteEngine::prepare_create`]. The
    /// mask is mandatory for reporting — see [`NONCE_MASK`].
    pub async fn get_identity_contract_nonce(
        &self,
        identity_id: &str,
        contract_id: &str,
    ) -> Result<u64> {
        let id = parse_id(identity_id, "identity id")?;
        let contract = parse_id(contract_id, "contract id")?;
        let raw = self
            .sdk
            .get_identity_contract_nonce(id, contract, false, None)
            .await
            .map_err(|e| Error::Platform(format!("fetching identity-contract nonce: {e}")))?;
        Ok(raw & NONCE_MASK)
    }

    /// Whether a document of `document_type` with base58 `document_id` exists in
    /// `contract` (proof-verified single-document fetch).
    pub async fn document_exists(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
    ) -> Result<bool> {
        Ok(self
            .fetch_document(contract, document_type, document_id)
            .await?
            .is_some())
    }

    /// The document of `document_type` with base58 `document_id` in `contract`, or `None`
    /// when it provably does not exist (proof-verified single-document fetch).
    pub async fn fetch_document(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
    ) -> Result<Option<FetchedDocument>> {
        let fetch = || Box::pin(self.fetch_document_once(contract, document_type, document_id));
        match fetch().await {
            Err(e) if Box::pin(self.refreshed_after([contract], &e)).await => fetch().await,
            found => found,
        }
    }

    async fn fetch_document_once(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
    ) -> Result<Option<FetchedDocument>> {
        let doc_id = parse_id(document_id, "document id")?;
        let query = DocumentQuery::new(self.current(contract), document_type)
            .map_err(|e| Error::Platform(format!("building document query: {e}")))?
            .with_document_id(&doc_id);
        let found = retry_transient_read("fetch document", || {
            Document::fetch(&self.sdk, query.clone())
        })
        .await
        .map_err(|e| {
            self.read_error(
                &contract.id(),
                &e,
                &format!("fetching document {document_id}"),
            )
        })?;
        Ok(found.as_ref().map(FetchedDocument::from_document))
    }

    /// Query **one page** of `document_type` in `contract`, applying `filters` (AND-ed
    /// where-clauses), `order` (traversal order), a `limit` (which must be >= 1; see below)
    /// and an optional `start_after` cursor (a base58 document id).
    ///
    /// For a read that must be COMPLETE, use [`PlatformClient::query_all_documents`]
    /// instead — this returns at most one page and gives the caller no signal about whether
    /// more rows exist.
    ///
    /// Returns SDK-free [`FetchedDocument`]s (no `Document` / `Value` leaks across the
    /// module boundary, style guide §B).
    ///
    /// ## byteArray operands are passed *natively*, not base64
    ///
    /// The wasm/JS SDK requires `byteArray` where-operands as base64 strings (spike
    /// S0.8). The native rs-sdk path is different: a [`WhereClause`]'s value is a
    /// `platform_value::Value`, so a `refNameHash` / `packHash` operand is supplied as
    /// `Value::Bytes(..)` / `Value::Bytes32(..)` / `Value::Identifier(..)` directly —
    /// **no base64 encoding**. [`QueryValue`] carries the SDK-free operand and this
    /// method converts it to the right `Value` variant. (base64 is the wasm quirk only.)
    pub async fn query_documents(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        filters: &[QueryFilter],
        order: &[QueryOrder],
        limit: u32,
        start_after: Option<&str>,
    ) -> Result<Vec<FetchedDocument>> {
        // A descending page after a cursor cannot be proved on protocol 13 under the 4.2
        // verifier (see [`ascending_equivalent`]). When an ascending equivalent exists, read
        // the whole set that way (complete, reversed to the requested order) and slice out
        // the page after the cursor. This costs a complete read per page; the listings that
        // page descending (issues, PRs, stars) are small.
        if let (Some(after), Some(_)) = (start_after, ascending_equivalent(filters, order)) {
            if limit == 0 {
                return Err(Error::Config("query limit must be greater than 0".into()));
            }
            let all = self
                .query_all_documents(contract, document_type, filters, order)
                .await?;
            let Some(at) = all.iter().position(|d| d.id == after) else {
                return Err(Error::Config(format!(
                    "start_after document {after} is not in the {document_type} result set"
                )));
            };
            return Ok(all.into_iter().skip(at + 1).take(limit as usize).collect());
        }
        self.query_page(contract, document_type, filters, order, limit, start_after)
            .await
    }

    /// One page exactly as requested — the network half of [`Self::query_documents`], which
    /// the complete reader calls directly (it only ever pages ascending after a cursor).
    async fn query_page(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        filters: &[QueryFilter],
        order: &[QueryOrder],
        limit: u32,
        start_after: Option<&str>,
    ) -> Result<Vec<FetchedDocument>> {
        let page = || {
            Box::pin(self.query_page_once(
                contract,
                document_type,
                filters,
                order,
                limit,
                start_after,
            ))
        };
        match page().await {
            Err(e) if Box::pin(self.refreshed_after([contract], &e)).await => page().await,
            documents => documents,
        }
    }

    async fn query_page_once(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        filters: &[QueryFilter],
        order: &[QueryOrder],
        limit: u32,
        start_after: Option<&str>,
    ) -> Result<Vec<FetchedDocument>> {
        let mut query = DocumentQuery::new(self.current(contract), document_type)
            .map_err(|e| Error::Platform(format!("building document query: {e}")))?;

        for f in filters {
            query = query.with_where(f.to_where_clause());
        }
        for o in order {
            query = query.with_order_by(o.to_order_clause());
        }
        // `limit` is REQUIRED to be a real bound. It used to be optional, with 0 meaning
        // "leave it unset" — but unset does not mean unlimited: Drive fills an absent limit
        // from `DriveConfig::default_query_limit`, which is 100, the same value as its
        // maximum. So `limit = 0` read as "give me everything" and silently delivered the
        // first 100 rows with no short-page signal, which is how several
        // state-reconstructing reads in this crate came to fold truncated histories. Callers
        // that genuinely want everything must use `query_all_documents`.
        if limit == 0 {
            return Err(Error::Config(
                "query limit must be greater than 0; use query_all_documents() for a \
                 complete read (limit 0 does not mean unlimited — Drive caps it at 100)"
                    .into(),
            ));
        }
        query = query.with_limit(limit);
        if let Some(after) = start_after {
            let id = parse_id(after, "start_after document id")?;
            query.start = Some(Start::StartAfter(id.to_vec()));
        }

        let documents = retry_transient_read("query documents", || {
            Document::fetch_many(&self.sdk, query.clone())
        })
        .await
        .map_err(|e| {
            self.read_error(
                &contract.id(),
                &e,
                &format!("querying {document_type} documents"),
            )
        })?;

        Ok(documents
            .into_iter()
            .filter_map(|(_id, maybe_doc)| maybe_doc.as_ref().map(FetchedDocument::from_document))
            .collect())
    }

    /// Each matching document's consensus `$updatedAt` (ms), by `$id`, for a type that records
    /// it: every match, paged on the `$id` cursor as [`Self::query_all_documents`] pages (the
    /// documents themselves are read through that; this is the one system field it leaves out).
    /// `order` must be ascending and end in a unique traversal. A document without one is absent.
    pub async fn query_updated_at(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        filters: &[QueryFilter],
        order: &[QueryOrder],
    ) -> Result<BTreeMap<String, u64>> {
        const PAGE: u32 = 100;
        let mut out = BTreeMap::new();
        let mut after: Option<Vec<u8>> = None;
        loop {
            let mut query = DocumentQuery::new(self.current(contract), document_type)
                .map_err(|e| Error::Platform(format!("building document query: {e}")))?;
            for f in filters {
                query = query.with_where(f.to_where_clause());
            }
            for o in order {
                query = query.with_order_by(o.to_order_clause());
            }
            query = query.with_limit(PAGE);
            if let Some(id) = &after {
                query.start = Some(Start::StartAfter(id.clone()));
            }
            let documents = retry_transient_read("query documents", || {
                Document::fetch_many(&self.sdk, query.clone())
            })
            .await
            .map_err(|e| {
                self.read_error(
                    &contract.id(),
                    &e,
                    &format!("querying {document_type} documents"),
                )
            })?;
            let mut last = None;
            let mut n = 0u32;
            for (id, doc) in &documents {
                n += 1;
                last = Some(id.to_vec());
                if let Some(at) = doc.as_ref().and_then(Document::updated_at) {
                    out.insert(id.to_string(Encoding::Base58), at);
                }
            }
            if n < PAGE {
                return Ok(out);
            }
            after = last;
        }
    }

    /// Query **every** matching document, paginating past Platform's ≤100-row page cap.
    ///
    /// [`PlatformClient::query_documents`] returns a single page (≤100 rows); an
    /// authorization-bearing fold (events, memberships) MUST see all rows or a stranger
    /// can bury real state-changing docs past row 100 with un-gated spam and freeze the
    /// displayed state. This loops on the `$id` cursor (`start_after` = the last row's id)
    /// until a short page is returned. `order` must be a stable traversal so the cursor
    /// advances deterministically.
    pub async fn query_all_documents(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        filters: &[QueryFilter],
        order: &[QueryOrder],
    ) -> Result<Vec<FetchedDocument>> {
        self.query_documents_up_to(contract, document_type, filters, order, usize::MAX)
            .await
    }

    /// [`Self::query_all_documents`], stopping once more than `max` rows are held: the rows in
    /// `order`, at least `max + 1` of them when more match (the caller truncates and says so).
    /// A descending read that is paged ascending and reversed (see [`ascending_equivalent`])
    /// cannot stop early (its first rows are the last read), so it reads every match.
    pub async fn query_documents_up_to(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        filters: &[QueryFilter],
        order: &[QueryOrder],
        max: usize,
    ) -> Result<Vec<FetchedDocument>> {
        // Page a descending read in ascending order and reverse it (see
        // [`ascending_equivalent`]): the rs-sdk 4.2 verifier rejects the proof a protocol-13
        // node returns for a descending page that starts after a cursor, so every read past
        // the first 100 rows would fail on testnet.
        let ascending = ascending_equivalent(filters, order);
        let order = ascending.as_deref().unwrap_or(order);
        // See [`tie_probe_allowed`]: when the index ends in `$createdAt`, every page boundary
        // is followed by a read of the boundary timestamp, so same-block rows are not lost.
        let tie_safe = tie_probe_allowed(filters, order);
        let max = if ascending.is_some() { usize::MAX } else { max };
        // `async move` so the futures own their inputs; returning a future that borrows the
        // closure's parameter would not outlive the call.
        let mut documents = page_until(
            document_type,
            |start_after: Option<String>| async move {
                self.query_page(
                    contract,
                    document_type,
                    filters,
                    order,
                    PAGE_SIZE,
                    start_after.as_deref(),
                )
                .await
            },
            tie_safe.then_some(|created_at: u64| async move {
                let mut tie = filters.to_vec();
                tie.push(QueryFilter::eq(
                    "$createdAt",
                    FieldValue::uint64(created_at),
                ));
                self.query_page(contract, document_type, &tie, order, PAGE_SIZE, None)
                    .await
            }),
            max,
        )
        .await?;
        if ascending.is_some() {
            documents.reverse();
        }
        Ok(documents)
    }

    /// [`Self::query_all_documents`] for documents of ~15 KB each (pack `chunk`s), whose
    /// pages are paced by an [`AdaptivePager`] instead of a fixed size and the SDK's fixed
    /// deadline (QW3-005).
    ///
    /// A 100-row page of chunks is about 1.5 MB. Under the SDK's default request deadline
    /// (10 s plus the 5 s connect timeout) a DAPI node serving 30-65 KB/s can never answer
    /// it: every node timed out, was banned for it, and `dg repo clone` of a 2.8 MB repo
    /// failed with "no available addresses" after 11 minutes. Here a page starts at
    /// [`LARGE_PAGE_START`] rows with a deadline sized for a slow link, the deadline follows
    /// the rate the network actually delivered, and a page that still runs out of time is
    /// asked again from the same cursor with half the rows and twice the time. The nodes are
    /// not banned for it (the deadline is ours, not their fault). Rows already read are kept:
    /// a slow page costs that page, not the read.
    ///
    /// `order` must be all-ascending with no `$createdAt` tie handling needed (chunks are
    /// read by `seq`); any other read goes through [`Self::query_all_documents`].
    pub async fn query_all_large_documents(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        filters: &[QueryFilter],
        order: &[QueryOrder],
    ) -> Result<Vec<FetchedDocument>> {
        // (Its pages refresh and retry one by one.)
        if !order.iter().all(|o| o.ascending) || tie_probe_allowed(filters, order) {
            return self
                .query_all_documents(contract, document_type, filters, order)
                .await;
        }
        // A document newer than the held contract restarts the read once, under the new
        // version: once per update per process.
        let read = || {
            Box::pin(self.query_all_large_documents_once(contract, document_type, filters, order))
        };
        match read().await {
            Err(e) if Box::pin(self.refreshed_after([contract], &e)).await => read().await,
            documents => documents,
        }
    }

    async fn query_all_large_documents_once(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        filters: &[QueryFilter],
        order: &[QueryOrder],
    ) -> Result<Vec<FetchedDocument>> {
        let what = format!("querying {document_type} documents");
        let what = what.as_str();
        page_adaptively(
            document_type,
            AdaptivePager::new(LARGE_PAGE_START, LARGE_PAGE_MAX),
            |start_after: Option<String>, limit: u32, timeout: std::time::Duration| async move {
                let mut query =
                    DocumentQuery::new(self.current(contract), document_type).map_err(|e| {
                        PageFailure::Other(Error::Platform(format!("building document query: {e}")))
                    })?;
                for f in filters {
                    query = query.with_where(f.to_where_clause());
                }
                for o in order {
                    query = query.with_order_by(o.to_order_clause());
                }
                query = query.with_limit(limit);
                if let Some(after) = &start_after {
                    let id =
                        parse_id(after, "start_after document id").map_err(PageFailure::Other)?;
                    query.start = Some(Start::StartAfter(id.to_vec()));
                }
                let settings = large_page_settings(timeout);
                let documents = retry_with_quorum_waits(
                    "query documents",
                    RETRY_BACKOFF_BASE,
                    // A page that ran out of time is the pager's to shrink, not a flake to
                    // repeat at the same size.
                    |e: &dash_sdk::Error| is_transient_node_error(e) && !is_deadline(e),
                    rate_limit_reset,
                    (quorum::is_quorum_miss, &quorum::QUORUM_WAITS),
                    || {
                        let fut = Document::fetch_many_with_metadata(
                            &self.sdk,
                            query.clone(),
                            Some(settings),
                        );
                        async move {
                            crate::budget::acquire().await;
                            fut.await.map(|(docs, _metadata)| docs)
                        }
                    },
                )
                .await
                .map_err(|e| {
                    if is_deadline(&e) {
                        PageFailure::Deadline(e.to_string())
                    } else {
                        PageFailure::Other(self.read_error(&contract.id(), &e, what))
                    }
                })?;
                Ok(documents
                    .into_iter()
                    .filter_map(|(_id, maybe_doc)| {
                        maybe_doc.as_ref().map(FetchedDocument::from_document)
                    })
                    .collect())
            },
        )
        .await
    }

    /// Fetch several contracts in ONE proved `getDataContracts` request (those not already
    /// held by this process or the disk cache), registering each like
    /// [`Self::fetch_contract`]. A contract the network does not have is skipped; the next
    /// [`Self::fetch_contract`] of it reports that.
    pub async fn prefetch_contracts(&self, contract_ids: &[&str]) -> Result<()> {
        let mut missing = Vec::new();
        for &id in contract_ids {
            if self.memo().contains_key(id) {
                continue;
            }
            let parsed = parse_id(id, "contract id")?;
            match self.cached_contract(id, parsed).await {
                Some(c) => {
                    self.remember(id.to_string(), c);
                }
                None => missing.push(parsed),
            }
        }
        if missing.is_empty() {
            return Ok(());
        }
        let fetched = retry_transient_read("fetch contracts", || {
            DataContract::fetch_many(&self.sdk, missing.clone())
        })
        .await
        .map_err(|e| Error::Platform(format!("fetching contracts: {e}")))?;
        for (id, contract) in fetched {
            let Some(contract) = contract else { continue };
            let id = id.to_string(Encoding::Base58);
            self.store_contract(&id, &contract);
            self.remember(id, contract);
        }
        Ok(())
    }

    /// Run several one-page reads in as few round trips as possible: the first read is the
    /// page of a protocol-14 composite `getDocuments` and the others ride along as its
    /// sub-queries (independent siblings, or lookups bound to an earlier read's documents),
    /// all proved under ONE merged proof (`GetDocumentsRequestV1.sub_queries`,
    /// `dash-platform-queries` `composite_document_query`). At most
    /// [`MAX_BATCH_READS`] reads go in one request; more are split.
    ///
    /// Every read must carry an explicit `limit` (≤ 100) and no cursor: a composite page takes
    /// none, so page with a range clause (`$createdAt >= t`). A read's results are exactly
    /// what the same read alone returns. When the network refuses the composite shape the
    /// reads are sent one by one; when it has no composite surface at all (before protocol
    /// 14), later batches of this client go that way too.
    pub async fn query_batch(&self, reads: &[BatchRead<'_>]) -> Result<Vec<Vec<FetchedDocument>>> {
        for (i, read) in reads.iter().enumerate() {
            if let Some(b) = &read.bind {
                if i >= MAX_BATCH_READS || b.source >= i {
                    return Err(Error::Config(format!(
                        "batched read {i} binds to read {}: a binding names an earlier read of \
                         the first {MAX_BATCH_READS}",
                        b.source
                    )));
                }
            }
        }
        let mut out = Vec::with_capacity(reads.len());
        for group in reads.chunks(MAX_BATCH_READS) {
            out.extend(self.query_group(group).await?);
        }
        Ok(out)
    }

    /// One composite request for `reads` (≤ [`MAX_BATCH_READS`], bindings group-local).
    async fn query_group(&self, reads: &[BatchRead<'_>]) -> Result<Vec<Vec<FetchedDocument>>> {
        use std::sync::atomic::Ordering as AtomicOrdering;
        let composite_ok = reads.len() > 1 && !self.no_composite.load(AtomicOrdering::Relaxed);
        if composite_ok {
            // A Vec, not the `map` iterator: a closure over `&BatchRead` held across the await
            // makes this future not `Send` for every lifetime, which callers that spawn it
            // (forge-gateway's handlers) need.
            let contracts: Vec<&LoadedContract> = reads.iter().map(|r| r.contract).collect();
            let composite = match Box::pin(self.query_composite(reads)).await {
                Err(e) if Box::pin(self.refreshed_after(contracts, &e)).await => {
                    Box::pin(self.query_composite(reads)).await
                }
                other => other,
            };
            match composite {
                Ok(r) => return Ok(r),
                Err(Error::CompositeRefused {
                    unsupported,
                    reason,
                }) => {
                    // A network without the composite surface stops trying; a shape refused
                    // for its own reasons only falls back this once. Transient and rate-limit
                    // failures are not refusals: they propagate (after the read's own
                    // retries) rather than turning one request into several.
                    tracing::info!(%reason, "composite query refused; reading one by one");
                    if unsupported {
                        self.no_composite.store(true, AtomicOrdering::Relaxed);
                    }
                }
                Err(e) => return Err(e),
            }
        }
        let mut out: Vec<Vec<FetchedDocument>> = Vec::with_capacity(reads.len());
        for read in reads {
            let mut filters = read.filters.clone();
            if let Some(bind) = &read.bind {
                // The composite derives `field IN <source's values>`; alone, that is an `in`
                // clause built from the source's results (≤ 100 values, Drive's `in` cap).
                let values: Vec<FieldValue> = out
                    .get(bind.source)
                    .map(|docs| {
                        let mut seen = BTreeSet::new();
                        docs.iter()
                            .filter_map(|d| bind_value(d, &bind.source_property))
                            .filter(|v| seen.insert(*v))
                            .map(FieldValue::Identifier)
                            .collect()
                    })
                    .unwrap_or_default();
                if values.is_empty() {
                    out.push(Vec::new());
                    continue;
                }
                filters.push(QueryFilter::in_list(bind.field.clone(), values));
            }
            // Drive treats `in` as a range, which needs an order on its field; a composite
            // lookup left unordered gets one from the page, a plain query must name it.
            let mut order = read.order.clone();
            if let Some(bind) = &read.bind {
                if !order.iter().any(|o| o.field == bind.field) {
                    order.insert(0, QueryOrder::asc(bind.field.clone()));
                }
            }
            out.push(
                self.query_page(
                    read.contract,
                    read.document_type,
                    &filters,
                    &order,
                    read.limit,
                    None,
                )
                .await?,
            );
        }
        Ok(out)
    }

    /// `reads` as one composite request: the first is the page, the rest its sub-queries.
    async fn query_composite(&self, reads: &[BatchRead<'_>]) -> Result<Vec<Vec<FetchedDocument>>> {
        use dash_sdk::platform::{CompositeBindingSource, CompositeSubQuery};
        use drive_proof_verifier::CompositeDocuments;
        let (page, rest) = reads
            .split_first()
            .ok_or_else(|| Error::Config("an empty batch".into()))?;
        let mut query = self.document_query(page)?;
        for read in rest {
            let mut sub =
                CompositeSubQuery::documents(self.current(read.contract), read.document_type)
                    .map_err(|e| Error::Platform(format!("building a sub-query: {e}")))?
                    .with_limit(read.limit);
            for f in &read.filters {
                sub = sub.with_where(f.to_where_clause());
            }
            for o in &read.order {
                sub = sub.with_order_by(o.to_order_clause());
            }
            if let Some(b) = &read.bind {
                let source = match b.source {
                    0 => CompositeBindingSource::Page,
                    // Sub-query indices exclude the page.
                    n => CompositeBindingSource::SubQuery(n - 1),
                };
                sub = sub.bound_to(source, b.source_property.clone(), b.field.clone());
            }
            query = query.with_sub_query(sub);
        }
        let result = retry_transient_read("composite query", || {
            CompositeDocuments::fetch(&self.sdk, query.clone())
        })
        .await
        .map_err(|e| {
            // Not a refusal of the composition: plain reads would get the same answer.
            if is_contract_missing(&e) {
                self.read_error(&page.contract.id(), &e, "composite query")
            } else {
                composite_refusal(&e)
            }
        })?
        .ok_or_else(|| Error::Platform("composite query returned nothing".into()))?;
        if result.sub_results.len() != rest.len() {
            return Err(Error::Platform(format!(
                "composite query answered {} of {} sub-queries",
                result.sub_results.len(),
                rest.len()
            )));
        }
        let convert = |docs: &[Document]| docs.iter().map(FetchedDocument::from_document).collect();
        Ok(std::iter::once(convert(&result.page_documents))
            .chain(result.sub_results.iter().map(|s| convert(s.documents())))
            .collect())
    }

    /// The plain `DocumentQuery` of one read (no cursor).
    fn document_query(&self, read: &BatchRead<'_>) -> Result<DocumentQuery> {
        if read.limit == 0 || read.limit > PAGE_SIZE {
            return Err(Error::Config(format!(
                "a batched read needs a limit of 1 to {PAGE_SIZE}"
            )));
        }
        let mut query = DocumentQuery::new(self.current(read.contract), read.document_type)
            .map_err(|e| Error::Platform(format!("building document query: {e}")))?;
        for f in &read.filters {
            query = query.with_where(f.to_where_clause());
        }
        for o in &read.order {
            query = query.with_order_by(o.to_order_clause());
        }
        Ok(query.with_limit(read.limit))
    }

    /// An O(1) provable count of `document_type` documents in `contract` matching
    /// `filters`, via the count-tree `getDocuments`+`select count(*)` aggregate (the
    /// mechanism behind star / issue / PR totals, data-contracts §3). The `filters`
    /// fields must exactly match a `countable` index prefix (or the type must be
    /// `documentsCountable`), else consensus rejects the count.
    pub async fn count_documents(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        filters: &[QueryFilter],
    ) -> Result<u64> {
        let mut query = DocumentQuery::new(self.current(contract), document_type)
            .map_err(|e| Error::Platform(format!("building count query: {e}")))?;
        for f in filters {
            query = query.with_where(f.to_where_clause());
        }
        query = query.with_select(SelectProjection::count_star());
        let count = retry_transient_read("count documents", || {
            DocumentCount::fetch(&self.sdk, query.clone())
        })
        .await
        .map_err(|e| {
            self.read_error(
                &contract.id(),
                &e,
                &format!("counting {document_type} documents"),
            )
        })?;
        Ok(count.map_or(0, |c| c.0))
    }

    /// Proved counts of `document_type` documents matching `filters`, one per value of the
    /// `In` filter on `group_field` (`select count(*) … group by group_field`,
    /// [`DocumentSplitCounts`]): Drive answers one count tree per `In` value of a countable
    /// index the filters cover exactly (`PointLookupProof`). Keyed by the value's tree-key
    /// bytes ([`decode_u8_key`] for an integer ≤ 255, the 32 raw bytes for an identifier); a
    /// value with no documents is absent (read it as 0). No `limit` is sent: Drive refuses one
    /// on a group-by-`In` aggregate (the `In` array, ≤ 100 values, bounds the result).
    pub async fn count_documents_grouped(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        filters: &[QueryFilter],
        group_field: &str,
    ) -> Result<BTreeMap<Vec<u8>, u64>> {
        let query = self
            .grouped_query(contract, document_type, filters, group_field)?
            .with_select(SelectProjection::count_star());
        let counts = retry_transient_read("grouped count", || {
            DocumentSplitCounts::fetch(&self.sdk, query.clone())
        })
        .await
        .map_err(|e| {
            self.read_error(
                &contract.id(),
                &e,
                &format!("counting {document_type} documents by {group_field}"),
            )
        })?;
        Ok(split_counts(counts.map(|c| c.0).unwrap_or_default()))
    }

    /// Proved sums of `sum_field` over `document_type` documents matching `filters`, one per
    /// value of the `In` filter on `group_field` (`select sum(sum_field) … group by
    /// group_field`, [`DocumentSplitSums`]) on an index whose `summable` names `sum_field`.
    /// Keyed like [`Self::count_documents_grouped`]; a value with no documents is absent.
    pub async fn sum_documents_grouped(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        filters: &[QueryFilter],
        group_field: &str,
        sum_field: &str,
    ) -> Result<BTreeMap<Vec<u8>, i64>> {
        let query = self
            .grouped_query(contract, document_type, filters, group_field)?
            .with_select(SelectProjection::sum(sum_field));
        let sums = retry_transient_read("grouped sum", || {
            DocumentSplitSums::fetch(&self.sdk, query.clone())
        })
        .await
        .map_err(|e| {
            self.read_error(
                &contract.id(),
                &e,
                &format!("summing {document_type}.{sum_field} by {group_field}"),
            )
        })?;
        Ok(split_sums(sums.map(|s| s.0).unwrap_or_default()))
    }

    /// The query of a grouped aggregate: `filters`, grouped by `group_field`, no limit.
    fn grouped_query(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        filters: &[QueryFilter],
        group_field: &str,
    ) -> Result<DocumentQuery> {
        if !filters
            .iter()
            .any(|f| f.op == QueryOp::In && f.field == group_field)
        {
            return Err(Error::Config(format!(
                "a grouped aggregate groups by an `in` filter; none on {group_field}"
            )));
        }
        let mut query = DocumentQuery::new(self.current(contract), document_type)
            .map_err(|e| Error::Platform(format!("building grouped query: {e}")))?;
        for f in filters {
            query = query.with_where(f.to_where_clause());
        }
        Ok(query.with_group_by(group_field))
    }

    /// What is left of key `key_id`'s budget on `identity_id` (protocol 14), proof-verified.
    /// `None` when the key has no budget (or does not exist); `Some(0)` when it is spent.
    pub async fn key_remaining_budget(
        &self,
        identity_id: &str,
        key_id: u32,
    ) -> Result<Option<u64>> {
        use dash_sdk::platform::identity_keys_remaining_budgets::{
            IdentityKeysRemainingBudgets, IdentityKeysRemainingBudgetsQuery,
        };
        let query = IdentityKeysRemainingBudgetsQuery {
            identity_id: parse_id(identity_id, "identity id")?,
            key_ids: vec![key_id],
        };
        let budgets = retry_transient_read("key budget", || {
            IdentityKeysRemainingBudgets::fetch(&self.sdk, query.clone())
        })
        .await
        .map_err(|e| Error::Platform(format!("reading key {key_id}'s remaining budget: {e}")))?;
        Ok(budgets.and_then(|b| b.get(&key_id).copied().flatten()))
    }
}

/// Flat grouped counts: entries summed per key across `In` forks (a flat query has none), an
/// absent or unproved count read as 0.
fn split_counts(entries: Vec<SplitCountEntry>) -> BTreeMap<Vec<u8>, u64> {
    let mut out: BTreeMap<Vec<u8>, u64> = BTreeMap::new();
    for e in entries {
        let slot = out.entry(e.key).or_default();
        *slot = slot.saturating_add(e.count.unwrap_or(0));
    }
    out
}

/// Flat grouped sums, as [`split_counts`].
fn split_sums(entries: Vec<SplitSumEntry>) -> BTreeMap<Vec<u8>, i64> {
    let mut out: BTreeMap<Vec<u8>, i64> = BTreeMap::new();
    for e in entries {
        let slot = out.entry(e.key).or_default();
        *slot = slot.saturating_add(e.sum.unwrap_or(0));
    }
    out
}

/// The value of a `u8` property from its tree key (one byte, sign bit flipped: rs-dpp
/// `DocumentPropertyType::encode_u8`). `None` for a key of another width.
#[must_use]
pub fn decode_u8_key(key: &[u8]) -> Option<u8> {
    match key {
        [b] => Some(b ^ 0x80),
        _ => None,
    }
}

/// The identifier (base58) an identifier property's tree key names (its 32 raw bytes).
#[must_use]
pub fn decode_identifier_key(key: &[u8]) -> Option<String> {
    <[u8; 32]>::try_from(key).ok().map(encode_identifier)
}

/// A read-only where-operator, mapped to the SDK's [`WhereOperator`] inside this module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryOp {
    /// `field == value`.
    Eq,
    /// `field > value` (the skip-scan seek operator, S0.8).
    Gt,
    /// `field >= value`.
    Gte,
    /// `field < value`.
    Lt,
    /// `field <= value`.
    Lte,
    /// `field startsWith value` (string prefix search).
    StartsWith,
    /// `field in [values]` (the value is a [`FieldValue::List`], at most 100 items).
    In,
}

impl QueryOp {
    fn to_operator(self) -> WhereOperator {
        match self {
            QueryOp::Eq => WhereOperator::Equal,
            QueryOp::Gt => WhereOperator::GreaterThan,
            QueryOp::Gte => WhereOperator::GreaterThanOrEquals,
            QueryOp::Lt => WhereOperator::LessThan,
            QueryOp::Lte => WhereOperator::LessThanOrEquals,
            QueryOp::StartsWith => WhereOperator::StartsWith,
            QueryOp::In => WhereOperator::In,
        }
    }
}

/// The most reads [`PlatformClient::query_batch`] sends in one request: the page plus
/// Drive's `MAX_SUB_QUERIES` (10).
pub const MAX_BATCH_READS: usize = 11;

/// One read of a [`PlatformClient::query_batch`]: a single page (explicit `limit`, no cursor).
#[derive(Debug, Clone)]
pub struct BatchRead<'c> {
    /// The contract.
    pub contract: &'c LoadedContract,
    /// The document type.
    pub document_type: &'c str,
    /// Fixed where-clauses.
    pub filters: Vec<QueryFilter>,
    /// Order.
    pub order: Vec<QueryOrder>,
    /// Row cap, 1–100.
    pub limit: u32,
    /// Derive `field IN <values>` from an earlier read's documents.
    pub bind: Option<BatchBind>,
}

/// A [`BatchRead`]'s derived clause: `field IN` the `source_property` values (identifiers:
/// `$id`, `$ownerId` or an identifier property) of read `source`'s documents.
#[derive(Debug, Clone)]
pub struct BatchBind {
    /// The index of an earlier read of the same batch group.
    pub source: usize,
    /// The source documents' property.
    pub source_property: String,
    /// The bound field of this read.
    pub field: String,
}

/// The identifier `property` of `d` a binding reads (`$id`, `$ownerId` or an identifier
/// field), as raw bytes.
fn bind_value(d: &FetchedDocument, property: &str) -> Option<[u8; 32]> {
    match property {
        "$id" => decode_identifier(&d.id).ok(),
        "$ownerId" => decode_identifier(&d.owner_id).ok(),
        other => d.field_bytes32(other),
    }
}

impl QueryFilter {
    /// The SDK where-clause.
    fn to_where_clause(&self) -> WhereClause {
        WhereClause {
            field: self.field.clone(),
            operator: self.op.to_operator(),
            value: self.value.clone().into_query_value(),
        }
    }
}

impl QueryOrder {
    /// The SDK order clause.
    fn to_order_clause(&self) -> OrderClause {
        OrderClause {
            field: self.field.clone(),
            ascending: self.ascending,
        }
    }
}

/// An SDK-free query operand. Reuses [`FieldValue`] so a `byteArray` operand is carried
/// as native bytes and converted to `Value::Bytes*` (never base64 — see
/// [`PlatformClient::query_documents`]).
pub type QueryValue = FieldValue;

trait IntoQueryValue {
    fn into_query_value(self) -> Value;
}
impl IntoQueryValue for QueryValue {
    fn into_query_value(self) -> Value {
        self.into_value()
    }
}

/// A single AND-ed where-clause for [`PlatformClient::query_documents`].
#[derive(Debug, Clone)]
pub struct QueryFilter {
    /// The indexed field name (e.g. `refNameHash`, `packHash`, `normalizedName`,
    /// `$ownerId`, `seq`).
    pub field: String,
    /// The comparison operator.
    pub op: QueryOp,
    /// The operand (native bytes / integer / text / identifier).
    pub value: QueryValue,
}

impl QueryFilter {
    /// A `field == value` filter.
    pub fn eq(field: impl Into<String>, value: QueryValue) -> Self {
        Self {
            field: field.into(),
            op: QueryOp::Eq,
            value,
        }
    }

    /// A `field > value` filter (skip-scan seek).
    pub fn gt(field: impl Into<String>, value: QueryValue) -> Self {
        Self {
            field: field.into(),
            op: QueryOp::Gt,
            value,
        }
    }

    /// A `field >= value` filter.
    pub fn gte(field: impl Into<String>, value: QueryValue) -> Self {
        Self {
            field: field.into(),
            op: QueryOp::Gte,
            value,
        }
    }

    /// A `field in [values]` filter (at most 100 values).
    pub fn in_list(field: impl Into<String>, values: Vec<QueryValue>) -> Self {
        Self {
            field: field.into(),
            op: QueryOp::In,
            value: FieldValue::List(values),
        }
    }

    /// A `field <= value` filter.
    pub fn lte(field: impl Into<String>, value: QueryValue) -> Self {
        Self {
            field: field.into(),
            op: QueryOp::Lte,
            value,
        }
    }
}

/// A traversal-order clause. `ascending: false` is the query-time reverse traversal the
/// data-contracts `$createdAt desc` markers denote (stored indices are asc-only, S0.6).
#[derive(Debug, Clone)]
pub struct QueryOrder {
    /// The field to order by (e.g. `$createdAt`, `refNameHash`, `seq`).
    pub field: String,
    /// Ascending (`true`) or reverse (`false`).
    pub ascending: bool,
}

impl QueryOrder {
    /// Ascending order by `field`.
    pub fn asc(field: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            ascending: true,
        }
    }

    /// Descending (reverse-traversal) order by `field`.
    pub fn desc(field: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            ascending: false,
        }
    }
}

/// An SDK-free view of a fetched document: its base58 ids, consensus `$createdAt` and
/// its properties as [`FieldValue`]s. Built by [`PlatformClient::query_documents`]; the
/// SDK `Document` / `Value` types never cross this boundary (style guide §B).
///
/// Serializable so the append-only history cache ([`crate::history`]) can keep rows exactly as
/// Platform returned them (ciphertext included, for a private repository).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FetchedDocument {
    /// Base58 document `$id`.
    pub id: String,
    /// Base58 `$ownerId` (the creator).
    pub owner_id: String,
    /// Consensus `$createdAt` in ms, when the document type records it.
    pub created_at: Option<u64>,
    /// `$createdAtBlockHeight`, set by the network, when the document type records it
    /// (required on every private-repo type: anchors and the late-content rule order by it,
    /// `docs/security/private-repos.md` §13).
    pub created_at_block_height: Option<u64>,
    /// `$updatedAtBlockHeight`, when the document type records it (replaceable issue, patch
    /// and comment: the late-content rule judges edits too, §8.2).
    pub updated_at_block_height: Option<u64>,
    /// Property name → value, in the SDK-free field representation.
    pub fields: BTreeMap<String, FieldValue>,
    /// `$revision` of a mutable document (what a guarded replace compares, see
    /// [`DocumentEngine::replace_document_guarded`]); `None` when the type records none.
    pub revision: Option<u64>,
}

impl FetchedDocument {
    fn from_document(doc: &Document) -> Self {
        let id = doc.id().to_string(Encoding::Base58);
        let owner_id = doc.owner_id().to_string(Encoding::Base58);
        let created_at = doc.created_at();
        let created_at_block_height = doc.created_at_block_height();
        let updated_at_block_height = doc.updated_at_block_height();
        let fields = doc
            .properties()
            .iter()
            .filter_map(|(k, v)| FieldValue::from_value(v).map(|fv| (k.clone(), fv)))
            .collect();
        Self {
            id,
            owner_id,
            created_at,
            created_at_block_height,
            updated_at_block_height,
            fields,
            revision: doc.revision(),
        }
    }

    /// The raw bytes of a `byteArray` / identifier field, if present and byte-shaped.
    pub fn field_bytes(&self, name: &str) -> Option<Vec<u8>> {
        self.fields.get(name).and_then(FieldValue::as_bytes)
    }

    /// A 32-byte field (an identifier or a hash), if present and exactly 32 bytes.
    pub fn field_bytes32(&self, name: &str) -> Option<[u8; 32]> {
        self.field_bytes(name)
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
    }

    /// A `byteArray` field as lowercase hex (the form `crate::rules` oids/hashes use).
    pub fn field_hex(&self, name: &str) -> Option<String> {
        self.field_bytes(name).map(hex::encode)
    }

    /// An integer field, if present.
    pub fn field_u64(&self, name: &str) -> Option<u64> {
        self.fields.get(name).and_then(FieldValue::as_u64)
    }

    /// A string field, if present.
    pub fn field_str(&self, name: &str) -> Option<String> {
        self.fields
            .get(name)
            .and_then(FieldValue::as_str)
            .map(str::to_string)
    }

    /// A boolean field (absent → `false`).
    pub fn field_bool(&self, name: &str) -> bool {
        matches!(self.fields.get(name), Some(FieldValue::Bool(true)))
    }
}

/// Build an rs-sdk `Signer` (`SingleKeySigner`) from a keystore key's WIF.
///
/// Lives here, not in `keystore`, because `SingleKeySigner` is an SDK type and the SDK
/// is confined to this module (style guide §B). The keystore stays SDK-free and only
/// hands over the (redacted) WIF.
fn signer_from_key(key: &IdentityKey) -> Result<SingleKeySigner> {
    SingleKeySigner::new(key.private_key_wif.expose())
        .map_err(|e| Error::Config(format!("invalid signing key WIF: {e}")))
}

/// Whether a prepared write creates or deletes a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteOp {
    /// A document create.
    Create,
    /// A document delete.
    Delete,
    /// A document replace (an edit of a mutable document by its owner).
    Replace,
}

/// A signed, ready-to-broadcast document write — built and signed exactly once.
///
/// Holds the precomputed document id (deterministic from the baked entropy for a
/// create) and the [`SignedTransition`] (fixed nonce + bytes). Re-executing the same
/// `PreparedWrite` re-broadcasts the identical bytes; it can never produce a second,
/// different write. This is the unit the sign-once / idempotent-retry model operates on.
#[derive(Clone)]
pub struct PreparedWrite {
    document_id: String,
    document_type: String,
    op: WriteOp,
    signed: SignedTransition,
}

impl PreparedWrite {
    /// The base58 document id this write targets (for a create, deterministic from the
    /// baked entropy — known before broadcast).
    pub fn document_id(&self) -> &str {
        &self.document_id
    }

    /// The document type name.
    pub fn document_type(&self) -> &str {
        &self.document_type
    }

    /// Whether this is a create or delete.
    pub fn operation(&self) -> WriteOp {
        self.op
    }

    /// The signed transition (fixed nonce + serialized bytes) to broadcast.
    pub fn signed(&self) -> &SignedTransition {
        &self.signed
    }
}

impl std::fmt::Debug for PreparedWrite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedWrite")
            .field("document_id", &self.document_id)
            .field("document_type", &self.document_type)
            .field("op", &self.op)
            .field("signed", &self.signed)
            .finish()
    }
}

/// The idempotent document write engine over a [`PlatformClient`].
///
/// Bound to one signing identity + one on-chain signing key (selected from the
/// identity's public keys to match the keystore private key at the right security
/// level). Create and delete documents against any contract the identity is authorized
/// to write.
pub struct WriteEngine<'a> {
    client: &'a PlatformClient,
    signer: SingleKeySigner,
    signing_key: IdentityPublicKey,
    owner_id: Identifier,
}

impl<'a> WriteEngine<'a> {
    /// Build a write engine for `identity`, signing with the keystore `key`.
    ///
    /// Verifies the keystore private key matches an on-chain AUTHENTICATION key on the
    /// identity and selects that `IdentityPublicKey` for signing. The caller picks the
    /// keystore key at the right security level (HIGH/CRITICAL for doc ops — see
    /// `keystore::BridgeIdentity::doc_op_key`).
    pub fn new(
        client: &'a PlatformClient,
        identity: &LoadedIdentity,
        key: &IdentityKey,
    ) -> Result<Self> {
        let signer = signer_from_key(key)?;
        let signing_key = select_matching_key(&identity.0, &signer)?;
        Ok(Self {
            client,
            signer,
            signing_key,
            owner_id: identity.0.id(),
        })
    }

    /// The on-chain key id this engine signs with (diagnostics).
    pub fn signing_key_id(&self) -> u32 {
        self.signing_key.id()
    }

    /// The [`PlatformClient`] this engine drives — lets a backend built over the engine
    /// (e.g. [`crate::backends::PlatformBackend`]) run read queries without re-plumbing a
    /// separate client handle.
    pub(crate) fn client(&self) -> &PlatformClient {
        self.client
    }

    /// Build and sign — **exactly once** — a document-create transition against a fixed,
    /// freshly bumped identity-contract nonce and fresh entropy.
    ///
    /// The returned [`PreparedWrite`] captures the deterministic document id and the
    /// signed bytes; hand it to [`WriteEngine::execute`] (retrying re-broadcasts the
    /// same bytes). `properties` maps field name → [`FieldValue`].
    pub async fn prepare_create(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        properties: BTreeMap<String, FieldValue>,
    ) -> Result<PreparedWrite> {
        let contract = &contract.0;
        let properties: BTreeMap<String, Value> = properties
            .into_iter()
            .map(|(k, v)| (k, v.into_value()))
            .collect();

        // Resolve the type before the nonce fetch: the fetch bumps the cached nonce, and an
        // unknown type must fail without consuming one.
        let doc_type_ref = contract
            .document_type_for_name(document_type)
            .map_err(|e| Error::Config(format!("unknown document type '{document_type}': {e}")))?;

        let mut rng = StdRng::from_entropy();
        let entropy: [u8; 32] = rng.gen();

        // Fetch the nonce ONCE (bump_first = true) and bake it into the signature. We do
        // NOT re-fetch on retry — that would bump the nonce and (with fresh entropy) mint
        // a new document id, i.e. a duplicate write. The SDK's NonceCache handles DIP-30
        // internally, so this value is used as-is.
        let nonce = self
            .client
            .sdk()
            .get_identity_contract_nonce(self.owner_id, contract.id(), true, None)
            .await
            .map_err(|e| Error::Platform(format!("fetching identity-contract nonce: {e}")))?;

        // One version for both the id and the transition: the SDK's latest learned
        // version (raised by every proved response; the nonce above may come from its
        // cache, so this is not necessarily fresh). Reading it once keeps the id and the
        // transition in agreement. If it is stale because the network upgraded, Drive
        // refuses the create loudly (see `create_landed`), never silently.
        let platform_version = self.client.sdk().version();

        // The id the transition will carry, known before broadcast. From protocol 14 it
        // commits to the identity-contract nonce as well as the entropy (protocol 13 and
        // earlier: entropy only), and the create transition re-derives it the same way —
        // so it must come from the same entropy, nonce and version we sign with.
        let document_id = Document::generate_document_id(
            &contract.id(),
            &self.owner_id,
            document_type,
            entropy.as_slice(),
            nonce,
            platform_version,
        )
        .map_err(|e| Error::Platform(format!("deriving the document id: {e}")))?;

        let document = Document::V0(DocumentV0 {
            id: document_id,
            owner_id: self.owner_id,
            properties,
            revision: Some(INITIAL_REVISION),
            created_at: None,
            updated_at: None,
            transferred_at: None,
            created_at_block_height: None,
            updated_at_block_height: None,
            transferred_at_block_height: None,
            created_at_core_block_height: None,
            updated_at_core_block_height: None,
            transferred_at_core_block_height: None,
            creator_id: None,
            moderated_at: None,
            moderated_by: None,
            // Assigned by Drive on create; not part of the client-built document.
            contract_version: None,
        });

        let state_transition = BatchTransition::new_document_creation_transition_from_document(
            document,
            doc_type_ref,
            entropy,
            &self.signing_key,
            nonce,
            0,
            // No forge-v2 type is token-gated: no token payment.
            None,
            &self.signer,
            platform_version,
            None,
        )
        .await
        .map_err(|e| Error::Platform(format!("signing create transition: {e}")))?;

        Ok(PreparedWrite {
            document_id: document_id.to_string(Encoding::Base58),
            document_type: document_type.to_string(),
            op: WriteOp::Create,
            signed: SignedTransition::from_state_transition(&state_transition, nonce)?,
        })
    }

    /// Build and sign — **exactly once** — a document-delete transition against a fixed,
    /// freshly bumped nonce. See [`WriteEngine::prepare_create`] for the idempotency
    /// rationale.
    pub async fn prepare_delete(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
    ) -> Result<PreparedWrite> {
        self.prepare_delete_with_values(contract, document_type, document_id, BTreeMap::new(), None)
            .await
    }

    /// [`Self::prepare_delete`] carrying the document's property `values` (and its
    /// `$createdAt`, when the type requires one).
    ///
    /// A protocol-14 `indexOnly` type (forge-v2 `star`, `follow`) has no stored row to delete
    /// by id: its delete names the document's values, from which Drive recomputes every index
    /// entry and checks each entry's row commitment. rs-dpp's deletion factory builds that
    /// `indexOnlyDelete` transition itself when the type is `indexOnly`, provided the document
    /// handed to it carries the values; for a stored type the values are ignored and an
    /// ordinary by-id delete is built. The delete is scoped to the signer, so another owner's
    /// values delete nothing (consensus answers `DocumentNotFound`, [`Error::NotFound`]).
    pub async fn prepare_delete_with_values(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
        values: BTreeMap<String, FieldValue>,
        created_at: Option<u64>,
    ) -> Result<PreparedWrite> {
        let contract = &contract.0;
        let doc_id = parse_id(document_id, "document id")?;

        let document = Document::V0(DocumentV0 {
            id: doc_id,
            owner_id: self.owner_id,
            properties: values
                .into_iter()
                .map(|(k, v)| (k, v.into_value()))
                .collect(),
            revision: Some(INITIAL_REVISION),
            created_at,
            updated_at: None,
            transferred_at: None,
            created_at_block_height: None,
            updated_at_block_height: None,
            transferred_at_block_height: None,
            created_at_core_block_height: None,
            updated_at_core_block_height: None,
            transferred_at_core_block_height: None,
            creator_id: None,
            moderated_at: None,
            moderated_by: None,
            // Assigned by Drive on create; not part of the client-built document.
            contract_version: None,
        });

        let doc_type_ref = contract
            .document_type_for_name(document_type)
            .map_err(|e| Error::Config(format!("unknown document type '{document_type}': {e}")))?;

        let nonce = self
            .client
            .sdk()
            .get_identity_contract_nonce(self.owner_id, contract.id(), true, None)
            .await
            .map_err(|e| Error::Platform(format!("fetching identity-contract nonce: {e}")))?;

        let state_transition = BatchTransition::new_document_deletion_transition_from_document(
            document,
            doc_type_ref,
            &self.signing_key,
            nonce,
            0,
            None,
            &self.signer,
            self.client.sdk().version(),
            None,
        )
        .await
        .map_err(|e| Error::Platform(format!("signing delete transition: {e}")))?;

        Ok(PreparedWrite {
            document_id: document_id.to_string(),
            document_type: document_type.to_string(),
            op: WriteOp::Delete,
            signed: SignedTransition::from_state_transition(&state_transition, nonce)?,
        })
    }

    /// Broadcast a [`PreparedWrite`]'s signed bytes and wait for the confirmation proof,
    /// re-broadcasting the **identical** bytes on a retryable failure.
    ///
    /// Returns [`BroadcastOutcome::Applied`] on a fresh landing,
    /// [`BroadcastOutcome::AlreadyExists`] when the document is already present (gRPC
    /// AlreadyExists / already-present document) — the idempotency guarantee that a
    /// killed-and-retried push does not double-write — or [`BroadcastOutcome::NonceConsumed`]
    /// when the nonce is spent, which the caller must disambiguate.
    ///
    /// **indexOnly types (protocol 14, forge-v2 `star` / `follow`):** their proofs only
    /// attest the resulting state, so a create that finds an identical entry already present
    /// reports `Applied`, and the `document_id` of such a create names no stored row. Deleting
    /// one needs the protocol-14 indexOnly delete, which carries the document's values: build
    /// it with [`Self::prepare_delete_with_values`].
    pub async fn execute(&self, prepared: &PreparedWrite) -> Result<BroadcastOutcome> {
        // Deserialize the SAME signed bytes we captured at prepare time. Every broadcast
        // in the loop below re-sends these exact bytes (identical nonce, entropy and
        // signature), so a retry can only ever make the write land once.
        let state_transition =
            StateTransition::deserialize_from_bytes_untrusted(&prepared.signed.bytes)
                .map_err(|e| Error::Platform(format!("deserializing signed transition: {e}")))?;
        let sdk = self.client.sdk();
        let document_type = prepared.document_type.as_str();
        // One rate-limit wait budget for the whole write, across its re-broadcasts.
        let waits = std::sync::atomic::AtomicU32::new(0);
        let (st, waits) = (&state_transition, &waits);
        drive_write(
            move |elsewhere| async move {
                // A rate-limit refusal is waited out here (the same signed bytes go again after
                // `ratelimit-reset`), rather than spending one of the loop's re-broadcasts on
                // a 2 s backoff the gateway will refuse again (D-902).
                loop {
                    crate::budget::acquire().await;
                    // `Some(n)`: a node the rotation would not pick, one that does not hold
                    // these bytes cached (see `drive_write`).
                    let sent = match elsewhere {
                        Some(n) => self.broadcast_elsewhere(st, n).await,
                        None => st.broadcast(sdk, None).await,
                    };
                    let Err(e) = sent else {
                        return Ok(());
                    };
                    let used = waits.load(std::sync::atomic::Ordering::Relaxed);
                    match rate_limit_reset(&e) {
                        Some(reset) if used < crate::budget::MAX_RATE_LIMIT_WAITS => {
                            waits.store(used + 1, std::sync::atomic::Ordering::Relaxed);
                            crate::budget::wait_out_rate_limit("broadcast", reset).await;
                        }
                        _ => return Err(classify_write_error(&e, document_type)),
                    }
                }
            },
            // The affected-state wait, not the strict one. rs-sdk 4.2's strict wait fails any
            // outcome whose proof only authenticates the resulting state, and that is every
            // document of an `indexOnly` type (protocol 14; forge-v2's `star` / `follow`): the
            // entry carries no id, entropy or nonce to bind one transition to it. This accepts
            // execution-proved outcomes too, so nothing weakens for the other types, and for a
            // sign-once write "the proven state holds it" is exactly the success condition — a
            // duplicate of the same signed bytes is rejected on its nonce, not proved again.
            // Still needed on v5.0.0-beta.1: platform#5136 made the SDK's own document put and
            // delete wait this way for an indexOnly type, but this engine broadcasts and waits
            // itself, and the strict `wait_for_response` still refuses such an outcome.
            || async {
                match st
                    .wait_for_affected_state::<StateTransitionProofResult>(
                        sdk,
                        Some(wait_settings()),
                    )
                    .await
                {
                    Ok(_proof) => Ok(()),
                    // The proof holds a document written under a newer version of its contract
                    // than this process loaded (an in-place update since): the transition is in
                    // a block. Hold the new version from here on, and let the spent nonce
                    // settle it (`NonceConsumed`: the caller's proved read decides).
                    Err(e) if is_stale_contract(&e.to_string()) => {
                        Box::pin(self.client.refresh_contract_of(st)).await;
                        Err(WriteFailure::Retryable(e.to_string()))
                    }
                    Err(e) => Err(classify_write_error(&e, document_type)),
                }
            },
            || self.nonce_spent(st, prepared.signed.nonce),
            RETRY_BACKOFF_BASE,
            &quorum::QUORUM_WAITS,
            document_type,
        )
        .await
    }

    /// Send `transition` to the `n`th node away from the SDK's rotation ([`drive_write`]): one
    /// live DAPI address ([`pick_elsewhere`]), asked once, never banned for its answer. Falls
    /// back to the rotation when no live address is known.
    // The error is the SDK's own (large) type, classified by the caller on the next line.
    #[allow(clippy::result_large_err)]
    async fn broadcast_elsewhere(
        &self,
        transition: &StateTransition,
        n: usize,
    ) -> std::result::Result<(), dash_sdk::Error> {
        use dash_sdk::dapi_client::{DapiClient, DapiRequest};
        use dash_sdk::platform::transition::broadcast_request::BroadcastRequestForStateTransition;
        let sdk = self.client.sdk();
        let request = transition.broadcast_request_for_state_transition()?;
        let live = sdk.address_list().get_live_addresses();
        let Some(address) = pick_elsewhere(live, &request.state_transition, n) else {
            return transition.broadcast(sdk, None).await;
        };
        tracing::debug!(node = %address, n, "sending the write to another node");
        let client = DapiClient::new(
            std::iter::once(address).collect(),
            RequestSettings {
                connect_timeout: Some(DAPI_CONNECT_TIMEOUT),
                retries: Some(0),
                ban_failed_address: Some(false),
                ..RequestSettings::default()
            },
        );
        request
            .execute(&client, RequestSettings::default())
            .await
            .map(|_| ())
            .map_err(|e| dash_sdk::Error::from(e.inner))
    }

    /// Whether Platform's proved identity-contract nonce says `nonce` can no longer be used
    /// by `transition` (Drive's own `validate_identity_nonce_update`): something — ours or
    /// another write — took it. `false` when it is still free, when the transition is not a
    /// document batch, or when the read fails (the loop then re-broadcasts as before).
    async fn nonce_spent(&self, transition: &StateTransition, nonce: u64) -> bool {
        use dash_sdk::dpp::state_transition::batch_transition::accessors::DocumentsBatchTransitionAccessorsV0;
        use drive_proof_verifier::types::IdentityContractNonceFetcher;

        let StateTransition::Batch(batch) = transition else {
            return false;
        };
        let (Some(owner), Some(first)) = (transition.owner_id(), batch.first_transition()) else {
            return false;
        };
        let contract = first.data_contract_id();
        let sdk = self.client.sdk();
        match retry_transient_read("fetch identity-contract nonce", || {
            IdentityContractNonceFetcher::fetch(sdk, (owner, contract))
        })
        .await
        {
            Ok(current) => {
                let current = current.map_or(0, |f| f.0);
                let spent = nonce_is_spent(current, nonce, owner);
                tracing::debug!(
                    nonce,
                    current = current & NONCE_MASK,
                    spent,
                    "checked whether the write's nonce is still free"
                );
                spent
            }
            Err(e) => {
                tracing::warn!(error = %e, "could not read the identity-contract nonce");
                false
            }
        }
    }

    /// Convenience: prepare + execute a document create, returning the base58 id.
    ///
    /// For resumable pushes prefer [`WriteEngine::prepare_create`] + persisting the
    /// [`PreparedWrite`]'s [`WriteIntent`] before [`WriteEngine::execute`], so a crash
    /// resumes by re-executing the same signed bytes.
    pub async fn create_document(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        properties: BTreeMap<String, FieldValue>,
    ) -> Result<String> {
        Ok(self
            .create_landed(contract, document_type, properties)
            .await?
            .document_id)
    }

    /// Prepare + execute a document create, returning the [`PreparedWrite`] that landed.
    ///
    /// The id is derived at the SDK's latest learned protocol version. If the network has
    /// moved past it (a 13 -> 14 upgrade under a long-running client), Drive refuses the
    /// create at basic validation with nothing landed. This then re-reads the version via
    /// a proved query and prepares + executes once more, with a fresh nonce and entropy.
    /// That is safe: the refused transition never executed.
    pub async fn create_landed(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        properties: BTreeMap<String, FieldValue>,
    ) -> Result<PreparedWrite> {
        self.create_journaled(contract, document_type, properties, |_| Ok(()))
            .await
    }

    /// A create whose signed bytes are handed to `persist` BEFORE the first broadcast, so a
    /// caller that dies mid-broadcast can later [`Self::replay`] the identical transition
    /// instead of signing a second, different write (the resumable repo-create session).
    ///
    /// A refusal for a stale protocol version (nothing landed) re-prepares once, persisting
    /// the replacement before broadcasting it, as [`Self::create_landed`] does.
    pub async fn create_journaled(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        properties: BTreeMap<String, FieldValue>,
        persist: impl FnMut(&PreparedWrite) -> Result<()>,
    ) -> Result<PreparedWrite> {
        self.create_journaled_with(contract, document_type, properties, Resign::Never, persist)
            .await
    }

    /// [`Self::create_journaled`] with the policy for a create that goes unconfirmed: under
    /// [`Resign::Unique`] (a document consensus admits only once: an issue or PR at its dense
    /// `number`, a unique index) it is signed again at once with a fresh nonce, every
    /// replacement handed to `persist` first, so a caller that finds the number taken can tell
    /// its own landed copy by id.
    pub async fn create_journaled_with(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        properties: BTreeMap<String, FieldValue>,
        resign: Resign,
        persist: impl FnMut(&PreparedWrite) -> Result<()>,
    ) -> Result<PreparedWrite> {
        self.create_probed(
            contract,
            document_type,
            properties,
            persist,
            NO_PROBE,
            resign,
        )
        .await
    }

    /// A create of an `indexOnly` type (forge-v2 `star` / `follow`), whose entry has no stored
    /// row to read back by id: when the write's nonce is found spent, `probe` (an owner-scoped
    /// query, polled like [`Self::landed`]) says whether ours is the entry that landed, instead
    /// of a by-id read that could never find it and would sign a second copy.
    pub async fn create_index_only<F, Fut>(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        properties: BTreeMap<String, FieldValue>,
        probe: F,
    ) -> Result<PreparedWrite>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<bool>>,
    {
        self.create_probed(
            contract,
            document_type,
            properties,
            |_| Ok(()),
            Some(probe),
            Resign::Never,
        )
        .await
    }

    async fn create_probed<F, Fut>(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        properties: BTreeMap<String, FieldValue>,
        mut persist: impl FnMut(&PreparedWrite) -> Result<()>,
        probe: Option<F>,
        resign: Resign,
    ) -> Result<PreparedWrite>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<bool>>,
    {
        // Calibration (`DASH_FORGE_COST_TRACE=1`, off otherwise: two balance reads per write):
        // each create's measured balance drop, by type and serialized size, logged at info on
        // `forge_core::cost`. Only meaningful for sequential writes by an identity nothing else
        // is spending. An explicit switch, not the log level: `tracing::enabled!` also holds
        // when any other target is traced, and these reads must never ride along unasked.
        let traced = std::env::var_os("DASH_FORGE_COST_TRACE").is_some_and(|v| v == "1");
        let owner = self.owner_id.to_string(Encoding::Base58);
        let before = if traced {
            self.client.get_balance(&owner).await.ok()
        } else {
            None
        };
        let landed = self
            .create_attempts(
                contract,
                document_type,
                properties,
                &mut persist,
                probe,
                resign,
            )
            .await?;
        if let Some(before) = before {
            let mut after = self.client.get_balance(&owner).await.ok();
            for _ in 0..8 {
                if after.is_some_and(|a| a != before) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                after = self.client.get_balance(&owner).await.ok();
            }
            tracing::info!(
                target: "forge_core::cost",
                document_type,
                bytes = landed.signed().bytes.len(),
                measured = after.map_or(0, |a| before.saturating_sub(a)),
                "write cost"
            );
        }
        Ok(landed)
    }

    async fn create_attempts<F, Fut>(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        properties: BTreeMap<String, FieldValue>,
        persist: &mut impl FnMut(&PreparedWrite) -> Result<()>,
        probe: Option<F>,
        resign: Resign,
    ) -> Result<PreparedWrite>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<bool>>,
    {
        let probe = &probe;
        create_loop(
            || self.prepare_create(contract, document_type, properties.clone()),
            persist,
            |prepared| async move { self.execute(&prepared).await },
            |signed: Vec<PreparedWrite>| async move {
                // an indexOnly entry has no id to read back: the owner-scoped probe says whether
                // an entry like this one is there
                if let Some(probe) = probe {
                    return Ok(poll_confirm(probe).await?.then(|| signed.len() - 1));
                }
                let ids: Vec<&str> = signed.iter().map(PreparedWrite::document_id).collect();
                self.landed_any(contract, document_type, &ids).await
            },
            || self.client.sdk().refresh_identity_nonce(&self.owner_id),
            || async {
                let version = self.client.refresh_protocol_version().await?;
                tracing::debug!(version, "stale protocol version; re-preparing once");
                Ok(())
            },
            resign,
            document_type,
        )
        .await
    }

    /// Which of `ids` (the transitions one create signed) has landed, polling like
    /// [`Self::landed`]: the latest first. `None` when none shows within the polls.
    pub async fn landed_any(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        ids: &[&str],
    ) -> Result<Option<usize>> {
        for attempt in 0..CONFIRM_ATTEMPTS {
            for (i, id) in ids.iter().enumerate().rev() {
                if self
                    .client
                    .document_exists(contract, document_type, id)
                    .await?
                {
                    return Ok(Some(i));
                }
            }
            if attempt + 1 < CONFIRM_ATTEMPTS {
                tokio::time::sleep(CONFIRM_DELAY).await;
            }
        }
        Ok(None)
    }

    /// Whether a document exists (`want = true`) or is gone (`want = false`), polling briefly:
    /// a proved read right after a landing can lag a block behind it.
    pub async fn landed(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
        want: bool,
    ) -> Result<bool> {
        for attempt in 0..CONFIRM_ATTEMPTS {
            if self
                .client
                .document_exists(contract, document_type, document_id)
                .await?
                == want
            {
                return Ok(true);
            }
            if attempt + 1 < CONFIRM_ATTEMPTS {
                tokio::time::sleep(CONFIRM_DELAY).await;
            }
        }
        Ok(false)
    }

    /// Re-broadcast a write captured earlier by [`Self::create_journaled`]. The identical
    /// signed bytes land at most once: a transition that already landed reports
    /// [`BroadcastOutcome::AlreadyExists`].
    pub async fn replay(
        &self,
        document_type: &str,
        intent: &WriteIntent,
    ) -> Result<BroadcastOutcome> {
        self.execute(&PreparedWrite {
            document_id: intent.document_id.clone(),
            document_type: document_type.to_string(),
            op: intent.operation,
            signed: intent.transition.clone(),
        })
        .await
    }

    /// Convenience: prepare + execute a document delete.
    pub async fn delete_document(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
    ) -> Result<()> {
        for _ in 0..2 {
            let prepared = self
                .prepare_delete(contract, document_type, document_id)
                .await?;
            match self.execute(&prepared).await? {
                BroadcastOutcome::NonceConsumed => {
                    if self
                        .landed(contract, document_type, document_id, false)
                        .await?
                    {
                        return Ok(());
                    }
                    tracing::debug!(
                        document_type,
                        "another write by this identity took the nonce; re-preparing the delete"
                    );
                }
                _ => return Ok(()),
            }
        }
        Err(Error::Nonce)
    }

    /// Replace the signer's own document `document_id` of `document_type`: `changes` set (a
    /// `None` value removes the property), everything else kept as stored. Returns `false`
    /// when the stored document already holds every change (nothing signed or paid).
    ///
    /// Signed once, at revision + 1 (Drive requires exactly that,
    /// `batch/transformer/v0` "expected_revision = previous_revision + 1"). A spent nonce is
    /// settled by re-reading: done if the stored document holds the changes, else re-prepared
    /// from the stored revision (up to three times). A replace refused for its revision (another
    /// replace landed between the read and the broadcast) is returned as the Platform error, not
    /// retried: the caller re-runs it against the new document. Consensus refuses a non-owner
    /// and any `immutable` property change.
    pub async fn replace_document(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
        changes: &BTreeMap<String, Option<FieldValue>>,
    ) -> Result<bool> {
        self.replace_document_guarded(contract, document_type, document_id, changes, None)
            .await
    }

    /// The stored document `document_id` of `document_type` (the SDK's own type, which a
    /// replace is built from), read with the newest version of `contract` this process holds,
    /// and again once after a refresh when it was written under a newer one.
    async fn fetch_stored(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
    ) -> Result<Option<Document>> {
        let doc_id = parse_id(document_id, "document id")?;
        let fetch = || async {
            let query = DocumentQuery::new(self.client.current(contract), document_type)
                .map_err(|e| Error::Platform(format!("building document query: {e}")))?
                .with_document_id(&doc_id);
            retry_transient_read("fetch document", || {
                Document::fetch(self.client.sdk(), query.clone())
            })
            .await
            .map_err(|e| Error::Platform(format!("fetching document {document_id}: {e}")))
        };
        match fetch().await {
            Err(e) if Box::pin(self.client.refreshed_after([contract], &e)).await => fetch().await,
            found => found,
        }
    }

    /// [`Self::replace_document`], refused (E607, nothing signed) when the stored document is
    /// no longer at `expected_revision`, the revision the caller read and built `changes`
    /// from: another edit landed since, and replacing it would silently drop that edit. A
    /// private edit needs this: it re-seals the whole content it read.
    pub async fn replace_document_guarded(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
        changes: &BTreeMap<String, Option<FieldValue>>,
        expected_revision: Option<u64>,
    ) -> Result<bool> {
        // The newest version of the contract this process holds, taken again at each use: a
        // fetch below may refresh it (an in-place update since `contract` was loaded).
        let current = || self.client.current(contract);
        current()
            .document_type_for_name(document_type)
            .map_err(|e| Error::Config(format!("unknown document type '{document_type}': {e}")))?;
        let fetch = || Box::pin(self.fetch_stored(contract, document_type, document_id));
        let holds = |doc: &Document| {
            changes.iter().all(|(k, v)| {
                let stored = doc.properties().get(k).and_then(FieldValue::from_value);
                same_field(stored.as_ref(), v.as_ref())
            })
        };
        let mut broadcast = false;
        for _ in 0..3 {
            let Some(mut doc) = fetch().await? else {
                return Err(Error::NotFound);
            };
            if doc.owner_id() != self.owner_id {
                return Err(Error::Config(format!(
                    "{document_type} {document_id} belongs to another identity; only its owner can edit it"
                )));
            }
            if holds(&doc) {
                // ours landed (after a spent nonce), or it already read that way
                return Ok(broadcast);
            }
            check_revision(
                document_type,
                document_id,
                expected_revision,
                doc.revision(),
                broadcast,
            )?;
            let next = doc
                .revision()
                .unwrap_or(INITIAL_REVISION)
                .checked_add(1)
                .ok_or_else(|| Error::Platform("document revision overflow".into()))?;
            doc.set_revision(Some(next));
            let props = doc.properties_mut();
            for (k, v) in changes {
                match v {
                    Some(v) => props.insert(k.clone(), v.clone().into_value()),
                    None => props.remove(k),
                };
            }
            let nonce = self
                .client
                .sdk()
                .get_identity_contract_nonce(self.owner_id, contract.0.id(), true, None)
                .await
                .map_err(|e| Error::Platform(format!("fetching identity-contract nonce: {e}")))?;
            let data_contract = current();
            let doc_type_ref = data_contract
                .document_type_for_name(document_type)
                .map_err(|e| {
                    Error::Config(format!("unknown document type '{document_type}': {e}"))
                })?;
            let state_transition =
                BatchTransition::new_document_replacement_transition_from_document(
                    doc,
                    doc_type_ref,
                    &self.signing_key,
                    nonce,
                    0,
                    None,
                    &self.signer,
                    self.client.sdk().version(),
                    None,
                )
                .await
                .map_err(|e| Error::Platform(format!("signing replace transition: {e}")))?;
            let prepared = PreparedWrite {
                document_id: document_id.to_string(),
                document_type: document_type.to_string(),
                op: WriteOp::Replace,
                signed: SignedTransition::from_state_transition(&state_transition, nonce)?,
            };
            broadcast = true;
            match self.execute(&prepared).await? {
                BroadcastOutcome::NonceConsumed => {
                    // Ours landed (its answer lost), or another write took the nonce: the
                    // stored document says which.
                    for attempt in 0..CONFIRM_ATTEMPTS {
                        if fetch().await?.is_some_and(|d| holds(&d)) {
                            return Ok(true);
                        }
                        if attempt + 1 < CONFIRM_ATTEMPTS {
                            tokio::time::sleep(CONFIRM_DELAY).await;
                        }
                    }
                }
                _ => return Ok(true),
            }
        }
        Err(Error::Nonce)
    }

    /// Prepare + execute a values-carrying delete ([`Self::prepare_delete_with_values`]): the
    /// only delete an `indexOnly` type accepts. On [`BroadcastOutcome::NonceConsumed`] the
    /// caller decides by re-reading: an `indexOnly` document has no id [`Self::landed`] could
    /// fetch.
    pub async fn delete_with_values(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
        values: BTreeMap<String, FieldValue>,
        created_at: Option<u64>,
    ) -> Result<BroadcastOutcome> {
        let prepared = self
            .prepare_delete_with_values(contract, document_type, document_id, values, created_at)
            .await?;
        self.execute(&prepared).await
    }
}

/// Refuse a replace built from `expected` when the stored document is at `stored` (another
/// edit landed in between): E607. `None` expected: no guard. `broadcast`: an earlier attempt of
/// this replace was broadcast and its nonce spent, so whether it landed is not known here.
fn check_revision(
    document_type: &str,
    document_id: &str,
    expected: Option<u64>,
    stored: Option<u64>,
    broadcast: bool,
) -> Result<()> {
    match expected {
        Some(e) if stored != Some(e) => Err(crate::user_error::UserError::new(
            crate::user_error::codes::EDIT_CONFLICT,
            if broadcast {
                format!("this {document_type} changed while your edit was being sent; it now holds another edit")
            } else {
                format!("this {document_type} changed since you read it; nothing was written")
            },
        )
        .cause(format!(
            "{document_type} {document_id} is at revision {}, the edit was made against revision {e}",
            stored.map_or_else(|| "?".into(), |s| s.to_string())
        ))
        .fix("read it again and redo the edit on the current text")
        .into()),
        _ => Ok(()),
    }
}

/// Whether a stored field equals a wanted one, by value rather than by wire form: an integer of
/// any width (`Integer`/`Uint64`), bytes of any kind (`Bytes`/`Bytes32`/`Identifier`), and a
/// string list read back as empty bytes all compare as what they hold. `None` is absent.
fn same_field(stored: Option<&FieldValue>, wanted: Option<&FieldValue>) -> bool {
    match (stored, wanted) {
        (None, None) => true,
        (Some(s), Some(w)) => {
            if let (Some(a), Some(b)) = (s.as_u64(), w.as_u64()) {
                return a == b;
            }
            if let (Some(a), Some(b)) = (s.as_bytes(), w.as_bytes()) {
                return a == b;
            }
            if let (Some(a), Some(b)) = (s.as_text_list(), w.as_text_list()) {
                return a == b;
            }
            s == w
        }
        _ => false,
    }
}

/// Whether `nonce` can no longer be used by a transition, given the raw identity-contract
/// nonce Platform holds: Drive's own `validate_identity_nonce_update`, for nonces at or below
/// the tip (the tip, one more than 24 behind it, or a skipped one since filled). A nonce above
/// the tip is free. Parity: forge-web `isNonceSpent` (same cases in both test suites).
fn nonce_is_spent(current: u64, nonce: u64, owner: Identifier) -> bool {
    use dash_sdk::dpp::identity::identity_nonce::validate_identity_nonce_update;
    nonce <= current & NONCE_MASK
        && !validate_identity_nonce_update(current, nonce, owner).is_valid()
}

/// The "no probe" of [`WriteEngine::create_journaled`]: confirm a spent nonce by reading the
/// document back by id.
type NoProbe = fn() -> std::future::Ready<Result<bool>>;
const NO_PROBE: Option<NoProbe> = None;

/// Poll `probe` like [`WriteEngine::landed`]: `true` as soon as it holds.
async fn poll_confirm<F, Fut>(probe: &F) -> Result<bool>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<bool>>,
{
    for attempt in 0..CONFIRM_ATTEMPTS {
        if probe().await? {
            return Ok(true);
        }
        if attempt + 1 < CONFIRM_ATTEMPTS {
            tokio::time::sleep(CONFIRM_DELAY).await;
        }
    }
    Ok(false)
}

/// How many proved reads [`WriteEngine::landed`] makes, and the pause between them (about
/// 15 s: a re-broadcast of our own landed bytes must be seen before a replacement is signed).
const CONFIRM_ATTEMPTS: usize = 10;
const CONFIRM_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);

/// An SDK-free document field value, converted to the Platform value type inside this
/// module. Lets callers build document properties (byteArray / integer / string /
/// identifier / nested-object fields) without importing any rs-dpp type (style guide §B).
///
/// It is also the SDK-free carrier a [`FetchedDocument`] hands back — [`FieldValue::from_value`]
/// maps a fetched `platform_value::Value` into this closed set so no SDK type leaks out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum FieldValue {
    /// A variable-length `byteArray` field.
    Bytes(Vec<u8>),
    /// A fixed 32-byte `byteArray` field (e.g. a packHash / refNameHash).
    Bytes32([u8; 32]),
    /// A 32-byte identifier field (a byteArray with the identifier content-media-type,
    /// e.g. `repoContractId`, `forkOf`, `targetId`). Encoded as `Value::Identifier`.
    Identifier([u8; 32]),
    /// An unsigned integer field. Serialized at its **minimal** CBOR width (`0` → `U8`),
    /// which matches how Drive canonicalizes a top-level typed `I64` field (coerced from any
    /// width) and a *bounded* nested integer.
    Integer(u64),
    /// A **full-width** `u64` integer field, always serialized as `Value::U64`. Required for
    /// a nested-object integer whose schema property is *unbounded* (no `maximum`): rs-dpp
    /// stores such a property as `I64`/`U64`, but a nested value bypasses typed coercion, so
    /// a minimal-width encoding (e.g. `U32`) mismatches Drive's stored width and fails proof
    /// verification. `imported.createdAt` is the case in point (data-contracts §2.4).
    Uint64(u64),
    /// A signed integer field (forge-v2 `transition.delta`, −8..8). Serialized at its minimal
    /// signed width; a top-level typed field (`I8` under sized integer types) coerces it. Reads
    /// of a negative integer land here; a non-negative one reads back as [`FieldValue::Integer`].
    Signed(i64),
    /// A UTF-8 string field (e.g. `defaultBranch`, `normalizedName`).
    Text(String),
    /// A boolean field (e.g. `force`, `archived`).
    Bool(bool),
    /// A nested object field (e.g. `config.backend`), keyed by property name.
    Object(BTreeMap<String, FieldValue>),
    /// A typed array of non-byte items (forge-v2 `uris`, `protectedPatterns`, `topics`:
    /// arrays of strings). Byte arrays stay [`FieldValue::Bytes`].
    List(Vec<FieldValue>),
}

impl FieldValue {
    /// A variable-length `byteArray` field from an owned byte vector.
    pub fn bytes(bytes: Vec<u8>) -> Self {
        FieldValue::Bytes(bytes)
    }

    /// A fixed 32-byte `byteArray` field (e.g. a packHash).
    pub fn bytes32(bytes: [u8; 32]) -> Self {
        FieldValue::Bytes32(bytes)
    }

    /// A 32-byte identifier field (byteArray with identifier content-media-type).
    pub fn identifier(bytes: [u8; 32]) -> Self {
        FieldValue::Identifier(bytes)
    }

    /// An unsigned-integer field (minimal CBOR width).
    pub fn integer(n: u64) -> Self {
        FieldValue::Integer(n)
    }

    /// A full-width `u64` field ([`FieldValue::Uint64`]) — use for an unbounded nested-object
    /// integer that Drive stores as `U64`.
    pub fn uint64(n: u64) -> Self {
        FieldValue::Uint64(n)
    }

    /// A UTF-8 string field.
    pub fn text(s: impl Into<String>) -> Self {
        FieldValue::Text(s.into())
    }

    /// A boolean field.
    pub fn boolean(b: bool) -> Self {
        FieldValue::Bool(b)
    }

    /// The raw bytes of a `Bytes`/`Bytes32`/`Identifier` field, if this is one.
    pub fn as_bytes(&self) -> Option<Vec<u8>> {
        match self {
            FieldValue::Bytes(b) => Some(b.clone()),
            FieldValue::Bytes32(b) | FieldValue::Identifier(b) => Some(b.to_vec()),
            _ => None,
        }
    }

    /// The unsigned value of an `Integer`/`Uint64` field, if this is one.
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            FieldValue::Integer(n) | FieldValue::Uint64(n) => Some(*n),
            FieldValue::Signed(n) => u64::try_from(*n).ok(),
            _ => None,
        }
    }

    /// The signed value of any integer field, if this is one that fits an `i64`.
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            FieldValue::Integer(n) | FieldValue::Uint64(n) => i64::try_from(*n).ok(),
            FieldValue::Signed(n) => Some(*n),
            _ => None,
        }
    }

    /// A signed integer field ([`FieldValue::Signed`]).
    pub fn signed(n: i64) -> Self {
        FieldValue::Signed(n)
    }

    /// A string list: the items of a [`FieldValue::List`] of `Text`. An empty array reads
    /// back as empty bytes (the item type is not on the wire), so that is an empty list too.
    pub fn as_text_list(&self) -> Option<Vec<String>> {
        match self {
            FieldValue::List(items) => items
                .iter()
                .map(|i| i.as_str().map(str::to_string))
                .collect(),
            FieldValue::Bytes(b) if b.is_empty() => Some(Vec::new()),
            _ => None,
        }
    }

    /// A typed string-array field.
    pub fn text_list<S: Into<String>>(items: impl IntoIterator<Item = S>) -> Self {
        FieldValue::List(
            items
                .into_iter()
                .map(|s| FieldValue::Text(s.into()))
                .collect(),
        )
    }

    /// The string of a `Text` field, if this is one.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            FieldValue::Text(s) => Some(s),
            _ => None,
        }
    }

    pub(crate) fn into_value(self) -> Value {
        match self {
            FieldValue::Bytes(b) => Value::Bytes(b),
            FieldValue::Bytes32(b) => Value::Bytes32(b),
            FieldValue::Identifier(b) => Value::Identifier(b),
            // Every contract integer field is `"type":"integer"` → `DocumentPropertyType::I64`,
            // and the I64 serializer coerces any integer Value via `to_integer()`, so a
            // *top-level* field round-trips regardless of width. A *nested*-object integer
            // (e.g. `config.backend.mode`) bypasses typed serialization and is stored as
            // generic CBOR, which canonicalizes to the smallest uint on read-back — so the
            // post-broadcast proof compares the returned (minimal-width) value against the
            // one we signed. Emitting the minimal-width uint matches that canonical form in
            // both cases and keeps the proof check happy.
            FieldValue::Integer(n) => minimal_uint(n),
            // Full-width u64 for an unbounded nested integer (matches Drive's stored width).
            FieldValue::Uint64(n) => Value::U64(n),
            FieldValue::Signed(n) => minimal_int(n),
            FieldValue::Text(s) => Value::Text(s),
            FieldValue::Bool(b) => Value::Bool(b),
            FieldValue::Object(map) => Value::Map(
                map.into_iter()
                    .map(|(k, v)| (Value::Text(k), v.into_value()))
                    .collect(),
            ),
            FieldValue::List(items) => {
                Value::Array(items.into_iter().map(FieldValue::into_value).collect())
            }
        }
    }

    /// Map a fetched `platform_value::Value` into the SDK-free field set. Integer
    /// variants collapse to [`FieldValue::Integer`]; a `byteArray` returned as an
    /// `Array` of `U8` is re-packed to [`FieldValue::Bytes`]. Unrepresentable values
    /// (floats, null, nested arrays) yield `None` — M1 documents never use them.
    fn from_value(value: &Value) -> Option<Self> {
        Some(match value {
            Value::Bytes(b) => FieldValue::Bytes(b.clone()),
            Value::Bytes20(b) => FieldValue::Bytes(b.to_vec()),
            Value::Bytes32(b) => FieldValue::Bytes32(*b),
            Value::Identifier(b) => FieldValue::Identifier(*b),
            Value::Text(s) => FieldValue::Text(s.clone()),
            Value::Bool(b) => FieldValue::Bool(*b),
            Value::U128(n) => FieldValue::Integer(u64::try_from(*n).ok()?),
            Value::I128(n) => FieldValue::Integer(u64::try_from(*n).ok()?),
            Value::U64(n) => FieldValue::Integer(*n),
            Value::I64(n) => signed_or_unsigned(*n),
            Value::U32(n) => FieldValue::Integer(u64::from(*n)),
            Value::I32(n) => signed_or_unsigned(i64::from(*n)),
            Value::U16(n) => FieldValue::Integer(u64::from(*n)),
            Value::I16(n) => signed_or_unsigned(i64::from(*n)),
            Value::U8(n) => FieldValue::Integer(u64::from(*n)),
            Value::I8(n) => signed_or_unsigned(i64::from(*n)),
            // A byteArray that came back as an array of U8 → repack to bytes. Anything else
            // is a typed array (forge-v2 string lists).
            Value::Array(items) if items.iter().all(|i| matches!(i, Value::U8(_))) => {
                FieldValue::Bytes(
                    items
                        .iter()
                        .filter_map(|i| match i {
                            Value::U8(b) => Some(*b),
                            _ => None,
                        })
                        .collect(),
                )
            }
            Value::Array(items) => FieldValue::List(
                items
                    .iter()
                    .map(FieldValue::from_value)
                    .collect::<Option<Vec<_>>>()?,
            ),
            Value::Map(entries) => {
                let mut map = BTreeMap::new();
                for (k, v) in entries {
                    let key = k.as_text()?.to_string();
                    map.insert(key, FieldValue::from_value(v)?);
                }
                FieldValue::Object(map)
            }
            _ => return None,
        })
    }
}

/// Parse `https://host:port` DAPI URLs into the SDK's address list.
fn parse_address_list(addresses: &[String]) -> Result<AddressList> {
    addresses
        .iter()
        .map(|a| {
            a.parse::<Address>()
                .map_err(|e| Error::Config(format!("invalid DAPI address {a:?}: {e}")))
        })
        .collect()
}

/// Parse a base58 Platform id, mapping failures to a config error.
pub(crate) fn parse_id(s: &str, what: &str) -> Result<Identifier> {
    // The SDK's own text ("byte length not 32 bytes error: Identifier must be 32 bytes long
    // from bytes") says nothing a reader can act on (QW2-076).
    Identifier::from_string(s, Encoding::Base58).map_err(|_| {
        Error::Config(format!(
            "invalid {what} {:?}: a Platform id is 32 bytes, written in base58 (about 44 characters)",
            s.chars().take(64).collect::<String>()
        ))
    })
}

/// Decode a base58 Platform id (identity / contract) to its raw 32 bytes — the form an
/// identifier document field (`repoContractId`, `forkOf`, a `$ownerId` filter operand)
/// carries. Keeps base58 decoding inside the SDK-confined module (style guide §B).
pub fn decode_identifier(base58: &str) -> Result<[u8; 32]> {
    Ok(parse_id(base58, "identifier")?.to_buffer())
}

/// Rows per page. Drive's default and maximum are both 100.
const PAGE_SIZE: u32 = 100;

/// The all-ascending order whose traversal, reversed, is exactly `order`'s traversal — or
/// `None` when `order` is already ascending or has no such equivalent.
///
/// A complete read ([`PlatformClient::query_all_documents`]) pages with a `start_after`
/// cursor. The grovedb verifier in rs-sdk 4.2 checks that every proof op matches the walk
/// direction. Protocol-13 nodes (testnet today) answer a descending page after a cursor
/// with a proof that fails that check. That page is only needed when a read passes one page,
/// so it surfaced as `packManifest` reads failing on a repo with 101 manifests. Ascending
/// pages verify, and Drive's descending walk is the exact reverse of its ascending walk,
/// so an ascending read reversed returns the same rows in the same order.
///
/// Reversing the whole result also reverses any clause that was already ascending. That is
/// only harmless when an equality filter pins that clause's field to one value, so any
/// other mixed order returns `None` and is read as requested.
fn ascending_equivalent(filters: &[QueryFilter], order: &[QueryOrder]) -> Option<Vec<QueryOrder>> {
    if order.iter().all(|o| o.ascending) {
        return None;
    }
    let pinned = |field: &str| {
        filters
            .iter()
            .any(|f| f.op == QueryOp::Eq && f.field == field)
    };
    if order.iter().any(|o| o.ascending && !pinned(&o.field)) {
        return None;
    }
    Some(
        order
            .iter()
            .map(|o| QueryOrder::asc(o.field.clone()))
            .collect(),
    )
}

/// Hard safety cap on total rounds, matching forge-web's `queryAllDocuments`.
/// 1000 pages x 100 rows = 100k documents.
const MAX_PAGES: usize = 1000;

/// Whether a complete read can make its page boundaries tie-safe: its order ends in
/// `$createdAt` ascending, every earlier order field is pinned by an `==` filter, and every
/// filter is an `==` on some other field. The index then ends in `$createdAt`, so an
/// equality on the boundary timestamp is a valid query on the same index.
///
/// Why: on protocol 13, a `start_after` cursor excludes the cursor's whole `$createdAt`
/// key, not just the rows up to the cursor document. Documents created in the same block
/// as a page's last row that sort after it would be silently skipped. `$createdAt` is the
/// block time, so these ties are real. Protocol 14 bounds the cursor by document id and
/// does not drop them.
///
/// Every forge-v2 type read with an order ending in `$createdAt` requires it, so a proved
/// query returns the boundary row's
/// timestamp.
fn tie_probe_allowed(filters: &[QueryFilter], order: &[QueryOrder]) -> bool {
    let Some((last, rest)) = order.split_last() else {
        return false;
    };
    let pinned = |field: &str| {
        filters
            .iter()
            .any(|f| f.op == QueryOp::Eq && f.field == field)
    };
    last.field == "$createdAt"
        && last.ascending
        && rest.iter().all(|o| o.ascending && pinned(&o.field))
        && filters
            .iter()
            .all(|f| f.op == QueryOp::Eq && f.field != "$createdAt")
}

/// Page a `$id`-cursored query to exhaustion, given a page fetcher and, optionally, a
/// boundary-tie reader.
///
/// Transport-free so the loop itself is testable: `query_all_documents` owns a live `Sdk`,
/// which made the one piece of logic that decides whether a read is complete the one piece
/// with no test. `fetch` receives the `start_after` cursor (`None` for the first page) and
/// returns one page.
///
/// `tie_probe`, when given, returns every row whose `$createdAt` equals its argument, in
/// traversal order (see [`tie_probe_allowed`]). After each full page it is called with the
/// last row's `$createdAt`. Rows not yet held are appended, and the cursor moves to the last
/// tied row. A tie of a full page or more cannot be proved complete and fails the read.
/// Rows are deduplicated by `$id` throughout.
///
/// A **short page is the only accepted proof** that the end was reached. If the cursor
/// cannot advance, or the page cap is hit, this returns [`Error::IncompleteRead`] rather
/// than a partial answer — forge-web throws at the same two points, because failing at
/// different points on identical data would itself be the cross-client divergence these
/// reads exist to prevent.
#[cfg(test)]
async fn page_to_exhaustion<F, Fut, P, PFut>(
    document_type: &str,
    fetch: F,
    tie_probe: Option<P>,
) -> Result<Vec<FetchedDocument>>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<FetchedDocument>>>,
    P: FnMut(u64) -> PFut,
    PFut: std::future::Future<Output = Result<Vec<FetchedDocument>>>,
{
    page_until(document_type, fetch, tie_probe, usize::MAX).await
}

/// [`page_to_exhaustion`] that also stops, successfully, once more than `max` rows are held
/// (a capped read: the caller knows more may match).
async fn page_until<F, Fut, P, PFut>(
    document_type: &str,
    mut fetch: F,
    mut tie_probe: Option<P>,
    max: usize,
) -> Result<Vec<FetchedDocument>>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<FetchedDocument>>>,
    P: FnMut(u64) -> PFut,
    PFut: std::future::Future<Output = Result<Vec<FetchedDocument>>>,
{
    let incomplete = |fetched: usize, reason: String| Error::IncompleteRead {
        document_type: document_type.to_string(),
        fetched,
        reason,
    };
    let mut out: Vec<FetchedDocument> = Vec::new();
    let mut held: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut take = |out: &mut Vec<FetchedDocument>, rows: Vec<FetchedDocument>| {
        for d in rows {
            if held.insert(d.id.clone()) {
                out.push(d);
            }
        }
    };
    let mut start_after: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let page = fetch(start_after.clone()).await?;
        let n = page.len();
        let last = page.last().map(|d| (d.id.clone(), d.created_at));
        take(&mut out, page);
        if n < PAGE_SIZE as usize || out.len() > max {
            return Ok(out);
        }
        let Some((mut cursor, created_at)) = last else {
            // A full page with no last element is impossible, but treating it as "done"
            // would silently truncate; treat it as unprovable instead.
            return Err(incomplete(
                out.len(),
                "a full page yielded no cursor document".to_string(),
            ));
        };
        if let (Some(probe), Some(t)) = (tie_probe.as_mut(), created_at) {
            let tied = probe(t).await?;
            if tied.len() >= PAGE_SIZE as usize {
                return Err(incomplete(
                    out.len(),
                    format!(
                        "{PAGE_SIZE} or more documents share $createdAt {t}; the page \
                         boundary tie cannot be read completely"
                    ),
                ));
            }
            if let Some(last_tied) = tied.last() {
                cursor.clone_from(&last_tied.id);
            }
            take(&mut out, tied);
        }
        start_after = Some(cursor);
    }
    Err(Error::IncompleteRead {
        document_type: document_type.to_string(),
        fetched: out.len(),
        reason: format!(
            "the {MAX_PAGES}-page safety cap was reached before a short page proved the end"
        ),
    })
}

/// Rows in the first page of a [`PlatformClient::query_all_large_documents`] read: 16 chunks,
/// about 235 KB (the browser reads chunk bytes in 256 KiB blocks).
const LARGE_PAGE_START: u32 = 16;
/// The most rows a large-document page grows to on a fast link: 48 chunks, about 700 KB.
const LARGE_PAGE_MAX: u32 = 48;
/// The shortest per-request deadline a large page is given.
const LARGE_PAGE_MIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// The longest: a page of one ~15 KB document that takes longer than this is a network that
/// does not deliver, and the read fails rather than waiting on it forever.
const LARGE_PAGE_MAX_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// The rate assumed before any page was measured, in documents per second: one chunk
/// (~15 KB) a second, below the 30-65 KB/s bonsia's slowest nodes served during QA wave 3.
const LARGE_PAGE_ASSUMED_RATE: f64 = 1.0;
/// A page's deadline is this many times the time the measured rate says it needs.
const LARGE_PAGE_HEADROOM: f64 = 3.0;

/// The page size and per-request deadline of a large-document read
/// ([`PlatformClient::query_all_large_documents`]), driven by the progress the network makes:
/// the deadline is [`LARGE_PAGE_HEADROOM`] times what the last page's rate needs (within
/// [`LARGE_PAGE_MIN_TIMEOUT`]..[`LARGE_PAGE_MAX_TIMEOUT`]); a page answered within a quarter
/// of its deadline lets the next one double, up to a ceiling; a page that runs out of time is
/// asked again with half the rows and twice the deadline, and the ceiling drops to that size
/// until [`LARGE_PAGE_RECOVERY`] quick pages in a row raise it again (one slow node must not
/// shrink a whole read). One row at the longest deadline failing ends the read.
#[derive(Debug, Clone, PartialEq)]
struct AdaptivePager {
    limit: u32,
    /// The size a quick page may grow to: [`Self::max`], lowered by a deadline.
    ceiling: u32,
    max: u32,
    /// Quick pages since the ceiling last moved.
    quick: u32,
    timeout: std::time::Duration,
}

/// Quick pages in a row after which a lowered ceiling doubles again.
const LARGE_PAGE_RECOVERY: u32 = 8;

impl AdaptivePager {
    fn new(start: u32, max: u32) -> Self {
        let max = max.max(1);
        let limit = start.clamp(1, max);
        Self {
            limit,
            ceiling: max,
            max,
            quick: 0,
            timeout: Self::deadline_for(limit, LARGE_PAGE_ASSUMED_RATE),
        }
    }

    /// The deadline for `limit` rows at `rate` rows per second.
    fn deadline_for(limit: u32, rate: f64) -> std::time::Duration {
        let secs = f64::from(limit) / rate.max(f64::MIN_POSITIVE) * LARGE_PAGE_HEADROOM;
        std::time::Duration::try_from_secs_f64(secs)
            .unwrap_or(LARGE_PAGE_MAX_TIMEOUT)
            .clamp(LARGE_PAGE_MIN_TIMEOUT, LARGE_PAGE_MAX_TIMEOUT)
    }

    /// A page of `rows` came back after `elapsed`.
    fn on_page(&mut self, rows: usize, elapsed: std::time::Duration) {
        if rows == 0 {
            return;
        }
        let rate =
            f64::from(u32::try_from(rows).unwrap_or(u32::MAX)) / elapsed.as_secs_f64().max(0.001);
        if elapsed.saturating_mul(4) < self.timeout {
            self.quick += 1;
            if self.ceiling < self.max && self.quick >= LARGE_PAGE_RECOVERY {
                self.ceiling = self.ceiling.saturating_mul(2).min(self.max);
                self.quick = 0;
            }
            self.limit = self.limit.saturating_mul(2).min(self.ceiling);
        } else {
            self.quick = 0;
        }
        self.timeout = Self::deadline_for(self.limit, rate);
    }

    /// A page ran out of time: `false` when it was already one row at the longest deadline
    /// (the read gives up), else the next attempt is smaller and longer.
    fn on_deadline(&mut self) -> bool {
        if self.limit == 1 && self.timeout >= LARGE_PAGE_MAX_TIMEOUT {
            return false;
        }
        self.limit = (self.limit / 2).max(1);
        self.ceiling = self.limit;
        self.quick = 0;
        self.timeout = self
            .timeout
            .saturating_mul(2)
            .clamp(LARGE_PAGE_MIN_TIMEOUT, LARGE_PAGE_MAX_TIMEOUT);
        true
    }
}

/// Why one large-document page failed: it ran out of its deadline (the pager shrinks it and
/// asks again), or anything else (the read fails with it).
#[derive(Debug)]
enum PageFailure {
    Deadline(String),
    Other(Error),
}

/// The request settings of one large-document page: `timeout` per attempt, up to two more
/// tries inside the SDK (each on a node it picks among those not banned), and no new bans.
/// A node that has not finished a big answer by a deadline we chose is slow, not broken;
/// banning it sent every node of bonsia to the ban list in QA wave 3, and the read then died
/// with "no available addresses". Bans other requests of this process set still apply, and
/// an unreachable node fails within the 5 s connect timeout.
fn large_page_settings(timeout: std::time::Duration) -> RequestSettings {
    RequestSettings {
        timeout: Some(timeout),
        retries: Some(2),
        ban_failed_address: Some(false),
        ..RequestSettings::default()
    }
}

/// The transport error inside `e`, wherever the SDK wrapped it: directly, or as the last error
/// behind "no available addresses to retry" once it had banned every node it tried.
fn transport_error(
    e: &dash_sdk::Error,
) -> Option<&dash_sdk::dapi_client::transport::TransportError> {
    use dash_sdk::dapi_client::DapiClientError;
    match e {
        dash_sdk::Error::DapiClientError(DapiClientError::Transport(t)) => Some(t),
        dash_sdk::Error::DapiClientError(DapiClientError::NoAvailableAddressesToRetry(t)) => {
            Some(t)
        }
        dash_sdk::Error::NoAvailableAddressesToRetry(inner) => transport_error(inner),
        _ => None,
    }
}

/// Whether `e` is a request that ran out of its deadline: gRPC `DeadlineExceeded` (the SDK's
/// own attempt deadline, or the node honouring `grpc-timeout`), a gateway's timeout answered
/// as `Unavailable` / `Cancelled` ("upstream request timeout", "Timeout expired"), or the
/// SDK's `TimeoutReached`.
fn is_deadline(e: &dash_sdk::Error) -> bool {
    use dapi_grpc::tonic::Code;
    use dash_sdk::dapi_client::transport::TransportError;
    if matches!(e, dash_sdk::Error::TimeoutReached(..)) {
        return true;
    }
    let Some(TransportError::Grpc(s)) = transport_error(e) else {
        return false;
    };
    let message = s.message().to_ascii_lowercase();
    s.code() == Code::DeadlineExceeded
        || (matches!(s.code(), Code::Unavailable | Code::Cancelled)
            && (message.contains("timeout") || message.contains("timed out")))
}

/// Said once per process, the first time a large read has to slow down.
static SLOW_READ_SAID: AtomicBool = AtomicBool::new(false);

/// The byte-array payload of every new row [`page_adaptively`] has read in this process (a
/// pack's chunks, mostly): what a progress display counts while one large read is in flight
/// (QW4-014: a 270 MB clone read its one pack's chunks for minutes with nothing shown).
static LARGE_READ_BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The bytes large reads ([`PlatformClient::query_all_large_documents`]) have received in
/// this process so far: a running total a progress display samples, never reset.
pub fn large_read_bytes() -> u64 {
    LARGE_READ_BYTES.load(std::sync::atomic::Ordering::Relaxed)
}

/// The byte-array payload `d` carries (a chunk's `data`, its hashes).
fn payload_bytes(d: &FetchedDocument) -> u64 {
    d.fields
        .values()
        .map(|v| match v {
            FieldValue::Bytes(b) => b.len() as u64,
            FieldValue::Bytes32(_) | FieldValue::Identifier(_) => 32,
            _ => 0,
        })
        .sum()
}

/// Page a `$id`-cursored, all-ascending read to exhaustion with an [`AdaptivePager`]: the
/// transport-free loop behind [`PlatformClient::query_all_large_documents`]. `fetch` gets the
/// cursor, the page size and the per-request deadline. As in [`page_to_exhaustion`], only a
/// short page (fewer rows than were asked for) proves the end; rows are deduplicated by `$id`.
/// A page that runs out of time is asked again from the same cursor, smaller and longer, so
/// the rows already read are never read again. The safety cap is the same number of rows as
/// [`page_to_exhaustion`]'s (`MAX_PAGES` full pages of `PAGE_SIZE`), not of pages, which here
/// can be one row each; a full page that adds no new row fails the read (its cursor does not
/// advance).
async fn page_adaptively<F, Fut>(
    document_type: &str,
    mut pager: AdaptivePager,
    mut fetch: F,
) -> Result<Vec<FetchedDocument>>
where
    F: FnMut(Option<String>, u32, std::time::Duration) -> Fut,
    Fut: std::future::Future<Output = std::result::Result<Vec<FetchedDocument>, PageFailure>>,
{
    let mut out: Vec<FetchedDocument> = Vec::new();
    let mut held: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut start_after: Option<String> = None;
    let max_rows = MAX_PAGES * PAGE_SIZE as usize;
    while out.len() < max_rows {
        let (limit, timeout) = (pager.limit, pager.timeout);
        let started = std::time::Instant::now();
        let page = match fetch(start_after.clone(), limit, timeout).await {
            Ok(page) => page,
            Err(PageFailure::Other(e)) => return Err(e),
            Err(PageFailure::Deadline(detail)) => {
                if !pager.on_deadline() {
                    return Err(Error::Platform(format!(
                        "querying {document_type} documents: the network did not deliver even \
                         one document within {} s, after {} were read ({detail})",
                        timeout.as_secs(),
                        out.len()
                    )));
                }
                tracing::debug!(
                    document_type,
                    limit = pager.limit,
                    timeout_ms = duration_ms(pager.timeout),
                    "a page ran out of time; asking again for fewer rows with a longer deadline"
                );
                if !SLOW_READ_SAID.swap(true, std::sync::atomic::Ordering::Relaxed) {
                    eprintln!(
                        "dash: Dash Platform is answering slowly; reading in smaller pieces \
                         with longer waits (this can take a few minutes)"
                    );
                }
                continue;
            }
        };
        let n = page.len();
        pager.on_page(n, started.elapsed());
        let last = page.last().map(|d| d.id.clone());
        let before = out.len();
        for d in page {
            if held.insert(d.id.clone()) {
                LARGE_READ_BYTES.fetch_add(payload_bytes(&d), std::sync::atomic::Ordering::Relaxed);
                out.push(d);
            }
        }
        if n < limit as usize {
            return Ok(out);
        }
        if out.len() == before {
            return Err(Error::IncompleteRead {
                document_type: document_type.to_string(),
                fetched: out.len(),
                reason: "a full page held no new document: the cursor did not advance".into(),
            });
        }
        let Some(cursor) = last else {
            return Err(Error::IncompleteRead {
                document_type: document_type.to_string(),
                fetched: out.len(),
                reason: "a full page yielded no cursor document".to_string(),
            });
        };
        start_after = Some(cursor);
    }
    Err(Error::IncompleteRead {
        document_type: document_type.to_string(),
        fetched: out.len(),
        reason: format!(
            "the {max_rows}-document safety cap was reached before a short page proved the end"
        ),
    })
}

/// Encode raw 32 identifier bytes back to base58 (the form ids are named by everywhere
/// else in the workspace).
pub fn encode_identifier(bytes: [u8; 32]) -> String {
    Identifier::from(bytes).to_string(Encoding::Base58)
}

/// A read integer: non-negative ones stay [`FieldValue::Integer`] (every existing reader), a
/// negative one is [`FieldValue::Signed`] (sized integer types store `transition.delta` as `I8`).
fn signed_or_unsigned(n: i64) -> FieldValue {
    u64::try_from(n).map_or(FieldValue::Signed(n), FieldValue::Integer)
}

/// The smallest signed `Value` holding `n` ([`minimal_uint`] for a non-negative one).
fn minimal_int(n: i64) -> Value {
    if let Ok(u) = u64::try_from(n) {
        return minimal_uint(u);
    }
    if let Ok(v) = i8::try_from(n) {
        Value::I8(v)
    } else if let Ok(v) = i16::try_from(n) {
        Value::I16(v)
    } else if let Ok(v) = i32::try_from(n) {
        Value::I32(v)
    } else {
        Value::I64(n)
    }
}

/// The smallest-width unsigned `Value` holding `n` — the canonical CBOR integer form
/// (integer `0` decodes back as `U8(0)`, not `U64(0)`). Matching it keeps a nested-object
/// integer's signed value equal to what the network stores and the proof returns; a
/// top-level integer field (typed `I64`) coerces from any width, so this is safe there too.
fn minimal_uint(n: u64) -> Value {
    if let Ok(v) = u8::try_from(n) {
        Value::U8(v)
    } else if let Ok(v) = u16::try_from(n) {
        Value::U16(v)
    } else if let Ok(v) = u32::try_from(n) {
        Value::U32(v)
    } else {
        Value::U64(n)
    }
}

/// Select the identity's on-chain AUTHENTICATION key that (a) the signer can sign with
/// and (b) is a usable ECDSA_SECP256K1 authentication key at HIGH or CRITICAL — the
/// levels document create/delete accept (spike S0.7).
fn select_matching_key(identity: &Identity, signer: &SingleKeySigner) -> Result<IdentityPublicKey> {
    use dash_sdk::dpp::identity::identity_public_key::accessors::v1::IdentityPublicKeyGettersV1;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    // The signer's key is on the identity but can no longer sign: say so (E305), rather than
    // "no usable key", which sends people looking for a different file.
    if let Some(k) = identity
        .public_keys()
        .values()
        .find(|k| signer.can_sign_with(k))
    {
        if k.is_disabled() {
            return Err(Error::Platform(format!(
                "Identity public key {} is disabled and can no longer sign",
                k.id()
            )));
        }
        if let Some(exp) = k.expires_at().filter(|e| *e <= now_ms) {
            return Err(Error::Platform(format!(
                "Identity public key {} expired at {exp} ms and can no longer sign",
                k.id()
            )));
        }
    }
    for public_key in identity.public_keys().values() {
        if public_key.is_disabled() || !signer.can_sign_with(public_key) {
            continue;
        }
        if public_key.purpose() == Purpose::AUTHENTICATION
            && public_key.key_type() == KeyType::ECDSA_SECP256K1
            && matches!(
                public_key.security_level(),
                SecurityLevel::HIGH | SecurityLevel::CRITICAL
            )
        {
            return Ok(public_key.clone());
        }
    }
    Err(Error::Config(
        "no usable HIGH/CRITICAL AUTHENTICATION key on the identity matches the keystore key"
            .into(),
    ))
}

/// The classification of a broadcast error, driving the retry loop.
#[derive(Debug)]
enum WriteFailure {
    /// The node already holds these exact signed bytes (gRPC `AlreadyExists`: "already in
    /// mempool" or "already in chain"). Not an answer yet: wait for the result.
    TxKnown,
    /// The document is already there (an already-present document, or a content-addressed
    /// unique-index duplicate). Idempotent success.
    AlreadyLanded,
    /// The nonce was already used: this write landed earlier, or another write took it.
    NonceConsumed,
    /// The nonce is more than 24 above the highest Drive has seen for the identity and
    /// contract (`NonceTooFarInFuture`): writes signed before it have not landed yet. Refused
    /// at CheckTx, so nothing landed; the same bytes are valid once the tip catches up.
    NonceAhead,
    /// A transient failure (stale node, timeout, proof mismatch). Safe to re-broadcast
    /// the same signed bytes — the SDK's authoritative `CanRetry::can_retry()` says so.
    Retryable(String),
    /// A proof no node could make verifiable yet: the quorum that signed it rotated in and the
    /// quorum service has not caught up ([`quorum`]). Retried like [`Self::Retryable`], after
    /// the longer [`quorum::QUORUM_WAITS`].
    QuorumMiss(String),
    /// A terminal failure surfaced as a crate error.
    Fatal(Error),
}

/// Pull the consensus error out of whichever SDK error variant carries it (a broadcast
/// error's `cause`, or a protocol error). Structured — never string-matched.
fn consensus_error_of(e: &dash_sdk::Error) -> Option<&ConsensusError> {
    match e {
        dash_sdk::Error::StateTransitionBroadcastError(ste) => ste.cause.as_ref(),
        dash_sdk::Error::Protocol(dash_sdk::dpp::ProtocolError::ConsensusError(ce)) => {
            Some(ce.as_ref())
        }
        _ => None,
    }
}

/// Document types whose UNIQUE index makes a same-content re-upload an idempotent no-op:
/// `chunk` (unique `(packHash, seq)`) and `packManifest` (unique `packHash`). A resumed
/// push re-broadcasts these and a `DuplicateUniqueIndexError` means "already stored" =
/// success — NOT for e.g. `repo` (unique `($ownerId, name)`), where a
/// duplicate is a genuine name collision and must stay fatal.
const CONTENT_ADDRESSED_UNIQUE_DOC_TYPES: [&str; 2] = ["chunk", "packManifest"];

/// Classify a `dash_sdk::Error` from a document broadcast by matching structured enum
/// variants (not lowercased Display substrings). A missing membership (consensus 40120 on
/// `$ownerId`) maps to a distinct, non-retryable crate error; retryability comes
/// from the SDK's authoritative [`CanRetry::can_retry`]. `document_type` scopes the
/// unique-index idempotency (see [`CONTENT_ADDRESSED_UNIQUE_DOC_TYPES`]).
fn classify_write_error(e: &dash_sdk::Error, document_type: &str) -> WriteFailure {
    // gRPC-level "already exists": the node already has these exact bytes, in its mempool or
    // in a block. Neither is an answer: a pending transition can still be dropped (a nonce
    // another write took first), and one in a block can have failed there. The result wait
    // answers both, at once for one already in a block.
    if matches!(e, dash_sdk::Error::AlreadyExists(_)) {
        return WriteFailure::TxKnown;
    }

    // The id was derived at a protocol version the network is not on (a 13 -> 14 upgrade
    // under a long-running client). Refused at basic validation: nothing landed.
    if let Some(ConsensusError::BasicError(BasicError::InvalidDocumentTransitionIdError(err))) =
        consensus_error_of(e)
    {
        return WriteFailure::Fatal(Error::StaleProtocolVersion(format!("{err:?}")));
    }

    // 10422: a `propertyConstraints` rule of the type does not hold (forge-v2: a dense number
    // another create took, a state move the target's transitions no longer allow). Refused
    // before execution, so nothing landed; the caller re-reads and decides.
    if let Some(ConsensusError::BasicError(BasicError::DocumentPropertyConstraintViolatedError(
        err,
    ))) = consensus_error_of(e)
    {
        return WriteFailure::Fatal(Error::RuleRefused {
            document_type: err.document_type_name().to_string(),
            rule: err.constraint().to_string(),
            detail: err.to_string(),
        });
    }

    if let Some(ConsensusError::StateError(state_error)) = consensus_error_of(e) {
        match state_error {
            // The document is already present, or the baked nonce was already consumed
            // by an earlier (identical) broadcast → the intended write has landed.
            StateError::DocumentAlreadyPresentError(_) => return WriteFailure::AlreadyLanded,
            StateError::InvalidIdentityNonceError(err)
                if matches!(err.error, MergeIdentityNonceResult::NonceTooFarInFuture) =>
            {
                return WriteFailure::NonceAhead
            }
            StateError::InvalidIdentityNonceError(_) => return WriteFailure::NonceConsumed,
            // A delete of a document that is not there (an unstar of a repo not starred, or
            // one another process already removed).
            StateError::DocumentNotFoundError(_) => return WriteFailure::Fatal(Error::NotFound),
            // A resumed push re-uploading a content-addressed chunk / manifest collides on
            // its UNIQUE index — the content is already stored, so this is idempotent
            // success (never charged the storage twice), scoped to those doc types only.
            StateError::DuplicateUniqueIndexError(_)
                if CONTENT_ADDRESSED_UNIQUE_DOC_TYPES.contains(&document_type) =>
            {
                return WriteFailure::AlreadyLanded
            }
            // A unique-index collision on any OTHER type is a genuine clash (an `issue`
            // /`patch` `number` already taken, a `repo` name collision). Surface it
            // as a distinct, non-retryable error so the optimistic-numbering allocator can
            // catch it and retry with the next number (a name collision stays fatal at the
            // caller). NOT idempotent success — the content differs from what landed.
            StateError::DuplicateUniqueIndexError(err) => {
                return WriteFailure::Fatal(Error::DuplicateUniqueIndex(format!("{err:?}")))
            }
            // 40120 on the writer path: a protocol-14 `ownerRefersTo` gate found no
            // membership document for the writer (forge-v2: never granted, or revoked; or a
            // writer where the type needs a maintainer). RC1's `asMember` proof is the same
            // gate on a property: the signer's maintainer/writer document.
            StateError::ReferencedEntityNotFoundError(err) => {
                let document_type = document_type.to_string();
                let detail = format!("40120: {err}");
                return WriteFailure::Fatal(match err.path() {
                    "$ownerId" | "asMember" => Error::NotAMember {
                        document_type,
                        detail,
                    },
                    // Any other path: what a property refers to is missing (a revoked member a
                    // `repoKey` wraps to, a `consent` not written yet, a deleted parent).
                    path => Error::ReferenceNotFound {
                        document_type,
                        path: path.to_string(),
                        detail,
                    },
                });
            }
            // 40128: the replace changes a property the type freezes, always or by a
            // conditional `immutable` entry (v5:packages/rs-drive-abci/src/execution/
            // validation/state_transition/state_transitions/batch/action_validation/document/
            // document_replace_transition_action/state_v1/mod.rs:95-138). Nothing landed.
            StateError::DocumentImmutablePropertyChangedError(err) => {
                return WriteFailure::Fatal(Error::FrozenField {
                    document_type: err.document_type_name().to_string(),
                    property: err.property().to_string(),
                    detail: format!("40128: {err}"),
                });
            }
            _ => {}
        }
    }

    if quorum::is_quorum_miss(e) {
        return WriteFailure::QuorumMiss(e.to_string());
    }

    // The SDK's retry signal (StaleNode / TimeoutReached / Proof) plus node-level transport
    // failures. Re-broadcasting the identical signed bytes is safe for all of them.
    if is_transient_node_error(e) {
        return WriteFailure::Retryable(e.to_string());
    }

    WriteFailure::Fatal(Error::Platform(e.to_string()))
}

/// Whether an error's text is rs-dpp refusing to decode a document written under a newer
/// version of its contract than the reader holds: an in-place update (forge-v2 UPDATE-1) gave
/// the type a property, and every document of it written since carries that property's
/// presence byte (v5.0.0-beta.1 packages/rs-dpp/src/document/v0/serialize/v3.rs:557-570). The
/// cure is to refetch the contract; no node answers otherwise.
pub(crate) fn is_stale_contract(message: &str) -> bool {
    message.contains("trailing bytes") && message.contains("refetch the contract")
}

/// Drive refused a read because the contract it names does not exist: gRPC `InvalidArgument`
/// carrying `QuerySyntaxError::DataContractNotFound` ("contract not found error: …"). An answer,
/// not a flake: no node has the contract.
fn is_contract_missing(e: &dash_sdk::Error) -> bool {
    use dash_sdk::dapi_client::transport::TransportError;
    use dash_sdk::dapi_client::DapiClientError;
    matches!(
        e,
        dash_sdk::Error::DapiClientError(DapiClientError::Transport(TransportError::Grpc(s)))
            if s.code() == dapi_grpc::tonic::Code::InvalidArgument
                && s.message().contains("contract not found")
    )
}

/// Whether an SDK error is a node problem that a fresh DAPI rotation can fix, as opposed to
/// an answer. Drives both the read retry and the write re-broadcast (whose idempotency
/// comes from re-sending the same signed bytes, not from this check).
///
/// The SDK's own [`CanRetry`] for its top-level error covers a stale node, an
/// SDK timeout and a failed proof, but not the two failures testnet produces most: a
/// retryable gRPC status from the node (`Unavailable` for an unreachable one), and the SDK
/// giving up because it banned every node it tried. Both are transient: a ban lapses after
/// a minute (the SDK's default base ban period), so a backed-off retry does not just ask
/// the same dead nodes again.
fn is_transient_node_error(e: &dash_sdk::Error) -> bool {
    // Every node answers the same: the document is newer than the contract read it with.
    if is_stale_contract(&e.to_string()) {
        return false;
    }
    match e {
        dash_sdk::Error::NoAvailableAddressesToRetry(_) => true,
        dash_sdk::Error::DapiClientError(d) => d.can_retry() || d.is_no_available_addresses(),
        other => other.can_retry(),
    }
}

/// Base delay before the second read or broadcast attempt; later attempts double it
/// (2 s, 4 s, 8 s).
const RETRY_BACKOFF_BASE: std::time::Duration = std::time::Duration::from_secs(2);

/// The pause after failed attempt number `attempt` (1-based): `base`, then doubling.
fn backoff_delay(base: std::time::Duration, attempt: u32) -> std::time::Duration {
    base * 2u32.saturating_pow(attempt.saturating_sub(1))
}

/// The settings for one result wait: a single node, [`WAIT_REQUEST_TIMEOUT`], and an overall
/// [`WAIT_DEADLINE`]. No SDK-level retry: on silence the write loop re-broadcasts, which is
/// what finds out whether the transition is still pending, landed, or was dropped.
fn wait_settings() -> dash_sdk::platform::transition::put_settings::PutSettings {
    dash_sdk::platform::transition::put_settings::PutSettings {
        request_settings: RequestSettings {
            timeout: Some(WAIT_REQUEST_TIMEOUT),
            retries: Some(0),
            // A node that stays silent about a transition it accepted is not broken (the
            // transition was dropped); banning it would only shrink the pool for the retry.
            ban_failed_address: Some(false),
            ..RequestSettings::default()
        },
        wait_timeout: Some(WAIT_DEADLINE),
        ..Default::default()
    }
}

/// The broadcast / wait loop behind [`WriteEngine::execute`], over its three steps so the
/// control flow is testable without a network. Every broadcast sends the same signed bytes.
///
/// * A broadcast that fails transiently is retried (backed off), up to
///   [`MAX_BROADCAST_ATTEMPTS`] in all.
/// * A broadcast the node accepts (or already holds: `TxKnown`) is followed by one bounded
///   wait ([`WAIT_REQUEST_TIMEOUT`]).
/// * A wait that ends without an answer asks `nonce_spent`. A spent nonce means our
///   transition either landed or lost its nonce to another write by the same identity, and
///   will never produce a result on its own — the caller's proved read decides which
///   ([`BroadcastOutcome::NonceConsumed`]). This is the moutai hang: Tenderdash drops the
///   loser of a same-nonce race from its mempool on recheck, yet keeps its hash in the
///   mempool cache, so a re-broadcast only ever hears "tx already exists in cache" and the
///   wait never answers. A free nonce means the transition is still pending (or was dropped
///   for another reason): re-broadcast and wait again.
/// * Anything else is final.
///
/// **Sending elsewhere** (`broadcast(Some(n))`: the `n`th node picked away from the rotation,
/// [`WriteEngine::broadcast_elsewhere`]). A Tenderdash node keeps a transition's hash in its
/// mempool cache after the transition stops moving toward a block — dropped on recheck, removed
/// by a proposer, or stranded in that node's mempool when its gossip was lost — and refuses the
/// same bytes from then on with "tx already exists in cache" before Drive is asked
/// (tenderdash `internal/mempool/mempool.go:229-236`; dashmate sets
/// `keep-invalid-txs-in-cache = true` and no TTL). rs-dapi passes that message on as gRPC
/// `AlreadyExists` without telling pending, dropped and committed apart
/// (`rs-dapi/src/services/platform_service/error_mapping.rs:384-388`), and the SDK's rotation
/// does not move off a node for it (it is not retryable), so every re-send can reach the one
/// node that will never take it (sakura, collab1 and collab2). So once a re-send is answered
/// that way and the wait after it hears nothing with the nonce still free, every later send of
/// this call goes to another node, one not tried yet each time. A send a total-reading rule
/// refused at CheckTx goes elsewhere too: the refusing node keeps those bytes cached as well.
#[allow(clippy::too_many_lines)] // one loop, its outcomes side by side
async fn drive_write<B, BFut, W, WFut, N, NFut>(
    mut broadcast: B,
    mut wait: W,
    mut nonce_spent: N,
    backoff: std::time::Duration,
    quorum_waits: &[std::time::Duration],
    document_type: &str,
) -> Result<BroadcastOutcome>
where
    B: FnMut(Option<usize>) -> BFut,
    BFut: std::future::Future<Output = std::result::Result<(), WriteFailure>>,
    W: FnMut() -> WFut,
    WFut: std::future::Future<Output = std::result::Result<(), WriteFailure>>,
    N: FnMut() -> NFut,
    NFut: std::future::Future<Output = bool>,
{
    let mut attempt: u32 = 0;
    let mut lag_retries: u32 = 0;
    let mut quorum_retries: u32 = 0;
    let mut ahead_retries: u32 = 0;
    // An earlier send of this call may have reached a node: a later TxKnown is then ours.
    let mut tried = false;
    // Whether a broadcast in THIS call was accepted. A transition the node already knew on
    // our first send was broadcast by an earlier call (a replayed journal): its landing is
    // reported as `AlreadyExists`, not as a fresh `Applied`.
    let mut sent = false;
    // Once some node holds these bytes cached without moving them toward a block, the next
    // send goes to the `n`th node away from the rotation (and the one after to the next).
    let mut elsewhere: Option<usize> = None;
    loop {
        attempt += 1;
        let started = std::time::Instant::now();
        let sent_now = broadcast(elsewhere).await;
        // A send to another node that did not answer: the next one tries yet another.
        if elsewhere.is_some() && matches!(sent_now, Err(WriteFailure::Retryable(_))) {
            go_elsewhere(&mut elsewhere);
        }
        // A refusal the broadcast returned is CheckTx's (nonce unspent: may be sent again); one
        // the wait returns (after a send or TxKnown) came from block execution: final.
        let at_check_tx = matches!(sent_now, Err(ref f) if !matches!(f, WriteFailure::TxKnown));
        let tried_before = tried;
        // Only a send that may have reached a node: accepted, or no answer (not one refused
        // before it left, such as every node banned).
        tried |= matches!(sent_now, Ok(()) | Err(WriteFailure::Retryable(_)));
        let failure = match sent_now {
            Ok(()) | Err(WriteFailure::TxKnown) => {
                // Ok is our own send, and so is TxKnown after an earlier send of ours; TxKnown on
                // every send so far (a replayed journal) is not.
                sent |= sent_now.is_ok() || tried_before;
                match wait().await {
                    Ok(()) => {
                        tracing::debug!(
                            document_type,
                            attempt,
                            elapsed_ms = duration_ms(started.elapsed()),
                            "write landed"
                        );
                        return Ok(if sent {
                            BroadcastOutcome::Applied
                        } else {
                            BroadcastOutcome::AlreadyExists
                        });
                    }
                    // No answer: can it still land? (A quorum miss asks after its pause.)
                    Err(f @ WriteFailure::Retryable(_)) => {
                        if nonce_spent().await {
                            tracing::debug!(
                                document_type,
                                attempt,
                                elapsed_elapsed_ms = duration_ms(started.elapsed()),
                                "no result, and the write's nonce is spent: it landed or another \
                                 write by this identity took the nonce"
                            );
                            return Ok(BroadcastOutcome::NonceConsumed);
                        }
                        // The node held these bytes and still nothing came, with the nonce
                        // free: it will refuse them from its cache from now on. Send elsewhere
                        // (and once sending elsewhere, a silent node is passed over too).
                        if matches!(sent_now, Err(WriteFailure::TxKnown)) || elsewhere.is_some() {
                            go_elsewhere(&mut elsewhere);
                            tracing::debug!(
                                document_type,
                                attempt,
                                "the node already holds these bytes but they do not land; \
                                 sending them to another node"
                            );
                        }
                        f
                    }
                    Err(f) => f,
                }
            }
            Err(f) => f,
        };
        let failure = match wait_out_quorum(
            failure,
            quorum_waits,
            &mut quorum_retries,
            document_type,
            &mut nonce_spent,
        )
        .await
        {
            QuorumStep::Retry => continue,
            QuorumStep::Landed => return Ok(BroadcastOutcome::NonceConsumed),
            QuorumStep::Failure(f) => f,
        };
        let used = attempt - lag_retries - quorum_retries - ahead_retries;
        match failure {
            WriteFailure::AlreadyLanded => return Ok(BroadcastOutcome::AlreadyExists),
            WriteFailure::NonceConsumed => return Ok(BroadcastOutcome::NonceConsumed),
            // Writes signed before this one have not landed yet: wait for the tip to catch up,
            // then send the same bytes to a node that did not refuse (and cache) them.
            WriteFailure::NonceAhead if ahead_retries < MAX_AHEAD_RETRIES => {
                ahead_retries += 1;
                go_elsewhere(&mut elsewhere);
                let delay = backoff_delay(backoff * 2, ahead_retries);
                tracing::debug!(
                    document_type,
                    delay_ms = duration_ms(delay),
                    "nonce too far ahead of the identity's landed writes; waiting for them"
                );
                tokio::time::sleep(delay).await;
            }
            // Still ahead: nothing of it landed (refused before execution). A nonce error, so
            // the caller re-signs once it reads the chain again.
            // A send of this call that a node took is valid again once the tip catches up, so it
            // may still land: unconfirmed, not a nonce error.
            WriteFailure::NonceAhead => {
                tracing::warn!("{document_type}: nonce still too far ahead of the landed writes");
                return Err(if tried || sent {
                    Error::Timeout { retryable: true }
                } else {
                    Error::Nonce
                });
            }
            WriteFailure::Retryable(reason) if used < MAX_BROADCAST_ATTEMPTS => {
                let delay = backoff_delay(backoff, used);
                tracing::debug!(
                    document_type,
                    attempt,
                    elapsed_elapsed_ms = duration_ms(started.elapsed()),
                    delay_ms = duration_ms(delay),
                    error = %reason,
                    "write not confirmed; re-broadcasting identical signed bytes (same nonce/entropy)"
                );
                tokio::time::sleep(delay).await;
            }
            // Only a broadcast answers TxKnown, and that is handled above; a wait cannot. A
            // quorum miss was made Retryable above. Warned with why (re-broadcasts are debug).
            f @ (WriteFailure::Retryable(_)
            | WriteFailure::TxKnown
            | WriteFailure::QuorumMiss(_)) => {
                tracing::warn!("write not confirmed; giving up ({document_type}: {f:?})");
                return Err(Error::Timeout { retryable: true });
            }
            // A total-reading rule refused it: the judging node may not hold this identity's
            // documents of the last block yet (a manifest right after its chunks). Nothing was
            // spent; send the same bytes again once it has caught up.
            WriteFailure::Fatal(Error::RuleRefused {
                document_type: refused,
                rule,
                detail,
            }) if at_check_tx
                && reads_a_total(&refused, &rule)
                && lag_retries < MAX_LAG_RETRIES =>
            {
                lag_retries += 1;
                // The refusing node keeps these bytes cached (keep-invalid-txs-in-cache): it
                // would only answer "already exists in cache" to them now.
                go_elsewhere(&mut elsewhere);
                wait_out_lag(document_type, &rule, &detail, backoff, lag_retries).await;
            }
            WriteFailure::Fatal(err) => return Err(err),
        }
    }
}

/// When a create whose transition went unconfirmed ([`Error::Timeout`]: sent, never answered,
/// its nonce still free, after re-sends to other nodes) may be signed again with a fresh nonce.
/// The unconfirmed transition may be stranded in a mempool and land later, so a replacement
/// (another nonce, another id) is a second copy unless consensus refuses one of the two.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resign {
    /// Not in this call: the timeout is returned. The caller re-signs once the nonce is
    /// provably spent and a proved read finds nothing of its own (the importer waits for
    /// enough later writes to land, then reads the chain again).
    Never,
    /// At once (up to [`MAX_UNCONFIRMED_RESIGNS`] times): consensus admits one copy only (the
    /// same dense `number`, a unique index), so the transition and its replacement cannot both
    /// land, and a caller that finds the number taken adopts its own copy by id.
    Unique,
}

/// Transitions one create may sign in all ([`create_loop`]): the first, a re-sign after a stale
/// protocol version, after a nonce another write took, and after an unconfirmed send.
const MAX_CREATE_ATTEMPTS: usize = 6;

/// Re-signs of an unconfirmed create under [`Resign::Unique`].
const MAX_UNCONFIRMED_RESIGNS: usize = 2;

/// The sign / send / re-sign loop behind [`WriteEngine::create_attempts`], over its steps so the
/// control flow is testable without a network. Each attempt `prepare`s a transition (a fresh
/// nonce and entropy), hands it to `persist`, then `execute`s it ([`drive_write`]):
///
/// * landed (or already there): done;
/// * its nonce spent ([`BroadcastOutcome::NonceConsumed`]): ours landed, or another write by
///   this identity took the nonce. `landed` reads back every transition this call signed (any
///   of them may be the one that landed); none: re-prepared (none of them can ever land now),
///   after `refresh_nonce` marks the SDK's cached nonce stale so the next one is the higher of
///   its cache and Platform's (it never goes back down). Repeated nonce losses end in
///   [`Error::Nonce`] after [`MAX_CREATE_ATTEMPTS`];
/// * a stale protocol version (refused before execution): `refresh_version`, re-prepared once;
/// * unconfirmed ([`Error::Timeout`]): re-prepared at once only under [`Resign::Unique`];
/// * anything else: returned.
#[allow(clippy::too_many_arguments)] // each step a closure, so the loop runs without a network
async fn create_loop<T, P, PF, X, XF, L, LF, R, RF, V, VF>(
    mut prepare: P,
    persist: &mut impl FnMut(&T) -> Result<()>,
    mut execute: X,
    mut landed: L,
    mut refresh_nonce: R,
    mut refresh_version: V,
    resign: Resign,
    document_type: &str,
) -> Result<T>
where
    T: Clone,
    P: FnMut() -> PF,
    PF: std::future::Future<Output = Result<T>>,
    X: FnMut(T) -> XF,
    XF: std::future::Future<Output = Result<BroadcastOutcome>>,
    L: FnMut(Vec<T>) -> LF,
    LF: std::future::Future<Output = Result<Option<usize>>>,
    R: FnMut() -> RF,
    RF: std::future::Future<Output = ()>,
    V: FnMut() -> VF,
    VF: std::future::Future<Output = Result<()>>,
{
    let mut signed: Vec<T> = Vec::new();
    let mut resigns = 0usize;
    let mut version_refreshed = false;
    for _ in 0..MAX_CREATE_ATTEMPTS {
        let prepared = prepare().await?;
        persist(&prepared)?;
        signed.push(prepared.clone());
        match execute(prepared.clone()).await {
            Ok(BroadcastOutcome::NonceConsumed) => {
                if let Some(i) = landed(signed.clone()).await? {
                    return Ok(signed.swap_remove(i));
                }
                // Expected when one identity writes in parallel, and recovered here; a write that
                // cannot recover fails with `Error::Nonce` below.
                tracing::debug!(
                    document_type,
                    "another write by this identity took the nonce; re-preparing"
                );
                refresh_nonce().await;
            }
            Ok(_) => return Ok(prepared),
            Err(Error::StaleProtocolVersion(reason)) if !version_refreshed => {
                version_refreshed = true;
                tracing::debug!(%reason, "stale protocol version");
                refresh_version().await?;
            }
            Err(Error::Timeout { retryable: true })
                if resign == Resign::Unique && resigns < MAX_UNCONFIRMED_RESIGNS =>
            {
                resigns += 1;
                tracing::warn!(
                    document_type,
                    "write not confirmed (a node holds it but it does not land); signing it \
                     again with a fresh nonce: consensus admits only one copy"
                );
            }
            Err(e) => return Err(e),
        }
    }
    Err(Error::Nonce)
}

/// Send the next broadcast of a write to another node than any tried so far ([`drive_write`]).
fn go_elsewhere(elsewhere: &mut Option<usize>) {
    *elsewhere = Some(elsewhere.map_or(0, |n| n + 1));
}

/// The `n`th node away from the rotation for the transition `bytes`: the live addresses in a
/// fixed order, starting at a point the transition's bytes decide (so writes stuck at once
/// spread over the nodes), and `n` steps on, so each later send of the same write asks a node
/// not asked yet. `None` without a live address.
fn pick_elsewhere(mut live: Vec<Address>, bytes: &[u8], n: usize) -> Option<Address> {
    if live.is_empty() {
        return None;
    }
    live.sort_by_key(|a| a.uri().to_string());
    let start = bytes.iter().fold(0usize, |h, b| {
        h.wrapping_mul(31).wrapping_add(usize::from(*b))
    });
    let at = (start % live.len() + n % live.len()) % live.len();
    Some(live.swap_remove(at))
}

/// Before lag retry `n` (1-based) of a write a total-reading rule refused at CheckTx: wait about
/// a block, then two ([`MAX_LAG_RETRIES`]), for the node to catch up.
async fn wait_out_lag(
    document_type: &str,
    rule: &str,
    detail: &str,
    backoff: std::time::Duration,
    n: u32,
) {
    let delay = backoff_delay(backoff * 3 / 2, n);
    // Debug, not warn: the write is being recovered, and a refusal that outlasts the retries
    // reaches the caller as its own error (D-5).
    tracing::debug!(
        document_type,
        rule,
        delay_ms = duration_ms(delay),
        error = %detail,
        "refused by a rule that reads a total; re-broadcasting once the node has caught up \
         with this identity's latest writes"
    );
    tokio::time::sleep(delay).await;
}

/// What [`drive_write`] does after [`wait_out_quorum`].
enum QuorumStep {
    /// Send the same bytes again.
    Retry,
    /// The nonce was spent while it waited: the write landed, or another took the nonce.
    Landed,
    /// Handle this failure as usual.
    Failure(WriteFailure),
}

/// A quorum the quorum service has not caught up with ([`WriteFailure::QuorumMiss`]): wait for
/// it ([`quorum::wait_for_quorum`]: unbanning the nodes banned over it), then ask whether the
/// nonce was spent meanwhile before sending again, without spending an ordinary attempt. When
/// no wait is due (past the pacing or the rotation's budget, or an unreachable quorum service)
/// it is an ordinary retryable failure, asked the same question first. Any other failure is
/// returned as it is.
async fn wait_out_quorum<N, NFut>(
    failure: WriteFailure,
    waits: &[std::time::Duration],
    retries: &mut u32,
    document_type: &str,
    nonce_spent: &mut N,
) -> QuorumStep
where
    N: FnMut() -> NFut,
    NFut: std::future::Future<Output = bool>,
{
    let WriteFailure::QuorumMiss(reason) = failure else {
        return QuorumStep::Failure(failure);
    };
    let waited = quorum::wait_for_quorum(document_type, waits, *retries as usize).await;
    if nonce_spent().await {
        return QuorumStep::Landed;
    }
    if waited {
        *retries += 1;
        QuorumStep::Retry
    } else {
        QuorumStep::Failure(WriteFailure::Retryable(reason))
    }
}

fn duration_ms(d: std::time::Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// Run a proof-verified read, retrying transient node failures with exponential backoff.
///
/// Reads are side-effect free, so a retry is always safe. Each attempt is a fresh SDK call
/// and therefore a fresh rotation over the unbanned DAPI nodes. A non-transient error (a
/// verified "not found" is an `Ok(None)`, not an error; a malformed query is not transient)
/// returns immediately.
// The error is the SDK's own (large) type, passed straight through from the SDK calls this
// wraps; every caller maps it to a crate error on the next line.
#[allow(clippy::result_large_err)]
pub(crate) async fn retry_transient_read<T, F, Fut>(
    label: &str,
    mut op: F,
) -> std::result::Result<T, dash_sdk::Error>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = std::result::Result<T, dash_sdk::Error>>,
{
    retry_with_quorum_waits(
        label,
        RETRY_BACKOFF_BASE,
        is_transient_node_error,
        rate_limit_reset,
        (quorum::is_quorum_miss, &quorum::QUORUM_WAITS),
        || {
            let fut = op();
            async move {
                crate::budget::acquire().await;
                fut.await
            }
        },
    )
    .await
}

/// A composite query's failure: [`Error::CompositeRefused`] when the node answered it with a
/// refusal of the request itself (an invalid argument: a shape Drive rejects; unimplemented or
/// an unsupported query version: a network without the composite surface), the plain platform
/// error otherwise (a transient node failure the retries did not cure, a rate limit).
fn composite_refusal(e: &dash_sdk::Error) -> Error {
    use dapi_grpc::tonic::Code;
    use dash_sdk::dapi_client::transport::TransportError;
    use dash_sdk::dapi_client::DapiClientError;
    let code = match e {
        dash_sdk::Error::DapiClientError(DapiClientError::Transport(TransportError::Grpc(s))) => {
            Some(s.code())
        }
        _ => None,
    };
    let text = e.to_string();
    let unsupported = code == Some(Code::Unimplemented)
        || text.contains("UnsupportedQueryVersion")
        || text.contains("unsupported query version");
    if unsupported || code == Some(Code::InvalidArgument) {
        Error::CompositeRefused {
            unsupported,
            reason: text,
        }
    } else {
        Error::Platform(format!("composite query: {text}"))
    }
}

/// How long the gateway asked us to wait: `Some(ratelimit-reset)` when `e` is a DAPI
/// rate-limit refusal (gRPC `ResourceExhausted`), wherever the SDK wrapped it (directly, or
/// as the last error behind "no available addresses to retry" once it had banned every node
/// it tried). A `ResourceExhausted` without the header is not a rate limit (drive-abci's
/// busy check-tx answer): `None`, and the caller's ordinary backoff applies.
fn rate_limit_reset(e: &dash_sdk::Error) -> Option<std::time::Duration> {
    // Only a refusal carrying the gateway's `ratelimit-reset`: drive-abci also answers
    // ResourceExhausted (without the header) when check-tx capacity is briefly busy, which the
    // ordinary short backoff handles.
    transport_error(e).and_then(dash_sdk::dapi_client::CanRetry::rate_limit_ban_duration)
}

/// [`retry_with_quorum_waits`] with no quorum waits: what the attempt-count and rate-limit tests
/// drive.
#[cfg(test)]
async fn retry_with_backoff<T, E, F, Fut>(
    label: &str,
    base: std::time::Duration,
    transient: impl Fn(&E) -> bool,
    rate_limited: impl Fn(&E) -> Option<std::time::Duration>,
    op: F,
) -> std::result::Result<T, E>
where
    E: std::fmt::Display,
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = std::result::Result<T, E>>,
{
    retry_with_quorum_waits(
        label,
        base,
        transient,
        rate_limited,
        (|_: &E| false, &[]),
        op,
    )
    .await
}

/// The loop behind [`retry_transient_read`], generic over the error and the delays so the
/// attempt count and backoff are testable without a network or a real clock.
///
/// A rate-limit refusal (`rate_limited` returns the reset the gateway asked for) is not a
/// failed attempt: the loop waits out the reset (plus jitter) and asks again, up to
/// [`crate::budget::MAX_RATE_LIMIT_WAITS`] times, and says so on stderr once per wait
/// (D-902: a rate limit used to ban every node and fail the command). Nor is a quorum miss
/// (`quorum.0`, [`quorum::is_quorum_miss`]): it is retried after each pause of `quorum.1` in
/// turn, every node unbanned first. Past those, failures take the ordinary attempts.
async fn retry_with_quorum_waits<T, E, F, Fut>(
    label: &str,
    base: std::time::Duration,
    transient: impl Fn(&E) -> bool,
    rate_limited: impl Fn(&E) -> Option<std::time::Duration>,
    quorum: (impl Fn(&E) -> bool, &[std::time::Duration]),
    mut op: F,
) -> std::result::Result<T, E>
where
    E: std::fmt::Display,
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = std::result::Result<T, E>>,
{
    let (quorum_miss, quorum_waits) = quorum;
    let mut attempt: u32 = 1;
    let mut waits: u32 = 0;
    let mut quorum_retries: usize = 0;
    loop {
        let e = match op().await {
            Ok(v) => return Ok(v),
            Err(e) => e,
        };
        if quorum_miss(&e) && quorum::wait_for_quorum(label, quorum_waits, quorum_retries).await {
            quorum_retries += 1;
            continue;
        }
        match rate_limited(&e) {
            Some(reset) if waits < crate::budget::MAX_RATE_LIMIT_WAITS => {
                waits += 1;
                crate::budget::wait_out_rate_limit(label, reset).await;
                continue;
            }
            _ => {}
        }
        if attempt >= MAX_READ_ATTEMPTS || !transient(&e) {
            return Err(e);
        }
        let delay = backoff_delay(base, attempt);
        tracing::debug!(
            op = label,
            attempt,
            delay_ms = duration_ms(delay),
            error = %e,
            "transient Platform read failure; backing off and retrying on a fresh node rotation"
        );
        tokio::time::sleep(delay).await;
        attempt += 1;
    }
}

/// A signed state transition ready to (re)broadcast.
///
/// The bytes are captured once, before the first broadcast, so a timeout can rebroadcast
/// the identical, same-nonce transition rather than re-signing (which would burn a fresh
/// nonce + entropy and risk a duplicate write). This is the load-bearing primitive of
/// the idempotent-retry model — [`WriteEngine::execute`] broadcasts exactly these bytes.
#[derive(Clone, Serialize, Deserialize)]
pub struct SignedTransition {
    /// The serialized, signed transition bytes.
    pub bytes: Vec<u8>,
    /// The identity-contract nonce this transition was signed against.
    pub nonce: u64,
}

impl SignedTransition {
    /// Serialize a signed `StateTransition` into the durable byte form.
    fn from_state_transition(st: &StateTransition, nonce: u64) -> Result<Self> {
        let bytes = st
            .serialize_to_bytes()
            .map_err(|e| Error::Platform(format!("serializing signed transition: {e}")))?;
        Ok(Self { bytes, nonce })
    }
}

impl std::fmt::Debug for SignedTransition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Signed bytes are not secret, but they are large and noisy; summarize.
        f.debug_struct("SignedTransition")
            .field("bytes_len", &self.bytes.len())
            .field("nonce", &self.nonce)
            .finish()
    }
}

/// Outcome of a broadcast attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BroadcastOutcome {
    /// The transition was accepted and its result observed for the first time.
    Applied,
    /// The transition already existed on-chain — treated as success (idempotency).
    AlreadyExists,
    /// Platform refused the transition's nonce as already used. That is this very transition
    /// having landed earlier (a re-broadcast) OR another write by the same identity having
    /// taken the nonce first — on forge-v2 every write an identity makes shares one nonce
    /// counter, so concurrent processes can collide. The caller must check which:
    /// [`WriteEngine::create_journaled`] and [`WriteEngine::delete_document`] do.
    NonceConsumed,
}

/// The durable idempotent-retry intent: "I intend to broadcast *these* exact signed
/// bytes for chunk `seq`". Persisted (via a [`JournalStore`]) before the first broadcast
/// so a crashed push resumes by re-executing the same [`SignedTransition`] rather than
/// re-signing.
///
// TODO(push-pipeline): the disk-backed journal (`.git/dash/journal/<packHash>.json`)
// and its `JournalStore` filesystem impl land with the pack push pipeline. Today the
// in-memory [`WriteEngine::execute`] retry loop already delivers the core guarantee
// (re-broadcast the same bytes; AlreadyExists = success); this type + [`PushJournal`]
// fix the on-disk shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteIntent {
    /// Zero-based chunk sequence within the pack this intent belongs to.
    pub seq: u32,
    /// The document id the write targets (deterministic for a create).
    pub document_id: String,
    /// Whether the intent creates or deletes.
    pub operation: WriteOp,
    /// The signed transition to (re)broadcast verbatim.
    pub transition: SignedTransition,
}

impl WriteIntent {
    /// Capture a [`PreparedWrite`] as a durable journal intent for chunk `seq`.
    pub fn for_prepared(seq: u32, prepared: &PreparedWrite) -> Self {
        Self {
            seq,
            document_id: prepared.document_id.clone(),
            operation: prepared.op,
            transition: prepared.signed.clone(),
        }
    }
}

/// A persistence sink for [`PushJournal`] progress, so an interrupted push resumes
/// without re-paying. Implemented over the filesystem by the push pipeline; defined here
/// so the engine can be tested against an in-memory fake.
pub trait JournalStore {
    /// Persist journal progress (called after each confirmed write).
    fn checkpoint(&self, journal: &PushJournal) -> Result<()>;
}

/// A single confirmed-write record within a [`PushJournal`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    /// Zero-based chunk sequence within the pack.
    pub seq: u32,
    /// The on-chain document id of the confirmed write.
    pub document_id: String,
}

/// The resumable-push journal for a single pack (`.git/dash/journal/<packHash>.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushJournal {
    /// Hex SHA-256 of the pack this journal tracks.
    pub pack_hash: String,
    /// Total chunk count for the pack (from the manifest plan).
    pub chunk_count: u32,
    /// Chunks already confirmed, by sequence.
    pub uploaded: Vec<JournalEntry>,
}

impl PushJournal {
    /// Start an empty journal for a pack.
    pub fn new(pack_hash: impl Into<String>, chunk_count: u32) -> Self {
        Self {
            pack_hash: pack_hash.into(),
            chunk_count,
            uploaded: Vec::new(),
        }
    }

    /// Record a confirmed write from its durable [`WriteIntent`].
    pub fn record(&mut self, intent: &WriteIntent) {
        if !self.has(intent.seq) {
            self.uploaded.push(JournalEntry {
                seq: intent.seq,
                document_id: intent.document_id.clone(),
            });
        }
    }

    /// Whether the chunk at `seq` has already been confirmed (skip → no re-pay).
    pub fn has(&self, seq: u32) -> bool {
        self.uploaded.iter().any(|e| e.seq == seq)
    }

    /// Whether every chunk has been confirmed.
    pub fn is_complete(&self) -> bool {
        self.uploaded.len() >= self.chunk_count as usize
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ascending_equivalent, is_contract_missing, is_stale_contract, is_transient_node_error,
        page_to_exhaustion, page_until, retry_with_backoff, tie_probe_allowed, FetchedDocument,
        FieldValue, JournalStore, PushJournal, QueryFilter, QueryOrder, SignedTransition,
        WriteIntent, WriteOp, MAX_PAGES, MAX_READ_ATTEMPTS, NONCE_MASK, PAGE_SIZE,
    };
    use crate::error::{Error, Result};
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    /// The grouped-count keys of `transition.kind` (a `u8` under sized integer types) and the
    /// grouped-sum keys of `targetId` (an identifier), as Drive serializes them
    /// (`encode_value_for_tree_keys`): checked against rs-dpp's own encoder.
    #[test]
    fn grouped_aggregate_keys_decode_as_drive_encodes_them() {
        use dash_sdk::dpp::data_contract::document_type::DocumentPropertyType;
        use dash_sdk::dpp::platform_value::Value;
        for kind in [1u8, 2, 11, 12, 13, 14, 15, 16, 17, 0, 255] {
            let key = DocumentPropertyType::U8
                .encode_value_for_tree_keys(&Value::U8(kind))
                .unwrap();
            assert_eq!(key, DocumentPropertyType::encode_u8(kind));
            assert_eq!(super::decode_u8_key(&key), Some(kind), "kind {kind}");
        }
        assert_eq!(super::decode_u8_key(&[1, 2]), None);
        let id = [7u8; 32];
        let key = DocumentPropertyType::Identifier
            .encode_value_for_tree_keys(&Value::Identifier(id))
            .unwrap();
        assert_eq!(
            super::decode_identifier_key(&key),
            Some(super::encode_identifier(id))
        );
        assert_eq!(super::decode_identifier_key(&key[..31]), None);
    }

    /// Split entries flatten per key; an unproved (`None`) value reads 0.
    #[test]
    fn split_entries_flatten_per_key() {
        use drive_proof_verifier::{SplitCountEntry, SplitSumEntry};
        let counts = super::split_counts(vec![
            SplitCountEntry {
                in_key: None,
                key: vec![0x81],
                count: Some(3),
            },
            SplitCountEntry {
                in_key: None,
                key: vec![0x82],
                count: None,
            },
        ]);
        assert_eq!(counts, BTreeMap::from([(vec![0x81], 3), (vec![0x82], 0)]));
        let sums = super::split_sums(vec![
            SplitSumEntry {
                in_key: None,
                key: vec![1; 32],
                sum: Some(-1),
            },
            SplitSumEntry {
                in_key: Some(vec![9]),
                key: vec![1; 32],
                sum: Some(9),
            },
        ]);
        assert_eq!(sums, BTreeMap::from([(vec![1; 32], 8)]));
    }

    /// `transition.delta` is signed: a negative value goes out as a signed `Value` and reads
    /// back as [`FieldValue::Signed`]; a non-negative one stays [`FieldValue::Integer`].
    #[test]
    fn signed_integers_round_trip() {
        use dash_sdk::dpp::platform_value::Value;
        assert_eq!(FieldValue::signed(-8).into_value(), Value::I8(-8));
        assert_eq!(FieldValue::signed(2).into_value(), Value::U8(2));
        assert_eq!(FieldValue::signed(-300).into_value(), Value::I16(-300));
        assert_eq!(
            FieldValue::from_value(&Value::I8(-1)),
            Some(FieldValue::Signed(-1))
        );
        assert_eq!(
            FieldValue::from_value(&Value::I8(8)),
            Some(FieldValue::Integer(8))
        );
        assert_eq!(FieldValue::Signed(-1).as_i64(), Some(-1));
        assert_eq!(FieldValue::Signed(-1).as_u64(), None);
        assert_eq!(FieldValue::Integer(5).as_i64(), Some(5));
    }

    #[test]
    fn a_replace_against_a_newer_revision_is_refused() {
        use super::check_revision;
        assert!(
            check_revision("comment", "c1", None, Some(3), false).is_ok(),
            "no guard"
        );
        assert!(check_revision("comment", "c1", Some(3), Some(3), false).is_ok());
        let err = check_revision("comment", "c1", Some(2), Some(3), false).unwrap_err();
        let Error::User(u) = &err else {
            panic!("{err:?}")
        };
        assert_eq!(u.code, crate::user_error::codes::EDIT_CONFLICT);
        assert!(u.message.contains("nothing was written"), "{}", u.message);
        // after a broadcast whose nonce was spent, it cannot claim nothing was written
        let err = check_revision("comment", "c1", Some(2), Some(3), true).unwrap_err();
        let Error::User(u) = &err else {
            panic!("{err:?}")
        };
        assert!(!u.message.contains("nothing was written"), "{}", u.message);
    }

    #[test]
    fn a_replace_holds_by_value_not_wire_form() {
        use super::same_field;
        let s = |v: FieldValue| Some(v);
        // Integer widths, byte kinds, and an empty list that reads back as empty bytes.
        assert!(same_field(
            s(FieldValue::Uint64(3)).as_ref(),
            s(FieldValue::Integer(3)).as_ref()
        ));
        assert!(same_field(
            s(FieldValue::Bytes32([7; 32])).as_ref(),
            s(FieldValue::Identifier([7; 32])).as_ref()
        ));
        assert!(same_field(
            s(FieldValue::Bytes(vec![])).as_ref(),
            s(FieldValue::text_list(Vec::<String>::new())).as_ref()
        ));
        assert!(same_field(
            s(FieldValue::text_list(["a", "b"])).as_ref(),
            s(FieldValue::text_list(["a", "b"])).as_ref()
        ));
        assert!(!same_field(
            s(FieldValue::text_list(["a", "b"])).as_ref(),
            s(FieldValue::text_list(["b", "a"])).as_ref()
        ));
        assert!(!same_field(
            s(FieldValue::Integer(3)).as_ref(),
            s(FieldValue::Integer(4)).as_ref()
        ));
        assert!(same_field(None, None));
        assert!(!same_field(None, s(FieldValue::text("x")).as_ref()));
    }

    fn fields(order: &[QueryOrder]) -> Vec<(String, bool)> {
        order
            .iter()
            .map(|o| (o.field.clone(), o.ascending))
            .collect()
    }

    #[test]
    fn a_descending_complete_read_is_paged_ascending() {
        let asc = ascending_equivalent(&[], &[QueryOrder::desc("$createdAt")]).unwrap();
        assert_eq!(fields(&asc), [("$createdAt".to_string(), true)]);
    }

    #[test]
    fn an_ascending_read_is_left_alone() {
        assert!(ascending_equivalent(&[], &[QueryOrder::asc("$createdAt")]).is_none());
        assert!(ascending_equivalent(&[], &[]).is_none());
    }

    #[test]
    fn a_mixed_order_flips_only_when_the_ascending_prefix_is_pinned() {
        let order = [QueryOrder::asc("kind"), QueryOrder::desc("$createdAt")];
        // `kind` pinned by an equality filter: reversing it is a no-op, so the read flips.
        let pinned = [QueryFilter::eq("kind", FieldValue::integer(1))];
        let asc = ascending_equivalent(&pinned, &order).unwrap();
        assert_eq!(
            fields(&asc),
            [("kind".to_string(), true), ("$createdAt".to_string(), true)]
        );
        // Unpinned (or only range-filtered): reversing would reorder `kind`, so it stays.
        assert!(ascending_equivalent(&[], &order).is_none());
        let ranged = [QueryFilter::gt("kind", FieldValue::integer(1))];
        assert!(ascending_equivalent(&ranged, &order).is_none());
    }

    fn doc(i: usize) -> FetchedDocument {
        FetchedDocument {
            id: format!("d-{i:06}"),
            owner_id: "owner".to_string(),
            created_at: Some(i as u64),
            created_at_block_height: None,
            updated_at_block_height: None,
            fields: BTreeMap::new(),
            revision: None,
        }
    }

    /// Serve `total` documents in `PAGE_SIZE` pages, honoring the `start_after` cursor.
    fn serve(
        total: usize,
    ) -> impl FnMut(Option<String>) -> std::future::Ready<Result<Vec<FetchedDocument>>> {
        move |start_after: Option<String>| {
            let from = match &start_after {
                None => 0,
                Some(id) => {
                    let n: usize = id.trim_start_matches("d-").parse().unwrap();
                    n + 1
                }
            };
            let to = (from + PAGE_SIZE as usize).min(total);
            let page = (from..to).map(doc).collect::<Vec<_>>();
            std::future::ready(Ok(page))
        }
    }

    type Ready = std::future::Ready<Result<Vec<FetchedDocument>>>;

    fn no_probe() -> Option<fn(u64) -> Ready> {
        None
    }

    /// A document at `created_at` with id `d-<i>`.
    fn doc_at(i: usize, created_at: u64) -> FetchedDocument {
        FetchedDocument {
            created_at: Some(created_at),
            ..doc(i)
        }
    }

    /// Rows sorted by ($createdAt, $id), served with PROTOCOL-13 cursor semantics: a
    /// `start_after` cursor excludes every row whose `$createdAt` is <= the cursor's, so rows
    /// sharing the cursor's timestamp but sorting after it are skipped (the real Drive
    /// behaviour this guards against).
    fn protocol_13(rows: Vec<FetchedDocument>) -> impl FnMut(Option<String>) -> Ready {
        move |start_after| {
            let from_t = start_after.map(|id| {
                rows.iter()
                    .find(|d| d.id == id)
                    .and_then(|d| d.created_at)
                    .unwrap()
            });
            let page = rows
                .iter()
                .filter(|d| from_t.is_none_or(|t| d.created_at.unwrap() > t))
                .take(PAGE_SIZE as usize)
                .cloned()
                .collect();
            std::future::ready(Ok(page))
        }
    }

    /// 99 rows at distinct times, then `tied` rows sharing one timestamp: row 100 is the
    /// first of the tie, so the page boundary falls inside it.
    fn straddling_tie(tied: usize) -> Vec<FetchedDocument> {
        let mut rows: Vec<FetchedDocument> = (0..99).map(|i| doc_at(i, i as u64)).collect();
        rows.extend((99..99 + tied).map(|i| doc_at(i, 1_000)));
        rows.push(doc_at(99 + tied, 2_000));
        rows
    }

    #[tokio::test]
    async fn protocol_13_drops_same_block_rows_at_a_page_boundary_without_the_probe() {
        let rows = straddling_tie(3);
        let got = page_to_exhaustion("event", protocol_13(rows.clone()), no_probe())
            .await
            .unwrap();
        // The mock reproduces the gap: the two tied rows after the boundary are lost.
        assert_eq!(got.len(), rows.len() - 2);
    }

    #[tokio::test]
    async fn the_tie_probe_recovers_same_block_rows_at_a_page_boundary() {
        let rows = straddling_tie(3);
        let tie_rows = rows.clone();
        let probe = move |t: u64| {
            let tied = tie_rows
                .iter()
                .filter(|d| d.created_at == Some(t))
                .cloned()
                .collect();
            std::future::ready(Ok(tied))
        };
        let got = page_to_exhaustion("event", protocol_13(rows.clone()), Some(probe))
            .await
            .unwrap();
        let ids: Vec<&str> = got.iter().map(|d| d.id.as_str()).collect();
        let want: Vec<&str> = rows.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, want, "every row, once, in traversal order");
    }

    #[tokio::test]
    async fn a_boundary_tie_of_a_full_page_is_refused() {
        let rows = straddling_tie(PAGE_SIZE as usize);
        let tie_rows = rows.clone();
        let probe = move |t: u64| {
            let tied = tie_rows
                .iter()
                .filter(|d| d.created_at == Some(t))
                .take(PAGE_SIZE as usize)
                .cloned()
                .collect();
            std::future::ready(Ok(tied))
        };
        let got = page_to_exhaustion("event", protocol_13(rows), Some(probe)).await;
        assert!(matches!(got, Err(Error::IncompleteRead { .. })), "{got:?}");
    }

    #[test]
    fn the_tie_probe_runs_only_where_created_at_ends_the_index() {
        let owner = || QueryFilter::eq("$ownerId", FieldValue::integer(1));
        assert!(tie_probe_allowed(&[], &[QueryOrder::asc("$createdAt")]));
        assert!(tie_probe_allowed(
            &[owner()],
            &[QueryOrder::asc("$ownerId"), QueryOrder::asc("$createdAt")]
        ));
        // Not ending in $createdAt, an unpinned prefix, a range filter, or descending.
        assert!(!tie_probe_allowed(&[], &[QueryOrder::asc("seq")]));
        assert!(!tie_probe_allowed(
            &[],
            &[QueryOrder::asc("$ownerId"), QueryOrder::asc("$createdAt")]
        ));
        assert!(!tie_probe_allowed(
            &[QueryFilter::gt("seq", FieldValue::integer(1))],
            &[QueryOrder::asc("$createdAt")]
        ));
        assert!(!tie_probe_allowed(&[], &[QueryOrder::desc("$createdAt")]));
    }

    #[tokio::test]
    async fn pages_past_the_first_page_boundary() {
        // 101 rows: the case the whole change exists for. A single page would stop at 100.
        let got = page_to_exhaustion("event", serve(101), no_probe())
            .await
            .unwrap();
        assert_eq!(got.len(), 101);
        assert_eq!(got[100].id, "d-000100");
    }

    #[tokio::test]
    async fn a_short_first_page_is_the_end() {
        let capped = page_until("event", serve(usize::MAX), no_probe(), 150)
            .await
            .expect("a capped read stops once past the cap");
        assert_eq!(
            capped.len(),
            200,
            "two full pages: the second passes the cap"
        );
        let got = page_to_exhaustion("event", serve(7), no_probe())
            .await
            .unwrap();
        assert_eq!(got.len(), 7);
    }

    #[tokio::test]
    async fn an_exactly_full_last_page_still_probes_once_more() {
        // Exactly PAGE_SIZE rows: the first page is full, so the end is NOT yet proven and
        // a second (empty, therefore short) page must be requested.
        let mut calls = 0usize;
        let got = page_to_exhaustion(
            "event",
            |start_after| {
                calls += 1;
                let mut f = serve(PAGE_SIZE as usize);
                f(start_after)
            },
            no_probe(),
        )
        .await
        .unwrap();
        assert_eq!(got.len(), PAGE_SIZE as usize);
        assert_eq!(calls, 2, "a full page is never itself proof of the end");
    }

    #[tokio::test]
    async fn refuses_to_return_a_partial_answer_at_the_page_cap() {
        // A cursor that always advances and pages that are always full: the end is never
        // proven, so this must fail rather than hand back 100k rows as if complete.
        let got = page_to_exhaustion("event", serve(usize::MAX), no_probe()).await;
        match got {
            Err(Error::IncompleteRead {
                document_type,
                fetched,
                ..
            }) => {
                assert_eq!(document_type, "event");
                assert_eq!(fetched, MAX_PAGES * PAGE_SIZE as usize);
            }
            other => panic!("expected IncompleteRead, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn propagates_a_fetch_error() {
        let got = page_to_exhaustion(
            "event",
            |_| std::future::ready(Err(Error::Platform("boom".into()))),
            no_probe(),
        )
        .await;
        assert!(matches!(got, Err(Error::Platform(_))));
    }

    /// QW3-005: the deadline follows the rate the network delivered, a page answered well
    /// inside it grows, and a page that runs out of time halves with a doubled deadline.
    #[test]
    fn the_large_page_deadline_follows_the_network() {
        use super::{
            AdaptivePager, LARGE_PAGE_MAX, LARGE_PAGE_MAX_TIMEOUT, LARGE_PAGE_MIN_TIMEOUT,
            LARGE_PAGE_START,
        };
        use std::time::Duration;
        let mut p = AdaptivePager::new(LARGE_PAGE_START, LARGE_PAGE_MAX);
        // One chunk a second assumed, three times over: 16 chunks get 48 s, not the SDK's 15.
        assert_eq!((p.limit, p.timeout), (16, Duration::from_secs(48)));
        // 16 chunks in 8 s (about 30 KB/s): well inside 48 s, so the page doubles, and the
        // deadline is three times what 32 chunks need at 2 a second.
        p.on_page(16, Duration::from_secs(8));
        assert_eq!((p.limit, p.timeout), (32, Duration::from_secs(48)));
        // 32 in 40 s: no growth, and the slower rate gets the longest deadline.
        p.on_page(32, Duration::from_secs(40));
        assert_eq!((p.limit, p.timeout), (32, LARGE_PAGE_MAX_TIMEOUT));
        // A fast link grows to the maximum with the shortest deadline.
        let mut fast = AdaptivePager::new(LARGE_PAGE_START, LARGE_PAGE_MAX);
        for _ in 0..4 {
            fast.on_page(fast.limit as usize, Duration::from_millis(300));
        }
        assert_eq!(
            (fast.limit, fast.timeout),
            (LARGE_PAGE_MAX, LARGE_PAGE_MIN_TIMEOUT)
        );
        // Out of time: half the rows, twice the time, down to one row at the longest
        // deadline, which is the last try.
        let mut slow = AdaptivePager::new(LARGE_PAGE_START, LARGE_PAGE_MAX);
        let mut steps = Vec::new();
        while slow.on_deadline() {
            steps.push((slow.limit, slow.timeout.as_secs()));
        }
        assert_eq!(steps, [(8, 96), (4, 120), (2, 120), (1, 120)]);
    }

    /// QW3-005: a page that runs out of time is asked again from the same cursor with fewer
    /// rows; the read completes, in order, with nothing read twice.
    #[tokio::test]
    async fn a_slow_large_read_shrinks_its_pages_and_completes() {
        use super::{
            page_adaptively, AdaptivePager, PageFailure, LARGE_PAGE_MAX, LARGE_PAGE_START,
        };
        let total = 190;
        let asked = RefCell::new(Vec::new());
        let got = page_adaptively(
            "chunk",
            AdaptivePager::new(LARGE_PAGE_START, LARGE_PAGE_MAX),
            |start_after: Option<String>, limit: u32, _timeout| {
                asked.borrow_mut().push(limit);
                // The network delivers at most 8 rows before any deadline.
                let out = if limit > 8 {
                    Err(PageFailure::Deadline(
                        "no complete response within 15s".into(),
                    ))
                } else {
                    let from = start_after.map_or(0, |id| {
                        id.trim_start_matches("d-").parse::<usize>().unwrap() + 1
                    });
                    Ok((from..(from + limit as usize).min(total))
                        .map(doc)
                        .collect())
                };
                std::future::ready(out)
            },
        )
        .await
        .unwrap();
        let ids: Vec<String> = got.iter().map(|d| d.id.clone()).collect();
        let want: Vec<String> = (0..total).map(|i| doc(i).id).collect();
        assert_eq!(ids, want);
        let asked = asked.into_inner();
        // The first page of 16 ran out of time. After it the read stays at 8 and tries 16
        // again only after 8 quick pages in a row: 24 pages of 8 cover 190 rows (the last one
        // short), with one retry of 16 per 8 of them.
        assert_eq!(asked[..2], [16, 8], "{asked:?}");
        let (big, small): (Vec<u32>, Vec<u32>) = asked.iter().partition(|&&l| l > 8);
        assert_eq!(small.len(), 24, "{asked:?}");
        assert!(small.iter().all(|&l| l == 8), "{asked:?}");
        assert_eq!(big.len(), 3, "{asked:?}");
    }

    /// QW3-005: a node that was slow once does not keep a fast read small: after
    /// `LARGE_PAGE_RECOVERY` quick pages the ceiling doubles again.
    #[test]
    fn a_lowered_page_ceiling_recovers_after_quick_pages() {
        use super::{AdaptivePager, LARGE_PAGE_MAX, LARGE_PAGE_RECOVERY, LARGE_PAGE_START};
        use std::time::Duration;
        let mut p = AdaptivePager::new(LARGE_PAGE_START, LARGE_PAGE_MAX);
        assert!(p.on_deadline());
        assert_eq!(p.limit, 8);
        for _ in 0..LARGE_PAGE_RECOVERY - 1 {
            p.on_page(p.limit as usize, Duration::from_millis(200));
            assert_eq!(p.limit, 8);
        }
        p.on_page(8, Duration::from_millis(200));
        assert_eq!(p.limit, 16);
        // A slow page resets the streak.
        p.on_page(16, Duration::from_secs(19));
        assert_eq!((p.limit, p.quick), (16, 0));
    }

    /// QW4-014: a large read counts the byte payload of each new row it reads, once, so a
    /// progress display can show a single large pack coming in.
    #[tokio::test]
    async fn a_large_read_counts_the_bytes_it_receives() {
        use super::{large_read_bytes, page_adaptively, AdaptivePager, LARGE_PAGE_MAX};
        let chunk = |i: usize| {
            let mut d = doc(i);
            d.fields
                .insert("data".into(), FieldValue::Bytes(vec![0; 1000]));
            d.fields
                .insert("packHash".into(), FieldValue::Bytes32([0; 32]));
            d.fields.insert("seq".into(), FieldValue::Integer(i as u64));
            d
        };
        let before = large_read_bytes();
        let got = page_adaptively(
            "chunk",
            AdaptivePager::new(4, LARGE_PAGE_MAX),
            |after: Option<String>, limit: u32, _| {
                let from = after.map_or(0, |id| {
                    id.trim_start_matches("d-").parse::<usize>().unwrap() + 1
                });
                std::future::ready(Ok((from..(from + limit as usize).min(10))
                    .map(chunk)
                    .collect()))
            },
        )
        .await
        .unwrap();
        assert_eq!(got.len(), 10);
        // Other tests read concurrently: at least this read's 10 × (1000 + 32) bytes.
        assert!(large_read_bytes() - before >= 10 * 1032);
    }

    /// A full page that adds nothing new (a cursor that does not advance) fails the read
    /// instead of looping.
    #[tokio::test]
    async fn a_large_read_whose_cursor_does_not_advance_fails() {
        use super::{page_adaptively, AdaptivePager, LARGE_PAGE_MAX, LARGE_PAGE_START};
        let got = page_adaptively(
            "chunk",
            AdaptivePager::new(LARGE_PAGE_START, LARGE_PAGE_MAX),
            |_, limit: u32, _| std::future::ready(Ok((0..limit as usize).map(doc).collect())),
        )
        .await;
        assert!(
            matches!(&got, Err(Error::IncompleteRead { fetched: 48, .. })),
            "{got:?}"
        );
    }

    /// QW3-005: a network that cannot deliver one row at the longest deadline fails the read
    /// with what was read so far, after a bounded number of tries; other failures are not
    /// retried by the pager.
    #[tokio::test]
    async fn a_large_read_gives_up_when_nothing_arrives() {
        use super::{
            page_adaptively, AdaptivePager, PageFailure, LARGE_PAGE_MAX, LARGE_PAGE_START,
        };
        let calls = RefCell::new(0);
        let got = page_adaptively(
            "chunk",
            AdaptivePager::new(LARGE_PAGE_START, LARGE_PAGE_MAX),
            |_, _, _| {
                *calls.borrow_mut() += 1;
                std::future::ready(Err::<Vec<FetchedDocument>, _>(PageFailure::Deadline(
                    "late".into(),
                )))
            },
        )
        .await;
        match got {
            Err(Error::Platform(m)) => {
                assert!(
                    m.contains("did not deliver even one document within 120 s"),
                    "{m}"
                );
            }
            other => panic!("expected a Platform error, got {other:?}"),
        }
        assert_eq!(*calls.borrow(), 5);
        let calls = RefCell::new(0);
        let got = page_adaptively(
            "chunk",
            AdaptivePager::new(LARGE_PAGE_START, LARGE_PAGE_MAX),
            |_, _, _| {
                *calls.borrow_mut() += 1;
                std::future::ready(Err::<Vec<FetchedDocument>, _>(PageFailure::Other(
                    Error::NotFound,
                )))
            },
        )
        .await;
        assert!(matches!(got, Err(Error::NotFound)));
        assert_eq!(*calls.borrow(), 1);
    }

    #[test]
    fn a_deadline_is_recognised_in_every_wrapper() {
        use super::is_deadline;
        use dash_sdk::dapi_client::transport::TransportError;
        use dash_sdk::dapi_client::DapiClientError;
        let late = || {
            TransportError::Grpc(dapi_grpc::tonic::Status::deadline_exceeded(
                "no complete response within 15s",
            ))
        };
        let direct = dash_sdk::Error::DapiClientError(DapiClientError::Transport(late()));
        assert!(is_deadline(&direct));
        assert!(is_deadline(&dash_sdk::Error::DapiClientError(
            DapiClientError::NoAvailableAddressesToRetry(Box::new(late()))
        )));
        assert!(is_deadline(&dash_sdk::Error::NoAvailableAddressesToRetry(
            Box::new(direct)
        )));
        assert!(!is_deadline(&dash_sdk::Error::DapiClientError(
            DapiClientError::Transport(TransportError::Grpc(
                dapi_grpc::tonic::Status::unavailable("tcp connect error")
            ))
        )));
        // A gateway that enforced the grpc-timeout itself answers 504, which is Unavailable.
        assert!(is_deadline(&dash_sdk::Error::DapiClientError(
            DapiClientError::Transport(TransportError::Grpc(
                dapi_grpc::tonic::Status::unavailable("upstream request timeout")
            ))
        )));
    }

    #[test]
    fn nonce_mask_is_low_40_bits() {
        assert_eq!(NONCE_MASK, 0xFF_FFFF_FFFF);
        // High bits above bit 40 are stripped; the low 40 survive.
        let raw = (0xABCD_u64 << 40) | 0x12_3456_789A;
        assert_eq!(raw & NONCE_MASK, 0x12_3456_789A);
    }

    /// An in-memory [`JournalStore`] proving the journal scaffolding is exercised (the
    /// disk-backed store lands with the push pipeline).
    #[derive(Default)]
    struct MemJournalStore {
        last: RefCell<Option<PushJournal>>,
    }
    impl JournalStore for MemJournalStore {
        fn checkpoint(&self, journal: &PushJournal) -> Result<()> {
            *self.last.borrow_mut() = Some(journal.clone());
            Ok(())
        }
    }

    #[test]
    fn journal_records_intents_and_checkpoints() {
        let store = MemJournalStore::default();
        let mut journal = PushJournal::new("abc", 2);
        assert!(!journal.is_complete());

        for seq in 0..2 {
            let intent = WriteIntent {
                seq,
                document_id: format!("doc{seq}"),
                operation: WriteOp::Create,
                transition: SignedTransition {
                    bytes: vec![0xAA, 0xBB, 0xCC, 0xDD],
                    nonce: u64::from(seq) + 1,
                },
            };
            journal.record(&intent);
            // Idempotent: recording the same seq twice does not duplicate.
            journal.record(&intent);
            store.checkpoint(&journal).unwrap();
        }

        assert!(journal.is_complete());
        assert!(journal.has(0));
        assert_eq!(journal.uploaded.len(), 2);
        assert_eq!(store.last.borrow().as_ref().unwrap().uploaded.len(), 2);
    }

    /// Drive `retry_with_backoff` with a scripted sequence of outcomes (no clock: zero base
    /// delay). Returns the result and how many attempts were made.
    async fn run_script(
        script: Vec<std::result::Result<u32, &'static str>>,
    ) -> (std::result::Result<u32, &'static str>, usize) {
        let calls = RefCell::new(script.into_iter());
        let attempts = RefCell::new(0usize);
        let out = retry_with_backoff(
            "test",
            std::time::Duration::ZERO,
            |e: &&str| e.starts_with("transient"),
            |_: &&str| None,
            || {
                *attempts.borrow_mut() += 1;
                std::future::ready(calls.borrow_mut().next().expect("script exhausted"))
            },
        )
        .await;
        let n = *attempts.borrow();
        (out, n)
    }

    #[tokio::test]
    async fn transient_read_failures_are_retried_until_success() {
        let (out, n) = run_script(vec![Err("transient a"), Err("transient b"), Ok(7)]).await;
        assert_eq!(out, Ok(7));
        assert_eq!(n, 3);
    }

    #[tokio::test]
    async fn transient_read_retries_are_bounded() {
        let script = (0..MAX_READ_ATTEMPTS + 2)
            .map(|_| Err("transient"))
            .collect();
        let (out, n) = run_script(script).await;
        assert_eq!(out, Err("transient"));
        assert_eq!(n, MAX_READ_ATTEMPTS as usize);
    }

    #[tokio::test]
    async fn a_non_transient_read_error_is_not_retried() {
        let (out, n) = run_script(vec![Err("malformed query"), Ok(1)]).await;
        assert_eq!(out, Err("malformed query"));
        assert_eq!(n, 1);
    }

    /// D-902: a `ResourceExhausted` carrying `ratelimit-reset` is read as "wait N s" wherever
    /// the SDK wrapped it (directly, or behind "no available addresses" after it banned every
    /// node), and nothing else is.
    #[test]
    fn a_rate_limit_refusal_is_read_with_its_reset() {
        use dash_sdk::dapi_client::transport::TransportError;
        use dash_sdk::dapi_client::DapiClientError;
        let limited = |reset: Option<&str>| {
            let mut s = dapi_grpc::tonic::Status::resource_exhausted("429");
            if let Some(r) = reset {
                s.metadata_mut().insert(
                    "ratelimit-reset",
                    dapi_grpc::tonic::metadata::MetadataValue::try_from(r).unwrap(),
                );
            }
            TransportError::Grpc(s)
        };
        let direct =
            dash_sdk::Error::DapiClientError(DapiClientError::Transport(limited(Some("23"))));
        assert_eq!(
            super::rate_limit_reset(&direct),
            Some(std::time::Duration::from_secs(23))
        );
        let banned_all = dash_sdk::Error::DapiClientError(
            DapiClientError::NoAvailableAddressesToRetry(Box::new(limited(Some("41")))),
        );
        assert_eq!(
            super::rate_limit_reset(&banned_all),
            Some(std::time::Duration::from_secs(41))
        );
        let no_header = dash_sdk::Error::DapiClientError(DapiClientError::Transport(limited(None)));
        assert_eq!(
            super::rate_limit_reset(&no_header),
            None,
            "a busy node, not a rate limit"
        );
        let down = dash_sdk::Error::DapiClientError(DapiClientError::Transport(
            TransportError::Grpc(dapi_grpc::tonic::Status::unavailable("x")),
        ));
        assert_eq!(super::rate_limit_reset(&down), None);
    }

    /// A rate-limited read waits out the reset and then succeeds, without spending one of its
    /// transient-failure attempts (the whole read fails only after five refusals in a row).
    #[tokio::test(start_paused = true)]
    async fn a_rate_limited_read_waits_for_the_reset_and_succeeds() {
        let calls = RefCell::new(vec![Err("limited"), Err("limited"), Ok(5)].into_iter());
        let started = tokio::time::Instant::now();
        let out = retry_with_backoff(
            "test",
            std::time::Duration::ZERO,
            |_: &&str| false,
            |e: &&str| (*e == "limited").then(|| std::time::Duration::from_secs(30)),
            || std::future::ready(calls.borrow_mut().next().expect("script exhausted")),
        )
        .await;
        assert_eq!(out, Ok(5));
        assert!(
            started.elapsed() >= std::time::Duration::from_secs(60),
            "waited {:?}",
            started.elapsed()
        );
        // Five refusals in a row are an error, not an endless wait.
        let refusals = RefCell::new(0u32);
        let out: std::result::Result<u32, &str> = retry_with_backoff(
            "test",
            std::time::Duration::ZERO,
            |_: &&str| false,
            |_: &&str| Some(std::time::Duration::from_secs(1)),
            || {
                *refusals.borrow_mut() += 1;
                std::future::ready(Err("limited"))
            },
        )
        .await;
        assert_eq!(out, Err("limited"));
        assert_eq!(*refusals.borrow(), crate::budget::MAX_RATE_LIMIT_WAITS + 1);
    }

    #[test]
    fn node_level_failures_classify_as_transient() {
        use dash_sdk::dapi_client::transport::TransportError;
        use dash_sdk::dapi_client::DapiClientError;
        let grpc = |s: dapi_grpc::tonic::Status| {
            dash_sdk::Error::DapiClientError(DapiClientError::Transport(TransportError::Grpc(s)))
        };

        // An unreachable node surfaces as gRPC Unavailable ("tcp connect error").
        assert!(is_transient_node_error(&grpc(
            dapi_grpc::tonic::Status::unavailable("tcp connect error")
        )));
        // Every node banned: the SDK's give-up error, both shapes.
        assert!(is_transient_node_error(&dash_sdk::Error::DapiClientError(
            DapiClientError::NoAvailableAddresses
        )));
        assert!(is_transient_node_error(
            &dash_sdk::Error::NoAvailableAddressesToRetry(Box::new(grpc(
                dapi_grpc::tonic::Status::unavailable("x")
            )))
        ));
        // A request the node understood and refused is an answer, not a flake.
        assert!(!is_transient_node_error(&grpc(
            dapi_grpc::tonic::Status::invalid_argument("bad where clause")
        )));
        assert!(!is_transient_node_error(&dash_sdk::Error::Config(
            "bad".into()
        )));
    }

    #[test]
    fn a_document_newer_than_the_held_contract_is_stale_and_not_transient() {
        // What the SDK answers a reader holding version 1 of a contract for a document written
        // under version 2 of an updated type (measured on sakura: update1-probe.mjs).
        let text = "serialized document has trailing bytes: it was serialized under contract \
                    version 2 with properties this document type does not know; refetch the contract";
        let e = dash_sdk::Error::Protocol(dash_sdk::dpp::ProtocolError::CorruptedSerialization(
            text.to_string(),
        ));
        assert!(is_stale_contract(&e.to_string()), "{e}");
        assert!(!is_transient_node_error(&e), "every node answers the same");
        // The crate error a read maps it to keeps the text, so the read refreshes and retries.
        assert!(is_stale_contract(&format!(
            "querying release documents: {e}"
        )));
        assert!(!is_stale_contract(
            "Corrupted Serialization: error probing for trailing bytes in serialized document"
        ));
    }

    #[test]
    fn drives_contract_not_found_refusal_is_recognized() {
        use dapi_grpc::tonic::Status;
        use dash_sdk::dapi_client::transport::TransportError;
        use dash_sdk::dapi_client::DapiClientError;
        let grpc = |s: Status| {
            dash_sdk::Error::DapiClientError(DapiClientError::Transport(TransportError::Grpc(s)))
        };
        // What a reset devnet answers a document read against a contract it no longer has.
        let reset = grpc(Status::invalid_argument(
            "contract not found error: contract not found when querying from value with contract info",
        ));
        assert!(is_contract_missing(&reset));
        assert!(
            reset.to_string().contains(
                "code: 'Client specified an invalid argument', message: \"contract not found error"
            ),
            "{reset}"
        );
        assert!(!is_transient_node_error(&reset), "an answer, not a flake");
        // Document query v1's wording.
        assert!(is_contract_missing(&grpc(Status::invalid_argument(
            "contract not found error: contract not found for a document query"
        ))));
        // Other refusals and outages are not it.
        assert!(!is_contract_missing(&grpc(Status::invalid_argument(
            "bad where clause"
        ))));
        assert!(!is_contract_missing(&grpc(Status::unavailable(
            "contract not found"
        ))));
    }

    /// Drive [`super::drive_write`] with scripted broadcast and wait answers (consumed in
    /// order) and no backoff. Returns the outcome and how many of each step ran.
    /// Scripted `nonce_spent` answers are consumed in order too; missing ones are `false`.
    async fn scripted_write(
        broadcasts: Vec<std::result::Result<(), super::WriteFailure>>,
        waits: Vec<std::result::Result<(), super::WriteFailure>>,
        spent: Vec<bool>,
    ) -> (Result<super::BroadcastOutcome>, usize, usize) {
        let (out, nb, nw, _) = scripted_write_to(broadcasts, waits, spent).await;
        (out, nb, nw)
    }

    /// [`scripted_write`], also returning where each broadcast was sent: `None` the SDK's
    /// rotation, `Some(n)` the `n`th node away from it.
    async fn scripted_write_to(
        broadcasts: Vec<std::result::Result<(), super::WriteFailure>>,
        waits: Vec<std::result::Result<(), super::WriteFailure>>,
        spent: Vec<bool>,
    ) -> (
        Result<super::BroadcastOutcome>,
        usize,
        usize,
        Vec<Option<usize>>,
    ) {
        let b = RefCell::new(broadcasts.into_iter());
        let w = RefCell::new(waits.into_iter());
        let n = RefCell::new(spent.into_iter());
        let (nb, nw) = (RefCell::new(0), RefCell::new(0));
        let to = RefCell::new(Vec::new());
        let out = super::drive_write(
            |elsewhere| {
                *nb.borrow_mut() += 1;
                to.borrow_mut().push(elsewhere);
                std::future::ready(b.borrow_mut().next().expect("no more broadcasts scripted"))
            },
            || {
                *nw.borrow_mut() += 1;
                std::future::ready(w.borrow_mut().next().expect("no more waits scripted"))
            },
            || std::future::ready(n.borrow_mut().next().unwrap_or(false)),
            std::time::Duration::ZERO,
            &[std::time::Duration::ZERO; 3],
            "comment",
        )
        .await;
        (out, nb.into_inner(), nw.into_inner(), to.into_inner())
    }

    fn timeout() -> super::WriteFailure {
        super::WriteFailure::Retryable("wait timed out".into())
    }

    fn quorum_miss() -> super::WriteFailure {
        super::WriteFailure::QuorumMiss("Quorum not found for type 107".into())
    }

    /// A quorum rotation the quorum service lags (bonsia, 01:48Z): the proofs cannot be
    /// verified for minutes. The write waits for it without spending its ordinary re-broadcasts,
    /// asks whether its nonce is spent before each re-send (so it never lands twice), and lands
    /// once the quorum is known; past the waits it gives up as a timeout.
    #[tokio::test]
    async fn a_write_waits_out_a_quorum_rotation() {
        // The wait cannot verify the proof twice, then can: the same bytes land.
        let (out, nb, nw) = scripted_write(
            vec![Ok(()), Ok(()), Ok(())],
            vec![Err(quorum_miss()), Err(quorum_miss()), Ok(())],
            vec![false, false],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::Applied);
        assert_eq!((nb, nw), (3, 3));
        // The nonce probe finds it landed during the rotation: not sent again.
        let (out, nb, _) = scripted_write(vec![Ok(())], vec![Err(quorum_miss())], vec![true]).await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::NonceConsumed);
        assert_eq!(nb, 1);
        // A broadcast the SDK gave up on (every node banned over the quorum: a bare "no
        // available addresses", classified as a quorum miss) waits too.
        let (out, nb, _) =
            scripted_write(vec![Err(quorum_miss()), Ok(())], vec![Ok(())], vec![]).await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::Applied);
        assert_eq!(nb, 2);
        // A replayed journal: the node held the bytes on every send, across a quorum wait. Not
        // this call's send: AlreadyExists.
        let (out, nb, nw) = scripted_write(
            vec![
                Err(super::WriteFailure::TxKnown),
                Err(super::WriteFailure::TxKnown),
            ],
            vec![Err(quorum_miss()), Ok(())],
            vec![false],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::AlreadyExists);
        assert_eq!((nb, nw), (2, 2));
        // A first send that never left (every node banned over the quorum) is not ours either:
        // the TxKnown after it is the replay's.
        let (out, nb, nw) = scripted_write(
            vec![Err(quorum_miss()), Err(super::WriteFailure::TxKnown)],
            vec![Ok(())],
            vec![false],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::AlreadyExists);
        assert_eq!((nb, nw), (2, 1));
        // Past its three scripted waits: ordinary retries (4), then a timeout.
        let (out, nb, _) = scripted_write(
            (0..7).map(|_| Ok(())).collect(),
            vec![
                Err(quorum_miss()),
                Err(quorum_miss()),
                Err(quorum_miss()),
                Err(quorum_miss()),
                Err(quorum_miss()),
                Err(quorum_miss()),
                Err(quorum_miss()),
            ],
            vec![false; 7],
        )
        .await;
        assert!(
            matches!(out, Err(Error::Timeout { retryable: true })),
            "{out:?}"
        );
        assert_eq!(nb, 3 + super::MAX_BROADCAST_ATTEMPTS as usize);
    }

    /// A read through the quorum wait: the same pauses, without spending its ordinary attempts.
    #[tokio::test(start_paused = true)]
    async fn a_read_waits_out_a_quorum_rotation() {
        let script = vec![Err("quorum"), Err("quorum"), Err("quorum"), Ok(7)];
        let calls = RefCell::new(script.into_iter());
        let waits = [std::time::Duration::from_secs(15); 3];
        let started = tokio::time::Instant::now();
        let out = super::retry_with_quorum_waits(
            "test",
            std::time::Duration::ZERO,
            |_: &&str| false,
            |_: &&str| None,
            (|e: &&str| *e == "quorum", &waits),
            || std::future::ready(calls.borrow_mut().next().expect("script exhausted")),
        )
        .await;
        assert_eq!(out, Ok(7));
        assert!(started.elapsed() >= std::time::Duration::from_secs(45));
        // Past the waits a quorum miss is an ordinary failure (not transient here: returned).
        let calls = RefCell::new(vec![Err("quorum"); 5].into_iter());
        let out: std::result::Result<u32, &str> = super::retry_with_quorum_waits(
            "test",
            std::time::Duration::ZERO,
            |_: &&str| false,
            |_: &&str| None,
            (|e: &&str| *e == "quorum", &waits),
            || std::future::ready(calls.borrow_mut().next().expect("script exhausted")),
        )
        .await;
        assert_eq!(out, Err("quorum"));
    }

    fn refused(document_type: &str, rule: &str) -> super::WriteFailure {
        super::WriteFailure::Fatal(Error::RuleRefused {
            document_type: document_type.into(),
            rule: rule.into(),
            detail: "10422".into(),
        })
    }

    /// A manifest refused by `platformChunks` on a node a block behind its chunks is sent
    /// again (the same bytes: nothing was spent) and lands; a rule that reads no total, or a
    /// refusal that outlasts the retries, is final.
    #[tokio::test]
    async fn a_lagging_total_is_retried_and_a_real_refusal_is_final() {
        let (out, nb, nw) = scripted_write(
            vec![Err(refused("packManifest", "platformChunks")), Ok(())],
            vec![Ok(())],
            vec![],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::Applied);
        assert_eq!((nb, nw), (2, 1));

        let (out, nb, _) = scripted_write(
            vec![
                Err(refused("packManifest", "platformChunks")),
                Err(refused("packManifest", "platformChunks")),
                Err(refused("packManifest", "platformChunks")),
            ],
            vec![],
            vec![],
        )
        .await;
        assert!(
            matches!(out, Err(Error::RuleRefused { ref rule, .. }) if rule == "platformChunks"),
            "{out:?}"
        );
        assert_eq!(nb, 1 + super::MAX_LAG_RETRIES as usize);

        // A rule that reads no total (a sealed private ref named in plaintext) is final at once.
        // Returned by the wait, the refusal came from block execution (the nonce is spent, the
        // fee paid): final at once, nothing to wait out.
        let (out, nb, nw) = scripted_write(
            vec![Ok(())],
            vec![Err(refused("packManifest", "platformChunks"))],
            vec![],
        )
        .await;
        assert!(matches!(out, Err(Error::RuleRefused { .. })), "{out:?}");
        assert_eq!((nb, nw), (1, 1));
        // Also when the node already held the bytes (a resend or a replayed journal of a
        // transition a block refused: "already in chain").
        let (out, nb, nw) = scripted_write(
            vec![Err(super::WriteFailure::TxKnown)],
            vec![Err(refused("packManifest", "platformChunks"))],
            vec![],
        )
        .await;
        assert!(matches!(out, Err(Error::RuleRefused { .. })), "{out:?}");
        assert_eq!((nb, nw), (1, 1));

        // Lag retries do not use up the re-broadcasts a lost answer gets.
        let mut sends = vec![
            Err(refused("release", "oneLive")),
            Err(refused("release", "oneLive")),
        ];
        sends.extend([Ok(()), Ok(()), Ok(()), Ok(())]);
        let (out, nb, nw) = scripted_write(
            sends,
            vec![Err(timeout()), Err(timeout()), Err(timeout()), Ok(())],
            vec![false, false, false],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::Applied);
        assert_eq!((nb, nw), (6, 4));

        let (out, nb, _) =
            scripted_write(vec![Err(refused("refUpdate", "noPlain"))], vec![], vec![]).await;
        assert!(matches!(out, Err(Error::RuleRefused { .. })));
        assert_eq!(nb, 1);
        for (t, r) in [
            ("release", "oneLive"),
            ("issue", "dense"),
            ("transition", "c6_lockedAfter"),
        ] {
            assert!(super::reads_a_total(t, r), "{t}.{r}");
        }
        assert!(!super::reads_a_total("patch", "platformChunks"));
    }

    /// Every rule of the RC1 contracts that reads a total is one the write loop waits out, and
    /// every one listed is such a rule (a renamed rule does not linger).
    #[test]
    fn every_total_reading_rule_is_listed() {
        let mut found = Vec::new();
        for name in ["forge-core", "forge-collab", "forge-community"] {
            let path = format!(
                "{}/../../forge-contracts/contracts/{name}.json",
                env!("CARGO_MANIFEST_DIR")
            );
            let c: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            for (t, schema) in c["documentSchemas"].as_object().unwrap() {
                let Some(rules) = schema["propertyConstraints"].as_object() else {
                    continue;
                };
                for (r, rule) in rules {
                    let text = rule.to_string();
                    if text.contains("countOf") || text.contains("sumOf") {
                        assert!(super::reads_a_total(t, r), "{name}: {t}.{r}");
                        found.push((t.clone(), r.clone()));
                    }
                }
            }
        }
        for (t, r) in super::TOTAL_READING_RULES {
            assert!(
                found.iter().any(|(ft, fr)| ft == t && fr == r),
                "{t}.{r} is listed but reads no total in the contracts"
            );
        }
    }

    #[tokio::test]
    async fn a_write_that_lands_is_applied_after_one_broadcast_and_one_wait() {
        let (out, nb, nw) = scripted_write(vec![Ok(())], vec![Ok(())], vec![]).await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::Applied);
        assert_eq!((nb, nw), (1, 1));
    }

    /// The moutai hang: the node accepted our transition, then another write by the same
    /// identity took its nonce and Tenderdash dropped ours, so no result ever comes and every
    /// re-broadcast only hears "tx already exists in cache". After one bounded wait the loop
    /// sees the nonce is spent and hands the question to the caller, instead of seven 30 s
    /// waits on seven nodes (before) or four re-broadcasts into the cache (without the check).
    #[tokio::test]
    async fn a_silent_wait_with_a_spent_nonce_hands_over_at_once() {
        let (out, nb, nw) = scripted_write(vec![Ok(())], vec![Err(timeout())], vec![true]).await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::NonceConsumed);
        assert_eq!((nb, nw), (1, 1));
        // The same when the re-broadcast is the one that learns the nonce is gone.
        let (out, nb, nw) = scripted_write(
            vec![Ok(()), Err(super::WriteFailure::NonceConsumed)],
            vec![Err(timeout())],
            vec![],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::NonceConsumed);
        assert_eq!((nb, nw), (2, 1));
    }

    /// Still pending (slow block): the re-broadcast is told the node has it, so the loop
    /// waits again rather than failing, and the write is ours.
    #[tokio::test]
    async fn a_slow_block_waits_again_and_reports_applied() {
        let (out, nb, nw) = scripted_write(
            vec![Ok(()), Err(super::WriteFailure::TxKnown)],
            vec![Err(timeout()), Ok(())],
            vec![],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::Applied);
        assert_eq!((nb, nw), (2, 2));
    }

    /// A replayed journal: the node knew the bytes on the first send (an earlier process
    /// broadcast them), so the landing is not a fresh write.
    #[tokio::test]
    async fn bytes_the_node_already_had_report_already_exists() {
        let (out, _, _) = scripted_write(
            vec![Err(super::WriteFailure::TxKnown)],
            vec![Ok(())],
            vec![],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::AlreadyExists);
        // But a later attempt's TxKnown is our own earlier send landing.
        let (out, _, _) = scripted_write(
            vec![Err(timeout()), Err(super::WriteFailure::TxKnown)],
            vec![Ok(())],
            vec![],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::Applied);
    }

    #[tokio::test]
    async fn the_loop_is_bounded_and_fatal_answers_stop_it() {
        let (out, nb, nw) = scripted_write(
            (0..super::MAX_BROADCAST_ATTEMPTS).map(|_| Ok(())).collect(),
            (0..super::MAX_BROADCAST_ATTEMPTS)
                .map(|_| Err(timeout()))
                .collect(),
            vec![],
        )
        .await;
        assert!(matches!(out, Err(Error::Timeout { retryable: true })));
        let max = super::MAX_BROADCAST_ATTEMPTS as usize;
        assert_eq!((nb, nw), (max, max));

        let (out, nb, nw) = scripted_write(
            vec![Err(super::WriteFailure::Fatal(Error::NotAMember {
                document_type: "refUpdate".into(),
                detail: "40120".into(),
            }))],
            vec![],
            vec![],
        )
        .await;
        assert!(matches!(out, Err(Error::NotAMember { .. })));
        assert_eq!((nb, nw), (1, 0));
    }

    /// 40120 on the membership gates (`$ownerId`, `asMember`) is not being a member; on any
    /// other path it is a missing reference, typed with its path. 10422 names its rule.
    #[test]
    fn consensus_refusals_are_typed_by_path_and_rule() {
        use dash_sdk::dpp::consensus::basic::document::{
            DocumentPropertyConstraintViolatedError, PropertyConstraintViolation,
        };
        use dash_sdk::dpp::consensus::basic::BasicError;
        use dash_sdk::dpp::consensus::state::document::referenced_entity_not_found_error::ReferencedEntityNotFoundError;
        use dash_sdk::dpp::consensus::state::state_error::StateError;
        use dash_sdk::dpp::consensus::ConsensusError;
        use dash_sdk::dpp::data_contract::document_type::DocumentPropertyReferenceTarget;
        let refused = |ce: ConsensusError| {
            dash_sdk::Error::Protocol(dash_sdk::dpp::ProtocolError::ConsensusError(Box::new(ce)))
        };
        let missing = |path: &str| {
            refused(ConsensusError::StateError(
                StateError::ReferencedEntityNotFoundError(ReferencedEntityNotFoundError::new(
                    [9; 32].into(),
                    DocumentPropertyReferenceTarget::Identity,
                    path.into(),
                )),
            ))
        };
        for path in ["$ownerId", "asMember"] {
            assert!(
                matches!(
                    super::classify_write_error(&missing(path), "comment"),
                    super::WriteFailure::Fatal(Error::NotAMember { .. })
                ),
                "{path}"
            );
        }
        match super::classify_write_error(&missing("memberId"), "repoKey") {
            super::WriteFailure::Fatal(Error::ReferenceNotFound {
                document_type,
                path,
                detail,
            }) => {
                assert_eq!(
                    (document_type.as_str(), path.as_str()),
                    ("repoKey", "memberId")
                );
                assert!(detail.starts_with("40120: "), "{detail}");
            }
            _ => panic!("a missing memberId is a missing reference"),
        }
        let rule = refused(ConsensusError::BasicError(
            BasicError::DocumentPropertyConstraintViolatedError(
                DocumentPropertyConstraintViolatedError::new(
                    "review".into(),
                    "memberVerdict".into(),
                    PropertyConstraintViolation::NotMet,
                ),
            ),
        ));
        assert!(matches!(
            super::classify_write_error(&rule, "review"),
            super::WriteFailure::Fatal(Error::RuleRefused { rule, .. }) if rule == "memberVerdict"
        ));
    }

    /// A nonce Drive refuses as used is a spent nonce (landed, or taken by another write); one
    /// too far ahead of the landed writes is not: nothing of it landed, and it is waited for.
    #[test]
    fn a_nonce_too_far_ahead_is_not_a_spent_one() {
        use dash_sdk::dpp::consensus::state::identity::invalid_identity_contract_nonce_error::InvalidIdentityNonceError;
        use dash_sdk::dpp::consensus::state::state_error::StateError;
        use dash_sdk::dpp::consensus::ConsensusError;
        let refused = |why| {
            dash_sdk::Error::Protocol(dash_sdk::dpp::ProtocolError::ConsensusError(Box::new(
                ConsensusError::StateError(StateError::InvalidIdentityNonceError(
                    InvalidIdentityNonceError::new([9; 32].into(), Some(10), 40, why),
                )),
            )))
        };
        assert!(matches!(
            super::classify_write_error(
                &refused(super::MergeIdentityNonceResult::NonceTooFarInFuture),
                "comment"
            ),
            super::WriteFailure::NonceAhead
        ));
        for used in [
            super::MergeIdentityNonceResult::NonceAlreadyPresentAtTip,
            super::MergeIdentityNonceResult::NonceAlreadyPresentInPast(3),
            super::MergeIdentityNonceResult::NonceTooFarInPast,
        ] {
            assert!(matches!(
                super::classify_write_error(&refused(used), "comment"),
                super::WriteFailure::NonceConsumed
            ));
        }
    }

    /// Ahead of the landed writes: waited for, then sent to another node (the refusing one keeps
    /// the bytes cached), and lands; still ahead past the waits, a nonce error (nothing landed).
    #[tokio::test]
    async fn a_nonce_too_far_ahead_waits_for_the_writes_before_it() {
        use super::WriteFailure::NonceAhead;
        let (out, _, _, to) =
            scripted_write_to(vec![Err(NonceAhead), Ok(())], vec![Ok(())], vec![]).await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::Applied);
        assert_eq!(to, [None, Some(0)]);
        let n = super::MAX_AHEAD_RETRIES as usize + 1;
        let (out, nb, _, _) =
            scripted_write_to((0..n).map(|_| Err(NonceAhead)).collect(), vec![], vec![]).await;
        assert!(matches!(out, Err(Error::Nonce)), "{out:?}");
        assert_eq!(nb, n);
        // But a send a node took before may land once the tip catches up: unconfirmed.
        let mut sends = vec![Ok(())];
        sends.extend((0..n).map(|_| Err(NonceAhead)));
        let (out, _, _, _) = scripted_write_to(sends, vec![Err(timeout())], vec![false]).await;
        assert!(
            matches!(out, Err(Error::Timeout { retryable: true })),
            "{out:?}"
        );
    }

    /// An indexOnly create whose nonce was found spent is settled by its probe: present means
    /// ours landed and nothing is re-signed. (The all-absent case is `landed`'s own loop: ten
    /// polls 1.5 s apart, too slow for a unit test without tokio's paused clock.)
    #[tokio::test]
    async fn poll_confirm_settles_on_the_probe() {
        let calls = std::cell::Cell::new(0u32);
        let present_on_second = || {
            calls.set(calls.get() + 1);
            std::future::ready(Ok(calls.get() >= 2))
        };
        assert!(super::poll_confirm(&present_on_second).await.unwrap());
        assert_eq!(calls.get(), 2, "stops as soon as the entry shows up");

        // A failed read is an error, never "lost" (which would sign a second copy).
        let failing = || std::future::ready(Err(Error::NotFound));
        assert!(super::poll_confirm(&failing).await.is_err());
    }

    /// The same cases as forge-web's `isNonceSpent` tests.
    #[test]
    fn nonce_is_spent_follows_drive() {
        use dash_sdk::platform::Identifier;
        let spent =
            |current: u64, nonce: u64| super::nonce_is_spent(current, nonce, Identifier::default());
        let skipped = |behind: u64| 1u64 << (behind - 1 + 40);
        assert!(!spent(10, 11));
        assert!(!spent(10, 40), "far above the tip is free, not spent");
        assert!(spent(10, 10));
        assert!(spent(10, 9));
        assert!(!spent(skipped(1) + 10, 9));
        assert!(spent(skipped(2) + 10, 9));
        assert!(!spent(skipped(2) + 10, 8));
        assert!(!spent(skipped(24) + 100, 76));
        assert!(spent(100, 75));
    }

    /// The wait is bounded per node and never bans: silence about a dropped transition is
    /// not a dead node.
    #[test]
    fn the_result_wait_is_one_bounded_request_that_bans_nobody() {
        let s = super::wait_settings();
        assert_eq!(s.request_settings.retries, Some(0));
        assert_eq!(s.request_settings.ban_failed_address, Some(false));
        assert_eq!(
            s.request_settings.timeout,
            Some(super::WAIT_REQUEST_TIMEOUT)
        );
        assert!(s
            .wait_timeout
            .is_some_and(|t| t > super::WAIT_REQUEST_TIMEOUT));
    }

    /// Sakura, collab1 and collab2: the first send was taken, nothing came, and every re-send of
    /// the same bytes was answered "tx already exists in cache" by the one node that held them
    /// without moving them toward a block. The re-sends after that go to other nodes, a new one
    /// each time, and the bytes land through one of them.
    #[tokio::test]
    async fn bytes_a_node_holds_but_does_not_land_are_sent_to_other_nodes() {
        use super::WriteFailure::TxKnown;
        // Dropped first send: taken, no result; the re-send is refused from the cache; the next
        // send goes elsewhere, is taken there, and lands.
        let (out, nb, nw, to) = scripted_write_to(
            vec![Ok(()), Err(TxKnown), Ok(())],
            vec![Err(timeout()), Err(timeout()), Ok(())],
            vec![false, false],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::Applied);
        assert_eq!((nb, nw), (3, 3));
        assert_eq!(to, [None, None, Some(0)]);

        // Every node it reaches holds it and nothing lands: each send after the first refusal
        // asks a node not asked yet, then the write gives up unconfirmed (its nonce still free),
        // for the caller to re-sign.
        let (out, nb, _, to) = scripted_write_to(
            vec![Ok(()), Err(TxKnown), Err(TxKnown), Err(TxKnown)],
            vec![
                Err(timeout()),
                Err(timeout()),
                Err(timeout()),
                Err(timeout()),
            ],
            vec![false; 4],
        )
        .await;
        assert!(
            matches!(out, Err(Error::Timeout { retryable: true })),
            "{out:?}"
        );
        assert_eq!(nb, super::MAX_BROADCAST_ATTEMPTS as usize);
        assert_eq!(to, [None, None, Some(0), Some(1)]);

        // A node elsewhere that does not answer: the next send asks yet another.
        let (out, _, _, to) = scripted_write_to(
            vec![Ok(()), Err(TxKnown), Err(timeout()), Ok(())],
            vec![Err(timeout()), Err(timeout()), Ok(())],
            vec![false, false],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::Applied);
        assert_eq!(to, [None, None, Some(0), Some(1)]);

        // A node elsewhere takes it, then nothing comes: it holds the bytes now, so the next send
        // asks another one too.
        let (out, _, _, to) = scripted_write_to(
            vec![Ok(()), Err(TxKnown), Ok(()), Ok(())],
            vec![Err(timeout()), Err(timeout()), Err(timeout()), Ok(())],
            vec![false, false, false],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::Applied);
        assert_eq!(to, [None, None, Some(0), Some(1)]);

        // The nonce found spent after the refusal: landed, or taken by another write; the caller
        // reads back what landed. Nothing is sent again.
        let (out, nb, _, to) = scripted_write_to(
            vec![Ok(()), Err(TxKnown)],
            vec![Err(timeout()), Err(timeout())],
            vec![false, true],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::NonceConsumed);
        assert_eq!((nb, to), (2, vec![None, None]));

        // A send the rotation answers without a result but no cached refusal stays on the
        // rotation (a slow block, not a stuck node).
        let (_, _, _, to) = scripted_write_to(
            vec![Ok(()), Ok(())],
            vec![Err(timeout()), Ok(())],
            vec![false],
        )
        .await;
        assert_eq!(to, [None, None]);
    }

    /// A total-reading rule refused the send at CheckTx: the refusing node keeps those bytes
    /// cached (dashmate's keep-invalid-txs-in-cache), so the lag retry goes to another node.
    #[tokio::test]
    async fn a_lag_retry_goes_to_another_node() {
        let (out, _, _, to) = scripted_write_to(
            vec![Err(refused("comment", "lockGate")), Ok(())],
            vec![Ok(())],
            vec![],
        )
        .await;
        assert_eq!(out.unwrap(), super::BroadcastOutcome::Applied);
        assert_eq!(to, [None, Some(0)]);
    }

    #[test]
    fn another_node_is_a_new_one_each_time_and_spread_by_transition() {
        let live: Vec<super::Address> = (1..=5)
            .map(|i| format!("https://10.0.0.{i}:1443").parse().unwrap())
            .collect();
        let pick = |bytes: &[u8], n| super::pick_elsewhere(live.clone(), bytes, n).unwrap();
        let picked: std::collections::BTreeSet<String> =
            (0..5).map(|n| pick(b"tx", n).to_string()).collect();
        assert_eq!(picked.len(), 5, "five sends, five nodes");
        assert_eq!(pick(b"tx", 0), pick(b"tx", 5), "round the list");
        let starts: std::collections::BTreeSet<String> = [b"a", b"b", b"c", b"d"]
            .iter()
            .map(|b| pick(*b, 0).to_string())
            .collect();
        assert!(
            starts.len() > 1,
            "writes stuck at once spread over the nodes"
        );
        assert!(super::pick_elsewhere(Vec::new(), b"tx", 0).is_none());
    }

    /// What [`super::create_loop`] did: the transitions it prepared (numbered from 0) and how
    /// often it read the nonce again.
    #[derive(Default)]
    struct Loop {
        prepared: usize,
        persisted: Vec<usize>,
        refreshed: usize,
        landed_asks: Vec<Vec<usize>>,
    }

    /// Run [`super::create_loop`] with scripted send outcomes (one per transition) and read-backs
    /// (one per spent nonce: which transition shows on chain).
    async fn scripted_create(
        sends: Vec<Result<super::BroadcastOutcome>>,
        landed: Vec<Option<usize>>,
        resign: super::Resign,
    ) -> (Result<usize>, Loop) {
        let log = RefCell::new(Loop::default());
        let sends = RefCell::new(sends.into_iter());
        let landed = RefCell::new(landed.into_iter());
        let out = super::create_loop(
            || {
                let mut l = log.borrow_mut();
                l.prepared += 1;
                std::future::ready(Ok(l.prepared - 1))
            },
            &mut |p: &usize| {
                log.borrow_mut().persisted.push(*p);
                Ok(())
            },
            |_| std::future::ready(sends.borrow_mut().next().expect("no more sends scripted")),
            |signed: Vec<usize>| {
                log.borrow_mut().landed_asks.push(signed);
                std::future::ready(Ok(landed
                    .borrow_mut()
                    .next()
                    .expect("no read-back scripted")))
            },
            || {
                log.borrow_mut().refreshed += 1;
                std::future::ready(())
            },
            || std::future::ready(Ok(())),
            resign,
            "comment",
        )
        .await;
        (out, log.into_inner())
    }

    /// An issue or PR (dense `number`) whose send goes unconfirmed is signed again at once with a
    /// fresh nonce: both copies carry the number, so consensus lands one. A comment is not: a
    /// stranded first copy could land beside a second, so the timeout goes back to the caller.
    #[tokio::test]
    async fn an_unconfirmed_create_is_re_signed_only_where_consensus_admits_one_copy() {
        use super::{BroadcastOutcome::Applied, Resign};
        let timeout = || Err(Error::Timeout { retryable: true });
        let (out, log) =
            scripted_create(vec![timeout(), Ok(Applied)], vec![], Resign::Unique).await;
        assert_eq!(out.unwrap(), 1, "the replacement landed");
        assert_eq!(log.persisted, [0, 1], "each persisted before it was sent");

        let (out, log) = scripted_create(vec![timeout()], vec![], Resign::Never).await;
        assert!(matches!(out, Err(Error::Timeout { retryable: true })));
        assert_eq!(log.prepared, 1, "never signed twice");

        // Bounded: past the re-signs the timeout is the caller's.
        let (out, log) = scripted_create(
            vec![timeout(), timeout(), timeout()],
            vec![],
            Resign::Unique,
        )
        .await;
        assert!(matches!(out, Err(Error::Timeout { retryable: true })));
        assert_eq!(log.prepared, 1 + super::MAX_UNCONFIRMED_RESIGNS);
    }

    /// A spent nonce: every transition this create signed is read back (an earlier, unconfirmed
    /// one may be the copy that landed); none there, the nonce is read again from Platform and a
    /// new one signed. The dips run's "nonce desynchronized" now takes six losses in a row.
    #[tokio::test]
    async fn a_spent_nonce_reads_back_every_copy_and_reads_the_nonce_again() {
        use super::BroadcastOutcome::{Applied, NonceConsumed};
        use super::Resign;
        let timeout = || Err(Error::Timeout { retryable: true });
        // Unconfirmed, re-signed; the second's nonce is found spent and the FIRST copy landed.
        let (out, log) = scripted_create(
            vec![timeout(), Ok(NonceConsumed)],
            vec![Some(0)],
            Resign::Unique,
        )
        .await;
        assert_eq!(out.unwrap(), 0, "the first copy is the result: no third");
        assert_eq!(log.landed_asks, [vec![0, 1]]);

        // Another write took the nonce: read again, signed again, landed.
        let (out, log) = scripted_create(
            vec![Ok(NonceConsumed), Ok(Applied)],
            vec![None],
            Resign::Never,
        )
        .await;
        assert_eq!(out.unwrap(), 1);
        assert_eq!(log.refreshed, 1);

        // Losing it every time ends in the desync error, after MAX_CREATE_ATTEMPTS.
        let n = super::MAX_CREATE_ATTEMPTS;
        let (out, log) = scripted_create(
            (0..n).map(|_| Ok(NonceConsumed)).collect(),
            vec![None; n],
            Resign::Never,
        )
        .await;
        assert!(matches!(out, Err(Error::Nonce)), "{out:?}");
        assert_eq!((log.prepared, log.refreshed), (n, n));
    }
}
