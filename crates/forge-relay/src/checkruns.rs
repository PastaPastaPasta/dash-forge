//! In-place `checkRun` updates (platform-parity spec §2.10, D-604 area).
//!
//! A `checkRun` is mutable: a runner creates it `queued`, then replaces the same document with
//! `in_progress`, then `completed`. A replace keeps `$createdAt`, so the relay's usual streams
//! (`$createdAt > cursor`) never see it, and there is no `$updatedAt` index to read instead.
//! So for each watched head the relay reads the newest page of `checkRun (repoId, headOid)`
//! every cycle and compares each document's `$revision` with the one it saw last
//! ([`diff`]).
//!
//! **GitHub actions.** GitHub's `check_run` has four actions: `created`, `completed`,
//! `rerequested` and `requested_action`. A repository webhook receives only `created` and
//! `completed`. The other two are requests from GitHub's UI to the GitHub App that owns the
//! run, and Forge has neither. So the relay sends:
//!
//! * `created` for a document it has not seen, created no earlier than the head's baseline;
//! * `completed` when the status becomes `completed`: on a new document already completed
//!   (after its `created`), or on a replace of a run last seen not completed.
//!
//! A replace to `in_progress`, or an edit of a run that was already completed, has no GitHub
//! action and is not delivered (the next `completed` carries the current state).
//!
//! **State.** What was seen, per head and document (`$revision`, completed or not), is kept
//! in `<state dir>/check-runs/<repo id>.json` when the retry queue is durable (the queue's
//! lock makes the state dir this relay's), so a restart does not re-send, and a known run
//! that completed while the relay was down is sent `completed`. The watched heads are
//! restored from it too. (Runs created while it was down are not replayed, like every stream.)

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use forge_core::platform::FetchedDocument;

use crate::payload::CheckRunAction;

/// Rows read per head and cycle: Drive's page maximum, the newest runs first.
pub const PAGE: u32 = 100;

/// Runs remembered per head. A run missing from a read (deleted, past the newest page, or a
/// lagging node) is remembered, so it is not announced again if it reappears; beyond this
/// many, the oldest are forgotten.
pub const MAX_RUNS_PER_HEAD: usize = 2 * PAGE as usize;

/// What the relay last saw of one `checkRun` document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunSeen {
    /// Its `$revision`.
    pub rev: u64,
    /// Whether its status was `completed`.
    pub done: bool,
    /// Its `$createdAt` (ms): which runs are forgotten first.
    pub at: u64,
}

/// One watched head's runs, by document id.
pub type HeadRuns = BTreeMap<String, RunSeen>;

/// A `checkRun`'s status is `completed` (a document without one counts as completed, as
/// [`crate::ingest::translate_check_run`] reports it).
pub fn is_done(d: &FetchedDocument) -> bool {
    d.field_str("status").is_none_or(|s| s == "completed")
}

/// Compare a head's current runs (`docs`, any order) with what was seen (`prev`). Returns the
/// events to send, oldest document first, and the new state for the head. `since` is the
/// head's baseline: an unseen document created before it is recorded, not delivered. A read
/// older than what was seen (a lagging node) keeps the newer state and sends nothing. Runs
/// absent from `docs` stay remembered (at most [`MAX_RUNS_PER_HEAD`], newest kept).
pub fn diff<'a>(
    prev: &HeadRuns,
    docs: &'a [FetchedDocument],
    since: u64,
) -> (Vec<(CheckRunAction, &'a FetchedDocument)>, HeadRuns) {
    let mut docs: Vec<&FetchedDocument> = docs.iter().filter(|d| d.created_at.is_some()).collect();
    docs.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let mut out = Vec::new();
    let mut next = prev.clone();
    for d in docs {
        let now = RunSeen {
            rev: d.revision.unwrap_or(1),
            done: is_done(d),
            at: d.created_at.unwrap_or(0),
        };
        match prev.get(&d.id) {
            None => {
                if d.created_at.unwrap_or(0) >= since {
                    out.push((CheckRunAction::Created, d));
                    if now.done {
                        out.push((CheckRunAction::Completed, d));
                    }
                }
                next.insert(d.id.clone(), now);
            }
            Some(seen) if now.rev < seen.rev => {
                next.insert(d.id.clone(), *seen);
            }
            Some(seen) => {
                if now.rev > seen.rev && now.done && !seen.done {
                    out.push((CheckRunAction::Completed, d));
                }
                next.insert(d.id.clone(), now);
            }
        }
    }
    if next.len() > MAX_RUNS_PER_HEAD {
        let mut by_age: Vec<(u64, String)> = next.iter().map(|(k, v)| (v.at, k.clone())).collect();
        by_age.sort();
        for (_, k) in by_age.iter().take(next.len() - MAX_RUNS_PER_HEAD) {
            next.remove(k);
        }
    }
    (out, next)
}

/// The dedup key (the `X-GitHub-Delivery` seed) of a check-run event: the document id for
/// `created`, and the id plus the revision for `completed`, so a run that completes again
/// after a re-run is delivered again while every relay derives the same key.
pub fn event_key(d: &FetchedDocument, action: CheckRunAction) -> String {
    match action {
        CheckRunAction::Created => d.id.clone(),
        CheckRunAction::Completed => {
            format!("{}:completed:{}", d.id, d.revision.unwrap_or(1))
        }
    }
}

/// One persisted head.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedHead {
    /// When the head was first watched (block time, ms).
    pub seen: u64,
    /// Its runs.
    pub runs: HeadRuns,
}

