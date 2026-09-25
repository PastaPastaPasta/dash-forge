//! Per-network configuration: which Dash network a client targets, and which Dash Forge
//! contracts are deployed on it.
//!
//! - [`Network`] — testnet, mainnet, or a **named** devnet (`moutai`) with its own DAPI
//!   address list and quorum service (`https://quorums.<name>.networks.dash.org`).
//! - Contract ids come from `forge-contracts/deployments/<key>.json`, embedded at build time
//!   (`build.rs` globs the directory, so committing `mainnet.json` or `devnet-<name>.json`
//!   is the whole change). The key is `testnet`, `mainnet`, or `devnet-<name>`.
//! - [`NetworkSettings`] is one layer of user input (CLI flags, a config file, git config,
//!   the environment). Binaries stack layers with [`NetworkSettings::overlay`] in their own
//!   precedence order and call [`NetworkSettings::resolve`] once.
//! - A network with no registry deployment resolves with `registry: None`; the first
//!   operation that needs the registry fails with [`Error::NotDeployed`] rather than
//!   silently talking to another network's contract.
//!
//! SDK-free: [`crate::platform`] maps [`Network`] onto the SDK's types.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

include!(concat!(env!("OUT_DIR"), "/deployments.rs"));

/// Env var: the network kind (`testnet` / `mainnet` / `devnet`).
pub const ENV_NETWORK: &str = "DASH_FORGE_NETWORK";
/// Env var: the devnet name (`moutai`), used when the network is `devnet`.
pub const ENV_DEVNET_NAME: &str = "DASH_FORGE_DEVNET_NAME";
/// Env var: comma-separated devnet DAPI addresses (`host`, `host:port` or a full URL).
pub const ENV_DAPI_ADDRESSES: &str = "DASH_FORGE_DAPI_ADDRESSES";
/// Env var: an explicit quorum service base URL for a devnet.
pub const ENV_QUORUM_URL: &str = "DASH_FORGE_QUORUM_URL";
/// Env var: a registry contract id that overrides the embedded deployment.
pub const ENV_REGISTRY_CONTRACT_ID: &str = "FORGE_REGISTRY_CONTRACT_ID";

/// The DAPI port assumed when an address omits one (the Platform HTTPS gateway).
pub const DEFAULT_DAPI_PORT: u16 = 1443;

/// The network a client is bound to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    /// Dash testnet.
    Testnet,
    /// Dash mainnet.
    Mainnet,
    /// A named devnet. It has no built-in seed list: the DAPI addresses come from config,
    /// the devnet's deployment file, or (when both are empty) discovery through its quorum
    /// service at connect time.
    Devnet {
        /// The devnet name (`moutai`); selects `deployments/devnet-<name>.json` and the
        /// default quorum service host.
        name: String,
        /// DAPI endpoints as `https://host:port` URLs. Empty = discover at connect time.
        #[serde(default)]
        dapi_addresses: Vec<String>,
        /// Quorum service base URL; `None` = `https://quorums.<name>.networks.dash.org`.
        #[serde(default)]
        quorum_base_url: Option<String>,
    },
}

