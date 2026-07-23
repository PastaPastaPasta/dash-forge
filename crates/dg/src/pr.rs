//! `dg pr` — pull requests (patches).
//!
//! `create`/`list`/`view`/`review`/`merge` are wired to `forge-core`'s
//! [`PullRequestService`]; `merge` posts the `merge` event (the git merge itself is
//! client-side, per PRD 02 §B). `checkout`/`diff` are deliberately thin git wrappers that
//! operate on objects already in the local odb.

use std::process::Command;

use anyhow::{bail, Context, Result};
use serde_json::json;

use forge_core::collab::{PullRequestInput, PullRequestService};

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::{PrCommand, VerdictArg};

/// Dispatch a `pr` subcommand.
pub async fn run(ctx: &Ctx, cmd: &PrCommand) -> Result<()> {
    match cmd {
        PrCommand::Create {
            repo,
            title,
            body,
            base,
            source_contract,
            head_oid,
            source_ref,
        } => {
            create(
                ctx,
                repo,
                title,
                body,
                base,
                source_contract,
                head_oid,
                source_ref.as_deref(),
            )
            .await
        }
        PrCommand::List { repo, limit } => list(ctx, repo, *limit).await,
        PrCommand::View { repo, number } => view(ctx, repo, *number).await,
        PrCommand::Checkout { repo, number } => checkout(ctx, repo, *number).await,
        PrCommand::Review {
            repo,
            number,
            verdict,
            body,
            commit,
        } => review(ctx, repo, *number, *verdict, body, commit.as_deref()).await,
        PrCommand::Merge {
            repo,
            number,
            merge_oid,
        } => merge(ctx, repo, *number, merge_oid.as_deref()).await,
        PrCommand::Diff { repo, number } => diff(ctx, repo, *number).await,
    }
}

#[allow(clippy::too_many_arguments)]
async fn create(
    ctx: &Ctx,
    repo: &str,
    title: &str,
    body: &str,
    base: &str,
    source_contract: &str,
    head_oid_hex: &str,
    source_ref: Option<&str>,
) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let head_oid = hex::decode(head_oid_hex).context("--head-oid must be hex")?;
    if !ctx.confirm(&format!("Open PR {title:?}? (a small ungated write)"))? {
        bail!("aborted");
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = PullRequestService::new(&client, &identity, &bridge);
    let input = PullRequestInput {
        title: title.to_string(),
        body: body.to_string(),
        base_ref_name: base.to_string(),
        source_listing_id: None,
        source_contract_id: source_contract.to_string(),
        source_ref_name: source_ref.map(str::to_string),
        head_oid,
        patch_manifest_hash: None,
    };
    let pr = svc
        .create_pr(&handle.repo_contract_id, &input)
        .await
        .context("create_pr")?;

    ctx.emit(
        json!({
            "status": "created",
            "number": pr.number,
            "documentId": pr.document_id,
            "title": pr.title,
            "baseRef": pr.base_ref_name,
            "headOid": pr.head_oid,
        }),
        || println!("Opened PR #{}: {}", pr.number, pr.title),
    );
    Ok(())
}

async fn list(ctx: &Ctx, repo: &str, limit: u32) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = PullRequestService::new(&client, &identity, &bridge);
    let prs = svc
        .list_prs(&handle.repo_contract_id, limit, None)
        .await
        .context("list_prs")?;

    let rows: Vec<_> = prs
        .iter()
        .map(|p| {
            json!({
                "number": p.number,
                "title": p.title,
                "author": p.author,
                "baseRef": p.base_ref_name,
                "headOid": p.head_oid,
            })
        })
        .collect();

    ctx.emit(json!({ "count": rows.len(), "prs": rows }), || {
        for p in &prs {
            println!(
                "#{:<4} {}  ({})",
                p.number,
                p.title,
                &p.head_oid.chars().take(12).collect::<String>()
            );
        }
    });
    Ok(())
}

async fn view(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = PullRequestService::new(&client, &identity, &bridge);
    let pw = svc
        .pr_state(&handle.repo_contract_id, number, None)
        .await
        .context("pr_state")?
        .ok_or_else(|| anyhow::anyhow!("PR #{number} not found"))?;

    ctx.emit(
        json!({
            "number": pw.pr.number,
            "title": pw.pr.title,
            "body": pw.pr.body,
            "author": pw.pr.author,
            "baseRef": pw.pr.base_ref_name,
            "headOid": pw.pr.head_oid,
            "state": serde_json::to_value(&pw.state).unwrap_or_default(),
        }),
        || {
            let mark = if pw.state.merged {
                "merged"
            } else if pw.state.open {
                "open"
            } else {
                "closed"
            };
            println!("#{} [{mark}] {}", pw.pr.number, pw.pr.title);
            println!("author: {}", pw.pr.author);
            println!("base:   {}", pw.pr.base_ref_name);
            println!("head:   {}", pw.pr.head_oid);
            if !pw.pr.body.is_empty() {
                println!("\n{}", pw.pr.body);
            }
        },
    );
    Ok(())
}

