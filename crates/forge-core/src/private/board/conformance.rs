//! The `sealed_board__*` vectors (`tools/private-repos-vectors/boards.py`, an independent
//! Python reference over `private-repos.md` §4.6), run byte for byte, as forge-web's
//! `lib/private/board.conformance.test.ts` runs them. Unknown input keys are refused.

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    open, parse, seal, seal_with_nonce, Bind, BoardFields, CardFields, Content, Opened,
    StoredBoardDoc, VECTOR_CASE,
};
use crate::private::conformance::{h32, key, nonce12, open_context, OpenCtxIn, Vector};
use crate::private::{doc, EpochKeys, PrivateError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocIn {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    key: Option<u64>,
    #[serde(default)]
    board: Option<u64>,
    #[serde(default)]
    item: Option<String>,
    #[serde(default)]
    owner_id: Option<String>,
    #[serde(default)]
    epoch: Option<u64>,
    #[serde(default)]
    plaintext: Option<bool>,
    #[serde(default)]
    enc: Option<String>,
}

impl DocIn {
    /// The bind, or `None` for a key or board out of u32 range (malformed input).
    fn bind(&self) -> Option<Bind> {
        let u32_of = |v: Option<u64>| v.and_then(|n| u32::try_from(n).ok());
        Some(match self.kind.as_str() {
            "board" => Bind::Board {
                key: u32_of(self.key)?,
            },
            "card" => Bind::Card {
                board: u32_of(self.board)?,
                item: h32(self.item.as_deref()?),
            },
            other => panic!("unknown doc type {other}"),
        })
    }
}

/// A card's fields as the vectors give them: `col` may be out of the byte's range.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FieldsIn {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    spec: Option<String>,
    #[serde(default)]
    col: Option<i64>,
    #[serde(default)]
    rank: Option<String>,
    #[serde(default)]
    f: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct In {
    op: String,
    repo_id: String,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    epoch: Option<u32>,
    #[serde(default)]
    owner_id: Option<String>,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    context: Option<Value>,
    doc: DocIn,
    #[serde(default)]
    fields: Option<FieldsIn>,
}

fn content_of(bind: &Bind, f: FieldsIn) -> Option<Content> {
    Some(match bind {
        Bind::Board { .. } => Content::Board(BoardFields {
            name: f.name.unwrap_or_default(),
            spec: f.spec.unwrap_or_default(),
        }),
        Bind::Card { .. } => Content::Card(CardFields {
            col: f.col.map(u8::try_from).transpose().ok()?,
            rank: f.rank,
            f: f.f,
        }),
    })
}

fn content_json(c: &Content) -> Value {
    match c {
        Content::Board(f) => serde_json::to_value(f).unwrap(),
        Content::Card(f) => serde_json::to_value(f).unwrap(),
    }
}

#[allow(clippy::many_single_char_names)] // the vector's input, keys, bind, content, doc
fn run(v: &Vector) -> Value {
    let i: In = serde_json::from_value(v.input.clone())
        .unwrap_or_else(|e| panic!("vector `{}`: input: {e}", v.name));
    let repo_id = h32(&i.repo_id);
    if i.op == "seal" {
        let keys = EpochKeys::derive(&repo_id, i.epoch.unwrap(), &key(i.key.as_deref().unwrap()));
        let owner = h32(i.owner_id.as_deref().unwrap());
        let bind = i.doc.bind().unwrap();
        // a value no field holds (a column of 256) is refused as the writer refuses it
        let Some(c) = content_of(&bind, i.fields.unwrap()) else {
            return json!({ "error": "malformed" });
        };
        return match seal_with_nonce(
            &keys,
            &owner,
            &bind,
            &c,
            nonce12(i.nonce.as_deref().unwrap()),
        ) {
            Ok(s) => {
                // what the writer seals is what a reader accepts
                assert_eq!(parse(&bind, &s.tlv).as_ref(), Some(&c), "{}", v.name);
                json!({
                    "ad": hex::encode(&s.ad),
                    "tlv": hex::encode(&*s.tlv),
                    "enc": hex::encode(&s.enc),
                })
            }
            Err(PrivateError::Malformed) => json!({ "error": "malformed" }),
            Err(e) => panic!("vector `{}`: {e}", v.name),
        };
    }
    assert_eq!(i.op, "open", "{}", v.name);
    let c: OpenCtxIn = serde_json::from_value(i.context.unwrap()).unwrap();
    let ctx = open_context(&repo_id, &c);
    let d = &i.doc;
    let stored = StoredBoardDoc {
        bind: d.bind().unwrap(),
        owner_id: h32(d.owner_id.as_deref().unwrap()),
        epoch: d.epoch.and_then(|e| u32::try_from(e).ok()),
        enc: d.enc.as_deref().map(|e| hex::decode(e).unwrap()),
        plaintext: d.plaintext == Some(true),
    };
    match open(&ctx, &stored) {
        Opened::Readable(c) => json!({ "status": "readable", "fields": content_json(&c) }),
        Opened::Unreadable(r) => json!({ "status": "unreadable", "reason": r }),
        Opened::Malformed => json!({ "status": "malformed" }),
    }
}

/// THE PARITY PROOF for sealed boards and cards: every `sealed_board__*` vector.
#[test]
fn sealed_board_vectors() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../forge-contracts/vectors");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("read vectors dir")
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.extension().is_some_and(|x| x == "json")
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("sealed_board__"))
        })
        .collect();
    files.sort();
    let (mut seals, mut opens) = (0, 0);
    for path in &files {
        let v: Vector = serde_json::from_slice(&std::fs::read(path).unwrap())
            .unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
        assert_eq!(v.case, VECTOR_CASE, "{}", path.display());
        if v.input["op"] == "seal" {
            seals += 1;
        } else {
            opens += 1;
        }
        assert_eq!(run(&v), v.expected, "vector `{}`", v.name);
    }
    assert!(
        seals >= 15 && opens >= 20,
        "ran {seals} seal and {opens} open vectors"
    );
    println!("sealed_board: {} vectors green", seals + opens);
}

