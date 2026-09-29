//! [`RepoService`] — the git data plane `git-remote-dash` and `dg` drive.
//!
//! Every operation takes a resolved [`RepoRef`] and reaches its documents through the
//! repo's [`DocScope`]: the network's shared forge-core contract with `repoId == R` on every
//! query and write.
//!
//! - [`RepoService::write_ref_update`] / [`RepoService::read_refs`] — append a ref update
//!   (`protectedRefUpdate` for a protected ref, routed by the as-of config rule) and fold a
//!   repo's ref history into [`RefState`]s via [`crate::rules::resolve_ref`].
//! - [`RepoService::write_pack_manifest`] / [`RepoService::read_pack_manifests`] and the
//!   chunk tier ([`PlatformChunkTarget`]).
//! - [`RepoService::fetch_artifact`] — read a pack: external copies first, then Platform
//!   chunks. Each uploader has its own copy of a pack; readers try them in the
//!   `FORGE_RULES_V2` order (maintainers', then writers', then former members'), and use
//!   the first that hash-verifies ([`crate::rules::v2::order_pack_copies`]).
//! - [`RepoService::repack`] — consolidate the live packs into one superseding pack. Nothing
//!   is deleted: chunks and manifests are permanent (forge-v2 §4).
//!
//! Repository creation is [`crate::create`]; resolution is [`crate::resolve`]; membership
//! is [`crate::members`]. This module names no rs-sdk type (style guide §B).

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use futures::StreamExt as _;

use crate::backends::{PackBackend, PackMeta, PlatformBackend, Uri};
use crate::error::{Error, Result};
use crate::keyring::{sealed_error, Keyring, PrivateSigner};
use crate::keystore::BridgeIdentity;
use crate::layout;
use crate::platform::{
    self, FetchedDocument, FieldValue, JournalStore, LoadedContract, LoadedIdentity,
    PlatformClient, PushJournal, WriteEngine, WriteIntent,
};
use crate::private::{DocHeader, DocKind, Fields, Private, PrivateError, RefNameHasher};
use crate::rules::v2::{CopyKey, PackCopy, PackCopyRow, Role, V2Pack, Visibility};
use crate::rules::{self, ConfigDoc, RefState};
use crate::scope::{self, DocScope, RepoRef};
use crate::storage::{PackReader, Replication, StorageTarget, UriBudget};
use crate::user_error::{codes, UserError};

// Document type names (the git data plane in forge-core).
use crate::refs::DOC_CONFIG;
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
    /// External copies (`uris`, a typed string array).
    pub uris: Vec<String>,
    /// Prior `packHash`es this manifest supersedes (parsed from the packed `byteArray`).
    pub supersedes: Vec<[u8; 32]>,
    /// Tip commits the artifact describes (parsed from the packed `byteArray`): a history
    /// index's `[tip]` or `[tip, baseTip]`.
    pub tips: Vec<[u8; 20]>,
    /// `$createdAtBlockHeight` (the private-repo late-content rule, §8.2); 0 when unknown.
    pub created_at_block_height: u64,
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
    /// External mirror URIs.
    pub uris: Vec<String>,
    /// Prior artifact `packHash`es this manifest makes redundant (repack supersedes plan).
    /// Serialized as one packed `byteArray` = concatenated 32-byte hashes.
    pub supersedes: Vec<[u8; 32]>,
    /// Tip OIDs this artifact covers (kind-2 flatIndex tip; a gitmirror pack's ref tips).
    /// Serialized as one packed `byteArray` = concatenated raw OID bytes.
    pub tips: Vec<Vec<u8>>,
}

/// The largest `packManifest.sizeBytes` the RC1 contract accepts (`sizeNonNeg`: 1 TiB).
pub const MAX_MANIFEST_SIZE_BYTES: u64 = 1 << 40;

/// The `tips` widths the RC1 `kindShape` rule accepts on a history index (kind 3): one or
/// two SHA-1 or SHA-256 oids.
const HISTORY_TIPS_BYTES: [usize; 4] = [20, 32, 40, 64];

impl PackManifestInput {
    /// Refuse what the RC1 `packManifest` schema and rules would refuse, before anything is
    /// signed: `sizeNonNeg` (at most 1 TiB), `storageShape` (a Platform copy holds its bytes
    /// in `chunkCount` chunks of 14,700 B; an external one has no chunks), `kindShape` (whole
    /// supersedes hashes, and a history index's tips), and the `uris`/`tips`/`supersedes`
    /// field sizes. `platformChunks` (the chunks are all on chain) is a consensus total the
    /// writer satisfies by writing the manifest only after its chunks landed.
    pub fn check(&self) -> Result<()> {
        let refuse = |why: String| Err(Error::Config(format!("packManifest refused: {why}")));
        if self.size_bytes > MAX_MANIFEST_SIZE_BYTES {
            return refuse(format!("sizeBytes {} is over 1 TiB", self.size_bytes));
        }
        if self.kind > 255 {
            return refuse(format!("kind {} is not 0-255", self.kind));
        }
        match self.storage {
            0 if self.size_bytes
                > self
                    .chunk_count
                    .saturating_mul(crate::pack::DOC_PAYLOAD_MAX as u64) =>
            {
                return refuse(format!(
                    "{} bytes do not fit {} chunk(s)",
                    self.size_bytes, self.chunk_count
                ));
            }
            1 if self.chunk_count != 0 => {
                return refuse("an external copy has no chunks".into());
            }
            0 | 1 => {}
            other => return refuse(format!("storage {other} is not 0 or 1")),
        }
        if u32::try_from(self.chunk_count).is_err() {
            return refuse(format!("chunkCount {} is over u32", self.chunk_count));
        }
        if !MANIFEST_URIS_V2.fits(&self.uris) {
            return refuse("uris holds at most 8 URIs of at most 300 bytes each".into());
        }
        if self.supersedes.len() > MAX_SUPERSEDES {
            return refuse(format!(
                "it supersedes {} artifacts; at most {MAX_SUPERSEDES} fit",
                self.supersedes.len()
            ));
        }
        let tips: usize = self.tips.iter().map(Vec::len).sum();
        if tips > 512 {
            return refuse(format!("tips is {tips} bytes; at most 512 fit"));
        }
        if self.kind == u64::from(crate::pack::KIND_HISTORY_INDEX)
            && !HISTORY_TIPS_BYTES.contains(&tips)
        {
            return refuse(format!(
                "a history index names one or two tips (20, 32, 40 or 64 bytes), not {tips} bytes"
            ));
        }
        Ok(())
    }

    /// The `packManifest` document properties in `scope`, after [`Self::check`]: `packHash`
    /// as an identifier, and `tips` / `supersedes` as packed byteArrays (concatenated
    /// fixed-width entries).
    pub fn props(&self, scope: &DocScope) -> Result<BTreeMap<String, FieldValue>> {
        self.check()?;
        let mut props = scope.props([
            ("packHash", FieldValue::identifier(self.pack_hash)),
            ("kind", FieldValue::integer(self.kind)),
            ("sizeBytes", FieldValue::integer(self.size_bytes)),
            ("objectCount", FieldValue::integer(self.object_count)),
            ("chunkCount", FieldValue::integer(self.chunk_count)),
            ("storage", FieldValue::integer(self.storage)),
        ]);
        if !self.uris.is_empty() {
            props.insert("uris".into(), FieldValue::text_list(self.uris.clone()));
        }
        if !self.tips.is_empty() {
            props.insert("tips".into(), FieldValue::bytes(self.tips.concat()));
        }
        if !self.supersedes.is_empty() {
            props.insert(
                "supersedes".into(),
                FieldValue::bytes(self.supersedes.concat()),
            );
        }
        Ok(props)
    }
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

/// How a repository's artifacts are stored: as-is (public), or sealed under the current
/// write epoch (private, §3). Reseeds and mirrors copy stored bytes verbatim and never
/// re-seal (§3.4).
pub enum PackCodec {
    /// A public repository.
    Public,
    /// A private repository's write seams.
    Private(Box<Private>),
}

impl PackCodec {
    /// The bytes to store for artifact `plain`.
    pub fn seal(&self, plain: Vec<u8>) -> Result<Vec<u8>> {
        match self {
            Self::Public => Ok(plain),
            Self::Private(p) => crate::private::PackCipher::seal(p.as_ref(), plain),
        }
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
    /// Nothing was published: why, and what repairs it.
    Skipped(IndexSkip),
}

/// Why a push's browse index was not published, and the command that repairs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexSkip {
    /// What happened, in terms a user can act on.
    pub reason: String,
    /// What repairs it.
    pub remedy: IndexRemedy,
}

/// The command that repairs a missing browse index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexRemedy {
    /// `dg repo reindex`: the pack is fine, only its index is missing (the manifest was not
    /// visible yet, or the index upload failed).
    Reindex,
    /// `dg repack`: the index cannot be extended as it stands (the pack space outgrew the
    /// 16-bit `packRef`, or a fragment was built over another pack space).
    Repack,
    /// Restore the storage of an index fragment that cannot be read (`dg storage status`
    /// finds it; `dg reseed` re-uploads it): until it reads, readers fall back, and neither a
    /// reindex nor a repack changes that.
    Restore,
    /// Nothing a user runs fixes it (the pushed hash is listed under another kind).
    None,
}

impl IndexSkip {
    fn new(reason: impl Into<String>, remedy: IndexRemedy) -> Self {
        Self {
            reason: reason.into(),
            remedy,
        }
    }

    /// The command that repairs `repo` (`owner/name`), if any.
    pub fn fix(&self, repo: &str) -> Option<String> {
        match self.remedy {
            IndexRemedy::Reindex => Some(format!("dg repo reindex {repo}")),
            IndexRemedy::Repack => Some(format!("dg repack {repo}")),
            IndexRemedy::Restore => Some(format!("dg storage status {repo}")),
            IndexRemedy::None => None,
        }
    }
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
    /// The repository's current members (only their claims count as already superseded).
    roles: &'a RoleMap,
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
    /// Live git packs the manifest could not name ([`MAX_SUPERSEDES`] fit); another
    /// `dg repack` names them.
    pub remaining: usize,
}

/// What [`RepoService::reindex`] would publish ([`RepoService::plan_reindex`]).
#[derive(Debug)]
pub struct ReindexPlan {
    /// The stored git packs with objects that no index fragment covers, in `packRef` order.
    /// Empty: the repository is fully indexed.
    pub missing: Vec<V2Pack>,
    /// The live fragments the new one folds in (and supersedes), with their rows: empty
    /// unless the live fragments are at [`MAX_LOCATOR_FRAGMENTS`].
    fold: Vec<(PackManifestInfo, crate::pack::ObjectLocator)>,
    /// Every index fragment hash the plan read (or tried to): one that appears later was
    /// published concurrently.
    known: BTreeSet<[u8; 32]>,
    manifests: Vec<PackManifestInfo>,
    roles: RoleMap,
}

impl ReindexPlan {
    /// Whether the new fragment also folds the live ones in.
    pub fn fold(&self) -> bool {
        !self.fold.is_empty()
    }

    /// Whether any copy of a missing pack is stored as Platform chunks: then the index may go
    /// there too. A repository whose packs live only on the owner's storage never gets an
    /// index on Platform it did not ask for.
    pub fn packs_on_platform(&self) -> bool {
        let git = u64::from(crate::pack::KIND_GIT_PACK);
        self.missing.iter().any(|p| {
            self.manifests
                .iter()
                .any(|m| m.kind == git && m.storage == 0 && hex::encode(m.pack_hash) == p.pack_hash)
        })
    }

    /// Whether any copy of any git pack is stored as Platform chunks: where a history index may
    /// go when no pack is missing its locator.
    pub fn any_pack_on_platform(&self) -> bool {
        let git = u64::from(crate::pack::KIND_GIT_PACK);
        self.manifests
            .iter()
            .any(|m| m.kind == git && m.storage == 0)
    }

    /// The history index plan for `tip`, from the same manifests ([`plan_history_index`]).
    pub fn history_plan(&self, tip: [u8; 20]) -> HistoryPlan {
        plan_history_index(&self.manifests, &self.roles, tip)
    }

    /// Objects the published fragment will index (what its size, and price, follow).
    pub fn index_objects(&self) -> u64 {
        self.missing.iter().map(|p| p.object_count).sum::<u64>()
            + self
                .fold
                .iter()
                .map(|(_, f)| f.object_count() as u64)
                .sum::<u64>()
    }
}

/// What [`RepoService::reindex`] did.
#[derive(Debug, Default)]
pub struct ReindexReport {
    /// The index manifest published; `None` when nothing was left to index (every pack was
    /// skipped, or an index published meanwhile covers them).
    pub manifest_id: Option<String>,
    /// The packs (hex) the published fragment indexes.
    pub indexed: Vec<String>,
    /// Objects it indexes (folded fragments included).
    pub index_objects: u64,
    /// Packs (hex) not indexed, and why.
    pub skipped: Vec<(String, String)>,
}

/// The index fragments a reader merges, as forge-web's `loadBrowseContext` does: every kind-1
/// pack of the pack list, superseded or not (the web lists copies unverified, so it honours no
/// `supersedes`), one representative copy each, keyed by the pack's first upload.
fn index_fragments(manifests: &[PackManifestInfo], roles: &RoleMap) -> Vec<PackManifestInfo> {
    let kind = u64::from(crate::pack::KIND_OBJECT_LOCATOR);
    pack_list(manifests, roles, None)
        .into_iter()
        .filter(|p| p.kind == kind)
        .filter_map(|p| {
            let rep = manifests
                .iter()
                .find(|m| Some(&m.document_id) == p.copies.first())?;
            Some(PackManifestInfo {
                created_at: p.first.created_at,
                document_id: p.first.id.clone(),
                ..rep.clone()
            })
        })
        .collect()
}

/// The live fragments a new index folds in, when they are at [`MAX_LOCATOR_FRAGMENTS`]: the
/// newest [`fold_limit`] (a manifest's `supersedes` names at most that many; the rest stay
/// live, merged by readers, and fold on a later publish). `None`: publish a plain fragment.
fn fold_set(live: &[PackManifestInfo]) -> Option<Vec<PackManifestInfo>> {
    (live.len() >= MAX_LOCATOR_FRAGMENTS).then(|| live.iter().take(fold_limit()).cloned().collect())
}

/// The re-check a reindex makes on the manifests read just before its write (`fresh`): every
/// pack it indexed (`planned`) must still sit at its `packRef`, and every fragment readers
/// merge must still index a prefix of the space. Returns the fragments published since the
/// plan (not in `known`), whose coverage the caller subtracts.
fn recheck_reindex(
    fresh: &[PackManifestInfo],
    roles: &RoleMap,
    planned: &[V2Pack],
    known: &BTreeSet<[u8; 32]>,
    fold: &[PackManifestInfo],
) -> Result<Vec<PackManifestInfo>> {
    let space = locator_pack_space(fresh, roles, None);
    let merged = index_fragments(fresh, roles);
    let moved = planned
        .iter()
        .any(|p| space.get(p.pack_ref).map(|s| &s.pack_hash) != Some(&p.pack_hash));
    if moved || !fragments_index_prefixes(fresh, roles, &space, &merged) {
        return Err(Error::Config(format!(
            "{FRAGMENT_MISMATCH}; nothing was published — run `dg repack`"
        )));
    }
    // A folded fragment superseded meanwhile (another fold) must not be folded again.
    let superseded: BTreeSet<[u8; 32]> = fresh
        .iter()
        .flat_map(|m| m.supersedes.iter().copied())
        .collect();
    if fold.iter().any(|f| superseded.contains(&f.pack_hash)) {
        return Err(Error::Config(
            "the index fragments were folded while this ran; nothing was published — run \
             `dg repo reindex` again"
                .into(),
        ));
    }
    Ok(merged
        .into_iter()
        .filter(|m| !known.contains(&m.pack_hash))
        .collect())
}

/// Why a stored pack cannot be given index rows: an older client's `--fix-thin` pack (its
/// `REF_DELTA` bases come after the deltas), which only a repack can rebuild.
fn unindexable_reason(e: &Error) -> String {
    let text = e.to_string();
    if text.contains("REF_DELTA") {
        "stored by an older client in a shape the browse index cannot describe (REF_DELTA / \
         --fix-thin); run `dg repack` to rebuild it and its index"
            .into()
    } else {
        text
    }
}

/// Why an index is not published or folded when a fragment's rows name a pack past the end of
/// the pack space: it was built over another space.
const FRAGMENT_OUTSIDE_SPACE: &str =
    "a published index fragment addresses a pack outside the pack set";

/// The packs of `space` that hold objects but have no row in the live fragments (`covered`
/// is the set of `packRef`s they index). An index row naming a pack past the end of the
/// space means a fragment was built over another space: refused, like a push would.
fn uncovered_packs(space: &[V2Pack], covered: &BTreeSet<u16>) -> Result<Vec<V2Pack>> {
    if covered.iter().any(|&r| usize::from(r) >= space.len()) {
        return Err(Error::Config(format!(
            "{FRAGMENT_OUTSIDE_SPACE}; run `dg repack`"
        )));
    }
    Ok(space
        .iter()
        .filter(|p| p.object_count > 0)
        .filter(|p| {
            u16::try_from(p.pack_ref)
                .ok()
                .is_none_or(|r| !covered.contains(&r))
        })
        .cloned()
        .collect())
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

/// One ref update of a push ([`RepoService::write_ref_updates`]).
#[derive(Debug, Clone)]
pub struct RefWrite {
    /// The full ref name (`refs/heads/main`).
    pub ref_name: String,
    /// The new tip (20 raw bytes; all zero deletes the ref).
    pub new_oid: Vec<u8>,
    /// The tip the pusher saw (divergence detection).
    pub prev_oid: Option<Vec<u8>>,
    /// A forced update.
    pub force: bool,
}

/// A repository's current members as the pack reader rule needs them (maintainers'
/// copies first).
pub type RoleMap = BTreeMap<String, Role>;

/// The git data-plane service, bound to one signing identity and its keys, or to none.
///
/// Constructed per operation batch: it borrows a connected [`PlatformClient`] and, for
/// anything that signs (or opens a private repository), the fetched signer
/// [`LoadedIdentity`] and its [`BridgeIdentity`] key material. A [`Self::reader`] has no
/// signer: it reads a public repository anonymously (refs, manifests, packs from external
/// copies or Platform chunks), and every signing operation fails with E301.
pub struct RepoService<'a> {
    client: &'a PlatformClient,
    signer: Option<(&'a LoadedIdentity, &'a BridgeIdentity)>,
    /// A private repository's keys, loaded once per service for reads and replaced by every
    /// write-time reload ([`Self::private_writer`], §5.3), so a rotation a write picked up is
    /// also what later reads (the push's convergence re-read, a locator fold) open with.
    keyring: KeyringCache,
}

/// A private repository's keys as one or more [`RepoService`]s share them: every write-time
/// reload replaces the entry, so a helper's later services (the push's convergence re-read, a
/// fetch) open with the keys its writes used.
pub type KeyringCache = std::sync::Arc<std::sync::Mutex<Option<std::sync::Arc<Keyring>>>>;

