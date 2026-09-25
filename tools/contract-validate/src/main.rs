//! Offline validation of the forge-v2 data contracts against Dash Platform protocol 14.
//!
//!   cargo run --manifest-path tools/contract-validate/Cargo.toml -- \
//!       forge-contracts/contracts/forge-core.json forge-contracts/contracts/forge-collab.json
//!
//! For each contract, in order, this:
//!   1. derives the contract id the deploy script will get (placeholder owner, nonce 1) and, for
//!      a later contract, substitutes the ids of the earlier ones for their placeholders
//!      (`FORGE_CORE_CONTRACT_ID`), exactly as `forge-contracts/scripts/deploy-v2.mjs` does;
//!   2. parses it with FULL validation under `PlatformVersion::get(14)` — the meta-schema, every
//!      document type, index, `refersTo`/`ownerRefersTo`/`lookup`, `immutable`, `encryptedFor`,
//!      `maxBytes`, typed-array and `indexOnly` rule the create transition's action transform
//!      runs on a node;
//!   3. runs the create transition's state-free basic-structure rules (version, keywords,
//!      description, contract-group registration and memberships);
//!   4. runs the registration-time reference checks on every `refersTo` leaf (a port of
//!      drive-abci `validate_data_contract_references` v0), resolving references into another
//!      contract against the earlier contracts held in memory, which a node would fetch from state;
//!   5. validates sample documents against the parsed types (JSON schema and maxBytes, the
//!      document-property validation every create and replace runs), expecting well-formed ones
//!      to pass and malformed ones to be refused;
//!   6. serializes the contract and a signed-shape `DataContractCreateTransition` v1 and reports
//!      both sizes against `max_state_transition_size` and the registration fee.
//!
//! What cannot be checked offline, and is left to registration on a live network: that the
//! referenced contract exists in state (it is the in-memory one here), that the signer's identity
//! exists and holds the balance, and the contract group's state rules (group not already
//! registered, signer owns or administers the group a membership names).

use anyhow::{anyhow, bail, Context, Result};
use dpp::contract_group::{
    generate_contract_group_id, ContractGroupMember, ContractGroupMembership,
    ContractGroupRegistration,
};
use dpp::data_contract::accessors::v0::DataContractV0Getters;
use dpp::data_contract::accessors::v1::DataContractV1Getters;
use dpp::data_contract::conversion::json::DataContractJsonConversionMethodsV0;
use dpp::data_contract::document_type::accessors::{DocumentTypeV0Getters, DocumentTypeV2Getters};
use dpp::data_contract::document_type::{
    is_referenced_system_agreement_property, is_referring_system_agreement_property, is_transient,
    DocumentPropertyReferenceTarget, DocumentPropertyType, DocumentTypeRef, PropertyReference,
    ReferenceHolder,
};
use dpp::data_contract::serialized_version::DataContractInSerializationFormat;
use dpp::data_contract::validate_document::DataContractDocumentValidationMethodsV0;
use dpp::data_contract::DataContract;
use dpp::identifier::Identifier;
use dpp::serialization::PlatformSerializable;
use dpp::state_transition::data_contract_create_transition::{
    DataContractCreateTransition, DataContractCreateTransitionV1,
};
use dpp::state_transition::StateTransition;
use dpp::version::PlatformVersion;
use dpp::version::TryIntoPlatformVersioned;
use serde_json::Value as Json;
use std::collections::BTreeMap;
use std::path::PathBuf;

const PROTOCOL_VERSION: u32 = 14;
/// A stand-in owner. Contract ids derive from it, so the ids printed here are not the ones a
/// real deploy gets; the sizes are identical because every id is 32 bytes.
const PLACEHOLDER_OWNER: [u8; 32] = [7u8; 32];
/// An ECDSA recoverable signature, what a CRITICAL secp256k1 key produces.
const SIGNATURE_LEN: usize = 65;
const CREDITS_PER_DASH: f64 = 100_000_000_000.0;

