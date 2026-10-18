//! Private managed-node state and offline kubo configuration.
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use base64::Engine as _;
use rand::RngCore as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{node_error, FORGE_RPC_PATHS, KUBO_VERSION};

fn default_link_origin() -> String {
    DEFAULT_ORIGIN.into()
}

pub const DEFAULT_ORIGIN: &str = "https://forge.dashhq.org";
const STORAGE_DEFAULTS: &str =
    include_str!("../../../../forge-contracts/config/storage-defaults.json");

#[derive(Clone)]
pub(crate) struct Node {
    pub dir: PathBuf,
    pub config: NodeConfig,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NodeConfig {
    pub name: String,
    pub api_port: u16,
    pub gateway_port: u16,
    pub internal_api_port: u16,
    pub internal_gateway_port: u16,
    pub origins: Vec<String>,
    #[serde(default = "default_link_origin")]
    pub link_origin: String,
    pub kubo_version: String,
    pub service: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_override: Option<PathBuf>,
}

impl Default for NodeConfig {
    fn default() -> Self {
        Self {
            name: "kubo".into(),
            api_port: 5001,
            gateway_port: 8080,
            internal_api_port: 5101,
            internal_gateway_port: 8180,
            origins: vec![DEFAULT_ORIGIN.into()],
            link_origin: default_link_origin(),
            kubo_version: KUBO_VERSION.into(),
            service: false,
            binary_override: None,
        }
    }
}

impl Node {
    pub fn load() -> Result<Self> {
        Self::load_from(data_dir()?)
    }

    pub fn load_from(dir: PathBuf) -> Result<Self> {
        let config: NodeConfig =
            toml::from_str(&fs::read_to_string(dir.join("node.toml")).map_err(|_| {
                node_error("no managed IPFS node is configured", "run `dg ipfs up`")
            })?)?;
        config.validate()?;
        Ok(Self { dir, config })
    }

    pub fn save(&self) -> Result<()> {
        self.config.validate()?;
        write_private(
            &self.dir.join("node.toml"),
            toml::to_string(&self.config)?.as_bytes(),
        )
    }

    pub fn repo(&self) -> PathBuf {
        self.dir.join("repo")
    }
    pub fn api(&self) -> String {
        format!("http://127.0.0.1:{}", self.config.api_port)
    }
    pub fn gateway(&self) -> String {
        format!("http://127.0.0.1:{}", self.config.gateway_port)
    }
    pub fn internal_api(&self) -> String {
        format!("http://127.0.0.1:{}", self.config.internal_api_port)
    }
    pub fn binary(&self) -> PathBuf {
        std::env::var_os("DASH_FORGE_KUBO_BIN")
            .map(PathBuf::from)
            .or_else(|| self.config.binary_override.clone())
            .unwrap_or_else(|| {
                self.dir
                    .join("bin")
                    .join(if cfg!(windows) { "ipfs.exe" } else { "ipfs" })
            })
    }
}

impl NodeConfig {
    /// An older repo is migrated by kubo; a newer repo requires a newer dg.
    pub fn validate_version(&self) -> Result<()> {
        let parse = |version: &str| -> Option<Vec<u64>> {
            let parts = version
                .split('.')
                .map(str::parse)
                .collect::<Result<Vec<u64>, _>>()
                .ok()?;
            (parts.len() == 3).then_some(parts)
        };
        let recorded = parse(&self.kubo_version);
        if recorded.is_none() || recorded > parse(KUBO_VERSION) {
            return Err(node_error(
                "this node requires a newer kubo version",
                "upgrade dg",
            ));
        }
        Ok(())
    }

    pub fn set_binary_override(&mut self, binary: Option<std::ffi::OsString>) -> Result<()> {
        self.binary_override = binary.map(fs::canonicalize).transpose()?;
        Ok(())
    }

