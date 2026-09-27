//! A minimal health/liveness HTTP listener (optional, `--listen`).
//!
//! Dependency-free (raw tokio TCP): answers any request with `200 OK` and
//! `{"status":"ok","durable":<bool>}` so a container orchestrator or load balancer can probe
//! the relay; `durable` is false when the retry queue fell back to memory (its state dir was
//! unusable), so an operator can alert on it. It never reads the request body and never
//! delivers anything.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::error::{RelayError, Result};

/// Serve health responses on `addr` until the task is dropped.
pub async fn serve(addr: &str, durable: bool) -> Result<()> {
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| RelayError::Io(format!("binding health listener on {addr}: {e}")))?;
    tracing::info!(%addr, "health listener up");
    loop {
        let (mut stream, _peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                tracing::warn!(error = %e, "health accept failed");
                continue;
            }
        };
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            // Best-effort read of the request line; ignore contents.
            let _ = stream.read(&mut buf).await;
            let body = format!("{{\"status\":\"ok\",\"durable\":{durable}}}");
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes()).await;
            let _ = stream.shutdown().await;
        });
    }
}
