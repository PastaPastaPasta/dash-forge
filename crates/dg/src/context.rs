//! Command execution context: global-flag + config resolution, connection helpers,
//! confirmation prompts and JSON/human output. Errors are rendered by [`crate::errors`].

use std::io::{IsTerminal, Write};
use std::path::PathBuf;

use anyhow::{Context as _, Result};
use serde_json::Value;

use forge_core::keystore::{BridgeIdentity, Secret};
use forge_core::network::{full_network_key, NetworkSettings, NetworkTarget};
use forge_core::platform::{LoadedIdentity, Network, PlatformClient};
use forge_core::user_error::{codes, UserError};

use crate::config::Config;
use crate::Cli;

/// The resolved runtime context for one `dg` invocation.
#[allow(clippy::struct_excessive_bools)] // independent CLI flags
pub struct Ctx {
    /// Emit machine-readable JSON instead of human output.
    pub json: bool,
    /// Skip confirmation prompts (automation / CI).
    pub yes: bool,
    /// The resolved network and the forge-v2 contracts deployed on it.
    pub target: NetworkTarget,
    /// Nothing chose the network (no flag, no `config.toml` network, no environment), so
    /// `target` is the built-in default.
    pub network_is_default: bool,
    /// Which layer chose the network (see [`stack`]).
    pub network_source: NetworkSource,
    /// The resolved identity file path (from `--identity` / `DASH_FORGE_KEY` / config), if any.
    pub identity_path: Option<PathBuf>,
    /// `--identity` as given on the command line (not the environment or the default).
    pub cli_identity: Option<PathBuf>,
    /// Whether stdin is a terminal (a prompt can be answered).
    pub stdin_tty: bool,
    /// `--allow-archived`: write to an archived repository anyway (E606 otherwise).
    pub allow_archived: bool,
    /// The identity source's contents, once unlocked (a sealed file's passphrase is asked
    /// once per run). Handed to `git-remote-dash` over a pipe ([`crate::git::DashEnv`]).
    unlocked: std::sync::OnceLock<Secret>,
    /// Whether this run's `git-remote-dash` takes the handed key (`git remote-dash
    /// --check-key`, run once, before the first handoff).
    helper_ok: std::sync::OnceLock<bool>,
    /// The identity id config.toml records next to `default_identity`, when that default is
    /// the key source in use: it names the identity without unsealing its key.
    pub config_identity_id: Option<String>,
    /// What the key source says about itself without being opened, read once.
    source_facts: SourceFacts,
}

/// Whether `cmd` takes its network from the repository in the current directory (see
/// [`stack`]). Sign-in commands record a network of their own, and a clone or a new repository
/// is not the one here, so they do not.
fn follows_repo_network(cmd: &crate::Command) -> bool {
    use crate::{Command, RepoCommand};
    !matches!(
        cmd,
        Command::Auth(_)
            | Command::Repo(RepoCommand::Clone { .. } | RepoCommand::Create(_))
            | Command::Completions { .. }
    )
}

/// Why a confirmation prompt cannot be asked, or `None` when it can (or `--yes` answers it).
fn prompt_blocker(yes: bool, json: bool, stdin_tty: bool) -> Option<&'static str> {
    if yes {
        None
    } else if json {
        Some("--json mode cannot prompt")
    } else if !stdin_tty {
        Some("stdin is not a terminal")
    } else {
        None
    }
}

/// The E802 for a prompt that cannot be asked, with `cause`; callers add the fixes.
fn confirmation_required(cause: String) -> UserError {
    UserError::new(codes::CONFIRMATION_REQUIRED, "confirmation required")
        .cause(cause)
        .note("nothing was written")
}

/// The fields a key source states about itself without being opened: its network key
/// (`testnet`, `devnet-bonsia`, …, or a bare `devnet`) and its identity id.
#[derive(Debug, Default, PartialEq, Eq)]
struct SourceFacts {
    network: Option<String>,
    identity_id: Option<String>,
}

