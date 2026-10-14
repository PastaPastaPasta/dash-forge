//! The agent's way out (mixed-visibility DESIGN §4.9, "Network"): an HTTP `CONNECT` proxy in the
//! runner process that lets through the endpoints of the AI service an access notice names and
//! refuses everything else, writing one line per attempt to the job's egress log.
//!
//! The agent's container sits on a Docker network with no route out (`--internal`) and no DNS for
//! outside names; the only thing it reaches is a relay container (socat) on that network and the
//! bridge, which forwards to this proxy. So the allowlist is enforced by where packets can go, not
//! by the agent honouring `HTTPS_PROXY`: an agent that ignores the variable reaches nothing.
//!
//! Only `CONNECT host:port` is served (TLS end to end; the proxy never sees the content). A
//! request in the clear (`GET http://…`) is refused: an endpoint is reached over TLS or not at all.

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs as _};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context as _, Result};

/// How long the proxy waits for a request's head, and for the upstream connection.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);

/// The largest request head read (a `CONNECT` line and its headers).
const MAX_HEAD: usize = 8 * 1024;

/// One endpoint an agent may reach: a host name (lower case) and a port.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Endpoint {
    /// The host, lower case.
    pub host: String,
    /// The port.
    pub port: u16,
}

impl Endpoint {
    /// `host:port` (a host name or an IPv4 address; no scheme, path or user), else `None`.
    pub fn parse(s: &str) -> Option<Self> {
        let (host, port) = s.trim().rsplit_once(':')?;
        let port: u16 = port.parse().ok().filter(|p| *p > 0)?;
        let host = host.to_ascii_lowercase();
        let ok = !host.is_empty()
            && host.len() <= 253
            && host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
            && !host.starts_with(['.', '-'])
            && !host.ends_with(['.', '-']);
        ok.then_some(Self { host, port })
    }
}

impl std::fmt::Display for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.host, self.port)
    }
}

/// What the proxy did with one attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Let through to an allowed endpoint.
    Allowed,
    /// Refused: not on the list.
    Denied,
    /// Refused: not a `CONNECT` (a request in the clear, or not HTTP at all).
    NotConnect,
    /// Allowed, but the endpoint could not be reached.
    Unreachable,
}

impl Verdict {
    fn word(&self) -> &'static str {
        match self {
            Self::Allowed => "allow",
            Self::Denied => "deny",
            Self::NotConnect => "deny-not-connect",
            Self::Unreachable => "allow-unreachable",
        }
    }
}

/// One line of the egress log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attempt {
    /// When (ms since 1970).
    pub at: u64,
    /// What was asked for (`host:port`, or what the request named).
    pub target: String,
    /// What the proxy did.
    pub verdict: Verdict,
}

/// A running proxy. Dropping it stops it.
pub struct Proxy {
    port: u16,
    stop: Arc<AtomicBool>,
    addr: std::net::SocketAddr,
    log: Arc<Mutex<Vec<Attempt>>>,
}

impl Proxy {
    /// Listen at `listen` (`addr:port`, port 0 for any), letting through `allowed` only, and
    /// log every attempt to `log_path`.
    pub fn start(listen: &str, allowed: Vec<Endpoint>, log_path: &Path) -> Result<Self> {
        let listener =
            TcpListener::bind(listen).with_context(|| format!("egress proxy: binding {listen}"))?;
        let addr = listener.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let log = Arc::new(Mutex::new(Vec::new()));
        std::fs::write(log_path, b"").with_context(|| format!("writing {}", log_path.display()))?;
        let allowed = Arc::new(allowed);
        {
            let (stop, log, log_path) = (Arc::clone(&stop), Arc::clone(&log), log_path.to_owned());
            std::thread::spawn(move || {
                for conn in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(conn) = conn else { continue };
                    let (allowed, log, log_path) =
                        (Arc::clone(&allowed), Arc::clone(&log), log_path.clone());
                    std::thread::spawn(move || {
                        let attempt = serve(conn, &allowed);
                        record(&log, &log_path, attempt);
                    });
                }
            });
        }
        Ok(Self {
            port: addr.port(),
            stop,
            addr,
            log,
        })
    }

    /// The port it listens on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Every attempt so far.
    pub fn attempts(&self) -> Vec<Attempt> {
        self.log.lock().map(|l| l.clone()).unwrap_or_default()
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // wake the accept loop so it sees the flag
        let _ = TcpStream::connect_timeout(&self.addr, Duration::from_millis(200));
    }
}

