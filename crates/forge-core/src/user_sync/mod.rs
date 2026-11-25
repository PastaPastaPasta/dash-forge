//! Settings that follow the identity (`docs/design/identity-synced-state.md`): the `forge-user`
//! contract's encrypted `state` slots, and the `share` + `grant` documents through which a
//! repository's owner lends its storage to its maintainers.
//!
//! Additive only: `storage.toml`, git config and the keychain entries a user has are read, never
//! rewritten. Synced profiles live in memory ([`crate::storage::SecretRef::Value`]); a profile in
//! `storage.toml` wins on its name.

pub mod crypto;
pub mod doc;
pub mod key;
pub mod platform;
pub mod repo;
pub mod storage;
pub mod store;

#[cfg(test)]
mod migration_tests;

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::error::{Error, Result};
use crate::storage::policy::StoragePolicy;
use crate::storage::profiles::{valid_profile_name, Profile, StorageProfiles};

pub use doc::{Entry, SlotDoc};
pub use key::{LocalKey, SyncKey};
#[cfg(test)]
pub use store::MemoryStore;
pub use store::{EncKeyInfo, GrantDoc, ShareDoc, StateDoc, UserStore};

/// The `state` document type.
pub const DOC_STATE: &str = "state";
/// The `share` document type.
pub const DOC_SHARE: &str = "share";
/// The `grant` document type.
pub const DOC_GRANT: &str = "grant";
/// The storage slot.
pub const SLOT_STORAGE: &str = "storage";
/// The share plaintext's format.
pub const SHARE_FORMAT: &str = "forge-user/share";

/// The time now, in ms.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// One identity's sync, with its key `E` and a [`UserStore`].
pub struct UserSync<'a> {
    key: &'a SyncKey,
    store: &'a dyn UserStore,
}

/// A slot as read: its plaintext and the document it came from.
#[derive(Debug, Clone)]
pub struct ReadSlot {
    /// The plaintext.
    pub doc: SlotDoc,
    /// The stored document.
    pub stored: StateDoc,
}

impl<'a> UserSync<'a> {
    /// `key`'s sync through `store`.
    pub fn new(key: &'a SyncKey, store: &'a dyn UserStore) -> Self {
        Self { key, store }
    }

    /// The slot, decrypted; `None` when the identity has none.
    pub async fn read_slot(&self, slot: &str) -> Result<Option<ReadSlot>> {
        let Some(stored) = self.store.state(&self.key.identity_id, slot).await? else {
            return Ok(None);
        };
        if stored.owner_id != self.key.identity_id || stored.slot != slot {
            return Err(Error::Integrity);
        }
        let plain = crypto::open_state(
            self.key.secret(),
            &self.key.network,
            self.key.identity(),
            slot,
            stored.v,
            stored.key_id,
            &stored.nonce,
            &stored.pieces,
        )?;
        Ok(Some(ReadSlot {
            doc: SlotDoc::parse(slot, &plain)?,
            stored,
        }))
    }

    async fn write_slot(&self, slot: &str, doc: &SlotDoc, over: Option<&StateDoc>) -> Result<()> {
        let nonce = crypto::fresh_nonce()?;
        let pieces = crypto::seal_state(
            self.key.secret(),
            &self.key.network,
            self.key.identity(),
            slot,
            self.key.key_id,
            &nonce,
            &doc.to_json()?,
        )?;
        self.store
            .put_state(&StateDoc {
                id: over.and_then(|s| s.id.clone()),
                owner_id: self.key.identity_id.clone(),
                revision: over.and_then(|s| s.revision),
                slot: slot.to_string(),
                v: crypto::STATE_V,
                key_id: self.key.key_id,
                nonce,
                pieces,
            })
            .await
    }

