//! A scripted local HTTP/1.1 server for unit tests: every request is answered by a closure
//! from its method and request headers, so a test can return a status a real store would
//! (AWS's 403 on HEAD) or repeat a response header on several lines (kubo's CORS headers),
//! which a mocking layer inside reqwest could not reproduce.

use std::fmt::Write as _;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::sync::{Arc, Mutex};

/// A request as the server saw it.
#[derive(Debug, Clone)]
pub struct Seen {
    /// `GET`, `HEAD`, `PUT`, …
    pub method: String,
    /// Header lines, names lower-cased, in order.
    pub headers: Vec<(String, String)>,
}

impl Seen {
    /// The first value of header `name` (lower-case).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// What to answer: status, header lines (repeats allowed) and body. `content-length` and
/// `connection: close` are added.
pub struct Reply {
    /// The status code.
    pub status: u16,
    /// Header lines, sent in order.
    pub headers: Vec<(&'static str, String)>,
    /// The body (not sent for HEAD; its length still is).
    pub body: Vec<u8>,
}

impl Reply {
    /// A reply with no extra headers.
    pub fn new(status: u16, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: body.into(),
        }
    }

    /// Add a header line.
    #[must_use]
    pub fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }
}

/// Serve `route` on 127.0.0.1; returns the base URL and the log of requests seen.
pub fn serve(
    route: impl Fn(&Seen) -> Reply + Send + Sync + 'static,
) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let log = Arc::new(Mutex::new(Vec::new()));
    let seen_log = Arc::clone(&log);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() || line.is_empty() {
                continue;
            }
            let method = line
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .to_string();
            let mut headers = Vec::new();
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
                    break;
                }
                if let Some((n, v)) = h.trim_end().split_once(':') {
                    headers.push((n.trim().to_ascii_lowercase(), v.trim().to_string()));
                }
            }
            let seen = Seen { method, headers };
            let len: usize = seen
                .header("content-length")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let mut body = vec![0u8; len];
            let _ = reader.read_exact(&mut body);
            let reply = route(&seen);
            let head_request = seen.method == "HEAD";
            seen_log.lock().unwrap().push(seen);
            let mut out = format!("HTTP/1.1 {} X\r\n", reply.status);
            for (n, v) in &reply.headers {
                let _ = write!(out, "{n}: {v}\r\n");
            }
            let _ = write!(
                out,
                "content-length: {}\r\nconnection: close\r\n\r\n",
                reply.body.len()
            );
            let _ = stream.write_all(out.as_bytes());
            if !head_request {
                let _ = stream.write_all(&reply.body);
            }
        }
    });
    (format!("http://{addr}"), log)
}
