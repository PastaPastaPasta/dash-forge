//! Maintainer bans (UPDATE-1 `ban`, `docs/contracts/forge-v2.md` §3.2): which identities a
//! repo's maintainers banned, and what readers collapse because of it.
//!
//! A `ban` (forge-collab) names a repo and an identity, with an optional `reason` code. Consensus
//! checks one thing, at write time: its writer held a `maintainer` document for the repo. It
//! never stops the banned identity from writing (issues, PRs, comments and reviews are un-gated).
//! Everything else is this reader rule, shared with `forge-web/lib/rules/bans.ts` and held in
//! parity by the `"rules": "v2"` vectors `bans__*`:
//!
//! 1. A ban counts only while its writer is the repo's owner or a **current** maintainer: a
//!    removed maintainer's bans stop counting (the contract cannot re-check them).
//! 2. A ban of the owner or of a current maintainer is ignored: nobody bans someone with the
//!    same or more authority, and a maintainer's work is never hidden by a peer.
//! 3. Several standing bans of one identity (one per maintainer, the unique index): the owner's
//!    decides, else the earliest by `($createdAt, $id)`.
//! 4. Readers collapse every issue, PR, comment and review the banned identity wrote in the repo,
//!    with a reveal, as they collapse a maintainer's hide ([`apply_bans`]); an item a maintainer
//!    hid keeps its hide. Display only, like a hide: a banned writer's review verdict still
//!    counts until it is dismissed.
//! 5. Clients refuse the banned identity's issue, PR, comment and review creates in the repo
//!    before signing (E610). Consensus would still accept them.
//!
//! Lifting a ban is deleting the document, which only its writer can do (Platform: a delete is
//! the owner's). Another maintainer cannot lift it; the repo owner can remove its writer as a
//! maintainer, after which rule 1 drops the ban.
//!
//! `reason` is an integer 0–255 by contract; its meaning is this client convention
//! ([`BAN_REASONS`]): absent or 0 is no reason, 1 spam, 2 abuse, 3 off-topic, and any other
//! code reads as "other".

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::moderation::{Hidden, HiddenItems, HiddenVia, ThreadItem};

/// The reason codes clients write and how they read them (`ban.reason`). Code 0 (or none) is
/// no reason; a code not listed reads as [`BAN_REASON_OTHER`].
pub const BAN_REASONS: [(u8, &str); 3] = [(1, "spam"), (2, "abuse"), (3, "off-topic")];

/// How a reason code outside [`BAN_REASONS`] (and not 0) reads.
pub const BAN_REASON_OTHER: &str = "other";

/// The reason a ban's `reason` code names: `None` for no reason (absent or 0), else one of
/// [`BAN_REASONS`]' names or [`BAN_REASON_OTHER`].
#[must_use]
pub fn ban_reason_label(code: Option<u8>) -> Option<&'static str> {
    match code {
        None | Some(0) => None,
        Some(c) => Some(
            BAN_REASONS
                .iter()
                .find(|(n, _)| *n == c)
                .map_or(BAN_REASON_OTHER, |(_, name)| name),
        ),
    }
}

/// The code a reason name is written as (`None`: not one of [`BAN_REASONS`]).
#[must_use]
pub fn ban_reason_code(name: &str) -> Option<u8> {
    BAN_REASONS
        .iter()
        .find(|(_, n)| n.eq_ignore_ascii_case(name))
        .map(|(c, _)| *c)
}

/// A `ban` document, flattened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ban {
    /// `$id`.
    pub id: String,
    /// `identityId`: who is banned (base58).
    pub identity: String,
    /// `$ownerId`: the maintainer who banned them.
    pub by: String,
    /// `reason` (0–255), when written.
    #[serde(default)]
    pub reason: Option<u8>,
    /// `$createdAt` (ms).
    pub created_at: u64,
}

/// Whose bans count in a repo: the owner and the maintainers now.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BanScope {
    /// The repo's owner.
    pub owner: String,
    /// The repo's current maintainers.
    #[serde(default)]
    pub maintainers: BTreeSet<String>,
}

impl BanScope {
    /// The owner or a current maintainer: may ban, and is never banned.
    #[must_use]
    pub fn moderates(&self, identity: &str) -> bool {
        identity == self.owner || self.maintainers.contains(identity)
    }
}

/// The standing ban of each banned identity (rules 1–3), by identity.
#[must_use]
pub fn standing_bans(bans: &[Ban], scope: &BanScope) -> BTreeMap<String, Ban> {
    let mut ordered: Vec<&Ban> = bans
        .iter()
        .filter(|b| scope.moderates(&b.by) && !scope.moderates(&b.identity))
        .collect();
    ordered.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let mut out: BTreeMap<String, Ban> = BTreeMap::new();
    for b in ordered {
        match out.get(&b.identity) {
            // The owner's outranks a maintainer's earlier one; otherwise the earliest stands.
            Some(have) if have.by != scope.owner && b.by == scope.owner => {}
            Some(_) => continue,
            None => {}
        }
        out.insert(b.identity.clone(), b.clone());
    }
    out
}

