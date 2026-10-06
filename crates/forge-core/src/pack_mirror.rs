//! Pack mirrors (UPDATE-1 `packMirror`, `docs/contracts/forge-v2.md` §2, §9.1): record another
//! copy of a pack, list and delete one's own records, and read a pack from the recorded mirrors
//! when every copy its manifests name has failed. The rules (what may be recorded, the order a
//! reader tries) are [`crate::rules::pack_mirror`], shared with forge-web.
//!
//! A mirror is never an authority: its bytes must hash to the pack's SHA-256, so a bad one can
//! only fail to serve. Readers take mirrors for a public repository only, and only for a pack the
//! repository's own manifests list.

use std::collections::BTreeMap;

use crate::error::{Error, Result};
use crate::platform::{
    self, FetchedDocument, FieldValue, LoadedContract, PlatformClient, QueryFilter, QueryOrder,
    WriteEngine,
};
use crate::rules::pack_mirror::{
    check_mirror_uris, mirror_read_order, MirrorReadInput, MirrorRecord, UriCheck, UriProblem,
};
use crate::rules::v2::{Role, Visibility};
use crate::scope::RepoRef;

/// forge-core's pack mirror type.
pub const DOC_PACK_MIRROR: &str = "packMirror";

/// The records one read of a pack's mirrors returns at most (one page).
pub const MIRROR_RECORDS_READ: u32 = 100;

/// A `packMirror` document, as its writer and readers see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackMirror {
    /// Document `$id`.
    pub id: String,
    /// Its writer (`$ownerId`).
    pub owner_id: String,
    /// The repository (base58).
    pub repo_id: String,
    /// The pack it mirrors (hex).
    pub pack_hash: String,
    /// `kind`: 1 https, 2 IPFS.
    pub kind: u64,
    /// `uris`.
    pub uris: Vec<String>,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// A `packMirror` document as a [`PackMirror`]; `None` when it lacks a field.
#[must_use]
pub fn mirror_from_doc(d: &FetchedDocument) -> Option<PackMirror> {
    Some(PackMirror {
        id: d.id.clone(),
        owner_id: d.owner_id.clone(),
        repo_id: d.field_bytes32("repoId").map(platform::encode_identifier)?,
        pack_hash: d.field_hex("packHash")?,
        kind: d.field_u64("kind")?,
        uris: d.fields.get("uris").and_then(FieldValue::as_text_list)?,
        created_at: d.created_at.unwrap_or_default(),
    })
}

/// Why `uris` cannot be recorded, in words; `None` when they can.
#[must_use]
pub fn uri_problem_words(check: &UriCheck) -> Option<String> {
    let UriCheck::Refused { problem, index } = check else {
        return None;
    };
    let which = index.map_or_else(String::new, |i| format!("address {}: ", i + 1));
    Some(match problem {
        UriProblem::None => "give at least one address".to_string(),
        UriProblem::TooMany => "a mirror holds at most 4 addresses".to_string(),
        UriProblem::Length => format!("{which}an address is 1-300 characters"),
        UriProblem::Address => {
            format!("{which}use an https:// URL without a user name or password, or ipfs://<CID>")
        }
        UriProblem::IpfsPath => format!("{which}an ipfs:// address is the bare CID, no path"),
        UriProblem::Duplicate => format!("{which}the same address twice"),
        UriProblem::MixedKinds => {
            "one mirror holds https addresses or IPFS addresses, not both".to_string()
        }
    })
}

fn hash_value(pack_hash: &str) -> Result<FieldValue> {
    let bytes: [u8; 32] = hex::decode(pack_hash)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| Error::InvalidInput(format!("{pack_hash:?} is not a pack hash")))?;
    Ok(FieldValue::bytes32(bytes))
}

fn repo_value(repo: &RepoRef) -> Result<FieldValue> {
    Ok(FieldValue::identifier(platform::decode_identifier(
        &repo.repo_id,
    )?))
}

