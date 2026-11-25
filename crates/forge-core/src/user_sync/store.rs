//! Reading and writing forge-user documents: the [`UserStore`] port, with the Platform
//! implementation in [`super::platform`] and an in-memory one (`MemoryStore`) for tests.

#[cfg(test)]
use std::collections::BTreeMap;
#[cfg(test)]
use std::sync::Mutex;

use async_trait::async_trait;

#[cfg(test)]
use crate::error::Error;
use crate::error::Result;

/// A `state` document.
#[derive(Clone, PartialEq, Eq)]
pub struct StateDoc {
    /// The document id (`None` before it is created).
    pub id: Option<String>,
    /// `$ownerId` (base58).
    pub owner_id: String,
    /// `$revision`, for a guarded replace.
    pub revision: Option<u64>,
    /// `slot`.
    pub slot: String,
    /// `v`.
    pub v: u8,
    /// `keyId`.
    pub key_id: u32,
    /// `n`.
    pub nonce: [u8; 12],
    /// `d0`, `d1`, `d2`.
    pub pieces: Vec<Vec<u8>>,
}

/// A `share` document.
#[derive(Clone, PartialEq, Eq)]
pub struct ShareDoc {
    /// The document id.
    pub id: Option<String>,
    /// `$ownerId`: the repository's owner.
    pub owner_id: String,
    /// `$revision`.
    pub revision: Option<u64>,
    /// `repoId` (base58).
    pub repo_id: String,
    /// `epoch`.
    pub epoch: u32,
    /// `keyId`: the owner's encryption key the RSK was derived with.
    pub key_id: u32,
    /// `n`.
    pub nonce: [u8; 12],
    /// `d0`, `d1`.
    pub pieces: Vec<Vec<u8>>,
}

/// A `grant` document.
#[derive(Clone, PartialEq, Eq)]
pub struct GrantDoc {
    /// The document id.
    pub id: Option<String>,
    /// `$ownerId`: the repository's owner.
    pub owner_id: String,
    /// `$revision`.
    pub revision: Option<u64>,
    /// `repoId` (base58).
    pub repo_id: String,
    /// `memberId` (base58).
    pub member_id: String,
    /// `epoch`.
    pub epoch: u32,
    /// `senderKeyId`: the owner's key.
    pub sender_key_id: u32,
    /// `recipientKeyId`: the member's key.
    pub recipient_key_id: u32,
    /// `wrapped`.
    pub wrapped: Vec<u8>,
}

macro_rules! redacted_debug {
    ($t:ty, $($f:ident),*) => {
        impl std::fmt::Debug for $t {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.debug_struct(stringify!($t))
                    $(.field(stringify!($f), &self.$f))*
                    .finish_non_exhaustive()
            }
        }
    };
}
redacted_debug!(StateDoc, id, owner_id, slot, key_id);
redacted_debug!(ShareDoc, id, owner_id, repo_id, epoch, key_id);
redacted_debug!(GrantDoc, id, owner_id, repo_id, member_id, epoch);

/// An identity's live forge-user encryption key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncKeyInfo {
    /// Its id on the identity.
    pub id: u32,
    /// The 33-byte compressed public key.
    pub public_key: Vec<u8>,
}

/// The forge-user documents, as a client reads and writes them. Every write is the signer's
/// own; a reader checks `$ownerId` itself.
#[async_trait]
pub trait UserStore: Send + Sync {
    /// `owner`'s `state` document for `slot`.
    async fn state(&self, owner: &str, slot: &str) -> Result<Option<StateDoc>>;
    /// Create (no `id`) or replace (guarded by `revision`) the signer's `state`.
    async fn put_state(&self, doc: &StateDoc) -> Result<()>;
    /// `owner`'s `share` for `repo`.
    async fn share(&self, owner: &str, repo: &str) -> Result<Option<ShareDoc>>;
    /// Create or replace the signer's `share`.
    async fn put_share(&self, doc: &ShareDoc) -> Result<()>;
    /// Every `grant` `owner` wrote for `repo`.
    async fn grants_of_repo(&self, owner: &str, repo: &str) -> Result<Vec<GrantDoc>>;
    /// `owner`'s `grant` to `member` for `repo` (the unique `byMember` index).
    async fn grant(&self, owner: &str, repo: &str, member: &str) -> Result<Option<GrantDoc>>;
    /// Create or replace the signer's `grant`.
    async fn put_grant(&self, doc: &GrantDoc) -> Result<()>;
    /// Delete the signer's `grant`.
    async fn delete_grant(&self, doc: &GrantDoc) -> Result<()>;
    /// `identity`'s live forge-user ENCRYPTION keys, oldest first (one identity read).
    async fn encryption_keys(&self, identity: &str) -> Result<Vec<EncKeyInfo>>;
}

