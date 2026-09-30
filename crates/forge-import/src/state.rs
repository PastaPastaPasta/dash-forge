//! The incremental state file (`--state`): when the last successful sync started, so the
//! next run asks the source only for what changed since.
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
    /// The source this state belongs to (`github.com/owner/repo`, `gitlab.com/group/project`).
    pub source: String,
    /// The destination: the repo id and the forge-collab contract its collaboration documents
    /// live in ([`destination`]). A re-registered forge-collab starts empty, so a cursor saved
    /// against the old one must not narrow what the next run reads (D-918). The key stays
    /// `repoId` in the file, so an older state file is read (and, being bare, does not match).
    #[serde(rename = "repoId")]
    pub destination: String,
    /// Unix seconds when the last successful run started.
    pub last_sync_started: Option<u64>,
    /// PRs/MRs (source numbers) the source merged whose merge the last run could not prove
    /// yet (the code was not on chain, or the base could not be fetched): read again by the
    /// next run whatever `since` says, so the cursor never skips past them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub revisit: Vec<u32>,
    /// Items the destination refused (a content error: a field too long, an illegal ref name,
    /// …), as `"<tk>:<source number>"` (0 issue, 1 PR). The state advances past them, so one
    /// bad item does not hold every later run at the same window; one edited at the source
    /// comes back into the window and is tried again. The dense-order check leaves them out
    /// of what it calls missing ([`crate::sink::Sink`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refused: Vec<String>,
    #[serde(skip)]
    path: Option<PathBuf>,
}

