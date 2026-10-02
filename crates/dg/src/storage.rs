//! `dg storage` — the user's storage profiles and a repo's storage policy.
//!
//! - `add | list | remove` — manage `~/.config/dash-forge/storage.toml` (secrets are
//!   `env:`/`keychain:` references; values are never written, printed or sent anywhere).
//! - `test <profile>` — put/get/delete a probe object, then check the public read URL and
//!   browser CORS, printing the exact provider CORS config to paste when it is missing.
//! - `use <profiles>` — set `dash.storage` / `dash.replicas` in git config: where
//!   `git push` stores packs.
//! - `advertise <repo>` — write the policy's mode + public read URLs to the on-chain
//!   `config.backend` so readers know where to look.
//! - `status <repo>` — per-URI availability matrix for a repo's packs.

use std::process::Command as Process;

use anyhow::{bail, Context, Result};
use forge_core::user_error::{codes, UserError};
use serde_json::json;

use forge_core::backends::{Health, IpfsBackend, PackBackend, PackMeta, S3Backend, Uri};
use forge_core::storage::copies::{count_copies, policy_copies, CopyCount};
use forge_core::storage::cors::{cors_fix, kubo_cors_fix, probe_cors, provider_of};
use forge_core::storage::policy::{
    git_config_scoped, git_config_scoped_with, parse_git_bool, pick_scoped, GitConfigRun,
};
use forge_core::storage::profiles::{
    valid_profile_name, KeyId, KuboProfile, PinningProfile, PlatformProfile, S3Profile,
};
use forge_core::storage::publish::{
    profile_problems, refuse_unpublishable, ALLOW_PRIVATE_URI_GIT_KEY,
};
use forge_core::storage::{
    PackReader, Profile, ResolvedPolicy, SecretRef, StoragePolicy, StorageProfiles,
    PLATFORM_PROFILE,
};

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::{ProfileKindArg, StorageAddArgs, StorageCommand};

/// Dispatch a `storage` subcommand.
pub async fn run(ctx: &Ctx, cmd: &StorageCommand) -> Result<()> {
    match cmd {
        StorageCommand::Status { repo } => status(ctx, repo).await,
        StorageCommand::Add(args) => add(ctx, args).await,
        StorageCommand::List => list(ctx),
        StorageCommand::Remove { name } => remove(ctx, name),
        StorageCommand::Test { name } => test(ctx, name).await,
        StorageCommand::Use {
            profiles,
            replicas,
            platform_fallback,
            global,
        } => use_profiles(ctx, profiles, *replicas, *platform_fallback, *global).await,
        StorageCommand::Advertise { repo, remote } => advertise(ctx, repo, remote.as_deref()).await,
    }
}

fn need(field: Option<&String>, flag: &str, kind: &str) -> Result<String> {
    field
        .cloned()
        .with_context(|| format!("--{flag} is required for a {kind} profile"))
}

fn secret_ref(value: Option<&String>, flag: &str) -> Result<Option<SecretRef>> {
    value
        .map(|v| v.parse::<SecretRef>().with_context(|| format!("--{flag}")))
        .transpose()
}

/// Build a profile from `dg storage add` flags.
pub(crate) fn profile_from_args(a: &StorageAddArgs) -> Result<Profile> {
    let kind = a.kind.ok_or_else(|| {
        crate::errors::usage("--kind is required (s3, ipfs-kubo, ipfs-pinning-service or platform)")
    })?;
    let s3_only = [
        ("endpoint", a.endpoint.is_some()),
        ("region", a.region.is_some()),
        ("bucket", a.bucket.is_some()),
        ("public-url", a.public_url.is_some()),
        ("prefix", a.prefix.is_some()),
        ("access-key-id", a.access_key_id.is_some()),
        ("secret-access-key", a.secret_access_key.is_some()),
        ("session-token", a.session_token.is_some()),
        ("virtual-hosted", a.virtual_hosted),
    ];
    let ipfs_only = [
        ("api", a.api.is_some()),
        ("gateway", a.gateway.is_some()),
        ("public-gateway", a.public_gateway.is_some()),
        ("api-auth", a.api_auth.is_some()),
    ];
    let pin_only = [
        ("pinning-endpoint", a.pinning_endpoint.is_some()),
        ("pinning-token", a.pinning_token.is_some()),
        ("pin-timeout-secs", a.pin_timeout_secs.is_some()),
    ];
    let reject = |flags: &[(&str, bool)], kind: &str| -> Result<()> {
        if let Some((f, _)) = flags.iter().find(|(_, set)| *set) {
            return Err(crate::errors::usage(format!(
                "--{f} does not apply to a {kind} profile"
            )));
        }
        Ok(())
    };
    let profile = match kind {
        ProfileKindArg::S3 => {
            reject(&ipfs_only, "s3")?;
            reject(&pin_only, "s3")?;
            Profile::S3(S3Profile {
                endpoint: need(a.endpoint.as_ref(), "endpoint", "s3")?,
                region: a.region.clone().unwrap_or_else(|| "us-east-1".into()),
                bucket: need(a.bucket.as_ref(), "bucket", "s3")?,
                path_style: !a.virtual_hosted,
                public_url: a.public_url.clone(),
                prefix: a.prefix.clone().unwrap_or_default(),
                access_key_id: a
                    .access_key_id
                    .as_deref()
                    .map(KeyId::parse)
                    .transpose()
                    .context("--access-key-id")?,
                secret_access_key: secret_ref(a.secret_access_key.as_ref(), "secret-access-key")?,
                session_token: secret_ref(a.session_token.as_ref(), "session-token")?,
                allow_private_uri: a.allow_private_uri,
            })
        }
        ProfileKindArg::IpfsKubo => {
            reject(&s3_only, "ipfs-kubo")?;
            reject(&pin_only, "ipfs-kubo")?;
            Profile::IpfsKubo(KuboProfile {
                api: need(a.api.as_ref(), "api", "ipfs-kubo")?,
                gateway: a.gateway.clone(),
                public_gateway: a.public_gateway.clone(),
                api_auth: secret_ref(a.api_auth.as_ref(), "api-auth")?,
                allow_private_uri: a.allow_private_uri,
            })
        }
        ProfileKindArg::IpfsPinningService => {
            reject(&s3_only, "ipfs-pinning-service")?;
            Profile::IpfsPinningService(PinningProfile {
                api: need(a.api.as_ref(), "api", "ipfs-pinning-service")?,
                gateway: a.gateway.clone(),
                public_gateway: a.public_gateway.clone(),
                api_auth: secret_ref(a.api_auth.as_ref(), "api-auth")?,
                pinning_endpoint: need(
                    a.pinning_endpoint.as_ref(),
                    "pinning-endpoint",
                    "ipfs-pinning-service",
                )?,
                pinning_token: secret_ref(a.pinning_token.as_ref(), "pinning-token")?
                    .context("--pinning-token is required for an ipfs-pinning-service profile")?,
                pin_timeout_secs: a.pin_timeout_secs,
                allow_private_uri: a.allow_private_uri,
            })
        }
        ProfileKindArg::Platform => {
            if a.allow_private_uri {
                return Err(crate::errors::usage(
                    "--allow-private-uri does not apply to a platform profile",
                ));
            }
            reject(&s3_only, "platform")?;
            reject(&ipfs_only, "platform")?;
            reject(&pin_only, "platform")?;
            Profile::Platform(PlatformProfile {})
        }
    };
    profile.validate()?;
    Ok(profile)
}

/// `dg storage add`: from flags, or — with no arguments at all, in a terminal — the prompt
/// flow ([`crate::storage_wizard`]).
async fn add(ctx: &Ctx, args: &StorageAddArgs) -> Result<()> {
    let Some(name) = args.name.as_deref() else {
        let no_args = *args == StorageAddArgs::default();
        if no_args && ctx.interactive() {
            return crate::storage_wizard::run(&mut crate::prompt::TtyPrompter)
                .await
                .map(drop);
        }
        return Err(UserError::new(codes::USAGE, "storage profile not added: no profile name")
            .cause(if no_args {
                "the interactive setup needs a terminal, and runs only without --json and --yes"
            } else {
                "flags were given without the profile name"
            })
            .fix("pass the profile as flags: `dg storage add <name> --kind s3 --endpoint … --bucket …` (see `dg storage add --help`)")
            .fix("run `dg storage add` with no arguments in a terminal to be asked for each value")
            .into());
    };
    let (profile, path, replaced) = save_profile(name, args)?;
    let unresolved: Vec<String> = profile
        .secret_refs()
        .iter()
        .filter(|(_, r)| !r.is_available())
        .map(|(f, r)| format!("{f} → {r}"))
        .collect();
    let url_warnings = publish_warnings(&profile);
    ctx.emit(
        json!({
            "status": if replaced { "replaced" } else { "added" },
            "profile": name,
            "kind": profile.kind(),
            "path": path.display().to_string(),
            "unresolvedSecrets": unresolved,
            "warnings": url_warnings,
            "allowPrivateUri": profile.allow_private_uri(),
        }),
        || {
            println!(
                "{} storage profile {name:?} ({}) in {}",
                if replaced { "Replaced" } else { "Added" },
                profile.kind(),
                path.display()
            );
            for u in &unresolved {
                println!("  note: secret {u} does not resolve yet (set it before pushing)");
            }
            for w in &url_warnings {
                println!("  warning: {w}");
            }
            println!("  next: dg storage test {name}");
        },
    );
    Ok(())
}

