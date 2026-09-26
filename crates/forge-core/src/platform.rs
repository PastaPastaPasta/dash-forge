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

use std::collections::BTreeMap;
use std::num::NonZeroUsize;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use dapi_grpc::platform::v0::get_documents_request::get_documents_request_v0::Start;
use dash_sdk::dapi_client::{Address, AddressList, CanRetry};
use dash_sdk::dpp::balances::credits::TokenAmount;
use dash_sdk::dpp::block::extended_epoch_info::ExtendedEpochInfo;
use dash_sdk::dpp::consensus::basic::BasicError;
use dash_sdk::dpp::consensus::state::state_error::StateError;
use dash_sdk::dpp::consensus::ConsensusError;
use dash_sdk::dpp::dashcore::secp256k1::rand::{rngs::StdRng, Rng, SeedableRng};
use dash_sdk::dpp::dashcore::Network as DashcoreNetwork;
use dash_sdk::dpp::data_contract::accessors::v0::DataContractV0Getters;
use dash_sdk::dpp::data_contract::document_type::accessors::DocumentTypeV1Getters;
use dash_sdk::dpp::document::{Document, DocumentV0, DocumentV0Getters, INITIAL_REVISION};
use dash_sdk::dpp::identity::accessors::IdentityGettersV0;
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
use dash_sdk::dpp::tokens::calculate_token_id;
use dash_sdk::dpp::tokens::info::v0::IdentityTokenInfoV0Accessors;
use dash_sdk::dpp::tokens::info::IdentityTokenInfo;
use dash_sdk::dpp::tokens::token_amount_on_contract_token::DocumentActionTokenCost;
use dash_sdk::dpp::tokens::token_payment_info::v0::TokenPaymentInfoV0;
use dash_sdk::dpp::tokens::token_payment_info::TokenPaymentInfo;
use dash_sdk::drive::query::{OrderClause, SelectProjection, WhereClause, WhereOperator};
use dash_sdk::platform::contract_groups::ContractGroupMembershipsForContract;
use dash_sdk::platform::documents::document_query::DocumentQuery;
use dash_sdk::platform::fetch_current_no_parameters::FetchCurrent;
use dash_sdk::platform::tokens::identity_token_balances::IdentitiesTokenBalancesQuery;
use dash_sdk::platform::tokens::token_info::IdentitiesTokenInfosQuery;
use dash_sdk::platform::transition::broadcast::BroadcastStateTransition;
use dash_sdk::platform::{DataContract, Fetch, FetchMany, Identifier, Identity, IdentityPublicKey};
use dash_sdk::{RequestSettings, Sdk, SdkBuilder};
use drive_proof_verifier::types::identity_token_balance::IdentitiesTokenBalances;
use drive_proof_verifier::types::token_info::IdentitiesTokenInfos;
use drive_proof_verifier::DocumentCount;
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

pub use crate::network::{Network, NetworkTarget, Registry};

/// The `dashcore` network the SDK and its context provider use for `network`.
fn to_dashcore(network: &Network) -> DashcoreNetwork {
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

impl LoadedContract {
    /// The contract's base58 id.
    pub fn id(&self) -> String {
        self.0.id().to_string(Encoding::Base58)
    }

    /// The contract owner's base58 identity id. The owner is auto-credited both tokens'
    /// `baseSupply` at creation, so it is always a WRITE+MAINTAIN holder even though no
    /// `mint` history document records that crediting (data-contracts §2.1).
    pub fn owner_id(&self) -> String {
        self.0.owner_id().to_string(Encoding::Base58)
    }

    /// Whether the contract declares a document type named `name`. Used to feature-detect
    /// template additions (e.g. the template-v2 `packMirror` type) so a client can fall
    /// back gracefully on a contract instantiated from an older template.
    pub fn has_document_type(&self, name: &str) -> bool {
        self.0.has_document_type_for_name(name)
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
pub struct LoadedIdentity(Identity);

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
                purpose: match k.purpose() {
                    Purpose::AUTHENTICATION => "AUTHENTICATION",
                    Purpose::ENCRYPTION => "ENCRYPTION",
                    Purpose::DECRYPTION => "DECRYPTION",
                    Purpose::TRANSFER => "TRANSFER",
                    Purpose::SYSTEM => "SYSTEM",
                    Purpose::VOTING => "VOTING",
                    Purpose::OWNER => "OWNER",
                }
                .to_string(),
                security_level: match k.security_level() {
                    SecurityLevel::MASTER => "MASTER",
                    SecurityLevel::CRITICAL => "CRITICAL",
                    SecurityLevel::HIGH => "HIGH",
                    SecurityLevel::MEDIUM => "MEDIUM",
                }
                .to_string(),
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
            })
            .collect()
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
    /// `None` for an unbound key.
    pub bound_to: Option<String>,
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

impl std::fmt::Debug for LoadedIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoadedIdentity")
            .field("id", &self.id())
            .field("balance", &self.0.balance())
            .finish()
    }
}

