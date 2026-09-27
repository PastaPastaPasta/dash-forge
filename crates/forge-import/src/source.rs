//! Where an import reads from: GitHub or GitLab, behind one [`Source`] trait, so the rest
//! of the pipeline (pricing, the git push, the on-chain diff, the summary) is shared.

use std::path::Path;

use anyhow::Result;

use crate::model::SrcCollab;

/// Which classes to sync.
#[derive(Debug, Clone, Copy, Default)]
#[allow(clippy::struct_excessive_bools)]
pub struct Classes {
    /// Branches and tags (and PR/MR heads when `prs`).
    pub code: bool,
    /// Issues (with comments and state).
    pub issues: bool,
    /// Pull (merge) requests (with comments, reviews and state).
    pub prs: bool,
    /// Releases.
    pub releases: bool,
    /// Label definitions.
    pub labels: bool,
}

impl Classes {
    /// Parse `code,issues,prs,releases,labels` (`all` = every class; `mrs` = `prs`).
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
                "prs" | "pulls" | "mrs" | "merge_requests" => c.prs = true,
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

/// The source named on the command line: GitLab for `gitlab.com/…`, a `https://gitlab.com/`
/// URL, or anything with `gitlab_url` (a self-hosted instance); GitHub otherwise
/// (`owner/repo`, `github.com/owner/repo`, its URL).
pub fn parse(spec: &str, gitlab_url: Option<&str>) -> Result<Box<dyn Source>> {
    let s = spec.trim();
    let gitlab = gitlab_url.is_some()
        || s.starts_with("gitlab.com/")
        || s.starts_with("https://gitlab.com/");
    Ok(if gitlab {
        Box::new(crate::source_gitlab::GitlabSource::new(
            crate::gitlab::GitlabRepoRef::parse(s, gitlab_url)?,
        ))
    } else {
        Box::new(crate::source_github::GithubSource::new(
            crate::github::GithubRepoRef::parse(s)?,
        ))
    })
}

/// What the destination repository is created with.
#[derive(Debug, Clone, Default)]
pub struct SourceMeta {
    /// The source's default branch (empty: `main`).
    pub default_branch: String,
    /// The source's description, if any.
    pub description: Option<String>,
}

/// A repository to import from.
pub trait Source {
    /// `host/owner/repo`, how the source is named in headers, summaries and state files.
    fn display(&self) -> String;

    /// The destination name when `--repo` is not given (the source's last path segment,
    /// lower-cased).
    fn default_name(&self) -> String;

    /// Repository metadata; also proves the source exists and can be read.
    fn meta(&self) -> Result<SourceMeta>;

    /// The collaboration data: issues and PRs/MRs with their threads and state, labels,
    /// releases, and the open PRs/MRs whose heads the git push mirrors. With `since` (ISO
    /// 8601), only what changed after it; `limit` caps issues + PRs (0 = all).
    fn collect(&self, classes: Classes, since: Option<&str>, limit: usize) -> Result<SrcCollab>;

    /// Mirror-clone (or update) the git data into the bare repository at `dir`: branches,
    /// tags, and the PR/MR heads under [`Self::pull_head_prefix`]. Only branches, tags and
    /// the open PRs'/MRs' heads are ever pushed (explicit refspecs, see
    /// [`crate::gitsync::Refs`]), whatever else the local mirror holds.
    fn sync_mirror(&self, dir: &Path) -> Result<()>;

    /// Where [`Self::sync_mirror`] keeps a PR/MR head: `<prefix><n>/head`.
    fn pull_head_prefix(&self) -> &'static str;
}
