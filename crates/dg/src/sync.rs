//! Settings that follow the identity, dg's side (`docs/design/identity-synced-state.md` §7):
//! storage profiles synced through forge-user, merged in memory with `storage.toml` (which
//! wins on a name and is never rewritten), and repository storage lent to maintainers.
//!
//! On only where forge-user is registered and this computer holds the identity's forge-user
//! key `E` (`dg auth login --wallet`); everywhere else dg behaves exactly as before.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Default, Serialize, Deserialize)]
struct LocalState {
    #[serde(default)]
    device: String,
    /// `<network>/<identity>` → ms of the checked first upload.
    #[serde(default)]
    synced: BTreeMap<String, u64>,
}

fn local_state_path() -> Result<PathBuf> {
    Ok(crate::config::config_dir()?.join("user-sync.toml"))
}

impl LocalState {
    fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| toml::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn save(&self, path: &Path) -> Result<()> {
        let raw = toml::to_string_pretty(self).context("serializing user-sync.toml")?;
        forge_core::keystore::write_private_file(path, raw.as_bytes())
            .with_context(|| format!("writing {}", path.display()))
    }

    /// This computer's short id, made on first use (`<name>-<device>` keeps a clashing profile).
    fn device(path: &Path) -> String {
        let mut s = Self::load(path);
        if s.device.len() == 6 && s.device.bytes().all(|b| b.is_ascii_hexdigit()) {
            return s.device;
        }
        let mut b = [0u8; 3];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut b);
        s.device = hex::encode(b);
        let _ = s.save(path);
        s.device
    }
}

fn account(key: &SyncKey) -> String {
    format!("{}/{}", key.network, key.identity_id)
}

/// When this computer's first upload for `key`'s identity was checked, if it was.
pub fn synced_at(key: &SyncKey) -> Option<u64> {
    let path = local_state_path().ok()?;
    LocalState::load(&path).synced.get(&account(key)).copied()
}

fn record_synced(key: &SyncKey, at: u64) -> Result<()> {
    let path = local_state_path()?;
    let _lock = crate::auth::wallet::lock_state(&path)?;
    let mut s = LocalState::load(&path);
    s.synced.insert(account(key), at);
    s.save(&path)
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
    let Ok(path) = local_state_path() else { return };
    let device = LocalState::device(&path);
    let policy = global_default_policy();
    let run = writer
        .with_store(contract, async |store| {
            Ok(user_sync::first_sync(store, key, &local, policy.as_ref(), &device).await?)
        })
        .await;
    match run {
        Ok(done) => {
            if done.recorded {
                let _ = record_synced(key, user_sync::now_ms());
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
                eprintln!("note: the change was saved here but not synced to your identity ({e:#}); it syncs on the next `dg storage` change");
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
    let value = match profile.map(user_sync::storage::profile_to_synced) {
        None => None,
        Some(Ok(v)) => Some(v),
        Some(Err(e)) => {
            if !ctx.json && !matches!(state(ctx), SyncState::Unavailable | SyncState::Off) {
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

/// As the owner of the session's repository, after its members changed: lend its shared
/// storage to the current maintainers that have a forge-user key and revoke anyone else
/// (`identity-synced-state.md` §5). The share holds what the owner's synced policy for this
/// repository names when there is one; with no share yet, what the synced default names; else
/// what it holds now. `None` when sync is off, the signer is not the owner, or it failed
/// (a note says so).
pub async fn after_membership_change(
    ctx: &Ctx,
    s: &crate::common::Session,
) -> Option<user_sync::Reconciled> {
    let SyncState::On { key, contract } = state(ctx) else {
        return None;
    };
    let me = s.identity.id();
    if s.repo.owner_id() != me || key.identity_id != me {
        return None;
    }
    let run = async {
        let maintainers = user_sync::repo::current_maintainers(&s.client, &s.repo).await?;
        Writer::new(&s.client, &s.bridge, &s.identity)
            .with_store(&contract, async |store| {
                let sync = UserSync::new(&key, store);
                let own = sync.read_slot(SLOT_STORAGE).await?.map(|r| r.doc);
                let local = StorageProfiles::load().unwrap_or_default();
                let first = store.share(&me, s.repo.id()).await?.is_none();
                let content = own.as_ref().and_then(|doc| {
                    let own_repo = doc
                        .get(&user_sync::storage::repo_key(s.repo.id()))
                        .and_then(user_sync::storage::policy_from_synced);
                    let policy = match own_repo {
                        Some(p) => p,
                        None if first => user_sync::synced_policy(doc, None)?,
                        None => return None,
                    };
                    user_sync::ShareContent::for_policy(
                        &policy,
                        &user_sync::effective(&local, Some(doc)).profiles,
                    )
                });
                let wanted = content
                    .as_ref()
                    .map_or(user_sync::Wanted::Keep, user_sync::Wanted::Content);
                Ok(sync
                    .reconcile_repo(s.repo.id(), wanted, &maintainers)
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
