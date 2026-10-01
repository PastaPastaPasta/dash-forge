//! L-02: a passphrase-sealed key and `git-remote-dash`, offline (`--check-key` loads the key a
//! push would sign with and touches no network).
//!
//! - `dg` hands the key it unlocked over an inherited pipe, through `git`: the helper signs
//!   with it and asks nothing, with no terminal and no DASH_FORGE_PASSPHRASE.
//! - Without a handoff, and without a terminal, the sealed key is refused with E303 naming the
//!   ways out, not "this command does not prompt; set DASH_FORGE_PASSPHRASE".
//! - The key never appears in the helper's environment.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use forge_core::keystore::Secret;

const ID: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";
/// A throwaway testnet WIF (of the key 0x11…11, never funded): only its format matters to
/// `--check-key`, and a dfk1 key must hold a well-formed one.
const WIF: &str = "cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw";
const PASS: &str = "correct horse battery staple";

fn dfk1() -> String {
    format!("dfk1:devnet-moutai:{ID}:5:{WIF}")
}

/// A scratch HOME / XDG config with a sealed key file recorded as the default, the way
/// `dg auth login` under DASH_FORGE_NO_KEYCHAIN leaves it.
struct Fixture {
    dir: tempfile::TempDir,
    key: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("xdg/dash-forge");
        std::fs::create_dir_all(conf.join("identities")).unwrap();
        // Keep dg's one-time move of a pre-XDG ~/.config/dash-forge from running here.
        std::fs::write(conf.join(".migrated-from-home-config"), "").unwrap();
        let key = conf.join(format!("identities/devnet-moutai-{ID}.key"));
        let sealed = forge_core::sealed::seal(dfk1().as_bytes(), PASS).unwrap();
        std::fs::write(&key, sealed).unwrap();
        std::fs::write(
            conf.join("config.toml"),
            format!(
                "default_identity = {:?}\ndefault_identity_id = {ID:?}\n",
                key.display()
            ),
        )
        .unwrap();
        Self { dir, key }
    }

    /// `git remote-dash --check-key` (git finds the helper on PATH, as for a push) in this
    /// fixture's HOME, with no terminal: stdin is null, and `GIT_TERMINAL_PROMPT=0` stands in
    /// for "no /dev/tty" where the test runner has one.
    fn check_key_cmd(&self) -> Command {
        let helper_dir = Path::new(env!("CARGO_BIN_EXE_git-remote-dash"))
            .parent()
            .unwrap()
            .to_path_buf();
        let path = std::env::join_paths(std::iter::once(helper_dir).chain(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        )))
        .unwrap();
        let mut cmd = Command::new("git");
        cmd.args(["remote-dash", "--check-key"])
            .current_dir(self.dir.path())
            .env_clear()
            .env("PATH", path)
            .env("HOME", self.dir.path())
            .env("XDG_CONFIG_HOME", self.dir.path().join("xdg"))
            .env("DASH_FORGE_NO_KEYCHAIN", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("NO_COLOR", "1")
            .stdin(Stdio::null());
        cmd
    }

    /// [`Self::check_key_cmd`], handing `handoff` over the way `dg` does.
    fn git_check_key(&self, handoff: Option<&str>) -> Output {
        let mut cmd = self.check_key_cmd();
        if let Some(key) = handoff {
            forge_core::key_handoff::attach(&mut cmd, &Secret::new(key)).unwrap();
        }
        cmd.output().unwrap()
    }
}

#[test]
fn a_handed_key_signs_with_no_passphrase_and_no_terminal() {
    let fx = Fixture::new();
    let out = fx.git_check_key(Some(&dfk1()));
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "stdout: {stdout}\nstderr: {stderr}");
    assert!(stdout.contains(ID), "{stdout}");
    assert!(
        !stderr.contains(WIF) && !stdout.contains(WIF),
        "the key is never printed"
    );
}

#[test]
fn a_sealed_key_without_a_terminal_names_the_ways_out() {
    let fx = Fixture::new();
    let out = fx.git_check_key(None);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "{stderr}");
    assert!(stderr.contains("[E303]"), "{stderr}");
    assert!(
        stderr.contains("sealed with a passphrase") && stderr.contains("no terminal"),
        "{stderr}"
    );
    for way in [
        "in a terminal",
        "keychain",
        "`dg init`",
        "DASH_FORGE_PASSPHRASE",
    ] {
        assert!(stderr.contains(way), "names {way:?}: {stderr}");
    }
    assert!(stderr.contains(&fx.key.display().to_string()), "{stderr}");
}

#[test]
fn the_passphrase_variable_still_works_for_scripts() {
    let fx = Fixture::new();
    let out = fx
        .check_key_cmd()
        .env("DASH_FORGE_PASSPHRASE", PASS)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains(ID));
}
