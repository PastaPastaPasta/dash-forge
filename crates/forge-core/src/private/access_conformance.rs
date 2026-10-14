//! The `access_notice__*` vectors and the `read` ops of the `key_letter__*` vectors
//! (`tools/private-repos-vectors/access.py`), run byte for byte.

use std::path::PathBuf;

use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

use super::access_notice::{self, AccessNotice, Askers, NoticeEntry, Threads};
use super::doc::{self, DocHeader};
use super::key_letter::{LetterDoc, LetterHead, LetterPack, ReadLetter, ReadTarget, TypedLetter};
use super::{EpochKey, EpochKeys};
use crate::rules::agent_request;
use crate::rules::v2::Role;

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap()).unwrap()
}

fn hex32(v: &Value) -> [u8; 32] {
    bytes(v).try_into().unwrap()
}

fn typed_json(t: &TypedLetter) -> Value {
    json!({ "type": t.kind, "v": t.v, "fields": Value::Object(t.fields.clone()) })
}

fn target_json(t: ReadTarget) -> Value {
    match t {
        ReadTarget::Pr(n) => json!({ "pr": n }),
        ReadTarget::Issue(n) => json!({ "issue": n }),
        ReadTarget::Branch(h) => json!({ "branch": hex::encode(h) }),
    }
}

fn read_json(r: &ReadLetter) -> Value {
    json!({
        "job": hex::encode(r.job),
        "asOf": r.as_of,
        "target": target_json(r.target),
        "docs": r.docs.iter().map(|d| json!({
            "id": hex::encode(d.id), "revision": d.revision, "key": hex::encode(*d.key),
        })).collect::<Vec<_>>(),
        "packs": r.packs.iter().map(|p| json!({
            "packHash": hex::encode(p.pack_hash), "key": hex::encode(*p.key),
        })).collect::<Vec<_>>(),
        "heads": r.heads.iter().map(|h| json!({
            "blind": hex::encode(&h.blind), "oid": hex::encode(&h.oid), "salt": hex::encode(h.salt),
        })).collect::<Vec<_>>(),
    })
}

fn read_of(v: &Value) -> ReadLetter {
    let target = v["target"].as_object().unwrap();
    let (k, n) = target.iter().next().unwrap();
    ReadLetter {
        job: hex32(&v["job"]),
        as_of: v["asOf"].as_u64().unwrap(),
        target: match k.as_str() {
            "pr" => ReadTarget::Pr(u32::try_from(n.as_u64().unwrap()).unwrap()),
            "issue" => ReadTarget::Issue(u32::try_from(n.as_u64().unwrap()).unwrap()),
            _ => ReadTarget::Branch(hex32(n)),
        },
        docs: v["docs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| LetterDoc {
                id: hex32(&d["id"]),
                revision: d["revision"].as_u64().unwrap(),
                key: Zeroizing::new(hex32(&d["key"])),
            })
            .collect(),
        packs: v["packs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| LetterPack {
                pack_hash: hex32(&p["packHash"]),
                key: Zeroizing::new(hex32(&p["key"])),
            })
            .collect(),
        heads: v["heads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| LetterHead {
                blind: bytes(&h["blind"]),
                oid: bytes(&h["oid"]),
                salt: hex32(&h["salt"]),
            })
            .collect(),
    }
}

fn notice_json(n: &AccessNotice) -> Value {
    json!({
        "bot": hex::encode(n.bot),
        "may": n.may,
        "askers": n.askers.as_str(),
        "threads": match &n.threads {
            Threads::All => json!("all"),
            Threads::Listed(ns) => json!(ns),
        },
        "processor": n.processor,
        "until": n.until,
        "revokes": n.revokes.iter().map(hex::encode).collect::<Vec<_>>(),
        "note": n.note,
        "extra": Value::Object(n.extra.clone()),
    })
}

fn notice_of(v: &Value) -> AccessNotice {
    AccessNotice {
        bot: hex32(&v["bot"]),
        may: v["may"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m.as_str().unwrap().to_owned())
            .collect(),
        askers: if v["askers"] == "writers" {
            Askers::Writers
        } else {
            Askers::Maintainers
        },
        threads: match &v["threads"] {
            Value::String(_) => Threads::All,
            ns => Threads::Listed(
                ns.as_array()
                    .unwrap()
                    .iter()
                    .map(|n| u32::try_from(n.as_u64().unwrap()).unwrap())
                    .collect(),
            ),
        },
        processor: v["processor"].as_str().map(str::to_owned),
        until: v["until"].as_u64(),
        revokes: v["revokes"].as_array().unwrap().iter().map(hex32).collect(),
        note: v["note"].as_str().unwrap().to_owned(),
        extra: v["extra"].as_object().cloned().unwrap_or_default(),
    }
}

fn format_result(t: &TypedLetter) -> Value {
    json!({
        "letter": typed_json(t),
        "plaintextHex": hex::encode(&*t.encode().unwrap()),
    })
}

