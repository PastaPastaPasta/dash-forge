//! GitHub source layer — a thin wrapper over the `gh` CLI (authenticated out-of-band as
//! the invoking user) so forge-import never implements GitHub auth itself (PRD 06).
//!
//! Every read is `gh api <path> --paginate --jq '.[]'`, which streams each array element
//! as one JSON object per line (JSONL) across all pages — rate-limit- and pagination-aware
//! for free. Clones go through `gh repo clone`, which injects the token transparently.
//!
//! The mapped structs carry only the fields forge-import maps onto Forge collab docs; every
//! field is `#[serde(default)]` so an unexpected-shape payload degrades gracefully rather
//! than aborting a long migration.

use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;

/// A parsed `owner/repo` GitHub source reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubRepoRef {
    /// Repository owner (user or org).
    pub owner: String,
    /// Repository name.
    pub repo: String,
}

impl GithubRepoRef {
    /// Parse `owner/repo`, also accepting a full `https://github.com/owner/repo[.git]` or
    /// `github.com/owner/repo` URL form.
    pub fn parse(s: &str) -> Result<Self> {
        let trimmed = s
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_start_matches("github.com/")
            .trim_end_matches('/')
            .trim_end_matches(".git");
        let mut parts = trimmed.split('/').filter(|p| !p.is_empty());
        let owner = parts
            .next()
            .ok_or_else(|| anyhow!("invalid GitHub ref {s:?}: expected owner/repo"))?;
        let repo = parts
            .next()
            .ok_or_else(|| anyhow!("invalid GitHub ref {s:?}: expected owner/repo"))?;
        if parts.next().is_some() {
            bail!("invalid GitHub ref {s:?}: expected exactly owner/repo");
        }
        Ok(Self {
            owner: owner.to_string(),
            repo: repo.to_string(),
        })
    }

    /// The `owner/repo` slug.
    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

/// Repository metadata (default branch, size).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct RepoMeta {
    /// Default branch name (e.g. `main` / `master`).
    #[serde(default)]
    pub default_branch: String,
    /// On-disk size reported by GitHub, in KiB.
    #[serde(default)]
    pub size: u64,
    /// Repository description.
    #[serde(default)]
    pub description: Option<String>,
}

/// A GitHub user reference (author / actor).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhUser {
    /// GitHub login handle.
    #[serde(default)]
    pub login: String,
}

/// A GitHub label.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhLabel {
    /// Label name.
    #[serde(default)]
    pub name: String,
    /// 6-hex color (no leading `#`).
    #[serde(default)]
    pub color: String,
    /// Optional description.
    #[serde(default)]
    pub description: Option<String>,
}

/// A GitHub milestone.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhMilestone {
    /// Milestone title.
    #[serde(default)]
    pub title: String,
    /// Milestone description.
    #[serde(default)]
    pub description: Option<String>,
    /// Due date (ISO 8601), if set.
    #[serde(default)]
    pub due_on: Option<String>,
    /// `open` / `closed`.
    #[serde(default)]
    pub state: String,
}

/// A GitHub issue (the issues endpoint also returns PRs — those carry `pull_request`).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhIssue {
    /// Issue number.
    #[serde(default)]
    pub number: u64,
    /// Title.
    #[serde(default)]
    pub title: String,
    /// Body (may be null).
    #[serde(default)]
    pub body: Option<String>,
    /// Author.
    #[serde(default)]
    pub user: GhUser,
    /// `open` / `closed`.
    #[serde(default)]
    pub state: String,
    /// Browser URL.
    #[serde(default)]
    pub html_url: String,
    /// Creation time (ISO 8601).
    #[serde(default)]
    pub created_at: String,
    /// Labels attached at import time.
    #[serde(default)]
    pub labels: Vec<GhLabel>,
    /// Comment count (for cost estimation without fetching every thread).
    #[serde(default)]
    pub comments: u64,
    /// Present iff this "issue" is really a pull request (skip in the issue class).
    #[serde(default)]
    pub pull_request: Option<serde_json::Value>,
}

impl GhIssue {
    /// Whether this record is actually a pull request (returned by the issues endpoint).
    pub fn is_pull_request(&self) -> bool {
        self.pull_request.is_some()
    }
}

/// A GitHub pull request (from the `pulls` endpoint — carries head/base refs).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhPull {
    /// PR number.
    #[serde(default)]
    pub number: u64,
    /// Title.
    #[serde(default)]
    pub title: String,
    /// Body.
    #[serde(default)]
    pub body: Option<String>,
    /// Author.
    #[serde(default)]
    pub user: GhUser,
    /// `open` / `closed`.
    #[serde(default)]
    pub state: String,
    /// Whether the PR was merged.
    #[serde(default)]
    pub merged_at: Option<String>,
    /// Browser URL.
    #[serde(default)]
    pub html_url: String,
    /// Creation time (ISO 8601).
    #[serde(default)]
    pub created_at: String,
    /// Head ref (source branch).
    #[serde(default)]
    pub head: GhRef,
    /// Base ref (target branch).
    #[serde(default)]
    pub base: GhRef,
    /// Comment count.
    #[serde(default)]
    pub comments: u64,
}

