//! Which blobs each stored pack holds, for a partial clone: `.git/dash/catalog/<repo id>/<pack
//! hash>.txt`, one blob oid per line.
//!
//! A `--filter` fetch reads whole packs through a scratch repository and keeps only the filtered
//! subset, so [`crate::fetched::FetchedPacks`] cannot record them as held. It records here what
//! each pack it read holds instead. When git then fetches missing blobs lazily (a checkout,
//! `git log -p`, `git blame`), a fetch of blobs this catalog places downloads only the packs
//! holding them ([`cover`]), not every pack of the repository again.
//!
//! The catalog is advisory, like the held-pack record: it only picks which packs to download.
//! Every pack is still hash-verified, and a pack that turns out not to hold a wanted blob (a
//! catalog copied from elsewhere, a pack now set aside) fails the narrow fetch, and the helper
//! falls back to reading every pack.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// The blobs each catalogued pack holds, by stored pack hash.
pub type Catalog = BTreeMap<[u8; 32], BTreeSet<String>>;

fn dir(git_dir: &Path, repo_id: &str) -> PathBuf {
    git_dir
        .join("dash")
        .join("catalog")
        .join(forge_core::cache::component(repo_id))
}

/// The catalog entries of `packs` for `repo_id` in `git_dir`; a pack without one (never read by
/// a filtered fetch, or unreadable) is left out.
pub fn load(git_dir: &Path, repo_id: &str, packs: impl IntoIterator<Item = [u8; 32]>) -> Catalog {
    let dir = dir(git_dir, repo_id);
    packs
        .into_iter()
        .filter_map(|h| {
            let text = std::fs::read_to_string(dir.join(format!("{}.txt", hex::encode(h)))).ok()?;
            let blobs = text
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_hexdigit()))
                .map(str::to_ascii_lowercase)
                .collect();
            Some((h, blobs))
        })
        .collect()
}

/// Record that pack `hash` holds `blobs` (atomically; a failure only costs a wider fetch later).
pub fn record(git_dir: &Path, repo_id: &str, hash: [u8; 32], blobs: &[String]) {
    let mut text = blobs.join("\n");
    text.push('\n');
    forge_core::cache::write(
        &dir(git_dir, repo_id).join(format!("{}.txt", hex::encode(hash))),
        text.as_bytes(),
    );
}

/// The packs, of those `catalog` describes, that together hold every one of `wants`: each round
/// takes the pack holding the most wants still uncovered (the first in `catalog` order on a
/// tie). `None` when a want is in no catalogued pack (a tree or commit, a blob of a pack never
/// read whole, or a catalog that does not cover the repository): the fetch then reads every
/// pack. No wants, no packs.
pub fn cover(catalog: &Catalog, wants: &[String]) -> Option<Vec<[u8; 32]>> {
    let mut left: BTreeSet<String> = wants.iter().map(|w| w.to_ascii_lowercase()).collect();
    let mut chosen = Vec::new();
    while !left.is_empty() {
        let (hash, blobs) = catalog
            .iter()
            .map(|(h, b)| (h, b.intersection(&left).count(), b))
            .filter(|(_, n, _)| *n > 0)
            // max_by_key keeps the last maximum; reversing keeps the first
            .rev()
            .max_by_key(|(_, n, _)| *n)
            .map(|(h, _, b)| (*h, b))?;
        left.retain(|w| !blobs.contains(w));
        chosen.push(hash);
    }
    Some(chosen)
}

#[cfg(test)]
mod tests {
    use super::{cover, load, record, Catalog};

    fn oid(c: char) -> String {
        c.to_string().repeat(40)
    }

    #[test]
    fn the_catalog_round_trips_per_repository_and_pack() {
        let dir = tempfile::tempdir().unwrap();
        record(dir.path(), "repoA", [1; 32], &[oid('a'), oid('b')]);
        record(dir.path(), "repoA", [2; 32], &[]);
        let got = load(dir.path(), "repoA", [[1; 32], [2; 32], [3; 32]]);
        assert_eq!(got.len(), 2, "a pack never catalogued is left out");
        assert_eq!(got[&[1; 32]], [oid('a'), oid('b')].into_iter().collect());
        assert!(
            got[&[2; 32]].is_empty(),
            "a pack with no blobs is still catalogued"
        );
        assert!(
            load(dir.path(), "repoB", [[1; 32]]).is_empty(),
            "catalogs are per repository"
        );
    }

    #[test]
    fn junk_lines_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        record(
            dir.path(),
            "r",
            [1; 32],
            &["nothex!".into(), oid('A'), String::new()],
        );
        assert_eq!(
            load(dir.path(), "r", [[1; 32]])[&[1; 32]],
            [oid('a')].into_iter().collect()
        );
    }

    #[test]
    fn the_fewest_packs_that_hold_every_want() {
        let catalog: Catalog = [
            ([1; 32], [oid('a')].into_iter().collect()),
            (
                [2; 32],
                [oid('a'), oid('b'), oid('c')].into_iter().collect(),
            ),
            ([3; 32], [oid('c'), oid('d')].into_iter().collect()),
            ([4; 32], [oid('d')].into_iter().collect()),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            cover(&catalog, &[oid('a')]),
            Some(vec![[1; 32]]),
            "the first on a tie"
        );
        assert_eq!(
            cover(&catalog, &[oid('a'), oid('b'), oid('d')]),
            Some(vec![[2; 32], [3; 32]])
        );
        assert_eq!(
            cover(&catalog, &[oid('D')]),
            Some(vec![[3; 32]]),
            "oids in any case"
        );
        assert_eq!(
            cover(&catalog, &[oid('a'), oid('e')]),
            None,
            "e is in no pack"
        );
        assert_eq!(cover(&catalog, &[]), Some(vec![]));
        assert_eq!(cover(&Catalog::new(), &[oid('a')]), None);
    }
}
