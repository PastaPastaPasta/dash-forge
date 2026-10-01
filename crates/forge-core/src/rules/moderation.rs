//! Maintainer moderation (RC2 MOD, `docs/contracts/forge-v2.md` §3.3; part of
//! `FORGE_RULES_V2`): what a reader collapses after a maintainer's hide.
//!
//! Platform v5 cannot delete someone else's document in one repo only: contract moderation is
//! contract-wide (v5 book `data-model/contract-moderation.md`), and a delete by anyone but the
//! owner is refused (40102). So a maintainer *hides* a comment, a review or a whole issue or PR
//! with an immutable `event` (kind 24, `refId` = the item, none = the thread; kind 25 unhides),
//! and every reader applies [`hidden_items`]. Nothing is deleted, and the events are the audit
//! trail.
//!
//! With the `event_as_maintainer` contract flag (`asMaintainer`, the `hideByMaint` rule)
//! consensus proves at write time that the writer was a maintainer, so every hide counts, also
//! after its writer's removal. Without it consensus admits any member's event, and a reader
//! counts only the hides of the repo's owner and its current maintainers.
//!
//! Hiding is display only: it changes no state fold. Merge readiness is computed by each client
//! and no consensus rule counts reviews, so a client that dropped a hidden review's verdict would
//! disagree with one that did not; a hidden review still counts until it is dismissed (kind 15).
//!
//! Every function is pure. The `"rules": "v2"` vectors `hidden_items__*` in
//! `forge-contracts/vectors/` hold this module in parity with `forge-web/lib/rules/moderation.ts`.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::{event_order, Event, EventKind};

/// The reasons a hide may give (`value`), as GitHub's "hide comment" offers them. Any other
/// value reads as no reason.
pub const HIDE_REASONS: [&str; 6] = [
    "spam",
    "abuse",
    "off-topic",
    "outdated",
    "resolved",
    "duplicate",
];

/// Whether `value` is one of [`HIDE_REASONS`].
#[must_use]
pub fn is_hide_reason(value: &str) -> bool {
    HIDE_REASONS.contains(&value)
}

/// A comment or review of the thread: what a hide's `refId` may name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadItem {
    /// Document `$id`.
    pub id: String,
    /// Its writer (`$ownerId`).
    pub author: String,
    /// A comment's `reviewId` (an inline comment of that review), if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_id: Option<String>,
}

/// Who may hide in a thread, and how a reader judges it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HideScope {
    /// The issue's or PR's `$id`.
    pub thread_id: String,
    /// Its author.
    pub thread_author: String,
    /// The repo's owner: its hide outranks a maintainer's, and only it hides what it wrote.
    pub owner: String,
    /// The repo's maintainers now. Read only without `proved`.
    #[serde(default)]
    pub maintainers: BTreeSet<String>,
    /// Whether the contract proves a hide's maintainer (`event.asMaintainer`): then every hide
    /// counts.
    #[serde(default)]
    pub proved: bool,
}

/// Where a hide on an item comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HiddenVia {
    /// A hide names the item (or, for the thread, names none).
    Item,
    /// An inline comment of a hidden review.
    Review,
}

/// A standing hide.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hidden {
    /// Who hid it (the deciding event's `$ownerId`).
    pub by: String,
    /// One of [`HIDE_REASONS`], when the hide gave one.
    pub reason: Option<String>,
    /// When (`$createdAt`, ms).
    pub at: u64,
    /// The deciding event's `$id`.
    pub event_id: String,
    /// The item's own hide, or its review's.
    pub via: HiddenVia,
}

/// What a reader collapses in one issue or PR.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenItems {
    /// The whole thread is hidden (lists leave it out; its page shows a banner).
    pub thread: Option<Hidden>,
    /// Each hidden comment or review by `$id`, with the inline comments of a hidden review.
    pub items: BTreeMap<String, Hidden>,
}

impl HiddenItems {
    /// The hide on comment or review `id`, if any.
    #[must_use]
    pub fn item(&self, id: &str) -> Option<&Hidden> {
        self.items.get(id)
    }
}