    /// The slot as read back after writing `written`, once it holds every entry of it (a node may
    /// be a block behind: read again a few times).
    async fn read_back(&self, slot: &str, written: &SlotDoc) -> Result<SlotDoc> {
        let mut missing = String::new();
        for attempt in 0..4u64 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(1500 * attempt)).await;
            }
            let Some(back) = self.read_slot(slot).await? else {
                missing = "the slot".into();
                continue;
            };
            match written
                .entries
                .iter()
                .find(|(k, e)| back.doc.entries.get(*k).is_none_or(|b| b.at < e.at))
            {
                Some((k, _)) => missing.clone_from(k),
                None => return Ok(back.doc),
            }
        }
        Err(Error::Platform(format!(
            "the synced settings read back without {missing}"
        )))
    }

    /// Merge `changes` into the stored slot and write the result when it differs, then read it
    /// back and check every entry of `changes` that won is there as written. Returns the merged
    /// document. A write that lost a race is merged and written once more.
    pub async fn merge_into(&self, slot: &str, changes: &SlotDoc) -> Result<SlotDoc> {
        let mut last = None;
        for _ in 0..2 {
            let current = self.read_slot(slot).await?;
            let mut merged = current
                .as_ref()
                .map_or_else(|| SlotDoc::new(slot), |r| r.doc.clone());
            let before = merged.to_json()?;
            merged.merge(changes);
            if merged.to_json()? == before && current.is_some() {
                return Ok(merged);
            }
            if let Err(e) = self
                .write_slot(slot, &merged, current.as_ref().map(|r| &r.stored))
                .await
            {
                last = Some(e);
                continue;
            }
            return self.read_back(slot, &merged).await;
        }
        Err(last.unwrap_or(Error::Nonce))
    }
}

// ---------------------------------------------------------------------------------------
// Storage: the merged view
// ---------------------------------------------------------------------------------------

/// Where a profile of the effective set comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// Only `storage.toml`.
    Local,
    /// Only the synced copy.
    Synced,
    /// Both, the same.
    Both,
    /// Both, different: `storage.toml`'s is used here.
    LocalOverSynced,
    /// A repository owner's storage shared with this maintainer.
    Shared,
}

/// `storage.toml` with the synced profiles added in memory.
#[derive(Debug, Clone, Default)]
pub struct Effective {
    /// The profiles to use (`storage.toml`'s, then the synced ones it does not name).
    pub profiles: StorageProfiles,
    /// Where each came from.
    pub origin: BTreeMap<String, Origin>,
    /// Synced profiles this build cannot use: why.
    pub unusable: BTreeMap<String, String>,
}

fn same_profile(local: &Profile, synced: &Value) -> bool {
    storage::profile_to_synced(local)
        .is_ok_and(|l| doc::canonical_json(&l) == doc::canonical_json(synced))
}

/// The live synced profiles of `doc`, by name.
pub fn synced_profiles(doc: &SlotDoc) -> BTreeMap<String, &Value> {
    doc.entries
        .iter()
        .filter_map(|(k, e)| {
            let name = k.strip_prefix(storage::PROFILE_PREFIX)?;
            Some((name.to_string(), e.v.as_ref()?))
        })
        .filter(|(n, _)| valid_profile_name(n))
        .collect()
}

/// `local` plus the profiles of the synced storage slot `doc` (`storage.toml` wins on name).
pub fn effective(local: &StorageProfiles, doc: Option<&SlotDoc>) -> Effective {
    let mut out = Effective {
        profiles: local.clone(),
        origin: local
            .profiles
            .keys()
            .map(|n| (n.clone(), Origin::Local))
            .collect(),
        unusable: BTreeMap::new(),
    };
    let Some(doc) = doc else { return out };
    for (name, value) in synced_profiles(doc) {
        if let Some(mine) = local.profiles.get(&name) {
            let o = if same_profile(mine, value) {
                Origin::Both
            } else {
                Origin::LocalOverSynced
            };
            out.origin.insert(name, o);
            continue;
        }
        match storage::profile_from_synced(value) {
            Ok(Some(p)) => {
                out.profiles.profiles.insert(name.clone(), p);
                out.origin.insert(name, Origin::Synced);
            }
            Ok(None) => {
                out.unusable
                    .insert(name, "a kind this version of dg does not know".into());
            }
            Err(e) => {
                out.unusable.insert(name, e.to_string());
            }
        }
    }
    out
}

/// The synced policy for `repo_id` (its own, else the default), when one names targets.
pub fn synced_policy(doc: &SlotDoc, repo_id: Option<&str>) -> Option<StoragePolicy> {
    repo_id
        .and_then(|r| doc.get(&storage::repo_key(r)))
        .or_else(|| doc.get(storage::DEFAULT_KEY))
        .and_then(storage::policy_from_synced)
}

/// What uploading a device's local settings would add.
#[derive(Debug, Clone, Default)]
pub struct Upload {
    /// The entries to merge in.
    pub changes: Option<SlotDoc>,
    /// Profiles uploaded, as `(local name, synced name)`.
    pub uploaded: Vec<(String, String)>,
    /// Profiles left out, with why (a secret that does not resolve here).
    pub skipped: Vec<(String, String)>,
}

