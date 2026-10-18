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

/// The epoch history is published below (DESIGN §4.10 step 7): the lower of the seal-off epoch
/// the repository's settings state (`stated`) and the one a run rotated to and recorded
/// (`recorded`), when it recorded one. A rotation by someone else between a run's seal-off and
/// the flip raises the stated one; the run's own seal-off key, which members wrote under during
/// the conversion, is still never published. The web runs the same rule (`cutoffOf`), so both
/// build the same bundles.
#[must_use]
pub fn history_cutoff(stated: Option<u32>, recorded: Option<u32>) -> Option<u32> {
    match (stated, recorded) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// The most epoch-key entries one make-public bundle of epoch keys carries: what fits one
/// Platform chunk (14,700 B) beside its header and a full note, `(14,700 − 7 − 1,024) / 69`. A
/// repository with more epochs below its seal-off epoch is published in several bundles.
pub const MAX_EPOCH_ENTRIES: usize = 198;

/// The note of every make-public bundle of epoch keys ([`epoch_key_bundles`]).
pub const EPOCH_BUNDLE_NOTE: &str = "Everything written before this repository was made public.";

/// The make-public bundles (§18.3) publishing `keys`, epoch keys of the repository `repo_id`
/// (mixed-visibility DESIGN §4.10 step 7): one 0x06 entry per epoch, in epoch order, at most
/// [`MAX_EPOCH_ENTRIES`] per bundle. Empty when `keys` is. The caller passes only epochs below
/// the seal-off epoch ([`crate::keyring::Keyring::epoch_keys_below`]); readers ignore any other.
///
/// # Errors
///
/// Never in practice: [`bundle::encode`] refuses only more than `u16::MAX` entries.
pub fn epoch_key_bundles(
    repo_id: &[u8; 32],
    keys: &BTreeMap<u32, EpochKey>,
) -> Result<Vec<Vec<u8>>, super::PrivateError> {
    let entries: Vec<bundle::Entry> = keys
        .iter()
        .map(|(&revision, key)| bundle::Entry {
            kind: ENTRY_EPOCH_KEY,
            target: *repo_id,
            revision,
            key: key.clone(),
        })
        .collect();
    entries
        .chunks(MAX_EPOCH_ENTRIES)
        .map(|c| bundle::encode(c, EPOCH_BUNDLE_NOTE))
        .collect()
}

/// The v1 tag-65 value (§18.5). Its timestamp is informational.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealOffMarker {
    /// 1 Code only, 2 Everything.
    pub mode: SealOffMode,
    /// Random 16-byte run identifier, kept in the local record too.
    pub conversion_id: [u8; 16],
    /// The enclosing config's epoch.
    pub boundary_epoch: u32,
    /// Client clock in milliseconds.
    pub started_at_ms: u64,
    /// Earlier boundary set aside by an intentional start-over.
    pub replaces_epoch: Option<u32>,
}

/// What becomes public.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SealOffMode {
    /// Chosen branches and tags.
    CodeOnly,
    /// Everything below the boundary.
    Everything,
}

impl SealOffMarker {
    /// A fresh run identity (the enclosing rotation supplies the final epoch).
    pub fn new(
        mode: SealOffMode,
        started_at_ms: u64,
        replaces_epoch: Option<u32>,
    ) -> Result<Self, super::PrivateError> {
        let random = super::keys::rnd32()?;
        Ok(Self {
            mode,
            conversion_id: random[..16].try_into().expect("16 bytes"),
            boundary_epoch: 1,
            started_at_ms,
            replaces_epoch,
        })
    }

    /// Encode all integers in big-endian order.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(34);
        out.extend_from_slice(&[
            1,
            match self.mode {
                SealOffMode::CodeOnly => 1,
                SealOffMode::Everything => 2,
            },
        ]);
        out.extend_from_slice(&self.conversion_id);
        out.extend_from_slice(&self.boundary_epoch.to_be_bytes());
        out.extend_from_slice(&self.started_at_ms.to_be_bytes());
        if let Some(e) = self.replaces_epoch {
            out.extend_from_slice(&e.to_be_bytes());
        }
        out
    }

    /// Unknown values remain candidates at their config's epoch.
    #[must_use]
    pub fn parse(value: &[u8], epoch: u32) -> Option<Self> {
        if !matches!(value.len(), 30 | 34) || value[0] != 1 || epoch == 0 {
            return None;
        }
        let mode = match value[1] {
            1 => SealOffMode::CodeOnly,
            2 => SealOffMode::Everything,
            _ => return None,
        };
        let boundary_epoch = u32::from_be_bytes(value[18..22].try_into().ok()?);
        if boundary_epoch != epoch {
            return None;
        }
        Some(Self {
            mode,
            conversion_id: value[2..18].try_into().ok()?,
            boundary_epoch,
            started_at_ms: u64::from_be_bytes(value[22..30].try_into().ok()?),
            replaces_epoch: if value.len() == 34 {
                Some(u32::from_be_bytes(value[30..34].try_into().ok()?))
            } else {
                None
            },
        })
    }
}

