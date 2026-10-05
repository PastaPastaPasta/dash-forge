//! The HTTP surface.
//!
//! | Route | What |
//! |---|---|
//! | `GET /<owner>/<name>.git/info/refs?service=git-upload-pack` | ref advertisement (smart HTTP) |
//! | `POST /<owner>/<name>.git/git-upload-pack` | clone / fetch |
//! | `GET /<owner>/<name>.git/forge-manifest.json` | what is served, as of which Platform block |
//! | `GET /<owner>/<name>` | redirect to the web app |
//! | `GET /badge/<owner>/<name>/<stars\|ci\|release\|issues>.<svg\|json>` | README badges |
//! | `GET /feed/<owner>/<name>/<releases\|commits\|issues>.atom` | Atom feeds |
//! | `GET /og/<owner>/<name>[.png]` | link preview page / image |
//! | `GET /healthz`, `/readyz`, `/metrics` | liveness, readiness, Prometheus |
//!
//! `<owner>` is an identity id or a DPNS name, so `badge`, `feed`, `og`, `healthz`, `readyz`
//! and `metrics` cannot be served as owners (DPNS names that equal them are reachable by id).

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{ConnectInfo, FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Semaphore;

use crate::badge::{self, Badge, Kind};
use crate::cache::{Lookup, RenderCache, Rendered};
use crate::config::{Config, TrustProxy};
use crate::feed::{self, Entry, Feed};
use crate::git_http::{self, BackendRequest};
use crate::limits::{ClientConcurrency, RateLimiter};
use crate::metrics::{Gauges, Metrics};
use crate::mirror::{Mirrors, Slot, Unavailable};
use crate::og;
use crate::upstream::RepoInfo;

/// The largest `git-upload-pack` request body (wants and haves; git gzips it).
pub const MAX_UPLOAD_PACK_REQUEST: usize = 16 * 1024 * 1024;

/// How long a client may take to send a `git-upload-pack` request body.
pub const UPLOAD_PACK_BODY_TIMEOUT: Duration = Duration::from_secs(30);

/// How long any request may take to produce its response's head, beyond the cold-mirror wait
/// (`--cold-wait-secs`): a backstop for a Platform read, a body or a backend that never ends.
/// A response that has started streaming is bounded by its own deadline instead.
const REQUEST_TIMEOUT_BEYOND_COLD_WAIT: Duration = Duration::from_secs(120);

/// How long a resolved `owner/name` is trusted, and an absent one.
const RESOLVE_TTL: Duration = Duration::from_secs(300);
const RESOLVE_MISS_TTL: Duration = Duration::from_secs(60);

/// The most `owner/name` resolutions kept.
const MAX_RESOLVED: usize = 50_000;

/// Entries in the feed.
const FEED_ENTRIES: usize = 30;

/// A resolution and when it was made (`None`: no such repository).
type Resolved = (Instant, Option<RepoInfo>);

/// A repository's branch and tag tips (`refs/heads/main` → oid) and its default branch, as the
/// mirror's manifest or a proved snapshot names them.
#[derive(Debug)]
struct RepoTips {
    default_branch: Option<String>,
    tips: std::collections::BTreeMap<String, String>,
}

/// The most repositories whose snapshot tips are kept ([`AppState::tips`]).
const MAX_TIPS: usize = 10_000;

/// Shared state.
pub struct AppState {
    /// Settings.
    pub cfg: Arc<Config>,
    /// The mirrors.
    pub mirrors: Arc<Mirrors>,
    /// Counters.
    pub metrics: Arc<Metrics>,
    rate: RateLimiter,
    clone_rate: RateLimiter,
    new_mirror_rate: RateLimiter,
    clone_per_client: ClientConcurrency,
    clones: Arc<Semaphore>,
    renders: RenderCache,
    resolved: Mutex<HashMap<(String, String), Resolved>>,
    /// Snapshot tips of repositories without a mirror, by repo id, for the render TTL: a badge
    /// for any `?branch=` costs at most one snapshot read per repository per TTL.
    tips: Mutex<HashMap<String, (Instant, Arc<RepoTips>)>>,
    fonts: Arc<resvg::usvg::fontdb::Database>,
    allowed: Mutex<HashSet<String>>,
}

impl AppState {
    /// State over `mirrors`.
    pub fn new(cfg: Arc<Config>, mirrors: Arc<Mirrors>, metrics: Arc<Metrics>) -> Self {
        let minute = Duration::from_secs(60);
        Self {
            rate: RateLimiter::new(cfg.rate_per_min, minute),
            clone_rate: RateLimiter::new(cfg.clones_per_min, minute),
            new_mirror_rate: RateLimiter::new(cfg.new_mirrors_per_hour, Duration::from_secs(3600)),
            clone_per_client: ClientConcurrency::new(cfg.clones_per_client),
            clones: Arc::new(Semaphore::new(cfg.clones_max.max(1))),
            renders: RenderCache::new(Duration::from_secs(cfg.render_ttl_secs), 10_000),
            resolved: Mutex::default(),
            tips: Mutex::default(),
            fonts: og::fonts(cfg.font_dir.as_deref()),
            allowed: Mutex::default(),
            cfg,
            mirrors,
            metrics,
        }
    }

    /// Serve `repo` even without `--all-public` (it is in `--repos`).
    pub fn allow(&self, repo: &RepoInfo) {
        self.allowed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(repo.repo_id.clone());
    }

    fn gauges(&self) -> Gauges {
        let (mirrors, mirrors_ready, cache_bytes) = self.mirrors.stats();
        Gauges {
            mirrors,
            mirrors_ready,
            cache_bytes,
            cache_max_bytes: self.cfg.cache_max_bytes,
            upload_packs_active: self.clone_per_client.active() as u64,
        }
    }
}

type St = State<Arc<AppState>>;

/// The router.
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/healthz", get(|| async { "ok\n" }))
        .route("/readyz", get(readyz))
        .route("/metrics", get(metrics))
        .route("/badge/{owner}/{name}/{file}", get(badge_route))
        .route("/feed/{owner}/{name}/{file}", get(feed_route))
        .route("/og/{owner}/{file}", get(og_route))
        .route("/{owner}/{repo}/info/refs", get(info_refs))
        .route("/{owner}/{repo}/git-upload-pack", post(upload_pack))
        .route("/{owner}/{repo}/git-receive-pack", post(read_only))
        .route("/{owner}/{repo}/forge-manifest.json", get(manifest_route))
        .route("/{owner}/{repo}", get(repo_page))
        .fallback(|| async { text(StatusCode::NOT_FOUND, "not found\n") })
        .layer(middleware::from_fn_with_state(Arc::clone(&state), guard))
        .with_state(state)
}

