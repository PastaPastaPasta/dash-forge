//! Check runs on members-only branches (`docs/security/private-repos.md` §19.8, mixed-visibility
//! DESIGN §4.3 "CI on a members branch").
//!
//! A check run is a public `checkRun` document: its `headOid`, `name`, status, conclusion and
//! times are plaintext. On a members-only branch a runner reports the commit's **blind** as
//! `headOid` (rule C: the bytes the introducing ref update carries, [`super::blind`]), an
//! **opaque name**, no summary, details link, run id or artifacts, and its log **sealed** at an
//! `https://` or `ipfs://` `logUrl` whose `logSha256` covers the sealed bytes:
//!
//! ```text
//! K_name  = HMAC-SHA256(salt, "dash-forge/v2/check-name")
//! name'   = base32(HMAC-SHA256(K_name, 0x01 ‖ name))[0..16]               (RFC 4648, lower case)
//! K_log   = HMAC-SHA256(K_name, 0x02 ‖ nonce)
//! AD      = "DFCL" ‖ 0x01 ‖ u8(len(blind)) ‖ blind ‖ name'
//! P       = u32(len(H)) ‖ H ‖ u64(len(log)) ‖ log ‖ 0x00 … (to a multiple of 4,096 bytes)
//! H       = {"head":"<real commit hex>","name":"<check name>","v":1}       (exactly this form)
//! sealed  = "DFCL" ‖ 0x01 ‖ nonce(12) ‖ AES-256-GCM(K_log, nonce, P, AD)
//! ```
//!
//! `salt` is the blind's salt (TLV 27 of the update that introduced the commit), so the key is
//! per pushed commit: the public cannot link two pushes of one branch by their check names, as it
//! cannot link their blinds (DESIGN D4). Members hold the salt (they open the update) and so
//! resolve a name by opening the run's log, whose header names the check; the header's name must
//! hash to the run's opaque name and its commit to the run's blind, so a log moved to another run
//! does not open there. `H` is read only in its one canonical form (these keys in this order, no
//! spaces, JSON's shortest escapes, lower-case hex), so every reader reads the same header. A runner outside the members gets the salt in a branch key letter (phase 4).

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use super::blind::{self, Salt};
use super::keys::ct_eq;
use super::PrivateError;

/// The conformance vectors' case (`forge-contracts/vectors/members_check__*.json`).
pub const CASE: &str = "members_check";
/// The sealed log's magic.
pub const MAGIC: &[u8; 4] = b"DFCL";
/// The sealed log format this client writes and opens.
pub const VERSION: u8 = 0x01;
/// The opaque name's length in base32 characters (80 bits).
pub const OPAQUE_NAME_LEN: usize = 16;
/// The sealed plaintext is padded to a multiple of this.
pub const PAD: usize = 4096;

const NAME_LABEL: &[u8] = b"dash-forge/v2/check-name";
/// `K_name`'s two uses, kept apart: an opaque name, a log key.
const NAME_DOMAIN: u8 = 0x01;
const LOG_DOMAIN: u8 = 0x02;
const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
/// magic, version, nonce, GCM tag.
const OVERHEAD: usize = 4 + 1 + 12 + 16;

fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    for p in parts {
        mac.update(p);
    }
    mac.finalize().into_bytes().into()
}

/// RFC 4648 base32, lower case, no padding.
fn base32(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in bytes {
        acc = (acc << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32[((acc >> bits) & 31) as usize] as char);
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(BASE32[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Whether `name` has the shape of an opaque check name: 16 characters of `a`–`z` and `2`–`7`.
/// A public check may happen to be named so; only a run on a blind a member can map is resolved.
#[must_use]
pub fn is_opaque_name(name: &str) -> bool {
    name.len() == OPAQUE_NAME_LEN && name.bytes().all(|b| BASE32.contains(&b))
}

/// The keys of the check runs on one blinded commit: `K_name` from the blind's salt.
#[derive(Clone)]
pub struct CheckKeys {
    salt: Zeroizing<Salt>,
    name_key: Zeroizing<[u8; 32]>,
}

/// It holds a salt and a key: `Debug` shows neither.
impl std::fmt::Debug for CheckKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CheckKeys(<redacted>)")
    }
}

/// The header a sealed log opens to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    head: String,
    name: String,
    v: u8,
}

/// A sealed log, opened: the check's real name, the real commit it ran on, and the log.
#[derive(Clone, PartialEq, Eq)]
pub struct CheckLog {
    /// The check's real name (`ci / build`).
    pub name: String,
    /// The real commit (hex).
    pub head: String,
    /// The log's bytes (empty for a run that has not finished).
    pub log: Vec<u8>,
}

/// It holds a members-only check name, commit and log: `Debug` shows the log's length only.
impl std::fmt::Debug for CheckLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CheckLog")
            .field("log_bytes", &self.log.len())
            .finish_non_exhaustive()
    }
}