/// One contract of the group: its file, the placeholder later contracts use for its id, and
/// whether its create transition registers the contract group (the first does).
struct Entry {
    path: PathBuf,
    registers_group: bool,
}

fn main() -> Result<()> {
    let paths: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
    if paths.is_empty() {
        bail!("usage: contract-validate <forge-core.json> [<forge-collab.json> ...]");
    }
    let entries: Vec<Entry> = paths
        .into_iter()
        .enumerate()
        .map(|(i, path)| Entry { path, registers_group: i == 0 })
        .collect();

    let pv = PlatformVersion::get(PROTOCOL_VERSION)
        .map_err(|e| anyhow!("protocol version {PROTOCOL_VERSION}: {e}"))?;
    let limit = pv.system_limits.max_state_transition_size;
    let owner = Identifier::from(PLACEHOLDER_OWNER);
    // The core contract registers the group with nonce 1; every contract enrols in it.
    let group_id = generate_contract_group_id(&owner, 1);
    // Known-answer vector for forge-contracts/scripts/deploy-v2.mjs, which derives both ids in JS
    println!(
        "id derivation (owner 0x07*32, nonce 1): contract {} group {}\n",
        DataContract::generate_data_contract_id_v0(owner, 1),
        group_id
    );

    let mut known: Vec<DataContract> = Vec::new();
    let mut placeholders: BTreeMap<String, String> = BTreeMap::new();
    let mut failures = 0usize;

    for (i, entry) in entries.iter().enumerate() {
        let nonce = (i + 1) as u64;
        let name = entry
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("contract")
            .to_string();
        println!("== {name} ({})", entry.path.display());
        match validate_one(entry, &name, nonce, owner, group_id, &known, &placeholders, pv, limit)
        {
            Ok(contract) => {
                placeholders.insert(placeholder_for(&name), contract.id().to_string(
                    dpp::platform_value::string_encoding::Encoding::Base58,
                ));
                known.push(contract);
            }
            Err(e) => {
                failures += 1;
                println!("   FAIL: {e:#}");
            }
        }
    }

    if failures > 0 {
        bail!("{failures} contract(s) failed validation");
    }
    println!("\nall contracts valid under protocol {PROTOCOL_VERSION}");
    Ok(())
}

/// `forge-core` -> `FORGE_CORE_CONTRACT_ID`.
fn placeholder_for(name: &str) -> String {
    format!("{}_CONTRACT_ID", name.to_uppercase().replace('-', "_"))
}

