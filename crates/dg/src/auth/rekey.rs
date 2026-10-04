//! `dg auth keys rotate --encryption`: replace the identity's ENCRYPTION key
//! (`docs/security/private-repos.md` §5.2 "Rekey flow"), for a lost device or a leaked key.
//!
//! In order: add the new key `k+1` (derived from the recovery words, master-signed); rotate every
//! private repository this identity maintains so its new epoch is wrapped to the new key (§5.5);
//! name the repositories where it is only a member (a maintainer's repair check rotates them,
//! §5.6); then disable the old key. A rotation that fails leaves the old key enabled, and running
//! the command again picks up where it stopped: the newest enabled key is the new one, and a
//! repository already wrapped to it is skipped.

use std::path::Path;

use anyhow::{Context as _, Result};
use serde_json::{json, Value};

use forge_core::keyring::{self, EncryptionKeys, PrivateSigner};
use forge_core::keystore::BridgeIdentity;
use forge_core::platform::{identity_keys, IdentityKeyInfo, LoadedIdentity};
use forge_core::rules::v2::Role;
use forge_core::scope::RepoRef;
use forge_core::user_error::{codes, UserError};

use super::{master_identity, store, StorageArgs};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line};

/// What happened to one maintained repository.
enum Outcome {
    Rotated(keyring::Rotation),
    AlreadyMoved,
    NotMaintainer,
    Failed(String),
}

/// The rekey as it will run, worked out before anything is signed.
struct Plan {
    id: String,
    old_ids: Vec<u32>,
    new_id: u32,
    /// An earlier run already added the new key.
    resuming: bool,
    secret: identity_keys::EncryptionSecret,
    members: keyring::PrivateMemberships,
    keep_old: bool,
}

/// What the run did, for the report.
struct Done<'a> {
    plan: &'a Plan,
    outcomes: Vec<(&'a RepoRef, Outcome)>,
    disabled: Option<Vec<u32>>,
    stored: Option<store::Stored>,
}

impl Done<'_> {
    fn failed(&self) -> bool {
        self.outcomes
            .iter()
            .any(|(_, o)| matches!(o, Outcome::Failed(_)))
    }
}

pub(super) async fn rotate_encryption(
    ctx: &Ctx,
    master_file: Option<&Path>,
    storage: &StorageArgs,
    keep_old: bool,
) -> Result<()> {
    let forge = ctx
        .target
        .v2
        .clone()
        .context("Dash Forge is not deployed on this network")?;
    let current = ctx.load_bridge()?;
    let client = ctx.connect().await?;
    let master = master_identity(ctx, master_file, &current.identity_id)?;
    identity_keys::require_master_key(&master)?;
    let identity = client.fetch_signer(&master).await?;
    let plan = plan(ctx, &client, &forge, &master, &identity, keep_old).await?;
    let price = ctx.usd_price();
    if !ctx.json {
        print_plan(&plan, price);
    }
    ctx.confirm_or_cancel("Replace the key?")?;
    let before = client.get_balance(&plan.id).await.unwrap_or(0);

    // 1. The new key (nothing to do when an earlier run added it).
    if !plan.resuming {
        let added = identity_keys::add_encryption_key(&client, &identity, &master, &plan.secret)
            .await
            .context("adding the new encryption key")?;
        anyhow::ensure!(
            added == plan.new_id,
            "the new encryption key landed as #{added}, not #{}; run this again",
            plan.new_id
        );
        if !ctx.json {
            println!("✓ added ENCRYPTION key #{added}");
        }
    }

    // 2. Rotate every repository this identity maintains, signing with the key in use and
    //    holding both encryption keys: the old one opens the current epoch, the new one is the
    //    highest enabled key, so the new epoch is wrapped to it (self first).
    let signing = client.fetch_signer(&current).await?;
    let work = with_encryption_keys(&current, &master, &signing, &forge.core, ctx);
    let signer = PrivateSigner {
        client: &client,
        identity: &signing,
        bridge: &work,
    };
    let mut done = Done {
        plan: &plan,
        outcomes: Vec::new(),
        disabled: None,
        stored: None,
    };
    for repo in &plan.members.maintained {
        let outcome = rotate_one(&signer, repo, plan.new_id).await;
        if !ctx.json {
            print_outcome(repo, &outcome);
        }
        done.outcomes.push((repo, outcome));
    }

    // 3. The old key: disabled once every maintained repository moved.
    if !done.failed() && !keep_old && !plan.old_ids.is_empty() {
        let wif = &master
            .master_key()
            .context("no master key")?
            .private_key_wif;
        client
            .update_identity_keys(&plan.id, wif, &[], &plan.old_ids)
            .await
            .context("disabling the old encryption key")?;
        done.disabled = Some(plan.old_ids.clone());
    }

    // 4. The key this computer stores: its encryption keys now include the new one.
    done.stored = restore_login(ctx, storage, &current, &work)?;
    let spent = crate::common::spent_since(&client, &plan.id, before).await;
    ctx.emit(report_json(&done, &cost_json(spent, price)), || {
        print_done(&done, &cost_line(spent, price));
    });
    if done.failed() {
        return Err(
            UserError::new(codes::PARTIAL, "not every repository moved to the new key")
                .cause("the old encryption key stays enabled, so nothing is lost")
                .fix("run `dg auth keys rotate --encryption` again: it continues where it stopped")
                .into(),
        );
    }
    Ok(())
}

