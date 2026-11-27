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

use std::collections::BTreeMap;

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
    /// read-only, and disable key `disable` in the same transition. The new key's id, once a
    /// read shows it on the identity.
    async fn add_and_disable(
        &self,
        identity: &str,
        secret: &SecretBytes,
        disable: u32,
    ) -> Result<u32>;
}

/// The identity's forge-user keys as the recovery phrase makes them.
pub struct PhraseKeys {
    network: String,
    identity_id: String,
    current: u32,
    keys: BTreeMap<u32, SyncKey>,
    next: SecretBytes,
}

impl std::fmt::Debug for PhraseKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PhraseKeys")
            .field("identity_id", &self.identity_id)
            .field("current", &self.current)
            .field("keys", &self.keys.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl PhraseKeys {
    /// The identity's current (highest-id live) forge-user key.
    pub fn current(&self) -> &SyncKey {
        &self.keys[&self.current]
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

/// Derive rotations `0..=n` (`n` = the number of forge-user keys + 2, at least 4) and match them
/// to `identity_id`'s forge-user keys. `network` is Forge's network key (coin type 5 only on
/// `mainnet`); `contract_id` is forge-user's. Reads the identity once and writes nothing.
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
    let mut highest = None;
    for rotation in 0..=n {
        let secret = seed.sync_secret(mainnet, &identity, &contract, rotation)?;
        let public = crypto::public_key(&secret)?;
        for k in all.iter().filter(|k| k.public_key == public) {
            keys.insert(
                k.id,
                SyncKey::new(network, identity_id, k.id, secret.clone())?,
            );
            highest = highest.max(Some(rotation));
        }
    }
    if !keys.contains_key(&current) {
        return Ok(PhraseCheck::NotThisPhrase);
    }
    let next_rotation = highest
        .and_then(|r: u32| r.checked_add(1))
        .ok_or(Error::Integrity)?;
    let next = seed.sync_secret(mainnet, &identity, &contract, next_rotation)?;
    let next_public = crypto::public_key(&next)?;
    if all.iter().any(|k| k.public_key == next_public) {
        return Err(Error::Integrity);
    }
    Ok(PhraseCheck::Keys(PhraseKeys {
        network: network.to_string(),
        identity_id: identity_id.to_string(),
        current,
        keys,
        next,
    }))
}

/// What a move did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Moved {
    /// The key sync is under now.
    pub key_id: u32,
    /// The key this run disabled (`None`: an earlier run, or another device, already moved).
    pub disabled: Option<u32>,
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

struct Plan {
    states: Vec<StateDoc>,
    shares: Vec<(ShareDoc, Vec<GrantDoc>)>,
}

impl Plan {
    async fn read(store: &dyn UserStore, keys: &PhraseKeys) -> Result<Self> {
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
        for (s, _) in &shares {
            if !keys.keys.contains_key(&s.key_id) {
                return Err(unknown_key("shared storage of a repository", s.key_id));
            }
        }
        Ok(Self { states, shares })
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
/// When every document is already under the current key and the current key is the one this
/// device holds (or it holds none), the next rotation's key is added and the current one
/// disabled in one update; otherwise no update is sent and only what is still behind is
/// re-sealed under the current key. Then: every `state` slot, read with the key its `keyId`
/// names, is written again under the new key with the same plaintext and read back; missing
/// [`GUARDED_SLOTS`] are created empty; every share moves to an epoch above it and every grant
/// of it, then each grant is rewritten (a grant whose recipient key is no longer live is
/// deleted). Returns the new key and what was written.
pub async fn move_key(
    store: &dyn UserStore,
    ledger: &dyn KeyLedger,
    keys: &PhraseKeys,
    held: Option<u32>,
) -> Result<(SyncKey, Moved)> {
    let plan = Plan::read(store, keys).await?;
    let current = keys.current();
    let start_over = !plan.behind(current.key_id) && held.is_none_or(|h| h == current.key_id);
    let mut out = Moved::default();
    let target = if start_over {
        let id = ledger
            .add_and_disable(&keys.identity_id, &keys.next, current.key_id)
            .await?;
        out.disabled = Some(current.key_id);
        SyncKey::new(&keys.network, &keys.identity_id, id, keys.next.clone())?
    } else {
        current.clone()
    };
    out.key_id = target.key_id;
    let sync = UserSync::new(&target, store);
    for s in &plan.states {
        if s.key_id == target.key_id {
            continue;
        }
        reseal_state(&sync, &keys.keys[&s.key_id], s).await?;
        out.states.push(s.slot.clone());
    }
    for slot in GUARDED_SLOTS {
        if plan.states.iter().any(|s| s.slot == slot)
            || store.state(&target.identity_id, slot).await?.is_some()
        {
            continue;
        }
        let empty = SlotDoc::new(slot).to_json()?;
        sync.write_plain(slot, &empty, None).await?;
        out.created.push(slot.to_string());
    }
    for (share, grants) in &plan.shares {
        let (written, rewritten, dropped) =
            move_share(&sync, &keys.keys[&share.key_id], share, grants).await?;
        if written {
            out.shares.push(share.repo_id.clone());
        }
        out.grants += rewritten;
        out.dropped += dropped;
    }
    Ok((target, out))
}

/// The identity's current sync key, for a device that does not hold it (spec §B').
pub fn add_key(keys: &PhraseKeys) -> SyncKey {
    keys.current().clone()
}

async fn reseal_state(sync: &UserSync<'_>, old: &SyncKey, s: &StateDoc) -> Result<()> {
    let plain = crypto::open_state(
        old.secret(),
        &old.network,
        old.identity(),
        &s.slot,
        s.v,
        s.key_id,
        &s.nonce,
        &s.pieces,
    )?;
    sync.write_plain(&s.slot, &plain, Some(s)).await
}

/// Move one share to `sync`'s key (unless it already is) and rewrite its grants: whether the
/// share was written, the grants rewritten and the grants deleted.
async fn move_share(
    sync: &UserSync<'_>,
    old: &SyncKey,
    share: &ShareDoc,
    grants: &[GrantDoc],
) -> Result<(bool, usize, usize)> {
    let key = sync.key;
    let repo = crate::platform::decode_identifier(&share.repo_id)?;
    let (epoch, written) = if share.key_id == key.key_id {
        (share.epoch, false)
    } else {
        let aad = crypto::share_aad(&old.network, &repo, share.epoch, share.key_id)?;
        let rsk = crypto::repo_storage_key(old.secret(), &repo, &old.network, share.epoch);
        let sealed = crypto::open(&rsk, &share.nonce, &share.pieces.concat(), &aad)?;
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
    };
    let rsk = sync.rsk(&repo, epoch);
    let (mut rewritten, mut dropped) = (0, 0);
    for g in grants {
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
pub async fn require_current(store: &dyn UserStore, key: &SyncKey) -> Result<()> {
    match standing(store, key).await? {
        KeyStanding::Current => Ok(()),
        KeyStanding::Moved => Err(Error::InvalidInput(KEY_MOVED.into())),
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
        updates: AtomicU32,
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
            disable: u32,
        ) -> Result<u32> {
            if self.fail.swap(false, Ordering::SeqCst) {
                return Err(Error::Platform("no answer".into()));
            }
            let next = self
                .store
                .all_keys(identity)
                .iter()
                .map(|(k, _)| k.id + 1)
                .max()
                .unwrap_or(0);
            self.store
                .add_key(identity, next, crypto::public_key(secret)?.to_vec());
            self.store.disable_key(identity, disable);
            self.updates.fetch_add(1, Ordering::SeqCst);
            Ok(next)
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
                updates: AtomicU32::new(0),
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
                    1,
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
        assert_eq!(moved.disabled, Some(3));
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
        assert_eq!((again.key_id, moved.disabled), (4, None));
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
            assert_eq!((key.key_id, moved.disabled), (4, None), "cut {cut}");
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
        assert_eq!((key.key_id, moved.disabled), (4, Some(3)));
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
}
