//! Wiring: the store, Platform, the embedded relay, the router, the pollers and the API.

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tokio::sync::watch;

use forge_core::platform::PlatformClient;
use forge_relay::config::{CliOverrides, RelayConfig};
use forge_relay::daemon::Embed;
use forge_relay::sinks::{EventSink, NameCache};

use crate::api::{self, ApiSettings, App};
use crate::auth::PlatformKeys;
use crate::chain::PlatformChain;
use crate::config::{secret_env, Config};
use crate::crypto::Vault;
use crate::dispatch::Dispatcher;
use crate::error::{NotifyError, Result};
use crate::index::{Indexer, ReindexQueue};
use crate::limits::RateLimiter;
use crate::mail::{Mailer, SmtpMailer};
use crate::push::{Pusher, WebPusher};
use crate::route::{MentionIndex, NotifySink, Router};
use crate::store::{day_of, now_ms, Store};

/// How often private repositories are polled for activity.
const PRIVATE_POLL: Duration = Duration::from_secs(300);

/// The relay settings the service embeds: no relay identity, no webhooks, no listener (the
/// service serves its own), a non-durable queue (nothing is ever retried without a hook).
pub fn relay_config(cfg: &Config) -> Result<RelayConfig> {
    let mut rc = RelayConfig::load(
        None,
        &CliOverrides {
            network: cfg.network.clone(),
            poll_interval_secs: Some(cfg.poll_interval.as_secs()),
            web_base_url: Some(cfg.web_url.clone()),
            lookback: Some(0),
            ..CliOverrides::default()
        },
    )
    .map_err(|e| NotifyError::Config(e.to_string()))?;
    rc.use_platform_webhooks = false;
    rc.identity_path = None;
    rc.listen = None;
    rc.state_dir = None;
    rc.state_dir_explicit = false;
    Ok(rc)
}

/// Run the service until SIGTERM or ctrl-c.
pub async fn run(cfg: Config) -> Result<()> {
    let vault = Arc::new(Vault::from_base64(
        secret_env("FORGE_NOTIFY_DATA_KEY")?
            .ok_or_else(|| {
                NotifyError::Config(
                    "FORGE_NOTIFY_DATA_KEY (or _FILE) is required: `forge-notify keys` makes one"
                        .into(),
                )
            })?
            .as_str(),
    )?);
    let store = Store::open(&cfg.data_dir)?;
    let relay_cfg = relay_config(&cfg)?;
    let client = Arc::new(PlatformClient::connect(relay_cfg.target.clone()).await?);
    let chain = Arc::new(PlatformChain::connect(Arc::clone(&client)).await?);
    // Present: connecting the chain needs forge-v2.
    let forge = relay_cfg.target.v2.clone().ok_or_else(|| {
        NotifyError::Config(format!(
            "forge-v2 is not deployed on {}",
            relay_cfg.target.network
        ))
    })?;

    let (mailer, pusher) = channels(&cfg)?;
    tracing::info!(
        network = %relay_cfg.target.network,
        email = mailer.is_some(),
        push = pusher.is_some(),
        operator = %cfg.operator,
        "forge-notify starting"
    );

    let dispatcher = Arc::new(Dispatcher {
        store: store.clone(),
        vault: Arc::clone(&vault),
        mailer,
        pusher,
        public_url: cfg.public_url.clone(),
        web_url: cfg.web_url.clone(),
        operator: cfg.operator.clone(),
        contact: cfg.contact.clone(),
        per_user_daily: cfg.limits.per_user_daily,
        daily_budget: cfg.limits.daily_send_budget,
    });
    let (feed_tx, feed_rx) = watch::channel(BTreeSet::new());
    let mentions = Arc::new(RwLock::new(MentionIndex::default()));
    let indexer = Arc::new(Indexer::new(
        store.clone(),
        chain,
        Arc::clone(&dispatcher),
        feed_tx,
        Arc::clone(&mentions),
        cfg.limits,
        cfg.web_url.clone(),
    ));

    let (sink, events) = NotifySink::new();
    tokio::spawn(
        Router {
            store: store.clone(),
            dispatcher: Arc::clone(&dispatcher),
            names: Some(Arc::new(NameCache::new(Arc::clone(&client)))),
            mentions,
        }
        .run(events),
    );

    let ready = Arc::new(AtomicBool::new(false));
    let reindex = Arc::new(ReindexQueue::default());
    spawn_background(&cfg, &indexer, &dispatcher, &store, Arc::clone(&reindex));

    let relay = tokio::spawn({
        let sinks: Vec<Arc<dyn EventSink>> = vec![Arc::new(sink)];
        let ready = Arc::clone(&ready);
        async move {
            ready.store(true, Ordering::SeqCst);
            let r = forge_relay::daemon::run_with(
                relay_cfg,
                Embed {
                    sinks,
                    watch_feed: Some(feed_rx),
                    watch_events: Vec::new(),
                },
            )
            .await;
            ready.store(false, Ordering::SeqCst);
            r
        }
    });

    let app = Arc::new(App {
        store,
        vault,
        keys: Arc::new(PlatformKeys::new(client)),
        dispatcher,
        limiter: RateLimiter::new(cfg.limits.per_ip_per_minute),
        reindex,
        ready,
        settings: api_settings(&cfg, forge),
    });
    serve(cfg.listen, app, relay).await
}

