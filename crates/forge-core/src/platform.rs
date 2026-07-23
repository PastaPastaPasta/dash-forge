//! Platform client and the idempotent write engine.
//!
//! This is the one module allowed to touch rs-sdk / rs-dpp (style guide §B: "SDK
//! touched only inside `forge-core::platform`"). Everything the rest of the workspace
//! needs is re-exposed here through SDK-free types (`Network`, `String` ids, the opaque
//! [`LoadedContract`] / [`LoadedIdentity`] handles, the journal structs), so binaries
//! never name a Platform type directly.
//!
//! - [`PlatformClient`] — a `dash_sdk::Sdk` wrapper connected to testnet/mainnet with a
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
//!   ("already exists" / consumed nonce) is reported as [`BroadcastOutcome::AlreadyExists`],
//!   never a fresh write — so a killed-mid-push retry cannot double-spend or duplicate.
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
use dash_sdk::dapi_client::CanRetry;
use dash_sdk::dpp::balances::credits::TokenAmount;
use dash_sdk::dpp::consensus::state::state_error::StateError;
use dash_sdk::dpp::consensus::ConsensusError;
use dash_sdk::dpp::dashcore::secp256k1::rand::{rngs::StdRng, Rng, SeedableRng};
use dash_sdk::dpp::dashcore::Network as DashcoreNetwork;
use dash_sdk::dpp::data_contract::accessors::v0::DataContractV0Getters;
use dash_sdk::dpp::data_contract::conversion::json::DataContractJsonConversionMethodsV0;
use dash_sdk::dpp::data_contract::document_type::accessors::DocumentTypeV1Getters;
use dash_sdk::dpp::document::{Document, DocumentV0, DocumentV0Getters, INITIAL_REVISION};
use dash_sdk::dpp::identity::accessors::IdentityGettersV0;
use dash_sdk::dpp::identity::identity_public_key::accessors::v0::IdentityPublicKeyGettersV0;
use dash_sdk::dpp::identity::signer::Signer;
use dash_sdk::dpp::identity::{KeyType, PartialIdentity, Purpose, SecurityLevel};
use dash_sdk::dpp::platform_value::string_encoding::Encoding;
use dash_sdk::dpp::platform_value::Value;
use dash_sdk::dpp::serialization::{PlatformDeserializable, PlatformSerializable};
use dash_sdk::dpp::state_transition::batch_transition::methods::v0::DocumentsBatchTransitionMethodsV0;
use dash_sdk::dpp::state_transition::batch_transition::BatchTransition;
use dash_sdk::dpp::state_transition::data_contract_create_transition::methods::DataContractCreateTransitionMethodsV0;
use dash_sdk::dpp::state_transition::data_contract_create_transition::DataContractCreateTransition;
use dash_sdk::dpp::state_transition::proof_result::StateTransitionProofResult;
use dash_sdk::dpp::state_transition::StateTransition;
use dash_sdk::dpp::tokens::calculate_token_id;
use dash_sdk::dpp::tokens::info::v0::IdentityTokenInfoV0Accessors;
use dash_sdk::dpp::tokens::info::IdentityTokenInfo;
use dash_sdk::dpp::tokens::token_amount_on_contract_token::DocumentActionTokenCost;
use dash_sdk::dpp::tokens::token_payment_info::v0::TokenPaymentInfoV0;
use dash_sdk::dpp::tokens::token_payment_info::TokenPaymentInfo;
use dash_sdk::drive::query::{OrderClause, SelectProjection, WhereClause, WhereOperator};
use dash_sdk::platform::documents::document_query::DocumentQuery;
use dash_sdk::platform::tokens::builders::destroy::TokenDestroyFrozenFundsTransitionBuilder;
use dash_sdk::platform::tokens::builders::freeze::TokenFreezeTransitionBuilder;
use dash_sdk::platform::tokens::builders::mint::TokenMintTransitionBuilder;
use dash_sdk::platform::tokens::builders::unfreeze::TokenUnfreezeTransitionBuilder;
use dash_sdk::platform::tokens::identity_token_balances::IdentitiesTokenBalancesQuery;
use dash_sdk::platform::tokens::token_info::IdentitiesTokenInfosQuery;
use dash_sdk::platform::transition::broadcast::BroadcastStateTransition;
use dash_sdk::platform::{DataContract, Fetch, FetchMany, Identifier, Identity, IdentityPublicKey};
use dash_sdk::{Sdk, SdkBuilder};
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

