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
//! [`ValidatedTarget::client_builder`] pins the client to exactly those
//! (`ClientBuilder::resolve_to_addrs`) and gives it a resolver that answers no name, so the
//! pinned addresses are the only route: the IP validated is the IP connected to, and a host
//! that does not match the pin fails instead of being resolved again. IP-literal URLs skip DNS.
//! Redirects and environment proxies are off (a 30x to an internal host, or a proxy resolving
//! the name itself, would bypass all of this), and [`ValidatedTarget::post`] sends to the
//! validated URL, never to the original string.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::dns::{Name, Resolve, Resolving};
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
        // 192.88.99.0/24 deprecated 6to4 relay anycast (RFC 7526).
        || (o[0] == 192 && o[1] == 88 && o[2] == 99)
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
    // ::ffff:0:0:0/96 IPv4-translated (RFC 2765).
    if seg[..6] == [0, 0, 0, 0, 0xFFFF, 0] {
        return v4_is_non_public(embedded_v4(seg[6], seg[7]));
    }
    // Special-purpose ranges that are never a public host: 100::/64 discard-only,
    // 2001:2::/48 benchmarking, 2001:10::/28 ORCHID, 2001:20::/28 ORCHIDv2,
    // 3fff::/20 documentation, 5f00::/16 SRv6 SIDs.
    if (seg[0] == 0x0100 && seg[1..4] == [0, 0, 0])
        || (seg[0] == 0x2001 && seg[1] == 0x0002 && seg[2] == 0)
        || (seg[0] == 0x2001 && (seg[1] & 0xFFF0) == 0x0010)
        || (seg[0] == 0x2001 && (seg[1] & 0xFFF0) == 0x0020)
        || (seg[0] == 0x3FFF && (seg[1] & 0xF000) == 0)
        || seg[0] == 0x5F00
    {
        return true;
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

/// A delivery target whose address(es) passed the SSRF policy. Only [`resolve_and_validate`]
/// makes one and its fields are read-only, so the URL a request is sent to is the URL that
/// was checked.
#[derive(Debug, Clone)]
pub struct ValidatedTarget {
    url: Url,
    host: String,
    pinned_addrs: Option<Vec<SocketAddr>>,
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
    /// The parsed URL. Send the request to exactly this value.
    pub fn url(&self) -> &Url {
        &self.url
    }

    /// The host as reqwest resolves it (a domain; empty for an IP literal).
    pub fn host(&self) -> &str {
        &self.host
    }

    /// The validated addresses the connection must be **pinned** to (hostname case). `None`
    /// for an IP-literal URL, which reqwest connects to without DNS.
    pub fn pinned_addrs(&self) -> Option<&[SocketAddr]> {
        self.pinned_addrs.as_deref()
    }

    /// A client builder for this target: no redirects, no environment proxy, and DNS that
    /// answers only the pinned addresses for this target's host ([`NoDns`] for any other
    /// name). The caller adds timeouts and builds it.
    pub fn client_builder(&self) -> reqwest::ClientBuilder {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .dns_resolver(std::sync::Arc::new(NoDns));
        if let Some(addrs) = &self.pinned_addrs {
            builder = builder.resolve_to_addrs(&self.host, addrs);
        }
        builder
    }

    /// A `POST` to exactly the validated URL, through `client` (from [`Self::client_builder`]).
    pub fn post(&self, client: &reqwest::Client) -> reqwest::RequestBuilder {
        client.post(self.url.clone())
    }

    /// A hostname target pinned to `addrs`, without the checks, for tests of what a target
    /// drives (pools, clients).
    #[cfg(test)]
    pub(crate) fn pinned_for_test(url: &str, addrs: Vec<SocketAddr>) -> Self {
        let url = Url::parse(url).unwrap();
        Self {
            host: url.host_str().unwrap_or_default().to_string(),
            url,
            pinned_addrs: Some(addrs),
        }
    }

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

/// A DNS resolver that resolves nothing. A delivery client reaches a hostname only through
/// the addresses pinned for it ([`ValidatedTarget::client_builder`]), so a host that does not
/// match the pin fails to connect instead of being resolved again.
struct NoDns;

impl Resolve for NoDns {
    fn resolve(&self, name: Name) -> Resolving {
        let err = format!("{} has no validated address", name.as_str());
        Box::pin(std::future::ready(Err(err.into())))
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
            .map_err(|_| RelayError::Unresolved(format!("DNS lookup for {host:?} timed out")))?
            .map_err(|e| RelayError::Unresolved(format!("resolving delivery host {host:?}: {e}")))?
            .collect();
    if addrs.is_empty() {
        return Err(RelayError::Unresolved(format!(
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
            "http://192.88.99.1/x",
            // A zone id is not a valid URL host.
            "http://[fe80::1%25eth0]/x",
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

    /// URLs whose canonical (WHATWG) host is not public, however they are spelled: the host
    /// checked is the one the parser settles on, never a later `@` or a suffix.
    const NON_PUBLIC_SPELLINGS: &[(&str, &str)] = &[
        ("http://127.0.0.1:8080\\@1.1.1.1/../admin", "127.0.0.1"),
        ("http://10.0.0.1\\@1.1.1.1/", "10.0.0.1"),
        ("https://169.254.169.254\\\\@1.1.1.1/", "169.254.169.254"),
        ("http://127.0.0.1#@1.1.1.1/", "127.0.0.1"),
        ("http://127.0.0.1?@1.1.1.1/", "127.0.0.1"),
        ("http://127.0.0.1/@1.1.1.1/", "127.0.0.1"),
        ("http://127.0.0.1./x", "127.0.0.1"),
        ("http://0x7f.0.0.1./x", "127.0.0.1"),
        ("http://017700000001/x", "127.0.0.1"),
        ("http://127.0.0.1%2e/x", "127.0.0.1"),
        ("http://\u{ff11}\u{ff12}\u{ff17}.0.0.1/x", "127.0.0.1"),
        ("http://[::ffff:127.0.0.1]/x", "[::ffff:7f00:1]"),
        ("http://[::ffff:a9fe:a9fe]/x", "[::ffff:a9fe:a9fe]"),
        ("http://[fe80::1]/x", "[fe80::1]"),
        ("http://[::1]:8080\\@1.1.1.1/", "[::1]"),
    ];

    #[tokio::test]
    async fn non_public_hosts_are_refused_in_every_spelling() {
        for &(url, host) in NON_PUBLIC_SPELLINGS {
            let parsed = parse_target(url).unwrap_or_else(|e| panic!("{url}: {e}"));
            assert_eq!(parsed.host_str(), Some(host), "{url}");
            assert!(refused(url).await, "{url} should be refused");
            // With allow_private the same canonical URL is the one validated.
            let t = resolve_and_validate(url, true, T).await.unwrap();
            assert_eq!(t.url(), &parsed, "{url}");
        }
    }

    #[tokio::test]
    async fn userinfo_is_refused_whatever_follows_it() {
        for url in [
            "http://1.1.1.1@127.0.0.1/",
            "http://user@127.0.0.1\\@1.1.1.1/",
            "http://a@b@169.254.169.254/",
            "http://public.example:80@10.0.0.1/",
            "http://%31@127.0.0.1/",
        ] {
            for allow_private in [false, true] {
                let err = resolve_and_validate(url, allow_private, T)
                    .await
                    .expect_err(url);
                assert!(err.to_string().contains("userinfo"), "{url}: {err}");
            }
        }
    }

    #[tokio::test]
    async fn a_public_host_before_the_backslash_is_the_one_kept() {
        // The canonical host is public, so it is allowed; what follows the backslash is path.
        let t = resolve_and_validate("https://1.1.1.1\\@127.0.0.1/hook", false, T)
            .await
            .unwrap();
        assert_eq!(t.url().host_str(), Some("1.1.1.1"));
        assert_eq!(t.url().path(), "/@127.0.0.1/hook");
        // An ordinary DNS name parses as a domain, to be resolved and pinned.
        let u = parse_target("https://ci.example.com:8443/hook").unwrap();
        assert_eq!(u.host(), Some(url::Host::Domain("ci.example.com")));
        assert_eq!(u.port(), Some(8443));
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
            "::ffff:0:7f00:1", // IPv4-translated 127.0.0.1
            "::ffff:0:a00:1",  // IPv4-translated 10.0.0.1
            "100::1",          // discard-only
            "2001:2::1",       // benchmarking
            "2001:10::1",      // ORCHID
            "2001:2f:ffff::1", // ORCHIDv2
            "3fff::1",         // documentation
            "3fff:fff::1",     // documentation, end of the /20
            "5f00::1",         // SRv6 SIDs
        ] {
            assert!(ip_is_non_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "2606:4700:4700::1111",
            "64:ff9b::808:808",
            "2002:0808:0808::1",
            "::ffff:0:808:808", // IPv4-translated 8.8.8.8
            "100:0:0:1::1",     // past the discard-only /64
            "2001:3::1",
            "3fff:1000::1", // past the documentation /20
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