#[allow(clippy::too_many_arguments)]
fn validate_one(
    entry: &Entry,
    name: &str,
    nonce: u64,
    owner: Identifier,
    group_id: Identifier,
    known: &[DataContract],
    placeholders: &BTreeMap<String, String>,
    pv: &PlatformVersion,
    limit: u64,
) -> Result<DataContract> {
    let raw = std::fs::read_to_string(&entry.path)
        .with_context(|| format!("reading {}", entry.path.display()))?;
    let mut text = raw.clone();
    for (placeholder, id) in placeholders {
        text = text.replace(placeholder, id);
    }
    if let Some(unresolved) = ["_CONTRACT_ID\""].iter().find(|p| text.contains(*p)) {
        bail!("an id placeholder (…{unresolved}) is left unresolved: list the contract it names first");
    }
    let mut json: Json = serde_json::from_str(&text).context("parsing JSON")?;

    let contract_id = DataContract::generate_data_contract_id_v0(owner, nonce);
    json["id"] = Json::String(contract_id.to_string(
        dpp::platform_value::string_encoding::Encoding::Base58,
    ));
    json["ownerId"] = Json::String(owner.to_string(
        dpp::platform_value::string_encoding::Encoding::Base58,
    ));

    // (2) full structural validation, as the node's action transform runs it
    let contract = DataContract::from_json(json, true, pv).map_err(|e| anyhow!("{e}"))?;
    println!("   parse (full validation, protocol {}): ok", pv.protocol_version);

    let types = contract.document_types();
    for (type_name, document_type) in types {
        let dt = document_type.as_ref();
        println!(
            "   - {type_name:<18} mutable={:<5} deletable={:<5} indexOnly={:<5} indices={} refs={}{}",
            dt.documents_mutable(),
            dt.documents_can_be_deleted(),
            dt.index_only(),
            dt.indexes().len(),
            dt.reference_declarations().count(),
            if dt.owner_reference().is_some() { " ownerRefersTo" } else { "" },
        );
    }

    // (3) + (6) the create transition, v1 with the contract group
    let serialization: DataContractInSerializationFormat =
        (&contract).try_into_platform_versioned(pv).map_err(|e| anyhow!("{e}"))?;
    let memberships = vec![ContractGroupMembership {
        contract_group_id: group_id,
        member: ContractGroupMember::Contract,
    }];
    let registration = entry.registers_group.then(|| ContractGroupRegistration {
        admins: Default::default(),
        name: Some("dash-forge".to_string()),
        description: Some("Dash Forge v2: forge-core and forge-collab".to_string()),
    });
    let transition: DataContractCreateTransition = DataContractCreateTransitionV1 {
        data_contract: serialization,
        identity_nonce: nonce,
        contract_group: registration.clone(),
        contract_group_memberships: memberships.clone(),
        user_fee_increase: 0,
        signature_public_key_id: 2,
        signature: vec![0u8; SIGNATURE_LEN].into(),
    }
    .into();
    basic_structure(&contract, registration.as_ref(), &memberships, pv)?;
    println!("   create-transition basic structure (v2 rules): ok");

    // (4) the registration-time reference validation, against state held in memory
    let (local, foreign) = registration_references(&contract, known, pv)?;
    println!("   registration reference checks: {local} same-contract + {foreign} cross-contract leaves, ok");

    // (5) sample documents: every good one accepted, every bad one refused
    let check = |doc_type: &str, props: &Json| -> Result<bool> {
        let value: dpp::platform_value::Value = props.clone().into();
        let result = contract
            .validate_document_properties(doc_type, value, pv)
            .map_err(|e| anyhow!("{e}"))?;
        Ok(result.is_valid())
    };
    let samples = sample_documents(name);
    for (doc_type, props) in &samples {
        if !check(doc_type, props)? {
            let value: dpp::platform_value::Value = props.clone().into();
            let errors = contract.validate_document_properties(doc_type, value, pv).map_err(|e| anyhow!("{e}"))?.errors;
            bail!("sample {doc_type} rejected: {errors:?}");
        }
    }
    let bad = bad_documents(name);
    for (doc_type, why, props) in &bad {
        if check(doc_type, props)? {
            bail!("bad sample {doc_type} ({why}) was accepted");
        }
    }
    println!(
        "   sample documents: {} accepted, {} malformed refused",
        samples.len(),
        bad.len()
    );

    let contract_bytes = {
        use dpp::serialization::PlatformSerializableWithPlatformVersion;
        contract
            .serialize_to_bytes_with_platform_version(pv)
            .map_err(|e| anyhow!("{e}"))?
            .len()
    };
    let st: StateTransition = transition.into();
    let st_bytes = st.serialize_to_bytes().map_err(|e| anyhow!("{e}"))?;
    // Round-trip through the node's untrusted decoder, which enforces the protocol gates
    StateTransition::deserialize_from_bytes_untrusted_in_version(&st_bytes, pv)
        .map_err(|e| anyhow!("transition does not decode under protocol 14: {e}"))?;
    let fee = contract.registration_cost(pv).map_err(|e| anyhow!("{e}"))?;
    let index_count: usize = types.values().map(|t| t.as_ref().indexes().len()).sum();
    println!(
        "   size: contract {contract_bytes} B, create transition {} B / {limit} B max_state_transition_size ({:.1}%)",
        st_bytes.len(),
        100.0 * st_bytes.len() as f64 / limit as f64
    );
    println!(
        "   estimated_contract_max_serialized_size (fee-estimation target, not a limit): {} B",
        pv.system_limits.estimated_contract_max_serialized_size
    );
    println!(
        "   registration fee (fee schedule of protocol {}): {fee} credits = {:.4} DASH ({} types, {index_count} indices, {} keywords)",
        pv.protocol_version,
        fee as f64 / CREDITS_PER_DASH,
        types.len(),
        contract.keywords().len()
    );
    if st_bytes.len() as u64 > limit {
        bail!("create transition exceeds max_state_transition_size");
    }
    Ok(contract)
}

