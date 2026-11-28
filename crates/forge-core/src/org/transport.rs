//! An organization's log on Platform (organizations design §10): `orgMember` proofs and sealed
//! shares, `orgMessage` parts, and how a reader turns members' documents back into `dti/1`
//! envelopes. No network here; `session` does the reads and writes.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write as _;

use blstrs_plus::Scalar;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::XChaCha20Poly1305;
use ed25519_dalek::{Signature, Signer as _, Verifier as _, VerifyingKey};
use hkdf::Hkdf;
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::canon::canonical;
use super::ceremony::{Config, KeySlot, Participant, SlotKeys};
use super::derive::{MemberKeys, Seed};
use super::envelope;
use super::state::{Ceremony, CeremonyResult};
use super::OrgError;

pub const DOC_MEMBER: &str = "orgMember";
pub const DOC_ORG: &str = "org";
pub const DOC_MESSAGE: &str = "orgMessage";
pub const DOC_SHARE: &str = "orgShare";

/// The most bytes one `orgMessage` carries.
pub const MAX_PART: usize = 5120;
/// The most documents one message is split into.
pub const MAX_PARTS: usize = 16;
/// The most bytes a message inflates to.
pub const MAX_PAYLOAD: usize = 266_240;
/// The most Forge identities one member key binds (earliest first).
pub const MAX_IDENTITIES_PER_KEY: usize = 4;

/// The envelope types an `orgMessage` carries; others are ignored.
pub const MESSAGE_TYPES: [&str; 4] = ["proposal", "approve", "reject", "broadcast"];

/// What an `orgMember` proof signs: binds the Forge identity `owner` to the member key.
pub fn proof_message(network: &str, org: &str, owner: &str) -> String {
    format!("dash-forge/org-member/1\n{network}\n{org}\n{owner}")
}

pub fn member_proof(keys: &MemberKeys, network: &str, org: &str, owner: &str) -> [u8; 64] {
    keys.auth()
        .sign(proof_message(network, org, owner).as_bytes())
        .to_bytes()
}

pub fn verify_proof(auth_pub: &[u8], network: &str, org: &str, owner: &str, proof: &[u8]) -> bool {
    let (Ok(key), Ok(sig)) = (
        <[u8; 32]>::try_from(auth_pub)
            .map_err(|_| ())
            .and_then(|k| VerifyingKey::from_bytes(&k).map_err(|_| ())),
        Signature::from_slice(proof),
    ) else {
        return false;
    };
    key.verify(proof_message(network, org, owner).as_bytes(), &sig)
        .is_ok()
}

fn share_key(seed: &Seed, network: &str, org: &str, cid: &str) -> Zeroizing<[u8; 32]> {
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(b"dash-forge/org-share/1"), seed.bytes())
        .expand(format!("{network}\n{org}\n{cid}").as_bytes(), key.as_mut())
        .expect("32 bytes is a valid HKDF length");
    key
}

/// The member's signing-slot share, sealed so only their phrase opens it: nonce ‖ ciphertext ‖
/// tag.
pub fn seal_share(
    seed: &Seed,
    network: &str,
    org: &str,
    cid: &str,
    share: &Scalar,
    nonce: [u8; 24],
) -> Vec<u8> {
    let key = share_key(seed, network, org, cid);
    let plain = Zeroizing::new(share.to_be_bytes());
    let sealed = XChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(&key[..]))
        .encrypt(&nonce.into(), plain.as_slice())
        .expect("encrypting 32 bytes cannot fail");
    [nonce.as_slice(), &sealed].concat()
}

/// [`seal_share`] with a random nonce.
pub fn seal_share_random(
    seed: &Seed,
    network: &str,
    org: &str,
    cid: &str,
    share: &Scalar,
) -> Vec<u8> {
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).expect("OS random source");
    seal_share(seed, network, org, cid, share, nonce)
}

pub fn open_share(
    seed: &Seed,
    network: &str,
    org: &str,
    cid: &str,
    sealed: &[u8],
) -> Option<Scalar> {
    if sealed.len() < 24 + 16 {
        return None;
    }
    let (nonce, rest) = sealed.split_at(24);
    let key = share_key(seed, network, org, cid);
    let plain = Zeroizing::new(
        XChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(&key[..]))
            .decrypt(nonce.into(), rest)
            .ok()?,
    );
    let bytes: [u8; 32] = plain.as_slice().try_into().ok()?;
    Option::from(Scalar::from_be_bytes(&bytes))
}