/// A repo's persisted check-run state: watched head oid (hex) → its runs.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Saved {
    /// The heads.
    pub heads: BTreeMap<String, SavedHead>,
}

/// Where check-run state is kept: `<state dir>/check-runs`, or nowhere (in memory only).
#[derive(Debug, Clone, Default)]
pub struct Store {
    dir: Option<PathBuf>,
}

impl Store {
    /// A store in `<state_dir>/check-runs` (created mode 0700), or in memory only (`None`, or
    /// when the directory cannot be used, with a warning).
    pub fn open(state_dir: Option<&Path>) -> Self {
        let Some(state_dir) = state_dir else {
            return Self::default();
        };
        let dir = state_dir.join("check-runs");
        match crate::queue::ensure_private_dir(&dir) {
            Ok(()) => Self { dir: Some(dir) },
            Err(e) => {
                tracing::warn!(dir = %dir.display(), error = %e, "check-run state is kept in memory only: a restart may re-send or miss a check run's completion");
                Self::default()
            }
        }
    }

    fn path(&self, repo_id: &str) -> Option<PathBuf> {
        // Repo ids are base58; anything else is not a file name this store writes.
        if repo_id.is_empty() || !repo_id.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return None;
        }
        self.dir.as_ref().map(|d| d.join(format!("{repo_id}.json")))
    }

    /// The repo's saved state (empty when there is none or it cannot be read).
    pub fn load(&self, repo_id: &str) -> Saved {
        let Some(path) = self.path(repo_id) else {
            return Saved::default();
        };
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                tracing::warn!(file = %path.display(), error = %e, "ignoring unreadable check-run state");
                Saved::default()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Saved::default(),
            Err(e) => {
                tracing::warn!(file = %path.display(), error = %e, "ignoring unreadable check-run state");
                Saved::default()
            }
        }
    }

    /// Save the repo's state (durably: a temp file, synced, renamed). Off the async threads.
    pub async fn save(&self, repo_id: &str, saved: &Saved) {
        let (Some(dir), Some(_)) = (self.dir.clone(), self.path(repo_id)) else {
            return;
        };
        let bytes = match serde_json::to_vec(saved) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(repo = %repo_id, error = %e, "cannot serialize check-run state");
                return;
            }
        };
        let id = repo_id.to_string();
        let done =
            tokio::task::spawn_blocking(move || crate::queue::write_entry(&dir, &id, &bytes)).await;
        if let Ok(Err(e)) | Err(e) = done.map_err(std::io::Error::other) {
            tracing::warn!(repo = %repo_id, error = %e, "cannot save check-run state; a restart may re-send check runs");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::platform::FieldValue;

    fn run(id: &str, created: u64, rev: u64, status: &str) -> FetchedDocument {
        FetchedDocument {
            id: id.into(),
            owner_id: "RUNNER".into(),
            created_at: Some(created),
            created_at_block_height: None,
            updated_at_block_height: None,
            revision: Some(rev),
            fields: BTreeMap::from([
                ("headOid".into(), FieldValue::bytes(vec![0xab; 20])),
                ("name".into(), FieldValue::text("build")),
                ("status".into(), FieldValue::text(status)),
            ]),
        }
    }

    fn actions(out: &[(CheckRunAction, &FetchedDocument)]) -> Vec<(CheckRunAction, String)> {
        out.iter().map(|(a, d)| (*a, d.id.clone())).collect()
    }

    /// [`diff`] over one document, as `(action, delivery key)` pairs and the new state.
    fn step(
        prev: &HeadRuns,
        doc: FetchedDocument,
        since: u64,
    ) -> (Vec<(CheckRunAction, String)>, HeadRuns) {
        let docs = [doc];
        let (out, next) = diff(prev, &docs, since);
        let out = out.iter().map(|(a, d)| (*a, event_key(d, *a))).collect();
        (out, next)
    }

    /// The runner's lifecycle: queued, replaced with in_progress, replaced with completed.
    /// Before this fix the relay read `$createdAt > cursor` and saw only the first state.
    #[test]
    fn a_run_replaced_in_place_is_delivered_created_then_completed() {
        use CheckRunAction::{Completed, Created};
        let (out, s1) = step(&HeadRuns::new(), run("A", 10, 1, "queued"), 5);
        assert_eq!(out, vec![(Created, "A".into())]);

        let (out, s2) = step(&s1, run("A", 10, 2, "in_progress"), 5);
        assert!(
            out.is_empty(),
            "in_progress has no GitHub action of its own"
        );

        let (out, s3) = step(&s2, run("A", 10, 3, "completed"), 5);
        assert_eq!(out, vec![(Completed, "A:completed:3".into())]);

        let (out, _) = step(&s3, run("A", 10, 4, "completed"), 5);
        assert!(
            out.is_empty(),
            "an edit of a completed run is not a new completion"
        );
        let (out, _) = step(&s3, run("A", 10, 3, "completed"), 5);
        assert!(out.is_empty(), "the same read again sends nothing");
    }

    #[test]
    fn a_run_created_completed_sends_both_actions() {
        use CheckRunAction::{Completed, Created};
        let docs = [run("B", 10, 1, "completed"), run("A", 9, 1, "queued")];
        let (out, _) = diff(&HeadRuns::new(), &docs, 0);
        assert_eq!(
            actions(&out),
            vec![
                (Created, "A".into()),
                (Created, "B".into()),
                (Completed, "B".into())
            ],
            "oldest document first"
        );
        assert_ne!(
            event_key(out[1].1, Created),
            event_key(out[2].1, Completed),
            "distinct delivery ids"
        );
    }

    #[test]
    fn runs_before_the_baseline_are_recorded_and_their_later_completion_is_sent() {
        let (out, s) = step(&HeadRuns::new(), run("A", 10, 1, "queued"), 50);
        assert!(out.is_empty(), "created before the baseline: not replayed");
        let (out, _) = step(&s, run("A", 10, 2, "completed"), 50);
        assert_eq!(
            out,
            vec![(CheckRunAction::Completed, "A:completed:2".into())]
        );
    }

    #[test]
    fn a_lagging_read_does_not_regress_or_resend() {
        let (_, s) = step(&HeadRuns::new(), run("A", 10, 3, "completed"), 0);
        let (out, s2) = step(&s, run("A", 10, 2, "in_progress"), 0);
        assert!(out.is_empty());
        assert_eq!(
            s2["A"],
            RunSeen {
                rev: 3,
                done: true,
                at: 10
            }
        );
        let (out, _) = step(&s2, run("A", 10, 3, "completed"), 0);
        assert!(out.is_empty(), "no second completed after the lag");
    }

    #[test]
    fn a_run_completed_again_after_a_rerun_is_delivered_again() {
        let (_, s) = step(&HeadRuns::new(), run("A", 10, 1, "completed"), 0);
        let (out, s) = step(&s, run("A", 10, 2, "queued"), 0);
        assert!(out.is_empty());
        let (out, _) = step(&s, run("A", 10, 3, "completed"), 0);
        assert_eq!(
            out,
            vec![(CheckRunAction::Completed, "A:completed:3".into())]
        );
    }

    /// A run missing from one read (a lagging node, or past the newest page) is remembered,
    /// so it is not announced as new when it reappears; the memory per head is bounded.
    #[test]
    fn a_run_missing_from_a_read_is_not_announced_again() {
        let (_, s) = step(&HeadRuns::new(), run("A", 10, 1, "queued"), 0);
        let (out, s) = step(&s, run("B", 11, 1, "queued"), 0);
        assert_eq!(out.len(), 1);
        assert!(s.contains_key("A"), "A is still remembered");
        let (out, _) = step(&s, run("A", 10, 1, "queued"), 0);
        assert!(out.is_empty());

        let many: Vec<FetchedDocument> = (0..MAX_RUNS_PER_HEAD as u64 + 5)
            .map(|i| run(&format!("r{i:04}"), i, 1, "queued"))
            .collect();
        let (_, s) = diff(&HeadRuns::new(), &many, 0);
        assert_eq!(s.len(), MAX_RUNS_PER_HEAD);
        assert!(!s.contains_key("r0000"), "the oldest are forgotten");
    }

    /// A restart must not re-send: the state survives in the state dir.
    #[tokio::test]
    async fn state_survives_a_restart() {
        let base = std::env::temp_dir().join(format!("relay-checkruns-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let repo = "5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX";
        let (_, runs) = step(&HeadRuns::new(), run("A", 10, 2, "in_progress"), 0);
        let saved = Saved {
            heads: BTreeMap::from([("ab".repeat(20), SavedHead { seen: 7, runs })]),
        };
        Store::open(Some(&base)).save(repo, &saved).await;

        let loaded = Store::open(Some(&base)).load(repo);
        assert_eq!(loaded, saved);
        let prev = &loaded.heads[&"ab".repeat(20)].runs;
        let (out, _) = step(prev, run("A", 10, 2, "in_progress"), 0);
        assert!(out.is_empty(), "nothing re-sent after the restart");
        let (out, _) = step(prev, run("A", 10, 3, "completed"), 0);
        assert_eq!(
            out.len(),
            1,
            "a completion while the relay was down is sent"
        );

        assert_eq!(Store::open(None).load(repo), Saved::default());
        assert_eq!(
            Store::open(Some(&base)).load("../x"),
            Saved::default(),
            "not a file name"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