/// Serve the API until the embedded relay stops (it handles SIGTERM and ctrl-c).
async fn serve(
    listen: SocketAddr,
    app: Arc<App>,
    relay: tokio::task::JoinHandle<forge_relay::error::Result<()>>,
) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|e| NotifyError::Config(format!("listening on {listen}: {e}")))?;
    tracing::info!(listen = %listen, "API listening");
    let server = axum::serve(
        listener,
        api::router(app).into_make_service_with_connect_info::<SocketAddr>(),
    );
    // The relay stops on SIGTERM / ctrl-c itself; the API stops with it.
    tokio::select! {
        r = server => r.map_err(|e| NotifyError::Internal(format!("server: {e}")))?,
        r = relay => {
            match r {
                Ok(Ok(())) => tracing::info!("stopped"),
                Ok(Err(e)) => return Err(NotifyError::Unavailable(format!("the watcher stopped: {e}"))),
                Err(e) => return Err(NotifyError::Internal(format!("the watcher panicked: {e}"))),
            }
        }
    }
    Ok(())
}

/// The mailer and the pusher.
type Channels = (Option<Arc<dyn Mailer>>, Option<Arc<dyn Pusher>>);

/// The mailer and the pusher the configuration asks for (at least one).
fn channels(cfg: &Config) -> Result<Channels> {
    let mailer: Option<Arc<dyn Mailer>> = match &cfg.smtp {
        Some(t) => Some(Arc::new(
            SmtpMailer::new(t, &cfg.operator).map_err(NotifyError::Config)?,
        )),
        None => None,
    };
    let pusher: Option<Arc<dyn Pusher>> = match (
        secret_env("FORGE_NOTIFY_VAPID_PRIVATE_KEY")?,
        &cfg.vapid_subject,
    ) {
        (Some(k), Some(subject)) => Some(Arc::new(WebPusher::new(k.as_str(), subject)?)),
        (None, None) => None,
        _ => {
            return Err(NotifyError::Config(
                "push needs both FORGE_NOTIFY_VAPID_PRIVATE_KEY and FORGE_NOTIFY_VAPID_SUBJECT"
                    .into(),
            ))
        }
    };
    if mailer.is_none() && pusher.is_none() {
        return Err(NotifyError::Config(
            "nothing to send with: configure SMTP (FORGE_NOTIFY_SMTP_HOST) and/or Web Push \
             (FORGE_NOTIFY_VAPID_PRIVATE_KEY)"
                .into(),
        ));
    }
    Ok((mailer, pusher))
}

/// The API's view of the configuration.
pub fn api_settings(cfg: &Config, forge: forge_core::network::ForgeIds) -> ApiSettings {
    ApiSettings {
        operator: cfg.operator.clone(),
        forge,
        public_url: cfg.public_url.clone(),
        allowed_origins: cfg.allowed_origins.clone(),
        privacy_url: cfg.privacy_url.clone(),
        contact: cfg.contact.clone(),
        push_hosts: cfg.push_hosts.clone(),
        insecure_local: cfg.insecure_local,
        trust_proxy: cfg.trust_proxy,
        max_subscribers: cfg.limits.max_subscribers,
        max_repos_per_user: cfg.limits.max_repos_per_user,
        digest_hour: cfg.digest_hour,
    }
}

/// The index rebuilds, the pollers, digests and the daily purge.
fn spawn_background(
    cfg: &Config,
    indexer: &Arc<Indexer>,
    dispatcher: &Arc<Dispatcher>,
    store: &Store,
    reindex: Arc<ReindexQueue>,
) {
    let ix = Arc::clone(indexer);
    let every = cfg.index_interval;
    tokio::spawn(async move {
        loop {
            if let Err(e) = ix.refresh_all().await {
                tracing::warn!(error = %e, "index rebuild failed");
            }
            tokio::time::sleep(every).await;
        }
    });
    let ix = Arc::clone(indexer);
    let st = store.clone();
    tokio::spawn(async move {
        loop {
            for identity in reindex.next_batch().await {
                if let Ok(Some(s)) = st.subscriber(&identity) {
                    if let Err(e) = ix.refresh_one(&s).await {
                        tracing::warn!(error = %e, "indexing a subscriber failed");
                    }
                }
            }
            if let Err(e) = ix.rebuild_feed() {
                tracing::warn!(error = %e, "rebuilding the watch feed failed");
            }
        }
    });
    let ix = Arc::clone(indexer);
    let every = cfg.addressed_interval;
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(every).await;
            if let Err(e) = ix.poll_addressed().await {
                tracing::warn!(error = %e, "addressed poll failed");
            }
        }
    });
    let ix = Arc::clone(indexer);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(PRIVATE_POLL).await;
            if let Err(e) = ix.poll_private().await {
                tracing::warn!(error = %e, "private activity poll failed");
            }
        }
    });
    let d = Arc::clone(dispatcher);
    let st = store.clone();
    let hour = u64::from(cfg.digest_hour);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            let now = now_ms();
            let today = day_of(now);
            if (now / 3_600_000) % 24 == hour
                && st.cursor("digest:day").ok().flatten() != Some(today)
            {
                let _ = st.set_cursor("digest:day", today);
                match d.send_digests().await {
                    Ok(n) => tracing::info!(digests = n, "daily digests sent"),
                    Err(e) => tracing::warn!(error = %e, "daily digests failed"),
                }
                if let Err(e) = st.purge() {
                    tracing::warn!(error = %e, "purge failed");
                }
            }
        }
    });
}