impl CheckKeys {
    /// The keys of the commit whose blind uses `salt`.
    #[must_use]
    pub fn new(salt: &Salt) -> Self {
        Self {
            salt: Zeroizing::new(*salt),
            name_key: Zeroizing::new(hmac(salt, &[NAME_LABEL])),
        }
    }

    /// `K_name`, for the conformance vectors only.
    #[cfg(any(test, feature = "vectors"))]
    #[must_use]
    pub fn name_key_for_vectors(&self) -> [u8; 32] {
        *self.name_key
    }

    /// The opaque name of check `name` on this commit.
    #[must_use]
    pub fn opaque_name(&self, name: &str) -> String {
        let mac = hmac(&*self.name_key, &[&[NAME_DOMAIN], name.as_bytes()]);
        base32(&mac[..10])
    }

    fn log_key(&self, nonce: &[u8; 12]) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(hmac(&*self.name_key, &[&[LOG_DOMAIN], nonce]))
    }

    fn ad(blind: &[u8], opaque: &str) -> Vec<u8> {
        let mut ad = Vec::with_capacity(6 + blind.len() + opaque.len());
        ad.extend_from_slice(MAGIC);
        ad.push(VERSION);
        // a blind is 20 or 32 bytes ([`blind::is_oid_width`]), so it fits a byte
        ad.push(u8::try_from(blind.len()).unwrap_or(u8::MAX));
        ad.extend_from_slice(blind);
        ad.extend_from_slice(opaque.as_bytes());
        ad
    }

    /// Seal `log` of check `name`, run on the real commit `head` reported as `blind`, under a
    /// fresh nonce.
    pub fn seal_log(
        &self,
        blind: &[u8],
        name: &str,
        head: &[u8],
        log: &[u8],
    ) -> Result<Vec<u8>, PrivateError> {
        let mut nonce = [0u8; 12];
        getrandom::getrandom(&mut nonce).map_err(|_| PrivateError::Rng)?;
        self.seal_log_with_nonce(blind, name, head, log, &nonce)
    }

    /// [`Self::seal_log`] under a given nonce (the vectors; a writer never reuses one).
    pub(crate) fn seal_log_with_nonce(
        &self,
        blind: &[u8],
        name: &str,
        head: &[u8],
        log: &[u8],
        nonce: &[u8; 12],
    ) -> Result<Vec<u8>, PrivateError> {
        if !blind::is_oid_width(blind.len()) || blind.len() != head.len() {
            return Err(PrivateError::Malformed);
        }
        if blind::blind(&self.salt, head).as_deref() != Some(blind) {
            return Err(PrivateError::Malformed);
        }
        let header = serde_json::to_vec(&Header {
            head: hex::encode(head),
            name: name.to_string(),
            v: 1,
        })
        .map_err(|_| PrivateError::Malformed)?;
        let hlen = u32::try_from(header.len()).map_err(|_| PrivateError::Malformed)?;
        let mut p = Zeroizing::new(Vec::with_capacity(12 + header.len() + log.len() + PAD));
        p.extend_from_slice(&hlen.to_be_bytes());
        p.extend_from_slice(&header);
        p.extend_from_slice(&(log.len() as u64).to_be_bytes());
        p.extend_from_slice(log);
        let padded = p.len().div_ceil(PAD) * PAD;
        p.resize(padded, 0);
        let opaque = self.opaque_name(name);
        let ad = Self::ad(blind, &opaque);
        let ct = Aes256Gcm::new((&*self.log_key(nonce)).into())
            .encrypt(Nonce::from_slice(nonce), Payload { msg: &p, aad: &ad })
            .map_err(|_| PrivateError::Malformed)?;
        let mut out = Vec::with_capacity(OVERHEAD + ct.len());
        out.extend_from_slice(MAGIC);
        out.push(VERSION);
        out.extend_from_slice(nonce);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    /// Open the sealed log of the run named `opaque` on `blind`. Refused as malformed when it does
    /// not open, its padding is not zeros, or its header names a check that does not hash to
    /// `opaque` or a commit whose blind is not `blind`; a later format is [`PrivateError::UnknownVersion`].
    pub fn open_log(
        &self,
        blind: &[u8],
        opaque: &str,
        sealed: &[u8],
    ) -> Result<CheckLog, PrivateError> {
        if sealed.len() < OVERHEAD || &sealed[..4] != MAGIC {
            return Err(PrivateError::Malformed);
        }
        if sealed[4] != VERSION {
            return Err(PrivateError::UnknownVersion(sealed[4]));
        }
        let nonce: [u8; 12] = sealed[5..17].try_into().expect("12 bytes");
        let ad = Self::ad(blind, opaque);
        let p = Zeroizing::new(
            Aes256Gcm::new((&*self.log_key(&nonce)).into())
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &sealed[17..],
                        aad: &ad,
                    },
                )
                .map_err(|_| PrivateError::Malformed)?,
        );
        let (raw, log) = split_plaintext(&p).ok_or(PrivateError::Malformed)?;
        let header: Header = serde_json::from_slice(raw).map_err(|_| PrivateError::Malformed)?;
        let head = hex::decode(&header.head).map_err(|_| PrivateError::Malformed)?;
        let blinded = blind::blind(&self.salt, &head);
        // the one canonical form: no other spacing, order, escape, number form or hex case
        let canonical = serde_json::to_vec(&header).map_err(|_| PrivateError::Malformed)?;
        if header.v != 1
            || canonical != raw
            || header.head != hex::encode(&head)
            || blinded.as_deref().is_none_or(|b| !ct_eq(b, blind))
            || !ct_eq(self.opaque_name(&header.name).as_bytes(), opaque.as_bytes())
        {
            return Err(PrivateError::Malformed);
        }
        Ok(CheckLog {
            name: header.name,
            head: header.head,
            log: log.to_vec(),
        })
    }
}