/// Append `attempt` to the log and its file (`<ms> <verdict> <target>`).
fn record(log: &Mutex<Vec<Attempt>>, path: &Path, attempt: Option<Attempt>) {
    let Some(a) = attempt else { return };
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(path) {
        let _ = writeln!(f, "{} {} {}", a.at, a.verdict.word(), a.target);
    }
    if let Ok(mut l) = log.lock() {
        l.push(a);
    }
}

/// Serve one connection: read its request head, judge it, and either tunnel it or refuse it.
/// `None` for a connection that sent nothing (the proxy's own wake-up, a port scan).
fn serve(mut client: TcpStream, allowed: &[Endpoint]) -> Option<Attempt> {
    let _ = client.set_read_timeout(Some(HEAD_TIMEOUT));
    let head = read_head(&client)?;
    let at = crate::run::now_ms();
    let target = match connect_target(&head) {
        Request::Connect(t) => t,
        Request::Other => {
            let _ = client
                .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n");
            return Some(Attempt {
                at,
                target: first_line_target(&head),
                verdict: Verdict::NotConnect,
            });
        }
    };
    let shown = target
        .as_ref()
        .map_or_else(|| first_line_target(&head), ToString::to_string);
    let Some(endpoint) = target.filter(|t| allowed.contains(t)) else {
        let _ = client.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return Some(Attempt {
            at,
            target: shown,
            verdict: Verdict::Denied,
        });
    };
    let upstream = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| {
            addrs.find_map(|a| TcpStream::connect_timeout(&a, HEAD_TIMEOUT).ok())
        });
    let Some(upstream) = upstream else {
        let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        return Some(Attempt {
            at,
            target: shown,
            verdict: Verdict::Unreachable,
        });
    };
    if client
        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
        .is_err()
    {
        return None;
    }
    let _ = client.set_read_timeout(None);
    tunnel(client, upstream);
    Some(Attempt {
        at,
        target: shown,
        verdict: Verdict::Allowed,
    })
}

/// The request head (up to the blank line), or `None` when nothing came.
fn read_head(client: &TcpStream) -> Option<String> {
    let mut r = BufReader::new(client.try_clone().ok()?.take(MAX_HEAD as u64));
    let mut head = String::new();
    loop {
        let mut line = String::new();
        match r.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let end = line == "\r\n" || line == "\n";
                head.push_str(&line);
                if end {
                    break;
                }
            }
        }
    }
    (!head.trim().is_empty()).then_some(head)
}

/// What a request asks for.
enum Request {
    /// `CONNECT`: its target, when it is `host:port` over HTTP/1.x.
    Connect(Option<Endpoint>),
    /// Anything else.
    Other,
}

/// What `head` asks for.
fn connect_target(head: &str) -> Request {
    let mut parts = head.lines().next().unwrap_or_default().split_whitespace();
    if !parts
        .next()
        .is_some_and(|m| m.eq_ignore_ascii_case("CONNECT"))
    {
        return Request::Other;
    }
    let target = parts.next().unwrap_or_default();
    let version_ok = parts.next().is_some_and(|v| v.starts_with("HTTP/1."));
    Request::Connect(Endpoint::parse(target).filter(|_| version_ok))
}

/// What a request's first line names, for the log: its target, cut short and printable.
fn first_line_target(head: &str) -> String {
    let line = head.lines().next().unwrap_or_default();
    let t = line.split_whitespace().nth(1).unwrap_or(line);
    t.chars()
        .filter(char::is_ascii_graphic)
        .take(120)
        .collect()
}