/// An in-memory [`UserStore`] playing one signer at a time (`MemoryStore::as_signer`), which
/// enforces Platform's owner rule and the unique indexes.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    inner: Mutex<Memory>,
}

#[cfg(test)]
#[derive(Default)]
struct Memory {
    signer: String,
    next: u64,
    states: BTreeMap<String, StateDoc>,
    shares: BTreeMap<String, ShareDoc>,
    grants: BTreeMap<String, GrantDoc>,
    keys: BTreeMap<String, Vec<EncKeyInfo>>,
    writes: u64,
    fail_share_write: bool,
}

#[cfg(test)]
impl MemoryStore {
    /// An empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Make `identity` the signer of the writes that follow.
    pub fn as_signer(&self, identity: &str) {
        self.inner.lock().expect("store lock").signer = identity.to_string();
    }

    /// Register `identity`'s forge-user encryption key.
    pub fn add_key(&self, identity: &str, id: u32, public_key: Vec<u8>) {
        self.inner
            .lock()
            .expect("store lock")
            .keys
            .entry(identity.to_string())
            .or_default()
            .push(EncKeyInfo { id, public_key });
    }

    /// Make the next share write fail (an interrupted run).
    pub fn fail_next_share_write(&self) {
        self.inner.lock().expect("store lock").fail_share_write = true;
    }

    /// Disable `identity`'s key `id` (it no longer counts as live).
    pub fn disable_key(&self, identity: &str, id: u32) {
        if let Some(keys) = self
            .inner
            .lock()
            .expect("store lock")
            .keys
            .get_mut(identity)
        {
            keys.retain(|k| k.id != id);
        }
    }

    /// How many documents were written (created, replaced or deleted).
    pub fn writes(&self) -> u64 {
        self.inner.lock().expect("store lock").writes
    }

    /// Every grant stored.
    pub fn all_grants(&self) -> Vec<GrantDoc> {
        self.inner
            .lock()
            .expect("store lock")
            .grants
            .values()
            .cloned()
            .collect()
    }
}

#[cfg(test)]
fn not_owner() -> Error {
    Error::Platform("only the owner of a document can change it".into())
}

#[cfg(test)]
impl Memory {
    fn id(&mut self) -> String {
        self.next += 1;
        format!("doc{}", self.next)
    }

    /// Platform's rules for a create (`id` `None`) or replace of the signer's document, given
    /// the one stored under the same unique index: its new id.
    fn admit(
        &mut self,
        owner: &str,
        id: Option<&String>,
        revision: Option<u64>,
        stored: Option<(Option<String>, Option<u64>)>,
    ) -> Result<String> {
        if owner != self.signer {
            return Err(not_owner());
        }
        match (id, stored) {
            (None, None) => Ok(self.id()),
            (None, Some(_)) => Err(Error::DuplicateUniqueIndex("forge-user".into())),
            (Some(_), None) => Err(Error::NotFound),
            (Some(a), Some((b, rev))) => {
                if Some(a) != b.as_ref() {
                    return Err(Error::DuplicateUniqueIndex("forge-user".into()));
                }
                if revision != rev {
                    return Err(Error::Platform(
                        "the document changed since it was read".into(),
                    ));
                }
                Ok(a.clone())
            }
        }
    }
}

#[cfg(test)]
#[async_trait]
impl UserStore for MemoryStore {
    async fn state(&self, owner: &str, slot: &str) -> Result<Option<StateDoc>> {
        let m = self.inner.lock().expect("store lock");
        Ok(m.states
            .values()
            .find(|d| d.owner_id == owner && d.slot == slot)
            .cloned())
    }

