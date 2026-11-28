//! An organization's document writes (docs/design/organizations.md §9): unsigned transitions
//! signed by the group key's id with an empty signature, their decoding for review, attaching
//! the combined threshold signature, and the lookups review needs.

use std::collections::BTreeMap;
use std::sync::Arc;

use dash_sdk::dpp::address_funds::AddressWitness;
use dash_sdk::dpp::data_contract::accessors::v0::DataContractV0Getters;
use dash_sdk::dpp::data_contract::document_type::DocumentTypeRef;
use dash_sdk::dpp::document::{Document, DocumentV0Setters};
use dash_sdk::dpp::identity::accessors::IdentityGettersV0;
use dash_sdk::dpp::identity::identity_public_key::accessors::v0::IdentityPublicKeyGettersV0;
use dash_sdk::dpp::identity::signer::Signer;
use dash_sdk::dpp::identity::{KeyType, Purpose, SecurityLevel};
use dash_sdk::dpp::platform_value::string_encoding::Encoding;
use dash_sdk::dpp::platform_value::BinaryData;
use dash_sdk::dpp::platform_value::Value;
use dash_sdk::dpp::serialization::{
    PlatformDeserializableUntrusted, PlatformSerializable, Signable,
};
use dash_sdk::dpp::state_transition::batch_transition::accessors::DocumentsBatchTransitionAccessorsV0;
use dash_sdk::dpp::state_transition::batch_transition::batched_transition::document_transition::{
    DocumentTransition, DocumentTransitionV0Methods,
};
use dash_sdk::dpp::state_transition::batch_transition::batched_transition::BatchedTransitionRef;
use dash_sdk::dpp::state_transition::batch_transition::methods::v0::DocumentsBatchTransitionMethodsV0;
use dash_sdk::dpp::state_transition::batch_transition::methods::StateTransitionCreationOptions;
use dash_sdk::dpp::state_transition::batch_transition::BatchTransition;
use dash_sdk::dpp::state_transition::StateTransition;
use dash_sdk::dpp::state_transition::StateTransitionSigningOptions;
use dash_sdk::dpp::version::PlatformVersion;
use dash_sdk::dpp::ProtocolError;
use dash_sdk::platform::types::identity::PublicKeyHash;
use dash_sdk::platform::{DataContract, Fetch, Identifier, Identity, IdentityPublicKey};
use serde_json::{json, Map, Value as Json};
use sha2::{Digest, Sha256};

use super::{
    client_document, encode_identifier, parse_id, retry_transient_read, FieldValue, LoadedContract,
    LoadedIdentity, PlatformClient, SignedTransition, NONCE_MASK,
};
use crate::error::{Error, Result};

/// Document transitions with base version 1, as evo-sdk builds them, so forge-web, dg and
/// multisig.dashhq.org's rebuild agree byte for byte (version 2 only adds action fees, which no
/// Forge document charges).
const BASE_V1: StateTransitionCreationOptions = StateTransitionCreationOptions {
    signing_options: StateTransitionSigningOptions {
        allow_signing_with_any_security_level: false,
        allow_signing_with_any_purpose: false,
    },
    batch_feature_version: None,
    method_feature_version: None,
    base_feature_version: Some(1),
    action_fee_agreement: None,
    contest_fund: None,
};

/// Signs nothing: building a transition through it leaves the signature empty and sets the
/// signing key's id, which is exactly the unsigned form a proposal carries.
#[derive(Debug)]
struct Unsigned;

#[async_trait::async_trait]
impl Signer<IdentityPublicKey> for Unsigned {
    async fn sign(
        &self,
        _: &IdentityPublicKey,
        _: &[u8],
    ) -> std::result::Result<BinaryData, ProtocolError> {
        Ok(BinaryData::default())
    }

    async fn sign_create_witness(
        &self,
        _: &IdentityPublicKey,
        _: &[u8],
    ) -> std::result::Result<AddressWitness, ProtocolError> {
        Err(ProtocolError::Generic(
            "an organization signs no address witness".into(),
        ))
    }

    fn can_sign_with(&self, _: &IdentityPublicKey) -> bool {
        true
    }
}

/// One unsigned organization write, ready to become a proposal.
#[derive(Debug, Clone)]
pub struct UnsignedWrite {
    /// The serialized transition: signature key id set, signature empty.
    pub unsigned: Vec<u8>,
    /// Its signable bytes (what the group signs).
    pub signable: Vec<u8>,
    pub document_id: String,
    pub document_type: String,
    pub nonce: u64,
    /// The `dti` `document` intent describing the same write (byte values as hex strings).
    pub intent: Json,
}

