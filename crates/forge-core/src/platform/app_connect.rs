//! App Connect v2's chain reads over [`PlatformClient`] (`crate::app_connect`'s ports; forge-web
//! `lib/auth/app-connect-port.ts`). Every read is proved, and identity reads go to the network
//! (the SDK keeps no identity cache): a key a wallet added moments ago is what is checked.

use std::collections::BTreeMap;

use async_trait::async_trait;
use dash_sdk::dpp::identity::accessors::IdentityGettersV0;
use dash_sdk::dpp::identity::identity_public_key::accessors::v0::IdentityPublicKeyGettersV0;
use dash_sdk::dpp::identity::identity_public_key::accessors::v1::IdentityPublicKeyGettersV1;
use dash_sdk::dpp::identity::identity_public_key::contract_bounds::ContractBounds;
use dash_sdk::platform::identity_keys_remaining_budgets::{
    IdentityKeysRemainingBudgets, IdentityKeysRemainingBudgetsQuery,
};
use dash_sdk::platform::{Fetch, Identifier, IdentityPublicKey};

use super::{
    decode_identifier, encode_identifier, retry_transient_read, FieldValue, PlatformClient,
    QueryFilter, QueryOrder,
};
use crate::app_connect::poll::ResponsePort;
use crate::app_connect::verify::{Candidate, IdentityPort};
use crate::app_connect::{
    ChainKey, Id, KeyBounds, APP_CONNECT_CONTRACT_ID, RESPONSE_DOCUMENT_TYPE,
};
use crate::error::{Error, Result};

/// A key as the verifier reads it.
fn chain_key(k: &IdentityPublicKey) -> ChainKey {
    ChainKey {
        id: k.id(),
        key_type: k.key_type() as u8,
        purpose: k.purpose() as u8,
        security_level: k.security_level() as u8,
        data: k.data().to_vec(),
        disabled: k.is_disabled(),
        bounds: k.contract_bounds().map(|b| match b {
            ContractBounds::SingleContract { id } => KeyBounds::SingleContract {
                contract_id: id.to_buffer(),
            },
            ContractBounds::SingleContractDocumentType {
                id,
                document_type_name,
            } => KeyBounds::DocumentType {
                contract_id: id.to_buffer(),
                document_type_name: document_type_name.clone(),
            },
            ContractBounds::ContractGroup { id } => KeyBounds::ContractGroup {
                group_id: id.to_buffer(),
            },
        }),
        total_budget: k.total_budget(),
        expires_at_ms: k.expires_at(),
    }
}

