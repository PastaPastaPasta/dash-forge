//! The reading side of a `dti/1` key ceremony: the config, reveal checks, group keys, the
//! transcript and a member's share recovery.

use std::collections::BTreeMap;

use blstrs_plus::group::Group;
use blstrs_plus::{G1Projective, Scalar};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha512};

use super::bls;
use super::canon::{digest, int_of, js_len};
use super::derive::{dkg_coefficients, length_prefixed, MemberKeys, Part, Seed};
use super::envelope::{box_context, is_hex, is_hex_value, open_box, PROTOCOL};
use super::OrgError;

const PURPOSES: [&str; 6] = [
    "AUTHENTICATION",
    "ENCRYPTION",
    "DECRYPTION",
    "TRANSFER",
    "VOTING",
    "OWNER",
];
const SECURITY_LEVELS: [&str; 4] = ["MASTER", "CRITICAL", "HIGH", "MEDIUM"];
const MAX_REVEAL_BYTES: usize = 240 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Participant {
    pub index: u32,
    pub name: String,
    pub auth_pub: String,
    pub transport_pub: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeySlot {
    pub slot: String,
    pub key_id: u32,
    pub purpose: String,
    pub security_level: String,
}

/// A validated ceremony config. `raw` is the config as posted: the ceremony id hashes it.
#[derive(Debug, Clone)]
pub struct Config {
    pub raw: Value,
    pub room: String,
    pub network: String,
    pub label: String,
    pub threshold: usize,
    pub organizer: String,
    pub participants: Vec<Participant>,
    pub keys: Vec<KeySlot>,
}

impl Config {
    pub fn index_of(&self, auth_pub: &str) -> Option<u32> {
        self.participants
            .iter()
            .find(|p| p.auth_pub == auth_pub)
            .map(|p| p.index)
    }

    pub fn n(&self) -> usize {
        self.participants.len()
    }
}

pub fn room_name_ok(room: &str) -> bool {
    (8..=64).contains(&room.len())
        && room
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn slot_name_ok(slot: &str) -> bool {
    let b = slot.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `mainnet`, `testnet`, `local` or `devnet-<name>` (`dti`'s `isNetwork`).
pub fn is_network(id: &str) -> bool {
    if matches!(id, "mainnet" | "testnet" | "local") {
        return true;
    }
    let Some(name) = id.strip_prefix("devnet-") else {
        return false;
    };
    let b = name.as_bytes();
    !matches!(name, "mainnet" | "testnet" | "local" | "regtest" | "devnet")
        && !b.is_empty()
        && b.len() <= 28
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn bad(why: &str) -> OrgError {
    OrgError::Malformed(why.to_string())
}

fn small_int(v: Option<&Value>) -> Option<i64> {
    v.and_then(int_of)
}

/// `dti`'s `validateConfig`.
#[allow(clippy::too_many_lines)] // one check after another, in dti's order
pub fn validate_config(raw: &Value) -> Result<Config, OrgError> {
    let o = raw
        .as_object()
        .ok_or_else(|| bad("config must be an object"))?;
    let text = |k: &str| o.get(k).and_then(Value::as_str);
    if text("protocol") != Some(PROTOCOL) {
        return Err(bad("unsupported protocol"));
    }
    let room = text("room")
        .filter(|r| room_name_ok(r))
        .ok_or_else(|| bad("config must name its room"))?;
    let network = text("network")
        .filter(|n| is_network(n))
        .ok_or_else(|| bad("bad network"))?;
    let label = text("label")
        .filter(|l| !l.is_empty() && js_len(l) <= 120)
        .ok_or_else(|| bad("label must be 1-120 characters"))?;
    let (Some(ps), Some(ks)) = (
        o.get("participants").and_then(Value::as_array),
        o.get("keys").and_then(Value::as_array),
    ) else {
        return Err(bad("participants and keys must be lists"));
    };
    let n = ps.len();
    if !(2..=64).contains(&n) {
        return Err(bad("between 2 and 64 participants"));
    }
    let threshold = small_int(o.get("threshold"))
        .and_then(|t| usize::try_from(t).ok())
        .filter(|t| (2..=n).contains(t))
        .ok_or_else(|| bad("bad threshold"))?;
    let mut participants = Vec::with_capacity(n);
    for (i, p) in ps.iter().enumerate() {
        let index = small_int(p.get("index"));
        if index != i64::try_from(i + 1).ok() {
            return Err(bad("participant indices must be 1..n in order"));
        }
        let (Some(auth), Some(transport)) = (
            p.get("authPub").and_then(Value::as_str),
            p.get("transportPub").and_then(Value::as_str),
        ) else {
            return Err(bad("participant has malformed keys"));
        };
        if !is_hex(auth, Some(32)) || !is_hex(transport, Some(32)) {
            return Err(bad("participant has malformed keys"));
        }
        let name = p
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| js_len(s) <= 64)
            .ok_or_else(|| bad("participant has a bad name"))?;
        participants.push(Participant {
            index: u32::try_from(i + 1).expect("at most 64"),
            name: name.to_string(),
            auth_pub: auth.to_string(),
            transport_pub: transport.to_string(),
        });
    }
    let unique = |f: fn(&Participant) -> &str| {
        let mut v: Vec<&str> = participants.iter().map(f).collect();
        v.sort_unstable();
        v.dedup();
        v.len() == n
    };
    if !unique(|p| &p.auth_pub) || !unique(|p| &p.transport_pub) {
        return Err(bad("participant keys must be unique"));
    }
    let organizer = text("organizer")
        .filter(|o| participants.iter().any(|p| p.auth_pub == *o))
        .ok_or_else(|| bad("organizer must be a participant"))?;
    if ks.is_empty() {
        return Err(bad("at least one key slot"));
    }
    let mut keys = Vec::with_capacity(ks.len());
    for k in ks {
        let slot = k
            .get("slot")
            .and_then(Value::as_str)
            .filter(|s| slot_name_ok(s))
            .ok_or_else(|| bad("bad slot name"))?;
        let key_id = small_int(k.get("keyId"))
            .and_then(|i| u32::try_from(i).ok())
            .filter(|i| *i < 1000)
            .ok_or_else(|| bad("bad keyId"))?;
        let purpose = k.get("purpose").and_then(Value::as_str).unwrap_or_default();
        let level = k
            .get("securityLevel")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !PURPOSES.contains(&purpose) || !SECURITY_LEVELS.contains(&level) {
            return Err(bad("bad purpose/level"));
        }
        keys.push(KeySlot {
            slot: slot.to_string(),
            key_id,
            purpose: purpose.to_string(),
            security_level: level.to_string(),
        });
    }
    let mut slots: Vec<&str> = keys.iter().map(|k| k.slot.as_str()).collect();
    let mut ids: Vec<u32> = keys.iter().map(|k| k.key_id).collect();
    slots.sort_unstable();
    slots.dedup();
    ids.sort_unstable();
    ids.dedup();
    if slots.len() != keys.len() || ids.len() != keys.len() {
        return Err(bad("slot names and keyIds must be unique"));
    }
    let estimate = 400 + keys.len() * (300 + threshold * 100 + (n - 1) * 180);
    if estimate > MAX_REVEAL_BYTES {
        return Err(bad("too many members or key slots"));
    }
    Ok(Config {
        raw: raw.clone(),
        room: room.to_string(),
        network: network.to_string(),
        label: label.to_string(),
        threshold,
        organizer: organizer.to_string(),
        participants,
        keys,
    })
}

pub fn ceremony_id(config: &Config) -> Result<String, OrgError> {
    Ok(digest(&json!({ "ceremony": config.raw }))?)
}

pub fn reveal_digest(reveal: &Value) -> Result<String, OrgError> {
    Ok(digest(&json!({ "reveal": reveal }))?)
}

fn pok_challenge(ctx: &[u8], r: &G1Projective, a: &G1Projective) -> Scalar {
    let r = bls::g1_hex(r);
    let a = bls::g1_hex(a);
    let input = length_prefixed(&[
        Part::Bytes(ctx),
        Part::Bytes(&hex::decode(r).expect("hex")),
        Part::Bytes(&hex::decode(a).expect("hex")),
    ]);
    bls::scalar_from_be_wide(&Sha512::digest(input))
}

/// The Schnorr proof of knowledge of a member's constant coefficient, bound to (cid, slot, i).
pub fn pok_verify(
    commitment: &str,
    r_hex: &str,
    z_hex: &str,
    cid: &str,
    slot: &str,
    index: u32,
) -> bool {
    let (Some(a), Some(r), Some(z)) = (
        bls::g1_from_hex(commitment),
        bls::g1_from_hex(r_hex),
        bls::scalar_from_hex_mod(z_hex),
    ) else {
        return false;
    };
    let ctx = length_prefixed(&[
        Part::Text(&format!("{PROTOCOL}/pok")),
        Part::Text(cid),
        Part::Text(slot),
        Part::Num(index),
    ]);
    let c = pok_challenge(&ctx, &r, &a);
    if bool::from(blstrs_plus::ff::Field::is_zero(&z))
        || bool::from(blstrs_plus::ff::Field::is_zero(&c))
    {
        return false;
    }
    bls::g1(&z) == r + a * c
}

fn same_keys(v: &Value, keys: &[&str]) -> bool {
    let Some(o) = v.as_object() else {
        return false;
    };
    let mut have: Vec<&str> = o.keys().map(String::as_str).collect();
    let mut want = keys.to_vec();
    have.sort_unstable();
    want.sort_unstable();
    have == want
}

/// Whether `reveal` is a well-shaped reveal by member `index` with valid proofs.
pub fn reveal_shape_ok(config: &Config, cid: &str, reveal: &Value, index: u32) -> bool {
    let slots: Vec<&str> = config.keys.iter().map(|k| k.slot.as_str()).collect();
    if !same_keys(reveal, &["cid", "index", "slots"]) || !same_keys(&reveal["slots"], &slots) {
        return false;
    }
    if reveal["cid"].as_str() != Some(cid) || int_of(&reveal["index"]) != Some(i64::from(index)) {
        return false;
    }
    let mut expected: Vec<String> = config
        .participants
        .iter()
        .filter(|p| p.index != index)
        .map(|p| p.index.to_string())
        .collect();
    expected.sort();
    config.keys.iter().all(|k| {
        let s = &reveal["slots"][&k.slot];
        if !same_keys(s, &["commitments", "pok", "boxes"]) || !same_keys(&s["pok"], &["R", "z"]) {
            return false;
        }
        if !is_hex_value(&s["pok"]["z"], Some(32)) || !is_hex_value(&s["pok"]["R"], Some(48)) {
            return false;
        }
        let Some(commitments) = s["commitments"].as_array() else {
            return false;
        };
        let Some(boxes) = s["boxes"].as_object() else {
            return false;
        };
        if !commitments.iter().all(|c| is_hex_value(c, Some(48)))
            || !boxes.values().all(|b| is_hex_value(b, None))
            || commitments.len() != config.threshold
        {
            return false;
        }
        let first = commitments[0].as_str().unwrap_or_default();
        let pok = &s["pok"];
        if !pok_verify(
            first,
            pok["R"].as_str().unwrap_or_default(),
            pok["z"].as_str().unwrap_or_default(),
            cid,
            &k.slot,
            index,
        ) {
            return false;
        }
        let top = commitments[config.threshold - 1]
            .as_str()
            .unwrap_or_default();
        if bls::g1_from_hex(top).is_none_or(|p| bool::from(p.is_identity())) {
            return false;
        }
        let mut have: Vec<String> = boxes.keys().cloned().collect();
        have.sort();
        have == expected
    })
}

/// One slot's agreed keys: the group key and every member's public share.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotKeys {
    pub group_public_key: String,
    pub public_shares: BTreeMap<u32, String>,
}

impl SlotKeys {
    pub fn public_shares_digest(&self) -> Result<String, OrgError> {
        let map: Map<String, Value> = self
            .public_shares
            .iter()
            .map(|(i, pk)| (i.to_string(), Value::String(pk.clone())))
            .collect();
        Ok(digest(&Value::Object(map))?)
    }
}

fn commitments_of(reveal: &Value, slot: &str) -> Option<Vec<G1Projective>> {
    reveal["slots"][slot]["commitments"]
        .as_array()?
        .iter()
        .map(|c| bls::g1_from_hex(c.as_str()?))
        .collect()
}

/// Group keys and public shares from every member's reveal (`groupKeys`).
pub fn group_keys(
    config: &Config,
    reveals: &BTreeMap<u32, Value>,
) -> Result<BTreeMap<String, SlotKeys>, OrgError> {
    let mut out = BTreeMap::new();
    for k in &config.keys {
        let sets = config
            .participants
            .iter()
            .map(|p| {
                reveals
                    .get(&p.index)
                    .and_then(|r| commitments_of(r, &k.slot))
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| bad("missing reveal"))?;
        let group: G1Projective = sets.iter().map(|c| c[0]).sum();
        let mut public_shares = BTreeMap::new();
        for p in &config.participants {
            let share: G1Projective = sets
                .iter()
                .map(|c| bls::eval_commitments(c, u64::from(p.index)))
                .sum();
            public_shares.insert(p.index, bls::g1_hex(&share));
        }
        if bool::from(group.is_identity()) {
            return Err(bad("group public key is the identity point"));
        }
        let top: G1Projective = sets.iter().map(|c| c[config.threshold - 1]).sum();
        if bool::from(top.is_identity()) {
            return Err(bad("joint polynomial has degree below threshold-1"));
        }
        out.insert(
            k.slot.clone(),
            SlotKeys {
                group_public_key: bls::g1_hex(&group),
                public_shares,
            },
        );
    }
    Ok(out)
}

/// `digest({transcript: cid, reveals: [digest of each member's reveal, in index order]})`.
pub fn transcript_digest(cid: &str, digests: &[String]) -> Result<String, OrgError> {
    Ok(digest(&json!({ "transcript": cid, "reveals": digests }))?)
}

/// This member's secret share of every slot: their own polynomial at their index plus each other
/// member's box to them, Feldman-checked (`receiveShares`, failing on any complaint).
pub fn receive_shares(
    seed: &Seed,
    keys: &MemberKeys,
    config: &Config,
    cid: &str,
    reveals: &BTreeMap<u32, Value>,
) -> Result<BTreeMap<String, Scalar>, OrgError> {
    let me = config
        .index_of(&keys.auth_pub)
        .ok_or(OrgError::NotAMember)?;
    let mut shares = BTreeMap::new();
    for k in &config.keys {
        let mut share = bls::eval_poly(
            &dkg_coefficients(seed, cid, &k.slot, config.threshold),
            u64::from(me),
        );
        for p in config.participants.iter().filter(|p| p.index != me) {
            let complaint =
                |reason: &str| OrgError::Share(format!("{}: member {} {reason}", k.slot, p.index));
            let reveal = reveals
                .get(&p.index)
                .ok_or_else(|| complaint("sent no reveal"))?;
            let ctx = box_context(
                cid,
                &k.slot,
                p.index,
                me,
                &p.transport_pub,
                &keys.transport_pub,
            );
            let sealed = reveal["slots"][&k.slot]["boxes"][me.to_string()]
                .as_str()
                .unwrap_or_default();
            let text = open_box(keys, &p.transport_pub, &ctx, sealed)
                .ok_or_else(|| complaint("sent a share box that does not decrypt"))?;
            let value = bls::parse_share(&text)
                .ok_or_else(|| complaint("sent a share that is not a valid scalar"))?;
            let commitments = commitments_of(reveal, &k.slot)
                .ok_or_else(|| complaint("sent malformed commitments"))?;
            if bls::g1(&value) != bls::eval_commitments(&commitments, u64::from(me)) {
                return Err(complaint(
                    "sent a share that does not match its commitments",
                ));
            }
            share += value;
        }
        shares.insert(k.slot.clone(), share);
    }
    Ok(shares)
}
