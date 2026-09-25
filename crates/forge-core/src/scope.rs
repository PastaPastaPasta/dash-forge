//! Which repository a client is talking to, and how its documents are addressed.
//!
//! Two generations of repository exist side by side:
//!
//! * **forge-v2** (protocol 14): a repository is a `repo` document in the network's shared
//!   forge-core contract, and every other document of it (refs, config, packs, chunks,
//!   membership) lives in the same contract, keyed by `repoId`. This is where writes go.
//! * **forge-v1**: one data contract per repository, found through the registry. **Read
//!   only**: existing v1 repositories stay cloneable, but nothing writes to them any more.
//!
//! [`RepoRef`] names one repository of either kind. [`DocScope`] turns it into the contract
//! to query and the filters/properties every query and write needs: on v2 each query gains
//! `repoId == R` and each write a `repoId` property; on v1 the contract itself is the scope.
//! The field codec here ([`text_list`], [`chunk_scope`], ...) absorbs the remaining schema
//! differences so the transport code is written once.

use std::collections::BTreeMap;

use crate::error::{Error, Result};
use crate::network::ForgeIds;
use crate::platform::{self, FetchedDocument, FieldValue, QueryFilter};
use crate::rules::v2::Visibility;

/// A resolved repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepoRef {
    /// A forge-v2 repository: a `repo` document in the network's forge-core contract.
    V2 {
        /// The forge-v2 contracts of the network the repo lives on.
        forge: ForgeIds,
        /// The base58 `repo` document id (`repoId` in every other document).
        repo_id: String,
        /// The base58 owner identity (`repo.$ownerId`).
        owner_id: String,
        /// The immutable URL slug (`repo.name`).
        name: String,
        /// `repo.visibility`.
        visibility: Visibility,
    },
    /// A forge-v1 repository: its own data contract. Read only.
    V1 {
        /// The base58 repo contract id.
        contract_id: String,
        /// The base58 owner identity (the contract owner).
        owner_id: String,
        /// The registry name, or the contract id when it was addressed by id.
        name: String,
    },
}

impl RepoRef {
    /// The owner identity (base58).
    pub fn owner_id(&self) -> &str {
        match self {
            RepoRef::V2 { owner_id, .. } | RepoRef::V1 { owner_id, .. } => owner_id,
        }
    }

    /// The repository name (the v2 slug, the v1 registry name).
    pub fn name(&self) -> &str {
        match self {
            RepoRef::V2 { name, .. } | RepoRef::V1 { name, .. } => name,
        }
    }

    /// The id that names this repository on chain: the `repo` document id (v2) or the
    /// repo contract id (v1). Either form is accepted by `dash://<id>`.
    pub fn id(&self) -> &str {
        match self {
            RepoRef::V2 { repo_id, .. } => repo_id,
            RepoRef::V1 { contract_id, .. } => contract_id,
        }
    }

    /// `v2` or `v1`, for display and `--json`.
    pub fn generation(&self) -> &'static str {
        match self {
            RepoRef::V2 { .. } => "v2",
            RepoRef::V1 { .. } => "v1",
        }
    }

    /// Whether this is a (read-only) forge-v1 repository.
    pub fn is_v1(&self) -> bool {
        matches!(self, RepoRef::V1 { .. })
    }

    /// `owner/name`, the form users type.
    pub fn display(&self) -> String {
        format!("{}/{}", self.owner_id(), self.name())
    }

    /// The `dash://` remote URL for this repository.
    pub fn remote_url(&self) -> String {
        format!("dash://{}", self.display())
    }

    /// The forge-v2 contracts, or [`Error::V1ReadOnly`] for a v1 repository. Every write
    /// path starts here, so a v1 repository refuses writes before anything is signed.
    pub fn require_v2(&self) -> Result<&ForgeIds> {
        match self {
            RepoRef::V2 { forge, .. } => Ok(forge),
            RepoRef::V1 { .. } => Err(Error::V1ReadOnly {
                repo: self.display(),
            }),
        }
    }

    /// The v1 repo contract id, for the services that still address a repository by its
    /// contract (issues, PRs, releases, labels: forge-collab lands in a later release).
    pub fn v1_contract_id(&self) -> Result<&str> {
        match self {
            RepoRef::V1 { contract_id, .. } => Ok(contract_id),
            RepoRef::V2 { .. } => Err(Error::Config(format!(
                "{} is a forge-v2 repo; issues, pull requests, releases and labels on forge-v2 \
                 are not supported by this version of the CLI yet",
                self.display()
            ))),
        }
    }

    /// The document scope of this repository's git data plane (refs, config, packs).
    pub fn scope(&self) -> Result<DocScope> {
        Ok(match self {
            RepoRef::V2 { forge, repo_id, .. } => DocScope {
                contract_id: forge.core.clone(),
                repo_id: Some(platform::decode_identifier(repo_id)?),
            },
            RepoRef::V1 { contract_id, .. } => DocScope {
                contract_id: contract_id.clone(),
                repo_id: None,
            },
        })
    }

    /// Refuse to operate on a repository this client cannot read correctly yet.
    pub fn require_readable(&self) -> Result<()> {
        match self {
            RepoRef::V2 {
                visibility: Visibility::Private,
                ..
            } => Err(Error::Config(format!(
                "{} is a private repository; private repositories are not supported by this \
                 version of the CLI yet",
                self.display()
            ))),
            _ => Ok(()),
        }
    }
}

