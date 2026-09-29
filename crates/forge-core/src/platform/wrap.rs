//! The `repoKey` wrap through the SDK's `encryptedFor` helpers (`docs/security/private-repos.md`
//! §5.1): `dash_sdk::platform::encrypted_for::{encrypt_property, decrypt_property,
//! EncryptedPropertyEnvelope::read}` read the declaration from the contract, write
//! `recipientKeyId` / `senderKeyId`, and refuse a wrong-shaped ciphertext. The plaintext is built
//! and checked by [`crate::private::wrap`]; nothing here re-implements ECDH or AES-CBC.
//!
//! Lives in `forge-core::platform` because the SDK is confined here (style guide §B): callers
//! pass raw key bytes and [`LoadedContract`], and get raw bytes back.

use std::collections::BTreeMap;

use dash_sdk::dpp::dashcore::secp256k1::{PublicKey, SecretKey};
use dash_sdk::dpp::data_contract::accessors::v0::DataContractV0Getters as _;
use dash_sdk::dpp::document::{Document, DocumentV0};
use dash_sdk::dpp::platform_value::Value;
use dash_sdk::platform::encrypted_for::{
    decrypt_property, encrypt_property, EncryptedPropertyEnvelope, EncryptionKeys,
};
use dash_sdk::platform::Identifier;
use zeroize::Zeroizing;

use super::LoadedContract;
use crate::error::{Error, Result};
use crate::private::{wrap, EpochKey, PrivateError};

const DOC_TYPE: &str = "repoKey";
const PROPERTY: &str = "wrapped";

/// A secp256k1 private key for the wrap, zeroized on drop, never printed.
pub struct WrapSecret(SecretKey);

impl WrapSecret {
    /// From 32 raw bytes (an identity's `ENCRYPTION` key).
    pub fn from_bytes(bytes: &[u8; 32]) -> Result<Self> {
        SecretKey::from_byte_array(bytes)
            .map(Self)
            .map_err(|_| Error::Config("invalid secp256k1 private key".into()))
    }
}

impl Drop for WrapSecret {
    fn drop(&mut self) {
        self.0.non_secure_erase();
    }
}

impl std::fmt::Debug for WrapSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WrapSecret(<redacted>)")
    }
}

fn public_key(bytes: &[u8]) -> Result<PublicKey> {
    PublicKey::from_slice(bytes).map_err(|_| Error::Config("invalid secp256k1 public key".into()))
}

fn doc_type(
    contract: &LoadedContract,
) -> Result<dash_sdk::dpp::data_contract::document_type::DocumentTypeRef<'_>> {
    contract
        .0
        .document_type_for_name(DOC_TYPE)
        .map_err(|e| Error::Config(format!("contract has no {DOC_TYPE} type: {e}")))
}

/// The `repoKey` properties that carry a wrap of `key` (the key of `epoch` of `repo_id`) from the
/// sender to the recipient: `wrapped` (64 bytes: a fresh IV and the padded 47-byte plaintext),
/// `recipientKeyId` and `senderKeyId`. The caller adds `repoId`, `memberId` and `epoch`.
pub fn seal_wrap(
    contract: &LoadedContract,
    repo_id: &[u8; 32],
    epoch: u32,
    key: &EpochKey,
    parties: &WrapParties<'_>,
) -> Result<WrapProperties> {
    let pt = wrap::plaintext(repo_id, epoch, key);
    let (sender_key_id, recipient_key_id) = (parties.sender_key_id, parties.recipient_key_id);
    let keys = EncryptionKeys {
        sender_key_id,
        sender_private_key: &parties.sender.0,
        recipient_key_id,
        recipient_public_key: public_key(parties.recipient_public_key)?,
    };
    let mut props = BTreeMap::new();
    encrypt_property(doc_type(contract)?, PROPERTY, &pt, &keys, &mut props)
        .map_err(|e| Error::Config(format!("wrapping the repo key: {e}")))?;
    let wrapped = props
        .get(PROPERTY)
        .and_then(|v| v.as_bytes().cloned())
        .ok_or_else(|| Error::Config("the SDK wrote no wrapped bytes".into()))?;
    Ok(WrapProperties {
        wrapped,
        recipient_key_id,
        sender_key_id,
    })
}