/// What a key source says about itself without opening it: an inline `dfk1:` key and a
/// `keychain:` source name both in their text, a plaintext identity file in its JSON. A
/// sealed file says nothing without its passphrase.
fn source_facts(source: &std::path::Path) -> SourceFacts {
    use forge_core::keystore::{parse_keychain_source, DFK1_PREFIX};
    let own = |s: Option<&str>| s.filter(|v| !v.is_empty()).map(str::to_string);
    let Some(s) = source.to_str() else {
        return SourceFacts::default();
    };
    if let Some(rest) = s.strip_prefix(DFK1_PREFIX) {
        // dfk1:<network>:<identityId>:<keyId>:<wif>
        let mut parts = rest.split(':');
        return SourceFacts {
            network: own(parts.next()),
            identity_id: own(parts.next()),
        };
    }
    if let Some((_, account)) = parse_keychain_source(s) {
        // keychain:dash-forge/<network>/<identityId>
        return SourceFacts {
            network: account.rsplit_once('/').and_then(|(n, _)| own(Some(n))),
            identity_id: own(account.rsplit('/').next()),
        };
    }
    // Only a regular file: reading a pipe (`--identity <(pass show …)`, /dev/stdin) here would
    // leave nothing for the key load that may follow.
    if !std::fs::metadata(source).is_ok_and(|m| m.is_file()) {
        return SourceFacts::default();
    }
    let Ok(raw) = std::fs::read_to_string(source).map(zeroize::Zeroizing::new) else {
        return SourceFacts::default();
    };
    if forge_core::sealed::is_sealed(&raw) {
        return SourceFacts::default();
    }
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return SourceFacts::default();
    };
    SourceFacts {
        network: own(v.get("network").and_then(Value::as_str)),
        identity_id: own(v.get("identityId").and_then(Value::as_str)),
    }
}

/// Fetch the signing identity: E304 naming this network (and the key's own, when it records
/// another) when Platform has no such identity.
async fn fetch_signer(client: &PlatformClient, bridge: &BridgeIdentity) -> Result<LoadedIdentity> {
    client
        .fetch_signer(bridge)
        .await
        .context("fetching the signing identity")
}

/// Where `dg`'s network came from: the highest layer that set it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkSource {
    /// `--network` / `--devnet-name` / `--dapi-addresses`.
    Flags,
    /// This repository's own git config (`dash.network` & co., as `dg init` / `dg repo clone`
    /// write them).
    Repository,
    /// `config.toml` (`dg auth new` / `dg auth login` record it).
    Config,
    /// `DASH_FORGE_NETWORK` and friends.
    Environment,
    /// The network the key in use records (`dfk1:<network>:…`, an identity file's `network`).
    Key,
    /// Nothing chose one: the built-in default.
    Default,
}

impl std::fmt::Display for NetworkSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Flags => "from the command line",
            Self::Repository => "from this repository's git config",
            Self::Config => "from config.toml",
            Self::Environment => "from DASH_FORGE_NETWORK",
            Self::Key => "from the key in use",
            Self::Default => "the default",
        })
    }
}

/// The network layers, highest precedence first (see [`stack`]).
struct Layers {
    flags: NetworkSettings,
    repo: NetworkSettings,
    config: NetworkSettings,
    env: NetworkSettings,
    key: NetworkSettings,
}

