//! A room's state: `dti`'s `reduce`, restricted to what a completed ceremony and its proposals
//! need (hello, config, accept, dkg-commit, dkg-reveal, dkg-complete, proposal, approve, reject,
//! broadcast). The state is a function of the set of envelopes, not of their order.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::Value;

use super::bls;
use super::canon::int_of;
use super::ceremony::{
    ceremony_id, group_keys, is_network, reveal_digest, reveal_shape_ok, slot_name_ok,
    transcript_digest, validate_config, Config, KeySlot, SlotKeys,
};
use super::envelope::{self, is_hex, is_hex_value};

const ORDER: [&str; 11] = [
    "hello",
    "config",
    "accept",
    "dkg-commit",
    "dkg-reveal",
    "dkg-complete",
    "dkg-complaint",
    "proposal",
    "approve",
    "reject",
    "broadcast",
];

#[derive(Debug, Clone)]
pub struct Hello {
    pub name: String,
    pub transport_pub: String,
}

/// A completed ceremony's agreed result.
#[derive(Debug, Clone)]
pub struct CeremonyResult {
    pub transcript: String,
    pub keys: BTreeMap<String, (KeySlot, SlotKeys)>,
}

#[derive(Debug, Clone)]
pub struct Ceremony {
    pub cid: String,
    pub config: Config,
    /// When the config envelope was posted; orders ceremonies (newest first) as web does.
    pub config_at: String,
    accepts: BTreeSet<u32>,
    raw_commits: BTreeMap<u32, Vec<String>>,
    raw_reveals: BTreeMap<u32, Vec<Value>>,
    raw_completes: BTreeMap<u32, Vec<Value>>,
    /// The reveals the agreed completion names, by member index (empty until complete).
    pub reveals: BTreeMap<u32, Value>,
    pub result: Option<CeremonyResult>,
}

impl Ceremony {
    /// A ceremony known complete without its transcript (an organization's published roster).
    pub fn completed(cid: String, config: Config, result: CeremonyResult) -> Self {
        Self {
            cid,
            config,
            config_at: String::new(),
            accepts: BTreeSet::new(),
            raw_commits: BTreeMap::new(),
            raw_reveals: BTreeMap::new(),
            raw_completes: BTreeMap::new(),
            reveals: BTreeMap::new(),
            result: Some(result),
        }
    }

    /// Whether this member's shares can be recomputed from the transcript (a roster has none).
    pub fn has_transcript(&self) -> bool {
        !self.reveals.is_empty()
    }

    pub fn is_complete(&self) -> bool {
        self.result.is_some()
    }

    pub fn slot(&self, slot: &str) -> Option<&(KeySlot, SlotKeys)> {
        self.result.as_ref()?.keys.get(slot)
    }

