//! Platform-parity rules (`docs/design/platform-parity-spec.md` §2.6, §1.2, §4; part of
//! `FORGE_RULES_V2`).
//!
//! * [`checks_state`] — whether a head's check runs meet a branch `policy`'s required checks.
//! * [`fold_thread_meta_v2`] — an issue's or PR's milestone, pinned and locked state (event kinds
//!   17–22).
//! * [`pinned_targets`] — the repo's pinned issues and PRs, from its event feed.
//! * [`fold_milestones_v2`] — a repo's milestones (newest definition per title) with the open
//!   and closed counts of what is in each.
//! * [`trending_window`] / [`trending_recount`] — the window a trending read covers and the
//!   ranking it proves, recomputed from the stars (`starBeat`) themselves.
//!
//! Every function is pure. The `"rules": "v2"` vectors `checks__*`, `thread_meta__*`,
//! `pinned__*`, `milestones__*` and `trending__*` in `forge-contracts/vectors/` hold this module
//! in parity with `forge-web/lib/rules/parity.ts`.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::v2::RoleOracle;
use super::{Event, EventKind};

// ===========================================================================
// Required checks
// ===========================================================================

/// One `checkRun` document, flattened.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRunRow {
    /// Document `$id`.
    pub id: String,
    /// `headOid`, hex.
    pub head_oid: String,
    /// The check's name.
    pub name: String,
    /// `queued`, `in_progress` or `completed`.
    pub status: String,
    /// The outcome once completed; absent before.
    #[serde(default)]
    pub conclusion: Option<String>,
    /// The reporter (`$ownerId`).
    pub reporter: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// What a branch `policy` says about checks.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksPolicy {
    /// Every check reported on the head must pass, and at least one must be reported.
    #[serde(default)]
    pub require_checks: bool,
    /// These checks must be reported and pass (overrides "every reported check" when set).
    #[serde(default)]
    pub required_checks: Vec<String>,
    /// `requiredCheckSources` (RC1 `check_sources`): the identity (base58, a runner or a
    /// maintainer of the repo) whose runs alone decide each of `required_checks`, paired by
    /// position. Empty: any trusted reporter's run decides (the rule before RC1).
    #[serde(default)]
    pub required_check_sources: Vec<String>,
}

/// Where one required check stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    /// Completed with `success`, `neutral` or `skipped`.
    Passed,
    /// Completed with any other conclusion (or none).
    Failing,
    /// Queued or in progress.
    Pending,
    /// No trusted run of this name on the head.
    Missing,
}

/// One required check and the run that decides it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredCheck {
    /// The check's name.
    pub name: String,
    /// Where it stands.
    pub state: CheckState,
    /// The deciding run's `$id`, if any.
    pub run_id: Option<String>,
}

/// A head's checks against a policy ([`checks_state`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksState {
    /// The checks the policy requires, by name (code-point order).
    pub required: Vec<RequiredCheck>,
    /// Every required check passed (and, for `requireChecks` alone, at least one was reported).
    pub met: bool,
    /// Runs on the head not counted: their reporter is no longer a maintainer, writer or runner.
    pub untrusted: u32,
}

/// The conclusions that pass a required check (GitHub's: a neutral or skipped run blocks
/// nothing).
pub const PASSING_CONCLUSIONS: [&str; 3] = ["success", "neutral", "skipped"];

fn check_state_of(run: &CheckRunRow) -> CheckState {
    match run.status.as_str() {
        "completed" => {
            if run
                .conclusion
                .as_deref()
                .is_some_and(|c| PASSING_CONCLUSIONS.contains(&c))
            {
                CheckState::Passed
            } else {
                CheckState::Failing
            }
        }
        _ => CheckState::Pending,
    }
}

