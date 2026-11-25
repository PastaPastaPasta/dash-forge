//! Settings that follow the identity, dg's side (`docs/design/identity-synced-state.md` §7):
//! storage profiles synced through forge-user, merged in memory with `storage.toml` (which
//! wins on a name and is never rewritten), and repository storage lent to maintainers.
//!
//! On only where forge-user is registered and this computer holds the identity's forge-user
//! key `E` (`dg auth login --wallet`); everywhere else dg behaves exactly as before.

use anyhow::Result;

use forge_core::platform::{LoadedIdentity, PlatformClient, WriteEngine};
use forge_core::storage::policy::{run_git_config, GitConfigRun};
use forge_core::storage::{StoragePolicy, StorageProfiles};
use forge_core::user_sync::{
    self, key::LocalKey, platform::PlatformUserStore, Effective, SlotDoc, SyncKey, UserStore,
    UserSync, SLOT_STORAGE,
};

use crate::context::Ctx;

/// The one line shown when sync is off on a network that has it.
pub const OFF_HINT: &str =
    "storage on this computer only: sign in with your wallet again (`dg auth login --wallet`) to sync storage across devices";

/// The guide a maintainer removal points to.
pub const ROTATE_GUIDE: &str = "docs/guides/rotate-storage-credentials.md";

/// Whether sync applies to this run.
#[derive(Debug)]
pub enum SyncState {
    /// The network has no forge-user contract: nothing changes.
    Unavailable,
    /// No identity, or one this computer holds no forge-user key for.
    Off,
    /// The key is in a sealed file and its passphrase is not in the environment.
    Locked,
    /// On.
    On {
        /// `E`.
        key: SyncKey,
        /// forge-user's contract id.
        contract: String,
    },
}

impl SyncState {
    /// What it is, for `--json`.
    pub fn label(&self) -> &'static str {
        match self {
            SyncState::Unavailable => "unavailable",
            SyncState::Off => "off",
            SyncState::Locked => "locked",
            SyncState::On { .. } => "on",
        }
    }
}

/// The sync state of the context's identity, read without prompting.
pub fn state(ctx: &Ctx) -> SyncState {
    let Some(contract) = ctx.target.v2.as_ref().and_then(|f| f.user.clone()) else {
        return SyncState::Unavailable;
    };
    let Some(identity) = ctx.identity_id_hint() else {
        return SyncState::Off;
    };
    match user_sync::key::load(&ctx.network_label(), &identity) {
        LocalKey::Held(key) => SyncState::On { key, contract },
        LocalKey::Absent => SyncState::Off,
        LocalKey::Locked => SyncState::Locked,
    }
}

// ---------------------------------------------------------------------------------------
// user-sync.toml: this computer's device id and when each identity's first sync was checked
// ---------------------------------------------------------------------------------------

/// When this computer's first upload for `key`'s identity was checked, if it was.
pub fn synced_at(key: &SyncKey) -> Option<u64> {
    user_sync::local::synced_at(&key.network, &key.identity_id)
}

// ---------------------------------------------------------------------------------------
// The storage slot
// ---------------------------------------------------------------------------------------

/// The user's global default policy (`git config --global dash.storage`), when set.
pub fn global_default_policy() -> Option<StoragePolicy> {
    let get = |key: &str| match run_git_config(&["config", "--global", "--get", key]) {
        GitConfigRun::Found(v) => Some(v.trim().to_string()).filter(|v| !v.is_empty()),
        _ => None,
    };
    StoragePolicy::from_git_values(
        Some(&get("dash.storage")?),
        get("dash.replicas").as_deref(),
        get("dash.platformFallback").as_deref(),
    )
    .ok()
    .filter(|p| !p.is_platform_only())
}

/// A writer for an identity a command already holds.
pub struct Writer<'c> {
    client: &'c PlatformClient,
    bridge: &'c forge_core::keystore::BridgeIdentity,
    identity: &'c LoadedIdentity,
}

