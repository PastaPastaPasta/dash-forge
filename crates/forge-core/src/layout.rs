//! The RC1 layout: which forge-v2 contract holds each document type, and the `vis` stamp.
//!
//! RC1 moved `event`, `authorEvent` and `milestone` (O-01) and `runner` (O-02) into
//! forge-community, and `repoKey` (O-03) into forge-collab (`docs/contracts/forge-v2.md`,
//! `forge-contracts/contracts/*.json`). Every Rust reader and writer resolves a type's contract
//! here instead of hard-coding one, so the map lives in exactly one place.
//!
//! DESIGN rev 4.1 D44 adds a fourth contract, forge-meta, registered last: `repoKey`, `ban`,
//! `label`, `topic`, `packMirror`, `profile` and `follow` ([`META_TYPES`]) move there, and
//! `vaultEntry` (UPDATE-2, the passkey vault), `board` and `card` (UPDATE-3, boards) exist there
//! only ([`META_ONLY_TYPES`]). The
//! deployment record says which layout a network has (`v2.forgeMeta` present,
//! [`ForgeIds::meta`]), so one build serves sakura's three-contract set and four-contract sets:
//! [`ForgeIds::contract_of`] is the layout-aware map, [`ForgeContract::of`] the three-contract
//! home.
//!
//! The `vis` stamp (`"public"` / `"private"`) is required on maintainer, writer, refUpdate,
//! protectedRefUpdate, config, release, issue, patch, comment, review, checkRun and webhook;
//! `topic.vis` and `starBeat.vis` may only be `"public"`. Consensus proves the stamp against the
//! repo (or the member document), so it always equals the repository's `visibility`.

use std::collections::BTreeMap;

use crate::network::ForgeIds;
use crate::platform::FieldValue;
use crate::rules::v2::Visibility;

/// One of the forge-v2 contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ForgeContract {
    /// forge-core: repos, members, consent, refs, config, packs, releases, labels, topics.
    Core,
    /// forge-collab: issues, patches, transitions, comments, reviews, repo keys.
    Collab,
    /// forge-community: events, milestones, runners, check runs, policies, webhooks and the
    /// social types.
    Community,
    /// forge-meta (D44), on a four-contract set only: [`META_TYPES`].
    Meta,
}

/// forge-core's document types (RC1; `packMirror` added by UPDATE-1).
pub const CORE_TYPES: [&str; 14] = [
    "repo",
    "maintainer",
    "writer",
    "consent",
    "refUpdate",
    "protectedRefUpdate",
    "config",
    "packManifest",
    "chunk",
    "release",
    "label",
    "topic",
    "packMirror",
    "pushGrant",
];

/// forge-collab's document types (RC1; `repoKey` moved in from core; `ban` added by UPDATE-1).
pub const COLLAB_TYPES: [&str; 7] = [
    "issue",
    "patch",
    "transition",
    "comment",
    "review",
    "repoKey",
    "ban",
];

/// forge-community's document types (RC1; `event`, `authorEvent`, `milestone` and `runner`
/// moved in).
pub const COMMUNITY_TYPES: [&str; 12] = [
    "event",
    "authorEvent",
    "milestone",
    "runner",
    "checkRun",
    "policy",
    "webhook",
    "profile",
    "star",
    "watch",
    "follow",
    "starBeat",
];

/// The types forge-meta holds on a four-contract set (D44). On a three-contract set they stay
/// in [`CORE_TYPES`] (`label`, `topic`, `packMirror`), [`COLLAB_TYPES`] (`repoKey`, `ban`) and
/// [`COMMUNITY_TYPES`] (`profile`, `follow`). None of them is read by a rule, total or derived
/// index of its old contract, so the move changes no consensus rule. [`META_ONLY_TYPES`] are the
/// exception: `build.py` builds them with the four-contract layout only, so they have no
/// three-contract home and [`ForgeContract::of`] knows no contract for them.
pub const META_TYPES: [&str; 10] = [
    "repoKey",
    "ban",
    "label",
    "topic",
    "packMirror",
    "profile",
    "follow",
    "vaultEntry",
    "board",
    "card",
];

/// The [`META_TYPES`] no three-contract set has: `vaultEntry` (UPDATE-2, the passkey vault) and
/// `board` and `card` (UPDATE-3, `docs/design/boards.md` §3). On a network without forge-meta
/// [`ForgeIds::contract_of`] answers `None` for them.
pub const META_ONLY_TYPES: [&str; 3] = ["vaultEntry", "board", "card"];

