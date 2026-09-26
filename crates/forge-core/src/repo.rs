//! [`RepoService`] — the git data plane `git-remote-dash` and `dg` drive.
//!
//! Every operation takes a resolved [`RepoRef`] and reaches its documents through the
//! repo's [`DocScope`]: on forge-v2 that is the network's shared forge-core contract with
//! `repoId == R` on every query and write; on forge-v1 it is the repo's own contract. v1
//! repositories are **read only**: every write refuses them with [`Error::V1ReadOnly`]
//! before signing anything.
//!
//! - [`RepoService::write_ref_update`] / [`RepoService::read_refs`] — append a ref update
//!   (`protectedRefUpdate` for a protected ref, routed by the as-of config rule) and fold a
//!   repo's ref history into [`RefState`]s via [`crate::rules::resolve_ref`].
//! - [`RepoService::write_pack_manifest`] / [`RepoService::read_pack_manifests`] and the
//!   chunk tier ([`PlatformChunkTarget`]).
//! - [`RepoService::fetch_artifact`] — read a pack: external copies first, then Platform
//!   chunks. On v2 each uploader has its own copy of a pack; readers try them in the
//!   `FORGE_RULES_V2` order (maintainers', then writers', then former members'), and use
//!   the first that hash-verifies ([`crate::rules::v2::order_pack_copies`]).
//! - [`RepoService::repack`] — consolidate the live packs into one superseding pack. On v2
//!   nothing is deleted: chunks and manifests are permanent (forge-v2 §4).
//!
//! Repository creation is [`crate::create`]; resolution is [`crate::resolve`]; membership
//! is [`crate::members`]. This module names no rs-sdk type (style guide §B).

use std::collections::{BTreeMap, BTreeSet};

use crate::backends::{PackBackend, PackMeta, PlatformBackend, Uri};
use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::platform::{
    FetchedDocument, FieldValue, JournalStore, LoadedContract, LoadedIdentity, PlatformClient,
    PushJournal, QueryFilter, QueryOrder, WriteEngine, WriteIntent,
};
use crate::private::RefNameHasher;
use crate::rules::v2::{CopyKey, PackCopy, PackCopyRow, Role, V2Pack};
use crate::rules::{self, ConfigDoc, RefState};
use crate::scope::{self, DocScope, RepoRef};
use crate::storage::{PackReader, Replication, StorageTarget, UriBudget};

// Document type names (the git data plane; the same names in forge-core and repo-v1).
const DOC_CONFIG: &str = "config";
use crate::refs::{DOC_PROTECTED_REF_UPDATE, DOC_REF_UPDATE};
const DOC_PACK_MANIFEST: &str = "packManifest";

/// A `packManifest` document read back from a repository.
#[derive(Debug, Clone)]
pub struct PackManifestInfo {
    /// The manifest document id.
    pub document_id: String,
    /// `$createdAt` (ms). With `document_id` this is the platform total order that
    /// [`locator_pack_space`] turns into the locator's `packRef` space.
    pub created_at: u64,
    /// The base58 `$ownerId` of the uploader. On v2 its chunks are keyed by it.
    pub owner_id: String,
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
    /// External copies (`uris`: a typed array on v2, a JSON string on v1).
    pub uris: Vec<String>,
    /// Prior `packHash`es this manifest supersedes (parsed from the packed `byteArray`).
    pub supersedes: Vec<[u8; 32]>,
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
    /// External mirror URIs.
    pub uris: Vec<String>,
    /// Prior artifact `packHash`es this manifest makes redundant (repack supersedes plan).
    /// Serialized as one packed `byteArray` = concatenated 32-byte hashes.
    pub supersedes: Vec<[u8; 32]>,
    /// Tip OIDs this artifact covers (kind-2 flatIndex tip; a gitmirror pack's ref tips).
    /// Serialized as one packed `byteArray` = concatenated raw OID bytes.
    pub tips: Vec<Vec<u8>>,
}

/// Live index fragments tolerated before a push folds them into one locator.
///
/// Trades writer cost against reader fan-out: each fragment is one more artifact a browser
/// fetches before its first object read, while folding republishes the whole index. 16 keeps
/// the cold-browse fan-out small and the amortized write cost at roughly a sixteenth of a
/// whole-index republish per push.
const MAX_LOCATOR_FRAGMENTS: usize = 16;

/// Where a repack writes the consolidated pack.
#[derive(Clone, Copy, Default)]
pub enum RepackTarget<'a> {
    /// On-chain `chunk` docs (the default).
    #[default]
    Platform,
    /// An external backend (ipfs/s3/https) — migrates cold history outward. The pack is
    /// hash-verifiable at its URIs.
    External(&'a dyn PackBackend),
    /// A storage policy's targets, requiring `required` verified confirmations
    /// ([`crate::storage::replicate`]). This is what a `git push` writes through.
    Replicated {
        /// The targets (external and/or [`PlatformChunkTarget`]).
        targets: &'a [&'a dyn StorageTarget],
        /// Confirmations required before the manifest may be written.
        required: usize,
    },
}

/// The `packManifest.uris` budget of a v2 repo: a typed array (forge-core schema).
pub const MANIFEST_URIS_V2: UriBudget = UriBudget::array(8, 300);
/// The `config.backend.uris` budget of a v2 repo (forge-core schema).
pub const BACKEND_URIS_V2: UriBudget = UriBudget::array(4, 300);

/// How a manifest records an artifact stored through [`RepackTarget::Replicated`]:
/// `storage` 0 when an on-chain copy exists (Platform-reading clients, including today's
/// web app, read the chunks; every other copy is still listed in `uris` for CLI readers to
/// race), `storage` 1 when only external copies exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredArtifact {
    /// `packManifest.storage`.
    pub storage: u64,
    /// `packManifest.chunkCount` — 0 unless an on-chain copy was written.
    pub chunk_count: u64,
    /// `packManifest.uris`.
    pub uris: Vec<String>,
}

impl StoredArtifact {
    /// Derive the manifest fields from a successful replication of `bytes` into a v2
    /// repository (the only kind anything is written to).
    pub fn from_replication(rep: &Replication, bytes: &[u8]) -> Result<Self> {
        let platform = rep.has_platform();
        Ok(Self {
            storage: u64::from(!platform),
            chunk_count: if platform {
                crate::pack::split(bytes).len() as u64
            } else {
                0
            },
            uris: rep.manifest_uris(MANIFEST_URIS_V2)?,
        })
    }
}

/// The Platform `chunk`-document tier as a [`StorageTarget`].
///
/// With a journal it uploads resumably (an interrupted push resumes without re-paying for
/// confirmed chunks). On forge-v2 chunks are permanent and keyed by uploader, so a partial
/// upload is simply resumed (or re-uploaded idempotently) by the next push: chunk writes are
/// content-addressed by `(repoId, uploader, packHash, seq)`, so the retry of a stored chunk
/// is refused as a duplicate and treated as stored.
pub struct PlatformChunkTarget<'s> {
    svc: &'s RepoService<'s>,
    repo: &'s RepoRef,
    name: String,
    journal: Option<(std::sync::Mutex<PushJournal>, &'s (dyn JournalStore + Sync))>,
}

impl<'s> PlatformChunkTarget<'s> {
    /// A target writing `repo`'s chunks through `svc`.
    pub fn new(svc: &'s RepoService<'s>, repo: &'s RepoRef, name: impl Into<String>) -> Self {
        Self {
            svc,
            repo,
            name: name.into(),
            journal: None,
        }
    }

    /// A resumable target: confirmed chunks are checkpointed through `store`.
    pub fn resumable(
        svc: &'s RepoService<'s>,
        repo: &'s RepoRef,
        name: impl Into<String>,
        journal: PushJournal,
        store: &'s (dyn JournalStore + Sync),
    ) -> Self {
        Self {
            svc,
            repo,
            name: name.into(),
            journal: Some((std::sync::Mutex::new(journal), store)),
        }
    }
}

#[async_trait::async_trait]
impl StorageTarget for PlatformChunkTarget<'_> {
    fn name(&self) -> &str {
        &self.name
    }

    fn is_platform(&self) -> bool {
        true
    }

    async fn store(&self, bytes: &[u8], meta: &PackMeta) -> Result<Vec<Uri>> {
        if let Some((journal, store)) = &self.journal {
            // Take the journal out for the upload (a std lock must not be held across an
            // await) and put the checkpointed state back either way.
            let poisoned = || Error::Io("push journal lock poisoned".into());
            let mut j = std::mem::take(&mut *journal.lock().map_err(|_| poisoned())?);
            let res = self
                .svc
                .put_pack_resumable(self.repo, bytes, meta, &mut j, *store)
                .await;
            *journal.lock().map_err(|_| poisoned())? = j;
            return res;
        }
        self.svc.put_pack(self.repo, bytes, meta).await
    }
}

/// What [`RepoService::publish_push_locator`] did to the browse index.
#[derive(Debug, Clone)]
pub enum PushIndexOutcome {
    /// An index fragment covering just the pushed pack was published.
    Fragment {
        /// The new `packManifest` document id.
        manifest_id: String,
        /// The pushed pack's position in the live pack space.
        pack_ref: u16,
    },
    /// The live fragments were folded into one locator covering the whole live pack space.
    Consolidated {
        /// The new `packManifest` document id.
        manifest_id: String,
        /// How many fragments it superseded.
        folded: usize,
    },
    /// Nothing was published; the string says why, in terms a user can act on.
    Skipped(String),
}