/// The entries that bring `local` (and the default `policy`, git config's) into the synced
/// copy `synced` without dropping anything: a profile it lacks is added under its name; one it
/// holds with other settings under `<name>-<device>`; a name it tombstoned is left alone.
pub fn upload_plan(
    local: &StorageProfiles,
    default_policy: Option<&StoragePolicy>,
    synced: Option<&SlotDoc>,
    device: &str,
    at: u64,
) -> Upload {
    let empty = SlotDoc::new(SLOT_STORAGE);
    let synced = synced.unwrap_or(&empty);
    let mut changes = SlotDoc::new(SLOT_STORAGE);
    let mut out = Upload::default();
    for (name, profile) in &local.profiles {
        let value = match storage::profile_to_synced(profile) {
            Ok(v) => v,
            Err(e) => {
                out.skipped.push((name.clone(), e.to_string()));
                continue;
            }
        };
        let key = storage::profile_key(name);
        let target = match synced.entries.get(&key) {
            None => name.clone(),
            Some(e) => match &e.v {
                None => continue,
                Some(v) if doc::canonical_json(v) == doc::canonical_json(&value) => continue,
                Some(_) => {
                    let alt = format!("{name}-{device}");
                    if !valid_profile_name(&alt) {
                        out.skipped
                            .push((name.clone(), "its name is too long to keep both".into()));
                        continue;
                    }
                    match synced.get(&storage::profile_key(&alt)) {
                        Some(v) if doc::canonical_json(v) == doc::canonical_json(&value) => {
                            continue
                        }
                        _ => alt,
                    }
                }
            },
        };
        changes.set(&storage::profile_key(&target), at, value);
        out.uploaded.push((name.clone(), target));
    }
    if let Some(policy) = default_policy.filter(|p| !p.is_platform_only()) {
        if !synced.entries.contains_key(storage::DEFAULT_KEY) {
            changes.set(storage::DEFAULT_KEY, at, storage::policy_to_synced(policy));
        }
    }
    out.changes = (!changes.entries.is_empty()).then_some(changes);
    out
}

/// What a first sync did.
#[derive(Debug, Default)]
pub struct FirstSync {
    /// Profiles uploaded, as `(local name, synced name)`.
    pub uploaded: Vec<(String, String)>,
    /// Profiles left on this computer only, with why.
    pub skipped: Vec<(String, String)>,
    /// Whether the check passed and `syncedAt` was recorded.
    pub recorded: bool,
}

/// Bring this computer's `storage.toml` profiles (and global default policy) into the synced
/// copy without changing either: upload what it lacks, read it back, decrypt it, and check every
/// uploaded profile is there as sent before recording `syncedAt`. Runs again until it passes.
pub async fn first_sync(
    store: &dyn UserStore,
    key: &SyncKey,
    local: &StorageProfiles,
    default_policy: Option<&StoragePolicy>,
    device: &str,
) -> Result<FirstSync> {
    let sync = UserSync::new(key, store);
    let current = sync.read_slot(SLOT_STORAGE).await?.map(|r| r.doc);
    let plan = upload_plan(local, default_policy, current.as_ref(), device, now_ms());
    let back = match &plan.changes {
        Some(changes) => sync.merge_into(SLOT_STORAGE, changes).await?,
        None => current.unwrap_or_else(|| SlotDoc::new(SLOT_STORAGE)),
    };
    let checked = plan.uploaded.iter().all(|(local_name, synced_name)| {
        let sent = local
            .profiles
            .get(local_name)
            .and_then(|p| storage::profile_to_synced(p).ok());
        let got = back.get(&storage::profile_key(synced_name));
        match (sent, got) {
            (Some(s), Some(g)) => doc::canonical_json(&s) == doc::canonical_json(g),
            _ => false,
        }
    });
    if !checked {
        return Err(Error::Platform(
            "the synced storage settings did not read back as uploaded; nothing local was changed"
                .into(),
        ));
    }
    Ok(FirstSync {
        recorded: plan.skipped.is_empty(),
        uploaded: plan.uploaded,
        skipped: plan.skipped,
    })
}

// ---------------------------------------------------------------------------------------
// Maintainers: share + grants
// ---------------------------------------------------------------------------------------

/// A repository's shared storage: the profiles its policy names and the policy.
#[derive(Clone, PartialEq)]
pub struct ShareContent {
    /// Profile name → synced `{settings, secrets}`.
    pub profiles: BTreeMap<String, Value>,
    /// The policy.
    pub policy: Value,
    /// Fields this build does not know.
    pub extra: Map<String, Value>,
}