/// One message as stored: deflated when that is shorter (`fmt` 1), in parts of at most
/// [`MAX_PART`] bytes sharing the payload's SHA-256.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Encoded {
    pub fmt: u8,
    pub digest: [u8; 32],
    pub parts: Vec<Vec<u8>>,
}

pub fn encode(envelope: &Value) -> Result<Encoded, OrgError> {
    let raw = canonical(envelope)?.into_bytes();
    let mut z = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    z.write_all(&raw).expect("writing to a Vec");
    let deflated = z.finish().expect("writing to a Vec");
    let (fmt, payload) = if deflated.len() < raw.len() {
        (1, deflated)
    } else {
        (0, raw)
    };
    encode_payload(fmt, &payload)
}

fn encode_payload(fmt: u8, payload: &[u8]) -> Result<Encoded, OrgError> {
    let parts: Vec<Vec<u8>> = payload.chunks(MAX_PART).map(<[u8]>::to_vec).collect();
    if parts.len() > MAX_PARTS {
        return Err(OrgError::Malformed(format!(
            "this message is too big for Platform ({} bytes after compression; at most {})",
            payload.len(),
            MAX_PART * MAX_PARTS
        )));
    }
    Ok(Encoded {
        fmt,
        digest: Sha256::digest(payload).into(),
        parts,
    })
}

/// The payload's envelope: inflated when `fmt` is 1, and canonical JSON exactly.
pub fn decode(fmt: u64, payload: &[u8]) -> Option<Value> {
    let raw = match fmt {
        0 => payload.to_vec(),
        1 => inflate_whole(payload)?,
        _ => return None,
    };
    if raw.len() > MAX_PAYLOAD {
        return None;
    }
    let text = std::str::from_utf8(&raw).ok()?;
    let value: Value = serde_json::from_str(text).ok()?;
    (canonical(&value).ok()? == text).then_some(value)
}

/// One deflate-raw stream that ends exactly at the end of `payload` (nothing after it, not
/// truncated), inflating to at most one byte over [`MAX_PAYLOAD`].
fn inflate_whole(payload: &[u8]) -> Option<Vec<u8>> {
    let mut z = flate2::Decompress::new(false);
    let mut out = Vec::with_capacity(MAX_PAYLOAD + 1);
    let status = z
        .decompress_vec(payload, &mut out, flate2::FlushDecompress::Finish)
        .ok()?;
    (status == flate2::Status::StreamEnd && z.total_in() == payload.len() as u64).then_some(out)
}

/// An `orgMessage` document as read.
#[derive(Debug, Clone)]
pub struct MessageDoc {
    pub id: String,
    pub owner: String,
    pub created_at: u64,
    pub digest: Vec<u8>,
    pub part: u64,
    pub parts: u64,
    pub fmt: u64,
    pub body: Vec<u8>,
}

/// One whole message: who carried it, the envelope, and when its last part landed.
#[derive(Debug, Clone)]
pub struct Carried {
    pub owner: String,
    pub envelope: Value,
    pub created_at: u64,
}

/// Messages whose every part, from the same owner, is present and matches the digest. For a
/// part repeated with other bytes, the earliest document counts.
pub fn reassemble(docs: &[MessageDoc]) -> Vec<Carried> {
    let mut groups: BTreeMap<(&str, &[u8]), Vec<&MessageDoc>> = BTreeMap::new();
    for d in docs {
        groups
            .entry((d.owner.as_str(), d.digest.as_slice()))
            .or_default()
            .push(d);
    }
    let mut out = Vec::new();
    for ((owner, digest), mut ds) in groups {
        ds.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        let mut chosen: BTreeMap<u64, &MessageDoc> = BTreeMap::new();
        for d in ds {
            chosen.entry(d.part).or_insert(d);
        }
        let Some(first) = chosen.get(&0) else {
            continue;
        };
        let (parts, fmt) = (first.parts, first.fmt);
        let whole = (1..=MAX_PARTS as u64).contains(&parts)
            && chosen.len() as u64 == parts
            && chosen
                .iter()
                .enumerate()
                .all(|(i, (p, d))| *p == i as u64 && d.parts == parts && d.fmt == fmt);
        if !whole {
            continue;
        }
        let payload: Vec<u8> = chosen
            .values()
            .flat_map(|d| d.body.iter().copied())
            .collect();
        if Sha256::digest(&payload).as_slice() != digest {
            continue;
        }
        if let Some(envelope) = decode(fmt, &payload) {
            out.push(Carried {
                owner: owner.to_string(),
                envelope,
                created_at: chosen.values().map(|d| d.created_at).max().unwrap_or(0),
            });
        }
    }
    out
}

