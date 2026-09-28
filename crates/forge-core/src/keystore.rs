//! Bridge-format identity JSON parsing and secret redaction.
//!
//! `bridge.thepasta.org` exports a non-custodial identity file (see
//! `docs/testing/e2e-test-plan.md` §1.1-B) containing a mnemonic, an asset-lock key,
//! and the identity's keys with WIF/hex private material. Secret fields are wrapped
//! in [`Secret`], whose `Debug`/`Display`-free surface keeps key material out of
//! logs, journals and panic output (style guide §B: "newtype with redacted Debug").
//!
//! Where a signing identity comes from (a *key source*, what `--identity` / `DASH_FORGE_KEY` /
//! the config default hold):
//!
//! * a path to a bridge-format identity file (plaintext JSON);
//! * a path to a passphrase-sealed file ([`crate::sealed`]) holding a bridge file or a `dfk1:`
//!   key: `dg auth login` writes one where there is no OS keychain;
//! * `keychain:dash-forge/<network>/<identityId>`: an OS keychain entry ([`crate::keychain`])
//!   holding the same (`dg auth new` / `dg auth login` store limited keys there);
//! * an inline `dfk1:<network>:<identityId>:<keyId>:<wif>` limited key (CI secrets).

use std::ffi::OsStr;
use std::fmt::{self, Write as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::{Error, Result};

/// A secret string (mnemonic, WIF, private-key hex) that never reveals itself in
/// `Debug` **or** serialized output. Access the underlying value explicitly via
/// [`Secret::expose`].
///
/// `Deserialize` reads a plain string (so identity files load), but `Serialize` emits a
/// fixed `"[redacted]"` placeholder — so even if a parent struct (`IdentityKey`,
/// `BridgeIdentity`) is ever serialized into a journal or log, the WIF/mnemonic can
/// never leak. Round-tripping a `Secret` through serde is therefore intentionally lossy.
/// The string is wiped from memory when the `Secret` is dropped.
#[derive(Clone)]
pub struct Secret(zeroize::Zeroizing<String>);

/// The placeholder emitted whenever a [`Secret`] is serialized.
const REDACTED: &str = "[redacted]";

impl Secret {
    /// Wrap a plaintext secret.
    pub fn new(value: impl Into<String>) -> Self {
        Self(zeroize::Zeroizing::new(value.into()))
    }

    /// Borrow the underlying secret. The call site is the audit point — never log
    /// or format the returned value.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl Serialize for Secret {
    /// Emit a redaction placeholder, never the secret material.
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(REDACTED)
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        Ok(Self::new(String::deserialize(deserializer)?))
    }
}

/// A single identity key entry from the bridge export.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityKey {
    /// Key index within the identity (0 = Master).
    pub id: u32,
    /// Human-readable role name (e.g. "Master", "High-Auth").
    pub name: String,
    /// Key algorithm, e.g. `ECDSA_SECP256K1`.
    pub key_type: String,
    /// Key purpose, e.g. `AUTHENTICATION`, `TRANSFER`, `ENCRYPTION`.
    pub purpose: String,
    /// Security level, e.g. `MASTER`, `CRITICAL`, `HIGH`, `MEDIUM`.
    pub security_level: String,
    /// Wallet Import Format private key (secret).
    pub private_key_wif: Secret,
    /// Hex-encoded private key (secret).
    pub private_key_hex: Secret,
    /// Hex-encoded public key (not secret).
    pub public_key_hex: String,
    /// BIP-32 derivation path.
    pub derivation_path: String,
}

/// The asset-lock funding key from a bridge export (`mainnet-bridge` shape: an object,
/// not a bare string). Only the WIF is secret.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetLockKey {
    /// Wallet Import Format asset-lock private key (secret).
    pub wif: Secret,
    /// Hex-encoded public key (not secret).
    pub public_key_hex: String,
    /// BIP-44 derivation path.
    pub derivation_path: String,
}

/// A parsed bridge-format identity export.
///
/// Mirrors the `mainnet-bridge` key-backup shape produced by `tools/mint-identity`
/// (create mode). Unknown top-level fields (`created`, `mode`, `depositAddress`,
/// `txid`) are ignored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeIdentity {
    /// Target network, e.g. `testnet` or `mainnet`.
    pub network: String,
    /// Base58 identity id.
    pub identity_id: String,
    /// The identity's keys.
    pub identity_keys: Vec<IdentityKey>,
    /// HD mnemonic the keys derive from (secret).
    pub mnemonic: Secret,
    /// Asset-lock funding key.
    pub asset_lock_key: AssetLockKey,
}

/// The prefix of an inline limited key (`dfk1:<network>:<identityId>:<keyId>:<wif>`).
pub const DFK1_PREFIX: &str = "dfk1:";

/// The warning for a `dfk1:` key passed as a command-line argument: other local users can
/// read a process's arguments (`ps`), and shells keep them in history.
pub const INLINE_KEY_ON_ARGV: &str = "an inline dfk1: key on the command line is visible to \
    other local users (ps) and kept in shell history; set DASH_FORGE_KEY instead";

/// The `dfk1:<network>:<identityId>:<keyId>:<wif>` value of one key.
pub fn dfk1(network: &str, identity_id: &str, key_id: u32, wif: &str) -> Secret {
    Secret::new(format!(
        "{DFK1_PREFIX}{network}:{identity_id}:{key_id}:{wif}"
    ))
}

/// Whether a `DASH_FORGE_KEY` / `--identity` value is an inline `dfk1:` key, not a path.
pub fn is_inline_key(source: &Path) -> bool {
    source.to_str().is_some_and(|s| s.starts_with(DFK1_PREFIX))
}

/// Whether a key source that should be a path is instead key material pasted into it: an
/// identity JSON (a CI variable of the wrong type holds the file's text, not its path), or
/// anything multi-line. Such a value must never be echoed.
pub fn looks_like_pasted_key(source: &Path) -> bool {
    let s = source.to_string_lossy();
    let t = s.trim_start();
    t.starts_with('{') || t.contains('\n') || t.len() > 4096
}

