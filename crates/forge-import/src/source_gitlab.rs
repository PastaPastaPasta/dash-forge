//! GitLab → [`SrcCollab`]: issues, merge requests, their notes and diff discussions, labels
//! and releases, mapped to what the forge-v2 mirror should hold. Everything past this point
//! (pricing, the push, the on-chain diff) is the same as for GitHub.
//!
//! * **Numbers.** GitLab numbers issues (`#n`) and merge requests (`!n`) in two sequences,
//!   and so does forge-v2 (issues and patches), so each keeps its GitLab number.
//! * **Keys.** `imported.url` is the item's canonical web URL,
//!   `https://<host>/<project>/-/issues/<iid>` or `…/-/merge_requests/<iid>`, and a note's
//!   is `<item url>#note_<id>` (the anchor GitLab links notes with). The same keys as the
//!   GitHub path: a re-run writes only what is new.
//! * **Threads.** An issue's notes, and a merge request's discussions, oldest first. System
//!   notes (activity) are left out, as GitHub's timeline events are; state is replayed as
//!   events instead. **Internal notes and confidential issues are never mirrored**: the
//!   mirror is public, and those are members-only on GitLab.
//! * **Diff notes** keep their line: `position.new_path`/`new_line` (or `old_*` for a
//!   removed line), on `position.head_sha`, as the comment anchor
//!   (<https://docs.gitlab.com/api/discussions/>).
//! * **Merged** merge requests record the merge commit, else the squash commit, else (a
//!   fast-forward merge) the head.
//! * **Heads.** The heads of open merge requests are pushed as `refs/mirror/pull/<iid>/head`,
//!   from `refs/merge-requests/<iid>/head`, which GitLab also keeps for a fork's merge
//!   request, as the GitHub path does for fork PRs. GitLab deletes that ref 14 days after a
//!   merge request closes or merges; such a merge request is imported with its metadata and
//!   state, and its body says its commits are not available.
//! * **Releases** keep their tag, title and notes; asset links are recorded by URL (GitLab
//!   reports no digest or size for them). Releases dated in the future are left out.

use std::collections::BTreeSet;
use std::path::Path;

use anyhow::Result;

use forge_core::collab::v2::TargetKind;
use forge_core::collab::{CommentAnchor, ReleaseAsset};

use crate::github::iso8601_to_unix;
use crate::gitlab::{GitlabClient, GitlabRepoRef, GlItem, GlNote, GlProject, GlRelease, Readable};
use crate::model::{self, SrcCollab, SrcComment, SrcPatch, SrcRelease, SrcTarget};
use crate::source::{Classes, Source, SourceMeta};

/// A GitLab project as a [`Source`].
pub struct GitlabSource {
    gl: GitlabClient,
    include_members_only: bool,
}

impl GitlabSource {
    /// Read `repo` over HTTPS (`GITLAB_TOKEN` when set). `include_members_only`
    /// (`--include-members-only`) lets a run mirror issues or merge requests that GitLab
    /// shows only to project members; without it such a run is refused.
    pub fn new(repo: GitlabRepoRef, include_members_only: bool) -> Self {
        Self {
            gl: GitlabClient::new(repo),
            include_members_only,
        }
    }
}

impl Source for GitlabSource {
    fn display(&self) -> String {
        self.gl.repo().display()
    }

    fn default_name(&self) -> String {
        self.gl.repo().name().to_ascii_lowercase()
    }

    fn meta(&self) -> Result<SourceMeta> {
        let p = self.gl.project()?;
        Ok(SourceMeta {
            default_branch: p.default_branch.unwrap_or_default(),
            description: p.description,
        })
    }

    fn collect(&self, classes: Classes, since: Option<&str>, limit: usize) -> Result<SrcCollab> {
        collect(&self.gl, classes, since, limit, self.include_members_only)
    }

    fn sync_mirror(&self, dir: &Path) -> Result<()> {
        self.gl.sync_mirror(dir)
    }

    fn pull_head_prefix(&self) -> &'static str {
        "refs/merge-requests/"
    }
}

/// An issue or a merge request, as listed.
struct Item {
    kind: TargetKind,
    gl: GlItem,
}