/// The two identity keys a wrap is under (§5.1): the wrapping maintainer's `ENCRYPTION` key and
/// the member's highest enabled `ENCRYPTION` key.
#[derive(Debug, Clone, Copy)]
pub struct WrapParties<'a> {
    /// The sender's private key.
    pub sender: &'a WrapSecret,
    /// The sender's key id (`senderKeyId`).
    pub sender_key_id: u32,
    /// The recipient's public key (33-byte compressed).
    pub recipient_public_key: &'a [u8],
    /// The recipient's key id (`recipientKeyId`).
    pub recipient_key_id: u32,
}

/// What [`seal_wrap`] writes into a `repoKey`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrapProperties {
    /// `wrapped`.
    pub wrapped: Vec<u8>,
    /// `recipientKeyId`.
    pub recipient_key_id: u32,
    /// `senderKeyId`.
    pub sender_key_id: u32,
}

/// Recover the epoch key from a `repoKey`'s `wrapped` bytes with the reader's private key and
/// the other side's public key (the sender's for a recipient; the recipient's for the sender
/// reading its own wrap). A padding failure, a wrong version or a KCV mismatch is
/// [`PrivateError::WrapUnreadable`]; the anchor check ([`wrap::check_against_anchor`]) is the
/// caller's, with the epoch's anchor in hand.
pub fn open_wrap(
    contract: &LoadedContract,
    repo_id: &[u8; 32],
    epoch: u32,
    wrapped: &[u8],
    reader: &WrapSecret,
    counterparty_public_key: &[u8],
) -> std::result::Result<EpochKey, PrivateError> {
    let dt = doc_type(contract).map_err(|_| PrivateError::WrapUnreadable)?;
    let counterparty =
        public_key(counterparty_public_key).map_err(|_| PrivateError::WrapUnreadable)?;
    let mut props = BTreeMap::new();
    props.insert(PROPERTY.to_string(), Value::Bytes(wrapped.to_vec()));
    let pt = Zeroizing::new(
        decrypt_property(dt, PROPERTY, &props, &reader.0, &counterparty)
            .map_err(|_| PrivateError::WrapUnreadable)?,
    );
    wrap::parse(repo_id, epoch, &pt)
}

/// Whose keys a stored `repoKey`'s wrap is under: `(recipient identity, recipientKeyId, sender
/// identity, senderKeyId)`, read by the SDK from the contract's declaration.
pub fn wrap_envelope(
    contract: &LoadedContract,
    owner_id: [u8; 32],
    properties: BTreeMap<String, super::FieldValue>,
) -> Result<([u8; 32], u32, [u8; 32], u32)> {
    let dt = doc_type(contract)?;
    let props: BTreeMap<String, Value> = properties
        .into_iter()
        .map(|(k, v)| (k, v.into_value()))
        .collect();
    let doc = Document::V0(DocumentV0 {
        id: Identifier::default(),
        owner_id: Identifier::from(owner_id),
        properties: props,
        revision: None,
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
        contract_version: None,
    });
    let env = EncryptedPropertyEnvelope::read(dt, PROPERTY, &doc)
        .map_err(|e| Error::Config(format!("reading the repo key envelope: {e}")))?;
    Ok((
        env.recipient_id.to_buffer(),
        env.recipient_key_id,
        env.sender_id.to_buffer(),
        env.sender_key_id,
    ))
}

/// forge-collab (which holds `repoKey` since RC1) parsed from the repo's schema, its
/// forge-core references pointed at a stand-in id, for tests.
#[cfg(test)]
pub(crate) fn test_contract() -> LoadedContract {
    use dash_sdk::dpp::data_contract::conversion::json::DataContractJsonConversionMethodsV0;
    let raw = include_str!("../../../../forge-contracts/contracts/forge-collab.json").replace(
        "FORGE_CORE_CONTRACT_ID",
        &super::encode_identifier([0x0c; 32]),
    );
    let json: serde_json::Value = serde_json::from_str(&raw).expect("forge-collab.json");
    let pv = dash_sdk::dpp::version::PlatformVersion::get(14).expect("protocol 14");
    let c =
        dash_sdk::platform::DataContract::from_json(json, true, pv).expect("forge-collab parses");
    LoadedContract(std::sync::Arc::new(c))
}

