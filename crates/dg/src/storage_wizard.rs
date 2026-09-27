//! `dg storage add` with no arguments: the prompt flow of UX spec §3.2.
//!
//! The answers build the same [`StorageAddArgs`] the flags do ([`collect`]), so the flow ends
//! by printing a re-runnable `dg storage add …` command ([`equivalent_command`]). A pasted
//! secret is read without echo and stored in the OS keychain under
//! `dash-forge/<profile>` (`keychain:dash-forge/<profile>`), never written to storage.toml,
//! printed or logged. The profile is saved, then checked exactly like `dg storage test`
//! ([`crate::storage::run_checks`]); a failing check prints its fix and the flow still
//! finishes (the CLI reads without CORS; only the web app needs it).

use std::path::Path;

use anyhow::Result;

use forge_core::keychain;
use forge_core::keystore::Secret;
use forge_core::storage::profiles::valid_profile_name;
use forge_core::storage::{SecretRef, StorageProfiles, PLATFORM_PROFILE};
use forge_core::user_error::{codes, UserError};

use crate::prompt::{text_valid, Prompter};
use crate::{ProfileKindArg, StorageAddArgs};

/// What the prompts produced: the flags, plus a pasted secret to put in the keychain
/// before the profile is saved.
pub struct Answers {
    /// The flags the answers map to (`name` and `kind` always set).
    pub args: StorageAddArgs,
    /// A secret the user pasted, to store under `keychain:dash-forge/<name>`.
    pub pasted: Option<Secret>,
}

/// The S3 provider presets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Preset {
    R2,
    B2,
    Aws,
    Other,
}

/// Ask for a storage profile. `existing` are the profile names already in storage.toml;
/// `keychain_ok` is whether the OS keychain can store a pasted secret on this machine.
pub fn collect(p: &mut dyn Prompter, existing: &[String], keychain_ok: bool) -> Result<Answers> {
    let name = loop {
        let name = text_valid(
            p,
            "Profile name",
            "a short name you pick; repos refer to it (`dg storage use <name>`)",
            None,
            |n| {
                if !valid_profile_name(n) {
                    Err("use letters, digits, '-', '_' or '.' (at most 64)".into())
                } else if n == PLATFORM_PROFILE {
                    Err("`platform` is built in; pick another name".into())
                } else {
                    Ok(())
                }
            },
        )?;
        if !existing.contains(&name) || p.confirm(&format!("{name} exists. Replace it?"), false)? {
            break name;
        }
    };
    let kind = match p.choose(
        "Kind",
        &[
            "S3-compatible (Cloudflare R2, Backblaze B2, AWS S3, MinIO)",
            "IPFS: your own kubo node",
            "IPFS: kubo + a pinning service",
            "Dash Platform (on-chain, permanent, ~0.28 DASH per MiB)",
        ],
        0,
    )? {
        0 => ProfileKindArg::S3,
        1 => ProfileKindArg::IpfsKubo,
        2 => ProfileKindArg::IpfsPinningService,
        _ => ProfileKindArg::Platform,
    };
    let mut args = StorageAddArgs {
        name: Some(name.clone()),
        kind: Some(kind),
        ..StorageAddArgs::default()
    };
    let mut pasted = None;
    match kind {
        ProfileKindArg::S3 => s3(p, &name, keychain_ok, &mut args, &mut pasted)?,
        ProfileKindArg::IpfsKubo | ProfileKindArg::IpfsPinningService => {
            ipfs(p, &name, keychain_ok, &mut args, &mut pasted)?;
        }
        ProfileKindArg::Platform => {}
    }
    Ok(Answers { args, pasted })
}

fn http_url(v: &str) -> std::result::Result<(), String> {
    match reqwest::Url::parse(v) {
        Ok(u) if matches!(u.scheme(), "http" | "https") && u.host_str().is_some() => Ok(()),
        _ => Err("an http(s) URL, e.g. https://example.org".into()),
    }
}

fn optional_url(v: &str) -> std::result::Result<(), String> {
    if v.is_empty() {
        Ok(())
    } else {
        http_url(v)
    }
}

fn non_empty(v: &str) -> std::result::Result<(), String> {
    if v.trim().is_empty() {
        Err("an answer is required".into())
    } else {
        Ok(())
    }
}