/// How to name a key source in messages: the path of an identity file, or for an inline
/// `dfk1:` key everything but its WIF. Pasted key material (see [`looks_like_pasted_key`])
/// is never shown.
pub fn describe_key_source(source: &Path) -> String {
    if looks_like_pasted_key(source) {
        return "[an identity's contents, not a path: redacted]".to_string();
    }
    match source.to_str().filter(|s| s.starts_with(DFK1_PREFIX)) {
        Some(inline) => {
            let parts: Vec<&str> = inline[DFK1_PREFIX.len()..].splitn(4, ':').collect();
            match parts[..] {
                [network, id, key, _] => format!("dfk1:{network}:{id}:{key}:[redacted]"),
                _ => "dfk1:[redacted]".to_string(),
            }
        }
        None => source.display().to_string(),
    }
}

/// The prefix of a key source kept in the OS keychain (`keychain:<service>/<account>`).
pub const KEYCHAIN_PREFIX: &str = "keychain:";

/// Whether `source` names a file on disk (not an inline `dfk1:` key or a keychain entry).
pub fn is_file_source(source: &Path) -> bool {
    source
        .to_str()
        .is_none_or(|s| !s.starts_with(DFK1_PREFIX) && !s.starts_with(KEYCHAIN_PREFIX))
}

/// The keychain key source for an identity: `keychain:dash-forge/<network>/<identityId>`.
pub fn keychain_source(network: &str, identity_id: &str) -> String {
    format!(
        "{KEYCHAIN_PREFIX}{}/{network}/{identity_id}",
        crate::keychain::SERVICE
    )
}

/// `(service, account)` of a `keychain:` key source.
pub fn parse_keychain_source(source: &str) -> Option<(&str, &str)> {
    source
        .strip_prefix(KEYCHAIN_PREFIX)?
        .split_once('/')
        .filter(|(s, a)| !s.is_empty() && !a.is_empty())
}

/// Dash Forge's config directory: `$XDG_CONFIG_HOME/dash-forge`, else
/// `~/.config/dash-forge` (ux-dx-spec §7.6).
///
/// Releases before the XDG change always used `~/.config/dash-forge`. When the two differ, the
/// first call in a process copies what the new directory lacks from the old one, once
/// ([`migrate_legacy_config`]), and says so on stderr.
pub fn forge_config_dir() -> Option<PathBuf> {
    static ONCE: std::sync::Once = std::sync::Once::new();
    let xdg = std::env::var_os("XDG_CONFIG_HOME");
    let home = std::env::var_os("HOME");
    let mut resolved = None;
    ONCE.call_once(|| {
        // Leave storage.toml alone while DASH_FORGE_STORAGE_CONFIG names another file.
        let storage_env = crate::storage::profiles::STORAGE_CONFIG_ENV;
        let hold_back: &[&str] = if std::env::var_os(storage_env).is_some() {
            &["storage.toml"]
        } else {
            &[]
        };
        resolved = Some(config_dir_migrating(
            xdg.as_deref(),
            home.as_deref(),
            hold_back,
        ));
    });
    match resolved {
        Some(r) => {
            let (dir, notice) = r?;
            // stderr only: stdout is git's protocol channel in the remote helper.
            if let Some(line) = notice {
                eprintln!("{line}");
            }
            Some(dir)
        }
        None => config_dirs(xdg.as_deref(), home.as_deref()).map(|(dir, _)| dir),
    }
}

/// [`forge_config_dir`] for explicit `XDG_CONFIG_HOME` / `HOME` values: the directory, after
/// copying the pre-XDG one into it when they differ ([`migrate_legacy_config`]), and the
/// notice to print when that copied (or failed to copy) anything.
pub fn config_dir_migrating(
    xdg: Option<&OsStr>,
    home: Option<&OsStr>,
    hold_back: &[&str],
) -> Option<(PathBuf, Option<String>)> {
    let (dir, legacy) = config_dirs(xdg, home)?;
    let notice = legacy.and_then(|legacy| {
        migrate_legacy_config(&legacy, &dir, hold_back)
            .and_then(|m| migration_notice(&legacy, &dir, &m))
    });
    Some((dir, notice))
}

/// The config directory for these `XDG_CONFIG_HOME` / `HOME` values, and the pre-XDG
/// directory (`$HOME/.config/dash-forge`) when it is a different path. A relative
/// `XDG_CONFIG_HOME` is ignored, as the XDG spec requires.
pub fn config_dirs(
    xdg: Option<&OsStr>,
    home: Option<&OsStr>,
) -> Option<(PathBuf, Option<PathBuf>)> {
    let legacy = home.map(|h| PathBuf::from(h).join(".config").join("dash-forge"));
    let dir = xdg
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .map(|p| p.join("dash-forge"))
        .or_else(|| legacy.clone())?;
    let legacy = legacy.filter(|l| *l != dir);
    Some((dir, legacy))
}

/// The file in the new config directory that records that the old one was copied, so a file
/// deleted afterwards (a `dg auth logout`, a removed profile) is never brought back. Its
/// `pending <name>` lines name top-level entries that were held back, still to copy.
pub const LEGACY_MIGRATION_MARKER: &str = ".migrated-from-home-config";

/// What [`migrate_legacy_config`] did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Migration {
    /// Files (and symlinks) copied.
    pub copied: usize,
    /// Entries that could not be copied, with why (not retried: the notice says so once).
    pub failed: Vec<String>,
    /// Top-level names left behind on purpose (see `hold_back`), copied by a later run.
    pub held_back: Vec<String>,
}

