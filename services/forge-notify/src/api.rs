//! The HTTP API.
//!
//! | Route | What |
//! |---|---|
//! | `GET /healthz` | liveness: `{"status":"ok"}` |
//! | `GET /readyz` | readiness: the store answers and the watcher started (else 503) |
//! | `GET /metrics` | Prometheus text: aggregate counts only (subscribers, sends today, …) |
//! | `GET /v1/info` | operator, channels offered, the VAPID public key, limits, privacy link |
//! | `POST /v1/request` | a signed request ([`crate::auth`]): account, email, prefs, push, test, export, delete |
//! | `GET /v1/verify?token=` | the confirmation page (a button: link scanners must not confirm) |
//! | `POST /v1/verify` | confirm an address (form field `token`) |
//! | `GET /u/{token}` | the unsubscribe page |
//! | `POST /u/{token}` | unsubscribe (RFC 8058 one-click: any body, no login) |
//!
//! Browsers may call `/v1/*` from the allowed origins only (CORS). Every route is rate limited
//! per client address. Responses carry `Cache-Control: no-store`; pages carry a CSP that
//! allows no script and `Referrer-Policy: no-referrer` (their URLs hold tokens).

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::{ConnectInfo, DefaultBodyLimit, Form, Path, Query, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::auth::{self, KeySource, SignedEnvelope, SignedRequest};
use crate::crypto::{random_token, token_hash, Vault};
use crate::dispatch::{email_context, push_context, Dispatcher};
use crate::error::{NotifyError, Result};
use crate::index::ReindexQueue;
use crate::limits::{client_ip, RateLimiter, TrustProxy};
use crate::mail::Mail;
use crate::push::{check_target, PushMessage, PushTarget};
use crate::store::{now_ms, Pending, Prefs, Store};

/// How long a confirmation link lives.
pub const VERIFY_TTL_MS: u64 = 48 * 3600 * 1000;
/// How many identities may share one address.
pub const MAX_IDENTITIES_PER_EMAIL: u64 = 5;
/// Confirmation mails per identity per day, and per address per day.
pub const VERIFY_PER_DAY: u64 = 5;
/// Push subscriptions per identity.
pub const MAX_PUSH_PER_IDENTITY: usize = 10;
/// Test sends per identity per day.
pub const TESTS_PER_DAY: u64 = 5;
/// The largest request body.
pub const MAX_BODY: usize = 16 * 1024;

/// What the handlers share.
pub struct App {
    /// The store.
    pub store: Store,
    /// The data key.
    pub vault: Arc<Vault>,
    /// Identity keys.
    pub keys: Arc<dyn KeySource>,
    /// Delivery (and its mailer and pusher).
    pub dispatcher: Arc<Dispatcher>,
    /// Per-address limits.
    pub limiter: RateLimiter,
    /// Ask the indexer to rebuild one identity's follows.
    pub reindex: Arc<ReindexQueue>,
    /// Set once the watcher is running.
    pub ready: Arc<AtomicBool>,
    /// Settings the API needs.
    pub settings: ApiSettings,
}

/// The configuration the API reads.
#[derive(Debug, Clone)]
pub struct ApiSettings {
    /// The operator name.
    pub operator: String,
    /// The Forge contracts and group: a signing key bound elsewhere is refused.
    pub forge: forge_core::network::ForgeIds,
    /// This service's public URL.
    pub public_url: String,
    /// Allowed browser origins.
    pub allowed_origins: Vec<String>,
    /// The privacy notice link.
    pub privacy_url: Option<String>,
    /// The operator's contact.
    pub contact: Option<String>,
    /// Allowed push hosts.
    pub push_hosts: Vec<String>,
    /// Local test mode.
    pub insecure_local: bool,
    /// Trust proxy headers for the client address.
    pub trust_proxy: TrustProxy,
    /// Subscriber cap.
    pub max_subscribers: u64,
    /// Repos per subscriber.
    pub max_repos_per_user: usize,
    /// The digest hour.
    pub digest_hour: u8,
}

/// The router.
pub fn router(app: Arc<App>) -> Router {
    let origins: Vec<HeaderValue> = app
        .settings
        .allowed_origins
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE])
        .max_age(std::time::Duration::from_secs(600));
    let api = Router::new()
        .route("/v1/info", get(info))
        .route("/v1/request", post(signed))
        .layer(cors);
    Router::new()
        .route("/healthz", get(|| async { Json(json!({"status": "ok"})) }))
        .route("/readyz", get(readyz))
        .route("/metrics", get(metrics))
        .route("/v1/verify", get(verify_page).post(verify_confirm))
        .route("/u/{token}", get(unsubscribe_page).post(unsubscribe_now))
        .merge(api)
        .layer(middleware::from_fn_with_state(Arc::clone(&app), guard))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(app)
}

