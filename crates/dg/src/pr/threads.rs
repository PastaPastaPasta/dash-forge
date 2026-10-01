//! The review state `dg pr view` shows, folded from a PR's documents (review-parity §2.5 C3,
//! R7, R8, R9, R11, R12, R13). Pure: every input was read and proof-checked before.
//!
//! * [`threads`] — inline threads (an anchored root and its replies) with their anchor, whether
//!   they are outdated (not on the current head) and resolved, and the suggestions in them;
//!   general comments apart. The same grouping as forge-web `placeThreads` (by head; the web
//!   also marks a line the diff no longer shows as outdated, which the CLI cannot see
//!   without the diff).
//! * [`reviewer_rows`] — one row per reviewer or requested reviewer: approved, changes
//!   requested, commented, awaiting, stale, dismissed, or doesn't count (not a member).
//! * [`since_your_review`] — "new commits since your review" for the viewer.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use forge_core::collab::v2::{Comment, Review};
use forge_core::rules::v2::{
    anchor_of, parse_suggestions, Anchor, Approvals, PrReviewState, RoleOracle,
};
use forge_core::rules::Verdict;

/// One comment of a thread.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadComment {
    /// Document `$id`.
    pub id: String,
    /// `$ownerId`.
    pub author: String,
    /// The text.
    pub body: String,
    /// The review it was submitted with, if any.
    pub review_id: Option<String>,
    /// The ```` ```suggestion ```` blocks in it (their replacement text).
    pub suggestions: Vec<String>,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

impl ThreadComment {
    fn of(c: &Comment) -> Self {
        Self {
            id: c.document_id.clone(),
            author: c.author.clone(),
            body: c.body.clone(),
            review_id: c.review_id.clone(),
            suggestions: parse_suggestions(&c.body)
                .into_iter()
                .map(|s| s.text)
                .collect(),
            created_at: c.created_at,
        }
    }
}

/// An inline thread: an anchored root comment and its replies.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    /// The root comment's id (what `dg pr resolve` names).
    pub id: String,
    /// Where it points.
    pub anchor: Anchor,
    /// `path:line`, `path:3-5 (old)`, or `path`.
    pub location: String,
    /// Not on the PR's current head (made on an older head, or with no head recorded).
    pub outdated: bool,
    /// The newest resolve / unresolve of it was a resolve.
    pub resolved: bool,
    /// The root, then its replies, oldest first.
    pub comments: Vec<ThreadComment>,
    /// A mirrored root's source diff hunk (QW2-010; shown as text, [`Comment::shown_hunk`]).
    pub diff_hunk: Option<String>,
}

/// A PR's conversations.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversations {
    /// Inline threads, by path then line.
    pub threads: Vec<Thread>,
    /// General comments (not anchored, nor replies to an anchored comment), oldest first.
    pub general: Vec<ThreadComment>,
}

/// The root a comment replies to (following `replyTo` among `by_id`), or itself; a cycle or
/// a missing parent stops the walk.
pub fn root_of<'a>(c: &'a Comment, by_id: &BTreeMap<&str, &'a Comment>) -> &'a Comment {
    let mut cur = c;
    let mut seen = BTreeSet::from([c.document_id.as_str()]);
    while let Some(parent) = cur.reply_to.as_deref().and_then(|p| by_id.get(p)).copied() {
        if !seen.insert(parent.document_id.as_str()) {
            break;
        }
        cur = parent;
    }
    cur
}

/// The id of the thread root of comment `id` among `comments`, or `None` when it is not one
/// of them (what `dg pr resolve` names: any comment of a thread resolves the thread).
pub fn root_id(comments: &[Comment], id: &str) -> Option<String> {
    let by_id: BTreeMap<&str, &Comment> = comments
        .iter()
        .map(|c| (c.document_id.as_str(), c))
        .collect();
    let c = by_id.get(id)?;
    Some(root_of(c, &by_id).document_id.clone())
}

