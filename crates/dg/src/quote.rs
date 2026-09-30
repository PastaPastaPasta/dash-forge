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
}

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
        push_fees::estimate_ref_updates(1) + history
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
    };
}
