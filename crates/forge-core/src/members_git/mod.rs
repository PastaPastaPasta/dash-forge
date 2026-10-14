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

/// Who a ref, a commit or a pack is for. Serialized as `"public"`, `"members"`, or a narrower
/// branch's ledger token (`branch:<16 hex>`, [`crate::private::branch_key::ledger_token`]).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Audience {
    /// Everyone.
    Public,
    /// The repository's members (the members key).
    Members,
    /// A narrower branch's audience (its own branch key, phase 3F), by its ledger token; who that
    /// is lives in [`guard::NarrowAudiences`].
    Narrower(String),
}

impl Audience {
    /// Whether it is sealed (members-only or narrower).
    #[must_use]
    pub fn is_sealed(&self) -> bool {
        *self != Self::Public
    }

    /// The spelling vectors and the ledger use.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Public => "public",
            Self::Members => "members",
            Self::Narrower(t) => t,
        }
    }

    /// Parse [`Self::as_str`]: a token other than `public` and `members` is narrower when it is a
    /// valid ledger audience token.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "public" => Some(Self::Public),
            "members" => Some(Self::Members),
            t => match ledger::EntryAudience::parse(t)? {
                ledger::EntryAudience::Narrower(t) => Some(Self::Narrower(t)),
                ledger::EntryAudience::Members => None,
            },
        }
    }

    /// The ledger audience a commit pushed for it is recorded with (`None` for public).
    #[must_use]
    pub fn entry(&self) -> Option<ledger::EntryAudience> {
        match self {
            Self::Public => None,
            Self::Members => Some(ledger::EntryAudience::Members),
            Self::Narrower(t) => Some(ledger::EntryAudience::Narrower(t.clone())),
        }
    }
}

impl serde::Serialize for Audience {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> serde::Deserialize<'de> for Audience {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Self::parse(&s).ok_or_else(|| serde::de::Error::custom(format!("unknown audience `{s}`")))
    }
}
