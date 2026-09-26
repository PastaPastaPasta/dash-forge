//! GitHub source layer: a thin wrapper over the `gh` CLI, so forge-import never implements
//! GitHub auth itself. `gh` reads `GH_TOKEN` / `GITHUB_TOKEN` (CI) or its own login.
//!
//! Every list read is `gh api <path> --paginate --jq '.[]'`, one JSON object per line across
//! all pages. The structs carry only what the importer maps; every field is
//! `#[serde(default)]` so an unexpected payload degrades instead of aborting a long import.

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
    /// Parse `owner/repo`, also accepting `https://github.com/owner/repo[.git]` and
    /// `github.com/owner/repo`. Only GitHub name characters are accepted, so the value is
    /// safe to put in an API path and a clone URL.
    pub fn parse(s: &str) -> Result<Self> {
        let trimmed = s
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_start_matches("github.com/")
            .trim_end_matches('/')
            .trim_end_matches(".git");
        let parts: Vec<&str> = trimmed.split('/').collect();
        let [owner, repo] = parts[..] else {
            bail!("invalid GitHub repository {s:?}: expected owner/repo");
        };
        let ok = |p: &str| {
            !p.is_empty()
                && !p.starts_with('.')
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        };
        if !ok(owner) || !ok(repo) {
            bail!("invalid GitHub repository {s:?}: expected owner/repo");
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

/// Repository metadata.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct RepoMeta {
    /// Default branch name.
    #[serde(default)]
    pub default_branch: String,
    /// GitHub-reported size, KiB.
    #[serde(default)]
    pub size: u64,
    /// Description.
    #[serde(default)]
    pub description: Option<String>,
}

/// A GitHub user.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhUser {
    /// Login.
    #[serde(default)]
    pub login: String,
}

/// A GitHub label.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhLabel {
    /// Name.
    #[serde(default)]
    pub name: String,
    /// 6-hex color, no `#`.
    #[serde(default)]
    pub color: String,
    /// Description.
    #[serde(default)]
    pub description: Option<String>,
}

/// An issue as the issues endpoint returns it (PRs included: they carry `pull_request`).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhIssue {
    /// Number (shared by issues and PRs on GitHub).
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
    /// Browser URL.
    #[serde(default)]
    pub html_url: String,
    /// Creation time (ISO 8601).
    #[serde(default)]
    pub created_at: String,
    /// Labels now.
    #[serde(default)]
    pub labels: Vec<GhLabel>,
    /// Comment count.
    #[serde(default)]
    pub comments: u64,
    /// Present iff this is a pull request.
    #[serde(default)]
    pub pull_request: Option<serde_json::Value>,
}

impl GhIssue {
    /// Whether this record is a pull request.
    pub fn is_pull_request(&self) -> bool {
        self.pull_request.is_some()
    }

    /// Whether it is closed.
    pub fn is_closed(&self) -> bool {
        self.state.eq_ignore_ascii_case("closed")
    }
}

/// A PR head/base pointer.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhRef {
    /// Branch name.
    #[serde(default, rename = "ref")]
    pub ref_name: String,
    /// Commit.
    #[serde(default)]
    pub sha: String,
}

/// The pull-request detail (`pulls/{n}`).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhPull {
    /// Number.
    #[serde(default)]
    pub number: u64,
    /// Head.
    #[serde(default)]
    pub head: GhRef,
    /// Base.
    #[serde(default)]
    pub base: GhRef,
    /// Merge time, when merged.
    #[serde(default)]
    pub merged_at: Option<String>,
    /// The merge (or squash/rebase result) commit.
    #[serde(default)]
    pub merge_commit_sha: Option<String>,
    /// Draft.
    #[serde(default)]
    pub draft: bool,
}

/// A release asset.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhAsset {
    /// File name.
    #[serde(default)]
    pub name: String,
    /// Size in bytes.
    #[serde(default)]
    pub size: u64,
    /// Download URL.
    #[serde(default)]
    pub browser_download_url: String,
    /// `sha256:<hex>`, when GitHub computed one.
    #[serde(default)]
    pub digest: Option<String>,
}

