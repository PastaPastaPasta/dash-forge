//! GitLab source layer: the REST API v4 over plain HTTPS (`curl`), for gitlab.com or a
//! self-hosted instance (`--gitlab-url`).
//!
//! **Auth.** `GITLAB_TOKEN` (a personal, project or group access token with the `read_api`
//! scope) is sent as `PRIVATE-TOKEN`; the importer never takes it on the command line. A
//! CI job token cannot read issues, issue notes, discussions or labels
//! (<https://docs.gitlab.com/ci/jobs/ci_job_token/>), so CI needs a project access token
//! too. Without a token only anonymous reads are made: GitLab.com then serves the project,
//! its issue and merge request listings, releases and the git data, but answers notes,
//! discussions and labels with `401` (observed on gitlab.com and on self-hosted instances,
//! 2026-09-27), so an anonymous run imports items without their threads and says so.
//!
//! **Pagination** is offset pagination, `per_page` at most 100, following the `Link:
//! rel="next"` header (<https://docs.gitlab.com/api/rest/#pagination-link-header>); totals
//! are not needed (`x-total` is omitted above 10,000 results).
//!
//! **Rate limits.** At most [`MAX_REQUESTS_PER_MINUTE`] requests a minute, GitLab.com's
//! proposed Free-tier burst limit (100/min, <https://docs.gitlab.com/user/gitlab_com/rate_limits/>),
//! and a `429` is retried after its `Retry-After` seconds (same page: "tells you how many
//! seconds remain until your quota resets").
//!
//! Every field is `#[serde(default)]`: an unexpected payload degrades one item, never the
//! import.

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;

/// The GitLab.com API origin.
pub const GITLAB_COM: &str = "https://gitlab.com";

/// Requests per minute the client allows itself (GitLab.com Free's proposed burst limit).
pub const MAX_REQUESTS_PER_MINUTE: u32 = 100;

/// A GitLab project: the instance and the project's full path (`group/subgroup/project`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitlabRepoRef {
    /// Instance origin, `https://host[:port]` (no trailing slash).
    pub base: String,
    /// Full project path.
    pub path: String,
}

impl GitlabRepoRef {
    /// Parse `gitlab.com/group/project`, `https://gitlab.com/group/sub/project[.git]`, or,
    /// with `base` (from `--gitlab-url`), a bare `group/project` or a URL on that host.
    /// Only GitLab path characters are accepted, so the value is safe in an API path and a
    /// clone URL.
    pub fn parse(s: &str, base: Option<&str>) -> Result<Self> {
        let base = base
            .map(|b| normalize_base(b).with_context(|| format!("invalid --gitlab-url {b:?}")))
            .transpose()?;
        let s = s.trim().trim_end_matches('/');
        let s = s.strip_suffix(".git").unwrap_or(s);
        let (origin, path) = if let Some(rest) = s.strip_prefix("https://") {
            let (host, path) = rest
                .split_once('/')
                .ok_or_else(|| anyhow!("invalid GitLab project {s:?}: no project path"))?;
            (format!("https://{host}"), path.to_string())
        } else if let Some(path) = s.strip_prefix("gitlab.com/") {
            (GITLAB_COM.to_string(), path.to_string())
        } else if let Some(b) = &base {
            let host = b.trim_start_matches("https://");
            let path = s.strip_prefix(&format!("{host}/")).unwrap_or(s);
            (b.clone(), path.to_string())
        } else {
            bail!(
                "invalid GitLab project {s:?}: use gitlab.com/<group>/<project>, its https URL, \
                 or --gitlab-url <https://host> with <group>/<project>"
            );
        };
        if let Some(b) = &base {
            if &origin != b {
                bail!("{s:?} is not on --gitlab-url {b}");
            }
        }
        let path = path.split("/-/").next().unwrap_or_default().to_string();
        let segments: Vec<&str> = path.split('/').collect();
        let ok = |p: &str| {
            !p.is_empty()
                && !p.starts_with('.')
                && !p.starts_with('-')
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        };
        if segments.len() < 2 || !segments.iter().all(|p| ok(p)) {
            bail!("invalid GitLab project {s:?}: expected <group>/<project>");
        }
        Ok(Self { base: origin, path })
    }

