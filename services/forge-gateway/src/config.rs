//! The gateway's settings: flags, each with a `GATEWAY_*` environment variable (the Docker image
//! is configured through the environment). The network comes from forge-core's own variables
//! (`DASH_FORGE_NETWORK`, `DASH_FORGE_DEVNET_NAME`, `DASH_FORGE_DAPI_ADDRESSES`, …), as for
//! `dg` and `git-remote-dash`.

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Parser, ValueEnum};

/// Which header names the client's address (for rate limits) when the gateway sits behind a proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum TrustProxy {
    /// Use the TCP peer address (the gateway faces the internet).
    None,
    /// `CF-Connecting-IP` (behind Cloudflare, a tunnel included).
    Cloudflare,
    /// The last `X-Forwarded-For` entry (behind one reverse proxy you run).
    XForwardedFor,
}

/// `forge-gateway` settings.
#[derive(Debug, Clone, Parser)]
#[command(
    name = "forge-gateway",
    version,
    about = "Read-only git-over-HTTPS mirror of public Dash Forge repositories, with badges, Atom feeds and link previews.",
    long_about = None
)]
pub struct Config {
    /// Address to listen on.
    #[arg(long, env = "GATEWAY_LISTEN", default_value = "127.0.0.1:8080")]
    pub listen: SocketAddr,

    /// Where mirrors, the manifest snapshots and the Platform read cache live.
    #[arg(long, env = "GATEWAY_DATA_DIR", default_value = "./forge-gateway-data")]
    pub data_dir: PathBuf,

    /// This gateway's public base URL, used in feeds, link previews and the index page
    /// (never taken from the request's Host header).
    #[arg(long, env = "GATEWAY_PUBLIC_URL")]
    pub public_url: Option<String>,

    /// The Forge web app links point at.
    #[arg(
        long,
        env = "GATEWAY_WEB_URL",
        default_value = "https://forge.dashhq.org"
    )]
    pub web_url: String,

    /// Repositories (`owner/name`, owner an identity id or DPNS name) mirrored at start, kept
    /// warm and never evicted. Comma-separated.
    #[arg(long, env = "GATEWAY_REPOS", value_delimiter = ',')]
    pub repos: Vec<String>,

    /// Serve any public repository on demand, not only `--repos`.
    #[arg(long, env = "GATEWAY_ALL_PUBLIC", default_value_t = false)]
    pub all_public: bool,

    /// Disk cap for all mirrors (bytes; `K`, `M`, `G` suffixes are powers of 1024). The least
    /// recently served mirrors are evicted above it.
    #[arg(long, env = "GATEWAY_CACHE_MAX", default_value = "20G", value_parser = parse_size)]
    pub cache_max_bytes: u64,

    /// The largest repository mirrored (the sum of its recorded git packs).
    #[arg(long, env = "GATEWAY_REPO_MAX", default_value = "2G", value_parser = parse_size)]
    pub repo_max_bytes: u64,

    /// How often a warm mirror is checked against Platform (seconds).
    #[arg(long, env = "GATEWAY_POLL_SECS", default_value_t = 120)]
    pub poll_secs: u64,

    /// A mirror served within this many hours is kept fresh by polling; older ones are
    /// refreshed on their next request.
    #[arg(long, env = "GATEWAY_WARM_HOURS", default_value_t = 24)]
    pub warm_hours: u64,

    /// A forge-relay whose `[wake]` stream announces pushes (`http(s)://host:port`).
    #[arg(long, env = "GATEWAY_WAKE_URL")]
    pub wake_url: Option<String>,

    /// The relay's `[wake]` shared secret, in a file (32–96 printable ASCII characters).
    #[arg(long, env = "GATEWAY_WAKE_SECRET_FILE")]
    pub wake_secret_file: Option<PathBuf>,

    /// Which header names the client (rate limits only; it is never logged).
    #[arg(long, env = "GATEWAY_TRUST_PROXY", value_enum, default_value = "none")]
    pub trust_proxy: TrustProxy,

    /// Requests per minute per client address (every route).
    #[arg(long, env = "GATEWAY_RATE_PER_MIN", default_value_t = 240)]
    pub rate_per_min: u32,

    /// Clones and fetches (`git-upload-pack`) per minute per client address.
    #[arg(long, env = "GATEWAY_CLONES_PER_MIN", default_value_t = 30)]
    pub clones_per_min: u32,

    /// Concurrent `git-upload-pack`s per client address.
    #[arg(long, env = "GATEWAY_CLONES_PER_CLIENT", default_value_t = 2)]
    pub clones_per_client: usize,

    /// Concurrent `git-upload-pack`s in total.
    #[arg(long, env = "GATEWAY_CLONES_MAX", default_value_t = 16)]
    pub clones_max: usize,

    /// New (cold) mirrors one client address may start per hour.
    #[arg(long, env = "GATEWAY_NEW_MIRRORS_PER_HOUR", default_value_t = 10)]
    pub new_mirrors_per_hour: u32,

    /// Mirror refreshes running at once.
    #[arg(long, env = "GATEWAY_REFRESH_MAX", default_value_t = 2)]
    pub refresh_max: usize,

    /// How long a request waits for a cold mirror before answering `503 Retry-After`.
    #[arg(long, env = "GATEWAY_COLD_WAIT_SECS", default_value_t = 20)]
    pub cold_wait_secs: u64,

    /// The longest one refresh's `git fetch` may run (seconds).
    #[arg(long, env = "GATEWAY_FETCH_TIMEOUT_SECS", default_value_t = 1800)]
    pub fetch_timeout_secs: u64,

    /// The longest one `git-upload-pack` response may stream (seconds).
    #[arg(long, env = "GATEWAY_SERVE_TIMEOUT_SECS", default_value_t = 900)]
    pub serve_timeout_secs: u64,

    /// Badge, feed and preview cache lifetime (seconds; shields' minimum is 300).
    #[arg(long, env = "GATEWAY_RENDER_TTL_SECS", default_value_t = 300)]
    pub render_ttl_secs: u64,

    /// The `git` binary.
    #[arg(long, env = "GATEWAY_GIT", default_value = "git")]
    pub git: PathBuf,

    /// The directory holding `git-remote-dash` (prepended to the fetch's PATH). Default: PATH.
    #[arg(long, env = "GATEWAY_HELPER_DIR")]
    pub helper_dir: Option<PathBuf>,

    /// Extra fonts for link-preview images (system fonts are always loaded).
    #[arg(long, env = "GATEWAY_FONT_DIR")]
    pub font_dir: Option<PathBuf>,
}