/// Copy bytes both ways until either side closes.
fn tunnel(client: TcpStream, upstream: TcpStream) {
    let (Ok(mut c2), Ok(mut u2)) = (client.try_clone(), upstream.try_clone()) else {
        return;
    };
    let (mut client, mut upstream) = (client, upstream);
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut c2, &mut u2);
        let _ = u2.shutdown(Shutdown::Write);
    });
    let _ = std::io::copy(&mut upstream, &mut client);
    let _ = client.shutdown(Shutdown::Write);
    let _ = up.join();
}

/// A summary of `attempts`: each target once, with its verdict and how many times.
pub fn summary(attempts: &[Attempt]) -> Vec<String> {
    let mut seen: std::collections::BTreeMap<(String, &'static str), usize> =
        std::collections::BTreeMap::new();
    for a in attempts {
        *seen.entry((a.target.clone(), a.verdict.word())).or_default() += 1;
    }
    seen.into_iter()
        .map(|((t, v), n)| format!("{v} {t} ×{n}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(port: u16, request: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(request.as_bytes()).unwrap();
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        let mut out = vec![0u8; 64];
        let n = s.read(&mut out).unwrap_or(0);
        String::from_utf8_lossy(&out[..n]).into_owned()
    }

    fn wait_for(p: &Proxy, n: usize) -> Vec<Attempt> {
        for _ in 0..100 {
            let a = p.attempts();
            if a.len() >= n {
                return a;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        p.attempts()
    }

    #[test]
    fn endpoints_are_host_and_port_only() {
        assert_eq!(
            Endpoint::parse("API.Example.com:443"),
            Some(Endpoint {
                host: "api.example.com".into(),
                port: 443
            })
        );
        for bad in [
            "api.example.com",
            "https://api.example.com:443",
            "user@api.example.com:443",
            "api.example.com:0",
            "api.example.com:99999",
            ":443",
            "a/b:443",
            "[::1]:443",
        ] {
            assert_eq!(Endpoint::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn only_listed_endpoints_are_tunnelled_and_every_attempt_is_logged() {
        // an "AI service" on loopback that answers with a greeting
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let up_port = upstream.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = upstream.accept() {
                let _ = s.write_all(b"hello from the service");
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("egress.log");
        let allowed = vec![Endpoint::parse(&format!("127.0.0.1:{up_port}")).unwrap()];
        let p = Proxy::start("127.0.0.1:0", allowed, &log).unwrap();

        let got = ask(
            p.port(),
            &format!("CONNECT 127.0.0.1:{up_port} HTTP/1.1\r\nHost: x\r\n\r\n"),
        );
        assert!(got.starts_with("HTTP/1.1 200"), "{got}");
        let got = ask(p.port(), "CONNECT example.com:443 HTTP/1.1\r\n\r\n");
        assert!(got.starts_with("HTTP/1.1 403"), "{got}");
        let got = ask(p.port(), "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
        assert!(got.starts_with("HTTP/1.1 405"), "{got}");

        let attempts = wait_for(&p, 3);
        let verdicts: Vec<_> = attempts
            .iter()
            .map(|a| (a.target.clone(), a.verdict.clone()))
            .collect();
        assert!(verdicts.contains(&(format!("127.0.0.1:{up_port}"), Verdict::Allowed)));
        assert!(verdicts.contains(&("example.com:443".into(), Verdict::Denied)));
        assert!(verdicts.contains(&("http://example.com/".into(), Verdict::NotConnect)));
        let text = std::fs::read_to_string(&log).unwrap();
        assert_eq!(text.lines().count(), 3, "{text}");
        assert!(text.contains(" deny example.com:443"), "{text}");
        assert!(summary(&attempts)
            .iter()
            .any(|l| l == "deny example.com:443 ×1"));
    }

    #[test]
    fn a_connect_to_a_listed_host_on_another_port_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let p = Proxy::start(
            "127.0.0.1:0",
            vec![Endpoint::parse("api.example.com:443").unwrap()],
            &dir.path().join("e.log"),
        )
        .unwrap();
        let got = ask(p.port(), "CONNECT api.example.com:22 HTTP/1.1\r\n\r\n");
        assert!(got.starts_with("HTTP/1.1 403"), "{got}");
        assert_eq!(wait_for(&p, 1)[0].verdict, Verdict::Denied);
    }
}
