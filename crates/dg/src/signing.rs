//! Signed commits (P1-7): `dg profile key list|add|remove` publish the keys you sign commits
//! with on your (public) profile, and `dg verify-commit` checks a clone's commits against the
//! keys a repository's owner and members publish, the same verdict the web's Verified badges
//! show (`forge_core::rules::signature`).

use std::path::Path;
use std::process::Command;

use anyhow::{bail, Context as _, Result};
use serde_json::json;

use crate::common::Reader;
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, safe};
use crate::ProfileKeyCommand;
use forge_core::profile::{self as core_profile, ProfileWrite};
use forge_core::rules::signature::{read_pubkey_entry, verify_commit_signature, SignatureVerdict};
use forge_core::signing_keys;
use forge_core::user_error::{codes, UserError};

/// A key edit `forge_core::signing_keys` refused (a duplicate, a full profile, a key Forge does
/// not verify), as E201: nothing was signed.
fn refused(e: forge_core::error::Error) -> anyhow::Error {
    let why = match e {
        forge_core::error::Error::Config(m) => m,
        other => return other.into(),
    };
    UserError::new(codes::USAGE, "signing key not accepted")
        .cause(why)
        .note("checked before anything was signed; nothing was written or paid")
        .into()
}

/// Dispatch a `profile key` subcommand.
pub async fn run_key(ctx: &Ctx, cmd: &ProfileKeyCommand) -> Result<()> {
    match cmd {
        ProfileKeyCommand::List => list(ctx).await,
        ProfileKeyCommand::Add { ssh, gpg } => add(ctx, ssh.as_deref(), gpg.as_deref()).await,
        ProfileKeyCommand::Remove { fingerprint } => remove(ctx, fingerprint).await,
    }
}

/// One line per key: its kind and fingerprint.
pub fn describe(entry: &str) -> String {
    let v = read_pubkey_entry(entry);
    let kind = match v.kind.as_str() {
        "ssh" => entry.split(' ').next().unwrap_or("ssh"),
        "openpgp" => "openpgp",
        _ => "invalid",
    };
    let note = if v.verifiable {
        ""
    } else {
        " (not verifiable here)"
    };
    format!(
        "{kind:<12} {}{note}",
        v.fingerprint.as_deref().unwrap_or("?")
    )
}

async fn list(ctx: &Ctx) -> Result<()> {
    let client = ctx.connect().await?;
    let forge = ctx.target.require_v2()?;
    let me = match ctx.identity_id_hint() {
        Some(id) => id,
        None => ctx.load_bridge()?.identity_id,
    };
    let keys = core_profile::read_profile(&client, forge, &me)
        .await?
        .map(|p| p.pubkeys)
        .unwrap_or_default();
    ctx.emit(
        json!({
            "keys": keys.iter().map(|k| {
                let v = read_pubkey_entry(k);
                json!({"entry": k, "kind": v.kind, "fingerprint": v.fingerprint, "verifiable": v.verifiable})
            }).collect::<Vec<_>>(),
        }),
        || {
            if keys.is_empty() {
                println!("no signing keys on your profile; `dg profile key add` publishes the one git signs with");
            }
            for k in &keys {
                println!("{}", describe(k));
            }
        },
    );
    Ok(())
}

/// `git config --get <key>` here, or `None`.
fn git_config(key: &str) -> Option<String> {
    crate::git::config_get(Path::new("."), key)
}

/// The entry for the SSH key `spec` names: a public key line, a `key::` line from git config, or
/// a path to a `.pub` file (a private key's path reads its `.pub` beside it).
fn ssh_from(spec: &str) -> Result<String> {
    let spec = spec.strip_prefix("key::").unwrap_or(spec);
    if spec.starts_with("ssh-") || spec.starts_with("sk-") || spec.starts_with("ecdsa-") {
        return signing_keys::ssh_entry(spec).map_err(refused);
    }
    let path = shellexpand_home(spec);
    let pub_path = if path.extension().is_some_and(|e| e == "pub") {
        path
    } else {
        path.with_extension(match path.extension() {
            Some(e) => format!("{}.pub", e.to_string_lossy()),
            None => "pub".into(),
        })
    };
    let line = std::fs::read_to_string(&pub_path)
        .with_context(|| format!("reading the SSH public key {}", pub_path.display()))?;
    signing_keys::ssh_entry(line.trim()).map_err(refused)
}