/// A config opened under its anchored epoch key, another key, or not opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealOffOpening {
    /// Raw tag-65 bytes, if present.
    Opened(Option<Vec<u8>>),
    /// The config's commitment differs from its anchored epoch's.
    OtherKey,
    /// No key, malformed framing, or an authentication failure.
    Unreadable,
}

/// Every config as the pure marker rule needs it.
#[derive(Debug, Clone)]
pub struct SealOffConfig {
    /// Raw document id, used for the final tie-break.
    pub id: [u8; 32],
    /// Signed owner identity.
    pub owner: [u8; 32],
    /// Enclosing epoch.
    pub epoch: Option<u32>,
    /// Stamped private.
    pub private: bool,
    /// Platform block height.
    pub height: u64,
    /// Result of opening with the anchored epoch key.
    pub opening: SealOffOpening,
}

/// The authority for an unfinished conversion, also kept after the flip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActiveSealOff {
    /// No owner marker.
    None,
    /// At least one owner config cannot be opened: repair keys first.
    Unknown,
    /// Lowest boundary not set aside by a valid later owner marker.
    Active {
        /// Boundary epoch.
        epoch: u32,
        /// Platform height of the chosen config.
        height: u64,
        /// None for an unknown marker value (the boundary still counts).
        marker: Option<SealOffMarker>,
        /// Highest candidate still in force; start-over must cover all of them.
        highest_epoch: u32,
        /// All older boundaries through this epoch have been set aside by the owner.
        replaces_through: Option<u32>,
    },
}

impl ActiveSealOff {
    /// The boundary, when known. Callers must handle `Unknown` before proceeding.
    #[must_use]
    pub fn epoch(&self) -> Option<u32> {
        match self {
            Self::Active { epoch, .. } => Some(*epoch),
            _ => None,
        }
    }

    /// Highest local or unreplaced owner boundary to cover when starting over.
    #[must_use]
    pub fn replacement_epoch(&self, recorded: Option<u32>) -> Option<u32> {
        recorded.max(match self {
            Self::Active { highest_epoch, .. } => Some(*highest_epoch),
            _ => None,
        })
    }

    /// Lower boundary still in force. Callers must refuse `Unknown` first.
    #[must_use]
    pub fn boundary(&self, recorded: Option<u32>) -> Option<u32> {
        let recorded = match self {
            Self::Active {
                replaces_through: Some(r),
                ..
            } => recorded.filter(|e| e > r),
            _ => recorded,
        };
        history_cutoff(recorded, self.epoch())
    }
}

/// One sticky rule (§18.5), shared with the web's `activeSealOff` and the conformance vectors.
#[must_use]
pub fn active_seal_off(configs: &[SealOffConfig], owner: &[u8; 32]) -> ActiveSealOff {
    let counted: Vec<_> = configs
        .iter()
        .filter(|c| c.owner == *owner && c.private && c.epoch.is_some_and(|e| e >= 1))
        .collect();
    if counted
        .iter()
        .any(|c| c.opening == SealOffOpening::Unreadable)
    {
        return ActiveSealOff::Unknown;
    }
    let mut candidates: Vec<_> = counted
        .into_iter()
        .filter_map(|c| {
            let SealOffOpening::Opened(Some(value)) = &c.opening else {
                return None;
            };
            let epoch = c.epoch?;
            Some((c, epoch, SealOffMarker::parse(value, epoch)))
        })
        .collect();
    let replaces_through = candidates
        .iter()
        .filter_map(|(_, e, m)| m.as_ref()?.replaces_epoch.filter(|r| r < e))
        .max();
    candidates.retain(|(_, e, _)| replaces_through.is_none_or(|r| *e > r));
    let highest_epoch = candidates.iter().map(|(_, e, _)| *e).max();
    candidates.sort_by_key(|(c, e, _)| (*e, c.height, c.id));
    candidates
        .first()
        .map_or(ActiveSealOff::None, |(c, epoch, marker)| {
            ActiveSealOff::Active {
                epoch: *epoch,
                height: c.height,
                marker: marker.clone(),
                highest_epoch: highest_epoch.expect("a selected candidate exists"),
                replaces_through,
            }
        })
}

