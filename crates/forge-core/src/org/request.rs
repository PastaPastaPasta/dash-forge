//! Forge requests: the proposals that share a Forge note's `group`, in `seq` order
//! (organizations design §9). A proposal without a Forge note is a request of its own.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::canon::{int_of, js_len};
use super::envelope::is_hex;
use super::state::{Ceremony, Proposal, ProposalStatus, RoomState};

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
/// proposals sharing a group, and its id is `<group>-<first 16 hex of the proposer's key>`, so
/// nobody can claim another member's id (§11.5). Web groups the same way.
pub fn requests(state: &RoomState, cid: &str) -> Vec<Request> {
    let mut groups: BTreeMap<(String, String), Vec<(Note, &Proposal)>> = BTreeMap::new();
    let mut out = Vec::new();
    for p in state.proposals.values() {
        if !p.posted_requirements().iter().any(|(c, _)| c == cid) {
            continue;
        }
        match p.note().and_then(Note::parse) {
            Some(note) => groups
                .entry((note.group.clone(), p.from.clone()))
                .or_default()
                .push((note, p)),
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
        members.sort_by(|a, b| a.0.seq.cmp(&b.0.seq).then_with(|| a.1.id.cmp(&b.1.id)));
        let of = members[0].0.of;
        let whole = members.len() == of
            && members
                .iter()
                .enumerate()
                .all(|(i, (n, _))| n.seq == i && n.of == of);
        out.push(Request {
            id: request_id(&group, &from),
            title: members[0].0.title.clone(),
            forge: true,
            proposals: members.iter().map(|(_, p)| p.id.clone()).collect(),
            proposer: from,
            at: members
                .iter()
                .map(|(_, p)| p.at.clone())
                .min()
                .unwrap_or_default(),
            problem: (!whole).then(|| "its parts are missing or repeated".to_string()),
        });
    }
    out.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)));
    out
}

/// A Forge request's id: its group and the first 16 hex digits of its proposer's key.
pub fn request_id(group: &str, proposer: &str) -> String {
    format!("{group}-{}", proposer.get(..16).unwrap_or(proposer))
}

/// Find a request by its id, by its bare group when exactly one proposer used it, or by an
/// unambiguous prefix (at least 4 characters) of its id.
pub fn find<'a>(requests: &'a [Request], id: &str) -> Option<&'a Request> {
    if let Some(r) = requests.iter().find(|r| r.id == id) {
        return Some(r);
    }
    let prefixed = format!("{id}-");
    let mut by_group = requests
        .iter()
        .filter(|r| r.forge && r.id.starts_with(&prefixed));
    if let Some(r) = by_group.next() {
        return by_group.next().is_none().then_some(r);
    }
    let mut hits = requests
        .iter()
        .filter(|r| id.len() >= 4 && r.id.starts_with(id));
    let first = hits.next()?;
    hits.next().is_none().then_some(first)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestStatus {
    Collecting,
    Ready,
    Done,
    Expired,
    /// Still collecting, but so many members declined that the rest cannot reach the threshold.
    Declined,
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
            Self::Declined => "declined",
            Self::Invalid => "invalid",
        }
    }
}

/// What Platform shows of a part's document (§11.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DocState {
    #[default]
    Absent,
    /// A delete's document still exists.
    Present,
    /// A create's document is at revision 1 with the part's fields; a replace's is at its
    /// revision with them.
    Same,
    /// The same, with other fields.
    Different,
    /// A replace's document is at the revision it replaces: it has not landed yet.
    Base,
    /// The document is past the part's revision (edited since).
    Later,
}

/// What Platform says about one part.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PartFacts {
    pub nonce_spent: bool,
    pub doc: DocState,
    /// Another request's part is known to have landed with this part's nonce.
    pub taken_by_other: bool,
}

/// Per proposal id, what Platform says about it.
pub type ChainView = BTreeMap<String, PartFacts>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PartState {
    Collecting,
    Ready,
    Done,
    /// A create a member reported broadcast whose nonce is spent, but whose document is gone:
    /// done, and deleted since (or never seen).
    Gone,
    Expired,
}