/// The keyring of `repo` held in `cache`, else `load`ed (lazily: only on a miss) and cached.
/// One entry, keyed by repository: another repository's keyring is never returned.
pub async fn cached_keyring<F>(
    cache: &KeyringCache,
    repo: &RepoRef,
    load: impl FnOnce() -> F,
) -> Result<std::sync::Arc<Keyring>>
where
    F: std::future::Future<Output = Result<Keyring>>,
{
    let repo_id = repo.scope()?.repo_id;
    let lock = || {
        cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    };
    if let Some(k) = lock().as_ref().filter(|k| *k.repo_id() == repo_id) {
        return Ok(std::sync::Arc::clone(k));
    }
    let fresh = std::sync::Arc::new(load().await?);
    *lock() = Some(std::sync::Arc::clone(&fresh));
    Ok(fresh)
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
            signer: Some((identity, bridge)),
            keyring: KeyringCache::default(),
        }
    }

    /// A service with no signer: reads a public repository anonymously. Signing operations
    /// (and opening a private repository) fail with E301.
    pub fn reader(client: &'a PlatformClient) -> Self {
        Self {
            client,
            signer: None,
            keyring: KeyringCache::default(),
        }
    }

    /// The signer, or E301 naming what needed one.
    fn identity_pair(&self) -> Result<(&'a LoadedIdentity, &'a BridgeIdentity)> {
        self.signer.ok_or_else(|| {
            UserError::new(codes::NO_IDENTITY, "no identity configured")
                .cause("this operation signs (or opens a private repository), and it was started without an identity")
                .fix("`dg auth login <file>` (or `dg auth new`) records a default key that git uses too")
                .fix("or export DASH_FORGE_KEY=<identity file | keychain:… | dfk1:…>")
                .into()
        })
    }

    /// The signer's identity id (E301 without one).
    fn identity_id(&self) -> Result<String> {
        Ok(self.identity_pair()?.0.id())
    }

    /// [`Self::new`] sharing `cache`: a helper invocation reads a private repo's keys once, and
    /// a reload by any of its services (every write re-reads them, [`Self::private_writer`])
    /// is what the others open with next.
    pub fn with_keyring(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
        cache: KeyringCache,
    ) -> Self {
        Self {
            client,
            signer: Some((identity, bridge)),
            keyring: cache,
        }
    }

    /// The signer's view for private-repository key operations (E301 without a signer).
    pub fn signer(&self) -> Result<PrivateSigner<'a>> {
        let (identity, bridge) = self.identity_pair()?;
        Ok(PrivateSigner {
            client: self.client,
            identity,
            bridge,
        })
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, Option<std::sync::Arc<Keyring>>> {
        self.keyring
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The keys of private `repo` as this identity holds them: loaded once per service (and
    /// per repository), refreshed by every write.
    pub async fn keyring(&self, repo: &RepoRef) -> Result<std::sync::Arc<Keyring>> {
        let signer = self.signer()?;
        cached_keyring(
            &self.keyring,
            repo,
            || async move { signer.keyring(repo).await },
        )
        .await
    }

    /// The seams to write private `repo` with, from a keyring read NOW (§5.3: re-read the
    /// anchors before every write, so nothing is written under a superseded epoch). The
    /// reload also replaces the cached keyring.
    pub async fn private_writer(
        &self,
        repo: &RepoRef,
    ) -> Result<(Private, std::sync::Arc<Keyring>)> {
        let kr = std::sync::Arc::new(self.signer()?.keyring(repo).await?);
        *self.cache() = Some(std::sync::Arc::clone(&kr));
        let w = kr.writer(repo)?;
        Ok((w, kr))
    }

    /// The pack codec for `repo`: identity for a public repo, sealing under the current write
    /// epoch for a private one (re-resolved now).
    pub async fn pack_codec(&self, repo: &RepoRef) -> Result<PackCodec> {
        Ok(match repo.visibility {
            Visibility::Public => PackCodec::Public,
            Visibility::Private => PackCodec::Private(Box::new(self.private_writer(repo).await?.0)),
        })
    }

    /// The bytes a reader hands to git for a fetched artifact: `sealed` itself for a public
    /// repo; for a private one, the plaintext (§3.5), after the late-content rule (§8.2).
    /// `manifest` is the copy the bytes came from; see [`Self::open_artifact_of`] to judge the
    /// pack by all of its copies.
    pub async fn open_artifact(
        &self,
        repo: &RepoRef,
        manifest: &PackManifestInfo,
        sealed: Vec<u8>,
    ) -> Result<Vec<u8>> {
        self.open_artifact_of(repo, &[manifest], manifest.size_bytes, sealed)
            .await
    }

    /// [`Self::open_artifact`] for a pack whose manifests are `copies` (every copy names the
    /// same sealed bytes): the late-content rule reads the pack if ANY copy qualifies, since
    /// a current member attesting the bytes makes them readable whoever else uploaded them.
    pub async fn open_artifact_of(
        &self,
        repo: &RepoRef,
        copies: &[&PackManifestInfo],
        size_bytes: u64,
        sealed: Vec<u8>,
    ) -> Result<Vec<u8>> {
        let Some(manifest) = copies.first() else {
            return Err(Error::NotFound);
        };
        if repo.visibility == Visibility::Public {
            return Ok(sealed);
        }
        let kr = self.keyring(repo).await?;
        let header = crate::private::PackHeader::parse(
            sealed
                .get(..crate::private::pack::HEADER_LEN)
                .ok_or_else(|| sealed_error(&PrivateError::SealedPackCorrupt))?,
            size_bytes,
        )
        .map_err(|e| sealed_error(&e))?;
        // A manifest with no block height cannot be judged (§8.1): it never qualifies.
        let readable = copies.iter().any(|m| {
            m.created_at_block_height > 0
                && platform::decode_identifier(&m.owner_id).is_ok_and(|owner| {
                    kr.resolution()
                        .manifest_standing(header.epoch(), m.created_at_block_height, &owner)
                        .readable
                })
        });
        if !readable {
            return Err(UserError::new(
                codes::LATE_CONTENT,
                format!(
                    "pack {} was uploaded under an old key after the key was rotated",
                    &hex::encode(manifest.pack_hash)[..12]
                ),
            )
            .cause(format!(
                "its sealed header names epoch {} and its uploader {} is no longer a member",
                header.epoch(),
                manifest.owner_id
            ))
            .into());
        }
        match kr.open_pack(repo, &sealed, size_bytes) {
            // Sealed under an epoch newer than the keys this service holds (a rotation landed
            // while it ran): read the keys again once.
            Err(_) if !kr.resolution().keys.contains_key(&header.epoch()) => {
                let fresh = std::sync::Arc::new(self.signer()?.keyring(repo).await?);
                *self.cache() = Some(std::sync::Arc::clone(&fresh));
                fresh.open_pack(repo, &sealed, size_bytes)
            }
            // A tag failure on every copy predating the key's first statement: sealed under an
            // earlier use of the epoch number (§5.3), a different key. Not corruption; skipped
            // like late content. A malformed or truncated copy (E508) still fails as such.
            // (the header parsed above and the length matches, so only a segment tag can fail)
            Err(_)
                if sealed.len() as u64 == size_bytes
                    && copies
                    .iter()
                    .all(|m| kr.earlier_use(header.epoch(), Some(m.created_at_block_height))) =>
            {
                Err(UserError::new(
                    codes::LATE_CONTENT,
                    format!(
                        "pack {} was sealed under an earlier use of key epoch {}",
                        &hex::encode(manifest.pack_hash)[..12],
                        header.epoch()
                    ),
                )
                .cause("that epoch number stopped existing when its anchor's maintainer was removed, and was used again with a new key")
                .into())
            }
            other => other,
        }
    }

    /// A document write engine bound to the signer, signing with the HIGH doc-op key.
    fn doc_engine(&self) -> Result<WriteEngine<'a>> {
        let (identity, bridge) = self.identity_pair()?;
        WriteEngine::new(self.client, identity, bridge.doc_op_key()?)
    }

    /// The contract holding `repo`'s git data (forge-core), fetched and registered with the
    /// proof verifier.
    pub async fn repo_contract(&self, repo: &RepoRef) -> Result<LoadedContract> {
        self.client.fetch_contract(&repo.scope()?.contract_id).await
    }

    /// The scope and contract of `repo`, for reading.
    async fn readable(&self, repo: &RepoRef) -> Result<(DocScope, LoadedContract)> {
        let scope = repo.scope()?;
        let contract = self.client.fetch_contract(&scope.contract_id).await?;
        Ok((scope, contract))
    }

    /// The scope and contract of `repo`, for writing.
    async fn writable(&self, repo: &RepoRef) -> Result<(DocScope, LoadedContract)> {
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
        check_ref_write(ref_name, new_oid, prev_oid)?;
        let (scope, contract) = self.writable(repo).await?;
        if repo.visibility == Visibility::Private {
            return self
                .write_private_ref_update(
                    repo, &scope, &contract, ref_name, new_oid, prev_oid, force,
                )
                .await;
        }
        // The config in force now: this write is routed by it.
        let configs = crate::refs::read_config_history(self.client, &contract, &scope).await?;
        let doc_type = ref_doc_type(ref_name, &current_protected_patterns(&configs));
        let props = public_ref_props(&scope, ref_name, new_oid, prev_oid, force)?;
        self.doc_engine()?
            .create_document(&contract, doc_type, props)
            .await
    }

    /// Write several ref updates as one step of a push (P-6): the config is read ONCE, now
    /// (it routes each update to `refUpdate` or `protectedRefUpdate`), and the writes of a
    /// public repository go in parallel, each with its own nonce, up to the chunk pipeline's
    /// window; every one is attempted, so a ref after a failed one can still land. A private
    /// repository writes them one by one ([`Self::write_ref_update`]: each re-reads the
    /// anchors before it seals, §5.3) and stops at the first failure. Every name is checked
    /// before anything is written. `on_landed(i)` is called for `updates[i]` as it lands (in
    /// order), so a caller can report it at once. Returns each attempted update's result, in
    /// order (shorter than `updates` when a sequential write failed); `Err` only when nothing
    /// was written (an illegal name, or reading the repository or its config failed).
    pub async fn write_ref_updates(
        &self,
        repo: &RepoRef,
        updates: &[RefWrite],
        mut on_landed: impl FnMut(usize),
    ) -> Result<Vec<Result<String>>> {
        for u in updates {
            check_ref_write(&u.ref_name, &u.new_oid, u.prev_oid.as_deref())?;
        }
        let mut results = Vec::with_capacity(updates.len());
        if repo.visibility == Visibility::Private || updates.len() < 2 {
            for (i, u) in updates.iter().enumerate() {
                let r = self
                    .write_ref_update(
                        repo,
                        &u.ref_name,
                        &u.new_oid,
                        u.prev_oid.as_deref(),
                        u.force,
                    )
                    .await;
                let failed = r.is_err();
                if !failed {
                    on_landed(i);
                }
                results.push(r);
                if failed {
                    break;
                }
            }
            return Ok(results);
        }
        let (scope, contract) = self.writable(repo).await?;
        let configs = crate::refs::read_config_history(self.client, &contract, &scope).await?;
        let patterns = current_protected_patterns(&configs);
        let engine = self.doc_engine()?;
        let (scope, contract, patterns, engine) = (&scope, &contract, &patterns, &engine);
        let mut landed = futures::stream::iter(updates.iter().map(|u| async move {
            let props = public_ref_props(
                scope,
                &u.ref_name,
                &u.new_oid,
                u.prev_oid.as_deref(),
                u.force,
            )?;
            engine
                .create_document(contract, ref_doc_type(&u.ref_name, patterns), props)
                .await
        }))
        .buffered(crate::backends::platform::pipeline_window());
        while let Some(r) = landed.next().await {
            if r.is_ok() {
                on_landed(results.len());
            }
            results.push(r);
        }
        Ok(results)
    }

    /// A private ref update (§4.5): `refNameHash = HMAC(K_ref,e, refName)` under the write
    /// epoch re-resolved now, `refName` only inside `enc`, bound (AD) to the hash, the oids and
    /// `force`. Protected routing uses the decrypted config timeline.
    #[allow(clippy::too_many_arguments)]
    async fn write_private_ref_update(
        &self,
        repo: &RepoRef,
        scope: &DocScope,
        contract: &LoadedContract,
        ref_name: &str,
        new_oid: &[u8],
        prev_oid: Option<&[u8]>,
        force: bool,
    ) -> Result<String> {
        let (w, kr) = self.private_writer(repo).await?;
        let epoch = w.write_epoch();
        let ref_name_hash = w.hash(epoch, ref_name)?;
        let protected = rules::matches_protected(ref_name, &kr.config().protected_patterns);
        let (doc_type, kind) = if protected {
            (DOC_PROTECTED_REF_UPDATE, DocKind::ProtectedRefUpdate)
        } else {
            (DOC_REF_UPDATE, DocKind::RefUpdate)
        };
        let owner = platform::decode_identifier(&self.identity_id()?)?;
        let mut header = DocHeader::new(kind, owner, epoch);
        header.ref_name_hash = Some(ref_name_hash);
        header.new_oid = Some(new_oid.to_vec());
        header.prev_oid = prev_oid.map(<[u8]>::to_vec);
        header.force = Some(force);
        let enc = w.seal_doc(
            &header,
            &Fields {
                ref_name: Some(ref_name.to_string()),
                ..Fields::default()
            },
        )?;
        let mut props = scope.props([
            ("refNameHash", FieldValue::bytes32(ref_name_hash)),
            ("newOid", FieldValue::bytes(new_oid.to_vec())),
            ("force", FieldValue::boolean(force)),
            ("enc", FieldValue::bytes(enc)),
            ("epoch", FieldValue::integer(u64::from(epoch))),
        ]);
        if let Some(prev) = prev_oid {
            props.insert("prevOid".into(), FieldValue::bytes(prev.to_vec()));
        }
        layout::stamp_vis(&mut props, repo.visibility);
        self.doc_engine()?
            .create_document(contract, doc_type, props)
            .await
    }

    /// Enumerate every ref and its resolved [`RefState`].
    ///
    /// Every ref's history, and the repo's `config` history, come from
    /// [`crate::refs::read_git_state`]: the append-only `reflog` read through the delta cache
    /// ([`crate::history`]), so a repository's history is paged once and every later read
    /// costs one request for what landed since (see the `refs` module docs for why this
    /// replaced the `refState` keyset scan). Each ref's updates are folded with the config
    /// history by [`crate::rules::resolve_ref`].
    ///
    /// The ancestry predicate is reflexive-only here (no read-side commit graph):
    /// fast-forward supersession via `prevOid` still resolves, but descend-detection is
    /// deferred to the push-side pipeline that has the object store.
    pub async fn read_refs(&self, repo: &RepoRef) -> Result<Vec<(String, RefState)>> {
        let (scope, contract) = self.readable(repo).await?;
        if repo.visibility == Visibility::Private {
            let kr = self.keyring(repo).await?;
            kr.require_key(repo)?; // no key at all: say so, rather than list nothing
            return crate::refs::read_private_refs(self.client, &contract, &scope, &kr).await;
        }
        let state = crate::refs::read_git_state(
            self.client,
            &contract,
            &scope,
            crate::history::Freshness::Now,
        )
        .await?;
        let configs = state.config_history();
        let by_hash = state.ref_histories();

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
        if repo.visibility == Visibility::Private {
            return Ok(self
                .keyring(repo)
                .await?
                .config()
                .protected_patterns
                .clone());
        }
        let (scope, contract) = self.readable(repo).await?;
        let configs = crate::refs::read_config_history(self.client, &contract, &scope).await?;
        Ok(current_protected_patterns(&configs))
    }

    /// The config in force in `scope`: the newest **well-formed** `config` by
    /// `($createdAt, $id)`, the same selection the ref rules (`current_protected_patterns`) and
    /// forge-web's `readConfigBundle` make, so a settings write builds on the config readers
    /// see. Read through the delta cache: [`Freshness::Now`](crate::history::Freshness::Now)
    /// for anything that writes from it (a settings write must build on the newest config),
    /// `Synced` for a read that follows a `list` in the same process.
    async fn newest_config(
        &self,
        scope: &DocScope,
        contract: &LoadedContract,
        freshness: crate::history::Freshness,
    ) -> Result<Option<FetchedDocument>> {
        let state = crate::refs::read_git_state(self.client, contract, scope, freshness).await?;
        Ok(newest_well_formed_config(state.configs))
    }

    /// The repo's current default branch from the newest `config` (e.g. `main`) — the
    /// branch `git-remote-dash` reports as the `HEAD` symref. `None` when there is none.
    pub async fn read_default_branch(&self, repo: &RepoRef) -> Result<Option<String>> {
        if repo.visibility == Visibility::Private {
            return Ok(self.keyring(repo).await?.config().default_branch.clone());
        }
        let (scope, contract) = self.readable(repo).await?;
        Ok(self
            .newest_config(&scope, &contract, crate::history::Freshness::Synced)
            .await?
            .and_then(|d| d.field_str("defaultBranch")))
    }

    /// Append a `config` carrying `backend_mode`, optionally replacing the advertised read
    /// `uris` (the public read bases of a storage policy — `dg storage advertise`; `None`
    /// keeps the newest config's). Default branch, protected patterns and the archived
    /// flag carry over (config is append-only, newest wins). Maintainer-gated. `Ok(None)` when
    /// the config already says so: nothing is written.
    pub async fn set_backend(
        &self,
        repo: &RepoRef,
        backend_mode: u8,
        new_uris: Option<&[String]>,
    ) -> Result<Option<String>> {
        let change = ConfigChange {
            backend_mode: Some(backend_mode),
            backend_uris: new_uris.map(<[String]>::to_vec),
            ..ConfigChange::default()
        };
        self.update_config(repo, &change).await
    }

    /// The repository's current configuration (the newest well-formed `config`; a private
    /// repo's decrypted), or the defaults when none exists.
    pub async fn current_config(&self, repo: &RepoRef) -> Result<CurrentConfig> {
        if repo.visibility == Visibility::Private {
            let kr = self.keyring(repo).await?;
            kr.require_key(repo)?;
            return Ok(CurrentConfig::of_private(kr.config()));
        }
        let (scope, contract) = self.readable(repo).await?;
        Ok(self
            .newest_config(&scope, &contract, crate::history::Freshness::Now)
            .await?
            .as_ref()
            .map_or_else(CurrentConfig::default, CurrentConfig::of_doc))
    }

    /// Append a `config` applying `change` over the current one (config is append-only,
    /// newest wins; every field not in `change` carries over). Maintainer-gated at consensus.
    /// A private repository's config is re-sealed (a v0x02 non-anchor config under the write
    /// epoch, carrying the anchor's chain link). `Ok(None)` when the current config already
    /// holds every change: nothing is signed.
    pub async fn update_config(
        &self,
        repo: &RepoRef,
        change: &ConfigChange,
    ) -> Result<Option<String>> {
        change.validate()?;
        let (scope, contract) = self.writable(repo).await?;
        if repo.visibility == Visibility::Private {
            let (w, kr) = self.private_writer(repo).await?;
            let now = CurrentConfig::of_private(kr.config());
            let next = now.apply(change);
            if next == now {
                return Ok(None);
            }
            let epoch = w.write_epoch();
            let owner = platform::decode_identifier(&self.identity_id()?)?;
            // Every config of an epoch >= 1 repeats its anchor's chain link (§4.3), so it can
            // serve as the anchor if the anchor's author stops being a maintainer.
            let base = Fields {
                default_branch: Some(next.default_branch.clone()),
                protected_patterns: next.protected_patterns.clone(),
                ..Fields::default()
            };
            let fields = match kr.link_of(epoch)? {
                Some(l) => l.apply(base),
                None => base,
            };
            let enc = w.seal_doc(&DocHeader::new(DocKind::Config, owner, epoch), &fields)?;
            let mut props = scope.props([
                ("enc", FieldValue::bytes(enc)),
                ("epoch", FieldValue::integer(u64::from(epoch))),
                ("backend", next.backend_value()),
                ("archived", FieldValue::boolean(next.archived)),
            ]);
            layout::stamp_vis(&mut props, repo.visibility);
            return self
                .doc_engine()?
                .create_document(&contract, DOC_CONFIG, props)
                .await
                .map(Some);
        }
        let now = self
            .newest_config(&scope, &contract, crate::history::Freshness::Now)
            .await?
            .as_ref()
            .map_or_else(CurrentConfig::default, CurrentConfig::of_doc);
        let next = now.apply(change);
        if next == now {
            return Ok(None);
        }
        let mut props = scope.props([
            ("defaultBranch", FieldValue::text(&next.default_branch)),
            ("backend", next.backend_value()),
            ("archived", FieldValue::boolean(next.archived)),
        ]);
        // An empty list is the same as none (`is_well_formed`), and omitting it is smaller.
        if !next.protected_patterns.is_empty() {
            props.insert(
                "protectedPatterns".into(),
                FieldValue::text_list(next.protected_patterns.clone()),
            );
        }
        layout::stamp_vis(&mut props, repo.visibility);
        self.doc_engine()?
            .create_document(&contract, DOC_CONFIG, props)
            .await
            .map(Some)
    }

    /// Edit the `repo` document's description and topics (only its owner may: `repo` is
    /// owner-mutable; `name`, `visibility` and `forkOf` are immutable). `Ok(false)` when it
    /// already holds them. Plaintext by design, private repos included (private-repos.md §7).
    pub async fn edit_repo(&self, repo: &RepoRef, edit: &RepoEdit) -> Result<bool> {
        edit.validate()?;
        let (_, contract) = self.writable(repo).await?;
        let mut changes = BTreeMap::new();
        if let Some(d) = &edit.description {
            changes.insert(
                "description".to_string(),
                (!d.is_empty()).then(|| FieldValue::text(d)),
            );
        }
        if let Some(t) = &edit.topics {
            changes.insert(
                "topics".to_string(),
                (!t.is_empty()).then(|| FieldValue::text_list(t.clone())),
            );
        }
        if changes.is_empty() {
            return Ok(false);
        }
        self.doc_engine()?
            .replace_document(&contract, "repo", repo.id(), &changes)
            .await
    }

    /// Write a `packManifest` (member-gated). Returns the manifest document id.
    pub async fn write_pack_manifest(
        &self,
        repo: &RepoRef,
        manifest: &PackManifestInput,
    ) -> Result<String> {
        let (scope, contract) = self.writable(repo).await?;
        let props = manifest.props(&scope)?;
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
    ///
    /// `packManifest` is append-only, so this reads through the delta cache
    /// ([`crate::history`]): a repository's manifests are paged once, then each read costs one
    /// request for what landed since.
    pub async fn read_pack_manifests(&self, repo: &RepoRef) -> Result<Vec<PackManifestInfo>> {
        let (scope, contract) = self.readable(repo).await?;
        let spec = crate::history::HistorySpec::new(&contract, DOC_PACK_MANIFEST, &scope);
        let docs = crate::history::sync(self.client, &[spec], crate::history::Freshness::Now)
            .await?
            .pop()
            .unwrap_or_default();
        // Newest first, `($createdAt, $id)` descending.
        docs.iter().rev().map(manifest_info).collect()
    }

    /// Every manifest of `pack_hash` (each uploader may hold a copy).
    pub async fn read_pack_copies(
        &self,
        repo: &RepoRef,
        pack_hash: [u8; 32],
    ) -> Result<Vec<PackManifestInfo>> {
        // From the (delta-cached) manifest list: one request for what landed since, where a
        // `byHash` query would be one more round trip every push.
        Ok(self
            .read_pack_manifests(repo)
            .await?
            .into_iter()
            .filter(|m| m.pack_hash == pack_hash)
            .collect())
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
        PlatformBackend::new(&engine, &contract, &scope, self.identity_id()?)
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
        use crate::backends::platform::{chunk_documents, pipeline_window, CHUNK_DOC_TYPE};

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

        // Pipelined (P-6, D-910): up to `PIPELINE_WINDOW` chunk creates in flight, each signed
        // once with its own nonce from the SDK's nonce cache, as `PlatformBackend::put` does.
        // The proof wait (~1-2 s a write) is what bounded a sequential upload to ~0.6 chunk/s;
        // in flight together the chunks land at the rate blocks accept them. A chunk is
        // journaled the moment it lands, in any order, so an interrupted push resumes by
        // skipping exactly the chunks that landed. A nonce another in-flight write took is
        // recovered inside `create_landed` (confirmed by a proved read, else re-signed).
        let (done, todo): (Vec<_>, Vec<_>) = chunk_documents(bytes, pack_hash)
            .into_iter()
            .partition(|(seq, _)| journal.has(*seq));
        if !done.is_empty() {
            tracing::debug!(
                skipped = done.len(),
                "chunks already journaled; skipping them"
            );
        }
        let (engine, contract, scope) = (&engine, &contract, &scope);
        let mut landed = futures::stream::iter(todo.into_iter().map(|(seq, props)| async move {
            engine
                .create_landed(contract, CHUNK_DOC_TYPE, scope.scoped(props))
                .await
                .map(|prepared| (seq, prepared))
        }))
        .buffer_unordered(pipeline_window());
        while let Some(done) = landed.next().await {
            let (seq, prepared) = done?;
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
            scope.locator(&self.identity_id()?, &meta.pack_hash)
        )])
    }

    /// The uploader → current role map the pack reader rule ranks copies by.
    pub async fn copy_roles(&self, repo: &RepoRef) -> Result<RoleMap> {
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

    /// A reader over the user's gateway list with this repo's OWN public gateways first:
    /// they reach the node that holds the content, which a shared default gateway may not.
    /// Only trusted records count: the `…/ipfs/` bases `config.backend.uris` advertises
    /// (maintainer-written), then those in manifests uploaded by a CURRENT member (`roles`),
    /// at most [`crate::storage::read::MAX_REPO_GATEWAYS`]. A past writer or a stranger
    /// cannot put a stalling gateway ahead of every pack. A config that cannot be read only
    /// costs the preference, never the read.
    pub async fn repo_reader(
        &self,
        repo: &RepoRef,
        manifests: &[PackManifestInfo],
        roles: &RoleMap,
    ) -> PackReader {
        let mut backend = Vec::new();
        if let Ok((scope, contract)) = self.readable(repo).await {
            if let Ok(Some(config)) = self
                .newest_config(&scope, &contract, crate::history::Freshness::Synced)
                .await
            {
                backend = scope::backend_uris(&config);
            }
        }
        PackReader::from_user_config()
            .prefer_gateways(trusted_repo_gateways(&backend, manifests, roles))
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
        // A read: chunks are fetched with the connection alone, no signing key, so a clone of
        // a public repo works without an identity.
        let mut last = Error::NotFound;
        for locator in &platform {
            let read = match crate::backends::PlatformLocator::parse(locator) {
                Ok(loc) => {
                    crate::backends::platform::read_platform_pack(self.client, contract, &loc).await
                }
                Err(e) => Err(e),
            };
            match read {
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

    /// Every git pack of `git` (best copy, opened), with its hash, for a repack. A pack this
    /// identity cannot open is left out (see the caller).
    async fn open_live_packs(
        &self,
        repo: &RepoRef,
        contract: &LoadedContract,
        manifests: &[PackManifestInfo],
        git: &[PackManifestInfo],
        roles: &RoleMap,
    ) -> Result<(Vec<Vec<u8>>, Vec<[u8; 32]>)> {
        let reader = self.repo_reader(repo, manifests, roles).await;
        let mut pack_blobs = Vec::new();
        let mut blob_hashes = Vec::new();
        for (hash, copies) in group_by_hash(git) {
            let (sealed, m) = self
                .fetch_best_copy(repo, contract, &copies, roles, &reader)
                .await
                .map_err(|e| {
                    Error::Io(format!(
                        "repack: pack {} is unreadable: {e}",
                        hex::encode(hash)
                    ))
                })?;
            // A pack this reader cannot open (late, or under an epoch it holds no key for) is
            // left out, as reseed skips unreadable packs; the new pack is built from the tips
            // and fails loudly if it needed objects only such a pack held.
            match self
                .open_artifact_of(repo, &copies, m.size_bytes, sealed)
                .await
            {
                Ok(plain) => {
                    pack_blobs.push(plain);
                    blob_hashes.push(hash);
                }
                Err(e) => {
                    tracing::warn!(pack = %hex::encode(hash), error = %e, "repack: skipping a pack this identity cannot open");
                }
            }
        }
        Ok((pack_blobs, blob_hashes))
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
        let caller = self.identity_id()?;

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
        let (pack_blobs, blob_hashes) = self
            .open_live_packs(repo, &contract, &manifests, &git, &roles)
            .await?;
        let tip_refs: Vec<&str> = tips.iter().map(String::as_str).collect();
        let consolidated = crate::pack::repack_from_packs(&pack_blobs, &tip_refs)?;
        let object_count = consolidated.parsed.object_count() as u64;
        // Already a single consolidated pack (compared on the plaintext: a private repo's
        // stored hash is of the sealed bytes, which differ on every seal). A manifest is
        // unique per (repo, uploader, packHash) and permanent: if the caller recorded that
        // pack, a repack can add nothing. If only other members did, the consolidation below
        // records the caller's own copy on `target` (more places for the same objects).
        refuse_own_consolidation(
            &git,
            &pack_blobs,
            &blob_hashes,
            &consolidated.bytes,
            &caller,
        )?;
        let new_bytes = self.pack_codec(repo).await?.seal(consolidated.bytes)?;
        let new_meta = PackMeta::for_bytes(&new_bytes);
        let new_pack_hash = new_meta.pack_hash_bytes()?;

        let balance_start = self.client.get_balance(&caller).await.unwrap_or(0);
        let stored = self
            .store_consolidated(repo, &new_bytes, &new_meta, target)
            .await?;
        let new_uris = stored.uris.clone();
        // A push that landed while this ran stored a pack the consolidation does not hold;
        // superseding it would hide objects its refs need. Re-read just before the write.
        let fresh = self.read_pack_manifests(repo).await?;
        refuse_raced_push(&git, &fresh)?;
        let (supersedes, new_manifest_id) = self
            .write_consolidated_manifest(
                repo,
                &fresh,
                &ConsolidatedPack {
                    pack_hash: new_pack_hash,
                    size_bytes: new_bytes.len() as u64,
                    object_count,
                    chunk_count: stored.chunk_count,
                    storage: stored.storage,
                    uris: stored.uris,
                    tips: &tips,
                    roles: &roles,
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
        let remaining = repack_remaining(&fresh, &roles, new_pack_hash);
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
            remaining,
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
        let supersedes = repack_supersedes(manifests, pack.roles, pack.pack_hash);
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
        let me = self.identity_id()?;
        let manifests = self.read_pack_manifests(repo).await?;
        let git = git_pack_manifests(&manifests);
        let roles = self.copy_roles(repo).await?;
        let reader = self.repo_reader(repo, &manifests, &roles).await;
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
        let roles = self.copy_roles(repo).await.unwrap_or_default();
        let reader = self.repo_reader(repo, &manifests, &roles).await;
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
            // A private repo's recorded bytes are sealed; a fetched clone holds plaintext, so
            // only the pusher's kept copy can restore them.
            let local = match repo.visibility {
                Visibility::Public => crate::storage::local::find_local_pack(git_dir, m.pack_hash)?,
                Visibility::Private => crate::storage::local::find_kept_pack(git_dir, m.pack_hash)?,
            };
            let Some(bytes) = local else {
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
        // A manifest names at most MAX_SUPERSEDES packs: past that, the newest ones. The rest
        // stay live, and readers still merge them (they index a prefix of the space).
        let supersedes = live_locator_manifests(&manifests)
            .iter()
            .take(fold_limit())
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
        // The pack's own manifest must be listed before its position can be known, and the
        // node answering may be a block behind the one that confirmed it (D-920).
        let roles = self.copy_roles(repo).await?;
        // Test affordance, compiled only with `--features test-hooks`: every read misses the
        // pushed pack's manifest, as a lagging node's did for dashpay/dash, so the e2e can
        // prove the skip is reported and `dg repo reindex` repairs it.
        #[cfg(feature = "test-hooks")]
        let lagging = std::env::var_os("DASH_FORGE_TEST_MANIFEST_LAG").is_some();
        #[cfg(not(feature = "test-hooks"))]
        let lagging = false;
        let (manifests, plan) = read_push_index_plan(&roles, pack_hash, || async {
            let mut ms = self.read_pack_manifests(repo).await?;
            if lagging {
                ms.retain(|m| m.pack_hash != pack_hash);
            }
            Ok(ms)
        })
        .await?;
        let space_len = locator_pack_space(&manifests, &roles, None).len();
        let (pack_ref, live_locators, fold) = match plan {
            PushIndexPlan::NotListed => {
                return Ok(PushIndexOutcome::Skipped(IndexSkip::new(
                    "the pack's manifest is not listed yet by the nodes read",
                    IndexRemedy::Reindex,
                )))
            }
            PushIndexPlan::Skip(why) => return Ok(PushIndexOutcome::Skipped(why)),
            PushIndexPlan::Publish {
                pack_ref,
                live_locators,
                fold,
            } => (pack_ref, live_locators, fold),
        };

        // Oldest-first for a stable row order; rows are keyed by `(oid, packRef)`. Without a
        // fold the fragment is the pushed pack's rows alone.
        let folded_in = if fold {
            match self
                .read_live_fragments(repo, &manifests, &roles, &live_locators)
                .await
            {
                Ok(parts) => parts,
                // A fold needs every live fragment's rows; one that cannot be read is a storage
                // problem a reindex cannot repair (it refuses the same fragment).
                Err(e) => {
                    return Ok(PushIndexOutcome::Skipped(IndexSkip::new(
                        format!("a live index fragment cannot be read to fold it: {e}"),
                        IndexRemedy::Restore,
                    )))
                }
            }
        } else {
            Vec::new()
        };
        let own = crate::pack::ObjectLocator::build(pack, pack_ref)?;
        let parts: Vec<&crate::pack::ObjectLocator> =
            folded_in.iter().chain(std::iter::once(&own)).collect();
        let locator = crate::pack::ObjectLocator::merge(&parts);
        // A row naming a pack past the end of the live space means one fragment was built
        // over a different space — publish nothing rather than supersede the parts with an
        // index that addresses packs the reader cannot resolve.
        if locator
            .max_pack_ref()
            .is_some_and(|r| usize::from(r) >= space_len)
        {
            return Ok(PushIndexOutcome::Skipped(IndexSkip::new(
                FRAGMENT_OUTSIDE_SPACE,
                IndexRemedy::Repack,
            )));
        }
        let supersedes = if fold {
            live_locators.iter().map(|m| m.pack_hash).collect()
        } else {
            Vec::new()
        };
        let manifest_id = self
            .store_locator(repo, &locator, supersedes, target)
            .await?;
        Ok(if fold {
            PushIndexOutcome::Consolidated {
                manifest_id,
                folded: live_locators.len(),
            }
        } else {
            PushIndexOutcome::Fragment {
                manifest_id,
                pack_ref,
            }
        })
    }

    /// Whether a fragment readers merge already covers git pack `pack_hash` (a retry of a push
    /// that recorded the pack but died before its index, D-920). `Ok(false)` when the pack is
    /// not listed at all. Reads the fragments a reader would (small artifacts).
    pub async fn is_pack_indexed(&self, repo: &RepoRef, pack_hash: [u8; 32]) -> Result<bool> {
        let manifests = self.read_pack_manifests(repo).await?;
        let roles = self.copy_roles(repo).await?;
        let space = locator_pack_space(&manifests, &roles, None);
        let hash = hex::encode(pack_hash);
        let Some(pack_ref) = space
            .iter()
            .find(|p| p.pack_hash == hash)
            .and_then(|p| u16::try_from(p.pack_ref).ok())
        else {
            return Ok(false);
        };
        let merged = index_fragments(&manifests, &roles);
        Ok(self
            .read_fragments(repo, &manifests, &roles, &merged)
            .await?
            .iter()
            .any(|(_, f)| f.pack_ref_iter().any(|r| r == pack_ref)))
    }

    /// Download and parse the live index fragments `live` (newest first), oldest first.
    async fn read_live_fragments(
        &self,
        repo: &RepoRef,
        manifests: &[PackManifestInfo],
        roles: &RoleMap,
        live: &[PackManifestInfo],
    ) -> Result<Vec<crate::pack::ObjectLocator>> {
        let contract = self.repo_contract(repo).await?;
        let reader = self.repo_reader(repo, manifests, roles).await;
        let kind = u64::from(crate::pack::KIND_OBJECT_LOCATOR);
        let mut parts = Vec::with_capacity(live.len());
        for m in live.iter().rev() {
            // Every uploader's copy of the fragment, in reader order: one dead copy must not
            // fail a fold another copy can serve.
            let copies: Vec<&PackManifestInfo> = manifests
                .iter()
                .filter(|c| c.kind == kind && c.pack_hash == m.pack_hash)
                .collect();
            let copies = if copies.is_empty() { vec![m] } else { copies };
            let (sealed, best) = self
                .fetch_best_copy(repo, &contract, &copies, roles, &reader)
                .await?;
            let bytes = self
                .open_artifact_of(repo, &copies, best.size_bytes, sealed)
                .await?;
            parts.push(crate::pack::ObjectLocator::parse(&bytes)?);
        }
        Ok(parts)
    }

    /// What [`Self::reindex`] would publish: the stored git packs (with objects) that no index
    /// fragment a reader merges covers. Reads those fragments (small artifacts) to learn what
    /// they cover; stores nothing.
    ///
    /// Coverage is decided over the fragments the WEB merges ([`index_fragments`]: every
    /// kind-1 pack of the pack list, superseded or not), so a repository the web already reads
    /// as indexed is never indexed again. A fragment that cannot be read is refused: the web
    /// falls back for the whole repository while it cannot load one, so a new index would be
    /// paid for and change nothing. Only the fold decision uses the live set.
    pub async fn plan_reindex(&self, repo: &RepoRef) -> Result<ReindexPlan> {
        let manifests = self.read_pack_manifests(repo).await?;
        let roles = self.copy_roles(repo).await?;
        let space = locator_pack_space(&manifests, &roles, None);
        let merged = index_fragments(&manifests, &roles);
        if !fragments_index_prefixes(&manifests, &roles, &space, &merged) {
            return Err(Error::Config(format!(
                "{FRAGMENT_MISMATCH}; run `dg repack`"
            )));
        }
        let read = self
            .read_fragments(repo, &manifests, &roles, &merged)
            .await?;
        // A fragment the web merges but cannot load sends it to its fallback clone whatever
        // else is published: indexing its packs again would be paid for and change nothing.
        if let Some(bad) = merged
            .iter()
            .find(|m| !read.iter().any(|(r, _)| r.pack_hash == m.pack_hash))
        {
            return Err(Error::Config(format!(
                "index fragment {} cannot be read (no copy verifies, or this identity cannot \
                 open it); readers fall back to downloading the packs until it can be read, \
                 and a new index would not change that. Restore its storage (`dg reseed`), or \
                 check `dg storage status`",
                hex::encode(bad.pack_hash)
            )));
        }
        let covered: BTreeSet<u16> = read.iter().flat_map(|(_, f)| f.pack_ref_iter()).collect();
        let missing = uncovered_packs(&space, &covered)?;
        if let Some(p) = missing.iter().find(|p| u16::try_from(p.pack_ref).is_err()) {
            return Err(Error::Config(format!(
                "{} (pack {} sits at position {}); run `dg repack` to consolidate",
                pack_ref_overflow(space.len()),
                p.pack_hash,
                p.pack_ref
            )));
        }
        // Folded only when a push would fold: the live fragments at the cap, those read.
        let live = if missing.is_empty() {
            Vec::new()
        } else {
            fold_set(&live_locator_manifests(&manifests)).unwrap_or_default()
        };
        let fold = read
            .into_iter()
            .filter(|(m, _)| live.iter().any(|l| l.pack_hash == m.pack_hash))
            .collect();
        Ok(ReindexPlan {
            missing,
            fold,
            known: merged.iter().map(|m| m.pack_hash).collect(),
            manifests,
            roles,
        })
    }

    /// Download and parse the index fragments `fragments` (one representative copy each, as
    /// [`index_fragments`] lists them; the best verifying copy is read). One that cannot be
    /// read or parsed is left out and logged: it covers nothing.
    async fn read_fragments(
        &self,
        repo: &RepoRef,
        manifests: &[PackManifestInfo],
        roles: &RoleMap,
        fragments: &[PackManifestInfo],
    ) -> Result<Vec<(PackManifestInfo, crate::pack::ObjectLocator)>> {
        let contract = self.repo_contract(repo).await?;
        let reader = self.repo_reader(repo, manifests, roles).await;
        let locator = u64::from(crate::pack::KIND_OBJECT_LOCATOR);
        let mut out = Vec::with_capacity(fragments.len());
        for f in fragments {
            let copies: Vec<&PackManifestInfo> = manifests
                .iter()
                .filter(|m| m.kind == locator && m.pack_hash == f.pack_hash)
                .collect();
            let parsed = match self
                .fetch_best_copy(repo, &contract, &copies, roles, &reader)
                .await
            {
                Ok((sealed, m)) => match self
                    .open_artifact_of(repo, &copies, m.size_bytes, sealed)
                    .await
                {
                    Ok(bytes) => crate::pack::ObjectLocator::parse(&bytes),
                    Err(e) => Err(e),
                },
                Err(e) => Err(e),
            };
            match parsed {
                Ok(l) => out.push((f.clone(), l)),
                Err(e) => tracing::warn!(
                    fragment = %hex::encode(f.pack_hash),
                    error = %e,
                    "an index fragment is unreadable; the packs it covers count as unindexed"
                ),
            }
        }
        Ok(out)
    }

    /// Publish the browse index for the packs `plan` found unindexed (`plan.missing` must not
    /// be empty): download each (its best verifying copy), index it at its `packRef`, and
    /// store ONE index fragment over them all, folding the live fragments in when they are at
    /// [`MAX_LOCATOR_FRAGMENTS`]. Only the index is written: the packs are read, never stored
    /// again. A pack that cannot be read, or that an older client stored in a shape the index
    /// cannot describe, is reported in [`ReindexReport::skipped`] and the rest are indexed.
    pub async fn reindex(
        &self,
        repo: &RepoRef,
        plan: &ReindexPlan,
        target: RepackTarget<'_>,
    ) -> Result<ReindexReport> {
        let contract = self.repo_contract(repo).await?;
        let reader = self.repo_reader(repo, &plan.manifests, &plan.roles).await;
        let git = u64::from(crate::pack::KIND_GIT_PACK);
        let mut report = ReindexReport::default();
        let mut built = Vec::with_capacity(plan.missing.len());
        for p in &plan.missing {
            let hash = hash32(&p.pack_hash)
                .ok_or_else(|| Error::Config(format!("pack hash {} is not hex", p.pack_hash)))?;
            let copies: Vec<&PackManifestInfo> = plan
                .manifests
                .iter()
                .filter(|m| m.kind == git && m.pack_hash == hash)
                .collect();
            let indexed = async {
                let (sealed, m) = self
                    .fetch_best_copy(repo, &contract, &copies, &plan.roles, &reader)
                    .await
                    .map_err(|e| format!("unreadable: {e}"))?;
                let bytes = self
                    .open_artifact_of(repo, &copies, m.size_bytes, sealed)
                    .await
                    .map_err(|e| format!("unreadable: {e}"))?;
                let parsed = crate::pack::index_stored_pack(&bytes)
                    .map_err(|e| unindexable_reason(&e))?
                    .parsed;
                let pack_ref =
                    u16::try_from(p.pack_ref).map_err(|_| pack_ref_overflow(p.pack_ref))?;
                crate::pack::ObjectLocator::build(&parsed, pack_ref)
                    .map_err(|e| unindexable_reason(&e))
            }
            .await;
            match indexed {
                Ok(l) => built.push((p.clone(), l)),
                Err(why) => report.skipped.push((p.pack_hash.clone(), why)),
            }
        }

        // Re-read just before the write. A pack that landed since only appends to the space,
        // so every row built above still means the same pack; a repack (or a role change that
        // re-ranks a copy's kind) moves packs, and is refused. An index published meanwhile by
        // a push or another reindex is read, and the packs it covers are dropped from this one.
        let fresh = self.read_pack_manifests(repo).await?;
        let roles = self.copy_roles(repo).await?;
        let planned: Vec<V2Pack> = built.iter().map(|(p, _)| p.clone()).collect();
        let fold_live: Vec<PackManifestInfo> = plan.fold.iter().map(|(m, _)| m.clone()).collect();
        let arrived = recheck_reindex(&fresh, &roles, &planned, &plan.known, &fold_live)?;
        if !arrived.is_empty() {
            let covered: BTreeSet<u16> = self
                .read_fragments(repo, &fresh, &roles, &arrived)
                .await?
                .iter()
                .flat_map(|(_, f)| f.pack_ref_iter())
                .collect();
            built.retain(|(p, _)| u16::try_from(p.pack_ref).is_ok_and(|r| !covered.contains(&r)));
        }
        if built.is_empty() {
            return Ok(report);
        }

        let mut parts: Vec<&crate::pack::ObjectLocator> = built.iter().map(|(_, l)| l).collect();
        parts.extend(plan.fold.iter().map(|(_, l)| l));
        let locator = crate::pack::ObjectLocator::merge(&parts);
        let supersedes = plan.fold.iter().map(|(m, _)| m.pack_hash).collect();
        report.index_objects = locator.object_count() as u64;
        report.indexed = built.into_iter().map(|(p, _)| p.pack_hash).collect();
        report.manifest_id = Some(
            self.store_locator(repo, &locator, supersedes, target)
                .await?,
        );
        Ok(report)
    }

    /// Upload a locator artifact and record its `packManifest` (kind 1).
    async fn store_locator(
        &self,
        repo: &RepoRef,
        locator: &crate::pack::ObjectLocator,
        supersedes: Vec<[u8; 32]>,
        target: RepackTarget<'_>,
    ) -> Result<String> {
        let artifact = Artifact {
            kind: crate::pack::KIND_OBJECT_LOCATOR,
            plain: locator.as_bytes().to_vec(),
            rows: locator.object_count() as u64,
            supersedes,
            tips: Vec::new(),
        };
        self.store_artifact(repo, artifact, target).await
    }

    /// Seal (for a private repository) and upload a browse artifact that locates itself, then
    /// record its `packManifest`. Returns the manifest id.
    async fn store_artifact(
        &self,
        repo: &RepoRef,
        artifact: Artifact,
        target: RepackTarget<'_>,
    ) -> Result<String> {
        let bytes = self.pack_codec(repo).await?.seal(artifact.plain)?;
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
                kind: u64::from(artifact.kind),
                size_bytes: bytes.len() as u64,
                object_count: artifact.rows,
                chunk_count: stored.chunk_count,
                storage: stored.storage,
                uris: stored.uris,
                supersedes: artifact.supersedes,
                tips: artifact.tips.iter().map(|t| t.to_vec()).collect(),
            },
        )
        .await
    }

    /// What the next history index of `tip` should be (see [`plan_history_index`]), from the
    /// manifests and the repository's current members. Reads no artifact.
    pub async fn plan_history_publish(&self, repo: &RepoRef, tip: [u8; 20]) -> Result<HistoryPlan> {
        let manifests = self.read_pack_manifests(repo).await?;
        let roles = self.copy_roles(repo).await?;
        Ok(plan_history_index(&manifests, &roles, tip))
    }

    /// Store a history index [`prepare_history_index`] computed, through `target`: its version
    /// lists (kind 5) first, then its column index (kind 3), each with its `packManifest`. The
    /// column goes last so a reader that finds it can already find the lists of the same tip.
    pub async fn store_history_index(
        &self,
        repo: &RepoRef,
        prepared: PreparedHistory,
        target: RepackTarget<'_>,
    ) -> Result<HistoryPublished> {
        let PreparedHistory {
            index,
            artifact,
            column,
            ..
        } = prepared;
        let versions_manifest_id = match artifact {
            Some(a) => Some(self.store_artifact(repo, a, target).await?),
            None => None,
        };
        let manifest_id = match column {
            Some(c) => Some(self.store_artifact(repo, c, target).await?),
            None => None,
        };
        Ok(HistoryPublished {
            manifest_id,
            versions_manifest_id,
            rows: index.paths.len() as u64,
            delta: index.base.is_some(),
            commit_count: index.commit_count,
        })
    }
}

/// A self-locating browse artifact to store ([`RepoService::store_artifact`]).
struct Artifact {
    kind: u8,
    /// The plaintext bytes (sealed on the way out for a private repository).
    plain: Vec<u8>,
    /// `objectCount`: rows the artifact holds.
    rows: u64,
    supersedes: Vec<[u8; 32]>,
    tips: Vec<[u8; 20]>,
}

/// A live history index, as the manifests describe it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEntry {
    /// The artifact's `packHash`.
    pub pack_hash: [u8; 32],
    /// The tip it describes.
    pub tip: [u8; 20],
    /// For a delta: the tip of the full index it extends.
    pub base_tip: Option<[u8; 20]>,
    /// Its stored size (sealed, for a private repository).
    pub size_bytes: u64,
    /// For a full index: the stored bytes of every v2 delta a current member published over its
    /// tip, superseded ones included. Each push pays for its whole cumulative delta, so this is
    /// what the deltas over this base have cost so far ([`prepare_history_index`]).
    pub deltas_paid: u64,
}

/// What the next history index publish should do.
///
/// A history index is two artifacts of the same tip: its **version lists** (kind 5, the whole
/// index, format 2), which Blame and a path's History read, and its **column index** (kind 3,
/// the last-change column and the counts, format 1), which the file list and the commit counts
/// read. Each kind is its own series of full indexes and deltas (a delta's header names the full
/// index of its own kind). The version lists decide full or delta; the column follows them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryPlan {
    /// Both kinds already cover the tip: nothing to publish.
    pub covered: bool,
    /// The version lists already cover the tip (only its column index is missing).
    pub lists_covered: bool,
    /// The live FULL version-lists indexes by current members, newest first: the bases a delta
    /// may extend (the first on the new tip's first-parent chain).
    pub bases: Vec<HistoryEntry>,
    /// Every live version-lists index by a current member: what a full index supersedes, and
    /// the deltas of a base a new delta supersedes.
    pub live: Vec<HistoryEntry>,
    /// The repository has no version-lists manifest yet: this one is its first, which pays the
    /// first-of-kind fee ([`crate::cost::push_fees::HISTORY_FIRST_EXTRA`]).
    pub first: bool,
    /// Every live column index by a current member (a column delta extends the full one of its
    /// base tip; a full column supersedes them all).
    pub columns: Vec<HistoryEntry>,
    /// The repository has no column-index manifest yet (its first pays the first-of-kind fee).
    pub columns_first: bool,
}

impl HistoryPlan {
    /// The plan for a repository with no history index yet (a first push into a new one): a
    /// full index of each kind, their first.
    pub fn fresh() -> Self {
        Self {
            first: true,
            columns_first: true,
            ..Self::default()
        }
    }
}

/// What [`RepoService::store_history_index`] published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryPublished {
    /// The column index's manifest document id (kind 3), when one was published.
    pub manifest_id: Option<String>,
    /// The version lists' manifest document id (kind 5), when they were published.
    pub versions_manifest_id: Option<String>,
    /// Path rows it holds.
    pub rows: u64,
    /// A delta over a full index (else a full index).
    pub delta: bool,
    /// `git rev-list --count` of the tip.
    pub commit_count: u64,
}

/// A history index computed and ready to store ([`RepoService::store_history_index`]).
pub struct PreparedHistory {
    index: crate::pack::HistoryIndex,
    /// The version lists (kind 5); `None` when they already cover the tip.
    artifact: Option<Artifact>,
    /// The column index (kind 3); `None` when one already covers the tip.
    column: Option<Artifact>,
    /// The repository's first version-lists index (it pays the first-of-kind fee).
    first: bool,
    /// The repository's first column index.
    columns_first: bool,
    /// For a full index that replaces deltas which have cost as much as it: the delta over the
    /// same base, still readable, for a push whose cost guard declines the full index.
    fallback: Option<Box<PreparedHistory>>,
}

impl PreparedHistory {
    /// The cheaper delta to publish instead when the cost guard declines this full index.
    pub fn fallback(&self) -> Option<&PreparedHistory> {
        self.fallback.as_deref()
    }

    /// Swap in [`Self::fallback`] (after the guard declined this one), if there is one.
    pub fn into_fallback(self) -> Option<PreparedHistory> {
        self.fallback.map(|b| *b)
    }

    /// The plaintext size of both artifacts (what the push prices; sealing adds a little).
    pub fn plain_len(&self) -> u64 {
        [&self.artifact, &self.column]
            .into_iter()
            .flatten()
            .map(|a| a.plain.len() as u64)
            .sum()
    }

    /// The price of storing both artifacts (an upper bound), sealed or not, with
    /// `external_targets` URIs and, when `platform`, their chunks.
    pub fn credits(&self, sealed: bool, external_targets: u64, platform: bool) -> u64 {
        [
            (&self.artifact, self.first),
            (&self.column, self.columns_first),
        ]
        .into_iter()
        .filter_map(|(a, first)| Some((a.as_ref()?, first)))
        .map(|(a, first)| {
            crate::cost::push_fees::history_index(
                a.plain.len() as u64,
                sealed,
                external_targets,
                platform,
                first,
            )
        })
        .sum()
    }

    /// The computed index.
    pub fn index(&self) -> &crate::pack::HistoryIndex {
        &self.index
    }

    /// Whether it is the repository's first history index.
    pub fn is_first(&self) -> bool {
        self.first || self.columns_first
    }
}

/// One kind's live history indexes: what [`plan_history_index`] reads from the manifests.
struct Series {
    /// Live indexes by current members, not superseded by a member's manifest, newest first,
    /// one per `packHash`.
    live: Vec<HistoryEntry>,
    /// Its full indexes, each with what the deltas over its tip have cost.
    bases: Vec<HistoryEntry>,
    /// An index of this kind covers `tip`.
    covered: bool,
    /// No manifest of this kind exists yet.
    first: bool,
}

/// The live indexes of `kind` among `manifests` (see [`Series`]).
fn series(manifests: &[PackManifestInfo], roles: &RoleMap, kind: u8, tip: [u8; 20]) -> Series {
    let kind = u64::from(kind);
    let member = |m: &PackManifestInfo| roles.contains_key(&m.owner_id);
    let superseded: BTreeSet<[u8; 32]> = manifests
        .iter()
        .filter(|m| member(m))
        .flat_map(|m| m.supersedes.iter().copied())
        .collect();
    // Newest first (the manifest list's order), one entry per packHash.
    let mut seen = BTreeSet::new();
    let live: Vec<HistoryEntry> = manifests
        .iter()
        .filter(|m| m.kind == kind && member(m) && !superseded.contains(&m.pack_hash))
        .filter(|m| seen.insert(m.pack_hash))
        .filter_map(|m| {
            Some(HistoryEntry {
                pack_hash: m.pack_hash,
                tip: *m.tips.first()?,
                base_tip: m.tips.get(1).copied(),
                size_bytes: m.size_bytes,
                deltas_paid: 0,
            })
        })
        .collect();
    // What the deltas over each base tip have cost: every such manifest by a member, once.
    let mut paid: BTreeMap<[u8; 20], u64> = BTreeMap::new();
    let mut counted = BTreeSet::new();
    for m in manifests {
        let Some(base_tip) = m.tips.get(1) else {
            continue;
        };
        if m.kind == kind && member(m) && counted.insert(m.pack_hash) {
            let sum = paid.entry(*base_tip).or_default();
            *sum = sum.saturating_add(m.size_bytes);
        }
    }
    // A delta covers its tip only while a live full index of its base tip stands behind it:
    // a reader could not overlay it otherwise (forge-web `historySource` applies the same rule).
    let full = |e: &&HistoryEntry| e.base_tip.is_none();
    let full_tips: BTreeSet<[u8; 20]> = live.iter().filter(full).map(|e| e.tip).collect();
    let covers = |e: &HistoryEntry| e.base_tip.is_none_or(|b| full_tips.contains(&b));
    Series {
        covered: live.iter().any(|e| e.tip == tip && covers(e)),
        bases: live
            .iter()
            .filter(full)
            .map(|e| HistoryEntry {
                deltas_paid: paid.get(&e.tip).copied().unwrap_or(0),
                ..e.clone()
            })
            .collect(),
        first: !manifests.iter().any(|m| m.kind == kind),
        live,
    }
}

/// Plan the history index publish for `tip` from the repository's manifests: the live version
/// lists (kind 5) and column indexes (kind 3), each by a current member and not superseded by a
/// member's manifest, whether both already cover `tip`, and the newest full version-lists index
/// a delta could extend.
pub fn plan_history_index(
    manifests: &[PackManifestInfo],
    roles: &RoleMap,
    tip: [u8; 20],
) -> HistoryPlan {
    let versions = series(manifests, roles, crate::pack::KIND_HISTORY_VERSIONS, tip);
    let columns = series(manifests, roles, crate::pack::KIND_HISTORY_INDEX, tip);
    HistoryPlan {
        covered: versions.covered && columns.covered,
        lists_covered: versions.covered,
        bases: versions.bases,
        live: versions.live,
        first: versions.first,
        columns: columns.live,
        columns_first: columns.first,
    }
}

/// Compute the history index for `tip` in the local repository `git_dir` as `plan` says: a
/// delta over the newest of `plan.bases` on `tip`'s first-parent chain while deltas stay the
/// cheaper choice ([`delta_pays`]), else a full index superseding the live ones; and its column
/// index ([`column_of`]). `None` when `plan` says both already cover `tip`. Local only: nothing
/// is read from or written to the network.
pub fn prepare_history_index(
    git_dir: &std::path::Path,
    tip: [u8; 20],
    plan: &HistoryPlan,
) -> Result<Option<PreparedHistory>> {
    use crate::pack::historyindex::compute;
    if plan.covered {
        return Ok(None);
    }
    let tip_hex = hex::encode(tip);
    let full_index = || -> Result<crate::pack::HistoryIndex> {
        compute(git_dir, &tip_hex, None)?
            .ok_or_else(|| Error::Config("history index: no full index computed".into()))
    };
    // A delta over the newest live full index whose tip is on the new tip's first-parent chain
    // (and the local repository holds it), while deltas pay ([`delta_pays`]).
    let mut fallback = None;
    for base in &plan.bases {
        let Ok(Some(mut delta)) = compute(git_dir, &tip_hex, Some(&hex::encode(base.tip))) else {
            continue;
        };
        delta.base = Some(base.pack_hash);
        let bytes = delta.to_compressed()?;
        let size = bytes.len() as u64;
        // A delta is cumulative: it replaces the earlier deltas of the same base.
        let earlier = plan.live.iter().filter(|e| e.base_tip == Some(base.tip));
        let column = column_of(&delta, Some(base.tip), plan, tip, &full_index)?;
        let delta = prepared(delta, bytes, vec![tip, base.tip], earlier, column, plan);
        if delta_pays(size, base) {
            return Ok(Some(delta));
        }
        // The deltas have cost a full index, but this one is still readable (at most half the
        // base): kept for a push whose cost guard declines the full index.
        if size.saturating_mul(2) <= base.size_bytes {
            fallback = Some(Box::new(delta));
        }
        // The newest base on the chain is too far behind: a full index, not an older base.
        break;
    }
    let index = full_index()?;
    let bytes = index.to_compressed()?;
    let column = column_of(&index, None, plan, tip, &full_index)?;
    let mut full = prepared(index, bytes, vec![tip], plan.live.iter(), column, plan);
    full.fallback = fallback;
    Ok(Some(full))
}

/// The column index (kind 3) to publish with the version lists `ix` of `tip` (a delta over the
/// full index of `base_tip`, or full): a delta over the live full column of the same base tip
/// superseding that base's earlier column deltas, else a full column superseding every live one.
/// `None` when a live column already covers `tip` with a full index of the same base behind it.
fn column_of(
    ix: &crate::pack::HistoryIndex,
    base_tip: Option<[u8; 20]>,
    plan: &HistoryPlan,
    tip: [u8; 20],
    full_index: &dyn Fn() -> Result<crate::pack::HistoryIndex>,
) -> Result<Option<Artifact>> {
    let full_columns: Vec<&HistoryEntry> = plan
        .columns
        .iter()
        .filter(|e| e.base_tip.is_none())
        .collect();
    let covered = plan.columns.iter().any(|e| {
        e.tip == tip
            && e.base_tip
                .is_none_or(|b| full_columns.iter().any(|f| f.tip == b))
    });
    if covered {
        return Ok(None);
    }
    let column_base = base_tip.and_then(|b| full_columns.iter().find(|f| f.tip == b));
    let (column, tips, replaces): (_, _, Vec<&HistoryEntry>) = match (base_tip, column_base) {
        (Some(b), Some(base)) => {
            let c = ix.column().with_base(base.pack_hash);
            let earlier = plan.columns.iter().filter(|e| e.base_tip == Some(b));
            (c, vec![tip, b], earlier.collect())
        }
        // Full lists, or a delta whose base tip has no live full column: a full column.
        (None, _) => (ix.column(), vec![tip], plan.columns.iter().collect()),
        (Some(_), None) => (
            full_index()?.column(),
            vec![tip],
            plan.columns.iter().collect(),
        ),
    };
    Ok(Some(Artifact {
        kind: crate::pack::KIND_HISTORY_INDEX,
        rows: column.paths.len() as u64,
        plain: column.to_compressed()?,
        supersedes: replaces
            .into_iter()
            .take(MAX_SUPERSEDES)
            .map(|e| e.pack_hash)
            .collect(),
        tips,
    }))
}

/// Whether a delta of `bytes` over `base` is worth publishing, rather than a full index.
///
/// A delta is cumulative, so every push pays for all the changes since the base again, and the
/// deltas' cost grows with the square of the pushes. Rent or buy: publish deltas until what they
/// have cost ([`HistoryEntry::deltas_paid`]) plus this one would reach the base's size, then a full
/// index. That spends at most twice what the best schedule would, and with deltas that grow about
/// linearly it republishes near the best point (on dashpay/dash, ~240 B per commit against a
/// 753 KB base: about every 80 one-commit pushes). A delta is never over half the base, so a reader
/// never downloads more for the pair than 1.5 bases.
fn delta_pays(bytes: u64, base: &HistoryEntry) -> bool {
    // Member-written sizes: saturating, so an absurd one can only end the deltas, never wrap.
    bytes.saturating_mul(2) <= base.size_bytes
        && base.deltas_paid.saturating_add(bytes) <= base.size_bytes
}

/// A computed index as the version-lists artifact to store (kind 5), superseding `replaces` (at
/// most [`MAX_SUPERSEDES`]), with its column index. The version lists are left out when a live
/// one already covers the tip (only the column was missing).
fn prepared<'e>(
    index: crate::pack::HistoryIndex,
    plain: Vec<u8>,
    tips: Vec<[u8; 20]>,
    replaces: impl Iterator<Item = &'e HistoryEntry>,
    column: Option<Artifact>,
    plan: &HistoryPlan,
) -> PreparedHistory {
    let artifact = (!plan.lists_covered).then(|| Artifact {
        kind: crate::pack::KIND_HISTORY_VERSIONS,
        rows: index.paths.len() as u64,
        plain,
        supersedes: replaces.take(MAX_SUPERSEDES).map(|e| e.pack_hash).collect(),
        tips,
    });
    PreparedHistory {
        index,
        artifact,
        column,
        first: plan.first,
        columns_first: plan.columns_first,
        fallback: None,
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
    // A verifier with no keys: a private repo's ref names are sealed and its hashes keyed.
    repo.require_public("verifying tips without keys")?;
    let scope = repo.scope()?;
    let contract = client.fetch_contract(&scope.contract_id).await?;
    let state =
        crate::refs::read_git_state(client, &contract, &scope, crate::history::Freshness::Now)
            .await?;
    let configs = state.config_history();
    let updates = state.ref_history(crate::backends::sha256(ref_name.as_bytes()));
    Ok(updates
        .iter()
        .filter(|u| rules::is_update_valid(u, &configs))
        .map(|u| u.new_oid.clone())
        .collect())
}

/// The default branch a repo without one (or without any config) uses.
pub const DEFAULT_BRANCH: &str = "main";

/// `config.protectedPatterns` holds at most this many globs (forge-core schema).
pub const MAX_PROTECTED_PATTERNS: usize = 8;
/// …of at most this many characters each.
pub const MAX_PATTERN_CHARS: usize = 100;
/// `repo.description` holds at most this many characters and bytes (forge-core schema).
pub const MAX_DESCRIPTION: (usize, usize) = (500, 1000);
/// `repo.topics`: at most 10 unique, `^[a-z0-9][a-z0-9-]*$`, 1–30 characters.
pub const MAX_TOPICS: usize = 10;

/// A repository's current configuration, as a settings reader and writer sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentConfig {
    /// The default branch, short (`main`).
    pub default_branch: String,
    /// The protected-ref globs (`refs/heads/main`).
    pub protected_patterns: Vec<String>,
    /// The `archived` flag (a client rule; consensus does not enforce it).
    pub archived: bool,
    /// `backend.mode`.
    pub backend_mode: u8,
    /// `backend.uris`.
    pub backend_uris: Vec<String>,
}