/// Whether the check runs on `head_oid` meet `policy` (platform-parity-spec §2.6).
///
/// * A run counts only when its reporter is a **current** maintainer or writer (`oracle`) or a
///   current runner (`runners`); consensus admitted it from one of them, and revoking the
///   membership withdraws the trust (the approvals rule). Runs on another head are ignored.
/// * The newest counting run per name by `($createdAt, $id)` decides that name. An untrusted
///   run never shadows a trusted one.
/// * `requiredChecks` set: each named check must be decided by a passing run; a missing one is
///   `missing`. Otherwise `requireChecks`: every counting name must pass, and at least one
///   must exist. Neither: nothing is required and `met` is true.
/// * **Pinned sources** (`requiredCheckSources`, paired with `requiredChecks` by position):
///   a pinned name counts only the runs its source signed, so another member's or runner's run
///   of that name neither passes nor blocks it (nor counts as untrusted). The source must still
///   be a current member or runner. Consensus admits as many sources as names or none
///   (`sourcesMatchNames`); a list that does not pair up pins nothing, and an empty one is the
///   rule without pinning.
///
/// A client rule for the merge box (a maintainer may override), never consensus.
#[must_use]
pub fn checks_state(
    runs: &[CheckRunRow],
    head_oid: &str,
    oracle: &RoleOracle,
    runners: &BTreeSet<String>,
    policy: &ChecksPolicy,
) -> ChecksState {
    let trusted = |who: &str| oracle.current_role(who).is_some() || runners.contains(who);
    let pins = pinned_sources(policy);
    let pinned_out = |run: &CheckRunRow| {
        pins.get(run.name.as_str())
            .is_some_and(|sources| !sources.contains(run.reporter.as_str()))
    };
    let mut newest: BTreeMap<&str, &CheckRunRow> = BTreeMap::new();
    let mut untrusted = 0u32;
    for run in runs
        .iter()
        .filter(|r| r.head_oid.eq_ignore_ascii_case(head_oid) && !r.name.is_empty())
    {
        if !trusted(&run.reporter) {
            untrusted = untrusted.saturating_add(1);
            continue;
        }
        if pinned_out(run) {
            continue;
        }
        let newer = newest.get(run.name.as_str()).is_none_or(|held| {
            (run.created_at, run.id.as_str()) > (held.created_at, held.id.as_str())
        });
        if newer {
            newest.insert(run.name.as_str(), run);
        }
    }
    // An empty name names nothing (the schema refuses one; a reader's input may not).
    let listed: BTreeSet<&str> = policy
        .required_checks
        .iter()
        .map(String::as_str)
        .filter(|n| !n.is_empty())
        .collect();
    let require_all = listed.is_empty() && policy.require_checks;
    let names = if require_all {
        newest.keys().copied().collect()
    } else {
        listed
    };
    let required: Vec<RequiredCheck> = names
        .into_iter()
        .map(|name| match newest.get(name) {
            Some(run) => RequiredCheck {
                name: name.to_owned(),
                state: check_state_of(run),
                run_id: Some(run.id.clone()),
            },
            None => RequiredCheck {
                name: name.to_owned(),
                state: CheckState::Missing,
                run_id: None,
            },
        })
        .collect();
    let all_pass = required.iter().all(|c| c.state == CheckState::Passed);
    let met = all_pass && !(require_all && required.is_empty());
    ChecksState {
        required,
        met,
        untrusted,
    }
}

/// Each pinned check name and the sources that may decide it ([`checks_state`]): empty unless
/// `requiredCheckSources` pairs up with `requiredChecks`. An empty name or source pins nothing.
pub fn pinned_sources(policy: &ChecksPolicy) -> BTreeMap<&str, BTreeSet<&str>> {
    let mut pins: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    if policy.required_check_sources.len() != policy.required_checks.len() {
        return pins;
    }
    for (name, source) in policy
        .required_checks
        .iter()
        .zip(&policy.required_check_sources)
        .filter(|(n, s)| !n.is_empty() && !s.is_empty())
    {
        pins.entry(name.as_str())
            .or_default()
            .insert(source.as_str());
    }
    pins
}

// ===========================================================================
// Milestone, pin, lock (event kinds 17–22)
// ===========================================================================

/// An issue's or PR's milestone, pinned and locked state ([`fold_thread_meta_v2`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMeta {
    /// The milestone (the newest set / clear), if any.
    pub milestone: Option<String>,
    /// Pinned to the repo's issue or PR list.
    pub pinned: bool,
    /// When the standing pin was made (ms); `None` when not pinned.
    pub pinned_at: Option<u64>,
    /// Locked, from the retired lock events (kinds 21/22, refused on chain since RC1 by
    /// `noState`). Kept for the shared vectors only: read a thread's lock from its transitions
    /// (`TargetLog::locked`, a sum of 16 or more).
    pub locked: bool,
}

