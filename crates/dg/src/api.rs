//! `dg api query`: a raw document query against a Forge contract (or DPNS), verified against
//! its Platform proof like every other read, printed as JSON (`gh api`'s shape: the data, no
//! table). For scripts and debugging: the where-clauses must match one of the type's indexes,
//! as Drive requires; a query no index serves is refused by the node, and said so.
//!
//! ```text
//! dg api query core repo '[["$ownerId","==","7K1E…"]]' --order '[["name","asc"]]' --limit 5
//! dg api query collab issue '[["repoId","==","Hi1Q…"]]' --count
//! dg api query dpns domain '[["records.identity","==","7K1E…"]]'
//! ```
//!
//! Operands are typed from the contract's schema: an identifier is base58, a byte array hex, an
//! integer a JSON number. Output values are typed the same way.

use anyhow::{Context as _, Result};
use serde_json::{json, Map, Value};

use forge_core::platform::{
    encode_identifier, FetchedDocument, FieldValue, LoadedContract, PropertyKind, QueryFilter,
    QueryOp, QueryOrder,
};
use forge_core::user_error::{codes, UserError};

use crate::context::Ctx;
use crate::ApiCommand;

/// The most rows `--all` reads (a guard against reading a whole contract by accident).
const ALL_MAX: usize = 10_000;

/// Dispatch an `api` subcommand.
pub async fn run(ctx: &Ctx, cmd: &ApiCommand) -> Result<()> {
    match cmd {
        ApiCommand::Query(a) => query(ctx, a).await,
    }
}

/// The contract id `name` stands for: `core`, `collab`, `community`, `dpns`, or an id.
fn contract_id(client: &forge_core::platform::PlatformClient, name: &str) -> Result<String> {
    let forge = || client.target().require_v2();
    Ok(match name {
        "core" => forge()?.core.clone(),
        "collab" => forge()?.collab.clone(),
        "community" => forge()?.community.clone(),
        "dpns" => forge_core::platform::identity::DPNS_CONTRACT_ID.to_string(),
        id => {
            forge_core::platform::decode_identifier(id).map_err(|_| {
                usage(format!(
                    "{id:?} is no contract: use core, collab, community, dpns or a contract id"
                ))
            })?;
            id.to_string()
        }
    })
}

fn usage(msg: String) -> anyhow::Error {
    UserError::new(codes::USAGE, msg)
        .fix("`dg api query --help` shows the syntax")
        .into()
}

/// A where-clause operator as JSON spells it (the web SDK's spelling).
fn op_of(op: &str) -> Option<QueryOp> {
    Some(match op {
        "==" | "=" => QueryOp::Eq,
        ">" => QueryOp::Gt,
        ">=" => QueryOp::Gte,
        "<" => QueryOp::Lt,
        "<=" => QueryOp::Lte,
        "startsWith" => QueryOp::StartsWith,
        "in" => QueryOp::In,
        _ => return None,
    })
}

/// `v` as an operand for `property` (`kind`).
fn operand(kind: PropertyKind, property: &str, v: &Value) -> Result<FieldValue> {
    let bad = || usage(format!("{property}: {v} is not a value of this property"));
    Ok(match (kind, v) {
        (_, Value::Array(items)) => FieldValue::List(
            items
                .iter()
                .map(|i| operand(kind, property, i))
                .collect::<Result<_>>()?,
        ),
        (PropertyKind::Identifier, Value::String(s)) => {
            FieldValue::identifier(forge_core::platform::decode_identifier(s).map_err(|_| bad())?)
        }
        (PropertyKind::Bytes, Value::String(s)) => {
            let bytes = hex::decode(s).map_err(|_| bad())?;
            match <[u8; 32]>::try_from(bytes.as_slice()) {
                Ok(b32) => FieldValue::bytes32(b32),
                Err(_) => FieldValue::bytes(bytes),
            }
        }
        (PropertyKind::Integer, Value::Number(n)) => match (n.as_u64(), n.as_i64()) {
            (Some(u), _) => FieldValue::integer(u),
            (None, Some(i)) => FieldValue::Signed(i),
            _ => return Err(bad()),
        },
        (PropertyKind::Text, Value::String(s)) => FieldValue::text(s.clone()),
        (PropertyKind::Bool, Value::Bool(b)) => FieldValue::boolean(*b),
        _ => return Err(bad()),
    })
}

