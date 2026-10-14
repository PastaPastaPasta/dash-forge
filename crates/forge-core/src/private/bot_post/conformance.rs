//! The `bot_post__*` vectors (`tools/private-repos-vectors/bot_post.py`), run byte for byte.

use std::path::PathBuf;

use serde_json::{json, Map, Value};

use super::{obj_key, open, seal_with_nonce, PostKey, PostKeyLetter, VECTOR_CASE};
use crate::private::conformance::{
    error_json, h32, nonce12, open_context, opened_json, OpenCtxIn, StoredDocIn,
};
use crate::private::doc::{self, DocHeader, MIN_V3};
use crate::private::key_letter::TypedLetter;
use crate::private::{tlv, EpochKey, EpochKeys, Fields};

fn header(v: &Value) -> DocHeader {
    serde_json::from_value(v.clone()).expect("doc header")
}

fn stored(v: &Value) -> (DocHeader, Vec<u8>) {
    serde_json::from_value::<StoredDocIn>(v.clone())
        .expect("stored doc")
        .split()
}

fn post_key(i: &Value, epoch: u32) -> PostKey {
    PostKey::new(
        &h32(i["repoId"].as_str().unwrap()),
        epoch,
        &h32(i["bot"].as_str().unwrap()),
        &h32(i["w"].as_str().unwrap()),
    )
}

fn run_post_key(i: &Value) -> Value {
    let repo_id = h32(i["repoId"].as_str().unwrap());
    let epoch = u32::try_from(i["epoch"].as_u64().unwrap()).unwrap();
    let keys = EpochKeys::derive(
        &repo_id,
        epoch,
        &EpochKey::from_bytes(h32(i["key"].as_str().unwrap())),
    );
    let post = PostKey::derive(&keys, &h32(i["bot"].as_str().unwrap()));
    json!({ "w": hex::encode(post.key()) })
}

fn run_seal(i: &Value) -> Value {
    let h = header(&i["doc"]);
    let fields: Fields = serde_json::from_value(i["fields"].clone()).unwrap();
    // the key is the bot's, for epoch 0; a header under another epoch is the refusal under test
    let post = post_key(i, 0);
    match seal_with_nonce(&post, &h, &fields, nonce12(i["nonce"].as_str().unwrap())) {
        Ok(enc) => {
            let ad = h
                .ad_in(&h32(i["repoId"].as_str().unwrap()), super::V5)
                .unwrap();
            let max = h.kind.max_enc() - MIN_V3;
            let pt = doc::padded(h.kind, &tlv::encode(&fields), max);
            json!({
                "ad": hex::encode(ad),
                "kObj": hex::encode(*obj_key(&post, &h, &enc).expect("commits")),
                "commit": hex::encode(&enc[13..45]),
                "tlv": hex::encode(&*pt),
                "enc": hex::encode(&enc),
            })
        }
        Err(e) => error_json(&e),
    }
}

fn run_open(i: &Value) -> Value {
    let repo_id = h32(i["repoId"].as_str().unwrap());
    let c: OpenCtxIn = serde_json::from_value(i["context"].clone()).unwrap();
    let (h, enc) = stored(&i["doc"]);
    opened_json(&doc::open_content(&open_context(&repo_id, &c), &h, &enc))
}

fn run_open_with_post_key(i: &Value) -> Value {
    let (h, enc) = stored(&i["doc"]);
    let post = post_key(i, u32::try_from(i["epoch"].as_u64().unwrap()).unwrap());
    opened_json(&open(&post, &h, &enc))
}

fn run_obj_key(i: &Value) -> Value {
    let repo_id = h32(i["repoId"].as_str().unwrap());
    let (h, enc) = stored(&i["doc"]);
    let keys = EpochKeys::derive(
        &repo_id,
        h.epoch,
        &EpochKey::from_bytes(h32(i["key"].as_str().unwrap())),
    );
    match doc::members_obj_key(&keys, &h, &enc) {
        Some(k) => json!({
            "kObj": hex::encode(*k),
            "opened": opened_json(&doc::open_members_with_key(&repo_id, &h, &enc, &k)),
        }),
        None => json!({ "kObj": null, "opened": null }),
    }
}

fn run_letter(i: &Value) -> Value {
    let letter = PostKeyLetter {
        epoch: u32::try_from(i["epoch"].as_u64().unwrap()).unwrap(),
        key: zeroize::Zeroizing::new(h32(i["key"].as_str().unwrap())),
    };
    let pt = letter.to_typed().encode().unwrap();
    json!({ "plaintext": hex::encode(&*pt) })
}

fn run_letter_decode(i: &Value) -> Value {
    let pt = hex::decode(i["plaintext"].as_str().unwrap()).unwrap();
    match TypedLetter::decode(&pt)
        .as_ref()
        .and_then(PostKeyLetter::from_typed)
    {
        Some(l) => json!({ "epoch": l.epoch, "key": hex::encode(*l.key) }),
        None => Value::Null,
    }
}

#[test]
fn bot_post_conformance_vectors() {
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
            "postKey" => run_post_key(i),
            "seal" => run_seal(i),
            "open" => run_open(i),
            "openWithPostKey" => run_open_with_post_key(i),
            "objKey" => run_obj_key(i),
            "letter" => run_letter(i),
            "letterDecode" => run_letter_decode(i),
            other => panic!("{}: unknown op {other}", path.display()),
        };
        assert_eq!(got, v["expected"], "vector {}", path.display());
        ran += 1;
    }
    assert!(ran >= 40, "expected 40+ bot_post vectors, ran {ran}");
}