/// The stored facts about a repack's consolidated pack, as its `packManifest` records them.
struct ConsolidatedPack<'a> {
    pack_hash: [u8; 32],
    size_bytes: u64,
    object_count: u64,
    chunk_count: u64,
    storage: u64,
    uris: Vec<String>,
    /// The resolved ref tips the pack covers (hex oids).
    tips: &'a [String],
}

/// The result of [`RepoService::repack`] (consolidate-only on forge-v2).
#[derive(Debug, Clone)]
pub struct RepackReport {
    /// SHA-256 of the new consolidated pack.
    pub new_pack_hash: [u8; 32],
    /// The new `packManifest` document id.
    pub new_manifest_id: String,
    /// The `objectLocator` manifest published over the consolidated pack, when it landed.
    ///
    /// `None` means the repack succeeded but the browse index was not written — browsing
    /// stays on the whole-pack fallback until the next repack. Not an error: the
    /// consolidation is already paid for and durable by then.
    pub locator_manifest_id: Option<String>,
    /// Size of the consolidated pack in bytes.
    pub new_pack_bytes: u64,
    /// Object count of the consolidated pack.
    pub object_count: u64,
    /// The URIs the new pack is stored at (platform locator, or external mirrors).
    pub new_uris: Vec<String>,
    /// How many prior packs the new manifest supersedes.
    pub superseded_count: usize,
    /// Bytes of the packs the new manifest supersedes. They stay stored (readers fall
    /// back to them); on your own external storage they may be garbage-collected.
    pub superseded_bytes: u64,
    /// Credits spent uploading the consolidated pack and writing its manifest(s).
    pub cost_credits: u64,
}

/// The result of [`RepoService::reseed`].
#[derive(Debug, Clone, Default)]
pub struct ReseedReport {
    /// Every pack re-uploaded.
    pub reseeded: Vec<Reseeded>,
    /// Packs with no readable copy (not reseeded; `dg reseed --from-local` can restore them).
    pub unreadable: Vec<[u8; 32]>,
}

/// One pack [`RepoService::reseed`] re-uploaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reseeded {
    /// The pack.
    pub pack_hash: [u8; 32],
    /// Where the new copy is.
    pub uris: Vec<String>,
    /// Whether the caller's own manifest now records it (`false`: the caller already had
    /// one for this pack, and manifests are immutable).
    pub announced: bool,
}

/// The result of [`RepoService::reseed_from_local`].
#[derive(Debug, Clone, Default)]
pub struct LocalReseedReport {
    /// Packs re-uploaded from the local clone.
    pub restored: Vec<LocalReseed>,
    /// Packs whose recorded copies still verified (skipped).
    pub healthy: Vec<[u8; 32]>,
    /// Packs that needed restoring but have no local copy in this clone.
    pub missing: Vec<[u8; 32]>,
}

/// One pack [`RepoService::reseed_from_local`] re-uploaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalReseed {
    /// The pack.
    pub pack_hash: [u8; 32],
    /// Every URI the confirmed copies are at now.
    pub uris: Vec<String>,
    /// Whether one of them is a URI the manifest already records (the recorded copy is
    /// readable again — the usual outcome when re-uploading through the original profile).
    pub restored_recorded_uri: bool,
}

/// A repository's current members as the pack reader rule needs them (maintainers'
/// copies first): empty on v1, where every copy is the repo contract's own.
pub type RoleMap = BTreeMap<String, Role>;

/// The git data-plane service, bound to one signing identity and its keys.
///
/// Constructed per operation batch: it borrows a connected [`PlatformClient`], the fetched
/// signer [`LoadedIdentity`] and its [`BridgeIdentity`] key material.
pub struct RepoService<'a> {
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
}

impl<'a> RepoService<'a> {
    /// Bind the service to `client`, the signer `identity`, and its `bridge` key material.
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

