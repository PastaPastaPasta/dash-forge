//! In-place `checkRun` updates (platform-parity spec §2.10, D-604 area).
//!
//! A `checkRun` is mutable: a runner creates it `queued`, then replaces the same document with
//! `in_progress`, then `completed`. A replace keeps `$createdAt`, so the relay's usual streams
//! (`$createdAt > cursor`) never see it, and there is no `$updatedAt` index to read instead.
//! So for each watched head the relay reads `checkRun (repoId, headOid, $createdAt >= t)`
//! every cycle, paged to the end, and compares each document's `$revision` with the one it saw
//! last ([`diff`]). `t` is [`read_from`]: the oldest run not yet seen completed, else the
//! newest run seen. A head whose runs have all completed costs one short page, and a run is
//! re-read until it completes, however many runs came after it.
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
//! While no hook of the repo wants `check_run`, what was seen is dropped, so a hook added
//! later is not sent completions from before it existed.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use forge_core::platform::FetchedDocument;

use crate::error::Result;
use crate::ingest::PageSource;
use crate::payload::CheckRunAction;

/// Rows per page (Drive's maximum).
const PAGE: u32 = 100;

/// Runs remembered per head: those seen completed are forgotten first, oldest first. A run
/// missing from a read (deleted, or a lagging node) stays remembered, so it is not announced
/// again if it reappears.
const MAX_RUNS_PER_HEAD: usize = 500;

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
fn is_done(d: &FetchedDocument) -> bool {
    d.field_str("status").is_none_or(|s| s == "completed")
}

/// Keep the `max` entries of `map` that sort last by `rank` (ties: the larger key stays).
pub fn keep_last<V, R: Ord>(map: &mut BTreeMap<String, V>, max: usize, rank: impl Fn(&V) -> R) {
    if map.len() <= max {
        return;
    }
    let mut ranked: Vec<(R, String)> = map.iter().map(|(k, v)| (rank(v), k.clone())).collect();
    ranked.sort();
    for (_, k) in &ranked[..map.len() - max] {
        map.remove(k);
    }
}

/// Where a head's next read starts (`$createdAt >=`): the oldest run not seen completed, else
/// the newest run seen, else `floor` (the head's baseline) for a head with no run yet.
pub fn read_from(prev: &HeadRuns, floor: u64) -> u64 {
    prev.values()
        .filter(|r| !r.done)
        .map(|r| r.at)
        .min()
        .or_else(|| prev.values().map(|r| r.at).max())
        .unwrap_or(floor)
}

/// A head's runs created at or after `from`, ascending, paged to the end (`source` is the
/// head's `checkRun (repoId, headOid)` index). Pages continue after the previous page's last
/// document, fetched a moment earlier; a failed read is retried whole next cycle.
pub async fn read_runs(source: &impl PageSource, from: u64) -> Result<Vec<FetchedDocument>> {
    let mut out = Vec::new();
    loop {
        let after = out.last().map(|d: &FetchedDocument| d.id.clone());
        let page = source
            .page(Some(from), true, PAGE, after.as_deref())
            .await?;
        let full = page.len() >= PAGE as usize;
        out.extend(page);
        if !full {
            return Ok(out);
        }
    }
}

