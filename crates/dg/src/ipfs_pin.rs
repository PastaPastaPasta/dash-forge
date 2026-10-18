//! Repository pinning and the follow refresh called by the managed node's supervisor.

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context as _, Result};
use clap::{Args, Parser as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use forge_core::backends::ipfs::{IpfsConfig, PinningServiceConfig, DEFAULT_PIN_TIMEOUT};
use forge_core::backends::IpfsBackend;
use forge_core::keystore::Secret;
use forge_core::rules::v2::{Role, Visibility};
use forge_core::storage::pin::{
    pin_repo, pin_targets, PinEvent, PinOptions, PinOutcome, PinReaderContext, PinReport, PinWhat,
    RepoPinReader,
};
use forge_core::storage::{human_bytes, Profile, StorageProfiles};
use forge_core::user_error::{codes, UserError};

use crate::common::Reader;
use crate::context::Ctx;
use crate::fmt::safe;
use crate::ipfs::config::{data_dir as ipfs_data_dir, Node};

const PRIVATE_CONSENT: &str =
    "Your IP address will be listed on IPFS as holding this private repo's (encrypted) files.";

#[derive(Debug, Clone, Default, Args)]
#[allow(clippy::struct_excessive_bools)] // independent command switches
pub struct IpfsPinArgs {
    /// The repository (owner/name or repository id).
    #[arg(required_unless_present = "all", conflicts_with = "all")]
    pub repo: Option<String>,
    /// Use this IPFS storage profile.
    #[arg(long, value_name = "NAME")]
    pub profile: Option<String>,
    /// Pin now and refresh when new files are pushed.
    #[arg(long, conflicts_with_all = ["unfollow", "all"])]
    pub follow: bool,
    /// Stop refreshing this repository.
    #[arg(long, conflicts_with_all = ["follow", "all", "dry_run"])]
    pub unfollow: bool,
    /// Refresh every followed repository once.
    #[arg(long)]
    pub all: bool,
    /// Show the files and disk space needed, without pinning.
    #[arg(long)]
    pub dry_run: bool,
    /// Include full IPFS addresses in progress output.
    #[arg(long)]
    pub verbose: bool,
}

fn ensure_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn read_toml<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T> {
    match fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).with_context(|| format!("reading {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e.into()),
    }
}

fn write_toml(path: &Path, value: &impl Serialize) -> Result<()> {
    let dir = path.parent().context("file has no parent directory")?;
    ensure_dir(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    file.write_all(toml::to_string_pretty(value)?.as_bytes())?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| e.error)?;
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FollowFile {
    #[serde(default)]
    pub repo: Vec<FollowRepo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowRepo {
    pub network: String,
    pub repo_id: String,
    pub owner: String,
    pub name: String,
    #[serde(default)]
    pub last_run: u64,
    #[serde(default)]
    pub blobs: usize,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
    /// Consent persists for unattended refreshes, never inferred from a public follow.
    #[serde(default)]
    pub private_consent: bool,
}

pub fn followed_repos() -> Result<FollowFile> {
    read_toml(&ipfs_data_dir()?.join("follow.toml"))
}

fn update_follow(dir: &Path, change: impl FnOnce(&mut FollowFile)) -> Result<()> {
    ensure_dir(dir)?;
    // Lock the stable sidecar, since the data file is atomically replaced. Drop releases it.
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("follow.lock"))?;
    lock.lock()?;
    let path = dir.join("follow.toml");
    let mut file: FollowFile = read_toml(&path)?;
    change(&mut file);
    write_toml(&path, &file)
}

fn is_ipfs(profile: &Profile) -> bool {
    matches!(
        profile,
        Profile::IpfsKubo(_) | Profile::IpfsPinningService(_)
    )
}

fn select_profile<'a>(
    profiles: &'a StorageProfiles,
    node: Option<&Node>,
    name: Option<&str>,
) -> Result<(&'a str, &'a Profile)> {
    let find = |name: &str| {
        profiles
            .profiles
            .get_key_value(name)
            .filter(|(_, p)| is_ipfs(p))
    };
    if let Some(name) = name {
        return find(name)
            .map(|(key, profile)| (key.as_str(), profile))
            .ok_or_else(|| {
                UserError::new(
                    codes::STORAGE_CONFIG,
                    "the selected profile is not an IPFS profile",
                )
                .fix("run dg ipfs up, or pass --profile with an IPFS profile name")
                .into()
            });
    }
    if let Some((key, profile)) = node.and_then(|node| find(&node.config.name)) {
        return Ok((key, profile));
    }
    let mut candidates = profiles.profiles.iter().filter(|(_, p)| is_ipfs(p));
    if let Some((name, profile)) = candidates.next() {
        if candidates.next().is_none() {
            return Ok((name, profile));
        }
    }
    bail!(UserError::new(
        codes::NO_STORAGE,
        "choose an IPFS storage profile before pinning"
    )
    .fix("run dg ipfs up")
    .fix("or pass --profile <name>"))
}

fn backend(dir: &Path, node: Option<&Node>, profile: &Profile) -> Result<IpfsBackend> {
    let config = match profile {
        Profile::IpfsKubo(p) => {
            let managed = node
                .map(Node::api)
                .is_some_and(|api| api.trim_end_matches('/') == p.api.trim_end_matches('/'));
            let auth = if managed {
                // Never deserialize a token with an error that could echo its source line.
                #[derive(Deserialize)]
                struct Tokens {
                    forge: Secret,
                }
                let text = zeroize::Zeroizing::new(
                    fs::read_to_string(dir.join("tokens.toml"))
                        .context("reading the managed node token; run dg ipfs up")?,
                );
                let token: Tokens = toml::from_str(&text).map_err(|_| {
                    UserError::new(codes::STORAGE_SECRET, "cannot read the managed node token")
                        .fix("run dg ipfs up")
                })?;
                Some(Secret::new(format!("Bearer {}", token.forge.expose())))
            } else {
                p.api_auth
                    .as_ref()
                    .map(forge_core::storage::SecretRef::resolve)
                    .transpose()?
            };
            IpfsConfig {
                api: Some(p.api.trim_end_matches('/').into()),
                api_auth: auth,
                gateway: p.gateway.clone().unwrap_or_default(),
                pinning: None,
            }
        }
        Profile::IpfsPinningService(p) => IpfsConfig {
            // CID-only pinning: remote_pin must not query the profile's kubo node.
            api: None,
            api_auth: None,
            gateway: String::new(),
            pinning: Some(PinningServiceConfig {
                endpoint: p.pinning_endpoint.trim_end_matches('/').into(),
                token: p.pinning_token.resolve()?,
                timeout: p
                    .pin_timeout_secs
                    .map_or(DEFAULT_PIN_TIMEOUT, Duration::from_secs),
                poll_interval: Duration::from_secs(2),
            }),
        },
        _ => bail!("expected an IPFS profile"),
    };
    Ok(IpfsBackend::with_client(
        config,
        forge_core::storage::http_client(),
    ))
}

#[derive(Default, Serialize, Deserialize)]
struct Notes {
    #[serde(default)]
    dht: bool,
}

fn public_note(dir: &Path, quiet: bool) -> Result<()> {
    let path = dir.join("notes.toml");
    let mut notes: Notes = read_toml(&path)?;
    if !notes.dht && !quiet {
        eprintln!("Pinning announces on IPFS that this node holds the repo's files. This links your IP address and peer id to the repo.");
        notes.dht = true;
        write_toml(&path, &notes)?;
    }
    Ok(())
}

struct Finished {
    body: Value,
    report: PinReport,
}

/// The command entry point R1 merges into its IPFS command dispatcher.
pub async fn run_pin(ctx: &Ctx, args: &IpfsPinArgs) -> Result<()> {
    if args.all {
        let summary = Box::pin(refresh(ctx, args, false)).await?;
        let body = json!({"status": "refreshed", "repos": summary.repos, "failed": summary.failed});
        if !summary.failed.is_empty() {
            return Err(crate::errors::reported(
                UserError::new(
                    codes::PARTIAL,
                    "some followed repositories could not be pinned",
                ),
                body,
            ));
        }
        ctx.emit(body, || {});
        return Ok(());
    }
    if args.unfollow {
        let reader =
            Reader::open_unsealed(ctx, args.repo.as_deref().context("repository required")?)
                .await?;
        let network = ctx.network_label();
        update_follow(&ipfs_data_dir()?, |file| {
            file.repo
                .retain(|r| r.network != network || r.repo_id != reader.repo.id());
        })?;
        ctx.emit(
            json!({"status":"unfollowed", "repoId":reader.repo.id()}),
            || println!("Stopped following {}.", safe(&reader.repo.display())),
        );
        return Ok(());
    }
    let finished = Box::pin(pin(ctx, args, false)).await?;
    if !finished.report.failed.is_empty() {
        return Err(crate::errors::reported(
            UserError::new(codes::PARTIAL, "some repository files could not be pinned")
                .fix("run the pin command again to resume"),
            finished.body,
        ));
    }
    ctx.emit(finished.body, || {});
    Ok(())
}

#[allow(clippy::too_many_lines)] // resolve, consent, run and persist one repository's result
async fn pin(ctx: &Ctx, args: &IpfsPinArgs, quiet: bool) -> Result<Finished> {
    let dir = ipfs_data_dir()?;
    let profiles = StorageProfiles::load()?;
    let node = if dir.join("node.toml").exists() {
        Some(Node::load_from(dir.clone())?)
    } else {
        None
    };
    let (profile_name, profile) =
        select_profile(&profiles, node.as_ref(), args.profile.as_deref())?;
    let repo_arg = args.repo.as_deref().context("repository required")?;
    let unsealed = Reader::open_unsealed(ctx, repo_arg).await?;
    if unsealed.repo.visibility == Visibility::Private {
        let viewer = if let Some(viewer) = unsealed.viewer() {
            Some(viewer.to_string())
        } else if ctx.identity_path.is_some() {
            Some(ctx.signer_on(&unsealed.client).await?.1.id())
        } else {
            None
        };
        let roles = unsealed.service().copy_roles(&unsealed.repo).await?;
        if !viewer.as_deref().is_some_and(|who| {
            who == unsealed.repo.owner_id() || roles.get(who).is_some_and(|role| *role != Role::Bot)
        }) {
            bail!(UserError::new(
                codes::NOT_A_KEY_HOLDER,
                "only members can pin a private repo"
            )
            .fix("sign in as a repository member"));
        }
    }
    let read = Reader::open_discussion(ctx, repo_arg).await?;
    let service = read.service();
    let roles = service.copy_roles(&read.repo).await?;
    let manifests = service.read_pack_manifests(&read.repo).await?;
    let pack_reader = service.repo_reader(&read.repo, &manifests, &roles).await;
    let members = if read.repo.visibility == Visibility::Private {
        Some(service.keyring(&read.repo).await?)
    } else {
        service.keyring(&read.repo).await.ok()
    };
    if read.repo.visibility == Visibility::Public && members.is_some() {
        service.read_members_refs(&read.repo).await?;
    }
    let mut shared = std::collections::BTreeMap::new();
    if let Some(branches) = Box::pin(read.shared_branches()).await? {
        for branch in branches {
            shared.extend(branch.packs);
        }
    }
    let collab = read.collab();
    let plan = Box::pin(pin_targets(
        &service,
        &read.repo,
        &PinReaderContext {
            reader: &pack_reader,
            collab: &collab,
            members,
            shared,
        },
    ))
    .await?;
    let needs_consent = read.repo.visibility == Visibility::Private || plan.needs_consent;
    let sensitive = if args.dry_run {
        needs_consent
    } else {
        consent(ctx, needs_consent, quiet)?
    };
    if !args.dry_run && read.repo.visibility == Visibility::Public {
        public_note(&dir, quiet)?;
    }
    if !quiet && !ctx.json {
        println!("{} blobs · {} · {} not on IPFS · {} members-only, skipped · {} unreadable, skipped · {} invalid CIDs skipped · {} conflicting CIDs skipped · {} stranger copies ignored · cost 0 DASH (local disk only)",
            plan.targets.len(), human_bytes(plan.bytes()), plan.not_on_ipfs, plan.members_only_skipped, plan.unreadable_skipped, plan.invalid_cids_skipped, plan.conflicting_cids_skipped, plan.stranger_copies_ignored);
    }
    let report = if args.dry_run {
        PinReport::default()
    } else {
        let node = backend(&dir, node.as_ref(), profile)?;
        let reader = RepoPinReader {
            service: &service,
            repo: &read.repo,
            reader: &pack_reader,
            roles,
        };
        pin_repo(
            &plan,
            &node,
            &reader,
            &PinOptions {
                remote_name: format!("forge:{}/{}", read.repo.owner_id(), read.repo.name()),
                ..PinOptions::default()
            },
            |event| {
                if quiet || ctx.json {
                    return;
                }
                if let PinEvent::Done { i, outcome } = event {
                    let target = &plan.targets[i - 1];
                    let what = match &target.what {
                        PinWhat::Pack { .. } => "pack".to_string(),
                        PinWhat::ReleaseAsset { tag, name } => {
                            format!("release {}/{}", safe(tag), safe(name))
                        }
                    };
                    let state = match outcome {
                        PinOutcome::Already => "already".into(),
                        PinOutcome::Pinned { from } => {
                            format!("pinned (bytes from {})", safe(&from))
                        }
                        PinOutcome::Failed { why } => format!(
                            "FAILED: {}",
                            safe(&target.candidates.iter().fold(why, |why, candidate| {
                                why.replace(&candidate.cid, "[IPFS address]")
                            }))
                        ),
                    };
                    println!(
                        "[{i}/{}] {what} {}… {}  {state}{}",
                        plan.targets.len(),
                        target.sha256.chars().take(7).collect::<String>(),
                        human_bytes(target.size),
                        if args.verbose {
                            format!(
                                "  {}",
                                target
                                    .candidates
                                    .iter()
                                    .map(|c| c.cid.as_str())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            )
                        } else {
                            String::new()
                        }
                    );
                }
            },
        )
        .await
    };
    if !quiet && !ctx.json && !args.dry_run {
        println!(
            "{} blobs: {} pinned, {} already, {} failed · {} on your node · cost 0 DASH",
            plan.targets.len(),
            report.pinned,
            report.already,
            report.failed.len(),
            human_bytes(report.bytes)
        );
    }
    if args.follow && !args.dry_run {
        let entry = FollowRepo {
            network: ctx.network_label(),
            repo_id: read.repo.id().to_string(),
            owner: read.repo.owner_id().to_string(),
            name: read.repo.name().to_string(),
            last_run: now(),
            blobs: report.pinned + report.already,
            last_error: failure_text(&report),
            profile: Some(profile_name.to_string()),
            private_consent: sensitive,
        };
        update_follow(&dir, |file| {
            file.repo
                .retain(|r| r.network != entry.network || r.repo_id != entry.repo_id);
            file.repo.push(entry);
        })?;
    }
    Ok(Finished {
        body: json!({"status": if args.dry_run { "planned" } else { "pinned" }, "repoId": read.repo.id(),
        "profile":profile_name, "plan":plan, "totalBytes":plan.bytes(), "costDash":0, "report":report}),
        report,
    })
}

/// Return consent scoped to sensitive content; a public --yes is never a grant for later private pins.
fn consent(ctx: &Ctx, sensitive: bool, quiet: bool) -> Result<bool> {
    if !sensitive || ctx.yes {
        return Ok(sensitive);
    }
    if ctx.json || quiet {
        bail!(UserError::new(codes::CONFIRMATION_REQUIRED, PRIVATE_CONSENT).fix("add --yes"));
    }
    ctx.confirm_or_cancel(PRIVATE_CONSENT)?;
    Ok(true)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn failure_text(report: &PinReport) -> Option<String> {
    (!report.failed.is_empty()).then(|| {
        report
            .failed
            .iter()
            .map(|f| f.why.as_str())
            .collect::<Vec<_>>()
            .join("; ")
    })
}

#[derive(Debug, Default, Serialize)]
pub struct FollowSummary {
    pub repos: Vec<Value>,
    pub failed: Vec<String>,
}

/// Called once at service start and every 30 minutes. Never writes progress to stdout.
pub async fn follow_tick(ctx: &Ctx) -> Result<FollowSummary> {
    forge_core::sealed::forbid_prompts();
    Box::pin(refresh(
        ctx,
        &IpfsPinArgs {
            all: true,
            ..IpfsPinArgs::default()
        },
        true,
    ))
    .await
}

async fn refresh(ctx: &Ctx, args: &IpfsPinArgs, quiet: bool) -> Result<FollowSummary> {
    let follows = followed_repos()?;
    let mut summary = FollowSummary::default();
    for entry in follows.repo {
        let result = Box::pin(refresh_one(ctx, args, &entry, quiet)).await;
        let (blobs, last_error) = match &result {
            Ok(done) => (
                done.report.pinned + done.report.already,
                failure_text(&done.report),
            ),
            Err(error) => (
                entry.blobs,
                Some(forge_core::user_error::one_line(&error.to_string())),
            ),
        };
        if let Some(error) = &last_error {
            if !quiet && !ctx.json {
                eprintln!(
                    "{}/{}: FAILED: {}",
                    safe(&entry.owner),
                    safe(&entry.name),
                    safe(error)
                );
            }
            summary
                .failed
                .push(format!("{}/{}: {error}", entry.owner, entry.name));
        }
        summary.repos.push(match result {
            Ok(done) => done.body,
            Err(_) => json!({"repoId":entry.repo_id,"network":entry.network,"error":last_error}),
        });
        if !args.dry_run {
            update_follow(&ipfs_data_dir()?, |file| {
                if let Some(current) = file
                    .repo
                    .iter_mut()
                    .find(|r| r.network == entry.network && r.repo_id == entry.repo_id)
                {
                    current.last_run = now();
                    current.blobs = blobs;
                    current.last_error = last_error;
                }
            })?;
        }
    }
    Ok(summary)
}

async fn refresh_one(
    ctx: &Ctx,
    args: &IpfsPinArgs,
    entry: &FollowRepo,
    quiet: bool,
) -> Result<Finished> {
    let network = forge_core::network::Network::from_key(&entry.network);
    let mut flags: Vec<std::ffi::OsString> =
        vec!["dg".into(), "--network".into(), network.kind().into()];
    if let Some(name) = network.devnet_name() {
        flags.extend(["--devnet-name".into(), name.into()]);
    }
    if let Some(identity) = &ctx.cli_identity {
        flags.extend(["--identity".into(), identity.as_os_str().to_os_string()]);
    }
    flags.extend(["ipfs".into(), "pin".into(), entry.repo_id.clone().into()]);
    let cli = crate::Cli::try_parse_from(flags)?;
    let mut run = Ctx::resolve(&cli, &crate::config::Config::load()?)?;
    if entry.network == ctx.network_label() {
        run.target = ctx.target.clone();
    }
    run.json = ctx.json;
    run.yes = ctx.yes || entry.private_consent;
    run.stdin_tty = !quiet && ctx.stdin_tty;
    let options = IpfsPinArgs {
        repo: Some(entry.repo_id.clone()),
        profile: args.profile.clone().or_else(|| entry.profile.clone()),
        dry_run: args.dry_run,
        verbose: args.verbose,
        ..IpfsPinArgs::default()
    };
    Box::pin(pin(&run, &options, quiet)).await
}

/// Optional parent pinning is attached to the fork's one result object.
pub struct ForkPinResult {
    pub body: Value,
    pub failed: bool,
}

pub async fn pin_parent_after_fork(ctx: &Ctx, parent: &str) -> ForkPinResult {
    let result = Box::pin(pin(
        ctx,
        &IpfsPinArgs {
            repo: Some(parent.to_string()),
            ..IpfsPinArgs::default()
        },
        ctx.json,
    ))
    .await;
    match result {
        Ok(done) => ForkPinResult {
            failed: !done.report.failed.is_empty(),
            body: done.body,
        },
        Err(error)
            if error
                .downcast_ref::<UserError>()
                .is_some_and(|u| u.code == codes::NO_STORAGE) =>
        {
            eprintln!(
                "Fork created; run dg ipfs up, then dg ipfs pin {} to keep its files here.",
                safe(parent)
            );
            ForkPinResult {
                body: json!({"status":"unavailable", "fix":"run dg ipfs up"}),
                failed: false,
            }
        }
        Err(error) => ForkPinResult {
            body: json!({"status":"failed", "detail":forge_core::user_error::one_line(&error.to_string())}),
            failed: true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_selection_requires_an_unambiguous_ipfs_profile() {
        let profiles = StorageProfiles::parse("[profiles.one]\nkind='ipfs-kubo'\napi='http://127.0.0.1:5001'\n[profiles.two]\nkind='ipfs-kubo'\napi='http://127.0.0.1:5002'\n").unwrap();
        assert!(select_profile(&profiles, None, None).is_err());
        let managed = Some(Node {
            dir: std::path::PathBuf::new(),
            config: crate::ipfs::config::NodeConfig {
                name: "two".into(),
                ..Default::default()
            },
        });
        assert_eq!(
            select_profile(&profiles, managed.as_ref(), None).unwrap().0,
            "two"
        );
        assert_eq!(
            select_profile(&profiles, managed.as_ref(), Some("one"))
                .unwrap()
                .0,
            "one"
        );
    }

    #[test]
    fn follow_updates_preserve_other_networks_and_do_not_readd_unfollowed_repos() {
        let dir = tempfile::tempdir().unwrap();
        let entry = FollowRepo {
            network: "testnet".into(),
            repo_id: "repo".into(),
            owner: "owner".into(),
            name: "name".into(),
            last_run: 0,
            blobs: 0,
            last_error: None,
            profile: None,
            private_consent: false,
        };
        update_follow(dir.path(), |f| f.repo.push(entry.clone())).unwrap();
        update_follow(dir.path(), |f| {
            f.repo.push(FollowRepo {
                network: "mainnet".into(),
                ..entry.clone()
            });
        })
        .unwrap();
        update_follow(dir.path(), |f| f.repo.retain(|r| r.network != "testnet")).unwrap();
        let file: FollowFile = read_toml(&dir.path().join("follow.toml")).unwrap();
        assert_eq!(file.repo.len(), 1);
        assert_eq!(file.repo[0].network, "mainnet");
        assert!(!file.repo[0].private_consent);
    }

    #[test]
    fn pin_flags_enforce_repository_or_all() {
        for flags in [
            vec!["dg", "ipfs", "pin"],
            vec!["dg", "ipfs", "pin", "o/r", "--all"],
            vec!["dg", "ipfs", "pin", "o/r", "--follow", "--unfollow"],
        ] {
            assert!(crate::Cli::try_parse_from(flags).is_err());
        }
        for flags in [
            vec!["dg", "ipfs", "pin", "--all"],
            vec!["dg", "ipfs", "pin", "o/r", "--yes", "--json"],
            vec!["dg", "repo", "fork", "o/r", "--pin"],
        ] {
            assert!(crate::Cli::try_parse_from(flags).is_ok());
        }
    }

    #[test]
    fn private_consent_is_required_for_json_and_unattended_refreshes() {
        let json = Ctx::scripted(false, true, false, None);
        let error = consent(&json, true, false).unwrap_err();
        let user = error.downcast_ref::<UserError>().unwrap();
        assert_eq!(user.code, codes::CONFIRMATION_REQUIRED);
        assert!(user.to_json().to_string().contains("add --yes"));
        let service = Ctx::scripted(false, false, false, None);
        assert!(consent(&service, true, true).is_err());
        assert!(!consent(&service, false, true).unwrap());
        let yes = Ctx::scripted(true, true, false, None);
        assert!(consent(&yes, true, true).unwrap());
        // A public follow created with --yes grants no future private-content consent.
        assert!(!consent(&yes, false, true).unwrap());
    }

    #[test]
    fn managed_auth_is_used_only_for_the_managed_api_and_parse_errors_hide_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let profiles = StorageProfiles::parse("[profiles.node]\nkind='ipfs-kubo'\napi='http://127.0.0.1:5001'\napi_auth='env:FORGE_TEST_MISSING_PIN_TOKEN'\n").unwrap();
        let written = Node {
            dir: dir.path().to_owned(),
            config: crate::ipfs::config::NodeConfig::default(),
        };
        written.save().unwrap();
        assert!(fs::read_to_string(dir.path().join("node.toml"))
            .unwrap()
            .contains("apiPort"));
        let node = Some(Node::load_from(dir.path().to_owned()).unwrap());
        fs::write(
            dir.path().join("tokens.toml"),
            "forge='local-stub-token'\nadmin='unused-stub-token'\n",
        )
        .unwrap();
        let profile = &profiles.profiles["node"];
        let node_backend = backend(dir.path(), node.as_ref(), profile).unwrap();
        assert_eq!(
            node_backend.config().api_auth.as_ref().unwrap().expose(),
            "Bearer local-stub-token"
        );
        fs::write(dir.path().join("tokens.toml"), "forge='DO-NOT-ECHO-THIS\n").unwrap();
        let error = backend(dir.path(), node.as_ref(), profile)
            .unwrap_err()
            .to_string();
        assert!(!error.contains("DO-NOT-ECHO-THIS"));
        assert!(error.contains("cannot read the managed node token"));
        // A foreign node does not consume a local node's token file.
        let public = StorageProfiles::parse(
            "[profiles.other]\nkind='ipfs-kubo'\napi='http://127.0.0.1:5002'\n",
        )
        .unwrap();
        assert!(
            backend(dir.path(), node.as_ref(), &public.profiles["other"])
                .unwrap()
                .config()
                .api_auth
                .is_none()
        );
    }

    #[test]
    fn concurrent_follow_updates_do_not_lose_entries() {
        let dir = tempfile::tempdir().unwrap();
        std::thread::scope(|scope| {
            for n in 0..8 {
                let path = dir.path();
                scope.spawn(move || {
                    update_follow(path, |file| {
                        file.repo.push(FollowRepo {
                            network: "testnet".into(),
                            repo_id: n.to_string(),
                            owner: "owner".into(),
                            name: n.to_string(),
                            last_run: 0,
                            blobs: 0,
                            last_error: None,
                            profile: None,
                            private_consent: false,
                        });
                    })
                    .unwrap();
                });
            }
        });
        let file: FollowFile = read_toml(&dir.path().join("follow.toml")).unwrap();
        assert_eq!(file.repo.len(), 8);
    }
}