/// The client address limits are keyed by (never logged).
#[derive(Debug, Clone, Copy)]
pub struct ClientIp(pub IpAddr);

impl FromRequestParts<Arc<AppState>> for ClientIp {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(Ok(Self(client_ip(
            &parts.headers,
            parts.extensions.get(),
            state.cfg.trust_proxy,
        ))))
    }
}

fn client_ip(
    headers: &HeaderMap,
    conn: Option<&ConnectInfo<SocketAddr>>,
    trust: TrustProxy,
) -> IpAddr {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let from_proxy = match trust {
        TrustProxy::None => None,
        TrustProxy::Cloudflare => header("cf-connecting-ip").and_then(|v| v.trim().parse().ok()),
        TrustProxy::XForwardedFor => header("x-forwarded-for")
            .and_then(|v| v.rsplit(',').next())
            .and_then(|v| v.trim().parse().ok()),
    };
    from_proxy
        .or_else(|| conn.map(|c| c.0.ip()))
        .unwrap_or(IpAddr::from([0, 0, 0, 0]))
}

/// Every request: the per-client rate limit, security headers, and one log line (method,
/// path, status, time; never the client's address or user agent).
async fn guard(State(state): St, req: Request<Body>, next: Next) -> Response {
    let ip = client_ip(req.headers(), req.extensions().get(), state.cfg.trust_proxy);
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let probe = matches!(path.as_str(), "/healthz" | "/readyz" | "/metrics");
    if !probe {
        if let Err(wait) = state.rate.check(ip) {
            Metrics::inc(&state.metrics.rate_limited);
            return too_many(wait, "too many requests from your address; slow down\n");
        }
    }
    let started = Instant::now();
    let limit = Duration::from_secs(state.cfg.cold_wait_secs) + REQUEST_TIMEOUT_BEYOND_COLD_WAIT;
    let mut resp = match tokio::time::timeout(limit, next.run(req)).await {
        Ok(r) => r,
        Err(_) => text(
            StatusCode::SERVICE_UNAVAILABLE,
            "the request took too long; try again shortly\n",
        ),
    };
    let h = resp.headers_mut();
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    if !probe {
        tracing::info!(
            %method,
            path = %path,
            status = resp.status().as_u16(),
            ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "request"
        );
    }
    resp
}

fn text(status: StatusCode, body: impl Into<String>) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        body.into(),
    )
        .into_response()
}

fn too_many(wait: Duration, msg: &str) -> Response {
    let mut r = text(StatusCode::TOO_MANY_REQUESTS, msg);
    if let Ok(v) = HeaderValue::from_str(&wait.as_secs().max(1).to_string()) {
        r.headers_mut().insert(header::RETRY_AFTER, v);
    }
    r
}

fn cors(mut r: Response) -> Response {
    r.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    r
}

