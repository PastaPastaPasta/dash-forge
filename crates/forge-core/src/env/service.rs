//! Environments over Platform: read every snapshot of a repository and resolve them
//! ([`Environments::read`]), and save one ([`Environments::save`]). The rules are in the pure
//! modules ([`super::codec`], [`super::chain`]); this file only fetches, opens and writes.

use std::collections::{BTreeMap, BTreeSet};

use futures::StreamExt as _;

use super::chain::{self, EnvHistory, EnvState, Exposure, Resolution, SnapshotRef, State};
use super::codec::{self, ManifestCheck, OpenError, OpenKeys};
use super::format::{diff, Change, Snapshot, Var};
use super::{Audience, MAX_RECIPIENTS};
use crate::error::{Error, Result};
use crate::keyring::{recipient_key, PrivateSigner};
use crate::keystore::BridgeIdentity;
use crate::members::MemberReader;
use crate::platform::{self, LoadedIdentity, PlatformClient};
use crate::private::named::{OwnerKey, Reader, Recipient};
use crate::private::EpochKeys;
use crate::repo::{PackManifestInfo, RepoService};
use crate::rules::v2::Role;
use crate::scope::RepoRef;
use crate::user_error::{codes, UserError};

/// Artifacts fetched at once.
const FETCH_WINDOW: usize = 8;

/// What one authorized snapshot came to for this reader.
#[derive(Debug, Clone)]
pub enum Opened {
    /// It opened.
    Snapshot(Snapshot),
    /// It was fetched and did not open.
    Refused(OpenError),
    /// No copy could be fetched (the message, never content).
    Unfetched(String),
}

impl Opened {
    /// The snapshot, when it opened.
    #[must_use]
    pub fn snapshot(&self) -> Option<&Snapshot> {
        match self {
            Self::Snapshot(s) => Some(s),
            _ => None,
        }
    }

    /// Why it cannot be read, for a person.
    #[must_use]
    pub fn reason(&self) -> String {
        match self {
            Self::Snapshot(_) => String::new(),
            Self::Refused(e) => e.reason().to_owned(),
            Self::Unfetched(why) => format!("it could not be fetched ({why})"),
        }
    }
}

/// Every environment of a repository as one reader sees it.
#[derive(Debug, Clone)]
pub struct Book {
    /// The repository's current maintainers (base58).
    pub maintainers: BTreeSet<String>,
    /// Every kind-8 manifest, newest first, as read.
    pub manifests: Vec<PackManifestInfo>,
    /// What each authorized snapshot came to, by manifest document id.
    pub opened: BTreeMap<String, Opened>,
    /// Authorization, the chains and their heads.
    pub resolution: Resolution,
}

/// A head, as a conflict names it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    /// The snapshot's manifest document id.
    pub id: String,
    /// Who wrote it (base58).
    pub author: String,
    /// When (`$createdAt`, ms).
    pub created_at: u64,
}

impl Head {
    /// The id prefix people type (`--keep`).
    #[must_use]
    pub fn short(&self) -> &str {
        &self.id[..self.id.len().min(10)]
    }
}

/// Why an environment's values cannot be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Blocked {
    /// No environment of that name is readable here (it may still be one this reader cannot
    /// read: `hidden` counts those).
    Missing {
        /// Environments this reader cannot name.
        hidden: usize,
    },
    /// Two or more heads: the values are never merged automatically.
    Conflict(Vec<Head>),
    /// The latest change does not open for this reader.
    Unreadable {
        /// That change.
        head: Head,
        /// Why, for a person.
        reason: String,
    },
}

/// One change in an environment's history.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    /// The snapshot.
    #[serde(flatten)]
    pub head: Head,
    /// The padded, sealed size (what the public sees).
    pub size_bytes: u64,
    /// Who could read it.
    pub audience: Option<Audience>,
    /// The entries it changed against the snapshot it replaced, by name.
    pub changes: Vec<(String, Change)>,
    /// Why it cannot be read, when it cannot.
    pub unreadable: Option<String>,
}

impl Book {
    fn manifest(&self, id: &str) -> Option<&PackManifestInfo> {
        self.manifests.iter().find(|m| m.document_id == id)
    }

    fn head(&self, id: &str) -> Head {
        let m = self.manifest(id);
        Head {
            id: id.to_owned(),
            author: m.map(|m| m.owner_id.clone()).unwrap_or_default(),
            created_at: m.map_or(0, |m| m.created_at),
        }
    }

