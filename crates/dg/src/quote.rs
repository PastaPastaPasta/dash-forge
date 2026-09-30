//! Pre-sign quotes for writes whose prompts used to carry a fixed figure (QW2-020: "~0.0001
//! DASH" for a pull request that cost 0.0013). Each is an upper bound built from the importer's
//! calibrated per-kind model (`forge_import::budget::collab_doc_credits`) and `git push`'s fees
//! (`forge_core::cost::push_fees`), with the write priced as the first of its kind in its
//! repository.

use forge_core::cost::push_fees;
use forge_import::budget::{collab_doc_credits, sealed_release_credits, CollabDoc};

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

/// The bytes one release asset adds to its list: its SHA-256, size and the list's framing,
/// beyond its name and URIs. Rounded up.
const ASSET_FIXED_BYTES: u64 = 64;

/// A `transition` (close, reopen, merge, draft, ready, lock): an issue close charged 74.1M
/// credits on bonsia (QA wave 2, IP-14), above the 65M an event was quoted at; ~10 % over it.
pub const TRANSITION: u64 = 82_000_000;

/// A new issue or pull request carrying `text_bytes` of text (title, body, and a patch's ref
/// names), priced as its repository's first. Charged on bonsia: an issue 118.7M, a pull
/// request 130.1M-133.9M (QW2-020).
pub fn target_create(text_bytes: u64) -> u64 {
    collab_doc_credits(CollabDoc::Target, text_bytes + TARGET_FIXED_BYTES) + FIRST_OF_KIND_EXTRA
}

/// A public `release` revision carrying `text_bytes` of tag, name and notes, and `assets` (each
/// its name and URIs in `asset_bytes` in all). Charged on bonsia: a first release with one
/// asset 93.9M, an unpublish revision 70.4M (QW2-020, quoted "~0.0002 DASH").
pub fn release(text_bytes: u64, assets: u64, asset_bytes: u64) -> u64 {
    let bytes = RELEASE_FIXED_BYTES + text_bytes + assets * ASSET_FIXED_BYTES + asset_bytes;
    collab_doc_credits(CollabDoc::Release, bytes)
}

/// A sealed (private) release revision, and its new asset list's manifest when `new_list`,
/// naming `targets`' URIs (`forge_import::budget::sealed_release_credits`).
pub fn sealed_release(new_list: bool, targets: u64) -> u64 {
    sealed_release_credits(new_list, targets)
}

/// The bytes a history-index part is priced at when its size is not known before the push (a
/// small repository's parts are a few hundred bytes; each is at least one `chunk` when Platform
/// stores it).
const HISTORY_PART_BYTES: u64 = 1024;

/// What `dg pr merge` writes on Platform: the merge `transition`; unless it only records a
/// merge, the push of the base branch (its ref update and, on the default branch, the two parts
/// of its history index, as `chunk`s too when `platform_bytes`); and the source branch's delete
/// when asked. New objects' pack comes on top (a fast-forward stores none; `git push` prices
/// it as it runs).
pub fn merge(pushes: bool, deletes_source: bool, platform_bytes: bool) -> u64 {
    let push = if pushes {
        let part = push_fees::history_index(HISTORY_PART_BYTES, false, 1, platform_bytes, false);
        push_fees::estimate_ref_updates(1) + 2 * part
    } else {
        0
    };
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
        assert!(release("v0.1.0".len() as u64, 0, 0) >= 70_376_000);
        assert!(release(6, 1, "app.tar.gz".len() as u64 + 60) >= 93_914_000);
        // `dg issue close` (a transition): 74.1M.
        const { assert!(TRANSITION >= 74_100_000) };
        assert!(merge(false, false, true) >= 74_100_000);
        // A fast-forward `dg pr merge` into the default branch, packs on Platform: 532.7M
        // (fixes/costs/04-quotes-vs-charges.txt; it was quoted 0.00416 DASH before the history
        // index's chunks were counted).
        assert!(merge(true, false, true) >= 532_741_400);
    }

    /// The quotes stay quotes, not overestimates by an order of magnitude.
    #[test]
    fn quotes_stay_within_a_small_multiple_of_the_charges() {
        assert!(target_create(1) < 2 * 118_731_000);
        assert!(release(6, 0, 0) < 2 * 70_376_000);
        // A merge that pushes costs more than one that only records it, and a source-branch
        // delete more again.
        assert!(merge(true, false, false) > merge(false, false, false));
        assert!(merge(true, true, false) > merge(true, false, false));
        assert!(merge(true, false, true) > merge(true, false, false));
        assert!(merge(true, false, true) < 2 * 532_741_400);
    }
}