/// An `orgMember` document as read.
#[derive(Debug, Clone)]
pub struct MemberDoc {
    pub id: String,
    pub owner: String,
    pub created_at: u64,
    pub org: String,
    pub auth_pub: Vec<u8>,
    pub proof: Vec<u8>,
}

/// An `orgShare` document as read: one member identity's sealed share of one ceremony.
#[derive(Debug, Clone)]
pub struct ShareDoc {
    pub owner: String,
    pub org: String,
    pub cid: String,
    pub sealed: Vec<u8>,
}

/// Member key (hex) → the Forge identities it binds, earliest first, at most
/// [`MAX_IDENTITIES_PER_KEY`]: documents for `org` whose key is one of `members` and whose
/// proof verifies for their owner.
pub fn bind_identities<'a>(
    docs: &'a [MemberDoc],
    network: &str,
    org: &str,
    members: &BTreeSet<String>,
) -> BTreeMap<String, Vec<&'a MemberDoc>> {
    let mut sorted: Vec<&MemberDoc> = docs.iter().collect();
    sorted.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let mut out: BTreeMap<String, Vec<&MemberDoc>> = BTreeMap::new();
    for d in sorted {
        let key = hex::encode(&d.auth_pub);
        if d.org != org
            || !members.contains(&key)
            || !verify_proof(&d.auth_pub, network, org, &d.owner, &d.proof)
        {
            continue;
        }
        let list = out.entry(key).or_default();
        if list.len() < MAX_IDENTITIES_PER_KEY && !list.iter().any(|x| x.owner == d.owner) {
            list.push(d);
        }
    }
    out
}

/// A Platform envelope for `reduce`, ordered at `at` (its earliest document's time).
#[derive(Debug, Clone)]
pub struct Timed {
    pub id: String,
    pub envelope: Value,
    pub at: String,
}

/// The organization's log: envelopes carried by an identity bound to their author, of the
/// types a log holds, deduplicated by envelope id at their earliest time, ordered by (time,
/// id).
pub fn merge(carried: &[Carried], owner_keys: &BTreeMap<String, BTreeSet<String>>) -> Vec<Timed> {
    let mut best: BTreeMap<String, (u64, &Value)> = BTreeMap::new();
    for c in carried {
        let from = c.envelope["from"].as_str();
        let kind = c.envelope["type"].as_str().unwrap_or_default();
        let bound = from.is_some_and(|f| owner_keys.get(&c.owner).is_some_and(|ks| ks.contains(f)));
        if !bound || !MESSAGE_TYPES.contains(&kind) {
            continue;
        }
        let Ok(id) = envelope::id(&c.envelope) else {
            continue;
        };
        let slot = best.entry(id).or_insert((c.created_at, &c.envelope));
        if c.created_at < slot.0 {
            *slot = (c.created_at, &c.envelope);
        }
    }
    let mut out: Vec<Timed> = best
        .into_iter()
        .map(|(id, (t, e))| Timed {
            id,
            envelope: e.clone(),
            at: iso_ms(t),
        })
        .collect();
    out.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Milliseconds since the epoch as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn iso_ms(ms: u64) -> String {
    super::envelope::iso_from_ms(u128::from(ms))
}

/// The organization's published roster (an `org` document).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Roster {
    pub room: String,
    pub relay: Option<String>,
    pub cid: String,
    pub key_id: u32,
    pub group_key: String,
    pub threshold: usize,
    /// Participants' auth keys (hex), by participant index from 1.
    pub members: Vec<String>,
    /// Their public shares of the group key (hex), same order.
    pub pub_shares: Vec<String>,
}

/// The slot name a roster's key takes in `reduce` (the default layout's AUTHENTICATION/HIGH).
pub const ROSTER_SLOT: &str = "high";

