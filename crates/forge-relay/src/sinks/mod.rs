//! Sinks: deliver repository activity to chat, push and email from the relay's **private
//! config**, with no on-chain document (DX-08).
//!
//! A `webhook` document is public on chain and needs a maintainer to write it. A sink is the
//! other way round: the relay's operator lists it in `relay.toml`, and its URL, token or SMTP
//! password never leaves the relay host. So a contributor or a watcher can get Discord, Slack,
//! Matrix, ntfy or email notices for any public repository, and nothing about it is published.
//!
//! ```toml
//! [[sink]]
//! name = "team-chat"
//! kind = "discord"                       # discord | slack | matrix | ntfy | smtp
//! url = "env:DISCORD_WEBHOOK_URL"        # a secret reference, never the URL itself
//! repos = ["alice/project"]              # watched for this sink; default: the chosen repos
//! events = ["pull_request", "issues"]    # default: every event
//! ```
//!
//! * **Secrets** are references (`env:VAR` or `keychain:<service>/<account>`, the scheme of
//!   storage profiles, [`forge_core::storage::SecretRef`]); a literal is refused. A Discord or
//!   Slack webhook URL *is* a credential, so it is a reference too.
//! * **What reaches a sink**: a sink with `repos` gets those repositories (watched for it). A
//!   sink without `repos` gets the repositories the operator chose: the config's `[watch]`
//!   (repos and identity), `[wake]`, `[[webhook]]` blocks and the sinks' own `repos`, and an
//!   embedder's watch feed; they are polled for its `events` too. It never gets a repository
//!   served only because a `webhook` document points at the relay identity: anyone can create
//!   a repository and such a document, so that would let strangers post into the operator's
//!   channels ([`SinkHub::set_covered`]). Either way the sink's `events` filter applies. Each
//!   event becomes a [`render::Notice`]: who did what, an excerpt, the forge-web link. The
//!   relay serves public repositories only.
//! * **Delivery**: each sink has a worker and a queue of [`QUEUE_PER_SINK`] events (more are
//!   dropped with a warning), sends at most `max-per-minute` (default
//!   [`DEFAULT_PER_MINUTE`]), and retries a failure [`RETRIES`] times (2 s, 10 s, 30 s, or the
//!   receiver's `Retry-After`, at most 2 min) before it drops the notice with a `SINK-DROP` log
//!   line. A 4xx other than 408/429 is not retried. Sinks are not durable: notices queued at
//!   shutdown are lost (webhooks keep their retry queue).
//! * **Logs** name the sink, its kind, the repo id and the event; never a URL, token, address
//!   or body.
//!
//! Embedders (forge-notify) implement [`EventSink`] themselves and pass it to
//! [`crate::daemon::run_with`].

pub mod render;
pub mod send;

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use lettre::message::Mailbox;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use forge_core::keystore::Secret;
use forge_core::platform::PlatformClient;
use forge_core::storage::SecretRef;

use crate::error::{RelayError, Result};
use crate::payload::{WebhookEvent, ALL_EVENTS};

pub use render::Notice;

/// Receives every event the relay's poller emits, with the repository id. It must not block:
/// queue the event and return.
pub trait EventSink: Send + Sync {
    /// One event of repository `repo_id`.
    fn accept(&self, repo_id: &str, event: &WebhookEvent);
}

/// Events waiting per sink; beyond this they are dropped with a warning.
pub const QUEUE_PER_SINK: usize = 256;

/// The default send rate per sink (Discord allows 30 a minute per webhook).
pub const DEFAULT_PER_MINUTE: u32 = 20;

/// Retries after a failed send.
pub const RETRIES: usize = 3;

/// The pause before each retry (unless the receiver asked for longer).
const RETRY_DELAYS: [Duration; RETRIES] = [
    Duration::from_secs(2),
    Duration::from_secs(10),
    Duration::from_secs(30),
];

/// The longest `Retry-After` honoured.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(120);

/// The kinds of sink.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SinkKind {
    /// A Discord channel webhook.
    Discord,
    /// A Slack incoming webhook.
    Slack,
    /// A Matrix room, through a bot account's access token.
    Matrix,
    /// An ntfy topic (ntfy.sh or self-hosted): push to phones and desktops.
    Ntfy,
    /// Email over SMTP.
    Smtp,
}

impl SinkKind {
    /// The kind as written in the config.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Discord => "discord",
            Self::Slack => "slack",
            Self::Matrix => "matrix",
            Self::Ntfy => "ntfy",
            Self::Smtp => "smtp",
        }
    }
}