    /// A document write engine bound to the signer, signing with the HIGH doc-op key.
    fn doc_engine(&self) -> Result<WriteEngine<'a>> {
        WriteEngine::new(self.client, self.identity, self.bridge.doc_op_key()?)
    }

    /// The contract holding `repo`'s git data (forge-core, or the v1 repo contract),
    /// fetched and registered with the proof verifier.
    pub async fn repo_contract(&self, repo: &RepoRef) -> Result<LoadedContract> {
        self.client.fetch_contract(&repo.scope()?.contract_id).await
    }

    /// The scope and contract of `repo`, for reading (a repo this client can read).
    async fn readable(&self, repo: &RepoRef) -> Result<(DocScope, LoadedContract)> {
        repo.require_readable()?;
        let scope = repo.scope()?;
        let contract = self.client.fetch_contract(&scope.contract_id).await?;
        Ok((scope, contract))
    }

    /// The writable (v2) scope and contract of `repo`, or [`Error::V1ReadOnly`].
    async fn writable(&self, repo: &RepoRef) -> Result<(DocScope, LoadedContract)> {
        repo.require_v2()?;
        self.readable(repo).await
    }

    /// Append a ref update. `new_oid` all-zero = ref deletion; `prev_oid` = the expected
    /// prior tip (for divergence detection). Protected refs (per the current `config`
    /// patterns) route to the maintainer-gated `protectedRefUpdate`; everything else is a
    /// member-gated `refUpdate`. Returns the created document id.
    pub async fn write_ref_update(
        &self,
        repo: &RepoRef,
        ref_name: &str,
        new_oid: &[u8],
        prev_oid: Option<&[u8]>,
        force: bool,
    ) -> Result<String> {
        // Injection defense (write-side guard, defense-in-depth with rules::is_update_valid):
        // `refName` is an arbitrary Platform string that never passed `git check-ref-format`,
        // so a control char / newline could inject a spoofed ref-advertisement line into every
        // clone. Reject illegal names before writing.
        if !rules::is_legal_ref_name(ref_name) {
            return Err(Error::Config(format!(
                "illegal ref name {ref_name:?}: must be non-empty, no leading '-', no whitespace/control characters"
            )));
        }
        let (scope, contract) = self.writable(repo).await?;
        let hasher = crate::private::Public;
        let ref_name_hash = hasher.hash(ref_name);

        let configs = self.fetch_config_history(&scope, &contract).await?;
        let protected = rules::matches_protected(ref_name, &current_protected_patterns(&configs));
        let doc_type = if protected {
            DOC_PROTECTED_REF_UPDATE
        } else {
            DOC_REF_UPDATE
        };

        let mut props = scope.props([
            ("refNameHash", FieldValue::bytes32(ref_name_hash)),
            ("refName", FieldValue::text(ref_name)),
            ("newOid", FieldValue::bytes(new_oid.to_vec())),
            ("force", FieldValue::boolean(force)),
        ]);
        if let Some(prev) = prev_oid {
            props.insert("prevOid".into(), FieldValue::bytes(prev.to_vec()));
        }
        self.doc_engine()?
            .create_document(&contract, doc_type, props)
            .await
    }

    /// Enumerate every ref and its resolved [`RefState`].
    ///
    /// Every ref's history comes from [`crate::refs::read_all_ref_updates`] — a keyset scan
    /// over the `refState` index (scoped to the repo: `(repoId, refNameHash, $createdAt)` on
    /// forge-v2), ⌈updates/100⌉ queries per type plus one per ref that fills a page by itself,
    /// with a `prevOid` completeness check — and each ref's combined update history + the
    /// repo's `config` history is folded by [`crate::rules::resolve_ref`].
    ///
    /// Two earlier readers failed in opposite ways. The S0.8 skip-scan (one `limit 1` query
    /// per ref per type, then one history read per ref) cost about four sequential
    /// round-trips per ref ever pushed, deleted ones included: over a minute per `git`
    /// command on the nightly repo. Paging the `refState` index with a `startAfter` cursor
    /// was fast but silently lost rows on protocol 13 (see the `refs` module docs). Paging
    /// the whole `reflog` index was correct but read every update of every ref on every
    /// command, so it is kept only as the fallback the completeness check falls to.
    ///
    /// The ancestry predicate is reflexive-only here (no read-side commit graph):
    /// fast-forward supersession via `prevOid` still resolves, but descend-detection is
    /// deferred to the push-side pipeline that has the object store.
    pub async fn read_refs(&self, repo: &RepoRef) -> Result<Vec<(String, RefState)>> {
        let (scope, contract) = self.readable(repo).await?;
        let configs = self.fetch_config_history(&scope, &contract).await?;
        let by_hash = crate::refs::read_all_ref_updates(self.client, &contract, &scope).await?;

        let mut out = Vec::with_capacity(by_hash.len());
        for (hash, updates) in &by_hash {
            let hash_hex = hex::encode(hash);
            // Shared naming rule (forge-web applies the same one) — never the raw newest
            // update, which may carry a name that does not hash to this key.
            let Some(ref_name) = rules::display_ref_name(updates, &hash_hex).map(str::to_owned)
            else {
                continue;
            };
            let state = rules::resolve_ref(updates, &configs, &hash_hex, |a, b| a == b);
            out.push((ref_name, state));
        }
        Ok(out)
    }

    /// The protected-ref globs in force now (the newest `config`).
    pub async fn protected_patterns(&self, repo: &RepoRef) -> Result<Vec<String>> {
        let (scope, contract) = self.readable(repo).await?;
        let configs = self.fetch_config_history(&scope, &contract).await?;
        Ok(current_protected_patterns(&configs))
    }

    /// The newest `config` document in `scope`, if any.
    async fn newest_config(
        &self,
        scope: &DocScope,
        contract: &LoadedContract,
    ) -> Result<Option<FetchedDocument>> {
        Ok(self
            .client
            .query_documents(
                contract,
                DOC_CONFIG,
                &scope.filters([]),
                &[QueryOrder::desc("$createdAt")],
                1,
                None,
            )
            .await?
            .into_iter()
            .next())
    }

    /// The repo's current default branch from the newest `config` (e.g. `main`) — the
    /// branch `git-remote-dash` reports as the `HEAD` symref. `None` when there is none.
    pub async fn read_default_branch(&self, repo: &RepoRef) -> Result<Option<String>> {
        let (scope, contract) = self.readable(repo).await?;
        Ok(self
            .newest_config(&scope, &contract)
            .await?
            .and_then(|d| d.field_str("defaultBranch")))
    }

    /// Append a `config` carrying `backend_mode`, optionally replacing the advertised read
    /// `uris` (the public read bases of a storage policy — `dg storage advertise`; `None`
    /// keeps the newest config's). Default branch, protected patterns and the archived
    /// flag carry over (config is append-only, newest wins). Maintainer-gated.
    pub async fn set_backend(
        &self,
        repo: &RepoRef,
        backend_mode: u8,
        new_uris: Option<&[String]>,
    ) -> Result<String> {
        if let Some(list) = new_uris {
            if !BACKEND_URIS_V2.fits(list) {
                return Err(Error::Config(format!(
                    "config.backend.uris holds at most {} URLs of at most {} bytes each",
                    BACKEND_URIS_V2.max_items.unwrap_or_default(),
                    BACKEND_URIS_V2.max_item_len.unwrap_or_default()
                )));
            }
        }
        let (scope, contract) = self.writable(repo).await?;
        let newest = self.newest_config(&scope, &contract).await?;
        let default_branch = newest
            .as_ref()
            .and_then(|d| d.field_str("defaultBranch"))
            .unwrap_or_else(|| "main".to_string());
        let patterns = newest
            .as_ref()
            .map(|d| scope::doc_text_list(d, "protectedPatterns"))
            .unwrap_or_default();
        let archived = newest.as_ref().is_some_and(|d| d.field_bool("archived"));
        let uris = match new_uris {
            Some(list) => list.to_vec(),
            None => newest.as_ref().map(scope::backend_uris).unwrap_or_default(),
        };

        let mut backend = BTreeMap::new();
        backend.insert(
            "mode".to_string(),
            FieldValue::integer(u64::from(backend_mode)),
        );
        if !uris.is_empty() {
            backend.insert("uris".to_string(), FieldValue::text_list(uris));
        }
        let mut props = scope.props([
            ("defaultBranch", FieldValue::text(default_branch)),
            ("backend", FieldValue::Object(backend)),
            ("archived", FieldValue::boolean(archived)),
        ]);
        if !patterns.is_empty() {
            props.insert("protectedPatterns".into(), FieldValue::text_list(patterns));
        }
        self.doc_engine()?
            .create_document(&contract, DOC_CONFIG, props)
            .await
    }

    /// Write a `packManifest` (member-gated). Returns the manifest document id.
    pub async fn write_pack_manifest(
        &self,
        repo: &RepoRef,
        manifest: &PackManifestInput,
    ) -> Result<String> {
        let (scope, contract) = self.writable(repo).await?;
        let mut props = scope.props([
            ("packHash", FieldValue::bytes32(manifest.pack_hash)),
            ("kind", FieldValue::integer(manifest.kind)),
            ("sizeBytes", FieldValue::integer(manifest.size_bytes)),
            ("objectCount", FieldValue::integer(manifest.object_count)),
            ("chunkCount", FieldValue::integer(manifest.chunk_count)),
            ("storage", FieldValue::integer(manifest.storage)),
            (
                "offsetIndexParts",
                FieldValue::integer(manifest.offset_index_parts),
            ),
        ]);
        if !manifest.uris.is_empty() {
            if !MANIFEST_URIS_V2.fits(&manifest.uris) {
                return Err(Error::Config(
                    "packManifest.uris holds at most 8 URIs of at most 300 bytes each".into(),
                ));
            }
            props.insert("uris".into(), FieldValue::text_list(manifest.uris.clone()));
        }
        // `tips` / `supersedes` are packed byteArrays (concatenated fixed-width entries).
        if !manifest.tips.is_empty() {
            props.insert("tips".into(), FieldValue::bytes(manifest.tips.concat()));
        }
        if !manifest.supersedes.is_empty() {
            props.insert(
                "supersedes".into(),
                FieldValue::bytes(manifest.supersedes.concat()),
            );
        }
        self.doc_engine()?
            .create_document(&contract, DOC_PACK_MANIFEST, props)
            .await
    }

    /// Read **every** `packManifest` document of a repo, newest first.
    ///
    /// Completeness is load-bearing for the transport, not just for display: `fetch`
    /// downloads the union of every live kind-0 pack, and each push stores an *incremental*
    /// pack. Drop the oldest manifests — which is what a capped newest-first read does once
    /// a repo passes one page — and the initial import pack, holding the root objects and
    /// the delta bases everything else is built against, falls out of the set.
    pub async fn read_pack_manifests(&self, repo: &RepoRef) -> Result<Vec<PackManifestInfo>> {
        let (scope, contract) = self.readable(repo).await?;
        let docs = self
            .client
            .query_all_documents(
                &contract,
                DOC_PACK_MANIFEST,
                &scope.filters([]),
                &[QueryOrder::desc("$createdAt")],
            )
            .await?;
        docs.iter().map(manifest_info).collect()
    }

    /// Every manifest of `pack_hash` (on v2 each uploader may hold a copy; on v1 the index
    /// is unique, so at most one).
    pub async fn read_pack_copies(
        &self,
        repo: &RepoRef,
        pack_hash: [u8; 32],
    ) -> Result<Vec<PackManifestInfo>> {
        let (scope, contract) = self.readable(repo).await?;
        let docs = self
            .client
            .query_all_documents(
                &contract,
                DOC_PACK_MANIFEST,
                &scope.filters([QueryFilter::eq("packHash", FieldValue::bytes32(pack_hash))]),
                &[],
            )
            .await?;
        docs.iter().map(manifest_info).collect()
    }

    /// Store pack `bytes` as pipelined `chunk` documents, returning the `platform://…`
    /// locator the manifest records.
    pub async fn put_pack(
        &self,
        repo: &RepoRef,
        bytes: &[u8],
        meta: &PackMeta,
    ) -> Result<Vec<Uri>> {
        let (scope, contract) = self.writable(repo).await?;
        let engine = self.doc_engine()?;
        PlatformBackend::new(&engine, &contract, &scope, self.identity.id())
            .put(bytes, meta)
            .await
    }

    /// Store pack `bytes` as `chunk` documents **resumably**: a [`PushJournal`] records the
    /// chunk seqs already confirmed and is checkpointed through `store` after each one, so an
    /// interrupted push resumes by skipping the already-uploaded chunks. Idempotent even
    /// without a journal: a re-broadcast chunk that already landed collides on the unique
    /// chunk index → [`crate::platform::BroadcastOutcome::AlreadyExists`], never a second
    /// charge. Returns the `platform://…` locator the manifest records.
    pub async fn put_pack_resumable(
        &self,
        repo: &RepoRef,
        bytes: &[u8],
        meta: &PackMeta,
        journal: &mut PushJournal,
        store: &(dyn JournalStore + Sync),
    ) -> Result<Vec<Uri>> {
        use crate::backends::platform::{chunk_documents, CHUNK_DOC_TYPE};

        let (scope, contract) = self.writable(repo).await?;
        let engine = self.doc_engine()?;
        let pack_hash = meta.pack_hash_bytes()?;

        // Test affordance, compiled only with `--features test-hooks`: abort after
        // uploading N fresh chunks to simulate a `kill -9` mid-push, so the resume path can
        // be exercised deterministically end-to-end.
        #[cfg(feature = "test-hooks")]
        let kill_after: Option<usize> = std::env::var("DASH_FORGE_KILL_AFTER_CHUNK")
            .ok()
            .and_then(|s| s.parse().ok());
        #[cfg(not(feature = "test-hooks"))]
        let kill_after: Option<usize> = None;
        let mut uploaded_now = 0usize;

        for (seq, props) in chunk_documents(bytes, pack_hash) {
            if journal.has(seq) {
                tracing::debug!(seq, "chunk already journaled; skipping");
                continue;
            }
            let prepared = engine
                .create_landed(&contract, CHUNK_DOC_TYPE, scope.scoped(props))
                .await?;
            journal.record(&WriteIntent::for_prepared(seq, &prepared));
            store.checkpoint(journal)?;

            uploaded_now += 1;
            if kill_after == Some(uploaded_now) {
                return Err(Error::Io(format!(
                    "simulated mid-push interruption after {uploaded_now} chunk(s) \
                     (DASH_FORGE_KILL_AFTER_CHUNK) — journal persisted for resume"
                )));
            }
        }
        Ok(vec![Uri(
            scope.locator(&self.identity.id(), &meta.pack_hash)
        )])
    }

    /// The uploader → current role map the v2 pack reader rule ranks copies by. Empty on
    /// v1 (a v1 pack has exactly one copy).
    pub async fn copy_roles(&self, repo: &RepoRef) -> Result<RoleMap> {
        if repo.is_v1() {
            return Ok(RoleMap::new());
        }
        let members = crate::members::MemberReader::new(self.client)
            .list(repo)
            .await?;
        let oracle = crate::members::oracle(&members);
        Ok(members
            .iter()
            .filter_map(|m| {
                oracle
                    .current_role(&m.identity_id)
                    .map(|r| (m.identity_id.clone(), r))
            })
            .collect())
    }

    /// Fetch a stored artifact's bytes with the user's read configuration (storage.toml
    /// gateways and S3 profiles). See [`Self::fetch_artifact_from`].
    pub async fn fetch_artifact(
        &self,
        repo: &RepoRef,
        manifest: &PackManifestInfo,
        reader: &PackReader,
    ) -> Result<Vec<u8>> {
        let contract = self.repo_contract(repo).await?;
        self.fetch_artifact_from(repo, &contract, manifest, reader)
            .await
    }

    /// Fetch one manifest's artifact, SHA-256-verified against it.
    ///
    /// External copies go first: every recorded URI, raced with `reader`'s IPFS gateway
    /// list (cheap, and needs no Platform queries). The Platform `chunk` copy is the last
    /// resort — used when no external copy verifies, or when the manifest records none. On
    /// v2 that copy is the chunks *this manifest's uploader* wrote.
    pub async fn fetch_artifact_from(
        &self,
        repo: &RepoRef,
        contract: &LoadedContract,
        manifest: &PackManifestInfo,
        reader: &PackReader,
    ) -> Result<Vec<u8>> {
        let expected = hex::encode(manifest.pack_hash);
        let scope = repo.scope()?;
        let own = Uri(scope.locator(&manifest.owner_id, &expected));
        // Platform copies to read, in order: chunks another repo's scope holds (a fork's
        // manifest names its parent's this way), then this manifest's own chunks.
        // Only locators of THIS pack: a manifest naming another pack's chunks would have
        // readers download them in full before the hash check refused them.
        let mut platform: Vec<Uri> = manifest
            .uris
            .iter()
            .map(|u| Uri(u.clone()))
            .filter(|u| {
                *u != own
                    && crate::backends::PlatformLocator::parse(u)
                        .is_ok_and(|l| l.pack_hash == manifest.pack_hash)
            })
            .collect();
        if manifest.storage == 0 {
            platform.push(own);
        }
        // Every body is capped at the manifest's size (0 = unknown on very old manifests).
        let size = (manifest.size_bytes > 0).then_some(manifest.size_bytes);
        if reader.has_candidates(&manifest.uris) {
            // With chunks to fall back on, the external copies get a size-scaled budget
            // after which no new candidate starts — dead gateways must not cost minutes per
            // pack before the on-chain read, but a big pack streaming from a healthy mirror
            // is not abandoned mid-transfer.
            let budget =
                (!platform.is_empty()).then(|| crate::storage::read::external_budget(size));
            match reader
                .fetch_verified(&manifest.uris, &expected, size, budget)
                .await
            {
                Ok(bytes) => return Ok(bytes),
                Err(e) if platform.is_empty() => return Err(e),
                Err(e) => tracing::info!(
                    pack = %expected,
                    error = %e,
                    "no external copy verified; reading Platform chunks"
                ),
            }
        } else if platform.is_empty() {
            return Err(Error::Io(format!(
                "artifact {expected} is stored externally but its manifest records no URI this \
                 client can read ({:?})",
                manifest.uris
            )));
        }
        let engine = self.doc_engine()?;
        let backend = PlatformBackend::new(&engine, contract, &scope, self.identity.id());
        let mut last = Error::NotFound;
        for locator in &platform {
            match backend.get(locator, None).await {
                Ok(bytes) if hex::encode(crate::backends::sha256(&bytes)) == expected => {
                    return Ok(bytes)
                }
                Ok(_) => last = Error::Integrity,
                Err(e) => {
                    tracing::info!(%locator, error = %e, "Platform copy unreadable");
                    last = e;
                }
            }
        }
        Err(last)
    }

    /// Read `pack_hash` from the best copy that verifies (forge-v2 §4 reader rule):
    /// `copies` are its manifests, tried maintainers' first, then writers', then former
    /// members', each by `($createdAt, $id)`. Returns the bytes and the copy they came
    /// from, or the last error when no copy verifies.
    pub async fn fetch_best_copy<'m>(
        &self,
        repo: &RepoRef,
        contract: &LoadedContract,
        copies: &[&'m PackManifestInfo],
        roles: &RoleMap,
        reader: &PackReader,
    ) -> Result<(Vec<u8>, &'m PackManifestInfo)> {
        let mut last = Error::NotFound;
        for m in order_copies(copies, roles) {
            match self.fetch_artifact_from(repo, contract, m, reader).await {
                Ok(bytes) => return Ok((bytes, m)),
                Err(e) => {
                    tracing::info!(
                        pack = %hex::encode(m.pack_hash),
                        uploader = %m.owner_id,
                        error = %e,
                        "pack copy did not verify; trying the next copy"
                    );
                    last = e;
                }
            }
        }
        Err(last)
    }

    /// Consolidate a repo's live packs into **one** optimized pack and publish it with a
    /// `supersedes` list. **Deletes nothing**: on forge-v2 chunks and manifests are
    /// permanent, so the superseded packs stay readable as the fallback the reader rule
    /// keeps (a hash proves a pack's bytes, not that it holds everything it replaces).
    ///
    /// Flow: resolve refs → reachable tips; fetch every git pack (best copy; superseded
    /// ones too — a hash does not prove a consolidation is complete); rebuild one
    /// self-contained pack over the tips ([`crate::pack::repack_from_packs`]); upload it to
    /// `target`; write its manifest (`supersedes` the packs not already superseded, the
    /// resolved tips); publish the consolidated browse index (best-effort).
    pub async fn repack(&self, repo: &RepoRef, target: RepackTarget<'_>) -> Result<RepackReport> {
        let (_, contract) = self.writable(repo).await?;
        let caller = self.identity.id();

        let refs = self.read_refs(repo).await?;
        let tips = resolved_tip_oids(&refs);
        if tips.is_empty() {
            return Err(Error::Config(
                "repack: repo has no resolved refs — nothing to consolidate".into(),
            ));
        }
        let manifests = self.read_pack_manifests(repo).await?;
        let git = git_pack_manifests(&manifests);
        if git.is_empty() {
            return Err(Error::Config("repack: no git packs to consolidate".into()));
        }

        let roles = self.copy_roles(repo).await?;
        let reader = PackReader::from_user_config();
        let mut pack_blobs = Vec::new();
        for (hash, copies) in group_by_hash(&git) {
            let (bytes, _) = self
                .fetch_best_copy(repo, &contract, &copies, &roles, &reader)
                .await
                .map_err(|e| {
                    Error::Io(format!(
                        "repack: pack {} is unreadable: {e}",
                        hex::encode(hash)
                    ))
                })?;
            pack_blobs.push(bytes);
        }
        let tip_refs: Vec<&str> = tips.iter().map(String::as_str).collect();
        let consolidated = crate::pack::repack_from_packs(&pack_blobs, &tip_refs)?;
        let new_bytes = consolidated.bytes;
        let new_meta = PackMeta::for_bytes(&new_bytes);
        let new_pack_hash = new_meta.pack_hash_bytes()?;
        let object_count = consolidated.parsed.object_count() as u64;

        // Already a single optimal pack: nothing to gain, and nothing to write.
        if git.iter().any(|m| m.pack_hash == new_pack_hash) {
            return Err(Error::Config(
                "repack: the repo is already a single consolidated pack (nothing to do)".into(),
            ));
        }

        let balance_start = self.client.get_balance(&caller).await.unwrap_or(0);
        let stored = self
            .store_consolidated(repo, &new_bytes, &new_meta, target)
            .await?;
        let new_uris = stored.uris.clone();
        let (supersedes, new_manifest_id) = self
            .write_consolidated_manifest(
                repo,
                &manifests,
                &ConsolidatedPack {
                    pack_hash: new_pack_hash,
                    size_bytes: new_bytes.len() as u64,
                    object_count,
                    chunk_count: stored.chunk_count,
                    storage: stored.storage,
                    uris: stored.uris,
                    tips: &tips,
                },
            )
            .await?;
        let locator_manifest_id = self
            .publish_locator_best_effort(repo, &roles, &consolidated.parsed, new_pack_hash, target)
            .await;
        let balance_end = self
            .client
            .get_balance(&caller)
            .await
            .unwrap_or(balance_start);

        let superseded_bytes = supersedes
            .iter()
            .filter_map(|h| manifests.iter().find(|m| m.pack_hash == *h))
            .map(|m| m.size_bytes)
            .sum();
        Ok(RepackReport {
            new_pack_hash,
            new_manifest_id,
            locator_manifest_id,
            new_pack_bytes: new_bytes.len() as u64,
            object_count,
            new_uris,
            superseded_count: supersedes.len(),
            superseded_bytes,
            cost_credits: balance_start.saturating_sub(balance_end),
        })
    }

    /// Store a repack's consolidated pack on `target`, returning the manifest fields.
    async fn store_consolidated(
        &self,
        repo: &RepoRef,
        bytes: &[u8],
        meta: &PackMeta,
        target: RepackTarget<'_>,
    ) -> Result<StoredArtifact> {
        let chunk_count = crate::pack::split(bytes).len() as u64;
        Ok(match target {
            RepackTarget::Platform => StoredArtifact {
                storage: 0,
                chunk_count,
                uris: uri_strings(self.put_pack(repo, bytes, meta).await?),
            },
            RepackTarget::External(backend) => StoredArtifact {
                storage: 1,
                chunk_count: 0,
                uris: uri_strings(backend.put(bytes, meta).await?),
            },
            RepackTarget::Replicated { targets, required } => {
                let rep = crate::storage::replicate(targets, bytes, meta, required)
                    .await
                    .map_err(|e| Error::Io(e.to_string()))?;
                StoredArtifact::from_replication(&rep, bytes)?
            }
        })
    }

    /// Write the `packManifest` for a repack's consolidated pack, returning the
    /// `supersedes` list it recorded and the new document id.
    async fn write_consolidated_manifest(
        &self,
        repo: &RepoRef,
        manifests: &[PackManifestInfo],
        pack: &ConsolidatedPack<'_>,
    ) -> Result<(Vec<[u8; 32]>, String)> {
        let supersedes = repack_supersedes(manifests, pack.pack_hash);
        let tip_oids: Vec<Vec<u8>> = pack
            .tips
            .iter()
            .filter_map(|t| hex::decode(t).ok())
            .take(16)
            .collect();
        let id = self
            .write_pack_manifest(
                repo,
                &PackManifestInput {
                    pack_hash: pack.pack_hash,
                    kind: u64::from(crate::pack::KIND_GIT_PACK),
                    size_bytes: pack.size_bytes,
                    object_count: pack.object_count,
                    chunk_count: pack.chunk_count,
                    storage: pack.storage,
                    // 0 = no separate `manifestPart` offset-index doc written. The browse
                    // plane's index is the `objectLocator` published alongside.
                    offset_index_parts: 0,
                    uris: pack.uris.clone(),
                    supersedes: supersedes.clone(),
                    tips: tip_oids,
                },
            )
            .await?;
        Ok((supersedes, id))
    }

    /// Re-upload each live pack to `target` and announce the new location (`dg reseed`).
    ///
    /// Every pack is read from its best verifying copy and stored on `target`. On forge-v2
    /// each uploader may record its own manifest for a pack (the unique index includes
    /// `$ownerId`), so the new location is announced by writing the caller's own copy —
    /// `storage` 1, the new URIs — when the caller has none yet for that pack; readers
    /// verify it by hash like any other copy. Packs the caller already holds a manifest for
    /// are uploaded but not re-announced (a manifest is immutable).
    pub async fn reseed(&self, repo: &RepoRef, target: &dyn PackBackend) -> Result<ReseedReport> {
        let (_, contract) = self.writable(repo).await?;
        let me = self.identity.id();
        let manifests = self.read_pack_manifests(repo).await?;
        let git = git_pack_manifests(&manifests);
        let roles = self.copy_roles(repo).await?;
        let reader = PackReader::from_user_config();
        let mut report = ReseedReport::default();
        for (hash, copies) in group_by_hash(&git) {
            let (bytes, best) = match self
                .fetch_best_copy(repo, &contract, &copies, &roles, &reader)
                .await
            {
                Ok(got) => got,
                Err(e) => {
                    // One unreadable pack must not stop the others from being reseeded.
                    tracing::warn!(pack = %hex::encode(hash), error = %e, "no readable copy; skipping");
                    report.unreadable.push(hash);
                    continue;
                }
            };
            let meta = PackMeta::for_bytes(&bytes);
            let uris = uri_strings(target.put(&bytes, &meta).await?);
            let announced = if copies.iter().any(|m| m.owner_id == me) {
                false
            } else {
                self.write_pack_manifest(
                    repo,
                    &PackManifestInput {
                        pack_hash: hash,
                        kind: best.kind,
                        size_bytes: best.size_bytes,
                        object_count: best.object_count,
                        chunk_count: 0,
                        storage: 1,
                        offset_index_parts: 0,
                        uris: uris.clone(),
                        supersedes: best.supersedes.clone(),
                        tips: Vec::new(),
                    },
                )
                .await?;
                true
            };
            report.reseeded.push(Reseeded {
                pack_hash: hash,
                uris,
                announced,
            });
        }
        Ok(report)
    }

    /// Restore lost external copies from a LOCAL clone (`dg reseed --from-local`).
    ///
    /// For every git pack (or just `only`), the pack's exact bytes are looked up in
    /// `git_dir` ([`crate::storage::local::find_local_pack`]: the helper's kept copy, or a
    /// fetched `objects/pack/*.pack`), SHA-256-verified against the manifest, and stored
    /// on `targets` (≥ `required` must confirm). Storage keys are content-addressed — S3
    /// `…/packs/<sha256>.pack`, the IPFS CID — so re-uploading through the SAME profile the
    /// pack was pushed with recreates the very URI the immutable manifest already records,
    /// and readers find it again.
    ///
    /// Packs with no local copy are reported in `missing`; packs whose recorded copies
    /// still verify are skipped unless `force`. Writes nothing to Platform.
    pub async fn reseed_from_local(
        &self,
        repo: &RepoRef,
        git_dir: &std::path::Path,
        targets: &[&dyn StorageTarget],
        required: usize,
        only: Option<[u8; 32]>,
        force: bool,
    ) -> Result<LocalReseedReport> {
        let manifests = self.read_pack_manifests(repo).await?;
        let live: Vec<PackManifestInfo> = git_pack_manifests(&manifests)
            .into_iter()
            .filter(|m| only.is_none_or(|h| h == m.pack_hash))
            .collect();
        if let (Some(h), true) = (only, live.is_empty()) {
            return Err(Error::Config(format!(
                "no git pack {} in this repo's manifests",
                hex::encode(h)
            )));
        }
        let contract = self.repo_contract(repo).await?;
        let reader = PackReader::from_user_config();
        let mut report = LocalReseedReport::default();
        for m in &live {
            if !force
                && self
                    .fetch_artifact_from(repo, &contract, m, &reader)
                    .await
                    .is_ok()
            {
                report.healthy.push(m.pack_hash);
                continue;
            }
            let Some(bytes) = crate::storage::local::find_local_pack(git_dir, m.pack_hash)? else {
                report.missing.push(m.pack_hash);
                continue;
            };
            let meta = PackMeta::for_bytes(&bytes);
            let rep = crate::storage::replicate(targets, &bytes, &meta, required)
                .await
                .map_err(|e| Error::Io(format!("pack {}: {e}", meta.pack_hash)))?;
            let uris = rep.uris();
            let restored = uris.iter().any(|u| m.uris.contains(u));
            report.restored.push(LocalReseed {
                pack_hash: m.pack_hash,
                uris,
                restored_recorded_uri: restored,
            });
        }
        Ok(report)
    }

    /// Publish the consolidated browse index for a repack, reporting failure as `None`
    /// rather than unwinding it: the repack has already landed and been paid for.
    async fn publish_locator_best_effort(
        &self,
        repo: &RepoRef,
        roles: &RoleMap,
        pack: &crate::pack::ParsedPack,
        pack_hash: [u8; 32],
        target: RepackTarget<'_>,
    ) -> Option<String> {
        match self
            .publish_locator(repo, roles, pack, pack_hash, target)
            .await
        {
            Ok(id) => Some(id),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "repack consolidated the packs but could not publish the objectLocator; \
                     browse stays on the fallback path until the next repack"
                );
                None
            }
        }
    }

    /// Build and publish an `objectLocator` (kind 1) over the consolidated repack pack,
    /// superseding every prior locator fragment.
    ///
    /// `pack_ref` is read from a FRESH manifest list: the consolidated pack is appended to
    /// the pack space (superseded packs keep their positions), after any pack a concurrent
    /// push stored first.
    async fn publish_locator(
        &self,
        repo: &RepoRef,
        roles: &RoleMap,
        pack: &crate::pack::ParsedPack,
        pack_hash: [u8; 32],
        target: RepackTarget<'_>,
    ) -> Result<String> {
        let manifests = self.read_pack_manifests(repo).await?;
        let space = locator_pack_space(&manifests, roles, None);
        let hash = hex::encode(pack_hash);
        let idx = space
            .iter()
            .position(|p| p.pack_hash == hash)
            .ok_or_else(|| {
                Error::Config("repack: the consolidated pack is not in the pack set".into())
            })?;
        let pack_ref = u16::try_from(idx).map_err(|_| {
            Error::Config(format!(
                "repack: the pack set has {} packs — past the locator's 16-bit packRef",
                space.len()
            ))
        })?;
        let locator = crate::pack::ObjectLocator::build(pack, pack_ref)?;
        let supersedes = live_locator_manifests(&manifests)
            .iter()
            .map(|m| m.pack_hash)
            .collect();
        self.store_locator(repo, &locator, supersedes, target).await
    }

    /// Publish the browse-index fragment for a pack that a push just stored.
    ///
    /// The index is published in FRAGMENTS, one per stored pack, rather than as a single
    /// whole-repo locator rewritten on every push: a fragment costs 36 bytes per object the
    /// push actually added. Readers merge the live fragments
    /// ([`crate::pack::ObjectLocator::merge`]). Once the live fragment count would exceed
    /// [`MAX_LOCATOR_FRAGMENTS`], this folds them into ONE locator superseding the lot.
    ///
    /// Returns what it did, including the reasons it declined; a push has already landed by
    /// the time this runs, so nothing here is fatal to it.
    pub async fn publish_push_locator(
        &self,
        repo: &RepoRef,
        pack: &crate::pack::ParsedPack,
        pack_hash: [u8; 32],
        target: RepackTarget<'_>,
    ) -> Result<PushIndexOutcome> {
        let manifests = self.read_pack_manifests(repo).await?;
        let roles = self.copy_roles(repo).await?;
        let space_len = locator_pack_space(&manifests, &roles, None).len();
        let (pack_ref, live_locators) = match plan_push_index(&manifests, &roles, pack_hash) {
            PushIndexPlan::Skip(why) => return Ok(PushIndexOutcome::Skipped(why)),
            PushIndexPlan::Publish {
                pack_ref,
                fold: false,
                ..
            } => {
                let fragment = crate::pack::ObjectLocator::build(pack, pack_ref)?;
                let manifest_id = self
                    .store_locator(repo, &fragment, Vec::new(), target)
                    .await?;
                return Ok(PushIndexOutcome::Fragment {
                    manifest_id,
                    pack_ref,
                });
            }
            PushIndexPlan::Publish {
                pack_ref,
                live_locators,
                fold: true,
            } => (pack_ref, live_locators),
        };

        // Fold. Oldest-first for a stable row order; rows are keyed by `(oid, packRef)`.
        let contract = self.repo_contract(repo).await?;
        let reader = PackReader::from_user_config();
        let mut parts = Vec::with_capacity(live_locators.len() + 1);
        for m in live_locators.iter().rev() {
            let bytes = self
                .fetch_artifact_from(repo, &contract, m, &reader)
                .await?;
            parts.push(crate::pack::ObjectLocator::parse(&bytes)?);
        }
        parts.push(crate::pack::ObjectLocator::build(pack, pack_ref)?);
        let folded = crate::pack::ObjectLocator::merge(&parts.iter().collect::<Vec<_>>());
        // A row naming a pack past the end of the live space means one fragment was built
        // over a different space — publish nothing rather than supersede the parts with an
        // index that addresses packs the reader cannot resolve.
        if folded
            .max_pack_ref()
            .is_some_and(|r| usize::from(r) >= space_len)
        {
            return Ok(PushIndexOutcome::Skipped(
                "a published index fragment addresses a pack outside the pack set — \
                 run `dg repack` to rebuild the index"
                    .into(),
            ));
        }
        let supersedes = live_locators.iter().map(|m| m.pack_hash).collect();
        let manifest_id = self
            .store_locator(repo, &folded, supersedes, target)
            .await?;
        Ok(PushIndexOutcome::Consolidated {
            manifest_id,
            folded: live_locators.len(),
        })
    }

    /// Upload a locator artifact and record its `packManifest` (kind 1).
    async fn store_locator(
        &self,
        repo: &RepoRef,
        locator: &crate::pack::ObjectLocator,
        supersedes: Vec<[u8; 32]>,
        target: RepackTarget<'_>,
    ) -> Result<String> {
        let bytes = locator.as_bytes().to_vec();
        let meta = PackMeta::for_bytes(&bytes);
        let pack_hash = meta.pack_hash_bytes()?;
        let stored = match target {
            RepackTarget::Replicated { targets, required } => {
                let rep = crate::storage::replicate(targets, &bytes, &meta, required)
                    .await
                    .map_err(|e| Error::Io(format!("browse index: {e}")))?;
                StoredArtifact::from_replication(&rep, &bytes)?
            }
            other => self.store_consolidated(repo, &bytes, &meta, other).await?,
        };
        self.write_pack_manifest(
            repo,
            &PackManifestInput {
                pack_hash,
                kind: u64::from(crate::pack::KIND_OBJECT_LOCATOR),
                size_bytes: bytes.len() as u64,
                object_count: locator.object_count() as u64,
                chunk_count: stored.chunk_count,
                storage: stored.storage,
                // No separate `manifestPart` offset-index doc is written for the locator
                // itself; never claim a part that was not stored.
                offset_index_parts: 0,
                uris: stored.uris,
                supersedes,
                tips: Vec::new(),
            },
        )
        .await
    }

    // --- internal read helpers ---

    /// The repo's **complete** `config` history (append-only, non-deletable), as
    /// [`ConfigDoc`]s ordered by `$createdAt`.
    ///
    /// Paged to exhaustion. `config_as_of` treats "no config in force at time T" as
    /// UNPROTECTED, so a truncated history does not merely go stale — it silently
    /// re-admits plain `refUpdate`s on protected refs that the rules layer had correctly
    /// rendered inert. forge-web reads the same timeline, and the two clients must fold the
    /// same input.
    async fn fetch_config_history(
        &self,
        scope: &DocScope,
        contract: &LoadedContract,
    ) -> Result<Vec<ConfigDoc>> {
        let docs = self
            .client
            .query_all_documents(
                contract,
                DOC_CONFIG,
                &scope.filters([]),
                &[QueryOrder::asc("$createdAt")],
            )
            .await?;
        Ok(docs.iter().map(config_doc).collect())
    }
}