/// Where a repository's git-data documents live, and how to address them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocScope {
    /// The contract holding the documents: forge-core (v2) or the repo contract (v1).
    pub contract_id: String,
    /// `Some(repoId)` on v2: every query filters on it and every write carries it.
    pub repo_id: Option<[u8; 32]>,
}

impl DocScope {
    /// Whether this is a forge-v2 scope.
    pub fn is_v2(&self) -> bool {
        self.repo_id.is_some()
    }

    /// `extra` with `repoId == R` prepended on v2 (it is the first property of every
    /// forge-v2 index, so it must come first).
    pub fn filters(&self, extra: impl IntoIterator<Item = QueryFilter>) -> Vec<QueryFilter> {
        self.repo_id
            .map(|id| QueryFilter::eq("repoId", FieldValue::identifier(id)))
            .into_iter()
            .chain(extra)
            .collect()
    }

    /// Document properties with `repoId` added on v2.
    pub fn props(
        &self,
        props: impl IntoIterator<Item = (&'static str, FieldValue)>,
    ) -> BTreeMap<String, FieldValue> {
        self.scoped(props.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    /// An already-built property map with `repoId` added on v2.
    pub fn scoped(&self, mut props: BTreeMap<String, FieldValue>) -> BTreeMap<String, FieldValue> {
        if let Some(id) = self.repo_id {
            props.insert("repoId".to_string(), FieldValue::identifier(id));
        }
        props
    }

    /// The filters that select one pack's chunks, in `seq` order.
    ///
    /// v2 chunks are keyed `(repoId, $ownerId, packHash, seq)`: each uploader has its own
    /// copy, so a chunk read names whose copy it reads (the manifest's `$ownerId`). v1
    /// chunks are keyed `(packHash, seq)` inside the repo contract.
    pub fn chunk_filters(
        &self,
        owner: Option<&str>,
        pack_hash: [u8; 32],
    ) -> Result<Vec<QueryFilter>> {
        let owner = match (self.is_v2(), owner) {
            (false, _) => None,
            (true, Some(o)) => Some(QueryFilter::eq(
                "$ownerId",
                FieldValue::identifier(platform::decode_identifier(o)?),
            )),
            (true, None) => {
                return Err(Error::Config(
                    "a forge-v2 chunk read must name the uploader whose copy it reads".into(),
                ))
            }
        };
        Ok(self.filters(
            owner
                .into_iter()
                .chain([QueryFilter::eq("packHash", FieldValue::bytes32(pack_hash))]),
        ))
    }

    /// The `platform://` locator of a pack stored as this scope's chunks:
    /// `platform://<core>/<repoId>/<owner>/<packHash>` on v2 (the uploader is part of the
    /// chunk key), `platform://<contract>/<packHash>` on v1.
    pub fn locator(&self, owner: &str, pack_hash_hex: &str) -> String {
        let scheme = crate::backends::PLATFORM_SCHEME;
        match self.repo_id {
            Some(id) => format!(
                "{scheme}://{}/{}/{owner}/{pack_hash_hex}",
                self.contract_id,
                platform::encode_identifier(id)
            ),
            None => format!("{scheme}://{}/{pack_hash_hex}", self.contract_id),
        }
    }
}

/// A string-list field, in either generation's encoding: a typed string array (v2) or a
/// JSON-encoded string (v1: `protectedPatterns`, `uris`, `backend.uris`). Absent or
/// unreadable is empty.
pub fn text_list(value: Option<&FieldValue>) -> Vec<String> {
    match value {
        Some(FieldValue::Text(json)) => serde_json::from_str(json).unwrap_or_default(),
        Some(v) => v.as_text_list().unwrap_or_default(),
        None => Vec::new(),
    }
}

/// [`text_list`] of a document's top-level field.
pub fn doc_text_list(doc: &FetchedDocument, field: &str) -> Vec<String> {
    text_list(doc.fields.get(field))
}

/// The `config.backend.uris` list of a `config` document.
pub fn backend_uris(doc: &FetchedDocument) -> Vec<String> {
    match doc.fields.get("backend") {
        Some(FieldValue::Object(backend)) => text_list(backend.get("uris")),
        _ => Vec::new(),
    }
}

/// The `repo.visibility` string as a [`Visibility`]; anything but `private` is public.
pub fn visibility_of(doc: &FetchedDocument) -> Visibility {
    match doc.field_str("visibility").as_deref() {
        Some("private") => Visibility::Private,
        _ => Visibility::Public,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::QueryOp;

    const REPO: &str = "GdZYaEntYPiW9dvUGCHyeqN7H7qEocbSkuj81n341i3L";
    const OWNER: &str = "9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD";

    fn forge() -> ForgeIds {
        ForgeIds {
            core: "CORE".into(),
            collab: "COLLAB".into(),
            group: "GROUP".into(),
        }
    }

    fn v2() -> RepoRef {
        RepoRef::V2 {
            forge: forge(),
            repo_id: REPO.into(),
            owner_id: OWNER.into(),
            name: "proj".into(),
            visibility: Visibility::Public,
        }
    }

    fn v1() -> RepoRef {
        RepoRef::V1 {
            contract_id: REPO.into(),
            owner_id: OWNER.into(),
            name: "proj".into(),
        }
    }

    #[test]
    fn v2_scope_filters_every_query_by_repo_id_first() {
        let scope = v2().scope().unwrap();
        assert_eq!(scope.contract_id, "CORE");
        let f = scope.filters([QueryFilter::eq("packHash", FieldValue::bytes32([1; 32]))]);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].field, "repoId");
        assert_eq!(f[0].op, QueryOp::Eq);
        assert_eq!(
            f[0].value,
            FieldValue::identifier(platform::decode_identifier(REPO).unwrap())
        );
        assert_eq!(f[1].field, "packHash");
        // An unfiltered v2 read is still scoped to the repo.
        assert_eq!(scope.filters([]).len(), 1);
    }

    #[test]
    fn v1_scope_is_the_repo_contract_with_no_extra_filter() {
        let scope = v1().scope().unwrap();
        assert_eq!(scope.contract_id, REPO);
        assert!(scope.filters([]).is_empty());
        assert!(!scope.props([]).contains_key("repoId"));
    }

    #[test]
    fn v2_writes_carry_the_repo_id() {
        let props = v2()
            .scope()
            .unwrap()
            .props([("refName", FieldValue::text("refs/heads/main"))]);
        assert!(matches!(
            props.get("repoId"),
            Some(FieldValue::Identifier(_))
        ));
        assert_eq!(props.len(), 2);
    }

    #[test]
    fn v2_chunk_reads_are_scoped_to_one_uploaders_copy() {
        let scope = v2().scope().unwrap();
        let f = scope.chunk_filters(Some(OWNER), [7; 32]).unwrap();
        let fields: Vec<_> = f.iter().map(|f| f.field.as_str()).collect();
        assert_eq!(fields, ["repoId", "$ownerId", "packHash"]);
        assert!(scope.chunk_filters(None, [7; 32]).is_err());
        // v1: the pack hash alone.
        let f = v1().scope().unwrap().chunk_filters(None, [7; 32]).unwrap();
        assert_eq!(f.len(), 1);
    }

    #[test]
    fn locators_name_the_uploader_on_v2() {
        let h = "ab".repeat(32);
        assert_eq!(
            v2().scope().unwrap().locator(OWNER, &h),
            format!("platform://CORE/{REPO}/{OWNER}/{h}")
        );
        assert_eq!(
            v1().scope().unwrap().locator(OWNER, &h),
            format!("platform://{REPO}/{h}")
        );
    }

    #[test]
    fn v1_refuses_writes_and_v2_refuses_v1_only_services() {
        let err = v1().require_v2().unwrap_err().to_string();
        assert!(err.contains("v1 repo (read-only)"), "{err}");
        assert!(err.contains("dg migrate"), "{err}");
        assert!(v2().require_v2().is_ok());
        assert!(v2().v1_contract_id().is_err());
        assert_eq!(v1().v1_contract_id().unwrap(), REPO);
    }

    #[test]
    fn private_v2_repos_are_refused_until_supported() {
        let mut r = v2();
        if let RepoRef::V2 { visibility, .. } = &mut r {
            *visibility = Visibility::Private;
        }
        assert!(r.require_readable().is_err());
        assert!(v2().require_readable().is_ok());
    }

    #[test]
    fn text_lists_decode_both_generations() {
        assert_eq!(
            text_list(Some(&FieldValue::text(r#"["a","b"]"#))),
            vec!["a", "b"]
        );
        assert_eq!(
            text_list(Some(&FieldValue::text_list(["a", "b"]))),
            vec!["a", "b"]
        );
        // An empty typed array comes back as empty bytes.
        assert!(text_list(Some(&FieldValue::bytes(Vec::new()))).is_empty());
        assert!(text_list(None).is_empty());
        assert!(text_list(Some(&FieldValue::text("not json"))).is_empty());
    }
}
