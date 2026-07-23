//! Out-of-protocol admin commands used to provision and inspect `dash://` repos.
//!
//! These are not part of the git remote-helper protocol; they are a thin CLI over
//! `forge-core`'s [`RepoService`] so the M1 round-trip can create a repo, check the
//! signing identity's balance, and refund deletable storage after the test. The real,
//! polished surface for this is `dg` (PRD 02 §B); this is the minimal helper-local shim.

use anyhow::{anyhow, bail, Context, Result};
use tokio::runtime::Runtime;

use forge_core::keystore::BridgeIdentity;
use forge_core::platform::PlatformClient;
use forge_core::repo::{credits_to_dash, CreateRepoOpts, RepoService};

use crate::helper::network_from_env;

/// The `CreateRepoOpts` the M1 provisioning path uses (default branch `main`, platform
/// backend). Shared by the create and resume flows so they stay in lockstep.
fn m1_repo_opts() -> CreateRepoOpts {
    CreateRepoOpts {
        default_branch: "main".to_string(),
        backend_mode: 0,
        description: "Dash Forge M1 round-trip test repo".to_string(),
        template_version: 1,
    }
}

/// Dispatch an admin subcommand (`args[0]` is the `--…` verb).
pub fn run(rt: &Runtime, args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("--create-repo") => {
            let name = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: git-remote-dash --create-repo <name>"))?;
            rt.block_on(create_repo(name))
        }
        Some("--balance") => rt.block_on(balance()),
        Some("--resume-repo") => {
            let name = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: git-remote-dash --resume-repo <name>"))?;
            rt.block_on(resume_repo(name))
        }
        Some("--teardown") => {
            let owner = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: git-remote-dash --teardown <owner> <repo>"))?;
            let repo = args
                .get(2)
                .ok_or_else(|| anyhow!("usage: git-remote-dash --teardown <owner> <repo>"))?;
            rt.block_on(teardown(owner, repo))
        }
        other => bail!("unknown admin command {other:?}"),
    }
}

/// Load the signing identity named by `DASH_FORGE_KEY` and connect to the configured
/// network.
async fn connect() -> Result<(PlatformClient, BridgeIdentity)> {
    let key_path = std::env::var_os("DASH_FORGE_KEY")
        .ok_or_else(|| anyhow!("DASH_FORGE_KEY must point at the identity JSON for admin ops"))?;
    let bridge = BridgeIdentity::load_from_file(&key_path)
        .with_context(|| format!("loading identity from {key_path:?}"))?;
    let client = PlatformClient::connect(network_from_env())
        .await
        .context("connecting to Dash Platform")?;
    Ok((client, bridge))
}

/// Create a fresh repo owned by the `DASH_FORGE_KEY` identity, printing its ids and the
/// measured instantiation cost.
async fn create_repo(name: &str) -> Result<()> {
    let (client, bridge) = connect().await?;
    let identity = client.fetch_identity(&bridge.identity_id).await?;
    let before = identity.balance();

    let svc = RepoService::new(&client, &identity, &bridge);
    let result = svc
        .create_repo(name, &m1_repo_opts())
        .await
        .context("create_repo")?;

    println!("repo_contract_id={}", result.handle.repo_contract_id);
    println!("owner_id={}", result.handle.owner_id);
    println!("normalized_name={}", result.handle.normalized_name);
    println!("listing_document_id={}", result.listing_document_id);
    println!(
        "instantiation_cost_credits={}",
        result.repo_v1_instantiation_cost_credits
    );
    println!(
        "instantiation_cost_dash={:.6}",
        credits_to_dash(result.repo_v1_instantiation_cost_credits)
    );
    println!("balance_before_dash={:.6}", credits_to_dash(before));
    println!(
        "remote_url=dash://{}/{}",
        result.handle.owner_id, result.handle.normalized_name
    );
    Ok(())
}

/// Recover a repo whose (already paid-for) DataContractCreate landed but whose follow-on
/// `config` + `repoListing` writes did not — the case where `broadcast_and_wait` returned
/// a cached `AlreadyExists`. Scans recent identity nonces, derives the deterministic
/// contract id `hash(ownerId || nonce)`, and finalizes the first one that exists on-chain
/// without paying for a second create.
async fn resume_repo(name: &str) -> Result<()> {
    let (client, bridge) = connect().await?;
    let identity = client.fetch_identity(&bridge.identity_id).await?;
    let owner = &bridge.identity_id;
    let current = client.identity_nonce(owner).await?;
    tracing::info!(
        nonce = current,
        "current identity nonce; scanning for orphan contract"
    );

    // The create bumped-and-used the nonce; if it landed, the on-chain nonce is that value.
    // Scan a small window back for robustness.
    let mut found: Option<String> = None;
    for nonce in (current.saturating_sub(3)..=current).rev() {
        let candidate = client.derive_contract_id(owner, nonce)?;
        if client.fetch_contract(&candidate).await.is_ok() {
            println!("found_orphan_contract id={candidate} nonce={nonce}");
            found = Some(candidate);
            break;
        }
    }
    let contract_id = found.ok_or_else(|| {
        anyhow!(
            "no orphan contract found in the recent nonce window; the create may not have landed"
        )
    })?;

    let svc = RepoService::new(&client, &identity, &bridge);
    let result = svc
        .resume_repo(&contract_id, name, &m1_repo_opts())
        .await
        .context("resume_repo (finalize config + listing)")?;

    println!("repo_contract_id={}", result.handle.repo_contract_id);
    println!("owner_id={}", result.handle.owner_id);
    println!("normalized_name={}", result.handle.normalized_name);
    println!("listing_document_id={}", result.listing_document_id);
    println!(
        "remote_url=dash://{}/{}",
        result.handle.owner_id, result.handle.normalized_name
    );
    Ok(())
}

/// Print the signing identity's spendable balance.
async fn balance() -> Result<()> {
    let (client, bridge) = connect().await?;
    let credits = client.get_balance(&bridge.identity_id).await?;
    println!("identity_id={}", bridge.identity_id);
    println!("balance_credits={credits}");
    println!("balance_dash={:.6}", credits_to_dash(credits));
    Ok(())
}

/// Best-effort refund of a repo's deletable storage (chunks + pack manifests). The repo
/// contract and its audit docs are permanent by design; the registry listing is left in
/// place (a small doc) so the repo stays resolvable.
async fn teardown(owner: &str, repo: &str) -> Result<()> {
    let (client, bridge) = connect().await?;
    let identity = client.fetch_identity(&bridge.identity_id).await?;
    let svc = RepoService::new(&client, &identity, &bridge);

    let handle = svc
        .resolve_repo(owner, repo)
        .await
        .context("resolve_repo")?;
    let manifests = svc.read_pack_manifests(&handle).await?;
    println!("manifests={}", manifests.len());

    for m in &manifests {
        match svc.delete_chunks(&handle, m.pack_hash).await {
            Ok(n) => println!("deleted_chunks pack={} count={n}", hex::encode(m.pack_hash)),
            Err(e) => tracing::warn!(error = %e, "delete_chunks failed (continuing)"),
        }
        match svc
            .delete_document(&handle.repo_contract_id, "packManifest", &m.document_id)
            .await
        {
            Ok(()) => println!("deleted_manifest id={}", m.document_id),
            Err(e) => tracing::warn!(error = %e, "delete manifest failed (continuing)"),
        }
    }
    Ok(())
}
