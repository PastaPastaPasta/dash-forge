//! `dg branch share <b> --to @x`: give someone outside the members one members-only branch as it
//! is now (mixed-visibility DESIGN §4.3 "Branch keys for CI and people", §9 3G;
//! `docs/security/private-repos.md` §20.2).
//!
//! The share is a `branch` key letter (kind 10) to the recipients and the sharer: the branch's
//! head, the blind its push carries with its salt, the keyed name hash of that push, and the file
//! keys of the members-only packs that hold the branch's commits beyond the public branches. The
//! recipient's `git fetch` then lists the branch and opens just those packs, without the members
//! key. It is a snapshot: what is pushed to the branch later is under the members key, which the
//! recipient does not hold, until it is shared again.
//!
//! Which packs: [`forge_core::members_git::share`] (shared with the git helper's letters to
//! runner bots).

use std::path::Path;

use anyhow::{Context as _, Result};
use serde_json::json;

use forge_core::members_git::share::{self, Snapshot};
use forge_core::private::key_letter;
use forge_core::private::named::{Recipient, MAX_ARTIFACT_RECIPIENTS};
use forge_core::rules::v2::{Role, Visibility};
use forge_core::user_error::{codes, UserError};

use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::safe;
use crate::git;

/// A refusal that shares nothing.
fn nothing_shared(code: &'static str, why: impl Into<String>) -> UserError {
    UserError::new(code, why).note("nothing was shared")
}

fn nobody_refusal(why: impl Into<String>) -> anyhow::Error {
    nothing_shared(codes::USAGE, why).into()
}

/// The people `--to` names, each once and never the sharer: `(identity id, the word that named
/// them)` and their recipient slots, in the same order.
async fn resolve_recipients(
    s: &Session,
    to: &[String],
    me: &str,
    action: &str,
) -> Result<(Vec<(String, String)>, Vec<Recipient>)> {
    let mut names: Vec<(String, String)> = Vec::new();
    let mut recipients: Vec<Recipient> = Vec::new();
    for word in to.iter().map(|w| w.trim()).filter(|w| !w.is_empty()) {
        let id = crate::common::resolve_identity(&s.client, word, "recipient").await?;
        if id == me || names.iter().any(|(i, _)| *i == id) {
            continue;
        }
        let identity = s.client.fetch_identity(&id).await?;
        let keys = identity.public_keys();
        let Some(pk) = forge_core::keyring::recipient_key(&keys, &s.repo.forge().core)
            .and_then(|k| <[u8; 33]>::try_from(k.public_key.as_slice()).ok())
        else {
            return Err(nothing_shared(
                codes::NO_ENCRYPTION_KEY,
                format!(
                    "{action}: {word} has no encryption key, so nothing can be shared with them"
                ),
            )
            .fix(format!(
                "ask {word} to add one: `dg auth keys add --encryption`"
            ))
            .into());
        };
        recipients.push(Recipient {
            identity_id: forge_core::platform::decode_identifier(&id)?,
            public_key: pk,
        });
        names.push((id, word.to_owned()));
    }
    Ok((names, recipients))
}

/// Branch `full` of the session's repository as it is now, in the clone at `cwd`
/// ([`forge_core::members_git::share::snapshot`]), saying first that the packs are being read.
pub async fn snapshot(
    ctx: &Ctx,
    s: &Session,
    svc: &forge_core::repo::RepoService<'_>,
    kr: &std::sync::Arc<forge_core::keyring::Keyring>,
    cwd: &Path,
    full: &str,
) -> Result<Snapshot> {
    let json = ctx.json;
    let progress = |line: &str| {
        if !json {
            eprintln!("{}", safe(line));
        }
    };
    Ok(share::snapshot(svc, &s.repo, kr, cwd, full, &progress).await?)
}