/// An owner or name as a URL segment: letters, digits, `.`, `_`, `-`.
fn segment_ok(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && !s.starts_with('.')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// `name` without its `.git`.
fn repo_name(repo: &str) -> &str {
    repo.strip_suffix(".git").unwrap_or(repo)
}

/// Record a resolution, keeping at most [`MAX_RESOLVED`] however many names are asked for:
/// when full, drop the expired entries and the misses, and if it is still full, start over.
fn remember(
    resolved: &mut HashMap<(String, String), Resolved>,
    key: (String, String),
    info: Option<RepoInfo>,
) {
    if resolved.len() >= MAX_RESOLVED {
        resolved.retain(|_, (at, i)| at.elapsed() < RESOLVE_TTL && i.is_some());
        if resolved.len() >= MAX_RESOLVED {
            resolved.clear();
        }
    }
    resolved.insert(key, (Instant::now(), info));
}

/// Resolve `owner/name` to a public repository this gateway serves, or the response that says
/// why not. A failed Platform read falls back to the last resolution (a mirror keeps serving
/// while Platform is down).
async fn resolve(state: &AppState, owner: &str, name: &str) -> Result<RepoInfo, Box<Response>> {
    let net = state.mirrors.upstream().network();
    let absent = || {
        text(
            StatusCode::NOT_FOUND,
            format!("no public repository {owner}/{name} on {net}\n"),
        )
    };
    if !segment_ok(owner, 64) || !segment_ok(name, 100) {
        return Err(Box::new(absent()));
    }
    let key = (owner.to_string(), name.to_string());
    let cached = state
        .resolved
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&key)
        .cloned();
    let info = match cached.clone() {
        Some((at, info))
            if at.elapsed()
                < if info.is_some() {
                    RESOLVE_TTL
                } else {
                    RESOLVE_MISS_TTL
                } =>
        {
            info
        }
        _ => match state.mirrors.upstream().resolve(owner, name).await {
            Ok(info) => {
                state.metrics.upstream(true);
                remember(
                    &mut state
                        .resolved
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner),
                    key,
                    info.clone(),
                );
                info
            }
            Err(e) => {
                state.metrics.upstream(false);
                tracing::warn!(error = %format!("{e:#}"), "resolve failed");
                match cached {
                    Some((_, info)) => info,
                    None => {
                        return Err(Box::new(text(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "Dash Platform cannot be read right now; try again shortly, or clone with dash:// (git-remote-dash reads Platform directly)\n",
                        )))
                    }
                }
            }
        },
    };
    let Some(info) = info else {
        return Err(Box::new(absent()));
    };
    if !info.public {
        // As absent: a gateway never serves (or confirms) a private repository.
        Metrics::inc(&state.metrics.private_refused);
        return Err(Box::new(absent()));
    }
    let listed = state
        .allowed
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .contains(&info.repo_id);
    if !state.cfg.all_public && !listed {
        return Err(Box::new(text(
            StatusCode::NOT_FOUND,
            format!("{owner}/{name} is not mirrored by this gateway (it serves only the repositories its operator lists)\n"),
        )));
    }
    Ok(info)
}

/// The mirror of `repo`, ready to serve, or the response that says why not. Starting a new
/// mirror counts against the client's hourly allowance.
async fn ready_mirror(
    state: &AppState,
    ip: IpAddr,
    repo: &RepoInfo,
) -> Result<Arc<Slot>, Box<Response>> {
    if !state.mirrors.known(&repo.repo_id) {
        if let Err(wait) = state.new_mirror_rate.check(ip) {
            Metrics::inc(&state.metrics.rate_limited);
            return Err(Box::new(too_many(
                wait,
                "too many new mirrors started from your address; try again later\n",
            )));
        }
    }
    let slot = state.mirrors.slot(repo);
    match state
        .mirrors
        .ready(&slot, Duration::from_secs(state.cfg.cold_wait_secs))
        .await
    {
        Ok(()) => Ok(slot),
        Err(u) => Err(Box::new(unavailable(&u))),
    }
}

fn unavailable(u: &Unavailable) -> Response {
    match u {
        Unavailable::Pending => {
            let mut r = text(
                StatusCode::SERVICE_UNAVAILABLE,
                "this repository is being mirrored from Dash Platform for the first time; try again in a minute (or clone with dash://)\n",
            );
            r.headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("30"));
            r
        }
        Unavailable::TooLarge { bytes, cap } => text(
            StatusCode::FORBIDDEN,
            format!(
                "this repository ({} MiB) is larger than this gateway mirrors ({} MiB); clone it with dash://\n",
                bytes >> 20,
                cap >> 20
            ),
        ),
        Unavailable::Failed(_) => text(
            StatusCode::SERVICE_UNAVAILABLE,
            "this repository cannot be mirrored right now (Dash Platform or its storage is unreachable); clone it with dash://\n",
        ),
    }
}

#[derive(Debug, Deserialize)]
struct ServiceQuery {
    service: Option<String>,
}

