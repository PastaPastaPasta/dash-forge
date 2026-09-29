//! Offline validation of the forge-v2 data contracts against Dash Platform protocol 14.
//!
//!   cargo run --manifest-path tools/contract-validate/Cargo.toml -- \
//!       --vectors forge-contracts/vectors/rc1 \
//!       forge-contracts/contracts/forge-core.json \
//!       forge-contracts/contracts/forge-collab.json [--previous <the forge-collab.json that is registered>] \
//!       forge-contracts/contracts/forge-community.json
//!
//! `--previous <file>` after a contract also reports whether a `DataContractUpdate` from that
//! (registered) schema to this one passes rs-dpp's `validate_update` under protocol 14.
//! `--expect-update <file>` is the same check made a failure when the update is refused: CI runs
//! it for forge-core, which only ever changes by an in-place update (platform-parity-spec §6).
//!
//! For each contract, in order, this:
//!   1. derives the contract id the deploy script will get (placeholder owner, nonce 1) and, for
//!      a later contract, substitutes the ids of the earlier ones for their placeholders
//!      (`FORGE_CORE_CONTRACT_ID`), exactly as `forge-contracts/scripts/deploy-v2.mjs` does;
//!   2. parses it with FULL validation under `PlatformVersion::get(14)` — the meta-schema, every
//!      document type, index, `refersTo`/`ownerRefersTo`/`findBy`/`where`, `immutable`, `encryptedFor`,
//!      `maxBytes`, typed-array and `indexOnly` rule the create transition's action transform
//!      runs on a node;
//!   3. runs the create transition's state-free basic-structure rules (version, keywords,
//!      description, contract-group registration and memberships);
//!   4. runs the registration-time reference checks on every `refersTo` leaf (a port of
//!      drive-abci `validate_data_contract_references` v0), resolving references into another
//!      contract against the earlier contracts held in memory, which a node would fetch from state;
//!   5. with `--vectors <dir>`, judges the contract's document vectors (`<dir>/<name>.json`,
//!      forge-contracts/vectors/rc1) against the parsed types (JSON schema, maxBytes and every
//!      `propertyConstraints` rule that reads no total, time or height: the document-property
//!      validation every create and replace runs): each accepted case must pass and each refused
//!      one must fail for the reason it names;
//!   6. serializes the contract and a signed-shape `DataContractCreateTransition` v1 and reports
//!      both sizes against `max_state_transition_size` and the registration fee.
//!
//! What cannot be checked offline, and is left to registration on a live network: that the
//! referenced contract exists in state (it is the in-memory one here), that the signer's identity
//! exists and holds the balance, and the contract group's state rules (group not already
//! registered, signer owns or administers the group a membership names).

use anyhow::{anyhow, bail, Context, Result};
use dpp::block::block_info::BlockInfo;
use dpp::contract_group::{
    generate_contract_group_id, ContractGroupMember, ContractGroupMembership,
    ContractGroupRegistration,
};
use dpp::data_contract::accessors::v0::{DataContractV0Getters, DataContractV0Setters};
use dpp::data_contract::accessors::v1::DataContractV1Getters;
use dpp::data_contract::conversion::json::DataContractJsonConversionMethodsV0;
use dpp::data_contract::document_type::accessors::{DocumentTypeV0Getters, DocumentTypeV2Getters};
use dpp::data_contract::document_type::property_constraints::DocumentSystemValues;
use dpp::data_contract::document_type::{
    is_referenced_system_agreement_property, is_referring_system_agreement_property, is_transient,
    DocumentPropertyReferenceTarget, DocumentPropertyType, DocumentTypeRef, PropertyReference,
    ReferenceHolder,
};
use dpp::data_contract::serialized_version::DataContractInSerializationFormat;
use dpp::data_contract::validate_document::DataContractDocumentValidationMethodsV0;
use dpp::data_contract::validate_update::DataContractUpdateValidationMethodsV0;
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
    /// `--previous <file>` after a contract: the schema registered before, to report whether a
    /// DataContractUpdate from it to this one passes the protocol's update rules.
    previous: Option<PathBuf>,
    /// `--expect-update` instead of `--previous`: a refused update fails the run.
    expect_update: bool,
}

