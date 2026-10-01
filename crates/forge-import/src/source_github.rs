//! GitHub → [`SrcCollab`]: issues, pull requests, comments, reviews, labels and releases,
//! mapped to what the forge-v2 mirror should hold.
//!
//! * Issues and PRs are listed in GitHub's number order (one sequence for both). Forge numbers
//!   them densely as they are created, so a fresh mirror of a repository with no deleted items
//!   numbers identically; each keeps its GitHub number as its upstream number
//!   ([`crate::sink`]).
//! * The GitHub author cannot sign, so the mirror identity writes every document. The body
//!   opens with *"Mirrored from github.com/o/r#123 by @bob"*, and `imported`
//!   `{author, createdAt, url}` records the original; `imported.url` (the GitHub
//!   `html_url`) is the idempotency key.
//! * State is replayed by the mirror identity (who must be a maintainer or writer): close,
//!   reopen, merge (with the merge commit), draft and ready as transitions, labels as events.
//! * Release assets are referenced (GitHub download URL + sha256 when GitHub reports one),
//!   never re-uploaded.
//!
//! With `since`, only issues/PRs updated since then are listed, and only comments updated
//! since then; an item's whole desired state is still compared on chain, so nothing depends
//! on the window being exact.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::Result;

use forge_core::collab::v2::TargetKind;
use forge_core::collab::{CommentAnchor, ReleaseAsset, Verdict};
use forge_core::rules::v2::CloseReason;

use crate::github::{iso8601_to_unix, GhComment, GhIssue, GithubClient, GithubRepoRef};
use crate::model::{
    self, SrcCloseReason, SrcCollab, SrcComment, SrcLabel, SrcPatch, SrcRelease, SrcReview,
    SrcTarget,
};
use crate::source::{Classes, Source, SourceMeta};

/// A GitHub repository as a [`Source`].
pub struct GithubSource {
    repo: GithubRepoRef,
    gh: GithubClient,
}

impl GithubSource {
    /// Read `repo` through `gh`.
    pub fn new(repo: GithubRepoRef) -> Self {
        Self {
            gh: GithubClient::new(repo.clone()),
            repo,
        }
    }
}

impl Source for GithubSource {
    fn display(&self) -> String {
        format!("github.com/{}", self.repo.slug())
    }

    fn default_name(&self) -> String {
        self.repo.repo.to_ascii_lowercase()
    }

    fn meta(&self) -> Result<SourceMeta> {
        let m = self.gh.repo_meta()?;
        Ok(SourceMeta {
            default_branch: m.default_branch,
            description: m.description,
        })
    }

    fn collect(
        &self,
        classes: Classes,
        since: Option<&str>,
        revisit: &[u32],
        limit: usize,
    ) -> Result<SrcCollab> {
        let mut out = collect(&self.gh, &self.repo, classes, since, limit)?;
        if classes.prs && since.is_some() {
            let have: BTreeSet<u32> = out.targets.iter().map(|t| t.number).collect();
            let missing: Vec<u64> = revisit
                .iter()
                .filter(|n| !have.contains(n))
                .map(|&n| u64::from(n))
                .collect();
            if !missing.is_empty() {
                // Each one in full (no `since`: its thread is diffed on chain anyway). One that
                // cannot be read (deleted at GitHub) is warned about and dropped: it must not
                // fail every later run.
                let mut items = Vec::with_capacity(missing.len());
                for &n in &missing {
                    match self.gh.issue(n) {
                        Ok(i) => items.push(i),
                        Err(e) if gone_at_github(&e) => out.warnings.push(format!(
                            "#{n} (a merge to prove again) is gone from GitHub, so it is not \
                             revisited any more: {e:#}"
                        )),
                        Err(e) => {
                            // Kept for the next run: the run is partial, so the state (and
                            // the list) do not advance.
                            out.incomplete = true;
                            out.warnings.push(format!(
                                "#{n} (a merge to prove again) could not be read this run: {e:#}"
                            ));
                        }
                    }
                }
                let revisited =
                    targets(&self.gh, &self.repo, &items, classes, None, true, &mut out)?;
                out.targets.extend(revisited);
                out.targets.sort_by_key(|t| t.number);
            }
        }
        Ok(out)
    }

    fn sync_mirror(&self, dir: &Path) -> Result<()> {
        self.gh.sync_mirror(dir)
    }

    fn fetch_bases(
        &self,
        dir: &Path,
        bases: &[String],
        treeless: bool,
    ) -> Result<BTreeMap<String, crate::gitsync::Unfetched>> {
        crate::gitsync::fetch_proof_bases(
            dir,
            &self.gh.clone_url(),
            bases,
            treeless,
            crate::github::git_auth().as_ref(),
        )
    }

    fn pull_head_prefix(&self) -> &'static str {
        "refs/pull/"
    }
}

/// Whether `e` says the item no longer exists at GitHub (HTTP 404 or 410, as `gh api` reports
/// them), rather than a failure a later run may not meet.
fn gone_at_github(e: &anyhow::Error) -> bool {
    let s = format!("{e:#}");
    s.contains("HTTP 404") || s.contains("HTTP 410")
}

/// Whether `e` is GitHub refusing one item's sub-listing (its reviews, conversation comments
/// or review comments) with a client error: HTTP 404, 410, 422 or 451, as `gh api` reports
/// them (`gh: Unprocessable Entity (HTTP 422)`). Not 401 or 403 (the token, not the item:
/// they fail the run), and not a rate limit or a 5xx (retried in [`crate::github`], and
/// failing the run once the retries run out).
fn refused_for_item(e: &anyhow::Error) -> bool {
    let s = format!("{e:#}");
    ["404", "410", "422", "451"]
        .iter()
        .any(|code| s.contains(&format!("(HTTP {code})")))
}

/// How long to wait before asking once more for a sub-listing GitHub refused.
const REFUSED_RETRY_WAIT: std::time::Duration = if cfg!(test) {
    std::time::Duration::ZERO
} else {
    std::time::Duration::from_secs(10)
};

/// One item's sub-listing (`what`: its reviews, comments or review comments), or `None` when
/// GitHub refuses it for that item ([`refused_for_item`]) twice, `REFUSED_RETRY_WAIT` apart:
/// the item is then mirrored without it. A warning names the item and what was left out, and
/// the run is incomplete, so it ends partial and `--state` does not advance: the next run reads
/// the item again and adds what it gets (comments and reviews are only ever added, found on
/// chain by URL). dashpay/dash#6498's reviews answered 422 once, 97 minutes into a full
/// import, and the whole run failed before writing anything; they read fine minutes later.
fn unless_refused<T>(
    list: impl Fn() -> Result<Vec<T>>,
    number: u64,
    what: &str,
    gaps: &mut SrcCollab,
) -> Result<Option<Vec<T>>> {
    let first = match list() {
        Err(e) if refused_for_item(&e) => e,
        listed => return listed.map(Some),
    };
    tracing::warn!(
        number,
        part = what,
        error = %format!("{first:#}"),
        "GitHub refused one item's sub-listing; asking once more"
    );
    std::thread::sleep(REFUSED_RETRY_WAIT);
    match list() {
        Err(e) if refused_for_item(&e) => {
            let error = format!("{e:#}");
            tracing::warn!(
                number,
                left_out = what,
                %error,
                "GitHub refused one item's sub-listing again; mirroring the item without it"
            );
            gaps.incomplete = true;
            let w = format!(
                "#{number} is mirrored without its {what}: GitHub refused to list them \
                 ({error}). The run is partial, so the next run reads #{number} again"
            );
            // A PR's thread can be read in full twice in one run (conversation count, then
            // review-comment count): one warning.
            if !gaps.warnings.contains(&w) {
                gaps.warnings.push(w);
            }
            Ok(None)
        }
        listed => listed.map(Some),
    }
}