async fn info_refs(
    State(state): St,
    ClientIp(ip): ClientIp,
    Path((owner, repo)): Path<(String, String)>,
    Query(q): Query<ServiceQuery>,
    headers: HeaderMap,
) -> Response {
    Metrics::inc(&state.metrics.requests_git);
    match q.service.as_deref() {
        Some("git-upload-pack") => {}
        Some("git-receive-pack") => return read_only().await,
        _ => {
            return text(
                StatusCode::FORBIDDEN,
                "this gateway speaks git's smart HTTP protocol only (git 1.6.6 or newer)\n",
            )
        }
    }
    let info = match resolve(&state, &owner, repo_name(&repo)).await {
        Ok(i) => i,
        Err(r) => return *r,
    };
    let slot = match ready_mirror(&state, ip, &info).await {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let Some(guard) = state.mirrors.checkout(&slot) else {
        return unavailable(&Unavailable::Pending);
    };
    let req = BackendRequest {
        method: "GET".into(),
        path_info: format!("/{}.git/info/refs", info.repo_id),
        query: "service=git-upload-pack".into(),
        git_protocol: header_str(&headers, "git-protocol"),
        ..BackendRequest::default()
    };
    match git_http::serve(
        &state.mirrors,
        Arc::clone(&state.metrics),
        req,
        vec![Box::new(guard)],
        Duration::from_secs(60),
    )
    .await
    {
        Ok(r) => cors(r),
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "info/refs failed");
            text(
                StatusCode::INTERNAL_SERVER_ERROR,
                "the mirror could not be read\n",
            )
        }
    }
}

fn header_str(h: &HeaderMap, name: &str) -> Option<String> {
    h.get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

async fn upload_pack(
    State(state): St,
    ClientIp(ip): ClientIp,
    Path((owner, repo)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    Metrics::inc(&state.metrics.requests_git);
    let info = match resolve(&state, &owner, repo_name(&repo)).await {
        Ok(i) => i,
        Err(r) => return *r,
    };
    if let Err(wait) = state.clone_rate.check(ip) {
        Metrics::inc(&state.metrics.rate_limited);
        return too_many(wait, "too many clones from your address; slow down\n");
    }
    // The client's own slot bounds how many bodies it can have in flight; a client that
    // trickles its body holds only that, and the gateway's slots are taken once the body is in
    // and the mirror is ready.
    let Some(client_permit) = state.clone_per_client.acquire(ip) else {
        Metrics::inc(&state.metrics.rate_limited);
        return too_many(
            Duration::from_secs(10),
            "too many clones at once from your address\n",
        );
    };
    let body = match tokio::time::timeout(
        UPLOAD_PACK_BODY_TIMEOUT,
        axum::body::to_bytes(body, MAX_UPLOAD_PACK_REQUEST),
    )
    .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => return text(StatusCode::PAYLOAD_TOO_LARGE, "request too large\n"),
        Err(_) => {
            return text(
                StatusCode::REQUEST_TIMEOUT,
                "the request body took too long\n",
            )
        }
    };
    let slot = match ready_mirror(&state, ip, &info).await {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let Ok(global_permit) = Arc::clone(&state.clones).try_acquire_owned() else {
        Metrics::inc(&state.metrics.rate_limited);
        let mut r = text(
            StatusCode::SERVICE_UNAVAILABLE,
            "this gateway is busy; try again shortly (or clone with dash://)\n",
        );
        r.headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("10"));
        return r;
    };
    let Some(guard) = state.mirrors.checkout(&slot) else {
        return unavailable(&Unavailable::Pending);
    };
    Metrics::inc(&state.metrics.upload_packs);
    let req = BackendRequest {
        method: "POST".into(),
        path_info: format!("/{}.git/git-upload-pack", info.repo_id),
        query: String::new(),
        content_type: header_str(&headers, "content-type"),
        content_encoding: header_str(&headers, "content-encoding"),
        git_protocol: header_str(&headers, "git-protocol"),
        body,
    };
    match git_http::serve(
        &state.mirrors,
        Arc::clone(&state.metrics),
        req,
        vec![
            Box::new(guard),
            Box::new(client_permit),
            Box::new(global_permit),
        ],
        Duration::from_secs(state.cfg.serve_timeout_secs),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "upload-pack failed");
            text(
                StatusCode::INTERNAL_SERVER_ERROR,
                "the mirror could not be read\n",
            )
        }
    }
}

async fn read_only() -> Response {
    text(
        StatusCode::FORBIDDEN,
        "this gateway is a read-only mirror; push with dash:// (git-remote-dash signs your push to Dash Platform)\n",
    )
}

async fn manifest_route(
    State(state): St,
    ClientIp(ip): ClientIp,
    Path((owner, repo)): Path<(String, String)>,
) -> Response {
    Metrics::inc(&state.metrics.requests_other);
    let info = match resolve(&state, &owner, repo_name(&repo)).await {
        Ok(i) => i,
        Err(r) => return cors(*r),
    };
    let slot = match ready_mirror(&state, ip, &info).await {
        Ok(s) => s,
        Err(r) => return cors(*r),
    };
    let Some(m) = slot.manifest() else {
        return cors(unavailable(&Unavailable::Pending));
    };
    let body = serde_json::to_string_pretty(&*m).unwrap_or_default();
    cors(
        (
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, "public, max-age=30"),
            ],
            body,
        )
            .into_response(),
    )
}