impl PartState {
    pub fn finished(self) -> bool {
        matches!(self, Self::Done | Self::Gone)
    }
}

/// Whether the write is visible on Platform. A document past the part's revision (edited
/// since), and a delete, count only with the nonce spent and a member's `claim` that it
/// broadcast it.
pub fn landed(action: &str, f: &PartFacts, claim: bool) -> bool {
    match action {
        "create" | "replace" => {
            f.doc == DocState::Same || (f.doc == DocState::Later && f.nonce_spent && claim)
        }
        "delete" => f.doc == DocState::Absent && f.nonce_spent && claim,
        _ => false,
    }
}

/// One part's state (§11.6). `claim`: a member reported broadcasting it. Without `facts`
/// (nothing read from Platform), only signatures count.
pub fn part_state(
    action: &str,
    shares_ready: bool,
    claim: bool,
    facts: Option<&PartFacts>,
) -> PartState {
    let signed = if shares_ready {
        PartState::Ready
    } else {
        PartState::Collecting
    };
    let Some(f) = facts else { return signed };
    if f.taken_by_other {
        PartState::Expired
    } else if landed(action, f, claim) {
        PartState::Done
    } else if action == "create" && claim && f.nonce_spent && f.doc == DocState::Absent {
        PartState::Gone
    } else if f.nonce_spent
        || (action == "create" && f.doc != DocState::Absent)
        || (action == "replace" && f.doc != DocState::Base)
        || (action == "delete" && f.doc == DocState::Absent)
    {
        PartState::Expired
    } else {
        signed
    }
}

/// A request's status and the sentence both clients show for it (§11.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub status: RequestStatus,
    pub parts: Vec<PartState>,
    pub problems: Vec<String>,
    pub threshold: usize,
    pub size: usize,
}

impl Summary {
    /// Some part is done but deleted since.
    pub fn gone(&self) -> bool {
        self.status == RequestStatus::Done && self.parts.contains(&PartState::Gone)
    }

    /// The fixed sentence for `invalid`, `declined` and a gone `done`.
    pub fn text(&self) -> Option<String> {
        match self.status {
            RequestStatus::Invalid => Some(refused_text(&self.problems)),
            RequestStatus::Declined => Some(format!(
                "Declined: too many members declined it to reach {} of {}.",
                self.threshold, self.size
            )),
            RequestStatus::Done if self.gone() => Some("Done (no longer on Platform)".into()),
            _ => None,
        }
    }
}

/// "Forge won't sign this: <reasons>."
pub fn refused_text(problems: &[String]) -> String {
    format!(
        "Forge won't sign this: {}.",
        super::one_line(&problems.join("; ")).trim_end_matches('.')
    )
}

/// The request's status from its parts: invalid (any problem) > declined > done > expired >
/// ready > collecting. `declined`: members who declined without approving.
pub fn summarize(
    problems: Vec<String>,
    declined: usize,
    threshold: usize,
    size: usize,
    parts: &[(bool, PartState)],
) -> Summary {
    let each: Vec<PartState> = parts.iter().map(|(_, s)| *s).collect();
    let status = if !problems.is_empty() {
        RequestStatus::Invalid
    } else if !parts.iter().any(|(ready, _)| *ready) && declined > size.saturating_sub(threshold) {
        RequestStatus::Declined
    } else if !each.is_empty() && each.iter().all(|s| s.finished()) {
        RequestStatus::Done
    } else if each.contains(&PartState::Expired) {
        RequestStatus::Expired
    } else if !each.is_empty() && each.iter().all(|s| *s != PartState::Collecting) {
        RequestStatus::Ready
    } else {
        RequestStatus::Collecting
    };
    Summary {
        status,
        parts: each,
        problems,
        threshold,
        size,
    }
}

