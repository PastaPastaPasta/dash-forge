//! Review before signing (organizations design §9): every check a signer makes on a proposal's
//! decoded transition, and the plain description of what it writes.

use std::collections::BTreeMap;

use crate::network::ForgeIds;
use crate::platform::org::{decode_unsigned, DecodedWrite, NonceState};
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
    if !d.canonical {
        problems.push("its bytes do not re-encode to themselves".into());
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
            super::one_line(&d.action),
            super::one_line(&d.document_type)
        ));
    } else if expect.forge.contract_id_of(&d.document_type) != Some(d.contract_id.as_str()) {
        problems.push("it writes to a contract that is not this network's Forge".into());
    }
    problems
}

/// Step 4: the nonce must still be usable, and not further ahead than Platform accepts.
pub fn nonce_problem(d: &DecodedWrite, current: NonceState) -> Option<String> {
    if current.spent(d.nonce) {
        Some("it was overtaken: its nonce is already used".to_string())
    } else if current.too_far(d.nonce) {
        Some("its nonce is further ahead than Platform accepts".to_string())
    } else {
        None
    }
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
            "Edit the listing of {}{}",
            names.repo(Some(d.document_id.clone())),
            changes(d, stored, names)
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
        ("profile", "replace") => format!(
            "Update the organization's profile{}",
            changes(d, stored, names)
        ),
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

fn shown(key: &str, v: &FieldValue, names: &Names) -> String {
    match v {
        FieldValue::Text(t) => format!("“{t}”"),
        FieldValue::Identifier(b) | FieldValue::Bytes32(b) => {
            let id = crate::platform::encode_identifier(*b);
            if key == "renamedTo" {
                names.repo(Some(id))
            } else {
                id
            }
        }
        FieldValue::Bytes(b) => match <[u8; 32]>::try_from(b.as_slice()) {
            Ok(a) => shown(key, &FieldValue::Identifier(a), names),
            Err(_) => hex::encode(b),
        },
        FieldValue::Integer(n) | FieldValue::Uint64(n) => n.to_string(),
        FieldValue::Signed(n) => n.to_string(),
        FieldValue::Bool(b) => b.to_string(),
        FieldValue::List(items) => items
            .iter()
            .map(|i| shown(key, i, names))
            .collect::<Vec<_>>()
            .join(", "),
        FieldValue::Object(_) => "(a nested value)".into(),
    }
}

/// `: set description to “…”; remove website` — what a replace changes against `stored`.
fn changes(d: &DecodedWrite, stored: Option<&DecodedWrite>, names: &Names) -> String {
    let Some(before) = stored else {
        return " (its current version could not be read)".into();
    };
    let mut out = Vec::new();
    for (k, v) in &d.properties {
        if before.properties.get(k) != Some(v) {
            out.push(format!("set {k} to {}", shown(k, v, names)));
        }
    }
    for k in before.properties.keys() {
        if !d.properties.contains_key(k) {
            out.push(format!("remove {k}"));
        }
    }
    if out.is_empty() {
        " (no change)".into()
    } else {
        format!(": {}", out.join("; "))
    }
}

/// The ids a description names: repositories and identities.
pub fn referenced_ids(d: &DecodedWrite) -> (Vec<String>, Vec<String>) {
    (
        ident(d, "repoId")
            .into_iter()
            .chain(ident(d, "renamedTo"))
            .collect(),
        ident(d, "memberId").into_iter().collect(),
    )
}

/// The stored document a delete removes or a replace changes, as a [`DecodedWrite`]-shaped
/// view (its properties).
pub async fn stored_target(
    client: &PlatformClient,
    d: &DecodedWrite,
) -> crate::Result<Option<DecodedWrite>> {
    if d.action != "delete" && d.action != "replace" {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn write(action: &str, props: &[(&str, FieldValue)]) -> DecodedWrite {
        DecodedWrite {
            batch: true,
            canonical: true,
            owner_id: String::new(),
            signature_key_id: None,
            user_fee_increase: 0,
            signature_empty: true,
            document_transitions: 1,
            transitions: 1,
            contract_id: String::new(),
            document_type: "repo".into(),
            action: action.into(),
            document_id: "R".into(),
            nonce: 1,
            revision: Some(2),
            properties: props
                .iter()
                .map(|(k, v)| ((*k).to_string(), v.clone()))
                .collect(),
            signable: Vec::new(),
        }
    }

    #[test]
    fn a_listing_edit_says_what_it_changes() {
        let mut names = Names::default();
        names.repos.insert("R".into(), "acme/widgets".into());
        let other = [7u8; 32];
        names.repos.insert(
            crate::platform::encode_identifier(other),
            "mallory/trap".into(),
        );
        let before = write(
            "replace",
            &[
                ("name", FieldValue::text("widgets")),
                ("description", FieldValue::text("old")),
                ("website", FieldValue::text("https://a")),
            ],
        );
        let after = write(
            "replace",
            &[
                ("name", FieldValue::text("widgets")),
                ("description", FieldValue::text("new")),
                ("renamedTo", FieldValue::Bytes(other.to_vec())),
            ],
        );
        assert_eq!(
            describe(&after, Some(&before), &names),
            "Edit the listing of acme/widgets: set description to “new”; set renamedTo to mallory/trap; remove website"
        );
        assert!(describe(&after, None, &names).ends_with("could not be read)"));
    }
}
