//! Which repository a client is talking to, and how its documents are addressed.
//!
//! A repository is a `repo` document in the network's shared forge-core contract, and every
//! other document of it (refs, config, packs, chunks, membership) lives in the same contract,
//! keyed by `repoId` (`docs/contracts/forge-v2.md` §2).
//!
//! [`RepoRef`] names one repository. [`DocScope`] turns it into the contract to query and the
//! filters/properties every query and write needs: each query gains `repoId == R` and each
//! write a `repoId` property.

use std::collections::BTreeMap;

use crate::error::Result;
use crate::network::ForgeIds;
use crate::platform::{self, FetchedDocument, FieldValue, QueryFilter};
use crate::rules::v2::Visibility;
use crate::user_error::{codes, UserError};

/// A resolved repository: a `repo` document in the network's forge-core contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    /// The forge-v2 contracts of the network the repo lives on.
    pub forge: ForgeIds,
    /// The base58 `repo` document id (`repoId` in every other document).
    pub repo_id: String,
    /// The base58 owner identity (`repo.$ownerId`).
    pub owner_id: String,
    /// The immutable URL slug (`repo.name`).
    pub name: String,
    /// `repo.visibility`.
    pub visibility: Visibility,
}

impl RepoRef {
    /// The owner identity (base58).
    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }

    /// The repository name (the slug).
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The `repo` document id that names this repository on chain; `dash://<id>` accepts it.
    pub fn id(&self) -> &str {
        &self.repo_id
    }

    /// The network's forge-v2 contracts this repository lives in.
    pub fn forge(&self) -> &ForgeIds {
        &self.forge
    }

    /// `owner/name`, the form users type.
    pub fn display(&self) -> String {
        format!("{}/{}", self.owner_id(), self.name())
    }

    /// The `dash://` remote URL for this repository.
    pub fn remote_url(&self) -> String {
        format!("dash://{}", self.display())
    }

    /// The document scope of this repository's git data plane (refs, config, packs).
    pub fn scope(&self) -> Result<DocScope> {
        Ok(DocScope {
            contract_id: self.forge.core.clone(),
            repo_id: platform::decode_identifier(&self.repo_id)?,
        })
    }

    /// Refuse `what` on a private repository (E207): the operations that do not handle one (a
    /// fork, whose copied refs and manifests would need the parent's keys; a release, whose
    /// notes and assets would be published unencrypted).
    pub fn require_public(&self, what: &str) -> Result<()> {
        match self.visibility {
            Visibility::Private => Err(UserError::new(
                codes::PRIVATE_UNSUPPORTED,
                format!(
                    "{} is a private repository; {what} is not supported for private repositories",
                    self.display()
                ),
            )
            .cause(format!("private repositories don't support {what} yet"))
            .fix("see docs/security/private-repos.md §7 for what a private repository supports")
            .into()),
            Visibility::Public => Ok(()),
        }
    }
}

/// Where a repository's git-data documents live, and how to address them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocScope {
    /// The contract holding the documents (the network's forge-core).
    pub contract_id: String,
    /// The repo: every query filters on it and every write carries it.
    pub repo_id: [u8; 32],
}

impl DocScope {
    /// `extra` with `repoId == R` prepended (it is the first property of every forge-v2
    /// index, so it must come first).
    pub fn filters(&self, extra: impl IntoIterator<Item = QueryFilter>) -> Vec<QueryFilter> {
        std::iter::once(QueryFilter::eq(
            "repoId",
            FieldValue::identifier(self.repo_id),
        ))
        .chain(extra)
        .collect()
    }

