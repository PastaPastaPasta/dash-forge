//! The `key_letter__*` vectors (`tools/private-repos-vectors/key_letters.py`), run byte for byte.

use std::path::PathBuf;

use serde_json::{json, Map, Value};

use super::{open, BranchLetter, LetterError, ManifestCheck, TypedLetter, VECTOR_CASE};
use crate::envelope::PrivateKey;
use crate::private::named::{self, OwnerKey, Reader, Recipient};
use crate::private::{EpochKey, EpochKeys, PackHeader};

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap()).unwrap()
}

fn hex32(v: &Value) -> [u8; 32] {
    bytes(v).try_into().unwrap()
}

fn typed(v: &Value) -> TypedLetter {
    TypedLetter {
        kind: v["type"].as_str().unwrap().to_owned(),
        v: v["v"].as_u64().unwrap(),
        fields: v["fields"].as_object().unwrap().clone(),
    }
}

fn typed_json(t: &TypedLetter) -> Value {
    json!({ "type": t.kind, "v": t.v, "fields": Value::Object(t.fields.clone()) })
}

fn branch_json(b: &BranchLetter) -> Value {
    json!({
        "name": b.name,
        "refNameHash": hex::encode(b.ref_name_hash),
        "head": {
            "blind": hex::encode(&b.head.blind),
            "oid": hex::encode(&b.head.oid),
            "salt": hex::encode(b.head.salt),
        },
        "packs": b.packs.iter().map(|p| json!({
            "packHash": hex::encode(p.pack_hash),
            "key": hex::encode(*p.key),
        })).collect::<Vec<_>>(),
        "asOf": b.as_of,
    })
}

fn branch_of(v: &Value) -> BranchLetter {
    let head = &v["head"];
    BranchLetter {
        name: v["name"].as_str().unwrap().to_owned(),
        ref_name_hash: hex32(&v["refNameHash"]),
        head: super::LetterHead {
            blind: bytes(&head["blind"]),
            oid: bytes(&head["oid"]),
            salt: hex32(&head["salt"]),
        },
        packs: v["packs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| super::LetterPack {
                pack_hash: hex32(&p["packHash"]),
                key: zeroize::Zeroizing::new(hex32(&p["key"])),
            })
            .collect(),
        as_of: v["asOf"].as_u64().unwrap(),
    }
}

fn owner_keys(v: &Value) -> Vec<OwnerKey> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|k| OwnerKey {
            id: u32::try_from(k["id"].as_u64().unwrap()).unwrap(),
            purpose: u8::try_from(k["purpose"].as_u64().unwrap()).unwrap(),
            key_type: u8::try_from(k["keyType"].as_u64().unwrap()).unwrap(),
            data: bytes(&k["data"]),
        })
        .collect()
}

fn run_format(i: &Value) -> Value {
    let letter = match i.get("branch") {
        Some(b) => {
            let b = branch_of(b);
            let t = b.to_typed().expect("a well-formed branch letter");
            assert_eq!(BranchLetter::from_typed(&t).as_ref(), Some(&b));
            t
        }
        None => typed(&i["letter"]),
    };
    match letter.encode() {
        Ok(pt) => {
            assert_eq!(TypedLetter::decode(&pt).as_ref(), Some(&letter));
            json!({ "letter": typed_json(&letter), "plaintextHex": hex::encode(&*pt) })
        }
        Err(LetterError::TooLarge(_)) => json!({ "error": "tooLarge" }),
        Err(LetterError::Invalid(_)) => json!({ "error": "invalid" }),
    }
}

fn run_decode(i: &Value) -> Value {
    let results: Vec<Value> = i["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let name = c["name"].clone();
            match TypedLetter::decode(&bytes(&c["plaintextHex"])) {
                None => json!({ "name": name, "error": "malformed" }),
                Some(t) => json!({
                    "name": name,
                    "letter": typed_json(&t),
                    "branch": BranchLetter::from_typed(&t).as_ref().map_or(Value::Null, branch_json),
                }),
            }
        })
        .collect();
    json!({ "results": results })
}

