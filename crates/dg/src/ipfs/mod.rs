//! A managed local IPFS node and its browser connection.
pub(crate) mod config;
mod follow;
mod install;
mod pair;
mod proxy;
mod serve;
mod service;
mod status;

use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Subcommand;
use forge_core::storage::profiles::KuboProfile;
use forge_core::storage::{Profile, StorageProfiles};
use forge_core::user_error::{codes, UserError};
use serde_json::json;

use crate::context::Ctx;
use config::{Node, NodeConfig, Tokens};

pub(crate) fn init_serve_logging() -> Result<()> {
    let dir = config::data_dir()?;
    config::private_dir(&dir)?;
    let writer = serve::log_writer(&dir);
    forge_core::logging::init_cli_writer(move || writer.clone(), false);
    Ok(())
}

pub const KUBO_VERSION: &str = "0.43.1";
pub const FORGE_RPC_PATHS: &[&str] = &[
    "/api/v0/add",
    "/api/v0/pin/add",
    "/api/v0/pin/ls",
    "/api/v0/pin/rm",
    "/api/v0/id",
    "/api/v0/version",
];

pub fn node_error(message: &str, fix: &str) -> anyhow::Error {
    UserError::new(codes::STORAGE_CONFIG, message)
        .fix(fix)
        .into()
}

