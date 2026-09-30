//! Passphrase-sealed files: identity keys where there is no OS keychain, and the encrypted
//! backups `dg auth export` writes.
//!
//! A sealed file is JSON, so it is recognizable and its parameters travel with it:
//!
//! ```json
//! { "dashForgeSealed": 1, "kdf": "argon2id", "m": 65536, "t": 3, "p": 1,
//!   "salt": "<hex 16>", "cipher": "xchacha20poly1305", "nonce": "<hex 24>",
//!   "ciphertext": "<hex>" }
//! ```
//!
//! The key is Argon2id(passphrase, salt) with the browser vault's parameters (64 MiB, 3
//! passes; ux-dx-spec §2.3), and the plaintext is sealed with XChaCha20-Poly1305. Every header
//! field is bound into the AEAD as associated data, so weakening the KDF parameters in the file
//! makes decryption fail instead of making it cheaper to attack. A wrong passphrase and a
//! modified file both fail the same way.
//!
//! Where the passphrase comes from: the `DASH_FORGE_PASSPHRASE` environment variable (CI,
//! scripts), else a hidden prompt on the terminal (`/dev/tty`, or the Windows console
//! `CONIN$`, so it also works in `git-remote-dash`, whose stdin and stdout belong to git). A `git push` that `dg` runs never
//! asks: `dg` hands the helper the key it already unlocked ([`crate::key_handoff`]).

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::keystore::Secret;

/// Environment variable a passphrase is read from before prompting.
pub const PASSPHRASE_ENV: &str = "DASH_FORGE_PASSPHRASE";

/// Set by a program that must never read from the terminal (the importer, `dg --json`): a
/// sealed file then needs [`PASSPHRASE_ENV`], and no prompt appears. `GIT_TERMINAL_PROMPT=0`
/// has the same effect, so the helper does not ask when git was told not to.
static NO_PROMPT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Never prompt for a passphrase in this process (see [`NO_PROMPT`]).
pub fn forbid_prompts() {
    NO_PROMPT.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Whether prompts are allowed in this process.
pub fn prompts_allowed() -> bool {
    !NO_PROMPT.load(std::sync::atomic::Ordering::Relaxed)
        && std::env::var_os("GIT_TERMINAL_PROMPT").is_none_or(|v| v != "0")
}

/// Whether [`passphrase`] can get a passphrase without failing: [`PASSPHRASE_ENV`] is set, or
/// prompts are allowed and there is a terminal to ask on. Checked before a step that must not
/// fail halfway for want of one.
pub fn passphrase_available() -> bool {
    std::env::var_os(PASSPHRASE_ENV).is_some_and(|v| !v.is_empty())
        || (prompts_allowed() && have_terminal())
}

/// Whether the prompt has a terminal to ask on: the device rpassword reads and writes,
/// `/dev/tty` on Unix and the console `CONIN$` on Windows. Not stdin: under git a helper's
/// stdin is git's pipe, while the terminal is still there to ask on.
pub fn have_terminal() -> bool {
    const TERMINAL: &str = if cfg!(windows) { "CONIN$" } else { "/dev/tty" };
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(TERMINAL)
        .is_ok()
}

/// The shortest passphrase accepted when sealing.
pub const MIN_PASSPHRASE_LEN: usize = 10;

const FORMAT: u32 = 1;
const KDF: &str = "argon2id";
const CIPHER: &str = "xchacha20poly1305";
/// Argon2id memory cost in KiB (64 MiB), passes and lanes: the browser vault's parameters.
const M_COST: u32 = 64 * 1024;
const T_COST: u32 = 3;
const P_COST: u32 = 1;
/// Upper bounds accepted when opening, so a crafted file cannot make `dg` allocate gigabytes.
const MAX_M_COST: u32 = 256 * 1024;
const MAX_T_COST: u32 = 10;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    dash_forge_sealed: u32,
    kdf: String,
    m: u32,
    t: u32,
    p: u32,
    salt: String,
    cipher: String,
    nonce: String,
    ciphertext: String,
}

impl Envelope {
    /// The associated data: every header field, in a fixed order.
    fn aad(&self) -> Vec<u8> {
        format!(
            "dash-forge-sealed/{}/{}/{}/{}/{}/{}/{}/{}",
            self.dash_forge_sealed,
            self.kdf,
            self.m,
            self.t,
            self.p,
            self.salt,
            self.cipher,
            self.nonce
        )
        .into_bytes()
    }
}

/// Whether `raw` is a sealed file (as opposed to plaintext JSON).
pub fn is_sealed(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(raw).is_ok_and(|v| v.get("dashForgeSealed").is_some())
}

fn derive_key(
    passphrase: &str,
    salt: &[u8],
    m: u32,
    t: u32,
    p: u32,
) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(m, t, p, Some(32))
        .map_err(|e| Error::Config(format!("invalid sealed-file parameters: {e}")))?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|e| Error::Config(format!("deriving the key from the passphrase: {e}")))?;
    Ok(key)
}

fn check_len(passphrase: &str) -> Result<()> {
    if passphrase.chars().count() < MIN_PASSPHRASE_LEN {
        return Err(Error::Config(format!(
            "the passphrase must be at least {MIN_PASSPHRASE_LEN} characters"
        )));
    }
    Ok(())
}

