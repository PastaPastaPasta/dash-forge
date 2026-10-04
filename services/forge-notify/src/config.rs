//! Configuration: every setting is a flag and an environment variable (`FORGE_NOTIFY_*`), so a
//! container needs no config file. Secrets come from the environment or from a file (`*_FILE`,
//! for Docker or systemd credentials), never from a flag.

use crate::limits::TrustProxy;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use clap::Args;
use lettre::message::Mailbox;
use zeroize::Zeroizing;

use forge_core::network::NetworkSettings;
use forge_relay::sinks::{is_loopback_host, SmtpTarget, SmtpTls};

use crate::error::{NotifyError, Result};

/// The push services a browser subscribes with (Chrome/Edge via FCM, Firefox, Safari, Windows).
/// A push endpoint is a URL the browser gives us; only these hosts (and their subdomains) are
/// posted to, so a subscription cannot point the service at an arbitrary server.
pub const DEFAULT_PUSH_HOSTS: &[&str] = &[
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.apple.com",
    "notify.windows.com",
];

/// `forge-notify serve` settings.
#[derive(Debug, Clone, Args)]
#[allow(clippy::struct_excessive_bools)]
pub struct ServeArgs {
    /// Address to listen on (put a TLS proxy in front).
    #[arg(long, env = "FORGE_NOTIFY_LISTEN", default_value = "0.0.0.0:8080")]
    pub listen: SocketAddr,
    /// This service's public base URL, used in mail links (`https://notify.example.org`).
    #[arg(long, env = "FORGE_NOTIFY_PUBLIC_URL")]
    pub public_url: String,
    /// The forge-web origin notices link to (include a sub-path deploy's base path).
    #[arg(
        long,
        env = "FORGE_NOTIFY_WEB_URL",
        default_value = "https://forge.dashhq.org"
    )]
    pub web_url: String,
    /// The operator name signed requests must carry (default: the public URL's host).
    #[arg(long, env = "FORGE_NOTIFY_OPERATOR")]
    pub operator: Option<String>,
    /// Origins allowed to call the API from a browser, comma-separated (default: the web URL's
    /// origin).
    #[arg(long, env = "FORGE_NOTIFY_ALLOWED_ORIGINS", value_delimiter = ',')]
    pub allowed_origins: Vec<String>,
    /// Where the SQLite store lives.
    #[arg(long, env = "FORGE_NOTIFY_DATA_DIR", default_value = "/data")]
    pub data_dir: PathBuf,
    /// A link to the operator's privacy notice, shown before anyone subscribes.
    #[arg(long, env = "FORGE_NOTIFY_PRIVACY_URL")]
    pub privacy_url: Option<String>,
    /// The operator's contact address, shown in mail footers and `/v1/info`.
    #[arg(long, env = "FORGE_NOTIFY_CONTACT")]
    pub contact: Option<String>,

    /// The Dash network (testnet, mainnet or devnet).
    #[arg(long, env = "FORGE_NOTIFY_NETWORK")]
    pub network: Option<String>,
    /// The devnet name (with `--network devnet`).
    #[arg(long, env = "FORGE_NOTIFY_DEVNET_NAME")]
    pub devnet_name: Option<String>,
    /// Devnet DAPI addresses, comma-separated.
    #[arg(long, env = "FORGE_NOTIFY_DAPI_ADDRESSES")]
    pub dapi_addresses: Option<String>,
    /// Seconds between polls of the watched repositories.
    #[arg(long, env = "FORGE_NOTIFY_POLL_SECS", default_value_t = 15)]
    pub poll_secs: u64,
    /// Seconds between rebuilds of each subscriber's repositories and addressed-event polls.
    #[arg(long, env = "FORGE_NOTIFY_INDEX_SECS", default_value_t = 900)]
    pub index_secs: u64,
    /// Seconds between polls of review requests and assignments (any repository).
    #[arg(long, env = "FORGE_NOTIFY_ADDRESSED_SECS", default_value_t = 120)]
    pub addressed_secs: u64,

    /// SMTP server (unset: no email; push only).
    #[arg(long, env = "FORGE_NOTIFY_SMTP_HOST")]
    pub smtp_host: Option<String>,
    /// SMTP port (default: 587 for starttls, 465 for tls, 25 for none).
    #[arg(long, env = "FORGE_NOTIFY_SMTP_PORT")]
    pub smtp_port: Option<u16>,
    /// starttls, tls or none (none: a local relay or a test server only).
    #[arg(long, env = "FORGE_NOTIFY_SMTP_TLS", default_value = "starttls")]
    pub smtp_tls: String,
    /// SMTP username.
    #[arg(long, env = "FORGE_NOTIFY_SMTP_USERNAME")]
    pub smtp_username: Option<String>,
    /// The sender, e.g. `Dash Forge <notify@example.org>`.
    #[arg(long, env = "FORGE_NOTIFY_MAIL_FROM")]
    pub mail_from: Option<String>,
    /// The VAPID subject (`mailto:` or `https:`) push services may contact.
    #[arg(long, env = "FORGE_NOTIFY_VAPID_SUBJECT")]
    pub vapid_subject: Option<String>,
    /// Push service hosts allowed as endpoints, comma-separated (default: the major browsers').
    #[arg(long, env = "FORGE_NOTIFY_PUSH_HOSTS", value_delimiter = ',')]
    pub push_hosts: Vec<String>,

    /// The hour (UTC, 0-23) daily digests are sent.
    #[arg(long, env = "FORGE_NOTIFY_DIGEST_HOUR", default_value_t = 8)]
    pub digest_hour: u8,
    /// The most subscribers this service takes.
    #[arg(long, env = "FORGE_NOTIFY_MAX_SUBSCRIBERS", default_value_t = 10_000)]
    pub max_subscribers: u64,
    /// The most repositories followed per subscriber (watched, owned and member).
    #[arg(long, env = "FORGE_NOTIFY_MAX_REPOS_PER_USER", default_value_t = 50)]
    pub max_repos_per_user: usize,
    /// The most repositories followed in total.
    #[arg(long, env = "FORGE_NOTIFY_MAX_REPOS", default_value_t = 2_000)]
    pub max_repos: usize,
    /// Mails and pushes sent per day, in total (a global spam and cost ceiling).
    #[arg(long, env = "FORGE_NOTIFY_DAILY_SEND_BUDGET", default_value_t = 20_000)]
    pub daily_send_budget: u64,
    /// Notices sent per subscriber per day (more go into the next digest).
    #[arg(long, env = "FORGE_NOTIFY_PER_USER_DAILY", default_value_t = 200)]
    pub per_user_daily: u64,
    /// API requests per minute per client address.
    #[arg(long, env = "FORGE_NOTIFY_PER_IP_PER_MINUTE", default_value_t = 60)]
    pub per_ip_per_minute: u32,
    /// Where the client address comes from: `none` (the socket peer), `cloudflare`
    /// (`CF-Connecting-IP`, behind a Cloudflare tunnel or proxy only) or `forwarded` (the last
    /// `X-Forwarded-For` entry, the one the proxy in front appended).
    #[arg(long, env = "FORGE_NOTIFY_TRUST_PROXY", value_enum, default_value_t = TrustProxy::None)]
    pub trust_proxy: TrustProxy,
    /// Allow http and loopback endpoints and origins (local tests only).
    #[arg(long, env = "FORGE_NOTIFY_INSECURE_LOCAL", default_value_t = false)]
    pub insecure_local: bool,
}