/// The create transition's unpaid structure rules that depend on the transition alone
/// (drive-abci `data_contract_create/basic_structure` v0..v2), restated for the fields this
/// contract uses. Only a node runs the real ones, so each is restated here, not imported.
fn basic_structure(
    contract: &DataContract,
    registration: Option<&ContractGroupRegistration>,
    memberships: &[ContractGroupMembership],
    pv: &PlatformVersion,
) -> Result<()> {
    let limits = &pv.system_limits;
    if contract.version() != 1 {
        bail!("a created contract must be version 1");
    }
    if contract.keywords().len() > 50 {
        bail!("too many keywords");
    }
    for keyword in contract.keywords() {
        if keyword.len() < 3 || keyword.len() > 50 {
            bail!("keyword {keyword:?} must be 3..=50 characters");
        }
    }
    if let Some(description) = contract.description() {
        if !(3..=100).contains(&description.len()) {
            bail!(
                "contract description must be 3..=100 characters, is {}",
                description.len()
            );
        }
    }
    if let Some(registration) = registration {
        if registration.admins.len() > limits.max_contract_group_admins as usize {
            bail!("too many contract group admins");
        }
        if let Some(n) = &registration.name {
            let len = n.chars().count();
            if len == 0 || len > limits.max_contract_group_name_length as usize {
                bail!("contract group name length {len}");
            }
        }
        if let Some(d) = &registration.description {
            let len = d.chars().count();
            if len == 0 || len > limits.max_contract_group_description_length as usize {
                bail!("contract group description length {len}");
            }
        }
    }
    if memberships.len() > limits.max_contract_group_memberships_per_contract as usize {
        bail!("too many contract group memberships");
    }
    Ok(())
}

/// A port of drive-abci `validate_data_contract_references` v0 (the registration-time state
/// validation of every `refersTo` leaf), run against this contract and the contracts validated
/// before it, which a node would fetch from state. The parser under full validation leaves the
/// referenced-side checks of a same-contract leaf's permanence (40122 / 40131) and every
/// `propertyAgreement` pair to this step, so it runs on every leaf, not only foreign ones.
fn registration_references(contract: &DataContract, known: &[DataContract], pv: &PlatformVersion) -> Result<(usize, usize)> {
    let (mut local, mut foreign) = (0, 0);
    for (type_name, document_type) in contract.document_types() {
        let dt = document_type.as_ref();
        for (holder, reference) in dt.reference_declarations() {
            let reference_property = match holder {
                ReferenceHolder::Property(path) => Some(path),
                ReferenceHolder::Owner | ReferenceHolder::Creator => None,
            };
            let target = match reference {
                PropertyReference::Value(t) | PropertyReference::Elements { target: t, .. } => t,
                // key id references are checked by the parser and by the key-id arm of the
                // node's validator, which reads only the declaring type
                PropertyReference::KeyId(_) => continue,
            };
            for (leaf_path, leaf) in target.leaves_with_paths() {
                let Some(decl) = leaf.as_any_document_reference() else {
                    continue;
                };
                let at = if leaf_path.is_empty() {
                    format!("{type_name}.{}", holder.path())
                } else {
                    format!("{type_name}.{}.{leaf_path}", holder.path())
                };
                let target_id = decl.contract_id.unwrap_or(contract.id());
                let referenced_contract = if target_id == contract.id() {
                    local += 1;
                    contract
                } else {
                    foreign += 1;
                    known.iter().find(|c| c.id() == target_id).ok_or_else(|| {
                        anyhow!("{at}: referenced contract {target_id} is not one validated before this one (40121)")
                    })?
                };
                let referenced = referenced_contract
                    .document_type_optional_for_name(decl.document_type_name)
                    .ok_or_else(|| anyhow!("{at}: {target_id} has no document type {} (40121)", decl.document_type_name))?;
                check_leaf(contract, dt, reference_property, referenced_contract, referenced, leaf, &decl, target_id != contract.id(), &at, pv)?;
            }
        }
    }
    Ok((local, foreign))
}