    pub fn set_link_origin(&mut self, origin: Option<&str>) -> Result<()> {
        let origin = origin
            .map(validate_origin)
            .transpose()?
            .unwrap_or_else(default_link_origin);
        if !self.origins.contains(&origin) {
            return Err(forge_core::user_error::UserError::new(
                forge_core::user_error::codes::USAGE,
                "the connection origin is not allowed for this node",
            )
            .fix(format!("dg ipfs origin add {origin}"))
            .into());
        }
        self.link_origin = origin;
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        if !forge_core::storage::profiles::valid_profile_name(&self.name) {
            return Err(crate::errors::usage("invalid storage profile name"));
        }
        if self
            .binary_override
            .as_ref()
            .is_some_and(|p| !p.is_absolute())
        {
            return Err(crate::errors::usage(
                "the kubo binary override must be an absolute path",
            ));
        }
        let ports = [
            self.api_port,
            self.gateway_port,
            self.internal_api_port,
            self.internal_gateway_port,
        ];
        if ports.contains(&0)
            || ports
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != 4
        {
            return Err(crate::errors::usage(
                "the node's four ports must be distinct and nonzero",
            ));
        }
        if !self.origins.iter().any(|o| o == DEFAULT_ORIGIN) {
            return Err(crate::errors::usage(
                "the Forge website must remain an allowed origin",
            ));
        }
        if !self.origins.contains(&self.link_origin) {
            return Err(crate::errors::usage(
                "the connection link origin must be allowed",
            ));
        }
        for origin in &self.origins {
            // Browsers omit the default http port from Origin. CLI input still needs
            // an explicit port, but persisted origins use the browser's canonical form.
            if matches!(origin.as_str(), "http://localhost" | "http://127.0.0.1") {
                validate_origin(&format!("{origin}:80"))?;
            } else {
                validate_origin(origin)?;
            }
        }
        Ok(())
    }
}

pub fn data_dir() -> Result<PathBuf> {
    // Like forge_config_dir, honor XDG explicitly; macOS follows the same data layout.
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    }
    .ok_or_else(|| {
        node_error(
            "cannot find the user data directory",
            "set XDG_DATA_HOME (LOCALAPPDATA on Windows)",
        )
    })?;
    if !base.is_absolute() {
        return Err(crate::errors::usage(
            "the data directory must be an absolute path",
        ));
    }
    Ok(base.join("dash-forge/ipfs"))
}

pub fn private_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("private file has no parent")?;
    private_dir(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

/// Keep this lock alive through read/modify/write operations; the file itself is never removed.
pub fn lock(dir: &Path, name: &str) -> Result<File> {
    private_dir(dir)?;
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(name))?;
    file.try_lock().map_err(|_| {
        node_error(
            "another IPFS command is using this node",
            "wait for it to finish and retry",
        )
    })?;
    Ok(file)
}

// Intentionally no Debug: tokens must never enter diagnostics.
#[derive(Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub forge: String,
    pub admin: String,
}

impl Tokens {
    pub fn load(node: &Node) -> Result<Self> {
        let text = fs::read_to_string(node.dir.join("tokens.toml"))?;
        let tokens: Self = toml::from_str(&text).map_err(|_| {
            node_error(
                "invalid tokens.toml",
                "restore the file or run `dg ipfs up --rotate-token`",
            )
        })?;
        for token in [&tokens.forge, &tokens.admin] {
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(token)
                .map_err(|_| node_error("invalid node token", "run `dg ipfs up --rotate-token`"))?;
            if bytes.len() != 32 {
                return Err(node_error(
                    "invalid node token length",
                    "run `dg ipfs up --rotate-token`",
                ));
            }
        }
        Ok(tokens)
    }

    pub fn load_or_create(node: &Node, rotate: bool) -> Result<Self> {
        if !rotate && node.dir.join("tokens.toml").exists() {
            return Self::load(node);
        }
        let generate = || {
            let mut bytes = [0; 32];
            rand::rngs::OsRng.fill_bytes(&mut bytes);
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
        };
        let tokens = Self {
            forge: generate(),
            admin: generate(),
        };
        write_private(
            &node.dir.join("tokens.toml"),
            toml::to_string(&tokens)?.as_bytes(),
        )?;
        Ok(tokens)
    }
}

pub fn validate_origin(origin: &str) -> Result<String> {
    let invalid = || {
        crate::errors::usage("origin must be an https address without a path, or http://localhost:PORT for development; shared IPFS gateways are refused")
    };
    let url = reqwest::Url::parse(origin).map_err(|_| invalid())?;
    let authority = origin.split_once("://").ok_or_else(invalid)?.1;
    if origin.chars().any(char::is_whitespace)
        || authority.contains(['/', '?', '#', '@', '\\'])
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    let host = url.host_str().ok_or_else(invalid)?;
    let shared: Value = serde_json::from_str(STORAGE_DEFAULTS)?;
    let mut denied = vec![
        "ipfs.io".to_string(),
        "dweb.link".into(),
        "cf-ipfs.com".into(),
        "gateway.pinata.cloud".into(),
    ];
    for gateway in shared["ipfsGateways"]
        .as_array()
        .context("storage gateway defaults")?
    {
        let parsed = reqwest::Url::parse(gateway.as_str().context("gateway URL")?)?;
        denied.push(parsed.host_str().context("gateway host")?.to_string());
    }
    if host.contains(".ipfs.")
        || denied.iter().any(|h| {
            host.trim_end_matches('.') == h
                || host.trim_end_matches('.').ends_with(&format!(".{h}"))
        })
    {
        return Err(invalid());
    }
    let local_http = url.scheme() == "http"
        && matches!(host, "localhost" | "127.0.0.1")
        && authority
            .rsplit_once(':')
            .is_some_and(|(_, port)| port.parse::<u16>().is_ok_and(|p| p > 0));
    if url.scheme() != "https" && !local_http {
        return Err(invalid());
    }
    Ok(url.origin().ascii_serialization())
}

