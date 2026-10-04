//! Signed-commit badges (P1-7): who signed a git commit, judged against the signing keys
//! identities list in their `profile.pubkeys` (`docs/contracts/forge-v2.md` §2). The TypeScript
//! half is `forge-web/lib/rules/signature.ts`; the `pubkey_entry` and `commit_signature` vectors
//! hold them equal.
//!
//! **Key entries** (`profile.pubkeys`, at most 4 of at most 300 bytes):
//! - `ssh-ed25519 <base64> [comment]`: an OpenSSH public key line. Other SSH key types are read
//!   (their fingerprint shows) but never verify.
//! - `gpg:<FINGERPRINT> <base64>`: an OpenPGP key's signing (sub)key as one public-key or
//!   public-subkey packet, whose fingerprint must be FINGERPRINT (40 hex, v4; 64 hex, v6).
//!   Ed25519 (EdDSA, algorithms 22 and 27) and ECDSA on P-256/384/521 verify. `gpg:<FINGERPRINT>`
//!   alone names a key it does not publish, so it never verifies.
//!
//! **A commit's verdict** ([`verify_commit_signature`]): the signature git stores in the `gpgsig`
//! header (`gpgsig-sha256` in a SHA-256 repository) over the object without its signature
//! headers, exactly as `git verify-commit` reads it. Verified needs a signature that checks
//! against a key listed by exactly one of the candidate identities (a repository's owner and
//! members); the same key on two identities' profiles is ambiguous. SSH signatures must be in
//! git's `git` namespace. Only SHA-256/384/512 and SHA3-256/512 digests and binary-document
//! OpenPGP signatures are accepted. Nothing proves an identity holds the key it lists: Verified
//! means "signed with a key this identity publishes".
//!
//! Verification runs in well-vetted libraries: rPGP for OpenPGP, `ed25519-dalek` for the Ed25519
//! of an SSH signature, whose `sshsig` envelope is parsed here per OpenSSH's PROTOCOL.sshsig.

use std::collections::BTreeSet;

use base64::Engine as _;
use pgp::composed::{Deserializable as _, DetachedSignature};
use pgp::crypto::hash::HashAlgorithm;
use pgp::crypto::public_key::PublicKeyAlgorithm;
use pgp::packet::{Packet, PacketParser, SignatureType};
use pgp::types::{EcdsaPublicParams, KeyDetails as _, PublicParams};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256, Sha512};

/// Who may have signed: an identity and its `profile.pubkeys`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Signer {
    pub identity: String,
    pub pubkeys: Vec<String>,
}

/// How an entry of `profile.pubkeys` reads (what the `pubkey_entry` vectors pin).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PubkeyEntryView {
    /// `ssh`, `openpgp` or `invalid`.
    pub kind: String,
    /// `SHA256:<base64>` (SSH) or the uppercase hex fingerprint (OpenPGP).
    pub fingerprint: Option<String>,
    /// Whether a signature can be checked against it.
    pub verifiable: bool,
}

/// A signed commit's verdict (what the `commit_signature` vectors pin).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignatureVerdict {
    /// `verified` or `unverified`.
    pub status: String,
    /// Why it is unverified: `unknown_key`, `ambiguous_key`, `bad_signature`, `unsupported`,
    /// `malformed`.
    pub reason: Option<String>,
    /// `ssh`, `openpgp`, `x509` or `unknown`.
    pub format: String,
    /// The signing key: `SHA256:…` (SSH), the issuer fingerprint or key id in hex (OpenPGP).
    pub key: Option<String>,
    /// The identity whose profile lists the key, when exactly one does.
    pub signer: Option<String>,
}

impl SignatureVerdict {
    /// Whether the signature verified.
    pub fn verified(&self) -> bool {
        self.status == "verified"
    }
}

fn verdict(format: &str, key: Option<String>, reason: Option<&str>) -> SignatureVerdict {
    SignatureVerdict {
        status: if reason.is_none() {
            "verified"
        } else {
            "unverified"
        }
        .into(),
        reason: reason.map(str::to_string),
        format: format.into(),
        key,
        signer: None,
    }
}

// --- the signature git stores ----------------------------------------------------------------