async fn repo_page(State(state): St, Path((owner, repo)): Path<(String, String)>) -> Response {
    Metrics::inc(&state.metrics.requests_other);
    let name = repo_name(&repo);
    if !segment_ok(&owner, 64) || !segment_ok(name, 100) {
        return text(StatusCode::NOT_FOUND, "not found\n");
    }
    (
        StatusCode::FOUND,
        [(
            header::LOCATION,
            format!("{}/{owner}/{name}", state.cfg.web_base()),
        )],
    )
        .into_response()
}

/// `r`, cacheable for `max_age` seconds.
fn respond(r: Rendered, max_age: u64) -> Response {
    (
        [
            (header::CONTENT_TYPE, r.content_type.to_string()),
            (header::CACHE_CONTROL, format!("public, max-age={max_age}")),
        ],
        r.body,
    )
        .into_response()
}

/// A cached render: fresh from the cache, else rendered now, else (Platform failing) the stale
/// copy, else `fallback`.
async fn cached<F, Fut>(
    state: &AppState,
    key: String,
    render: F,
    fallback: impl FnOnce() -> Option<Rendered>,
) -> Response
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Rendered>>,
{
    let ttl = state.renders.ttl().as_secs();
    let expired = match state.renders.get(&key) {
        Lookup::Fresh(r) => return respond(r, ttl),
        Lookup::Stale(r) => Some(r),
        Lookup::Miss => None,
    };
    match render().await {
        Ok(r) => {
            state.metrics.upstream(true);
            state.renders.put(key, r.clone());
            respond(r, ttl)
        }
        Err(e) => {
            state.metrics.upstream(false);
            tracing::warn!(error = %format!("{e:#}"), "render failed");
            if let Some(r) = expired {
                Metrics::inc(&state.metrics.stale_renders);
                return respond(r, 60);
            }
            match fallback() {
                Some(r) => respond(r, 60),
                None => text(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Dash Platform cannot be read right now; try again shortly\n",
                ),
            }
        }
    }
}

#[derive(Debug, Deserialize)]
struct BadgeQuery {
    branch: Option<String>,
}

fn svg_rendered(b: &Badge) -> Rendered {
    Rendered {
        content_type: "image/svg+xml; charset=utf-8",
        body: Bytes::from(badge::svg(b)),
    }
}

async fn badge_route(
    State(state): St,
    Path((owner, name, file)): Path<(String, String, String)>,
    Query(q): Query<BadgeQuery>,
) -> Response {
    Metrics::inc(&state.metrics.requests_badge);
    let Some((kind, ext)) = file.rsplit_once('.') else {
        return text(
            StatusCode::NOT_FOUND,
            "badges are <kind>.svg or <kind>.json\n",
        );
    };
    let (Some(kind), true) = (Kind::parse(kind), matches!(ext, "svg" | "json")) else {
        return text(
            StatusCode::NOT_FOUND,
            "badge kinds: stars, ci, release, issues (.svg or .json)\n",
        );
    };
    let json = ext == "json";
    let info = match resolve(&state, &owner, &name).await {
        Ok(i) => i,
        Err(r) => {
            let b = Badge::new("dash forge", "repo not found", "lightgrey");
            let status = r.status();
            let mut resp = if json {
                badge::endpoint_json(&b, 300).into_response()
            } else {
                svg_rendered(&b).body.into_response()
            };
            *resp.status_mut() = status;
            resp.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(if json {
                    "application/json"
                } else {
                    "image/svg+xml; charset=utf-8"
                }),
            );
            return cors(resp);
        }
    };
    let ttl = state.cfg.render_ttl_secs;
    let to_rendered = move |b: &Badge| {
        if json {
            Rendered {
                content_type: "application/json",
                body: Bytes::from(badge::endpoint_json(b, ttl)),
            }
        } else {
            svg_rendered(b)
        }
    };
    let Ok(branch) = badge_branch(&state, &info, kind, q.branch).await else {
        let b = Badge::new("checks", "no branch", "lightgrey");
        return cors(respond(to_rendered(&b), ttl));
    };
    let key = format!(
        "badge:{}:{file}:{}",
        info.repo_id,
        branch.as_deref().unwrap_or("")
    );
    let label = match kind {
        Kind::Stars => "stars",
        Kind::Ci => "checks",
        Kind::Release => "release",
        Kind::Issues => "issues",
    };
    let s = Arc::clone(&state);
    let resp = cached(
        &state,
        key,
        || async move {
            let up = s.mirrors.upstream();
            let b = match kind {
                Kind::Stars => Badge::new("stars", up.stars(&info).await?.to_string(), "blue"),
                Kind::Issues => Badge::new(
                    "issues",
                    format!("{} open", up.open_issues(&info).await?),
                    "blue",
                ),
                Kind::Release => match up.releases(&info).await?.into_iter().find(|r| !r.yanked) {
                    Some(r) => Badge::new("release", r.tag, "blue"),
                    None => Badge::new("release", "none", "lightgrey"),
                },
                Kind::Ci => {
                    let tip = branch_tip(&s, &info, branch.as_deref()).await?;
                    match tip {
                        Some(oid) => badge::ci(&up.checks(&info, &oid).await?),
                        None => Badge::new("checks", "no branch", "lightgrey"),
                    }
                }
            };
            Ok(to_rendered(&b))
        },
        || Some(to_rendered(&Badge::unavailable(label))),
    )
    .await;
    cors(resp)
}

