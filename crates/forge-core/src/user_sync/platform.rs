//! [`UserStore`] over Platform: proved reads through [`PlatformClient`], writes through the
//! signer's [`WriteEngine`] (its group-bound key: forge-user is a member of the dash-forge group).

use std::collections::BTreeMap;

use async_trait::async_trait;

use super::store::{EncKeyInfo, GrantDoc, ShareDoc, StateDoc, UserStore};
use super::{DOC_GRANT, DOC_SHARE, DOC_STATE};
use crate::error::{Error, Result};
use crate::platform::{
    decode_identifier, FetchedDocument, FieldValue, KeyBounds, LoadedContract, PlatformClient,
    QueryFilter, QueryOrder, WriteEngine,
};

const PIECE_FIELDS: [&str; 3] = ["d0", "d1", "d2"];

/// forge-user on Platform.
pub struct PlatformUserStore<'a> {
    client: &'a PlatformClient,
    contract: LoadedContract,
    engine: Option<&'a WriteEngine<'a>>,
}

impl<'a> PlatformUserStore<'a> {
    /// A reader (and, with `engine`, a writer) of forge-user `contract_id`.
    pub async fn open(
        client: &'a PlatformClient,
        contract_id: &str,
        engine: Option<&'a WriteEngine<'a>>,
    ) -> Result<Self> {
        Ok(Self {
            client,
            contract: client.fetch_contract(contract_id).await?,
            engine,
        })
    }

    fn engine(&self) -> Result<&'a WriteEngine<'a>> {
        self.engine
            .ok_or_else(|| Error::Config("forge-user: this store only reads".into()))
    }

    async fn query(
        &self,
        doc_type: &str,
        filters: &[QueryFilter],
        limit: u32,
    ) -> Result<Vec<FetchedDocument>> {
        self.client
            .query_documents(&self.contract, doc_type, filters, &[], limit, None)
            .await
    }

    /// Create (`id` `None`) or replace `id` at `revision`: `fields` set, `cleared` removed.
    async fn write(
        &self,
        doc_type: &str,
        id: Option<&String>,
        revision: Option<u64>,
        fields: BTreeMap<String, FieldValue>,
        cleared: &[&str],
    ) -> Result<()> {
        let engine = self.engine()?;
        match id {
            None => {
                engine
                    .create_document(&self.contract, doc_type, fields)
                    .await?;
            }
            Some(id) => {
                let mut changes: BTreeMap<String, Option<FieldValue>> =
                    fields.into_iter().map(|(k, v)| (k, Some(v))).collect();
                for c in cleared {
                    changes.insert((*c).to_string(), None);
                }
                engine
                    .replace_document_guarded(&self.contract, doc_type, id, &changes, revision)
                    .await?;
            }
        }
        Ok(())
    }
}

fn id_field(text: &str) -> Result<FieldValue> {
    Ok(FieldValue::identifier(decode_identifier(text)?))
}

fn u32_field(doc: &FetchedDocument, name: &str) -> Result<u32> {
    doc.field_u64(name)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| Error::InvalidInput(format!("a forge-user document has no {name}")))
}

fn nonce(doc: &FetchedDocument) -> Result<[u8; 12]> {
    doc.field_bytes("n")
        .and_then(|b| <[u8; 12]>::try_from(b).ok())
        .ok_or_else(|| Error::InvalidInput("a forge-user document has no 12-byte nonce".into()))
}

fn pieces(doc: &FetchedDocument) -> Vec<Vec<u8>> {
    PIECE_FIELDS
        .iter()
        .map_while(|f| doc.field_bytes(f))
        .collect()
}

fn ident(doc: &FetchedDocument, name: &str) -> Result<String> {
    doc.field_bytes32(name)
        .map(crate::platform::encode_identifier)
        .ok_or_else(|| Error::InvalidInput(format!("a forge-user document has no {name}")))
}

