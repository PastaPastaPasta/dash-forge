//! QW2-001: `dg` run with piped stdio (as in CI) prints no recovery words and no key.
//!
//! Each command runs with stdin null and stdout/stderr captured, in a scratch HOME, and both
//! streams are grepped for every word of the BIP-39 English list. A word dg prints as part of
//! its own messages is in its source code, so the check is: no BIP-39 word in the output that
//! the dg and forge-core sources never contain. The sources hold about 38% of the list, so
//! twelve leaked words all falling inside it happens about once in 100,000 leaks; a leak in
//! the numbered form `dg auth new` used is also caught on its own, every time.
//! Where the secret is known (a fixture identity, the words in a backup file), its exact
//! words and key are grepped for too.
//!
//! The offline cases need no network: the refusals come before dg connects to anything. The
//! `#[ignore]`d live case drives `dg auth new` against devnet bonsia up to the deposit
//! request, with the words going only to a `--backup-file`:
//!
//! ```sh
//! cargo test -p dg --test no_secrets_on_pipes -- --ignored --nocapture
//! ```
#![cfg(unix)]

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::io::Read as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use forge_core::network::Network;
use forge_core::platform::identity::{new_mnemonic, NewIdentityKeys};

const ID: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";
const RELAY: &str = "3hA7gWZb8CCL2DCUfxbhfsxdYQF7oaFmiNNfs4Hspwmn";
/// Environment variables that mark a CI run (kept in step with `secret_out::CI_MARKERS`):
/// cleared, so these tests exercise the pipe rule alone, and set explicitly where one is needed.
const CI_MARKERS: &[&str] = &[
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "TF_BUILD",
    "JENKINS_URL",
    "TEAMCITY_VERSION",
    "BUILDKITE",
    "CODEBUILD_BUILD_ID",
];

/// Lowercase alphabetic runs of `text` (for the source vocabulary: a superset of its words).
fn tokens(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_ascii_alphabetic())
        .filter(|t| !t.is_empty())
        .map(str::to_ascii_lowercase)
}

/// The whole words of `text`: whitespace-separated, stripped of surrounding punctuation
/// (quotes, commas, a list number's dot), and made only of letters. An address, an id or a
/// path is one token with digits or slashes in it, so it never matches a word by accident.
fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split_whitespace()
        .map(|t| t.trim_matches(|c: char| !c.is_ascii_alphabetic()))
        .filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_alphabetic()))
        .map(str::to_ascii_lowercase)
}

/// Every token of the dg and forge-core sources: the words dg's own messages can contain.
fn source_vocabulary() -> BTreeSet<String> {
    fn walk(dir: &Path, into: &mut BTreeSet<String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, into);
            } else if path.extension().is_some_and(|e| e == "rs") {
                into.extend(tokens(&std::fs::read_to_string(&path).unwrap()));
            }
        }
    }
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut words = BTreeSet::new();
    walk(&crates.join("dg/src"), &mut words);
    walk(&crates.join("forge-core/src"), &mut words);
    words
}

/// BIP-39 words in `text` that no dg message could have put there.
fn foreign_bip39_words(text: &str, vocabulary: &BTreeSet<String>) -> BTreeSet<String> {
    let list: BTreeSet<&str> = bip39::Language::English
        .word_list()
        .iter()
        .copied()
        .collect();
    words(text)
        .filter(|t| list.contains(t.as_str()) && !vocabulary.contains(t))
        .collect()
}

/// A numbered word list ("  3. word") anywhere in `text`: how `dg auth new` shows the words.
fn numbered_bip39_word(text: &str) -> Option<String> {
    let list: BTreeSet<&str> = bip39::Language::English
        .word_list()
        .iter()
        .copied()
        .collect();
    let parts: Vec<&str> = text.split_whitespace().collect();
    parts.windows(2).find_map(|w| {
        let numbered = w[0]
            .strip_suffix('.')
            .is_some_and(|n| n.parse::<u8>().is_ok());
        (numbered && list.contains(w[1])).then(|| format!("{} {}", w[0], w[1]))
    })
}

/// A scratch HOME with XDG directories under it.
struct Home {
    dir: tempfile::TempDir,
}