/// How an SMTP connection is secured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SmtpTls {
    /// STARTTLS on the submission port (587), required.
    #[default]
    Starttls,
    /// Implicit TLS (port 465).
    Tls,
    /// No TLS: only for a relay on the same host or a local test server (Mailpit). Refused
    /// with credentials unless the host is a loopback address.
    None,
}

/// One `[[sink]]` block as written. Unknown keys are refused, so a typo is not silently a
/// sink that never sends.
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct SinkFile {
    name: String,
    kind: SinkKind,
    #[serde(default)]
    repos: Vec<String>,
    #[serde(default)]
    events: Vec<String>,
    max_per_minute: Option<u32>,
    // discord, slack
    url: Option<String>,
    // matrix
    homeserver: Option<String>,
    room: Option<String>,
    access_token: Option<String>,
    // ntfy
    server: Option<String>,
    topic: Option<String>,
    token: Option<String>,
    priority: Option<u8>,
    // smtp
    host: Option<String>,
    port: Option<u16>,
    tls: Option<SmtpTls>,
    username: Option<String>,
    password: Option<String>,
    from: Option<String>,
    #[serde(default)]
    to: Vec<String>,
}

impl std::fmt::Debug for SinkFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SinkFile")
            .field("name", &self.name)
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

/// Where a sink sends. `Debug` shows no secret.
#[derive(Clone)]
pub enum SinkTarget {
    /// A Discord webhook URL (the URL is the credential).
    Discord {
        /// The webhook URL.
        url: Secret,
    },
    /// A Slack incoming-webhook URL (the URL is the credential).
    Slack {
        /// The webhook URL.
        url: Secret,
    },
    /// A Matrix room.
    Matrix {
        /// The homeserver's client API base, e.g. `https://matrix.org`.
        homeserver: url::Url,
        /// The room id (`!abc:example.org`).
        room: String,
        /// The bot account's access token.
        token: Secret,
    },
    /// An ntfy topic.
    Ntfy {
        /// The server, e.g. `https://ntfy.sh`.
        server: url::Url,
        /// The topic (on a public server, whoever knows it can read it: keep it secret).
        topic: Secret,
        /// An access token, for a server with access control.
        token: Option<Secret>,
        /// ntfy priority 1..=5.
        priority: Option<u8>,
    },
    /// Email.
    Smtp(SmtpTarget),
}

/// An SMTP sink's server and addresses.
#[derive(Clone)]
pub struct SmtpTarget {
    /// The SMTP server host.
    pub host: String,
    /// Its port.
    pub port: u16,
    /// How the connection is secured.
    pub tls: SmtpTls,
    /// Username and password, if the server wants them.
    pub credentials: Option<(String, Secret)>,
    /// The sender.
    pub from: Mailbox,
    /// The recipients.
    pub to: Vec<Mailbox>,
}

impl std::fmt::Debug for SinkTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Discord { .. } => f.write_str("Discord([redacted])"),
            Self::Slack { .. } => f.write_str("Slack([redacted])"),
            Self::Matrix { homeserver, .. } => write!(
                f,
                "Matrix({}, [redacted])",
                homeserver.origin().ascii_serialization()
            ),
            Self::Ntfy { server, .. } => {
                write!(
                    f,
                    "Ntfy({}, [redacted])",
                    server.origin().ascii_serialization()
                )
            }
            Self::Smtp(t) => write!(
                f,
                "Smtp({}:{}, {:?}, {} recipients)",
                t.host,
                t.port,
                t.tls,
                t.to.len()
            ),
        }
    }
}

/// A resolved sink: its secrets read, its addresses parsed.
#[derive(Debug, Clone)]
pub struct SinkSpec {
    /// The sink's name (for logs).
    pub name: String,
    /// The kind.
    pub kind: SinkKind,
    /// `owner/name` or repo ids this sink wants (watched for it); empty = every served repo.
    pub repos: Vec<String>,
    /// The events it wants; empty or `*` = all.
    pub events: Vec<String>,
    /// Sends per minute at most.
    pub max_per_minute: u32,
    /// Where it sends.
    pub target: SinkTarget,
}

fn config_err(name: &str, why: impl std::fmt::Display) -> RelayError {
    RelayError::Config(format!("[[sink]] {name}: {why}"))
}