impl<'c> Writer<'c> {
    /// Over a client and identity a command already holds.
    pub fn new(
        client: &'c PlatformClient,
        bridge: &'c forge_core::keystore::BridgeIdentity,
        identity: &'c LoadedIdentity,
    ) -> Self {
        Self {
            client,
            bridge,
            identity,
        }
    }

    /// Run `f` with a forge-user store that writes as this identity.
    pub async fn with_store<T>(
        &self,
        contract: &str,
        f: impl AsyncFnOnce(&dyn UserStore) -> Result<T>,
    ) -> Result<T> {
        let engine = WriteEngine::new(self.client, self.identity, self.bridge.doc_op_key()?)?;
        let store = PlatformUserStore::open(self.client, contract, Some(&engine)).await?;
        f(&store).await
    }
}

/// [`first_sync`] for the context's identity when it has not passed on this computer yet;
/// prints one line when it uploaded something. Failures are a note, never an error.
pub async fn ensure_first_sync(ctx: &Ctx, writer: &Writer<'_>, key: &SyncKey, contract: &str) {
    if synced_at(key).is_some() {
        return;
    }
    let Ok(local) = StorageProfiles::load() else {
        return;
    };
    let device = user_sync::local::device();
    let policy = global_default_policy();
    let run = writer
        .with_store(contract, async |store| {
            Ok(user_sync::first_sync(store, key, &local, policy.as_ref(), &device).await?)
        })
        .await;
    match run {
        Ok(done) => {
            if done.recorded {
                let _ = user_sync::local::record_synced(
                    &key.network,
                    &key.identity_id,
                    user_sync::now_ms(),
                );
            }
            if ctx.json {
                return;
            }
            if !done.uploaded.is_empty() {
                let names: Vec<String> = done
                    .uploaded
                    .iter()
                    .map(|(l, s)| {
                        if l == s {
                            l.clone()
                        } else {
                            format!("{l} (as {s})")
                        }
                    })
                    .collect();
                eprintln!(
                    "storage profiles now synced with your identity: {}",
                    names.join(", ")
                );
            }
            for (name, why) in &done.skipped {
                eprintln!("note: storage profile {name} stays on this computer only ({why})");
            }
        }
        Err(e) => {
            if !ctx.json {
                eprintln!("note: your storage profiles were not synced yet ({e:#}); dg tries again next time");
            }
        }
    }
}

/// Run the first sync if it has not passed here yet, else record one `dg storage` change: entry
/// `entry` set to `value`, or tombstoned (`None`, only when the synced copy holds it). A no-op
/// when sync is off; a failure is a note: the local change stands.
async fn record_change(ctx: &Ctx, entry: String, value: Option<serde_json::Value>) -> bool {
    let SyncState::On { key, contract } = state(ctx) else {
        return false;
    };
    let run = async {
        let (client, bridge, identity) = ctx.connect_with_identity().await?;
        let writer = Writer::new(&client, &bridge, &identity);
        ensure_first_sync(ctx, &writer, &key, &contract).await;
        writer
            .with_store(&contract, async |store| {
                let sync = UserSync::new(&key, store);
                let current = sync.read_slot(SLOT_STORAGE).await?;
                let held = current.as_ref().and_then(|r| r.doc.get(&entry));
                if held == value.as_ref() {
                    return Ok(true);
                }
                let mut changes = SlotDoc::new(SLOT_STORAGE);
                match &value {
                    Some(v) => changes.set(&entry, user_sync::now_ms(), v.clone()),
                    None => changes.remove(&entry, user_sync::now_ms()),
                };
                let back = sync.merge_into(SLOT_STORAGE, &changes).await?;
                Ok(back.get(&entry) == value.as_ref())
            })
            .await
    };
    match run.await {
        Ok(true) => true,
        Ok(false) => {
            if !ctx.json {
                eprintln!(
                    "note: another device changed {entry} later; its change is the one that syncs"
                );
            }
            false
        }
        Err(e) => {
            if !ctx.json {
                eprintln!("note: the change was saved here but not synced to your identity ({e:#}); run the same `dg storage` command again to sync it");
            }
            false
        }
    }
}

