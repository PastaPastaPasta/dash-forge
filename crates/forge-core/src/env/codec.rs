//! Sealing and opening one snapshot: every snapshot is written as a letter to specific people
//! (DFPK 0x02); the phase-1 Members form under the repository's members key (DFPK 0x01) is only
//! read. The reader's checks of D24, in order.

use zeroize::Zeroizing;

use super::format::{FormatError, Snapshot};
use crate::envelope::PrivateKey;
use crate::platform::IdentityKeyInfo;
use crate::private::keys::{ct_eq, sha256};
use crate::private::named::{self, ArtifactError, OwnerKey, Reader, Recipient};
use crate::private::{pack, EpochKeys, PrivateError};

/// Why a snapshot cannot be sealed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SealError {
    /// The snapshot breaks a format rule.
    #[error(transparent)]
    Format(#[from] FormatError),
    /// The recipients do not match the snapshot's `to`, or the sender is not first.
    #[error("the recipients do not match the snapshot's list, with the writer first")]
    Recipients,
    /// The crypto layer refused (the RNG, a key).
    #[error(transparent)]
    Private(#[from] PrivateError),
}

/// An old-format Members snapshot sealed under `keys` (the members key chain at an epoch) as a
/// DFPK 0x01 file with a caller-chosen `fileId`: the conformance vectors and tests only. Nothing
/// writes this form any more (revision 4, D9).
#[cfg(any(test, feature = "vectors"))]
pub fn seal_members_with(
    keys: &EpochKeys,
    snap: &Snapshot,
    file_id: [u8; 16],
) -> Result<Vec<u8>, SealError> {
    let pt = snap.encode()?;
    Ok(pack::seal_with_file_id(
        keys,
        &pt,
        file_id,
        pack::WRITE_SEG_LOG2,
    )?)
}

/// The recipients must be exactly the snapshot's `to`, in order, the writer (`owner_id`) first.
fn check_recipients(snap: &Snapshot, owner_id: &[u8; 32], recipients: &[Recipient]) -> bool {
    !snap.members_key()
        && recipients
            .first()
            .is_some_and(|r| r.identity_id == *owner_id)
        && recipients.len() == snap.to.len()
        && recipients
            .iter()
            .zip(&snap.to)
            .all(|(r, t)| crate::platform::encode_identifier(r.identity_id) == *t)
}

/// Seal `snap` (version 2) from `sender` (the writer's ENCRYPTION key `sender_key_id`; the
/// writer is `owner_id`, the manifest's `$ownerId`) to `recipients` in slot order, the writer
/// first, as a DFPK 0x02 file. `snap.to` must list the same identities in the same order.
pub fn seal_letter(
    repo_id: &[u8; 32],
    sender: &PrivateKey,
    sender_key_id: u32,
    owner_id: &[u8; 32],
    recipients: &[Recipient],
    snap: &Snapshot,
) -> Result<Vec<u8>, SealError> {
    if snap.version != 2 || !check_recipients(snap, owner_id, recipients) {
        return Err(SealError::Recipients);
    }
    let pt = snap.encode()?;
    Ok(named::seal_artifact(
        repo_id,
        sender,
        sender_key_id,
        owner_id,
        recipients,
        &pt,
    )?)
}

/// [`seal_letter`] with a caller-chosen `K_obj`, `fileId` and slot IVs (any version): the
/// conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
#[allow(clippy::too_many_arguments)]
pub fn seal_letter_with(
    repo_id: &[u8; 32],
    sender: &PrivateKey,
    sender_key_id: u32,
    owner_id: &[u8; 32],
    recipients: &[Recipient],
    snap: &Snapshot,
    k_obj: &[u8; 32],
    file_id: [u8; 16],
    ivs: &[[u8; 16]],
) -> Result<Vec<u8>, SealError> {
    if !check_recipients(snap, owner_id, recipients) {
        return Err(SealError::Recipients);
    }
    let pt = snap.encode()?;
    Ok(named::seal_artifact_with(
        repo_id,
        sender,
        sender_key_id,
        owner_id,
        recipients,
        &pt,
        k_obj,
        file_id,
        named::ARTIFACT_SEG_LOG2,
        ivs,
    )?)
}

/// Why a snapshot does not open. The order of the checks is the order of the variants that can
/// occur first: the manifest's `packHash`, its `sizeBytes`, the envelope, the key, the content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenError {
    /// The bytes do not hash to the owner-signed manifest's `packHash`: never opened.
    PackHashMismatch,
    /// The bytes are not as long as the manifest's `sizeBytes`.
    SizeMismatch,
    /// The envelope or a segment failed its checks.
    SealedPackCorrupt,
    /// An old-format Members snapshot under an epoch whose key this reader does not hold.
    NoKey,
    /// A snapshot not sent to this reader.
    NotARecipient,
    /// It opened but is not a snapshot its envelope agrees with, or its sender key is not the
    /// owner's ECDSA_SECP256K1 ENCRYPTION key.
    Malformed,
}

