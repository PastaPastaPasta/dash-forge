//! Boards (`docs/design/boards.md`; forge-meta `board` and `card`, UPDATE-3): reading a
//! repository's boards and cards, assembling the items a board folds, and every board and card
//! write. A fifth `impl` of [`super::v2::Collab`]; the pure rules are
//! [`crate::rules::boards`]. Parity: forge-web `lib/repo/boards.ts` (reads),
//! `lib/repo/board-items.ts` (items) and `lib/repo/board-writes.ts` (writes).
//!
//! * **Reads**: [`Collab::boards`] (a repo's boards, newest revision per key over every
//!   member's, deleted dropped), [`Collab::board`] (one board's definition and every card, the
//!   `card.recent` index), [`Collab::cards_since`] (`$updatedAt >=` a time, merged by `$id` with
//!   [`merge_cards`]), [`Collab::item_card_docs`] (`card.onItem`: one item's cards on one board,
//!   and the signer's own document) and [`Collab::item_boards`] (an item's boards whose home is
//!   its repository or another of the same owner, §5.6).
//! * **Items** ([`Collab::board_items`], §2.3, §2.4): per source repository its open issues and
//!   pull requests, the closed ones inside the auto-archive window (or, with `arch` 0, the
//!   [`CLOSED_PER_REPO`] most recently closed) and every closed one a card names; then every item
//!   a card names outside the sources, by id, in any repository. The CLI reads the issue and PR
//!   lists whole (the PRs page after page, up to [`PR_PAGES`]), so it filters in memory what
//!   the web's feed walk pages through ([`select_source_items`]).
//! * **Writes**: one document operation each, the signer's role checked first (a board claims
//!   `r` 1, writers and maintainers; a card 1 or 2, triage too: [`super::v2::gated_write`]), and
//!   refused before signing where the contract or the board rules would refuse it. A board and a
//!   card are one mutable document per member, so a write replaces the signer's own document
//!   when they have one and creates it otherwise; a card is written over a fresh read of the
//!   item's newest card, its change applied to it (§3.2, [`patched_card`]).
//!
//! A private repository's boards and cards are sealed ([`crate::private::board`],
//! private-repos.md §4.6): a member opens them with the repository's keys; a document carrying
//! plaintext content beside `enc`, a private one without `enc`, or one whose seal is malformed
//! is skipped by every reader, and a write still finds the signer's own document among the raw
//! rows. In a repository made public (§18) the sealed boards and cards of its private era open
//! with the epoch keys its owner published; any other public repository's sealed one (a later
//! client's members-only board) reads as unreadable, never dropped.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;

use super::v2::{
    issue_from_doc, patch_from_doc, Collab, IssueView, PatchView, DOC_ISSUE, DOC_PATCH,
};
use crate::error::{Error, Result};
use crate::keyring::Keyring;
use crate::members;
use crate::platform::{self, FetchedDocument, FieldValue, LoadedContract, QueryFilter, QueryOrder};
use crate::private::board::{self as sealed, Bind, BoardFields, CardFields, Content, Opened};
use crate::rules::boards::{
    bottom_rank, field_value_ok, is_board_name, is_explicit_rank, iteration_at, newest_boards,
    newest_cards, parse_field_values, parse_spec, rank_between, serialize_field_values,
    serialize_spec, top_rank, BoardDoc, BoardFold, BoardItem, BoardSpec, CardDoc, FieldType,
    ItemKind, ItemState, Placement, RankError, Scalar, SpecError, BOARD_DELETED, CARD_ACTIVE,
    CARD_ARCHIVED, CARD_REMOVED, ITER_INDEX_MAX,
};
use crate::rules::transition::{ISSUE_CLOSE, PR_CLOSE, PR_DRAFT_CLOSE, PR_MERGE};
use crate::rules::v2::{fold_thread_meta_v2, Role, Visibility};
use crate::scope::RepoRef;
use crate::user_error::{codes, UserError};

/// forge-meta (UPDATE-3, four-contract sets only): a member's revision of a board's definition.
pub const DOC_BOARD: &str = "board";
/// forge-meta (UPDATE-3): a member's placement of one issue or PR on a board.
pub const DOC_CARD: &str = "card";

/// Board `state`: open.
pub const BOARD_OPEN: i64 = 0;
/// Board `state`: closed (read-only, listed under Closed).
pub const BOARD_CLOSED: i64 = 1;

/// With auto-archive off, a source repository's closed items read at first are its most
/// recently closed this many (§2.4; the web's `CLOSED_PER_REPO`).
pub const CLOSED_PER_REPO: usize = 200;

const DAY_MS: i64 = 86_400_000;

/// A board's state (§3.1 `state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BoardState {
    /// Open.
    Open,
    /// Closed: read-only, listed under Closed.
    Closed,
    /// Deleted (state 2 is the delete: the documents are never deleted).
    Deleted,
}

impl BoardState {
    /// The `board.state` integer.
    #[must_use]
    pub fn code(self) -> i64 {
        match self {
            Self::Open => BOARD_OPEN,
            Self::Closed => BOARD_CLOSED,
            Self::Deleted => BOARD_DELETED,
        }
    }

    fn of(code: i64) -> Self {
        match code {
            BOARD_CLOSED => Self::Closed,
            BOARD_DELETED => Self::Deleted,
            _ => Self::Open,
        }
    }

    /// `open`, `closed` or `deleted`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Deleted => "deleted",
        }
    }
}

/// One member's revision of a board: one document per (home repo, key, member), replaced in
/// place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardRevision {
    /// `$id`.
    pub id: String,
    /// `$ownerId`.
    pub owner_id: String,
    /// `$updatedAt`.
    pub updated_at: i64,
}

/// A board as its newest revision defines it (the web's `BoardView`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    /// The board's key.
    pub key: u32,
    /// The home repository's id.
    pub repo_id: String,
    /// Open, closed or deleted.
    pub state: BoardState,
    /// `None` when it could not be read (a sealed board without the repo's key).
    pub name: Option<String>,
    /// The parsed definition; `None` when it could not be read or was refused.
    pub spec: Option<BoardSpec>,
    /// Why `spec` is `None`: the rules' refusal ([`SpecError::as_str`]) or `unreadable`.
    pub spec_error: Option<String>,
    /// The definition is sealed (a private repository's).
    pub sealed: bool,
    /// The newest revision.
    pub newest: BoardRevision,
    /// Every member's revision document, oldest first, malformed ones included (a save
    /// replaces the signer's own, [`own_revision`], whatever it holds).
    pub revisions: Vec<BoardRevision>,
}

/// A card as read: the rules' [`CardDoc`] and whether it is a sealed card this reader could
/// not open (its column, rank and fields unknown, not empty).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BoardCard {
    /// The card.
    #[serde(flatten)]
    pub card: CardDoc,
    /// Sealed and not opened here.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unreadable: bool,
    /// The document's `$revision`, when the read has it: what tells a read that lags behind
    /// this client's own write ([`Collab::write_card`], §3.2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
}

/// A card a [`Collab`]'s write landed: its document, the revision it wrote, and what it holds.
#[derive(Debug, Clone)]
pub struct LandedCard {
    /// The signer's card document.
    pub document_id: String,
    /// The `$revision` the write made.
    pub revision: u64,
    /// What it holds.
    pub card: CardDoc,
}

/// What a card write over `docs` (a fresh read of item `item_id`'s cards) builds on (§3.2,
/// the web's `overIfAhead`): the newest card this reader opens (one it cannot open holds values
/// it cannot carry over), or, while the read lacks `landed` (the last card this client's write
/// of the item landed), holds an older revision of it, or (its revision unknown) holds other
/// content, `landed` (a member's own back-to-back writes must not undo each other); with the
/// signer's own document (the read's, or the landed one's) and the revision it holds.
#[must_use]
pub fn card_base_of(
    landed: Option<&LandedCard>,
    item_id: &str,
    docs: &ItemCardDocs,
) -> (Option<CardDoc>, Option<String>, u64) {
    let read_revision = |id: &str| {
        docs.cards
            .iter()
            .find(|c| c.card.id == id)
            .and_then(|c| c.revision)
    };
    if let Some(l) = landed {
        let read = docs.cards.iter().find(|c| c.card.id == l.document_id);
        let behind = match read {
            None => true,
            Some(c) => match c.revision {
                Some(r) => r < l.revision,
                None => {
                    (&c.card.col, &c.card.rank, &c.card.f, c.card.state)
                        != (&l.card.col, &l.card.rank, &l.card.f, l.card.state)
                }
            },
        };
        if behind {
            return (
                Some(l.card.clone()),
                Some(l.document_id.clone()),
                l.revision,
            );
        }
    }
    let readable: Vec<CardDoc> = docs
        .cards
        .iter()
        .filter(|c| !c.unreadable)
        .map(|c| c.card.clone())
        .collect();
    (
        newest_cards(&readable).get(item_id).map(|c| (*c).clone()),
        docs.own.clone(),
        docs.own.as_deref().and_then(read_revision).unwrap_or(0),
    )
}

/// The repositories of `docs` (`repo` documents read by `repo`'s owner) whose boards `repo`'s
/// items show in their sidebar (§5.6): `repo` itself and the owner's other public ones, by id.
#[must_use]
pub fn sidebar_homes_of(repo: &RepoRef, docs: &[FetchedDocument]) -> BTreeMap<String, RepoRef> {
    let mut homes = BTreeMap::from([(repo.id().to_string(), repo.clone())]);
    for d in docs {
        if let Ok(r) = crate::resolve::repo_ref_from_doc(repo.forge(), d) {
            if r.owner_id() == repo.owner_id() && r.visibility != Visibility::Private {
                homes.entry(r.id().to_string()).or_insert(r);
            }
        }
    }
    homes
}

/// One board and every card on it, as [`Collab::board`] reads them.
#[derive(Debug, Clone)]
pub struct BoardRead {
    /// The definition.
    pub board: Board,
    /// Every member's card, ordered by (`$updatedAt`, `$id`).
    pub cards: Vec<BoardCard>,
    /// The newest `$updatedAt` among the cards (0 when none): a later read starts here.
    pub since: i64,
}

/// Every member's card for one item on one board, and the `$id` of the signer's own card
/// document (whatever it holds).
#[derive(Debug, Clone)]
pub struct ItemCardDocs {
    /// The cards that read.
    pub cards: Vec<BoardCard>,
    /// The signer's own document.
    pub own: Option<String>,
}

/// One board an issue or PR is on, for its sidebar (§5.6).
#[derive(Debug, Clone)]
pub struct ItemBoard {
    /// The board's home repository.
    pub home: RepoRef,
    /// The board.
    pub board: Board,
    /// Every member's card for the item on it.
    pub cards: Vec<BoardCard>,
    /// The newest of them, if any.
    pub card: Option<BoardCard>,
}