/// The network a client is bound to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    /// Dash testnet.
    Testnet,
    /// Dash mainnet.
    Mainnet,
    /// A local devnet (dashmate).
    Devnet,
}

impl Network {
    /// The corresponding `dashcore` network used by the SDK's context provider.
    fn to_dashcore(self) -> DashcoreNetwork {
        match self {
            Network::Testnet => DashcoreNetwork::Testnet,
            Network::Mainnet => DashcoreNetwork::Mainnet,
            Network::Devnet => DashcoreNetwork::Devnet,
        }
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
}

impl std::fmt::Debug for LoadedIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoadedIdentity")
            .field("id", &self.id())
            .field("balance", &self.0.balance())
            .finish()
    }
}

/// An rs-sdk-backed Platform client: a connected `Sdk` plus the network it targets.
///
/// Construct with [`PlatformClient::connect`]. Proof verification is always on (the
/// trusted context provider supplies quorum public keys over HTTPS); there is no
/// trustless-without-Core path, matching spike S0.3.
pub struct PlatformClient {
    sdk: Sdk,
    network: Network,
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
            .field("network", &self.network)
            .finish_non_exhaustive()
    }
}

impl PlatformClient {
    /// Connect to `network`, wiring in the trusted HTTP context provider so proofs
    /// verify without a local Core RPC node.
    ///
    /// Only testnet and mainnet have built-in seed address lists; devnet is rejected
    /// here (it needs an explicit address list this constructor does not take).
    // Kept `async` for a stable I/O-shaped contract: `SdkBuilder::build()` connects
    // lazily today, but the connect surface should not churn if that changes.
    #[allow(clippy::unused_async)]
    pub async fn connect(network: Network) -> Result<Self> {
        let dashcore_network = network.to_dashcore();

        let context_provider = TrustedHttpContextProvider::new(
            dashcore_network,
            None,
            NonZeroUsize::new(100).expect("cache size is non-zero"),
        )
        .map_err(|e| Error::Platform(format!("building context provider: {e}")))?;

        let builder = match network {
            Network::Testnet => SdkBuilder::new_testnet(),
            Network::Mainnet => SdkBuilder::new_mainnet(),
            Network::Devnet => {
                return Err(Error::Config(
                    "devnet requires an explicit address list; not supported by connect()".into(),
                ))
            }
        };

        let sdk = builder
            .with_context_provider(context_provider.clone())
            .build()
            .map_err(|e| Error::Platform(format!("building SDK: {e}")))?;

        Ok(Self {
            sdk,
            network,
            context_provider,
        })
    }

    /// The network this client targets.
    pub fn network(&self) -> Network {
        self.network
    }

    /// The underlying SDK handle. Kept crate-visible so [`WriteEngine`] can drive it
    /// without re-exporting SDK types across the crate boundary.
    pub(crate) fn sdk(&self) -> &Sdk {
        &self.sdk
    }

    /// Fetch a data contract by base58 id.
    pub async fn fetch_contract(&self, contract_id: &str) -> Result<LoadedContract> {
        let id = parse_id(contract_id, "contract id")?;
        let contract = DataContract::fetch(&self.sdk, id)
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
        let identity = Identity::fetch(&self.sdk, id)
            .await
            .map_err(|e| Error::Platform(format!("fetching identity {identity_id}: {e}")))?
            .ok_or(Error::NotFound)?;
        Ok(LoadedIdentity(identity))
    }

    /// The identity's spendable credit balance.
    pub async fn get_balance(&self, identity_id: &str) -> Result<u64> {
        Ok(self.fetch_identity(identity_id).await?.balance())
    }

    /// The identity's current nonce (the value contract-create id derivation uses),
    /// fetched without bumping — for diagnostics / orphan-contract recovery.
    pub async fn identity_nonce(&self, identity_id: &str) -> Result<u64> {
        let id = parse_id(identity_id, "identity id")?;
        self.sdk
            .get_identity_nonce(id, false, None)
            .await
            .map_err(|e| Error::Platform(format!("fetching identity nonce: {e}")))
    }