    async fn put_state(&self, doc: &StateDoc) -> Result<()> {
        let mut m = self.inner.lock().expect("store lock");
        let existing = m
            .states
            .values()
            .find(|d| d.owner_id == doc.owner_id && d.slot == doc.slot)
            .cloned();
        let id = m.admit(
            &doc.owner_id,
            doc.id.as_ref(),
            doc.revision,
            existing.map(|d| (d.id, d.revision)),
        )?;
        let mut stored = doc.clone();
        stored.id = Some(id);
        stored.revision = Some(doc.revision.map_or(1, |r| r + 1));
        m.writes += 1;
        m.states.insert(stored.id.clone().expect("id"), stored);
        Ok(())
    }

    async fn share(&self, owner: &str, repo: &str) -> Result<Option<ShareDoc>> {
        let m = self.inner.lock().expect("store lock");
        Ok(m.shares
            .values()
            .find(|d| d.owner_id == owner && d.repo_id == repo)
            .cloned())
    }

    async fn put_share(&self, doc: &ShareDoc) -> Result<()> {
        let mut m = self.inner.lock().expect("store lock");
        if std::mem::take(&mut m.fail_share_write) {
            return Err(Error::Platform("the node went away".into()));
        }
        let existing = m
            .shares
            .values()
            .find(|d| d.owner_id == doc.owner_id && d.repo_id == doc.repo_id)
            .cloned();
        let id = m.admit(
            &doc.owner_id,
            doc.id.as_ref(),
            doc.revision,
            existing.map(|d| (d.id, d.revision)),
        )?;
        let mut stored = doc.clone();
        stored.id = Some(id);
        stored.revision = Some(doc.revision.map_or(1, |r| r + 1));
        m.writes += 1;
        m.shares.insert(stored.id.clone().expect("id"), stored);
        Ok(())
    }

    async fn grants_of_repo(&self, owner: &str, repo: &str) -> Result<Vec<GrantDoc>> {
        let m = self.inner.lock().expect("store lock");
        Ok(m.grants
            .values()
            .filter(|d| d.owner_id == owner && d.repo_id == repo)
            .cloned()
            .collect())
    }

    async fn grant(&self, owner: &str, repo: &str, member: &str) -> Result<Option<GrantDoc>> {
        let m = self.inner.lock().expect("store lock");
        Ok(m.grants
            .values()
            .find(|d| d.owner_id == owner && d.repo_id == repo && d.member_id == member)
            .cloned())
    }

    async fn put_grant(&self, doc: &GrantDoc) -> Result<()> {
        let mut m = self.inner.lock().expect("store lock");
        let existing = m
            .grants
            .values()
            .find(|d| {
                d.owner_id == doc.owner_id
                    && d.repo_id == doc.repo_id
                    && d.member_id == doc.member_id
            })
            .cloned();
        let id = m.admit(
            &doc.owner_id,
            doc.id.as_ref(),
            doc.revision,
            existing.map(|d| (d.id, d.revision)),
        )?;
        let mut stored = doc.clone();
        stored.id = Some(id);
        stored.revision = Some(doc.revision.map_or(1, |r| r + 1));
        m.writes += 1;
        m.grants.insert(stored.id.clone().expect("id"), stored);
        Ok(())
    }

    async fn delete_grant(&self, doc: &GrantDoc) -> Result<()> {
        let mut m = self.inner.lock().expect("store lock");
        let id = doc.id.clone().ok_or(Error::NotFound)?;
        let owner = m
            .grants
            .get(&id)
            .map(|d| d.owner_id.clone())
            .ok_or(Error::NotFound)?;
        if owner != m.signer {
            return Err(not_owner());
        }
        m.writes += 1;
        m.grants.remove(&id);
        Ok(())
    }

    async fn encryption_keys(&self, identity: &str) -> Result<Vec<EncKeyInfo>> {
        let m = self.inner.lock().expect("store lock");
        let mut keys = m.keys.get(identity).cloned().unwrap_or_default();
        keys.sort_by_key(|k| k.id);
        Ok(keys)
    }
}