/// The `?branch=` a badge reads: only the checks badge reads one, and only a servable name.
/// `Err` when the repository has no such branch, which is known without a render (or a cache
/// entry, or a Platform read) per name.
async fn badge_branch(
    state: &AppState,
    info: &RepoInfo,
    kind: Kind,
    branch: Option<String>,
) -> Result<Option<String>, ()> {
    let Some(b) = branch
        .filter(|b| kind == Kind::Ci && crate::mirror::servable_ref(&format!("refs/heads/{b}")))
    else {
        return Ok(None);
    };
    match repo_tips(state, info).await {
        Ok(t) if !t.tips.contains_key(&format!("refs/heads/{b}")) => Err(()),
        // Platform failing: render as usual, so a stale render can still answer.
        _ => Ok(Some(b)),
    }
}

/// The tip of `branch` (default: the default branch), from [`repo_tips`].
async fn branch_tip(
    state: &AppState,
    info: &RepoInfo,
    branch: Option<&str>,
) -> anyhow::Result<Option<String>> {
    let t = repo_tips(state, info).await?;
    let want = branch
        .or(t.default_branch.as_deref())
        .map_or_else(|| "refs/heads/main".into(), |b| format!("refs/heads/{b}"));
    Ok(t.tips.get(&want).cloned())
}

/// `info`'s tips: from the mirror's manifest when it has one, else from a proved snapshot read
/// at most once per render TTL.
async fn repo_tips(state: &AppState, info: &RepoInfo) -> anyhow::Result<Arc<RepoTips>> {
    if state.mirrors.known(&info.repo_id) {
        if let Some(m) = state.mirrors.slot(info).manifest() {
            return Ok(Arc::new(RepoTips {
                default_branch: m.default_branch.clone(),
                tips: m
                    .refs
                    .iter()
                    .map(|r| (r.name.clone(), r.oid.clone()))
                    .collect(),
            }));
        }
    }
    let ttl = state.renders.ttl();
    let cached = state
        .tips
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&info.repo_id)
        .filter(|(at, _)| at.elapsed() < ttl)
        .map(|(_, t)| Arc::clone(t));
    if let Some(t) = cached {
        return Ok(t);
    }
    let snap = state.mirrors.upstream().snapshot(info).await?;
    let t = Arc::new(RepoTips {
        tips: snap.tips(),
        default_branch: snap.default_branch,
    });
    let mut all = state.tips.lock().unwrap_or_else(PoisonError::into_inner);
    if all.len() >= MAX_TIPS {
        all.retain(|_, (at, _)| at.elapsed() < ttl);
        if all.len() >= MAX_TIPS {
            all.clear();
        }
    }
    all.insert(info.repo_id.clone(), (Instant::now(), Arc::clone(&t)));
    Ok(t)
}