/// Fold a target's member `event`s into its [`ThreadMeta`].
///
/// Only `event` documents are read: milestone set/clear (17/18) and pin/unpin/lock/unlock
/// (19–22) are members' kinds, which an `authorEvent` cannot carry (its schema `enum`). Events
/// apply in `($createdAt, $id)` order and the newest of each pair stands. A milestone set
/// without a `value` is inert. Membership since revoked does not undo an event (§3).
#[must_use]
pub fn fold_thread_meta_v2(events: &[Event]) -> ThreadMeta {
    let mut log: Vec<&Event> = events.iter().collect();
    log.sort_by(|a, b| super::event_order(a, b));
    let mut meta = ThreadMeta::default();
    for e in log {
        match e.kind {
            EventKind::MilestoneSet => {
                if let Some(v) = e.value.as_deref().filter(|v| !v.is_empty()) {
                    meta.milestone = Some(v.to_owned());
                }
            }
            EventKind::MilestoneClear => meta.milestone = None,
            EventKind::Pin => {
                meta.pinned = true;
                meta.pinned_at = Some(e.created_at);
            }
            EventKind::Unpin => {
                meta.pinned = false;
                meta.pinned_at = None;
            }
            EventKind::Lock => meta.locked = true,
            EventKind::Unlock => meta.locked = false,
            _ => {}
        }
    }
    meta
}

/// A pinned issue or PR ([`pinned_targets`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedTarget {
    /// The issue or PR (`targetId`).
    pub target_id: String,
    /// When the standing pin was made (ms).
    pub pinned_at: u64,
}

/// The pinned issues and PRs among a repo's member `event`s (its `feed`): per target the
/// newest pin/unpin by `($createdAt, $id)` stands. Newest pin first; equal times by target id
/// (code-point order). The UI shows the first three, as GitHub does.
#[must_use]
pub fn pinned_targets(events: &[Event]) -> Vec<PinnedTarget> {
    let mut log: Vec<&Event> = events
        .iter()
        .filter(|e| matches!(e.kind, EventKind::Pin | EventKind::Unpin) && !e.target_id.is_empty())
        .collect();
    log.sort_by(|a, b| super::event_order(a, b));
    let mut state: BTreeMap<&str, Option<u64>> = BTreeMap::new();
    for e in log {
        state.insert(
            e.target_id.as_str(),
            (e.kind == EventKind::Pin).then_some(e.created_at),
        );
    }
    let mut out: Vec<PinnedTarget> = state
        .into_iter()
        .filter_map(|(target, at)| {
            at.map(|pinned_at| PinnedTarget {
                target_id: target.to_owned(),
                pinned_at,
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.pinned_at
            .cmp(&a.pinned_at)
            .then_with(|| a.target_id.cmp(&b.target_id))
    });
    out
}

// ===========================================================================
// Milestones
// ===========================================================================

/// One `milestone` document, flattened (decrypted first in a private repo).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneDoc {
    /// Document `$id`.
    pub id: String,
    /// The title (the key events name it by).
    pub title: String,
    /// The description.
    #[serde(default)]
    pub description: Option<String>,
    /// The due date (ms).
    #[serde(default)]
    pub due_on: Option<u64>,
    /// Closed.
    #[serde(default)]
    pub closed: bool,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// What a milestone holds: one issue or PR, its fold's `open` and [`ThreadMeta::milestone`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneItem {
    /// Open (the issue/PR fold).
    pub open: bool,
    /// Its milestone ([`fold_thread_meta_v2`]).
    #[serde(default)]
    pub milestone: Option<String>,
}

/// A repo's milestone with its progress ([`fold_milestones_v2`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Milestone {
    /// The standing definition's `$id`.
    pub id: String,
    /// The title.
    pub title: String,
    /// The description ("" when none).
    pub description: String,
    /// The due date (ms).
    pub due_on: Option<u64>,
    /// Closed.
    pub closed: bool,
    /// Open issues and PRs in it.
    pub open: u32,
    /// Closed (and merged) issues and PRs in it.
    pub closed_items: u32,
}

/// A repo's milestones: the newest definition per title by `($createdAt, $id)` (like labels,
/// forge-v2.md §2; a definition deleted by its writer is simply gone), each with the open and
/// closed counts of the `items` whose milestone is its title. Items naming a title with no
/// definition are not counted anywhere. Sorted by title (code-point order).
#[must_use]
pub fn fold_milestones_v2(docs: &[MilestoneDoc], items: &[MilestoneItem]) -> Vec<Milestone> {
    let mut newest: BTreeMap<&str, &MilestoneDoc> = BTreeMap::new();
    for d in docs.iter().filter(|d| !d.title.is_empty()) {
        let newer = newest
            .get(d.title.as_str())
            .is_none_or(|held| (d.created_at, d.id.as_str()) > (held.created_at, held.id.as_str()));
        if newer {
            newest.insert(d.title.as_str(), d);
        }
    }
    let mut counts: BTreeMap<&str, (u32, u32)> = BTreeMap::new();
    for item in items {
        if let Some(title) = item.milestone.as_deref() {
            let c = counts.entry(title).or_default();
            if item.open {
                c.0 = c.0.saturating_add(1);
            } else {
                c.1 = c.1.saturating_add(1);
            }
        }
    }
    newest
        .into_iter()
        .map(|(title, d)| {
            let (open, closed_items) = counts.get(title).copied().unwrap_or_default();
            Milestone {
                id: d.id.clone(),
                title: title.to_owned(),
                description: d.description.clone().unwrap_or_default(),
                due_on: d.due_on,
                closed: d.closed,
                open,
                closed_items,
            }
        })
        .collect()
}