/// Rate limit, and the headers every response carries.
async fn guard(
    State(app): State<Arc<App>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    let ip = client_ip(peer, req.headers(), app.settings.trust_proxy);
    let probe = matches!(req.uri().path(), "/healthz" | "/readyz");
    if !probe && !app.limiter.allow(ip) {
        return NotifyError::RateLimited("slow down".into()).into_response();
    }
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        ),
    );
    res
}

async fn readyz(State(app): State<Arc<App>>) -> Response {
    let store = app.store.ping();
    let watcher = app.ready.load(Ordering::SeqCst);
    let status = if store && watcher {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(json!({"store": store, "watcher": watcher}))).into_response()
}

async fn metrics(State(app): State<Arc<App>>) -> Result<Response> {
    use std::fmt::Write as _;
    let mut body = String::new();
    for (name, value) in app.store.gauges()? {
        let _ = writeln!(body, "# TYPE {name} gauge\n{name} {value}");
    }
    let ready = u8::from(app.ready.load(Ordering::SeqCst));
    let _ = writeln!(
        body,
        "# TYPE forge_notify_ready gauge\nforge_notify_ready {ready}"
    );
    Ok(([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body).into_response())
}

async fn info(State(app): State<Arc<App>>) -> Json<Value> {
    let d = &app.dispatcher;
    let s = &app.settings;
    Json(json!({
        "service": "forge-notify",
        "version": env!("CARGO_PKG_VERSION"),
        "operator": s.operator,
        "channels": {
            "email": d.mailer.is_some(),
            "push": d.pusher.is_some(),
        },
        "vapidPublicKey": d.pusher.as_ref().map(|p| p.public_key()),
        "privacyUrl": s.privacy_url,
        "contact": s.contact,
        "digestHourUtc": s.digest_hour,
        "limits": {
            "reposPerSubscriber": s.max_repos_per_user,
            "pushSubscriptions": MAX_PUSH_PER_IDENTITY,
        },
        "auth": {"domain": auth::DOMAIN.trim_end(), "maxSkewSecs": auth::MAX_SKEW_SECS},
    }))
}

fn now_secs() -> u64 {
    now_ms() / 1000
}

fn payload<T: for<'de> Deserialize<'de>>(req: &SignedRequest) -> Result<T> {
    serde_json::from_value(req.payload.clone())
        .map_err(|e| NotifyError::BadRequest(format!("payload: {e}")))
}

async fn signed(
    State(app): State<Arc<App>>,
    Json(env): Json<SignedEnvelope>,
) -> Result<Json<Value>> {
    let req = auth::verify(
        &env,
        &app.settings.operator,
        app.keys.as_ref(),
        &app.settings.forge,
        now_secs(),
    )
    .await?;
    let expires = (req.time + auth::MAX_SKEW_SECS * 2) * 1000;
    if !app
        .store
        .use_nonce(&format!("{}:{}", req.identity, req.nonce), expires)?
    {
        return Err(NotifyError::Unauthorized(
            "this request was already used".into(),
        ));
    }
    tracing::info!(action = %req.action, "signed request");
    let id = req.identity.as_str();
    match req.action.as_str() {
        "account.get" => account(&app, id),
        "email.set" => email_set(&app, &req).await,
        "email.remove" => {
            app.store.remove_email(id)?;
            Ok(Json(json!({"ok": true})))
        }
        "prefs.set" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct P {
                prefs: Prefs,
            }
            let p: P = payload(&req)?;
            p.prefs.check()?;
            ensure_room(&app, id)?;
            app.store.set_prefs(id, &p.prefs)?;
            app.reindex.request(id);
            account(&app, id)
        }
        "push.add" => push_add(&app, &req),
        "push.remove" => {
            #[derive(Deserialize)]
            struct P {
                endpoint: String,
            }
            let p: P = payload(&req)?;
            let removed = app.store.remove_push(id, &endpoint_hash(&p.endpoint))?;
            Ok(Json(json!({"ok": removed})))
        }
        "test.send" => test_send(&app, id).await,
        "data.export" => export(&app, id),
        "data.delete" => {
            app.store.delete_identity(id)?;
            Ok(Json(json!({"ok": true, "deleted": true})))
        }
        _ => Err(NotifyError::BadRequest("unknown action".into())),
    }
}

