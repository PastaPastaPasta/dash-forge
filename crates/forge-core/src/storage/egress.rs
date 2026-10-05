//! Public-only egress for recorded copies: a manifest's URLs are written by whoever pushed,
//! so a reader (a user's `git fetch`, or a forge-gateway answering strangers) must not be
//! steered into this machine or its network. [`super::publish::is_public_https_url`] judges
//! a URL's literal host; this module also refuses what that cannot see:
//!
//! - a redirect to a host that is not public https ([`may_fetch`] is checked on every hop),
//! - a DNS name that resolves to a private, loopback, link-local, CGNAT or unique-local
//!   address ([`PublicOnlyResolver`]: those addresses are dropped at connect time).
//!
//! Origins the user configured (a read gateway, a profile's public URL or gateway: their own
//! NAS) are the explicit exception, as they are for [`super::PackReader`]'s candidates.

use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::Url;

use super::publish::is_public_https_url;

/// Redirect hops followed before giving up (reqwest's default).
const MAX_REDIRECTS: usize = 10;

/// Whether `ip` is a globally routable unicast address: not loopback, unspecified,
/// private (RFC 1918), link-local, CGNAT (100.64/10), unique-local (fc00::/7), multicast,
/// broadcast or reserved, nor one of those embedded in an IPv6 address (IPv4-mapped,
/// IPv4-compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`).
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (18..=19).contains(&b))
        || a >= 224)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    let embedded = |hi: u16, lo: u16| Ipv4Addr::from((u32::from(hi) << 16) | u32::from(lo));
    if s[..6] == [0, 0, 0, 0, 0, 0xffff] || s[..6] == [0; 6] {
        // IPv4-mapped, or IPv4-compatible (which includes `::` and `::1`).
        return is_public_v4(embedded(s[6], s[7]));
    }
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return is_public_v4(embedded(s[6], s[7]));
    }
    if s[0] == 0x2002 {
        return is_public_v4(embedded(s[1], s[2]));
    }
    !((s[0] & 0xfe00) == 0xfc00 // unique-local fc00::/7
        || (s[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (s[0] & 0xffc0) == 0xfec0 // site-local fec0::/10 (deprecated)
        || (s[0] & 0xff00) == 0xff00) // multicast
}

/// Hosts and origins the user configured, which egress checks let through.
#[derive(Debug, Clone, Default)]
pub struct Trusted {
    /// `scheme://host[:port]` origins.
    pub origins: Vec<String>,
    /// Lowercase host names (no trailing dot), whose DNS answers are not filtered.
    pub hosts: BTreeSet<String>,
}

impl Trusted {
    /// The origins and hosts of `urls` (unparseable entries are skipped).
    pub fn of<'a>(urls: impl IntoIterator<Item = &'a str>) -> Self {
        let mut t = Self::default();
        for raw in urls {
            let Ok(u) = Url::parse(raw) else { continue };
            let origin = u.origin().ascii_serialization();
            if origin != "null" && !t.origins.contains(&origin) {
                t.origins.push(origin);
            }
            if let Some(h) = u.host_str() {
                t.hosts.insert(h.trim_end_matches('.').to_ascii_lowercase());
            }
        }
        t
    }

    fn has_origin(&self, u: &Url) -> bool {
        let o = u.origin().ascii_serialization();
        o != "null" && self.origins.contains(&o)
    }
}

/// Whether a reader may request `url`: public https whose host, when an IP literal, is a
/// public address ([`is_public_ip`]), or a URL on an origin the user configured.
pub fn may_fetch(url: &str, trusted: &Trusted) -> bool {
    let Ok(u) = Url::parse(url) else { return false };
    if trusted.has_origin(&u) {
        return true;
    }
    let host = u.host_str().unwrap_or_default();
    let literal_ok = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .map_or(true, is_public_ip);
    literal_ok && is_public_https_url(url)
}

/// A resolver that drops every non-public address ([`is_public_ip`]) a name resolves to,
/// except for the hosts the user configured. A name left with no address fails to connect.
/// IP literals never reach a resolver: [`may_fetch`] judges those.
#[derive(Debug, Clone)]
pub struct PublicOnlyResolver {
    trusted_hosts: Arc<BTreeSet<String>>,
}

