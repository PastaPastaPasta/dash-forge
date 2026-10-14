//! Publication dates for coordinated fixes: member `event` kind 28 (`embargo`, forge-v2.md
//! §3.5; mixed-visibility DESIGN §4.7 "Embargo", D18), a client convention inside the
//! contract's open `event.kind` (4–255), like the policy bypass (23) and CI re-runs (26). No
//! schema change.
//!
//! A maintainer or writer sets the date on the members-only issue (or pull request) that tracks
//! a fix. The event's `value` is the plan, sealed under the members key like every value on a
//! members-only target, so the public learns that a publication date was set on the thread, by
//! whom and when, never the date or what is published:
//!
//! * `targetId` / `targetNumber`: the tracking issue, or the pull request when there is none;
//! * `refId`: **the repository's own id**, as a re-run request's (§3.3): a release bot reads the
//!   repository's dates with one query on the sparse `addressee (refId, $createdAt)` index;
//! * `value`: one canonical JSON object ([`EmbargoValue`]), at most 120 characters (the event
//!   value's bound): a schedule `{"v":1,"at":…,"pr":…,"b":…,"o":…,"t":…,"m":…}`, a cancellation
//!   `{"v":1,"cancel":true}` or a completion `{"v":1,"done":"<commit>"}`. A value that is not
//!   exactly its own canonical form (key order, spacing, duplicate keys, unknown keys or another
//!   `v`) is no record, so both stacks read the same bytes the same way.
//!
//! A **schedule** counts only when its writer is the repository owner, or a maintainer or role-1
//! writer at its `$createdAt`; consensus admits triage's too on the live contracts. A
//! cancellation or completion always counts: consensus admitted its writer as a member, and it
//! only stops a publication, so a later removal of its writer never brings a date back
//! ([`record_counts`]). Per target, the newest counted schedule is the embargo, and a newer
//! cancellation or completion ends it ([`embargo_of`]).
//!
//! The release bot (D18) is a member identity, not a runner: at the date it makes the tracking
//! issue public, publishes the branch (a squash made then, never one prepared earlier), tags and
//! releases, in that order, and then writes the completion ([`checklist`]).

use serde::{Deserialize, Serialize};

use super::v2::RoleOracle;

/// The `event.kind` of a publication date.
pub const EMBARGO_KIND: u64 = 28;

/// The value's bounds: characters, then UTF-8 bytes (`event.value`).
pub const VALUE_MAX: (usize, usize) = (120, 480);

/// The only value format.
const VERSION: u64 = 1;

/// What is published at the date.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbargoPlan {
    /// The date: Unix seconds (UTC).
    pub at: u64,
    /// A members-only pull request whose branch is published onto its base and recorded merged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<u32>,
    /// Or a members-only branch (its short name) …
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// … published onto this public branch (short name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub onto: Option<String>,
    /// A tag made on the published commit, then released.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// The published commit's message (default: the branch's commit subjects).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// One kind-28 value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum EmbargoValue {
    /// Publish at a date.
    Schedule(EmbargoPlan),
    /// The date is withdrawn: nothing is published.
    Cancel,
    /// Published, as `commit` (lowercase hex).
    Done {
        /// The public commit.
        commit: String,
    },
}

/// The value's wire form: short keys, in this order.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    v: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pr: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    b: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    o: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    t: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    m: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cancel: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    done: Option<String>,
}

/// Whether `name` is a branch's short name a plan may carry (`refs/heads/<name>` is a legal ref).
fn is_branch_name(name: &str) -> bool {
    !name.starts_with("refs/") && super::is_legal_ref_name(&format!("refs/heads/{name}"))
}

/// Whether `name` is a tag a plan may carry (`refs/tags/<name>` is a legal ref).
fn is_tag_name(name: &str) -> bool {
    !name.starts_with("refs/") && super::is_legal_ref_name(&format!("refs/tags/{name}"))
}