/// Group `comments` (oldest first) into inline threads and general comments; `head` is the
/// PR's current head, `resolved` the fold's resolved roots.
pub fn threads(comments: &[Comment], head: &str, resolved: &[String]) -> Conversations {
    let by_id: BTreeMap<&str, &Comment> = comments
        .iter()
        .map(|c| (c.document_id.as_str(), c))
        .collect();
    let resolved: BTreeSet<&str> = resolved.iter().map(String::as_str).collect();
    // By root id; the final sort orders the threads, so the map's order does not matter.
    let mut open: BTreeMap<String, (Anchor, Option<String>, Vec<ThreadComment>)> = BTreeMap::new();
    let mut general = Vec::new();
    for c in comments {
        let root = root_of(c, &by_id);
        let Some(anchor) = anchor_of(&root.anchor) else {
            general.push(ThreadComment::of(c));
            continue;
        };
        open.entry(root.document_id.clone())
            .or_insert_with(|| (anchor, root.shown_hunk().map(str::to_string), Vec::new()))
            .2
            .push(ThreadComment::of(c));
    }
    let head = head.to_ascii_lowercase();
    let mut threads: Vec<Thread> = open
        .into_iter()
        .map(|(id, (anchor, diff_hunk, mut comments))| {
            // The root first, whatever order replies arrived in.
            comments.sort_by_key(|c| (c.id != id, c.created_at));
            Thread {
                location: crate::pr::inline::location(
                    &anchor.path,
                    anchor.start_line,
                    anchor.line,
                    anchor.side.map(u64::from),
                ),
                outdated: anchor.commit_oid.is_empty() || anchor.commit_oid != head,
                resolved: resolved.contains(id.as_str()),
                id,
                anchor,
                comments,
                diff_hunk,
            }
        })
        .collect();
    threads.sort_by(|a, b| {
        (&a.anchor.path, a.anchor.line, &a.id).cmp(&(&b.anchor.path, b.anchor.line, &b.id))
    });
    Conversations { threads, general }
}

/// Drop the hunk of each thread whose root's signer `trusted` does not admit to mirror (QW2-010:
/// the hunk is the source's text only when a mirror wrote it).
pub fn drop_untrusted_hunks(conv: &mut Conversations, trusted: impl Fn(&str) -> bool) {
    for t in &mut conv.threads {
        let root_trusted = t.comments.first().is_some_and(|c| trusted(&c.author));
        if !root_trusted {
            t.diff_hunk = None;
        }
    }
}

/// A reviewer's standing on the PR.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Standing {
    /// Their approval counts on the current head.
    Approved,
    /// Their request for changes counts on the current head.
    ChangesRequested,
    /// Their newest review is a comment.
    Commented,
    /// Requested, and no review since the request.
    Awaiting,
    /// Their verdict is on an older head.
    Stale,
    /// Their newest review was dismissed.
    Dismissed,
    /// They are not a maintainer or writer, so their verdict does not count.
    NotMember,
    /// They opened the PR: their own verdict never counts (GitHub: authors can't approve their
    /// own PR), as `count_approvals` rules.
    Author,
}

impl Standing {
    /// Human wording.
    pub fn label(self) -> &'static str {
        match self {
            Standing::Approved => "approved",
            Standing::ChangesRequested => "changes requested",
            Standing::Commented => "commented",
            Standing::Awaiting => "awaiting review",
            Standing::Stale => "stale — new commits since",
            Standing::Dismissed => "dismissed",
            Standing::NotMember => "doesn't count (not a maintainer or writer)",
            Standing::Author => "author, not counted",
        }
    }
}

/// One row of the "Reviewers" card.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewerRow {
    /// The reviewer's identity.
    pub identity: String,
    /// Their standing.
    pub state: Standing,
    /// Requested (and not removed); `requestedAt` is the standing request's time.
    pub requested: bool,
    /// When the standing request was made (ms).
    pub requested_at: Option<u64>,
    /// Requested again after they had reviewed.
    pub re_requested: bool,
    /// Their newest review.
    pub review_id: Option<String>,
    /// The head their newest review was on.
    pub reviewed_oid: Option<String>,
    /// Why their newest review was dismissed.
    pub dismiss_reason: Option<String>,
}

/// The newest review per reviewer by `(createdAt, id)`.
fn newest_reviews(reviews: &[Review]) -> BTreeMap<&str, &Review> {
    let mut out: BTreeMap<&str, &Review> = BTreeMap::new();
    for r in reviews {
        let newer = out
            .get(r.reviewer.as_str())
            .is_none_or(|e| (r.created_at, &r.document_id) > (e.created_at, &e.document_id));
        if newer {
            out.insert(&r.reviewer, r);
        }
    }
    out
}

