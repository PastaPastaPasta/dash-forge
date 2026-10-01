//! Review parity rules (`docs/design/review-parity-spec.md` §5, part of `FORGE_RULES_V2`).
//!
//! * [`fold_pr_review_v2`] — the review state a PR's `event` + `authorEvent` documents fold to
//!   (kinds 11–18 and 16): the PR's current head, requested reviewers, resolved threads,
//!   dismissed reviews and milestone.
//! * [`meets_policy`] — whether the approvals satisfy a branch `policy`.
//! * [`anchor_of`] — an inline comment's anchor (file-level, a line, or a range).
//! * [`group_review_comments`] — the comments that belong to a review.
//! * [`parse_suggestions`] / [`apply_suggestion`] — GitHub-style ```` ```suggestion ```` blocks.
//! * [`linked_issues`] — `fixes #12`-style references.
//!
//! Every function is pure, and the `"rules": "v2"` vectors in `forge-contracts/vectors/`
//! (`fold_review_v2__*`, `policy__*`, `anchor__*`, `review_group__*`, `suggestion__*`,
//! `linked_issues__*`) hold it in parity with `forge-web/lib/rules/review.ts`.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::v2::{Approvals, Role, RoleOracle};
use super::{event_order, Event, EventKind, Oid};

// ===========================================================================
// The review fold
// ===========================================================================

/// The kinds an `authorEvent` may carry (the forge-collab schema's `kind` enum, 11–14 and 16):
/// thread resolve / unresolve, review request / remove, head update. An author's close, reopen,
/// draft and ready are `transition`s ([`super::transition`]).
#[must_use]
pub fn is_author_kind(kind: EventKind) -> bool {
    matches!(
        kind,
        EventKind::ThreadResolve
            | EventKind::ThreadUnresolve
            | EventKind::ReviewRequest
            | EventKind::ReviewRequestRemove
            | EventKind::HeadUpdate
    )
}

/// One `headUpdate` that applied, for the "pushed n commits" timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadUpdate {
    /// The new head.
    pub oid: Oid,
    /// Who moved it (the PR author or a base-repo member).
    pub actor: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// The event's `$id`.
    pub id: String,
}

/// A requested reviewer whose newest request was not removed after it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestedReviewer {
    /// The reviewer's identity.
    pub identity: String,
    /// When the standing request was made (re-requesting moves it).
    pub requested_at: u64,
}

/// A dismissed review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dismissal {
    /// The dismissed review's `$id`.
    pub review_id: String,
    /// The maintainer or writer who dismissed it.
    pub actor: String,
    /// The reason (`value`), empty when none was given.
    pub reason: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// A PR's review state (`fold_pr_review_v2`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewState {
    /// The current head: the newest applied `headUpdate`'s `oid`, else the patch's `headOid`.
    pub head: Oid,
    /// Every applied `headUpdate`, oldest first.
    pub head_updates: Vec<HeadUpdate>,
    /// Standing review requests, by identity (code-point order).
    pub requested_reviewers: Vec<RequestedReviewer>,
    /// Resolved thread roots (code-point order): the newest resolve/unresolve per root was a
    /// resolve, and the root is one of `known_roots`.
    pub resolved_threads: Vec<String>,
    /// Dismissed reviews, by review id (code-point order). The first dismissal of a review
    /// stands (a dismissal cannot be undone).
    pub dismissed_reviews: Vec<Dismissal>,
    /// The milestone (newest set/clear), if any.
    pub milestone: Option<String>,
}

/// Whether an `authorEvent` applies: an author kind ([`is_author_kind`]) by the target's author.
///
/// Consensus already guarantees both (the schema's `kind` enum, and the gate is the author
/// lookup), so this is defense in depth against a reader handing in the wrong documents. An
/// `event` needs no check: its existence proves a maintainer or writer wrote it, and revoking
/// them later does not undo that.
pub(crate) fn author_event_applies(e: &Event, target_author: &str) -> bool {
    is_author_kind(e.kind) && e.actor == target_author
}