/// The repository's label definitions.
fn labels(gh: &GithubClient) -> Result<Vec<SrcLabel>> {
    Ok(gh
        .labels()?
        .iter()
        .filter_map(|l| model::label(&l.name, &l.color, l.description.as_deref()))
        .collect())
}

/// Read GitHub into the model. `limit` caps issues + PRs (0 = all).
pub fn collect(
    gh: &GithubClient,
    src: &GithubRepoRef,
    classes: Classes,
    since: Option<&str>,
    limit: usize,
) -> Result<SrcCollab> {
    let mut out = SrcCollab::default();
    if classes.labels {
        out.labels = Some(labels(gh)?);
    }
    if classes.releases {
        out.releases = Some(
            gh.releases()?
                .into_iter()
                .filter(|r| !r.draft && !r.tag_name.is_empty())
                .map(|r| release(&r))
                .collect(),
        );
    }
    if classes.code && classes.prs {
        // A failed listing fails the run (`?`): an empty list here always means "none open".
        out.open_pulls = Some(gh.open_pulls()?);
    }
    if !(classes.issues || classes.prs) {
        return Ok(out);
    }

    let keep = |i: &GhIssue| {
        if i.is_pull_request() {
            classes.prs
        } else {
            classes.issues
        }
    };
    // `--limit` reads only the pages holding the first `limit` items, and then only their
    // threads, one request each: on a repository with thousands of items that is a few
    // requests instead of every comment it ever had. A full run reads the repository-wide
    // listings instead (100 per request beats a request per item).
    // PRs only, and no `since` (the pulls listing cannot filter by update time): the pulls
    // listing, so an issue-heavy repository's issues are not paged through.
    let (mut items, truncated) = if limit > 0 && classes.prs && !classes.issues && since.is_none() {
        gh.first_pulls(limit)?
    } else if limit > 0 {
        gh.first_issues(since, limit, keep)?
    } else {
        (gh.issues(since)?.into_iter().filter(keep).collect(), false)
    };
    items.sort_by_key(|i| i.number);
    out.truncated = truncated;
    out.targets = targets(gh, src, &items, classes, since, limit > 0, &mut out)?;
    Ok(out)
}

/// The model of `items` (sorted by number): each with its thread, and a PR with its detail and
/// reviews. `per_item` reads each item's own thread and detail (a `--limit` run, or a few
/// revisited items); otherwise the repository-wide listings are read once. An item whose own
/// sub-listing GitHub refuses is mirrored without it, noted in `gaps` ([`unless_refused`]).
fn targets(
    gh: &GithubClient,
    src: &GithubRepoRef,
    items: &[GhIssue],
    classes: Classes,
    since: Option<&str>,
    per_item: bool,
    gaps: &mut SrcCollab,
) -> Result<Vec<SrcTarget>> {
    let mut out = Vec::with_capacity(items.len());
    let mut threads = threads(gh, items, classes, since, per_item, gaps)?;

    // PR details from the listing (one call per 100 PRs); a PR the listing missed (it
    // changed mid-read), or any PR of a `--limit` run, is read by its own call.
    let mut pulls = if !per_item && classes.prs && items.iter().any(GhIssue::is_pull_request) {
        gh.pulls(since)?
    } else {
        BTreeMap::new()
    };
    for i in items {
        let Ok(number) = u32::try_from(i.number) else {
            continue;
        };
        let mut t = target(src, i, number);
        if t.close_reason
            .as_ref()
            .is_some_and(|r| r.reason == CloseReason::Duplicate)
        {
            t.close_reason = Some(duplicate_reason(gh, src, i, gaps));
        }
        let mut thread = threads.remove(&i.number).unwrap_or_default();
        let pull = if i.is_pull_request() {
            Some(match pulls.remove(&i.number) {
                Some(p) => p,
                None => gh.pull(i.number)?,
            })
        } else {
            None
        };
        // L-05 for review comments: the issues listing counts only conversation comments, so a
        // PR whose line comments at the source outnumber those the `since` window returned is
        // read in full too. The count is the detail endpoint's (`pulls/{n}`); a PR taken from the
        // `pulls` listing has none (GitHub leaves it out there), so its line comments older than
        // the window stay unread until the item is next read on its own.
        if let Some(p) = &pull {
            let lines = thread.iter().filter(|c| c.path.is_some()).count() as u64;
            if since.is_some() && !per_item && p.review_comments > lines {
                thread = full_thread(gh, i, std::mem::take(&mut thread), gaps)?;
            }
        }
        thread.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        t.comments = thread.iter().map(|c| comment(src, number, c)).collect();
        if let Some(pull) = pull {
            t.kind = TargetKind::Patch;
            t.draft = pull.draft;
            t.merged_oid = pull
                .merged_at
                .as_ref()
                .and(pull.merge_commit_sha.as_deref())
                .and_then(model::oid);
            t.merged_without_sha = pull.merged_at.is_some() && t.merged_oid.is_none();
            let head = model::oid(&pull.head.sha).unwrap_or_else(|| vec![0; 20]);
            let base = if pull.base.ref_name.is_empty() {
                "main".to_string()
            } else {
                pull.base.ref_name.clone()
            };
            // Where it branched from, and the head branch when it is on a fork (L-36, L-37):
            // the patch has no field for either, so the body's provenance block names them.
            // GitHub's names are case-insensitive: `dashpay/Dash` is `dashpay/dash`.
            let from_fork = pull
                .head
                .repo
                .as_ref()
                .is_none_or(|r| !r.full_name.eq_ignore_ascii_case(&src.slug()));
            let head_label = if from_fork && !pull.head.label.is_empty() {
                pull.head.label.clone()
            } else {
                pull.head.ref_name.clone()
            };
            t.body = model::with_pull_origin(&t.body, &pull.base.sha, &head_label, &i.html_url);
            // Only open PRs' heads are pushed (a closed PR's objects are not the mirror's to
            // pay for), so only they name a checkoutable source ref.
            let open_head = classes.code && !i.is_closed();
            t.patch = Some(SrcPatch {
                base_ref_name: format!("refs/heads/{base}"),
                source_ref_name: open_head.then(|| format!("refs/mirror/pull/{number}/head")),
                head_oid: head,
            });
            t.reviews = unless_refused(|| gh.reviews(i.number), i.number, "reviews", gaps)?
                .unwrap_or_default()
                .into_iter()
                .filter_map(|r| review(src, number, &r))
                .collect();
        }
        out.push(t);
    }
    Ok(out)
}

