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
//! - A network with no forge-v2 deployment resolves with `v2: None`; the first operation
//!   that needs the contracts fails with [`Error::V2NotDeployed`] rather than silently talking
//!   to another network's contracts.
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
    /// Absent (not merely empty) falls back to `v2.devnet.addresses`.
    #[serde(default)]
    dapi_addresses: Option<Vec<String>>,
    #[serde(default)]
    quorum_base_url: Option<String>,
    /// The forge-v2 record `deploy-v2.mjs` read-modify-writes (`forge-contracts/scripts`).
    #[serde(default)]
    v2: Option<V2Record>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContractRecord {
    #[serde(default)]
    contract_id: Option<String>,
    #[serde(default)]
    owner_id: Option<String>,
    /// `registered` once confirmed; `broadcasting` while a deploy is in flight.
    #[serde(default)]
    status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2Record {
    #[serde(default)]
    forge_core: Option<ContractRecord>,
    #[serde(default)]
    forge_collab: Option<ContractRecord>,
    #[serde(default)]
    contract_group_id: Option<String>,
    #[serde(default)]
    forge_core_superseded: Vec<SupersededRecord>,
    #[serde(default)]
    forge_collab_superseded: Vec<SupersededRecord>,
    /// The group `deploy-v2.mjs` verified on chain: its id and owner (the deployer).
    #[serde(default)]
    contract_group: Option<GroupRecord>,
    /// The devnet `deploy-v2.mjs` registered on, with the DAPI addresses it used.
    #[serde(default)]
    devnet: Option<V2Devnet>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupersededRecord {
    #[serde(default)]
    contract_id: Option<String>,
    #[serde(default)]
    contract_group_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupRecord {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    owner: Option<String>,
}

#[derive(Deserialize)]
struct V2Devnet {
    #[serde(default)]
    addresses: Option<Vec<String>>,
}

impl DeploymentFile {
    /// Top-level `dapiAddresses`, else `v2.devnet.addresses` (parity with forge-web
    /// `recordedDapiAddresses`).
    fn recorded_dapi_addresses(&self) -> &[String] {
        self.dapi_addresses
            .as_deref()
            .or_else(|| {
                self.v2
                    .as_ref()
                    .and_then(|v2| v2.devnet.as_ref())
                    .and_then(|d| d.addresses.as_deref())
            })
            .unwrap_or_default()
    }
}

impl ContractRecord {
    /// The id of a confirmed registration; `None` for a missing or in-flight one.
    fn registered_id(&self) -> Option<String> {
        if self.status.as_deref() != Some("registered") {
            return None;
        }
        self.contract_id.clone().filter(|s| !s.is_empty())
    }
}

impl V2Record {
    /// Every forge-v2 id, or `None` unless both contracts are registered and the group is
    /// recorded — a half-finished deploy is not a usable deployment.
    fn ids(&self) -> Option<ForgeIds> {
        let group = self.contract_group_id.clone().filter(|s| !s.is_empty())?;
        let superseded_in_group = self
            .forge_core_superseded
            .iter()
            .chain(&self.forge_collab_superseded)
            .filter(|r| r.contract_group_id.as_deref() == Some(group.as_str()))
            .filter_map(|r| r.contract_id.clone())
            .collect();
        // The group's owner: the verified `contractGroup` record for this group, else the
        // owner of forge-core, whose create transition registered the group.
        let recorded = self
            .contract_group
            .as_ref()
            .filter(|g| g.id.as_deref() == Some(group.as_str()));
        let group_owner = recorded
            .and_then(|g| g.owner.clone())
            .or_else(|| self.forge_core.as_ref().and_then(|c| c.owner_id.clone()))
            .filter(|s| !s.is_empty());
        Some(ForgeIds {
            core: self.forge_core.as_ref()?.registered_id()?,
            collab: self.forge_collab.as_ref()?.registered_id()?,
            group,
            superseded_in_group,
            group_owner,
        })
    }
}

/// The forge-v2 contracts registered on a network (base58 ids), from the deployment file's
/// `v2` record. See `docs/contracts/forge-v2.md`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeIds {
    /// The forge-core contract (repos, refs, packs).
    pub core: String,
    /// The forge-collab contract (issues, PRs, reviews, social graph).
    pub collab: String,
    /// The contract group both contracts belong to.
    pub group: String,
    /// Earlier forge-core / forge-collab contracts `deploy-v2.mjs` superseded but left in the
    /// same group (a group cannot drop a member). A group-bound key can sign for them too;
    /// they are Forge's own, so the group check accepts them.
    pub superseded_in_group: Vec<String>,
    /// The identity that owns the group: the Forge deployer. The trust root a group-bound key
    /// depends on (`docs/contracts/forge-v2.md` §group trust). `None` when the file records
    /// neither the group's owner nor forge-core's.
    /// The group must also have no admins (`deploy-v2.mjs` registers none).
    pub group_owner: Option<String>,
}

/// What an embedded deployment file records for one network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deployment {
    /// The deployment key (`devnet-moutai`, `mainnet`).
    pub key: String,
    /// DAPI addresses recorded for a devnet (normalized); empty for testnet/mainnet.
    pub dapi_addresses: Vec<String>,
    /// A quorum service URL recorded for a devnet.
    pub quorum_base_url: Option<String>,
    /// The forge-v2 contracts, or `None` when none are fully registered here.
    pub v2: Option<ForgeIds>,
}

impl Deployment {
    /// The repo-relative path of the file this came from.
    pub fn path(&self) -> String {
        format!("forge-contracts/deployments/{}.json", self.key)
    }
}

/// The keys of every embedded deployment file, sorted.
pub fn deployment_keys() -> impl Iterator<Item = &'static str> {
    EMBEDDED_DEPLOYMENTS.iter().map(|(key, _)| *key)
}