/// Validate `name` and the flags, then add (or replace) the profile in storage.toml.
/// Returns the profile, the file, and whether a profile of that name was replaced.
pub(crate) fn save_profile(
    name: &str,
    args: &StorageAddArgs,
) -> Result<(Profile, std::path::PathBuf, bool)> {
    if !valid_profile_name(name) {
        return Err(crate::errors::usage(format!(
            "profile name {name:?} must be letters, digits, '-', '_' or '.'"
        )));
    }
    let profile = profile_from_args(args)?;
    let path = StorageProfiles::default_path()?;
    let mut profiles = StorageProfiles::load_from(&path)?;
    let replaced = profiles
        .profiles
        .insert(name.to_string(), profile.clone())
        .is_some();
    profiles.save_to(&path)?;
    Ok((profile, path, replaced))
}

/// Warnings about the addresses `profile` would record on chain, one line each, saying
/// whether a push will refuse them.
pub(crate) fn publish_warnings(profile: &Profile) -> Vec<String> {
    profile_problems(profile)
        .iter()
        .map(|p| {
            let consequence = if !p.problem.refused() {
                ""
            } else if profile.allow_private_uri() {
                " allow_private_uri is set, so pushes record it anyway."
            } else {
                " `git push` refuses to record it unless you pass `-o allow-private-uri` or \
                 re-add the profile with --allow-private-uri."
            };
            format!("{}: {}.{consequence}", p.field, p.describe())
        })
        .collect()
}

/// git config `dash.allowPrivateUri`, or `remote.<remote>.dashAllowPrivateUri` by the
/// helper's scope rule ([`pick_scoped`]).
pub(crate) fn allow_private_uri_config(remote: Option<&str>) -> Result<bool> {
    let value = pick_scoped(
        remote.and_then(|r| git_config_scoped(&format!("remote.{r}.dashAllowPrivateUri"))),
        git_config_scoped(ALLOW_PRIVATE_URI_GIT_KEY),
    );
    Ok(value
        .map(|v| parse_git_bool(ALLOW_PRIVATE_URI_GIT_KEY, &v))
        .transpose()?
        .unwrap_or(false))
}

/// The command-line override a `dg` command offers for a non-public address.
pub(crate) const ALLOW_FLAG: &str = "--allow-private-uri";

/// Refuse (E501) before anything is written when one of `targets` would record a read
/// address that is not public https on chain, unless the command's own override (`flag`:
/// its name, and whether it was given), git config `dash.allowPrivateUri` (or
/// `remote.<remote>.dashAllowPrivateUri`, by the same scope rule as the helper) or the
/// profile's own `allow_private_uri` allows it. The same rule `git push` applies.
pub(crate) fn check_publishable<'a>(
    targets: impl IntoIterator<Item = (&'a str, &'a Profile)>,
    flag: Option<(&str, bool)>,
    remote: Option<&str>,
    lead: &str,
) -> Result<()> {
    let from_git = allow_private_uri_config(remote)?;
    let given = flag.is_some_and(|(_, on)| on);
    refuse_unpublishable(targets, given || from_git, lead, flag.map(|(f, _)| f)).map_err(Into::into)
}

/// A one-line, secret-free description of a profile.
fn describe(profile: &Profile) -> String {
    match profile {
        Profile::S3(p) => format!(
            "{} bucket {} ({}, {}){}",
            p.endpoint,
            p.bucket,
            p.region,
            if p.path_style {
                "path-style"
            } else {
                "virtual-hosted"
            },
            p.public_url.as_ref().map_or_else(
                || ", private (no public_url)".to_string(),
                |u| format!(", public {u}")
            )
        ),
        Profile::IpfsKubo(p) => format!("kubo {}", p.api),
        Profile::IpfsPinningService(p) => format!("kubo {} + pins {}", p.api, p.pinning_endpoint),
        Profile::Platform(_) => "on-chain chunk documents".into(),
    }
}

fn list(ctx: &Ctx) -> Result<()> {
    let path = StorageProfiles::default_path()?;
    let profiles = StorageProfiles::load_from(&path)?;
    let mut rows: Vec<_> = profiles
        .profiles
        .iter()
        .map(|(name, p)| {
            let secrets: Vec<_> = p
                .secret_refs()
                .iter()
                .map(|(f, r)| json!({ "field": f, "ref": r.to_string(), "available": r.is_available() }))
                .collect();
            json!({ "name": name, "kind": p.kind(), "target": describe(p), "secrets": secrets, "builtIn": false })
        })
        .collect();
    // The human list shows the built-in profile too; so does the JSON (QW-081).
    rows.push(json!({
        "name": PLATFORM_PROFILE,
        "kind": "platform",
        "target": "on-chain chunk documents",
        "secrets": [],
        "builtIn": true,
    }));
    ctx.emit(
        json!({
            "path": path.display().to_string(),
            "profiles": rows,
            "ipfsGateways": profiles.ipfs_gateways(),
        }),
        || {
            println!("Storage profiles ({}):", path.display());
            if profiles.profiles.is_empty() {
                println!("  (none — add one with `dg storage add <name> --kind …`)");
            }
            for (name, p) in &profiles.profiles {
                println!("  {name:<16} {:<22} {}", p.kind(), describe(p));
                for (field, r) in p.secret_refs() {
                    let state = if r.is_available() { "set" } else { "NOT SET" };
                    println!("  {:<16} {:<22}   {field} = {r} ({state})", "", "");
                }
            }
            println!("  {PLATFORM_PROFILE:<16} {:<22} built in", "platform");
            println!(
                "IPFS read gateways: {}",
                profiles.ipfs_gateways().join(", ")
            );
        },
    );
    Ok(())
}

fn remove(ctx: &Ctx, name: &str) -> Result<()> {
    let path = StorageProfiles::default_path()?;
    let mut profiles = StorageProfiles::load_from(&path)?;
    let Some(removed) = profiles.profiles.remove(name) else {
        return Err(crate::errors::not_found(
            format!("no storage profile {name:?} in {}", path.display()),
            "`dg storage list` lists the profiles",
        ));
    };
    profiles.save_to(&path)?;
    // The profile is gone first: a keychain that cannot be reached must not keep it.
    let secrets = remove_owned_secrets(name, &removed, &profiles, forge_core::keychain::delete);
    ctx.emit(
        json!({ "status": "removed", "profile": name, "keychain": secrets.to_json() }),
        || {
            println!("Removed storage profile {name:?}. Repos whose dash.storage names it will refuse to push until it is re-added or dropped from dash.storage.");
            secrets.print();
        },
    );
    Ok(())
}

/// What `dg storage remove` did with the keychain entries the removed profile referenced.
#[derive(Debug, Default, PartialEq)]
struct SecretCleanup {
    /// The profile's own entry (`dash-forge/<profile>`), deleted.
    deleted: Vec<String>,
    /// The profile's own entry, referenced but not in the keychain (nothing to delete).
    absent: Vec<String>,
    /// The profile's own entry, kept because another profile still names it:
    /// `(reference, profile)`.
    shared: Vec<(String, String)>,
    /// The profile's own entry, which could not be deleted: `(reference, why)`.
    failed: Vec<(String, String)>,
    /// Every other entry it referenced (another service, another profile's name, a
    /// `dg auth` key): never touched.
    foreign: Vec<String>,
}

