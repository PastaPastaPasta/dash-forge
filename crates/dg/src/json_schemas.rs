//! The `--json` schemas under `docs/schemas/` (written by `docs/schemas/generate.py`) against
//! dg itself:
//!
//! - every dg command is in the schema index, with a schema or a reason it prints no JSON, and
//!   the index names no command dg doesn't have;
//! - every schema compiles (JSON Schema draft 2020-12, its `common.schema.json` references
//!   resolved);
//! - the output of dg's own JSON builders, versioned as dg prints it, validates against the
//!   schema of the command that prints it;
//! - the case files in `e2e/cli/json-fixtures/` (dg output captured offline, shapes taken from
//!   the emitters, and wrong shapes that must fail) get the verdict each expects, so this full
//!   validator and `e2e/cli/json_check.py`, which checks the e2e suite's real output, agree.
//!
//! CI also runs `python3 docs/schemas/generate.py --check`, so a schema edited by hand without
//! its spec fails there, and `json_check.py --cases` on the same case files.

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

/// Why `printed` does not match `schema` (empty: it matches).
fn problems(schema: &JSONSchema, printed: &Value) -> Vec<String> {
    match schema.validate(printed) {
        Ok(()) => Vec::new(),
        Err(errors) => errors
            .map(|e| format!("{} at {}", e, e.instance_path))
            .collect(),
    }
}

/// The schema a run of `command` that exited `exit` is checked against: the command's own on
/// exit 0, the error schema otherwise (docs/VERSIONING.md).
fn schema_file(command: &str, exit: i64) -> String {
    let index = read("index.json");
    let key = if exit == 0 {
        &index["commands"][command]
    } else {
        &index["error"]
    };
    key.as_str()
        .unwrap_or_else(|| panic!("no schema for `dg {command}` (exit {exit})"))
        .to_string()
}

/// `value` as dg prints it, checked against the schema of `command`.
fn assert_valid(command: &str, value: &Value) {
    let file = schema_file(command, 0);
    let printed = versioned(value);
    let why = problems(&compile(&file), &printed);
    assert!(
        why.is_empty(),
        "`dg {command} --json` does not match {file}:\n{}\n{printed:#}",
        why.join("\n")
    );
}

/// `body` printed with `error`'s block, as a failed run prints it, checked against the error
/// schema.
fn assert_error_valid(body: &Value, error: &forge_core::user_error::UserError) {
    let printed = versioned(&crate::errors::with_error(Some(body), error));
    let why = problems(&compile("error.schema.json"), &printed);
    assert!(why.is_empty(), "{}\n{printed:#}", why.join("\n"));
}

/// `value` checked against the shared definition `name` (common.schema.json).
fn assert_def(name: &str, value: &Value) {
    let common = read("common.schema.json");
    let id = common["$id"].as_str().unwrap().to_string();
    let schema = JSONSchema::options()
        .with_draft(Draft::Draft202012)
        .with_document(id.clone(), common)
        .compile(&json!({ "$ref": format!("{id}#/$defs/{name}") }))
        .unwrap_or_else(|e| panic!("$defs/{name}: {e}"));
    let why = problems(&schema, value);
    assert!(why.is_empty(), "{}\n{value:#}", why.join("\n"));
}