/// The listed types a contract build may leave out: RC2's fused star (C1, a `build.py` flag)
/// drops `starBeat`, whose count the star's own `byWeek` index takes over. Clients read the
/// shape from the loaded contract (`Collab::fused_star`), so both builds work. `packMirror` and
/// `ban` arrive with UPDATE-1 (an in-place update, roadmap D4): a contract still at its first
/// version, or one built with those flags off, has neither. `pushGrant` is B1's (the mainnet
/// set only, D42).
pub const OPTIONAL_TYPES: [&str; 4] = ["starBeat", "packMirror", "ban", "pushGrant"];

impl ForgeContract {
    /// The contract that holds `doc_type` on a three-contract set, or `None` for a type RC1
    /// does not define (such as the removed `manifestPart`). Readers and writers resolve through
    /// [`ForgeIds::contract_of`], which knows whether the network has forge-meta.
    pub fn of(doc_type: &str) -> Option<Self> {
        if CORE_TYPES.contains(&doc_type) {
            Some(Self::Core)
        } else if COLLAB_TYPES.contains(&doc_type) {
            Some(Self::Collab)
        } else if COMMUNITY_TYPES.contains(&doc_type) {
            Some(Self::Community)
        } else {
            None
        }
    }

    /// [`Self::of`] on a network with (`has_meta`) or without forge-meta: [`META_TYPES`] are
    /// forge-meta's on a four-contract set (D44).
    pub fn in_layout(doc_type: &str, has_meta: bool) -> Option<Self> {
        if has_meta && META_TYPES.contains(&doc_type) {
            Some(Self::Meta)
        } else {
            Self::of(doc_type)
        }
    }

    /// The contract's name in the deployment file (`forge-core`, …).
    pub fn name(self) -> &'static str {
        match self {
            Self::Core => "forge-core",
            Self::Collab => "forge-collab",
            Self::Community => "forge-community",
            Self::Meta => "forge-meta",
        }
    }

    /// This contract's base58 id on the network `forge` describes; `None` for forge-meta on a
    /// three-contract set.
    pub fn id(self, forge: &ForgeIds) -> Option<&str> {
        match self {
            Self::Core => Some(&forge.core),
            Self::Collab => Some(&forge.collab),
            Self::Community => Some(&forge.community),
            Self::Meta => forge.meta.as_deref(),
        }
    }
}

impl ForgeIds {
    /// The contract that holds `doc_type` on this network: forge-meta for [`META_TYPES`] when
    /// the deployment has it (D44), else the three-contract home ([`ForgeContract::of`]).
    /// `None` for a type no forge-v2 contract defines.
    pub fn contract_of(&self, doc_type: &str) -> Option<ForgeContract> {
        ForgeContract::in_layout(doc_type, self.meta.is_some())
    }

    /// The base58 id of the contract that holds `doc_type`, or `None` for an unknown type.
    pub fn contract_id_of(&self, doc_type: &str) -> Option<&str> {
        self.contract_of(doc_type).and_then(|c| c.id(self))
    }

    /// The base58 id of the contract that holds `doc_type`, a type the caller names by its
    /// constant (`DOC_LABEL`, …). Panics on a type no forge-v2 contract defines: that is a
    /// programming error, which the layout tests catch.
    pub fn home(&self, doc_type: &str) -> &str {
        self.contract_id_of(doc_type)
            .unwrap_or_else(|| panic!("no forge-v2 contract holds {doc_type}"))
    }
}

/// The `vis` property name.
pub const VIS: &str = "vis";

/// The types whose `vis` is required and equals the repository's visibility.
pub const VIS_TYPES: [&str; 12] = [
    "maintainer",
    "writer",
    "refUpdate",
    "protectedRefUpdate",
    "config",
    "release",
    "issue",
    "patch",
    "comment",
    "review",
    "checkRun",
    "webhook",
];

/// The types whose `vis` may only be `"public"`.
pub const PUBLIC_VIS_TYPES: [&str; 2] = ["topic", "starBeat"];

/// The types that carry `asMember` (the signer, proving a maintainer or writer document).
pub const MEMBER_PROOF_TYPES: [&str; 4] = ["issue", "patch", "comment", "review"];

/// The `asMember` property name.
pub const AS_MEMBER: &str = "asMember";

impl Visibility {
    /// The wire form: `"public"` or `"private"` (`repo.visibility` and every `vis` stamp).
    pub fn as_str(self) -> &'static str {
        match self {
            Visibility::Public => "public",
            Visibility::Private => "private",
        }
    }
}

/// The `vis` stamp for a repository of `visibility`.
pub fn vis(visibility: Visibility) -> FieldValue {
    FieldValue::text(visibility.as_str())
}

/// Stamp `props` with `vis` = the repository's `visibility`.
pub fn stamp_vis(props: &mut BTreeMap<String, FieldValue>, visibility: Visibility) {
    props.insert(VIS.to_string(), vis(visibility));
}

