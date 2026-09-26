//! Private repositories: the cryptographic core of `docs/security/private-repos.md`.
//!
//! Consensus cannot hide data, so a private repository's content is encrypted client-side under
//! a per-repo, per-epoch key that only members hold. This module is that core, pure and
//! SDK-free apart from the wrap (which goes through `dash_sdk`'s `encryptedFor` helpers in
//! [`crate::platform::wrap`]):
//!
//! * [`keys`]: the epoch key, its HKDF-SHA256 subkeys (§2), the RNG hedge (§3.6);
//! * [`tlv`]: the strict TLV plaintext of an encrypted field (§4.3);
//! * [`doc`]: sealing and opening `enc` (v0x01, and the key-committing v0x02 of config anchors),
//!   the associated data (§4.4) and [`doc::open_content`] with the ref-name hash check and the
//!   late-content rule (§4.5, §8);
//! * [`pack`]: sealed artifacts: a 36-byte header and 16 KiB AES-GCM STREAM segments with a
//!   hand-built nonce, whole, streaming and ranged (§3);
//! * [`wrap`]: the 47-byte `repoKey` wrap plaintext (§5.1);
//! * [`epoch`]: anchors, the current epoch, the chain walk, alerts and the repair check, as one
//!   pure function over flattened rows (§5.3–§5.6).
//!
//! The seams the data plane already routes through ([`RefNameHasher`], [`RepoCodec`],
//! [`PackCipher`], [`RepoKeyReader`]) get their private implementations in [`Private`]. Push,
//! fetch and the web UI adopt them in later changes; until then [`for_visibility`] still refuses a
//! private repository, so nothing writes one half-finished.

pub mod doc;
pub mod epoch;
pub mod keys;
pub mod pack;
pub mod tlv;
pub mod wrap;

#[cfg(test)]
mod conformance;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::rules::v2::Visibility;

pub use doc::{open_content, DocHeader, OpenContext, Opened, Unreadable};
pub use epoch::{resolve_epochs, Alert, EpochResolution, Repair};
pub use keys::{EpochKey, EpochKeys};
pub use pack::{PackHeader, SealedRange};
pub use tlv::Fields;

/// `GRACE_BLOCKS` of the late-content rule (§8.2, `FORGE_RULES_V2`).
pub const GRACE_BLOCKS: u64 = 240;

/// The document types that carry `enc` (§4.4 `docType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocKind {
    /// `issue`.
    Issue,
    /// `patch`.
    Patch,
    /// `comment`.
    Comment,
    /// `review`.
    Review,
    /// `refUpdate`.
    RefUpdate,
    /// `protectedRefUpdate`.
    ProtectedRefUpdate,
    /// `config`, always `enc` v0x02.
    Config,
}

impl DocKind {
    /// The contract's type name, the `docType` of the AD.
    #[must_use]
    pub fn type_name(self) -> &'static str {
        match self {
            Self::Issue => "issue",
            Self::Patch => "patch",
            Self::Comment => "comment",
            Self::Review => "review",
            Self::RefUpdate => "refUpdate",
            Self::ProtectedRefUpdate => "protectedRefUpdate",
            Self::Config => "config",
        }
    }

    /// The largest `enc` the contract admits for this type (`schemaDefs.enc.maxItems`).
    #[must_use]
    pub fn max_enc(self) -> usize {
        match self {
            Self::Issue | Self::Patch | Self::Comment | Self::Review => 5120,
            Self::RefUpdate | Self::ProtectedRefUpdate | Self::Config => 1536,
        }
    }
}

/// Why a private-repository operation failed. Each maps to a user-facing class (errors.md,
/// §9 CLI codes); none carries key material.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PrivateError {
    /// Input violates the framing, the TLV rules or the ref-name hash check (§4, §8.1).
    #[error("malformed private-repo content")]
    Malformed,
    /// A plaintext too large for the type's `enc` cap (§4.1, §4.3 combined sizes).
    #[error("content too large for an encrypted {0} (at most {1} bytes of plaintext)")]
    TooLarge(&'static str, usize),
    /// A sealed artifact failed its checks (§3.5).
    #[error("sealed pack corrupt")]
    SealedPackCorrupt,
    /// The storage length differs from the manifest's `sizeBytes` (§3.5 step 1).
    #[error("sealed pack length does not match the manifest's sizeBytes")]
    SizeMismatch,
    /// No key for the epoch a document or artifact names.
    #[error("no key for epoch {0}")]
    NoKey(u32),
    /// A ranged read outside the plaintext.
    #[error("range outside the sealed artifact")]
    OutOfRange,
    /// The wrap did not decrypt to a version-1 plaintext with a matching KCV (§5.1).
    #[error("the repo key wrap could not be read (wrong keys or corrupt bytes)")]
    WrapUnreadable,
    /// The unwrapped key does not commit to the epoch's anchor (§5.4 (5)).
    #[error("a maintainer gave this member a key that is not the epoch's key")]
    KeyMismatch,
    /// The OS CSPRNG failed.
    #[error("the operating system's random number generator failed")]
    Rng,
}