/// Whether `hex` is a commit id: 40 or 64 lowercase hex digits.
fn is_commit(hex: &str) -> bool {
    matches!(hex.len(), 40 | 64) && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The latest date a plan may carry: 2^53 − 1 seconds, so every stack reads it as an exact number.
pub const AT_MAX: u64 = (1 << 53) - 1;

/// What is wrong with `plan`, or `None`: a date, exactly one of a pull request and a branch, a
/// branch with the public branch it goes onto (and `onto` only with one), legal names, and a
/// message that is one or more lines of text without control characters. A message is blank
/// when it holds only spaces and line feeds (one rule every stack applies the same way).
fn plan_problem(plan: &EmbargoPlan) -> Option<String> {
    if plan.at == 0 {
        return Some("the date is missing".into());
    }
    if plan.at > AT_MAX {
        return Some("the date is out of range".into());
    }
    match (&plan.pr, &plan.branch, &plan.onto) {
        (Some(0), _, _) => return Some("pull request 0 does not exist".into()),
        (Some(_), None, None) => {}
        (None, Some(b), Some(o)) => {
            if !is_branch_name(b) {
                return Some(format!("{b:?} is not a branch name"));
            }
            if !is_branch_name(o) {
                return Some(format!("{o:?} is not a branch name"));
            }
            if b == o {
                return Some("a branch can't be published onto itself".into());
            }
        }
        (Some(_), _, _) => {
            return Some("a pull request is published onto its own base: name no branch".into())
        }
        (None, None, _) => return Some("name a pull request or a branch to publish".into()),
        (None, Some(_), None) => return Some("name the public branch it is published onto".into()),
    }
    if let Some(t) = &plan.tag {
        if !is_tag_name(t) {
            return Some(format!("{t:?} is not a tag name"));
        }
    }
    if let Some(m) = &plan.message {
        if m.chars().all(|c| c == ' ' || c == '\n') {
            return Some("the message is empty".into());
        }
        if m.chars().any(|c| c.is_control() && c != '\n') {
            return Some("the message has control characters".into());
        }
    }
    None
}

impl EmbargoValue {
    /// The value as its wire object.
    fn wire(&self) -> Wire {
        match self {
            Self::Schedule(p) => Wire {
                v: VERSION,
                at: Some(p.at),
                pr: p.pr,
                b: p.branch.clone(),
                o: p.onto.clone(),
                t: p.tag.clone(),
                m: p.message.clone(),
                ..Wire::default()
            },
            Self::Cancel => Wire {
                v: VERSION,
                cancel: Some(true),
                ..Wire::default()
            },
            Self::Done { commit } => Wire {
                v: VERSION,
                done: Some(commit.clone()),
                ..Wire::default()
            },
        }
    }

    /// The value as stored: canonical JSON, at most [`VALUE_MAX`]. `Err` names what is wrong
    /// before anything is signed.
    ///
    /// # Errors
    /// A malformed plan or commit, or a value over the bound (a long branch name or message).
    pub fn encode(&self) -> Result<String, String> {
        match self {
            Self::Schedule(p) => {
                if let Some(why) = plan_problem(p) {
                    return Err(why);
                }
            }
            Self::Done { commit } if !is_commit(commit) => {
                return Err(format!("{commit:?} is not a commit id (lowercase hex)"));
            }
            Self::Cancel | Self::Done { .. } => {}
        }
        let s = serde_json::to_string(&self.wire()).map_err(|e| e.to_string())?;
        if s.chars().count() > VALUE_MAX.0 || s.len() > VALUE_MAX.1 {
            return Err(format!(
                "the plan is {} characters stored and a publication date holds at most {}: use a shorter branch name, tag or message",
                s.chars().count(),
                VALUE_MAX.0
            ));
        }
        Ok(s)
    }

    /// The value `text` stores, or `None` when it is not exactly one value's canonical form.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let w: Wire = serde_json::from_str(text).ok()?;
        if w.v != VERSION {
            return None;
        }
        let no_plan =
            w.pr.is_none() && w.b.is_none() && w.o.is_none() && w.t.is_none() && w.m.is_none();
        let value = match (w.at, w.cancel, w.done) {
            (Some(at), None, None) => Self::Schedule(EmbargoPlan {
                at,
                pr: w.pr,
                branch: w.b,
                onto: w.o,
                tag: w.t,
                message: w.m,
            }),
            (None, Some(true), None) if no_plan => Self::Cancel,
            (None, None, Some(commit)) if no_plan => Self::Done { commit },
            _ => return None,
        };
        (value.encode().ok()? == text).then_some(value)
    }
}

