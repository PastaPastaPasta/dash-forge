//! Environments over Platform: read every snapshot of a repository and resolve them
//! ([`Environments::read`]), and save one ([`Environments::save`]). The rules are in the pure
//! modules ([`super::codec`], [`super::chain`]); this file only fetches, opens and writes.

use std::collections::{BTreeMap, BTreeSet};

use futures::StreamExt as _;

use super::chain::{self, EnvHistory, EnvState, Exposure, Resolution, SnapshotRef, State};
use super::codec::{self, ManifestCheck, OpenError, OpenKeys};
use super::format::{diff, Change, Snapshot, Var};
use super::{Audience, MAX_RECIPIENTS};
use crate::members::Member;
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

/// Debug builds only: skip the maintainer check before writing, so live QA can post what a
/// modified client would (a writer's snapshot, which every reader must ignore).
#[cfg(debug_assertions)]
pub const TEST_ANY_WRITER: &str = "DASH_FORGE_TEST_ENV_ANY_WRITER";

/// Debug builds only: comma-separated `packHash`es (hex) live QA adds to a new snapshot's
/// `supersedes`.
#[cfg(debug_assertions)]
pub const TEST_SUPERSEDES: &str = "DASH_FORGE_TEST_ENV_SUPERSEDES";

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
    /// An old-format Members snapshot under a members key its author could no longer use when it
    /// was saved (the late-content rule sealed packs follow, `private-repos.md` §8.2).
    Late,
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
            Self::Late => "it was saved under a members key after that key was replaced".to_owned(),
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
    /// The authorized snapshots stored in the old format (DFPK 0x01, under the members key), by
    /// manifest document id, whether or not they opened here.
    pub old_format: BTreeSet<String>,
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
    Conflict {
        /// The heads, oldest first.
        heads: Vec<Head>,
        /// The heads share no earlier version: separate histories (two first versions, or a
        /// chain split), not two changes made at once.
        split: bool,
    },
    /// The latest change does not open for this reader.
    Unreadable {
        /// That change.
        head: Head,
        /// Why, for a person.
        reason: String,
        /// No copy of it could be fetched (a storage or network failure, not a key).
        unfetched: bool,
    },
}

/// One change in an environment's history.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    /// The snapshot.
    #[serde(flatten)]
    pub head: Head,
    /// Its `packHash`, hex (public, as its author, time and size are).
    pub pack_hash: String,
    /// The padded, sealed size (what the public sees).
    pub size_bytes: u64,
    /// Who could read it.
    pub audience: Option<Audience>,
    /// The entries it changed against the snapshot it replaced, by name.
    pub changes: Vec<(String, Change)>,
    /// Why it cannot be read, when it cannot.
    pub unreadable: Option<String>,
    /// A maintainer saved it again for this removed maintainer, with their values.
    pub saved_for: Option<String>,
}