/// Delete the keychain entry `dg storage add` stores a pasted secret under for profile
/// `name` (`keychain:dash-forge/<name>`), when the removed profile references it and no
/// profile in `remaining` still does. Every other entry it references is left alone and
/// reported: one under another service, a `dg auth` key (`dash-forge/<network>/<id>`), or
/// another profile's `dash-forge/<other>` entry, which may be a secret the user stored by
/// hand. `delete` is [`forge_core::keychain::delete`] (`Ok(false)`: no such entry).
fn remove_owned_secrets(
    name: &str,
    removed: &Profile,
    remaining: &StorageProfiles,
    mut delete: impl FnMut(&str, &str) -> forge_core::Result<bool>,
) -> SecretCleanup {
    use forge_core::keychain::SERVICE;
    let mut out = SecretCleanup::default();
    let mut seen = std::collections::BTreeSet::new();
    for (_, r) in removed.secret_refs() {
        let SecretRef::Keychain { service, account } = r else {
            continue;
        };
        let reference = r.to_string();
        if !seen.insert(reference.clone()) {
            continue;
        }
        if service != SERVICE || account != name {
            out.foreign.push(reference);
            continue;
        }
        let user = remaining
            .profiles
            .iter()
            .find(|(_, p)| p.secret_refs().iter().any(|(_, o)| *o == r))
            .map(|(other, _)| other.clone());
        if let Some(other) = user {
            out.shared.push((reference, other));
            continue;
        }
        match delete(service, account) {
            Ok(true) => out.deleted.push(reference),
            Ok(false) => out.absent.push(reference),
            Err(e) => out.failed.push((reference, e.to_string())),
        }
    }
    out
}

impl SecretCleanup {
    fn to_json(&self) -> serde_json::Value {
        let pairs = |v: &[(String, String)], k: &str| -> Vec<serde_json::Value> {
            v.iter().map(|(r, x)| json!({ "ref": r, k: x })).collect()
        };
        json!({
            "deleted": self.deleted,
            "notFound": self.absent,
            "keptSharedWith": pairs(&self.shared, "profile"),
            "failed": pairs(&self.failed, "error"),
            "notOwned": self.foreign,
        })
    }

    fn print(&self) {
        let store = forge_core::keychain::store_name();
        for r in &self.deleted {
            println!("Deleted its secret {r} from the {store}.");
        }
        for r in &self.absent {
            println!("{r} was not in the {store}; nothing to delete.");
        }
        for (r, other) in &self.shared {
            println!("Kept {r}: profile {other:?} still uses it.");
        }
        for (r, why) in &self.failed {
            // Only `keychain:dash-forge/<profile>` entries are ever deleted (or fail to be).
            let service = forge_core::keychain::SERVICE;
            let account = r
                .strip_prefix(&format!("keychain:{service}/"))
                .unwrap_or_default();
            let by_hand = if cfg!(target_os = "macos") {
                format!("`security delete-generic-password -s {service} -a {account}`")
            } else {
                format!("the {store}")
            };
            eprintln!("warning: could not delete {r} ({why}); remove it with {by_hand}");
        }
        for r in &self.foreign {
            println!("Left {r} in place: dg storage add did not create it for this profile.");
        }
    }
}

/// One storage check.
struct Step {
    name: &'static str,
    ok: bool,
    warn: bool,
    detail: String,
}

/// The checks [`run_checks`] ran, plus the provider fixes to print.
#[derive(Default)]
pub(crate) struct Report {
    steps: Vec<Step>,
    pub fixes: Vec<String>,
    /// Print each row as it is recorded (human mode), so a slow check shows progress.
    live: bool,
}

impl Report {
    fn record(&mut self, name: &'static str, ok: bool, warn: bool, detail: String) {
        if self.live {
            let mark = match (ok, warn) {
                (false, _) => "FAIL",
                (true, true) => "WARN",
                (true, false) => " OK ",
            };
            println!("  [{mark}] {name:<14} {detail}");
        }
        self.steps.push(Step {
            name,
            ok,
            warn,
            detail,
        });
    }

    /// A problem that does not fail the test (what works still works).
    fn warn(&mut self, name: &'static str, detail: impl Into<String>) {
        self.record(name, true, true, detail.into());
    }

    fn pass(&mut self, name: &'static str, detail: impl Into<String>) {
        self.record(name, true, false, detail.into());
    }

    fn fail(&mut self, name: &'static str, detail: impl Into<String>) {
        self.record(name, false, false, detail.into());
    }

    /// Record `res` as step `name`; `Some(value)` on success.
    fn check<T, E: std::fmt::Display>(
        &mut self,
        name: &'static str,
        res: std::result::Result<T, E>,
        ok_detail: impl FnOnce(&T) -> String,
    ) -> Option<T> {
        match res {
            Ok(v) => {
                self.pass(name, ok_detail(&v));
                Some(v)
            }
            Err(e) => {
                self.fail(name, e.to_string());
                None
            }
        }
    }

    pub fn ok(&self) -> bool {
        self.steps.iter().all(|s| s.ok)
    }

    /// The names of the failing checks.
    pub fn failed(&self) -> Vec<&'static str> {
        self.steps
            .iter()
            .filter(|s| !s.ok)
            .map(|s| s.name)
            .collect()
    }

    /// The names of the checks that only warned.
    pub fn warnings(&self) -> Vec<&'static str> {
        self.steps
            .iter()
            .filter(|s| s.warn)
            .map(|s| s.name)
            .collect()
    }

    /// The `--json` rows.
    pub fn steps_json(&self) -> Vec<serde_json::Value> {
        self.steps
            .iter()
            .map(|s| json!({"step": s.name, "ok": s.ok, "warn": s.warn, "detail": s.detail}))
            .collect()
    }
}

/// Run every check for `profile` (the same ones for `dg storage test` and the end of the
/// `dg storage add` prompts): a signed PUT, a signed GET, an anonymous GET through the
/// public URL, the browser CORS preflight for `Range`, and a delete of the probe (IPFS:
/// add + pin, gateway reads, unpin). `live` prints each row as it finishes.
pub(crate) async fn run_checks(profile: &Profile, live: bool) -> Report {
    let http = forge_core::storage::http_client();
    let mut r = Report {
        live,
        ..Report::default()
    };
    for w in publish_warnings(profile) {
        r.warn("public address", w);
    }
    match profile {
        Profile::Platform(_) => r.pass(
            "platform",
            "on-chain storage needs no probe; `dg auth balance` shows the credits it spends",
        ),
        Profile::S3(p) => test_s3(p, &http, &mut r).await,
        Profile::IpfsKubo(_) | Profile::IpfsPinningService(_) => {
            test_ipfs(profile, &http, &mut r).await;
        }
    }
    r
}

/// A unique probe body (so a cached/stale object can never pass for this run's upload).
fn probe_body() -> Vec<u8> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("dash-forge storage probe {nonce}\n").into_bytes()
}

/// GET `url` anonymously and require exactly `body`; on success, check browser CORS.
async fn check_public_read(
    r: &mut Report,
    http: &reqwest::Client,
    name: &'static str,
    url: &str,
    body: &[u8],
) -> bool {
    let got = forge_core::backends::HttpsBackend::with_client(http.clone())
        .get(&Uri(url.to_string()), None)
        .await;
    match got {
        Ok(b) if b == body => r.pass(name, format!("anonymous GET {url} OK")),
        Ok(_) => r.fail(
            name,
            format!("{url} served different bytes (a stale cache?)"),
        ),
        Err(e) => r.fail(name, format!("{url}: {e}")),
    }
    let ok = r.steps.last().is_some_and(|s| s.ok);
    if ok {
        let cors = probe_cors(http, url).await;
        if !cors.browser_ok() {
            r.fail("browser CORS", cors.problems.join("; "));
        } else if cors.warnings.is_empty() {
            r.pass(
                "browser CORS",
                "GET + Range preflight allowed, Content-Range exposed",
            );
        } else {
            r.warn(
                "browser CORS",
                format!(
                    "GET + Range preflight allowed; {}",
                    cors.warnings.join("; ")
                ),
            );
        }
    }
    ok
}

async fn test(ctx: &Ctx, name: &str) -> Result<()> {
    let profiles = StorageProfiles::load()?;
    let profile = profiles
        .get(name)
        .with_context(|| format!("no storage profile {name:?} (see `dg storage list`)"))?;
    if !ctx.json {
        println!("Testing storage profile {name:?} ({}):", profile.kind());
    }
    let r = run_checks(&profile, !ctx.json).await;

    let ok = r.ok();
    let body = json!({
        "profile": name,
        "kind": profile.kind(),
        "ok": ok,
        "steps": r.steps_json(),
        "fixes": r.fixes,
    });
    if ctx.json && !ok {
        // Printed once, with the error block, by the renderer.
    } else {
        ctx.emit(body.clone(), || {
            for f in &r.fixes {
                println!("\nFix:\n{f}");
            }
            let warned = r.warnings();
            if ok && !warned.is_empty() {
                println!(
                    "\nChecks passed with warnings ({}): pushes work, but read the [WARN] rows above.",
                    warned.join(", ")
                );
            } else if ok {
                println!(
                    "\nAll checks passed — run `dg storage use <profiles>` in a repo to push here."
                );
            } else {
                println!("\nSome checks failed (see above).");
            }
        });
    }
    if ok {
        return Ok(());
    }
    let failed = r.failed();
    let mut err = UserError::new(
        codes::STORAGE_TEST,
        format!("storage profile {name:?} failed its checks"),
    )
    .cause(format!("failing: {}", failed.join(", ")))
    .fix(format!(
        "fix what the failing rows name (a CORS fix is printed above), then `dg storage test {name}`"
    ));
    if failed == ["browser CORS"] {
        err = err.note(
            "git push and clone work without CORS; only the web app cannot read this storage",
        );
    }
    Err(crate::errors::reported(err, body))
}