/// Every comment (conversation and review) on `items`, by parent number. `per_item` (a
/// `--limit` run) reads each item's own thread; otherwise the repository-wide listings are
/// read once and filtered (100 per request beats a request per item).
///
/// With `since` those listings hold only the comments updated in the window, so an item seen
/// for the first time (or whose older comments were never mirrored) would get a fraction of its
/// thread (L-05: 1 of 24 on dashpay/dash#6935). An item whose conversation count at the source
/// is more than the window returned is therefore read in full, on its own; comments already on
/// chain are found by URL and not written again.
fn threads(
    gh: &GithubClient,
    items: &[GhIssue],
    classes: Classes,
    since: Option<&str>,
    per_item: bool,
    gaps: &mut SrcCollab,
) -> Result<BTreeMap<u64, Vec<GhComment>>> {
    let mut out: BTreeMap<u64, Vec<GhComment>> = BTreeMap::new();
    if per_item {
        for i in items {
            out.insert(i.number, full_thread(gh, i, Vec::new(), gaps)?);
        }
        return Ok(out);
    }
    if items.is_empty() {
        return Ok(out);
    }
    let wanted: BTreeSet<u64> = items.iter().map(|i| i.number).collect();
    let mut all = gh.issue_comments(since)?;
    if classes.prs {
        all.extend(gh.review_comments(since)?);
    }
    for c in all {
        if let Some(n) = c.number().filter(|n| wanted.contains(n)) {
            out.entry(n).or_default().push(c);
        }
    }
    if since.is_some() {
        for i in items {
            let got = out
                .get(&i.number)
                .map_or(0, |t| t.iter().filter(|c| c.path.is_none()).count() as u64);
            if i.comments > got {
                let windowed = out.remove(&i.number).unwrap_or_default();
                out.insert(i.number, full_thread(gh, i, windowed, gaps)?);
            }
        }
    }
    Ok(out)
}

/// One item's whole thread: its conversation comments, and a PR's review (line) comments.
/// `read` is what was already read of it (the `since` window's comments, from the
/// repository-wide listings): a listing GitHub refuses for this item ([`unless_refused`])
/// keeps what `read` has of that kind instead.
fn full_thread(
    gh: &GithubClient,
    i: &GhIssue,
    read: Vec<GhComment>,
    gaps: &mut SrcCollab,
) -> Result<Vec<GhComment>> {
    let (read_lines, read_conversation): (Vec<_>, Vec<_>) =
        read.into_iter().partition(|c| c.path.is_some());
    let mut thread = if i.comments > 0 {
        unless_refused(
            || gh.comments_on(i.number, None),
            i.number,
            "comments",
            gaps,
        )?
        .unwrap_or(read_conversation)
    } else {
        Vec::new()
    };
    if i.is_pull_request() {
        thread.extend(
            unless_refused(
                || gh.review_comments_on(i.number, None),
                i.number,
                "review comments",
                gaps,
            )?
            .unwrap_or(read_lines),
        );
    }
    Ok(thread)
}

/// A duplicate-closed issue's reason, with its canonical when GitHub names one in this
/// repository (one GraphQL read). A failed read keeps the reason without a canonical, and says
/// so.
fn duplicate_reason(
    gh: &GithubClient,
    src: &GithubRepoRef,
    i: &GhIssue,
    gaps: &mut SrcCollab,
) -> SrcCloseReason {
    let duplicate_of = match gh.duplicate_of(i.number) {
        Ok(n) => n.and_then(|n| u32::try_from(n).ok()),
        Err(e) => {
            gaps.warnings.push(format!(
                "#{} was closed as a duplicate; which issue it duplicates could not be read ({e:#}), so it is mirrored without",
                i.number
            ));
            None
        }
    };
    SrcCloseReason {
        reason: CloseReason::Duplicate,
        duplicate_of: duplicate_of
            .map(|n| (n, format!("https://github.com/{}/issues/{n}", src.slug()))),
    }
}

/// GitHub's `state_reason` of a closed issue as a close reason (`reopened` and `null` are none).
fn close_reason(i: &GhIssue) -> Option<SrcCloseReason> {
    if i.is_pull_request() || !i.is_closed() {
        return None;
    }
    let reason = match i.state_reason.as_deref()? {
        "completed" => CloseReason::Completed,
        "not_planned" => CloseReason::NotPlanned,
        "duplicate" => CloseReason::Duplicate,
        _ => return None,
    };
    Some(SrcCloseReason {
        reason,
        duplicate_of: None,
    })
}

/// `url` with its `#…` fragment replaced by `fragment`: a review comment's URL is its PR's with
/// `#discussion_r<id>`, a review's with `#pullrequestreview-<id>`.
fn sibling_url(url: &str, fragment: &str) -> String {
    let base = url.split_once('#').map_or(url, |(b, _)| b);
    format!("{base}#{fragment}")
}

fn header(src: &GithubRepoRef, number: u32, login: &str, created: u64, kind: &str) -> String {
    format!(
        "> Mirrored from github.com/{}#{number} by @{login} ({kind}, {})\n\n",
        src.slug(),
        model::date(created)
    )
}

fn target(src: &GithubRepoRef, i: &GhIssue, number: u32) -> SrcTarget {
    let created = iso8601_to_unix(&i.created_at);
    let kind = if i.is_pull_request() {
        "pull request"
    } else {
        "issue"
    };
    SrcTarget {
        kind: TargetKind::Issue,
        number,
        title: model::title(&i.title, &format!("#{number}")),
        body: model::body(
            &header(src, number, &i.user.login, created, kind),
            i.body.as_deref().unwrap_or(""),
            &i.html_url,
        ),
        imported: model::imported(&i.user.login, created, &i.html_url),
        closed: i.is_closed(),
        close_reason: close_reason(i),
        merged_oid: None,
        merged_without_sha: false,
        labels: i
            .labels
            .iter()
            .map(|l| model::label_name(&l.name))
            .filter(|l| !l.is_empty())
            .collect(),
        draft: false,
        patch: None,
        comments: Vec::new(),
        reviews: Vec::new(),
    }
}

fn comment(src: &GithubRepoRef, number: u32, c: &GhComment) -> SrcComment {
    let created = iso8601_to_unix(&c.created_at);
    let kind = if c.path.is_some() {
        "review comment"
    } else {
        "comment"
    };
    let anchor = c.path.as_ref().map(|p| review_anchor(c, p));
    let mut text = c.body.clone().unwrap_or_default();
    if let Some(path) = &c.path {
        let line = anchor.as_ref().and_then(|a| a.line);
        text = format!(
            "`{path}`{}\n\n{text}",
            line.map(|l| format!(" line {l}")).unwrap_or_default()
        );
    }
    let in_review = c.path.is_some();
    SrcComment {
        body: model::body(
            &header(src, number, &c.user.login, created, kind),
            &text,
            &c.html_url,
        ),
        imported: model::imported(&c.user.login, created, &c.html_url),
        anchor,
        reply_key: c
            .in_reply_to_id
            .filter(|_| in_review)
            .map(|id| sibling_url(&c.html_url, &format!("discussion_r{id}"))),
        review_key: c
            .pull_request_review_id
            .filter(|_| in_review)
            .map(|id| sibling_url(&c.html_url, &format!("pullrequestreview-{id}"))),
    }
}

