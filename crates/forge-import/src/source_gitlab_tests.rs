//! [`super::collect`] against recorded GitLab responses (testdata/gitlab, see its README):
//! no network.

use super::*;
use crate::gitlab::{GlApi, GlResponse};
use std::cell::RefCell;
use std::rc::Rc;

const BASE: &str = "https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-runner-docker-cleanup";

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!(
        "{}/testdata/gitlab/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

/// The recorded project, every request logged. `anonymous` answers notes, discussions and
/// labels with 401, as gitlab.com does without a token; `overrides` answer a route (the path
/// after the project) with a fixed response.
#[derive(Default)]
struct Recorded {
    anonymous: bool,
    /// Answer the first request with a 429 (Retry-After 1).
    throttle_once: RefCell<bool>,
    /// Fail the first request with no answer at all (curl exit 7).
    unreachable_once: RefCell<bool>,
    overrides: Vec<(&'static str, GlResponse)>,
    project: Option<String>,
    log: Rc<RefCell<Vec<String>>>,
}

fn ok(body: String, next: Option<String>) -> GlResponse {
    GlResponse::ok(body, next)
}

fn mrs(range: std::ops::Range<usize>) -> String {
    let all: Vec<serde_json::Value> =
        serde_json::from_str(&fixture("merge_requests.json")).unwrap();
    serde_json::to_string(&all[range]).unwrap()
}

impl GlApi for Recorded {
    fn get(&self, url: &str) -> Result<GlResponse> {
        self.log.borrow_mut().push(url.to_string());
        if self.unreachable_once.replace(false) {
            return Err(crate::gitlab::Transient("curl: (7) Failed to connect".into()).into());
        }
        if self.throttle_once.replace(false) {
            let mut r = GlResponse::status(429, Vec::new(), None);
            r.retry_after = Some(1);
            return Ok(r);
        }
        let rest = url.strip_prefix(BASE).unwrap();
        let (route, query) = rest.split_once('?').unwrap_or((rest, ""));
        // An override is a route, or a route and query prefix (`/merge_requests?state=opened`).
        let hit = self
            .overrides
            .iter()
            .find(|(p, _)| match p.split_once('?') {
                Some((r, q)) => r == route && query.starts_with(q),
                None => *p == route,
            });
        if let Some((_, r)) = hit {
            return Ok(r.clone());
        }
        let denied = GlResponse::status(401, br#"{"message":"401 Unauthorized"}"#.to_vec(), None);
        Ok(match route {
            "" => ok(
                self.project.clone().unwrap_or_else(|| fixture("project.json")),
                None,
            ),
            "/issues" => ok(fixture("issues.json"), None),
            "/merge_requests" if query.contains("state=opened") => {
                ok(r#"[{"iid":5,"state":"opened"}]"#.into(), None)
            }
            // Two pages, to exercise `Link: rel="next"`.
            "/merge_requests" if query.contains("page=2") => ok(mrs(3..6), None),
            "/merge_requests" => ok(
                mrs(0..3),
                Some(format!("{BASE}/merge_requests?{query}&page=2")),
            ),
            "/releases" => ok(fixture("releases.json"), None),
            _ if self.anonymous => denied,
            "/labels" => ok(
                r##"[{"name":"type::bug","color":"#D9534F","description":"A bug"},{"name":" ","color":"#000000"}]"##
                    .into(),
                None,
            ),
            "/issues/2/notes" => ok(fixture("issue-2-notes.json"), None),
            "/merge_requests/5/discussions" => ok(fixture("mr-5-discussions.json"), None),
            r if r.ends_with("/notes") || r.ends_with("/discussions") => ok("[]".into(), None),
            other => panic!("unexpected request {other}"),
        })
    }

    fn ls_remote(&self, _url: &str, pattern: &str) -> Result<String> {
        assert_eq!(pattern, "refs/merge-requests/*/head");
        Ok(fixture("ls-remote-mr-heads.txt"))
    }
}

fn repo() -> GitlabRepoRef {
    GitlabRepoRef::parse(
        "gitlab.com/gitlab-org/gitlab-runner-docker-cleanup",
        None,
        crate::gitlab::BaseOptions::default(),
    )
    .unwrap()
}

fn serve(api: Recorded) -> (GitlabClient, Rc<RefCell<Vec<String>>>) {
    let log = Rc::clone(&api.log);
    (GitlabClient::with_api(repo(), Box::new(api)), log)
}

fn client(anonymous: bool) -> (GitlabClient, Rc<RefCell<Vec<String>>>) {
    serve(Recorded {
        anonymous,
        ..Default::default()
    })
}

/// `collect` with members-only content refused (the default).
fn collect(gl: &GitlabClient, c: Classes, since: Option<&str>, limit: usize) -> Result<SrcCollab> {
    super::collect(gl, c, since, &[], limit, false)
}

fn all() -> Classes {
    Classes::parse("all").unwrap()
}

fn by_number(out: &SrcCollab, kind: TargetKind, n: u32) -> &SrcTarget {
    out.targets
        .iter()
        .find(|t| t.kind == kind && t.number == n)
        .unwrap()
}

#[test]
fn issues_and_merge_requests_keep_their_numbers_keys_and_state() {
    let (gl, _) = client(false);
    let out = collect(&gl, all(), None, 0).unwrap();
    assert_eq!(out.targets.len(), 3 + 6);
    assert!(!out.truncated && !out.incomplete, "{:?}", out.warnings);
    let issue = by_number(&out, TargetKind::Issue, 2);
    assert_eq!(
        issue.imported.url,
        "https://gitlab.com/gitlab-org/gitlab-runner-docker-cleanup/-/issues/2"
    );
    assert!(issue
        .body
        .starts_with("> Mirrored from gitlab.com/gitlab-org/gitlab-runner-docker-cleanup#2 by @"));
    assert!(!issue.closed);
    assert!(by_number(&out, TargetKind::Issue, 1).closed);
    // Same number, other kind: GitLab's two sequences stay apart.
    let mr = by_number(&out, TargetKind::Patch, 2);
    assert!(mr.imported.url.ends_with("/-/merge_requests/2"));
    assert!(mr.body.contains("cleanup!2 by @"));
    let labels = out.labels.as_ref().unwrap();
    assert_eq!(labels.len(), 1, "blank names are dropped");
    assert_eq!(labels[0].color, "#d9534f");
    assert_eq!(out.open_pulls.as_deref(), Some(&[5][..]));
}

#[test]
fn notes_skip_system_and_internal_ones_and_keep_ghost_authors() {
    let (gl, _) = client(false);
    let out = collect(&gl, all(), None, 0).unwrap();
    let issue = by_number(&out, TargetKind::Issue, 2);
    let urls: Vec<&str> = issue
        .comments
        .iter()
        .map(|c| c.imported.url.as_str())
        .collect();
    assert_eq!(
        urls,
        [
            "https://gitlab.com/gitlab-org/gitlab-runner-docker-cleanup/-/issues/2#note_305",
            "https://gitlab.com/gitlab-org/gitlab-runner-docker-cleanup/-/issues/2#note_307",
        ]
    );
    assert_eq!(issue.comments[1].imported.author, crate::github::GHOST);
    assert!(issue
        .comments
        .iter()
        .all(|c| !c.body.contains("members-only")));
}

#[test]
fn diff_discussions_become_anchored_comments_in_order() {
    let (gl, _) = client(false);
    let out = collect(&gl, all(), None, 0).unwrap();
    let mr = by_number(&out, TargetKind::Patch, 5);
    let last_lines: Vec<&str> = mr
        .comments
        .iter()
        .map(|c| c.body.lines().last().unwrap())
        .collect();
    // Oldest first, across threads; the system note ("added 1 commit") is left out.
    assert_eq!(
        last_lines,
        [
            "discussion text",
            "a single comment",
            "diff comment",
            "on a removed line",
            "on the whole file",
            "reply to the discussion"
        ]
    );
    // A file-level note keeps its file, with no line.
    let file = mr
        .comments
        .iter()
        .find(|c| c.body.ends_with("on the whole file"))
        .unwrap();
    let a = file.anchor.as_ref().unwrap();
    assert_eq!(
        (a.path.as_deref(), a.line, a.side),
        (Some("logo.png"), None, None)
    );
    assert!(file.body.contains("`logo.png`\n"));
    let diff = mr
        .comments
        .iter()
        .find(|c| c.body.ends_with("diff comment"))
        .unwrap();
    let a = diff.anchor.as_ref().unwrap();
    assert_eq!(
        (a.path.as_deref(), a.line, a.side),
        (Some("package.json"), Some(27), Some(1))
    );
    assert_eq!(
        a.commit_oid,
        model::oid("4803c71e6b1833ca72b8b26ef2ecd5adc8a38031")
    );
    assert!(diff.body.contains("`package.json` line 27"));
    let removed = mr
        .comments
        .iter()
        .find(|c| c.body.ends_with("removed line"))
        .unwrap();
    let a = removed.anchor.as_ref().unwrap();
    assert_eq!(
        (a.path.as_deref(), a.line, a.side),
        (Some("old.js"), Some(5), Some(0))
    );
    assert_eq!(removed.imported.author, crate::github::GHOST);
    assert_eq!(mr.comments.iter().filter(|c| c.anchor.is_none()).count(), 3);
}

#[test]
fn merge_requests_map_merges_forks_and_lost_heads() {
    let (gl, _) = client(false);
    let out = collect(&gl, all(), None, 0).unwrap();
    // Open, head still at GitLab: pushed and checkoutable.
    let open = by_number(&out, TargetKind::Patch, 5);
    let p = open.patch.as_ref().unwrap();
    assert_eq!(
        p.source_ref_name.as_deref(),
        Some("refs/mirror/pull/5/head")
    );
    assert_eq!(p.base_ref_name, "refs/heads/master");
    assert!(!open.closed && !open.body.contains("not available"));
    // Merged from a deleted fork: merge commit recorded, head gone, and said so.
    let merged = by_number(&out, TargetKind::Patch, 1);
    assert_eq!(
        merged.merged_oid,
        model::oid("4b5cefa8c57f54cc2b200a87e235e77ec4c29a80")
    );
    assert!(merged.closed);
    assert!(merged.patch.as_ref().unwrap().source_ref_name.is_none());
    assert!(merged.body.contains("Its commits are not available"));
    // A closed fork MR: closed, not merged, metadata only.
    let fork = by_number(&out, TargetKind::Patch, 6);
    assert!(fork.closed && fork.merged_oid.is_none());
    assert_eq!(
        fork.patch.as_ref().unwrap().head_oid,
        model::oid("da8e2b646e71a11891f40dd13c3b7632d78913fa").unwrap()
    );
}

#[test]
fn releases_reference_their_links() {
    let (gl, _) = client(false);
    let out = collect(&gl, all(), None, 0).unwrap();
    let r = &out.releases.as_ref().unwrap()[0];
    assert_eq!(r.tag_name, "v1.119.0");
    assert_eq!(r.assets.len(), 2);
    assert!(r.assets[0].uris[0].contains("/-/releases/v1.119.0/downloads/"));
    assert!(r.assets[0].sha256.is_empty());
}

/// Without a token, gitlab.com shows the items but not their threads or labels: the run
/// imports what it can, warns, and does not let `--state` skip the rest next time.
#[test]
fn an_anonymous_run_is_marked_incomplete() {
    let (gl, log) = client(true);
    let out = collect(&gl, all(), None, 0).unwrap();
    assert_eq!(out.targets.len(), 9);
    assert!(out.incomplete);
    assert!(out.labels.is_none());
    assert!(out.targets.iter().all(|t| t.comments.is_empty()));
    assert_eq!(out.warnings.len(), 2, "{:?}", out.warnings);
    assert!(out
        .warnings
        .iter()
        .all(|w| w.contains("GITLAB_TOKEN") && w.contains("401")));
    // After the first refused thread, no more are asked for.
    let threads = log
        .borrow()
        .iter()
        .filter(|u| u.contains("/notes") || u.contains("/discussions"))
        .count();
    assert_eq!(threads, 1, "{:#?}", log.borrow());
}

/// H1: a refused listing (403: releases disabled or members-only, as gitlab-foss answers
/// anonymously; 401 for issues) is a warning and a partial run, never an aborted import.
#[test]
fn a_refused_listing_is_partial_not_fatal() {
    let (gl, _) = serve(Recorded {
        overrides: vec![
            ("/releases", GlResponse::status(403, b"{}".to_vec(), None)),
            ("/issues", GlResponse::status(401, b"{}".to_vec(), None)),
        ],
        ..Default::default()
    });
    let out = collect(&gl, all(), None, 0).unwrap();
    assert!(out.incomplete);
    assert!(out.releases.is_none());
    assert!(out.targets.iter().all(|t| t.kind == TargetKind::Patch));
    assert_eq!(out.targets.len(), 6);
    assert!(out
        .warnings
        .iter()
        .any(|w| w.contains("the releases") && w.contains("403") && w.contains("members")));
    assert!(out
        .warnings
        .iter()
        .any(|w| w.contains("the issues") && w.contains("401") && w.contains("GITLAB_TOKEN")));
    // Only a refused project read is fatal.
    let (gl, _) = serve(Recorded {
        overrides: vec![("", GlResponse::status(401, b"{}".to_vec(), None))],
        ..Default::default()
    });
    assert!(collect(&gl, all(), None, 0).is_err());
}

/// A 403 on one item's thread (a members-only merge request) does not stop the others'.
#[test]
fn a_forbidden_thread_does_not_stop_the_others() {
    let (gl, _) = serve(Recorded {
        overrides: vec![(
            "/issues/1/notes",
            GlResponse::status(403, b"{}".to_vec(), None),
        )],
        ..Default::default()
    });
    let out = collect(&gl, all(), None, 0).unwrap();
    assert!(out.incomplete);
    assert_eq!(by_number(&out, TargetKind::Issue, 2).comments.len(), 2);
    assert!(!by_number(&out, TargetKind::Patch, 5).comments.is_empty());
    let forbidden = out.warnings.iter().filter(|w| w.contains("403")).count();
    assert_eq!(
        forbidden, 1,
        "one warning, not one per item: {:?}",
        out.warnings
    );
}

/// A refused open-MR listing must not become "no MR is open": the heads push (with
/// `--prune`) would then delete every MR head already on Dash. It is not planned at all.
#[test]
fn a_refused_open_mr_listing_plans_no_heads_push() {
    let (gl, _) = serve(Recorded {
        overrides: vec![(
            "/merge_requests?state=opened",
            GlResponse::status(403, b"{}".to_vec(), None),
        )],
        ..Default::default()
    });
    let classes = all();
    let out = collect(&gl, classes, None, 0).unwrap();
    assert!(out.open_pulls.is_none());
    assert!(out.incomplete);
    assert_eq!(
        crate::importer::planned_pushes(classes, out.open_pulls.as_deref()),
        [crate::gitsync::Refs::Code]
    );
    // The listing read: the heads push is planned, with the open MR.
    let (gl, _) = client(false);
    let out = collect(&gl, classes, None, 0).unwrap();
    assert_eq!(
        crate::importer::planned_pushes(classes, out.open_pulls.as_deref()),
        [
            crate::gitsync::Refs::Code,
            crate::gitsync::Refs::PullHeads(vec![5])
        ]
    );
}

/// M2: a next page on another origin is not followed (the token would go there), and the
/// listing is reported incomplete rather than silently short.
#[test]
fn an_off_origin_next_link_is_refused_and_partial() {
    let (gl, log) = serve(Recorded {
        overrides: vec![(
            "/issues",
            GlResponse::ok(
                fixture("issues.json"),
                Some("https://evil.example/api/v4/projects/1/issues?page=2".into()),
            ),
        )],
        ..Default::default()
    });
    let out = collect(&gl, Classes::parse("issues").unwrap(), None, 0).unwrap();
    assert!(out.incomplete);
    assert!(
        out.targets.is_empty(),
        "a short listing is not mirrored as if complete"
    );
    assert!(out.warnings.iter().any(|w| w.contains("evil.example")));
    assert!(!log.borrow().iter().any(|u| u.contains("evil.example")));
}

/// A moved project answers 301: reported with its new place, not followed.
#[test]
fn a_redirect_is_reported_not_followed() {
    let mut moved = GlResponse::status(301, Vec::new(), None);
    moved.location = Some("https://gitlab.com/new/place".into());
    let (gl, _) = serve(Recorded {
        overrides: vec![("", moved)],
        ..Default::default()
    });
    let e = format!("{:#}", collect(&gl, all(), None, 0).unwrap_err());
    assert!(
        e.contains("https://gitlab.com/new/place") && e.contains("moved"),
        "{e}"
    );
}

/// M8: a project whose issues or merge requests are members-only is refused unless the
/// run opts in; what the run does not ask for does not matter.
#[test]
fn members_only_content_needs_the_opt_in() {
    let private = r#"{"id":444821,"path_with_namespace":"gitlab-org/gitlab-runner-docker-cleanup","issues_access_level":"private","merge_requests_access_level":"enabled"}"#;
    let api = || Recorded {
        project: Some(private.into()),
        ..Default::default()
    };
    let (gl, _) = serve(api());
    let e = format!("{:#}", collect(&gl, all(), None, 0).unwrap_err());
    assert!(
        e.contains("--include-members-only") && e.contains("issues"),
        "{e}"
    );
    let (gl, _) = serve(api());
    assert!(collect(&gl, Classes::parse("code,prs,releases").unwrap(), None, 0).is_ok());
    let (gl, _) = serve(api());
    let out = super::collect(&gl, all(), None, &[], 0, true).unwrap();
    assert_eq!(out.targets.len(), 9);
}

/// H2: a members-only note flagged the old way (`confidential`) is never mirrored.
#[test]
fn old_style_confidential_notes_are_not_mirrored() {
    let (gl, _) = client(false);
    let out = collect(&gl, all(), None, 0).unwrap();
    let issue = by_number(&out, TargetKind::Issue, 2);
    assert!(
        issue.comments.iter().all(|c| !c.body.contains("old-style")),
        "{:#?}",
        issue.comments
    );
}

#[test]
fn an_unreachable_gitlab_is_retried() {
    let (gl, log) = serve(Recorded {
        unreachable_once: RefCell::new(true),
        ..Default::default()
    });
    assert_eq!(gl.project().unwrap().id, 444_821);
    assert_eq!(log.borrow().len(), 2);
}

#[test]
fn a_limited_run_reads_one_page_of_each_listing() {
    let (gl, log) = client(false);
    let out = collect(&gl, Classes::parse("issues,prs").unwrap(), None, 2).unwrap();
    assert_eq!(out.targets.len(), 2);
    assert!(out.truncated);
    let log = log.borrow();
    assert!(!log.iter().any(|u| u.contains("page=2")), "{log:#?}");
    drop(log);
    // Releases are bounded too: one of the recorded release's listing.
    let (gl, _) = client(false);
    let out = collect(&gl, Classes::parse("releases").unwrap(), None, 1).unwrap();
    assert_eq!(out.releases.as_ref().map(Vec::len), Some(1));
}

#[test]
fn a_rate_limited_request_is_retried() {
    let (gl, log) = serve(Recorded {
        throttle_once: RefCell::new(true),
        ..Default::default()
    });
    assert_eq!(gl.project().unwrap().id, 444_821);
    assert_eq!(log.borrow().len(), 2);
}

#[test]
fn incremental_reads_ask_for_updated_after() {
    let (gl, log) = client(false);
    collect(
        &gl,
        Classes::parse("issues,prs").unwrap(),
        Some("2026-01-01T00:00:00Z"),
        0,
    )
    .unwrap();
    let log = log.borrow();
    let listings: Vec<&String> = log
        .iter()
        .filter(|u| u.contains("/issues?") || u.contains("/merge_requests?state=all"))
        .collect();
    assert!(!listings.is_empty());
    assert!(listings
        .iter()
        .all(|u| u.contains("updated_after=2026-01-01T00:00:00Z")));
}
