//! Behaviour tests. Fake secrets are assembled at run time so that none appears whole in this
//! repository (GitHub push protection reads its bytes).

use crate::util::{crc32, encode_base};
use crate::{
    github_checksum_ok, gitlab_checksum_ok, is_env_file_name, is_test_path, scan_file, verdict,
    AllowList, Rule, Severity, WarnReason,
};

const B62: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const B36: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

fn github_token(random: &str) -> String {
    let check = encode_base(u64::from(crc32(random.as_bytes())), B62, 6);
    format!("{}{}{random}{check}", "gh", "p_")
}

fn gitlab_token(payload: &str) -> String {
    let prefix = format!("{}{}", "gl", "pat-");
    let len = encode_base(payload.len() as u64, B36, 2);
    let crc = encode_base(
        u64::from(crc32(format!("{prefix}{payload}.01.{len}").as_bytes())),
        B36,
        7,
    );
    format!("{prefix}{payload}.01.{len}{crc}")
}

fn pem() -> String {
    let line = "VGhpcyBpcyBub3QgYSByZWFsIGtleSwgaXQgaXMgYSBGb3JnZSB0ZXN0LiBUaGlz";
    let label = format!("EC {}", "PRIVATE KEY");
    format!("-----BEGIN {label}-----\n{line}\n{line}\n-----END {label}-----\n")
}

fn rules(path: &str, text: &str) -> Vec<Rule> {
    scan_file(path, Some(text.as_bytes()))
        .into_iter()
        .map(|f| f.rule)
        .collect()
}

#[test]
fn env_file_names() {
    for p in [
        ".env",
        "a/.env",
        ".env.local",
        ".env.production",
        "x/.env.staging",
    ] {
        assert!(is_env_file_name(p), "{p}");
    }
    for p in [
        ".env.example",
        ".env.sample",
        ".env.template",
        ".env.local.example",
        ".envrc",
        "env",
        "x.env",
        ".environment",
    ] {
        assert!(!is_env_file_name(p), "{p}");
    }
}

#[test]
fn a_new_env_refuses_and_its_example_passes() {
    let f = scan_file(".env", Some(b"SECRET=x\n"));
    assert_eq!(f.len(), 1);
    assert_eq!(verdict(&f[0], false).severity, Severity::Refuse);
    assert!(scan_file(".env.example", Some(b"SECRET=x\n")).is_empty());
}

#[test]
fn test_folders_and_history_warn() {
    assert!(is_test_path("test/key.pem"));
    assert!(is_test_path("a/testdata/b/key.pem"));
    assert!(!is_test_path("test"));
    assert!(!is_test_path("latest/key.pem"));
    let f = &scan_file("test/key.pem", Some(pem().as_bytes()))[0];
    assert_eq!(f.rule, Rule::PrivateKey);
    assert_eq!(verdict(f, false).reason, Some(WarnReason::TestPath));
    let f = &scan_file("key.pem", Some(pem().as_bytes()))[0];
    assert_eq!(verdict(f, false).severity, Severity::Refuse);
    assert_eq!(verdict(f, true).reason, Some(WarnReason::History));
}

#[test]
fn github_checksums() {
    let token = github_token("FakeTokenForForgeSecretsScan01");
    assert!(github_checksum_ok(&token));
    let mut bad = token.clone();
    bad.pop();
    bad.push(if token.ends_with('A') { 'B' } else { 'A' });
    assert!(!github_checksum_ok(&bad));
    assert_eq!(rules("a.sh", &format!("T={token}\n")), [Rule::GithubToken]);
    assert_eq!(
        rules("a.sh", &format!("T={bad}\n")),
        [Rule::UnverifiedToken]
    );
    // Inside a longer word it is not a token.
    assert!(rules("a.sh", &format!("T=x{token}\n")).is_empty());
}

#[test]
fn gitlab_checksums() {
    let token = gitlab_token("FakeGitLabPayloadForForgeScanTests01");
    assert!(gitlab_checksum_ok(&token));
    assert!(!gitlab_checksum_ok(&token.replace(".01.", ".02.")));
    assert_eq!(
        rules("ci.yml", &format!("token: {token}.\n")),
        [Rule::GitlabToken]
    );
}

