//! Install only the pinned, checksum-verified kubo executable.
use std::io::{Read, Write};
use std::path::Path;

use anyhow::Result;
use futures::StreamExt as _;
use sha2::{Digest, Sha512};

use super::{config, node_error, Node, KUBO_VERSION};

fn archive_target(os: &str, arch: &str) -> Result<(&'static str, &'static str)> {
    match (os, arch) {
        ("macos", "aarch64") => Ok(("darwin-arm64.tar.gz", "bc282d781d856736051ce6d216ba47d52bec703f1a54ab5fa20fba26a92e4af3e8fb131e220cdf01f20205f1effb1a5b7bedbdeff15e8edbbe8e5b01923a7cbb")),
        ("macos", "x86_64") => Ok(("darwin-amd64.tar.gz", "efe0c1561595fbf7b5bdc3fc651863697c2bf388eed5f8c94c163f60d9575201808538abba84f652718f015ad1af6e3c01ced1321ddb2082f934ba8952e4a4ab")),
        ("linux", "x86_64") => Ok(("linux-amd64.tar.gz", "ff53b2428794fc8cca39505d28c15b4cceaef4b90a09284f291f611fcdc8c06399690575fc89cbd4d85ef71f3652581296c6f2e710386f887c8edf36b6e89d71")),
        ("linux", "aarch64") => Ok(("linux-arm64.tar.gz", "70f082584651ef78fb5b07448be53bb0adf141aadcb7eea15ffa59bd9ca78fed46781c2cf5915b3528c591052f97486067fedb0a7a1415abd5bfd44942921501")),
        ("windows", "x86_64") => Ok(("windows-amd64.zip", "e611cecef25cddb10b7f907145383608d9b31219ad7120041aeacfe2313882da1944f2897fda29bc2d959dd357e4950089ec8f2cbd52b29f2fc472bcae4356d0")),
        _ => Err(node_error("no pinned kubo archive is available for this platform", "use macOS or Linux on arm64/amd64, or Windows on amd64")),
    }
}

async fn correct_version(path: &Path) -> bool {
    tokio::process::Command::new(path).args(["version", "--number"]).output().await
        .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == KUBO_VERSION)
}

fn verify(path: &Path, expected: &str) -> Result<()> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha512::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 { break; }
        hash.update(&buffer[..n]);
    }
    if hex::encode(hash.finalize()) != expected {
        return Err(node_error("kubo archive checksum mismatch; nothing was installed", "remove the local archive override or obtain the official v0.43.1 archive"));
    }
    Ok(())
}

pub async fn install(node: &Node) -> Result<()> {
    if std::env::var_os("DASH_FORGE_KUBO_BIN").is_some() {
        if correct_version(&node.binary()).await { return Ok(()); }
        return Err(node_error("DASH_FORGE_KUBO_BIN does not report kubo 0.43.1", "point it at an executable kubo 0.43.1 binary"));
    }
    let (target, sha) = archive_target(std::env::consts::OS, std::env::consts::ARCH)?;
    if correct_version(&node.binary()).await { return Ok(()); }
    config::private_dir(&node.dir)?;
    let mut download = tempfile::NamedTempFile::new_in(&node.dir)?;
    let local = std::env::var_os("DASH_FORGE_KUBO_ARCHIVE");
    if let Some(path) = &local {
        std::io::copy(&mut std::fs::File::open(path)?, &mut download)?;
    } else {
        let url = format!("https://github.com/ipfs/kubo/releases/download/v{KUBO_VERSION}/kubo_v{KUBO_VERSION}_{target}");
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(300)).build()?;
        let mut stream = client.get(url).send().await?.error_for_status()?.bytes_stream();
        while let Some(chunk) = stream.next().await { download.write_all(&chunk?)?; }
    }
    download.flush()?;
    // Explicit test hook for synthetic offline archives. Both switches and a local archive
    // are required; normal downloads can never bypass the compiled-in checksum.
    let skip = std::env::var("DASH_FORGE_KUBO_SKIP_SHA").is_ok_and(|s| s == "1");
    let test_hook = cfg!(test) || std::env::var("DASH_FORGE_KUBO_TEST_HOOKS").is_ok_and(|s| s == "1");
    if skip && !(test_hook && local.is_some()) {
        return Err(node_error("checksum bypass is a local-archive test hook only", "unset DASH_FORGE_KUBO_SKIP_SHA"));
    }
    if !skip { verify(download.path(), sha)?; }
    let unpack = tempfile::tempdir_in(&node.dir)?;
    let executable = if cfg!(windows) { "kubo/ipfs.exe" } else { "kubo/ipfs" };
    let result = tokio::process::Command::new("tar")
        .arg(if target.ends_with(".zip") { "-xf" } else { "-xzf" })
        .arg(download.path()).arg("-C").arg(unpack.path()).arg(executable).output().await?;
    if !result.status.success() { return Err(node_error("could not unpack kubo", "install the system tar command and retry")); }
    let extracted = unpack.path().join(executable);
    if !correct_version(&extracted).await { return Err(node_error("the archive does not contain kubo 0.43.1", "use the official pinned archive")); }
    let bin = node.dir.join("bin"); config::private_dir(&bin)?;
    let mut staged = tempfile::NamedTempFile::new_in(&bin)?;
    std::io::copy(&mut std::fs::File::open(extracted)?, &mut staged)?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt as _; staged.as_file().set_permissions(std::fs::Permissions::from_mode(0o755))?; }
    staged.as_file().sync_all()?;
    staged.persist(node.binary()).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_supported_archive_has_a_full_sha512() {
        for (os, arch) in [("macos", "aarch64"), ("macos", "x86_64"), ("linux", "aarch64"), ("linux", "x86_64"), ("windows", "x86_64")] {
            let (_, sha) = archive_target(os, arch).unwrap(); assert_eq!(hex::decode(sha).unwrap().len(), 64);
        }
        assert!(archive_target("windows", "aarch64").is_err());
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(verify(file.path(), &"0".repeat(128)).is_err());
    }
}