impl Default for CurrentConfig {
    fn default() -> Self {
        Self {
            default_branch: DEFAULT_BRANCH.into(),
            protected_patterns: Vec::new(),
            archived: false,
            backend_mode: 0,
            backend_uris: Vec::new(),
        }
    }
}

impl CurrentConfig {
    /// A public `config` document's fields.
    fn of_doc(d: &FetchedDocument) -> Self {
        let (backend_mode, backend_uris) = backend_parts(d.fields.get("backend"));
        Self {
            // Stored short (`main`); a config some other writer stored in full form reads the same.
            default_branch: d
                .field_str("defaultBranch")
                .map(|b| short_branch_name(&b).to_string())
                .filter(|b| !b.is_empty())
                .unwrap_or_else(|| DEFAULT_BRANCH.into()),
            protected_patterns: scope::doc_text_list(d, "protectedPatterns"),
            archived: d.field_bool("archived"),
            backend_mode,
            backend_uris,
        }
    }

    /// A private repository's decrypted config.
    fn of_private(cfg: &crate::keyring::PrivateConfig) -> Self {
        let (backend_mode, backend_uris) = backend_parts(cfg.backend.as_ref());
        Self {
            default_branch: cfg
                .default_branch
                .clone()
                .unwrap_or_else(|| DEFAULT_BRANCH.into()),
            protected_patterns: cfg.protected_patterns.clone(),
            archived: cfg.archived,
            backend_mode,
            backend_uris,
        }
    }

