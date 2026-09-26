//! The `repoKey` wrap plaintext (`docs/security/private-repos.md` §5.1): `0x01 ‖ KCV_e(14) ‖
//! K_e(32)`, 47 bytes, which `encryptedFor` pads to 48 so `wrapped` is always 64 bytes.
//!
//! The ECDH + AES-256-CBC around it is the SDK's `encryptedFor` helper
//! ([`crate::platform::wrap`]); this module builds and checks the plaintext. CBC has no tag, so
//! the version byte and `KCV_e` are error detection only; the key is authenticated by the
//! anchor's commitment ([`check_against_anchor`]).

use zeroize::Zeroizing;

use super::keys::{ct_eq, EpochKey, EpochKeys};
use super::PrivateError;

/// The wrap plaintext version.
pub const VERSION: u8 = 0x01;
/// The wrap plaintext length.
pub const PLAINTEXT_LEN: usize = 47;

/// `0x01 ‖ KCV_e ‖ K_e` for `key`, the key of `epoch` of the repository `repo_id`.
#[must_use]
pub fn plaintext(repo_id: &[u8; 32], epoch: u32, key: &EpochKey) -> Zeroizing<Vec<u8>> {
    let keys = EpochKeys::derive(repo_id, epoch, key);
    let mut pt = Zeroizing::new(Vec::with_capacity(PLAINTEXT_LEN));
    pt.push(VERSION);
    pt.extend_from_slice(keys.kcv());
    pt.extend_from_slice(key.expose());
    pt
}

/// Recover `K_e` from a decrypted wrap plaintext: version `0x01` and a `KCV_e` that matches the
/// recovered key (§5.4 (4)), else [`PrivateError::WrapUnreadable`] (wrong keys or corrupt bytes,
/// never a protocol violation).
pub fn parse(repo_id: &[u8; 32], epoch: u32, pt: &[u8]) -> Result<EpochKey, PrivateError> {
    if pt.len() != PLAINTEXT_LEN || pt[0] != VERSION {
        return Err(PrivateError::WrapUnreadable);
    }
    let key = EpochKey::from_slice(&pt[15..]).ok_or(PrivateError::WrapUnreadable)?;
    let keys = EpochKeys::derive(repo_id, epoch, &key);
    if !ct_eq(keys.kcv(), &pt[1..15]) {
        return Err(PrivateError::WrapUnreadable);
    }
    Ok(key)
}

/// §5.4 (5): the recovered key must commit to the commitment the epoch's anchor carries, else
/// [`PrivateError::KeyMismatch`] (alert naming the wrap's author; never look for another config
/// the key opens).
pub fn check_against_anchor(
    repo_id: &[u8; 32],
    epoch: u32,
    key: &EpochKey,
    anchor_commit: &[u8],
) -> Result<(), PrivateError> {
    if EpochKeys::derive(repo_id, epoch, key).commits_to(anchor_commit) {
        Ok(())
    } else {
        Err(PrivateError::KeyMismatch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_refusals() {
        let repo = [0x11; 32];
        let k = EpochKey::from_bytes([9; 32]);
        let pt = plaintext(&repo, 2, &k);
        assert_eq!(pt.len(), PLAINTEXT_LEN);
        assert_eq!(parse(&repo, 2, &pt).unwrap(), k);
        assert_eq!(parse(&repo, 3, &pt), Err(PrivateError::WrapUnreadable));
        assert_eq!(
            parse(&[0x12; 32], 2, &pt),
            Err(PrivateError::WrapUnreadable)
        );
        assert_eq!(
            parse(&repo, 2, &pt[..46]),
            Err(PrivateError::WrapUnreadable)
        );
        let commit = *EpochKeys::derive(&repo, 2, &k).commit();
        assert!(check_against_anchor(&repo, 2, &k, &commit).is_ok());
        assert_eq!(
            check_against_anchor(&repo, 2, &EpochKey::from_bytes([8; 32]), &commit),
            Err(PrivateError::KeyMismatch)
        );
    }
}