impl Book {
    /// The manifest of document `id`.
    #[must_use]
    pub fn manifest(&self, id: &str) -> Option<&PackManifestInfo> {
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
            State::Conflict => Err(Blocked::Conflict {
                heads: state.heads.iter().map(|h| self.head(h)).collect(),
                split: self.is_split(state),
            }),
        }
    }

    fn unreadable(&self, id: &str) -> Blocked {
        Blocked::Unreadable {
            head: self.head(id),
            reason: self.opened.get(id).map(Opened::reason).unwrap_or_default(),
            unfetched: matches!(self.opened.get(id), Some(Opened::Unfetched(_))),
        }
    }

    /// Whether `state`'s heads share no earlier counted version (separate histories) rather
    /// than having been made from one version at the same time.
    fn is_split(&self, state: &EnvState) -> bool {
        let in_env: BTreeMap<[u8; 32], &PackManifestInfo> = state
            .snapshots
            .iter()
            .filter_map(|id| self.manifest(id).map(|m| (m.pack_hash, m)))
            .collect();
        let ancestors = |id: &str| -> BTreeSet<[u8; 32]> {
            let mut seen = BTreeSet::new();
            let mut todo: Vec<&PackManifestInfo> = self.manifest(id).into_iter().collect();
            while let Some(m) = todo.pop() {
                for h in &m.supersedes {
                    if let Some(p) = in_env.get(h) {
                        if p.created_at_block_height < m.created_at_block_height && seen.insert(*h)
                        {
                            todo.push(p);
                        }
                    }
                }
            }
            seen
        };
        let mut sets = state.heads.iter().map(|h| ancestors(h));
        let Some(first) = sets.next() else {
            return false;
        };
        sets.fold(first, |acc, s| acc.intersection(&s).copied().collect())
            .is_empty()
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
                // compared with the newest earlier snapshot of this environment it names that
                // this reader can open
                let before = m
                    .map(|m| {
                        m.supersedes
                            .iter()
                            .filter_map(|h| hash_to_id.get(h))
                            .filter_map(|p| self.manifest(p).zip(self.snapshot(p)))
                            .max_by_key(|(pm, _)| {
                                (pm.created_at_block_height, pm.document_id.clone())
                            })
                            .map(|(_, snap)| snap)
                    })
                    .unwrap_or_default();
                HistoryItem {
                    head: self.head(id),
                    pack_hash: m.map(|m| hex::encode(m.pack_hash)).unwrap_or_default(),
                    size_bytes: m.map_or(0, |m| m.size_bytes),
                    audience: opened.map(|s| s.audience.clone()),
                    changes: opened.map(|s| diff(before, s)).unwrap_or_default(),
                    saved_for: opened.and_then(|s| s.saved_for.clone()),
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

    /// What the old format left in `env` (DESIGN §4.5, §10): whether its latest version is an
    /// old-format Members snapshot, the names held in its old-format snapshots this reader opened
    /// that are not marked changed in the latest version, and how many old-format snapshots did
    /// not open here. `None` when it has none.
    #[must_use]
    pub fn old_format_of(&self, env: &str) -> Option<OldFormat> {
        let state = self.state(env)?;
        let old: Vec<&String> = state
            .snapshots
            .iter()
            .filter(|id| self.old_format.contains(*id))
            .collect();
        if old.is_empty() {
            return None;
        }
        let head = state.heads.last().and_then(|h| self.snapshot(h));
        let marked: BTreeSet<&str> = head
            .map(|h| h.marked_changed.iter().map(String::as_str).collect())
            .unwrap_or_default();
        let mut unmarked = BTreeSet::new();
        let mut unopened = 0;
        for id in &old {
            match self.snapshot(id) {
                Some(s) => unmarked.extend(
                    s.vars
                        .keys()
                        .filter(|n| !marked.contains(n.as_str()))
                        .cloned(),
                ),
                None => unopened += 1,
            }
        }
        Some(OldFormat {
            latest: state.heads.iter().any(|h| self.old_format.contains(h)),
            unmarked: unmarked.into_iter().collect(),
            unopened,
        })
    }

    /// The `supersedes` a new snapshot of `env` writes ([`chain::window`]).
    #[must_use]
    pub fn window(&self, env: &str) -> Vec<[u8; 32]> {
        self.state(env)
            .map(|state| self.window_over(&state.snapshots, &state.heads))
            .unwrap_or_default()
    }

    /// [`chain::window`] over the snapshots `ids` of an environment whose heads are `heads` (the
    /// current resolution's, or a predicted one's).
    #[must_use]
    pub fn window_over(&self, ids: &[String], heads: &[String]) -> Vec<[u8; 32]> {
        let refs: Vec<SnapshotRef> = ids
            .iter()
            .filter_map(|id| self.manifest(id))
            .map(snapshot_ref)
            .collect();
        let refs: Vec<&SnapshotRef> = refs.iter().collect();
        chain::window(&refs, heads)
    }

    /// The ignored manifests that name any snapshot of `env` (for its history): changes by
    /// people who are not maintainers now, never used.
    #[must_use]
    pub fn ignored_for(&self, env: &str) -> Vec<Head> {
        let Some(state) = self.state(env) else {
            return Vec::new();
        };
        let hashes: BTreeSet<[u8; 32]> = state
            .snapshots
            .iter()
            .filter_map(|id| self.manifest(id).map(|m| m.pack_hash))
            .collect();
        let mut out: Vec<&PackManifestInfo> = self
            .manifests
            .iter()
            .filter(|m| !self.maintainers.contains(&m.owner_id))
            .filter(|m| m.supersedes.iter().any(|h| hashes.contains(h)))
            .collect();
        out.sort_by(|a, b| chain_order(a).cmp(&chain_order(b)));
        out.iter().map(|m| self.head(&m.document_id)).collect()
    }

    /// The resolution these manifests would have if the maintainers were `maintainers` (a dry
    /// run of a removal: only snapshots this book opened can be named, so a set larger than the
    /// current one needs [`Environments::read_with_maintainer`]).
    #[must_use]
    pub fn resolution_with(&self, maintainers: &BTreeSet<String>) -> Resolution {
        let refs: Vec<SnapshotRef> = self.manifests.iter().map(snapshot_ref).collect();
        let by_hash: BTreeMap<[u8; 32], &str> = self
            .manifests
            .iter()
            .filter(|m| maintainers.contains(&m.owner_id))
            .filter_map(|m| {
                self.snapshot(&m.document_id)
                    .map(|s| (m.pack_hash, s.env.as_str()))
            })
            .collect();
        chain::resolve(maintainers, &refs, |h| by_hash.get(h).copied())
    }

    /// The ignored manifests (by people who are not maintainers now) that name a head of `env`
    /// from a higher block: never used, but readers warn about them.
    #[must_use]
    pub fn ignored_newer(&self, env: &str) -> Vec<Head> {
        self.state(env)
            .map(|s| s.ignored_newer.iter().map(|id| self.head(id)).collect())
            .unwrap_or_default()
    }

    /// The newest earlier snapshot of `state`'s environment, below `head` in block height, that
    /// someone other than `author` wrote and this reader can open: what the removal diff compares
    /// with.
    #[must_use]
    pub fn previous_by_other(
        &self,
        state: &EnvState,
        head: &PackManifestInfo,
        author: &str,
    ) -> Option<&Snapshot> {
        state
            .snapshots
            .iter()
            .filter_map(|id| self.manifest(id).zip(self.snapshot(id)))
            .filter(|(m, _)| {
                m.owner_id != author && m.created_at_block_height < head.created_at_block_height
            })
            .max_by_key(|(m, _)| (m.created_at_block_height, m.document_id.clone()))
            .map(|(_, snap)| snap)
    }

    /// What a new snapshot of `env` starts from: the current entries and audience and the
    /// heads it supersedes. On a conflict, `keep` (a head's id or its prefix) picks the entries
    /// and the new snapshot supersedes every head, which resolves it.
    pub fn base(&self, repo: &RepoRef, env: &str, keep: Option<&str>) -> Result<Base> {
        let from = |snap: &Snapshot, heads: usize| Base {
            vars: snap.vars.clone(),
            audience: Some(snap.audience.clone()),
            id: snap.id,
            version: snap.version,
            marked_changed: snap.marked_changed.clone(),
            supersedes: self.window(env),
            heads,
        };
        match self.current(env) {
            Ok(snap) => {
                if let Some(k) = keep {
                    return Err(UserError::new(
                        codes::USAGE,
                        format!("{env} has no conflict to resolve, so --keep {k} is not needed"),
                    )
                    .into());
                }
                Ok(from(snap, 1))
            }
            Err(Blocked::Missing { .. }) => Ok(Base {
                vars: BTreeMap::new(),
                audience: None,
                id: None,
                version: 2,
                marked_changed: Vec::new(),
                supersedes: Vec::new(),
                heads: 0,
            }),
            Err(Blocked::Conflict { heads, split }) => {
                let picked = keep.and_then(|k| {
                    let hits: Vec<&Head> = heads.iter().filter(|h| h.id.starts_with(k)).collect();
                    (hits.len() == 1).then(|| hits[0])
                });
                match picked.and_then(|h| self.snapshot(&h.id)) {
                    Some(snap) => Ok(from(snap, heads.len())),
                    None => Err(conflict_error(repo, env, &heads, split)),
                }
            }
            Err(Blocked::Unreadable {
                head,
                reason,
                unfetched: true,
            }) => Err(unfetched_error(env, &head, &reason)),
            Err(Blocked::Unreadable { head, reason, .. }) => Err(UserError::new(
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
            .fix("ask a maintainer who can read it to make any change, or to save it again for you")
            .note("nothing was written")
            .into()),
        }
    }
}

/// The headline of a conflict: "2 people changed production at the same time" (or "production
/// was changed 2 times at the same time"), or for heads with no earlier version in common
/// "production has 2 separate histories".
#[must_use]
pub fn conflict_headline(env: &str, heads: &[Head], split: bool) -> String {
    if split {
        return format!("{env} has {} separate histories", heads.len());
    }
    let authors: BTreeSet<&str> = heads.iter().map(|h| h.author.as_str()).collect();
    if authors.len() > 1 {
        format!("{} people changed {env} at the same time", authors.len())
    } else {
        format!("{env} was changed {} times at the same time", heads.len())
    }
}

/// E608: `env` has two or more latest versions. Every one is named (id, author, time); which to
/// keep is left to a maintainer who has looked at `dg env history`.
#[must_use]
pub fn conflict_error(repo: &RepoRef, env: &str, heads: &[Head], split: bool) -> Error {
    let versions: Vec<String> = heads
        .iter()
        .map(|h| format!("{} by {} at {}", h.short(), h.author, utc(h.created_at)))
        .collect();
    let why = if split {
        "they share no earlier version: two first versions were saved, or a removed maintainer's changes joined them"
    } else {
        "they were made from the same version, and versions are never merged automatically"
    };
    UserError::new(
        codes::ENV_CONFLICT,
        format!(
            "{}, so its values can't be used until a maintainer keeps one",
            conflict_headline(env, heads, split)
        ),
    )
    .cause(format!(
        "{env} in {} has {} latest versions ({why}): {}",
        repo.display(),
        heads.len(),
        versions.join(", ")
    ))
    .fix(format!(
        "compare them with `dg env history --env {env}`, then a maintainer keeps one: `dg env edit --env {env} --keep <id>`"
    ))
    .into()
}

/// E503 for an environment whose latest change could not be fetched (not a key problem).
#[must_use]
pub fn unfetched_error(env: &str, head: &Head, reason: &str) -> Error {
    UserError::new(
        codes::PACKS_UNREADABLE,
        format!("the latest change to {env} couldn't be fetched"),
    )
    .cause(format!("{} by {}: {reason}", head.short(), head.author))
    .fix("check your connection and storage settings (`dg storage status`), then try again")
    .into()
}

pub use super::chain::MAX_SUPERSEDES;

/// What the old format left in one environment ([`Book::old_format_of`]).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OldFormat {
    /// Its latest version is in the old format.
    pub latest: bool,
    /// Names held in old-format versions, not marked changed since.
    pub unmarked: Vec<String>,
    /// Old-format versions this reader can't open (their names are unknown here).
    pub unopened: usize,
}

impl OldFormat {
    /// Whether the banner is shown: the latest version is old, or old values may still be in
    /// use.
    #[must_use]
    pub fn needs_attention(&self) -> bool {
        self.latest || !self.unmarked.is_empty() || self.unopened > 0
    }
}

/// Where a new snapshot starts ([`Book::base`]).
#[derive(Debug, Clone)]
pub struct Base {
    /// The entries to edit.
    pub vars: BTreeMap<String, Var>,
    /// The environment's audience, when it exists (an old snapshot's as the group of its word).
    pub audience: Option<Audience>,
    /// The environment's id, when a version-2 snapshot of it exists.
    pub id: Option<[u8; 16]>,
    /// The version of the snapshot it starts from (2 for a new environment).
    pub version: u8,
    /// The names marked changed so far ([`Snapshot::marked_changed`]), carried forward.
    pub marked_changed: Vec<String>,
    /// The `packHash`es the new snapshot supersedes.
    pub supersedes: Vec<[u8; 32]>,
    /// How many heads the environment has now (0 new, 1, or more when `keep` resolves a
    /// conflict).
    pub heads: usize,
}

impl Base {
    /// The environment's id, or a fresh random one for its first version-2 save.
    pub fn id_or_new(&self) -> Result<[u8; 16]> {
        if let Some(id) = self.id {
            return Ok(id);
        }
        let mut id = [0u8; 16];
        getrandom::getrandom(&mut id)
            .map_err(|e| Error::Config(format!("drawing an environment id: {e}")))?;
        Ok(id)
    }
}

/// A snapshot ready to save.
#[derive(Debug, Clone)]
pub struct Draft {
    /// The environment.
    pub env: String,
    /// Its id ([`Base::id_or_new`]).
    pub id: [u8; 16],
    /// Who can read it.
    pub audience: Audience,
    /// Every entry it holds.
    pub vars: BTreeMap<String, Var>,
    /// What it replaces ([`Base::supersedes`]).
    pub supersedes: Vec<[u8; 32]>,
    /// Set when saving a removed maintainer's values again for them.
    pub saved_for: Option<String>,
    /// The names marked changed ([`Snapshot::marked_changed`]).
    pub marked_changed: Vec<String>,
    /// The people the audience resolves to, when the caller worked them out (a membership
    /// change's plan, from the member list as it will be); `None`: from the member documents now.
    pub people: Option<BTreeSet<String>>,
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
    /// Who it goes to (base58, the writer first).
    pub to: Vec<String>,
    /// People of the audience left out because their identity has no usable encryption key.
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
    /// Who it was sent to (base58, the writer first).
    pub to: Vec<String>,
    /// People of the audience left out because their identity has no usable encryption key.
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

/// The largest a sealed snapshot may be: one Platform chunk. The biggest bucket under a header
/// for 16 people fits; a large environment for many more people may not, and is refused before
/// signing.
pub const MAX_SEALED: u64 = crate::pack::DOC_PAYLOAD_MAX as u64;

/// The people `audience` resolves to with `members` the repository's membership documents and
/// `owner` its owner (base58, sorted): its group's members (the owner is in every group) and the
/// people it adds. The writer is added at write time.
#[must_use]
pub fn resolve_people(audience: &Audience, owner: &str, members: &[Member]) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = audience.also.iter().cloned().collect();
    if let Some(g) = audience.group {
        out.insert(owner.to_owned());
        out.extend(
            members
                .iter()
                .filter(|m| g.includes(m.role))
                .map(|m| m.identity_id.clone()),
        );
    }
    out
}

/// E611: a first save without an audience.
#[must_use]
pub fn audience_required(env: &str) -> Error {
    UserError::new(
        codes::AUDIENCE_REQUIRED,
        format!("choose who can read environment {env}"),
    )
    .cause("an environment has no default audience: you choose it when you first save it")
    .fix(format!(
        "dg env set … --env {env} --audience maintainers   # or writers, members, people --to @a,@b"
    ))
    .note("nothing was written")
    .into()
}

/// E612: environments this member cannot read (DESIGN §4.5): "not in the audience" and "in the
/// group, not saved since" look the same from outside, so the message is generic.
#[must_use]
pub fn not_shared_yet(repo: &RepoRef, env: Option<&str>) -> UserError {
    let what = env.map_or_else(
        || "An environment in this repo hasn't been shared with you".to_owned(),
        |e| format!("{} has no environment {e} shared with you", repo.display()),
    );
    UserError::new(codes::NOT_SHARED_YET, what).fix(
        "if you should have access, ask a maintainer to save it again (`dg env resave`)",
    )
}

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
    /// fetched or opened (D24).
    pub async fn read(&self, repo: &RepoRef) -> Result<Book> {
        self.read_as(repo, None).await
    }

    /// [`Self::read`] as if `extra` were a maintainer too: a dry run of a promotion, opening
    /// their snapshots as a reader would once they count.
    pub async fn read_with_maintainer(&self, repo: &RepoRef, extra: &str) -> Result<Book> {
        self.read_as(repo, Some(extra)).await
    }

    async fn read_as(&self, repo: &RepoRef, extra: Option<&str>) -> Result<Book> {
        let svc = self.repo_service();
        let members = MemberReader::new(self.client);
        let (manifests, maintainers) =
            futures::try_join!(svc.read_pack_manifests(repo), members.maintainers(repo))?;
        let manifests: Vec<PackManifestInfo> = manifests
            .into_iter()
            .filter(|m| m.kind == u64::from(crate::pack::KIND_ENV_SNAPSHOT))
            .collect();
        let mut maintainers: BTreeSet<String> =
            maintainers.into_iter().map(|m| m.identity_id).collect();
        maintainers.extend(extra.map(str::to_owned));
        let authorized = authorized(&manifests, &maintainers);
        let fetched = self.opener(repo, &svc, &authorized).await?;
        let old_format: BTreeSet<String> = fetched
            .fetched
            .iter()
            .filter(|(_, b)| {
                b.as_ref()
                    .is_ok_and(|b| b.get(4) == Some(&crate::private::pack::VERSION))
            })
            .map(|(id, _)| id.clone())
            .collect();
        let opened: BTreeMap<String, Opened> = fetched.open_all(&authorized);
        let refs: Vec<SnapshotRef> = manifests.iter().map(snapshot_ref).collect();
        let by_hash: BTreeMap<[u8; 32], String> = authorized
            .iter()
            .filter_map(|m| {
                opened
                    .get(&m.document_id)
                    .and_then(Opened::snapshot)
                    .map(|s| (m.pack_hash, s.env.clone()))
            })
            .collect();
        let resolution =
            chain::resolve(&maintainers, &refs, |h| by_hash.get(h).map(String::as_str));
        Ok(Book {
            maintainers,
            manifests,
            opened,
            old_format,
            resolution,
        })
    }

    /// Fetch `list`'s artifacts and gather the keys to open them with: the owners' identity keys
    /// (a Maintainers snapshot's sender key), the reader's ENCRYPTION keys, and the members key
    /// chain when a Members snapshot is met.
    async fn opener(
        &self,
        repo: &RepoRef,
        svc: &RepoService<'_>,
        list: &[&PackManifestInfo],
    ) -> Result<Opener> {
        let reader = crate::storage::PackReader::from_user_config();
        let fetched: BTreeMap<String, std::result::Result<Vec<u8>, String>> =
            futures::stream::iter(list.iter().map(|m| {
                let reader = &reader;
                async move {
                    let got = svc
                        .fetch_artifact(repo, m, reader)
                        .await
                        .map_err(|e| e.to_string());
                    (m.document_id.clone(), got)
                }
            }))
            .buffer_unordered(FETCH_WINDOW)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .collect();
        let needs = |version: u8| {
            fetched
                .values()
                .any(|b| b.as_ref().is_ok_and(|b| b.get(4) == Some(&version)))
        };
        let mut owner_keys: BTreeMap<String, Vec<OwnerKey>> = BTreeMap::new();
        if needs(crate::private::named::ARTIFACT_VERSION) {
            let owners: BTreeSet<&str> = list.iter().map(|m| m.owner_id.as_str()).collect();
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
        let mut standing = None;
        if let (true, Some(s)) = (needs(crate::private::pack::VERSION), signer.as_ref()) {
            // a repository without a members key chain, or a reader without its key: nothing
            // opens, which is what the reader is told per snapshot
            if let Ok(kr) = s.keyring(repo).await {
                let repo_id = *kr.repo_id();
                for (e, k) in &kr.resolution().keys {
                    epoch_keys.insert(*e, EpochKeys::derive(&repo_id, *e, k));
                }
                standing = Some(kr.resolution().clone());
            }
        }
        Ok(Opener {
            repo_id: repo.scope()?.repo_id,
            fetched,
            owner_keys,
            reader_id,
            reader_keys,
            epoch_keys,
            standing,
        })
    }

    /// Refuse anyone but a current maintainer before anything is read or signed (phase 1:
    /// maintainers-only writes, security review H5).
    pub async fn require_maintainer(&self, repo: &RepoRef, action: &str) -> Result<()> {
        // Live QA posts a non-maintainer's snapshot this way, to show that readers ignore it
        // (consensus admits it from any role-1 writer). Not compiled into release builds.
        #[cfg(debug_assertions)]
        if std::env::var_os(TEST_ANY_WRITER).is_some() {
            return Ok(());
        }
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

    /// Seal `draft` as the next snapshot of its environment: a letter to the people its audience
    /// resolves to, each with a usable encryption key, the writer first. Refused unless the
    /// signer is a current maintainer. Nothing is written: [`Self::store`] does that, after the caller has shown
    /// the plan and its cost.
    pub async fn prepare(&self, repo: &RepoRef, draft: &Draft) -> Result<Prepared> {
        self.require_maintainer(repo, &format!("change {}", draft.env))
            .await?;
        let (sealed, to, skipped) = self.seal(repo, draft).await?;
        #[allow(unused_mut)]
        let mut supersedes = draft.supersedes.clone();
        // Name more heads, as a modified client could (live QA's forgery). Not in release builds.
        #[cfg(debug_assertions)]
        if let Ok(list) = std::env::var(TEST_SUPERSEDES) {
            supersedes.extend(list.split(',').filter_map(|h| {
                hex::decode(h.trim())
                    .ok()
                    .and_then(|b| <[u8; 32]>::try_from(b).ok())
            }));
        }
        Ok(Prepared {
            audience: draft.audience.clone(),
            supersedes,
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
            audience: prepared.audience.clone(),
            to: prepared.to.clone(),
            skipped: prepared.skipped.clone(),
        })
    }

    /// The recipients of a snapshot: `me` (the writer, slot 0, with its key `me_key_id`), then
    /// every one of `people` but `me` by id, each with their highest usable ENCRYPTION key; the
    /// key id of every slot; and the people left out for having none.
    async fn recipients(
        &self,
        repo: &RepoRef,
        me: Recipient,
        me_key_id: u32,
        people: &BTreeSet<String>,
    ) -> Result<(Vec<Recipient>, Vec<u32>, Vec<String>)> {
        let me_id = platform::encode_identifier(me.identity_id);
        let core = repo.forge().core.clone();
        let mut recipients = vec![me];
        let mut key_ids = vec![me_key_id];
        let mut skipped = Vec::new();
        for other in people.iter().filter(|p| **p != me_id) {
            let keys = match self.client.fetch_identity(other).await {
                Ok(identity) => identity.public_keys(),
                Err(Error::NotFound) => Vec::new(),
                Err(e) => return Err(e),
            };
            let key = recipient_key(&keys, &core).and_then(|k| {
                <[u8; 33]>::try_from(k.public_key.as_slice())
                    .ok()
                    .map(|pk| (k.id, pk))
            });
            match key {
                Some((id, public_key)) => {
                    recipients.push(Recipient {
                        identity_id: platform::decode_identifier(other)?,
                        public_key,
                    });
                    key_ids.push(id);
                }
                None => skipped.push(other.clone()),
            }
        }
        Ok((recipients, key_ids, skipped))
    }

    /// Seal `draft` as a letter to the people its audience resolves to (the member documents
    /// now, or `draft.people`), the writer first: the bytes, who it goes to, and who was left
    /// out.
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
        let action = format!("save {}", draft.env);
        let people = if let Some(p) = &draft.people {
            p.clone()
        } else {
            let members = MemberReader::new(self.client).list(repo).await?;
            resolve_people(&draft.audience, repo.owner_id(), &members)
        };
        let enc = signer.encryption_keys(repo);
        let (sender_key_id, sender) = enc
            .sender()
            .ok_or_else(|| crate::keyring::no_encryption_key_held(&action))?;
        let me_bytes = platform::decode_identifier(&signer.identity.id())?;
        let (recipients, key_ids, skipped) = self
            .recipients(
                repo,
                Recipient {
                    identity_id: me_bytes,
                    public_key: sender.public_key(),
                },
                sender_key_id,
                &people,
            )
            .await?;
        if recipients.len() > MAX_RECIPIENTS {
            return Err(UserError::new(
                codes::USAGE,
                format!(
                    "{action}: {} is {} people. An environment can be shared with at most {MAX_RECIPIENTS}.",
                    draft.audience.label(),
                    recipients.len()
                ),
            )
            .fix("choose a smaller group or specific people (`--audience`)")
            .note("nothing was written")
            .into());
        }
        let mut snap = Snapshot::new(&draft.env, draft.id, draft.audience.clone(), draft.vars.clone());
        snap.generated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(0));
        snap.saved_for.clone_from(&draft.saved_for);
        snap.marked_changed.clone_from(&draft.marked_changed);
        snap.to = recipients
            .iter()
            .map(|r| platform::encode_identifier(r.identity_id))
            .collect();
        snap.to_keys = key_ids;
        let sealed = codec::seal_letter(
            &repo.scope()?.repo_id,
            sender,
            sender_key_id,
            &me_bytes,
            &recipients,
            &snap,
        )
        .map_err(|e| Error::Config(format!("{action}: {e}")))?;
        if sealed.len() as u64 > MAX_SEALED {
            return Err(UserError::new(
                codes::USAGE,
                format!(
                    "{action}: {} values for {} people don't fit one save",
                    snap.vars.len(),
                    recipients.len()
                ),
            )
            .cause(format!(
                "the encrypted environment is {} bytes; one save holds at most {MAX_SEALED}",
                sealed.len()
            ))
            .fix("split it into two environments, or share it with fewer people")
            .note("nothing was written")
            .into());
        }
        Ok((sealed, snap.to, skipped))
    }
}