/// A release.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhRelease {
    /// Tag.
    #[serde(default)]
    pub tag_name: String,
    /// Title.
    #[serde(default)]
    pub name: Option<String>,
    /// Notes.
    #[serde(default)]
    pub body: Option<String>,
    /// Draft (never mirrored).
    #[serde(default)]
    pub draft: bool,
    /// Assets.
    #[serde(default)]
    pub assets: Vec<GhAsset>,
}

/// An issue/PR conversation comment, or a PR review (line) comment.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhComment {
    /// Comment id.
    #[serde(default)]
    pub id: u64,
    /// Body.
    #[serde(default)]
    pub body: Option<String>,
    /// Author.
    #[serde(default)]
    pub user: GhUser,
    /// Browser URL (the idempotency key recorded in `imported.url`).
    #[serde(default)]
    pub html_url: String,
    /// Creation time.
    #[serde(default)]
    pub created_at: String,
    /// `…/issues/{n}` (conversation comments).
    #[serde(default)]
    pub issue_url: Option<String>,
    /// `…/pulls/{n}` (review comments).
    #[serde(default)]
    pub pull_request_url: Option<String>,
    /// Review comments: file path.
    #[serde(default)]
    pub path: Option<String>,
    /// Review comments: line in the new file.
    #[serde(default)]
    pub line: Option<u64>,
    /// Review comments: `LEFT` / `RIGHT`.
    #[serde(default)]
    pub side: Option<String>,
    /// Review comments: the commit commented on.
    #[serde(default)]
    pub commit_id: Option<String>,
}

impl GhComment {
    /// The issue or PR number this comment belongs to.
    pub fn number(&self) -> Option<u64> {
        let url = self
            .issue_url
            .as_deref()
            .or(self.pull_request_url.as_deref())?;
        url.rsplit('/').next()?.parse().ok()
    }
}

