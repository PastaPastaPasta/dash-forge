//! SSRF guard for webhook delivery targets (PRD 05 §Security).
//!
//! A `webhook.url` comes from chain: any maintainer of any repo can write one and address it
//! to a public relay. So by default the relay refuses to deliver to private, loopback,
//! link-local, multicast or otherwise non-public addresses; otherwise a webhook pointed at
//! `http://169.254.169.254/…` or `http://10.0.0.1/…` turns the relay into a confused-deputy
//! port scanner / metadata exfiltrator.
//!
//! ## One parser
//!
//! The URL is parsed **once**, with the same WHATWG parser reqwest uses (`reqwest::Url`), and
//! the request is sent to that parsed value. A hand-rolled parser that disagrees with reqwest's
//! is a bypass: `http://127.0.0.1\@public.example/` names `public.example` to a naive
//! `rsplit('@')` but `127.0.0.1` to a WHATWG parser (a backslash ends the authority of an http
//! URL). Decimal, octal and hex IPv4 hosts (`http://2130706433/`, `http://0x7f.1/`) are
//! normalized by the parser to dotted quads, so they are checked as the address they are.
//!
//! Refused outright, even with `allow_private`: any scheme but `http`/`https`, userinfo
//! (`user:pass@`; reqwest would send it as Basic auth to whatever host the URL names), and a
//! missing host.
//!
//! ## Defeating DNS rebinding (TOCTOU)
//!
//! Validating a hostname's resolved IPs and then handing the *hostname* to reqwest is unsafe:
//! reqwest re-resolves at connect time, so a rebinding record (public at check, private at
//! connect) bypasses the guard. [`resolve_and_validate`] resolves the host **once** (async,
//! with a timeout), validates **every** returned address, and returns them as `pinned_addrs`;
//! the caller pins the client to exactly those (`ClientBuilder::resolve_to_addrs`), so the IP
//! validated is the IP connected to. IP-literal URLs skip DNS. Redirects are disabled by the
//! caller (a 30x to an internal host would bypass all of this).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::Url;

use crate::error::{RelayError, Result};

/// Whether an IPv4 address is outside the public routable space.
fn v4_is_non_public(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        // 0.0.0.0/8 "this network".
        || o[0] == 0
        // 100.64.0.0/10 carrier-grade NAT (RFC 6598).
        || (o[0] == 100 && (o[1] & 0xC0) == 64)
        // 192.0.0.0/24 IETF protocol assignments.
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        // 198.18.0.0/15 benchmarking (RFC 2544).
        || (o[0] == 198 && (o[1] & 0xFE) == 18)
        // 240.0.0.0/4 reserved (includes 255.255.255.255).
        || o[0] >= 240
}

/// The IPv4 address embedded in two IPv6 segments (`hi`, `lo` → `a.b.c.d`).
fn embedded_v4(hi: u16, lo: u16) -> Ipv4Addr {
    let [a, b] = hi.to_be_bytes();
    let [c, d] = lo.to_be_bytes();
    Ipv4Addr::new(a, b, c, d)
}

/// Whether an IPv6 address is outside the public routable space. Every form that embeds an
/// IPv4 address is judged by that address.
fn v6_is_non_public(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return true;
    }
    let seg = ip.segments();
    // fe80::/10 link-local, fec0::/10 deprecated site-local.
    if (seg[0] & 0xFFC0) == 0xFE80 || (seg[0] & 0xFFC0) == 0xFEC0 {
        return true;
    }
    // fc00::/7 unique local.
    if (seg[0] & 0xFE00) == 0xFC00 {
        return true;
    }
    // 2001:db8::/32 documentation.
    if seg[0] == 0x2001 && seg[1] == 0x0DB8 {
        return true;
    }
    // ::ffff:0:0/96 IPv4-mapped.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return v4_is_non_public(v4);
    }
    // ::/96 deprecated IPv4-compatible (`::a.b.c.d`); `::` and `::1` are handled above.
    if seg[..6].iter().all(|&s| s == 0) {
        return v4_is_non_public(embedded_v4(seg[6], seg[7]));
    }
    // 64:ff9b::/96 NAT64 well-known prefix, and 64:ff9b:1::/48 local-use NAT64 (RFC 8215):
    // the target is the embedded IPv4 in the last 32 bits. The local-use prefix is
    // operator-defined, so it is refused whatever it embeds.
    if seg[0] == 0x0064 && seg[1] == 0xFF9B {
        if seg[2] == 0x0001 {
            return true;
        }
        return v4_is_non_public(embedded_v4(seg[6], seg[7]));
    }
    // 2002::/16 6to4: the embedded IPv4 is in segments 1-2.
    if seg[0] == 0x2002 {
        return v4_is_non_public(embedded_v4(seg[1], seg[2]));
    }
    // 2001:0::/32 Teredo: the client address is obfuscated; refuse rather than decode.
    if seg[0] == 0x2001 && seg[1] == 0 {
        return true;
    }
    false
}

