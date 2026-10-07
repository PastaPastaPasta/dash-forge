//! The `private_*` conformance vectors (`docs/security/private-repos.md` §11), shared byte for
//! byte with `forge-web/lib/private/conformance.test.ts` and generated independently by
//! `tools/private-repos-vectors/gen.py`. Unknown input keys are refused at every depth.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::doc::{self, AnchorRef, DocHeader, OpenContext, Opened};
use super::epoch::{resolve_epochs, ConfigRow, MemberRow, WrapRow};
use super::keys::{sha256, EpochKey, EpochKeys, ObjKeys};
use super::named::{self, LetterOpened};
use super::pack::{self, PackHeader};
use super::tlv::Fields;
use super::{release, wrap, PrivateError};
use crate::platform::FieldValue;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Vector {
    name: String,
    #[allow(dead_code)]
    description: String,
    case: String,
    rules: String,
    input: Value,
    expected: Value,
}

/// The fields of a `private_epoch` vector that hold 32-byte identities or ids.
const ID_KEYS: &[&str] = &["identity", "owner", "memberId", "reader", "author", "id"];
const ID_LIST_KEYS: &[&str] = &["anchors", "members", "nonMembers", "missingWraps"];

/// `value` with every identity / id string re-encoded by `f` (the `idEncoding: "base58"`
/// vectors: base58 in the vector, hex in the rule types).
fn recode_ids(value: &Value, key: Option<&str>, f: &dyn Fn(&str) -> String) -> Value {
    match value {
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, v)| {
                    let inner = if key == Some("anchors") {
                        "anchors"
                    } else {
                        k.as_str()
                    };
                    (k.clone(), recode_ids(v, Some(inner), f))
                })
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(|v| recode_ids(v, key, f)).collect()),
        Value::String(s)
            if key.is_some_and(|k| ID_KEYS.contains(&k) || ID_LIST_KEYS.contains(&k)) =>
        {
            Value::String(f(s))
        }
        other => other.clone(),
    }
}

fn h32(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}

fn nonce12(s: &str) -> [u8; 12] {
    hex::decode(s).unwrap().try_into().unwrap()
}

fn key(s: &str) -> EpochKey {
    EpochKey::from_bytes(h32(s))
}

/// Every key of `given` must survive a parse + re-serialize, at every depth.
fn assert_no_unknown_keys(given: &Value, parsed: &Value, at: &str) {
    match (given, parsed) {
        (Value::Object(g), Value::Object(p)) => {
            for (k, gv) in g {
                let pv = p
                    .get(k)
                    .unwrap_or_else(|| panic!("unknown input key `{at}.{k}`"));
                assert_no_unknown_keys(gv, pv, &format!("{at}.{k}"));
            }
        }
        (Value::Array(g), Value::Array(p)) => {
            assert_eq!(g.len(), p.len(), "{at}: array length changed in round trip");
            for (i, (gv, pv)) in g.iter().zip(p).enumerate() {
                assert_no_unknown_keys(gv, pv, &format!("{at}[{i}]"));
            }
        }
        _ => {}
    }
}

fn input<T: DeserializeOwned + Serialize>(v: &Vector) -> T {
    let parsed: T = serde_json::from_value(v.input.clone())
        .unwrap_or_else(|e| panic!("vector `{}`: {} input: {e}", v.name, v.case));
    let again = serde_json::to_value(&parsed).expect("re-serialize input");
    assert_no_unknown_keys(&v.input, &again, &format!("{} input", v.name));
    parsed
}

fn plaintext(mod251: Option<usize>, hex_: Option<&str>) -> Vec<u8> {
    match (mod251, hex_) {
        (Some(n), None) => (0..n).map(|i| u8::try_from(i % 251).unwrap()).collect(),
        (None, Some(h)) => hex::decode(h).unwrap(),
        _ => panic!("exactly one of plaintextMod251 / plaintextHex"),
    }
}