/// Every tip (hex `newOid`) that a **valid** update of `ref_name` in `repo` ever set: updates
/// that pass [`rules::is_update_valid`] (legal name that hashes to its key, protected-ref
/// routing as of each update's time), read with no identity. What a verifier checks a pushed
/// oid against: "a valid update set this ref to it", which holds even after later pushes,
/// unlike "it is the current tip".
pub async fn read_valid_tips(
    client: &PlatformClient,
    repo: &RepoRef,
    ref_name: &str,
) -> Result<BTreeSet<String>> {
    repo.require_readable()?;
    let scope = repo.scope()?;
    let contract = client.fetch_contract(&scope.contract_id).await?;
    let configs: Vec<ConfigDoc> = client
        .query_all_documents(
            &contract,
            DOC_CONFIG,
            &scope.filters([]),
            &[QueryOrder::asc("$createdAt")],
        )
        .await?
        .iter()
        .map(config_doc)
        .collect();
    let hash = crate::backends::sha256(ref_name.as_bytes());
    let updates = crate::refs::read_ref_history(client, &contract, &scope, hash).await?;
    Ok(updates
        .iter()
        .filter(|u| rules::is_update_valid(u, &configs))
        .map(|u| u.new_oid.clone())
        .collect())
}

/// A `config` document flattened to what protection resolution needs.
pub fn config_doc(d: &FetchedDocument) -> ConfigDoc {
    ConfigDoc {
        id: d.id.clone(),
        created_at: d.created_at.unwrap_or(0),
        protected_patterns: scope::doc_text_list(d, "protectedPatterns"),
    }
}

