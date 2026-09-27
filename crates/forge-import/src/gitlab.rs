//! GitLab source layer: the REST API v4 over plain HTTPS (`curl`), for gitlab.com or a
//! self-hosted instance (`--gitlab-url`).
//!
//! **Auth.** `GITLAB_TOKEN` (a personal, project or group access token with the `read_api`
//! scope) is sent as `Authorization: Bearer` ("You can also use personal, project, or group
//! access tokens with OAuth-compliant headers", docs.gitlab.com/api/rest/authentication/),
//! through curl's stdin, never argv; curl follows no redirect, so the header never reaches
//! another host. The importer never takes the token on the command line. A
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
    /// Instance base, `https://host[:port][/relative-root]` (no trailing slash; the
    /// default port dropped): where `/api/v4` and the project's web path hang.
    pub base: String,
    /// Full project path.
    pub path: String,
}

/// How `--gitlab-url` may be spelled.
#[derive(Debug, Clone, Copy, Default)]
pub struct BaseOptions {
    /// `--allow-http`: accept an `http://` instance (a local or lab GitLab). Everything,
    /// the token included, then travels in the clear.
    pub allow_http: bool,
}

impl GitlabRepoRef {
    /// Parse `gitlab.com/group/project`, `https://gitlab.com/group/sub/project[.git]`, or,
    /// with `base` (from `--gitlab-url`), a bare `group/project` or a URL under that base.
    /// Only GitLab path characters are accepted, so the value is safe in an API path and a
    /// clone URL.
    pub fn parse(s: &str, base: Option<&str>, opts: BaseOptions) -> Result<Self> {
        let base = base
            .map(|b| normalize_base(b, opts).with_context(|| format!("invalid --gitlab-url {b:?}")))
            .transpose()?;
        let s = s.trim().trim_end_matches('/');
        let s = s.strip_suffix(".git").unwrap_or(s);
        let (origin, path) = if let Some(b) = &base {
            // Under the given base: its full URL, its URL without the scheme, or a bare path.
            let unschemed = b.split_once("://").map_or(b.as_str(), |(_, rest)| rest);
            let path = s
                .strip_prefix(&format!("{b}/"))
                .or_else(|| s.strip_prefix(&format!("{unschemed}/")))
                .unwrap_or(s);
            if path.contains("://") {
                bail!("{s:?} is not under --gitlab-url {b}");
            }
            (b.clone(), path.to_string())
        } else if let Some(rest) = s.strip_prefix("https://") {
            let (host, path) = rest
                .split_once('/')
                .ok_or_else(|| anyhow!("invalid GitLab project {s:?}: no project path"))?;
            (
                normalize_base(&format!("https://{host}"), opts)?,
                path.to_string(),
            )
        } else if let Some(path) = s.strip_prefix("gitlab.com/") {
            (GITLAB_COM.to_string(), path.to_string())
        } else {
            bail!(
                "invalid GitLab project {s:?}: use gitlab.com/<group>/<project>, its https URL, \
                 or --gitlab-url <https://host> with <group>/<project>"
            );
        };
        let path = path.split("/-/").next().unwrap_or_default().to_string();
        let segments: Vec<&str> = path.split('/').collect();
        if segments.len() < 2 || !segments.iter().all(|p| path_segment_ok(p)) {
            bail!("invalid GitLab project {s:?}: expected <group>/<project>");
        }
        Ok(Self { base: origin, path })
    }