/// Builds an organization identity's unsigned document writes with its group key.
pub struct OrgWriter<'a> {
    client: &'a PlatformClient,
    owner: Identifier,
    key: IdentityPublicKey,
}

impl<'a> OrgWriter<'a> {
    /// Bind to `identity`'s key `key_id`, which must be an enabled BLS12-381 AUTHENTICATION
    /// key at HIGH (the group key Forge signs documents with).
    pub fn new(client: &'a PlatformClient, identity: &LoadedIdentity, key_id: u32) -> Result<Self> {
        let key = org_key(identity, key_id)?;
        Ok(Self {
            client,
            owner: identity.0.id(),
            key,
        })
    }

    /// The identity's identity-contract nonce for `contract_id` (proved).
    pub async fn current_nonce(&self, contract_id: &str) -> Result<NonceState> {
        self.client
            .proved_contract_nonce(&encode_identifier(self.owner.to_buffer()), contract_id)
            .await
    }

    fn build(&self, contract: &LoadedContract) -> Build<'_> {
        Build {
            dc: self.client.current(contract),
            owner: self.owner,
            key: &self.key,
            version: self.client.sdk().version(),
        }
    }

    /// An unsigned create of a `document_type` document with `properties`, at `nonce`.
    pub async fn create(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        properties: BTreeMap<String, FieldValue>,
        nonce: u64,
    ) -> Result<UnsignedWrite> {
        let mut entropy = [0u8; 32];
        getrandom::getrandom(&mut entropy).map_err(|e| Error::Platform(e.to_string()))?;
        self.build(contract)
            .create(document_type, properties, nonce, entropy)
            .await
    }

    /// An unsigned delete of the stored `document_type` document `document_id`, at `nonce`.
    pub async fn delete(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
        nonce: u64,
    ) -> Result<UnsignedWrite> {
        self.build(contract)
            .delete(document_type, document_id, nonce)
            .await
    }

    /// An unsigned replace of the stored `document_type` document `document_id`, which is at
    /// `stored_revision`, with `properties` (the whole new property set), at `nonce`.
    pub async fn replace(
        &self,
        contract: &LoadedContract,
        document_type: &str,
        document_id: &str,
        stored_revision: u64,
        properties: BTreeMap<String, FieldValue>,
        nonce: u64,
    ) -> Result<UnsignedWrite> {
        self.build(contract)
            .replace(
                document_type,
                document_id,
                stored_revision,
                properties,
                nonce,
            )
            .await
    }
}

/// Building one unsigned write: no network involved.
struct Build<'a> {
    dc: Arc<DataContract>,
    owner: Identifier,
    key: &'a IdentityPublicKey,
    version: &'a PlatformVersion,
}

