//! Opt-in real-kubo smoke test. No public network is used by ordinary unit tests.
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn dg(data: &Path, config: &Path, kubo: &std::ffi::OsStr) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_dg"));
    command
        .env("XDG_DATA_HOME", data)
        .env("XDG_CONFIG_HOME", config)
        .env("LOCALAPPDATA", data)
        .env("DASH_FORGE_NO_KEYCHAIN", "1")
        .env("DASH_FORGE_KUBO_BIN", kubo)
        .env(
            "DASH_FORGE_STORAGE_CONFIG",
            config.join("dash-forge/storage.toml"),
        )
        .stdin(Stdio::null());
    command
}

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
#[ignore = "needs DASH_FORGE_KUBO_BIN pointing to kubo 0.43.1; see src/ipfs/README.md"]
fn managed_ipfs_live_up_serve_and_offline_config() {
    let kubo = std::env::var_os("DASH_FORGE_KUBO_BIN").expect("set DASH_FORGE_KUBO_BIN");
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let config = temp.path().join("config");
    std::fs::create_dir_all(config.join("dash-forge")).unwrap();
    std::fs::write(
        config.join("dash-forge/storage.toml"),
        "[read]\nipfs_gateways = []\n",
    )
    .unwrap();
    // Hold both public ports until immediately before setup to avoid picking the same one.
    let api = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let gateway = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let api_port = api.local_addr().unwrap().port();
    let gateway_port = gateway.local_addr().unwrap().port();
    drop((api, gateway));
    let up = dg(&data, &config, &kubo)
        .args([
            "ipfs",
            "up",
            "--no-service",
            "--no-open",
            "--json",
            "--api-port",
            &api_port.to_string(),
            "--gateway-port",
            &gateway_port.to_string(),
        ])
        .output()
        .unwrap();
    assert!(up.status.success(), "managed node setup failed");
    let value: serde_json::Value = serde_json::from_slice(&up.stdout).unwrap();
    assert_eq!(value["node"]["kuboVersion"], "0.43.1");
    assert_eq!(value["node"]["service"], "manual");
    let repo = data.join("dash-forge/ipfs/repo");
    let shown = Command::new(&kubo)
        .env("IPFS_PATH", &repo)
        .args(["config", "show"])
        .output()
        .unwrap();
    assert!(shown.status.success());
    let cfg: serde_json::Value = serde_json::from_slice(&shown.stdout).unwrap();
    assert_eq!(cfg["Gateway"]["NoFetch"], true);
    assert_eq!(cfg["API"]["Authorizations"].as_object().unwrap().len(), 2);
    let running = Running(
        dg(&data, &config, &kubo)
            .args(["ipfs", "serve"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let status = dg(&data, &config, &kubo)
            .args(["ipfs", "status", "--json"])
            .output()
            .unwrap();
        if status.status.success() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "managed node did not become ready"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    let stopped = dg(&data, &config, &kubo)
        .args(["ipfs", "down", "--purge", "--yes", "--json"])
        .output()
        .unwrap();
    assert!(stopped.status.success());
    assert!(!data.join("dash-forge/ipfs").exists());
    drop(running);
}
