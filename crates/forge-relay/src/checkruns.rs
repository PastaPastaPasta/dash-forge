//! In-place `checkRun` updates (platform-parity spec §2.10, D-604 area).
//!
//! A `checkRun` is mutable: a runner creates it `queued`, then replaces the same document with
//! `in_progress`, then `completed`. A replace keeps `$createdAt`, so the relay's usual streams
//! (`$createdAt > cursor`) never see it, and there is no `$updatedAt` index to read instead.
//! So for each watched head the relay reads `checkRun (repoId, headOid, $createdAt >= t)`
//! every cycle (at most [`MAX_PAGES`] pages) and compares each document's `$revision` with the
//! one it saw last ([`diff`]). `t` is [`read_from`]: the head's oldest open run, else its
//! newest run, but never past its newest [`MAX_RUNS_PER_HEAD`]. So a run is re-read until it
//! completes (even with hundreds of runs after it), and a quiet head costs one short page.
//! A completed run is not re-read: a re-run is a new `checkRun` document, as on GitHub (where
//! re-running a check creates a new check run).
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
//! While no hook of the repo wants `check_run` (or the repo is no longer served), what was
//! seen is dropped, so a hook added later is not sent completions from before it existed: a
//! run already open when the hook is added is never read, so its `completed` is not sent.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use forge_core::platform::FetchedDocument;

use crate::error::Result;
use crate::ingest::PageSource;
use crate::payload::CheckRunAction;

/// Rows per page (Drive's maximum).
const PAGE: u32 = 100;

/// Pages read per head and cycle. A head with more new runs catches up over several cycles.
const MAX_PAGES: usize = 5;

/// A head's read never reaches back past its newest this many runs: an open run older than
/// that (a runner that died) is given up, and its completion is not sent. Bounds a head's
/// memory, and leaves at least one of the [`MAX_PAGES`] for runs not seen yet, so a burst of
/// new runs is caught up with over the next cycles.
const MAX_RUNS_PER_HEAD: usize = (MAX_PAGES - 1) * PAGE as usize;

/// What the relay last saw of one `checkRun` document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunSeen {
    /// Its `$revision`.
    pub rev: u64,
    /// Whether its status was `completed`.
    pub done: bool,
    /// Its `$createdAt` (ms).
    pub at: u64,
    /// Absent from the last read that covered it (deleted, or a lagging node): remembered, so
    /// it is not announced again if it reappears, but no longer holding the read's start.
    #[serde(default)]
    pub missing: bool,
}

/// One watched head's runs, by document id.
pub type HeadRuns = BTreeMap<String, RunSeen>;

/// A `checkRun`'s status is `completed` (a document without one counts as completed, as
/// [`crate::ingest::translate_check_run`] reports it).
fn is_done(d: &FetchedDocument) -> bool {
    d.field_str("status").is_none_or(|s| s == "completed")
}

/// Where a head's next read starts (`$createdAt >=`): its oldest open run (not completed, not
/// missing), else its newest run, but never before its newest [`MAX_RUNS_PER_HEAD`]. `floor`
/// (the head's baseline) for a head with no run yet.
pub fn read_from(prev: &HeadRuns, floor: u64) -> u64 {
    let mut ats: Vec<u64> = prev.values().map(|r| r.at).collect();
    if ats.is_empty() {
        return floor;
    }
    ats.sort_unstable_by(|a, b| b.cmp(a));
    let open = prev
        .values()
        .filter(|r| !r.done && !r.missing)
        .map(|r| r.at)
        .min()
        .unwrap_or(ats[0]);
    let limit = ats.get(MAX_RUNS_PER_HEAD - 1).copied().unwrap_or(0);
    open.max(limit)
}

/// A head's runs created at or after `from`, ascending (`source` is the head's
/// `checkRun (repoId, headOid)` index): up to [`MAX_PAGES`] pages, fewer once `stop()` says
/// so (the poll's deadline). A cut-short read is a complete prefix of the index, which is
/// all [`diff`] needs; the next cycle continues from it. Pages continue after the previous
/// page's last document, fetched a moment earlier; a failed read is retried whole next cycle.
pub async fn read_runs(
    source: &impl PageSource,
    from: u64,
    stop: impl Fn() -> bool,
) -> Result<Vec<FetchedDocument>> {
    let mut out = Vec::new();
    for _ in 0..MAX_PAGES {
        let after = out.last().map(|d: &FetchedDocument| d.id.clone());
        let page = source
            .page(Some(from), true, PAGE, after.as_deref())
            .await?;
        let full = page.len() >= PAGE as usize;
        out.extend(page);
        if !full || stop() {
            break;
        }
    }
    Ok(out)
}