pub fn patch_config(config: &mut Value, node: &Node, tokens: &Tokens) {
    config["Addresses"]["API"] = json!(format!(
        "/ip4/127.0.0.1/tcp/{}",
        node.config.internal_api_port
    ));
    config["Addresses"]["Gateway"] = json!(format!(
        "/ip4/127.0.0.1/tcp/{}",
        node.config.internal_gateway_port
    ));
    config["Gateway"]["NoFetch"] = json!(true);
    // The raw internal gateway is also reachable on loopback. Its default wildcard
    // CORS would bypass the proxy's origin boundary, so remove that wildcard too.
    config["Gateway"]["HTTPHeaders"]["Access-Control-Allow-Origin"] = json!(node.config.origins);
    config["Gateway"]["HTTPHeaders"]["Access-Control-Allow-Methods"] = json!(["GET", "HEAD"]);
    config["API"]["HTTPHeaders"]["Access-Control-Allow-Origin"] = json!(node.config.origins);
    config["API"]["HTTPHeaders"]["Access-Control-Allow-Methods"] = json!(["POST"]);
    config["API"]["Authorizations"] = json!({
        "dash-forge": {"AuthSecret": format!("bearer:{}", tokens.forge), "AllowedPaths": FORGE_RPC_PATHS},
        "owner": {"AuthSecret": format!("bearer:{}", tokens.admin), "AllowedPaths": ["/api/v0"]}
    });
}

/// Linux kubo uses fcntl locks, which do not conflict with our flock. Also probe its
/// advertised API address before offline writes; even an auth refusal means it is live.
pub async fn refuse_live_kubo(node: &Node) -> Result<()> {
    let address = match fs::read_to_string(node.repo().join("api")) {
        Ok(address) => address,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let parts: Vec<_> = address.trim().split('/').collect();
    let url = match parts.as_slice() {
        ["", "ip4" | "dns" | "dns4", host, "tcp", port] => format!("http://{host}:{port}"),
        ["", "ip6", host, "tcp", port] => format!("http://[{host}]:{port}"),
        _ => {
            return Err(node_error(
                "cannot probe the repo's API address",
                "stop any manually started kubo and remove its stale repo/api file",
            ))
        }
    };
    let live = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(2))
        .build()?
        .post(format!("{url}/api/v0/version"))
        .send()
        .await
        .is_ok();
    if live {
        return Err(node_error(
            "the kubo repo is still in use",
            "stop any manually started kubo daemon and retry",
        ));
    }
    Ok(())
}

