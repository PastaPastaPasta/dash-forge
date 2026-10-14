//! The git side of members-only branches in a public repository (mixed-visibility DESIGN §4.3,
//! D21, D22; `docs/security/private-repos.md` §19.4–§19.6), as library code the git helper
//! wires in:
//!
//! * [`plan`]: which pack a push uploads for which audience, with which delta bases (D22);
//! * [`ledger`]: the clone's sealed-object ledger, `<git common dir>/dash/sealed-ledger`;
//! * [`guard`]: the publication guard, a pure function over the ledger, the commits the pusher
//!   can decrypt, the batch and the public tips, through an object-graph seam the helper backs
//!   with git;
//! * [`hook`]: the clone's `pre-push` hook, which runs the ledger check for pushes to other
//!   remotes (E810).

pub mod guard;
pub mod hook;
pub mod ledger;
pub mod plan;

#[cfg(test)]
pub(crate) mod conformance;

/// Who a ref, a commit or a pack is for.
#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum Audience {
    /// Everyone.
    Public,
    /// The repository's members (the members key).
    Members,
}