/// An `event` document as the embargo rule reads it (ids as base58).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbargoEvent {
    /// `$id`.
    pub id: String,
    /// `repoId`.
    pub repo_id: String,
    /// `targetId`.
    pub target_id: String,
    /// `targetNumber`.
    pub target_number: u64,
    /// `kind`.
    pub kind: u64,
    /// `refId`, when present.
    #[serde(default)]
    pub ref_id: Option<String>,
    /// `value`, opened (members-only targets seal it), when present.
    #[serde(default)]
    pub value: Option<String>,
    /// `$ownerId`.
    pub actor: String,
    /// `$createdAt` (ms).
    pub created_at: u64,
}

/// A well-formed kind-28 record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbargoRecord {
    /// The event's `$id`.
    pub id: String,
    /// The tracking issue's or pull request's document id.
    pub target_id: String,
    /// Its number.
    pub number: u32,
    /// What it says.
    pub value: EmbargoValue,
    /// Who wrote it.
    pub actor: String,
    /// When (`$createdAt`, ms).
    pub created_at: u64,
}

/// The record `e` makes in the repository `repo_id`, or `None`: another kind, another
/// repository's event (its `repoId`, or a `refId` that is not the repository), no target number,
/// or a value that is missing, unreadable here or not canonical.
#[must_use]
pub fn embargo_record(repo_id: &str, e: &EmbargoEvent) -> Option<EmbargoRecord> {
    if e.kind != EMBARGO_KIND || e.repo_id != repo_id || e.ref_id.as_deref() != Some(repo_id) {
        return None;
    }
    let number = u32::try_from(e.target_number).ok().filter(|n| *n > 0)?;
    let value = EmbargoValue::parse(e.value.as_deref()?)?;
    Some(EmbargoRecord {
        id: e.id.clone(),
        target_id: e.target_id.clone(),
        number,
        value,
        actor: e.actor.clone(),
        created_at: e.created_at,
    })
}

/// Whether `rec` counts. A schedule counts when its writer is the repository `owner`, or held a
/// maintainer or role-1 writer document at its `$createdAt` (`oracle`: the repository's current
/// memberships). A withdrawal or a completion always counts: consensus admitted its writer as a
/// member when it was written, and it only ever stops a publication, so removing its writer
/// later (which deletes their membership document) never brings a withdrawn date back.
#[must_use]
pub fn record_counts(rec: &EmbargoRecord, owner: &str, oracle: &RoleOracle) -> bool {
    !matches!(rec.value, EmbargoValue::Schedule(_))
        || rec.actor == owner
        || oracle.approver_at(&rec.actor, rec.created_at)
}

/// Where an embargo stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum EmbargoState {
    /// Waiting for its date (or past it, not yet published).
    Scheduled,
    /// Withdrawn.
    Cancelled {
        /// Who withdrew it.
        by: String,
        /// When (ms).
        at: u64,
    },
    /// Published.
    Done {
        /// The public commit.
        commit: String,
        /// Who published it.
        by: String,
        /// When the completion was recorded (ms).
        at: u64,
    },
}

