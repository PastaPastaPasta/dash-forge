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
//! and the importer all read what any of them stored without a dialog, across upgrades.
//!
//! The trade-off, the same one the GitHub CLI makes: the item's access list trusts
//! `/usr/bin/security`, so **any program running as you can read it without a prompt**. The
//! keychain still protects it at rest and from other users. What Dash Forge puts there:
//! limited identity keys (a budget, an expiry, the forge contracts only) and the storage
//! credentials `dg storage add` is given (S3 secret keys, pinning tokens). Master keys and
//! recovery words never go there: `dg auth login --full-key` always uses a passphrase-sealed
//! file. Treat a storage credential kept here like one in an `env:` variable: scope it to the
//! one bucket.
//!
//! Values are written as `b64:<base64>` so any text round-trips (`security -w` prints a value
//! with a tab or non-ASCII bytes as hex, which a reader cannot tell from a literal); entries
//! written by hand or by older versions are read literally, their hex form recognized with
//! `security -g`.
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
/// seconds a line on stderr says so, and after [`READ_TIMEOUT`] the read fails (on macOS the
/// `security` process is killed) instead of hanging the command. It blocks: call it from
/// async code through `spawn_blocking`, or accept blocking one worker for that long.
pub fn get(service: &str, account: &str) -> Result<Option<Secret>> {
    platform::get(service, account)
        .map(|v| v.map(|z| Secret::new(z.as_str())))
        .map_err(|why| {
            Error::Config(format!(
                "could not read keychain entry {service}/{account}: {why}"
            ))
        })
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
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const SECURITY: &str = "/usr/bin/security";
    /// `security` exits 44 when the item is not found.
    const NOT_FOUND: i32 = 44;
    /// `security -i` reads each command into a fixed-size line buffer; stay well under it.
    const MAX_COMMAND: usize = 3_800;
    /// The prefix of values dg writes.
    const B64: &str = "b64:";

    /// Run `security` with `args`, killing it after `deadline` (an access dialog nobody
    /// answers). Returns (exit code, stdout, stderr).
    /// Exit code, stdout and stderr of one `security` run.
    type Output = (
        Option<i32>,
        zeroize::Zeroizing<Vec<u8>>,
        zeroize::Zeroizing<Vec<u8>>,
    );

    fn run(args: &[&str], deadline: Duration) -> Result<Output, String> {
        let mut child = Command::new(SECURITY)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not run {SECURITY}: {e}"))?;
        let start = Instant::now();
        let mut noticed = false;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(e) => return Err(format!("waiting for {SECURITY}: {e}")),
            }
            if !noticed && start.elapsed() > Duration::from_secs(4) {
                eprintln!("waiting for the macOS Keychain: allow access in the dialog it shows");
                noticed = true;
            }
            if start.elapsed() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "no answer to the macOS Keychain access dialog within {} s (over SSH there \
                     is no dialog: use an env: reference or a key file there)",
                    deadline.as_secs()
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let out = child
            .wait_with_output()
            .map_err(|e| format!("reading {SECURITY}: {e}"))?;
        Ok((
            out.status.code(),
            zeroize::Zeroizing::new(out.stdout),
            zeroize::Zeroizing::new(out.stderr),
        ))
    }

    pub(super) fn available() -> bool {
        run(&["default-keychain"], Duration::from_secs(10)).is_ok_and(|(c, _, _)| c == Some(0))
    }

    /// Quote `s` for a `security -i` command line.
    pub(super) fn quote(s: &str) -> String {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }

    pub(super) fn set(service: &str, account: &str, secret: &str) -> Result<(), String> {
        use base64::Engine as _;
        if [service, account]
            .iter()
            .any(|v| v.contains(['\n', '\r', '\0']))
        {
            return Err("a line break or NUL in the service or account".into());
        }
        let encoded = zeroize::Zeroizing::new(format!(
            "{B64}{}",
            base64::engine::general_purpose::STANDARD.encode(secret.as_bytes())
        ));
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
            quote(&encoded)
        ));
        if add.len() > MAX_COMMAND {
            return Err(format!(
                "the value is longer than the keychain command allows ({MAX_COMMAND} bytes)"
            ));
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
        // `-g` prints the value on stderr as `password: "…"` or, for bytes that are not
        // plain printable ASCII, `password: 0x<HEX>  "…"`, so the two cannot be confused.
        let (code, _, stderr) = run(
            &["find-generic-password", "-s", service, "-a", account, "-g"],
            super::READ_TIMEOUT,
        )?;
        match code {
            Some(0) => {}
            Some(NOT_FOUND) => return Ok(None),
            Some(c) => {
                return Err(format!(
                    "{SECURITY} refused (exit {c}; access denied, or the keychain is locked)"
                ))
            }
            None => return Err(format!("{SECURITY} was interrupted")),
        }
        let text =
            std::str::from_utf8(&stderr).map_err(|_| "unreadable keychain output".to_string())?;
        let value = parse_g(text).ok_or("unreadable keychain output")?;
        decode(&value).map(|v| (!v.is_empty()).then_some(v))
    }

    /// The raw value from `security … -g` output (stderr).
    pub(super) fn parse_g(stderr: &str) -> Option<zeroize::Zeroizing<Vec<u8>>> {
        let line = stderr.lines().find_map(|l| l.strip_prefix("password: "))?;
        if let Some(rest) = line.strip_prefix("0x") {
            let hex_part = rest.split_whitespace().next().unwrap_or_default();
            return hex::decode(hex_part).ok().map(zeroize::Zeroizing::new);
        }
        let inner = line.strip_prefix('"')?.strip_suffix('"')?;
        Some(zeroize::Zeroizing::new(inner.as_bytes().to_vec()))
    }

    /// A stored value: `b64:` decoded, anything else taken as it is.
    pub(super) fn decode(raw: &[u8]) -> Result<zeroize::Zeroizing<String>, String> {
        use base64::Engine as _;
        let bytes = match raw.strip_prefix(B64.as_bytes()) {
            Some(b) => zeroize::Zeroizing::new(
                base64::engine::general_purpose::STANDARD
                    .decode(b)
                    .map_err(|_| "a malformed b64: keychain value".to_string())?,
            ),
            None => zeroize::Zeroizing::new(raw.to_vec()),
        };
        String::from_utf8(bytes.to_vec())
            .map(zeroize::Zeroizing::new)
            .map_err(|_| "the keychain value is not text".to_string())
    }

    pub(super) fn delete(service: &str, account: &str) -> Result<bool, String> {
        let (code, _, _) = run(
            &["delete-generic-password", "-s", service, "-a", account],
            super::READ_TIMEOUT,
        )?;
        match code {
            Some(0) => Ok(true),
            Some(NOT_FOUND) => Ok(false),
            Some(c) => Err(format!("{SECURITY} refused (exit {c})")),
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
            .map_err(|e| e.to_string())?;
        match get(service, account)? {
            Some(v) if *v == *secret => Ok(()),
            _ => Err("the credential store did not keep the value".into()),
        }
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
    fn security_output_parses_literal_hex_and_b64() {
        use super::platform::{decode, parse_g};
        let lit = parse_g("keychain: \"x\"\npassword: \"plain value\"\n").unwrap();
        assert_eq!(&*decode(&lit).unwrap(), "plain value");
        // A value with a tab / non-ASCII prints as hex.
        let hex = parse_g("password: 0x636166C3A9  \"caf\\303\\251\"\n").unwrap();
        assert_eq!(&*decode(&hex).unwrap(), "café");
        let b = parse_g("password: \"b64:eAl5\"\n").unwrap();
        assert_eq!(&*decode(&b).unwrap(), "x\ty");
        assert!(parse_g("nothing here").is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn security_quoting_escapes_backslashes_and_quotes() {
        assert_eq!(super::platform::quote(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(super::platform::quote("plain"), "\"plain\"");
    }
}