impl SyncState {
    /// Load `path` for `source` → `destination` ([`destination`]). `source` names what the run
    /// reads, classes and limit included (see [`scope`]), so a file saved by a narrower run
    /// (`--sync code`) is not reused by a wider one. A missing file, or one for another source,
    /// scope or destination, is a fresh state (a full scan).
    pub fn load(path: Option<&Path>, source: &str, destination: &str) -> Self {
        let fresh = Self {
            source: source.to_string(),
            destination: destination.to_string(),
            last_sync_started: None,
            revisit: Vec::new(),
            refused: Vec::new(),
            path: path.map(Path::to_path_buf),
        };
        let Some(p) = path else { return fresh };
        match std::fs::read(p)
            .ok()
            .and_then(|b| serde_json::from_slice::<SyncState>(&b).ok())
        {
            Some(s) if s.source == source && s.destination == destination => Self {
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

    /// The `since` to ask the source with (ISO 8601), or `None` for a full scan.
    pub fn since(&self) -> Option<String> {
        self.last_sync_started
            .map(|t| crate::github::unix_to_iso8601(t.saturating_sub(OVERLAP_SECS)))
    }

    /// The items the last run left to revisit ([`Self::revisit`]); none on a full scan, which
    /// reads everything anyway.
    pub fn pending_revisits(&self) -> &[u32] {
        if self.last_sync_started.is_some() {
            &self.revisit
        } else {
            &[]
        }
    }

    /// The items the destination refused on earlier runs ([`Self::refused`]), as `(tk,
    /// source number)`.
    #[must_use]
    pub fn refused_items(&self) -> std::collections::BTreeSet<(u8, u32)> {
        self.refused
            .iter()
            .filter_map(|k| {
                let (tk, n) = k.split_once(':')?;
                Some((tk.parse().ok()?, n.parse().ok()?))
            })
            .collect()
    }

    /// Set the refused items to save ([`Self::refused`]).
    pub fn set_refused(&mut self, items: &std::collections::BTreeSet<(u8, u32)>) {
        self.refused = items.iter().map(|(tk, n)| format!("{tk}:{n}")).collect();
    }

    /// Record a successful run that started at `started` (unix seconds), with the items the
    /// next run must read again whatever `since` says ([`Self::revisit`]).
    pub fn save(&mut self, started: u64, revisit: Vec<u32>) -> Result<()> {
        self.last_sync_started = Some(started);
        self.revisit = revisit;
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

/// What a state file's scope is stamped with: bumped whenever an importer writes items
/// differently, so the first run after an upgrade is a full scan that revisits items a state
/// file would skip. `v2`: merged PRs recorded as merged, and release asset hashes (D-602,
/// D-517), so a repository an older import mirrored is repaired by its next scheduled run.
pub const SCOPE_VERSION: &str = "v2";

/// The state key of a run: its source plus what it reads (`github.com/o/r
/// [issues,prs,releases,labels,code] limit=0 v2`).
pub fn scope(source: &str, classes: crate::source::Classes, limit: usize) -> String {
    let c = classes;
    let on = [
        (c.code, "code"),
        (c.issues, "issues"),
        (c.prs, "prs"),
        (c.releases, "releases"),
        (c.labels, "labels"),
    ];
    let names: Vec<&str> = on.iter().filter(|(b, _)| *b).map(|(_, n)| *n).collect();
    format!(
        "{source} [{}] limit={limit} {SCOPE_VERSION}",
        names.join(",")
    )
}

/// The destination key a state file is saved against: the repo id and the forge-collab
/// contract id (`<repoId>@<collab>`). An empty repo id (a repo this run will create) stays
/// empty, so no saved state ever matches it.
pub fn destination(repo_id: &str, collab_contract: &str) -> String {
    if repo_id.is_empty() {
        String::new()
    } else {
        format!("{repo_id}@{collab_contract}")
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
        s.save(1_000_000, Vec::new()).unwrap();

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

    /// A state file an older importer saved (no version in its scope) is a full scan for this
    /// one: the PRs it recorded closed-not-merged are revisited and repaired (D-602).
    /// A1 (review): merges a run could not prove are saved and read again by the next run
    /// (the cursor still advances past everything else); a full scan needs no list.
    #[test]
    fn unproved_merges_are_revisited_by_the_next_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.json");
        let mut s = SyncState::load(Some(&path), "src", "R1");
        assert!(s.pending_revisits().is_empty());
        s.save(1_000_000, vec![7, 9]).unwrap();
        let again = SyncState::load(Some(&path), "src", "R1");
        assert_eq!(again.pending_revisits(), [7, 9]);
        assert!(again.since().is_some());
        let mut next = again;
        next.save(2_000_000, Vec::new()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("revisit"),
            "an empty list is not written: {raw}"
        );
        assert!(SyncState::load(Some(&path), "src", "R1")
            .pending_revisits()
            .is_empty());
    }

    #[test]
    fn an_older_importers_state_is_a_full_scan() {
        let dir = std::env::temp_dir().join(format!("forge-import-scope-{}", std::process::id()));
        let path = dir.join("s.json");
        let all = crate::source::Classes::parse("all").unwrap();
        let old = "github.com/o/r [code,issues,prs,releases,labels] limit=0";
        SyncState::load(Some(&path), old, "R1")
            .save(1_000_000, Vec::new())
            .unwrap();
        let now = scope("github.com/o/r", all, 0);
        assert!(now.ends_with(" v2"), "{now}");
        assert!(SyncState::load(Some(&path), &now, "R1").since().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// D-918: after forge-collab is re-registered, the collab documents of every repo are gone
    /// from the contract the importer now writes to. A state file saved against the old contract
    /// must not narrow the next run to "changed since": it is a full scan, which re-imports the
    /// issues and PRs into the new contract.
    #[test]
    fn a_state_saved_against_another_collab_contract_is_a_full_scan() {
        let dir = std::env::temp_dir().join(format!("forge-import-collab-{}", std::process::id()));
        let path = dir.join("s.json");
        let before = destination("R1", "CollabOld");
        SyncState::load(Some(&path), "github.com/o/r", &before)
            .save(1_000_000, Vec::new())
            .unwrap();
        assert!(SyncState::load(Some(&path), "github.com/o/r", &before)
            .since()
            .is_some());
        let after = destination("R1", "CollabNew");
        assert!(SyncState::load(Some(&path), "github.com/o/r", &after)
            .since()
            .is_none());
        // A repo the run will create has no destination yet: nothing matches it.
        assert_eq!(destination("", "CollabNew"), "");
        std::fs::remove_dir_all(&dir).ok();
    }
}
