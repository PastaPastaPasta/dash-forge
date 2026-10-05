//! The conformance vectors in `forge-contracts/vectors/secret_scan/` (inputs from
//! `tools/secret-scan-vectors/gen.py`). `FORGE_SECRETS_BLESS=1` rewrites each `expected` from
//! this implementation; review the diff before committing it.

use std::path::{Path, PathBuf};

use forge_secrets::{decide, scan_file, scan_unread, AllowList, Severity};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    path: String,
    content: Option<Vec<String>>,
    /// The git blob id of a file that was not read (`content: null`).
    #[serde(default)]
    blob_id: Option<String>,
    history: bool,
    #[serde(default)]
    allow_file: Option<String>,
    #[serde(default)]
    allow_secrets: Vec<String>,
}

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../forge-contracts/vectors/secret_scan")
}

/// What the scan reports for `input`, in the vectors' shape.
fn run(input: &Input) -> Value {
    let content = input.content.as_ref().map(|pieces| pieces.concat());
    let mut allow = input
        .allow_file
        .as_deref()
        .map(AllowList::parse)
        .unwrap_or_default();
    for fp in &input.allow_secrets {
        assert!(allow.add_fingerprint(fp), "allowSecrets entry {fp:?}");
    }
    let findings = match content.as_deref() {
        Some(text) => scan_file(&input.path, text.as_bytes()),
        None => scan_unread(
            &input.path,
            input.blob_id.as_deref().expect("blobId for an unread file"),
        ),
    };
    Value::from(
        findings
            .iter()
            .map(|f| {
                let v = decide(f, input.history, &allow);
                json!({
                    "rule": f.rule.id(),
                    "line": f.line,
                    "fingerprint": f.fingerprint,
                    "severity": match v.map(|v| v.severity) {
                        Some(Severity::Refuse) => "refuse",
                        Some(Severity::Warn) => "warn",
                        None => "silent",
                    },
                    "reason": v.and_then(|v| v.reason).map(forge_secrets::WarnReason::id),
                })
            })
            .collect::<Vec<_>>(),
    )
}

#[test]
fn secret_scan_vectors() {
    let bless = std::env::var_os("FORGE_SECRETS_BLESS").is_some();
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir())
        .expect("read the secret_scan vectors")
        .map(|e| e.expect("dir entry").path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    assert!(
        files.len() >= 30,
        "expected 30+ vectors, found {}",
        files.len()
    );
    for path in files {
        let text = std::fs::read_to_string(&path).expect("read vector");
        let mut v: Value = serde_json::from_str(&text).expect("parse vector");
        let name = v["name"].as_str().unwrap_or_default().to_string();
        assert_eq!(v["case"], "secret_scan", "{name}");
        let input: Input = serde_json::from_value(v["input"].clone())
            .unwrap_or_else(|e| panic!("vector {name}: input: {e}"));
        let got = run(&input);
        if bless {
            v["expected"] = got;
            let mut out = serde_json::to_string_pretty(&v).expect("serialize");
            out.push('\n');
            std::fs::write(&path, out).expect("write vector");
        } else {
            assert_eq!(got, v["expected"], "vector {name}");
        }
    }
}
