//! GitHub → [`SrcCollab`]: issues, pull requests, comments, reviews, labels and releases,
//! mapped to what the forge-v2 mirror should hold.
//!
//! * Numbers are kept (GitHub issues and PRs share one sequence; forge-v2 numbers issues and
//!   PRs independently, so each keeps its GitHub number and the gaps are fine, §6).
//! * The GitHub author cannot sign, so the mirror identity writes every document. The body
//!   opens with *"Mirrored from github.com/o/r#123 by @bob"*, and `imported`
//!   `{author, createdAt, url}` records the original; `imported.url` (the GitHub
//!   `html_url`) is the idempotency key.
//! * State is replayed as member events written by the mirror identity (who must be a
//!   maintainer or writer): close, reopen, merge (with the merge commit), labels, draft.
//! * Release assets are referenced (GitHub download URL + sha256 when GitHub reports one),
//!   never re-uploaded.
//!
//! With `since`, only issues/PRs updated since then are listed, and only comments updated
//! since then; an item's whole desired state is still compared on chain, so nothing depends
//! on the window being exact.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;

use forge_core::collab::v2::TargetKind;
use forge_core::collab::{CommentAnchor, ReleaseAsset, Verdict};

use crate::github::{iso8601_to_unix, GhComment, GhIssue, GithubClient, GithubRepoRef};
use crate::model::{
    self, SrcCollab, SrcComment, SrcLabel, SrcPatch, SrcRelease, SrcReview, SrcTarget,
};

/// Which classes to sync.
#[derive(Debug, Clone, Copy, Default)]
#[allow(clippy::struct_excessive_bools)]
pub struct Classes {
    /// Branches and tags (and PR heads when `prs`).
    pub code: bool,
    /// Issues (with comments and state).
    pub issues: bool,
    /// Pull requests (with comments, reviews and state).
    pub prs: bool,
    /// Releases.
    pub releases: bool,
    /// Label definitions.
    pub labels: bool,
}

impl Classes {
    /// Parse `code,issues,prs,releases,labels` (`all` = every class).
    pub fn parse(s: &str) -> Result<Self> {
        let mut c = Self::default();
        for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            match part {
                "all" => {
                    c = Self {
                        code: true,
                        issues: true,
                        prs: true,
                        releases: true,
                        labels: true,
                    }
                }
                "code" => c.code = true,
                "issues" => c.issues = true,
                "prs" | "pulls" => c.prs = true,
                "releases" => c.releases = true,
                "labels" => c.labels = true,
                other => anyhow::bail!(
                    "unknown sync class {other:?}: use code, issues, prs, releases, labels or all"
                ),
            }
        }
        Ok(c)
    }
}