    /// `host/group/project`, how the source is named in headers and summaries.
    pub fn display(&self) -> String {
        format!("{}/{}", self.base.trim_start_matches("https://"), self.path)
    }

    /// The project's last path segment (the default destination name).
    pub fn name(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or(&self.path)
    }

    /// The API path prefix `projects/<url-encoded path>`.
    fn api_project(&self) -> String {
        format!("projects/{}", self.path.replace('/', "%2F"))
    }

    /// The project's web URL.
    pub fn web_url(&self) -> String {
        format!("{}/{}", self.base, self.path)
    }
}

/// `https://host[:port]` from a `--gitlab-url` value (http:// only for loopback, for tests
/// against a local instance).
fn normalize_base(b: &str) -> Result<String> {
    let b = b.trim().trim_end_matches('/');
    let host = b
        .strip_prefix("https://")
        .or_else(|| {
            b.strip_prefix("http://")
                .filter(|h| h.starts_with("127.0.0.1") || h.starts_with("localhost"))
        })
        .ok_or_else(|| anyhow!("expected https://<host>"))?;
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
    {
        bail!("expected https://<host> with no path");
    }
    Ok(b.to_string())
}

// ---------------------------------------------------------------------------------------
// Payloads (only what the importer maps)
// ---------------------------------------------------------------------------------------

/// Project metadata (`GET /projects/:id`).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GlProject {
    /// Numeric id (fork MRs name their source project by it).
    #[serde(default)]
    pub id: u64,
    /// Default branch.
    #[serde(default)]
    pub default_branch: Option<String>,
    /// Description.
    #[serde(default)]
    pub description: Option<String>,
    /// Full path, canonical case.
    #[serde(default)]
    pub path_with_namespace: String,
}

/// A user reference. A deleted account comes back as GitLab's "Ghost User".
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GlUser {
    /// Username (`@name`).
    #[serde(default)]
    pub username: String,
}

impl GlUser {
    /// The username, or `ghost` when missing.
    pub fn login(&self) -> &str {
        if self.username.trim().is_empty() {
            crate::github::GHOST
        } else {
            &self.username
        }
    }
}

/// An issue or a merge request (the fields both share, plus the MR ones).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GlItem {
    /// Per-project number (`#n` for issues, `!n` for merge requests).
    #[serde(default)]
    pub iid: u64,
    /// Title.
    #[serde(default)]
    pub title: String,
    /// Body.
    #[serde(default)]
    pub description: Option<String>,
    /// Author.
    #[serde(default, deserialize_with = "null_default")]
    pub author: GlUser,
    /// `opened`, `closed`, `locked` or `merged` (MRs).
    #[serde(default)]
    pub state: String,
    /// Browser URL (the idempotency key).
    #[serde(default)]
    pub web_url: String,
    /// Creation time.
    #[serde(default)]
    pub created_at: String,
    /// Last update.
    #[serde(default)]
    pub updated_at: String,
    /// Label names.
    #[serde(default)]
    pub labels: Vec<String>,
    /// Comments by people (system notes excluded).
    #[serde(default)]
    pub user_notes_count: u64,
    /// MR: head commit of the source branch.
    #[serde(default)]
    pub sha: Option<String>,
    /// MR: the merge commit, once merged (`null` for a fast-forward merge).
    #[serde(default)]
    pub merge_commit_sha: Option<String>,
    /// MR: the squash commit, once merged with squash.
    #[serde(default)]
    pub squash_commit_sha: Option<String>,
    /// MR: target branch.
    #[serde(default)]
    pub target_branch: String,
    /// MR: source branch.
    #[serde(default)]
    pub source_branch: String,
    /// MR: source project (another project for a fork MR; `null` once the fork is gone).
    #[serde(default)]
    pub source_project_id: Option<u64>,
    /// MR: target project.
    #[serde(default)]
    pub target_project_id: Option<u64>,
    /// MR: draft.
    #[serde(default)]
    pub draft: bool,
    /// Issue: confidential (members only; never mirrored).
    #[serde(default)]
    pub confidential: bool,
}