fn test_repo(name: &str) -> forge_core::scope::RepoRef {
    forge_core::scope::RepoRef {
        forge: forge_core::network::ForgeIds::test_forge(),
        repo_id: format!("{name}-id"),
        owner_id: "4X5xgudNAwLhWEL3jgsisYszZXPnf33VbyaAqjbUB9Yi".into(),
        name: name.into(),
        visibility: forge_core::rules::v2::Visibility::Public,
    }
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

// Review round 1 of the schemas: each of the commands below printed a shape its schema did not
// allow. The bodies come from the builders the commands print with.

/// `dg import`: the summary on success; the summary with the error block when it did not finish.
#[test]
fn import_summaries_match() {
    use forge_import::summary::{Status, Summary};
    let mut summary = Summary::new("devnet-sakura".into(), "github.com/o/r".into());
    for status in [Status::Ok, Status::DryRun] {
        summary.status = status;
        let (body, error) = crate::import::outcome(&summary).unwrap();
        assert!(error.is_none());
        assert_valid("import", &body);
    }
    summary.warnings.push("issue #4 skipped".into());
    for (status, error) in [
        (Status::Partial, None),
        (Status::CapExceeded, Some("would spend more than 0.1 DASH")),
        (Status::Error, Some("the source refused the token")),
    ] {
        summary.status = status;
        summary.error = error.map(String::from);
        let (body, error) = crate::import::outcome(&summary).unwrap();
        assert_error_valid(&body, &error.expect("a run that did not finish fails"));
    }
}

/// `dg search issues` / `dg search prs`: `query` is the parsed query.
#[test]
fn search_queries_match() {
    use forge_core::rules::search::{parse_issue_search, parse_pull_search, IssueQuery, PullQuery};
    let base = IssueQuery {
        state: "all".into(),
        ..IssueQuery::default()
    };
    let issues = parse_issue_search(
        "crash label:bug -label:wontfix assignee:me in:title is:closed comments:>2",
        &base,
    );
    assert_valid(
        "search issues",
        &json!({ "repo": "o/r", "query": issues.query, "notApplied": issues.unresolved, "total": 0, "count": 0, "issues": [] }),
    );
    let base = PullQuery {
        state: "all".into(),
        ..PullQuery::default()
    };
    let prs = parse_pull_search("is:draft review-requested:me label:ui", &base);
    assert_valid(
        "search prs",
        &json!({ "repo": "o/r", "query": prs.query, "notApplied": prs.unresolved, "total": 0, "count": 0, "prs": [] }),
    );
}

/// `dg repo create` / `dg init`: `steps` maps each document to what this run did. `dg repo
/// fork`: `refsWritten` lists the refs; an incomplete fork is printed with its error.
#[test]
fn create_steps_and_forks_match() {
    use forge_core::create::{CreateRepoResult, StepOutcome};
    assert_def(
        "createSteps",
        &crate::publish::steps_json(&[
            ("repo", StepOutcome::Created),
            ("writer", StepOutcome::Resumed),
            ("config", StepOutcome::Existed),
        ]),
    );
    let parent = test_repo("parent");
    let mut fork = forge_core::fork::ForkResult {
        created: CreateRepoResult {
            repo: test_repo("fork"),
            steps: vec![("repo", StepOutcome::Created)],
            cost_credits: 1_000,
        },
        manifests_written: 1,
        platform_referenced: 1,
        manifests_existing: 0,
        unreferenceable: Vec::new(),
        refs_written: vec!["refs/heads/main".into(), "refs/tags/v1".into()],
        cost_credits: 45_300_000,
    };
    assert_valid(
        "repo fork",
        &crate::repo::fork_body(&parent, &fork, Some(25.0)),
    );
    fork.unreferenceable.push([7; 32]);
    assert_error_valid(
        &crate::repo::fork_body(&parent, &fork, None),
        &forge_core::user_error::UserError::new(
            forge_core::user_error::codes::PACKS_UNREADABLE,
            "fork incomplete",
        ),
    );
}

/// `dg repo reindex`: `cost` is null when the balance could not be read. `dg repo members
/// enable` hands a key that needs repair to `dg repo keys repair`, and prints its shape.
#[test]
fn reindex_and_key_repairs_match() {
    let report = forge_core::repo::ReindexReport {
        manifest_id: Some("M".into()),
        indexed: vec!["h".into()],
        index_objects: 40,
        skipped: vec![("h2".into(), "no copy can be read".into())],
    };
    for spent in [None, Some(1_000)] {
        assert_valid(
            "repo reindex",
            &crate::maint::reindex_body(&test_repo("r"), &report, spent, None),
        );
    }
    let rotation = crate::keys::rotation_json(&forge_core::keyring::Rotation {
        epoch: 3,
        wrapped: vec!["B".into()],
        skipped: Vec::new(),
        won: true,
        burned: Some(2),
    });
    let repaired = json!({ "status": "repaired", "rotated": rotation, "nonMembers": ["C"], "wrapped": [], "skipped": [], "cost": crate::fmt::cost_json(1, None) });
    assert_valid("repo members enable", &repaired);
    assert_valid("repo keys repair", &repaired);
    assert_valid(
        "repo members enable",
        &json!({ "status": "already_on", "repo": "o/r", "epoch": 3 }),
    );
}

/// The case files `e2e/cli/json_check.py --cases` checks, through this validator: both must give
/// each case its expected verdict.
#[test]
fn the_fixture_cases_get_their_verdicts() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/cli/json-fixtures");
    let mut names: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    names.sort();
    let mut checked = 0;
    for path in names {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let case: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let expect = case["expect"].as_str().unwrap_or("valid");
        if expect == "skipped" {
            continue;
        }
        let command = case["command"]
            .as_str()
            .unwrap_or_else(|| panic!("{name}: name the command"));
        let exit = case["exit"].as_i64().unwrap();
        let stdout = match &case["stdout"] {
            Value::String(text) => serde_json::from_str(text).ok(),
            v => Some(v.clone()),
        };
        let why = match &stdout {
            Some(v) => problems(&compile(&schema_file(command, exit)), v),
            None => vec!["stdout is not JSON".into()],
        };
        let got = if why.is_empty() { "valid" } else { "invalid" };
        assert_eq!(got, expect, "{name}: {}", why.join("\n"));
        checked += 1;
    }
    assert!(checked >= 20, "only {checked} cases in {}", dir.display());
}