fn piece_fields(
    fields: &mut BTreeMap<String, FieldValue>,
    pieces: &[Vec<u8>],
    max: usize,
) -> Vec<&'static str> {
    for (name, p) in PIECE_FIELDS.iter().zip(pieces) {
        fields.insert((*name).to_string(), FieldValue::bytes(p.clone()));
    }
    PIECE_FIELDS[pieces.len().min(max)..max].to_vec()
}

fn state_from(doc: &FetchedDocument) -> Result<StateDoc> {
    Ok(StateDoc {
        id: Some(doc.id.clone()),
        owner_id: doc.owner_id.clone(),
        revision: doc.revision,
        slot: doc.field_str("slot").unwrap_or_default(),
        v: u8::try_from(doc.field_u64("v").unwrap_or(0)).unwrap_or(0),
        key_id: u32_field(doc, "keyId")?,
        nonce: nonce(doc)?,
        pieces: pieces(doc),
    })
}

fn share_from(doc: &FetchedDocument) -> Result<ShareDoc> {
    Ok(ShareDoc {
        id: Some(doc.id.clone()),
        owner_id: doc.owner_id.clone(),
        revision: doc.revision,
        repo_id: ident(doc, "repoId")?,
        epoch: u32_field(doc, "epoch")?,
        key_id: u32_field(doc, "keyId")?,
        nonce: nonce(doc)?,
        pieces: pieces(doc),
    })
}

fn grant_from(doc: &FetchedDocument) -> Result<GrantDoc> {
    Ok(GrantDoc {
        id: Some(doc.id.clone()),
        owner_id: doc.owner_id.clone(),
        revision: doc.revision,
        repo_id: ident(doc, "repoId")?,
        member_id: ident(doc, "memberId")?,
        epoch: u32_field(doc, "epoch")?,
        sender_key_id: u32_field(doc, "senderKeyId")?,
        recipient_key_id: u32_field(doc, "recipientKeyId")?,
        wrapped: doc.field_bytes("wrapped").unwrap_or_default(),
    })
}

