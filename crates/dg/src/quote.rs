//! Pre-sign quotes for writes whose prompts used to carry a fixed figure (QW2-020: "~0.0001
//! DASH" for a pull request that cost 0.0013). Each is an upper bound built from the importer's
//! calibrated per-kind model (`forge_import::budget::collab_doc_credits`) and `git push`'s fees
//! (`forge_core::cost::push_fees`), with the write priced as the first of its kind in its
//! repository.

use forge_core::cost::push_fees;
use forge_import::budget::{collab_doc_credits, CollabDoc};

/// What a write that is the first of its kind pays beyond a later one of the same size: its
/// new index subtrees (a repository's first issue, a thread's first comment). Measured on
/// devnet bonsia (Platform 4.2.0-beta.7, 2026-09-30): a repository's first issue 120.9M
/// credits, its second 80.1M (QW-038: the table priced the later one, and was exceeded).
pub const FIRST_OF_KIND_EXTRA: u64 = 50_000_000;

/// The bytes an `issue` or `patch` stores beyond its text: `repoId`, `number`, the state and
/// counters, and a patch's source repository id and head oid. Rounded up.
const TARGET_FIXED_BYTES: u64 = 128;

/// The bytes a `release` stores beyond its tag, name, notes and asset list: `repoId`, the
/// revision and its flags. Rounded up.
const RELEASE_FIXED_BYTES: u64 = 64;

/// A `transition` (close, reopen, merge, draft, ready, lock): an issue close charged 74.1M
/// credits on bonsia (QA wave 2, IP-14), above the 65M an event was quoted at; ~10 % over it.
pub const TRANSITION: u64 = 82_000_000;

/// A new issue or pull request carrying `text_bytes` of text (title, body, and a patch's ref
/// names), priced as its repository's first. Charged on bonsia: an issue 118.7M, a pull
/// request 130.1M-133.9M (QW2-020).
pub fn target_create(text_bytes: u64) -> u64 {
    collab_doc_credits(CollabDoc::Target, text_bytes + TARGET_FIXED_BYTES) + FIRST_OF_KIND_EXTRA
}

/// A public `release` revision carrying `text_bytes` of tag, name and notes, and its asset list
/// as stored (`assets_bytes` of JSON). Charged on bonsia: a first release with one asset 93.9M,
/// an unpublish revision 70.4M (QW2-020, quoted "~0.0002 DASH").
pub fn release(text_bytes: u64, assets_bytes: u64) -> u64 {
    collab_doc_credits(
        CollabDoc::Release,
        RELEASE_FIXED_BYTES + text_bytes + assets_bytes,
    )
}

/// What a `webhook` document's index entries cost beyond its bytes (QW3-022: it was priced by
/// its bytes alone, ~0.000093 DASH, and charged 0.00077 by dg and 0.00102 by the web on bonsia,
/// beta.7, 2026-09-30): the larger charge, rounded up.
const WEBHOOK_INDEX_OVERHEAD: u64 = 110_000_000;

/// A `webhook` document of `bytes` (its encrypted secret and URL included), priced as the
/// repository's first: an upper bound.
pub fn webhook(bytes: u64) -> u64 {
    forge_core::cost::estimate(bytes).total() + WEBHOOK_INDEX_OVERHEAD
}

/// The bytes an `event` stores beyond its `value`: `repoId`, `targetId`, `targetNumber`, `kind`,
/// the claimed role `r`, and an `oid` when it names one (a policy bypass names the merge).
/// Rounded up.
const EVENT_FIXED_BYTES: u64 = 112;

/// What an event that is its thread's first (or its repository feed's) pays beyond a later one:
/// its `target` and `feed` index subtrees (+8.3M and +8.0M on moutai). Charged on devnet sakura
/// (Platform 5.0.0-beta.1, QA wave 4): a label added as an issue's first event 67.8M, one
/// removed later 51.7M.
const EVENT_FIRST_EXTRA: u64 = 8_000_000;