/// Copy everything under `legacy` that `dir` lacks into `dir`, recursively, once. Nothing in
/// `dir` is ever overwritten; `legacy` is left as it is (older binaries and scripts keep
/// reading it). Directories are created 0700; a file keeps its owner bits and loses every
/// group and other bit (a key file stays 0600). Top-level names in `hold_back` are not copied
/// (`storage.toml` while `DASH_FORGE_STORAGE_CONFIG` points elsewhere): the marker records
/// them, and the first later run that does not hold them back copies them if still missing.
///
/// Returns `None` when there is nothing to do: no `legacy` directory, the same directory
/// under two names (or one inside the other), or an earlier run's [`LEGACY_MIGRATION_MARKER`]
/// with nothing pending.
pub fn migrate_legacy_config(legacy: &Path, dir: &Path, hold_back: &[&str]) -> Option<Migration> {
    if !legacy.is_dir() {
        return None;
    }
    let marker = dir.join(LEGACY_MIGRATION_MARKER);
    // `None`: never ran. `Some(names)`: ran; only these top-level names are still to copy.
    let pending: Option<Vec<String>> = match std::fs::read_to_string(&marker) {
        Ok(text) => Some(
            text.lines()
                .filter_map(|l| l.strip_prefix("pending "))
                .map(str::to_string)
                .collect(),
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return None, // unreadable marker: never risk a second full copy
    };
    if let Some(p) = &pending {
        if p.iter().all(|n| hold_back.contains(&n.as_str())) {
            return None;
        }
    }
    // The same directory under two names, or one inside the other (copying would recurse into
    // its own output): nothing to do.
    let (a, b) = (real_path(legacy), real_path(dir));
    if a.starts_with(&b) || b.starts_with(&a) {
        return None;
    }
    // An empty old directory has nothing to carry over; no marker is needed either.
    std::fs::read_dir(legacy).ok()?.next()?.ok()?;
    let mut m = Migration::default();
    if let Err(e) = ensure_private_dir(dir) {
        m.failed.push(format!("{}: {e}", dir.display()));
        return Some(m);
    }
    copy_missing(legacy, dir, pending.as_deref(), hold_back, &mut m);
    // Written after every walk, so a copy runs once; what was held back stays pending.
    let mut note = format!("copied from {}\n", legacy.display());
    for name in &m.held_back {
        let _ = writeln!(note, "pending {name}");
    }
    if let Err(e) = replace_private_file(&marker, note.as_bytes()) {
        m.failed.push(format!("{LEGACY_MIGRATION_MARKER}: {e}"));
    }
    Some(m)
}

/// `p` with symlinks resolved, including when its tail does not exist yet: the nearest
/// existing ancestor is resolved and the rest appended.
fn real_path(p: &Path) -> PathBuf {
    let mut tail = Vec::new();
    let mut cur = p;
    loop {
        if let Ok(real) = cur.canonicalize() {
            return tail.iter().rev().fold(real, |acc, c| acc.join(c));
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_os_string());
                cur = parent;
            }
            _ => return p.to_path_buf(),
        }
    }
}

/// Replace `path` with `bytes` (0600) through a temporary file and a rename.
fn replace_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = temp_sibling(path);
    create_private_file(&tmp, bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// A unique `.<name>.<pid>.<seq>.<nonce>.tmp` path next to `path` (in `.` for a bare file
/// name). Unique per process, thread and call; callers create it with `create_new`, which
/// refuses any collision. The legacy-config copy skips these names.
fn temp_sibling(path: &Path) -> PathBuf {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let mut nonce = [0u8; 8];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    dir.join(format!(
        ".{name}.{}.{}.{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        hex::encode(nonce)
    ))
}

/// The one-line notice for a migration, or `None` when it did nothing worth saying.
pub fn migration_notice(legacy: &Path, dir: &Path, m: &Migration) -> Option<String> {
    if m.copied == 0 && m.failed.is_empty() && m.held_back.is_empty() {
        return None;
    }
    let mut line = format!(
        "dash-forge: XDG_CONFIG_HOME is set, so the config now lives in {}; copied {} file{} \
         from {} (left in place)",
        dir.display(),
        m.copied,
        if m.copied == 1 { "" } else { "s" },
        legacy.display()
    );
    if let Some(first) = m.failed.first() {
        let _ = write!(
            line,
            "; {} could not be copied (first: {first}): copy them by hand",
            m.failed.len()
        );
    }
    if !m.held_back.is_empty() {
        let _ = write!(
            line,
            "; not copied while {} is set: {}",
            crate::storage::profiles::STORAGE_CONFIG_ENV,
            m.held_back.join(", ")
        );
    }
    Some(line)
}

/// Create `dir` (and its parents) if missing; a directory this creates is 0700.
fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        b.mode(0o700);
    }
    match b.create(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && dir.is_dir() => Ok(()),
        other => other,
    }
}

/// The recursive step of [`migrate_legacy_config`]. `only` (copy just these names) and
/// `hold_back` apply to `src`'s own entries only (the call for the top directory).
fn copy_missing(
    src: &Path,
    dst: &Path,
    only: Option<&[String]>,
    hold_back: &[&str],
    m: &mut Migration,
) {
    let entries = match std::fs::read_dir(src) {
        Ok(e) => e,
        Err(e) => return m.failed.push(format!("{}: {e}", src.display())),
    };
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                m.failed.push(format!("{}: {e}", src.display()));
                continue;
            }
        };
        let name = entry.file_name();
        let (from, to) = (entry.path(), dst.join(&name));
        let lossy = name.to_string_lossy();
        // The marker, and a write_private_file temporary a crash left behind.
        if name == LEGACY_MIGRATION_MARKER
            || (lossy.starts_with('.') && lossy.ends_with(".tmp"))
            || only.is_some_and(|o| !o.iter().any(|n| name == n.as_str()))
        {
            continue;
        }
        let exists = std::fs::symlink_metadata(&to).is_ok();
        if hold_back.iter().any(|h| name == **h) {
            if !exists {
                m.held_back.push(lossy.into_owned());
            }
            continue;
        }
        let meta = match std::fs::symlink_metadata(&from) {
            Ok(meta) => meta,
            Err(e) => {
                m.failed.push(format!("{}: {e}", from.display()));
                continue;
            }
        };
        let result = if meta.is_dir() {
            if exists && !to.is_dir() {
                continue; // a file where the old directory was: the new one wins
            }
            ensure_private_dir(&to).map(|()| copy_missing(&from, &to, None, &[], m))
        } else if exists {
            continue; // never overwrite
        } else if meta.file_type().is_symlink() {
            copy_symlink(&from, &to).map(|()| m.copied += 1)
        } else if meta.is_file() {
            copy_file_private(&from, &to, &meta).map(|()| m.copied += 1)
        } else {
            Err(std::io::Error::other("not a regular file"))
        };
        match result {
            // Another process (git's helper next to `dg`) copied it first.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => m.failed.push(format!("{}: {e}", from.display())),
            Ok(()) => {}
        }
    }
}