/// The applicable documents of both types, in `(createdAt, id)` order. `events` come first in
/// the input, so two documents with the same key keep that order (the sort is stable; real
/// `$id`s never collide across document types). Every fold over a target's log uses this.
pub(crate) fn merged_log<'a>(
    events: &'a [Event],
    author_events: &'a [Event],
    target_author: &str,
) -> Vec<&'a Event> {
    let mut log: Vec<&Event> = events
        .iter()
        .chain(
            author_events
                .iter()
                .filter(|e| author_event_applies(e, target_author)),
        )
        .collect();
    log.sort_by(|a, b| event_order(a, b));
    log
}

/// Fold a PR's `event` and `authorEvent` documents into its [`PrReviewState`].
///
/// * Ordering is `(createdAt, id)` over both types, `event`s first at equal keys; an
///   `authorEvent` applies only if its kind is an author
///   kind ([`is_author_kind`]) and its writer is `target_author`.
/// * `headUpdate` (16) needs an `oid`; the newest applied one is the head.
/// * `reviewRequest` / `reviewRequestRemove` (13/14) need a `ref_id` (the reviewer); the newest
///   per identity stands.
/// * `threadResolve` / `threadUnresolve` (11/12) need a `ref_id` in `known_roots` (the PR's
///   root comments, supplied by the reader); the newest per root stands.
/// * `reviewDismiss` (15, members only) needs a `ref_id` (the review); the reason is `value`.
/// * `milestoneSet` / `milestoneClear` (17/18, members only): newest wins; a set without a
///   `value` is inert.
///
/// A kind 11–18 document missing its payload is inert.
#[must_use]
pub fn fold_pr_review_v2(
    events: &[Event],
    author_events: &[Event],
    target_author: &str,
    initial_head: &str,
    known_roots: &BTreeSet<String>,
) -> PrReviewState {
    let log = merged_log(events, author_events, target_author);

    let mut head_updates = Vec::new();
    let mut requested: BTreeMap<String, Option<u64>> = BTreeMap::new();
    let mut resolved: BTreeMap<String, bool> = BTreeMap::new();
    let mut dismissed: BTreeMap<String, Dismissal> = BTreeMap::new();
    let mut milestone = None;
    let present = |s: &Option<String>| s.as_deref().filter(|v| !v.is_empty()).map(str::to_owned);
    for e in log {
        match e.kind {
            EventKind::HeadUpdate => {
                if let Some(oid) = present(&e.oid)
                    .filter(|o| is_hex_oid(o))
                    .map(|o| o.to_ascii_lowercase())
                {
                    head_updates.push(HeadUpdate {
                        oid,
                        actor: e.actor.clone(),
                        created_at: e.created_at,
                        id: e.id.clone(),
                    });
                }
            }
            EventKind::ReviewRequest | EventKind::ReviewRequestRemove => {
                if let Some(who) = present(&e.ref_id) {
                    let at = (e.kind == EventKind::ReviewRequest).then_some(e.created_at);
                    requested.insert(who, at);
                }
            }
            EventKind::ThreadResolve | EventKind::ThreadUnresolve => {
                if let Some(root) = present(&e.ref_id).filter(|r| known_roots.contains(r)) {
                    resolved.insert(root, e.kind == EventKind::ThreadResolve);
                }
            }
            EventKind::ReviewDismiss => {
                if let Some(review_id) = present(&e.ref_id) {
                    dismissed.entry(review_id.clone()).or_insert(Dismissal {
                        review_id,
                        actor: e.actor.clone(),
                        reason: e.value.clone().unwrap_or_default(),
                        created_at: e.created_at,
                    });
                }
            }
            EventKind::MilestoneSet => {
                if let Some(v) = present(&e.value) {
                    milestone = Some(v);
                }
            }
            EventKind::MilestoneClear => milestone = None,
            _ => {}
        }
    }
    PrReviewState {
        head: head_updates
            .last()
            .map_or_else(|| initial_head.to_owned(), |h| h.oid.clone()),
        head_updates,
        requested_reviewers: requested
            .into_iter()
            .filter_map(|(identity, at)| {
                at.map(|requested_at| RequestedReviewer {
                    identity,
                    requested_at,
                })
            })
            .collect(),
        resolved_threads: resolved
            .into_iter()
            .filter_map(|(root, r)| r.then_some(root))
            .collect(),
        dismissed_reviews: dismissed.into_values().collect(),
        milestone,
    }
}