// ===========================================================================
// Trending
// ===========================================================================

/// A `timeRange` grid, in seconds (the index's declaration).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeGrid {
    /// Window length.
    pub range: u64,
    /// Interval between window starts.
    pub step: u64,
    /// Grid alignment.
    #[serde(default)]
    pub phase: u64,
}

/// forge-collab `starBeat.byWeek`: seven-day windows starting every day at 00:00 UTC.
pub const STAR_BEAT_GRID: TimeGrid = TimeGrid {
    range: 604_800,
    step: 86_400,
    phase: 0,
};

/// Which window a trending read selects (the query's `IN_TIME_RANGE` selector), or all time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrendingSelector {
    /// The window that started most recently: "today so far".
    Newest,
    /// The oldest window still open: a near-full trailing `range` ("this week").
    Oldest,
    /// No window: every star (the all-time ranking, "most starred").
    All,
}

/// A window `[start, end)` in ms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    /// First instant in the window (ms).
    pub start: u64,
    /// First instant after it (ms).
    pub end: u64,
}

/// The window `selector` names at `now_ms` on `grid`, as rs-dpp's `TimeRangeTransform`
/// resolves it (`most_recent_start`, `oldest_active_start`): newest = `phase + ⌊(now − phase) /
/// step⌋ · step`, oldest = `newest − (range/step − 1) · step`, not before `phase`. `None` for
/// [`TrendingSelector::All`], a zero step, or `now` before the phase.
#[must_use]
pub fn trending_window(grid: TimeGrid, now_ms: u64, selector: TrendingSelector) -> Option<Window> {
    let (range, step, phase) = (
        grid.range.saturating_mul(1000),
        grid.step.saturating_mul(1000),
        grid.phase.saturating_mul(1000),
    );
    if step == 0 || now_ms < phase {
        return None;
    }
    let back = match selector {
        TrendingSelector::Newest => 0,
        TrendingSelector::Oldest => (range / step).saturating_sub(1).saturating_mul(step),
        TrendingSelector::All => return None,
    };
    let newest = phase + (now_ms - phase) / step * step;
    let start = newest.saturating_sub(back).max(phase);
    Some(Window {
        start,
        end: start.saturating_add(range),
    })
}

/// One star (or trending beat): the starred repo's id as hex (the ranked query's group key)
/// and when it was written.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarBeat {
    /// The repo id, hex (32 bytes).
    pub repo: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// One row of a ranking.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendingEntry {
    /// The repo id, hex (lowercase).
    pub repo: String,
    /// Stars in the window.
    pub count: u64,
}

/// The ranking a `documents.ranked` read proves, recomputed from the beats themselves: the
/// count per repo of the beats inside the selected window (all of them for
/// [`TrendingSelector::All`]), highest first, **equal counts by repo id descending** (a
/// descending walk of the ranked secondary, keyed by count then group key; measured on moutai),
/// at most `limit` rows. The Explore page shows the proved read; this is what a client-side
/// recount must agree with.
#[must_use]
pub fn trending_recount(
    beats: &[StarBeat],
    grid: TimeGrid,
    now_ms: u64,
    selector: TrendingSelector,
    limit: usize,
) -> Vec<TrendingEntry> {
    let window = trending_window(grid, now_ms, selector);
    if window.is_none() && selector != TrendingSelector::All {
        return Vec::new();
    }
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    for b in beats {
        let inside = window.is_none_or(|w| b.created_at >= w.start && b.created_at < w.end);
        if inside && !b.repo.is_empty() {
            *counts.entry(b.repo.to_ascii_lowercase()).or_default() += 1;
        }
    }
    let mut rows: Vec<TrendingEntry> = counts
        .into_iter()
        .map(|(repo, count)| TrendingEntry { repo, count })
        .collect();
    rows.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| b.repo.cmp(&a.repo)));
    rows.truncate(limit);
    rows
}