impl Network {
    /// The network kind: `testnet`, `mainnet` or `devnet` (the value `--network` takes).
    pub fn kind(&self) -> &'static str {
        match self {
            Network::Testnet => "testnet",
            Network::Mainnet => "mainnet",
            Network::Devnet { .. } => "devnet",
        }
    }

    /// The deployment key: `testnet`, `mainnet` or `devnet-<name>`. Names the
    /// `forge-contracts/deployments/<key>.json` file and the per-network identity directory.
    pub fn key(&self) -> String {
        match self {
            Network::Devnet { name, .. } => format!("devnet-{name}"),
            other => other.kind().to_string(),
        }
    }

    /// The devnet name, if this is a devnet.
    pub fn devnet_name(&self) -> Option<&str> {
        match self {
            Network::Devnet { name, .. } => Some(name),
            _ => None,
        }
    }

    /// The quorum service base URL the trusted context provider reads quorum keys from.
    pub fn quorum_base_url(&self) -> String {
        match self {
            Network::Testnet => "https://quorums.testnet.networks.dash.org".to_string(),
            Network::Mainnet => "https://quorums.mainnet.networks.dash.org".to_string(),
            Network::Devnet {
                quorum_base_url: Some(url),
                ..
            } => url.clone(),
            Network::Devnet { name, .. } => format!("https://quorums.{name}.networks.dash.org"),
        }
    }

    /// The env vars that select this network in a child process (`git` → git-remote-dash).
    /// Every var is always present so a stale inherited value cannot leak through.
    pub fn env_vars(&self) -> Vec<(&'static str, String)> {
        let (name, addresses, quorum) = match self {
            Network::Devnet {
                name,
                dapi_addresses,
                quorum_base_url,
            } => (
                name.clone(),
                dapi_addresses.join(","),
                quorum_base_url.clone().unwrap_or_default(),
            ),
            _ => (String::new(), String::new(), String::new()),
        };
        vec![
            (ENV_NETWORK, self.kind().to_string()),
            (ENV_DEVNET_NAME, name),
            (ENV_DAPI_ADDRESSES, addresses),
            (ENV_QUORUM_URL, quorum),
        ]
    }
}

impl fmt::Display for Network {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.key())
    }
}

/// Validate a devnet name the way the SDK's quorum-URL builder does, so a bad name fails
/// here with the flag's name in the message instead of deep inside connect.
fn validate_devnet_name(name: &str) -> Result<()> {
    let ok_chars = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !ok_chars || name.starts_with('-') || name.ends_with('-') {
        return Err(Error::Config(format!(
            "invalid devnet name {name:?}: use letters, digits and inner hyphens (e.g. `moutai`)"
        )));
    }
    // These alias a real network's quorum host (quorums.mainnet.networks.dash.org).
    if matches!(
        name.to_ascii_lowercase().as_str(),
        "mainnet" | "testnet" | "devnet" | "local" | "regtest"
    ) {
        return Err(Error::Config(format!(
            "invalid devnet name {name:?}: it is reserved (it would alias a non-devnet quorum host)"
        )));
    }
    Ok(())
}

/// Parse a comma-separated DAPI address list. Each entry is `host`, `host:port` or a full
/// `https://host:port` URL; a missing scheme becomes `https://` and a missing port
/// [`DEFAULT_DAPI_PORT`]. Empty entries are skipped.
pub fn parse_dapi_addresses(list: &str) -> Result<Vec<String>> {
    list.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(normalize_dapi_address)
        .collect()
}

fn normalize_dapi_address(raw: &str) -> Result<String> {
    let (scheme, rest) = raw.split_once("://").unwrap_or(("https", raw));
    let authority = rest.trim_end_matches('/');
    if authority.is_empty() || authority.contains('/') || authority.contains(char::is_whitespace) {
        return Err(Error::Config(format!(
            "invalid DAPI address {raw:?}: expected host, host:port or https://host:port"
        )));
    }
    if authority.contains(':') {
        Ok(format!("{scheme}://{authority}"))
    } else {
        Ok(format!("{scheme}://{authority}:{DEFAULT_DAPI_PORT}"))
    }
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

/// The on-disk shape of `forge-contracts/deployments/<key>.json` (only what clients read).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentFile {
    #[serde(default)]
    dapi_addresses: Vec<String>,
    #[serde(default)]
    quorum_base_url: Option<String>,
    #[serde(default)]
    registry: Option<ContractRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContractRecord {
    #[serde(default)]
    contract_id: Option<String>,
}

/// What an embedded deployment file records for one network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deployment {
    /// The deployment key (`testnet`, `devnet-moutai`).
    pub key: String,
    /// The registry contract id, or `None` when the file is a skeleton (not yet deployed).
    pub registry_contract_id: Option<String>,
    /// DAPI addresses recorded for a devnet (normalized); empty for testnet/mainnet.
    pub dapi_addresses: Vec<String>,
    /// A quorum service URL recorded for a devnet.
    pub quorum_base_url: Option<String>,
}