/// Copy one regular file to a new `to`, keeping only its owner permission bits. The bytes go
/// to a temporary file first (created exclusively, never through a symlink) that is then
/// hard-linked into place, so a reader never sees a half-written file and an existing `to`
/// is never replaced (the link fails with `AlreadyExists`).
fn copy_file_private(from: &Path, to: &Path, meta: &std::fs::Metadata) -> std::io::Result<()> {
    use std::io::Write as _;
    let bytes = zeroize::Zeroizing::new(std::fs::read(from)?);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
        let owner = meta.permissions().mode() & 0o700;
        opts.mode(if owner == 0 { 0o600 } else { owner });
    }
    #[cfg(not(unix))]
    let _ = meta;
    let tmp = temp_sibling(to);
    let result = opts
        .open(&tmp)
        .and_then(|mut f| f.write_all(&bytes).and_then(|()| f.sync_all()))
        .and_then(|()| std::fs::hard_link(&tmp, to));
    let _ = std::fs::remove_file(&tmp);
    result
}

/// Recreate a symlink as it is (same target, not followed).
fn copy_symlink(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(std::fs::read_link(from)?, to)
    }
    #[cfg(not(unix))]
    {
        let _ = to;
        Err(std::io::Error::other(format!(
            "{} is a symlink; not copied on this platform",
            from.display()
        )))
    }
}

/// The key source `dg` recorded as the default (`default_identity` in `config.toml`), for
/// tools without an `--identity` of their own (the remote helper). `Ok(None)` when there is
/// no config file or it records none. A `config.toml` that cannot be read or does not parse
/// is an error (E204 naming the line and column), not "no default": `dg` refuses the same
/// file, and signing as nobody would hide the typo behind an E301.
pub fn configured_default_source() -> Result<Option<String>> {
    let Some(path) = crate::config_file::dg_config_path() else {
        return Ok(None);
    };
    configured_default_source_in(&path)
}

fn configured_default_source_in(path: &Path) -> Result<Option<String>> {
    let Some(v) = crate::config_file::read_config_toml(path)? else {
        return Ok(None);
    };
    Ok(v.get("default_identity")
        .and_then(toml::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string))
}

