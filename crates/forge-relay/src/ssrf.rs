//! SSRF guard for webhook delivery targets (PRD 05 §Security).
//!
//! A `webhook.url` is attacker-controllable in the general case (any MAINTAIN holder
//! posts one), so by default the relay refuses to deliver to private, loopback,
//! link-local or otherwise non-public addresses — otherwise a webhook pointed at
//! `http://169.254.169.254/…` or `http://10.0.0.1/…` turns the relay into a
//! confused-deputy port-scanner / metadata-exfiltrator.
//!
//! The check resolves the host (defeating DNS-rebinding: if *any* resolved address is
//! non-public the target is rejected) unless `allow_private` is set — which the M2 local
//! test needs, since it delivers to `127.0.0.1`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};

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
    false
}

/// Whether an [`IpAddr`] must be refused by default.
pub fn ip_is_non_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_is_non_public(v4),
        IpAddr::V6(v6) => v6_is_non_public(v6),
    }
}

/// Validate a delivery URL's host against the SSRF policy.
///
/// When `allow_private` is false, resolves the host and rejects if *any* resolved
/// address is non-public (DNS-rebinding defense). When `allow_private` is true (local
/// testing) the check is skipped. Also enforces `http`/`https` scheme only.
pub fn check_url(url: &str, allow_private: bool) -> Result<()> {
    let (scheme, host, port) = parse_http_url(url)?;
    if scheme != "http" && scheme != "https" {
        return Err(RelayError::Ssrf(format!(
            "refusing delivery URL with non-HTTP scheme {scheme:?}: {url}"
        )));
    }
    if allow_private {
        return Ok(());
    }

    // If the host is an IP literal, check it directly (no DNS).
    if let Ok(ip) = host.parse::<IpAddr>() {
        if ip_is_non_public(ip) {
            return Err(RelayError::Ssrf(format!(
                "refusing delivery to non-public address {ip} (set allow_private for local testing): {url}"
            )));
        }
        return Ok(());
    }

    // Otherwise resolve every address and reject if ANY is non-public.
    let resolve_port = port.unwrap_or(if scheme == "https" { 443 } else { 80 });
    let addrs: Vec<_> = (host.as_str(), resolve_port)
        .to_socket_addrs()
        .map_err(|e| RelayError::Ssrf(format!("resolving delivery host {host:?}: {e}")))?
        .collect();
    if addrs.is_empty() {
        return Err(RelayError::Ssrf(format!(
            "delivery host {host:?} resolved to no addresses: {url}"
        )));
    }
    for addr in addrs {
        if ip_is_non_public(addr.ip()) {
            return Err(RelayError::Ssrf(format!(
                "refusing delivery: host {host:?} resolves to non-public address {} (DNS-rebinding guard): {url}",
                addr.ip()
            )));
        }
    }
    Ok(())
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

    #[test]
    fn loopback_rejected_by_default() {
        assert!(check_url("http://127.0.0.1:9000/hook", false).is_err());
        assert!(check_url("http://[::1]:9000/hook", false).is_err());
        assert!(check_url("http://localhost:9000/hook", false).is_err());
    }

    #[test]
    fn private_ranges_rejected() {
        for host in [
            "10.0.0.1",
            "172.16.5.4",
            "192.168.1.1",
            "169.254.169.254", // cloud metadata endpoint
            "100.64.0.1",      // CGNAT
            "0.0.0.0",
        ] {
            assert!(
                check_url(&format!("http://{host}/x"), false).is_err(),
                "{host} should be rejected"
            );
        }
    }

    #[test]
    fn public_ip_allowed() {
        assert!(check_url("https://1.1.1.1/hook", false).is_ok());
        assert!(check_url("https://8.8.8.8:443/hook", false).is_ok());
    }

    #[test]
    fn allow_private_overrides() {
        assert!(check_url("http://127.0.0.1:9000/hook", true).is_ok());
        assert!(check_url("http://10.0.0.1/hook", true).is_ok());
    }

    #[test]
    fn non_http_scheme_rejected_even_when_private_allowed() {
        assert!(check_url("file:///etc/passwd", true).is_err());
        assert!(check_url("gopher://127.0.0.1/x", true).is_err());
    }

    #[test]
    fn userinfo_stripped_before_host_check() {
        // The real host is the loopback; userinfo must not confuse the parser.
        assert!(check_url("http://user:pass@127.0.0.1/x", false).is_err());
    }

    #[test]
    fn ipv4_mapped_ipv6_loopback_rejected() {
        assert!(ip_is_non_public("::ffff:127.0.0.1".parse().unwrap()));
        assert!(ip_is_non_public("fc00::1".parse().unwrap()));
        assert!(ip_is_non_public("fe80::1".parse().unwrap()));
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
