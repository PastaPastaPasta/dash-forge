//! A private repository's keys on Platform: the documents behind [`crate::private`]'s pure
//! epoch rules (`docs/security/private-repos.md` §5), read, resolved and written.
//!
//! * [`Keyring::load`] reads the repository's current membership, every `config` and every
//!   `repoKey` (all proof-verified, complete), unwraps the reader's own wraps with the identity
//!   file's `ENCRYPTION` key, and runs [`resolve_epochs`]: the epochs that exist, the one to
//!   write under, the keys the reader holds (wraps plus the `prevEpochKey` chain), the alerts,
//!   and the repair check. It is loaded again **before every write** (§5.3, M2): a rotation
//!   that landed since the last read is picked up, and nothing is written under a superseded
//!   epoch by an honest client.
//! * [`Keyring::open`] is `open_content` (§8.1) for a fetched document: the AD's bind fields,
//!   `$createdAtBlockHeight` and the late-content rule come from the document itself.
//! * The writes: [`create_private_state`] (epoch 0 on a new repo: self-wrap, then the anchor),
//!   [`add_member_wrap`], [`rotate`] (§5.5: wraps for `n+1` to every remaining member, self
//!   first, then the anchor, then the "am I first" check) and [`repair`] (§5.6).
//!
//! No epoch key is ever written to disk. A rotation that dies between its wraps and its anchor
//! is resumed from the chain: the rotator's own self-wrap for the unanchored epoch *is* the
//! journal (it is posted first), and unwrapping it recovers the key.

use std::collections::{BTreeMap, BTreeSet};

use crate::envelope::{self, PrivateKey};
use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::members::{Member, MemberReader};
use crate::platform::wrap::{open_wrap, seal_wrap, WrapParties, WrapSecret};
use crate::platform::{
    self, FetchedDocument, FieldValue, IdentityKeyInfo, LoadedContract, LoadedIdentity,
    PlatformClient, QueryOrder, WriteEngine,
};
use crate::private::epoch::{ConfigRow, MemberRow, WrapRow};
use crate::private::{
    open_content, resolve_epochs, Alert, DocHeader, EpochKey, EpochKeys, EpochResolution, Fields,
    OpenContext, Opened, Private, Unreadable,
};
use crate::private::{DocKind, PrivateError};
use crate::rules::v2::Role;
use crate::scope::{DocScope, RepoRef};
use crate::user_error::{codes, UserError};

/// The `repoKey` document type.
pub const DOC_REPO_KEY: &str = "repoKey";
/// The repository `config` document type.
const DOC_CONFIG: &str = crate::refs::DOC_CONFIG;
/// How many proved reads [`rotate`] makes while it waits to see its own anchor, and the pause.
const ANCHOR_POLLS: usize = 20;
const ANCHOR_POLL_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);

/// The fix every "no encryption key" error carries.
pub const FIX_ADD_ENCRYPTION_KEY: &str = "dg auth keys add --encryption";

/// The reader's own `ENCRYPTION` keys: the identity file's private keys whose public key is an
/// `ENCRYPTION` key of the identity on chain (enabled or not: a wrap to a since-disabled key
/// still opens history, §5.4 (1)), and which of them is usable to *send* with (enabled).
pub struct EncryptionKeys {
    /// key id → (private key, enabled on chain).
    keys: BTreeMap<u32, (PrivateKey, bool)>,
}

impl std::fmt::Debug for EncryptionKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EncryptionKeys")
            .field("ids", &self.keys.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl EncryptionKeys {
    /// The identity file's `ENCRYPTION` keys that match one of `on_chain`'s `ENCRYPTION` keys
    /// (bound to `core` or unbound).
    pub fn held(bridge: &BridgeIdentity, on_chain: &[IdentityKeyInfo], core: &str) -> Self {
        let keys = envelope::encryption_keys(bridge)
            .into_iter()
            .filter_map(|(id, private)| {
                let k = on_chain.iter().find(|k| {
                    k.id == id
                        && k.purpose == "ENCRYPTION"
                        && k.key_type == "ECDSA_SECP256K1"
                        && k.bound_to.as_deref().is_none_or(|b| b == core)
                        && k.public_key.as_slice() == private.public_key().as_slice()
                })?;
                Some((id, (private, !k.disabled)))
            })
            .collect();
        Self { keys }
    }

    /// The highest-id **enabled** key: the one to wrap from (`senderKeyId`) and to wrap to
    /// oneself.
    pub fn sender(&self) -> Option<(u32, &PrivateKey)> {
        self.keys
            .iter()
            .rev()
            .find(|(_, (_, enabled))| *enabled)
            .map(|(id, (k, _))| (*id, k))
    }

    /// The private key with `id`, enabled or not.
    fn get(&self, id: u32) -> Option<&PrivateKey> {
        self.keys.get(&id).map(|(k, _)| k)
    }

    /// Whether the file holds none.
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

/// E305: the identity has no usable `ENCRYPTION` key in its file.
pub fn no_encryption_key(who: &str, action: &str) -> Error {
    UserError::new(
        codes::NO_ENCRYPTION_KEY,
        format!("{action}: {who} has no encryption key"),
    )
    .cause("private repositories encrypt their content to each member's identity ENCRYPTION key, and the identity file in use holds none that matches an enabled key on the identity")
    .fix(FIX_ADD_ENCRYPTION_KEY)
    .note("adding one is a single identity update signed by the master key")
    .into()
}

/// A member's highest-id enabled `ENCRYPTION` key (`ECDSA_SECP256K1`, unbound or bound to
/// `core`): the recipient of every wrap to them (§5.2).
pub fn recipient_key<'k>(keys: &'k [IdentityKeyInfo], core: &str) -> Option<&'k IdentityKeyInfo> {
    keys.iter()
        .filter(|k| k.is_usable_encryption_key(core))
        .max_by_key(|k| k.id)
}

