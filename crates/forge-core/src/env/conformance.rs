//! The `env_snapshot__*` vectors (`tools/private-repos-vectors/env.py`), run byte for byte.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde_json::{json, Value};

use super::chain::{self, EnvHistory, SnapshotRef};
use super::codec::{self, ManifestCheck, OpenKeys};
use super::format::{Snapshot, Var, VarType};
use super::{default_audience, Audience};
use crate::envelope::PrivateKey;
use crate::private::named::{OwnerKey, Reader, Recipient};
use crate::private::{EpochKey, EpochKeys};

/// The file-name prefix of every vector this harness runs (the rules harnesses skip it).
pub(crate) const CASE_PREFIX: &str = "env_snapshot";

fn hex32(v: &Value) -> [u8; 32] {
    hex::decode(v.as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap()
}

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap()).unwrap()
}

fn snapshot_of(v: &Value) -> Snapshot {
    Snapshot {
        env: v["env"].as_str().unwrap().into(),
        audience: Audience::parse(v["audience"].as_str().unwrap()).unwrap(),
        generated_at: v["generatedAt"].as_u64().unwrap(),
        to: v
            .get("to")
            .map(|t| {
                t.as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_str().unwrap().to_owned())
                    .collect()
            })
            .unwrap_or_default(),
        vars: v["vars"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, e)| {
                (
                    k.clone(),
                    Var {
                        value: e["value"].as_str().unwrap().into(),
                        kind: if e["type"] == "secret" {
                            VarType::Secret
                        } else {
                            VarType::Variable
                        },
                        note: e["note"].as_str().unwrap_or("").into(),
                    },
                )
            })
            .collect(),
    }
}

fn snapshot_json(s: &Snapshot) -> Value {
    let mut out = json!({
        "env": s.env,
        "audience": s.audience.as_str(),
        "generatedAt": s.generated_at,
        "vars": s.vars.iter().map(|(k, v)| (k.clone(), json!({
            "type": v.kind.as_str(), "value": v.value, "note": v.note,
        }))).collect::<serde_json::Map<String, Value>>(),
    });
    if s.audience == Audience::Maintainers {
        out["to"] = json!(s.to);
    }
    out
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

fn private_keys(reader: &Value) -> Vec<PrivateKey> {
    reader["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| PrivateKey::from_slice(&bytes(k)).unwrap())
        .collect()
}

/// Open `sealed` for `manifest` as `reader` with `epoch_keys`, as the vectors write the result.
fn open_one(
    repo_id: &[u8; 32],
    manifest: &Value,
    sealed: &[u8],
    okeys: &[OwnerKey],
    reader: &Value,
    epoch_keys: &Value,
) -> Value {
    let keys: BTreeMap<u32, EpochKeys> = epoch_keys
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            let epoch = u32::try_from(e["epoch"].as_u64().unwrap()).unwrap();
            let key = EpochKey::from_bytes(hex32(&e["key"]));
            (epoch, EpochKeys::derive(repo_id, epoch, &key))
        })
        .collect();
    let lookup = |e: u32| keys.get(&e);
    let reader_keys = private_keys(reader);
    let open_keys = OpenKeys {
        repo_id,
        owner_keys: okeys,
        reader: Some(Reader {
            identity_id: hex32(&reader["identityId"]),
            keys: &reader_keys,
        }),
        epoch_keys: &lookup,
    };
    let pack_hash = hex32(&manifest["packHash"]);
    let check = ManifestCheck {
        owner_id: manifest["ownerId"].as_str().unwrap(),
        pack_hash: &pack_hash,
        size_bytes: manifest["sizeBytes"].as_u64().unwrap(),
    };
    match codec::open(&check, sealed, &open_keys) {
        Ok(s) => json!({ "snapshot": snapshot_json(&s) }),
        Err(e) => json!({ "error": e }),
    }
}

fn run_open(inp: &Value, expected: &Value) -> Value {
    let repo_id = hex32(&inp["repoId"]);
    if let Some(cases) = inp.get("cases") {
        let results: Vec<Value> = cases
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                open_one(
                    &repo_id,
                    &c["manifest"],
                    &bytes(&c["sealed"]),
                    &owner_keys(&c["ownerKeys"]),
                    &c["reader"],
                    &c["epochKeys"],
                )
            })
            .collect();
        return json!({ "results": results });
    }
    let sealed = bytes(&inp["sealed"]);
    let okeys = owner_keys(&inp["ownerKeys"]);
    let mut out = serde_json::Map::new();
    if let Some(seal) = inp.get("seal") {
        // the writer: the canonical padded plaintext, then the deterministic seal
        let snap = snapshot_of(&inp["snapshot"]);
        let pt = snap.encode().unwrap();
        out.insert("plaintextHex".into(), json!(hex::encode(&*pt)));
        let file_id: [u8; 16] = bytes(&seal["fileId"]).try_into().unwrap();
        let resealed = if let Some(key) = seal.get("epochKey") {
            let epoch = u32::try_from(seal["epoch"].as_u64().unwrap()).unwrap();
            let keys = EpochKeys::derive(&repo_id, epoch, &EpochKey::from_bytes(hex32(key)));
            codec::seal_members_with(&keys, &snap, file_id).unwrap()
        } else {
            let sender = &private_keys(&seal["sender"])[0];
            let recipients: Vec<Recipient> = seal["recipients"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| Recipient {
                    identity_id: hex32(&r["identityId"]),
                    public_key: bytes(&r["pub"]).try_into().unwrap(),
                })
                .collect();
            let ivs: Vec<[u8; 16]> = seal["ivs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| bytes(i).try_into().unwrap())
                .collect();
            codec::seal_maintainers_with(
                &repo_id,
                sender,
                u32::try_from(seal["senderKeyId"].as_u64().unwrap()).unwrap(),
                &hex32(&seal["sender"]["identityId"]),
                &recipients,
                &snap,
                &hex32(&seal["kObj"]),
                file_id,
                &ivs,
            )
            .unwrap()
        };
        assert_eq!(
            hex::encode(&resealed),
            hex::encode(&sealed),
            "resealed bytes"
        );
        out.insert(
            "packHash".into(),
            json!(hex::encode(crate::private::keys::sha256(&sealed))),
        );
    }
    let results: Vec<Value> = inp["readers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            open_one(
                &repo_id,
                &inp["manifest"],
                &sealed,
                &okeys,
                &r["reader"],
                &r["epochKeys"],
            )
        })
        .collect();
    out.insert("results".into(), json!(results));
    let _ = expected;
    Value::Object(out)
}