impl Deployment {
    /// The repo-relative path of the file this came from.
    pub fn path(&self) -> String {
        format!("forge-contracts/deployments/{}.json", self.key)
    }

    /// The registry this file records, sourced to the file; `None` for a skeleton.
    pub fn registry(&self) -> Option<Registry> {
        self.registry_contract_id
            .clone()
            .map(|contract_id| Registry {
                contract_id,
                source: ContractSource::Deployment(self.path()),
            })
    }
}

/// The keys of every embedded deployment file, sorted.
pub fn deployment_keys() -> impl Iterator<Item = &'static str> {
    EMBEDDED_DEPLOYMENTS.iter().map(|(key, _)| *key)
}

/// The embedded deployment for `key`, or `None` when no file exists for it.
pub fn deployment(key: &str) -> Result<Option<Deployment>> {
    let Some((_, raw)) = EMBEDDED_DEPLOYMENTS.iter().find(|(k, _)| *k == key) else {
        return Ok(None);
    };
    let file: DeploymentFile = serde_json::from_str(raw).map_err(|e| {
        Error::Config(format!(
            "forge-contracts/deployments/{key}.json is malformed: {e}"
        ))
    })?;
    Ok(Some(Deployment {
        key: key.to_string(),
        registry_contract_id: file
            .registry
            .and_then(|r| r.contract_id)
            .filter(|s| !s.is_empty()),
        dapi_addresses: file
            .dapi_addresses
            .iter()
            .map(|a| normalize_dapi_address(a))
            .collect::<Result<_>>()?,
        quorum_base_url: file.quorum_base_url.filter(|s| !s.is_empty()),
    }))
}

// ---------------------------------------------------------------------------
// Registry resolution
// ---------------------------------------------------------------------------

/// Where a resolved contract id came from (reported by `dg doctor`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractSource {
    /// A user override; the string names where it was set (`env FORGE_REGISTRY_CONTRACT_ID`,
    /// `config registry_contract_id`, `git config dash.registryContractId`).
    Override(String),
    /// The embedded deployment file (its repo-relative path).
    Deployment(String),
}

impl fmt::Display for ContractSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ContractSource::Override(origin) => write!(f, "override ({origin})"),
            ContractSource::Deployment(path) => f.write_str(path),
        }
    }
}

/// The registry contract a client uses, and where its id came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registry {
    /// The base58 registry contract id.
    pub contract_id: String,
    /// Where the id came from.
    pub source: ContractSource,
}

impl Registry {
    /// A user-supplied override, labelled with where it was set.
    pub fn override_from(contract_id: impl Into<String>, origin: impl Into<String>) -> Self {
        Self {
            contract_id: contract_id.into(),
            source: ContractSource::Override(origin.into()),
        }
    }
}

/// The registry for `network` with no user override: the embedded deployment's id, or
/// `None` when nothing is deployed there.
pub fn deployed_registry(network: &Network) -> Result<Option<Registry>> {
    Ok(deployment(&network.key())?.and_then(|d| d.registry()))
}

/// A network plus the registry resolved for it — what [`crate::platform::PlatformClient`]
/// connects to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkTarget {
    /// The network.
    pub network: Network,
    /// The registry, or `None` when no registry is deployed on `network` and no override
    /// was given (registry operations then fail with [`Error::NotDeployed`]).
    pub registry: Option<Registry>,
}

impl NetworkTarget {
    /// `network` with the registry from `FORGE_REGISTRY_CONTRACT_ID` if set, else the
    /// embedded deployment.
    pub fn for_network(network: Network) -> Result<Self> {
        let registry = match NetworkSettings::from_env().registry {
            Some(r) => Some(r),
            None => deployed_registry(&network)?,
        };
        Ok(Self { network, registry })
    }

