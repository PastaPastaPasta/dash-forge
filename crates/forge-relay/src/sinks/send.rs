//! Each sink's wire format and transport. The bodies are pure functions of a [`Notice`]
//! (tested offline); [`Transport::send`] posts them.
//!
//! | Kind | Request | Docs |
//! |---|---|---|
//! | `discord` | `POST <webhook url>?wait=true`, `{"embeds": [...], "allowed_mentions": {"parse": []}}` | Discord "Execute Webhook" |
//! | `slack` | `POST <incoming webhook url>`, `{"text": ..., "unfurl_links": false}` | Slack "Sending messages using incoming webhooks" |
//! | `matrix` | `PUT /_matrix/client/v3/rooms/{room}/send/m.room.message/{txnId}` with a bearer token, an `m.notice` | Matrix client-server API v1.x |
//! | `ntfy` | `POST <server>/` with ntfy's JSON body (`topic`, `title`, `message`, `click`) | ntfy "Publish as JSON" |
//! | `smtp` | a text/plain message over SMTP (STARTTLS, implicit TLS, or plain on a local relay) | RFC 5321 / 5322 |
//!
//! No sink can ping anyone: Discord's `allowed_mentions` is empty, Slack's `<`, `>` and `&`
//! are escaped so `<!channel>` is literal, and Matrix's `m.mentions` is empty (intentional
//! mentions, Matrix v1.7), so a title that spells a name or `@room` notifies nobody.
//!
//! Errors never carry a URL (a Discord or Slack URL is the credential): reqwest's errors are
//! stripped with `without_url`, and only the HTTP status is reported.

use std::time::Duration;

use lettre::message::header::{ContentType, HeaderName, HeaderValue};
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde_json::{json, Value};

use super::render::Notice;
use super::{SinkTarget, SmtpTarget, SmtpTls};

/// A send that failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    /// Worth retrying (a 5xx, 408, 429, a timeout, a connection error), after `after` when the
    /// receiver said (`Retry-After`).
    Retry {
        /// The receiver's `Retry-After`, if any.
        after: Option<Duration>,
        /// What happened (no URL, no secret).
        why: String,
    },
    /// Retrying cannot fix it (a 4xx: a revoked token, a deleted webhook, a bad room).
    Permanent(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Retry { why, .. } => write!(f, "{why} (retrying)"),
            Self::Permanent(why) => write!(f, "{why} (not retried)"),
        }
    }
}

/// Discord's limits: an embed title of 256 characters, a description of 4096.
const DISCORD_TITLE: usize = 256;

/// A Discord webhook body: one embed (title linking the page, the excerpt, the repo).
pub fn discord_body(n: &Notice) -> Value {
    let mut embed = json!({
        "title": cut(&n.title, DISCORD_TITLE),
        "url": n.url,
        "footer": { "text": n.repo },
    });
    if !n.excerpt.is_empty() {
        embed["description"] = Value::String(discord_escape(&n.excerpt));
    }
    json!({
        "username": "Dash Forge",
        "embeds": [embed],
        "allowed_mentions": { "parse": [] },
    })
}

/// Escape Discord markdown in text written by others, so it shows as typed.
fn discord_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if matches!(
            c,
            '\\' | '*' | '_' | '~' | '`' | '|' | '>' | '#' | '[' | ']' | '<' | '@'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Slack's three escapes: `&`, `<`, `>` (so `<!channel>` and `<url|text>` from a title are
/// literal).
fn slack_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// A Slack incoming-webhook body: a linked title and a quoted excerpt.
pub fn slack_body(n: &Notice) -> Value {
    let mut text = format!(
        "<{}|{}>  ·  {}",
        slack_escape(&n.url).replace('|', "%7C"),
        slack_escape(&n.title),
        slack_escape(&n.repo)
    );
    if !n.excerpt.is_empty() {
        for line in n.excerpt.lines() {
            text.push_str("\n>");
            text.push_str(&slack_escape(line));
        }
    }
    json!({ "text": text, "unfurl_links": false, "unfurl_media": false })
}

/// HTML escape for Matrix's `formatted_body`.
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// A Matrix `m.notice` (a bot message: clients do not notify for it by default).
pub fn matrix_body(n: &Notice) -> Value {
    let mut body = format!("{} ({})\n{}", n.title, n.repo, n.url);
    let mut html = format!(
        "<a href=\"{}\">{}</a> ({})",
        html_escape(&n.url),
        html_escape(&n.title),
        html_escape(&n.repo)
    );
    if !n.excerpt.is_empty() {
        body.push_str("\n\n");
        body.push_str(&n.excerpt);
        html.push_str("<blockquote>");
        html.push_str(&html_escape(&n.excerpt).replace('\n', "<br>"));
        html.push_str("</blockquote>");
    }
    json!({
        "msgtype": "m.notice",
        "body": body,
        "format": "org.matrix.custom.html",
        "formatted_body": html,
        "m.mentions": {},
    })
}

/// An ntfy JSON publish body.
pub fn ntfy_body(n: &Notice, topic: &str, priority: Option<u8>) -> Value {
    let mut v = json!({
        "topic": topic,
        "title": cut(&format!("{}: {}", n.repo, n.event_label()), 250),
        "message": if n.excerpt.is_empty() { n.title.clone() } else { format!("{}\n\n{}", n.title, n.excerpt) },
        "click": n.url,
        "tags": ["dash-forge"],
    });
    if let Some(p) = priority {
        v["priority"] = Value::from(p);
    }
    v
}

/// An email's subject and text body.
pub fn email_text(n: &Notice, footer: &str) -> (String, String) {
    let subject = cut(&format!("[{}] {}", n.repo, n.title), 180);
    let mut body = format!("{}\n\n{}\n", n.title, n.url);
    if !n.excerpt.is_empty() {
        body.push('\n');
        for line in n.excerpt.lines() {
            body.push_str("> ");
            body.push_str(line);
            body.push('\n');
        }
    }
    body.push_str("\n-- \n");
    body.push_str(footer);
    body.push('\n');
    (subject, body)
}

impl Notice {
    /// A short label of the event for a push title (`pull request #12`, `push`, `release`).
    pub fn event_label(&self) -> String {
        match self.thread {
            Some((true, n)) => format!("pull request #{n}"),
            Some((false, n)) => format!("issue #{n}"),
            None => self.event.replace('_', " "),
        }
    }
}

/// `s` cut to `max` characters, with an ellipsis.
fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// `Auto-Submitted: auto-generated` (RFC 3834): no auto-replies to a notification.
#[derive(Debug, Clone)]
pub struct AutoSubmitted;

impl lettre::message::header::Header for AutoSubmitted {
    fn name() -> HeaderName {
        HeaderName::new_from_ascii_str("Auto-Submitted")
    }

    fn parse(_: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self)
    }

    fn display(&self) -> HeaderValue {
        HeaderValue::new(Self::name(), "auto-generated".to_string())
    }
}