impl Resolve for PublicOnlyResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().trim_end_matches('.').to_ascii_lowercase();
        let trusted = self.trusted_hosts.contains(&host);
        Box::pin(async move {
            let found: Vec<SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let kept: Vec<SocketAddr> = found
                .into_iter()
                .filter(|a| trusted || is_public_ip(a.ip()))
                .collect();
            if kept.is_empty() {
                return Err(format!("{host} resolves to no public address").into());
            }
            Ok(Box::new(kept.into_iter()) as Addrs)
        })
    }
}

/// [`super::http_client`]'s timeouts, plus public-only egress: every redirect hop must pass
/// [`may_fetch`], and DNS answers go through [`PublicOnlyResolver`]. `trusted` is what the
/// user configured.
pub fn public_read_client(trusted: &Trusted) -> reqwest::Client {
    let hops = trusted.clone();
    let redirects = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            attempt.error("too many redirects")
        } else if may_fetch(attempt.url().as_str(), &hops) {
            attempt.follow()
        } else {
            let to = attempt.url().host_str().unwrap_or("?").to_string();
            attempt.error(format!(
                "refused a redirect to {to}: not a public https host"
            ))
        }
    });
    super::http_client_builder()
        .redirect(redirects)
        .dns_resolver(Arc::new(PublicOnlyResolver {
            trusted_hosts: Arc::new(trusted.hosts.clone()),
        }))
        .build()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_special_addresses_are_not_public() {
        for ip in [
            "0.0.0.0",
            "10.1.2.3",
            "127.0.0.1",
            "100.64.0.1",
            "100.127.255.255",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "192.0.0.8",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:192.168.1.1",
            "::ffff:127.0.0.1",
            "::7f00:1",
            "64:ff9b::a9fe:a9fe",
            "2002:c0a8:0101::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip} is not public");
        }
        for ip in [
            "1.1.1.1",
            "8.8.8.8",
            "100.63.255.255",
            "100.128.0.1",
            "172.15.0.1",
            "172.32.0.1",
            "2606:4700:4700::1111",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
            "2002:0808:0808::1",
        ] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip} is public");
        }
    }

    #[test]
    fn may_fetch_checks_literals_and_honours_configured_origins() {
        let none = Trusted::default();
        assert!(may_fetch("https://pub.example/p", &none));
        assert!(!may_fetch("http://pub.example/p", &none));
        assert!(!may_fetch("https://192.168.1.5/p", &none));
        assert!(!may_fetch("https://[64:ff9b::c0a8:105]/p", &none));
        assert!(!may_fetch("https://[::7f00:1]/p", &none));
        let nas = Trusted::of(["http://192.168.1.5:9000/bucket"]);
        assert!(may_fetch("http://192.168.1.5:9000/bucket/p", &nas));
        assert!(!may_fetch("http://192.168.1.5:9001/p", &nas));
    }

    /// A one-shot HTTP server on 127.0.0.1 answering every request with `head` (no body).
    fn answer(head: String) -> String {
        use std::io::{BufRead as _, BufReader, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                }
                let _ = stream.write_all(head.as_bytes());
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn redirects_to_private_hosts_are_refused() {
        let inner = answer("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok".into());
        // The user's own server (trusted) redirects into the LAN: refused all the same.
        let outer = answer(format!(
            "HTTP/1.1 302 Found\r\nlocation: {inner}/secret\r\ncontent-length: 0\r\n\r\n"
        ));
        let client = public_read_client(&Trusted::of([outer.as_str()]));
        let err = client.get(format!("{outer}/p")).send().await.unwrap_err();
        assert!(err.is_redirect(), "{err:?}");
        // A redirect within a trusted origin is followed.
        let client = public_read_client(&Trusted::of([outer.as_str(), inner.as_str()]));
        let resp = client.get(format!("{outer}/p")).send().await.unwrap();
        assert_eq!(resp.text().await.unwrap(), "ok");
    }

    #[tokio::test]
    async fn names_resolving_to_private_addresses_are_refused() {
        let ok = answer("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok".into());
        let port = ok.rsplit(':').next().unwrap();
        // `localhost` resolves to loopback only.
        let url = format!("http://localhost:{port}/p");
        let err = public_read_client(&Trusted::default())
            .get(&url)
            .send()
            .await
            .unwrap_err();
        assert!(err.is_connect(), "{err:?}");
        assert!(format!("{err:?}").contains("no public address"), "{err:?}");
        // Unless the user configured that host.
        let resp = public_read_client(&Trusted::of([url.as_str()]))
            .get(&url)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.text().await.unwrap(), "ok");
    }
}