/// What an event naming an identity or an item in `refId` pays beyond one that names none: the
/// 32 bytes and its entry in the sparse `addressee (refId)` index, with that addressee's
/// subtree. Charged on sakura (QW4-039, QW4-049): an assignment 67.3M-67.4M in a thread whose
/// label events paid 51.7M-59.4M; a review request 74.0M; a thread resolve 66.0M.
pub const ADDRESSEE_EXTRA: u64 = 18_000_000;

/// A member `event` (a label, an assignment, a milestone, a pin, a hide, a policy bypass)
/// carrying `value_bytes` of `value`, and, when `addressee`, an identity or item in `refId`;
/// priced as its thread's first. An upper bound.
pub fn event(value_bytes: u64, addressee: bool) -> u64 {
    let addressee = if addressee { ADDRESSEE_EXTRA } else { 0 };
    collab_doc_credits(CollabDoc::Event, EVENT_FIXED_BYTES + value_bytes)
        + EVENT_FIRST_EXTRA
        + addressee
}

/// The bytes a `comment` stores beyond its body: `repoId`, `targetId`, the claimed role `r`,
/// and a review comment's anchor. Rounded up.
const COMMENT_FIXED_BYTES: u64 = 96;

/// What a thread's first comment by an author who never commented before pays beyond a later
/// one: the thread's `targetId` subtree and the author's (+11.7M and +10.6M on moutai).
const COMMENT_FIRST_EXTRA: u64 = 24_000_000;

/// A `comment` of `body_bytes`, priced as its thread's and its author's first. An upper bound.
pub fn comment(body_bytes: u64) -> u64 {
    collab_doc_credits(CollabDoc::Comment, COMMENT_FIXED_BYTES + body_bytes) + COMMENT_FIRST_EXTRA
}

/// The bytes a `label` or `milestone` definition stores beyond its text: `repoId`, the claimed
/// role `r`, the flags and a milestone's due date. Rounded up.
const DEFINITION_FIXED_BYTES: u64 = 64;

/// A `label` definition carrying `text_bytes` of name, colour and description, priced as the
/// repository's first (+8.0M on moutai): 41.4M on sakura (QW4-049).
pub fn label_definition(text_bytes: u64) -> u64 {
    collab_doc_credits(CollabDoc::Label, DEFINITION_FIXED_BYTES + text_bytes) + 8_000_000
}

/// A `milestone` definition carrying `text_bytes` of title and description, priced as the
/// repository's first: its type has the label's indexes and a due date (45M steady in the web's
/// model, never measured apart).
pub fn milestone_definition(text_bytes: u64) -> u64 {
    collab_doc_credits(CollabDoc::Label, DEFINITION_FIXED_BYTES + text_bytes) + 18_000_000
}

/// A `topic` document, priced as the repository's first: 61.7M-62.6M on bonsia (QA wave 3),
/// the repository's first 72.9M.
pub const TOPIC: u64 = 78_000_000;

/// A document replace carrying `bytes` of new text: the fixed part (17M on moutai) and every
/// byte. An upper bound for a replace that changes that much.
pub fn replace(bytes: u64) -> u64 {
    20_000_000 + 27_500 * bytes
}

/// What a `profile` pays beyond its bytes: its one unique index (`$ownerId`) and, as the
/// signer's first forge-community write, its contract nonce. Charged on sakura (Platform
/// 5.0.0-beta.1, P1-7): 36.8M-37.2M for a first profile with ~120 bytes of text.
const PROFILE_INDEX_OVERHEAD: u64 = 40_000_000;

/// A new `profile` carrying `text_bytes` of text: an upper bound.
pub fn profile(text_bytes: u64) -> u64 {
    forge_core::cost::estimate(text_bytes + 64).total() + PROFILE_INDEX_OVERHEAD
}

/// A member's `consent` (`dg collab accept`): 30.8M on bonsia, 30.6M on sakura (QW4-049).
pub const CONSENT: u64 = 33_000_000;

/// A `writer` or `maintainer` document (`dg collab add`), priced as the member's first: 38.9M-
/// 46.8M on moutai, a triage grant 48.1M on sakura (QW4-049; it was quoted 20M).
pub const MEMBER_GRANT: u64 = 52_000_000;

/// A `star`, priced as the repository's first, the starrer's first and their first
/// forge-community write: 17.7M-36.0M on moutai; RC2's fused star 57.1M on sakura, a
/// repository's first (QW4-049, 2026-10-01).
pub const STAR: u64 = 70_000_000;

