//! [`PlatformBackend`] — pack bytes as `chunk` documents on Dash Platform.
//!
//! The default, always-available tier: Platform is the source of truth. Pack bytes are
//! split by [`crate::pack::split`] into `chunk` documents (`packHash`, `seq`, and up to
//! [`FIELDS_PER_DOC`] byte fields `d0..d2` of ≤ 4,900 B — the frozen S0.2 geometry) and
//! written through the idempotent [`WriteEngine`], **pipelined** with sequential nonces
//! and a window of [`PIPELINE_WINDOW`] (spike S0.1: ~4 docs/sec landing at window 8).
//! Read-back is by `(packHash, seq)` range.
//!
//! ## What is live here vs. deferred to M1
//!
//! - **Write** ([`PlatformBackend::put`]) drives the real [`WriteEngine`] and is exercised
//!   by the `#[ignore]`d live test (needs a repo/chunk contract + a funded identity).
//! - **The chunk-document encode/decode** ([`encode_chunk_doc`] / [`decode_chunk_doc`]) is
//!   pure and covered by offline round-trip unit tests — it is the load-bearing on-chain
//!   byte format.
//! - **Read-back** ([`PlatformBackend::get`]) needs a property-returning `chunk` query by
//!   `(packHash, seq)`; that query helper lives in `crate::platform` and lands in M1 (the
//!   SDK is confined to that module). Until then `get`/`probe` return a clear pending
//!   error, and the reassembly is the pure [`crate::pack::join`] over decoded chunks.

use std::collections::BTreeMap;

use futures::stream::{self, StreamExt, TryStreamExt};

use super::{ByteRange, Caps, Health, PackBackend, PackMeta, Uri};
use crate::error::{Error, Result};
use crate::pack::{join, split, Chunk, FIELDS_PER_DOC};
use crate::platform::{FieldValue, LoadedContract, QueryFilter, QueryOrder, WriteEngine};

/// The platform scheme label used in manifest URIs.
pub const PLATFORM_SCHEME: &str = "platform";

/// The document type pack bytes are stored under.
pub const CHUNK_DOC_TYPE: &str = "chunk";

/// In-flight write window for the chunk pipeline (frozen S0.1 sweet spot: window 8,
/// ~4 docs/sec landing; look-ahead caps ~24).
pub const PIPELINE_WINDOW: usize = 8;

/// Page size for the chunk read-back scan. Platform caps a document query at ~100 rows,
/// so a pack with more chunks is paged via a `seq`-ordered `start_after` cursor.
const CHUNK_PAGE_LIMIT: u32 = 100;

/// The document field carrying a chunk's packHash (32-byte `byteArray`).
pub const FIELD_PACK_HASH: &str = "packHash";
/// The document field carrying a chunk's zero-based sequence.
pub const FIELD_SEQ: &str = "seq";

/// The field name for byte payload `i` (`d0`, `d1`, `d2`).
fn data_field_name(i: usize) -> String {
    format!("d{i}")
}

/// Encode one [`Chunk`] as `chunk`-document properties (`packHash`, `seq`, `d0..d2`).
///
/// Only the present byte fields are emitted (a short final chunk carries fewer than
/// [`FIELDS_PER_DOC`]). This is the exact on-chain byte format; keep it in lockstep with
/// [`decode_chunk_doc`].
pub fn encode_chunk_doc(pack_hash: [u8; 32], chunk: &Chunk) -> BTreeMap<String, FieldValue> {
    let mut props = BTreeMap::new();
    props.insert(FIELD_PACK_HASH.to_string(), FieldValue::bytes32(pack_hash));
    props.insert(
        FIELD_SEQ.to_string(),
        FieldValue::integer(u64::from(chunk.seq)),
    );
    for (i, field) in chunk.fields.iter().enumerate() {
        props.insert(data_field_name(i), FieldValue::bytes(field.clone()));
    }
    props
}

/// Decode `chunk`-document properties back into a [`Chunk`], inverting
/// [`encode_chunk_doc`].
///
/// Reads `seq` and collects the contiguous `d0`, `d1`, … byte fields (stopping at the
/// first absent index, so trailing gaps never fabricate empty fields).
pub fn decode_chunk_doc(props: &BTreeMap<String, FieldValue>) -> Result<Chunk> {
    let seq = match props.get(FIELD_SEQ) {
        Some(FieldValue::Integer(n)) => u32::try_from(*n)
            .map_err(|_| Error::Config(format!("chunk seq {n} does not fit u32")))?,
        _ => return Err(Error::Config("chunk document missing integer 'seq'".into())),
    };

    let mut fields = Vec::with_capacity(FIELDS_PER_DOC);
    for i in 0..FIELDS_PER_DOC {
        match props.get(&data_field_name(i)) {
            Some(FieldValue::Bytes(b)) => fields.push(b.clone()),
            Some(_) => {
                return Err(Error::Config(format!(
                    "chunk field d{i} is not a byteArray"
                )))
            }
            None => break,
        }
    }
    if fields.is_empty() {
        return Err(Error::Config("chunk document has no byte fields".into()));
    }
    Ok(Chunk { seq, fields })
}