/// `s` percent-encoded as one URL path segment.
fn path_segment(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

async fn feed_route(
    State(state): St,
    ClientIp(ip): ClientIp,
    Path((owner, name, file)): Path<(String, String, String)>,
) -> Response {
    Metrics::inc(&state.metrics.requests_feed);
    let Some(kind) = file.strip_suffix(".atom") else {
        return text(
            StatusCode::NOT_FOUND,
            "feeds: releases.atom, commits.atom, issues.atom\n",
        );
    };
    if !matches!(kind, "releases" | "commits" | "issues") {
        return text(
            StatusCode::NOT_FOUND,
            "feeds: releases.atom, commits.atom, issues.atom\n",
        );
    }
    let info = match resolve(&state, &owner, &name).await {
        Ok(i) => i,
        Err(r) => return *r,
    };
    // The commit feed reads the mirror (git log), so it needs one.
    let slot = if kind == "commits" {
        match ready_mirror(&state, ip, &info).await {
            Ok(s) => Some(s),
            Err(r) => return *r,
        }
    } else {
        None
    };
    let web = format!("{}/{owner}/{name}", state.cfg.web_base());
    let net = state.mirrors.upstream().network();
    let feed_id = format!("urn:dash-forge:{net}:{}:{kind}", info.repo_id);
    let self_url = format!("{}/feed/{owner}/{name}/{file}", state.cfg.public_base());
    let key = format!("feed:{}:{kind}:{owner}", info.repo_id);
    let s = Arc::clone(&state);
    let kind = kind.to_string();
    cors(
        cached(
            &state,
            key,
            || async move {
                let entries = feed_entries(&s, &info, &kind, slot, &web, &net).await?;
                let xml = Feed {
                    id: feed_id,
                    title: format!("{owner}/{name} {kind}"),
                    self_url,
                    link: web,
                    entries,
                }
                .render();
                Ok(Rendered {
                    content_type: "application/atom+xml; charset=utf-8",
                    body: Bytes::from(xml),
                })
            },
            || None,
        )
        .await,
    )
}

/// A feed's entries, newest first. `web` is the repository's page; the commit feed reads the
/// mirror `slot` (`git log` of `HEAD`).
async fn feed_entries(
    s: &AppState,
    info: &RepoInfo,
    kind: &str,
    slot: Option<Arc<Slot>>,
    web: &str,
    net: &str,
) -> anyhow::Result<Vec<Entry>> {
    let up = s.mirrors.upstream();
    Ok(match kind {
        "releases" => up
            .releases(info)
            .await?
            .into_iter()
            .map(|r| Entry {
                id: format!("urn:dash-forge:{net}:release:{}", r.document_id),
                title: format!(
                    "{}{}",
                    if r.name.is_empty() { &r.tag } else { &r.name },
                    if r.yanked { " (yanked)" } else { "" }
                ),
                link: format!("{web}/releases/tag/{}", path_segment(&r.tag)),
                updated_ms: r.created_at,
                author: None,
                content: (!r.notes.is_empty()).then(|| badge::clip(&r.notes, 4000)),
            })
            .take(FEED_ENTRIES)
            .collect(),
        "issues" => up
            .issues(info, FEED_ENTRIES)
            .await?
            .into_iter()
            .map(|i| Entry {
                id: format!("urn:dash-forge:{net}:issue:{}", i.document_id),
                title: format!("#{} {}", i.number, i.title),
                link: format!("{web}/issues/{}", i.number),
                updated_ms: i.created_at,
                author: Some(og::short_owner(&i.author)),
                content: None,
            })
            .collect(),
        _ => {
            let slot = slot.ok_or_else(|| anyhow::anyhow!("a commit feed needs a mirror"))?;
            let guard = s
                .mirrors
                .checkout(&slot)
                .ok_or_else(|| anyhow::anyhow!("the mirror was evicted"))?;
            let mut c = s.mirrors.git(&guard.slot().dir);
            c.args([
                "log",
                "-n",
                &FEED_ENTRIES.to_string(),
                feed::LOG_FORMAT,
                "HEAD",
                "--",
            ]);
            let out = tokio::time::timeout(Duration::from_secs(30), c.output()).await??;
            let log = if out.status.success() {
                feed::parse_log(&String::from_utf8_lossy(&out.stdout))
            } else {
                Vec::new()
            };
            log.into_iter()
                .map(|c| Entry {
                    id: format!("urn:dash-forge:{net}:commit:{}", c.oid),
                    title: if c.subject.is_empty() {
                        c.oid.clone()
                    } else {
                        c.subject
                    },
                    link: format!("{web}/commit/{}", c.oid),
                    updated_ms: c.time.saturating_mul(1000),
                    author: Some(c.author),
                    content: None,
                })
                .collect()
        }
    })
}

async fn og_route(State(state): St, Path((owner, file)): Path<(String, String)>) -> Response {
    Metrics::inc(&state.metrics.requests_og);
    let (name, png) = match file.strip_suffix(".png") {
        Some(n) => (n.to_string(), true),
        None => (file.clone(), false),
    };
    let info = match resolve(&state, &owner, &name).await {
        Ok(i) => i,
        Err(r) => return *r,
    };
    let owner_label = og::short_owner(&owner);
    let web = format!("{}/{owner}/{name}", state.cfg.web_base());
    let key = format!("og:{}:{owner}:{png}", info.repo_id);
    let s = Arc::clone(&state);
    cached(
        &state,
        key,
        || async move {
            let up = s.mirrors.upstream();
            let description = up.description(&info).await?;
            if !png {
                let html = og::page_html(&og::Page {
                    title: format!("{owner_label}/{name}"),
                    description,
                    image: format!("{}/og/{owner}/{name}.png", s.cfg.public_base()),
                    target: web,
                });
                return Ok(Rendered {
                    content_type: "text/html; charset=utf-8",
                    body: Bytes::from(html),
                });
            }
            let stars = up.stars(&info).await.ok();
            let default_branch = s
                .mirrors
                .known(&info.repo_id)
                .then(|| s.mirrors.slot(&info).manifest())
                .flatten()
                .and_then(|m| m.default_branch.clone());
            let site = s
                .cfg
                .web_base()
                .split("://")
                .nth(1)
                .unwrap_or_default()
                .to_string();
            let card = og::Card {
                owner: owner_label,
                name,
                description,
                stars,
                default_branch,
                site,
            };
            let fonts = Arc::clone(&s.fonts);
            let png =
                tokio::task::spawn_blocking(move || og::render_png(&og::card_svg(&card), fonts))
                    .await??;
            Ok(Rendered {
                content_type: "image/png",
                body: Bytes::from(png),
            })
        },
        || None,
    )
    .await
}

async fn index(State(state): St) -> Response {
    Metrics::inc(&state.metrics.requests_other);
    let net = state.mirrors.upstream().network();
    let base = badge::xml_escape(&state.cfg.public_base());
    let web = badge::xml_escape(&state.cfg.web_base());
    let html = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dash Forge gateway</title></head>
<body style="font-family:sans-serif;max-width:46rem;margin:2rem auto;line-height:1.5">
<h1>Dash Forge gateway</h1>
<p>A read-only git mirror of public <a href="{web}">Dash Forge</a> repositories on <code>{net}</code>, for tools that only speak plain git.</p>
<pre>git clone {base}/&lt;owner&gt;/&lt;name&gt;.git</pre>
<p>It is optional and never an authority: every repository's <code>forge-manifest.json</code> names the Platform documents behind each ref, and <code>dg verify-mirror {base}/&lt;owner&gt;/&lt;name&gt;.git</code> checks the mirror against Dash Platform with proofs. <code>git clone dash://&lt;owner&gt;/&lt;name&gt;</code> never needs this gateway.</p>
<p>Badges: <code>/badge/&lt;owner&gt;/&lt;name&gt;/{{stars,ci,release,issues}}.svg</code>. Feeds: <code>/feed/&lt;owner&gt;/&lt;name&gt;/{{releases,commits,issues}}.atom</code>. Previews: <code>/og/&lt;owner&gt;/&lt;name&gt;</code>.</p>
<p>Privacy: client addresses are held in memory for rate limiting only and are never logged. Private repositories are never served.</p>
</body></html>"#
    );
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response()
}