/// Whether an [`IpAddr`] must be refused by default.
pub fn ip_is_non_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_is_non_public(v4),
        IpAddr::V6(v6) => v6_is_non_public(v6),
    }
}

/// A delivery target whose address(es) passed the SSRF policy.
#[derive(Debug, Clone)]
pub struct ValidatedTarget {
    /// The parsed URL. Send the request to exactly this value.
    pub url: Url,
    /// The host as reqwest resolves it (a domain; empty for an IP literal).
    pub host: String,
    /// The validated addresses the connection must be **pinned** to (hostname case). `None`
    /// for an IP-literal URL, which reqwest connects to without DNS.
    pub pinned_addrs: Option<Vec<SocketAddr>>,
}

/// Parse `url` and apply the checks that hold even with `allow_private`: http(s) only, a
/// host, no userinfo.
pub fn parse_target(url: &str) -> Result<Url> {
    let parsed = Url::parse(url.trim())
        .map_err(|e| RelayError::Ssrf(format!("malformed delivery URL ({e})")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(RelayError::Ssrf(format!(
            "refusing delivery URL with scheme {:?}",
            parsed.scheme()
        )));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(RelayError::Ssrf(
            "refusing delivery URL with userinfo (user:pass@host)".into(),
        ));
    }
    if parsed.host().is_none() {
        return Err(RelayError::Ssrf("delivery URL has no host".into()));
    }
    Ok(parsed)
}

/// The URL as logs show it: scheme, host and port only (a path or query can carry a token).
pub fn redact(url: &str) -> String {
    match Url::parse(url) {
        Ok(u) => match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{}://{h}:{p}", u.scheme()),
            (Some(h), None) => format!("{}://{h}", u.scheme()),
            _ => "<url without host>".to_string(),
        },
        Err(_) => "<malformed url>".to_string(),
    }
}

impl ValidatedTarget {
    /// The address the connection goes to (the first pinned one), for per-destination bounds:
    /// many hostnames that resolve to one server share its pool.
    pub fn ip_key(&self) -> String {
        match (&self.pinned_addrs, self.url.host()) {
            (Some(addrs), _) if !addrs.is_empty() => addrs[0].ip().to_string(),
            (_, Some(url::Host::Ipv4(ip))) => ip.to_string(),
            (_, Some(url::Host::Ipv6(ip))) => ip.to_string(),
            _ => self.host.clone(),
        }
    }
}