/// Read a secret from `VAR`, or from the file `VAR_FILE` names. Never from a flag. An empty
/// value or file counts as unset (so a compose file can mount an empty secret to turn a channel
/// off).
pub fn secret_env(var: &str) -> Result<Option<Zeroizing<String>>> {
    if let Ok(v) = std::env::var(var) {
        if !v.is_empty() {
            return Ok(Some(Zeroizing::new(v)));
        }
    }
    let file_var = format!("{var}_FILE");
    match std::env::var(&file_var) {
        Ok(path) if !path.is_empty() => {
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| NotifyError::Config(format!("{file_var}: reading the file: {e}")))?;
            let raw = Zeroizing::new(raw);
            let v = raw.trim();
            Ok((!v.is_empty()).then(|| Zeroizing::new(v.to_string())))
        }
        _ => Ok(None),
    }
}

/// The resolved configuration.
#[derive(Clone)]
pub struct Config {
    /// The listen address.
    pub listen: SocketAddr,
    /// This service's public base URL, no trailing slash.
    pub public_url: String,
    /// The forge-web origin, no trailing slash.
    pub web_url: String,
    /// The operator name signed requests carry.
    pub operator: String,
    /// Browser origins allowed by CORS.
    pub allowed_origins: Vec<String>,
    /// The store's directory.
    pub data_dir: PathBuf,
    /// The privacy notice link.
    pub privacy_url: Option<String>,
    /// The operator's contact address.
    pub contact: Option<String>,
    /// The network settings (resolved by the relay's loader).
    pub network: NetworkSettings,
    /// The repo poll interval.
    pub poll_interval: Duration,
    /// The subscriber-index rebuild interval.
    pub index_interval: Duration,
    /// The addressed-event poll interval.
    pub addressed_interval: Duration,
    /// SMTP, when email is on.
    pub smtp: Option<SmtpTarget>,
    /// The VAPID subject, when push is on.
    pub vapid_subject: Option<String>,
    /// Allowed push hosts.
    pub push_hosts: Vec<String>,
    /// The digest hour (UTC).
    pub digest_hour: u8,
    /// Limits.
    pub limits: Limits,
    /// Whether client addresses come from proxy headers.
    pub trust_proxy: TrustProxy,
    /// Local test mode.
    pub insecure_local: bool,
}

