//! Resumable migration state (PRD 06 `--resume`).
//!
//! A JSON checkpoint file records exactly what has already been imported — the repo
//! created/resolved, git refs pushed, and the set of GitHub artifact keys (issue numbers,
//! PR numbers, label names, milestone titles, release tags) already written to Platform.
//! On `--resume` the importer skips anything already recorded, so an interrupted run never
//! duplicates a document or pays a fee twice. The checkpoint is flushed after every write.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// The persisted migration checkpoint.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImportState {
    /// Source `owner/repo` this state belongs to (guards against a mismatched `--resume`).
    #[serde(default)]
    pub source: String,
    /// Destination repo contract id (base58), once created or resolved.
    #[serde(default)]
    pub repo_contract_id: Option<String>,
    /// Destination repo owner identity id (base58).
    #[serde(default)]
    pub owner_id: Option<String>,
    /// Destination repo name.
    #[serde(default)]
    pub repo_name: Option<String>,
    /// Whether the repo contract was freshly created by this migration (vs reused).
    #[serde(default)]
    pub repo_created: bool,
    /// Whether git refs/packs have been pushed.
    #[serde(default)]
    pub refs_pushed: bool,
    /// GitHub issue numbers already imported.
    #[serde(default)]
    pub done_issues: BTreeSet<u64>,
    /// GitHub PR numbers already imported.
    #[serde(default)]
    pub done_prs: BTreeSet<u64>,
    /// Label names already imported (labels + milestone-derived labels).
    #[serde(default)]
    pub done_labels: BTreeSet<String>,
    /// Release tags already imported.
    #[serde(default)]
    pub done_releases: BTreeSet<String>,
    /// Total credits spent by this migration so far (running audit; 1e11 = 1 DASH).
    #[serde(default)]
    pub spent_credits: u64,
    #[serde(skip)]
    path: PathBuf,
}

impl ImportState {
    /// Load state from `path`, or start fresh (recording `source`) if it does not exist.
    /// A resumed file whose `source` disagrees is rejected — resuming the wrong migration
    /// into the wrong repo would double-pay against unrelated artifacts.
    pub fn load_or_new(path: &Path, source: &str) -> Result<Self> {
        if path.exists() {
            let raw = std::fs::read_to_string(path)
                .with_context(|| format!("reading resume state {}", path.display()))?;
            let mut state: ImportState = serde_json::from_str(&raw)
                .with_context(|| format!("parsing resume state {}", path.display()))?;
            if !state.source.is_empty() && state.source != source {
                anyhow::bail!(
                    "resume-state {} is for source {:?}, not {:?} — refusing to resume",
                    path.display(),
                    state.source,
                    source
                );
            }
            state.source = source.to_string();
            state.path = path.to_path_buf();
            Ok(state)
        } else {
            Ok(Self {
                source: source.to_string(),
                path: path.to_path_buf(),
                ..Default::default()
            })
        }
    }

    /// Persist the checkpoint to disk (atomic-ish: write + rename).
    pub fn save(&self) -> Result<()> {
        if self.path.as_os_str().is_empty() {
            return Ok(());
        }
        let tmp = self.path.with_extension("tmp");
        let json = serde_json::to_string_pretty(self).context("serializing resume state")?;
        std::fs::write(&tmp, json)
            .with_context(|| format!("writing resume state {}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path)
            .with_context(|| format!("installing resume state {}", self.path.display()))?;
        Ok(())
    }

    /// Record additional spend and checkpoint.
    pub fn add_spend(&mut self, credits: u64) -> Result<()> {
        self.spent_credits = self.spent_credits.saturating_add(credits);
        self.save()
    }
}

#[cfg(test)]
mod tests {
    use super::ImportState;

    #[test]
    fn round_trips_and_resumes() {
        let dir = std::env::temp_dir().join(format!("forge-import-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let _ = std::fs::remove_file(&path);

        let mut s = ImportState::load_or_new(&path, "dashpay/dips").unwrap();
        s.repo_contract_id = Some("Ctr".into());
        s.done_issues.insert(7);
        s.done_labels.insert("bug".into());
        s.save().unwrap();

        let reloaded = ImportState::load_or_new(&path, "dashpay/dips").unwrap();
        assert_eq!(reloaded.repo_contract_id.as_deref(), Some("Ctr"));
        assert!(reloaded.done_issues.contains(&7));
        assert!(reloaded.done_labels.contains("bug"));

        // A mismatched source is refused.
        assert!(ImportState::load_or_new(&path, "other/repo").is_err());
        let _ = std::fs::remove_file(&path);
    }
}
