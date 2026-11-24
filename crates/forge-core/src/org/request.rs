//! Forge requests: the proposals that share a Forge note's `group`, in `seq` order
//! (organizations design §9). A proposal without a Forge note is a request of its own.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::canon::{int_of, js_len};
use super::envelope::is_hex;
use super::state::{Proposal, ProposalStatus, RoomState};

pub const MAX_TITLE: usize = 120;

/// A parsed Forge note: `{"forge":1,"group":"<16 hex>","seq":i,"of":k,"title":"…"}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub group: String,
    pub seq: usize,
    pub of: usize,
    pub title: String,
}

impl Note {
    pub fn parse(text: &str) -> Option<Self> {
        let v: Value = serde_json::from_str(text).ok()?;
        if int_of(&v["forge"]) != Some(1) {
            return None;
        }
        let group = v["group"].as_str().filter(|g| is_hex(g, Some(8)))?;
        let seq = usize::try_from(int_of(&v["seq"])?).ok()?;
        let of = usize::try_from(int_of(&v["of"])?)
            .ok()
            .filter(|n| *n >= 1)?;
        let title = v["title"].as_str().filter(|t| js_len(t) <= MAX_TITLE)?;
        (seq < of).then(|| Self {
            group: group.to_string(),
            seq,
            of,
            title: title.to_string(),
        })
    }

    pub fn to_json(&self) -> String {
        serde_json::json!({
            "forge": 1,
            "group": self.group,
            "seq": self.seq,
            "of": self.of,
            "title": self.title,
        })
        .to_string()
    }
}

/// A new request group id: 16 random hex digits.
pub fn new_group_id() -> String {
    let mut b = [0u8; 8];
    getrandom::getrandom(&mut b).expect("OS random source");
    hex::encode(b)
}

/// Truncate a title to what a note carries.
pub fn fit_title(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if js_len(&out) + c.len_utf16() > MAX_TITLE {
            break;
        }
        out.push(c);
    }
    out
}

#[derive(Debug, Clone)]
pub struct Request {
    pub id: String,
    pub title: String,
    /// Made by Forge (a Forge note), or a lone proposal made elsewhere.
    pub forge: bool,
    /// Proposal ids in `seq` order.
    pub proposals: Vec<String>,
    pub proposer: String,
    pub at: String,
    /// Why the request's proposals do not form a whole request.
    pub problem: Option<String>,
}

/// Every request of the ceremony `cid` in the room, oldest first. A request is one proposer's
/// proposals sharing a group, so nobody else can break a member's request by reusing its group.
/// The plain group id goes to the earliest proposal by one of `members` (the ceremony's
/// participants) that the room accepted and that asks for `cid`'s key alone; any other
/// proposer's request gets `<group>-<first 16 hex of its key>`. Web groups the same way.
pub fn requests(state: &RoomState, cid: &str, members: &BTreeSet<String>) -> Vec<Request> {
    let mut groups: BTreeMap<(String, String), Vec<(Note, &Proposal)>> = BTreeMap::new();
    let mut first: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut out = Vec::new();
    for p in state.proposals.values() {
        let asks = p.posted_requirements();
        if !asks.iter().any(|(c, _)| c == cid) {
            continue;
        }
        match p.note().and_then(Note::parse) {
            Some(note) => {
                let may_claim = p.status != ProposalStatus::Invalid
                    && members.contains(&p.from)
                    && asks.len() == 1;
                if may_claim {
                    let seen = (p.at.clone(), p.from.clone());
                    first
                        .entry(note.group.clone())
                        .and_modify(|e| *e = e.clone().min(seen.clone()))
                        .or_insert(seen);
                }
                groups
                    .entry((note.group.clone(), p.from.clone()))
                    .or_default()
                    .push((note, p));
            }
            None => out.push(Request {
                id: p.id.clone(),
                title: String::new(),
                forge: false,
                proposals: vec![p.id.clone()],
                proposer: p.from.clone(),
                at: p.at.clone(),
                problem: None,
            }),
        }
    }
    for ((group, from), mut members) in groups {
        let id = if first.get(&group).is_some_and(|(_, f)| *f == from) {
            group
        } else {
            format!("{group}-{}", from.get(..16).unwrap_or(&from))
        };
        members.sort_by(|a, b| a.0.seq.cmp(&b.0.seq).then_with(|| a.1.id.cmp(&b.1.id)));
        let of = members[0].0.of;
        let proposer = members[0].1.from.clone();
        let whole = members.len() == of
            && members
                .iter()
                .enumerate()
                .all(|(i, (n, p))| n.seq == i && n.of == of && p.from == proposer);
        out.push(Request {
            id,
            title: members[0].0.title.clone(),
            forge: true,
            proposals: members.iter().map(|(_, p)| p.id.clone()).collect(),
            proposer,
            at: members
                .iter()
                .map(|(_, p)| p.at.clone())
                .min()
                .unwrap_or_default(),
            problem: (!whole)
                .then(|| "its parts are missing, repeated, or from different members".to_string()),
        });
    }
    out.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Find a request by its id or an unambiguous prefix of it.
pub fn find<'a>(requests: &'a [Request], id: &str) -> Option<&'a Request> {
    if let Some(r) = requests.iter().find(|r| r.id == id) {
        return Some(r);
    }
    let mut hits = requests
        .iter()
        .filter(|r| id.len() >= 4 && r.id.starts_with(id));
    let first = hits.next()?;
    hits.next().is_none().then_some(first)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestStatus {
    Collecting,
    Ready,
    Done,
    Expired,
    Invalid,
}