/// A board's items, ready to fold (the web's `BoardItemSet`).
#[derive(Debug, Clone, Default)]
pub struct BoardItemSet {
    /// The items.
    pub items: Vec<BoardItem>,
    /// Items shown as "a private item": in a private repository this reader cannot open, or
    /// members-only and not opened.
    pub hidden: BTreeSet<String>,
    /// Card items that are no issue or PR this reader can find (dropped from the board).
    pub missing: BTreeSet<String>,
    /// A source's list stopped short (more than [`PR_PAGES`] pages of pull requests).
    pub partial: bool,
    /// Some source repository has closed items older than were kept.
    pub has_older_closed: bool,
}

/// A board with its cards, items and fold at `now`: what `dg board view` shows and what a move
/// ranks against.
#[derive(Debug, Clone)]
pub struct BoardSnapshot {
    /// The board and its cards.
    pub read: BoardRead,
    /// Its items.
    pub items: BoardItemSet,
    /// The fold; `None` when the definition did not open.
    pub fold: Option<BoardFold>,
    /// The time it was folded at (ms).
    pub now: i64,
}

impl BoardSnapshot {
    /// The item with `id`.
    #[must_use]
    pub fn item(&self, id: &str) -> Option<&BoardItem> {
        self.items.items.iter().find(|i| i.id == id)
    }

    /// Where item `id` shows.
    #[must_use]
    pub fn placement(&self, id: &str) -> Option<&Placement> {
        self.fold.as_ref()?.items.iter().find(|p| p.id == id)
    }

    /// Every item's placement by its id (empty when the definition did not open).
    #[must_use]
    pub fn placement_index(&self) -> HashMap<&str, &Placement> {
        self.fold
            .as_ref()
            .map(|f| f.items.iter().map(|p| (p.id.as_str(), p)).collect())
            .unwrap_or_default()
    }

    /// Column `col`'s visible cards in rank order, with their effective ranks (what a move
    /// ranks between).
    #[must_use]
    pub fn column(&self, col: u8) -> Vec<RankedCard> {
        let Some(fold) = &self.fold else {
            return Vec::new();
        };
        let placed = self.placement_index();
        fold.columns
            .iter()
            .filter(|c| c.id == col)
            .flat_map(|c| c.items.iter())
            .map(|id| RankedCard {
                id: id.clone(),
                rank: placed
                    .get(id.as_str())
                    .map_or_else(String::new, |p| p.rank.clone()),
            })
            .collect()
    }
}

/// The signer's own revision of a board, if they wrote one.
#[must_use]
pub fn own_revision<'b>(board: &'b Board, me: &str) -> Option<&'b BoardRevision> {
    board.revisions.iter().find(|r| r.owner_id == me)
}

/// Whether `role` may place cards: move, rank, set fields, add, archive, remove (§5.1).
#[must_use]
pub fn can_place_cards(role: Option<Role>) -> bool {
    matches!(role, Some(Role::Maintainer | Role::Writer | Role::Triage))
}

/// Whether `role` may create, edit, close or delete a board and save views (§5.1).
#[must_use]
pub fn can_edit_boards(role: Option<Role>) -> bool {
    matches!(role, Some(Role::Maintainer | Role::Writer))
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

/// A u32 integer field, or `None`.
fn u32_of(d: &FetchedDocument, field: &str) -> Option<u32> {
    d.field_u64(field).and_then(|n| u32::try_from(n).ok())
}

/// `$updatedAt` (both timestamps are required on these types; `$createdAt` covers a row read
/// before `$updatedAt` was).
#[allow(clippy::cast_possible_wrap)] // ms since 1970
fn updated_at(d: &FetchedDocument) -> i64 {
    d.updated_at.or(d.created_at).unwrap_or(0) as i64
}

/// How a reader opens a stored sealed board or card: `None` when it holds no keys (a public
/// repository's sealed document, or a reader without the private repository's).
pub type Opener<'k> = Option<&'k dyn Fn(&sealed::StoredBoardDoc) -> Opened>;

/// A stored document's sealed form for [`sealed::open`]; `None` when it names no owner or also
/// carries a plaintext content field ([`Bind::plaintext_fields`]: malformed, skipped).
fn stored_of(d: &FetchedDocument, bind: Bind) -> Option<sealed::StoredBoardDoc> {
    if bind
        .plaintext_fields()
        .iter()
        .any(|f| d.fields.contains_key(*f))
    {
        return None;
    }
    Some(sealed::StoredBoardDoc {
        bind,
        owner_id: platform::decode_identifier(&d.owner_id).ok()?,
        epoch: u32_of(d, "epoch"),
        enc: d.field_bytes("enc"),
        plaintext: false,
    })
}

/// A `board` document as the rules read it ([`BoardDoc`]) and whether it is sealed, opened
/// where it is; `None` when malformed (plaintext content beside `enc`, a private board without
/// `enc`, a broken seal), which every reader skips. A sealed board `open` cannot open reads with
/// no name or spec. Parity: the web's `boardDocOf`.
#[must_use]
pub fn board_doc_of(
    d: &FetchedDocument,
    visibility: Visibility,
    open: Opener<'_>,
) -> Option<(BoardDoc, bool)> {
    let key = u32_of(d, "key").filter(|k| *k > 0)?;
    let state = d.field_u64("state").filter(|s| *s <= 2)?;
    let mut doc = BoardDoc {
        id: d.id.clone(),
        owner_id: d.owner_id.clone(),
        updated_at: updated_at(d),
        key,
        state: i64::try_from(state).ok()?,
        name: None,
        spec: None,
    };
    if !d.fields.contains_key("enc") {
        if visibility == Visibility::Private {
            return None;
        }
        doc.name = d.field_str("name");
        doc.spec = d.field_str("spec");
        return Some((doc, false));
    }
    let stored = stored_of(d, Bind::Board { key })?;
    let Some(open) = open else {
        return Some((doc, true));
    };
    match open(&stored) {
        Opened::Malformed => return None,
        Opened::Readable(Content::Board(f)) => {
            doc.name = Some(f.name);
            doc.spec = Some(f.spec);
        }
        Opened::Readable(Content::Card(_)) | Opened::Unreadable(_) => {}
    }
    Some((doc, true))
}

/// A `card` document as the rules read it, opened where it is sealed: one `open` cannot open
/// keeps its `state`, marked unreadable. `None` when malformed (as [`board_doc_of`]).
#[must_use]
pub fn card_doc_of(
    d: &FetchedDocument,
    visibility: Visibility,
    open: Opener<'_>,
) -> Option<BoardCard> {
    let board = u32_of(d, "board").filter(|b| *b > 0)?;
    let state = d.field_u64("state").filter(|s| *s <= 2)?;
    let item_bytes = d.field_bytes32("item")?;
    let mut card = CardDoc {
        id: d.id.clone(),
        owner_id: d.owner_id.clone(),
        updated_at: updated_at(d),
        item: platform::encode_identifier(item_bytes),
        col: None,
        rank: None,
        f: None,
        state: i64::try_from(state).ok()?,
    };
    if !d.fields.contains_key("enc") {
        if visibility == Visibility::Private {
            return None;
        }
        card.col = d
            .field_u64("col")
            .filter(|c| *c <= 255)
            .and_then(|c| i64::try_from(c).ok());
        card.rank = d.field_str("rank");
        card.f = d.field_str("f");
        return Some(BoardCard {
            card,
            unreadable: false,
            revision: d.revision,
        });
    }
    let bind = Bind::Card {
        board,
        item: item_bytes,
    };
    let stored = stored_of(d, bind)?;
    let unread = |card| {
        Some(BoardCard {
            card,
            unreadable: true,
            revision: d.revision,
        })
    };
    let Some(open) = open else {
        return unread(card);
    };
    match open(&stored) {
        Opened::Malformed => None,
        Opened::Readable(Content::Card(f)) => {
            card.col = f.col.map(i64::from);
            card.rank = f.rank;
            card.f = f.f;
            Some(BoardCard {
                card,
                unreadable: false,
                revision: d.revision,
            })
        }
        Opened::Readable(Content::Board(_)) | Opened::Unreadable(_) => unread(card),
    }
}

/// The boards `docs` (one repository's `board` documents) define: per key the newest revision
/// ([`newest_boards`]), ascending by key, deleted ones only `with_deleted`. `read` is
/// [`board_doc_of`] with the reader's opener.
pub fn boards_of(
    repo_id: &str,
    docs: &[FetchedDocument],
    read: impl Fn(&FetchedDocument) -> Option<(BoardDoc, bool)>,
    with_deleted: bool,
) -> Vec<Board> {
    let opened: Vec<(BoardDoc, bool)> = docs.iter().filter_map(read).collect();
    let sealed: HashMap<&str, bool> = opened.iter().map(|(d, s)| (d.id.as_str(), *s)).collect();
    // every revision document, the skipped ones too: a write replaces the signer's own
    let mut by_key: BTreeMap<u32, Vec<BoardRevision>> = BTreeMap::new();
    for d in docs {
        if let Some(key) = u32_of(d, "key") {
            by_key.entry(key).or_default().push(BoardRevision {
                id: d.id.clone(),
                owner_id: d.owner_id.clone(),
                updated_at: updated_at(d),
            });
        }
    }
    let docs: Vec<BoardDoc> = opened.iter().map(|(d, _)| d.clone()).collect();
    newest_boards(&docs, with_deleted)
        .into_iter()
        .map(|d| {
            let parsed = d.spec.as_deref().map(parse_spec);
            let mut revisions = by_key.get(&d.key).cloned().unwrap_or_default();
            revisions.sort_by(|a, b| (a.updated_at, &a.id).cmp(&(b.updated_at, &b.id)));
            Board {
                key: d.key,
                repo_id: repo_id.to_string(),
                state: BoardState::of(d.state),
                name: d.name.clone(),
                spec_error: match &parsed {
                    None => Some("unreadable".into()),
                    Some(Err(e)) => Some(e.as_str().into()),
                    Some(Ok(_)) => None,
                },
                spec: parsed.and_then(std::result::Result::ok),
                sealed: sealed.get(d.id.as_str()).copied().unwrap_or(false),
                newest: BoardRevision {
                    id: d.id.clone(),
                    owner_id: d.owner_id.clone(),
                    updated_at: d.updated_at,
                },
                revisions,
            }
        })
        .collect()
}

/// `held` with `fresh` merged in by `$id`: a card is replaced in place (same `$id`, a later
/// `$updatedAt`), so the later of two copies wins; a copy read twice (a `>=` boundary) is kept
/// once. Ordered by (`$updatedAt`, `$id`).
#[must_use]
pub fn merge_cards(held: &[BoardCard], fresh: &[BoardCard]) -> Vec<BoardCard> {
    let mut by_id: HashMap<&str, &BoardCard> = HashMap::new();
    for c in held.iter().chain(fresh) {
        match by_id.get(c.card.id.as_str()) {
            Some(prev) if c.card.updated_at < prev.card.updated_at => {}
            _ => {
                by_id.insert(&c.card.id, c);
            }
        }
    }
    let mut out: Vec<BoardCard> = by_id.into_values().cloned().collect();
    out.sort_by(|a, b| (a.card.updated_at, &a.card.id).cmp(&(b.card.updated_at, &b.card.id)));
    out
}

/// The newest `$updatedAt` of `cards`, or 0.
#[must_use]
pub fn cards_since(cards: &[BoardCard]) -> i64 {
    cards.iter().map(|c| c.card.updated_at).max().unwrap_or(0)
}

/// The rules' cards of `cards`.
#[must_use]
pub fn card_docs(cards: &[BoardCard]) -> Vec<CardDoc> {
    cards.iter().map(|c| c.card.clone()).collect()
}

// ---------------------------------------------------------------------------------------------
// Items (§2.3, §2.4)
// ---------------------------------------------------------------------------------------------

/// The `$createdAt` of `transitions`' latest move into closed or merged.
#[must_use]
#[allow(clippy::cast_possible_wrap)] // ms since 1970
pub fn closed_at_of(transitions: &[crate::rules::v2::Transition]) -> Option<i64> {
    transitions
        .iter()
        .filter(|t| matches!(t.kind, ISSUE_CLOSE | PR_CLOSE | PR_MERGE | PR_DRAFT_CLOSE))
        .map(|t| t.created_at as i64)
        .max()
}

/// An issue as the board reads it (the web's `boardItemOfIssue`). `label` names its repository.
#[must_use]
#[allow(clippy::cast_possible_wrap)] // ms since 1970
pub fn board_item_of_issue(v: &IssueView, repo_id: &str, label: &str) -> BoardItem {
    let open = v.state.open;
    BoardItem {
        id: v.issue.document_id.clone(),
        number: u64::from(v.issue.number),
        repo_id: repo_id.to_string(),
        repo: Some(label.to_string()),
        kind: ItemKind::Issue,
        state: if open {
            ItemState::Open
        } else {
            ItemState::Closed
        },
        created_at: v.issue.created_at as i64,
        closed_at: if open {
            None
        } else {
            closed_at_of(&v.log.transitions)
        },
        title: v.issue.title.clone(),
        labels: v.state.labels.iter().cloned().collect(),
        assignees: v.state.assignees.iter().cloned().collect(),
        milestone: fold_thread_meta_v2(&v.log.events).milestone,
        author: v.issue.author.clone(),
    }
}

/// A pull request as the board reads it (the web's `boardItemOfPull`).
#[must_use]
#[allow(clippy::cast_possible_wrap)] // ms since 1970
pub fn board_item_of_patch(v: &PatchView, repo_id: &str, label: &str) -> BoardItem {
    let state = if v.state.merged {
        ItemState::Merged
    } else if v.state.open {
        ItemState::Open
    } else {
        ItemState::Closed
    };
    BoardItem {
        id: v.patch.document_id.clone(),
        number: u64::from(v.patch.number),
        repo_id: repo_id.to_string(),
        repo: Some(label.to_string()),
        kind: ItemKind::Pr,
        state,
        created_at: v.patch.created_at as i64,
        closed_at: (state != ItemState::Open)
            .then(|| closed_at_of(&v.log.transitions))
            .flatten(),
        title: v.patch.title.clone(),
        labels: v.state.labels.iter().cloned().collect(),
        assignees: v.state.assignees.iter().cloned().collect(),
        milestone: v.review.milestone.clone(),
        author: v.patch.author.clone(),
    }
}

/// A placeholder for an item this reader cannot open ("a private item"): only what is plaintext
/// about it.
#[must_use]
pub fn placeholder(id: &str, repo_id: &str, kind: ItemKind) -> BoardItem {
    BoardItem {
        id: id.to_string(),
        number: 0,
        repo_id: repo_id.to_string(),
        repo: None,
        kind,
        state: ItemState::Open,
        created_at: 0,
        closed_at: None,
        title: String::new(),
        labels: Vec::new(),
        assignees: Vec::new(),
        milestone: None,
        author: String::new(),
    }
}

/// Which kinds a board's sources read in each source repository (absent `r`: `home`).
#[must_use]
pub fn source_kinds(spec: &BoardSpec, home: &str) -> BTreeMap<String, BTreeSet<ItemKind>> {
    use crate::rules::boards::SourceKind;
    let mut out: BTreeMap<String, BTreeSet<ItemKind>> = BTreeMap::new();
    for s in &spec.sources {
        let kinds = out
            .entry(s.r.clone().unwrap_or_else(|| home.to_string()))
            .or_default();
        if s.k != SourceKind::Pulls {
            kinds.insert(ItemKind::Issue);
        }
        if s.k != SourceKind::Issues {
            kinds.insert(ItemKind::Pr);
        }
    }
    out
}

/// The items of one source repository a board keeps (§2.4, the web's first walk): every open
/// one; the closed and merged ones inside the auto-archive window (`arch` days before `now`;
/// older ones are archived), or with `arch` 0 the [`CLOSED_PER_REPO`] most recently closed;
/// with `older`, the next [`CLOSED_PER_REPO`] closed ones past those (what the web's
/// `loadOlderClosed` reads for a view asking for `is:archived`); and every closed one a card
/// names (`carded`). `all` is every item of the repository of the sources' kinds. Returns the
/// kept items and whether older closed ones were left out.
#[must_use]
#[allow(clippy::implicit_hasher)] // the caller's set of carded ids
pub fn select_source_items(
    all: Vec<BoardItem>,
    arch: u16,
    carded: &HashSet<&str>,
    now: i64,
    older: bool,
) -> (Vec<BoardItem>, bool) {
    let (mut kept, mut closed): (Vec<BoardItem>, Vec<BoardItem>) =
        all.into_iter().partition(|i| i.state == ItemState::Open);
    // newest closed first; an unknown close time last
    closed.sort_by(|a, b| {
        b.closed_at
            .unwrap_or(i64::MIN)
            .cmp(&a.closed_at.unwrap_or(i64::MIN))
            .then_with(|| a.id.cmp(&b.id))
    });
    let cutoff = now - i64::from(arch) * DAY_MS;
    let recent = |n: usize, i: &BoardItem| {
        if arch > 0 {
            i.closed_at.is_some_and(|at| at >= cutoff)
        } else {
            n < CLOSED_PER_REPO
        }
    };
    // the first walk's closed items; with `older`, the next stretch past them
    let first = closed
        .iter()
        .enumerate()
        .take_while(|(n, i)| recent(*n, i))
        .count();
    let reach = if older {
        first + CLOSED_PER_REPO
    } else {
        first
    };
    let mut left_out = false;
    for (n, i) in closed.into_iter().enumerate() {
        if n < reach || carded.contains(i.id.as_str()) {
            kept.push(i);
        } else {
            left_out = true;
        }
    }
    (kept, left_out)
}

// ---------------------------------------------------------------------------------------------
// Write checks (§2.7, §3)
// ---------------------------------------------------------------------------------------------

/// What a board definition the rules refuse is called.
fn spec_problem(e: SpecError) -> &'static str {
    match e {
        SpecError::Json => "the board definition is not valid JSON",
        SpecError::Version => "the board definition is of a version this build does not write",
        SpecError::Size => "a board definition is at most 4096 bytes",
        SpecError::Desc => "a board description is at most 1024 characters",
        SpecError::Columns => "a board has 1 to 20 columns",
        SpecError::Column => "a column needs a unique name of 1-63 characters and an id of 1-255",
        SpecError::Def => "the default column is not one of the board's columns",
        SpecError::Done => "the Done column is not one of the board's columns",
        SpecError::Sources => "a board has at most 5 sources",
        SpecError::Source => {
            "a source names issues, pull requests or both, with a query of at most 512 characters"
        }
        SpecError::Fields => "a board has at most 12 fields",
        SpecError::Field => {
            "a field needs a unique name and an id of 1-255, and may not be named like a query key"
        }
        SpecError::Options => "a select field has 1-30 options with unique names",
        SpecError::Views => "a board has at most 8 views",
        SpecError::View => {
            "a view's grouping, swimlanes, sort and columns must name the board's own fields"
        }
        SpecError::Arch => "auto-archive is 0 to 3650 days",
    }
}

