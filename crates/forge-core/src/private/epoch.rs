//! Epochs, anchors and membership (`docs/security/private-repos.md` §5.3–§5.6, §8.2), as one
//! pure function over flattened rows: which epochs exist, which is current, which the reader can
//! read (accepted wraps plus the `prevEpochKey` chain), the alerts to raise, and the repair
//! check a maintainer's client runs on every visit.
//!
//! Every statement counts only while its author is a **current maintainer** (C1): anchors,
//! wraps, and so the current epoch.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::doc::{
    hex32, is_late, open_with, AnchorRef, DocHeader, OpenContext, Opened, MIN_V2, V2,
};
use super::keys::{EpochKey, EpochKeys};
use super::DocKind;
use crate::rules::v2::Role;

/// A current `maintainer` or `writer` document of the repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberRow {
    /// `memberId`.
    #[serde(with = "hex32")]
    pub identity: [u8; 32],
    /// Which document type.
    pub role: Role,
    /// `$createdAt` (ms).
    pub created_at: u64,
}

/// A `config` document of the repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigRow {
    /// `$id`, 32 bytes: anchors tie-break on it as raw bytes (§5.3), never as a string.
    #[serde(with = "hex32")]
    pub id: [u8; 32],
    /// `$ownerId`.
    #[serde(with = "hex32")]
    pub owner: [u8; 32],
    /// `epoch`.
    pub epoch: u32,
    /// `$createdAtBlockHeight`, the network-set order of anchors (M1).
    pub created_at_block_height: u64,
    /// `$createdAt` (client-set; never used to order anchors).
    pub created_at: u64,
    /// `enc`.
    #[serde(with = "hex_bytes")]
    pub enc: Vec<u8>,
}

/// A `repoKey` document of the repository, with the key the reader recovered from it, if the
/// wrap is addressed to the reader and unwrapped to a version-1 plaintext with a matching KCV.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WrapRow {
    /// `$id`.
    #[serde(with = "hex32")]
    pub id: [u8; 32],
    /// `$ownerId`, the wrapping maintainer.
    #[serde(with = "hex32")]
    pub owner: [u8; 32],
    /// `memberId`.
    #[serde(with = "hex32")]
    pub member_id: [u8; 32],
    /// `epoch`.
    pub epoch: u32,
    /// `recipientKeyId`.
    pub recipient_key_id: u32,
    /// Whether `recipientKeyId` is still an enabled key on the member's identity (§5.6).
    pub key_enabled: bool,
    /// The recovered epoch key (reader's own wraps only).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "super::keys::opt_key_serde"
    )]
    pub key: Option<EpochKey>,
}

/// An alert the UI shows the affected member and maintainers (§9); never a silent downgrade.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Alert {
    /// A current maintainer gave the reader a key that does not commit to the epoch's anchor.
    #[serde(rename_all = "camelCase")]
    KeyMismatch {
        /// The epoch.
        epoch: u32,
        /// The wrap's author.
        #[serde(with = "hex32")]
        author: [u8; 32],
    },
    /// The `prevEpochKey` chain stops at this epoch's anchor.
    #[serde(rename_all = "camelCase")]
    ChainBroken {
        /// The epoch whose anchor breaks the chain.
        epoch: u32,
        /// The anchor's author.
        #[serde(with = "hex32")]
        author: [u8; 32],
    },
    /// A current maintainer's config for an epoch that does not exist: above the first missing
    /// epoch number, or posted before the epoch below it was anchored (§5.3).
    #[serde(rename_all = "camelCase")]
    EpochGap {
        /// The epoch it names.
        epoch: u32,
        /// Its author.
        #[serde(with = "hex32")]
        author: [u8; 32],
    },
    /// The current epoch is wrapped to identities that are not members, or is burned: rotate
    /// (H2, §5.3). `members` is empty for a burned epoch with no wrapped non-member.
    #[serde(rename_all = "camelCase")]
    RotationRequired {
        /// The current epoch.
        epoch: u32,
        /// The wrapped non-members.
        #[serde(with = "hex32_vec")]
        members: Vec<[u8; 32]>,
    },
}

impl Alert {
    fn sort_key(&self) -> (u32, u8, [u8; 32]) {
        match self {
            Self::KeyMismatch { epoch, author } => (*epoch, 0, *author),
            Self::ChainBroken { epoch, author } => (*epoch, 1, *author),
            Self::EpochGap { epoch, author } => (*epoch, 2, *author),
            Self::RotationRequired { epoch, .. } => (*epoch, 3, [0; 32]),
        }
    }
}