/// Stack the network layers in `dg`'s precedence order, for [`NetworkSettings::resolve`], and
/// say which one chose the network.
///
/// Precedence, field by field: flags (`--network` / `--devnet-name` / `--dapi-addresses`) >
/// this repository's own git config (`local` / `worktree` `dash.network`, `dash.devnetName`,
/// `dash.dapiAddresses`, `dash.quorumUrl`: a `dash://` repository lives on one network, and
/// `git push` uses it too) > config file > environment (`DASH_FORGE_NETWORK`,
/// `DASH_FORGE_DEVNET_NAME`, `DASH_FORGE_DAPI_ADDRESSES`) > the network the key records (a CI
/// runner's `dfk1:` key) > the embedded `forge-contracts/deployments/<network>.json` > testnet.
/// A lower layer that names a different network contributes nothing network-specific (see
/// `NetworkSettings::overlay`).
fn stack(l: Layers) -> (NetworkSettings, NetworkSource) {
    let ordered = [
        (NetworkSource::Flags, l.flags),
        (NetworkSource::Repository, l.repo),
        (NetworkSource::Config, l.config),
        (NetworkSource::Environment, l.env),
        (NetworkSource::Key, l.key),
    ];
    let source = ordered
        .iter()
        .find(|(_, layer)| !layer.is_unset())
        .map_or(NetworkSource::Default, |(s, _)| *s);
    let stacked = ordered
        .into_iter()
        .map(|(_, layer)| layer)
        .reduce(NetworkSettings::overlay)
        .unwrap_or_default();
    (stacked, source)
}

/// The network the repository in the current directory pins in its own git config (`local`
/// or `worktree` scope; `dg init` and `dg repo clone` write it). Global and system values do
/// not count: they are not this repository's. Empty outside a repository, or with a git too
/// old for `--show-scope`.
fn repo_network() -> NetworkSettings {
    let out = std::process::Command::new("git")
        .args([
            "config",
            "--show-scope",
            "--get-regexp",
            r"^dash\.(network|devnetname|dapiaddresses|quorumurl)$",
        ])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    match out {
        Ok(o) if o.status.success() => parse_repo_network(&String::from_utf8_lossy(&o.stdout)),
        _ => NetworkSettings::default(),
    }
}

/// [`repo_network`] from `git config --show-scope --get-regexp` output (`<scope>\t<key>
/// <value>` lines, keys lowercased by git). A `worktree` value beats a `local` one; within a
/// scope the last one wins, as in git.
fn parse_repo_network(text: &str) -> NetworkSettings {
    let mut found: std::collections::HashMap<String, (u8, String)> =
        std::collections::HashMap::new();
    for line in text.lines() {
        let Some((scope, rest)) = line.split_once('\t') else {
            continue;
        };
        let rank = match scope {
            "worktree" => 2,
            "local" => 1,
            _ => continue,
        };
        let (key, value) = rest.split_once(' ').unwrap_or((rest, ""));
        if found.get(key).is_none_or(|(r, _)| rank >= *r) {
            found.insert(key.to_string(), (rank, value.to_string()));
        }
    }
    NetworkSettings::from_git_config(|k| found.get(&k.to_ascii_lowercase()).map(|(_, v)| v.clone()))
}

