//! Moving settings sync to a new key (`docs/design/identity-synced-state.md`, #751), and adding
//! the identity's current sync key to another device, both from the recovery phrase.
//!
//! The forge-user key `E` of rotation `r` is the wallet's DIP-13 application encryption key
//! ([`SyncSeed::sync_secret`]). A move adds `E` of the next rotation and disables the current
//! key in one `IdentityUpdate` signed by the master key, then re-seals every `state` document
//! (plaintext byte for byte), moves every `share` to a new epoch under the new key (content
//! unchanged) and rewrites its grants with the new `senderKeyId`. A client that still holds the
//! old key then fails to open the slots (the key id is in the AAD) and writes nothing.
//!
//! A run that stops part-way is finished by the next one: documents still sealed under an older
//! key the phrase makes are re-sealed under the current key, with no second `IdentityUpdate`.

use std::collections::{BTreeMap, BTreeSet};

use async_trait::async_trait;

use super::store::{GrantDoc, ShareDoc, StateDoc, UserStore};
use super::{crypto, doc::SlotDoc, SyncKey, UserSync, SLOT_STORAGE};
use crate::app_connect::SecretBytes;
use crate::error::{Error, Result};
pub use crate::platform::identity_keys::SyncSeed;

/// The display-preferences slot the web app writes.
pub const SLOT_PREFS: &str = "prefs";

/// Slots a move creates (empty) when the identity has none, so a client holding the old key
/// finds them sealed under the new one and never starts them under the old key.
pub const GUARDED_SLOTS: [&str; 2] = [SLOT_STORAGE, SLOT_PREFS];

/// One of an identity's forge-user `ENCRYPTION` keys (`ECDSA_SECP256K1`, bound to forge-user
/// alone), live or disabled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeUserKey {
    /// Its id on the identity.
    pub id: u32,
    /// The 33-byte compressed public key.
    pub public_key: Vec<u8>,
    /// Whether it is disabled.
    pub disabled: bool,
}

/// An identity's forge-user keys, and the update that moves sync to a new one.
#[async_trait]
pub trait KeyLedger: Send + Sync {
    /// Every forge-user `ENCRYPTION` key of `identity`, live and disabled.
    async fn forge_user_keys(&self, identity: &str) -> Result<Vec<ForgeUserKey>>;
    /// One `IdentityUpdate` signed by the master key: add `secret` as the next key id (one above
    /// the highest), `ECDSA_SECP256K1` / `ENCRYPTION` / `MEDIUM`, bound to forge-user, not
    /// read-only, and disable the keys `disable` in the same transition. The new key's id, once
    /// a read shows it on the identity. A failure says whether the update was broadcast
    /// ([`MoveError::started`]): once it was, it may land later.
    async fn add_and_disable(
        &self,
        identity: &str,
        secret: &SecretBytes,
        disable: &[u32],
    ) -> std::result::Result<u32, MoveError>;
    /// The current maintainers of repository `repo_id` (its owner left out): who a share's
    /// grants may stay with. Empty for a repository that is gone.
    async fn maintainers(&self, repo_id: &str) -> Result<BTreeSet<String>>;
}

/// Where on the phrase's DIP-13 branch a forge-user key is: the pre-rotation path (testnet and
/// devnet wallets before DIP-13 gained the rotation level), else a rotation. Ordered: a legacy
/// key comes before rotation 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Rotation {
    /// `…/purpose'`, no rotation level.
    Legacy,
    /// `…/purpose'/r'`.
    At(u32),
}

/// The identity's forge-user keys as the recovery phrase makes them.
pub struct PhraseKeys {
    network: String,
    identity_id: String,
    current: u32,
    keys: BTreeMap<u32, SyncKey>,
    rotations: BTreeMap<u32, Rotation>,
    live: Vec<u32>,
    next: SecretBytes,
    next_taken: Option<u32>,
    next_id: u32,
}

impl std::fmt::Debug for PhraseKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PhraseKeys")
            .field("identity_id", &self.identity_id)
            .field("current", &self.current)
            .field("rotations", &self.rotations)
            .finish_non_exhaustive()
    }
}

impl PhraseKeys {
    /// The identity's current (highest-id live) forge-user key.
    pub fn current(&self) -> &SyncKey {
        &self.keys[&self.current]
    }

    /// The key a move would register (public values only): its expected id (one above the
    /// highest forge-user key id; the update decides) and its public key. What a device records
    /// before the update, so a retry after a lost answer finishes under it ([`move_key_with`]).
    pub fn next_key(&self) -> Result<(u32, [u8; 33])> {
        Ok((self.next_id, crypto::public_key(&self.next)?))
    }

    /// Whether an earlier move can be finished under the current key: it is at rotation 1 or
    /// above (a move never registers rotation 0, which wallets hand out at sign-in, nor the
    /// legacy key) and at the highest rotation the phrase made of any of the identity's
    /// forge-user keys, live or disabled. A current key at a lower rotation (one an attacker
    /// could hold, registered again under a newer id) is always moved away from.
    pub fn current_is_newest(&self) -> bool {
        let current = self.rotations.get(&self.current);
        current >= Some(&Rotation::At(1)) && self.rotations.values().max() == current
    }
}

/// What the phrase makes of the identity's sync keys.
#[derive(Debug)]
pub enum PhraseCheck {
    /// The identity has no live forge-user key: it doesn't sync yet. Nothing was written.
    NotSyncing,
    /// The phrase does not make the identity's current forge-user key. Nothing was written.
    NotThisPhrase,
    /// The keys.
    Keys(PhraseKeys),
}

/// The line for [`PhraseCheck::NotSyncing`].
pub const NOT_SYNCING: &str = "This identity doesn't sync yet.";
/// The line for [`PhraseCheck::NotThisPhrase`].
pub const NOT_THIS_PHRASE: &str = "This recovery phrase doesn't make this identity's sync key.";

/// Derive the legacy key and rotations `0..=n` (`n` = the number of forge-user keys + 2, at
/// least 4) and match them to `identity_id`'s forge-user keys. `network` is Forge's network key
/// (coin type 5 only on `mainnet`); `contract_id` is forge-user's. Reads the identity once and
/// writes nothing. The next key is one rotation past the highest the phrase made (at least
/// rotation 1: rotation 0 is what wallets hand out at sign-in).
pub async fn phrase_keys(
    ledger: &dyn KeyLedger,
    seed: &SyncSeed,
    network: &str,
    identity_id: &str,
    contract_id: &str,
) -> Result<PhraseCheck> {
    let identity = crate::platform::decode_identifier(identity_id)?;
    let contract = crate::platform::decode_identifier(contract_id)?;
    let all = ledger.forge_user_keys(identity_id).await?;
    let Some(current) = all.iter().filter(|k| !k.disabled).map(|k| k.id).max() else {
        return Ok(PhraseCheck::NotSyncing);
    };
    let n = u32::try_from(all.len() + 2).unwrap_or(u32::MAX).max(4);
    let mainnet = network == "mainnet";
    let mut keys = BTreeMap::new();
    let mut rotations = BTreeMap::new();
    let candidates = std::iter::once(Rotation::Legacy).chain((0..=n).map(Rotation::At));
    for rotation in candidates {
        let secret = match rotation {
            Rotation::Legacy => seed.legacy_sync_secret(mainnet, &identity, &contract)?,
            Rotation::At(r) => seed.sync_secret(mainnet, &identity, &contract, r)?,
        };
        let public = crypto::public_key(&secret)?;
        for k in all.iter().filter(|k| k.public_key == public) {
            keys.insert(
                k.id,
                SyncKey::new(network, identity_id, k.id, secret.clone())?,
            );
            rotations.insert(k.id, rotation);
        }
    }
    if !keys.contains_key(&current) {
        return Ok(PhraseCheck::NotThisPhrase);
    }
    let highest = rotations
        .values()
        .filter_map(|r| match r {
            Rotation::At(r) => Some(*r),
            Rotation::Legacy => None,
        })
        .max()
        .unwrap_or(0);
    let next = seed.sync_secret(
        mainnet,
        &identity,
        &contract,
        highest.checked_add(1).ok_or(Error::Integrity)?,
    )?;
    let next_public = crypto::public_key(&next)?;
    let next_taken = all
        .iter()
        .any(|k| k.public_key == next_public)
        .then_some(highest + 1);
    let live = all
        .iter()
        .filter(|k| !k.disabled && keys.contains_key(&k.id))
        .map(|k| k.id)
        .collect();
    Ok(PhraseCheck::Keys(PhraseKeys {
        network: network.to_string(),
        identity_id: identity_id.to_string(),
        current,
        keys,
        rotations,
        live,
        next,
        next_taken,
        next_id: all.iter().map(|k| k.id + 1).max().unwrap_or(0),
    }))
}