impl Build<'_> {
    fn doc_type(&self, name: &str) -> Result<DocumentTypeRef<'_>> {
        self.dc
            .document_type_for_name(name)
            .map_err(|e| Error::Config(format!("unknown document type '{name}': {e}")))
    }

    async fn create(
        &self,
        document_type: &str,
        properties: BTreeMap<String, FieldValue>,
        nonce: u64,
        entropy: [u8; 32],
    ) -> Result<UnsignedWrite> {
        let doc_type = self.doc_type(document_type)?;
        let id = Document::generate_document_id(
            &self.dc.id(),
            &self.owner,
            document_type,
            &entropy,
            nonce,
            self.version,
        )
        .map_err(|e| Error::Platform(format!("deriving the document id: {e}")))?;
        let intent_doc = json!({
            "action": "create",
            "documentType": document_type,
            "properties": properties_json(&properties),
            "entropy": hex::encode(entropy),
        });
        let document = client_document(id, self.owner, plain_values(properties), None);
        let st = BatchTransition::new_document_creation_transition_from_document(
            document,
            doc_type,
            entropy,
            self.key,
            nonce,
            0,
            None,
            &Unsigned,
            self.version,
            Some(BASE_V1),
        )
        .await
        .map_err(|e| Error::Platform(format!("building the create transition: {e}")))?;
        self.finish(&st, document_type, id, nonce, intent_doc)
    }

    async fn delete(
        &self,
        document_type: &str,
        document_id: &str,
        nonce: u64,
    ) -> Result<UnsignedWrite> {
        let doc_type = self.doc_type(document_type)?;
        let id = parse_id(document_id, "document id")?;
        let document = client_document(id, self.owner, BTreeMap::new(), None);
        let st = BatchTransition::new_document_deletion_transition_from_document(
            document,
            doc_type,
            self.key,
            nonce,
            0,
            None,
            &Unsigned,
            self.version,
            Some(BASE_V1),
        )
        .await
        .map_err(|e| Error::Platform(format!("building the delete transition: {e}")))?;
        let intent_doc = json!({
            "action": "delete",
            "documentType": document_type,
            "id": document_id,
        });
        self.finish(&st, document_type, id, nonce, intent_doc)
    }

    async fn replace(
        &self,
        document_type: &str,
        document_id: &str,
        stored_revision: u64,
        properties: BTreeMap<String, FieldValue>,
        nonce: u64,
    ) -> Result<UnsignedWrite> {
        let doc_type = self.doc_type(document_type)?;
        let id = parse_id(document_id, "document id")?;
        let next = stored_revision
            .checked_add(1)
            .ok_or_else(|| Error::Platform("document revision overflow".into()))?;
        let intent_doc = json!({
            "action": "replace",
            "documentType": document_type,
            "properties": properties_json(&properties),
            "id": document_id,
            "revision": stored_revision.to_string(),
        });
        let mut document = client_document(id, self.owner, plain_values(properties), None);
        document.set_revision(Some(next));
        let st = BatchTransition::new_document_replacement_transition_from_document(
            document,
            doc_type,
            self.key,
            nonce,
            0,
            None,
            &Unsigned,
            self.version,
            Some(BASE_V1),
        )
        .await
        .map_err(|e| Error::Platform(format!("building the replace transition: {e}")))?;
        self.finish(&st, document_type, id, nonce, intent_doc)
    }

    fn finish(
        &self,
        st: &StateTransition,
        document_type: &str,
        id: Identifier,
        nonce: u64,
        intent_doc: Json,
    ) -> Result<UnsignedWrite> {
        let unsigned = st
            .serialize_to_bytes()
            .map_err(|e| Error::Platform(format!("serializing the transition: {e}")))?;
        let signable = st
            .signable_bytes()
            .map_err(|e| Error::Platform(format!("the transition's signable bytes: {e}")))?;
        let mut intent = json!({
            "type": "document",
            "userFeeIncrease": 0,
            "ownerId": encode_identifier(self.owner.to_buffer()),
            "contractId": self.dc.id().to_string(Encoding::Base58),
            "identityContractNonce": nonce.to_string(),
            "signer": { "keyId": self.key.id() },
        });
        intent["document"] = intent_doc;
        Ok(UnsignedWrite {
            unsigned,
            signable,
            document_id: id.to_string(Encoding::Base58),
            document_type: document_type.to_string(),
            nonce,
            intent,
        })
    }
}

fn org_key(identity: &LoadedIdentity, key_id: u32) -> Result<IdentityPublicKey> {
    let key = identity
        .0
        .public_keys()
        .get(&key_id)
        .ok_or_else(|| Error::Config(format!("the organization has no key {key_id}")))?;
    if key.key_type() != KeyType::BLS12_381
        || key.purpose() != Purpose::AUTHENTICATION
        || key.security_level() != SecurityLevel::HIGH
    {
        return Err(Error::Config(format!(
            "key {key_id} of the organization is not its HIGH group key"
        )));
    }
    if key.is_disabled() {
        return Err(Error::Config(format!(
            "the organization's key {key_id} is disabled"
        )));
    }
    Ok(key.clone())
}

/// Document properties as an organization's transition carries them (§9), as evo-sdk encodes
/// forge-web's values: identifiers and other byte values are plain byte arrays and integers are
/// 64-bit, so both clients build the same bytes for the same write.
fn plain_values(properties: BTreeMap<String, FieldValue>) -> BTreeMap<String, Value> {
    fn one(v: FieldValue) -> Value {
        match v {
            FieldValue::Identifier(b) | FieldValue::Bytes32(b) => Value::Bytes(b.to_vec()),
            FieldValue::Integer(n) | FieldValue::Uint64(n) => Value::U64(n),
            FieldValue::Signed(n) => Value::I64(n),
            FieldValue::Object(m) => Value::Map(
                m.into_iter()
                    .map(|(k, v)| (Value::Text(k), one(v)))
                    .collect(),
            ),
            FieldValue::List(items) => Value::Array(items.into_iter().map(one).collect()),
            other => other.into_value(),
        }
    }
    properties.into_iter().map(|(k, v)| (k, one(v))).collect()
}