// ===========================================================================
// Branch policy
// ===========================================================================

/// A `policy` document, flattened (forge-v2.md §2). The newest by `(createdAt, id)` among the
/// repo's policies is the one in force; the reader picks it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    /// Approvals a merge needs (0–10).
    pub required_approvals: u32,
    /// 0: any member's approval counts; 1: maintainers' only.
    #[serde(default)]
    pub approver_role: u8,
    /// Passing checks required (informational to [`meets_policy`], which judges approvals).
    #[serde(default)]
    pub require_checks: bool,
    /// Allowed merge methods, bitmask (1 ff, 2 merge commit, 4 squash, 8 rebase; 0 any; the
    /// contract caps it at 15).
    #[serde(default)]
    pub merge_methods: u8,
    /// The checks a merge needs by name (`requiredChecks`: at most 10, unique).
    #[serde(default)]
    pub required_checks: Vec<String>,
    /// `requiredCheckSources`: the runner or maintainer (base58) whose runs alone decide each
    /// of `required_checks`, paired by position; as many as the names, or none (any trusted
    /// reporter's run decides). See [`super::parity::checks_state`].
    #[serde(default)]
    pub required_check_sources: Vec<String>,
}

impl Policy {
    /// The policy's check rules, as [`super::parity::checks_state`] judges them.
    #[must_use]
    pub fn checks_policy(&self) -> super::parity::ChecksPolicy {
        super::parity::ChecksPolicy {
            require_checks: self.require_checks,
            required_checks: self.required_checks.clone(),
            required_check_sources: self.required_check_sources.clone(),
        }
    }
}

/// How far the approvals are from a policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyStatus {
    /// `have >= need`.
    pub met: bool,
    /// Approvers whose **current** role satisfies `approver_role`.
    pub have: u32,
    /// `required_approvals`.
    pub need: u32,
}

/// Whether `approvals` (from [`super::v2::count_approvals`] on the current head, dismissed
/// reviews and the PR author's own reviews excluded) meet `policy`. An approver counts when their current role satisfies
/// `approver_role` (0: a maintainer or role-1 writer, never triage or reader; 1: maintainer
/// only). A client rule for the merge box, never consensus.
#[must_use]
pub fn meets_policy(approvals: &Approvals, oracle: &RoleOracle, policy: &Policy) -> PolicyStatus {
    let have = approvals
        .approvers
        .iter()
        .filter(|a| match oracle.current_role(a) {
            Some(Role::Maintainer) => true,
            Some(Role::Writer) => policy.approver_role == 0,
            // Never approvers: their verdicts are shown, not counted.
            Some(Role::Triage | Role::Reader) | None => false,
        })
        .count();
    let have = u32::try_from(have).unwrap_or(u32::MAX);
    PolicyStatus {
        met: have >= policy.required_approvals,
        have,
        need: policy.required_approvals,
    }
}

// ===========================================================================
// Anchors
// ===========================================================================

/// A comment's anchor fields as stored (plaintext, or decrypted for `path` in a private repo).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorFields {
    /// `path`.
    #[serde(default)]
    pub path: Option<String>,
    /// `line` (the last line of a range).
    #[serde(default)]
    pub line: Option<u64>,
    /// `startLine`.
    #[serde(default)]
    pub start_line: Option<u64>,
    /// `side`: 0 old, 1 new.
    #[serde(default)]
    pub side: Option<u64>,
    /// `commitOid`, hex (empty or absent: not recorded).
    #[serde(default)]
    pub commit_oid: Option<String>,
}

