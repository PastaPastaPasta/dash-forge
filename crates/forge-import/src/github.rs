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

/// The login GitHub shows for a deleted account.
pub const GHOST: &str = "ghost";

/// A GitHub user. A deleted account comes back as `"user": null` (or without a login) and
/// reads as [`GHOST`], the name GitHub itself shows for it.
#[derive(Debug, Clone)]
pub struct GhUser {
    /// Login ([`GHOST`] for a deleted account).
    pub login: String,
}

impl Default for GhUser {
    fn default() -> Self {
        Self {
            login: GHOST.to_string(),
        }
    }
}

impl<'de> Deserialize<'de> for GhUser {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            #[serde(default)]
            login: Option<String>,
        }
        let login = Option::<Raw>::deserialize(d)?
            .and_then(|r| r.login)
            .filter(|l| !l.trim().is_empty());
        Ok(login.map_or_else(Self::default, |login| Self { login }))
    }
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
    /// `owner:branch` (a fork's owner for a PR from a fork).
    #[serde(default)]
    pub label: String,
    /// Branch name.
    #[serde(default, rename = "ref")]
    pub ref_name: String,
    /// Commit.
    #[serde(default)]
    pub sha: String,
    /// The repository the branch is in (`None` when it was deleted, e.g. a removed fork).
    #[serde(default)]
    pub repo: Option<GhRepoName>,
}

/// A repository as a PR's head or base names it.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhRepoName {
    /// `owner/name`.
    #[serde(default)]
    pub full_name: String,
}

/// The pull-request detail (`pulls/{n}`).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GhPull {
    /// Number.
    #[serde(default)]
    pub number: u64,
    /// Review (line) comments at the source (the detail endpoint; the listing omits it).
    #[serde(default)]
    pub review_comments: u64,
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
    /// Last update (ISO 8601), for the incremental listing.
    #[serde(default)]
    pub updated_at: String,
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
    /// The release's page on GitHub.
    #[serde(default)]
    pub html_url: String,
    /// When it was published (ISO 8601; `None` for a draft).
    #[serde(default)]
    pub published_at: Option<String>,
    /// Who published it.
    #[serde(default)]
    pub author: Option<GhUser>,
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

/// How the client reaches the GitHub REST API: `gh` in production, recorded responses in
/// tests.
pub trait GhApi {
    /// One request's JSON body (`path` is relative to the API root).
    fn json(&self, path: &str) -> Result<Vec<u8>>;
    /// Every element of a paginated array listing, one JSON document each, across all
    /// pages.
    fn list(&self, path: &str) -> Result<Vec<String>>;
}

/// The `gh` CLI (`gh api`), which owns auth, pagination and retries.
pub struct GhCli;

impl GhApi for GhCli {
    fn json(&self, path: &str) -> Result<Vec<u8>> {
        api_json(path)
    }

    fn list(&self, path: &str) -> Result<Vec<String>> {
        api_list_lines(path)
    }
}

/// The GitHub client.
pub struct GithubClient {
    repo: GithubRepoRef,
    api: Box<dyn GhApi>,
}

impl GithubClient {
    /// Bind to a source repo, reading through `gh`.
    pub fn new(repo: GithubRepoRef) -> Self {
        Self::with_api(repo, Box::new(GhCli))
    }

    /// Bind to a source repo, reading through `api`.
    pub fn with_api(repo: GithubRepoRef, api: Box<dyn GhApi>) -> Self {
        Self { repo, api }
    }

    fn path(&self, rest: &str) -> String {
        format!("repos/{}/{rest}", self.repo.slug())
    }

    fn get<T: for<'de> Deserialize<'de>>(&self, path: &str, what: &str) -> Result<T> {
        serde_json::from_slice(&self.api.json(path)?).with_context(|| format!("parsing {what}"))
    }

    fn list<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<Vec<T>> {
        self.api
            .list(path)?
            .iter()
            .map(|l| {
                serde_json::from_str(l).with_context(|| format!("parsing an element of {path}"))
            })
            .collect()
    }

