//! Where `dg auth` keeps an identity's key (ux-dx-spec §2.4): the OS keychain (service
//! `dash-forge`, account `<network>/<identityId>`), else
//! `~/.config/dash-forge/identities/<network>-<id>.key` sealed under a passphrase, else — only
//! with `--insecure-plaintext` — the same file unencrypted (every later read warns).
//!
//! What is stored is a key *source text*: a `dfk1:` limited key (the default), or the whole
//! bridge identity JSON for `--full-key`. The value recorded as `default_identity` in
//! config.toml is where to find it (`keychain:dash-forge/<network>/<id>` or the file path), so
//! `dg`, `git-remote-dash` and the importer all load it through
//! `BridgeIdentity::load_from_file`.

use std::path::PathBuf;

use anyhow::{Context as _, Result};

use forge_core::keychain;
use forge_core::keystore::{self, Secret};
use forge_core::sealed;
use forge_core::user_error::{codes, UserError};

use crate::config::{config_dir, Config};
use crate::context::Ctx;

/// How the key was stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stored {
    /// In the OS keychain.
    Keychain {
        /// The `keychain:` key source.
        source: String,
    },
    /// In a passphrase-sealed file.
    Sealed(PathBuf),
    /// In an unencrypted file (`--insecure-plaintext`).
    Plaintext(PathBuf),
}

impl Stored {
    /// The key source to record as the default identity.
    pub fn source(&self) -> String {
        match self {
            Stored::Keychain { source } => source.clone(),
            Stored::Sealed(p) | Stored::Plaintext(p) => p.to_string_lossy().into_owned(),
        }
    }

    /// Where it is, for people: "macOS Keychain (dash-forge/testnet/5Dtb…)".
    pub fn describe(&self) -> String {
        match self {
            Stored::Keychain { source } => format!(
                "{} ({})",
                keychain::store_name(),
                source.trim_start_matches(keystore::KEYCHAIN_PREFIX)
            ),
            Stored::Sealed(p) => format!("{} (passphrase-encrypted)", p.display()),
            Stored::Plaintext(p) => format!("{} (UNENCRYPTED)", p.display()),
        }
    }

    /// `keychain` / `sealed-file` / `plaintext-file`, for `--json`.
    pub fn kind(&self) -> &'static str {
        match self {
            Stored::Keychain { .. } => "keychain",
            Stored::Sealed(_) => "sealed-file",
            Stored::Plaintext(_) => "plaintext-file",
        }
    }
}

/// Describe an arbitrary key source the same way (for `dg auth status`). Key material
/// pasted where a path belongs (an identity JSON in `DASH_FORGE_KEY`) is never shown.
pub fn describe_source(source: &str) -> (String, &'static str) {
    if keystore::looks_like_pasted_key(std::path::Path::new(source)) {
        return (
            keystore::describe_key_source(std::path::Path::new(source)),
            "pasted",
        );
    }
    if source.starts_with(keystore::KEYCHAIN_PREFIX) {
        if keystore::parse_keychain_source(source).is_none() {
            // Malformed: whatever follows the prefix may be a pasted key.
            return ("keychain:[redacted]".into(), "keychain");
        }
        let s = Stored::Keychain {
            source: source.to_string(),
        };
        return (s.describe(), s.kind());
    }
    if source.starts_with(keystore::DFK1_PREFIX) {
        return ("inline dfk1: key (DASH_FORGE_KEY)".into(), "inline");
    }
    let path = PathBuf::from(source);
    let sealed_file = std::fs::read_to_string(&path).is_ok_and(|raw| sealed::is_sealed(&raw));
    if sealed_file {
        let s = Stored::Sealed(path);
        (s.describe(), s.kind())
    } else if path.extension().is_some_and(|e| e == "key") {
        let s = Stored::Plaintext(path);
        (s.describe(), s.kind())
    } else {
        (
            // Not `path.display()`: a value that names no file may be a pasted key.
            format!("{} (identity file)", keystore::describe_key_source(&path)),
            "identity-file",
        )
    }
}

/// The fallback key file for an identity: `identities/<network>-<id>.key`.
fn key_file(network: &str, identity_id: &str) -> Result<PathBuf> {
    Ok(config_dir()?
        .join("identities")
        .join(format!("{network}-{identity_id}.key")))
}

/// Which slot a key goes to: the one in use, or the staging slot a new key waits in until the
/// chain has it (so the key in use is never overwritten by one that might not register).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    /// The key this computer signs with.
    Main,
    /// A new key, not yet confirmed on chain.
    Pending,
    /// forge-user's encryption key `E` (settings that follow the identity), which older dg
    /// builds never read.
    Sync,
}

impl Slot {
    fn suffix(self) -> &'static str {
        match self {
            Slot::Main => "",
            Slot::Pending => ".pending",
            Slot::Sync => ".sync",
        }
    }
}

fn account(network: &str, identity_id: &str, slot: Slot) -> String {
    format!("{network}/{identity_id}{}", slot.suffix())
}

fn slot_file(network: &str, identity_id: &str, slot: Slot) -> Result<PathBuf> {
    let f = key_file(network, identity_id)?;
    Ok(match slot {
        Slot::Main => f,
        Slot::Pending => f.with_extension("key.pending"),
        Slot::Sync => f.with_extension("key.sync"),
    })
}

/// How a key is stored: where, and (for a sealed file) the passphrase, so one run asks once.
#[derive(Debug, Default)]
pub struct Storer {
    /// Allow an unencrypted file where there is no keychain.
    pub insecure_plaintext: bool,
    /// Never use the keychain (a full identity with its master key).
    pub no_keychain: bool,
    pass: Option<Secret>,
    /// Where this storer last put a pending key, and the key, so [`promote`] removes that copy
    /// only while it still holds this run's key.
    staged: Option<(Stored, Secret)>,
    /// What [`Storer::main_slot_replaced`] said a main-slot store overwrites (the caller asked
    /// about exactly that): a main-slot key file outside it is never written over.
    guarded_main: Option<Vec<String>>,
}

impl Storer {
    /// A storer for a limited key.
    pub fn new(insecure_plaintext: bool) -> Self {
        Self {
            insecure_plaintext,
            ..Self::default()
        }
    }

    /// A storer for a full identity (master key included): never the keychain.
    pub fn sealed_only(insecure_plaintext: bool) -> Self {
        Self {
            insecure_plaintext,
            no_keychain: true,
            ..Self::default()
        }
    }

    /// Store `text` (a `dfk1:` key or a bridge JSON) for `identity_id` on `network` in `slot`,
    /// preferring the keychain (never for a full identity: its master key goes behind a
    /// passphrase). `insecure_plaintext` allows an unencrypted file when there is no keychain.
    pub fn store(
        &mut self,
        network: &str,
        identity_id: &str,
        text: &Secret,
        slot: Slot,
    ) -> Result<Stored> {
        // One store at a time per identity, across processes: the copy's name, the copy and the
        // write happen together.
        let _lock = identity_lock(network, identity_id)?;
        let stored = self.write(network, identity_id, text, slot)?;
        if slot == Slot::Pending {
            self.staged = Some((stored.clone(), Secret::new(text.expose())));
        }
        Ok(stored)
    }

