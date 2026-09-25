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
use forge_core::storage::cors::{cors_fix, kubo_cors_fix, probe_cors, provider_of};
use forge_core::storage::policy::{git_config_scoped, pick_scoped};
use forge_core::storage::profiles::{
    valid_profile_name, KeyId, KuboProfile, PinningProfile, PlatformProfile, S3Profile,
};
use forge_core::storage::{
    PackReader, Profile, SecretRef, StoragePolicy, StorageProfiles, PLATFORM_PROFILE,
};

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::{ProfileKindArg, StorageAddArgs, StorageCommand};

/// Dispatch a `storage` subcommand.
pub async fn run(ctx: &Ctx, cmd: &StorageCommand) -> Result<()> {
    match cmd {
        StorageCommand::Status { repo } => status(ctx, repo).await,
        StorageCommand::Add(args) => add(ctx, args),
        StorageCommand::List => list(ctx),
        StorageCommand::Remove { name } => remove(ctx, name),
        StorageCommand::Test { name } => test(ctx, name).await,
        StorageCommand::Use {
            profiles,
            replicas,
            platform_fallback,
            global,
        } => use_profiles(ctx, profiles, *replicas, *platform_fallback, *global),
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
fn profile_from_args(a: &StorageAddArgs) -> Result<Profile> {
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
    let profile = match a.kind {
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
            })
        }
        ProfileKindArg::Platform => {
            reject(&s3_only, "platform")?;
            reject(&ipfs_only, "platform")?;
            reject(&pin_only, "platform")?;
            Profile::Platform(PlatformProfile {})
        }
    };
    profile.validate()?;
    Ok(profile)
}

fn add(ctx: &Ctx, args: &StorageAddArgs) -> Result<()> {
    if !valid_profile_name(&args.name) {
        return Err(crate::errors::usage(format!(
            "profile name {:?} must be letters, digits, '-', '_' or '.'",
            args.name
        )));
    }
    let profile = profile_from_args(args)?;
    let path = StorageProfiles::default_path()?;
    let mut profiles = StorageProfiles::load_from(&path)?;
    let replaced = profiles
        .profiles
        .insert(args.name.clone(), profile.clone())
        .is_some();
    profiles.save_to(&path)?;
    let unresolved: Vec<String> = profile
        .secret_refs()
        .iter()
        .filter(|(_, r)| !r.is_available())
        .map(|(f, r)| format!("{f} → {r}"))
        .collect();
    ctx.emit(
        json!({
            "status": if replaced { "replaced" } else { "added" },
            "profile": args.name,
            "kind": profile.kind(),
            "path": path.display().to_string(),
            "unresolvedSecrets": unresolved,
        }),
        || {
            println!(
                "{} storage profile {:?} ({}) in {}",
                if replaced { "Replaced" } else { "Added" },
                args.name,
                profile.kind(),
                path.display()
            );
            for u in &unresolved {
                println!("  note: secret {u} does not resolve yet (set it before pushing)");
            }
            println!("  next: dg storage test {}", args.name);
        },
    );
    Ok(())
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
    let rows: Vec<_> = profiles
        .profiles
        .iter()
        .map(|(name, p)| {
            let secrets: Vec<_> = p
                .secret_refs()
                .iter()
                .map(|(f, r)| json!({ "field": f, "ref": r.to_string(), "available": r.is_available() }))
                .collect();
            json!({ "name": name, "kind": p.kind(), "target": describe(p), "secrets": secrets })
        })
        .collect();
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
    if profiles.profiles.remove(name).is_none() {
        return Err(crate::errors::not_found(
            format!("no storage profile {name:?} in {}", path.display()),
            "`dg storage list` lists the profiles",
        ));
    }
    profiles.save_to(&path)?;
    ctx.emit(json!({ "status": "removed", "profile": name }), || {
        println!("Removed storage profile {name:?}. Repos whose dash.storage names it will refuse to push until it is re-added or dropped from dash.storage.");
    });
    Ok(())
}

/// One `dg storage test` step.
struct Step {
    name: &'static str,
    ok: bool,
    detail: String,
}

/// The checks `dg storage test` ran, plus the provider fixes to print.
#[derive(Default)]
struct Report {
    steps: Vec<Step>,
    fixes: Vec<String>,
}

impl Report {
    fn pass(&mut self, name: &'static str, detail: impl Into<String>) {
        self.steps.push(Step {
            name,
            ok: true,
            detail: detail.into(),
        });
    }