    /// Repository metadata (also proves the repo exists and `gh` works).
    pub fn repo_meta(&self) -> Result<RepoMeta> {
        self.get(
            &format!("repos/{}", self.repo.slug()),
            "repository metadata",
        )
    }

    /// Issues and PRs updated since `since` (ISO 8601), or all of them.
    pub fn issues(&self, since: Option<&str>) -> Result<Vec<GhIssue>> {
        self.list(&self.path(&with_since(
            "issues?state=all&per_page=100&sort=updated&direction=asc",
            since,
        )))
    }

    /// The first issues and PRs by number (oldest created first, which is number order),
    /// updated since `since`, page by page until `keep` has accepted `want` of them. Returns
    /// the accepted items and whether the listing had more accepted ones after those: a
    /// `--limit` run reads a handful of pages, not a large repository's whole history.
    pub fn first_issues(
        &self,
        since: Option<&str>,
        want: usize,
        keep: impl Fn(&GhIssue) -> bool,
    ) -> Result<(Vec<GhIssue>, bool)> {
        let path = self.path(&with_since(
            "issues?state=all&per_page=100&sort=created&direction=asc",
            since,
        ));
        let mut out = Vec::new();
        for page in 1.. {
            let batch: Vec<GhIssue> =
                self.get(&format!("{path}&page={page}"), "the issue listing")?;
            let last_page = batch.len() < 100;
            for i in batch.into_iter().filter(|i| keep(i)) {
                if out.len() == want {
                    return Ok((out, true));
                }
                out.push(i);
            }
            if last_page {
                break;
            }
        }
        Ok((out, false))
    }

    /// The first `want` pull requests (oldest created first) as issue records, for a
    /// `--limit` run that mirrors PRs only: the pulls listing skips the issues, which on an
    /// issue-heavy repository the issue listing would page through. Whether there were more.
    pub fn first_pulls(&self, want: usize) -> Result<(Vec<GhIssue>, bool)> {
        let path = self.path("pulls?state=all&sort=created&direction=asc&per_page=100");
        let mut numbers = Vec::new();
        for page in 1.. {
            let batch: Vec<GhPull> =
                self.get(&format!("{path}&page={page}"), "the pull request listing")?;
            let last_page = batch.len() < 100;
            for p in batch {
                if numbers.len() == want {
                    return Ok((self.issues_numbered(&numbers)?, true));
                }
                numbers.push(p.number);
            }
            if last_page {
                break;
            }
        }
        Ok((self.issues_numbered(&numbers)?, false))
    }

    /// The issue records (title, body, author, labels, state) of these numbers.
    fn issues_numbered(&self, numbers: &[u64]) -> Result<Vec<GhIssue>> {
        numbers
            .iter()
            .map(|n| self.get(&self.path(&format!("issues/{n}")), &format!("#{n}")))
            .collect()
    }

    /// The numbers of every open PR (their heads are what the mirror pushes).
    pub fn open_pulls(&self) -> Result<Vec<u64>> {
        Ok(self
            .list::<GhPull>(&self.path("pulls?state=open&per_page=100"))?
            .into_iter()
            .map(|p| p.number)
            .collect())
    }

    /// One issue or PR as the issues listing shows it.
    pub fn issue(&self, number: u64) -> Result<GhIssue> {
        self.get(
            &self.path(&format!("issues/{number}")),
            &format!("#{number}"),
        )
    }

    /// One PR's detail.
    pub fn pull(&self, number: u64) -> Result<GhPull> {
        self.get(
            &self.path(&format!("pulls/{number}")),
            &format!("PR #{number}"),
        )
    }