    /// How far a ceremony that is not complete got.
    pub fn stage(&self) -> &'static str {
        let n = self.config.n();
        if self.result.is_some() {
            "complete"
        } else if self.accepts.len() < n {
            "accepting"
        } else if self.raw_commits.len() < n {
            "committing"
        } else if self.raw_reveals.len() < n {
            "revealing"
        } else if self.raw_completes.len() < n {
            "completing"
        } else {
            "failed"
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProposalStatus {
    Collecting,
    Ready,
    Executed,
    Invalid,
}

impl ProposalStatus {
    /// Enough valid shares (ready, or reported broadcast).
    pub fn is_signed(self) -> bool {
        matches!(self, Self::Ready | Self::Executed)
    }
}

#[derive(Debug, Clone)]
pub struct Approval {
    pub id: String,
    pub at: String,
    pub shares: Value,
}

#[derive(Debug, Clone)]
pub struct Rejection {
    pub at: String,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct Broadcast {
    pub from: String,
    pub at: String,
    pub result: Value,
}

/// One `{cid, slot}` requirement of a proposal and the valid shares it has.
#[derive(Debug, Clone)]
pub struct Requirement {
    pub cid: String,
    pub slot: String,
    pub key: String,
    pub threshold: Option<usize>,
    pub shares: BTreeMap<u32, String>,
    pub invalid_shares: Vec<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Proposal {
    pub id: String,
    pub from: String,
    pub at: String,
    pub body: Value,
    pub approvals: BTreeMap<String, Approval>,
    approval_order: Vec<String>,
    pub rejections: BTreeMap<String, Rejection>,
    pub broadcasts: Vec<Broadcast>,
    pub status: ProposalStatus,
    pub requirements: Vec<Requirement>,
    pub error: Option<String>,
}

impl Proposal {
    #[cfg(test)]
    pub(crate) fn bare(id: &str, from: &str, note: &str) -> Self {
        Self {
            id: id.into(),
            from: from.into(),
            at: String::new(),
            body: serde_json::json!({ "note": note, "requirements": [{ "cid": "c", "slot": "high" }] }),
            approvals: BTreeMap::new(),
            approval_order: Vec::new(),
            rejections: BTreeMap::new(),
            broadcasts: Vec::new(),
            status: ProposalStatus::Collecting,
            requirements: Vec::new(),
            error: None,
        }
    }

    pub fn network(&self) -> &str {
        self.body["network"].as_str().unwrap_or_default()
    }

    /// The decoded transition's action (`create`, `replace`, `delete`, …), empty when it does
    /// not decode.
    pub fn action(&self) -> String {
        self.decoded().map(|d| d.action).unwrap_or_default()
    }

    /// The decoded unsigned transition, when it decodes.
    pub fn decoded(&self) -> Option<crate::platform::org::DecodedWrite> {
        crate::platform::org::decode_unsigned(&hex::decode(self.unsigned_hex()).ok()?).ok()
    }

    pub fn note(&self) -> Option<&str> {
        self.body["note"].as_str()
    }

    pub fn unsigned_hex(&self) -> &str {
        self.body["unsigned"].as_str().unwrap_or_default()
    }

    pub fn signable(&self) -> Vec<u8> {
        hex::decode(self.body["signable"].as_str().unwrap_or_default()).unwrap_or_default()
    }

    /// The `cid/slot` requirements as posted.
    pub fn posted_requirements(&self) -> Vec<(String, String)> {
        self.body["requirements"]
            .as_array()
            .map(|rs| {
                rs.iter()
                    .map(|r| {
                        (
                            r["cid"].as_str().unwrap_or_default().to_string(),
                            r["slot"].as_str().unwrap_or_default().to_string(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Members (auth keys) who approved, in the order their approvals were applied.
    pub fn approvers(&self) -> &[String] {
        &self.approval_order
    }

    /// Whether a member's broadcast reported success.
    pub fn broadcast_ok(&self) -> bool {
        self.status == ProposalStatus::Executed
    }
}

#[derive(Debug, Clone, Default)]
pub struct RoomState {
    pub hellos: BTreeMap<String, Hello>,
    pub ceremonies: BTreeMap<String, Ceremony>,
    pub proposals: BTreeMap<String, Proposal>,
    pub message_count: usize,
}

pub fn requirement_key(cid: &str, slot: &str) -> String {
    format!("{cid}/{slot}")
}

/// `dti`'s `validProposalBody`.
pub fn valid_proposal_body(b: &Value) -> bool {
    let Some(o) = b.as_object() else {
        return false;
    };
    if !o
        .get("network")
        .and_then(Value::as_str)
        .is_some_and(is_network)
    {
        return false;
    }
    if !o
        .get("intent")
        .is_some_and(|i| i.is_object() && i["type"].is_string())
    {
        return false;
    }
    if !o.get("unsigned").is_some_and(|v| is_hex_value(v, None))
        || !o
            .get("signable")
            .and_then(Value::as_str)
            .is_some_and(|s| is_hex(s, None) && !s.is_empty())
    {
        return false;
    }
    let Some(reqs) = o.get("requirements").and_then(Value::as_array) else {
        return false;
    };
    if reqs.is_empty() || reqs.len() > 16 {
        return false;
    }
    let mut keys = HashSet::new();
    for r in reqs {
        let (Some(cid), Some(slot)) = (r["cid"].as_str(), r["slot"].as_str()) else {
            return false;
        };
        if !r.is_object() || !is_hex(cid, Some(32)) || !slot_name_ok(slot) {
            return false;
        }
        keys.insert(requirement_key(cid, slot));
    }
    if keys.len() != reqs.len() {
        return false;
    }
    if o.get("derived").is_some_and(|d| !d.is_object()) {
        return false;
    }
    o.get("note").is_none_or(Value::is_string)
}

struct Message {
    id: String,
    value: Value,
    kind: String,
    from: String,
    at: String,
}

/// Reduce a room's envelopes to its state. Invalid, duplicate and other-room envelopes are
/// ignored.
pub fn reduce(messages: &[Value], room: Option<&str>) -> RoomState {
    reduce_with(messages, &[], room, Vec::new())
}

/// [`reduce`] over the key ceremony's envelopes, `timed` envelopes from Platform (each ordered
/// at its earliest document's time instead of its own `at`), and `known` ceremonies that need no
/// transcript (a published roster).
pub fn reduce_with(
    messages: &[Value],
    timed: &[super::transport::Timed],
    room: Option<&str>,
    known: Vec<Ceremony>,
) -> RoomState {
    let mut seen = HashSet::new();
    let mut list = Vec::new();
    let all = messages
        .iter()
        .map(|m| (m, None))
        .chain(timed.iter().map(|t| (&t.envelope, Some(t.at.as_str()))));
    for (m, at) in all {
        let Ok(id) = envelope::id(m) else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        if !envelope::verify(m) || room.is_some_and(|r| m["room"].as_str() != Some(r)) {
            continue;
        }
        list.push(Message {
            id,
            kind: m["type"].as_str().unwrap_or_default().to_string(),
            from: m["from"].as_str().unwrap_or_default().to_string(),
            at: at
                .or_else(|| m["at"].as_str())
                .unwrap_or_default()
                .to_string(),
            value: m.clone(),
        });
    }
    let rank = |k: &str| ORDER.iter().position(|o| *o == k).unwrap_or(usize::MAX);
    list.sort_by(|a, b| {
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then_with(|| a.at.cmp(&b.at))
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut state = RoomState {
        message_count: seen.len(),
        ..RoomState::default()
    };
    for c in known {
        state.ceremonies.entry(c.cid.clone()).or_insert(c);
    }
    for m in &list {
        apply(&mut state, m);
    }
    for c in state.ceremonies.values_mut() {
        finish_ceremony(c);
    }
    let ceremonies = &state.ceremonies;
    for p in state.proposals.values_mut() {
        finish_proposal(p, ceremonies);
    }
    state
}

#[allow(clippy::too_many_lines)] // one arm per message type, as dti's reduce
fn apply(state: &mut RoomState, m: &Message) {
    let b = &m.value["body"];
    let body_obj = b.is_object();
    let cid = b["cid"].as_str().filter(|_| body_obj);
    let idx = cid
        .and_then(|c| state.ceremonies.get(c))
        .and_then(|c| c.config.index_of(&m.from));
    match m.kind.as_str() {
        "hello" => {
            if let (Some(name), Some(t)) = (b["name"].as_str(), b["transportPub"].as_str()) {
                if is_hex(t, Some(32)) {
                    state.hellos.insert(
                        m.from.clone(),
                        Hello {
                            name: name.chars().take(64).collect(),
                            transport_pub: t.to_string(),
                        },
                    );
                }
            }
        }
        "config" => {
            let Ok(config) = validate_config(&b["config"]) else {
                return;
            };
            if m.from != config.organizer
                || config.room != m.value["room"].as_str().unwrap_or_default()
            {
                return;
            }
            let Ok(cid) = ceremony_id(&config) else {
                return;
            };
            state.ceremonies.entry(cid.clone()).or_insert(Ceremony {
                cid,
                config,
                config_at: m.at.clone(),
                accepts: BTreeSet::new(),
                raw_commits: BTreeMap::new(),
                raw_reveals: BTreeMap::new(),
                raw_completes: BTreeMap::new(),
                reveals: BTreeMap::new(),
                result: None,
            });
        }
        "accept" => {
            if let (Some(i), Some(c)) = (idx, ceremony_mut(state, cid)) {
                c.accepts.insert(i);
            }
        }
        "dkg-commit" => {
            if let (Some(i), Some(c)) = (idx, ceremony_mut(state, cid)) {
                if let Some(d) = b["digest"].as_str().filter(|d| is_hex(d, Some(32))) {
                    c.raw_commits.entry(i).or_default().push(d.to_string());
                }
            }
        }
        "dkg-reveal" => {
            if let (Some(i), Some(c)) = (idx, ceremony_mut(state, cid)) {
                if b["reveal"].is_object() || b["reveal"].is_array() {
                    c.raw_reveals
                        .entry(i)
                        .or_default()
                        .push(b["reveal"].clone());
                }
            }
        }
        "dkg-complete" => {
            if let (Some(i), Some(c)) = (idx, ceremony_mut(state, cid)) {
                if b["transcript"].is_string() && (b["keys"].is_object() || b["keys"].is_array()) {
                    c.raw_completes.entry(i).or_default().push(b.clone());
                }
            }
        }
        "proposal" => {
            if valid_proposal_body(b) {
                state.proposals.insert(
                    m.id.clone(),
                    Proposal {
                        id: m.id.clone(),
                        from: m.from.clone(),
                        at: m.at.clone(),
                        body: b.clone(),
                        approvals: BTreeMap::new(),
                        approval_order: Vec::new(),
                        rejections: BTreeMap::new(),
                        broadcasts: Vec::new(),
                        status: ProposalStatus::Invalid,
                        requirements: Vec::new(),
                        error: None,
                    },
                );
            }
        }
        "approve" => {
            let Some(p) = b["proposalId"]
                .as_str()
                .and_then(|id| state.proposals.get_mut(id))
            else {
                return;
            };
            if !p.approvals.contains_key(&m.from)
                && (b["shares"].is_object() || b["shares"].is_array())
            {
                p.approvals.insert(
                    m.from.clone(),
                    Approval {
                        id: m.id.clone(),
                        at: m.at.clone(),
                        shares: b["shares"].clone(),
                    },
                );
                p.approval_order.push(m.from.clone());
            }
        }
        "reject" => {
            if let Some(p) = b["proposalId"]
                .as_str()
                .and_then(|id| state.proposals.get_mut(id))
            {
                let reason = match &b["reason"] {
                    Value::Null => String::new(),
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                p.rejections.insert(
                    m.from.clone(),
                    Rejection {
                        at: m.at.clone(),
                        reason: reason.chars().take(500).collect(),
                    },
                );
            }
        }
        "broadcast" => {
            if let Some(p) = b["proposalId"]
                .as_str()
                .and_then(|id| state.proposals.get_mut(id))
            {
                if b["result"].is_object() || b["result"].is_array() {
                    p.broadcasts.push(Broadcast {
                        from: m.from.clone(),
                        at: m.at.clone(),
                        result: b["result"].clone(),
                    });
                }
            }
        }
        _ => {}
    }
}

fn ceremony_mut<'a>(state: &'a mut RoomState, cid: Option<&str>) -> Option<&'a mut Ceremony> {
    state.ceremonies.get_mut(cid?)
}

struct ValidReveal {
    reveal: Value,
    digest: String,
}

fn valid_reveals(c: &Ceremony, index: u32) -> Vec<ValidReveal> {
    let commits: BTreeSet<&String> = c.raw_commits.get(&index).into_iter().flatten().collect();
    let mut out: Vec<ValidReveal> = Vec::new();
    for reveal in c.raw_reveals.get(&index).into_iter().flatten() {
        let Ok(d) = reveal_digest(reveal) else {
            continue;
        };
        if !commits.contains(&d) || out.iter().any(|x| x.digest == d) {
            continue;
        }
        if !reveal_shape_ok(&c.config, &c.cid, reveal, index) {
            continue;
        }
        out.push(ValidReveal {
            reveal: reveal.clone(),
            digest: d,
        });
    }
    out
}

fn reveal_list(body: &Value, n: usize) -> Option<Vec<String>> {
    let list = body["reveals"].as_array()?;
    if list.len() != n || !list.iter().all(|d| is_hex_value(d, Some(32))) {
        return None;
    }
    Some(
        list.iter()
            .map(|d| d.as_str().unwrap_or_default().to_string())
            .collect(),
    )
}

fn completion_matches(
    c: &Ceremony,
    body: &Value,
    keys: &BTreeMap<String, SlotKeys>,
    transcript: &str,
) -> bool {
    body["transcript"].as_str() == Some(transcript)
        && c.config.keys.iter().all(|k| {
            let ours = &keys[&k.slot];
            let theirs = &body["keys"][&k.slot];
            theirs["groupPublicKey"].as_str() == Some(ours.group_public_key.as_str())
                && ours
                    .public_shares_digest()
                    .is_ok_and(|d| theirs["publicSharesDigest"].as_str() == Some(d.as_str()))
        })
}

/// Complete when every member posted a completion naming the same reveal digests, and the keys
/// computed from exactly those reveals match each of them (`finishCeremony` / `agreedCompletion`).
fn finish_ceremony(c: &mut Ceremony) {
    let participants: Vec<u32> = c.config.participants.iter().map(|p| p.index).collect();
    let n = participants.len();
    let completes = |i: u32| c.raw_completes.get(&i).map_or(&[][..], Vec::as_slice);
    if !participants.iter().all(|i| !completes(*i).is_empty()) {
        return;
    }
    let per: BTreeMap<u32, Vec<ValidReveal>> = participants
        .iter()
        .map(|i| (*i, valid_reveals(c, *i)))
        .collect();
    let mut candidates: Vec<Vec<String>> = Vec::new();
    for body in completes(participants[0]) {
        if let Some(list) = reveal_list(body, n) {
            if !candidates.contains(&list) {
                candidates.push(list);
            }
        }
    }
    for candidate in candidates {
        if !participants.iter().all(|i| {
            completes(*i)
                .iter()
                .any(|b| reveal_list(b, n).as_ref() == Some(&candidate))
        }) {
            continue;
        }
        let chosen: Option<BTreeMap<u32, Value>> = participants
            .iter()
            .zip(&candidate)
            .map(|(i, d)| {
                per[i]
                    .iter()
                    .find(|r| &r.digest == d)
                    .map(|r| (*i, r.reveal.clone()))
            })
            .collect();
        let Some(chosen) = chosen else {
            continue;
        };
        let Ok(transcript) = transcript_digest(&c.cid, &candidate) else {
            continue;
        };
        let Ok(keys) = group_keys(&c.config, &chosen) else {
            continue;
        };
        let agreed = participants.iter().all(|i| {
            completes(*i).iter().any(|b| {
                reveal_list(b, n).as_ref() == Some(&candidate)
                    && completion_matches(c, b, &keys, &transcript)
            })
        });
        if agreed {
            let slots = c
                .config
                .keys
                .iter()
                .map(|k| (k.slot.clone(), (k.clone(), keys[&k.slot].clone())))
                .collect();
            c.reveals = chosen;
            c.result = Some(CeremonyResult {
                transcript,
                keys: slots,
            });
            return;
        }
    }
}

fn finish_proposal(p: &mut Proposal, ceremonies: &BTreeMap<String, Ceremony>) {
    p.requirements.clear();
    p.status = ProposalStatus::Invalid;
    let reqs = p.posted_requirements();
    let member = |auth: &str| {
        reqs.iter().any(|(cid, _)| {
            ceremonies
                .get(cid)
                .is_some_and(|c| c.config.index_of(auth).is_some())
        })
    };
    if !member(&p.from) {
        p.error = Some("proposer is not a member of any required ceremony".into());
        return;
    }
    let message = p.signable();
    let mut ready = true;
    for (cid, slot) in &reqs {
        let key = requirement_key(cid, slot);
        let c = ceremonies.get(cid);
        let mut entry = Requirement {
            cid: cid.clone(),
            slot: slot.clone(),
            key: key.clone(),
            threshold: c.map(|c| c.config.threshold),
            shares: BTreeMap::new(),
            invalid_shares: Vec::new(),
            error: None,
        };
        match c.and_then(|c| c.slot(slot).map(|s| (c, s))) {
            None => {
                entry.error = Some("ceremony not complete or slot unknown".into());
                ready = false;
            }
            Some((c, (_, keys))) => {
                for auth in &p.approval_order {
                    let Some(i) = c.config.index_of(auth) else {
                        continue;
                    };
                    let s = &p.approvals[auth].shares[&key];
                    if is_falsy(s) {
                        continue;
                    }
                    let share = s["share"].as_str();
                    let valid = int_of(&s["index"]) == Some(i64::from(i))
                        && share.is_some_and(|sh| {
                            bls::verify_hex(sh, &message, &keys.public_shares[&i])
                        });
                    match share {
                        Some(sh) if valid => {
                            entry.shares.insert(i, sh.to_string());
                        }
                        _ => entry.invalid_shares.push(i),
                    }
                }
                if entry.shares.len() < c.config.threshold {
                    ready = false;
                }
            }
        }
        p.requirements.push(entry);
    }
    let member_ok = |want_confirmed: bool| {
        p.broadcasts.iter().any(|x| {
            member(&x.from)
                && x.result["ok"] == Value::Bool(true)
                && (!want_confirmed || x.result["confirmed"] == Value::Bool(true))
        })
    };
    p.status = if ready && (member_ok(true) || member_ok(false)) {
        ProposalStatus::Executed
    } else if ready {
        ProposalStatus::Ready
    } else {
        ProposalStatus::Collecting
    };
}

fn is_falsy(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::String(s) => s.is_empty(),
        Value::Number(n) => n.as_f64() == Some(0.0),
        _ => false,
    }
}