/// The `String`s of a list of [`Uri`]s.
fn uri_strings(uris: Vec<Uri>) -> Vec<String> {
    uris.into_iter().map(|u| u.0).collect()
}

/// Group manifests by pack hash (every copy of one pack together), in hash order.
pub fn group_by_hash(manifests: &[PackManifestInfo]) -> Vec<([u8; 32], Vec<&PackManifestInfo>)> {
    let mut groups: BTreeMap<[u8; 32], Vec<&PackManifestInfo>> = BTreeMap::new();
    for m in manifests {
        groups.entry(m.pack_hash).or_default().push(m);
    }
    groups.into_iter().collect()
}

/// `copies` of one pack in the order the forge-v2 reader rule tries them
/// ([`crate::rules::v2::order_pack_copies`]): uploaders who are currently maintainers,
/// then writers, then anyone else, each by `($createdAt, $id)`.
pub fn order_copies<'m>(
    copies: &[&'m PackManifestInfo],
    roles: &RoleMap,
) -> Vec<&'m PackManifestInfo> {
    let as_rule: Vec<PackCopy> = copies
        .iter()
        .map(|m| PackCopy {
            id: m.document_id.clone(),
            pack_hash: hex::encode(m.pack_hash),
            owner_role: roles.get(&m.owner_id).copied(),
            created_at: m.created_at,
            verified: true,
            supersedes: Vec::new(),
        })
        .collect();
    crate::rules::v2::order_pack_copies(&as_rule)
        .into_iter()
        .filter_map(|c| copies.iter().find(|m| m.document_id == c.id).copied())
        .collect()
}