impl RequestStatus {
    pub fn is_open(self) -> bool {
        matches!(self, Self::Collecting | Self::Ready)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Collecting => "collecting",
            Self::Ready => "ready",
            Self::Done => "done",
            Self::Expired => "expired",
            Self::Invalid => "invalid",
        }
    }
}

/// What Platform says about a request's proposals: those whose write is visible, and those whose
/// nonce is at or below the identity's current one.
#[derive(Debug, Clone, Default)]
pub struct ChainView {
    pub landed: BTreeSet<String>,
    pub spent: BTreeSet<String>,
    /// Reported executed, but the nonce is still free: it has not landed.
    pub unproven: BTreeSet<String>,
}

/// The request's status (§9 "Request status"). Without a chain view, `done` comes from
/// broadcasts only and `expired` is never reported.
pub fn status(state: &RoomState, req: &Request, chain: Option<&ChainView>) -> RequestStatus {
    if req.problem.is_some() {
        return RequestStatus::Invalid;
    }
    let ps: Vec<&Proposal> = req
        .proposals
        .iter()
        .filter_map(|id| state.proposals.get(id))
        .collect();
    if ps.len() != req.proposals.len() || ps.iter().any(|p| p.status == ProposalStatus::Invalid) {
        return RequestStatus::Invalid;
    }
    let landed = |p: &Proposal| {
        (p.status == ProposalStatus::Executed && !chain.is_some_and(|c| c.unproven.contains(&p.id)))
            || chain.is_some_and(|c| c.landed.contains(&p.id))
    };
    if ps.iter().all(|p| landed(p)) {
        return RequestStatus::Done;
    }
    if ps
        .iter()
        .any(|p| !landed(p) && chain.is_some_and(|c| c.spent.contains(&p.id)))
    {
        return RequestStatus::Expired;
    }
    if ps
        .iter()
        .all(|p| matches!(p.status, ProposalStatus::Ready | ProposalStatus::Executed))
    {
        RequestStatus::Ready
    } else {
        RequestStatus::Collecting
    }
}

/// `(collected, threshold)`: the fewest valid shares any proposal has, against the threshold.
pub fn collected(state: &RoomState, req: &Request) -> (usize, usize) {
    let mut have = usize::MAX;
    let mut need = 0;
    for p in req
        .proposals
        .iter()
        .filter_map(|id| state.proposals.get(id))
    {
        for r in &p.requirements {
            have = have.min(r.shares.len());
            need = need.max(r.threshold.unwrap_or(0));
        }
    }
    (if have == usize::MAX { 0 } else { have }, need)
}

/// Whether the member `auth_pub` has approved every proposal of the request.
pub fn approved_by(state: &RoomState, req: &Request, auth_pub: &str) -> bool {
    req.proposals.iter().all(|id| {
        state
            .proposals
            .get(id)
            .is_some_and(|p| p.approvals.contains_key(auth_pub))
    })
}

/// Whether the member `auth_pub` declined any proposal of the request.
pub fn declined_by(state: &RoomState, req: &Request, auth_pub: &str) -> bool {
    req.proposals.iter().any(|id| {
        state
            .proposals
            .get(id)
            .is_some_and(|p| p.rejections.contains_key(auth_pub))
    })
}