/// The ECDH shared key `SHA-256(parity ‖ x)` of the scheme, for the conformance vectors only
/// (production goes through `encrypt_property` / `decrypt_property`).
#[cfg(test)]
pub(crate) fn shared_key_for_vectors(secret: &WrapSecret, public: &[u8]) -> [u8; 32] {
    use dash_sdk::dpp::dashcore::secp256k1::ecdh::SharedSecret;
    SharedSecret::new(&public_key(public).expect("public key"), &secret.0).secret_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private::EpochKeys;

    fn contract() -> LoadedContract {
        test_contract()
    }

    fn secret(hex_: &str) -> WrapSecret {
        WrapSecret::from_bytes(&hex::decode(hex_).unwrap().try_into().unwrap()).unwrap()
    }

    const SENDER: &str = "840fa5c84d8f6ecf5c27fd778356ba94480b9b35f264e7690933dcf1676f9ac0";
    const RECIPIENT: &str = "f16baad1b1863c015869f5a6a2db471537d06a31d3bd78d961300f13f6b14239";
    const SENDER_PUB: &str = "03f3d414f81ac96cea14d3ec25685430f04c47c8b0559fff0ffe77113d8ada7948";
    const RECIPIENT_PUB: &str =
        "035bf470bf1fbffac4b0b01c0ae8480b0b56d6695482bb116286c62e99af15e337";

    #[test]
    fn sdk_round_trip_both_directions() {
        let c = contract();
        let repo = [0x11; 32];
        let key = EpochKey::from_bytes(core::array::from_fn(|i| u8::try_from(i).unwrap()));
        let sender = secret(SENDER);
        let recipient_pub = hex::decode(RECIPIENT_PUB).unwrap();
        let parties = WrapParties {
            sender: &sender,
            sender_key_id: 4,
            recipient_public_key: &recipient_pub,
            recipient_key_id: 4,
        };
        let props = seal_wrap(&c, &repo, 0, &key, &parties).unwrap();
        assert_eq!(props.wrapped.len(), 64, "wrapped is always 64 bytes (§5.1)");
        let by_recipient = open_wrap(
            &c,
            &repo,
            0,
            &props.wrapped,
            &secret(RECIPIENT),
            &hex::decode(SENDER_PUB).unwrap(),
        )
        .unwrap();
        let by_sender = open_wrap(
            &c,
            &repo,
            0,
            &props.wrapped,
            &secret(SENDER),
            &hex::decode(RECIPIENT_PUB).unwrap(),
        )
        .unwrap();
        assert_eq!(by_recipient, key);
        assert_eq!(by_sender, key);
        let commit = *EpochKeys::derive(&repo, 0, &key).commit();
        assert!(wrap::check_against_anchor(&repo, 0, &by_recipient, &commit).is_ok());
    }

    #[test]
    fn a_wrong_shape_is_refused_before_decryption() {
        let c = contract();
        assert_eq!(
            open_wrap(
                &c,
                &[0x11; 32],
                0,
                &[0u8; 20],
                &secret(RECIPIENT),
                &hex::decode(SENDER_PUB).unwrap()
            ),
            Err(PrivateError::WrapUnreadable)
        );
    }

    #[test]
    fn envelope_names_both_keys() {
        let c = contract();
        let mut props = BTreeMap::new();
        props.insert(
            "repoId".into(),
            super::super::FieldValue::identifier([0x11; 32]),
        );
        props.insert(
            "memberId".into(),
            super::super::FieldValue::identifier([0x33; 32]),
        );
        props.insert("epoch".into(), super::super::FieldValue::integer(0));
        props.insert(
            "recipientKeyId".into(),
            super::super::FieldValue::integer(4),
        );
        props.insert("senderKeyId".into(), super::super::FieldValue::integer(5));
        props.insert(
            "wrapped".into(),
            super::super::FieldValue::bytes(vec![0; 64]),
        );
        let (rid, rk, sid, sk) = wrap_envelope(&c, [0x22; 32], props).unwrap();
        assert_eq!((rid, rk, sid, sk), ([0x33; 32], 4, [0x22; 32], 5));
    }
}