    /// `self` with `change` applied (unset fields carry over).
    #[must_use]
    pub fn apply(&self, change: &ConfigChange) -> Self {
        let mut next = self.clone();
        if let Some(b) = &change.default_branch {
            next.default_branch = short_branch_name(b).to_string();
        }
        if let Some(p) = &change.protected_patterns {
            next.protected_patterns.clone_from(p);
        }
        if let Some(a) = change.archived {
            next.archived = a;
        }
        if let Some(m) = change.backend_mode {
            next.backend_mode = m;
        }
        if let Some(u) = &change.backend_uris {
            next.backend_uris.clone_from(u);
        }
        next
    }

    /// The `backend` object to write.
    fn backend_value(&self) -> FieldValue {
        let mut backend = BTreeMap::new();
        backend.insert(
            "mode".to_string(),
            FieldValue::integer(u64::from(self.backend_mode)),
        );
        if !self.backend_uris.is_empty() {
            backend.insert(
                "uris".to_string(),
                FieldValue::text_list(self.backend_uris.clone()),
            );
        }
        FieldValue::Object(backend)
    }
}

/// The newest well-formed public `config` of `docs` by `($createdAt, $id)`.
fn newest_well_formed_config(docs: Vec<FetchedDocument>) -> Option<FetchedDocument> {
    docs.into_iter()
        .filter(crate::refs::config_well_formed)
        .max_by(|a, b| (a.created_at.unwrap_or(0), &a.id).cmp(&(b.created_at.unwrap_or(0), &b.id)))
}