/// Seal `plaintext` under `passphrase`, returning the file's JSON text.
pub fn seal(plaintext: &[u8], passphrase: &str) -> Result<String> {
    check_len(passphrase)?;
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let mut env = Envelope {
        dash_forge_sealed: FORMAT,
        kdf: KDF.into(),
        m: M_COST,
        t: T_COST,
        p: P_COST,
        salt: hex::encode(salt),
        cipher: CIPHER.into(),
        nonce: hex::encode(nonce),
        ciphertext: String::new(),
    };
    let key = derive_key(passphrase, &salt, M_COST, T_COST, P_COST)?;
    let cipher = XChaCha20Poly1305::new((&*key).into());
    let aad = env.aad();
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| Error::Config("sealing failed".into()))?;
    env.ciphertext = hex::encode(ct);
    Ok(serde_json::to_string_pretty(&env)?)
}

/// Open a sealed file's JSON text with `passphrase`.
pub fn open(raw: &str, passphrase: &str) -> Result<Zeroizing<Vec<u8>>> {
    let bad = |why: &str| Error::Config(format!("not a readable sealed file: {why}"));
    let env: Envelope = serde_json::from_str(raw).map_err(|_| bad("malformed"))?;
    if env.dash_forge_sealed != FORMAT || env.kdf != KDF || env.cipher != CIPHER {
        return Err(bad("unsupported format version, KDF or cipher"));
    }
    if env.m > MAX_M_COST || env.t > MAX_T_COST || env.p != P_COST {
        return Err(bad("KDF parameters out of range"));
    }
    let salt = hex::decode(&env.salt).map_err(|_| bad("salt"))?;
    let nonce = hex::decode(&env.nonce).map_err(|_| bad("nonce"))?;
    let ct = hex::decode(&env.ciphertext).map_err(|_| bad("ciphertext"))?;
    if nonce.len() != 24 || salt.len() < 16 {
        return Err(bad("salt or nonce length"));
    }
    let key = derive_key(passphrase, &salt, env.m, env.t, env.p)?;
    let cipher = XChaCha20Poly1305::new((&*key).into());
    let aad = env.aad();
    cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ct,
                aad: &aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| Error::WrongPassphrase)
}

/// The passphrase for `what`: [`PASSPHRASE_ENV`] when set, else a hidden prompt on the
/// terminal. `confirm` asks twice (for a new file) and enforces [`MIN_PASSPHRASE_LEN`].
pub fn passphrase(what: &str, confirm: bool) -> Result<Secret> {
    if let Some(p) = std::env::var_os(PASSPHRASE_ENV).filter(|v| !v.is_empty()) {
        let p = p
            .into_string()
            .map_err(|_| Error::Config(format!("{PASSPHRASE_ENV} is not UTF-8")))?;
        return Ok(Secret::new(p));
    }
    if !prompts_allowed() {
        return Err(Error::Config(format!(
            "{what} needs a passphrase and this command does not prompt; set {PASSPHRASE_ENV}"
        )));
    }
    let prompt = |label: &str| {
        rpassword::prompt_password(label).map_err(|e| {
            Error::Config(format!(
                "{what} needs a passphrase and there is no terminal to ask on ({e}); set \
                 {PASSPHRASE_ENV}"
            ))
        })
    };
    let first = Zeroizing::new(prompt(&format!("Passphrase for {what}: "))?);
    if confirm {
        check_len(&first)?;
        let second = Zeroizing::new(prompt("Repeat the passphrase: ")?);
        if *first != *second {
            return Err(Error::Config("the two passphrases differ".into()));
        }
    }
    Ok(Secret::new(first.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASS: &str = "correct horse battery";

    #[test]
    fn round_trips_and_is_recognized() {
        let raw = seal(b"{\"k\":1}", PASS).unwrap();
        assert!(is_sealed(&raw));
        assert!(!is_sealed("{\"identityId\":\"x\"}"));
        assert!(!raw.contains("\"k\""), "plaintext must not appear");
        assert_eq!(open(&raw, PASS).unwrap().as_slice(), b"{\"k\":1}");
    }

    #[test]
    fn a_wrong_passphrase_fails_authentication() {
        let raw = seal(b"secret", PASS).unwrap();
        let err = open(&raw, "wrong passphrase!").unwrap_err().to_string();
        assert!(err.contains("wrong passphrase"), "{err}");
    }

    #[test]
    fn weakening_the_kdf_in_the_header_fails() {
        let raw = seal(b"secret", PASS).unwrap();
        let weakened = raw.replace("\"t\": 3", "\"t\": 1");
        assert_ne!(raw, weakened);
        assert!(open(&weakened, PASS).is_err());
    }

    #[test]
    fn absurd_parameters_are_refused_before_hashing() {
        let raw = seal(b"secret", PASS).unwrap();
        let huge = raw.replace("\"m\": 65536", "\"m\": 4000000000");
        assert!(open(&huge, PASS)
            .unwrap_err()
            .to_string()
            .contains("out of range"));
    }

    #[test]
    fn short_passphrases_are_refused() {
        assert!(seal(b"x", "short").is_err());
    }
}