fn decode_cases(i: &Value, read: impl Fn(&TypedLetter) -> (&'static str, Value)) -> Value {
    let results: Vec<Value> = i["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let mut r = Map::new();
            r.insert("name".into(), c["name"].clone());
            match TypedLetter::decode(&bytes(&c["plaintextHex"])) {
                None => {
                    r.insert("error".into(), json!("malformed"));
                }
                Some(t) => {
                    let (key, value) = read(&t);
                    if key == "read" {
                        r.insert("letter".into(), typed_json(&t));
                    }
                    r.insert(key.into(), value);
                }
            }
            Value::Object(r)
        })
        .collect();
    json!({ "results": results })
}

fn run_read_open_doc(i: &Value) -> Value {
    let repo_id = hex32(&i["repoId"]);
    let keys = EpochKeys::derive(
        &repo_id,
        u32::try_from(i["epoch"].as_u64().unwrap()).unwrap(),
        &EpochKey::from_bytes(hex32(&i["epochKey"])),
    );
    let mut wrong = Value::Null;
    let results: Vec<Value> = i["docs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            let header: DocHeader = serde_json::from_value(d["header"].clone()).unwrap();
            let enc = bytes(&d["encHex"]);
            let key = doc::read_obj_key(&keys, &header, &enc).unwrap();
            if d["name"] == "comment" {
                // a bundle's key for the same comment is the same key
                assert_eq!(doc::members_obj_key(&keys, &header, &enc).unwrap(), key);
                wrong = super::conformance::opened_json(&doc::open_shared_with_key(
                    &repo_id,
                    &header,
                    &enc,
                    &hex32(&i["wrongKey"]),
                ));
            } else {
                // a bundle does not publish a pull request's own text or an event
                assert!(doc::members_obj_key(&keys, &header, &enc).is_none());
            }
            json!({
                "name": d["name"],
                "objKey": hex::encode(*key),
                "opened": super::conformance::opened_json(&doc::open_shared_with_key(&repo_id, &header, &enc, &key)),
            })
        })
        .collect();
    json!({ "results": results, "wrongKey": wrong })
}

/// The `read` ops of a `key_letter__*` vector (`readFormat`, `readDecode`, `readOpenDoc`).
pub(crate) fn run_read(i: &Value) -> Value {
    match i["op"].as_str().unwrap() {
        "readFormat" => format_result(&read_of(&i["read"]).to_typed().unwrap()),
        "readDecode" => decode_cases(i, |t| {
            (
                "read",
                ReadLetter::from_typed(t).map_or(Value::Null, |r| read_json(&r)),
            )
        }),
        "readOpenDoc" => run_read_open_doc(i),
        other => panic!("unknown op {other}"),
    }
}

fn role_of(v: &Value) -> Option<Role> {
    v.as_str()
        .map(|s| serde_json::from_value(Value::String(s.to_owned())).unwrap())
}

fn run_notice(i: &Value) -> Value {
    match i["op"].as_str().unwrap() {
        "noticeFormat" => format_result(&notice_of(&i["notice"]).to_typed().unwrap()),
        "noticeDecode" => decode_cases(i, |t| {
            (
                "notice",
                AccessNotice::from_typed(t).map_or(Value::Null, |n| notice_json(&n)),
            )
        }),
        "noticeCurrent" => {
            let maintainers: Vec<&str> = i["maintainers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m.as_str().unwrap())
                .collect();
            let entries: Vec<NoticeEntry> = i["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| NoticeEntry {
                    id: e["id"].as_str().unwrap().to_owned(),
                    writer: e["writer"].as_str().unwrap().to_owned(),
                    created_at: e["createdAt"].as_u64().unwrap(),
                    pack_hash: [0; 32],
                    notice: notice_of(&e["notice"]),
                })
                .collect();
            let current: Map<String, Value> =
                access_notice::current(&entries, |w| maintainers.contains(&w))
                    .into_iter()
                    .map(|(bot, e)| (hex::encode(bot), json!(e.id)))
                    .collect();
            json!({ "current": current })
        }
        "ask" => {
            let results: Vec<Value> = i["cases"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    let notice = (!c["notice"].is_null()).then(|| notice_of(&c["notice"]));
                    let refusal = agent_request::check_ask(
                        notice.as_ref(),
                        role_of(&c["role"]),
                        u32::try_from(c["number"].as_u64().unwrap()).unwrap(),
                        c["membersOnly"].as_bool().unwrap(),
                        c["now"].as_u64().unwrap(),
                    )
                    .err()
                    .map_or(Value::Null, |r| serde_json::to_value(r).unwrap());
                    json!({ "name": c["name"], "refusal": refusal })
                })
                .collect();
            json!({ "results": results })
        }
        other => panic!("unknown op {other}"),
    }
}

#[test]
fn access_notice_conformance_vectors() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../forge-contracts/vectors");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&format!("{}__", access_notice::VECTOR_CASE)))
        })
        .collect();
    files.sort();
    for path in &files {
        let v: Map<String, Value> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(
            run_notice(&v["input"]),
            v["expected"],
            "vector {}",
            path.display()
        );
    }
    assert!(
        files.len() >= 7,
        "ran {} access notice vectors",
        files.len()
    );
}
