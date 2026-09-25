//! `dg doctor` — diagnose connectivity, contract ids, key sanity, and workspace health.

use std::process::Command;

use anyhow::Result;
use serde_json::{json, Value};

use forge_core::network::{self, ContractSource, NetworkTarget};
use forge_core::platform::Network;
use forge_core::tokens::TOKEN_HISTORY_CONTRACT_ID;

use crate::config::{config_path, Config};
use crate::context::Ctx;

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
    let network = ctx.network_label();
    let checks = vec![
        check_dg(),
        check_git(),
        check_helper(),
        check_config(),
        check_network(ctx.network()),
        check_contracts(&ctx.target),
        check_identity(ctx),
        check_dapi(ctx, &network).await,
    ];

    let all_ok = checks.iter().all(|c| c.ok);
    let checks_json: Vec<Value> = checks.iter().map(Check::to_json).collect();

    let registry = ctx
        .target
        .registry
        .as_ref()
        .map(|r| json!({ "contractId": r.contract_id, "source": r.source.to_string() }));
    ctx.emit(
        json!({
            "ok": all_ok,
            "network": network,
            "registry": registry,
            "checks": checks_json,
        }),
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

/// This binary's own build: version, commit and target (the line to paste in a bug report).
fn check_dg() -> Check {
    Check {
        name: "dg",
        ok: true,
        detail: env!("DASH_FORGE_VERSION").to_string(),
    }
}

/// `git-remote-dash` on PATH (git needs it for every `dash://` URL) and built from the same
/// version as this `dg`: the two share forge-core's wire formats and contract ids.
fn check_helper() -> Check {
    match Command::new("git-remote-dash").arg("--version").output() {
        Ok(o) => helper_check(Some((
            o.status.success(),
            String::from_utf8_lossy(&o.stdout).trim().to_string(),
        ))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => helper_check(None),
        Err(e) => Check {
            name: "helper",
            ok: false,
            detail: format!("could not run git-remote-dash --version: {e}"),
        },
    }
}

/// [`check_helper`]'s verdict for a `(succeeded, stdout)` run, or `None` when it did not run.
///
/// The package version must match (the helper and dg share forge-core's wire formats); a
/// different commit at the same version — a dev tree where only one binary was rebuilt — is
/// reported but passes.
fn helper_check(run: Option<(bool, String)>) -> Check {
    let ours = env!("CARGO_PKG_VERSION");
    let our_sha = env!("DASH_FORGE_GIT_SHA");
    let (ok, detail) = match run {
        None => (
            false,
            "git-remote-dash not found on PATH — git cannot clone or push dash:// URLs \
             (install it next to dg: see docs/INSTALL.md)"
                .to_string(),
        ),
        Some((true, line)) => match parse_version_line(&line) {
            Some((version, sha)) if version == ours => {
                if sha == our_sha {
                    (true, line)
                } else {
                    (
                        true,
                        format!("{line}; built from a different commit than dg ({our_sha})"),
                    )
                }
            }
            Some(_) => (
                false,
                format!("{line} does not match dg {ours} — install both from the same release"),
            ),
            None => (
                false,
                format!("unrecognised `git-remote-dash --version` output: {line:?}"),
            ),
        },
        Some((false, _)) => (
            false,
            format!(
                "the git-remote-dash on PATH predates `--version` — reinstall it to match dg {ours}"
            ),
        ),
    };
    Check {
        name: "helper",
        ok,
        detail,
    }
}

/// Split `git-remote-dash <version> (<sha> <target>)` into `(version, sha)`.
fn parse_version_line(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix("git-remote-dash ")?;
    let (version, build) = rest.split_once(" (")?;
    let sha = build.split_whitespace().next()?;
    Some((version, sha))
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

/// The resolved network: its deployment key, and for a devnet where DAPI and quorums come
/// from.
fn check_network(network: &Network) -> Check {
    let detail = match network {
        Network::Devnet { dapi_addresses, .. } => format!(
            "{network} (DAPI: {}; quorums: {})",
            if dapi_addresses.is_empty() {
                "discovered from the quorum service at connect".to_string()
            } else {
                format!("{} address(es)", dapi_addresses.len())
            },
            network.quorum_base_url()
        ),
        _ => format!("{network} (built-in seed list)"),
    };
    Check {
        name: "network",
        ok: true,
        detail,
    }
}

/// The registry id this invocation will use and where it came from. A network with no
/// deployment fails here with the same actionable message the commands give.
fn check_contracts(target: &NetworkTarget) -> Check {
    let embedded = network::deployed_registry(&target.network);
    match (target.require_registry(), embedded) {
        (Ok(r), Ok(embedded)) => {
            // An override that differs from a real deployment is legitimate (a private
            // registry) but worth surfacing, since it changes which repos resolve.
            let note = match (&r.source, embedded) {
                (ContractSource::Override(_), Some(d)) if d.contract_id != r.contract_id => {
                    format!("; overrides {} from {}", d.contract_id, d.source)
                }
                _ => String::new(),
            };
            Check {
                name: "contracts",
                ok: true,
                detail: format!(
                    "registry={} (source: {}{note}), tokenHistory={TOKEN_HISTORY_CONTRACT_ID}",
                    r.contract_id, r.source
                ),
            }
        }
        (Err(e), _) | (_, Err(e)) => Check {
            name: "contracts",
            ok: false,
            detail: e.to_string(),
        },
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

/// DAPI connectivity + proof verification: fetch the registry contract, or — on a network
/// with no registry (the `contracts` check already fails for that) — the TokenHistory
/// system contract, whose id is the same everywhere, so connectivity is still reported.
async fn check_dapi(ctx: &Ctx, network: &str) -> Check {
    let (what, contract_id) = match &ctx.target.registry {
        Some(r) => ("registry contract", r.contract_id.as_str()),
        None => ("TokenHistory system contract", TOKEN_HISTORY_CONTRACT_ID),
    };
    match ctx.connect().await {
        Ok(client) => match client.fetch_contract(contract_id).await {
            Ok(_) => Check {
                name: "dapi",
                ok: true,
                detail: format!("connected to {network}; {what} fetched + proof-verified"),
            },
            Err(e) => Check {
                name: "dapi",
                ok: false,
                detail: format!("connected but {what} fetch failed: {e}"),
            },
        },
        Err(e) => Check {
            name: "dapi",
            ok: false,
            detail: format!("could not connect to {network}: {e}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::network::{NetworkSettings, Registry};

    #[test]
    fn helper_check_requires_a_matching_version() {
        let ours = format!("git-remote-dash {}", env!("DASH_FORGE_VERSION"));
        let c = helper_check(Some((true, ours.clone())));
        assert!(c.ok, "{}", c.detail);
        assert_eq!(c.detail, ours);

        let other_commit = format!(
            "git-remote-dash {} (000000000000 {})",
            env!("CARGO_PKG_VERSION"),
            env!("DASH_FORGE_TARGET")
        );
        let c = helper_check(Some((true, other_commit)));
        assert!(c.ok, "{}", c.detail);
        assert!(c.detail.contains("different commit"), "{}", c.detail);

        let c = helper_check(Some((true, "git-remote-dash 9.9.9 (abc x)".into())));
        assert!(!c.ok);
        assert!(c.detail.contains("does not match dg"), "{}", c.detail);

        let c = helper_check(Some((true, "something else".into())));
        assert!(!c.ok);
        assert!(c.detail.contains("unrecognised"), "{}", c.detail);

        // An old helper treats `--version` as an unknown admin verb and exits non-zero.
        let c = helper_check(Some((false, String::new())));
        assert!(!c.ok);
        assert!(c.detail.contains("predates `--version`"), "{}", c.detail);

        let c = helper_check(None);
        assert!(!c.ok);
        assert!(c.detail.contains("not found on PATH"), "{}", c.detail);
    }

    #[test]
    fn contracts_check_reports_the_deployment_file_as_the_source() {
        let target = NetworkSettings::default().resolve().unwrap();
        let c = check_contracts(&target);
        assert!(c.ok, "{}", c.detail);
        assert!(
            c.detail
                .contains("source: forge-contracts/deployments/testnet.json"),
            "{}",
            c.detail
        );
    }

    #[test]
    fn contracts_check_names_an_override_and_what_it_replaces() {
        let target = NetworkSettings {
            registry: Some(Registry::override_from(
                "PRIVATE",
                "env FORGE_REGISTRY_CONTRACT_ID",
            )),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        let c = check_contracts(&target);
        assert!(c.ok);
        assert!(c.detail.contains("registry=PRIVATE"), "{}", c.detail);
        assert!(
            c.detail
                .contains("override (env FORGE_REGISTRY_CONTRACT_ID)"),
            "{}",
            c.detail
        );
        assert!(c.detail.contains("overrides "), "{}", c.detail);
    }

    #[test]
    fn contracts_check_fails_clearly_on_an_undeployed_devnet() {
        let target = NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("moutai".into()),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        let c = check_contracts(&target);
        assert!(!c.ok);
        assert!(
            c.detail
                .contains("no Dash Forge registry is deployed on devnet-moutai yet"),
            "{}",
            c.detail
        );
        assert!(check_network(&target.network)
            .detail
            .contains("10 address(es)"));
    }
}
