//! Resumable-push journal persistence: `.git/dash/journal/<packHash>.json`.
//!
//! `forge-core` owns the [`PushJournal`] record + the [`JournalStore`] checkpoint contract
//! (so the write engine can be tested against an in-memory fake); this module supplies the
//! on-disk implementation the helper uses. Recording each confirmed chunk seq before moving
//! on lets a `kill -9`-interrupted push resume by re-reading the journal and skipping the
//! already-uploaded chunks — total fees ≈ a single push (PRD 02 §A).

use std::path::{Path, PathBuf};

use forge_core::platform::{JournalStore, PushJournal};
use forge_core::{Error, Result};

/// The journal path for a pack under a repo's `GIT_DIR`.
pub fn journal_path(git_dir: &Path, pack_hash_hex: &str) -> PathBuf {
    git_dir
        .join("dash")
        .join("journal")
        .join(format!("{pack_hash_hex}.json"))
}

/// Load an existing journal for `pack_hash_hex`, or start a fresh one. A journal whose
/// recorded pack hash does not match (a stale/foreign file) is discarded rather than
/// trusted — resuming against the wrong pack would skip real chunks.
pub fn load_or_new(path: &Path, pack_hash_hex: &str, chunk_count: u32) -> PushJournal {
    if let Ok(bytes) = std::fs::read(path) {
        if let Ok(journal) = serde_json::from_slice::<PushJournal>(&bytes) {
            if journal.pack_hash == pack_hash_hex && journal.chunk_count == chunk_count {
                return journal;
            }
        }
    }
    PushJournal::new(pack_hash_hex, chunk_count)
}

/// A filesystem-backed [`JournalStore`] writing atomically-ish (write-then-rename) to a
/// fixed path after every confirmed chunk.
pub struct FileJournalStore {
    path: PathBuf,
}

impl FileJournalStore {
    /// Create a store that checkpoints to `path`.
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl JournalStore for FileJournalStore {
    fn checkpoint(&self, journal: &PushJournal) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| Error::Io(e.to_string()))?;
        }
        let json = serde_json::to_vec_pretty(journal).map_err(Error::from)?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, &json).map_err(|e| Error::Io(e.to_string()))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| Error::Io(e.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{load_or_new, FileJournalStore};
    use forge_core::platform::{JournalStore, PushJournal, WriteIntent, WriteOp};

    fn intent(seq: u32) -> WriteIntent {
        WriteIntent {
            seq,
            document_id: format!("doc{seq}"),
            operation: WriteOp::Create,
            transition: forge_core::platform::SignedTransition {
                bytes: vec![1, 2, 3],
                nonce: u64::from(seq) + 1,
            },
        }
    }

    #[test]
    fn checkpoint_then_reload_skips_recorded_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dash/journal/abc.json");

        let mut journal = load_or_new(&path, "abc", 3);
        assert!(!journal.has(0));
        journal.record(&intent(0));
        journal.record(&intent(1));
        let store = FileJournalStore::new(path.clone());
        store.checkpoint(&journal).unwrap();

        // Simulate a crash + resume: reload from disk.
        let resumed = load_or_new(&path, "abc", 3);
        assert!(
            resumed.has(0),
            "resumed journal must skip already-uploaded chunk 0"
        );
        assert!(resumed.has(1));
        assert!(!resumed.has(2), "chunk 2 was never uploaded");
        assert!(!resumed.is_complete());
    }

    #[test]
    fn mismatched_pack_hash_starts_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("j.json");
        let mut journal = PushJournal::new("aaa", 2);
        journal.record(&intent(0));
        FileJournalStore::new(path.clone())
            .checkpoint(&journal)
            .unwrap();
        // A different pack hash must not inherit the old journal's recorded chunks.
        let fresh = load_or_new(&path, "bbb", 2);
        assert!(!fresh.has(0));
    }
}