    /// The registry, or the actionable "not deployed here" error.
    pub fn require_registry(&self) -> Result<&Registry> {
        self.registry.as_ref().ok_or_else(|| Error::NotDeployed {
            network: self.network.key(),
        })
    }

    /// The env vars that hand this exact target to a child process (`git` →
    /// git-remote-dash): [`Network::env_vars`] plus `FORGE_REGISTRY_CONTRACT_ID` when the
    /// registry is an override (blank otherwise, so an inherited value cannot leak in).
    pub fn env_vars(&self) -> Vec<(&'static str, String)> {
        let mut vars = self.network.env_vars();
        let registry = match &self.registry {
            Some(Registry {
                contract_id,
                source: ContractSource::Override(_),
            }) => contract_id.clone(),
            _ => String::new(),
        };
        vars.push((ENV_REGISTRY_CONTRACT_ID, registry));
        vars
    }
}

/// One layer of network settings from a single source (CLI flags, a config file, git
/// config, the environment). Unset fields fall through to the next layer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetworkSettings {
    /// Network kind (`testnet` / `mainnet` / `devnet`).
    pub network: Option<String>,
    /// Devnet name (only read when the resolved kind is `devnet`).
    pub devnet_name: Option<String>,
    /// Comma-separated DAPI addresses (devnet only).
    pub dapi_addresses: Option<String>,
    /// Quorum service base URL (devnet only).
    pub quorum_base_url: Option<String>,
    /// Registry contract id override.
    pub registry: Option<Registry>,
}

/// The env var names, in [`NetworkSettings::from_lookup`] order.
const ENV_KEYS: [&str; 5] = [
    ENV_NETWORK,
    ENV_DEVNET_NAME,
    ENV_DAPI_ADDRESSES,
    ENV_QUORUM_URL,
    ENV_REGISTRY_CONTRACT_ID,
];

/// The git config keys, in [`NetworkSettings::from_lookup`] order.
const GIT_CONFIG_KEYS: [&str; 5] = [
    "dash.network",
    "dash.devnetName",
    "dash.dapiAddresses",
    "dash.quorumUrl",
    "dash.registryContractId",
];

/// `Some(trimmed)` for a non-empty value; an empty setting counts as unset, so
/// `DASH_FORGE_DEVNET_NAME=` (as [`Network::env_vars`] exports for testnet) falls through.
fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

impl NetworkSettings {
    /// The layer from command-line flags (`--network`, `--devnet-name`, `--dapi-addresses`).
    /// `--devnet-name` without `--network` means devnet, so the flag is never silently
    /// dropped in favour of a lower layer's `network = "testnet"`.
    pub fn from_flags(
        network: Option<String>,
        devnet_name: Option<String>,
        dapi_addresses: Option<String>,
    ) -> Self {
        let devnet_name = non_empty(devnet_name);
        let network = non_empty(network).or_else(|| devnet_name.as_ref().map(|_| "devnet".into()));
        Self {
            network,
            devnet_name,
            dapi_addresses: non_empty(dapi_addresses),
            ..Self::default()
        }
    }

    /// The layer read from `DASH_FORGE_NETWORK`, `DASH_FORGE_DEVNET_NAME`,
    /// `DASH_FORGE_DAPI_ADDRESSES`, `DASH_FORGE_QUORUM_URL` and `FORGE_REGISTRY_CONTRACT_ID`.
    pub fn from_env() -> Self {
        Self::from_lookup(|k| std::env::var(k).ok(), ENV_KEYS, "env")
    }

    /// The layer from git config `dash.network`, `dash.devnetName`, `dash.dapiAddresses`,
    /// `dash.quorumUrl` and `dash.registryContractId`, read through `get` (which returns
    /// the value of a git config key, if set).
    pub fn from_git_config(get: impl Fn(&str) -> Option<String>) -> Self {
        Self::from_lookup(get, GIT_CONFIG_KEYS, "git config")
    }