/// The where-clauses of `json` (`[["field", "op", value], …]`).
fn filters(contract: &LoadedContract, doc_type: &str, json: &str) -> Result<Vec<QueryFilter>> {
    let clauses: Vec<(String, String, Value)> = serde_json::from_str(json).map_err(|e| {
        usage(format!(
            "the where-clauses are not [[field, op, value], …]: {e}"
        ))
    })?;
    clauses
        .into_iter()
        .map(|(field, op, value)| {
            let op = op_of(&op).ok_or_else(|| {
                usage(format!(
                    "{op:?} is no operator: ==, >, >=, <, <=, startsWith or in"
                ))
            })?;
            let kind = contract
                .property_kind(doc_type, &field)
                .ok_or_else(|| usage(format!("{doc_type} has no property {field:?}")))?;
            Ok(QueryFilter {
                value: operand(kind, &field, &value)?,
                field,
                op,
            })
        })
        .collect()
}

/// The order clauses of `json` (`[["field", "asc"|"desc"], …]`).
fn orders(json: &str) -> Result<Vec<QueryOrder>> {
    let clauses: Vec<(String, String)> = serde_json::from_str(json).map_err(|e| {
        usage(format!(
            "--order is not [[field, \"asc\"|\"desc\"], …]: {e}"
        ))
    })?;
    clauses
        .into_iter()
        .map(|(field, dir)| match dir.as_str() {
            "asc" => Ok(QueryOrder::asc(field)),
            "desc" => Ok(QueryOrder::desc(field)),
            other => Err(usage(format!("{other:?} is no direction: asc or desc"))),
        })
        .collect()
}

/// A field value as JSON: identifiers base58, bytes hex, objects and lists recursively.
fn value_json(kind: Option<PropertyKind>, v: &FieldValue) -> Value {
    match v {
        FieldValue::Identifier(b) => json!(encode_identifier(*b)),
        FieldValue::Bytes32(b) if kind == Some(PropertyKind::Identifier) => {
            json!(encode_identifier(*b))
        }
        FieldValue::Bytes32(b) => json!(hex::encode(b)),
        FieldValue::Bytes(b) => json!(hex::encode(b)),
        FieldValue::Integer(n) | FieldValue::Uint64(n) => json!(n),
        FieldValue::Signed(n) => json!(n),
        FieldValue::Text(s) => json!(s),
        FieldValue::Bool(b) => json!(b),
        FieldValue::Object(m) => Value::Object(
            m.iter()
                .map(|(k, v)| (k.clone(), value_json(None, v)))
                .collect(),
        ),
        FieldValue::List(items) => {
            Value::Array(items.iter().map(|i| value_json(kind, i)).collect())
        }
    }
}

/// A document as JSON: its system fields, then its properties.
fn doc_json(contract: &LoadedContract, doc_type: &str, d: &FetchedDocument) -> Value {
    let mut m = Map::new();
    m.insert("$id".into(), json!(d.id));
    m.insert("$ownerId".into(), json!(d.owner_id));
    if let Some(at) = d.created_at {
        m.insert("$createdAt".into(), json!(at));
    }
    if let Some(h) = d.created_at_block_height {
        m.insert("$createdAtBlockHeight".into(), json!(h));
    }
    if let Some(h) = d.updated_at_block_height {
        m.insert("$updatedAtBlockHeight".into(), json!(h));
    }
    if let Some(r) = d.revision {
        m.insert("$revision".into(), json!(r));
    }
    for (k, v) in &d.fields {
        m.insert(
            k.clone(),
            value_json(contract.property_kind(doc_type, k), v),
        );
    }
    Value::Object(m)
}

