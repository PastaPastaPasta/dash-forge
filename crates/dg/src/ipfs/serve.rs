//! Supervise kubo and the two streaming loopback listeners in one user service.
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncReadExt as _};
use tokio::sync::{watch, Mutex};
use tokio::task::JoinSet;

use super::{config, follow, node_error, proxy, Node};

pub async fn shutdown(mut receiver: watch::Receiver<bool>) {
    if !*receiver.borrow() {
        let _ = receiver.changed().await;
    }
}

async fn signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! { result = tokio::signal::ctrl_c() => result?, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await?;
    }
    Ok(())
}

pub async fn run(node: Node) -> Result<()> {
    let _guard = config::lock(&node.dir, "serve.lock")?;
    let _ = std::fs::remove_file(node.dir.join("stop"));
    let tokens = config::Tokens::load(&node)?;
    let state = proxy::Proxy::new(node.clone(), tokens.clone())?;
    let api = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, node.config.api_port))
        .await
        .context("could not bind the IPFS API port")?;
    let gateway =
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, node.config.gateway_port))
            .await
            .context("could not bind the IPFS gateway port")?;
    let (sender, receiver) = watch::channel(false);
    let mut tasks = JoinSet::new();
    let rx = receiver.clone();
    let api_router = proxy::rpc_router(state.clone());
    tasks.spawn(async move {
        axum::serve(api, api_router)
            .with_graceful_shutdown(shutdown(rx))
            .await
            .map_err(anyhow::Error::from)
    });
    let rx = receiver.clone();
    let gw_router = proxy::gateway_router(state);
    tasks.spawn(async move {
        axum::serve(gateway, gw_router)
            .with_graceful_shutdown(shutdown(rx))
            .await
            .map_err(anyhow::Error::from)
    });
    tasks.spawn(supervise(node.clone(), tokens, receiver.clone()));
    let follow_node = node.clone();
    let rx = receiver.clone();
    tasks.spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30 * 60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                () = shutdown(rx.clone()) => return Ok(()),
                _ = interval.tick() => {
                    tokio::select! {
                        () = shutdown(rx.clone()) => return Ok(()),
                        result = follow::follow_tick(&follow_node) => if let Err(error) = result { tracing::warn!(%error, "IPFS follow refresh failed"); }
                    }
                }
            }
        }
    });
    let result = tokio::select! {
        result = signal() => result,
        () = stop_requested(&node) => Ok(()),
        result = tasks.join_next() => match result { Some(result) => result.unwrap_or_else(|error| Err(error.into())), None => Ok(()) },
    };
    let _ = sender.send(true);
    // Give in-flight streams a bounded grace period, then close their connections.
    let drained = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(joined) = tasks.join_next().await {
            joined??;
        }
        Ok::<(), anyhow::Error>(())
    })
    .await;
    match drained {
        Ok(result) => result?,
        Err(_) => {
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
        }
    }
    result
}

async fn stop_requested(node: &Node) {
    loop {
        if node.dir.join("stop").exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub async fn stop(node: &Node) -> Result<()> {
    config::private_dir(&node.dir)?;
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(node.dir.join("serve.lock"))?;
    if file.try_lock().is_ok() {
        return Ok(());
    }
    config::write_private(&node.dir.join("stop"), b"stop\n")?;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if file.try_lock().is_ok() {
            return Ok(());
        }
    }
    Err(node_error(
        "the IPFS supervisor has not stopped",
        "stop `dg ipfs serve` before changing its configuration",
    ))
}

async fn supervise(
    node: Node,
    tokens: config::Tokens,
    receiver: watch::Receiver<bool>,
) -> Result<()> {
    let log_lock = Arc::new(Mutex::new(()));
    let mut backoff = 1;
    loop {
        if *receiver.borrow() {
            return Ok(());
        }
        let start = tokio::time::Instant::now();
        let child = tokio::process::Command::new(node.binary())
            .env("IPFS_PATH", node.repo())
            .args(["daemon", "--migrate=true"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        match child {
            Ok(mut child) => {
                let stdout = child.stdout.take().context("missing kubo stdout")?;
                let stderr = child.stderr.take().context("missing kubo stderr")?;
                let out = tokio::spawn(log_stream(stdout, node.clone(), log_lock.clone()));
                let err = tokio::spawn(log_stream(stderr, node.clone(), log_lock.clone()));
                tokio::select! {
                    result = child.wait() => { result?; }
                    () = shutdown(receiver.clone()) => {
                        // shutdown is authenticated and only targets our child's repo. No token in argv.
                        let _ = super::status::admin_rpc(&node, &tokens, "shutdown").await;
                        if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_err() { child.kill().await?; }
                        let _ = out.await; let _ = err.await;
                        return Ok(());
                    }
                }
                out.await??;
                err.await??;
            }
            Err(_) => {
                tracing::warn!("could not start kubo; retrying");
            }
        }
        if start.elapsed() > Duration::from_secs(60) {
            backoff = 1;
        }
        tokio::select! {
            () = shutdown(receiver.clone()) => return Ok(()),
            () = tokio::time::sleep(Duration::from_secs(backoff)) => {}
        }
        backoff = (backoff * 2).min(60);
    }
}

async fn log_stream(
    mut stream: impl AsyncRead + Unpin,
    node: Node,
    lock: Arc<Mutex<()>>,
) -> Result<()> {
    let mut buffer = [0; 8192];
    loop {
        let size = stream.read(&mut buffer).await?;
        if size == 0 {
            return Ok(());
        }
        let _guard = lock.lock().await;
        let path = node.dir.join("serve.log");
        if std::fs::metadata(&path)
            .is_ok_and(|m| m.len() + u64::try_from(size).unwrap_or(8192) > 5 * 1024 * 1024)
        {
            let old = node.dir.join("serve.log.1");
            if old.exists() {
                std::fs::remove_file(&old)?;
            }
            std::fs::rename(&path, old)?;
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        options.open(path)?.write_all(&buffer[..size])?;
    }
}