/// `Some(v)` for a non-empty answer.
fn some(v: String) -> Option<String> {
    (!v.is_empty()).then_some(v)
}

#[allow(clippy::too_many_lines)] // one question after another, each with its own hint
fn s3(
    p: &mut dyn Prompter,
    name: &str,
    keychain_ok: bool,
    args: &mut StorageAddArgs,
    pasted: &mut Option<Secret>,
) -> Result<()> {
    let preset = match p.choose(
        "Provider",
        &[
            "Cloudflare R2   (region auto, path-style; recommended: free egress)",
            "Backblaze B2",
            "AWS S3",
            "MinIO / other S3-compatible",
        ],
        0,
    )? {
        0 => Preset::R2,
        1 => Preset::B2,
        2 => Preset::Aws,
        _ => Preset::Other,
    };
    let (endpoint, region) = match preset {
        Preset::R2 => {
            let account = text_valid(
                p,
                "Account id",
                "Cloudflare dashboard → R2 → Overview: \"Account ID\" (32 hex characters)",
                None,
                |v| {
                    if !v.is_empty() && v.bytes().all(|b| b.is_ascii_alphanumeric()) {
                        Ok(())
                    } else {
                        Err("letters and digits only".into())
                    }
                },
            )?;
            (
                format!(
                    "https://{}.r2.cloudflarestorage.com",
                    account.to_ascii_lowercase()
                ),
                "auto".to_string(),
            )
        }
        Preset::B2 => {
            let region = text_valid(
                p,
                "Region",
                "B2 → Buckets → your bucket → Endpoint `s3.<region>.backblazeb2.com`: the middle part, e.g. us-west-004",
                None,
                non_empty,
            )?;
            (format!("https://s3.{region}.backblazeb2.com"), region)
        }
        Preset::Aws => {
            let region = text_valid(
                p,
                "Region",
                "the bucket's AWS region (S3 console → Buckets → AWS Region column)",
                Some("us-east-1"),
                non_empty,
            )?;
            (format!("https://s3.{region}.amazonaws.com"), region)
        }
        Preset::Other => {
            let endpoint = text_valid(
                p,
                "Endpoint",
                "the S3 API origin, e.g. https://minio.example.org or http://127.0.0.1:9000",
                None,
                http_url,
            )?;
            let region = text_valid(
                p,
                "Region",
                "MinIO ignores it; other stores document theirs",
                Some("us-east-1"),
                non_empty,
            )?;
            (endpoint.trim_end_matches('/').to_string(), region)
        }
    };
    let bucket = text_valid(
        p,
        "Bucket",
        match preset {
            Preset::R2 => "R2 → Overview: the bucket name (create one with Create bucket)",
            Preset::B2 => "B2 → Buckets: the bucket name (Files in bucket: Public)",
            Preset::Aws => "S3 console → Buckets: the bucket name",
            Preset::Other => "the bucket name (MinIO: `mc mb <alias>/<bucket>`)",
        },
        None,
        non_empty,
    )?;
    let suggested = match preset {
        Preset::R2 => String::new(),
        Preset::B2 | Preset::Other => format!("{endpoint}/{bucket}"),
        Preset::Aws => format!("https://{bucket}.s3.{region}.amazonaws.com"),
    };
    let public_url = text_valid(
        p,
        match preset {
            Preset::R2 => "Public URL (r2.dev or custom domain)",
            _ => "Public URL",
        },
        match preset {
            Preset::R2 => "bucket → Settings → Public access: the R2.dev subdomain (https://pub-….r2.dev) or your custom domain; empty = private",
            Preset::B2 => "a public bucket serves https://s3.<region>.backblazeb2.com/<bucket>; type `none` for a private bucket",
            Preset::Aws => "needs a public-read bucket policy or CloudFront; type `none` for a private bucket",
            Preset::Other => "where anonymous readers GET objects; type `none` for a private bucket",
        },
        Some(&suggested),
        |v| if v == "none" { Ok(()) } else { optional_url(v) },
    )?;
    let access_key_id = text_valid(
        p,
        "Access key id",
        match preset {
            Preset::R2 => "R2 → Manage R2 API Tokens → Create API token (Object Read & Write): \"Access Key ID\"",
            Preset::B2 => "B2 → App Keys → Add a New Application Key: the keyID",
            Preset::Aws => "IAM → Users → Security credentials → Access keys (or env:AWS_ACCESS_KEY_ID)",
            Preset::Other => "the access key (MinIO: a user or service account name)",
        },
        None,
        non_empty,
    )?;
    let env_default = match preset {
        Preset::R2 => "R2_SECRET_ACCESS_KEY",
        Preset::B2 => "B2_SECRET",
        Preset::Aws => "AWS_SECRET_ACCESS_KEY",
        Preset::Other => "S3_SECRET_ACCESS_KEY",
    };
    let secret = secret_ref(
        p,
        "Secret access key",
        name,
        env_default,
        keychain_ok,
        pasted,
    )?;
    args.endpoint = Some(endpoint);
    args.region = Some(region);
    args.bucket = Some(bucket);
    args.virtual_hosted = preset == Preset::Aws;
    args.public_url = some(public_url).filter(|u| u != "none");
    args.access_key_id = Some(access_key_id);
    args.secret_access_key = Some(secret);
    Ok(())
}

