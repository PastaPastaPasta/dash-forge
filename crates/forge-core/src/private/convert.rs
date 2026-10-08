//! Repositories made public (`docs/security/private-repos.md` §18; DESIGN §4.10, D36): the facts
//! every reader derives from the `config` timeline alone, and the epoch keys an owner's
//! make-public bundle publishes.
//!
//! A repository is **converted** when it is public now and has a `config` stamped `vis:
//! "private"`: consensus held every document's `vis` equal to its repository's visibility when it
//! was written, and a repository can only ever go from private to public. Its **seal-off epoch**
//! `E'` is the highest existing epoch stated while it was private (the rotation the conversion
//! runs before the flip); only epochs below it may be published. Its **conversion marker** is the
//! first config stamped `vis: "public"`: a pack manifest recorded up to that block height may
//! hold sealed bytes and is checked before it is downloaded.

use std::collections::BTreeMap;

use super::bundle::{self, ENTRY_EPOCH_KEY};
use super::epoch::{Alert, Anchor};
use super::keys::{EpochKey, EpochKeys};
use crate::rules::v2::Visibility;

/// The minimum Forge version that reads a repository made public (§18): clones, fetches, forks
/// and pages of a converted repository need it. The "Make this repo public" dialog names it
/// ("People on Forge older than 0.2.0 can't clone it until they update").
pub const CONVERTED_REPO_MIN_CLIENT_VERSION: &str = "0.2.0";

/// One `config` document as the conversion facts need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigStamp {
    /// `$id` (orders configs of one block).
    pub id: [u8; 32],
    /// `epoch` (absent on a plaintext config).
    pub epoch: Option<u32>,
    /// It is stamped `vis: "private"`.
    pub private: bool,
    /// `$createdAtBlockHeight`.
    pub height: u64,
}

/// What a reader knows about a repository made public.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Conversion {
    /// `E'`: the highest existing epoch stated while the repository was private. `None` when no
    /// such epoch exists (nothing may be published).
    pub seal_off_epoch: Option<u32>,
    /// The block height of the first `vis: "public"` config; `None` before one lands (every
    /// manifest is then checked).
    pub marker_height: Option<u64>,
}

impl Conversion {
    /// The conversion facts of a repository that is public now (`public`), from every one of its
    /// configs; `existing` says which epochs exist (§5.3). `None` when it was never private.
    #[must_use]
    pub fn of(
        public: bool,
        configs: &[ConfigStamp],
        existing: impl Fn(u32) -> bool,
    ) -> Option<Self> {
        if !public || !configs.iter().any(|c| c.private) {
            return None;
        }
        let seal_off_epoch = configs
            .iter()
            .filter(|c| c.private)
            .filter_map(|c| c.epoch)
            .filter(|&e| existing(e))
            .max();
        // a config with no block height (0) cannot be placed, so it never marks the conversion
        let marker_height = configs
            .iter()
            .filter(|c| !c.private && c.height > 0)
            .map(|c| (c.height, c.id))
            .min()
            .map(|(h, _)| h);
        Some(Self {
            seal_off_epoch,
            marker_height,
        })
    }

    /// Whether a pack manifest recorded at block height `height` may hold bytes sealed while the
    /// repository was private: at or before the marker's height, or any before a marker exists
    /// (a height of 0, unknown, counts). Such a pack's first bytes are checked before it is
    /// downloaded; a plaintext pack pushed between the flip and the marker passes that check.
    #[must_use]
    pub fn may_be_sealed(&self, height: u64) -> bool {
        self.marker_height.is_none_or(|m| height <= m)
    }
}

/// Why a reader skips a stored artifact (§3.2, §18.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// Sealed under key epoch `epoch`, which this reader does not hold: written while a
    /// repository made public was private, and not among the keys its owner published.
    NoKey {
        /// The sealed header's epoch.
        epoch: u32,
    },
    /// A sealed header of a version this client does not open (specific people, or a later
    /// client's audience).
    OtherFormat {
        /// The header version.
        version: u8,
    },
}

/// Whether a reader skips an artifact of a PUBLIC repository by its first bytes `head` (at least
/// 12; the whole artifact after a download), holding the epoch keys `holds` says (§18.2): a
/// sealed header under an epoch it does not hold, or of another version. A plaintext head, or
/// one too short to tell, is read as it is. (A private repository's artifacts are all sealed;
/// only another header version is skipped there.)
#[must_use]
pub fn skip_reason(head: &[u8], holds: impl Fn(u32) -> bool) -> Option<SkipReason> {
    use super::pack::{sniff, Head};
    match sniff(head) {
        Head::Sealed { epoch } if !holds(epoch) => Some(SkipReason::NoKey { epoch }),
        Head::OtherVersion(version) => Some(SkipReason::OtherFormat { version }),
        _ => None,
    }
}