impl GhPull {
    /// Whether this PR was merged.
    pub fn is_merged(&self) -> bool {
        self.merged_at.is_some()
    }
}

/// A PR head/base ref pointer.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhRef {
    /// Branch name (`ref` in the API).
    #[serde(default, rename = "ref")]
    pub ref_name: String,
    /// Commit SHA.
    #[serde(default)]
    pub sha: String,
}

/// A GitHub release.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhRelease {
    /// Tag name.
    #[serde(default)]
    pub tag_name: String,
    /// Display name.
    #[serde(default)]
    pub name: Option<String>,
    /// Release notes (markdown body).
    #[serde(default)]
    pub body: Option<String>,
    /// Whether the release is a draft.
    #[serde(default)]
    pub draft: bool,
}

/// An issue/PR comment.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhComment {
    /// Comment body.
    #[serde(default)]
    pub body: Option<String>,
    /// Author.
    #[serde(default)]
    pub user: GhUser,
    /// Browser URL.
    #[serde(default)]
    pub html_url: String,
    /// Creation time (ISO 8601).
    #[serde(default)]
    pub created_at: String,
}

/// The GitHub source client — every method shells `gh`.
pub struct GithubClient {
    repo: GithubRepoRef,
}

impl GithubClient {
    /// Bind a client to a source repo and verify `gh` is installed + authenticated.
    pub fn connect(repo: GithubRepoRef) -> Result<Self> {
        let status = Command::new("gh")
            .args(["auth", "status"])
            .output()
            .context("running `gh auth status` — is the GitHub CLI installed?")?;
        if !status.status.success() {
            bail!(
                "`gh` is not authenticated: {}\nrun `gh auth login` first",
                String::from_utf8_lossy(&status.stderr).trim()
            );
        }
        Ok(Self { repo })
    }

    /// Fetch repository metadata.
    pub fn repo_meta(&self) -> Result<RepoMeta> {
        let out = api_json(&format!("repos/{}", self.repo.slug()))?;
        serde_json::from_slice(&out).context("parsing repo metadata")
    }

    /// Fetch every issue (state=all). Includes PR records — callers filter with
    /// [`GhIssue::is_pull_request`].
    pub fn issues(&self) -> Result<Vec<GhIssue>> {
        api_list(&format!(
            "repos/{}/issues?state=all&per_page=100",
            self.repo.slug()
        ))
    }

    /// Fetch every pull request (state=all).
    pub fn pulls(&self) -> Result<Vec<GhPull>> {
        api_list(&format!(
            "repos/{}/pulls?state=all&per_page=100",
            self.repo.slug()
        ))
    }

    /// Fetch every label.
    pub fn labels(&self) -> Result<Vec<GhLabel>> {
        api_list(&format!("repos/{}/labels?per_page=100", self.repo.slug()))
    }

    /// Fetch every milestone (state=all).
    pub fn milestones(&self) -> Result<Vec<GhMilestone>> {
        api_list(&format!(
            "repos/{}/milestones?state=all&per_page=100",
            self.repo.slug()
        ))
    }

    /// Fetch every release.
    pub fn releases(&self) -> Result<Vec<GhRelease>> {
        api_list(&format!("repos/{}/releases?per_page=100", self.repo.slug()))
    }

    /// Fetch the comment thread for one issue/PR number.
    pub fn issue_comments(&self, number: u64) -> Result<Vec<GhComment>> {
        api_list(&format!(
            "repos/{}/issues/{number}/comments?per_page=100",
            self.repo.slug()
        ))
    }

    /// Bare-clone the source repo into `dest` (all refs, full history).
    ///
    /// Uses an HTTPS clone (no auth for public repos; private repos are reached via the token
    /// baked into the URL from `gh auth token`) rather than `gh repo clone`, whose SSH default
    /// depends on a working ssh-agent. The token, when present, is passed as
    /// `x-access-token:<token>@` — standard for GitHub HTTPS.
    pub fn clone_bare(&self, dest: &Path) -> Result<()> {
        let token = gh_token();
        let url = match &token {
            Some(t) => format!(
                "https://x-access-token:{t}@github.com/{}.git",
                self.repo.slug()
            ),
            None => format!("https://github.com/{}.git", self.repo.slug()),
        };
        let status = Command::new("git")
            .args(["clone", "--bare", "--quiet", &url])
            .arg(dest)
            .status()
            .context("running git clone (HTTPS)")?;
        if !status.success() {
            bail!(
                "cloning https://github.com/{} failed (private repo? run `gh auth login`)",
                self.repo.slug()
            );
        }
        Ok(())
    }
}