impl Ctx {
    /// Resolve the context from parsed CLI flags and the persisted config.
    ///
    /// Network: see [`stack`]. Identity: `--identity` > `DASH_FORGE_KEY` env > config
    /// default.
    pub fn resolve(cli: &Cli, config: &Config) -> Result<Self> {
        let flags = NetworkSettings::from_flags(
            cli.network.map(|n| n.kind().to_string()),
            cli.devnet_name.clone(),
            cli.dapi_addresses.clone(),
        );
        let explicit = cli
            .identity
            .clone()
            .or_else(|| std::env::var_os("DASH_FORGE_KEY").map(PathBuf::from));
        // The recorded id names the recorded default only.
        let config_identity_id = match explicit {
            None => config.default_identity_id.clone(),
            Some(_) => None,
        };
        let identity_path =
            explicit.or_else(|| config.default_identity.as_deref().map(PathBuf::from));
        let facts = identity_path
            .as_deref()
            .map(source_facts)
            .unwrap_or_default();
        let key = facts
            .network
            .as_deref()
            .and_then(full_network_key)
            .map(|k| NetworkSettings::from_flags(Some(k), None, None))
            .unwrap_or_default();
        let repo = if follows_repo_network(&cli.command) {
            repo_network()
        } else {
            NetworkSettings::default()
        };
        let (layers, network_source) = stack(Layers {
            flags,
            repo,
            config: config.network_settings(),
            env: NetworkSettings::from_env(),
            key,
        });
        let network_is_default = network_source == NetworkSource::Default;
        let target = layers.resolve().with_context(|| {
            format!(
                "resolving the network, set {network_source} (--network / --devnet-name, git \
                 config dash.network, config.toml or DASH_FORGE_NETWORK)"
            )
        })?;

        if cli
            .identity
            .as_deref()
            .is_some_and(forge_core::keystore::is_inline_key)
        {
            tracing::warn!("{}", forge_core::keystore::INLINE_KEY_ON_ARGV);
        }

        Ok(Self {
            json: cli.json,
            yes: cli.yes,
            target,
            network_is_default,
            network_source,
            identity_path,
            cli_identity: cli.identity.clone(),
            stdin_tty: std::io::stdin().is_terminal(),
            allow_archived: cli.allow_archived,
            unlocked: std::sync::OnceLock::new(),
            helper_ok: std::sync::OnceLock::new(),
            config_identity_id,
            source_facts: facts,
        })
    }

    /// The resolved network.
    pub fn network(&self) -> &Network {
        &self.target.network
    }

    /// The network label used in JSON / output: `testnet`, `mainnet` or `devnet-<name>`.
    pub fn network_label(&self) -> String {
        self.target.network.key()
    }

    /// The resolved identity path, or an actionable error explaining how to set one.
    pub fn require_identity_path(&self) -> Result<&PathBuf> {
        self.identity_path.as_ref().ok_or_else(|| {
            UserError::new(codes::NO_IDENTITY, "no identity configured")
                .cause("this command signs with an identity, and none was given or set as the default")
                .fix("`dg auth new` creates an identity; `dg auth login <file>` (or `--mnemonic`) signs in with one")
                .fix("pass --identity <file>, or set DASH_FORGE_KEY=<file>")
                .into()
        })
    }

    /// The configured identity's id, read without unsealing its key: an inline `dfk1:` key
    /// and a `keychain:` source name it, config.toml records it for the default, and a
    /// plaintext identity file holds it. `None` when it cannot be told without the key (a
    /// sealed file given by path) or no identity is configured.
    pub fn identity_id_hint(&self) -> Option<String> {
        self.identity_path.as_ref()?;
        // What the source itself says wins; the recorded id covers a sealed file.
        self.source_facts
            .identity_id
            .clone()
            .or_else(|| self.config_identity_id.clone())
            .filter(|id| forge_core::resolve::looks_like_identity_id(id))
    }

    /// Load the signing identity (bridge-format key material) from the resolved path.
    pub fn load_bridge(&self) -> Result<BridgeIdentity> {
        let path = self.require_identity_path()?;
        self.unlock_key(path)
            .and_then(|key| Ok(BridgeIdentity::from_source_text(key.expose())?))
            .with_context(|| {
                format!(
                    "loading identity from {}",
                    forge_core::keystore::describe_key_source(path)
                )
            })
    }

    /// The identity source's contents, unlocked on first use (a sealed file asks for its
    /// passphrase then, and not again in this run).
    fn unlock_key(&self, path: &std::path::Path) -> Result<&Secret> {
        if let Some(key) = self.unlocked.get() {
            return Ok(key);
        }
        let key = BridgeIdentity::unlock_source(path)?;
        Ok(self.unlocked.get_or_init(|| key))
    }

    /// The key this run already unlocked, if any: what a `dash://` git command is handed.
    pub fn unlocked_key(&self) -> Option<&Secret> {
        self.unlocked.get()
    }