#[async_trait]
impl UserStore for PlatformUserStore<'_> {
    async fn state(&self, owner: &str, slot: &str) -> Result<Option<StateDoc>> {
        let docs = self
            .query(
                DOC_STATE,
                &[
                    QueryFilter::eq("$ownerId", id_field(owner)?),
                    QueryFilter::eq("slot", FieldValue::text(slot)),
                ],
                1,
            )
            .await?;
        docs.into_iter()
            .find(|d| d.owner_id == owner)
            .map(|d| state_from(&d))
            .transpose()
    }

    async fn states_of(&self, owner: &str) -> Result<Vec<StateDoc>> {
        self.client
            .query_all_documents(
                &self.contract,
                DOC_STATE,
                &[QueryFilter::eq("$ownerId", id_field(owner)?)],
                &[QueryOrder::asc("slot")],
            )
            .await?
            .iter()
            .filter(|d| d.owner_id == owner)
            .map(state_from)
            .collect()
    }

    async fn put_state(&self, doc: &StateDoc) -> Result<()> {
        let mut fields = BTreeMap::from([
            ("slot".to_string(), FieldValue::text(doc.slot.clone())),
            ("v".to_string(), FieldValue::integer(u64::from(doc.v))),
            (
                "keyId".to_string(),
                FieldValue::integer(u64::from(doc.key_id)),
            ),
            ("n".to_string(), FieldValue::bytes(doc.nonce.to_vec())),
        ]);
        let cleared = piece_fields(&mut fields, &doc.pieces, 3);
        self.write(DOC_STATE, doc.id.as_ref(), doc.revision, fields, &cleared)
            .await
    }

    async fn share(&self, owner: &str, repo: &str) -> Result<Option<ShareDoc>> {
        let docs = self
            .query(
                DOC_SHARE,
                &[
                    QueryFilter::eq("$ownerId", id_field(owner)?),
                    QueryFilter::eq("repoId", id_field(repo)?),
                ],
                1,
            )
            .await?;
        docs.into_iter()
            .find(|d| d.owner_id == owner)
            .map(|d| share_from(&d))
            .transpose()
    }

    async fn shares_of(&self, owner: &str) -> Result<Vec<ShareDoc>> {
        self.client
            .query_all_documents(
                &self.contract,
                DOC_SHARE,
                &[QueryFilter::eq("$ownerId", id_field(owner)?)],
                &[QueryOrder::asc("repoId")],
            )
            .await?
            .iter()
            .filter(|d| d.owner_id == owner)
            .map(share_from)
            .collect()
    }

    async fn put_share(&self, doc: &ShareDoc) -> Result<()> {
        let mut fields = BTreeMap::from([
            ("repoId".to_string(), id_field(&doc.repo_id)?),
            (
                "epoch".to_string(),
                FieldValue::integer(u64::from(doc.epoch)),
            ),
            (
                "keyId".to_string(),
                FieldValue::integer(u64::from(doc.key_id)),
            ),
            ("n".to_string(), FieldValue::bytes(doc.nonce.to_vec())),
        ]);
        let cleared = piece_fields(&mut fields, &doc.pieces, 2);
        self.write(DOC_SHARE, doc.id.as_ref(), doc.revision, fields, &cleared)
            .await
    }

    async fn grants_of_repo(&self, owner: &str, repo: &str) -> Result<Vec<GrantDoc>> {
        // Complete, never one page: a grant left out would be a revocation left undone.
        self.client
            .query_all_documents(
                &self.contract,
                DOC_GRANT,
                &[
                    QueryFilter::eq("$ownerId", id_field(owner)?),
                    QueryFilter::eq("repoId", id_field(repo)?),
                ],
                &[QueryOrder::asc("memberId")],
            )
            .await?
            .iter()
            .filter(|d| d.owner_id == owner)
            .map(grant_from)
            .collect()
    }

    async fn grant(&self, owner: &str, repo: &str, member: &str) -> Result<Option<GrantDoc>> {
        self.query(
            DOC_GRANT,
            &[
                QueryFilter::eq("$ownerId", id_field(owner)?),
                QueryFilter::eq("repoId", id_field(repo)?),
                QueryFilter::eq("memberId", id_field(member)?),
            ],
            1,
        )
        .await?
        .iter()
        .find(|d| d.owner_id == owner)
        .map(grant_from)
        .transpose()
    }

    async fn put_grant(&self, doc: &GrantDoc) -> Result<()> {
        let fields = BTreeMap::from([
            ("repoId".to_string(), id_field(&doc.repo_id)?),
            ("memberId".to_string(), id_field(&doc.member_id)?),
            (
                "epoch".to_string(),
                FieldValue::integer(u64::from(doc.epoch)),
            ),
            (
                "senderKeyId".to_string(),
                FieldValue::integer(u64::from(doc.sender_key_id)),
            ),
            (
                "recipientKeyId".to_string(),
                FieldValue::integer(u64::from(doc.recipient_key_id)),
            ),
            (
                "wrapped".to_string(),
                FieldValue::bytes(doc.wrapped.clone()),
            ),
        ]);
        self.write(DOC_GRANT, doc.id.as_ref(), doc.revision, fields, &[])
            .await
    }

    async fn delete_grant(&self, doc: &GrantDoc) -> Result<()> {
        let id = doc.id.as_ref().ok_or(Error::NotFound)?;
        self.engine()?
            .delete_document(&self.contract, DOC_GRANT, id)
            .await
    }

    async fn encryption_keys(&self, identity: &str) -> Result<Vec<EncKeyInfo>> {
        let identity = match self.client.fetch_identity(identity).await {
            Ok(i) => i,
            Err(Error::NotFound) => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let contract = self.contract.id();
        let mut keys: Vec<EncKeyInfo> = identity
            .public_keys()
            .into_iter()
            .filter(|k| {
                !k.disabled
                    && k.purpose == "ENCRYPTION"
                    && k.key_type == "ECDSA_SECP256K1"
                    && k.bounds
                        == Some(KeyBounds::Contract {
                            id: contract.clone(),
                            document_type: None,
                        })
            })
            .map(|k| EncKeyInfo {
                id: k.id,
                public_key: k.public_key,
            })
            .collect();
        keys.sort_by_key(|k| k.id);
        Ok(keys)
    }
}

