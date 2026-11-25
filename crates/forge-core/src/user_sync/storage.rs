//! The `storage` slot's entries in the web app's shapes (`forge-web/lib/storage/profiles.ts`):
//! `profile:<name>` → `{settings: ProfilePublic, secrets: ProfileSecrets}`, `default` and
//! `repo:<repoId>` → `StoragePolicy`. dg-only settings the web form has no field for ride in
//! a sibling `dg` object, which the web keeps as it is.

use serde_json::{json, Map, Value};

use crate::error::{Error, Result};
use crate::keystore::Secret;
use crate::storage::policy::StoragePolicy;
use crate::storage::profiles::{
    valid_profile_name, KeyId, KuboProfile, PinningProfile, PlatformProfile, Profile, S3Profile,
    SecretRef,
};

/// `profile:<name>`.
pub const PROFILE_PREFIX: &str = "profile:";
/// The default policy.
pub const DEFAULT_KEY: &str = "default";
/// `repo:<repoId>`: one repository's policy.
pub const REPO_PREFIX: &str = "repo:";

/// The entry key of profile `name`.
pub fn profile_key(name: &str) -> String {
    format!("{PROFILE_PREFIX}{name}")
}

/// The entry key of repository `repo_id`'s policy.
pub fn repo_key(repo_id: &str) -> String {
    format!("{REPO_PREFIX}{repo_id}")
}

fn s3_provider(endpoint: &str) -> &'static str {
    let host = reqwest::Url::parse(endpoint)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default();
    if host.ends_with(".r2.cloudflarestorage.com") {
        "r2"
    } else if host.ends_with(".backblazeb2.com") {
        "b2"
    } else if host.ends_with(".amazonaws.com") {
        "aws"
    } else {
        "minio"
    }
}

fn put_secret(secrets: &mut Map<String, Value>, field: &str, r: Option<&SecretRef>) -> Result<()> {
    if let Some(r) = r {
        let value = r.resolve()?;
        secrets.insert(field.into(), Value::String(value.expose().to_string()));
    }
    Ok(())
}

/// `profile` as the synced `{settings, secrets}` value, every secret resolved to its value
/// (it travels encrypted). Fails, naming the reference only, when a secret does not resolve here.
pub fn profile_to_synced(profile: &Profile) -> Result<Value> {
    let mut secrets = Map::new();
    let mut dg = Map::new();
    let settings = match profile {
        Profile::S3(p) => {
            match &p.access_key_id {
                Some(KeyId::Literal(id)) => {
                    secrets.insert("accessKeyId".into(), Value::String(id.clone()));
                }
                Some(KeyId::Ref(r)) => put_secret(&mut secrets, "accessKeyId", Some(r))?,
                None => {}
            }
            put_secret(
                &mut secrets,
                "secretAccessKey",
                p.secret_access_key.as_ref(),
            )?;
            put_secret(&mut secrets, "sessionToken", p.session_token.as_ref())?;
            if p.allow_private_uri {
                dg.insert("allowPrivateUri".into(), Value::Bool(true));
            }
            json!({
                "kind": "s3",
                "provider": s3_provider(&p.endpoint),
                "endpoint": p.endpoint,
                "region": p.region,
                "bucket": p.bucket,
                "pathStyle": p.path_style,
                "publicUrl": p.public_url.clone().unwrap_or_default(),
                "prefix": p.prefix,
            })
        }
        Profile::IpfsKubo(p) => {
            put_secret(&mut secrets, "apiAuth", p.api_auth.as_ref())?;
            if p.allow_private_uri {
                dg.insert("allowPrivateUri".into(), Value::Bool(true));
            }
            json!({
                "kind": "ipfs-kubo",
                "provider": "kubo",
                "api": p.api,
                "gateway": p.gateway.clone().unwrap_or_default(),
                "publicGateway": p.public_gateway.clone().unwrap_or_default(),
                "pinningEndpoint": "",
            })
        }
        Profile::IpfsPinningService(p) => {
            put_secret(&mut secrets, "apiAuth", p.api_auth.as_ref())?;
            put_secret(&mut secrets, "pinningToken", Some(&p.pinning_token))?;
            if p.allow_private_uri {
                dg.insert("allowPrivateUri".into(), Value::Bool(true));
            }
            if let Some(t) = p.pin_timeout_secs {
                dg.insert("pinTimeoutSecs".into(), json!(t));
            }
            json!({
                "kind": "ipfs-pinning-service",
                "provider": "pinning",
                "api": p.api,
                "gateway": p.gateway.clone().unwrap_or_default(),
                "publicGateway": p.public_gateway.clone().unwrap_or_default(),
                "pinningEndpoint": p.pinning_endpoint,
            })
        }
        Profile::Platform(_) => json!({"kind": "platform", "provider": "platform"}),
    };
    let mut out = json!({"settings": settings, "secrets": Value::Object(secrets)});
    if !dg.is_empty() {
        out["dg"] = Value::Object(dg);
    }
    Ok(out)
}

