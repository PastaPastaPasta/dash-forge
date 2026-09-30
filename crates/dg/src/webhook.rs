//! `dg webhook` — forge-v2 webhooks: add / list / remove.
//!
//! A webhook is a forge-community `webhook` document a maintainer writes: a URL, the events it
//! wants, the relay identity that delivers them, and the HMAC secret encrypted to that relay's
//! encryption key (`forge_core::webhooks`). The relay reads it from Platform, so pointing a
//! repo at another relay is `dg webhook add` again with `--relay <other>` and the same
//! `--name`.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Subcommand;
use serde_json::json;

use forge_core::cost::estimate;
use forge_core::envelope::SecretBytes;
use forge_core::user_error::{codes, UserError};
use forge_core::webhooks::{
    generate_secret, hook_id_for_label, newest_per_hook, random_hook_id, NewWebhook, WebhookReader,
    WebhookService,
};

use crate::common::{resolve, Reader, RepoRef};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line};
use crate::secret_out::{self, Stream, Surroundings};

/// `dg webhook` subcommands.
#[derive(Debug, Subcommand)]
pub enum WebhookCommand {
    /// Add (or replace) a webhook: a relay POSTs GitHub-shaped events for the repo to a URL.
    Add(AddArgs),
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

/// `dg webhook add` arguments.
#[derive(Debug, clap::Args)]
pub struct AddArgs {
    /// The repository (`owner/name`, a bare name of yours, or a repo id).
    repo: String,
    /// Where to deliver: https:// to a DNS name, with an optional port (forge-community refuses
    /// http, IP addresses, localhost and user:password@). The URL is stored publicly on chain.
    /// Public repositories only.
    #[arg(long)]
    url: String,
    /// The relay identity (base58) that delivers; the secret is encrypted to its key.
    #[arg(long)]
    relay: String,
    /// GitHub event names to deliver (push, issues, pull_request, issue_comment,
    /// pull_request_review, release, check_run); default all.
    #[arg(long, value_delimiter = ',')]
    events: Vec<String>,
    /// Read the secret from this environment variable (32..=96 printable ASCII characters,
    /// no spaces). Without it a random secret is generated: shown once on a terminal, or
    /// written to --secret-file.
    #[arg(long, value_name = "VAR")]
    secret_env: Option<String>,
    /// Write the generated secret to this new file (0600; an existing file is refused) instead
    /// of showing it. Required without a terminal (CI, pipes, --json) unless --secret-env is
    /// given: a generated secret is never printed there.
    #[arg(long, value_name = "FILE", conflicts_with = "secret_env")]
    secret_file: Option<PathBuf>,
    /// A name for the hook; adding again under the same name replaces it. Default: a new
    /// random hook id.
    #[arg(long)]
    name: Option<String>,
    /// Accept a URL with a query string (it is public on chain).
    #[arg(long)]
    force: bool,
}

impl WebhookCommand {
    /// The error headline and the repo, for `errors::context_for`.
    pub fn context(&self) -> (&'static str, Option<&String>) {
        match self {
            WebhookCommand::Add(a) => ("webhook not added", Some(&a.repo)),
            WebhookCommand::List { repo } => ("could not list webhooks", Some(repo)),
            WebhookCommand::Remove { repo, .. } => ("webhook not removed", Some(repo)),
        }
    }
}

/// Dispatch a `webhook` subcommand.
pub async fn run(ctx: &Ctx, cmd: &WebhookCommand) -> Result<()> {
    match cmd {
        WebhookCommand::Add(args) => add(ctx, args).await,
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

async fn add(ctx: &Ctx, args: &AddArgs) -> Result<()> {
    let AddArgs {
        repo,
        url,
        relay,
        events,
        ..
    } = args;
    let repo_ref = RepoRef::parse(repo)?;
    let (secret, show) = hook_secret(ctx, args)?;
    let hook_id = args
        .name
        .as_deref()
        .map_or_else(random_hook_id, hook_id_for_label);

    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = WebhookService::new(&client, &identity, &bridge);
    svc.require_maintainer(&handle).await?;
    let prepared = svc
        .prepare(
            &handle,
            &NewWebhook {
                hook_id,
                url: url.clone(),
                events: events.clone(),
                relay_identity_id: relay.clone(),
                secret: secret.clone(),
                disabled: false,
                allow_credentials_in_url: args.force,
            },
        )
        .await
        .context("preparing the webhook")?;

    let price = ctx.usd_price();
    let credits = estimate(prepared.approx_bytes).total();
    if !ctx.json {
        println!(
            "Adding a webhook to {} → {url} (relay {relay}, key {})\n  webhook document     {}",
            handle.display(),
            prepared.relay_key_id,
            cost_line(credits, price)
        );
    }
    // On stderr in every mode, so --json output stays parseable and scripts still see it.
    eprintln!(
        "note: the webhook URL (including its path) and event list are public on chain; only \
         the secret is encrypted. Do not put tokens in the URL."
    );
    if !ctx.confirm(&format!("Add the webhook to {}?", handle.display()))? {
        return Err(crate::errors::cancelled());
    }
    // Kept before the hook is written, so a hook whose secret nobody holds is never added.
    if let Some(p) = &args.secret_file {
        secret_out::write_new_file(p, secret.expose())?;
    }
    let document_id = svc
        .send(&handle, &prepared)
        .await
        .with_context(|| send_failure(args.secret_file.as_deref()))?;

    // A generated secret is shown exactly once, and only on a terminal: on chain it exists
    // only encrypted to the relay (and to this identity's own key). A secret from
    // --secret-env, or one written to --secret-file, is never echoed, and never in --json.
    let secret_text = show
        .then(|| zeroize::Zeroizing::new(String::from_utf8_lossy(secret.expose()).into_owned()));
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
            "secretFile": args.secret_file.as_ref().map(|p| p.display().to_string()),
            "estimate": cost_json(credits, price),
        }),
        || {
            println!(
                "✓ webhook {} (document {document_id})",
                hex::encode(hook_id)
            );
            print_secret(
                secret_text.as_deref().map(String::as_str),
                args.secret_file.as_deref(),
            );
        },
    );
    Ok(())
}