/// The network a "not deployed here" message points to: the first embedded deployment with
/// forge-v2 contracts, mainnet first, then testnet, then the devnets by name. Only its kind
/// and name matter (addresses come from the deployment when it is selected). `None` when
/// no network has a deployment.
pub fn suggested_v2_network() -> Option<Network> {
    let rank = |k: &str| match k {
        "mainnet" => 0,
        "testnet" => 1,
        _ => 2,
    };
    let key = deployment_keys()
        .filter(|k| deployment(k).ok().flatten().is_some_and(|d| d.v2.is_some()))
        .min_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)))?;
    Some(match key {
        "mainnet" => Network::Mainnet,
        "testnet" => Network::Testnet,
        key => Network::Devnet {
            name: key.strip_prefix("devnet-").unwrap_or(key).to_string(),
            dapi_addresses: Vec::new(),
            quorum_base_url: None,
        },
    })
}

impl Network {
    /// The `dg` flags that select this network: `--network devnet --devnet-name moutai`.
    pub fn dg_flags(&self) -> String {
        match self.devnet_name() {
            Some(name) => format!("--network devnet --devnet-name {name}"),
            None => format!("--network {}", self.kind()),
        }
    }

    /// The git config that selects this network for `git` (the remote helper), in `scope`
    /// (`""` for this repository, `"--global "` for every one): `git config dash.network
    /// devnet && git config dash.devnetName moutai`.
    pub fn git_config_command(&self, scope: &str) -> String {
        let git = format!("git config {scope}");
        match self.devnet_name() {
            Some(name) => format!("{git}dash.network devnet && {git}dash.devnetName {name}"),
            None => format!("{git}dash.network {}", self.kind()),
        }
    }