/// An rs-sdk-backed Platform client: a connected `Sdk` plus the network it targets and the
/// registry resolved for that network.
///
/// Construct with [`PlatformClient::connect`]. Proof verification is always on (the
/// trusted context provider supplies quorum public keys over HTTPS); there is no
/// trustless-without-Core path, matching spike S0.3.
pub struct PlatformClient {
    sdk: Sdk,
    target: NetworkTarget,
    /// A handle to the same context provider the SDK holds (it is `Clone` over shared
    /// inner state). The trusted provider only serves user data contracts from its
    /// known-contracts cache — it has no SDK-refetch path — so every contract we fetch
    /// must be registered here or the proof verifier rejects writes against it with
    /// "unknown contract".
    context_provider: TrustedHttpContextProvider,
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
    /// The target's registry is not fetched here: a network with no deployment still
    /// connects (identity/balance reads work), and registry operations fail with
    /// [`Error::NotDeployed`] when they need it.
    pub async fn connect(target: NetworkTarget) -> Result<Self> {
        let network = &target.network;
        let dashcore_network = to_dashcore(network);
        let cache_size = NonZeroUsize::new(100).expect("cache size is non-zero");

        let context_provider = match network {
            Network::Devnet { .. } => TrustedHttpContextProvider::new_with_url(
                dashcore_network,
                network.quorum_base_url(),
                cache_size,
            ),
            _ => TrustedHttpContextProvider::new(dashcore_network, None, cache_size),
        }
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
                                network.quorum_base_url()
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

        Ok(Self {
            sdk,
            target,
            context_provider,
        })
    }

    /// Connect to `network` with the registry from its embedded deployment (or the
    /// `FORGE_REGISTRY_CONTRACT_ID` override). For callers without a config layer of their
    /// own — tests and examples.
    pub async fn connect_network(network: Network) -> Result<Self> {
        Self::connect(NetworkTarget::for_network(network)?).await
    }

    /// The network this client targets.
    pub fn network(&self) -> &Network {
        &self.target.network
    }

    /// The resolved network + registry this client was connected with.
    pub fn target(&self) -> &NetworkTarget {
        &self.target
    }

    /// The registry contract id for this network, or [`Error::NotDeployed`] when no registry
    /// is deployed on it (never another network's id).
    pub fn registry_contract_id(&self) -> Result<&str> {
        Ok(self.target.require_registry()?.contract_id.as_str())
    }