// ===========================================================================
// Check-run reports: monotonic status and times
// ===========================================================================

/// The stored run a report would update, as far as the monotonic rules read it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRun {
    /// `queued`, `in_progress` or `completed`.
    pub status: String,
    /// `startedAt` (ms), once set.
    #[serde(default)]
    pub started_at: Option<u64>,
    /// `completedAt` (ms), once set.
    #[serde(default)]
    pub completed_at: Option<u64>,
    /// `conclusion`, once set.
    #[serde(default)]
    pub conclusion: Option<String>,
    /// `externalId` (the CI's own run id), once set.
    #[serde(default)]
    pub external_id: Option<String>,
}

/// What a reporter says now.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    /// `queued`, `in_progress` or `completed`.
    pub status: String,
    /// The conclusion of a completed run.
    #[serde(default)]
    pub conclusion: Option<String>,
    /// A start time the CI gives (ms); else the report's time is used.
    #[serde(default)]
    pub started_at: Option<u64>,
    /// A completion time the CI gives (ms); else the report's time is used.
    #[serde(default)]
    pub completed_at: Option<u64>,
    /// The CI's own run id, when it gives one.
    #[serde(default)]
    pub external_id: Option<String>,
}

/// How a report is written ([`check_run_write`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunWriteAction {
    /// A new `checkRun` document.
    Create,
    /// A replace of the stored run.
    Replace,
}

/// The write a report makes: create or replace, and the immutable-once-set fields it carries.
/// On a replace, only a field the stored run does not have yet is set (`None` keeps the stored
/// value: `startedAt`, `completedAt`, `conclusion` and `externalId` are `immutableAllowSetting`,
/// so a set value never changes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunWrite {
    /// Create or replace.
    pub action: RunWriteAction,
    /// `startedAt` to write, if any.
    pub started_at: Option<u64>,
    /// `completedAt` to write, if any.
    pub completed_at: Option<u64>,
    /// `conclusion` to write, if any.
    pub conclusion: Option<String>,
    /// `externalId` to write, if any.
    pub external_id: Option<String>,
}

fn status_rank(status: &str) -> Option<u8> {
    match status {
        "queued" => Some(0),
        "in_progress" => Some(1),
        "completed" => Some(2),
        _ => None,
    }
}

/// Whether `stored` can take `report` as a replace: same run (an `externalId` never changes)
/// moving forwards, and a completed run's conclusion unchanged.
fn continues(stored: &StoredRun, report: &RunReport, rank: u8) -> bool {
    let Some(held) = status_rank(&stored.status) else {
        return false;
    };
    let same_run = match (&stored.external_id, &report.external_id) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    };
    let conclusion_kept = stored.conclusion.is_none() || stored.conclusion == report.conclusion;
    same_run && rank >= held && conclusion_kept
}