/// Quotas and caps.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Subscribers in total.
    pub max_subscribers: u64,
    /// Repositories per subscriber.
    pub max_repos_per_user: usize,
    /// Repositories in total.
    pub max_repos: usize,
    /// Sends per day in total.
    pub daily_send_budget: u64,
    /// Sends per subscriber per day.
    pub per_user_daily: u64,
    /// API requests per minute per address.
    pub per_ip_per_minute: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_subscribers: 10_000,
            max_repos_per_user: 50,
            max_repos: 2_000,
            daily_send_budget: 20_000,
            per_user_daily: 200,
            per_ip_per_minute: 60,
        }
    }
}

/// `url` without a trailing slash, checked: https (or http to loopback in local mode), no
/// userinfo, no query or fragment.
pub fn base_url(field: &str, raw: &str, insecure_local: bool) -> Result<String> {
    let u = url::Url::parse(raw.trim())
        .map_err(|_| NotifyError::Config(format!("{field} is not a URL")))?;
    let local = u.host_str().is_some_and(is_loopback_host);
    if !(u.scheme() == "https" || (u.scheme() == "http" && (local || insecure_local))) {
        return Err(NotifyError::Config(format!(
            "{field} must be https (http only for a local test)"
        )));
    }
    if !u.username().is_empty() || u.password().is_some() || u.query().is_some() {
        return Err(NotifyError::Config(format!(
            "{field} must have no user, password or query"
        )));
    }
    Ok(u.as_str().trim_end_matches('/').to_string())
}

/// A link shown to users (the privacy notice): https (or http to loopback in local mode),
/// so a page can never be handed a `javascript:` or `data:` URL.
pub fn web_link(field: &str, raw: &str, insecure_local: bool) -> Result<String> {
    let u = url::Url::parse(raw.trim())
        .map_err(|_| NotifyError::Config(format!("{field} is not a URL")))?;
    let local = u.host_str().is_some_and(is_loopback_host);
    if !(u.scheme() == "https" || (u.scheme() == "http" && (local || insecure_local))) {
        return Err(NotifyError::Config(format!("{field} must be https")));
    }
    Ok(u.to_string())
}

/// The origin of a base URL (`https://host[:port]`).
pub fn origin_of(base: &str) -> String {
    url::Url::parse(base).map_or_else(|_| base.to_string(), |u| u.origin().ascii_serialization())
}

