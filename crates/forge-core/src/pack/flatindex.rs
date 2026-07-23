//! The `flatIndex` browse artifact: a tip commit's complete recursive file listing
//! (`path → oid, mode, size`), path-sorted and gzip-compressed — GitHub's tree API as
//! one static artifact (data-contracts §2.3). Includes tree nodes (so directories
//! carry their tree OID) and gitlink submodule entries (mode 160000, type `commit`).
//!
//! Enumerated with `git ls-tree -r -t -l -z <tip>` and parsed directly. Serialized
//! format (then gzipped whole with flate2):
//!
//! ```text
//! tipOid(20) || varint(nrows) || row*
//! row = mode(u32 BE) || oid(20) || varint(size) || varint(pathLen) || path(utf8)
//! ```

#![allow(clippy::cast_possible_truncation)]

use super::build::git_capture;
use super::parse::OID_LEN;
use crate::error::{Error, Result};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::{Read as _, Write as _};
use std::path::Path;

/// git file mode of a gitlink (submodule) entry.
pub const MODE_GITLINK: u32 = 0o160_000;

/// One entry in a flat index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlatEntry {
    /// Repository-root-relative path.
    pub path: String,
    /// Object id at the path (tree, blob, or submodule commit).
    pub oid: [u8; OID_LEN],
    /// git file mode (e.g. 0o100644 blob, 0o040000 tree, 0o160000 gitlink).
    pub mode: u32,
    /// Object size in bytes (0 for trees and gitlinks).
    pub size: u64,
}

impl FlatEntry {
    /// Whether this entry is a submodule gitlink (mode 160000).
    pub fn is_gitlink(&self) -> bool {
        self.mode == MODE_GITLINK
    }

    /// Whether this entry is a tree (directory) node.
    pub fn is_tree(&self) -> bool {
        self.mode == 0o040_000
    }
}

/// A parsed flat index over one tip commit.
pub struct FlatIndex {
    /// The tip commit OID this index describes.
    pub tip: [u8; OID_LEN],
    entries: Vec<FlatEntry>,
}

/// Build a flat index for `tip` in `repo` and return the gzip-compressed artifact.
pub fn build(repo: &Path, tip: &str) -> Result<Vec<u8>> {
    let index = FlatIndex::from_repo(repo, tip)?;
    index.to_compressed()
}