#[allow(clippy::too_many_arguments)]
fn check_leaf(
    _contract: &DataContract,
    declaring: DocumentTypeRef,
    reference_property: Option<&str>,
    referenced_contract: &DataContract,
    referenced: DocumentTypeRef,
    leaf: &DocumentPropertyReferenceTarget,
    decl: &dpp::data_contract::document_type::DocumentReferenceDeclaration,
    is_foreign: bool,
    at: &str,
    pv: &PlatformVersion,
) -> Result<()> {
    let deletable =
        referenced.documents_can_be_deleted() || referenced.documents_can_be_deleted_by_moderators();
    if decl.permanent && deletable {
        bail!("{at}: permanentDocument names deletable type {} (40122)", decl.document_type_name);
    }
    if !decl.permanent && !deletable {
        bail!("{at}: deletableDocument names non-deletable type {} (40131)", decl.document_type_name);
    }
    // the parse already ran the referenced side of same-contract lookups and lists
    if is_foreign {
        if let Some(lookup) = decl.lookup {
            if let Some(reason) = lookup.referenced_side_error(declaring, referenced) {
                bail!("{at}: lookup {} invalid (40137): {reason}", lookup.index);
            }
        }
        if let Some(list) = leaf.as_list_element_reference() {
            if let Some(reason) = list.referenced_side_error(referenced) {
                bail!("{at}: list invalid (40138): {reason}");
            }
        }
    }
    let writer = DocumentPropertyType::Identifier;
    for (referring, referenced_prop) in decl.property_agreement {
        let invalid = |why: &str| anyhow!("{at}: agreement {referring} = {referenced_prop} invalid (40126): {why}");
        if Some(referring.as_str()) == reference_property {
            return Err(invalid("the referring property cannot be the reference property itself"));
        }
        let referring_type = if referring.starts_with('$') {
            if !is_referring_system_agreement_property(referring) {
                return Err(invalid("the referring side must be a schema property or $ownerId"));
            }
            &writer
        } else {
            &declaring
                .flattened_properties()
                .get(referring)
                .ok_or_else(|| invalid("the declaring type does not define the referring property"))?
                .property_type
        };
        if referenced_prop.starts_with('$') {
            if !is_referenced_system_agreement_property(referenced_prop) {
                return Err(invalid("only $ownerId, $creatorId and $id may be agreed with"));
            }
            if !matches!(referring_type, DocumentPropertyType::Identifier | DocumentPropertyType::IdentifierWithReference(_)) {
                return Err(invalid("the referring property must be an identifier"));
            }
            if referenced_prop == "$creatorId"
                && !referenced
                    .should_use_creator_id(referenced_contract.system_version_type(), referenced_contract.config().version(), pv)
                    .map_err(|e| anyhow!("{e}"))?
            {
                return Err(invalid("the referenced type does not record $creatorId"));
            }
            continue;
        }
        let theirs = referenced
            .flattened_properties()
            .get(referenced_prop)
            .ok_or_else(|| invalid("the referenced type does not define the referenced property"))?;
        if is_transient(referenced, referenced_prop) {
            return Err(invalid("the referenced property is transient"));
        }
        if matches!(referring_type, DocumentPropertyType::Object(_) | DocumentPropertyType::TypedArray(_))
            || matches!(theirs.property_type, DocumentPropertyType::Object(_) | DocumentPropertyType::TypedArray(_))
        {
            return Err(invalid("agreement properties must be single plain values"));
        }
        if referring_type.value_kind() != theirs.property_type.value_kind() {
            return Err(invalid("the two properties hold different kinds of value"));
        }
    }
    Ok(())
}