/// Collect the distinct hex OIDs a repo's resolved refs point at — the reachable tip set
/// repack plants as refs so GC keeps exactly the reachable graph. Includes every head of a
/// diverged ref (none of the racing commits may be dropped).
fn resolved_tip_oids(refs: &[(String, RefState)]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for (_, state) in refs {
        match state {
            RefState::Resolved { oid, .. } => {
                if seen.insert(oid.clone()) {
                    out.push(oid.clone());
                }
            }
            RefState::Diverged { heads } => {
                for h in heads {
                    if seen.insert(h.oid.clone()) {
                        out.push(h.oid.clone());
                    }
                }
            }
            RefState::Unborn => {}
        }
    }
    out
}

/// Pack hashes a repack's consolidated manifest lists in `supersedes`: the git packs no
/// manifest already names in `supersedes`, except the new one, in pack-space order.
///
/// `supersedes` is a packed byteArray capped at 1024 bytes — **32 hashes**. A pack an
/// earlier repack superseded stays superseded (the manifest that says so is permanent), so
/// it needs no slot here. Past 32 the list is truncated and the caller warned: the repack
/// still consolidates, and a pack it could not name is only read whole a little longer.
fn repack_supersedes(manifests: &[PackManifestInfo], new_pack_hash: [u8; 32]) -> Vec<[u8; 32]> {
    /// `packManifest.supersedes` is a byteArray of at most 1024 bytes.
    const MAX_SUPERSEDES: usize = 1024 / 32;
    let claimed: BTreeSet<[u8; 32]> = manifests
        .iter()
        .flat_map(|m| m.supersedes.iter().copied())
        .collect();
    let new_hash = hex::encode(new_pack_hash);
    let mut out: Vec<[u8; 32]> = locator_pack_space(manifests, &RoleMap::new(), None)
        .iter()
        .filter(|p| p.pack_hash != new_hash)
        .filter_map(|p| hash32(&p.pack_hash))
        .filter(|h| !claimed.contains(h))
        .collect();
    if out.len() > MAX_SUPERSEDES {
        tracing::warn!(
            wanted = out.len(),
            kept = MAX_SUPERSEDES,
            "more packs than `supersedes` can name; the rest stay read whole until a later \
             repack names them"
        );
        out.truncate(MAX_SUPERSEDES);
    }
    out
}