impl std::fmt::Debug for ShareContent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShareContent")
            .field("profiles", &self.profiles.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl ShareContent {
    /// The share for `policy` over `profiles` (the effective set): the non-Platform profiles it
    /// names, and the policy with any Platform-kind name as `platform`. `None` when it names no
    /// other profile, or one that is not there or does not resolve.
    pub fn for_policy(policy: &StoragePolicy, profiles: &StorageProfiles) -> Option<Self> {
        let mut out = BTreeMap::new();
        let mut targets = Vec::new();
        for name in &policy.targets {
            let p = profiles.get(name)?;
            if p.is_platform() {
                targets.push(crate::storage::PLATFORM_PROFILE.to_string());
                continue;
            }
            out.insert(name.clone(), storage::profile_to_synced(&p).ok()?);
            targets.push(name.clone());
        }
        let policy = StoragePolicy {
            targets,
            ..policy.clone()
        };
        (!out.is_empty()).then(|| Self {
            profiles: out,
            policy: storage::policy_to_synced(&policy),
            extra: Map::new(),
        })
    }

    /// Nothing shared: what a share holds once its owner stops sharing.
    fn nothing() -> Self {
        Self {
            profiles: BTreeMap::new(),
            policy: Value::Null,
            extra: Map::new(),
        }
    }

    /// Whether `self` holds what `other` holds (the fields dg writes; others are carried along).
    fn same_as(&self, other: &Self) -> bool {
        self.profiles == other.profiles && self.policy == other.policy
    }

    fn to_json(&self) -> Vec<u8> {
        let mut v = json!({
            "format": SHARE_FORMAT,
            "version": 1,
            "profiles": self.profiles,
            "policy": self.policy,
        });
        if let Value::Object(m) = &mut v {
            for (k, x) in &self.extra {
                m.entry(k.clone()).or_insert_with(|| x.clone());
            }
        }
        doc::canonical_json(&v)
    }

    fn parse(json: &[u8]) -> Result<Self> {
        let bad = || Error::InvalidInput("the shared storage does not parse".into());
        let Value::Object(mut m) = serde_json::from_slice(json).map_err(|_| bad())? else {
            return Err(bad());
        };
        if m.remove("format").as_ref().and_then(Value::as_str) != Some(SHARE_FORMAT) {
            return Err(bad());
        }
        m.remove("version");
        let profiles = match m.remove("profiles") {
            Some(Value::Object(p)) => p.into_iter().collect(),
            _ => return Err(bad()),
        };
        let policy = m.remove("policy").unwrap_or(Value::Null);
        Ok(Self {
            profiles,
            policy,
            extra: m,
        })
    }

    /// The shared profiles under `share.<owner8>.<name>` names (a name that would not be a valid
    /// profile name is left out), and the policy over those names, so they never collide with the
    /// maintainer's own. The owner's word does not reach the maintainer's own network: a shared
    /// profile never records a non-public address (`allow_private_uri` is off).
    pub fn as_profiles(
        &self,
        owner_id: &str,
    ) -> (BTreeMap<String, Profile>, Option<StoragePolicy>) {
        let tag: String = owner_id.chars().take(8).collect();
        let rename = |n: &str| Some(format!("share.{tag}.{n}")).filter(|s| valid_profile_name(s));
        let profiles = self
            .profiles
            .iter()
            .filter_map(|(n, v)| {
                let mut p = storage::profile_from_synced(v).ok()??;
                p.forbid_private_uri();
                Some((rename(n)?, p))
            })
            .collect::<BTreeMap<_, _>>();
        let policy = storage::policy_from_synced(&self.policy).and_then(|mut p| {
            p.targets = p
                .targets
                .iter()
                .map(|t| {
                    if t == crate::storage::PLATFORM_PROFILE {
                        Some(t.clone())
                    } else {
                        rename(t)
                    }
                })
                .collect::<Option<_>>()?;
            Some(p)
        });
        (profiles, policy)
    }
}

/// What an owner's reconcile makes the share hold.
#[derive(Debug, Clone, Copy)]
pub enum Wanted<'a> {
    /// What it holds now (the caller does not know the repository's policy).
    Keep,
    /// These profiles and policy.
    Content(&'a ShareContent),
    /// Nothing: the policy names no storage to share, so sharing stops.
    Nothing,
}

/// What an owner's reconcile did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reconciled {
    /// The epoch now.
    pub epoch: u32,
    /// Whether the share was written.
    pub share_written: bool,
    /// Maintainers whose grant was written.
    pub granted: Vec<String>,
    /// Maintainers with no forge-user key yet: access once they sign in with a wallet.
    pub waiting: Vec<String>,
    /// Members whose grant was deleted: no longer maintainers, their key no longer live, or the
    /// owner stopped sharing.
    pub revoked: Vec<String>,
    /// Whether the repository shares storage now.
    pub shared: bool,
}