/// Where an inline comment points.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    /// The file.
    pub path: String,
    /// The line (the last line of a range); `None` for a file-level comment.
    pub line: Option<u64>,
    /// The first line of a range (equal to `line` for a single line); `None` file-level.
    pub start_line: Option<u64>,
    /// 0 old side, 1 new side; `None` file-level.
    pub side: Option<u8>,
    /// The commit the comment was made on, lowercase hex, or empty.
    pub commit_oid: String,
}

fn is_hex_oid(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A comment's anchor (spec §5.4), or `None` for a general comment. A malformed anchor is
/// `None` too, so the comment shows as general rather than at a wrong place:
///
/// * `path` present and non-empty, else no anchor;
/// * `line` present ⇒ `side` ∈ {0, 1}; `side` without `line` is malformed;
/// * `start_line` present ⇒ `line` present and `start_line <= line`;
/// * `commit_oid` empty/absent or 40/64 hex (any case; returned lowercase).
///
/// A file-level anchor has `path` only.
#[must_use]
pub fn anchor_of(f: &AnchorFields) -> Option<Anchor> {
    let path = f.path.as_deref().filter(|p| !p.is_empty())?;
    let commit_oid = f.commit_oid.as_deref().unwrap_or("").to_ascii_lowercase();
    if !(commit_oid.is_empty() || is_hex_oid(&commit_oid)) {
        return None;
    }
    let (line, start_line, side) = match (f.line, f.side, f.start_line) {
        (None, None, None) => (None, None, None),
        (Some(line), Some(side @ (0 | 1)), start) => {
            let start = start.unwrap_or(line);
            if start > line {
                return None;
            }
            (Some(line), Some(start), Some(u8::try_from(side).ok()?))
        }
        _ => return None,
    };
    Some(Anchor {
        path: path.to_owned(),
        line,
        start_line,
        side,
        commit_oid,
    })
}

// ===========================================================================
// A review's comments
// ===========================================================================

/// A `comment`, flattened for [`group_review_comments`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    /// `$id`.
    pub id: String,
    /// `$ownerId`.
    pub owner: String,
    /// `reviewId`, when present.
    #[serde(default)]
    pub review_id: Option<String>,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// A review's comments and how many of those it announced have landed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewGroup {
    /// The review's comments, `(createdAt, id)` order.
    pub comments: Vec<String>,
    /// `comments.len()`.
    pub landed: u32,
    /// The review's `commentCount` (0 when absent).
    pub expected: u32,
}

/// The comments of review `review_id` by `reviewer` (spec §5.5): `reviewId == review_id` **and**
/// owner `== reviewer` (consensus already requires both; readers check again), in
/// `(createdAt, id)` order. `expected` is the review's `commentCount`; `landed < expected`
/// means a submit is still in flight or was interrupted.
#[must_use]
pub fn group_review_comments(
    review_id: &str,
    reviewer: &str,
    comment_count: Option<u32>,
    comments: &[ReviewComment],
) -> ReviewGroup {
    let mut mine: Vec<&ReviewComment> = comments
        .iter()
        .filter(|c| c.review_id.as_deref() == Some(review_id) && c.owner == reviewer)
        .collect();
    mine.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    ReviewGroup {
        landed: u32::try_from(mine.len()).unwrap_or(u32::MAX),
        comments: mine.into_iter().map(|c| c.id.clone()).collect(),
        expected: comment_count.unwrap_or(0),
    }
}

// ===========================================================================
// Suggestions
// ===========================================================================

/// One ```` ```suggestion ```` block: the replacement text for the anchored lines, without a
/// trailing newline (an empty suggestion deletes the lines).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// The replacement lines joined by `\n`.
    pub text: String,
}

/// How many `ch` characters `s` starts with (all ASCII, so bytes = characters).
fn run_of(s: &str, ch: char) -> usize {
    s.len() - s.trim_start_matches(ch).len()
}

/// The whitespace of fences: ASCII space, tab and CR only. Rust's and JavaScript's `trim` and
/// whitespace splits disagree on Unicode (U+0085, U+FEFF), and both ports must agree.
fn is_fence_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\r')
}