/// `P`'s header and log, when its lengths fit, it is a whole number of [`PAD`] blocks and the
/// rest is zeros.
fn split_plaintext(p: &[u8]) -> Option<(&[u8], &[u8])> {
    if p.is_empty() || p.len() % PAD != 0 {
        return None;
    }
    let hlen = usize::try_from(u32::from_be_bytes(p.get(..4)?.try_into().ok()?)).ok()?;
    let at = hlen.checked_add(4)?;
    let header = p.get(4..at)?;
    let start = at.checked_add(8)?;
    let llen = usize::try_from(u64::from_be_bytes(p.get(at..start)?.try_into().ok()?)).ok()?;
    let end = start.checked_add(llen)?;
    let log = p.get(start..end)?;
    let rest = p.get(end..)?;
    (rest.len() < PAD && rest.iter().all(|&b| b == 0)).then_some((header, log))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn salt(c: u8) -> Salt {
        [c; 32]
    }

    #[test]
    fn base32_is_rfc4648_lower_case() {
        // RFC 4648 §10, lower case, no padding
        for (raw, enc) in [
            ("", ""),
            ("f", "my"),
            ("fo", "mzxq"),
            ("foo", "mzxw6"),
            ("foob", "mzxw6yq"),
            ("fooba", "mzxw6ytb"),
            ("foobar", "mzxw6ytboi"),
        ] {
            assert_eq!(base32(raw.as_bytes()), enc);
        }
    }

    #[test]
    fn opaque_names_are_per_salt_and_name() {
        let a = CheckKeys::new(&salt(1));
        let b = CheckKeys::new(&salt(2));
        let n = a.opaque_name("ci / build");
        assert!(is_opaque_name(&n), "{n}");
        assert_ne!(n, a.opaque_name("ci / test"));
        assert_ne!(n, b.opaque_name("ci / build"));
        assert_eq!(n, CheckKeys::new(&salt(1)).opaque_name("ci / build"));
        assert!(!is_opaque_name("ci / build"));
    }

    #[test]
    fn a_sealed_log_opens_only_on_its_own_run() {
        let k = CheckKeys::new(&salt(3));
        let head = [0x42u8; 20];
        let blind = blind::blind(&salt(3), &head).unwrap();
        let sealed = k.seal_log(&blind, "ci / build", &head, b"ok\n").unwrap();
        assert_eq!(sealed.len(), OVERHEAD + PAD);
        let opaque = k.opaque_name("ci / build");
        let log = k.open_log(&blind, &opaque, &sealed).unwrap();
        assert_eq!(
            (log.name.as_str(), log.log.as_slice()),
            ("ci / build", &b"ok\n"[..])
        );
        assert_eq!(log.head, hex::encode(head));
        // another run's name, another blind, another salt, a flipped byte
        assert!(k
            .open_log(&blind, &k.opaque_name("ci / test"), &sealed)
            .is_err());
        let other = blind::blind(&salt(3), &[0x43; 20]).unwrap();
        assert!(k.open_log(&other, &opaque, &sealed).is_err());
        assert!(CheckKeys::new(&salt(4))
            .open_log(&blind, &opaque, &sealed)
            .is_err());
        let mut bad = sealed.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(k.open_log(&blind, &opaque, &bad).is_err());
        bad = sealed;
        bad[4] = 2;
        assert_eq!(
            k.open_log(&blind, &opaque, &bad),
            Err(PrivateError::UnknownVersion(2))
        );
        // a head whose blind is not the one given is never sealed
        assert!(k.seal_log(&other, "ci / build", &head, b"").is_err());
        assert_eq!(format!("{k:?}"), "CheckKeys(<redacted>)");
    }

    /// `members_check__*` (`tools/private-repos-vectors/members_checks.py`) byte for byte.
    #[test]
    fn conformance_vectors() {
        use serde_json::{json, Value};
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../forge-contracts/vectors");
        let mut files: Vec<_> = std::fs::read_dir(&dir)
            .expect("read vectors dir")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(&format!("{CASE}__")) && n.ends_with(".json"))
            })
            .collect();
        files.sort();
        assert!(files.len() >= 24, "expected 24+ vectors, found {}", files.len());
        let hex32 = |v: &Value| -> [u8; 32] { hex::decode(v.as_str().unwrap()).unwrap().try_into().unwrap() };
        let bytes = |v: &Value| hex::decode(v.as_str().unwrap()).unwrap();
        for path in files {
            let v: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let (name, input, expected) = (&v["name"], &v["input"], &v["expected"]);
            let keys = CheckKeys::new(&hex32(&input["salt"]));
            let got = match input["op"].as_str().unwrap() {
                "name" => json!({
                    "nameKey": hex::encode(keys.name_key_for_vectors()),
                    "opaque": keys.opaque_name(input["name"].as_str().unwrap()),
                }),
                "seal" => {
                    let nonce: [u8; 12] = bytes(&input["nonce"]).try_into().unwrap();
                    let name = input["name"].as_str().unwrap();
                    let sealed = keys
                        .seal_log_with_nonce(
                            &bytes(&input["blind"]),
                            name,
                            &bytes(&input["head"]),
                            &bytes(&input["log"]),
                            &nonce,
                        )
                        .unwrap();
                    json!({
                        "opaque": keys.opaque_name(name),
                        "sealed": hex::encode(&sealed),
                        "sha256": hex::encode(super::super::keys::sha256(&sealed)),
                    })
                }
                "open" => match keys.open_log(
                    &bytes(&input["blind"]),
                    input["opaque"].as_str().unwrap(),
                    &bytes(&input["sealed"]),
                ) {
                    Ok(l) => json!({ "name": l.name, "head": l.head, "log": hex::encode(&l.log) }),
                    Err(PrivateError::UnknownVersion(n)) => {
                        json!({ "error": "unknownVersion", "version": n })
                    }
                    Err(_) => json!({ "error": "malformed" }),
                },
                op => panic!("{name}: unknown op {op}"),
            };
            assert_eq!(&got, expected, "{name}");
        }
    }
}