    /// Build a layer from a key lookup. `keys` names network, devnet name, DAPI list,
    /// quorum URL and registry id in that order; `origin` labels a registry override.
    fn from_lookup(get: impl Fn(&str) -> Option<String>, keys: [&str; 5], origin: &str) -> Self {
        let [network, devnet_name, dapi_addresses, quorum_base_url, registry] = keys;
        Self {
            network: non_empty(get(network)),
            devnet_name: non_empty(get(devnet_name)),
            dapi_addresses: non_empty(get(dapi_addresses)),
            quorum_base_url: non_empty(get(quorum_base_url)),
            registry: non_empty(get(registry))
                .map(|id| Registry::override_from(id, format!("{origin} {registry}"))),
        }
    }

    /// Field-wise: keep each field of `self`, filling unset ones from `lower`.
    ///
    /// A lower layer that names a *different* network (kind or devnet name) contributes
    /// nothing network-specific: a config file's testnet registry override must not follow
    /// `--network mainnet`, and a `moutai` DAPI list must not follow `--devnet-name paloma`.
    #[must_use]
    pub fn overlay(self, lower: Self) -> Self {
        let differs = |a: &Option<String>, b: &Option<String>, fold: bool| match (a, b) {
            (Some(a), Some(b)) if fold => !a.eq_ignore_ascii_case(b),
            (Some(a), Some(b)) => a != b,
            _ => false,
        };
        let lower = if differs(&self.network, &lower.network, true)
            || differs(&self.devnet_name, &lower.devnet_name, false)
        {
            Self {
                network: lower.network,
                ..Self::default()
            }
        } else {
            lower
        };
        Self {
            network: self.network.or(lower.network),
            devnet_name: self.devnet_name.or(lower.devnet_name),
            dapi_addresses: self.dapi_addresses.or(lower.dapi_addresses),
            quorum_base_url: self.quorum_base_url.or(lower.quorum_base_url),
            registry: self.registry.or(lower.registry),
        }
    }