    fn write(
        &mut self,
        network: &str,
        identity_id: &str,
        text: &Secret,
        slot: Slot,
    ) -> Result<Stored> {
        let mut sync_keychain_failed = None;
        let mut keychain_failed = false;
        if !self.no_keychain && keychain::available() {
            let acct = account(network, identity_id, slot);
            // An entry that can't be read is left as it is (it can't be copied first), and the
            // key goes to a file instead.
            let failed = match keep_keychain_entry(&acct, &backup_stamp(), text.expose()) {
                Err(e) if slot == Slot::Sync => Some(e),
                Err(e) => {
                    eprintln!(
                        "note: the keychain entry could not be copied first ({e:#}), so it is left as it is; using a file"
                    );
                    keychain_failed = true;
                    None
                }
                Ok(kept) => {
                    if let Some(kept) = kept {
                        kept_one(keychain_source(&kept), slot);
                    }
                    // keychain::set reads the value back before it reports success.
                    match keychain::set(keychain::SERVICE, &acct, text.expose()) {
                        Ok(()) => {
                            return Ok(Stored::Keychain {
                                source: keychain_source(&acct),
                            })
                        }
                        Err(e) if slot == Slot::Sync => Some(e.into()),
                        Err(e) => {
                            eprintln!("note: the keychain refused the key ({e}); using a file");
                            keychain_failed = true;
                            None
                        }
                    }
                }
            };
            if let Some(e) = failed {
                // The sync key is looked up in the keychain before the file, so a file beside an
                // entry there would never be read: the file is used only when there is none.
                match sync_fallback(keychain::get(keychain::SERVICE, &acct), text) {
                    SyncFallback::InKeychain => {
                        return Ok(Stored::Keychain {
                            source: keychain_source(&acct),
                        })
                    }
                    SyncFallback::File => {
                        sync_keychain_failed = Some(e);
                        keychain_failed = true;
                    }
                    SyncFallback::Refuse => return Err(e),
                }
            }
        }
        let stored = self.write_file(network, identity_id, text, slot, keychain_failed)?;
        if let Some(e) = sync_keychain_failed {
            eprintln!("{}", sync_file_note(&e, &stored));
        }
        Ok(stored)
    }

    fn write_file(
        &mut self,
        network: &str,
        identity_id: &str,
        text: &Secret,
        slot: Slot,
        keychain_failed: bool,
    ) -> Result<Stored> {
        let path = slot_file(network, identity_id, slot)?;
        let guarded = self.guarded_main.as_deref().filter(|_| slot == Slot::Main);
        // Refused before a passphrase is asked for, unless only that passphrase can tell (a
        // sealed file).
        let sealed_there = std::fs::read_to_string(&path).is_ok_and(|raw| sealed::is_sealed(&raw));
        if !sealed_there || (self.insecure_plaintext && !self.no_keychain) {
            if let Some(refused) = unguarded_overwrite(guarded, &path, None) {
                return Err(refused.into());
            }
        }
        if self.insecure_plaintext && !self.no_keychain {
            keep_replaced_file(&path, text.expose().as_bytes(), slot)?;
            keystore::write_private_file(&path, text.expose().as_bytes())?;
            return Ok(Stored::Plaintext(path));
        }
        if self.pass.is_none() {
            let why = if self.no_keychain {
                "a full identity (master key included) is only ever stored behind a passphrase"
            } else if keychain_failed {
                "the OS keychain did not take the key, so it goes to a passphrase-encrypted file"
            } else {
                "there is no OS keychain here, so the key goes to a passphrase-encrypted file"
            };
            // Named as the file the key ends up in: a new key is written beside it as
            // `….key.pending` until the chain confirms it (QW3-070).
            let shown =
                slot_file(network, identity_id, Slot::Main).unwrap_or_else(|_| path.clone());
            // Say why before asking (QW4-058: a bare "Passphrase for the key file …" came with
            // no reason, which only a failure printed).
            if sealed::passphrase_env_in_use(&[sealed::PASSPHRASE_ENV]).is_none()
                && sealed::passphrase_available()
            {
                eprintln!("{}", passphrase_reason(why));
            }
            let pass = sealed::passphrase(&format!("the key file {}", shown.display()), true)
                .map_err(|e| {
                    UserError::new(codes::USAGE, "the key could not be stored")
                        .cause(format!("{why}, and {e}"))
                        .fix("run it in a terminal to type a passphrase, or set DASH_FORGE_PASSPHRASE")
                        .note("nothing was registered on Platform")
                })?;
            self.pass = Some(pass);
        }
        let pass = self.pass.as_ref().context("no passphrase")?;
        if let Some(refused) = unguarded_overwrite(guarded, &path, Some(pass)) {
            return Err(refused.into());
        }
        let sealed_text = sealed::seal(text.expose().as_bytes(), pass.expose())?;
        keep_before_sealing(&path, pass, text, sealed_text.as_bytes(), slot)?;
        keystore::write_private_file(&path, sealed_text.as_bytes())?;
        Ok(Stored::Sealed(path))
    }
}

/// Why the main-slot key file `path` must not be written over: the caller was told the store
/// overwrites only `predicted` ([`Storer::main_slot_replaced`]), which does not name it (the
/// keychain was to take the key, and refused it), and it holds what the guard would have asked
/// about: a master key, or a key that does not open (as plain text, or sealed with `pass`). A
/// limited key there is replaced after a copy is kept, as any store does.
fn unguarded_overwrite(
    predicted: Option<&[String]>,
    path: &std::path::Path,
    pass: Option<&Secret>,
) -> Option<UserError> {
    let predicted = predicted?;
    let real = |p: &std::path::Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.into());
    if !path.exists()
        || predicted
            .iter()
            .any(|s| real(std::path::Path::new(s)) == real(path))
    {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok();
    let plain = raw.as_deref().and_then(|raw| {
        if let Ok(b) = keystore::BridgeIdentity::from_source_text(raw) {
            return Some(b);
        }
        let opened = sealed::open(raw, pass?.expose()).ok()?;
        keystore::BridgeIdentity::from_source_text(std::str::from_utf8(&opened).ok()?).ok()
    });
    if plain.as_ref().is_some_and(|b| b.master_key().is_none()) {
        return None;
    }
    Some(
        UserError::new(
            codes::USAGE,
            "the key could not be stored in the keychain, and the key file there was kept",
        )
        .cause(format!(
            "the keychain did not take the key, and {} holds {}",
            path.display(),
            if plain.is_some() {
                "this identity's master key"
            } else if raw.as_deref().is_some_and(|raw| {
                sealed::is_sealed(raw) && pass.is_none_or(|p| sealed::open(raw, p.expose()).is_err())
            }) {
                "a key sealed with another passphrase than the one typed, so dg cannot tell whether it is the master key"
            } else {
                "something dg could not read as a key"
            }
        ))
        .fix("unlock the keychain (over SSH on a Mac: `security unlock-keychain`) and run it again")
        .fix(format!(
            "or move {} somewhere safe and run it again",
            path.display()
        )),
    )
}