/// `backend.mode` and `backend.uris` of a config's `backend` object.
fn backend_parts(backend: Option<&FieldValue>) -> (u8, Vec<String>) {
    match backend {
        Some(FieldValue::Object(b)) => (
            b.get("mode")
                .and_then(FieldValue::as_u64)
                .and_then(|m| u8::try_from(m).ok())
                .unwrap_or(0),
            scope::text_list(b.get("uris")),
        ),
        _ => (0, Vec::new()),
    }
}

/// `refs/heads/main` → `main` (the form `config.defaultBranch` stores); a short name as is.
#[must_use]
pub fn short_branch_name(b: &str) -> &str {
    b.strip_prefix("refs/heads/").unwrap_or(b)
}

/// Refuse a default branch the RC1 contract would refuse (`$defs.branch`: the ref grammar
/// with no leading `-`) or that no `git push` could create (`refs/heads/<branch>` must pass
/// `git check-ref-format` in 255 bytes).
pub fn check_default_branch(branch: &str) -> Result<()> {
    if rules::is_legal_branch_name(branch)
        && rules::is_git_ref_name(&format!("refs/heads/{branch}"))
    {
        return Ok(());
    }
    Err(Error::Config(format!(
        "{branch:?} is not a branch name: 1-244 bytes, not starting with '-', and passing \
         `git check-ref-format` (no spaces, control characters, `~^:?*[\\`, `..` or `@{{`)"
    )))
}

/// A change to a repository's configuration; `None` fields carry over.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfigChange {
    /// The new default branch (`main` or `refs/heads/main`).
    pub default_branch: Option<String>,
    /// The new protected-ref globs (the whole list).
    pub protected_patterns: Option<Vec<String>>,
    /// Archive (`true`) or unarchive.
    pub archived: Option<bool>,
    /// The new backend mode.
    pub backend_mode: Option<u8>,
    /// The new advertised read bases.
    pub backend_uris: Option<Vec<String>>,
}

impl ConfigChange {
    /// Refuse what the `config` schema would refuse, before anything is signed.
    pub fn validate(&self) -> Result<()> {
        if let Some(b) = &self.default_branch {
            check_default_branch(short_branch_name(b))?;
        }
        if let Some(p) = &self.protected_patterns {
            check_patterns(p)?;
        }
        if let Some(u) = &self.backend_uris {
            if !BACKEND_URIS_V2.fits(u) {
                return Err(Error::Config(format!(
                    "config.backend.uris holds at most {} URLs of at most {} bytes each",
                    BACKEND_URIS_V2.max_items, BACKEND_URIS_V2.max_item_len
                )));
            }
        }
        Ok(())
    }
}

/// Refuse a protected-pattern list the `config` schema would refuse: at most 8 globs of 1–100
/// characters, no whitespace or control characters, no duplicates.
pub fn check_patterns(patterns: &[String]) -> Result<()> {
    if patterns.len() > MAX_PROTECTED_PATTERNS {
        return Err(Error::Config(format!(
            "a repository holds at most {MAX_PROTECTED_PATTERNS} protected patterns"
        )));
    }
    let mut seen = BTreeSet::new();
    for p in patterns {
        let chars = p.chars().count();
        if chars == 0 || chars > MAX_PATTERN_CHARS {
            return Err(Error::Config(format!(
                "protected pattern {p:?} must be 1-{MAX_PATTERN_CHARS} characters"
            )));
        }
        if p.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(Error::Config(format!(
                "protected pattern {p:?} holds whitespace or a control character"
            )));
        }
        if !seen.insert(p.as_str()) {
            return Err(Error::Config(format!(
                "protected pattern {p:?} is listed twice"
            )));
        }
    }
    Ok(())
}

/// An edit of the `repo` document; `None` fields are left as they are, an empty value clears.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RepoEdit {
    /// The new description (`""` clears it).
    pub description: Option<String>,
    /// The new topics (the whole list; empty clears them).
    pub topics: Option<Vec<String>>,
}

impl RepoEdit {
    /// Refuse what the `repo` schema would refuse, before anything is signed.
    pub fn validate(&self) -> Result<()> {
        if let Some(d) = &self.description {
            let (chars, bytes) = MAX_DESCRIPTION;
            if d.chars().count() > chars || d.len() > bytes {
                return Err(Error::Config(format!(
                    "a description holds at most {chars} characters and {bytes} bytes"
                )));
            }
        }
        if let Some(t) = &self.topics {
            if t.len() > MAX_TOPICS {
                return Err(Error::Config(format!(
                    "a repository has at most {MAX_TOPICS} topics"
                )));
            }
            let mut seen = BTreeSet::new();
            for topic in t {
                let ok = (1..=30).contains(&topic.len())
                    && topic
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    && !topic.starts_with('-');
                if !ok {
                    return Err(Error::Config(format!(
                        "topic {topic:?}: use 1-30 of a-z, 0-9 and '-', not starting with '-'"
                    )));
                }
                if !seen.insert(topic.as_str()) {
                    return Err(Error::Config(format!("topic {topic:?} is listed twice")));
                }
            }
        }
        Ok(())
    }
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

/// The repo's own public gateways a reader should try first: `config.backend.uris`'s
/// (`backend`, maintainer-written), then those recorded in manifests whose uploader is a
/// current member (`roles`), capped ([`crate::storage::read::repo_gateways`]).
pub fn trusted_repo_gateways(
    backend: &[String],
    manifests: &[PackManifestInfo],
    roles: &RoleMap,
) -> Vec<String> {
    let members = manifests
        .iter()
        .filter(|m| roles.contains_key(&m.owner_id))
        .flat_map(|m| &m.uris);
    crate::storage::read::repo_gateways(backend.iter().chain(members))
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

/// `packManifest.supersedes` is a byteArray of at most 1024 bytes: 32 hashes.
pub const MAX_SUPERSEDES: usize = 1024 / 32;

/// Pack hashes a repack's consolidated manifest lists in `supersedes`: the git packs no
/// current member's manifest already names in `supersedes`, except the new one, in
/// pack-space order.
///
/// A pack an earlier repack superseded stays superseded (the manifest that says so is
/// permanent), so it needs no slot here. Claims made by another copy of the new pack itself
/// are named again: a copy is read on its own. A stranger's claim counts for nothing (the
/// reader rule ranks copies by role). Past [`MAX_SUPERSEDES`] the list is truncated: the
/// packs left over stay live, and another repack names them.
fn repack_supersedes(
    manifests: &[PackManifestInfo],
    roles: &RoleMap,
    new_pack_hash: [u8; 32],
) -> Vec<[u8; 32]> {
    let mut out = unclaimed_packs(manifests, roles, new_pack_hash);
    out.truncate(MAX_SUPERSEDES);
    out
}

/// How many live git packs a consolidated manifest for `new_pack_hash` could not name in
/// `supersedes`.
fn repack_remaining(
    manifests: &[PackManifestInfo],
    roles: &RoleMap,
    new_pack_hash: [u8; 32],
) -> usize {
    unclaimed_packs(manifests, roles, new_pack_hash)
        .len()
        .saturating_sub(MAX_SUPERSEDES)
}

/// [`repack_supersedes`] without the cap.
fn unclaimed_packs(
    manifests: &[PackManifestInfo],
    roles: &RoleMap,
    new_pack_hash: [u8; 32],
) -> Vec<[u8; 32]> {
    let claimed: BTreeSet<[u8; 32]> = manifests
        .iter()
        .filter(|m| m.pack_hash != new_pack_hash && roles.contains_key(&m.owner_id))
        .flat_map(|m| m.supersedes.iter().copied())
        .collect();
    let new_hash = hex::encode(new_pack_hash);
    locator_pack_space(manifests, &RoleMap::new(), None)
        .iter()
        .filter(|p| p.pack_hash != new_hash)
        .filter_map(|p| hash32(&p.pack_hash))
        .filter(|h| !claimed.contains(h))
        .collect()
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
    /// The pushed pack's manifest is not in the list yet: the node that answered is behind
    /// the one that confirmed the write. Read again ([`MANIFEST_VISIBLE_ATTEMPTS`]).
    NotListed,
    /// Publish nothing: why, and what repairs it.
    Skip(IndexSkip),
}

/// Reads of the manifest list a push makes before it gives up on seeing its own manifest.
/// Writes are confirmed by one node's proof and reads go to any node, so the first read after
/// a write can miss it (D-920: the 18,452-chunk dashpay/dash import landed with no browse
/// index because of exactly this).
const MANIFEST_VISIBLE_ATTEMPTS: u32 = 6;
/// The pause before the second read (about a block); each later pause doubles, capped at
/// [`MANIFEST_VISIBLE_MAX_DELAY`]: 1, 2, 4, 8, 8 s, about 23 s in all before giving up.
const MANIFEST_VISIBLE_DELAY: std::time::Duration = std::time::Duration::from_secs(1);
/// The longest pause between two of those reads.
const MANIFEST_VISIBLE_MAX_DELAY: std::time::Duration = std::time::Duration::from_secs(8);

/// Read the manifest list (`read`) and plan the push's index, reading again with a growing
/// pause while the pushed pack's manifest is not listed yet ([`PushIndexPlan::NotListed`]),
/// at most [`MANIFEST_VISIBLE_ATTEMPTS`] times. Returns the last list read and its plan.
async fn read_push_index_plan<F, Fut>(
    roles: &RoleMap,
    pack_hash: [u8; 32],
    mut read: F,
) -> Result<(Vec<PackManifestInfo>, PushIndexPlan)>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PackManifestInfo>>>,
{
    let mut delay = MANIFEST_VISIBLE_DELAY;
    let mut attempt = 1;
    loop {
        // A failed read spends an attempt like a lagging one: the push is already stored, so
        // one flaky node must not cost it its index, but the budget stays bounded.
        let last = attempt >= MANIFEST_VISIBLE_ATTEMPTS;
        match read().await {
            Ok(manifests) => {
                let plan = plan_push_index(&manifests, roles, pack_hash);
                if !matches!(plan, PushIndexPlan::NotListed) || last {
                    return Ok((manifests, plan));
                }
                tracing::info!(
                    attempt,
                    "the pushed pack's manifest is not listed yet; reading again"
                );
            }
            Err(e) if last => return Err(e),
            Err(e) => {
                tracing::info!(attempt, error = %e, "reading the manifest list failed; reading again");
            }
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(MANIFEST_VISIBLE_MAX_DELAY);
        attempt += 1;
    }
}

/// Why an index is not extended when a live fragment was built over another pack space
/// (remedy: `dg repack`).
const FRAGMENT_MISMATCH: &str =
    "a published index fragment no longer matches the pack set (a repack landed concurrently)";

/// The most live fragments one index manifest can fold (its `supersedes` names them all).
fn fold_limit() -> usize {
    MAX_SUPERSEDES
}

/// The skip reason when the pack space outgrew the locator's 16-bit `packRef`.
fn pack_ref_overflow(packs: usize) -> String {
    format!("the pack set has {packs} packs — past the locator's 16-bit packRef")
}

/// Whether every live fragment indexes a PREFIX of `space` (the pack space as of its first
/// upload), so the `packRef`s merged from them all mean the same packs. The space only grows
/// at the end between repacks, so this fails only when a fragment was published while a
/// repack changed the space.
fn fragments_index_prefixes(
    manifests: &[PackManifestInfo],
    roles: &RoleMap,
    space: &[V2Pack],
    live: &[PackManifestInfo],
) -> bool {
    live.iter().all(|m| {
        let as_of = locator_pack_space(
            manifests,
            roles,
            Some(&CopyKey {
                created_at: m.created_at,
                id: m.document_id.clone(),
            }),
        );
        as_of.len() <= space.len()
            && as_of
                .iter()
                .zip(space)
                .all(|(a, b)| a.pack_hash == b.pack_hash)
    })
}

/// Decide how a push should extend the browse index.
///
/// `manifests` should already include the pack just written; when no copy of it is listed
/// yet this says [`PushIndexPlan::NotListed`], so the caller reads again. Three ways this
/// declines, each meaning the index would otherwise start addressing the wrong bytes:
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
    if !manifests.iter().any(|m| m.pack_hash == pack_hash) {
        return PushIndexPlan::NotListed;
    }
    let space = locator_pack_space(manifests, roles, None);
    let hash = hex::encode(pack_hash);
    let Some(idx) = space.iter().position(|p| p.pack_hash == hash) else {
        return PushIndexPlan::Skip(IndexSkip::new(
            "the pushed pack is not in the git pack space — its index would address the \
             wrong bytes",
            IndexRemedy::None,
        ));
    };
    let Ok(pack_ref) = u16::try_from(idx) else {
        return PushIndexPlan::Skip(IndexSkip::new(
            pack_ref_overflow(space.len()),
            IndexRemedy::Repack,
        ));
    };

    // Checked over every fragment a reader merges (the web honours no `supersedes`), not
    // only the live ones: publishing into an index readers already reject helps nobody.
    if !fragments_index_prefixes(manifests, roles, &space, &index_fragments(manifests, roles)) {
        return PushIndexPlan::Skip(IndexSkip::new(FRAGMENT_MISMATCH, IndexRemedy::Repack));
    }
    let live_locators = live_locator_manifests(manifests);
    if !fragments_index_prefixes(manifests, roles, &space, &live_locators) {
        return PushIndexPlan::Skip(IndexSkip::new(FRAGMENT_MISMATCH, IndexRemedy::Repack));
    }
    let (fold, live_locators) = match fold_set(&live_locators) {
        Some(set) => (true, set),
        None => (false, live_locators),
    };
    PushIndexPlan::Publish {
        pack_ref,
        live_locators,
        fold,
    }
}

/// The repository's pack list (`FORGE_RULES_V2::v2_pack_list`, forge-v2.md §4) over its
/// manifests: every pack once, however many uploaders hold a copy, with its `packRef` among
/// the packs of its kind. `roles` ranks the copies.
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

/// Refuse a repack whose manifest list changed while it ran: a git pack in `fresh` that was
/// not in `read` (the set the consolidation was built from) came from a concurrent push.
fn refuse_raced_push(read: &[PackManifestInfo], fresh: &[PackManifestInfo]) -> Result<()> {
    let known: BTreeSet<[u8; 32]> = read.iter().map(|m| m.pack_hash).collect();
    let git = u64::from(crate::pack::KIND_GIT_PACK);
    if fresh
        .iter()
        .any(|m| m.kind == git && !known.contains(&m.pack_hash))
    {
        return Err(Error::Config(
            "repack: a push landed during the repack; nothing was recorded, run it again \
             (the consolidated pack already uploaded is content-addressed and is reused)"
                .into(),
        ));
    }
    Ok(())
}

/// A repack whose consolidated pack is one the caller already recorded can add nothing: its
/// manifest is unique per (repo, uploader, packHash) and permanent. `blobs[i]` is the
/// plaintext of the pack `hashes[i]`.
fn refuse_own_consolidation(
    git: &[PackManifestInfo],
    blobs: &[Vec<u8>],
    hashes: &[[u8; 32]],
    consolidated: &[u8],
    caller: &str,
) -> Result<()> {
    let Some(i) = blobs.iter().position(|b| b == consolidated) else {
        return Ok(());
    };
    if git
        .iter()
        .any(|m| m.pack_hash == hashes[i] && m.owner_id == caller)
    {
        return Err(Error::Config(
            "repack: the repo is already a single consolidated pack that you recorded; its \
             manifest is permanent, so a repack cannot add copies to it (new pushes follow the \
             storage policy)"
                .into(),
        ));
    }
    Ok(())
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
        uris,
        supersedes,
        tips: d
            .field_bytes("tips")
            .map(|raw| raw.as_chunks::<20>().0.to_vec())
            .unwrap_or_default(),
        created_at_block_height: d.created_at_block_height.unwrap_or_default(),
    })
}

