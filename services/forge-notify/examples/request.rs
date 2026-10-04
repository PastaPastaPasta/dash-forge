//! Send one signed request to a forge-notify service, signed by a key of a bridge-format
//! identity file (what `dg auth export --reveal-secrets` writes): a command-line client for
//! operators and tests. The private key is read from the file and never printed.
//!
//! ```sh
//! cargo run -p forge-notify --example request -- \
//!   --url http://127.0.0.1:8080 --operator notify.example.org \
//!   --identity-file alice.identity.json --key 1 \
//!   --action email.set --payload '{"email":"alice@example.org"}'
//! ```

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use clap::Parser;
use rand::RngCore as _;
use serde_json::{json, Value};

#[derive(Debug, Parser)]
struct Args {
    /// The service's base URL.
    #[arg(long)]
    url: String,
    /// The operator name the service expects (its `/v1/info` says).
    #[arg(long)]
    operator: String,
    /// A bridge-format identity file.
    #[arg(long)]
    identity_file: std::path::PathBuf,
    /// The key id to sign with (an AUTHENTICATION HIGH or CRITICAL key).
    #[arg(long)]
    key: u32,
    /// The action.
    #[arg(long)]
    action: String,
    /// The payload JSON.
    #[arg(long, default_value = "{}")]
    payload: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let a = Args::parse();
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&a.identity_file)?)?;
    let identity = file["identityId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("no identityId in the file"))?;
    let key = file["identityKeys"]
        .as_array()
        .and_then(|ks| {
            ks.iter()
                .find(|k| k["id"].as_u64() == Some(u64::from(a.key)))
        })
        .and_then(|k| k["privateKeyHex"].as_str())
        .ok_or_else(|| anyhow::anyhow!("no private key {} in the file", a.key))?;
    let secret = secp256k1::SecretKey::from_slice(&zeroize::Zeroizing::new(hex::decode(key)?))?;
    let mut nonce = [0u8; 18];
    rand::thread_rng().fill_bytes(&mut nonce);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let request = json!({
        "v": 1,
        "service": a.operator,
        "action": a.action,
        "identity": identity,
        "key": a.key,
        "nonce": URL_SAFE_NO_PAD.encode(nonce),
        "time": time,
        "payload": serde_json::from_str::<Value>(&a.payload)?,
    })
    .to_string();
    let body = json!({
        "request": request,
        "signature": forge_notify::auth::sign(&request, &secret),
    });
    let res = reqwest::Client::new()
        .post(format!("{}/v1/request", a.url.trim_end_matches('/')))
        .json(&body)
        .send()
        .await?;
    let status = res.status();
    println!("{status}\n{}", res.text().await?);
    if !status.is_success() {
        std::process::exit(1);
    }
    Ok(())
}