/// One row per reviewer (anyone with a review) and per requested reviewer, requested first,
/// then by identity. `pr_author`'s own approve / request-changes verdict is
/// [`Standing::Author`]: shown, never counted.
pub fn reviewer_rows(
    reviews: &[Review],
    fold: &PrReviewState,
    approvals: &Approvals,
    oracle: &RoleOracle,
    head: &str,
    pr_author: &str,
) -> Vec<ReviewerRow> {
    let newest = newest_reviews(reviews);
    let requested: BTreeMap<&str, u64> = fold
        .requested_reviewers
        .iter()
        .map(|r| (r.identity.as_str(), r.requested_at))
        .collect();
    let dismissed: BTreeMap<&str, &str> = fold
        .dismissed_reviews
        .iter()
        .map(|d| (d.review_id.as_str(), d.reason.as_str()))
        .collect();
    let who: BTreeSet<&str> = newest.keys().chain(requested.keys()).copied().collect();
    let mut rows: Vec<ReviewerRow> = who
        .into_iter()
        .map(|id| {
            let review = newest.get(id).copied();
            let requested_at = requested.get(id).copied();
            let awaiting = requested_at.is_some_and(|at| review.is_none_or(|r| r.created_at <= at));
            let dismissal = review.and_then(|r| dismissed.get(r.document_id.as_str()).copied());
            // What counts comes first, so a row never disagrees with the approvals fold: an older,
            // undismissed verdict on the head still stands when only the newest was dismissed.
            let state = if awaiting {
                Standing::Awaiting
            } else if approvals.approvers.contains(id) {
                Standing::Approved
            } else if approvals.changes_requested.contains(id) {
                Standing::ChangesRequested
            } else if dismissal.is_some() {
                Standing::Dismissed
            } else {
                match review {
                    Some(r)
                        if id == pr_author
                            && matches!(
                                r.verdict,
                                Verdict::Approve
                                    | Verdict::RequestChanges
                                    | Verdict::ApproveNonMember
                                    | Verdict::RequestChangesNonMember
                            ) =>
                    {
                        Standing::Author
                    }
                    // a non-member's verdict (4 / 5) is shown, never counted
                    Some(r)
                        if matches!(
                            r.verdict,
                            Verdict::ApproveNonMember | Verdict::RequestChangesNonMember
                        ) =>
                    {
                        Standing::NotMember
                    }
                    Some(r) if matches!(r.verdict, Verdict::Approve | Verdict::RequestChanges) => {
                        if !oracle.member_at(id, r.created_at) || oracle.current_role(id).is_none()
                        {
                            Standing::NotMember
                        } else if r.commit_oid != head {
                            Standing::Stale
                        } else {
                            // An older verdict on this head that a newer one cleared cannot
                            // happen (newest wins); a dismissed earlier one is covered above.
                            Standing::Commented
                        }
                    }
                    _ => Standing::Commented,
                }
            };
            ReviewerRow {
                identity: id.to_string(),
                state,
                requested: requested_at.is_some(),
                requested_at,
                re_requested: awaiting && review.is_some(),
                review_id: review.map(|r| r.document_id.clone()),
                reviewed_oid: review.map(|r| r.commit_oid.clone()),
                dismiss_reason: dismissal.map(str::to_string),
            }
        })
        .collect();
    rows.sort_by_key(|r| (!r.requested, r.identity.clone()));
    rows
}

/// "New commits since your review": the viewer's newest review is on an older head.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SinceYourReview {
    /// The head the viewer reviewed.
    pub reviewed_oid: String,
    /// The PR's head now.
    pub head_oid: String,
    /// How many times the head moved after that review.
    pub head_updates: usize,
}

