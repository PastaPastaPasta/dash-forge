//! The pipelined write phase: issue and PR creates strictly in order, each item's dependent
//! writes (comments, reviews, labels, state) in bounded parallel lanes.
//!
//! **Why this split.** Forge numbers issues and PRs densely (forge-v2 §6.2: `number ==
//! countOf(issue) + countOf(patch) + 1`), so the creates are one sequence in upstream order,
//! each confirmed before the next ([`run`]'s *head*). Everything else about an item names only
//! the item itself: a comment or review `refersTo` its target (plus `lockGate`, which reads the
//! target's own lock transitions), a label event its target, and a transition's `c1`–`c6`
//! rules read the same target's earlier transitions. None of them moves the count the next
//! create is numbered by. So once item N is confirmed on chain, its *job* (the rest of its
//! writes) can run while N+1… are created.
//!
//! **Order kept.** Each job runs its writes one at a time, in the order the sequential run
//! wrote them: comments (source order), reviews (source order), label events, transitions.
//! Readers order a thread's timeline by `$createdAt`, the state rules need a target's
//! transitions in order, and L-46 puts the state after the thread; one job per item keeps all
//! three. Jobs of different items run in up to `lanes` lanes at once.
//!
//! **Stopping.** The first error that is not about one item (the spend cap, a network error)
//! stops the head from creating more and every lane from starting another write
//! ([`Stop::check`]); writes already in flight finish, so what landed is counted and paid for
//! before the run reports. That error is the run's.
//!
//! `lanes == 1` is the sequential run: create, then that item's writes, then the next item.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use anyhow::Result;
use futures::channel::mpsc;
use futures::{SinkExt as _, StreamExt as _};

/// The default number of lanes: the window git-remote-dash's chunk upload has run at on every
/// network since spike S0.1 (`forge_core::backends::platform::PIPELINE_WINDOW`).
pub const DEFAULT_LANES: usize = forge_core::backends::platform::PIPELINE_WINDOW;

/// The most lanes a run may use.
///
/// Every write signs with its own identity-contract nonce (the SDK's nonce cache hands them
/// out under a lock), and Drive accepts them out of order, but only within 24 of the highest
/// that has landed (`MAX_MISSING_IDENTITY_REVISIONS`). A write that stalls (dropped from a
/// mempool, waiting out a quorum rotation) while 24 later ones land can no longer land with
/// its nonce: forge-core's write loop then finds its document absent by id and signs it
/// again with a new nonce (`create_attempts`, up to three times), so a stall costs time, not
/// a document, and never lands one twice. More lanes make that likelier, and the process's DAPI
/// pacing (8 requests a second) caps the useful number near [`DEFAULT_LANES`] anyway.
pub const MAX_LANES: usize = 16;

/// Parse a lane count (`--concurrency`): 1..=[`MAX_LANES`].
pub fn parse_lanes(s: &str) -> Result<usize, String> {
    match s.parse::<usize>() {
        Ok(n) if (1..=MAX_LANES).contains(&n) => Ok(n),
        _ => Err(format!("expected a number from 1 to {MAX_LANES}")),
    }
}

/// Items the head may place ahead of the lanes, per lane. A crash leaves at most this many
/// items created with their threads unwritten; the next run finds them on chain and finishes
/// them.
const QUEUE_PER_LANE: usize = 4;

/// Lock `m`, recovering from a panic elsewhere (the state is plain data).
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a lane gets once the run is stopping: it starts no new write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stopped;

impl std::fmt::Display for Stopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("stopping: an earlier write failed")
    }
}

impl std::error::Error for Stopped {}

/// The stop signal shared by the head and the lanes, and the error that raised it.
#[derive(Debug, Default)]
pub struct Stop {
    stopped: AtomicBool,
    first: Mutex<Option<anyhow::Error>>,
}

impl Stop {
    /// Whether the run is stopping.
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Refuse to start another write once the run is stopping.
    pub fn check(&self) -> Result<()> {
        if self.is_stopped() {
            return Err(Stopped.into());
        }
        Ok(())
    }

    /// Stop the run with `e`; the first error is the one reported.
    pub fn fail(&self, e: anyhow::Error) {
        let mut first = lock(&self.first);
        if first.is_none() && e.downcast_ref::<Stopped>().is_none() {
            *first = Some(e);
        }
        self.stopped.store(true, Ordering::SeqCst);
    }

    fn take(&self) -> Option<anyhow::Error> {
        lock(&self.first).take()
    }
}

