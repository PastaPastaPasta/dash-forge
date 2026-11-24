//! Review before signing (organizations design §9): every check a signer makes on a proposal's
//! decoded transition, and the plain description of what it writes.

use std::collections::BTreeMap;

use crate::network::ForgeIds;
use crate::platform::org::{decode_unsigned, DecodedWrite};
use crate::platform::{FieldValue, PlatformClient};
use crate::rules::v2::Role;

use super::state::Proposal;

/// The (document type, action) pairs an organization signs (§9 review step 5).
pub const ALLOWED: [(&str, &str); 13] = [
    ("repo", "create"),
    ("repo", "replace"),
    ("maintainer", "create"),
    ("maintainer", "delete"),
    ("writer", "create"),
    ("writer", "delete"),
    ("config", "create"),
    ("profile", "create"),
    ("profile", "replace"),
    ("topic", "create"),
    ("topic", "delete"),
    ("runner", "create"),
    ("runner", "delete"),
];

/// What a review checks the proposal against.
#[derive(Debug, Clone)]
pub struct Expect<'a> {
    pub network: &'a str,
    pub org_id: &'a str,
    pub key_id: u32,
    pub cid: &'a str,
    pub slot: &'a str,
    pub forge: &'a ForgeIds,
}

#[derive(Debug, Clone)]
pub struct Reviewed {
    pub decoded: Option<DecodedWrite>,
    pub problems: Vec<String>,
}

impl Reviewed {
    pub fn ok(&self) -> bool {
        self.problems.is_empty()
    }
}

/// The checks that need no network: §9 review steps 1, 2, 3 and 5, plus the proposal's network
/// and signing requirement. Step 4 (the nonce) is [`nonce_problem`].
pub fn review_offline(expect: &Expect<'_>, proposal: &Proposal) -> Reviewed {
    let mut problems = Vec::new();
    if proposal.network() != expect.network {
        problems.push(format!(
            "it is for {}, not {}",
            proposal.network(),
            expect.network
        ));
    }
    let reqs = proposal.posted_requirements();
    if reqs != [(expect.cid.to_string(), expect.slot.to_string())] {
        problems.push("it asks for signatures from keys other than the organization's".into());
    }
    let decoded = match hex::decode(proposal.unsigned_hex())
        .map_err(|e| e.to_string())
        .and_then(|b| decode_unsigned(&b).map_err(|e| e.to_string()))
    {
        Ok(d) => d,
        Err(e) => {
            problems.push(format!("its transition cannot be read: {e}"));
            return Reviewed {
                decoded: None,
                problems,
            };
        }
    };
    problems.extend(decoded_problems(expect, &decoded, &proposal.signable()));
    Reviewed {
        decoded: Some(decoded),
        problems,
    }
}

/// Steps 1, 2, 3 and 5 on a decoded transition and the bytes the proposal asks to sign.
pub fn decoded_problems(expect: &Expect<'_>, d: &DecodedWrite, signable: &[u8]) -> Vec<String> {
    let mut problems = Vec::new();
    if !d.batch || d.transitions != 1 || d.document_transitions != 1 {
        problems.push("it is not exactly one document write".into());
        return problems;
    }
    if d.owner_id != expect.org_id {
        problems.push("it writes as another identity, not the organization".into());
    }
    if d.signature_key_id != Some(expect.key_id) {
        problems.push("it is not signed with the organization's group key".into());
    }
    if d.user_fee_increase != 0 {
        problems.push("it raises the fee".into());
    }
    if !d.signature_empty {
        problems.push("it already carries a signature".into());
    }
    if d.signable != signable {
        problems.push("the bytes to sign are not the transition's".into());
    }
    if !ALLOWED.contains(&(d.document_type.as_str(), d.action.as_str())) {
        problems.push(format!(
            "Forge does not sign this kind of write ({} {})",
            d.action, d.document_type
        ));
    } else if expect.forge.contract_id_of(&d.document_type) != Some(d.contract_id.as_str()) {
        problems.push("it writes to a contract that is not this network's Forge".into());
    }
    problems
}

/// Step 4: the nonce must be above the identity's current one.
pub fn nonce_problem(d: &DecodedWrite, current: u64) -> Option<String> {
    (d.nonce <= current).then(|| "it was overtaken: its nonce is already used".to_string())
}