    /// Every pull request's detail (head, base, merge, draft) from the paginated listing,
    /// by number: one call per 100 PRs instead of one per PR. Newest updated first, so with
    /// `since` the listing stops at the first PR not updated since.
    pub fn pulls(&self, since: Option<&str>) -> Result<std::collections::BTreeMap<u64, GhPull>> {
        let path = self.path("pulls?state=all&sort=updated&direction=desc&per_page=100");
        let all: Vec<GhPull> = match since {
            None => self.list(&path)?,
            Some(since) => {
                let mut out = Vec::new();
                let mut page = 1;
                loop {
                    let batch: Vec<GhPull> =
                        self.get(&format!("{path}&page={page}"), "the pull request listing")?;
                    let done = batch.len() < 100
                        || batch.last().is_some_and(|p| p.updated_at.as_str() < since);
                    out.extend(batch.into_iter().filter(|p| p.updated_at.as_str() >= since));
                    if done {
                        break;
                    }
                    page += 1;
                }
                out
            }
        };
        Ok(all.into_iter().map(|p| (p.number, p)).collect())
    }

    /// Every label.
    pub fn labels(&self) -> Result<Vec<GhLabel>> {
        self.list(&self.path("labels?per_page=100"))
    }

    /// Every release.
    pub fn releases(&self) -> Result<Vec<GhRelease>> {
        self.list(&self.path("releases?per_page=100"))
    }

    /// Conversation comments on every issue and PR, updated since `since`.
    pub fn issue_comments(&self, since: Option<&str>) -> Result<Vec<GhComment>> {
        self.list(&self.path(&with_since(
            "issues/comments?per_page=100&sort=created&direction=asc",
            since,
        )))
    }

    /// Every PR's review (line) comments, updated since `since`.
    pub fn review_comments(&self, since: Option<&str>) -> Result<Vec<GhComment>> {
        self.list(&self.path(&with_since(
            "pulls/comments?per_page=100&sort=created&direction=asc",
            since,
        )))
    }

    /// One issue's or PR's conversation comments, updated since `since`.
    pub fn comments_on(&self, number: u64, since: Option<&str>) -> Result<Vec<GhComment>> {
        self.list(&self.path(&with_since(
            &format!("issues/{number}/comments?per_page=100"),
            since,
        )))
    }

    /// One PR's review (line) comments, updated since `since`.
    pub fn review_comments_on(&self, number: u64, since: Option<&str>) -> Result<Vec<GhComment>> {
        self.list(&self.path(&with_since(
            &format!("pulls/{number}/comments?per_page=100"),
            since,
        )))
    }

    /// One PR's reviews.
    pub fn reviews(&self, number: u64) -> Result<Vec<GhReview>> {
        self.list(&self.path(&format!("pulls/{number}/reviews?per_page=100")))
    }

    /// The repository's clone URL.
    pub fn clone_url(&self) -> String {
        format!("https://github.com/{}.git", self.repo.slug())
    }

