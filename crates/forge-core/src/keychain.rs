//! The OS credential store: the macOS login keychain, the Windows Credential Manager, or the
//! freedesktop Secret Service.
//!
//! Entries are addressed by `(service, account)`, the same pair a `keychain:<service>/<account>`
//! reference names ([`crate::storage::SecretRef`]). Dash Forge uses service [`SERVICE`] for
//! everything it writes: storage secrets under the profile name, identity keys under
//! `<network>/<identityId>`.
//!
//! **macOS** goes through `/usr/bin/security` for every read, write and delete (the secret
//! travels over its stdin and stdout, never a command line). macOS grants a keychain item to
//! the program that created it, and a Rust binary's identity changes with every build and
//! upgrade; `security` is the same Apple-signed program every time, so `dg`, `git-remote-dash`
//! and the importer all read what any of them stored without a dialog, across upgrades. The
//! trade-off is the one the GitHub CLI makes: any program running as you can ask `security`
//! for the entry. Forge keeps only limited keys there (a budget, an expiry, the forge
//! contracts only), and the keychain still protects them at rest and from other users.
//!
//! **Elsewhere** it uses the `keyring` crate (Secret Service over D-Bus, Credential Manager),
//! with `secret-tool` as a read fallback for entries created by hand. A machine without a
//! credential store (headless Linux, a container) reports [`available`]` == false`; callers
//! then use a passphrase-encrypted file instead.
//!
//! [`DISABLE_ENV`] stops Dash Forge from *choosing* the keychain ([`available`] is false and
//! [`set`] refuses); an explicit `keychain:` reference the user wrote is still read.

use crate::error::{Error, Result};
use crate::keystore::Secret;

/// The service name every Dash Forge entry is stored under.
pub const SERVICE: &str = "dash-forge";

/// Environment switch that makes [`available`] report `false` (tests, CI, and users who want
/// the encrypted file even where a keychain exists).
pub const DISABLE_ENV: &str = "DASH_FORGE_NO_KEYCHAIN";

/// How long a keychain read may wait for the user to answer an access dialog (an entry
/// created by another program) before it gives up.
pub const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

fn disabled() -> bool {
    std::env::var_os(DISABLE_ENV).is_some_and(|v| !v.is_empty() && v != "0")
}

/// Whether an OS credential store can be used on this machine.
pub fn available() -> bool {
    available_unless(disabled())
}

fn available_unless(disabled: bool) -> bool {
    !disabled && platform::available()
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
    platform::set(service, account, secret).map_err(|why| {
        Error::Config(format!(
            "could not write keychain entry {service}/{account}: {why}"
        ))
    })
}

/// The secret under `(service, account)`, or `None` when there is no such entry. Reads
/// happen even with [`DISABLE_ENV`] set: the caller named this entry explicitly.
///
/// A read of an entry another program created can wait on an access dialog: after a few
/// seconds a line on stderr says so, and after [`READ_TIMEOUT`] the read fails instead of
/// hanging the command (a `git push` waiting on a dialog nobody sees).
pub fn get(service: &str, account: &str) -> Result<Option<Secret>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let (svc, acct) = (service.to_string(), account.to_string());
    std::thread::spawn(move || {
        let _ = tx.send(platform::get(&svc, &acct));
    });
    let notice = std::time::Duration::from_secs(4);
    let answer = match rx.recv_timeout(notice) {
        Ok(r) => Some(r),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            eprintln!(
                "waiting for the {}: allow access to {service}/{account} in the dialog it shows",
                store_name()
            );
            rx.recv_timeout(READ_TIMEOUT.saturating_sub(notice)).ok()
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => None,
    };
    match answer {
        Some(Ok(v)) => Ok(v.map(|z| Secret::new(z.as_str()))),
        Some(Err(why)) => Err(Error::Config(format!(
            "could not read keychain entry {service}/{account}: {why}"
        ))),
        None => Err(Error::Config(format!(
            "could not read keychain entry {service}/{account}: no answer to the {} access \
             dialog within {} s (over SSH there is no dialog: use an env: reference or a key \
             file there)",
            store_name(),
            READ_TIMEOUT.as_secs()
        ))),
    }
}

/// Delete the entry under `(service, account)`. `Ok(false)` when there was none.
pub fn delete(service: &str, account: &str) -> Result<bool> {
    platform::delete(service, account).map_err(|why| {
        Error::Config(format!(
            "could not delete keychain entry {service}/{account}: {why}"
        ))
    })
}

/// macOS: every operation through `/usr/bin/security` (see the module docs).
#[cfg(target_os = "macos")]
mod platform {
    use std::io::Write as _;
    use std::process::{Command, Output, Stdio};

    const SECURITY: &str = "/usr/bin/security";
    /// `security` exits 44 when the item is not found.
    const NOT_FOUND: i32 = 44;
    /// `security -i` reads each command into a fixed-size line buffer; stay well under it.
    const MAX_COMMAND: usize = 3_800;

    fn run(args: &[&str]) -> std::io::Result<Output> {
        Command::new(SECURITY)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
    }

    pub(super) fn available() -> bool {
        run(&["default-keychain"]).is_ok_and(|o| o.status.success())
    }

    /// Quote `s` for a `security -i` command line.
    pub(super) fn quote(s: &str) -> String {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }

    pub(super) fn set(service: &str, account: &str, secret: &str) -> Result<(), String> {
        if [service, account, secret]
            .iter()
            .any(|v| v.contains(['\n', '\r', '\0']))
        {
            return Err("a line break or NUL in the value".into());
        }
        // Delete then add: an update would keep an existing item's access list (an entry an
        // older version wrote straight through the Security framework).
        let delete = format!(
            "delete-generic-password -s {} -a {}\n",
            quote(service),
            quote(account)
        );
        let add = zeroize::Zeroizing::new(format!(
            "add-generic-password -s {} -a {} -l {} -w {}\n",
            quote(service),
            quote(account),
            quote(&format!("{service} ({account})")),
            quote(secret)
        ));
        if add.len() > MAX_COMMAND {
            return Err(format!("the value is longer than {MAX_COMMAND} bytes"));
        }
        let mut child = Command::new(SECURITY)
            .arg("-i")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            // Its error messages echo the command line, secret included: never show them.
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not run {SECURITY}: {e}"))?;
        {
            let mut stdin = child.stdin.take().ok_or("no stdin")?;
            stdin
                .write_all(delete.as_bytes())
                .and_then(|()| stdin.write_all(add.as_bytes()))
                .map_err(|e| format!("writing to {SECURITY}: {e}"))?;
        }
        child
            .wait()
            .map_err(|e| format!("waiting for {SECURITY}: {e}"))?;
        // `security -i` exits 0 even when a command inside it fails: read the item back.
        match get(service, account) {
            Ok(Some(v)) if *v == *secret => Ok(()),
            Ok(_) => Err("the keychain did not keep the value".into()),
            Err(e) => Err(e),
        }
    }

    pub(super) fn get(
        service: &str,
        account: &str,
    ) -> Result<Option<zeroize::Zeroizing<String>>, String> {
        let out = run(&["find-generic-password", "-s", service, "-a", account, "-w"])
            .map_err(|e| format!("could not run {SECURITY}: {e}"))?;
        let stdout = zeroize::Zeroizing::new(out.stdout);
        match out.status.code() {
            Some(0) => {
                let text = std::str::from_utf8(&stdout)
                    .map_err(|_| "the entry is not text".to_string())?
                    .trim_end_matches(['\r', '\n']);
                Ok((!text.is_empty()).then(|| zeroize::Zeroizing::new(text.to_string())))
            }
            Some(NOT_FOUND) => Ok(None),
            Some(code) => Err(format!(
                "{SECURITY} refused (exit {code}; access denied, or the keychain is locked)"
            )),
            None => Err(format!("{SECURITY} was interrupted")),
        }
    }

    pub(super) fn delete(service: &str, account: &str) -> Result<bool, String> {
        let out = run(&["delete-generic-password", "-s", service, "-a", account])
            .map_err(|e| format!("could not run {SECURITY}: {e}"))?;
        match out.status.code() {
            Some(0) => Ok(true),
            Some(NOT_FOUND) => Ok(false),
            Some(code) => Err(format!("{SECURITY} refused (exit {code})")),
            None => Err(format!("{SECURITY} was interrupted")),
        }
    }
}

/// Linux / BSD / Windows: the `keyring` crate, with `secret-tool` as a read fallback.
#[cfg(not(target_os = "macos"))]
mod platform {
    pub(super) fn available() -> bool {
        keyring::Entry::store_status().is_ok()
    }

    fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(service, account)
            .map_err(|e| format!("the credential store is not available: {e}"))
    }

    pub(super) fn set(service: &str, account: &str, secret: &str) -> Result<(), String> {
        entry(service, account)?
            .set_password(secret)
            .map_err(|e| e.to_string())
    }

    pub(super) fn get(
        service: &str,
        account: &str,
    ) -> Result<Option<zeroize::Zeroizing<String>>, String> {
        if let Ok(e) = entry(service, account) {
            match e.get_password() {
                Ok(v) if !v.is_empty() => return Ok(Some(zeroize::Zeroizing::new(v))),
                Ok(_) | Err(keyring::Error::NoEntry) => {}
                Err(err) => return Err(err.to_string()),
            }
        }
        Ok(secret_tool_lookup(service, account))
    }

    pub(super) fn delete(service: &str, account: &str) -> Result<bool, String> {
        match entry(service, account)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    }

    /// An entry created by hand with `secret-tool store … service S account A`.
    fn secret_tool_lookup(service: &str, account: &str) -> Option<zeroize::Zeroizing<String>> {
        use std::process::{Command, Stdio};
        if cfg!(windows) {
            return None;
        }
        let out = Command::new("secret-tool")
            .args(["lookup", "service", service, "account", account])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let stdout = zeroize::Zeroizing::new(out.stdout);
        if !out.status.success() {
            return None;
        }
        let text = std::str::from_utf8(&stdout)
            .ok()?
            .trim_end_matches(['\r', '\n']);
        (!text.is_empty()).then(|| zeroize::Zeroizing::new(text.to_string()))
    }
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

    #[cfg(target_os = "macos")]
    #[test]
    fn security_quoting_escapes_backslashes_and_quotes() {
        assert_eq!(super::platform::quote(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(super::platform::quote("plain"), "\"plain\"");
    }
}
