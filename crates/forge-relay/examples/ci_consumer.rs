//! Reference CI consumer (PRD 05 §CI integration / Acceptance).
//!
//! This is the pattern a CI provider (or a self-hosted runner) implements to consume relay
//! webhooks *without trusting the relay*:
//!
//!  1. Receive the webhook and **verify the HMAC-SHA256 signature** (`X-Hub-Signature-256`).
//!  2. **Re-fetch the referenced state from Platform** and verify it independently — here,
//!     for a `push`, confirm by forge's own rules that a valid update of the ref set it to
//!     `after`. A tampered relay that altered the payload is detected here, which is the
//!     whole trust model: the relay is availability-only.
//!  3. **Write a `checkRun` doc back** through the runner's own identity (a writer or
//!     maintainer of the repo) — closing the CI loop forge-web renders. (Best-effort: if it
//!     is not a member the write is reported as skipped, not fatal.)
//!
//! Run it:
//! ```text
//! FORGE_RELAY_SECRET=shared-secret \
//! CI_IDENTITY=/path/CI-RUNNER.identity.json \
//! CI_REPO=<forge-v2 repo id> CI_NETWORK=devnet DASH_FORGE_DEVNET_NAME=moutai \
//! CI_LISTEN=127.0.0.1:9099 \
//! cargo run -p forge-relay --example ci_consumer
//! ```
//! `CI_IDENTITY` is optional: without it the consumer verifies and logs but writes no
//! `checkRun`.

use std::collections::BTreeMap;
use std::env;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use forge_core::keystore::BridgeIdentity;
use forge_core::platform::{FieldValue, Network, PlatformClient, WriteEngine};
use forge_core::webhooks::verify_signature as verify;

/// A parsed HTTP request: method/path plus lowercased headers and the raw body.
struct HttpRequest {
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let secret = env::var("FORGE_RELAY_SECRET")
        .map_err(|_| anyhow::anyhow!("set FORGE_RELAY_SECRET to the webhook HMAC secret"))?;
    let listen = env::var("CI_LISTEN").unwrap_or_else(|_| "127.0.0.1:9099".to_string());
    let ci_identity = env::var("CI_IDENTITY").ok();
    // SECURITY: the verification repo is CONFIGURED, never taken from the payload. The
    // relay is untrusted; if the consumer picked the repo from `repository`, a malicious
    // relay would point verification at a repo it controls and defeat the whole
    // re-fetch-and-verify defense this example exists to demonstrate. So CI_REPO is
    // mandatory — the consumer only ever verifies against the repo it was told to trust.
    let ci_repo = env::var("CI_REPO").map_err(|_| {
        anyhow::anyhow!(
            "set CI_REPO to the EXPECTED forge-v2 repo id (base58). The verification target \
             must be configured, never derived from the (untrusted) webhook payload."
        )
    })?;
    // CI_NETWORK selects the kind; a devnet also reads DASH_FORGE_DEVNET_NAME /
    // DASH_FORGE_DAPI_ADDRESSES (forge_core::network's env layer).
    let network = forge_core::network::NetworkSettings {
        network: env::var("CI_NETWORK").ok(),
        ..Default::default()
    }
    .overlay(forge_core::network::NetworkSettings::from_env())
    .resolve()?
    .network;

    let listener = TcpListener::bind(&listen).await?;
    tracing::info!(%listen, ci_repo = %ci_repo, "reference CI consumer listening");

    loop {
        let (stream, _peer) = listener.accept().await?;
        let secret = secret.clone();
        let ci_identity = ci_identity.clone();
        let ci_repo = ci_repo.clone();
        if let Err(e) = handle(stream, &secret, ci_identity.as_deref(), &ci_repo, &network).await {
            tracing::warn!(error = %e, "request handling failed");
        }
    }
}

async fn handle(
    mut stream: TcpStream,
    secret: &str,
    ci_identity: Option<&str>,
    ci_repo: &str,
    network: &Network,
) -> anyhow::Result<()> {
    let req = read_request(&mut stream).await?;

    let sig = req
        .headers
        .get("x-hub-signature-256")
        .cloned()
        .unwrap_or_default();
    let event = req
        .headers
        .get("x-github-event")
        .cloned()
        .unwrap_or_default();
    let delivery = req
        .headers
        .get("x-github-delivery")
        .cloned()
        .unwrap_or_default();

    // 1. Verify the HMAC signature.
    if !verify(secret.as_bytes(), &req.body, &sig) {
        tracing::warn!(event, delivery, "SIGNATURE INVALID — rejecting (401)");
        respond(&mut stream, 401, "invalid signature").await?;
        return Ok(());
    }
    tracing::info!(event, delivery, bytes = req.body.len(), "signature OK");

    let payload: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();

    // 2. Independently verify against Platform (push: confirm the after-oid is on-chain).
    if event == "push" {
        if let Err(e) = verify_and_check_run(&payload, ci_identity, ci_repo, network).await {
            tracing::warn!(error = %e, "platform verification / checkRun write encountered an issue");
        }
    }

    respond(&mut stream, 200, "ok").await?;
    Ok(())
}