async fn test_s3(p: &S3Profile, http: &reqwest::Client, r: &mut Report) {
    let Some(cfg) = r.check("credentials", p.to_config(), |c| {
        if c.credentials.is_some() {
            "resolved (SigV4 signing)".into()
        } else {
            "none — anonymous requests (only a public-write bucket accepts them)".into()
        }
    }) else {
        return;
    };
    let backend = S3Backend::with_client(cfg, S3Backend::client());
    let body = probe_body();
    let key = backend.object_key(&format!(
        "probe/dg-storage-test-{}.txt",
        forge_core::backends::sigv4::sha256_hex(&body)
    ));

    if r.check(
        "put",
        backend.put_object(&key, &body, "text/plain").await,
        |()| format!("wrote {key} (signed PUT)"),
    )
    .is_none()
    {
        return;
    }
    match backend.get_object(&key, None).await {
        Ok(b) if b == body => r.pass("get", "read back identical bytes (signed GET)"),
        Ok(b) => r.fail("get", format!("read back {} bytes that differ", b.len())),
        Err(e) => r.fail("get", e.to_string()),
    }

    if let Some(url) = backend.public_url(&key) {
        let steps_before = r.steps.len();
        let public_ok = check_public_read(r, http, "public read", &url, &body).await;
        let cors_failed = r.steps[steps_before..]
            .iter()
            .any(|s| s.name == "browser CORS" && !s.ok);
        if !public_ok {
            r.fixes.push(format!(
                "Make objects publicly readable at public_url ({}). R2: Settings → Public access \
                 → enable the r2.dev subdomain or connect a custom domain. B2: make the bucket \
                 allPublic. AWS: a bucket policy granting s3:GetObject on {}/*, or CloudFront. \
                 MinIO: `mc anonymous set download <alias>/{}`.",
                p.public_url.as_deref().unwrap_or_default(),
                p.bucket,
                p.bucket
            ));
        } else if cors_failed {
            r.fixes.push(cors_fix(provider_of(&p.endpoint), &p.bucket));
        }
    } else {
        r.pass(
            "public read",
            "no public_url: only CLIs holding this profile can read these packs (browsers and \
             other users use the repo's other copies)",
        );
    }

    r.check("delete", backend.delete_object(&key).await, |()| {
        "probe removed".into()
    });
}

async fn test_ipfs(profile: &Profile, http: &reqwest::Client, r: &mut Report) {
    let (api, local_gw, public_gw, api_auth) = match profile {
        Profile::IpfsKubo(p) => (&p.api, &p.gateway, &p.public_gateway, &p.api_auth),
        Profile::IpfsPinningService(p) => (&p.api, &p.gateway, &p.public_gateway, &p.api_auth),
        _ => return,
    };
    let Some(auth) = r.check(
        "credentials",
        api_auth.as_ref().map(SecretRef::resolve).transpose(),
        |a| {
            if a.is_some() {
                "RPC auth resolved".into()
            } else {
                "no RPC auth".into()
            }
        },
    ) else {
        return;
    };
    let kubo = IpfsBackend::with_client(
        forge_core::backends::ipfs::IpfsConfig {
            api: Some(api.trim_end_matches('/').to_string()),
            api_auth: auth,
            gateway: public_gw
                .clone()
                .or_else(|| local_gw.clone())
                .unwrap_or_default(),
            pinning: None,
        },
        http.clone(),
    );
    if r.check("kubo api", kubo.version().await, |v| {
        format!("kubo {v} at {api}")
    })
    .is_none()
    {
        return;
    }
    let body = probe_body();
    let Some(uris) = r.check(
        "add + pin",
        kubo.put(&body, &PackMeta::for_bytes(&body)).await,
        |u| {
            format!(
                "{} (CIDv1 raw-leaves, matches the local derivation, pinned)",
                u[0]
            )
        },
    ) else {
        return;
    };
    let cid = IpfsBackend::cid_of(&uris[0]).unwrap_or_default();
    if let Some(gw) = local_gw {
        let url = format!("{}/ipfs/{cid}", gw.trim_end_matches('/'));
        match forge_core::backends::HttpsBackend::with_client(http.clone())
            .get(&Uri(url.clone()), None)
            .await
        {
            Ok(b) if b == body => r.pass("gateway", format!("GET {url} OK")),
            Ok(_) => r.fail("gateway", format!("{url} served different bytes")),
            Err(e) => r.fail("gateway", format!("{url}: {e}")),
        }
    }
    if let Some(gw) = public_gw {
        let url = format!("{}/ipfs/{cid}", gw.trim_end_matches('/'));
        let before = r.steps.len();
        check_public_read(r, http, "public gateway", &url, &body).await;
        if r.steps[before..]
            .iter()
            .any(|s| s.name == "browser CORS" && !s.ok)
        {
            r.fixes.push(kubo_cors_fix().to_string());
        }
    } else {
        let gateways = StorageProfiles::load().unwrap_or_default().ipfs_gateways();
        check_shared_gateways(r, http, gateways, &cid, &body).await;
    }
    if let Profile::IpfsPinningService(p) = profile {
        test_pinning_auth(p, http, r).await;
    }
    r.check("cleanup", kubo.unpin(&cid).await, |()| {
        "probe unpinned".into()
    });
}

/// How long `dg storage test` gives the shared gateways to find a fresh probe CID.
const SHARED_GATEWAY_FETCH: std::time::Duration = std::time::Duration::from_secs(30);

/// A profile without `public_gateway`: readers can only fetch what it stores through the
/// shared gateway list (`[read] ipfs_gateways`, else the defaults), which must find this node
/// on the IPFS network. Ask each live one for the probe just added; warn (never fail: git
/// push works either way) when none serves it, since then an IPFS-only repo is unreadable.
async fn check_shared_gateways(
    r: &mut Report,
    http: &reqwest::Client,
    gateways: Vec<String>,
    cid: &str,
    body: &[u8],
) {
    if r.live {
        println!(
            "  ....   {:<14} asking {} shared gateway(s) for the probe (up to {} s)…",
            "shared gateway",
            gateways.len(),
            SHARED_GATEWAY_FETCH.as_secs()
        );
    }
    let results = forge_core::storage::read::fetch_from_gateways(
        http,
        &gateways,
        cid,
        body,
        SHARED_GATEWAY_FETCH,
    )
    .await;
    if let Some((gw, _)) = results.iter().find(|(_, res)| res.is_ok()) {
        r.pass(
            "shared gateway",
            format!("{gw} fetched the probe from this node (no public_gateway is set)"),
        );
        return;
    }
    let tried = results
        .iter()
        .filter_map(|(gw, res)| res.as_ref().err().map(|e| format!("{gw}: {e}")))
        .collect::<Vec<_>>()
        .join("; ");
    r.warn(
        "shared gateway",
        format!(
            "no IPFS gateway could fetch what this node stores ({}), so readers cannot clone \
             or browse a repo stored only here. Set a public gateway that reaches this node \
             (`dg storage add <name> … --public-gateway https://…`), add one that does to \
             [read] ipfs_gateways in storage.toml, or add a second, non-IPFS profile to \
             the repo's policy",
            if tried.is_empty() {
                "no gateways configured".to_string()
            } else {
                tried
            }
        ),
    );
}

async fn test_pinning_auth(p: &PinningProfile, http: &reqwest::Client, r: &mut Report) {
    let Some(token) = r.check("pinning token", p.pinning_token.resolve(), |_| {
        format!("{} resolved", p.pinning_token)
    }) else {
        return;
    };
    let cfg = forge_core::backends::ipfs::PinningServiceConfig {
        endpoint: p.pinning_endpoint.trim_end_matches('/').to_string(),
        token,
        timeout: std::time::Duration::from_secs(p.pin_timeout_secs.unwrap_or(120)),
        poll_interval: std::time::Duration::from_secs(2),
    };
    let client = forge_core::backends::ipfs::PinningClient::new(http, &cfg);
    r.check("pinning api", client.check_auth().await, |()| {
        format!("authenticated to {}", p.pinning_endpoint)
    });
}