/// The context of a failed hook write: where its secret was kept, if in a file.
fn send_failure(secret_file: Option<&std::path::Path>) -> String {
    secret_file.map_or_else(
        || "writing the webhook".to_string(),
        |p| {
            format!(
                "writing the webhook (it may still land: `dg webhook list`; {} holds its secret \
                 if it did, else delete it and run again)",
                p.display()
            )
        },
    )
}

/// The secret's line after a hook is added: the secret itself (a terminal only), or its file.
fn print_secret(shown: Option<&str>, file: Option<&std::path::Path>) {
    if let Some(s) = shown {
        println!("  secret (shown once; configure it at the receiver): {s}");
    }
    if let Some(p) = file {
        println!(
            "  secret written to {} (0600); configure it at the receiver, then delete the file",
            p.display()
        );
    }
}

/// The hook's secret, and whether to show it (a generated one going to no --secret-file),
/// decided before anything is read or signed.
fn hook_secret(ctx: &Ctx, args: &AddArgs) -> Result<(SecretBytes, bool)> {
    if let Some(var) = &args.secret_env {
        // `var_os`, not `var`: a `VarError::NotUnicode` would print the value itself.
        let value = std::env::var_os(var)
            .ok_or_else(|| crate::errors::usage(format!("--secret-env: ${var} is not set")))?
            .into_string()
            .map_err(|_| crate::errors::usage(format!("--secret-env: ${var} is not UTF-8")))?;
        return Ok((SecretBytes::new(value.into_bytes()), false));
    }
    match &args.secret_file {
        Some(p) if p.symlink_metadata().is_ok() => Err(crate::errors::usage(format!(
            "--secret-file {} exists; name a new file (it is never overwritten)",
            p.display()
        ))),
        Some(_) => Ok((generate_secret(), false)),
        None => {
            refuse_unless_shown(Surroundings::detect(ctx.json, Stream::Stdout))?;
            Ok((generate_secret(), true))
        }
    }
}

/// Refuse to generate a secret that would be printed where a person may not be its only reader.
fn refuse_unless_shown(here: Surroundings) -> Result<()> {
    let Some(why) = here.why_not() else {
        return Ok(());
    };
    Err(UserError::new(
        codes::USAGE,
        "the generated webhook secret has nowhere safe to go",
    )
    .cause(format!(
        "{why}, and dg never prints a secret where a log or another program could keep it"
    ))
    .fix("pass --secret-file <new file>: the secret goes only to that file (0600) and only its path is printed")
    .fix("or pass --secret-env <VAR> with a secret you made (32 to 96 printable characters)")
    .fix("or run it in a terminal to see the secret once")
    .note("nothing was written or paid")
    .into())
}

/// A read: no key is opened for a public repository (QW-034: a sealed key with no terminal
/// stopped it with E303, while every other list reads on).
async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    let r = Reader::open(ctx, repo).await?;
    let handle = &r.repo;
    let hooks = newest_per_hook(
        WebhookReader::new(&r.client)
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