    /// Whether `git-remote-dash` takes the handed key: `check` runs once per run, and its
    /// answer is kept.
    pub fn helper_checked(&self, check: impl FnOnce() -> bool) -> bool {
        *self.helper_ok.get_or_init(check)
    }

    /// Connect to the resolved network.
    pub async fn connect(&self) -> Result<PlatformClient> {
        PlatformClient::connect(self.target.clone())
            .await
            .with_context(|| format!("connecting to Dash Platform ({})", self.target.network))
    }

    /// Connect and fetch the signing identity in one step (the common preamble for
    /// mutating commands).
    pub async fn connect_with_identity(
        &self,
    ) -> Result<(PlatformClient, BridgeIdentity, LoadedIdentity)> {
        let bridge = self.load_bridge()?;
        let client = self.connect().await?;
        let identity = fetch_signer(&client, &bridge).await?;
        Ok((client, bridge, identity))
    }

    /// Load the signing identity and fetch it over `client`, already connected (a read that
    /// found it needs keys after all: a private repository).
    pub async fn signer_on(
        &self,
        client: &PlatformClient,
    ) -> Result<(BridgeIdentity, LoadedIdentity)> {
        let bridge = self.load_bridge()?;
        let identity = fetch_signer(client, &bridge).await?;
        Ok((bridge, identity))
    }

    /// Ask the user to confirm a cost-bearing / destructive action.
    ///
    /// `--yes` short-circuits to `true`. In `--json` mode a prompt is impossible, so an
    /// un-confirmed cost-bearing action is refused (pass `--yes` for automation). A
    /// non-interactive stdin (piped / CI without `--yes`) is likewise refused rather than
    /// silently proceeding.
    pub fn confirm(&self, prompt: &str) -> Result<bool> {
        self.ask(prompt, false)
    }

    /// [`Self::confirm`] for a question whose empty answer is yes (`[Y/n]`); a "no" is the
    /// E803 cancellation.
    pub fn proceed(&self, prompt: &str) -> Result<()> {
        if self.ask(prompt, true)? {
            Ok(())
        } else {
            Err(crate::errors::cancelled())
        }
    }

    /// Whether prompt flows may ask questions: stdin is a terminal and neither `--yes` nor
    /// `--json` was given (UX spec §7.1).
    pub fn interactive(&self) -> bool {
        !self.yes && !self.json && self.stdin_tty
    }

    /// E802 up front, for a command (`what`) that will ask before it spends: when the answer
    /// could not be given (no `--yes`, and `--json` or a stdin that is not a terminal), stop
    /// before any identity load, network read or plan output, not at the prompt.
    pub fn require_confirmable(&self, what: &str) -> Result<()> {
        match prompt_blocker(self.yes, self.json, self.stdin_tty) {
            None => Ok(()),
            Some(why) => Err(confirmation_required(format!(
                "{what} asks for confirmation before it spends, and {why}"
            ))
            .fix("pass --yes (-y) to confirm without a prompt, as scripts and CI must")
            .fix("run it in a terminal to review the plan and answer the prompt")
            .into()),
        }
    }

    fn ask(&self, prompt: &str, default_yes: bool) -> Result<bool> {
        if self.yes {
            return Ok(true);
        }
        if let Some(why) = prompt_blocker(self.yes, self.json, self.stdin_tty) {
            return Err(confirmation_required(format!("{prompt} — and {why}"))
                .fix("check the estimate, then run the same command with --yes")
                .into());
        }
        eprint!("{prompt} {} ", if default_yes { "[Y/n]" } else { "[y/N]" });
        std::io::stderr().flush().ok();
        let mut line = String::new();
        if std::io::stdin()
            .read_line(&mut line)
            .context("reading confirmation")?
            == 0
        {
            // EOF (Ctrl-D) is never a yes.
            return Ok(false);
        }
        Ok(match line.trim().to_ascii_lowercase().as_str() {
            "" => default_yes,
            answer => matches!(answer, "y" | "yes"),
        })
    }

