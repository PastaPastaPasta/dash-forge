//! Local CIDv1 derivation for the exact import parameters the IPFS backend asks kubo for.
//!
//! The design (PRD 04 §2) treats the CID as a *second* integrity check next to the
//! manifest SHA-256: the CID must re-derive from the bytes. That only works if the import
//! parameters are pinned, so [`super::ipfs::IpfsBackend`] always adds with
//! `cid-version=1&raw-leaves=true&chunker=size-262144&hash=sha2-256` and the balanced
//! layout (kubo's default), and this module computes the same root CID locally:
//!
//! - the bytes are split into 256 KiB chunks, each a `raw` (0x55) leaf block whose CID is
//!   `CIDv1(raw, sha2-256(chunk))`;
//! - a single-chunk file's root IS that leaf (`bafkrei…`);
//! - otherwise leaves are grouped 174 to a `dag-pb` (0x70) UnixFS `File` node, and those
//!   nodes grouped again, until one root remains — exactly the tree go-unixfs's balanced
//!   builder produces, since it fills each subtree completely before starting the next.
//!
//! Comparing this against the CID kubo returns proves kubo stored *these* bytes under the
//! parameters we asked for (a node configured with another chunker would return a CID no
//! pinning service could match against a local re-derivation). The live check against a
//! real kubo is `backends::live_tests::ipfs_cid_matches_kubo` (`make storage-it`).

use sha2::{Digest as _, Sha256};

/// The fixed-size chunker kubo is asked to use (`size-262144`).
pub const CHUNK_SIZE: usize = 262_144;

/// Maximum links per UnixFS node in the balanced layout (go-unixfs `DefaultLinksPerBlock`).
pub const MAX_LINKS: usize = 174;

const CODEC_RAW: u64 = 0x55;
const CODEC_DAG_PB: u64 = 0x70;
const MH_SHA2_256: u64 = 0x12;

/// A block in the DAG under construction: its binary CID, its total serialized size
/// (the `Tsize` a parent records) and how many bytes of file content it spans.
struct Block {
    cid: Vec<u8>,
    tsize: u64,
    content: u64,
}

/// The CIDv1 (base32, `b…`) kubo produces for `bytes` under the pinned import parameters.
pub fn cid_v1_raw_leaves(bytes: &[u8]) -> String {
    let mut level: Vec<Block> = if bytes.is_empty() {
        vec![leaf(&[])]
    } else {
        bytes.chunks(CHUNK_SIZE).map(leaf).collect()
    };
    while level.len() > 1 {
        level = level.chunks(MAX_LINKS).map(file_node).collect();
    }
    let root = level.pop().expect("one block remains");
    multibase_base32(&root.cid)
}

fn leaf(chunk: &[u8]) -> Block {
    Block {
        cid: cid_bytes(CODEC_RAW, chunk),
        tsize: chunk.len() as u64,
        content: chunk.len() as u64,
    }
}

/// A dag-pb UnixFS `File` node linking `children`.
fn file_node(children: &[Block]) -> Block {
    let content: u64 = children.iter().map(|c| c.content).sum();

    // UnixFS `Data` message: Type=File(2), filesize, one blocksizes entry per child
    // (proto2 `repeated uint64`, so NOT packed). No `Data` bytes on an internal node.
    let mut unixfs = Vec::new();
    put_key(&mut unixfs, 1, 0);
    put_varint(&mut unixfs, 2);
    put_key(&mut unixfs, 3, 0);
    put_varint(&mut unixfs, content);
    for c in children {
        put_key(&mut unixfs, 4, 0);
        put_varint(&mut unixfs, c.content);
    }

    // dag-pb `PBNode`: every `Links` entry (field 2) is serialized BEFORE `Data`
    // (field 1) — the canonical dag-pb order. Each `PBLink` carries Hash, an empty Name
    // (always emitted by go-merkledag) and Tsize.
    let mut node = Vec::new();
    for c in children {
        let mut link = Vec::new();
        put_key(&mut link, 1, 2);
        put_varint(&mut link, c.cid.len() as u64);
        link.extend_from_slice(&c.cid);
        put_key(&mut link, 2, 2);
        put_varint(&mut link, 0);
        put_key(&mut link, 3, 0);
        put_varint(&mut link, c.tsize);

        put_key(&mut node, 2, 2);
        put_varint(&mut node, link.len() as u64);
        node.extend_from_slice(&link);
    }
    put_key(&mut node, 1, 2);
    put_varint(&mut node, unixfs.len() as u64);
    node.extend_from_slice(&unixfs);

    let tsize = node.len() as u64 + children.iter().map(|c| c.tsize).sum::<u64>();
    Block {
        cid: cid_bytes(CODEC_DAG_PB, &node),
        tsize,
        content,
    }
}

/// Binary CIDv1: `varint(1) ‖ varint(codec) ‖ varint(sha2-256) ‖ varint(32) ‖ digest`.
fn cid_bytes(codec: u64, block: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(36);
    put_varint(&mut out, 1);
    put_varint(&mut out, codec);
    put_varint(&mut out, MH_SHA2_256);
    put_varint(&mut out, 32);
    out.extend_from_slice(&Sha256::digest(block));
    out
}

fn put_key(out: &mut Vec<u8>, field: u64, wire_type: u64) {
    put_varint(out, (field << 3) | wire_type);
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let byte = u8::try_from(v & 0x7f).expect("masked to 7 bits");
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// Multibase base32 (RFC 4648 lowercase, no padding) with the `b` prefix.
fn multibase_base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::with_capacity(1 + bytes.len() * 8 / 5 + 1);
    out.push('b');
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for &b in bytes {
        buffer = (buffer << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(char::from(ALPHABET[((buffer >> bits) & 31) as usize]));
        }
    }
    if bits > 0 {
        out.push(char::from(ALPHABET[((buffer << (5 - bits)) & 31) as usize]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_raw_leaf_matches_the_well_known_cid() {
        // CIDv1 raw of zero bytes — the IPFS ecosystem's well-known empty raw block.
        assert_eq!(
            cid_v1_raw_leaves(b""),
            "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"
        );
    }

    #[test]
    fn small_file_is_a_single_raw_leaf() {
        // `echo -n hello | ipfs add --cid-version=1 --raw-leaves` → this CID.
        assert_eq!(
            cid_v1_raw_leaves(b"hello"),
            "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"
        );
    }

    #[test]
    fn multi_chunk_root_is_dag_pb() {
        let data = vec![7u8; CHUNK_SIZE + 1];
        let cid = cid_v1_raw_leaves(&data);
        // dag-pb CIDv1 base32 roots start `bafybei`.
        assert!(cid.starts_with("bafybei"), "{cid}");
        // Deterministic.
        assert_eq!(cid, cid_v1_raw_leaves(&data));
    }

    #[test]
    fn varint_encoding() {
        let mut v = Vec::new();
        put_varint(&mut v, 300);
        assert_eq!(v, [0xac, 0x02]);
    }
}