/// A ban as a reader's collapse: [`HiddenVia::Ban`], by the ban's writer, at its time.
#[must_use]
pub fn ban_hidden(ban: &Ban) -> Hidden {
    Hidden {
        by: ban.by.clone(),
        reason: None,
        at: ban.created_at,
        event_id: ban.id.clone(),
        via: HiddenVia::Ban,
        ban_reason: Some(ban.reason.unwrap_or(0)),
    }
}

/// `hidden` (a thread's maintainer hides, [`super::moderation::hidden_items`]) with the standing
/// `bans` applied (rule 4): the thread when its author is banned, and every comment and review a
/// banned identity wrote, each unless a hide already covers it. `counted` is unchanged.
#[must_use]
pub fn apply_bans(
    mut hidden: HiddenItems,
    bans: &BTreeMap<String, Ban>,
    thread_author: &str,
    comments: &[ThreadItem],
    reviews: &[ThreadItem],
) -> HiddenItems {
    if bans.is_empty() {
        return hidden;
    }
    if hidden.thread.is_none() {
        hidden.thread = bans.get(thread_author).map(ban_hidden);
    }
    for item in comments.iter().chain(reviews) {
        if hidden.items.contains_key(&item.id) {
            continue;
        }
        if let Some(b) = bans.get(&item.author) {
            hidden.items.insert(item.id.clone(), ban_hidden(b));
        }
    }
    hidden
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ban(id: &str, identity: &str, by: &str, at: u64) -> Ban {
        Ban {
            id: id.into(),
            identity: identity.into(),
            by: by.into(),
            reason: Some(1),
            created_at: at,
        }
    }

    fn scope() -> BanScope {
        BanScope {
            owner: "own".into(),
            maintainers: ["m1".to_string(), "m2".to_string()].into(),
        }
    }

    #[test]
    fn only_current_moderators_ban_and_they_are_exempt() {
        let bans = [
            ban("b1", "spammer", "m1", 10),
            ban("b2", "x", "gone", 5),
            ban("b3", "m2", "m1", 6),
            ban("b4", "own", "m1", 7),
        ];
        let got = standing_bans(&bans, &scope());
        assert_eq!(got.keys().collect::<Vec<_>>(), ["spammer"]);
    }

    #[test]
    fn the_owners_ban_outranks_an_earlier_one() {
        let bans = [ban("b1", "s", "m1", 10), ban("b2", "s", "own", 20)];
        assert_eq!(standing_bans(&bans, &scope())["s"].by, "own");
        let bans = [ban("b1", "s", "m2", 10), ban("b0", "s", "m1", 10)];
        assert_eq!(standing_bans(&bans, &scope())["s"].id, "b0");
    }

    #[test]
    fn reasons_read_by_code() {
        assert_eq!(ban_reason_label(None), None);
        assert_eq!(ban_reason_label(Some(0)), None);
        assert_eq!(ban_reason_label(Some(2)), Some("abuse"));
        assert_eq!(ban_reason_label(Some(200)), Some("other"));
        assert_eq!(ban_reason_code("Spam"), Some(1));
        assert_eq!(ban_reason_code("other"), None);
    }

    #[test]
    fn bans_collapse_what_hides_left() {
        let bans = standing_bans(&[ban("b1", "s", "m1", 10)], &scope());
        let item = |id: &str, author: &str| ThreadItem {
            id: id.into(),
            author: author.into(),
            review_id: None,
        };
        let mut hidden = HiddenItems::default();
        hidden.items.insert(
            "c2".into(),
            Hidden {
                by: "m2".into(),
                reason: Some("spam".into()),
                at: 3,
                event_id: "e".into(),
                via: HiddenVia::Item,
                ban_reason: None,
            },
        );
        let got = apply_bans(
            hidden,
            &bans,
            "s",
            &[item("c1", "s"), item("c2", "s"), item("c3", "ok")],
            &[item("r1", "s")],
        );
        assert_eq!(got.thread.as_ref().map(|h| h.via), Some(HiddenVia::Ban));
        assert_eq!(got.items["c1"].via, HiddenVia::Ban);
        assert_eq!(got.items["c1"].ban_reason, Some(1));
        assert_eq!(got.items["c2"].via, HiddenVia::Item);
        assert_eq!(got.items["r1"].via, HiddenVia::Ban);
        assert!(!got.items.contains_key("c3"));
    }
}