/// A `repoKey` document, flattened.
#[derive(Debug, Clone)]
struct WrapDoc {
    id: [u8; 32],
    owner: [u8; 32],
    member: [u8; 32],
    epoch: u32,
    recipient_key_id: u32,
    sender_key_id: u32,
    wrapped: Vec<u8>,
    height: u64,
}

impl WrapDoc {
    fn from_doc(d: &FetchedDocument) -> Option<Self> {
        Some(Self {
            id: platform::decode_identifier(&d.id).ok()?,
            owner: platform::decode_identifier(&d.owner_id).ok()?,
            member: d.field_bytes32("memberId")?,
            epoch: u32::try_from(d.field_u64("epoch")?).ok()?,
            recipient_key_id: u32::try_from(d.field_u64("recipientKeyId")?).ok()?,
            sender_key_id: u32::try_from(d.field_u64("senderKeyId")?).ok()?,
            wrapped: d.field_bytes("wrapped")?,
            height: d.created_at_block_height.unwrap_or(0),
        })
    }
}

/// A `config` document of a private repository, flattened.
fn config_row(d: &FetchedDocument) -> Option<ConfigRow> {
    Some(ConfigRow {
        id: platform::decode_identifier(&d.id).ok()?,
        owner: platform::decode_identifier(&d.owner_id).ok()?,
        epoch: u32::try_from(d.field_u64("epoch")?).ok()?,
        created_at_block_height: d.created_at_block_height?,
        created_at: d.created_at.unwrap_or(0),
        enc: d.field_bytes("enc").filter(|e| !e.is_empty())?,
    })
}

/// The decrypted state of a private repository's `config` timeline, for the ref rules.
#[derive(Debug, Clone, Default)]
pub struct PrivateConfig {
    /// The newest readable config's default branch (short name: `main`).
    pub default_branch: Option<String>,
    /// Every readable config as the ref rules take it (`$createdAt`, `$id`, patterns).
    pub history: Vec<crate::rules::ConfigDoc>,
    /// The newest readable config's protected patterns.
    pub protected_patterns: Vec<String>,
    /// The newest config's plaintext `backend` (mode, uris), carried into a rotation anchor.
    pub backend: Option<FieldValue>,
    /// The newest config's `archived` flag.
    pub archived: bool,
}

/// A private repository's keys, as one reader sees them now.
pub struct Keyring {
    repo_id: [u8; 32],
    reader: [u8; 32],
    members: Vec<Member>,
    configs: Vec<FetchedDocument>,
    wraps: Vec<WrapDoc>,
    resolution: EpochResolution,
    ctx: OpenContext,
    /// Wraps this reader could not open, by epoch (for `dg repo keys status`).
    unreadable_wraps: Vec<u32>,
}

impl std::fmt::Debug for Keyring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keyring")
            .field("resolution", &self.resolution)
            .finish_non_exhaustive()
    }
}

/// Everything [`Keyring::load`] reads, so a write path can re-use the contract.
pub struct KeyringIo<'a> {
    /// The connection.
    pub client: &'a PlatformClient,
    /// forge-core, fetched.
    pub core: &'a LoadedContract,
    /// The repository's scope.
    pub scope: &'a DocScope,
}

impl Keyring {
    /// Read and resolve the keys of `repo` for the identity `reader`, unwrapping its own wraps
    /// with `enc` (its file's `ENCRYPTION` keys). A reader with no keys still loads: it can
    /// see epochs, members and alerts, and every open is `Unreadable(NoKey)`.
    pub async fn load(
        client: &PlatformClient,
        repo: &RepoRef,
        reader: &str,
        enc: &EncryptionKeys,
    ) -> Result<Self> {
        let scope = repo.scope()?;
        let core = client.fetch_contract(&scope.contract_id).await?;
        Self::load_with(
            &KeyringIo {
                client,
                core: &core,
                scope: &scope,
            },
            repo,
            reader,
            enc,
        )
        .await
    }

    /// [`Self::load`] with an already fetched contract and scope.
    pub async fn load_with(
        io: &KeyringIo<'_>,
        repo: &RepoRef,
        reader: &str,
        enc: &EncryptionKeys,
    ) -> Result<Self> {
        let reader_bytes = platform::decode_identifier(reader)?;
        let members = MemberReader::new(io.client).list(repo).await?;
        let configs = io
            .client
            .query_all_documents(
                io.core,
                DOC_CONFIG,
                &io.scope.filters([]),
                &[QueryOrder::asc("$createdAt")],
            )
            .await?;
        let wraps: Vec<WrapDoc> = io
            .client
            .query_all_documents(
                io.core,
                DOC_REPO_KEY,
                &io.scope.filters([]),
                &[QueryOrder::asc("memberId")],
            )
            .await?
            .iter()
            .filter_map(WrapDoc::from_doc)
            .collect();
        let mut keyring = Self {
            repo_id: io.scope.repo_id,
            reader: reader_bytes,
            members,
            configs,
            wraps,
            resolution: EpochResolution::default(),
            ctx: OpenContext::default(),
            unreadable_wraps: Vec::new(),
        };
        keyring.resolve(io, enc).await?;
        Ok(keyring)
    }

