//! The OS credential store: macOS Keychain, Windows Credential Manager, or the freedesktop
//! Secret Service, through the `keyring` crate.
//!
//! Entries are addressed by `(service, account)`, the same pair a `keychain:<service>/<account>`
//! reference names ([`crate::storage::SecretRef`]). Dash Forge uses service [`SERVICE`] for
//! everything it writes: storage secrets under the profile name, identity keys under
//! `<network>/<identityId>`.
//!
//! Reads fall back to the platform's command-line tool (`security` on macOS, `secret-tool`
//! elsewhere), so entries a user created by hand before `dg` wrote them itself keep resolving.
//! A machine without a credential store (headless Linux, a container) reports
//! [`available`]` == false`; callers then use a passphrase-encrypted file instead.
//!
//! [`DISABLE_ENV`] stops Dash Forge from *choosing* the keychain ([`available`] is false and
//! [`set`] refuses); an explicit `keychain:` reference the user wrote is still read.
//!
//! macOS grants a keychain item to the program that created it. Another program reading it
//! (`git-remote-dash` reading what `dg` stored, or `security` in the fallback) makes macOS
//! ask once whether to allow it ("Always Allow" remembers the answer; a rebuilt or
//! reinstalled binary may ask again). Over SSH there is no one to ask, so the read fails:
//! use an `env:` reference there.

use crate::error::{Error, Result};
use crate::keystore::Secret;

/// The service name every Dash Forge entry is stored under.
pub const SERVICE: &str = "dash-forge";

/// Environment switch that makes [`available`] report `false` (tests, CI, and users who want
/// the encrypted file even where a keychain exists).
pub const DISABLE_ENV: &str = "DASH_FORGE_NO_KEYCHAIN";

fn disabled() -> bool {
    std::env::var_os(DISABLE_ENV).is_some_and(|v| !v.is_empty() && v != "0")
}

/// Whether an OS credential store can be used on this machine.
pub fn available() -> bool {
    available_unless(disabled())
}

fn available_unless(disabled: bool) -> bool {
    !disabled && keyring::Entry::store_status().is_ok()
}

/// Where secrets go on this machine, for messages ("macOS Keychain").
pub fn store_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS Keychain"
    } else if cfg!(windows) {
        "Windows Credential Manager"
    } else {
        "Secret Service keyring"
    }
}

fn entry(service: &str, account: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(service, account).map_err(|e| {
        Error::Config(format!(
            "the OS keychain is not available ({}): {e}",
            store_name()
        ))
    })
}

/// Store `secret` under `(service, account)`, replacing any previous value.
pub fn set(service: &str, account: &str, secret: &str) -> Result<()> {
    set_unless(disabled(), service, account, secret)
}

fn set_unless(disabled: bool, service: &str, account: &str, secret: &str) -> Result<()> {
    if disabled {
        return Err(Error::Config(format!(
            "the OS keychain is disabled ({DISABLE_ENV} is set)"
        )));
    }
    entry(service, account)?.set_password(secret).map_err(|e| {
        Error::Config(format!(
            "could not write keychain entry {service}/{account}: {e}"
        ))
    })
}

/// The secret under `(service, account)`, or `None` when there is no such entry. Reads
/// happen even with [`DISABLE_ENV`] set: the caller named this entry explicitly.
pub fn get(service: &str, account: &str) -> Result<Option<Secret>> {
    if let Ok(e) = keyring::Entry::new(service, account) {
        match e.get_password() {
            Ok(v) if !v.is_empty() => return Ok(Some(Secret::new(v))),
            Ok(_) | Err(keyring::Error::NoEntry) => {}
            Err(err) => {
                // A locked or refused store: try the CLI tool before giving up.
                if let Some(v) = cli_lookup(service, account) {
                    return Ok(Some(Secret::new(v)));
                }
                return Err(Error::Config(format!(
                    "could not read keychain entry {service}/{account}: {err}"
                )));
            }
        }
    }
    Ok(cli_lookup(service, account).map(Secret::new))
}

/// Delete the entry under `(service, account)`. `Ok(false)` when there was none.
pub fn delete(service: &str, account: &str) -> Result<bool> {
    match entry(service, account)?.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(Error::Config(format!(
            "could not delete keychain entry {service}/{account}: {e}"
        ))),
    }
}

/// Look an entry up with the platform's command-line tool (entries created by hand with
/// `security add-generic-password` or `secret-tool store`). `None` when absent or unreadable.
fn cli_lookup(service: &str, account: &str) -> Option<String> {
    use std::process::{Command, Stdio};
    if cfg!(windows) {
        return None;
    }
    let output = if cfg!(target_os = "macos") {
        Command::new("security")
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
    } else {
        Command::new("secret-tool")
            .args(["lookup", "service", service, "account", account])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
    }
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout)
        .ok()?
        .trim_end_matches(['\r', '\n'])
        .to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    // The switch is passed in rather than set in the process environment, which other
    // tests running in parallel would see.
    #[test]
    fn a_disabled_keychain_is_unavailable_and_refuses_writes() {
        assert!(!super::available_unless(true));
        let err = super::set_unless(true, super::SERVICE, "test/none", "x").unwrap_err();
        assert!(err.to_string().contains(super::DISABLE_ENV));
    }
}