/// Resolve and validate a delivery URL against the SSRF policy, returning the parsed URL and
/// the addresses to pin the connection to. See the module docs.
pub async fn resolve_and_validate(
    url: &str,
    allow_private: bool,
    dns_timeout: Duration,
) -> Result<ValidatedTarget> {
    let parsed = parse_target(url)?;
    let shown = redact(url);
    let refuse = |ip: IpAddr, how: &str| {
        RelayError::Ssrf(format!(
            "refusing delivery to non-public address {ip}{how} (run with --allow-private \
             for local testing): {shown}"
        ))
    };

    let literal = match parsed.host() {
        Some(url::Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
        _ => None,
    };
    if let Some(ip) = literal {
        if !allow_private && ip_is_non_public(ip) {
            return Err(refuse(ip, ""));
        }
        return Ok(ValidatedTarget {
            url: parsed,
            host: String::new(),
            pinned_addrs: None,
        });
    }

    let host = parsed.host_str().unwrap_or_default().to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> =
        tokio::time::timeout(dns_timeout, tokio::net::lookup_host((host.as_str(), port)))
            .await
            .map_err(|_| RelayError::Ssrf(format!("DNS lookup for {host:?} timed out")))?
            .map_err(|e| RelayError::Ssrf(format!("resolving delivery host {host:?}: {e}")))?
            .collect();
    if addrs.is_empty() {
        return Err(RelayError::Ssrf(format!(
            "delivery host {host:?} resolved to no addresses"
        )));
    }
    if !allow_private {
        if let Some(bad) = addrs.iter().find(|a| ip_is_non_public(a.ip())) {
            return Err(refuse(bad.ip(), &format!(" (resolved from {host:?})")));
        }
    }
    Ok(ValidatedTarget {
        url: parsed,
        host,
        pinned_addrs: Some(addrs),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Duration = Duration::from_secs(2);

    async fn refused(url: &str) -> bool {
        resolve_and_validate(url, false, T).await.is_err()
    }

    #[tokio::test]
    async fn loopback_and_private_literals_are_refused() {
        for url in [
            "http://127.0.0.1:9000/hook",
            "http://[::1]:9000/hook",
            "http://10.0.0.1/x",
            "http://172.16.5.4/x",
            "http://192.168.1.1/x",
            "http://169.254.169.254/latest/meta-data",
            "http://100.64.0.1/x",
            "http://0.0.0.0/x",
            "http://224.0.0.1/x",
            "http://198.18.0.1/x",
            "http://255.255.255.255/x",
        ] {
            assert!(refused(url).await, "{url} should be refused");
        }
    }

    #[tokio::test]
    async fn alternative_ipv4_spellings_are_normalized_then_refused() {
        // Decimal, hex, octal and shortened forms all mean 127.0.0.1 to the WHATWG parser.
        for url in [
            "http://2130706433/x",
            "http://0x7f000001/x",
            "http://0177.0.0.1/x",
            "http://127.1/x",
            "http://0x7f.1/x",
        ] {
            assert!(refused(url).await, "{url} should be refused");
        }
    }

    #[tokio::test]
    async fn a_backslash_cannot_split_the_parsers() {
        // A naive `rsplit('@')` sees `public.example`; reqwest connects to 127.0.0.1. With one
        // parser the host checked is the host connected to.
        let t = parse_target("http://127.0.0.1\\@public.example/x").unwrap();
        assert_eq!(t.host_str(), Some("127.0.0.1"));
        assert!(refused("http://127.0.0.1\\@public.example/x").await);
    }

    #[tokio::test]
    async fn hostname_resolving_to_loopback_is_refused() {
        assert!(refused("http://localhost:9000/hook").await);
    }

    #[tokio::test]
    async fn public_ip_literal_is_allowed_and_not_pinned() {
        let t = resolve_and_validate("https://1.1.1.1/hook", false, T)
            .await
            .unwrap();
        assert!(t.pinned_addrs.is_none());
        assert_eq!(t.url.as_str(), "https://1.1.1.1/hook");
    }

    #[tokio::test]
    async fn allow_private_pins_the_validated_addresses() {
        let t = resolve_and_validate("http://localhost:9000/hook", true, T)
            .await
            .unwrap();
        let addrs = t
            .pinned_addrs
            .expect("a hostname target carries pinned addrs");
        assert!(!addrs.is_empty());
        assert!(addrs.iter().all(|a| a.ip().is_loopback()));
        assert_eq!(t.host, "localhost");
    }

    #[tokio::test]
    async fn schemes_userinfo_and_hostless_urls_are_refused_even_when_private_is_allowed() {
        for url in [
            "file:///etc/passwd",
            "gopher://127.0.0.1/x",
            "ftp://example.com/x",
            "http://user:pass@127.0.0.1/x",
            "http://user@example.com/x",
            "https://:pw@example.com/x",
            "not a url",
            "http:///nohost",
        ] {
            assert!(
                resolve_and_validate(url, true, T).await.is_err(),
                "{url} should be refused"
            );
        }
    }

    #[test]
    fn ipv6_forms_embedding_ipv4_are_judged_by_the_ipv4() {
        for ip in [
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::192.168.1.1",
            "2002:7f00:0001::1",  // 6to4 of 127.0.0.1
            "2002:0a00:0001::1",  // 6to4 of 10.0.0.1
            "64:ff9b::7f00:1",    // NAT64 of 127.0.0.1
            "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
            "64:ff9b:1::808:808", // local-use NAT64: refused outright
            "2001:0:1234::1",     // Teredo
            "fc00::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
        ] {
            assert!(ip_is_non_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "2606:4700:4700::1111",
            "64:ff9b::808:808",
            "2002:0808:0808::1",
        ] {
            assert!(!ip_is_non_public(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn redaction_keeps_only_scheme_host_and_port() {
        assert_eq!(
            redact("https://u:p@ci.example/secret-path/hook?token=abc#frag"),
            "https://ci.example"
        );
        assert_eq!(redact("http://127.0.0.1:9000/h"), "http://127.0.0.1:9000");
        assert_eq!(redact("::"), "<malformed url>");
    }

    #[tokio::test]
    async fn the_pool_key_is_the_address_connected_to() {
        let t = resolve_and_validate("http://localhost:9/h", true, T)
            .await
            .unwrap();
        assert!(
            t.ip_key() == "127.0.0.1" || t.ip_key() == "::1",
            "{}",
            t.ip_key()
        );
        let t = resolve_and_validate("http://127.0.0.1:9/h", true, T)
            .await
            .unwrap();
        assert_eq!(t.ip_key(), "127.0.0.1");
    }
}