/// Which keys go and which comes, and the repositories it touches.
async fn plan(
    ctx: &Ctx,
    client: &forge_core::platform::PlatformClient,
    forge: &forge_core::network::ForgeIds,
    master: &BridgeIdentity,
    identity: &LoadedIdentity,
    keep_old: bool,
) -> Result<Plan> {
    let id = identity.id();
    let mut enabled: Vec<IdentityKeyInfo> = identity
        .public_keys()
        .into_iter()
        .filter(|k| k.is_usable_encryption_key(&forge.core))
        .collect();
    enabled.sort_by_key(|k| k.id);
    let Some(newest) = enabled.last().cloned() else {
        return Err(UserError::new(
            codes::NO_ENCRYPTION_KEY,
            "there is no encryption key to replace",
        )
        .cause(format!("identity {id} has no enabled ENCRYPTION key"))
        .fix("add one: `dg auth keys add --encryption`")
        .into());
    };
    if !identity_keys::recorded_keys_match(master, &identity.public_keys()) {
        return Err(words_needed());
    }
    // Two or more enabled: an earlier run added the newest and stopped before disabling the rest.
    let resuming = enabled.len() >= 2;
    let new_id = if resuming {
        newest.id
    } else {
        identity_keys::next_key_id(identity)
    };
    let secret = identity_keys::derive_encryption_secret(master, new_id, ctx.network())
        .ok_or_else(words_needed)?;
    if resuming && secret.public_key().as_slice() != newest.public_key.as_slice() {
        return Err(UserError::new(
            codes::KEY_CANNOT_SIGN,
            "the identity has more than one enabled encryption key",
        )
        .cause(format!(
            "key #{new_id} is not the one these recovery words derive, so it is not an earlier rotation's"
        ))
        .fix("disable the one you don't use (`dg auth keys disable <id> --force`), then run this again")
        .note("nothing was sent")
        .into());
    }
    let members = keyring::private_memberships(client, forge, &id).await?;
    Ok(Plan {
        old_ids: enabled
            .iter()
            .map(|k| k.id)
            .filter(|k| *k != new_id)
            .collect(),
        id,
        new_id,
        resuming,
        secret,
        members,
        keep_old,
    })
}

fn words_needed() -> anyhow::Error {
    UserError::new(
        codes::KEY_CANNOT_SIGN,
        "the new encryption key cannot be derived from what was given",
    )
    .cause("a new key must come from the identity's recovery words, so that they alone recover it")
    .fix("run it again and type the recovery words when asked, or pass --master <identity file> with the words")
    .note("nothing was sent")
    .into()
}