/// One target's embargo: its newest counted schedule and what became of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Embargo {
    /// The tracking issue's or pull request's document id.
    pub target_id: String,
    /// Its number.
    pub number: u32,
    /// What is published, and when.
    pub plan: EmbargoPlan,
    /// Who set the date.
    pub set_by: String,
    /// When (ms).
    pub set_at: u64,
    /// The schedule's event id.
    pub id: String,
    /// Where it stands.
    pub state: EmbargoState,
}

impl Embargo {
    /// Whether it is waiting and its date has come (`now`: Unix seconds).
    #[must_use]
    pub fn due(&self, now: u64) -> bool {
        self.state == EmbargoState::Scheduled && now >= self.plan.at
    }
}

/// The embargo of target `target_id` from `records` (any targets, counted ones only, any order):
/// its newest schedule (by `$createdAt`, then id), ended by a newer cancellation or completion.
/// `None` when it has no schedule.
#[must_use]
pub fn embargo_of(target_id: &str, records: &[EmbargoRecord]) -> Option<Embargo> {
    let mut mine: Vec<&EmbargoRecord> = records
        .iter()
        .filter(|r| r.target_id == target_id)
        .collect();
    mine.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let (i, s, plan) = mine
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, r)| match &r.value {
            EmbargoValue::Schedule(plan) => Some((i, *r, plan)),
            _ => None,
        })?;
    let state = mine[i + 1..]
        .iter()
        .find_map(|r| match &r.value {
            EmbargoValue::Cancel => Some(EmbargoState::Cancelled {
                by: r.actor.clone(),
                at: r.created_at,
            }),
            EmbargoValue::Done { commit } => Some(EmbargoState::Done {
                commit: commit.clone(),
                by: r.actor.clone(),
                at: r.created_at,
            }),
            EmbargoValue::Schedule(_) => None,
        })
        .unwrap_or(EmbargoState::Scheduled);
    Some(Embargo {
        target_id: s.target_id.clone(),
        number: s.number,
        plan: plan.clone(),
        set_by: s.actor.clone(),
        set_at: s.created_at,
        id: s.id.clone(),
        state,
    })
}

/// Every target's embargo from `records` (counted ones only), by target number.
#[must_use]
pub fn embargoes(records: &[EmbargoRecord]) -> Vec<Embargo> {
    let mut targets: Vec<&str> = records.iter().map(|r| r.target_id.as_str()).collect();
    targets.sort_unstable();
    targets.dedup();
    let mut out: Vec<Embargo> = targets
        .into_iter()
        .filter_map(|t| embargo_of(t, records))
        .collect();
    out.sort_by(|a, b| (a.number, &a.target_id).cmp(&(b.number, &b.target_id)));
    out
}

/// One step of the release, in the order the release bot takes them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "step")]
pub enum Step {
    /// Make the tracking issue public (its title and description).
    MakePublic {
        /// The issue.
        issue: u32,
    },
    /// Publish the branch, squashed into one new commit.
    Publish,
    /// Tag the published commit.
    Tag {
        /// The tag.
        tag: String,
    },
    /// Release the tag.
    Release {
        /// The tag.
        tag: String,
    },
}

/// What a client knows of the steps' outcomes (`None`: not known; a completion ticks them all).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Facts {
    /// The tracking issue reads public for everyone.
    #[serde(default)]
    pub issue_public: Option<bool>,
    /// The branch is published (the pull request merged, or the base holds its changes).
    #[serde(default)]
    pub published: Option<bool>,
    /// The tag is on Forge.
    #[serde(default)]
    pub tagged: Option<bool>,
    /// The tag has a live release.
    #[serde(default)]
    pub released: Option<bool>,
}

/// One checklist line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    /// The step.
    #[serde(flatten)]
    pub step: Step,
    /// Whether it is done.
    pub done: bool,
}