/// The repair check of §5.6 for the current epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Repair {
    /// Rotate (§5.5 steps 1–4): the current epoch is wrapped to a non-member, or is burned.
    pub rotate: bool,
    /// Wrapped identities that are not members.
    #[serde(with = "hex32_vec")]
    pub non_members: Vec<[u8; 32]>,
    /// Members with no wrap for the current epoch to an enabled key: wrap them, no rotation.
    #[serde(with = "hex32_vec")]
    pub missing_wraps: Vec<[u8; 32]>,
}

/// One existing epoch's anchor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    /// The anchor config's `$id`.
    pub id: [u8; 32],
    /// Its author, a current maintainer.
    pub owner: [u8; 32],
    /// Its `$createdAtBlockHeight`.
    pub height: u64,
    /// The commitment its `enc` carries (`None` for an `enc` that is not v0x02: it matches no
    /// key).
    pub commit: Option<[u8; 32]>,
    /// The block height of stated(e): the first config (by anyone) carrying this commitment,
    /// when the epoch's key was first stated on chain (§5.3). A re-anchor keeps it.
    pub stated_height: u64,
}

/// Everything [`resolve_epochs`] decides.
#[derive(Clone, Default)]
pub struct EpochResolution {
    /// The highest existing epoch (epochs exist contiguously from 0).
    pub current_epoch: Option<u32>,
    /// The anchor of every existing epoch.
    pub anchors: BTreeMap<u32, Anchor>,
    /// The key of every epoch the reader can read.
    pub keys: BTreeMap<u32, EpochKey>,
    /// The epoch the reader writes under: the current epoch, if readable, not burned (§5.3)
    /// and not wrapped to a non-member (§5.6).
    pub write_epoch: Option<u32>,
    /// Readable epochs whose anchor is burned (§5.3): chain links only, never written under;
    /// content under one is late unless its author is a current member.
    pub burned: BTreeSet<u32>,
    /// Epochs that appear in configs or wraps but have no anchor (not epochs; §5.3).
    pub unanchored: Vec<u32>,
    /// Alerts, deduplicated and ordered by `(epoch, kind, author)`.
    pub alerts: Vec<Alert>,
    /// The repair check for the current epoch.
    pub repair: Option<Repair>,
    /// Current members (whose late content is still shown, §8.2).
    pub members: BTreeSet<[u8; 32]>,
}

impl std::fmt::Debug for EpochResolution {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EpochResolution")
            .field("current_epoch", &self.current_epoch)
            .field("readable", &self.keys.keys().collect::<Vec<_>>())
            .field("write_epoch", &self.write_epoch)
            .field("burned", &self.burned)
            .field("unanchored", &self.unanchored)
            .field("alerts", &self.alerts)
            .field("repair", &self.repair)
            .finish_non_exhaustive()
    }
}

/// How a manifest stands under the late-content rule (§8.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestStanding {
    /// Its sealed header's epoch is older than the epoch current at its block height, or is
    /// burned: shown to maintainers as "uploaded under an old key".
    pub suspect: bool,
    /// Whether to read it: always for a current member's upload, else only when neither suspect
    /// nor late.
    pub readable: bool,
}

impl EpochResolution {
    fn anchor_refs(&self) -> BTreeMap<u32, AnchorRef> {
        self.anchors
            .iter()
            .map(|(&e, a)| {
                (
                    e,
                    AnchorRef {
                        id: a.id,
                        height: a.height,
                    },
                )
            })
            .collect()
    }

    /// The [`OpenContext`] for [`super::open_content`]: subkeys of every readable epoch, the
    /// anchors and the members.
    #[must_use]
    pub fn open_context(&self, repo_id: &[u8; 32]) -> OpenContext {
        OpenContext {
            keys: self
                .keys
                .iter()
                .map(|(&e, k)| (e, EpochKeys::derive(repo_id, e, k)))
                .collect(),
            anchors: self.anchor_refs(),
            members: self.members.clone(),
            burned: self.burned.clone(),
        }
    }

    /// Whether content under `epoch` at block height `height` by `owner` is late (§8.2).
    #[must_use]
    pub fn is_late(&self, epoch: u32, height: u64, owner: &[u8; 32]) -> bool {
        is_late(
            &self.anchor_refs(),
            &self.burned,
            epoch,
            height,
            self.members.contains(owner),
        )
    }