#[derive(Debug, Subcommand)]
pub enum IpfsCommand {
    /// Set up an IPFS node and connect it to Forge.
    Up(UpArgs),
    /// Run the node until stopped (also used by the login service).
    #[command(hide = true)]
    Serve,
    /// Show the node, stored bytes, pins and followed repositories.
    Status,
    /// Get a new connection code for the web app.
    Connect {
        /// Print the connection link without opening a browser.
        #[arg(long)]
        no_open: bool,
        /// Use this allowed website for the connection link.
        #[arg(long, value_name = "ORIGIN")]
        origin: Option<String>,
    },
    /// Manage which websites may connect to this node.
    #[command(subcommand)]
    Origin(OriginCommand),
    /// Stop the node and remove its login service.
    Down {
        /// Also delete the node's stored files and storage profile (asks first).
        #[arg(long)]
        purge: bool,
    },
    /// Run a command with the managed IPFS program.
    Ipfs {
        /// Arguments to pass to IPFS, after --.
        #[arg(last = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Keep a repository's files on this node, and optionally follow its new pushes.
    Pin(crate::ipfs_pin::IpfsPinArgs),
}

#[derive(Debug, clap::Args)]
#[allow(clippy::struct_excessive_bools)] // Independent setup flags.
pub struct UpArgs {
    /// Also allow this website to connect (https address without a path; repeatable).
    #[arg(long, value_name = "ORIGIN")]
    origin: Vec<String>,
    /// Storage profile name (default: kubo, or this node's saved name).
    #[arg(long, value_name = "NAME")]
    name: Option<String>,
    /// Local API port (default: 5001, or the saved port).
    #[arg(long, value_name = "PORT")]
    api_port: Option<u16>,
    /// Local read port (default: 8080, or the saved port).
    #[arg(long, value_name = "PORT")]
    gateway_port: Option<u16>,
    /// Replace the node's access tokens; connect your browsers again afterwards.
    #[arg(long)]
    rotate_token: bool,
    /// Set up without a login service; then run `dg ipfs serve` yourself.
    #[arg(long)]
    no_service: bool,
    /// On Linux, keep the service running without a login.
    #[arg(long, conflicts_with = "no_service")]
    linger: bool,
    /// Print the connection link without opening a browser.
    #[arg(long)]
    no_open: bool,
}

#[derive(Debug, Subcommand)]
pub enum OriginCommand {
    /// Allow a website and restart the node.
    Add { origin: String },
    /// Remove a website and restart the node.
    Remove { origin: String },
}

pub async fn run(ctx: &Ctx, command: &IpfsCommand) -> Result<()> {
    match command {
        IpfsCommand::Up(args) => Box::pin(up(ctx, args)).await,
        IpfsCommand::Serve => Box::pin(serve::run(ctx, Node::load()?)).await,
        IpfsCommand::Status => {
            let value = status::collect(&Node::load()?).await?;
            ctx.emit(value.clone(), || {
                println!(
                    "IPFS node: kubo {}, peer {}",
                    value["kuboVersion"].as_str().unwrap_or("?"),
                    value["peerId"].as_str().unwrap_or("?")
                );
                println!("  Service: {}", value["service"].as_str().unwrap_or("?"));
                println!(
                    "  Stored: {} bytes; {} recursive pins",
                    value["repoBytes"], value["recursivePins"]
                );
                println!(
                    "  Reachability: {}",
                    value["reachability"].as_str().unwrap_or("?")
                );
                if let Some(fix) = value["fix"].as_str() {
                    println!("  Fix: {fix}");
                }
                println!("  Origins: {}", value["origins"]);
                println!("  Listen addresses: {}", value["listenAddresses"]);
                println!("  Followed repositories: {}", value["followed"]);
            });
            Ok(())
        }
        IpfsCommand::Connect { no_open, origin } => {
            let mut node = Node::load()?;
            if let Some(origin) = origin {
                node.config.set_link_origin(Some(origin))?;
            }
            let connection = pair::create(&node)?;
            let opened = open_link(&connection.link, *no_open || ctx.json).await;
            ctx.emit(json!({"connect":connection}), || {
                print_connection(&connection, opened);
            });
            Ok(())
        }
        IpfsCommand::Origin(command) => Box::pin(origin(ctx, command)).await,
        IpfsCommand::Down { purge } => Box::pin(down(ctx, *purge)).await,
        IpfsCommand::Ipfs { args } => passthrough(ctx, args).await,
        IpfsCommand::Pin(args) => Box::pin(crate::ipfs_pin::run_pin(ctx, args)).await,
    }
}

fn profile(node: &Node, auth_ref: Option<String>) -> Result<Profile> {
    Ok(Profile::IpfsKubo(KuboProfile {
        api: node.api(),
        gateway: Some(node.gateway()),
        public_gateway: None,
        api_auth: auth_ref.map(|s| s.parse()).transpose()?,
        allow_private_uri: false,
    }))
}

#[allow(clippy::too_many_lines)] // One ordered setup: install, stop, configure, verify, save, connect.
async fn up(ctx: &Ctx, args: &UpArgs) -> Result<()> {
    let dir = config::data_dir()?;
    let _guard = config::lock(&dir, "config.lock")?;
    let mut node = if dir.join("node.toml").exists() {
        Node::load_from(dir)?
    } else {
        Node {
            dir,
            config: NodeConfig::default(),
        }
    };
    node.config
        .set_binary_override(std::env::var_os("DASH_FORGE_KUBO_BIN"))?;
    if let Some(name) = &args.name {
        node.config.name.clone_from(name);
    }
    if let Some(port) = args.api_port {
        node.config.api_port = port;
    }
    if let Some(port) = args.gateway_port {
        node.config.gateway_port = port;
    }
    for origin in &args.origin {
        let origin = config::validate_origin(origin)?;
        if origin.starts_with("http:") {
            eprintln!("Warning: allowing a local development website over http.");
        }
        if !node.config.origins.contains(&origin) {
            node.config.origins.push(origin);
        }
    }
    node.config
        .set_link_origin(args.origin.first().map(String::as_str))?;
    node.config.validate()?;
    if let Some(existing) = StorageProfiles::load()?.get(&node.config.name) {
        if !matches!(existing, Profile::IpfsKubo(ref p) if p.api == node.api()) {
            return Err(crate::errors::usage("this profile name belongs to another storage address; choose a new name with --name"));
        }
    }
    install::install(&node).await?;
    node.config.kubo_version = KUBO_VERSION.into();
    check_public_ports(&node).await?;
    if args.no_service {
        service::uninstall(&node).await?;
    } else {
        service::stop(&node).await?;
    }
    config::refuse_live_kubo(&node).await?;
    let tokens = Tokens::load_or_create(&node, args.rotate_token)?;
    // Any earlier connection code is no longer valid after reconfiguration.
    if node.dir.join("pair.json").exists() {
        std::fs::remove_file(node.dir.join("pair.json"))?;
    }
    config::configure(&node, &tokens).await?;
    node.config.service = !args.no_service;
    node.save()?;
    // In --no-service mode, run a temporary supervisor for the same verification, then
    // stop it. The user starts their permanent foreground supervisor with `ipfs serve`.
    if node.config.service {
        check_public_ports(&node).await?;
        node.config.service = service::install(&node, args.linger).await?;
        node.save()?;
    }
    let mut temporary = if node.config.service {
        None
    } else {
        Some(
            tokio::process::Command::new(std::env::current_exe()?)
                .args(["ipfs", "serve"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()?,
        )
    };
    let verified = Box::pin(verify(&node, &tokens, !ctx.json)).await;
    if let Some(child) = temporary.as_mut() {
        let stopped = serve::stop(&node).await;
        if stopped.is_ok()
            && tokio::time::timeout(Duration::from_secs(20), child.wait())
                .await
                .is_err()
        {
            child.kill().await?;
        }
        stopped?;
    }
    let (peer_id, version) = verified?;
    let auth = format!("Bearer {}", tokens.forge);
    let name = node.config.name.clone();
    let stored = tokio::task::spawn_blocking(move || {
        forge_core::keychain::set(forge_core::keychain::SERVICE, &name, &auth)
    })
    .await?
    .is_ok();
    let auth_ref = if stored {
        format!("keychain:dash-forge/{}", node.config.name)
    } else {
        eprintln!("The OS keychain is unavailable. The CLI profile uses env:DASH_FORGE_KUBO_AUTH; set it to the node's Forge bearer token when pushing. IPFS commands use private tokens.toml directly.");
        "env:DASH_FORGE_KUBO_AUTH".into()
    };
    crate::storage::save_profile(
        &node.config.name,
        &crate::StorageAddArgs {
            kind: Some(crate::ProfileKindArg::IpfsKubo),
            api: Some(node.api()),
            gateway: Some(node.gateway()),
            api_auth: Some(auth_ref),
            ..Default::default()
        },
    )?;
    let connection = pair::create(&node)?;
    let opened = open_link(
        &connection.link,
        args.no_open || ctx.json || !node.config.service,
    )
    .await;
    let value = json!({"node":{"kuboVersion":version,"peerId":peer_id,"api":node.api(),"gateway":node.gateway(),"origins":node.config.origins,"service":if node.config.service {"login"} else {"manual"}}, "profile":node.config.name,"connect":connection});
    ctx.emit(value, || {
        println!(
            "IPFS node ready: kubo {version}, peer {peer_id}, {}.",
            if node.config.service {
                "starts at login"
            } else {
                "run `dg ipfs serve` to start it"
            }
        );
        println!(
            "  RPC      {} (add, pin, unpin, id; allowed websites only)",
            node.api()
        );
        println!(
            "  Gateway  {} (serves only what this node holds)",
            node.gateway()
        );
        println!(
            "  CLI      storage profile {:?} saved — `dg storage use {}` sends your pushes there.",
            node.config.name, node.config.name
        );
        print_connection(&connection, opened);
    });
    Ok(())
}

async fn check_public_ports(node: &Node) -> Result<()> {
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()?;
    let running = std::fs::File::open(node.dir.join("serve.lock"))
        .is_ok_and(|file| matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)));
    let mut reservations = Vec::new();
    for (port, base, flag) in [
        (node.config.api_port, node.api(), "--api-port"),
        (node.config.gateway_port, node.gateway(), "--gateway-port"),
    ] {
        match std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)) {
            Ok(listener) => reservations.push(listener),
            Err(_) if running && proxy::healthy(&http, &base).await => {}
            Err(_) => {
                return Err(node_error(
                    &format!("IPFS public port {port} is already in use"),
                    &format!("choose a free port with {flag}"),
                ))
            }
        }
    }
    Ok(())
}