fn ipfs(
    p: &mut dyn Prompter,
    name: &str,
    keychain_ok: bool,
    args: &mut StorageAddArgs,
    pasted: &mut Option<Secret>,
) -> Result<()> {
    args.api = Some(text_valid(
        p,
        "kubo RPC API",
        "the node's API address (kubo config Addresses.API)",
        Some("http://127.0.0.1:5001"),
        http_url,
    )?);
    args.gateway = some(text_valid(
        p,
        "Gateway (to verify uploads)",
        "the node's own gateway (kubo config Addresses.Gateway); empty = verify by CID + pin only",
        Some("http://127.0.0.1:8080"),
        optional_url,
    )?);
    args.public_gateway = some(text_valid(
        p,
        "Public gateway",
        "an https gateway that serves this node's content to browsers; empty = none",
        Some(""),
        optional_url,
    )?);
    if args.kind == Some(ProfileKindArg::IpfsPinningService) {
        args.pinning_endpoint = Some(text_valid(
            p,
            "Pinning service endpoint",
            "the service's Pinning Service API base URL (its docs: \"PSA endpoint\")",
            None,
            http_url,
        )?);
        args.pinning_token = Some(secret_ref(
            p,
            "Pinning service access token",
            name,
            "PINNING_TOKEN",
            keychain_ok,
            pasted,
        )?);
    }
    Ok(())
}

/// Ask how a secret is stored; returns its reference. A pasted value goes into `pasted`.
fn secret_ref(
    p: &mut dyn Prompter,
    what: &str,
    profile: &str,
    env_default: &str,
    keychain_ok: bool,
    pasted: &mut Option<Secret>,
) -> Result<String> {
    let keychain_ref = format!("keychain:{}/{profile}", keychain::SERVICE);
    let store = keychain::store_name();
    let paste = format!("paste it now; dg stores it in the {store} (recommended)");
    let mut options = vec![
        "an environment variable (for CI, or a secrets manager)",
        "it is already in the keychain",
    ];
    if keychain_ok {
        options.insert(0, &paste);
    }
    let choice = p.choose(
        &format!("{what} — how do you want to store it?"),
        &options,
        0,
    )?;
    let choice = if keychain_ok { choice } else { choice + 1 };
    Ok(match choice {
        0 => {
            *pasted = Some(p.secret(
                what,
                &format!(
                    "input is hidden; stored as {keychain_ref}, never written to storage.toml"
                ),
            )?);
            keychain_ref
        }
        1 => {
            let var = text_valid(
                p,
                "Variable name",
                "set it in the environment dg and git run in",
                Some(env_default),
                env_name_check,
            )?;
            format!("env:{var}")
        }
        _ => text_valid(
            p,
            "Keychain reference",
            "keychain:<service>/<account> of the existing entry",
            Some(&keychain_ref),
            |v| {
                if !v.starts_with("keychain:") {
                    return Err("starts with keychain:".to_string());
                }
                v.parse::<SecretRef>().map(drop).map_err(|e| e.to_string())
            },
        )?,
    })
}

/// An environment variable NAME (`R2_SECRET_ACCESS_KEY`), not a pasted secret: upper-case
/// letters, digits and `_`, starting with a letter or `_`, at most 64 characters. A value
/// typed here is written to storage.toml and printed, so anything that looks like a key is
/// refused.
fn env_name_check(v: &str) -> std::result::Result<(), String> {
    let ok = !v.is_empty()
        && v.len() <= 64
        && v.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        && !v.as_bytes()[0].is_ascii_digit();
    if ok {
        Ok(())
    } else {
        Err(
            "a variable NAME such as R2_SECRET_ACCESS_KEY (A-Z, 0-9, _), not the secret itself"
                .into(),
        )
    }
}