/// Write `bytes` to `path` readable by the owner only, replacing it atomically: the data goes
/// to a 0600 temporary file in the same directory (created exclusively, so no symlink is
/// followed) that is then renamed over `path`. A parent directory under the Forge config
/// directory is created and kept 0700.
pub fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let io = |e: std::io::Error| Error::Io(format!("writing {}: {e}", path.display()));
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let forge_dir = forge_config_dir();
            // Only Forge's own directories are tightened, never one the user named.
            if forge_dir.is_some_and(|c| dir.starts_with(c)) {
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                    .map_err(io)?;
            }
        }
    }
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if path.file_name().is_none() {
        return Err(Error::Io(format!("{} names no file", path.display())));
    }
    let tmp = temp_sibling(path);
    if let Err(e) = create_private_file(&tmp, bytes) {
        // Never leave a partial secret behind.
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    // rename() replaces a symlink at `path` instead of writing through it.
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io(e)
    })?;
    // Make the new directory entry durable too.
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Create `path` for a new export or backup, owner-only, refusing to overwrite anything or to
/// follow a symlink planted at the name (`O_EXCL` does not follow links).
pub fn create_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;
    let io = |e: std::io::Error| Error::Io(format!("writing {}: {e}", path.display()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let mut f = opts.open(path).map_err(io)?;
    f.write_all(bytes).map_err(io)?;
    f.sync_all().map_err(io)
}

/// Security levels acceptable for signing a document create/delete, in preference
/// order. Document ops accept HIGH (spike S0.7); CRITICAL also works and is the
/// fallback when a HIGH key is absent.
pub const DOC_OP_LEVELS: [&str; 2] = ["HIGH", "CRITICAL"];

impl BridgeIdentity {
    /// Parse a bridge-format identity export from JSON.
    pub fn from_json(raw: &str) -> Result<Self> {
        Ok(serde_json::from_str(raw)?)
    }

    /// Load a signing identity from `path`: a bridge-format identity export on disk, or an
    /// inline limited key `dfk1:<network>:<identityId>:<keyId>:<wif>` (the one-value form CI
    /// secrets use, ux-dx-spec §2.4). Every tool reads `DASH_FORGE_KEY` as a path, so taking
    /// the inline form here gives all of them the CI format at once.
    ///
    /// Never format `path` into a message yourself: use [`describe_key_source`], which keeps
    /// an inline key's WIF out of it.
    ///
    /// Also takes a `keychain:<service>/<account>` source (an OS keychain entry) and a
    /// passphrase-sealed file (the passphrase comes from `DASH_FORGE_PASSPHRASE` or a hidden
    /// prompt on the terminal); see the module docs.
    pub fn load_from_file(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_source_text(Self::unlock_source(path)?.expose())
    }

    /// What the key source `path` holds, unlocked: a `dfk1:` key or a bridge-format identity
    /// JSON, read from the keychain or a file (a sealed file is opened here, asking for its
    /// passphrase once). [`Self::from_source_text`] parses it; `dg` also hands it to
    /// `git-remote-dash` ([`crate::key_handoff`]) so the helper never asks again.
    pub fn unlock_source(path: impl AsRef<Path>) -> Result<Secret> {
        let path = path.as_ref();
        if let Some(inline) = path.to_str().filter(|s| s.starts_with(DFK1_PREFIX)) {
            // Refused here, with the format's own message, rather than later.
            Self::from_dfk1(inline)?;
            return Ok(Secret::new(inline));
        }
        if let Some(src) = path.to_str().filter(|s| s.starts_with(KEYCHAIN_PREFIX)) {
            let (service, account) = parse_keychain_source(src).ok_or_else(|| {
                Error::Config(format!(
                    "identity source {src:?} must be keychain:<service>/<account>"
                ))
            })?;
            return crate::keychain::get(service, account)?.ok_or_else(|| {
                Error::Io(format!(
                    "reading identity: no key in the keychain under {service}/{account}"
                ))
            });
        }
        if looks_like_pasted_key(path) {
            // The value is the identity itself where a path was expected (a CI variable of
            // the wrong type). Say so without echoing a byte of it.
            return Err(Error::Config(
                "the identity source holds an identity's contents, not a path to it: store it \
                 as a file (in GitLab CI, a File-type variable) and pass that file's path"
                    .into(),
            ));
        }
        let shown = describe_key_source(path);
        let raw = zeroize::Zeroizing::new(
            std::fs::read_to_string(path)
                .map_err(|e| Error::Io(format!("reading identity file {shown}: {e}")))?,
        );
        if crate::sealed::is_sealed(&raw) {
            let pass = crate::sealed::passphrase(&shown, false)?;
            let plain = crate::sealed::open(&raw, pass.expose())?;
            let text = std::str::from_utf8(&plain)
                .map_err(|_| Error::Io("the sealed identity file does not hold text".into()))?;
            return Ok(Secret::new(text));
        }
        if path.extension().is_some_and(|e| e == "key") {
            tracing::warn!(
                "{shown} holds an unencrypted identity key (stored with --insecure-plaintext)"
            );
        }
        Ok(Secret::new(raw.as_str()))
    }

    /// Parse what a keychain entry or a key file holds: a `dfk1:` limited key or a
    /// bridge-format identity JSON.
    pub fn from_source_text(text: &str) -> Result<Self> {
        let t = text.trim();
        if t.starts_with(DFK1_PREFIX) {
            Self::from_dfk1(t)
        } else {
            // serde_json quotes the offending text in its errors, and this text holds keys.
            Self::from_json(t).map_err(|_| {
                Error::Config(
                    "the stored identity is neither a dfk1: key nor a bridge-format identity file"
                        .into(),
                )
            })
        }
    }

    /// The identity as bridge-format JSON **with its secrets** (unlike `Serialize`, which
    /// redacts them): what a `--full-key` login stores and `dg auth export --reveal-secrets`
    /// writes. Handle the result as a secret.
    pub fn to_json_with_secrets(&self) -> Secret {
        let keys: Vec<serde_json::Value> = self
            .identity_keys
            .iter()
            .map(|k| {
                serde_json::json!({
                    "id": k.id,
                    "name": k.name,
                    "keyType": k.key_type,
                    "purpose": k.purpose,
                    "securityLevel": k.security_level,
                    "privateKeyWif": k.private_key_wif.expose(),
                    "privateKeyHex": k.private_key_hex.expose(),
                    "publicKeyHex": k.public_key_hex,
                    "derivationPath": k.derivation_path,
                })
            })
            .collect();
        let v = serde_json::json!({
            "network": self.network,
            "identityId": self.identity_id,
            "identityKeys": keys,
            "mnemonic": self.mnemonic.expose(),
            "assetLockKey": {
                "wif": self.asset_lock_key.wif.expose(),
                "publicKeyHex": self.asset_lock_key.public_key_hex,
                "derivationPath": self.asset_lock_key.derivation_path,
            },
        });
        // Compact: one line, so it also fits where a line break is not allowed.
        Secret::new(serde_json::to_string(&v).unwrap_or_default())
    }

    /// The identity's MASTER authentication key, when this source carries one.
    pub fn master_key(&self) -> Option<&IdentityKey> {
        self.auth_key("MASTER")
            .filter(|k| !k.private_key_wif.expose().is_empty())
    }

    /// The `dfk1:` form of key `key_id` of this identity.
    pub fn to_dfk1(&self, key_id: u32) -> Option<Secret> {
        let k = self.identity_keys.iter().find(|k| k.id == key_id)?;
        Some(dfk1(
            &self.network,
            &self.identity_id,
            k.id,
            k.private_key_wif.expose(),
        ))
    }

    /// Parse an inline limited key `dfk1:<network>:<identityId>:<keyId>:<wif>` into an
    /// identity carrying just that key. The key is listed as a HIGH authentication key (what
    /// document writes sign with); the write engine still matches it against the identity's
    /// on-chain keys, so a key that is not one of them, or not usable for writes, is refused
    /// there. No mnemonic, no master key: that is the point of the format.
    pub fn from_dfk1(value: &str) -> Result<Self> {
        let bad = |why: &str| {
            Error::Config(format!(
                "DASH_FORGE_KEY is not a valid dfk1 key ({why}); expected \
                 dfk1:<network>:<identityId>:<keyId>:<wif>"
            ))
        };
        let rest = value
            .trim()
            .strip_prefix(DFK1_PREFIX)
            .ok_or_else(|| bad("no dfk1: prefix"))?;
        let parts: Vec<&str> = rest.splitn(4, ':').collect();
        let [network, identity_id, key_id, wif] = parts[..] else {
            return Err(bad("it needs four fields after dfk1:"));
        };
        if network.is_empty() || identity_id.is_empty() || wif.is_empty() {
            return Err(bad("an empty field"));
        }
        // The network and id end up in file names and keychain accounts: letters, digits
        // and `-` only for the network, base58 for the id.
        if !network
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(bad("the network is not a network name"));
        }
        if !(40..=44).contains(&identity_id.len())
            || !identity_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() && !b"0OIl".contains(&b))
        {
            return Err(bad("the identity id is not base58"));
        }
        let id: u32 = key_id
            .parse()
            .map_err(|_| bad("the key id is not a number"))?;
        Ok(Self {
            network: network.to_string(),
            identity_id: identity_id.to_string(),
            identity_keys: vec![IdentityKey {
                id,
                name: "dfk1".into(),
                key_type: "ECDSA_SECP256K1".into(),
                purpose: "AUTHENTICATION".into(),
                security_level: "HIGH".into(),
                private_key_wif: Secret::new(wif),
                private_key_hex: Secret::new(""),
                public_key_hex: String::new(),
                derivation_path: String::new(),
            }],
            mnemonic: Secret::new(""),
            asset_lock_key: AssetLockKey {
                wif: Secret::new(""),
                public_key_hex: String::new(),
                derivation_path: String::new(),
            },
        })
    }

    /// Find an authentication key at the given security level, if present.
    pub fn auth_key(&self, security_level: &str) -> Option<&IdentityKey> {
        self.identity_keys
            .iter()
            .find(|k| k.purpose == "AUTHENTICATION" && k.security_level == security_level)
    }

    /// Pick the best AUTHENTICATION key for a document create/delete, preferring
    /// HIGH and falling back to CRITICAL (spike S0.7: document ops accept both).
    pub fn doc_op_key(&self) -> Result<&IdentityKey> {
        DOC_OP_LEVELS
            .iter()
            .find_map(|level| self.auth_key(level))
            .ok_or_else(|| {
                Error::Config("no HIGH or CRITICAL AUTHENTICATION key in identity file".into())
            })
    }
}

#[cfg(test)]
mod tests {
    use super::{BridgeIdentity, Secret};