    /// Mirror-clone (or update) the source into the bare repo at `dir`: branches, tags and
    /// `refs/pull/*`. An existing mirror is fetched with `--prune`, so deletions and
    /// force-pushes on GitHub are reflected.
    pub fn sync_mirror(&self, dir: &Path) -> Result<()> {
        let url = self.clone_url();
        let mut cmd = Command::new("git");
        if let Some((k, v)) = git_auth() {
            append_git_config(&mut cmd, &k, &v);
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

/// The git config entry that authenticates git to github.com with `gh`'s token: an auth
/// header from the environment, never the URL or argv. `None` without a token.
pub(crate) fn git_auth() -> Option<(String, String)> {
    gh_token().map(|t| {
        (
            "http.https://github.com/.extraheader".to_string(),
            format!(
                "AUTHORIZATION: basic {}",
                base64_lite::encode(format!("x-access-token:{t}").as_bytes())
            ),
        )
    })
}

/// Give `cmd` one more git config entry through `GIT_CONFIG_*`, appended after any the
/// caller already set (the Mirror Action and the CI templates scope their settings that way).
pub(crate) fn append_git_config(cmd: &mut Command, key: &str, value: &str) {
    let n: usize = std::env::var("GIT_CONFIG_COUNT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    cmd.env("GIT_CONFIG_COUNT", (n + 1).to_string())
        .env(format!("GIT_CONFIG_KEY_{n}"), key)
        .env(format!("GIT_CONFIG_VALUE_{n}"), value);
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

/// Standard base64 of `input` (for git's HTTP auth headers).
pub fn base64(input: &[u8]) -> String {
    base64_lite::encode(input)
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
        if stderr.contains("rate limit") {
            // Primary or secondary rate limit: wait for the reset (bounded), then retry. A
            // run that keeps hitting it fails with a clear message rather than a raw 403.
            if attempt == ATTEMPTS {
                bail!(
                    "{what} failed: the GitHub API rate limit was reached; re-run after it \
                     resets (`gh api rate_limit`), or with a token that has a higher limit"
                );
            }
            let wait = rate_limit_wait(attempt);
            tracing::warn!(
                attempt,
                wait_secs = wait.as_secs(),
                "GitHub rate limit; waiting"
            );
            std::thread::sleep(wait);
            last_err = stderr;
            continue;
        }
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

/// How long to wait out a rate limit: until the core limit resets (from `gh api
/// rate_limit`, capped at 15 minutes), else a growing default (a secondary limit asks for
/// a minute or so).
fn rate_limit_wait(attempt: u32) -> std::time::Duration {
    let fallback = std::time::Duration::from_secs(60 * u64::from(attempt));
    let reset = Command::new("gh")
        .args([
            "api",
            "rate_limit",
            "--jq",
            ".resources.core | [.remaining, .reset] | @tsv",
        ])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let (remaining, reset) = text.split_once('\t')?;
            let (remaining, reset) = (remaining.parse::<u64>().ok()?, reset.parse::<u64>().ok()?);
            (remaining == 0).then_some(reset)
        });
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    match reset {
        Some(at) if at > now => std::time::Duration::from_secs((at - now + 5).min(15 * 60)),
        _ => fallback,
    }
}

fn api_json(path: &str) -> Result<Vec<u8>> {
    Ok(gh_output_with_retry(&["api", path], &format!("`gh api {path}`"))?.stdout)
}

fn api_list_lines(path: &str) -> Result<Vec<String>> {
    let out = gh_output_with_retry(
        &["api", path, "--paginate", "--jq", ".[]"],
        &format!("`gh api {path}`"),
    )?;
    let text = String::from_utf8(out.stdout).context("gh api output was not UTF-8")?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
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

    /// F-7: `octocat/Hello-World` has review comments by deleted accounts (`"user": null`,
    /// recorded in testdata/). They used to abort the whole import; as on GitHub itself,
    /// they are attributed to `@ghost`.
    #[test]
    fn a_deleted_author_is_the_ghost() {
        let raw = include_str!("../testdata/github/hello-world-ghost-review-comment.json");
        let c: GhComment = serde_json::from_str(raw).unwrap();
        assert_eq!(c.user.login, GHOST);
        assert_eq!(c.number(), Some(351));
        for doc in [
            r#"{"number":1,"user":null}"#,
            r#"{"number":1}"#,
            r#"{"number":1,"user":{"login":null}}"#,
            r#"{"number":1,"user":{"login":""}}"#,
        ] {
            let i: GhIssue = serde_json::from_str(doc).unwrap();
            assert_eq!(i.user.login, GHOST, "{doc}");
        }
        let r: GhReview = serde_json::from_str(r#"{"id":1,"user":null}"#).unwrap();
        assert_eq!(r.user.login, GHOST);
        let alive: GhIssue = serde_json::from_str(r#"{"user":{"login":"bob"}}"#).unwrap();
        assert_eq!(alive.user.login, "bob");
    }

    /// F-7 against a whole recorded listing: set `FORGE_IMPORT_GH_NDJSON` to a file of
    /// `gh api repos/octocat/Hello-World/pulls/comments --paginate --jq '.[]'` output.
    #[test]
    #[ignore = "needs a recorded listing (FORGE_IMPORT_GH_NDJSON)"]
    fn a_recorded_listing_parses() {
        let path = std::env::var("FORGE_IMPORT_GH_NDJSON").unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        let all: Vec<GhComment> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let ghosts = all.iter().filter(|c| c.user.login == GHOST).count();
        eprintln!("{} comments, {ghosts} by @ghost", all.len());
        assert!(ghosts > 0);
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