/// The refusal of a move whose next key is already on the identity.
pub fn next_taken_line(rotation: u32) -> String {
    format!(
        "This identity already has the sync key a move would add (rotation {rotation}). Nothing was changed."
    )
}

/// What a move did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Moved {
    /// The key sync is under now.
    pub key_id: u32,
    /// The keys this run disabled (none: an earlier run, or another device, already moved).
    pub disabled: Vec<u32>,
    /// Slots re-sealed under the new key.
    pub states: Vec<String>,
    /// Slots created empty under the new key ([`GUARDED_SLOTS`]).
    pub created: Vec<String>,
    /// Repositories whose share moved to a new epoch under the new key.
    pub shares: Vec<String>,
    /// Grants rewritten with the new sender key.
    pub grants: usize,
    /// Grants deleted: their recipient key is no longer live.
    pub dropped: usize,
}

impl Moved {
    /// Whether the run changed nothing: no update, nothing written (sync was already under the
    /// newest key).
    pub fn nothing_done(&self) -> bool {
        self.disabled.is_empty()
            && self.states.is_empty()
            && self.created.is_empty()
            && self.shares.is_empty()
            && self.grants == 0
            && self.dropped == 0
    }
}

/// A move that failed: whether it failed before anything was written (`started` false: nothing
/// changed) or part-way (the same command finishes it).
#[derive(Debug)]
pub struct MoveError {
    /// Whether something was already written (this run's update landed, or an earlier run's
    /// move is being finished).
    pub started: bool,
    /// Why.
    pub error: Error,
}

impl std::fmt::Display for MoveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(f)
    }
}

impl std::error::Error for MoveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}

struct Plan {
    states: Vec<StateDoc>,
    shares: Vec<(ShareDoc, Vec<GrantDoc>)>,
    maintainers: BTreeMap<String, BTreeSet<String>>,
}

impl Plan {
    async fn read(
        store: &dyn UserStore,
        ledger: &dyn KeyLedger,
        keys: &PhraseKeys,
    ) -> Result<Self> {
        let me = &keys.identity_id;
        let states: Vec<StateDoc> = store
            .states_of(me)
            .await?
            .into_iter()
            .filter(|s| s.owner_id == *me)
            .collect();
        let mut shares = Vec::new();
        for share in store.shares_of(me).await? {
            if share.owner_id != *me {
                continue;
            }
            let grants = store.grants_of_repo(me, &share.repo_id).await?;
            shares.push((share, grants));
        }
        // Every document must open with a key the phrase makes, before anything is written.
        for s in &states {
            if s.v != crypto::STATE_V {
                return Err(Error::InvalidInput(format!(
                    "your synced {} settings were written by a newer Forge; update dg to move them",
                    s.slot
                )));
            }
            if !keys.keys.contains_key(&s.key_id) {
                return Err(unknown_key(
                    &format!("synced {} settings", s.slot),
                    s.key_id,
                ));
            }
        }
        for (s, gs) in &shares {
            if !keys.keys.contains_key(&s.key_id) {
                return Err(unknown_key("shared storage of a repository", s.key_id));
            }
            if gs
                .iter()
                .map(|g| g.epoch)
                .fold(s.epoch, u32::max)
                .checked_add(1)
                .is_none()
            {
                return Err(Error::InvalidInput(
                    "a repository's shared storage is at the last epoch there is; nothing was changed"
                        .into(),
                ));
            }
        }
        let mut maintainers = BTreeMap::new();
        for (s, _) in &shares {
            maintainers.insert(s.repo_id.clone(), ledger.maintainers(&s.repo_id).await?);
        }
        let plan = Self {
            states,
            shares,
            maintainers,
        };
        plan.opens(keys)?;
        Ok(plan)
    }

    /// Every document opens under the key it names: checked before the identity update, so a
    /// slot or share that can't be read never strands a move after the old key is disabled.
    fn opens(&self, keys: &PhraseKeys) -> Result<()> {
        for s in &self.states {
            open_state_doc(&keys.keys[&s.key_id], s).map_err(|_| {
                Error::InvalidInput(format!(
                    "your synced {} settings don't open with key {}; nothing was changed",
                    s.slot, s.key_id
                ))
            })?;
        }
        for (s, _) in &self.shares {
            open_share_doc(&keys.keys[&s.key_id], s).map_err(|_| {
                Error::InvalidInput(format!(
                    "a repository's shared storage doesn't open with key {}; nothing was changed",
                    s.key_id
                ))
            })?;
        }
        Ok(())
    }

    /// Whether some document is not yet under `key_id`: an interrupted move.
    fn behind(&self, key_id: u32) -> bool {
        self.states.iter().any(|s| s.key_id != key_id)
            || self
                .shares
                .iter()
                .any(|(s, gs)| s.key_id != key_id || gs.iter().any(|g| g.sender_key_id != key_id))
    }
}

fn unknown_key(what: &str, key_id: u32) -> Error {
    Error::InvalidInput(format!(
        "your {what} are sealed under key {key_id}, which this recovery phrase doesn't make; nothing was changed"
    ))
}

/// Move `keys`' identity to a new sync key (spec §B), or finish a move that stopped part-way.
/// `held` is the key id this device holds, if any.
///
/// A run finishes an earlier move only when the current key is at the highest rotation the
/// phrase makes ([`PhraseKeys::current_is_newest`]) and something is still behind it (or this
/// device holds another key); then no update is sent and what is behind is re-sealed under the
/// current key. Otherwise the next rotation's key is added and every live forge-user key the
/// phrase makes is disabled, in one update. Then: every `state` slot, read with the key its
/// `keyId` names, is written again under the new key with the same plaintext and read back;
/// missing [`GUARDED_SLOTS`] are created empty; every share moves to an epoch above it and every
/// grant of it, then each grant is rewritten (a grant whose recipient key is no longer live, or
/// that is below the share's epoch, is deleted). Returns the new key and what was written.
pub async fn move_key(
    store: &dyn UserStore,
    ledger: &dyn KeyLedger,
    keys: &PhraseKeys,
    held: Option<u32>,
) -> std::result::Result<(SyncKey, Moved), MoveError> {
    move_key_with(store, ledger, keys, held, None).await
}

/// [`move_key`], where `pending` is the public key this device recorded before an earlier
/// run's identity update ([`PhraseKeys::next_key`]): when it is the current key, that update
/// landed though its answer was lost, and the move is finished under it rather than moved again.
pub async fn move_key_with(
    store: &dyn UserStore,
    ledger: &dyn KeyLedger,
    keys: &PhraseKeys,
    held: Option<u32>,
    pending: Option<&[u8]>,
) -> std::result::Result<(SyncKey, Moved), MoveError> {
    let before = |error| MoveError {
        started: false,
        error,
    };
    if let Some(rotation) = keys.next_taken {
        return Err(before(Error::InvalidInput(next_taken_line(rotation))));
    }
    let plan = Plan::read(store, ledger, keys).await.map_err(before)?;
    let current = keys.current();
    let landed_unanswered = pending
        .is_some_and(|p| crypto::public_key(current.secret()).is_ok_and(|c| c.as_slice() == p));
    let resume = keys.current_is_newest()
        && (plan.behind(current.key_id)
            || held.is_some_and(|h| h != current.key_id)
            || landed_unanswered);
    let mut out = Moved::default();
    let target = if resume {
        current.clone()
    } else {
        let id = ledger
            .add_and_disable(&keys.identity_id, &keys.next, &keys.live)
            .await?;
        out.disabled.clone_from(&keys.live);
        SyncKey::new(&keys.network, &keys.identity_id, id, keys.next.clone()).map_err(|error| {
            MoveError {
                started: true,
                error,
            }
        })?
    };
    out.key_id = target.key_id;
    reseal(store, keys, &plan, &target, &mut out)
        .await
        .map_err(|error| MoveError {
            started: true,
            error,
        })?;
    Ok((target, out))
}

