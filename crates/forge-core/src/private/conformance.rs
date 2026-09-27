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
use super::keys::{sha256, EpochKey, EpochKeys};
use super::pack::{self, PackHeader};
use super::tlv::Fields;
use super::{wrap, PrivateError};

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
    anchors: BTreeMap<String, AnchorRef>,
    members: Vec<String>,
    #[serde(default)]
    burned: Vec<u32>,
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
            let nonce: [u8; 12] = hex::decode(&i.nonce).unwrap().try_into().unwrap();
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
        "private_doc_open" => {
            let i: DocOpenIn = input(v);
            let repo_id = h32(&i.repo_id);
            let (header, enc) = i.doc.split();
            let ctx = OpenContext {
                keys: keyring(&repo_id, &i.context.keys),
                anchors: i
                    .context
                    .anchors
                    .iter()
                    .map(|(e, a)| (e.parse().unwrap(), a.clone()))
                    .collect(),
                members: i.context.members.iter().map(|m| h32(m)).collect(),
                burned: i.context.burned.iter().copied().collect(),
            };
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
        other => panic!("vector `{}`: unknown private case `{other}`", v.name),
    }
}

fn wrap_contract() -> crate::platform::LoadedContract {
    crate::platform::wrap::test_contract()
}

fn secret(h: &str) -> crate::platform::wrap::WrapSecret {
    crate::platform::wrap::WrapSecret::from_bytes(&h32(h)).unwrap()
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
                .is_some_and(|n| n.starts_with("private_"))
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
    assert!(ran >= 168, "ran {ran} private vectors, expected 168+");
    println!("private conformance: {ran} vectors green");
}
