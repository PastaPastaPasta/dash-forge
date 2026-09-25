//! Private-repository seams (`docs/contracts/forge-v2.md` §5), as no-op interfaces.
//!
//! Public repositories are all this release writes and reads. The places a private
//! repository will differ already go through these traits, so the private-repo release fills
//! them in rather than re-plumbing the data plane:
//!
//! * [`RefNameHasher`]: `refNameHash` is `sha256(refName)` in a public repo and
//!   `HMAC-SHA256(epoch key, refName)` in a private one.
//! * [`RepoCodec`]: a private repo's content fields travel inside `enc`; a public repo's are
//!   plaintext.
//! * [`PackCipher`]: a private repo's packs are encrypted before upload.
//! * [`RepoKeyReader`]: the epoch key comes from the member's `repoKey` wrap.
//!
//! [`for_visibility`] hands out the implementations; for a private repository it refuses,
//! so nothing can write a private repo's data in the clear by accident.

use crate::error::{Error, Result};
use crate::rules::v2::Visibility;

/// How a ref name becomes its indexed `refNameHash`.
pub trait RefNameHasher: Send + Sync {
    /// The 32-byte `refNameHash` of `ref_name`.
    fn hash(&self, ref_name: &str) -> [u8; 32];
}

/// How a document's content fields are carried: plaintext, or sealed in `enc`.
pub trait RepoCodec: Send + Sync {
    /// Whether content is written as plaintext fields (public) or in `enc` (private).
    fn plaintext(&self) -> bool;
}

/// How pack bytes are protected before they leave the machine.
pub trait PackCipher: Send + Sync {
    /// The bytes to upload for `pack`.
    fn seal(&self, pack: Vec<u8>) -> Result<Vec<u8>>;
    /// The pack bytes from uploaded `sealed` bytes.
    fn open(&self, sealed: Vec<u8>) -> Result<Vec<u8>>;
}

/// Where a member's repository key for an epoch comes from.
pub trait RepoKeyReader: Send + Sync {
    /// The 32-byte content key of `epoch`.
    fn epoch_key(&self, epoch: u32) -> Result<[u8; 32]>;
}

/// The public-repository implementation of every seam: sha256 ref hashes, plaintext
/// fields, packs as-is, and no keys.
#[derive(Debug, Clone, Copy, Default)]
pub struct Public;

impl RefNameHasher for Public {
    fn hash(&self, ref_name: &str) -> [u8; 32] {
        crate::backends::sha256(ref_name.as_bytes())
    }
}

impl RepoCodec for Public {
    fn plaintext(&self) -> bool {
        true
    }
}

impl PackCipher for Public {
    fn seal(&self, pack: Vec<u8>) -> Result<Vec<u8>> {
        Ok(pack)
    }
    fn open(&self, sealed: Vec<u8>) -> Result<Vec<u8>> {
        Ok(sealed)
    }
}

impl RepoKeyReader for Public {
    fn epoch_key(&self, _epoch: u32) -> Result<[u8; 32]> {
        Err(not_supported())
    }
}

fn not_supported() -> Error {
    Error::Config("private repositories are not supported by this version of the CLI yet".into())
}

/// The seams for a repository of `visibility`. Private repositories are refused until the
/// private-repo release implements them.
pub fn for_visibility(visibility: Visibility) -> Result<Public> {
    match visibility {
        Visibility::Public => Ok(Public),
        Visibility::Private => Err(not_supported()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_seams_are_the_identity_and_sha256() {
        let p = for_visibility(Visibility::Public).unwrap();
        assert_eq!(
            hex::encode(p.hash("refs/heads/main")),
            hex::encode(crate::backends::sha256(b"refs/heads/main"))
        );
        assert!(p.plaintext());
        assert_eq!(p.open(p.seal(b"pack".to_vec()).unwrap()).unwrap(), b"pack");
        assert!(p.epoch_key(0).is_err());
    }

    #[test]
    fn private_repositories_are_refused() {
        assert!(for_visibility(Visibility::Private).is_err());
    }
}