async fn verify(node: &Node, tokens: &Tokens, live: bool) -> Result<(String, String)> {
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()?;
    let ready = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if proxy::healthy(&http, &node.api()).await
                && proxy::healthy(&http, &node.gateway()).await
                && http
                    .post(format!("{}/api/v0/version", node.api()))
                    .bearer_auth(&tokens.forge)
                    .send()
                    .await
                    .is_ok_and(|r| r.status().is_success())
            {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
    .await;
    if ready.is_err() {
        return Err(node_error(
            "the IPFS node did not become ready within 60 seconds",
            "start it: dg ipfs up",
        ));
    }
    let report = crate::storage::run_checks_with_auth(
        &profile(node, None)?,
        live,
        Some(&format!("Bearer {}", tokens.forge)),
    )
    .await;
    if !report.ok() {
        return Err(UserError::new(
            codes::STORAGE_TEST,
            "the IPFS node failed its storage checks",
        )
        .cause(report.failed().join(", "))
        .fix("start it: dg ipfs up")
        .into());
    }
    let id = status::admin_rpc(node, tokens, "id").await?;
    let version = status::admin_rpc(node, tokens, "version").await?;
    Ok((
        id["ID"].as_str().context("kubo peer id missing")?.into(),
        version["Version"]
            .as_str()
            .context("kubo version missing")?
            .into(),
    ))
}

async fn origin(ctx: &Ctx, command: &OriginCommand) -> Result<()> {
    let mut node = Node::load()?;
    let _guard = config::lock(&node.dir, "config.lock")?;
    let (origin, add) = match command {
        OriginCommand::Add { origin } => (origin, true),
        OriginCommand::Remove { origin } => (origin, false),
    };
    let origin = config::validate_origin(origin)?;
    if origin == config::DEFAULT_ORIGIN && !add {
        return Err(crate::errors::usage(
            "the Forge website must remain an allowed origin",
        ));
    }
    if add && origin.starts_with("http:") {
        eprintln!("Warning: allowing a local development website over http.");
    }
    service::stop(&node).await?;
    if add {
        if !node.config.origins.contains(&origin) {
            node.config.origins.push(origin);
        }
    } else {
        node.config.origins.retain(|o| o != &origin);
        if node.config.link_origin == origin {
            node.config.set_link_origin(None)?;
        }
    }
    config::configure(&node, &Tokens::load(&node)?).await?;
    node.save()?;
    if node.config.service {
        check_public_ports(&node).await?;
        node.config.service = service::install(&node, false).await?;
        node.save()?;
    } else {
        eprintln!("Origins saved; run `dg ipfs serve` to restart the node.");
    }
    ctx.emit(json!({"origins":node.config.origins}), || {
        println!("Allowed websites: {}", node.config.origins.join(", "));
    });
    Ok(())
}

fn directory_bytes(path: &std::path::Path) -> Result<u64> {
    let mut size = 0;
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let meta = entry.path().symlink_metadata()?;
        size += if meta.is_dir() {
            directory_bytes(&entry.path())?
        } else {
            meta.len()
        };
    }
    Ok(size)
}