    async fn resolve(&mut self, io: &KeyringIo<'_>, enc: &EncryptionKeys) -> Result<()> {
        // Which identities' keys are enabled now (for §5.6's "wrap to an enabled key"), and the
        // sender public keys our own wraps need. One identity fetch per distinct party.
        let mut parties: BTreeSet<[u8; 32]> = self.wraps.iter().map(|w| w.member).collect();
        parties.extend(
            self.wraps
                .iter()
                .filter(|w| w.member == self.reader)
                .map(|w| w.owner),
        );
        let mut keys_of: BTreeMap<[u8; 32], Vec<IdentityKeyInfo>> = BTreeMap::new();
        for p in parties {
            match io
                .client
                .fetch_identity(&platform::encode_identifier(p))
                .await
            {
                Ok(identity) => {
                    keys_of.insert(p, identity.public_keys());
                }
                Err(Error::NotFound) => {}
                Err(e) => return Err(e),
            }
        }
        let enabled = |who: &[u8; 32], id: u32| {
            keys_of
                .get(who)
                .and_then(|ks| ks.iter().find(|k| k.id == id))
                .is_some_and(|k| !k.disabled && k.purpose == "ENCRYPTION")
        };

        let mut rows = Vec::with_capacity(self.wraps.len());
        let mut unreadable = Vec::new();
        for w in &self.wraps {
            let key = if w.member == self.reader {
                let got = self.unwrap_own(io.core, w, enc, &keys_of);
                if got.is_none() {
                    unreadable.push(w.epoch);
                }
                got
            } else {
                None
            };
            rows.push(WrapRow {
                id: w.id,
                owner: w.owner,
                member_id: w.member,
                epoch: w.epoch,
                recipient_key_id: w.recipient_key_id,
                key_enabled: enabled(&w.member, w.recipient_key_id),
                key,
            });
        }
        let memberships: Vec<MemberRow> = self
            .members
            .iter()
            .filter_map(|m| {
                Some(MemberRow {
                    identity: platform::decode_identifier(&m.identity_id).ok()?,
                    role: m.role,
                    created_at: m.created_at,
                })
            })
            .collect();
        let configs: Vec<ConfigRow> = self.configs.iter().filter_map(config_row).collect();
        self.resolution =
            resolve_epochs(&self.repo_id, &self.reader, &memberships, &configs, &rows);
        self.ctx = self.resolution.open_context(&self.repo_id);
        unreadable.sort_unstable();
        unreadable.dedup();
        self.unreadable_wraps = unreadable;
        Ok(())
    }

    /// The key in one of the reader's own wraps: the reader's private key named by
    /// `recipientKeyId`, and the sender's public key named by `senderKeyId`. `None` when either
    /// is missing or the wrap does not open (version / KCV, §5.4 (4)).
    fn unwrap_own(
        &self,
        core: &LoadedContract,
        w: &WrapDoc,
        enc: &EncryptionKeys,
        keys_of: &BTreeMap<[u8; 32], Vec<IdentityKeyInfo>>,
    ) -> Option<EpochKey> {
        let mine = enc.get(w.recipient_key_id)?;
        let sender_pub = keys_of
            .get(&w.owner)?
            .iter()
            .find(|k| k.id == w.sender_key_id && k.purpose == "ENCRYPTION")?
            .public_key
            .clone();
        let secret = secret_of(mine).ok()?;
        open_wrap(
            core,
            &self.repo_id,
            w.epoch,
            &w.wrapped,
            &secret,
            &sender_pub,
        )
        .ok()
    }

    /// The resolution: epochs, anchors, alerts, the repair check.
    pub fn resolution(&self) -> &EpochResolution {
        &self.resolution
    }

    /// The repository's current members.
    pub fn members(&self) -> &[Member] {
        &self.members
    }

    /// The reader's role now.
    pub fn reader_role(&self) -> Option<Role> {
        let me = platform::encode_identifier(self.reader);
        self.members
            .iter()
            .filter(|m| m.identity_id == me)
            .map(|m| m.role)
            .min()
    }

    /// Epochs with a wrap to the reader that it could not open.
    pub fn unreadable_wraps(&self) -> &[u32] {
        &self.unreadable_wraps
    }

    /// The epochs the reader can read.
    pub fn readable_epochs(&self) -> Vec<u32> {
        self.resolution.keys.keys().copied().collect()
    }

    /// The seams to write with: [`Private`] over the write epoch, or the reason there is none
    /// (E306 no key at all, E307/E308 an alert, E309 a current epoch this reader cannot use).
    pub fn writer(&self, repo: &RepoRef) -> Result<Private> {
        Private::from_resolution(&self.repo_id, &self.resolution).ok_or_else(|| self.no_write(repo))
    }

    /// The seams to read with: every readable epoch (and the write epoch when there is one).
    /// Reading needs no write epoch, so a member of a repo mid-rotation can still read history.
    pub fn reader(&self, repo: &RepoRef) -> Result<ReadKeys> {
        if self.resolution.keys.is_empty() {
            return Err(self.no_read(repo));
        }
        Ok(ReadKeys {
            keys: self
                .resolution
                .keys
                .iter()
                .map(|(&e, k)| (e, EpochKeys::derive(&self.repo_id, e, k)))
                .collect(),
        })
    }