/// Resolve a secret reference (`env:` / `keychain:`). Errors name the field, never a value.
fn secret(name: &str, field: &str, raw: Option<String>) -> Result<Secret> {
    let raw = raw.ok_or_else(|| config_err(name, format!("needs {field}")))?;
    let r: SecretRef = raw.parse().map_err(|_| {
        config_err(
            name,
            format!(
                "{field} must be a secret reference (env:VAR or keychain:<service>/<account>), \
                 not the value"
            ),
        )
    })?;
    r.resolve()
        .map_err(|e| config_err(name, format!("{field}: {e}")))
}

/// A value that may be given plainly or as a secret reference (an ntfy topic).
fn maybe_secret(name: &str, field: &str, raw: Option<String>) -> Result<Secret> {
    match raw {
        Some(r) if r.starts_with("env:") || r.starts_with("keychain:") => {
            secret(name, field, Some(r))
        }
        Some(r) => Ok(Secret::new(r)),
        None => Err(config_err(name, format!("needs {field}"))),
    }
}

/// Whether `host` is a loopback name or address.
pub fn is_loopback_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    h.eq_ignore_ascii_case("localhost")
        || h.parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// An `https` URL, or `http` to a loopback host (a local test), with no userinfo.
fn web_url(name: &str, field: &str, raw: &str) -> Result<url::Url> {
    let u = url::Url::parse(raw).map_err(|_| config_err(name, format!("{field} is not a URL")))?;
    let local = u.host_str().is_some_and(is_loopback_host);
    if !(u.scheme() == "https" || (u.scheme() == "http" && local)) {
        return Err(config_err(
            name,
            format!("{field} must be https (http only to localhost, for tests)"),
        ));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(config_err(
            name,
            format!("{field} must not carry a user or password"),
        ));
    }
    Ok(u)
}

fn check_events(events: &[String], what: &str) -> Result<()> {
    for e in events {
        if e != "*" && !ALL_EVENTS.contains(&e.as_str()) {
            return Err(RelayError::Config(format!(
                "{what}: unknown event {e:?} (one of {})",
                ALL_EVENTS.join(", ")
            )));
        }
    }
    Ok(())
}

impl SinkFile {
    /// Refuse a field that the sink's kind does not use (a Matrix token on a Slack sink is a
    /// mistake, not something to ignore).
    fn check_fields(&self, name: &str) -> Result<()> {
        let kind = self.kind;
        let used: [(&str, bool); 15] = [
            ("url", self.url.is_some()),
            ("homeserver", self.homeserver.is_some()),
            ("room", self.room.is_some()),
            ("access-token", self.access_token.is_some()),
            ("server", self.server.is_some()),
            ("topic", self.topic.is_some()),
            ("token", self.token.is_some()),
            ("priority", self.priority.is_some()),
            ("host", self.host.is_some()),
            ("port", self.port.is_some()),
            ("tls", self.tls.is_some()),
            ("username", self.username.is_some()),
            ("password", self.password.is_some()),
            ("from", self.from.is_some()),
            ("to", !self.to.is_empty()),
        ];
        let allowed: &[&str] = match kind {
            SinkKind::Discord | SinkKind::Slack => &["url"],
            SinkKind::Matrix => &["homeserver", "room", "access-token"],
            SinkKind::Ntfy => &["server", "topic", "token", "priority"],
            SinkKind::Smtp => &["host", "port", "tls", "username", "password", "from", "to"],
        };
        if let Some((field, _)) = used.iter().find(|(f, set)| *set && !allowed.contains(f)) {
            return Err(config_err(
                name,
                format!("a {} sink has no {field}", kind.as_str()),
            ));
        }
        Ok(())
    }