fn shellexpand_home(p: &str) -> std::path::PathBuf {
    match (p.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => Path::new(&home).join(rest),
        _ => p.into(),
    }
}

/// The entry for the OpenPGP key `id` names, exported with `gpg` (git's `gpg.program`).
fn gpg_from(id: &str) -> Result<String> {
    let program = git_config("gpg.openpgp.program")
        .or_else(|| git_config("gpg.program"))
        .unwrap_or_else(|| "gpg".into());
    let out = Command::new(&program)
        .args(["--export", id.trim_end_matches('!')])
        .output()
        .with_context(|| format!("running {program} --export"))?;
    if !out.status.success() || out.stdout.is_empty() {
        bail!(
            UserError::new(codes::USAGE, format!("{program} has no public key {id:?}"))
                .cause(String::from_utf8_lossy(&out.stderr).trim().to_string())
                .fix("`gpg --list-secret-keys --keyid-format long` lists your keys")
                .fix("or pass --ssh for an SSH signing key")
        );
    }
    signing_keys::openpgp_entry(&out.stdout, Some(id)).map_err(refused)
}

/// The entry `--ssh`/`--gpg` name, or git's own signing key (`gpg.format`, `user.signingkey`).
fn entry_for(ssh: Option<&str>, gpg: Option<&str>) -> Result<String> {
    match (ssh, gpg) {
        (Some(s), _) => ssh_from(s),
        (None, Some(g)) => gpg_from(g),
        (None, None) => {
            let Some(key) = git_config("user.signingkey") else {
                bail!(
                    UserError::new(codes::USAGE, "no key named and git has no user.signingkey")
                        .fix(
                            "`dg profile key add --ssh ~/.ssh/id_ed25519.pub` or `--gpg <key id>`"
                        )
                );
            };
            match git_config("gpg.format").as_deref() {
                Some("ssh") => ssh_from(&key),
                Some("x509") => bail!(UserError::new(
                    codes::UNSUPPORTED,
                    "git signs with X.509 here (gpg.format=x509), which Forge does not verify"
                )
                .fix("use an Ed25519 SSH or OpenPGP key")),
                _ => gpg_from(&key),
            }
        }
    }
}

async fn add(ctx: &Ctx, ssh: Option<&str>, gpg: Option<&str>) -> Result<()> {
    let entry = entry_for(ssh, gpg)?;
    ctx.require_confirmable("dg profile key add")?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let forge = ctx.target.require_v2()?;
    let me = identity.id();
    let stored = core_profile::read_profile(&client, forge, &me).await?;
    let current = stored
        .as_ref()
        .map(|p| p.pubkeys.clone())
        .unwrap_or_default();
    let keys = signing_keys::with_key(&current, entry.clone()).map_err(refused)?;
    let price = ctx.usd_price();
    let quote = if stored.is_none() {
        crate::quote::profile(entry.len() as u64)
    } else {
        crate::quote::replace(entry.len() as u64)
    };
    ctx.confirm_or_cancel(&format!(
        "Publish {} on your profile? ({}; public: anyone can read it)",
        describe(&entry),
        cost_line(quote, price)
    ))?;
    let engine = core_profile::engine(&client, &identity, &bridge)?;
    let before = client.get_balance(&me).await.unwrap_or(0);
    signing_keys::write_pubkeys(&engine, &client, forge, stored.as_ref(), &keys).await?;
    let spent = crate::common::spent_since(&client, &me, before).await;
    let v = read_pubkey_entry(&entry);
    ctx.emit(
        json!({"status": "added", "entry": entry, "fingerprint": v.fingerprint, "cost": cost_json(spent, price)}),
        || {
            println!("✓ signing key added: {} · {}", describe(&entry), cost_line(spent, price));
            println!("  commits you sign with it show Verified in repositories you are a member of");
        },
    );
    Ok(())
}