    fn alert_error(&self, repo: &RepoRef) -> Option<Error> {
        self.resolution.alerts.iter().find_map(|a| match a {
            Alert::KeyMismatch { epoch, author } => Some(
                UserError::new(
                    codes::KEY_MISMATCH,
                    format!("{}: a maintainer gave you a key that isn't this repo's key (epoch {epoch})", repo.display()),
                )
                .cause(format!(
                    "the repoKey from {} does not commit to epoch {epoch}'s anchor",
                    platform::encode_identifier(*author)
                ))
                .fix(format!("ask a maintainer to run `dg repo keys repair {}`", repo.display()))
                .into(),
            ),
            Alert::ChainBroken { epoch, author } => Some(
                UserError::new(
                    codes::KEY_CHAIN_BROKEN,
                    format!("{}: the key chain is broken at epoch {epoch}", repo.display()),
                )
                .cause(format!(
                    "the anchor by {} does not carry a previous key that opens the epoch before it",
                    platform::encode_identifier(*author)
                ))
                .fix("ask that maintainer to re-wrap the older epoch to you")
                .into(),
            ),
            Alert::RotationRequired { .. } => None,
        })
    }

    fn no_read(&self, repo: &RepoRef) -> Error {
        if let Some(e) = self.alert_error(repo) {
            return e;
        }
        let member = self.reader_role().is_some();
        let (why, fix) = if member {
            (
                "you are a member, but no current maintainer has wrapped the repo key to your encryption key yet".to_string(),
                format!("ask a maintainer to run `dg repo keys repair {}`", repo.display()),
            )
        } else {
            (
                "you are not a member of this private repository (or you were removed)".to_string(),
                format!(
                    "ask a maintainer to run `dg collab add {} {}`",
                    repo.display(),
                    platform::encode_identifier(self.reader)
                ),
            )
        };
        UserError::new(
            codes::NOT_A_KEY_HOLDER,
            format!("private repo {}: you hold no key for it", repo.display()),
        )
        .cause(why)
        .fix(fix)
        .into()
    }

    fn no_write(&self, repo: &RepoRef) -> Error {
        if self.resolution.keys.is_empty() {
            return self.no_read(repo);
        }
        if let Some(e) = self.alert_error(repo) {
            return e;
        }
        UserError::new(
            codes::ROTATION_PENDING,
            format!(
                "private repo {}: the current key epoch is not one you can write under yet",
                repo.display()
            ),
        )
        .cause(format!(
            "the current epoch is {:?} and you hold keys for {:?}: a rotation landed and no maintainer has wrapped its key to you",
            self.resolution.current_epoch,
            self.readable_epochs()
        ))
        .fix(format!("ask a maintainer to run `dg repo keys repair {}`", repo.display()))
        .note("nothing was written")
        .into()
    }

    /// `open_content` (§8.1) for a fetched document of `kind`, with its bind fields read from
    /// the document. A private document with no `enc` is `Malformed`.
    pub fn open(&self, kind: DocKind, d: &FetchedDocument) -> Opened {
        let Some(enc) = d.field_bytes("enc").filter(|e| !e.is_empty()) else {
            return Opened::Malformed;
        };
        let Some(header) = header_of(kind, d) else {
            return Opened::Malformed;
        };
        open_content(&self.ctx, &header, &enc)
    }

    /// The decrypted config timeline: every config that opens (any epoch the reader holds),
    /// as the ref rules take it, and the newest one's fields.
    pub fn config(&self) -> PrivateConfig {
        let mut out = PrivateConfig::default();
        let mut newest: Option<(u64, String, Fields)> = None;
        for d in &self.configs {
            let Opened::Readable(fields) = self.open(DocKind::Config, d) else {
                continue;
            };
            let at = d.created_at.unwrap_or(0);
            out.history.push(crate::rules::ConfigDoc {
                id: d.id.clone(),
                created_at: at,
                protected_patterns: fields.protected_patterns.clone(),
            });
            let key = (at, d.id.clone());
            if newest
                .as_ref()
                .is_none_or(|(t, id, _)| key > (*t, id.clone()))
            {
                newest = Some((at, d.id.clone(), *fields));
            }
        }
        if let Some((_, id, f)) = newest {
            out.default_branch = f.default_branch.map(|b| short_branch(&b).to_string());
            out.protected_patterns = f.protected_patterns;
            if let Some(d) = self.configs.iter().find(|d| d.id == id) {
                out.backend = d.fields.get("backend").cloned();
                out.archived = d.field_bool("archived");
            }
        }
        out
    }

    /// The raw keys the resolution holds (for tests and for the rotation's `prevEpochKey`).
    fn epoch_key(&self, epoch: u32) -> Option<&EpochKey> {
        self.resolution.keys.get(&epoch)
    }
}

/// The subkeys of every epoch a reader holds.
pub struct ReadKeys {
    keys: BTreeMap<u32, EpochKeys>,
}