/// The source's view of what one run read: the model, and helpers for refused reads.
trait Outcome {
    /// `value`, or, when GitLab refused it, a warning, the run marked incomplete (so
    /// `--state` does not advance and the summary is partial), and `None`.
    fn readable<T>(&mut self, r: Readable<T>, what: &str, repo: &GitlabRepoRef) -> Option<T>;
}

impl Outcome for SrcCollab {
    fn readable<T>(&mut self, r: Readable<T>, what: &str, repo: &GitlabRepoRef) -> Option<T> {
        match r {
            Ok(v) => Some(v),
            Err(d) => {
                self.incomplete = true;
                let w = d.explain(what, repo);
                if !self.warnings.contains(&w) {
                    self.warnings.push(w);
                }
                None
            }
        }
    }
}

/// Refuse a project whose issues or merge requests GitLab shows only to its members,
/// unless `--include-members-only`: the mirror is public and permanent, and such content
/// must never be published by accident. (GitLab reports the access levels only to a token
/// that can see them; an anonymous run cannot read members-only content in the first place.)
fn check_members_only(project: &GlProject, classes: Classes, include: bool) -> Result<()> {
    let hidden: Vec<&str> = project
        .members_only()
        .into_iter()
        .filter(|f| match *f {
            "issues" => classes.issues,
            _ => classes.prs,
        })
        .collect();
    if hidden.is_empty() || include {
        return Ok(());
    }
    anyhow::bail!(
        "this project's {} are visible only to its members on GitLab, and a Forge mirror is \
         public and permanent. Pass --include-members-only to publish them anyway, or leave \
         them out with --sync",
        hidden.join(" and ")
    )
}

/// The project-level reads into `out`: label definitions, releases, and the open merge
/// requests whose heads the push mirrors. `--limit` bounds these listings too, so a trial
/// reads a few pages whatever the project's size.
fn project_level(
    gl: &GitlabClient,
    classes: Classes,
    limit: usize,
    out: &mut SrcCollab,
) -> Result<()> {
    let repo = gl.repo();
    if classes.labels {
        let labels = gl.labels()?;
        out.labels = out
            .readable(labels, "the label definitions", repo)
            .map(|l| {
                l.iter()
                    .filter_map(|l| model::label(&l.name, &l.color, l.description.as_deref()))
                    .collect()
            });
    }
    if classes.releases {
        let releases = gl.releases(limit)?;
        if let Some((r, more)) = out.readable(releases, "the releases", repo) {
            out.truncated |= more;
            out.releases = Some(
                r.iter()
                    .filter(|r| !r.upcoming_release && !r.tag_name.is_empty())
                    .map(release)
                    .collect(),
            );
        }
    }
    if classes.code && classes.prs {
        let open = gl.open_merge_requests(limit)?;
        // Refused: `None`, so the heads push is skipped (never pruned to nothing).
        out.open_pulls = out.readable(open, "the open merge requests", repo);
    }
    Ok(())
}