async fn readyz(State(state): St) -> Response {
    let (ok, failed) = state.metrics.upstream_times();
    let ready = match (ok, failed) {
        (_, None) => true,
        (Some(ok), Some(failed)) => ok >= failed,
        (None, Some(_)) => false,
    };
    let g = state.gauges();
    let body = json!({
        "status": if ready { "ok" } else { "degraded" },
        "network": state.mirrors.upstream().network(),
        "platform": if ready { "reachable" } else { "failing" },
        "mirrors": g.mirrors,
        "mirrorsReady": g.mirrors_ready,
        "cacheBytes": g.cache_bytes,
    });
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

async fn metrics(State(state): St) -> Response {
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.metrics.render(state.gauges()),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_resolution_cache_is_bounded() {
        let hit = |n: usize| {
            Some(RepoInfo {
                repo_id: format!("r{n}"),
                owner_id: "o".into(),
                name: format!("n{n}"),
                public: true,
            })
        };
        let mut m = HashMap::new();
        for n in 0..MAX_RESOLVED {
            let info = if n % 2 == 0 { hit(n) } else { None };
            remember(&mut m, ("o".into(), format!("n{n}")), info);
        }
        assert_eq!(m.len(), MAX_RESOLVED);
        // Full: the misses go, the live hits stay.
        remember(&mut m, ("o".into(), "new".into()), hit(MAX_RESOLVED));
        assert_eq!(m.len(), MAX_RESOLVED / 2 + 1);
        assert!(m.contains_key(&("o".to_string(), "n0".to_string())));
        assert!(!m.contains_key(&("o".to_string(), "n1".to_string())));
        // Full of live hits: it starts over rather than grow.
        let mut m = HashMap::new();
        for n in 0..MAX_RESOLVED {
            remember(&mut m, ("o".into(), format!("n{n}")), hit(n));
        }
        remember(&mut m, ("o".into(), "new".into()), None);
        assert_eq!(m.len(), 1);
    }

    #[test]
    fn segments_are_checked() {
        assert!(segment_ok("alice", 64));
        assert!(segment_ok("G6D3ejKx", 64));
        assert!(segment_ok("my-repo.rs", 100));
        assert!(!segment_ok("", 64));
        assert!(!segment_ok("..", 64));
        assert!(!segment_ok(".git", 64));
        assert!(!segment_ok("a/b", 64));
        assert!(!segment_ok("a%2Fb", 64));
        assert_eq!(repo_name("x.git"), "x");
        assert_eq!(repo_name("x"), "x");
    }

    #[test]
    fn the_client_address_comes_from_the_trusted_header_only() {
        let mut h = HeaderMap::new();
        h.insert("cf-connecting-ip", "198.51.100.7".parse().unwrap());
        h.insert(
            "x-forwarded-for",
            "203.0.113.1, 198.51.100.8".parse().unwrap(),
        );
        let conn = ConnectInfo(SocketAddr::from(([10, 0, 0, 1], 5000)));
        assert_eq!(
            client_ip(&h, Some(&conn), TrustProxy::None).to_string(),
            "10.0.0.1"
        );
        assert_eq!(
            client_ip(&h, Some(&conn), TrustProxy::Cloudflare).to_string(),
            "198.51.100.7"
        );
        assert_eq!(
            client_ip(&h, Some(&conn), TrustProxy::XForwardedFor).to_string(),
            "198.51.100.8"
        );
        assert_eq!(
            client_ip(&HeaderMap::new(), None, TrustProxy::Cloudflare).to_string(),
            "0.0.0.0"
        );
    }

    #[test]
    fn path_segments_are_encoded() {
        assert_eq!(path_segment("v1.0.0"), "v1.0.0");
        assert_eq!(path_segment("a/b c"), "a%2Fb%20c");
    }
}