    /// Fetch the registry contract for this network (see [`Self::registry_contract_id`]).
    pub async fn fetch_registry(&self) -> Result<LoadedContract> {
        let id = self.registry_contract_id()?.to_string();
        self.fetch_contract(&id).await
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

    /// Fetch a data contract by base58 id.
    pub async fn fetch_contract(&self, contract_id: &str) -> Result<LoadedContract> {
        let id = parse_id(contract_id, "contract id")?;
        let contract =
            retry_transient_read("fetch contract", || DataContract::fetch(&self.sdk, id))
                .await
                .map_err(|e| Error::Platform(format!("fetching contract {contract_id}: {e}")))?
                .ok_or(Error::NotFound)?;
        // Register with the context provider so proof verification of subsequent
        // writes against this contract can resolve it (see field docs).
        self.context_provider.add_known_contract(contract.clone());
        Ok(LoadedContract(Arc::new(contract)))
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
        let doc_id = parse_id(document_id, "document id")?;
        let query = DocumentQuery::new(Arc::clone(&contract.0), document_type)
            .map_err(|e| Error::Platform(format!("building document query: {e}")))?
            .with_document_id(&doc_id);
        let found = retry_transient_read("fetch document", || {
            Document::fetch(&self.sdk, query.clone())
        })
        .await
        .map_err(|e| Error::Platform(format!("fetching document {document_id}: {e}")))?;
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
        let mut query = DocumentQuery::new(Arc::clone(&contract.0), document_type)
            .map_err(|e| Error::Platform(format!("building document query: {e}")))?;

        for f in filters {
            query = query.with_where(WhereClause {
                field: f.field.clone(),
                operator: f.op.to_operator(),
                value: f.value.clone().into_query_value(),
            });
        }
        for o in order {
            query = query.with_order_by(OrderClause {
                field: o.field.clone(),
                ascending: o.ascending,
            });
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
        .map_err(|e| Error::Platform(format!("querying {document_type} documents: {e}")))?;

        Ok(documents
            .into_iter()
            .filter_map(|(_id, maybe_doc)| maybe_doc.as_ref().map(FetchedDocument::from_document))
            .collect())
    }

    /// Query **every** matching document, paginating past Platform's ≤100-row page cap.
    ///
    /// [`PlatformClient::query_documents`] returns a single page (≤100 rows); an
    /// authorization-bearing fold (events, token history) MUST see all rows or a stranger
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
        // Page a descending read in ascending order and reverse it (see
        // [`ascending_equivalent`]): the rs-sdk 4.2 verifier rejects the proof a protocol-13
        // node returns for a descending page that starts after a cursor, so every read past
        // the first 100 rows would fail on testnet.
        let ascending = ascending_equivalent(filters, order);
        let order = ascending.as_deref().unwrap_or(order);
        // See [`tie_probe_allowed`]: when the index ends in `$createdAt`, every page boundary
        // is followed by a read of the boundary timestamp, so same-block rows are not lost.
        let tie_safe = tie_probe_allowed(filters, order);
        // `async move` so the futures own their inputs; returning a future that borrows the
        // closure's parameter would not outlive the call.
        let mut documents = page_to_exhaustion(
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
        )
        .await?;
        if ascending.is_some() {
            documents.reverse();
        }
        Ok(documents)
    }

    // === Token reads (the v1 collaborator ACL, read-only) ==================
    //
    // forge-v1 repositories granted access with two tokens per repo contract (WRITE at
    // position 0, MAINTAIN at position 1). v1 is read-only now: these reads remain so a v1
    // repo's collaborators and token history still render, but nothing mints, freezes or
    // destroys any more. forge-v2 membership is documents (`crate::members`).

    /// The base58 token id for `position` (0 = WRITE, 1 = MAINTAIN) of `contract`,
    /// derived as `hash("dash_token" || contractId || position)` (rs-dpp `calculate_token_id`).
    pub fn token_id(&self, contract: &LoadedContract, position: u16) -> String {
        let raw = calculate_token_id(&contract.0.id().to_buffer(), position);
        Identifier::from(raw).to_string(Encoding::Base58)
    }

    /// The token balances (`identity → amount`, absent = 0) of `token_id_b58` across
    /// `identities` (base58). This is the authoritative on-chain collaborator holding
    /// check — a positive balance means the token is held.
    pub async fn token_balances(
        &self,
        token_id_b58: &str,
        identities: &[String],
    ) -> Result<BTreeMap<String, u64>> {
        if identities.is_empty() {
            return Ok(BTreeMap::new());
        }
        let token_id = parse_id(token_id_b58, "token id")?;
        let identity_ids = identities
            .iter()
            .map(|s| parse_id(s, "identity id"))
            .collect::<Result<Vec<_>>>()?;
        let query = IdentitiesTokenBalancesQuery {
            identity_ids,
            token_id,
        };
        let balances: IdentitiesTokenBalances =
            retry_transient_read("query token balances", || {
                TokenAmount::fetch_many(&self.sdk, query.clone())
            })
            .await
            .map_err(|e| Error::Platform(format!("querying token balances: {e}")))?;
        Ok(balances
            .iter()
            .map(|(id, amt)| (id.to_string(Encoding::Base58), amt.unwrap_or(0)))
            .collect())
    }

    /// The frozen status (`identity → frozen`, absent = false) of `token_id_b58` across
    /// `identities` (base58) — the suspend state included in a collaborator listing.
    pub async fn token_frozen(
        &self,
        token_id_b58: &str,
        identities: &[String],
    ) -> Result<BTreeMap<String, bool>> {
        if identities.is_empty() {
            return Ok(BTreeMap::new());
        }
        let token_id = parse_id(token_id_b58, "token id")?;
        let identity_ids = identities
            .iter()
            .map(|s| parse_id(s, "identity id"))
            .collect::<Result<Vec<_>>>()?;
        let query = IdentitiesTokenInfosQuery {
            identity_ids,
            token_id,
        };
        let infos: IdentitiesTokenInfos = retry_transient_read("query token infos", || {
            IdentityTokenInfo::fetch_many(&self.sdk, query.clone())
        })
        .await
        .map_err(|e| Error::Platform(format!("querying token infos: {e}")))?;
        Ok(infos
            .iter()
            .map(|(id, info)| {
                (
                    id.to_string(Encoding::Base58),
                    info.as_ref()
                        .is_some_and(IdentityTokenInfoV0Accessors::frozen),
                )
            })
            .collect())
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
        let mut query = DocumentQuery::new(Arc::clone(&contract.0), document_type)
            .map_err(|e| Error::Platform(format!("building count query: {e}")))?;
        for f in filters {
            query = query.with_where(WhereClause {
                field: f.field.clone(),
                operator: f.op.to_operator(),
                value: f.value.clone().into_query_value(),
            });
        }
        query = query.with_select(SelectProjection::count_star());
        let count = retry_transient_read("count documents", || {
            DocumentCount::fetch(&self.sdk, query.clone())
        })
        .await
        .map_err(|e| Error::Platform(format!("counting {document_type} documents: {e}")))?;
        Ok(count.map_or(0, |c| c.0))
    }
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
#[derive(Debug, Clone)]
pub struct FetchedDocument {
    /// Base58 document `$id`.
    pub id: String,
    /// Base58 `$ownerId` (the creator).
    pub owner_id: String,
    /// Consensus `$createdAt` in ms, when the document type records it.
    pub created_at: Option<u64>,
    /// Property name → value, in the SDK-free field representation.
    pub fields: BTreeMap<String, FieldValue>,
}

impl FetchedDocument {
    fn from_document(doc: &Document) -> Self {
        let id = doc.id().to_string(Encoding::Base58);
        let owner_id = doc.owner_id().to_string(Encoding::Base58);
        let created_at = doc.created_at();
        let fields = doc
            .properties()
            .iter()
            .filter_map(|(k, v)| FieldValue::from_value(v).map(|fv| (k.clone(), fv)))
            .collect();
        Self {
            id,
            owner_id,
            created_at,
            fields,
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
            // Assigned by Drive on create; not part of the client-built document.
            contract_version: None,
        });

        // For a token-gated create the transition must carry payment info matching the
        // doc type's declared `tokenCost.create` (else consensus rejects with "Required
        // token payment info not set"). Ungated types → `None` (platform fee only).
        let token_payment = token_payment_for(doc_type_ref.document_creation_token_cost());

        let state_transition = BatchTransition::new_document_creation_transition_from_document(
            document,
            doc_type_ref,
            entropy,
            &self.signing_key,
            nonce,
            0,
            token_payment,
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

        // A token-gated delete (chunk/packManifest refund) carries payment info matching
        // the doc type's `tokenCost.delete`; non-deletable/ungated types → `None`.
        let token_payment = token_payment_for(doc_type_ref.document_deletion_token_cost());

        let state_transition = BatchTransition::new_document_deletion_transition_from_document(
            document,
            doc_type_ref,
            &self.signing_key,
            nonce,
            0,
            token_payment,
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

        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            // The affected-state wait, not the strict one. rs-sdk 4.2's strict wait fails any
            // outcome whose proof only authenticates the resulting state, and that is every
            // document of an `indexOnly` type (protocol 14; forge-v2's `star` / `follow`): the
            // entry carries no id, entropy or nonce to bind one transition to it. This accepts
            // execution-proved outcomes too, so nothing weakens for the other types, and for a
            // sign-once write "the proven state holds it" is exactly the success condition — a
            // duplicate of the same signed bytes is rejected on its nonce, not proved again.
            match state_transition
                .broadcast_and_wait_for_affected_state::<StateTransitionProofResult>(sdk, None)
                .await
            {
                Ok(_proof) => return Ok(BroadcastOutcome::Applied),
                Err(e) => match classify_write_error(&e, &prepared.document_type) {
                    WriteFailure::AlreadyLanded => return Ok(BroadcastOutcome::AlreadyExists),
                    WriteFailure::NonceConsumed => return Ok(BroadcastOutcome::NonceConsumed),
                    WriteFailure::Retryable if attempt < MAX_BROADCAST_ATTEMPTS => {
                        // Loop around to re-broadcast the identical signed bytes, after a
                        // backoff so a node whose ban just lapsed is not re-picked at once.
                        let delay = backoff_delay(RETRY_BACKOFF_BASE, attempt);
                        tracing::warn!(
                            attempt,
                            delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                            error = %e,
                            "retryable broadcast failure; re-broadcasting identical signed bytes (same nonce/entropy)"
                        );
                        tokio::time::sleep(delay).await;
                    }
                    WriteFailure::Retryable => return Err(Error::Timeout { retryable: true }),
                    WriteFailure::Fatal(err) => return Err(err),
                },
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
        mut persist: impl FnMut(&PreparedWrite) -> Result<()>,
    ) -> Result<PreparedWrite> {
        // Two retries: a stale protocol version (nothing landed) and a nonce another write by
        // this identity took first (ours can then never land). Each re-prepares with a fresh
        // nonce and entropy, persisting the replacement before it is broadcast.
        for attempt in 0..3 {
            let prepared = self
                .prepare_create(contract, document_type, properties.clone())
                .await?;
            persist(&prepared)?;
            match self.execute(&prepared).await {
                Ok(BroadcastOutcome::NonceConsumed) => {
                    if self
                        .landed(contract, document_type, prepared.document_id(), true)
                        .await?
                    {
                        return Ok(prepared);
                    }
                    tracing::warn!(
                        document_type,
                        "another write by this identity took the nonce; re-preparing"
                    );
                }
                Ok(_) => return Ok(prepared),
                Err(Error::StaleProtocolVersion(reason)) if attempt == 0 => {
                    let version = self.client.refresh_protocol_version().await?;
                    tracing::warn!(%reason, version, "stale protocol version; re-preparing once");
                }
                Err(e) => return Err(e),
            }
        }
        Err(Error::Nonce)
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
                    tracing::warn!(
                        document_type,
                        "another write by this identity took the nonce; re-preparing the delete"
                    );
                }
                _ => return Ok(()),
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
#[derive(Debug, Clone, PartialEq)]
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
            _ => None,
        }
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

    fn into_value(self) -> Value {
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
            Value::I64(n) => FieldValue::Integer(u64::try_from(*n).ok()?),
            Value::U32(n) => FieldValue::Integer(u64::from(*n)),
            Value::I32(n) => FieldValue::Integer(u64::try_from(*n).ok()?),
            Value::U16(n) => FieldValue::Integer(u64::from(*n)),
            Value::U8(n) => FieldValue::Integer(u64::from(*n)),
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
fn parse_id(s: &str, what: &str) -> Result<Identifier> {
    Identifier::from_string(s, Encoding::Base58)
        .map_err(|e| Error::Config(format!("invalid {what} (expected base58): {e}")))
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
/// Limitation: the fix needs the boundary row's `$createdAt`. A proved query returns it
/// for registry types, but not for the history-keeping repo-v1 types (`packManifest`,
/// `event`, `refUpdate`, `issue`, ...), under either SDK version. Their reads keep the
/// protocol-13 gap until they move to forge-v2 contracts on protocol 14.
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
async fn page_to_exhaustion<F, Fut, P, PFut>(
    document_type: &str,
    mut fetch: F,
    mut tie_probe: Option<P>,
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
        if n < PAGE_SIZE as usize {
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

/// Encode raw 32 identifier bytes back to base58 (the form ids are named by everywhere
/// else in the workspace).
pub fn encode_identifier(bytes: [u8; 32]) -> String {
    Identifier::from(bytes).to_string(Encoding::Base58)
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

/// Build the [`TokenPaymentInfo`] a gated document create/delete must carry from the
/// doc type's declared [`DocumentActionTokenCost`], or `None` for an ungated action.
///
/// `maximum_token_cost` is pinned to the contract-declared amount so a later
/// owner-side price change cannot silently overcharge the actor (the SDK's stated
/// rationale for the field); `payment_token_contract_id` / `token_contract_position` /
/// `gas_fees_paid_by` mirror the declaration exactly, which is what consensus checks.
fn token_payment_for(cost: Option<DocumentActionTokenCost>) -> Option<TokenPaymentInfo> {
    cost.map(|c| {
        TokenPaymentInfo::V0(TokenPaymentInfoV0 {
            payment_token_contract_id: c.contract_id,
            token_contract_position: c.token_contract_position,
            minimum_token_cost: None,
            maximum_token_cost: Some(c.token_amount),
            gas_fees_paid_by: c.gas_fees_paid_by,
        })
    })
}

/// Select the identity's on-chain AUTHENTICATION key that (a) the signer can sign with
/// and (b) is a usable ECDSA_SECP256K1 authentication key at HIGH or CRITICAL — the
/// levels document create/delete accept (spike S0.7).
fn select_matching_key(identity: &Identity, signer: &SingleKeySigner) -> Result<IdentityPublicKey> {
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
enum WriteFailure {
    /// The write already landed on-chain (a duplicate re-broadcast: already-present
    /// document, or gRPC AlreadyExists). Idempotent success.
    AlreadyLanded,
    /// The nonce was already used: this write landed earlier, or another write took it.
    NonceConsumed,
    /// A transient failure (stale node, timeout, proof mismatch). Safe to re-broadcast
    /// the same signed bytes — the SDK's authoritative `CanRetry::can_retry()` says so.
    Retryable,
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
/// success — NOT for e.g. `repoListing` (unique `(ownerId, normalizedName)`), where a
/// duplicate is a genuine name collision and must stay fatal.
const CONTENT_ADDRESSED_UNIQUE_DOC_TYPES: [&str; 2] = ["chunk", "packManifest"];

/// Classify a `dash_sdk::Error` from a document broadcast by matching structured enum
/// variants (not lowercased Display substrings). Frozen-token (consensus 40702) and
/// unauthorized (40701) map to distinct, non-retryable crate errors; retryability comes
/// from the SDK's authoritative [`CanRetry::can_retry`]. `document_type` scopes the
/// unique-index idempotency (see [`CONTENT_ADDRESSED_UNIQUE_DOC_TYPES`]).
fn classify_write_error(e: &dash_sdk::Error, document_type: &str) -> WriteFailure {
    // gRPC-level "already exists" — the object is already on-chain.
    if matches!(e, dash_sdk::Error::AlreadyExists(_)) {
        return WriteFailure::AlreadyLanded;
    }

    // The id was derived at a protocol version the network is not on (a 13 -> 14 upgrade
    // under a long-running client). Refused at basic validation: nothing landed.
    if let Some(ConsensusError::BasicError(BasicError::InvalidDocumentTransitionIdError(err))) =
        consensus_error_of(e)
    {
        return WriteFailure::Fatal(Error::StaleProtocolVersion(format!("{err:?}")));
    }

    if let Some(ConsensusError::StateError(state_error)) = consensus_error_of(e) {
        match state_error {
            // The document is already present, or the baked nonce was already consumed
            // by an earlier (identical) broadcast → the intended write has landed.
            StateError::DocumentAlreadyPresentError(_) => return WriteFailure::AlreadyLanded,
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
            // /`patch` `number` already taken, a `repoListing` name collision). Surface it
            // as a distinct, non-retryable error so the optimistic-numbering allocator can
            // catch it and retry with the next number (a name collision stays fatal at the
            // caller). NOT idempotent success — the content differs from what landed.
            StateError::DuplicateUniqueIndexError(err) => {
                return WriteFailure::Fatal(Error::DuplicateUniqueIndex(format!("{err:?}")))
            }
            // 40702: the identity's token account is frozen → write access revoked.
            StateError::IdentityTokenAccountFrozenError(_) => {
                return WriteFailure::Fatal(Error::TokenFrozen)
            }
            // 40701: not authorized for this token action.
            StateError::UnauthorizedTokenActionError(_) => {
                return WriteFailure::Fatal(Error::Unauthorized)
            }
            // 40120 on the writer path: a protocol-14 `ownerRefersTo` gate found no
            // membership document for the writer (forge-v2: never granted, or revoked; or a
            // writer where the type needs a maintainer).
            StateError::ReferencedEntityNotFoundError(err) if err.path() == "$ownerId" => {
                return WriteFailure::Fatal(Error::NotAMember {
                    document_type: document_type.to_string(),
                    detail: format!("40120: {err}"),
                })
            }
            _ => {}
        }
    }

    // The SDK's retry signal (StaleNode / TimeoutReached / Proof) plus node-level transport
    // failures. Re-broadcasting the identical signed bytes is safe for all of them.
    if is_transient_node_error(e) {
        return WriteFailure::Retryable;
    }

    WriteFailure::Fatal(Error::Platform(e.to_string()))
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

/// Run a proof-verified read, retrying transient node failures with exponential backoff.
///
/// Reads are side-effect free, so a retry is always safe. Each attempt is a fresh SDK call
/// and therefore a fresh rotation over the unbanned DAPI nodes. A non-transient error (a
/// verified "not found" is an `Ok(None)`, not an error; a malformed query is not transient)
/// returns immediately.
// The error is the SDK's own (large) type, passed straight through from the SDK calls this
// wraps; every caller maps it to a crate error on the next line.
#[allow(clippy::result_large_err)]
async fn retry_transient_read<T, F, Fut>(
    label: &str,
    op: F,
) -> std::result::Result<T, dash_sdk::Error>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = std::result::Result<T, dash_sdk::Error>>,
{
    retry_with_backoff(label, RETRY_BACKOFF_BASE, is_transient_node_error, op).await
}

/// The loop behind [`retry_transient_read`], generic over the error and the delay so the
/// attempt count and backoff are testable without a network or a real clock.
async fn retry_with_backoff<T, E, F, Fut>(
    label: &str,
    base: std::time::Duration,
    transient: impl Fn(&E) -> bool,
    mut op: F,
) -> std::result::Result<T, E>
where
    E: std::fmt::Display,
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = std::result::Result<T, E>>,
{
    let mut attempt: u32 = 1;
    loop {
        match op().await {
            Ok(v) => return Ok(v),
            Err(e) if attempt < MAX_READ_ATTEMPTS && transient(&e) => {
                let delay = backoff_delay(base, attempt);
                tracing::warn!(
                    op = label,
                    attempt,
                    delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                    error = %e,
                    "transient Platform read failure; backing off and retrying on a fresh node rotation"
                );
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
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
        ascending_equivalent, is_transient_node_error, page_to_exhaustion, retry_with_backoff,
        tie_probe_allowed, FetchedDocument, FieldValue, JournalStore, PushJournal, QueryFilter,
        QueryOrder, SignedTransition, WriteIntent, WriteOp, MAX_PAGES, MAX_READ_ATTEMPTS,
        NONCE_MASK, PAGE_SIZE,
    };
    use crate::error::{Error, Result};
    use std::cell::RefCell;
    use std::collections::BTreeMap;

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
            fields: BTreeMap::new(),
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
}