    /// The environment that selects this network for one command:
    /// `DASH_FORGE_NETWORK=devnet DASH_FORGE_DEVNET_NAME=moutai`.
    pub fn env_assignments(&self) -> String {
        match self.devnet_name() {
            Some(name) => format!("{ENV_NETWORK}=devnet {ENV_DEVNET_NAME}={name}"),
            None => format!("{ENV_NETWORK}={}", self.kind()),
        }
    }
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
    let dapi_addresses = file
        .recorded_dapi_addresses()
        .iter()
        .map(|a| normalize_dapi_address(a))
        .collect::<Result<_>>()?;
    Ok(Some(Deployment {
        key: key.to_string(),
        dapi_addresses,
        quorum_base_url: file.quorum_base_url.filter(|s| !s.is_empty()),
        v2: file.v2.as_ref().and_then(V2Record::ids),
    }))
}

/// A network plus the forge-v2 contracts deployed on it — what
/// [`crate::platform::PlatformClient`] connects to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkTarget {
    /// The network.
    pub network: Network,
    /// The forge-v2 contracts the embedded deployment records for `network`, or `None` when
    /// none are registered there (repository operations then fail with
    /// [`Error::V2NotDeployed`]).
    pub v2: Option<ForgeIds>,
}

impl NetworkTarget {
    /// `network` with the contracts its embedded deployment records.
    pub fn for_network(network: Network) -> Result<Self> {
        let v2 = deployment(&network.key())?.and_then(|d| d.v2);
        Ok(Self { network, v2 })
    }

    /// The forge-v2 contracts, or the actionable "not deployed here" error.
    pub fn require_v2(&self) -> Result<&ForgeIds> {
        self.v2.as_ref().ok_or_else(|| Error::V2NotDeployed {
            network: self.network.key(),
        })
    }

    /// The env vars that hand this exact target to a child process (`git` →
    /// git-remote-dash): [`Network::env_vars`].
    pub fn env_vars(&self) -> Vec<(&'static str, String)> {
        self.network.env_vars()
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
}

/// The env var names, in [`NetworkSettings::from_lookup`] order.
const ENV_KEYS: [&str; 4] = [
    ENV_NETWORK,
    ENV_DEVNET_NAME,
    ENV_DAPI_ADDRESSES,
    ENV_QUORUM_URL,
];

/// The git config keys, in [`NetworkSettings::from_lookup`] order.
const GIT_CONFIG_KEYS: [&str; 4] = [
    "dash.network",
    "dash.devnetName",
    "dash.dapiAddresses",
    "dash.quorumUrl",
];

/// `dg`'s `config.toml` keys. It records no quorum URL, so that slot names no key.
const DG_CONFIG_KEYS: [&str; 4] = ["network", "devnet_name", "dapi_addresses", ""];

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
    /// `DASH_FORGE_DAPI_ADDRESSES` and `DASH_FORGE_QUORUM_URL`.
    pub fn from_env() -> Self {
        Self::from_lookup(|k| std::env::var(k).ok(), ENV_KEYS)
    }

    /// The layer from git config `dash.network`, `dash.devnetName`, `dash.dapiAddresses`
    /// and `dash.quorumUrl`, read through `get` (which returns the value of a git config
    /// key, if set).
    pub fn from_git_config(get: impl Fn(&str) -> Option<String>) -> Self {
        Self::from_lookup(get, GIT_CONFIG_KEYS)
    }

    /// The layer `dg` saved as the default (`network`, `devnet_name`, `dapi_addresses` in
    /// `config.toml`, written by `dg auth new` / `dg auth login`), for tools that take no
    /// network flag of their own (the remote helper). Empty when there is no config file; a
    /// file that cannot be read or does not parse is E204, as it is in `dg`.
    pub fn from_dg_config() -> Result<Self> {
        match crate::keystore::forge_config_dir() {
            Some(dir) => Self::from_dg_config_file(&dir.join("config.toml")),
            None => Ok(Self::default()),
        }
    }

