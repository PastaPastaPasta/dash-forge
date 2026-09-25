//! Out-of-protocol admin commands used to provision and inspect `dash://` repos.
//!
//! These are not part of the git remote-helper protocol; they are a thin CLI over
//! `forge-core` so test scripts can create a repo, check the signing identity's balance and
//! read raw ref documents. The real, polished surface for this is `dg` (PRD 02 §B).

use anyhow::{anyhow, bail, Context, Result};
use tokio::runtime::Runtime;

use forge_core::create::{create_repo as create_v2, default_journal_dir, CreateRepoOpts};
use forge_core::keystore::BridgeIdentity;
use forge_core::platform::{PlatformClient, QueryOrder};
use forge_core::repo::{credits_to_dash, RepoService};
use forge_core::resolve::resolve_named;

use crate::helper::network_target;

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
        Some("--write-ref") => {
            let owner = args.get(1);
            let repo = args.get(2);
            let ref_name = args.get(3);
            let oid = args.get(4);
            match (owner, repo, ref_name, oid) {
                (Some(o), Some(r), Some(n), Some(x)) => rt.block_on(write_ref(o, r, n, x)),
                _ => bail!("usage: git-remote-dash --write-ref <owner> <repo> <refName> <oidHex>"),
            }
        }
        Some("--dump-refs") => {
            let owner = args.get(1);
            let repo = args.get(2);
            match (owner, repo) {
                (Some(o), Some(r)) => rt.block_on(dump_refs(o, r)),
                _ => bail!("usage: git-remote-dash --dump-refs <owner> <repo>"),
            }
        }
        Some(verb @ ("--resume-repo" | "--teardown")) => bail!(
            "{verb} is gone: repo creation is resumable (re-run --create-repo), and forge-v2 \
             packs are permanent"
        ),
        other => bail!("unknown admin command {other:?}"),
    }
}

/// Load the signing identity named by `DASH_FORGE_KEY` and connect to the configured
/// network.
async fn connect() -> Result<(PlatformClient, BridgeIdentity)> {
    let key_path = std::env::var_os("DASH_FORGE_KEY")
        .ok_or_else(|| anyhow!("DASH_FORGE_KEY must point at the identity JSON for admin ops"))?;
    let bridge = BridgeIdentity::load_from_file(&key_path)
        .with_context(|| format!("loading identity from {}", key_path.display()))?;
    let client = PlatformClient::connect(network_target()?)
        .await
        .context("connecting to Dash Platform")?;
    Ok((client, bridge))
}

/// Create (or finish creating) a forge-v2 repo owned by the `DASH_FORGE_KEY` identity,
/// printing its ids and what it cost.
async fn create_repo(name: &str) -> Result<()> {
    let (client, bridge) = connect().await?;
    let identity = client.fetch_identity(&bridge.identity_id).await?;
    let before = identity.balance();
    let result = create_v2(
        &client,
        &identity,
        &bridge,
        &CreateRepoOpts::public(name),
        &default_journal_dir()?,
    )
    .await
    .context("create_repo")?;

    println!("repo_id={}", result.repo.id());
    println!("owner_id={}", result.repo.owner_id());
    println!("name={}", result.repo.name());
    println!("cost_credits={}", result.cost_credits);
    println!("cost_dash={:.6}", credits_to_dash(result.cost_credits));
    println!("balance_before_dash={:.6}", credits_to_dash(before));
    println!("remote_url={}", result.repo.remote_url());
    Ok(())
}

/// Directly write a `refUpdate` (test tool): proves the write-side injection guard rejects
/// an illegal `refName` (e.g. one containing a newline that would inject a spoofed
/// ref-advertisement line) before any document is written.
async fn write_ref(owner: &str, repo: &str, ref_name: &str, oid_hex: &str) -> Result<()> {
    let (client, bridge) = connect().await?;
    let identity = client.fetch_identity(&bridge.identity_id).await?;
    let svc = RepoService::new(&client, &identity, &bridge);
    let repo = resolve_named(&client, owner, repo)
        .await
        .context("resolving repo")?;
    let new_oid = hex::decode(oid_hex).context("oid must be hex")?;
    let doc_id = svc
        .write_ref_update(&repo, ref_name, &new_oid, None, false)
        .await
        .context("write_ref_update")?;
    println!("wrote_ref_update id={doc_id} ref={ref_name:?}");
    Ok(())
}

/// Dump raw `refUpdate` / `protectedRefUpdate` documents (diagnostic).
async fn dump_refs(owner: &str, repo: &str) -> Result<()> {
    let (client, _bridge) = connect().await?;
    let repo = resolve_named(&client, owner, repo).await?;
    let scope = repo.scope()?;
    let contract = client.fetch_contract(&scope.contract_id).await?;
    for doc_type in ["refUpdate", "protectedRefUpdate"] {
        // A diagnostic that dumps "the raw history" must dump all of it.
        let docs = client
            .query_all_documents(
                &contract,
                doc_type,
                &scope.filters([]),
                &[QueryOrder::asc("$createdAt")],
            )
            .await?;
        println!("--- {doc_type}: {} docs ---", docs.len());
        for d in &docs {
            println!(
                "  ref={:?} new={} prev={} force={} createdAt={} id={} owner={}",
                d.field_str("refName").unwrap_or_default(),
                d.field_hex("newOid").unwrap_or_default(),
                d.field_hex("prevOid").unwrap_or_default(),
                d.field_bool("force"),
                d.created_at.unwrap_or_default(),
                d.id,
                d.owner_id,
            );
        }
    }
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
