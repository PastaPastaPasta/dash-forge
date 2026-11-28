//! Review before signing (organizations design §9): every check a signer makes on a proposal's
//! decoded transition, and the plain description of what it writes.

use std::collections::BTreeMap;

use crate::network::ForgeIds;
use crate::platform::org::{decode_unsigned, DecodedWrite, NonceState};
use crate::platform::{FieldValue, PlatformClient};
use crate::rules::v2::Role;

use super::owner::parse_declared_org;
use super::state::Proposal;
use super::transport::Roster;

/// The (document type, action) pairs an organization signs (§9 review step 5, §10.5).
pub const ALLOWED: [(&str, &str); 15] = [
    ("org", "create"),
    ("org", "replace"),
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
    /// The roster of the ceremony the organization signs with: what an `org` write must
    /// publish, and the N of M a declared profile link must name.
    pub roster: Option<Roster>,
}

#[derive(Debug, Clone)]
pub struct Reviewed {
    pub decoded: Option<DecodedWrite>,
    pub problems: Vec<String>,
    /// Review step 4: the nonce is used or too far ahead (status reads it as `expired`).
    pub nonce: Option<String>,
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
                nonce: None,
            };
        }
    };
    problems.extend(decoded_problems(expect, &decoded, &proposal.signable()));
    Reviewed {
        decoded: Some(decoded),
        problems,
        nonce: None,
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
    let home = if d.document_type == "org" {
        expect.forge.org.as_deref()
    } else {
        expect.forge.contract_id_of(&d.document_type)
    };
    if !ALLOWED.contains(&(d.document_type.as_str(), d.action.as_str())) {
        problems.push(format!(
            "Forge does not sign this kind of write ({} {})",
            super::one_line(&d.action),
            super::one_line(&d.document_type)
        ));
    } else if home != Some(d.contract_id.as_str()) {
        problems.push("it writes to a contract that is not this network's Forge".into());
    }
    problems.extend(roster_problem(expect, d));
    problems
}

