//! SSRF guard for webhook delivery targets (PRD 05 §Security).
//!
//! A `webhook.url` is attacker-controllable in the general case (any MAINTAIN holder
//! posts one), so by default the relay refuses to deliver to private, loopback,
//! link-local or otherwise non-public addresses — otherwise a webhook pointed at
//! `http://169.254.169.254/…` or `http://10.0.0.1/…` turns the relay into a
//! confused-deputy port-scanner / metadata-exfiltrator.
//!
//! ## Defeating DNS-rebinding (TOCTOU)
//!
//! Validating a hostname's resolved IPs and then handing the *hostname* to reqwest is
//! unsafe: reqwest re-resolves at connect time, so a rebinding record (public at check,
//! private at connect) bypasses the guard. [`resolve_and_validate`] therefore resolves the
//! host **once** (async, with a timeout), validates **every** returned address, and returns
//! them as `pinned_addrs` — the caller pins the HTTP client to exactly those addresses
//! (`ClientBuilder::resolve_to_addrs`) so no second resolution happens and the IP that was
//! validated is exactly the IP connected to. IP-literal URLs skip DNS entirely.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use crate::error::{RelayError, Result};

/// Whether an IPv4 address is outside the public routable space (must be refused unless
/// `allow_private`).
fn v4_is_non_public(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
        // 100.64.0.0/10 carrier-grade NAT (shared address space, RFC 6598).
        || (ip.octets()[0] == 100 && (ip.octets()[1] & 0xC0) == 64)
        // 0.0.0.0/8 "this host on this network".
        || ip.octets()[0] == 0
        // 192.0.0.0/24 IETF protocol assignments.
        || (ip.octets()[0] == 192 && ip.octets()[1] == 0 && ip.octets()[2] == 0)
}

/// The IPv4 address embedded in two IPv6 segments (`hi`, `lo` → `a.b.c.d`).
fn embedded_v4(hi: u16, lo: u16) -> Ipv4Addr {
    Ipv4Addr::new(
        (hi >> 8) as u8,
        (hi & 0xff) as u8,
        (lo >> 8) as u8,
        (lo & 0xff) as u8,
    )
}

