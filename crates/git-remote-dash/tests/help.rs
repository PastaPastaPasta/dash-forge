//! `git-remote-dash --help` and `-h` print the usage and exit 0, before admin mode (whose `--`
//! prefix they share) and without touching the network.

use std::process::Command;

const HELPER: &str = env!("CARGO_BIN_EXE_git-remote-dash");

#[test]
fn help_prints_usage_and_exits_zero() {
    for flag in ["--help", "-h"] {
        let out = Command::new(HELPER)
            .arg(flag)
            .env_remove("DASH_FORGE_KEY")
            .output()
            .unwrap();
        assert!(out.status.success(), "{flag}: {out:?}");
        let text = String::from_utf8(out.stdout).unwrap();
        assert!(
            text.starts_with(concat!("git-remote-dash ", env!("CARGO_PKG_VERSION"))),
            "{text}"
        );
        assert!(text.contains("git clone dash://<owner>/<repo>"), "{text}");
        assert!(text.contains("DASH_FORGE_NETWORK"), "{text}");
        assert!(
            out.stderr.is_empty(),
            "{flag}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