/// The recorded mirrors of `pack_hash` in `repo` (its `byHash` index, one page). Empty on a
/// contract without the type.
pub async fn mirrors_of(
    client: &PlatformClient,
    core: &LoadedContract,
    repo: &RepoRef,
    pack_hash: &str,
) -> Result<Vec<PackMirror>> {
    if !core.has_document_type(DOC_PACK_MIRROR) {
        return Ok(Vec::new());
    }
    let docs = client
        .query_documents(
            core,
            DOC_PACK_MIRROR,
            &[
                QueryFilter::eq("repoId", repo_value(repo)?),
                QueryFilter::eq("packHash", hash_value(pack_hash)?),
            ],
            &[QueryOrder::asc("$ownerId")],
            MIRROR_RECORDS_READ,
            None,
        )
        .await?;
    Ok(docs.iter().filter_map(mirror_from_doc).collect())
}

/// Every mirror `owner` recorded (its `byOwner` index), oldest first.
pub async fn mirrors_by(
    client: &PlatformClient,
    core: &LoadedContract,
    owner: &str,
) -> Result<Vec<PackMirror>> {
    if !core.has_document_type(DOC_PACK_MIRROR) {
        return Ok(Vec::new());
    }
    let docs = client
        .query_all_documents(
            core,
            DOC_PACK_MIRROR,
            &[QueryFilter::eq(
                "$ownerId",
                FieldValue::identifier(platform::decode_identifier(owner)?),
            )],
            &[QueryOrder::asc("$createdAt")],
        )
        .await?;
    Ok(docs.iter().filter_map(mirror_from_doc).collect())
}

/// The addresses a reader tries for `pack_hash`, in the shared order
/// ([`mirror_read_order`]): `roles` are the repository's members now.
#[must_use]
pub fn read_order(
    repo: &RepoRef,
    pack_hash: &str,
    listed: &[String],
    mirrors: &[PackMirror],
    roles: &BTreeMap<String, Role>,
) -> Vec<String> {
    mirror_read_order(&MirrorReadInput {
        pack_hash: pack_hash.to_string(),
        listed: listed.to_vec(),
        visibility: repo.visibility,
        mirrors: mirrors
            .iter()
            .map(|m| MirrorRecord {
                id: m.id.clone(),
                owner_role: roles.get(&m.owner_id).copied(),
                created_at: m.created_at,
                pack_hash: m.pack_hash.clone(),
                kind: m.kind,
                uris: m.uris.clone(),
            })
            .collect(),
    })
}

/// Record a mirror of `pack_hash` of `repo` at `uris` as the signer. Refused before signing for
/// a private repository, for addresses the shared rule refuses, and on a contract without the
/// type. Returns the document id.
pub async fn record_mirror(
    engine: &WriteEngine<'_>,
    core: &LoadedContract,
    repo: &RepoRef,
    pack_hash: &str,
    uris: &[String],
) -> Result<String> {
    if repo.visibility == Visibility::Private {
        return Err(Error::InvalidInput(
            "a private repository's packs are sealed to its members: mirrors are for public repositories".into(),
        ));
    }
    let check = check_mirror_uris(uris);
    let UriCheck::Ok { kind } = check else {
        return Err(Error::InvalidInput(
            uri_problem_words(&check).unwrap_or_default(),
        ));
    };
    if !core.has_document_type(DOC_PACK_MIRROR) {
        return Err(Error::Config(
            "this network's Forge doesn't support pack mirrors yet".into(),
        ));
    }
    let props = BTreeMap::from([
        ("repoId".to_string(), repo_value(repo)?),
        ("packHash".to_string(), hash_value(pack_hash)?),
        ("kind".to_string(), FieldValue::integer(kind)),
        ("uris".to_string(), FieldValue::text_list(uris.to_vec())),
    ]);
    engine.create_document(core, DOC_PACK_MIRROR, props).await
}

/// Delete the signer's mirror record `id` (its writer only).
pub async fn delete_mirror(
    engine: &WriteEngine<'_>,
    core: &LoadedContract,
    id: &str,
) -> Result<()> {
    engine.delete_document(core, DOC_PACK_MIRROR, id).await
}