impl Roster {
    /// The roster a completed ceremony gives for its signing slot.
    pub fn of_ceremony(c: &Ceremony, relay: Option<&str>) -> Option<Self> {
        let (slot, keys) = super::signing_slot(c)?;
        let mut ps: Vec<&Participant> = c.config.participants.iter().collect();
        ps.sort_by_key(|p| p.index);
        let pub_shares = ps
            .iter()
            .map(|p| keys.public_shares.get(&p.index).cloned())
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            room: c.config.room.clone(),
            relay: relay.map(str::to_string),
            cid: c.cid.clone(),
            key_id: slot.key_id,
            group_key: keys.group_public_key.clone(),
            threshold: c.config.threshold,
            members: ps.iter().map(|p| p.auth_pub.clone()).collect(),
            pub_shares,
        })
    }

    /// Whether it describes exactly the same signing key as `other` (the relay aside).
    pub fn same_key(&self, other: &Self) -> bool {
        self.room == other.room
            && self.cid == other.cid
            && self.key_id == other.key_id
            && self.group_key == other.group_key
            && self.threshold == other.threshold
            && self.members == other.members
            && self.pub_shares == other.pub_shares
    }

    /// A completed ceremony standing in for the transcript: enough for `reduce` to check
    /// shares and thresholds, and for review to name the key. Its participants are unnamed.
    pub fn ceremony(&self, network: &str, label: &str) -> Ceremony {
        let participants: Vec<Participant> = self
            .members
            .iter()
            .enumerate()
            .map(|(i, auth)| Participant {
                index: u32::try_from(i + 1).unwrap_or(u32::MAX),
                name: format!("member {}", i + 1),
                auth_pub: auth.clone(),
                transport_pub: String::new(),
            })
            .collect();
        let slot = KeySlot {
            slot: ROSTER_SLOT.to_string(),
            key_id: self.key_id,
            purpose: "AUTHENTICATION".into(),
            security_level: "HIGH".into(),
        };
        let keys = SlotKeys {
            group_public_key: self.group_key.clone(),
            public_shares: participants
                .iter()
                .zip(&self.pub_shares)
                .map(|(p, s)| (p.index, s.clone()))
                .collect(),
        };
        let config = Config {
            raw: Value::Null,
            room: self.room.clone(),
            network: network.to_string(),
            label: label.to_string(),
            threshold: self.threshold,
            organizer: String::new(),
            participants,
            keys: vec![slot.clone()],
        };
        Ceremony::completed(
            self.cid.clone(),
            config,
            CeremonyResult {
                transcript: String::new(),
                keys: BTreeMap::from([(ROSTER_SLOT.to_string(), (slot, keys))]),
            },
        )
    }

    /// The roster an `org` document's properties describe: `None` when they are not a
    /// well-formed one.
    pub fn from_props(p: &BTreeMap<String, crate::platform::FieldValue>) -> Option<Self> {
        let cid = p.get("cid")?.as_bytes()?;
        let group_key = p.get("groupKey")?.as_bytes()?;
        let members = p.get("members")?.as_bytes()?;
        let pub_shares = p.get("pubShares")?.as_bytes()?;
        let threshold = p.get("threshold")?.as_u64()?;
        let n = members.len() / 32;
        let ok = cid.len() == 32
            && group_key.len() == 48
            && members.len().is_multiple_of(32)
            && (2..=64).contains(&n)
            && pub_shares.len() == n * 48
            && (2..=n as u64).contains(&threshold);
        ok.then(|| Self {
            room: p
                .get("room")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            relay: p.get("relay").and_then(|v| v.as_str()).map(str::to_string),
            cid: hex::encode(&cid),
            key_id: p
                .get("keyId")
                .and_then(crate::platform::FieldValue::as_u64)
                .and_then(|k| u32::try_from(k).ok())
                .unwrap_or(u32::MAX),
            group_key: hex::encode(&group_key),
            threshold: usize::try_from(threshold).unwrap_or(0),
            members: members.chunks(32).map(hex::encode).collect(),
            pub_shares: pub_shares.chunks(48).map(hex::encode).collect(),
        })
    }

    /// The `members` and `pubShares` byte arrays of the `org` document.
    pub fn members_bytes(&self) -> Vec<u8> {
        concat_hex(&self.members)
    }

    pub fn pub_shares_bytes(&self) -> Vec<u8> {
        concat_hex(&self.pub_shares)
    }
}

fn concat_hex(list: &[String]) -> Vec<u8> {
    list.iter()
        .flat_map(|h| hex::decode(h).unwrap_or_default())
        .collect()
}