/// E201 for a board write the board or the schema refuses, before anything is signed.
fn refused(message: impl Into<String>) -> Error {
    UserError::new(codes::USAGE, message)
        .note("checked before anything was signed; nothing was written or paid")
        .into()
}

/// The trimmed name and canonical definition JSON a board write stores, or the refusal (the
/// web's `checkBoardInput`).
pub fn check_board_input(name: &str, spec: &BoardSpec) -> Result<BoardFields> {
    let name = name.trim();
    if !is_board_name(name) {
        return Err(refused(
            "a board name is 1-63 characters, with no control characters",
        ));
    }
    let spec = serialize_spec(spec).map_err(|e| refused(spec_problem(e)))?;
    Ok(BoardFields {
        name: name.to_string(),
        spec,
    })
}

/// A new board's key (§2.1): with an `intent`, derived from it and the repository (the web's
/// `newBoardKey`: `sha256("dash-forge board key\0" ‖ repoId ‖ "\0" ‖ intent ‖ "\0" ‖ attempt)`,
/// big-endian, 0 read as 1), so a retry of one create names the same board; else random.
pub fn new_board_key(repo_id: &str, intent: Option<&str>, attempt: u32) -> Result<u32> {
    let bytes = if let Some(i) = intent {
        use sha2::Digest as _;
        let h = sha2::Sha256::digest(
            format!("dash-forge board key\u{0}{repo_id}\u{0}{i}\u{0}{attempt}").as_bytes(),
        );
        [h[0], h[1], h[2], h[3]]
    } else {
        let r = crate::private::keys::rnd32()?;
        [r[0], r[1], r[2], r[3]]
    };
    let k = u32::from_be_bytes(bytes);
    Ok(if k == 0 { 1 } else { k })
}

fn refuse_unless_open(board: &Board) -> Result<()> {
    match board.state {
        BoardState::Open => Ok(()),
        BoardState::Deleted => Err(refused("this board was deleted")),
        BoardState::Closed => Err(UserError::new(
            codes::USAGE,
            "this board is closed: reopen it to change it",
        )
        .fix(format!("`dg board close <repo> {} --reopen`", board.key))
        .note("checked before anything was signed; nothing was written or paid")
        .into()),
    }
}

/// E313 for a board whose definition did not open or parse here.
fn unreadable(board: &Board, what: &str) -> Error {
    let code = if board.spec_error.as_deref() == Some("unreadable") {
        codes::MEMBERS_ONLY
    } else {
        codes::INVALID_CONFIG
    };
    UserError::new(
        code,
        format!("this board's definition can't be read here, so {what}"),
    )
    .cause(match board.spec_error.as_deref() {
        Some("unreadable") | None => "it is sealed with keys this reader does not hold".into(),
        Some(e) => format!("its definition is refused by the board rules ({e})"),
    })
    .into()
}

/// The item a card names: its id and its repository (for the cross-repository confirm, §3.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardItem {
    /// The item's `$id`.
    pub id: String,
    /// Its repository's id.
    pub repo_id: String,
}

