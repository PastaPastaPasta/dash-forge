//! Per-user service integration. Rendering is pure and never invokes a shell.
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::config;
#[cfg(not(windows))]
use super::node_error;
use super::Node;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use anyhow::Context as _;
use anyhow::Result;
#[cfg(any(target_os = "macos", target_os = "linux", test))]
use std::path::Path;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::path::PathBuf;

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set")
}

#[cfg(target_os = "linux")]
fn user_config_dir() -> Result<PathBuf> {
    match std::env::var_os("XDG_CONFIG_HOME") {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => Ok(home()?.join(".config")),
    }
}

#[cfg(any(target_os = "macos", test))]
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(any(target_os = "macos", test))]
pub fn render_plist(exe: &Path, dir: &Path) -> String {
    let exe = xml(&exe.to_string_lossy());
    let log = xml(&dir.join("serve.log").to_string_lossy());
    let data = xml(&dir
        .parent()
        .and_then(Path::parent)
        .unwrap_or(dir)
        .to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>org.dashforge.ipfs</string>
<key>ProgramArguments</key><array><string>{exe}</string><string>ipfs</string><string>serve</string></array>
<key>EnvironmentVariables</key><dict><key>XDG_DATA_HOME</key><string>{data}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>{log}</string>
<key>StandardErrorPath</key><string>{log}</string>
</dict></plist>
"#
    )
}

#[cfg(any(target_os = "linux", test))]
fn unit_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}

#[cfg(any(target_os = "linux", test))]
pub fn render_unit(exe: &Path, dir: &Path) -> String {
    let exe = unit_quote(&exe.to_string_lossy().replace('$', "$$"));
    let data = unit_quote(&format!(
        "XDG_DATA_HOME={}",
        dir.parent().and_then(Path::parent).unwrap_or(dir).display()
    ));
    format!("[Unit]\nDescription=Dash Forge IPFS node\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart={exe} ipfs serve\nEnvironment={data}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=20\nUMask=0077\n\n[Install]\nWantedBy=default.target\n")
}

async fn command(program: &str, args: &[&str]) -> Result<bool> {
    Ok(tokio::process::Command::new(program)
        .args(args)
        .output()
        .await?
        .status
        .success())
}

#[cfg(target_os = "macos")]
async fn domain() -> Result<String> {
    let out = tokio::process::Command::new("id")
        .arg("-u")
        .output()
        .await?;
    if !out.status.success() {
        return Err(node_error(
            "could not find the user service domain",
            "run `dg ipfs serve` yourself",
        ));
    }
    Ok(format!("gui/{}", String::from_utf8(out.stdout)?.trim()))
}

pub async fn stop(node: &Node) -> Result<()> {
    if node.config.service {
        #[cfg(target_os = "macos")]
        {
            let _ = command(
                "launchctl",
                &[
                    "bootout",
                    &format!("{}/org.dashforge.ipfs", domain().await?),
                ],
            )
            .await;
        }
        #[cfg(target_os = "linux")]
        {
            let _ = command("systemctl", &["--user", "stop", "dash-forge-ipfs.service"]).await;
        }
        #[cfg(windows)]
        {
            let _ = command("schtasks", &["/End", "/TN", "DashForgeIPFS"]).await;
        }
    }
    // Also stops a foreground `serve` without sending a signal to an unverified PID.
    super::serve::stop(node).await
}