    /// How a manifest whose sealed header names `header_epoch`, written at `height` by `owner`,
    /// stands (§8.2).
    #[must_use]
    pub fn manifest_standing(
        &self,
        header_epoch: u32,
        height: u64,
        owner: &[u8; 32],
    ) -> ManifestStanding {
        let current_at = self
            .anchors
            .iter()
            .filter(|(_, a)| a.height <= height)
            .map(|(&e, _)| e)
            .max();
        let suspect =
            current_at.is_some_and(|c| header_epoch < c) || self.burned.contains(&header_epoch);
        let member = self.members.contains(owner);
        let late = self.is_late(header_epoch, height, owner);
        ManifestStanding {
            suspect,
            readable: member || (!suspect && !late),
        }
    }
}

/// anchor(e) for every epoch (§5.3): the first config for `e` by `($createdAtBlockHeight, $id)`
/// whose author is a current maintainer, whether or not the reader can open it, and, for
/// `e ≥ 1`, strictly after **stated(e − 1)** in that order: the first config for `e − 1` (itself
/// after stated(e − 2)) that carries anchor(e − 1)'s commitment, by anyone, i.e. when that
/// epoch's key was first stated on chain. `config` is maintainer-gated and non-deletable, so
/// this is fixed history: a config posted before the epoch below it had its key is never an
/// anchor (no honest flow pre-posts), while a re-anchor after a maintainer's removal repeats the
/// commitment and so leaves the epochs above it intact. Epochs are kept only for the contiguous
/// run from 0. Returns the anchors and, for every other epoch a current maintainer named, its
/// first config (each an `EpochGap`).
fn select_anchors<'c>(
    configs: &'c [ConfigRow],
    maintainers: &BTreeSet<[u8; 32]>,
) -> (BTreeMap<u32, (&'c ConfigRow, u64)>, Vec<&'c ConfigRow>) {
    let order = |c: &ConfigRow| (c.created_at_block_height, c.id);
    let mut by_epoch: BTreeMap<u32, Vec<&ConfigRow>> = BTreeMap::new();
    for c in configs {
        by_epoch.entry(c.epoch).or_default().push(c);
    }
    for cs in by_epoch.values_mut() {
        cs.sort_by_key(|c| order(c));
    }
    let mut anchors: BTreeMap<u32, (&ConfigRow, u64)> = BTreeMap::new();
    let mut stated: Option<(u64, [u8; 32])> = None;
    for e in 0..=u32::MAX {
        let Some(cs) = by_epoch.get(&e) else { break };
        let valid: Vec<&ConfigRow> = cs
            .iter()
            .copied()
            .filter(|c| stated.is_none_or(|b| order(c) > b))
            .collect();
        let Some(&anchor) = valid.iter().find(|c| maintainers.contains(&c.owner)) else {
            break;
        };
        let commit = anchor_of(anchor).commit;
        let first = valid
            .iter()
            .find(|c| commit.is_some() && anchor_of(c).commit == commit)
            .map_or(anchor, |c| *c);
        anchors.insert(e, (anchor, first.created_at_block_height));
        stated = Some(order(first));
    }
    let gaps = by_epoch
        .iter()
        .filter(|(e, _)| !anchors.contains_key(e))
        .filter_map(|(_, cs)| cs.iter().find(|c| maintainers.contains(&c.owner)).copied())
        .collect();
    (anchors, gaps)
}

fn anchor_of(c: &ConfigRow) -> Anchor {
    let commit = (c.enc.len() >= MIN_V2 && c.enc[0] == V2)
        .then(|| c.enc[1..33].try_into().expect("32 bytes"));
    Anchor {
        id: c.id,
        owner: c.owner,
        height: c.created_at_block_height,
        commit,
        stated_height: c.created_at_block_height,
    }
}

/// Walk the `prevEpochKey` chain down from `start` (§5.3, L2), adding every epoch it reaches to
/// `keys`, and raising `ChainBroken` where it stops early. Each anchor links to exactly the
/// epoch below it (`prevEpoch = e − 1`). A burned anchor carries no `prevEpochKey`, so a walk
/// that reaches one stops there; the anchor above a burned run carries `skipEpochKey`, the key of
/// the nearest epoch below the run that is not burned, and the walk continues from that epoch
/// (the burned epochs in between stay unreadable through this walk: nothing is sealed under
/// them).
fn walk_chain(
    repo_id: &[u8; 32],
    start: u32,
    first: &BTreeMap<u32, &ConfigRow>,
    commits_to: &impl Fn(u32, &EpochKey) -> bool,
    keys: &mut BTreeMap<u32, EpochKey>,
    alerts: &mut BTreeSet<Alert>,
) {
    let open = |e: u32, key: &EpochKey| -> Option<Box<super::Fields>> {
        let c = first[&e];
        let header = DocHeader::new(DocKind::Config, c.owner, e);
        match open_with(&EpochKeys::derive(repo_id, e, key), &header, &c.enc, true) {
            Opened::Readable(f) => Some(f),
            _ => None,
        }
    };
    let mut e = start;
    while e > 0 {
        let broken = Alert::ChainBroken {
            epoch: e,
            author: first[&e].owner,
        };
        let Some(fields) = open(e, &keys[&e]) else {
            alerts.insert(broken);
            return;
        };
        if fields.burned {
            return; // a chain link only from above (its skipEpochKey)
        }
        let (Some(p), Some(pk)) = (fields.prev_epoch, fields.prev_epoch_key.clone()) else {
            alerts.insert(broken);
            return;
        };
        if p != e - 1 || !commits_to(p, &pk) {
            alerts.insert(broken);
            return;
        }
        let below_burned = open(p, &pk).is_some_and(|f| f.burned);
        if !below_burned {
            if keys.contains_key(&p) {
                return;
            }
            keys.insert(p, pk);
            e = p;
            continue;
        }
        // the burned epoch's own key (readable, and judged burned, like any epoch)
        keys.entry(p).or_insert(pk);
        // step over the burned run with the skip key: the nearest lower epoch it commits to
        let target = fields.skip_epoch_key.as_ref().and_then(|sk| {
            (0..p)
                .rev()
                .find(|&s| commits_to(s, sk))
                .map(|s| (s, sk.clone()))
        });
        let Some((s, sk)) = target.filter(|(s, sk)| open(*s, sk).is_some_and(|f| !f.burned)) else {
            alerts.insert(broken);
            return;
        };
        if keys.contains_key(&s) {
            return;
        }
        keys.insert(s, sk);
        e = s;
    }
}

/// The readable epochs (`keys`) whose anchor's sealed config carries the burned flag (§5.3): only the
/// anchor's flag counts, and only an epoch the reader holds the key of can be judged.
fn burned_epochs(
    repo_id: &[u8; 32],
    anchors: &BTreeMap<u32, &ConfigRow>,
    keys: &BTreeMap<u32, EpochKey>,
) -> BTreeSet<u32> {
    keys.iter()
        .filter(|(&e, k)| {
            let c = anchors[&e];
            let header = DocHeader::new(DocKind::Config, c.owner, e);
            matches!(
                open_with(&EpochKeys::derive(repo_id, e, k), &header, &c.enc, true),
                Opened::Readable(f) if f.burned
            )
        })
        .map(|(&e, _)| e)
        .collect()
}

/// The repair check of §5.6 for the current epoch `n`; a burned `n` always rotates.
fn repair_check(
    n: u32,
    burned: bool,
    wraps: &[WrapRow],
    maintainers: &BTreeSet<[u8; 32]>,
    members: &BTreeSet<[u8; 32]>,
) -> Repair {
    let from_maintainer = |w: &&WrapRow| w.epoch == n && maintainers.contains(&w.owner);
    let wrapped: BTreeSet<[u8; 32]> = wraps
        .iter()
        .filter(from_maintainer)
        .map(|w| w.member_id)
        .collect();
    let enabled: BTreeSet<[u8; 32]> = wraps
        .iter()
        .filter(from_maintainer)
        .filter(|w| w.key_enabled)
        .map(|w| w.member_id)
        .collect();
    let non_members: Vec<[u8; 32]> = wrapped.difference(members).copied().collect();
    let missing_wraps: Vec<[u8; 32]> = members.difference(&enabled).copied().collect();
    Repair {
        rotate: burned || !non_members.is_empty(),
        non_members,
        missing_wraps,
    }
}

/// Resolve a repository's epochs for `reader` from its current membership documents, all of its
/// `config` documents and its `repoKey` documents (§5.3–§5.6).
#[must_use]
pub fn resolve_epochs(
    repo_id: &[u8; 32],
    reader: &[u8; 32],
    memberships: &[MemberRow],
    configs: &[ConfigRow],
    wraps: &[WrapRow],
) -> EpochResolution {
    let maintainers: BTreeSet<[u8; 32]> = memberships
        .iter()
        .filter(|m| m.role == Role::Maintainer)
        .map(|m| m.identity)
        .collect();
    let members: BTreeSet<[u8; 32]> = memberships.iter().map(|m| m.identity).collect();

    let (selected, gaps) = select_anchors(configs, &maintainers);
    let first: BTreeMap<u32, &ConfigRow> = selected.iter().map(|(&e, (c, _))| (e, *c)).collect();
    let anchors: BTreeMap<u32, Anchor> = selected
        .iter()
        .map(|(&e, (c, stated))| {
            (
                e,
                Anchor {
                    stated_height: *stated,
                    ..anchor_of(c)
                },
            )
        })
        .collect();
    let current_epoch = anchors.keys().next_back().copied();
    let unanchored: Vec<u32> = configs
        .iter()
        .map(|c| c.epoch)
        .chain(wraps.iter().map(|w| w.epoch))
        .filter(|e| !anchors.contains_key(e))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let commits_to = |e: u32, key: &EpochKey| {
        anchors
            .get(&e)
            .and_then(|a| a.commit)
            .is_some_and(|c| EpochKeys::derive(repo_id, e, key).commits_to(&c))
    };

    // accepted wraps (§5.4): to the reader, from a current maintainer, for an existing epoch; a
    // key that does not commit to the anchor is a KeyMismatch, never a reason to look elsewhere
    let mut alerts: BTreeSet<Alert> = gaps
        .iter()
        .map(|c| Alert::EpochGap {
            epoch: c.epoch,
            author: c.owner,
        })
        .collect();
    let mut keys: BTreeMap<u32, EpochKey> = BTreeMap::new();
    let mut starts: Vec<u32> = Vec::new();
    for w in wraps {
        let Some(key) = &w.key else { continue };
        if w.member_id != *reader
            || !maintainers.contains(&w.owner)
            || !anchors.contains_key(&w.epoch)
        {
            continue;
        }
        if commits_to(w.epoch, key) {
            keys.insert(w.epoch, key.clone());
            starts.push(w.epoch);
        } else {
            alerts.insert(Alert::KeyMismatch {
                epoch: w.epoch,
                author: w.owner,
            });
        }
    }
    for start in starts {
        walk_chain(repo_id, start, &first, &commits_to, &mut keys, &mut alerts);
    }

    let burned = burned_epochs(repo_id, &first, &keys);
    let repair =
        current_epoch.map(|n| repair_check(n, burned.contains(&n), wraps, &maintainers, &members));
    if let (Some(r), Some(n)) = (&repair, current_epoch) {
        if r.rotate && maintainers.contains(reader) {
            alerts.insert(Alert::RotationRequired {
                epoch: n,
                members: r.non_members.clone(),
            });
        }
    }
    let mut alerts: Vec<Alert> = alerts.into_iter().collect();
    alerts.sort_by_key(Alert::sort_key);

    // nothing is written under an epoch a non-member holds (§5.6): it waits for the rotation
    let leaked = repair.as_ref().is_some_and(|r| !r.non_members.is_empty());
    let write_epoch =
        current_epoch.filter(|n| keys.contains_key(n) && !burned.contains(n) && !leaked);
    EpochResolution {
        current_epoch,
        anchors,
        keys,
        write_epoch,
        burned,
        unanchored,
        alerts,
        repair,
        members,
    }
}

mod hex_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        hex::decode(String::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}

mod hex32_vec {
    use serde::ser::SerializeSeq;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[[u8; 32]], s: S) -> Result<S::Ok, S::Error> {
        let mut seq = s.serialize_seq(Some(v.len()))?;
        for id in v {
            seq.serialize_element(&hex::encode(id))?;
        }
        seq.end()
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<[u8; 32]>, D::Error> {
        Vec::<String>::deserialize(d)?
            .into_iter()
            .map(|s| {
                let b = hex::decode(s).map_err(serde::de::Error::custom)?;
                <[u8; 32]>::try_from(b).map_err(|_| serde::de::Error::custom("expected 32 bytes"))
            })
            .collect()
    }
}