/// Where the sync key goes once the keychain failed to take it (#768).
#[derive(Debug, PartialEq, Eq)]
enum SyncFallback {
    /// The entry holds the key after all.
    InKeychain,
    /// There is no entry, so a file is read: the sealed `.key.sync` file.
    File,
    /// An entry that would hide a file is there, or the keychain can't say: nothing is stored.
    Refuse,
}

/// [`SyncFallback`] from a fresh read of the sync key's entry (`entry`) after the keychain failed
/// to take `text`.
fn sync_fallback(entry: forge_core::error::Result<Option<Secret>>, text: &Secret) -> SyncFallback {
    match entry {
        Ok(None) => SyncFallback::File,
        Ok(Some(v)) if v.expose() == text.expose() => SyncFallback::InKeychain,
        Ok(Some(_)) | Err(_) => SyncFallback::Refuse,
    }
}

/// The line saying the sync key went to a file because the keychain failed (`e`).
fn sync_file_note(e: &anyhow::Error, stored: &Stored) -> String {
    let (path, sealed) = match stored {
        Stored::Sealed(p) => (p, true),
        Stored::Plaintext(p) => (p, false),
        Stored::Keychain { source } => {
            return format!("note: the settings-sync key is kept in {source}")
        }
    };
    format!(
        "note: the OS keychain failed ({e:#}), so the settings-sync key is kept in {}{}",
        path.display(),
        if sealed {
            " (dg and git read it when DASH_FORGE_PASSPHRASE is set)"
        } else {
            ""
        }
    )
}

/// The `keychain:` key source of dg's entry `acct`, which `--identity` and `DASH_FORGE_KEY`
/// take.
fn keychain_source(acct: &str) -> String {
    format!("{}{}/{acct}", keystore::KEYCHAIN_PREFIX, keychain::SERVICE)
}

/// Where this run kept the keys it replaced, for `--json` ([`kept_this_run`]).
static KEPT: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// The key sources of the copies this run kept of keys it replaced (`previousKeyKeptAt`).
pub fn kept_this_run() -> Vec<String> {
    KEPT.lock().map(|k| k.clone()).unwrap_or_default()
}

/// Say where a replaced key was kept. An identity key's copy is a key source and goes to
/// `previousKeyKeptAt`; a sync key's is not one.
fn kept_one(at: String, slot: Slot) {
    if slot == Slot::Sync {
        eprintln!("The settings-sync key this computer held is kept at {at}");
        return;
    }
    eprintln!("The key this computer held is kept at {at} (`--identity {at}` uses it)");
    KEPT.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(at);
}

/// Before a key file is replaced by `new`, keep a copy of it ([`keep_file`]), unless it
/// already holds exactly `new`.
fn keep_replaced_file(path: &std::path::Path, new: &[u8], slot: Slot) -> Result<()> {
    if std::fs::read(path).is_ok_and(|old| zeroize::Zeroizing::new(old).as_slice() == new) {
        return Ok(());
    }
    if let Some(kept) = keep_file(path, &backup_stamp())? {
        kept_one(kept.display().to_string(), slot);
    }
    Ok(())
}

/// The UTC time a backup is named after: `20261125T120000Z`.
fn backup_stamp() -> String {
    forge_core::backends::sigv4::AmzDate::now().datetime
}

/// How many names a backup tries (`….bak-<stamp>`, then `-2`, `-3`, …) before giving up.
const BACKUP_NAMES: u32 = 1000;

fn backup_name(name: &str, stamp: &str, n: u32) -> String {
    if n == 1 {
        format!("{name}.bak-{stamp}")
    } else {
        format!("{name}.bak-{stamp}-{n}")
    }
}

/// Copy the key file `path`, byte for byte, to a new `<name>.bak-<stamp>` beside it (0600),
/// never over an existing file. `None` when there is no file. Fails when it exists but can't
/// be read or copied, so nothing replaces it.
fn keep_file(path: &std::path::Path, stamp: &str) -> Result<Option<PathBuf>> {
    use std::io::Write as _;
    let bytes = match std::fs::read(path) {
        Ok(b) => zeroize::Zeroizing::new(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(e).with_context(|| {
                format!(
                    "reading {} to keep a copy before replacing it",
                    path.display()
                )
            })
        }
    };
    let name = path
        .file_name()
        .with_context(|| format!("{} names no file", path.display()))?
        .to_string_lossy()
        .into_owned();
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    for n in 1..=BACKUP_NAMES {
        let backup = path.with_file_name(backup_name(&name, stamp, n));
        let mut f = match opts.open(&backup) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(e).with_context(|| format!("keeping a copy at {}", backup.display()))
            }
        };
        if let Err(e) = f.write_all(&bytes).and_then(|()| f.sync_all()) {
            drop(f);
            let _ = std::fs::remove_file(&backup);
            return Err(e).with_context(|| format!("keeping a copy at {}", backup.display()));
        }
        return Ok(Some(backup));
    }
    anyhow::bail!(
        "no free name to keep a copy of {} (tried {BACKUP_NAMES})",
        path.display()
    )
}

/// Copy dg's keychain entry `acct` to a new account `<acct>.bak-<stamp>`, never over an existing
/// entry. `None` when there is no entry. Fails when it can't be read or copied.
fn keep_keychain_entry(acct: &str, stamp: &str, new: &str) -> Result<Option<String>> {
    let Some(value) = keychain::get(keychain::SERVICE, acct)
        .context("reading the keychain entry to keep a copy before replacing it")?
    else {
        return Ok(None);
    };
    if value.expose() == new {
        return Ok(None);
    }
    keep_keychain_copy(keychain::SERVICE, acct, &value, stamp).map(Some)
}

/// Copy `value` (the entry `svc`/`acct` holds) to a new account `<acct>.bak-<stamp>` of `svc`,
/// never over an existing entry. Returns that account.
fn keep_keychain_copy(svc: &str, acct: &str, value: &Secret, stamp: &str) -> Result<String> {
    for n in 1..=BACKUP_NAMES {
        let backup = backup_name(acct, stamp, n);
        if keychain::get(svc, &backup)?.is_some() {
            continue;
        }
        keychain::set(svc, &backup, value.expose())?;
        return Ok(backup);
    }
    anyhow::bail!("no free keychain account to keep a copy of {acct} (tried {BACKUP_NAMES})")
}

