//! `dg repo` — repo lifecycle: create / view / list / delete / backend set (+ clone/fork).

use anyhow::{bail, Context, Result};
use serde_json::json;

use forge_core::cost::prompt_delete_refund;
use forge_core::platform::{self, FieldValue, QueryFilter, QueryOrder};
use forge_core::repo::{CreateRepoOpts, RepoService, TESTNET_REGISTRY_CONTRACT_ID};
use forge_core::tokens::TokenService;

use crate::common::{resolve, RepoRef};
use crate::context::{network_label, Ctx};
use crate::fmt::{cost_json, cost_line, dash_usd_price, refund_line, REPO_CREATE_ESTIMATE_CREDITS};
use crate::{RepoBackendCommand, RepoCommand};

/// Dispatch a `repo` subcommand.
pub async fn run(ctx: &Ctx, cmd: &RepoCommand) -> Result<()> {
    match cmd {
        RepoCommand::Create {
            name,
            storage,
            description,
        } => create(ctx, name, storage.mode(), storage.label(), description).await,
        RepoCommand::Clone { repo } => clone(ctx, repo),
        RepoCommand::Fork { repo } => fork(ctx, repo),
        RepoCommand::View { repo } => view(ctx, repo).await,
        RepoCommand::List { owner } => list(ctx, owner.as_deref()).await,
        RepoCommand::Delete { repo } => delete(ctx, repo).await,
        RepoCommand::Backend(RepoBackendCommand::Set { repo, mode }) => {
            backend_set(ctx, repo, mode.mode(), mode.label()).await
        }
    }
}

/// Create a repo (contract instantiate + listing + token setup). Shows the ~1.18 DASH
/// instantiation estimate and prompts unless `--yes`, then reports the measured cost.
async fn create(
    ctx: &Ctx,
    name: &str,
    backend_mode: u8,
    storage_label: &str,
    description: &str,
) -> Result<()> {
    let price = dash_usd_price();
    if !ctx.json {
        println!(
            "Creating repo {name:?} ({storage_label} storage) — estimated cost {}",
            cost_line(REPO_CREATE_ESTIMATE_CREDITS, price)
        );
    }
    if !ctx.confirm(&format!(
        "Create repo {name:?}? This instantiates a contract (~{})",
        cost_line(REPO_CREATE_ESTIMATE_CREDITS, price)
    ))? {
        bail!("aborted");
    }

    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let svc = RepoService::new(&client, &identity, &bridge);
    let opts = CreateRepoOpts {
        default_branch: "main".to_string(),
        backend_mode,
        description: description.to_string(),
        template_version: 1,
    };
    let result = svc.create_repo(name, &opts).await.context("create_repo")?;
    let credits = result.repo_v1_instantiation_cost_credits;

    ctx.emit(
        json!({
            "status": "created",
            "repoContractId": result.handle.repo_contract_id,
            "ownerId": result.handle.owner_id,
            "name": result.handle.name,
            "normalizedName": result.handle.normalized_name,
            "listingDocumentId": result.listing_document_id,
            "storage": storage_label,
            "remoteUrl": format!("dash://{}/{}", result.handle.owner_id, result.handle.normalized_name),
            "cost": cost_json(credits, price),
        }),
        || {
            println!("Created {}/{}", result.handle.owner_id, result.handle.normalized_name);
            println!("  contract: {}", result.handle.repo_contract_id);
            println!(
                "  remote:   dash://{}/{}",
                result.handle.owner_id, result.handle.normalized_name
            );
            if credits == 0 {
                println!("  cost:     0 (repo already existed — idempotent, no double-pay)");
            } else {
                println!("  cost:     {}", cost_line(credits, price));
            }
        },
    );
    Ok(())
}

/// Print the `git clone` invocation for a repo (cloning itself is the remote helper's job).
fn clone(ctx: &Ctx, repo: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let owner = repo_ref
        .owner
        .clone()
        .context("clone needs an explicit owner: `dg repo clone <owner>/<name>`")?;
    let url = format!("dash://{}/{}", owner, repo_ref.name);
    ctx.emit(
        json!({ "remoteUrl": url, "command": format!("git clone {url}") }),
        || println!("git clone {url}"),
    );
    Ok(())
}

/// Fork — not yet wired (needs the fork-contract + copied-refs pipeline, PRD 02 §B).
#[allow(clippy::unnecessary_wraps)]
fn fork(ctx: &Ctx, repo: &str) -> Result<()> {
    ctx.emit(
        json!({
            "status": "not_implemented",
            "repo": repo,
            "todo": "fork mints a new repo contract + copied refs (shared CIDs where the backend allows); pipeline not yet wired",
        }),
        || {
            eprintln!("dg repo fork: not yet wired");
            eprintln!("  TODO: mint a fork contract + copy refs (shared CIDs where possible), set forkOf on the listing");
        },
    );
    Ok(())
}