/// Plan the `chunk` documents for `bytes`: the ordered `(seq, properties)` list that
/// [`PlatformBackend::put`] writes. Pure — usable offline to inspect/validate the split.
pub fn chunk_documents(
    bytes: &[u8],
    pack_hash: [u8; 32],
) -> Vec<(u32, BTreeMap<String, FieldValue>)> {
    split(bytes)
        .into_iter()
        .map(|chunk| (chunk.seq, encode_chunk_doc(pack_hash, &chunk)))
        .collect()
}

/// The Platform storage backend, bound to a [`WriteEngine`] + the repo/chunk contract it
/// writes into.
///
/// Holds borrows (the engine borrows a `PlatformClient`, a keystore key and an identity),
/// so it is constructed per-push rather than stored long-lived or boxed `'static`.
pub struct PlatformBackend<'a> {
    engine: &'a WriteEngine<'a>,
    contract: &'a LoadedContract,
}

impl<'a> PlatformBackend<'a> {
    /// Bind a backend to `engine` writing `chunk` docs into `contract`.
    pub fn new(engine: &'a WriteEngine<'a>, contract: &'a LoadedContract) -> Self {
        Self { engine, contract }
    }

    /// The `platform://<contractId>/<packHash>` locator for a stored pack.
    fn locator_uri(&self, pack_hash: &str) -> Uri {
        Uri(format!(
            "{PLATFORM_SCHEME}://{}/{}",
            self.contract.id(),
            pack_hash
        ))
    }

    /// The 32-byte packHash from a `platform://<contractId>/<packHashHex>` locator.
    fn pack_hash_from_uri(uri: &Uri) -> Result<[u8; 32]> {
        let rest = uri
            .rest()
            .ok_or_else(|| Error::Config(format!("not a platform locator: {uri}")))?;
        let hex_hash = rest.rsplit_once('/').map_or(rest, |(_, h)| h);
        let raw = hex::decode(hex_hash)
            .map_err(|e| Error::Config(format!("platform locator packHash not hex: {e}")))?;
        raw.try_into()
            .map_err(|_| Error::Config("platform locator packHash is not 32 bytes".into()))
    }

    /// Read every `chunk` document for `pack_hash`, ordered by `seq`, paging through the
    /// ~100-row query cap with a `start_after` cursor. Decodes each to a [`Chunk`].
    async fn read_chunks(&self, pack_hash: [u8; 32]) -> Result<Vec<Chunk>> {
        let client = self.engine.client();
        let mut chunks: Vec<Chunk> = Vec::new();
        let mut start_after: Option<String> = None;
        loop {
            let page = client
                .query_documents(
                    self.contract,
                    CHUNK_DOC_TYPE,
                    &[QueryFilter::eq(
                        FIELD_PACK_HASH,
                        FieldValue::bytes32(pack_hash),
                    )],
                    &[QueryOrder::asc(FIELD_SEQ)],
                    CHUNK_PAGE_LIMIT,
                    start_after.as_deref(),
                )
                .await?;
            let page_len = page.len();
            for doc in &page {
                chunks.push(decode_chunk_doc(&doc.fields)?);
            }
            start_after = page.last().map(|d| d.id.clone());
            if page_len < CHUNK_PAGE_LIMIT as usize {
                break;
            }
        }
        // The (packHash, seq) index already returns seq-ordered, but sort defensively so
        // reassembly never depends on traversal order.
        chunks.sort_by_key(|c| c.seq);
        Ok(chunks)
    }
}

