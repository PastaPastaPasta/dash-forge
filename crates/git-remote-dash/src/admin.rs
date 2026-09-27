//! Out-of-protocol admin commands used to provision and inspect `dash://` repos.
//!
//! These are not part of the git remote-helper protocol; they are a thin CLI over
//! `forge-core` so test scripts can create a repo, check the signing identity's balance and
//! read raw ref documents. The real, polished surface for this is `dg` (PRD 02 §B).

use anyhow::{anyhow, bail, Context, Result};
use tokio::runtime::Runtime;

use forge_core::create::{create_repo as create_v2, default_journal_dir, CreateRepoOpts};
use forge_core::keystore::BridgeIdentity;
use forge_core::platform::{
    decode_identifier, FetchedDocument, FieldValue, LoadedContract, PlatformClient, QueryFilter,
    QueryOrder,
};
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
        Some("--dump-collab") => match (args.get(1), args.get(2)) {
            (Some(o), Some(r)) => rt.block_on(dump_collab(o, r)),
            _ => bail!("usage: git-remote-dash --dump-collab <owner> <repo>"),
        },
        Some("--dump-pack-heads") => match (args.get(1), args.get(2)) {
            (Some(o), Some(r)) => rt.block_on(dump_pack_heads(o, r)),
            _ => bail!("usage: git-remote-dash --dump-pack-heads <owner> <repo>"),
        },
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
    let bridge = BridgeIdentity::load_from_file(&key_path).with_context(|| {
        format!(
            "loading identity from {}",
            forge_core::keystore::describe_key_source(key_path.as_ref())
        )
    })?;
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
                "  ref={:?} hash={} enc={} new={} prev={} force={} createdAt={} id={} owner={}",
                d.field_str("refName").unwrap_or_default(),
                d.field_hex("refNameHash").unwrap_or_default(),
                d.field_bytes("enc").map_or(0, |e| e.len()),
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

/// The free-text properties a private repo's collaboration documents must never carry.
const TEXT_FIELDS: [&str; 6] = [
    "title",
    "body",
    "path",
    "baseRefName",
    "sourceRefName",
    "value",
];

/// Dump the raw issue / patch / comment / review documents of a repo, and its member events
/// that carry a value (a label or milestone name, …), as stored (diagnostic: in a private repo
/// every free-text property is absent and `enc` carries it). Comments, reviews and events are
/// found through their issue or patch (they are indexed by target, not by repo).
async fn dump_collab(owner: &str, repo: &str) -> Result<()> {
    let (client, _bridge) = connect().await?;
    let repo = resolve_named(&client, owner, repo).await?;
    let collab = client.fetch_contract(&repo.forge().collab).await?;
    let scope = repo.scope()?;
    let print = |doc_type: &str, docs: &[FetchedDocument]| {
        for d in docs {
            let text: Vec<String> = TEXT_FIELDS
                .iter()
                .filter_map(|f| d.field_str(f).map(|v| format!("{f}={v:?}")))
                .collect();
            println!(
                "  type={doc_type} id={} epoch={} enc={} baseRefNameHash={} plaintext=[{}]",
                d.id,
                d.field_u64("epoch")
                    .map_or_else(|| "-".into(), |e| e.to_string()),
                d.field_bytes("enc").map_or(0, |e| e.len()),
                d.field_hex("baseRefNameHash").unwrap_or_default(),
                text.join(" ")
            );
        }
    };
    for doc_type in ["issue", "patch"] {
        let docs = client
            .query_all_documents(
                &collab,
                doc_type,
                &scope.filters([]),
                &[QueryOrder::asc("$createdAt")],
            )
            .await?;
        print(doc_type, &docs);
        for d in &docs {
            print(
                "comment",
                &by_target(&client, &collab, "comment", "targetId", &d.id).await?,
            );
            // an event without a value (close, merge, …) has nothing to seal
            let valued: Vec<FetchedDocument> =
                by_target(&client, &collab, "event", "targetId", &d.id)
                    .await?
                    .into_iter()
                    .filter(|e| e.fields.contains_key("value") || e.fields.contains_key("enc"))
                    .collect();
            print("event", &valued);
            if doc_type == "patch" {
                print(
                    "review",
                    &by_target(&client, &collab, "review", "patchId", &d.id).await?,
                );
            }
        }
    }
    Ok(())
}

/// Every `doc_type` document whose `field` names `id` (the `target` / `patch` indexes).
async fn by_target(
    client: &PlatformClient,
    collab: &LoadedContract,
    doc_type: &str,
    field: &str,
    id: &str,
) -> Result<Vec<FetchedDocument>> {
    let id = decode_identifier(id)?;
    Ok(client
        .query_all_documents(
            collab,
            doc_type,
            &[QueryFilter::eq(field, FieldValue::identifier(id))],
            &[QueryOrder::asc(field), QueryOrder::asc("$createdAt")],
        )
        .await?)
}

/// Print the first bytes of every stored git pack, as stored (diagnostic: a private repo's
/// packs are sealed and start with `DFPK`; a public repo's start with `PACK`).
async fn dump_pack_heads(owner: &str, repo: &str) -> Result<()> {
    let (client, bridge) = connect().await?;
    let identity = client.fetch_identity(&bridge.identity_id).await?;
    let repo = resolve_named(&client, owner, repo).await?;
    let svc = RepoService::new(&client, &identity, &bridge);
    let reader = forge_core::storage::PackReader::from_user_config();
    for m in svc.read_pack_manifests(&repo).await? {
        let bytes = svc.fetch_artifact(&repo, &m, &reader).await?;
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4)]).into_owned();
        println!(
            "  pack={} kind={} head={head:?}",
            hex::encode(m.pack_hash),
            m.kind
        );
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