    /// The snapshot of manifest `id`, when it opened.
    #[must_use]
    pub fn snapshot(&self, id: &str) -> Option<&Snapshot> {
        self.opened.get(id).and_then(Opened::snapshot)
    }

    /// The environment `env`'s state, when this reader can name it.
    #[must_use]
    pub fn state(&self, env: &str) -> Option<&EnvState> {
        self.resolution.env(env)
    }

    /// The values of `env`, or why they cannot be used: a conflict and an unreadable latest
    /// change fail closed (D24).
    pub fn current(&self, env: &str) -> std::result::Result<&Snapshot, Blocked> {
        let Some(state) = self.state(env) else {
            return Err(Blocked::Missing {
                hidden: self.resolution.hidden.len(),
            });
        };
        match state.state {
            State::Current => self
                .snapshot(&state.heads[0])
                .ok_or_else(|| self.unreadable(&state.heads[0])),
            State::Unreadable => Err(self.unreadable(&state.heads[0])),
            State::Conflict => Err(Blocked::Conflict(
                state.heads.iter().map(|h| self.head(h)).collect(),
            )),
        }
    }

    fn unreadable(&self, id: &str) -> Blocked {
        Blocked::Unreadable {
            head: self.head(id),
            reason: self.opened.get(id).map(Opened::reason).unwrap_or_default(),
        }
    }

    /// The heads of `env` (one, or every head of a conflict).
    #[must_use]
    pub fn heads(&self, env: &str) -> Vec<Head> {
        self.state(env)
            .map(|s| s.heads.iter().map(|h| self.head(h)).collect())
            .unwrap_or_default()
    }

    /// `env`'s changes, oldest first, each against the snapshot it replaced (names only).
    #[must_use]
    pub fn history(&self, env: &str) -> Vec<HistoryItem> {
        let Some(state) = self.state(env) else {
            return Vec::new();
        };
        let hash_to_id: BTreeMap<[u8; 32], &str> = state
            .snapshots
            .iter()
            .filter_map(|id| self.manifest(id).map(|m| (m.pack_hash, id.as_str())))
            .collect();
        state
            .snapshots
            .iter()
            .map(|id| {
                let m = self.manifest(id);
                let opened = self.snapshot(id);
                let before = m
                    .and_then(|m| m.supersedes.iter().find_map(|h| hash_to_id.get(h)))
                    .and_then(|p| self.snapshot(p));
                HistoryItem {
                    head: self.head(id),
                    size_bytes: m.map_or(0, |m| m.size_bytes),
                    audience: opened.map(|s| s.audience),
                    changes: opened.map(|s| diff(before, s)).unwrap_or_default(),
                    unreadable: opened
                        .is_none()
                        .then(|| self.opened.get(id).map(Opened::reason).unwrap_or_default()),
                }
            })
            .collect()
    }

    /// The removal checklist for `removed` (base58), who held the members key when
    /// `held_members_key`: the environments and current value names they could read
    /// ([`chain::exposure`]).
    #[must_use]
    pub fn exposure(&self, removed: &str, held_members_key: bool) -> Vec<Exposure> {
        let rows: Vec<(String, Vec<&Snapshot>, Vec<&Snapshot>)> = self
            .resolution
            .environments
            .iter()
            .map(|e| {
                let pick = |ids: &[String]| ids.iter().filter_map(|i| self.snapshot(i)).collect();
                (e.env.clone(), pick(&e.heads), pick(&e.snapshots))
            })
            .collect();
        let histories: Vec<EnvHistory<'_>> = rows
            .iter()
            .map(|(env, heads, all)| EnvHistory {
                env,
                heads,
                snapshots: all,
            })
            .collect();
        chain::exposure(&histories, removed, held_members_key)
    }

