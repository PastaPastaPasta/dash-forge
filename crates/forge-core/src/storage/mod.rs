//! Bring-your-own storage: the user's storage profiles, a repo's replication policy, the
//! push-side replication engine, and the read-side racer.
//!
//! - [`profiles`] — `~/.config/dash-forge/storage.toml`: named S3 / kubo / pinning-service
//!   / Platform targets whose secrets are references (`env:` / `keychain:`), never values.
//! - [`policy`] — `dash.storage` / `dash.replicas` in git config: which profiles a push
//!   writes to and how many must confirm.
//! - [`targets`] — the [`StorageTarget`] seam the push path writes through, the external
//!   (S3 / IPFS) implementation with upload verification, and [`replicate`], which fans a
//!   pack out to every target in parallel and fails unless N confirm. The Platform target
//!   lives next to the contract model in [`crate::repo`], so a new contract generation
//!   changes that one implementation and nothing in the push path.
//! - [`read`] — [`PackReader`]: races a manifest's recorded URIs and a configurable IPFS
//!   gateway list, hash-verifying every candidate; Platform chunks are the caller's last
//!   resort.
//! - [`cors`] — browser-readability checks and the exact provider CORS config to paste.
//!
//! Nothing in this module is operated by the Forge project: every endpoint is the user's
//! own, or a public gateway that is only ever trusted for bytes that hash-verify.

pub mod cors;
pub mod local;
pub mod policy;
pub mod profiles;
pub mod read;
pub mod targets;

pub use policy::{ResolvedPolicy, StoragePolicy};
pub use profiles::{Profile, SecretRef, StorageProfiles, PLATFORM_PROFILE};
pub use read::PackReader;
pub use targets::{
    replicate, ExternalTarget, Observed, Replica, Replication, ReplicationError, StorageTarget,
    StoreOutcome, TargetFailure, UriBudget,
};

/// The shared defaults file (also imported by forge-web).
const STORAGE_DEFAULTS_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../forge-contracts/config/storage-defaults.json"
));

/// The default public IPFS gateway list, from `forge-contracts/config/storage-defaults.json`
/// — the single place every client reads it from.
pub fn default_ipfs_gateways() -> Vec<String> {
    let parsed: serde_json::Value =
        serde_json::from_str(STORAGE_DEFAULTS_JSON).expect("storage-defaults.json is valid JSON");
    parsed["ipfsGateways"]
        .as_array()
        .expect("storage-defaults.json has ipfsGateways")
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.trim_end_matches('/').to_string()))
        .collect()
}

/// A human byte count (`812 B`, `4.0 KiB`, `1.2 MiB`).
#[allow(clippy::cast_precision_loss)]
pub fn human_bytes(n: u64) -> String {
    const KIB: f64 = 1024.0;
    let f = n as f64;
    if f < KIB {
        format!("{n} B")
    } else if f < KIB * KIB {
        format!("{:.1} KiB", f / KIB)
    } else if f < KIB * KIB * KIB {
        format!("{:.1} MiB", f / (KIB * KIB))
    } else {
        format!("{:.2} GiB", f / (KIB * KIB * KIB))
    }
}

/// The HTTP client storage I/O uses: bounded connect and idle-read timeouts so a dead
/// endpoint costs one timeout and a failover, not a hung push or clone.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_gateway_defaults_load() {
        let g = default_ipfs_gateways();
        assert!(g.len() >= 2, "several public gateways by default");
        assert!(g
            .iter()
            .all(|u| u.starts_with("https://") && !u.ends_with('/')));
    }

    #[test]
    fn human_bytes_units() {
        assert_eq!(human_bytes(812), "812 B");
        assert_eq!(human_bytes(4096), "4.0 KiB");
        assert_eq!(human_bytes(1_258_291), "1.2 MiB");
    }
}