async fn down(ctx: &Ctx, purge: bool) -> Result<()> {
    let node = Node::load()?;
    let _guard = config::lock(&node.dir, "config.lock")?;
    if purge {
        let size = directory_bytes(&node.repo())?;
        ctx.confirm_or_cancel(&format!(
            "Delete this IPFS node and its {size} stored bytes?"
        ))?;
    }
    service::uninstall(&node).await?;
    let _repo_guard = if purge && node.repo().exists() {
        config::refuse_live_kubo(&node).await?;
        Some(config::lock(&node.repo(), "repo.lock").map_err(|_| {
            node_error(
                "the kubo repo is still in use",
                "stop any manually started kubo daemon before purging",
            )
        })?)
    } else {
        None
    };
    if purge {
        let path = StorageProfiles::default_path()?;
        let mut profiles = StorageProfiles::load_from(&path)?;
        if matches!(profiles.get(&node.config.name), Some(Profile::IpfsKubo(ref p)) if p.api == node.api())
        {
            let removed = profiles
                .profiles
                .remove(&node.config.name)
                .context("managed profile missing")?;
            profiles.save_to(&path)?;
            let _ = crate::storage::remove_owned_secrets(
                &node.config.name,
                &removed,
                &profiles,
                forge_core::keychain::delete,
            );
        }
        // Delete this managed directory only. No global IPFS or storage cleanup.
        std::fs::remove_dir_all(&node.dir)?;
    }
    ctx.emit(json!({"status":"stopped","purged":purge}), || {
        println!(
            "IPFS node stopped{}.",
            if purge {
                " and its stored files deleted"
            } else {
                ""
            }
        );
    });
    Ok(())
}

