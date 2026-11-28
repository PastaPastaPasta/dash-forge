//! What a member does in a room: recover their shares, approve (one BLS share signature per
//! requirement they hold), reject, combine and report a broadcast.

use std::collections::BTreeMap;

use blstrs_plus::Scalar;
use serde_json::{json, Map, Value};
use zeroize::Zeroize;

use super::bls;
use super::ceremony::receive_shares;
use super::derive::{MemberKeys, Seed};
use super::envelope::seal;
use super::state::{ProposalStatus, RoomState};
use super::OrgError;

/// A member's secret shares of one ceremony, wiped on drop.
pub struct Shares {
    pub index: u32,
    pub cid: String,
    shares: BTreeMap<String, Scalar>,
}

impl Drop for Shares {
    fn drop(&mut self) {
        for s in self.shares.values_mut() {
            s.zeroize();
        }
    }
}

impl Shares {
    /// One slot's share (a sealed share opened from Platform).
    pub fn single(cid: &str, index: u32, slot: &str, share: Scalar) -> Self {
        Self {
            index,
            cid: cid.to_string(),
            shares: BTreeMap::from([(slot.to_string(), share)]),
        }
    }

    pub fn get(&self, slot: &str) -> Option<&Scalar> {
        self.shares.get(slot)
    }
}

/// Recompute this member's shares of ceremony `cid` from the seed and the ceremony's messages,
/// each checked against the public share the ceremony agreed (`recoverShares`).
pub fn recover_shares(
    seed: &Seed,
    keys: &MemberKeys,
    state: &RoomState,
    cid: &str,
) -> Result<Shares, OrgError> {
    let c = state
        .ceremonies
        .get(cid)
        .ok_or_else(|| OrgError::Malformed(format!("unknown ceremony {cid}")))?;
    let me = c
        .config
        .index_of(&keys.auth_pub)
        .ok_or(OrgError::NotAMember)?;
    if !c.is_complete() {
        return Err(OrgError::Malformed(format!(
            "ceremony {} is {}",
            &cid[..12],
            c.stage()
        )));
    }
    let shares = Shares {
        index: me,
        cid: cid.to_string(),
        shares: receive_shares(seed, keys, &c.config, cid, &c.reveals)?,
    };
    for (slot, share) in &shares.shares {
        let expected = c.slot(slot).map(|(_, k)| k.public_shares[&me].as_str());
        if expected != Some(bls::g1_hex(&bls::g1(share)).as_str()) {
            return Err(OrgError::Share(format!(
                "the recovered {slot} share does not match the group's record (wrong recovery phrase or passphrase?)"
            )));
        }
    }
    Ok(shares)
}

/// An `approve` envelope for `proposal_id`: a share signature for each requirement of the
/// ceremony `shares` belong to.
pub fn approve(
    shares: &Shares,
    keys: &MemberKeys,
    state: &RoomState,
    proposal_id: &str,
    at: &str,
) -> Result<Value, OrgError> {
    let p = state
        .proposals
        .get(proposal_id)
        .ok_or_else(|| OrgError::Malformed(format!("unknown proposal {proposal_id}")))?;
    let c = state
        .ceremonies
        .get(&shares.cid)
        .ok_or_else(|| OrgError::Malformed(format!("unknown ceremony {}", shares.cid)))?;
    let message = p.signable();
    let mut signed = Map::new();
    for (cid, slot) in p.posted_requirements() {
        if cid != shares.cid {
            continue;
        }
        let share = shares
            .get(&slot)
            .ok_or_else(|| OrgError::Malformed(format!("slot {slot} is not in the ceremony")))?;
        signed.insert(
            super::state::requirement_key(&cid, &slot),
            json!({ "index": shares.index, "share": hex::encode(bls::sign_share(share, &message)) }),
        );
    }
    if signed.is_empty() {
        return Err(OrgError::NotAMember);
    }
    seal(
        keys,
        &c.config.room,
        "approve",
        json!({ "proposalId": proposal_id, "shares": signed }),
        at,
    )
}

pub fn reject(
    keys: &MemberKeys,
    room: &str,
    proposal_id: &str,
    reason: &str,
    at: &str,
) -> Result<Value, OrgError> {
    seal(
        keys,
        room,
        "reject",
        json!({ "proposalId": proposal_id, "reason": reason }),
        at,
    )
}

pub fn record_broadcast(
    keys: &MemberKeys,
    room: &str,
    proposal_id: &str,
    result: Value,
    at: &str,
) -> Result<Value, OrgError> {
    seal(
        keys,
        room,
        "broadcast",
        {
            let mut body = json!({ "proposalId": proposal_id });
            body["result"] = result;
            body
        },
        at,
    )
}

/// One requirement's combined signature.
#[derive(Debug, Clone)]
pub struct Combined {
    pub signature: [u8; 96],
    pub signers: Vec<u32>,
    pub group_public_key: String,
}

/// Combine the `threshold` lowest-index valid shares of each requirement and check the result
/// against the group key (`combine`).
pub fn combine(
    state: &RoomState,
    proposal_id: &str,
) -> Result<BTreeMap<String, Combined>, OrgError> {
    let p = state
        .proposals
        .get(proposal_id)
        .ok_or_else(|| OrgError::Malformed(format!("unknown proposal {proposal_id}")))?;
    if !matches!(p.status, ProposalStatus::Ready | ProposalStatus::Executed) {
        return Err(OrgError::NotReady);
    }
    let message = p.signable();
    let mut out = BTreeMap::new();
    for r in &p.requirements {
        let threshold = r.threshold.ok_or(OrgError::NotReady)?;
        let picked: Vec<(u32, Vec<u8>)> = r
            .shares
            .iter()
            .take(threshold)
            .map(|(i, s)| (*i, hex::decode(s).unwrap_or_default()))
            .collect();
        let pairs: Vec<(u64, Vec<u8>)> = picked
            .iter()
            .map(|(i, s)| (u64::from(*i), s.clone()))
            .collect();
        let signature = bls::combine(&pairs).ok_or(OrgError::NotReady)?;
        let group = state.ceremonies[&r.cid]
            .slot(&r.slot)
            .map(|(_, k)| k.group_public_key.clone())
            .ok_or(OrgError::NotReady)?;
        if !bls::verify(&signature, &message, &group) {
            return Err(OrgError::Share(format!(
                "{}: the combined signature does not verify under the group key",
                r.key
            )));
        }
        out.insert(
            r.key.clone(),
            Combined {
                signature,
                signers: picked.iter().map(|(i, _)| *i).collect(),
                group_public_key: group,
            },
        );
    }
    Ok(out)
}