/// A fence opener: up to three spaces, then three or more backticks or tildes. Returns the
/// indentation, the fence character, its run length and the info string's first word.
fn fence_open(line: &str) -> Option<(usize, char, usize, &str)> {
    let indent = run_of(line, ' ');
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let ch = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let run = run_of(rest, ch);
    if run < 3 {
        return None;
    }
    let info = rest[run..].trim_matches(is_fence_space);
    // A backtick fence's info string may not contain a backtick (CommonMark).
    if ch == '`' && info.contains('`') {
        return None;
    }
    let word = info.split(is_fence_space).next().unwrap_or("");
    Some((indent, ch, run, word))
}

/// Whether `line` closes a fence of `ch` × `run`: up to three spaces, at least `run` of `ch`,
/// then only fence whitespace.
fn fence_close(line: &str, ch: char, run: usize) -> bool {
    let indent = run_of(line, ' ');
    if indent > 3 {
        return false;
    }
    let rest = &line[indent..];
    let n = run_of(rest, ch);
    n >= run && rest[n..].chars().all(is_fence_space)
}

/// A content line with up to `indent` leading spaces removed (the opener's indentation,
/// CommonMark).
fn strip_indent(line: &str, indent: usize) -> &str {
    &line[run_of(line, ' ').min(indent)..]
}

/// The ```` ```suggestion ```` blocks of a comment body, in order (spec §5.6). Line endings are
/// normalised (`\r\n` and a lone `\r` → `\n`); a fence is three or more backticks or tildes
/// after at most three spaces, closed by a run at least as long of the same character
/// followed only by ASCII space, tab or CR; the info string's first word (split on those)
/// must be `suggestion`. Content lines lose up to the opener's indentation. Blocks inside
/// other fences are not suggestions. An unclosed suggestion fence runs to the end of the body
/// (CommonMark), and still counts.
#[must_use]
pub fn parse_suggestions(body: &str) -> Vec<Suggestion> {
    let text = body.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    let mut open: Option<(usize, char, usize, bool, Vec<&str>)> = None;
    for line in text.split('\n') {
        match &mut open {
            Some((indent, ch, run, is_suggestion, lines)) => {
                if fence_close(line, *ch, *run) {
                    if *is_suggestion {
                        out.push(Suggestion {
                            text: lines.join("\n"),
                        });
                    }
                    open = None;
                } else {
                    lines.push(strip_indent(line, *indent));
                }
            }
            None => {
                if let Some((indent, ch, run, word)) = fence_open(line) {
                    open = Some((indent, ch, run, word == "suggestion", Vec::new()));
                }
            }
        }
    }
    if let Some((_, _, _, true, lines)) = open {
        out.push(Suggestion {
            text: lines.join("\n"),
        });
    }
    out
}

/// Why [`apply_suggestion`] refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SuggestionError {
    /// `start_line` is 0, or after `end_line`.
    BadRange,
    /// `end_line` is past the file's last line.
    OutOfRange,
}

/// Replace lines `start_line..=end_line` (1-based) of `file` with `text` (spec §5.6). The file's
/// newline style (`\r\n` when its first line ending is one, else `\n`) and its trailing-newline
/// state are kept; `text`'s own line endings are normalised to the file's. An empty `text`
/// deletes the lines.
///
/// # Errors
///
/// [`SuggestionError::BadRange`] for `start_line == 0` or `start_line > end_line`;
/// [`SuggestionError::OutOfRange`] when `end_line` is past the last line.
pub fn apply_suggestion(
    file: &str,
    start_line: u64,
    end_line: u64,
    text: &str,
) -> Result<String, SuggestionError> {
    if start_line == 0 || start_line > end_line {
        return Err(SuggestionError::BadRange);
    }
    let crlf = file
        .find('\n')
        .is_some_and(|i| i > 0 && file.as_bytes()[i - 1] == b'\r');
    let nl = if crlf { "\r\n" } else { "\n" };
    let trailing = file.ends_with('\n');
    let normalized = file.replace("\r\n", "\n");
    let body = normalized.strip_suffix('\n').unwrap_or(&normalized);
    let mut lines: Vec<&str> = if normalized.is_empty() {
        Vec::new()
    } else {
        body.split('\n').collect()
    };
    let (start, end) = (
        usize::try_from(start_line).map_err(|_| SuggestionError::OutOfRange)?,
        usize::try_from(end_line).map_err(|_| SuggestionError::OutOfRange)?,
    );
    if end > lines.len() {
        return Err(SuggestionError::OutOfRange);
    }
    let replacement = text.replace("\r\n", "\n");
    let new: Vec<&str> = if replacement.is_empty() {
        Vec::new()
    } else {
        replacement.split('\n').collect()
    };
    lines.splice(start - 1..end, new);
    let mut out = lines.join(nl);
    if trailing && !lines.is_empty() {
        out.push_str(nl);
    }
    Ok(out)
}