impl GlItem {
    /// Closed, or merged.
    pub fn is_closed(&self) -> bool {
        matches!(self.state.as_str(), "closed" | "merged" | "locked")
    }

    /// Merged.
    pub fn is_merged(&self) -> bool {
        self.state == "merged"
    }

    /// A merge request from another project (a fork).
    pub fn is_fork(&self) -> bool {
        self.source_project_id != self.target_project_id
    }
}

/// A diff position on an MR note (`text` positions carry lines).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GlPosition {
    /// `text`, `image` or `file`.
    #[serde(default)]
    pub position_type: String,
    /// The MR head commit the note was made on.
    #[serde(default)]
    pub head_sha: Option<String>,
    /// Path before the change.
    #[serde(default)]
    pub old_path: Option<String>,
    /// Path after the change.
    #[serde(default)]
    pub new_path: Option<String>,
    /// Line before the change (`null` on an added line).
    #[serde(default)]
    pub old_line: Option<u64>,
    /// Line after the change (`null` on a removed line).
    #[serde(default)]
    pub new_line: Option<u64>,
}

/// A note (comment), from a notes listing or inside a discussion.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GlNote {
    /// Note id (`#note_<id>` in its URL).
    #[serde(default)]
    pub id: u64,
    /// Body.
    #[serde(default)]
    pub body: String,
    /// Author.
    #[serde(default, deserialize_with = "null_default")]
    pub author: GlUser,
    /// Creation time.
    #[serde(default)]
    pub created_at: String,
    /// Activity ("changed the description", "closed"), not a comment.
    #[serde(default)]
    pub system: bool,
    /// Internal (members-only) note.
    #[serde(default)]
    pub internal: bool,
    /// Line anchor of a diff note.
    #[serde(default)]
    pub position: Option<GlPosition>,
}

/// A discussion thread: its notes, oldest first.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GlDiscussion {
    /// Discussion id.
    #[serde(default)]
    pub id: String,
    /// Notes.
    #[serde(default)]
    pub notes: Vec<GlNote>,
}

/// A label.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GlLabel {
    /// Name.
    #[serde(default)]
    pub name: String,
    /// `#rrggbb`.
    #[serde(default)]
    pub color: String,
    /// Description.
    #[serde(default)]
    pub description: Option<String>,
}

/// A release asset link.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GlLink {
    /// File name.
    #[serde(default)]
    pub name: String,
    /// Where it is (anywhere; GitLab only stores the link).
    #[serde(default)]
    pub url: String,
    /// The permanent `/-/releases/<tag>/downloads/...` URL, when one was set.
    #[serde(default)]
    pub direct_asset_url: Option<String>,
}

/// A release's assets.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GlAssets {
    /// Links (the uploaded or linked assets; GitLab's source archives are not listed).
    #[serde(default)]
    pub links: Vec<GlLink>,
}

/// A release.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GlRelease {
    /// Tag.
    #[serde(default)]
    pub tag_name: String,
    /// Title.
    #[serde(default)]
    pub name: Option<String>,
    /// Notes.
    #[serde(default)]
    pub description: Option<String>,
    /// Dated in the future (not published yet).
    #[serde(default)]
    pub upcoming_release: bool,
    /// Assets.
    #[serde(default)]
    pub assets: GlAssets,
}

/// `null` as the default (GitLab sends `"author": null` for some imported items).
fn null_default<'de, D, T>(d: D) -> std::result::Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

// ---------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------

/// One API response.
#[derive(Debug, Clone)]
pub struct GlResponse {
    /// HTTP status.
    pub status: u16,
    /// Body.
    pub body: Vec<u8>,
    /// `Link: <…>; rel="next"`, when there is a next page.
    pub next: Option<String>,
    /// `Retry-After` seconds, on a 429.
    pub retry_after: Option<u64>,
}