/// `FieldValue`s as intent JSON: identifiers and bytes as hex strings (§9).
pub fn properties_json(properties: &BTreeMap<String, FieldValue>) -> Json {
    fn one(v: &FieldValue) -> Json {
        match v {
            FieldValue::Bytes(b) => Json::String(hex::encode(b)),
            FieldValue::Bytes32(b) | FieldValue::Identifier(b) => Json::String(hex::encode(b)),
            FieldValue::Integer(n) | FieldValue::Uint64(n) => json!(n),
            FieldValue::Signed(n) => json!(n),
            FieldValue::Text(s) => Json::String(s.clone()),
            FieldValue::Bool(b) => Json::Bool(*b),
            FieldValue::Object(m) => Json::Object(
                m.iter()
                    .map(|(k, v)| (k.clone(), one(v)))
                    .collect::<Map<_, _>>(),
            ),
            FieldValue::List(items) => Json::Array(items.iter().map(one).collect()),
        }
    }
    Json::Object(
        properties
            .iter()
            .map(|(k, v)| (k.clone(), one(v)))
            .collect(),
    )
}

/// What a decoded unsigned transition writes.
#[derive(Debug, Clone)]
pub struct DecodedWrite {
    /// Whether it is a documents batch at all.
    pub batch: bool,
    /// Whether the bytes re-encode to themselves (nothing appended, nothing non-canonical).
    pub canonical: bool,
    pub owner_id: String,
    pub signature_key_id: Option<u32>,
    pub user_fee_increase: u16,
    pub signature_empty: bool,
    /// Document transitions in the batch (token transitions count as not documents).
    pub document_transitions: usize,
    pub transitions: usize,
    pub contract_id: String,
    pub document_type: String,
    /// `create`, `replace`, `delete`, or the name of another document action.
    pub action: String,
    pub document_id: String,
    pub nonce: u64,
    pub revision: Option<u64>,
    pub properties: BTreeMap<String, FieldValue>,
    pub signable: Vec<u8>,
}

/// Decode a proposal's `unsigned` bytes.
pub fn decode_unsigned(bytes: &[u8]) -> Result<DecodedWrite> {
    let st = StateTransition::deserialize_from_bytes_untrusted(bytes)
        .map_err(|e| Error::InvalidInput(format!("the transition does not decode: {e}")))?;
    let signable = st
        .signable_bytes()
        .map_err(|e| Error::InvalidInput(format!("the transition's signable bytes: {e}")))?;
    let canonical = st
        .serialize_to_bytes()
        .is_ok_and(|again| again.as_slice() == bytes);
    let mut out = DecodedWrite {
        batch: false,
        canonical,
        owner_id: st
            .owner_id()
            .map(|o| o.to_string(Encoding::Base58))
            .unwrap_or_default(),
        signature_key_id: st.signature_public_key_id(),
        user_fee_increase: st.user_fee_increase(),
        signature_empty: st.signature().is_none_or(BinaryData::is_empty),
        document_transitions: 0,
        transitions: 0,
        contract_id: String::new(),
        document_type: String::new(),
        action: String::new(),
        document_id: String::new(),
        nonce: 0,
        revision: None,
        properties: BTreeMap::new(),
        signable,
    };
    let StateTransition::Batch(batch) = &st else {
        return Ok(out);
    };
    out.batch = true;
    out.transitions = batch.transitions_len();
    out.document_transitions = batch
        .transitions_iter()
        .filter(|t| matches!(t, BatchedTransitionRef::Document(_)))
        .count();
    if let Some(BatchedTransitionRef::Document(dt)) = batch.first_transition() {
        out.contract_id = dt.data_contract_id().to_string(Encoding::Base58);
        out.document_type.clone_from(dt.document_type_name());
        out.action = match dt {
            DocumentTransition::Create(_) => "create",
            DocumentTransition::Replace(_) => "replace",
            DocumentTransition::Delete(_) => "delete",
            DocumentTransition::Transfer(_) => "transfer",
            DocumentTransition::UpdatePrice(_) => "updatePrice",
            DocumentTransition::Purchase(_) => "purchase",
            DocumentTransition::IndexOnlyDelete(_) => "indexOnlyDelete",
            DocumentTransition::Erase(_) => "erase",
        }
        .to_string();
        out.document_id = dt.get_id().to_string(Encoding::Base58);
        out.nonce = dt.identity_contract_nonce();
        out.revision = dt.revision();
        out.properties = dt
            .data()
            .map(|d| {
                d.iter()
                    .filter_map(|(k, v)| Some((k.clone(), FieldValue::from_value(v)?)))
                    .collect()
            })
            .unwrap_or_default();
    }
    Ok(out)
}

