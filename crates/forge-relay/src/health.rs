//! The optional HTTP listener (`--listen`): health, and runner wake-ups.
//!
//! Dependency-free (raw tokio TCP, one request per connection):
//!
//! * `GET /v1/wake?…` goes to the [`WakeHub`] when `[wake]` is configured (see
//!   [`crate::wake`]); without it, that path answers `404`.
//! * Any other request answers `200 OK` with `{"status":"ok","durable":<bool>}`, so a container
//!   orchestrator or load balancer can probe the relay; `durable` is false when the retry queue
//!   fell back to memory (its state dir was unusable), so an operator can alert on it.
//!
//! It never reads a request body and never delivers anything. Request heads are capped at
//! 8 KiB and must arrive within 10 s; at most [`MAX_WAITING`] wake requests are held open.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

use crate::error::{RelayError, Result};
use crate::wake::{self, Refusal, WakeHub};

/// The largest request head read.
const MAX_HEAD: usize = 8 * 1024;

/// How long a client has to send its request head.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);

/// Wake requests held open at once; more are answered `503` at once.
const MAX_WAITING: usize = 64;

/// Connections served at once (each is held at most [`HEAD_TIMEOUT`] before it is
/// authenticated); more are dropped.
const MAX_CONNECTIONS: usize = 256;

/// Serve on `addr` until the task is dropped.
pub async fn serve(addr: &str, durable: bool, wake: Option<Arc<WakeHub>>) -> Result<()> {
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| RelayError::Io(format!("binding the listener on {addr}: {e}")))?;
    tracing::info!(%addr, wake = wake.is_some(), "listener up");
    let waiting = Arc::new(Semaphore::new(MAX_WAITING));
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                // Out of file descriptors, most likely: do not spin.
                tracing::warn!(error = %e, "accept failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        // Past the cap the connection is dropped unanswered.
        let Ok(slot) = Arc::clone(&connections).try_acquire_owned() else {
            continue;
        };
        let (wake, waiting) = (wake.clone(), Arc::clone(&waiting));
        tokio::spawn(async move {
            let _ = handle(stream, durable, wake.as_deref(), &waiting).await;
            drop(slot);
        });
    }
}

/// A parsed request head: the method, the target (path and query) and the headers we read.
struct Head {
    method: String,
    target: String,
    time: Option<String>,
    signature: Option<String>,
}

/// Parse a request head read by [`read_head`]; `None` when it is not one.
fn parse_head(raw: &[u8]) -> Option<Head> {
    let text = std::str::from_utf8(raw).ok()?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target) = (first.next()?.to_string(), first.next()?.to_string());
    let mut head = Head {
        method,
        target,
        time: None,
        signature: None,
    };
    for line in lines {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        match k.trim().to_ascii_lowercase().as_str() {
            "x-forge-wake-time" => head.time = Some(v.trim().to_string()),
            "x-forge-wake-signature" => head.signature = Some(v.trim().to_string()),
            _ => {}
        }
    }
    Some(head)
}

/// Read the request head (up to the blank line), within [`HEAD_TIMEOUT`] and [`MAX_HEAD`].
async fn read_head(stream: &mut TcpStream) -> Option<Vec<u8>> {
    let mut buf = Vec::with_capacity(1024);
    let read = async {
        let mut chunk = [0u8; 1024];
        loop {
            let n = stream.read(&mut chunk).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                buf.truncate(end);
                return Some(());
            }
            if buf.len() > MAX_HEAD {
                return None;
            }
        }
    };
    tokio::time::timeout(HEAD_TIMEOUT, read).await.ok()??;
    Some(buf)
}

/// Write the response and close; `signature` is a wake answer's signature header.
async fn reply(
    stream: &mut TcpStream,
    status: &str,
    body: &str,
    signature: Option<&str>,
) -> std::io::Result<()> {
    let sig = signature.map_or_else(String::new, |s| {
        format!("X-Forge-Wake-Signature: {s}\r\nCache-Control: no-store\r\n")
    });
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{sig}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.shutdown().await
}

/// Refuse the request with `status` and `{"error": why}`.
async fn refuse(stream: &mut TcpStream, status: &str, why: &str) -> std::io::Result<()> {
    let body = serde_json::json!({ "error": why }).to_string();
    reply(stream, status, &body, None).await
}

