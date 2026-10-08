//! Who a letter goes to (mixed-visibility DESIGN §4.2, D2, D26): the recipients of an issue,
//! comment or review sealed to specific people (`enc` v0x04), fixed when it is posted.
//!
//! A preset resolves to its group's current people: *Maintainers* is the owner and the
//! maintainers, *Writers and maintainers* adds the role-1 writers (never triage members or
//! readers). A reply re-lists the letters it answers: a Specific-people parent's list, or a group
//! parent's group as it is now plus that parent's writer, so someone who joined the group since
//! reads from the reply on. A reply may name more people, never fewer. The writer is always slot
//! 0; the rest are in ascending id order. Vectors `role_group_letter__*`
//! (`tools/private-repos-vectors/letters.py`).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::v2::Role;
pub use crate::private::tlv::LetterGroup;

/// At most this many recipients, the writer included (the slots sit in one 5,120-byte field).
pub const MAX_RECIPIENTS: usize = crate::private::named::MAX_RECIPIENTS;

/// A member of the repository, as the member documents say now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LetterMember {
    /// Base58 identity id.
    pub identity: String,
    /// Its role.
    pub role: Role,
}

/// What the writer asked for: a preset, people named one by one, or both.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LetterRequest {
    /// A role-group preset.
    #[serde(default)]
    pub group: Option<LetterGroup>,
    /// People named one by one (base58).
    #[serde(default)]
    pub people: Vec<String>,
}

/// A letter a new one replies under (the target, the comment replied to, the thread's root),
/// as its writer listed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParentLetter {
    /// Its recipients in slot order (base58; slot 0 is its writer).
    pub recipients: Vec<String>,
    /// The group it was sent to, if any.
    #[serde(default)]
    pub group: Option<LetterGroup>,
}

/// Everything [`plan`] needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LetterInput {
    /// The repository's owner (base58): in every group.
    pub owner: String,
    /// The writer (base58): always slot 0.
    pub sender: String,
    /// The member documents now.
    pub members: Vec<LetterMember>,
    /// Identities with no usable encryption key.
    pub keyless: Vec<String>,
    /// What the writer asked for (`None`: re-list the parents).
    #[serde(default)]
    pub request: Option<LetterRequest>,
    /// The picker's exact list, instead of a request: it must hold every parent's recipients.
    #[serde(default)]
    pub exact: Option<Vec<String>>,
    /// The letters it replies under.
    pub parents: Vec<ParentLetter>,
    /// Whether it is written under a members-only parent (every recipient must be a member).
    pub members_only_parent: bool,
}

/// Who a letter goes to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LetterPlan {
    /// The recipients in slot order: the writer, then the rest by id.
    pub recipients: Vec<String>,
    /// People it would have gone to who have no usable encryption key, left out.
    pub skipped: Vec<String>,
    /// The group the TLV names (tag 29): only when everyone else is in it.
    pub group: Option<LetterGroup>,
}

/// Why a letter is refused before signing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "error", deny_unknown_fields)]
pub enum LetterRefusal {
    /// No preset, no people and no parent letter.
    NoRecipients,
    /// The picker's list leaves out people an earlier message in the thread went to.
    Narrower {
        /// Who it leaves out.
        people: Vec<String>,
    },
    /// People named one by one have no usable encryption key.
    NoEncryptionKey {
        /// Who.
        people: Vec<String>,
    },
    /// Under a members-only parent, people who are not members.
    NotMembers {
        /// Who.
        people: Vec<String>,
    },
    /// More than [`MAX_RECIPIENTS`], the writer included.
    TooMany {
        /// How many it would go to.
        count: usize,
    },
}

/// The people `group` is now: the owner, and every member whose role is in it.
#[must_use]
pub fn group_now(group: LetterGroup, owner: &str, members: &[LetterMember]) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = members
        .iter()
        .filter(|m| in_group(group, m.role))
        .map(|m| m.identity.clone())
        .collect();
    out.insert(owner.to_owned());
    out
}

/// Whether a member with `role` is in `group`.
#[must_use]
pub fn in_group(group: LetterGroup, role: Role) -> bool {
    match group {
        LetterGroup::Maintainers => role == Role::Maintainer,
        LetterGroup::Writers => matches!(role, Role::Maintainer | Role::Writer),
    }
}

/// What a reply re-lists of `p` when it asks for nothing: its list, or its group now and its
/// writer.
fn inherited(p: &ParentLetter, owner: &str, members: &[LetterMember]) -> BTreeSet<String> {
    match p.group {
        Some(g) => {
            let mut out = group_now(g, owner, members);
            out.extend(p.recipients.first().cloned());
            out
        }
        None => p.recipients.iter().cloned().collect(),
    }
}

/// Who a reply must still go to under `p`: its list, less the people a group parent listed who
/// have left the group (its writer always stays).
fn required(p: &ParentLetter, owner: &str, members: &[LetterMember]) -> BTreeSet<String> {
    let Some(g) = p.group else {
        return p.recipients.iter().cloned().collect();
    };
    let now = group_now(g, owner, members);
    p.recipients
        .iter()
        .enumerate()
        .filter(|(i, r)| *i == 0 || now.contains(*r))
        .map(|(_, r)| r.clone())
        .collect()
}

