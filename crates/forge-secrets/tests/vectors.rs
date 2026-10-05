//! The conformance vectors in `forge-contracts/vectors/secret_scan/` (inputs from
//! `tools/secret-scan-vectors/gen.py`). `FORGE_SECRETS_BLESS=1` rewrites each `expected` from
//! this implementation; review the diff before committing it.

use std::path::{Path, PathBuf};

use forge_secrets::{scan_file, verdict, AllowList, Severity};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    path: String,
    content: Option<Vec<String>>,
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
    let findings = scan_file(&input.path, content.as_deref().map(str::as_bytes));
    Value::from(
        findings
            .iter()
            .map(|f| {
                let v = verdict(f, input.history);
                json!({
                    "rule": f.rule.id(),
                    "line": f.line,
                    "fingerprint": f.fingerprint,
                    "severity": match v.severity {
                        Severity::Refuse => "refuse",
                        Severity::Warn => "warn",
                    },
                    "reason": v.reason.map(forge_secrets::WarnReason::id),
                    "allowed": allow.allows(f),
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