    /// What a new snapshot of `env` starts from: the current entries and audience and the
    /// heads it supersedes. On a conflict, `keep` (a head's id or its prefix) picks the entries
    /// and the new snapshot supersedes every head, which resolves it.
    pub fn base(&self, repo: &RepoRef, env: &str, keep: Option<&str>) -> Result<Base> {
        let hashes = |heads: &[Head]| -> Vec<[u8; 32]> {
            heads
                .iter()
                .filter_map(|h| self.manifest(&h.id).map(|m| m.pack_hash))
                .collect()
        };
        match self.current(env) {
            Ok(snap) => {
                if let Some(k) = keep {
                    return Err(UserError::new(
                        codes::USAGE,
                        format!("{env} has no conflict to resolve; --keep {k} is not needed"),
                    )
                    .into());
                }
                Ok(Base {
                    vars: snap.vars.clone(),
                    audience: Some(snap.audience),
                    supersedes: hashes(&self.heads(env)),
                })
            }
            Err(Blocked::Missing { .. }) => Ok(Base {
                vars: BTreeMap::new(),
                audience: None,
                supersedes: Vec::new(),
            }),
            Err(Blocked::Conflict(heads)) => {
                let picked = keep.and_then(|k| {
                    let hits: Vec<&Head> = heads.iter().filter(|h| h.id.starts_with(k)).collect();
                    (hits.len() == 1).then(|| hits[0])
                });
                match picked.and_then(|h| self.snapshot(&h.id)) {
                    Some(snap) => Ok(Base {
                        vars: snap.vars.clone(),
                        audience: Some(snap.audience),
                        supersedes: hashes(&heads),
                    }),
                    None => Err(conflict_error(repo, env, &heads)),
                }
            }
            Err(Blocked::Unreadable { head, reason }) => Err(UserError::new(
                codes::NOT_A_KEY_HOLDER,
                format!(
                    "the latest change to {env} can't be read by you, so it can't be changed from here"
                ),
            )
            .cause(format!(
                "the change by {} at {} ({}) {reason}",
                head.author,
                utc(head.created_at),
                head.short()
            ))
            .fix("ask a maintainer who can read it to make any change: they save it for the current maintainers")
            .note("nothing was written")
            .into()),
        }
    }
}

/// E607 for an environment two people changed at once.
#[must_use]
pub fn conflict_error(repo: &RepoRef, env: &str, heads: &[Head]) -> Error {
    let mut u = UserError::new(
        codes::EDIT_CONFLICT,
        format!(
            "{} people changed {env} at the same time, so its values can't be used until one version is kept",
            heads.len()
        ),
    )
    .cause(format!(
        "{env} in {} has {} latest versions, and they are never merged automatically",
        repo.display(),
        heads.len()
    ));
    for h in heads {
        u = u.cause(format!(
            "{} by {} at {}",
            h.short(),
            h.author,
            utc(h.created_at)
        ));
    }
    if let Some(h) = heads.first() {
        u = u.fix(format!(
            "a maintainer keeps one: `dg env edit --env {env} --keep {}` (or `dg env set … --keep <id>`)",
            h.short()
        ));
    }
    u.fix(format!(
        "`dg env history --env {env}` shows what each changed"
    ))
    .into()
}

/// Where a new snapshot starts ([`Book::base`]).
#[derive(Debug, Clone)]
pub struct Base {
    /// The entries to edit.
    pub vars: BTreeMap<String, Var>,
    /// The environment's audience, when it exists.
    pub audience: Option<Audience>,
    /// The `packHash`es the new snapshot supersedes.
    pub supersedes: Vec<[u8; 32]>,
}

/// A snapshot ready to save.
#[derive(Debug, Clone)]
pub struct Draft {
    /// The environment.
    pub env: String,
    /// Who can read it.
    pub audience: Audience,
    /// Every entry it holds.
    pub vars: BTreeMap<String, Var>,
    /// What it replaces ([`Base::supersedes`]).
    pub supersedes: Vec<[u8; 32]>,
}

/// A sealed snapshot not yet written ([`Environments::prepare`]).
#[derive(Debug, Clone)]
pub struct Prepared {
    /// Its audience.
    pub audience: Audience,
    /// What it supersedes.
    pub supersedes: Vec<[u8; 32]>,
    /// The sealed artifact.
    pub sealed: Vec<u8>,
    /// Who it goes to (Maintainers; base58, the writer first).
    pub to: Vec<String>,
    /// Maintainers left out because their identity has no usable encryption key.
    pub skipped: Vec<String>,
}

impl Prepared {
    /// The upper bound it costs to store ([`snapshot_credits`]).
    #[must_use]
    pub fn credits(&self) -> u64 {
        snapshot_credits(self.sealed.len() as u64)
    }
}