#[async_trait::async_trait]
impl PackBackend for PlatformBackend<'_> {
    fn scheme(&self) -> &'static str {
        PLATFORM_SCHEME
    }

    fn caps(&self) -> Caps {
        // On-chain: CLI write (holds the WRITE token + signing key); reads available to
        // CLI and browser via DAPI. Browser writes need the identity's key — CLI-shaped.
        Caps {
            read_cli: true,
            read_browser: true,
            write_cli: true,
            write_browser: false,
        }
    }

    async fn put(&self, bytes: &[u8], meta: &PackMeta) -> Result<Vec<Uri>> {
        let pack_hash = meta.pack_hash_bytes()?;
        let docs = chunk_documents(bytes, pack_hash);

        // Pipeline the chunk creates with a bounded in-flight window (S0.1: window 8).
        // `buffered` preserves order while running up to PIPELINE_WINDOW concurrently; the
        // engine's sequential-nonce + idempotent re-broadcast handles landing order.
        stream::iter(docs.into_iter().map(|(_seq, props)| {
            self.engine
                .create_document(self.contract, CHUNK_DOC_TYPE, props)
        }))
        .buffered(PIPELINE_WINDOW)
        .try_collect::<Vec<_>>()
        .await?;

        Ok(vec![self.locator_uri(&meta.pack_hash)])
    }

    async fn get(&self, uri: &Uri, range: Option<ByteRange>) -> Result<Vec<u8>> {
        // Read every chunk for the pack (paged, seq-ordered), decode, and reassemble via
        // the pure `crate::pack::join`. A ranged read slices the reassembled bytes — the
        // platform tier serves whole chunks, so partial fetch is a post-join slice (the
        // browse plane's per-object ranged reads run over the locator, not raw chunks).
        let pack_hash = Self::pack_hash_from_uri(uri)?;
        let chunks = self.read_chunks(pack_hash).await?;
        if chunks.is_empty() {
            return Err(Error::NotFound);
        }
        let bytes = join(&chunks);
        match range {
            None => Ok(bytes),
            Some(r) => {
                let start = usize::try_from(r.start)
                    .map_err(|_| Error::Config("range start overflows usize".into()))?;
                let end = usize::try_from(r.end)
                    .map_err(|_| Error::Config("range end overflows usize".into()))?
                    .min(bytes.len());
                if start >= bytes.len() {
                    return Ok(Vec::new());
                }
                Ok(bytes[start..end].to_vec())
            }
        }
    }

    async fn probe(&self, uri: &Uri) -> Result<Health> {
        // A cheap presence check: seek the first chunk (`limit 1`) for the pack. `ok` is
        // whether any chunk is stored; size is left unknown (a whole-pack size would
        // require reading every chunk — that's `get`'s job, not a probe's).
        let pack_hash = Self::pack_hash_from_uri(uri)?;
        let started = std::time::Instant::now();
        let page = self
            .engine
            .client()
            .query_documents(
                self.contract,
                CHUNK_DOC_TYPE,
                &[QueryFilter::eq(
                    FIELD_PACK_HASH,
                    FieldValue::bytes32(pack_hash),
                )],
                &[QueryOrder::asc(FIELD_SEQ)],
                1,
                None,
            )
            .await?;
        Ok(Health {
            ok: !page.is_empty(),
            size: None,
            latency: started.elapsed(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pack::join;

    fn ramp(n: usize) -> Vec<u8> {
        (0..n).map(|i| u8::try_from(i % 251).unwrap()).collect()
    }

    #[test]
    fn chunk_doc_round_trips_through_encode_decode() {
        let pack_hash = [7u8; 32];
        // Sizes crossing a field, a full doc, and a short tail.
        for &n in &[1usize, 4_900, 4_901, 14_700, 14_701, 30_000] {
            let data = ramp(n);
            let chunks = split(&data);
            let decoded: Vec<Chunk> = chunks
                .iter()
                .map(|c| decode_chunk_doc(&encode_chunk_doc(pack_hash, c)).unwrap())
                .collect();
            assert_eq!(decoded, chunks, "round-trip mismatch at {n} bytes");
            // And the whole pack reassembles bit-for-bit.
            assert_eq!(join(&decoded), data, "join mismatch at {n} bytes");
        }
    }

    #[test]
    fn encode_emits_expected_fields_for_short_final_chunk() {
        // 14,700 + 10 → chunk 0 full (d0,d1,d2), chunk 1 short (d0 only).
        let data = ramp(14_700 + 10);
        let chunks = split(&data);
        assert_eq!(chunks.len(), 2);

        let full = encode_chunk_doc([1u8; 32], &chunks[0]);
        assert!(matches!(
            full.get(FIELD_PACK_HASH),
            Some(FieldValue::Bytes32(_))
        ));
        assert!(matches!(full.get(FIELD_SEQ), Some(FieldValue::Integer(0))));
        for i in 0..FIELDS_PER_DOC {
            assert!(full.contains_key(&data_field_name(i)), "missing d{i}");
        }

        let short = encode_chunk_doc([1u8; 32], &chunks[1]);
        assert!(matches!(short.get(FIELD_SEQ), Some(FieldValue::Integer(1))));
        assert!(short.contains_key("d0"));
        assert!(!short.contains_key("d1"));
        assert!(!short.contains_key("d2"));
    }

    #[test]
    fn decode_rejects_malformed_documents() {
        // Missing seq.
        let mut props = BTreeMap::new();
        props.insert("d0".to_string(), FieldValue::bytes(vec![1, 2, 3]));
        assert!(decode_chunk_doc(&props).is_err());

        // seq present but no byte fields.
        let mut props = BTreeMap::new();
        props.insert(FIELD_SEQ.to_string(), FieldValue::integer(0));
        assert!(decode_chunk_doc(&props).is_err());

        // wrong type for a data field.
        let mut props = BTreeMap::new();
        props.insert(FIELD_SEQ.to_string(), FieldValue::integer(0));
        props.insert("d0".to_string(), FieldValue::integer(9));
        assert!(decode_chunk_doc(&props).is_err());
    }

    #[test]
    fn chunk_documents_are_seq_ordered_and_cover_bytes() {
        let data = ramp(14_700 * 2 + 123);
        let pack_hash = [9u8; 32];
        let docs = chunk_documents(&data, pack_hash);
        for (i, (seq, _)) in docs.iter().enumerate() {
            assert_eq!(*seq as usize, i);
        }
        // Decode all back and rejoin → original bytes.
        let rebuilt: Vec<Chunk> = docs
            .iter()
            .map(|(_, props)| decode_chunk_doc(props).unwrap())
            .collect();
        assert_eq!(join(&rebuilt), data);
    }
}