/// The write that records `report` against `stored` (the reporter's run it would update, or
/// none) at `now_ms`, so the forge-community `checkRun` rules hold (`conclusionIfDone`,
/// `doneIfConclusion`, `startedIfRunning`, `runningIfStarted`, `completedAtIfDone`,
/// `doneIfCompletedAt`, D-5):
///
/// * a conclusion comes with `completed` and only with it;
/// * `startedAt` is set on the first report that is not `queued`, `completedAt` on the first
///   `completed` one: the CI's own time when given, else `now_ms`; a completion never precedes
///   the start it is paired with;
/// * a stored time, conclusion or `externalId` is never changed or dropped;
/// * a report that would move a run backwards (in progress to queued, completed to anything
///   else), change a completed run's conclusion, or name another `externalId` is a re-run: a
///   new document.
///
/// `None` when consensus would refuse the report whatever is stored: an unknown status, a
/// `completed` without a conclusion, or a conclusion on a run that is not completed.
#[must_use]
pub fn check_run_write(
    stored: Option<&StoredRun>,
    report: &RunReport,
    now_ms: u64,
) -> Option<RunWrite> {
    let rank = status_rank(&report.status)?;
    if (rank == 2) != report.conclusion.is_some() {
        return None;
    }
    let stored = stored.filter(|s| continues(s, report, rank));
    let held_start = stored.and_then(|s| s.started_at);
    let held_end = stored.and_then(|s| s.completed_at);
    let start = held_start.or_else(|| (rank >= 1).then(|| report.started_at.unwrap_or(now_ms)));
    let end = held_end.or_else(|| {
        (rank == 2).then(|| {
            let end = report.completed_at.unwrap_or(now_ms);
            start.map_or(end, |s| end.max(s))
        })
    });
    let unset = |held: Option<&String>, given: &Option<String>| {
        if held.is_some() {
            None
        } else {
            given.clone()
        }
    };
    Some(RunWrite {
        action: if stored.is_some() {
            RunWriteAction::Replace
        } else {
            RunWriteAction::Create
        },
        started_at: if held_start.is_some() { None } else { start },
        completed_at: if held_end.is_some() { None } else { end },
        conclusion: unset(
            stored.and_then(|s| s.conclusion.as_ref()),
            &report.conclusion,
        ),
        external_id: unset(
            stored.and_then(|s| s.external_id.as_ref()),
            &report.external_id,
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::super::v2::{Membership, Role};
    use super::*;

    const HEAD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn run(id: &str, name: &str, reporter: &str, at: u64, conclusion: &str) -> CheckRunRow {
        CheckRunRow {
            id: id.into(),
            head_oid: HEAD.into(),
            name: name.into(),
            status: "completed".into(),
            conclusion: Some(conclusion.into()),
            reporter: reporter.into(),
            created_at: at,
        }
    }

    fn oracle() -> RoleOracle {
        RoleOracle::new(vec![
            Membership {
                identity: "maint".into(),
                role: Role::Maintainer,
                created_at: 1,
            },
            Membership {
                identity: "writ".into(),
                role: Role::Writer,
                created_at: 1,
            },
        ])
    }

    fn policy(names: &[&str], sources: &[&str]) -> ChecksPolicy {
        ChecksPolicy {
            require_checks: true,
            required_checks: names.iter().map(|s| (*s).to_string()).collect(),
            required_check_sources: sources.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    fn states(s: &ChecksState) -> Vec<(&str, CheckState)> {
        s.required
            .iter()
            .map(|c| (c.name.as_str(), c.state))
            .collect()
    }

    #[test]
    fn a_pinned_check_counts_only_its_sources_runs() {
        let runners = BTreeSet::from(["bot".to_string()]);
        // A writer's newer passing `build` does not decide a `build` pinned to the runner,
        // whose run failed; `lint`, pinned to the maintainer, passes by the maintainer's run.
        let runs = [
            run("r1", "build", "bot", 10, "failure"),
            run("r2", "build", "writ", 20, "success"),
            run("r3", "lint", "maint", 10, "success"),
            run("r4", "lint", "bot", 20, "failure"),
        ];
        let s = checks_state(
            &runs,
            HEAD,
            &oracle(),
            &runners,
            &policy(&["build", "lint"], &["bot", "maint"]),
        );
        assert_eq!(
            states(&s),
            [("build", CheckState::Failing), ("lint", CheckState::Passed)]
        );
        assert!(!s.met);
        assert_eq!(s.untrusted, 0, "another member's run is not untrusted");
        assert_eq!(s.required[0].run_id.as_deref(), Some("r1"));
        // Only another reporter's run: the pinned check is missing.
        let s = checks_state(
            &runs[1..2],
            HEAD,
            &oracle(),
            &runners,
            &policy(&["build"], &["bot"]),
        );
        assert_eq!(states(&s), [("build", CheckState::Missing)]);
    }

    #[test]
    fn no_sources_or_a_list_that_does_not_pair_up_is_the_unpinned_rule() {
        let runners = BTreeSet::from(["bot".to_string()]);
        let runs = [
            run("r1", "build", "bot", 10, "failure"),
            run("r2", "build", "writ", 20, "success"),
        ];
        for sources in [&[][..], &["bot", "maint"][..]] {
            let s = checks_state(
                &runs,
                HEAD,
                &oracle(),
                &runners,
                &policy(&["build"], sources),
            );
            assert_eq!(states(&s), [("build", CheckState::Passed)], "{sources:?}");
            assert!(s.met);
        }
    }

    #[test]
    fn a_revoked_source_decides_nothing() {
        // The pinned runner was revoked: its run is untrusted, and nobody else's counts.
        let runs = [
            run("r1", "build", "bot", 10, "success"),
            run("r2", "build", "writ", 20, "success"),
        ];
        let s = checks_state(
            &runs,
            HEAD,
            &oracle(),
            &BTreeSet::new(),
            &policy(&["build"], &["bot"]),
        );
        assert_eq!(states(&s), [("build", CheckState::Missing)]);
        assert_eq!(s.untrusted, 1);
    }
}