/// An SMTP transport for `t`.
pub fn smtp_transport(t: &SmtpTarget) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let builder = match t.tls {
        SmtpTls::Starttls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&t.host)
            .map_err(|e| format!("smtp {}: {e}", t.host))?,
        SmtpTls::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&t.host)
            .map_err(|e| format!("smtp {}: {e}", t.host))?,
        SmtpTls::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&t.host),
    };
    let mut builder = builder.port(t.port).timeout(Some(Duration::from_secs(20)));
    if let Some((user, pass)) = &t.credentials {
        builder = builder.credentials(Credentials::new(user.clone(), pass.expose().to_string()));
    }
    Ok(builder.build())
}

/// Send `message` over `smtp`, classifying the failure.
pub async fn smtp_send(
    smtp: &AsyncSmtpTransport<Tokio1Executor>,
    message: Message,
) -> Result<(), SendError> {
    match smtp.send(message).await {
        Ok(_) => Ok(()),
        Err(e) if e.is_permanent() => Err(SendError::Permanent(format!(
            "smtp refused the message: {}",
            e.status()
                .map_or_else(|| "permanent error".to_string(), |c| c.to_string())
        ))),
        Err(e) => Err(SendError::Retry {
            after: None,
            why: format!("smtp: {}", smtp_reason(&e)),
        }),
    }
}

/// An SMTP error in a few words (no addresses).
fn smtp_reason(e: &lettre::transport::smtp::Error) -> String {
    if e.is_timeout() {
        "timed out".into()
    } else if e.is_transient() {
        format!(
            "temporary failure {}",
            e.status().map_or_else(String::new, |c| c.to_string())
        )
    } else if e.is_tls() {
        "TLS failure".into()
    } else {
        "connection failed".into()
    }
}

/// Build an email for `n` to `to`.
pub fn email_message(
    t: &SmtpTarget,
    to: &[Mailbox],
    n: &Notice,
    footer: &str,
) -> Result<Message, SendError> {
    let (subject, text) = email_text(n, footer);
    let mut b = Message::builder()
        .from(t.from.clone())
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .header(AutoSubmitted);
    for m in to {
        b = b.to(m.clone());
    }
    b.body(text)
        .map_err(|e| SendError::Permanent(format!("building the message: {e}")))
}

/// Classify an HTTP answer.
fn http_outcome(resp: &reqwest::Response) -> Result<(), SendError> {
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    let after = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s >= 0.0)
        .map(|s| Duration::from_secs_f64(s.min(3600.0)));
    let why = format!("HTTP {}", status.as_u16());
    if status.as_u16() == 429 || status.as_u16() == 408 || status.is_server_error() {
        Err(SendError::Retry { after, why })
    } else {
        Err(SendError::Permanent(why))
    }
}

/// A reqwest error, without its URL (which may be the credential).
fn http_error(e: reqwest::Error) -> SendError {
    let e = e.without_url();
    let why = if e.is_timeout() {
        "timed out".to_string()
    } else if e.is_connect() {
        "connection failed".to_string()
    } else {
        format!("request failed: {e}")
    };
    SendError::Retry { after: None, why }
}

