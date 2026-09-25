//! A repo's storage policy: which profiles a push writes to and how many must confirm.
//!
//! The policy is LOCAL (git config), because the credentials it needs are local:
//!
//! ```text
//! git config dash.storage  "r2-main,kubo"   # profile names from storage.toml
//! git config dash.replicas 2                # N: the push fails unless N targets confirm
//! git config dash.platformFallback true     # optional: store on Platform if N is not met
//! ```
//!
//! `remote.<name>.dashStorage` / `remote.<name>.dashReplicas` /
//! `remote.<name>.dashPlatformFallback` override these per remote. No policy at all means
//! "Platform only" — the behaviour every push had before policies existed.
//!
//! The on-chain `config.backend` only ADVERTISES the mode + public read URIs to readers;
//! it never chooses where a push writes, because the chain cannot hold the credentials.

use super::profiles::{Profile, StorageProfiles, PLATFORM_PROFILE};
use crate::error::{Error, Result};

/// The raw policy, as read from git config.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoragePolicy {
    /// Profile names, in the order given.
    pub targets: Vec<String>,
    /// Required confirmations; `None` = every target.
    pub replicas: Option<usize>,
    /// Store on Platform when the external targets cannot confirm `replicas`.
    pub platform_fallback: bool,
}

/// A policy resolved against the user's profiles.
#[derive(Debug, Clone)]
pub struct ResolvedPolicy {
    /// External (non-Platform) targets, in policy order.
    pub external: Vec<(String, Profile)>,
    /// Whether Platform `chunk` storage is one of the targets.
    pub platform: bool,
    /// Required confirmations (`1..=targets`).
    pub replicas: usize,
    /// Store on Platform when the external targets cannot confirm `replicas`.
    pub platform_fallback: bool,
}

/// Parse a git-config boolean (`true/yes/on/1` and `false/no/off/0`, case-insensitive).
pub fn parse_git_bool(key: &str, value: &str) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" | "1" => Ok(true),
        "false" | "no" | "off" | "0" | "" => Ok(false),
        other => Err(Error::Config(format!(
            "{key} must be a boolean (true/false), got {other:?}"
        ))),
    }
}

impl StoragePolicy {
    /// Platform only, one replica (the default when nothing is configured).
    pub fn platform_only() -> Self {
        Self {
            targets: vec![PLATFORM_PROFILE.to_string()],
            replicas: Some(1),
            platform_fallback: false,
        }
    }

    /// Build from the raw git-config values (`dash.storage`, `dash.replicas`,
    /// `dash.platformFallback`). All `None` → [`StoragePolicy::platform_only`].
    pub fn from_git_values(
        storage: Option<&str>,
        replicas: Option<&str>,
        platform_fallback: Option<&str>,
    ) -> Result<Self> {
        let targets: Vec<String> = storage
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        let replicas = match replicas.map(str::trim).filter(|s| !s.is_empty()) {
            None => None,
            Some(r) => Some(r.parse::<usize>().map_err(|_| {
                Error::Config(format!("dash.replicas must be a whole number, got {r:?}"))
            })?),
        };
        let platform_fallback = platform_fallback
            .map(|v| parse_git_bool("dash.platformFallback", v))
            .transpose()?
            .unwrap_or(false);
        if targets.is_empty() {
            if replicas.is_some_and(|r| r > 1) {
                return Err(Error::Config(
                    "dash.replicas is set but dash.storage lists no targets — add targets with \
                     `dg storage use <profile,…>`"
                        .into(),
                ));
            }
            return Ok(Self {
                platform_fallback,
                ..Self::platform_only()
            });
        }
        Ok(Self {
            targets,
            replicas,
            platform_fallback,
        })
    }

    /// Whether this is the implicit Platform-only policy.
    pub fn is_platform_only(&self) -> bool {
        self.targets.len() == 1 && self.targets[0] == PLATFORM_PROFILE
    }

    /// Resolve the names against `profiles`, validating the replica count.
    pub fn resolve(&self, profiles: &StorageProfiles) -> Result<ResolvedPolicy> {
        let mut external = Vec::new();
        let mut platform = false;
        for (i, name) in self.targets.iter().enumerate() {
            if self.targets[..i].contains(name) {
                return Err(Error::Config(format!("dash.storage lists {name:?} twice")));
            }
            let profile = profiles.get(name).ok_or_else(|| {
                let known: Vec<&str> = profiles.profiles.keys().map(String::as_str).collect();
                Error::Config(format!(
                    "dash.storage names unknown storage profile {name:?} (known: {}; `platform` \
                     is built in). Add it with `dg storage add {name} …`",
                    if known.is_empty() {
                        "none".to_string()
                    } else {
                        known.join(", ")
                    }
                ))
            })?;
            if profile.is_platform() {
                if platform {
                    return Err(Error::Config(
                        "dash.storage lists Platform storage twice (under two names)".into(),
                    ));
                }
                platform = true;
            } else {
                external.push((name.clone(), profile));
            }
        }
        let total = external.len() + usize::from(platform);
        let replicas = self.replicas.unwrap_or(total);
        if replicas == 0 {
            return Err(Error::Config("dash.replicas must be at least 1".into()));
        }
        if replicas > total {
            return Err(Error::Config(format!(
                "dash.replicas is {replicas} but dash.storage lists only {total} target(s)"
            )));
        }
        Ok(ResolvedPolicy {
            external,
            platform,
            replicas,
            platform_fallback: self.platform_fallback && !platform,
        })
    }
}