    /// Resolve to a [`NetworkTarget`]. The kind defaults to testnet, or to devnet when only
    /// a devnet name was given. A devnet needs a name; its DAPI addresses and quorum URL
    /// fall back to `deployments/devnet-<name>.json`. The registry is the override if any
    /// layer set one, else the embedded deployment.
    pub fn resolve(self) -> Result<NetworkTarget> {
        let kind = match (&self.network, &self.devnet_name) {
            (Some(kind), _) => kind.as_str(),
            (None, Some(_)) => "devnet",
            (None, None) => "testnet",
        };
        let (network, recorded) = match kind.to_ascii_lowercase().as_str() {
            "testnet" => (Network::Testnet, deployment("testnet")?),
            "mainnet" => (Network::Mainnet, deployment("mainnet")?),
            "devnet" => {
                let name = self.devnet_name.ok_or_else(|| {
                    Error::Config(
                        "network `devnet` needs a devnet name: pass --devnet-name <name> \
                         (or set dash.devnetName / DASH_FORGE_DEVNET_NAME)"
                            .into(),
                    )
                })?;
                validate_devnet_name(&name)?;
                let recorded = deployment(&format!("devnet-{name}"))?;
                let dapi_addresses = match &self.dapi_addresses {
                    Some(list) => parse_dapi_addresses(list)?,
                    None => recorded
                        .as_ref()
                        .map(|d| d.dapi_addresses.clone())
                        .unwrap_or_default(),
                };
                let quorum_base_url = self
                    .quorum_base_url
                    .or_else(|| recorded.as_ref().and_then(|d| d.quorum_base_url.clone()));
                let network = Network::Devnet {
                    name,
                    dapi_addresses,
                    quorum_base_url,
                };
                (network, recorded)
            }
            other => {
                return Err(Error::Config(format!(
                    "unknown network {other:?}: expected testnet, mainnet or devnet"
                )))
            }
        };
        let registry = self
            .registry
            .or_else(|| recorded.as_ref().and_then(Deployment::registry));
        Ok(NetworkTarget { network, registry })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The testnet registry id as read straight from the file on disk — proves the embedded
    /// copy is the committed file, without restating the id here.
    fn testnet_registry_on_disk() -> String {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../forge-contracts/deployments/testnet.json"
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        v["registry"]["contractId"].as_str().unwrap().to_string()
    }

    fn layer(network: &str) -> NetworkSettings {
        NetworkSettings {
            network: Some(network.into()),
            ..Default::default()
        }
    }

    #[test]
    fn every_embedded_deployment_parses() {
        let keys: Vec<_> = deployment_keys().collect();
        assert!(keys.contains(&"testnet"), "{keys:?}");
        assert!(keys.contains(&"devnet-moutai"), "{keys:?}");
        for key in keys {
            deployment(key).unwrap().expect("listed key has a file");
        }
    }

    #[test]
    fn testnet_registry_comes_from_the_deployment_file() {
        let t = NetworkSettings::default().resolve().unwrap();
        assert_eq!(t.network, Network::Testnet);
        let r = t.require_registry().unwrap();
        assert_eq!(r.contract_id, testnet_registry_on_disk());
        assert_eq!(
            r.source,
            ContractSource::Deployment("forge-contracts/deployments/testnet.json".into())
        );
    }

    #[test]
    fn mainnet_without_a_deployment_is_not_deployed_not_testnet() {
        // Becomes vacuous (and should be deleted) once deployments/mainnet.json lands.
        if deployment("mainnet").unwrap().is_some() {
            return;
        }
        let t = layer("mainnet").resolve().unwrap();
        assert_eq!(t.network, Network::Mainnet);
        assert!(t.registry.is_none());
        let err = t.require_registry().unwrap_err().to_string();
        assert!(
            err.contains("no Dash Forge registry is deployed on mainnet yet"),
            "{err}"
        );
        assert!(err.contains("docs/mainnet-runbook.md"), "{err}");
    }

    #[test]
    fn moutai_resolves_addresses_from_its_skeleton_and_has_no_registry() {
        let t = NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("moutai".into()),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        let Network::Devnet {
            name,
            dapi_addresses,
            ..
        } = &t.network
        else {
            panic!("expected devnet, got {:?}", t.network);
        };
        assert_eq!(name, "moutai");
        assert_eq!(dapi_addresses.len(), 10);
        assert!(dapi_addresses.contains(&"https://68.67.122.84:1443".to_string()));
        assert_eq!(t.network.key(), "devnet-moutai");
        assert_eq!(
            t.network.quorum_base_url(),
            "https://quorums.moutai.networks.dash.org"
        );
        let err = t.require_registry().unwrap_err().to_string();
        assert!(err.contains("devnet-moutai"), "{err}");
    }

    #[test]
    fn explicit_dapi_addresses_beat_the_deployment_file() {
        let t = NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("moutai".into()),
            dapi_addresses: Some("10.0.0.1, 10.0.0.2:2443,https://node.example:443/".into()),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        let Network::Devnet { dapi_addresses, .. } = t.network else {
            panic!("expected devnet");
        };
        assert_eq!(
            dapi_addresses,
            vec![
                "https://10.0.0.1:1443",
                "https://10.0.0.2:2443",
                "https://node.example:443"
            ]
        );
    }

    #[test]
    fn unknown_devnet_resolves_with_no_addresses_and_no_registry() {
        let t = NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("paloma".into()),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        assert!(
            matches!(&t.network, Network::Devnet { dapi_addresses, .. } if dapi_addresses.is_empty())
        );
        assert!(t.registry.is_none());
    }

    #[test]
    fn a_devnet_name_alone_implies_devnet() {
        let t = NetworkSettings {
            devnet_name: Some("moutai".into()),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        assert_eq!(t.network.key(), "devnet-moutai");
    }

    #[test]
    fn devnet_without_a_name_is_an_actionable_error() {
        let err = layer("devnet").resolve().unwrap_err().to_string();
        assert!(err.contains("--devnet-name"), "{err}");
    }

    #[test]
    fn bad_devnet_names_and_networks_are_rejected() {
        for bad in ["", "-x", "x-", "a.b", "mainnet", "Testnet"] {
            let res = NetworkSettings {
                network: Some("devnet".into()),
                devnet_name: Some(bad.into()),
                ..Default::default()
            }
            .resolve();
            // An empty name is "unset" only when it came through `non_empty`; set directly
            // it must still fail validation.
            assert!(res.is_err(), "devnet name {bad:?} should be rejected");
        }
        assert!(layer("moonnet").resolve().is_err());
    }

    #[test]
    fn devnet_fields_are_ignored_for_testnet() {
        let t = NetworkSettings {
            network: Some("testnet".into()),
            devnet_name: Some("moutai".into()),
            dapi_addresses: Some("10.0.0.1".into()),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        assert_eq!(t.network, Network::Testnet);
    }

    #[test]
    fn overlay_is_field_wise_with_the_upper_layer_winning() {
        let flags = NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("moutai".into()),
            ..Default::default()
        };
        let config = NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("moutai".into()),
            dapi_addresses: Some("10.1.1.1".into()),
            registry: Some(Registry::override_from("CFG", "config")),
            ..Default::default()
        };
        let env = NetworkSettings {
            dapi_addresses: Some("10.9.9.9".into()),
            quorum_base_url: Some("https://q.example".into()),
            registry: Some(Registry::override_from("ENV", "env")),
            ..Default::default()
        };
        let merged = flags.overlay(config).overlay(env);
        assert_eq!(merged.network.as_deref(), Some("devnet"));
        assert_eq!(merged.devnet_name.as_deref(), Some("moutai"));
        assert_eq!(merged.dapi_addresses.as_deref(), Some("10.1.1.1"));
        assert_eq!(merged.quorum_base_url.as_deref(), Some("https://q.example"));
        assert_eq!(merged.registry.as_ref().unwrap().contract_id, "CFG");
    }

    #[test]
    fn a_layer_for_another_network_contributes_nothing_network_specific() {
        // `--network mainnet` must not pick up the config file's testnet registry override.
        let flags = layer("mainnet");
        let config = NetworkSettings {
            network: Some("testnet".into()),
            registry: Some(Registry::override_from("TESTREG", "config")),
            ..Default::default()
        };
        let merged = flags.overlay(config);
        assert_eq!(merged.registry, None);
        assert!(merged.resolve().unwrap().registry.is_none());

        // `--devnet-name paloma` must not pick up moutai's configured DAPI list.
        let flags = NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("paloma".into()),
            ..Default::default()
        };
        let config = NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("moutai".into()),
            dapi_addresses: Some("10.1.1.1".into()),
            ..Default::default()
        };
        let merged = flags.overlay(config);
        assert_eq!(merged.devnet_name.as_deref(), Some("paloma"));
        assert_eq!(merged.dapi_addresses, None);

