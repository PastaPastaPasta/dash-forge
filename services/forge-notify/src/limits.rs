//! Per-address request limits (a fixed one-minute window), and the client address.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::http::HeaderMap;

/// Requests per minute per client address.
pub struct RateLimiter {
    per_minute: u32,
    windows: Mutex<HashMap<IpAddr, (Instant, u32)>>,
}

const MAX_TRACKED: usize = 100_000;

impl RateLimiter {
    /// A limiter allowing `per_minute` requests per address.
    pub fn new(per_minute: u32) -> Self {
        Self {
            per_minute,
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Count a request from `ip`: false when it is over the limit.
    pub fn allow(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut w = self
            .windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if w.len() > MAX_TRACKED {
            w.retain(|_, (start, _)| now.duration_since(*start) < Duration::from_secs(60));
        }
        let e = w.entry(normalize(ip)).or_insert((now, 0));
        if now.duration_since(e.0) >= Duration::from_secs(60) {
            *e = (now, 0);
        }
        e.1 += 1;
        e.1 <= self.per_minute
    }
}

/// IPv6 clients are limited per /64 (one host usually holds a whole /64).
fn normalize(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => {
            let mut seg = v6.segments();
            for s in &mut seg[4..] {
                *s = 0;
            }
            IpAddr::V6(seg.into())
        }
        v4 @ IpAddr::V4(_) => v4,
    }
}

/// The client's address: the socket peer, or (behind a trusted proxy) `CF-Connecting-IP`, else
/// the first `X-Forwarded-For` entry.
pub fn client_ip(peer: SocketAddr, headers: &HeaderMap, trust_proxy: bool) -> IpAddr {
    if trust_proxy {
        let from = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
                .and_then(|v| v.trim().parse::<IpAddr>().ok())
        };
        if let Some(ip) = from("cf-connecting-ip").or_else(|| from("x-forwarded-for")) {
            return ip;
        }
    }
    peer.ip()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_per_address_and_per_v6_prefix() {
        let l = RateLimiter::new(2);
        let a: IpAddr = "192.0.2.1".parse().unwrap();
        assert!(l.allow(a) && l.allow(a) && !l.allow(a));
        assert!(l.allow("192.0.2.2".parse().unwrap()));
        let v6a: IpAddr = "2001:db8::1".parse().unwrap();
        let v6b: IpAddr = "2001:db8::2".parse().unwrap();
        assert!(l.allow(v6a) && l.allow(v6b) && !l.allow(v6a));
    }

    #[test]
    fn proxy_headers_only_when_trusted() {
        let peer: SocketAddr = "10.0.0.1:5000".parse().unwrap();
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "198.51.100.7, 10.0.0.1".parse().unwrap());
        assert_eq!(client_ip(peer, &h, false), peer.ip());
        assert_eq!(
            client_ip(peer, &h, true),
            "198.51.100.7".parse::<IpAddr>().unwrap()
        );
    }
}