// ===========================================================================
// Linked issues
// ===========================================================================

const LINK_VERBS: [&str; 9] = [
    "close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved",
];

/// The issue numbers `text` closes (spec §5.7): a verb (`close[sd]`, `fix(e[sd])`,
/// `resolve[sd]`, any case, as a whole word), optional `:`, whitespace, then `#n` with `n` a
/// positive number that fits `u32` and is not followed by a word character. Deduplicated,
/// ascending.
#[must_use]
pub fn linked_issues(text: &str) -> Vec<u32> {
    let bytes = text.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut out = BTreeSet::new();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_alphabetic() || (i > 0 && is_word(bytes[i - 1])) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
            i += 1;
        }
        let word = text[start..i].to_ascii_lowercase();
        if i < bytes.len() && is_word(bytes[i]) || !LINK_VERBS.contains(&word.as_str()) {
            continue;
        }
        let mut j = i;
        if j < bytes.len() && bytes[j] == b':' {
            j += 1;
        }
        let ws = j;
        while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
            j += 1;
        }
        if j == ws || j >= bytes.len() || bytes[j] != b'#' {
            continue;
        }
        j += 1;
        let digits = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j == digits || (j < bytes.len() && is_word(bytes[j])) {
            continue;
        }
        if let Ok(n) = text[digits..j].parse::<u32>() {
            if n > 0 {
                out.insert(n);
            }
        }
        i = j;
    }
    out.into_iter().collect()
}

#[cfg(test)]
mod bounded_time {
    //! Hang / blow-up guards for the suggestion parser and the replacement, which read
    //! untrusted, permanent comment bodies (the Rust side of forge-web's `render-fuzz`). Each
    //! batch runs on its own thread with a wall-clock deadline, so a regression to quadratic
    //! time fails here instead of hanging CI. The budgets are forge-web's: ≤ 250 ms per input
    //! up to 20 KB, ≤ 3 s at 1 MiB (debug build; release is ~10× faster).

    use super::{apply_suggestion, parse_suggestions};
    use std::time::{Duration, Instant};

    const KB20: usize = 20_000;
    const MIB: usize = 1 << 20;