/// Fetched artifacts and the keys to open them ([`Environments::read`]).
struct Opener {
    repo_id: [u8; 32],
    fetched: BTreeMap<String, std::result::Result<Vec<u8>, String>>,
    owner_keys: BTreeMap<String, Vec<OwnerKey>>,
    reader_id: Option<[u8; 32]>,
    reader_keys: Vec<crate::envelope::PrivateKey>,
    epoch_keys: BTreeMap<u32, EpochKeys>,
    /// The members key chain, for the late-content rule on Members snapshots.
    standing: Option<crate::private::EpochResolution>,
}

impl Opener {
    /// Whether `bytes`, a Members (DFPK 0x01) snapshot, is late content: sealed under an epoch
    /// its owner could no longer write when the manifest landed (as for sealed packs,
    /// [`crate::private::EpochResolution::manifest_standing`]). A manifest with no block height
    /// cannot be judged and never qualifies.
    fn late(&self, m: &PackManifestInfo, bytes: &[u8]) -> bool {
        if bytes.get(4) != Some(&crate::private::pack::VERSION) {
            return false;
        }
        let (Some(res), Ok(header), Ok(owner)) = (
            self.standing.as_ref(),
            crate::private::PackHeader::parse(bytes, bytes.len() as u64),
            platform::decode_identifier(&m.owner_id),
        ) else {
            return false;
        };
        m.created_at_block_height == 0
            || !res
                .manifest_standing(header.epoch(), m.created_at_block_height, &owner)
                .readable
    }

