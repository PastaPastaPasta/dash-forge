//! The board read assembly and write merges (`docs/design/boards.md` §2.4, §3.2), offline:
//! documents as Platform returns them, sealed ones opened with fixed keys.

use std::collections::{BTreeMap, HashSet};

use super::*;
use crate::platform::{encode_identifier, FetchedDocument, FieldValue};
use crate::private::board::{self as sealed, Bind, BoardFields, CardFields, Content};
use crate::private::doc::{AnchorRef, OpenContext};
use crate::private::{EpochKey, EpochKeys};
use crate::rules::boards::{default_spec, fold_board, BoardItem, ItemKind, ItemState, Scalar};

const REPO: [u8; 32] = [0x11; 32];
const ALICE: [u8; 32] = [0xa1; 32];
const BOB: [u8; 32] = [0xb2; 32];
const ITEM: [u8; 32] = [0x44; 32];

fn doc(id: u8, owner: [u8; 32], updated: u64, fields: Vec<(&str, FieldValue)>) -> FetchedDocument {
    FetchedDocument {
        id: encode_identifier([id; 32]),
        owner_id: encode_identifier(owner),
        created_at: Some(1),
        created_at_block_height: Some(1),
        updated_at_block_height: Some(1),
        updated_at: Some(updated),
        fields: fields
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
        revision: Some(1),
    }
}

fn spec_json() -> String {
    serialize_spec(&default_spec(&encode_identifier(REPO), 0)).unwrap()
}

fn board_doc(
    id: u8,
    owner: [u8; 32],
    updated: u64,
    key: u64,
    name: &str,
    state: u64,
) -> FetchedDocument {
    doc(
        id,
        owner,
        updated,
        vec![
            ("repoId", FieldValue::identifier(REPO)),
            ("key", FieldValue::integer(key)),
            ("name", FieldValue::text(name)),
            ("spec", FieldValue::text(spec_json())),
            ("state", FieldValue::integer(state)),
        ],
    )
}

fn card_doc(id: u8, owner: [u8; 32], updated: u64, col: u64) -> FetchedDocument {
    doc(
        id,
        owner,
        updated,
        vec![
            ("repoId", FieldValue::identifier(REPO)),
            ("board", FieldValue::integer(7)),
            ("item", FieldValue::identifier(ITEM)),
            ("col", FieldValue::integer(col)),
            ("state", FieldValue::integer(0)),
        ],
    )
}

fn keys() -> (EpochKeys, OpenContext) {
    let keys = EpochKeys::derive(&REPO, 0, &EpochKey::from_bytes([3; 32]));
    let ctx = OpenContext {
        keys: [(0, keys.clone())].into(),
        anchors: [(
            0,
            AnchorRef {
                id: [9; 32],
                height: 1,
                stated_height: 1,
            },
        )]
        .into(),
        ..OpenContext::default()
    };
    (keys, ctx)
}

#[test]
fn the_newest_revision_names_a_board_and_every_revision_is_kept() {
    let docs = vec![
        board_doc(1, ALICE, 10, 7, "Roadmap", 0),
        board_doc(2, BOB, 20, 7, "Plan", 0),
        board_doc(3, ALICE, 5, 9, "Gone", 2),
        // malformed (no state): no board reads it, but it is still Bob's revision of key 9
        doc(4, BOB, 30, vec![("key", FieldValue::integer(9))]),
    ];
    let boards = boards_of(
        "home",
        &docs,
        |d| board_doc_of(d, Visibility::Public, None),
        false,
    );
    assert_eq!(boards.len(), 1);
    let b = &boards[0];
    assert_eq!(
        (b.key, b.name.as_deref(), b.state),
        (7, Some("Plan"), BoardState::Open)
    );
    assert_eq!(b.newest.owner_id, encode_identifier(BOB));
    assert_eq!(b.revisions.len(), 2);
    assert!(b.revisions[0].updated_at < b.revisions[1].updated_at);
    assert!(b.spec.is_some() && b.spec_error.is_none() && !b.sealed);
    assert_eq!(
        own_revision(b, &encode_identifier(ALICE)).map(|r| r.id.clone()),
        Some(encode_identifier([1; 32]))
    );
    let all = boards_of(
        "home",
        &docs,
        |d| board_doc_of(d, Visibility::Public, None),
        true,
    );
    assert_eq!(all.len(), 2);
    assert_eq!(all[1].state, BoardState::Deleted);
    // the malformed row is still the revision a write by Bob would replace
    assert_eq!(all[1].revisions.len(), 2);
}