    /// [`Self::from_dg_config`] for the `config.toml` at `path`.
    pub fn from_dg_config_file(path: &std::path::Path) -> Result<Self> {
        let Some(v) = crate::config_file::read_config_toml(path)? else {
            return Ok(Self::default());
        };
        let key = |k: &str| v.get(k).and_then(toml::Value::as_str).map(str::to_string);
        Ok(Self::from_lookup(key, DG_CONFIG_KEYS))
    }

    /// What `git push` / `git clone` of a `dash://` URL resolve: the environment (what `dg`
    /// and forge-import pass the helper) > git config `dash.*` (read through `git_get`) >
    /// the network `dg` recorded in `config.toml` > (in [`Self::resolve`]) testnet. Without
    /// the `config.toml` layer, `dg auth new --devnet-name moutai` followed by a plain
    /// `git push` went to testnet (L-03). See [`Self::git_helper_layers`].
    pub fn for_git_helper(git_get: impl Fn(&str) -> Option<String>) -> Result<Self> {
        Self::git_helper_layers(
            Self::from_env(),
            Self::from_git_config(git_get),
            Self::from_dg_config,
        )
    }

    /// Stack the remote helper's layers: `env` over `git`, then `dg` (the saved default) only
    /// when those two leave the network open. `dg` is read lazily, so a `config.toml` that
    /// does not parse (E204) fails only the invocations that would have used it.
    pub fn git_helper_layers(
        env: Self,
        git: Self,
        dg: impl FnOnce() -> Result<Self>,
    ) -> Result<Self> {
        let upper = env.overlay(git);
        if upper.names_a_network() {
            return Ok(upper);
        }
        Ok(upper.overlay(dg()?))
    }

    /// Whether this layer picks one network by itself: a devnet name, or `testnet` /
    /// `mainnet`. A bare `devnet` still needs a name from a lower layer.
    pub fn names_a_network(&self) -> bool {
        self.devnet_name.is_some()
            || self
                .network
                .as_deref()
                .is_some_and(|n| !n.eq_ignore_ascii_case("devnet"))
    }

    /// Build a layer from a key lookup. `keys` names network, devnet name, DAPI list and
    /// quorum URL in that order.
    fn from_lookup(get: impl Fn(&str) -> Option<String>, keys: [&str; 4]) -> Self {
        let [network, devnet_name, dapi_addresses, quorum_base_url] = keys;
        Self {
            network: non_empty(get(network)),
            devnet_name: non_empty(get(devnet_name)),
            dapi_addresses: non_empty(get(dapi_addresses)),
            quorum_base_url: non_empty(get(quorum_base_url)),
        }
    }

