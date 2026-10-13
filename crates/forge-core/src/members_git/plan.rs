//! Packs by audience (DESIGN D22, §4.3 "Packs"; S4 §2): a push's batch splits into one public
//! pack and one members-only pack per members-only branch, each built by the unchanged
//! [`crate::pack::build_pack`] from the wants and delta bases planned here.
//!
//! * **Public**: `want` = the batch's new public tips, `have` = P (the public tips the pusher
//!   holds) and nothing else. P-only bases are required for correctness, not tidiness: with
//!   members tips among the bases, a pusher repository with a reachability bitmap leaked a
//!   members-only blob into a public pack as a delta base, and omitted a published blob (S4).
//! * **Members-only, per branch**: `want` = that branch's new tip, `have` = P ∪ the batch's new
//!   public tips ∪ that branch's previous tip. Never another members-only branch's tips, so
//!   publishing one branch's pack (or a narrower branch's, 3F) can never expose another's objects.
//!
//! The public pack goes first. A deletion packs nothing; a members-only branch set to a commit
//! the bases already reach needs no pack.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::Audience;

/// One ref update of a push batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchRef {
    /// The destination ref (`refs/heads/sec/fix`).
    pub dst: String,
    /// The new tip (hex); `None` for a delete.
    pub new: Option<String>,
    /// Who the ref is for.
    pub audience: Audience,
}

/// One pack to build: `build_pack(want, have)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackJob {
    /// Tips to pack (hex, sorted).
    pub want: Vec<String>,
    /// Delta bases the receiver already holds (hex, sorted).
    pub have: Vec<String>,
}

/// One members-only branch's pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MembersPackJob {
    /// The branch.
    #[serde(rename = "ref")]
    pub ref_name: String,
    /// Its tip (hex).
    pub want: Vec<String>,
    /// Its bases (hex, sorted).
    pub have: Vec<String>,
}

/// The packs of one push, in upload order: the public pack, then the members-only ones by ref.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackPlan {
    /// The public pack (kind 0), if the batch adds public objects.
    pub public: Option<PackJob>,
    /// One members-only pack (kind 64) per members-only branch that needs one.
    pub members: Vec<MembersPackJob>,
}

/// Plan a push's packs. `public_tips` is P, the public tips the pusher holds (fetched first);
/// `members_tips` maps each members-only branch to its previous tip the pusher holds; `batch` is
/// the push.
#[must_use]
pub fn plan(
    public_tips: &[String],
    members_tips: &BTreeMap<String, String>,
    batch: &[BatchRef],
) -> PackPlan {
    let p: BTreeSet<&str> = public_tips.iter().map(String::as_str).collect();
    let new_of = |audience: Audience| {
        batch
            .iter()
            .filter(move |u| u.audience == audience)
            .filter_map(|u| u.new.as_deref().map(|n| (u, n)))
    };
    let public_want: BTreeSet<&str> = new_of(Audience::Public)
        .map(|(_, n)| n)
        .filter(|n| !p.contains(n))
        .collect();
    let mut out = PackPlan {
        public: (!public_want.is_empty()).then(|| PackJob {
            want: public_want.iter().map(|s| (*s).to_owned()).collect(),
            have: p.iter().map(|s| (*s).to_owned()).collect(),
        }),
        members: Vec::new(),
    };
    let mut members: Vec<(&BatchRef, &str)> = new_of(Audience::Members).collect();
    members.sort_by(|a, b| a.0.dst.cmp(&b.0.dst));
    for (u, tip) in members {
        let mut have: BTreeSet<&str> = p.union(&public_want).copied().collect();
        if let Some(prev) = members_tips.get(&u.dst) {
            have.insert(prev);
        }
        if have.contains(tip) {
            continue;
        }
        out.members.push(MembersPackJob {
            ref_name: u.dst.clone(),
            want: vec![tip.to_owned()],
            have: have.into_iter().map(str::to_owned).collect(),
        });
    }
    out
}