/// What [`Environments::store`] wrote.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    /// The manifest document id.
    pub id: String,
    /// The snapshot's `packHash`, hex.
    pub pack_hash: String,
    /// Its sealed size.
    pub size_bytes: u64,
    /// Its audience.
    pub audience: Audience,
    /// Who it was sent to (Maintainers; base58, the writer first).
    pub to: Vec<String>,
    /// Maintainers left out because their identity has no usable encryption key.
    pub skipped: Vec<String>,
}

/// The upper bound a snapshot of `sealed_len` bytes costs: one `chunk` and one `packManifest`.
#[must_use]
pub fn snapshot_credits(sealed_len: u64) -> u64 {
    use crate::cost::push_fees::{
        CHUNK_FLAT, CHUNK_OVERHEAD_BYTES, CHUNK_PER_BYTE, MANIFEST_FIRST,
    };
    CHUNK_PER_BYTE * (sealed_len + CHUNK_OVERHEAD_BYTES) + CHUNK_FLAT + MANIFEST_FIRST
}

/// The largest a snapshot is sealed: the biggest bucket under the widest header.
pub const MAX_SEALED: u64 = (super::format::MAX_SNAPSHOT
    + crate::private::named::artifact_header_len(MAX_RECIPIENTS)
    + 16) as u64;

/// Environments of repositories, read and written as one identity (or anonymously).
pub struct Environments<'a> {
    client: &'a PlatformClient,
    signer: Option<(&'a LoadedIdentity, &'a BridgeIdentity)>,
}

impl<'a> Environments<'a> {
    /// As `identity`, with its key file `bridge` (its ENCRYPTION keys open what was sent to it).
    #[must_use]
    pub fn new(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
    ) -> Self {
        Self {
            client,
            signer: Some((identity, bridge)),
        }
    }

    /// Anonymously: nothing opens; environments are only counted.
    #[must_use]
    pub fn reader(client: &'a PlatformClient) -> Self {
        Self {
            client,
            signer: None,
        }
    }