impl Config {
    /// Settings as given, with empty values (an unset variable in a compose file is `""`) read
    /// as absent, and checked: a wake URL needs its secret, the cache must hold one repository.
    pub fn checked(mut self) -> Result<Self, String> {
        fn some(s: Option<String>) -> Option<String> {
            s.filter(|v| !v.trim().is_empty())
        }
        fn some_path(p: Option<PathBuf>) -> Option<PathBuf> {
            p.filter(|v| !v.as_os_str().is_empty())
        }
        self.public_url = some(self.public_url);
        self.wake_url = some(self.wake_url);
        self.wake_secret_file = some_path(self.wake_secret_file);
        self.helper_dir = some_path(self.helper_dir);
        self.font_dir = some_path(self.font_dir);
        self.repos.retain(|r| !r.trim().is_empty());
        if self.wake_url.is_some() && self.wake_secret_file.is_none() {
            return Err(
                "GATEWAY_WAKE_URL needs GATEWAY_WAKE_SECRET_FILE (the relay's [wake] secret)"
                    .into(),
            );
        }
        if self.cache_max_bytes < self.repo_max_bytes {
            return Err("GATEWAY_CACHE_MAX must be at least GATEWAY_REPO_MAX".into());
        }
        if let Some(u) = &self.public_url {
            if !(u.starts_with("https://") || u.starts_with("http://")) {
                return Err("GATEWAY_PUBLIC_URL must be an http(s) URL".into());
            }
        }
        Ok(self)
    }

    /// The public base URL, without a trailing slash.
    pub fn public_base(&self) -> String {
        self.public_url
            .clone()
            .unwrap_or_else(|| format!("http://{}", self.listen))
            .trim_end_matches('/')
            .to_string()
    }

    /// The web app's base URL, without a trailing slash.
    pub fn web_base(&self) -> String {
        self.web_url.trim_end_matches('/').to_string()
    }

    /// Settings for tests: everything on, generous limits, `data_dir` as given.
    pub fn for_tests(data_dir: PathBuf) -> Self {
        let mut c = Self::parse_from(["forge-gateway"]);
        c.data_dir = data_dir;
        c.all_public = true;
        c.cold_wait_secs = 30;
        c
    }
}

/// `20G`, `512M`, `64K` or a plain byte count (powers of 1024; a trailing `B`/`iB` is allowed).
pub fn parse_size(s: &str) -> Result<u64, String> {
    let t = s.trim();
    let t = t
        .strip_suffix("iB")
        .or_else(|| t.strip_suffix('B'))
        .unwrap_or(t);
    let (num, mult) = match t.chars().last() {
        Some('K' | 'k') => (&t[..t.len() - 1], 1u64 << 10),
        Some('M' | 'm') => (&t[..t.len() - 1], 1 << 20),
        Some('G' | 'g') => (&t[..t.len() - 1], 1 << 30),
        Some('T' | 't') => (&t[..t.len() - 1], 1 << 40),
        _ => (t, 1),
    };
    num.trim()
        .parse::<u64>()
        .ok()
        .and_then(|n| n.checked_mul(mult))
        .ok_or_else(|| format!("{s:?} is not a size (e.g. 20G, 512M, 1048576)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_parse() {
        assert_eq!(parse_size("20G").unwrap(), 20 << 30);
        assert_eq!(parse_size("512MiB").unwrap(), 512 << 20);
        assert_eq!(parse_size("64k").unwrap(), 64 << 10);
        assert_eq!(parse_size("1048576").unwrap(), 1 << 20);
        assert!(parse_size("lots").is_err());
        assert!(parse_size("99999999999T").is_err());
    }

    #[test]
    fn empty_values_are_absent() {
        let mut c = Config::parse_from(["forge-gateway"]);
        c.wake_url = Some(String::new());
        c.public_url = Some(" ".into());
        c.repos = vec![String::new()];
        let c = c.checked().unwrap();
        assert!(c.wake_url.is_none() && c.public_url.is_none() && c.repos.is_empty());
        let mut c = Config::parse_from(["forge-gateway"]);
        c.wake_url = Some("http://relay:8787".into());
        assert!(c
            .checked()
            .unwrap_err()
            .contains("GATEWAY_WAKE_SECRET_FILE"));
        let mut c = Config::parse_from(["forge-gateway"]);
        c.cache_max_bytes = 1;
        assert!(c.checked().is_err());
    }

    #[test]
    fn defaults_are_conservative() {
        let c = Config::parse_from(["forge-gateway"]);
        assert!(!c.all_public, "only listed repos unless asked");
        assert_eq!(c.listen.ip().to_string(), "127.0.0.1");
        assert_eq!(c.trust_proxy, TrustProxy::None);
        assert_eq!(c.public_base(), "http://127.0.0.1:8080");
    }
}