/// `e`'s checklist, in order: make the tracking issue public (when the target is an issue,
/// `target_is_issue`), publish, then tag and release (when the plan names a tag). A step is done
/// when the embargo is complete or `facts` says so.
#[must_use]
pub fn checklist(e: &Embargo, target_is_issue: bool, facts: &Facts) -> Vec<ChecklistItem> {
    let complete = matches!(e.state, EmbargoState::Done { .. });
    let item = |step: Step, fact: Option<bool>| ChecklistItem {
        step,
        done: complete || fact == Some(true),
    };
    let mut out = Vec::new();
    if target_is_issue {
        out.push(item(
            Step::MakePublic { issue: e.number },
            facts.issue_public,
        ));
    }
    out.push(item(Step::Publish, facts.published));
    if let Some(t) = &e.plan.tag {
        out.push(item(Step::Tag { tag: t.clone() }, facts.tagged));
        out.push(item(Step::Release { tag: t.clone() }, facts.released));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::v2::{Membership, Role};

    fn plan() -> EmbargoPlan {
        EmbargoPlan {
            at: 1_792_000_000,
            pr: None,
            branch: Some("sec/cve-77".into()),
            onto: Some("main".into()),
            tag: Some("v1.2.3".into()),
            message: None,
        }
    }

    fn ev(id: &str, value: &str, at: u64) -> EmbargoEvent {
        EmbargoEvent {
            id: id.into(),
            repo_id: "R".into(),
            target_id: "T".into(),
            target_number: 12,
            kind: EMBARGO_KIND,
            ref_id: Some("R".into()),
            value: Some(value.into()),
            actor: "M".into(),
            created_at: at,
        }
    }

    #[test]
    fn values_round_trip_in_their_canonical_form() {
        let s = EmbargoValue::Schedule(plan()).encode().unwrap();
        assert_eq!(
            s,
            r#"{"v":1,"at":1792000000,"b":"sec/cve-77","o":"main","t":"v1.2.3"}"#
        );
        assert_eq!(
            EmbargoValue::parse(&s),
            Some(EmbargoValue::Schedule(plan()))
        );
        assert_eq!(
            EmbargoValue::Cancel.encode().unwrap(),
            r#"{"v":1,"cancel":true}"#
        );
        let done = EmbargoValue::Done {
            commit: "ab".repeat(20),
        };
        assert_eq!(EmbargoValue::parse(&done.encode().unwrap()), Some(done));
        // not canonical: spacing, order, duplicates, unknown keys, another version
        for bad in [
            r#"{"v":1, "cancel":true}"#,
            r#"{"cancel":true,"v":1}"#,
            r#"{"v":1,"cancel":true,"cancel":true}"#,
            r#"{"v":1,"cancel":true,"x":1}"#,
            r#"{"v":2,"cancel":true}"#,
            r#"{"v":1,"cancel":false}"#,
            r#"{"v":1,"cancel":true,"t":"v1"}"#,
            r#"{"v":1,"at":5}"#,
            r#"{"v":1,"done":"ABABABABABABABABABABABABABABABABABABABAB"}"#,
        ] {
            assert_eq!(EmbargoValue::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn plans_are_checked_before_signing() {
        let with = |f: &dyn Fn(&mut EmbargoPlan)| {
            let mut p = plan();
            f(&mut p);
            EmbargoValue::Schedule(p).encode()
        };
        assert!(with(&|p| p.at = 0).is_err());
        assert!(with(&|p| p.pr = Some(3)).is_err(), "a PR and a branch");
        assert!(with(&|p| {
            p.pr = Some(3);
            p.branch = None;
            p.onto = None;
        })
        .is_ok());
        assert!(with(&|p| p.onto = None).is_err());
        assert!(with(&|p| p.branch = Some("a..b".into())).is_err());
        assert!(with(&|p| p.tag = Some("v1 2".into())).is_err());
        assert!(with(&|p| p.message = Some("x\u{7}".into())).is_err());
        assert!(
            with(&|p| p.message = Some("x".repeat(80))).is_err(),
            "too long"
        );
        assert!(with(&|p| p.onto = Some("sec/cve-77".into())).is_err());
    }

    #[test]
    fn the_newest_counted_schedule_wins_and_a_later_end_closes_it() {
        let s1 = EmbargoValue::Schedule(plan()).encode().unwrap();
        let mut p2 = plan();
        p2.at += 3600;
        let s2 = EmbargoValue::Schedule(p2.clone()).encode().unwrap();
        let cancel = EmbargoValue::Cancel.encode().unwrap();
        let recs: Vec<EmbargoRecord> = [ev("a", &s1, 10), ev("b", &s2, 20)]
            .iter()
            .filter_map(|e| embargo_record("R", e))
            .collect();
        let e = embargo_of("T", &recs).unwrap();
        assert_eq!(e.plan, p2);
        assert_eq!(e.state, EmbargoState::Scheduled);
        assert!(!e.due(p2.at - 1));
        assert!(e.due(p2.at));
        let mut with_cancel = recs.clone();
        with_cancel.push(embargo_record("R", &ev("c", &cancel, 30)).unwrap());
        let e = embargo_of("T", &with_cancel).unwrap();
        assert!(matches!(e.state, EmbargoState::Cancelled { .. }));
        assert!(!e.due(u64::MAX));
        // a cancellation older than the schedule does not end it
        let mut early = recs;
        early.push(embargo_record("R", &ev("c", &cancel, 15)).unwrap());
        assert_eq!(
            embargo_of("T", &early).unwrap().state,
            EmbargoState::Scheduled
        );
        assert!(embargo_of("T", &[]).is_none());
    }

    #[test]
    fn records_belong_to_the_repository() {
        let s = EmbargoValue::Cancel.encode().unwrap();
        assert!(embargo_record("R", &ev("a", &s, 1)).is_some());
        let other = EmbargoEvent {
            repo_id: "B".into(),
            ..ev("a", &s, 1)
        };
        assert!(embargo_record("R", &other).is_none());
        let unaddressed = EmbargoEvent {
            ref_id: None,
            ..ev("a", &s, 1)
        };
        assert!(embargo_record("R", &unaddressed).is_none());
        let hidden = EmbargoEvent {
            value: None,
            ..ev("a", &s, 1)
        };
        assert!(embargo_record("R", &hidden).is_none());
    }

    #[test]
    fn only_the_owner_maintainers_and_role_1_writers_count() {
        let oracle = RoleOracle::new(vec![Membership {
            identity: "T".into(),
            role: Role::Triage,
            created_at: 1,
        }]);
        let s = EmbargoValue::Schedule(plan()).encode().unwrap();
        let mut r = embargo_record("R", &ev("a", &s, 5)).unwrap();
        r.actor = "T".into();
        assert!(!record_counts(&r, "O", &oracle), "a triage member's date");
        r.actor = "O".into();
        assert!(record_counts(&r, "O", &oracle));
        // a withdrawal counts whoever wrote it, a former member too
        let c = EmbargoValue::Cancel.encode().unwrap();
        let mut w = embargo_record("R", &ev("b", &c, 6)).unwrap();
        w.actor = "gone".into();
        assert!(record_counts(&w, "O", &oracle));
    }

    #[test]
    fn the_checklist_follows_the_plan() {
        let s = EmbargoValue::Schedule(plan()).encode().unwrap();
        let recs = vec![embargo_record("R", &ev("a", &s, 1)).unwrap()];
        let e = embargo_of("T", &recs).unwrap();
        let facts = Facts {
            issue_public: Some(true),
            ..Facts::default()
        };
        let c = checklist(&e, true, &facts);
        assert_eq!(c.len(), 4);
        assert!(c[0].done && !c[1].done && !c[2].done && !c[3].done);
        assert_eq!(checklist(&e, false, &facts).len(), 3);
    }
}