/// The run's decision from its record, the owner marker, and the anchored key epoch now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SealOffDecision {
    /// Rotate once with a new marker.
    New,
    /// Continue without rotating, checking strictly below this epoch.
    Adopt(u32),
    /// Wait for Platform to show this epoch.
    Lagging(u32),
    /// Only an intentional start-over may replace this boundary.
    Passed(u32),
    /// Already public: publish strictly below the lowest known cutoff.
    Public(Option<u32>),
    /// Repair keys before proceeding.
    Unknown,
}

/// The common boundary decision for both conversion entry points and the shared vectors.
#[must_use]
pub fn seal_off_decision(
    recorded: Option<u32>,
    active: &ActiveSealOff,
    current: Option<u32>,
    flipped: bool,
    stated: Option<u32>,
) -> SealOffDecision {
    if *active == ActiveSealOff::Unknown {
        return SealOffDecision::Unknown;
    }
    let boundary = active.boundary(recorded);
    if flipped {
        return SealOffDecision::Public(history_cutoff(stated, boundary));
    }
    match boundary {
        None => SealOffDecision::New,
        Some(e) if current == Some(e) => SealOffDecision::Adopt(e),
        Some(e) if current.is_some_and(|c| c > e) => SealOffDecision::Passed(e),
        Some(e) => SealOffDecision::Lagging(e),
    }
}

/// A member notice points to the owner marker rather than repeating its contents (§18.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealOffNotice {
    /// The confirmed run's id.
    pub conversion_id: [u8; 16],
    /// The confirmed marker's epoch.
    pub boundary_epoch: u32,
    /// Earlier boundary, for a start-over notice.
    pub replaces_epoch: Option<u32>,
}

impl ActiveSealOff {
    /// Only a known, owner-confirmed marker supplies a notice pointer.
    #[must_use]
    pub fn notice_for(&self, conversion_id: &[u8; 16]) -> Option<SealOffNotice> {
        let Self::Active {
            marker: Some(m), ..
        } = self
        else {
            return None;
        };
        if m.conversion_id != *conversion_id {
            return None;
        }
        Some(SealOffNotice {
            conversion_id: m.conversion_id,
            boundary_epoch: m.boundary_epoch,
            replaces_epoch: m.replaces_epoch,
        })
    }

    /// A received pointer is unconfirmed unless it matches the authoritative owner marker.
    #[must_use]
    pub fn confirms_notice(&self, notice: &SealOffNotice) -> bool {
        self.notice_for(&notice.conversion_id).as_ref() == Some(notice)
    }
}

#[cfg(test)]
mod seal_off_notice_tests {
    use super::*;
    #[test]
    fn notices_resolve_only_to_the_confirmed_owner_marker() {
        let marker = SealOffMarker {
            mode: SealOffMode::Everything,
            conversion_id: [1; 16],
            boundary_epoch: 3,
            started_at_ms: 123,
            replaces_epoch: Some(1),
        };
        let active = ActiveSealOff::Active {
            epoch: 3,
            height: 10,
            highest_epoch: 3,
            replaces_through: Some(1),
            marker: Some(marker),
        };
        assert!(active.notice_for(&[2; 16]).is_none());
        let notice = active.notice_for(&[1; 16]).unwrap();
        assert_eq!(notice.replaces_epoch, Some(1));
        assert!(active.confirms_notice(&notice));
        assert!(!ActiveSealOff::Unknown.confirms_notice(&notice));
        let mut different = notice;
        different.conversion_id[0] = 2;
        assert!(!active.confirms_notice(&different));
    }
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

    /// History is published only below the lower of the stated and the recorded seal-off epoch,
    /// so a rotation that slipped in before the flip never publishes a run's own seal-off key.
    #[test]
    fn history_stops_below_the_runs_own_seal_off() {
        assert_eq!(history_cutoff(Some(4), Some(3)), Some(3));
        assert_eq!(history_cutoff(Some(3), Some(3)), Some(3));
        assert_eq!(history_cutoff(Some(3), Some(5)), Some(3));
        assert_eq!(history_cutoff(Some(3), None), Some(3));
        assert_eq!(history_cutoff(None, Some(2)), Some(2));
        assert_eq!(history_cutoff(None, None), None);
    }