/// A 64-hex pack hash as bytes.
fn hash32(hex_hash: &str) -> Option<[u8; 32]> {
    hex::decode(hex_hash).ok()?.try_into().ok()
}

/// What [`RepoService::publish_push_locator`] should do, decided from the manifest list
/// alone. Separated from the transport so the decision — which is all the interesting
/// behavior — is testable without a platform connection.
#[derive(Debug, Clone)]
enum PushIndexPlan {
    /// Publish an index over the pushed pack at `pack_ref`. When `fold`, also absorb
    /// `live_locators` and supersede them.
    Publish {
        pack_ref: u16,
        live_locators: Vec<PackManifestInfo>,
        fold: bool,
    },
    /// Publish nothing; the string says why, in terms a user can act on.
    Skip(String),
}

/// Decide how a push should extend the browse index.
///
/// `manifests` must already include the pack just written. Three ways this declines, each
/// meaning the index would otherwise start addressing the wrong bytes:
///
/// * the pushed pack is not in the git pack space (another copy re-labelled its kind);
/// * the pack space outgrew the locator's 16-bit `packRef`;
/// * a live fragment indexes a pack space that is not a prefix of the current one. The
///   space only grows at the end (a pack keeps its first-upload position, superseded or
///   not), so this holds unless a pack's kind changed under a later, higher-ranked copy.
fn plan_push_index(
    manifests: &[PackManifestInfo],
    roles: &RoleMap,
    pack_hash: [u8; 32],
) -> PushIndexPlan {
    let space = locator_pack_space(manifests, roles, None);
    let hash = hex::encode(pack_hash);
    let Some(idx) = space.iter().position(|p| p.pack_hash == hash) else {
        return PushIndexPlan::Skip(
            "the pushed pack is not in the git pack space — its index would address the \
             wrong bytes"
                .into(),
        );
    };
    let Ok(pack_ref) = u16::try_from(idx) else {
        return PushIndexPlan::Skip(format!(
            "the pack set has {} packs — past the locator's 16-bit packRef; \
             run `dg maint repack` to consolidate",
            space.len()
        ));
    };

    let live_locators = live_locator_manifests(manifests);
    for m in &live_locators {
        let as_of = locator_pack_space(
            manifests,
            roles,
            Some(&CopyKey {
                created_at: m.created_at,
                id: m.document_id.clone(),
            }),
        );
        if as_of.len() > space.len()
            || as_of
                .iter()
                .zip(&space)
                .any(|(a, b)| a.pack_hash != b.pack_hash)
        {
            return PushIndexPlan::Skip(
                "a published index fragment no longer matches the pack set \
                 (a repack landed concurrently) — run `dg maint repack` to rebuild it"
                    .into(),
            );
        }
    }

    let fold = live_locators.len() >= MAX_LOCATOR_FRAGMENTS;
    PushIndexPlan::Publish {
        pack_ref,
        live_locators,
        fold,
    }
}

/// The repository's pack list (`FORGE_RULES_V2::v2_pack_list`, forge-v2.md §4) over its
/// manifests: every pack once, however many uploaders hold a copy, with its `packRef` among
/// the packs of its kind. `roles` ranks the copies (empty on v1, where each pack has one).
/// Copies are listed unchecked (`verified: None`), so no pack counts as superseded here;
/// supersession only changes which packs a reader fetches whole, never a position.
pub fn pack_list(
    manifests: &[PackManifestInfo],
    roles: &RoleMap,
    as_of: Option<&CopyKey>,
) -> Vec<V2Pack> {
    let rows: Vec<PackCopyRow> = manifests
        .iter()
        .map(|m| PackCopyRow {
            id: m.document_id.clone(),
            pack_hash: hex::encode(m.pack_hash),
            kind: m.kind,
            created_at: m.created_at,
            owner_role: roles.get(&m.owner_id).copied(),
            size_bytes: m.size_bytes,
            object_count: m.object_count,
            chunk_count: m.chunk_count,
            supersedes: m.supersedes.iter().map(hex::encode).collect(),
            verified: None,
        })
        .collect();
    crate::rules::v2::v2_pack_list(&rows, as_of)
}

/// The space a locator's `packRef` indexes: the git (kind-0) packs of [`pack_list`], in
/// `packRef` order. `as_of` bounds it to what existed when an older locator was built.
/// Shared with forge-web (`v2PackList`) through the `v2_pack_list__*` vectors.
pub fn locator_pack_space(
    manifests: &[PackManifestInfo],
    roles: &RoleMap,
    as_of: Option<&CopyKey>,
) -> Vec<V2Pack> {
    pack_list(manifests, roles, as_of)
        .into_iter()
        .filter(|p| p.kind == u64::from(crate::pack::KIND_GIT_PACK))
        .collect()
}