/// Whether the request waits for this member's signature: still collecting, a member of every
/// ceremony it needs, and neither signed nor declined by them.
pub fn waits_for(state: &RoomState, req: &Request, auth_pub: &str) -> bool {
    status(state, req, None) == RequestStatus::Collecting
        && !approved_by(state, req, auth_pub)
        && !declined_by(state, req, auth_pub)
        && req.proposals.iter().all(|id| {
            state.proposals.get(id).is_some_and(|p| {
                p.requirements.iter().all(|r| {
                    state
                        .ceremonies
                        .get(&r.cid)
                        .is_some_and(|c| c.config.index_of(auth_pub).is_some())
                })
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: &str = "0123456789abcdef";

    fn state(parts: &[(&str, &str, usize, usize)]) -> RoomState {
        let mut st = RoomState::default();
        for (i, (from, group, seq, of)) in parts.iter().enumerate() {
            let note = Note {
                group: (*group).into(),
                seq: *seq,
                of: *of,
                title: "t".into(),
            }
            .to_json();
            let id = format!("p{i}");
            st.proposals
                .insert(id.clone(), Proposal::bare(&id, from, &note));
        }
        st
    }

    fn members() -> BTreeSet<String> {
        ["a", "zz", "bbbbbbbbbb"]
            .iter()
            .map(|m| (*m).to_string())
            .collect()
    }

    fn problem(parts: &[(&str, &str, usize, usize)]) -> bool {
        let reqs = requests(&state(parts), "c", &members());
        assert_eq!(reqs.len(), 1);
        assert_eq!(
            status(&state(parts), &reqs[0], None) == RequestStatus::Invalid,
            reqs[0].problem.is_some()
        );
        reqs[0].problem.is_some()
    }

    #[test]
    fn a_whole_request_is_one_member_with_seqs_zero_to_of() {
        assert!(!problem(&[("a", G, 0, 2), ("a", G, 1, 2)]));
        assert!(problem(&[("a", G, 0, 2)]));
        assert!(problem(&[("a", G, 0, 2), ("a", G, 0, 2)]));
        assert!(problem(&[("a", G, 0, 3), ("a", G, 1, 3), ("a", G, 1, 3)]));
        assert!(problem(&[("a", G, 0, 2), ("a", G, 1, 3)]));
    }

    #[test]
    fn someone_reusing_a_group_does_not_break_the_request() {
        let st = state(&[("a", G, 0, 1), ("bbbbbbbbbb", G, 0, 1)]);
        let reqs = requests(&st, "c", &members());
        assert_eq!(reqs.len(), 2);
        let mine = reqs.iter().find(|r| r.proposer == "a").unwrap();
        assert_eq!(mine.id, G);
        assert!(mine.problem.is_none());
        let theirs = reqs.iter().find(|r| r.proposer != "a").unwrap();
        assert_eq!(theirs.id, format!("{G}-bbbbbbbbbb"));

        let mut st = state(&[("zz", G, 0, 1), ("bbbbbbbbbb", G, 0, 1)]);
        let outsider = st.proposals.get_mut("p1").unwrap();
        outsider.at = "2000-01-01T00:00:00.000Z".into();
        outsider.status = ProposalStatus::Invalid;
        let reqs = requests(&st, "c", &members());
        assert_eq!(reqs.iter().find(|r| r.proposer == "zz").unwrap().id, G);

        // Accepted by the room through a ceremony of its own, but not a member and asking for
        // a second key: it can't take the id either.
        let mut st = state(&[("zz", G, 0, 1), ("outsider", G, 0, 1)]);
        let outsider = st.proposals.get_mut("p1").unwrap();
        outsider.at = "2000-01-01T00:00:00.000Z".into();
        outsider.body["requirements"] = serde_json::json!([
            { "cid": "c", "slot": "high" },
            { "cid": "e", "slot": "high" }
        ]);
        let reqs = requests(&st, "c", &members());
        assert_eq!(reqs.iter().find(|r| r.proposer == "zz").unwrap().id, G);
        assert_eq!(
            reqs.iter().find(|r| r.proposer == "outsider").unwrap().id,
            format!("{G}-outsider")
        );
    }

    #[test]
    fn a_note_out_of_range_is_not_a_forge_note() {
        assert!(
            Note::parse(r#"{"forge":1,"group":"0123456789abcdef","seq":2,"of":2,"title":""}"#)
                .is_none()
        );
        assert!(
            Note::parse(r#"{"forge":1,"group":"0123456789ABCDEF","seq":0,"of":1,"title":""}"#)
                .is_none()
        );
        assert!(
            Note::parse(r#"{"forge":2,"group":"0123456789abcdef","seq":0,"of":1,"title":""}"#)
                .is_none()
        );
    }
}
