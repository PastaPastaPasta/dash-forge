//! Plain-git mirrors of a public repository (`forge-gateway`) and how a client checks one.
//!
//! A mirror serves `git clone https://<gateway>/<owner>/<name>.git`. Git objects are
//! content-addressed, so the only things a reader trusts a mirror for are **which tips it serves
//! for which refs, and how fresh they are**. Both are checkable:
//!
//! - the mirror publishes a [`Manifest`] (`<url>/forge-manifest.json`): the Platform height and
//!   time of its snapshot, and for every ref the `$id` of the `refUpdate` /
//!   `protectedRefUpdate` that set its tip, which anyone can re-read with proofs;
//! - [`compare`] checks the refs a mirror actually serves (`git ls-remote <url>`) against the
//!   refs folded from Platform with proofs ([`crate::repo::RepoService::read_ref_records`]).
//!   A ref is a **match**, **stale** (it serves a tip the ref validly had, and the ref moved
//!   after the mirror's snapshot), or a **mismatch** (a tip the ref never had, a ref Platform
//!   does not have, or an old tip or an omitted ref the snapshot should already show).
//!
//! The worst a dishonest mirror can do is therefore delay or omit, and either shows. It is a
//! convenience: `dash://` reads Platform and storage directly and never needs it.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::repo::{RefRecord, RefTip};

/// The manifest's file name under a mirror's URL (`<url>/forge-manifest.json`).
pub const MANIFEST_FILE: &str = "forge-manifest.json";

/// The manifest schema this version writes and reads.
pub const MANIFEST_SCHEMA: &str = "forge-gateway-manifest/v1";

/// What a mirror says it serves, and as of when (`forge-manifest.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// [`MANIFEST_SCHEMA`].
    pub schema: String,
    /// The network key (`testnet`, `mainnet`, `devnet-sakura`).
    pub network: String,
    /// The forge-core contract id the refs were read from.
    pub forge_core: String,
    /// The repository's `repo` document id.
    pub repo_id: String,
    /// Its owner's identity id.
    pub owner_id: String,
    /// Its name (slug).
    pub name: String,
    /// The default branch (`HEAD` points at it), when the config names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    /// Platform block height of the snapshot (a proof-verified response's metadata).
    pub platform_height: u64,
    /// Platform block time of the snapshot (ms): every ref update up to it is reflected.
    pub platform_time_ms: u64,
    /// When the mirror took the snapshot, by its own clock (ms since the Unix epoch).
    pub fetched_at_ms: u64,
    /// Every live ref the mirror serves.
    pub refs: Vec<RefTip>,
    /// The repository's git packs and how many recorded copies each has.
    #[serde(default)]
    pub packs: Vec<ManifestPack>,
}

/// One git pack of a [`Manifest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestPack {
    /// SHA-256 of the pack (hex).
    pub pack_hash: String,
    /// Recorded copies (one per uploader).
    pub copies: usize,
    /// Size (bytes).
    pub size_bytes: u64,
}

/// How one ref of a mirror compares with Platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// The mirror serves the proved tip.
    Match,
    /// The mirror is behind: it serves a tip the ref had (or lacks a ref) and the ref changed
    /// after its snapshot.
    Stale,
    /// The mirror serves something Platform never had for the ref, or omits what its snapshot
    /// should already show.
    Mismatch,
}

impl Verdict {
    /// `match` / `stale` / `MISMATCH`, as `dg verify-mirror` prints it.
    pub fn label(self) -> &'static str {
        match self {
            Verdict::Match => "match",
            Verdict::Stale => "stale",
            Verdict::Mismatch => "MISMATCH",
        }
    }
}

/// One ref's comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefCheck {
    /// The ref name.
    pub name: String,
    /// The tip the mirror serves (`None`: it does not serve the ref).
    pub served: Option<String>,
    /// The proved tip (`None`: no live ref on Platform).
    pub proved: Option<String>,
    /// The verdict.
    pub verdict: Verdict,
    /// Why, in a few words.
    pub why: String,
}

/// A mirror's refs compared with Platform's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    /// The worst verdict of any ref ([`Verdict::Match`] when there are none).
    pub verdict: Verdict,
    /// Every ref either side has, by name.
    pub refs: Vec<RefCheck>,
}

impl Comparison {
    /// How many refs got `verdict`.
    pub fn count(&self, verdict: Verdict) -> usize {
        self.refs.iter().filter(|r| r.verdict == verdict).count()
    }
}