/// forge-user's keys on an identity, read from Platform; with the identity's master key, the
/// update that moves sync to a new key ([`super::rotate`]).
pub struct PlatformKeyLedger<'a> {
    client: &'a PlatformClient,
    contract_id: String,
    master_wif: Option<crate::keystore::Secret>,
}

impl<'a> PlatformKeyLedger<'a> {
    /// A reader of forge-user `contract_id`'s keys; with `master_wif` (the identity's MASTER
    /// key), also the writer of the update.
    pub fn new(
        client: &'a PlatformClient,
        contract_id: &str,
        master_wif: Option<crate::keystore::Secret>,
    ) -> Self {
        Self {
            client,
            contract_id: contract_id.to_string(),
            master_wif,
        }
    }

    async fn live_id_of(&self, identity: &str, public: &[u8]) -> Result<Option<u32>> {
        use super::rotate::KeyLedger as _;
        Ok(self
            .forge_user_keys(identity)
            .await?
            .into_iter()
            .find(|k| !k.disabled && k.public_key == public)
            .map(|k| k.id))
    }
}

#[async_trait]
impl super::rotate::KeyLedger for PlatformKeyLedger<'_> {
    async fn forge_user_keys(&self, identity: &str) -> Result<Vec<super::rotate::ForgeUserKey>> {
        let identity = match self.client.fetch_identity(identity).await {
            Ok(i) => i,
            Err(Error::NotFound) => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let bound = Some(KeyBounds::Contract {
            id: self.contract_id.clone(),
            document_type: None,
        });
        let mut keys: Vec<_> = identity
            .public_keys()
            .into_iter()
            .filter(|k| {
                k.purpose == "ENCRYPTION" && k.key_type == "ECDSA_SECP256K1" && k.bounds == bound
            })
            .map(|k| super::rotate::ForgeUserKey {
                id: k.id,
                public_key: k.public_key,
                disabled: k.disabled,
            })
            .collect();
        keys.sort_by_key(|k| k.id);
        Ok(keys)
    }

    async fn add_and_disable(
        &self,
        identity: &str,
        secret: &crate::app_connect::SecretBytes,
        disable: u32,
    ) -> Result<u32> {
        use crate::platform::identity::{FreshKey, KeySpec};
        let master = self.master_wif.as_ref().ok_or_else(|| {
            Error::Config("moving sync to a new key needs the identity's master key".into())
        })?;
        let public = super::crypto::public_key(secret)?;
        if let Some(id) = self.live_id_of(identity, &public).await? {
            return Ok(id);
        }
        let fresh = FreshKey::from_secret_bytes(secret.expose(), self.client.network())?;
        let sent = self
            .client
            .update_identity_keys(
                identity,
                master,
                &[(
                    &fresh,
                    KeySpec::SyncEncryption {
                        contract: self.contract_id.clone(),
                    },
                )],
                &[disable],
            )
            .await;
        // Whatever the broadcast said, a read of the identity decides (it may have landed).
        for attempt in 0..5u64 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(2000 * attempt)).await;
            }
            if let Some(id) = self.live_id_of(identity, &public).await? {
                return Ok(id);
            }
            if sent.is_err() && attempt >= 1 {
                break;
            }
        }
        sent?;
        Err(Error::Platform(
            "the identity update was accepted, but the new sync key is not on the identity yet; run the same command again in a minute"
                .into(),
        ))
    }
}