pub async fn configure(node: &Node, tokens: &Tokens) -> Result<()> {
    refuse_live_kubo(node).await?;
    let path = node.repo().join("config");
    if !path.exists() {
        private_dir(&node.repo())?;
        let result = tokio::process::Command::new(node.binary())
            .env("IPFS_PATH", node.repo())
            .arg("init")
            .output()
            .await?;
        if !result.status.success() {
            return Err(node_error(
                "kubo could not initialize its repo",
                "check the data directory permissions and available disk space",
            ));
        }
    }
    // Supplement the live API probe with the advisory lock (flock on Unix).
    let _repo_guard = lock(&node.repo(), "repo.lock").map_err(|_| {
        node_error(
            "the kubo repo is still in use",
            "stop any manually started kubo daemon and retry",
        )
    })?;
    let mut config: Value = serde_json::from_slice(&fs::read(&path)?).map_err(|_| {
        node_error(
            "invalid kubo configuration",
            "restore the repo's config file",
        )
    })?;
    patch_config(&mut config, node, tokens);
    write_private(&path, &serde_json::to_vec_pretty(&config)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn live_repo_api_is_detected_even_when_it_refuses_auth() {
        let temp = tempfile::tempdir().unwrap();
        let node = Node {
            dir: temp.path().to_owned(),
            config: NodeConfig::default(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        private_dir(&node.repo()).unwrap();
        fs::write(
            node.repo().join("api"),
            format!("/ip4/127.0.0.1/tcp/{port}\n"),
        )
        .unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new().fallback(|| async { axum::http::StatusCode::UNAUTHORIZED }),
            )
            .await
            .unwrap();
        });
        let error = refuse_live_kubo(&node).await.unwrap_err();
        assert!(error
            .downcast_ref::<forge_core::user_error::UserError>()
            .is_some());
        task.abort();
        let _ = task.await;
        assert!(refuse_live_kubo(&node).await.is_ok()); // stale api file is harmless.
    }

    #[test]
    fn recorded_versions_allow_migration_but_refuse_downgrades() {
        let temp = tempfile::tempdir().unwrap();
        for version in ["0.9.0", "0.42.0", KUBO_VERSION, "0.44.0", "1.0.0", "bad"] {
            let config = NodeConfig {
                kubo_version: version.into(),
                ..Default::default()
            };
            let node = Node {
                dir: temp.path().to_owned(),
                config,
            };
            node.save().unwrap();
            let loaded = Node::load_from(temp.path().to_owned()).unwrap(); // up can load any recorded version.
            let result = loaded.config.validate_version();
            assert_eq!(
                result.is_ok(),
                matches!(version, "0.9.0" | "0.42.0" | KUBO_VERSION)
            );
            if let Err(error) = result {
                let user = error
                    .downcast_ref::<forge_core::user_error::UserError>()
                    .unwrap();
                assert!(user.to_json().to_string().contains("upgrade dg"));
            }
        }
    }

    #[test]
    fn binary_override_is_replaced_and_cleared_on_each_up() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let mut config = NodeConfig {
            binary_override: Some(temp.path().join("old")),
            ..Default::default()
        };
        config
            .set_binary_override(Some(temp.path().as_os_str().to_owned()))
            .unwrap();
        assert_eq!(
            config.binary_override,
            Some(fs::canonicalize(temp.path()).unwrap())
        );
        config.set_binary_override(None).unwrap();
        assert_eq!(config.binary_override, None);
    }

    #[test]
    fn origins_reject_shared_hosts_and_unsafe_components() {
        for bad in [
            "null",
            "*",
            "http://example.org",
            "http://localhost",
            "https://ipfs.io",
            "https://ipfs.io.",
            "https://x.ipfs.dweb.link",
            "https://forge.test/a",
            "https://forge.test/",
            "https://forge.test?x",
            "https://forge.test#x",
            "https://user@forge.test",
            "https://ipfs.filebase.io",
        ] {
            assert!(validate_origin(bad).is_err(), "{bad}");
        }
        for good in [
            DEFAULT_ORIGIN,
            "https://forge.test:8443",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ] {
            assert_eq!(validate_origin(good).unwrap(), good);
        }
        let defaults: Value = serde_json::from_str(STORAGE_DEFAULTS).unwrap();
        for gateway in defaults["ipfsGateways"].as_array().unwrap() {
            assert!(validate_origin(gateway.as_str().unwrap()).is_err());
        }
    }
    #[test]
    fn node_locks_are_exclusive_and_stale_files_do_not_block_restart() {
        let temp = tempfile::tempdir().unwrap();
        let first = lock(temp.path(), "repo.lock").unwrap();
        assert!(lock(temp.path(), "repo.lock").is_err());
        drop(first);
        assert!(lock(temp.path(), "repo.lock").is_ok());
    }

    #[test]
    fn secrets_round_trip_and_authorizations_are_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let node = Node {
            dir: temp.path().join("node"),
            config: NodeConfig::default(),
        };
        let tokens = Tokens::load_or_create(&node, false).unwrap();
        assert_eq!(
            tokens.forge,
            Tokens::load_or_create(&node, false).unwrap().forge
        );
        assert_ne!(
            tokens.forge,
            Tokens::load_or_create(&node, true).unwrap().forge
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                fs::metadata(node.dir.join("tokens.toml"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&node.dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        let mut config = json!({"API":{"Authorizations":{"old":{}}},"Identity":{"PeerID":"keep"}});
        patch_config(&mut config, &node, &tokens);
        assert_eq!(
            config["API"]["Authorizations"].as_object().unwrap().len(),
            2
        );
        assert_eq!(
            config["API"]["Authorizations"]["dash-forge"]["AllowedPaths"],
            json!(FORGE_RPC_PATHS)
        );
        assert_eq!(config["Gateway"]["NoFetch"], true);
        assert_eq!(
            config["Gateway"]["HTTPHeaders"]["Access-Control-Allow-Origin"],
            json!(node.config.origins)
        );
        assert_eq!(config["Identity"]["PeerID"], "keep");
    }
}
