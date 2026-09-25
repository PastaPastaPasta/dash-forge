//! Local copies of stored packs, for `dg reseed --from-local`.
//!
//! A stored pack is identified by the SHA-256 of its exact bytes (`packManifest.packHash`),
//! so "restoring" a lost copy means finding those exact bytes again. A local clone has
//! them in one of two places:
//!
//! - `<git dir>/dash/packs/<sha256>.pack` — the copy `git-remote-dash` keeps of every pack
//!   it pushed to external storage ([`keep_pushed_pack`]). This is the pusher's own copy,
//!   and the only one for a push that was interrupted before its refs landed (no other
//!   clone ever fetched it).
//! - `<git dir>/objects/pack/pack-*.pack` — a fetch indexes each stored pack verbatim (it
//!   is self-contained, so `index-pack --fix-thin` changes nothing), so any clone that
//!   fetched the pack holds its exact bytes under git's own name for it.
//!
//! Every candidate is SHA-256-verified against the manifest before it is used.

use std::path::{Path, PathBuf};

use crate::backends::sha256;
use crate::error::{Error, Result};

/// Where `git-remote-dash` keeps pushed packs under a git dir.
pub fn kept_packs_dir(git_dir: &Path) -> PathBuf {
    git_dir.join("dash").join("packs")
}

/// Keep a copy of a pack this clone pushed to external storage, so it can be restored
/// with `dg reseed --from-local` if every external copy is later lost. Written atomically;
/// an existing copy is left alone. Best-effort for the caller (a failure to keep the copy
/// must not fail a push).
pub fn keep_pushed_pack(git_dir: &Path, pack_hash_hex: &str, bytes: &[u8]) -> Result<PathBuf> {
    if pack_hash_hex.len() != 64 || !pack_hash_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Config(format!("not a pack hash: {pack_hash_hex:?}")));
    }
    let dir = kept_packs_dir(git_dir);
    std::fs::create_dir_all(&dir).map_err(|e| Error::Io(format!("{}: {e}", dir.display())))?;
    let path = dir.join(format!("{pack_hash_hex}.pack"));
    if path.exists() {
        return Ok(path);
    }
    let tmp = dir.join(format!("{pack_hash_hex}.pack.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| Error::Io(format!("{}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, &path).map_err(|e| Error::Io(format!("{}: {e}", path.display())))?;
    Ok(path)
}

/// Find the exact bytes of the pack whose SHA-256 is `pack_hash` in `git_dir`, checking
/// the kept copy first, then every `objects/pack/*.pack`. `None` when no local file hashes
/// to it.
pub fn find_local_pack(git_dir: &Path, pack_hash: [u8; 32]) -> Result<Option<Vec<u8>>> {
    let hex = hex::encode(pack_hash);
    let mut candidates = vec![kept_packs_dir(git_dir).join(format!("{hex}.pack"))];
    let pack_dir = git_dir.join("objects").join("pack");
    if let Ok(entries) = std::fs::read_dir(&pack_dir) {
        let mut found: Vec<PathBuf> = entries
            .filter_map(std::result::Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "pack"))
            .collect();
        found.sort();
        candidates.extend(found);
    }
    for path in candidates {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if sha256(&bytes) == pack_hash {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_kept_and_fetched_packs_by_content_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let git_dir = tmp.path();
        let kept = b"PACK-kept-bytes".to_vec();
        let fetched = b"PACK-fetched-bytes".to_vec();
        let kept_hash = sha256(&kept);
        let fetched_hash = sha256(&fetched);

        keep_pushed_pack(git_dir, &hex::encode(kept_hash), &kept).unwrap();
        std::fs::create_dir_all(git_dir.join("objects/pack")).unwrap();
        std::fs::write(git_dir.join("objects/pack/pack-abc.pack"), &fetched).unwrap();
        std::fs::write(git_dir.join("objects/pack/pack-abc.idx"), b"not a pack").unwrap();

        assert_eq!(find_local_pack(git_dir, kept_hash).unwrap(), Some(kept));
        assert_eq!(
            find_local_pack(git_dir, fetched_hash).unwrap(),
            Some(fetched)
        );
        assert_eq!(find_local_pack(git_dir, [0u8; 32]).unwrap(), None);
        assert!(keep_pushed_pack(git_dir, "../x", b"").is_err());
    }

    #[test]
    fn a_tampered_kept_copy_is_not_returned() {
        let tmp = tempfile::tempdir().unwrap();
        let good = b"PACK-good".to_vec();
        let hash = sha256(&good);
        let dir = kept_packs_dir(tmp.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{}.pack", hex::encode(hash))),
            b"PACK-evil",
        )
        .unwrap();
        assert_eq!(find_local_pack(tmp.path(), hash).unwrap(), None);
    }
}