/// Decode a `packManifest` document.
fn manifest_info(d: &FetchedDocument) -> Result<PackManifestInfo> {
    let pack_hash = d
        .field_bytes32("packHash")
        .ok_or_else(|| Error::Platform("packManifest missing packHash".into()))?;
    let uris = scope::doc_text_list(d, "uris");
    // `supersedes` is a packed byteArray of concatenated 32-byte packHashes.
    let supersedes = d
        .field_bytes("supersedes")
        .map(|raw| {
            raw.as_chunks::<32>()
                .0
                .iter()
                .map(|c| {
                    let mut h = [0u8; 32];
                    h.copy_from_slice(c);
                    h
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(PackManifestInfo {
        document_id: d.id.clone(),
        created_at: d.created_at.unwrap_or_default(),
        owner_id: d.owner_id.clone(),
        pack_hash,
        kind: d.field_u64("kind").unwrap_or_default(),
        size_bytes: d.field_u64("sizeBytes").unwrap_or_default(),
        object_count: d.field_u64("objectCount").unwrap_or_default(),
        chunk_count: d.field_u64("chunkCount").unwrap_or_default(),
        storage: d.field_u64("storage").unwrap_or_default(),
        offset_index_parts: d.field_u64("offsetIndexParts").unwrap_or_default(),
        uris,
        supersedes,
    })
}

/// The live (non-superseded) `objectLocator` manifests, newest-first — the index fragments a
/// reader must merge, and the set a consolidation supersedes.
fn live_locator_manifests(manifests: &[PackManifestInfo]) -> Vec<PackManifestInfo> {
    let superseded: BTreeSet<[u8; 32]> = manifests
        .iter()
        .flat_map(|m| m.supersedes.iter().copied())
        .collect();
    let mut live: Vec<PackManifestInfo> = manifests
        .iter()
        .filter(|m| m.kind == u64::from(crate::pack::KIND_OBJECT_LOCATOR))
        .filter(|m| !superseded.contains(&m.pack_hash))
        .cloned()
        .collect();
    live.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.document_id.cmp(&a.document_id))
    });
    live
}

/// Every git pack (kind 0) manifest, all copies: what a fetch, a repack or a reseed reads
/// (per pack, from its best verifying copy). Superseded packs are included — they are the
/// fallback the reader rule keeps.
fn git_pack_manifests(manifests: &[PackManifestInfo]) -> Vec<PackManifestInfo> {
    manifests
        .iter()
        .filter(|m| m.kind == u64::from(crate::pack::KIND_GIT_PACK))
        .cloned()
        .collect()
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

#[cfg(test)]
mod tests {
    use super::{
        current_protected_patterns, group_by_hash, live_locator_manifests, locator_pack_space,
        order_copies, plan_push_index, repack_supersedes, PackManifestInfo, PushIndexPlan, RoleMap,
        MAX_LOCATOR_FRAGMENTS,
    };
    use crate::rules::v2::{CopyKey, Role};
    use crate::rules::ConfigDoc;

    /// A manifest stub carrying only what the packRef space is derived from.
    fn manifest(id: &str, created_at: u64, kind: u8, hash: u8) -> PackManifestInfo {
        PackManifestInfo {
            document_id: id.into(),
            created_at,
            owner_id: "owner".into(),
            pack_hash: [hash; 32],
            kind: u64::from(kind),
            size_bytes: 0,
            object_count: 0,
            chunk_count: 0,
            storage: 0,
            offset_index_parts: 0,
            uris: Vec::new(),
            supersedes: Vec::new(),
        }
    }

    fn hashes(ms: &[PackManifestInfo]) -> Vec<u8> {
        ms.iter().map(|m| m.pack_hash[0]).collect()
    }

    /// The first byte of each pack in the locator space (unranked copies, as of now or `t`).
    fn space(ms: &[PackManifestInfo], as_of: Option<(u64, &str)>) -> Vec<u8> {
        let key = as_of.map(|(created_at, id)| CopyKey {
            created_at,
            id: id.to_string(),
        });
        locator_pack_space(ms, &RoleMap::new(), key.as_ref())
            .iter()
            .map(|p| hex::decode(&p.pack_hash).unwrap()[0])
            .collect()
    }

    #[test]
    fn locator_pack_space_orders_live_packs_oldest_first_with_the_id_tiebreak() {
        // Query order is `$createdAt desc`; the packRef space is the reverse WITH the id
        // tiebreak, which a plain reversal of the query result would lose.
        let manifests = vec![
            manifest("zz", 200, 0, 3),
            manifest("aa", 200, 0, 2),
            manifest("mm", 100, 0, 1),
            manifest("ll", 150, 1, 9), // a locator is not part of the pack space
        ];
        assert_eq!(space(&manifests, None), vec![1, 2, 3]);
    }

    #[test]
    fn superseded_packs_keep_their_positions_and_as_of_bounds_the_space() {
        // v2 manifests are permanent: a repack appends the consolidated pack and the packs
        // it supersedes keep their packRefs, so no locator is ever renumbered.
        let mut consolidated = manifest("cc", 300, 0, 9);
        consolidated.supersedes = vec![[1u8; 32], [2u8; 32]];
        let manifests = vec![
            consolidated,
            manifest("bb", 200, 0, 2),
            manifest("aa", 100, 0, 1),
        ];
        assert_eq!(space(&manifests, None), vec![1, 2, 9]);
        // As of a locator published before the repack: only the originals.
        assert_eq!(space(&manifests, Some((250, "ll"))), vec![1, 2]);
    }

    #[test]
    fn live_locator_manifests_drops_superseded_fragments_newest_first() {
        let mut folded = manifest("ff", 300, 1, 9);
        folded.supersedes = vec![[7u8; 32]];
        let manifests = vec![
            folded,
            manifest("ee", 250, 1, 8),
            manifest("dd", 200, 1, 7), // superseded by the fold
            manifest("aa", 100, 0, 1), // a git pack is not a fragment
        ];
        assert_eq!(hashes(&live_locator_manifests(&manifests)), vec![9, 8]);
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

    /// Shorthand: what `plan_push_index` decided, as `(pack_ref, fold)` or the skip reason.
    fn plan(manifests: &[PackManifestInfo], hash: u8) -> Result<(u16, bool, usize), String> {
        match plan_push_index(manifests, &RoleMap::new(), [hash; 32]) {
            PushIndexPlan::Publish {
                pack_ref,
                fold,
                live_locators,
            } => Ok((pack_ref, fold, live_locators.len())),
            PushIndexPlan::Skip(why) => Err(why),
        }
    }

    #[test]
    fn push_index_plan_publishes_a_fragment_at_the_pushed_packs_position() {
        // Two packs already stored, one index fragment; the push just added the third.
        let manifests = vec![
            manifest("p3", 300, 0, 3),
            manifest("f1", 150, 1, 8),
            manifest("p2", 200, 0, 2),
            manifest("p1", 100, 0, 1),
        ];
        assert_eq!(plan(&manifests, 3), Ok((2, false, 1)));
    }

    #[test]
    fn push_index_plan_folds_once_the_fragment_count_reaches_the_cap() {
        let mut manifests = vec![manifest("p1", 100, 0, 1), manifest("p2", 200, 0, 2)];
        for i in 0..MAX_LOCATOR_FRAGMENTS {
            let id = format!("f{i}");
            manifests.push(manifest(
                &id,
                110 + i as u64,
                1,
                100 + u8::try_from(i).unwrap(),
            ));
        }
        // One short of the cap: still a cheap per-push fragment.
        let mut under = manifests.clone();
        under.pop();
        assert_eq!(plan(&under, 2), Ok((1, false, MAX_LOCATOR_FRAGMENTS - 1)));
        // At the cap: fold, and absorb every live fragment.
        assert_eq!(plan(&manifests, 2), Ok((1, true, MAX_LOCATOR_FRAGMENTS)));
    }

    #[test]
    fn push_index_plan_indexes_a_pack_a_concurrent_repack_superseded() {
        // A repack landed between the push and this read. The pushed pack keeps its
        // position (superseded packs are never renumbered), so its fragment is still right.
        let mut consolidated = manifest("cc", 300, 0, 9);
        consolidated.supersedes = vec![[1u8; 32], [2u8; 32]];
        let manifests = vec![
            consolidated,
            manifest("p2", 200, 0, 2),
            manifest("p1", 100, 0, 1),
        ];
        assert_eq!(plan(&manifests, 2), Ok((1, false, 0)));
    }

    #[test]
    fn push_index_plan_declines_a_pack_whose_kind_another_copy_changed() {
        // A maintainer's later copy labels the pushed hash a locator (kind 1): the pack is
        // no longer in the git pack space, so indexing it would address the wrong bytes.
        let mut relabel = manifest("m1", 300, 1, 3);
        relabel.owner_id = "alice".into();
        let manifests = vec![
            relabel,
            manifest("p3", 200, 0, 3),
            manifest("p1", 100, 0, 1),
        ];
        let roles: RoleMap = [("alice".to_string(), Role::Maintainer)]
            .into_iter()
            .collect();
        let got = plan_push_index(&manifests, &roles, [3; 32]);
        assert!(
            matches!(&got, PushIndexPlan::Skip(why) if why.contains("not in the git pack space")),
            "{got:?}"
        );
    }

    #[test]
    fn push_index_plan_accepts_a_fragment_that_indexes_a_prefix_of_the_live_space() {
        // The ordinary case the check above must not reject: an older fragment covering
        // fewer packs, because the live pack list only grows at the end between repacks.
        let manifests = vec![
            manifest("p3", 300, 0, 3),
            manifest("p2", 200, 0, 2),
            manifest("f1", 150, 1, 8), // indexed [p1] — a prefix of [p1, p2, p3]
            manifest("p1", 100, 0, 1),
        ];
        assert_eq!(plan(&manifests, 3), Ok((2, false, 1)));
    }

    #[test]
    fn repack_supersedes_names_every_live_pack_but_the_new_one() {
        // Nothing is deleted on v2: an already-superseded pack keeps its superseder and
        // needs no slot; every live pack (anyone's) is named, oldest first.
        let mut bob = manifest("bob", 100, 0, 1);
        bob.owner_id = "bob".into();
        let mut prev = manifest("prev", 300, 0, 2);
        prev.supersedes = vec![[1u8; 32]];
        let new = manifest("new", 400, 0, 9);
        let out = repack_supersedes(&[new, prev, bob], [9u8; 32]);
        assert_eq!(out, vec![[2u8; 32]], "P1 is already superseded by `prev`");
    }

    #[test]
    fn repack_supersedes_never_names_the_new_pack_and_stays_within_the_field() {
        // `supersedes` is a 1024-byte packed byteArray: 32 hashes, no more. Past that the
        // list is truncated rather than failing the write.
        let mut manifests = vec![manifest("new", 999, 0, 9)];
        for i in 0..40u8 {
            manifests.push(manifest(&format!("p{i}"), 100 + u64::from(i), 0, i + 10));
        }
        let out = repack_supersedes(&manifests, [9u8; 32]);
        assert_eq!(out.len(), 32);
        assert!(!out.contains(&[9u8; 32]), "must never supersede itself");
        assert_eq!(out[0], [10u8; 32], "oldest first");
    }

    #[test]
    fn a_second_uploaders_copy_does_not_shift_the_pack_space() {
        // v2: carol re-uploads pack 1 after pack 2 landed. Pack 1 keeps packRef 0.
        let mut copy = manifest("c2", 300, 0, 1);
        copy.owner_id = "carol".into();
        let manifests = vec![copy, manifest("p2", 200, 0, 2), manifest("p1", 100, 0, 1)];
        assert_eq!(space(&manifests, None), vec![1, 2]);
        assert_eq!(group_by_hash(&manifests)[0].1.len(), 2);
    }

    #[test]
    fn copies_are_tried_maintainers_then_writers_then_former_members() {
        let mut stranger = manifest("s", 50, 0, 1);
        stranger.owner_id = "mallory".into();
        let mut writer = manifest("w", 200, 0, 1);
        writer.owner_id = "bob".into();
        let mut maint = manifest("m", 300, 0, 1);
        maint.owner_id = "alice".into();
        let roles: RoleMap = [
            ("alice".to_string(), Role::Maintainer),
            ("bob".to_string(), Role::Writer),
        ]
        .into_iter()
        .collect();
        let copies = [&stranger, &writer, &maint];
        let order: Vec<_> = order_copies(&copies, &roles)
            .iter()
            .map(|m| m.document_id.clone())
            .collect();
        assert_eq!(order, ["m", "w", "s"]);
        // With no membership known (v1), the order is by time.
        let order: Vec<_> = order_copies(&copies, &RoleMap::new())
            .iter()
            .map(|m| m.document_id.clone())
            .collect();
        assert_eq!(order, ["s", "w", "m"]);
    }

    #[test]
    fn live_locator_manifests_breaks_created_at_ties_by_document_id() {
        let a = manifest("aa", 100, 1, 1);
        let b = manifest("bb", 100, 1, 2);
        assert_eq!(
            live_locator_manifests(&[a, b])
                .iter()
                .map(|m| m.document_id.clone())
                .collect::<Vec<_>>(),
            vec!["bb", "aa"]
        );
    }
}