#[test]
fn a_refused_definition_reads_as_a_board_without_one() {
    let mut d = board_doc(1, ALICE, 10, 7, "Roadmap", 0);
    d.fields
        .insert("spec".into(), FieldValue::text(r#"{"v":1,"columns":[]}"#));
    let b = &boards_of(
        "home",
        &[d],
        |d| board_doc_of(d, Visibility::Public, None),
        false,
    )[0];
    assert!(b.spec.is_none());
    assert_eq!(b.spec_error.as_deref(), Some("columns"));
}

#[test]
fn a_private_board_opens_with_the_keys_and_is_unreadable_without() {
    let (keys, ctx) = keys();
    let fields = BoardFields {
        name: "Roadmap".into(),
        spec: spec_json(),
    };
    let enc = sealed::seal(
        &keys,
        &ALICE,
        &Bind::Board { key: 7 },
        &Content::Board(fields),
    )
    .unwrap();
    let d = doc(
        1,
        ALICE,
        10,
        vec![
            ("repoId", FieldValue::identifier(REPO)),
            ("key", FieldValue::integer(7)),
            ("state", FieldValue::integer(1)),
            ("epoch", FieldValue::integer(0)),
            ("enc", FieldValue::bytes(enc)),
        ],
    );
    let open = |s: &sealed::StoredBoardDoc| sealed::open(&ctx, s);
    let (b, was_sealed) = board_doc_of(&d, Visibility::Private, Some(&open)).unwrap();
    assert!(was_sealed);
    assert_eq!(b.name.as_deref(), Some("Roadmap"));
    assert_eq!(b.state, 1);
    let (b, _) = board_doc_of(&d, Visibility::Private, None).unwrap();
    assert_eq!((b.name, b.spec), (None, None));
    // plaintext beside enc, and a private board without enc: malformed, skipped
    let mut both = d.clone();
    both.fields.insert("name".into(), FieldValue::text("x"));
    assert!(board_doc_of(&both, Visibility::Private, Some(&open)).is_none());
    let plain = board_doc(2, ALICE, 10, 7, "Roadmap", 0);
    assert!(board_doc_of(&plain, Visibility::Private, Some(&open)).is_none());
    // the same seal moved to another key does not open
    let mut moved = d;
    moved.fields.insert("key".into(), FieldValue::integer(8));
    let (b, _) = board_doc_of(&moved, Visibility::Private, Some(&open)).unwrap();
    assert!(b.name.is_none());
}

/// A repository made public (§18): the boards and cards sealed while it was private open with
/// the epoch keys its owner published (the reader's opener), as the web's `repo.published`
/// opens them; without those keys they read as unreadable, never dropped.
#[test]
fn a_repository_made_public_opens_its_private_era_boards_with_the_published_keys() {
    let (keys, published) = keys();
    let enc = sealed::seal(
        &keys,
        &ALICE,
        &Bind::Board { key: 7 },
        &Content::Board(BoardFields {
            name: "Roadmap".into(),
            spec: spec_json(),
        }),
    )
    .unwrap();
    let d = doc(
        1,
        ALICE,
        10,
        vec![
            ("repoId", FieldValue::identifier(REPO)),
            ("key", FieldValue::integer(7)),
            ("state", FieldValue::integer(0)),
            ("epoch", FieldValue::integer(0)),
            ("enc", FieldValue::bytes(enc)),
        ],
    );
    let open = |s: &sealed::StoredBoardDoc| sealed::open(&published, s);
    let read = |o| {
        boards_of(
            "home",
            std::slice::from_ref(&d),
            |x| board_doc_of(x, Visibility::Public, o),
            false,
        )
    };
    let b = &read(Some(&open))[0];
    assert!(b.sealed && b.spec.is_some());
    assert_eq!(b.name.as_deref(), Some("Roadmap"));
    let b = &read(None)[0];
    assert!(b.sealed && b.name.is_none());
    assert_eq!(b.spec_error.as_deref(), Some("unreadable"));
    // and a card of that era keeps its column, so a later write carries it over
    let card_enc = sealed::seal(
        &keys,
        &BOB,
        &Bind::Card {
            board: 7,
            item: ITEM,
        },
        &Content::Card(CardFields {
            col: Some(2),
            rank: Some("Vx".into()),
            f: Some(r#"{"1":2}"#.into()),
        }),
    )
    .unwrap();
    let c = doc(
        2,
        BOB,
        11,
        vec![
            ("repoId", FieldValue::identifier(REPO)),
            ("board", FieldValue::integer(7)),
            ("item", FieldValue::identifier(ITEM)),
            ("state", FieldValue::integer(0)),
            ("epoch", FieldValue::integer(0)),
            ("enc", FieldValue::bytes(card_enc)),
        ],
    );
    let opened = card_doc_of(&c, Visibility::Public, Some(&open)).unwrap();
    assert!(!opened.unreadable);
    assert_eq!(opened.card.col, Some(2));
    assert!(
        card_doc_of(&c, Visibility::Public, None)
            .unwrap()
            .unreadable
    );
}

#[test]
fn a_new_boards_key_is_random_or_derived_from_its_intent() {
    // the web's `newBoardKey`: sha256("dash-forge board key\0" ‖ repoId ‖ "\0" ‖ intent ‖ "\0" ‖ attempt)
    assert_eq!(
        new_board_key("REPOID", Some("intent-1"), 0).unwrap(),
        3_811_880_938
    );
    assert_eq!(
        new_board_key("REPOID", Some("intent-1"), 1).unwrap(),
        3_777_027_571
    );
    assert_ne!(
        new_board_key("REPOID", None, 0).unwrap(),
        new_board_key("REPOID", None, 0).unwrap()
    );
}

#[test]
fn a_sealed_card_keeps_its_state_when_it_does_not_open() {
    let (keys, ctx) = keys();
    let bind = Bind::Card {
        board: 7,
        item: ITEM,
    };
    let fields = CardFields {
        col: Some(2),
        rank: Some("V".into()),
        f: Some(r#"{"1":3}"#.into()),
    };
    let enc = sealed::seal(&keys, &BOB, &bind, &Content::Card(fields)).unwrap();
    let d = doc(
        5,
        BOB,
        10,
        vec![
            ("repoId", FieldValue::identifier(REPO)),
            ("board", FieldValue::integer(7)),
            ("item", FieldValue::identifier(ITEM)),
            ("state", FieldValue::integer(1)),
            ("epoch", FieldValue::integer(0)),
            ("enc", FieldValue::bytes(enc)),
        ],
    );
    let open = |s: &sealed::StoredBoardDoc| sealed::open(&ctx, s);
    let c = card_doc_of(&d, Visibility::Private, Some(&open)).unwrap();
    assert!(!c.unreadable);
    assert_eq!((c.card.col, c.card.rank.as_deref()), (Some(2), Some("V")));
    assert_eq!(c.card.item, encode_identifier(ITEM));
    let c = card_doc_of(&d, Visibility::Private, None).unwrap();
    assert!(c.unreadable);
    assert_eq!((c.card.state, c.card.col), (1, None));
    // a public card reads its plaintext; a column past 255 is none
    let p = card_doc_of(&card_doc(6, ALICE, 3, 300), Visibility::Public, None).unwrap();
    assert_eq!(p.card.col, None);
}

#[test]
fn cards_merge_by_id_the_later_copy_winning() {
    let read = |d: &FetchedDocument| card_doc_of(d, Visibility::Public, None).unwrap();
    let a1 = read(&card_doc(1, ALICE, 10, 1));
    let a2 = read(&card_doc(1, ALICE, 30, 3));
    let b = read(&card_doc(2, BOB, 20, 2));
    let merged = merge_cards(&[a1.clone(), b.clone()], &[a2.clone(), b.clone()]);
    assert_eq!(merged, vec![b.clone(), a2.clone()]);
    // an older copy read later does not undo a newer one
    assert_eq!(
        merge_cards(std::slice::from_ref(&a2), &[a1]),
        vec![a2.clone()]
    );
    assert_eq!(cards_since(&merged), 30);
    assert_eq!(cards_since(&[]), 0);
    let me = encode_identifier(ALICE);
    assert_eq!(
        plan_card_writes(&merged, &me, &[encode_identifier(ITEM), "other".into()]),
        (1, 1)
    );
}

fn base_card(f: Option<&str>, rank: Option<&str>) -> CardDoc {
    CardDoc {
        id: "c".into(),
        owner_id: "o".into(),
        updated_at: 1,
        item: "i".into(),
        col: Some(2),
        rank: rank.map(str::to_string),
        f: f.map(str::to_string),
        state: CARD_ARCHIVED,
    }
}

#[test]
fn a_patch_applies_to_the_newest_card_and_keeps_the_rest() {
    let spec = default_spec("home", 0);
    let base = base_card(Some(r#"{"1":2,"2":5}"#), Some("V1"));
    let mut patch = CardPatch::default();
    patch.fields.insert(1, Some(Scalar::from(3)));
    patch.fields.insert(2, None);
    let next = patched_card(&spec, Some(&base), &patch).unwrap();
    assert_eq!(next.f.as_deref(), Some(r#"{"1":3}"#));
    assert_eq!(
        (next.col, next.rank.as_deref(), next.state),
        (Some(2), Some("V1"), CARD_ARCHIVED)
    );
    // clearing the last value writes none; a base rank ending in 0 is implicit, not carried
    let mut clear = CardPatch::default();
    clear.fields.insert(1, None);
    clear.fields.insert(2, None);
    let next = patched_card(
        &spec,
        Some(&base_card(Some(r#"{"1":2}"#), Some("V10"))),
        &clear,
    )
    .unwrap();
    assert_eq!((next.f, next.rank), (None, None));
    let fresh = patched_card(&spec, None, &CardPatch::state(CARD_REMOVED)).unwrap();
    assert_eq!((fresh.col, fresh.state), (None, CARD_REMOVED));
    assert_eq!(
        patched_card(&spec, None, &CardPatch::default())
            .unwrap()
            .state,
        CARD_ACTIVE
    );
}

#[test]
fn a_patch_the_board_does_not_admit_is_refused_before_signing() {
    let spec = default_spec("home", 0);
    let ok = |p: CardPatch| check_patch(&spec, &p).is_ok();
    assert!(ok(CardPatch {
        col: Some(0),
        ..CardPatch::default()
    }));
    assert!(!ok(CardPatch {
        col: Some(9),
        ..CardPatch::default()
    }));
    assert!(!ok(CardPatch {
        rank: Some("V0".into()),
        ..CardPatch::default()
    }));
    assert!(!ok(CardPatch::state(3)));
    let field = |id, v: Scalar| {
        let mut p = CardPatch::default();
        p.fields.insert(id, Some(v));
        p
    };
    assert!(ok(field(1, Scalar::from(4))));
    assert!(!ok(field(1, Scalar::from(5))), "no option 5");
    assert!(!ok(field(9, Scalar::from(1))), "no field 9");
    assert!(
        !ok(field(3, Scalar::Text("x".into()))),
        "an iteration is a number"
    );
    assert!(ok(field(2, Scalar::Num(2.5))));
}

#[test]
fn a_board_name_and_definition_are_checked_and_written_canonically() {
    let spec = default_spec(&encode_identifier(REPO), 0);
    let f = check_board_input("  Roadmap ", &spec).unwrap();
    assert_eq!(f.name, "Roadmap");
    assert_eq!(parse_spec(&f.spec).unwrap(), spec);
    assert!(check_board_input("   ", &spec).is_err());
    assert!(check_board_input("a\u{7}b", &spec).is_err());
    assert!(check_board_input(&"x".repeat(64), &spec).is_err());
    let mut bad = spec;
    bad.columns.clear();
    assert!(check_board_input("Roadmap", &bad).is_err());
}

fn ranked(ids: &[(&str, &str)]) -> Vec<RankedCard> {
    ids.iter()
        .map(|(id, rank)| RankedCard {
            id: (*id).into(),
            rank: (*rank).into(),
        })
        .collect()
}

#[test]
fn a_move_ranks_between_its_new_neighbours() {
    let col = ranked(&[("a", "1"), ("b", "V1"), ("c", "V5"), ("d", "X")]);
    let at = |m: &str, d: DropAt| rank_at(&col, m, &d).unwrap().unwrap();
    let top = at("z", DropAt::Top);
    assert!(top.as_str() < "1");
    let bottom = at("z", DropAt::Bottom);
    assert!(bottom.as_str() > "X");
    let before = at("z", DropAt::Before("c".into()));
    assert!("V1" < before.as_str() && before.as_str() < "V5");
    let after = at("z", DropAt::After("c".into()));
    assert!("V5" < after.as_str() && after.as_str() < "X");
    // the moving card itself is left out: `b` after `c` goes between `c` and `d`
    let b_after_c = at("b", DropAt::After("c".into()));
    assert!("V5" < b_after_c.as_str() && b_after_c.as_str() < "X");
    assert!(rank_at(&col, "z", &DropAt::Before("nope".into())).is_none());
    assert!(rank_at(&[], "z", &DropAt::Bottom).unwrap().is_ok());
    // two equal ranks: no room, re-rank
    let tie = ranked(&[("a", "V1"), ("b", "V1")]);
    assert_eq!(
        rank_at(&tie, "z", &DropAt::After("a".into())).unwrap(),
        Err(RankError::Rerank)
    );
}

fn item(id: &str, state: ItemState, closed_at: Option<i64>) -> BoardItem {
    BoardItem {
        id: id.into(),
        number: 1,
        repo_id: "home".into(),
        repo: None,
        kind: ItemKind::Issue,
        state,
        created_at: 0,
        closed_at,
        title: id.into(),
        labels: Vec::new(),
        assignees: Vec::new(),
        milestone: None,
        author: "a".into(),
    }
}

#[test]
fn a_source_keeps_its_open_items_and_its_recently_closed_ones() {
    let day = 86_400_000;
    let now = 100 * day;
    let all = vec![
        item("open", ItemState::Open, None),
        item("recent", ItemState::Closed, Some(now - 2 * day)),
        item("old", ItemState::Merged, Some(now - 20 * day)),
        item("old-carded", ItemState::Closed, Some(now - 30 * day)),
    ];
    let carded: HashSet<&str> = ["old-carded"].into();
    let (kept, older) = select_source_items(all.clone(), 14, &carded, now, false);
    let ids: Vec<&str> = kept.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, ["open", "recent", "old-carded"]);
    assert!(older);
    // auto-archive off: the most recently closed CLOSED_PER_REPO
    let many: Vec<BoardItem> = (0..CLOSED_PER_REPO + 5)
        .map(|n| {
            item(
                &format!("c{n:03}"),
                ItemState::Closed,
                Some(i64::try_from(n).unwrap()),
            )
        })
        .collect();
    let (kept, older) = select_source_items(many, 0, &HashSet::new(), now, false);
    assert_eq!(kept.len(), CLOSED_PER_REPO);
    assert!(older);
    assert!(kept.iter().all(|i| i.id.as_str() >= "c005"));
    let (_, older) = select_source_items(all, 365, &HashSet::new(), now, false);
    assert!(!older);
}

/// `dg board view --archived` (a view asking for `is:archived`) keeps the next
/// `CLOSED_PER_REPO` closed items past the window, as the web's "Show older" reads them: an
/// item auto-archived without a card shows.
#[test]
fn a_view_asking_for_archived_items_keeps_the_next_stretch_of_older_closed_ones() {
    let day = 86_400_000;
    let now = 1_000 * day;
    let mut all = vec![
        item("open", ItemState::Open, None),
        item("recent", ItemState::Closed, Some(now - 2 * day)),
    ];
    // 205 closed past the 14-day window, newest first c000 … c204, none carded
    all.extend((0..CLOSED_PER_REPO + 5).map(|n| {
        item(
            &format!("c{n:03}"),
            ItemState::Closed,
            Some(now - 30 * day - i64::try_from(n).unwrap() * day),
        )
    }));
    let (kept, older) = select_source_items(all.clone(), 14, &HashSet::new(), now, false);
    assert_eq!(kept.len(), 2);
    assert!(older);
    let (kept, older) = select_source_items(all.clone(), 14, &HashSet::new(), now, true);
    let ids: Vec<&str> = kept.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids.len(), 2 + CLOSED_PER_REPO);
    assert!(ids.contains(&"c000") && ids.contains(&"c199") && !ids.contains(&"c200"));
    assert!(older);
    // auto-archive off: the first 200, then 200 more
    let (kept, older) = select_source_items(all, 0, &HashSet::new(), now, true);
    assert_eq!(kept.len(), 1 + CLOSED_PER_REPO + 6);
    assert!(!older);
}

#[test]
fn source_kinds_merge_per_repository() {
    let mut spec = default_spec("home", 0);
    spec.sources = vec![
        crate::rules::boards::BoardSource {
            r: None,
            k: crate::rules::boards::SourceKind::Issues,
            q: String::new(),
        },
        crate::rules::boards::BoardSource {
            r: Some("home".into()),
            k: crate::rules::boards::SourceKind::Pulls,
            q: String::new(),
        },
        crate::rules::boards::BoardSource {
            r: Some("other".into()),
            k: crate::rules::boards::SourceKind::Issues,
            q: String::new(),
        },
    ];
    let kinds = source_kinds(&spec, "home");
    assert_eq!(kinds["home"].len(), 2);
    assert_eq!(
        kinds["other"].iter().copied().collect::<Vec<_>>(),
        [ItemKind::Issue]
    );
}

#[test]
fn next_iteration_moves_the_current_iterations_open_unfinished_items() {
    let spec = default_spec("home", 0); // Iteration (field 3) from 1969-12-29, 14 days
    let now = 20 * 86_400_000; // iteration 1 (index 1)
    let items = vec![
        item("move", ItemState::Open, None),
        item("done-col", ItemState::Open, None),
        item("closed", ItemState::Closed, Some(1)),
        item("later", ItemState::Open, None),
    ];
    let card = |id: &str, n: u8, f: &str| CardDoc {
        id: format!("card-{id}"),
        owner_id: "o".into(),
        updated_at: 5,
        item: id.into(),
        col: Some(i64::from(n)),
        rank: None,
        f: Some(f.into()),
        state: CARD_ACTIVE,
    };
    let cards = vec![
        card("move", 2, r#"{"3":1}"#),
        card("done-col", 3, r#"{"3":1}"#),
        card("closed", 2, r#"{"3":1}"#),
        card("later", 1, r#"{"3":2}"#),
    ];
    let fold = fold_board(&spec, "home", &items, &cards, now);
    let (next, moving) = next_iteration_plan(&spec, 3, &items, &fold.items, now).unwrap();
    assert_eq!(next, 2);
    assert_eq!(
        moving.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        ["move"]
    );
    assert!(
        next_iteration_plan(&spec, 1, &items, &fold.items, now).is_none(),
        "not an iteration field"
    );
}

#[test]
fn an_item_reference_is_a_number_a_repo_and_number_or_a_link() {
    let r = |t: &str| parse_item_reference(t);
    assert_eq!(
        r("#12"),
        Some(ItemReference {
            repo: None,
            number: 12
        })
    );
    assert_eq!(
        r(" alice/proj#7 "),
        Some(ItemReference {
            repo: Some(("alice".into(), "proj".into())),
            number: 7
        })
    );
    assert_eq!(
        r("https://forge.dashhq.org/repo/issue/?owner=alice&name=my%2Dproj&number=3"),
        Some(ItemReference {
            repo: Some(("alice".into(), "my-proj".into())),
            number: 3
        })
    );
    assert_eq!(
        r("https://forge.dashhq.org/repo/pull?owner=a&name=b&number=4").map(|x| x.number),
        Some(4)
    );
    assert_eq!(r("Fix the login page"), None);
    assert_eq!(r("#"), None);
    assert_eq!(r("#12345678901"), None);
    assert_eq!(
        r("https://forge.dashhq.org/repo/tree?owner=a&name=b&number=4"),
        None
    );
}

#[test]
fn a_closed_items_close_time_is_its_latest_move_into_closed_or_merged() {
    let t = |kind: u8, at: u64| -> crate::rules::v2::Transition {
        serde_json::from_value(serde_json::json!({ "kind": kind, "createdAt": at })).unwrap()
    };
    assert_eq!(
        closed_at_of(&[t(1, 5), t(2, 7), t(1, 9), t(3, 11)]),
        Some(9)
    );
    assert_eq!(closed_at_of(&[t(14, 5), t(13, 8)]), Some(8));
    assert_eq!(closed_at_of(&[t(2, 5)]), None);
}

#[test]
fn boards_are_role_gated_like_the_web() {
    use crate::collab::v2::gated_write;
    // forge-web `lib/rules/roles.ts`: `board` admits r 1 only, `card` 1 or 2
    assert_eq!(
        gated_write(DOC_BOARD, &BTreeMap::new()),
        Some((Role::Writer, false))
    );
    assert_eq!(
        gated_write(DOC_CARD, &BTreeMap::new()),
        Some((Role::Triage, false))
    );
    assert!(crate::members::ROLE_GATED_TYPES.contains(&DOC_BOARD));
    assert!(crate::members::ROLE_GATED_TYPES.contains(&DOC_CARD));
    assert!(can_place_cards(Some(Role::Triage)) && !can_place_cards(Some(Role::Reader)));
    assert!(can_edit_boards(Some(Role::Writer)) && !can_edit_boards(Some(Role::Triage)));
    assert!(!can_place_cards(None) && !can_edit_boards(Some(Role::Bot)));
    // a triage member claims r 2 on a card
    assert_eq!(
        crate::collab::v2::claimed_role_for(DOC_CARD, &BTreeMap::new(), Some(Role::Triage)),
        Some(2)
    );
}

#[test]
fn a_snapshot_lists_a_columns_cards_with_their_ranks() {
    let spec = default_spec("home", 0);
    let items = vec![
        item("a", ItemState::Open, None),
        item("b", ItemState::Open, None),
    ];
    let cards = vec![CardDoc {
        id: "c".into(),
        owner_id: "o".into(),
        updated_at: 1,
        item: "b".into(),
        col: Some(1),
        rank: Some("1".into()),
        f: None,
        state: CARD_ACTIVE,
    }];
    let fold = fold_board(&spec, "home", &items, &cards, 0);
    let snap = BoardSnapshot {
        read: BoardRead {
            board: Board {
                key: 7,
                repo_id: "home".into(),
                state: BoardState::Open,
                name: Some("B".into()),
                spec: Some(spec),
                spec_error: None,
                sealed: false,
                newest: BoardRevision {
                    id: "r".into(),
                    owner_id: "o".into(),
                    updated_at: 1,
                },
                revisions: Vec::new(),
            },
            cards: Vec::new(),
            since: 0,
        },
        items: BoardItemSet {
            items,
            ..BoardItemSet::default()
        },
        fold: Some(fold),
        now: 0,
    };
    let col = snap.column(1);
    assert_eq!(
        col.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["b", "a"]
    );
    assert_eq!(col[0].rank, "1");
    assert!(col[1].rank.starts_with('V'));
    assert!(snap.placement("a").is_some() && snap.item("zz").is_none());
}

fn landed(document_id: &str, revision: u64, col: i64) -> LandedCard {
    LandedCard {
        document_id: document_id.into(),
        revision,
        card: CardDoc {
            id: document_id.into(),
            owner_id: encode_identifier(ALICE),
            updated_at: 0,
            item: encode_identifier(ITEM),
            col: Some(col),
            rank: None,
            f: Some(r#"{"1":1}"#.into()),
            state: CARD_ACTIVE,
        },
    }
}

/// §3.2: a member's own back-to-back writes must not undo each other. A write builds on the
/// card this client's last write landed while the fresh read lags behind it (it lacks the
/// document, or holds an older revision), and on the read once it caught up, another
/// member's newer card included.
#[test]
fn a_write_builds_on_its_last_landed_card_only_while_the_read_lags_behind_it() {
    let item = encode_identifier(ITEM);
    let read = |docs: Vec<FetchedDocument>, own: Option<&str>| ItemCardDocs {
        cards: docs
            .iter()
            .filter_map(|d| card_doc_of(d, Visibility::Public, None))
            .collect(),
        own: own.map(str::to_string),
    };
    let mut mine = card_doc(1, ALICE, 100, 2);
    mine.revision = Some(3);
    let mine_id = mine.id.clone();
    let l = landed(&mine_id, 4, 3);
    // the read holds revision 3: older than the landed 4, so the landed card is the base
    let (base, own, revision) =
        card_base_of(Some(&l), &item, &read(vec![mine.clone()], Some(&mine_id)));
    assert_eq!(base.and_then(|b| b.col), Some(3));
    assert_eq!((own.as_deref(), revision), (Some(mine_id.as_str()), 4));
    // a create whose read does not show it yet: the landed document is the one to replace
    let (base, own, _) = card_base_of(Some(&l), &item, &read(Vec::new(), None));
    assert_eq!(
        (base.and_then(|b| b.col), own.as_deref()),
        (Some(3), Some(mine_id.as_str()))
    );
    // caught up, and Bob wrote since: the read is the base, Bob's card included
    mine.revision = Some(4);
    let bob = card_doc(2, BOB, 200, 1);
    let (base, own, revision) = card_base_of(
        Some(&l),
        &item,
        &read(vec![mine, bob.clone()], Some(&mine_id)),
    );
    assert_eq!(base.map(|b| b.id), Some(bob.id.clone()));
    assert_eq!((own.as_deref(), revision), (Some(mine_id.as_str()), 4));
    // nothing landed (another process, or a duplicate's re-read): the read's newest card,
    // another device's own card included, never a card built before the conflict
    let other_device = card_doc(3, ALICE, 300, 4);
    let (base, own, revision) = card_base_of(
        None,
        &item,
        &read(vec![bob, other_device.clone()], Some(&other_device.id)),
    );
    assert_eq!(base.and_then(|b| b.col), Some(4));
    assert_eq!((own, revision), (Some(other_device.id), 1));
}

/// §5.6: an item's sidebar reads the boards of its repository and its owner's other public
/// repositories only; a private one's and a stranger's are never read.
#[test]
fn an_items_sidebar_reads_its_owners_public_repositories_only() {
    let forge = crate::network::ForgeIds {
        core: "core".into(),
        collab: "collab".into(),
        community: "community".into(),
        meta: Some("meta".into()),
        group: "group".into(),
        superseded_in_group: Vec::new(),
        group_owner: None,
    };
    let owner = encode_identifier(ALICE);
    let repo = RepoRef {
        forge,
        repo_id: encode_identifier(REPO),
        owner_id: owner.clone(),
        name: "forge".into(),
        visibility: Visibility::Private,
    };
    let repo_doc = |id: u8, who: [u8; 32], name: &str, visibility: &str| {
        doc(
            id,
            who,
            1,
            vec![
                ("name", FieldValue::text(name)),
                ("visibility", FieldValue::text(visibility)),
            ],
        )
    };
    let homes = sidebar_homes_of(
        &repo,
        &[
            repo_doc(0x21, ALICE, "plan", "public"),
            repo_doc(0x22, ALICE, "secret", "private"),
            repo_doc(0x23, BOB, "theirs", "public"),
        ],
    );
    let names: Vec<&str> = homes.values().map(|r| r.name.as_str()).collect();
    assert_eq!(homes.len(), 2);
    assert!(names.contains(&"forge") && names.contains(&"plan"));
}