/// View a repo: resolved refs, default branch, pack manifests, collaborator count.
async fn view(ctx: &Ctx, repo: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;

    let svc = RepoService::new(&client, &identity, &bridge);
    let default_branch = svc.read_default_branch(&handle).await.unwrap_or(None);
    let refs = svc.read_refs(&handle).await.unwrap_or_default();
    let manifests = svc.read_pack_manifests(&handle).await.unwrap_or_default();
    let collaborators = TokenService::new(&client, &identity, &bridge)
        .list_collaborators(&handle.repo_contract_id)
        .await
        .map(|c| c.len())
        .unwrap_or(0);

    let refs_json: Vec<_> = refs
        .iter()
        .map(|(name, state)| {
            json!({ "name": name, "state": serde_json::to_value(state).unwrap_or_default() })
        })
        .collect();
    let total_bytes: u64 = manifests.iter().map(|m| m.size_bytes).sum();

    ctx.emit(
        json!({
            "repoContractId": handle.repo_contract_id,
            "ownerId": handle.owner_id,
            "name": handle.name,
            "normalizedName": handle.normalized_name,
            "defaultBranch": default_branch,
            "refs": refs_json,
            "packCount": manifests.len(),
            "packBytes": total_bytes,
            "collaborators": collaborators,
            "remoteUrl": format!("dash://{}/{}", handle.owner_id, handle.normalized_name),
        }),
        || {
            println!("{}/{}", handle.owner_id, handle.normalized_name);
            println!("  contract:       {}", handle.repo_contract_id);
            println!(
                "  default branch: {}",
                default_branch.clone().unwrap_or_else(|| "(none)".into())
            );
            println!("  refs:           {}", refs.len());
            for (name, state) in &refs {
                println!("    {name}  {}", ref_state_short(state));
            }
            println!(
                "  packs:          {} ({total_bytes} bytes)",
                manifests.len()
            );
            println!("  collaborators:  {collaborators}");
            println!(
                "  remote:         dash://{}/{}",
                handle.owner_id, handle.normalized_name
            );
        },
    );
    Ok(())
}

/// A compact human string for a resolved ref state.
fn ref_state_short(state: &forge_core::rules::RefState) -> String {
    use forge_core::rules::RefState;
    match state {
        RefState::Unborn => "(unborn)".to_string(),
        RefState::Resolved { oid, .. } => oid.chars().take(12).collect(),
        RefState::Diverged { heads } => format!("(diverged: {} heads)", heads.len()),
    }
}

/// List an owner's repositories from the registry `repoListing` index.
async fn list(ctx: &Ctx, owner: Option<&str>) -> Result<()> {
    let (client, _bridge, identity) = ctx.connect_with_identity().await?;
    let owner_id = owner.map_or_else(|| identity.id(), str::to_string);
    let owner_bytes = platform::decode_identifier(&owner_id)?;

    let registry = client.fetch_contract(TESTNET_REGISTRY_CONTRACT_ID).await?;
    let docs = client
        .query_documents(
            &registry,
            "repoListing",
            &[QueryFilter::eq(
                "$ownerId",
                FieldValue::identifier(owner_bytes),
            )],
            // Order by normalizedName to match the registry's `ownerName`
            // `($ownerId, normalizedName)` compound index ($createdAt is not indexed here).
            &[QueryOrder::asc("normalizedName")],
            0,
            None,
        )
        .await
        .context("querying the registry for repoListing docs")?;

    let repos: Vec<_> = docs
        .iter()
        .map(|d| {
            let repo_contract = d
                .field_bytes("repoContractId")
                .and_then(|b| <[u8; 32]>::try_from(b).ok())
                .map(platform::encode_identifier);
            json!({
                "name": d.field_str("name"),
                "normalizedName": d.field_str("normalizedName"),
                "repoContractId": repo_contract,
                "description": d.field_str("description"),
                "listingId": d.id,
            })
        })
        .collect();

    ctx.emit(
        json!({ "owner": owner_id, "count": repos.len(), "repos": repos }),
        || {
            println!("{} repo(s) for {owner_id}:", docs.len());
            for d in &docs {
                println!(
                    "  {}  ({})",
                    d.field_str("normalizedName").unwrap_or_default(),
                    d.field_str("description").unwrap_or_default()
                );
            }
        },
    );
    Ok(())
}