/// Read GitLab into the model. `limit` caps issues + merge requests (0 = all).
pub fn collect(
    gl: &GitlabClient,
    classes: Classes,
    since: Option<&str>,
    limit: usize,
    include_members_only: bool,
) -> Result<SrcCollab> {
    let repo = gl.repo();
    let project = gl.project()?;
    check_members_only(&project, classes, include_members_only)?;
    // Keys use the canonical project path (GitLab's own case), so they never depend on how
    // the source was typed.
    let canonical = GitlabRepoRef {
        path: if project.path_with_namespace.is_empty() {
            repo.path.clone()
        } else {
            project.path_with_namespace.clone()
        },
        ..repo.clone()
    };
    let mut out = SrcCollab::default();
    project_level(gl, classes, limit, &mut out)?;
    if !(classes.issues || classes.prs) {
        return Ok(out);
    }

    let items = items(gl, classes, since, limit, &mut out)?;
    // Which merge requests GitLab still has a head for (it deletes the ref 14 days after
    // one closes or merges). Unknown (the git read failed) is never reported as gone.
    let heads: Option<BTreeSet<u64>> = if classes.prs {
        match gl.merge_request_heads() {
            Ok(h) => Some(h),
            Err(e) => {
                out.warnings.push(format!(
                    "could not list the merge request heads of {}: {e:#}",
                    repo.display()
                ));
                None
            }
        }
    } else {
        None
    };
    let mut skipped_confidential = 0;
    // After a 401 no more threads are asked for: the token reads none (the warning says so
    // once).
    let mut threads_readable = true;
    for item in &items {
        let Ok(number) = u32::try_from(item.gl.iid) else {
            continue;
        };
        if item.gl.confidential {
            skipped_confidential += 1;
            continue;
        }
        let url = item_url(&canonical, item.kind, item.gl.iid);
        let head_gone = item.kind == TargetKind::Patch
            && heads.as_ref().is_some_and(|h| !h.contains(&item.gl.iid));
        let mut t = target(&canonical, item, number, &url, head_gone);
        if threads_readable && item.gl.user_notes_count > 0 {
            let notes = match item.kind {
                TargetKind::Issue => gl.issue_notes(item.gl.iid)?,
                TargetKind::Patch => gl
                    .mr_discussions(item.gl.iid)?
                    .map(|ds| ds.into_iter().flat_map(|d| d.notes).collect()),
            };
            // A 401 means this token reads no thread at all: stop asking. A 403 may concern
            // one item only (a members-only merge request), so the others are still read.
            if matches!(notes, Err(crate::gitlab::Denied::Unauthorized)) {
                threads_readable = false;
            }
            if let Some(mut notes) =
                out.readable(notes, "the comments on issues and merge requests", repo)
            {
                notes.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
                t.comments = notes
                    .iter()
                    .filter(|n| n.is_public_comment())
                    .map(|n| comment(&canonical, item, number, &url, n))
                    .collect();
            }
        }
        if item.kind == TargetKind::Patch {
            t.patch = Some(patch(&item.gl, number, classes.code, head_gone));
        }
        out.targets.push(t);
    }
    if skipped_confidential > 0 {
        out.warnings.push(format!(
            "{skipped_confidential} confidential issue(s) of {} were not mirrored: the mirror \
             is public",
            repo.display()
        ));
    }
    Ok(out)
}

/// The issues and merge requests to mirror, oldest first; `out.truncated` when `limit` left
/// some out, and a refused listing is a warning (the run is partial). With `limit`, each
/// listing is read only as far as its first `limit` items.
fn items(
    gl: &GitlabClient,
    classes: Classes,
    since: Option<&str>,
    limit: usize,
    out: &mut SrcCollab,
) -> Result<Vec<Item>> {
    let mut all = Vec::new();
    for (on, kind, what) in [
        (classes.issues, TargetKind::Issue, "the issues"),
        (classes.prs, TargetKind::Patch, "the merge requests"),
    ] {
        if !on {
            continue;
        }
        let listed = match kind {
            TargetKind::Issue => gl.issues(since, limit)?,
            TargetKind::Patch => gl.merge_requests(since, limit)?,
        };
        if let Some((list, more)) = out.readable(listed, what, gl.repo()) {
            out.truncated |= more;
            all.extend(list.into_iter().map(|gl| Item { kind, gl }));
        }
    }
    all.sort_by(|a, b| a.gl.created_at.cmp(&b.gl.created_at));
    if limit > 0 && all.len() > limit {
        all.truncate(limit);
        out.truncated = true;
    }
    Ok(all)
}

/// The canonical web URL of an issue or merge request (the idempotency key).
fn item_url(repo: &GitlabRepoRef, kind: TargetKind, iid: u64) -> String {
    let what = match kind {
        TargetKind::Issue => "issues",
        TargetKind::Patch => "merge_requests",
    };
    format!("{}/-/{what}/{iid}", repo.web_url())
}

/// `#12` for an issue, `!12` for a merge request.
fn reference(kind: TargetKind, number: u32) -> String {
    match kind {
        TargetKind::Issue => format!("#{number}"),
        TargetKind::Patch => format!("!{number}"),
    }
}

fn header(repo: &GitlabRepoRef, r: &str, login: &str, created: u64, kind: &str) -> String {
    format!(
        "> Mirrored from {}{r} by @{login} ({kind}, {})\n\n",
        repo.display(),
        model::date(created)
    )
}

