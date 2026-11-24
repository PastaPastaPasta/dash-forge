//! Organizations: repository owners that are N-of-M threshold identities made with
//! multisig.dashhq.org (`dti/1`). Forge implements the reading and signing side of `dti/1`
//! (docs/design/organizations.md §9): envelopes, room state, share recovery, approve, reject,
//! combine and broadcast. The Platform half (building, reviewing and broadcasting the
//! organization's transitions) is `platform::org`.

pub mod actions;
pub mod bls;
pub mod canon;
pub mod ceremony;
pub mod derive;
pub mod envelope;
pub mod member;
pub mod relay;
pub mod request;
pub mod review;
pub mod session;
pub mod state;

#[cfg(test)]
mod vector_tests;

use serde::{Deserialize, Serialize};

use crate::network::Network;
use ceremony::{KeySlot, SlotKeys};
use state::{Ceremony, RoomState};

pub use derive::{MemberKeys, Seed};
pub use relay::{Relay, DEFAULT_RELAY};
pub use session::{connect, Org};

#[derive(Debug, thiserror::Error)]
pub enum OrgError {
    #[error("{0}")]
    Malformed(String),
    #[error("{0}")]
    Phrase(String),
    #[error("this recovery phrase is not one of the organization's members")]
    NotAMember,
    #[error("{0}")]
    Share(String),
    #[error("not enough valid signatures yet")]
    NotReady,
    #[error("{0}")]
    Relay(String),
    #[error(transparent)]
    Canonical(#[from] canon::NotCanonical),
}

impl From<OrgError> for crate::Error {
    fn from(e: OrgError) -> Self {
        crate::Error::Config(e.to_string())
    }
}

/// Whether organizations are available on `network`: everywhere but mainnet, for now.
pub fn enabled(network: &Network) -> bool {
    !matches!(network, Network::Mainnet)
}

/// The sentence every organization command answers with on mainnet.
pub const NOT_ON_MAINNET: &str = "Organizations are not available on mainnet yet.";

/// A member of a connected organization, as remembered locally.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberRecord {
    pub index: u32,
    pub name: String,
    pub auth_pub: String,
}

/// A connected organization: public values only (§9 "Local record").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgRecord {
    pub network: String,
    pub org_id: String,
    pub room: String,
    pub relay: String,
    pub auth_pub: String,
    pub label: String,
    pub threshold: usize,
    pub members: Vec<MemberRecord>,
}

impl OrgRecord {
    pub fn member_name(&self, auth_pub: &str) -> String {
        self.members
            .iter()
            .find(|m| m.auth_pub == auth_pub)
            .map_or_else(
                || format!("{}…", &auth_pub[..auth_pub.len().min(8)]),
                |m| m.name.clone(),
            )
    }
}

/// The group id an invite link or a bare group id names.
pub fn parse_group_id(text: &str) -> Option<String> {
    let t = text.trim();
    for marker in ["#room=", "&room=", "?room="] {
        if let Some(rest) = t.split(marker).nth(1) {
            let id: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            return ceremony::room_name_ok(&id).then_some(id);
        }
    }
    ceremony::room_name_ok(t).then(|| t.to_string())
}

/// The slot an organization signs Forge documents with: purpose AUTHENTICATION, level HIGH.
pub fn signing_slot(c: &Ceremony) -> Option<(&KeySlot, &SlotKeys)> {
    c.result
        .as_ref()?
        .keys
        .values()
        .find(|(k, _)| k.purpose == "AUTHENTICATION" && k.security_level == "HIGH")
        .map(|(k, s)| (k, s))
}

/// Completed ceremonies with a signing slot, newest config first.
pub fn signing_ceremonies(state: &RoomState) -> Vec<&Ceremony> {
    let mut list: Vec<&Ceremony> = state
        .ceremonies
        .values()
        .filter(|c| signing_slot(c).is_some())
        .collect();
    list.sort_by(|a, b| {
        let at = |c: &Ceremony| {
            c.config.raw["createdAt"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        };
        at(b).cmp(&at(a)).then_with(|| a.cid.cmp(&b.cid))
    });
    list
}
