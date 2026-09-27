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
    /// (bound to `core` or unbound). An on-chain `ENCRYPTION` key whose private half the file
    /// does not hold (one `dg auth keys add --encryption` added later, which stores nothing) is
    /// derived from the file's recovery words at the identity's DIP-13 key path, when the words
    /// reproduce the identity's keys.
    pub fn held(
        bridge: &BridgeIdentity,
        on_chain: &[IdentityKeyInfo],
        core: &str,
        network: &platform::Network,
    ) -> Self {
        let mut candidates = envelope::encryption_keys(bridge);
        let in_file: BTreeSet<u32> = candidates.iter().map(|(id, _)| *id).collect();
        let words_match = || platform::identity_keys::recorded_keys_match(bridge, on_chain);
        for k in on_chain
            .iter()
            .filter(|k| k.purpose == "ENCRYPTION" && !in_file.contains(&k.id))
        {
            if !words_match() {
                break;
            }
            if let Some(secret) =
                platform::identity_keys::derive_encryption_secret(bridge, k.id, network)
            {
                if let Ok(private) = PrivateKey::from_slice(secret.as_slice()) {
                    candidates.push((k.id, private));
                }
            }
        }
        let keys = candidates
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

/// E306: the identity has no usable `ENCRYPTION` key in its file.
pub fn no_encryption_key(who: &str, action: &str) -> Error {
    UserError::new(
        codes::NO_ENCRYPTION_KEY,
        format!("{action}: {who} has no encryption key"),
    )
    .cause("private repositories encrypt their content to each member's identity ENCRYPTION key, and the key source in use holds none that matches an enabled key on the identity (a limited key from `dg auth login` holds only a signing key)")
    .fix("if the identity has an ENCRYPTION key (`dg auth keys list`), use a source that holds it: `DASH_FORGE_KEY=<identity file>`, or `dg auth login --full-key <identity file>`")
    .fix(format!("if it has none: {FIX_ADD_ENCRYPTION_KEY}"))
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
    /// The rows [`resolve_epochs`] ran over, kept to ask "what if this identity were (not) a
    /// maintainer" before a membership change (§5.3).
    rows: Rows,
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

/// The flattened rows of one load.
#[derive(Clone, Default)]
struct Rows {
    members: Vec<MemberRow>,
    configs: Vec<ConfigRow>,
    wraps: Vec<WrapRow>,
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
            rows: Rows::default(),
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
        self.rows = Rows {
            members: memberships,
            configs,
            wraps: rows,
        };
        self.ctx = self.resolution.open_context(&self.repo_id);
        self.config = self.decrypt_config();
        unreadable.sort_unstable();
        unreadable.dedup();
        self.unreadable_wraps = unreadable;
        Ok(())
    }

    /// The identity these keys were resolved for.
    pub fn reader(&self) -> &[u8; 32] {
        &self.reader
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

    /// The first epoch whose anchor would change (commitment, or which epoch is current) if
    /// `who` became a maintainer (§5.3: adding a maintainer must not change any anchor). Their
    /// earlier configs (from a past maintainer role) would count again, and may come first.
    #[must_use]
    pub fn maintainer_would_move_anchors(&self, who: [u8; 32]) -> Option<u32> {
        // (A config of theirs above the current epoch never counts: it predates the epoch
        // below it being stated, §5.3.)
        let before = &self.resolution;
        let after = self.resolution_if(who, true);
        if after.current_epoch != before.current_epoch {
            return Some(match (before.current_epoch, after.current_epoch) {
                (Some(b), Some(a)) => b.min(a).saturating_add(1),
                _ => 0,
            });
        }
        before
            .anchors
            .iter()
            .find(|(e, a)| after.anchors.get(e).map(|x| x.commit) != Some(a.commit))
            .map(|(&e, _)| e)
    }

    /// The resolution as it would be if `who` did (`maintainer = true`) or did not hold the
    /// maintainer role, everything else unchanged: anchors and wraps count only from current
    /// maintainers (§5.3, §5.4), so a role change can move them.
    #[must_use]
    pub fn resolution_if(&self, who: [u8; 32], maintainer: bool) -> EpochResolution {
        let mut members: Vec<MemberRow> = self
            .rows
            .members
            .iter()
            .filter(|m| m.identity != who || m.role != Role::Maintainer)
            .cloned()
            .collect();
        if maintainer {
            members.push(MemberRow {
                identity: who,
                role: Role::Maintainer,
                created_at: 0,
            });
        }
        resolve_epochs(
            &self.repo_id,
            &self.reader,
            &members,
            &self.rows.configs,
            &self.rows.wraps,
        )
    }

    /// Who anchored the current epoch, when it is burned (§5.3): the maintainer whose rotation
    /// closed it.
    #[must_use]
    pub fn burned_by(&self) -> Option<(u32, [u8; 32])> {
        let n = self.resolution.current_epoch?;
        self.resolution
            .burned
            .contains(&n)
            .then(|| (n, self.resolution.anchors[&n].owner))
    }

    /// The seams to write with: [`Private`] over the write epoch, or the reason there is none
    /// (E307 no key at all, E308/E309 an alert, E310 a current epoch this reader cannot use).
    pub fn writer(&self, repo: &RepoRef) -> Result<Private> {
        Private::from_resolution(&self.repo_id, &self.resolution).ok_or_else(|| self.no_write(repo))
    }

    /// Refuse a reader that holds no key at all (E307, or the alert that explains why).
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
            Alert::RotationRequired { .. } | Alert::EpochGap { .. } => None,
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
        if let (Some(n), Some(r)) = (self.resolution.current_epoch, &self.resolution.repair) {
            if !r.non_members.is_empty() && self.resolution.keys.contains_key(&n) {
                return UserError::new(
                    codes::ROTATION_PENDING,
                    format!(
                        "private repo {}: a non-member holds the current key (epoch {n})",
                        repo.display()
                    ),
                )
                .cause(format!(
                    "the key of epoch {n} is wrapped to {}; nothing is written until a maintainer rotates",
                    r.non_members
                        .iter()
                        .map(|m| platform::encode_identifier(*m))
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
                .fix(format!("`dg repo keys repair {}` (a maintainer)", repo.display()))
                .note("nothing was written")
                .into();
            }
        }
        if let Some((n, by)) = self.burned_by() {
            return UserError::new(
                codes::ROTATION_PENDING,
                format!("private repo {}: key epoch {n} is burned", repo.display()),
            )
            .cause(format!(
                "{} closed it (its key may have reached someone it must not): nothing is written under it until a maintainer rotates",
                platform::encode_identifier(by)
            ))
            .fix(fix_repair(repo))
            .note("nothing was written")
            .into();
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
        let opened = open_content(&self.ctx, &header, &enc);
        let earlier = matches!(
            opened,
            Opened::Unreadable(Unreadable::BadTag | Unreadable::CommitMismatch)
        ) && self.earlier_use(header.epoch, header.created_at_block_height);
        if earlier {
            Opened::Unreadable(Unreadable::EarlierUse)
        } else {
            opened
        }
    }

    /// Whether something written at `height` under `epoch` predates the moment the epoch's
    /// current key was first stated on chain (stated(e), §5.3; a re-anchor does not move it):
    /// it was sealed under an earlier use of the number, not tampered with.
    pub fn earlier_use(&self, epoch: u32, height: Option<u64>) -> bool {
        let anchor = self.resolution.anchors.get(&epoch);
        matches!((anchor, height), (Some(a), Some(h)) if h < a.stated_height)
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

    /// The chain link of `epoch`'s anchor (`prevEpoch`, `prevEpochKey`, `skipEpochKey`, burned),
    /// which every later config of the epoch repeats (§4.3). `None` for epoch 0; an error when
    /// the anchor does not open.
    pub fn link_of(&self, epoch: u32) -> Result<Option<ChainLink>> {
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
            Opened::Readable(f) => match f.prev_epoch {
                Some(prev) => Ok(Some(ChainLink {
                    prev,
                    prev_key: f.prev_epoch_key,
                    skip_key: f.skip_epoch_key,
                    burned: f.burned,
                })),
                None => Err(PrivateError::Malformed.into()),
            },
            _ => Err(Error::Config(format!(
                "the anchor of key epoch {epoch} does not open with your keys"
            ))),
        }
    }
}

/// The chain fields of a config for `e ≥ 1` (§4.3, §5.3): `prevEpoch = e − 1`; `prevEpochKey`
/// unless burned; `skipEpochKey` when `e − 1` is burned (the key of the nearest epoch below the
/// burned run that is not burned); the burned flag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainLink {
    /// `prevEpoch`.
    pub prev: u32,
    /// `prevEpochKey` (none on a burned config).
    pub prev_key: Option<EpochKey>,
    /// `skipEpochKey`.
    pub skip_key: Option<EpochKey>,
    /// Tag 11.
    pub burned: bool,
}

impl ChainLink {
    /// The link's fields on top of `f`.
    pub fn apply(&self, f: Fields) -> Fields {
        Fields {
            prev_epoch: Some(self.prev),
            prev_epoch_key: self.prev_key.clone(),
            skip_epoch_key: self.skip_key.clone(),
            burned: self.burned,
            ..f
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
        Opened::Unreadable(Unreadable::EarlierUse) => {
            Some("sealed under an earlier use of its key epoch")
        }
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
            self.client.network(),
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
        let base = Fields {
            default_branch: Some(anchor.default_branch.to_string()),
            protected_patterns: anchor.protected_patterns.to_vec(),
            ..Fields::default()
        };
        let fields = match &anchor.link {
            Some(l) => l.apply(base),
            None => base,
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
    /// A fresh proved read of the keyring, re-using `w`'s contract, scope and keys.
    async fn reload(&self, w: &WriteCtx, repo: &RepoRef) -> Result<Keyring> {
        let io = KeyringIo {
            client: self.client,
            core: &w.core,
            scope: &w.scope,
        };
        Keyring::load_with(&io, repo, &self.identity.id(), &w.enc).await
    }

    /// Reload up to `polls` times, `ANCHOR_POLL_DELAY` apart, until `check` returns `Some`.
    async fn poll<T>(
        &self,
        w: &WriteCtx,
        repo: &RepoRef,
        polls: usize,
        mut check: impl FnMut(&Keyring) -> Option<T>,
    ) -> Result<Option<T>> {
        for attempt in 0..polls {
            if let Some(t) = check(&self.reload(w, repo).await?) {
                return Ok(Some(t));
            }
            if attempt + 1 < polls {
                tokio::time::sleep(ANCHOR_POLL_DELAY).await;
            }
        }
        Ok(None)
    }

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
    /// The chain link (`None` for epoch 0).
    link: Option<ChainLink>,
    default_branch: &'k str,
    protected_patterns: &'k [String],
    backend: FieldValue,
    archived: bool,
}

impl<'k> AnchorInput<'k> {
    /// An anchor repeating the current config's fields (`config` is newest-wins).
    fn current(
        cfg: &'k PrivateConfig,
        epoch: u32,
        key: &'k EpochKey,
        link: Option<ChainLink>,
    ) -> Self {
        Self {
            epoch,
            key,
            link,
            default_branch: cfg.default_branch.as_deref().unwrap_or("main"),
            protected_patterns: &cfg.protected_patterns,
            backend: cfg.backend.clone().unwrap_or_else(|| backend_object(0)),
            archived: cfg.archived,
        }
    }
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
    let key = match pending_key(&w.kr, w.me, 0) {
        Some(k) => k,
        None => self_wrap(signer, &w, 0, EpochKey::generate()?).await?.0,
    };
    signer
        .post_anchor(
            &w,
            &AnchorInput {
                epoch: 0,
                key: &key,
                link: None,
                default_branch: short_branch(default_branch),
                protected_patterns: &[],
                backend,
                archived: false,
            },
        )
        .await?;
    Ok(true)
}

/// Post the signer's own wrap of `key` for `epoch` and return the key the epoch must use, and
/// whether it is a standing one: a self-wrap that already stands (a resumed run whose read
/// lagged the landed wrap) wins, since the unique index keeps it and the signer would otherwise
/// anchor a key it cannot read.
async fn self_wrap(
    signer: &PrivateSigner<'_>,
    w: &WriteCtx,
    epoch: u32,
    key: EpochKey,
) -> Result<(EpochKey, bool)> {
    match signer.post_wrap(w, epoch, &key, w.me).await? {
        WrapOutcome::Posted | WrapOutcome::Same => Ok((key, false)),
        WrapOutcome::Different(Some(standing)) => Ok((standing, true)),
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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
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
    /// An epoch this rotation anchored burned on the way (§5.3): an earlier run's key for it
    /// may have reached someone outside the remaining members, so it only links the chain.
    pub burned: Option<u32>,
}

/// The epoch a rotation chains from: the current epoch and its key. A burned current epoch
/// still chains (§5.3); one the rotator cannot read cannot.
fn chain_from(kr: &Keyring, repo: &RepoRef) -> Result<(u32, EpochKey)> {
    kr.resolution
        .current_epoch
        .and_then(|n| kr.epoch_key(n).map(|k| (n, k.clone())))
        .ok_or_else(|| kr.no_write(repo))
}

/// The chain link the anchor of `from.0 + 1` carries (§5.3): `prevEpoch = n`, and unless it is
/// itself burned, `prevEpochKey = K_n` and, when `n` is burned, `skipEpochKey` = the key of the
/// nearest epoch below the burned run that is not burned. `skip_below` is that key when the
/// rotator already knows it (a burn it just posted), else it is looked up in `kr`.
fn next_link(
    kr: &Keyring,
    from: &(u32, EpochKey),
    from_burned: bool,
    burned: bool,
    skip_below: Option<&EpochKey>,
) -> Result<ChainLink> {
    let (n, k_n) = from;
    if burned {
        // the burned key may sit with someone who never held K_n: it carries no key below
        return Ok(ChainLink {
            prev: *n,
            prev_key: None,
            skip_key: None,
            burned: true,
        });
    }
    let skip_key = if from_burned {
        Some(if let Some(k) = skip_below {
            k.clone()
        } else {
            below_burned_run(kr, *n)?
        })
    } else {
        None
    };
    Ok(ChainLink {
        prev: *n,
        prev_key: Some(k_n.clone()),
        skip_key,
        burned: false,
    })
}

/// Whether the reader's next rotation may have to burn `n + 1` first (§5.5): an earlier run of
/// theirs left a self-wrap there. For cost estimates only; the rotation decides for itself.
pub fn rotation_may_burn(kr: &Keyring) -> bool {
    kr.resolution
        .current_epoch
        .and_then(|n| n.checked_add(1))
        .is_some_and(|next| {
            kr.wraps
                .iter()
                .any(|w| w.epoch == next && w.owner == kr.reader && w.member == kr.reader)
        })
}

/// The key of the nearest epoch below burned epoch `n`'s run that is not burned, from the
/// reader's keys: every epoch between must be known burned.
fn below_burned_run(kr: &Keyring, n: u32) -> Result<EpochKey> {
    let res = &kr.resolution;
    (0..n)
        .rev()
        .find(|e| !res.burned.contains(e))
        .filter(|s| (s + 1..n).all(|e| res.burned.contains(&e)))
        .and_then(|s| res.keys.get(&s).cloned())
        .ok_or_else(|| {
            Error::Config(format!(
                "key epoch {n} is burned and the epoch below its burned run is not readable to you"
            ))
        })
}

/// This signer's own self-wrap for `epoch`, opened: the key an earlier run drew for it (the
/// unique index keeps that wrap, so it is the only key `epoch` can have for this signer).
fn pending_key(kr: &Keyring, me: [u8; 32], epoch: u32) -> Option<EpochKey> {
    kr.wraps
        .iter()
        .find(|w| w.epoch == epoch && w.member == me && w.owner == me)
        .and_then(|w| w.key.clone())
}

/// A crash injected for the e2e suite (`DASH_FORGE_TEST_FAULT=<point>`), honoured only in debug
/// builds: the rotation stops at `point` as if the process died there.
fn test_fault(point: &str) -> Result<()> {
    if cfg!(debug_assertions) && std::env::var("DASH_FORGE_TEST_FAULT").is_ok_and(|p| p == point) {
        return Err(Error::Config(format!("test fault injected at {point}")));
    }
    Ok(())
}

/// What a rotation does with the key it holds for `n + 1` (§5.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    /// Wrap it to the remaining members and anchor it.
    Use,
    /// It may have reached someone outside the remaining members: wrap it to the remaining
    /// members anyway (so any maintainer can see the burn and chain from it), anchor it burned,
    /// and rotate on to `n + 2`.
    Burn,
}

/// What a rotation knows about the key it holds for `n + 1`.
#[derive(Debug, Clone, Copy, Default)]
#[allow(clippy::struct_excessive_bools)]
struct KeyFacts {
    /// The rotation excludes someone (a removal).
    removing: bool,
    /// The key came from this signer's own earlier self-wrap.
    resumed: bool,
    /// A standing self-wrap with another key was found only on posting (a read that lagged it).
    adopted: bool,
    /// This signer's wraps at `n + 1` to someone outside the targets are visible.
    strays: bool,
    /// A standing wrap to a remaining member holds another key or names a key they no longer
    /// use.
    unusable: bool,
}

/// The decision of §5.5 for `n + 1` (pure).
fn step_for(f: KeyFacts) -> Step {
    // a removal cannot trust a read that may lag an earlier run's wrap to the member being
    // removed; any run can see such a wrap once it is visible; and a wrap cannot be replaced
    // within an epoch
    if (f.removing && (f.resumed || f.adopted)) || f.strays || f.unusable {
        Step::Burn
    } else {
        Step::Use
    }
}

/// Rotate to the next epoch (§5.5 "remove member", steps 1–4): epochs are contiguous, so it is
/// always `n + 1`. Wrap its key to every current member except `exclude` (self first), post
/// the anchor with its chain link ([`next_link`]), and wait until a proved read shows whether
/// this anchor is first.
///
/// `exclude` names identities that must not be wrapped even if a stale read still lists them
/// (the member just removed). Resumable without a local journal: this signer's self-wrap for an
/// unanchored `n + 1` is unwrapped and its key reused (§5.5 "crash between steps 2 and 3").
/// When that key may have reached someone outside the remaining members ([`step_for`]), `n + 1`
/// is wrapped to the remaining members, anchored **burned** (a chain link only, carrying no key
/// below it) and the rotation continues to `n + 2`; if another maintainer's anchor for `n + 1`
/// wins that race, nothing more is posted and the result says the rotation lost.
pub async fn rotate(
    signer: &PrivateSigner<'_>,
    repo: &RepoRef,
    exclude: &[String],
) -> Result<Rotation> {
    let w = signer.open(repo).await?;
    let me_b58 = signer.identity.id();
    require_rotator(&w.kr, repo)?;
    let mut from = chain_from(&w.kr, repo)?;
    let mut from_burned = w.kr.resolution.burned.contains(&from.0);
    // the key a burned run skips to, once this rotation burned an epoch itself
    let mut skip_below: Option<EpochKey> = None;
    // A member with no usable key is skipped rather than blocking the rotation: the removed
    // member must lose the key now; the skipped one is wrapped by a repair later.
    let targets = rotation_targets(&w.kr, &me_b58, exclude);
    let removing = !exclude.is_empty();
    if removing {
        member_list_is_stable(signer, repo, &me_b58, exclude, &targets).await?;
    }
    let cfg = w.kr.config();
    let mut burned = None;
    loop {
        let epoch = from
            .0
            .checked_add(1)
            .ok_or_else(|| Error::Config("key epoch overflow".into()))?;
        let pending = pending_key(&w.kr, w.me, epoch);
        let resumed = pending.is_some();
        let (key, adopted) = self_wrap(
            signer,
            &w,
            epoch,
            pending.map_or_else(EpochKey::generate, Ok)?,
        )
        .await?;
        test_fault("after-self-wrap")?;
        let strays = !stray_wraps(signer, &w, repo, epoch, &targets)
            .await?
            .is_empty();
        let mut facts = KeyFacts {
            removing,
            resumed,
            adopted,
            strays,
            unusable: false,
        };
        let mut step = step_for(facts);
        let (mut wrapped, mut skipped) = (Vec::new(), Vec::new());
        if step == Step::Use {
            match wrap_all(signer, &w, epoch, &key, &targets).await? {
                Ok((a, b)) => (wrapped, skipped) = (a, b),
                Err(member) => {
                    tracing::info!(epoch, %member, "a resumed epoch holds an unusable wrap; burning it");
                    facts.unusable = true;
                    step = step_for(facts);
                }
            }
        }
        if step == Step::Burn {
            if burned.is_some() {
                return Err(UserError::new(
                    codes::ROTATION_PENDING,
                    format!("key epoch {epoch} needs burning too; it was left unanchored"),
                )
                .fix(format!(
                    "run `dg repo keys repair {}` again",
                    repo.display()
                ))
                .into());
            }
            // C1: every remaining member gets the burned key, so any maintainer sees the burn
            // and can chain from it; nothing is ever sealed under it. Wraps that cannot be
            // posted (no key, a standing one that cannot be replaced) are skipped.
            wrap_remaining(signer, &w, epoch, &key, &targets).await?;
            let link = next_link(&w.kr, &from, from_burned, true, None)?;
            let input = AnchorInput::current(cfg, epoch, &key, Some(link));
            if !anchor_and_confirm(signer, &w, repo, &input).await? {
                // another maintainer's anchor for this epoch won: theirs stands, and posting
                // n + 2 from a key that is not the epoch's would fork the chain
                return Ok(Rotation {
                    epoch,
                    ..Rotation::default()
                });
            }
            test_fault("after-burn-anchor")?;
            burned = Some(epoch);
            if !from_burned {
                skip_below = Some(from.1.clone());
            }
            from = (epoch, key);
            from_burned = true;
            continue;
        }
        if let Some(stray) = stray_wraps(signer, &w, repo, epoch, &targets)
            .await?
            .first()
        {
            return Err(stray_error(epoch, *stray));
        }
        let link = next_link(&w.kr, &from, from_burned, false, skip_below.as_ref())?;
        let input = AnchorInput::current(cfg, epoch, &key, Some(link));
        let won = anchor_and_confirm(signer, &w, repo, &input).await?;
        return Ok(Rotation {
            epoch,
            wrapped,
            skipped,
            won,
            burned,
        });
    }
}

fn require_rotator(kr: &Keyring, repo: &RepoRef) -> Result<()> {
    if kr.reader_role() == Some(Role::Maintainer) {
        return Ok(());
    }
    Err(Error::NotPermitted {
        action: format!("rotate the key of {}", repo.display()),
        reason: "only a current maintainer can rotate a private repository's key".into(),
        needs: "maintainer".into(),
    })
}

/// Post `anchor` (the commit point), then wait for a proved read that lists the epoch's configs
/// and say whether its anchor is this one: the same author **and** the same commitment
/// (`select_anchors` orders by `($createdAtBlockHeight, raw $id)` among current maintainers). A
/// resumed run may post a second anchor with the same key; the first is still this signer's.
async fn anchor_and_confirm(
    signer: &PrivateSigner<'_>,
    w: &WriteCtx,
    repo: &RepoRef,
    anchor: &AnchorInput<'_>,
) -> Result<bool> {
    signer.post_anchor(w, anchor).await?;
    let ours = *EpochKeys::derive(&w.scope.repo_id, anchor.epoch, anchor.key).commit();
    signer
        .poll(w, repo, ANCHOR_POLLS, |now| {
            let a = now.resolution.anchors.get(&anchor.epoch)?;
            Some(a.owner == w.me && a.commit == Some(ours))
        })
        .await?
        .ok_or(Error::Timeout { retryable: true })
}

/// Wrap a burned epoch's key to every target but self (already wrapped); a member who cannot
/// be wrapped is skipped (nothing is sealed under a burned key, and `n + 2` wraps everyone).
async fn wrap_remaining(
    signer: &PrivateSigner<'_>,
    w: &WriteCtx,
    epoch: u32,
    key: &EpochKey,
    targets: &[String],
) -> Result<()> {
    for t in &targets[1..] {
        signer
            .post_wrap(w, epoch, key, platform::decode_identifier(t)?)
            .await?;
    }
    Ok(())
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

/// What [`reanchor_before_removal`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reanchor {
    /// Epochs re-anchored under the same key, chain link and burned flag.
    pub reanchored: Vec<u32>,
    /// Epochs that stop existing with the removal (§5.3 contiguity): the leaving maintainer
    /// anchored every one of them, no maintainer who stays wrote or received a wrap for them,
    /// and nothing readable sits above them. The next rotation takes the lowest number again.
    pub dropped: Vec<u32>,
    /// Members who stay and hold a wrap for a dropped epoch: content under it becomes
    /// unreadable to them too.
    pub losing: Vec<String>,
}

/// Which of `leaving`'s anchors a remover re-anchors, and the epochs that go (pure; §5.3):
/// `Ok((reanchor, top))` where `top` is the current epoch once `leaving` is gone. `leaving`'s
/// lowest unreadable epoch and everything above it are dropped, but only when `leaving`
/// anchored all of them, nothing above it is readable to the remover, and no maintainer who
/// stays wrote or received a wrap for any of them (`rows`: wrap rows are public, so this needs
/// no keys; a remover whose own wrap lags must not drop an epoch another maintainer holds).
/// `Err(e)` when the removal needs a maintainer who can read epoch `e`: dropping it is not
/// allowed, or `e` is the surviving current epoch and the remover cannot chain the removal's
/// rotation from it (`None`: nothing would survive at all). Refused before anything is written.
fn reanchor_plan(
    res: &EpochResolution,
    rows: &Rows,
    leaving: [u8; 32],
) -> std::result::Result<(Vec<u32>, Option<u32>), Option<u32>> {
    let Some(current) = res.current_epoch else {
        return Ok((Vec::new(), None));
    };
    let theirs: Vec<u32> = res
        .anchors
        .iter()
        .filter(|(_, a)| a.owner == leaving)
        .map(|(&e, _)| e)
        .collect();
    let lost = theirs.iter().copied().find(|e| !res.keys.contains_key(e));
    let staying: BTreeSet<[u8; 32]> = rows
        .members
        .iter()
        .filter(|m| m.role == Role::Maintainer && m.identity != leaving)
        .map(|m| m.identity)
        .collect();
    let droppable = |u: u32| {
        !res.keys.keys().any(|&r| r > u)
            && (u..=current).all(|e| res.anchors.get(&e).is_some_and(|a| a.owner == leaving))
            && !rows.wraps.iter().any(|w| {
                // the leaving maintainer's own wraps stop counting with the role (§5.4 (2)),
                // and could otherwise pin an epoch they alone can read
                w.owner != leaving
                    && w.epoch >= u
                    && w.epoch <= current
                    && (staying.contains(&w.owner) || staying.contains(&w.member_id))
            })
    };
    let top = match lost {
        None => current,
        Some(u) if !droppable(u) => return Err(Some(u)),
        // nothing would be left to chain a rotation from
        Some(0) => return Err(None),
        Some(u) => u - 1,
    };
    if !res.keys.contains_key(&top) {
        return Err(Some(top));
    }
    Ok((
        theirs.into_iter().filter(|&e| e <= top).collect(),
        Some(top),
    ))
}

/// Whether `after` (the resolution once `leaving` is gone and the re-anchors landed) keeps
/// every epoch up to `top` as it was in `before`: the same anchor commitments and burned flags,
/// every key the remover held, a readable `top` to rotate from, and no new broken chain link.
/// `Err` names the first epoch that changed.
fn removal_preserves(
    before: &EpochResolution,
    after: &EpochResolution,
    top: u32,
) -> std::result::Result<(), u32> {
    if after.current_epoch != Some(top) {
        return Err(after.current_epoch.map_or(0, |c| c.min(top)));
    }
    for e in 0..=top {
        let commit = |r: &EpochResolution| r.anchors.get(&e).map(|a| a.commit);
        if commit(before) != commit(after)
            || before.burned.contains(&e) != after.burned.contains(&e)
            || (before.keys.contains_key(&e) && !after.keys.contains_key(&e))
        {
            return Err(e);
        }
    }
    if !after.keys.contains_key(&top) {
        return Err(top);
    }
    let broken = |r: &EpochResolution| -> BTreeSet<u32> {
        r.alerts
            .iter()
            .filter_map(|a| match a {
                Alert::ChainBroken { epoch, .. } => Some(*epoch),
                _ => None,
            })
            .collect()
    };
    match broken(after).difference(&broken(before)).next() {
        Some(&e) => Err(e),
        None => Ok(()),
    }
}

/// Before `leaving` loses the maintainer role: re-anchor every epoch whose anchor `leaving`
/// wrote, under the same key, chain link and burned flag, so each epoch keeps its commitment
/// once `leaving`'s configs stop counting (§5.3). Otherwise the current epoch would fall back to
/// an older one (a key earlier removed members hold) and the epoch's content would open under
/// nobody's key. Then check, on a proved read with `leaving` taken out, that nothing up to the
/// surviving current epoch changed; refuse (nothing removed) if it did.
pub async fn reanchor_before_removal(
    signer: &PrivateSigner<'_>,
    repo: &RepoRef,
    leaving: &str,
) -> Result<Reanchor> {
    let w = signer.open(repo).await?;
    let leaving = platform::decode_identifier(leaving)?;
    if leaving == w.me {
        let mine = anchored_by(&w.kr.resolution, w.me);
        if mine.is_empty() {
            return Ok(Reanchor::default());
        }
        return Err(UserError::new(
            codes::ROTATION_PENDING,
            format!(
                "you can't remove your own maintainer role while you anchor key epochs {mine:?} of {}",
                repo.display()
            ),
        )
        .cause("your anchors stop counting with the role and nobody can re-anchor them first: every epoch from the lowest of them up would stop existing")
        .fix("keep the role")
        .note("nothing was removed")
        .into());
    }
    let before = &w.kr.resolution;
    let (theirs, top) =
        reanchor_plan(before, &w.kr.rows, leaving).map_err(|e| unremovable(repo, leaving, e))?;
    let Some(top) = top else {
        return Ok(Reanchor::default());
    };
    let dropped: Vec<u32> = (top + 1..=before.current_epoch.unwrap_or(top)).collect();
    let losing: BTreeSet<[u8; 32]> =
        w.kr.rows
            .wraps
            .iter()
            .filter(|x| dropped.contains(&x.epoch) && x.member_id != leaving)
            .filter(|x| w.kr.rows.members.iter().any(|m| m.identity == x.member_id))
            .map(|x| x.member_id)
            .collect();
    let mut out = Reanchor {
        reanchored: Vec::new(),
        dropped,
        losing: losing
            .into_iter()
            .map(platform::encode_identifier)
            .collect(),
    };
    let cfg = w.kr.config();
    for epoch in theirs {
        let key = &before.keys[&epoch];
        let input = AnchorInput::current(cfg, epoch, key, w.kr.link_of(epoch)?);
        signer.post_anchor(&w, &input).await?;
        out.reanchored.push(epoch);
    }
    // Wraps from `leaving` stop counting with their role too (§5.4 (2)). If this signer's only
    // accepted wrap of `top` is theirs, it would lose the epoch it must chain the coming
    // rotation from: wrap it to itself first (older epochs follow through the chain).
    let posted =
        wrap_held_through(signer, &w, repo, leaving, top).await? || !out.reanchored.is_empty();
    confirm_removal(signer, &w, repo, leaving, top, posted)
        .await
        .map(|()| out)
}

/// Wrap to this signer every epoch up to `top` it reads only through `leaving`'s wraps (they
/// stop counting with the role, §5.4 (2), and the chain may not reach the epoch from `top`), and
/// `top` itself when so. Returns whether anything was posted; a standing self-wrap with another
/// key is an error (a wrap cannot be replaced within an epoch).
async fn wrap_held_through(
    signer: &PrivateSigner<'_>,
    w: &WriteCtx,
    repo: &RepoRef,
    leaving: [u8; 32],
    top: u32,
) -> Result<bool> {
    let before = &w.kr.resolution;
    let maintainers: BTreeSet<[u8; 32]> =
        w.kr.rows
            .members
            .iter()
            .filter(|m| m.role == Role::Maintainer && m.identity != leaving)
            .map(|m| m.identity)
            .collect();
    let held_otherwise = |e: u32| held_from_others(&w.kr.wraps, before, &maintainers, w.me, e);
    // every epoch this signer reads only through `leaving`'s wraps (the chain may not reach it
    // from `top` once those stop counting): wrap it to itself first
    let only_theirs: Vec<u32> =
        w.kr.wraps
            .iter()
            .filter(|x| x.member == w.me && x.owner == leaving && x.key.is_some())
            .map(|x| x.epoch)
            .filter(|&e| e <= top && !held_otherwise(e))
            .chain((!held_otherwise(top)).then_some(top))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
    let mut posted = false;
    for e in only_theirs {
        let Some(key) = before.keys.get(&e).cloned() else {
            continue;
        };
        let (_, adopted) = self_wrap(signer, w, e, key).await?;
        if adopted {
            return Err(UserError::new(
                codes::ROTATION_PENDING,
                format!("your own key wrap for epoch {e} of {} holds another key", repo.display()),
            )
            .cause("an earlier run of yours (a rotation that lost a race) left it, and a wrap cannot be replaced within an epoch")
            .fix(format!("run `dg repo keys rotate {}` first, then the removal", repo.display()))
            .note("nothing was removed")
            .into());
        }
        posted = true;
    }
    Ok(posted)
}

/// Whether `me` holds epoch `e`'s key through a wrap from a maintainer who stays, carrying the
/// very key the resolution uses for `e` (a wrap of another key, a race loser's, proves nothing).
fn held_from_others(
    wraps: &[WrapDoc],
    before: &EpochResolution,
    staying: &BTreeSet<[u8; 32]>,
    me: [u8; 32],
    e: u32,
) -> bool {
    wraps.iter().any(|x| {
        x.epoch == e
            && x.member == me
            && staying.contains(&x.owner)
            && x.key.is_some()
            && x.key.as_ref() == before.keys.get(&e)
    })
}

/// Poll until the resolution without `leaving` keeps every epoch up to `top` as it was
/// ([`removal_preserves`]): a later config of the same epoch by another current maintainer,
/// earlier than the re-anchor, would become the anchor instead, so the outcome is checked, not
/// the intent. The refusal names who took an anchor over.
async fn confirm_removal(
    signer: &PrivateSigner<'_>,
    w: &WriteCtx,
    repo: &RepoRef,
    leaving: [u8; 32],
    top: u32,
    posted: bool,
) -> Result<()> {
    let before = &w.kr.resolution;
    let polls = if posted { ANCHOR_POLLS } else { 1 };
    let mut changed: Option<(u32, Option<[u8; 32]>)> = None;
    let ok = signer
        .poll(w, repo, polls, |now| {
            let after = now.resolution_if(leaving, false);
            match removal_preserves(before, &after, top) {
                Ok(()) => Some(()),
                Err(e) => {
                    let by = displaced_by(before, &after, e, w.me);
                    changed = Some((e, by));
                    None
                }
            }
        })
        .await?;
    if ok.is_some() {
        return Ok(());
    }
    let (epoch, by) = changed.unwrap_or((top, None));
    let mut err = UserError::new(
        codes::ROTATION_PENDING,
        format!(
            "removing {} would change key epoch {epoch} of {}",
            platform::encode_identifier(leaving),
            repo.display()
        ),
    )
    .cause("once their key statements stop counting, that epoch's anchor, burned flag or chain link would differ from today's (or the re-anchor is not visible yet)");
    if let Some(by) = by {
        err = err.cause(format!(
            "a config for epoch {epoch} by {} would take over its anchor; remove them first",
            platform::encode_identifier(by)
        ));
    }
    Err(err
        .fix("run the command again in a moment; if it keeps failing, run `dg repo keys status`")
        .note("nothing was removed")
        .into())
}

/// Who took over epoch `e`'s anchor in `after` (the resolution once the leaving maintainer is
/// gone): named only when the commitment actually changed and it is not this signer.
fn displaced_by(
    before: &EpochResolution,
    after: &EpochResolution,
    e: u32,
    me: [u8; 32],
) -> Option<[u8; 32]> {
    let a = after.anchors.get(&e)?;
    let was = before.anchors.get(&e).and_then(|b| b.commit);
    (a.commit != was && a.owner != me).then_some(a.owner)
}

/// The existing epochs `who` anchors: a maintainer cannot drop their own role while this is not
/// empty, since nobody could re-anchor them first (§5.3).
fn anchored_by(res: &EpochResolution, who: [u8; 32]) -> Vec<u32> {
    res.anchors
        .iter()
        .filter(|(_, a)| a.owner == who)
        .map(|(&e, _)| e)
        .collect()
}

/// The refusal of a maintainer removal that would lose readable epochs (see [`reanchor_plan`]).
fn unremovable(repo: &RepoRef, leaving: [u8; 32], epoch: Option<u32>) -> Error {
    let who = platform::encode_identifier(leaving);
    let what = epoch.map_or_else(
        || "the repository's first key epoch".to_string(),
        |e| format!("key epoch {e}"),
    );
    UserError::new(
        codes::ROTATION_PENDING,
        format!("removing {who} from {} needs a maintainer who can read {what}", repo.display()),
    )
    .cause("you cannot read it: either it would stop existing with every epoch above it while another maintainer, or an epoch above it, still holds it, or it stays current and the removal's rotation must chain from it")
    .fix("ask a maintainer who holds that epoch to wrap it to you (if it is the current epoch, `dg repo keys repair` on their side does it), then run the removal again")
    .note("nothing was removed")
    .into()
}

/// (Removal) Two reads of the member list that disagree mean a node is behind: nothing is
/// wrapped from a list that may still name the member being removed.
async fn member_list_is_stable(
    signer: &PrivateSigner<'_>,
    repo: &RepoRef,
    me: &str,
    exclude: &[String],
    targets: &[String],
) -> Result<()> {
    let again = MemberReader::new(signer.client).list(repo).await?;
    if targets_of(&again, me, exclude) == targets {
        return Ok(());
    }
    Err(UserError::new(
        codes::ROTATION_PENDING,
        "the member list changed between two reads; nothing was rotated",
    )
    .fix("run the command again in a moment")
    .into())
}

/// Every wrap this signer posted at `epoch` to someone outside `targets`, on a fresh read: one
/// (an earlier run's, hidden from the first read) would hand them the key.
async fn stray_wraps(
    signer: &PrivateSigner<'_>,
    w: &WriteCtx,
    repo: &RepoRef,
    epoch: u32,
    targets: &[String],
) -> Result<Vec<[u8; 32]>> {
    let allowed: BTreeSet<[u8; 32]> = targets
        .iter()
        .filter_map(|t| platform::decode_identifier(t).ok())
        .collect();
    let now = signer.reload(w, repo).await?;
    Ok(now
        .wraps
        .iter()
        .filter(|x| x.epoch == epoch && x.owner == w.me && !allowed.contains(&x.member))
        .map(|x| x.member)
        .collect())
}

fn stray_error(epoch: u32, stray: [u8; 32]) -> Error {
    UserError::new(
        codes::ROTATION_PENDING,
        format!(
            "key epoch {epoch} was also wrapped to {}; nothing was anchored",
            platform::encode_identifier(stray)
        ),
    )
    .cause("an earlier run's wrap to someone outside the remaining members stands at this epoch")
    .fix("run the command again: it closes that epoch (burned) and rotates past it")
    .into()
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
/// non-member or burned (§5.3; `repair.rotate` either way, excluding the non-members, if any),
/// else wrap each member with no wrap to an enabled key. A maintainer only.
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
            key: key.map(|b| EpochKey::from_bytes([b; 32])),
        }
    }

    /// Rows for `resolve_epochs`, built with `config`/`wrap`; `keyring(reader)` resolves them.
    struct Fixture {
        repo_id: [u8; 32],
        members: Vec<MemberRow>,
        configs: Vec<ConfigRow>,
        wraps: Vec<WrapRow>,
    }

    fn k(b: u8) -> EpochKey {
        EpochKey::from_bytes([b; 32])
    }

    impl Fixture {
        fn new(members: &[([u8; 32], Role)]) -> Self {
            Self {
                repo_id: [0x11; 32],
                members: members
                    .iter()
                    .map(|&(identity, role)| MemberRow {
                        identity,
                        role,
                        created_at: 1,
                    })
                    .collect(),
                configs: Vec::new(),
                wraps: Vec::new(),
            }
        }

        /// A config for `epoch` under key byte `key`, chaining to `prev` (key byte), by `owner`.
        fn config(
            &mut self,
            owner: [u8; 32],
            epoch: u32,
            key: u8,
            prev: Option<u8>,
            height: u64,
            burned: bool,
        ) -> &mut Self {
            let keys = EpochKeys::derive(&self.repo_id, epoch, &k(key));
            let fields = Fields {
                default_branch: Some("main".into()),
                prev_epoch: prev.map(|_| epoch - 1),
                prev_epoch_key: prev.filter(|_| !burned).map(k),
                burned,
                ..Fields::default()
            };
            let enc = crate::private::doc::seal(
                &keys,
                &DocHeader::new(DocKind::Config, owner, epoch),
                &fields,
            )
            .unwrap();
            let n = u8::try_from(self.configs.len()).unwrap();
            self.configs.push(ConfigRow {
                id: [0x40 + n; 32],
                owner,
                epoch,
                created_at_block_height: height,
                created_at: height,
                enc,
            });
            self
        }

        /// A wrap of key byte `key` for `epoch` from `owner` to `member` (opened: `member` is
        /// the reader).
        fn wrap(&mut self, owner: [u8; 32], member: [u8; 32], epoch: u32, key: u8) -> &mut Self {
            let n = u8::try_from(self.wraps.len()).unwrap();
            self.wraps.push(WrapRow {
                id: [0x80 + n; 32],
                owner,
                member_id: member,
                epoch,
                recipient_key_id: 4,
                key_enabled: true,
                key: Some(k(key)),
            });
            self
        }

        fn rows(&self) -> Rows {
            Rows {
                members: self.members.clone(),
                configs: self.configs.clone(),
                wraps: self.wraps.clone(),
            }
        }

        fn keyring(&self, reader: [u8; 32]) -> Keyring {
            let resolution = resolve_epochs(
                &self.repo_id,
                &reader,
                &self.members,
                &self.configs,
                &self.wraps,
            );
            Keyring {
                repo_id: self.repo_id,
                reader,
                members: self
                    .members
                    .iter()
                    .map(|m| member(m.identity, m.role))
                    .collect(),
                configs: Vec::new(),
                wraps: Vec::new(),
                ctx: resolution.open_context(&self.repo_id),
                resolution,
                rows: self.rows(),
                config: PrivateConfig::default(),
                unreadable_wraps: Vec::new(),
            }
        }
    }

    fn test_repo() -> RepoRef {
        RepoRef {
            forge: crate::network::ForgeIds {
                core: "C".into(),
                collab: "L".into(),
                group: "G".into(),
                superseded_in_group: vec![],
            },
            repo_id: "R".into(),
            owner_id: "alice".into(),
            name: "proj".into(),
            visibility: crate::rules::v2::Visibility::Private,
        }
    }

    const ALICE: [u8; 32] = [1; 32];
    const BOB: [u8; 32] = [2; 32];
    const DAVE: [u8; 32] = [4; 32];

    /// Epochs 0..=2 by alice (keys 10, 11, 12), all wrapped to alice at 2.
    fn three_epochs(members: &[([u8; 32], Role)]) -> Fixture {
        let mut f = Fixture::new(members);
        f.config(ALICE, 0, 10, None, 10, false)
            .config(ALICE, 1, 11, Some(10), 20, false)
            .config(ALICE, 2, 12, Some(11), 30, false)
            .wrap(ALICE, ALICE, 2, 12);
        f
    }

    #[test]
    fn a_rotation_chains_from_a_burned_current_epoch_it_cannot_write_under() {
        let mut f = Fixture::new(&[(ALICE, Role::Maintainer)]);
        f.config(ALICE, 0, 10, None, 10, false)
            .config(ALICE, 1, 11, Some(10), 20, true)
            .wrap(ALICE, ALICE, 1, 11);
        let kr = f.keyring(ALICE);
        let repo = test_repo();
        assert!(
            kr.writer(&repo).is_err(),
            "nothing is written under a burned epoch"
        );
        let (n, key) = chain_from(&kr, &repo).unwrap();
        assert_eq!(
            (n, key),
            (1, k(11)),
            "the next epoch is 2, chained from burned 1"
        );
        assert_eq!(kr.burned_by(), Some((1, ALICE)));
        let r = kr.resolution.repair.as_ref().unwrap();
        assert!(
            r.rotate && r.non_members.is_empty(),
            "repair rotates with nobody to exclude"
        );
    }

    #[test]
    fn a_pending_self_wrap_is_the_next_epochs_key() {
        let mut kr = Fixture::new(&[(ALICE, Role::Maintainer), (BOB, Role::Writer)]).keyring(ALICE);
        kr.wraps = vec![
            wrap(ALICE, ALICE, 1, Some(9)),
            wrap(ALICE, BOB, 1, None),
            wrap(BOB, ALICE, 2, Some(7)),
        ];
        assert_eq!(pending_key(&kr, ALICE, 1), Some(k(9)));
        assert_eq!(
            pending_key(&kr, ALICE, 2),
            None,
            "only this signer's own self-wrap"
        );
    }

    #[test]
    fn removing_a_maintainer_drops_only_their_unreadable_top_epochs() {
        let members = [(ALICE, Role::Maintainer), (DAVE, Role::Maintainer)];
        // dave anchored epoch 3 and wrapped it only to himself
        let mut f = three_epochs(&members);
        f.config(DAVE, 3, 13, Some(12), 40, false);
        let before = f.keyring(ALICE).resolution;
        assert_eq!(before.current_epoch, Some(3));
        assert_eq!(
            reanchor_plan(&before, &f.rows(), DAVE),
            Ok((vec![], Some(2)))
        );
        // an epoch 4 chaining from it makes it readable through the chain: re-anchored
        let mut g = three_epochs(&members);
        g.config(DAVE, 3, 13, Some(12), 40, false)
            .config(ALICE, 4, 14, Some(13), 50, false)
            .wrap(ALICE, ALICE, 4, 14);
        assert_eq!(
            reanchor_plan(&g.keyring(ALICE).resolution, &g.rows(), DAVE),
            Ok((vec![3], Some(4)))
        );
        // unreadable (4's link to it is broken) with a readable epoch above: cannot be dropped
        f.config(ALICE, 4, 14, Some(0x55), 50, false)
            .wrap(ALICE, ALICE, 4, 14);
        let before = f.keyring(ALICE).resolution;
        assert_eq!(reanchor_plan(&before, &f.rows(), DAVE), Err(Some(3)));
        // carol anchored epoch 3 (unreadable to alice), dave epoch 4: 3 survives as current and
        // alice cannot rotate from it, so she cannot remove dave (refused before any write)
        let carol = [3; 32];
        let mut h = three_epochs(&[
            (ALICE, Role::Maintainer),
            (DAVE, Role::Maintainer),
            (carol, Role::Maintainer),
        ]);
        h.config(carol, 3, 13, Some(12), 40, false)
            .config(DAVE, 4, 14, Some(13), 50, false);
        assert_eq!(
            reanchor_plan(&h.keyring(ALICE).resolution, &h.rows(), DAVE),
            Err(Some(3))
        );
        // dave's readable anchors are re-anchored
        let f = {
            let mut g = Fixture::new(&members);
            g.config(ALICE, 0, 10, None, 10, false)
                .config(DAVE, 1, 11, Some(10), 20, false)
                .config(ALICE, 2, 12, Some(11), 30, false)
                .wrap(ALICE, ALICE, 2, 12);
            g
        };
        let before = f.keyring(ALICE).resolution;
        assert_eq!(
            reanchor_plan(&before, &f.rows(), DAVE),
            Ok((vec![1], Some(2)))
        );
    }

    #[test]
    fn an_epoch_a_staying_maintainer_holds_is_never_dropped() {
        let carol = [3; 32];
        let members = [
            (ALICE, Role::Maintainer),
            (DAVE, Role::Maintainer),
            (carol, Role::Maintainer),
        ];
        // dave anchored epoch 3; alice's wrap for it lags, while carol (who stays) wrapped it
        // to herself: she holds it
        let mut f = three_epochs(&members);
        f.config(DAVE, 3, 13, Some(12), 40, false);
        f.wraps.push(WrapRow {
            key: None,
            ..f.wraps[0].clone()
        });
        let last = f.wraps.len() - 1;
        f.wraps[last].epoch = 3;
        f.wraps[last].owner = carol;
        f.wraps[last].member_id = carol;
        assert_eq!(
            reanchor_plan(&f.keyring(ALICE).resolution, &f.rows(), DAVE),
            Err(Some(3))
        );
        // dave's wrap for it, only to a writer who stays: dropped, and they are named
        f.wraps[last].owner = DAVE;
        f.wraps[last].member_id = BOB;
        f.members.push(MemberRow {
            identity: BOB,
            role: Role::Writer,
            created_at: 1,
        });
        assert_eq!(
            reanchor_plan(&f.keyring(ALICE).resolution, &f.rows(), DAVE),
            Ok((vec![], Some(2)))
        );
    }

    #[test]
    fn a_regranted_maintainers_preposted_future_config_is_inert() {
        let members = [(ALICE, Role::Maintainer), (BOB, Role::Writer)];
        let mut f = three_epochs(&members);
        // dave, a past maintainer, pre-posted epoch 4: above the gap at 3, invisible today
        f.config(DAVE, 4, 14, Some(13), 25, false);
        let kr = f.keyring(ALICE);
        assert_eq!(kr.resolution.current_epoch, Some(2));
        assert_eq!(
            kr.maintainer_would_move_anchors(DAVE),
            None,
            "a config posted before the epoch below it was stated never counts (§5.3)"
        );
    }

    #[test]
    fn a_rotation_burns_what_may_have_leaked_and_uses_the_rest() {
        let f = KeyFacts::default;
        assert_eq!(step_for(f()), Step::Use);
        let resumed = KeyFacts {
            resumed: true,
            ..f()
        };
        assert_eq!(step_for(resumed), Step::Use, "a plain rotation resumes");
        let removing = KeyFacts {
            removing: true,
            ..f()
        };
        assert_eq!(step_for(removing), Step::Use, "a removal with a fresh key");
        assert_eq!(
            step_for(KeyFacts {
                resumed: true,
                ..removing
            }),
            Step::Burn,
            "never resumes"
        );
        assert_eq!(
            step_for(KeyFacts {
                adopted: true,
                ..removing
            }),
            Step::Burn,
            "nor adopts"
        );
        assert_eq!(
            step_for(KeyFacts {
                strays: true,
                ..f()
            }),
            Step::Burn,
            "a visible stray"
        );
        assert_eq!(
            step_for(KeyFacts {
                unusable: true,
                ..resumed
            }),
            Step::Burn,
            "unreplaceable"
        );
    }

    #[test]
    fn a_burned_anchor_carries_no_key_below_and_the_next_one_skips_the_run() {
        let kr = three_epochs(&[(ALICE, Role::Maintainer)]).keyring(ALICE);
        let from = (2, k(12));
        let burn = next_link(&kr, &from, false, true, None).unwrap();
        assert_eq!(
            (
                burn.prev,
                burn.prev_key.is_none(),
                burn.skip_key.is_none(),
                burn.burned
            ),
            (2, true, true, true)
        );
        // right after burning 3 (from 2): epoch 4 chains to 3 and skips to 2
        let after = next_link(&kr, &(3, k(13)), true, false, Some(&k(12))).unwrap();
        assert_eq!(after.prev, 3);
        assert_eq!(after.prev_key, Some(k(13)));
        assert_eq!(after.skip_key, Some(k(12)));
        // a plain link has no skip key
        let plain = next_link(&kr, &from, false, false, None).unwrap();
        assert_eq!((plain.prev_key, plain.skip_key), (Some(k(12)), None));
    }

    #[test]
    fn any_maintainer_finishes_a_burn_it_was_wrapped() {
        // alice burned epoch 1 and crashed; the burn path wrapped K_1 to carol (a maintainer)
        let carol = [3; 32];
        let mut f = Fixture::new(&[(ALICE, Role::Maintainer), (carol, Role::Maintainer)]);
        f.config(ALICE, 0, 10, None, 10, false)
            .config(ALICE, 1, 11, Some(10), 20, true)
            .wrap(ALICE, carol, 0, 10)
            .wrap(ALICE, carol, 1, 11);
        let kr = f.keyring(carol);
        let repo = test_repo();
        assert_eq!(kr.burned_by(), Some((1, ALICE)), "carol sees the burn");
        assert_eq!(
            chain_from(&kr, &repo).unwrap(),
            (1, k(11)),
            "and can chain from it"
        );
        let r = kr.resolution.repair.as_ref().unwrap();
        assert!(r.rotate, "her repair rotates");
        // the rotation's anchor for 2 skips the burned run down to epoch 0
        let link = next_link(&kr, &(1, k(11)), true, false, None).unwrap();
        assert_eq!((link.prev, link.skip_key), (1, Some(k(10))));
    }

    #[test]
    fn an_owner_cannot_drop_their_role_while_anchoring_an_epoch() {
        let f = three_epochs(&[(ALICE, Role::Maintainer), (DAVE, Role::Maintainer)]);
        let kr = f.keyring(ALICE);
        assert_eq!(anchored_by(&kr.resolution, ALICE), vec![0, 1, 2]);
        assert!(
            anchored_by(&kr.resolution, DAVE).is_empty(),
            "dave may leave"
        );
    }

    #[test]
    fn the_leaving_maintainers_own_wraps_never_pin_an_epoch() {
        // dave anchored 3 and wrapped it only to alice (the remover), with a key she can't use
        let mut f = three_epochs(&[(ALICE, Role::Maintainer), (DAVE, Role::Maintainer)]);
        f.config(DAVE, 3, 13, Some(12), 40, false);
        f.wraps.push(WrapRow {
            id: [0xee; 32],
            owner: DAVE,
            member_id: ALICE,
            epoch: 3,
            recipient_key_id: 4,
            key_enabled: true,
            key: None,
        });
        let kr = f.keyring(ALICE);
        assert_eq!(
            reanchor_plan(&kr.resolution, &f.rows(), DAVE),
            Ok((vec![], Some(2)))
        );
    }

    #[test]
    fn content_older_than_an_epochs_current_anchor_is_an_earlier_use() {
        let kr = three_epochs(&[(ALICE, Role::Maintainer)]).keyring(ALICE);
        // epoch 2's anchor is at height 30
        assert!(kr.earlier_use(2, Some(29)));
        assert!(!kr.earlier_use(2, Some(30)));
        assert!(!kr.earlier_use(2, None));
        assert!(!kr.earlier_use(9, Some(1)), "no such epoch");
    }

    #[test]
    fn a_removal_refusal_names_only_who_changed_the_commitment() {
        let before = three_epochs(&[(ALICE, Role::Maintainer), (DAVE, Role::Maintainer)])
            .keyring(ALICE)
            .resolution;
        // the same commitment re-anchored by dave: nobody displaced anything
        let mut after = before.clone();
        after.anchors.get_mut(&1).unwrap().owner = DAVE;
        assert_eq!(displaced_by(&before, &after, 1, ALICE), None);
        // another commitment: dave took it over
        after.anchors.get_mut(&1).unwrap().commit = Some([0x77; 32]);
        assert_eq!(displaced_by(&before, &after, 1, ALICE), Some(DAVE));
        // never the remover itself
        after.anchors.get_mut(&1).unwrap().owner = ALICE;
        assert_eq!(displaced_by(&before, &after, 1, ALICE), None);
    }

    #[test]
    fn an_earlier_use_is_judged_from_the_keys_first_statement_not_the_reanchor() {
        let mut f = Fixture::new(&[(ALICE, Role::Maintainer), (DAVE, Role::Maintainer)]);
        f.config(ALICE, 0, 10, None, 10, false)
            .config(DAVE, 1, 11, Some(10), 20, false)
            .config(ALICE, 1, 11, Some(10), 50, false)
            .wrap(ALICE, ALICE, 1, 11);
        // dave is gone: alice's re-anchor at 50 is the anchor, but K_1 was stated at 20
        f.members.retain(|m| m.identity != DAVE);
        let kr = f.keyring(ALICE);
        assert_eq!(kr.resolution.anchors[&1].height, 50);
        assert_eq!(kr.resolution.anchors[&1].stated_height, 20);
        assert!(
            !kr.earlier_use(1, Some(30)),
            "content at 30 is this key's, not an earlier use"
        );
        assert!(kr.earlier_use(1, Some(19)));
    }

    #[test]
    fn nothing_is_written_while_a_non_member_holds_the_current_key() {
        let mallory = [7; 32];
        let mut f = three_epochs(&[(ALICE, Role::Maintainer)]);
        f.wrap(ALICE, mallory, 2, 12);
        let kr = f.keyring(ALICE);
        let err = kr.writer(&test_repo()).map(|_| ()).unwrap_err().to_string();
        assert!(err.contains("a non-member holds the current key"), "{err}");
    }

    #[test]
    fn a_wrap_of_another_key_does_not_count_as_holding_the_epoch() {
        let carol = [3; 32];
        let f = three_epochs(&[(ALICE, Role::Maintainer), (carol, Role::Maintainer)]);
        let before = f.keyring(ALICE).resolution;
        let staying = BTreeSet::from([ALICE, carol]);
        let wrap_of = |key: u8| WrapDoc {
            id: [0xab; 32],
            owner: carol,
            member: ALICE,
            epoch: 2,
            recipient_key_id: 4,
            sender_key_id: 4,
            wrapped: vec![0; 64],
            key: Some(k(key)),
        };
        assert!(held_from_others(
            &[wrap_of(12)],
            &before,
            &staying,
            ALICE,
            2
        ));
        assert!(
            !held_from_others(&[wrap_of(0x55)], &before, &staying, ALICE, 2),
            "a race loser's wrap holds another key"
        );
    }

    #[test]
    fn a_removal_must_keep_every_anchor_burned_flag_and_chain_link() {
        let members = [(ALICE, Role::Maintainer), (DAVE, Role::Maintainer)];
        let mut g = Fixture::new(&members);
        g.config(ALICE, 0, 10, None, 10, false)
            .config(DAVE, 1, 11, Some(10), 20, true)
            .config(ALICE, 2, 12, Some(11), 30, false)
            .wrap(ALICE, ALICE, 2, 12);
        let kr = g.keyring(ALICE);
        let before = kr.resolution.clone();
        // without a re-anchor, epoch 1 has no anchor once dave goes: epoch 2 is above a gap
        assert!(removal_preserves(&before, &kr.resolution_if(DAVE, false), 2).is_err());
        // a re-anchor that drops the burned flag changes epoch 1
        g.config(ALICE, 1, 11, Some(10), 35, false);
        let kr = g.keyring(ALICE);
        assert_eq!(
            removal_preserves(&before, &kr.resolution_if(DAVE, false), 2),
            Err(1)
        );
        // one that repeats it keeps everything
        g.configs.pop();
        g.config(ALICE, 1, 11, Some(10), 35, true);
        let kr = g.keyring(ALICE);
        assert_eq!(
            removal_preserves(&before, &kr.resolution_if(DAVE, false), 2),
            Ok(())
        );
        // a re-anchor under another key changes the commitment
        g.configs.pop();
        g.config(ALICE, 1, 0x77, Some(10), 35, true);
        let kr = g.keyring(ALICE);
        // epoch 1's anchor changes (and with it epoch 2, which came before this key was stated)
        assert_eq!(
            removal_preserves(&before, &kr.resolution_if(DAVE, false), 2),
            Err(1)
        );
    }

    #[test]
    fn adding_a_maintainer_must_not_move_an_anchor() {
        let members = [(ALICE, Role::Maintainer), (BOB, Role::Writer)];
        let mut f = three_epochs(&members);
        assert_eq!(f.keyring(ALICE).maintainer_would_move_anchors(BOB), None);
        // dave, a past maintainer, posted an earlier config for epoch 1 under another key
        f.config(DAVE, 1, 0x77, Some(10), 15, false);
        assert_eq!(
            f.keyring(ALICE).maintainer_would_move_anchors(DAVE),
            Some(1)
        );
        // or a config for epoch 3, which would become the current epoch
        let mut f = three_epochs(&members);
        f.config(DAVE, 3, 13, Some(12), 40, false);
        assert_eq!(
            f.keyring(ALICE).maintainer_would_move_anchors(DAVE),
            Some(3)
        );
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