    /// Field-wise: keep each field of `self`, filling unset ones from `lower`.
    ///
    /// A lower layer that names a *different* network (kind or devnet name) contributes
    /// nothing network-specific: a `moutai` DAPI list must not follow `--devnet-name paloma`.
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
        }
    }

    /// Resolve to a [`NetworkTarget`]. The kind defaults to testnet, or to devnet when only
    /// a devnet name was given. A devnet needs a name; its DAPI addresses and quorum URL
    /// fall back to `deployments/devnet-<name>.json`, as do the forge-v2 contract ids.
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
        let v2 = recorded.and_then(|d| d.v2);
        Ok(NetworkTarget { network, v2 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// moutai's forge-v2 ids as read straight from the file on disk: proves the embedded copy
    /// is the committed file, without restating the ids here.
    fn expected_ids() -> ForgeIds {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../forge-contracts/deployments/devnet-moutai.json"
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let on_disk = |p: &str| v.pointer(p).unwrap().as_str().unwrap().to_string();
        ForgeIds {
            core: on_disk("/v2/forgeCore/contractId"),
            collab: on_disk("/v2/forgeCollab/contractId"),
            group: on_disk("/v2/contractGroupId"),
            superseded_in_group: v["v2"]["forgeCoreSuperseded"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(
                    v["v2"]["forgeCollabSuperseded"]
                        .as_array()
                        .into_iter()
                        .flatten(),
                )
                .filter(|r| r["contractGroupId"] == v["v2"]["contractGroupId"])
                .filter_map(|r| r["contractId"].as_str().map(str::to_string))
                .collect(),
            group_owner: Some(on_disk("/v2/contractGroup/owner")),
        }
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
        assert!(keys.contains(&"devnet-moutai"), "{keys:?}");
        for key in keys {
            deployment(key).unwrap().expect("listed key has a file");
        }
    }

    #[test]
    fn a_network_without_a_deployment_is_not_deployed_not_another_networks() {
        for net in ["testnet", "mainnet"] {
            // Vacuous for a network once its deployment file lands.
            if deployment(net).unwrap().is_some() {
                continue;
            }
            let t = layer(net).resolve().unwrap();
            assert_eq!(t.network.key(), net);
            assert!(t.v2.is_none());
            let err = t.require_v2().unwrap_err().to_string();
            assert!(
                err.contains(&format!("forge-v2 isn't deployed on {net} yet")),
                "{err}"
            );
        }
    }

    #[test]
    fn moutai_exposes_its_forge_v2_ids_from_the_deployment_file() {
        let expected = expected_ids();

        let d = deployment("devnet-moutai").unwrap().unwrap();
        assert_eq!(d.v2.as_ref(), Some(&expected));
        let t = NetworkSettings {
            devnet_name: Some("moutai".into()),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        assert_eq!(t.v2, Some(expected.clone()));
        assert_eq!(
            NetworkTarget::for_network(t.network.clone()).unwrap().v2,
            Some(expected)
        );
        assert_eq!(t.require_v2().unwrap(), &expected_ids());
    }

    #[test]
    fn dapi_addresses_fall_back_to_the_v2_devnet_record() {
        let addrs = |json: &str| {
            serde_json::from_str::<DeploymentFile>(json)
                .unwrap()
                .recorded_dapi_addresses()
                .to_vec()
        };
        let v2 = r#""v2":{"devnet":{"name":"x","addresses":["https://10.0.0.9:1443"]}}"#;
        assert_eq!(
            addrs(&format!("{{{v2}}}")),
            vec!["https://10.0.0.9:1443".to_string()]
        );
        // A top-level list, even an empty one, is authoritative.
        assert_eq!(
            addrs(&format!(
                r#"{{"dapiAddresses":["https://10.0.0.1:1443"],{v2}}}"#
            )),
            vec!["https://10.0.0.1:1443".to_string()]
        );
        assert!(addrs(&format!(r#"{{"dapiAddresses":[],{v2}}}"#)).is_empty());
        assert!(addrs("{}").is_empty());
    }

    #[test]
    fn a_partial_v2_record_is_not_a_deployment() {
        let parse = |json: &str| {
            serde_json::from_str::<DeploymentFile>(json)
                .unwrap()
                .v2
                .and_then(|r| r.ids())
        };
        let full = r#"{"v2":{"forgeCore":{"contractId":"C","status":"registered"},
            "forgeCollab":{"contractId":"L","status":"registered"},"contractGroupId":"G"}}"#;
        assert_eq!(
            parse(full),
            Some(ForgeIds {
                core: "C".into(),
                collab: "L".into(),
                group: "G".into(),
                superseded_in_group: vec![],
                group_owner: None,
            })
        );
        // In flight, missing a contract, or missing the group: no ids.
        assert_eq!(parse(&full.replacen("registered", "broadcasting", 1)), None);
        assert_eq!(
            parse(
                r#"{"v2":{"forgeCore":{"contractId":"C","status":"registered"},"contractGroupId":"G"}}"#
            ),
            None
        );
        assert_eq!(parse(&full.replace(r#","contractGroupId":"G""#, "")), None);
        assert_eq!(parse("{}"), None);
    }

    #[test]
    fn the_group_owner_is_the_verified_record_for_this_group_else_forge_cores_owner() {
        let owner = |json: &str| {
            serde_json::from_str::<DeploymentFile>(json)
                .unwrap()
                .v2
                .and_then(|r| r.ids())
                .unwrap()
                .group_owner
        };
        let base = r#"{"v2":{"forgeCore":{"contractId":"C","ownerId":"CORE_OWNER","status":"registered"},
            "forgeCollab":{"contractId":"L","status":"registered"},"contractGroupId":"G"GROUP}}"#;
        // The verified record for this group wins.
        assert_eq!(
            owner(&base.replace("GROUP", r#","contractGroup":{"id":"G","owner":"REC"}"#)),
            Some("REC".into())
        );
        // A record for another (superseded) group is ignored: forge-core's owner registered G.
        assert_eq!(
            owner(&base.replace("GROUP", r#","contractGroup":{"id":"OLD","owner":"REC"}"#)),
            Some("CORE_OWNER".into())
        );
        // No record: forge-core's owner. Neither: none, and the group check refuses.
        assert_eq!(owner(&base.replace("GROUP", "")), Some("CORE_OWNER".into()));
        assert_eq!(
            owner(
                &base
                    .replace("GROUP", "")
                    .replace(r#""ownerId":"CORE_OWNER","#, "")
            ),
            None
        );
    }

    #[test]
    fn moutai_resolves_addresses_from_its_deployment() {
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
    fn unknown_devnet_resolves_with_no_addresses_and_no_contracts() {
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
        assert!(t.v2.is_none());
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
            ..Default::default()
        };
        let env = NetworkSettings {
            dapi_addresses: Some("10.9.9.9".into()),
            quorum_base_url: Some("https://q.example".into()),
            ..Default::default()
        };
        let merged = flags.overlay(config).overlay(env);
        assert_eq!(merged.network.as_deref(), Some("devnet"));
        assert_eq!(merged.devnet_name.as_deref(), Some("moutai"));
        assert_eq!(merged.dapi_addresses.as_deref(), Some("10.1.1.1"));
        assert_eq!(merged.quorum_base_url.as_deref(), Some("https://q.example"));
    }

    #[test]
    fn a_layer_for_another_network_contributes_nothing_network_specific() {
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
        let merged = layer("devnet").overlay(NetworkSettings {
            devnet_name: Some("moutai".into()),
            ..Default::default()
        });
        assert_eq!(merged.devnet_name.as_deref(), Some("moutai"));
    }

    #[test]
    fn lookup_layers_treat_empty_values_as_unset() {
        let vars = [
            (ENV_NETWORK, "devnet"),
            (ENV_DEVNET_NAME, ""),
            (ENV_DAPI_ADDRESSES, "  "),
            (ENV_QUORUM_URL, "https://q.example"),
        ];
        let env = NetworkSettings::from_lookup(
            |k| {
                vars.iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| (*v).to_string())
            },
            ENV_KEYS,
        );
        assert_eq!(env.network.as_deref(), Some("devnet"));
        assert_eq!(env.devnet_name, None);
        assert_eq!(env.dapi_addresses, None);
        assert_eq!(env.quorum_base_url.as_deref(), Some("https://q.example"));
    }

    #[test]
    fn git_config_layer_reads_the_dash_keys() {
        let git = NetworkSettings::from_git_config(|k| match k {
            "dash.network" => Some("devnet".into()),
            "dash.devnetName" => Some("moutai".into()),
            "dash.dapiAddresses" => Some("10.1.1.1".into()),
            _ => None,
        });
        let t = git.resolve().unwrap();
        assert_eq!(t.network.key(), "devnet-moutai");
        assert!(
            matches!(&t.network, Network::Devnet { dapi_addresses, .. } if dapi_addresses == &["https://10.1.1.1:1443"])
        );
    }

    /// The remote helper's layers, resolved to a deployment key, with `dg`'s config.toml
    /// holding `dg_toml`.
    fn helper_key(env: NetworkSettings, git: NetworkSettings, dg_toml: &str) -> String {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, dg_toml).unwrap();
        NetworkSettings::git_helper_layers(env, git, || NetworkSettings::from_dg_config_file(&path))
            .unwrap()
            .resolve()
            .unwrap()
            .network
            .key()
    }

    const DG_MOUTAI: &str = "network = \"devnet\"\ndevnet_name = \"moutai\"\n\
                             default_identity = \"keychain:dash-forge/devnet-moutai/X\"\n";

    #[test]
    fn the_helper_falls_back_to_the_network_dg_saved() {
        // L-03: `dg auth new --devnet-name moutai`, then a plain `git push` went to testnet.
        let none = NetworkSettings::default;
        assert_eq!(helper_key(none(), none(), DG_MOUTAI), "devnet-moutai");
        // With no config.toml (or one that records no network) it is still testnet.
        assert_eq!(helper_key(none(), none(), ""), "testnet");
        let t = NetworkSettings::git_helper_layers(none(), none(), || {
            NetworkSettings::from_dg_config_file(std::path::Path::new("/nonexistent/c.toml"))
        })
        .unwrap();
        assert_eq!(t.resolve().unwrap().network, Network::Testnet);
    }

    #[test]
    fn env_beats_git_config_beats_dg_config() {
        let none = NetworkSettings::default;
        let git = |k: &str| (k == "dash.network").then(|| "mainnet".to_string());
        assert_eq!(
            helper_key(none(), NetworkSettings::from_git_config(git), DG_MOUTAI),
            "mainnet"
        );
        assert_eq!(
            helper_key(
                layer("testnet"),
                NetworkSettings::from_git_config(git),
                DG_MOUTAI
            ),
            "testnet"
        );
        // A git-config devnet with its own name ignores dg's saved devnet (and its addresses).
        let paloma = NetworkSettings::from_git_config(|k| match k {
            "dash.network" => Some("devnet".into()),
            "dash.devnetName" => Some("paloma".into()),
            _ => None,
        });
        let dg = format!("{DG_MOUTAI}dapi_addresses = \"10.9.9.9\"\n");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, dg).unwrap();
        let s = NetworkSettings::git_helper_layers(none(), paloma, || {
            NetworkSettings::from_dg_config_file(&path)
        })
        .unwrap();
        assert_eq!(s.devnet_name.as_deref(), Some("paloma"));
        assert_eq!(s.dapi_addresses, None);
    }

    #[test]
    fn a_bare_devnet_above_takes_the_name_dg_saved() {
        // `DASH_FORGE_NETWORK=devnet` alone needs a name; dg's config supplies it.
        assert_eq!(
            helper_key(layer("devnet"), NetworkSettings::default(), DG_MOUTAI),
            "devnet-moutai"
        );
    }

    #[test]
    fn a_broken_dg_config_is_read_only_when_it_is_needed() {
        let bad = |path: &std::path::Path| {
            std::fs::write(path, "network = \n").unwrap();
            NetworkSettings::from_dg_config_file(path)
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        // The environment chose: the broken file is never read.
        let s = NetworkSettings::git_helper_layers(
            layer("mainnet"),
            NetworkSettings::default(),
            || bad(&path),
        )
        .unwrap();
        assert_eq!(s.network.as_deref(), Some("mainnet"));
        // Nothing above chose: E204 naming the file, never a silent testnet.
        let err = NetworkSettings::git_helper_layers(
            NetworkSettings::default(),
            NetworkSettings::default(),
            || bad(&path),
        )
        .unwrap_err();
        let u = crate::user_error::classify(
            [&err as &(dyn std::error::Error + 'static)],
            &crate::user_error::ErrorContext::default(),
        );
        assert_eq!(u.code, "E204");
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