/// The proposal's transition with the combined signature attached, ready to broadcast.
pub fn attach_signature(unsigned: &[u8], signature: &[u8; 96]) -> Result<SignedTransition> {
    let mut st = StateTransition::deserialize_from_bytes_untrusted(unsigned)
        .map_err(|e| Error::InvalidInput(format!("the transition does not decode: {e}")))?;
    let nonce = decode_unsigned(unsigned)?.nonce;
    st.set_signature(BinaryData::new(signature.to_vec()));
    SignedTransition::from_state_transition(&st, nonce)
}

/// `RIPEMD-160(SHA-256(key))`: how Platform indexes a unique key.
pub fn public_key_hash(public_key: &[u8]) -> [u8; 20] {
    use ripemd::Ripemd160;
    Ripemd160::digest(Sha256::digest(public_key)).into()
}

impl PlatformClient {
    /// The identity holding the unique key `public_key` (a BLS12-381 group key), if any.
    pub async fn identity_by_public_key(
        &self,
        public_key: &[u8],
    ) -> Result<Option<LoadedIdentity>> {
        let hash = PublicKeyHash(public_key_hash(public_key));
        let found = retry_transient_read("fetch identity by key", || {
            Identity::fetch(&self.sdk, hash.clone())
        })
        .await
        .map_err(|e| Error::Platform(format!("looking up the identity of a key: {e}")))?;
        Ok(found.map(LoadedIdentity))
    }

    /// The identity-contract nonce from a proved read (never the SDK's cache).
    pub async fn proved_contract_nonce(
        &self,
        identity_id: &str,
        contract_id: &str,
    ) -> Result<NonceState> {
        use drive_proof_verifier::types::IdentityContractNonceFetcher;
        let owner = parse_id(identity_id, "identity id")?;
        let contract = parse_id(contract_id, "contract id")?;
        let current = retry_transient_read("fetch identity-contract nonce", || {
            IdentityContractNonceFetcher::fetch(&self.sdk, (owner, contract))
        })
        .await
        .map_err(|e| Error::Platform(format!("fetching identity-contract nonce: {e}")))?;
        Ok(NonceState(current.map_or(0, |f| f.0)))
    }
}

/// Platform's raw identity-contract nonce: the low 40 bits are the tip, the high 24 a bitmap
/// of skipped nonces still free (DIP-30).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct NonceState(pub u64);

impl NonceState {
    pub fn tip(self) -> u64 {
        self.0 & NONCE_MASK
    }

    /// Whether `nonce` can no longer be used, as Drive decides it (a skipped one is free).
    pub fn spent(self, nonce: u64) -> bool {
        super::nonce_is_spent(self.0, nonce, Identifier::default())
    }

    /// Whether `nonce` is further ahead than Platform accepts. With no nonce yet (a contract the
    /// identity never wrote to), Drive refuses 24 and up.
    pub fn too_far(self, nonce: u64) -> bool {
        if self.0 == 0 {
            nonce >= MAX_NONCE_AHEAD
        } else {
            nonce > self.tip().saturating_add(MAX_NONCE_AHEAD)
        }
    }
}

/// How far above the tip Platform accepts a nonce (rs-dpp `MAX_MISSING_IDENTITY_REVISIONS`).
pub const MAX_NONCE_AHEAD: u64 = 24;