fn run_seal(i: &Value) -> Value {
    let sender = PrivateKey::from_slice(&bytes(&i["sender"]["priv"])).unwrap();
    let recipients: Vec<Recipient> = i["recipients"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| Recipient {
            identity_id: hex32(&r["identityId"]),
            public_key: bytes(&r["publicKey"]).try_into().unwrap(),
        })
        .collect();
    let ivs: Vec<[u8; 16]> = i["ivs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| bytes(v).try_into().unwrap())
        .collect();
    let plain = typed(&i["letter"]).encode().unwrap();
    let sealed = named::seal_artifact_with(
        &hex32(&i["repoId"]),
        &sender,
        u32::try_from(i["senderKeyId"].as_u64().unwrap()).unwrap(),
        &hex32(&i["ownerId"]),
        &recipients,
        &plain,
        &hex32(&i["kObj"]),
        bytes(&i["fileId"]).try_into().unwrap(),
        named::ARTIFACT_SEG_LOG2,
        &ivs,
    )
    .unwrap();
    json!({
        "sealedHex": hex::encode(&sealed),
        "packHash": hex::encode(crate::private::keys::sha256(&sealed)),
        "sizeBytes": sealed.len(),
    })
}

fn run_open(i: &Value) -> Value {
    let repo_id = hex32(&i["repoId"]);
    let sealed = bytes(&i["sealedHex"]);
    let pack_hash = hex32(&i["manifest"]["packHash"]);
    let check = ManifestCheck {
        pack_hash: &pack_hash,
        size_bytes: i["manifest"]["sizeBytes"].as_u64().unwrap(),
    };
    let okeys = owner_keys(&i["ownerKeys"]);
    let results: Vec<Value> = i["readers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let keys: Vec<PrivateKey> = r["keys"]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| PrivateKey::from_slice(&bytes(k)).unwrap())
                .collect();
            let reader = Reader {
                identity_id: hex32(&r["identityId"]),
                keys: &keys,
            };
            match open(&repo_id, &check, &sealed, &okeys, &reader) {
                Ok(o) => json!({ "letter": typed_json(&o.letter), "recipients": o.recipients }),
                Err(e) => json!({ "error": e }),
            }
        })
        .collect();
    json!({ "results": results })
}

fn run_file_key(i: &Value) -> Value {
    let sealed = bytes(&i["sealedHex"]);
    let epoch = u32::try_from(i["epoch"].as_u64().unwrap()).unwrap();
    let keys = EpochKeys::derive(
        &hex32(&i["repoId"]),
        epoch,
        &EpochKey::from_bytes(hex32(&i["epochKey"])),
    );
    let header = PackHeader::parse(&sealed, sealed.len() as u64).unwrap();
    let key = header.file_key(&keys).unwrap();
    let plain =
        crate::private::pack::open_with_file_key(&sealed, sealed.len() as u64, &key).unwrap();
    let wrong = crate::private::pack::open_with_file_key(
        &sealed,
        sealed.len() as u64,
        &hex32(&i["wrongKey"]),
    );
    assert_eq!(
        wrong,
        Err(crate::private::PrivateError::SealedPackCorrupt),
        "a wrong key"
    );
    json!({
        "fileKey": hex::encode(*key),
        "plaintextSha256": hex::encode(crate::private::keys::sha256(&plain)),
        "plaintextLen": plain.len(),
        "wrongKey": "sealedPackCorrupt",
    })
}

#[test]
fn key_letter_conformance_vectors() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../forge-contracts/vectors");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&format!("{VECTOR_CASE}__")))
        })
        .collect();
    files.sort();
    let mut ran = 0;
    for path in &files {
        let v: Map<String, Value> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let i = &v["input"];
        let got = match i["op"].as_str().unwrap() {
            "format" => run_format(i),
            "decode" => run_decode(i),
            "seal" => run_seal(i),
            "open" => run_open(i),
            "fileKey" => run_file_key(i),
            "readFormat" | "readDecode" | "readOpenDoc" => {
                crate::private::access_conformance::run_read(i)
            }
            other => panic!("{}: unknown op {other}", path.display()),
        };
        assert_eq!(got, v["expected"], "vector {}", path.display());
        ran += 1;
    }
    assert!(ran >= 15, "ran {ran} key letter vectors, expected 15+");
}