/// Compare a head's current runs (`docs`, any order) with what was seen (`prev`). Returns the
/// events to send, oldest document first, and the new state for the head. `since` is the
/// head's baseline: an unseen document created before it is recorded, not delivered. A read
/// older than what was seen (a lagging node) keeps the newer state and sends nothing. Runs
/// absent from `docs` stay remembered (at most [`MAX_RUNS_PER_HEAD`]).
pub fn diff<'a>(
    prev: &HeadRuns,
    docs: &'a [FetchedDocument],
    since: u64,
) -> (Vec<(CheckRunAction, &'a FetchedDocument)>, HeadRuns) {
    let mut docs: Vec<&FetchedDocument> = docs.iter().filter(|d| d.created_at.is_some()).collect();
    docs.sort_by_key(|d| (d.created_at, &d.id));
    let mut out = Vec::new();
    let mut next = prev.clone();
    for d in docs {
        let now = RunSeen {
            rev: d.revision.unwrap_or(1),
            done: is_done(d),
            at: d.created_at.unwrap_or(0),
        };
        match prev.get(&d.id) {
            // A lagging read: `next` already holds the newer state.
            Some(seen) if now.rev < seen.rev => continue,
            Some(seen) => {
                if now.rev > seen.rev && now.done && !seen.done {
                    out.push((CheckRunAction::Completed, d));
                }
            }
            None if now.at >= since => {
                out.push((CheckRunAction::Created, d));
                if now.done {
                    out.push((CheckRunAction::Completed, d));
                }
            }
            None => {}
        }
        next.insert(d.id.clone(), now);
    }
    keep_last(&mut next, MAX_RUNS_PER_HEAD, |r| (!r.done, r.at));
    (out, next)
}

/// The dedup key (the `X-GitHub-Delivery` seed) of a check-run event: the document id for
/// `created`, and the id plus the revision seen completed for `completed`, so a run that
/// completes again after a re-run is delivered again. Relays that see the same revision derive
/// the same key; a completed run edited between two relays' reads can reach a receiver twice
/// (the payloads are the same run: dedupe on `check_run.id` and `status` too).
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

    /// The directory, when `repo_id` can name a file in it: repo ids are base58, and anything
    /// else is not a file name this store reads or writes.
    fn dir_for(&self, repo_id: &str) -> Option<&Path> {
        let ok = !repo_id.is_empty() && repo_id.bytes().all(|b| b.is_ascii_alphanumeric());
        self.dir.as_deref().filter(|_| ok)
    }

    /// The repo's saved state (empty when there is none or it cannot be read).
    pub fn load(&self, repo_id: &str) -> Saved {
        let Some(path) = self
            .dir_for(repo_id)
            .map(|d| d.join(format!("{repo_id}.json")))
        else {
            return Saved::default();
        };
        let read = std::fs::read(&path)
            .and_then(|b| serde_json::from_slice(&b).map_err(std::io::Error::from));
        match read {
            Ok(saved) => saved,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Saved::default(),
            Err(e) => {
                tracing::warn!(file = %path.display(), error = %e, "ignoring unreadable check-run state");
                Saved::default()
            }
        }
    }

    /// Save the repo's state (durably: a temp file, synced, renamed). Off the async threads.
    pub async fn save(&self, repo_id: &str, saved: &Saved) {
        let Some(dir) = self.dir_for(repo_id).map(Path::to_path_buf) else {
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
        if let Err(e) = done.map_err(std::io::Error::other).flatten() {
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

        // Bounded: completed runs are forgotten first, oldest first; open ones are kept.
        let many: Vec<FetchedDocument> = (0..MAX_RUNS_PER_HEAD as u64 + 5)
            .map(|i| {
                let status = if i == 0 { "queued" } else { "completed" };
                run(&format!("r{i:04}"), i, 1, status)
            })
            .collect();
        let (_, s) = diff(&HeadRuns::new(), &many, 0);
        assert_eq!(s.len(), MAX_RUNS_PER_HEAD);
        assert!(s.contains_key("r0000"), "the open run is kept");
        assert!(!s.contains_key("r0001"), "the oldest completed one goes");
    }

    #[test]
    fn a_head_is_read_from_its_oldest_open_run() {
        assert_eq!(read_from(&HeadRuns::new(), 42), 42, "no run: the baseline");
        let (_, s) = step(&HeadRuns::new(), run("A", 10, 1, "completed"), 0);
        let (_, s) = step(&s, run("B", 20, 1, "queued"), 0);
        let (_, s) = step(&s, run("C", 30, 1, "completed"), 0);
        assert_eq!(read_from(&s, 0), 20, "the oldest run not completed");
        let (_, s) = step(&s, run("B", 20, 2, "completed"), 0);
        assert_eq!(read_from(&s, 0), 30, "all completed: the newest run seen");
    }

    /// An in-memory `checkRun (repoId, headOid, $createdAt)` index.
    struct Index(Vec<FetchedDocument>, std::cell::Cell<usize>);

    #[allow(clippy::unused_async_trait_impl)]
    impl PageSource for Index {
        async fn page(
            &self,
            since: Option<u64>,
            ascending: bool,
            limit: u32,
            start_after: Option<&str>,
        ) -> Result<Vec<FetchedDocument>> {
            assert!(ascending);
            self.1.set(self.1.get() + 1);
            let mut rows: Vec<&FetchedDocument> = self
                .0
                .iter()
                .filter(|d| since.is_none_or(|s| d.created_at.unwrap() >= s))
                .collect();
            rows.sort_by_key(|d| (d.created_at, &d.id));
            let skip = start_after
                .and_then(|a| rows.iter().position(|d| d.id == a))
                .map_or(0, |i| i + 1);
            Ok(rows
                .into_iter()
                .skip(skip)
                .take(limit as usize)
                .cloned()
                .collect())
        }
    }

    /// Before, a head's read was its newest 100 runs: in a matrix of more, the older runs
    /// never showed up again, so their completion was never sent.
    #[tokio::test]
    async fn an_open_run_behind_more_than_a_page_of_newer_runs_still_completes() {
        let mut rows = vec![run("old", 1, 1, "queued")];
        rows.extend((0..250).map(|i| run(&format!("n{i:03}"), 10 + i, 1, "completed")));
        let index = Index(rows, std::cell::Cell::new(0));
        let docs = read_runs(&index, 0).await.unwrap();
        assert_eq!(docs.len(), 251, "paged to the end");
        assert_eq!(index.1.get(), 3);
        let (out, s) = diff(&HeadRuns::new(), &docs, 0);
        assert_eq!(out.len(), 1 + 2 * 250);

        let mut rows = index.0;
        rows[0] = run("old", 1, 2, "completed");
        let index = Index(rows, std::cell::Cell::new(0));
        let docs = read_runs(&index, read_from(&s, 0)).await.unwrap();
        let (out, _) = diff(&s, &docs, 0);
        assert_eq!(
            actions(&out),
            vec![(CheckRunAction::Completed, "old".into())]
        );

        // Once all are completed, a head costs one short page.
        let (_, s) = diff(&s, &docs, 0);
        let index = Index(index.0, std::cell::Cell::new(0));
        let docs = read_runs(&index, read_from(&s, 0)).await.unwrap();
        assert_eq!((docs.len(), index.1.get()), (1, 1));
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