impl FlatIndex {
    /// Enumerate a tip's recursive listing via `git ls-tree` and parse it.
    pub fn from_repo(repo: &Path, tip: &str) -> Result<Self> {
        super::build::ensure_safe_rev(tip)?;
        // `--end-of-options` stops git treating a `-`-leading tree-ish as an option;
        // `ensure_safe_rev` already rejects such input, but this is defense-in-depth.
        let out = git_capture(
            repo,
            &["ls-tree", "-r", "-t", "-l", "-z", "--end-of-options", tip],
            None,
        )?;
        let tip_oid = resolve_oid(repo, tip)?;
        let mut entries = Vec::new();
        for rec in out.split(|&b| b == 0) {
            if rec.is_empty() {
                continue;
            }
            entries.push(parse_ls_tree_record(rec)?);
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(Self {
            tip: tip_oid,
            entries,
        })
    }

    /// Construct directly from parts (used to inject synthetic entries in tests).
    pub fn from_parts(tip: [u8; OID_LEN], mut entries: Vec<FlatEntry>) -> Self {
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Self { tip, entries }
    }

    /// All entries, path-sorted.
    pub fn entries(&self) -> &[FlatEntry] {
        &self.entries
    }

    /// Look up a single path.
    pub fn lookup(&self, path: &str) -> Option<&FlatEntry> {
        self.entries
            .binary_search_by(|e| e.path.as_str().cmp(path))
            .ok()
            .map(|i| &self.entries[i])
    }

    /// List the immediate children of a directory `prefix` (`""` = repo root).
    pub fn list_dir(&self, prefix: &str) -> Vec<&FlatEntry> {
        let norm = if prefix.is_empty() || prefix.ends_with('/') {
            prefix.to_string()
        } else {
            format!("{prefix}/")
        };
        self.entries
            .iter()
            .filter(|e| {
                let Some(rest) = e.path.strip_prefix(&norm) else {
                    return false;
                };
                !rest.is_empty() && !rest.contains('/')
            })
            .collect()
    }

    /// Serialize + gzip the index into the transportable artifact.
    pub fn to_compressed(&self) -> Result<Vec<u8>> {
        let mut body = Vec::new();
        body.extend_from_slice(&self.tip);
        write_varint(&mut body, self.entries.len() as u64);
        for e in &self.entries {
            body.extend_from_slice(&e.mode.to_be_bytes());
            body.extend_from_slice(&e.oid);
            write_varint(&mut body, e.size);
            let path = e.path.as_bytes();
            write_varint(&mut body, path.len() as u64);
            body.extend_from_slice(path);
        }
        let mut enc = GzEncoder::new(Vec::new(), Compression::new(9));
        enc.write_all(&body).map_err(|e| Error::Io(e.to_string()))?;
        enc.finish().map_err(|e| Error::Io(e.to_string()))
    }

    /// Parse a gzip-compressed flat index artifact back into a reader.
    pub fn parse(compressed: &[u8]) -> Result<Self> {
        let mut body = Vec::new();
        GzDecoder::new(compressed)
            .read_to_end(&mut body)
            .map_err(|e| Error::Io(e.to_string()))?;

        let mut pos = 0usize;
        let tip: [u8; OID_LEN] = body
            .get(pos..pos + OID_LEN)
            .ok_or_else(|| Error::Config("flatIndex truncated (tip)".into()))?
            .try_into()
            .unwrap();
        pos += OID_LEN;
        let nrows = read_varint(&body, &mut pos)?;

        let mut entries = Vec::with_capacity(usize::try_from(nrows).unwrap_or(0));
        for _ in 0..nrows {
            let mode = u32::from_be_bytes(
                body.get(pos..pos + 4)
                    .ok_or_else(|| Error::Config("flatIndex truncated (mode)".into()))?
                    .try_into()
                    .unwrap(),
            );
            pos += 4;
            let oid: [u8; OID_LEN] = body
                .get(pos..pos + OID_LEN)
                .ok_or_else(|| Error::Config("flatIndex truncated (oid)".into()))?
                .try_into()
                .unwrap();
            pos += OID_LEN;
            let size = read_varint(&body, &mut pos)?;
            let plen = usize::try_from(read_varint(&body, &mut pos)?)
                .map_err(|_| Error::Config("flatIndex path length overflow".into()))?;
            let path = String::from_utf8(
                body.get(pos..pos + plen)
                    .ok_or_else(|| Error::Config("flatIndex truncated (path)".into()))?
                    .to_vec(),
            )
            .map_err(|_| Error::Config("flatIndex non-utf8 path".into()))?;
            pos += plen;
            entries.push(FlatEntry {
                path,
                oid,
                mode,
                size,
            });
        }
        Ok(Self { tip, entries })
    }
}

/// Parse one `git ls-tree -r -t -l -z` record: `"<mode> <type> <oid> <size>\t<path>"`.
fn parse_ls_tree_record(rec: &[u8]) -> Result<FlatEntry> {
    let tab = rec
        .iter()
        .position(|&b| b == b'\t')
        .ok_or_else(|| Error::Config("ls-tree record missing tab".into()))?;
    let meta = std::str::from_utf8(&rec[..tab])
        .map_err(|_| Error::Config("ls-tree non-utf8 meta".into()))?;
    let path = String::from_utf8(rec[tab + 1..].to_vec())
        .map_err(|_| Error::Config("ls-tree non-utf8 path".into()))?;

    let mut it = meta.split_whitespace();
    let mode = it
        .next()
        .ok_or_else(|| Error::Config("ls-tree no mode".into()))?;
    let _typ = it
        .next()
        .ok_or_else(|| Error::Config("ls-tree no type".into()))?;
    let oid_hex = it
        .next()
        .ok_or_else(|| Error::Config("ls-tree no oid".into()))?;
    let size = it
        .next()
        .ok_or_else(|| Error::Config("ls-tree no size".into()))?;

    let mode =
        u32::from_str_radix(mode, 8).map_err(|_| Error::Config("ls-tree bad mode".into()))?;
    let oid_bytes = hex::decode(oid_hex).map_err(|_| Error::Config("ls-tree bad oid".into()))?;
    let oid: [u8; OID_LEN] = oid_bytes
        .as_slice()
        .try_into()
        .map_err(|_| Error::Config("ls-tree oid not 20 bytes".into()))?;
    let size = if size == "-" {
        0
    } else {
        size.parse().unwrap_or(0)
    };

    Ok(FlatEntry {
        path,
        oid,
        mode,
        size,
    })
}

fn resolve_oid(repo: &Path, rev: &str) -> Result<[u8; OID_LEN]> {
    super::build::ensure_safe_rev(rev)?;
    let out = git_capture(
        repo,
        &["rev-parse", "--verify", "--end-of-options", rev],
        None,
    )?;
    let hexs = std::str::from_utf8(&out)
        .map_err(|_| Error::Config("rev-parse non-utf8".into()))?
        .trim();
    let bytes = hex::decode(hexs).map_err(|_| Error::Config("rev-parse bad oid".into()))?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| Error::Config("rev-parse oid not 20 bytes".into()))
}

fn write_varint(buf: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            buf.push(b | 0x80);
        } else {
            buf.push(b);
            break;
        }
    }
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Result<u64> {
    let mut r = 0u64;
    let mut shift = 0u32;
    loop {
        let b = *buf
            .get(*pos)
            .ok_or_else(|| Error::Config("flatIndex truncated (varint)".into()))?;
        *pos += 1;
        r |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    Ok(r)
}