/// `current` (the key this computer signs with) holding every encryption key the master
/// source's words derive for the identity, old and new.
fn with_encryption_keys(
    current: &BridgeIdentity,
    master: &BridgeIdentity,
    identity: &LoadedIdentity,
    core: &str,
    ctx: &Ctx,
) -> BridgeIdentity {
    let on_chain = identity.public_keys();
    let mut keys = std::collections::BTreeMap::new();
    for source in [master, current] {
        for k in EncryptionKeys::held(source, &on_chain, core, ctx.network())
            .to_identity_keys(ctx.network())
        {
            keys.entry(k.id).or_insert(k);
        }
    }
    let mut work = current.clone();
    work.identity_keys.retain(|k| k.purpose != "ENCRYPTION");
    work.identity_keys.extend(keys.into_values());
    work
}

async fn rotate_one(signer: &PrivateSigner<'_>, repo: &RepoRef, new_id: u32) -> Outcome {
    let kr = match signer.keyring(repo).await {
        Ok(kr) => kr,
        Err(e) => return Outcome::Failed(e.to_string()),
    };
    if kr.reader_role() != Some(Role::Maintainer) {
        return Outcome::NotMaintainer;
    }
    if kr.own_current_wrap_keys().contains(&new_id) {
        return Outcome::AlreadyMoved;
    }
    match keyring::rotate(signer, repo, &[]).await {
        Ok(r) => Outcome::Rotated(r),
        Err(e) => Outcome::Failed(e.to_string()),
    }
}

/// Store the key in use again with the new encryption key beside it, when it lives in dg's own
/// store and already kept encryption keys there. A file of the user's own (an identity file
/// with its words) derives the new key by itself.
fn restore_login(
    ctx: &Ctx,
    storage: &StorageArgs,
    current: &BridgeIdentity,
    work: &BridgeIdentity,
) -> Result<Option<store::Stored>> {
    let Some(path) = ctx.identity_path.as_ref() else {
        return Ok(None);
    };
    let (_, kind) = store::describe_source(&path.to_string_lossy());
    let kept_encryption = current
        .identity_keys
        .iter()
        .any(|k| k.purpose == "ENCRYPTION");
    if !matches!(kind, "keychain" | "sealed-file" | "plaintext-file")
        || !kept_encryption
        || storage.signing_only
    {
        return Ok(None);
    }
    let stored = store::store(
        &ctx.network_label(),
        &current.identity_id,
        &work.to_json_with_secrets(),
        kind == "plaintext-file",
    )
    .context("storing the new encryption key beside the key in use")?;
    store::set_default(ctx, &current.identity_id, &stored.source())?;
    Ok(Some(stored))
}

fn names(repos: &[RepoRef]) -> String {
    repos
        .iter()
        .map(RepoRef::display)
        .collect::<Vec<_>>()
        .join(", ")
}