/// The problems that make `req` not a request Forge can sign, before any review: its parts
/// don't form a whole one, or one isn't a valid proposal of the room.
pub fn structural_problems(state: &RoomState, req: &Request) -> Vec<String> {
    let mut out: Vec<String> = req.problem.iter().cloned().collect();
    let invalid = req.proposals.iter().any(|id| {
        state
            .proposals
            .get(id)
            .is_none_or(|p| p.status == ProposalStatus::Invalid)
    });
    if invalid {
        out.push("one of its parts is not a valid proposal from a member".into());
    }
    out
}

/// The request's status (§9, §11): `review` holds every review problem found (empty when it was
/// not reviewed), `chain` what Platform says (none: signatures only).
pub fn status(
    state: &RoomState,
    req: &Request,
    ceremony: &Ceremony,
    chain: Option<&ChainView>,
    review: &[String],
) -> Summary {
    let mut problems = structural_problems(state, req);
    for p in review {
        if !problems.contains(p) {
            problems.push(p.clone());
        }
    }
    let parts: Vec<(bool, PartState)> = req
        .proposals
        .iter()
        .map(|id| {
            let Some(p) = state.proposals.get(id) else {
                return (false, PartState::Collecting);
            };
            let ready = p.status.is_signed();
            let action = p.action();
            let facts = chain.and_then(|c| c.get(id));
            (
                ready,
                part_state(&action, ready, p.status == ProposalStatus::Executed, facts),
            )
        })
        .collect();
    let c = &ceremony.config;
    summarize(
        problems,
        declined_count(state, req, ceremony),
        c.threshold,
        c.participants.len(),
        &parts,
    )
}

/// How many of `ceremony`'s participants declined `req` without approving any of it.
pub fn declined_count(state: &RoomState, req: &Request, ceremony: &Ceremony) -> usize {
    let ps: Vec<&Proposal> = req
        .proposals
        .iter()
        .filter_map(|id| state.proposals.get(id))
        .collect();
    let approved: BTreeSet<&str> = ps
        .iter()
        .flat_map(|p| p.approvals.keys().map(String::as_str))
        .collect();
    ps.iter()
        .flat_map(|p| p.rejections.keys().map(String::as_str))
        .filter(|k| ceremony.config.index_of(k).is_some() && !approved.contains(k))
        .collect::<BTreeSet<_>>()
        .len()
}

/// Whether no part of `req` has enough signatures and more of `ceremony`'s participants
/// declined it, without approving, than M−N: the rest cannot reach the threshold.
pub fn declined_out(state: &RoomState, req: &Request, ceremony: &Ceremony) -> bool {
    let any_ready = req.proposals.iter().any(|id| {
        state
            .proposals
            .get(id)
            .is_some_and(|p| p.status.is_signed())
    });
    let c = &ceremony.config;
    !any_ready
        && declined_count(state, req, ceremony) > c.participants.len().saturating_sub(c.threshold)
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
    structural_problems(state, req).is_empty()
        && req.proposals.iter().any(|id| {
            state
                .proposals
                .get(id)
                .is_some_and(|p| p.status == ProposalStatus::Collecting)
        })
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

    fn problem(parts: &[(&str, &str, usize, usize)]) -> bool {
        let reqs = requests(&state(parts), "c");
        assert_eq!(reqs.len(), 1);
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
    fn every_id_names_its_proposer_and_a_bare_group_resolves_when_unique() {
        let st = state(&[
            ("aaaaaaaaaaaaaaaaaa", G, 0, 1),
            ("bbbbbbbbbbbbbbbbbb", G, 0, 1),
        ]);
        let reqs = requests(&st, "c");
        let ids: Vec<&str> = reqs.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.contains(&"0123456789abcdef-aaaaaaaaaaaaaaaa"));
        assert!(ids.contains(&"0123456789abcdef-bbbbbbbbbbbbbbbb"));
        assert!(find(&reqs, G).is_none());
        let one = requests(&state(&[("aaaaaaaaaaaaaaaaaa", G, 0, 1)]), "c");
        assert_eq!(
            find(&one, G).unwrap().id,
            "0123456789abcdef-aaaaaaaaaaaaaaaa"
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