/// Serve one connection: a wake request on [`wake::PATH`], a health answer elsewhere.
async fn handle(
    mut stream: TcpStream,
    durable: bool,
    wake: Option<&WakeHub>,
    waiting: &Semaphore,
) -> std::io::Result<()> {
    let head = read_head(&mut stream).await.and_then(|b| parse_head(&b));
    let Some(head) = head else {
        return refuse(&mut stream, "400 Bad Request", "bad request").await;
    };
    let (path, query) = head
        .target
        .split_once('?')
        .unwrap_or((head.target.as_str(), ""));
    if path != wake::PATH {
        let body = format!("{{\"status\":\"ok\",\"durable\":{durable}}}");
        return reply(&mut stream, "200 OK", &body, None).await;
    }
    let Some(hub) = wake else {
        return refuse(&mut stream, "404 Not Found", "no [wake] configured").await;
    };
    if head.method != "GET" {
        return refuse(&mut stream, "405 Method Not Allowed", "GET only").await;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    // The query is checked first: a malformed request never reaches the replay guard.
    let checked = wake::parse_query(query).and_then(|q| {
        hub.authenticate(
            &head.target,
            head.time.as_deref(),
            head.signature.as_deref(),
            now,
        )?;
        Ok(q)
    });
    let q = match checked {
        Ok(q) => q,
        Err(Refusal::BadRequest(why)) => {
            return refuse(&mut stream, "400 Bad Request", why).await;
        }
        Err(Refusal::Unauthorized) => {
            return refuse(&mut stream, "401 Unauthorized", "unauthorized").await;
        }
    };
    let Ok(_slot) = waiting.try_acquire() else {
        return refuse(&mut stream, "503 Service Unavailable", "busy").await;
    };
    let signature = head.signature.unwrap_or_default();
    let (body, sig) = hub.respond(&q, &signature).await;
    reply(&mut stream, "200 OK", &body, Some(&sig)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::envelope::SecretBytes;
    use forge_core::webhooks::{sign_body, verify_signature};
    use std::collections::BTreeMap;

    const SECRET: &[u8] = b"a-shared-wake-secret-of-32-bytes-or-more";

    async fn get(addr: &str, target: &str, headers: &str) -> (String, String) {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(format!("GET {target} HTTP/1.1\r\nHost: x\r\n{headers}\r\n").as_bytes())
            .await
            .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        let (head, body) = out.split_once("\r\n\r\n").unwrap();
        (head.to_string(), body.to_string())
    }

    #[tokio::test]
    async fn health_elsewhere_and_signed_wakes_on_the_wake_path() {
        let hub = Arc::new(WakeHub::new(
            SecretBytes::new(SECRET.to_vec()),
            BTreeMap::from([(
                "R1".to_string(),
                crate::wake::WakeRepo {
                    name: "O/one".into(),
                    label: "alice/one".into(),
                },
            )]),
        ));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        drop(listener);
        let server = {
            let (addr, hub) = (addr.clone(), Arc::clone(&hub));
            tokio::spawn(async move { serve(&addr, true, Some(hub)).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;

        let (head, body) = get(&addr, "/healthz", "").await;
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert_eq!(body, "{\"status\":\"ok\",\"durable\":true}");

        let target = "/v1/wake?wait=0&nonce=0123456789abcdef";
        let (head, _) = get(&addr, target, "").await;
        assert!(head.starts_with("HTTP/1.1 401"), "unsigned: {head}");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let sig = sign_body(SECRET, wake::request_message(target, now).as_bytes());
        let hdrs = format!("X-Forge-Wake-Time: {now}\r\nX-Forge-Wake-Signature: {sig}\r\n");
        let (head, body) = get(&addr, target, &hdrs).await;
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        let answer_sig = head
            .lines()
            .find_map(|l| l.strip_prefix("X-Forge-Wake-Signature: "))
            .unwrap();
        assert!(verify_signature(
            SECRET,
            &wake::response_message(&sig, body.as_bytes()),
            answer_sig
        ));
        let (head, _) = get(&addr, target, &hdrs).await;
        assert!(head.starts_with("HTTP/1.1 401"), "a replay: {head}");
        server.abort();
    }
}
