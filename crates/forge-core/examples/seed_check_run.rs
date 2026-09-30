//! TEST FIXTURE ONLY: report one check run, so an e2e scenario has a run for `dg pr checks` to
//! read.
//!
//! ```text
//! DASH_FORGE_NETWORK=devnet DASH_FORGE_DEVNET_NAME=bonsia \
//!   cargo run -p forge-core --example seed_check_run -- \
//!   <identity file> <repo id> <head oid> <name> <status> [conclusion] [details url]
//! ```
//!
//! It goes through forge-core's check-run writer ([`CheckRuns`], as `dg ci report` does), so
//! the document is what forge-community (RC1) accepts: `outcome`, the `vis` stamp, millisecond
//! times set once, and no text on a private repository. A report for a run that already exists
//! updates it. The signer must be a runner, maintainer or writer of the repo. Prints the
//! document id and what was done.

use forge_core::ci::{CheckReport, CheckRuns};
use forge_core::keystore::BridgeIdentity;
use forge_core::platform::PlatformClient;

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
    let report = CheckReport {
        head_oid: head.to_ascii_lowercase(),
        name: name.clone(),
        status: status.clone(),
        conclusion: rest.first().cloned(),
        details_url: rest.get(1).cloned(),
        ..CheckReport::default()
    };
    let done = CheckRuns::new(&client, &signer, &bridge)
        .report(&repo, &report)
        .await?;
    println!("{} {}", done.document_id, done.action);
    Ok(())
}