/// Create the subscriber row unless the service is full.
fn ensure_room(app: &App, identity: &str) -> Result<()> {
    if app.store.subscriber(identity)?.is_none()
        && app.store.subscriber_count()? >= app.settings.max_subscribers
    {
        return Err(NotifyError::RateLimited(
            "this service is not taking new subscribers".into(),
        ));
    }
    app.store.ensure_subscriber(identity)?;
    Ok(())
}

/// `a•••@example.org`.
fn mask(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) => {
            let first: String = local.chars().take(1).collect();
            format!("{first}•••@{domain}")
        }
        None => "•••".into(),
    }
}

fn account(app: &App, identity: &str) -> Result<Json<Value>> {
    let Some(s) = app.store.subscriber(identity)? else {
        return Ok(Json(
            json!({"identity": identity, "subscribed": false, "prefs": Prefs::default()}),
        ));
    };
    let email = match &s.email_sealed {
        Some(sealed) => Some(mask(
            &app.vault.open_string(&email_context(identity), sealed)?,
        )),
        None => None,
    };
    let pushes: Vec<Value> = app
        .store
        .pushes(identity)?
        .iter()
        .map(|p| json!({"id": p.id, "label": p.label, "createdAt": p.created_at}))
        .collect();
    let follows = app.store.follows(identity)?;
    Ok(Json(json!({
        "identity": identity,
        "subscribed": true,
        "email": {
            "address": email,
            "verified": s.email_verified,
            "paused": s.email_paused,
        },
        "prefs": s.prefs,
        "push": pushes,
        "following": {
            "repos": follows.len(),
            "private": follows.iter().filter(|f| f.private).count(),
        },
    })))
}

async fn email_set(app: &App, req: &SignedRequest) -> Result<Json<Value>> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct P {
        email: String,
    }
    let Some(mailer) = app.dispatcher.mailer.clone() else {
        return Err(NotifyError::BadRequest(
            "this service does not send email".into(),
        ));
    };
    let p: P = payload(req)?;
    let email = p.email.trim().to_string();
    if email.len() > 254
        || email.parse::<lettre::Address>().is_err()
        || email.chars().any(char::is_control)
    {
        return Err(NotifyError::BadRequest(
            "that is not an email address".into(),
        ));
    }
    let id = req.identity.as_str();
    ensure_room(app, id)?;
    let idx = app.vault.email_index(&email);
    if app.store.identities_with_email(&idx)? >= MAX_IDENTITIES_PER_EMAIL {
        return Err(NotifyError::BadRequest(
            "this address is already used by too many identities".into(),
        ));
    }
    let limit_key = app.vault.email_limit_key(&email);
    if !app
        .store
        .take_quota(&format!("verify:{id}"), VERIFY_PER_DAY)?
        || !app
            .store
            .take_quota(&format!("verify-addr:{limit_key}"), VERIFY_PER_DAY)?
    {
        return Err(NotifyError::RateLimited(
            "too many confirmation mails today; try tomorrow".into(),
        ));
    }
    // A confirmation mail is a mail: it counts against the service's daily budget too.
    if !app
        .store
        .take_quota("global", app.dispatcher.daily_budget)?
    {
        return Err(NotifyError::RateLimited(
            "the service has sent all the mail it may today; try tomorrow".into(),
        ));
    }
    let token = random_token();
    app.store.add_pending(
        &token_hash(&token),
        &Pending {
            identity: id.to_string(),
            email_sealed: app.vault.seal(&email_context(id), email.as_bytes())?,
            email_idx: idx,
            expires_at: now_ms() + VERIFY_TTL_MS,
        },
    )?;
    let link = format!("{}/v1/verify?token={token}", app.settings.public_url);
    let short = forge_relay::sinks::render::short_id(id);
    let text = format!(
        "Someone (hopefully you) asked {op} to email Dash Forge notifications for the identity \
         {short} to this address.\n\nConfirm it here (the link works for 48 hours):\n{link}\n\n\
         If it was not you, ignore this mail: nothing more will be sent, and the request \
         expires.\n\n-- \n{op} (forge-notify). Notifications are optional: Forge works without \
         them.\n",
        op = app.settings.operator,
    );
    let mail = Mail {
        to: email,
        subject: "Confirm your email for Dash Forge notifications".into(),
        text,
        unsubscribe: None,
    };
    mailer
        .send(&mail)
        .await
        .map_err(|e| NotifyError::Unavailable(format!("sending the confirmation mail: {e}")))?;
    Ok(Json(json!({"ok": true, "status": "pending"})))
}