impl ResolvedPolicy {
    /// Target names in policy order (external first, then `platform`), for display.
    pub fn target_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.external.iter().map(|(n, _)| n.clone()).collect();
        if self.platform {
            names.push(PLATFORM_PROFILE.to_string());
        }
        names
    }

    /// Total configured targets.
    pub fn total(&self) -> usize {
        self.external.len() + usize::from(self.platform)
    }

    /// The `config.backend.mode` this policy advertises: `0` platform, `1` ipfs, `2` s3,
    /// `4` mixed (Platform plus external, or more than one external kind).
    pub fn advertised_mode(&self) -> u8 {
        let mut kinds: Vec<u8> = self
            .external
            .iter()
            .map(|(_, p)| match p {
                Profile::S3(_) => 2,
                _ => 1,
            })
            .collect();
        kinds.sort_unstable();
        kinds.dedup();
        match (self.platform, kinds.as_slice()) {
            (_, []) => 0,
            (false, [only]) => *only,
            _ => 4,
        }
    }

    /// The public read bases readers can use for this policy's external targets (the S3
    /// public origins and IPFS public gateways) — what `config.backend.uris` advertises.
    pub fn advertised_uris(&self) -> Vec<String> {
        let mut out = Vec::new();
        for (_, p) in &self.external {
            match p {
                Profile::S3(s3) => {
                    if let Some(u) = &s3.public_url {
                        out.push(u.trim_end_matches('/').to_string());
                    }
                }
                other => {
                    if let Some(g) = other.public_gateway() {
                        out.push(format!("{}/ipfs/", g.trim_end_matches('/')));
                    } else {
                        out.push("ipfs://".to_string());
                    }
                }
            }
        }
        out.dedup();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profiles() -> StorageProfiles {
        StorageProfiles::parse(
            r#"
[profiles.r2]
kind = "s3"
endpoint = "https://acct.r2.cloudflarestorage.com"
region = "auto"
bucket = "forge"
public_url = "https://pub.r2.dev"

[profiles.kubo]
kind = "ipfs-kubo"
api = "http://127.0.0.1:5001"

[profiles.chain]
kind = "platform"
"#,
        )
        .unwrap()
    }

    #[test]
    fn nothing_configured_is_platform_only() {
        let p = StoragePolicy::from_git_values(None, None, None).unwrap();
        assert!(p.is_platform_only());
        let r = p.resolve(&StorageProfiles::default()).unwrap();
        assert!(r.platform);
        assert!(r.external.is_empty());
        assert_eq!(r.replicas, 1);
        assert_eq!(r.advertised_mode(), 0);
    }

    #[test]
    fn replicas_default_to_every_target() {
        let p = StoragePolicy::from_git_values(Some("r2, kubo"), None, None).unwrap();
        let r = p.resolve(&profiles()).unwrap();
        assert_eq!(r.replicas, 2);
        assert_eq!(r.target_names(), vec!["r2", "kubo"]);
        assert!(!r.platform);
        assert_eq!(r.advertised_mode(), 4, "s3 + ipfs is mixed");
        assert_eq!(
            r.advertised_uris(),
            vec!["https://pub.r2.dev".to_string(), "ipfs://".to_string()]
        );
    }

    #[test]
    fn explicit_replicas_and_platform_member() {
        let p = StoragePolicy::from_git_values(Some("r2,platform"), Some("1"), None).unwrap();
        let r = p.resolve(&profiles()).unwrap();
        assert_eq!(r.replicas, 1);
        assert!(r.platform);
        assert_eq!(r.external.len(), 1);
        assert_eq!(r.advertised_mode(), 4);
        // A user-named platform profile resolves the same way.
        let p = StoragePolicy::from_git_values(Some("chain"), None, None).unwrap();
        assert!(p.resolve(&profiles()).unwrap().platform);
    }

    #[test]
    fn single_external_kind_advertises_that_kind() {
        let p = StoragePolicy::from_git_values(Some("r2"), None, None).unwrap();
        assert_eq!(p.resolve(&profiles()).unwrap().advertised_mode(), 2);
        let p = StoragePolicy::from_git_values(Some("kubo"), None, None).unwrap();
        assert_eq!(p.resolve(&profiles()).unwrap().advertised_mode(), 1);
    }

    #[test]
    fn invalid_policies_are_refused() {
        let pr = profiles();
        let err = |s: Option<&str>, r: Option<&str>| {
            StoragePolicy::from_git_values(s, r, None)
                .and_then(|p| p.resolve(&pr))
                .unwrap_err()
                .to_string()
        };
        assert!(err(Some("r2,kubo"), Some("3")).contains("only 2 target"));
        assert!(err(Some("r2"), Some("0")).contains("at least 1"));
        assert!(err(Some("r2"), Some("two")).contains("whole number"));
        assert!(err(Some("r2,r2"), None).contains("twice"));
        assert!(err(Some("platform,chain"), None).contains("twice"));
        assert!(err(Some("nope"), None).contains("dg storage add nope"));
        assert!(err(None, Some("2")).contains("no targets"));
    }

    #[test]
    fn fallback_is_ignored_when_platform_is_already_a_target() {
        let p = StoragePolicy::from_git_values(Some("r2,platform"), None, Some("true")).unwrap();
        assert!(!p.resolve(&profiles()).unwrap().platform_fallback);
        let p = StoragePolicy::from_git_values(Some("r2"), None, Some("yes")).unwrap();
        assert!(p.resolve(&profiles()).unwrap().platform_fallback);
        assert!(StoragePolicy::from_git_values(Some("r2"), None, Some("maybe")).is_err());
    }
}