async fn reseal(
    store: &dyn UserStore,
    keys: &PhraseKeys,
    plan: &Plan,
    target: &SyncKey,
    out: &mut Moved,
) -> Result<()> {
    let sync = UserSync::new(target, store);
    for s in &plan.states {
        if s.key_id == target.key_id {
            continue;
        }
        reseal_state(&sync, &keys.keys[&s.key_id], s).await?;
        out.states.push(s.slot.clone());
    }
    for slot in GUARDED_SLOTS {
        if plan.states.iter().any(|s| s.slot == slot) {
            continue;
        }
        // A slot an old-key client created after the listing, before the update disabled it.
        match store.state(&target.identity_id, slot).await? {
            Some(late) if late.key_id == target.key_id => {}
            Some(late) => {
                let old = keys
                    .keys
                    .get(&late.key_id)
                    .ok_or_else(|| unknown_key(&format!("synced {slot} settings"), late.key_id))?;
                reseal_state(&sync, old, &late).await?;
                out.states.push(slot.to_string());
            }
            None => {
                let empty = SlotDoc::new(slot).to_json()?;
                sync.write_plain(slot, &empty, None).await?;
                out.created.push(slot.to_string());
            }
        }
    }
    for (share, grants) in &plan.shares {
        let (written, rewritten, dropped) = move_share(
            &sync,
            &keys.keys[&share.key_id],
            share,
            grants,
            &plan.maintainers[&share.repo_id],
        )
        .await?;
        if written {
            out.shares.push(share.repo_id.clone());
        }
        out.grants += rewritten;
        out.dropped += dropped;
    }
    Ok(())
}

/// The identity's current sync key, for a device that does not hold it (spec §B').
pub fn add_key(keys: &PhraseKeys) -> SyncKey {
    keys.current().clone()
}

fn open_state_doc(old: &SyncKey, s: &StateDoc) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    crypto::open_state(
        old.secret(),
        &old.network,
        old.identity(),
        &s.slot,
        s.v,
        s.key_id,
        &s.nonce,
        &s.pieces,
    )
}

/// The share's sealed (still deflated) content, opened under `old`.
fn open_share_doc(old: &SyncKey, share: &ShareDoc) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    let repo = crate::platform::decode_identifier(&share.repo_id)?;
    let aad = crypto::share_aad(&old.network, &repo, share.epoch, share.key_id)?;
    let rsk = crypto::repo_storage_key(old.secret(), &repo, &old.network, share.epoch);
    crypto::open(&rsk, &share.nonce, &share.pieces.concat(), &aad)
}

async fn reseal_state(sync: &UserSync<'_>, old: &SyncKey, s: &StateDoc) -> Result<()> {
    let plain = open_state_doc(old, s)?;
    sync.write_plain(&s.slot, &plain, Some(s)).await
}

/// Move one share to `sync`'s key (unless it already is) and rewrite its grants: whether the
/// share was written, the grants rewritten and the grants deleted.
async fn move_share(
    sync: &UserSync<'_>,
    old: &SyncKey,
    share: &ShareDoc,
    grants: &[GrantDoc],
    maintainers: &BTreeSet<String>,
) -> Result<(bool, usize, usize)> {
    let key = sync.key;
    let repo = crate::platform::decode_identifier(&share.repo_id)?;
    let (mut rewritten, mut dropped) = (0, 0);
    let moving = share.key_id != key.key_id;
    // As a reconcile would, before the share moves: a grant to someone who is no longer a
    // maintainer, or below the share's epoch (one a removal revoked and stopped before deleting,
    // or had not re-granted yet), is deleted, so no retry ever lends the new share to it. The
    // owner's next push grants the current maintainers again.
    let mut kept = Vec::new();
    for g in grants {
        let current = maintainers.contains(&g.member_id) && g.member_id != key.identity_id;
        if current && (!moving || g.epoch >= share.epoch) {
            kept.push(g);
        } else {
            sync.store.delete_grant(g).await?;
            dropped += 1;
        }
    }
    let (epoch, written) = if moving {
        let sealed = open_share_doc(old, share)?;
        let epoch = grants
            .iter()
            .map(|g| g.epoch)
            .fold(share.epoch, u32::max)
            .checked_add(1)
            .ok_or(Error::Integrity)?;
        let nonce = crypto::fresh_nonce()?;
        let aad = crypto::share_aad(&key.network, &repo, epoch, key.key_id)?;
        let pieces = crypto::split(&crypto::seal(
            &sync.rsk(&repo, epoch),
            &nonce,
            &sealed,
            &aad,
        )?)?;
        sync.store
            .put_share(&ShareDoc {
                id: share.id.clone(),
                owner_id: key.identity_id.clone(),
                revision: share.revision,
                repo_id: share.repo_id.clone(),
                epoch,
                key_id: key.key_id,
                nonce,
                pieces,
            })
            .await?;
        (epoch, true)
    } else {
        (share.epoch, false)
    };
    let rsk = sync.rsk(&repo, epoch);
    for g in kept {
        if g.sender_key_id == key.key_id && (!written || g.epoch == epoch) {
            continue;
        }
        let live = sync.store.encryption_keys(&g.member_id).await?;
        if let Some(their) = live.iter().find(|k| k.id == g.recipient_key_id) {
            sync.put_grant(Some(g), &share.repo_id, &g.member_id, their, epoch, &rsk)
                .await?;
            rewritten += 1;
        } else {
            sync.store.delete_grant(g).await?;
            dropped += 1;
        }
    }
    Ok((written, rewritten, dropped))
}

/// What a device's sync key is to the identity now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStanding {
    /// It is the identity's current forge-user key (or the identity lists none live).
    Current,
    /// The identity's current forge-user key is another one: sync moved to a new key, and this
    /// device needs it once (`add-key`).
    Moved,
}

/// Whether `key` is still `store`'s identity's current forge-user key (one identity read).
pub async fn standing(store: &dyn UserStore, key: &SyncKey) -> Result<KeyStanding> {
    let live = store.encryption_keys(&key.identity_id).await?;
    let public = crypto::public_key(key.secret())?;
    Ok(match live.last() {
        Some(newest) if newest.id != key.key_id || newest.public_key != public => {
            KeyStanding::Moved
        }
        _ => KeyStanding::Current,
    })
}

/// The note a device holding a key that sync moved away from sees: plain, with the one step.
pub const ADD_KEY_NOTE: &str = "your synced settings moved to a new key; add it to this computer once with `dg storage sync add-key`";

/// The error a write under a key that is no longer the identity's current one returns.
pub const KEY_MOVED: &str = "your synced settings moved to a new key, which this device doesn't hold yet; nothing was written";