/// A commit's signature and the bytes it signs, as git's `parse_buffer_signed_by_header` splits
/// them: the header named for the repository's hash (`gpgsig`, or `gpgsig-sha256`) and its
/// continuation lines are the signature (each line without its leading space); every signature
/// header, of either hash, is left out of the payload; the message after the blank line is kept
/// whole. `None` for an unsigned commit.
pub fn split_signed_commit(bytes: &[u8], sha256_repo: bool) -> Option<(Vec<u8>, String)> {
    let header: &[u8] = if sha256_repo {
        b"gpgsig-sha256"
    } else {
        b"gpgsig"
    };
    let (mut payload, mut signature) = (Vec::new(), Vec::new());
    let (mut in_signature, mut other_signature, mut saw) = (false, false, false);
    let mut line = 0;
    while line < bytes.len() {
        let mut next = bytes[line..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(bytes.len(), |i| line + i + 1);
        let rest = &bytes[line..];
        let sig = if in_signature && rest.first() == Some(&b' ') {
            Some(line + 1)
        } else if rest.starts_with(header) && rest.get(header.len()) == Some(&b' ') {
            other_signature = false;
            Some(line + header.len() + 1)
        } else {
            if rest.starts_with(b"gpgsig") {
                other_signature = true;
            } else if other_signature && rest.first() != Some(&b' ') {
                other_signature = false;
            }
            None
        };
        if let Some(from) = sig {
            signature.extend_from_slice(&bytes[from..next]);
            saw = true;
            in_signature = true;
        } else {
            // The blank line ends the header: the message is copied whole.
            if rest.first() == Some(&b'\n') {
                next = bytes.len();
            }
            if !other_signature {
                payload.extend_from_slice(&bytes[line..next]);
            }
            in_signature = false;
        }
        line = next;
    }
    saw.then(|| (payload, String::from_utf8_lossy(&signature).into_owned()))
}

// --- bytes, base64, SSH wire strings ---------------------------------------------------------

/// Strict base64 (padding as written).
fn b64(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(4) {
        return None;
    }
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

/// OpenSSH's fingerprint: `SHA256:` and the unpadded base64 of the key blob's SHA-256.
pub fn ssh_fingerprint(blob: &[u8]) -> String {
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(blob))
    )
}

/// A reader of SSH wire `string`s and `uint32`s.
struct Wire<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Wire<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self { b, at: 0 }
    }
    fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        let out = self.b.get(self.at..self.at.checked_add(n)?)?;
        self.at += n;
        Some(out)
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_be_bytes(self.bytes(4)?.try_into().ok()?))
    }
    fn string(&mut self) -> Option<&'a [u8]> {
        let n = usize::try_from(self.u32()?).ok()?;
        self.bytes(n)
    }
    fn text(&mut self) -> Option<String> {
        Some(String::from_utf8_lossy(self.string()?).into_owned())
    }
    fn done(&self) -> bool {
        self.at == self.b.len()
    }
}

fn wire_string(b: &[u8]) -> Vec<u8> {
    let mut out = u32::try_from(b.len())
        .unwrap_or(u32::MAX)
        .to_be_bytes()
        .to_vec();
    out.extend_from_slice(b);
    out
}

/// An `ssh-ed25519` key blob's 32-byte key, or `None` for any other blob.
fn ed25519_key(blob: &[u8]) -> Option<[u8; 32]> {
    let mut w = Wire::new(blob);
    if w.text()? != "ssh-ed25519" {
        return None;
    }
    let key: [u8; 32] = w.string()?.try_into().ok()?;
    w.done().then_some(key)
}

// --- key entries -----------------------------------------------------------------------------

/// An entry, parsed.
enum Entry {
    Ssh {
        blob: Vec<u8>,
        fingerprint: String,
        verifiable: bool,
    },
    OpenPgp {
        fingerprint: String,
        packet: Option<Vec<u8>>,
        verifiable: bool,
    },
    Invalid,
}

