//! `dg webhook` — forge-v2 webhooks: add / list / remove.
//!
//! A webhook is a forge-collab `webhook` document a maintainer writes: a URL, the events it
//! wants, the relay identity that delivers them, and the HMAC secret encrypted to that relay's
//! encryption key (`forge_core::webhooks`). The relay reads it from Platform, so pointing a
//! repo at another relay is `dg webhook add` again with `--relay <other>` and the same
//! `--name`.

use anyhow::{Context, Result};
use clap::Subcommand;
use serde_json::json;

use forge_core::cost::estimate;
use forge_core::envelope::SecretBytes;
use forge_core::webhooks::{
    generate_secret, hook_id_for_label, newest_per_hook, random_hook_id, NewWebhook, WebhookReader,
    WebhookService,
};

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, dash_usd_price};

/// `dg webhook` subcommands.
#[derive(Debug, Subcommand)]
pub enum WebhookCommand {
    /// Add (or replace) a webhook: a relay POSTs GitHub-shaped events for the repo to a URL.
    Add {
        /// The repository (`owner/name`, a bare name of yours, or a repo id).
        repo: String,
        /// Where to deliver (http:// or https://; the relay refuses private addresses
        /// unless it runs with --allow-private).
        #[arg(long)]
        url: String,
        /// The relay identity (base58) that delivers; the secret is encrypted to its key.
        #[arg(long)]
        relay: String,
        /// GitHub event names to deliver (push, issues, pull_request, issue_comment,
        /// pull_request_review, release, check_run); default all.
        #[arg(long, value_delimiter = ',')]
        events: Vec<String>,
        /// Read the secret from this environment variable (32..=96 bytes). Without it a
        /// random secret is generated and printed once.
        #[arg(long, value_name = "VAR")]
        secret_env: Option<String>,
        /// A name for the hook; adding again under the same name replaces it. Default: a
        /// new random hook id.
        #[arg(long)]
        name: Option<String>,
    },
    /// List the repository's webhooks (the newest document of each).
    List {
        /// The repository.
        repo: String,
    },
    /// Remove a webhook (by hook id hex or --name label).
    Remove {
        /// The repository.
        repo: String,
        /// The hook id (64 hex characters) or the name it was added with.
        hook: String,
    },
}

impl WebhookCommand {
    /// The error headline and the repo, for `errors::context_for`.
    pub fn context(&self) -> (&'static str, Option<&String>) {
        match self {
            WebhookCommand::Add { repo, .. } => ("webhook not added", Some(repo)),
            WebhookCommand::List { repo } => ("could not list webhooks", Some(repo)),
            WebhookCommand::Remove { repo, .. } => ("webhook not removed", Some(repo)),
        }
    }
}

/// Dispatch a `webhook` subcommand.
pub async fn run(ctx: &Ctx, cmd: &WebhookCommand) -> Result<()> {
    match cmd {
        WebhookCommand::Add {
            repo,
            url,
            relay,
            events,
            secret_env,
            name,
        } => {
            add(
                ctx,
                repo,
                url,
                relay,
                events,
                secret_env.as_deref(),
                name.as_deref(),
            )
            .await
        }
        WebhookCommand::List { repo } => list(ctx, repo).await,
        WebhookCommand::Remove { repo, hook } => remove(ctx, repo, hook).await,
    }
}

/// A hook id from the user: 64 hex characters, else the hash of a name.
fn parse_hook(input: &str) -> [u8; 32] {
    let mut id = [0u8; 32];
    if input.len() == 64 && hex::decode_to_slice(input, &mut id).is_ok() {
        return id;
    }
    hook_id_for_label(input)
}

