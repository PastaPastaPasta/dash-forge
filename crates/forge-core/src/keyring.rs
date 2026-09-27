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

use futures::{StreamExt as _, TryStreamExt as _};

use crate::envelope::{self, PrivateKey};
use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::members::{Member, MemberReader};
use crate::platform::wrap::{open_wrap, seal_wrap, WrapParties, WrapSecret};
use crate::platform::{
    self, FetchedDocument, FieldValue, IdentityKeyInfo, LoadedContract, LoadedIdentity,
    PlatformClient, QueryFilter, QueryOrder, WriteEngine,
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

/// Identity reads a keyring load runs at once.
const IDENTITY_FETCH_WINDOW: usize = 8;

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
    /// The epoch key, when this is one of the reader's own wraps and it opened (§5.4 (4)).
    key: Option<EpochKey>,
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
            key: None,
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
    /// The decrypted config timeline, built once at load.
    config: PrivateConfig,
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
            config: PrivateConfig::default(),
            unreadable_wraps: Vec::new(),
        };
        keyring.resolve(io, enc).await?;
        Ok(keyring)
    }

    async fn resolve(&mut self, io: &KeyringIo<'_>, enc: &EncryptionKeys) -> Result<()> {
        // Identity keys are read only where a decision needs them, so wraps nobody may delete
        // (a removed maintainer's, to arbitrary identities) cannot inflate every load: current
        // members (§5.6's "wrap to an enabled key") and the authors of the reader's own wraps
        // who are current maintainers (their sender keys; §5.4 ignores anyone else's wraps).
        let members: BTreeSet<[u8; 32]> = self
            .members
            .iter()
            .filter_map(|m| platform::decode_identifier(&m.identity_id).ok())
            .collect();
        let maintainers: BTreeSet<[u8; 32]> = self
            .members
            .iter()
            .filter(|m| m.role == Role::Maintainer)
            .filter_map(|m| platform::decode_identifier(&m.identity_id).ok())
            .collect();
        let mut parties = members;
        parties.extend(
            self.wraps
                .iter()
                .filter(|w| w.member == self.reader && maintainers.contains(&w.owner))
                .map(|w| w.owner),
        );
        let fetched: Vec<Option<([u8; 32], Vec<IdentityKeyInfo>)>> =
            futures::stream::iter(parties.into_iter().map(|p| async move {
                match io
                    .client
                    .fetch_identity(&platform::encode_identifier(p))
                    .await
                {
                    Ok(identity) => Ok(Some((p, identity.public_keys()))),
                    Err(Error::NotFound) => Ok(None),
                    Err(e) => Err(e),
                }
            }))
            .buffered(IDENTITY_FETCH_WINDOW)
            .try_collect()
            .await?;
        let keys_of: BTreeMap<[u8; 32], Vec<IdentityKeyInfo>> =
            fetched.into_iter().flatten().collect();
        let enabled = |who: &[u8; 32], id: u32| {
            keys_of
                .get(who)
                .and_then(|ks| ks.iter().find(|k| k.id == id))
                .is_some_and(|k| !k.disabled && k.purpose == "ENCRYPTION")
        };

        let mut unreadable = Vec::new();
        for i in 0..self.wraps.len() {
            if self.wraps[i].member != self.reader {
                continue;
            }
            let key = unwrap_own(io.core, &self.repo_id, &self.wraps[i], enc, &keys_of);
            if key.is_none() {
                unreadable.push(self.wraps[i].epoch);
            }
            self.wraps[i].key = key;
        }
        let rows: Vec<WrapRow> = self
            .wraps
            .iter()
            .map(|w| WrapRow {
                id: w.id,
                owner: w.owner,
                member_id: w.member,
                epoch: w.epoch,
                recipient_key_id: w.recipient_key_id,
                key_enabled: enabled(&w.member, w.recipient_key_id),
                key: w.key.clone(),
            })
            .collect();
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
        self.config = self.decrypt_config();
        unreadable.sort_unstable();
        unreadable.dedup();
        self.unreadable_wraps = unreadable;
        Ok(())
    }

    /// The repository these keys belong to.
    pub fn repo_id(&self) -> &[u8; 32] {
        &self.repo_id
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

    /// Refuse a reader that holds no key at all (E306, or the alert that explains why).
    /// Reading needs no write epoch, so a member of a repo mid-rotation can still read history.
    pub fn require_key(&self, repo: &RepoRef) -> Result<()> {
        if self.resolution.keys.is_empty() {
            return Err(self.no_read(repo));
        }
        Ok(())
    }

    /// Open a whole sealed artifact whose manifest says `size_bytes` (§3.5), under any epoch
    /// the reader holds.
    pub fn open_pack(&self, repo: &RepoRef, sealed: &[u8], size_bytes: u64) -> Result<Vec<u8>> {
        self.require_key(repo)?;
        crate::private::pack::open(sealed, size_bytes, |e| self.ctx.keys.get(&e))
            .map_err(|e| sealed_error(&e))
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
                .fix(fix_repair(repo))
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
                fix_repair(repo),
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
        .fix(fix_repair(repo))
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
    pub fn config(&self) -> &PrivateConfig {
        &self.config
    }

    fn decrypt_config(&self) -> PrivateConfig {
        let mut out = PrivateConfig::default();
        let mut newest: Option<(&FetchedDocument, Fields)> = None;
        for d in &self.configs {
            let Opened::Readable(fields) = self.open(DocKind::Config, d) else {
                continue;
            };
            out.history.push(crate::rules::ConfigDoc {
                id: d.id.clone(),
                created_at: d.created_at.unwrap_or(0),
                protected_patterns: fields.protected_patterns.clone(),
            });
            let key = |doc: &FetchedDocument| (doc.created_at.unwrap_or(0), doc.id.clone());
            if newest.as_ref().is_none_or(|(n, _)| key(d) > key(n)) {
                newest = Some((d, *fields));
            }
        }
        if let Some((d, f)) = newest {
            out.default_branch = f.default_branch.map(|b| short_branch(&b).to_string());
            out.protected_patterns = f.protected_patterns;
            out.backend = d.fields.get("backend").cloned();
            out.archived = d.field_bool("archived");
        }
        out
    }

    /// The raw keys the resolution holds (for tests and for the rotation's `prevEpochKey`).
    fn epoch_key(&self, epoch: u32) -> Option<&EpochKey> {
        self.resolution.keys.get(&epoch)
    }

    /// `(prevEpoch, prevEpochKey)` of `epoch`'s anchor, which every later config of the epoch
    /// repeats (§4.3). `None` for epoch 0; an error when the anchor does not open.
    pub fn prev_of(&self, epoch: u32) -> Result<Option<(u32, EpochKey)>> {
        if epoch == 0 {
            return Ok(None);
        }
        let anchor = self
            .resolution
            .anchors
            .get(&epoch)
            .ok_or_else(|| Error::Config(format!("key epoch {epoch} has no anchor")))?;
        let doc = self
            .configs
            .iter()
            .find(|d| platform::decode_identifier(&d.id).ok() == Some(anchor.id))
            .ok_or_else(|| {
                Error::Config(format!("the anchor of key epoch {epoch} was not read"))
            })?;
        match self.open(DocKind::Config, doc) {
            Opened::Readable(f) => match (f.prev_epoch, f.prev_epoch_key) {
                (Some(p), Some(k)) => Ok(Some((p, k))),
                _ => Err(PrivateError::Malformed.into()),
            },
            _ => Err(Error::Config(format!(
                "the anchor of key epoch {epoch} does not open with your keys"
            ))),
        }
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

/// The fix every "a maintainer must repair the key" error carries.
fn fix_repair(repo: &RepoRef) -> String {
    format!(
        "ask a maintainer to run `dg repo keys repair {}`",
        repo.display()
    )
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

/// The key in one of the reader's own wraps: the reader's private key named by
/// `recipientKeyId`, and the sender's public key named by `senderKeyId`. `None` when either is
/// missing or the wrap does not open (version / KCV, §5.4 (4)).
fn unwrap_own(
    core: &LoadedContract,
    repo_id: &[u8; 32],
    w: &WrapDoc,
    enc: &EncryptionKeys,
    keys_of: &BTreeMap<[u8; 32], Vec<IdentityKeyInfo>>,
) -> Option<EpochKey> {
    let mine = enc.get(w.recipient_key_id)?;
    let sender_pub = &keys_of
        .get(&w.owner)?
        .iter()
        .find(|k| k.id == w.sender_key_id && k.purpose == "ENCRYPTION")?
        .public_key;
    let secret = secret_of(mine).ok()?;
    open_wrap(core, repo_id, w.epoch, &w.wrapped, &secret, sender_pub).ok()
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
        w: &WriteCtx,
        epoch: u32,
        key: &EpochKey,
        member: [u8; 32],
    ) -> Result<WrapOutcome> {
        let (core, scope) = (&w.core, &w.scope);
        let (sender_id, sender) = w
            .enc
            .sender()
            .ok_or_else(|| no_encryption_key("your identity", "cannot wrap the repo key"))?;
        let member_b58 = platform::encode_identifier(member);
        let recipient_keys = self.client.fetch_identity(&member_b58).await?.public_keys();
        let Some(recipient) = recipient_key(&recipient_keys, &scope.contract_id) else {
            return Ok(WrapOutcome::NoRecipientKey);
        };
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
            Ok(_) => Ok(WrapOutcome::Posted),
            // (repoId, memberId, epoch, $ownerId) is unique: this signer already wrapped this
            // epoch to them, and that wrap stands. It counts only if it holds the same key to
            // the member's current key; read it back and say which.
            Err(Error::DuplicateUniqueIndex(_)) => {
                let existing = self
                    .read_own_wrap(w, epoch, member, &recipient_keys)
                    .await?;
                Ok(match existing {
                    Some((k, kid)) if &k == key && kid == recipient.id => WrapOutcome::Same,
                    other => WrapOutcome::Different(other.map(|(k, _)| k)),
                })
            }
            Err(e) => Err(e),
        }
    }

    /// This signer's standing wrap of `epoch` to `member`, opened with the signer's own key
    /// (ECDH is symmetric: a sender reads its own wraps with the recipient's public key):
    /// the key it holds and the recipient key id it names. `None` when it cannot be read.
    async fn read_own_wrap(
        &self,
        w: &WriteCtx,
        epoch: u32,
        member: [u8; 32],
        recipient_keys: &[IdentityKeyInfo],
    ) -> Result<Option<(EpochKey, u32)>> {
        let docs = self
            .client
            .query_documents(
                &w.core,
                DOC_REPO_KEY,
                &w.scope.filters([
                    QueryFilter::eq("memberId", FieldValue::identifier(member)),
                    QueryFilter::eq("epoch", FieldValue::integer(u64::from(epoch))),
                    QueryFilter::eq("$ownerId", FieldValue::identifier(w.me)),
                ]),
                &[],
                1,
                None,
            )
            .await?;
        let Some(d) = docs.first().and_then(WrapDoc::from_doc) else {
            return Ok(None);
        };
        let Some(mine) = w.enc.get(d.sender_key_id) else {
            return Ok(None);
        };
        let Some(pubkey) = recipient_keys
            .iter()
            .find(|k| k.id == d.recipient_key_id && k.purpose == "ENCRYPTION")
        else {
            return Ok(None);
        };
        let secret = secret_of(mine)?;
        Ok(open_wrap(
            &w.core,
            &w.scope.repo_id,
            epoch,
            &d.wrapped,
            &secret,
            &pubkey.public_key,
        )
        .ok()
        .map(|k| (k, d.recipient_key_id)))
    }

    /// Post the anchor `config` of `epoch` sealed under `key`: the current config's fields,
    /// plus `prevEpoch`/`prevEpochKey` for `epoch ≥ 1`.
    async fn post_anchor(&self, w: &WriteCtx, anchor: &AnchorInput<'_>) -> Result<String> {
        let (core, scope, owner) = (&w.core, &w.scope, w.me);
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

/// How posting one wrap ended.
#[derive(Debug)]
enum WrapOutcome {
    /// A new `repoKey` landed.
    Posted,
    /// This signer's wrap for (member, epoch) already stands, with the same key to the
    /// member's current key: nothing to do.
    Same,
    /// This signer's wrap for (member, epoch) already stands with another key, or to a key the
    /// member no longer uses (the unique index keeps it; it cannot be replaced). The key it
    /// holds, when the signer can read it back.
    Different(Option<EpochKey>),
    /// The member has no usable `ENCRYPTION` key: nothing was written.
    NoRecipientKey,
}

/// Everything a keyring write needs: the contract, the scope, the signer's keys and the
/// keyring read now (§5.3: before every write).
struct WriteCtx {
    core: LoadedContract,
    scope: DocScope,
    me: [u8; 32],
    enc: EncryptionKeys,
    kr: Keyring,
}

impl PrivateSigner<'_> {
    async fn open(&self, repo: &RepoRef) -> Result<WriteCtx> {
        let scope = repo.scope()?;
        let core = self.client.fetch_contract(&scope.contract_id).await?;
        let enc = self.encryption_keys(repo);
        let kr = Keyring::load_with(
            &KeyringIo {
                client: self.client,
                core: &core,
                scope: &scope,
            },
            repo,
            &self.identity.id(),
            &enc,
        )
        .await?;
        let me = kr.reader;
        Ok(WriteCtx {
            core,
            scope,
            me,
            enc,
            kr,
        })
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
    let w = signer.open(repo).await?;
    if w.kr.resolution.anchors.contains_key(&0) {
        return Ok(false);
    }
    // Resume: our own epoch-0 self-wrap, if it landed, is the key.
    let resumed =
        w.kr.wraps
            .iter()
            .filter(|x| x.epoch == 0 && x.member == w.me && x.owner == w.me)
            .find_map(|x| x.key.clone());
    let key = if let Some(k) = resumed {
        k
    } else {
        let k = EpochKey::generate()?;
        self_wrap(signer, &w, 0, k).await?
    };
    signer
        .post_anchor(
            &w,
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

/// Post the signer's own wrap of `key` for `epoch` and return the key the epoch must use: a
/// self-wrap that already stands (a resumed run whose read lagged the landed wrap) wins, since
/// the unique index keeps it and the signer would otherwise anchor a key it cannot read.
async fn self_wrap(
    signer: &PrivateSigner<'_>,
    w: &WriteCtx,
    epoch: u32,
    key: EpochKey,
) -> Result<EpochKey> {
    match signer.post_wrap(w, epoch, &key, w.me).await? {
        WrapOutcome::Posted | WrapOutcome::Same => Ok(key),
        WrapOutcome::Different(Some(standing)) => Ok(standing),
        WrapOutcome::Different(None) | WrapOutcome::NoRecipientKey => Err(UserError::new(
            codes::ROTATION_PENDING,
            format!("your own key wrap for epoch {epoch} stands and cannot be read back"),
        )
        .cause("it was sealed from an encryption key your identity file no longer holds")
        .fix("run the command again with the identity file that holds that key, or rotate from another maintainer")
        .into()),
    }
}

/// Wrap the current epoch's key to `member` (§5.5 "add member"): the second of the two
/// transitions of an add. Idempotent: the signer's own standing wrap with the same key counts.
/// A standing wrap that cannot be replaced (the member changed keys since) needs a rotation.
pub async fn add_member_wrap(
    signer: &PrivateSigner<'_>,
    repo: &RepoRef,
    member: &str,
) -> Result<()> {
    let w = signer.open(repo).await?;
    let epoch = w.kr.writer(repo)?.write_epoch();
    let key =
        w.kr.epoch_key(epoch)
            .expect("the write epoch's key is held")
            .clone();
    match signer
        .post_wrap(&w, epoch, &key, platform::decode_identifier(member)?)
        .await?
    {
        WrapOutcome::Posted | WrapOutcome::Same => Ok(()),
        WrapOutcome::NoRecipientKey => Err(no_encryption_key(member, "cannot wrap the repo key")),
        WrapOutcome::Different(_) => Err(UserError::new(
            codes::ROTATION_PENDING,
            format!("{member} already has a wrap of epoch {epoch} from you that it cannot use"),
        )
        .cause("they changed their encryption key since; a wrap cannot be replaced within an epoch")
        .fix(format!(
            "rotate the key: `dg repo keys rotate {}`",
            repo.display()
        ))
        .into()),
    }
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
    /// Members skipped: no usable `ENCRYPTION` key (the repair check wraps them once they add
    /// one).
    pub skipped: Vec<String>,
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
    let w = signer.open(repo).await?;
    let (kr, me) = (&w.kr, w.me);
    let me_b58 = signer.identity.id();
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
    // Step 2: wraps, self first (its standing key wins, see `self_wrap`), to every remaining
    // member. A member with no usable key is skipped rather than blocking the rotation: the
    // removed member must lose the key now; the skipped one is wrapped by a repair later. A
    // resumed epoch whose earlier wrap to a member cannot be replaced (they changed keys since)
    // is abandoned for a fresh one, once.
    let targets = rotation_targets(kr, &me_b58, exclude);
    let (mut epoch, mut key) = next_epoch(kr, me, n, exclude, None)?;
    let mut abandoned = None;
    let (key, wrapped, skipped) = loop {
        let key_now = self_wrap(signer, &w, epoch, key).await?;
        match wrap_all(signer, &w, epoch, &key_now, &targets).await? {
            Ok((wrapped, skipped)) => break (key_now, wrapped, skipped),
            Err(member) if abandoned.is_none() => {
                tracing::info!(epoch, %member, "a resumed epoch holds an unusable wrap; starting a fresh one");
                abandoned = Some(epoch);
                (epoch, key) = next_epoch(kr, me, n, exclude, abandoned)?;
            }
            Err(member) => {
                return Err(Error::Config(format!(
                    "key epoch {epoch} already holds another key of yours for {member}; run \
                     `dg repo keys rotate {}` again",
                    repo.display()
                )))
            }
        }
    };

    // Step 3: the anchor (the commit point), with the current config's fields.
    let cfg = kr.config();
    let default_branch = cfg.default_branch.clone().unwrap_or_else(|| "main".into());
    signer
        .post_anchor(
            &w,
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

    // Step 4: a proved read that lists the epoch's configs; confirm ours is first among current
    // maintainers' (select_anchors orders by ($createdAtBlockHeight, raw $id)).
    let io = KeyringIo {
        client: signer.client,
        core: &w.core,
        scope: &w.scope,
    };
    for attempt in 0..ANCHOR_POLLS {
        let now = Keyring::load_with(&io, repo, &me_b58, &w.enc).await?;
        if let Some(a) = now.resolution.anchors.get(&epoch) {
            // A resumed run may post a second anchor with the same key; the first is still ours.
            return Ok(Rotation {
                epoch,
                wrapped,
                skipped,
                won: a.owner == me,
            });
        }
        if attempt + 1 < ANCHOR_POLLS {
            tokio::time::sleep(ANCHOR_POLL_DELAY).await;
        }
    }
    Err(Error::Timeout { retryable: true })
}

/// Wrap `key` of `epoch` to every target but the first (self, already wrapped): `Ok` with who
/// was wrapped (self first) and who was skipped (no usable key), or `Err(member)` when a
/// standing wrap to that member holds another key or names a key they no longer use.
async fn wrap_all(
    signer: &PrivateSigner<'_>,
    w: &WriteCtx,
    epoch: u32,
    key: &EpochKey,
    targets: &[String],
) -> Result<std::result::Result<(Vec<String>, Vec<String>), String>> {
    let (mut wrapped, mut skipped) = (vec![targets[0].clone()], Vec::new());
    for t in &targets[1..] {
        match signer
            .post_wrap(w, epoch, key, platform::decode_identifier(t)?)
            .await?
        {
            WrapOutcome::Posted | WrapOutcome::Same => wrapped.push(t.clone()),
            WrapOutcome::NoRecipientKey => skipped.push(t.clone()),
            WrapOutcome::Different(_) => return Ok(Err(t.clone())),
        }
    }
    Ok(Ok((wrapped, skipped)))
}

/// The epoch and key a rotation above `n` uses (§5.5 step 1 and the crash rule): the key of
/// this signer's own self-wrap for an unanchored epoch above `n` (a rotation that died before
/// its anchor), else a fresh key for the next epoch number with no wrap by this signer and no
/// anchor.
fn next_epoch(
    kr: &Keyring,
    me: [u8; 32],
    n: u32,
    exclude: &[String],
    abandoned: Option<u32>,
) -> Result<(u32, EpochKey)> {
    // A pending epoch is resumed only while its key reached nobody who must not have it: a
    // crashed rotation's wrap to the member being removed now would hand them the new key.
    let members: BTreeSet<[u8; 32]> = kr
        .members()
        .iter()
        .filter(|m| !exclude.contains(&m.identity_id))
        .filter_map(|m| platform::decode_identifier(&m.identity_id).ok())
        .chain(std::iter::once(me))
        .collect();
    let clean = |epoch: u32| {
        kr.wraps
            .iter()
            .filter(|w| w.epoch == epoch && w.owner == me)
            .all(|w| members.contains(&w.member))
    };
    let pending = kr
        .wraps
        .iter()
        .filter(|w| {
            w.epoch > n
                && w.member == me
                && w.owner == me
                && !kr.resolution.anchors.contains_key(&w.epoch)
                && clean(w.epoch)
                && abandoned.is_none()
        })
        .max_by_key(|w| (w.epoch, w.height))
        .and_then(|w| w.key.clone().map(|k| (w.epoch, k)));
    if let Some(p) = pending {
        return Ok(p);
    }
    // Never reuse an epoch number seen anywhere: an epoch whose anchor's author was removed
    // stops existing but its content stays under that number, and a removed member's wraps
    // and configs keep naming theirs.
    let used: BTreeSet<u32> = kr
        .wraps
        .iter()
        .map(|w| w.epoch)
        .chain(kr.configs.iter().filter_map(config_row).map(|c| c.epoch))
        .chain(kr.resolution.anchors.keys().copied())
        .chain(kr.resolution.unanchored.iter().copied())
        .chain(abandoned)
        .collect();
    let floor = used.iter().next_back().copied().unwrap_or(n).max(n);
    Ok((fresh_epoch(floor, &used)?, EpochKey::generate()?))
}

/// Before `leaving` loses the maintainer role: re-anchor every existing epoch whose anchor
/// `leaving` wrote, under the same key and chain link, so the epoch keeps its commitment once
/// `leaving`'s configs stop counting (§5.3). Otherwise the current epoch would fall back to an
/// older one (a key earlier removed members hold) and the epoch's content would open under
/// nobody's key. Epochs this signer cannot read are left, and returned, for the caller to
/// report. Returns `(re-anchored, unreadable)`.
pub async fn reanchor_before_removal(
    signer: &PrivateSigner<'_>,
    repo: &RepoRef,
    leaving: &str,
) -> Result<(Vec<u32>, Vec<u32>)> {
    let w = signer.open(repo).await?;
    let leaving = platform::decode_identifier(leaving)?;
    if leaving == w.me {
        return Ok((Vec::new(), Vec::new()));
    }
    let cfg = w.kr.config().clone();
    let default_branch = cfg.default_branch.clone().unwrap_or_else(|| "main".into());
    let (mut done, mut unreadable) = (Vec::new(), Vec::new());
    let theirs: Vec<u32> =
        w.kr.resolution
            .anchors
            .iter()
            .filter(|(_, a)| a.owner == leaving)
            .map(|(&e, _)| e)
            .collect();
    for epoch in theirs {
        let Some(key) = w.kr.epoch_key(epoch).cloned() else {
            unreadable.push(epoch);
            continue;
        };
        let prev = w.kr.prev_of(epoch)?;
        signer
            .post_anchor(
                &w,
                &AnchorInput {
                    epoch,
                    key: &key,
                    prev: prev.as_ref().map(|(p, k)| (*p, k)),
                    default_branch: &default_branch,
                    protected_patterns: &cfg.protected_patterns,
                    backend: cfg.backend.clone().unwrap_or_else(|| backend_object(0)),
                    archived: cfg.archived,
                },
            )
            .await?;
        done.push(epoch);
    }
    // Wraps from `leaving` stop counting with their role too (§5.4 (2)). If this signer's only
    // accepted wrap of the current epoch is theirs, it would lose the epoch it must chain the
    // coming rotation from: wrap it to itself first (older epochs follow through the chain).
    if let Some(n) = w.kr.resolution.current_epoch {
        let held_otherwise =
            w.kr.wraps
                .iter()
                .any(|x| x.epoch == n && x.member == w.me && x.owner != leaving && x.key.is_some());
        if let (false, Some(key)) = (held_otherwise, w.kr.epoch_key(n).cloned()) {
            self_wrap(signer, &w, n, key).await?;
        }
    }
    Ok((done, unreadable))
}

/// The smallest epoch number above `n` that is not in `used` (this signer's wraps and every
/// anchored epoch): epoch numbers need not be contiguous (§5.5 "crash between steps 2 and 3").
fn fresh_epoch(n: u32, used: &BTreeSet<u32>) -> Result<u32> {
    let overflow = || Error::Config("key epoch overflow".into());
    let mut e = n.checked_add(1).ok_or_else(overflow)?;
    while used.contains(&e) {
        e = e.checked_add(1).ok_or_else(overflow)?;
    }
    Ok(e)
}

/// Who a rotation wraps to: this signer first, then every current member not in `exclude`.
fn rotation_targets(kr: &Keyring, me: &str, exclude: &[String]) -> Vec<String> {
    targets_of(kr.members(), me, exclude)
}

fn targets_of(members: &[Member], me: &str, exclude: &[String]) -> Vec<String> {
    let mut targets: Vec<String> = vec![me.to_string()];
    for m in members {
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
    /// Members still without a wrap: no usable `ENCRYPTION` key yet.
    pub skipped: Vec<String>,
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
    let w = signer.open(repo).await?;
    let epoch = w.kr.writer(repo)?.write_epoch();
    let key =
        w.kr.epoch_key(epoch)
            .expect("the write epoch's key is held")
            .clone();
    for m in &r.missing_wraps {
        let id = platform::encode_identifier(*m);
        match signer.post_wrap(&w, epoch, &key, *m).await? {
            WrapOutcome::Posted | WrapOutcome::Same => report.wrapped.push(id),
            WrapOutcome::NoRecipientKey => report.skipped.push(id),
            // A standing wrap of ours to a key they no longer use cannot be replaced within
            // the epoch: a new epoch wraps everyone to their current key.
            WrapOutcome::Different(_) => {
                report.rotated = Some(rotate(signer, repo, &[]).await?);
                return Ok(report);
            }
        }
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

    fn member(id: [u8; 32], role: Role) -> Member {
        Member {
            identity_id: platform::encode_identifier(id),
            role,
            document_id: format!("d{}", id[0]),
            created_at: 1,
        }
    }

    fn wrap(owner: [u8; 32], member: [u8; 32], epoch: u32, key: Option<u8>) -> WrapDoc {
        WrapDoc {
            id: [u8::try_from(epoch).unwrap_or(0xff); 32],
            owner,
            member,
            epoch,
            recipient_key_id: 4,
            sender_key_id: 4,
            wrapped: vec![0; 64],
            height: u64::from(epoch),
            key: key.map(|b| EpochKey::from_bytes([b; 32])),
        }
    }

    /// A keyring with members and wraps and no anchors above epoch 0.
    fn keyring(members: Vec<Member>, wraps: Vec<WrapDoc>) -> Keyring {
        let mut resolution = EpochResolution::default();
        resolution.anchors.insert(
            0,
            crate::private::epoch::Anchor {
                id: [0xa0; 32],
                owner: [1; 32],
                height: 1,
                commit: None,
            },
        );
        Keyring {
            repo_id: [0x11; 32],
            reader: [1; 32],
            members,
            configs: Vec::new(),
            wraps,
            resolution,
            ctx: OpenContext::default(),
            config: PrivateConfig::default(),
            unreadable_wraps: Vec::new(),
        }
    }

    #[test]
    fn a_pending_epoch_is_resumed_only_if_its_key_reached_no_excluded_member() {
        let (alice, bob, carol) = ([1; 32], [2; 32], [3; 32]);
        let members = vec![
            member(alice, Role::Maintainer),
            member(bob, Role::Writer),
            member(carol, Role::Writer),
        ];
        // a crashed `dg repo keys rotate`: epoch 1 wrapped to alice (self) and bob, no anchor
        let wraps = vec![
            wrap(alice, alice, 1, Some(9)),
            wrap(alice, bob, 1, None),
            wrap(alice, carol, 1, None),
        ];
        let kr = keyring(members, wraps);
        // resumed by a plain rotation: nobody excluded
        let (e, k) = next_epoch(&kr, alice, 0, &[], None).unwrap();
        assert_eq!((e, k), (1, EpochKey::from_bytes([9; 32])));
        // removing bob must not reuse the key bob already holds: a fresh epoch past 1
        let bob_b58 = platform::encode_identifier(bob);
        let (e, k) = next_epoch(&kr, alice, 0, &[bob_b58], None).unwrap();
        assert_eq!(e, 2);
        assert_ne!(k, EpochKey::from_bytes([9; 32]));
    }

    #[test]
    fn an_abandoned_pending_epoch_is_never_resumed_or_reused() {
        let (alice, bob) = ([1; 32], [2; 32]);
        let kr = keyring(
            vec![member(alice, Role::Maintainer), member(bob, Role::Writer)],
            vec![wrap(alice, alice, 1, Some(9)), wrap(alice, bob, 1, None)],
        );
        // bob changed keys since: epoch 1's wrap to him cannot be replaced, so it is abandoned
        let (e, k) = next_epoch(&kr, alice, 0, &[], Some(1)).unwrap();
        assert_eq!(e, 2);
        assert_ne!(k, EpochKey::from_bytes([9; 32]));
    }

    #[test]
    fn epoch_numbers_seen_on_any_config_or_wrap_are_never_reused() {
        // a removed maintainer anchored epoch 1 (no longer an anchor, still on chain as a wrap
        // to bob): the next epoch is above it, never 1 again
        let (alice, bob, mallory) = ([1; 32], [2; 32], [7; 32]);
        let kr = keyring(
            vec![member(alice, Role::Maintainer), member(bob, Role::Writer)],
            vec![wrap(mallory, bob, 1, None)],
        );
        let (e, _) = next_epoch(&kr, alice, 0, &[], None).unwrap();
        assert_eq!(e, 2);
    }

    #[test]
    fn a_pending_epoch_wrapped_to_a_non_member_is_not_resumed() {
        let (alice, mallory) = ([1; 32], [7; 32]);
        let kr = keyring(
            vec![member(alice, Role::Maintainer)],
            vec![
                wrap(alice, alice, 3, Some(9)),
                wrap(alice, mallory, 3, None),
            ],
        );
        let (e, _) = next_epoch(&kr, alice, 0, &[], None).unwrap();
        assert_eq!(e, 4, "a new epoch is above every epoch number seen (3)");
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
    fn rotation_wraps_self_first_and_never_an_excluded_member() {
        let m = |id: &str, role| Member {
            identity_id: id.into(),
            role,
            document_id: format!("d-{id}"),
            created_at: 1,
        };
        let members = [
            m("bob", Role::Writer),
            m("alice", Role::Maintainer),
            m("carol", Role::Maintainer),
            // carol also holds the writer role: one wrap each, not two
            m("carol", Role::Writer),
        ];
        // a stale read still lists bob after his removal: excluded anyway
        assert_eq!(
            targets_of(&members, "alice", &["bob".into()]),
            ["alice", "carol"]
        );
        assert_eq!(
            targets_of(&members, "alice", &[]),
            ["alice", "bob", "carol"]
        );
        // the rotator is wrapped first even when not listed yet (a lagging read)
        assert_eq!(targets_of(&[], "alice", &[]), ["alice"]);
    }

    #[test]
    fn a_fresh_epoch_skips_used_numbers() {
        assert_eq!(fresh_epoch(0, &BTreeSet::new()).unwrap(), 1);
        // a race loser's wraps for 1 and 2, and an anchored 3: the next free is 4
        assert_eq!(fresh_epoch(0, &BTreeSet::from([1, 2, 3])).unwrap(), 4);
        assert_eq!(fresh_epoch(5, &BTreeSet::from([1, 2])).unwrap(), 6);
        assert!(fresh_epoch(u32::MAX, &BTreeSet::new()).is_err());
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