    /// Derive the deterministic contract id `hash(ownerId || nonce)` for a given owner +
    /// identity nonce — the same id [`PlatformClient::contract_create`] produces, exposed
    /// so a create whose follow-on writes failed can locate its (already paid-for) orphan
    /// contract without re-creating it.
    pub fn derive_contract_id(&self, owner_id: &str, nonce: u64) -> Result<String> {
        let owner = parse_id(owner_id, "owner id")?;
        Ok(DataContract::generate_data_contract_id_v0(owner, nonce).to_string(Encoding::Base58))
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
        let doc_id = parse_id(document_id, "document id")?;
        let query = DocumentQuery::new(Arc::clone(&contract.0), document_type)
            .map_err(|e| Error::Platform(format!("building document query: {e}")))?
            .with_document_id(&doc_id);
        let found = Document::fetch(&self.sdk, query)
            .await
            .map_err(|e| Error::Platform(format!("fetching document {document_id}: {e}")))?;
        Ok(found.is_some())
    }

    /// Query documents of `document_type` in `contract`, applying `filters` (AND-ed
    /// where-clauses), `order` (traversal order), an optional `limit` (0 = server
    /// default, ~100) and an optional `start_after` cursor (a base58 document id).
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
        if limit > 0 {
            query = query.with_limit(limit);
        }
        if let Some(after) = start_after {
            let id = parse_id(after, "start_after document id")?;
            query.start = Some(Start::StartAfter(id.to_vec()));
        }

