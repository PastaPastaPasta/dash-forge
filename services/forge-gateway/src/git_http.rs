//! Smart-HTTP git through stock `git http-backend` (CGI), streamed both ways: only
//! `info/refs?service=git-upload-pack` and `git-upload-pack` reach it. Each mirror is
//! configured with `http.getanyfile=false` (no dumb file serving) and `http.receivepack=false`
//! (no push), so even a request that slipped past the router could only read refs and packs.

use std::future::Future as _;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use axum::body::Body;
use axum::http::{HeaderName, HeaderValue, Response, StatusCode};
use bytes::Bytes;
use futures::Stream;
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::process::{Child, ChildStdout};
use tokio_util::io::ReaderStream;

use crate::metrics::Metrics;
use crate::mirror::Mirrors;

/// The most a CGI header block may hold.
const MAX_HEADER_BYTES: usize = 16 * 1024;

/// One request for `git http-backend`.
#[derive(Debug, Clone, Default)]
pub struct BackendRequest {
    /// `GET` or `POST`.
    pub method: String,
    /// `/<repo id>.git/info/refs` or `/<repo id>.git/git-upload-pack`.
    pub path_info: String,
    /// The query string (`service=git-upload-pack`).
    pub query: String,
    /// `Content-Type`.
    pub content_type: Option<String>,
    /// `Content-Encoding` (`gzip` only is passed through).
    pub content_encoding: Option<String>,
    /// `Git-Protocol` (`version=2`), when well-formed.
    pub git_protocol: Option<String>,
    /// The request body (bounded by the caller).
    pub body: Bytes,
}

/// Whether a `Git-Protocol` header is one git could have sent (`version=2`, `key=value:...`).
pub fn valid_git_protocol(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 256
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"=:.,_-".contains(&b))
}

/// Run `git http-backend` for `req` and stream its answer. `hold` lives as long as the body
/// streams (the mirror's serve guard, the concurrency permits); the backend is killed when the
/// client goes away or `timeout` passes.
pub async fn serve(
    mirrors: &Mirrors,
    metrics: Arc<Metrics>,
    req: BackendRequest,
    hold: Vec<Box<dyn Send + Sync>>,
    timeout: Duration,
) -> Result<Response<Body>> {
    let mut c = mirrors.git(mirrors.root());
    c.arg("http-backend")
        .env("GIT_PROJECT_ROOT", mirrors.root())
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("PATH_INFO", &req.path_info)
        .env("REQUEST_METHOD", &req.method)
        .env("QUERY_STRING", &req.query)
        .env("CONTENT_LENGTH", req.body.len().to_string())
        // The client's address never reaches git (or its logs).
        .env("REMOTE_ADDR", "127.0.0.1")
        .env_remove("GIT_PROTOCOL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(ct) = &req.content_type {
        c.env("CONTENT_TYPE", ct);
    }
    if let Some(enc) = req
        .content_encoding
        .as_deref()
        .filter(|e| matches!(*e, "gzip" | "x-gzip"))
    {
        c.env("HTTP_CONTENT_ENCODING", enc);
    }
    if let Some(p) = req
        .git_protocol
        .as_deref()
        .filter(|p| valid_git_protocol(p))
    {
        c.env("GIT_PROTOCOL", p);
    }
    let mut child = c.spawn()?;
    let mut stdin = child.stdin.take().expect("piped");
    let body = req.body;
    tokio::spawn(async move {
        let _ = stdin.write_all(&body).await;
    });
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = (&mut stderr).take(4096).read_to_end(&mut buf).await;
            if !buf.is_empty() {
                tracing::debug!(stderr = %String::from_utf8_lossy(&buf).trim(), "git http-backend");
            }
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        });
    }
    let mut out = BufReader::new(child.stdout.take().expect("piped"));
    let (status, headers) =
        tokio::time::timeout(Duration::from_secs(60), read_cgi_headers(&mut out))
            .await
            .map_err(|_| anyhow!("git http-backend sent no headers"))??;
    let mut resp = Response::builder().status(status);
    for (k, v) in headers {
        if let (Ok(k), Ok(v)) = (HeaderName::try_from(k), HeaderValue::try_from(v)) {
            resp = resp.header(k, v);
        }
    }
    let stream = Streamed {
        inner: ReaderStream::with_capacity(out, 64 * 1024),
        _child: child,
        _hold: hold,
        deadline: Box::pin(tokio::time::sleep(timeout)),
        metrics,
    };
    Ok(resp.body(Body::from_stream(stream))?)
}

/// Read a CGI header block: `Status: 403 Forbidden` and the response headers.
async fn read_cgi_headers(
    out: &mut BufReader<ChildStdout>,
) -> Result<(StatusCode, Vec<(String, String)>)> {
    let mut status = StatusCode::OK;
    let mut headers = Vec::new();
    let mut read = 0usize;
    loop {
        let mut line = String::new();
        let n = out.read_line(&mut line).await?;
        if n == 0 {
            bail!("git http-backend ended before its headers did");
        }
        read += n;
        if read > MAX_HEADER_BYTES {
            bail!("git http-backend's headers are too long");
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            return Ok((status, headers));
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let v = v.trim();
        if k.eq_ignore_ascii_case("status") {
            status = v
                .split_whitespace()
                .next()
                .and_then(|c| c.parse::<u16>().ok())
                .and_then(|c| StatusCode::from_u16(c).ok())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        } else {
            headers.push((k.trim().to_string(), v.to_string()));
        }
    }
}

/// The backend's stdout as a body: ends at the deadline, and kills the backend when dropped
/// (the client went away).
struct Streamed {
    inner: ReaderStream<BufReader<ChildStdout>>,
    _child: Child,
    _hold: Vec<Box<dyn Send + Sync>>,
    deadline: Pin<Box<tokio::time::Sleep>>,
    metrics: Arc<Metrics>,
}

impl Stream for Streamed {
    type Item = std::io::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.deadline.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Some(Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "the response ran past the gateway's serve timeout",
            ))));
        }
        let next = Pin::new(&mut self.inner).poll_next(cx);
        if let Poll::Ready(Some(Ok(b))) = &next {
            self.metrics
                .git_bytes
                .fetch_add(b.len() as u64, Ordering::Relaxed);
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_protocol_header_is_checked() {
        assert!(valid_git_protocol("version=2"));
        assert!(valid_git_protocol("version=2:object-format=sha1"));
        assert!(!valid_git_protocol(""));
        assert!(!valid_git_protocol("version=2\nX: y"));
        assert!(!valid_git_protocol("version=2; rm -rf /"));
    }
}