impl CardItem {
    /// `item`'s.
    #[must_use]
    pub fn of(item: &BoardItem) -> Self {
        Self {
            id: item.id.clone(),
            repo_id: item.repo_id.clone(),
        }
    }
}

/// What a card write changes; everything else is carried over from the item's newest card.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CardPatch {
    /// The column id; 0 for "No status".
    pub col: Option<u8>,
    /// An explicit rank (§2.6).
    pub rank: Option<String>,
    /// Field values by field id: `Some` sets one, `None` clears it.
    pub fields: BTreeMap<u8, Option<Scalar>>,
    /// 0 active, 1 archived, 2 removed.
    pub state: Option<i64>,
}

impl CardPatch {
    /// A patch setting only `state`.
    #[must_use]
    pub fn state(state: i64) -> Self {
        Self {
            state: Some(state),
            ..Self::default()
        }
    }
}

/// Whether a card for an item of `item_repo_id` on a board of `home` must be confirmed first
/// (§3.3): `item` is plaintext and indexed, so a private repository's card naming another
/// repository's item tells everyone that the private repository tracks it.
#[must_use]
pub fn cross_repo_card_needs_confirm(home: &RepoRef, item_repo_id: &str) -> bool {
    home.visibility == Visibility::Private && item_repo_id != home.id()
}

/// What [`cross_repo_card_needs_confirm`] warns of.
pub const CROSS_REPO_WARNING: &str = "this board is in a private repository: placing an item of another repository on it shows everyone that this repository tracks that item";

fn refuse_unless_confirmed(home: &RepoRef, item_repo_id: &str, confirmed: bool) -> Result<()> {
    if cross_repo_card_needs_confirm(home, item_repo_id) && !confirmed {
        return Err(
            UserError::new(codes::CONFIRMATION_REQUIRED, CROSS_REPO_WARNING)
                .fix("confirm at the prompt, or pass --yes")
                .note("checked before anything was signed; nothing was written or paid")
                .into(),
        );
    }
    Ok(())
}

/// A scalar as the JSON value a card stores.
fn json_of(v: &Scalar) -> Option<serde_json::Value> {
    match v {
        Scalar::Num(x) => serde_json::Number::from_f64(*x).map(serde_json::Value::Number),
        Scalar::Text(t) => Some(serde_json::Value::String(t.clone())),
    }
}

/// Refuse a patch the board or the schema would refuse (the web's `checkPatch`).
pub fn check_patch(spec: &BoardSpec, patch: &CardPatch) -> Result<()> {
    if patch
        .col
        .is_some_and(|c| c != 0 && !spec.columns.iter().any(|x| x.id == c))
    {
        return Err(refused("that column is not on this board"));
    }
    if patch.rank.as_deref().is_some_and(|r| !is_explicit_rank(r)) {
        return Err(refused("a rank is 1-63 rank digits, not ending in 0"));
    }
    if patch
        .state
        .is_some_and(|s| ![CARD_ACTIVE, CARD_ARCHIVED, CARD_REMOVED].contains(&s))
    {
        return Err(refused("a card is active, archived or removed"));
    }
    for (id, v) in &patch.fields {
        let Some(field) = spec.field(*id) else {
            return Err(refused("that field is not on this board"));
        };
        if let Some(v) = v {
            if json_of(v).and_then(|j| field_value_ok(field, &j)).is_none() {
                return Err(refused(format!(
                    "that is not a valid value for {}",
                    field.name
                )));
            }
        }
    }
    Ok(())
}

/// The card a patch makes (the web's `patchedCard`'s result).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchedCard {
    /// The column.
    pub col: Option<u8>,
    /// The explicit rank.
    pub rank: Option<String>,
    /// The field values' JSON.
    pub f: Option<String>,
    /// The state.
    pub state: i64,
}

/// The card `patch` makes over `base` (the item's newest card, any member's, or none): its
/// column, rank and state replaced where given, its field values merged (`None` clears one).
pub fn patched_card(
    spec: &BoardSpec,
    base: Option<&CardDoc>,
    patch: &CardPatch,
) -> Result<PatchedCard> {
    let mut values = parse_field_values(base.and_then(|b| b.f.as_deref()), spec);
    for (id, v) in &patch.fields {
        match v {
            Some(v) => values.insert(*id, v.clone()),
            None => values.remove(id),
        };
    }
    let f = serialize_field_values(&values, spec)
        .ok_or_else(|| refused("these field values are over 2048 bytes"))?;
    let rank = patch.rank.clone().or_else(|| {
        base.and_then(|b| b.rank.clone())
            .filter(|r| is_explicit_rank(r))
    });
    let col = patch
        .col
        .or_else(|| base.and_then(|b| b.col).and_then(|c| u8::try_from(c).ok()));
    Ok(PatchedCard {
        col,
        rank,
        f: (f != "{}").then_some(f),
        state: patch
            .state
            .or_else(|| base.map(|b| b.state))
            .unwrap_or(CARD_ACTIVE),
    })
}

// ---------------------------------------------------------------------------------------------
// Ranks (§2.6, §5.2)
// ---------------------------------------------------------------------------------------------

/// A card in a column's shown order: its item and its effective rank (the fold's).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RankedCard {
    /// The item's `$id`.
    pub id: String,
    /// Its effective rank.
    pub rank: String,
}

/// The rank that drops a card at position `index` (0 = the top) of `column`, the column's cards
/// in rank order without the one moving (the web's `rankForDrop`): the top is [`top_rank`]
/// (above the sourced pool), the bottom [`bottom_rank`] (below it), elsewhere
/// [`rank_between`] the two neighbours.
pub fn rank_for_drop(
    column: &[RankedCard],
    index: usize,
) -> std::result::Result<String, RankError> {
    let at = index.min(column.len());
    if column.is_empty() {
        return top_rank(None);
    }
    if at == 0 {
        return top_rank(Some(&column[0].rank));
    }
    if at == column.len() {
        return bottom_rank(Some(&column[at - 1].rank));
    }
    rank_between(&column[at - 1].rank, &column[at].rank)
}

/// Where a move puts a card in its column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DropAt {
    /// At the top.
    Top,
    /// At the bottom.
    Bottom,
    /// Just before this item.
    Before(String),
    /// Just after this item.
    After(String),
}

/// The rank that drops `item` at `at` in `column` (the target column's cards in rank order;
/// the moving card itself may be among them and is left out). `None` when `at` names an item
/// that is not in the column.
#[must_use]
pub fn rank_at(
    column: &[RankedCard],
    item: &str,
    at: &DropAt,
) -> Option<std::result::Result<String, RankError>> {
    let others: Vec<RankedCard> = column.iter().filter(|c| c.id != item).cloned().collect();
    let pos = |id: &str| others.iter().position(|c| c.id == id);
    let index = match at {
        DropAt::Top => 0,
        DropAt::Bottom => others.len(),
        DropAt::Before(id) => pos(id)?,
        DropAt::After(id) => pos(id)? + 1,
    };
    Some(rank_for_drop(&others, index))
}

/// What a [`RankError`] tells the user (the web's `RANK_PROBLEM`).
fn rank_problem(e: RankError) -> Error {
    match e {
        RankError::Invalid => refused("the neighbouring ranks are not ranks"),
        RankError::Order => refused("the neighbours are out of order: read the board again"),
        RankError::Rerank => refused(
            "there is no room left between these cards: re-rank this column first (move the cards to its top or bottom)",
        ),
    }
}

/// How many of the writes to `items` create a card (the signer has none for it) and how many
/// replace one: what is priced first.
#[must_use]
pub fn plan_card_writes(cards: &[BoardCard], me: &str, items: &[String]) -> (usize, usize) {
    let mine: HashSet<&str> = cards
        .iter()
        .filter(|c| c.card.owner_id == me)
        .map(|c| c.card.item.as_str())
        .collect();
    let creates = items
        .iter()
        .filter(|id| !mine.contains(id.as_str()))
        .count();
    (creates, items.len() - creates)
}

/// The items "move open items to the next iteration" moves (§5.4): every open item on the
/// board (not archived) whose iteration field `field_id` is the current iteration at `now`,
/// outside the Done column; and that next iteration's index. `None` when there is no current
/// iteration (or the field is not an iteration field).
#[must_use]
pub fn next_iteration_plan(
    spec: &BoardSpec,
    field_id: u8,
    items: &[BoardItem],
    placements: &[Placement],
    now: i64,
) -> Option<(i64, Vec<CardItem>)> {
    let field = spec.field(field_id).filter(|f| f.kind == FieldType::Iter)?;
    let current = iteration_at(field, now)?;
    if current + 1 > ITER_INDEX_MAX {
        return None;
    }
    let by_id: HashMap<&str, &BoardItem> = items.iter().map(|i| (i.id.as_str(), i)).collect();
    let want = Scalar::from(current);
    let moving = placements
        .iter()
        .filter_map(|p| {
            let item = by_id.get(p.id.as_str())?;
            let open = item.state == ItemState::Open && p.on && p.archived.is_none();
            let in_done = spec.done != 0 && p.col == spec.done;
            (open && !in_done && p.fields.get(&field_id) == Some(&want)).then(|| CardItem::of(item))
        })
        .collect();
    Some((current + 1, moving))
}

/// An existing item a quick add names (§5.3, the web's `parseItemReference`): `#12`,
/// `owner/name#12`, or an issue, PR or number link of the web app
/// (`/repo/issue/?owner=…&name=…&number=12`); `None` for anything else. The owner and name are
/// as written, resolved by the caller.
#[must_use]
pub fn parse_item_reference(text: &str) -> Option<ItemReference> {
    let t = text.trim();
    let number = |s: &str| -> Option<u32> {
        ((1..=10).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse().ok())
            .flatten()
    };
    if let Some(n) = t.strip_prefix('#') {
        return Some(ItemReference {
            repo: None,
            number: number(n)?,
        });
    }
    if let Some((repo, n)) = t.rsplit_once('#') {
        let plain = |s: &str| {
            !s.is_empty() && !s.contains(|c: char| c.is_whitespace() || c == '/' || c == '#')
        };
        if let Some((owner, name)) = repo.split_once('/') {
            if plain(owner) && plain(name) && !t.contains("://") {
                return Some(ItemReference {
                    repo: Some((owner.to_string(), name.to_string())),
                    number: number(n)?,
                });
            }
        }
    }
    // a link of the web app: `<origin>/repo/issue/?owner=…&name=…&number=12`
    let (_, rest) = t.split_once("://")?;
    let path_query = &rest[rest.find('/')?..];
    let (path, query) = path_query.split_once('?')?;
    let query = query.split('#').next().unwrap_or_default();
    let path = path.strip_suffix('/').unwrap_or(path);
    if !["/repo/issue", "/repo/pull", "/repo/number"].contains(&path) {
        return None;
    }
    let param = |k: &str| {
        query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .find(|(key, _)| *key == k)
            .map(|(_, v)| percent_decode(v))
    };
    Some(ItemReference {
        repo: Some((param("owner")?, param("name")?)),
        number: number(&param("number")?)?,
    })
}