impl ServeArgs {
    /// Check and resolve the settings, reading the SMTP password from the environment.
    pub fn resolve(self) -> Result<Config> {
        let public_url = base_url(
            "FORGE_NOTIFY_PUBLIC_URL",
            &self.public_url,
            self.insecure_local,
        )?;
        let web_url = base_url("FORGE_NOTIFY_WEB_URL", &self.web_url, self.insecure_local)?;
        let operator = match &self.operator {
            Some(o) => o.trim().to_string(),
            None => url::Url::parse(&public_url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_default(),
        };
        if operator.is_empty() || operator.len() > 100 || operator.contains(['\n', '\r']) {
            return Err(NotifyError::Config(
                "FORGE_NOTIFY_OPERATOR must be 1 to 100 characters on one line".into(),
            ));
        }
        let allowed_origins = if self.allowed_origins.is_empty() {
            vec![origin_of(&web_url)]
        } else {
            self.allowed_origins
                .iter()
                .map(|o| {
                    base_url("FORGE_NOTIFY_ALLOWED_ORIGINS", o, self.insecure_local)
                        .map(|b| origin_of(&b))
                })
                .collect::<Result<Vec<_>>>()?
        };
        let smtp = self.smtp_target()?;
        if let Some(s) = &self.vapid_subject {
            if !(s.starts_with("mailto:") || s.starts_with("https://")) {
                return Err(NotifyError::Config(
                    "FORGE_NOTIFY_VAPID_SUBJECT must be a mailto: or https: URL".into(),
                ));
            }
        }
        if self.digest_hour > 23 {
            return Err(NotifyError::Config(
                "FORGE_NOTIFY_DIGEST_HOUR must be 0 to 23".into(),
            ));
        }
        let push_hosts = if self.push_hosts.is_empty() {
            DEFAULT_PUSH_HOSTS.iter().map(ToString::to_string).collect()
        } else {
            self.push_hosts
                .iter()
                .map(|h| h.trim().to_ascii_lowercase())
                .collect()
        };
        Ok(Config {
            listen: self.listen,
            public_url,
            web_url,
            operator,
            allowed_origins,
            data_dir: self.data_dir,
            privacy_url: match self.privacy_url.as_deref().map(str::trim) {
                Some(p) if !p.is_empty() => Some(web_link(
                    "FORGE_NOTIFY_PRIVACY_URL",
                    p,
                    self.insecure_local,
                )?),
                _ => None,
            },
            contact: self.contact,
            network: NetworkSettings {
                network: self.network,
                devnet_name: self.devnet_name,
                dapi_addresses: self.dapi_addresses,
                quorum_base_url: None,
            },
            poll_interval: Duration::from_secs(self.poll_secs.max(5)),
            index_interval: Duration::from_secs(self.index_secs.max(60)),
            addressed_interval: Duration::from_secs(self.addressed_secs.max(30)),
            smtp,
            vapid_subject: self.vapid_subject,
            push_hosts,
            digest_hour: self.digest_hour,
            limits: Limits {
                max_subscribers: self.max_subscribers,
                max_repos_per_user: self.max_repos_per_user.max(1),
                max_repos: self.max_repos.max(1),
                daily_send_budget: self.daily_send_budget,
                per_user_daily: self.per_user_daily.max(1),
                per_ip_per_minute: self.per_ip_per_minute.max(1),
            },
            trust_proxy: self.trust_proxy,
            insecure_local: self.insecure_local,
        })
    }

    /// The SMTP server, when `FORGE_NOTIFY_SMTP_HOST` is set.
    fn smtp_target(&self) -> Result<Option<SmtpTarget>> {
        let Some(host) = self.smtp_host.clone() else {
            return Ok(None);
        };
        let tls = match self.smtp_tls.as_str() {
            "starttls" => SmtpTls::Starttls,
            "tls" => SmtpTls::Tls,
            "none" => SmtpTls::None,
            _ => {
                return Err(NotifyError::Config(
                    "FORGE_NOTIFY_SMTP_TLS must be starttls, tls or none".into(),
                ))
            }
        };
        let port = self.smtp_port.unwrap_or(match tls {
            SmtpTls::Starttls => 587,
            SmtpTls::Tls => 465,
            SmtpTls::None => 25,
        });
        let password = secret_env("FORGE_NOTIFY_SMTP_PASSWORD")?;
        let credentials = match (&self.smtp_username, password) {
            (Some(u), Some(p)) => Some((
                u.clone(),
                forge_core::keystore::Secret::new(p.as_str().to_string()),
            )),
            (None, None) => None,
            _ => {
                return Err(NotifyError::Config(
                    "FORGE_NOTIFY_SMTP_USERNAME and FORGE_NOTIFY_SMTP_PASSWORD go together".into(),
                ))
            }
        };
        if tls == SmtpTls::None && credentials.is_some() && !is_loopback_host(&host) {
            return Err(NotifyError::Config(
                "FORGE_NOTIFY_SMTP_TLS=none would send the SMTP password in the clear".into(),
            ));
        }
        let from: Mailbox = self
            .mail_from
            .as_deref()
            .ok_or_else(|| NotifyError::Config("email needs FORGE_NOTIFY_MAIL_FROM".into()))?
            .parse()
            .map_err(|_| NotifyError::Config("FORGE_NOTIFY_MAIL_FROM is not an address".into()))?;
        Ok(Some(SmtpTarget {
            host,
            port,
            tls,
            credentials,
            from,
            to: Vec::new(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_urls_are_https_without_userinfo() {
        assert_eq!(
            base_url("x", "https://notify.example.org/", false).unwrap(),
            "https://notify.example.org"
        );
        assert!(base_url("x", "http://notify.example.org", false).is_err());
        assert!(base_url("x", "http://127.0.0.1:8080", false).is_ok());
        assert!(base_url("x", "https://u:p@notify.example.org", false).is_err());
        assert!(base_url("x", "https://notify.example.org/?a=1", false).is_err());
        assert_eq!(origin_of("https://a.example/sub"), "https://a.example");
    }
}