    /// What each of `list` came to: opened ([`codec::open`], D24's order), refused, or unfetched.
    fn open_all(&self, list: &[&PackManifestInfo]) -> BTreeMap<String, Opened> {
        let lookup = |e: u32| self.epoch_keys.get(&e);
        let none: Vec<OwnerKey> = Vec::new();
        list.iter()
            .map(|m| {
                let result = match self.fetched.get(&m.document_id) {
                    Some(Ok(bytes)) if self.late(m, bytes) => Opened::Late,
                    Some(Ok(bytes)) => {
                        let keys = OpenKeys {
                            repo_id: &self.repo_id,
                            owner_keys: self.owner_keys.get(&m.owner_id).unwrap_or(&none),
                            reader: self.reader_id.map(|identity_id| Reader {
                                identity_id,
                                keys: &self.reader_keys,
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
                (m.document_id.clone(), result)
            })
            .collect()
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

/// The authorized manifests (a current maintainer's, the first of each `packHash`), in
/// `($createdAtBlockHeight, $id)` order: exactly the nodes [`chain::resolve`] keeps.
fn authorized<'m>(
    manifests: &'m [PackManifestInfo],
    maintainers: &BTreeSet<String>,
) -> Vec<&'m PackManifestInfo> {
    let mut order: Vec<&PackManifestInfo> = manifests.iter().collect();
    order.sort_by(|a, b| chain_order(a).cmp(&chain_order(b)));
    let mut seen = BTreeSet::new();
    order
        .into_iter()
        .filter(|m| maintainers.contains(&m.owner_id) && seen.insert(m.pack_hash))
        .collect()
}

/// `($createdAtBlockHeight, $id)`: the order the chain reads manifests in.
fn chain_order(m: &PackManifestInfo) -> (u64, &str) {
    (m.created_at_block_height, &m.document_id)
}

fn snapshot_ref(m: &PackManifestInfo) -> SnapshotRef {
    SnapshotRef {
        id: m.document_id.clone(),
        owner_id: m.owner_id.clone(),
        pack_hash: m.pack_hash,
        supersedes: m.supersedes.clone(),
        height: m.created_at_block_height,
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