/// Representative documents per type, checked against the parsed schema.
fn sample_documents(contract: &str) -> Vec<(&'static str, Json)> {
    let id = |b: u8| Json::Array(vec![Json::from(b); 32]);
    let bytes = |b: u8, n: usize| Json::Array(vec![Json::from(b); n]);
    match contract {
        "forge-core" => vec![
            ("repo", serde_json::json!({ "name": "dash-forge", "description": "git on Dash Platform", "defaultBranch": "main", "visibility": "public", "topics": ["git", "dash"] })),
            ("repo", serde_json::json!({ "name": "secret.repo_1", "visibility": "private", "forkOf": id(3) })),
            ("maintainer", serde_json::json!({ "repoId": id(1), "memberId": id(2) })),
            ("writer", serde_json::json!({ "repoId": id(1), "memberId": id(2) })),
            ("refUpdate", serde_json::json!({ "repoId": id(1), "refNameHash": bytes(9, 32), "refName": "refs/heads/main", "newOid": bytes(1, 20), "prevOid": bytes(2, 20) })),
            ("protectedRefUpdate", serde_json::json!({ "repoId": id(1), "refNameHash": bytes(9, 32), "refName": "refs/heads/main", "newOid": bytes(1, 32), "force": true })),
            ("config", serde_json::json!({ "repoId": id(1), "defaultBranch": "main", "protectedPatterns": ["refs/heads/main", "refs/tags/**"], "backend": { "mode": 2, "uris": ["s3://bucket/prefix"] }, "archived": false })),
            ("packManifest", serde_json::json!({ "repoId": id(1), "packHash": bytes(4, 32), "kind": 0, "sizeBytes": 1234, "objectCount": 10, "chunkCount": 1, "storage": 0, "uris": [], "tips": bytes(1, 20), "offsetIndexParts": 0 })),
            ("manifestPart", serde_json::json!({ "repoId": id(1), "packHash": bytes(4, 32), "partSeq": 0, "entries": bytes(5, 100) })),
            ("chunk", serde_json::json!({ "repoId": id(1), "packHash": bytes(4, 32), "seq": 0, "d0": bytes(6, 4900), "d1": bytes(6, 4900) })),
            ("release", serde_json::json!({ "repoId": id(1), "tagName": "v1.0.0", "name": "One", "notes": "notes", "yanked": false, "assets": "[]" })),
            ("label", serde_json::json!({ "repoId": id(1), "name": "bug", "color": "#d73a4a", "description": "Something is broken" })),
            ("repoKey", serde_json::json!({ "repoId": id(1), "memberId": id(2), "epoch": 0, "recipientKeyId": 4, "senderKeyId": 4, "wrapped": bytes(7, 64) })),
        ],
        "forge-collab" => vec![
            ("issue", serde_json::json!({ "repoId": id(1), "number": 1, "title": "It breaks", "body": "Steps…" })),
            ("issue", serde_json::json!({ "repoId": id(1), "number": 2, "enc": bytes(1, 64), "epoch": 0 })),
            ("issue", serde_json::json!({ "repoId": id(1), "number": 3, "title": "imported", "imported": { "author": "octocat", "createdAt": 1, "url": "https://github.com/o/r/issues/3" } })),
            ("patch", serde_json::json!({ "repoId": id(1), "number": 1, "title": "Fix", "baseRefNameHash": bytes(9, 32), "baseRefName": "refs/heads/main", "sourceRepoId": id(3), "sourceRefNameHash": bytes(8, 32), "sourceRefName": "refs/heads/fix", "headOid": bytes(1, 20), "patchManifestHash": bytes(4, 32) })),
            ("comment", serde_json::json!({ "repoId": id(1), "targetId": id(5), "body": "LGTM", "commitOid": bytes(1, 20), "path": "src/main.rs", "line": 10, "side": 1 })),
            ("review", serde_json::json!({ "repoId": id(1), "patchId": id(5), "verdict": 1, "commitOid": bytes(1, 20), "body": "ok" })),
            ("event", serde_json::json!({ "repoId": id(1), "targetId": id(5), "targetNumber": 1, "kind": 3, "oid": bytes(1, 20) })),
            ("checkRun", serde_json::json!({ "repoId": id(1), "headOid": bytes(1, 20), "name": "ci/test", "status": "completed", "conclusion": "success", "detailsUrl": "https://ci.example/1", "summary": "12 passed" })),
            ("webhook", serde_json::json!({ "repoId": id(1), "hookId": bytes(3, 32), "url": "https://relay.example/hook", "events": ["push", "issue"], "relayIdentityId": id(6), "relayKeyId": 4, "senderKeyId": 4, "secret": bytes(2, 48), "disabled": false })),
            ("profile", serde_json::json!({ "displayName": "pasta", "bio": "hi", "links": ["https://dash.org"] })),
            ("star", serde_json::json!({ "repoId": id(1) })),
            ("follow", serde_json::json!({ "identityId": id(2) })),
        ],
        _ => vec![],
    }
}