pub async fn install(node: &Node, linger: bool) -> Result<bool> {
    let exe = std::env::current_exe()?;
    #[cfg(target_os = "macos")]
    {
        let _ = linger;
        let path = home()?.join("Library/LaunchAgents/org.dashforge.ipfs.plist");
        config::write_private(&path, render_plist(&exe, &node.dir).as_bytes())?;
        if !command(
            "launchctl",
            &["bootstrap", &domain().await?, &path.to_string_lossy()],
        )
        .await
        .unwrap_or(false)
        {
            return Err(node_error(
                "could not start the IPFS login service",
                "run `dg ipfs up --no-service`, then `dg ipfs serve` yourself",
            ));
        }
    }
    #[cfg(target_os = "linux")]
    {
        let base = user_config_dir()?;
        let path = base.join("systemd/user/dash-forge-ipfs.service");
        config::write_private(&path, render_unit(&exe, &node.dir).as_bytes())?;
        let ready = command("systemctl", &["--user", "daemon-reload"])
            .await
            .unwrap_or(false)
            && command(
                "systemctl",
                &["--user", "enable", "--now", "dash-forge-ipfs.service"],
            )
            .await
            .unwrap_or(false);
        if !ready {
            return Err(node_error(
                "systemd's user service is unavailable",
                "run `dg ipfs up --no-service`, then `dg ipfs serve` under your own supervisor",
            ));
        }
        if linger {
            if !command("loginctl", &["enable-linger"])
                .await
                .unwrap_or(false)
            {
                return Err(node_error(
                    "could not enable services before login",
                    "run `loginctl enable-linger` yourself, or omit --linger",
                ));
            }
        } else {
            eprintln!(
                "Hint: `loginctl enable-linger $USER` keeps the node running without a login."
            );
        }
    }
    #[cfg(windows)]
    {
        let _ = (node, linger);
        let task = format!("\"{}\" ipfs serve", exe.display());
        let ready = command(
            "schtasks",
            &[
                "/Create",
                "/F",
                "/SC",
                "ONLOGON",
                "/TN",
                "DashForgeIPFS",
                "/TR",
                &task,
            ],
        )
        .await
        .unwrap_or(false)
            && command("schtasks", &["/Run", "/TN", "DashForgeIPFS"])
                .await
                .unwrap_or(false);
        if !ready {
            eprintln!("Warning: could not start the logon task; run `dg ipfs serve` yourself.");
            return Ok(false);
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = (exe, linger);
        return Err(node_error(
            "user services are unsupported on this platform",
            "run `dg ipfs up --no-service`, then `dg ipfs serve`",
        ));
    }
    Ok(true)
}

pub async fn uninstall(node: &Node) -> Result<()> {
    stop(node).await?;
    if node.config.service {
        #[cfg(target_os = "macos")]
        {
            remove_if_present(&home()?.join("Library/LaunchAgents/org.dashforge.ipfs.plist"))?;
        }
        #[cfg(target_os = "linux")]
        {
            let _ = command(
                "systemctl",
                &["--user", "disable", "dash-forge-ipfs.service"],
            )
            .await;
            let base = user_config_dir()?;
            remove_if_present(&base.join("systemd/user/dash-forge-ipfs.service"))?;
            let _ = command("systemctl", &["--user", "daemon-reload"]).await;
        }
        #[cfg(windows)]
        {
            let _ = command("schtasks", &["/Delete", "/F", "/TN", "DashForgeIPFS"]).await;
        }
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn remove_if_present(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg_attr(windows, allow(clippy::unused_async))]
pub async fn state(node: &Node) -> &'static str {
    if !node.config.service {
        return "manual";
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(domain) = domain().await {
            if command(
                "launchctl",
                &["print", &format!("{domain}/org.dashforge.ipfs")],
            )
            .await
            .unwrap_or(false)
            {
                return "running";
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if command(
            "systemctl",
            &["--user", "is-active", "--quiet", "dash-forge-ipfs.service"],
        )
        .await
        .unwrap_or(false)
        {
            return "running";
        }
    }
    "stopped or managed manually"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_rendering_matches_goldens() {
        assert_eq!(
            render_plist(Path::new("/opt/dg"), Path::new("/data/dash-forge/ipfs")),
            include_str!("fixtures/service.plist")
        );
        assert_eq!(
            render_unit(Path::new("/opt/dg"), Path::new("/data/dash-forge/ipfs")),
            include_str!("fixtures/service.unit")
        );
        assert!(
            render_plist(Path::new("/a&b/dg"), Path::new("/data/dash-forge/ipfs"))
                .contains("/a&amp;b/dg")
        );
        assert_eq!(unit_quote("/a %b$\"/dg"), "\"/a %%b$\\\"/dg\"");
    }
}