/// The objects the browse index a push of `objects` objects publishes will cover, from the
/// repository's manifests: the push's own fragment, or, when the live fragments have
/// reached [`MAX_LOCATOR_FRAGMENTS`] (the push folds them into one index), every object they
/// index as well. For pricing the push before it is made.
pub fn push_index_objects(manifests: &[PackManifestInfo], objects: u64) -> u64 {
    let live = live_locator_manifests(manifests);
    if live.len() >= MAX_LOCATOR_FRAGMENTS {
        objects + live.iter().map(|m| m.object_count).sum::<u64>()
    } else {
        objects
    }
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

/// Refuse a ref update the RC1 contract would refuse, before anything is signed: a name
/// outside `git check-ref-format` ([`rules::is_git_ref_name`]: the `$defs.refName` pattern,
/// `@{` and `noLock` included), or an oid that is not exactly 20 or 32 bytes (`oidWidth`).
/// The name is also the injection defense (with [`rules::is_update_valid`] on the fold): a
/// control char or newline could inject a spoofed ref-advertisement line into every clone.
///
/// A delete (an all-zero `new_oid`) only needs the contract's grammar, so a maintainer can
/// remove a ref another client created that git itself could not (a middle `.lock` component).
fn check_ref_write(ref_name: &str, new_oid: &[u8], prev_oid: Option<&[u8]>) -> Result<()> {
    let delete = new_oid.iter().all(|&b| b == 0);
    let legal = if delete {
        rules::is_legal_ref_name(ref_name)
    } else {
        rules::is_git_ref_name(ref_name)
    };
    if !legal {
        return Err(Error::Config(format!(
            "illegal ref name {ref_name:?}: it must pass `git check-ref-format` (refs/…, at most \
             255 bytes; no spaces, control characters, `~^:?*[\\`, `..`, `@{{`, or a component \
             that starts with `.` or ends with `.lock`)"
        )));
    }
    if !oid_widths_ok(new_oid, prev_oid) {
        return Err(Error::Config(format!(
            "ref update of {ref_name:?} refused: an object id is 20 (SHA-1) or 32 (SHA-256) bytes"
        )));
    }
    Ok(())
}

/// RC1 `oidWidth` on a ref update: `newOid` is 20 or 32 bytes, and so is `prevOid` if present.
fn oid_widths_ok(new_oid: &[u8], prev_oid: Option<&[u8]>) -> bool {
    let ok = |o: &[u8]| matches!(o.len(), 20 | 32);
    ok(new_oid) && prev_oid.is_none_or(ok)
}

/// The document type a public ref update is written as: `protectedRefUpdate` for a ref the
/// current config protects, else `refUpdate`.
fn ref_doc_type(ref_name: &str, protected_patterns: &[String]) -> &'static str {
    if rules::matches_protected(ref_name, protected_patterns) {
        DOC_PROTECTED_REF_UPDATE
    } else {
        DOC_REF_UPDATE
    }
}