async fn remove(ctx: &Ctx, fingerprint: &str) -> Result<()> {
    ctx.require_confirmable("dg profile key remove")?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let forge = ctx.target.require_v2()?;
    let me = identity.id();
    let Some(stored) = core_profile::read_profile(&client, forge, &me).await? else {
        bail!(UserError::new(
            codes::USAGE,
            "you have no profile, so no keys to remove"
        ));
    };
    let keys = signing_keys::without_key(&stored.pubkeys, fingerprint).map_err(refused)?;
    let price = ctx.usd_price();
    ctx.confirm_or_cancel(&format!(
        "Remove the key ending {fingerprint} from your profile? ({}; commits signed with it then show Unverified)",
        cost_line(crate::quote::replace(0), price)
    ))?;
    let engine = core_profile::engine(&client, &identity, &bridge)?;
    let wrote = signing_keys::write_pubkeys(&engine, &client, forge, Some(&stored), &keys).await?;
    ctx.emit(
        json!({"status": if matches!(wrote, ProfileWrite::Unchanged(_)) { "unchanged" } else { "removed" }}),
        || println!("✓ signing key removed"),
    );
    Ok(())
}

// --- dg verify-commit --------------------------------------------------------------------------

/// `git <args>` here, its stdout as bytes.
fn git_bytes(args: &[&str]) -> Result<Vec<u8>> {
    let out = Command::new("git")
        .args(args)
        .output()
        .with_context(|| format!("running git {}", args.join(" ")))?;
    if !out.status.success() {
        bail!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(out.stdout)
}

/// The words of a verdict for a terminal.
pub(crate) fn verdict_words(v: &SignatureVerdict, names: &impl Fn(&str) -> String) -> String {
    let key = v.key.as_deref().unwrap_or("?");
    match (v.status.as_str(), v.reason.as_deref()) {
        ("verified", _) => format!(
            "Verified    {} · {} {key}",
            v.signer.as_deref().map(names).unwrap_or_default(),
            v.format
        ),
        (_, Some("unknown_key")) => format!(
            "Unverified  {} key {key} is on no member's profile",
            v.format
        ),
        (_, Some("ambiguous_key")) => format!(
            "Unverified  {} key {key} is on more than one profile",
            v.format
        ),
        (_, Some("bad_signature")) => format!("Unverified  BAD signature ({} key {key})", v.format),
        (_, Some("unsupported")) => format!(
            "Unverified  {} signature of a kind Forge does not check",
            v.format
        ),
        _ => "Unverified  the signature could not be read".into(),
    }
}

/// `dg verify-commit <REV>... [-R <repo>]`: each commit's verdict.
pub async fn verify_commits(
    ctx: &Ctx,
    repo: Option<&str>,
    revs: &[String],
    author: &[String],
) -> Result<()> {
    let Some(repo) = repo.map(str::to_string).or_else(crate::storage::clone_repo) else {
        bail!(
            UserError::new(codes::USAGE, "which repository's keys count?")
                .cause("this directory is not a clone of a Forge repository")
                .fix("run it in a clone, or pass -R <owner/name>")
        );
    };
    let r = Reader::open(ctx, &repo).await?;
    let mut extra = Vec::new();
    for a in author {
        extra.push(forge_core::resolve::resolve_owner(&r.client, a).await?);
    }
    let signers = signing_keys::repo_signers(&r.client, &r.repo, &extra).await?;
    let sha256 = git_bytes(&["rev-parse", "--show-object-format"])
        .is_ok_and(|o| String::from_utf8_lossy(&o).trim() == "sha256");
    let mut rows = Vec::new();
    for rev in revs {
        let oid = String::from_utf8_lossy(&git_bytes(&[
            "rev-parse",
            "--verify",
            &format!("{rev}^{{commit}}"),
        ])?)
        .trim()
        .to_string();
        let raw = git_bytes(&["cat-file", "commit", &oid])?;
        rows.push((
            rev.clone(),
            oid,
            verify_commit_signature(&raw, &signers, sha256),
        ));
    }
    let any_bad = rows.iter().any(|(_, _, v)| {
        v.as_ref()
            .is_some_and(|v| v.reason.as_deref() == Some("bad_signature"))
    });
    ctx.emit(
        json!({
            "repo": r.repo.display(),
            "commits": rows.iter().map(|(rev, oid, v)| json!({"rev": rev, "oid": oid, "signature": v})).collect::<Vec<_>>(),
        }),
        || {
            for (_, oid, v) in &rows {
                let short = &oid[..oid.len().min(12)];
                match v {
                    None => println!("{short}  unsigned"),
                    Some(v) => println!("{short}  {}", verdict_words(v, &|id: &str| safe(id).into_owned())),
                }
            }
        },
    );
    if any_bad {
        bail!(
            UserError::new(codes::INTEGRITY, "a commit's signature does not match it")
                .cause("the commit was changed after it was signed, or its signature is not git's")
        );
    }
    Ok(())
}