fn ids(ids: &[u32]) -> String {
    ids.iter()
        .map(|i| format!("#{i}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn print_plan(plan: &Plan, price: Option<f64>) {
    let (id, new_id, members) = (&plan.id, plan.new_id, &plan.members);
    let maintained = members.maintained.len();
    let estimate = if plan.resuming {
        0
    } else {
        identity_keys::ADD_KEY_ESTIMATE_CREDITS
    } + maintained as u64 * crate::keys::rotation_estimate(2).0;
    println!(
        "Replace the ENCRYPTION key {} of {id} with key #{new_id}, derived from the recovery words:",
        ids(&plan.old_ids)
    );
    let mut step = 0;
    let mut next = || {
        step += 1;
        step
    };
    if plan.resuming {
        println!(
            "  {}. key #{new_id} is already on the identity (an earlier run added it)",
            next()
        );
    } else {
        println!(
            "  {}. add key #{new_id} (one identity update, signed by the master key)",
            next()
        );
    }
    if maintained == 0 {
        println!(
            "  {}. no private repository you maintain needs rotating",
            next()
        );
    } else {
        println!(
            "  {}. rotate the key of the {maintained} private repo(s) you maintain, so new content is sealed for key #{new_id}: {}",
            next(),
            names(&members.maintained)
        );
    }
    if !members.member_only.is_empty() {
        println!(
            "  {}. {} repo(s) where you are not a maintainer keep using the old key until a maintainer rotates (their next visit does it): {}",
            next(),
            members.member_only.len(),
            names(&members.member_only)
        );
    }
    if plan.keep_old {
        println!(
            "  {}. keep {} enabled (--keep-old)",
            next(),
            ids(&plan.old_ids)
        );
    } else if !plan.old_ids.is_empty() {
        println!(
            "  {}. disable {}: whoever holds it can no longer read what is sealed from now on (past content stays readable to them)",
            next(),
            ids(&plan.old_ids)
        );
    }
    println!(
        "  about {} (two members a repo assumed)",
        cost_line(estimate, price)
    );
}

fn print_outcome(repo: &RepoRef, o: &Outcome) {
    match o {
        Outcome::Rotated(r) => crate::keys::print_rotation(repo, r),
        Outcome::AlreadyMoved => println!("{}: already on the new key", repo.display()),
        Outcome::NotMaintainer => println!(
            "{}: you are no longer a maintainer; a maintainer must rotate",
            repo.display()
        ),
        Outcome::Failed(e) => eprintln!("{}: not rotated: {e}", repo.display()),
    }
}

fn print_done(done: &Done<'_>, cost: &str) {
    let plan = done.plan;
    let new_id = plan.new_id;
    if let Some(d) = &done.disabled {
        println!(
            "✓ disabled {}; private repos now use key #{new_id} · {cost}",
            ids(d)
        );
    } else if done.failed() {
        println!(
            "  {} stays enabled until every repository moved · {cost}",
            ids(&plan.old_ids)
        );
    } else if plan.keep_old {
        println!(
            "  {} stays enabled (--keep-old) · {cost}",
            ids(&plan.old_ids)
        );
    }
    if let Some(s) = &done.stored {
        println!(
            "  this computer now keeps key #{new_id} too, in {}",
            s.describe()
        );
    }
    if !plan.members.member_only.is_empty() {
        println!(
            "  ask a maintainer of {} to rotate (`dg repo keys repair <repo>`); until then new content there is sealed for the old key",
            names(&plan.members.member_only)
        );
    }
    println!("  other browsers and computers: add the new key from the recovery phrase (web: Settings → Private repos)");
}

fn report_json(done: &Done<'_>, cost: &Value) -> Value {
    let plan = done.plan;
    let repos: Vec<Value> = done
        .outcomes
        .iter()
        .map(|(repo, o)| {
            let (status, detail) = match o {
                Outcome::Rotated(r) => ("rotated", crate::keys::rotation_json(r)),
                Outcome::AlreadyMoved => ("already_moved", Value::Null),
                Outcome::NotMaintainer => ("not_maintainer", Value::Null),
                Outcome::Failed(e) => ("failed", json!(e)),
            };
            json!({ "repo": repo.display(), "repoId": repo.id(), "status": status, "detail": detail })
        })
        .collect();
    json!({
        "status": if done.disabled.is_some() { "replaced" } else { "added" },
        "identityId": plan.id,
        "oldKeyIds": plan.old_ids,
        "newKeyId": plan.new_id,
        "added": !plan.resuming,
        "repos": repos,
        "askMaintainer": plan.members.member_only.iter().map(|r| json!({ "repo": r.display(), "repoId": r.id() })).collect::<Vec<_>>(),
        "disabledKeyIds": done.disabled,
        "storedAt": done.stored.as_ref().map(store::Stored::describe),
        "cost": cost,
    })
}