async fn passthrough(ctx: &Ctx, args: &[String]) -> Result<()> {
    let node = Node::load()?;
    let tokens = Tokens::load(&node)?;
    // Kubo 0.43.1 has no API-auth environment option. The owner token is necessarily
    // visible in this child argv to local process inspectors, but is never logged by dg.
    let mut command = tokio::process::Command::new(node.binary());
    command
        .env("IPFS_PATH", node.repo())
        .arg(format!(
            "--api=/ip4/127.0.0.1/tcp/{}",
            node.config.internal_api_port
        ))
        .arg(format!("--api-auth=bearer:{}", tokens.admin))
        .args(args);
    if ctx.json {
        let output = command.output().await?;
        let value = json!({"exitCode":output.status.code(),"stdout":String::from_utf8_lossy(&output.stdout),"stderr":String::from_utf8_lossy(&output.stderr)});
        if !output.status.success() {
            return Err(crate::errors::reported(
                UserError::new(codes::STORAGE_CONFIG, "IPFS command failed")
                    .fix("check the command's exit code"),
                value,
            ));
        }
        ctx.emit(value, || {});
    } else if !command.status().await?.success() {
        return Err(node_error(
            "IPFS command failed",
            "see the IPFS command's output",
        ));
    }
    Ok(())
}

async fn open_link(link: &str, skip: bool) -> bool {
    if skip {
        return false;
    }
    #[cfg(target_os = "macos")]
    let mut command = tokio::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = {
        if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return false;
        }
        tokio::process::Command::new("xdg-open")
    };
    #[cfg(windows)]
    let mut command = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/c", "start", ""]);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = link;
        return false;
    }
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    {
        command
            .arg(link)
            .output()
            .await
            .is_ok_and(|o| o.status.success())
    }
}

fn print_connection(connection: &pair::Connection, opened: bool) {
    println!(
        "Connecting the web app… {} {}",
        if opened { "opened" } else { "open" },
        connection.link
    );
    println!(
        "Settings → Storage → IPFS (kubo) → Connect with a code: {} (valid 10 min).",
        connection.code
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn public_port_conflicts_name_the_corresponding_flag() {
        let temp = tempfile::tempdir().unwrap();
        let api = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let gateway = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let node = Node {
            dir: temp.path().to_owned(),
            config: NodeConfig {
                api_port: api.local_addr().unwrap().port(),
                gateway_port: gateway.local_addr().unwrap().port(),
                ..Default::default()
            },
        };
        let error = check_public_ports(&node).await.unwrap_err();
        let user = error.downcast_ref::<UserError>().unwrap();
        assert!(user.to_json().to_string().contains("--api-port"));
        drop(api);
        let error = check_public_ports(&node).await.unwrap_err();
        let user = error.downcast_ref::<UserError>().unwrap();
        assert!(user.to_json().to_string().contains("--gateway-port"));
        drop(gateway);
        assert!(check_public_ports(&node).await.is_ok());
    }

    #[test]
    fn missing_repo_has_no_bytes_to_purge() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(directory_bytes(&temp.path().join("repo")).unwrap(), 0);
    }
}