fn run_resolve(inp: &Value) -> Value {
    let maintainers: BTreeSet<String> = inp["maintainers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m.as_str().unwrap().to_owned())
        .collect();
    let manifests: Vec<SnapshotRef> = inp["manifests"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| SnapshotRef {
            id: m["id"].as_str().unwrap().into(),
            owner_id: m["ownerId"].as_str().unwrap().into(),
            pack_hash: hex32(&m["packHash"]),
            supersedes: m["supersedes"]
                .as_array()
                .unwrap()
                .iter()
                .map(hex32)
                .collect(),
            height: m["height"].as_u64().unwrap(),
        })
        .collect();
    let opened: BTreeMap<[u8; 32], Option<String>> = inp["opened"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(h, v)| {
            (
                hex32(&json!(h)),
                v.get("env").and_then(Value::as_str).map(str::to_owned),
            )
        })
        .collect();
    let r = chain::resolve(&maintainers, &manifests, |h| {
        opened.get(h).and_then(|e| e.as_deref())
    });
    serde_json::to_value(r).unwrap()
}

fn run_exposure(inp: &Value) -> Value {
    let snap = |v: &Value| Snapshot {
        env: "x".into(),
        audience: Audience::parse(v["audience"].as_str().unwrap()).unwrap(),
        generated_at: 0,
        to: v
            .get("to")
            .map(|t| {
                t.as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_str().unwrap().to_owned())
                    .collect()
            })
            .unwrap_or_default(),
        vars: v["vars"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, val)| {
                (
                    k.clone(),
                    Var {
                        value: val.as_str().unwrap().into(),
                        kind: VarType::Secret,
                        note: String::new(),
                    },
                )
            })
            .collect(),
    };
    let envs: Vec<(String, Vec<Snapshot>, Vec<Snapshot>)> = inp["environments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            let list = |k: &str| e[k].as_array().unwrap().iter().map(snap).collect();
            (
                e["env"].as_str().unwrap().to_owned(),
                list("heads"),
                list("snapshots"),
            )
        })
        .collect();
    let refs: Vec<(String, Vec<&Snapshot>, Vec<&Snapshot>)> = envs
        .iter()
        .map(|(n, h, s)| (n.clone(), h.iter().collect(), s.iter().collect()))
        .collect();
    let histories: Vec<EnvHistory<'_>> = refs
        .iter()
        .map(|(env, heads, snapshots)| EnvHistory {
            env,
            heads,
            snapshots,
        })
        .collect();
    let results: Vec<Value> = inp["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            serde_json::to_value(chain::exposure(
                &histories,
                c["removed"].as_str().unwrap(),
                c["heldMembersKey"].as_bool().unwrap(),
            ))
            .unwrap()
        })
        .collect();
    json!({ "results": results })
}

fn run(v: &Value) -> Value {
    let inp = &v["input"];
    match inp["op"].as_str().unwrap() {
        "format" => json!({ "results": inp["cases"].as_array().unwrap().iter().map(|c| {
            match snapshot_of(&c["snapshot"]).encode() {
                Ok(pt) => json!({ "plaintextHex": hex::encode(&*pt), "sizeBytes": pt.len() }),
                Err(_) => json!({ "tooLarge": true }),
            }
        }).collect::<Vec<_>>() }),
        "decode" => json!({ "results": inp["cases"].as_array().unwrap().iter().map(|c| {
            match Snapshot::decode(&bytes(&c["plaintextHex"])) {
                Some(s) => json!({ "name": c["name"], "snapshot": snapshot_json(&s) }),
                None => json!({ "name": c["name"], "error": "malformed" }),
            }
        }).collect::<Vec<_>>() }),
        "open" => run_open(inp, &v["expected"]),
        "resolve" => run_resolve(inp),
        "exposure" => run_exposure(inp),
        "defaultAudience" => json!({ "results": inp["names"].as_array().unwrap().iter()
            .map(|n| default_audience(n.as_str().unwrap()).as_str()).collect::<Vec<_>>() }),
        other => panic!("unknown env_snapshot op {other}"),
    }
}

#[test]
fn env_snapshot_vectors() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../forge-contracts/vectors");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(CASE_PREFIX))
                && p.extension().is_some_and(|x| x == "json")
        })
        .collect();
    files.sort();
    let mut ran = 0;
    for path in &files {
        let v: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(v["case"], CASE_PREFIX, "{}", path.display());
        let got = run(&v);
        assert_eq!(got, v["expected"], "vector `{}`", v["name"]);
        ran += 1;
    }
    assert!(ran >= 20, "ran {ran} env_snapshot vectors, expected 20+");
}