impl From<PrivateError> for Error {
    fn from(e: PrivateError) -> Self {
        match e {
            PrivateError::SealedPackCorrupt | PrivateError::SizeMismatch => Error::Integrity,
            other => Error::Config(format!("private repository: {other}")),
        }
    }
}

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

/// The private-repository seams for one reader of one repository: the epoch keys it resolved
/// ([`resolve_epochs`]) and the epoch it writes under.
///
/// Seal APIs draw their nonce / fileId through the hedge (§3.6) and take none from the caller.
#[derive(Clone)]
pub struct Private {
    keys: BTreeMap<u32, EpochKeys>,
    raw: BTreeMap<u32, EpochKey>,
    write_epoch: u32,
}

impl std::fmt::Debug for Private {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Private")
            .field("epochs", &self.keys.keys().collect::<Vec<_>>())
            .field("write_epoch", &self.write_epoch)
            .finish_non_exhaustive()
    }
}

impl Private {
    /// Seams over the keys a resolution found. `None` unless the resolution has an epoch the
    /// reader can write under (§5.3: never under an epoch without an anchor, or one it cannot
    /// read).
    #[must_use]
    pub fn from_resolution(repo_id: &[u8; 32], resolution: &EpochResolution) -> Option<Self> {
        let write_epoch = resolution.write_epoch?;
        let raw: BTreeMap<u32, EpochKey> = resolution.keys.clone();
        let keys = raw
            .iter()
            .map(|(&e, k)| (e, EpochKeys::derive(repo_id, e, k)))
            .collect();
        Some(Self {
            keys,
            raw,
            write_epoch,
        })
    }

    /// The epoch new content is written under.
    #[must_use]
    pub fn write_epoch(&self) -> u32 {
        self.write_epoch
    }

    /// The subkeys of `epoch`, if held.
    #[must_use]
    pub fn epoch_keys(&self, epoch: u32) -> Option<&EpochKeys> {
        self.keys.get(&epoch)
    }

    fn writer(&self) -> &EpochKeys {
        self.keys
            .get(&self.write_epoch)
            .expect("the write epoch's keys are held by construction")
    }

    /// Seal a document's content under the write epoch (a random, hedged nonce).
    pub fn seal_doc(
        &self,
        header: &DocHeader,
        fields: &Fields,
    ) -> std::result::Result<Vec<u8>, PrivateError> {
        let mut header = header.clone();
        header.epoch = self.write_epoch;
        doc::seal(self.writer(), &header, fields)
    }

    /// Open a sealed artifact after checking its length against the manifest's `size_bytes`.
    pub fn open_pack(
        &self,
        sealed: &[u8],
        size_bytes: u64,
    ) -> std::result::Result<Vec<u8>, PrivateError> {
        pack::open(sealed, size_bytes, |e| self.keys.get(&e))
    }
}

impl RefNameHasher for Private {
    fn hash(&self, ref_name: &str) -> [u8; 32] {
        self.writer().ref_name_hash(ref_name)
    }
}

impl RepoCodec for Private {
    fn plaintext(&self) -> bool {
        false
    }
}

impl PackCipher for Private {
    fn seal(&self, pack: Vec<u8>) -> Result<Vec<u8>> {
        Ok(pack::seal(self.writer(), &pack)?)
    }
    fn open(&self, sealed: Vec<u8>) -> Result<Vec<u8>> {
        let len = sealed.len() as u64;
        Ok(self.open_pack(&sealed, len)?)
    }
}

impl RepoKeyReader for Private {
    fn epoch_key(&self, epoch: u32) -> Result<[u8; 32]> {
        self.raw
            .get(&epoch)
            .map(|k| *k.expose())
            .ok_or_else(|| PrivateError::NoKey(epoch).into())
    }
}

fn not_supported() -> Error {
    Error::Config("private repositories are not supported by this version of the CLI yet".into())
}

/// The seams for a repository of `visibility`. Private repositories are refused until push and
/// fetch adopt [`Private`] (a later change), so nothing writes one half-finished.
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