/// Where a review comment on `path` sits (QW2-010): on the current diff while GitHub still has
/// its line (`line`, `commit_id`), else where it was made (`original_line`,
/// `original_commit_id`: an outdated comment); a comment on a whole file (`subject_type`
/// `file`) names its path only. The hunk is the source's, trimmed to the original line
/// ([`crate::hunk::trim`]).
fn review_anchor(c: &GhComment, path: &str) -> CommentAnchor {
    let right = c.side.as_deref() != Some("LEFT");
    let file = c.subject_type.as_deref() == Some("file");
    let (commit, line, start) = match c.line {
        Some(l) => (c.commit_id.as_deref(), Some(l), c.start_line),
        None => (
            c.original_commit_id.as_deref().or(c.commit_id.as_deref()),
            c.original_line,
            c.original_start_line,
        ),
    };
    let line = line.filter(|_| !file);
    let diff_hunk = match (c.diff_hunk.as_deref(), c.original_line) {
        (Some(h), Some(l)) if !file => crate::hunk::trim(h, right, l, c.original_start_line),
        _ => None,
    };
    CommentAnchor {
        reply_to: None,
        commit_oid: commit.and_then(model::oid),
        path: Some(model::clip(path, 500, 1000)),
        line,
        // A side goes with a line: an anchor with a side and no line reads as malformed.
        side: line.map(|_| u64::from(right)),
        start_line: start.filter(|&s| line.is_some_and(|l| s < l)),
        review_id: None,
        diff_hunk,
    }
}

fn review(src: &GithubRepoRef, number: u32, r: &crate::github::GhReview) -> Option<SrcReview> {
    let verdict = match r.state.as_str() {
        "APPROVED" => Verdict::Approve,
        "CHANGES_REQUESTED" => Verdict::RequestChanges,
        "COMMENTED" => Verdict::Comment,
        // Pending reviews are private drafts; dismissed ones no longer stand.
        _ => return None,
    };
    let commit_oid = r.commit_id.as_deref().and_then(model::oid)?;
    let created = r.submitted_at.as_deref().map_or(0, iso8601_to_unix);
    Some(SrcReview {
        verdict,
        commit_oid,
        body: model::body(
            &header(
                src,
                number,
                &r.user.login,
                created,
                &format!("review, {}", model::verdict_word(verdict)),
            ),
            r.body.as_deref().unwrap_or(""),
            &r.html_url,
        ),
        imported: model::imported(&r.user.login, created, &r.html_url),
    })
}