/// The hides standing in a thread, from its events (any kinds; 24/25 are read), its comments and
/// its reviews. For each key — the thread, or a comment or review of it:
///
/// 1. Only kinds 24/25 on this thread count, and only from a hider the contract proved
///    (`scope.proved`) or, without the proof, the owner or a current maintainer.
/// 2. A `refId` must name a comment or review of this thread: consensus never checks it.
/// 3. If the owner wrote any of the key's events, the owner's latest decides; what the owner
///    wrote only the owner hides; otherwise the latest decides, by `($createdAt, $id)`.
/// 4. A hide decides "hidden", an unhide "shown". A review's hide also covers its inline
///    comments (`reviewId`) that are not hidden themselves.
#[must_use]
pub fn hidden_items(
    events: &[Event],
    scope: &HideScope,
    comments: &[ThreadItem],
    reviews: &[ThreadItem],
) -> HiddenItems {
    let authors: BTreeMap<&str, &str> = comments
        .iter()
        .chain(reviews)
        .map(|i| (i.id.as_str(), i.author.as_str()))
        .collect();
    let mut ordered: Vec<&Event> = events
        .iter()
        .filter(|e| matches!(e.kind, EventKind::Hide | EventKind::Unhide))
        .filter(|e| e.target_id == scope.thread_id)
        .filter(|e| scope.proved || e.actor == scope.owner || scope.maintainers.contains(&e.actor))
        .collect();
    ordered.sort_by(|a, b| event_order(a, b));
    // key: None = the thread, Some(id) = an item of it
    let mut by_key: BTreeMap<Option<&str>, Vec<&Event>> = BTreeMap::new();
    for e in ordered {
        let key = match e.ref_id.as_deref() {
            None => None,
            Some(r) if authors.contains_key(r) => Some(r),
            Some(_) => continue,
        };
        by_key.entry(key).or_default().push(e);
    }
    let mut out = HiddenItems::default();
    for (key, list) in by_key {
        let author = key.map_or(scope.thread_author.as_str(), |k| authors[k]);
        let decisive = match list.iter().rev().find(|e| e.actor == scope.owner) {
            Some(e) => Some(*e),
            None if author == scope.owner => None,
            None => list.last().copied(),
        };
        let Some(e) = decisive.filter(|e| e.kind == EventKind::Hide) else {
            continue;
        };
        let hidden = Hidden {
            by: e.actor.clone(),
            reason: e.value.clone().filter(|v| is_hide_reason(v)),
            at: e.created_at,
            event_id: e.id.clone(),
            via: HiddenVia::Item,
        };
        match key {
            None => out.thread = Some(hidden),
            Some(k) => {
                out.items.insert(k.to_string(), hidden);
            }
        }
    }
    for c in comments {
        let Some(review) = c.review_id.as_deref() else {
            continue;
        };
        if out.items.contains_key(&c.id) {
            continue;
        }
        if let Some(h) = out.items.get(review).filter(|h| h.via == HiddenVia::Item) {
            let h = Hidden {
                via: HiddenVia::Review,
                ..h.clone()
            };
            out.items.insert(c.id.clone(), h);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(id: &str, kind: EventKind, actor: &str, ref_id: Option<&str>, at: u64) -> Event {
        Event {
            id: id.into(),
            target_id: "T".into(),
            kind,
            actor: actor.into(),
            value: None,
            oid: None,
            ref_id: ref_id.map(Into::into),
            created_at: at,
        }
    }
    fn item(id: &str, author: &str, review: Option<&str>) -> ThreadItem {
        ThreadItem {
            id: id.into(),
            author: author.into(),
            review_id: review.map(Into::into),
        }
    }
    fn scope(proved: bool, maintainers: &[&str]) -> HideScope {
        HideScope {
            thread_id: "T".into(),
            thread_author: "bob".into(),
            owner: "own".into(),
            maintainers: maintainers.iter().map(|m| (*m).to_string()).collect(),
            proved,
        }
    }

    #[test]
    fn the_owner_outranks_a_later_maintainer() {
        let comments = [item("c1", "bob", None)];
        let events = [
            ev("e1", EventKind::Hide, "own", Some("c1"), 1),
            ev("e2", EventKind::Unhide, "alice", Some("c1"), 2),
        ];
        let got = hidden_items(&events, &scope(true, &[]), &comments, &[]);
        assert_eq!(got.item("c1").map(|h| h.by.as_str()), Some("own"));
    }

    #[test]
    fn a_foreign_ref_and_another_thread_are_ignored() {
        let comments = [item("c1", "bob", None)];
        let mut other = ev("e2", EventKind::Hide, "own", Some("c1"), 2);
        other.target_id = "U".into();
        let events = [ev("e1", EventKind::Hide, "own", Some("cX"), 1), other];
        let got = hidden_items(&events, &scope(true, &[]), &comments, &[]);
        assert_eq!(got, HiddenItems::default());
    }

    #[test]
    fn a_removed_maintainer_counts_only_with_the_proof() {
        let comments = [item("c1", "bob", None)];
        let events = [ev("e1", EventKind::Hide, "gone", Some("c1"), 1)];
        assert!(hidden_items(&events, &scope(true, &[]), &comments, &[])
            .item("c1")
            .is_some());
        assert!(
            hidden_items(&events, &scope(false, &["alice"]), &comments, &[])
                .item("c1")
                .is_none()
        );
        assert!(
            hidden_items(&events, &scope(false, &["gone"]), &comments, &[])
                .item("c1")
                .is_some()
        );
    }

    #[test]
    fn a_review_hide_covers_its_inline_comments() {
        let reviews = [item("r1", "bob", None)];
        let comments = [item("c1", "bob", Some("r1")), item("c2", "bob", None)];
        let events = [ev("e1", EventKind::Hide, "alice", Some("r1"), 1)];
        let got = hidden_items(&events, &scope(true, &[]), &comments, &reviews);
        assert_eq!(got.item("c1").map(|h| h.via), Some(HiddenVia::Review));
        assert!(got.item("c2").is_none());
        assert_eq!(got.item("r1").map(|h| h.via), Some(HiddenVia::Item));
    }

    #[test]
    fn only_the_owner_hides_what_the_owner_wrote() {
        let comments = [item("c1", "own", None)];
        let events = [ev("e1", EventKind::Hide, "alice", Some("c1"), 1)];
        assert!(hidden_items(&events, &scope(true, &[]), &comments, &[])
            .item("c1")
            .is_none());
    }
}