/// Whether an IPv6 address is outside the public routable space.
fn v6_is_non_public(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    let seg = ip.segments();
    // fe80::/10 link-local.
    if (seg[0] & 0xFFC0) == 0xFE80 {
        return true;
    }
    // fc00::/7 unique local addresses (no stable std predicate).
    if (seg[0] & 0xFE00) == 0xFC00 {
        return true;
    }
    // ::ffff:0:0/96 IPv4-mapped — re-check the embedded v4.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return v4_is_non_public(v4);
    }
    // ::/96 deprecated IPv4-compatible (`::a.b.c.d`, top 96 bits zero) — `::`/`::1` are
    // already handled above, so a nonzero tail here is an embedded v4; re-check it.
    if seg[..6].iter().all(|&s| s == 0) {
        return v4_is_non_public(embedded_v4(seg[6], seg[7]));
    }
    // 2002::/16 6to4 — embedded v4 in segments 1-2; re-check it (a 6to4 wrapper around a
    // private/loopback v4 must be refused).
    if seg[0] == 0x2002 {
        return v4_is_non_public(embedded_v4(seg[1], seg[2]));
    }
    // 2001:0000::/32 Teredo — the client v4 is obfuscated across the tail; reject outright
    // rather than trust a partial decode.
    if seg[0] == 0x2001 && seg[1] == 0x0000 {
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

/// A delivery target whose address(es) have passed the SSRF policy.
#[derive(Debug, Clone)]
pub struct ValidatedTarget {
    /// The lowercased host (hostname or IP literal) from the URL.
    pub host: String,
    /// The validated socket addresses the connection must be **pinned** to (hostname
    /// case). `None` for an IP-literal URL, which reqwest connects to without any DNS —
    /// so there is nothing to pin and no rebinding window.
    pub pinned_addrs: Option<Vec<SocketAddr>>,
}

/// Resolve and validate a delivery URL against the SSRF policy, returning the addresses to
/// pin the connection to.
///
/// - Enforces `http`/`https` scheme only.
/// - IP-literal host: validated in place (unless `allow_private`); no DNS, `pinned_addrs`
///   is `None`.
/// - Hostname: resolved **once** via async DNS (bounded by `dns_timeout`); if
///   `allow_private` is false, **every** resolved address must be public, else the target
///   is refused (rebinding defense). The validated addresses are returned so the caller
///   pins the client to them (no second resolution at connect time).
pub async fn resolve_and_validate(
    url: &str,
    allow_private: bool,
    dns_timeout: Duration,
) -> Result<ValidatedTarget> {
    let (scheme, host, port) = parse_http_url(url)?;
    if scheme != "http" && scheme != "https" {
        return Err(RelayError::Ssrf(format!(
            "refusing delivery URL with non-HTTP scheme {scheme:?}: {url}"
        )));
    }

    // IP literal → no DNS, no rebinding window; validate directly.
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !allow_private && ip_is_non_public(ip) {
            return Err(RelayError::Ssrf(format!(
                "refusing delivery to non-public address {ip} (set allow_private for local testing): {url}"
            )));
        }
        return Ok(ValidatedTarget {
            host,
            pinned_addrs: None,
        });
    }

    // Hostname → resolve ONCE (async, timed) and validate every address.
    let resolve_port = port.unwrap_or(if scheme == "https" { 443 } else { 80 });
    let addrs: Vec<SocketAddr> = tokio::time::timeout(
        dns_timeout,
        tokio::net::lookup_host((host.as_str(), resolve_port)),
    )
    .await
    .map_err(|_| RelayError::Ssrf(format!("DNS lookup for {host:?} timed out: {url}")))?
    .map_err(|e| RelayError::Ssrf(format!("resolving delivery host {host:?}: {e}")))?
    .collect();

    if addrs.is_empty() {
        return Err(RelayError::Ssrf(format!(
            "delivery host {host:?} resolved to no addresses: {url}"
        )));
    }
    if !allow_private {
        for addr in &addrs {
            if ip_is_non_public(addr.ip()) {
                return Err(RelayError::Ssrf(format!(
                    "refusing delivery: host {host:?} resolves to non-public address {} (DNS-rebinding guard): {url}",
                    addr.ip()
                )));
            }
        }
    }
    // Pin the connection to exactly the validated addresses.
    Ok(ValidatedTarget {
        host,
        pinned_addrs: Some(addrs),
    })
}

