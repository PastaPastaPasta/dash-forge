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
use crate::storage::read::PackReader;

/// forge-core's pack mirror type.
pub const DOC_PACK_MIRROR: &str = "packMirror";

/// The records one read of a pack's mirrors returns at most (one page), and the members one
/// read of their records names (the `in` clause's limit).
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
    // `packHash` is a `hid` (an identifier-typed byteArray), as on `packManifest`.
    Ok(FieldValue::identifier(bytes))
}

fn repo_value(repo: &RepoRef) -> Result<FieldValue> {
    Ok(FieldValue::identifier(platform::decode_identifier(
        &repo.repo_id,
    )?))
}

/// The recorded mirrors of `pack_hash` in `repo` (its `byHash` index): every record of the
/// repository's `members` (read by writer, so no number of strangers' records can push a
/// member's out), then one page of everyone's, ordered by writer. Each record once. Empty on a
/// contract without the type.
pub async fn mirrors_of(
    client: &PlatformClient,
    core: &LoadedContract,
    repo: &RepoRef,
    pack_hash: &str,
    members: &[String],
) -> Result<Vec<PackMirror>> {
    if !core.has_document_type(DOC_PACK_MIRROR) {
        return Ok(Vec::new());
    }
    let pack = [
        QueryFilter::eq("repoId", repo_value(repo)?),
        QueryFilter::eq("packHash", hash_value(pack_hash)?),
    ];
    let by_writer = [QueryOrder::asc("$ownerId")];
    let mut members: Vec<[u8; 32]> = members
        .iter()
        .map(|m| platform::decode_identifier(m))
        .collect::<Result<_>>()?;
    members.sort_unstable();
    members.dedup();
    let mut docs = Vec::new();
    for chunk in members.chunks(MIRROR_RECORDS_READ as usize) {
        let mut filters = pack.to_vec();
        filters.push(QueryFilter::in_list(
            "$ownerId",
            chunk.iter().map(|id| FieldValue::identifier(*id)).collect(),
        ));
        docs.extend(
            client
                .query_documents(
                    core,
                    DOC_PACK_MIRROR,
                    &filters,
                    &by_writer,
                    MIRROR_RECORDS_READ,
                    None,
                )
                .await?,
        );
    }
    docs.extend(
        client
            .query_documents(
                core,
                DOC_PACK_MIRROR,
                &pack,
                &by_writer,
                MIRROR_RECORDS_READ,
                None,
            )
            .await?,
    );
    Ok(dedup_records(docs.iter().filter_map(mirror_from_doc)))
}

/// `records` with each document once (the first time it appears).
fn dedup_records(records: impl IntoIterator<Item = PackMirror>) -> Vec<PackMirror> {
    let mut seen = std::collections::BTreeSet::new();
    records
        .into_iter()
        .filter(|m| seen.insert(m.id.clone()))
        .collect()
}

/// `owner`'s record of `pack_hash` in `repo`, if any (`byHash` is unique per writer: one
/// record per pack each).
pub async fn mirror_of_owner(
    client: &PlatformClient,
    core: &LoadedContract,
    repo: &RepoRef,
    pack_hash: &str,
    owner: &str,
) -> Result<Option<PackMirror>> {
    if !core.has_document_type(DOC_PACK_MIRROR) {
        return Ok(None);
    }
    let docs = client
        .query_documents(
            core,
            DOC_PACK_MIRROR,
            &[
                QueryFilter::eq("repoId", repo_value(repo)?),
                QueryFilter::eq("packHash", hash_value(pack_hash)?),
                QueryFilter::eq(
                    "$ownerId",
                    FieldValue::identifier(platform::decode_identifier(owner)?),
                ),
            ],
            &[QueryOrder::asc("$ownerId")],
            1,
            None,
        )
        .await?;
    Ok(docs.iter().find_map(mirror_from_doc))
}

/// Whether addresses serve a pack ([`check_serves`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServeCheck {
    /// One of them served bytes that hash to the pack.
    Serves,
    /// None served it, and at least one served other bytes: a body that does not hash to the
    /// pack, or one larger than the pack (each failure, in words).
    WrongBytes(String),
    /// None answered with it: not found, refused, timed out, or none this computer reads.
    Unreachable(String),
}