impl Home {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("xdg/dash-forge");
        std::fs::create_dir_all(&conf).unwrap();
        // Keep dg's one-time move of a pre-XDG ~/.config/dash-forge from running here.
        std::fs::write(conf.join(".migrated-from-home-config"), "").unwrap();
        Self { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// `dg <args>` with no terminal anywhere: stdin null, stdout and stderr piped.
    fn dg(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_dg"));
        cmd.args(args)
            .current_dir(self.dir.path())
            .env("HOME", self.dir.path())
            .env("XDG_CONFIG_HOME", self.path("xdg"))
            .env("XDG_STATE_HOME", self.path("state"))
            .env("XDG_CACHE_HOME", self.path("cache"))
            .env("DASH_FORGE_NO_KEYCHAIN", "1")
            .env("NO_COLOR", "1")
            .env_remove("DASH_FORGE_KEY")
            .env_remove("DASH_FORGE_PASSPHRASE")
            .env_remove("DASH_FORGE_NETWORK")
            .env_remove("DASH_FORGE_DEVNET_NAME")
            // A dead DAPI and quorum service: a case that reached the network fails differently.
            .env("DASH_FORGE_DAPI_ADDRESSES", "https://127.0.0.1:9")
            .env("DASH_FORGE_QUORUM_URL", "http://127.0.0.1:9")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for m in CI_MARKERS {
            cmd.env_remove(m);
        }
        cmd
    }

    fn run(&self, args: &[&str]) -> Output {
        let started = Instant::now();
        let out = self.dg(args).output().unwrap();
        // Every offline case is refused or finished before any network read.
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "dg {args:?} took {:?}: did it reach the network?",
            started.elapsed()
        );
        out
    }
}