/// Refuse a write under `key` when it is not the identity's current forge-user key: a client
/// holding a key that was moved away from must not write state or shares under it.
///
/// A read that fails can't tell, and allows the write, as before sync keys could move: a user
/// who never moves is never blocked by it.
pub async fn require_current(store: &dyn UserStore, key: &SyncKey) -> Result<()> {
    match standing(store, key).await {
        Ok(KeyStanding::Moved) => Err(Error::InvalidInput(KEY_MOVED.into())),
        Ok(KeyStanding::Current) | Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    use serde_json::json;

    use super::*;
    use crate::user_sync::{MemoryStore, ShareContent, Wanted, SHARE_VERSION};

    const ABANDON: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                           abandon abandon abandon about";
    const OTHER: &str = "legal winner thank year wave sausage worth useful legal winner thank \
                         yellow";
    const CONTRACT: &str = "46phmETaASw6L1AsBc3MDTCQTMGkiVV8hGwsgi5ay6BU";
    const ZETA_STORAGE: &[u8] = br#"{"entries":{},"format":"forge-user/storage","version":1}"#;
    const ZETA: &[u8] =
        br#"{"version":7,"format":"forge-user/zeta","entries":{"x":{"weird":true,"at":1,"v":{"b":2,"a":1}}},"top":"kept"}"#;

    fn h(label: &str) -> [u8; 32] {
        use sha2::Digest as _;
        sha2::Sha256::digest(label.as_bytes()).into()
    }

    fn id(label: &str) -> String {
        crate::app_connect::encode_base58(&h(label))
    }

    struct Ledger<'a> {
        store: &'a MemoryStore,
        fail: AtomicBool,
        lose_answer: AtomicBool,
        updates: AtomicU32,
        late_prefs: std::sync::Mutex<Option<SyncKey>>,
        maintainers_of: std::sync::Mutex<Option<BTreeSet<String>>>,
    }

    #[async_trait]
    impl KeyLedger for Ledger<'_> {
        async fn forge_user_keys(&self, identity: &str) -> Result<Vec<ForgeUserKey>> {
            Ok(self
                .store
                .all_keys(identity)
                .into_iter()
                .map(|(k, disabled)| ForgeUserKey {
                    id: k.id,
                    public_key: k.public_key,
                    disabled,
                })
                .collect())
        }

        async fn add_and_disable(
            &self,
            identity: &str,
            secret: &SecretBytes,
            disable: &[u32],
        ) -> std::result::Result<u32, MoveError> {
            if self.fail.swap(false, Ordering::SeqCst) {
                return Err(MoveError {
                    started: false,
                    error: Error::Platform("refused before it was sent".into()),
                });
            }
            let next = self
                .store
                .all_keys(identity)
                .iter()
                .map(|(k, _)| k.id + 1)
                .max()
                .unwrap_or(0);
            let late = self.late_prefs.lock().unwrap().take();
            if let Some(old) = late {
                futures::executor::block_on(UserSync::new(&old, self.store).write_plain(
                    SLOT_PREFS,
                    br#"{"entries":{},"format":"forge-user/prefs","version":1}"#,
                    None,
                ))
                .unwrap();
            }
            let public = crypto::public_key(secret).map_err(|error| MoveError {
                started: false,
                error,
            })?;
            self.store.add_key(identity, next, public.to_vec());
            for id in disable {
                self.store.disable_key(identity, *id);
            }
            self.updates.fetch_add(1, Ordering::SeqCst);
            if self.lose_answer.swap(false, Ordering::SeqCst) {
                return Err(MoveError {
                    started: true,
                    error: Error::Platform("the answer was lost".into()),
                });
            }
            Ok(next)
        }

        async fn maintainers(&self, repo_id: &str) -> Result<BTreeSet<String>> {
            if let Some(set) = self.maintainers_of.lock().unwrap().clone() {
                return Ok(set);
            }
            Ok(self
                .store
                .all_grants()
                .into_iter()
                .filter(|g| g.repo_id == repo_id)
                .map(|g| g.member_id)
                .collect())
        }
    }

    struct World {
        me: String,
        member: String,
        repo: String,
        store: MemoryStore,
        e0: SyncKey,
        e_member: SyncKey,
        content: ShareContent,
    }

    impl World {
        fn ledger(&self) -> Ledger<'_> {
            Ledger {
                store: &self.store,
                fail: AtomicBool::new(false),
                lose_answer: AtomicBool::new(false),
                updates: AtomicU32::new(0),
                late_prefs: std::sync::Mutex::new(None),
                maintainers_of: std::sync::Mutex::new(None),
            }
        }

        /// Every slot's plaintext, opened with `key`.
        fn plaintexts(&self, key: &SyncKey) -> BTreeMap<String, Vec<u8>> {
            let states = futures::executor::block_on(self.store.states_of(&self.me)).unwrap();
            states
                .iter()
                .map(|s| {
                    let plain = crypto::open_state(
                        key.secret(),
                        &key.network,
                        key.identity(),
                        &s.slot,
                        s.v,
                        s.key_id,
                        &s.nonce,
                        &s.pieces,
                    )
                    .unwrap();
                    (s.slot.clone(), plain.to_vec())
                })
                .collect()
        }
    }

    fn seed(phrase: &str) -> SyncSeed {
        SyncSeed::from_phrase(phrase).unwrap()
    }

    /// An identity syncing under rotation 0 (key 3): a storage slot, a slot this build does not
    /// know, and one repository shared with a maintainer.
    async fn world() -> World {
        let me = id("mover");
        let member = id("mover's maintainer");
        let repo = id("mover's repo");
        let secret = seed(ABANDON)
            .sync_secret(
                false,
                &crate::platform::decode_identifier(&me).unwrap(),
                &crate::platform::decode_identifier(CONTRACT).unwrap(),
                0,
            )
            .unwrap();
        let e0 = SyncKey::new("testnet", &me, 3, secret).unwrap();
        let e_member =
            SyncKey::new("testnet", &member, 9, SecretBytes::new(h("member E"))).unwrap();
        let store = MemoryStore::new();
        store.add_key(&me, 3, e0.public_key().to_vec());
        store.add_key(&member, 9, e_member.public_key().to_vec());
        store.as_signer(&me);
        let sync = UserSync::new(&e0, &store);
        let mut storage = SlotDoc::new(SLOT_STORAGE);
        storage.set(
            "profile:r2",
            5,
            json!({"settings": {"kind": "s3", "bucket": "b"}, "secrets": {"secretAccessKey": "s"}}),
        );
        storage.set("future:thing", 6, json!({"unknown": [1, 2]}));
        sync.merge_into(SLOT_STORAGE, &storage).await.unwrap();
        sync.write_plain("zeta", ZETA, None).await.unwrap();
        let content = ShareContent {
            profiles: [(
                "r2".to_string(),
                json!({"settings": {"kind": "s3", "bucket": "b"}, "secrets": {"secretAccessKey": "s"}}),
            )]
            .into(),
            policy: json!({"targets": ["r2"], "replicas": 1, "platformFallback": false}),
            version: SHARE_VERSION,
            extra: serde_json::Map::new(),
        };
        let maintainers: BTreeSet<String> = [member.clone()].into();
        let r = sync
            .reconcile_repo(&repo, Wanted::Content(&content), &maintainers)
            .await
            .unwrap();
        assert_eq!(r.granted, vec![member.clone()]);
        World {
            me,
            member,
            repo,
            store,
            e0,
            e_member,
            content,
        }
    }

    async fn keys_of(w: &World, ledger: &Ledger<'_>, phrase: &str) -> PhraseCheck {
        phrase_keys(ledger, &seed(phrase), "testnet", &w.me, CONTRACT)
            .await
            .unwrap()
    }

    async fn ready(w: &World, ledger: &Ledger<'_>) -> PhraseKeys {
        match keys_of(w, ledger, ABANDON).await {
            PhraseCheck::Keys(k) => k,
            other => panic!("expected keys, got {other:?}"),
        }
    }

    /// The end state of a finished move to key `new_id`: everything under it, the plaintext as
    /// before byte for byte, the share as before at a newer epoch, the old key shut out.
    async fn assert_moved(w: &World, before: &BTreeMap<String, Vec<u8>>, new_id: u32) {
        assert_moved_to(w, before, new_id, 1).await;
    }

    async fn assert_moved_to(
        w: &World,
        before: &BTreeMap<String, Vec<u8>>,
        new_id: u32,
        rotation: u32,
    ) {
        let live = w.store.encryption_keys(&w.me).await.unwrap();
        assert_eq!(live.iter().map(|k| k.id).collect::<Vec<_>>(), [new_id]);
        let new_key = SyncKey::new(
            "testnet",
            &w.me,
            new_id,
            seed(ABANDON)
                .sync_secret(
                    false,
                    w.e0.identity(),
                    &crate::platform::decode_identifier(CONTRACT).unwrap(),
                    rotation,
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(live[0].public_key, new_key.public_key().to_vec());
        let states = w.store.states_of(&w.me).await.unwrap();
        assert!(states.iter().all(|s| s.key_id == new_id));
        let after = w.plaintexts(&new_key);
        for (slot, plain) in before {
            assert_eq!(&after[slot], plain, "{slot} changed");
        }
        assert_eq!(after["zeta"], ZETA);
        assert_eq!(
            after[SLOT_PREFS],
            SlotDoc::new(SLOT_PREFS).to_json().unwrap()
        );
        assert!(UserSync::new(&w.e0, &w.store)
            .read_slot(SLOT_STORAGE)
            .await
            .is_err());

        let share = w.store.share(&w.me, &w.repo).await.unwrap().unwrap();
        let grants = w.store.grants_of_repo(&w.me, &w.repo).await.unwrap();
        assert_eq!(share.key_id, new_id);
        assert!(share.epoch >= 1);
        assert_eq!(grants.len(), 1);
        assert!(grants.iter().all(|g| g.epoch == share.epoch
            && g.sender_key_id == new_id
            && g.recipient_key_id == 9));
        let got = UserSync::new(&w.e_member, &w.store)
            .granted_share(&w.repo, &w.me)
            .await
            .unwrap();
        assert_eq!(got.as_ref(), Some(&w.content));
        let old = UserSync::new(&w.e0, &w.store);
        let repo = crate::platform::decode_identifier(&w.repo).unwrap();
        assert!(old
            .open_share(&share, &old.rsk(&repo, share.epoch))
            .is_err());
    }

    #[tokio::test]
    async fn a_move_reseals_everything_under_the_next_rotation_byte_for_byte() {
        let w = world().await;
        let before = w.plaintexts(&w.e0);
        let old_share = w.store.share(&w.me, &w.repo).await.unwrap().unwrap();
        let ledger = w.ledger();
        let keys = ready(&w, &ledger).await;
        assert_eq!(add_key(&keys).key_id, 3);
        let (key, moved) = move_key(&w.store, &ledger, &keys, Some(3)).await.unwrap();
        assert_eq!(key.key_id, 4);
        assert_eq!(moved.disabled, [3]);
        assert_eq!(moved.states, ["storage", "zeta"]);
        assert_eq!(moved.created, ["prefs"]);
        assert_eq!(moved.shares, std::slice::from_ref(&w.repo));
        assert_eq!((moved.grants, moved.dropped), (1, 0));
        assert_moved(&w, &before, 4).await;
        let share = w.store.share(&w.me, &w.repo).await.unwrap().unwrap();
        assert_eq!(share.epoch, old_share.epoch + 1);

        // Another device: the phrase makes the current key; adding it opens the slots.
        let keys = ready(&w, &ledger).await;
        let added = add_key(&keys);
        assert_eq!(added.key_id, 4);
        assert_eq!(added.secret().expose(), key.secret().expose());
        let read = UserSync::new(&added, &w.store)
            .read_slot(SLOT_STORAGE)
            .await
            .unwrap()
            .unwrap();
        assert!(read.doc.get("future:thing").is_some());

        // A device that still holds key 3 runs the move again: it only adopts key 4.
        let writes = w.store.writes();
        let (again, moved) = move_key(&w.store, &ledger, &keys, Some(3)).await.unwrap();
        assert_eq!(again.key_id, 4);
        assert!(moved.nothing_done());
        assert_eq!(w.store.writes(), writes);
        assert_eq!(ledger.updates.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_client_holding_the_old_key_reads_an_error_and_writes_nothing() {
        let w = world().await;
        let ledger = w.ledger();
        let keys = ready(&w, &ledger).await;
        move_key(&w.store, &ledger, &keys, Some(3)).await.unwrap();
        let writes = w.store.writes();
        let old = UserSync::new(&w.e0, &w.store);
        // What every released client does first: open the slot. The key id is in the AAD.
        assert!(matches!(
            old.read_slot(SLOT_STORAGE).await,
            Err(Error::Integrity)
        ));
        let mut change = SlotDoc::new(SLOT_STORAGE);
        change.set(
            "profile:new",
            super::super::now_ms(),
            json!({"settings": {}}),
        );
        assert!(old.merge_into(SLOT_STORAGE, &change).await.is_err());
        assert!(old.merge_into(SLOT_PREFS, &change).await.is_err());
        let local = crate::storage::StorageProfiles::default();
        assert!(
            super::super::first_sync(&w.store, &w.e0, &local, None, "dev")
                .await
                .is_err()
        );
        let maintainers: BTreeSet<String> = [w.member.clone()].into();
        assert!(old
            .reconcile_repo_by_rule(&w.repo, &maintainers)
            .await
            .is_err());
        // Even with no slot to read first, a share is never written under the old key.
        for wanted in [Wanted::Keep, Wanted::Nothing, Wanted::Content(&w.content)] {
            let e = old
                .reconcile_repo(&w.repo, wanted, &BTreeSet::new())
                .await
                .unwrap_err();
            assert!(e.to_string().contains("moved to a new key"), "{e}");
        }
        assert_eq!(w.store.writes(), writes, "the old key wrote something");
        assert_eq!(standing(&w.store, &w.e0).await.unwrap(), KeyStanding::Moved);
    }

    #[tokio::test]
    async fn a_wrong_phrase_or_no_live_key_refuses_before_any_write() {
        let w = world().await;
        let ledger = w.ledger();
        let writes = w.store.writes();
        assert!(matches!(
            keys_of(&w, &ledger, OTHER).await,
            PhraseCheck::NotThisPhrase
        ));
        let nobody = phrase_keys(&ledger, &seed(ABANDON), "testnet", &id("nobody"), CONTRACT)
            .await
            .unwrap();
        assert!(matches!(nobody, PhraseCheck::NotSyncing));
        w.store.disable_key(&w.me, 3);
        assert!(matches!(
            keys_of(&w, &ledger, ABANDON).await,
            PhraseCheck::NotSyncing
        ));
        assert_eq!(w.store.writes(), writes);
        assert_eq!(ledger.updates.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_document_under_a_key_the_phrase_does_not_make_refuses_before_any_write() {
        let w = world().await;
        let ledger = w.ledger();
        let stranger = SyncKey::new("testnet", &w.me, 1, SecretBytes::new(h("random E"))).unwrap();
        w.store.add_key(&w.me, 1, stranger.public_key().to_vec());
        UserSync::new(&stranger, &w.store)
            .write_plain("odd", b"{}", None)
            .await
            .unwrap();
        let keys = ready(&w, &ledger).await;
        let writes = w.store.writes();
        assert!(move_key(&w.store, &ledger, &keys, Some(3)).await.is_err());
        assert_eq!(w.store.writes(), writes);
        assert_eq!(ledger.updates.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_move_interrupted_at_any_step_finishes_on_the_next_run() {
        let full = {
            let w = world().await;
            let start = w.store.writes();
            let ledger = w.ledger();
            let keys = ready(&w, &ledger).await;
            move_key(&w.store, &ledger, &keys, Some(3)).await.unwrap();
            w.store.writes() - start
        };
        assert_eq!(full, 5, "two slots, one created, one share, one grant");
        for cut in 0..full {
            let w = world().await;
            let before = w.plaintexts(&w.e0);
            let ledger = w.ledger();
            let keys = ready(&w, &ledger).await;
            w.store.fail_writes_after(Some(w.store.writes() + cut));
            assert!(
                move_key(&w.store, &ledger, &keys, Some(3)).await.is_err(),
                "cut {cut}"
            );
            w.store.fail_writes_after(None);
            // This device still holds key 3; the phrase now makes key 4 the current one.
            let keys = ready(&w, &ledger).await;
            let (key, moved) = move_key(&w.store, &ledger, &keys, Some(3)).await.unwrap();
            assert_eq!(key.key_id, 4, "cut {cut}");
            assert!(moved.disabled.is_empty(), "cut {cut}");
            assert_eq!(ledger.updates.load(Ordering::SeqCst), 1, "cut {cut}");
            assert_moved(&w, &before, 4).await;
        }
        // The update itself fails: nothing was written, and the next run starts over.
        let w = world().await;
        let before = w.plaintexts(&w.e0);
        let ledger = w.ledger();
        ledger.fail.store(true, Ordering::SeqCst);
        let writes = w.store.writes();
        let keys = ready(&w, &ledger).await;
        assert!(move_key(&w.store, &ledger, &keys, Some(3)).await.is_err());
        assert_eq!(w.store.writes(), writes);
        let (key, moved) = move_key(&w.store, &ledger, &keys, Some(3)).await.unwrap();
        assert_eq!((key.key_id, moved.disabled), (4, vec![3]));
        assert_moved(&w, &before, 4).await;
    }

    #[tokio::test]
    async fn a_grant_to_a_key_no_longer_live_is_dropped_and_the_epoch_passes_every_grant() {
        let w = world().await;
        let ledger = w.ledger();
        let mut g = w.store.grants_of_repo(&w.me, &w.repo).await.unwrap()[0].clone();
        // A grant ahead of the share (a later epoch an older run wrote).
        g.epoch = 6;
        w.store.put_grant(&g).await.unwrap();
        let keys = ready(&w, &ledger).await;
        move_key(&w.store, &ledger, &keys, Some(3)).await.unwrap();
        let share = w.store.share(&w.me, &w.repo).await.unwrap().unwrap();
        assert_eq!(share.epoch, 7);

        // The member's key goes; a second move drops the grant.
        w.store.disable_key(&w.member, 9);
        let keys = ready(&w, &ledger).await;
        let (key, moved) = move_key(&w.store, &ledger, &keys, Some(4)).await.unwrap();
        assert_eq!((key.key_id, moved.dropped, moved.grants), (5, 1, 0));
        assert!(w
            .store
            .grants_of_repo(&w.me, &w.repo)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            w.store.share(&w.me, &w.repo).await.unwrap().unwrap().epoch,
            8
        );
    }

    #[tokio::test]
    async fn a_lower_rotation_registered_again_is_moved_away_from_never_resealed_under() {
        let w = world().await;
        let before = w.plaintexts(&w.e0);
        let ledger = w.ledger();
        let keys = ready(&w, &ledger).await;
        move_key(&w.store, &ledger, &keys, Some(3)).await.unwrap();
        // Rotation 0 (the leaked key) is registered again under a newer id, and is now current.
        w.store.add_key(&w.me, 5, w.e0.public_key().to_vec());
        let keys = ready(&w, &ledger).await;
        assert_eq!(keys.current().key_id, 5);
        assert!(!keys.current_is_newest());
        let held = Some(5);
        let (key, moved) = move_key(&w.store, &ledger, &keys, held).await.unwrap();
        assert_eq!(key.key_id, 6);
        assert_eq!(moved.disabled, [4, 5]);
        assert_moved_to(&w, &before, 6, 2).await;
        let rot0 = SyncKey::new("testnet", &w.me, 5, w.e0.secret().clone()).unwrap();
        assert!(UserSync::new(&rot0, &w.store)
            .read_slot(SLOT_STORAGE)
            .await
            .is_err());
        // Even with a document still under rotation 1, the move never stops at rotation 0.
        let w = world().await;
        let before = w.plaintexts(&w.e0);
        let ledger = w.ledger();
        let keys = ready(&w, &ledger).await;
        w.store.fail_writes_after(Some(w.store.writes() + 1));
        assert!(move_key(&w.store, &ledger, &keys, Some(3)).await.is_err());
        w.store.fail_writes_after(None);
        w.store.add_key(&w.me, 5, w.e0.public_key().to_vec());
        let keys = ready(&w, &ledger).await;
        let (key, _) = move_key(&w.store, &ledger, &keys, Some(3)).await.unwrap();
        assert_eq!(key.key_id, 6);
        assert_moved_to(&w, &before, 6, 2).await;
    }

    #[tokio::test]
    async fn a_legacy_key_is_recognised_and_moves_to_rotation_1() {
        let w = world().await;
        let before = w.plaintexts(&w.e0);
        let legacy = seed(ABANDON)
            .legacy_sync_secret(
                false,
                w.e0.identity(),
                &crate::platform::decode_identifier(CONTRACT).unwrap(),
            )
            .unwrap();
        let old = SyncKey::new("testnet", &w.me, 3, legacy).unwrap();
        // An identity whose only sync key is the pre-rotation one, its slot sealed under it.
        let store = MemoryStore::new();
        store.add_key(&w.me, 3, old.public_key().to_vec());
        store.as_signer(&w.me);
        UserSync::new(&old, &store)
            .write_plain(SLOT_STORAGE, &before[SLOT_STORAGE], None)
            .await
            .unwrap();
        let legacy_ledger = Ledger {
            store: &store,
            fail: AtomicBool::new(false),
            lose_answer: AtomicBool::new(false),
            updates: AtomicU32::new(0),
            late_prefs: std::sync::Mutex::new(None),
            maintainers_of: std::sync::Mutex::new(None),
        };
        let PhraseCheck::Keys(keys) =
            phrase_keys(&legacy_ledger, &seed(ABANDON), "testnet", &w.me, CONTRACT)
                .await
                .unwrap()
        else {
            panic!("the legacy key is not recognised");
        };
        assert_eq!(add_key(&keys).secret().expose(), old.secret().expose());
        let (key, moved) = move_key(&store, &legacy_ledger, &keys, None).await.unwrap();
        assert_eq!((key.key_id, moved.disabled), (4, vec![3]));
        let rot1 = seed(ABANDON)
            .sync_secret(
                false,
                w.e0.identity(),
                &crate::platform::decode_identifier(CONTRACT).unwrap(),
                1,
            )
            .unwrap();
        assert_eq!(key.secret().expose(), rot1.expose());
        let read = UserSync::new(&key, &store)
            .read_slot(SLOT_STORAGE)
            .await
            .unwrap();
        assert!(read.is_some());
    }

    #[tokio::test]
    async fn a_key_read_that_fails_never_blocks_a_write() {
        let w = world().await;
        w.store.fail_key_reads(true);
        let mut change = SlotDoc::new(SLOT_STORAGE);
        change.set(
            "profile:more",
            super::super::now_ms(),
            json!({"settings": {}}),
        );
        UserSync::new(&w.e0, &w.store)
            .merge_into(SLOT_STORAGE, &change)
            .await
            .unwrap();
        assert!(require_current(&w.store, &w.e0).await.is_ok());
        w.store.fail_key_reads(false);
        assert!(require_current(&w.store, &w.e0).await.is_ok());
    }

    #[tokio::test]
    async fn an_error_before_any_write_says_nothing_started() {
        let w = world().await;
        let ledger = w.ledger();
        ledger.fail.store(true, Ordering::SeqCst);
        let keys = ready(&w, &ledger).await;
        let e = move_key(&w.store, &ledger, &keys, Some(3))
            .await
            .unwrap_err();
        assert!(!e.started);
        let keys = ready(&w, &ledger).await;
        w.store.fail_writes_after(Some(w.store.writes()));
        let e = move_key(&w.store, &ledger, &keys, Some(3))
            .await
            .unwrap_err();
        assert!(e.started);
    }

    #[tokio::test]
    async fn an_update_that_lands_without_an_answer_counts_as_started_and_finishes() {
        let w = world().await;
        let before = w.plaintexts(&w.e0);
        let ledger = w.ledger();
        ledger.lose_answer.store(true, Ordering::SeqCst);
        let writes = w.store.writes();
        let keys = ready(&w, &ledger).await;
        let e = move_key(&w.store, &ledger, &keys, Some(3))
            .await
            .unwrap_err();
        assert!(e.started, "a broadcast update may have landed");
        assert_eq!(w.store.writes(), writes);
        let keys = ready(&w, &ledger).await;
        let (key, moved) = move_key(&w.store, &ledger, &keys, Some(3)).await.unwrap();
        assert_eq!(key.key_id, 4);
        assert!(moved.disabled.is_empty());
        assert_eq!(ledger.updates.load(Ordering::SeqCst), 1);
        assert_moved(&w, &before, 4).await;
    }

    #[tokio::test]
    async fn a_next_key_already_on_the_identity_refuses_with_its_rotation() {
        let me = id("crowded");
        let identity = crate::platform::decode_identifier(&me).unwrap();
        let contract = crate::platform::decode_identifier(CONTRACT).unwrap();
        let public = |r| {
            let secret = seed(ABANDON)
                .sync_secret(false, &identity, &contract, r)
                .unwrap();
            crypto::public_key(&secret).unwrap().to_vec()
        };
        // Rotation 5 sits past the rotations derived (0 to 4), under a lower id than the current
        // key at rotation 4: a move would add rotation 5 again.
        let store = MemoryStore::new();
        store.add_key(&me, 1, public(5));
        store.add_key(&me, 2, public(4));
        let ledger = Ledger {
            store: &store,
            fail: AtomicBool::new(false),
            lose_answer: AtomicBool::new(false),
            updates: AtomicU32::new(0),
            late_prefs: std::sync::Mutex::new(None),
            maintainers_of: std::sync::Mutex::new(None),
        };
        let PhraseCheck::Keys(keys) =
            phrase_keys(&ledger, &seed(ABANDON), "testnet", &me, CONTRACT)
                .await
                .unwrap()
        else {
            panic!("expected keys");
        };
        // Adding the current key is still fine.
        assert_eq!(add_key(&keys).key_id, 2);
        let e = move_key(&store, &ledger, &keys, Some(2)).await.unwrap_err();
        assert!(!e.started);
        assert_eq!(e.error.to_string(), next_taken_line(5));
        assert_eq!(
            next_taken_line(5),
            "This identity already has the sync key a move would add (rotation 5). Nothing was changed."
        );
        assert_eq!(store.writes(), 0);
        assert_eq!(ledger.updates.load(Ordering::SeqCst), 0);
    }

    type Hook = std::sync::Mutex<Option<Box<dyn FnOnce(&MemoryStore) + Send>>>;

    /// A [`MemoryStore`] where something happens at one call: a move landing in between.
    struct Hooked<'a> {
        inner: &'a MemoryStore,
        on_share: Hook,
        on_put_state: Hook,
    }

    impl<'a> Hooked<'a> {
        fn new(inner: &'a MemoryStore) -> Self {
            Self {
                inner,
                on_share: std::sync::Mutex::new(None),
                on_put_state: std::sync::Mutex::new(None),
            }
        }
    }

    #[async_trait]
    impl UserStore for Hooked<'_> {
        async fn state(&self, owner: &str, slot: &str) -> Result<Option<StateDoc>> {
            self.inner.state(owner, slot).await
        }
        async fn states_of(&self, owner: &str) -> Result<Vec<StateDoc>> {
            self.inner.states_of(owner).await
        }
        async fn put_state(&self, doc: &StateDoc) -> Result<()> {
            let hook = self.on_put_state.lock().unwrap().take();
            if let Some(hook) = hook {
                hook(self.inner);
                return Err(Error::Platform("the node went away".into()));
            }
            self.inner.put_state(doc).await
        }
        async fn share(&self, owner: &str, repo: &str) -> Result<Option<ShareDoc>> {
            let hook = self.on_share.lock().unwrap().take();
            if let Some(hook) = hook {
                hook(self.inner);
            }
            self.inner.share(owner, repo).await
        }
        async fn shares_of(&self, owner: &str) -> Result<Vec<ShareDoc>> {
            self.inner.shares_of(owner).await
        }
        async fn put_share(&self, doc: &ShareDoc) -> Result<()> {
            self.inner.put_share(doc).await
        }
        async fn grants_of_repo(&self, owner: &str, repo: &str) -> Result<Vec<GrantDoc>> {
            self.inner.grants_of_repo(owner, repo).await
        }
        async fn grant(&self, owner: &str, repo: &str, member: &str) -> Result<Option<GrantDoc>> {
            self.inner.grant(owner, repo, member).await
        }
        async fn put_grant(&self, doc: &GrantDoc) -> Result<()> {
            self.inner.put_grant(doc).await
        }
        async fn delete_grant(&self, doc: &GrantDoc) -> Result<()> {
            self.inner.delete_grant(doc).await
        }
        async fn encryption_keys(&self, identity: &str) -> Result<Vec<super::super::EncKeyInfo>> {
            self.inner.encryption_keys(identity).await
        }
    }

    /// What a move's identity update does to the keys: key 4 (rotation 1) in, key 3 out.
    fn land_update(w: &World) -> impl FnOnce(&MemoryStore) + Send + 'static {
        let me = w.me.clone();
        let rot1 = crypto::public_key(
            &seed(ABANDON)
                .sync_secret(
                    false,
                    w.e0.identity(),
                    &crate::platform::decode_identifier(CONTRACT).unwrap(),
                    1,
                )
                .unwrap(),
        )
        .unwrap()
        .to_vec();
        move |store: &MemoryStore| {
            store.add_key(&me, 4, rot1);
            store.disable_key(&me, 3);
        }
    }

    #[tokio::test]
    async fn a_merge_retry_asks_again_whether_the_key_moved() {
        let w = world().await;
        let hooked = Hooked::new(&w.store);
        *hooked.on_put_state.lock().unwrap() = Some(Box::new(land_update(&w)));
        let mut change = SlotDoc::new(SLOT_PREFS);
        change.set("theme", super::super::now_ms(), json!("dark"));
        let writes = w.store.writes();
        let e = UserSync::new(&w.e0, &hooked)
            .merge_into(SLOT_PREFS, &change)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("moved to a new key"), "{e}");
        assert_eq!(w.store.writes(), writes);
        assert!(w.store.state(&w.me, SLOT_PREFS).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_reconcile_racing_a_move_never_overwrites_the_moved_share() {
        let w = world().await;
        let hooked = Hooked::new(&w.store);
        let land = land_update(&w);
        let (me, repo) = (w.me.clone(), w.repo.clone());
        // The move lands and rewrites the share after the reconcile's key check, before its read.
        *hooked.on_share.lock().unwrap() = Some(Box::new(move |store: &MemoryStore| {
            land(store);
            let mut moved = futures::executor::block_on(store.share(&me, &repo))
                .unwrap()
                .unwrap();
            moved.key_id = 4;
            moved.epoch += 1;
            futures::executor::block_on(store.put_share(&moved)).unwrap();
        }));
        let writes = w.store.writes();
        let maintainers: BTreeSet<String> = [w.member.clone()].into();
        let e = UserSync::new(&w.e0, &hooked)
            .reconcile_repo(&w.repo, Wanted::Content(&w.content), &maintainers)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("moved to a new key"), "{e}");
        assert_eq!(w.store.writes(), writes + 1, "only the move's own write");
        let share = w.store.share(&w.me, &w.repo).await.unwrap().unwrap();
        assert_eq!(share.key_id, 4);
    }

    #[tokio::test]
    async fn a_document_that_does_not_open_or_a_last_epoch_refuses_before_the_update() {
        let w = world().await;
        let ledger = w.ledger();
        let mut bad = w.store.state(&w.me, SLOT_STORAGE).await.unwrap().unwrap();
        bad.pieces[0][0] ^= 1;
        w.store.put_state(&bad).await.unwrap();
        let writes = w.store.writes();
        let keys = ready(&w, &ledger).await;
        let e = move_key(&w.store, &ledger, &keys, Some(3))
            .await
            .unwrap_err();
        assert!(!e.started);
        assert!(e.error.to_string().contains("don't open"), "{}", e.error);
        assert_eq!(
            (w.store.writes(), ledger.updates.load(Ordering::SeqCst)),
            (writes, 0)
        );

        let w = world().await;
        let ledger = w.ledger();
        let mut g = w.store.grants_of_repo(&w.me, &w.repo).await.unwrap()[0].clone();
        g.epoch = u32::MAX;
        w.store.put_grant(&g).await.unwrap();
        let writes = w.store.writes();
        let keys = ready(&w, &ledger).await;
        let e = move_key(&w.store, &ledger, &keys, Some(3))
            .await
            .unwrap_err();
        assert!(!e.started);
        assert_eq!(
            (w.store.writes(), ledger.updates.load(Ordering::SeqCst)),
            (writes, 0)
        );
    }

    #[tokio::test]
    async fn rotation_0_current_beside_a_live_legacy_key_moves_on_and_never_resumes() {
        let w = world().await;
        let contract = crate::platform::decode_identifier(CONTRACT).unwrap();
        let legacy = SyncKey::new(
            "testnet",
            &w.me,
            1,
            seed(ABANDON)
                .legacy_sync_secret(false, w.e0.identity(), &contract)
                .unwrap(),
        )
        .unwrap();
        let rot0 = SyncKey::new("testnet", &w.me, 2, w.e0.secret().clone()).unwrap();
        let store = MemoryStore::new();
        store.add_key(&w.me, 1, legacy.public_key().to_vec());
        store.add_key(&w.me, 2, rot0.public_key().to_vec());
        store.as_signer(&w.me);
        UserSync::new(&legacy, &store)
            .write_plain(SLOT_STORAGE, ZETA_STORAGE, None)
            .await
            .unwrap();
        let ledger = Ledger {
            store: &store,
            fail: AtomicBool::new(false),
            lose_answer: AtomicBool::new(false),
            updates: AtomicU32::new(0),
            late_prefs: std::sync::Mutex::new(None),
            maintainers_of: std::sync::Mutex::new(None),
        };
        let PhraseCheck::Keys(keys) =
            phrase_keys(&ledger, &seed(ABANDON), "testnet", &w.me, CONTRACT)
                .await
                .unwrap()
        else {
            panic!("expected keys");
        };
        assert_eq!(keys.current().key_id, 2);
        assert!(
            !keys.current_is_newest(),
            "rotation 0 never finishes a move"
        );
        // This device holds rotation 0 and a slot is still under the legacy key: before, that
        // finished "a move" under rotation 0 and left the legacy key live.
        let (key, moved) = move_key(&store, &ledger, &keys, Some(2)).await.unwrap();
        assert_eq!((key.key_id, moved.disabled), (3, vec![1, 2]));
        let rot1 = seed(ABANDON)
            .sync_secret(false, w.e0.identity(), &contract, 1)
            .unwrap();
        assert_eq!(key.secret().expose(), rot1.expose());
        let live = store.encryption_keys(&w.me).await.unwrap();
        assert_eq!(live.iter().map(|k| k.id).collect::<Vec<_>>(), [3]);
        let read = UserSync::new(&key, &store).read_slot(SLOT_STORAGE).await;
        assert!(read.unwrap().is_some());
        assert_eq!(ledger.updates.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_guarded_slot_an_old_client_wrote_during_the_move_is_resealed() {
        let w = world().await;
        let ledger = w.ledger();
        *ledger.late_prefs.lock().unwrap() = Some(w.e0.clone());
        let keys = ready(&w, &ledger).await;
        let (key, moved) = move_key(&w.store, &ledger, &keys, Some(3)).await.unwrap();
        assert!(moved.states.contains(&SLOT_PREFS.to_string()));
        assert!(moved.created.is_empty());
        let prefs = w.store.state(&w.me, SLOT_PREFS).await.unwrap().unwrap();
        assert_eq!(prefs.key_id, key.key_id);
        assert!(UserSync::new(&key, &w.store)
            .read_slot(SLOT_PREFS)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn a_grant_a_reconcile_revoked_part_way_is_never_restored_by_a_move() {
        let w = world().await;
        let bob = id("a removed maintainer");
        let e_bob = SyncKey::new("testnet", &bob, 5, SecretBytes::new(h("bob E"))).unwrap();
        w.store.add_key(&bob, 5, e_bob.public_key().to_vec());
        let owner = UserSync::new(&w.e0, &w.store);
        let both: BTreeSet<String> = [w.member.clone(), bob.clone()].into();
        owner
            .reconcile_repo(&w.repo, Wanted::Content(&w.content), &both)
            .await
            .unwrap();
        // Bob's removal stops after the share (epoch 1) and Alice's grant, before Bob's delete.
        w.store.fail_writes_after(Some(w.store.writes() + 2));
        let alice: BTreeSet<String> = [w.member.clone()].into();
        assert!(owner
            .reconcile_repo(&w.repo, Wanted::Content(&w.content), &alice)
            .await
            .is_err());
        w.store.fail_writes_after(None);
        let left = w.store.grant(&w.me, &w.repo, &bob).await.unwrap().unwrap();
        let before_move = w.store.share(&w.me, &w.repo).await.unwrap().unwrap();
        assert!(
            left.epoch < before_move.epoch,
            "Bob's revoked grant is still there"
        );

        // The move stops just after deleting Bob's grant (three slots, then the delete).
        let ledger = w.ledger();
        *ledger.maintainers_of.lock().unwrap() = Some(alice.clone());
        let keys = ready(&w, &ledger).await;
        w.store.fail_writes_after(Some(w.store.writes() + 4));
        let e = move_key(&w.store, &ledger, &keys, Some(3))
            .await
            .unwrap_err();
        assert!(e.started);
        w.store.fail_writes_after(None);
        assert!(w.store.grant(&w.me, &w.repo, &bob).await.unwrap().is_none());

        let keys = ready(&w, &ledger).await;
        let (key, moved) = move_key(&w.store, &ledger, &keys, Some(3)).await.unwrap();
        assert_eq!((key.key_id, moved.grants), (4, 1));
        let share = w.store.share(&w.me, &w.repo).await.unwrap().unwrap();
        assert_eq!((share.key_id, share.epoch), (4, before_move.epoch + 1));
        assert!(w.store.grant(&w.me, &w.repo, &bob).await.unwrap().is_none());
        assert!(UserSync::new(&e_bob, &w.store)
            .granted_share(&w.repo, &w.me)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            UserSync::new(&w.e_member, &w.store)
                .granted_share(&w.repo, &w.me)
                .await
                .unwrap()
                .as_ref(),
            Some(&w.content)
        );
    }

    #[tokio::test]
    async fn a_grant_to_someone_no_longer_a_maintainer_is_deleted_not_moved() {
        let w = world().await;
        let ledger = w.ledger();
        *ledger.maintainers_of.lock().unwrap() = Some(BTreeSet::new());
        let keys = ready(&w, &ledger).await;
        let (_, moved) = move_key(&w.store, &ledger, &keys, Some(3)).await.unwrap();
        assert_eq!((moved.grants, moved.dropped), (0, 1));
        assert!(w
            .store
            .grants_of_repo(&w.me, &w.repo)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn an_update_whose_answer_was_lost_is_finished_under_the_recorded_key() {
        let me = id("nothing synced yet");
        let identity = crate::platform::decode_identifier(&me).unwrap();
        let contract = crate::platform::decode_identifier(CONTRACT).unwrap();
        let rot0 = seed(ABANDON)
            .sync_secret(false, &identity, &contract, 0)
            .unwrap();
        let store = MemoryStore::new();
        store.add_key(&me, 3, crypto::public_key(&rot0).unwrap().to_vec());
        store.as_signer(&me);
        let ledger = Ledger {
            store: &store,
            fail: AtomicBool::new(false),
            lose_answer: AtomicBool::new(true),
            updates: AtomicU32::new(0),
            late_prefs: std::sync::Mutex::new(None),
            maintainers_of: std::sync::Mutex::new(None),
        };
        let keys_now = || async {
            match phrase_keys(&ledger, &seed(ABANDON), "testnet", &me, CONTRACT)
                .await
                .unwrap()
            {
                PhraseCheck::Keys(k) => k,
                other => panic!("expected keys, got {other:?}"),
            }
        };
        // A device that holds no key: it records the key it is about to register, then loses
        // the answer of an update that landed.
        let keys = keys_now().await;
        let (expected_id, pending) = keys.next_key().unwrap();
        assert_eq!(expected_id, 4);
        let e = move_key_with(&store, &ledger, &keys, None, Some(&pending))
            .await
            .unwrap_err();
        assert!(e.started);
        assert_eq!(store.writes(), 0);
        // The retry finishes under that key instead of registering another.
        let keys = keys_now().await;
        let (key, moved) = move_key_with(&store, &ledger, &keys, None, Some(&pending))
            .await
            .unwrap();
        assert_eq!(key.key_id, 4);
        assert!(moved.disabled.is_empty());
        assert_eq!(moved.created, ["storage", "prefs"]);
        assert_eq!(ledger.updates.load(Ordering::SeqCst), 1);
        // A later move goes on to the next rotation.
        let keys = keys_now().await;
        let (next, moved) = move_key(&store, &ledger, &keys, Some(4)).await.unwrap();
        assert_eq!((next.key_id, moved.disabled), (5, vec![4]));
        let rot2 = seed(ABANDON)
            .sync_secret(false, &identity, &contract, 2)
            .unwrap();
        assert_eq!(next.secret().expose(), rot2.expose());
    }
}
