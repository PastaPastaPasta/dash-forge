//! `dg doctor` — check everything a push, clone or web read depends on, grouped the way the
//! UX spec (§7.5) lists them, each row `✓`/`!`/`✗` with the fix next to it.
//!
//! Sections: **toolchain** (git ≥ 2.26, `git-remote-dash` on PATH and the same version),
//! **identity** (file, keys, permissions, on-chain existence and balance), **network**
//! (target, DAPI reachable, forge-v2 / protocol-14 contracts present), **contracts** (where
//! each id comes from), **storage** (every profile: valid, secrets resolvable, web CORS
//! preflight on its public URL), **git config** (`dash.*` for this repository: storage
//! policy, cost guard, network agreement with `dg`).
//!
//! `--fix` applies only local, reversible, free fixes: create the config directories with
//! mode 0700, tighten an identity file to 0600, and set git config keys that are unset (the
//! spec's default cost guard, and `dash.network` so `git push` uses the network `dg` uses).
//! It never overwrites a value the user set and never signs or broadcasts anything.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Result;
use serde_json::{json, Value};

use forge_core::network::{self, ContractSource, NetworkSettings, NetworkTarget};
use forge_core::platform::{Network, PlatformClient};
use forge_core::storage::cors::probe_preflight;
use forge_core::storage::policy::git_config_scoped;
use forge_core::storage::{Profile, StoragePolicy, StorageProfiles};
use forge_core::tokens::TOKEN_HISTORY_CONTRACT_ID;
use forge_core::user_error::{codes, redact, UserError};

use crate::config::{config_dir, config_path, Config};
use crate::context::Ctx;
use crate::fmt::{credits_to_dash, dash_amount};

/// The oldest git whose `git config --show-scope` the storage policy relies on (older ones
/// fall back to an unscoped read, which cannot rank a global `remote.*` key below a
/// repo-local `dash.*` one).
const MIN_GIT: (u32, u32) = (2, 26);

/// The spec's default push cost guard (UX spec §4 rule 4), in DASH.
const DEFAULT_COST_WARN_THRESHOLD: &str = "0.01";

/// Balance below which writes will soon fail (UX spec §4 "Low").
const LOW_BALANCE_DASH: f64 = 0.01;

/// A row's verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Ok,
    Warn,
    Fail,
}

impl Status {
    fn label(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Warn => "warn",
            Status::Fail => "fail",
        }
    }

    fn mark(self) -> &'static str {
        match self {
            Status::Ok => "✓",
            Status::Warn => "!",
            Status::Fail => "✗",
        }
    }
}

