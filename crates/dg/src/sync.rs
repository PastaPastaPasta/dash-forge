//! Settings that follow the identity, dg's side (`docs/design/identity-synced-state.md` §7):
//! storage profiles synced through forge-user, merged in memory with `storage.toml` (which
//! wins on a name and is never rewritten), and repository storage lent to maintainers.
//!
//! On only where forge-user is registered and this computer holds the identity's forge-user
//! key `E` (`dg auth login --wallet`); everywhere else dg behaves exactly as before.

use std::collections::{BTreeMap, BTreeSet};
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

/// The decrypted storage slot (`None` when the identity has none).
pub async fn read_storage(store: &dyn UserStore, key: &SyncKey) -> Result<Option<SlotDoc>> {
    Ok(UserSync::new(key, store)
        .read_slot(SLOT_STORAGE)
        .await
        .context("reading your synced storage settings")?
        .map(|r| r.doc))
}

/// A connected writer for the context's identity.
pub struct Writer<'c> {
    client: Client<'c>,
    identity: LoadedIdentity,
    bridge: forge_core::keystore::BridgeIdentity,
}

enum Client<'c> {
    Owned(Box<PlatformClient>),
    Borrowed(&'c PlatformClient),
}

impl Writer<'static> {
    /// Connect as the context's identity.
    pub async fn connect(ctx: &Ctx) -> Result<Self> {
        let (client, bridge, identity) = ctx.connect_with_identity().await?;
        Ok(Self {
            client: Client::Owned(Box::new(client)),
            identity,
            bridge,
        })
    }
}

impl<'c> Writer<'c> {
    /// Over a client and identity a command already holds.
    pub fn from_parts(
        client: &'c PlatformClient,
        bridge: forge_core::keystore::BridgeIdentity,
        identity: LoadedIdentity,
    ) -> Self {
        Self {
            client: Client::Borrowed(client),
            identity,
            bridge,
        }
    }

    /// The client.
    pub fn client(&self) -> &PlatformClient {
        match &self.client {
            Client::Owned(c) => c,
            Client::Borrowed(c) => c,
        }
    }

    /// Run `f` with a forge-user store that writes as this identity.
    pub async fn with_store<T>(
        &self,
        contract: &str,
        f: impl AsyncFnOnce(&dyn UserStore) -> Result<T>,
    ) -> Result<T> {
        let client = self.client();
        let engine = WriteEngine::new(client, &self.identity, self.bridge.doc_op_key()?)?;
        let store = PlatformUserStore::open(client, contract, Some(&engine)).await?;
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

/// Record a `dg storage` change to profile `name` (`Some`: added or edited, `None`: removed)
/// in the synced copy. A no-op when sync is off; a failure is a note.
pub async fn after_profile_change(
    ctx: &Ctx,
    name: &str,
    profile: Option<&forge_core::storage::Profile>,
) {
    let SyncState::On { key, contract } = state(ctx) else {
        return;
    };
    let mut changes = SlotDoc::new(SLOT_STORAGE);
    let at = user_sync::now_ms();
    let entry = user_sync::storage::profile_key(name);
    match profile {
        Some(p) => match user_sync::storage::profile_to_synced(p) {
            Ok(v) => {
                changes.set(&entry, at, v);
            }
            Err(e) => {
                if !ctx.json {
                    eprintln!("note: {name} stays on this computer only ({e})");
                }
                return;
            }
        },
        None => {
            changes.remove(&entry, at);
        }
    }
    let run = async {
        let writer = Writer::connect(ctx).await?;
        writer
            .with_store(&contract, async |store| {
                let sync = UserSync::new(&key, store);
                if profile.is_none()
                    && sync
                        .read_slot(SLOT_STORAGE)
                        .await?
                        .is_none_or(|r| r.doc.get(&entry).is_none())
                {
                    return Ok(());
                }
                sync.merge_into(SLOT_STORAGE, &changes).await.map(|_| ())?;
                Ok(())
            })
            .await
    };
    if let Err(e) = run.await {
        if !ctx.json {
            eprintln!("note: the change was saved here but not synced to your identity ({e:#}); it syncs on the next `dg storage` change");
        }
    }
}

/// The profiles to use: `storage.toml` plus the synced ones (when sync is on and readable).
/// Never fails on account of sync: a read that fails leaves `storage.toml` alone.
pub async fn effective(ctx: &Ctx, client: Option<&PlatformClient>) -> (Effective, Option<SlotDoc>) {
    let local = StorageProfiles::load().unwrap_or_default();
    let SyncState::On { key, contract } = state(ctx) else {
        return (user_sync::effective(&local, None), None);
    };
    let owned;
    let client = match client {
        Some(c) => c,
        None => match ctx.connect().await {
            Ok(c) => {
                owned = c;
                &owned
            }
            Err(_) => return (user_sync::effective(&local, None), None),
        },
    };
    let doc = match PlatformUserStore::open(client, &contract, None).await {
        Ok(store) => read_storage(&store, &key).await.ok().flatten(),
        Err(_) => None,
    };
    (user_sync::effective(&local, doc.as_ref()), doc)
}

// ---------------------------------------------------------------------------------------
// Maintainers
// ---------------------------------------------------------------------------------------

/// The line a removal prints.
pub fn rotate_line(member: &str) -> String {
    format!(
        "{member} could read this repository's shared storage credentials; they can't read new ones, but rotate what they saw: {ROTATE_GUIDE}"
    )
}

/// As the owner of `repo_id`: lend the storage its policy names (`wanted`, or what the share
/// already holds) to `maintainers`, revoking anyone else. A no-op without sync.
pub async fn reconcile_repo(
    writer: &Writer<'_>,
    key: &SyncKey,
    contract: &str,
    repo_id: &str,
    wanted: Option<&user_sync::ShareContent>,
    maintainers: &BTreeSet<String>,
) -> Result<user_sync::Reconciled> {
    writer
        .with_store(contract, async |store| {
            Ok(UserSync::new(key, store)
                .reconcile_repo(repo_id, wanted, maintainers)
                .await?)
        })
        .await
}