    fn private_signer(&self) -> Option<PrivateSigner<'a>> {
        self.signer.map(|(identity, bridge)| PrivateSigner {
            client: self.client,
            identity,
            bridge,
        })
    }

    fn repo_service(&self) -> RepoService<'a> {
        match self.signer {
            Some((identity, bridge)) => RepoService::new(self.client, identity, bridge),
            None => RepoService::reader(self.client),
        }
    }

    /// Read every environment of `repo`: the kind-8 manifests and the current maintainers, then
    /// every snapshot a current maintainer wrote, fetched (checked against its manifest's
    /// `packHash`) and opened, then [`chain::resolve`]. A snapshot by anyone else is never
    /// fetched.
    #[allow(clippy::too_many_lines)] // fetch, keys, open, resolve: one read
    pub async fn read(&self, repo: &RepoRef) -> Result<Book> {
        let svc = self.repo_service();
        let members = MemberReader::new(self.client);
        let (manifests, maintainers) =
            futures::try_join!(svc.read_pack_manifests(repo), members.maintainers(repo))?;
        let manifests: Vec<PackManifestInfo> = manifests
            .into_iter()
            .filter(|m| m.kind == u64::from(crate::pack::KIND_ENV_SNAPSHOT))
            .collect();
        let maintainers: BTreeSet<String> =
            maintainers.into_iter().map(|m| m.identity_id).collect();
        let authorized = authorized(&manifests, &maintainers);

        // fetch the authorized artifacts (each checked against its manifest's packHash)
        let reader = crate::storage::PackReader::from_user_config();
        let fetched: Vec<(String, std::result::Result<Vec<u8>, String>)> =
            futures::stream::iter(authorized.iter().map(|m| {
                let (svc, reader) = (&svc, &reader);
                async move {
                    let got = svc
                        .fetch_artifact(repo, m, reader)
                        .await
                        .map_err(|e| e.to_string());
                    (m.document_id.clone(), got)
                }
            }))
            .buffer_unordered(FETCH_WINDOW)
            .collect()
            .await;
        let fetched: BTreeMap<String, std::result::Result<Vec<u8>, String>> =
            fetched.into_iter().collect();
        let needs = |version: u8| {
            fetched
                .values()
                .any(|b| b.as_ref().is_ok_and(|b| b.get(4) == Some(&version)))
        };

        // the keys: the owners' identity keys (a Maintainers snapshot's sender key), the
        // reader's ENCRYPTION keys, and the members key chain when a Members snapshot is met
        let mut owner_keys: BTreeMap<String, Vec<OwnerKey>> = BTreeMap::new();
        if needs(crate::private::named::ARTIFACT_VERSION) {
            let owners: BTreeSet<&str> = authorized.iter().map(|m| m.owner_id.as_str()).collect();
            for owner in owners {
                let keys = match self.client.fetch_identity(owner).await {
                    Ok(identity) => codec::owner_keys(&identity.public_keys()),
                    Err(Error::NotFound) => Vec::new(),
                    Err(e) => return Err(e),
                };
                owner_keys.insert(owner.to_owned(), keys);
            }
        }
        let signer = self.private_signer();
        let reader_keys = signer
            .as_ref()
            .map(|s| s.encryption_keys(repo).private_keys())
            .unwrap_or_default();
        let reader_id = self
            .signer
            .and_then(|(identity, _)| platform::decode_identifier(&identity.id()).ok());
        let mut epoch_keys: BTreeMap<u32, EpochKeys> = BTreeMap::new();
        if let (true, Some(s)) = (needs(crate::private::pack::VERSION), signer.as_ref()) {
            // a repository without a members key chain, or a reader without its key: nothing
            // opens, which is what the reader is told per snapshot
            if let Ok(kr) = s.keyring(repo).await {
                let repo_id = *kr.repo_id();
                for (e, k) in &kr.resolution().keys {
                    epoch_keys.insert(*e, EpochKeys::derive(&repo_id, *e, k));
                }
            }
        }
        let repo_id = repo.scope()?.repo_id;
        let lookup = |e: u32| epoch_keys.get(&e);
        let none: Vec<OwnerKey> = Vec::new();
        let mut opened: BTreeMap<String, Opened> = BTreeMap::new();
        for m in &authorized {
            let result = match fetched.get(&m.document_id) {
                Some(Ok(bytes)) => {
                    let keys = OpenKeys {
                        repo_id: &repo_id,
                        owner_keys: owner_keys.get(&m.owner_id).unwrap_or(&none),
                        reader: reader_id.map(|identity_id| Reader {
                            identity_id,
                            keys: &reader_keys,
                        }),
                        epoch_keys: &lookup,
                    };
                    let check = ManifestCheck {
                        owner_id: &m.owner_id,
                        pack_hash: &m.pack_hash,
                        size_bytes: m.size_bytes,
                    };
                    match codec::open(&check, bytes, &keys) {
                        Ok(s) => Opened::Snapshot(s),
                        Err(e) => Opened::Refused(e),
                    }
                }
                Some(Err(e)) => Opened::Unfetched(e.clone()),
                None => Opened::Unfetched("not fetched".into()),
            };
            opened.insert(m.document_id.clone(), result);
        }

        let refs: Vec<SnapshotRef> = manifests.iter().map(snapshot_ref).collect();
        let by_hash: BTreeMap<[u8; 32], &str> = authorized
            .iter()
            .filter_map(|m| {
                opened
                    .get(&m.document_id)
                    .and_then(Opened::snapshot)
                    .map(|s| (m.pack_hash, s.env.as_str()))
            })
            .collect();
        let resolution = chain::resolve(&maintainers, &refs, |h| by_hash.get(h).copied());
        Ok(Book {
            maintainers,
            manifests,
            opened,
            resolution,
        })
    }

    /// Refuse anyone but a current maintainer before anything is read or signed (phase 1:
    /// maintainers-only writes, security review H5).
    pub async fn require_maintainer(&self, repo: &RepoRef, action: &str) -> Result<()> {
        let Some((identity, _)) = self.signer else {
            return Err(
                UserError::new(codes::NO_IDENTITY, format!("{action}: no identity"))
                    .fix("`dg auth login <file>`")
                    .into(),
            );
        };
        let me = identity.id();
        let role = MemberReader::new(self.client).best_role(repo, &me).await?;
        if role == Some(Role::Maintainer) {
            return Ok(());
        }
        let you = match role {
            Some(Role::Writer) => format!("you are a writer of {}", repo.display()),
            Some(Role::Triage) => format!("you are a triage member of {}", repo.display()),
            Some(Role::Reader) => format!("you are a reader of {}", repo.display()),
            Some(Role::Maintainer) | None => format!("you are not a member of {}", repo.display()),
        };
        Err(UserError::new(
            codes::NOT_A_WRITER,
            format!("{action}: only maintainers can change environments"),
        )
        .cause(you)
        .fix("ask a maintainer to make the change")
        .note("nothing was written")
        .into())
    }

    /// Seal `draft` as the next snapshot of its environment, for its audience (Members under the
    /// members key at the write epoch, read fresh; Maintainers to every current maintainer with
    /// a usable encryption key, the writer first). Refused unless the signer is a current
    /// maintainer. Nothing is written: [`Self::store`] does that, after the caller has shown
    /// the plan and its cost.
    pub async fn prepare(&self, repo: &RepoRef, draft: &Draft) -> Result<Prepared> {
        self.require_maintainer(repo, &format!("change {}", draft.env))
            .await?;
        let (sealed, to, skipped) = self.seal(repo, draft).await?;
        Ok(Prepared {
            audience: draft.audience,
            supersedes: draft.supersedes.clone(),
            sealed,
            to,
            skipped,
        })
    }

    /// Store `prepared` as one Platform chunk and record its kind-8 `packManifest`.
    pub async fn store(&self, repo: &RepoRef, prepared: &Prepared) -> Result<Saved> {
        let (id, pack_hash) = self
            .repo_service()
            .store_env_snapshot(repo, &prepared.sealed, prepared.supersedes.clone())
            .await?;
        Ok(Saved {
            id,
            pack_hash: hex::encode(pack_hash),
            size_bytes: prepared.sealed.len() as u64,
            audience: prepared.audience,
            to: prepared.to.clone(),
            skipped: prepared.skipped.clone(),
        })
    }

    /// The recipients of a Maintainers snapshot: `me` (the writer, slot 0), then every other
    /// current maintainer by id with their highest usable ENCRYPTION key; and the maintainers
    /// left out for having none.
    async fn recipients(
        &self,
        repo: &RepoRef,
        me: Recipient,
    ) -> Result<(Vec<Recipient>, Vec<String>)> {
        let me_id = platform::encode_identifier(me.identity_id);
        let mut others: Vec<String> = MemberReader::new(self.client)
            .maintainers(repo)
            .await?
            .into_iter()
            .map(|m| m.identity_id)
            .filter(|id| *id != me_id)
            .collect();
        others.sort();
        others.dedup();
        let core = repo.forge().core.clone();
        let mut recipients = vec![me];
        let mut skipped = Vec::new();
        for other in others {
            let keys = match self.client.fetch_identity(&other).await {
                Ok(identity) => identity.public_keys(),
                Err(Error::NotFound) => Vec::new(),
                Err(e) => return Err(e),
            };
            let key = recipient_key(&keys, &core)
                .and_then(|k| <[u8; 33]>::try_from(k.public_key.as_slice()).ok());
            match key {
                Some(public_key) => recipients.push(Recipient {
                    identity_id: platform::decode_identifier(&other)?,
                    public_key,
                }),
                None => skipped.push(other),
            }
        }
        Ok((recipients, skipped))
    }

    /// Seal `draft` for its audience: the bytes, who it goes to, and who was left out.
    async fn seal(
        &self,
        repo: &RepoRef,
        draft: &Draft,
    ) -> Result<(Vec<u8>, Vec<String>, Vec<String>)> {
        let signer = self.private_signer().ok_or_else(|| {
            Error::from(UserError::new(
                codes::NO_IDENTITY,
                "saving an environment needs an identity",
            ))
        })?;
        let generated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(0));
        let mut snap = Snapshot {
            env: draft.env.clone(),
            audience: draft.audience,
            generated_at,
            to: Vec::new(),
            vars: draft.vars.clone(),
        };
        let action = format!("save {}", draft.env);
        match draft.audience {
            Audience::Members => {
                let kr = signer.keyring(repo).await?;
                // E312 when no members key exists (members-only content not turned on), E311
                // when one does and none was shared with this maintainer yet
                if !kr.has_members_key() {
                    return Err(crate::keyring::members_only_off(repo));
                }
                if kr.resolution().keys.is_empty() {
                    return Err(crate::keyring::no_key_shared(repo));
                }
                let resolution = kr.resolution();
                let epoch = resolution
                    .write_epoch
                    .filter(|e| resolution.keys.contains_key(e))
                    .ok_or_else(|| no_members_key(repo, &action))?;
                let keys = EpochKeys::derive(kr.repo_id(), epoch, &resolution.keys[&epoch]);
                let sealed = codec::seal_members(&keys, &snap)
                    .map_err(|e| Error::Config(format!("{action}: {e}")))?;
                Ok((sealed, Vec::new(), Vec::new()))
            }
            Audience::Maintainers => {
                let enc = signer.encryption_keys(repo);
                let (sender_key_id, sender) = enc
                    .sender()
                    .ok_or_else(|| crate::keyring::no_encryption_key_held(&action))?;
                let me = signer.identity.id();
                let me_bytes = platform::decode_identifier(&me)?;
                let (recipients, skipped) = self
                    .recipients(
                        repo,
                        Recipient {
                            identity_id: me_bytes,
                            public_key: sender.public_key(),
                        },
                    )
                    .await?;
                if recipients.len() > MAX_RECIPIENTS {
                    return Err(UserError::new(
                        codes::UNSUPPORTED,
                        format!(
                            "{action}: {} maintainers have an encryption key, and a Maintainers environment goes to at most {MAX_RECIPIENTS} people",
                            recipients.len()
                        ),
                    )
                    .fix("use the Members audience (`--audience members`), or fewer maintainers")
                    .note("nothing was written")
                    .into());
                }
                snap.to = recipients
                    .iter()
                    .map(|r| platform::encode_identifier(r.identity_id))
                    .collect();
                let sealed = codec::seal_maintainers(
                    &repo.scope()?.repo_id,
                    sender,
                    sender_key_id,
                    &me_bytes,
                    &recipients,
                    &snap,
                )
                .map_err(|e| Error::Config(format!("{action}: {e}")))?;
                Ok((sealed, snap.to.clone(), skipped))
            }
        }
    }
}

