//! `dg doctor` — check everything a push, clone or web read depends on, grouped the way the
//! UX spec (§7.5) lists them, each row `✓`/`!`/`✗` with the fix next to it.
//!
//! Sections: **toolchain** (git ≥ 2.26, `git-remote-dash` on PATH and the same version),
//! **identity** (config.toml parses, file, keys, permissions, on-chain existence and
//! balance), **network** (target, DAPI reachable, forge-v2 / protocol-14 contracts
//! present), **contracts** (where each id comes from), **storage** (every profile: valid,
//! secrets resolvable, web CORS preflight on its public URL), **read gateways** (every IPFS
//! read gateway and each IPFS profile's public gateway answer; an IPFS profile nobody else
//! can read through is flagged), **git config** (`dash.*` for this repository: storage
//! policy, cost guard, network agreement with `dg`).
//!
//! `--fix` applies only local, reversible, free fixes: create the config directories with
//! mode 0700, tighten an identity file to 0600, and set git config keys that are unset (the
//! spec's default cost guard). git needs no network fix for the network `dg auth` saved: the
//! helper reads it from `config.toml`. Doctor reports git config or environment values that
//! override it, with the command that fixes them in the right scope.
//! It never overwrites a value the user set and never signs or broadcasts anything.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Result;
use serde_json::{json, Value};

use forge_core::network::{
    NetworkSettings, NetworkTarget, ENV_DAPI_ADDRESSES, ENV_DEVNET_NAME, ENV_NETWORK,
    GIT_NETWORK_KEYS,
};
use forge_core::platform::{Network, PlatformClient};
use forge_core::storage::cors::probe_preflight;
use forge_core::storage::policy::git_config_scoped;
use forge_core::storage::{Profile, StoragePolicy, StorageProfiles};
use forge_core::user_error::{codes, redact, UserError};

use crate::config::{config_dir, config_path, Config};
use crate::context::Ctx;
use crate::fmt::{credits_to_dash, dash_amount};

/// The oldest git whose `git config --show-scope` the storage policy relies on (older ones
/// fall back to an unscoped read, which cannot rank a global `remote.*` key below a
/// repo-local `dash.*` one).
const MIN_GIT: (u32, u32) = (2, 26);

/// The spec's default push cost guard (UX spec §4 rule 4), in DASH. 0.05: on bonsia a tiny
/// push with its packs on Platform is quoted ~0.012 DASH (charged ~0.009), so the old 0.01
/// stopped every such push without a terminal (QW-080). A megabyte of packs still asks.
const DEFAULT_COST_WARN_THRESHOLD: &str = "0.05";

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
}

impl AutoFix {
    fn describe(&self) -> String {
        match self {
            AutoFix::PrivateDir(p) => format!("mkdir -p -m 700 {}", p.display()),
            AutoFix::PrivateFile(p) => format!("chmod 600 {}", p.display()),
            AutoFix::GitConfigGlobal(k, v) => format!("git config --global {k} {v}"),
        }
    }