/// How the client reaches GitLab: HTTPS and git in production, recorded responses in tests.
pub trait GlApi {
    /// GET `url` (absolute).
    fn get(&self, url: &str) -> Result<GlResponse>;
    /// `git ls-remote <url> <pattern>` output (`<oid>\t<ref>` lines).
    fn ls_remote(&self, url: &str, pattern: &str) -> Result<String>;
}

/// The API over `curl` (already a dependency of every git install that speaks https). The
/// token goes in a header read from stdin (`-H @-`), never on the command line.
pub struct Curl {
    token: Option<String>,
    base: String,
}

impl Curl {
    /// For the instance at `base`, with `GITLAB_TOKEN` when it is set.
    pub fn from_env(base: &str) -> Self {
        Self {
            token: gitlab_token(),
            base: base.to_string(),
        }
    }
}

/// The git config entry that sends `token` to `base` as HTTP basic auth: an access token is
/// the password, with any non-empty user name
/// (<https://docs.gitlab.com/user/profile/personal_access_tokens/>). Passed through
/// `GIT_CONFIG_*`, so it is never in a URL, argv or a config file.
fn git_auth(base: &str, token: Option<&str>) -> Option<(String, String)> {
    token.map(|t| {
        (
            format!("http.{base}/.extraheader"),
            format!(
                "Authorization: Basic {}",
                crate::github::base64(format!("oauth2:{t}").as_bytes())
            ),
        )
    })
}