/// The id of an endpoint in the store (the endpoint itself is sealed).
pub fn endpoint_hash(endpoint: &str) -> String {
    hex::encode(Sha256::digest(endpoint.as_bytes()))
}

fn push_add(app: &App, req: &SignedRequest) -> Result<Json<Value>> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct P {
        endpoint: String,
        p256dh: String,
        auth: String,
        #[serde(default)]
        label: Option<String>,
    }
    if app.dispatcher.pusher.is_none() {
        return Err(NotifyError::BadRequest(
            "this service does not send push".into(),
        ));
    }
    let p: P = payload(req)?;
    let target = PushTarget {
        endpoint: p.endpoint,
        p256dh: p.p256dh,
        auth: p.auth,
    };
    check_target(
        &target,
        &app.settings.push_hosts,
        app.settings.insecure_local,
    )?;
    let id = req.identity.as_str();
    ensure_room(app, id)?;
    let hash = endpoint_hash(&target.endpoint);
    let existing = app.store.pushes(id)?;
    if existing.len() >= MAX_PUSH_PER_IDENTITY {
        return Err(NotifyError::BadRequest(format!(
            "at most {MAX_PUSH_PER_IDENTITY} browsers per identity; remove one first"
        )));
    }
    let label = p
        .label
        .map(|l| forge_relay::sinks::render::clean_line(&l, 60));
    let plain = serde_json::to_vec(&target).map_err(|e| NotifyError::Internal(e.to_string()))?;
    app.store.add_push(
        id,
        &hash,
        &app.vault.seal(&push_context(id), &plain)?,
        label.as_deref(),
    )?;
    app.reindex.request(id);
    Ok(Json(json!({"ok": true})))
}

async fn test_send(app: &App, id: &str) -> Result<Json<Value>> {
    let Some(s) = app.store.subscriber(id)? else {
        return Err(NotifyError::BadRequest("nothing is set up yet".into()));
    };
    if !app.store.take_quota(&format!("test:{id}"), TESTS_PER_DAY)? {
        return Err(NotifyError::RateLimited("too many tests today".into()));
    }
    let d = &app.dispatcher;
    let mut mailed = false;
    if let (true, Some(m), Some(sealed)) = (s.mail_ok(), &d.mailer, &s.email_sealed) {
        let to = app.vault.open_string(&email_context(id), sealed)?;
        let mail = Mail {
            to: to.to_string(),
            subject: "Dash Forge: a test notification".into(),
            text: format!(
                "This is a test from {}. Notifications for your identity reach this address.\n\n\
                 -- \nStop all email from this service: {}\n",
                app.settings.operator,
                d.unsubscribe_url(&s)
            ),
            unsubscribe: Some(d.unsubscribe_url(&s)),
        };
        mailed = d.send_mail(m.as_ref(), &s, &mail).await?;
    }
    let mut pushed = 0;
    if let Some(p) = &d.pusher {
        let message = PushMessage {
            title: "Dash Forge".into(),
            body: "A test notification: push works in this browser.".into(),
            url: format!("{}/settings/notifications/", d.web_url),
            tag: "test".into(),
        };
        for row in app.store.pushes(id)? {
            let plain = app.vault.open(&push_context(id), &row.sealed)?;
            if let Ok(t) = serde_json::from_slice::<PushTarget>(&plain) {
                if p.push(&t, &message).await == crate::push::PushOutcome::Sent {
                    pushed += 1;
                }
            }
        }
    }
    Ok(Json(json!({"ok": true, "email": mailed, "push": pushed})))
}

fn export(app: &App, id: &str) -> Result<Json<Value>> {
    let Some(s) = app.store.subscriber(id)? else {
        return Ok(Json(json!({"identity": id, "subscribed": false})));
    };
    let email = match &s.email_sealed {
        Some(sealed) => Some(
            app.vault
                .open_string(&email_context(id), sealed)?
                .to_string(),
        ),
        None => None,
    };
    let mut pushes = Vec::new();
    for row in app.store.pushes(id)? {
        let plain = app.vault.open(&push_context(id), &row.sealed)?;
        let t: Value = serde_json::from_slice(&plain).unwrap_or(Value::Null);
        pushes.push(json!({"subscription": t, "label": row.label, "createdAt": row.created_at}));
    }
    let follows: Vec<Value> = app
        .store
        .follows(id)?
        .iter()
        .map(|f| json!({"repoId": f.repo_id, "reason": f.reason, "private": f.private}))
        .collect();
    Ok(Json(json!({
        "exportedAt": now_ms(),
        "operator": app.settings.operator,
        "identity": id,
        "createdAt": s.created_at,
        "email": {"address": email, "verified": s.email_verified, "paused": s.email_paused},
        "prefs": s.prefs,
        "push": pushes,
        "following": follows,
        "participating": app.store.participating_repos(id)?,
        "dpnsLabel": s.name,
    })))
}