    /// Document properties with `repoId` added.
    pub fn props(
        &self,
        props: impl IntoIterator<Item = (&'static str, FieldValue)>,
    ) -> BTreeMap<String, FieldValue> {
        self.scoped(props.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    /// An already-built property map with `repoId` added.
    pub fn scoped(&self, mut props: BTreeMap<String, FieldValue>) -> BTreeMap<String, FieldValue> {
        props.insert("repoId".to_string(), FieldValue::identifier(self.repo_id));
        props
    }

    /// The filters that select one pack's chunks, in `seq` order.
    ///
    /// Chunks are keyed `(repoId, $ownerId, packHash, seq)`: each uploader has its own copy,
    /// so a chunk read names whose copy it reads (the manifest's `$ownerId`).
    pub fn chunk_filters(&self, owner: &str, pack_hash: [u8; 32]) -> Result<Vec<QueryFilter>> {
        Ok(self.filters([
            QueryFilter::eq(
                "$ownerId",
                FieldValue::identifier(platform::decode_identifier(owner)?),
            ),
            QueryFilter::eq("packHash", FieldValue::bytes32(pack_hash)),
        ]))
    }

    /// The `platform://` locator of a pack stored as this scope's chunks:
    /// `platform://<core>/<repoId>/<owner>/<packHash>` (the uploader is part of the chunk key).
    pub fn locator(&self, owner: &str, pack_hash_hex: &str) -> String {
        format!(
            "{}://{}/{}/{owner}/{pack_hash_hex}",
            crate::backends::PLATFORM_SCHEME,
            self.contract_id,
            platform::encode_identifier(self.repo_id)
        )
    }
}

/// A typed string-array field. Absent or unreadable is empty.
pub fn text_list(value: Option<&FieldValue>) -> Vec<String> {
    value.and_then(FieldValue::as_text_list).unwrap_or_default()
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

    fn repo() -> RepoRef {
        RepoRef {
            forge: ForgeIds {
                core: "CORE".into(),
                collab: "COLLAB".into(),
                group: "GROUP".into(),
                superseded_in_group: vec![],
                group_owner: None,
            },
            repo_id: REPO.into(),
            owner_id: OWNER.into(),
            name: "proj".into(),
            visibility: Visibility::Public,
        }
    }

    #[test]
    fn scope_filters_every_query_by_repo_id_first() {
        let scope = repo().scope().unwrap();
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
        // An unfiltered read is still scoped to the repo.
        assert_eq!(scope.filters([]).len(), 1);
    }

    #[test]
    fn writes_carry_the_repo_id() {
        let props = repo()
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
    fn chunk_reads_are_scoped_to_one_uploaders_copy() {
        let scope = repo().scope().unwrap();
        let f = scope.chunk_filters(OWNER, [7; 32]).unwrap();
        let fields: Vec<_> = f.iter().map(|f| f.field.as_str()).collect();
        assert_eq!(fields, ["repoId", "$ownerId", "packHash"]);
        assert!(scope.chunk_filters("not base58!", [7; 32]).is_err());
    }

    #[test]
    fn locators_name_the_uploader() {
        let h = "ab".repeat(32);
        assert_eq!(
            repo().scope().unwrap().locator(OWNER, &h),
            format!("platform://CORE/{REPO}/{OWNER}/{h}")
        );
    }

    #[test]
    fn public_only_operations_refuse_private_repos() {
        let mut r = repo();
        r.visibility = Visibility::Private;
        let err = r.require_public("forking").unwrap_err();
        assert!(
            matches!(&err, crate::error::Error::User(u) if u.code == codes::PRIVATE_UNSUPPORTED),
            "{err:?}"
        );
        assert!(repo().require_public("forking").is_ok());
    }

    #[test]
    fn text_lists_decode_typed_arrays() {
        assert_eq!(
            text_list(Some(&FieldValue::text_list(["a", "b"]))),
            vec!["a", "b"]
        );
        // An empty typed array comes back as empty bytes.
        assert!(text_list(Some(&FieldValue::bytes(Vec::new()))).is_empty());
        assert!(text_list(None).is_empty());
        assert!(text_list(Some(&FieldValue::text(r#"["a"]"#))).is_empty());
    }
}