/// Delete a repo's deletable storage (chunks + pack manifests → refund) and its registry
/// listing. Shows a refund estimate and prompts unless `--yes`.
async fn delete(ctx: &Ctx, repo: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = RepoService::new(&client, &identity, &bridge);

    let manifests = svc.read_pack_manifests(&handle).await.unwrap_or_default();
    let total_bytes: u64 = manifests.iter().map(|m| m.size_bytes).sum();
    let refund = prompt_delete_refund(total_bytes);
    let price = dash_usd_price();

    if !ctx.json {
        println!(
            "Deleting {}/{}: {} pack(s), {total_bytes} bytes — estimated {}",
            handle.owner_id,
            handle.normalized_name,
            manifests.len(),
            refund_line(refund, price)
        );
    }
    if !ctx.confirm(&format!(
        "Delete {}/{} storage? (est. {})",
        handle.owner_id,
        handle.normalized_name,
        refund_line(refund, price)
    ))? {
        bail!("aborted");
    }

    let mut deleted_chunks = 0usize;
    let mut deleted_manifests = 0usize;
    for m in &manifests {
        if let Ok(n) = svc.delete_chunks(&handle, m.pack_hash).await {
            deleted_chunks += n;
        }
        if svc
            .delete_document(&handle.repo_contract_id, "packManifest", &m.document_id)
            .await
            .is_ok()
        {
            deleted_manifests += 1;
        }
    }

    // Best-effort listing removal (makes the repo unresolvable, completing the delete).
    let listing_removed = remove_listing(ctx, &client, &bridge, &identity, &handle)
        .await
        .unwrap_or(false);

    ctx.emit(
        json!({
            "status": "deleted",
            "repoContractId": handle.repo_contract_id,
            "deletedChunks": deleted_chunks,
            "deletedManifests": deleted_manifests,
            "listingRemoved": listing_removed,
            "refundEstimate": cost_json(refund, price),
            "note": "the repo contract and its append-only audit docs are permanent by design",
        }),
        || {
            println!("Deleted {deleted_chunks} chunk(s), {deleted_manifests} manifest(s).");
            println!("Listing removed: {listing_removed}");
            println!("Estimated refund: {}", refund_line(refund, price));
            println!("note: the repo contract itself is permanent (Platform contracts cannot be deleted).");
        },
    );
    Ok(())
}

/// Find and delete the registry `repoListing` for a repo, returning whether one was
/// removed. Best-effort: a failure does not fail the whole delete.
async fn remove_listing(
    _ctx: &Ctx,
    client: &forge_core::platform::PlatformClient,
    bridge: &forge_core::keystore::BridgeIdentity,
    identity: &forge_core::platform::LoadedIdentity,
    handle: &forge_core::repo::RepoHandle,
) -> Result<bool> {
    let registry = client.fetch_contract(TESTNET_REGISTRY_CONTRACT_ID).await?;
    let owner_bytes = platform::decode_identifier(&handle.owner_id)?;
    let docs = client
        .query_documents(
            &registry,
            "repoListing",
            &[
                QueryFilter::eq("$ownerId", FieldValue::identifier(owner_bytes)),
                QueryFilter::eq(
                    "normalizedName",
                    FieldValue::text(handle.normalized_name.clone()),
                ),
            ],
            &[],
            1,
            None,
        )
        .await?;
    let Some(listing) = docs.into_iter().next() else {
        return Ok(false);
    };
    let svc = RepoService::new(client, identity, bridge);
    svc.delete_document(TESTNET_REGISTRY_CONTRACT_ID, "repoListing", &listing.id)
        .await?;
    Ok(true)
}

/// Set a repo's storage backend mode (appends a new `config` doc; MAINTAIN-gated).
async fn backend_set(ctx: &Ctx, repo: &str, mode: u8, label: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;

    if !ctx.confirm(&format!(
        "Set backend of {}/{} to {label}? (a small config write)",
        handle.owner_id, handle.normalized_name
    ))? {
        bail!("aborted");
    }

    let svc = RepoService::new(&client, &identity, &bridge);
    let doc_id = svc
        .set_backend_mode(&handle, mode)
        .await
        .context("set_backend_mode")?;

    ctx.emit(
        json!({
            "status": "backend_set",
            "repoContractId": handle.repo_contract_id,
            "backend": label,
            "mode": mode,
            "configDocumentId": doc_id,
            "network": network_label(ctx.network),
        }),
        || {
            println!(
                "Backend of {}/{} set to {label} (config doc {doc_id}).",
                handle.owner_id, handle.normalized_name
            );
        },
    );
    Ok(())
}
