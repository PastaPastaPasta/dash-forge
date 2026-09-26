//! The incremental state file (`--state`): when the last successful sync started, so the
//! next run asks GitHub only for what changed since.
//!
//! It is an optimisation, never the source of truth: what is already mirrored is decided
//! on chain (see [`crate::sink`]), so a lost, stale or foreign state file costs a full
//! re-scan, never a duplicate document or a second fee.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Re-read this much before the recorded start, so an item updated while the last run was
/// reading is seen again (it is diffed, so seeing it twice costs nothing).
const OVERLAP_SECS: u64 = 600;

/// The persisted state.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    /// `github.com/owner/repo` this state belongs to.
    pub source: String,
    /// The destination repo id.
    pub repo_id: String,
    /// Unix seconds when the last successful run started.
    pub last_sync_started: Option<u64>,
    #[serde(skip)]
    path: Option<PathBuf>,
}

impl SyncState {
    /// Load `path` for `source` → `repo_id`. A missing file, or one for another source or
    /// destination, is a fresh state (a full scan).
    pub fn load(path: Option<&Path>, source: &str, repo_id: &str) -> Self {
        let fresh = Self {
            source: source.to_string(),
            repo_id: repo_id.to_string(),
            last_sync_started: None,
            path: path.map(Path::to_path_buf),
        };
        let Some(p) = path else { return fresh };
        match std::fs::read(p)
            .ok()
            .and_then(|b| serde_json::from_slice::<SyncState>(&b).ok())
        {
            Some(s) if s.source == source && s.repo_id == repo_id => Self {
                path: fresh.path,
                ..s
            },
            Some(_) => {
                tracing::warn!(
                    path = %p.display(),
                    "the state file is for another source or destination; doing a full scan"
                );
                fresh
            }
            None => fresh,
        }
    }

    /// The `since` to ask GitHub with (ISO 8601), or `None` for a full scan.
    pub fn since(&self) -> Option<String> {
        self.last_sync_started
            .map(|t| crate::github::unix_to_iso8601(t.saturating_sub(OVERLAP_SECS)))
    }

    /// Record a successful run that started at `started` (unix seconds).
    pub fn save(&mut self, started: u64) -> Result<()> {
        self.last_sync_started = Some(started);
        let Some(p) = &self.path else { return Ok(()) };
        if let Some(dir) = p.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let tmp = p.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, p).with_context(|| format!("writing {}", p.display()))
    }
}

/// Now, unix seconds.
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_ignores_foreign_state() {
        let dir = std::env::temp_dir().join(format!("forge-import-state-{}", std::process::id()));
        let path = dir.join("s.json");
        let mut s = SyncState::load(Some(&path), "github.com/o/r", "R1");
        assert!(s.since().is_none(), "a missing file is a full scan");
        s.save(1_000_000).unwrap();

        let again = SyncState::load(Some(&path), "github.com/o/r", "R1");
        assert_eq!(again.last_sync_started, Some(1_000_000));
        assert_eq!(
            again.since().unwrap(),
            crate::github::unix_to_iso8601(1_000_000 - OVERLAP_SECS)
        );
        // Another destination: full scan, never another repo's cursor.
        assert!(SyncState::load(Some(&path), "github.com/o/r", "R2")
            .since()
            .is_none());
        std::fs::write(&path, b"{nope").unwrap();
        assert!(SyncState::load(Some(&path), "github.com/o/r", "R1")
            .since()
            .is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