    fn fail(&mut self, name: &'static str, detail: impl Into<String>) {
        self.steps.push(Step {
            name,
            ok: false,
            detail: detail.into(),
        });
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

    fn ok(&self) -> bool {
        self.steps.iter().all(|s| s.ok)
    }
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
        if cors.browser_ok() {
            r.pass(
                "browser CORS",
                "GET + Range preflight allowed, Content-Range exposed",
            );
        } else {
            r.fail("browser CORS", cors.problems.join("; "));
        }
    }
    ok
}

async fn test(ctx: &Ctx, name: &str) -> Result<()> {
    let profiles = StorageProfiles::load()?;
    let profile = profiles
        .get(name)
        .with_context(|| format!("no storage profile {name:?} (see `dg storage list`)"))?;
    let http = forge_core::storage::http_client();
    let mut r = Report::default();
    match &profile {
        Profile::Platform(_) => r.pass(
            "platform",
            "on-chain storage needs no probe; `dg auth balance` shows the credits it spends",
        ),
        Profile::S3(p) => test_s3(p, &http, &mut r).await,
        Profile::IpfsKubo(_) | Profile::IpfsPinningService(_) => {
            test_ipfs(&profile, &http, &mut r).await;
        }
    }

    let ok = r.ok();
    let body = json!({
        "profile": name,
        "kind": profile.kind(),
        "ok": ok,
        "steps": r.steps.iter().map(|s| json!({"step": s.name, "ok": s.ok, "detail": s.detail})).collect::<Vec<_>>(),
        "fixes": r.fixes,
    });
    if ctx.json && !ok {
        // Printed once, with the error block, by the renderer.
    } else {
        ctx.emit(body.clone(), || {
            println!("Testing storage profile {name:?} ({}):", profile.kind());
            for s in &r.steps {
                let mark = if s.ok { " OK " } else { "FAIL" };
                println!("  [{mark}] {:<14} {}", s.name, s.detail);
            }
            for f in &r.fixes {
                println!("\nFix:\n{f}");
            }
            if ok {
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
    let failed: Vec<&str> = r.steps.iter().filter(|s| !s.ok).map(|s| s.name).collect();
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
    }
    if let Profile::IpfsPinningService(p) = profile {
        test_pinning_auth(p, http, r).await;
    }
    r.check("cleanup", kubo.unpin(&cid).await, |()| {
        "probe unpinned".into()
    });
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

fn git_config(global: bool, args: &[&str]) -> Result<()> {
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

fn use_profiles(
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
    ctx.emit(
        json!({
            "storage": names,
            "replicas": resolved.replicas,
            "platformFallback": resolved.platform_fallback,
            "scope": if global { "global" } else { "repo" },
        }),
        || {
            println!(
                "git push will store packs on: {names} (need {} of {}){}",
                resolved.replicas,
                resolved.total(),
                if resolved.platform_fallback { ", falling back to Platform" } else { "" }
            );
            if !resolved.external.is_empty() {
                println!(
                    "Tell readers where to look: dg storage advertise <owner>/<repo>  (one small on-chain config write)"
                );
            }
        },
    );
    Ok(())
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
        json!({ "status": "advertised", "mode": mode, "uris": uris, "configDocId": doc }),
        || {
            println!(
                "Advertised mode {mode} with {} read URL(s) (config doc {doc}).",
                uris.len()
            );
        },
    );
    Ok(())
}

/// Probe each pack's mirror URIs and report an availability matrix. Platform-tier packs
/// (on-chain `chunk` docs) are reported as on-chain; external copies are probed live —
/// `ipfs://` URIs through every configured read gateway.
async fn status(ctx: &Ctx, repo: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = forge_core::repo::RepoService::new(&client, &identity, &bridge);
    let manifests = svc.read_pack_manifests(&handle).await.unwrap_or_default();
    let scope = handle.scope()?;
    let reader = PackReader::from_user_config();
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
            "kind": m.kind,
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
                    "  pack {}  ({} bytes, {})",
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
mod tests {
    use super::*;
    use clap::Parser as _;

    fn add_args(argv: &[&str]) -> StorageAddArgs {
        let mut full = vec!["dg", "storage", "add"];
        full.extend_from_slice(argv);
        match crate::Cli::parse_from(full).command {
            crate::Command::Storage(StorageCommand::Add(a)) => *a,
            _ => panic!("expected storage add"),
        }
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
    }
}
