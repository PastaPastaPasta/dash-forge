//! The RC1 layout: which forge-v2 contract holds each document type, and the `vis` stamp.
//!
//! RC1 moved `event`, `authorEvent` and `milestone` (O-01) and `runner` (O-02) into
//! forge-community, and `repoKey` (O-03) into forge-collab (`docs/contracts/forge-v2.md`,
//! `forge-contracts/contracts/*.json`). Every Rust reader and writer resolves a type's contract
//! here instead of hard-coding one, so the map lives in exactly one place.
//!
//! The `vis` stamp (`"public"` / `"private"`) is required on maintainer, writer, refUpdate,
//! protectedRefUpdate, config, release, issue, patch, comment, review, checkRun and webhook;
//! `topic.vis` and `starBeat.vis` may only be `"public"`. Consensus proves the stamp against the
//! repo (or the member document), so it always equals the repository's `visibility`.

use std::collections::BTreeMap;

use crate::network::ForgeIds;
use crate::platform::FieldValue;
use crate::rules::v2::Visibility;

/// One of the three forge-v2 contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ForgeContract {
    /// forge-core: repos, members, consent, refs, config, packs, releases, labels, topics.
    Core,
    /// forge-collab: issues, patches, transitions, comments, reviews, repo keys.
    Collab,
    /// forge-community: events, milestones, runners, check runs, policies, webhooks and the
    /// social types.
    Community,
}

/// forge-core's document types (RC1).
pub const CORE_TYPES: [&str; 12] = [
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
];

/// forge-collab's document types (RC1; `repoKey` moved in from core).
pub const COLLAB_TYPES: [&str; 6] = [
    "issue",
    "patch",
    "transition",
    "comment",
    "review",
    "repoKey",
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

impl ForgeContract {
    /// The contract that holds `doc_type`, or `None` for a type RC1 does not define (such as
    /// the removed `manifestPart`).
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

    /// The contract's name in the deployment file (`forge-core`, …).
    pub fn name(self) -> &'static str {
        match self {
            Self::Core => "forge-core",
            Self::Collab => "forge-collab",
            Self::Community => "forge-community",
        }
    }

    /// This contract's base58 id on the network `forge` describes.
    pub fn id(self, forge: &ForgeIds) -> &str {
        match self {
            Self::Core => &forge.core,
            Self::Collab => &forge.collab,
            Self::Community => &forge.community,
        }
    }
}

impl ForgeIds {
    /// The base58 id of the contract that holds `doc_type`, or `None` for an unknown type.
    pub fn contract_id_of(&self, doc_type: &str) -> Option<&str> {
        ForgeContract::of(doc_type).map(|c| c.id(self))
    }
}

/// The `vis` property name.
pub const VIS: &str = "vis";

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
            };
            listed.sort_unstable();
            assert_eq!(types, listed, "{file}");
            for t in types {
                assert_eq!(ForgeContract::of(t), Some(want), "{t}");
            }
        }
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