/// A `starBeat` (a star's Trending count, on a contract without RC2's fused star): 14.4M-21.7M
/// on moutai, the identity's first the dearer.
pub const STAR_BEAT: u64 = 23_000_000;

/// A `watch`, priced as the repository's first and the watcher's first forge-community write:
/// 27.6M on moutai, 47.3M on sakura (QW4-049, 2026-10-01).
pub const WATCH: u64 = 58_000_000;

/// The bytes a history-index part is priced at when its size is not known before the push (a
/// small repository's parts are a few hundred bytes; each is at least one `chunk` when Platform
/// stores it).
const HISTORY_PART_BYTES: u64 = 1024;

/// How a merge's push of its base branch is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MergePush {
    /// The base is the repository's default branch: the push publishes its history index (two
    /// parts).
    pub history_index: bool,
    /// Platform stores the pushed bytes, the history index's included, as `chunk`s.
    pub platform_bytes: bool,
    /// The push uploads a pack, with its browse index: the head's commits are not in the base
    /// repository yet (a pull request from a fork, QW3-022), or the merge writes a new commit
    /// (a squash, QW4-046).
    pub uploads_pack: bool,
}

/// The pack a merge uploads from a fork is priced at this size: a pull request's few commits
/// are usually a few KiB (the fork-PR merge QA wave 3 measured charged 920.5M credits in all).
/// A larger head costs more; `git push` prices it as it runs.
const MERGE_PACK_BYTES: u64 = 4096;
/// The objects that pack is priced at (its browse index grows with them).
const MERGE_PACK_OBJECTS: u64 = 16;

/// What `dg pr merge` writes on Platform: the merge `transition`; unless it only records a
/// merge (`push` is `None`), the push of the base branch (its ref update, and its history
/// index); and the source branch's delete when asked. New objects' pack comes on top (a
/// fast-forward stores none; `git push` prices it as it runs).
pub fn merge(push: Option<MergePush>, deletes_source: bool) -> u64 {
    let push = push.map_or(0, |p| {
        let history = if p.history_index {
            2 * push_fees::history_index(HISTORY_PART_BYTES, false, 1, p.platform_bytes, false)
        } else {
            0
        };
        let pack = if p.uploads_pack {
            push_fees::estimate_push(&push_fees::PushShape {
                pack_bytes: MERGE_PACK_BYTES,
                objects: MERGE_PACK_OBJECTS,
                index_objects: MERGE_PACK_OBJECTS,
                refs: 0,
                external_targets: 0,
                platform_bytes: p.platform_bytes,
                sealed: false,
            })
            .total()
        } else {
            0
        };
        push_fees::estimate_ref_updates(1) + history + pack
    });
    let delete = if deletes_source {
        push_fees::estimate_ref_updates(1)
    } else {
        0
    };
    TRANSITION + push + delete
}

#[cfg(test)]
mod tests {
    use super::*;

    /// QW2-020: every quote covers what bonsia charged for the same write.
    #[test]
    fn quotes_cover_the_bonsia_charges() {
        // `dg issue create --title x`: 118.7M.
        assert!(target_create(1) >= 118_731_000);
        // `dg pr create --title "docs: note from a fork"` from refs/heads/fix/readme into
        // refs/heads/main: 133.9M (the highest of the two).
        let pr_text = ("docs: note from a fork".len()
            + "refs/heads/fix/readme".len()
            + "refs/heads/main".len()) as u64;
        assert!(target_create(pr_text) >= 133_946_000);
        // `dg release unpublish`: 70.4M; `dg release create v0.1.0` with one asset: 93.9M.
        assert!(release("v0.1.0".len() as u64, 0) >= 70_376_000);
        // One asset: `[{"name":"app.tar.gz","sha256":<64 hex>,"size_bytes":1234,"uris":[<60 B>]}]`.
        assert!(release(6, 170) >= 93_914_000);
        // `dg issue close` (a transition): 74.1M.
        const { assert!(TRANSITION >= 74_100_000) };
        assert!(merge(None, false) >= 74_100_000);
        // A fast-forward `dg pr merge` into the default branch, packs on Platform: 532.7M and
        // 500.5M (fixes/costs/04-quotes-vs-charges.txt; it was quoted 0.00416 DASH before the
        // history index's chunks were counted).
        assert!(merge(Some(DEFAULT_ON_PLATFORM), false) >= 532_741_400);
        // QW3-022: the same merge of a pull request from a fork, which uploads the head's
        // commits into the base: 920.5M (quoted 760M before).
        let from_fork = MergePush {
            uploads_pack: true,
            ..DEFAULT_ON_PLATFORM
        };
        assert!(merge(Some(from_fork), false) >= 920_538_820);
        assert!(merge(Some(from_fork), false) < 2 * 920_538_820);
        // `dg webhook add`: 77.2M (dg), 102.1M (the web's larger document); a document of
        // about 600 bytes.
        assert!(webhook(600) >= 102_100_000);
        assert!(webhook(600) < 2 * 102_100_000);
    }