/// The line printed before the key file's passphrase is asked for: why there is one, and when
/// it is asked again.
fn passphrase_reason(why: &str) -> String {
    let why = crate::repo_settings::capitalize(why);
    format!(
        "{why}: choose a passphrase to seal it. dg asks for it when a command needs the key (DASH_FORGE_PASSPHRASE gives it to scripts)."
    )
}

/// A storer that writes back to `source` when it is this identity's main slot (dg's own
/// keychain entry, or its passphrase-sealed key file), else `None` (a key file or inline key of
/// the user's own, or a plaintext one: those are left alone). The keychain entry is written to
/// the keychain again, the sealed file to a sealed file.
pub fn main_slot_storer(network: &str, identity_id: &str, source: &str) -> Result<Option<Storer>> {
    if source == main_keychain_source(network, identity_id) {
        return Ok(Some(Storer::new(false)));
    }
    let main = slot_file(network, identity_id, Slot::Main)?;
    let sealed_here = std::path::Path::new(source) == main
        && std::fs::read_to_string(&main).is_ok_and(|raw| sealed::is_sealed(&raw));
    Ok(sealed_here.then(|| Storer::sealed_only(false)))
}

fn main_keychain_source(network: &str, identity_id: &str) -> String {
    format!(
        "{}{}/{}",
        keystore::KEYCHAIN_PREFIX,
        keychain::SERVICE,
        account(network, identity_id, Slot::Main)
    )
}

impl Storer {
    /// The key sources in `identity_id`'s main slot on `network` that [`Storer::store`] would
    /// overwrite (after keeping a copy): dg's keychain entry when the keychain takes the key and
    /// an entry is there, else the key file when it exists. An entry that cannot be read is left
    /// as it is and the key goes to the file, so the file is what is overwritten then.
    /// A later main-slot store refuses to write over a key file this did not name (the keychain
    /// refused the key, and the file holds a key nobody was asked about).
    pub fn main_slot_replaced(&mut self, network: &str, identity_id: &str) -> Result<Vec<String>> {
        let predicted = self.predict_main(network, identity_id)?;
        self.guarded_main = Some(predicted.clone());
        Ok(predicted)
    }

    /// Key sources the caller opened and found to hold no master key: a main-slot fallback may
    /// write over them (after keeping a copy) whatever passphrase this run seals with.
    pub fn may_replace(&mut self, sources: impl IntoIterator<Item = String>) {
        if let Some(guarded) = self.guarded_main.as_mut() {
            guarded.extend(sources);
        }
    }

    fn predict_main(&self, network: &str, identity_id: &str) -> Result<Vec<String>> {
        if !self.no_keychain && keychain::available() {
            match keychain::get(
                keychain::SERVICE,
                &account(network, identity_id, Slot::Main),
            ) {
                Ok(Some(_)) => return Ok(vec![main_keychain_source(network, identity_id)]),
                Ok(None) => return Ok(Vec::new()),
                Err(_) => {}
            }
        }
        let file = slot_file(network, identity_id, Slot::Main)?;
        Ok(if file.exists() {
            vec![file.to_string_lossy().into_owned()]
        } else {
            Vec::new()
        })
    }
}

/// Whether `source` is `identity_id`'s main-slot key file on `network`, which `dg auth logout`
/// removes, after copying it when it holds a master key ([`remove`]).
pub fn is_main_slot_file(network: &str, identity_id: &str, source: &str) -> bool {
    slot_file(network, identity_id, Slot::Main).is_ok_and(|f| {
        let real = |p: &std::path::Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.into());
        real(&f) == real(std::path::Path::new(source))
    })
}

/// Whether a limited key can be stored here without failing: in the keychain, unencrypted
/// (`insecure_plaintext`), or sealed under a passphrase that can be had ([`Storer::store`]).
pub fn can_store(insecure_plaintext: bool) -> bool {
    keychain::available() || insecure_plaintext || sealed::passphrase_available()
}

/// Store a limited key in the main slot (one-off).
pub fn store(
    network: &str,
    identity_id: &str,
    text: &Secret,
    insecure_plaintext: bool,
) -> Result<Stored> {
    Storer::new(insecure_plaintext).store(network, identity_id, text, Slot::Main)
}

/// Move a key from the pending slot to the main slot (the chain has confirmed it), then drop
/// the pending copy this storer staged (only that one: a pending key an earlier run left in
/// the other place may be live on chain). Returns where the main copy is.
pub fn promote(
    storer: &mut Storer,
    network: &str,
    identity_id: &str,
    text: &Secret,
) -> Result<Stored> {
    let main = storer.store(network, identity_id, text, Slot::Main)?;
    if let Some((stored, staged)) = storer.staged.take() {
        let _lock = identity_lock(network, identity_id).ok();
        discard(&stored, &staged, storer.pass.as_ref());
    }
    Ok(main)
}