/// Whether `identity`'s key `key_id` is `group_public_key` (48-byte hex): an enabled BLS12-381
/// key (§9 "Which identity a group controls").
pub fn holds_group_key(identity: &LoadedIdentity, key_id: u32, group_public_key: &str) -> bool {
    identity.0.public_keys().get(&key_id).is_some_and(|k| {
        k.key_type() == KeyType::BLS12_381
            && !k.is_disabled()
            && hex::encode(k.data().as_slice()) == group_public_key
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::ForgeContract;
    use crate::network::ForgeIds;
    use crate::org::review::{decoded_problems, describe, Expect, Names};
    use crate::test_support::rc1;
    use dash_sdk::dpp::identity::identity_public_key::v0::IdentityPublicKeyV0;

    const GROUP_KEY: &str = "b077a804ff5b955b52fa6f1f185b8dd933a38db59b7afa790d6d446972a2ade8e5a4406c381a83ec287337399c1b4904";
    const ORG: [u8; 32] = [9u8; 32];

    fn key() -> IdentityPublicKey {
        IdentityPublicKey::V0(IdentityPublicKeyV0 {
            id: 2,
            purpose: Purpose::AUTHENTICATION,
            security_level: SecurityLevel::HIGH,
            contract_bounds: None,
            key_type: KeyType::BLS12_381,
            read_only: false,
            data: BinaryData::new(hex::decode(GROUP_KEY).unwrap()),
            disabled_at: None,
        })
    }

    fn forge() -> ForgeIds {
        ForgeIds {
            core: rc1::loaded(ForgeContract::Core).id(),
            collab: rc1::loaded(ForgeContract::Collab).id(),
            community: rc1::loaded(ForgeContract::Community).id(),
            meta: None,
            group: String::new(),
            superseded_in_group: Vec::new(),
            group_owner: None,
            user: None,
            org: None,
        }
    }

    fn version() -> &'static PlatformVersion {
        PlatformVersion::get(14).unwrap()
    }

    async fn build(
        doc_type: &str,
        props: BTreeMap<String, FieldValue>,
        owner: [u8; 32],
    ) -> UnsignedWrite {
        let core = rc1::loaded(ForgeContract::Core);
        let key = key();
        Build {
            dc: core.0.clone(),
            owner: Identifier::from(owner),
            key: &key,
            version: version(),
        }
        .create(doc_type, props, 5, [3u8; 32])
        .await
        .unwrap()
    }

    fn repo_props() -> BTreeMap<String, FieldValue> {
        crate::create::repo_props(&crate::create::CreateRepoOpts::public("widgets"))
    }

    fn expect<'a>(forge: &'a ForgeIds, org: &'a str) -> Expect<'a> {
        Expect {
            network: "testnet",
            org_id: org,
            key_id: 2,
            cid: "",
            slot: "high",
            forge,
        }
    }

    #[tokio::test]
    async fn an_unsigned_create_decodes_and_passes_review() {
        let w = build("repo", repo_props(), ORG).await;
        let d = decode_unsigned(&w.unsigned).unwrap();
        assert_eq!(d.owner_id, encode_identifier(ORG));
        assert_eq!(d.signature_key_id, Some(2));
        assert!(d.signature_empty);
        assert_eq!(
            (d.document_type.as_str(), d.action.as_str()),
            ("repo", "create")
        );
        assert_eq!(d.document_id, w.document_id);
        assert_eq!(d.nonce, 5);
        assert_eq!(d.signable, w.signable);
        assert_eq!(
            d.properties.get("name").and_then(FieldValue::as_str),
            Some("widgets")
        );
        let forge = forge();
        let org = encode_identifier(ORG);
        assert_eq!(
            decoded_problems(&expect(&forge, &org), &d, &w.signable),
            Vec::<String>::new()
        );
        let mut names = Names::default();
        names
            .repos
            .insert(w.document_id.clone(), "acme/widgets".into());
        assert_eq!(
            describe(&d, None, &names),
            "Create the repository acme/widgets"
        );
        assert_eq!(w.intent["document"]["entropy"], hex::encode([3u8; 32]));
        assert_eq!(w.intent["identityContractNonce"], "5");
    }

    #[tokio::test]
    async fn review_refuses_another_owner_contract_type_or_bytes() {
        let forge = forge();
        let org = encode_identifier(ORG);
        let w = build("repo", repo_props(), [8u8; 32]).await;
        let d = decode_unsigned(&w.unsigned).unwrap();
        assert!(decoded_problems(&expect(&forge, &org), &d, &w.signable)
            .iter()
            .any(|p| p.contains("another identity")));

        let w = build("repo", repo_props(), ORG).await;
        let d = decode_unsigned(&w.unsigned).unwrap();
        let mut elsewhere = forge.clone();
        elsewhere.core = encode_identifier([1u8; 32]);
        assert!(decoded_problems(&expect(&elsewhere, &org), &d, &w.signable)
            .iter()
            .any(|p| p.contains("not this network's Forge")));
        assert!(decoded_problems(&expect(&forge, &org), &d, b"other bytes")
            .iter()
            .any(|p| p.contains("bytes to sign")));
        let mut other_key = expect(&forge, &org);
        other_key.key_id = 3;
        assert!(!decoded_problems(&other_key, &d, &w.signable).is_empty());

        let consent = BTreeMap::from([
            ("repoId".to_string(), FieldValue::identifier([4u8; 32])),
            ("vis".to_string(), FieldValue::text("public")),
        ]);
        let w = build("consent", consent, ORG).await;
        let d = decode_unsigned(&w.unsigned).unwrap();
        assert!(decoded_problems(&expect(&forge, &org), &d, &w.signable)
            .iter()
            .any(|p| p.contains("does not sign this kind of write")));
    }

    #[tokio::test]
    async fn the_combined_signature_attaches_without_changing_the_signed_bytes() {
        let w = build("repo", repo_props(), ORG).await;
        let signed = attach_signature(&w.unsigned, &[0xab; 96]).unwrap();
        let d = decode_unsigned(&signed.bytes).unwrap();
        assert!(!d.signature_empty);
        assert_eq!(d.signable, w.signable);
        assert_eq!(signed.nonce, 5);
    }

    #[tokio::test]
    async fn identifiers_travel_as_plain_bytes_and_hex_in_the_intent() {
        let core = rc1::loaded(ForgeContract::Core);
        let scope = crate::scope::DocScope {
            contract_id: core.id(),
            repo_id: [4u8; 32],
        };
        let props = crate::create::owner_maintainer_props(
            &scope,
            ORG,
            crate::rules::v2::Visibility::Public,
        );
        let w = build("maintainer", props, ORG).await;
        let st = StateTransition::deserialize_from_bytes_untrusted(&w.unsigned).unwrap();
        let StateTransition::Batch(batch) = &st else {
            panic!("not a batch")
        };
        let Some(BatchedTransitionRef::Document(dt)) = batch.first_transition() else {
            panic!("no document transition")
        };
        let data = dt.data().unwrap();
        assert_eq!(data.get("repoId"), Some(&Value::Bytes(vec![4u8; 32])));
        assert_eq!(data.get("memberId"), Some(&Value::Bytes(ORG.to_vec())));
        assert_eq!(
            w.intent["document"]["properties"]["repoId"],
            hex::encode([4u8; 32])
        );
        let d = decode_unsigned(&w.unsigned).unwrap();
        let (repos, people) = crate::org::review::referenced_ids(&d);
        assert_eq!(repos, vec![encode_identifier([4u8; 32])]);
        assert_eq!(people, vec![encode_identifier(ORG)]);
    }

    #[tokio::test]
    async fn a_replace_carries_the_stored_revision_in_its_intent() {
        let core = rc1::loaded(ForgeContract::Core);
        let key = key();
        let id = encode_identifier([6u8; 32]);
        let w = Build {
            dc: core.0.clone(),
            owner: Identifier::from(ORG),
            key: &key,
            version: version(),
        }
        .replace("repo", &id, 2, repo_props(), 7)
        .await
        .unwrap();
        assert_eq!(w.intent["document"]["revision"], "2");
        assert_eq!(w.intent["document"]["id"], id.as_str());
        let d = decode_unsigned(&w.unsigned).unwrap();
        assert_eq!(
            (d.action.as_str(), d.revision, d.nonce),
            ("replace", Some(3), 7)
        );
        assert_eq!(d.document_id, id);
        let forge = forge();
        let org = encode_identifier(ORG);
        assert!(decoded_problems(&expect(&forge, &org), &d, &w.signable).is_empty());
    }

    #[tokio::test]
    async fn bytes_that_do_not_re_encode_are_refused() {
        let w = build("repo", repo_props(), ORG).await;
        let mut padded = w.unsigned.clone();
        padded.push(0);
        let Ok(d) = decode_unsigned(&padded) else {
            return;
        };
        assert!(!d.canonical);
        let forge = forge();
        let org = encode_identifier(ORG);
        assert!(decoded_problems(&expect(&forge, &org), &d, &w.signable)
            .iter()
            .any(|p| p.contains("re-encode")));
    }

    fn field_of(v: &Json, bytes: bool) -> FieldValue {
        match v {
            Json::String(h) if bytes => {
                let raw = hex::decode(h).unwrap();
                <[u8; 32]>::try_from(raw.as_slice())
                    .map_or(FieldValue::Bytes(raw.clone()), FieldValue::Identifier)
            }
            Json::String(t) => FieldValue::text(t),
            Json::Number(n) => FieldValue::Integer(n.as_u64().unwrap()),
            Json::Bool(b) => FieldValue::Bool(*b),
            Json::Array(items) => {
                FieldValue::List(items.iter().map(|i| field_of(i, false)).collect())
            }
            Json::Object(m) => FieldValue::Object(
                m.iter()
                    .map(|(k, v)| (k.clone(), field_of(v, false)))
                    .collect(),
            ),
            Json::Null => panic!("null property"),
        }
    }

    /// Rebuild a proposal's write from its intent as dg builds it: a text property the document
    /// type does not declare a string is bytes (an intent carries bytes as hex text).
    async fn rebuild(intent: &Json, version: &'static PlatformVersion) -> UnsignedWrite {
        use dash_sdk::dpp::data_contract::accessors::v0::DataContractV0Setters;
        use dash_sdk::dpp::data_contract::document_type::accessors::DocumentTypeV0Getters;
        use dash_sdk::dpp::data_contract::document_type::DocumentPropertyType;
        let doc = &intent["document"];
        let doc_type = doc["documentType"].as_str().unwrap();
        let home = ForgeContract::of(doc_type).unwrap();
        let mut dc = (*rc1::loaded(home).0).clone();
        dc.set_id(parse_id(intent["contractId"].as_str().unwrap(), "contract").unwrap());
        let props: BTreeMap<String, FieldValue> = {
            let schema = dc.document_type_for_name(doc_type).unwrap();
            doc["properties"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| {
                    let bytes = schema.properties().get(k).is_some_and(|p| {
                        !matches!(p.property_type, DocumentPropertyType::String(_))
                    });
                    (k.clone(), field_of(v, bytes))
                })
                .collect()
        };
        let nonce: u64 = intent["identityContractNonce"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let key = key();
        let build = Build {
            dc: Arc::new(dc),
            owner: parse_id(intent["ownerId"].as_str().unwrap(), "owner").unwrap(),
            key: &key,
            version,
        };
        let id = || doc["id"].as_str().unwrap();
        match doc["action"].as_str().unwrap() {
            "create" => {
                let entropy: [u8; 32] = hex::decode(doc["entropy"].as_str().unwrap())
                    .unwrap()
                    .try_into()
                    .unwrap();
                build.create(doc_type, props, nonce, entropy).await
            }
            "replace" => {
                let stored = doc["revision"].as_str().unwrap().parse().unwrap();
                build.replace(doc_type, id(), stored, props, nonce).await
            }
            "delete" => build.delete(doc_type, id(), nonce).await,
            other => panic!("unknown action {other}"),
        }
        .unwrap()
    }

    /// forge-web's transitions: built on testnet (`web-built.json`) and, for every request type,
    /// under evo-sdk 5.0.3 and Forge's pin (`cross-sdk.json`, tools/org-vectors).
    #[tokio::test]
    async fn rebuilds_forge_web_transitions_byte_for_byte() {
        for name in ["web-built.json", "cross-sdk.json"] {
            let path = format!(
                "{}/../../forge-contracts/fixtures/org/{name}",
                env!("CARGO_MANIFEST_DIR")
            );
            let fixture: Json =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let versions: Vec<u32> = fixture["platformVersions"]
                .as_array()
                .map_or(vec![14], |v| {
                    v.iter()
                        .map(|n| u32::try_from(n.as_u64().unwrap()).unwrap())
                        .collect()
                });
            let entries = fixture
                .get("vectors")
                .unwrap_or(&fixture["proposals"])
                .as_array()
                .unwrap();
            assert!(entries.len() >= 3, "{name} holds no vectors");
            for p in entries {
                let intent = &p["intent"];
                let label = p
                    .get("label")
                    .unwrap_or(&intent["document"]["documentType"]);
                for v in &versions {
                    let w = rebuild(intent, PlatformVersion::get(*v).unwrap()).await;
                    assert_eq!(
                        hex::encode(&w.unsigned),
                        p["unsigned"].as_str().unwrap(),
                        "{name} {label} at protocol {v} differs from forge-web's"
                    );
                    if let Some(signable) = p.get("signable") {
                        assert_eq!(hex::encode(&w.signable), signable.as_str().unwrap());
                    }
                    if let Some(derived) = p.get("derived") {
                        assert_eq!(w.document_id, derived["documentId"].as_str().unwrap());
                    }
                    assert_eq!(w.intent["document"], intent["document"], "{name} {label}");
                    assert_eq!(
                        decode_unsigned(&w.unsigned).unwrap().document_id,
                        w.document_id
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn a_skipped_nonce_is_free_and_a_far_one_is_refused() {
        let n = NonceState(10);
        assert!(n.spent(10) && n.spent(9) && !n.spent(11));
        let skipped_one_behind = NonceState((1u64 << 40) + 10);
        assert!(!skipped_one_behind.spent(9));
        assert!(!n.too_far(34) && n.too_far(35));
        assert!(!NonceState(0).too_far(23) && NonceState(0).too_far(24));
        let w = build("repo", repo_props(), ORG).await;
        let mut d = decode_unsigned(&w.unsigned).unwrap();
        d.nonce = 9;
        assert!(crate::org::review::nonce_problem(&d, n).is_some());
        assert!(crate::org::review::nonce_problem(&d, skipped_one_behind).is_none());
    }

    #[test]
    fn a_bls_key_hash_is_hash160() {
        let h = public_key_hash(&hex::decode(GROUP_KEY).unwrap());
        assert_eq!(h.len(), 20);
    }
}