/// A safe, automatic fix `--fix` may apply.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AutoFix {
    /// Create (or tighten) a directory to mode 0700.
    PrivateDir(PathBuf),
    /// Tighten a file to mode 0600.
    PrivateFile(PathBuf),
    /// `git config --global <key> <value>` for a key that is unset everywhere.
    GitConfigGlobal(&'static str, String),
    /// `git config <key> <value>` in this repository, for a key that is unset everywhere.
    GitConfigLocal(&'static str, String),
}

impl AutoFix {
    fn describe(&self) -> String {
        match self {
            AutoFix::PrivateDir(p) => format!("mkdir -p -m 700 {}", p.display()),
            AutoFix::PrivateFile(p) => format!("chmod 600 {}", p.display()),
            AutoFix::GitConfigGlobal(k, v) => format!("git config --global {k} {v}"),
            AutoFix::GitConfigLocal(k, v) => format!("git config {k} {v}"),
        }
    }

    fn apply(&self) -> std::result::Result<(), String> {
        match self {
            AutoFix::PrivateDir(p) => {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
                set_mode(p, 0o700)
            }
            AutoFix::PrivateFile(p) => set_mode(p, 0o600),
            AutoFix::GitConfigGlobal(k, v) | AutoFix::GitConfigLocal(k, v) => {
                // Re-check: never overwrite a value that appeared since the check ran.
                if git_config_scoped(k).is_some() {
                    return Ok(());
                }
                let scope = if matches!(self, AutoFix::GitConfigGlobal(..)) {
                    &["config", "--global"][..]
                } else {
                    &["config"][..]
                };
                let out = Command::new("git")
                    .args(scope)
                    .args([k, v.as_str()])
                    .output()
                    .map_err(|e| e.to_string())?;
                if out.status.success() {
                    Ok(())
                } else {
                    Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
                }
            }
        }
    }
}

/// One diagnostic row.
#[derive(Debug, Clone)]
struct Check {
    name: &'static str,
    status: Status,
    detail: String,
    /// What to do about a warn/fail (a command where possible).
    fix: Option<String>,
    /// The part of the fix `--fix` can do by itself.
    auto: Option<AutoFix>,
}

impl Check {
    fn ok(name: &'static str, detail: impl Into<String>) -> Self {
        Self {
            name,
            status: Status::Ok,
            detail: detail.into(),
            fix: None,
            auto: None,
        }
    }

    fn warn(name: &'static str, detail: impl Into<String>, fix: impl Into<String>) -> Self {
        Self {
            status: Status::Warn,
            fix: Some(fix.into()),
            ..Self::ok(name, detail)
        }
    }

    fn fail(name: &'static str, detail: impl Into<String>, fix: impl Into<String>) -> Self {
        Self {
            status: Status::Fail,
            fix: Some(fix.into()),
            ..Self::ok(name, detail)
        }
    }

    fn auto(mut self, fix: AutoFix) -> Self {
        self.auto = Some(fix);
        self
    }
}

/// A titled group of rows.
struct Section {
    title: &'static str,
    checks: Vec<Check>,
}

/// Run every check, apply the safe fixes when `fix` is set, and report.
pub async fn run(ctx: &Ctx, fix: bool) -> Result<()> {
    let identity = check_identity(ctx).await;
    let mut sections = vec![
        Section {
            title: "toolchain",
            checks: check_toolchain(),
        },
        Section {
            title: "identity",
            checks: identity,
        },
        Section {
            title: "network",
            checks: check_network(ctx).await,
        },
        Section {
            title: "contracts",
            checks: vec![check_contracts(&ctx.target)],
        },
        Section {
            title: "storage",
            checks: check_storage().await,
        },
        Section {
            title: "git config",
            checks: check_git_config(ctx),
        },
    ];

    let applied = if fix {
        apply_fixes(&mut sections)
    } else {
        Vec::new()
    };
    // Rows quote URLs, paths and upstream errors; none of it may carry a credential.
    for c in sections.iter_mut().flat_map(|s| s.checks.iter_mut()) {
        c.detail = redact(&c.detail);
        c.fix = c.fix.as_deref().map(redact);
    }

    let all = || sections.iter().flat_map(|s| &s.checks);
    let failing: Vec<&str> = all()
        .filter(|c| c.status == Status::Fail)
        .map(|c| c.name)
        .collect();
    let fixable = all()
        .filter(|c| c.status != Status::Ok && c.auto.is_some())
        .count();
    let counts = Counts {
        failed: failing.len(),
        warned: all().filter(|c| c.status == Status::Warn).count(),
        fixable,
    };
    let body = report_json(ctx, &sections, &applied, &counts);

    if failing.is_empty() {
        ctx.emit(body, || print_report(ctx, &sections, &counts, fix));
        return Ok(());
    }
    if !ctx.json {
        print_report(ctx, &sections, &counts, fix);
    }
    let mut err = UserError::new(
        codes::CHECKS_FAILED,
        format!("{} check(s) failed", failing.len()),
    )
    .cause(format!("failing: {}", failing.join(", ")))
    .fix("apply the fix shown next to each ✗ row, then run `dg doctor` again");
    if fixable > 0 && !fix {
        err = err.fix("`dg doctor --fix` applies the safe ones automatically");
    }
    // The report is printed once, with the error block merged in under `--json`.
    Err(crate::errors::reported(err, body))
}

/// Row tallies for the summary.
struct Counts {
    failed: usize,
    warned: usize,
    fixable: usize,
}

/// The whole report as JSON.
fn report_json(ctx: &Ctx, sections: &[Section], applied: &[Value], counts: &Counts) -> Value {
    let registry = ctx
        .target
        .registry
        .as_ref()
        .map(|r| json!({ "contractId": r.contract_id, "source": r.source.to_string() }));
    let sections_json: Vec<Value> = sections
        .iter()
        .map(|s| {
            json!({
                "name": s.title,
                "checks": s.checks.iter().map(|c| json!({
                    "name": c.name,
                    "status": c.status.label(),
                    "ok": c.status != Status::Fail,
                    "detail": c.detail,
                    "fix": c.fix,
                    "autoFix": c.auto.as_ref().filter(|_| c.status != Status::Ok).map(AutoFix::describe),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({
        "ok": counts.failed == 0,
        "network": ctx.network_label(),
        "registry": registry,
        "forgeV2": ctx.target.v2.as_ref().map(|ids| json!({
            "core": ids.core,
            "collab": ids.collab,
            "group": ids.group,
        })),
        "failed": counts.failed,
        "warnings": counts.warned,
        "sections": sections_json,
        "fixesApplied": applied,
    })
}

/// The human report on stdout.
fn print_report(ctx: &Ctx, sections: &[Section], counts: &Counts, fix: bool) {
    println!("dg doctor ({})", ctx.network_label());
    for s in sections {
        println!("\n{}", s.title);
        for c in &s.checks {
            println!("  {} {:<16} {}", c.status.mark(), c.name, c.detail);
            if let Some(f) = &c.fix {
                println!("    {:<16} → {f}", "");
            }
        }
    }
    println!(
        "\n{}",
        match (counts.failed, counts.warned) {
            (0, 0) => "Everything checks out.".to_string(),
            (0, w) => format!("{w} warning(s); nothing is broken."),
            (f, w) => format!("{f} problem(s), {w} warning(s)."),
        }
    );
    if counts.fixable > 0 && !fix {
        println!(
            "`dg doctor --fix` can fix {} of these (local changes only, nothing is spent).",
            counts.fixable
        );
    }
}

/// Apply every failing row's safe fix, marking the rows that it fixed.
fn apply_fixes(sections: &mut [Section]) -> Vec<Value> {
    let mut applied = Vec::new();
    for c in sections.iter_mut().flat_map(|s| s.checks.iter_mut()) {
        let Some(auto) = c.auto.clone() else { continue };
        if c.status == Status::Ok {
            continue;
        }
        let what = auto.describe();
        match auto.apply() {
            Ok(()) => {
                c.status = Status::Ok;
                c.detail = format!("{} (fixed: {what})", c.detail);
                c.fix = None;
                applied.push(json!({ "fix": what, "ok": true }));
            }
            Err(e) => {
                c.detail = format!("{} (could not apply `{what}`: {e})", c.detail);
                applied.push(json!({ "fix": what, "ok": false, "error": e }));
            }
        }
    }
    applied
}

// --- toolchain ---------------------------------------------------------------------------

fn check_toolchain() -> Vec<Check> {
    let mut out = vec![Check::ok("dg", env!("DASH_FORGE_VERSION"))];
    match Command::new("git").arg("--version").output() {
        Ok(o) if o.status.success() => {
            let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
            out.push(git_version_check(&v));
        }
        _ => out.push(Check::fail(
            "git",
            "git is not on PATH",
            "install git ≥ 2.26 (https://git-scm.com/downloads)",
        )),
    }
    out.push(
        match Command::new("git-remote-dash").arg("--version").output() {
            Ok(o) => helper_check(Some((
                o.status.success(),
                String::from_utf8_lossy(&o.stdout).trim().to_string(),
            ))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => helper_check(None),
            Err(e) => Check::fail(
                "git-remote-dash",
                format!("could not run git-remote-dash --version: {e}"),
                "check that the binary on PATH is executable",
            ),
        },
    );
    out
}

/// Parse `git version 2.39.3 (Apple Git-146)` → `(2, 39)`.
fn parse_git_version(s: &str) -> Option<(u32, u32)> {
    let v = s.split_whitespace().nth(2)?;
    let mut it = v.split('.');
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

fn git_version_check(version_line: &str) -> Check {
    match parse_git_version(version_line) {
        Some(v) if v >= MIN_GIT => Check::ok("git", version_line),
        Some(_) => Check::warn(
            "git",
            format!("{version_line} is older than {}.{}: per-remote storage settings cannot be ranked by scope", MIN_GIT.0, MIN_GIT.1),
            "upgrade git to 2.26 or newer",
        ),
        None => Check::warn(
            "git",
            format!("could not read the version from {version_line:?}"),
            "check that `git --version` works",
        ),
    }
}

/// The helper check for a `(succeeded, stdout)` run of `git-remote-dash --version`, or `None`
/// when it is not on PATH. The package version must match (the helper and dg share
/// forge-core's wire formats); a different commit at the same version — a dev tree where
/// only one binary was rebuilt — is reported but passes.
fn helper_check(run: Option<(bool, String)>) -> Check {
    const NAME: &str = "git-remote-dash";
    let ours = env!("CARGO_PKG_VERSION");
    let our_sha = env!("DASH_FORGE_GIT_SHA");
    let reinstall = "install dg and git-remote-dash from the same release (docs/INSTALL.md)";
    match run {
        None => Check::fail(
            NAME,
            "not found on PATH: git cannot clone or push dash:// URLs",
            "install it next to dg and make sure its directory is on PATH (docs/INSTALL.md)",
        ),
        Some((true, line)) => match parse_version_line(&line) {
            Some((version, sha)) if version == ours => {
                if sha == our_sha {
                    Check::ok(NAME, line)
                } else {
                    Check::ok(
                        NAME,
                        format!("{line}; built from a different commit than dg ({our_sha})"),
                    )
                }
            }
            Some(_) => Check::fail(NAME, format!("{line} does not match dg {ours}"), reinstall),
            None => Check::fail(
                NAME,
                format!("unrecognised `git-remote-dash --version` output: {line:?}"),
                reinstall,
            ),
        },
        Some((false, _)) => Check::fail(
            NAME,
            format!("the git-remote-dash on PATH predates `--version` (dg is {ours})"),
            reinstall,
        ),
    }
}

/// Split `git-remote-dash <version> (<sha> <target>)` into `(version, sha)`.
fn parse_version_line(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix("git-remote-dash ")?;
    let (version, build) = rest.split_once(" (")?;
    let sha = build.split_whitespace().next()?;
    Some((version, sha))
}

// --- identity ----------------------------------------------------------------------------

async fn check_identity(ctx: &Ctx) -> Vec<Check> {
    let mut out = vec![check_config_dir()];
    let Some(path) = ctx.identity_path.clone() else {
        out.push(Check::warn(
            "identity",
            "none configured (reads work; writes need one)",
            "`dg auth login --identity <file>` with the bridge identity export",
        ));
        return out;
    };
    let bridge = match ctx.load_bridge() {
        Ok(b) => b,
        Err(e) => {
            out.push(Check::fail(
                "identity",
                format!("{}: {:#}", forge_core::keystore::describe_key_source(&path), e),
                "pass the bridge identity export with --identity <file>, or `dg auth login --identity <file>`",
            ));
            return out;
        }
    };
    out.push(Check::ok(
        "identity",
        format!(
            "{} ({})",
            bridge.identity_id,
            forge_core::keystore::describe_key_source(&path)
        ),
    ));
    if !forge_core::keystore::is_inline_key(&path) {
        out.push(file_mode_check(&path));
    }
    out.push(
        match (
            bridge.doc_op_key().is_ok(),
            bridge.token_admin_key().is_ok(),
        ) {
            (true, true) => Check::ok(
                "keys",
                "HIGH/CRITICAL auth key for writes; CRITICAL for token admin",
            ),
            (true, false) => Check::warn(
                "keys",
                "writes OK; no CRITICAL key, so `dg repo create` and `dg collab` cannot sign",
                "use the identity export that includes the CRITICAL AUTHENTICATION key for those",
            ),
            (false, _) => Check::fail(
                "keys",
                "no HIGH or CRITICAL AUTHENTICATION key: nothing can be signed",
                "export the identity again from the bridge (it includes the auth keys)",
            ),
        },
    );
    out.push(match ctx.connect().await {
        Err(_) => Check::warn(
            "balance",
            "not checked: Platform unreachable (see network)",
            "run `dg doctor` again when the network row passes",
        ),
        Ok(client) => match client.get_balance(&bridge.identity_id).await {
            Ok(credits) => balance_check(credits),
            Err(forge_core::Error::NotFound) => Check::fail(
                "balance",
                format!(
                    "identity {} does not exist on {}",
                    bridge.identity_id,
                    ctx.network_label()
                ),
                "select the network it was created on: `--network testnet|mainnet` or `--network devnet --devnet-name <name>`",
            ),
            Err(e) => Check::warn(
                "balance",
                format!("could not read it: {e}"),
                "run `dg doctor` again in a minute",
            ),
        },
    });
    out
}

fn balance_check(credits: u64) -> Check {
    let dash = credits_to_dash(credits);
    let detail = format!("{} DASH", dash_amount(dash));
    let fix = format!(
        "top up from any Dash wallet at {}",
        forge_core::user_error::TOP_UP_URL
    );
    if credits == 0 {
        Check::fail(
            "balance",
            format!("{detail}: every write will fail (reads still work)"),
            fix,
        )
    } else if dash < LOW_BALANCE_DASH {
        Check::warn("balance", format!("{detail} (low)"), fix)
    } else {
        Check::ok("balance", detail)
    }
}

fn check_config_dir() -> Check {
    let Ok(dir) = config_dir() else {
        return Check::fail("config dir", "HOME is not set", "set HOME");
    };
    let cfg = config_path()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    match mode_of(&dir) {
        None => Check::warn(
            "config dir",
            format!("{} does not exist yet", dir.display()),
            format!("mkdir -p -m 700 {}", dir.display()),
        )
        .auto(AutoFix::PrivateDir(dir)),
        Some(m) if m & 0o077 != 0 => Check::warn(
            "config dir",
            format!(
                "{} is mode {m:o}: other users can list your identity files",
                dir.display()
            ),
            format!("chmod 700 {}", dir.display()),
        )
        .auto(AutoFix::PrivateDir(dir)),
        Some(_) => Check::ok("config dir", format!("{} (config: {cfg})", dir.display())),
    }
}

fn file_mode_check(path: &Path) -> Check {
    match mode_of(path) {
        Some(m) if m & 0o077 != 0 => Check::warn(
            "key file mode",
            format!("{} is mode {m:o}: it holds private keys", path.display()),
            format!("chmod 600 {}", path.display()),
        )
        .auto(AutoFix::PrivateFile(path.to_path_buf())),
        Some(m) => Check::ok("key file mode", format!("{m:o}")),
        None => Check::ok("key file mode", "not applicable on this platform"),
    }
}

#[cfg(unix)]
fn mode_of(p: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .ok()
        .map(|m| m.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn mode_of(p: &Path) -> Option<u32> {
    // No POSIX modes: report existence only (0o700 = "private enough").
    p.exists().then_some(0o700)
}

#[cfg(unix)]
fn set_mode(p: &Path, mode: u32) -> std::result::Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn set_mode(_: &Path, _: u32) -> std::result::Result<(), String> {
    Ok(())
}

// --- network + contracts -----------------------------------------------------------------

async fn check_network(ctx: &Ctx) -> Vec<Check> {
    let network = ctx.network();
    let target = match network {
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
    let mut out = vec![Check::ok("target", target)];

    // DAPI + proof verification: fetch the registry contract, or — with no registry on this
    // network (the contracts row fails for that) — the TokenHistory system contract.
    let (what, contract_id) = match &ctx.target.registry {
        Some(r) => ("registry contract", r.contract_id.as_str()),
        None => ("TokenHistory system contract", TOKEN_HISTORY_CONTRACT_ID),
    };
    let client = match ctx.connect().await {
        Ok(c) => c,
        Err(e) => {
            out.push(Check::fail(
                "dapi",
                format!("could not connect: {e:#}"),
                "check the connection; on a devnet check --dapi-addresses / `dash.dapiAddresses`",
            ));
            return out;
        }
    };
    out.push(match client.fetch_contract(contract_id).await {
        Ok(_) => Check::ok("dapi", format!("reachable; {what} fetched and proof-verified")),
        Err(e) => Check::fail(
            "dapi",
            format!("connected, but the {what} fetch failed: {e}"),
            "run it again in a minute (failed nodes are skipped); if it persists, check the network selection",
        ),
    });
    // The protocol version is read only after a proved query: the SDK starts at its
    // per-network floor and learns the real version from verified response metadata.
    out.push(match client.refresh_protocol_version().await {
        Ok(v) => Check::ok(
            "protocol",
            format!("protocol version {v} (from a proof-verified response)"),
        ),
        Err(e) => Check::fail(
            "protocol",
            format!(
                "unverified (floor {}): the proved epoch read failed: {e}",
                client.protocol_version()
            ),
            "run it again in a minute (a different node is asked)",
        ),
    });
    out.push(check_forge_v2(&client, &ctx.target).await);
    out
}

/// The forge-v2 contracts recorded for this network: both must fetch with a verified proof
/// and both must be enrolled, as whole contracts, in the recorded contract group. A network
/// with no forge-v2 deployment passes with a note — v1 is the live data plane there.
async fn check_forge_v2(client: &PlatformClient, target: &NetworkTarget) -> Check {
    let Some(ids) = &target.v2 else {
        return Check::ok(
            "forge-v2",
            format!("not deployed on {} (v1 repos only)", target.network.key()),
        );
    };
    let mut problems = Vec::new();
    for (label, id) in [("forge-core", &ids.core), ("forge-collab", &ids.collab)] {
        if let Err(e) = client.fetch_contract(id).await {
            problems.push(format!("{label} {id} not provable: {e}"));
            continue;
        }
        match client.contract_groups_of(id).await {
            Ok(groups) if groups.contains(&ids.group) => {}
            Ok(groups) => problems.push(format!(
                "{label} {id} is not in group {} (member of: {})",
                ids.group,
                if groups.is_empty() {
                    "none".to_string()
                } else {
                    groups.join(", ")
                }
            )),
            Err(e) => problems.push(format!("{label} {id} group lookup failed: {e}")),
        }
    }
    if problems.is_empty() {
        Check::ok(
            "forge-v2",
            format!(
                "core={} collab={} both proof-verified and enrolled in group {}",
                ids.core, ids.collab, ids.group
            ),
        )
    } else {
        Check::fail(
            "forge-v2",
            problems.join("; "),
            "the network may not run protocol 14 yet, or the deployment record is stale; v1 repos still work",
        )
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
            let v2 = target
                .v2
                .as_ref()
                .map(|v| format!(", forge-v2 core={} collab={}", v.core, v.collab))
                .unwrap_or_default();
            Check::ok(
                "registry",
                format!(
                    "registry={} (source: {}{note}), tokenHistory={TOKEN_HISTORY_CONTRACT_ID}{v2}",
                    r.contract_id, r.source
                ),
            )
        }
        (Err(e), _) | (_, Err(e)) => Check::fail(
            "registry",
            e.to_string(),
            "use a network with a deployment (`--network testnet`), or set `registry_contract_id` in config.toml",
        ),
    }
}

// --- storage -----------------------------------------------------------------------------

async fn check_storage() -> Vec<Check> {
    let path = StorageProfiles::default_path()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let profiles = match StorageProfiles::load() {
        Ok(p) => p,
        Err(e) => {
            return vec![Check::fail(
                "storage.toml",
                e.to_string(),
                format!("fix {path}, or re-create the profiles with `dg storage add`"),
            )]
        }
    };
    if profiles.profiles.is_empty() {
        return vec![Check::ok(
            "profiles",
            format!("none in {path}: pushes store packs on Platform (~0.28 DASH/MiB); `dg storage add` adds your own bucket"),
        )];
    }
    let http = forge_core::storage::http_client();
    let mut out = Vec::new();
    for (name, profile) in &profiles.profiles {
        out.push(profile_check(name, profile));
        if let Some(url) = public_probe_url(profile) {
            out.push(match probe_preflight(&http, &url).await {
                Ok(()) => Check::ok("web CORS", format!("{name}: the web app may read {url}")),
                Err(why) => Check::warn(
                    "web CORS",
                    format!("{name}: {why}; git works, the web app cannot read this storage"),
                    format!("`dg storage test {name}` prints the exact CORS config to paste"),
                ),
            });
        }
    }
    out
}

fn profile_check(name: &str, profile: &Profile) -> Check {
    if let Err(e) = profile.validate() {
        return Check::fail(
            "profile",
            format!("{name}: {e}"),
            format!(
                "re-add it: `dg storage add {name} --kind {} …`",
                profile.kind()
            ),
        );
    }
    let missing: Vec<String> = profile
        .secret_refs()
        .into_iter()
        .filter(|(_, r)| !r.is_available())
        .map(|(field, r)| format!("{field} = {r}"))
        .collect();
    if missing.is_empty() {
        Check::ok(
            "profile",
            format!("{name} ({}): secrets resolve", profile.kind()),
        )
    } else {
        Check::fail(
            "profile",
            format!("{name}: unresolved {}", missing.join(", ")),
            "export the variable in the shell git and dg run in, or store it in the keychain",
        )
    }
}

/// Where a browser would read this profile's objects, for a preflight (an object that need
/// not exist: a preflight does not fetch it).
fn public_probe_url(profile: &Profile) -> Option<String> {
    match profile {
        Profile::S3(p) => p
            .public_url
            .as_ref()
            .map(|u| format!("{}/dash-forge-cors-check", u.trim_end_matches('/'))),
        // `bafkqaaa` is the empty identity CID: every gateway can serve it.
        _ => profile
            .public_gateway()
            .map(|g| format!("{}/ipfs/bafkqaaa", g.trim_end_matches('/'))),
    }
}

// --- git config --------------------------------------------------------------------------

fn check_git_config(ctx: &Ctx) -> Vec<Check> {
    let get = |k: &str| git_config_scoped(k).map(|(_, v)| v);
    let mut out = Vec::new();

    // The helper's network comes from env + git config; if that differs from dg's, pushes
    // go to one network and `dg` reads another.
    let helper_net = NetworkSettings::from_env()
        .overlay(NetworkSettings::from_git_config(|k| get(k)))
        .resolve()
        .map(|t| t.network.key());
    let dg_net = ctx.network_label();
    out.push(match helper_net {
        Ok(h) if h == dg_net => Check::ok("dash.network", format!("git push uses {h}, same as dg")),
        Ok(h) => {
            let mut c = Check::warn(
                "dash.network",
                format!("git push would use {h}, but dg uses {dg_net}"),
                network_fix_command(ctx.network()),
            );
            // Only when dg's network is the user's saved default (config.toml, not a one-off
            // --network flag or env var), git config sets none, and this is a repository:
            // then pinning it in this repo's config makes `git push` agree with `dg`. Never
            // global, never overwriting a choice, never a devnet (that needs more keys).
            let saved = Config::load().ok().and_then(|c| c.network);
            if saved.as_deref() == Some(ctx.network().kind())
                && get("dash.network").is_none()
                && std::env::var_os("DASH_FORGE_NETWORK").is_none()
                && ctx.network().devnet_name().is_none()
                && in_git_repo()
            {
                c = c.auto(AutoFix::GitConfigLocal(
                    "dash.network",
                    ctx.network().kind().to_string(),
                ));
            }
            c
        }
        Err(e) => Check::fail(
            "dash.network",
            format!("git config dash.* does not resolve: {e}"),
            "fix or unset the dash.network / dash.devnetName / dash.dapiAddresses values",
        ),
    });

    out.push(match get("dash.costWarnThreshold") {
        Some(v)
            if v.trim()
                .parse::<f64>()
                .is_ok_and(|x| x.is_finite() && x >= 0.0) =>
        {
            Check::ok("cost guard", format!("pushes above {v} DASH ask first"))
        }
        Some(v) => Check::fail(
            "cost guard",
            format!("dash.costWarnThreshold = {v:?} is not a DASH amount: every push fails"),
            format!("git config dash.costWarnThreshold {DEFAULT_COST_WARN_THRESHOLD}"),
        ),
        None => Check::warn(
            "cost guard",
            "dash.costWarnThreshold is unset: pushes never ask before spending",
            format!("git config --global dash.costWarnThreshold {DEFAULT_COST_WARN_THRESHOLD}"),
        )
        .auto(AutoFix::GitConfigGlobal(
            "dash.costWarnThreshold",
            DEFAULT_COST_WARN_THRESHOLD.into(),
        )),
    });
    if let Some(v) = get("dash.confirm") {
        if !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "" | "auto" | "always" | "never" | "true" | "false" | "yes" | "no"
        ) {
            out.push(Check::fail(
                "dash.confirm",
                format!("{v:?} is not auto, always or never: every push fails"),
                "git config dash.confirm auto",
            ));
        }
    }

    // This repository's storage policy (only meaningful inside a git repository).
    if !in_git_repo() {
        out.push(Check::ok(
            "dash.storage",
            "not inside a git repository; nothing repo-specific to check",
        ));
        return out;
    }
    let storage = get("dash.storage");
    let policy = StoragePolicy::from_git_values(
        storage.as_deref(),
        get("dash.replicas").as_deref(),
        get("dash.platformFallback").as_deref(),
    );
    out.push(match policy {
        Err(e) => Check::fail("dash.storage", e.to_string(), "`dg storage use <profiles>` rewrites it"),
        Ok(p) if p.is_platform_only() => Check::ok("dash.storage", "unset: pushes store packs on Platform"),
        Ok(p) => match StorageProfiles::load().and_then(|profiles| p.resolve(&profiles)) {
            Ok(r) => Check::ok(
                "dash.storage",
                format!("{} (need {} of {})", r.target_names().join(", "), r.replicas, r.total()),
            ),
            Err(e) => Check::fail(
                "dash.storage",
                e.to_string(),
                "`dg storage list` shows the profiles; `dg storage use <profiles>` sets dash.storage",
            ),
        },
    });
    out
}

fn network_fix_command(n: &Network) -> String {
    match n.devnet_name() {
        Some(name) => {
            format!("git config dash.network devnet && git config dash.devnetName {name}")
        }
        None => format!("git config dash.network {}", n.kind()),
    }
}

fn in_git_repo() -> bool {
    Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::network::Registry;

    #[test]
    fn contracts_check_reports_the_deployment_file_as_the_source() {
        let target = NetworkSettings::default().resolve().unwrap();
        let c = check_contracts(&target);
        assert_eq!(c.status, Status::Ok, "{}", c.detail);
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
        assert_eq!(c.status, Status::Ok);
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
        assert_eq!(c.status, Status::Fail);
        assert!(
            c.detail
                .contains("no Dash Forge registry is deployed on devnet-moutai yet"),
            "{}",
            c.detail
        );
        assert!(c.fix.is_some());
    }

    #[test]
    fn git_version_gate() {
        assert_eq!(
            parse_git_version("git version 2.39.3 (Apple Git-146)"),
            Some((2, 39))
        );
        assert_eq!(git_version_check("git version 2.26.0").status, Status::Ok);
        let old = git_version_check("git version 2.25.1");
        assert_eq!(old.status, Status::Warn);
        assert!(old.fix.unwrap().contains("2.26"));
    }

    #[test]
    fn helper_check_requires_a_matching_version() {
        let ours = format!("git-remote-dash {}", env!("DASH_FORGE_VERSION"));
        let c = helper_check(Some((true, ours.clone())));
        assert_eq!(c.status, Status::Ok, "{}", c.detail);
        assert_eq!(c.detail, ours);

        let other_commit = format!(
            "git-remote-dash {} (000000000000 {})",
            env!("CARGO_PKG_VERSION"),
            env!("DASH_FORGE_TARGET")
        );
        let c = helper_check(Some((true, other_commit)));
        assert_eq!(c.status, Status::Ok, "{}", c.detail);
        assert!(c.detail.contains("different commit"), "{}", c.detail);

        let c = helper_check(Some((true, "git-remote-dash 9.9.9 (abc x)".into())));
        assert_eq!(c.status, Status::Fail);
        assert!(c.detail.contains("does not match dg"), "{}", c.detail);

        let c = helper_check(Some((true, "something else".into())));
        assert_eq!(c.status, Status::Fail);
        assert!(c.detail.contains("unrecognised"), "{}", c.detail);

        // An old helper treats `--version` as an unknown admin verb and exits non-zero.
        let c = helper_check(Some((false, String::new())));
        assert_eq!(c.status, Status::Fail);
        assert!(c.detail.contains("predates `--version`"), "{}", c.detail);

        let c = helper_check(None);
        assert_eq!(c.status, Status::Fail);
        assert!(c.detail.contains("not found on PATH"), "{}", c.detail);
    }

    #[test]
    fn balance_thresholds() {
        let one_dash = forge_core::cost::CREDITS_PER_DASH;
        assert_eq!(balance_check(0).status, Status::Fail);
        assert_eq!(balance_check(one_dash / 1000).status, Status::Warn);
        assert_eq!(balance_check(one_dash).status, Status::Ok);
    }

    #[cfg(unix)]
    #[test]
    fn fix_tightens_modes_and_creates_private_dirs() {
        let dir = tempfile_dir();
        let key = dir.join("id.json");
        std::fs::write(&key, "{}").unwrap();
        set_mode(&key, 0o644).unwrap();
        let c = file_mode_check(&key);
        assert_eq!(c.status, Status::Warn);
        c.auto.unwrap().apply().unwrap();
        assert_eq!(mode_of(&key), Some(0o600));
        assert_eq!(file_mode_check(&key).status, Status::Ok);

        let sub = dir.join("new/cfg");
        AutoFix::PrivateDir(sub.clone()).apply().unwrap();
        assert_eq!(mode_of(&sub), Some(0o700));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    fn tempfile_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "dg-doctor-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn public_probe_urls() {
        let profiles = StorageProfiles::parse(
            "[profiles.r2]\nkind = \"s3\"\nendpoint = \"https://a.r2.cloudflarestorage.com\"\nbucket = \"b\"\npublic_url = \"https://pub-1.r2.dev/\"\n\
             [profiles.kubo]\nkind = \"ipfs-kubo\"\napi = \"http://127.0.0.1:5001\"\npublic_gateway = \"https://gw.example\"\n\
             [profiles.private]\nkind = \"s3\"\nendpoint = \"https://s3.amazonaws.com\"\nbucket = \"b\"\n",
        )
        .unwrap();
        assert_eq!(
            public_probe_url(&profiles.get("r2").unwrap()).as_deref(),
            Some("https://pub-1.r2.dev/dash-forge-cors-check")
        );
        assert_eq!(
            public_probe_url(&profiles.get("kubo").unwrap()).as_deref(),
            Some("https://gw.example/ipfs/bafkqaaa")
        );
        assert_eq!(public_probe_url(&profiles.get("private").unwrap()), None);
    }

    #[test]
    fn network_fix_names_the_devnet() {
        let n = NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("moutai".into()),
            ..Default::default()
        }
        .resolve()
        .unwrap()
        .network;
        assert!(network_fix_command(&n).contains("dash.devnetName moutai"));
        assert_eq!(
            network_fix_command(&Network::Mainnet),
            "git config dash.network mainnet"
        );
    }
}