async fn review(
    ctx: &Ctx,
    repo: &str,
    number: u64,
    verdict: VerdictArg,
    body: &str,
    commit: Option<&str>,
) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    if !ctx.confirm(&format!(
        "Post {verdict:?} review on PR #{number}? (a small ungated write)"
    ))? {
        bail!("aborted");
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = PullRequestService::new(&client, &identity, &bridge);
    let pr = svc
        .get_pr(&handle.repo_contract_id, number)
        .await?
        .ok_or_else(|| anyhow::anyhow!("PR #{number} not found"))?;
    let commit_hex = commit.unwrap_or(&pr.head_oid);
    let commit_oid = hex::decode(commit_hex).context("--commit must be hex")?;
    let doc_id = svc
        .review(
            &handle.repo_contract_id,
            &pr.document_id,
            verdict.code(),
            &commit_oid,
            body,
        )
        .await
        .context("review")?;

    ctx.emit(
        json!({
            "status": "reviewed",
            "pr": number,
            "verdict": verdict.code(),
            "reviewId": doc_id,
        }),
        || println!("Reviewed PR #{number} ({verdict:?}) — review {doc_id}."),
    );
    Ok(())
}

/// Post the `merge` event closing a PR. The actual git merge is client-side; pass
/// `--merge-oid` for the merge commit, else the PR head oid is recorded.
async fn merge(ctx: &Ctx, repo: &str, number: u64, merge_oid: Option<&str>) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    if !ctx.confirm(&format!("Merge PR #{number}? (posts a merge event)"))? {
        bail!("aborted");
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = PullRequestService::new(&client, &identity, &bridge);
    let pr = svc
        .get_pr(&handle.repo_contract_id, number)
        .await?
        .ok_or_else(|| anyhow::anyhow!("PR #{number} not found"))?;
    let oid_hex = merge_oid.unwrap_or(&pr.head_oid);
    let oid = hex::decode(oid_hex).context("--merge-oid must be hex")?;
    let event_id = svc
        .merge_event(&handle.repo_contract_id, &pr.document_id, &oid)
        .await
        .context("merge_event")?;

    ctx.emit(
        json!({
            "status": "merged",
            "pr": number,
            "mergeOid": oid_hex,
            "eventId": event_id,
            "note": "the merge commit must also be pushed to the base ref (git push) for the merge to be reachable",
        }),
        || {
            println!("Posted merge event for PR #{number} (merge {oid_hex}, event {event_id}).");
            println!("note: push the merge commit to the base ref so the merge resolves reachable.");
        },
    );
    Ok(())
}

/// Thin `checkout`: create a local `pr/<n>` branch at the PR head **if the object is
/// already in the local odb** (fetch it first via the `dash://` remote). No network fetch
/// is performed here — the pack transport is the remote helper's job.
async fn checkout(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = PullRequestService::new(&client, &identity, &bridge);
    let pr = svc
        .get_pr(&handle.repo_contract_id, number)
        .await?
        .ok_or_else(|| anyhow::anyhow!("PR #{number} not found"))?;

    let branch = format!("pr/{number}");
    let present = git_object_present(&pr.head_oid);
    let mut created = false;
    if present {
        created = Command::new("git")
            .args(["branch", "-f", &branch, &pr.head_oid])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }

    ctx.emit(
        json!({
            "pr": number,
            "headOid": pr.head_oid,
            "branch": branch,
            "objectPresent": present,
            "branchCreated": created,
            "note": if present { "created local branch at PR head" }
                    else { "PR head not in local odb — fetch it first: git fetch <dash-remote>" },
        }),
        || {
            if created {
                println!("Created branch {branch} at {}.", pr.head_oid);
            } else if present {
                println!(
                    "PR head present but `git branch` failed; run: git branch -f {branch} {}",
                    pr.head_oid
                );
            } else {
                println!("PR #{number} head {} is not in the local odb.", pr.head_oid);
                println!("Fetch it first (git fetch on the dash:// remote), then re-run checkout.");
            }
        },
    );
    Ok(())
}

/// Thin `diff`: run `git diff <base>...<head>` when both objects are in the local odb.
async fn diff(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = PullRequestService::new(&client, &identity, &bridge);
    let pr = svc
        .get_pr(&handle.repo_contract_id, number)
        .await?
        .ok_or_else(|| anyhow::anyhow!("PR #{number} not found"))?;

    if !git_object_present(&pr.head_oid) {
        ctx.emit(
            json!({
                "pr": number,
                "headOid": pr.head_oid,
                "diffAvailable": false,
                "note": "PR head not in local odb — fetch it first, then re-run diff",
            }),
            || {
                println!(
                    "PR #{number} head {} is not local; fetch it first.",
                    pr.head_oid
                );
            },
        );
        return Ok(());
    }

    // base...head against the PR head. The base ref name maps to a local ref if present.
    let range = format!("{}...{}", pr.base_ref_name, pr.head_oid);
    let out = Command::new("git")
        .args(["--no-pager", "diff", &range])
        .output()
        .context("running git diff")?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();

    ctx.emit(
        json!({
            "pr": number,
            "range": range,
            "diffAvailable": out.status.success(),
            "diff": text,
        }),
        || {
            if out.status.success() {
                print!("{text}");
            } else {
                println!("git diff {range} failed (is the base ref present locally?)");
            }
        },
    );
    Ok(())
}

/// Whether git can resolve `oid` to an object in the local odb.
fn git_object_present(oid: &str) -> bool {
    Command::new("git")
        .args(["cat-file", "-e", oid])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