fn is_ssh_type(t: &str) -> bool {
    let tail_ok = |s: &str, extra: &[u8]| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || extra.contains(&b))
    };
    t.strip_prefix("ssh-").is_some_and(|s| tail_ok(s, b"-"))
        || t.strip_prefix("ecdsa-sha2-")
            .is_some_and(|s| tail_ok(s, b"-"))
        || t.strip_prefix("sk-").is_some_and(|s| tail_ok(s, b"-@."))
}

fn is_fingerprint(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The one public-key or public-subkey packet `bytes` holds.
fn read_key_packet(bytes: &[u8]) -> Option<KeyPacket> {
    let mut parsed = PacketParser::new(bytes);
    let key = match parsed.next()?.ok()? {
        Packet::PublicKey(k) => KeyPacket::Primary(k),
        Packet::PublicSubkey(k) => KeyPacket::Sub(k),
        _ => return None,
    };
    parsed.next().is_none().then_some(key)
}

/// A key packet an entry holds.
enum KeyPacket {
    Primary(pgp::packet::PublicKey),
    Sub(pgp::packet::PublicSubkey),
}

impl KeyPacket {
    fn fingerprint(&self) -> String {
        let fp = match self {
            KeyPacket::Primary(k) => k.fingerprint(),
            KeyPacket::Sub(k) => k.fingerprint(),
        };
        hex::encode_upper(fp.as_bytes())
    }
    /// A packet rPGP read but whose algorithm it does not know (OpenPGP.js cannot parse it):
    /// invalid, as the web reads it.
    fn unknown(&self) -> bool {
        let params = match self {
            KeyPacket::Primary(k) => k.public_params(),
            KeyPacket::Sub(k) => k.public_params(),
        };
        matches!(params, PublicParams::Unknown { .. })
    }
    fn verifiable(&self) -> bool {
        let (alg, params) = match self {
            KeyPacket::Primary(k) => (k.algorithm(), k.public_params()),
            KeyPacket::Sub(k) => (k.algorithm(), k.public_params()),
        };
        match alg {
            PublicKeyAlgorithm::EdDSALegacy | PublicKeyAlgorithm::Ed25519 => true,
            PublicKeyAlgorithm::ECDSA => matches!(
                params,
                PublicParams::ECDSA(
                    EcdsaPublicParams::P256 { .. }
                        | EcdsaPublicParams::P384 { .. }
                        | EcdsaPublicParams::P521 { .. }
                )
            ),
            _ => false,
        }
    }
    fn verify(&self, sig: &pgp::packet::Signature, payload: &[u8]) -> bool {
        match self {
            KeyPacket::Primary(k) => sig.verify(k, payload).is_ok(),
            KeyPacket::Sub(k) => sig.verify(k, payload).is_ok(),
        }
    }
}

fn parse_entry(entry: &str) -> Entry {
    if let Some(rest) = entry.strip_prefix("gpg:") {
        let parts: Vec<&str> = rest.split(' ').collect();
        let (fpr, data) = match parts.as_slice() {
            [fpr] => (*fpr, None),
            [fpr, data] => (*fpr, Some(*data)),
            _ => return Entry::Invalid,
        };
        if !is_fingerprint(fpr) {
            return Entry::Invalid;
        }
        let fingerprint = fpr.to_ascii_uppercase();
        let Some(data) = data else {
            return Entry::OpenPgp {
                fingerprint,
                packet: None,
                verifiable: false,
            };
        };
        let Some(bytes) = b64(data) else {
            return Entry::Invalid;
        };
        let Some(key) = read_key_packet(&bytes) else {
            return Entry::Invalid;
        };
        if key.unknown() || key.fingerprint() != fingerprint {
            return Entry::Invalid;
        }
        return Entry::OpenPgp {
            fingerprint,
            verifiable: key.verifiable(),
            packet: Some(bytes),
        };
    }
    let mut parts = entry.split(' ');
    let (Some(typ), Some(data)) = (parts.next(), parts.next()) else {
        return Entry::Invalid;
    };
    if !is_ssh_type(typ) {
        return Entry::Invalid;
    }
    let Some(blob) = b64(data) else {
        return Entry::Invalid;
    };
    if Wire::new(&blob).text().as_deref() != Some(typ) {
        return Entry::Invalid;
    }
    Entry::Ssh {
        fingerprint: ssh_fingerprint(&blob),
        verifiable: ed25519_key(&blob).is_some(),
        blob,
    }
}

/// How a `profile.pubkeys` entry reads: what the `pubkey_entry` vectors pin.
pub fn read_pubkey_entry(entry: &str) -> PubkeyEntryView {
    match parse_entry(entry) {
        Entry::Ssh {
            fingerprint,
            verifiable,
            ..
        } => PubkeyEntryView {
            kind: "ssh".into(),
            fingerprint: Some(fingerprint),
            verifiable,
        },
        Entry::OpenPgp {
            fingerprint,
            verifiable,
            ..
        } => PubkeyEntryView {
            kind: "openpgp".into(),
            fingerprint: Some(fingerprint),
            verifiable,
        },
        Entry::Invalid => PubkeyEntryView {
            kind: "invalid".into(),
            fingerprint: None,
            verifiable: false,
        },
    }
}

// --- verdicts --------------------------------------------------------------------------------

/// The verdict once the signature checked against a key `owners` list.
fn by_owners(format: &str, key: String, owners: &BTreeSet<&str>) -> SignatureVerdict {
    match owners.len() {
        0 => verdict(format, Some(key), Some("unknown_key")),
        1 => SignatureVerdict {
            signer: owners.iter().next().map(|s| (*s).to_string()),
            ..verdict(format, Some(key), None)
        },
        _ => verdict(format, Some(key), Some("ambiguous_key")),
    }
}

/// The base64 body of an ASCII-armored block.
fn armor_body(armored: &str, label: &str) -> Option<Vec<u8>> {
    let lines: Vec<&str> = armored.split('\n').map(str::trim).collect();
    let begin = lines
        .iter()
        .position(|l| *l == format!("-----BEGIN {label}-----"))?;
    let end = lines
        .iter()
        .position(|l| *l == format!("-----END {label}-----"))?;
    if end <= begin {
        return None;
    }
    b64(&lines[begin + 1..end].concat())
}

fn verify_ssh(armored: &str, payload: &[u8], entries: &[(&str, Entry)]) -> SignatureVerdict {
    let malformed = |key| verdict("ssh", key, Some("malformed"));
    let Some(body) = armor_body(armored, "SSH SIGNATURE") else {
        return malformed(None);
    };
    let mut w = Wire::new(&body);
    let parsed = (|| {
        if w.bytes(6)? != b"SSHSIG" || w.u32()? != 1 {
            return None;
        }
        let public_key = w.string()?;
        let namespace = w.text()?;
        let reserved = w.string()?;
        let hash_alg = w.text()?;
        let sig_blob = w.string()?;
        w.done()
            .then_some((public_key, namespace, reserved, hash_alg, sig_blob))
    })();
    let Some((public_key, namespace, reserved, hash_alg, sig_blob)) = parsed else {
        return malformed(None);
    };
    let key = ssh_fingerprint(public_key);
    if namespace != "git" {
        return verdict("ssh", Some(key), Some("bad_signature"));
    }
    let raw = ed25519_key(public_key);
    let mut sw = Wire::new(sig_blob);
    let (Some(sig_type), Some(sig)) = (sw.text(), sw.string()) else {
        return malformed(Some(key));
    };
    if !sw.done() || (raw.is_some() && (sig_type != "ssh-ed25519" || sig.len() != 64)) {
        return malformed(Some(key));
    }
    let digest = match hash_alg.as_str() {
        "sha512" => Sha512::digest(payload).to_vec(),
        "sha256" => Sha256::digest(payload).to_vec(),
        _ => return verdict("ssh", Some(key), Some("unsupported")),
    };
    let Some(raw) = raw else {
        return verdict("ssh", Some(key), Some("unsupported"));
    };
    // PROTOCOL.sshsig: the magic, then the namespace, the reserved string, the hash algorithm
    // and the digest of the message, each as an SSH string.
    let mut signed = b"SSHSIG".to_vec();
    for part in [
        namespace.as_bytes(),
        reserved,
        hash_alg.as_bytes(),
        digest.as_slice(),
    ] {
        signed.extend(wire_string(part));
    }
    let ok = ed25519_dalek::VerifyingKey::from_bytes(&raw).is_ok_and(|vk| {
        <[u8; 64]>::try_from(sig).is_ok_and(|s| {
            vk.verify_strict(&signed, &ed25519_dalek::Signature::from_bytes(&s))
                .is_ok()
        })
    });
    if !ok {
        return verdict("ssh", Some(key), Some("bad_signature"));
    }
    let owners: BTreeSet<&str> = entries
        .iter()
        .filter(|(_, e)| {
            matches!(e, Entry::Ssh { blob, verifiable: true, .. } if blob.as_slice() == public_key)
        })
        .map(|(id, _)| *id)
        .collect();
    by_owners("ssh", key, &owners)
}

fn verify_openpgp(armored: &str, payload: &[u8], entries: &[(&str, Entry)]) -> SignatureVerdict {
    let Ok((detached, _)) = DetachedSignature::from_armor_single(armored.as_bytes()) else {
        return verdict("openpgp", None, Some("malformed"));
    };
    let sig = detached.signature;
    let fpr = sig
        .issuer_fingerprint()
        .first()
        .map(|f| hex::encode_upper(f.as_bytes()));
    let key_id = sig
        .issuer_key_id()
        .first()
        .map(|k| hex::encode_upper(k.as_ref()))
        .filter(|h| h.bytes().any(|b| b != b'0'));
    let Some(key) = fpr.clone().or_else(|| key_id.clone()) else {
        // A signature that names no issuer names no key to check it with.
        return verdict("openpgp", None, Some("malformed"));
    };
    let strong = matches!(
        sig.hash_alg(),
        Some(
            HashAlgorithm::Sha256
                | HashAlgorithm::Sha384
                | HashAlgorithm::Sha512
                | HashAlgorithm::Sha3_256
                | HashAlgorithm::Sha3_512
        )
    );
    if sig.typ() != Some(SignatureType::Binary) || !strong {
        return verdict("openpgp", Some(key), Some("unsupported"));
    }
    // The entries whose key the signature names, by its fingerprint, else its key id.
    let matches: Vec<(&str, &Vec<u8>)> = entries
        .iter()
        .filter_map(|(id, e)| match e {
            Entry::OpenPgp {
                fingerprint,
                packet: Some(packet),
                verifiable: true,
            } => {
                let named = match (&fpr, &key_id) {
                    (Some(f), _) => fingerprint == f,
                    (None, Some(k)) => fingerprint.len() == 40 && fingerprint.ends_with(k),
                    (None, None) => false,
                };
                named.then_some((*id, packet))
            }
            _ => None,
        })
        .collect();
    let Some(key_packet) = matches.first().and_then(|(_, p)| read_key_packet(p)) else {
        return verdict("openpgp", Some(key), Some("unknown_key"));
    };
    if !key_packet.verify(&sig, payload) {
        return verdict("openpgp", Some(key), Some("bad_signature"));
    }
    by_owners(
        "openpgp",
        key,
        &matches.iter().map(|(id, _)| *id).collect::<BTreeSet<_>>(),
    )
}

/// The verdict on a commit (its raw object bytes) against `signers`, or `None` for an unsigned
/// commit. `sha256_repo`: the repository's objects are SHA-256 (`gpgsig-sha256`).
pub fn verify_commit_signature(
    bytes: &[u8],
    signers: &[Signer],
    sha256_repo: bool,
) -> Option<SignatureVerdict> {
    let (payload, signature) = split_signed_commit(bytes, sha256_repo)?;
    let entries: Vec<(&str, Entry)> = signers
        .iter()
        .flat_map(|s| {
            s.pubkeys
                .iter()
                .map(|k| (s.identity.as_str(), parse_entry(k)))
        })
        .collect();
    let first = signature.split('\n').next().unwrap_or("").trim();
    Some(match first {
        "-----BEGIN SSH SIGNATURE-----" => verify_ssh(&signature, &payload, &entries),
        "-----BEGIN PGP SIGNATURE-----" => verify_openpgp(&signature, &payload, &entries),
        "-----BEGIN SIGNED MESSAGE-----" => verdict("x509", None, Some("unsupported")),
        _ => verdict("unknown", None, Some("malformed")),
    })
}