fn release(r: &crate::github::GhRelease) -> SrcRelease {
    let assets = r
        .assets
        .iter()
        .map(|a| ReleaseAsset {
            name: model::clip(&a.name, 200, 200),
            sha256: a
                .digest
                .as_deref()
                .and_then(|d| d.strip_prefix("sha256:"))
                .unwrap_or_default()
                .to_string(),
            size_bytes: a.size,
            uris: vec![model::clip(&a.browser_download_url, 300, 300)],
            uri: None,
        })
        .collect();
    let published = r.published_at.as_deref().map(|at| model::Published {
        host: "github.com".into(),
        author: r
            .author
            .as_ref()
            .map(|a| a.login.clone())
            .unwrap_or_default(),
        at: iso8601_to_unix(at),
    });
    model::release(
        &r.tag_name,
        r.name.as_deref(),
        r.body.as_deref(),
        assets,
        r.html_url.clone(),
        published.as_ref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::{GhAsset, GhRelease, GhReview, GhUser};

    fn src() -> GithubRepoRef {
        GithubRepoRef::parse("o/r").unwrap()
    }

    /// QW2-010: a review comment keeps its place (the current line, or where it was made once
    /// outdated, or just its file), its source hunk trimmed, and the keys of its review and
    /// of the root it replies to.
    #[test]
    fn review_comments_keep_their_anchor_hunk_review_and_parent() {
        let c = |v: serde_json::Value| -> GhComment {
            let mut base = serde_json::json!({
                "id": 11, "body": "nit", "user": {"login": "bob"},
                "html_url": "https://github.com/o/r/pull/2#discussion_r11",
                "created_at": "2020-01-02T03:04:05Z",
                "pull_request_url": "https://api.github.com/repos/o/r/pulls/2",
                "path": "a.rs", "side": "RIGHT", "subject_type": "line",
                "commit_id": "ab".repeat(20), "original_commit_id": "cd".repeat(20),
                "pull_request_review_id": 7, "in_reply_to_id": 10,
                "diff_hunk": "@@ -1,2 +1,3 @@\n a\n+b\n c",
                "line": 3, "original_line": 3,
            });
            for (k, x) in v.as_object().unwrap() {
                base[k] = x.clone();
            }
            serde_json::from_value(base).unwrap()
        };
        // on the current diff
        let now = comment(&src(), 2, &c(serde_json::json!({})));
        let a = now.anchor.as_ref().unwrap();
        assert_eq!(
            (a.line, a.side, a.commit_oid.clone()),
            (Some(3), Some(1), model::oid(&"ab".repeat(20)))
        );
        assert_eq!(a.diff_hunk.as_deref(), Some("@@ -1,2 +1,3 @@\n a\n+b\n c"));
        assert_eq!(
            now.review_key.as_deref(),
            Some("https://github.com/o/r/pull/2#pullrequestreview-7")
        );
        assert_eq!(
            now.reply_key.as_deref(),
            Some("https://github.com/o/r/pull/2#discussion_r10")
        );
        // outdated: GitHub drops `line`; it keeps the original line and commit (it had no
        // anchor at all before: a side without a line reads as malformed)
        let old = comment(
            &src(),
            2,
            &c(serde_json::json!({"line": null, "original_line": 2, "original_start_line": 1})),
        );
        let a = old.anchor.as_ref().unwrap();
        assert_eq!((a.line, a.start_line, a.side), (Some(2), Some(1), Some(1)));
        assert_eq!(a.commit_oid, model::oid(&"cd".repeat(20)));
        assert_eq!(a.diff_hunk.as_deref(), Some("@@ -1,1 +1,2 @@\n a\n+b"));
        // a comment on the whole file: its path only
        let file = comment(
            &src(),
            2,
            &c(serde_json::json!({"subject_type": "file", "line": null, "original_line": null})),
        );
        let a = file.anchor.as_ref().unwrap();
        assert_eq!((a.line, a.side, a.diff_hunk.as_deref()), (None, None, None));
        // a conversation comment has neither key
        let talk = comment(&src(), 2, &serde_json::from_value(comment_json(2)).unwrap());
        assert!(talk.anchor.is_none() && talk.review_key.is_none() && talk.reply_key.is_none());
    }

    /// QW-069: GitHub's `state_reason` of a closed issue; a PR or an open issue has none.
    #[test]
    fn a_closed_issue_keeps_its_state_reason() {
        let issue = |state: &str, reason: serde_json::Value| -> GhIssue {
            let mut v = issue_json(1);
            v["state"] = state.into();
            v["state_reason"] = reason;
            serde_json::from_value(v).unwrap()
        };
        let reason = |i: &GhIssue| close_reason(i).map(|r| r.reason);
        assert_eq!(
            reason(&issue("closed", "not_planned".into())),
            Some(CloseReason::NotPlanned)
        );
        assert_eq!(
            reason(&issue("closed", "completed".into())),
            Some(CloseReason::Completed)
        );
        assert_eq!(
            reason(&issue("closed", "duplicate".into())),
            Some(CloseReason::Duplicate)
        );
        assert_eq!(reason(&issue("closed", serde_json::Value::Null)), None);
        assert_eq!(reason(&issue("open", "reopened".into())), None);
        let mut pr = issue("closed", "completed".into());
        pr.pull_request = Some(serde_json::json!({}));
        assert_eq!(reason(&pr), None);
    }

    /// A large repository served from memory: 250 issues and PRs (every third a PR), each
    /// with one conversation comment, and every request recorded.
    struct BigRepo(std::rc::Rc<std::cell::RefCell<Vec<String>>>);

    const BIG: u64 = 250;

    fn issue_json(n: u64) -> serde_json::Value {
        let mut v = serde_json::json!({
            "number": n, "title": format!("item {n}"), "state": "open",
            "user": {"login": "bob"}, "comments": 1,
            "html_url": format!("https://github.com/o/r/issues/{n}"),
            "created_at": "2020-01-02T03:04:05Z",
        });
        if n.is_multiple_of(3) {
            v["pull_request"] = serde_json::json!({});
        }
        v
    }

    fn comment_json(n: u64) -> serde_json::Value {
        serde_json::json!({
            "id": n, "body": "hi", "user": null,
            "html_url": format!("https://github.com/o/r/issues/{n}#issuecomment-{n}"),
            "created_at": "2020-01-02T03:04:05Z",
            "issue_url": format!("https://api.github.com/repos/o/r/issues/{n}"),
        })
    }

    fn pull_json(n: u64) -> serde_json::Value {
        // Every sixth PR is from a fork.
        let head_repo = if n.is_multiple_of(6) {
            "someone/r"
        } else {
            "o/r"
        };
        serde_json::json!({
            "number": n,
            "head": {"ref": "f", "label": format!("{}:f", head_repo.split('/').next().unwrap()),
                     "sha": "ab".repeat(20), "repo": {"full_name": head_repo}},
            "base": {"ref": "main", "label": "o:main", "sha": "cd".repeat(20),
                     "repo": {"full_name": "o/r"}},
        })
    }

    impl BigRepo {
        fn answer(path: &str) -> Vec<serde_json::Value> {
            let rest = path.strip_prefix("repos/o/r/").unwrap();
            let (route, query) = rest.split_once('?').unwrap_or((rest, ""));
            let page: u64 = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("page="))
                .map_or(0, |p| p.parse().unwrap());
            let range = |page: u64| {
                if page == 0 {
                    1..=BIG
                } else {
                    (page - 1) * 100 + 1..=(page * 100).min(BIG)
                }
            };
            let parts: Vec<&str> = route.split('/').collect();
            match parts.as_slice() {
                ["issues"] => range(page).map(issue_json).collect(),
                ["issues", "comments"] => (1..=BIG).map(comment_json).collect(),
                ["issues", n, "comments"] => vec![comment_json(n.parse().unwrap())],
                ["pulls"] => range(page)
                    .filter(|n| n.is_multiple_of(3))
                    .map(pull_json)
                    .collect(),
                ["pulls", "comments"] | ["pulls", _, "comments" | "reviews"] => Vec::new(),
                other => panic!("unexpected request {other:?}"),
            }
        }
    }

    impl crate::github::GhApi for BigRepo {
        fn json(&self, path: &str) -> Result<Vec<u8>> {
            self.0.borrow_mut().push(path.to_string());
            let rest = path.strip_prefix("repos/o/r/pulls/").unwrap_or("");
            if let Ok(n) = rest.parse::<u64>() {
                return Ok(serde_json::to_vec(&pull_json(n))?);
            }
            let issue = path.strip_prefix("repos/o/r/issues/").unwrap_or("");
            if let Ok(n) = issue.parse::<u64>() {
                return Ok(serde_json::to_vec(&issue_json(n))?);
            }
            Ok(serde_json::to_vec(&Self::answer(path))?)
        }

        fn list(&self, path: &str) -> Result<Vec<String>> {
            self.0.borrow_mut().push(format!("{path} (all pages)"));
            Ok(Self::answer(path).iter().map(ToString::to_string).collect())
        }
    }

    fn big_repo() -> (GithubClient, std::rc::Rc<std::cell::RefCell<Vec<String>>>) {
        let log = std::rc::Rc::default();
        let gh = GithubClient::with_api(src(), Box::new(BigRepo(std::rc::Rc::clone(&log))));
        (gh, log)
    }

    /// Review: a revisited PR is dropped only when GitHub says it is gone. The texts are what
    /// `gh api` prints (checked 2026-09-28: `gh: Not Found (HTTP 404)`), as the retry wrapper
    /// keeps them in the error.
    #[test]
    fn only_a_404_or_410_drops_a_revisit() {
        let gone = anyhow::anyhow!("`gh api repos/o/r/issues/9` failed: gh: Not Found (HTTP 404)");
        assert!(gone_at_github(&gone));
        assert!(gone_at_github(&anyhow::anyhow!("gh: Gone (HTTP 410)")));
        let flaky =
            anyhow::anyhow!("`gh api repos/o/r/issues/9` failed: read: operation timed out");
        assert!(!gone_at_github(&flaky));
        assert!(!gone_at_github(&anyhow::anyhow!(
            "gh: Server Error (HTTP 502)"
        )));
    }

    /// [`BigRepo`], where the listings whose path contains a key of `refuse` fail with its
    /// error (what the retry wrapper reports once it gives up), `refusals` times in all, and
    /// PR #6 has one review.
    struct Refusing {
        repo: BigRepo,
        refuse: Vec<(&'static str, &'static str)>,
        refusals: std::cell::Cell<usize>,
    }

    impl crate::github::GhApi for Refusing {
        fn json(&self, path: &str) -> Result<Vec<u8>> {
            self.repo.json(path)
        }

        fn list(&self, path: &str) -> Result<Vec<String>> {
            if let Some((_, err)) = self.refuse.iter().find(|(p, _)| path.contains(p)) {
                if self.refusals.get() > 0 {
                    self.refusals.set(self.refusals.get() - 1);
                    anyhow::bail!("`gh api {path}&page=1` failed: {err}");
                }
            }
            if path.contains("pulls/6/reviews") {
                let r = serde_json::json!({
                    "id": 61, "state": "APPROVED", "user": {"login": "rev"},
                    "commit_id": "ab".repeat(20), "body": "utACK",
                    "html_url": "https://github.com/o/r/pull/6#pullrequestreview-61",
                    "submitted_at": "2020-01-02T03:04:05Z",
                });
                return Ok(vec![r.to_string()]);
            }
            self.repo.list(path)
        }
    }

    fn refusing(refuse: Vec<(&'static str, &'static str)>) -> GithubClient {
        refusing_times(refuse, usize::MAX)
    }

    fn refusing_times(refuse: Vec<(&'static str, &'static str)>, times: usize) -> GithubClient {
        let repo = BigRepo(std::rc::Rc::default());
        let refusals = std::cell::Cell::new(times);
        GithubClient::with_api(
            src(),
            Box::new(Refusing {
                repo,
                refuse,
                refusals,
            }),
        )
    }

    const UNPROCESSABLE: &str = "gh: Unprocessable Entity (HTTP 422)";

    /// dashpay/dash#6498: GitHub answered its reviews listing with a 422, 97 minutes into a full
    /// import, and the whole run failed before writing anything. The PR is mirrored without its
    /// reviews, the warning names it, and the run is incomplete (partial, `--state` held) so the
    /// next run reads it again; every other item keeps all it has.
    #[test]
    fn a_refused_review_listing_leaves_out_only_that_prs_reviews() {
        let gh = refusing(vec![("pulls/3/reviews", UNPROCESSABLE)]);
        let all = Classes::parse("issues,prs").unwrap();
        let out = collect(&gh, &src(), all, None, 0).unwrap();
        assert_eq!(
            out.targets.len(),
            usize::try_from(BIG).unwrap(),
            "every item is mirrored"
        );
        let pr = |n: u32| out.targets.iter().find(|t| t.number == n).unwrap();
        assert_eq!(pr(3).kind, TargetKind::Patch);
        assert!(pr(3).reviews.is_empty());
        assert_eq!(pr(3).comments.len(), 1, "its thread is still mirrored");
        assert_eq!(pr(6).reviews.len(), 1, "another PR keeps its reviews");
        assert!(out.incomplete, "partial, so --state does not advance");
        assert_eq!(out.warnings.len(), 1, "{:?}", out.warnings);
        let w = &out.warnings[0];
        assert!(w.starts_with("#3 is mirrored without its reviews"), "{w}");
        assert!(w.contains("HTTP 422"), "{w}");
    }

    /// The same for a thread read item by item (a `--limit` run, a revisit, or an item whose
    /// window missed comments): a refused conversation or review-comment listing leaves out
    /// just that part of just that item.
    #[test]
    fn a_refused_thread_listing_leaves_out_only_that_part() {
        let gh = refusing(vec![
            ("issues/1/comments", "gh: Not Found (HTTP 404)"),
            (
                "pulls/3/comments",
                "gh: Unavailable For Legal Reasons (HTTP 451)",
            ),
        ]);
        let all = Classes::parse("issues,prs").unwrap();
        let out = collect(&gh, &src(), all, None, 3).unwrap();
        let comments: Vec<usize> = out.targets.iter().map(|t| t.comments.len()).collect();
        assert_eq!(comments, [0, 1, 1], "#3 keeps its conversation comment");
        assert!(out.incomplete);
        assert_eq!(out.warnings.len(), 2, "{:?}", out.warnings);
        assert!(out.warnings[0].starts_with("#1 is mirrored without its comments"));
        assert!(out.warnings[1].starts_with("#3 is mirrored without its review comments"));
    }

    /// #6498's 422 did not repeat: a sub-listing refused once is asked for once more, and a
    /// second answer mirrors the item whole.
    #[test]
    fn a_sub_listing_refused_once_is_read_on_the_second_ask() {
        let gh = refusing_times(vec![("pulls/6/reviews", UNPROCESSABLE)], 1);
        let all = Classes::parse("issues,prs").unwrap();
        let out = collect(&gh, &src(), all, None, 0).unwrap();
        let pr6 = out.targets.iter().find(|t| t.number == 6).unwrap();
        assert_eq!(pr6.reviews.len(), 1);
        assert!(!out.incomplete);
        assert!(out.warnings.is_empty(), "{:?}", out.warnings);
    }

    /// An incremental run: #1 (a PR) has 2 conversation comments and 2 review comments at the
    /// source; the window returned one of each, so its thread is read in full, twice (for each
    /// count). Its review-comment listing is refused: the one the window returned is kept, the
    /// conversation is read whole, and the warning is given once.
    struct LineWindow(std::rc::Rc<std::cell::RefCell<Vec<String>>>);

    impl crate::github::GhApi for LineWindow {
        fn json(&self, path: &str) -> Result<Vec<u8>> {
            let v = match path.split_once('?').map_or(path, |(p, _)| p) {
                // The pulls listing (updated since): none, so #1's detail is read on its own.
                "repos/o/r/pulls" => serde_json::json!([]),
                "repos/o/r/pulls/1" => {
                    let mut p = pull_json(1);
                    p["review_comments"] = 2.into();
                    p
                }
                other => panic!("unexpected {other}"),
            };
            Ok(serde_json::to_vec(&v)?)
        }

        fn list(&self, path: &str) -> Result<Vec<String>> {
            self.0.borrow_mut().push(path.to_string());
            let route = path.split_once('?').map_or(path, |(p, _)| p);
            let c = |id: u64, line: bool| {
                let mut v = serde_json::json!({
                    "id": id, "body": format!("c{id}"), "user": {"login": "bob"},
                    "html_url": format!("https://github.com/o/r/pull/1#c{id}"),
                    "created_at": format!("2020-01-02T03:04:{id:02}Z"),
                });
                if line {
                    v["path"] = "a.rs".into();
                    v["pull_request_url"] = "https://api.github.com/repos/o/r/pulls/1".into();
                } else {
                    v["issue_url"] = "https://api.github.com/repos/o/r/issues/1".into();
                }
                v.to_string()
            };
            Ok(match route {
                "repos/o/r/issues" => vec![serde_json::json!({
                    "number": 1, "title": "t", "state": "open", "user": {"login": "bob"},
                    "comments": 2, "pull_request": {},
                    "html_url": "https://github.com/o/r/pull/1",
                    "created_at": "2020-01-02T03:04:05Z"})
                .to_string()],
                "repos/o/r/issues/comments" => vec![c(12, false)],
                "repos/o/r/pulls/comments" => vec![c(22, true)],
                "repos/o/r/issues/1/comments" => vec![c(11, false), c(12, false)],
                "repos/o/r/pulls/1/comments" => {
                    anyhow::bail!("`gh api {path}&page=1` failed: {UNPROCESSABLE}")
                }
                "repos/o/r/pulls/1/reviews" => Vec::new(),
                other => panic!("unexpected {other}"),
            })
        }
    }

    #[test]
    fn a_refused_full_thread_keeps_what_the_window_read() {
        let log = std::rc::Rc::default();
        let gh = GithubClient::with_api(src(), Box::new(LineWindow(std::rc::Rc::clone(&log))));
        let all = Classes::parse("issues,prs").unwrap();
        let out = collect(&gh, &src(), all, Some("2026-09-08T00:00:00Z"), 0).unwrap();
        let bodies: Vec<&str> = out.targets[0]
            .comments
            .iter()
            .map(|c| c.body.rsplit("\n\n").next().unwrap())
            .collect();
        assert_eq!(bodies, ["c11", "c12", "c22"], "{bodies:?}");
        assert!(out.incomplete);
        assert_eq!(out.warnings.len(), 1, "{:?}", out.warnings);
        assert!(out.warnings[0].starts_with("#1 is mirrored without its review comments"));
        let asked = log
            .borrow()
            .iter()
            .filter(|p| p.contains("pulls/1/comments"))
            .count();
        assert_eq!(asked, 4, "two full reads, each asking twice");
    }

    /// What is not about one item still fails the run: the token (401, or a 403 that is not a
    /// rate limit), a rate limit or a server error the retries did not outlast, and a refused
    /// repository-wide listing.
    #[test]
    fn auth_rate_limit_and_server_failures_still_fail_the_run() {
        let all = Classes::parse("issues,prs").unwrap();
        for err in [
            "gh: Bad credentials (HTTP 401)",
            "gh: Resource not accessible by integration (HTTP 403)",
            "the GitHub API rate limit was reached; re-run after it resets",
            "gh: Server Error (HTTP 502)",
            "stream error: stream ID 23; CANCEL; received from peer",
        ] {
            let gh = refusing(vec![("pulls/3/reviews", err)]);
            let e = collect(&gh, &src(), all, None, 0).unwrap_err();
            assert!(format!("{e:#}").contains(err), "{err}: {e:#}");
        }
        let gh = refusing(vec![("issues/comments?", UNPROCESSABLE)]);
        assert!(collect(&gh, &src(), all, None, 0).is_err());
    }

    #[test]
    fn only_a_client_error_about_the_item_is_refused_for_it() {
        for code in [404, 410, 422, 451] {
            let e =
                anyhow::anyhow!("`gh api repos/o/r/pulls/9/reviews` failed: gh: X (HTTP {code})");
            assert!(refused_for_item(&e), "{code}");
        }
        for code in [400, 401, 403, 409, 429, 500, 502] {
            let e =
                anyhow::anyhow!("`gh api repos/o/r/pulls/9/reviews` failed: gh: X (HTTP {code})");
            assert!(!refused_for_item(&e), "{code}");
        }
        // A PR numbered like a status code is not a status.
        let e = anyhow::anyhow!("`gh api repos/o/r/pulls/422/reviews` failed: gh: X (HTTP 502)");
        assert!(!refused_for_item(&e));
    }

    /// F-10: `--limit 2` on a large repository read every comment of the repository (tens
    /// of thousands on `octocat/Spoon-Knife`). It must read only the chosen items' threads,
    /// and only the first page of the listing.
    #[test]
    fn a_limited_run_reads_only_the_chosen_items() {
        let (gh, log) = big_repo();
        let all = Classes::parse("issues,prs").unwrap();
        let out = collect(&gh, &src(), all, None, 2).unwrap();
        assert_eq!(
            out.targets.iter().map(|t| t.number).collect::<Vec<_>>(),
            [1, 2]
        );
        assert!(out.truncated);
        assert!(out.targets.iter().all(|t| t.comments.len() == 1));
        assert!(out.targets[0].comments[0].body.contains("by @ghost"));
        // Repository-wide listings are what a limited run must not page through; one
        // item's thread may span pages.
        let repo_wide = |p: &String| {
            p.contains("(all pages)")
                && (p.contains("issues?")
                    || p.contains("issues/comments?")
                    || p.contains("pulls?")
                    || p.contains("pulls/comments?"))
        };
        let log = log.borrow();
        assert!(
            !log.iter().any(repo_wide),
            "a limited run paged a whole listing: {log:#?}"
        );
        assert_eq!(log.len(), 3, "one listing page and two threads: {log:#?}");

        // A PR among the chosen items: its detail, reviews and line comments, by number.
        let (gh, log) = big_repo();
        let out = collect(&gh, &src(), all, None, 3).unwrap();
        assert_eq!(out.targets[2].kind, TargetKind::Patch);
        // Its body names the base commit (L-36) and its own branch.
        assert!(
            out.targets[2]
                .body
                .contains(&format!("> Base {} · head f", "cd".repeat(20))),
            "{}",
            out.targets[2].body
        );
        assert!(!log.borrow().iter().any(repo_wide));
        assert!(log.borrow().iter().any(|p| p.ends_with("pulls/3")));
    }

    /// L-05: dashpay/dash#6935 (24 comments) was mirrored by a `--state` run whose window held
    /// one of them, and got just that one. An item whose source comment count is more than the
    /// window returned is read in full.
    struct Windowed(std::rc::Rc<std::cell::RefCell<Vec<String>>>);

    impl crate::github::GhApi for Windowed {
        fn json(&self, path: &str) -> Result<Vec<u8>> {
            self.0.borrow_mut().push(path.to_string());
            Ok(b"{}".to_vec())
        }

        fn list(&self, path: &str) -> Result<Vec<String>> {
            self.0.borrow_mut().push(path.to_string());
            let rest = path.strip_prefix("repos/o/r/").unwrap();
            let (route, _) = rest.split_once('?').unwrap_or((rest, ""));
            let c = |n: u64, id: u64| {
                serde_json::json!({
                    "id": id, "body": format!("c{id}"), "user": {"login": "bob"},
                    "html_url": format!("https://github.com/o/r/issues/{n}#issuecomment-{id}"),
                    "created_at": "2020-01-02T03:04:05Z",
                    "issue_url": format!("https://api.github.com/repos/o/r/issues/{n}"),
                })
                .to_string()
            };
            Ok(match route {
                // #1 has 3 comments, #2 has 1: the window returns one of each.
                "issues" => [(1, 3), (2, 1)]
                    .iter()
                    .map(|&(n, k)| {
                        serde_json::json!({"number": n, "title": "t", "state": "open",
                            "user": {"login": "bob"}, "comments": k,
                            "html_url": format!("https://github.com/o/r/issues/{n}"),
                            "created_at": "2020-01-02T03:04:05Z"})
                        .to_string()
                    })
                    .collect(),
                "issues/comments" => vec![c(1, 13), c(2, 21)],
                "issues/1/comments" => vec![c(1, 11), c(1, 12), c(1, 13)],
                other => panic!("unexpected {other}"),
            })
        }
    }

    #[test]
    fn an_item_whose_window_missed_comments_is_read_in_full() {
        let log = std::rc::Rc::default();
        let gh = GithubClient::with_api(src(), Box::new(Windowed(std::rc::Rc::clone(&log))));
        let out = collect(
            &gh,
            &src(),
            Classes::parse("issues").unwrap(),
            Some("2026-09-08T00:00:00Z"),
            0,
        )
        .unwrap();
        let counts: Vec<usize> = out.targets.iter().map(|t| t.comments.len()).collect();
        assert_eq!(counts, [3, 1], "#1 in full, #2 already whole");
        let log = log.borrow();
        assert!(log
            .iter()
            .any(|p| p.contains("issues/1/comments") && !p.contains("since=")));
        assert!(
            !log.iter().any(|p| p.contains("issues/2/comments")),
            "{log:#?}"
        );
    }

    /// `--sync prs --limit`: the pulls listing, never the issue listing.
    #[test]
    fn a_limited_prs_only_run_reads_the_pulls_listing() {
        let (gh, log) = big_repo();
        let out = collect(&gh, &src(), Classes::parse("prs").unwrap(), None, 2).unwrap();
        assert_eq!(
            out.targets.iter().map(|t| t.number).collect::<Vec<_>>(),
            [3, 6]
        );
        assert!(out.truncated);
        assert!(out.targets.iter().all(|t| t.kind == TargetKind::Patch));
        let log = log.borrow();
        assert!(!log.iter().any(|p| p.contains("issues?")), "{log:#?}");
    }

    #[test]
    fn a_failed_open_pr_listing_fails_the_run() {
        // The GitHub path has no partial read of the open PRs: a failed listing fails the
        // run, so an empty `open_pulls` never means "unknown" and a heads push never prunes
        // against a list that was not read. (Pinned: see the GitLab counterpart.)
        struct Refusing;
        impl crate::github::GhApi for Refusing {
            fn json(&self, _: &str) -> Result<Vec<u8>> {
                anyhow::bail!("HTTP 403")
            }
            fn list(&self, path: &str) -> Result<Vec<String>> {
                anyhow::bail!("`gh api {path}` failed: HTTP 403")
            }
        }
        let gh = GithubClient::with_api(src(), Box::new(Refusing));
        let code_and_prs = Classes::parse("code,prs").unwrap();
        assert!(collect(&gh, &src(), code_and_prs, None, 0).is_err());
        // Read (even empty): `Some`, so closed heads are pruned.
        let (gh, _) = big_repo();
        let out = collect(&gh, &src(), Classes::parse("code,prs").unwrap(), None, 0).unwrap();
        assert!(out.open_pulls.is_some());
    }

    /// Without `--limit`, the repository-wide listings stay: one paged read per kind beats
    /// a request per item.
    #[test]
    fn a_full_run_reads_comments_repository_wide() {
        let (gh, log) = big_repo();
        let out = collect(&gh, &src(), Classes::parse("issues").unwrap(), None, 0).unwrap();
        assert_eq!(out.targets.len(), 167);
        assert!(!out.truncated);
        assert!(out.targets.iter().all(|t| t.comments.len() == 1));
        let log = log.borrow();
        assert!(log
            .iter()
            .any(|p| p.contains("issues/comments?") && p.contains("(all pages)")));
        assert!(log.len() <= 3, "{log:#?}");
    }

    #[test]
    fn classes_parse() {
        let c = Classes::parse("code, issues,prs").unwrap();
        assert!(c.code && c.issues && c.prs && !c.releases && !c.labels);
        let all = Classes::parse("all").unwrap();
        assert!(all.releases && all.labels);
        assert!(Classes::parse("wiki").is_err());
    }

    #[test]
    fn an_issue_keeps_its_number_author_and_url() {
        let i = GhIssue {
            number: 12,
            title: "Crash".into(),
            body: Some("boom".into()),
            user: GhUser {
                login: "bob".into(),
            },
            state: "closed".into(),
            html_url: "https://github.com/o/r/issues/12".into(),
            created_at: "2020-01-02T03:04:05Z".into(),
            ..Default::default()
        };
        let t = target(&src(), &i, 12);
        assert_eq!(t.number, 12);
        assert!(t.closed);
        assert!(t
            .body
            .starts_with("> Mirrored from github.com/o/r#12 by @bob (issue, 2020-01-02)"));
        assert!(t.body.ends_with("boom"));
        assert_eq!(t.imported.url, "https://github.com/o/r/issues/12");
        assert_eq!(t.imported.created_at, 1_577_934_245);
    }

    #[test]
    fn reviews_map_verdicts_and_drop_pending() {
        let mk = |state: &str| GhReview {
            state: state.into(),
            commit_id: Some("ab".repeat(20)),
            html_url: "https://github.com/o/r/pull/3#r1".into(),
            ..Default::default()
        };
        assert_eq!(
            review(&src(), 3, &mk("APPROVED")).unwrap().verdict,
            Verdict::Approve
        );
        assert_eq!(
            review(&src(), 3, &mk("CHANGES_REQUESTED")).unwrap().verdict,
            Verdict::RequestChanges
        );
        assert!(review(&src(), 3, &mk("PENDING")).is_none());
        assert!(review(&src(), 3, &mk("DISMISSED")).is_none());
    }

    #[test]
    fn review_comments_carry_a_line_anchor() {
        let c = GhComment {
            body: Some("nit".into()),
            path: Some("src/a.rs".into()),
            line: Some(7),
            side: Some("RIGHT".into()),
            commit_id: Some("cd".repeat(20)),
            html_url: "u".into(),
            ..Default::default()
        };
        let s = comment(&src(), 3, &c);
        let a = s.anchor.unwrap();
        assert_eq!(
            (a.path.as_deref(), a.line, a.side),
            (Some("src/a.rs"), Some(7), Some(1))
        );
        assert!(s.body.contains("`src/a.rs` line 7"));
    }

    #[test]
    fn release_assets_are_referenced_and_fit_the_field() {
        let r = GhRelease {
            tag_name: "v1".into(),
            assets: (0..100)
                .map(|i| GhAsset {
                    name: format!("asset-{i}.tar.gz"),
                    size: 10,
                    browser_download_url: format!(
                        "https://github.com/o/r/releases/download/v1/asset-{i}.tar.gz"
                    ),
                    digest: Some(format!("sha256:{}", "a".repeat(64))),
                })
                .collect(),
            ..Default::default()
        };
        let rel = release(&r);
        assert!(!rel.assets.is_empty());
        assert!(serde_json::to_string(&rel.assets).unwrap().len() <= 4096);
        assert_eq!(rel.assets[0].sha256, "a".repeat(64));
        assert_eq!(rel.name, "v1");
    }

    /// Live on moutai (sharkdp/diskus v0.7.0, 17 assets): fitted with `sha256: ""`, the list
    /// outgrew 4096 bytes once the importer hashed them (D-517), and the release write failed.
    /// It is fitted with the hashes it will carry.
    #[test]
    fn assets_without_a_digest_are_fitted_with_their_hash() {
        let r = GhRelease {
            tag_name: "v1".into(),
            assets: (0..100)
                .map(|i| GhAsset {
                    name: format!("asset-{i}.tar.gz"),
                    size: 10,
                    browser_download_url: format!(
                        "https://github.com/o/r/releases/download/v1/asset-{i}.tar.gz"
                    ),
                    digest: None,
                })
                .collect(),
            ..Default::default()
        };
        let mut rel = release(&r);
        assert!(!rel.assets.is_empty());
        for a in &mut rel.assets {
            a.sha256 = "b".repeat(64);
        }
        assert!(serde_json::to_string(&rel.assets).unwrap().len() <= 4096);
    }
}