/// The GitHub token from `gh auth token`, if available (used only for HTTPS clone auth).
fn gh_token() -> Option<String> {
    let out = Command::new("gh").args(["auth", "token"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let t = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// Run a `gh` invocation, retrying transient network failures (connection resets, timeouts —
/// routine over the thousands of paginated calls a large enumeration makes). Non-transient
/// failures (4xx, auth) fail immediately.
fn gh_output_with_retry(args: &[&str], what: &str) -> Result<std::process::Output> {
    const ATTEMPTS: u32 = 4;
    let mut last_err = String::new();
    for attempt in 1..=ATTEMPTS {
        let out = Command::new("gh")
            .args(args)
            .output()
            .with_context(|| format!("running `gh {}`", args.join(" ")))?;
        if out.status.success() {
            return Ok(out);
        }
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let transient = stderr.contains("connection reset")
            || stderr.contains("timeout")
            || stderr.contains("TLS handshake")
            || stderr.contains("temporary failure")
            || stderr.contains("EOF")
            || stderr.contains("502")
            || stderr.contains("503");
        if !transient || attempt == ATTEMPTS {
            bail!("{what} failed: {stderr}");
        }
        let wait = std::time::Duration::from_secs(5 * u64::from(attempt));
        tracing::warn!(attempt, wait_secs = wait.as_secs(), %stderr, "transient gh failure — retrying");
        std::thread::sleep(wait);
        last_err = stderr;
    }
    bail!("{what} failed: {last_err}")
}

/// Run `gh api <path>` and return raw stdout bytes (single object).
fn api_json(path: &str) -> Result<Vec<u8>> {
    let out = gh_output_with_retry(&["api", path], &format!("`gh api {path}`"))?;
    Ok(out.stdout)
}

/// Run `gh api <path> --paginate --jq '.[]'` and deserialize the JSONL stream. Each output
/// line is one array element as a JSON object; blank lines are skipped.
fn api_list<T: for<'de> Deserialize<'de>>(path: &str) -> Result<Vec<T>> {
    let out = gh_output_with_retry(
        &["api", path, "--paginate", "--jq", ".[]"],
        &format!("`gh api {path} --paginate`"),
    )?;
    let text = String::from_utf8(out.stdout).context("gh api output was not UTF-8")?;
    let mut items = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let item: T = serde_json::from_str(line)
            .with_context(|| format!("parsing gh api element from {path}"))?;
        items.push(item);
    }
    Ok(items)
}

/// Parse an ISO 8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`, as GitHub emits) to unix
/// seconds. Returns `0` for an empty/unparseable value — provenance is best-effort and must
/// never abort a migration. Uses the Howard Hinnant days-from-civil algorithm (no external
/// date dependency).
pub fn iso8601_to_unix(s: &str) -> u64 {
    let bytes = s.as_bytes();
    // Expect at least "YYYY-MM-DDTHH:MM:SS".
    if bytes.len() < 19 {
        return 0;
    }
    let num = |a: usize, b: usize| -> Option<i64> { s.get(a..b)?.parse::<i64>().ok() };
    let (Some(y), Some(mo), Some(d), Some(h), Some(mi), Some(se)) = (
        num(0, 4),
        num(5, 7),
        num(8, 10),
        num(11, 13),
        num(14, 16),
        num(17, 19),
    ) else {
        return 0;
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return 0;
    }
    // days_from_civil: days since 1970-01-01.
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = (if y_adj >= 0 { y_adj } else { y_adj - 399 }) / 400;
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let total = days * 86_400 + h * 3_600 + mi * 60 + se;
    u64::try_from(total).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{iso8601_to_unix, GithubRepoRef};

    #[test]
    fn parses_slug_and_url_forms() {
        for form in [
            "dashpay/dips",
            "https://github.com/dashpay/dips",
            "https://github.com/dashpay/dips.git",
            "github.com/dashpay/dips/",
        ] {
            let r = GithubRepoRef::parse(form).unwrap();
            assert_eq!(r.owner, "dashpay");
            assert_eq!(r.repo, "dips");
            assert_eq!(r.slug(), "dashpay/dips");
        }
        assert!(GithubRepoRef::parse("nope").is_err());
        assert!(GithubRepoRef::parse("a/b/c").is_err());
    }

    #[test]
    fn iso8601_parses_known_epochs() {
        // Verified against `date -u -d ... +%s`.
        assert_eq!(iso8601_to_unix("1970-01-01T00:00:00Z"), 0);
        assert_eq!(iso8601_to_unix("2000-01-01T00:00:00Z"), 946_684_800);
        assert_eq!(iso8601_to_unix("2020-01-02T03:04:05Z"), 1_577_934_245);
        assert_eq!(iso8601_to_unix("2026-07-10T20:44:57Z"), 1_783_716_297);
    }

    #[test]
    fn iso8601_bad_input_is_zero() {
        assert_eq!(iso8601_to_unix(""), 0);
        assert_eq!(iso8601_to_unix("garbage"), 0);
        assert_eq!(iso8601_to_unix("2020-13-01T00:00:00Z"), 0);
    }
}
