//! The packs this clone already holds, per repository: `.git/dash/fetched/<repo id>.txt`, one
//! stored pack hash (hex, as the manifest records it) per line.
//!
//! A pack is recorded once a full (unfiltered) fetch indexed it whole, or once this clone pushed
//! it: its objects are then in the local object database, and a later fetch does not download
//! it again (`platform-parity-spec.md` §3.3: "only the packs whose hash is not in
//! `.git/dash/packs`"). The record is advisory: if the objects a fetch wants are still missing
//! after an incremental fetch (a `git gc` pruned them, the file was copied from another clone),
//! the helper fetches every pack again and rewrites the record.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// The set of stored pack hashes this clone holds for one repository.
#[derive(Debug, Default)]
pub struct FetchedPacks(BTreeSet<[u8; 32]>);

impl FetchedPacks {
    fn path(git_dir: &Path, repo_id: &str) -> PathBuf {
        git_dir
            .join("dash")
            .join("fetched")
            .join(format!("{}.txt", forge_core::cache::component(repo_id)))
    }

    /// The record for `repo_id` in `git_dir` (empty when absent or unreadable; bad lines are
    /// ignored).
    pub fn load(git_dir: &Path, repo_id: &str) -> Self {
        let text = std::fs::read_to_string(Self::path(git_dir, repo_id)).unwrap_or_default();
        Self(
            text.lines()
                .filter_map(|l| hex::decode(l.trim()).ok())
                .filter_map(|b| <[u8; 32]>::try_from(b).ok())
                .collect(),
        )
    }

    /// Whether `hash` is recorded.
    pub fn contains(&self, hash: &[u8; 32]) -> bool {
        self.0.contains(hash)
    }

    /// Record `hash`.
    pub fn insert(&mut self, hash: [u8; 32]) {
        self.0.insert(hash);
    }

    /// Write the record (atomically; a failure only costs a re-download later).
    pub fn save(&self, git_dir: &Path, repo_id: &str) {
        let text: Vec<String> = self.0.iter().map(hex::encode).collect();
        let text = text.join("\n") + "\n";
        forge_core::cache::write(&Self::path(git_dir, repo_id), text.as_bytes());
    }

    /// Record `hash` for `repo_id` in `git_dir` (load, insert, save).
    pub fn record(git_dir: &Path, repo_id: &str, hash: [u8; 32]) {
        let mut set = Self::load(git_dir, repo_id);
        set.insert(hash);
        set.save(git_dir, repo_id);
    }
}

#[cfg(test)]
mod tests {
    use super::FetchedPacks;

    #[test]
    fn the_record_round_trips_per_repository() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!FetchedPacks::load(dir.path(), "repoA").contains(&[7; 32]));
        FetchedPacks::record(dir.path(), "repoA", [7; 32]);
        FetchedPacks::record(dir.path(), "repoA", [9; 32]);
        let a = FetchedPacks::load(dir.path(), "repoA");
        assert!(a.contains(&[7; 32]) && a.contains(&[9; 32]));
        assert!(
            !FetchedPacks::load(dir.path(), "repoB").contains(&[7; 32]),
            "records are per repository"
        );
    }

    #[test]
    fn junk_lines_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("dash/fetched");
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(
            p.join("r.txt"),
            format!("nothex\n{}\nabcd\n", hex::encode([3u8; 32])),
        )
        .unwrap();
        let got = FetchedPacks::load(dir.path(), "r");
        assert!(got.contains(&[3; 32]));
    }
}