/// A PR review.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhReview {
    /// Review id.
    #[serde(default)]
    pub id: u64,
    /// Reviewer.
    #[serde(default)]
    pub user: GhUser,
    /// Body.
    #[serde(default)]
    pub body: Option<String>,
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`.
    #[serde(default)]
    pub state: String,
    /// The commit reviewed.
    #[serde(default)]
    pub commit_id: Option<String>,
    /// Browser URL.
    #[serde(default)]
    pub html_url: String,
    /// Submission time.
    #[serde(default)]
    pub submitted_at: Option<String>,
}

/// The GitHub client: every method shells `gh`.
pub struct GithubClient {
    repo: GithubRepoRef,
}

impl GithubClient {
    /// Bind to a source repo.
    pub fn new(repo: GithubRepoRef) -> Self {
        Self { repo }
    }

    fn path(&self, rest: &str) -> String {
        format!("repos/{}/{rest}", self.repo.slug())
    }

    /// Repository metadata (also proves the repo exists and `gh` works).
    pub fn repo_meta(&self) -> Result<RepoMeta> {
        let out = api_json(&format!("repos/{}", self.repo.slug()))?;
        serde_json::from_slice(&out).context("parsing repository metadata")
    }

    /// Issues and PRs updated since `since` (ISO 8601), or all of them.
    pub fn issues(&self, since: Option<&str>) -> Result<Vec<GhIssue>> {
        api_list(&self.path(&with_since(
            "issues?state=all&per_page=100&sort=updated&direction=asc",
            since,
        )))
    }

    /// One PR's detail.
    pub fn pull(&self, number: u64) -> Result<GhPull> {
        let out = api_json(&self.path(&format!("pulls/{number}")))?;
        serde_json::from_slice(&out).with_context(|| format!("parsing PR #{number}"))
    }

    /// Every label.
    pub fn labels(&self) -> Result<Vec<GhLabel>> {
        api_list(&self.path("labels?per_page=100"))
    }

    /// Every release.
    pub fn releases(&self) -> Result<Vec<GhRelease>> {
        api_list(&self.path("releases?per_page=100"))
    }

    /// Conversation comments on issues and PRs, updated since `since`.
    pub fn issue_comments(&self, since: Option<&str>) -> Result<Vec<GhComment>> {
        api_list(&self.path(&with_since(
            "issues/comments?per_page=100&sort=created&direction=asc",
            since,
        )))
    }

    /// PR review (line) comments, updated since `since`.
    pub fn review_comments(&self, since: Option<&str>) -> Result<Vec<GhComment>> {
        api_list(&self.path(&with_since(
            "pulls/comments?per_page=100&sort=created&direction=asc",
            since,
        )))
    }

    /// One PR's reviews.
    pub fn reviews(&self, number: u64) -> Result<Vec<GhReview>> {
        api_list(&self.path(&format!("pulls/{number}/reviews?per_page=100")))
    }

    /// Mirror-clone (or update) the source into the bare repo at `dir`: branches, tags and
    /// `refs/pull/*`. An existing mirror is fetched with `--prune`, so deletions and
    /// force-pushes on GitHub are reflected.
    pub fn sync_mirror(&self, dir: &Path) -> Result<()> {
        let url = format!("https://github.com/{}.git", self.repo.slug());
        // The token rides in an auth header from the environment, never in the URL or argv.
        let header = gh_token().map(|t| {
            use base64_lite::encode;
            format!(
                "AUTHORIZATION: basic {}",
                encode(format!("x-access-token:{t}").as_bytes())
            )
        });
        let mut cmd = Command::new("git");
        if let Some(h) = &header {
            cmd.env("GIT_CONFIG_COUNT", "1")
                .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
                .env("GIT_CONFIG_VALUE_0", h);
        }
        if dir.join("HEAD").exists() {
            cmd.arg("-C")
                .arg(dir)
                .args(["fetch", "--prune", "--quiet", &url])
                .args([
                    "+refs/heads/*:refs/heads/*",
                    "+refs/tags/*:refs/tags/*",
                    "+refs/pull/*/head:refs/pull/*/head",
                ]);
        } else {
            cmd.args(["clone", "--mirror", "--quiet", &url]).arg(dir);
        }
        let status = cmd.status().context("running git")?;
        if !status.success() {
            bail!(
                "fetching https://github.com/{} failed (private repository? set GH_TOKEN)",
                self.repo.slug()
            );
        }
        Ok(())
    }
}

fn with_since(path: &str, since: Option<&str>) -> String {
    match since {
        Some(s) => format!("{path}&since={s}"),
        None => path.to_string(),
    }
}

/// The token `gh` would use: `GH_TOKEN`, `GITHUB_TOKEN`, else `gh auth token`.
fn gh_token() -> Option<String> {
    for var in ["GH_TOKEN", "GITHUB_TOKEN"] {
        if let Ok(t) = std::env::var(var) {
            if !t.trim().is_empty() {
                return Some(t.trim().to_string());
            }
        }
    }
    let out = Command::new("gh").args(["auth", "token"]).output().ok()?;
    let t = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !t.is_empty()).then_some(t)
}

/// Minimal standard base64 (for the git auth header); avoids a dependency for 20 lines.
mod base64_lite {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(input: &[u8]) -> String {
        let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
        for chunk in input.chunks(3) {
            let b = [
                chunk[0],
                chunk.get(1).copied().unwrap_or(0),
                chunk.get(2).copied().unwrap_or(0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for (i, shift) in [18u32, 12, 6, 0].iter().enumerate() {
                if i <= chunk.len() {
                    out.push(ALPHABET[((n >> shift) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }
}

/// Run `gh`, retrying transient network failures; 4xx and auth failures fail at once.
fn gh_output_with_retry(args: &[&str], what: &str) -> Result<std::process::Output> {
    const ATTEMPTS: u32 = 4;
    let mut last_err = String::new();
    for attempt in 1..=ATTEMPTS {
        let out = Command::new("gh")
            .args(args)
            .output()
            .context("running `gh` (is the GitHub CLI installed?)")?;
        if out.status.success() {
            return Ok(out);
        }
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let transient = [
            "connection reset",
            "timeout",
            "TLS handshake",
            "temporary failure",
            "EOF",
            "502",
            "503",
            "504",
        ]
        .iter()
        .any(|m| stderr.contains(m));
        if !transient || attempt == ATTEMPTS {
            bail!("{what} failed: {stderr}");
        }
        let wait = std::time::Duration::from_secs(5 * u64::from(attempt));
        tracing::warn!(attempt, wait_secs = wait.as_secs(), %stderr, "transient gh failure; retrying");
        std::thread::sleep(wait);
        last_err = stderr;
    }
    Err(anyhow!("{what} failed: {last_err}"))
}

fn api_json(path: &str) -> Result<Vec<u8>> {
    Ok(gh_output_with_retry(&["api", path], &format!("`gh api {path}`"))?.stdout)
}

fn api_list<T: for<'de> Deserialize<'de>>(path: &str) -> Result<Vec<T>> {
    let out = gh_output_with_retry(
        &["api", path, "--paginate", "--jq", ".[]"],
        &format!("`gh api {path}`"),
    )?;
    let text = String::from_utf8(out.stdout).context("gh api output was not UTF-8")?;
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_str(l).with_context(|| format!("parsing an element of {path}")))
        .collect()
}

/// ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`) to unix seconds; `0` when unparseable (provenance
/// is best-effort and never aborts an import).
pub fn iso8601_to_unix(s: &str) -> u64 {
    if s.len() < 19 {
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
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = (if y_adj >= 0 { y_adj } else { y_adj - 399 }) / 400;
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + h * 3_600 + mi * 60 + se).unwrap_or(0)
}

/// Unix seconds to ISO 8601 UTC (the `since` parameter).
pub fn unix_to_iso8601(secs: u64) -> String {
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rem = secs % 86_400;
    // civil_from_days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_slug_and_url_forms_and_refuses_junk() {
        for form in [
            "dashpay/dips",
            "https://github.com/dashpay/dips",
            "https://github.com/dashpay/dips.git",
            "github.com/dashpay/dips/",
        ] {
            assert_eq!(GithubRepoRef::parse(form).unwrap().slug(), "dashpay/dips");
        }
        for bad in ["nope", "a/b/c", "a/b?x=1", "../x", "a/b c", "a/.git"] {
            assert!(GithubRepoRef::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn iso8601_round_trips() {
        assert_eq!(iso8601_to_unix("1970-01-01T00:00:00Z"), 0);
        assert_eq!(iso8601_to_unix("2020-01-02T03:04:05Z"), 1_577_934_245);
        assert_eq!(iso8601_to_unix("2026-07-10T20:44:57Z"), 1_783_716_297);
        for t in [0, 951_782_400, 1_577_934_245, 1_783_716_297] {
            assert_eq!(iso8601_to_unix(&unix_to_iso8601(t)), t);
        }
        assert_eq!(iso8601_to_unix("garbage"), 0);
    }

    #[test]
    fn comment_numbers_come_from_the_parent_url() {
        let c = GhComment {
            issue_url: Some("https://api.github.com/repos/o/r/issues/12".into()),
            ..Default::default()
        };
        assert_eq!(c.number(), Some(12));
        let r = GhComment {
            pull_request_url: Some("https://api.github.com/repos/o/r/pulls/7".into()),
            ..Default::default()
        };
        assert_eq!(r.number(), Some(7));
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_lite::encode(b""), "");
        assert_eq!(base64_lite::encode(b"f"), "Zg==");
        assert_eq!(base64_lite::encode(b"fo"), "Zm8=");
        assert_eq!(base64_lite::encode(b"foo"), "Zm9v");
        assert_eq!(base64_lite::encode(b"foobar"), "Zm9vYmFy");
    }
}