/// `ms` as `YYYY-MM-DD HH:MM UTC` (Howard Hinnant's `civil_from_days`; no date crate).
#[must_use]
pub fn utc(ms: u64) -> String {
    let secs = ms / 1000;
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02} UTC",
        rem / 3600,
        rem % 3600 / 60
    )
}

/// Members audience without a members key to write under.
fn no_members_key(repo: &RepoRef, action: &str) -> Error {
    UserError::new(
        codes::ROTATION_PENDING,
        format!("{action}: the members key can't be written under right now"),
    )
    .cause(format!(
        "a Members environment is encrypted under {}'s current members key, and a key change has not finished",
        repo.display()
    ))
    .fix(format!("`dg repo keys repair {}` finishes it", repo.display()))
    .fix("or save it for Maintainers instead: add `--audience maintainers`")
    .note("nothing was written")
    .into()
}

/// The authorized manifests (a current maintainer's, the first of each `packHash`), in
/// `($createdAt, $id)` order: exactly the nodes [`chain::resolve`] keeps.
fn authorized<'m>(
    manifests: &'m [PackManifestInfo],
    maintainers: &BTreeSet<String>,
) -> Vec<&'m PackManifestInfo> {
    let mut order: Vec<&PackManifestInfo> = manifests.iter().collect();
    order.sort_by(|a, b| (a.created_at, &a.document_id).cmp(&(b.created_at, &b.document_id)));
    let mut seen = BTreeSet::new();
    order
        .into_iter()
        .filter(|m| maintainers.contains(&m.owner_id) && seen.insert(m.pack_hash))
        .collect()
}

fn snapshot_ref(m: &PackManifestInfo) -> SnapshotRef {
    SnapshotRef {
        id: m.document_id.clone(),
        owner_id: m.owner_id.clone(),
        pack_hash: m.pack_hash,
        supersedes: m.supersedes.clone(),
        created_at: m.created_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_formats_known_instants() {
        assert_eq!(utc(0), "1970-01-01 00:00 UTC");
        assert_eq!(utc(20_725 * 86_400_000 + 3_661_000), "2026-09-29 01:01 UTC");
        assert_eq!(utc(951_782_400_000), "2000-02-29 00:00 UTC");
    }

    #[test]
    fn a_snapshot_is_quoted_as_one_chunk_and_one_manifest() {
        let c = snapshot_credits(MAX_SEALED);
        assert!(c > crate::cost::push_fees::MANIFEST_FIRST);
        assert!(
            MAX_SEALED <= crate::pack::DOC_PAYLOAD_MAX as u64,
            "one chunk"
        );
    }
}