/// A word for a shell command line: as is when it needs no quoting, else single-quoted.
pub fn shell_word(s: &str) -> String {
    let plain = !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_./:=@,+%".contains(&b));
    if plain {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

/// The `dg storage add …` command that makes the same profile without prompts.
pub fn equivalent_command(a: &StorageAddArgs) -> String {
    let mut words = vec!["dg".to_string(), "storage".into(), "add".into()];
    if let Some(n) = &a.name {
        words.push(shell_word(n));
    }
    let mut flag = |f: &str, v: Option<&String>| {
        if let Some(v) = v {
            words.push(format!("--{f}"));
            words.push(shell_word(v));
        }
    };
    let kind = a.kind.map(|k| {
        clap::ValueEnum::to_possible_value(&k)
            .map(|v| v.get_name().to_string())
            .unwrap_or_default()
    });
    flag("kind", kind.as_ref());
    flag("endpoint", a.endpoint.as_ref());
    flag("region", a.region.as_ref());
    flag("bucket", a.bucket.as_ref());
    flag("public-url", a.public_url.as_ref());
    flag("prefix", a.prefix.as_ref());
    flag("access-key-id", a.access_key_id.as_ref());
    flag("secret-access-key", a.secret_access_key.as_ref());
    flag("session-token", a.session_token.as_ref());
    flag("api", a.api.as_ref());
    flag("gateway", a.gateway.as_ref());
    flag("public-gateway", a.public_gateway.as_ref());
    flag("api-auth", a.api_auth.as_ref());
    flag("pinning-endpoint", a.pinning_endpoint.as_ref());
    flag("pinning-token", a.pinning_token.as_ref());
    let timeout = a.pin_timeout_secs.map(|t| t.to_string());
    flag("pin-timeout-secs", timeout.as_ref());
    if a.virtual_hosted {
        words.push("--virtual-hosted".into());
    }
    if a.allow_private_uri {
        words.push("--allow-private-uri".into());
    }
    words.join(" ")
}

/// What [`run`] set up.
pub struct Added {
    /// The profile name.
    pub name: String,
    /// Whether a check other than browser CORS failed (the storage cannot take a push yet).
    pub broken: bool,
}

/// Run the prompts, store a pasted secret, save the profile and test it.
pub async fn run(p: &mut dyn Prompter) -> Result<Added> {
    let path = StorageProfiles::default_path()?;
    let existing: Vec<String> = StorageProfiles::load_from(&path)?
        .profiles
        .into_keys()
        .collect();
    let Answers { args, pasted } = collect(p, &existing, keychain::available())?;
    let name = args.name.clone().unwrap_or_default();
    // Validate before anything is written, so a refused profile leaves no keychain entry.
    crate::storage::profile_from_args(&args)?;
    if let Some(secret) = &pasted {
        keychain::set(keychain::SERVICE, &name, secret.expose()).map_err(|e| {
            UserError::new(codes::STORAGE_SECRET, "storage profile not added: the secret could not be stored")
                .cause(e.to_string())
                .fix("run `dg storage add` again and choose an environment variable, or store the secret yourself and choose \"it is already in the keychain\"")
                .note("nothing was saved")
        })?;
    }
    let (profile, path, _) = crate::storage::save_profile(&name, &args)?;

    println!("Testing {name} …");
    let report = crate::storage::run_checks(&profile, true).await;
    for fix in &report.fixes {
        println!("  → {}", fix.replace('\n', "\n    "));
        println!("    then run `dg storage test {name}`");
    }
    let failed = report.failed();
    let broken = failed.iter().any(|f| *f != "browser CORS");
    if failed.contains(&"browser CORS") {
        println!("  note: git push and clone work without CORS; the web app cannot read this storage until it passes");
    }
    if broken {
        println!("  note: saved anyway; fix the failing rows, then run `dg storage test {name}` before pushing");
    }
    let stored = pasted
        .as_ref()
        .map(|_| format!(" (secret stored as keychain:{}/{name})", keychain::SERVICE))
        .unwrap_or_default();
    println!("Saved {}{stored}", tilde(&path));
    println!("Equivalent: {}", equivalent_command(&args));
    println!("Use it in a repo: dg storage use {name}");

    if !profile.is_platform() && !broken && !global_storage_set() {
        // The profile is saved already: Ctrl-D here means "no", not a failed command.
        let yes = p
            .confirm(
                &format!("Make {name} the default storage for new repos (and any repo without its own dash.storage)?"),
                true,
            )
            .unwrap_or(false);
        if yes {
            crate::storage::git_config(true, &["dash.storage", &name])?;
            println!("Default storage: {name} (equivalent: dg storage use {name} --global)");
        }
    }
    Ok(Added { name, broken })
}

/// Whether the user's global git config sets `dash.storage` (the default for new repos).
fn global_storage_set() -> bool {
    std::process::Command::new("git")
        .args(["config", "--global", "--get", "dash.storage"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .is_ok_and(|o| o.status.success() && !o.stdout.trim_ascii().is_empty())
}

/// `path` with the home directory shown as `~`.
fn tilde(path: &Path) -> String {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    match home.as_deref().and_then(|h| path.strip_prefix(h).ok()) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompt::Scripted;

    fn run_script(answers: &[&str], keychain_ok: bool) -> Answers {
        collect(
            &mut Scripted::new(answers),
            &["taken".to_string()],
            keychain_ok,
        )
        .unwrap()
    }

    #[test]
    fn r2_answers_map_to_the_flags_and_a_pasted_keychain_secret() {
        let a = run_script(
            &[
                "r2-main", // name
                "1",       // S3
                "1",       // R2
                "7C1ABC",  // account id
                "forge",   // bucket
                "https://pub-9a1.r2.dev",
                "AKID",   // access key id
                "1",      // paste for the keychain
                "s3cr3t", // the secret
            ],
            true,
        );
        assert_eq!(a.pasted.as_ref().map(Secret::expose), Some("s3cr3t"));
        let args = &a.args;
        assert_eq!(
            args.endpoint.as_deref(),
            Some("https://7c1abc.r2.cloudflarestorage.com")
        );
        assert_eq!(args.region.as_deref(), Some("auto"));
        assert!(!args.virtual_hosted, "R2 is path-style");
        assert_eq!(
            args.secret_access_key.as_deref(),
            Some("keychain:dash-forge/r2-main")
        );
        let cmd = equivalent_command(args);
        assert_eq!(
            cmd,
            "dg storage add r2-main --kind s3 --endpoint https://7c1abc.r2.cloudflarestorage.com \
             --region auto --bucket forge --public-url https://pub-9a1.r2.dev --access-key-id AKID \
             --secret-access-key keychain:dash-forge/r2-main"
        );
        assert!(
            !cmd.contains("s3cr3t"),
            "the secret is never in the command"
        );
        // The printed command parses back to exactly these flags.
        let words: Vec<&str> = cmd.split(' ').skip(3).collect();
        assert_eq!(&crate::storage::tests::add_args(&words), args);
        assert!(crate::storage::profile_from_args(args).is_ok());
    }

    #[test]
    fn minio_with_an_env_secret_and_defaults() {
        let a = run_script(
            &[
                "taken", // exists …
                "n",     // … keep it
                "minio",
                "1", // S3
                "4", // other
                "http://127.0.0.1:9000/",
                "", // region default
                "forge-byo",
                "", // public URL default: endpoint/bucket
                "minioadmin",
                "2", // env var
                "FORGE_E2E_MINIO_SECRET",
            ],
            true,
        );
        assert!(a.pasted.is_none());
        let args = &a.args;
        assert_eq!(args.name.as_deref(), Some("minio"));
        assert_eq!(args.endpoint.as_deref(), Some("http://127.0.0.1:9000"));
        assert_eq!(args.region.as_deref(), Some("us-east-1"));
        assert_eq!(
            args.public_url.as_deref(),
            Some("http://127.0.0.1:9000/forge-byo")
        );
        assert_eq!(
            args.secret_access_key.as_deref(),
            Some("env:FORGE_E2E_MINIO_SECRET")
        );
        assert!(crate::storage::profile_from_args(args).is_ok());
    }

    #[test]
    fn aws_is_virtual_hosted_and_none_means_private() {
        let a = run_script(
            &[
                "aws",
                "1",
                "3",
                "eu-west-1",
                "my-packs",
                "none",
                "AKID",
                "2",
                "",
            ],
            true,
        );
        assert!(a.args.virtual_hosted);
        assert_eq!(
            a.args.endpoint.as_deref(),
            Some("https://s3.eu-west-1.amazonaws.com")
        );
        assert_eq!(a.args.public_url, None);
        assert_eq!(
            a.args.secret_access_key.as_deref(),
            Some("env:AWS_SECRET_ACCESS_KEY")
        );
        assert!(equivalent_command(&a.args).ends_with("--virtual-hosted"));
    }

    #[test]
    fn without_a_keychain_pasting_is_not_offered() {
        // Option 1 is now the env var.
        let a = run_script(
            &[
                "b2",
                "1",
                "2",
                "us-west-004",
                "bkt",
                "",
                "KEYID",
                "1",
                "B2_SECRET",
            ],
            false,
        );
        assert_eq!(a.args.secret_access_key.as_deref(), Some("env:B2_SECRET"));
        assert_eq!(
            a.args.endpoint.as_deref(),
            Some("https://s3.us-west-004.backblazeb2.com")
        );
        assert_eq!(
            a.args.public_url.as_deref(),
            Some("https://s3.us-west-004.backblazeb2.com/bkt")
        );
    }

    #[test]
    fn invalid_answers_are_asked_again() {
        let mut p = Scripted::new(&["platform", "bad name", "k", "2", "not a url", "", "", ""]);
        let a = collect(&mut p, &[], true).unwrap();
        assert_eq!(a.args.name.as_deref(), Some("k"));
        assert_eq!(a.args.kind, Some(ProfileKindArg::IpfsKubo));
        assert_eq!(a.args.api.as_deref(), Some("http://127.0.0.1:5001"));
        assert_eq!(a.args.gateway.as_deref(), Some("http://127.0.0.1:8080"));
        assert_eq!(a.args.public_gateway, None);
        assert_eq!(p.asked.iter().filter(|q| *q == "Profile name").count(), 3);
        assert_eq!(
            equivalent_command(&a.args),
            "dg storage add k --kind ipfs-kubo --api http://127.0.0.1:5001 --gateway http://127.0.0.1:8080"
        );
    }

    #[test]
    fn platform_and_pinning_profiles() {
        let a = run_script(&["chain", "4"], true);
        assert_eq!(
            equivalent_command(&a.args),
            "dg storage add chain --kind platform"
        );
        let a = run_script(
            &[
                "pins",
                "3",
                "",
                "",
                "",
                "https://pins.example/psa",
                "1",
                "tok",
            ],
            true,
        );
        assert_eq!(
            a.args.pinning_token.as_deref(),
            Some("keychain:dash-forge/pins")
        );
        assert_eq!(a.pasted.as_ref().map(Secret::expose), Some("tok"));
        assert!(crate::storage::profile_from_args(&a.args).is_ok());
    }

    #[test]
    fn a_pasted_secret_is_not_taken_as_a_variable_name() {
        assert!(env_name_check("R2_SECRET_ACCESS_KEY").is_ok());
        assert!(env_name_check("_X1").is_ok());
        for bad in [
            "",
            "1ABC",
            "lower",
            "A-B",
            &"A".repeat(65),
            "wJalrXUtnFEMIK7MDENG",
        ] {
            // (the last is mixed case, like an AWS secret)
            assert!(env_name_check(bad).is_err(), "{bad:?}");
        }
        // The prompt asks again until it gets a name.
        let a = run_script(
            &[
                "b",
                "1",
                "4",
                "http://h",
                "",
                "bk",
                "",
                "AK",
                "2",
                "s3cr3tValue",
                "",
            ],
            true,
        );
        assert_eq!(
            a.args.secret_access_key.as_deref(),
            Some("env:S3_SECRET_ACCESS_KEY")
        );
    }

    #[test]
    fn shell_words_are_quoted_only_when_needed() {
        assert_eq!(shell_word("https://a.b/c?d"), "'https://a.b/c?d'");
        assert_eq!(shell_word("keychain:dash-forge/x"), "keychain:dash-forge/x");
        assert_eq!(shell_word("it's"), r"'it'\''s'");
        assert_eq!(shell_word(""), "''");
    }
}