#[test]
fn aws_needs_the_secret() {
    let id = format!("{}{}", "AK", "IAFAKEFAKEFAKEFAKE");
    let secret = format!("{}{}", "Fake", "SecretKeyForForgeScanTest/NotReal000");
    assert!(rules("a.ini", &format!("id = {id}\n")).is_empty());
    assert_eq!(
        rules("a.ini", &format!("id = {id}\nsecret = {secret}\n")),
        [Rule::AwsKeyPair]
    );
    // Written NAME=value, as shells, Dockerfiles and compose files do.
    assert_eq!(
        rules(
            "deploy.sh",
            &format!("export AWS_ACCESS_KEY_ID={id}\nexport AWS_SECRET_ACCESS_KEY={secret}\n")
        ),
        [Rule::AwsKeyPair]
    );
    // A git object id is not an AWS secret.
    assert!(rules(
        "a.ini",
        &format!("id = {id}\ncommit {}\n", "ab12".repeat(10))
    )
    .is_empty());
}

#[test]
fn private_key_markers_need_a_body() {
    assert_eq!(rules("k.pem", &pem()), [Rule::PrivateKey]);
    let marker = format!("-----BEGIN {}-----", "RSA PRIVATE KEY");
    assert!(rules("pem.rs", &format!("const M: &str = \"{marker}\";\n")).is_empty());
    // Encrypted keys carry header lines; they are skipped, the body still counts.
    let enc = pem().replace("KEY-----\n", "KEY-----\nProc-Type: 4,ENCRYPTED\n\n");
    assert_eq!(rules("k.pem", &enc), [Rule::PrivateKey]);
}

#[test]
fn wifs_warn_and_need_their_checksum() {
    // Dash Core src/test/data/key_io_valid.json (public test vectors).
    let w = "XK9kG3y8JeDgSNrXdomWiCiBMs7D2eNJSrux1rx7GuGLWpMxEH3w";
    let f = scan_file("contrib/k.py", Some(format!("K = '{w}'\n").as_bytes()));
    assert_eq!(f.len(), 1);
    assert_eq!(f[0].rule, Rule::Wif);
    assert_eq!(verdict(&f[0], false).reason, Some(WarnReason::Rule));
    let bad = format!("{}v", &w[..w.len() - 1]);
    assert!(rules("k.py", &format!("K = '{bad}'\n")).is_empty());
}

#[test]
fn assignments_warn_once_per_line() {
    assert_eq!(
        rules("s.py", "API_TOKEN = \"q8Zr2LxP0vNw7TkB4mYcHs9D\"\n"),
        [Rule::SecretAssignment]
    );
    // A token on the line is reported as the token, not also as an assignment.
    let token = github_token("FakeTokenForForgeSecretsScan01");
    assert_eq!(
        rules("s.py", &format!("GITHUB_TOKEN = \"{token}\"\n")),
        [Rule::GithubToken]
    );
    assert!(rules("s.py", "token_url = \"https://example.org/oauth/token\"\n").is_empty());
}

#[test]
fn fingerprints_are_short_stable_and_per_path() {
    let a = &scan_file(".env", Some(b"A=1\n"))[0];
    let b = &scan_file(".env", Some(b"A=1\n"))[0];
    let c = &scan_file("x/.env", Some(b"A=1\n"))[0];
    assert_eq!(a.fingerprint.len(), 12);
    assert_eq!(a.fingerprint, b.fingerprint);
    assert_ne!(a.fingerprint, c.fingerprint);
    let mut allow = AllowList::new();
    assert!(allow.add_fingerprint(&a.fingerprint));
    assert!(allow.allows(a) && !allow.allows(c));
}

#[test]
fn binary_and_oversized_files_are_matched_by_name_only() {
    let token = github_token("FakeTokenForForgeSecretsScan01");
    assert!(rules("a.bin", &format!("\0{token}")).is_empty());
    let big = format!("{token}\n{}", "a".repeat(crate::MAX_SCAN_BYTES));
    assert!(rules("big.txt", &big).is_empty());
    assert_eq!(
        scan_file(".env", None)
            .iter()
            .map(|f| f.rule)
            .collect::<Vec<_>>(),
        [Rule::EnvFile]
    );
}