fn main() -> Result<()> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut vectors: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--vectors" {
            vectors = Some(PathBuf::from(
                args.next().context("--vectors needs a directory")?,
            ));
            continue;
        }
        if arg == "--previous" || arg == "--expect-update" {
            let previous = args.next().with_context(|| format!("{arg} needs a file"))?;
            let last = entries
                .last_mut()
                .with_context(|| format!("{arg} must follow the contract it applies to"))?;
            last.previous = Some(PathBuf::from(previous));
            last.expect_update = arg == "--expect-update";
            continue;
        }
        entries.push(Entry {
            path: PathBuf::from(arg),
            registers_group: entries.is_empty(),
            previous: None,
            expect_update: false,
        });
    }
    if entries.is_empty() {
        bail!("usage: contract-validate [--vectors <dir>] <forge-core.json> [--expect-update <registered-forge-core.json>] [<forge-collab.json> [--previous <registered-forge-collab.json>]] [<forge-community.json> ...]");
    }

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
        match validate_one(
            entry,
            &name,
            nonce,
            owner,
            group_id,
            &known,
            &placeholders,
            vectors.as_deref(),
            pv,
            limit,
        ) {
            Ok(contract) => {
                placeholders.insert(
                    placeholder_for(&name),
                    contract
                        .id()
                        .to_string(dpp::platform_value::string_encoding::Encoding::Base58),
                );
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
    vectors: Option<&std::path::Path>,
    pv: &PlatformVersion,
    limit: u64,
) -> Result<DataContract> {
    // (2) full structural validation, as the node's action transform runs it
    let contract = load_contract(&entry.path, nonce, owner, placeholders, pv)?;
    println!(
        "   parse (full validation, protocol {}): ok",
        pv.protocol_version
    );

    // (2b) optional: would a DataContractUpdate from the previously registered schema to this
    // one pass the protocol's update rules? With `--previous` informational (the answer decides
    // between updating the registered contract in place and registering a new one); with
    // `--expect-update` a refusal fails the contract.
    if let Some(previous) = &entry.previous {
        let old = load_contract(previous, nonce, owner, placeholders, pv)?;
        let mut updated = contract.clone();
        updated.set_version(2);
        let result = old
            .validate_update(&updated, &BlockInfo::default(), pv)
            .map_err(|e| anyhow!("{e}"))?;
        if result.is_valid() {
            println!(
                "   update from {}: ALLOWED (DataContractUpdate v1 -> v2)",
                previous.display()
            );
        } else {
            println!(
                "   update from {}: REFUSED by validate_update:",
                previous.display()
            );
            for error in &result.errors {
                println!("     - {error}");
            }
            if entry.expect_update {
                bail!(
                    "{name} must stay an in-place update of {}, and the update rules refuse it",
                    previous.display()
                );
            }
        }
    }

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
    let serialization: DataContractInSerializationFormat = (&contract)
        .try_into_platform_versioned(pv)
        .map_err(|e| anyhow!("{e}"))?;
    let memberships = vec![ContractGroupMembership {
        contract_group_id: group_id,
        member: ContractGroupMember::Contract,
    }];
    let registration = entry.registers_group.then(|| ContractGroupRegistration {
        admins: Default::default(),
        name: Some("dash-forge".to_string()),
        description: Some(
            "Dash Forge v2: forge-core, forge-collab and forge-community".to_string(),
        ),
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
    let (local, foreign, keys) = registration_references(&contract, known, pv)?;
    println!(
        "   registration reference checks: {local} same-contract + {foreign} cross-contract document leaves, {keys} key references, ok"
    );

    // (5) the document vectors: every accepted case passes, every refused one fails for the
    // reason it names. Judged as a client pre-check judges them: the owner is the deployer, and a
    // rule reading a time, a height or a total is not judged (it needs the block or state).
    if let Some(dir) = vectors {
        let cases = read_cases(&dir.join(format!("{name}.json")))?;
        let mut wrong = Vec::new();
        for case in &cases {
            let system = DocumentSystemValues::owned_by(case.owner.unwrap_or(owner));
            let result = contract
                .validate_document_properties(&case.doc_type, case_value(&case.doc)?, &system, pv)
                .map_err(|e| anyhow!("{} ({}): {e}", case.name, case.doc_type))?;
            let reason = result.errors.first().map(refusal_reason);
            let fine = match (case.expect.as_str(), &reason) {
                ("ok", None) => true,
                ("refused", Some(got)) => case.why.as_deref().is_none_or(|want| want == got),
                _ => false,
            };
            if !fine {
                wrong.push(format!(
                    "[{}] {} ({}): expected {}{}, got {}",
                    case.item,
                    case.name,
                    case.doc_type,
                    case.expect,
                    case.why
                        .as_deref()
                        .map(|w| format!(" by {w}"))
                        .unwrap_or_default(),
                    match (&reason, result.errors.first()) {
                        (Some(r), Some(e)) => format!("refused by {r}: {e}"),
                        _ => "accepted".to_string(),
                    }
                ));
            }
        }
        if !wrong.is_empty() {
            bail!(
                "{} of {} document vectors disagree:\n     {}",
                wrong.len(),
                cases.len(),
                wrong.join("\n     ")
            );
        }
        let accepted = cases.iter().filter(|c| c.expect == "ok").count();
        println!(
            "   document vectors: {accepted} accepted, {} refused for the named reason",
            cases.len() - accepted
        );
    }

    let contract_bytes = {
        use dpp::serialization::PlatformSerializableWithPlatformVersion;
        contract
            .serialize_to_bytes_with_platform_version(pv)
            .map_err(|e| anyhow!("{e}"))?
            .len()
    };
    // Round-trip the serialization format through a full-validation parse: the node builds the
    // contract it stores from the transition's DataContractInSerializationFormat this way
    {
        let format: DataContractInSerializationFormat = (&contract)
            .try_into_platform_versioned(pv)
            .map_err(|e| anyhow!("{e}"))?;
        let reparsed = DataContract::try_from_platform_versioned(format, true, &mut vec![], pv)
            .map_err(|e| anyhow!("serialized form does not re-parse with full validation: {e}"))?;
        if reparsed != contract {
            bail!("serialized form re-parses to a different contract");
        }
    }
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

/// Read a contract file, substitute the ids of earlier contracts for their placeholders, give it
/// the id the deploy script derives (placeholder owner, `nonce`) and parse it with full validation.
fn load_contract(
    path: &std::path::Path,
    nonce: u64,
    owner: Identifier,
    placeholders: &BTreeMap<String, String>,
    pv: &PlatformVersion,
) -> Result<DataContract> {
    let mut text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    for (placeholder, id) in placeholders {
        text = text.replace(placeholder, id);
    }
    if let Some(unresolved) = ["_CONTRACT_ID\""].iter().find(|p| text.contains(*p)) {
        bail!("an id placeholder (…{unresolved}) is left unresolved: list the contract it names first");
    }
    let mut json: Json = serde_json::from_str(&text).context("parsing JSON")?;

    let contract_id = DataContract::generate_data_contract_id_v0(owner, nonce);
    json["id"] =
        Json::String(contract_id.to_string(dpp::platform_value::string_encoding::Encoding::Base58));
    json["ownerId"] =
        Json::String(owner.to_string(dpp::platform_value::string_encoding::Encoding::Base58));
    DataContract::from_json(json, true, pv).map_err(|e| anyhow!("{e}"))
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
/// `where` pair (the parsed model still calls it the property agreement) to this step, so it runs
/// on every leaf, not only foreign ones.
fn registration_references(
    contract: &DataContract,
    known: &[DataContract],
    pv: &PlatformVersion,
) -> Result<(usize, usize, usize)> {
    let (mut local, mut foreign, mut keys) = (0, 0, 0);
    for (type_name, document_type) in contract.document_types() {
        let dt = document_type.as_ref();
        for (holder, reference) in dt.reference_declarations() {
            let reference_property = match holder {
                ReferenceHolder::Property(path) => Some(path),
                ReferenceHolder::Owner | ReferenceHolder::Creator => None,
            };
            let target = match reference {
                // A revealed property (a `findBy` function's param, platform#5041) is checked
                // like an identifier's, as drive-abci does
                PropertyReference::Value(t)
                | PropertyReference::Revealed(t)
                | PropertyReference::Elements { target: t, .. } => t,
                PropertyReference::KeyId(key_ref) => {
                    check_key_id_reference(contract, dt, holder.path(), key_ref, pv)
                        .map_err(|e| anyhow!("{type_name}.{}: {e} (40125)", holder.path()))?;
                    keys += 1;
                    continue;
                }
            };
            for (leaf_path, leaf) in target.leaves_with_paths() {
                let at = if leaf_path.is_empty() {
                    format!("{type_name}.{}", holder.path())
                } else {
                    format!("{type_name}.{}.{leaf_path}", holder.path())
                };
                if let DocumentPropertyReferenceTarget::IdentityPublicKey {
                    key_id_property, ..
                } = leaf
                {
                    check_identity_key_leaf(dt, reference_property, key_id_property)
                        .map_err(|e| anyhow!("{at}: {e} (40125)"))?;
                    keys += 1;
                    continue;
                }
                let Some(decl) = leaf.as_any_document_reference() else {
                    continue;
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
                    .ok_or_else(|| {
                        anyhow!(
                            "{at}: {target_id} has no document type {} (40121)",
                            decl.document_type_name
                        )
                    })?;
                check_leaf(
                    contract,
                    dt,
                    reference_property,
                    referenced_contract,
                    referenced,
                    leaf,
                    &decl,
                    target_id != contract.id(),
                    &at,
                    pv,
                )?;
            }
        }
    }
    Ok((local, foreign, keys))
}

/// The identityPublicKey arm of drive-abci `validate_reference_target_declaration_v0`: the key
/// id property named by `keyIdProperty` exists, is an integer, carries no key reference of its
/// own, and is not stored while the identity property carrying the reference is transient.
fn check_identity_key_leaf(
    dt: DocumentTypeRef,
    reference_property: Option<&str>,
    key_id_property: &str,
) -> Result<()> {
    let Some(key_property) = dt.flattened_properties().get(key_id_property) else {
        bail!("key id property {key_id_property} is not defined");
    };
    if !key_property.property_type.is_integer() {
        bail!("key id property {key_id_property} must be an integer");
    }
    if matches!(
        key_property.property_type,
        DocumentPropertyType::KeyIdWithReference(_)
    ) {
        bail!("key id property {key_id_property} carries its own identityPublicKey reference");
    }
    if let Some(identity_path) = reference_property {
        if is_transient(dt, identity_path) && !is_transient(dt, key_id_property) {
            bail!("the key id is stored but its identity property is transient");
        }
    }
    Ok(())
}

/// The KeyId arm of drive-abci `validate_data_contract_references_v0`: a key id reference that
/// names its identity by `$creatorId` needs a type recording creator ids, and one that names a
/// property needs an identifier property without a key reference of its own, not transient
/// while the key id is stored.
fn check_key_id_reference(
    contract: &DataContract,
    dt: DocumentTypeRef,
    key_id_path: &str,
    key_ref: &dpp::data_contract::document_type::KeyIdReference,
    pv: &PlatformVersion,
) -> Result<()> {
    use dpp::data_contract::document_type::KeyReferenceIdentityProperty as Who;
    match &key_ref.identity_property {
        Who::OwnerId => Ok(()),
        Who::CreatorId => {
            let records = dt
                .should_use_creator_id(
                    contract.system_version_type(),
                    contract.config().version(),
                    pv,
                )
                .map_err(|e| anyhow!("{e}"))?;
            if !records {
                bail!("identityProperty $creatorId needs a type that records creator ids");
            }
            Ok(())
        }
        Who::Property(identity_path) => {
            let Some(identity) = dt.flattened_properties().get(identity_path) else {
                bail!("identity property {identity_path} is not defined");
            };
            match &identity.property_type {
                DocumentPropertyType::IdentifierWithReference(
                    DocumentPropertyReferenceTarget::IdentityPublicKey { .. },
                ) => bail!(
                    "identity property {identity_path} carries its own identityPublicKey reference"
                ),
                DocumentPropertyType::Identifier
                | DocumentPropertyType::IdentifierWithReference(_) => {}
                _ => bail!("identity property {identity_path} must be an identifier"),
            }
            if is_transient(dt, identity_path) && !is_transient(dt, key_id_path) {
                bail!("the key id is stored but identity property {identity_path} is transient");
            }
            Ok(())
        }
    }
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
    let deletable = referenced.documents_can_be_deleted()
        || referenced.documents_can_be_deleted_by_moderators();
    if decl.permanent && deletable {
        bail!(
            "{at}: permanentDocument names deletable type {} (40122)",
            decl.document_type_name
        );
    }
    if !decl.permanent && !deletable {
        bail!(
            "{at}: deletableDocument names non-deletable type {} (40131)",
            decl.document_type_name
        );
    }
    // the parse already ran the referenced side of same-contract lookups and lists
    if is_foreign {
        if let Some(lookup) = decl.lookup {
            if let Some(reason) = lookup.referenced_side_error(declaring, referenced) {
                bail!(
                    "{at}: findBy {{{}}} invalid (40137): {reason}",
                    lookup.find_by_names()
                );
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
        let invalid = |why: &str| {
            anyhow!("{at}: agreement {referring} = {referenced_prop} invalid (40126): {why}")
        };
        if Some(referring.as_str()) == reference_property {
            return Err(invalid(
                "the referring property cannot be the reference property itself",
            ));
        }
        let referring_type = if referring.starts_with('$') {
            if !is_referring_system_agreement_property(referring) {
                return Err(invalid(
                    "the referring side must be a schema property or $ownerId",
                ));
            }
            &writer
        } else {
            &declaring
                .flattened_properties()
                .get(referring)
                .ok_or_else(|| {
                    invalid("the declaring type does not define the referring property")
                })?
                .property_type
        };
        if referenced_prop.starts_with('$') {
            if !is_referenced_system_agreement_property(referenced_prop) {
                return Err(invalid(
                    "only $ownerId, $creatorId and $id may be agreed with",
                ));
            }
            if !matches!(
                referring_type,
                DocumentPropertyType::Identifier | DocumentPropertyType::IdentifierWithReference(_)
            ) {
                return Err(invalid("the referring property must be an identifier"));
            }
            if referenced_prop == "$creatorId"
                && !referenced
                    .should_use_creator_id(
                        referenced_contract.system_version_type(),
                        referenced_contract.config().version(),
                        pv,
                    )
                    .map_err(|e| anyhow!("{e}"))?
            {
                return Err(invalid("the referenced type does not record $creatorId"));
            }
            continue;
        }
        let theirs = referenced
            .flattened_properties()
            .get(referenced_prop)
            .ok_or_else(|| {
                invalid("the referenced type does not define the referenced property")
            })?;
        if is_transient(referenced, referenced_prop) {
            return Err(invalid("the referenced property is transient"));
        }
        if matches!(
            referring_type,
            DocumentPropertyType::Object(_) | DocumentPropertyType::TypedArray(_)
        ) || matches!(
            theirs.property_type,
            DocumentPropertyType::Object(_) | DocumentPropertyType::TypedArray(_)
        ) {
            return Err(invalid("agreement properties must be single plain values"));
        }
        if referring_type.value_kind() != theirs.property_type.value_kind() {
            return Err(invalid("the two properties hold different kinds of value"));
        }
    }
    Ok(())
}

/// The accept/refuse document vectors of one contract (`forge-contracts/vectors/rc1/<name>.json`,
/// written by `forge-contracts/schema/vectors.py`): `{item, name, type, expect, why?, owner?, doc}`,
/// where `doc` writes an identifier as `{"$id": n}` (32 bytes of n) or `{"$id": "<base58>"}`, and
/// a byte array as `{"$b": [fill, len]}` or `{"$hex": "..."}`.
struct Case {
    item: String,
    name: String,
    doc_type: String,
    expect: String,
    why: Option<String>,
    /// The signer (`"owner"`: a byte or base58), 0x07 * 32 when absent.
    owner: Option<Identifier>,
    doc: Json,
}

fn read_cases(path: &std::path::Path) -> Result<Vec<Case>> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let list: Vec<Json> =
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    list.into_iter()
        .map(|c| {
            let field = |k: &str| {
                c[k].as_str()
                    .map(str::to_string)
                    .with_context(|| format!("{}: a case without {k}", path.display()))
            };
            Ok(Case {
                item: field("item")?,
                name: field("name")?,
                doc_type: field("type")?,
                expect: field("expect")?,
                why: c["why"].as_str().map(str::to_string),
                owner: c.get("owner").map(case_identifier).transpose()?,
                doc: c["doc"].clone(),
            })
        })
        .collect()
}

/// An identifier written as a byte `n` (32 bytes of n) or a base58 string.
fn case_identifier(j: &Json) -> Result<Identifier> {
    match j {
        Json::Number(n) => Ok(Identifier::from(
            [n.as_u64().context("an id byte")? as u8; 32],
        )),
        Json::String(s) => {
            Identifier::from_string(s, dpp::platform_value::string_encoding::Encoding::Base58)
                .map_err(|e| anyhow!("{s}: {e}"))
        }
        other => bail!("an identifier is a byte or a base58 string, not {other}"),
    }
}

/// A vector document as a platform value: `{"$id": n | "<base58>"}` is an identifier,
/// `{"$b": [fill, len]}` and `{"$hex": "..."}` are byte arrays.
fn case_value(j: &Json) -> Result<dpp::platform_value::Value> {
    use dpp::platform_value::Value;
    Ok(match j {
        Json::Object(m) if m.contains_key("$b") => {
            let a = m["$b"].as_array().context("$b is [fill, len]")?;
            let fill = a[0].as_u64().context("$b fill")? as u8;
            Value::Bytes(vec![fill; a[1].as_u64().context("$b len")? as usize])
        }
        Json::Object(m) if m.contains_key("$hex") => {
            let hex = m["$hex"].as_str().context("$hex is a string")?;
            let byte = |i: usize| {
                u8::from_str_radix(hex.get(i..i + 2).context("odd hex")?, 16)
                    .map_err(|e| anyhow!("{hex}: {e}"))
            };
            Value::Bytes((0..hex.len()).step_by(2).map(byte).collect::<Result<_>>()?)
        }
        Json::Object(m) if m.contains_key("$id") => {
            Value::Identifier(case_identifier(&m["$id"])?.to_buffer())
        }
        Json::Object(m) => Value::Map(
            m.iter()
                .map(|(k, v)| Ok((Value::Text(k.clone()), case_value(v)?)))
                .collect::<Result<_>>()?,
        ),
        Json::Array(a) => Value::Array(a.iter().map(case_value).collect::<Result<_>>()?),
        other => other.clone().into(),
    })
}

/// A refusal's reason as the vectors name it: the JSON Schema keyword, the broken
/// `propertyConstraints` rule, `maxBytes`, or the consensus error code.
fn refusal_reason(e: &dpp::consensus::ConsensusError) -> String {
    use dpp::consensus::basic::BasicError;
    use dpp::consensus::codes::ErrorWithCode;
    use dpp::consensus::ConsensusError;
    match e {
        ConsensusError::BasicError(BasicError::JsonSchemaError(j)) => j.keyword().to_string(),
        ConsensusError::BasicError(BasicError::DocumentPropertyConstraintViolatedError(c)) => {
            c.constraint().to_string()
        }
        ConsensusError::BasicError(BasicError::DocumentPropertyMaxBytesExceededError(_)) => {
            "maxBytes".to_string()
        }
        other => other.code().to_string(),
    }
}