fn ident(d: &DecodedWrite, field: &str) -> Option<String> {
    match d.properties.get(field)? {
        FieldValue::Identifier(b) | FieldValue::Bytes32(b) => {
            Some(crate::platform::encode_identifier(*b))
        }
        FieldValue::Bytes(b) => <[u8; 32]>::try_from(b.as_slice())
            .ok()
            .map(crate::platform::encode_identifier),
        _ => None,
    }
}

fn text(d: &DecodedWrite, field: &str) -> Option<String> {
    d.properties.get(field)?.as_str().map(str::to_string)
}

/// Names the description uses: repositories by id (`label/name`) and identities by id.
#[derive(Debug, Clone, Default)]
pub struct Names {
    pub repos: BTreeMap<String, String>,
    pub identities: BTreeMap<String, String>,
}

impl Names {
    fn repo(&self, id: Option<String>) -> String {
        id.map_or_else(
            || "a repository".to_string(),
            |id| self.repos.get(&id).cloned().unwrap_or(id),
        )
    }

    fn who(&self, id: Option<String>) -> String {
        id.map_or_else(
            || "someone".to_string(),
            |id| self.identities.get(&id).cloned().unwrap_or(id),
        )
    }
}

fn role_of(d: &DecodedWrite) -> Role {
    if d.document_type == "maintainer" {
        return Role::Maintainer;
    }
    Role::from_writer_role_code(d.properties.get("role").and_then(FieldValue::as_u64))
        .unwrap_or(Role::Writer)
}

/// What the write does, in words. A delete is described from `stored`, the document it deletes
/// (read from Platform), when there is one.
pub fn describe(d: &DecodedWrite, stored: Option<&DecodedWrite>, names: &Names) -> String {
    let src = stored.unwrap_or(d);
    let repo = names.repo(ident(src, "repoId"));
    let who = names.who(ident(src, "memberId"));
    match (d.document_type.as_str(), d.action.as_str()) {
        ("repo", "create") => format!(
            "Create the repository {}",
            names.repo(Some(d.document_id.clone()))
        ),
        ("repo", "replace") => format!(
            "Edit the listing of {}",
            names.repo(Some(d.document_id.clone()))
        ),
        ("maintainer" | "writer", "create") => {
            format!("Give {who} {} access to {repo}", role_of(d).label())
        }
        ("maintainer" | "writer", "delete") if stored.is_some() => {
            format!("Remove {who}'s {} access to {repo}", role_of(src).label())
        }
        ("maintainer" | "writer", "delete") => {
            format!("Remove a {} access that no longer exists", d.document_type)
        }
        ("config", "create") => format!(
            "Set up {repo} (default branch {})",
            text(d, "defaultBranch").unwrap_or_else(|| "main".into())
        ),
        ("profile", "create") => "Create the organization's profile".into(),
        ("profile", "replace") => "Update the organization's profile".into(),
        ("topic", "create") => format!(
            "Add the topic {} to {repo}",
            text(d, "name").unwrap_or_default()
        ),
        ("topic", "delete") => format!(
            "Remove the topic {} from {repo}",
            stored.and_then(|s| text(s, "name")).unwrap_or_default()
        ),
        ("runner", "create") => format!("Add {who} as a CI runner of {repo}"),
        ("runner", "delete") => format!("Remove the CI runner {who} from {repo}"),
        (t, a) => format!("Unrecognized write ({a} {t})"),
    }
}

/// The ids a description names: repositories and identities.
pub fn referenced_ids(d: &DecodedWrite) -> (Vec<String>, Vec<String>) {
    (
        ident(d, "repoId").into_iter().collect(),
        ident(d, "memberId").into_iter().collect(),
    )
}

/// The stored document a delete removes, as a [`DecodedWrite`]-shaped view (its properties).
pub async fn stored_target(
    client: &PlatformClient,
    d: &DecodedWrite,
) -> crate::Result<Option<DecodedWrite>> {
    if d.action != "delete" {
        return Ok(None);
    }
    let contract = client.fetch_contract(&d.contract_id).await?;
    let doc = client
        .fetch_document(&contract, &d.document_type, &d.document_id)
        .await?;
    Ok(doc.map(|doc| DecodedWrite {
        properties: doc.fields,
        ..d.clone()
    }))
}