/// Re-fetch the pushed ref state from Platform and, if a CI identity is configured, write a
/// `checkRun` doc back. `ci_repo` is the CONFIGURED expected repo id — never the
/// payload's own `repository` (which the untrusted relay controls).
async fn verify_and_check_run(
    payload: &serde_json::Value,
    ci_identity: Option<&str>,
    ci_repo: &str,
    network: &Network,
) -> anyhow::Result<()> {
    let after = payload["after"].as_str().unwrap_or_default().to_string();
    let ref_name = payload["ref"].as_str().unwrap_or_default();
    // If the payload names a different repo than the one we trust, that is a red flag
    // (a tampered/misrouted delivery) — log it, but verify against the CONFIGURED repo only.
    if let Some(claimed) = payload["repository"]["dash_repo_id"].as_str() {
        if claimed != ci_repo {
            tracing::warn!(
                claimed,
                trusted = ci_repo,
                "payload repository id does not match the configured CI_REPO; verifying against CI_REPO only"
            );
        }
    }
    let repo_id = ci_repo.to_string();

    let client = PlatformClient::connect_network(network.clone()).await?;
    let repo = forge_core::resolve::resolve_id(&client, &repo_id).await?;
    let forge = repo.require_v2()?.clone();
    let scope = repo.scope()?;

    // Independent verification: did a *valid* update of this ref set it to `after`? forge's
    // own rule decides validity (legal name bound to its hash; on a protected ref, only a
    // maintainer's protectedRefUpdate counts). "The oid appears in some update" is not
    // enough: a writer's plain refUpdate on a protected branch lands on chain but moves
    // nothing. Not "is it the current tip" either: a later push must not fail this build. A
    // tampered relay payload fails here too.
    let tips = forge_core::repo::read_valid_tips(&client, &repo, ref_name).await?;
    let verified = tips.contains(&after);
    tracing::info!(
        after,
        ref_name,
        verified,
        "re-fetched ref history from Platform"
    );

    let conclusion = if verified { "success" } else { "failure" };
    let summary = if verified {
        format!("Verified push to {ref_name}: a valid update on Platform set it to {after}.")
    } else {
        format!("REJECTED: no valid update on Platform set {ref_name} to {after}.")
    };

    // 3. Write a checkRun doc back (best-effort — needs writer or maintainer on the repo).
    let Some(identity_path) = ci_identity else {
        tracing::info!("no CI_IDENTITY set — skipping checkRun write (verification-only mode)");
        return Ok(());
    };
    let bridge = BridgeIdentity::load_from_file(identity_path)?;
    let identity = client.fetch_identity(&bridge.identity_id).await?;
    let engine = WriteEngine::new(&client, &identity, bridge.doc_op_key()?)?;

    let after_bytes = hex::decode(&after).unwrap_or_default();
    let props: BTreeMap<String, FieldValue> = scope.props([
        ("headOid", FieldValue::bytes(after_bytes)),
        ("name", FieldValue::text("dash-forge-ci")),
        ("status", FieldValue::text("completed")),
        ("conclusion", FieldValue::text(conclusion)),
        ("summary", FieldValue::text(summary)),
    ]);
    let collab = client.fetch_contract(&forge.collab).await?;

    match engine.create_document(&collab, "checkRun", props).await {
        Ok(id) => {
            tracing::info!(check_run_doc = %id, conclusion, "wrote checkRun back to Platform (CI loop closed)");
        }
        Err(e) => {
            tracing::warn!(error = %e, "checkRun write skipped (the CI identity must be a writer or maintainer of the repo)");
        }
    }
    Ok(())
}

/// Read an HTTP/1.1 request (headers + Content-Length body) from `stream`.
async fn read_request(stream: &mut TcpStream) -> anyhow::Result<HttpRequest> {
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    // Read until we have the full header block.
    let header_end = loop {
        if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
            break pos;
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            anyhow::bail!("connection closed before headers completed");
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    let header_text = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut headers = BTreeMap::new();
    for line in header_text.split("\r\n").skip(1) {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let content_length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let body_start = header_end + 4;
    let mut body = buf[body_start..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(content_length);

    Ok(HttpRequest { headers, body })
}

async fn respond(stream: &mut TcpStream, status: u16, body: &str) -> anyhow::Result<()> {
    let reason = if status == 200 { "OK" } else { "Unauthorized" };
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.shutdown().await?;
    Ok(())
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