/// The marker for `viewer`, or `None` (no review, or their newest review is on the head).
pub fn since_your_review(
    reviews: &[Review],
    fold: &PrReviewState,
    viewer: &str,
) -> Option<SinceYourReview> {
    let mine = newest_reviews(reviews).get(viewer).copied()?;
    if mine.commit_oid == fold.head {
        return None;
    }
    Some(SinceYourReview {
        reviewed_oid: mine.commit_oid.clone(),
        head_oid: fold.head.clone(),
        head_updates: fold
            .head_updates
            .iter()
            .filter(|h| h.created_at >= mine.created_at)
            .count(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::rules::v2::{
        AnchorFields, Dismissal, HeadUpdate, Membership, RequestedReviewer, Role,
    };

    const H1: &str = "1111111111111111111111111111111111111111";
    const H2: &str = "2222222222222222222222222222222222222222";

    fn comment(
        id: &str,
        reply_to: Option<&str>,
        anchor: Option<(&str, u64, Option<u64>, &str)>,
        at: u64,
    ) -> Comment {
        Comment {
            document_id: id.into(),
            author: "rev".into(),
            body: format!("body {id}"),
            reply_to: reply_to.map(Into::into),
            review_id: None,
            anchor: anchor.map_or_else(AnchorFields::default, |(path, line, start, oid)| {
                AnchorFields {
                    path: Some(path.into()),
                    line: Some(line),
                    start_line: start,
                    side: Some(1),
                    commit_oid: Some(oid.into()),
                }
            }),
            created_at: at,
            imported: None,
            diff_hunk: None,
        }
    }

    fn review(id: &str, who: &str, verdict: Verdict, oid: &str, at: u64) -> Review {
        Review {
            document_id: id.into(),
            reviewer: who.into(),
            verdict,
            commit_oid: oid.into(),
            body: String::new(),
            comment_count: None,
            created_at: at,
            imported: None,
        }
    }

    fn fold(head: &str) -> PrReviewState {
        PrReviewState {
            head: head.into(),
            head_updates: Vec::new(),
            requested_reviewers: Vec::new(),
            resolved_threads: Vec::new(),
            dismissed_reviews: Vec::new(),
            milestone: None,
        }
    }

    /// QW2-010: a mirrored root's source hunk heads its thread; a native comment's never does.
    #[test]
    fn a_mirrored_thread_carries_its_hunk() {
        let mut mirrored = comment("m", None, Some(("src/a.rs", 2, None, H1)), 1);
        mirrored.diff_hunk = Some("@@ -1,2 +1,2 @@\n a\n+b".into());
        mirrored.imported = Some(forge_core::collab::Imported::default());
        let mut native = comment("n", None, Some(("src/b.rs", 2, None, H1)), 2);
        native.diff_hunk = Some("@@ -1 +1 @@\n+forged".into());
        let mut conv = threads(&[mirrored, native], H2, &[]);
        let hunks = |c: &Conversations| -> Vec<Option<String>> {
            c.threads.iter().map(|t| t.diff_hunk.clone()).collect()
        };
        assert_eq!(
            hunks(&conv),
            [Some("@@ -1,2 +1,2 @@\n a\n+b".to_string()), None]
        );
        // a signer who may not mirror shows none
        drop_untrusted_hunks(&mut conv, |who| who != "rev");
        assert_eq!(hunks(&conv), [None, None]);
    }

    #[test]
    fn threads_group_replies_under_their_root_and_mark_outdated_and_resolved() {
        let comments = vec![
            comment("a", None, Some(("src/b.rs", 5, Some(3), H1)), 1),
            comment("g", None, None, 2),
            comment("r1", Some("a"), None, 3),
            comment("c", None, Some(("src/a.rs", 2, None, H2)), 4),
            // A reply to a reply lands in the root's thread.
            comment("r2", Some("r1"), None, 5),
            // A reply to a general comment stays general.
            comment("gr", Some("g"), None, 6),
        ];
        let conv = threads(&comments, H2, &["a".to_string()]);
        let ids: Vec<&str> = conv.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["c", "a"], "by path");
        let a = &conv.threads[1];
        assert_eq!(a.location, "src/b.rs:3-5");
        assert!(a.outdated, "made on the older head");
        assert!(a.resolved);
        assert_eq!(
            a.comments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["a", "r1", "r2"]
        );
        assert!(!conv.threads[0].outdated);
        assert!(!conv.threads[0].resolved);
        assert_eq!(
            conv.general
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            ["g", "gr"]
        );
    }

    #[test]
    fn a_reply_cycle_does_not_hang() {
        let comments = vec![
            comment("x", Some("y"), None, 1),
            comment("y", Some("x"), None, 2),
        ];
        let conv = threads(&comments, H1, &[]);
        assert_eq!(conv.general.len(), 2);
    }

    #[test]
    fn suggestions_are_listed_per_comment() {
        let mut c = comment("s", None, Some(("a", 1, None, H1)), 1);
        c.body = "nit\n\n```suggestion\nlet x = 1;\n```".into();
        let conv = threads(&[c], H1, &[]);
        assert_eq!(conv.threads[0].comments[0].suggestions, ["let x = 1;"]);
    }

    #[test]
    fn reviewer_rows_cover_every_standing() {
        let oracle = RoleOracle::new(vec![
            Membership {
                identity: "m".into(),
                role: Role::Maintainer,
                created_at: 0,
            },
            Membership {
                identity: "w".into(),
                role: Role::Writer,
                created_at: 0,
            },
            Membership {
                identity: "d".into(),
                role: Role::Writer,
                created_at: 0,
            },
            Membership {
                identity: "s".into(),
                role: Role::Writer,
                created_at: 0,
            },
            Membership {
                identity: "auth".into(),
                role: Role::Maintainer,
                created_at: 0,
            },
        ]);
        let reviews = vec![
            review("r-m", "m", Verdict::Approve, H2, 10),
            review("r-w", "w", Verdict::RequestChanges, H2, 11),
            review("r-s", "s", Verdict::Approve, H1, 5),
            review("r-d", "d", Verdict::RequestChanges, H1, 6),
            review("r-x", "stranger", Verdict::Approve, H2, 12),
            review("r-c", "chatty", Verdict::Comment, H2, 13),
            review("r-q", "q", Verdict::Approve, H1, 1),
            review("r-a", "auth", Verdict::Approve, H2, 14),
        ];
        let mut f = fold(H2);
        f.dismissed_reviews = vec![Dismissal {
            review_id: "r-d".into(),
            actor: "m".into(),
            reason: "stale".into(),
            created_at: 20,
        }];
        f.requested_reviewers = vec![
            RequestedReviewer {
                identity: "q".into(),
                requested_at: 7,
            },
            RequestedReviewer {
                identity: "new".into(),
                requested_at: 8,
            },
        ];
        let approvals = forge_core::rules::v2::count_approvals(
            &reviews
                .iter()
                .map(|r| forge_core::rules::v2::Review {
                    id: r.document_id.clone(),
                    reviewer: r.reviewer.clone(),
                    verdict: r.verdict.code(),
                    commit_oid: r.commit_oid.clone(),
                    created_at: r.created_at,
                })
                .collect::<Vec<_>>(),
            &oracle,
            H2,
            &BTreeSet::from(["r-d".to_string()]),
            "auth",
        );
        // The PR author's own approval (a maintainer's, on the head) never counts (QW-003).
        assert!(!approvals.approvers.contains("auth"), "{approvals:?}");
        let rows = reviewer_rows(&reviews, &f, &approvals, &oracle, H2, "auth");
        let state: BTreeMap<&str, (Standing, bool)> = rows
            .iter()
            .map(|r| (r.identity.as_str(), (r.state, r.re_requested)))
            .collect();
        assert_eq!(state["m"].0, Standing::Approved);
        assert_eq!(state["w"].0, Standing::ChangesRequested);
        assert_eq!(state["s"].0, Standing::Stale);
        assert_eq!(state["d"].0, Standing::Dismissed);
        assert_eq!(state["stranger"].0, Standing::NotMember);
        assert_eq!(state["chatty"].0, Standing::Commented);
        assert_eq!(state["auth"].0, Standing::Author);
        assert_eq!(
            state["q"],
            (Standing::Awaiting, true),
            "re-requested after reviewing"
        );
        assert_eq!(state["new"], (Standing::Awaiting, false));
        // Requested reviewers first.
        assert!(rows[0].requested && rows[1].requested);
        assert_eq!(
            rows.iter()
                .find(|r| r.identity == "d")
                .unwrap()
                .dismiss_reason
                .as_deref(),
            Some("stale")
        );
    }

    #[test]
    fn new_commits_since_your_review() {
        let reviews = vec![review("r", "me", Verdict::RequestChanges, H1, 10)];
        let mut f = fold(H2);
        f.head_updates = vec![
            HeadUpdate {
                oid: H1.into(),
                actor: "a".into(),
                created_at: 5,
                id: "h0".into(),
            },
            HeadUpdate {
                oid: H2.into(),
                actor: "a".into(),
                created_at: 15,
                id: "h1".into(),
            },
        ];
        let m = since_your_review(&reviews, &f, "me").unwrap();
        assert_eq!((m.reviewed_oid.as_str(), m.head_updates), (H1, 1));
        assert!(since_your_review(&reviews, &f, "other").is_none());
        assert!(
            since_your_review(&reviews, &fold(H1), "me").is_none(),
            "on the head"
        );
    }
}