/// HTML-escape.
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn page(title: &str, body: &str) -> Html<String> {
    Html(format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>{t}</title><style>body{{font:16px/1.5 system-ui,sans-serif;max-width:36rem;\
         margin:3rem auto;padding:0 1rem;color:#1c1917}}button{{font:inherit;padding:.5rem 1rem;\
         border-radius:.375rem;border:1px solid #57534e;background:#fafaf9;cursor:pointer}}\
         p.s{{color:#57534e;font-size:.875rem}}</style></head><body><h1>{t}</h1>{body}</body></html>",
        t = esc(title)
    ))
}

#[derive(Deserialize)]
struct TokenQuery {
    token: String,
}

async fn verify_page(
    State(app): State<Arc<App>>,
    Query(q): Query<TokenQuery>,
) -> Result<Html<String>> {
    let Some(p) = app.store.pending(&token_hash(&q.token))? else {
        return Ok(page(
            "This link has expired",
            "<p>Ask for a new confirmation mail from Forge's Settings → Notifications.</p>",
        ));
    };
    let addr = app
        .vault
        .open_string(&email_context(&p.identity), &p.email_sealed)?;
    Ok(page(
        "Confirm your email",
        &format!(
            "<p>Send Dash Forge notifications for the identity <code>{id}</code> to \
             <strong>{addr}</strong>?</p><form method=\"post\" action=\"/v1/verify\">\
             <input type=\"hidden\" name=\"token\" value=\"{tok}\"><button type=\"submit\">\
             Confirm</button></form><p class=\"s\">Sent by {op}. If you did not ask for this, \
             close this page: nothing will be sent.</p>",
            id = esc(&p.identity),
            addr = esc(&addr),
            tok = esc(&q.token),
            op = esc(&app.settings.operator),
        ),
    ))
}

async fn verify_confirm(
    State(app): State<Arc<App>>,
    Form(q): Form<TokenQuery>,
) -> Result<Html<String>> {
    match app.store.confirm_pending(&token_hash(&q.token))? {
        Some(identity) => {
            app.reindex.request(&identity);
            Ok(page(
                "Email confirmed",
                "<p>Notifications will reach this address. Choose what you hear about in Forge's \
                 Settings → Notifications. Every mail has a one-click unsubscribe link.</p>",
            ))
        }
        None => Ok(page(
            "This link has expired",
            "<p>Ask for a new confirmation mail from Forge's Settings → Notifications.</p>",
        )),
    }
}

async fn unsubscribe_page(State(app): State<Arc<App>>, Path(token): Path<String>) -> Html<String> {
    if app.vault.check_unsubscribe_token(&token).is_none() {
        return page("This link is not valid", "<p>Nothing was changed.</p>");
    }
    page(
        "Unsubscribe",
        &format!(
            "<p>Stop all email from {op}? Your address is deleted from the service. Push \
             notifications in your browsers are not affected.</p><form method=\"post\" \
             action=\"/u/{tok}\"><button type=\"submit\">Unsubscribe</button></form>",
            op = esc(&app.settings.operator),
            tok = esc(&token),
        ),
    )
}

async fn unsubscribe_now(
    State(app): State<Arc<App>>,
    Path(token): Path<String>,
) -> Result<Html<String>> {
    let Some((identity, epoch)) = app.vault.check_unsubscribe_token(&token) else {
        return Err(NotifyError::NotFound);
    };
    let done = app.store.unsubscribe(&identity, epoch)?;
    tracing::info!(done, "one-click unsubscribe");
    Ok(page(
        "You are unsubscribed",
        "<p>No more email will be sent to this address, and it is deleted from the service. \
         You can subscribe again from Forge's Settings → Notifications.</p>",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masking_and_escaping() {
        assert_eq!(mask("alice@example.org"), "a•••@example.org");
        assert_eq!(
            esc("<a href=\"x\">&'"),
            "&lt;a href=&quot;x&quot;&gt;&amp;&#39;"
        );
    }
}