fn target(repo: &GitlabRepoRef, item: &Item, number: u32, url: &str, head_gone: bool) -> SrcTarget {
    let i = &item.gl;
    let created = iso8601_to_unix(&i.created_at);
    let r = reference(item.kind, number);
    let kind = match item.kind {
        TargetKind::Issue => "issue",
        TargetKind::Patch => "merge request",
    };
    let mut head = header(repo, &r, i.author.login(), created, kind);
    if head_gone {
        head.push_str(
            "> Its commits are not available: GitLab no longer has this merge request's head \
             (it deletes it 14 days after a merge request closes or merges).\n\n",
        );
    }
    SrcTarget {
        kind: item.kind,
        number,
        title: model::title(&i.title, &r),
        body: model::body(&head, i.description.as_deref().unwrap_or(""), url),
        imported: model::imported(i.author.login(), created, url),
        closed: i.is_closed(),
        merged_oid: i
            .is_merged()
            .then(|| {
                [&i.merge_commit_sha, &i.squash_commit_sha, &i.sha]
                    .into_iter()
                    .find_map(|s| s.as_deref().and_then(model::oid))
            })
            .flatten(),
        labels: i
            .labels
            .iter()
            .map(|l| model::label_name(l))
            .filter(|l| !l.is_empty())
            .collect(),
        draft: item.kind == TargetKind::Patch && i.draft,
        patch: None,
        comments: Vec::new(),
        reviews: Vec::new(),
    }
}

/// What a merge request points at. Only an open one's head is pushed (a closed one's
/// commits are not the mirror's to pay for), and only while GitLab still has it.
fn patch(m: &GlItem, number: u32, code: bool, head_gone: bool) -> SrcPatch {
    let base = if m.target_branch.is_empty() {
        "main"
    } else {
        &m.target_branch
    };
    SrcPatch {
        base_ref_name: format!("refs/heads/{base}"),
        source_ref_name: (code && !m.is_closed() && !head_gone)
            .then(|| format!("refs/mirror/pull/{number}/head")),
        head_oid: m
            .sha
            .as_deref()
            .and_then(model::oid)
            .unwrap_or_else(|| vec![0; 20]),
    }
}

fn comment(repo: &GitlabRepoRef, item: &Item, number: u32, url: &str, n: &GlNote) -> SrcComment {
    let created = iso8601_to_unix(&n.created_at);
    let note_url = format!("{url}#note_{}", n.id);
    let r = reference(item.kind, number);
    // A diff note keeps its place: a text note its line (the new side, or the old side for
    // a removed line), a file or image note its file.
    let anchor = n.position.as_ref().and_then(|p| {
        let (path, line, side) = match (p.new_line, p.old_line) {
            (Some(l), _) => (p.new_path.as_ref()?, Some(l), Some(1)),
            (None, Some(l)) => (
                p.old_path.as_ref().or(p.new_path.as_ref())?,
                Some(l),
                Some(0),
            ),
            (None, None) => (p.new_path.as_ref().or(p.old_path.as_ref())?, None, None),
        };
        Some(CommentAnchor {
            reply_to: None,
            commit_oid: p.head_sha.as_deref().and_then(model::oid),
            path: Some(model::clip(path, 500, 1000)),
            line,
            side,
        })
    });
    let (kind, text) = match &anchor {
        Some(a) => (
            "diff comment",
            format!(
                "`{}`{}\n\n{}",
                a.path.as_deref().unwrap_or_default(),
                a.line.map(|l| format!(" line {l}")).unwrap_or_default(),
                n.body
            ),
        ),
        None => ("comment", n.body.clone()),
    };
    SrcComment {
        body: model::body(
            &header(repo, &r, n.author.login(), created, kind),
            &text,
            &note_url,
        ),
        imported: model::imported(n.author.login(), created, &note_url),
        anchor,
    }
}

fn release(r: &GlRelease) -> SrcRelease {
    let assets = r
        .assets
        .links
        .iter()
        .filter(|l| !l.url.is_empty())
        .map(|l| ReleaseAsset {
            name: model::clip(&l.name, 200, 200),
            // GitLab records neither a digest nor a size for a release link.
            sha256: String::new(),
            size_bytes: 0,
            uris: vec![model::clip(
                l.direct_asset_url.as_deref().unwrap_or(&l.url),
                300,
                300,
            )],
            uri: None,
        })
        .collect();
    model::release(
        &r.tag_name,
        r.name.as_deref(),
        r.description.as_deref(),
        assets,
    )
}

#[cfg(test)]
#[path = "source_gitlab_tests.rs"]
mod tests;