/// A public ref update's properties: the plain `refName`, its hash (the epoch is unused for
/// a public repository), the oids, `force` and `vis: "public"`.
fn public_ref_props(
    scope: &DocScope,
    ref_name: &str,
    new_oid: &[u8],
    prev_oid: Option<&[u8]>,
    force: bool,
) -> Result<BTreeMap<String, FieldValue>> {
    let mut props = scope.props([
        (
            "refNameHash",
            FieldValue::bytes32(crate::private::Public.hash(0, ref_name)?),
        ),
        ("refName", FieldValue::text(ref_name)),
        ("newOid", FieldValue::bytes(new_oid.to_vec())),
        ("force", FieldValue::boolean(force)),
    ]);
    if let Some(prev) = prev_oid {
        props.insert("prevOid".into(), FieldValue::bytes(prev.to_vec()));
    }
    layout::stamp_public(&mut props);
    Ok(props)
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
        order_copies, plan_push_index, read_push_index_plan, refuse_raced_push, repack_remaining,
        repack_supersedes, trusted_repo_gateways, uncovered_packs, PackManifestInfo, PushIndexPlan,
        RoleMap, MANIFEST_VISIBLE_ATTEMPTS, MANIFEST_VISIBLE_DELAY, MANIFEST_VISIBLE_MAX_DELAY,
        MAX_LOCATOR_FRAGMENTS,
    };
    use super::{
        fold_limit, fold_set, index_fragments, recheck_reindex, unindexable_reason, IndexRemedy,
        IndexSkip, FRAGMENT_MISMATCH, MAX_SUPERSEDES,
    };
    use crate::error::Error;
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
            uris: Vec::new(),
            supersedes: Vec::new(),
            tips: Vec::new(),
            created_at_block_height: 0,
        }
    }

    /// A history index manifest (kind 3) by `owner` for `tip` (and `base_tip` for a delta).
    /// `m` as the column index (kind 3) of the same tip, with packHash `[hash; 32]`.
    fn as_column(m: &PackManifestInfo, hash: u8) -> PackManifestInfo {
        PackManifestInfo {
            kind: u64::from(crate::pack::KIND_HISTORY_INDEX),
            pack_hash: [hash; 32],
            document_id: format!("{}-column", m.document_id),
            ..m.clone()
        }
    }

    fn history(
        id: &str,
        at: u64,
        hash: u8,
        owner: &str,
        tip: u8,
        base_tip: Option<u8>,
    ) -> PackManifestInfo {
        let mut m = manifest(id, at, crate::pack::KIND_HISTORY_VERSIONS, hash);
        m.owner_id = owner.into();
        m.tips = std::iter::once(tip)
            .chain(base_tip)
            .map(|t| [t; 20])
            .collect();
        m.size_bytes = 1000;
        m
    }

    /// Rent or buy: deltas over a base go on while their cumulative cost stays under the base's
    /// size; then a full index. Only deltas by members count toward it.
    #[test]
    fn deltas_stop_once_they_have_cost_a_full_index() {
        use super::{delta_pays, plan_history_index};
        let roles: RoleMap = [("w".to_string(), Role::Writer)].into();
        let base = {
            let mut b = history("f", 10, 1, "w", 0xa0, None);
            b.size_bytes = 10_000;
            b
        };
        let delta = |id: &str, hash: u8, size: u64, owner: &str| {
            let mut d = history(id, 20, hash, owner, 0xb0 + hash, Some(0xa0));
            d.size_bytes = size;
            d
        };
        // Two deltas paid 6,000 (one superseded by the other: both were paid for); a stranger's
        // does not count.
        let mut newer = delta("d2", 3, 4_000, "w");
        let older = delta("d1", 2, 2_000, "w");
        newer.supersedes = vec![older.pack_hash];
        let manifests = [delta("x", 4, 50_000, "stranger"), newer, older, base];
        let plan = plan_history_index(&manifests, &roles, [0xcc; 20]);
        let b = &plan.bases[0];
        assert_eq!(b.deltas_paid, 6_000);
        assert!(
            delta_pays(4_000, b),
            "6,000 + 4,000 reaches 10,000: still a delta"
        );
        assert!(!delta_pays(4_001, b), "past the base's size: a full index");
        let fresh = super::HistoryEntry {
            deltas_paid: 0,
            ..b.clone()
        };
        assert!(!delta_pays(5_001, &fresh), "never over half the base");
    }

    /// Review L8: when the deltas have cost a full index, the full one is prepared with the
    /// delta as a fallback, for a push whose cost guard declines the full index.
    #[test]
    fn a_due_full_index_carries_the_delta_as_a_fallback() {
        use super::{plan_history_index, prepare_history_index};
        let d = tempfile::TempDir::new().unwrap();
        let p = d.path();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(p)
                .args(args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@e.x")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@e.x")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let oid = |rev: &str| -> [u8; 20] {
            hex::decode(git(&["rev-parse", rev]))
                .unwrap()
                .try_into()
                .unwrap()
        };
        git(&["init", "-q", "-b", "main"]);
        for i in 0..200 {
            std::fs::write(p.join(format!("f{i}.txt")), format!("{i}")).unwrap();
        }
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "many"]);
        let base_tip = oid("HEAD");
        std::fs::write(p.join("f1.txt"), "changed").unwrap();
        git(&["commit", "-q", "-am", "edit"]);
        let tip = oid("HEAD");
        let roles: RoleMap = [("w".to_string(), Role::Writer)].into();
        let mut base = history("f", 10, 1, "w", 0, None);
        base.tips = vec![base_tip];
        base.size_bytes = 100_000;
        // Earlier deltas over it already cost its size.
        let mut paid = history("d", 20, 2, "w", 0x11, None);
        paid.tips = vec![[0x11; 20], base_tip];
        paid.size_bytes = 100_000;
        let plan = plan_history_index(&[paid, base], &roles, tip);
        let full = prepare_history_index(p, tip, &plan).unwrap().unwrap();
        assert!(full.index().base.is_none(), "a full index is due");
        let fallback = full.fallback().expect("the delta is offered");
        assert_eq!(fallback.index().base, Some([1; 32]));
        assert!(fallback.plain_len() < full.plain_len());
        assert_eq!(
            full.into_fallback()
                .unwrap()
                .artifact
                .as_ref()
                .unwrap()
                .tips,
            vec![tip, base_tip]
        );
    }

    /// Review M1: a delta covers its tip only while a live full index of its base tip stands
    /// behind it. A delta whose base was superseded (or was never a member's) covers nothing, so
    /// the tip gets an index again.
    #[test]
    fn an_orphaned_delta_does_not_cover_its_tip() {
        use super::plan_history_index;
        let roles: RoleMap = [("w".to_string(), Role::Writer)].into();
        let delta = history("d", 20, 2, "w", 0xb0, Some(0xa0));
        let base = history("f", 10, 1, "w", 0xa0, None);
        assert!(
            plan_history_index(&[delta.clone(), base.clone()], &roles, [0xb0; 20]).lists_covered
        );
        // The base's only copy is a stranger's: it is not live, so the delta is orphaned.
        let mut stranger_base = base.clone();
        stranger_base.owner_id = "x".into();
        assert!(
            !plan_history_index(&[delta.clone(), stranger_base], &roles, [0xb0; 20]).lists_covered
        );
        // A newer full index of another tip superseded the base: orphaned too.
        let mut newer = history("g", 30, 3, "w", 0xc0, None);
        newer.supersedes = vec![base.pack_hash];
        assert!(!plan_history_index(&[newer, delta, base], &roles, [0xb0; 20]).lists_covered);
    }

    /// Review M2: the delta's base is the newest live full index on the new tip's first-parent
    /// chain, tried newest first: a newer full index of a side branch's tip (not on the chain)
    /// is skipped for an older one that is.
    #[test]
    fn a_delta_extends_the_newest_full_index_on_the_chain() {
        use super::{plan_history_index, prepare_history_index};
        let d = tempfile::TempDir::new().unwrap();
        let p = d.path();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(p)
                .args(args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@e.x")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@e.x")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let oid = |rev: &str| -> [u8; 20] {
            hex::decode(git(&["rev-parse", rev]))
                .unwrap()
                .try_into()
                .unwrap()
        };
        git(&["init", "-q", "-b", "main"]);
        for i in 0..400 {
            std::fs::write(p.join(format!("f{i}.txt")), format!("{i}")).unwrap();
        }
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "many files"]);
        let on_chain = oid("HEAD");
        git(&["checkout", "-q", "-b", "side"]);
        std::fs::write(p.join("side.txt"), "s").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "side"]);
        let side = oid("HEAD");
        git(&["checkout", "-q", "main"]);
        std::fs::write(p.join("f1.txt"), "changed").unwrap();
        git(&["commit", "-q", "-am", "edit f1"]);
        let tip = oid("HEAD");
        let roles: RoleMap = [("w".to_string(), Role::Writer)].into();
        let full = |id: &str, at: u64, hash: u8, t: [u8; 20]| {
            let mut m = history(id, at, hash, "w", 0, None);
            m.tips = vec![t];
            m.size_bytes = 100_000;
            m
        };
        // Newest first: the side branch's full index, then the one on main's chain.
        let manifests = [full("s", 20, 9, side), full("m", 10, 1, on_chain)];
        let plan = plan_history_index(&manifests, &roles, tip);
        let got = prepare_history_index(p, tip, &plan).unwrap().unwrap();
        assert_eq!(
            got.index().base,
            Some([1; 32]),
            "extends the index on the chain"
        );
        assert_eq!(got.artifact.as_ref().unwrap().tips, vec![tip, on_chain]);
    }

    #[test]
    fn a_history_plan_finds_the_covering_index_the_base_and_the_live_set() {
        use super::plan_history_index;
        let roles: RoleMap = [("w".to_string(), Role::Writer)].into();
        // Newest first, as read_pack_manifests answers.
        let mut delta_old = history("d1", 20, 2, "w", 0xb0, Some(0xa0));
        let delta_new = {
            let mut d = history("d2", 30, 3, "w", 0xc0, Some(0xa0));
            d.supersedes = vec![delta_old.pack_hash];
            d
        };
        delta_old.created_at = 20;
        let stranger = history("x", 40, 9, "stranger", 0xee, None);
        let all = [
            stranger,
            delta_new.clone(),
            delta_old,
            history("f", 10, 1, "w", 0xa0, None),
        ];

        let plan = plan_history_index(&all, &roles, [0xc0; 20]);
        assert!(plan.lists_covered, "the newest delta covers its tip");
        let plan = plan_history_index(&all, &roles, [0xd0; 20]);
        assert!(!plan.lists_covered);
        // The base is the newest full index by a member: never a stranger's.
        let bases: Vec<[u8; 20]> = plan.bases.iter().map(|b| b.tip).collect();
        assert_eq!(bases, [[0xa0; 20]]);
        assert!(!plan.first);
        assert!(plan_history_index(&[], &roles, [0xd0; 20]).first);
        // The superseded delta is not live; the stranger's index never counts.
        let live: Vec<[u8; 32]> = plan.live.iter().map(|e| e.pack_hash).collect();
        assert_eq!(live, [delta_new.pack_hash, [1; 32]]);
        assert!(!plan_history_index(&all, &roles, [0xee; 20]).lists_covered);
    }

    #[test]
    fn a_delta_over_a_nearby_base_is_published_and_supersedes_the_bases_earlier_deltas() {
        use super::{plan_history_index, prepare_history_index};
        let d = tempfile::TempDir::new().unwrap();
        let p = d.path();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(p)
                .args(args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@e.x")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@e.x")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        for i in 0..400 {
            std::fs::write(p.join(format!("f{i}.txt")), format!("{i}")).unwrap();
        }
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "many files"]);
        let tip = |git: &dyn Fn(&[&str]) -> String| -> [u8; 20] {
            hex::decode(git(&["rev-parse", "HEAD"]))
                .unwrap()
                .try_into()
                .unwrap()
        };
        let base_tip = tip(&git);
        let roles: RoleMap = [("w".to_string(), Role::Writer)].into();

        // No index yet: a full one.
        let plan = plan_history_index(&[], &roles, base_tip);
        let full = prepare_history_index(p, base_tip, &plan).unwrap().unwrap();
        assert!(full.index().base.is_none());
        assert_eq!(full.index().paths.len(), 400);
        assert_eq!(full.artifact.as_ref().unwrap().tips, vec![base_tip]);

        // One file changes: a delta over the full index, superseding the base's older delta.
        std::fs::write(p.join("f3.txt"), "changed").unwrap();
        git(&["commit", "-q", "-am", "edit f3"]);
        let new_tip = tip(&git);
        let mut base = history("f", 10, 1, "w", 0, None);
        base.tips = vec![base_tip];
        base.size_bytes = full.plain_len();
        let mut older = history("d", 20, 2, "w", 0x11, None);
        older.tips = vec![[0x11; 20], base_tip];
        let manifests = [older, base];
        let plan = plan_history_index(&manifests, &roles, new_tip);
        let delta = prepare_history_index(p, new_tip, &plan).unwrap().unwrap();
        assert_eq!(delta.index().base, Some([1; 32]));
        let rows: Vec<&[u8]> = delta.index().paths.keys().map(Vec::as_slice).collect();
        assert_eq!(rows, [b"f3.txt".as_slice()]);
        assert_eq!(
            delta.artifact.as_ref().unwrap().tips,
            vec![new_tip, base_tip]
        );
        assert_eq!(delta.artifact.as_ref().unwrap().supersedes, vec![[2; 32]]);
        assert_eq!(delta.index().commit_count, 2);

        // No column index yet: a full one, superseding nothing.
        let column = delta.column.as_ref().unwrap();
        assert_eq!(column.kind, crate::pack::KIND_HISTORY_INDEX);
        assert_eq!(
            (column.tips.clone(), column.supersedes.len()),
            (vec![new_tip], 0)
        );

        // A full column of the base tip and an older column delta over it: the column is a delta
        // over that full column (its header names the kind-3 base), superseding the older one.
        let mut column_base = as_column(&manifests[1], 0x31);
        column_base.tips = vec![base_tip];
        let mut column_older = as_column(&manifests[0], 0x32);
        column_older.tips = vec![[0x11; 20], base_tip];
        let with_columns = [
            column_older,
            column_base,
            manifests[0].clone(),
            manifests[1].clone(),
        ];
        let plan = plan_history_index(&with_columns, &roles, new_tip);
        let delta = prepare_history_index(p, new_tip, &plan).unwrap().unwrap();
        let column = delta.column.as_ref().unwrap();
        assert_eq!(column.tips, vec![new_tip, base_tip]);
        assert_eq!(column.supersedes, vec![[0x32; 32]]);
        let parsed = crate::pack::HistoryIndex::parse_kind(&column.plain, column.kind).unwrap();
        assert_eq!(
            parsed.base,
            Some([0x31; 32]),
            "the column delta extends the kind-3 base"
        );
        assert_eq!(parsed, delta.index().column().with_base([0x31; 32]));

        // Covered: nothing to do, once both kinds cover the tip.
        let mut covering = history("c", 30, 3, "w", 0, None);
        covering.tips = vec![new_tip];
        let plan = plan_history_index(std::slice::from_ref(&covering), &roles, new_tip);
        assert!(
            plan.lists_covered && !plan.covered,
            "the column is still missing"
        );
        let only_column = prepare_history_index(p, new_tip, &plan).unwrap().unwrap();
        assert!(
            only_column.artifact.is_none(),
            "the lists are not published again"
        );
        assert!(only_column.column.is_some());
        let both = [as_column(&covering, 0x33), covering];
        let plan = plan_history_index(&both, &roles, new_tip);
        assert!(prepare_history_index(p, new_tip, &plan).unwrap().is_none());
    }

    #[test]
    fn a_base_off_the_chain_or_a_big_delta_gets_a_full_index_superseding_the_live_set() {
        use super::{plan_history_index, prepare_history_index};
        let d = tempfile::TempDir::new().unwrap();
        let p = d.path();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(p)
                .args(args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@e.x")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@e.x")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(p.join("a"), "1").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "one"]);
        std::fs::write(p.join("a"), "2").unwrap();
        git(&["commit", "-q", "-am", "two"]);
        let head: [u8; 20] = hex::decode(git(&["rev-parse", "HEAD"]))
            .unwrap()
            .try_into()
            .unwrap();
        let roles: RoleMap = [("w".to_string(), Role::Writer)].into();
        // A base whose tip this clone does not hold: full.
        let unknown = history("f", 10, 1, "w", 0x42, None);
        let plan = plan_history_index(std::slice::from_ref(&unknown), &roles, head);
        let got = prepare_history_index(p, head, &plan).unwrap().unwrap();
        assert!(got.index().base.is_none());
        assert_eq!(got.artifact.as_ref().unwrap().supersedes, vec![[1; 32]]);
        // A base on the chain but tiny: the delta (every path) is not under half of it.
        let parent: [u8; 20] = hex::decode(git(&["rev-parse", "HEAD~1"]))
            .unwrap()
            .try_into()
            .unwrap();
        let mut small = history("f", 10, 1, "w", 0, None);
        small.tips = vec![parent];
        small.size_bytes = 10;
        let plan = plan_history_index(&[small], &roles, head);
        assert!(prepare_history_index(p, head, &plan)
            .unwrap()
            .unwrap()
            .index()
            .base
            .is_none());
    }

    #[test]
    fn only_trusted_records_name_the_repos_own_gateways() {
        let mut member = manifest("m", 1, 0, 1);
        member.owner_id = "writer".into();
        member.uris = vec!["https://member-gw.example/ipfs/bafym".into()];
        let mut stranger = manifest("s", 2, 0, 2);
        stranger.owner_id = "former-writer".into();
        stranger.uris = vec!["https://stall.example/ipfs/bafys".into()];
        let mut roles = RoleMap::new();
        roles.insert("writer".into(), Role::Writer);
        let backend = vec!["https://config-gw.example/ipfs/".to_string()];
        assert_eq!(
            trusted_repo_gateways(&backend, &[stranger.clone(), member.clone()], &roles),
            vec!["https://config-gw.example", "https://member-gw.example"]
        );
        // With no member list, only the maintainer-written config counts.
        assert_eq!(
            trusted_repo_gateways(&backend, &[stranger, member], &RoleMap::new()),
            vec!["https://config-gw.example"]
        );
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

    /// A push that will fold the browse index is priced for the whole folded index; one that
    /// adds a fragment, for its own objects.
    #[test]
    fn a_folding_push_prices_every_object_it_indexes() {
        let fragments = |n: usize| -> Vec<PackManifestInfo> {
            (0..n)
                .map(|i| {
                    let mut m = manifest(
                        &format!("{:02x}", i + 1),
                        100 + i as u64,
                        crate::pack::KIND_OBJECT_LOCATOR,
                        u8::try_from(i + 1).unwrap(),
                    );
                    m.object_count = 1_000;
                    m
                })
                .collect()
        };
        assert_eq!(
            super::push_index_objects(&fragments(MAX_LOCATOR_FRAGMENTS - 1), 7),
            7
        );
        assert_eq!(
            super::push_index_objects(&fragments(MAX_LOCATOR_FRAGMENTS), 7),
            7 + 1_000 * MAX_LOCATOR_FRAGMENTS as u64
        );
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
    fn a_ref_update_is_routed_and_checked_like_the_single_write() {
        assert_eq!(
            super::ref_doc_type("refs/heads/main", &["refs/heads/main".into()]),
            crate::refs::DOC_PROTECTED_REF_UPDATE
        );
        assert_eq!(
            super::ref_doc_type("refs/heads/dev", &["refs/heads/main".into()]),
            crate::refs::DOC_REF_UPDATE
        );
        let oid = [1u8; 20];
        assert!(super::check_ref_write("refs/heads/ok", &oid, None).is_ok());
        assert!(super::check_ref_write("refs/heads/bad\nname", &oid, None).is_err());
        // git cannot create a middle `.lock` component, but a ref another client wrote with
        // one (the contract accepts it) can still be deleted.
        assert!(super::check_ref_write("refs/heads/x.lock/y", &oid, None).is_err());
        assert!(super::check_ref_write("refs/heads/x.lock/y", &[0; 20], Some(&oid)).is_ok());
        assert!(super::check_ref_write("refs/heads/bad\nname", &[0; 20], None).is_err());
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
            PushIndexPlan::NotListed => Err("not listed".into()),
            PushIndexPlan::Skip(skip) => Err(skip.reason),
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
            matches!(&got, PushIndexPlan::Skip(s)
                if s.reason.contains("not in the git pack space") && s.remedy == IndexRemedy::None),
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
        let roles: RoleMap = [("owner", Role::Maintainer), ("bob", Role::Writer)]
            .into_iter()
            .map(|(i, r)| (i.to_string(), r))
            .collect();
        let out = repack_supersedes(&[new, prev, bob], &roles, [9u8; 32]);
        assert_eq!(out, vec![[2u8; 32]], "P1 is already superseded by `prev`");
    }

    /// M-B: when another member already recorded the consolidated pack, the caller's copy
    /// names the packs that copy supersedes again (a copy is read on its own).
    /// M-A: a stranger's claim does not count as already claimed.
    #[test]
    fn repack_supersedes_renames_claims_of_the_same_pack_and_ignores_strangers() {
        let old = manifest("old", 100, 0, 1);
        let mut other_copy = manifest("theirs", 300, 0, 9);
        other_copy.owner_id = "bob".into();
        other_copy.supersedes = vec![[1u8; 32]];
        let roles: RoleMap = [("bob".to_string(), Role::Writer)].into_iter().collect();
        let out = repack_supersedes(&[other_copy.clone(), old.clone()], &roles, [9u8; 32]);
        assert_eq!(out, vec![[1u8; 32]]);
        // A stranger's claim on pack 1 (in an unrelated pack 5) is not a claim.
        let mut stranger = manifest("s", 200, 0, 5);
        stranger.owner_id = "mallory".into();
        stranger.supersedes = vec![[1u8; 32]];
        let out = repack_supersedes(&[stranger, old], &roles, [9u8; 32]);
        assert!(out.contains(&[1u8; 32]), "{out:?}");
    }

    /// H-B: a push that lands between the pack reads and the manifest write aborts the
    /// repack instead of superseding a pack the consolidation does not hold.
    #[test]
    fn a_push_during_a_repack_aborts_it() {
        let read = vec![manifest("a", 100, 0, 1), manifest("b", 200, 0, 2)];
        let mut fresh = read.clone();
        assert!(refuse_raced_push(&read, &fresh).is_ok());
        // Another uploader's copy of a known pack, or a locator fragment, is no race.
        let mut copy = manifest("a2", 250, 0, 1);
        copy.owner_id = "bob".into();
        fresh.push(copy);
        fresh.push(manifest("loc", 260, 1, 7));
        assert!(refuse_raced_push(&read, &fresh).is_ok());
        fresh.push(manifest("c", 300, 0, 3));
        let err = refuse_raced_push(&read, &fresh).unwrap_err().to_string();
        assert!(err.contains("a push landed during the repack"), "{err}");
    }

    #[test]
    fn repack_supersedes_never_names_the_new_pack_and_stays_within_the_field() {
        // `supersedes` is a 1024-byte packed byteArray: 32 hashes, no more. Past that the
        // list is truncated rather than failing the write.
        let mut manifests = vec![manifest("new", 999, 0, 9)];
        for i in 0..40u8 {
            manifests.push(manifest(&format!("p{i}"), 100 + u64::from(i), 0, i + 10));
        }
        let out = repack_supersedes(&manifests, &RoleMap::new(), [9u8; 32]);
        assert_eq!(out.len(), 32);
        assert_eq!(repack_remaining(&manifests, &RoleMap::new(), [9u8; 32]), 8);
        // A second repack names the rest (and the first consolidation).
        let roles: RoleMap = [("owner".to_string(), Role::Maintainer)]
            .into_iter()
            .collect();
        manifests[0].supersedes = out.clone();
        let second = repack_supersedes(&manifests, &roles, [7u8; 32]);
        assert_eq!(second.len(), 9, "{second:?}");
        assert!(second.contains(&[9u8; 32]) && second.contains(&[49u8; 32]));
        assert_eq!(repack_remaining(&manifests, &roles, [7u8; 32]), 0);
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
        // With no membership known, the order is by time.
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

    /// D-920: the push's first manifest read answered from a node that did not list the
    /// just-confirmed manifest yet, and the push published no browse index at all. Not yet
    /// listed is its own answer, distinct from a pack that is listed under another kind.
    #[test]
    fn push_index_plan_says_not_listed_when_the_pushed_manifest_is_not_visible_yet() {
        let lagging = vec![manifest("p1", 100, 0, 1)];
        assert!(matches!(
            plan_push_index(&lagging, &RoleMap::new(), [2; 32]),
            PushIndexPlan::NotListed
        ));
        // An empty list, as the first push of a repository saw it (dashpay/dash).
        assert!(matches!(
            plan_push_index(&[], &RoleMap::new(), [2; 32]),
            PushIndexPlan::NotListed
        ));
        let mut caught_up = lagging;
        caught_up.push(manifest("p2", 200, 0, 2));
        assert_eq!(plan(&caught_up, 2), Ok((1, false, 0)));
    }

    /// D-920 end to end, with the manifest reader mocked: the node answering the push's first
    /// reads is behind and does not list the pack the push just recorded. The push must read
    /// again (backing off) and then plan to PUBLISH the fragment at the pack's position. Before
    /// the fix the first read decided, and the plan was a skip: no index was ever published.
    #[tokio::test(start_paused = true)]
    async fn a_push_whose_first_manifest_reads_lag_still_publishes_its_index() {
        let reads = std::cell::Cell::new(0u32);
        let lagging_node = || {
            reads.set(reads.get() + 1);
            // The pack recorded earlier is listed; the one this push just recorded shows up
            // only from the third read on.
            let mut ms = vec![manifest("p1", 100, 0, 1)];
            if reads.get() >= 3 {
                ms.push(manifest("p2", 200, 0, 2));
            }
            async move { Ok(ms) }
        };
        let started = tokio::time::Instant::now();
        let (manifests, plan) = read_push_index_plan(&RoleMap::new(), [2; 32], lagging_node)
            .await
            .unwrap();
        assert!(
            matches!(
                plan,
                PushIndexPlan::Publish {
                    pack_ref: 1,
                    fold: false,
                    ..
                }
            ),
            "{plan:?}"
        );
        assert_eq!(manifests.len(), 2);
        assert_eq!(reads.get(), 3, "stops at the first read that lists it");
        // Backed off 1 s, then 2 s.
        assert_eq!(started.elapsed(), std::time::Duration::from_secs(3));
    }

    /// D-920: a manifest that never shows up is given up on after a bounded number of reads
    /// (the push then reports the skip, with `dg repo reindex` as the fix).
    #[tokio::test(start_paused = true)]
    async fn a_manifest_that_never_shows_up_is_given_up_on() {
        let reads = std::cell::Cell::new(0u32);
        let started = tokio::time::Instant::now();
        let (_, plan) = read_push_index_plan(&RoleMap::new(), [9; 32], || {
            reads.set(reads.get() + 1);
            async { Ok(vec![manifest("p1", 100, 0, 1)]) }
        })
        .await
        .unwrap();
        assert!(matches!(plan, PushIndexPlan::NotListed), "{plan:?}");
        assert_eq!(reads.get(), MANIFEST_VISIBLE_ATTEMPTS);
        // 1 + 2 + 4 + 8 + 8: capped, and bounded.
        assert_eq!(started.elapsed(), std::time::Duration::from_secs(23));
        assert!(MANIFEST_VISIBLE_MAX_DELAY >= MANIFEST_VISIBLE_DELAY);
    }

    /// A read that fails spends one attempt and is retried; the push still reaches its plan.
    #[tokio::test(start_paused = true)]
    async fn a_failed_manifest_read_is_retried_within_the_budget() {
        let reads = std::cell::Cell::new(0u32);
        let (_, plan) = read_push_index_plan(&RoleMap::new(), [2; 32], || {
            reads.set(reads.get() + 1);
            let n = reads.get();
            async move {
                if n == 1 {
                    Err(Error::Platform("node unreachable".into()))
                } else {
                    Ok(vec![manifest("p2", 200, 0, 2)])
                }
            }
        })
        .await
        .unwrap();
        assert!(
            matches!(plan, PushIndexPlan::Publish { pack_ref: 0, .. }),
            "{plan:?}"
        );
        assert_eq!(reads.get(), 2);

        // Failing every time: bounded, and the last error is returned.
        reads.set(0);
        let err = read_push_index_plan(&RoleMap::new(), [2; 32], || {
            reads.set(reads.get() + 1);
            async { Err::<Vec<PackManifestInfo>, _>(Error::Platform("down".into())) }
        })
        .await
        .unwrap_err();
        assert!(err.to_string().contains("down"), "{err}");
        assert_eq!(reads.get(), MANIFEST_VISIBLE_ATTEMPTS);
    }

    /// Each reason a push leaves its index behind names the command that actually repairs
    /// it: a missing index `dg repo reindex`, a pack space the index cannot extend `dg repack`.
    #[test]
    fn a_skipped_index_names_the_right_remedy() {
        assert_eq!(
            IndexSkip::new("x", IndexRemedy::Reindex)
                .fix("o/r")
                .as_deref(),
            Some("dg repo reindex o/r")
        );
        assert_eq!(
            IndexSkip::new("x", IndexRemedy::Repack)
                .fix("o/r")
                .as_deref(),
            Some("dg repack o/r")
        );
        assert_eq!(IndexSkip::new("x", IndexRemedy::None).fix("o/r"), None);
        // A fragment that indexes a space the current one does not extend (its pack moved
        // under a later maintainer copy of another kind): the push's skip names `dg repack`.
        let mut relabel = manifest("m1", 300, 1, 1);
        relabel.owner_id = "alice".into();
        let ms = vec![
            relabel,
            manifest("f0", 150, 1, 8), // indexed the space [p1]
            manifest("p2", 200, 0, 2),
            manifest("p1", 100, 0, 1),
        ];
        let roles: RoleMap = [("alice".to_string(), Role::Maintainer)]
            .into_iter()
            .collect();
        let got = plan_push_index(&ms, &roles, [2; 32]);
        assert!(
            matches!(&got, PushIndexPlan::Skip(s) if s.remedy == IndexRemedy::Repack),
            "{got:?}"
        );
        // An older client's --fix-thin pack: repack, said plainly.
        let why = unindexable_reason(&Error::Config(
            "found 3 REF_DELTA + 0 non-contiguous".into(),
        ));
        assert!(
            why.contains("older client") && why.contains("dg repack"),
            "{why}"
        );
    }

    /// Re-review: a push checks the prefix rule over every fragment a reader merges, not
    /// only the live ones. A superseded fragment built over another space still breaks the
    /// web's index, so the push does not publish into it.
    #[test]
    fn a_push_checks_superseded_fragments_readers_still_merge() {
        let mut relabel = manifest("m1", 300, 1, 1);
        relabel.owner_id = "alice".into();
        let mut fold = manifest("fz", 350, 1, 20);
        fold.supersedes = vec![[8; 32]]; // the bad fragment below is no longer live
        let ms = vec![
            relabel,
            fold,
            manifest("f0", 150, 1, 8), // indexed [p1]; the space no longer starts with p1
            manifest("p2", 200, 0, 2),
            manifest("p1", 100, 0, 1),
        ];
        let roles: RoleMap = [("alice".to_string(), Role::Maintainer)]
            .into_iter()
            .collect();
        assert!(live_locator_manifests(&ms)
            .iter()
            .all(|m| m.document_id != "f0"));
        let got = plan_push_index(&ms, &roles, [2; 32]);
        assert!(
            matches!(&got, PushIndexPlan::Skip(s) if s.remedy == IndexRemedy::Repack),
            "{got:?}"
        );
    }

    /// A fold names at most MAX_SUPERSEDES fragments in its `supersedes` (the schema's
    /// maxItems): past that the newest are folded and the rest stay live.
    #[test]
    fn a_fold_supersedes_at_most_a_manifests_worth_of_fragments() {
        assert_eq!(fold_limit(), MAX_SUPERSEDES);
        let many: Vec<PackManifestInfo> = (0..40u8)
            .map(|i| manifest(&format!("f{i}"), 1_000 - u64::from(i), 1, 100 + i))
            .collect(); // newest first
        let set = fold_set(&many).unwrap();
        assert_eq!(set.len(), MAX_SUPERSEDES);
        assert_eq!(set[0].document_id, "f0", "the newest are folded");
        assert!(
            fold_set(&many[..MAX_LOCATOR_FRAGMENTS - 1]).is_none(),
            "under the cap: no fold"
        );
        let at_cap = fold_set(&many[..MAX_LOCATOR_FRAGMENTS]).unwrap();
        assert_eq!(at_cap.len(), MAX_LOCATOR_FRAGMENTS);
    }

    /// Review finding (High): the web merges EVERY kind-1 fragment (it honours no
    /// `supersedes`), so a repacked repository the web reads as fully indexed must read the
    /// same to `dg repo reindex`: p0 and p1, a repack pc superseding both, fragments over p0
    /// and p1, and the repack's locator over pc superseding them. Nothing is missing.
    #[test]
    fn reindex_counts_coverage_over_the_fragments_the_web_merges() {
        let mut ms = vec![manifest("p0", 100, 0, 1), manifest("f0", 110, 1, 11)];
        ms.push(manifest("p1", 200, 0, 2));
        ms.push(manifest("f1", 210, 1, 12));
        let mut pc = manifest("pc", 300, 0, 3);
        pc.supersedes = vec![[1; 32], [2; 32]];
        ms.push(pc);
        let mut lc = manifest("lc", 310, 1, 13);
        lc.supersedes = vec![[11; 32], [12; 32]];
        ms.push(lc);
        for m in &mut ms {
            m.object_count = 5;
        }
        let roles = RoleMap::new();
        let space = locator_pack_space(&ms, &roles, None);
        assert_eq!(space.len(), 3);
        // Rust's live set drops the superseded fragments; the web's merged set keeps them.
        assert_eq!(live_locator_manifests(&ms).len(), 1);
        let merged = index_fragments(&ms, &roles);
        assert_eq!(
            merged
                .iter()
                .map(|m| m.document_id.as_str())
                .collect::<Vec<_>>(),
            vec!["f0", "f1", "lc"]
        );
        // What those fragments cover: f0 → 0, f1 → 1, lc → 2.
        let covered = [0u16, 1, 2].into_iter().collect();
        assert!(uncovered_packs(&space, &covered).unwrap().is_empty());
        // Had only the live fragment (lc) been read, p0 and p1 would read as missing: the
        // 3.3 DASH re-index of dashpay/dash the review caught.
        let live_only = [2u16].into_iter().collect();
        assert_eq!(uncovered_packs(&space, &live_only).unwrap().len(), 2);
    }

    /// The re-check just before a reindex's write: a pack that landed since is fine (the space
    /// only grew), a fragment published since is returned so its coverage is subtracted, a
    /// repack that moved an indexed pack refuses, and a fold whose fragments were folded
    /// meanwhile refuses.
    #[test]
    fn reindex_rechecks_the_pack_space_before_writing() {
        let roles = RoleMap::new();
        let base = vec![manifest("p0", 100, 0, 1), manifest("p1", 200, 0, 2)];
        let planned = locator_pack_space(&base, &roles, None);
        let known = std::collections::BTreeSet::new();
        // A later push: the space grew at the end.
        let mut grew = base.clone();
        grew.push(manifest("p2", 300, 0, 3));
        assert!(recheck_reindex(&grew, &roles, &planned, &known, &[])
            .unwrap()
            .is_empty());
        // A fragment published meanwhile comes back as new.
        let mut indexed = grew.clone();
        indexed.push(manifest("f9", 310, 1, 9));
        let arrived = recheck_reindex(&indexed, &roles, &planned, &known, &[]).unwrap();
        assert_eq!(arrived.len(), 1);
        assert_eq!(arrived[0].document_id, "f9");
        // A pack the plan indexed now sits elsewhere: refused.
        let moved = vec![manifest("p1", 50, 0, 2), manifest("p0", 100, 0, 1)];
        let err = recheck_reindex(&moved, &roles, &planned, &known, &[]).unwrap_err();
        assert!(err.to_string().contains(FRAGMENT_MISMATCH), "{err}");
        // The fragments this reindex folds were superseded by another fold meanwhile.
        let f = manifest("f1", 150, 1, 7);
        let mut folded = base.clone();
        folded.push(f.clone());
        let mut other = manifest("fx", 400, 1, 8);
        other.supersedes = vec![[7; 32]];
        folded.push(other);
        let known: std::collections::BTreeSet<[u8; 32]> = [[7; 32]].into_iter().collect();
        let err = recheck_reindex(&folded, &roles, &planned, &known, &[f]).unwrap_err();
        assert!(err.to_string().contains("folded while this ran"), "{err}");
    }

    /// `dg repo reindex` indexes exactly the stored packs no live fragment covers: an empty
    /// pack needs no rows, and a fragment naming a pack past the space is refused.
    #[test]
    fn reindex_finds_the_packs_no_fragment_covers() {
        let mut empty = manifest("p2", 200, 0, 2);
        empty.object_count = 0;
        let mut ms = vec![manifest("p1", 100, 0, 1), empty, manifest("p3", 300, 0, 3)];
        for m in &mut ms {
            if m.document_id != "p2" {
                m.object_count = 10;
            }
        }
        let space = locator_pack_space(&ms, &RoleMap::new(), None);
        let refs = |c: &[u16]| {
            uncovered_packs(&space, &c.iter().copied().collect())
                .unwrap()
                .iter()
                .map(|p| p.pack_ref)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            refs(&[]),
            vec![0, 2],
            "no index at all: every pack with objects"
        );
        assert_eq!(refs(&[0]), vec![2], "the last push's fragment is missing");
        assert!(refs(&[0, 2]).is_empty(), "fully indexed");
        let wild = uncovered_packs(&space, &[0, 7].into_iter().collect());
        assert!(wild
            .unwrap_err()
            .to_string()
            .contains("outside the pack set"));
    }

    mod settings {
        use super::super::{
            check_patterns, newest_well_formed_config, short_branch_name, ConfigChange,
            CurrentConfig, RepoEdit,
        };
        use crate::platform::{FetchedDocument, FieldValue};

        fn config(id: &str, at: u64, fields: &[(&str, FieldValue)]) -> FetchedDocument {
            FetchedDocument {
                id: id.into(),
                owner_id: "o".into(),
                created_at: Some(at),
                created_at_block_height: Some(1),
                updated_at_block_height: None,
                revision: None,
                fields: fields
                    .iter()
                    .map(|(k, v)| ((*k).to_string(), v.clone()))
                    .collect(),
            }
        }

        #[test]
        fn the_config_in_force_is_the_newest_well_formed_one_by_created_at_then_id() {
            let main = || ("defaultBranch", FieldValue::text("main"));
            let docs = vec![
                config("a", 1, &[main()]),
                config("c", 5, &[main(), ("archived", FieldValue::boolean(true))]),
                config("b", 5, &[main()]),
                // Newest, but malformed for a public repo (an `enc`): readers skip it.
                config(
                    "z",
                    9,
                    &[
                        ("enc", FieldValue::bytes(vec![1; 40])),
                        ("epoch", FieldValue::integer(0)),
                    ],
                ),
            ];
            let newest = newest_well_formed_config(docs).unwrap();
            assert_eq!(newest.id, "c", "same $createdAt: the greater id wins");
            let cfg = CurrentConfig::of_doc(&config(
                "d",
                1,
                &[("defaultBranch", FieldValue::text("refs/heads/trunk"))],
            ));
            assert_eq!(
                cfg.default_branch, "trunk",
                "a full ref reads as the short name"
            );
        }

        #[test]
        fn a_change_carries_every_unset_field_over() {
            let now = CurrentConfig {
                default_branch: "main".into(),
                protected_patterns: vec!["refs/heads/main".into()],
                archived: false,
                backend_mode: 2,
                backend_uris: vec!["https://b.example/".into()],
            };
            let next = now.apply(&ConfigChange {
                default_branch: Some("refs/heads/trunk".into()),
                ..ConfigChange::default()
            });
            assert_eq!(next.default_branch, "trunk");
            assert_eq!(next.protected_patterns, now.protected_patterns);
            assert_eq!(
                (next.backend_mode, &next.backend_uris),
                (2, &now.backend_uris)
            );
            let archived = now.apply(&ConfigChange {
                archived: Some(true),
                ..ConfigChange::default()
            });
            assert!(archived.archived && archived.default_branch == "main");
            // A change to what already holds is no change: nothing is signed.
            assert_eq!(now.apply(&ConfigChange::default()), now);
            assert_eq!(
                now.apply(&ConfigChange {
                    default_branch: Some("main".into()),
                    ..ConfigChange::default()
                }),
                now
            );
        }

        #[test]
        fn short_branch_names_strip_refs_heads_only() {
            assert_eq!(short_branch_name("refs/heads/main"), "main");
            assert_eq!(short_branch_name("release/1.x"), "release/1.x");
        }

        #[test]
        fn patterns_are_checked_against_the_schema() {
            let ok = |v: &[&str]| {
                check_patterns(&v.iter().map(|s| (*s).to_string()).collect::<Vec<_>>())
            };
            assert!(ok(&["refs/heads/main", "refs/heads/release/*"]).is_ok());
            assert!(ok(&[]).is_ok());
            assert!(ok(&["refs/heads/a", "refs/heads/a"]).is_err(), "duplicate");
            assert!(ok(&[""]).is_err(), "empty");
            assert!(ok(&["refs/heads/a b"]).is_err(), "whitespace");
            assert!(ok(&[&"x".repeat(101)]).is_err(), "too long");
            assert!(
                ok(&["1", "2", "3", "4", "5", "6", "7", "8", "9"]).is_err(),
                "nine"
            );
            assert!(ok(&[&"x".repeat(100)]).is_ok());
        }

        #[test]
        fn default_branch_must_be_a_legal_branch_name() {
            let change = |b: &str| ConfigChange {
                default_branch: Some(b.into()),
                ..ConfigChange::default()
            };
            assert!(change("main").validate().is_ok());
            assert!(change("refs/heads/release/1.x").validate().is_ok());
            assert!(change("").validate().is_err());
            assert!(change("refs/heads/").validate().is_err());
            assert!(change("a b").validate().is_err());
            assert!(change(&"x".repeat(250)).validate().is_err());
        }

        #[test]
        fn repo_edits_are_checked_against_the_schema() {
            let topics = |v: &[&str]| RepoEdit {
                topics: Some(v.iter().map(|s| (*s).to_string()).collect()),
                ..RepoEdit::default()
            };
            assert!(topics(&["rust", "dash-platform", "v2"]).validate().is_ok());
            assert!(topics(&["Rust"]).validate().is_err(), "uppercase");
            assert!(topics(&["-x"]).validate().is_err(), "leading dash");
            assert!(topics(&["a_b"]).validate().is_err(), "underscore");
            assert!(topics(&["a", "a"]).validate().is_err(), "duplicate");
            assert!(topics(&[&"a".repeat(31)]).validate().is_err(), "too long");
            let many: Vec<String> = (0..11).map(|i| format!("t{i}")).collect();
            assert!(RepoEdit {
                topics: Some(many),
                ..RepoEdit::default()
            }
            .validate()
            .is_err());
            let desc = |d: String| RepoEdit {
                description: Some(d),
                ..RepoEdit::default()
            };
            assert!(desc("x".repeat(500)).validate().is_ok());
            assert!(desc("x".repeat(501)).validate().is_err());
            assert!(desc("\u{e9}".repeat(500)).validate().is_ok(), "1000 bytes");
            assert!(
                desc("\u{20ac}".repeat(400)).validate().is_err(),
                "1200 bytes"
            );
        }
    }
}

/// The write-side pre-checks this module owns agree with the frozen RC1 accept/refuse vectors
/// (`forge-contracts/vectors/rc1/forge-core.json`): ref names, default branches, release tags,
/// oid widths and the `packManifest` shape. A case whose refusal a pre-check cannot see (a
/// consensus total, a `where`, a field this client never sends) is not asserted here.
#[cfg(test)]
mod rc1_tests {
    use super::{
        check_default_branch, oid_widths_ok, public_ref_props, PackManifestInput,
        MAX_MANIFEST_SIZE_BYTES,
    };
    use crate::platform::FieldValue;
    use crate::rules;
    use serde_json::Value;

    /// A JSON file of the `forge-contracts` checkout, by its path in it.
    fn forge_contracts_json(rel: &str) -> Value {
        let path = format!("{}/../../forge-contracts/{rel}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(&path).expect(&path)).expect(&path)
    }

    /// `{"$b":[fill,len]}` or `{"$hex":"…"}` as bytes.
    fn bytes(v: &Value) -> Option<Vec<u8>> {
        if let Some(h) = v.get("$hex") {
            return hex::decode(h.as_str()?).ok();
        }
        let b = v.get("$b")?.as_array()?;
        let fill = u8::try_from(b[0].as_u64()?).ok()?;
        Some(vec![fill; usize::try_from(b[1].as_u64()?).ok()?])
    }

    /// One accept/refuse vector: a document of type `ty`, and whether (and by which rule,
    /// `why`) the contract refuses it.
    struct Case {
        name: String,
        ty: String,
        ok: bool,
        why: String,
        doc: Value,
    }

    /// Every frozen RC1 `forge-core` vector.
    fn cases() -> Vec<Case> {
        forge_contracts_json("vectors/rc1/forge-core.json")
            .as_array()
            .expect("vector list")
            .iter()
            .map(|c| Case {
                name: c["name"].as_str().unwrap().to_string(),
                ty: c["type"].as_str().unwrap().to_string(),
                ok: c["expect"] == "ok",
                why: c["why"].as_str().unwrap_or_default().to_string(),
                doc: c["doc"].clone(),
            })
            .collect()
    }

    #[test]
    fn ref_names_and_oids_agree_with_the_contract() {
        let mut seen = 0;
        for c in cases()
            .iter()
            .filter(|c| c.ty == "refUpdate" || c.ty == "protectedRefUpdate")
        {
            let new = bytes(&c.doc["newOid"]).unwrap();
            let prev = c.doc.get("prevOid").and_then(bytes);
            assert_eq!(
                oid_widths_ok(&new, prev.as_deref()),
                c.why != "oidWidth",
                "{}",
                c.name
            );
            let Some(name) = c.doc["refName"].as_str() else {
                continue;
            };
            let grammar = matches!(
                c.why.as_str(),
                "pattern" | "minLength" | "maxLength" | "maxBytes" | "noLock"
            );
            assert_eq!(rules::is_legal_ref_name(name), !grammar, "{}", c.name);
            // The git pre-check is the contract's grammar plus no `.lock` component anywhere.
            let lock_component = name
                .split('/')
                .any(|part| part.as_bytes().ends_with(b".lock"));
            assert_eq!(
                rules::is_git_ref_name(name),
                !grammar && !lock_component,
                "{}",
                c.name
            );
            seen += 1;
        }
        assert!(seen > 40, "only {seen} ref vectors");
    }

    #[test]
    fn default_branches_and_tags_agree_with_the_contract() {
        let (mut branches, mut tags) = (0, 0);
        for c in cases() {
            if c.name.contains("defaultBranch") {
                let b = c.doc["defaultBranch"].as_str().unwrap();
                assert_eq!(rules::is_legal_branch_name(b), c.ok, "{}", c.name);
                // What `dg` stores is the short name (`refs/heads/` is stripped first).
                if !b.starts_with("refs/") {
                    assert_eq!(check_default_branch(b).is_ok(), c.ok, "{}", c.name);
                }
                branches += 1;
            }
            if c.ty == "release" {
                let tag = c.doc["tagName"].as_str().unwrap();
                let refused_tag = matches!(
                    c.why.as_str(),
                    "pattern" | "minLength" | "maxLength" | "maxBytes"
                );
                assert_eq!(
                    crate::collab::v2::check_tag_name(tag).is_ok(),
                    !refused_tag,
                    "{}",
                    c.name
                );
                tags += 1;
            }
        }
        assert!(
            branches >= 10 && tags >= 10,
            "{branches} branches, {tags} tags"
        );
    }

    #[test]
    fn manifest_pre_checks_agree_with_the_contract() {
        let mut seen = 0;
        for c in cases().iter().filter(|c| c.ty == "packManifest") {
            let d = &c.doc;
            let supersedes = d.get("supersedes").and_then(bytes).unwrap_or_default();
            // A negative size or a partial hash is not representable here, and
            // `offsetIndexParts` is a field this client no longer has.
            let Some(size) = d["sizeBytes"].as_u64() else {
                continue;
            };
            if supersedes.len() % 32 != 0 || c.why == "additionalProperties" {
                continue;
            }
            let input = PackManifestInput {
                pack_hash: [4; 32],
                kind: d["kind"].as_u64().unwrap(),
                size_bytes: size,
                object_count: 1,
                chunk_count: d["chunkCount"].as_u64().unwrap(),
                storage: d["storage"].as_u64().unwrap(),
                uris: Vec::new(),
                supersedes: supersedes
                    .chunks(32)
                    .map(|h| h.try_into().unwrap())
                    .collect(),
                tips: d.get("tips").and_then(bytes).into_iter().collect(),
            };
            let checked = input.check();
            assert_eq!(checked.is_ok(), c.ok, "{}: {checked:?}", c.name);
            seen += 1;
        }
        assert!(seen >= 14, "only {seen} manifest vectors");
    }

    #[test]
    fn the_size_cap_and_enc_minima_are_the_contracts() {
        let core = forge_contracts_json("contracts/forge-core.json");
        let size = &core["documentSchemas"]["packManifest"]["propertyConstraints"]["sizeNonNeg"];
        assert_eq!(
            size["allOf"][1]["lessThanOrEqual"][1].as_u64(),
            Some(MAX_MANIFEST_SIZE_BYTES)
        );
        // Every sealed document is at least a v0x01 envelope, and a config a v0x02 one.
        assert_eq!(
            core["schemaDefs"]["enc"]["minItems"].as_u64(),
            Some(crate::private::doc::MIN_V1 as u64)
        );
        let enc_v2 = &core["documentSchemas"]["config"]["propertyConstraints"]["encV2"];
        assert_eq!(
            enc_v2["anyOf"][1]["greaterThanOrEqual"][1].as_u64(),
            Some(crate::private::doc::MIN_V2 as u64)
        );
    }

    /// The manifest forms the push path writes besides a git pack: a full and a delta history
    /// index, a browse artifact, a release-asset manifest and a history index's version lists
    /// (kind 5), each accepted by RC1.
    #[test]
    fn every_manifest_kind_the_client_writes_is_rc1_valid() {
        let scope = crate::scope::DocScope {
            contract_id: "CORE".into(),
            repo_id: [1; 32],
        };
        let history = u64::from(crate::pack::KIND_HISTORY_INDEX);
        for (kind, tips, supersedes) in [
            (history, vec![vec![1u8; 20]], vec![]),
            (history, vec![vec![1u8; 20], vec![2u8; 20]], vec![[3u8; 32]]),
            (
                u64::from(crate::pack::KIND_OBJECT_LOCATOR),
                vec![],
                vec![[3u8; 32]; 2],
            ),
            (u64::from(crate::pack::KIND_RELEASE_ASSETS), vec![], vec![]),
            (
                u64::from(crate::pack::KIND_HISTORY_VERSIONS),
                vec![vec![1u8; 20], vec![2u8; 20]],
                vec![[3u8; 32]],
            ),
        ] {
            let props = PackManifestInput {
                pack_hash: [4; 32],
                kind,
                size_bytes: 20_000,
                object_count: 3,
                chunk_count: 2,
                storage: 0,
                uris: Vec::new(),
                supersedes,
                tips,
            }
            .props(&scope)
            .unwrap();
            crate::test_support::rc1::assert_valid("packManifest", &props);
        }
    }

    #[test]
    fn a_public_ref_update_is_stamped_public() {
        let scope = crate::scope::DocScope {
            contract_id: "CORE".into(),
            repo_id: [1; 32],
        };
        let p = public_ref_props(&scope, "refs/heads/main", &[2; 20], None, false).unwrap();
        assert_eq!(p.get("vis"), Some(&FieldValue::text("public")));
    }
}

#[cfg(test)]
#[path = "repo_roundtrip_tests.rs"]
mod roundtrip_tests;