/// `%xx` and `+` decoded (a link's query value); a `%` without two hex digits kept as written.
fn percent_decode(s: &str) -> String {
    let hex = |b: u8| {
        char::from(b)
            .to_digit(16)
            .and_then(|d| u8::try_from(d).ok())
    };
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let pair = (bytes[i] == b'%')
            .then(|| Some(hex(*bytes.get(i + 1)?)? * 16 + hex(*bytes.get(i + 2)?)?))
            .flatten();
        match (bytes[i], pair) {
            (_, Some(b)) => {
                out.push(b);
                i += 2;
            }
            (b'+', None) => out.push(b' '),
            (b, None) => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// An item a quick add names: its repository (`owner`, `name`) when given, and its number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemReference {
    /// `(owner, name)` as written; `None`: the board's home repository.
    pub repo: Option<(String, String)>,
    /// The issue or PR number.
    pub number: u32,
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

/// The outcome of a board write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardWritten {
    /// The board's key.
    pub key: u32,
    /// The signer's revision document.
    pub document_id: String,
    /// A new document (the signer's first revision of this board), or a replace of theirs.
    pub created: bool,
    /// `false` when the stored revision already held the change (nothing signed or paid).
    pub changed: bool,
}

/// The outcome of a card write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardWritten {
    /// The item.
    pub item: String,
    /// The signer's card document.
    pub document_id: String,
    /// A new document, or a replace of the signer's own.
    pub created: bool,
    /// `false` when the stored card already held the change (nothing signed or paid).
    pub changed: bool,
    /// The column written.
    pub col: Option<u8>,
    /// The rank written.
    pub rank: Option<String>,
    /// The field values written.
    pub f: Option<String>,
    /// The state written.
    pub state: i64,
}

/// The outcome of a write to several cards: each item's, in order; the first failure stops the
/// rest.
#[derive(Debug)]
pub struct BulkWritten {
    /// What landed.
    pub written: Vec<CardWritten>,
    /// The item whose write failed, and why.
    pub failed: Option<(String, Error)>,
    /// Items not written because an earlier write failed.
    pub skipped: Vec<String>,
}

/// The outcome of [`Collab::quick_add_issue`]: the new issue, as the board reads it, and its
/// card (`Err` when only the issue landed: place it again).
#[derive(Debug)]
pub struct QuickAdded {
    /// The new issue.
    pub item: BoardItem,
    /// Its card, or why it was not written.
    pub card: std::result::Result<CardWritten, Error>,
}

/// E702 when the network's Forge has no boards (no forge-meta, or one before UPDATE-3).
fn no_boards(repo: &RepoRef) -> Error {
    UserError::new(
        codes::NOT_DEPLOYED,
        format!(
            "boards are not available for {} on this network yet",
            repo.display()
        ),
    )
    .cause("this network's Forge contracts have no `board` and `card` documents (the boards update is not registered here)")
    .into()
}

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------

/// The two forge-collab item types, in the order the web looks an id or number up in.
const ITEM_DOCS: [(&str, ItemKind); 2] = [(DOC_ISSUE, ItemKind::Issue), (DOC_PATCH, ItemKind::Pr)];

/// The owner's repositories an item's sidebar read takes, at most, as the homes its boards may
/// live in (the web's `OWNER_REPO_PAGES` pages of 100).
pub const OWNER_REPO_ROWS: usize = 300;
/// Cards one `card.onItem` read of an item's sidebar follows at most (the web's
/// `ITEM_CARD_PAGES` pages of 100).
pub const ITEM_CARD_ROWS: usize = 300;
/// Pull request pages (100 each) a source repository's read follows at most (the web reads its
/// open pull requests' list as far, `OPEN_PAGES`).
pub const PR_PAGES: usize = 30;

/// `content`'s set fields: a create's properties.
fn present(content: &BTreeMap<String, Option<FieldValue>>) -> BTreeMap<String, FieldValue> {
    content
        .iter()
        .filter_map(|(k, v)| v.clone().map(|v| (k.clone(), v)))
        .collect()
}