pub(crate) fn git_config(global: bool, args: &[&str]) -> Result<()> {
    let mut cmd = Process::new("git");
    cmd.arg("config");
    if global {
        cmd.arg("--global");
    }
    let out = cmd.args(args).output().context("running git config")?;
    // `--unset` of an absent key exits 5; that is fine.
    if !out.status.success() && out.status.code() != Some(5) {
        bail!(
            "git config {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

/// How the live packs of the repository behind this git repository's `dash://` remote
/// compare with a storage policy (F-15: a policy only applies to packs pushed after it).
pub(crate) struct ExistingCopies {
    /// `owner/name`.
    pub repo: String,
    /// The copies the policy asks for.
    pub required: usize,
    /// What the manifests record.
    pub count: CopyCount,
    /// The command that stores one consolidated pack under the policy.
    pub fix: String,
}

impl ExistingCopies {
    /// The copies the policy asks for, in words (`1 copy`, `2 copies`).
    pub fn required_copies(&self) -> String {
        let noun = if self.required == 1 { "copy" } else { "copies" };
        format!("{} {noun}", self.required)
    }

    /// One line: how many live packs have fewer copies than the policy asks for.
    pub fn summary(&self) -> String {
        format!(
            "{} of {} live pack(s) of {} have fewer than {} ({} byte(s))",
            self.count.thin.len(),
            self.count.live,
            self.repo,
            self.required_copies(),
            self.count.thin.iter().map(|t| t.size_bytes).sum::<u64>()
        )
    }
}

/// This git repository's forge remote, as `(name, dash:// URL)`: `origin` when it is one,
/// else the first `dash://` remote.
fn dash_remote_url() -> Option<(String, String)> {
    dash_remote_url_in(std::path::Path::new("."))
}

/// [`dash_remote_url`] of the repository at `dir`.
fn dash_remote_url_in(dir: &std::path::Path) -> Option<(String, String)> {
    let out = Process::new("git")
        .current_dir(dir)
        .args(["config", "--get-regexp", r"^remote\..*\.url$"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let remotes: Vec<(&str, &str)> = text
        .lines()
        .filter_map(|l| l.split_once(' '))
        .filter(|(_, url)| url.starts_with("dash://"))
        .collect();
    remotes
        .iter()
        .find(|(k, _)| *k == "remote.origin.url")
        .or_else(|| remotes.first())
        .map(|(k, url)| {
            let name = k.trim_start_matches("remote.").trim_end_matches(".url");
            (name.to_string(), (*url).to_string())
        })
}

/// Whether this git repository's forge remote names `repo`: its id, or its owner (id or DPNS
/// name, as the URL gives it) and name. What a command that follows the clone's storage
/// policy checks first, so a policy is never applied to another repository.
pub(crate) fn dash_remote_is(repo: &forge_core::scope::RepoRef, owner_label: &str) -> bool {
    let Some((owner, name)) =
        dash_remote_url().and_then(|(_, url)| crate::publish::parse_dash_url(&url))
    else {
        return false;
    };
    match name {
        None => owner == repo.id(),
        Some(name) => {
            name == repo.name()
                && (owner == repo.owner_id() || owner.eq_ignore_ascii_case(owner_label))
        }
    }
}

/// The name of this git repository's forge (`dash://`) remote, when it has one.
pub(crate) fn dash_remote_name() -> Option<String> {
    dash_remote_url().map(|(name, _)| name)
}

/// The repository this git repository's forge remote names, as a `dg` repository argument
/// (`owner/name`, or the repo id of a `dash://<id>` remote).
pub(crate) fn clone_repo() -> Option<String> {
    let (_, url) = dash_remote_url()?;
    Some(match crate::publish::parse_dash_url(&url)? {
        (owner, Some(name)) => format!("{owner}/{name}"),
        (id, None) => id,
    })
}

/// The storage policy a push through this repository's forge remote uses: its
/// `remote.<name>.dash*` settings over `dash.*`, by the helper's scope rule.
pub(crate) fn push_policy() -> Result<ResolvedPolicy> {
    Ok(push_policy_in(std::path::Path::new("."))?.resolve(&StorageProfiles::load()?)?)
}

/// The unresolved storage policy a push through the forge remote of the repository at `dir`
/// uses ([`push_policy`]'s rule: `remote.<name>.dash*` over `dash.*`).
pub(crate) fn push_policy_in(dir: &std::path::Path) -> Result<StoragePolicy> {
    let scoped = |key: &str| {
        git_config_scoped_with(key, |args| {
            match Process::new("git")
                .current_dir(dir)
                .args(args)
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output()
            {
                Ok(out) if out.status.success() => {
                    GitConfigRun::Found(String::from_utf8_lossy(&out.stdout).into_owned())
                }
                Ok(out) if out.status.code() == Some(1) => GitConfigRun::Unset,
                _ => GitConfigRun::Failed,
            }
        })
    };
    let remote = dash_remote_url_in(dir).map(|(name, _)| name);
    let value = |remote_key: &str, key: &str| {
        pick_scoped(
            remote
                .as_deref()
                .and_then(|r| scoped(&format!("remote.{r}.{remote_key}"))),
            scoped(&format!("dash.{key}")),
        )
    };
    Ok(StoragePolicy::from_git_values(
        value("dashStorage", "storage").as_deref(),
        value("dashReplicas", "replicas").as_deref(),
        value("dashPlatformFallback", "platformFallback").as_deref(),
    )?)
}

/// The command that repacks `repo` onto every target of `policy`, Platform included, each
/// of which must confirm: the consolidated pack then has the copies the policy asks for,
/// and so covers every pack recorded before it ([`count_copies`]).
fn repack_command(repo: &str, policy: &ResolvedPolicy) -> String {
    format!(
        "dg repack {repo} --profile {}",
        policy.target_names().join(",")
    )
}

/// Count the copies of every live pack of this git repository's forge repo against what
/// `policy` can make ([`policy_copies`]). `Ok(None)` when there is no `dash://` remote or
/// the policy asks for one copy (every stored pack has one). Reads only (no spend), within
/// 15 seconds.
pub(crate) async fn existing_copies(
    ctx: &Ctx,
    policy: &ResolvedPolicy,
) -> Result<Option<ExistingCopies>> {
    let required = policy_copies(policy);
    if required <= 1 {
        return Ok(None);
    }
    let Some((_, url)) = dash_remote_url() else {
        return Ok(None);
    };
    let (owner, name) = crate::publish::parse_dash_url(&url)
        .with_context(|| format!("remote URL {url} is not dash://<owner>/<repo>"))?;
    let read = async {
        // Reads only: no identity needed.
        let client = ctx.connect().await?;
        let handle = match &name {
            Some(n) => forge_core::resolve::resolve_named(&client, &owner, n).await?,
            None => forge_core::resolve::resolve_id(&client, &owner).await?,
        };
        let svc = forge_core::repo::RepoService::reader(&client);
        let manifests = svc.read_pack_manifests(&handle).await?;
        let roles = svc.copy_roles(&handle).await?;
        anyhow::Ok((handle.display(), manifests, roles))
    };
    let (repo, manifests, roles) = tokio::time::timeout(std::time::Duration::from_secs(15), read)
        .await
        .map_err(|_| anyhow::anyhow!("reading the pack manifests timed out after 15 s"))??;
    Ok(Some(ExistingCopies {
        count: count_copies(&manifests, &roles, required),
        fix: repack_command(&repo, policy),
        repo,
        required,
    }))
}

#[allow(clippy::too_many_lines)] // one flow: set the policy, then say what it leaves behind
async fn use_profiles(
    ctx: &Ctx,
    list: &str,
    replicas: Option<usize>,
    platform_fallback: bool,
    global: bool,
) -> Result<()> {
    let profiles = StorageProfiles::load()?;
    let replicas_s = replicas.map(|r| r.to_string());
    let fallback_s = platform_fallback.then_some("true");
    let policy = StoragePolicy::from_git_values(Some(list), replicas_s.as_deref(), fallback_s)?;
    let resolved = policy.resolve(&profiles)?;
    let names = resolved.target_names().join(",");
    git_config(global, &["dash.storage", &names])?;
    match replicas {
        Some(r) => git_config(global, &["dash.replicas", &r.to_string()])?,
        None => git_config(global, &["--unset", "dash.replicas"])?,
    }
    if platform_fallback {
        git_config(global, &["dash.platformFallback", "true"])?;
    } else {
        git_config(global, &["--unset", "dash.platformFallback"])?;
    }
    let url_warnings: Vec<String> = resolved
        .external
        .iter()
        .flat_map(|(n, p)| {
            publish_warnings(p)
                .into_iter()
                .map(move |w| format!("{n}: {w}"))
        })
        .collect();
    // A policy only applies to packs pushed after it: say what that leaves behind, from the
    // repo's manifests when they can be read (free reads), else in general.
    let existing = if global {
        Ok(None)
    } else {
        existing_copies(ctx, &resolved).await
    };
    // QW3-072: the repository's public config still names the storage it was created with
    // (the web's badge); say so when this policy differs.
    let advertised = if global {
        Advertised::NoClone
    } else {
        advertised_elsewhere(ctx, &resolved).await
    };
    ctx.emit(
        json!({
            "storage": names,
            "replicas": resolved.replicas,
            "platformFallback": resolved.platform_fallback,
            "scope": if global { "global" } else { "repo" },
            "warnings": url_warnings,
            "advertisedMode": match &advertised {
                Advertised::Elsewhere(_, mode) => Some(*mode),
                _ => None,
            },
            "existingPacks": match &existing {
                Ok(e) => e.as_ref().map(|e| json!({
                    "repo": e.repo,
                    "live": e.count.live,
                    "belowPolicy": e.count.thin.len(),
                    "fix": e.fix,
                })),
                Err(err) => Some(json!({ "error": format!("{err:#}") })),
            },
        }),
        || {
            println!(
                "git push will store packs on: {names} (need {} of {}){}",
                resolved.replicas,
                resolved.total(),
                if resolved.platform_fallback { ", falling back to Platform" } else { "" }
            );
            for w in &url_warnings {
                println!("warning: {w}");
            }
            match &existing {
                Ok(Some(e)) if !e.count.thin.is_empty() => {
                    println!(
                        "Packs already pushed keep the copies they were stored with: {}.",
                        e.summary()
                    );
                    println!(
                        "  Store them again under this policy as one consolidated pack (it asks first; one pack and one browse-index upload per target, plus two small manifest writes):\n  {}",
                        e.fix
                    );
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) if policy_copies(&resolved) <= 1 => {}
                other => {
                    if let Err(e) = other {
                        println!("(could not count the copies of packs already pushed: {e:#})");
                    }
                    println!(
                        "This applies to packs pushed from now on; packs already pushed keep the copies they were stored with. \
                         To store them under this policy as one consolidated pack: {}",
                        repack_command("<owner>/<repo>", &resolved)
                    );
                }
            }
            // QW4-064: the hint names the clone's repository, and is left out when its config
            // already says where the packs are.
            match &advertised {
                Advertised::Elsewhere(repo, mode) => println!(
                    "note: {repo} still tells readers its packs are on {} (its public config); `dg storage advertise {repo}` records this policy  (one small on-chain config write)",
                    mode_name(*mode)
                ),
                Advertised::Unread(repo) if !resolved.external.is_empty() => println!(
                    "Tell readers where to look: dg storage advertise {repo}  (one small on-chain config write)"
                ),
                Advertised::NoClone if !resolved.external.is_empty() => println!(
                    "Tell readers where to look: dg storage advertise <owner>/<repo>  (one small on-chain config write)"
                ),
                Advertised::Matches | Advertised::Unread(_) | Advertised::NoClone => {}
            }
        },
    );
    Ok(())
}

/// What a `config.backend.mode` says, in words.
fn mode_name(mode: u8) -> &'static str {
    match mode {
        0 => "Platform",
        1 => "IPFS",
        2 => "S3-compatible storage",
        _ => "several storages",
    }
}

/// What the clone's repository's public config advertises against `policy` ([`Advertised`]).
/// A read only, with no identity, given 15 s.
async fn advertised_elsewhere(ctx: &Ctx, policy: &ResolvedPolicy) -> Advertised {
    let Some((_, url)) = dash_remote_url() else {
        return Advertised::NoClone;
    };
    let Some((owner, name)) = crate::publish::parse_dash_url(&url) else {
        return Advertised::NoClone;
    };
    // The repository as the remote names it, for a hint when its config cannot be read.
    let named = name
        .as_ref()
        .map_or_else(|| owner.clone(), |n| format!("{owner}/{n}"));
    let read = async {
        let client = ctx.connect().await?;
        let handle = match &name {
            Some(n) => forge_core::resolve::resolve_named(&client, &owner, n).await?,
            None => forge_core::resolve::resolve_id(&client, &owner).await?,
        };
        let config = forge_core::repo::RepoService::reader(&client)
            .current_config(&handle)
            .await?;
        anyhow::Ok((handle.display(), config.backend_mode, config.backend_uris))
    };
    match tokio::time::timeout(std::time::Duration::from_secs(15), read).await {
        Ok(Ok((repo, mode, _))) if mode != policy.advertised_mode() => {
            Advertised::Elsewhere(repo, mode)
        }
        // The same mode at other read URLs (another bucket) still wants an advertise.
        Ok(Ok((repo, _, uris))) if !same_uris(&uris, &policy.advertised_uris()) => {
            Advertised::Unread(repo)
        }
        Ok(Ok(_)) => Advertised::Matches,
        _ => Advertised::Unread(named),
    }
}

/// Whether two read-URL lists name the same URLs, in any order.
fn same_uris(a: &[String], b: &[String]) -> bool {
    let a: std::collections::BTreeSet<&str> = a.iter().map(String::as_str).collect();
    let b: std::collections::BTreeSet<&str> = b.iter().map(String::as_str).collect();
    a == b
}

/// What the clone's repository tells readers about its storage, against a new policy.
enum Advertised {
    /// Not inside a clone of a Forge repository (or `--global`).
    NoClone,
    /// Its public config names another storage mode: (the repository, that mode).
    Elsewhere(String, u8),
    /// Its public config already says what this policy does.
    Matches,
    /// It could not be read (the repository as the remote names it), or it advertises other
    /// read URLs than this policy's (another bucket in the same mode): advertising is advised
    /// either way.
    Unread(String),
}

async fn advertise(ctx: &Ctx, repo: &str, remote: Option<&str>) -> Result<()> {
    // The same precedence the helper uses (forge_core::storage::policy::pick_scoped).
    let value = |remote_key: &str, key: &str| {
        pick_scoped(
            remote.and_then(|r| git_config_scoped(&format!("remote.{r}.{remote_key}"))),
            git_config_scoped(&format!("dash.{key}")),
        )
    };
    let storage = value("dashStorage", "storage");
    let replicas = value("dashReplicas", "replicas");
    let fallback = value("dashPlatformFallback", "platformFallback");
    let policy = StoragePolicy::from_git_values(
        storage.as_deref(),
        replicas.as_deref(),
        fallback.as_deref(),
    )?;
    let resolved = policy.resolve(&StorageProfiles::load()?)?;
    check_publishable(
        resolved.external.iter().map(|(n, p)| (n.as_str(), p)),
        None,
        remote,
        "nothing advertised",
    )?;
    let mode = resolved.advertised_mode();
    let uris = resolved.advertised_uris();
    if !ctx.confirm(&format!(
        "Advertise storage mode {mode} with read URLs {uris:?} on {repo}? (a small config write)"
    ))? {
        return Err(crate::errors::cancelled());
    }
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = forge_core::repo::RepoService::new(&client, &identity, &bridge);
    let doc = svc
        .set_backend(&handle, mode, Some(&uris))
        .await
        .context("writing config.backend")?;
    ctx.emit(
        json!({
            "status": if doc.is_some() { "advertised" } else { "unchanged" },
            "mode": mode,
            "uris": uris,
            "configDocId": doc,
        }),
        || match &doc {
            Some(id) => println!(
                "Advertised mode {mode} with {} read URL(s) (config doc {id}).",
                uris.len()
            ),
            None => println!(
                "Mode {mode} with these {} read URL(s) is already advertised; nothing was written.",
                uris.len()
            ),
        },
    );
    Ok(())
}

/// Probe each pack's mirror URIs and report an availability matrix. Platform-tier packs
/// (on-chain `chunk` docs) are reported as on-chain; external copies are probed live —
/// `ipfs://` URIs through every configured read gateway.
async fn status(ctx: &Ctx, repo: &str) -> Result<()> {
    // A read: a public repository's key is never opened (QW-034: a sealed key without a
    // terminal failed this with E303).
    let reader = crate::common::Reader::open(ctx, repo).await?;
    let handle = reader.repo.clone();
    let svc = reader.service();
    let manifests = svc.read_pack_manifests(&handle).await.unwrap_or_default();
    let scope = handle.scope()?;
    let roles = svc.copy_roles(&handle).await.unwrap_or_default();
    let reader = svc.repo_reader(&handle, &manifests, &roles).await;
    let https = forge_core::backends::HttpsBackend::with_client(forge_core::storage::http_client());

    let mut packs = Vec::new();
    for m in &manifests {
        // Each manifest is one uploader's copy (on v2 a pack may have several).
        let mut uris: Vec<String> = m.uris.clone();
        uris.sort();
        uris.dedup();
        let locator = scope.locator(&m.owner_id, &hex::encode(m.pack_hash));
        let rows = probe_rows(m, &uris, &locator, &reader, &https).await;
        packs.push(json!({
            "packHash": hex::encode(m.pack_hash),
            "uploader": m.owner_id,
            // Named, as the manifest kinds read (QW4-060: it was the raw integer).
            "kind": artifact_kind(m.kind),
            "kindCode": m.kind,
            "sizeBytes": m.size_bytes,
            "chunkCount": m.chunk_count,
            "storageTier": if m.storage == 0 { "platform" } else { "external" },
            "mirrors": rows,
        }));
    }

    ctx.emit(
        json!({
            "repoId": handle.id(),
            "packCount": manifests.len(),
            "ipfsGateways": reader.gateways(),
            "packs": packs,
        }),
        || {
            println!("Storage status for {}:", handle.display());
            if manifests.is_empty() {
                println!("  (no packs)");
            }
            for p in &packs {
                let hash = p["packHash"].as_str().unwrap_or("");
                println!(
                    "  {} {}  ({} bytes, {})",
                    p["kind"].as_str().unwrap_or("pack"),
                    &hash[..hash.len().min(12)],
                    p["sizeBytes"],
                    p["storageTier"].as_str().unwrap_or("")
                );
                if let Some(mirrors) = p["mirrors"].as_array() {
                    for m in mirrors {
                        let mark = match m["ok"].as_bool() {
                            Some(true) => "OK  ",
                            Some(false) => "DOWN",
                            None => " -- ",
                        };
                        println!("    [{mark}] {}", m["uri"].as_str().unwrap_or(""));
                    }
                }
            }
        },
    );
    Ok(())
}

/// A `packManifest.kind` by name: what the artifact is (`forge_core::pack` `KIND_*`).
fn artifact_kind(kind: u64) -> &'static str {
    use forge_core::pack::{
        KIND_FLAT_INDEX, KIND_GIT_PACK, KIND_HISTORY_INDEX, KIND_HISTORY_VERSIONS,
        KIND_LONG_BODY, KIND_OBJECT_LOCATOR, KIND_RELEASE_ASSETS,
    };
    match u8::try_from(kind) {
        Ok(KIND_GIT_PACK) => "pack",
        Ok(KIND_OBJECT_LOCATOR) => "browse-index",
        Ok(KIND_FLAT_INDEX) => "flat-index",
        Ok(KIND_HISTORY_INDEX) => "history-index",
        Ok(KIND_RELEASE_ASSETS) => "release-assets",
        Ok(KIND_HISTORY_VERSIONS) => "history-versions",
        Ok(KIND_LONG_BODY) => "long-body",
        _ => "unknown",
    }
}

/// The availability rows for one pack: its on-chain copy, every http(s) URL, every
/// `ipfs://` CID on every configured gateway, and the credentialed `s3://` locators.
async fn probe_rows(
    m: &forge_core::repo::PackManifestInfo,
    uris: &[String],
    platform_locator: &str,
    reader: &PackReader,
    https: &forge_core::backends::HttpsBackend,
) -> Vec<serde_json::Value> {
    let mut probe_urls: Vec<String> = Vec::new();
    for u in uris {
        let uri = Uri(u.clone());
        match uri.scheme() {
            Some("http" | "https") => probe_urls.push(u.clone()),
            Some("ipfs") => {
                if let Ok(cid) = IpfsBackend::cid_of(&uri) {
                    probe_urls.extend(reader.gateways().iter().map(|g| format!("{g}/ipfs/{cid}")));
                }
            }
            _ => {}
        }
    }
    probe_urls.sort();
    probe_urls.dedup();

    let mut rows = Vec::new();
    // Platform tier (storage == 0) means the bytes are on-chain chunk docs.
    if m.storage == 0 || m.uris.is_empty() {
        rows.push(json!({
            "uri": platform_locator,
            "scheme": "platform",
            "ok": m.chunk_count > 0,
            "detail": "on-chain chunk documents",
        }));
    }
    for url in &probe_urls {
        let health = https
            .probe(&Uri(url.clone()))
            .await
            .unwrap_or_else(|_| Health::down(std::time::Duration::ZERO));
        rows.push(json!({
            "uri": url,
            "scheme": Uri(url.clone()).scheme(),
            "ok": health.ok,
            "sizeBytes": health.size,
            "latencyMs": u64::try_from(health.latency.as_millis()).unwrap_or(u64::MAX),
        }));
    }
    for u in uris.iter().filter(|u| u.starts_with("s3://")) {
        rows.push(json!({
            "uri": u,
            "scheme": "s3",
            "ok": serde_json::Value::Null,
            "detail": "credentialed locator (readable with the matching storage profile)",
        }));
    }
    rows
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use clap::Parser as _;

    pub(crate) fn add_args(argv: &[&str]) -> StorageAddArgs {
        let mut full = vec!["dg", "storage", "add"];
        full.extend_from_slice(argv);
        match crate::Cli::parse_from(full).command {
            crate::Command::Storage(StorageCommand::Add(a)) => *a,
            _ => panic!("expected storage add"),
        }
    }

    fn profiles(toml: &str) -> StorageProfiles {
        StorageProfiles::parse(toml).unwrap()
    }

    const KC_S3: &str = "[profiles.kc-s3]\nkind = \"s3\"\nendpoint = \"https://s3.example\"\n\
        bucket = \"b\"\naccess_key_id = \"AK\"\nsecret_access_key = \"keychain:dash-forge/kc-s3\"\n";

    /// Run the cleanup for profile `name` of `all` (removed from it first) against a fake
    /// keychain holding `present`; returns the report and the deletes attempted.
    fn cleanup(
        all: &str,
        name: &str,
        present: &[&str],
        fail: bool,
    ) -> (SecretCleanup, Vec<String>) {
        let mut all = profiles(all);
        let removed = all.profiles.remove(name).unwrap();
        let mut calls = Vec::new();
        let report = remove_owned_secrets(name, &removed, &all, |svc, acct| {
            calls.push(format!("{svc}/{acct}"));
            if fail {
                return Err(forge_core::Error::Config("the keychain is locked".into()));
            }
            Ok(present.contains(&acct))
        });
        (report, calls)
    }

    #[test]
    fn removing_a_profile_deletes_the_secret_the_wizard_stored_for_it() {
        // D-402: the pasted secret stayed in the keychain after `dg storage remove`.
        let (r, calls) = cleanup(KC_S3, "kc-s3", &["kc-s3"], false);
        assert_eq!(calls, ["dash-forge/kc-s3"]);
        assert_eq!(r.deleted, ["keychain:dash-forge/kc-s3"]);
        assert_eq!(r.to_json()["deleted"][0], "keychain:dash-forge/kc-s3");
    }

    #[test]
    fn a_missing_entry_or_an_unavailable_keychain_does_not_fail_the_remove() {
        let (r, _) = cleanup(KC_S3, "kc-s3", &[], false);
        assert_eq!(r.absent, ["keychain:dash-forge/kc-s3"]);
        assert!(r.deleted.is_empty());
        let (r, _) = cleanup(KC_S3, "kc-s3", &["kc-s3"], true);
        assert_eq!(r.failed.len(), 1);
        assert!(r.failed[0].1.contains("locked"), "{:?}", r.failed);
    }

    #[test]
    fn an_entry_another_profile_still_names_is_kept() {
        let both = format!(
            "{KC_S3}[profiles.copy]\nkind = \"s3\"\nendpoint = \"https://other.example\"\n\
             bucket = \"c\"\naccess_key_id = \"AK\"\nsecret_access_key = \"keychain:dash-forge/kc-s3\"\n"
        );
        let (r, calls) = cleanup(&both, "kc-s3", &["kc-s3"], false);
        assert!(calls.is_empty(), "nothing deleted: {calls:?}");
        assert_eq!(
            r.shared,
            [("keychain:dash-forge/kc-s3".to_string(), "copy".to_string())]
        );
        // Another profile's entry is never deleted by removing this one: it may be a secret
        // the user stored by hand under `dash-forge/<name>` and pointed several profiles at.
        let only_copy = both.replace(KC_S3, "");
        let (r, calls) = cleanup(&only_copy, "copy", &["kc-s3"], false);
        assert!(calls.is_empty(), "nothing deleted: {calls:?}");
        assert_eq!(r.foreign, ["keychain:dash-forge/kc-s3"]);
    }

    #[test]
    fn entries_dg_did_not_create_for_the_profile_are_never_deleted() {
        // The user's own entry (another service), and a `dg auth` identity key
        // (`dash-forge/<network>/<id>`) someone pointed a profile at.
        let own = "[profiles.p]\nkind = \"ipfs-pinning-service\"\napi = \"http://127.0.0.1:5001\"\n\
            pinning_endpoint = \"https://pins.example\"\npinning_token = \"keychain:my-vault/pin\"\n\
            api_auth = \"keychain:dash-forge/devnet-moutai/9Skb\"\n";
        let (r, calls) = cleanup(own, "p", &["pin", "devnet-moutai/9Skb"], false);
        assert!(calls.is_empty(), "nothing deleted: {calls:?}");
        assert_eq!(r.foreign.len(), 2, "{r:?}");
        // env: references have no keychain entry at all.
        let env = KC_S3.replace("keychain:dash-forge/kc-s3", "env:S3_SECRET");
        let (r, calls) = cleanup(&env, "kc-s3", &[], false);
        assert!(calls.is_empty());
        assert_eq!(r, SecretCleanup::default());
    }

    #[test]
    fn a_secret_named_twice_by_the_profile_is_deleted_once() {
        let twice = KC_S3.replace(
            "access_key_id = \"AK\"",
            "access_key_id = \"keychain:dash-forge/kc-s3\"",
        );
        let (r, calls) = cleanup(&twice, "kc-s3", &["kc-s3"], false);
        assert_eq!(calls.len(), 1);
        assert_eq!(r.deleted.len(), 1);
    }

    /// A gateway stub: `/ipfs/bafkqaaa` answers 200 (it is alive), everything else 504 (it
    /// cannot find content), like a real gateway that cannot reach a NAT-ed node.
    fn stub_gateway() -> String {
        use std::io::{BufRead as _, BufReader, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h == "\r\n" || h.is_empty() {
                        break;
                    }
                }
                let status = if line.contains("/ipfs/bafkqaaa ") {
                    "200 OK"
                } else {
                    "504 Gateway Timeout"
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                );
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn no_gateway_reaching_the_node_is_a_warning_not_a_failure() {
        let mut r = Report::default();
        let http = reqwest::Client::new();
        check_shared_gateways(&mut r, &http, vec![stub_gateway()], "bafkreiprobe", b"x").await;
        assert!(r.ok(), "a warning must not fail the test");
        assert_eq!(r.warnings(), ["shared gateway"]);
        let detail = &r.steps[0].detail;
        assert!(detail.contains("no IPFS gateway could fetch"), "{detail}");
        assert!(detail.contains("--public-gateway"), "{detail}");
        assert!(detail.contains("504"), "{detail}");

        // No gateways at all is the same warning.
        let mut r = Report::default();
        check_shared_gateways(&mut r, &http, vec![], "bafkreiprobe", b"x").await;
        assert_eq!(r.warnings(), ["shared gateway"]);
    }

    #[test]
    fn builds_an_r2_profile() {
        let a = add_args(&[
            "r2-main",
            "--kind",
            "s3",
            "--endpoint",
            "https://acct.r2.cloudflarestorage.com",
            "--region",
            "auto",
            "--bucket",
            "forge",
            "--public-url",
            "https://pub-1.r2.dev",
            "--access-key-id",
            "env:R2_ACCESS_KEY_ID",
            "--secret-access-key",
            "keychain:dash-forge/r2-main",
        ]);
        let Profile::S3(p) = profile_from_args(&a).unwrap() else {
            panic!()
        };
        assert!(p.path_style);
        assert_eq!(p.region, "auto");
        assert!(matches!(p.access_key_id, Some(KeyId::Ref(_))));
    }

    #[test]
    fn refuses_literal_secret_and_foreign_flags() {
        let a = add_args(&[
            "x",
            "--kind",
            "s3",
            "--endpoint",
            "https://h",
            "--bucket",
            "b",
            "--access-key-id",
            "AK",
            "--secret-access-key",
            "plain-secret-value",
        ]);
        let err = format!("{:#}", profile_from_args(&a).unwrap_err());
        assert!(err.contains("reference"), "{err}");
        assert!(!err.contains("plain-secret-value"));
        let a = add_args(&[
            "k",
            "--kind",
            "ipfs-kubo",
            "--api",
            "http://x",
            "--bucket",
            "b",
        ]);
        assert!(profile_from_args(&a).is_err());
        let a = add_args(&["k", "--kind", "ipfs-kubo"]);
        assert!(format!("{:#}", profile_from_args(&a).unwrap_err()).contains("--api"));
        // No kind: a usage error naming --kind.
        let a = add_args(&["k"]);
        assert!(format!("{:#}", profile_from_args(&a).unwrap_err()).contains("--kind"));
    }

    #[test]
    fn a_loopback_public_url_is_warned_about_and_the_flag_is_kept() {
        let base = [
            "loop",
            "--kind",
            "s3",
            "--endpoint",
            "http://127.0.0.1:9100",
            "--bucket",
            "forge",
            "--public-url",
            "http://127.0.0.1:9100/forge",
        ];
        let p = profile_from_args(&add_args(&base)).unwrap();
        let w = publish_warnings(&p);
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(w[0].starts_with("public_url: 127.0.0.1:9100"), "{w:?}");
        assert!(w[0].contains("on chain forever"), "{w:?}");
        assert!(w[0].contains("-o allow-private-uri"), "{w:?}");
        let mut allowed = base.to_vec();
        allowed.push("--allow-private-uri");
        let a = add_args(&allowed);
        assert!(crate::storage_wizard::equivalent_command(&a).ends_with(" --allow-private-uri"));
        let p = profile_from_args(&a).unwrap();
        assert!(p.allow_private_uri());
        assert!(publish_warnings(&p)[0].contains("pushes record it anyway"));
        // A public https URL has nothing to say; --allow-private-uri is not for platform.
        let r2 = add_args(&[
            "r2",
            "--kind",
            "s3",
            "--endpoint",
            "https://a.r2.cloudflarestorage.com",
            "--bucket",
            "b",
            "--public-url",
            "https://files.example.org",
        ]);
        assert!(publish_warnings(&profile_from_args(&r2).unwrap()).is_empty());
        let platform = add_args(&["p", "--kind", "platform", "--allow-private-uri"]);
        assert!(profile_from_args(&platform).is_err());
    }

    #[test]
    fn warnings_pass_and_are_listed() {
        let mut r = Report::default();
        r.pass("put", "ok");
        r.warn("browser CORS", "Content-Range not exposed");
        assert!(r.ok());
        assert!(r.failed().is_empty());
        assert_eq!(r.warnings(), ["browser CORS"]);
        assert_eq!(r.steps_json()[1]["warn"], true);
        assert_eq!(r.steps_json()[1]["ok"], true);
        r.fail("get", "boom");
        assert_eq!(r.failed(), ["get"]);
    }

    #[test]
    fn the_repack_command_names_every_target_platform_included() {
        let profiles = StorageProfiles::parse(
            "[profiles.a]\nkind = \"ipfs-kubo\"\napi = \"http://127.0.0.1:5001\"\n\
             [profiles.b]\nkind = \"ipfs-kubo\"\napi = \"http://127.0.0.1:5002\"\n",
        )
        .unwrap();
        let policy = |s: &str| {
            StoragePolicy::from_git_values(Some(s), None, None)
                .unwrap()
                .resolve(&profiles)
                .unwrap()
        };
        // Every target, so the consolidated pack reaches N (Platform is one of the copies).
        let cmd = repack_command("o/r", &policy("a,b,platform"));
        assert_eq!(cmd, "dg repack o/r --profile a,b,platform");
        let cli = <crate::Cli as clap::Parser>::try_parse_from(cmd.split(' ')).unwrap();
        assert!(matches!(
            cli.command,
            crate::Command::Repack { profile: Some(ref p), .. } if p == "a,b,platform"
        ));
    }

    #[test]
    fn no_arguments_parse_as_the_empty_args_the_prompts_start_from() {
        assert_eq!(add_args(&[]), StorageAddArgs::default());
        assert_ne!(add_args(&["x"]), StorageAddArgs::default());
    }
}