/// Parse `git ls-remote` output (`<oid>\t<ref>` lines) into the refs a mirror serves: `HEAD`
/// and peeled tags (`^{}`) are left out, as Platform records neither.
pub fn parse_ls_remote(out: &str) -> BTreeMap<String, String> {
    out.lines()
        .filter_map(|l| l.split_once('\t'))
        .filter(|(_, name)| *name != "HEAD" && !name.ends_with("^{}"))
        .map(|(oid, name)| (name.trim().to_string(), oid.trim().to_ascii_lowercase()))
        .collect()
}

/// Compare the refs a mirror serves (`served`, name → oid) with the refs folded from Platform
/// (`records`). `as_of_ms` is the Platform block time the mirror says its snapshot reflects
/// ([`Manifest::platform_time_ms`]); without it (no manifest), a ref that is behind counts as
/// stale whenever its served tip is one the ref validly had.
pub fn compare(
    served: &BTreeMap<String, String>,
    records: &[RefRecord],
    as_of_ms: Option<u64>,
) -> Comparison {
    let by_name: BTreeMap<&str, &RefRecord> =
        records.iter().map(|r| (r.name.as_str(), r)).collect();
    let names: BTreeSet<&str> = served
        .keys()
        .map(String::as_str)
        .chain(
            records
                .iter()
                .filter(|r| r.tip.is_some())
                .map(|r| r.name.as_str()),
        )
        .collect();
    let moved_since = |r: &RefRecord| as_of_ms.is_none_or(|t| r.changed_at > t);
    let refs: Vec<RefCheck> = names
        .into_iter()
        .map(|name| {
            let served = served.get(name).cloned();
            let record = by_name.get(name).copied();
            let proved = record.and_then(|r| r.tip.as_ref()).map(|t| t.oid.clone());
            let (verdict, why) = match (&served, record) {
                (Some(s), Some(_)) if proved.as_deref() == Some(s.as_str()) => {
                    (Verdict::Match, "the proved tip".to_string())
                }
                (Some(s), Some(r)) if r.tips_ever.contains(s) && moved_since(r) => (
                    Verdict::Stale,
                    if proved.is_some() {
                        "an earlier tip; the ref moved after the mirror's snapshot"
                    } else {
                        "deleted on Platform after the mirror's snapshot"
                    }
                    .to_string(),
                ),
                (Some(s), Some(r)) if r.tips_ever.contains(s) => (
                    Verdict::Mismatch,
                    "an earlier tip, though the mirror's snapshot is newer than the change"
                        .to_string(),
                ),
                (Some(_), Some(_)) => (
                    Verdict::Mismatch,
                    "a tip no valid update of this ref ever set".to_string(),
                ),
                (Some(_), None) => (
                    Verdict::Mismatch,
                    "not a ref of this repository on Platform".to_string(),
                ),
                (None, Some(r)) if moved_since(r) => (
                    Verdict::Stale,
                    "not mirrored yet; the ref changed after the mirror's snapshot".to_string(),
                ),
                (None, _) => (
                    Verdict::Mismatch,
                    "omitted, though the mirror's snapshot is newer than the ref".to_string(),
                ),
            };
            RefCheck {
                name: name.to_string(),
                served,
                proved,
                verdict,
                why,
            }
        })
        .collect();
    let verdict = refs
        .iter()
        .map(|r| r.verdict)
        .max()
        .unwrap_or(Verdict::Match);
    Comparison { verdict, refs }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oid(c: char) -> String {
        std::iter::repeat_n(c, 40).collect()
    }

    fn record(name: &str, tip: Option<char>, ever: &[char], changed_at: u64) -> RefRecord {
        RefRecord {
            name: name.into(),
            tip: tip.map(|c| RefTip {
                name: name.into(),
                oid: oid(c),
                ref_update_id: "U".into(),
                document_type: "refUpdate".into(),
                created_at: changed_at,
                diverged: false,
            }),
            tips_ever: ever.iter().map(|c| oid(*c)).collect(),
            changed_at,
        }
    }

    fn served(pairs: &[(&str, char)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(n, c)| ((*n).into(), oid(*c))).collect()
    }

    #[test]
    fn ls_remote_drops_head_and_peeled_tags() {
        let out = format!(
            "{a}\tHEAD\n{a}\trefs/heads/main\n{b}\trefs/tags/v1\n{c}\trefs/tags/v1^{{}}\n",
            a = oid('a'),
            b = oid('b'),
            c = oid('c')
        );
        let refs = parse_ls_remote(&out);
        assert_eq!(refs.len(), 2);
        assert_eq!(refs["refs/heads/main"], oid('a'));
        assert_eq!(refs["refs/tags/v1"], oid('b'));
    }

    #[test]
    fn the_proved_tips_match() {
        let c = compare(
            &served(&[("refs/heads/main", 'a')]),
            &[record("refs/heads/main", Some('a'), &['a'], 10)],
            Some(20),
        );
        assert_eq!(c.verdict, Verdict::Match);
        assert_eq!(c.count(Verdict::Match), 1);
    }

    #[test]
    fn an_earlier_tip_is_stale_only_when_the_ref_moved_after_the_snapshot() {
        let records = [record("refs/heads/main", Some('b'), &['a', 'b'], 30)];
        let mirror = served(&[("refs/heads/main", 'a')]);
        assert_eq!(compare(&mirror, &records, Some(20)).verdict, Verdict::Stale);
        // No manifest: an earlier valid tip is stale.
        assert_eq!(compare(&mirror, &records, None).verdict, Verdict::Stale);
        // The snapshot claims to postdate the move: a lie.
        assert_eq!(
            compare(&mirror, &records, Some(40)).verdict,
            Verdict::Mismatch
        );
    }

    #[test]
    fn a_tip_the_ref_never_had_is_a_mismatch() {
        let c = compare(
            &served(&[("refs/heads/main", 'f')]),
            &[record("refs/heads/main", Some('b'), &['a', 'b'], 30)],
            None,
        );
        assert_eq!(c.verdict, Verdict::Mismatch);
        assert_eq!(c.refs[0].proved.as_deref(), Some(oid('b').as_str()));
    }

    #[test]
    fn invented_and_omitted_refs() {
        let records = [
            record("refs/heads/main", Some('a'), &['a'], 10),
            record("refs/heads/new", Some('n'), &['n'], 50),
        ];
        // An extra ref Platform does not have: mismatch.
        let c = compare(
            &served(&[
                ("refs/heads/main", 'a'),
                ("refs/heads/evil", 'e'),
                ("refs/heads/new", 'n'),
            ]),
            &records,
            Some(60),
        );
        assert_eq!(c.verdict, Verdict::Mismatch);
        assert_eq!(c.count(Verdict::Mismatch), 1);
        // A ref created after the snapshot is stale; one before it, omitted, is a mismatch.
        let mirror = served(&[("refs/heads/main", 'a')]);
        assert_eq!(compare(&mirror, &records, Some(20)).verdict, Verdict::Stale);
        assert_eq!(
            compare(&mirror, &records, Some(60)).verdict,
            Verdict::Mismatch
        );
    }

    #[test]
    fn a_ref_deleted_after_the_snapshot_is_stale() {
        let records = [record("refs/heads/gone", None, &['a'], 30)];
        let mirror = served(&[("refs/heads/gone", 'a')]);
        assert_eq!(compare(&mirror, &records, Some(20)).verdict, Verdict::Stale);
        assert_eq!(
            compare(&mirror, &records, Some(40)).verdict,
            Verdict::Mismatch
        );
        // Deleted and not served: nothing to compare.
        assert!(compare(&BTreeMap::new(), &records, Some(40))
            .refs
            .is_empty());
    }

    #[test]
    fn the_manifest_round_trips() {
        let m = Manifest {
            schema: MANIFEST_SCHEMA.into(),
            network: "devnet-sakura".into(),
            forge_core: "C".into(),
            repo_id: "R".into(),
            owner_id: "O".into(),
            name: "x".into(),
            default_branch: Some("main".into()),
            platform_height: 7,
            platform_time_ms: 8,
            fetched_at_ms: 9,
            refs: record("refs/heads/main", Some('a'), &['a'], 1)
                .tip
                .into_iter()
                .collect(),
            packs: vec![ManifestPack {
                pack_hash: "00".into(),
                copies: 2,
                size_bytes: 3,
            }],
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"refUpdateId\":\"U\""), "{json}");
        assert!(json.contains("\"platformHeight\":7"), "{json}");
        assert!(
            !json.contains("diverged"),
            "a resolved ref omits the flag: {json}"
        );
        assert_eq!(serde_json::from_str::<Manifest>(&json).unwrap(), m);
    }
}
