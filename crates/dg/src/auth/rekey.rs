//! `dg auth keys rotate --encryption`: replace the identity's ENCRYPTION key
//! (`docs/security/private-repos.md` §5.2 "Rekey flow"), for a lost device or a leaked key.
//!
//! In order: add a new key at the next key id (derived from the recovery words, master-signed);
//! rotate every private repository this identity maintains so its new epoch is wrapped to the new
//! key (§5.5), and check that it was; name the repositories where it is only a member (a
//! maintainer's repair check moves them, §5.6); then disable every other enabled encryption key.
//!
//! Every run adds a fresh key and treats every enabled key as old: a lost device may have held
//! any of them, an earlier run's new key included. So a run that stopped half way is finished by
//! running it again, at the price of one more key add.

use std::path::Path;

use anyhow::{Context as _, Result};
use serde_json::{json, Value};

use forge_core::keyring::{self, EncryptionKeys, PrivateSigner};
use forge_core::keystore::BridgeIdentity;
use forge_core::platform::{identity_keys, LoadedIdentity};
use forge_core::scope::RepoRef;
use forge_core::user_error::{codes, UserError};

use super::{master_identity, store, StorageArgs};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line};

/// What happened to one maintained repository.
enum Outcome {
    /// Rotated, and its current epoch is wrapped to the new key.
    Rotated(keyring::Rotation),
    /// No longer a maintainer there: a maintainer must move it (like a member-only repository).
    NotMaintainer,
    /// Not moved to the new key (an error, or the current epoch still opens only with an old
    /// key): the old keys stay enabled.
    Failed(String),
}

/// The rekey as it will run, worked out before anything is signed.
struct Plan {
    id: String,
    old_ids: Vec<u32>,
    new_id: u32,
    secret: identity_keys::EncryptionSecret,
    members: keyring::PrivateMemberships,
    keep_old: bool,
}

/// What the run did, for the report.
struct Done<'a> {
    plan: &'a Plan,
    outcomes: Vec<(&'a RepoRef, Outcome)>,
    disabled: Option<Vec<u32>>,
    stored: Result<Option<store::Stored>, String>,
}