/// The client every HTTP sink shares: rustls, no redirects (a redirect would carry a token to
/// another host), a 15 s budget per request.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .user_agent(concat!(
            "forge-relay/",
            env!("CARGO_PKG_VERSION"),
            " (sinks)"
        ))
        .build()
        .expect("a reqwest client with static settings builds")
}

/// What one sink sends through.
pub struct Transport {
    /// The shared HTTP client.
    pub http: reqwest::Client,
    /// The SMTP transport (`smtp` sinks).
    pub smtp: Option<AsyncSmtpTransport<Tokio1Executor>>,
}

impl Transport {
    /// Send `n` to `target`. `sink` names the sink in an email footer; `txn` is a stable id for
    /// the notice (Matrix deduplicates retries on it).
    pub async fn send(
        &self,
        target: &SinkTarget,
        sink: &str,
        n: &Notice,
        txn: &str,
    ) -> Result<(), SendError> {
        let resp = match target {
            SinkTarget::Discord { url } => {
                let mut u = url::Url::parse(url.expose())
                    .map_err(|_| SendError::Permanent("the Discord URL does not parse".into()))?;
                u.query_pairs_mut().append_pair("wait", "true");
                self.http.post(u).json(&discord_body(n)).send().await
            }
            SinkTarget::Slack { url } => {
                self.http
                    .post(url.expose())
                    .json(&slack_body(n))
                    .send()
                    .await
            }
            SinkTarget::Matrix {
                homeserver,
                room,
                token,
            } => {
                let mut u = homeserver.clone();
                u.path_segments_mut()
                    .map_err(|()| SendError::Permanent("bad homeserver URL".into()))?
                    .pop_if_empty()
                    .extend([
                        "_matrix",
                        "client",
                        "v3",
                        "rooms",
                        room,
                        "send",
                        "m.room.message",
                        txn,
                    ]);
                self.http
                    .put(u)
                    .bearer_auth(token.expose())
                    .json(&matrix_body(n))
                    .send()
                    .await
            }
            SinkTarget::Ntfy {
                server,
                topic,
                token,
                priority,
            } => {
                let mut req =
                    self.http
                        .post(server.clone())
                        .json(&ntfy_body(n, topic.expose(), *priority));
                if let Some(t) = token {
                    req = req.bearer_auth(t.expose());
                }
                req.send().await
            }
            SinkTarget::Smtp(t) => {
                let smtp = self
                    .smtp
                    .as_ref()
                    .ok_or_else(|| SendError::Permanent("no SMTP transport".into()))?;
                let footer = format!(
                    "Sent by a forge-relay sink ({sink}). Its operator configures it in relay.toml."
                );
                let message = email_message(t, &t.to, n, &footer)?;
                return smtp_send(smtp, message).await;
            }
        };
        http_outcome(&resp.map_err(http_error)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice() -> Notice {
        Notice {
            repo_id: "R".into(),
            repo: "alice/x".into(),
            event: "issue_comment",
            action: "created".into(),
            actor: "A".into(),
            title: "bob commented on issue #3: <!channel> & @everyone".into(),
            excerpt: "line *one*\n@here [link](http://evil)".into(),
            url: "https://forge.example/repo/issue/?owner=O&name=x&number=3".into(),
            thread: Some((false, 3)),
            id: "issue_comment:C".into(),
        }
    }

    #[test]
    fn discord_never_pings_and_escapes_markdown() {
        let b = discord_body(&notice());
        assert_eq!(b["allowed_mentions"]["parse"], json!([]));
        let d = b["embeds"][0]["description"].as_str().unwrap();
        assert!(
            d.contains("\\*one\\*") && d.contains("\\@here") && d.contains("\\[link\\]"),
            "{d}"
        );
        assert_eq!(b["embeds"][0]["url"], notice().url);
    }

    #[test]
    fn slack_escapes_its_control_sequences() {
        let t = slack_body(&notice())["text"].as_str().unwrap().to_string();
        assert!(t.contains("&lt;!channel&gt; &amp; @everyone"), "{t}");
        assert!(
            t.starts_with("<https://forge.example/repo/issue/?owner=O&amp;name=x&amp;number=3|")
        );
        assert!(t.contains("\n>line *one*"));
    }

    #[test]
    fn matrix_is_a_notice_with_no_mentions() {
        let b = matrix_body(&notice());
        assert_eq!(b["msgtype"], "m.notice");
        assert_eq!(b["m.mentions"], json!({}));
        let html = b["formatted_body"].as_str().unwrap();
        assert!(
            html.contains("&lt;!channel&gt;") && !html.contains("<!channel>"),
            "{html}"
        );
    }

    #[test]
    fn ntfy_and_email_bodies() {
        let b = ntfy_body(&notice(), "topic-x", Some(4));
        assert_eq!(b["topic"], "topic-x");
        assert_eq!(b["click"], notice().url);
        assert_eq!(b["priority"], 4);
        assert_eq!(b["title"], "alice/x: issue #3");
        let (subject, text) = email_text(&notice(), "footer");
        assert!(subject.starts_with("[alice/x] bob commented"));
        assert!(text.contains("\n> line *one*\n"));
        assert!(text.ends_with("-- \nfooter\n"));
    }
}