/// Record that profile `name` was added or edited (`Some`) or removed (`None`). Whether the
/// synced copy now says so.
pub async fn after_profile_change(
    ctx: &Ctx,
    name: &str,
    profile: Option<&forge_core::storage::Profile>,
) -> bool {
    // Secrets are resolved (a keychain read) only when sync is on for this network and session.
    if !matches!(state(ctx), SyncState::On { .. }) {
        return false;
    }
    let value = match profile.map(user_sync::storage::profile_to_synced) {
        None => None,
        Some(Ok(v)) => Some(v),
        Some(Err(e)) => {
            if !ctx.json {
                eprintln!("note: {name} stays on this computer only ({e})");
            }
            return false;
        }
    };
    record_change(ctx, user_sync::storage::profile_key(name), value).await
}

/// Record a new global default policy.
pub async fn after_default_policy(ctx: &Ctx, policy: &StoragePolicy) {
    let _ = record_change(
        ctx,
        user_sync::storage::DEFAULT_KEY.to_string(),
        Some(user_sync::storage::policy_to_synced(policy)),
    )
    .await;
}

/// `local` plus the synced profiles (when sync is on and readable). Never fails on account of
/// sync: a read that fails leaves `local` as it is.
pub async fn merged(ctx: &Ctx, local: &StorageProfiles) -> Effective {
    let SyncState::On { key, contract } = state(ctx) else {
        return user_sync::effective(local, None);
    };
    let doc = async {
        let client = ctx.connect().await?;
        let store = PlatformUserStore::open(&client, &contract, None).await?;
        let read = UserSync::new(&key, &store).read_slot(SLOT_STORAGE).await?;
        anyhow::Ok(read.map(|r| r.doc))
    }
    .await
    .ok()
    .flatten();
    user_sync::effective(local, doc.as_ref())
}

// ---------------------------------------------------------------------------------------
// Maintainers
// ---------------------------------------------------------------------------------------

/// The line a removal prints when the member could read the shared storage.
pub fn rotate_line(member: &str) -> String {
    format!(
        "{member} could read this repository's shared storage credentials; they can't read new ones, but rotate what they saw: {ROTATE_GUIDE}"
    )
}

/// The one line an owner sees when a reconcile stopped a share (about the default storage when the
/// repository never had storage of its own): once, as the share is already empty after.
pub fn print_stopped_default(ctx: &Ctx, repo: &str, done: &user_sync::Reconciled) {
    if let Some(line) = user_sync::stopped_line(repo, done).filter(|_| !ctx.json) {
        println!("{line}");
    }
}

/// As the owner of the session's repository, after its members changed: lend its shared
/// storage to the current maintainers that have a forge-user key and revoke anyone else
/// (`identity-synced-state.md` §5), the share holding what [`user_sync::ShareRule`] says.
/// `removed`: a member this command just removed. `None` when sync is off, the signer is not the
/// owner, or it failed (a note says so).
pub async fn after_membership_change(
    ctx: &Ctx,
    s: &crate::common::Session,
    removed: Option<&str>,
) -> Option<user_sync::Reconciled> {
    let contract = ctx.target.v2.as_ref()?.user.clone()?;
    // The session's own identity, opened already: a sealed `--identity` file names none ahead.
    let me = s.identity.id();
    if s.repo.owner_id() != me {
        return None;
    }
    let LocalKey::Held(key) = user_sync::key::load(&ctx.network_label(), &me) else {
        return None;
    };
    let run = async {
        let mut maintainers = user_sync::repo::current_maintainers(&s.client, &s.repo).await?;
        // A read a block behind may still list the member just removed.
        if let Some(gone) = removed {
            maintainers.remove(gone);
        }
        Writer::new(&s.client, &s.bridge, &s.identity)
            .with_store(&contract, async |store| {
                Ok(UserSync::new(&key, store)
                    .reconcile_repo_by_rule(s.repo.id(), &maintainers)
                    .await?)
            })
            .await
    };
    match run.await {
        Ok(done) => Some(done),
        Err(e) => {
            if !ctx.json {
                eprintln!("note: this repository's shared storage was not updated ({e:#}); your next push updates it");
            }
            None
        }
    }
}
