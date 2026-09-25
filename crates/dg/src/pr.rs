//! `dg pr` — pull requests (patches).
//!
//! `create`/`list`/`view`/`review`/`merge` are wired to `forge-core`'s
//! [`PullRequestService`].
//!
//! `merge` posts the `merge` event; it does NOT perform a git merge. The event is
//! authoritative only if the fold accepts it — the actor holds WRITE or MAINTAIN, and the
//! oid has already reached the base ref — so the command re-reads the PR afterwards and
//! reports what the fold says rather than assuming success (PRD 02 §B).
//!
//! `checkout`/`diff` fetch the PR head from the repo that holds it before touching git. A
//! PR's objects usually live in a different contract from the repo it targets, addressed by
//! `patch.sourceContractId`; the remote helper's `dash://<contractId>` form makes that
//! fetchable without a registry lookup.

use std::process::Command;

use anyhow::{Context, Result};
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
        return Err(crate::errors::cancelled());
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
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
        .create_pr(handle.v1_contract_id()?, &input)
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
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = PullRequestService::new(&client, &identity, &bridge);
    let prs = svc
        .list_prs(handle.v1_contract_id()?, limit, None)
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
                p.head_oid.chars().take(12).collect::<String>()
            );
        }
    });
    Ok(())
}

async fn view(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = PullRequestService::new(&client, &identity, &bridge);
    let pw = svc
        .pr_state(handle.v1_contract_id()?, number, None)
        .await
        .context("pr_state")?
        .ok_or_else(|| {
            crate::errors::not_found(
                format!("pull request #{number} not found in {repo}"),
                format!("`dg pr list {repo}` lists its pull requests"),
            )
        })?;
    // Reviews were write-only: `dg pr review` created documents nothing ever read back, so
    // a requested change was invisible to the contributor it was addressed to.
    // Distinguish "no reviews" from "could not read the reviews". Collapsing the two with
    // `unwrap_or_default()` would print "no reviews" on a failed read — reintroducing the
    // exact invisibility that made reviews worth surfacing in the first place.
    let reviews_result = svc
        .list_reviews(handle.v1_contract_id()?, &pw.pr.document_id)
        .await;
    let reviews = reviews_result.as_deref().unwrap_or(&[]);
    let reviews_error = reviews_result.as_ref().err().map(ToString::to_string);

    let reviews_json: Vec<_> = reviews
        .iter()
        .map(|r| {
            json!({
                "reviewer": r.reviewer,
                "verdict": r.verdict.code(),
                "verdictLabel": r.verdict.label(),
                "commitOid": r.commit_oid,
                "body": r.body,
                "createdAt": r.created_at,
            })
        })
        .collect();

    ctx.emit(
        json!({
            "number": pw.pr.number,
            "title": pw.pr.title,
            "body": pw.pr.body,
            "author": pw.pr.author,
            "baseRef": pw.pr.base_ref_name,
            "headOid": pw.pr.head_oid,
            "sourceContractId": pw.pr.source_contract_id,
            "sourceListingId": pw.pr.source_listing_id,
            "sourceRefName": pw.pr.source_ref_name,
            "patchManifestHash": pw.pr.patch_manifest_hash,
            "state": serde_json::to_value(&pw.state).unwrap_or_default(),
            "reviews": reviews_json,
            "reviewsError": reviews_error,
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
            // The source pointer is what a reviewer needs to fetch the PR at all; without
            // it, `head` names a commit with no stated home.
            if !pw.pr.source_contract_id.is_empty() {
                print!("source: contract {}", pw.pr.source_contract_id);
                match &pw.pr.source_ref_name {
                    Some(r) => println!(" ref {r}"),
                    None => println!(),
                }
            }
            if !pw.pr.body.is_empty() {
                println!("\n{}", pw.pr.body);
            }
            if let Some(err) = &reviews_error {
                println!("\nreviews: COULD NOT BE READ — {err}");
            } else if reviews.is_empty() {
                println!("\nno reviews");
            } else {
                println!("\nreviews:");
                for r in reviews {
                    println!("  {} — {}", r.verdict.label(), r.reviewer);
                    if !r.body.is_empty() {
                        println!("      {}", r.body);
                    }
                }
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
        return Err(crate::errors::cancelled());
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = PullRequestService::new(&client, &identity, &bridge);
    let pr = svc
        .get_pr(handle.v1_contract_id()?, number)
        .await?
        .ok_or_else(|| {
            crate::errors::not_found(
                format!("pull request #{number} not found in {repo}"),
                format!("`dg pr list {repo}` lists its pull requests"),
            )
        })?;
    let commit_hex = commit.unwrap_or(&pr.head_oid);
    let commit_oid = hex::decode(commit_hex).context("--commit must be hex")?;
    let doc_id = svc
        .review(
            handle.v1_contract_id()?,
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

/// Post the `merge` event closing a PR.
///
/// This command does NOT perform a git merge, and the event it posts is inert unless two
/// things hold: the caller holds WRITE or MAINTAIN, and the oid has already been pushed to
/// the base ref (`fold_pr_state` only accepts a merge whose oid was a base-ref tip). It used
/// to report `"status": "merged"` unconditionally, so a caller holding no token on a repo
/// saw a successful merge, exited 0, and the PR stayed open forever — and `--json`
/// consumers keyed off that. Now the state is re-read afterwards and reported as it is.
async fn merge(ctx: &Ctx, repo: &str, number: u64, merge_oid: Option<&str>) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    if !ctx.confirm(&format!("Merge PR #{number}? (posts a merge event)"))? {
        return Err(crate::errors::cancelled());
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = PullRequestService::new(&client, &identity, &bridge);
    let pr = svc
        .get_pr(handle.v1_contract_id()?, number)
        .await?
        .ok_or_else(|| {
            crate::errors::not_found(
                format!("pull request #{number} not found in {repo}"),
                format!("`dg pr list {repo}` lists its pull requests"),
            )
        })?;
    let oid_hex = merge_oid.unwrap_or(&pr.head_oid);
    let oid = hex::decode(oid_hex).context("--merge-oid must be hex")?;
    let event_id = svc
        .merge_event(handle.v1_contract_id()?, &pr.document_id, &oid)
        .await
        .context("merge_event")?;

    // Re-read the fold. A merge event is only authoritative if the fold accepts it, so
    // asking the same question a reader would ask is the only honest way to report the
    // outcome.
    let merged = svc
        .pr_state(handle.v1_contract_id()?, number, None)
        .await
        .ok()
        .flatten()
        .is_some_and(|pw| pw.state.merged);

    let (status, reason) = if merged {
        ("merged", None)
    } else {
        (
            "merge_event_posted",
            Some(
                "the event is not authoritative yet: it counts only once you hold WRITE or \
                 MAINTAIN on this repo AND the merge oid has been pushed to the base ref",
            ),
        )
    };

    ctx.emit(
        json!({
            "status": status,
            "pr": number,
            "mergeOid": oid_hex,
            "eventId": event_id,
            "merged": merged,
            "reason": reason,
        }),
        || {
            if merged {
                println!("Merged PR #{number} (merge {oid_hex}, event {event_id}).");
            } else {
                println!(
                    "Posted merge event for PR #{number} (merge {oid_hex}, event {event_id}), \
                     but the PR does not read as merged."
                );
                println!(
                    "The event counts only once you hold WRITE or MAINTAIN on this repo AND \
                     {oid_hex} has been pushed to {}.",
                    pr.base_ref_name
                );
                println!("  git push <dash-remote> {oid_hex}:{}", pr.base_ref_name);
            }
        },
    );
    Ok(())
}

/// Check a PR out: fetch its head from the repo that actually holds it, then create a
/// local `pr/<n>` branch at it.
///
/// This used to do no network I/O at all — it ran `git branch` only if the head object
/// happened to be in the local odb, which for a PR opened from a fork it never is, and told
/// the user to "fetch it first" without naming a remote that could deliver it. The PR
/// document does carry that pointer (`sourceContractId`), and the helper can now address a
/// repo by contract id, so the fetch it was describing can just be performed.
async fn checkout(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = PullRequestService::new(&client, &identity, &bridge);
    let pr = svc
        .get_pr(handle.v1_contract_id()?, number)
        .await?
        .ok_or_else(|| {
            crate::errors::not_found(
                format!("pull request #{number} not found in {repo}"),
                format!("`dg pr list {repo}` lists its pull requests"),
            )
        })?;

    let branch = format!("pr/{number}");
    let mut fetched = false;
    if !git_object_present(&pr.head_oid) {
        fetched = fetch_pr_head(ctx, &pr)?;
    }

    let present = git_object_present(&pr.head_oid);
    let mut created = false;
    if present {
        created = Command::new("git")
            .args(["branch", "-f", &branch, &pr.head_oid])
            .status()
            .is_ok_and(|s| s.success());
    }

    ctx.emit(
        json!({
            "pr": number,
            "headOid": pr.head_oid,
            "branch": branch,
            "sourceContractId": pr.source_contract_id,
            "sourceRefName": pr.source_ref_name,
            "fetched": fetched,
            "objectPresent": present,
            "branchCreated": created,
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
                println!(
                    "Could not obtain PR #{number} head {} from its source repo.",
                    pr.head_oid
                );
                println!("Fetch it by hand, then re-run checkout:");
                // A contract-addressed URL names no owner, so the helper cannot pick a
                // default identity file — spell out the variable it needs.
                println!(
                    "  DASH_FORGE_KEY=<identity.json> git fetch dash://{}",
                    pr.source_contract_id
                );
            }
        },
    );
    Ok(())
}

/// Fetch a PR's objects from the repo that holds them, returning whether the fetch ran.
///
/// Addresses the source repo by contract id (`dash://<contractId>`), because that is the
/// only pointer a `patch` document carries and nothing indexes a contract back to its
/// registry listing.
///
/// **The PR's `sourceRefName` is deliberately NOT passed to `git fetch`.** It is
/// attacker-chosen: `patch` carries no `tokenCost`, so any identity can open a PR against
/// any repo, and the field has no schema pattern. A positional `git fetch` argument is a
/// *refspec*, not a ref name — a value of `+refs/heads/evil:refs/heads/release` would
/// silently force-update a branch in the maintainer's own working repo the moment they ran
/// `dg pr checkout` (git refuses only the currently checked-out branch; every other local
/// branch is fair game — verified against git 2.43). `rules::is_legal_ref_name` does not
/// save us here: it permits both `:` and `+`, and being a write-side check it binds no
/// other client anyway.
///
/// Naming the ref bought nothing in the first place: the helper's fetch downloads the
/// union of the repo's kind-0 packs whatever refspec it is handed, so the default refspec
/// delivers exactly the same objects — including the head commit.
///
/// `source_contract_id` is safe to interpolate: it is re-encoded base58 from a decoded
/// `[u8; 32]`, and the empty case returns early.
fn fetch_pr_head(ctx: &Ctx, pr: &forge_core::collab::PullRequest) -> Result<bool> {
    if pr.source_contract_id.is_empty() {
        return Ok(false);
    }
    let url = format!("dash://{}", pr.source_contract_id);

    let mut cmd = Command::new("git");
    cmd.arg("fetch").arg(&url);
    // A contract-addressed URL names no owner, so the helper cannot derive a default key
    // path from it; hand it the identity this invocation already resolved. The network
    // (devnet name, DAPI list, registry override) must travel too, or the helper falls
    // back to its own default and a `--network mainnet` checkout would quietly query
    // testnet.
    if let Some(path) = &ctx.identity_path {
        cmd.env("DASH_FORGE_KEY", path);
    }
    cmd.envs(ctx.target.env_vars());

    let status = cmd.status().context("running git fetch for the PR head")?;
    Ok(status.success())
}

/// `diff`: run `git diff <base>...<head>`, fetching the PR head from its source repo first
/// when it is not already local.
async fn diff(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = PullRequestService::new(&client, &identity, &bridge);
    let pr = svc
        .get_pr(handle.v1_contract_id()?, number)
        .await?
        .ok_or_else(|| {
            crate::errors::not_found(
                format!("pull request #{number} not found in {repo}"),
                format!("`dg pr list {repo}` lists its pull requests"),
            )
        })?;

    if !git_object_present(&pr.head_oid) {
        fetch_pr_head(ctx, &pr)?;
    }

    if !git_object_present(&pr.head_oid) {
        ctx.emit(
            json!({
                "pr": number,
                "headOid": pr.head_oid,
                "sourceContractId": pr.source_contract_id,
                "diffAvailable": false,
                "note": "could not obtain the PR head from its source repo",
            }),
            || {
                println!(
                    "Could not obtain PR #{number} head {} from its source repo.",
                    pr.head_oid
                );
                if !pr.source_contract_id.is_empty() {
                    println!(
                        "  DASH_FORGE_KEY=<identity.json> git fetch dash://{}",
                        pr.source_contract_id
                    );
                }
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
        .is_ok_and(|s| s.success())
}