    /// Check the block and read its secrets.
    pub fn resolve(self) -> Result<SinkSpec> {
        let name = self.name.trim().to_string();
        if name.is_empty() || name.chars().count() > 64 {
            return Err(RelayError::Config(
                "[[sink]] needs a name of 1 to 64 characters".into(),
            ));
        }
        check_events(&self.events, &format!("[[sink]] {name}"))?;
        let max_per_minute = self.max_per_minute.unwrap_or(DEFAULT_PER_MINUTE);
        if !(1..=600).contains(&max_per_minute) {
            return Err(config_err(&name, "max-per-minute must be 1 to 600"));
        }
        let kind = self.kind;
        self.check_fields(&name)?;
        let target = match kind {
            SinkKind::Discord | SinkKind::Slack => {
                let url = secret(&name, "url", self.url)?;
                web_url(&name, "url", url.expose())?;
                if kind == SinkKind::Discord {
                    SinkTarget::Discord { url }
                } else {
                    SinkTarget::Slack { url }
                }
            }
            SinkKind::Matrix => {
                let hs = self
                    .homeserver
                    .ok_or_else(|| config_err(&name, "needs homeserver"))?;
                let room = self.room.ok_or_else(|| config_err(&name, "needs room"))?;
                // `!opaque:server`, or `!opaque` alone from room version 12 on.
                if room.len() < 2
                    || room.len() > 255
                    || !room.starts_with('!')
                    || room
                        .chars()
                        .any(|c| c.is_whitespace() || c.is_control() || c == '/')
                {
                    return Err(config_err(
                        &name,
                        "room must be a room id (!abc:example.org), not an alias",
                    ));
                }
                SinkTarget::Matrix {
                    homeserver: web_url(&name, "homeserver", &hs)?,
                    room,
                    token: secret(&name, "access-token", self.access_token)?,
                }
            }
            SinkKind::Ntfy => {
                let server = self.server.unwrap_or_else(|| "https://ntfy.sh".to_string());
                let topic = maybe_secret(&name, "topic", self.topic)?;
                let t = topic.expose();
                if t.is_empty()
                    || t.len() > 64
                    || !t
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                {
                    return Err(config_err(
                        &name,
                        "topic must be 1 to 64 letters, digits, '-' or '_'",
                    ));
                }
                if self.priority.is_some_and(|p| !(1..=5).contains(&p)) {
                    return Err(config_err(&name, "priority must be 1 to 5"));
                }
                SinkTarget::Ntfy {
                    server: web_url(&name, "server", &server)?,
                    topic,
                    token: self
                        .token
                        .map(|t| secret(&name, "token", Some(t)))
                        .transpose()?,
                    priority: self.priority,
                }
            }
            SinkKind::Smtp => SinkTarget::Smtp(smtp_target(
                &name,
                self.host,
                self.port,
                self.tls,
                self.username,
                self.password,
                self.from.as_deref(),
                &self.to,
            )?),
        };
        Ok(SinkSpec {
            name,
            kind,
            repos: self.repos,
            events: self.events,
            max_per_minute,
            target,
        })
    }
}

/// An `smtp` sink's server and addresses, checked.
#[allow(clippy::too_many_arguments)]
fn smtp_target(
    name: &str,
    host: Option<String>,
    port: Option<u16>,
    tls: Option<SmtpTls>,
    username: Option<String>,
    password: Option<String>,
    from: Option<&str>,
    to: &[String],
) -> Result<SmtpTarget> {
    let host = host.ok_or_else(|| config_err(name, "needs host"))?;
    let tls = tls.unwrap_or_default();
    let port = port.unwrap_or(match tls {
        SmtpTls::Starttls => 587,
        SmtpTls::Tls => 465,
        SmtpTls::None => 25,
    });
    let credentials = match (username, password) {
        (Some(u), p @ Some(_)) => Some((u, secret(name, "password", p)?)),
        (None, None) => None,
        _ => return Err(config_err(name, "username and password go together")),
    };
    if tls == SmtpTls::None && credentials.is_some() && !is_loopback_host(&host) {
        return Err(config_err(
            name,
            "tls = \"none\" would send the password in the clear",
        ));
    }
    let mailbox = |field: &str, s: &str| -> Result<Mailbox> {
        s.parse()
            .map_err(|_| config_err(name, format!("{field}: not an email address")))
    };
    let from = mailbox("from", from.ok_or_else(|| config_err(name, "needs from"))?)?;
    if to.is_empty() || to.len() > 50 {
        return Err(config_err(name, "needs 1 to 50 addresses in to"));
    }
    let to = to
        .iter()
        .map(|s| mailbox("to", s))
        .collect::<Result<Vec<_>>>()?;
    Ok(SmtpTarget {
        host,
        port,
        tls,
        credentials,
        from,
        to,
    })
}

/// `[watch]` as written.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct WatchFile {
    #[serde(default)]
    repos: Vec<String>,
    identity: Option<String>,
    #[serde(default)]
    events: Vec<String>,
}

/// Watch mode: repositories the relay polls with no `webhook` document, for its sinks.
#[derive(Debug, Clone, Default)]
pub struct WatchConfig {
    /// `owner/name` or repo ids.
    pub repos: Vec<String>,
    /// An identity (id or DPNS name) whose public `watch` documents add repositories,
    /// re-read at every discovery.
    pub identity: Option<String>,
    /// The events polled for (empty = all).
    pub events: Vec<String>,
}