/// Compare a head's runs read from `from` on (`docs`, any order, the complete read of
/// [`read_runs`]) with what was seen (`prev`). Returns the events to send, oldest document
/// first, and the new state for the head. `since` is the head's baseline: an unseen document
/// created before it is recorded, not delivered. A read older than what was seen (a lagging
/// node) keeps the newer state and sends nothing. A run the read covered but did not return,
/// while it returned a run created later (so the node has the block that created it), was
/// deleted: it is marked missing. A lagging node that has not reached a run's block marks
/// nothing. The new state keeps exactly the runs the next read covers ([`read_from`]), so a
/// run is never forgotten while it can still be read, and never read again once forgotten.
pub fn diff<'a>(
    prev: &HeadRuns,
    docs: &'a [FetchedDocument],
    since: u64,
    from: u64,
) -> (Vec<(CheckRunAction, &'a FetchedDocument)>, HeadRuns) {
    let mut docs: Vec<&FetchedDocument> = docs.iter().filter(|d| d.created_at.is_some()).collect();
    docs.sort_by_key(|d| (d.created_at, &d.id));
    let mut out = Vec::new();
    let mut next = prev.clone();
    // `$createdAt` is block time, which only increases: a node that returned a run created at
    // `t` has every block before `t`.
    let reached = docs.last().and_then(|d| d.created_at).unwrap_or(0);
    for r in next.values_mut().filter(|r| r.at >= from && r.at < reached) {
        r.missing = true;
    }
    for d in docs {
        let now = RunSeen {
            rev: d.revision.unwrap_or(1),
            done: is_done(d),
            at: d.created_at.unwrap_or(0),
            missing: false,
        };
        match prev.get(&d.id) {
            // A lagging read: keep the newer state (it is present, so not missing).
            Some(seen) if now.rev < seen.rev => {
                next.insert(
                    d.id.clone(),
                    RunSeen {
                        missing: false,
                        ..*seen
                    },
                );
                continue;
            }
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
    let keep_from = read_from(&next, since);
    next.retain(|_, r| r.at >= keep_from);
    (out, next)
}

/// The dedup key (the `X-GitHub-Delivery` seed) of a check-run event: the document id for
/// `created`, and the id plus the revision seen completed for `completed`. forge-community's
/// `checkRun` is monotonic (a completed run cannot go back to `queued`, and its completion
/// fields are set once), so a second completion of one document cannot happen on the current
/// contracts; a contract without those rules could replace a run back and complete it again,
/// and the revision keeps that a separate delivery. Relays that see the same revision derive
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

    /// Forget the repo's state (it is no longer served).
    pub fn remove(&self, repo_id: &str) {
        let Some(path) = self
            .dir_for(repo_id)
            .map(|d| d.join(format!("{repo_id}.json")))
        else {
            return;
        };
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                tracing::warn!(file = %path.display(), error = %e, "cannot remove check-run state");
            }
            _ => {}
        }
    }

    /// Save the repo's state (durably: a temp file, synced, renamed). Off the async threads.
    /// Returns whether the state is where it should be: written, or nothing to write (an
    /// in-memory store). `false` after a failure, so the caller retries next cycle.
    pub async fn save(&self, repo_id: &str, saved: &Saved) -> bool {
        let Some(dir) = self.dir_for(repo_id).map(Path::to_path_buf) else {
            return true;
        };
        let bytes = match serde_json::to_vec(saved) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(repo = %repo_id, error = %e, "cannot serialize check-run state");
                return false;
            }
        };
        let id = repo_id.to_string();
        let done =
            tokio::task::spawn_blocking(move || crate::queue::write_entry(&dir, &id, &bytes)).await;
        if let Err(e) = done.map_err(std::io::Error::other).flatten() {
            tracing::warn!(repo = %repo_id, error = %e, "cannot save check-run state; retrying next cycle (a restart meanwhile may re-send check runs)");
            return false;
        }
        true
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
            updated_at: None,
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
        let (out, next) = diff(prev, &docs, since, read_from(prev, since));
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
        let (out, _) = diff(&HeadRuns::new(), &docs, 0, 0);
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
                at: 10,
                missing: false
            }
        );
        let (out, _) = step(&s2, run("A", 10, 3, "completed"), 0);
        assert!(out.is_empty(), "no second completed after the lag");
    }

    /// The head's newest run is still read after it completes. forge-community refuses a
    /// replace back to `queued` (`doneIfCompletedAt`, set-once `completedAt`); against a
    /// contract that allowed one, a second completion is seen with its own delivery id.
    #[test]
    fn a_newest_run_completed_again_is_delivered_again() {
        let (_, s) = step(&HeadRuns::new(), run("A", 10, 1, "completed"), 0);
        let (out, s) = step(&s, run("A", 10, 2, "queued"), 0);
        assert!(out.is_empty());
        let (out, _) = step(&s, run("A", 10, 3, "completed"), 0);
        assert_eq!(
            out,
            vec![(CheckRunAction::Completed, "A:completed:3".into())]
        );
    }

    /// An open run a complete read no longer returns (while it returns a later one) was
    /// deleted: it stops holding the read's start, and is not read, nor announced, again.
    #[test]
    fn a_deleted_open_run_is_let_go() {
        let (_, s) = step(&HeadRuns::new(), run("A", 10, 1, "queued"), 0);
        assert_eq!(read_from(&s, 0), 10);
        let (out, s) = step(&s, run("B", 11, 1, "completed"), 0);
        assert_eq!(out.len(), 2, "B created and completed");
        assert!(!s.contains_key("A"), "A is let go");
        assert_eq!(read_from(&s, 0), 11, "and no longer holds the start");
    }

    #[test]
    fn a_head_is_read_from_its_oldest_open_run() {
        assert_eq!(read_from(&HeadRuns::new(), 42), 42, "no run: the baseline");
        let seen = |at, done| RunSeen {
            rev: 1,
            done,
            at,
            missing: false,
        };
        let s = HeadRuns::from([
            ("A".into(), seen(10, true)),
            ("B".into(), seen(20, false)),
            ("C".into(), seen(30, true)),
        ]);
        assert_eq!(read_from(&s, 0), 20, "the oldest open run");
        let mut s: HeadRuns = (0..300)
            .map(|i| (format!("r{i:03}"), seen(100 + i, true)))
            .collect();
        assert_eq!(read_from(&s, 0), 399, "all completed: the newest run");
        s.insert("open".into(), seen(50, false));
        assert_eq!(read_from(&s, 0), 50, "an open run behind them");
        s.get_mut("open").unwrap().missing = true;
        assert_eq!(read_from(&s, 0), 399, "a missing run no longer holds it");
        s.get_mut("open").unwrap().missing = false;
        s.extend((0..300).map(|i| (format!("s{i:03}"), seen(1000 + i, true))));
        assert_eq!(
            read_from(&s, 0),
            300,
            "never past the newest 400 (of 601): the 300 newer ones, then r399..r300"
        );
    }

    /// A node that has not reached the blocks of a head's runs returns fewer: that is not a
    /// deletion, so an open run behind many newer ones is kept and its completion still sent.
    #[tokio::test]
    async fn a_lagging_read_does_not_drop_an_open_run() {
        let mut rows = vec![run("open", 1, 1, "queued")];
        rows.extend((0..150).map(|i| run(&format!("n{i:03}"), 10 + i, 1, "completed")));
        let (_, s) = cycle(
            &Index(rows.clone(), std::cell::Cell::default()),
            &HeadRuns::new(),
        )
        .await;
        // A node at a block before any of them: nothing.
        let (out, s) = cycle(&Index(Vec::new(), std::cell::Cell::default()), &s).await;
        assert!(out.is_empty());
        assert!(
            s.contains_key("open") && !s["open"].missing,
            "not taken for deleted"
        );
        // A node that has only the first few blocks.
        let partial: Vec<FetchedDocument> = rows.iter().take(5).cloned().collect();
        let (out, s) = cycle(&Index(partial, std::cell::Cell::default()), &s).await;
        assert!(out.is_empty());
        assert!(!s["open"].missing && !s["n100"].missing);
        rows[0] = run("open", 1, 2, "completed");
        let (out, _) = cycle(&Index(rows, std::cell::Cell::default()), &s).await;
        assert_eq!(
            out,
            vec![(CheckRunAction::Completed, "open:completed:2".into())]
        );
    }

    /// The relay's cycle over an in-memory index: read from [`read_from`], then [`diff`].
    async fn cycle(index: &Index, prev: &HeadRuns) -> (Vec<(CheckRunAction, String)>, HeadRuns) {
        let from = read_from(prev, 0);
        let docs = read_runs(index, from, || false).await.unwrap();
        let (out, next) = diff(prev, &docs, 0, from);
        let out = out.iter().map(|(a, d)| (*a, event_key(d, *a))).collect();
        (out, next)
    }

    /// Review findings: a head with many runs is read in bounded pages and nothing is sent
    /// twice (not even runs forgotten past the bound), and a deleted open run does not pin
    /// the read.
    #[tokio::test]
    async fn repeated_cycles_send_each_change_once() {
        let mut rows = vec![run("open", 1, 1, "queued")];
        rows.extend((0..700).map(|i| run(&format!("n{i:03}"), 10 + i, 1, "completed")));
        let index = Index(rows, std::cell::Cell::new(0));
        let mut s = HeadRuns::new();
        let mut sent = BTreeMap::<String, usize>::new();
        for _ in 0..6 {
            index.1.set(0);
            let (out, next) = cycle(&index, &s).await;
            assert!(index.1.get() <= MAX_PAGES, "pages per cycle are capped");
            assert!(next.len() <= MAX_RUNS_PER_HEAD + PAGE as usize);
            for (_, key) in out {
                *sent.entry(key).or_default() += 1;
            }
            s = next;
        }
        assert!(sent.values().all(|n| *n == 1), "each event once");
        assert!(
            sent.contains_key("n699:completed:1"),
            "caught up to the end"
        );
        let (out, _) = cycle(&index, &s).await;
        assert!(out.is_empty());

        // A deleted open run: marked missing, then no longer holds the read's start.
        let mut rows = index.0.clone();
        rows.push(run("late-open", 800, 1, "queued"));
        rows.push(run("later", 801, 1, "completed"));
        let (_, s) = cycle(&Index(rows.clone(), std::cell::Cell::default()), &s).await;
        rows.retain(|d| d.id != "late-open");
        let (_, s) = cycle(&Index(rows.clone(), std::cell::Cell::default()), &s).await;
        assert!(!s.contains_key("late-open"), "let go");
        assert_eq!(read_from(&s, 0), 801);
        let quiet = Index(rows, std::cell::Cell::default());
        let (out, _) = cycle(&quiet, &s).await;
        assert!(out.is_empty());
        assert_eq!(
            quiet.1.get(),
            1,
            "one page: the deleted run does not pin the read"
        );
    }

    /// A read cut short by the deadline is a complete prefix: the next cycle continues it.
    #[tokio::test]
    async fn a_read_cut_short_continues_next_cycle() {
        let rows: Vec<FetchedDocument> = (0..250)
            .map(|i| run(&format!("n{i:03}"), 10 + i, 1, "queued"))
            .collect();
        let index = Index(rows, std::cell::Cell::new(0));
        let docs = read_runs(&index, 0, || true).await.unwrap();
        assert_eq!(
            (docs.len(), index.1.get()),
            (100, 1),
            "stopped after a page"
        );
        let (out, s) = diff(&HeadRuns::new(), &docs, 0, 0);
        assert_eq!(out.len(), 100);
        let (out, _) = cycle(&index, &s).await;
        assert_eq!(out.len(), 150, "the rest, once");
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
        let docs = read_runs(&index, 0, || false).await.unwrap();
        assert_eq!(docs.len(), 251, "paged to the end");
        assert_eq!(index.1.get(), 3);
        let (out, s) = diff(&HeadRuns::new(), &docs, 0, 0);
        assert_eq!(out.len(), 1 + 2 * 250);

        let mut rows = index.0;
        rows[0] = run("old", 1, 2, "completed");
        let index = Index(rows, std::cell::Cell::new(0));
        let (out, s) = cycle(&index, &s).await;
        assert_eq!(
            out,
            vec![(CheckRunAction::Completed, "old:completed:2".into())]
        );

        // Once all are completed, a head costs one short page (from its newest run).
        let index = Index(index.0, std::cell::Cell::new(0));
        let (out, _) = cycle(&index, &s).await;
        assert!(out.is_empty());
        assert_eq!(index.1.get(), 1);
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
        assert!(Store::open(Some(&base)).save(repo, &saved).await);

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