/// Whether one of `uris` serves `pack_hash` (`size` bytes, when known), as a reader would read
/// it, within [`crate::storage::read::external_budget`].
pub async fn check_serves(
    reader: &PackReader,
    uris: &[String],
    pack_hash: &str,
    size: Option<u64>,
) -> ServeCheck {
    use crate::backends::https::LARGER_THAN_EXPECTED;
    use crate::storage::read::{external_budget, Missed, WRONG_BYTES};
    match reader
        .race(uris, pack_hash, size, Some(external_budget(size)))
        .await
    {
        Ok(_) => ServeCheck::Serves,
        Err(Missed::NoCandidate) => ServeCheck::Unreachable(
            "this computer reads none of these addresses (an ipfs:// address needs a read gateway in storage.toml)".into(),
        ),
        Err(Missed::Unverified { error, places }) => {
            // A body over the pack's known `size` is other bytes too, refused before it was
            // hashed. Without a size the cap is the reader's ceiling, which says nothing of the
            // pack.
            let oversized = |p: &String| size.is_some() && p.contains(LARGER_THAN_EXPECTED);
            if places.iter().any(|p| p.contains(WRONG_BYTES) || oversized(p)) {
                ServeCheck::WrongBytes(error.to_string())
            } else {
                ServeCheck::Unreachable(error.to_string())
            }
        }
    }
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

/// The `packMirror` properties recording `uris` (of `kind`) for `pack_hash` of `repo`, for
/// `core`: stamped `vis: "public"` where the contract declares it (the mainnet build's
/// `mainnet_mirror_public`, whose `repoId` reference requires it to equal the repository's).
pub fn mirror_props(
    core: &LoadedContract,
    repo: &RepoRef,
    pack_hash: &str,
    kind: u64,
    uris: &[String],
) -> Result<BTreeMap<String, FieldValue>> {
    let mut props = BTreeMap::from([
        ("repoId".to_string(), repo_value(repo)?),
        ("packHash".to_string(), hash_value(pack_hash)?),
        ("kind".to_string(), FieldValue::integer(kind)),
        ("uris".to_string(), FieldValue::text_list(uris.to_vec())),
    ]);
    if core.has_property(DOC_PACK_MIRROR, "vis") {
        crate::layout::stamp_public(&mut props);
    }
    Ok(props)
}

/// Whether `core` has the `packMirror` type, as an error naming the network when it does not.
/// Callers check it before any download or cost prompt that a record would follow.
pub fn require_support(core: &LoadedContract) -> Result<()> {
    if core.has_document_type(DOC_PACK_MIRROR) {
        return Ok(());
    }
    Err(Error::Config(
        "this network's Forge doesn't support pack mirrors yet".into(),
    ))
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
    require_support(core)?;
    let props = mirror_props(core, repo, pack_hash, kind, uris)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::ForgeIds;

    use dpp::data_contract::conversion::json::DataContractJsonConversionMethodsV0;
    use dpp::data_contract::document_type::property_constraints::DocumentSystemValues;
    use dpp::data_contract::validate_document::DataContractDocumentValidationMethodsV0;
    use dpp::data_contract::DataContract;
    use dpp::identifier::Identifier;
    use dpp::platform_value::string_encoding::Encoding;
    use dpp::version::PlatformVersion;

    const HASH: &str = "abababababababababababababababababababababababababababababababab";

    fn repo() -> RepoRef {
        RepoRef {
            forge: ForgeIds::test_forge(),
            repo_id: platform::encode_identifier([3; 32]),
            owner_id: platform::encode_identifier([4; 32]),
            name: "proj".into(),
            visibility: Visibility::Public,
        }
    }

    /// forge-core as `forge-contracts/schema/build.py` builds it with `args`, as JSON with the
    /// test owner's contract id.
    fn built_core_json(args: &[&str]) -> serde_json::Value {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../forge-contracts");
        let dir = tempfile::tempdir().expect("temp dir");
        let out = std::process::Command::new("python3")
            .arg(format!("{root}/schema/build.py"))
            .args(args)
            .arg("--out")
            .arg(dir.path())
            .output()
            .expect("python3 runs build.py");
        assert!(
            out.status.success(),
            "build.py {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let text = std::fs::read_to_string(dir.path().join("forge-core.json")).expect("built");
        let mut json: serde_json::Value = serde_json::from_str(&text).expect("contract JSON");
        let owner = Identifier::from([7u8; 32]);
        let id = DataContract::generate_data_contract_id_v0(owner, 1);
        json["id"] = serde_json::Value::String(id.to_string(Encoding::Base58));
        json["ownerId"] = serde_json::Value::String(owner.to_string(Encoding::Base58));
        json
    }

    /// `json` parsed with full validation under protocol 14 (as `test_support::rc1` parses the
    /// committed one).
    fn parsed_core(json: serde_json::Value) -> DataContract {
        let pv = PlatformVersion::get(14).expect("protocol 14");
        DataContract::from_json(json, true, pv).expect("forge-core parses")
    }

    fn built_core(args: &[&str]) -> DataContract {
        parsed_core(built_core_json(args))
    }

    /// The schema's verdict on a create of `props` by a stranger.
    fn schema_errors(c: &DataContract, props: &BTreeMap<String, FieldValue>) -> Vec<String> {
        let data: BTreeMap<String, dpp::platform_value::Value> = props
            .iter()
            .map(|(k, v)| (k.clone(), v.clone().into_value()))
            .collect();
        let pv = PlatformVersion::get(14).expect("protocol 14");
        let system = DocumentSystemValues::owned_by(Identifier::from([9u8; 32]));
        c.validate_document_properties(DOC_PACK_MIRROR, data.into(), &system, pv)
            .expect("validation runs")
            .errors
            .iter()
            .map(ToString::to_string)
            .collect()
    }

    /// The mainnet rule `mainnet_mirror_public` requires `vis: "public"` on a mirror; the testnet
    /// build has no such property. The writer stamps it exactly where the contract declares it,
    /// and both builds accept what it writes. (The rule alone, on forge-core: the full `--mainnet`
    /// set moves `packMirror` to forge-meta, which clients read from phase M-B on.)
    #[test]
    fn a_mirror_carries_vis_where_the_contract_requires_it() {
        let uris = vec!["https://m.example.com/p.pack".to_string()];
        for (args, vis) in [(&["--on", "mainnet_mirror_public"][..], true), (&[][..], false)] {
            let c = built_core(args);
            let core = LoadedContract::for_tests(c.clone());
            let props = mirror_props(&core, &repo(), HASH, 1, &uris).expect("props");
            assert_eq!(props.contains_key("vis"), vis, "{args:?}");
            assert_eq!(schema_errors(&c, &props), Vec::<String>::new(), "{args:?}");
            assert_eq!(props["packHash"], FieldValue::identifier([0xab; 32]));
            if vis {
                let mut bare = props.clone();
                bare.remove("vis");
                assert!(!schema_errors(&c, &bare).is_empty(), "mainnet requires vis");
            }
        }
    }

    #[test]
    fn a_network_without_the_mirror_type_is_named() {
        assert!(require_support(&LoadedContract::for_tests(built_core(&[]))).is_ok());
        // The same contract without the type.
        let mut json = built_core_json(&[]);
        json["documentSchemas"]
            .as_object_mut()
            .expect("documentSchemas")
            .remove(DOC_PACK_MIRROR)
            .expect("the type exists");
        let err = require_support(&LoadedContract::for_tests(parsed_core(json))).unwrap_err();
        assert!(
            err.to_string().contains("doesn't support pack mirrors"),
            "{err}"
        );
    }

    #[test]
    fn a_record_read_twice_is_listed_once() {
        let m = |id: &str| PackMirror {
            id: id.into(),
            owner_id: "o".into(),
            repo_id: "r".into(),
            pack_hash: HASH.into(),
            kind: 1,
            uris: vec!["https://m.example/p".into()],
            created_at: 1,
        };
        let got = dedup_records([m("a"), m("b"), m("a")]);
        assert_eq!(
            got.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
    }
}
