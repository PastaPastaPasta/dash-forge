//! The key hierarchy of `docs/security/private-repos.md` §2: epoch keys and their HKDF-SHA256
//! subkeys, the RNG hedge of §3.6, and the constant-time comparisons every check uses.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use super::PrivateError;

/// The 14-byte key-check value (§2.3, §5.1): error detection, never authorization.
pub type Kcv = [u8; 14];

/// A 32-byte epoch key `K_e` (§2.1). Zeroized on drop; its `Debug` never shows the bytes, its
/// equality is constant-time, and it serializes as hex only in test / `vectors` builds.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct EpochKey([u8; 32]);

impl PartialEq for EpochKey {
    fn eq(&self, other: &Self) -> bool {
        ct_eq(&self.0, &other.0)
    }
}

impl Eq for EpochKey {}

/// Serde for an `Option<EpochKey>` field: hex in, and hex out only in test / `vectors` builds;
/// any other build writes `"<redacted>"`, so no `serde_json::to_string` can leak a key.
pub(crate) mod opt_key_serde {
    use super::EpochKey;
    use serde::{Deserialize, Deserializer, Serializer};

    #[allow(clippy::ref_option)]
    pub fn serialize<S: Serializer>(k: &Option<EpochKey>, s: S) -> Result<S::Ok, S::Error> {
        match k {
            #[cfg(any(test, feature = "vectors"))]
            Some(k) => s.serialize_str(&hex::encode(k.expose())),
            #[cfg(not(any(test, feature = "vectors")))]
            Some(_) => s.serialize_str("<redacted>"),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<EpochKey>, D::Error> {
        let s = zeroize::Zeroizing::new(String::deserialize(d)?);
        let bytes =
            zeroize::Zeroizing::new(hex::decode(s.as_str()).map_err(serde::de::Error::custom)?);
        EpochKey::from_slice(&bytes)
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("an epoch key is 32 bytes"))
    }
}

impl EpochKey {
    /// A fresh key from the OS CSPRNG, for a maintainer creating an epoch.
    pub fn generate() -> Result<Self, PrivateError> {
        let mut k = [0u8; 32];
        getrandom::getrandom(&mut k).map_err(|_| PrivateError::Rng)?;
        Ok(Self(k))
    }

    /// Wrap raw key bytes (a recovered wrap, a `prevEpochKey`, a journal entry).
    #[must_use]
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Copy a key out of a slice that must be exactly 32 bytes.
    pub fn from_slice(bytes: &[u8]) -> Option<Self> {
        <[u8; 32]>::try_from(bytes).ok().map(Self)
    }

    /// The raw bytes, for the wrap plaintext and the TLV `prevEpochKey` record only.
    #[must_use]
    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for EpochKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EpochKey(<redacted>)")
    }
}

/// `"dash-forge/v2/" ‖ label ‖ 0x00 ‖ u32(e) ‖ x`, the HKDF `info` of §2.2.
fn info(label: &str, epoch: u32, extra: &[u8]) -> Vec<u8> {
    let mut i = Vec::with_capacity(14 + label.len() + 5 + extra.len());
    i.extend_from_slice(b"dash-forge/v2/");
    i.extend_from_slice(label.as_bytes());
    i.push(0);
    i.extend_from_slice(&epoch.to_be_bytes());
    i.extend_from_slice(extra);
    i
}

/// The subkeys of one epoch of one repository (§2.2), derived once and cached for the session.
///
/// Every field is zeroized on drop. `Debug` shows the epoch and the (non-secret) key-check value
/// only, the way the UI names a key: "epoch 3 · `7cab1ab7…`".
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct EpochKeys {
    #[zeroize(skip)]
    repo_id: [u8; 32],
    #[zeroize(skip)]
    epoch: u32,
    prk: [u8; 32],
    doc: [u8; 32],
    ref_key: [u8; 32],
    /// `K_tag,e`: the HMAC key of a sealed release's `tagName` (§16.1), never an AEAD key.
    tag_key: [u8; 32],
    hedge: [u8; 32],
    #[zeroize(skip)]
    kcv: Kcv,
    #[zeroize(skip)]
    commit: [u8; 32],
}

impl EpochKeys {
    /// Derive every subkey of `key` for `epoch` of the repository `repo_id`.
    #[must_use]
    pub fn derive(repo_id: &[u8; 32], epoch: u32, key: &EpochKey) -> Self {
        // HKDF-Extract(salt = repoId, IKM = K_e)
        let (prk, _) = Hkdf::<Sha256>::extract(Some(repo_id), key.expose());
        let mut keys = Self {
            repo_id: *repo_id,
            epoch,
            prk: prk.into(),
            doc: [0; 32],
            ref_key: [0; 32],
            tag_key: [0; 32],
            hedge: [0; 32],
            kcv: [0; 14],
            commit: [0; 32],
        };
        keys.doc = keys.expand("doc", &[]);
        keys.ref_key = keys.expand("ref", &[]);
        keys.tag_key = keys.expand("tag", &[]);
        keys.hedge = keys.expand("hedge", &[]);
        keys.commit = keys.expand("commit", &[]);
        let kcv = Zeroizing::new(keys.expand("kcv", &[]));
        keys.kcv.copy_from_slice(&kcv[..14]);
        keys
    }

    fn expand(&self, label: &str, extra: &[u8]) -> [u8; 32] {
        let hk = Hkdf::<Sha256>::from_prk(&self.prk).expect("a 32-byte PRK is a valid HKDF PRK");
        let mut okm = [0u8; 32];
        hk.expand(&info(label, self.epoch, extra), &mut okm)
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        okm
    }