impl WatchFile {
    /// Check the block.
    pub fn resolve(self) -> Result<WatchConfig> {
        if self.repos.is_empty() && self.identity.is_none() {
            return Err(RelayError::Config("[watch] needs repos or identity".into()));
        }
        check_events(&self.events, "[watch]")?;
        Ok(WatchConfig {
            repos: self.repos,
            identity: self.identity,
            events: self.events,
        })
    }
}

/// DPNS names of identities, for display, cached (an hour when found, ten minutes when not).
pub struct NameCache {
    client: Arc<PlatformClient>,
    cache: Mutex<HashMap<String, (Option<String>, Instant)>>,
}

const NAME_TTL: Duration = Duration::from_secs(3600);
const NO_NAME_TTL: Duration = Duration::from_secs(600);
const NAME_CACHE_MAX: usize = 10_000;
/// How long one DPNS name read may take before the id shows bare.
const NAME_READ_DEADLINE: Duration = Duration::from_secs(5);

impl NameCache {
    /// A cache reading through `client`.
    pub fn new(client: Arc<PlatformClient>) -> Self {
        Self {
            client,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// The DPNS names of those of `ids` that have one (`alice.dash`).
    pub async fn names(&self, ids: &[String]) -> BTreeMap<String, String> {
        let now = Instant::now();
        let mut out = BTreeMap::new();
        let mut missing = Vec::new();
        {
            let cache = lock(&self.cache);
            for id in ids {
                match cache.get(id) {
                    Some((name, at))
                        if now.duration_since(*at)
                            < if name.is_some() {
                                NAME_TTL
                            } else {
                                NO_NAME_TTL
                            } =>
                    {
                        if let Some(n) = name {
                            out.insert(id.clone(), n.clone());
                        }
                    }
                    _ => missing.push(id.clone()),
                }
            }
        }
        if missing.is_empty() {
            return out;
        }
        // One at a time, each bounded: an event names a handful of ids, and most are cached.
        // (`PlatformClient::dpns_first_names` is not used: its stream is not `Send` for the
        // spawned sink worker.)
        let mut found = BTreeMap::new();
        for id in &missing {
            if let Ok(Ok(names)) =
                tokio::time::timeout(NAME_READ_DEADLINE, self.client.dpns_names_of(id)).await
            {
                if let Some(first) = names.into_iter().next() {
                    found.insert(id.clone(), first);
                }
            }
        }
        let mut cache = lock(&self.cache);
        if cache.len() > NAME_CACHE_MAX {
            cache.clear();
        }
        for id in missing {
            let name = found.remove(&id);
            if let Some(n) = &name {
                out.insert(id.clone(), n.clone());
            }
            cache.insert(id, (name, now));
        }
        out
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A started sink: what it wants and its worker's queue.
struct Handle {
    name: String,
    /// Repo ids; empty = the operator's chosen repos ([`SinkHub::set_covered`]).
    repos: BTreeSet<String>,
    events: Vec<String>,
    tx: mpsc::Sender<WebhookEvent>,
    /// When a full queue was last reported (rate-limits the warning).
    full_warned: Mutex<Option<Instant>>,
}

/// The configured sinks, each with its worker.
pub struct SinkHub {
    sinks: Vec<Handle>,
    /// The repos a sink without `repos` gets: those the operator chose, never one served only
    /// for a `webhook` document. Empty until the first discovery sets it.
    covered: Mutex<BTreeSet<String>>,
}

impl SinkHub {
    /// Start a worker per sink. Each sink comes with its `repos` resolved to ids (empty = the
    /// repos of [`SinkHub::set_covered`]). Must run inside a tokio runtime.
    pub fn start(
        sinks: Vec<(SinkSpec, BTreeSet<String>)>,
        names: Option<&Arc<NameCache>>,
    ) -> Result<Self> {
        let http = send::http_client();
        let mut handles = Vec::new();
        for (spec, repo_ids) in sinks {
            let smtp = match &spec.target {
                SinkTarget::Smtp(t) => {
                    Some(send::smtp_transport(t).map_err(|e| config_err(&spec.name, e))?)
                }
                _ => None,
            };
            let (tx, rx) = mpsc::channel(QUEUE_PER_SINK);
            handles.push(Handle {
                name: spec.name.clone(),
                repos: repo_ids,
                events: spec.events.clone(),
                tx,
                full_warned: Mutex::new(None),
            });
            tracing::info!(sink = %spec.name, kind = spec.kind.as_str(), target = ?spec.target, "sink ready");
            let transport = send::Transport {
                http: http.clone(),
                smtp,
            };
            tokio::spawn(run_sink(Arc::new(spec), transport, rx, names.cloned()));
        }
        Ok(Self {
            sinks: handles,
            covered: Mutex::new(BTreeSet::new()),
        })
    }

    /// Whether no sink is configured.
    pub fn is_empty(&self) -> bool {
        self.sinks.is_empty()
    }

    /// Set the repos a sink without `repos` gets: the ones the operator chose (`[watch]`,
    /// `[wake]`, `[[webhook]]`, the sinks' `repos`, an embedder's feed). A repo served only
    /// because a `webhook` document names the relay identity is never among them.
    pub fn set_covered(&self, repos: BTreeSet<String>) {
        *lock(&self.covered) = repos;
    }
}

impl EventSink for SinkHub {
    fn accept(&self, repo_id: &str, event: &WebhookEvent) {
        let covered = lock(&self.covered).contains(repo_id);
        for s in &self.sinks {
            let repo_ok = if s.repos.is_empty() {
                covered
            } else {
                s.repos.contains(repo_id)
            };
            if !repo_ok || !forge_core::webhooks::wants_event(&s.events, event.event) {
                continue;
            }
            if s.tx.try_send(event.clone()).is_err() {
                let mut warned = lock(&s.full_warned);
                if warned.is_none_or(|t| t.elapsed() > Duration::from_secs(60)) {
                    *warned = Some(Instant::now());
                    tracing::warn!(sink = %s.name, repo = %repo_id, "SINK-DROP: the sink's queue is full; dropping events (it is slower than the activity)");
                }
            }
        }
    }
}

/// Wait until a send fits `per_minute` (a sliding one-minute window), then record it.
async fn take_slot(sent: &mut VecDeque<Instant>, per_minute: u32) {
    let window = Duration::from_secs(60);
    while sent.front().is_some_and(|t| t.elapsed() >= window) {
        sent.pop_front();
    }
    if sent.len() >= per_minute as usize {
        if let Some(first) = sent.pop_front() {
            tokio::time::sleep(window.saturating_sub(first.elapsed())).await;
        }
    }
    sent.push_back(Instant::now());
}

/// A stable transaction id for a notice on a sink (Matrix dedupes retries on it).
fn txn_id(sink: &str, notice: &Notice) -> String {
    hex::encode(&Sha256::digest(format!("{sink}\n{}", notice.id))[..16])
}

/// One sink's worker.
async fn run_sink(
    spec: Arc<SinkSpec>,
    transport: send::Transport,
    mut rx: mpsc::Receiver<WebhookEvent>,
    names: Option<Arc<NameCache>>,
) {
    let mut sent = VecDeque::new();
    while let Some(event) = rx.recv().await {
        let resolved = match &names {
            Some(n) => n.names(&render::named_ids(&event)).await,
            None => BTreeMap::new(),
        };
        let Some(notice) = render::render(&event, &resolved) else {
            continue;
        };
        take_slot(&mut sent, spec.max_per_minute).await;
        deliver(&spec, &transport, &notice).await;
    }
}

/// Send `notice`, retrying per [`RETRY_DELAYS`]; logs the outcome. Whether it was delivered.
pub async fn deliver(spec: &SinkSpec, transport: &send::Transport, notice: &Notice) -> bool {
    let txn = txn_id(&spec.name, notice);
    let mut attempt = 0;
    loop {
        match transport.send(&spec.target, &spec.name, notice, &txn).await {
            Ok(()) => {
                tracing::debug!(sink = %spec.name, repo = %notice.repo_id, event = notice.event, "sink delivered");
                return true;
            }
            Err(send::SendError::Retry { after, why }) if attempt < RETRIES => {
                let floor = RETRY_DELAYS[attempt];
                let wait = after.map_or(floor, |a| a.min(MAX_RETRY_AFTER).max(floor));
                tracing::info!(sink = %spec.name, repo = %notice.repo_id, event = notice.event, attempt = attempt + 1, error = %why, "sink send failed; retrying");
                attempt += 1;
                tokio::time::sleep(wait).await;
            }
            Err(e) => {
                tracing::warn!(sink = %spec.name, kind = spec.kind.as_str(), repo = %notice.repo_id, event = notice.event, error = %e, "SINK-DROP: giving up on this notice");
                return false;
            }
        }
    }
}

#[cfg(test)]
mod tests;