/// Delete one stored copy, best effort, and only while it still holds `key` (another sign-in
/// may have staged its own key there since).
fn discard(stored: &Stored, key: &Secret, pass: Option<&Secret>) {
    match stored {
        Stored::Keychain { source } => {
            if let Some((svc, acct)) = keystore::parse_keychain_source(source) {
                if keychain::get(svc, acct)
                    .is_ok_and(|v| v.is_some_and(|v| v.expose() == key.expose()))
                {
                    let _ = keychain::delete(svc, acct);
                }
            }
        }
        Stored::Plaintext(p) => {
            if std::fs::read(p)
                .is_ok_and(|b| zeroize::Zeroizing::new(b).as_slice() == key.expose().as_bytes())
            {
                let _ = std::fs::remove_file(p);
            }
        }
        Stored::Sealed(p) => {
            if pass.is_some_and(|pass| sealed_holds(p, pass, key)) {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

/// Before the sealed file `path` is replaced by `sealed_text` (`text` sealed with `pass`), keep
/// a copy of it, unless it already opens with `pass` to `text`.
fn keep_before_sealing(
    path: &std::path::Path,
    pass: &Secret,
    text: &Secret,
    sealed_text: &[u8],
    slot: Slot,
) -> Result<()> {
    if sealed_holds(path, pass, text) {
        return Ok(());
    }
    keep_replaced_file(path, sealed_text, slot)
}

/// Whether the sealed file `path` opens with `pass` to exactly `key`.
fn sealed_holds(path: &std::path::Path, pass: &Secret, key: &Secret) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| sealed::open(&raw, pass.expose()).ok())
        .is_some_and(|plain| plain.as_slice() == key.expose().as_bytes())
}

/// An exclusive lock on `identities/<network>-<id>.lock`, held while a key for that identity is
/// copied and written. The file is never removed.
fn identity_lock(network: &str, identity_id: &str) -> Result<std::fs::File> {
    let path = key_file(network, identity_id)?.with_extension("lock");
    if let Some(dir) = path.parent() {
        keystore::ensure_private_dir(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let file = std::fs::File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    match file.lock() {
        Ok(()) => {}
        // A filesystem without locks (some network or FUSE mounts): store unlocked, as before.
        Err(e) if e.kind() == std::io::ErrorKind::Unsupported => {
            eprintln!(
                "note: {} can't be locked here ({e}); storing without it",
                path.display()
            );
        }
        Err(e) => return Err(e).with_context(|| format!("locking {}", path.display())),
    }
    Ok(file)
}

/// What [`remove`] did.
#[derive(Debug, Default)]
pub struct Removed {
    /// What was removed.
    pub removed: Vec<String>,
    /// The copies kept first, of keys that hold a master key or that dg could not open.
    pub kept: Vec<KeptCopy>,
}

/// A copy [`remove`] kept of a key before removing it.
#[derive(Debug, PartialEq, Eq)]
pub struct KeptCopy {
    /// The copy, as a key source (`--identity` takes it).
    pub at: String,
    /// Whether the key holds a master key or recovery words (else dg could not open it).
    pub master: bool,
}

/// Whether the stored key text `raw` holds a master key or recovery words: `Some(false)` only
/// when it opens as a key without either. `opened` is the identity this run loaded from it.
fn holds_master(raw: &str, opened: Option<&keystore::BridgeIdentity>) -> Option<bool> {
    let parsed = keystore::BridgeIdentity::from_source_text(raw).ok();
    parsed
        .as_ref()
        .or(opened)
        .map(|b| b.master_key().is_some() || !b.mnemonic.expose().trim().is_empty())
}

/// A key this run opened from a file, with the file's bytes it was opened from.
#[derive(Clone, Copy)]
pub struct OpenedFile<'a> {
    /// What the file opened to.
    pub key: &'a keystore::BridgeIdentity,
    /// The file's bytes when it was opened.
    pub bytes: &'a [u8],
}

/// Remove what [`store`] wrote for `identity_id` on `network` (keychain entries and key files,
/// main, pending and sync), and the keychain entry `source` names if it is another one. An
/// identity key that holds a master key, or that dg cannot open to check (a sealed file this run
/// did not open, or that changed since), is copied first ([`keep_file`], [`keep_keychain_copy`])
/// and stays if that fails. Fails if an entry exists but could not be removed.
pub fn remove(
    network: &str,
    identity_id: &str,
    source: Option<&str>,
    opened: Option<OpenedFile<'_>>,
) -> Result<Removed> {
    let _lock = identity_lock(network, identity_id).ok();
    let mut done = Removed::default();
    let stamp = backup_stamp();
    let sync_acct = account(network, identity_id, Slot::Sync);
    let mut entries: Vec<(String, String)> = [Slot::Main, Slot::Pending, Slot::Sync]
        .iter()
        .map(|s| {
            (
                keychain::SERVICE.to_string(),
                account(network, identity_id, *s),
            )
        })
        .collect();
    let named = source.and_then(keystore::parse_keychain_source);
    if let Some((svc, acct)) = named {
        if !entries.iter().any(|(s, a)| s == svc && a == acct) {
            entries.push((svc.to_string(), acct.to_string()));
        }
    }
    let mut failures = Vec::new();
    for (svc, acct) in &entries {
        if !(svc == keychain::SERVICE && *acct == sync_acct) {
            let kept = match keychain::get(svc, acct) {
                Ok(Some(v)) => match holds_master(v.expose(), None) {
                    Some(false) => Ok(None),
                    master => keep_keychain_copy(svc, acct, &v, &stamp).map(|at| {
                        Some(KeptCopy {
                            at: format!("{}{svc}/{at}", keystore::KEYCHAIN_PREFIX),
                            master: master.is_some(),
                        })
                    }),
                },
                Ok(None) => Ok(None),
                Err(e) => Err(e.into()),
            };
            match kept {
                Ok(kept) => done.kept.extend(kept),
                Err(e) => {
                    failures.push(format!("{e:#} (it is left as it is)"));
                    continue;
                }
            }
        }
        // Tried even with the keychain switched off: the entry may predate the switch.
        match keychain::delete(svc, acct) {
            Ok(true) => done
                .removed
                .push(format!("{} entry {svc}/{acct}", keychain::store_name())),
            Ok(false) => {}
            Err(e) => failures.push(format!("{e}")),
        }
    }
    let keychain_failed = !failures.is_empty();
    let mut file_failed = false;
    for slot in [Slot::Main, Slot::Pending, Slot::Sync] {
        let path = slot_file(network, identity_id, slot)?;
        if !path.exists() {
            continue;
        }
        match remove_key_file(&path, slot, opened, &stamp, &mut done.kept) {
            Ok(()) => done.removed.push(path.display().to_string()),
            Err(e) => {
                failures.push(format!("{e:#}"));
                file_failed = true;
            }
        }
    }
    if !failures.is_empty() {
        let mut u = UserError::new(codes::IDENTITY_UNREADABLE, "the stored key was not removed")
            .cause(failures.join("; "));
        if keychain_failed {
            u = u.fix("unlock the keychain and run `dg auth logout` again, or delete the entry in Keychain Access");
        }
        if file_failed {
            u = u.fix(
                "check that you can read and delete the key file, and run `dg auth logout` again",
            );
        }
        if !done.kept.is_empty() {
            let at: Vec<&str> = done.kept.iter().map(|k| k.at.as_str()).collect();
            u = u.note(format!("copies were kept at {}", at.join(", ")));
        }
        return Err(u.into());
    }
    Ok(done)
}

/// Remove the key file `path` of `slot`, after copying it beside it ([`keep_file`]) when it is an
/// identity key that holds a master key or that does not open (`opened`: what this run loaded,
/// used only while the file still holds the bytes it was loaded from).
fn remove_key_file(
    path: &std::path::Path,
    slot: Slot,
    opened: Option<OpenedFile<'_>>,
    stamp: &str,
    kept: &mut Vec<KeptCopy>,
) -> Result<()> {
    if slot != Slot::Sync {
        let raw = std::fs::read(path)
            .map(zeroize::Zeroizing::new)
            .with_context(|| format!("reading {} to check for a master key", path.display()))?;
        let opened = opened.filter(|o| o.bytes == raw.as_slice()).map(|o| o.key);
        let master = holds_master(std::str::from_utf8(&raw).unwrap_or_default(), opened);
        if master != Some(false) {
            let at = keep_file(path, stamp)?
                .with_context(|| format!("{} went away while it was copied", path.display()))?;
            kept.push(KeptCopy {
                at: at.display().to_string(),
                master: master.is_some(),
            });
        }
    }
    std::fs::remove_file(path).with_context(|| format!("removing {}", path.display()))
}

/// Record `source` as the default identity for the context's network (config.toml), with the
/// network settings the next command needs to reconnect.
pub fn set_default(ctx: &Ctx, identity_id: &str, source: &str) -> Result<()> {
    // An unreadable config is reported, not silently replaced by a default one.
    let mut config = Config::load()?;
    config.network = Some(ctx.network().kind().to_string());
    config.devnet_name = ctx.network().devnet_name().map(str::to_string);
    config.dapi_addresses = super::explicit_dapi_addresses(ctx.network());
    config.default_identity = Some(source.to_string());
    config.default_identity_id = Some(identity_id.to_string());
    config.save()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #664 review: the keychain refusing the key never writes over a master key (or a key that
    /// does not open) nobody was asked about; a limited key there is replaced as usual.
    #[test]
    fn the_keychain_fallback_never_writes_over_a_master_key_unasked() {
        // the testnet WIF of 0x11..11 (.gitleaks.toml lists it as a public example)
        let wif = "cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw";
        let master = &serde_json::json!({
            "network": "testnet",
            "identityId": "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB",
            "identityKeys": [{
                "id": 0, "name": "Master", "keyType": "ECDSA_SECP256K1", "purpose": "AUTHENTICATION",
                "securityLevel": "MASTER", "privateKeyWif": wif,
                "privateKeyHex": "", "publicKeyHex": "", "derivationPath": ""
            }],
            "mnemonic": "",
            "assetLockKey": { "wif": "", "publicKeyHex": "", "derivationPath": "" }
        })
        .to_string();
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("testnet-X.key");
        let named = file.to_string_lossy().into_owned();
        let pass = Secret::new("test-passphrase-1");
        let refused = |pass: Option<&Secret>| unguarded_overwrite(Some(&[]), &file, pass);
        assert!(refused(None).is_none(), "no file yet");
        std::fs::write(&file, master).unwrap();
        assert!(keystore::BridgeIdentity::from_source_text(master)
            .unwrap()
            .master_key()
            .is_some());
        let u = refused(None).expect("a master key is refused");
        assert_eq!(u.code, codes::USAGE);
        assert!(
            u.cause
                .as_deref()
                .unwrap()
                .contains("this identity's master key"),
            "{u:?}"
        );
        std::fs::write(
            &file,
            sealed::seal(master.as_bytes(), "test-passphrase-1").unwrap(),
        )
        .unwrap();
        assert!(
            refused(Some(&pass)).is_some_and(|u| u
                .cause
                .as_deref()
                .unwrap()
                .contains("this identity's master key")),
            "a sealed master key"
        );
        assert!(
            refused(None).is_some(),
            "a sealed file without its passphrase"
        );
        // a limited key (a wallet key an earlier fallback stored) is replaced as usual
        let limited = &format!("dfk1:testnet:8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB:5:{wif}");
        assert!(keystore::BridgeIdentity::from_source_text(limited).is_ok());
        std::fs::write(&file, limited).unwrap();
        assert!(refused(None).is_none(), "a plain limited key");
        std::fs::write(
            &file,
            sealed::seal(limited.as_bytes(), "test-passphrase-1").unwrap(),
        )
        .unwrap();
        assert!(refused(Some(&pass)).is_none(), "a sealed limited key");
        assert!(
            refused(Some(&Secret::new("other-passphrase-2"))).is_some_and(|u| u
                .cause
                .as_deref()
                .unwrap()
                .contains("another passphrase")),
            "another passphrase"
        );
        // ...unless wallet login already opened it as a limited key (with its own passphrase)
        let mut storer = Storer::new(false);
        storer.guarded_main = Some(Vec::new());
        storer.may_replace([file.to_string_lossy().into_owned()]);
        assert!(
            unguarded_overwrite(
                storer.guarded_main.as_deref(),
                &file,
                Some(&Secret::new("other-passphrase-2"))
            )
            .is_none(),
            "a key login opened as limited, sealed with another passphrase than this run's"
        );
        std::fs::write(&file, master).unwrap();
        assert!(
            unguarded_overwrite(Some(&[named]), &file, None).is_none(),
            "the guard asked about it"
        );
        assert!(
            unguarded_overwrite(None, &file, None).is_none(),
            "a store the guard did not predict"
        );
    }

    /// QW4-058: the passphrase prompt is introduced by why it is asked.
    #[test]
    fn the_passphrase_prompt_says_why() {
        let line = passphrase_reason(
            "there is no OS keychain here, so the key goes to a passphrase-encrypted file",
        );
        assert!(
            line.starts_with("There is no OS keychain here, so the key goes to a passphrase-encrypted file: choose a passphrase"),
            "{line}"
        );
        assert!(line.contains("DASH_FORGE_PASSPHRASE"), "{line}");
    }

    #[test]
    fn the_sync_slot_is_where_forge_core_reads_the_sync_key() {
        use forge_core::user_sync::key;
        for network in ["testnet", "devnet-sakura"] {
            assert_eq!(
                account(network, "ID", Slot::Sync),
                key::keychain_account(network, "ID")
            );
            assert_eq!(
                slot_file(network, "ID", Slot::Sync).ok(),
                key::key_file(network, "ID")
            );
        }
    }

    #[test]
    fn stored_sources_and_descriptions() {
        let k = Stored::Keychain {
            source: keystore::keychain_source("testnet", "ID"),
        };
        assert_eq!(k.source(), "keychain:dash-forge/testnet/ID");
        assert!(k.describe().contains("dash-forge/testnet/ID"));
        assert_eq!(k.kind(), "keychain");
        let (d, kind) = describe_source("dfk1:testnet:ID:5:cWIF");
        assert_eq!(kind, "inline");
        assert!(!d.contains("cWIF"));
    }

    fn backups_of(path: &std::path::Path) -> Vec<PathBuf> {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let mut found: Vec<PathBuf> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(&format!("{name}.bak-"))
            })
            .collect();
        found.sort();
        found
    }

    /// A master key, a limited key and a file that opens as no key are each copied byte for byte,
    /// 0600, beside the file, before anything replaces it.
    #[test]
    fn a_key_file_is_copied_byte_for_byte() {
        let master = br#"{"identityId":"X","identityKeys":[{"id":0,"purpose":"AUTHENTICATION","securityLevel":"MASTER","privateKeyWif":"cMASTER"}]}"#.to_vec();
        let limited = b"dfk1:testnet:X:5:cLIMITED".to_vec();
        let unreadable = vec![0xff, 0x00, 0xfe, b'\n', 0x80];
        for bytes in [master, limited, unreadable] {
            let t = tempfile::tempdir().unwrap();
            let file = t.path().join("testnet-X.key");
            std::fs::write(&file, &bytes).unwrap();
            let kept = keep_file(&file, "20261125T120000Z").unwrap().unwrap();
            assert_eq!(
                kept.file_name().unwrap(),
                "testnet-X.key.bak-20261125T120000Z"
            );
            assert_eq!(std::fs::read(&kept).unwrap(), bytes);
            assert_eq!(std::fs::read(&file).unwrap(), bytes, "the original stays");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                let mode = std::fs::metadata(&kept).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600);
            }
        }
    }

    #[test]
    fn no_file_means_nothing_to_keep() {
        let t = tempfile::tempdir().unwrap();
        assert!(
            keep_file(&t.path().join("testnet-X.key"), "20261125T120000Z")
                .unwrap()
                .is_none()
        );
    }

    /// Two replacements in a row (in the same second, or later) keep both copies, and an
    /// existing backup is never written over.
    #[test]
    fn a_backup_is_never_overwritten() {
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("testnet-X.key");
        std::fs::write(&file, b"first").unwrap();
        let one = keep_file(&file, "20261125T120000Z").unwrap().unwrap();
        std::fs::write(&file, b"second").unwrap();
        let two = keep_file(&file, "20261125T120000Z").unwrap().unwrap();
        std::fs::write(&file, b"third").unwrap();
        let three = keep_file(&file, "20261125T120001Z").unwrap().unwrap();
        assert_eq!(
            two.file_name().unwrap(),
            "testnet-X.key.bak-20261125T120000Z-2"
        );
        assert_eq!(std::fs::read(&one).unwrap(), b"first");
        assert_eq!(std::fs::read(&two).unwrap(), b"second");
        assert_eq!(std::fs::read(&three).unwrap(), b"third");
        assert_eq!(backups_of(&file), vec![one, two, three]);
    }

    /// A key file that exists but can't be read is not replaced: keeping the copy fails first.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_key_file_stops_the_replacement() {
        use std::os::unix::fs::PermissionsExt as _;
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("testnet-X.key");
        std::fs::write(&file, b"secret").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&file).is_ok() {
            return; // running as root: every file reads
        }
        assert!(keep_file(&file, "20261125T120000Z").is_err());
        assert!(backups_of(&file).is_empty());
    }

    /// Promotion deletes only the pending copy this run staged: a pending key an earlier run
    /// left in the other place (possibly live on chain) stays.
    #[test]
    fn promotion_discards_only_the_staged_copy() {
        let t = tempfile::tempdir().unwrap();
        let staged = t.path().join("testnet-X.key.pending");
        let earlier = t.path().join("testnet-Y.key.pending");
        std::fs::write(&staged, b"this run").unwrap();
        std::fs::write(&earlier, b"an earlier run").unwrap();
        let key = Secret::new("this run");
        std::fs::write(&earlier, b"an earlier run").unwrap();
        discard(&Stored::Plaintext(staged.clone()), &key, None);
        assert!(!staged.exists());
        assert_eq!(std::fs::read(&earlier).unwrap(), b"an earlier run");
        // Another sign-in staged its own key in the same place since: it stays.
        std::fs::write(&staged, b"another run").unwrap();
        discard(&Stored::Plaintext(staged.clone()), &key, None);
        assert_eq!(std::fs::read(&staged).unwrap(), b"another run");
        // A sealed copy is removed only when it opens to this run's key.
        let pass = Secret::new("test-passphrase");
        let sealed = t.path().join("testnet-Z.key.pending");
        std::fs::write(
            &sealed,
            sealed::seal(b"another run", "test-passphrase").unwrap(),
        )
        .unwrap();
        discard(&Stored::Sealed(sealed.clone()), &key, Some(&pass));
        assert!(sealed.exists());
        std::fs::write(
            &sealed,
            sealed::seal(b"this run", "test-passphrase").unwrap(),
        )
        .unwrap();
        assert!(sealed_holds(&sealed, &pass, &key));
        discard(&Stored::Sealed(sealed.clone()), &key, Some(&pass));
        assert!(!sealed.exists());
    }

    /// Writing the same bytes again keeps no copy; different bytes do. A sync key's copy is not
    /// an identity key source, so it stays out of `previousKeyKeptAt`.
    #[test]
    fn only_a_different_key_is_copied() {
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("testnet-X.key");
        std::fs::write(&file, b"same").unwrap();
        keep_replaced_file(&file, b"same", Slot::Main).unwrap();
        assert!(backups_of(&file).is_empty());
        let sync = t.path().join("testnet-X.key.sync");
        std::fs::write(&sync, b"fue1:old").unwrap();
        keep_replaced_file(&sync, b"fue1:new", Slot::Sync).unwrap();
        assert_eq!(backups_of(&sync).len(), 1);
        assert!(!kept_this_run()
            .iter()
            .any(|k| k.contains("testnet-X.key.sync")));
        keep_replaced_file(&file, b"different", Slot::Main).unwrap();
        let kept = backups_of(&file);
        assert_eq!(kept.len(), 1);
        assert_eq!(std::fs::read(&kept[0]).unwrap(), b"same");
        assert!(kept_this_run().contains(&kept[0].display().to_string()));
    }

    /// The sealed path: storing the same key again under the same passphrase keeps no copy;
    /// a different key, or a file the passphrase doesn't open, is copied first.
    #[test]
    fn a_sealed_key_is_copied_unless_it_is_the_same_key() {
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("testnet-S.key");
        let pass = Secret::new("test-passphrase");
        let key = Secret::new("dfk1:testnet:S:5:cKEY");
        let sealed_key = sealed::seal(key.expose().as_bytes(), pass.expose()).unwrap();
        std::fs::write(&file, &sealed_key).unwrap();
        let again = sealed::seal(key.expose().as_bytes(), pass.expose()).unwrap();
        keep_before_sealing(&file, &pass, &key, again.as_bytes(), Slot::Main).unwrap();
        assert!(
            backups_of(&file).is_empty(),
            "a repeated import keeps no copy"
        );

        let other = sealed::seal(b"another key", "another-passphrase").unwrap();
        std::fs::write(&file, &other).unwrap();
        keep_before_sealing(&file, &pass, &key, again.as_bytes(), Slot::Main).unwrap();
        let kept = backups_of(&file);
        assert_eq!(kept.len(), 1, "a file this passphrase can't open is copied");
        assert_eq!(std::fs::read_to_string(&kept[0]).unwrap(), other);

        std::fs::write(&file, &sealed_key).unwrap();
        let new_key = Secret::new("dfk1:testnet:S:6:cNEW");
        let sealed_new = sealed::seal(new_key.expose().as_bytes(), pass.expose()).unwrap();
        keep_before_sealing(&file, &pass, &new_key, sealed_new.as_bytes(), Slot::Main).unwrap();
        assert_eq!(backups_of(&file).len(), 2, "a different key is copied");
    }

    /// The stamp backups are named after is a UTC time that sorts.
    #[test]
    fn the_backup_stamp_is_a_utc_time() {
        let s = backup_stamp();
        assert_eq!(s.len(), 16, "{s}");
        assert!(s.ends_with('Z') && s.as_bytes()[8] == b'T', "{s}");
    }

    /// The testnet WIF of 0x11..11 (.gitleaks.toml lists it as a public example).
    const WIF: &str = "cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw";
    const ID: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";

    fn master_json() -> String {
        serde_json::json!({
            "network": "testnet",
            "identityId": ID,
            "identityKeys": [{
                "id": 0, "name": "Master", "keyType": "ECDSA_SECP256K1", "purpose": "AUTHENTICATION",
                "securityLevel": "MASTER", "privateKeyWif": WIF,
                "privateKeyHex": "", "publicKeyHex": "", "derivationPath": ""
            }],
            "mnemonic": "",
            "assetLockKey": { "wif": "", "publicKeyHex": "", "derivationPath": "" }
        })
        .to_string()
    }

    fn limited_text() -> String {
        format!("dfk1:testnet:{ID}:5:{WIF}")
    }

    /// A master key (or recovery words) counts; a limited key does not; what does not open is
    /// unknown unless this run opened it.
    #[test]
    fn what_holds_a_master_key() {
        let master = master_json();
        let limited_key = limited_text();
        assert_eq!(holds_master(&master, None), Some(true));
        assert_eq!(holds_master(&limited_key, None), Some(false));
        let mut words: serde_json::Value = serde_json::from_str(&master).unwrap();
        words["identityKeys"][0]["privateKeyWif"] = "".into();
        words["mnemonic"] = "abandon abandon abandon".into();
        assert_eq!(holds_master(&words.to_string(), None), Some(true));
        let sealed = sealed::seal(limited_key.as_bytes(), "test-passphrase").unwrap();
        assert_eq!(holds_master(&sealed, None), None);
        assert_eq!(holds_master("", None), None);
        let limited = keystore::BridgeIdentity::from_source_text(&limited_key).unwrap();
        let full = keystore::BridgeIdentity::from_source_text(&master).unwrap();
        assert_eq!(holds_master(&sealed, Some(&limited)), Some(false));
        assert_eq!(holds_master(&sealed, Some(&full)), Some(true));
    }

    #[derive(Debug, Clone, Copy)]
    enum Logout {
        Removed,
        KeptMaster,
        KeptUnopened,
    }

    /// `dg auth logout` never loses a master key: a key file holding one, one it could not open,
    /// or one that changed since it was opened, is copied beside it (0600, byte for byte) before
    /// it is removed; a limited key and the sync key are just removed.
    #[test]
    fn logout_keeps_a_copy_of_a_master_key_file() {
        let master = master_json();
        let limited_key = limited_text();
        let sealed_limited = sealed::seal(limited_key.as_bytes(), "test-passphrase").unwrap();
        let sealed_master = sealed::seal(master.as_bytes(), "test-passphrase").unwrap();
        let limited = keystore::BridgeIdentity::from_source_text(&limited_key).unwrap();
        let full = keystore::BridgeIdentity::from_source_text(&master).unwrap();
        let check = |what: &str,
                     bytes: &str,
                     slot: Slot,
                     opened: Option<(&keystore::BridgeIdentity, &str)>,
                     want: Logout| {
            let t = tempfile::tempdir().unwrap();
            let file = t.path().join(format!("testnet-X.key{}", slot.suffix()));
            std::fs::write(&file, bytes).unwrap();
            let opened = opened.map(|(key, from)| OpenedFile {
                key,
                bytes: from.as_bytes(),
            });
            let mut kept = Vec::new();
            remove_key_file(&file, slot, opened, "20261127T120000Z", &mut kept).unwrap();
            assert!(!file.exists(), "{what}");
            let master = match want {
                Logout::Removed => {
                    assert!(kept.is_empty(), "{what}");
                    assert!(backups_of(&file).is_empty(), "{what}");
                    return;
                }
                Logout::KeptMaster => true,
                Logout::KeptUnopened => false,
            };
            let copy = format!("{}.bak-20261127T120000Z", file.display());
            assert_eq!(
                kept,
                [KeptCopy {
                    at: copy.clone(),
                    master
                }],
                "{what}"
            );
            assert_eq!(std::fs::read_to_string(&copy).unwrap(), bytes, "{what}");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                let mode = std::fs::metadata(&copy).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600, "{what}");
            }
        };
        let main = Slot::Main;
        check("plain master", &master, main, None, Logout::KeptMaster);
        check("plain limited", &limited_key, main, None, Logout::Removed);
        check(
            "sealed, not opened",
            &sealed_limited,
            main,
            None,
            Logout::KeptUnopened,
        );
        let opened_limited = Some((&limited, sealed_limited.as_str()));
        check(
            "sealed, opened",
            &sealed_limited,
            main,
            opened_limited,
            Logout::Removed,
        );
        let stale = Some((&limited, sealed_limited.as_str()));
        check(
            "changed since opened",
            &sealed_master,
            main,
            stale,
            Logout::KeptUnopened,
        );
        let opened_master = Some((&full, sealed_master.as_str()));
        check(
            "sealed master",
            &sealed_master,
            main,
            opened_master,
            Logout::KeptMaster,
        );
        check(
            "pending master",
            &master,
            Slot::Pending,
            None,
            Logout::KeptMaster,
        );
        check(
            "sync key",
            "fue1:testnet:X:1:00",
            Slot::Sync,
            None,
            Logout::Removed,
        );
    }

    /// A key file `dg auth logout` can't read to check (or copy) is not removed.
    #[cfg(unix)]
    #[test]
    fn logout_leaves_a_key_file_it_cannot_read() {
        use std::os::unix::fs::PermissionsExt as _;
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("testnet-X.key");
        std::fs::write(&file, master_json()).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&file).is_ok() {
            return; // running as root: every file reads
        }
        let mut kept = Vec::new();
        assert!(remove_key_file(&file, Slot::Main, None, "20261127T120000Z", &mut kept).is_err());
        assert!(file.exists());
        assert!(kept.is_empty());
    }

    /// #768: once the keychain failed to take the sync key, the sealed file is used only when no
    /// entry is there to hide it.
    #[test]
    fn a_failed_keychain_falls_back_to_the_sync_file_only_without_an_entry() {
        let key = Secret::new("fue1:testnet:X:1:00");
        assert_eq!(sync_fallback(Ok(None), &key), SyncFallback::File);
        assert_eq!(
            sync_fallback(Ok(Some(Secret::new("fue1:testnet:X:1:00"))), &key),
            SyncFallback::InKeychain
        );
        assert_eq!(
            sync_fallback(Ok(Some(Secret::new("fue1:testnet:X:0:11"))), &key),
            SyncFallback::Refuse,
            "an older key there would hide the file"
        );
        assert_eq!(
            sync_fallback(
                Err(forge_core::Error::Config(
                    "could not read keychain entry".into()
                )),
                &key
            ),
            SyncFallback::Refuse,
            "an entry that can't be read may be there"
        );
    }

    /// `dg auth status` with an identity JSON pasted into `DASH_FORGE_KEY` never prints it.
    #[test]
    fn a_pasted_identity_is_never_described() {
        let pasted = r#"{"identityId":"X","identityKeys":[{"privateKeyWif":"cSECRETwif"}]}"#;
        let (d, kind) = describe_source(pasted);
        assert_eq!(kind, "pasted");
        assert!(!d.contains("cSECRET"), "{d}");
    }
}