fn text<'a>(o: &'a Map<String, Value>, field: &str) -> Result<&'a str> {
    o.get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::InvalidInput(format!("a synced profile has no {field}")))
}

fn optional(o: &Map<String, Value>, field: &str) -> Option<String> {
    o.get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn secret(o: &Map<String, Value>, field: &str) -> Option<SecretRef> {
    optional(o, field).map(|v| SecretRef::Value(Secret::new(v)))
}

/// The synced value as a dg [`Profile`] whose secrets are held in memory
/// ([`SecretRef::Value`]). `Ok(None)` for a kind this build does not know (the entry is kept as
/// it is); an error for a known kind that does not validate.
pub fn profile_from_synced(value: &Value) -> Result<Option<Profile>> {
    let empty = Map::new();
    let settings = value
        .get("settings")
        .and_then(Value::as_object)
        .ok_or_else(|| Error::InvalidInput("a synced profile has no settings".into()))?;
    let secrets = value
        .get("secrets")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let dg = value.get("dg").and_then(Value::as_object).unwrap_or(&empty);
    let allow_private_uri = dg
        .get("allowPrivateUri")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let profile = match settings.get("kind").and_then(Value::as_str) {
        Some("s3") => Profile::S3(S3Profile {
            endpoint: text(settings, "endpoint")?.to_string(),
            region: optional(settings, "region").unwrap_or_else(|| "us-east-1".into()),
            bucket: text(settings, "bucket")?.to_string(),
            path_style: settings
                .get("pathStyle")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            public_url: optional(settings, "publicUrl"),
            prefix: optional(settings, "prefix").unwrap_or_default(),
            access_key_id: secret(secrets, "accessKeyId").map(KeyId::Ref),
            secret_access_key: secret(secrets, "secretAccessKey"),
            session_token: secret(secrets, "sessionToken"),
            allow_private_uri,
        }),
        Some("ipfs-kubo") => Profile::IpfsKubo(KuboProfile {
            api: text(settings, "api")?.to_string(),
            gateway: optional(settings, "gateway"),
            public_gateway: optional(settings, "publicGateway"),
            api_auth: secret(secrets, "apiAuth"),
            allow_private_uri,
        }),
        Some("ipfs-pinning-service") => Profile::IpfsPinningService(PinningProfile {
            api: text(settings, "api")?.to_string(),
            gateway: optional(settings, "gateway"),
            public_gateway: optional(settings, "publicGateway"),
            api_auth: secret(secrets, "apiAuth"),
            pinning_endpoint: text(settings, "pinningEndpoint")?.to_string(),
            pinning_token: secret(secrets, "pinningToken").ok_or_else(|| {
                Error::InvalidInput("a synced pinning profile has no pinning token".into())
            })?,
            pin_timeout_secs: dg.get("pinTimeoutSecs").and_then(Value::as_u64),
            allow_private_uri,
        }),
        Some("platform") => Profile::Platform(PlatformProfile {}),
        _ => return Ok(None),
    };
    profile.validate()?;
    Ok(Some(profile))
}

/// A policy as the synced `{targets, replicas, platformFallback}`.
pub fn policy_to_synced(policy: &StoragePolicy) -> Value {
    json!({
        "targets": policy.targets,
        "replicas": policy.replicas.unwrap_or(policy.targets.len()).max(1),
        "platformFallback": policy.platform_fallback,
    })
}

/// A synced policy, or `None` when it does not parse or names no target.
pub fn policy_from_synced(value: &Value) -> Option<StoragePolicy> {
    let targets: Vec<String> = value
        .get("targets")?
        .as_array()?
        .iter()
        .map(|t| t.as_str().map(str::to_string))
        .collect::<Option<_>>()?;
    if targets.is_empty() || !targets.iter().all(|t| valid_profile_name(t)) {
        return None;
    }
    let replicas = value
        .get("replicas")
        .and_then(Value::as_u64)
        .and_then(|r| usize::try_from(r).ok());
    Some(StoragePolicy {
        targets,
        replicas,
        platform_fallback: value
            .get("platformFallback")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::StorageProfiles;

    const VECTORS: &str =
        include_str!("../../../../forge-contracts/fixtures/user-sync/vectors.json");

    #[test]
    fn the_web_profile_in_the_vectors_reads_and_writes_back_the_same() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        let entry = &v["state"][0]["plaintextJson"]["entries"]["profile:r2-main"]["v"];
        let p = profile_from_synced(entry).unwrap().unwrap();
        let Profile::S3(s3) = &p else { panic!() };
        assert_eq!(s3.bucket, "forge");
        assert_eq!(s3.public_url.as_deref(), Some("https://packs.example.org"));
        assert_eq!(
            s3.secret_access_key
                .as_ref()
                .unwrap()
                .resolve()
                .unwrap()
                .expose(),
            "test-secret-not-real"
        );
        assert_eq!(&profile_to_synced(&p).unwrap(), entry);
        let policy =
            policy_from_synced(&v["state"][0]["plaintextJson"]["entries"]["default"]["v"]).unwrap();
        assert_eq!(policy.targets, vec!["r2-main".to_string()]);
        assert_eq!(
            policy_to_synced(&policy),
            v["state"][0]["plaintextJson"]["entries"]["default"]["v"]
        );
    }

    #[test]
    fn every_local_kind_round_trips_with_its_secrets_resolved() {
        std::env::set_var("USER_SYNC_TEST_ID", "AKID");
        std::env::set_var("USER_SYNC_TEST_SECRET", "s3cr3t");
        std::env::set_var("USER_SYNC_TEST_PIN", "pin-token");
        let local = StorageProfiles::parse(
            r#"
[profiles.r2]
kind = "s3"
endpoint = "https://acct.r2.cloudflarestorage.com"
region = "auto"
bucket = "forge"
access_key_id = "env:USER_SYNC_TEST_ID"
secret_access_key = "env:USER_SYNC_TEST_SECRET"
allow_private_uri = true

[profiles.pins]
kind = "ipfs-pinning-service"
api = "http://127.0.0.1:5001"
pinning_endpoint = "https://pins.example/psa"
pinning_token = "env:USER_SYNC_TEST_PIN"
pin_timeout_secs = 60

[profiles.kubo]
kind = "ipfs-kubo"
api = "http://127.0.0.1:5001"

[profiles.chain]
kind = "platform"
"#,
        )
        .unwrap();
        for (name, p) in &local.profiles {
            let synced = profile_to_synced(p).unwrap();
            let back = profile_from_synced(&synced).unwrap().unwrap();
            assert_eq!(back.kind(), p.kind(), "{name}");
            assert_eq!(profile_to_synced(&back).unwrap(), synced, "{name}");
            assert!(
                !format!("{back:?}").contains("s3cr3t"),
                "a synced secret is never printed"
            );
        }
        let r2 = profile_to_synced(&local.profiles["r2"]).unwrap();
        assert_eq!(r2["settings"]["provider"], "r2");
        assert_eq!(r2["secrets"]["secretAccessKey"], "s3cr3t");
        assert_eq!(r2["dg"]["allowPrivateUri"], true);
        assert!(r2["settings"].get("allowPrivateUri").is_none());
        let mut in_memory = StorageProfiles::default();
        in_memory
            .profiles
            .insert("r2".into(), profile_from_synced(&r2).unwrap().unwrap());
        assert!(
            in_memory.to_toml().is_err(),
            "a synced secret never reaches storage.toml"
        );
    }

    #[test]
    fn an_unknown_kind_is_left_alone() {
        let v = json!({"settings": {"kind": "arweave", "provider": "x"}, "secrets": {}});
        assert!(profile_from_synced(&v).unwrap().is_none());
    }
}
