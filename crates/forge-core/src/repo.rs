//! [`RepoService`] — the repo-lifecycle API `git-remote-dash` calls.
//!
//! This is the orchestration layer that turns the [`crate::platform`] SDK primitives
//! (contract create, document create/delete, document query) and the pure
//! [`crate::rules`] resolver into the operations a git remote helper needs:
//!
//! - [`RepoService::create_repo`] — instantiate a repo-v1 contract (2 tokens + 15 doc
//!   types, `baseSupply` auto-crediting the owner WRITE+MAINTAIN), write the initial
//!   `config`, and publish the `repoListing` into the global registry. Returns the
//!   measured DataContractCreate cost (the repo-v1 instantiation number).
//! - [`RepoService::resolve_repo`] — registry lookup `(ownerId, normalizedName)` →
//!   repo contract id.
//! - [`RepoService::write_ref_update`] / [`RepoService::read_refs`] — append a WRITE- (or
//!   MAINTAIN-, for protected refs) gated ref update, and fold a repo's ref history into
//!   resolved [`RefState`]s via [`crate::rules::resolve_ref`].
//! - [`RepoService::write_pack_manifest`] / [`RepoService::read_pack_manifests`] and the
//!   chunk put/get, delegating pack-byte storage to [`crate::backends::PlatformBackend`].
//!
//! Everything SDK-shaped is reached through [`crate::platform`]; this module names no
//! rs-sdk / rs-dpp type (style guide §B).

use std::collections::{BTreeMap, BTreeSet};

use crate::backends::{ByteRange, PackBackend, PackMeta, PlatformBackend, Uri};
use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::platform::{
    self, FieldValue, LoadedContract, LoadedIdentity, PlatformClient, QueryFilter, QueryOrder,
    WriteEngine,
};
use crate::rules::{self, ConfigDoc, RefState, RefUpdate};

/// The repo-v1 contract template (2 tokens + 15 doc types), embedded at build time.
///
/// The template's `id` / `ownerId` are placeholders — [`PlatformClient::contract_create`]
/// derives the real id from the owner + nonce and stamps the real `ownerId`. Its token
/// admin rules target an org control group; [`apply_solo_owner_token_rules`] rewrites them
/// to `ContractOwner` for the solo-owner instantiation (see there for why).
const REPO_V1_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../forge-contracts/templates/repo-v1.json"
));

/// The deployed testnet registry contract id
/// (`forge-contracts/deployments/testnet.json`). The `repoListing` discovery docs live
/// here; resolution and publish target it.
pub const TESTNET_REGISTRY_CONTRACT_ID: &str = "5fu48xTUVDj2QtBTY6pPH9w2t73YHb1fxf1WMg6Rt9pd";

// Document type names (repo contract).
const DOC_CONFIG: &str = "config";
const DOC_REF_UPDATE: &str = "refUpdate";
const DOC_PROTECTED_REF_UPDATE: &str = "protectedRefUpdate";
const DOC_PACK_MANIFEST: &str = "packManifest";
const DOC_CHUNK: &str = "chunk";
// Document type name (registry contract).
const DOC_REPO_LISTING: &str = "repoListing";

/// Options for [`RepoService::create_repo`].
#[derive(Debug, Clone)]
pub struct CreateRepoOpts {
    /// The default branch recorded in `config` (e.g. `main`).
    pub default_branch: String,
    /// The writer-side backend mode (`0` platform, `1` ipfs, `2` s3, `3` https, `4`
    /// mixed) recorded in `config.backend.mode`.
    pub backend_mode: u8,
    /// The listing description (registry `repoListing.description`, ≤ 500 chars).
    pub description: String,
    /// The template version stamped into the listing (migration tracking).
    pub template_version: u32,
}

impl Default for CreateRepoOpts {
    fn default() -> Self {
        Self {
            default_branch: "main".to_string(),
            backend_mode: 0,
            description: String::new(),
            template_version: 1,
        }
    }
}

/// A handle to an instantiated repository.
#[derive(Debug, Clone)]
pub struct RepoHandle {
    /// Base58 id of the per-repo data contract.
    pub repo_contract_id: String,
    /// Base58 id of the repo owner identity.
    pub owner_id: String,
    /// The display name.
    pub name: String,
    /// The normalized (lowercased, validated) name used for resolution.
    pub normalized_name: String,
}