/// Documents the schema must refuse, each for one reason.
fn bad_documents(contract: &str) -> Vec<(&'static str, &'static str, Json)> {
    let id = |b: u8| Json::Array(vec![Json::from(b); 32]);
    let bytes = |b: u8, n: usize| Json::Array(vec![Json::from(b); n]);
    // 1300 four-byte characters: within maxLength 5120, over maxBytes 5120
    let wide = "\u{1F600}".repeat(1300);
    match contract {
        "forge-core" => vec![
            ("repo", "uppercase name", serde_json::json!({ "name": "Dash", "visibility": "public" })),
            ("repo", "name over 63", serde_json::json!({ "name": "a".repeat(64), "visibility": "public" })),
            ("repo", "unknown visibility", serde_json::json!({ "name": "x", "visibility": "internal" })),
            ("maintainer", "short member id", serde_json::json!({ "repoId": id(1), "memberId": bytes(2, 31) })),
            ("refUpdate", "missing repoId", serde_json::json!({ "refNameHash": bytes(9, 32), "refName": "refs/heads/main", "newOid": bytes(1, 20) })),
            ("refUpdate", "enc without epoch", serde_json::json!({ "repoId": id(1), "refNameHash": bytes(9, 32), "newOid": bytes(1, 20), "enc": bytes(1, 64) })),
            ("chunk", "d0 over 4900", serde_json::json!({ "repoId": id(1), "packHash": bytes(4, 32), "seq": 0, "d0": bytes(6, 4901) })),
            ("repoKey", "wrapped under 32", serde_json::json!({ "repoId": id(1), "memberId": id(2), "epoch": 0, "recipientKeyId": 4, "senderKeyId": 4, "wrapped": bytes(7, 16) })),
        ],
        "forge-collab" => vec![
            ("issue", "number 0", serde_json::json!({ "repoId": id(1), "number": 0, "title": "t" })),
            ("issue", "body over maxBytes", serde_json::json!({ "repoId": id(1), "number": 1, "title": "t", "body": wide })),
            ("issue", "enc without epoch", serde_json::json!({ "repoId": id(1), "number": 1, "enc": bytes(1, 64) })),
            ("event", "missing targetNumber", serde_json::json!({ "repoId": id(1), "targetId": id(5), "kind": 1 })),
            ("checkRun", "unknown status", serde_json::json!({ "repoId": id(1), "headOid": bytes(1, 20), "name": "ci", "status": "done" })),
            ("star", "extra property", serde_json::json!({ "repoId": id(1), "note": "x" })),
        ],
        _ => vec![],
    }
}
