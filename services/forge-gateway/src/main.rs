//! `forge-gateway`: see the crate docs and `docs/hosting/forge-gateway.md`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, Result};
use clap::Parser as _;
use forge_core::network::NetworkSettings;
use forge_core::platform::PlatformClient;
use forge_gateway::metrics::Metrics;
use forge_gateway::mirror::Mirrors;
use forge_gateway::upstream::{PlatformUpstream, Upstream};
use forge_gateway::{router, AppState, Config};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();
    let cfg = Arc::new(Config::parse());
    if cfg.cache_max_bytes < cfg.repo_max_bytes {
        anyhow::bail!("GATEWAY_CACHE_MAX must be at least GATEWAY_REPO_MAX");
    }
    std::fs::create_dir_all(&cfg.data_dir)
        .with_context(|| format!("creating {}", cfg.data_dir.display()))?;

    let target = NetworkSettings::from_env()
        .resolve()
        .context("resolving the network (DASH_FORGE_NETWORK, DASH_FORGE_DEVNET_NAME, …)")?;
    target.require_v2()?;
    let client = PlatformClient::connect(target)
        .await
        .context("connecting to Dash Platform")?;
    // The append-only histories (refs, feeds) persist across restarts: a refresh reads only
    // what landed since.
    client.history().set_dir(cfg.data_dir.join("history"));
    let upstream: Arc<dyn Upstream> = Arc::new(PlatformUpstream::new(
        client,
        cfg.data_dir.join("home"),
        cfg.helper_dir.clone(),
    )?);
    let metrics = Arc::new(Metrics::default());
    let mirrors = Arc::new(Mirrors::new(
        Arc::clone(&cfg),
        Arc::clone(&upstream),
        Arc::clone(&metrics),
    )?);
    let loaded = mirrors.load_existing().await?;
    let state = Arc::new(AppState::new(
        Arc::clone(&cfg),
        Arc::clone(&mirrors),
        Arc::clone(&metrics),
    ));
    tracing::info!(
        network = %upstream.network(),
        listen = %cfg.listen,
        mirrors = loaded,
        all_public = cfg.all_public,
        "forge-gateway starting"
    );

    for spec in cfg.repos.iter().filter(|s| !s.trim().is_empty()) {
        spawn_listed(spec.trim().to_string(), &state, &mirrors, &upstream);
    }
    spawn_poller(
        Arc::clone(&mirrors),
        Duration::from_secs(cfg.poll_secs.max(10)),
    );

    if let (Some(url), Some(secret_file)) = (cfg.wake_url.clone(), cfg.wake_secret_file.as_deref())
    {
        let secret = forge_gateway::wake::read_secret(secret_file)?;
        tokio::spawn(forge_gateway::wake::run(
            url,
            secret,
            Arc::clone(&mirrors),
            Arc::clone(&metrics),
        ));
    }

    let listener = tokio::net::TcpListener::bind(cfg.listen)
        .await
        .with_context(|| format!("listening on {}", cfg.listen))?;
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

/// `--repos`: mirrored now and kept warm (retried until the name resolves).
fn spawn_listed(
    spec: String,
    state: &Arc<AppState>,
    mirrors: &Arc<Mirrors>,
    upstream: &Arc<dyn Upstream>,
) {
    let (state, mirrors, upstream) = (Arc::clone(state), Arc::clone(mirrors), Arc::clone(upstream));
    tokio::spawn(async move {
        let Some((owner, name)) = spec.split_once('/') else {
            tracing::error!(repo = %spec, "GATEWAY_REPOS entries are owner/name");
            return;
        };
        let mut wait = Duration::from_secs(10);
        loop {
            match upstream.resolve(owner, name.trim_end_matches(".git")).await {
                Ok(Some(info)) if info.public => {
                    state.allow(&info);
                    let slot = mirrors.pin(&info);
                    mirrors.trigger(&slot);
                    return;
                }
                Ok(_) => {
                    tracing::error!(repo = %spec, "not a public repository: not mirrored");
                    return;
                }
                Err(e) => {
                    tracing::warn!(repo = %spec, error = %format!("{e:#}"), "resolving a listed repository; retrying");
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(Duration::from_secs(600));
                }
            }
        }
    });
}

/// The poller: warm mirrors are checked against Platform every `every`, and the cache trimmed.
fn spawn_poller(mirrors: Arc<Mirrors>, every: Duration) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            for slot in mirrors.warm() {
                if mirrors.stale(&slot) {
                    mirrors.trigger(&slot);
                }
            }
            mirrors.evict().await;
        }
    });
}

/// Ctrl-C or SIGTERM (`docker stop`).
async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = ctrl_c.await;
    }
    tracing::info!("shutting down");
}