        // A layer that names no network is not "another network": it applies.
        let merged = layer("mainnet").overlay(NetworkSettings {
            registry: Some(Registry::override_from("ANY", "env")),
            ..Default::default()
        });
        assert_eq!(merged.registry.unwrap().contract_id, "ANY");
    }

    #[test]
    fn a_registry_override_beats_the_deployment_file() {
        let t = NetworkSettings {
            registry: Some(Registry::override_from(
                "OVERRIDE",
                "env FORGE_REGISTRY_CONTRACT_ID",
            )),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        let r = t.require_registry().unwrap();
        assert_eq!(r.contract_id, "OVERRIDE");
        assert_eq!(
            r.source.to_string(),
            "override (env FORGE_REGISTRY_CONTRACT_ID)"
        );
    }

    #[test]
    fn a_registry_override_makes_mainnet_usable() {
        let t = NetworkSettings {
            network: Some("mainnet".into()),
            registry: Some(Registry::override_from("MAIN", "config")),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        assert_eq!(t.require_registry().unwrap().contract_id, "MAIN");
    }

    #[test]
    fn lookup_layers_treat_empty_values_as_unset() {
        let vars = [
            (ENV_NETWORK, "devnet"),
            (ENV_DEVNET_NAME, ""),
            (ENV_DAPI_ADDRESSES, "  "),
            (ENV_REGISTRY_CONTRACT_ID, "REG"),
        ];
        let env = NetworkSettings::from_lookup(
            |k| {
                vars.iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| (*v).to_string())
            },
            ENV_KEYS,
            "env",
        );
        assert_eq!(env.network.as_deref(), Some("devnet"));
        assert_eq!(env.devnet_name, None);
        assert_eq!(env.dapi_addresses, None);
        assert_eq!(
            env.registry,
            Some(Registry::override_from(
                "REG",
                "env FORGE_REGISTRY_CONTRACT_ID"
            ))
        );
    }

    #[test]
    fn git_config_layer_reads_the_dash_keys() {
        let git = NetworkSettings::from_git_config(|k| match k {
            "dash.network" => Some("devnet".into()),
            "dash.devnetName" => Some("moutai".into()),
            "dash.dapiAddresses" => Some("10.1.1.1".into()),
            "dash.registryContractId" => Some("GITREG".into()),
            _ => None,
        });
        let t = git.resolve().unwrap();
        assert_eq!(t.network.key(), "devnet-moutai");
        assert!(
            matches!(&t.network, Network::Devnet { dapi_addresses, .. } if dapi_addresses == &["https://10.1.1.1:1443"])
        );
        assert_eq!(
            t.require_registry().unwrap().source.to_string(),
            "override (git config dash.registryContractId)"
        );
    }

    #[test]
    fn env_vars_round_trip_a_devnet_through_a_child_process() {
        let net = Network::Devnet {
            name: "moutai".into(),
            dapi_addresses: vec![
                "https://10.0.0.1:1443".into(),
                "https://10.0.0.2:1443".into(),
            ],
            quorum_base_url: None,
        };
        let vars = net.env_vars();
        let child = NetworkSettings::from_lookup(
            |k| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()),
            ENV_KEYS,
            "env",
        )
        .resolve()
        .unwrap();
        assert_eq!(child.network, net);

        // Testnet exports blanks for the devnet vars, so a stale inherited devnet name is
        // overwritten rather than picked up.
        let vars = Network::Testnet.env_vars();
        assert!(vars
            .iter()
            .any(|(k, v)| *k == ENV_DEVNET_NAME && v.is_empty()));
    }

    #[test]
    fn network_round_trips_through_json() {
        let devnet = Network::Devnet {
            name: "moutai".into(),
            dapi_addresses: vec!["https://10.0.0.1:1443".into()],
            quorum_base_url: None,
        };
        for n in [Network::Testnet, Network::Mainnet, devnet] {
            let s = serde_json::to_string(&n).unwrap();
            let back: Network = serde_json::from_str(&s).unwrap();
            assert_eq!(n, back);
        }
        assert_eq!(
            serde_json::to_string(&Network::Testnet).unwrap(),
            "\"testnet\""
        );
    }

    #[test]
    fn dapi_address_normalization() {
        assert_eq!(
            parse_dapi_addresses("1.2.3.4").unwrap(),
            vec!["https://1.2.3.4:1443"]
        );
        assert_eq!(
            parse_dapi_addresses("http://1.2.3.4:3000").unwrap(),
            vec!["http://1.2.3.4:3000"]
        );
        assert!(parse_dapi_addresses(",, ,").unwrap().is_empty());
        assert!(parse_dapi_addresses("https://host/path").is_err());
    }
}