// --- inputs -----------------------------------------------------------------------------------

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KdfIn {
    repo_id: String,
    key: String,
    epoch: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RefHashIn {
    repo_id: String,
    key: String,
    epoch: u32,
    ref_name: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CollabSealIn {
    repo_id: String,
    key: String,
    epoch: u32,
    owner_id: String,
    doc_type: super::DocKind,
    nonce: String,
    props: BTreeMap<String, Value>,
}

/// Hex-encoded byte properties of a collaboration document (ids, oids, hashes, `enc`).
const COLLAB_BYTES: &[&str] = &[
    "targetId",
    "patchId",
    "sourceRepoId",
    "replyTo",
    "reviewId",
    "headOid",
    "commitOid",
    "patchManifestHash",
    "baseRefNameHash",
    "sourceRefNameHash",
    "refId",
    "enc",
];

fn collab_field(name: &str, v: &Value) -> FieldValue {
    match v {
        Value::String(h) if COLLAB_BYTES.contains(&name) => {
            FieldValue::bytes(hex::decode(h).expect("hex"))
        }
        Value::String(t) => FieldValue::text(t.clone()),
        Value::Bool(b) => FieldValue::boolean(*b),
        // `imported.createdAt` is a full-width integer, as `Imported::to_field` writes it
        Value::Number(n) if name == "createdAt" => FieldValue::uint64(n.as_u64().expect("u64")),
        Value::Number(n) => FieldValue::integer(n.as_u64().expect("u64")),
        Value::Object(m) => FieldValue::Object(
            m.iter()
                .map(|(k, v)| (k.clone(), collab_field(k, v)))
                .collect(),
        ),
        other => panic!("unexpected collab property {name}: {other}"),
    }
}

fn collab_json(v: &FieldValue) -> Value {
    match v {
        FieldValue::Bytes(b) => json!(hex::encode(b)),
        FieldValue::Bytes32(b) | FieldValue::Identifier(b) => json!(hex::encode(b)),
        FieldValue::Text(t) => json!(t),
        FieldValue::Bool(b) => json!(b),
        FieldValue::Integer(n) | FieldValue::Uint64(n) => json!(n),
        FieldValue::Signed(n) => json!(n),
        FieldValue::Object(m) => {
            Value::Object(m.iter().map(|(k, v)| (k.clone(), collab_json(v))).collect())
        }
        other @ FieldValue::List(_) => panic!("unexpected sealed property {other:?}"),
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocSealIn {
    repo_id: String,
    key: String,
    doc: DocHeader,
    fields: Fields,
    nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    anchor: Option<bool>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenCtxIn {
    keys: BTreeMap<String, String>,
    anchors: BTreeMap<String, AnchorIn>,
    members: Vec<String>,
    #[serde(default)]
    burned: Vec<u32>,
}

/// A context anchor: `statedHeight` (stated(e), §5.3) defaults to `height`, an anchor that is
/// itself the first statement of its key.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnchorIn {
    id: String,
    height: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stated_height: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocOpenIn {
    repo_id: String,
    context: OpenCtxIn,
    doc: StoredDocIn,
}

/// `DocHeader` plus `enc`; `flatten` does not combine with `deny_unknown_fields`, so `enc` is
/// split off and the rest parsed as a `DocHeader`, which refuses unknown keys itself.
#[derive(Deserialize, Serialize)]
struct StoredDocIn(BTreeMap<String, Value>);

impl StoredDocIn {
    fn split(&self) -> (DocHeader, Vec<u8>) {
        let mut m = self.0.clone();
        let enc = m
            .remove("enc")
            .and_then(|v| v.as_str().map(str::to_owned))
            .expect("enc");
        let header: DocHeader =
            serde_json::from_value(Value::Object(m.into_iter().collect())).expect("doc header");
        (header, hex::decode(enc).unwrap())
    }
}

/// A `mixed_doc_seal` vector: a members-only (v0x03) seal under the lane's epoch key.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MixedSealIn {
    repo_id: String,
    key: String,
    doc: DocHeader,
    fields: Fields,
    nonce: String,
}

/// A party of a letter vector: an identity and its ENCRYPTION key pair.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PartyIn {
    identity_id: String,
    #[serde(rename = "priv")]
    private: String,
    #[serde(rename = "pub")]
    public: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key_id: Option<u32>,
}

impl PartyIn {
    fn key(&self) -> crate::envelope::PrivateKey {
        crate::envelope::PrivateKey::from_hex(&self.private).unwrap()
    }
    fn recipient(&self) -> named::Recipient {
        named::Recipient {
            identity_id: h32(&self.identity_id),
            public_key: hex::decode(&self.public).unwrap().try_into().unwrap(),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NamedSealIn {
    repo_id: String,
    doc: DocHeader,
    fields: Fields,
    sender: PartyIn,
    recipients: Vec<PartyIn>,
    k_obj: String,
    nonce: String,
    ivs: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerKeyIn {
    id: u32,
    purpose: u8,
    key_type: u8,
    data: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReaderIn {
    identity_id: String,
    keys: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NamedOpenIn {
    repo_id: String,
    doc: StoredDocIn,
    owner_keys: Vec<OwnerKeyIn>,
    readers: Vec<ReaderIn>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactSealIn {
    repo_id: String,
    owner_id: String,
    sender: PartyIn,
    recipients: Vec<PartyIn>,
    k_obj: String,
    file_id: String,
    ivs: Vec<String>,
    plaintext_hex: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactOpenIn {
    repo_id: String,
    sealed: String,
    size_bytes: u64,
    owner_keys: Vec<OwnerKeyIn>,
    readers: Vec<ReaderIn>,
}

fn reader_keys(r: &ReaderIn) -> Vec<crate::envelope::PrivateKey> {
    r.keys
        .iter()
        .map(|k| crate::envelope::PrivateKey::from_hex(k).unwrap())
        .collect()
}

fn artifact_json(r: Result<zeroize::Zeroizing<Vec<u8>>, named::ArtifactError>) -> Value {
    match r {
        Ok(pt) => json!({ "plaintextHex": hex::encode(&*pt) }),
        Err(e) => json!({ "error": e }),
    }
}

fn owner_keys(keys: &[OwnerKeyIn]) -> Vec<named::OwnerKey> {
    keys.iter()
        .map(|k| named::OwnerKey {
            id: k.id,
            purpose: k.purpose,
            key_type: k.key_type,
            data: hex::decode(&k.data).unwrap(),
        })
        .collect()
}

fn letter_json(o: &LetterOpened) -> Value {
    match o {
        LetterOpened::Readable(l) => json!({
            "status": "readable",
            "fields": l.fields,
            "recipients": l.recipients.iter().map(hex::encode).collect::<Vec<_>>(),
            "slot": l.slot,
        }),
        LetterOpened::Unreadable(r) => json!({ "status": "unreadable", "reason": r }),
        LetterOpened::Malformed => json!({ "status": "malformed" }),
    }
}

/// Open `enc` as each reader in turn.
fn open_letters(
    repo_id: &[u8; 32],
    header: &DocHeader,
    enc: &[u8],
    owner: &[named::OwnerKey],
    readers: impl Iterator<Item = ([u8; 32], Vec<crate::envelope::PrivateKey>)>,
) -> Vec<Value> {
    readers
        .map(|(id, keys)| {
            let reader = named::Reader {
                identity_id: id,
                keys: &keys,
            };
            letter_json(&named::open(repo_id, header, enc, owner, &reader))
        })
        .collect()
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackSealIn {
    repo_id: String,
    key: String,
    epoch: u32,
    file_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    plaintext_mod251: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    plaintext_hex: Option<String>,
}

impl PackSealIn {
    fn seal(&self) -> (Vec<u8>, Vec<u8>) {
        let keys = EpochKeys::derive(&h32(&self.repo_id), self.epoch, &key(&self.key));
        let pt = plaintext(self.plaintext_mod251, self.plaintext_hex.as_deref());
        let fid: [u8; 16] = hex::decode(&self.file_id).unwrap().try_into().unwrap();
        (
            pack::seal_with_file_id(&keys, &pt, fid, pack::WRITE_SEG_LOG2).unwrap(),
            pt,
        )
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackOpenIn {
    repo_id: String,
    keys: BTreeMap<String, String>,
    sealed: String,
    size_bytes: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackRangeIn {
    seal: PackSealIn,
    range: [u64; 2],
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WrapSealIn {
    repo_id: String,
    sender_priv: String,
    sender_pub: String,
    recipient_priv: String,
    recipient_pub: String,
    key: String,
    epoch: u32,
    iv: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WrapOpenIn {
    repo_id: String,
    epoch: u32,
    wrapped: String,
    reader_priv: String,
    counterparty_pub: String,
    anchor_commit: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContentQuery {
    epoch: u32,
    created_at_block_height: u64,
    owner: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestQuery {
    header_epoch: u32,
    created_at_block_height: u64,
    owner: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EpochIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id_encoding: Option<String>,
    repo_id: String,
    reader: String,
    memberships: Vec<MemberRow>,
    configs: Vec<ConfigRow>,
    wraps: Vec<WrapRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_queries: Option<Vec<ContentQuery>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    manifest_queries: Option<Vec<ManifestQuery>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HedgeIn {
    repo_id: String,
    key: String,
    epoch: u32,
    rnd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    plaintext_mod251: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    doc: Option<DocHeader>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fields: Option<Fields>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseSealIn {
    repo_id: String,
    key: String,
    epoch: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fields: Option<release::ReleaseFields>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    manifest: Option<Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestIn {
    sealed: String,
    size_bytes: u64,
    asset_manifest: String,
    tag: String,
    notes_continue: bool,
}

/// One revision of a `private_release_fold` vector, after its open.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FoldRowIn {
    id: String,
    created_at: u64,
    epoch: u32,
    tag_name: String,
    /// `readable`, `malformed`, or the unreadable reason.
    status: String,
    /// Any string: only equality matters.
    enc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fields: Option<release::ReleaseFields>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseFoldIn {
    revisions: Vec<FoldRowIn>,
}

/// A stored release as the `private_release_open` vectors give it.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredReleaseIn {
    owner_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    epoch: Option<u32>,
    tag_name: String,
    vis: String,
    delta: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    yanked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    imported: Option<Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseOpenIn {
    repo_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context: Option<OpenCtxIn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    doc: Option<StoredReleaseIn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    keys: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    manifest: Option<ManifestIn>,
}

fn open_context(repo_id: &[u8; 32], c: &OpenCtxIn) -> OpenContext {
    OpenContext {
        keys: keyring(repo_id, &c.keys),
        anchors: c
            .anchors
            .iter()
            .map(|(e, a)| {
                let anchor = AnchorRef {
                    id: h32(&a.id),
                    height: a.height,
                    stated_height: a.stated_height.unwrap_or(a.height),
                };
                (e.parse().unwrap(), anchor)
            })
            .collect(),
        members: c.members.iter().map(|m| h32(m)).collect(),
        burned: c.burned.iter().copied().collect(),
    }
}

/// [`release::open`] as the vectors' `expected`.
fn release_open_json(ctx: &OpenContext, d: &StoredReleaseIn) -> Value {
    let malformed = json!({ "status": "malformed" });
    let Some(owner_id) = hex::decode(&d.owner_id)
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
    else {
        return malformed;
    };
    let enc = match d.enc.as_deref().map(hex::decode) {
        None => None,
        Some(Ok(e)) => Some(e),
        Some(Err(_)) => return malformed,
    };
    let stored = release::StoredRelease {
        owner_id,
        epoch: d.epoch,
        tag_name: d.tag_name.clone(),
        vis: d.vis.clone(),
        delta: d.delta,
        enc,
        plaintext: d.yanked.is_some() || d.imported.is_some(),
    };
    match release::open(ctx, &stored) {
        release::Opened::Readable(f) => json!({ "status": "readable", "fields": f }),
        release::Opened::Unreadable(r) => json!({ "status": "unreadable", "reason": r }),
        release::Opened::Malformed => malformed,
    }
}

/// [`release::fold`] over a vector's opened revisions, in the vectors' JSON.
fn release_fold_json(rows: &[FoldRowIn]) -> Value {
    let ids: Vec<Vec<u8>> = rows.iter().map(|r| hex::decode(&r.id).unwrap()).collect();
    let opened: Vec<release::Opened> = rows
        .iter()
        .map(|r| match r.status.as_str() {
            "readable" => release::Opened::Readable(Box::new(r.fields.clone().unwrap())),
            "malformed" => release::Opened::Malformed,
            reason => release::Opened::Unreadable(
                serde_json::from_value(Value::from(reason)).expect("an unreadable reason"),
            ),
        })
        .collect();
    let revs: Vec<release::Revision<'_>> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| release::Revision {
            id: &ids[i],
            created_at: r.created_at,
            epoch: r.epoch,
            tag_name: &r.tag_name,
            opened: &opened[i],
            enc: r.enc.as_bytes(),
        })
        .collect();
    let f = release::fold(&revs);
    let id = |i: &usize| rows[*i].id.clone();
    let live: serde_json::Map<String, Value> = f
        .live
        .iter()
        .map(|i| {
            let tag = rows[*i]
                .fields
                .as_ref()
                .expect("live revisions are readable");
            (tag.tag.clone(), Value::from(id(i)))
        })
        .collect();
    json!({
        "live": live,
        "history": f.history.iter().map(id).collect::<Vec<_>>(),
        "count": f.count,
        "replays": f.replays.iter().map(id).collect::<Vec<_>>(),
        "unknownTags": f.unknown_tags,
        "stale": f.stale,
        "hidden": f.hidden,
    })
}

/// `private_release_seal` / `private_release_open` / `private_release_fold` (§16).
fn run_release(v: &Vector) -> Value {
    if v.case == "private_release_seal" {
        let i: ReleaseSealIn = input(v);
        let keys = EpochKeys::derive(&h32(&i.repo_id), i.epoch, &key(&i.key));
        if let Some(m) = &i.manifest {
            let fid: [u8; 16] = hex::decode(i.file_id.as_deref().unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            let (canonical, sealed) = release::seal_manifest_with_file_id(&keys, m, fid).unwrap();
            return json!({
                "canonical": canonical,
                "header": hex::encode(&sealed[..36]),
                "sealedLen": sealed.len(),
                "packHash": hex::encode(sha256(&sealed)),
                "sealed": hex::encode(&sealed),
            });
        }
        let f = i.fields.as_ref().unwrap();
        let owner = h32(i.owner_id.as_deref().unwrap());
        return match release::seal_with_nonce(
            &keys,
            &owner,
            f,
            nonce12(i.nonce.as_deref().unwrap()),
        ) {
            Ok(s) => json!({
                "tagHash": hex::encode(keys.release_tag_hash(&f.tag)),
                "tagName": s.tag_name,
                "ad": hex::encode(s.ad),
                "tlv": hex::encode(s.tlv),
                "enc": hex::encode(&s.enc),
                "props": {
                    "tagName": s.tag_name, "vis": "private", "delta": 0, "epoch": i.epoch,
                    "enc": hex::encode(&s.enc),
                },
            }),
            Err(e) => error_json(&e),
        };
    }
    if v.case == "private_release_fold" {
        let i: ReleaseFoldIn = input(v);
        return release_fold_json(&i.revisions);
    }
    let i: ReleaseOpenIn = input(v);
    let repo_id = h32(&i.repo_id);
    if let Some(m) = &i.manifest {
        let ring = keyring(&repo_id, i.keys.as_ref().unwrap());
        return match release::open_manifest(
            &hex::decode(&m.sealed).unwrap(),
            m.size_bytes,
            &h32(&m.asset_manifest),
            &m.tag,
            m.notes_continue,
            |e| ring.get(&e),
        ) {
            Ok(manifest) => json!({ "status": "readable", "manifest": manifest }),
            Err(release::ManifestError::Mismatch) => json!({ "error": "manifestMismatch" }),
            Err(release::ManifestError::Pack(e)) => error_json(&e),
        };
    }
    let ctx = open_context(&repo_id, i.context.as_ref().unwrap());
    release_open_json(&ctx, i.doc.as_ref().unwrap())
}

// --- cases ------------------------------------------------------------------------------------

fn opened_json(o: &Opened) -> Value {
    match o {
        Opened::Readable(f) => json!({ "status": "readable", "fields": f }),
        Opened::Unreadable(r) => json!({ "status": "unreadable", "reason": r }),
        Opened::Malformed => json!({ "status": "malformed" }),
    }
}

fn error_json(e: &PrivateError) -> Value {
    let code = match e {
        PrivateError::Malformed => "malformed",
        PrivateError::TooLarge(..) => "tooLarge",
        PrivateError::SealedPackCorrupt => "sealedPackCorrupt",
        PrivateError::SizeMismatch => "sizeMismatch",
        PrivateError::NoKey(_) => "noKey",
        PrivateError::OutOfRange => "outOfRange",
        PrivateError::WrapUnreadable => "wrapUnreadable",
        PrivateError::KeyMismatch => "keyMismatch",
        PrivateError::Rng => "rng",
    };
    json!({ "error": code })
}

fn keyring(repo_id: &[u8; 32], keys: &BTreeMap<String, String>) -> BTreeMap<u32, EpochKeys> {
    keys.iter()
        .map(|(e, k)| {
            let e: u32 = e.parse().unwrap();
            (e, EpochKeys::derive(repo_id, e, &key(k)))
        })
        .collect()
}

#[allow(clippy::too_many_lines)]
fn run(v: &Vector) -> Value {
    match v.case.as_str() {
        "private_kdf" => {
            let i: KdfIn = input(v);
            let keys = EpochKeys::derive(&h32(&i.repo_id), i.epoch, &key(&i.key));
            let [prk, d, r, hedge] = keys.raw_subkeys_for_vectors();
            let mut out = json!({
                "prk": hex::encode(prk), "doc": hex::encode(d), "ref": hex::encode(r),
                "kcv": hex::encode(keys.kcv()), "commit": hex::encode(keys.commit()), "hedge": hex::encode(hedge),
            });
            if let Some(f) = &i.file_id {
                let fid: [u8; 16] = hex::decode(f).unwrap().try_into().unwrap();
                out["pack"] = json!(hex::encode(keys.raw_pack_key_for_vectors(&fid)));
            }
            out
        }
        "private_ref_hash" => {
            let i: RefHashIn = input(v);
            let keys = EpochKeys::derive(&h32(&i.repo_id), i.epoch, &key(&i.key));
            json!({
                "hash": hex::encode(keys.ref_name_hash(&i.ref_name)),
                "publicSha256": hex::encode(sha256(i.ref_name.as_bytes())),
            })
        }
        "private_doc_seal" => {
            let i: DocSealIn = input(v);
            let keys = EpochKeys::derive(&h32(&i.repo_id), i.doc.epoch, &key(&i.key));
            let nonce = nonce12(&i.nonce);
            let anchor = i.anchor.unwrap_or(false);
            match doc::seal_with_nonce(&keys, &i.doc, &i.fields, anchor, nonce) {
                Ok(enc) => {
                    let version = enc[0];
                    let ad = i.doc.ad(&keys, version).unwrap();
                    json!({
                        "ad": hex::encode(ad),
                        "tlv": hex::encode(&*super::tlv::encode(&i.fields)),
                        "enc": hex::encode(enc),
                    })
                }
                Err(e) => error_json(&e),
            }
        }
        "private_collab_seal" => {
            let i: CollabSealIn = input(v);
            let keys = EpochKeys::derive(&h32(&i.repo_id), i.epoch, &key(&i.key));
            let nonce = nonce12(&i.nonce);
            let owner = h32(&i.owner_id);
            let props = i
                .props
                .into_iter()
                .map(|(k, val)| {
                    let f = collab_field(&k, &val);
                    (k, f)
                })
                .collect();
            match crate::collab::private::seal_props_with_nonce(
                &keys, i.doc_type, owner, props, nonce,
            ) {
                Ok(sealed) => json!({
                    "props": sealed
                        .iter()
                        .map(|(k, val)| (k.clone(), collab_json(val)))
                        .collect::<serde_json::Map<_, _>>(),
                }),
                Err(e) if crate::collab::private::is_too_large(&e) => {
                    json!({ "error": "tooLarge" })
                }
                Err(e) => panic!("vector `{}`: {e}", v.name),
            }
        }
        "mixed_doc_seal" => {
            let i: MixedSealIn = input(v);
            let keys = EpochKeys::derive(&h32(&i.repo_id), i.doc.epoch, &key(&i.key));
            let nonce = nonce12(&i.nonce);
            match doc::seal_members_with_nonce(&keys, &i.doc, &i.fields, nonce) {
                Ok(enc) => {
                    let ad = i.doc.ad(&keys, doc::V3).unwrap();
                    let k_obj = keys.obj_key(&nonce, &ad);
                    let obj = ObjKeys::derive(keys.repo_id(), &k_obj);
                    let max = i.doc.kind.max_enc() - doc::MIN_V3;
                    let tlv = doc::padded(i.doc.kind, &super::tlv::encode(&i.fields), max);
                    json!({
                        "ad": hex::encode(&ad),
                        "kObj": hex::encode(*k_obj),
                        "commit": hex::encode(obj.commit()),
                        "tlv": hex::encode(&*tlv),
                        "enc": hex::encode(enc),
                    })
                }
                Err(e) => error_json(&e),
            }
        }
        "named_envelope" => {
            let i: NamedSealIn = input(v);
            let repo_id = h32(&i.repo_id);
            let sender = i.sender.key();
            let recipients: Vec<named::Recipient> =
                i.recipients.iter().map(PartyIn::recipient).collect();
            let k_obj = h32(&i.k_obj);
            let ivs: Vec<[u8; 16]> = i
                .ivs
                .iter()
                .map(|x| hex::decode(x).unwrap().try_into().unwrap())
                .collect();
            let enc = match named::seal_with(
                &repo_id,
                &sender,
                i.sender.key_id.unwrap(),
                &i.doc,
                &i.fields,
                &recipients,
                &k_obj,
                nonce12(&i.nonce),
                &ivs,
            ) {
                Ok(enc) => enc,
                Err(e) => return error_json(&e),
            };
            let n = recipients.len();
            let obj = ObjKeys::derive(&repo_id, &k_obj);
            let head = &enc[1..named::framing(n) - 28];
            let mut ad = i.doc.ad_without_keys(&repo_id, doc::V4).unwrap();
            ad.extend_from_slice(&sha256(head));
            let mut body = super::tlv::encode(&i.fields).to_vec();
            super::tlv::push_recipients(
                &mut body,
                &recipients.iter().map(|r| r.identity_id).collect::<Vec<_>>(),
            );
            let tlv = doc::padded(i.doc.kind, &body, named::max_tlv(i.doc.kind, n));
            let sender_secret = secret(&i.sender.private);
            // the SDK's own decrypt opens every slot of the letter to 0x02 ‖ KCV_obj ‖ K_obj: the
            // slots are still the encryptedFor scheme (drift check, both directions of the ECDH)
            let carrier = wrap_contract();
            for (r, slot) in i.recipients.iter().zip(head[37..].chunks(named::SLOT_LEN)) {
                let pt = crate::platform::wrap::sdk_decrypt_for_vectors(
                    &carrier,
                    slot,
                    &secret(&r.private),
                    &hex::decode(&i.sender.public).unwrap(),
                )
                .expect("the SDK opens a letter slot");
                assert_eq!(pt[0], named::SLOT_VERSION, "vector `{}`", v.name);
                assert_eq!(&pt[1..15], &obj.commit()[..14], "vector `{}`", v.name);
                assert_eq!(&pt[15..], &k_obj, "vector `{}`", v.name);
            }
            let owner = vec![named::OwnerKey {
                id: i.sender.key_id.unwrap(),
                purpose: named::PURPOSE_ENCRYPTION,
                key_type: named::KEY_TYPE_ECDSA_SECP256K1,
                data: hex::decode(&i.sender.public).unwrap(),
            }];
            let opened = open_letters(
                &repo_id,
                &i.doc,
                &enc,
                &owner,
                i.recipients
                    .iter()
                    .map(|r| (h32(&r.identity_id), vec![r.key()])),
            );
            json!({
                "shared": i.recipients.iter().map(|r| hex::encode(
                    crate::platform::wrap::shared_key_for_vectors(
                        &sender_secret,
                        &hex::decode(&r.public).unwrap(),
                    )
                )).collect::<Vec<_>>(),
                "commit": hex::encode(obj.commit()),
                "kcv": hex::encode(&obj.commit()[..14]),
                "headerSha256": hex::encode(sha256(head)),
                "ad": hex::encode(ad),
                "tlv": hex::encode(&*tlv),
                "enc": hex::encode(&enc),
                "opened": opened,
            })
        }
        "named_envelope_open" => {
            let i: NamedOpenIn = input(v);
            let repo_id = h32(&i.repo_id);
            let (header, enc) = i.doc.split();
            let owner = owner_keys(&i.owner_keys);
            let results = open_letters(
                &repo_id,
                &header,
                &enc,
                &owner,
                i.readers
                    .iter()
                    .map(|r| (h32(&r.identity_id), reader_keys(r))),
            );
            json!({ "results": results })
        }
        "named_artifact" => {
            let i: ArtifactSealIn = input(v);
            let repo_id = h32(&i.repo_id);
            let recipients: Vec<named::Recipient> =
                i.recipients.iter().map(PartyIn::recipient).collect();
            let k_obj = h32(&i.k_obj);
            let file_id: [u8; 16] = hex::decode(&i.file_id).unwrap().try_into().unwrap();
            let ivs: Vec<[u8; 16]> = i
                .ivs
                .iter()
                .map(|x| hex::decode(x).unwrap().try_into().unwrap())
                .collect();
            let plain = hex::decode(&i.plaintext_hex).unwrap();
            let sealed = named::seal_artifact_with(
                &repo_id,
                &i.sender.key(),
                i.sender.key_id.unwrap(),
                &h32(&i.owner_id),
                &recipients,
                &plain,
                &k_obj,
                file_id,
                named::ARTIFACT_SEG_LOG2,
                &ivs,
            )
            .unwrap();
            let owner = vec![named::OwnerKey {
                id: i.sender.key_id.unwrap(),
                purpose: named::PURPOSE_ENCRYPTION,
                key_type: named::KEY_TYPE_ECDSA_SECP256K1,
                data: hex::decode(&i.sender.public).unwrap(),
            }];
            for r in &i.recipients {
                let keys = [r.key()];
                let reader = named::Reader {
                    identity_id: h32(&r.identity_id),
                    keys: &keys,
                };
                let opened =
                    named::open_artifact(&repo_id, &sealed, sealed.len() as u64, &owner, &reader)
                        .unwrap();
                assert_eq!(*opened, plain, "vector `{}`", v.name);
            }
            let header_len = named::artifact_header_len(recipients.len());
            json!({
                "header": hex::encode(&sealed[..header_len]),
                "packKey": hex::encode(*ObjKeys::derive(&repo_id, &k_obj).pack_key(&file_id)),
                "sealedLen": sealed.len(),
                "packHash": hex::encode(sha256(&sealed)),
                "sealed": hex::encode(&sealed),
            })
        }
        "named_artifact_open" => {
            let i: ArtifactOpenIn = input(v);
            let repo_id = h32(&i.repo_id);
            let sealed = hex::decode(&i.sealed).unwrap();
            let owner = owner_keys(&i.owner_keys);
            let results: Vec<Value> = i
                .readers
                .iter()
                .map(|r| {
                    let keys = reader_keys(r);
                    let reader = named::Reader {
                        identity_id: h32(&r.identity_id),
                        keys: &keys,
                    };
                    artifact_json(named::open_artifact(
                        &repo_id,
                        &sealed,
                        i.size_bytes,
                        &owner,
                        &reader,
                    ))
                })
                .collect();
            json!({ "results": results })
        }
        "private_doc_open" | "mixed_doc_open" => {
            let i: DocOpenIn = input(v);
            let repo_id = h32(&i.repo_id);
            let (header, enc) = i.doc.split();
            let ctx = open_context(&repo_id, &i.context);
            opened_json(&doc::open_content(&ctx, &header, &enc))
        }
        "private_pack_seal" => {
            let i: PackSealIn = input(v);
            let (sealed, pt) = i.seal();
            let h = PackHeader::parse(&sealed, sealed.len() as u64).unwrap();
            let seg = h.seg_size() + 16;
            let tags: Vec<String> = (0..h.segments())
                .map(|s| {
                    let end = (pack::HEADER_LEN as u64 + (s + 1) * seg).min(sealed.len() as u64);
                    hex::encode(
                        &sealed[usize::try_from(end).unwrap() - 16..usize::try_from(end).unwrap()],
                    )
                })
                .collect();
            let mut out = json!({
                "header": hex::encode(&sealed[..36]),
                "segments": h.segments(),
                "sealedLen": sealed.len(),
                "tags": tags,
                "packHash": hex::encode(sha256(&sealed)),
                "plaintextSha256": hex::encode(sha256(&pt)),
            });
            if v.expected.get("sealed").is_some() {
                out["sealed"] = json!(hex::encode(&sealed));
            }
            out
        }
        "private_pack_open" => {
            let i: PackOpenIn = input(v);
            let repo_id = h32(&i.repo_id);
            let ring = keyring(&repo_id, &i.keys);
            let sealed = hex::decode(&i.sealed).unwrap();
            match pack::open(&sealed, i.size_bytes, |e| ring.get(&e)) {
                Ok(pt) => {
                    json!({ "plaintextSha256": hex::encode(sha256(&pt)), "plaintextLen": pt.len() })
                }
                Err(e) => error_json(&e),
            }
        }
        "private_pack_range" => {
            let i: PackRangeIn = input(v);
            let (sealed, _) = i.seal.seal();
            let keys = EpochKeys::derive(&h32(&i.seal.repo_id), i.seal.epoch, &key(&i.seal.key));
            let size = sealed.len() as u64;
            let [from, to] = i.range;
            // the planned range, from the header alone
            let header = PackHeader::parse(&sealed[..36], size).unwrap();
            match header.sealed_range(from, to) {
                Ok(range) => {
                    // the read through the session cache: the header (0..36) first, then only
                    // the range's segments
                    let cache = pack::HeaderCache::new();
                    let mut fetched = Vec::new();
                    let out = cache
                        .read_range(
                            &pack::PackCopy {
                                pack_hash: &sha256(&sealed),
                                copy: "copy",
                                size_bytes: size,
                            },
                            |e| (e == keys.epoch()).then_some(&keys),
                            |a, b| {
                                fetched.push([a, b]);
                                Ok::<_, ()>(
                                    sealed
                                        [usize::try_from(a).unwrap()..usize::try_from(b).unwrap()]
                                        .to_vec(),
                                )
                            },
                            from,
                            to,
                        )
                        .unwrap();
                    assert_eq!(
                        fetched,
                        vec![[0, 36], [range.start, range.end]],
                        "vector `{}`",
                        v.name
                    );
                    json!({
                        "segments": [range.first_segment, range.last_segment],
                        "sealedRange": [range.start, range.end],
                        "output": hex::encode(out),
                    })
                }
                Err(e) => error_json(&e),
            }
        }
        "private_wrap_seal" => {
            let i: WrapSealIn = input(v);
            let repo_id = h32(&i.repo_id);
            let pt = wrap::plaintext(&repo_id, i.epoch, &key(&i.key));
            // the SDK draws its own IV, so the seal direction is vectorized on the plaintext and
            // the SDK round trip in both directions; the open vectors decrypt the fixed-IV bytes
            let c = wrap_contract();
            let sender = secret(&i.sender_priv);
            let recipient_pub = hex::decode(&i.recipient_pub).unwrap();
            let parties = crate::platform::wrap::WrapParties {
                sender: &sender,
                sender_key_id: 4,
                recipient_public_key: &recipient_pub,
                recipient_key_id: 4,
            };
            let props =
                crate::platform::wrap::seal_wrap(&c, &repo_id, i.epoch, &key(&i.key), &parties)
                    .unwrap();
            assert_eq!(props.wrapped.len(), 64);
            for (reader, other) in [
                (&i.recipient_priv, &i.sender_pub),
                (&i.sender_priv, &i.recipient_pub),
            ] {
                let k = crate::platform::wrap::open_wrap(
                    &c,
                    &repo_id,
                    i.epoch,
                    &props.wrapped,
                    &secret(reader),
                    &hex::decode(other).unwrap(),
                )
                .unwrap();
                assert_eq!(k, key(&i.key), "vector `{}`: SDK round trip", v.name);
            }
            // the fixed-IV ciphertext opens through the SDK with the recipient's key
            let k = crate::platform::wrap::open_wrap(
                &c,
                &repo_id,
                i.epoch,
                &hex::decode(v.expected["wrapped"].as_str().unwrap()).unwrap(),
                &secret(&i.recipient_priv),
                &hex::decode(&i.sender_pub).unwrap(),
            )
            .unwrap();
            assert_eq!(k, key(&i.key));
            assert_eq!(&v.expected["wrapped"].as_str().unwrap()[..32], i.iv);
            json!({
                "shared": hex::encode(crate::platform::wrap::shared_key_for_vectors(
                    &secret(&i.sender_priv),
                    &hex::decode(&i.recipient_pub).unwrap(),
                )),
                "plaintext": hex::encode(&*pt),
                "wrapped": v.expected["wrapped"],
            })
        }
        "private_wrap_open" => {
            let i: WrapOpenIn = input(v);
            let repo_id = h32(&i.repo_id);
            let r = crate::platform::wrap::open_wrap(
                &wrap_contract(),
                &repo_id,
                i.epoch,
                &hex::decode(&i.wrapped).unwrap(),
                &secret(&i.reader_priv),
                &hex::decode(&i.counterparty_pub).unwrap(),
            )
            .and_then(|k| {
                wrap::check_against_anchor(
                    &repo_id,
                    i.epoch,
                    &k,
                    &hex::decode(&i.anchor_commit).unwrap(),
                )
                .map(|()| k)
            });
            match r {
                Ok(k) => json!({ "key": hex::encode(k.expose()) }),
                Err(e) => error_json(&e),
            }
        }
        "private_epoch" => {
            let base58 = v.input.get("idEncoding").is_some();
            let v = &if base58 {
                assert_eq!(v.input["idEncoding"], "base58", "vector `{}`", v.name);
                Vector {
                    input: recode_ids(&v.input, None, &|s| {
                        hex::encode(crate::platform::decode_identifier(s).expect("base58 id"))
                    }),
                    ..v.clone()
                }
            } else {
                v.clone()
            };
            let i: EpochIn = input(v);
            let repo_id = h32(&i.repo_id);
            let r = resolve_epochs(
                &repo_id,
                &h32(&i.reader),
                &i.memberships,
                &i.configs,
                &i.wraps,
            );
            let mut out = json!({
                "currentEpoch": r.current_epoch,
                "anchors": r.anchors.iter().map(|(e, a)| (e.to_string(), json!(hex::encode(a.id)))).collect::<serde_json::Map<_, _>>(),
                "readable": r.keys.keys().collect::<Vec<_>>(),
                "writeEpoch": r.write_epoch,
                "unanchored": r.unanchored,
                "alerts": r.alerts,
                "repair": r.repair,
            });
            if let Some(q) = &i.content_queries {
                out["content"] = q
                    .iter()
                    .map(|q| {
                        if r.is_late(q.epoch, q.created_at_block_height, &h32(&q.owner)) {
                            "late"
                        } else {
                            "shown"
                        }
                    })
                    .collect();
            }
            if let Some(q) = &i.manifest_queries {
                out["manifests"] = json!(q
                    .iter()
                    .map(|q| r.manifest_standing(
                        q.header_epoch,
                        q.created_at_block_height,
                        &h32(&q.owner)
                    ))
                    .collect::<Vec<_>>());
            }
            if base58 {
                recode_ids(&out, None, &|s| crate::platform::encode_identifier(h32(s)))
            } else {
                out
            }
        }
        "private_hedge" => {
            let i: HedgeIn = input(v);
            let keys = EpochKeys::derive(&h32(&i.repo_id), i.epoch, &key(&i.key));
            let rnd = h32(&i.rnd);
            if let (Some(d), Some(f)) = (&i.doc, &i.fields) {
                let ad = d.ad(&keys, 1).unwrap();
                json!({ "nonce": hex::encode(keys.hedged_nonce(&rnd, &ad, &super::tlv::encode(f))) })
            } else {
                let pt = plaintext(i.plaintext_mod251, None);
                json!({ "fileId": hex::encode(keys.hedged_file_id(&rnd, &sha256(&pt))) })
            }
        }
        "private_release_seal" | "private_release_open" | "private_release_fold" => run_release(v),
        other => panic!("vector `{}`: unknown private case `{other}`", v.name),
    }
}

fn wrap_contract() -> crate::platform::LoadedContract {
    crate::platform::wrap::test_contract()
}

fn secret(h: &str) -> crate::platform::wrap::WrapSecret {
    crate::platform::wrap::WrapSecret::from_bytes(&h32(h)).unwrap()
}

/// A CLI edit re-seals through the same transform as a create (`collab::private::reseal_edit`,
/// the web's `sealEdit`): every `private_collab_seal` vector's sealed document, opened and
/// re-sealed with its own text under the vector's nonce, gives back the vector's `enc` byte for
/// byte. So an edit writes exactly what a create of the edited text would.
#[test]
fn a_reseal_edit_is_the_create_transform() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../forge-contracts/vectors");
    let mut checked = 0usize;
    for entry in std::fs::read_dir(&dir).expect("read vectors dir") {
        let path = entry.unwrap().path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.starts_with("private_collab_seal__") {
            continue;
        }
        let v: Vector = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let Some(expected) = v.expected.get("props") else {
            continue; // tooLarge: nothing sealed
        };
        let i: CollabSealIn = input(&v);
        if i.doc_type == super::DocKind::Event {
            continue; // events are never edited
        }
        let repo_id = h32(&i.repo_id);
        let keys = EpochKeys::derive(&repo_id, i.epoch, &key(&i.key));
        let owner = h32(&i.owner_id);
        // the stored document as the chain holds it: the vector's expected (sealed) props
        let stored: BTreeMap<String, FieldValue> = expected
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, val)| (k.clone(), collab_field(k, val)))
            .collect();
        let d = crate::platform::FetchedDocument {
            id: crate::platform::encode_identifier([0x5a; 32]),
            owner_id: crate::platform::encode_identifier(owner),
            created_at: Some(1),
            created_at_block_height: Some(10),
            updated_at_block_height: None,
            updated_at: None,
            fields: stored,
            revision: Some(1),
        };
        let header = crate::keyring::header_of(i.doc_type, &d).unwrap();
        let ctx = OpenContext {
            keys: [(i.epoch, keys.clone())].into(),
            anchors: [(
                i.epoch,
                AnchorRef {
                    id: [9; 32],
                    height: 1,
                    stated_height: 1,
                },
            )]
            .into(),
            ..OpenContext::default()
        };
        let opened = crate::collab::private::open_doc(
            crate::private::doc::open_content(&ctx, &header, &d.field_bytes("enc").unwrap()),
            d,
        )
        .unwrap_or_else(|| panic!("vector `{}` does not open", v.name));
        // the edit sets the text it already has: the re-seal must be the create's bytes
        let changes: BTreeMap<String, Option<String>> = ["title", "body", "path"]
            .into_iter()
            .filter_map(|f| opened.field_str(f).map(|t| (f.to_string(), Some(t))))
            .collect();
        let sealed = crate::collab::private::reseal_edit_with_nonce(
            &keys,
            i.doc_type,
            owner,
            &opened,
            &changes,
            nonce12(&i.nonce),
        )
        .unwrap();
        let enc = sealed["enc"]
            .as_ref()
            .and_then(FieldValue::as_bytes)
            .unwrap();
        assert_eq!(
            hex::encode(enc),
            expected["enc"].as_str().unwrap(),
            "vector `{}`",
            v.name
        );
        checked += 1;
    }
    assert!(checked >= 15, "re-sealed {checked} vectors");
}

/// The vector cases (and file-name prefixes) this harness runs: the private-repository cases and
/// the mixed-visibility envelopes (members-only content, specific-people letters and artifacts).
/// The rules harness skips them.
pub(crate) const CRYPTO_CASE_PREFIXES: [&str; 4] =
    ["private_", "mixed_doc_", "named_envelope", "named_artifact"];

/// Whether `file_name` is one of [`CRYPTO_CASE_PREFIXES`].
fn is_crypto_vector(file_name: &str) -> bool {
    CRYPTO_CASE_PREFIXES
        .iter()
        .any(|p| file_name.starts_with(p))
}

#[test]
fn private_conformance_vectors() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../forge-contracts/vectors");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("read vectors dir")
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_crypto_vector)
                && p.extension().is_some_and(|x| x == "json")
        })
        .collect();
    files.sort();
    let mut ran = 0usize;
    for path in &files {
        let v: Vector = serde_json::from_slice(&std::fs::read(path).unwrap())
            .unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
        assert_eq!(v.rules, "v2", "{}", path.display());
        let got = run(&v);
        assert_eq!(got, v.expected, "vector `{}` ({})", v.name, v.case);
        ran += 1;
    }
    assert!(ran >= 298, "ran {ran} private vectors, expected 298+");
    println!("private conformance: {ran} vectors green");
}