impl Collab<'_> {
    /// The contract that holds `board` and `card` (forge-meta), or E702 when this network's
    /// has none.
    pub async fn board_contract(&self, repo: &RepoRef) -> Result<LoadedContract> {
        let Some(id) = repo.forge().contract_id_of(DOC_BOARD) else {
            return Err(no_boards(repo));
        };
        let contract = self.client().fetch_contract(id).await?;
        if !contract.has_document_type(DOC_BOARD) || !contract.has_document_type(DOC_CARD) {
            return Err(no_boards(repo));
        }
        Ok(contract)
    }

    /// The keys a reader of `repo` opens sealed boards and cards with (the web's `openerOf`):
    /// a private repository's (a member's); for a repository made public, the epoch keys its
    /// owner published (`private-repos.md` §18.3), which open what was sealed while it was
    /// private; none for any other public repository.
    async fn board_keys(&self, repo: &RepoRef) -> Result<Option<Arc<Keyring>>> {
        if repo.visibility == Visibility::Private {
            return Ok(Some(self.keyring(repo).await?));
        }
        Ok(
            match self
                .published_keys(repo, super::v2::Unopened::NotAMember)
                .await
            {
                super::v2::DocKeys::Held(kr, _) => Some(kr),
                super::v2::DocKeys::None(_) => None,
            },
        )
    }

    /// `f` given the reader's [`Opener`] for `repo` ([`Self::board_keys`]).
    async fn with_opener<R>(&self, repo: &RepoRef, f: impl FnOnce(Opener<'_>) -> R) -> Result<R> {
        let keys = self.board_keys(repo).await?;
        let open = |s: &sealed::StoredBoardDoc| {
            keys.as_ref().map_or(Opened::Malformed, |k| k.open_board(s))
        };
        let opener: Opener<'_> = keys
            .as_ref()
            .map(|_| &open as &dyn Fn(&sealed::StoredBoardDoc) -> Opened);
        Ok(f(opener))
    }

    /// `docs` of `repo` as [`Board`]s.
    async fn boards_from(
        &self,
        repo: &RepoRef,
        docs: &[FetchedDocument],
        with_deleted: bool,
    ) -> Result<Vec<Board>> {
        self.with_opener(repo, |o| {
            boards_of(
                repo.id(),
                docs,
                |d| board_doc_of(d, repo.visibility, o),
                with_deleted,
            )
        })
        .await
    }

    /// `docs` of `repo` as cards, the malformed dropped.
    async fn cards_from(&self, repo: &RepoRef, docs: &[FetchedDocument]) -> Result<Vec<BoardCard>> {
        self.with_opener(repo, |o| {
            docs.iter()
                .filter_map(|d| card_doc_of(d, repo.visibility, o))
                .collect()
        })
        .await
    }

    /// Every `board` document of `repo` (`board.byKey`, `repoId ==`), as stored; only key `key`
    /// when given.
    async fn board_docs(&self, repo: &RepoRef, key: Option<u32>) -> Result<Vec<FetchedDocument>> {
        let contract = self.board_contract(repo).await?;
        let mut filters = vec![Self::repo_filter(repo)?];
        if let Some(k) = key {
            filters.push(QueryFilter::eq("key", FieldValue::integer(u64::from(k))));
        }
        self.client()
            .query_all_documents(
                &contract,
                DOC_BOARD,
                &filters,
                &[QueryOrder::asc("key"), QueryOrder::asc("$ownerId")],
            )
            .await
    }

    /// Every board of `repo`: per key the newest revision over every member's, ascending by
    /// key, open and closed; deleted ones only `with_deleted`.
    pub async fn boards(&self, repo: &RepoRef, with_deleted: bool) -> Result<Vec<Board>> {
        let docs = self.board_docs(repo, None).await?;
        self.boards_from(repo, &docs, with_deleted).await
    }

    /// Board `key` of `repo` as its newest revision defines it (every member's revision read
    /// fresh), or `None` when it has none. A deleted board reads as deleted.
    pub async fn board_definition(&self, repo: &RepoRef, key: u32) -> Result<Option<Board>> {
        let docs = self.board_docs(repo, Some(key)).await?;
        Ok(self
            .boards_from(repo, &docs, true)
            .await?
            .into_iter()
            .next())
    }

    /// The `card.recent` documents of board `key` of `repo`, oldest change first (from
    /// `since` ms, inclusive).
    async fn recent_cards(
        &self,
        repo: &RepoRef,
        key: u32,
        since: Option<i64>,
    ) -> Result<Vec<BoardCard>> {
        let contract = self.board_contract(repo).await?;
        let mut filters = vec![
            Self::repo_filter(repo)?,
            QueryFilter::eq("board", FieldValue::integer(u64::from(key))),
        ];
        if let Some(t) = since {
            filters.push(QueryFilter::gte(
                "$updatedAt",
                FieldValue::uint64(u64::try_from(t).unwrap_or(0)),
            ));
        }
        let docs = self
            .client()
            .query_all_documents(
                &contract,
                DOC_CARD,
                &filters,
                &[QueryOrder::asc("board"), QueryOrder::asc("$updatedAt")],
            )
            .await?;
        self.cards_from(repo, &docs).await
    }

    /// Board `key` of `repo`: its definition and every card on it, every member's
    /// (`card.recent`), or `None` when the board has no revision. Cards of a board whose
    /// definition did not open are still read (their states are plaintext).
    pub async fn board(&self, repo: &RepoRef, key: u32) -> Result<Option<BoardRead>> {
        let Some(board) = self.board_definition(repo, key).await? else {
            return Ok(None);
        };
        let cards = merge_cards(&[], &self.recent_cards(repo, key, None).await?);
        let since = cards_since(&cards);
        Ok(Some(BoardRead {
            board,
            cards,
            since,
        }))
    }

    /// The cards of board `key` written or replaced at or after `since` ms: `>=`, since several
    /// cards can share a block time, so a caller merges them by `$id` ([`merge_cards`]).
    pub async fn cards_since(
        &self,
        repo: &RepoRef,
        key: u32,
        since: i64,
    ) -> Result<Vec<BoardCard>> {
        self.recent_cards(repo, key, Some(since)).await
    }

    /// Every member's card for `item_id` on board `key` of `repo`, read fresh (`card.onItem`):
    /// what a card write applies its change to (§3.2), and `me`'s own card document, found among
    /// the raw rows (one this reader skips as malformed is still the one the unique index holds).
    pub async fn item_card_docs(
        &self,
        repo: &RepoRef,
        key: u32,
        item_id: &str,
        me: &str,
    ) -> Result<ItemCardDocs> {
        let contract = self.board_contract(repo).await?;
        let docs = self
            .client()
            .query_all_documents(
                &contract,
                DOC_CARD,
                &[
                    QueryFilter::eq(
                        "item",
                        FieldValue::identifier(platform::decode_identifier(item_id)?),
                    ),
                    Self::repo_filter(repo)?,
                    QueryFilter::eq("board", FieldValue::integer(u64::from(key))),
                ],
                &[QueryOrder::asc("repoId"), QueryOrder::asc("board")],
            )
            .await?;
        let own = docs.iter().find(|d| d.owner_id == me).map(|d| d.id.clone());
        Ok(ItemCardDocs {
            cards: self.cards_from(repo, &docs).await?,
            own,
        })
    }

    /// The repositories whose boards `repo`'s items show in their sidebar (§5.6, the web's
    /// `sidebarHomes`): `repo` itself and its owner's other public repositories (at most
    /// [`OWNER_REPO_ROWS`]; a private one's boards are sealed with keys this read does not
    /// hold), by id.
    async fn sidebar_homes(&self, repo: &RepoRef) -> Result<BTreeMap<String, RepoRef>> {
        let core = self.core_contract(repo).await?;
        let owner = platform::decode_identifier(repo.owner_id())?;
        let docs = self
            .client()
            .query_documents_up_to(
                &core,
                crate::resolve::DOC_REPO,
                &[QueryFilter::eq("$ownerId", FieldValue::identifier(owner))],
                &[QueryOrder::asc("name")],
                OWNER_REPO_ROWS,
            )
            .await?;
        Ok(sidebar_homes_of(
            repo,
            &docs[..docs.len().min(OWNER_REPO_ROWS)],
        ))
    }

    /// The boards issue or PR `item_id` of `repo` has a card on, whose home is `repo` or
    /// another public repository of the same owner (§5.6: a stranger's board naming the issue
    /// is never read, nor a private repository's, sealed with keys this read does not hold).
    /// The owner's repositories are read first ([`Self::sidebar_homes`]), then `card.onItem`
    /// with `item ==` and `repoId in` them (100 a read, at most [`ITEM_CARD_ROWS`] each), so
    /// cards anyone else writes naming the item cost this read nothing. Deleted boards are
    /// left out, closed ones kept. Ordered by home repository (`repo` first), then key.
    pub async fn item_boards(&self, repo: &RepoRef, item_id: &str) -> Result<Vec<ItemBoard>> {
        let contract = self.board_contract(repo).await?;
        let item = FieldValue::identifier(platform::decode_identifier(item_id)?);
        let homes = self.sidebar_homes(repo).await?;
        let ids: Vec<&String> = homes.keys().collect();
        let mut by_home: BTreeMap<String, Vec<FetchedDocument>> = BTreeMap::new();
        for chunk in ids.chunks(100) {
            let in_homes = chunk
                .iter()
                .map(|id| platform::decode_identifier(id).map(FieldValue::identifier))
                .collect::<Result<Vec<_>>>()?;
            let docs = self
                .client()
                .query_documents_up_to(
                    &contract,
                    DOC_CARD,
                    &[
                        QueryFilter::eq("item", item.clone()),
                        QueryFilter::in_list("repoId", in_homes),
                    ],
                    &[QueryOrder::asc("repoId"), QueryOrder::asc("board")],
                    ITEM_CARD_ROWS,
                )
                .await?;
            for d in docs.into_iter().take(ITEM_CARD_ROWS) {
                if let Some(home) = d.field_bytes32("repoId").map(platform::encode_identifier) {
                    if homes.contains_key(&home) {
                        by_home.entry(home).or_default().push(d);
                    }
                }
            }
        }
        let mut ordered: Vec<(String, Vec<FetchedDocument>)> = by_home.into_iter().collect();
        ordered.sort_by_key(|(h, _)| (h != repo.id(), h.clone()));
        let mut out = Vec::new();
        for (home_id, home_docs) in ordered {
            let Some(home) = homes.get(&home_id).cloned() else {
                continue;
            };
            let mut by_key: BTreeMap<u32, Vec<FetchedDocument>> = BTreeMap::new();
            for d in home_docs {
                if let Some(k) = u32_of(&d, "board").filter(|k| *k > 0) {
                    by_key.entry(k).or_default().push(d);
                }
            }
            for (key, key_docs) in by_key {
                let Some(board) = self.board_definition(&home, key).await? else {
                    continue;
                };
                if board.state == BoardState::Deleted {
                    continue;
                }
                let cards = self.cards_from(&home, &key_docs).await?;
                let docs = card_docs(&cards);
                let newest = newest_cards(&docs).get(item_id).map(|c| c.id.clone());
                let card = newest.and_then(|id| cards.iter().find(|c| c.card.id == id).cloned());
                out.push(ItemBoard {
                    home: home.clone(),
                    board,
                    cards,
                    card,
                });
            }
        }
        Ok(out)
    }

    /// Every item of `repo` of `kinds`, as the board reads it: every issue, and every pull
    /// request, newest first, page after page ([`Self::list_patch_views_before`], at most
    /// [`PR_PAGES`] pages, as the web reads its open ones); `true` when that cap left some
    /// pull requests unread.
    async fn repo_items(
        &self,
        repo: &RepoRef,
        kinds: &BTreeSet<ItemKind>,
    ) -> Result<(Vec<BoardItem>, bool)> {
        let label = repo.display();
        let mut items = Vec::new();
        let mut partial = false;
        if kinds.contains(&ItemKind::Issue) {
            let read = self.issues_with_state_read(repo).await?;
            items.extend(
                read.rows
                    .iter()
                    .map(|v| board_item_of_issue(v, repo.id(), &label)),
            );
        }
        if kinds.contains(&ItemKind::Pr) {
            let mut seen = HashSet::new();
            let mut before: Option<u64> = None;
            for page in 0..PR_PAGES {
                let (listed, _) = self.list_patch_views_before(repo, 0, before).await?;
                // the page's oldest row, readable or not: the next page starts at its time
                let oldest = listed
                    .rows
                    .iter()
                    .map(|(v, _)| v.patch.created_at)
                    .chain(listed.members_only.iter().map(|m| m.created_at))
                    .min();
                let mut added = 0;
                for (v, _) in &listed.rows {
                    if seen.insert(v.patch.document_id.clone()) {
                        items.push(board_item_of_patch(v, repo.id(), &label));
                        added += 1;
                    }
                }
                added += listed
                    .members_only
                    .iter()
                    .filter(|m| seen.insert(m.document_id.clone()))
                    .count();
                if !listed.more {
                    break;
                }
                // a full page with no readable time to go on from, or one that added nothing
                // (one time shared by 100+ PRs), or the last page read: some PRs are left out
                if oldest.is_none() || (added == 0 && before == oldest) || page + 1 == PR_PAGES {
                    partial = true;
                    break;
                }
                before = oldest;
            }
        }
        Ok((items, partial))
    }

    /// Whether this reader opens `repo`'s items on a board of `home`: a public repository, the
    /// home, or another private repository whose keys this signer holds (a member of both,
    /// §2.5); remembered in `known`. A key this signer does not hold is no error: those items
    /// show as "a private item".
    async fn opens_items(
        &self,
        repo: &RepoRef,
        home: &RepoRef,
        known: &mut BTreeMap<String, bool>,
    ) -> Result<bool> {
        if repo.visibility != Visibility::Private || repo.id() == home.id() {
            return Ok(true);
        }
        if let Some(held) = known.get(repo.id()) {
            return Ok(*held);
        }
        // a keyring loads for a reader with no key too: holding one is `require_key`'s answer
        let held = match self.keyring(repo).await {
            Ok(kr) => kr.require_key(repo).is_ok(),
            Err(Error::User(_)) => false,
            Err(e) => return Err(e),
        };
        known.insert(repo.id().to_string(), held);
        Ok(held)
    }

    /// Repository `repo_id`: `home` itself, one already read, or resolved.
    async fn repo_of(
        &self,
        home: &RepoRef,
        known: &mut BTreeMap<String, Option<RepoRef>>,
        repo_id: &str,
    ) -> Option<RepoRef> {
        if repo_id == home.id() {
            return Some(home.clone());
        }
        if let Some(r) = known.get(repo_id) {
            return r.clone();
        }
        let r = crate::resolve::resolve_id(self.client(), repo_id)
            .await
            .ok();
        known.insert(repo_id.to_string(), r.clone());
        r
    }

    /// Where card-named item `id` is: its forge-collab document, its kind and its repository;
    /// `None` when it is no issue or PR of a repository this reader finds.
    async fn locate_carded(
        &self,
        home: &RepoRef,
        known: &mut BTreeMap<String, Option<RepoRef>>,
        collab: &LoadedContract,
        id: &str,
    ) -> Result<Option<(FetchedDocument, ItemKind, RepoRef)>> {
        for (doc_type, kind) in ITEM_DOCS {
            let Some(d) = self.client().fetch_document(collab, doc_type, id).await? else {
                continue;
            };
            let Some(repo_id) = d.field_bytes32("repoId").map(platform::encode_identifier) else {
                return Ok(None);
            };
            return Ok(self
                .repo_of(home, known, &repo_id)
                .await
                .map(|repo| (d, kind, repo)));
        }
        Ok(None)
    }

    /// Every item of the board `spec` of `home` describes (§2.3, §2.4; the web's
    /// `loadBoardItems`): its source repositories' items ([`select_source_items`]; with
    /// `archived`, the next stretch of older closed ones too, as the web reads for a view asking
    /// for `is:archived`), then every item `cards` name that the sources did not bring, by id in
    /// its own repository (a placeholder where it cannot be opened). A source repository that is
    /// private, not the home and not one whose keys this signer holds ([`Self::opens_items`])
    /// contributes nothing (its items show as placeholders where a card names them).
    pub async fn board_items(
        &self,
        home: &RepoRef,
        spec: &BoardSpec,
        cards: &[CardDoc],
        now: i64,
        archived: bool,
    ) -> Result<BoardItemSet> {
        let carded: HashSet<&str> = cards.iter().map(|c| c.item.as_str()).collect();
        let mut known = BTreeMap::new();
        let mut opens = BTreeMap::new();
        let mut set = BoardItemSet::default();
        let mut by_id: BTreeMap<String, BoardItem> = BTreeMap::new();
        for (repo_id, kinds) in source_kinds(spec, home.id()) {
            let Some(repo) = self.repo_of(home, &mut known, &repo_id).await else {
                continue;
            };
            if !self.opens_items(&repo, home, &mut opens).await? {
                continue;
            }
            let (all, partial) = self.repo_items(&repo, &kinds).await?;
            set.partial |= partial;
            let (kept, older) = select_source_items(all, spec.arch, &carded, now, archived);
            set.has_older_closed |= older;
            for i in kept {
                by_id.insert(i.id.clone(), i);
            }
        }
        let mut wanted: Vec<&str> = carded
            .iter()
            .copied()
            .filter(|id| !by_id.contains_key(*id))
            .collect();
        wanted.sort_unstable();
        let collab = self.collab_contract(home).await?;
        for id in wanted {
            let Some((d, kind, repo)) = self.locate_carded(home, &mut known, &collab, id).await?
            else {
                set.missing.insert(id.to_string());
                continue;
            };
            let item = if self.opens_items(&repo, home, &mut opens).await? {
                self.item_by_doc(&repo, kind, &d).await?
            } else {
                None
            };
            if let Some(i) = item {
                by_id.insert(i.id.clone(), i);
            } else {
                // located but not shown: a private or members-only item this reader cannot open
                set.hidden.insert(id.to_string());
                by_id.insert(id.to_string(), placeholder(id, repo.id(), kind));
            }
        }
        set.items = by_id.into_values().collect();
        Ok(set)
    }

    /// The board item of the issue or PR `d` of `repo`, read as its list reads it; `None` when
    /// this reader cannot open it (members-only, or not the well-formed item its number names).
    /// A failed read is an error, never "a private item".
    async fn item_by_doc(
        &self,
        repo: &RepoRef,
        kind: ItemKind,
        d: &FetchedDocument,
    ) -> Result<Option<BoardItem>> {
        use super::v2::{TargetKind, TargetRead};
        let label = repo.display();
        let (target, number) = match kind {
            ItemKind::Issue => (TargetKind::Issue, issue_from_doc(d).number),
            ItemKind::Pr => (TargetKind::Patch, patch_from_doc(d).number),
        };
        let Some(TargetRead::Readable(read)) = self.target_read(repo, target, number).await? else {
            return Ok(None);
        };
        if read.id != d.id {
            return Ok(None);
        }
        Ok(match kind {
            ItemKind::Issue => self
                .issue_view(repo, number)
                .await?
                .map(|v| board_item_of_issue(&v, repo.id(), &label)),
            ItemKind::Pr => {
                let v = self.patch_view(repo, patch_from_doc(&read)).await?;
                Some(board_item_of_patch(&v, repo.id(), &label))
            }
        })
    }

    /// Board `key` of `repo` read whole and folded at `now`: its definition and cards, its items
    /// ([`Self::board_items`], with the older closed ones when `archived`: a view asking for
    /// `is:archived`) and the fold. `None` when the board has no revision.
    pub async fn board_snapshot(
        &self,
        repo: &RepoRef,
        key: u32,
        now: i64,
        archived: bool,
    ) -> Result<Option<BoardSnapshot>> {
        let Some(read) = self.board(repo, key).await? else {
            return Ok(None);
        };
        let docs = card_docs(&read.cards);
        let (items, fold) = match &read.board.spec {
            Some(spec) => {
                let items = self.board_items(repo, spec, &docs, now, archived).await?;
                let fold =
                    crate::rules::boards::fold_board(spec, repo.id(), &items.items, &docs, now);
                (items, Some(fold))
            }
            None => (BoardItemSet::default(), None),
        };
        Ok(Some(BoardSnapshot {
            read,
            items,
            fold,
            now,
        }))
    }

    /// Issue or PR `number` of `repo` (issues first, as the web's `resolveItemByNumber`; `kind`
    /// asks for one), its id and kind, members-only ones included; `None` when neither exists.
    pub async fn resolve_item_by_number(
        &self,
        repo: &RepoRef,
        number: u32,
        kind: Option<ItemKind>,
    ) -> Result<Option<(String, ItemKind)>> {
        let collab = self.collab_contract(repo).await?;
        for (doc_type, k) in ITEM_DOCS {
            if kind.is_some_and(|want| want != k) {
                continue;
            }
            let docs = self
                .client()
                .query_documents(
                    &collab,
                    doc_type,
                    &[
                        Self::repo_filter(repo)?,
                        QueryFilter::eq("number", FieldValue::integer(u64::from(number))),
                    ],
                    &[QueryOrder::asc("number")],
                    1,
                    None,
                )
                .await?;
            if let Some(d) = docs.into_iter().next() {
                return Ok(Some((d.id, k)));
            }
        }
        Ok(None)
    }

    // --- writes ---------------------------------------------------------------------------

    /// Replace the signer's own `doc_type` document `id` with `content` and `state`, restating
    /// the role it claims (`r`) after the role pre-check: what [`Collab::write`] does for a
    /// create, for a replace. `false` when it already held all of it (nothing signed).
    #[allow(clippy::too_many_arguments)] // the document, what it holds, and the role it needs
    async fn replace_own(
        &self,
        repo: &RepoRef,
        contract: &LoadedContract,
        doc_type: &str,
        needs: Role,
        id: &str,
        content: &BTreeMap<String, Option<FieldValue>>,
        state: i64,
    ) -> Result<bool> {
        self.require_role(repo, needs, &format!("write this {doc_type}"))
            .await?;
        let mut changes = content.clone();
        changes.insert(
            "state".into(),
            Some(FieldValue::integer(state.unsigned_abs())),
        );
        let claimed = members::claimed_role(self.cached_role(repo).await?, false);
        if contract.has_property(doc_type, members::CLAIMED_ROLE) {
            changes.insert(
                members::CLAIMED_ROLE.to_string(),
                Some(FieldValue::integer(claimed)),
            );
        }
        self.engine()?
            .replace_document(contract, doc_type, id, &changes)
            .await
    }

    /// The content `bind` stores for `repo`: plaintext in a public repository; sealed into
    /// `epoch` and `enc` under the current write epoch in a private one. Every content field is
    /// stated (`None` removes it), so a replace drops the other form's fields.
    async fn board_content(
        &self,
        repo: &RepoRef,
        bind: Bind,
        content: &Content,
    ) -> Result<BTreeMap<String, Option<FieldValue>>> {
        let mut out = BTreeMap::new();
        if repo.visibility == Visibility::Private {
            let kr = self.keyring(repo).await?;
            let w = kr.writer(repo)?;
            let owner = platform::decode_identifier(&self.signer_id()?)?;
            let enc = sealed::seal(w.write_keys(), &owner, &bind, content)?;
            out.insert(
                "epoch".into(),
                Some(FieldValue::integer(u64::from(w.write_epoch()))),
            );
            out.insert("enc".into(), Some(FieldValue::bytes(enc)));
            for k in bind.plaintext_fields() {
                out.insert((*k).into(), None);
            }
            return Ok(out);
        }
        out.insert("epoch".into(), None);
        out.insert("enc".into(), None);
        let text = |s: &Option<String>| s.as_deref().map(FieldValue::text);
        match content {
            Content::Board(f) => {
                out.insert("name".into(), Some(FieldValue::text(&f.name)));
                out.insert("spec".into(), Some(FieldValue::text(&f.spec)));
            }
            Content::Card(f) => {
                out.insert(
                    "col".into(),
                    f.col.map(|c| FieldValue::integer(u64::from(c))),
                );
                out.insert("rank".into(), text(&f.rank));
                out.insert("f".into(), text(&f.f));
            }
        }
        Ok(out)
    }

    /// Write the signer's revision of board `key`: replace their own revision of `board` (the
    /// board as read) when they have one, else create one. `state` is plaintext; the name and
    /// definition sealed in a private repository.
    async fn write_board_revision(
        &self,
        repo: &RepoRef,
        key: u32,
        fields: BoardFields,
        state: BoardState,
        board: Option<&Board>,
    ) -> Result<BoardWritten> {
        let contract = self.board_contract(repo).await?;
        let content = self
            .board_content(repo, Bind::Board { key }, &Content::Board(fields))
            .await?;
        let me = self.signer_id()?;
        if let Some(own) = board.and_then(|b| own_revision(b, &me)) {
            let changed = self
                .replace_own(
                    repo,
                    &contract,
                    DOC_BOARD,
                    Role::Writer,
                    &own.id,
                    &content,
                    state.code(),
                )
                .await?;
            return Ok(BoardWritten {
                key,
                document_id: own.id.clone(),
                created: false,
                changed,
            });
        }
        self.require_role(repo, Role::Writer, "create, edit, close or delete boards")
            .await?;
        let mut props = present(&content);
        props.insert("key".into(), FieldValue::integer(u64::from(key)));
        props.insert(
            "state".into(),
            FieldValue::integer(state.code().unsigned_abs()),
        );
        let id = self.write(repo, &contract, DOC_BOARD, props).await?;
        Ok(BoardWritten {
            key,
            document_id: id,
            created: true,
            changed: true,
        })
    }

    /// Create a board in `repo` (§2.1): a new key no revision names (every raw row counted,
    /// the malformed too), and the signer's first revision of it. With an `intent` the key is
    /// derived from it ([`new_board_key`]), so a retry of one create names the same board: when
    /// the signer's own revision alone holds it, the first attempt landed and is replaced
    /// (`created` false), never a second board. Maintainers and writers only.
    pub async fn create_board(
        &self,
        repo: &RepoRef,
        name: &str,
        spec: &BoardSpec,
        intent: Option<&str>,
    ) -> Result<BoardWritten> {
        let fields = check_board_input(name, spec)?;
        self.require_role(repo, Role::Writer, "create boards")
            .await?;
        let me = self.signer_id()?;
        for attempt in 0..8 {
            let key = new_board_key(repo.id(), intent, attempt)?;
            let taken = self.board_docs(repo, Some(key)).await?;
            if taken.is_empty() {
                return self
                    .write_board_revision(repo, key, fields, BoardState::Open, None)
                    .await;
            }
            // a retry of this create whose first attempt landed: its own revision holds the key
            if intent.is_some() && taken.len() == 1 && taken[0].owner_id == me {
                let board = self.board_definition(repo, key).await?;
                return self
                    .write_board_revision(repo, key, fields, BoardState::Open, board.as_ref())
                    .await;
            }
        }
        Err(Error::Config(
            "could not find an unused board key; try again".into(),
        ))
    }

    /// Board `key` of `repo`, or E102.
    async fn existing_board(&self, repo: &RepoRef, key: u32) -> Result<Board> {
        self.board_definition(repo, key).await?.ok_or_else(|| {
            UserError::new(
                codes::NOT_FOUND,
                format!("no board {key} in {}", repo.display()),
            )
            .fix(format!(
                "`dg board list {}` lists its boards",
                repo.display()
            ))
            .into()
        })
    }

    /// Save a change to board `key` (its name, its definition, or both): read its newest
    /// revision fresh, apply the change, and replace the signer's own revision (or create one).
    /// Refused for a closed or deleted board, or one whose definition did not open.
    pub async fn save_board(
        &self,
        repo: &RepoRef,
        key: u32,
        name: Option<&str>,
        spec: Option<&BoardSpec>,
    ) -> Result<BoardWritten> {
        let board = self.existing_board(repo, key).await?;
        refuse_unless_open(&board)?;
        let (Some(old_name), Some(old_spec)) = (&board.name, &board.spec) else {
            return Err(unreadable(&board, "it can't be edited"));
        };
        let fields = check_board_input(name.unwrap_or(old_name), spec.unwrap_or(old_spec))?;
        self.write_board_revision(repo, key, fields, BoardState::Open, Some(&board))
            .await
    }

    /// Open, close (read-only, listed under Closed) or delete board `key` (§3.1 `state`): a new
    /// revision with the newest one's name and definition. A writer may close or delete a
    /// maintainer's board, as with labels. A deleted board stays deleted.
    pub async fn set_board_state(
        &self,
        repo: &RepoRef,
        key: u32,
        state: BoardState,
    ) -> Result<BoardWritten> {
        let board = self.existing_board(repo, key).await?;
        if board.state == BoardState::Deleted {
            return Err(refused("this board was deleted"));
        }
        let (Some(name), Some(spec)) = (&board.name, &board.spec) else {
            return Err(unreadable(&board, "it can't be changed"));
        };
        let fields = check_board_input(name, spec)?;
        self.write_board_revision(repo, key, fields, state, Some(&board))
            .await
    }

    /// Write the signer's card for `item` on `board` of `repo` (§3.2): refused for a closed
    /// board, a patch the board does not admit, or (unconfirmed) a private home's
    /// cross-repository item; then the definition and the item's cards are read fresh, `patch`
    /// is applied to its base ([`Self::card_base`]: the newest card this reader opens, or this
    /// `Collab`'s last landed card while the read lags behind it), and the signer's own card is
    /// replaced (or created: a create that meets the signer's card made meanwhile re-reads,
    /// applies the patch over the newest card then, and replaces it instead).
    pub async fn write_card(
        &self,
        repo: &RepoRef,
        board: &Board,
        item: &CardItem,
        patch: &CardPatch,
        confirm_cross_repo: bool,
    ) -> Result<CardWritten> {
        // what the caller's copy of the board refuses is refused at once; the fresh read decides
        refuse_unless_open(board)?;
        refuse_unless_confirmed(repo, &item.repo_id, confirm_cross_repo)?;
        let item_bytes = platform::decode_identifier(&item.id)?;
        self.require_role(repo, Role::Triage, "place items on boards")
            .await?;
        let contract = self.board_contract(repo).await?;
        let me = self.signer_id()?;
        // the definition read with the cards: a field, option or column another member added
        // since is kept, and a board closed meanwhile is read-only
        let fresh = self.existing_board(repo, board.key).await?;
        refuse_unless_open(&fresh)?;
        let Some(spec) = &fresh.spec else {
            return Err(unreadable(&fresh, "its cards can't be changed"));
        };
        check_patch(spec, patch)?;
        let landed_key = format!("{}:{}:{}", repo.id(), board.key, item.id);
        let bind = Bind::Card {
            board: board.key,
            item: item_bytes,
        };
        let docs = self.item_card_docs(repo, board.key, &item.id, &me).await?;
        let (base, own, revision) = self.card_base(&landed_key, &item.id, &docs);
        let mut next = patched_card(spec, base.as_ref(), patch)?;
        let mut content = self.card_content(repo, bind, &next).await?;
        let replace = async |id: &str, content: &BTreeMap<String, Option<FieldValue>>, state| {
            self.replace_own(repo, &contract, DOC_CARD, Role::Triage, id, content, state)
                .await
        };
        let (document_id, created, changed, revision) = if let Some(own) = own {
            let changed = replace(&own, &content, next.state).await?;
            (own, false, changed, revision + u64::from(changed))
        } else {
            let mut props = present(&content);
            props.insert("board".into(), FieldValue::integer(u64::from(board.key)));
            props.insert("item".into(), FieldValue::identifier(item_bytes));
            props.insert(
                "state".into(),
                FieldValue::integer(next.state.unsigned_abs()),
            );
            match self.write(repo, &contract, DOC_CARD, props).await {
                Ok(id) => (id, true, true, 1),
                // The signer's card for this item appeared since the read (another device):
                // apply the patch over the newest card now, that device's included, and
                // replace it.
                Err(Error::DuplicateUniqueIndex(m)) => {
                    let again = self.item_card_docs(repo, board.key, &item.id, &me).await?;
                    let (base, own, revision) = self.card_base(&landed_key, &item.id, &again);
                    let Some(own) = own else {
                        return Err(Error::DuplicateUniqueIndex(m));
                    };
                    next = patched_card(spec, base.as_ref(), patch)?;
                    content = self.card_content(repo, bind, &next).await?;
                    let changed = replace(&own, &content, next.state).await?;
                    (own, false, changed, revision + u64::from(changed))
                }
                Err(e) => return Err(e),
            }
        };
        self.land_card(landed_key, &document_id, revision, &me, &item.id, &next);
        Ok(CardWritten {
            item: item.id.clone(),
            document_id,
            created,
            changed,
            col: next.col,
            rank: next.rank.clone(),
            f: next.f.clone(),
            state: next.state,
        })
    }

    /// [`card_base_of`] with this `Collab`'s last landed card for `landed_key`.
    fn card_base(
        &self,
        landed_key: &str,
        item_id: &str,
        docs: &ItemCardDocs,
    ) -> (Option<CardDoc>, Option<String>, u64) {
        let landed = self
            .landed_cards
            .lock()
            .ok()
            .and_then(|m| m.get(landed_key).cloned());
        card_base_of(landed.as_ref(), item_id, docs)
    }

    /// A card's stored content for `repo` ([`Self::board_content`]).
    async fn card_content(
        &self,
        repo: &RepoRef,
        bind: Bind,
        next: &PatchedCard,
    ) -> Result<BTreeMap<String, Option<FieldValue>>> {
        self.board_content(
            repo,
            bind,
            &Content::Card(CardFields {
                col: next.col,
                rank: next.rank.clone(),
                f: next.f.clone(),
            }),
        )
        .await
    }

    /// Remember the card a write landed ([`Self::card_base`]).
    fn land_card(
        &self,
        landed_key: String,
        document_id: &str,
        revision: u64,
        me: &str,
        item: &str,
        next: &PatchedCard,
    ) {
        let card = CardDoc {
            id: document_id.to_string(),
            owner_id: me.to_string(),
            updated_at: 0,
            item: item.to_string(),
            col: next.col.map(i64::from),
            rank: next.rank.clone(),
            f: next.f.clone(),
            state: next.state,
        };
        if let Ok(mut m) = self.landed_cards.lock() {
            m.insert(
                landed_key,
                LandedCard {
                    document_id: document_id.to_string(),
                    revision,
                    card,
                },
            );
        }
    }

    /// Move `item` to column `col`, at `at` in `column` (the target column's cards in rank
    /// order, [`BoardSnapshot::column`]): one card write with the new column and rank. Refused
    /// before signing when no rank fits (re-rank the column first).
    #[allow(clippy::too_many_arguments)] // the board, the item, where, and the confirm
    pub async fn move_card(
        &self,
        repo: &RepoRef,
        board: &Board,
        item: &CardItem,
        col: u8,
        column: &[RankedCard],
        at: &DropAt,
        confirm_cross_repo: bool,
    ) -> Result<CardWritten> {
        let rank = rank_at(column, &item.id, at)
            .ok_or_else(|| refused("the card to drop it next to is not in that column"))?
            .map_err(rank_problem)?;
        let patch = CardPatch {
            col: Some(col),
            rank: Some(rank),
            ..CardPatch::default()
        };
        self.write_card(repo, board, item, &patch, confirm_cross_repo)
            .await
    }

    /// Write each of `writes` in turn, stopping at the first failure.
    pub async fn write_cards(
        &self,
        repo: &RepoRef,
        board: &Board,
        writes: &[(CardItem, CardPatch)],
        confirm_cross_repo: bool,
    ) -> BulkWritten {
        let mut written = Vec::new();
        for (i, (item, patch)) in writes.iter().enumerate() {
            match self
                .write_card(repo, board, item, patch, confirm_cross_repo)
                .await
            {
                Ok(w) => written.push(w),
                Err(e) => {
                    return BulkWritten {
                        written,
                        failed: Some((item.id.clone(), e)),
                        skipped: writes[i + 1..].iter().map(|(x, _)| x.id.clone()).collect(),
                    }
                }
            }
        }
        BulkWritten {
            written,
            failed: None,
            skipped: Vec::new(),
        }
    }

    /// Carry the current iteration's unfinished items into the next (§5.4):
    /// [`next_iteration_plan`] over `snapshot`, one write each.
    pub async fn move_open_to_next_iteration(
        &self,
        repo: &RepoRef,
        snapshot: &BoardSnapshot,
        field_id: u8,
    ) -> Result<BulkWritten> {
        let board = &snapshot.read.board;
        let (Some(spec), Some(fold)) = (&board.spec, &snapshot.fold) else {
            return Err(unreadable(board, "its cards can't be changed"));
        };
        let (next, items) = next_iteration_plan(
            spec,
            field_id,
            &snapshot.items.items,
            &fold.items,
            snapshot.now,
        )
        .ok_or_else(|| refused("there is no current iteration to move items from"))?;
        let writes: Vec<(CardItem, CardPatch)> = items
            .into_iter()
            .map(|i| {
                let mut p = CardPatch::default();
                p.fields.insert(field_id, Some(Scalar::from(next)));
                (i, p)
            })
            .collect();
        Ok(self.write_cards(repo, board, &writes, true).await)
    }

    /// Quick add (§5.3): `title` makes a real issue in `target` (`None`: the home repository)
    /// with the issue create everyone uses, then places it in column `col` at the bottom of
    /// `column` (the column's cards in rank order). Two writes; a card that fails after the
    /// issue landed is reported in [`QuickAdded::card`], not returned as the error, so the issue
    /// is not made twice.
    #[allow(clippy::too_many_arguments)] // the board, the title, where, and the confirm
    pub async fn quick_add_issue(
        &self,
        home: &RepoRef,
        board: &Board,
        title: &str,
        col: u8,
        column: &[RankedCard],
        target: Option<&RepoRef>,
        journal_dir: &Path,
        confirm_cross_repo: bool,
    ) -> Result<QuickAdded> {
        refuse_unless_open(board)?;
        let Some(spec) = &board.spec else {
            return Err(unreadable(board, "its cards can't be changed"));
        };
        check_patch(
            spec,
            &CardPatch {
                col: Some(col),
                ..CardPatch::default()
            },
        )?;
        let target = target.unwrap_or(home);
        refuse_unless_confirmed(home, target.id(), confirm_cross_repo)?;
        let title = title.trim();
        if title.is_empty() {
            return Err(refused("an issue needs a title"));
        }
        let created = self.create_issue(target, title, "", journal_dir).await?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        let item = BoardItem {
            id: created.document_id.clone(),
            number: u64::from(created.number),
            repo_id: target.id().to_string(),
            repo: Some(target.display()),
            kind: ItemKind::Issue,
            state: ItemState::Open,
            created_at: now,
            closed_at: None,
            title: title.to_string(),
            labels: Vec::new(),
            assignees: Vec::new(),
            milestone: None,
            author: self.signer_id()?,
        };
        let rank = (!column.is_empty())
            .then(|| rank_at(column, "", &DropAt::Bottom))
            .flatten()
            .and_then(std::result::Result::ok);
        let patch = CardPatch {
            col: Some(col),
            rank,
            ..CardPatch::default()
        };
        let card = self
            .write_card(home, board, &CardItem::of(&item), &patch, true)
            .await;
        Ok(QuickAdded { item, card })
    }
}

#[cfg(test)]
mod tests;
