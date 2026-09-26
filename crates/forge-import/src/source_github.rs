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
    /// Every class except those in `skip` (`issues`, `prs`, `labels`, `releases`), and
    /// whether `members` was skipped: the `--skip` form `migrate` takes. Code is always on.
    pub fn from_skip(skip: &[String]) -> (Self, bool) {
        let on = |what: &str| !skip.iter().any(|s| s == what);
        (
            Self {
                code: true,
                issues: on("issues"),
                prs: on("prs"),
                labels: on("labels"),
                releases: on("releases"),
            },
            on("members"),
        )
    }

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

    let mut items: Vec<GhIssue> = gh
        .issues(since)?
        .into_iter()
        .filter(|i| {
            if i.is_pull_request() {
                classes.prs
            } else {
                classes.issues
            }
        })
        .collect();
    items.sort_by_key(|i| i.number);
    if limit > 0 && items.len() > limit {
        items.truncate(limit);
        out.truncated = true;
    }
    let wanted: BTreeSet<u64> = items.iter().map(|i| i.number).collect();

    // Comments, grouped by parent number, in creation order.
    let mut comments: BTreeMap<u64, Vec<GhComment>> = BTreeMap::new();
    let mut review_comments: BTreeMap<u64, Vec<GhComment>> = BTreeMap::new();
    if !wanted.is_empty() {
        for c in gh.issue_comments(since)? {
            if let Some(n) = c.number().filter(|n| wanted.contains(n)) {
                comments.entry(n).or_default().push(c);
            }
        }
        if classes.prs {
            for c in gh.review_comments(since)? {
                if let Some(n) = c.number().filter(|n| wanted.contains(n)) {
                    review_comments.entry(n).or_default().push(c);
                }
            }
        }
    }

    for i in &items {
        let Ok(number) = u32::try_from(i.number) else {
            continue;
        };
        let mut t = target(src, i, number);
        let mut thread = comments.remove(&i.number).unwrap_or_default();
        thread.extend(review_comments.remove(&i.number).unwrap_or_default());
        thread.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        t.comments = thread.iter().map(|c| comment(src, number, c)).collect();
        if i.is_pull_request() {
            let pull = gh.pull(i.number)?;
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