    /// Run `f` over `inputs` on a thread; fail on a hang (`deadline`) or a slow input.
    fn expect_fast<T: Send + 'static>(label: &str, inputs: Vec<T>, budget: Duration, f: fn(&T)) {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut slowest = (Duration::ZERO, 0usize);
            for (i, x) in inputs.iter().enumerate() {
                let t = Instant::now();
                f(x);
                let took = t.elapsed();
                if took > slowest.0 {
                    slowest = (took, i);
                }
            }
            let _ = tx.send(slowest);
        });
        let (took, i) = rx
            .recv_timeout(Duration::from_secs(60))
            .unwrap_or_else(|_| panic!("{label}: batch did not finish in 60 s (hang)"));
        assert!(
            took < budget,
            "{label}: input #{i} took {took:?} (budget {budget:?})"
        );
    }

    /// `unit` repeated to `size` bytes (then `tail`).
    fn fill(size: usize, unit: &str, tail: &str) -> String {
        unit.repeat((size - tail.len()) / unit.len()) + tail
    }

    /// A small deterministic PRNG (xorshift), so a failure reproduces.
    fn nasty(seed: u64, count: usize, max_len: usize) -> Vec<String> {
        const ALPHABET: [&str; 14] = [
            "```",
            "~~~",
            "`",
            "~",
            "suggestion",
            " ",
            "\t",
            "\r",
            "\n",
            "\r\n",
            "x",
            "   ",
            "````",
            "\u{2028}",
        ];
        let mut state = seed | 1;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        (0..count)
            .map(|_| {
                let target = usize::try_from(next() % max_len as u64).unwrap_or(0);
                let mut s = String::new();
                while s.len() < target {
                    let tok = ALPHABET[usize::try_from(next() % 14).unwrap_or(0)];
                    let run = if next() % 10 == 0 {
                        1 + usize::try_from(next() % 2000).unwrap_or(0)
                    } else {
                        1
                    };
                    s.push_str(&tok.repeat(run.min((target - s.len()) / tok.len() + 1)));
                }
                s
            })
            .collect()
    }

    #[allow(clippy::ptr_arg)] // the batch is `Vec<String>`
    fn parse(s: &String) {
        std::hint::black_box(parse_suggestions(s));
    }

    #[test]
    fn parse_suggestions_adversarial_20kb() {
        let inputs = vec![
            format!("```x{}y", " ".repeat(KB20)),
            format!("```suggestion{}y", " ".repeat(KB20)),
            format!("```{}", " ".repeat(KB20)),
            format!("```suggestion{}", "\t".repeat(KB20)),
            format!("```suggestion\n```{}x", " ".repeat(KB20)),
            "`".repeat(KB20),
            "~".repeat(KB20),
            "```\n".repeat(KB20 / 4),
            "```suggestion\n".repeat(KB20 / 14),
            "```suggestion\nx\n```\n".repeat(KB20 / 20),
            format!("   ```suggestion\n{}", "   x\n".repeat(KB20 / 5)),
            "\r".repeat(KB20),
            "\r\n".repeat(KB20 / 2),
        ];
        expect_fast(
            "parse_suggestions",
            inputs,
            Duration::from_millis(250),
            parse,
        );
    }

    #[test]
    fn parse_suggestions_random_20kb() {
        expect_fast(
            "parse_suggestions random",
            nasty(0x5ec0, 300, KB20),
            Duration::from_millis(250),
            parse,
        );
    }

    #[test]
    fn parse_suggestions_one_mib() {
        let mut inputs: Vec<String> = [
            " ",
            "`",
            "~",
            "```\n",
            "```suggestion\n",
            "```suggestion\nx\n```\n",
            "\r",
            "\r\n",
            "\t",
        ]
        .iter()
        .map(|u| fill(MIB, u, ""))
        .collect();
        inputs.push(format!("```x{}", fill(MIB - 4, " ", "y")));
        inputs.push(format!("```suggestion\n```{}", fill(MIB - 20, " ", "x")));
        expect_fast(
            "parse_suggestions 1 MiB",
            inputs,
            Duration::from_secs(3),
            parse,
        );
    }

    #[test]
    fn apply_suggestion_one_mib() {
        let big = fill(MIB, "line\n", "");
        let lines = (MIB / 5) as u64;
        let inputs: Vec<(String, u64, u64, String)> = vec![
            (big.clone(), 1, lines, String::new()),
            (big.clone(), 1, 1, fill(MIB, "\n", "")),
            (big, lines, lines, fill(MIB, "x\r\n", "")),
            (fill(MIB, "a\r\n", ""), 2, 3, "b".into()),
            (fill(MIB, "\n", ""), 1, 1, "x".into()),
        ];
        expect_fast(
            "apply_suggestion 1 MiB",
            inputs,
            Duration::from_secs(3),
            |(f, a, b, t)| {
                std::hint::black_box(apply_suggestion(f, *a, *b, t).ok());
            },
        );
    }
}
