//! Reference CI consumer (PRD 05 §CI integration / Acceptance).
//!
//! This is the pattern a CI provider (or a self-hosted runner) implements to consume relay
//! webhooks *without trusting the relay*:
//!
//!  1. Receive the webhook and **verify the HMAC-SHA256 signature** (`X-Hub-Signature-256`).
//!  2. **Re-fetch the referenced state from Platform** and verify it independently — here,
//!     for a `push`, confirm the `after` oid actually appears in the repo's `refUpdate`
//!     history on-chain. A tampered relay that altered the payload is detected here (the
//!     oid it invented is not on Platform), which is the whole trust model: the relay is
//!     availability-only.
//!  3. **Write a `checkRun` doc back** through the runner's own identity holding a WRITE
//!     token — closing the CI loop that forge-web renders. (Best-effort: if the CI identity
//!     lacks WRITE on the repo the write is reported as skipped, not fatal.)
//!
//! Run it:
//! ```text
//! FORGE_RELAY_SECRET=shared-secret \
//! CI_IDENTITY=/path/CI-RUNNER.identity.json \
//! CI_REPO=<repoContractId> \
//! CI_LISTEN=127.0.0.1:9099 \
//! cargo run -p forge-relay --example ci_consumer
//! ```
//! `CI_IDENTITY`/`CI_REPO` are optional — without them it verifies + logs but writes no
//! `checkRun`.

use std::collections::BTreeMap;
use std::env;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use forge_core::keystore::BridgeIdentity;
use forge_core::platform::{FieldValue, Network, PlatformClient, QueryOrder, WriteEngine};

type HmacSha256 = Hmac<Sha256>;

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
    // SECURITY: the verification contract is CONFIGURED, never taken from the payload. The
    // relay is untrusted; if the consumer picked the contract from `repository`, a malicious
    // relay would point verification at a contract it controls and defeat the whole
    // re-fetch-and-verify defense this example exists to demonstrate. So CI_REPO is
    // mandatory — the consumer only ever verifies against the repo it was told to trust.
    let ci_repo = env::var("CI_REPO").map_err(|_| {
        anyhow::anyhow!(
            "set CI_REPO to the EXPECTED repo contract id (base58). The verification target \
             must be configured, never derived from the (untrusted) webhook payload."
        )
    })?;
    let network = match env::var("CI_NETWORK").as_deref() {
        Ok("mainnet") => Network::Mainnet,
        Ok("devnet") => Network::Devnet,
        _ => Network::Testnet,
    };

    let listener = TcpListener::bind(&listen).await?;
    tracing::info!(%listen, ci_repo = %ci_repo, "reference CI consumer listening");

    loop {
        let (stream, _peer) = listener.accept().await?;
        let secret = secret.clone();
        let ci_identity = ci_identity.clone();
        let ci_repo = ci_repo.clone();
        if let Err(e) = handle(stream, &secret, ci_identity.as_deref(), &ci_repo, network).await {
            tracing::warn!(error = %e, "request handling failed");
        }
    }
}

async fn handle(
    mut stream: TcpStream,
    secret: &str,
    ci_identity: Option<&str>,
    ci_repo: &str,
    network: Network,
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
/// `checkRun` doc back. `ci_repo` is the CONFIGURED expected contract id — never the
/// payload's own `repository` (which the untrusted relay controls).
async fn verify_and_check_run(
    payload: &serde_json::Value,
    ci_identity: Option<&str>,
    ci_repo: &str,
    network: Network,
) -> anyhow::Result<()> {
    let after = payload["after"].as_str().unwrap_or_default().to_string();
    let ref_name = payload["ref"].as_str().unwrap_or_default();
    // If the payload names a different contract than the one we trust, that is a red flag
    // (a tampered/misrouted delivery) — log it, but verify against the CONFIGURED repo only.
    if let Some(claimed) = payload["repository"]["dash_contract_id"].as_str() {
        if claimed != ci_repo {
            tracing::warn!(
                claimed,
                trusted = ci_repo,
                "payload repository contract id does not match the configured CI_REPO; verifying against CI_REPO only"
            );
        }
    }
    let repo_id = ci_repo.to_string();

    let client = PlatformClient::connect(network).await?;
    let contract = client.fetch_contract(&repo_id).await?;

    // Independent verification: does the after-oid actually exist in the repo's refUpdate
    // history on Platform? (A tampered relay payload would fail here.)
    let mut on_chain = false;
    for doc_type in ["refUpdate", "protectedRefUpdate"] {
        let docs = client
            .query_documents(
                &contract,
                doc_type,
                &[],
                &[QueryOrder::desc("$createdAt")],
                100,
                None,
            )
            .await?;
        if docs
            .iter()
            .any(|d| d.field_hex("newOid").as_deref() == Some(after.as_str()))
        {
            on_chain = true;
            break;
        }
    }
    tracing::info!(
        after,
        ref_name,
        on_chain,
        "re-fetched push state from Platform"
    );

    let conclusion = if on_chain { "success" } else { "failure" };
    let summary = if on_chain {
        format!("Verified push to {ref_name}: after-oid {after} is present on Platform.")
    } else {
        format!("REJECTED: after-oid {after} for {ref_name} was NOT found on Platform (possible tampered relay).")
    };

    // 3. Write a checkRun doc back (best-effort — needs WRITE on the repo).
    let Some(identity_path) = ci_identity else {
        tracing::info!("no CI_IDENTITY set — skipping checkRun write (verification-only mode)");
        return Ok(());
    };
    let bridge = BridgeIdentity::load_from_file(identity_path)?;
    let identity = client.fetch_identity(&bridge.identity_id).await?;
    let engine = WriteEngine::new(&client, &identity, bridge.doc_op_key()?)?;

    let after_bytes = hex::decode(&after).unwrap_or_default();
    let mut props: BTreeMap<String, FieldValue> = BTreeMap::new();
    props.insert("headOid".into(), FieldValue::bytes(after_bytes));
    props.insert("name".into(), FieldValue::text("dash-forge-ci"));
    props.insert("status".into(), FieldValue::text("completed"));
    props.insert("conclusion".into(), FieldValue::text(conclusion));
    props.insert("summary".into(), FieldValue::text(summary));

    match engine.create_document(&contract, "checkRun", props).await {
        Ok(id) => {
            tracing::info!(check_run_doc = %id, conclusion, "wrote checkRun back to Platform (CI loop closed)");
        }
        Err(e) => {
            tracing::warn!(error = %e, "checkRun write skipped (CI identity likely lacks a WRITE token on this repo)");
        }
    }
    Ok(())
}

/// Constant-time verify a `sha256=<hex>` signature.
fn verify(secret: &[u8], body: &[u8], signature_header: &str) -> bool {
    let Some(hex_sig) = signature_header.strip_prefix("sha256=") else {
        return false;
    };
    let Ok(expected) = hex::decode(hex_sig) else {
        return false;
    };
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key");
    mac.update(body);
    mac.verify_slice(&expected).is_ok()
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