    #[test]
    fn the_recorded_default_source_refuses_a_config_that_does_not_parse() {
        use super::configured_default_source_in as read;
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("config.toml");
        assert_eq!(read(&path).unwrap(), None, "no file: no default");
        std::fs::write(
            &path,
            "network = \"devnet\"\ndefault_identity = \"/k.json\"\n",
        )
        .unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some("/k.json"));
        std::fs::write(&path, "network = \"devnet\"\n").unwrap();
        assert_eq!(read(&path).unwrap(), None, "none recorded");
        // D-405: a syntax error used to read as "no default" (the helper then said E301).
        std::fs::write(&path, "network = \"devnet\"\ndefault_identity = \n").unwrap();
        let err = read(&path).unwrap_err();
        let crate::Error::User(u) = &err else {
            panic!("expected a phrased error, got {err}")
        };
        assert_eq!(u.code, crate::user_error::codes::INVALID_CONFIG);
        let cause = u.cause.clone().unwrap_or_default();
        assert!(cause.contains("config.toml: line 2, column 20"), "{cause}");
        // A config.toml that cannot be read (here: a directory) is E204 too.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        let err = read(&path).unwrap_err();
        let crate::Error::User(u) = &err else {
            panic!("expected a phrased error, got {err}")
        };
        assert_eq!(u.code, crate::user_error::codes::INVALID_CONFIG);
    }

    // All key material below is FAKE — non-functional placeholder strings only.
    const FIXTURE: &str = r#"{
        "network": "testnet",
        "identityId": "FAKEidentity1111111111111111111111111111111",
        "identityKeys": [
            {
                "id": 0,
                "name": "Master",
                "keyType": "ECDSA_SECP256K1",
                "purpose": "AUTHENTICATION",
                "securityLevel": "MASTER",
                "privateKeyWif": "FAKE-wif-master-DO-NOT-USE",
                "privateKeyHex": "deadbeefmaster",
                "publicKeyHex": "02aabbccddmaster",
                "derivationPath": "m/9'/1'/5'/0'/0'"
            },
            {
                "id": 2,
                "name": "High-Auth",
                "keyType": "ECDSA_SECP256K1",
                "purpose": "AUTHENTICATION",
                "securityLevel": "HIGH",
                "privateKeyWif": "FAKE-wif-high-DO-NOT-USE",
                "privateKeyHex": "deadbeefhigh",
                "publicKeyHex": "02aabbccddhigh",
                "derivationPath": "m/9'/1'/5'/0'/2'"
            }
        ],
        "mnemonic": "fake fake fake fake fake fake fake fake fake fake fake fake",
        "assetLockKey": {
            "wif": "FAKE-asset-lock-key-DO-NOT-USE",
            "publicKeyHex": "02aabbccddassetlock",
            "derivationPath": "m/44'/1'/0'/0/0"
        }
    }"#;

    #[test]
    fn parses_bridge_fixture() {
        let id = BridgeIdentity::from_json(FIXTURE).expect("fixture should parse");
        assert_eq!(id.network, "testnet");
        assert_eq!(
            id.identity_id,
            "FAKEidentity1111111111111111111111111111111"
        );
        assert_eq!(id.identity_keys.len(), 2);

        let master = &id.identity_keys[0];
        assert_eq!(master.name, "Master");
        assert_eq!(master.key_type, "ECDSA_SECP256K1");
        assert_eq!(master.purpose, "AUTHENTICATION");
        assert_eq!(master.security_level, "MASTER");
        assert_eq!(master.public_key_hex, "02aabbccddmaster");
        assert_eq!(master.derivation_path, "m/9'/1'/5'/0'/0'");
        // Secret values are still accessible via explicit expose().
        assert_eq!(
            master.private_key_wif.expose(),
            "FAKE-wif-master-DO-NOT-USE"
        );
    }

    #[test]
    fn finds_auth_key_by_security_level() {
        let id = BridgeIdentity::from_json(FIXTURE).unwrap();
        let high = id.auth_key("HIGH").expect("HIGH auth key present");
        assert_eq!(high.name, "High-Auth");
        assert!(id.auth_key("CRITICAL").is_none());
    }

    #[test]
    fn doc_op_key_prefers_high_then_critical() {
        let id = BridgeIdentity::from_json(FIXTURE).unwrap();
        // Fixture has MASTER + HIGH but no CRITICAL: doc ops select HIGH.
        let key = id.doc_op_key().expect("a HIGH or CRITICAL key is present");
        assert_eq!(key.security_level, "HIGH");
    }

    #[test]
    fn load_from_missing_file_is_io_error() {
        let err = BridgeIdentity::load_from_file("/nonexistent/definitely-not-here.json")
            .expect_err("missing file should error");
        assert!(matches!(err, crate::error::Error::Io(_)));
    }

    #[test]
    fn secret_debug_is_redacted() {
        let secret = Secret::new("super-secret-wif");
        let rendered = format!("{secret:?}");
        assert_eq!(rendered, "Secret(<redacted>)");
        assert!(!rendered.contains("super-secret-wif"));
    }

    #[test]
    fn serializing_identity_never_leaks_secrets() {
        let id = BridgeIdentity::from_json(FIXTURE).unwrap();
        // A future journal/log that serializes the identity must not emit secrets.
        let json = serde_json::to_string(&id).expect("serialize identity");
        assert!(!json.contains("FAKE-wif-master-DO-NOT-USE"));
        assert!(!json.contains("deadbeefmaster"));
        assert!(!json.contains("FAKE-asset-lock-key-DO-NOT-USE"));
        assert!(!json.contains("fake fake fake"));
        assert!(json.contains("[redacted]"));
        // Non-secret fields still serialize normally.
        assert!(json.contains("testnet"));
    }

    #[test]
    fn an_inline_dfk1_key_loads_as_one_high_auth_key() {
        let v = "dfk1:devnet-moutai:FAKEid1111111111111111111111111111111111111:5:cFAKEwifDONOTUSE";
        let id = BridgeIdentity::load_from_file(v).unwrap();
        assert_eq!(id.network, "devnet-moutai");
        assert_eq!(
            id.identity_id,
            "FAKEid1111111111111111111111111111111111111"
        );
        let key = id.doc_op_key().unwrap();
        assert_eq!(key.id, 5);
        assert_eq!(key.private_key_wif.expose(), "cFAKEwifDONOTUSE");
        assert!(
            id.auth_key("CRITICAL").is_none(),
            "a limited key is never CRITICAL"
        );
        assert!(id.mnemonic.expose().is_empty());
        // Nothing prints the WIF.
        assert!(!format!("{id:?}").contains("cFAKEwif"));
        let shown = super::describe_key_source(std::path::Path::new(v));
        assert_eq!(
            shown,
            "dfk1:devnet-moutai:FAKEid1111111111111111111111111111111111111:5:[redacted]"
        );
        assert!(super::is_inline_key(std::path::Path::new(v)));
        assert!(!super::is_inline_key(std::path::Path::new("/tmp/id.json")));
    }

    /// An identity JSON passed where a path belongs (a GitLab CI variable of type Variable,
    /// not File) is refused without a byte of it in the message.
    #[test]
    fn pasted_identity_contents_are_never_echoed() {
        let pasted = r#"{"identityId":"X","identityKeys":[{"privateKeyWif":"cSECRETwif"}]}"#;
        let p = std::path::Path::new(pasted);
        assert!(super::looks_like_pasted_key(p));
        assert!(!super::describe_key_source(p).contains("cSECRET"));
        let e = super::BridgeIdentity::load_from_file(p)
            .unwrap_err()
            .to_string();
        assert!(!e.contains("cSECRET") && e.contains("File-type"), "{e}");
        assert!(!super::looks_like_pasted_key(std::path::Path::new(
            "/tmp/id.json"
        )));
    }

    #[test]
    fn malformed_dfk1_keys_are_refused_without_echoing_the_wif() {
        for bad in [
            "dfk1:",
            "dfk1:testnet:id:5",
            "dfk1:testnet:id:five:cWIFsecret",
            "dfk1::id:5:cWIFsecret",
            // An id that is not base58, and a network that is not a name (both end up in file
            // names and keychain accounts).
            "dfk1:testnet:../../etc/passwd:5:cWIFsecret",
            "dfk1:test/net:FAKEid1111111111111111111111111111111111111:5:cWIFsecret",
        ] {
            let err = BridgeIdentity::from_dfk1(bad).unwrap_err().to_string();
            assert!(err.contains("dfk1:<network>"), "{err}");
            assert!(!err.contains("cWIFsecret"), "{err}");
        }
    }

    #[test]
    fn secret_serializes_to_redaction_placeholder() {
        let secret = Secret::new("super-secret-wif");
        let json = serde_json::to_string(&secret).unwrap();
        assert_eq!(json, "\"[redacted]\"");
        assert!(!json.contains("super-secret-wif"));
    }

    #[test]
    fn identity_debug_never_leaks_secrets() {
        let id = BridgeIdentity::from_json(FIXTURE).unwrap();
        let dumped = format!("{id:?}");
        // No secret material should appear anywhere in the Debug rendering.
        assert!(!dumped.contains("FAKE-wif-master-DO-NOT-USE"));
        assert!(!dumped.contains("deadbeefmaster"));
        assert!(!dumped.contains("FAKE-asset-lock-key-DO-NOT-USE"));
        assert!(!dumped.contains("fake fake fake"));
        assert!(dumped.contains("<redacted>"));
        // Non-secret fields are still visible for diagnostics.
        assert!(dumped.contains("testnet"));
        assert!(dumped.contains("02aabbccddmaster"));
    }

    // ---- F-16: the pre-XDG config directory is carried over once ----------------------

    mod legacy_config {
        use super::super::{
            config_dir_migrating, config_dirs, migrate_legacy_config, LEGACY_MIGRATION_MARKER,
        };
        use std::ffi::OsStr;
        use std::path::{Path, PathBuf};

        fn write(p: &Path, text: &str, mode: u32) {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
            }
            #[cfg(not(unix))]
            let _ = mode;
        }

        #[cfg(unix)]
        fn mode(p: &Path) -> u32 {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777
        }

        /// A HOME with a pre-XDG config (profiles, config, an identity key) and an empty
        /// XDG_CONFIG_HOME elsewhere.
        fn upgraded_user() -> (tempfile::TempDir, PathBuf, PathBuf) {
            let t = tempfile::tempdir().unwrap();
            let home = t.path().join("home");
            let xdg = t.path().join("xdg");
            let old = home.join(".config/dash-forge");
            write(
                &old.join("storage.toml"),
                "[profiles.r2]\nkind = \"s3\"\n",
                0o600,
            );
            write(&old.join("config.toml"), "network = \"testnet\"\n", 0o600);
            write(&old.join("identities/testnet-X.key"), "sealed", 0o600);
            write(&old.join("import-dash/state.json"), "{}", 0o644);
            (t, home, xdg)
        }

        fn dirs(home: &Path, xdg: &Path) -> (PathBuf, Option<String>) {
            config_dir_migrating(Some(xdg.as_os_str()), Some(home.as_os_str()), &[]).unwrap()
        }

        #[test]
        fn legacy_dir_is_only_reported_when_it_differs() {
            let (home, xdg) = (OsStr::new("/h"), OsStr::new("/x"));
            assert_eq!(
                config_dirs(Some(xdg), Some(home)),
                Some((
                    PathBuf::from("/x/dash-forge"),
                    Some(PathBuf::from("/h/.config/dash-forge"))
                ))
            );
            // No XDG, an empty one, a relative one, or XDG = ~/.config: no second directory.
            for x in [None, Some(""), Some("rel/dir"), Some("/h/.config")] {
                assert_eq!(
                    config_dirs(x.map(OsStr::new), Some(home)),
                    Some((PathBuf::from("/h/.config/dash-forge"), None)),
                    "{x:?}"
                );
            }
            assert_eq!(
                config_dirs(Some(xdg), None),
                Some((PathBuf::from("/x/dash-forge"), None))
            );
            assert_eq!(config_dirs(None, None), None);
        }

        #[test]
        fn upgrade_copies_the_old_config_once_and_says_where() {
            let (_t, home, xdg) = upgraded_user();
            let old = home.join(".config/dash-forge");
            let (dir, notice) = dirs(&home, &xdg);
            assert_eq!(dir, xdg.join("dash-forge"));
            for f in [
                "storage.toml",
                "config.toml",
                "identities/testnet-X.key",
                "import-dash/state.json",
            ] {
                assert_eq!(
                    std::fs::read(dir.join(f)).unwrap(),
                    std::fs::read(old.join(f)).unwrap(),
                    "{f}"
                );
            }
            let notice = notice.expect("a notice");
            assert!(!notice.contains('\n'), "{notice}");
            assert!(notice.contains(&dir.display().to_string()), "{notice}");
            assert!(notice.contains(&old.display().to_string()), "{notice}");
            assert!(notice.contains("copied 4 files"), "{notice}");
            // The old directory is left for older binaries.
            assert!(old.join("storage.toml").exists());
            assert!(dir.join(LEGACY_MIGRATION_MARKER).exists());

            // Once: a file removed from the new directory later is not brought back, and
            // nothing more is said.
            std::fs::remove_file(dir.join("storage.toml")).unwrap();
            let (_, again) = dirs(&home, &xdg);
            assert_eq!(again, None);
            assert!(!dir.join("storage.toml").exists());
        }

        #[cfg(unix)]
        #[test]
        fn secrets_stay_owner_only() {
            let (_t, home, xdg) = upgraded_user();
            let (dir, _) = dirs(&home, &xdg);
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&dir.join("identities")), 0o700);
            assert_eq!(mode(&dir.join("identities/testnet-X.key")), 0o600);
            assert_eq!(mode(&dir.join("storage.toml")), 0o600);
            // A world-readable file loses its group/other bits.
            assert_eq!(mode(&dir.join("import-dash/state.json")), 0o600);
        }

        #[test]
        fn nothing_in_the_new_dir_is_overwritten() {
            let (_t, home, xdg) = upgraded_user();
            let dir = xdg.join("dash-forge");
            write(&dir.join("storage.toml"), "new", 0o600);
            let (_, notice) = dirs(&home, &xdg);
            assert_eq!(
                std::fs::read_to_string(dir.join("storage.toml")).unwrap(),
                "new"
            );
            assert_eq!(
                std::fs::read_to_string(dir.join("config.toml")).unwrap(),
                "network = \"testnet\"\n"
            );
            assert!(notice.unwrap().contains("copied 3 files"));
        }

        #[test]
        fn a_held_back_storage_toml_waits_for_a_later_run() {
            let (_t, home, xdg) = upgraded_user();
            let dir = xdg.join("dash-forge");
            let held = |home: &Path, xdg: &Path| {
                config_dir_migrating(
                    Some(xdg.as_os_str()),
                    Some(home.as_os_str()),
                    &["storage.toml"],
                )
                .unwrap()
                .1
            };
            // DASH_FORGE_STORAGE_CONFIG set: storage.toml is not touched, the rest is.
            let notice = held(&home, &xdg).unwrap();
            assert!(notice.contains("DASH_FORGE_STORAGE_CONFIG"), "{notice}");
            assert!(!dir.join("storage.toml").exists());
            assert!(dir.join("config.toml").exists());
            // Still one-time for everything else: a key removed later (a logout) stays gone,
            // and a second held-back run says nothing.
            std::fs::remove_file(dir.join("identities/testnet-X.key")).unwrap();
            assert_eq!(held(&home, &xdg), None);
            assert!(!dir.join("identities/testnet-X.key").exists());
            // Without the override, the next run copies just the pending file, then is done.
            let (_, notice) = dirs(&home, &xdg);
            assert!(notice.unwrap().contains("copied 1 file "), "one file");
            assert!(dir.join("storage.toml").exists());
            assert!(!dir.join("identities/testnet-X.key").exists());
            std::fs::remove_file(dir.join("storage.toml")).unwrap();
            assert_eq!(dirs(&home, &xdg).1, None);
            assert!(!dir.join("storage.toml").exists());
        }

        #[cfg(unix)]
        #[test]
        fn a_file_that_cannot_be_copied_is_reported_once() {
            use std::os::unix::fs::PermissionsExt as _;
            let (_t, home, xdg) = upgraded_user();
            let old = home.join(".config/dash-forge");
            let fifo_like = old.join("unreadable.toml");
            write(&fifo_like, "x", 0o000);
            // Root reads anything; the point is moot there.
            if std::fs::read(&fifo_like).is_ok() {
                return;
            }
            let notice = dirs(&home, &xdg).1.unwrap();
            assert!(notice.contains("1 could not be copied"), "{notice}");
            assert!(xdg.join("dash-forge/storage.toml").exists());
            // Not retried on every run.
            assert_eq!(dirs(&home, &xdg).1, None);
            std::fs::set_permissions(&fifo_like, std::fs::Permissions::from_mode(0o600)).unwrap();
        }

        /// XDG_CONFIG_HOME set to the old directory itself, reached through a symlinked
        /// HOME: the new directory is inside the old one and must not be copied into itself.
        #[cfg(unix)]
        #[test]
        fn a_new_dir_inside_the_old_one_is_not_filled_from_it() {
            let (t, home, _) = upgraded_user();
            let link = t.path().join("home-link");
            std::os::unix::fs::symlink(&home, &link).unwrap();
            let old = link.join(".config/dash-forge");
            // $XDG_CONFIG_HOME/dash-forge = <old>/dash-forge, which does not exist yet.
            let (dir, notice) =
                config_dir_migrating(Some(old.as_os_str()), Some(home.as_os_str()), &[]).unwrap();
            assert_eq!(notice, None);
            assert!(!dir.exists(), "copied into itself: {}", dir.display());
        }

        #[test]
        fn no_legacy_dir_or_the_same_dir_does_nothing() {
            let t = tempfile::tempdir().unwrap();
            let (home, xdg) = (t.path().join("home"), t.path().join("xdg"));
            // No old directory at all.
            assert_eq!(dirs(&home, &xdg).1, None);
            assert!(!xdg.join("dash-forge").exists());
            // An empty old directory: nothing to carry over, nothing created.
            std::fs::create_dir_all(home.join(".config/dash-forge")).unwrap();
            assert_eq!(dirs(&home, &xdg).1, None);
            assert!(!xdg.join("dash-forge").exists());
            // XDG_CONFIG_HOME a symlink to ~/.config: one directory, nothing copied.
            write(&home.join(".config/dash-forge/storage.toml"), "x", 0o600);
            #[cfg(unix)]
            {
                let link = t.path().join("link");
                std::os::unix::fs::symlink(home.join(".config"), &link).unwrap();
                let legacy = home.join(".config/dash-forge");
                assert_eq!(
                    migrate_legacy_config(&legacy, &link.join("dash-forge"), &[]),
                    None
                );
                assert!(!legacy.join(LEGACY_MIGRATION_MARKER).exists());
            }
        }
    }
}