async fn query(ctx: &Ctx, a: &crate::ApiQueryArgs) -> Result<()> {
    if !(1..=100).contains(&a.limit) {
        return Err(usage("--limit is 1-100 (use --all for every row)".into()));
    }
    let client = ctx.connect().await?;
    let id = contract_id(&client, &a.contract)?;
    let contract = client
        .fetch_contract(&id)
        .await
        .with_context(|| format!("fetching contract {id}"))?;
    if !contract.has_document_type(&a.doc_type) {
        let mut names = contract.document_type_names();
        names.sort();
        return Err(UserError::new(
            codes::NOT_FOUND,
            format!(
                "contract {} has no document type {:?}",
                a.contract, a.doc_type
            ),
        )
        .cause(format!("its types: {}", names.join(", ")))
        .into());
    }
    let filters = filters(
        &contract,
        &a.doc_type,
        a.where_json.as_deref().unwrap_or("[]"),
    )?;
    if a.count {
        let n = client
            .count_documents(&contract, &a.doc_type, &filters)
            .await?;
        crate::errors::print_json(&json!({ "count": n }));
        return Ok(());
    }
    let order = orders(a.order.as_deref().unwrap_or("[]"))?;
    let docs = if a.all {
        let mut all = client
            .query_all_documents(&contract, &a.doc_type, &filters, &order)
            .await?;
        if all.len() > ALL_MAX {
            eprintln!(
                "note: {} rows match; the first {ALL_MAX} are printed (narrow the clauses, or page with --start-after)",
                all.len()
            );
            all.truncate(ALL_MAX);
        }
        all
    } else {
        client
            .query_documents(
                &contract,
                &a.doc_type,
                &filters,
                &order,
                a.limit,
                a.start_after.as_deref(),
            )
            .await?
    };
    let rows: Vec<Value> = docs
        .iter()
        .map(|d| doc_json(&contract, &a.doc_type, d))
        .collect();
    crate::errors::print_json(&Value::Array(rows));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{op_of, operand, orders, value_json};
    use forge_core::platform::{FieldValue, PropertyKind, QueryOp};
    use serde_json::json;

    /// Operands are typed from the schema: base58 identifiers, hex bytes (32 of them as
    /// `bytes32`), numbers, lists for `in`; a mismatch is a usage error.
    #[test]
    fn operands_are_typed_by_the_property() {
        let id = "7K1EkGWmXmYBcrQFzNE5P2iv4ww5pRkUY8nNrLVixKkK";
        assert!(matches!(
            operand(PropertyKind::Identifier, "repoId", &json!(id)).unwrap(),
            FieldValue::Identifier(_)
        ));
        assert!(matches!(
            operand(PropertyKind::Bytes, "h", &json!("ab".repeat(32))).unwrap(),
            FieldValue::Bytes32(_)
        ));
        assert!(matches!(
            operand(PropertyKind::Bytes, "h", &json!("abcd")).unwrap(),
            FieldValue::Bytes(_)
        ));
        assert!(matches!(
            operand(PropertyKind::Integer, "n", &json!(3)).unwrap(),
            FieldValue::Integer(3)
        ));
        assert!(matches!(
            operand(PropertyKind::Integer, "n", &json!([1, 2])).unwrap(),
            FieldValue::List(_)
        ));
        assert!(operand(PropertyKind::Integer, "n", &json!("3")).is_err());
        assert!(operand(PropertyKind::Identifier, "repoId", &json!("nope")).is_err());
        assert_eq!(op_of("startsWith"), Some(QueryOp::StartsWith));
        assert_eq!(op_of("!="), None);
        assert!(orders(r#"[["name","asc"],["$createdAt","desc"]]"#).is_ok());
        assert!(orders(r#"[["name","up"]]"#).is_err());
        assert_eq!(
            value_json(
                Some(PropertyKind::Identifier),
                &FieldValue::bytes32([1; 32])
            ),
            json!(forge_core::platform::encode_identifier([1; 32]))
        );
        assert_eq!(
            value_json(None, &FieldValue::bytes(vec![0xab])),
            json!("ab")
        );
    }
}