impl std::fmt::Debug for ReadKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReadKeys")
            .field("epochs", &self.keys.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl ReadKeys {
    /// The subkeys of `epoch`, if held.
    pub fn get(&self, epoch: u32) -> Option<&EpochKeys> {
        self.keys.get(&epoch)
    }

    /// Every held epoch's subkeys.
    pub fn all(&self) -> impl Iterator<Item = &EpochKeys> {
        self.keys.values()
    }

    /// Open a whole sealed artifact whose manifest says `size_bytes` (§3.5).
    pub fn open_pack(&self, sealed: &[u8], size_bytes: u64) -> Result<Vec<u8>> {
        crate::private::pack::open(sealed, size_bytes, |e| self.keys.get(&e))
            .map_err(|e| sealed_error(&e))
    }
}

/// A sealed-artifact failure as the user-facing class: a copy whose hash verified but whose
/// contents do not open is E508 (every copy of that hash is the same bytes).
pub fn sealed_error(e: &PrivateError) -> Error {
    match *e {
        PrivateError::NoKey(epoch) => UserError::new(
            codes::NOT_A_KEY_HOLDER,
            format!("a pack is sealed under key epoch {epoch}, which you hold no key for"),
        )
        .fix("ask a maintainer to run `dg repo keys repair <owner>/<repo>`")
        .into(),
        PrivateError::SizeMismatch => Error::Integrity,
        _ => UserError::new(
            codes::SEALED_PACK_CORRUPT,
            "a sealed pack failed its checks",
        )
        .cause(e.to_string())
        .fix("ask the member who pushed it to push again")
        .into(),
    }
}

/// `refs/heads/main` → `main`; a short name is returned as-is.
pub fn short_branch(b: &str) -> &str {
    b.strip_prefix("refs/heads/").unwrap_or(b)
}

/// The [`DocHeader`] of a fetched document: the §4.4 bind fields from its plaintext.
pub fn header_of(kind: DocKind, d: &FetchedDocument) -> Option<DocHeader> {
    let owner = platform::decode_identifier(&d.owner_id).ok()?;
    let epoch = u32::try_from(d.field_u64("epoch")?).ok()?;
    let mut h = DocHeader::new(kind, owner, epoch);
    h.id = platform::decode_identifier(&d.id).ok();
    h.created_at_block_height = d.created_at_block_height;
    match kind {
        DocKind::Issue => h.number = u32::try_from(d.field_u64("number")?).ok(),
        DocKind::Patch => {
            h.number = u32::try_from(d.field_u64("number")?).ok();
            h.base_ref_name_hash = d.field_bytes32("baseRefNameHash");
            h.source_ref_name_hash = d.field_bytes32("sourceRefNameHash");
        }
        DocKind::Comment => h.target_id = d.field_bytes32("targetId"),
        DocKind::Review => h.patch_id = d.field_bytes32("patchId"),
        DocKind::RefUpdate | DocKind::ProtectedRefUpdate => {
            h.ref_name_hash = d.field_bytes32("refNameHash");
            h.new_oid = d.field_bytes("newOid");
            h.prev_oid = d.field_bytes("prevOid");
            h.force = Some(d.field_bool("force"));
        }
        DocKind::Config => {}
    }
    Some(h)
}

/// Why a document did not open, in the three buckets the UI and `dg` report (§9 Reading).
pub fn hidden_bucket(o: &Opened) -> Option<&'static str> {
    match o {
        Opened::Readable(_) => None,
        Opened::Malformed | Opened::Unreadable(Unreadable::BadTag) => {
            Some("not encrypted for this repo")
        }
        Opened::Unreadable(Unreadable::Late) => Some("written after the key was rotated"),
        Opened::Unreadable(_) => Some("wrong or missing key"),
    }
}

fn secret_of(k: &PrivateKey) -> Result<WrapSecret> {
    WrapSecret::from_bytes(&k.secret_bytes())
}

/// A signer's view of a private repository: its client, identity, key file and the keys that
/// file holds.
pub struct PrivateSigner<'a> {
    /// The connection.
    pub client: &'a PlatformClient,
    /// The signing identity.
    pub identity: &'a LoadedIdentity,
    /// Its key file.
    pub bridge: &'a BridgeIdentity,
}

impl<'a> PrivateSigner<'a> {
    /// The signer's `ENCRYPTION` keys for `repo` (matched against its on-chain keys).
    pub fn encryption_keys(&self, repo: &RepoRef) -> EncryptionKeys {
        EncryptionKeys::held(
            self.bridge,
            &self.identity.public_keys(),
            &repo.forge().core,
        )
    }

    /// [`Keyring::load`] as this signer.
    pub async fn keyring(&self, repo: &RepoRef) -> Result<Keyring> {
        Keyring::load(
            self.client,
            repo,
            &self.identity.id(),
            &self.encryption_keys(repo),
        )
        .await
    }