#[async_trait]
impl IdentityPort for PlatformClient {
    async fn identity_keys(&self, identity_id: &Id) -> Result<Option<Vec<ChainKey>>> {
        match self.fetch_identity(&encode_identifier(*identity_id)).await {
            Ok(identity) => Ok(Some(
                identity.0.public_keys().values().map(chain_key).collect(),
            )),
            Err(Error::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn remaining_budgets(
        &self,
        identity_id: &Id,
        key_ids: &[u32],
    ) -> Result<BTreeMap<u32, u64>> {
        let query = IdentityKeysRemainingBudgetsQuery {
            identity_id: Identifier::from(*identity_id),
            key_ids: key_ids.to_vec(),
        };
        let budgets = retry_transient_read("key budgets", || {
            IdentityKeysRemainingBudgets::fetch(&self.sdk, query.clone())
        })
        .await
        .map_err(|e| Error::Platform(format!("reading remaining key budgets: {e}")))?;
        Ok(budgets
            .map(|b| {
                b.iter()
                    .filter_map(|(id, left)| left.map(|l| (*id, l)))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// The identity's enabled keys of `purpose` bound to `contract_id` alone, from the proved
    /// identity (the SDK has no proved `getIdentitiesContractKeys` fetch yet). forge-user takes
    /// `MultipleReferenceToLatest`; the wallets reuse the deterministic key, so any enabled one
    /// of these is the identity's.
    async fn contract_keys(
        &self,
        identity_id: &Id,
        contract_id: &Id,
        purpose: u8,
    ) -> Result<Vec<ChainKey>> {
        let identity = match self.fetch_identity(&encode_identifier(*identity_id)).await {
            Ok(identity) => identity,
            Err(Error::NotFound) => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        Ok(identity
            .0
            .public_keys()
            .values()
            .map(chain_key)
            .filter(|k| {
                !k.disabled
                    && k.purpose == purpose
                    && k.bounds
                        == Some(KeyBounds::SingleContract {
                            contract_id: *contract_id,
                        })
            })
            .collect())
    }
}

#[async_trait]
impl ResponsePort for PlatformClient {
    async fn list_candidates(
        &self,
        request_hash: &[u8; 20],
        hint: Option<&Id>,
        start_after: Option<&Id>,
        limit: u32,
    ) -> Result<Vec<Candidate>> {
        let contract = self.fetch_contract(APP_CONNECT_CONTRACT_ID).await?;
        let mut filters = vec![QueryFilter::eq(
            "appEphemeralPubKeyHash",
            FieldValue::bytes(request_hash.to_vec()),
        )];
        if let Some(hint) = hint {
            filters.push(QueryFilter::eq("$ownerId", FieldValue::identifier(*hint)));
        } else if let Some(after) = start_after {
            filters.push(QueryFilter::gt("$ownerId", FieldValue::identifier(*after)));
        }
        // The (appEphemeralPubKeyHash, $ownerId) index.
        let order = [
            QueryOrder::asc("appEphemeralPubKeyHash"),
            QueryOrder::asc("$ownerId"),
        ];
        let rows = self
            .query_documents(
                &contract,
                RESPONSE_DOCUMENT_TYPE,
                &filters,
                &order,
                limit,
                None,
            )
            .await?;
        // A row whose bytes do not read is kept with empty bytes (the verifier refuses it as
        // framing): dropping it would shorten the page, and a short page reads as the last.
        let mut candidates = rows
            .iter()
            .map(|row| {
                Ok(Candidate {
                    owner_id: decode_identifier(&row.owner_id)?,
                    wallet_ephemeral_pub_key: row
                        .field_bytes("walletEphemeralPubKey")
                        .unwrap_or_default(),
                    encrypted_payload: row.field_bytes("encryptedPayload").unwrap_or_default(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        candidates.sort_by_key(|c| c.owner_id);
        Ok(candidates)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_connect::{key_type, level, purpose};
    use dash_sdk::dpp::identity::identity_public_key::v0::IdentityPublicKeyV0;
    use dash_sdk::dpp::identity::identity_public_key::v1::IdentityPublicKeyV1;
    use dash_sdk::dpp::identity::{KeyType, Purpose, SecurityLevel};
    use dash_sdk::dpp::platform_value::BinaryData;

    fn v0(key_type: KeyType, bounds: Option<ContractBounds>) -> IdentityPublicKeyV0 {
        IdentityPublicKeyV0 {
            id: 4,
            purpose: Purpose::AUTHENTICATION,
            security_level: SecurityLevel::HIGH,
            contract_bounds: bounds,
            key_type,
            read_only: false,
            data: BinaryData::new(vec![9; 20]),
            disabled_at: None,
        }
    }

    #[test]
    fn maps_a_wallet_grant_key_with_its_numbers_bounds_and_limits() {
        let group = [5u8; 32];
        let key: IdentityPublicKey = IdentityPublicKeyV1::from_v0_with_limits(
            v0(
                KeyType::ECDSA_HASH160,
                Some(ContractBounds::ContractGroup {
                    id: Identifier::from(group),
                }),
            ),
            Some(25_000_000_000),
            Some(1_800_000_000_000),
        )
        .into();
        assert_eq!(
            chain_key(&key),
            ChainKey {
                id: 4,
                key_type: key_type::ECDSA_HASH160,
                purpose: purpose::AUTHENTICATION,
                security_level: level::HIGH,
                data: vec![9; 20],
                disabled: false,
                bounds: Some(KeyBounds::ContractGroup { group_id: group }),
                total_budget: Some(25_000_000_000),
                expires_at_ms: Some(1_800_000_000_000),
            }
        );
    }

    #[test]
    fn maps_document_type_bounds_and_a_disabled_v0_key() {
        let mut k = v0(
            KeyType::ECDSA_SECP256K1,
            Some(ContractBounds::SingleContractDocumentType {
                id: Identifier::from([6u8; 32]),
                document_type_name: "profile".into(),
            }),
        );
        k.disabled_at = Some(1);
        let mapped = chain_key(&k.into());
        assert!(mapped.disabled);
        assert_eq!(mapped.key_type, key_type::ECDSA_SECP256K1);
        assert_eq!(
            mapped.bounds,
            Some(KeyBounds::DocumentType {
                contract_id: [6; 32],
                document_type_name: "profile".into()
            })
        );
        assert_eq!((mapped.total_budget, mapped.expires_at_ms), (None, None));
    }
}