/// `GITLAB_TOKEN`, when set and not blank.
pub fn gitlab_token() -> Option<String> {
    std::env::var("GITLAB_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

impl GlApi for Curl {
    fn get(&self, url: &str) -> Result<GlResponse> {
        use std::io::Write as _;
        let headers = tempfile_path("forge-import-gl-headers");
        let mut cmd = Command::new("curl");
        cmd.args(["-sS", "--proto", "=https,http", "--max-time", "120", "-D"])
            .arg(&headers)
            .args(["-H", "Accept: application/json", "-H", "@-", "--", url])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().context("running curl (is it installed?)")?;
        {
            let mut stdin = child.stdin.take().expect("piped");
            if let Some(t) = &self.token {
                writeln!(stdin, "PRIVATE-TOKEN: {t}")?;
            }
        }
        let out = child.wait_with_output().context("running curl")?;
        let head = std::fs::read_to_string(&headers).unwrap_or_default();
        let _ = std::fs::remove_file(&headers);
        if !out.status.success() {
            bail!("GET {url}: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(parse_response(&head, out.stdout))
    }

    fn ls_remote(&self, url: &str, pattern: &str) -> Result<String> {
        let mut cmd = git_cmd(
            &["ls-remote", "--", url, pattern],
            git_auth(&self.base, self.token.as_deref()),
        );
        let out = cmd.output().context("running git ls-remote")?;
        if !out.status.success() {
            bail!(
                "git ls-remote {url} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

fn tempfile_path(prefix: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Status, next link and `Retry-After` from a `curl -D` header dump (the last response's
/// block, after any redirect or `100 Continue`).
pub fn parse_response(head: &str, body: Vec<u8>) -> GlResponse {
    let block = head
        .split("\r\n\r\n")
        .filter(|b| b.starts_with("HTTP/"))
        .last()
        .unwrap_or(head);
    let mut lines = block.lines();
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut next = None;
    let mut retry_after = None;
    for line in lines {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        match k.trim().to_ascii_lowercase().as_str() {
            "link" => next = next_link(v.trim()),
            "retry-after" => retry_after = v.trim().parse().ok(),
            _ => {}
        }
    }
    GlResponse {
        status,
        body,
        next,
        retry_after,
    }
}

/// The `rel="next"` URL of a `Link` header.
fn next_link(v: &str) -> Option<String> {
    v.split(',').find_map(|part| {
        let (url, rel) = part.split_once(';')?;
        rel.contains("rel=\"next\"").then(|| {
            url.trim()
                .trim_start_matches('<')
                .trim_end_matches('>')
                .to_string()
        })
    })
}

// ---------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------

/// Why a read returned nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denied {
    /// `401`/`403`: this token (or no token) may not read it.
    Unauthorized,
}

/// The GitLab client.
pub struct GitlabClient {
    repo: GitlabRepoRef,
    api: Box<dyn GlApi>,
    /// Request times in the last minute (the self-imposed rate limit).
    recent: RefCell<std::collections::VecDeque<Instant>>,
    /// `false` in tests: no waiting.
    pace: bool,
}

impl GitlabClient {
    /// Bind to a project, reading over HTTPS with `GITLAB_TOKEN` when set.
    pub fn new(repo: GitlabRepoRef) -> Self {
        Self {
            api: Box::new(Curl::from_env(&repo.base)),
            repo,
            recent: RefCell::default(),
            pace: true,
        }
    }

    /// Bind to a project, reading through `api` without pacing (tests).
    pub fn with_api(repo: GitlabRepoRef, api: Box<dyn GlApi>) -> Self {
        Self {
            repo,
            api,
            recent: RefCell::default(),
            pace: false,
        }
    }

    /// The project.
    pub fn repo(&self) -> &GitlabRepoRef {
        &self.repo
    }

    fn url(&self, rest: &str) -> String {
        let sep = if rest.is_empty() { "" } else { "/" };
        format!(
            "{}/api/v4/{}{sep}{rest}",
            self.repo.base,
            self.repo.api_project()
        )
    }

    /// Wait until one more request fits [`MAX_REQUESTS_PER_MINUTE`].
    fn throttle(&self) {
        if !self.pace {
            return;
        }
        let mut recent = self.recent.borrow_mut();
        let window = Duration::from_secs(60);
        while recent.front().is_some_and(|t| t.elapsed() >= window) {
            recent.pop_front();
        }
        if recent.len() >= MAX_REQUESTS_PER_MINUTE as usize {
            if let Some(oldest) = recent.front() {
                std::thread::sleep(window.saturating_sub(oldest.elapsed()));
            }
            recent.pop_front();
        }
        recent.push_back(Instant::now());
    }

    /// One GET, retrying a 429 after `Retry-After` and transient 5xx a few times. `Ok(Err)`
    /// when the token may not read it (401/403).
    fn get(&self, url: &str) -> Result<std::result::Result<GlResponse, Denied>> {
        const ATTEMPTS: u32 = 5;
        for attempt in 1..=ATTEMPTS {
            self.throttle();
            let r = self.api.get(url)?;
            match r.status {
                200..=299 => return Ok(Ok(r)),
                401 | 403 => return Ok(Err(Denied::Unauthorized)),
                429 | 500..=599 if attempt < ATTEMPTS => {
                    // 429: "Retry-After tells you how many seconds remain until your quota
                    // resets" (docs.gitlab.com/user/gitlab_com/rate_limits/). Capped at 15 min.
                    let wait = r
                        .retry_after
                        .unwrap_or(10 * u64::from(attempt))
                        .clamp(1, 900);
                    tracing::warn!(status = r.status, wait_secs = wait, "GitLab API; retrying");
                    if self.pace {
                        std::thread::sleep(Duration::from_secs(wait));
                    }
                }
                404 => bail!(
                    "GitLab answered 404 for {url}: the project does not exist, or it is \
                     private and GITLAB_TOKEN is unset or cannot read it"
                ),
                s => bail!(
                    "GET {url}: HTTP {s}: {}",
                    String::from_utf8_lossy(&r.body)
                        .chars()
                        .take(300)
                        .collect::<String>()
                ),
            }
        }
        bail!("GET {url}: GitLab kept refusing (rate limited or unavailable); re-run later")
    }

    fn one<T: for<'de> Deserialize<'de>>(&self, rest: &str, what: &str) -> Result<T> {
        match self.get(&self.url(rest))? {
            Ok(r) => serde_json::from_slice(&r.body).with_context(|| format!("parsing {what}")),
            Err(Denied::Unauthorized) => bail!(
                "GitLab refused to show {what} ({}): set GITLAB_TOKEN to a token with the \
                 read_api scope",
                self.repo.display()
            ),
        }
    }

    /// Every element of a paginated listing (following `Link: rel="next"`), or `Denied`.
    fn list<T: for<'de> Deserialize<'de>>(
        &self,
        rest: &str,
    ) -> Result<std::result::Result<Vec<T>, Denied>> {
        let mut url = self.url(rest);
        let mut out = Vec::new();
        loop {
            let r = match self.get(&url)? {
                Ok(r) => r,
                Err(d) => return Ok(Err(d)),
            };
            let page: Vec<T> = serde_json::from_slice(&r.body)
                .with_context(|| format!("parsing the listing {rest}"))?;
            out.extend(page);
            match r.next {
                // Only follow links on the same instance (never send the token elsewhere).
                Some(next) if next.starts_with(&format!("{}/", self.repo.base)) => url = next,
                _ => return Ok(Ok(out)),
            }
        }
    }

    /// Project metadata (also proves the project exists and can be read).
    pub fn project(&self) -> Result<GlProject> {
        self.one("", "the project")
    }

    /// Issues (all states), updated after `since`, oldest created first.
    pub fn issues(&self, since: Option<&str>) -> Result<Vec<GlItem>> {
        self.required(&with_since(
            "issues?state=all&order_by=created_at&sort=asc&per_page=100",
            since,
        ))
    }

    /// Merge requests (all states), updated after `since`, oldest created first.
    pub fn merge_requests(&self, since: Option<&str>) -> Result<Vec<GlItem>> {
        self.required(&with_since(
            "merge_requests?state=all&order_by=created_at&sort=asc&per_page=100",
            since,
        ))
    }

    /// The iids of every open merge request.
    pub fn open_merge_requests(&self) -> Result<Vec<u64>> {
        Ok(self
            .required::<GlItem>("merge_requests?state=opened&per_page=100")?
            .into_iter()
            .map(|m| m.iid)
            .collect())
    }

    /// An issue's notes, oldest first. `Err(Denied)` without the right token.
    pub fn issue_notes(&self, iid: u64) -> Result<std::result::Result<Vec<GlNote>, Denied>> {
        self.list(&format!(
            "issues/{iid}/notes?sort=asc&order_by=created_at&per_page=100"
        ))
    }

    /// A merge request's discussions (threads, diff notes with their positions).
    pub fn mr_discussions(
        &self,
        iid: u64,
    ) -> Result<std::result::Result<Vec<GlDiscussion>, Denied>> {
        self.list(&format!("merge_requests/{iid}/discussions?per_page=100"))
    }

    /// Label definitions. `Err(Denied)` without the right token.
    pub fn labels(&self) -> Result<std::result::Result<Vec<GlLabel>, Denied>> {
        self.list("labels?per_page=100")
    }

    /// Releases.
    pub fn releases(&self) -> Result<Vec<GlRelease>> {
        self.required("releases?per_page=100")
    }

    fn required<T: for<'de> Deserialize<'de>>(&self, rest: &str) -> Result<Vec<T>> {
        self.list(rest)?.map_err(|_| self.denied_listing(rest))
    }

    fn denied_listing(&self, rest: &str) -> anyhow::Error {
        anyhow!(
            "GitLab refused to list {} of {}: set GITLAB_TOKEN to a token with the read_api \
             scope",
            rest.split('?').next().unwrap_or(rest),
            self.repo.display()
        )
    }

    /// The first `want` issues (oldest created first) updated after `since`, reading pages
    /// only until they are found, and whether the listing had more.
    pub fn first_issues(&self, since: Option<&str>, want: usize) -> Result<(Vec<GlItem>, bool)> {
        self.first(
            &with_since(
                "issues?state=all&order_by=created_at&sort=asc&per_page=100",
                since,
            ),
            want,
        )
    }

    /// [`Self::first_issues`] for merge requests.
    pub fn first_merge_requests(
        &self,
        since: Option<&str>,
        want: usize,
    ) -> Result<(Vec<GlItem>, bool)> {
        self.first(
            &with_since(
                "merge_requests?state=all&order_by=created_at&sort=asc&per_page=100",
                since,
            ),
            want,
        )
    }

    fn first(&self, rest: &str, want: usize) -> Result<(Vec<GlItem>, bool)> {
        let mut url = self.url(rest);
        let mut out: Vec<GlItem> = Vec::new();
        loop {
            let Ok(r) = self.get(&url)? else {
                return Err(self.denied_listing(rest));
            };
            let page: Vec<GlItem> = serde_json::from_slice(&r.body)
                .with_context(|| format!("parsing the listing {rest}"))?;
            out.extend(page);
            if out.len() > want {
                out.truncate(want);
                return Ok((out, true));
            }
            match r.next {
                Some(next) if next.starts_with(&format!("{}/", self.repo.base)) => {
                    if out.len() == want {
                        return Ok((out, true));
                    }
                    url = next;
                }
                _ => return Ok((out, false)),
            }
        }
    }

    /// The iids of the merge requests whose head GitLab still has
    /// (`refs/merge-requests/<iid>/head`): GitLab deletes it 14 days after a merge request
    /// closes or merges
    /// (<https://docs.gitlab.com/user/project/merge_requests/merge_request_troubleshooting/>).
    pub fn merge_request_heads(&self) -> Result<BTreeSet<u64>> {
        let refs = self
            .api
            .ls_remote(&self.clone_url(), "refs/merge-requests/*/head")?;
        Ok(refs
            .lines()
            .filter_map(|l| {
                l.split('\t')
                    .nth(1)?
                    .strip_prefix("refs/merge-requests/")?
                    .strip_suffix("/head")?
                    .parse()
                    .ok()
            })
            .collect())
    }

    fn clone_url(&self) -> String {
        format!("{}.git", self.repo.web_url())
    }

    /// Mirror-clone (or update) the project into the bare repo at `dir`: branches, tags and
    /// merge request heads only. GitLab also advertises `refs/pipelines/*`,
    /// `refs/environments/*` and `refs/keep-around/*`, which are not the project's history,
    /// so there is no `clone --mirror`: explicit refspecs fetch just these three namespaces,
    /// and `--prune` drops what GitLab deleted (a merged branch, an expired MR head).
    pub fn sync_mirror(&self, dir: &Path) -> Result<()> {
        let url = self.clone_url();
        if !dir.join("HEAD").exists() {
            std::fs::create_dir_all(dir)?;
            run(git_cmd(
                &["-C", path_str(dir)?, "init", "--bare", "--quiet"],
                None,
            ))?;
        }
        run(git_cmd(
            &[
                "-C",
                path_str(dir)?,
                "fetch",
                "--prune",
                "--quiet",
                "--no-tags",
                "--",
                &url,
                "+refs/heads/*:refs/heads/*",
                "+refs/tags/*:refs/tags/*",
                "+refs/merge-requests/*/head:refs/merge-requests/*/head",
            ],
            git_auth(&self.repo.base, gitlab_token().as_deref()),
        ))
        .with_context(|| {
            format!(
                "fetching {url} (a private project? set GITLAB_TOKEN to a token with \
                 read_repository)"
            )
        })
    }
}

fn with_since(path: &str, since: Option<&str>) -> String {
    match since {
        Some(s) => format!("{path}&updated_after={s}"),
        None => path.to_string(),
    }
}

fn path_str(p: &Path) -> Result<&str> {
    p.to_str()
        .ok_or_else(|| anyhow!("{} is not UTF-8", p.display()))
}

/// `git <args>`, with one extra config entry appended after any `GIT_CONFIG_*` the caller
/// set (the Mirror Action and the CI template scope their settings that way).
fn git_cmd(args: &[&str], config: Option<(String, String)>) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args).env("GIT_TERMINAL_PROMPT", "0");
    if let Some((k, v)) = config {
        let n: usize = std::env::var("GIT_CONFIG_COUNT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        cmd.env("GIT_CONFIG_COUNT", (n + 1).to_string())
            .env(format!("GIT_CONFIG_KEY_{n}"), k)
            .env(format!("GIT_CONFIG_VALUE_{n}"), v);
    }
    cmd
}

fn run(mut cmd: Command) -> Result<()> {
    if !cmd.status().context("running git")?.success() {
        bail!("git failed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gitlab_project_forms_and_refuses_junk() {
        for form in [
            "gitlab.com/group/project",
            "https://gitlab.com/group/project",
            "https://gitlab.com/group/project.git",
            "https://gitlab.com/group/project/-/issues/3",
        ] {
            let r = GitlabRepoRef::parse(form, None).unwrap();
            assert_eq!(
                (r.base.as_str(), r.path.as_str()),
                (GITLAB_COM, "group/project")
            );
        }
        let deep = GitlabRepoRef::parse("gitlab.com/a/b/c/proj", None).unwrap();
        assert_eq!(deep.path, "a/b/c/proj");
        assert_eq!(deep.name(), "proj");
        assert_eq!(deep.api_project(), "projects/a%2Fb%2Fc%2Fproj");
        let own = GitlabRepoRef::parse("team/app", Some("https://git.example.org/")).unwrap();
        assert_eq!(own.base, "https://git.example.org");
        assert_eq!(own.display(), "git.example.org/team/app");
        assert_eq!(
            GitlabRepoRef::parse("git.example.org/team/app", Some("https://git.example.org"))
                .unwrap()
                .path,
            "team/app"
        );
        for bad in [
            "group/project",
            "gitlab.com/solo",
            "gitlab.com/a/../b",
            "gitlab.com/a/b c",
        ] {
            assert!(GitlabRepoRef::parse(bad, None).is_err(), "{bad}");
        }
        assert!(GitlabRepoRef::parse("https://gitlab.com/a/b", Some("https://other.org")).is_err());
        assert!(GitlabRepoRef::parse("a/b", Some("http://evil.example")).is_err());
        assert!(GitlabRepoRef::parse("a/b", Some("https://h/x")).is_err());
        assert!(GitlabRepoRef::parse("a/b", Some("http://127.0.0.1:8080")).is_ok());
    }

    #[test]
    fn responses_parse_status_next_link_and_retry_after() {
        let head = "HTTP/2 200 \r\nlink: <https://gitlab.com/api/v4/projects/1/issues?page=2&per_page=100>; rel=\"next\", <https://gitlab.com/api/v4/projects/1/issues?page=1>; rel=\"first\"\r\nx-total: 150\r\n\r\n";
        let r = parse_response(head, b"[]".to_vec());
        assert_eq!(r.status, 200);
        assert_eq!(
            r.next.as_deref(),
            Some("https://gitlab.com/api/v4/projects/1/issues?page=2&per_page=100")
        );
        let last = parse_response(
            "HTTP/2 200 \r\nlink: <https://x>; rel=\"first\"\r\n\r\n",
            vec![],
        );
        assert!(last.next.is_none());
        let limited = parse_response(
            "HTTP/1.1 100 Continue\r\n\r\nHTTP/2 429 \r\nretry-after: 7\r\n\r\n",
            vec![],
        );
        assert_eq!((limited.status, limited.retry_after), (429, Some(7)));
    }

    #[test]
    fn deleted_authors_are_the_ghost_and_states_map() {
        let n: GlNote = serde_json::from_str(r#"{"id":1,"author":null,"body":"x"}"#).unwrap();
        assert_eq!(n.author.login(), crate::github::GHOST);
        let m: GlItem = serde_json::from_str(
            r#"{"iid":6,"state":"merged","source_project_id":8,"target_project_id":4}"#,
        )
        .unwrap();
        assert!(m.is_closed() && m.is_merged() && m.is_fork());
        let gone: GlItem =
            serde_json::from_str(r#"{"iid":1,"source_project_id":null,"target_project_id":4}"#)
                .unwrap();
        assert!(gone.is_fork(), "a deleted fork is still a fork MR");
    }
}