    /// [`Self::confirm`], turning a "no" into the E803 cancellation.
    pub fn confirm_or_cancel(&self, prompt: &str) -> Result<()> {
        if self.confirm(prompt)? {
            Ok(())
        } else {
            Err(crate::errors::cancelled())
        }
    }

    /// Print a `--json` value (pretty) or a human closure's output, choosing by mode.
    #[allow(clippy::needless_pass_by_value)]
    pub fn emit(&self, value: Value, human: impl FnOnce()) {
        if self.json {
            crate::errors::print_json(&value);
        } else {
            human();
        }
    }
}

#[cfg(test)]
impl Ctx {
    /// A `Ctx` for devnet moutai (forge-v2 deployed) as a script would run it, for tests.
    pub(crate) fn scripted(
        yes: bool,
        json: bool,
        stdin_tty: bool,
        identity_path: Option<PathBuf>,
    ) -> Self {
        Self {
            json,
            yes,
            target: NetworkSettings::from_flags(None, Some("moutai".into()), None)
                .resolve()
                .unwrap(),
            network_is_default: false,
            network_source: NetworkSource::Flags,
            source_facts: identity_path
                .as_deref()
                .map(source_facts)
                .unwrap_or_default(),
            identity_path,
            cli_identity: None,
            stdin_tty,
            allow_archived: false,
            unlocked: std::sync::OnceLock::new(),
            helper_ok: std::sync::OnceLock::new(),
            config_identity_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(network: &str) -> Config {
        Config {
            network: Some(network.into()),
            ..Default::default()
        }
    }

    /// [`super::stack`] without a repository pin or a key's network.
    fn stack(flags: NetworkSettings, config: &Config, env: NetworkSettings) -> NetworkSettings {
        super::stack(Layers {
            flags,
            repo: NetworkSettings::default(),
            config: config.network_settings(),
            env,
            key: NetworkSettings::default(),
        })
        .0
    }

    fn net(key: &str) -> NetworkSettings {
        NetworkSettings::from_flags(Some(key.into()), None, None)
    }

    /// QW-032: a clone's own network (what `git push` uses) beats the saved default, and a CI
    /// runner's `dfk1:` key selects its network when nothing else does.
    #[test]
    fn the_repository_pin_and_the_keys_network_have_their_places() {
        let none = NetworkSettings::default;
        let layers = |repo, config, env, key| Layers {
            flags: none(),
            repo,
            config,
            env,
            key,
        };
        let (s, src) = super::stack(layers(net("devnet-bonsia"), net("testnet"), none(), none()));
        assert_eq!(src, NetworkSource::Repository);
        assert_eq!(s.resolve().unwrap().network.key(), "devnet-bonsia");
        // a flag still wins
        let (s, src) = super::stack(Layers {
            flags: net("mainnet"),
            ..layers(net("devnet-bonsia"), none(), none(), none())
        });
        assert_eq!(
            (src, s.resolve().unwrap().network.key()),
            (NetworkSource::Flags, "mainnet".into())
        );
        // fresh HOME in CI: only the key names a network
        let (s, src) = super::stack(layers(none(), none(), none(), net("devnet-bonsia")));
        assert_eq!(src, NetworkSource::Key);
        assert_eq!(s.resolve().unwrap().network.key(), "devnet-bonsia");
        // the environment beats the key
        let (_, src) = super::stack(layers(none(), none(), net("mainnet"), net("devnet-bonsia")));
        assert_eq!(src, NetworkSource::Environment);
        // nothing: the default
        let (s, src) = super::stack(layers(none(), none(), none(), none()));
        assert_eq!(src, NetworkSource::Default);
        assert!(s.is_unset());
    }

    #[test]
    fn only_the_repositorys_own_git_config_pins_its_network() {
        let text = "global\tdash.network testnet\n\
                    local\tdash.network devnet\n\
                    local\tdash.devnetname bonsia\n\
                    system\tdash.devnetname moutai\n";
        let s = parse_repo_network(text);
        assert_eq!(s.resolve().unwrap().network.key(), "devnet-bonsia");
        // a worktree value beats a local one
        let s = parse_repo_network("worktree\tdash.devnetname paloma\nlocal\tdash.network devnet\nlocal\tdash.devnetname bonsia\n");
        assert_eq!(s.devnet_name.as_deref(), Some("paloma"));
        // global only: nothing pinned here
        assert!(parse_repo_network(
            "global\tdash.network devnet\nglobal\tdash.devnetname bonsia\n"
        )
        .is_unset());
    }

    #[test]
    fn a_key_source_names_its_network_without_being_opened() {
        const ID: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";
        let facts = source_facts(std::path::Path::new(&format!(
            "dfk1:devnet-bonsia:{ID}:6:cWIFWIFWIF"
        )));
        assert_eq!(facts.network.as_deref(), Some("devnet-bonsia"));
        assert_eq!(facts.identity_id.as_deref(), Some(ID));
        let kc = source_facts(std::path::Path::new(&format!(
            "keychain:dash-forge/devnet-bonsia/{ID}"
        )));
        assert_eq!(kc.network.as_deref(), Some("devnet-bonsia"));
        assert_eq!(
            full_network_key("devnet-bonsia").as_deref(),
            Some("devnet-bonsia")
        );
        assert_eq!(full_network_key("Testnet").as_deref(), Some("testnet"));
        assert_eq!(
            full_network_key("DEVNET-bonsia").as_deref(),
            Some("devnet-bonsia")
        );
        assert_eq!(full_network_key("testnet").as_deref(), Some("testnet"));
        // an older identity file's bare `devnet` names no devnet
        assert_eq!(full_network_key("devnet"), None);
        assert_eq!(full_network_key(""), None);
    }

    #[test]
    fn flags_beat_config_beat_env() {
        let env = NetworkSettings {
            network: Some("mainnet".into()),
            ..Default::default()
        };
        // Config wins over env.
        let t = stack(NetworkSettings::default(), &config("testnet"), env.clone())
            .resolve()
            .unwrap();
        assert_eq!(t.network, Network::Testnet);
        // Env applies when nothing above sets a network.
        let t = stack(NetworkSettings::default(), &Config::default(), env)
            .resolve()
            .unwrap();
        assert_eq!(t.network, Network::Mainnet);
        // A flag wins over config.
        let flags = NetworkSettings::from_flags(Some("mainnet".into()), None, None);
        let t = stack(flags, &config("testnet"), NetworkSettings::default())
            .resolve()
            .unwrap();
        assert_eq!(t.network, Network::Mainnet);
    }

    #[test]
    fn only_an_empty_stack_is_the_default_network() {
        let none = NetworkSettings::default;
        let empty = stack(none(), &Config::default(), none());
        assert!(empty.network.is_none() && empty.devnet_name.is_none());
        assert_eq!(empty.resolve().unwrap().network, Network::Testnet);
        // `dg auth new --devnet-name moutai` saved a network: not the default any more.
        let saved = Config {
            devnet_name: Some("moutai".into()),
            ..config("devnet")
        };
        let t = stack(none(), &saved, none());
        assert_eq!(t.resolve().unwrap().network.key(), "devnet-moutai");
    }

    #[test]
    fn prompts_need_yes_unless_a_terminal_can_answer() {
        assert_eq!(prompt_blocker(true, true, false), None);
        assert_eq!(prompt_blocker(false, false, true), None);
        assert_eq!(
            prompt_blocker(false, false, false),
            Some("stdin is not a terminal")
        );
        assert_eq!(
            prompt_blocker(false, true, true),
            Some("--json mode cannot prompt")
        );
    }

    fn scripted_ctx(yes: bool, json: bool, stdin_tty: bool) -> Ctx {
        Ctx::scripted(yes, json, stdin_tty, None)
    }

    #[test]
    fn require_confirmable_names_yes_when_it_refuses() {
        assert!(scripted_ctx(true, false, false)
            .require_confirmable("`dg init`")
            .is_ok());
        assert!(scripted_ctx(false, false, true)
            .require_confirmable("`dg init`")
            .is_ok());
        let err = scripted_ctx(false, false, false)
            .require_confirmable("`dg init`")
            .unwrap_err();
        let u = forge_core::user_error::classify(
            err.chain(),
            &forge_core::user_error::ErrorContext::default(),
        );
        assert_eq!((u.code, u.exit_code()), ("E802", 8));
        assert!(u
            .cause
            .as_deref()
            .unwrap()
            .contains("stdin is not a terminal"));
        assert!(u.fix[0].contains("--yes"), "{:?}", u.fix);
        assert_eq!(u.note.as_deref(), Some("nothing was written"));
    }

    /// L-12: a read names its viewer without opening the key: a sealed file is never unsealed
    /// (no passphrase prompt), and its id comes from config.toml when it is the default.
    #[test]
    fn the_identity_id_is_read_without_opening_a_key() {
        const ID: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";
        let dir = tempfile::tempdir().unwrap();
        let hint = |source: &str, recorded: Option<&str>| {
            let mut ctx = Ctx::scripted(false, false, false, Some(PathBuf::from(source)));
            ctx.config_identity_id = recorded.map(str::to_string);
            ctx.identity_id_hint()
        };
        assert_eq!(
            hint(&format!("dfk1:devnet:{ID}:5:cWIFWIFWIF"), None).as_deref(),
            Some(ID)
        );
        assert_eq!(
            hint(&format!("keychain:dash-forge/devnet/{ID}"), None).as_deref(),
            Some(ID)
        );
        let plain = dir.path().join("id.json");
        std::fs::write(
            &plain,
            format!(r#"{{"identityId":"{ID}","network":"devnet"}}"#),
        )
        .unwrap();
        assert_eq!(hint(plain.to_str().unwrap(), None).as_deref(), Some(ID));
        // A sealed file does not say whose it is without its passphrase…
        let sealed_path = dir.path().join("id.key");
        let sealed = forge_core::sealed::seal(b"{}", "a long passphrase").unwrap();
        std::fs::write(&sealed_path, sealed).unwrap();
        assert_eq!(hint(sealed_path.to_str().unwrap(), None), None);
        // …unless config.toml recorded the id next to it as the default.
        assert_eq!(
            hint(sealed_path.to_str().unwrap(), Some(ID)).as_deref(),
            Some(ID)
        );
        // The source's own id wins over a (possibly stale) recorded one.
        let other = "4ggxb4HB2aFc5Q3Ms5x8ATYD3JdMLp9f3kMpWTyLEFtX";
        assert_eq!(
            hint(plain.to_str().unwrap(), Some(other)).as_deref(),
            Some(ID)
        );
        // A pipe (`--identity <(…)`) is not read for a hint: the key load needs its bytes.
        #[cfg(unix)]
        {
            let fifo = dir.path().join("fifo");
            let made = std::process::Command::new("mkfifo").arg(&fifo).status();
            if made.is_ok_and(|s| s.success()) {
                assert_eq!(hint(fifo.to_str().unwrap(), None), None);
            }
        }
        // No identity at all: nobody.
        let anon = Ctx::scripted(false, false, false, None);
        assert_eq!(anon.identity_id_hint(), None);
    }

    #[test]
    fn devnet_name_flag_overrides_a_testnet_config() {
        let flags = NetworkSettings::from_flags(None, Some("moutai".into()), None);
        let t = stack(flags, &config("testnet"), NetworkSettings::default())
            .resolve()
            .unwrap();
        assert_eq!(t.network.key(), "devnet-moutai");
    }
}
