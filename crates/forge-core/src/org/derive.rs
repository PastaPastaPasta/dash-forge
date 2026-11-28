//! A member's keys from their BIP39 seed (`dti/1` "Keys from the seed phrase").

use blstrs_plus::Scalar;
use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey as XPublic, StaticSecret};
use zeroize::Zeroizing;

use super::{bls, canon, OrgError};

const SALT: &[u8] = b"dash-threshold-identity/v1";

/// A 64-byte BIP39 seed, wiped on drop.
pub struct Seed(Zeroizing<[u8; 64]>);

impl std::fmt::Debug for Seed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Seed(..)")
    }
}

impl Seed {
    /// The seed of an English BIP39 phrase (case and spacing as typed do not matter) and an
    /// optional passphrase.
    pub fn from_phrase(phrase: &str, passphrase: &str) -> Result<Self, OrgError> {
        let words = Zeroizing::new(
            phrase
                .trim()
                .to_lowercase()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
        );
        let mnemonic = bip39::Mnemonic::parse_in(bip39::Language::English, words.as_str())
            .map_err(|_| {
                OrgError::Phrase(
                    "that is not a valid recovery phrase (English words, checksum must match)"
                        .into(),
                )
            })?;
        Ok(Self(Zeroizing::new(mnemonic.to_seed(passphrase))))
    }

    #[cfg(test)]
    pub(crate) fn from_bytes(bytes: [u8; 64]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        self.0.as_slice()
    }
}

/// One element of a length-prefixed list: text (UTF-8), a number (u32 big-endian) or bytes.
#[derive(Debug, Clone, Copy)]
pub enum Part<'a> {
    Text(&'a str),
    Num(u32),
    Bytes(&'a [u8]),
}

/// `lp(x₁) ‖ lp(x₂) ‖ …` with `lp(x) = u32be(len(x)) ‖ x`.
pub fn length_prefixed(parts: &[Part<'_>]) -> Vec<u8> {
    let mut out = Vec::new();
    for p in parts {
        let num;
        let bytes: &[u8] = match p {
            Part::Text(s) => s.as_bytes(),
            Part::Num(n) => {
                num = n.to_be_bytes();
                &num
            }
            Part::Bytes(b) => b,
        };
        let len = u32::try_from(bytes.len()).expect("part longer than 4 GiB");
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(bytes);
    }
    out
}

pub fn kdf(seed: &Seed, label: &str, parts: &[Part<'_>], len: usize) -> Zeroizing<Vec<u8>> {
    let mut info = vec![Part::Text(label)];
    info.extend_from_slice(parts);
    let mut okm = Zeroizing::new(vec![0u8; len]);
    Hkdf::<Sha256>::new(Some(SALT), seed.bytes())
        .expand(&length_prefixed(&info), &mut okm)
        .expect("HKDF output length is small");
    okm
}

/// The first nonzero `OS2IP(kdf(label, parts…, counter, 64)) mod r`.
pub fn kdf_scalar(seed: &Seed, label: &str, parts: &[Part<'_>]) -> Scalar {
    for counter in 0u32.. {
        let mut with = parts.to_vec();
        with.push(Part::Num(counter));
        let okm = kdf(seed, label, &with, 64);
        let x = bls::scalar_from_be_wide(&okm);
        if !bool::from(blstrs_plus::ff::Field::is_zero(&x)) {
            return x;
        }
    }
    unreachable!("a nonzero scalar is found long before u32 runs out")
}

/// A member's message-signing (Ed25519) and transport (X25519) keys.
pub struct MemberKeys {
    auth: SigningKey,
    transport: StaticSecret,
    pub auth_pub: String,
    pub transport_pub: String,
    pub fingerprint: String,
}

impl std::fmt::Debug for MemberKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemberKeys")
            .field("auth_pub", &self.auth_pub)
            .finish_non_exhaustive()
    }
}

impl MemberKeys {
    pub fn derive(seed: &Seed) -> Self {
        let auth_bytes: [u8; 32] = kdf(seed, "auth/ed25519", &[], 32)[..]
            .try_into()
            .expect("32 bytes");
        let auth = SigningKey::from_bytes(&auth_bytes);
        let transport_bytes: [u8; 32] = kdf(seed, "transport/x25519", &[], 32)[..]
            .try_into()
            .expect("32 bytes");
        let transport = StaticSecret::from(transport_bytes);
        let auth_pub = hex::encode(auth.verifying_key().as_bytes());
        let transport_pub = hex::encode(XPublic::from(&transport).as_bytes());
        let fingerprint = fingerprint(&auth_pub, &transport_pub);
        Self {
            auth,
            transport,
            auth_pub,
            transport_pub,
            fingerprint,
        }
    }

    pub(crate) fn auth(&self) -> &SigningKey {
        &self.auth
    }

    pub(crate) fn transport(&self) -> &StaticSecret {
        &self.transport
    }
}

/// `SHA-256("dti-fingerprint|authPub|transportPub")`, first 16 bytes, upper-case, in 8 groups.
pub fn fingerprint(auth_pub: &str, transport_pub: &str) -> String {
    let h = canon::sha256_hex(format!("dti-fingerprint|{auth_pub}|{transport_pub}").as_bytes())
        .to_uppercase();
    h.as_bytes()[..32]
        .chunks(4)
        .map(|c| std::str::from_utf8(c).expect("hex is ASCII"))
        .collect::<Vec<_>>()
        .join("-")
}

/// The member's DKG polynomial coefficients for ceremony `cid`, slot `slot`.
pub fn dkg_coefficients(seed: &Seed, cid: &str, slot: &str, threshold: usize) -> Vec<Scalar> {
    (0..threshold)
        .map(|k| {
            let k = u32::try_from(k).expect("threshold fits u32");
            kdf_scalar(
                seed,
                "dkg/coefficient",
                &[Part::Text(cid), Part::Text(slot), Part::Num(k)],
            )
        })
        .collect()
}