    /// QW4-046 / QW4-049 / QW4-039: the quotes cover what sakura (Platform 5.0.0-beta.1, QA wave
    /// 4) charged, within a small multiple.
    #[test]
    fn quotes_cover_the_sakura_charges() {
        // `dg pr merge 4 --override-policy --squash --delete-branch`, packs in your own storage,
        // into the default branch: 574.4M (quoted 508M without the squash's pack and the bypass
        // event). The bypass names "required approvals: 0 of 1; required check `build`: missing".
        let squash = MergePush {
            history_index: true,
            platform_bytes: false,
            uploads_pack: true,
        };
        let bypass = "required approvals: 0 of 1; required check `build`: missing".len() as u64;
        let quoted = merge(Some(squash), true) + event(bypass, false);
        assert!(quoted >= 574_359_000, "{quoted}");
        assert!(quoted < 2 * 574_359_000, "{quoted}");
        // A label added as an issue's first event 67.8M; a later one removed 51.7M.
        assert!(event("bug".len() as u64, false) >= 67_820_000);
        assert!(event("bug".len() as u64, false) < 2 * 51_668_000);
        // An assignment (the identity in `value` and `refId`) 67.3M-67.4M; a review request
        // (`refId` alone) 74.0M; a thread resolve 66.0M.
        assert!(event(44, true) >= 67_400_000);
        assert!(event(0, true) >= 74_000_000);
        assert!(event(44, true) < 2 * 67_349_000);
        // `dg collab accept` 30.6M; `dg collab add --role triage` 48.1M.
        const { assert!(CONSENT >= 30_567_000 && CONSENT < 2 * 30_567_000) };
        const { assert!(MEMBER_GRANT >= 48_108_000 && MEMBER_GRANT < 2 * 48_108_000) };
        // A comment is priced as its thread's first by a new author (74.4M on moutai).
        assert!(comment(10) >= 74_400_000);
        assert!(comment(10) < 2 * 74_400_000);
    }

    /// The quotes stay quotes, not overestimates by an order of magnitude.
    #[test]
    fn quotes_stay_within_a_small_multiple_of_the_charges() {
        assert!(target_create(1) < 2 * 118_731_000);
        assert!(release(6, 0) < 2 * 70_376_000);
        // A merge that pushes costs more than one that only records it, and a source-branch
        // delete more again.
        let on = |history_index, platform_bytes| {
            Some(MergePush {
                history_index,
                platform_bytes,
                uploads_pack: false,
            })
        };
        assert!(merge(on(false, true), false) > merge(None, false));
        assert!(merge(on(true, false), false) > merge(on(false, false), false));
        assert!(merge(on(true, true), false) > merge(on(true, false), false));
        assert!(merge(on(true, false), true) > merge(on(true, false), false));
        assert!(merge(on(true, true), false) < 2 * 532_741_400);
        // A merge into another branch publishes no history index: a ref update and the
        // transition, not the default branch's ~0.0076.
        assert!(merge(on(false, true), false) < 200_000_000);
    }

    const DEFAULT_ON_PLATFORM: MergePush = MergePush {
        history_index: true,
        platform_bytes: true,
        uploads_pack: false,
    };
}