impl Done<'_> {
    fn failed(&self) -> bool {
        self.outcomes
            .iter()
            .any(|(_, o)| matches!(o, Outcome::Failed(_)))
    }

    /// The repositories a maintainer must move: member-only ones, and maintained ones where the
    /// identity turned out not to be a maintainer any more.
    fn ask_maintainer(&self) -> Vec<&RepoRef> {
        self.plan
            .members
            .member_only
            .iter()
            .chain(
                self.outcomes
                    .iter()
                    .filter(|(_, o)| matches!(o, Outcome::NotMaintainer))
                    .map(|(r, _)| *r),
            )
            .collect()
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

    // 1. The new key.
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

    // 2. Rotate every repository this identity maintains, signing with the key in use and
    //    holding every encryption key: an old one opens the current epoch, the new one is the
    //    highest enabled key, so the new epoch is wrapped to it (self first).
    let signing = client.fetch_signer(&current).await?;
    let work = holding_every_encryption_key(&current, &master, &signing, &forge.core, ctx);
    let signer = PrivateSigner {
        client: &client,
        identity: &signing,
        bridge: &work,
    };
    let mut done = Done {
        plan: &plan,
        outcomes: Vec::new(),
        disabled: None,
        stored: Ok(None),
    };
    for repo in &plan.members.maintained {
        let outcome = rotate_one(&signer, repo, plan.new_id).await;
        if !ctx.json {
            print_outcome(repo, &outcome);
        }
        done.outcomes.push((repo, outcome));
    }

    // 3. The old keys: disabled once every maintained repository is on the new key.
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

    // 4. The key this computer stores: its encryption keys now include the new one. Everything
    //    above is on chain already, so a failure here is reported, not raised.
    done.stored = restore_login(ctx, storage, &current, &work).map_err(|e| format!("{e:#}"));
    let spent = crate::common::spent_since(&client, &plan.id, before).await;
    ctx.emit(report_json(&done, &cost_json(spent, price)), || {
        print_done(&done, &cost_line(spent, price));
    });
    if done.failed() {
        return Err(
            UserError::new(codes::PARTIAL, "not every repository moved to the new key")
                .cause("the old encryption keys stay enabled, so nothing is lost")
                .fix("run `dg auth keys rotate --encryption` again: it adds a fresh key and moves every repository to it")
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
    let mut old_ids: Vec<u32> = identity
        .public_keys()
        .into_iter()
        .filter(|k| k.is_usable_encryption_key(&forge.core))
        .map(|k| k.id)
        .collect();
    old_ids.sort_unstable();
    if old_ids.is_empty() {
        return Err(UserError::new(
            codes::NO_ENCRYPTION_KEY,
            "there is no encryption key to replace",
        )
        .cause(format!("identity {id} has no enabled ENCRYPTION key"))
        .fix("add one: `dg auth keys add --encryption`")
        .into());
    }
    if !identity_keys::recorded_keys_match(master, &identity.public_keys()) {
        return Err(words_needed());
    }
    let new_id = identity_keys::next_key_id(identity);
    let secret = identity_keys::derive_encryption_secret(master, new_id, ctx.network())
        .ok_or_else(words_needed)?;
    let members = keyring::private_memberships(client, forge, &id).await?;
    Ok(Plan {
        id,
        old_ids,
        new_id,
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
    .cause("a new key must come from the identity's recovery words, so that they alone recover it; the master key source given does not hold words that reproduce the identity's keys")
    .fix("pass --master <identity file> with the recovery words in it")
    .fix("or sign in with a limited key (`dg auth login`), then run it again and type the words when asked")
    .note("nothing was sent")
    .into()
}

/// `current` (the key this computer signs with) holding, in memory, every encryption key the
/// master source's words derive for the identity, old and new. What is stored afterwards is
/// decided by [`restore_login`].
fn holding_every_encryption_key(
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

/// Rotate `repo`, then check, from a fresh read, that this identity's wrap for the current epoch
/// went to `new_id`: a resumed epoch can keep an earlier self-wrap to an old key, and another
/// maintainer's concurrent anchor may have been wrapped before the new key existed.
async fn rotate_one(signer: &PrivateSigner<'_>, repo: &RepoRef, new_id: u32) -> Outcome {
    match keyring::rotate(signer, repo, &[]).await {
        Ok(r) => match signer.keyring(repo).await {
            Ok(kr) if kr.own_current_wrap_keys().contains(&new_id) => Outcome::Rotated(r),
            Ok(kr) => Outcome::Failed(format!(
                "its current key epoch {} is still wrapped to your old key, not #{new_id}",
                kr.resolution().current_epoch.unwrap_or_default()
            )),
            Err(e) => Outcome::Failed(format!("rotated, but reading it back failed: {e}")),
        },
        Err(forge_core::Error::NotPermitted { .. }) => Outcome::NotMaintainer,
        Err(e) => Outcome::Failed(e.to_string()),
    }
}

/// Store the key in use again with the new encryption key beside it, in the same place, when it
/// is dg's own stored limited key (`dg auth login`) and kept encryption keys there. A full
/// identity is never re-stored (its words derive the new key by themselves), nor a key file of
/// the user's own, nor a plaintext one (encryption keys are never written in the clear).
fn restore_login(
    ctx: &Ctx,
    storage: &StorageArgs,
    current: &BridgeIdentity,
    work: &BridgeIdentity,
) -> Result<Option<store::Stored>> {
    let Some(path) = ctx.identity_path.as_ref() else {
        return Ok(None);
    };
    let source = path.to_string_lossy();
    let kept_encryption = current
        .identity_keys
        .iter()
        .any(|k| k.purpose == "ENCRYPTION");
    if storage.signing_only
        || storage.insecure_plaintext
        || !kept_encryption
        || current.master_key().is_some()
    {
        return Ok(None);
    }
    let network = ctx.network_label();
    let Some(mut writer) = store::main_slot_storer(&network, &current.identity_id, &source)? else {
        return Ok(None);
    };
    let stored = writer
        .store(
            &network,
            &current.identity_id,
            &work.to_json_with_secrets(),
            store::Slot::Main,
        )
        .context("storing the new encryption key beside the key in use")?;
    Ok(Some(stored))
}

fn names(repos: &[&RepoRef]) -> String {
    repos
        .iter()
        .map(|r| r.display())
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
    let maintained: Vec<&RepoRef> = members.maintained.iter().collect();
    let member_only: Vec<&RepoRef> = members.member_only.iter().collect();
    let estimate = identity_keys::ADD_KEY_ESTIMATE_CREDITS
        + maintained.len() as u64 * crate::keys::rotation_estimate(2).0;
    println!(
        "Replace the ENCRYPTION key {} of {id} with a new key #{new_id}, derived from the recovery words:",
        ids(&plan.old_ids)
    );
    println!("  1. add key #{new_id} (one identity update, signed by the master key)");
    if maintained.is_empty() {
        println!("  2. no private repository you maintain needs rotating");
    } else {
        println!(
            "  2. rotate the key of the {} private repo(s) you maintain, so new content is sealed for key #{new_id}: {}",
            maintained.len(),
            names(&maintained)
        );
    }
    if !member_only.is_empty() {
        println!(
            "     {} repo(s) where you are not a maintainer keep using the old key until a maintainer moves them (their next visit does it): {}",
            member_only.len(),
            names(&member_only)
        );
    }
    if plan.keep_old {
        println!("  3. keep {} enabled (--keep-old)", ids(&plan.old_ids));
    } else {
        println!(
            "  3. disable {}: whoever holds it can no longer read what is sealed from now on (past content stays readable to them)",
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
        Outcome::NotMaintainer => println!(
            "{}: you are no longer a maintainer; a maintainer must move it",
            repo.display()
        ),
        Outcome::Failed(e) => eprintln!("{}: not moved to the new key: {e}", repo.display()),
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
            "  {} stay enabled until every repository moved · {cost}",
            ids(&plan.old_ids)
        );
    } else {
        println!(
            "  {} stay enabled (--keep-old) · {cost}",
            ids(&plan.old_ids)
        );
    }
    match &done.stored {
        Ok(Some(s)) => println!(
            "  this computer now keeps key #{new_id} too, in {}",
            s.describe()
        ),
        Ok(None) => {}
        Err(e) => eprintln!(
            "warning: key #{new_id} could not be stored on this computer ({e}); sign in again with `dg auth login` to keep it"
        ),
    }
    let ask = done.ask_maintainer();
    if !ask.is_empty() {
        println!(
            "  ask a maintainer of {} to move it to your new key (`dg repo keys repair <repo>`); until then new content there is sealed for the old key",
            names(&ask)
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
        "repos": repos,
        "askMaintainer": done.ask_maintainer().iter().map(|r| json!({ "repo": r.display(), "repoId": r.id() })).collect::<Vec<_>>(),
        "disabledKeyIds": done.disabled,
        "storedAt": done.stored.as_ref().ok().and_then(Option::as_ref).map(store::Stored::describe),
        "storeError": done.stored.as_ref().err(),
        "cost": cost,
    })
}