/// A hedged seal never repeats, and both kinds open to what was sealed.
#[test]
fn a_hedged_seal_round_trips_and_never_repeats() {
    let keys = EpochKeys::derive(
        &[0x11; 32],
        3,
        &crate::private::EpochKey::from_bytes([5; 32]),
    );
    let owner = [0x22; 32];
    let ctx = doc::OpenContext {
        keys: [(3, keys.clone())].into(),
        anchors: [(
            3,
            doc::AnchorRef {
                id: [0; 32],
                height: 1,
                stated_height: 1,
            },
        )]
        .into(),
        ..doc::OpenContext::default()
    };
    let board = Content::Board(BoardFields {
        name: "Roadmap".into(),
        spec: r#"{"v":1,"columns":[{"id":1,"name":"Todo"}]}"#.into(),
    });
    let bind = Bind::Board { key: 9 };
    let a = seal(&keys, &owner, &bind, &board).unwrap();
    let b = seal(&keys, &owner, &bind, &board).unwrap();
    assert_ne!(a, b);
    let stored = |bind, enc| StoredBoardDoc {
        bind,
        owner_id: owner,
        epoch: Some(3),
        enc: Some(enc),
        plaintext: false,
    };
    assert_eq!(
        open(&ctx, &stored(bind, a)),
        Opened::Readable(board.clone())
    );
    let card = Content::Card(CardFields {
        col: Some(1),
        rank: Some("Vx".into()),
        f: Some(r#"{"1":2}"#.into()),
    });
    let bind = Bind::Card {
        board: 9,
        item: [0x44; 32],
    };
    let c = seal(&keys, &owner, &bind, &card).unwrap();
    assert_eq!(open(&ctx, &stored(bind, c.clone())), Opened::Readable(card));
    // the same card bound to another item does not open
    let moved = Bind::Card {
        board: 9,
        item: [0x45; 32],
    };
    assert_eq!(
        open(&ctx, &stored(moved, c)),
        Opened::Unreadable(doc::Unreadable::BadTag)
    );
    // a board's content is refused as a card's
    assert!(seal(&keys, &owner, &bind, &board).is_err());
}