impl UserSync<'_> {
    fn open_share(&self, share: &ShareDoc, rsk: &[u8; 32]) -> Result<ShareContent> {
        let repo = crate::platform::decode_identifier(&share.repo_id)?;
        let aad = crypto::share_aad(&self.key.network, &repo, share.epoch, share.key_id)?;
        let plain = crypto::inflate_raw(&crypto::open(
            rsk,
            &share.nonce,
            &share.pieces.concat(),
            &aad,
        )?)?;
        ShareContent::parse(&plain)
    }

    fn rsk(&self, repo: &[u8; 32], epoch: u32) -> crypto::Key32 {
        crypto::repo_storage_key(self.key.secret(), repo, &self.key.network, epoch)
    }

    /// Write the share of `repo_id` at `epoch` holding `content`, over `existing`.
    async fn put_share(
        &self,
        existing: Option<&ShareDoc>,
        repo_id: &str,
        epoch: u32,
        rsk: &[u8; 32],
        content: &ShareContent,
    ) -> Result<()> {
        let repo = crate::platform::decode_identifier(repo_id)?;
        let nonce = crypto::fresh_nonce()?;
        let aad = crypto::share_aad(&self.key.network, &repo, epoch, self.key.key_id)?;
        let ct = crypto::seal(rsk, &nonce, &crypto::deflate_raw(&content.to_json())?, &aad)?;
        let pieces = crypto::split(&ct)?;
        if pieces.len() > 2 {
            return Err(Error::InvalidInput(
                "the shared storage settings are over 10,000 bytes encrypted".into(),
            ));
        }
        self.store
            .put_share(&ShareDoc {
                id: existing.and_then(|s| s.id.clone()),
                owner_id: self.key.identity_id.clone(),
                revision: existing.and_then(|s| s.revision),
                repo_id: repo_id.to_string(),
                epoch,
                key_id: self.key.key_id,
                nonce,
                pieces,
            })
            .await
    }

    /// Wrap `rsk` (epoch `epoch` of `repo_id`) to `member`'s key `their`, over `old`.
    async fn put_grant(
        &self,
        old: Option<&GrantDoc>,
        repo_id: &str,
        member: &str,
        their: &EncKeyInfo,
        epoch: u32,
        rsk: &[u8; 32],
    ) -> Result<()> {
        let wrapped = crypto::wrap_grant(
            self.key.secret(),
            &their.public_key,
            &self.key.network,
            self.key.identity(),
            &crate::platform::decode_identifier(repo_id)?,
            &crate::platform::decode_identifier(member)?,
            epoch,
            self.key.key_id,
            their.id,
            rsk,
            &crypto::fresh_nonce()?,
        )?;
        self.store
            .put_grant(&GrantDoc {
                id: old.and_then(|g| g.id.clone()),
                owner_id: self.key.identity_id.clone(),
                revision: old.and_then(|g| g.revision),
                repo_id: repo_id.to_string(),
                member_id: member.to_string(),
                epoch,
                sender_key_id: self.key.key_id,
                recipient_key_id: their.id,
                wrapped,
            })
            .await
    }

    /// The grants of `repo_id` to revoke: anyone who is no longer one of `maintainers` (or is
    /// the owner), or whose recipient key is no longer a live forge-user key; everyone when
    /// sharing stops.
    async fn to_revoke(
        &self,
        grants: &[GrantDoc],
        maintainers: &BTreeSet<String>,
        stop: bool,
    ) -> Result<Vec<GrantDoc>> {
        let mut out = Vec::new();
        for g in grants {
            let gone = stop
                || g.member_id == self.key.identity_id
                || !maintainers.contains(&g.member_id)
                || self
                    .store
                    .encryption_key(&g.member_id, Some(g.recipient_key_id))
                    .await?
                    .is_none();
            if gone {
                out.push(g.clone());
            }
        }
        Ok(out)
    }

    /// As the owner of `repo_id`: make its share hold what `wanted` says, grant it to every one
    /// of `maintainers` that has a live forge-user key, and revoke every other grant, moving to
    /// a new epoch when one is revoked (the removed key can still open the old one). Revoked
    /// grants go first, so a share that cannot be written or read never keeps one. Writes nothing
    /// that is already so.
    pub async fn reconcile_repo(
        &self,
        repo_id: &str,
        wanted: Wanted<'_>,
        maintainers: &BTreeSet<String>,
    ) -> Result<Reconciled> {
        let me = &self.key.identity_id;
        let repo = crate::platform::decode_identifier(repo_id)?;
        let existing = self.store.share(me, repo_id).await?;
        let all = self.store.grants_of_repo(me, repo_id).await?;
        let stop = matches!(wanted, Wanted::Nothing);
        let revoked = self.to_revoke(&all, maintainers, stop).await?;
        let mut out = Reconciled {
            epoch: existing.as_ref().map_or(0, |s| s.epoch),
            ..Reconciled::default()
        };
        if !revoked.is_empty() && existing.is_some() {
            out.epoch = out.epoch.checked_add(1).ok_or(Error::Integrity)?;
        }
        for g in &revoked {
            self.store.delete_grant(g).await?;
            out.revoked.push(g.member_id.clone());
        }
        let current = match &existing {
            Some(s) => Some(self.open_share(s, &self.rsk(&repo, s.epoch))?),
            None => None,
        };
        let mut content = match wanted {
            Wanted::Content(c) => c.clone(),
            Wanted::Nothing if existing.is_some() => ShareContent::nothing(),
            Wanted::Keep => match &current {
                Some(c) => c.clone(),
                None => return Ok(out),
            },
            Wanted::Nothing => return Ok(out),
        };
        if let Some(c) = &current {
            for (k, v) in &c.extra {
                content.extra.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        let rsk = self.rsk(&repo, out.epoch);
        let unchanged = existing.as_ref().is_some_and(|s| {
            s.epoch == out.epoch
                && s.key_id == self.key.key_id
                && current.as_ref().is_some_and(|c| c.same_as(&content))
        });
        if !unchanged {
            self.put_share(existing.as_ref(), repo_id, out.epoch, &rsk, &content)
                .await?;
            out.share_written = true;
        }
        if stop {
            return Ok(out);
        }
        out.shared = true;
        let kept: Vec<&GrantDoc> = all
            .iter()
            .filter(|g| !revoked.iter().any(|r| r.id == g.id))
            .collect();
        for member in maintainers.iter().filter(|m| *m != me) {
            let Some(their) = self.store.encryption_key(member, None).await? else {
                out.waiting.push(member.clone());
                continue;
            };
            let old = kept.iter().copied().find(|g| g.member_id == *member);
            if old.is_some_and(|g| {
                g.epoch == out.epoch
                    && g.recipient_key_id == their.id
                    && g.sender_key_id == self.key.key_id
            }) {
                continue;
            }
            self.put_grant(old, repo_id, member, &their, out.epoch, &rsk)
                .await?;
            out.granted.push(member.clone());
        }
        Ok(out)
    }

    /// As a maintainer of `repo_id`, owned by `owner_id`: the storage its owner shared with this
    /// identity, when the owner's grant to this key is at the share's epoch. The caller checks
    /// that this identity is a current maintainer.
    pub async fn granted_share(
        &self,
        repo_id: &str,
        owner_id: &str,
    ) -> Result<Option<ShareContent>> {
        let me = &self.key.identity_id;
        if owner_id == me {
            return Ok(None);
        }
        let Some(share) = self.store.share(owner_id, repo_id).await? else {
            return Ok(None);
        };
        let Some(grant) = self.store.grant(owner_id, repo_id, me).await? else {
            return Ok(None);
        };
        if share.owner_id != owner_id
            || grant.owner_id != owner_id
            || grant.member_id != *me
            || grant.epoch != share.epoch
            || grant.recipient_key_id != self.key.key_id
        {
            return Ok(None);
        }
        let Some(owner_key) = self
            .store
            .encryption_key(owner_id, Some(grant.sender_key_id))
            .await?
        else {
            return Ok(None);
        };
        let repo = crate::platform::decode_identifier(repo_id)?;
        let owner = crate::platform::decode_identifier(owner_id)?;
        let rsk = crypto::unwrap_grant(
            self.key.secret(),
            &owner_key.public_key,
            &self.key.network,
            &owner,
            &repo,
            self.key.identity(),
            grant.epoch,
            grant.sender_key_id,
            grant.recipient_key_id,
            &grant.wrapped,
        )?;
        self.open_share(&share, &rsk).map(Some)
    }
}