fn sorted(s: impl IntoIterator<Item = String>) -> Vec<String> {
    s.into_iter().collect::<BTreeSet<_>>().into_iter().collect()
}

/// Everyone a letter would go to before anyone without a key is left out (the writer
/// included), and the people named one by one; or the refusals that come before keys are known
/// (no recipients, a narrower list). What a writer fetches keys for before [`plan`].
fn wanted(i: &LetterInput) -> Result<(BTreeSet<String>, BTreeSet<String>), LetterRefusal> {
    let (owner, members) = (i.owner.as_str(), &i.members[..]);
    let mut want: BTreeSet<String> = BTreeSet::from([i.sender.clone()]);
    let mut named: BTreeSet<String> = BTreeSet::new();
    if let Some(exact) = &i.exact {
        want.extend(exact.iter().cloned());
        let missing: BTreeSet<String> = i
            .parents
            .iter()
            .flat_map(|p| required(p, owner, members))
            .filter(|r| !want.contains(r))
            .collect();
        if !missing.is_empty() {
            return Err(LetterRefusal::Narrower {
                people: sorted(missing),
            });
        }
    } else {
        if i.request.is_none() && i.parents.is_empty() {
            return Err(LetterRefusal::NoRecipients);
        }
        for p in &i.parents {
            want.extend(inherited(p, owner, members));
        }
        if let Some(r) = &i.request {
            named.extend(r.people.iter().cloned());
            if let Some(g) = r.group {
                want.extend(group_now(g, owner, members));
            }
        }
        want.extend(named.iter().cloned());
    }
    Ok((want, named))
}

/// The identities a letter could go to, the writer included: whose encryption keys a writer
/// reads before calling [`plan`] (with the ones that have none as `keyless`).
pub fn candidates(i: &LetterInput) -> Result<BTreeSet<String>, LetterRefusal> {
    wanted(i).map(|(want, _)| want)
}

/// Who a letter goes to, or why it is refused (the module docs; checked in this order: a
/// narrower list, people named with no key, non-members under a members-only parent, too many).
pub fn plan(i: &LetterInput) -> Result<LetterPlan, LetterRefusal> {
    let (owner, sender, members) = (i.owner.as_str(), &i.sender, &i.members[..]);
    let keyless: BTreeSet<&String> = i.keyless.iter().collect();
    let (want, named) = wanted(i)?;
    let no_key = sorted(
        named
            .iter()
            .filter(|p| *p != sender && keyless.contains(p))
            .cloned(),
    );
    if !no_key.is_empty() {
        return Err(LetterRefusal::NoEncryptionKey { people: no_key });
    }
    if i.members_only_parent {
        let outside = sorted(
            want.iter()
                .filter(|p| *p != owner && !members.iter().any(|m| &m.identity == *p))
                .cloned(),
        );
        if !outside.is_empty() {
            return Err(LetterRefusal::NotMembers { people: outside });
        }
    }
    let skipped = sorted(
        want.iter()
            .filter(|p| *p != sender && keyless.contains(p))
            .cloned(),
    );
    let recipients: Vec<String> = std::iter::once(sender.clone())
        .chain(
            want.iter()
                .filter(|p| *p != sender && !keyless.contains(p))
                .cloned(),
        )
        .collect();
    if recipients.len() > MAX_RECIPIENTS {
        return Err(LetterRefusal::TooMany {
            count: recipients.len(),
        });
    }
    let candidate = if i.exact.is_some() {
        None
    } else if let Some(r) = &i.request {
        r.group.filter(|_| r.people.is_empty())
    } else {
        let groups: BTreeSet<Option<LetterGroup>> = i.parents.iter().map(|p| p.group).collect();
        match groups.into_iter().collect::<Vec<_>>()[..] {
            [only] => only,
            _ => None,
        }
    };
    let group = candidate.filter(|g| {
        let now = group_now(*g, owner, members);
        recipients.iter().all(|r| r == sender || now.contains(r))
    });
    Ok(LetterPlan {
        recipients,
        skipped,
        group,
    })
}

/// "1 person" / "3 people".
#[must_use]
pub fn people(n: usize) -> String {
    if n == 1 {
        "1 person".to_owned()
    } else {
        format!("{n} people")
    }
}

impl LetterGroup {
    /// The preset's name (DESIGN §10): "Maintainers", "Writers and maintainers".
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            LetterGroup::Maintainers => "Maintainers",
            LetterGroup::Writers => "Writers and maintainers",
        }
    }

    /// How a recipient list names it: "maintainers when sent".
    #[must_use]
    pub fn when_sent(self) -> &'static str {
        match self {
            LetterGroup::Maintainers => "maintainers when sent",
            LetterGroup::Writers => "writers and maintainers when sent",
        }
    }
}