/// The result of [`RepoService::create_repo`], carrying the measured instantiation cost.
#[derive(Debug, Clone)]
pub struct CreateRepoResult {
    /// The repo handle.
    pub handle: RepoHandle,
    /// The measured DataContractCreate cost, in credits (÷ 1e11 = DASH). **This is the
    /// repo-v1 instantiation cost** the economics docs reconcile against.
    pub repo_v1_instantiation_cost_credits: u64,
    /// The registry `repoListing` document id (needed to delete the listing on repo
    /// teardown — the contract itself is permanent).
    pub listing_document_id: String,
}

/// Input for [`RepoService::write_pack_manifest`].
#[derive(Debug, Clone)]
pub struct PackManifestInput {
    /// SHA-256 of the pack (the `packHash` unique key).
    pub pack_hash: [u8; 32],
    /// Artifact kind (`0` git pack, `1` objectLocator, `2` flatIndex).
    pub kind: u64,
    /// Pack size in bytes.
    pub size_bytes: u64,
    /// Number of git objects in the pack.
    pub object_count: u64,
    /// Number of `chunk` documents the pack was split into.
    pub chunk_count: u64,
    /// Storage tier (`0` platform, `1` external).
    pub storage: u64,
    /// Offset-index part count (`≥ 1` for kind-0 packs, `0` for artifacts).
    pub offset_index_parts: u64,
    /// External mirror URIs (serialized to the `uris` JSON-string field).
    pub uris: Vec<String>,
}

/// A `packManifest` document read back from a repo contract.
#[derive(Debug, Clone)]
pub struct PackManifestInfo {
    /// The manifest document id.
    pub document_id: String,
    /// SHA-256 pack hash.
    pub pack_hash: [u8; 32],
    /// Artifact kind.
    pub kind: u64,
    /// Pack size in bytes.
    pub size_bytes: u64,
    /// Object count.
    pub object_count: u64,
    /// Chunk count.
    pub chunk_count: u64,
    /// Storage tier.
    pub storage: u64,
    /// Offset-index part count.
    pub offset_index_parts: u64,
    /// External mirror URIs (parsed from the `uris` JSON-string field).
    pub uris: Vec<String>,
}

/// The repo-lifecycle service, bound to one owner identity and its keys.
///
/// Constructed per-operation-batch: it borrows a connected [`PlatformClient`], the
/// fetched owner [`LoadedIdentity`], and the owner's [`BridgeIdentity`] key material
/// (HIGH for document ops, CRITICAL for the token-bearing contract create — spike S0.7).
pub struct RepoService<'a> {
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
}

impl<'a> RepoService<'a> {
    /// Bind the service to `client`, the owner `identity`, and its `bridge` key material.
    pub fn new(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
    ) -> Self {
        Self {
            client,
            identity,
            bridge,
        }
    }