/// Run `dg branch share <name> --to …`.
#[allow(clippy::too_many_lines)] // one pass: who, which branch, which packs, the letter, the write
pub async fn share(ctx: &Ctx, name: &str, to: &[String]) -> Result<()> {
    let cwd = std::env::current_dir().context("reading the current directory")?;
    let full = git::full_ref(name);
    git::require_branch_ref(&full)?;
    let short = forge_core::repo::short_branch_name(&full).to_owned();
    let repo = crate::storage::clone_repo().ok_or_else(|| {
        crate::errors::usage(
            "not in a clone of a Forge repository: share a members-only branch from a clone that has it",
        )
    })?;
    let s = Session::open_for_write(ctx, &repo, "nothing shared").await?;
    if s.repo.visibility != Visibility::Public {
        return Err(nobody_refusal(format!(
            "{} is private: everyone who can see its branches is a member. Add people with `dg collab add`",
            s.repo.display()
        )));
    }
    let svc = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge);
    let me = s.identity.id();
    let role = forge_core::members::MemberReader::new(&s.client)
        .best_role(&s.repo, &me)
        .await?;
    if !matches!(role, Some(Role::Maintainer | Role::Writer)) {
        return Err(nothing_shared(
            codes::NOT_A_WRITER,
            format!("share {short}: only members with Write or Maintain access can share a members-only branch"),
        )
        .into());
    }
    let kr = svc.keyring(&s.repo).await?;
    if !kr.has_members_key() {
        return Err(nothing_shared(
            codes::MEMBERS_ONLY_OFF,
            format!("{} has no members-only content", s.repo.display()),
        )
        .into());
    }
    if kr.resolution().keys.is_empty() {
        return Err(nothing_shared(
            codes::NO_KEY_SHARED,
            format!("share {short}: no key has been shared with you yet, so you can't read its members-only branches"),
        )
        .fix("ask a maintainer to run `dg repo members repair`")
        .into());
    }

    let snap = snapshot(ctx, &s, &svc, &kr, &cwd, &full).await?;
    let (tip, commits, choice, extra_objects) =
        (&snap.tip, snap.commits, &snap, snap.extra_objects);

    // the recipients: the sharer first, then each person named
    let signer = forge_core::keyring::PrivateSigner {
        client: &s.client,
        identity: &s.identity,
        bridge: &s.bridge,
    };
    let enc = signer.encryption_keys(&s.repo);
    let action = format!("share {short}");
    let (sender_key_id, sender) = enc
        .sender()
        .ok_or_else(|| forge_core::keyring::no_members_encryption_key_held(&action))?;
    let me_bytes = forge_core::platform::decode_identifier(&me)?;
    let (names, others) = resolve_recipients(&s, to, &me, &action).await?;
    let mut recipients = vec![Recipient {
        identity_id: me_bytes,
        public_key: sender.public_key(),
    }];
    recipients.extend(others);
    if names.is_empty() {
        return Err(crate::errors::usage(
            "--to names nobody to share with but you: give @names or identity ids",
        ));
    }
    if recipients.len() > MAX_ARTIFACT_RECIPIENTS {
        return Err(nobody_refusal(format!(
            "a branch can be shared with at most {} people at once",
            MAX_ARTIFACT_RECIPIENTS - 1
        )));
    }

    // the letter
    let letter = &snap.letter;
    let typed = letter
        .to_typed()
        .context("the share could not be written: its head did not check")?;
    if let Err(key_letter::LetterError::TooLarge(_)) = typed.encode() {
        return Err(nobody_refusal(format!(
            "{short} has too many pushes to share at once ({} packs)",
            choice.packs
        )));
    }
    let sealed = key_letter::seal(
        &s.repo.scope()?.repo_id,
        sender,
        sender_key_id,
        &me_bytes,
        &recipients,
        &typed,
    )
    .map_err(|e| anyhow::anyhow!("{action}: {e}"))?;
    if sealed.len() as u64 > forge_core::env::service::MAX_SEALED {
        return Err(nobody_refusal(format!(
            "{short} has too many pushes to share at once ({} packs)",
            choice.packs
        )));
    }
    let credits = forge_core::env::service::snapshot_credits(sealed.len() as u64);
    let who = names
        .iter()
        .map(|(_, w)| w.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    if !ctx.json {
        eprintln!(
            "Share {} with {who} as it is now: {commits} commit(s) beyond the public branches, head {}.",
            safe(&short),
            crate::fmt::short(tip)
        );
        if extra_objects > 0 {
            eprintln!(
                "  They also get {extra_objects} git object(s) that aren't on {} ({} of them commits): another members-only branch or an earlier push stored them with its commits.",
                safe(&short),
                choice.extra_commits
            );
        }
        eprintln!(
            "  They won't see anything pushed to {} later unless you share it again. Sharing can't be undone.",
            safe(&short)
        );
        eprintln!(
            "  Cost: {}",
            crate::fmt::cost_line(credits, ctx.usd_price())
        );
    }
    ctx.confirm_or_cancel(&format!("Share {} with {who}?", safe(&short)))?;
    let ((id, pack_hash), spent) = s.metered(|| svc.store_key_letter(&s.repo, &sealed)).await?;
    ctx.emit(
        json!({
            "status": "shared",
            "branch": short,
            "ref": full,
            "head": tip,
            "commits": commits,
            "extraCommits": choice.extra_commits,
            "extraObjects": extra_objects,
            "packs": choice.packs,
            "to": names.iter().map(|(i, _)| i).collect::<Vec<_>>(),
            "letter": id,
            "packHash": hex::encode(pack_hash),
            "cost": crate::fmt::cost_json(spent, ctx.usd_price()),
        }),
        || {
            println!("✓ shared {} with {who} as it is now", safe(&short));
            println!("  they get it with `git fetch`; anything pushed to it later isn't shared unless you share it again");
            println!("  spent {}", crate::fmt::cost_line(spent, ctx.usd_price()));
        },
    );
    Ok(())
}

