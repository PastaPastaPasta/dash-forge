//! TEST FIXTURE ONLY: write one `checkRun` document, so an e2e scenario has a run for
//! `dg pr checks` to read. Nothing in the tools writes check runs yet: the writer and `dg ci`
//! belong to platform-parity I-1, so this stays out of the public API.
//!
//! ```text
//! DASH_FORGE_NETWORK=devnet DASH_FORGE_DEVNET_NAME=moutai \
//!   cargo run -p forge-core --example seed_check_run -- \
//!   <identity file> <repo id> <head oid> <name> <status> [conclusion] [details url]
//! ```
//!
//! The signer must be a maintainer or writer of the repo (consensus gates `checkRun`). Prints
//! the new document id.

use std::collections::BTreeMap;

use forge_core::keystore::BridgeIdentity;
use forge_core::platform::{FieldValue, PlatformClient, WriteEngine};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [identity, repo_id, head, name, status, rest @ ..] = args.as_slice() else {
        return Err(
            "usage: seed_check_run <identity file> <repo id> <head oid> <name> <status> [conclusion] [details url]"
                .into(),
        );
    };
    let target = forge_core::network::NetworkSettings::from_env().resolve()?;
    let client = PlatformClient::connect(target).await?;
    let repo = forge_core::resolve::resolve_id(&client, repo_id).await?;
    let bridge = BridgeIdentity::load_from_file(identity)?;
    let signer = client.fetch_identity(&bridge.identity_id).await?;
    let engine = WriteEngine::new(&client, &signer, bridge.doc_op_key()?)?;
    let mut props = BTreeMap::from([
        ("headOid".to_string(), FieldValue::bytes(hex::decode(head)?)),
        ("name".to_string(), FieldValue::text(name.as_str())),
        ("status".to_string(), FieldValue::text(status.as_str())),
    ]);
    // forge-community's checkRun rules: a run that has started records `startedAt`, a completed
    // one `completedAt` too (both set once).
    let now_ms = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis(),
    )?;
    if status != "queued" {
        props.insert("startedAt".into(), FieldValue::integer(now_ms));
    }
    if status == "completed" {
        props.insert("completedAt".into(), FieldValue::integer(now_ms));
    }
    if let Some(c) = rest.first() {
        props.insert("conclusion".into(), FieldValue::text(c.as_str()));
    }
    if let Some(u) = rest.get(1) {
        props.insert("detailsUrl".into(), FieldValue::text(u.as_str()));
    }
    let community = client.fetch_contract(&repo.forge().community).await?;
    let id = engine
        .create_document(&community, "checkRun", repo.scope()?.scoped(props))
        .await?;
    println!("{id}");
    Ok(())
}