/// §10.5: an `org` write must publish exactly the bound ceremony's roster, and a profile's
/// declared link must name its N of M.
fn roster_problem(expect: &Expect<'_>, d: &DecodedWrite) -> Option<String> {
    let want = expect.roster.as_ref();
    match d.document_type.as_str() {
        "org" if d.action != "delete" => {
            let ok = Roster::from_props(&d.properties)
                .zip(want)
                .is_some_and(|(got, want)| got.same_key(want));
            (!ok).then(|| "the roster it publishes is not the organization's key ceremony".into())
        }
        "profile" => {
            let links = d
                .properties
                .get("links")
                .and_then(FieldValue::as_text_list)
                .unwrap_or_default();
            let quorum = want.map(|r| (r.threshold, r.members.len()));
            links
                .iter()
                .filter_map(|l| parse_declared_org(l, expect.network))
                .find(|(n, m)| quorum != Some((*n as usize, *m as usize)))
                .map(|(n, m)| match quorum {
                    Some((qn, qm)) => format!(
                        "its profile link declares the organization as {n} of {m}, but it is {qn} of {qm}"
                    ),
                    None => "its profile link declares an organization Forge can't check".into(),
                })
        }
        _ => None,
    }
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
    let quorum = || {
        Roster::from_props(&d.properties).map_or_else(String::new, |r| {
            format!(" ({} of {})", r.threshold, r.members.len())
        })
    };
    match (d.document_type.as_str(), d.action.as_str()) {
        ("org", "create") => format!("Publish the organization's roster on Platform{}", quorum()),
        ("org", "replace") => format!("Publish the organization's roster again{}", quorum()),
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
            "Set up {repo} (default branch {}{})",
            text(d, "defaultBranch").unwrap_or_else(|| "main".into()),
            match d.properties.get("protectedPatterns") {
                Some(FieldValue::List(p)) if !p.is_empty() => ", protected",
                _ => ", not protected",
            }
        ),
        ("profile", "create") => {
            let blank = DecodedWrite {
                properties: BTreeMap::new(),
                ..d.clone()
            };
            format!(
                "Create the organization's profile{}",
                changes(d, Some(&blank), names)
            )
        }
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

/// Equal by value: a transition carries identifiers as plain bytes and integers as `U64`, which
/// Drive hands back as identifiers and narrower integers.
fn same(a: &FieldValue, b: &FieldValue) -> bool {
    match (a, b) {
        (FieldValue::List(x), FieldValue::List(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
        }
        (FieldValue::Object(x), FieldValue::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => match (a.as_bytes(), b.as_bytes()) {
            (Some(x), Some(y)) => x == y,
            _ => match (a.as_i64(), b.as_i64()) {
                (Some(x), Some(y)) => x == y,
                _ => a == b,
            },
        },
    }
}

/// Profile properties an organization's request never sets or changes: signing keys and bot
/// claims stay what the organization's members put there by other means (none today).
pub const PROTECTED_PROFILE_FIELDS: [&str; 3] = ["pubkeys", "bot", "keyProofs"];

/// An organization `profile` write that sets or changes a protected property against `stored`
/// (none for a create).
pub fn protected_profile_problem(
    d: &DecodedWrite,
    stored: Option<&DecodedWrite>,
) -> Option<String> {
    if d.document_type != "profile" {
        return None;
    }
    let before = |k: &str| stored.and_then(|s| s.properties.get(k));
    PROTECTED_PROFILE_FIELDS
        .iter()
        .find(|k| match (d.properties.get(**k), before(k)) {
            (None, None) => false,
            (Some(a), Some(b)) => !same(a, b),
            _ => true,
        })
        .map(|k| {
            format!("it changes the profile's {k}, which an organization's request never does")
        })
}

/// Whether two documents carry the same fields, system (`$`) fields aside.
pub fn same_fields(a: &BTreeMap<String, FieldValue>, b: &BTreeMap<String, FieldValue>) -> bool {
    let user = |m: &BTreeMap<String, FieldValue>| m.keys().filter(|k| !k.starts_with('$')).count();
    user(a) == user(b)
        && a.iter()
            .filter(|(k, _)| !k.starts_with('$'))
            .all(|(k, v)| b.get(k).is_some_and(|w| same(v, w)))
}

/// `: set description to “…”; remove website` — what a replace changes against `stored`.
fn changes(d: &DecodedWrite, stored: Option<&DecodedWrite>, names: &Names) -> String {
    let Some(before) = stored else {
        let blank = DecodedWrite {
            properties: BTreeMap::new(),
            ..d.clone()
        };
        let sets = changes(d, Some(&blank), names);
        return format!(
            " (its current version could not be read; it would {})",
            sets.trim_start_matches(": ")
        );
    };
    let mut out = Vec::new();
    for (k, v) in &d.properties {
        if !before.properties.get(k).is_some_and(|b| same(b, v)) {
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
                ("forkOf", FieldValue::Identifier([9; 32])),
                ("stars", FieldValue::Integer(3)),
            ],
        );
        let after = write(
            "replace",
            &[
                ("name", FieldValue::text("widgets")),
                ("description", FieldValue::text("new")),
                ("renamedTo", FieldValue::Bytes(other.to_vec())),
                ("forkOf", FieldValue::Bytes(vec![9; 32])),
                ("stars", FieldValue::Uint64(3)),
            ],
        );
        assert_eq!(
            describe(&after, Some(&before), &names),
            "Edit the listing of acme/widgets: set description to “new”; set renamedTo to mallory/trap; remove website"
        );
        assert!(describe(&after, None, &names)
            .contains("could not be read; it would set description to “new”"));
    }

    fn roster() -> Roster {
        Roster {
            room: "t_000102030405060708090a0b0c0d0e0f".into(),
            relay: Some("https://multisig.dashhq.org".into()),
            cid: "11".repeat(32),
            key_id: 2,
            group_key: "22".repeat(48),
            threshold: 2,
            members: vec!["a1".repeat(32), "b2".repeat(32), "c3".repeat(32)],
            pub_shares: vec!["d4".repeat(48), "e5".repeat(48), "f6".repeat(48)],
        }
    }

    fn checked(d: &DecodedWrite, want: Option<Roster>) -> Option<String> {
        let forge = ForgeIds::test_forge();
        let expect = Expect {
            network: "testnet",
            org_id: "",
            key_id: 2,
            cid: "",
            slot: "high",
            forge: &forge,
            roster: want,
        };
        roster_problem(&expect, d)
    }

    #[test]
    fn an_org_write_must_publish_the_bound_ceremony_exactly() {
        let r = roster();
        let mut d = write("create", &[]);
        d.document_type = "org".into();
        d.properties = r.props();
        assert_eq!(checked(&d, Some(r.clone())), None);
        let mut other_relay = r.clone();
        other_relay.relay = Some("https://relay.example".into());
        d.properties = other_relay.props();
        assert_eq!(
            checked(&d, Some(r.clone())),
            None,
            "the relay is not the key"
        );
        let mut swapped = r.clone();
        swapped.members.swap(0, 1);
        d.properties = swapped.props();
        assert!(
            checked(&d, Some(r.clone())).is_some(),
            "members out of order"
        );
        let mut lower = r.clone();
        lower.threshold = 3;
        d.properties = lower.props();
        assert!(checked(&d, Some(r.clone())).is_some());
        d.properties = r.props();
        assert!(checked(&d, None).is_some(), "no ceremony to check against");
        assert!(describe(&d, None, &Names::default()).ends_with("(2 of 3)"));
    }

    #[test]
    fn a_declared_profile_link_must_name_the_organizations_n_of_m() {
        let link = |n, m| {
            FieldValue::text_list(vec![
                "https://acme.example".to_string(),
                super::super::owner::declared_org_link("testnet", n, m),
            ])
        };
        let mut d = write("replace", &[("links", link(2, 3))]);
        d.document_type = "profile".into();
        assert_eq!(checked(&d, Some(roster())), None);
        d.properties.insert("links".into(), link(2, 4));
        assert!(checked(&d, Some(roster()))
            .unwrap()
            .contains("2 of 4, but it is 2 of 3"));
        d.properties.insert(
            "links".into(),
            FieldValue::text_list(vec![super::super::owner::declared_org_link(
                "devnet-x", 9, 9,
            )]),
        );
        assert_eq!(
            checked(&d, Some(roster())),
            None,
            "another network's link is not checked"
        );
    }

    #[test]
    fn an_org_profile_write_never_touches_signing_keys_or_bot_claims() {
        let mut create = write("create", &[("displayName", FieldValue::text("Acme"))]);
        create.document_type = "profile".into();
        assert_eq!(protected_profile_problem(&create, None), None);
        assert!(describe(&create, None, &Names::default()).contains("set displayName to “Acme”"));
        create.properties.insert(
            "pubkeys".into(),
            FieldValue::text_list(vec!["ssh-ed25519 AAAA".to_string()]),
        );
        assert!(protected_profile_problem(&create, None)
            .unwrap()
            .contains("pubkeys"));

        let bot = |b: u8| {
            FieldValue::Object(BTreeMap::from([(
                "operator".to_string(),
                FieldValue::Bytes(vec![b; 32]),
            )]))
        };
        let mut stored = write(
            "replace",
            &[(
                "bot",
                FieldValue::Object(BTreeMap::from([(
                    "operator".to_string(),
                    FieldValue::Identifier([4; 32]),
                )])),
            )],
        );
        stored.document_type = "profile".into();
        let mut kept = stored.clone();
        kept.properties.insert("bot".into(), bot(4));
        assert_eq!(
            protected_profile_problem(&kept, Some(&stored)),
            None,
            "same value, other encoding"
        );
        let mut moved = stored.clone();
        moved.properties.insert("bot".into(), bot(5));
        assert!(protected_profile_problem(&moved, Some(&stored)).is_some());
        let mut dropped = stored.clone();
        dropped.properties.remove("bot");
        assert!(protected_profile_problem(&dropped, Some(&stored)).is_some());
    }
}
