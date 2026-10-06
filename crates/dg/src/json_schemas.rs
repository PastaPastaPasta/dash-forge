//! The `--json` schemas under `docs/schemas/` (written by `docs/schemas/generate.py`) against
//! dg itself:
//!
//! - every dg command is in the schema index, with a schema or a reason it prints no JSON, and
//!   the index names no command dg doesn't have;
//! - every schema compiles (JSON Schema draft 2020-12, its `common.schema.json` references
//!   resolved);
//! - the output of dg's own JSON builders, versioned as dg prints it, validates against the
//!   schema of the command that prints it.
//!
//! CI also runs `python3 docs/schemas/generate.py --check`, so a schema edited by hand without
//! its spec fails there.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use clap::{Command, CommandFactory};
use jsonschema::{Draft, JSONSchema};
use serde_json::{json, Value};

use crate::errors::{versioned, SCHEMA_VERSION};
use crate::Cli;

fn schemas_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/schemas/dg")
}

fn read(file: &str) -> Value {
    let p = schemas_dir().join(file);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// Every leaf command of dg's CLI, as its words (`issue view`).
fn leaves() -> BTreeSet<String> {
    fn walk(c: &Command, path: &mut Vec<String>, out: &mut BTreeSet<String>) {
        let subs: Vec<&Command> = c
            .get_subcommands()
            .filter(|s| s.get_name() != "help")
            .collect();
        if subs.is_empty() {
            out.insert(path.join(" "));
            return;
        }
        for s in subs {
            path.push(s.get_name().to_string());
            walk(s, path, out);
            path.pop();
        }
    }
    let mut out = BTreeSet::new();
    walk(&Cli::command(), &mut Vec::new(), &mut out);
    out
}

/// The schema of `file`, compiled with the shared definitions.
fn compile(file: &str) -> JSONSchema {
    let common = read("common.schema.json");
    let common_id = common["$id"].as_str().unwrap().to_string();
    JSONSchema::options()
        .with_draft(Draft::Draft202012)
        .with_document(common_id, common)
        .compile(&read(file))
        .unwrap_or_else(|e| panic!("{file} does not compile: {e}"))
}

/// `value` as dg prints it, checked against the schema of `command`.
fn assert_valid(command: &str, value: &Value) {
    let index = read("index.json");
    let file = index["commands"][command]
        .as_str()
        .unwrap_or_else(|| panic!("no schema for `dg {command}`"));
    let printed = versioned(value);
    let schema = compile(file);
    let why: Vec<String> = match schema.validate(&printed) {
        Ok(()) => Vec::new(),
        Err(errors) => errors
            .map(|e| format!("{} at {}", e, e.instance_path))
            .collect(),
    };
    assert!(
        why.is_empty(),
        "`dg {command} --json` does not match {file}:\n{}\n{printed:#}",
        why.join("\n")
    );
}

#[test]
fn every_command_is_in_the_index() {
    let index = read("index.json");
    assert_eq!(index["schemaVersion"], json!(SCHEMA_VERSION));
    let mut listed = BTreeSet::new();
    for key in ["commands", "noJson"] {
        for name in index[key].as_object().unwrap().keys() {
            listed.insert(name.clone());
        }
    }
    let commands = leaves();
    let missing: Vec<&String> = commands.difference(&listed).collect();
    let extra: Vec<&String> = listed.difference(&commands).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "docs/schemas/generate.py is out of step with dg's commands: add a schema (or a reason it \
         prints no JSON) for {missing:?}; remove {extra:?}; then run python3 docs/schemas/generate.py"
    );
}

#[test]
fn every_schema_compiles_and_carries_the_version() {
    let index = read("index.json");
    for (name, file) in index["commands"].as_object().unwrap() {
        let file = file.as_str().unwrap();
        compile(file);
        let schema = read(file);
        assert_eq!(
            schema["properties"]["schemaVersion"]["const"],
            json!(SCHEMA_VERSION),
            "{name}"
        );
    }
    compile("error.schema.json");
}

#[test]
fn printed_objects_carry_the_version_and_raw_reads_do_not_need_it() {
    assert_eq!(
        versioned(&json!({"a": 1}))["schemaVersion"],
        json!(SCHEMA_VERSION)
    );
    // An array (none of dg's commands prints one but `dg api`, raw) is printed as it is.
    assert_eq!(versioned(&json!([1, 2])), json!([1, 2]));
}

#[test]
fn an_error_matches_the_error_schema() {
    let u = forge_core::user_error::UserError::new(
        forge_core::user_error::codes::USAGE,
        "issue not created: the title is empty",
    )
    .cause("a title is required")
    .fix("pass --title");
    let printed = versioned(&u.to_json());
    let schema = compile("error.schema.json");
    let why: Vec<String> = match schema.validate(&printed) {
        Ok(()) => Vec::new(),
        Err(errors) => errors.map(|e| e.to_string()).collect(),
    };
    assert!(why.is_empty(), "{}\n{printed:#}", why.join("\n"));
}

#[test]
fn builders_match_their_commands_schemas() {
    assert_valid(
        "auth balance",
        &crate::fmt::balance_json(
            "4X5xgudNAwLhWEL3jgsisYszZXPnf33VbyaAqjbUB9Yi",
            123_456_789,
            "devnet",
        ),
    );
    let policy = forge_core::rules::review::Policy {
        required_approvals: 1,
        approver_role: 1,
        required_checks: vec!["build".into()],
        ..Default::default()
    };
    let shown = crate::repo_settings::policy_json(&policy);
    assert_valid(
        "repo policy show",
        &json!({ "repo": "o/r", "policy": shown, "note": "n" }),
    );
    assert_valid(
        "repo policy show",
        &json!({ "repo": "o/r", "policy": null, "note": "n" }),
    );
    let content = forge_core::rules::merge_check::MergeContent {
        verdict: forge_core::rules::merge_check::MergeVerdict::Squash,
        combined: vec!["src/a.rs".into()],
    };
    assert_valid(
        "pr verify",
        &json!({ "pr": 3, "merged": true, "mergeContent": crate::pr::verify::content_json(&"a".repeat(40), &content) }),
    );
    let cost = crate::fmt::cost_json(45_300_000, Some(25.0));
    assert_valid(
        "issue comment",
        &json!({ "status": "commented", "issue": 2, "commentId": "C", "audience": crate::audience::json(forge_core::rules::v2::Audience::Members), "cost": cost }),
    );
    assert_valid(
        "label list",
        &json!({ "count": 1, "labels": [{ "name": "bug", "color": "#d73a4a", "description": "", "retired": false }] }),
    );
}