/// Run `items` through `open` (the head: strictly one after another, in order) and each job it
/// returns through `finish` (up to `lanes` at once). `open` returning `None` means the item has
/// nothing more to do. See the module docs.
pub async fn run<T, J, O, OFut, F, FFut>(
    items: impl IntoIterator<Item = T>,
    lanes: usize,
    stop: &Stop,
    mut open: O,
    finish: F,
) -> Result<()>
where
    O: FnMut(T) -> OFut,
    OFut: Future<Output = Result<Option<J>>>,
    F: Fn(J) -> FFut,
    FFut: Future<Output = Result<()>>,
{
    if lanes <= 1 {
        for item in items {
            if let Some(job) = open(item).await? {
                finish(job).await?;
            }
        }
        return Ok(());
    }
    let (mut tx, rx) = mpsc::channel::<J>(lanes * QUEUE_PER_LANE);
    let head = async move {
        for item in items {
            if stop.is_stopped() {
                break;
            }
            match open(item).await {
                Ok(Some(job)) => {
                    if tx.send(job).await.is_err() {
                        break;
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    stop.fail(e);
                    break;
                }
            }
        }
        // Dropping the sender ends the lanes' stream once they drain the queue.
    };
    let finish = &finish;
    let tail = rx.for_each_concurrent(lanes, |job| async move {
        // Once stopping, queued jobs are dropped unstarted; the next run finds their items
        // on chain and finishes them.
        if stop.is_stopped() {
            return;
        }
        if let Err(e) = finish(job).await {
            stop.fail(e);
        }
    });
    futures::join!(head, tail);
    stop.take().map_or(Ok(()), Err)
}

/// Progress of the write phase for the log: how many items the head has placed (created, found,
/// or skipped), how many are complete, how many in run order are all complete (and the upstream
/// number of the last of them: with GitHub's one sequence, every item up to it; GitLab's issues
/// and merge requests interleave by creation time), documents written and spend.
#[derive(Debug)]
pub struct Progress {
    total: usize,
    every: Duration,
    state: Mutex<ProgressState>,
}

#[derive(Debug)]
struct ProgressState {
    started: Instant,
    last: Instant,
    printed: bool,
    placed: usize,
    placed_upstream: u32,
    complete: usize,
    /// Items at or past `low` that completed, by index, with their upstream numbers.
    ahead: BTreeMap<usize, u32>,
    /// Every item below this index is complete.
    low: usize,
    low_upstream: u32,
}

impl Progress {
    /// Progress over `total` items, said at most every `every`.
    pub fn new(total: usize, every: Duration) -> Self {
        let now = Instant::now();
        Self {
            total,
            every,
            state: Mutex::new(ProgressState {
                started: now,
                last: now,
                printed: false,
                placed: 0,
                placed_upstream: 0,
                complete: 0,
                ahead: BTreeMap::new(),
                low: 0,
                low_upstream: 0,
            }),
        }
    }

    /// The head is done with an item (upstream number `upstream`): created it, found it, or
    /// skipped it.
    pub fn placed(&self, upstream: u32) {
        let mut s = lock(&self.state);
        s.placed += 1;
        s.placed_upstream = s.placed_upstream.max(upstream);
    }

    /// Item `index` has nothing more to write this run.
    pub fn completed(&self, index: usize, upstream: u32) {
        let mut s = lock(&self.state);
        s.complete += 1;
        s.ahead.insert(index, upstream);
        while let Some(n) = {
            let low = s.low;
            s.ahead.remove(&low)
        } {
            s.low += 1;
            s.low_upstream = n;
        }
    }

    /// The line to log now, when one is due (`last`: the phase is over, said once a line was).
    /// `written` counts the documents written so far and `spent_dash` the spend; a dry run
    /// (`spent_dash` `None`) counts the documents it would write.
    pub fn line(&self, last: bool, written: u64, spent_dash: Option<f64>) -> Option<String> {
        let mut s = lock(&self.state);
        let now = Instant::now();
        let due = if last {
            s.printed
        } else {
            now.duration_since(s.last) >= self.every
        };
        if !due {
            return None;
        }
        s.last = now;
        s.printed = true;
        let elapsed = now.duration_since(s.started).as_secs();
        let (what, docs) = match spent_dash {
            Some(dash) => (
                "placed",
                format!("{written} documents written, {dash:.6} DASH spent"),
            ),
            None => ("priced", format!("{written} documents to write (dry run)")),
        };
        Some(format!(
            "forge-import: progress: {}/{} issues and PRs {what} (up to upstream #{}), {} \
             complete (all of the first {}, through upstream #{}); {docs}; {}m{:02}s",
            s.placed,
            self.total,
            s.placed_upstream,
            s.complete,
            s.low,
            s.low_upstream,
            elapsed / 60,
            elapsed % 60
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeSet;
    use std::rc::Rc;

    /// What the scheduler did, in order: `open i` / `start i` / `end i`.
    #[derive(Default)]
    struct Trace {
        events: Vec<String>,
        running: BTreeSet<usize>,
        most: usize,
        opening: bool,
    }

    async fn pause(i: usize) {
        // Jobs of different lengths, so lanes overtake one another.
        tokio::time::sleep(Duration::from_millis(((i * 7) % 5 + 1) as u64 * 10)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_head_is_ordered_and_the_lanes_are_bounded() {
        let trace = Rc::new(RefCell::new(Trace::default()));
        let stop = Stop::default();
        let (t1, t2) = (trace.clone(), trace.clone());
        run(
            0..40usize,
            4,
            &stop,
            move |i| {
                let t = t1.clone();
                async move {
                    {
                        let mut t = t.borrow_mut();
                        assert!(!t.opening, "one create at a time");
                        t.opening = true;
                        t.events.push(format!("open {i}"));
                    }
                    pause(i + 1).await;
                    t.borrow_mut().opening = false;
                    // every third item has nothing more to do
                    Ok((i % 3 != 0).then_some(i))
                }
            },
            move |i| {
                let t = t2.clone();
                async move {
                    {
                        let mut t = t.borrow_mut();
                        assert!(
                            t.events.contains(&format!("open {i}")),
                            "a job starts after its item is placed"
                        );
                        assert!(t.running.insert(i), "one job per item");
                        t.most = t.most.max(t.running.len());
                        t.events.push(format!("start {i}"));
                    }
                    pause(i).await;
                    let mut t = t.borrow_mut();
                    t.running.remove(&i);
                    t.events.push(format!("end {i}"));
                    Ok(())
                }
            },
        )
        .await
        .unwrap();
        let t = trace.borrow();
        let opens: Vec<usize> = t
            .events
            .iter()
            .filter_map(|e| e.strip_prefix("open ").map(|n| n.parse().unwrap()))
            .collect();
        assert_eq!(opens, (0..40).collect::<Vec<_>>(), "creates in order");
        assert!(
            t.most <= 4 && t.most > 1,
            "bounded, and parallel: {}",
            t.most
        );
        let ends = t.events.iter().filter(|e| e.starts_with("end ")).count();
        assert_eq!(ends, (0..40).filter(|i| i % 3 != 0).count());
    }

    /// The first real error stops the head and every lane from starting more; jobs in flight
    /// finish; that error is returned, not a lane's `Stopped`.
    #[tokio::test(start_paused = true)]
    async fn the_first_error_stops_the_run_and_in_flight_jobs_finish() {
        let started = Rc::new(RefCell::new(Vec::new()));
        let finished = Rc::new(RefCell::new(Vec::new()));
        let stop = Stop::default();
        let (s1, f1) = (started.clone(), finished.clone());
        let stop_ref = &stop;
        let err = run(
            0..100usize,
            3,
            &stop,
            |i| async move { Ok(Some(i)) },
            move |i| {
                let (s, f) = (s1.clone(), f1.clone());
                async move {
                    stop_ref.check()?;
                    s.borrow_mut().push(i);
                    if i == 5 {
                        anyhow::bail!("--max-spend reached");
                    }
                    pause(i).await;
                    f.borrow_mut().push(i);
                    Ok(())
                }
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.to_string(), "--max-spend reached");
        let started = started.borrow();
        let finished = finished.borrow();
        assert!(started.len() < 20, "stopped early: {started:?}");
        // Every job that started (but #5) finished: nothing was cut off mid-write.
        let mut want: Vec<usize> = started.iter().copied().filter(|&i| i != 5).collect();
        let mut got = finished.clone();
        want.sort_unstable();
        got.sort_unstable();
        assert_eq!(want, got);
    }

    #[tokio::test]
    async fn one_lane_is_the_sequential_run() {
        let log = RefCell::new(Vec::new());
        run(
            0..5usize,
            1,
            &Stop::default(),
            |i| {
                log.borrow_mut().push(format!("open {i}"));
                async move { Ok(Some(i)) }
            },
            |i| {
                log.borrow_mut().push(format!("finish {i}"));
                async { Ok(()) }
            },
        )
        .await
        .unwrap();
        let want: Vec<String> = (0..5)
            .flat_map(|i| [format!("open {i}"), format!("finish {i}")])
            .collect();
        assert_eq!(*log.borrow(), want);
        // The head's error is returned as it is.
        let e = run(
            0..3usize,
            1,
            &Stop::default(),
            |i| async move {
                anyhow::ensure!(i < 1, "boom");
                Ok(Some(i))
            },
            |_| async { Ok(()) },
        )
        .await
        .unwrap_err();
        assert_eq!(e.to_string(), "boom");
    }

    #[test]
    fn progress_says_how_far_every_item_is_complete() {
        let p = Progress::new(5, Duration::ZERO);
        for (i, n) in [10, 11, 13, 14, 15].into_iter().enumerate() {
            p.placed(n);
            if i != 1 {
                p.completed(i, n);
            }
        }
        let line = p.line(false, 42, Some(0.5)).unwrap();
        assert!(
            line.contains("5/5 issues and PRs placed (up to upstream #15), 4 complete (all of the first 1, through upstream #10)"),
            "{line}"
        );
        assert!(
            line.contains("42 documents written, 0.500000 DASH spent"),
            "{line}"
        );
        p.completed(1, 11);
        let last = p.line(true, 50, None).unwrap();
        assert!(last.contains("the first 5, through upstream #15"), "{last}");
        assert!(last.contains("5/5 issues and PRs priced"), "{last}");
        assert!(last.contains("50 documents to write (dry run)"), "{last}");
        // A phase that never said anything says nothing at its end either.
        let quiet = Progress::new(1, Duration::from_secs(3600));
        assert!(quiet.line(false, 0, Some(0.0)).is_none());
        assert!(quiet.line(true, 0, Some(0.0)).is_none());
    }
}