    /// A document write/delete engine bound to the owner, signing with the HIGH doc-op key.
    fn doc_engine(&self) -> Result<WriteEngine<'a>> {
        WriteEngine::new(self.client, self.identity, self.bridge.doc_op_key()?)
    }

    /// Instantiate a repo: publish the repo-v1 contract (tokens auto-credit the owner),
    /// write the initial `config`, and publish the registry `repoListing`.
    ///
    /// Returns a [`CreateRepoResult`] with the measured DataContractCreate cost. The
    /// `config` and `repoListing` writes each spend one gated/ungated document create on
    /// top (small platform fees, not the headline cost).
    pub async fn create_repo(&self, name: &str, opts: &CreateRepoOpts) -> Result<CreateRepoResult> {
        let normalized = normalize_name(name)?;
        let owner_b58 = self.identity.id();

        let mut template: serde_json::Value = serde_json::from_str(REPO_V1_TEMPLATE)
            .map_err(|e| Error::Config(format!("parsing repo-v1 template: {e}")))?;
        // The committed template models an *org* repo: token admin rules point at
        // `MainGroup` (group 0) with a single placeholder member. Platform rejects a
        // one-member group (`GroupHasTooFewMembersError`, ≥2 required), and a solo owner
        // has no second principal — so instantiate the solo-owner shape: token admin →
        // `ContractOwner`, group dropped (S0.7's validated single-owner token contract).
        apply_solo_owner_token_rules(&mut template);
        // The template numbers `position` globally (nested `imported`/`backend` children
        // consume positions in the parent's sequence), leaving each doc type's *top-level*
        // positions non-contiguous — which native rs-dpp rejects
        // (`MissingPositionsInDocumentTypePropertiesError`: top-level positions must run
        // 0..N with no gaps). Renumber every object level to local-contiguous positions.
        normalize_document_positions(&mut template);

        // 1. Publish the token-bearing contract (CRITICAL key). This is the headline cost.
        let crit_key = self.bridge.token_admin_key()?;
        let (repo_contract_id, create_cost) = self
            .client
            .contract_create(&template, self.identity, crit_key)
            .await?;
        tracing::info!(
            repo_contract_id = %repo_contract_id,
            cost_credits = create_cost,
            cost_dash = credits_to_dash(create_cost),
            "repo-v1 contract created (DataContractCreate)"
        );

        // 2 + 3: config + registry listing against the freshly created contract.
        let listing_document_id = self
            .finalize_repo(&repo_contract_id, name, &normalized, opts)
            .await?;

        Ok(CreateRepoResult {
            handle: RepoHandle {
                repo_contract_id,
                owner_id: owner_b58,
                name: name.to_string(),
                normalized_name: normalized,
            },
            repo_v1_instantiation_cost_credits: create_cost,
            listing_document_id,
        })
    }

    /// Finish instantiating a repo whose contract already exists but whose follow-on
    /// writes did not complete — write the `config` and registry `repoListing` against
    /// `repo_contract_id`. This is the recovery path for a [`RepoService::create_repo`]
    /// whose (already paid-for) DataContractCreate landed but a later step failed, so the
    /// expensive create is never repeated. `repo_v1_instantiation_cost_credits` is `0`
    /// (nothing new was created).
    pub async fn resume_repo(
        &self,
        repo_contract_id: &str,
        name: &str,
        opts: &CreateRepoOpts,
    ) -> Result<CreateRepoResult> {
        let normalized = normalize_name(name)?;
        let listing_document_id = self
            .finalize_repo(repo_contract_id, name, &normalized, opts)
            .await?;
        Ok(CreateRepoResult {
            handle: RepoHandle {
                repo_contract_id: repo_contract_id.to_string(),
                owner_id: self.identity.id(),
                name: name.to_string(),
                normalized_name: normalized,
            },
            repo_v1_instantiation_cost_credits: 0,
            listing_document_id,
        })
    }

    /// Write the initial `config` (MAINTAIN-gated; owner holds MAINTAIN via baseSupply)
    /// and the registry `repoListing` (ungated open create) for `repo_contract_id`,
    /// returning the listing document id.
    async fn finalize_repo(
        &self,
        repo_contract_id: &str,
        name: &str,
        normalized: &str,
        opts: &CreateRepoOpts,
    ) -> Result<String> {
        let repo_contract = self.client.fetch_contract(repo_contract_id).await?;
        let engine = self.doc_engine()?;

        engine
            .create_document(
                &repo_contract,
                DOC_CONFIG,
                config_properties(&opts.default_branch, opts.backend_mode),
            )
            .await?;

        let registry = self
            .client
            .fetch_contract(TESTNET_REGISTRY_CONTRACT_ID)
            .await?;
        let repo_id_bytes = platform::decode_identifier(repo_contract_id)?;
        let mut listing = BTreeMap::new();
        listing.insert("name".to_string(), FieldValue::text(name));
        listing.insert("normalizedName".to_string(), FieldValue::text(normalized));
        listing.insert(
            "repoContractId".to_string(),
            FieldValue::identifier(repo_id_bytes),
        );
        listing.insert(
            "templateVersion".to_string(),
            FieldValue::integer(u64::from(opts.template_version)),
        );
        listing.insert(
            "description".to_string(),
            FieldValue::text(opts.description.clone()),
        );
        listing.insert("topics".to_string(), FieldValue::text("[]"));
        engine
            .create_document(&registry, DOC_REPO_LISTING, listing)
            .await
    }

    /// Resolve a repo by owner identity id (base58) and repo name via the registry
    /// `repoListing` unique `(ownerId, normalizedName)` index.
    pub async fn resolve_repo(&self, owner_id: &str, repo_name: &str) -> Result<RepoHandle> {
        let normalized = normalize_name(repo_name)?;
        let registry = self
            .client
            .fetch_contract(TESTNET_REGISTRY_CONTRACT_ID)
            .await?;
        let owner_bytes = platform::decode_identifier(owner_id)?;

        let docs = self
            .client
            .query_documents(
                &registry,
                DOC_REPO_LISTING,
                &[
                    QueryFilter::eq("$ownerId", FieldValue::identifier(owner_bytes)),
                    QueryFilter::eq("normalizedName", FieldValue::text(normalized.clone())),
                ],
                &[],
                1,
                None,
            )
            .await?;

        let listing = docs.into_iter().next().ok_or(Error::NotFound)?;
        let repo_id_bytes = listing
            .field_bytes("repoContractId")
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .ok_or_else(|| Error::Platform("repoListing missing repoContractId".into()))?;
        let name = listing
            .field_str("name")
            .unwrap_or_else(|| repo_name.to_string());

        Ok(RepoHandle {
            repo_contract_id: platform::encode_identifier(repo_id_bytes),
            owner_id: owner_id.to_string(),
            name,
            normalized_name: normalized,
        })
    }

    /// Append a ref update. `new_oid` all-zero = ref deletion; `prev_oid` = the expected
    /// prior tip (for divergence detection). Protected refs (per the current `config`
    /// patterns) route to the MAINTAIN-gated `protectedRefUpdate` type; everything else
    /// is a WRITE-gated `refUpdate`. Returns the created document id.
    pub async fn write_ref_update(
        &self,
        repo: &RepoHandle,
        ref_name: &str,
        new_oid: &[u8],
        prev_oid: Option<&[u8]>,
        force: bool,
    ) -> Result<String> {
        let repo_contract = self.client.fetch_contract(&repo.repo_contract_id).await?;
        let ref_name_hash = crate::backends::sha256(ref_name.as_bytes());

        let configs = self.fetch_config_history(&repo_contract).await?;
        let patterns = current_protected_patterns(&configs);
        let protected = rules::matches_protected(ref_name, &patterns);
        let doc_type = if protected {
            DOC_PROTECTED_REF_UPDATE
        } else {
            DOC_REF_UPDATE
        };

        let mut props = BTreeMap::new();
        props.insert(
            "refNameHash".to_string(),
            FieldValue::bytes32(ref_name_hash),
        );
        props.insert("refName".to_string(), FieldValue::text(ref_name));
        props.insert("newOid".to_string(), FieldValue::bytes(new_oid.to_vec()));
        if let Some(prev) = prev_oid {
            props.insert("prevOid".to_string(), FieldValue::bytes(prev.to_vec()));
        }
        props.insert("force".to_string(), FieldValue::boolean(force));

        self.doc_engine()?
            .create_document(&repo_contract, doc_type, props)
            .await
    }

    /// Enumerate every ref and its resolved [`RefState`].
    ///
    /// Distinct ref-name hashes are found via the S0.8 skip-scan (`refNameHash > last`,
    /// `orderBy refNameHash`, `limit 1`) across both the `refUpdate` and
    /// `protectedRefUpdate` types; each ref's combined update history + the repo's
    /// `config` history is folded by [`crate::rules::resolve_ref`].
    ///
    /// The ancestry predicate is reflexive-only here (M1 has no read-side commit graph):
    /// fast-forward supersession via `prevOid` still resolves, but descend-detection is
    /// deferred to the push-side pipeline that has the object store. A single-tip ref (the
    /// common case) resolves to [`RefState::Resolved`] correctly.
    pub async fn read_refs(&self, repo: &RepoHandle) -> Result<Vec<(String, RefState)>> {
        let repo_contract = self.client.fetch_contract(&repo.repo_contract_id).await?;
        let configs = self.fetch_config_history(&repo_contract).await?;

        let mut hashes: BTreeSet<[u8; 32]> = BTreeSet::new();
        for doc_type in [DOC_REF_UPDATE, DOC_PROTECTED_REF_UPDATE] {
            self.enumerate_ref_hashes(&repo_contract, doc_type, &mut hashes)
                .await?;
        }

        let mut out = Vec::with_capacity(hashes.len());
        for hash in &hashes {
            let updates = self.fetch_ref_updates(&repo_contract, *hash).await?;
            let Some(newest) = updates.iter().max_by(|a, b| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| a.id.cmp(&b.id))
            }) else {
                continue;
            };
            let ref_name = newest.ref_name.clone();
            let hash_hex = hex::encode(hash);
            let state = rules::resolve_ref(&updates, &configs, &hash_hex, |a, b| a == b);
            out.push((ref_name, state));
        }
        Ok(out)
    }

    /// Write a `packManifest` document (WRITE-gated). Returns the manifest document id.
    pub async fn write_pack_manifest(
        &self,
        repo: &RepoHandle,
        manifest: &PackManifestInput,
    ) -> Result<String> {
        let repo_contract = self.client.fetch_contract(&repo.repo_contract_id).await?;
        let mut props = BTreeMap::new();
        props.insert(
            "packHash".to_string(),
            FieldValue::bytes32(manifest.pack_hash),
        );
        props.insert("kind".to_string(), FieldValue::integer(manifest.kind));
        props.insert(
            "sizeBytes".to_string(),
            FieldValue::integer(manifest.size_bytes),
        );
        props.insert(
            "objectCount".to_string(),
            FieldValue::integer(manifest.object_count),
        );
        props.insert(
            "chunkCount".to_string(),
            FieldValue::integer(manifest.chunk_count),
        );
        props.insert("storage".to_string(), FieldValue::integer(manifest.storage));
        props.insert(
            "offsetIndexParts".to_string(),
            FieldValue::integer(manifest.offset_index_parts),
        );
        if !manifest.uris.is_empty() {
            let json = serde_json::to_string(&manifest.uris)
                .map_err(|e| Error::Config(format!("serializing manifest uris: {e}")))?;
            props.insert("uris".to_string(), FieldValue::text(json));
        }

        self.doc_engine()?
            .create_document(&repo_contract, DOC_PACK_MANIFEST, props)
            .await
    }

    /// Read a repo's `packManifest` documents, newest first.
    pub async fn read_pack_manifests(&self, repo: &RepoHandle) -> Result<Vec<PackManifestInfo>> {
        let repo_contract = self.client.fetch_contract(&repo.repo_contract_id).await?;
        let docs = self
            .client
            .query_documents(
                &repo_contract,
                DOC_PACK_MANIFEST,
                &[],
                &[QueryOrder::desc("$createdAt")],
                0,
                None,
            )
            .await?;

        docs.iter()
            .map(|d| {
                let pack_hash = d
                    .field_bytes("packHash")
                    .and_then(|b| <[u8; 32]>::try_from(b).ok())
                    .ok_or_else(|| Error::Platform("packManifest missing packHash".into()))?;
                let uris = d
                    .field_str("uris")
                    .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
                    .unwrap_or_default();
                Ok(PackManifestInfo {
                    document_id: d.id.clone(),
                    pack_hash,
                    kind: d.field_u64("kind").unwrap_or_default(),
                    size_bytes: d.field_u64("sizeBytes").unwrap_or_default(),
                    object_count: d.field_u64("objectCount").unwrap_or_default(),
                    chunk_count: d.field_u64("chunkCount").unwrap_or_default(),
                    storage: d.field_u64("storage").unwrap_or_default(),
                    offset_index_parts: d.field_u64("offsetIndexParts").unwrap_or_default(),
                    uris,
                })
            })
            .collect()
    }

    /// Store pack `bytes` as pipelined `chunk` documents via [`PlatformBackend`], returning
    /// the `platform://…` locator(s) the manifest should record.
    pub async fn put_pack(
        &self,
        repo: &RepoHandle,
        bytes: &[u8],
        meta: &PackMeta,
    ) -> Result<Vec<Uri>> {
        let repo_contract = self.client.fetch_contract(&repo.repo_contract_id).await?;
        let engine = self.doc_engine()?;
        let backend = PlatformBackend::new(&engine, &repo_contract);
        backend.put(bytes, meta).await
    }

    /// Read pack bytes back from `chunk` documents via [`PlatformBackend`] (optionally a
    /// byte range), reassembled by the pure `crate::pack::join`.
    pub async fn get_pack(
        &self,
        repo: &RepoHandle,
        uri: &Uri,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>> {
        let repo_contract = self.client.fetch_contract(&repo.repo_contract_id).await?;
        let engine = self.doc_engine()?;
        let backend = PlatformBackend::new(&engine, &repo_contract);
        backend.get(uri, range).await
    }

    /// Delete a document by id from an arbitrary contract (used for teardown — chunks /
    /// manifests / the registry listing refund; the contract and non-deletable audit docs
    /// are permanent).
    pub async fn delete_document(
        &self,
        contract_id: &str,
        document_type: &str,
        document_id: &str,
    ) -> Result<()> {
        let contract = self.client.fetch_contract(contract_id).await?;
        self.doc_engine()?
            .delete_document(&contract, document_type, document_id)
            .await
    }

    /// Delete every `chunk` document for a pack (WRITE-gated refund), returning the count
    /// removed.
    pub async fn delete_chunks(&self, repo: &RepoHandle, pack_hash: [u8; 32]) -> Result<usize> {
        let repo_contract = self.client.fetch_contract(&repo.repo_contract_id).await?;
        let engine = self.doc_engine()?;
        let mut removed = 0;
        loop {
            let page = self
                .client
                .query_documents(
                    &repo_contract,
                    DOC_CHUNK,
                    &[QueryFilter::eq("packHash", FieldValue::bytes32(pack_hash))],
                    &[QueryOrder::asc("seq")],
                    100,
                    None,
                )
                .await?;
            if page.is_empty() {
                break;
            }
            for doc in &page {
                engine
                    .delete_document(&repo_contract, DOC_CHUNK, &doc.id)
                    .await?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    // --- internal read helpers ---

    /// The repo's full `config` history (append-only, non-deletable), as [`ConfigDoc`]s
    /// ordered by `$createdAt`.
    async fn fetch_config_history(&self, repo_contract: &LoadedContract) -> Result<Vec<ConfigDoc>> {
        // config is append-only & non-deletable; a repo's config history is tiny (one doc
        // per protect/settings change), so a single page covers M1. Pagination TODO if a
        // repo ever exceeds ~100 config revisions.
        let docs = self
            .client
            .query_documents(
                repo_contract,
                DOC_CONFIG,
                &[],
                &[QueryOrder::asc("$createdAt")],
                0,
                None,
            )
            .await?;
        Ok(docs
            .iter()
            .map(|d| ConfigDoc {
                id: d.id.clone(),
                created_at: d.created_at.unwrap_or(0),
                protected_patterns: d
                    .field_str("protectedPatterns")
                    .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
                    .unwrap_or_default(),
            })
            .collect())
    }

    /// Skip-scan the distinct `refNameHash` values of `doc_type` into `set`.
    async fn enumerate_ref_hashes(
        &self,
        repo_contract: &LoadedContract,
        doc_type: &str,
        set: &mut BTreeSet<[u8; 32]>,
    ) -> Result<()> {
        let mut last: Option<[u8; 32]> = None;
        loop {
            let filters = match last {
                Some(h) => vec![QueryFilter::gt("refNameHash", FieldValue::bytes32(h))],
                None => vec![],
            };
            let page = self
                .client
                .query_documents(
                    repo_contract,
                    doc_type,
                    &filters,
                    &[QueryOrder::asc("refNameHash")],
                    1,
                    None,
                )
                .await?;
            let Some(doc) = page.into_iter().next() else {
                break;
            };
            let Some(hash) = doc
                .field_bytes("refNameHash")
                .and_then(|b| <[u8; 32]>::try_from(b).ok())
            else {
                break;
            };
            set.insert(hash);
            last = Some(hash);
        }
        Ok(())
    }

    /// Fetch every `refUpdate` + `protectedRefUpdate` for one ref-name hash, flattened to
    /// the [`RefUpdate`] shape [`crate::rules::resolve_ref`] consumes.
    async fn fetch_ref_updates(
        &self,
        repo_contract: &LoadedContract,
        ref_name_hash: [u8; 32],
    ) -> Result<Vec<RefUpdate>> {
        let hash_hex = hex::encode(ref_name_hash);
        let mut updates = Vec::new();
        for (doc_type, protected) in [(DOC_REF_UPDATE, false), (DOC_PROTECTED_REF_UPDATE, true)] {
            let docs = self
                .client
                .query_documents(
                    repo_contract,
                    doc_type,
                    &[QueryFilter::eq(
                        "refNameHash",
                        FieldValue::bytes32(ref_name_hash),
                    )],
                    &[QueryOrder::asc("$createdAt")],
                    0,
                    None,
                )
                .await?;
            for d in &docs {
                updates.push(RefUpdate {
                    id: d.id.clone(),
                    ref_name_hash: hash_hex.clone(),
                    ref_name: d.field_str("refName").unwrap_or_default(),
                    prev_oid: d.field_hex("prevOid").unwrap_or_default(),
                    new_oid: d.field_hex("newOid").unwrap_or_default(),
                    force: d.field_bool("force"),
                    protected,
                    author: d.owner_id.clone(),
                    created_at: d.created_at.unwrap_or(0),
                });
            }
        }
        Ok(updates)
    }
}

/// The initial `config` document properties (`defaultBranch`, empty protected patterns,
/// backend mode, not archived).
fn config_properties(default_branch: &str, backend_mode: u8) -> BTreeMap<String, FieldValue> {
    let mut props = BTreeMap::new();
    props.insert(
        "defaultBranch".to_string(),
        FieldValue::text(default_branch),
    );
    props.insert("protectedPatterns".to_string(), FieldValue::text("[]"));
    let mut backend = BTreeMap::new();
    backend.insert(
        "mode".to_string(),
        FieldValue::integer(u64::from(backend_mode)),
    );
    backend.insert("uris".to_string(), FieldValue::text("[]"));
    props.insert("backend".to_string(), FieldValue::Object(backend));
    props.insert("archived".to_string(), FieldValue::boolean(false));
    props
}

/// Rewrite a repo template's tokens for a **solo-owner** repo: every token-admin rule
/// that points at `MainGroup` is re-pointed at `ContractOwner`, `mainControlGroup` is
/// cleared, and the top-level `groups` object is dropped.
///
/// The committed repo-v1 template targets an org repo (a control group holds
/// mint/freeze/destroy). Platform requires a group to have ≥ 2 members
/// (`GroupHasTooFewMembersError`), which a single owner cannot satisfy — so a solo repo
/// instantiates with the owner as the sole token authority (the S0.7-validated shape).
/// Org repos (a multi-principal owner) are a documented follow-up that keeps the group.
fn apply_solo_owner_token_rules(template: &mut serde_json::Value) {
    if let Some(obj) = template.as_object_mut() {
        obj.remove("groups");
    }
    let Some(tokens) = template.get_mut("tokens").and_then(|t| t.as_object_mut()) else {
        return;
    };
    for token in tokens.values_mut() {
        repoint_group_rules_to_owner(token);
    }
}

/// Recursively replace `MainGroup` action-taker values with `ContractOwner` and null out
/// any `mainControlGroup` reference within a token configuration.
fn repoint_group_rules_to_owner(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                if (key == "authorizedToMakeChange" || key == "adminActionTakers")
                    && v.as_str() == Some("MainGroup")
                {
                    *v = serde_json::Value::String("ContractOwner".to_string());
                } else if key == "mainControlGroup" {
                    *v = serde_json::Value::Null;
                } else {
                    repoint_group_rules_to_owner(v);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                repoint_group_rules_to_owner(item);
            }
        }
        _ => {}
    }
}

/// Renumber every doc-type schema's `position` fields so each object level is
/// contiguous 0..N (in existing position order).
///
/// Native rs-dpp validates that a document type's **top-level** property positions run
/// `0..N` with no gaps (`MissingPositionsInDocumentTypePropertiesError`). The committed
/// repo-v1 template numbers positions globally — a nested `imported`/`backend` object's
/// children take positions in the *parent's* sequence, so the parent object then jumps
/// past them (e.g. `comment`: top-level 0-6, then `imported` at 10), leaving a gap.
/// Renumbering per object level makes it valid without changing field identity (fields
/// are addressed by name, not position, in every write path).
fn normalize_document_positions(template: &mut serde_json::Value) {
    let Some(schemas) = template
        .get_mut("documentSchemas")
        .and_then(|v| v.as_object_mut())
    else {
        return;
    };
    for schema in schemas.values_mut() {
        renumber_object_positions(schema);
    }
}

/// Renumber one object schema's direct `properties` to contiguous 0-based positions (in
/// current position order), recursing into nested object properties.
fn renumber_object_positions(schema: &mut serde_json::Value) {
    let Some(props) = schema.get_mut("properties").and_then(|v| v.as_object_mut()) else {
        return;
    };
    let mut order: Vec<(String, u64)> = props
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                v.get("position")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            )
        })
        .collect();
    order.sort_by_key(|(_, pos)| *pos);
    for (new_pos, (key, _)) in order.into_iter().enumerate() {
        if let Some(prop) = props.get_mut(&key) {
            if let Some(obj) = prop.as_object_mut() {
                obj.insert(
                    "position".to_string(),
                    serde_json::Value::from(new_pos as u64),
                );
            }
            renumber_object_positions(prop);
        }
    }
}