/// Stamp `props` with `vis: "public"`: the only value `topic` and `starBeat` accept.
pub fn stamp_public(props: &mut BTreeMap<String, FieldValue>) {
    stamp_vis(props, Visibility::Public);
}

/// Stamp a new `doc_type` document of a repository of `visibility` with the `vis` its type
/// takes, if any: the repository's for [`VIS_TYPES`], `"public"` for [`PUBLIC_VIS_TYPES`].
pub fn stamp_vis_for(
    doc_type: &str,
    props: &mut BTreeMap<String, FieldValue>,
    visibility: Visibility,
) {
    if VIS_TYPES.contains(&doc_type) {
        stamp_vis(props, visibility);
    } else if PUBLIC_VIS_TYPES.contains(&doc_type) {
        stamp_public(props);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The map agrees with the generated RC1 contracts, type for type.
    #[test]
    fn the_map_matches_the_generated_contracts() {
        let root = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../forge-contracts/contracts"
        );
        for (file, want) in [
            ("forge-core.json", ForgeContract::Core),
            ("forge-collab.json", ForgeContract::Collab),
            ("forge-community.json", ForgeContract::Community),
        ] {
            let text = std::fs::read_to_string(format!("{root}/{file}")).unwrap();
            let json: serde_json::Value = serde_json::from_str(&text).unwrap();
            let schemas = json.get("documentSchemas").unwrap_or(&json);
            let mut types: Vec<&str> = schemas
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            types.sort_unstable();
            let mut listed: Vec<&str> = match want {
                ForgeContract::Core => CORE_TYPES.to_vec(),
                ForgeContract::Collab => COLLAB_TYPES.to_vec(),
                ForgeContract::Community => COMMUNITY_TYPES.to_vec(),
                ForgeContract::Meta => unreachable!("the committed set has three contracts"),
            };
            listed.sort_unstable();
            // A type a build flag left out is listed all the same (both shapes are read).
            listed.retain(|t| types.contains(t) || !OPTIONAL_TYPES.contains(t));
            assert_eq!(types, listed, "{file}");
            for t in types {
                assert_eq!(ForgeContract::of(t), Some(want), "{t}");
            }
        }
    }

    /// The stamp lists agree with the contracts: `vis` required (or public-only), `asMember`
    /// a property.
    #[test]
    fn the_stamp_lists_match_the_generated_contracts() {
        let root = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../forge-contracts/contracts"
        );
        let (mut vis, mut public, mut member) = (Vec::new(), Vec::new(), Vec::new());
        for file in [
            "forge-core.json",
            "forge-collab.json",
            "forge-community.json",
        ] {
            let text = std::fs::read_to_string(format!("{root}/{file}")).unwrap();
            let json: serde_json::Value = serde_json::from_str(&text).unwrap();
            let defs = &json["schemaDefs"];
            for (t, schema) in json["documentSchemas"].as_object().unwrap() {
                let props = &schema["properties"];
                if props.get(AS_MEMBER).is_some() {
                    member.push(t.clone());
                }
                let Some(v) = props.get(VIS) else { continue };
                let v = match v["$ref"].as_str() {
                    Some(r) => &defs[r.trim_start_matches("#/$defs/")],
                    None => v,
                };
                let values = v["enum"].as_array().unwrap();
                if values.len() == 1 {
                    assert_eq!(values[0], "public", "{t}");
                    public.push(t.clone());
                } else {
                    let required = schema["required"].as_array().unwrap();
                    assert!(required.iter().any(|r| r == VIS), "{t} requires vis");
                    vis.push(t.clone());
                }
            }
        }
        for (got, want) in [
            (&mut vis, VIS_TYPES.to_vec()),
            (&mut public, PUBLIC_VIS_TYPES.to_vec()),
            (&mut member, MEMBER_PROOF_TYPES.to_vec()),
        ] {
            let mut want: Vec<String> = want
                .into_iter()
                .filter(|t| !OPTIONAL_TYPES.contains(t) || got.iter().any(|g| g == t))
                .map(str::to_owned)
                .collect();
            got.sort();
            want.sort();
            assert_eq!(*got, want);
        }
    }

    /// The four-contract map (D44) agrees with `build.py --on layout_meta` (the layout alone;
    /// `--mainnet` adds types such as B1's `pushGrant` that clients learn later), type for
    /// type: forge-meta holds [`META_TYPES`] and the other three keep the rest.
    #[test]
    fn the_four_contract_map_matches_the_layout_build() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../forge-contracts");
        let dir = tempfile::tempdir().expect("temp dir");
        let out = std::process::Command::new("python3")
            .arg(format!("{root}/schema/build.py"))
            .args(["--on", "layout_meta", "--out"])
            .arg(dir.path())
            .output()
            .expect("python3 runs build.py");
        assert!(
            out.status.success(),
            "build.py --on layout_meta: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let forge = ForgeIds::test_forge_meta();
        let mut seen = 0;
        for (file, want) in [
            ("forge-core.json", ForgeContract::Core),
            ("forge-collab.json", ForgeContract::Collab),
            ("forge-community.json", ForgeContract::Community),
            ("forge-meta.json", ForgeContract::Meta),
        ] {
            let text = std::fs::read_to_string(dir.path().join(file)).expect(file);
            let json: serde_json::Value = serde_json::from_str(&text).unwrap();
            for t in json["documentSchemas"].as_object().unwrap().keys() {
                assert_eq!(forge.contract_of(t), Some(want), "{file}: {t}");
                seen += 1;
            }
        }
        assert_eq!(forge.all().last(), Some(&("forge-meta", "META")));
        assert!(seen > META_TYPES.len());
    }

    /// The committed four-contract set (`contracts/mainnet/`, what testnet and mainnet register)
    /// agrees with the client map type for type: every type maps to the file that holds it, and
    /// forge-meta holds exactly [`META_TYPES`].
    #[test]
    fn the_four_contract_map_matches_the_mainnet_set() {
        let dir = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../forge-contracts/contracts/mainnet"
        ));
        let forge = ForgeIds::test_forge_meta();
        let mut meta_types = Vec::new();
        for (file, want) in [
            ("forge-core.json", ForgeContract::Core),
            ("forge-collab.json", ForgeContract::Collab),
            ("forge-community.json", ForgeContract::Community),
            ("forge-meta.json", ForgeContract::Meta),
        ] {
            let text = std::fs::read_to_string(dir.join(file)).expect(file);
            let json: serde_json::Value = serde_json::from_str(&text).unwrap();
            for t in json["documentSchemas"].as_object().unwrap().keys() {
                assert_eq!(forge.contract_of(t), Some(want), "{file}: {t}");
                if want == ForgeContract::Meta {
                    meta_types.push(t.clone());
                }
            }
        }
        meta_types.sort();
        let mut want: Vec<String> = META_TYPES.iter().map(|t| (*t).to_owned()).collect();
        want.sort();
        assert_eq!(meta_types, want);
    }

    #[test]
    fn the_layout_follows_the_deployment_record() {
        let three = ForgeIds::test_forge();
        let four = ForgeIds::test_forge_meta();
        for t in META_TYPES {
            assert_eq!(four.contract_id_of(t), Some("META"), "{t}");
            assert_eq!(four.home(t), "META", "{t}");
            assert_ne!(three.contract_id_of(t), Some("META"), "{t}");
            // (vaultEntry, board and card are four-contract types: no home in the three-contract set)
            assert_eq!(
                three.contract_id_of(t).is_some(),
                !META_ONLY_TYPES.contains(&t),
                "{t}"
            );
        }
        for t in META_ONLY_TYPES {
            assert!(META_TYPES.contains(&t), "{t}");
            assert_eq!(ForgeContract::of(t), None, "{t}");
            assert_eq!(three.contract_of(t), None, "{t}");
            assert_eq!(four.contract_of(t), Some(ForgeContract::Meta), "{t}");
        }
        for (t, old) in [
            ("repoKey", "COLLAB"),
            ("ban", "COLLAB"),
            ("label", "CORE"),
            ("topic", "CORE"),
            ("packMirror", "CORE"),
            ("profile", "COMMUNITY"),
            ("follow", "COMMUNITY"),
        ] {
            assert_eq!(three.home(t), old, "{t}");
        }
        // The other types do not move.
        for t in [
            "repo", "issue", "comment", "star", "watch", "event", "runner",
        ] {
            assert_eq!(three.contract_id_of(t), four.contract_id_of(t), "{t}");
        }
        assert_eq!(ForgeContract::Meta.id(&three), None);
        assert_eq!(four.contract_id_of("manifestPart"), None);
    }

    #[test]
    fn moved_types_resolve_to_their_rc1_contract() {
        let forge = ForgeIds::test_forge();
        for t in ["event", "authorEvent", "milestone", "runner"] {
            assert_eq!(forge.contract_id_of(t), Some("COMMUNITY"), "{t}");
        }
        assert_eq!(forge.contract_id_of("repoKey"), Some("COLLAB"));
        assert_eq!(forge.contract_id_of("consent"), Some("CORE"));
        assert_eq!(forge.contract_id_of("manifestPart"), None);
    }

    #[test]
    fn vis_stamps_the_wire_form() {
        let mut p = BTreeMap::new();
        stamp_vis(&mut p, Visibility::Private);
        assert_eq!(p.get(VIS), Some(&FieldValue::text("private")));
        stamp_public(&mut p);
        assert_eq!(p.get(VIS), Some(&FieldValue::text("public")));
    }
}