    #[test]
    fn epoch_key_bundles_publish_each_epoch_once_and_split_by_size() {
        let repo = [7u8; 32];
        let keys: BTreeMap<u32, EpochKey> = (0..u32::try_from(MAX_EPOCH_ENTRIES + 3).unwrap())
            .map(|e| {
                (
                    e,
                    EpochKey::from_bytes([u8::try_from(e % 251).unwrap(); 32]),
                )
            })
            .collect();
        let bundles = epoch_key_bundles(&repo, &keys).unwrap();
        assert_eq!(bundles.len(), 2);
        let mut seen = Vec::new();
        for b in &bundles {
            assert!(b.len() <= 14_700);
            let parsed = bundle::parse(b).unwrap();
            assert_eq!(parsed.note, EPOCH_BUNDLE_NOTE);
            for e in parsed.entries {
                assert_eq!((e.kind, e.target), (ENTRY_EPOCH_KEY, repo));
                assert_eq!(&e.key, &keys[&e.revision]);
                seen.push(e.revision);
            }
        }
        assert_eq!(seen, keys.keys().copied().collect::<Vec<_>>());
        assert!(epoch_key_bundles(&repo, &BTreeMap::new())
            .unwrap()
            .is_empty());
    }

    /// A fixed input's bundle bytes, as `sha256` (the `packHash` a kind-7 manifest records):
    /// forge-web's `epochKeyBundles` asserts the same digest (`lib/private/convert.test.ts`), so
    /// a run started in `dg` is recognised as published by the web and the other way round.
    #[test]
    fn epoch_key_bundles_are_byte_identical_across_stacks() {
        use sha2::{Digest as _, Sha256};
        let repo = [7u8; 32];
        let keys: BTreeMap<u32, EpochKey> = [(0u32, 0x10u8), (1, 0x21), (5, 0x35)]
            .into_iter()
            .map(|(e, b)| (e, EpochKey::from_bytes([b; 32])))
            .collect();
        let bundles = epoch_key_bundles(&repo, &keys).unwrap();
        assert_eq!(bundles.len(), 1);
        assert_eq!(bundles[0].len(), 7 + 3 * 69 + EPOCH_BUNDLE_NOTE.len());
        assert_eq!(
            hex::encode(Sha256::digest(&bundles[0])),
            "740906d2c6534bbc3c7eaaa2b4a5e0321b3c2b4d710b5c9191d30d5953811757"
        );
    }
}

#[cfg(test)]
mod replacement_review_tests {
    use super::*;
    fn configs() -> Vec<SealOffConfig> {
        [1, 2, 3]
            .map(|epoch| SealOffConfig {
                id: [u8::try_from(epoch).unwrap(); 32],
                owner: [1; 32],
                epoch: Some(epoch),
                private: true,
                height: u64::from(epoch),
                opening: SealOffOpening::Opened(Some(
                    SealOffMarker {
                        mode: SealOffMode::CodeOnly,
                        conversion_id: [1; 16],
                        boundary_epoch: epoch,
                        started_at_ms: 1,
                        replaces_epoch: (epoch == 3).then_some(2),
                    }
                    .encode(),
                )),
            })
            .to_vec()
    }
    #[test]
    fn start_over_sets_aside_all_prior_owner_runs() {
        assert_eq!(active_seal_off(&configs(), &[1; 32]).epoch(), Some(3));
    }
    #[test]
    fn start_over_covers_highest_owner_or_local_boundary() {
        let mut configs = configs();
        configs.pop();
        let active = active_seal_off(&configs, &[1; 32]);
        assert_eq!(active.epoch(), Some(1));
        assert_eq!(active.replacement_epoch(None), Some(2));
        assert_eq!(active.replacement_epoch(Some(1)), Some(2));
        assert_eq!(active.replacement_epoch(Some(4)), Some(4));
    }
    #[test]
    fn stale_record_on_another_device_adopts_replacement() {
        let active = active_seal_off(&configs(), &[1; 32]);
        assert_eq!(
            seal_off_decision(Some(1), &active, Some(3), false, None),
            SealOffDecision::Adopt(3)
        );
    }
}