    fn engine(&self) -> Result<WriteEngine<'a>> {
        WriteEngine::new(self.client, self.identity, self.bridge.doc_op_key()?)
    }

    /// Post one `repoKey`: `key` (of `epoch`) wrapped from the signer's sender key to
    /// `member`'s highest enabled `ENCRYPTION` key. Returns the document id.
    async fn post_wrap(
        &self,
        core: &LoadedContract,
        scope: &DocScope,
        epoch: u32,
        key: &EpochKey,
        member: [u8; 32],
    ) -> Result<String> {
        let repo_core = scope.contract_id.clone();
        let enc = EncryptionKeys::held(self.bridge, &self.identity.public_keys(), &repo_core);
        let (sender_id, sender) = enc
            .sender()
            .ok_or_else(|| no_encryption_key("your identity", "cannot wrap the repo key"))?;
        let member_b58 = platform::encode_identifier(member);
        let recipient_keys = self.client.fetch_identity(&member_b58).await?.public_keys();
        let recipient = recipient_key(&recipient_keys, &repo_core)
            .ok_or_else(|| no_encryption_key(&member_b58, "cannot wrap the repo key"))?;
        let secret = secret_of(sender)?;
        let props = seal_wrap(
            core,
            &scope.repo_id,
            epoch,
            key,
            &WrapParties {
                sender: &secret,
                sender_key_id: sender_id,
                recipient_public_key: &recipient.public_key,
                recipient_key_id: recipient.id,
            },
        )?;
        let doc = scope.props([
            ("memberId", FieldValue::identifier(member)),
            ("epoch", FieldValue::integer(u64::from(epoch))),
            (
                "recipientKeyId",
                FieldValue::integer(u64::from(props.recipient_key_id)),
            ),
            (
                "senderKeyId",
                FieldValue::integer(u64::from(props.sender_key_id)),
            ),
            ("wrapped", FieldValue::bytes(props.wrapped)),
        ]);
        match self
            .engine()?
            .create_document(core, DOC_REPO_KEY, doc)
            .await
        {
            Ok(id) => Ok(id),
            // (repoId, memberId, epoch, $ownerId) is unique: this signer already wrapped this
            // epoch to them (a resumed rotation). Theirs stands.
            Err(Error::DuplicateUniqueIndex(_)) => Ok(String::new()),
            Err(e) => Err(e),
        }
    }

    /// Post the anchor `config` of `epoch` sealed under `key`: the current config's fields,
    /// plus `prevEpoch`/`prevEpochKey` for `epoch ≥ 1`.
    async fn post_anchor(
        &self,
        core: &LoadedContract,
        scope: &DocScope,
        anchor: &AnchorInput<'_>,
    ) -> Result<String> {
        let owner = platform::decode_identifier(&self.identity.id())?;
        let keys = EpochKeys::derive(&scope.repo_id, anchor.epoch, anchor.key);
        let fields = Fields {
            default_branch: Some(anchor.default_branch.to_string()),
            protected_patterns: anchor.protected_patterns.to_vec(),
            prev_epoch: anchor.prev.map(|(e, _)| e),
            prev_epoch_key: anchor.prev.map(|(_, k)| k.clone()),
            ..Fields::default()
        };
        let enc = crate::private::doc::seal(
            &keys,
            &DocHeader::new(DocKind::Config, owner, anchor.epoch),
            &fields,
        )?;
        let mut props = scope.props([
            ("enc", FieldValue::bytes(enc)),
            ("epoch", FieldValue::integer(u64::from(anchor.epoch))),
            ("archived", FieldValue::boolean(anchor.archived)),
        ]);
        props.insert("backend".into(), anchor.backend.clone());
        self.engine()?
            .create_document(core, DOC_CONFIG, props)
            .await
    }
}

/// What an anchor `config` carries.
struct AnchorInput<'k> {
    epoch: u32,
    key: &'k EpochKey,
    prev: Option<(u32, &'k EpochKey)>,
    default_branch: &'k str,
    protected_patterns: &'k [String],
    backend: FieldValue,
    archived: bool,
}

/// The plaintext `backend` object of a new repository's config.
pub fn backend_object(mode: u8) -> FieldValue {
    FieldValue::Object(BTreeMap::from([(
        "mode".to_string(),
        FieldValue::integer(u64::from(mode)),
    )]))
}

/// Epoch 0 of a new private repository (§5.5 "create", §9): the owner's self-wrap, then the
/// anchor `config`. Resumable: an existing self-wrap for epoch 0 is unwrapped and reused (the
/// key is never stored locally), and an existing anchor is left alone. Returns whether
/// anything was written.
pub async fn create_private_state(
    signer: &PrivateSigner<'_>,
    repo: &RepoRef,
    default_branch: &str,
    backend: FieldValue,
) -> Result<bool> {
    let scope = repo.scope()?;
    let core = signer.client.fetch_contract(&scope.contract_id).await?;
    let io = KeyringIo {
        client: signer.client,
        core: &core,
        scope: &scope,
    };
    let me = platform::decode_identifier(&signer.identity.id())?;
    let enc = signer.encryption_keys(repo);
    if enc.sender().is_none() {
        return Err(no_encryption_key(
            "your identity",
            "cannot create a private repository",
        ));
    }
    let kr = Keyring::load_with(&io, repo, &signer.identity.id(), &enc).await?;
    if kr.resolution.anchors.contains_key(&0) {
        return Ok(false);
    }
    // Resume: our own epoch-0 self-wrap, if it landed, is the key.
    let resumed = kr
        .wraps
        .iter()
        .filter(|w| w.epoch == 0 && w.member == me && w.owner == me)
        .find_map(|w| {
            let keys_of = BTreeMap::from([(me, signer.identity.public_keys())]);
            kr.unwrap_own(&core, w, &enc, &keys_of)
        });
    let key = if let Some(k) = resumed {
        k
    } else {
        let k = EpochKey::generate()?;
        signer.post_wrap(&core, &scope, 0, &k, me).await?;
        k
    };
    signer
        .post_anchor(
            &core,
            &scope,
            &AnchorInput {
                epoch: 0,
                key: &key,
                prev: None,
                default_branch: short_branch(default_branch),
                protected_patterns: &[],
                backend,
                archived: false,
            },
        )
        .await?;
    Ok(true)
}