        let documents = Document::fetch_many(&self.sdk, query)
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
        const PAGE: u32 = 100;
        let mut out: Vec<FetchedDocument> = Vec::new();
        let mut start_after: Option<String> = None;
        loop {
            let page = self
                .query_documents(
                    contract,
                    document_type,
                    filters,
                    order,
                    PAGE,
                    start_after.as_deref(),
                )
                .await?;
            let n = page.len();
            if let Some(last) = page.last() {
                start_after = Some(last.id.clone());
            }
            out.extend(page);
            if n < PAGE as usize {
                break;
            }
        }
        Ok(out)
    }

    /// Create a data contract (WITH tokens) from a JSON template, signing with `key`
    /// (must be a **CRITICAL** AUTHENTICATION key — token-bearing contracts are rejected
    /// for HIGH, spike S0.7).
    ///
    /// The contract id is derived from `owner` + a freshly bumped identity nonce
    /// (`hash(ownerId || nonce)`); the same nonce is baked into the create transition, so
    /// the id is deterministic and known before broadcast. `template` must contain
    /// `documentSchemas` and (optionally) `tokens` / `keywords` / `description`; any `id`,
    /// `ownerId` or `version` in it are ignored and re-synthesized here.
    ///
    /// ## Native rs-dpp accepts tokens from JSON
    ///
    /// Unlike the wasm `DataContract` constructor (which needs `TokenConfiguration`
    /// instances and drove the S0.7 `DataContract.fromJSON` workaround), native
    /// [`DataContract::from_json`] deserializes a plain-JSON `tokens` map directly — the
    /// full repo-v1 template (2 tokens + 15 doc types) round-trips with no per-token
    /// object construction.
    ///
    /// Returns `(contractId, cost_credits)` where `cost_credits` is the identity balance
    /// delta across the broadcast (the measured DataContractCreate cost).
    pub async fn contract_create(
        &self,
        template: &serde_json::Value,
        owner: &LoadedIdentity,
        key: &IdentityKey,
    ) -> Result<(String, u64)> {
        let signer = signer_from_key(key)?;
        // Token-bearing contract create requires a CRITICAL auth key (S0.7).
        let signing_key = select_key_at_level(&owner.0, &signer, SecurityLevel::CRITICAL)?;
        let owner_id = owner.0.id();

        // One nonce fetch, bumped, reused for both id-derivation and the transition —
        // `new_from_data_contract` re-derives the id from (owner, nonce) internally, so
        // any double-bump would desync the id from the signed nonce.
        let nonce = self
            .sdk
            .get_identity_nonce(owner_id, true, None)
            .await
            .map_err(|e| Error::Platform(format!("fetching identity nonce: {e}")))?;
        let contract_id = DataContract::generate_data_contract_id_v0(owner_id, nonce);

        let schemas = template
            .get("documentSchemas")
            .ok_or_else(|| Error::Config("contract template missing 'documentSchemas'".into()))?;
        let mut full = serde_json::json!({
            "$formatVersion": "1",
            "id": contract_id.to_string(Encoding::Base58),
            "ownerId": owner_id.to_string(Encoding::Base58),
            "version": 1,
            "documentSchemas": schemas,
        });
        let obj = full.as_object_mut().expect("json object");
        for k in ["tokens", "keywords", "description", "groups"] {
            if let Some(v) = template.get(k) {
                obj.insert(k.to_string(), v.clone());
            }
        }

        let contract = DataContract::from_json(full, true, self.sdk.version())
            .map_err(|e| Error::Platform(format!("deserializing data contract JSON: {e}")))?;

        let key_id = signing_key.id();
        let partial_identity = PartialIdentity {
            id: owner_id,
            loaded_public_keys: BTreeMap::from([(key_id, signing_key)]),
            balance: None,
            revision: None,
            not_found_public_keys: std::collections::BTreeSet::new(),
        };

        let state_transition = DataContractCreateTransition::new_from_data_contract(
            contract,
            nonce,
            &partial_identity,
            key_id,
            &signer,
            self.sdk.version(),
            None,
        )
        .await
        .map_err(|e| Error::Platform(format!("signing contract-create transition: {e}")))?;

        let balance_before = owner.balance();
        // The contract id is deterministic (`hash(ownerId || nonce)`) and the nonce is
        // baked into the signed transition, so a broadcast that errors *ambiguously* — a
        // transient reset that makes the SDK re-broadcast and hit its own cached tx
        // ("AlreadyExists"), a wait timeout after the tx landed — has NOT necessarily
        // failed. Retrying with a fresh nonce would mint (and pay ~1 DASH for) a SECOND
        // contract, orphaning the first. So on any broadcast error, verify by fetching the
        // derived id before surfacing an error: if the contract landed, this is success.
        match state_transition
            .broadcast_and_wait::<StateTransitionProofResult>(&self.sdk, None)
            .await
        {
            Ok(result) => {
                // Register the freshly created contract with the context provider so
                // subsequent proof-verified writes/reads against it resolve (see field
                // docs on `context_provider`).
                if let StateTransitionProofResult::VerifiedDataContract(created) = &result {
                    self.context_provider.add_known_contract(created.clone());
                }
            }
            Err(e) => match DataContract::fetch(&self.sdk, contract_id).await {
                Ok(Some(existing)) => {
                    // The create actually landed — idempotent success, not a double-pay.
                    self.context_provider.add_known_contract(existing);
                    tracing::warn!(
                        error = %e,
                        contract_id = %contract_id.to_string(Encoding::Base58),
                        "contract-create broadcast errored but the contract is on-chain; treating as success (idempotent — no second create)"
                    );
                }
                _ => {
                    return Err(Error::Platform(format!(
                        "broadcasting contract create: {e}"
                    )))
                }
            },
        }

        let balance_after = self
            .fetch_identity(&owner_id.to_string(Encoding::Base58))
            .await?
            .balance();
        let cost = balance_before.saturating_sub(balance_after);

        Ok((contract_id.to_string(Encoding::Base58), cost))
    }

    // === Token administration (collaborator ACL) =========================
    //
    // Token mint/freeze/unfreeze/destroy are the on-chain ACL: minting the WRITE
    // (position 0) or MAINTAIN (position 1) token to an identity grants it, freezing
    // suspends it (a frozen identity cannot spend the token → every gated create/delete
    // fails at consensus, S0.7), and destroying the frozen balance revokes it.
    //
    // All four require a **CRITICAL** AUTHENTICATION key (S0.7: HIGH is rejected for
    // token admin). They are signed by the token authority — for a solo-owner repo the
    // `ContractOwner`, i.e. the repo owner identity, which holds the mint/freeze/destroy
    // authority via the solo-owner token rules.
    //
    // The **keepsHistory mint() return-value bug** (S0.7): on a history-keeping token the
    // wasm SDK's result parser throws `'platformVersion' string value ''` *after* the
    // transition already landed at consensus. The native rs-sdk `token_*` helpers here
    // parse the `VerifiedTokenActionWithDocument` proof correctly, so the bug does not
    // fire — but [`finish_token_op`] still treats that exact string as "landed; verify via
    // query" defensively, and the [`crate::tokens`] service always re-reads the balance /
    // frozen status after every op rather than trusting the return value.

    /// The base58 token id for `position` (0 = WRITE, 1 = MAINTAIN) of `contract`,
    /// derived as `hash("dash_token" || contractId || position)` (rs-dpp `calculate_token_id`).
    pub fn token_id(&self, contract: &LoadedContract, position: u16) -> String {
        let raw = calculate_token_id(&contract.0.id().to_buffer(), position);
        Identifier::from(raw).to_string(Encoding::Base58)
    }

    /// Mint `amount` of the token at `position` to `recipient` (base58) — a **grant**.
    /// Signs with the owner's CRITICAL key. Verify success via a balance query (the mint
    /// return value is not trusted — see the module note).
    pub async fn token_mint(
        &self,
        contract: &LoadedContract,
        owner: &LoadedIdentity,
        key: &IdentityKey,
        position: u16,
        amount: u64,
        recipient: &str,
    ) -> Result<()> {
        let signer = signer_from_key(key)?;
        let signing_key = select_key_at_level(&owner.0, &signer, SecurityLevel::CRITICAL)?;
        let recipient_id = parse_id(recipient, "recipient id")?;
        let builder = TokenMintTransitionBuilder::new(
            Arc::clone(&contract.0),
            position,
            owner.0.id(),
            amount,
        )
        .issued_to_identity_id(recipient_id)
        .with_public_note("dash-forge grant".to_string());
        let outcome = self
            .sdk
            .token_mint(builder, &signing_key, &signer)
            .await
            .map(|_| ());
        finish_token_op("mint", outcome)
    }

    /// Freeze the token at `position` for `target` (base58) — a **suspend**. A frozen
    /// identity keeps its balance but cannot spend it, so every gated action fails.
    pub async fn token_freeze(
        &self,
        contract: &LoadedContract,
        owner: &LoadedIdentity,
        key: &IdentityKey,
        position: u16,
        target: &str,
    ) -> Result<()> {
        let signer = signer_from_key(key)?;
        let signing_key = select_key_at_level(&owner.0, &signer, SecurityLevel::CRITICAL)?;
        let target_id = parse_id(target, "target id")?;
        let builder = TokenFreezeTransitionBuilder::new(
            Arc::clone(&contract.0),
            position,
            owner.0.id(),
            target_id,
        )
        .with_public_note("dash-forge suspend".to_string());
        let outcome = self
            .sdk
            .token_freeze(builder, &signing_key, &signer)
            .await
            .map(|_| ());
        finish_token_op("freeze", outcome)
    }

    /// Unfreeze the token at `position` for `target` (base58) — lift a suspension.
    pub async fn token_unfreeze(
        &self,
        contract: &LoadedContract,
        owner: &LoadedIdentity,
        key: &IdentityKey,
        position: u16,
        target: &str,
    ) -> Result<()> {
        let signer = signer_from_key(key)?;
        let signing_key = select_key_at_level(&owner.0, &signer, SecurityLevel::CRITICAL)?;
        let target_id = parse_id(target, "target id")?;
        let builder = TokenUnfreezeTransitionBuilder::new(
            Arc::clone(&contract.0),
            position,
            owner.0.id(),
            target_id,
        )
        .with_public_note("dash-forge unsuspend".to_string());
        let outcome = self
            .sdk
            .token_unfreeze_identity(builder, &signing_key, &signer)
            .await
            .map(|_| ());
        finish_token_op("unfreeze", outcome)
    }

    /// Destroy the **frozen** balance of the token at `position` held by `target` (base58)
    /// — a **revoke**. The identity must already be frozen; its balance is zeroed and
    /// removed from supply, so it is no longer an on-chain collaborator.
    pub async fn token_destroy_frozen(
        &self,
        contract: &LoadedContract,
        owner: &LoadedIdentity,
        key: &IdentityKey,
        position: u16,
        target: &str,
    ) -> Result<()> {
        let signer = signer_from_key(key)?;
        let signing_key = select_key_at_level(&owner.0, &signer, SecurityLevel::CRITICAL)?;
        let target_id = parse_id(target, "target id")?;
        let builder = TokenDestroyFrozenFundsTransitionBuilder::new(
            Arc::clone(&contract.0),
            position,
            owner.0.id(),
            target_id,
        )
        .with_public_note("dash-forge revoke".to_string());
        let outcome = self
            .sdk
            .token_destroy_frozen_funds(builder, &signing_key, &signer)
            .await
            .map(|_| ());
        finish_token_op("destroy_frozen", outcome)
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
        let balances: IdentitiesTokenBalances = TokenAmount::fetch_many(&self.sdk, query)
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
        let infos: IdentitiesTokenInfos = IdentityTokenInfo::fetch_many(&self.sdk, query)
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
        let count = DocumentCount::fetch(&self.sdk, query)
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

        let mut rng = StdRng::from_entropy();
        let entropy: [u8; 32] = rng.gen();

        // The create transition takes the document's id verbatim (entropy is stored
        // alongside), so compute and set it from the same entropy we bake in — the id
        // is then known up front and stays consistent with the signed bytes.
        let document_id = Document::generate_document_id_v0(
            &contract.id(),
            &self.owner_id,
            document_type,
            entropy.as_slice(),
        );

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
        });

        let doc_type_ref = contract
            .document_type_for_name(document_type)
            .map_err(|e| Error::Config(format!("unknown document type '{document_type}': {e}")))?;

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
            self.client.sdk().version(),
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
        let contract = &contract.0;
        let doc_id = parse_id(document_id, "document id")?;

        let document = Document::V0(DocumentV0 {
            id: doc_id,
            owner_id: self.owner_id,
            properties: BTreeMap::new(),
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
    /// Returns [`BroadcastOutcome::Applied`] on a fresh landing, or
    /// [`BroadcastOutcome::AlreadyExists`] when the write had already landed (a consumed
    /// nonce / already-present document / gRPC AlreadyExists) — the idempotency guarantee
    /// that a killed-and-retried push does not double-write.
    pub async fn execute(&self, prepared: &PreparedWrite) -> Result<BroadcastOutcome> {
        // Deserialize the SAME signed bytes we captured at prepare time. Every broadcast
        // in the loop below re-sends these exact bytes (identical nonce, entropy and
        // signature), so a retry can only ever make the write land once.
        let state_transition = StateTransition::deserialize_from_bytes(&prepared.signed.bytes)
            .map_err(|e| Error::Platform(format!("deserializing signed transition: {e}")))?;
        let sdk = self.client.sdk();

        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            match state_transition
                .broadcast_and_wait::<StateTransitionProofResult>(sdk, None)
                .await
            {
                Ok(_proof) => return Ok(BroadcastOutcome::Applied),
                Err(e) => match classify_write_error(&e, &prepared.document_type) {
                    WriteFailure::AlreadyLanded => return Ok(BroadcastOutcome::AlreadyExists),
                    WriteFailure::Retryable if attempt < MAX_BROADCAST_ATTEMPTS => {
                        // Loop around to re-broadcast the identical signed bytes.
                        tracing::warn!(
                            attempt,
                            error = %e,
                            "retryable broadcast failure; re-broadcasting identical signed bytes (same nonce/entropy)"
                        );
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
        let prepared = self
            .prepare_create(contract, document_type, properties)
            .await?;
        self.execute(&prepared).await?;
        Ok(prepared.document_id)
    }

    /// Convenience: prepare + execute a document delete.
    pub async fn delete_document(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
    ) -> Result<()> {
        let prepared = self
            .prepare_delete(contract, document_type, document_id)
            .await?;
        self.execute(&prepared).await?;
        Ok(())
    }
}

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
            Value::Array(items) => {
                // A byteArray that came back as an array of U8 → repack to bytes.
                let mut bytes = Vec::with_capacity(items.len());
                for item in items {
                    match item {
                        Value::U8(b) => bytes.push(*b),
                        _ => return None,
                    }
                }
                FieldValue::Bytes(bytes)
            }
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

/// Select the identity's on-chain ECDSA_SECP256K1 AUTHENTICATION key at exactly
/// `level` that the signer can sign with — used for token-bearing contract create,
/// which requires CRITICAL (spike S0.7).
fn select_key_at_level(
    identity: &Identity,
    signer: &SingleKeySigner,
    level: SecurityLevel,
) -> Result<IdentityPublicKey> {
    for public_key in identity.public_keys().values() {
        if public_key.is_disabled() || !signer.can_sign_with(public_key) {
            continue;
        }
        if public_key.purpose() == Purpose::AUTHENTICATION
            && public_key.key_type() == KeyType::ECDSA_SECP256K1
            && public_key.security_level() == level
        {
            return Ok(public_key.clone());
        }
    }
    Err(Error::Config(format!(
        "no usable {level:?} AUTHENTICATION key on the identity matches the keystore key"
    )))
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
    /// The write already landed on-chain (a duplicate re-broadcast: consumed nonce,
    /// already-present document, or gRPC AlreadyExists). Idempotent success.
    AlreadyLanded,
    /// A transient failure (stale node, timeout, proof mismatch). Safe to re-broadcast
    /// the same signed bytes — the SDK's authoritative `CanRetry::can_retry()` says so.
    Retryable,
    /// A terminal failure surfaced as a crate error.
    Fatal(Error),
}

/// The exact wasm-SDK keepsHistory result-parse error (S0.7). Native rs-sdk parses the
/// token-action proof correctly, so this should never fire on this path; matched as a
/// defensive net so that, if it ever did, a transition that already landed at consensus
/// is treated as success (the [`crate::tokens`] service re-verifies via query regardless).
const TOKEN_HISTORY_PARSE_BUG: &str = "'platformVersion' string value ''";

/// Finish a token admin op: map `Ok` to success, translate a frozen / unauthorized
/// consensus rejection into the typed crate error, swallow the keepsHistory parse bug as
/// "landed", and surface anything else as a platform error. Token ops are NOT blindly
/// re-broadcast (a second mint would double-mint) — ambiguity is resolved by the caller's
/// post-op query, not a retry.
fn finish_token_op(label: &str, outcome: std::result::Result<(), dash_sdk::Error>) -> Result<()> {
    match outcome {
        Ok(()) => Ok(()),
        Err(e) => {
            if e.to_string().contains(TOKEN_HISTORY_PARSE_BUG) {
                tracing::warn!(
                    op = label,
                    error = %e,
                    "token op landed at consensus; SDK result-parse hit the keepsHistory bug (verify via query)"
                );
                return Ok(());
            }
            if let Some(ConsensusError::StateError(state_error)) = consensus_error_of(&e) {
                match state_error {
                    StateError::IdentityTokenAccountFrozenError(_) => {
                        return Err(Error::TokenFrozen)
                    }
                    StateError::UnauthorizedTokenActionError(_) => return Err(Error::Unauthorized),
                    _ => {}
                }
            }
            Err(Error::Platform(format!("token {label} failed: {e}")))
        }
    }
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

    if let Some(ConsensusError::StateError(state_error)) = consensus_error_of(e) {
        match state_error {
            // The document is already present, or the baked nonce was already consumed
            // by an earlier (identical) broadcast → the intended write has landed.
            StateError::DocumentAlreadyPresentError(_)
            | StateError::InvalidIdentityNonceError(_) => return WriteFailure::AlreadyLanded,
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
            _ => {}
        }
    }

    // Authoritative retry signal (StaleNode / TimeoutReached / Proof).
    if e.can_retry() {
        return WriteFailure::Retryable;
    }

    WriteFailure::Fatal(Error::Platform(e.to_string()))
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
        JournalStore, Network, PushJournal, SignedTransition, WriteIntent, WriteOp, NONCE_MASK,
    };
    use crate::error::Result;
    use std::cell::RefCell;

    #[test]
    fn nonce_mask_is_low_40_bits() {
        assert_eq!(NONCE_MASK, 0xFF_FFFF_FFFF);
        // High bits above bit 40 are stripped; the low 40 survive.
        let raw = (0xABCD_u64 << 40) | 0x12_3456_789A;
        assert_eq!(raw & NONCE_MASK, 0x12_3456_789A);
    }

    #[test]
    fn network_round_trips_through_json() {
        for n in [Network::Testnet, Network::Mainnet, Network::Devnet] {
            let s = serde_json::to_string(&n).unwrap();
            let back: Network = serde_json::from_str(&s).unwrap();
            assert_eq!(n, back);
        }
        assert_eq!(
            serde_json::to_string(&Network::Testnet).unwrap(),
            "\"testnet\""
        );
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
}