async fn add(
    ctx: &Ctx,
    repo: &str,
    url: &str,
    relay: &str,
    events: &[String],
    secret_env: Option<&str>,
    name: Option<&str>,
) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (secret, generated) = match secret_env {
        Some(var) => (
            SecretBytes::new(
                std::env::var(var)
                    .with_context(|| format!("reading the secret from ${var}"))?
                    .into_bytes(),
            ),
            false,
        ),
        None => (generate_secret(), true),
    };
    let hook_id = name.map_or_else(random_hook_id, hook_id_for_label);

    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = WebhookService::new(&client, &identity, &bridge);
    svc.require_maintainer(&handle).await?;
    let prepared = svc
        .prepare(
            &handle,
            &NewWebhook {
                hook_id,
                url: url.to_string(),
                events: events.to_vec(),
                relay_identity_id: relay.to_string(),
                secret: secret.clone(),
                disabled: false,
            },
        )
        .await
        .context("preparing the webhook")?;

    let price = dash_usd_price();
    let credits = estimate(prepared.approx_bytes).total();
    if !ctx.json {
        println!(
            "Adding a webhook to {} → {url} (relay {relay}, key {})\n  webhook document     {}",
            handle.display(),
            prepared.relay_key_id,
            cost_line(credits, price)
        );
    }
    if !ctx.confirm(&format!("Add the webhook to {}?", handle.display()))? {
        return Err(crate::errors::cancelled());
    }
    let document_id = svc
        .send(&handle, &prepared)
        .await
        .context("writing the webhook")?;

    // A generated secret is shown exactly once: on chain it exists only encrypted to the
    // relay (and to this identity's own key). A secret from --secret-env is never echoed.
    let secret_text = generated.then(|| String::from_utf8_lossy(secret.expose()).into_owned());
    ctx.emit(
        json!({
            "status": "created",
            "repo": handle.display(),
            "repoId": handle.id(),
            "documentId": document_id,
            "hookId": hex::encode(hook_id),
            "url": url,
            "events": events,
            "relayIdentityId": relay,
            "relayKeyId": prepared.relay_key_id,
            "senderKeyId": prepared.sender_key_id,
            "secret": secret_text,
            "estimate": cost_json(credits, price),
        }),
        || {
            println!(
                "✓ webhook {} (document {document_id})",
                hex::encode(hook_id)
            );
            if let Some(s) = &secret_text {
                println!("  secret (shown once; configure it at the receiver): {s}");
            }
        },
    );
    Ok(())
}

async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, _bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    handle.require_v2()?;
    let hooks = newest_per_hook(
        WebhookReader::new(&client)
            .for_repo(handle.id())
            .await
            .context("listing webhooks")?,
    );
    let rows: Vec<_> = hooks
        .iter()
        .map(|h| {
            json!({
                "hookId": h.hook_id_hex(),
                "documentId": h.document_id,
                "writer": h.owner_id,
                "createdAt": h.created_at,
                "url": h.url,
                "events": h.events,
                "relayIdentityId": h.relay_identity_id,
                "relayKeyId": h.relay_key_id,
                "disabled": h.disabled,
            })
        })
        .collect();
    ctx.emit(
        json!({ "repo": handle.display(), "count": rows.len(), "webhooks": rows }),
        || {
            println!("{} webhook(s) on {}:", hooks.len(), handle.display());
            for h in &hooks {
                let events = if h.events.is_empty() {
                    "all events".to_string()
                } else {
                    h.events.join(",")
                };
                println!(
                    "  {}  {}{}  [{events}]  relay {}",
                    &h.hook_id_hex()[..12],
                    h.url,
                    if h.disabled { " (disabled)" } else { "" },
                    h.relay_identity_id
                );
            }
        },
    );
    Ok(())
}

async fn remove(ctx: &Ctx, repo: &str, hook: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let hook_id = parse_hook(hook);
    if !ctx.confirm(&format!(
        "Remove webhook {hook} from {repo}? (deletes your documents for it; if another \
         maintainer's still delivers, writes a small disabled one over it)"
    ))? {
        return Err(crate::errors::cancelled());
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = WebhookService::new(&client, &identity, &bridge);
    svc.require_maintainer(&handle).await?;
    let report = svc
        .remove(&handle, hook_id)
        .await
        .context("removing the webhook")?;
    let found = !report.deleted.is_empty() || report.tombstone.is_some();
    ctx.emit(
        json!({
            "status": if found { "removed" } else { "not_found" },
            "repo": handle.display(),
            "hookId": hex::encode(hook_id),
            "deleted": report.deleted,
            "tombstone": report.tombstone,
        }),
        || {
            if found {
                println!(
                    "Removed webhook {} from {} ({} deleted{}).",
                    hex::encode(hook_id),
                    handle.display(),
                    report.deleted.len(),
                    report
                        .tombstone
                        .as_deref()
                        .map(|t| format!(", disabled by {t}"))
                        .unwrap_or_default()
                );
            } else {
                println!("No webhook {hook} on {}.", handle.display());
            }
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_ids_parse_from_hex_or_name() {
        let hex_id = "ab".repeat(32);
        assert_eq!(parse_hook(&hex_id), [0xab; 32]);
        assert_eq!(parse_hook("ci"), hook_id_for_label("ci"));
    }
}