/// Wrap the current epoch's key to `member` (§5.5 "add member"): the second of the two
/// transitions of an add. Idempotent (an existing wrap from this signer stands).
pub async fn add_member_wrap(
    signer: &PrivateSigner<'_>,
    repo: &RepoRef,
    member: &str,
) -> Result<()> {
    let scope = repo.scope()?;
    let core = signer.client.fetch_contract(&scope.contract_id).await?;
    let kr = signer.keyring(repo).await?;
    let w = kr.writer(repo)?;
    let epoch = w.write_epoch();
    let key = kr.epoch_key(epoch).expect("the write epoch's key is held");
    signer
        .post_wrap(
            &core,
            &scope,
            epoch,
            key,
            platform::decode_identifier(member)?,
        )
        .await?;
    Ok(())
}

/// Whether `member` has a usable `ENCRYPTION` key to wrap to (§5.5: add is refused without).
pub async fn member_can_receive(
    client: &PlatformClient,
    repo: &RepoRef,
    member: &str,
) -> Result<bool> {
    let keys = client.fetch_identity(member).await?.public_keys();
    Ok(recipient_key(&keys, &repo.forge().core).is_some())
}

/// What [`rotate`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rotation {
    /// The new epoch.
    pub epoch: u32,
    /// Members wrapped (self first).
    pub wrapped: Vec<String>,
    /// Whether this signer's anchor is the epoch's anchor (false: another current
    /// maintainer's won a concurrent rotation, and theirs stands).
    pub won: bool,
}

/// Rotate to a new epoch (§5.5 "remove member", steps 1–4): draw `K_{n+1}`, wrap it to every
/// current member except `exclude` (self first), post the anchor with `prevEpoch = n`,
/// `prevEpochKey = K_n`, and wait until a proved read shows whether this anchor is first.
///
/// `exclude` names identities that must not be wrapped even if a stale read still lists them
/// (the member just removed). Resumable without a local journal: a self-wrap by this signer
/// for an unanchored epoch above `n` is unwrapped and reused with its epoch number; otherwise
/// the next epoch with no wrap by this signer is used (§5.5 "crash between steps 2 and 3").
pub async fn rotate(
    signer: &PrivateSigner<'_>,
    repo: &RepoRef,
    exclude: &[String],
) -> Result<Rotation> {
    let scope = repo.scope()?;
    let core = signer.client.fetch_contract(&scope.contract_id).await?;
    let io = KeyringIo {
        client: signer.client,
        core: &core,
        scope: &scope,
    };
    let me_b58 = signer.identity.id();
    let me = platform::decode_identifier(&me_b58)?;
    let enc = signer.encryption_keys(repo);
    let kr = Keyring::load_with(&io, repo, &me_b58, &enc).await?;
    if kr.reader_role() != Some(Role::Maintainer) {
        return Err(Error::NotPermitted {
            action: format!("rotate the key of {}", repo.display()),
            reason: "only a current maintainer can rotate a private repository's key".into(),
            needs: "maintainer".into(),
        });
    }
    let n = kr.writer(repo)?.write_epoch(); // n must be readable to chain it
    let k_n = kr
        .epoch_key(n)
        .expect("the write epoch's key is held")
        .clone();
    let (epoch, key) = next_epoch(&kr, &core, &enc, signer, me, n)?;

    // Step 2: wraps, self first, to every remaining member.
    let targets = rotation_targets(&kr, &me_b58, exclude);
    let already: BTreeSet<[u8; 32]> = kr
        .wraps
        .iter()
        .filter(|w| w.epoch == epoch && w.owner == me)
        .map(|w| w.member)
        .collect();
    for t in &targets {
        let tb = platform::decode_identifier(t)?;
        if !already.contains(&tb) {
            signer.post_wrap(&core, &scope, epoch, &key, tb).await?;
        }
    }

    // Step 3: the anchor (the commit point), with the current config's fields.
    let cfg = kr.config();
    let default_branch = cfg.default_branch.clone().unwrap_or_else(|| "main".into());
    let anchor_id = signer
        .post_anchor(
            &core,
            &scope,
            &AnchorInput {
                epoch,
                key: &key,
                prev: Some((n, &k_n)),
                default_branch: &default_branch,
                protected_patterns: &cfg.protected_patterns,
                backend: cfg.backend.clone().unwrap_or_else(|| backend_object(0)),
                archived: cfg.archived,
            },
        )
        .await?;
    let anchor_bytes = platform::decode_identifier(&anchor_id)?;

    // Step 4: a proved read that lists the epoch's configs; confirm ours is first among current
    // maintainers' (select_anchors orders by ($createdAtBlockHeight, raw $id)).
    for attempt in 0..ANCHOR_POLLS {
        let now = Keyring::load_with(&io, repo, &me_b58, &enc).await?;
        if let Some(a) = now.resolution.anchors.get(&epoch) {
            return Ok(Rotation {
                epoch,
                wrapped: targets,
                won: a.id == anchor_bytes,
            });
        }
        if attempt + 1 < ANCHOR_POLLS {
            tokio::time::sleep(ANCHOR_POLL_DELAY).await;
        }
    }
    Err(Error::Timeout { retryable: true })
}

