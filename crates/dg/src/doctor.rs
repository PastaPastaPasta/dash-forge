//! `dg doctor` — diagnose connectivity, contract ids, key sanity, and workspace health.

use std::process::Command;

use anyhow::Result;
use serde_json::{json, Value};

use forge_core::repo::TESTNET_REGISTRY_CONTRACT_ID;
use forge_core::tokens::TOKEN_HISTORY_CONTRACT_ID;

use crate::config::{config_path, Config};
use crate::context::{network_label, Ctx};

/// The embedded testnet deployment manifest (contract ids), same file `forge-core` reads.
const TESTNET_DEPLOYMENTS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../forge-contracts/deployments/testnet.json"
));

/// A single diagnostic check.
struct Check {
    name: &'static str,
    ok: bool,
    detail: String,
}

impl Check {
    fn to_json(&self) -> Value {
        json!({ "name": self.name, "ok": self.ok, "detail": self.detail })
    }
}

/// Run the full diagnostic suite.
pub async fn run(ctx: &Ctx) -> Result<()> {
    let network = network_label(ctx.network);
    let checks = vec![
        check_git(),
        check_config(),
        check_contracts(),
        check_identity(ctx),
        check_dapi(ctx, network).await,
    ];

    let all_ok = checks.iter().all(|c| c.ok);
    let checks_json: Vec<Value> = checks.iter().map(Check::to_json).collect();

    ctx.emit(
        json!({ "ok": all_ok, "network": network, "checks": checks_json }),
        || {
            println!("dg doctor ({network}):");
            for c in &checks {
                let mark = if c.ok { "ok  " } else { "FAIL" };
                println!("  [{mark}] {:<10} {}", c.name, c.detail);
            }
            println!(
                "\n{}",
                if all_ok {
                    "All checks passed."
                } else {
                    "Some checks failed (see above)."
                }
            );
        },
    );

    if !all_ok {
        std::process::exit(1);
    }
    Ok(())
}

/// `git` present on PATH (required for pack build / pr checkout / merge).
fn check_git() -> Check {
    match Command::new("git").arg("--version").output() {
        Ok(o) if o.status.success() => Check {
            name: "git",
            ok: true,
            detail: String::from_utf8_lossy(&o.stdout).trim().to_string(),
        },
        _ => Check {
            name: "git",
            ok: false,
            detail: "git not found on PATH (required for pack build / pr checkout / merge)".into(),
        },
    }
}

/// Config file + workspace health.
fn check_config() -> Check {
    let cfg_path = config_path()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let config = Config::load().unwrap_or_default();
    Check {
        name: "config",
        ok: true,
        detail: format!(
            "{cfg_path} (network={}, default_identity={})",
            config.network.as_deref().unwrap_or("<unset>"),
            config.default_identity_id.as_deref().unwrap_or("<unset>")
        ),
    }
}

/// Embedded contract ids (deployments/testnet.json + forge-core constants) agree.
fn check_contracts() -> Check {
    let registry_from_file = serde_json::from_str::<Value>(TESTNET_DEPLOYMENTS)
        .ok()
        .and_then(|v| v["registry"]["contractId"].as_str().map(str::to_string));
    let registry_matches = registry_from_file.as_deref() == Some(TESTNET_REGISTRY_CONTRACT_ID);
    Check {
        name: "contracts",
        ok: registry_matches,
        detail: format!(
            "registry={} (deployments.json {}), tokenHistory={}",
            TESTNET_REGISTRY_CONTRACT_ID,
            if registry_matches {
                "matches"
            } else {
                "MISMATCH"
            },
            TOKEN_HISTORY_CONTRACT_ID,
        ),
    }
}

/// Key sanity for the configured identity (doc-op key + token-admin CRITICAL key).
fn check_identity(ctx: &Ctx) -> Check {
    if ctx.identity_path.is_none() {
        return Check {
            name: "identity",
            ok: true,
            detail: "no identity configured (run `dg auth login --identity <file>`)".into(),
        };
    }
    match ctx.load_bridge() {
        Ok(bridge) => {
            let has_doc = bridge.doc_op_key().is_ok();
            let has_admin = bridge.token_admin_key().is_ok();
            Check {
                name: "identity",
                ok: has_doc,
                detail: format!(
                    "{} (doc-op key: {}, token-admin CRITICAL key: {})",
                    bridge.identity_id,
                    if has_doc { "present" } else { "MISSING" },
                    if has_admin {
                        "present"
                    } else {
                        "absent (collab/create need it)"
                    },
                ),
            }
        }
        Err(e) => Check {
            name: "identity",
            ok: false,
            detail: format!("failed to load identity: {e}"),
        },
    }
}

/// DAPI connectivity + proof verification (fetch the registry contract).
async fn check_dapi(ctx: &Ctx, network: &str) -> Check {
    match ctx.connect().await {
        Ok(client) => match client.fetch_contract(TESTNET_REGISTRY_CONTRACT_ID).await {
            Ok(_) => Check {
                name: "dapi",
                ok: true,
                detail: format!(
                    "connected to {network}; registry contract fetched + proof-verified"
                ),
            },
            Err(e) => Check {
                name: "dapi",
                ok: false,
                detail: format!("connected but registry fetch failed: {e}"),
            },
        },
        Err(e) => Check {
            name: "dapi",
            ok: false,
            detail: format!("could not connect to {network}: {e}"),
        },
    }
}