/// Both streams, for grepping.
fn all_output(out: &Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

/// Fail if `text` could hold recovery words.
fn assert_no_recovery_words(what: &str, text: &str, vocabulary: &BTreeSet<String>) {
    let foreign = foreign_bip39_words(text, vocabulary);
    assert!(
        foreign.is_empty(),
        "{what}: BIP-39 words dg never prints on its own: {foreign:?}"
    );
    assert_eq!(
        numbered_bip39_word(text),
        None,
        "{what}: a numbered word list"
    );
}

/// Fail if `text` holds any word or the key of `secret_words` / `wif`.
fn assert_not_leaked(what: &str, text: &str, secret_words: &str, wif: Option<&str>) {
    assert!(!text.contains(secret_words), "{what}: the phrase");
    let words: Vec<&str> = secret_words.split(' ').collect();
    for pair in words.windows(2) {
        assert!(
            !text.contains(&format!("{} {}", pair[0], pair[1])),
            "{what}: two consecutive recovery words"
        );
    }
    for (i, w) in words.iter().enumerate() {
        assert!(
            !text.contains(&format!("{}. {w}", i + 1)),
            "{what}: recovery word #{}",
            i + 1
        );
    }
    if let Some(wif) = wif {
        assert!(!text.contains(wif), "{what}: a private key");
    }
}

#[test]
fn the_grep_catches_words_printed_the_way_the_bug_printed_them() {
    // QW2-001's output: the numbered list on stderr. Each check alone must catch it.
    let vocabulary = source_vocabulary();
    let mut caught_by_vocabulary = 0;
    for _ in 0..50 {
        let words = new_mnemonic().unwrap();
        let mut leak = String::from("Your recovery words. Write them down now.\n");
        for (i, w) in words.expose().split(' ').enumerate() {
            write!(leak, "  {:>2}. {w:<12}", i + 1).unwrap();
        }
        assert!(numbered_bip39_word(&leak).is_some());
        let phrase = format!("\"mnemonic\": \"{}\"", words.expose());
        if !foreign_bip39_words(&phrase, &vocabulary).is_empty() {
            caught_by_vocabulary += 1;
        }
    }
    // Each miss has odds of about 1 in 100,000 (see the module comment); allow a few.
    assert!(
        caught_by_vocabulary >= 45,
        "the vocabulary check missed {} of 50 leaks",
        50 - caught_by_vocabulary
    );
}

#[test]
fn auth_new_without_a_terminal_refuses_and_prints_no_words() {
    let vocabulary = source_vocabulary();
    let home = Home::new();
    for args in [
        &[
            "auth",
            "new",
            "--network",
            "devnet",
            "--devnet-name",
            "bonsia",
        ][..],
        &[
            "auth",
            "new",
            "--network",
            "devnet",
            "--devnet-name",
            "bonsia",
            "--skip-backup-check",
        ],
        &[
            "--json",
            "auth",
            "new",
            "--network",
            "devnet",
            "--devnet-name",
            "bonsia",
            "--skip-backup-check",
        ],
    ] {
        let out = home.run(args);
        let text = all_output(&out);
        assert_eq!(out.status.code(), Some(2), "dg {args:?}: {text}");
        assert!(text.contains("nowhere safe"), "dg {args:?}: {text}");
        assert!(text.contains("--backup-file"), "dg {args:?}: {text}");
        assert_no_recovery_words(&format!("dg {args:?}"), &text, &vocabulary);
    }
    // Nothing was started: no journal asks for --resume.
    assert!(!home.path("state/dash-forge/journals").exists());
}

#[test]
fn auth_new_under_ci_refuses_without_a_backup_file() {
    // The CI rule itself (a pty in CI is still refused) is `secret_out`'s unit test.
    let vocabulary = source_vocabulary();
    let home = Home::new();
    let out = home
        .dg(&[
            "auth",
            "new",
            "--network",
            "devnet",
            "--devnet-name",
            "bonsia",
            "--skip-backup-check",
        ])
        .env("CI", "true")
        .output()
        .unwrap();
    let text = all_output(&out);
    assert_eq!(out.status.code(), Some(2), "{text}");
    assert!(text.contains("nowhere safe"), "{text}");
    // The CI reason comes first: CI=true was noticed, not only the pipe.
    assert!(text.contains("looks like a CI run (CI is set)"), "{text}");
    assert_no_recovery_words("CI=true dg auth new", &text, &vocabulary);
}

#[test]
fn auth_new_refuses_a_backup_file_it_cannot_write_before_anything_else() {
    let home = Home::new();
    let existing = home.path("runner.json");
    std::fs::write(&existing, "an older backup").unwrap();
    let base = [
        "auth",
        "new",
        "--network",
        "devnet",
        "--devnet-name",
        "bonsia",
        "--backup-file",
    ];
    // Already there: never overwritten.
    let mut args = base.to_vec();
    args.push(existing.to_str().unwrap());
    let out = home.run(&args);
    let text = all_output(&out);
    assert_eq!(out.status.code(), Some(2), "{text}");
    assert!(text.contains("never overwritten"), "{text}");
    assert_eq!(
        std::fs::read_to_string(&existing).unwrap(),
        "an older backup"
    );
    // Sealed, with no terminal and no DASH_FORGE_PASSPHRASE to seal it.
    let fresh = home.path("new.json");
    let mut args = base.to_vec();
    args.push(fresh.to_str().unwrap());
    let out = home.run(&args);
    let text = all_output(&out);
    assert_eq!(out.status.code(), Some(2), "{text}");
    assert!(text.contains("DASH_FORGE_PASSPHRASE"), "{text}");
    assert!(!fresh.exists());
}

/// A plaintext bridge identity file (0600) for a fresh set of words.
fn fixture_identity(home: &Home) -> (PathBuf, String, String) {
    let words = new_mnemonic().unwrap();
    let keys = NewIdentityKeys::from_mnemonic(&words, &Network::Testnet).unwrap();
    let bridge = keys.to_bridge(ID);
    let wif = bridge.identity_keys[0].private_key_wif.expose().to_string();
    let path = home.path("identity.json");
    forge_core::keystore::create_private_file(
        &path,
        bridge.to_json_with_secrets().expose().as_bytes(),
    )
    .unwrap();
    (path, words.expose().to_string(), wif)
}

#[test]
fn auth_export_prints_only_the_path() {
    let vocabulary = source_vocabulary();
    let home = Home::new();
    let (identity, words, wif) = fixture_identity(&home);
    let identity = identity.to_str().unwrap();
    for (json, name) in [(false, "plain.json"), (true, "json.json")] {
        let target = home.path(name);
        let target = target.to_str().unwrap();
        let mut args = vec![
            "--identity",
            identity,
            "auth",
            "export",
            "--reveal-secrets",
            "-o",
            target,
        ];
        if json {
            args.insert(0, "--json");
        }
        let out = home.run(&args);
        let text = all_output(&out);
        assert!(out.status.success(), "dg {args:?}: {text}");
        assert!(text.contains(target), "dg {args:?} names the file: {text}");
        assert_not_leaked(&format!("dg {args:?}"), &text, &words, Some(&wif));
        assert_no_recovery_words(&format!("dg {args:?}"), &text, &vocabulary);
        // The file holds them, 0600.
        let written = std::fs::read_to_string(target).unwrap();
        assert!(written.contains(&wif));
        let mode = std::fs::metadata(target).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn auth_export_to_stdout_is_refused_with_json() {
    let home = Home::new();
    let (identity, words, wif) = fixture_identity(&home);
    let args = [
        "--json",
        "--identity",
        identity.to_str().unwrap(),
        "auth",
        "export",
        "--format",
        "dfk1",
        "--reveal-secrets",
        "-o",
        "-",
    ];
    let out = home.run(&args);
    let text = all_output(&out);
    assert_eq!(out.status.code(), Some(2), "{text}");
    assert!(text.contains("drop --json"), "{text}");
    assert_not_leaked("dg --json auth export -o -", &text, &words, Some(&wif));
}

#[test]
fn webhook_add_without_a_terminal_refuses_to_generate_a_secret() {
    let home = Home::new();
    for json in [false, true] {
        let mut args = vec![
            "webhook",
            "add",
            "alice/project",
            "--url",
            "https://ci.example.com/hook",
            "--relay",
            RELAY,
            "--yes",
        ];
        if json {
            args.insert(0, "--json");
        }
        let out = home.run(&args);
        let text = all_output(&out);
        assert_eq!(out.status.code(), Some(2), "dg {args:?}: {text}");
        assert!(text.contains("--secret-file"), "dg {args:?}: {text}");
        assert!(text.contains("nothing was written"), "dg {args:?}: {text}");
    }
}

#[test]
fn webhook_add_refuses_an_existing_secret_file() {
    let home = Home::new();
    let existing = home.path("hook.secret");
    std::fs::write(&existing, "keep me").unwrap();
    let args = [
        "webhook",
        "add",
        "alice/project",
        "--url",
        "https://ci.example.com/hook",
        "--relay",
        RELAY,
        "--secret-file",
        existing.to_str().unwrap(),
        "--yes",
    ];
    let out = home.run(&args);
    let text = all_output(&out);
    assert_eq!(out.status.code(), Some(2), "{text}");
    assert!(text.contains("never overwritten"), "{text}");
    assert_eq!(std::fs::read_to_string(&existing).unwrap(), "keep me");
}

/// LIVE (devnet bonsia): `dg auth new --backup-file … --reveal-secrets --skip-backup-check`
/// with piped stdio runs to the deposit request; the words are in the backup file and in
/// neither stream. The deposit is never sent: the run is stopped at the request.
#[test]
#[ignore = "live: needs devnet bonsia"]
fn live_auth_new_with_a_backup_file_prints_no_words() {
    let vocabulary = source_vocabulary();
    let home = Home::new();
    let backup = home.path("runner.json");
    let mut child = home
        .dg(&[
            "auth",
            "new",
            "--network",
            "devnet",
            "--devnet-name",
            std::env::var("DASH_FORGE_DEVNET")
                .as_deref()
                .unwrap_or("bonsia"),
            "--backup-file",
            backup.to_str().unwrap(),
            "--reveal-secrets",
            "--skip-backup-check",
        ])
        // The real network this time.
        .env_remove("DASH_FORGE_DAPI_ADDRESSES")
        .env_remove("DASH_FORGE_QUORUM_URL")
        .spawn()
        .unwrap();
    // Read stderr on a thread until the deposit request (the words would come before it), and
    // stop the run then, or after three minutes if dg goes quiet.
    let mut stderr = child.stderr.take().unwrap();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let reader = {
        let seen = std::sync::Arc::clone(&seen);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut buf) {
                if n == 0 {
                    break;
                }
                seen.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        })
    };
    let marker = "to this address from any Dash wallet";
    let started = Instant::now();
    while started.elapsed() < Duration::from_mins(3)
        && !String::from_utf8_lossy(&seen.lock().unwrap()).contains(marker)
        && child.try_wait().unwrap().is_none()
    {
        std::thread::sleep(Duration::from_millis(200));
    }
    child.kill().ok();
    let out = child.wait_with_output().unwrap();
    reader.join().unwrap();
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&seen.lock().unwrap())
    );
    assert!(
        text.contains(marker),
        "did not reach the deposit request: {text}"
    );
    assert!(text.contains(backup.to_str().unwrap()), "{text}");
    let file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&backup).unwrap()).unwrap();
    let words = file["mnemonic"].as_str().unwrap();
    assert_eq!(words.split(' ').count(), 12);
    assert_not_leaked("live dg auth new", &text, words, None);
    assert_no_recovery_words("live dg auth new", &text, &vocabulary);
}