/// Convert a credit amount to DASH for display/logging (1 DASH = 1e11 credits).
#[allow(clippy::cast_precision_loss)]
pub fn credits_to_dash(credits: u64) -> f64 {
    credits as f64 / 1e11
}

/// The protected-ref globs in force per the newest `config` (`(createdAt, id)` order).
fn current_protected_patterns(configs: &[ConfigDoc]) -> Vec<String> {
    configs
        .iter()
        .max_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        })
        .map(|c| c.protected_patterns.clone())
        .unwrap_or_default()
}

/// Normalize and validate a repo name against the registry
/// `^[a-z0-9][a-z0-9._-]{0,62}$` pattern (lowercased first).
fn normalize_name(name: &str) -> Result<String> {
    let normalized = name.to_ascii_lowercase();
    let bytes = normalized.as_bytes();
    let valid = (1..=63).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
    if valid {
        Ok(normalized)
    } else {
        Err(Error::Config(format!(
            "invalid repo name '{name}': must match ^[a-z0-9][a-z0-9._-]{{0,62}}$ after lowercasing"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::{current_protected_patterns, normalize_name, REPO_V1_TEMPLATE};
    use crate::rules::ConfigDoc;

    #[test]
    fn normalize_name_accepts_valid_and_rejects_invalid() {
        assert_eq!(normalize_name("MyRepo").unwrap(), "myrepo");
        assert_eq!(normalize_name("a.b-c_1").unwrap(), "a.b-c_1");
        assert!(normalize_name("").is_err());
        assert!(normalize_name(".leading-dot").is_err());
        assert!(normalize_name("has space").is_err());
        assert!(normalize_name(&"x".repeat(64)).is_err());
        assert!(normalize_name(&"x".repeat(63)).is_ok());
    }

    #[test]
    fn current_protected_patterns_picks_newest_config() {
        let configs = vec![
            ConfigDoc {
                id: "a".into(),
                created_at: 100,
                protected_patterns: vec!["refs/heads/main".into()],
            },
            ConfigDoc {
                id: "b".into(),
                created_at: 200,
                protected_patterns: vec!["refs/heads/*".into()],
            },
        ];
        assert_eq!(
            current_protected_patterns(&configs),
            vec!["refs/heads/*".to_string()]
        );
        assert!(current_protected_patterns(&[]).is_empty());
    }

    #[test]
    fn embedded_template_has_tokens_and_doc_types() {
        let t: serde_json::Value = serde_json::from_str(REPO_V1_TEMPLATE).unwrap();
        assert!(t.get("tokens").and_then(|v| v.as_object()).unwrap().len() == 2);
        assert!(
            t.get("documentSchemas")
                .and_then(|v| v.as_object())
                .unwrap()
                .len()
                >= 15
        );
    }

    #[test]
    fn normalize_positions_makes_top_level_contiguous() {
        use super::normalize_document_positions;
        let mut t: serde_json::Value = serde_json::from_str(REPO_V1_TEMPLATE).unwrap();
        normalize_document_positions(&mut t);

        for (name, schema) in t.get("documentSchemas").unwrap().as_object().unwrap() {
            let props = schema.get("properties").unwrap().as_object().unwrap();
            let mut positions: Vec<u64> = props
                .values()
                .map(|p| p.get("position").unwrap().as_u64().unwrap())
                .collect();
            positions.sort_unstable();
            let expected: Vec<u64> = (0..positions.len() as u64).collect();
            assert_eq!(
                positions, expected,
                "top-level positions for '{name}' must be contiguous 0..N"
            );
            // Nested `imported`/`backend` objects also renumbered to local 0-based.
            for prop in props.values() {
                if let Some(nested) = prop.get("properties").and_then(|v| v.as_object()) {
                    let mut np: Vec<u64> = nested
                        .values()
                        .map(|p| p.get("position").unwrap().as_u64().unwrap())
                        .collect();
                    np.sort_unstable();
                    assert_eq!(np, (0..np.len() as u64).collect::<Vec<_>>());
                }
            }
        }
    }

    #[test]
    fn solo_owner_transform_drops_group_and_repoints_rules() {
        use super::apply_solo_owner_token_rules;
        let mut t: serde_json::Value = serde_json::from_str(REPO_V1_TEMPLATE).unwrap();
        // The committed template targets an org group.
        assert!(t.get("groups").is_some());
        let raw = serde_json::to_string(&t).unwrap();
        assert!(raw.contains("MainGroup"));

        apply_solo_owner_token_rules(&mut t);

        // Group dropped; no MainGroup rule survives; every mainControlGroup nulled.
        assert!(t.get("groups").is_none());
        let out = serde_json::to_string(&t).unwrap();
        assert!(
            !out.contains("MainGroup"),
            "no MainGroup rule should remain"
        );
        for token in t.get("tokens").unwrap().as_object().unwrap().values() {
            assert!(token.get("mainControlGroup").unwrap().is_null());
        }
    }
}