/// The `vis` a document is opened under (§17, §18.1), or `None` when it is malformed: its own
/// stamp, which consensus held equal to its repository's visibility when it was written. A
/// repository made public (`converted`) keeps its earlier documents' `"private"`; a type without
/// a stamp (an `event`) is its repository's, except a v0x01 one (`enc0`) in a repository made
/// public, which only the private era wrote. A `"public"` document in a private repository
/// cannot exist, as a repository never becomes private: malformed.
#[must_use]
pub fn open_vis(
    stamp: Option<&str>,
    repository: Visibility,
    converted: bool,
    enc0: Option<u8>,
) -> Option<Visibility> {
    match (stamp, repository) {
        (None, Visibility::Public) if converted && enc0 == Some(super::doc::V1) => {
            Some(Visibility::Private)
        }
        (None, r) => Some(r),
        (Some("private"), _) => Some(Visibility::Private),
        (Some("public"), Visibility::Public) => Some(Visibility::Public),
        _ => None,
    }
}

/// One make-public bundle: its manifest's `$ownerId` and its (hash-verified) bytes.
#[derive(Debug, Clone)]
pub struct PublishedBundle {
    /// The manifest's `$ownerId`.
    pub owner: [u8; 32],
    /// The bundle's bytes ([`bundle::parse`]).
    pub bytes: Vec<u8>,
}

/// The epoch keys a converted repository's owner published (§18.3), each checked: an entry of
/// type 0x06 counts only in a bundle written by `repo_owner`, naming `repo_id`, for an existing
/// epoch below the seal-off epoch, and only when its key commits to that epoch's anchor. A key
/// that does not is a `PublishedKeyMismatch` alert and is ignored. Every other entry, a bundle
/// from anyone else and a bundle that does not parse are ignored.
#[must_use]
pub fn published_keys(
    repo_id: &[u8; 32],
    repo_owner: &[u8; 32],
    conversion: &Conversion,
    anchors: &BTreeMap<u32, Anchor>,
    bundles: &[PublishedBundle],
) -> (BTreeMap<u32, EpochKey>, Vec<Alert>) {
    let mut keys = BTreeMap::new();
    let mut alerts = Vec::new();
    let Some(seal_off) = conversion.seal_off_epoch else {
        return (keys, alerts);
    };
    for b in bundles.iter().filter(|b| b.owner == *repo_owner) {
        let Ok(parsed) = bundle::parse(&b.bytes) else {
            continue;
        };
        for e in parsed
            .entries
            .iter()
            .filter(|e| e.kind == ENTRY_EPOCH_KEY && e.target == *repo_id && e.revision < seal_off)
        {
            let Some(commit) = anchors.get(&e.revision).and_then(|a| a.commit) else {
                continue;
            };
            if EpochKeys::derive(repo_id, e.revision, &e.key).commits_to(&commit) {
                keys.entry(e.revision).or_insert_with(|| e.key.clone());
            } else {
                alerts.push(Alert::PublishedKeyMismatch {
                    epoch: e.revision,
                    author: b.owner,
                });
            }
        }
    }
    alerts.sort();
    alerts.dedup();
    (keys, alerts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(id: u8, epoch: Option<u32>, private: bool, height: u64) -> ConfigStamp {
        ConfigStamp {
            id: [id; 32],
            epoch,
            private,
            height,
        }
    }

    #[test]
    fn conversion_facts_come_from_the_config_timeline() {
        let configs = [
            stamp(1, Some(0), true, 10),
            stamp(2, Some(1), true, 20),
            stamp(3, Some(2), true, 30), // the seal-off rotation, still private
            stamp(4, None, false, 40),   // the plaintext config after the flip: the marker
            stamp(5, Some(3), false, 50), // a later public anchor
            stamp(6, Some(9), true, 25), // a private config of an epoch that does not exist
        ];
        let c = Conversion::of(true, &configs, |e| e <= 3).unwrap();
        assert_eq!(c.seal_off_epoch, Some(2));
        assert_eq!(c.marker_height, Some(40));
        assert!(c.may_be_sealed(40) && c.may_be_sealed(0) && !c.may_be_sealed(41));
        // never private, or private now: not converted
        assert_eq!(Conversion::of(false, &configs, |_| true), None);
        assert_eq!(Conversion::of(true, &configs[3..5], |_| true), None);
        // between the flip and the first public config: every manifest is checked
        let early = Conversion::of(true, &configs[..3], |_| true).unwrap();
        assert!(early.may_be_sealed(u64::MAX));
    }
}