    /// `host/group/project`, how the source is named in headers and summaries.
    pub fn display(&self) -> String {
        let bare = self
            .base
            .split_once("://")
            .map_or(self.base.as_str(), |(_, rest)| rest);
        format!("{bare}/{}", self.path)
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

/// Whether `p` is a GitLab namespace or project path segment.
fn path_segment_ok(p: &str) -> bool {
    !p.is_empty()
        && !p.starts_with('.')
        && !p.starts_with('-')
        && p.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// `scheme://host[:port][/relative-root]` from a `--gitlab-url` value: `https`, or `http`
/// with `--allow-http`; a default port (443, 80) dropped; a relative URL root (GitLab
/// installed under `/gitlab`) kept.
fn normalize_base(b: &str, opts: BaseOptions) -> Result<String> {
    let b = b.trim().trim_end_matches('/');
    let (scheme, rest, default_port) = if let Some(rest) = b.strip_prefix("https://") {
        ("https", rest, ":443")
    } else if let Some(rest) = b.strip_prefix("http://") {
        if !opts.allow_http {
            bail!(
                "{b} is http://: the token and everything read would travel unencrypted; use \
                 https://, or pass --allow-http for a local or lab instance"
            );
        }
        ("http", rest, ":80")
    } else {
        bail!("expected https://<host>");
    };
    let (host, root) = rest.split_once('/').unwrap_or((rest, ""));
    let host = host.strip_suffix(default_port).unwrap_or(host);
    let host_ok = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
        && !host.starts_with(['.', '-', ':']);
    if !host_ok {
        bail!("expected https://<host>[:port][/path]");
    }
    if !root.is_empty() && !root.split('/').all(path_segment_ok) {
        bail!("invalid relative URL root {root:?}");
    }
    Ok(if root.is_empty() {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}/{root}")
    })
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
    /// `disabled`, `private` (only project members) or `enabled` (everyone with access);
    /// absent from anonymous reads (docs.gitlab.com/api/projects/).
    #[serde(default)]
    pub issues_access_level: Option<String>,
    /// The same for merge requests.
    #[serde(default)]
    pub merge_requests_access_level: Option<String>,
}

impl GlProject {
    /// Which of issues and merge requests GitLab shows only to project members
    /// (`private`, "Only project members").
    pub fn members_only(&self) -> Vec<&'static str> {
        let private = |l: &Option<String>| l.as_deref() == Some("private");
        let mut out = Vec::new();
        if private(&self.issues_access_level) {
            out.push("issues");
        }
        if private(&self.merge_requests_access_level) {
            out.push("merge requests");
        }
        out
    }
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
    /// Closed, or merged. `locked` is open: GitLab uses it for a merge request being
    /// merged ("short-lived and transitional", docs.gitlab.com/api/merge_requests/), and
    /// for an open issue whose discussion is locked.
    pub fn is_closed(&self) -> bool {
        matches!(self.state.as_str(), "closed" | "merged")
    }

    /// Merged.
    pub fn is_merged(&self) -> bool {
        self.state == "merged"
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
    /// The same, as older GitLab versions name it ("Deprecated: Renamed to `internal`",
    /// docs.gitlab.com/api/notes/): an instance that sends only this must not leak it.
    #[serde(default)]
    pub confidential: bool,
    /// Line anchor of a diff note.
    #[serde(default)]
    pub position: Option<GlPosition>,
}

impl GlNote {
    /// A person's public comment: not activity, not members-only.
    pub fn is_public_comment(&self) -> bool {
        !self.system && !self.internal && !self.confidential
    }
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
    /// `Location`, on a 3xx.
    pub location: Option<String>,
}

impl GlResponse {
    /// A 200 with `body` (tests).
    pub fn ok(body: impl Into<Vec<u8>>, next: Option<String>) -> Self {
        Self::status(200, body, next)
    }

    /// Any status with `body` (tests).
    pub fn status(status: u16, body: impl Into<Vec<u8>>, next: Option<String>) -> Self {
        Self {
            status,
            body: body.into(),
            next,
            retry_after: None,
            location: None,
        }
    }
}

/// A request that got no HTTP answer: DNS, connect, timeout or a dropped connection
/// (curl exits 6, 7, 16, 28, 52, 55, 56, 92), worth another try.
#[derive(Debug)]
pub struct Transient(pub String);

impl std::fmt::Display for Transient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Transient {}

/// How the client reaches GitLab: HTTPS and git in production, recorded responses in tests.
pub trait GlApi {
    /// GET `url` (absolute). A [`Transient`] error is retried.
    fn get(&self, url: &str) -> Result<GlResponse>;
    /// `git ls-remote <url> <pattern>` output (`<oid>\t<ref>` lines).
    fn ls_remote(&self, url: &str, pattern: &str) -> Result<String>;
}

/// The API over `curl` (already a dependency of every git install that speaks https). The
/// token goes in a header read from stdin (`-H @-`), never on the command line; no redirect
/// is followed, so it never reaches another URL.
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

/// The git config entry that sends `token` to URLs under `base` as HTTP basic auth: an
/// access token is the password, with any non-empty user name
/// (<https://docs.gitlab.com/user/profile/personal_access_tokens/>). Passed through
/// `GIT_CONFIG_*`, so it is never in a URL, argv or a config file; `http.<url>.*` matches
/// only URLs under that prefix, so neither a redirect elsewhere nor another application on
/// the same host (beside a GitLab under a relative root) receives it.
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
        let mut cmd = Command::new("curl");
        // `-q` first: ignore any ~/.curlrc (it could add options, a proxy, a netrc). No
        // redirects: a moved project answers 3xx and is reported, never followed.
        cmd.args([
            "-q",
            "-sS",
            "--proto",
            "=https,http",
            "--max-redirs",
            "0",
            "--max-time",
            "120",
            "-D",
            "-",
            "-H",
            "Accept: application/json",
            "-H",
            "@-",
            "--",
            url,
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().context("running curl (is it installed?)")?;
        {
            let mut stdin = child.stdin.take().expect("piped");
            if let Some(t) = &self.token {
                writeln!(stdin, "Authorization: Bearer {t}")?;
            }
        }
        let out = child.wait_with_output().context("running curl")?;
        if !out.status.success() {
            let why = format!("GET {url}: {}", String::from_utf8_lossy(&out.stderr).trim());
            // No answer came: 6 no DNS, 7 no connection, 16 HTTP/2 framing, 28 timeout,
            // 52 empty reply, 55 send failed, 56 connection dropped, 92 HTTP/2 stream reset.
            return Err(match out.status.code() {
                Some(6 | 7 | 16 | 28 | 52 | 55 | 56 | 92) => Transient(why).into(),
                _ => anyhow!(why),
            });
        }
        Ok(split_response(&out.stdout))
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

/// `curl -D -` output (header blocks, a blank line, then the body) as a [`GlResponse`].
pub fn split_response(raw: &[u8]) -> GlResponse {
    // Header blocks end at CRLF CRLF; a `100 Continue` block may precede the real one.
    let mut at = 0;
    loop {
        let Some(end) = find(&raw[at..], b"\r\n\r\n") else {
            return parse_response(&String::from_utf8_lossy(&raw[at..]), Vec::new());
        };
        let block_end = at + end + 4;
        let next_is_headers = raw[block_end..].starts_with(b"HTTP/");
        if !next_is_headers {
            let head = String::from_utf8_lossy(&raw[..block_end]).into_owned();
            return parse_response(&head, raw[block_end..].to_vec());
        }
        at = block_end;
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// One response header's value.
fn header_value<'a>(block: &'a str, name: &str) -> Option<&'a str> {
    block.lines().skip(1).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

/// Status, next link and `Retry-After` from a header dump (the last block, after any
/// `100 Continue`).
pub fn parse_response(head: &str, body: Vec<u8>) -> GlResponse {
    let block = head
        .split("\r\n\r\n")
        .filter(|b| b.starts_with("HTTP/"))
        .last()
        .unwrap_or(head);
    let status = block
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    GlResponse {
        status,
        body,
        next: header_value(block, "link").and_then(next_link),
        retry_after: header_value(block, "retry-after").and_then(|v| v.parse().ok()),
        location: header_value(block, "location").map(str::to_string),
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

/// Why a read returned nothing, or less than all of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Denied {
    /// `401`: no token, or one too weak (without `read_api`).
    Unauthorized,
    /// `403`: the feature is disabled, or shown only to project members.
    Forbidden,
    /// The listing's next page was outside this instance's API; it was not followed (the token must
    /// never go there), so the listing stopped short.
    OffOrigin(String),
}

impl Denied {
    /// Why `what` of `repo` could not be read, and what the next run needs.
    pub fn explain(&self, what: &str, repo: &GitlabRepoRef) -> String {
        let repo = repo.display();
        match self {
            Denied::Unauthorized => format!(
                "GitLab refused {what} of {repo} (401: no GITLAB_TOKEN, or one without the \
                 read_api scope); not mirrored this run, and the run is partial"
            ),
            Denied::Forbidden => format!(
                "GitLab refused {what} of {repo} (403: the feature is disabled, or visible only \
                 to project members); not mirrored this run, and the run is partial"
            ),
            Denied::OffOrigin(url) => format!(
                "GitLab's next page of {what} of {repo} is outside its API ({url}); it was not \
                 followed, so the listing is incomplete and the run is partial"
            ),
        }
    }
}

/// A read that may be refused.
pub type Readable<T> = std::result::Result<T, Denied>;

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
        let api = Box::new(Curl::from_env(&repo.base));
        Self {
            pace: true,
            ..Self::with_api(repo, api)
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

    /// One GET, retrying a 429 after `Retry-After`, a 5xx, and a request that got no answer
    /// at all, a few times. `Ok(Err)` when GitLab refuses it (401, 403). `what` names the
    /// resource for the error messages.
    fn get(&self, url: &str, what: &str) -> Result<Readable<GlResponse>> {
        const ATTEMPTS: u32 = 5;
        for attempt in 1..=ATTEMPTS {
            self.throttle();
            let r = match self.api.get(url) {
                Ok(r) => r,
                Err(e) if e.is::<Transient>() && attempt < ATTEMPTS => {
                    tracing::warn!(error = %e, "GitLab unreachable; retrying");
                    self.pause(5 * u64::from(attempt));
                    continue;
                }
                Err(e) => return Err(e),
            };
            match r.status {
                200..=299 => return Ok(Ok(r)),
                401 => return Ok(Err(Denied::Unauthorized)),
                403 => return Ok(Err(Denied::Forbidden)),
                429 | 500..=599 if attempt < ATTEMPTS => {
                    // 429: "Retry-After tells you how many seconds remain until your quota
                    // resets" (docs.gitlab.com/user/gitlab_com/rate_limits/). Capped at 15 min.
                    let wait = r
                        .retry_after
                        .unwrap_or(10 * u64::from(attempt))
                        .clamp(1, 900);
                    tracing::warn!(status = r.status, wait_secs = wait, "GitLab API; retrying");
                    self.pause(wait);
                }
                300..=399 => bail!(
                    "GitLab redirected {what} of {} to {} (HTTP {}): the project was probably \
                     renamed or moved; import it under its new path. Redirects are not followed, \
                     so the token never goes elsewhere",
                    self.repo.display(),
                    r.location.as_deref().unwrap_or("an unnamed location"),
                    r.status
                ),
                404 => bail!(
                    "GitLab answered 404 for {what} of {}: {}",
                    self.repo.display(),
                    if what == "the project" {
                        "it does not exist, or it is private and GITLAB_TOKEN is unset or cannot \
                         read it"
                    } else {
                        "the project exists, but this endpoint does not (an older GitLab?)"
                    }
                ),
                s => bail!(
                    "GitLab answered HTTP {s} for {what} of {}: {}",
                    self.repo.display(),
                    String::from_utf8_lossy(&r.body)
                        .chars()
                        .take(300)
                        .collect::<String>()
                ),
            }
        }
        bail!(
            "GitLab kept refusing {what} of {} (rate limited or unavailable); re-run later",
            self.repo.display()
        )
    }

    fn pause(&self, secs: u64) {
        if self.pace {
            std::thread::sleep(Duration::from_secs(secs));
        }
    }

    /// A paginated listing, following `Link: rel="next"` under this `base/api/v4/` only. With `want`,
    /// pages are read only until `want` elements are found, at most `want` are kept, and the
    /// flag says whether the listing had more. A next page anywhere else is not followed
    /// (the token must never go there): the elements read so far are dropped and the listing
    /// is `Denied::OffOrigin`, so the run is partial rather than silently short.
    fn pages<T: for<'de> Deserialize<'de>>(
        &self,
        rest: &str,
        want: Option<usize>,
        what: &str,
    ) -> Result<Readable<(Vec<T>, bool)>> {
        let mut url = self.url(rest);
        let mut out = Vec::new();
        // Only pages of this instance's API (under a relative root, only that root's).
        let api_root = format!("{}/api/v4/", self.repo.base);
        loop {
            let r = match self.get(&url, what)? {
                Ok(r) => r,
                Err(d) => return Ok(Err(d)),
            };
            let page: Vec<T> = serde_json::from_slice(&r.body)
                .with_context(|| format!("parsing {what} of {}", self.repo.display()))?;
            out.extend(page);
            if let Some(want) = want.filter(|&w| out.len() > w) {
                out.truncate(want);
                return Ok(Ok((out, true)));
            }
            match r.next {
                None => return Ok(Ok((out, false))),
                Some(_) if want == Some(out.len()) => return Ok(Ok((out, true))),
                Some(next) if next.starts_with(&api_root) => url = next,
                Some(next) => return Ok(Err(Denied::OffOrigin(next))),
            }
        }
    }

    /// Every element of a listing (or, with `limit` > 0, at most `limit` and whether there
    /// were more), or why it could not be read.
    fn list<T: for<'de> Deserialize<'de>>(
        &self,
        rest: &str,
        limit: usize,
        what: &str,
    ) -> Result<Readable<(Vec<T>, bool)>> {
        self.pages(rest, (limit > 0).then_some(limit), what)
    }

    /// Project metadata (also proves the project exists and can be read). The only read
    /// whose refusal fails the run.
    pub fn project(&self) -> Result<GlProject> {
        match self.get(&self.url(""), "the project")? {
            Ok(r) => serde_json::from_slice(&r.body).context("parsing the project"),
            Err(d) => bail!("{}", d.explain("the project", &self.repo)),
        }
    }

    /// Issues (all states), updated after `since`, oldest created first. With `limit` (> 0),
    /// only the pages holding the first `limit` are read, and the flag says whether the
    /// listing had more.
    pub fn issues(
        &self,
        since: Option<&str>,
        limit: usize,
    ) -> Result<Readable<(Vec<GlItem>, bool)>> {
        self.list(
            &with_since(
                "issues?state=all&order_by=created_at&sort=asc&per_page=100",
                since,
            ),
            limit,
            "the issues",
        )
    }

    /// [`Self::issues`] for merge requests.
    pub fn merge_requests(
        &self,
        since: Option<&str>,
        limit: usize,
    ) -> Result<Readable<(Vec<GlItem>, bool)>> {
        self.list(
            &with_since(
                "merge_requests?state=all&order_by=created_at&sort=asc&per_page=100",
                since,
            ),
            limit,
            "the merge requests",
        )
    }

    /// The iids of open merge requests, oldest first; with `limit` (> 0), only the first
    /// `limit`.
    pub fn open_merge_requests(&self, limit: usize) -> Result<Readable<Vec<u64>>> {
        Ok(self
            .list::<GlItem>(
                "merge_requests?state=opened&order_by=created_at&sort=asc&per_page=100",
                limit,
                "the open merge requests",
            )?
            .map(|(open, _)| open.into_iter().map(|m| m.iid).collect()))
    }

    /// An issue's notes, oldest first.
    pub fn issue_notes(&self, iid: u64) -> Result<Readable<Vec<GlNote>>> {
        Ok(self
            .list(
                &format!("issues/{iid}/notes?sort=asc&order_by=created_at&per_page=100"),
                0,
                "the comments",
            )?
            .map(|(n, _)| n))
    }

    /// A merge request's discussions (threads, diff notes with their positions).
    pub fn mr_discussions(&self, iid: u64) -> Result<Readable<Vec<GlDiscussion>>> {
        Ok(self
            .list(
                &format!("merge_requests/{iid}/discussions?per_page=100"),
                0,
                "the comments",
            )?
            .map(|(d, _)| d))
    }

    /// Label definitions.
    pub fn labels(&self) -> Result<Readable<Vec<GlLabel>>> {
        Ok(self
            .list("labels?per_page=100", 0, "the label definitions")?
            .map(|(l, _)| l))
    }

    /// Releases, newest released first (GitLab's order); with `limit` (> 0), only the
    /// newest `limit`, and whether there were more.
    pub fn releases(&self, limit: usize) -> Result<Readable<(Vec<GlRelease>, bool)>> {
        self.list("releases?per_page=100", limit, "the releases")
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
        crate::github::append_git_config(&mut cmd, &k, &v);
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

    fn parse(s: &str, base: Option<&str>) -> Result<GitlabRepoRef> {
        GitlabRepoRef::parse(s, base, BaseOptions::default())
    }

    #[test]
    fn parses_gitlab_project_forms_and_refuses_junk() {
        for form in [
            "gitlab.com/group/project",
            "https://gitlab.com/group/project",
            "https://gitlab.com/group/project.git",
            "https://gitlab.com/group/project/-/issues/3",
            "https://gitlab.com:443/group/project",
        ] {
            let r = parse(form, None).unwrap();
            assert_eq!(
                (r.base.as_str(), r.path.as_str()),
                (GITLAB_COM, "group/project"),
                "{form}"
            );
        }
        let deep = parse("gitlab.com/a/b/c/proj", None).unwrap();
        assert_eq!(deep.path, "a/b/c/proj");
        assert_eq!(deep.name(), "proj");
        assert_eq!(deep.api_project(), "projects/a%2Fb%2Fc%2Fproj");
        let own = parse("team/app", Some("https://git.example.org:443/")).unwrap();
        assert_eq!(own.base, "https://git.example.org");
        assert_eq!(own.display(), "git.example.org/team/app");
        assert_eq!(
            parse("git.example.org/team/app", Some("https://git.example.org"))
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
            assert!(parse(bad, None).is_err(), "{bad}");
        }
        assert!(parse("https://gitlab.com/a/b", Some("https://other.org")).is_err());
    }

    /// M3: a relative URL root is kept; http:// needs --allow-http (loopback included).
    #[test]
    fn gitlab_url_takes_a_relative_root_and_http_only_when_allowed() {
        let rooted = parse("team/app", Some("https://example.org/gitlab")).unwrap();
        assert_eq!(rooted.base, "https://example.org/gitlab");
        assert_eq!(rooted.web_url(), "https://example.org/gitlab/team/app");
        assert_eq!(rooted.display(), "example.org/gitlab/team/app");
        assert_eq!(
            parse(
                "https://example.org/gitlab/team/app",
                Some("https://example.org/gitlab")
            )
            .unwrap()
            .path,
            "team/app"
        );
        for http in [
            "http://127.0.0.1:8080",
            "http://localhost",
            "http://lab.example",
        ] {
            assert!(parse("a/b", Some(http)).is_err(), "{http}");
            let allowed =
                GitlabRepoRef::parse("a/b", Some(http), BaseOptions { allow_http: true }).unwrap();
            assert!(allowed.base.starts_with("http://"));
        }
        // No `localhost` prefix games, even with --allow-http: the host is matched exactly.
        let lookalike = GitlabRepoRef::parse(
            "a/b",
            Some("http://localhost.evil.example:80"),
            BaseOptions { allow_http: true },
        )
        .unwrap();
        assert_eq!(lookalike.base, "http://localhost.evil.example");
        assert!(parse("a/b", Some("ftp://h")).is_err());
        assert!(parse("a/b", Some("https://h/../x")).is_err());
    }

    #[test]
    fn a_full_curl_dump_splits_into_headers_and_body() {
        let raw = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/2 200 \r\nlink: <https://gitlab.com/api/v4/x?page=2>; rel=\"next\"\r\n\r\n[{\"a\":1}]";
        let r = split_response(raw);
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"[{\"a\":1}]");
        assert_eq!(
            r.next.as_deref(),
            Some("https://gitlab.com/api/v4/x?page=2")
        );
        let moved = split_response(b"HTTP/2 301 \r\nlocation: https://gitlab.com/new/path\r\n\r\n");
        assert_eq!(
            (moved.status, moved.location.as_deref()),
            (301, Some("https://gitlab.com/new/path"))
        );
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
        assert!(n.is_public_comment());
        let m: GlItem = serde_json::from_str(r#"{"iid":6,"state":"merged"}"#).unwrap();
        assert!(m.is_closed() && m.is_merged());
        let locked: GlItem = serde_json::from_str(r#"{"iid":7,"state":"locked"}"#).unwrap();
        assert!(!locked.is_closed(), "locked is a transitional open state");
    }

    /// H2: an older GitLab marks members-only notes `confidential`, not `internal`.
    #[test]
    fn members_only_notes_are_never_public() {
        for doc in [
            r#"{"id":1,"internal":true}"#,
            r#"{"id":1,"confidential":true}"#,
            r#"{"id":1,"system":true}"#,
        ] {
            let n: GlNote = serde_json::from_str(doc).unwrap();
            assert!(!n.is_public_comment(), "{doc}");
        }
    }

    #[test]
    fn members_only_features_are_named() {
        let p: GlProject = serde_json::from_str(
            r#"{"issues_access_level":"private","merge_requests_access_level":"enabled"}"#,
        )
        .unwrap();
        assert_eq!(p.members_only(), ["issues"]);
        let anon: GlProject = serde_json::from_str(r#"{"issues_access_level":null}"#).unwrap();
        assert!(anon.members_only().is_empty());
    }
}