    fn apply(&self) -> std::result::Result<(), String> {
        match self {
            AutoFix::PrivateDir(p) => {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
                set_mode(p, 0o700)
            }
            AutoFix::PrivateFile(p) => set_mode(p, 0o600),
            AutoFix::GitConfigGlobal(k, v) => {
                // Re-check: never overwrite a value that appeared since the check ran.
                if git_config_scoped(k).is_some() {
                    return Ok(());
                }
                let out = Command::new("git")
                    .args(["config", "--global", k, v.as_str()])
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
    let mut network = check_network(ctx).await;
    let contracts = contract_rows(
        &mut network,
        check_contracts(&ctx.target, unchosen_undeployed(ctx)),
    );
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
            checks: network,
        },
        Section {
            title: "contracts",
            checks: contracts,
        },
        Section {
            title: "storage",
            checks: check_storage().await,
        },
        Section {
            title: "read gateways",
            checks: check_read_gateways().await,
        },
        Section {
            title: "git config",
            checks: check_git_config(ctx),
        },
        Section {
            title: "pack copies",
            checks: check_pack_copies(ctx).await,
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
        format!("{} failed", crate::fmt::plural(failing.len(), "check")),
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
        "forgeV2": ctx.target.v2.as_ref().map(|ids| json!({
            "core": ids.core,
            "collab": ids.collab,
            "community": ids.community,
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
    print!("{}", render_sections(sections));
    println!(
        "\n{}",
        match (counts.failed, counts.warned) {
            (0, 0) => "Everything checks out.".to_string(),
            (0, w) => format!("{}. Nothing is broken.", crate::fmt::plural(w, "warning")),
            (f, w) => format!(
                "{}, {}.",
                crate::fmt::plural(f, "problem"),
                crate::fmt::plural(w, "warning")
            ),
        }
    );
    if counts.fixable > 0 && !fix {
        println!(
            "`dg doctor --fix` can fix {} of these (local changes only, nothing is spent).",
            counts.fixable
        );
    }
}

/// The sections' rows, each under its heading. A section with nothing to check here (pack
/// copies outside a repository) has no heading either (L-35: an empty "pack copies").
fn render_sections(sections: &[Section]) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    for s in sections.iter().filter(|s| !s.checks.is_empty()) {
        let _ = writeln!(out, "\n{}", s.title);
        for c in &s.checks {
            let _ = writeln!(out, "  {} {:<16} {}", c.status.mark(), c.name, c.detail);
            if let Some(f) = &c.fix {
                let _ = writeln!(out, "    {:<16} → {f}", "");
            }
        }
    }
    out
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
                // The row said what was wrong; now it says what was done (QW3-070: "✓ … is
                // unset … (fixed: …)").
                c.detail = format!("fixed: {what} (it was: {})", c.detail);
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
    out.extend(check_config_file());
    let Some(path) = ctx.identity_path.clone() else {
        out.push(Check::warn(
            "identity",
            "none configured (reads work; writes need one)",
            "`dg auth new` creates one; `dg auth login <file>` (or `--mnemonic`) signs in",
        ));
        return out;
    };
    let bridge = match ctx.load_bridge() {
        Ok(b) => b,
        // A sealed key with no terminal to ask on and no DASH_FORGE_PASSPHRASE is not broken
        // (QW3-025): say how to check it, and read the balance by the recorded id. Signing in
        // again would register (and pay for) another key.
        Err(e) if crate::auth::passphrase_unavailable(&e).is_some() => {
            let why = if ctx.json {
                "--json does not ask for it"
            } else {
                "no terminal to ask on"
            };
            out.push(Check::warn(
                "identity",
                format!(
                    "{}: passphrase-sealed, not opened ({why})",
                    forge_core::keystore::describe_key_source(&path)
                ),
                "set DASH_FORGE_PASSPHRASE, or run `dg doctor` (without --json) in a terminal, to check the key",
            ));
            if forge_core::keystore::is_file_source(&path) {
                out.push(file_mode_check(&path));
            }
            if let Some(id) = ctx.identity_id_hint() {
                out.push(balance_row(ctx, &id).await);
            }
            return out;
        }
        Err(e) => {
            out.push(Check::fail(
                "identity",
                format!(
                    "{}: {:#}",
                    forge_core::keystore::describe_key_source(&path),
                    e
                ),
                "sign in again: `dg auth login <file>` or `dg auth login --mnemonic`",
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
    if forge_core::keystore::is_file_source(&path) {
        out.push(file_mode_check(&path));
    }
    if bridge.doc_op_key().is_err() {
        out.push(Check::fail(
            "keys",
            "no HIGH or CRITICAL AUTHENTICATION key: nothing can be signed",
            "export the identity again from the bridge (it includes the auth keys)",
        ));
    }
    let client = ctx.connect().await;
    let identity = match &client {
        Ok(c) => Some(c.fetch_identity(&bridge.identity_id).await),
        Err(_) => None,
    };
    if bridge.doc_op_key().is_ok() {
        out.push(match (&client, &identity) {
            (Ok(c), Some(Ok(identity))) => {
                let report = crate::auth::key_report(c, identity, &bridge, ctx).await;
                let access = crate::auth::private_access(ctx, &bridge, Some(identity));
                keys_check(&report, &access, crate::auth::now_ms())
            }
            // Not on chain, or not reachable: the balance row says which; what the key file
            // holds is all that can be said.
            _ => Check::ok(
                "keys",
                "HIGH/CRITICAL auth key for writes (its limits on chain not checked)",
            ),
        });
    }
    out.push(balance_of(
        ctx,
        &bridge.identity_id,
        client.is_ok(),
        identity,
    ));
    out
}

/// The `balance` row for identity `id`, read on its own (the key was not opened).
async fn balance_row(ctx: &Ctx, id: &str) -> Check {
    let client = ctx.connect().await;
    let identity = match &client {
        Ok(c) => Some(c.fetch_identity(id).await),
        Err(_) => None,
    };
    balance_of(ctx, id, client.is_ok(), identity)
}

/// The `balance` row: what reading identity `id` gave (`None`: not read, Platform was not
/// reached).
fn balance_of(
    ctx: &Ctx,
    id: &str,
    reached: bool,
    identity: Option<forge_core::Result<forge_core::platform::LoadedIdentity>>,
) -> Check {
    match (reached, identity) {
        (false, _) | (_, None) => Check::warn(
            "balance",
            "not checked: Platform unreachable (see network)",
            "run `dg doctor` again when the network row passes",
        ),
        (true, Some(fetched)) => match fetched.map(|i| i.balance()) {
            Ok(credits) => balance_check(credits),
            Err(forge_core::Error::NotFound) => Check::fail(
                "balance",
                format!("identity {id} does not exist on {}", ctx.network_label()),
                "select the network it was created on: `--network testnet|mainnet` or `--network devnet --devnet-name <name>`",
            ),
            Err(e) => Check::warn(
                "balance",
                format!("could not read it: {e}"),
                "run `dg doctor` again in a minute",
            ),
        },
    }
}

/// The `keys` row: what the key in use can sign, as the chain says (QW2-005: a CI runner key
/// bound to `checkRun` passed as "HIGH/CRITICAL auth key for writes"), whether it still can
/// (budget, expiry, `now_ms`), and whether private repositories open with it (an `ENCRYPTION`
/// key held beside it).
fn keys_check(
    report: &crate::auth::KeyReport,
    access: &crate::auth::PrivateAccess,
    now_ms: u64,
) -> Check {
    let Some(key_id) = report.key_id else {
        let what = match report.disabled_id {
            Some(id) => format!("the key in use (#{id}) is disabled: it can no longer sign"),
            None => "the key in use is not a key of this identity (never registered, or another identity's)".into(),
        };
        return Check::fail(
            "keys",
            what,
            "sign in again: `dg auth login <file>` or `dg auth login --mnemonic`",
        );
    };
    let line = crate::auth::key_line(Some(report), None, true);
    if let Some(why) = report.spent_or_expired(now_ms) {
        let fix = if report.doc_type.is_some() {
            "`dg ci runner new` registers a fresh runner key".to_string()
        } else {
            format!("`dg auth keys add --replace {key_id}` registers a fresh limited key")
        };
        return Check::fail("keys", format!("{line}: {why}, so it signs nothing"), fix);
    }
    let also = crate::auth::private_line(Some(access), report.doc_type.is_some(), Some(key_id))
        .map(|l| format!("; {l}"))
        .unwrap_or_default();
    if !report.is_capped() {
        // An unlimited key can spend the whole balance: only dg's own confirm step caps a
        // write it signs (client-only-rules §11).
        return Check::warn(
            "keys",
            format!("{line}{also}: it can spend the whole balance"),
            "`dg auth login <identity file>` registers a key with a budget and expiry and stores only that",
        );
    }
    Check::ok("keys", format!("{line}{also}"))
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

/// A failing `config.toml` row when the file cannot be read or does not parse (every other
/// command stops on it with E204; doctor ran on the defaults instead). `None` when it loads.
fn check_config_file() -> Option<Check> {
    config_file_check(&config_path().ok()?)
}

fn config_file_check(path: &Path) -> Option<Check> {
    let err = Config::load_from(path).err()?;
    let u = forge_core::user_error::classify(
        err.chain(),
        &forge_core::user_error::ErrorContext::default(),
    );
    Some(Check::fail(
        "config.toml",
        format!(
            "{}; dg ignored it for this report (network and identity below are the defaults)",
            u.cause.unwrap_or(u.message)
        ),
        u.fix
            .first()
            .cloned()
            .unwrap_or_else(|| format!("fix {}", path.display())),
    ))
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
    if unchosen_undeployed(ctx) {
        return vec![Check::warn(
            "target",
            format!("no network chosen yet (the default, {network}, has no forge-v2)"),
            format!(
                "`dg auth new {}` records one (so does `dg auth login`)",
                deployed_network_flags()
            ),
        )];
    }
    let source = ctx.network_source;
    let quorums = ctx.target.quorum_base_url();
    let target = match network {
        Network::Devnet { dapi_addresses, .. } => format!(
            "{network}, {source} (DAPI: {}; quorums: {quorums})",
            if dapi_addresses.is_empty() {
                "discovered from the quorum service at connect".to_string()
            } else {
                crate::fmt::plural_with(dapi_addresses.len(), "address", "addresses")
            },
        ),
        _ => format!("{network}, {source} (DAPI: built-in seed list; quorums: {quorums})"),
    };
    let mut out = vec![Check::ok("target", target)];

    // DAPI + proof verification: fetch forge-core, or — with no forge-v2 on this network
    // (the contracts row fails for that) — the DPNS system contract.
    let (what, contract_id) = match &ctx.target.v2 {
        Some(ids) => ("forge-core contract", ids.core.as_str()),
        None => ("DPNS system contract", DPNS_CONTRACT_ID),
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
        // Platform answered: the node is fine, the contract is not there (E702).
        Err(e @ forge_core::Error::ContractsMissing { .. }) => Check::fail(
            "dapi",
            format!("reachable, but {e}"),
            "the network may have been reset: update dg to a release made after Forge was deployed on it again, or check the network selection",
        ),
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
    out.extend(check_forge_v2(&client, &ctx.target).await);
    out
}

/// The contracts section: one `forge-v2` row (QW-083 printed it under network and again
/// here). The network section's proof-verified row, when it ran, moves here: it says all the
/// recorded row does and whether the contracts are really there. Otherwise (a fresh install,
/// no deployment, a DAPI that could not be reached) the recorded row is all there is.
fn contract_rows(network: &mut Vec<Check>, recorded: Check) -> Vec<Check> {
    match network.iter().position(|c| c.name == "forge-v2") {
        Some(i) => vec![network.remove(i)],
        None => vec![recorded],
    }
}

/// Where the forge-v2 contract ids for `target` come from.
fn deployment_source(target: &NetworkTarget) -> String {
    format!("forge-contracts/deployments/{}.json", target.network.key())
}

/// The DPNS system contract: its id is fixed by rs-dpp and identical on every network.
const DPNS_CONTRACT_ID: &str = "GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec";

/// The forge-v2 contracts recorded for this network: each must fetch with a verified proof
/// and be enrolled, as whole contracts, in the recorded contract group. `None` for a network
/// with no forge-v2 deployment: [`check_contracts`]' row reports that.
async fn check_forge_v2(client: &PlatformClient, target: &NetworkTarget) -> Option<Check> {
    let ids = target.v2.as_ref()?;
    let mut problems = Vec::new();
    // forge-community is forge-collab on a deployment that predates the split: checked once
    let mut contracts = ids.all().to_vec();
    contracts.dedup_by(|a, b| a.1 == b.1);
    for (label, id) in contracts {
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
    Some(if problems.is_empty() {
        Check::ok(
            "forge-v2",
            format!(
                "core={} collab={} community={} proof-verified and enrolled in group {} (source: {})",
                ids.core,
                ids.collab,
                ids.community,
                ids.group,
                deployment_source(target)
            ),
        )
    } else {
        Check::fail(
            "forge-v2",
            problems.join("; "),
            "the network may not run protocol 14 yet, or the deployment record is stale",
        )
    })
}

/// A fresh install: no flag, `config.toml` or environment chose a network, and the default
/// one has no forge-v2 deployment. The network rows are then one warning naming what to do,
/// instead of probing (and failing on) a network nobody picked (L-33).
fn unchosen_undeployed(ctx: &Ctx) -> bool {
    // A config.toml that does not parse may well name a network: its own row says so.
    ctx.network_is_default && ctx.target.v2.is_none() && check_config_file().is_none()
}

/// The `dg` flags that select a network with a forge-v2 deployment.
fn deployed_network_flags() -> String {
    forge_core::network::suggested_v2_network()
        .map_or_else(|| "--network <a deployed network>".into(), |n| n.dg_flags())
}

/// The forge-v2 contracts this invocation will use and where they came from. A network with
/// no deployment fails here with the same actionable message the commands give, unless this
/// is a fresh install ([`unchosen_undeployed`]), which only warns.
fn check_contracts(target: &NetworkTarget, fresh_install: bool) -> Check {
    if fresh_install {
        return Check::warn(
            "forge-v2",
            format!("none on {}, the default network", target.network),
            format!(
                "choose a network with a deployment: `dg auth new {}`",
                deployed_network_flags()
            ),
        );
    }
    match target.require_v2() {
        Ok(ids) => Check::ok(
            "forge-v2",
            format!(
                "core={} collab={} community={} group={} (source: {})",
                ids.core,
                ids.collab,
                ids.community,
                ids.group,
                deployment_source(target)
            ),
        ),
        Err(e) => Check::fail(
            "forge-v2",
            e.to_string(),
            format!(
                "use a network with a deployment: `{}`",
                deployed_network_flags()
            ),
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
            format!(
                "none in {path}: pushes store packs on Platform ({}); `dg storage add` adds your own bucket",
                crate::fmt::platform_rate()
            ),
        )];
    }
    let http = forge_core::storage::http_client();
    let mut out = Vec::new();
    for (name, profile) in &profiles.profiles {
        out.push(profile_check(name, profile));
        for w in crate::storage::publish_warnings(profile) {
            out.push(Check::warn(
                "public address",
                format!("{name}: {w}"),
                format!("re-add it with a public https address: `dg storage add {name} …`"),
            ));
        }
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
        // The empty identity CID: every gateway can serve it.
        _ => profile.public_gateway().map(|g| {
            format!(
                "{}/ipfs/{}",
                g.trim_end_matches('/'),
                forge_core::storage::read::IDENTITY_CID
            )
        }),
    }
}

// --- read gateways -----------------------------------------------------------------------

/// Probe every IPFS read gateway (`[read] ipfs_gateways`, else the shared defaults) and the
/// public gateway of every IPFS profile with the empty identity CID.
async fn check_read_gateways() -> Vec<Check> {
    use forge_core::storage::read::{probe_gateways, GATEWAY_PROBE_TIMEOUT};
    let profiles = StorageProfiles::load().unwrap_or_default();
    let list = profiles.ipfs_gateways();
    let mut all = list.clone();
    for p in profiles.profiles.values() {
        if let Some(g) = p
            .public_gateway()
            .map(|g| g.trim_end_matches('/').to_string())
        {
            if !all.contains(&g) {
                all.push(g);
            }
        }
    }
    let health = probe_gateways(
        &forge_core::storage::http_client(),
        &all,
        GATEWAY_PROBE_TIMEOUT,
    )
    .await;
    gateway_checks(&profiles, &list, &health)
}

/// The rows for [`check_read_gateways`], from probe results (pure, for tests).
fn gateway_checks(
    profiles: &StorageProfiles,
    list: &[String],
    health: &[(String, forge_core::storage::read::GatewayHealth)],
) -> Vec<Check> {
    let up = |g: &str| health.iter().any(|(h, s)| h == g && s.is_up());
    let why = |g: &str| {
        health
            .iter()
            .find(|(h, _)| h == g)
            .map_or_else(|| "not probed".to_string(), |(_, s)| s.describe())
    };
    let custom = profiles
        .read
        .ipfs_gateways
        .as_ref()
        .is_some_and(|l| !l.is_empty());
    let source = if custom {
        "[read] ipfs_gateways"
    } else {
        "the built-in defaults"
    };
    let mut out = Vec::new();
    let dead: Vec<String> = list
        .iter()
        .filter(|g| !up(g))
        .map(|g| format!("{g} ({})", why(g)))
        .collect();
    let live = list.iter().filter(|g| up(g)).count();
    out.push(if dead.is_empty() {
        Check::ok("gateways", format!("{live} of {} up ({source})", list.len()))
    } else if live > 0 {
        // QW4-057: with the built-in list there is no `[read]` section to drop one from: the
        // fix writes the list that answered here (a gateway can also be blocked by this
        // network's DNS, not down for everyone).
        let fix = if custom {
            "drop the ones that do not answer from [read] ipfs_gateways in storage.toml (reads skip them, at the cost of a timeout)".to_string()
        } else {
            let answered: Vec<String> = list
                .iter()
                .filter(|g| up(g))
                .map(|g| format!("\"{g}\""))
                .collect();
            // storage.toml may hold a `[read]` table already (an empty list keeps the defaults):
            // then the line goes in it, never a second table.
            let place = if profiles.read.ipfs_gateways.is_some() {
                "set it in storage.toml's `[read]` table"
            } else {
                "add to storage.toml (beside config.toml) a `[read]` table with"
            };
            format!(
                "reads skip them, at the cost of a timeout; if one stays unreachable from this network, {place} `ipfs_gateways = [{}]` (it replaces the built-in list, so later changes to it no longer reach you)",
                answered.join(", ")
            )
        };
        Check::warn(
            "gateways",
            format!(
                "{live} of {} answer from here ({source}); not answering: {}",
                list.len(),
                dead.join(", ")
            ),
            fix,
        )
    } else {
        // A warning, not a failure: repos on Platform or S3 storage need no gateway.
        Check::warn(
            "gateways",
            format!("none of the IPFS read gateways answers ({source}): {}", dead.join(", ")),
            "add a working gateway to [read] ipfs_gateways in storage.toml, e.g. `ipfs_gateways = [\"https://ipfs.filebase.io\"]`; until then ipfs:// copies are unreadable except through a repo's own public gateway",
        )
    });
    // An IPFS-only profile must be reachable through SOME gateway, or what it stores is
    // unreadable by anyone else.
    for (name, p) in &profiles.profiles {
        if !matches!(p, Profile::IpfsKubo(_) | Profile::IpfsPinningService(_)) {
            continue;
        }
        let own = p.public_gateway().map(|g| g.trim_end_matches('/'));
        let row = match own {
            Some(g) if up(g) => Check::ok("ipfs reach", format!("{name}: public gateway {g} is up")),
            Some(g) => Check::warn(
                "ipfs reach",
                format!("{name}: its public gateway {g} does not answer ({})", why(g)),
                "readers fall back to the shared gateways, which may not reach your node: fix the gateway, or keep a second, non-IPFS copy (`dg storage use <this>,<another>`)",
            ),
            // A pinning service holds the content on its own well-connected nodes.
            None if matches!(p, Profile::IpfsPinningService(_)) => Check::ok(
                "ipfs reach",
                format!("{name}: no public_gateway; the pinning service serves the content to the shared gateways"),
            ),
            None if live == 0 => Check::warn(
                "ipfs reach",
                format!("{name}: no public_gateway, and no shared gateway is up: nobody else can read what it stores"),
                format!("set one: `dg storage add {name} --kind {} … --public-gateway https://<a gateway that reaches your node>`, add a working gateway to [read] ipfs_gateways, or pair it with a non-IPFS profile", p.kind()),
            ),
            None => Check::ok(
                "ipfs reach",
                format!("{name}: no public_gateway: readers use the shared gateways, which must find your node on the IPFS network (`dg storage test {name}` checks; a node behind NAT often cannot be found)"),
            ),
        };
        out.push(row);
    }
    out
}

// --- git config --------------------------------------------------------------------------

fn check_git_config(ctx: &Ctx) -> Vec<Check> {
    let get = |k: &str| git_config_scoped(k).map(|(_, v)| v);
    let mut out = Vec::new();

    // What a `git` command resolves (env > git config > dg's config.toml, as the helper
    // does) against what dg uses. dg's own choice is the reference: a mismatch is fixed on
    // git's side, in the scope that holds the conflicting value.
    let helper_net = NetworkSettings::for_git_helper(get)
        .and_then(NetworkSettings::resolve)
        .map(|t| t.network.key());
    let dg_net = ctx.network_label();
    out.push(match helper_net {
        Ok(h) if h == dg_net => Check::ok("dash.network", format!("git uses {h}, same as dg")),
        // dg is on the built-in default only because nothing chose a network: aligning git
        // with it would move a working setup onto a network without Forge (QW-032).
        Ok(h) if ctx.network_is_default => Check::warn(
            "dash.network",
            format!("git uses {h}, but dg uses {dg_net} only because nothing chose a network for it"),
            {
                let flags = Network::from_key(&h).dg_flags();
                format!("pass `{flags}` to dg, or sign in there once so dg records it: `dg auth login <file> {flags}`")
            },
        ),
        Ok(h) => Check::warn(
            "dash.network",
            format!("git would use {h}, but dg uses {dg_net}"),
            network_fix_command(
                ctx.network(),
                &GitNetworkSource::detect(ctx.network()),
                in_git_repo(),
            ),
        ),
        Err(e) => git_network_unresolved(&e),
    });

    out.push(cost_guard_check(
        get("dash.costWarnThreshold").as_deref(),
        get("dash.confirm").as_deref(),
    ));

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
        Ok(p) if p.is_platform_only() => Check::ok("dash.storage", platform_only_detail(storage.as_deref())),
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

/// The `cost guard` row: what a push does before it spends, from `dash.costWarnThreshold` and
/// `dash.confirm` together, as git-remote-dash's guard decides it (QW4-055: the row read the
/// threshold alone, "pushes above 0.05 DASH ask first", whatever dash.confirm said).
fn cost_guard_check(threshold: Option<&str>, confirm: Option<&str>) -> Check {
    // A mode the helper rejects fails every push, whatever the threshold says.
    if let Some(c) = confirm.and_then(confirm_check) {
        return c;
    }
    let mode = confirm.map(|c| c.trim().to_ascii_lowercase());
    // `auto` when unset or empty (`confirm_check` passed the rest).
    let mode = match mode.as_deref() {
        Some("always" | "true" | "yes") => "always",
        Some("never" | "false" | "no") => "never",
        Some("refuse") => "refuse",
        _ => "auto",
    };
    let threshold = match threshold {
        Some(v)
            if v.trim()
                .parse::<f64>()
                .is_ok_and(|x| x.is_finite() && x >= 0.0) =>
        {
            Some(v.trim())
        }
        Some(v) => {
            return Check::fail(
                "cost guard",
                format!("dash.costWarnThreshold = {v:?} is not a DASH amount: every push fails"),
                format!("git config dash.costWarnThreshold {DEFAULT_COST_WARN_THRESHOLD}"),
            )
        }
        None => None,
    };
    match (mode, threshold) {
        ("never", Some(t)) => Check::ok(
            "cost guard",
            format!("pushes never ask (dash.confirm=never), whatever they cost; dash.costWarnThreshold {t} is not used"),
        ),
        ("never", None) => Check::ok("cost guard", "pushes never ask (dash.confirm=never)"),
        ("always", _) => Check::ok(
            "cost guard",
            "every paid push asks first (dash.confirm=always); without a terminal it is refused",
        ),
        ("refuse", Some(t)) => Check::ok(
            "cost guard",
            format!("pushes above {t} DASH fail without asking (dash.confirm=refuse)"),
        ),
        ("refuse", None) => Check::warn(
            "cost guard",
            "dash.confirm=refuse caps nothing: dash.costWarnThreshold is unset, so no push is refused",
            format!("git config --global dash.costWarnThreshold {DEFAULT_COST_WARN_THRESHOLD}"),
        ),
        (_, Some(t)) => Check::ok("cost guard", format!("pushes above {t} DASH ask first")),
        (_, None) => Check::warn(
            "cost guard",
            "dash.costWarnThreshold is unset: pushes never ask before spending",
            format!("git config --global dash.costWarnThreshold {DEFAULT_COST_WARN_THRESHOLD}"),
        )
        .auto(AutoFix::GitConfigGlobal(
            "dash.costWarnThreshold",
            DEFAULT_COST_WARN_THRESHOLD.into(),
        )),
    }
}

/// The `dash.confirm` row, only for a value the remote helper rejects. Keep in step with
/// git-remote-dash's `ConfirmMode::parse`: `auto`, `always`, `never` and `refuse`, plus the
/// boolean aliases.
fn confirm_check(v: &str) -> Option<Check> {
    let valid = matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "" | "auto" | "always" | "never" | "refuse" | "true" | "false" | "yes" | "no"
    );
    (!valid).then(|| {
        Check::fail(
            "dash.confirm",
            format!("{v:?} is not auto, always, never or refuse: every push fails"),
            "git config dash.confirm auto",
        )
    })
}

/// The `dash.storage` row's detail for a Platform-only policy: the value as set (`platform`),
/// or `unset` when there is none (QW2-081: a repo set to `platform` read "unset").
fn platform_only_detail(value: Option<&str>) -> String {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => format!("{v}: pushes store packs on Platform"),
        None => "unset: pushes store packs on Platform".to_string(),
    }
}

/// The `dash.network` row when git's network does not resolve: a `config.toml` that does
/// not parse (E204, reported on its own row) is a pointer to that row; anything else is a
/// bad `dash.*` value in git config.
fn git_network_unresolved(e: &forge_core::Error) -> Check {
    if matches!(e, forge_core::Error::User(u) if u.code == codes::INVALID_CONFIG) {
        return Check::warn(
            "dash.network",
            "git reads its default network from config.toml, which does not parse",
            "fix config.toml (see the config.toml row above)",
        );
    }
    Check::fail(
        "dash.network",
        format!("git's network does not resolve: {e}"),
        "fix or unset the dash.network / dash.devnetName / dash.dapiAddresses values",
    )
}

// --- pack copies -------------------------------------------------------------------------

/// Whether this repository's live packs have the copies its storage policy asks for. A
/// policy applies only to packs pushed after it was set, so older packs can have fewer.
async fn check_pack_copies(ctx: &Ctx) -> Vec<Check> {
    const NAME: &str = "copies";
    if !in_git_repo() {
        return Vec::new();
    }
    // A broken policy is reported under git config already; a Platform-only one or one
    // asking for a single copy has nothing to check (existing_copies returns None).
    let Ok(policy) = crate::storage::push_policy() else {
        return Vec::new();
    };
    match crate::storage::existing_copies(ctx, &policy).await {
        Ok(None) => Vec::new(),
        Ok(Some(e)) if e.count.thin.is_empty() => vec![Check::ok(
            NAME,
            format!(
                "every live pack of {} has at least {}",
                e.repo,
                e.required_copies()
            ),
        )],
        Ok(Some(e)) => vec![Check::warn(
            NAME,
            format!(
                "{}: they were pushed before this storage policy, and a storage outage can make them unreadable",
                e.summary()
            ),
            format!("{} stores them again as one consolidated pack (asks first)", e.fix),
        )],
        Err(err) => vec![Check::warn(
            NAME,
            format!("could not read this repository's pack manifests: {err:#}"),
            "run `dg doctor` again when Dash Platform is reachable",
        )],
    }
}

/// Where git's conflicting network setting comes from.
struct GitNetworkSource {
    /// `DASH_FORGE_NETWORK` / `DASH_FORGE_DEVNET_NAME` are set: the helper reads them before
    /// any config.
    env: bool,
    /// The git config scope (`local`, `global`, `system`, ...) holding `dash.network` or
    /// `dash.devnetName`, if any.
    scope: Option<String>,
}

impl GitNetworkSource {
    /// Where git's network comes from, for a mismatch with `want` (dg's network).
    fn detect(want: &Network) -> Self {
        Self::from_parts(
            &NetworkSettings::from_env(),
            want,
            GIT_NETWORK_KEYS.map(git_config_scoped),
        )
    }

    /// The environment is to blame only when it picks a network by itself and that is not
    /// `want`; the scope is the highest-precedence one holding either key.
    fn from_parts(
        env: &NetworkSettings,
        want: &Network,
        scoped: [Option<(String, String)>; 2],
    ) -> Self {
        let env_decides = env.clone().resolve().ok().filter(|_| !env.is_unset());
        Self {
            env: env_decides.is_some_and(|t| t.network.key() != want.key()),
            scope: scoped
                .into_iter()
                .flatten()
                .map(|(scope, _)| scope)
                .max_by_key(|scope| scope_rank(scope)),
        }
    }
}

/// git config precedence: command line > worktree > local > global > system.
fn scope_rank(scope: &str) -> u8 {
    match scope {
        "command" => 4,
        "worktree" => 3,
        "local" => 2,
        "global" => 1,
        _ => 0,
    }
}

/// The command that makes git use `n`. The environment wins over git config in the helper,
/// so an override there is dropped first. Otherwise git config is set where the conflicting
/// value lives: this repository's config only for a repo-local value inside the repository,
/// else `--global`, which also works outside a repository (L-24) and outranks a system value.
fn network_fix_command(n: &Network, from: &GitNetworkSource, in_repo: bool) -> String {
    if from.env {
        return format!(
            "unset {ENV_NETWORK} {ENV_DEVNET_NAME} {ENV_DAPI_ADDRESSES} (git reads them before any config)"
        );
    }
    // A worktree value outranks a local one, so it is fixed in its own scope.
    let scope = match from.scope.as_deref() {
        Some("worktree") if in_repo => "--worktree ",
        Some("local") if in_repo => "",
        _ => "--global ",
    };
    n.git_config_command(scope)
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

    /// An unlimited key can spend the whole balance: doctor warns and names the fix.
    #[test]
    fn an_unlimited_key_is_a_warning() {
        use crate::auth::{KeyReport, PrivateAccess};
        let access = PrivateAccess::for_test(&[4], true);
        let unlimited = keys_check(&KeyReport::for_test(3, false), &access, 0);
        assert!(
            matches!(unlimited.status, Status::Warn),
            "{}",
            unlimited.detail
        );
        assert!(
            unlimited.detail.contains("whole balance"),
            "{}",
            unlimited.detail
        );
        assert!(unlimited
            .fix
            .as_deref()
            .is_some_and(|f| f.contains("dg auth login")));
        let limited = keys_check(&KeyReport::for_test(5, true), &access, 0);
        assert!(matches!(limited.status, Status::Ok), "{}", limited.detail);
    }

    /// QW2-081: a repository set to `platform` says so; only a missing value is "unset".
    #[test]
    fn a_platform_storage_value_is_named_not_called_unset() {
        assert_eq!(
            platform_only_detail(Some("platform")),
            "platform: pushes store packs on Platform"
        );
        assert_eq!(
            platform_only_detail(None),
            "unset: pushes store packs on Platform"
        );
        assert_eq!(
            platform_only_detail(Some("  ")),
            "unset: pushes store packs on Platform"
        );
    }

    /// QW4-055: the cost guard row follows dash.confirm, not the threshold alone.
    #[test]
    fn the_cost_guard_row_follows_dash_confirm() {
        let detail = |t: Option<&str>, c: Option<&str>| cost_guard_check(t, c).detail;
        assert_eq!(
            detail(Some("0.05"), None),
            "pushes above 0.05 DASH ask first"
        );
        assert_eq!(
            detail(Some("0.05"), Some("auto")),
            "pushes above 0.05 DASH ask first"
        );
        assert!(detail(Some("0.05"), Some("never"))
            .starts_with("pushes never ask (dash.confirm=never)"));
        assert!(detail(Some("0.05"), Some("always")).starts_with("every paid push asks first"));
        assert_eq!(
            detail(Some("0.05"), Some("refuse")),
            "pushes above 0.05 DASH fail without asking (dash.confirm=refuse)"
        );
        assert!(detail(None, Some("refuse")).contains("caps nothing"));
        assert!(detail(Some("x"), Some("never")).contains("is not a DASH amount"));
        // An invalid mode fails every push: the row says so, not "ask first".
        let bad = cost_guard_check(Some("0.05"), Some("maybe"));
        assert_eq!(bad.status, Status::Fail);
        assert!(bad.detail.contains("every push fails"), "{}", bad.detail);
    }

    /// Every `dash.confirm` value the remote helper accepts passes, `refuse` included (the
    /// mode forge-import and the Mirror Action set, and `costs.md` documents).
    #[test]
    fn dash_confirm_accepts_every_mode_the_helper_does() {
        for v in [
            "", "auto", "always", "never", "refuse", "REFUSE", " refuse ", "true", "false", "yes",
            "no",
        ] {
            assert!(confirm_check(v).is_none(), "{v:?} was flagged");
        }
        let c = confirm_check("sometimes").expect("an unknown mode fails");
        assert!(c.detail.contains("refuse"), "{}", c.detail);
    }

    /// The guard `dg doctor --fix` sets lets a small push through without asking, packs on
    /// Platform included (its quote is an upper bound), and still asks before a megabyte.
    #[test]
    fn the_default_cost_guard_admits_a_small_platform_push() {
        use forge_core::cost::push_fees::{estimate_push, history_index, PushShape};
        let threshold: f64 = DEFAULT_COST_WARN_THRESHOLD.parse().unwrap();
        // The remote helper compares the guard with the push's quote plus the history index it
        // publishes with it (a first one, stored on Platform, ~1–2 KB).
        let history = history_index(2_000, false, 0, true, true);
        let small = PushShape {
            pack_bytes: 2_000,
            objects: 10,
            index_objects: 10,
            refs: 1,
            platform_bytes: true,
            ..PushShape::default()
        };
        let quote = credits_to_dash(estimate_push(&small).total() + history);
        assert!(
            quote < threshold,
            "a small Platform push is quoted {quote} DASH, above the {threshold} DASH guard"
        );
        let mib = PushShape {
            pack_bytes: 1 << 20,
            objects: 200,
            index_objects: 200,
            ..small
        };
        assert!(credits_to_dash(estimate_push(&mib).total() + history) > threshold);
    }

    #[test]
    fn a_section_with_no_rows_has_no_heading() {
        let sections = [
            Section {
                title: "git config",
                checks: vec![Check::ok("dash.network", "devnet-moutai")],
            },
            Section {
                title: "pack copies",
                checks: Vec::new(),
            },
        ];
        let out = render_sections(&sections);
        assert!(out.contains("git config"), "{out}");
        assert!(!out.contains("pack copies"), "L-35: {out}");
    }

    #[test]
    fn a_config_toml_that_does_not_parse_is_a_failing_row() {
        // D-405: doctor used to show "✓ config dir" and run on testnet defaults.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        assert!(
            config_file_check(&path).is_none(),
            "absent: nothing to report"
        );
        std::fs::write(&path, "network = \"devnet\"\n").unwrap();
        assert!(
            config_file_check(&path).is_none(),
            "valid: nothing to report"
        );
        std::fs::write(&path, "network = \"devnet\"\ndefault_identity = \n").unwrap();
        let c = config_file_check(&path).expect("a failing row");
        assert_eq!(c.status, Status::Fail);
        assert!(c.detail.contains("line 2, column 20"), "{}", c.detail);
        assert!(c.detail.contains("defaults"), "{}", c.detail);
        assert_eq!(
            c.fix.as_deref(),
            Some(format!("fix line 2 of {}", path.display()).as_str())
        );
    }

    fn gw_health(list: &[(&str, bool)]) -> Vec<(String, forge_core::storage::read::GatewayHealth)> {
        use forge_core::storage::read::GatewayHealth;
        list.iter()
            .map(|(g, up)| {
                let h = if *up {
                    GatewayHealth::Up
                } else {
                    GatewayHealth::Retired("429 with Sunset".into())
                };
                ((*g).to_string(), h)
            })
            .collect()
    }

    #[test]
    fn an_ipfs_only_profile_with_no_working_gateway_is_flagged() {
        let profiles = StorageProfiles::parse(
            "[profiles.k]\nkind = \"ipfs-kubo\"\napi = \"http://127.0.0.1:5001\"\n",
        )
        .unwrap();
        let list = vec![
            "https://a.example".to_string(),
            "https://b.example".to_string(),
        ];
        let rows = gateway_checks(
            &profiles,
            &list,
            &gw_health(&[("https://a.example", false), ("https://b.example", false)]),
        );
        assert_eq!(rows[0].name, "gateways");
        assert_eq!(rows[0].status, Status::Warn, "{}", rows[0].detail);
        assert!(rows[0].detail.contains("none of the IPFS read gateways"));
        assert_eq!(rows[1].name, "ipfs reach");
        assert_eq!(rows[1].status, Status::Warn);
        assert!(
            rows[1].detail.contains("nobody else can read"),
            "{}",
            rows[1].detail
        );

        // One gateway up: the list warns about the dead one, and the profile row still says
        // it depends on the shared gateways finding the node.
        let rows = gateway_checks(
            &profiles,
            &list,
            &gw_health(&[("https://a.example", true), ("https://b.example", false)]),
        );
        assert_eq!(rows[0].status, Status::Warn);
        assert!(
            rows[0].detail.contains("1 of 2 answer from here"),
            "{}",
            rows[0].detail
        );
        // QW4-057: with the built-in list, the fix writes the section that replaces it, naming
        // the gateway that answered.
        let fix = rows[0].fix.as_deref().unwrap();
        assert!(
            fix.contains("ipfs_gateways = [\"https://a.example\"]"),
            "{fix}"
        );
        assert!(fix.contains("replaces the built-in list"), "{fix}");
        assert!(
            fix.contains("add to storage.toml (beside config.toml) a `[read]` table"),
            "{fix}"
        );
        assert!(
            rows[1].detail.contains("no public_gateway"),
            "{}",
            rows[1].detail
        );
        assert_eq!(
            rows[1].status,
            Status::Ok,
            "a shared gateway is up: only a note"
        );

        // A pinning service needs no public gateway of its own, even with none up.
        let pinning = StorageProfiles::parse(
            "[profiles.p]\nkind = \"ipfs-pinning-service\"\napi = \"http://127.0.0.1:5001\"\n\
             pinning_endpoint = \"https://pins.example/psa\"\npinning_token = \"env:T\"\n",
        )
        .unwrap();
        let rows = gateway_checks(
            &pinning,
            &list,
            &gw_health(&[("https://a.example", false), ("https://b.example", false)]),
        );
        assert_eq!(rows[1].status, Status::Ok, "{}", rows[1].detail);
    }

    #[test]
    fn a_profile_with_a_live_public_gateway_is_ok() {
        let profiles = StorageProfiles::parse(
            "[profiles.k]\nkind = \"ipfs-kubo\"\napi = \"http://127.0.0.1:5001\"\n\
             public_gateway = \"https://mine.example\"\n",
        )
        .unwrap();
        let list = vec!["https://a.example".to_string()];
        let rows = gateway_checks(
            &profiles,
            &list,
            &gw_health(&[("https://a.example", true), ("https://mine.example", true)]),
        );
        assert!(rows.iter().all(|c| c.status == Status::Ok));
    }

    /// QW-083: the forge-v2 row was printed under network and again under contracts.
    #[test]
    fn the_forge_v2_row_is_printed_once() {
        let recorded = || Check::ok("forge-v2", "core=a (source: deployments/x.json)");
        let proved = Check::ok("forge-v2", "core=a proof-verified and enrolled in group g");
        let mut network = vec![
            Check::ok("dapi", "reachable"),
            Check::ok("protocol", "14"),
            proved,
        ];
        let contracts = contract_rows(&mut network, recorded());
        assert_eq!(contracts.len(), 1);
        assert!(
            contracts[0].detail.contains("proof-verified"),
            "the live row is kept"
        );
        let sections = [
            Section {
                title: "network",
                checks: network,
            },
            Section {
                title: "contracts",
                checks: contracts,
            },
        ];
        let out = render_sections(&sections);
        assert_eq!(out.matches("forge-v2").count(), 1, "{out}");

        // No live row (fresh install, no deployment, DAPI down): the recorded one stands.
        let mut network = vec![Check::fail("dapi", "could not connect", "retry")];
        let contracts = contract_rows(&mut network, recorded());
        assert!(contracts[0].detail.contains("source:"));
        assert_eq!(network.len(), 1);
    }

    #[test]
    fn contracts_check_reports_the_deployment_file_as_the_source() {
        let target = NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("moutai".into()),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        let c = check_contracts(&target, false);
        assert_eq!(c.status, Status::Ok, "{}", c.detail);
        assert!(
            c.detail
                .contains("source: forge-contracts/deployments/devnet-moutai.json"),
            "{}",
            c.detail
        );
    }

    #[test]
    fn contracts_check_fails_clearly_on_an_undeployed_devnet() {
        let target = NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("paloma".into()),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        let c = check_contracts(&target, false);
        assert_eq!(c.status, Status::Fail);
        assert!(
            c.detail
                .contains("forge-v2 isn't deployed on devnet-paloma yet"),
            "{}",
            c.detail
        );
        assert!(c.fix.is_some());
    }

    #[test]
    fn a_fresh_install_warns_instead_of_failing_on_testnet() {
        // L-33: the quick start's first `dg doctor` (nothing configured) exited 1 with E104.
        let testnet = NetworkSettings::default().resolve().unwrap();
        let c = check_contracts(&testnet, true);
        assert_eq!(c.status, Status::Warn, "{}", c.detail);
        assert!(
            c.fix
                .as_deref()
                .unwrap()
                // the live network with forge-v2, or a placeholder before any is registered
                .contains(&format!("dg auth new {}", deployed_network_flags())),
            "{:?}",
            c.fix
        );
        // Chosen explicitly (`--network testnet`), it is still the failure it was.
        assert_eq!(check_contracts(&testnet, false).status, Status::Fail);
    }

    #[test]
    fn the_env_is_blamed_only_when_it_picks_another_network() {
        let moutai = Network::from_key("devnet-moutai");
        let env = |n: &str, name: Option<&str>| NetworkSettings {
            network: Some(n.into()),
            devnet_name: name.map(str::to_string),
            ..Default::default()
        };
        let none = || [None, None];
        // The env names moutai too: a global mainnet git config is what to fix.
        let s = GitNetworkSource::from_parts(&env("devnet", Some("moutai")), &moutai, none());
        assert!(!s.env);
        assert!(GitNetworkSource::from_parts(&env("mainnet", None), &moutai, none()).env);
        // A bare `devnet` names no network by itself.
        assert!(!GitNetworkSource::from_parts(&env("devnet", None), &moutai, none()).env);
        assert!(!GitNetworkSource::from_parts(&NetworkSettings::default(), &moutai, none()).env);
    }

    #[test]
    fn the_scope_is_the_strongest_one_holding_either_key() {
        let moutai = Network::from_key("devnet-moutai");
        let at = |scope: &str| Some((scope.to_string(), "x".to_string()));
        let s = GitNetworkSource::from_parts(
            &NetworkSettings::default(),
            &moutai,
            [at("global"), at("local")],
        );
        assert_eq!(s.scope.as_deref(), Some("local"));
        let s = GitNetworkSource::from_parts(
            &NetworkSettings::default(),
            &moutai,
            [None, at("global")],
        );
        assert_eq!(s.scope.as_deref(), Some("global"));
    }

    #[test]
    fn a_broken_config_toml_points_the_network_row_at_its_own_row() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "network = \n").unwrap();
        let e = NetworkSettings::from_dg_config_file(&path).unwrap_err();
        let c = git_network_unresolved(&e);
        assert_eq!(c.status, Status::Warn);
        assert!(c.fix.unwrap().contains("config.toml row"));
        let other = forge_core::Error::Config("unknown network \"x\"".into());
        assert_eq!(git_network_unresolved(&other).status, Status::Fail);
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
    fn network_fix_names_the_devnet_and_the_scope() {
        let moutai = NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("moutai".into()),
            ..Default::default()
        }
        .resolve()
        .unwrap()
        .network;
        let from = |scope: Option<&str>| GitNetworkSource {
            env: false,
            scope: scope.map(str::to_string),
        };
        // L-24: outside a repository (where the quick start runs doctor), the repo-local
        // form fails; the fix is --global.
        assert_eq!(
            network_fix_command(&moutai, &from(None), false),
            "git config --global dash.network devnet && git config --global dash.devnetName moutai"
        );
        assert_eq!(
            network_fix_command(&moutai, &from(Some("global")), true),
            "git config --global dash.network devnet && git config --global dash.devnetName moutai"
        );
        // A repo-local value is fixed where it lives.
        assert_eq!(
            network_fix_command(&Network::Mainnet, &from(Some("local")), true),
            "git config dash.network mainnet"
        );
        assert_eq!(
            network_fix_command(&Network::Mainnet, &from(Some("worktree")), true),
            "git config --worktree dash.network mainnet"
        );
        // ... but not from outside that repository.
        assert_eq!(
            network_fix_command(&Network::Mainnet, &from(Some("local")), false),
            "git config --global dash.network mainnet"
        );
        // The environment beats any git config in the helper: drop it first.
        let env = GitNetworkSource {
            env: true,
            scope: Some("global".into()),
        };
        assert!(network_fix_command(&moutai, &env, true).starts_with("unset DASH_FORGE_NETWORK"));
    }
}