impl OpenError {
    /// What a person is told (never "sealed", "lane" or "named").
    #[must_use]
    pub fn reason(self) -> &'static str {
        match self {
            Self::PackHashMismatch | Self::SizeMismatch | Self::SealedPackCorrupt => {
                "its stored copy is damaged or does not match what its author recorded"
            }
            Self::NoKey => "you don't hold the members key it was saved under",
            Self::NotARecipient => "it was not sent to you",
            Self::Malformed => "it is not a valid environment snapshot",
        }
    }
}

/// What the reader opens with.
pub struct OpenKeys<'a> {
    /// The repository.
    pub repo_id: &'a [u8; 32],
    /// The manifest owner's identity keys (the sender key of a letter is taken from these
    /// only).
    pub owner_keys: &'a [OwnerKey],
    /// The reader and its ENCRYPTION private keys (none: nothing addressed to people opens).
    pub reader: Option<Reader<'a>>,
    /// The members key of an epoch, when held.
    pub epoch_keys: &'a dyn Fn(u32) -> Option<&'a EpochKeys>,
}

/// The manifest fields a reader checks a snapshot against.
#[derive(Debug, Clone, Copy)]
pub struct ManifestCheck<'a> {
    /// `$ownerId`, base58.
    pub owner_id: &'a str,
    /// `packHash`.
    pub pack_hash: &'a [u8; 32],
    /// `sizeBytes`.
    pub size_bytes: u64,
}

/// Open `sealed` (one copy of a kind-8 artifact) for `manifest`, in D24's order: the bytes must
/// hash to the owner-signed `packHash` before anything is decrypted, then the envelope opens with
/// `keys`, then the content must agree with the envelope.
pub fn open(
    manifest: &ManifestCheck<'_>,
    sealed: &[u8],
    keys: &OpenKeys<'_>,
) -> Result<Snapshot, OpenError> {
    if !ct_eq(&sha256(sealed), manifest.pack_hash) {
        return Err(OpenError::PackHashMismatch);
    }
    if sealed.len() as u64 != manifest.size_bytes {
        return Err(OpenError::SizeMismatch);
    }
    if sealed.len() < 9 || sealed[..4] != pack::MAGIC {
        return Err(OpenError::SealedPackCorrupt);
    }
    let plain: Zeroizing<Vec<u8>> = match sealed[4] {
        pack::VERSION => Zeroizing::new(
            pack::open(sealed, manifest.size_bytes, |e| (keys.epoch_keys)(e)).map_err(|e| match e {
                PrivateError::NoKey(_) => OpenError::NoKey,
                PrivateError::SizeMismatch => OpenError::SizeMismatch,
                _ => OpenError::SealedPackCorrupt,
            })?,
        ),
        named::ARTIFACT_VERSION => {
            let empty = Reader {
                identity_id: [0; 32],
                keys: &[],
            };
            let reader = keys.reader.as_ref().unwrap_or(&empty);
            named::open_artifact(
                keys.repo_id,
                sealed,
                manifest.size_bytes,
                keys.owner_keys,
                reader,
            )
            .map_err(|e| match e {
                ArtifactError::SizeMismatch => OpenError::SizeMismatch,
                ArtifactError::SealedPackCorrupt => OpenError::SealedPackCorrupt,
                ArtifactError::Malformed => OpenError::Malformed,
                ArtifactError::NotARecipient => OpenError::NotARecipient,
            })?
        }
        _ => return Err(OpenError::SealedPackCorrupt),
    };
    let snap = Snapshot::decode(&plain).ok_or(OpenError::Malformed)?;
    // A DFPK 0x01 file holds only an old-format Members snapshot; a 0x02 letter anything else,
    // its `to` one entry per slot with the manifest owner first.
    let letter = sealed[4] == named::ARTIFACT_VERSION;
    if snap.members_key() == letter {
        return Err(OpenError::Malformed);
    }
    if letter
        && (snap.to.len() != usize::from(sealed[8])
            || snap.to.first().map(String::as_str) != Some(manifest.owner_id))
    {
        return Err(OpenError::Malformed);
    }
    Ok(snap)
}

/// An identity's keys as the letter reader rule takes them ([`OwnerKey`]): Platform's purpose and
/// key type numbers (ENCRYPTION = 1, ECDSA_SECP256K1 = 0; anything else a number no sender key
/// has).
#[must_use]
pub fn owner_keys(keys: &[IdentityKeyInfo]) -> Vec<OwnerKey> {
    keys.iter()
        .map(|k| OwnerKey {
            id: k.id,
            purpose: if k.purpose == "ENCRYPTION" {
                named::PURPOSE_ENCRYPTION
            } else {
                u8::MAX
            },
            key_type: if k.key_type == "ECDSA_SECP256K1" {
                named::KEY_TYPE_ECDSA_SECP256K1
            } else {
                u8::MAX
            },
            data: k.public_key.clone(),
        })
        .collect()
}