/// The epoch and key a rotation above `n` uses (§5.5 step 1 and the crash rule): the key of
/// this signer's own self-wrap for an unanchored epoch above `n` (a rotation that died before
/// its anchor), else a fresh key for the next epoch number with no wrap by this signer and no
/// anchor.
fn next_epoch(
    kr: &Keyring,
    core: &LoadedContract,
    enc: &EncryptionKeys,
    signer: &PrivateSigner<'_>,
    me: [u8; 32],
    n: u32,
) -> Result<(u32, EpochKey)> {
    let keys_of = BTreeMap::from([(me, signer.identity.public_keys())]);
    let pending = kr
        .wraps
        .iter()
        .filter(|w| {
            w.epoch > n
                && w.member == me
                && w.owner == me
                && !kr.resolution.anchors.contains_key(&w.epoch)
        })
        .max_by_key(|w| (w.epoch, w.height))
        .and_then(|w| kr.unwrap_own(core, w, enc, &keys_of).map(|k| (w.epoch, k)));
    if let Some(p) = pending {
        return Ok(p);
    }
    let used: BTreeSet<u32> = kr
        .wraps
        .iter()
        .filter(|w| w.owner == me)
        .map(|w| w.epoch)
        .chain(kr.resolution.anchors.keys().copied())
        .collect();
    let overflow = || Error::Config("key epoch overflow".into());
    let mut e = n.checked_add(1).ok_or_else(overflow)?;
    while used.contains(&e) {
        e = e.checked_add(1).ok_or_else(overflow)?;
    }
    Ok((e, EpochKey::generate()?))
}

/// Who a rotation wraps to: this signer first, then every current member not in `exclude`.
fn rotation_targets(kr: &Keyring, me: &str, exclude: &[String]) -> Vec<String> {
    let mut targets: Vec<String> = vec![me.to_string()];
    for m in kr.members() {
        if !exclude.contains(&m.identity_id) && !targets.contains(&m.identity_id) {
            targets.push(m.identity_id.clone());
        }
    }
    targets
}

/// What [`repair`] did (§5.6).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RepairReport {
    /// A rotation it ran (a non-member held the current key).
    pub rotated: Option<Rotation>,
    /// The non-members that caused it.
    pub non_members: Vec<String>,
    /// Members wrapped for the current epoch (no rotation needed).
    pub wrapped: Vec<String>,
}

/// The repair check of §5.6, applied: rotate when the current epoch is wrapped to a
/// non-member, else wrap each member with no wrap to an enabled key. A maintainer only.
pub async fn repair(signer: &PrivateSigner<'_>, repo: &RepoRef) -> Result<RepairReport> {
    let kr = signer.keyring(repo).await?;
    let Some(r) = kr.resolution.repair.clone() else {
        return Ok(RepairReport::default());
    };
    let mut report = RepairReport {
        non_members: r
            .non_members
            .iter()
            .map(|m| platform::encode_identifier(*m))
            .collect(),
        ..RepairReport::default()
    };
    if r.rotate {
        report.rotated = Some(rotate(signer, repo, &report.non_members).await?);
        return Ok(report);
    }
    for m in &r.missing_wraps {
        let id = platform::encode_identifier(*m);
        add_member_wrap(signer, repo, &id).await?;
        report.wrapped.push(id);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::FieldValue;

    fn doc(kind_fields: Vec<(&str, FieldValue)>) -> FetchedDocument {
        FetchedDocument {
            id: platform::encode_identifier([7; 32]),
            owner_id: platform::encode_identifier([0x22; 32]),
            created_at: Some(10),
            created_at_block_height: Some(5),
            fields: kind_fields
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        }
    }

    #[test]
    fn header_binds_what_the_ad_needs() {
        let d = doc(vec![
            ("epoch", FieldValue::integer(2)),
            ("refNameHash", FieldValue::bytes32([1; 32])),
            ("newOid", FieldValue::bytes(vec![0xaa; 20])),
        ]);
        let h = header_of(DocKind::RefUpdate, &d).unwrap();
        assert_eq!(h.epoch, 2);
        assert_eq!(h.ref_name_hash, Some([1; 32]));
        assert_eq!(h.new_oid.as_deref(), Some(&[0xaa; 20][..]));
        assert_eq!(h.prev_oid, None);
        assert_eq!(
            h.force,
            Some(false),
            "force is always bound, false when absent"
        );
        assert_eq!(h.created_at_block_height, Some(5));
        assert!(
            header_of(DocKind::Issue, &d).is_none(),
            "an issue needs its number"
        );
    }

    #[test]
    fn short_branch_strips_refs_heads_only() {
        assert_eq!(short_branch("refs/heads/main"), "main");
        assert_eq!(short_branch("main"), "main");
        assert_eq!(short_branch("refs/tags/v1"), "refs/tags/v1");
    }

    #[test]
    fn recipient_is_the_highest_enabled_encryption_key() {
        let k = |id, disabled, purpose: &str| IdentityKeyInfo {
            id,
            purpose: purpose.into(),
            security_level: "MEDIUM".into(),
            key_type: "ECDSA_SECP256K1".into(),
            public_key: vec![2; 33],
            disabled,
            bound_to: None,
        };
        let keys = vec![
            k(4, false, "ENCRYPTION"),
            k(6, true, "ENCRYPTION"),
            k(7, false, "AUTHENTICATION"),
        ];
        assert_eq!(recipient_key(&keys, "CORE").map(|k| k.id), Some(4));
        assert!(recipient_key(&keys[1..], "CORE").is_none());
    }

    #[test]
    fn hidden_buckets_follow_the_ux_spec() {
        assert_eq!(
            hidden_bucket(&Opened::Malformed),
            Some("not encrypted for this repo")
        );
        assert_eq!(
            hidden_bucket(&Opened::Unreadable(Unreadable::Late)),
            Some("written after the key was rotated")
        );
        assert_eq!(
            hidden_bucket(&Opened::Unreadable(Unreadable::NoKey)),
            Some("wrong or missing key")
        );
        assert_eq!(hidden_bucket(&Opened::Readable(Box::default())), None);
    }
}