/// Minimally parse an HTTP(S) URL into `(scheme, host, port)`, lowercasing the scheme
/// and host and stripping any userinfo / path / query. Kept dependency-free and strict.
fn parse_http_url(url: &str) -> Result<(String, String, Option<u16>)> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| RelayError::Ssrf(format!("malformed URL (no scheme): {url}")))?;
    let scheme = scheme.to_ascii_lowercase();

    // Strip path/query/fragment.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("").to_string();
    // Strip userinfo (`user:pass@host`).
    let hostport = authority
        .rsplit_once('@')
        .map_or(authority.as_str(), |(_, hp)| hp);
    if hostport.is_empty() {
        return Err(RelayError::Ssrf(format!("malformed URL (no host): {url}")));
    }

    // IPv6 literal `[::1]:port`.
    if let Some(after) = hostport.strip_prefix('[') {
        let (host, tail) = after
            .split_once(']')
            .ok_or_else(|| RelayError::Ssrf(format!("malformed IPv6 URL: {url}")))?;
        let port = tail
            .strip_prefix(':')
            .map(|p| {
                p.parse::<u16>()
                    .map_err(|_| RelayError::Ssrf(format!("bad port in URL: {url}")))
            })
            .transpose()?;
        return Ok((scheme, host.to_ascii_lowercase(), port));
    }

    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => {
            let port = p
                .parse::<u16>()
                .map_err(|_| RelayError::Ssrf(format!("bad port in URL: {url}")))?;
            (h, Some(port))
        }
        None => (hostport, None),
    };
    if host.is_empty() {
        return Err(RelayError::Ssrf(format!(
            "malformed URL (empty host): {url}"
        )));
    }
    Ok((scheme, host.to_ascii_lowercase(), port))
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Duration = Duration::from_secs(2);

    #[tokio::test]
    async fn ip_literal_loopback_rejected_by_default() {
        assert!(resolve_and_validate("http://127.0.0.1:9000/hook", false, T)
            .await
            .is_err());
        assert!(resolve_and_validate("http://[::1]:9000/hook", false, T)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn hostname_resolving_to_loopback_rejected() {
        // `localhost` resolves to a loopback address — the resolve+validate path must
        // refuse it (this is the rebinding-defense path: the resolved IP is checked, and
        // it is exactly the IP that would be pinned).
        assert!(resolve_and_validate("http://localhost:9000/hook", false, T)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn private_literals_rejected() {
        for host in [
            "10.0.0.1",
            "172.16.5.4",
            "192.168.1.1",
            "169.254.169.254", // cloud metadata endpoint
            "100.64.0.1",      // CGNAT
            "0.0.0.0",
        ] {
            assert!(
                resolve_and_validate(&format!("http://{host}/x"), false, T)
                    .await
                    .is_err(),
                "{host} should be rejected"
            );
        }
    }

    #[tokio::test]
    async fn public_ip_literal_allowed_and_not_pinned() {
        let t = resolve_and_validate("https://1.1.1.1/hook", false, T)
            .await
            .unwrap();
        // IP literal: no DNS, nothing to pin.
        assert!(t.pinned_addrs.is_none());
        assert_eq!(t.host, "1.1.1.1");
    }

    #[tokio::test]
    async fn allow_private_pins_the_validated_addresses() {
        // With allow_private the loopback host is permitted, and the returned pinned_addrs
        // are exactly the resolved (loopback) addresses the client will be pinned to — the
        // validated IP is the connected IP, closing the rebinding TOCTOU.
        let t = resolve_and_validate("http://localhost:9000/hook", true, T)
            .await
            .unwrap();
        let addrs = t
            .pinned_addrs
            .expect("hostname target must carry pinned addrs");
        assert!(!addrs.is_empty());
        assert!(
            addrs.iter().all(|a| a.ip().is_loopback()),
            "pinned addrs must be exactly the resolved loopback addresses"
        );
    }

    #[tokio::test]
    async fn non_http_scheme_rejected_even_when_private_allowed() {
        assert!(resolve_and_validate("file:///etc/passwd", true, T)
            .await
            .is_err());
        assert!(resolve_and_validate("gopher://127.0.0.1/x", true, T)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn userinfo_stripped_before_host_check() {
        assert!(
            resolve_and_validate("http://user:pass@127.0.0.1/x", false, T)
                .await
                .is_err()
        );
    }

    #[test]
    fn ipv6_embedded_v4_forms_rejected() {
        // IPv4-mapped, ULA, link-local.
        assert!(ip_is_non_public("::ffff:127.0.0.1".parse().unwrap()));
        assert!(ip_is_non_public("fc00::1".parse().unwrap()));
        assert!(ip_is_non_public("fe80::1".parse().unwrap()));
        // IPv4-mapped private.
        assert!(ip_is_non_public("::ffff:10.0.0.1".parse().unwrap()));
        // Deprecated IPv4-compatible ::a.b.c.d wrapping a private v4.
        assert!(ip_is_non_public("::192.168.1.1".parse().unwrap()));
        // 6to4 wrapping loopback / private v4.
        assert!(ip_is_non_public("2002:7f00:0001::1".parse().unwrap())); // 127.0.0.1
        assert!(ip_is_non_public("2002:0a00:0001::1".parse().unwrap())); // 10.0.0.1
                                                                         // Teredo prefix rejected outright.
        assert!(ip_is_non_public("2001:0:1234::1".parse().unwrap()));
        // A genuinely public v6 is allowed.
        assert!(!ip_is_non_public("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn parse_extracts_scheme_host_port() {
        assert_eq!(
            parse_http_url("https://Example.COM:8443/path?q=1").unwrap(),
            ("https".into(), "example.com".into(), Some(8443))
        );
        assert_eq!(
            parse_http_url("http://host/x").unwrap(),
            ("http".into(), "host".into(), None)
        );
    }
}