/// The repository's label definitions.
fn labels(gh: &GithubClient) -> Result<Vec<SrcLabel>> {
    Ok(gh
        .labels()?
        .into_iter()
        .filter(|l| !l.name.trim().is_empty())
        .map(|l| SrcLabel {
            name: model::label_name(&l.name),
            color: model::color(&l.color),
            description: model::clip(l.description.as_deref().unwrap_or(""), 200, 400),
        })
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
        out.open_pulls = gh.open_pulls()?;
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
    let mut threads = threads(gh, &items, classes, since, limit > 0)?;

    // PR details from the listing (one call per 100 PRs); a PR the listing missed (it
    // changed mid-read), or any PR of a `--limit` run, is read by its own call.
    let mut pulls = if limit == 0 && classes.prs && items.iter().any(GhIssue::is_pull_request) {
        gh.pulls(since)?
    } else {
        BTreeMap::new()
    };
    for i in &items {
        let Ok(number) = u32::try_from(i.number) else {
            continue;
        };
        let mut t = target(src, i, number);
        let mut thread = threads.remove(&i.number).unwrap_or_default();
        thread.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        t.comments = thread.iter().map(|c| comment(src, number, c)).collect();
        if i.is_pull_request() {
            let pull = match pulls.remove(&i.number) {
                Some(p) => p,
                None => gh.pull(i.number)?,
            };
            t.kind = TargetKind::Patch;
            t.draft = pull.draft;
            t.merged_oid = pull
                .merged_at
                .as_ref()
                .and(pull.merge_commit_sha.as_deref())
                .and_then(model::oid);
            let head = model::oid(&pull.head.sha).unwrap_or_else(|| vec![0; 20]);
            let base = if pull.base.ref_name.is_empty() {
                "main".to_string()
            } else {
                pull.base.ref_name.clone()
            };
            // Only open PRs' heads are pushed (a closed PR's objects are not the mirror's to
            // pay for), so only they name a checkoutable source ref.
            let open_head = classes.code && !i.is_closed();
            t.patch = Some(SrcPatch {
                base_ref_name: format!("refs/heads/{base}"),
                source_ref_name: open_head.then(|| format!("refs/mirror/pull/{number}/head")),
                head_oid: head,
            });
            t.reviews = gh
                .reviews(i.number)?
                .into_iter()
                .filter_map(|r| review(src, number, &r))
                .collect();
        }
        out.targets.push(t);
    }
    Ok(out)
}

/// Every comment (conversation and review) on `items`, by parent number. `per_item` (a
/// `--limit` run) reads each item's own thread; otherwise the repository-wide listings are
/// read once and filtered (100 per request beats a request per item).
fn threads(
    gh: &GithubClient,
    items: &[GhIssue],
    classes: Classes,
    since: Option<&str>,
    per_item: bool,
) -> Result<BTreeMap<u64, Vec<GhComment>>> {
    let mut out: BTreeMap<u64, Vec<GhComment>> = BTreeMap::new();
    if per_item {
        for i in items {
            let thread = out.entry(i.number).or_default();
            if i.comments > 0 {
                thread.extend(gh.comments_on(i.number, since)?);
            }
            if i.is_pull_request() {
                thread.extend(gh.review_comments_on(i.number, since)?);
            }
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
    Ok(out)
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
        merged_oid: None,
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
    let mut text = c.body.clone().unwrap_or_default();
    if let Some(path) = &c.path {
        text = format!(
            "`{path}`{}\n\n{text}",
            c.line.map(|l| format!(" line {l}")).unwrap_or_default()
        );
    }
    SrcComment {
        body: model::body(
            &header(src, number, &c.user.login, created, kind),
            &text,
            &c.html_url,
        ),
        imported: model::imported(&c.user.login, created, &c.html_url),
        anchor: c.path.as_ref().map(|p| CommentAnchor {
            reply_to: None,
            commit_oid: c.commit_id.as_deref().and_then(model::oid),
            path: Some(model::clip(p, 500, 1000)),
            line: c.line,
            side: c.side.as_deref().map(|s| u64::from(s != "LEFT")),
        }),
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
        .collect::<Vec<_>>();
    SrcRelease {
        tag_name: r.tag_name.clone(),
        name: model::clip(r.name.as_deref().unwrap_or(&r.tag_name), 120, 480),
        notes: model::clip(r.body.as_deref().unwrap_or(""), 5120, 5120),
        assets: fit_assets(assets),
    }
}

/// Keep as many assets as fit the release's 4096-byte `assets` field.
fn fit_assets(mut assets: Vec<ReleaseAsset>) -> Vec<ReleaseAsset> {
    while !assets.is_empty() && serde_json::to_string(&assets).map_or(0, |s| s.len()) > 4096 {
        assets.pop();
    }
    assets
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::{GhAsset, GhRelease, GhReview, GhUser};

    fn src() -> GithubRepoRef {
        GithubRepoRef::parse("o/r").unwrap()
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
        serde_json::json!({
            "number": n, "head": {"ref": "f", "sha": "ab".repeat(20)},
            "base": {"ref": "main", "sha": "cd".repeat(20)},
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
        assert!(!log.borrow().iter().any(repo_wide));
        assert!(log.borrow().iter().any(|p| p.ends_with("pulls/3")));
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
}