    /// The repository these keys belong to.
    #[must_use]
    pub fn repo_id(&self) -> &[u8; 32] {
        &self.repo_id
    }

    /// The epoch these keys belong to.
    #[must_use]
    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    /// `KCV_e`, the first 14 bytes of the `kcv` subkey.
    #[must_use]
    pub fn kcv(&self) -> &Kcv {
        &self.kcv
    }

    /// `COMMIT_e`, the key commitment an anchor carries (§4.2, §5.3).
    #[must_use]
    pub fn commit(&self) -> &[u8; 32] {
        &self.commit
    }

    pub(crate) fn doc_key(&self) -> &[u8; 32] {
        &self.doc
    }

    /// `K_pack,e,fileId` for one sealed artifact (§3.3): the header version byte is part of the
    /// domain string.
    pub(crate) fn pack_key(&self, file_id: &[u8; 16]) -> Zeroizing<[u8; 32]> {
        let mut extra = [0u8; 17];
        extra[0] = super::pack::VERSION;
        extra[1..].copy_from_slice(file_id);
        Zeroizing::new(self.expand("pack", &extra))
    }

    /// `refNameHash = HMAC-SHA256(K_ref,e, refName)` (§4.5).
    #[must_use]
    pub fn ref_name_hash(&self, ref_name: &str) -> [u8; 32] {
        hmac(&self.ref_key, &[ref_name.as_bytes()])
    }

    /// `HMAC-SHA256(K_tag,e, tag)` (§16.1): a sealed release's tag, keyed per epoch and in a
    /// domain independent of [`Self::ref_name_hash`].
    #[must_use]
    pub fn release_tag_hash(&self, tag: &str) -> [u8; 32] {
        hmac(&self.tag_key, &[tag.as_bytes()])
    }

    /// Whether `commit` is this epoch's commitment, in constant time.
    #[must_use]
    pub fn commits_to(&self, commit: &[u8]) -> bool {
        ct_eq(&self.commit, commit)
    }

    /// `HMAC-SHA256(K_hedge,e, parts…)`: the §3.6 hedge over fresh randomness.
    pub(crate) fn hedge(&self, parts: &[&[u8]]) -> [u8; 32] {
        hmac(&self.hedge, parts)
    }

    /// `fileId = HMAC(K_hedge,e, 0x01 ‖ rnd(32) ‖ SHA-256(plaintext))[0..16]` (§3.6).
    pub(crate) fn hedged_file_id(&self, rnd: &[u8; 32], plaintext_sha256: &[u8; 32]) -> [u8; 16] {
        let mac = self.hedge(&[&[0x01], rnd, plaintext_sha256]);
        let mut id = [0u8; 16];
        id.copy_from_slice(&mac[..16]);
        id
    }

    /// `doc nonce = HMAC(K_hedge,e, 0x02 ‖ rnd(32) ‖ AD ‖ SHA-256(plaintext))[0..12]` (§3.6).
    pub(crate) fn hedged_nonce(&self, rnd: &[u8; 32], ad: &[u8], plaintext: &[u8]) -> [u8; 12] {
        let mac = self.hedge(&[&[0x02], rnd, ad, &sha256(plaintext)]);
        let mut n = [0u8; 12];
        n.copy_from_slice(&mac[..12]);
        n
    }

    /// The raw subkeys, for the conformance vectors only.
    #[cfg(any(test, feature = "vectors"))]
    #[must_use]
    pub fn raw_subkeys_for_vectors(&self) -> [[u8; 32]; 4] {
        [self.prk, self.doc, self.ref_key, self.hedge]
    }

    /// `K_pack,e,fileId`, for the conformance vectors only.
    #[cfg(any(test, feature = "vectors"))]
    #[must_use]
    pub fn raw_pack_key_for_vectors(&self, file_id: &[u8; 16]) -> [u8; 32] {
        *self.pack_key(file_id)
    }
}

impl std::fmt::Debug for EpochKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EpochKeys")
            .field("epoch", &self.epoch)
            .field("kcv", &hex::encode(&self.kcv[..4]))
            .finish_non_exhaustive()
    }
}

fn hmac(key: &[u8; 32], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    for p in parts {
        mac.update(p);
    }
    mac.finalize().into_bytes().into()
}

/// SHA-256.
#[must_use]
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Byte equality in constant time for equal lengths (commitments, KCVs, ref-name hashes).
/// Different lengths are unequal; a length is not secret.
#[must_use]
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

/// 32 bytes of fresh CSPRNG output: the `rnd(32)` of §3.6.
pub(crate) fn rnd32() -> Result<[u8; 32], PrivateError> {
    let mut r = [0u8; 32];
    getrandom::getrandom(&mut r).map_err(|_| PrivateError::Rng)?;
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_shows_key_material() {
        let key = EpochKey::from_bytes([0xab; 32]);
        assert_eq!(format!("{key:?}"), "EpochKey(<redacted>)");
        let keys = EpochKeys::derive(&[0x11; 32], 0, &key);
        let shown = format!("{keys:?}");
        assert!(!shown.contains("abab"), "{shown}");
        assert!(shown.contains("epoch: 0"), "{shown}");
    }

    #[test]
    fn generated_keys_differ() {
        assert_ne!(EpochKey::generate().unwrap(), EpochKey::generate().unwrap());
    }

    #[test]
    fn ct_eq_is_equality() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
    }
}
