// Shared build-script body for the user-facing binaries (`dg`, `git-remote-dash`), pulled in
// with `include!` from each crate's build.rs. It stamps the build with what `--version` and
// `dg doctor` report, so a bug report and a release asset can be traced to one commit:
//
//   DASH_FORGE_GIT_SHA    12-hex commit, from $DASH_FORGE_BUILD_SHA (CI) or `git rev-parse`,
//                         else `unknown` (a source tarball with no .git).
//   DASH_FORGE_TARGET     the target triple this binary was compiled for.
//   DASH_FORGE_VERSION    `<pkg version> (<sha> <target>)` — what clap prints after the
//                         binary name for `--version`.

use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn main() {
    let manifest_dir =
        std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("set by cargo"));

    println!("cargo:rerun-if-env-changed=DASH_FORGE_BUILD_SHA");
    let sha = match std::env::var("DASH_FORGE_BUILD_SHA") {
        Ok(s) if !s.trim().is_empty() => s.trim().chars().take(12).collect(),
        _ => {
            // Rerun when HEAD moves. HEAD changes on checkout; the branch it names (loose
            // or in packed-refs) changes on commit/reset even with the reflog disabled;
            // logs/HEAD is appended on all of these. `--git-path` resolves each correctly
            // inside a linked worktree (packed-refs lives in the common dir).
            let branch = git(&manifest_dir, &["symbolic-ref", "-q", "HEAD"]);
            let watched = ["HEAD", "logs/HEAD", "packed-refs"]
                .into_iter()
                .map(str::to_string)
                .chain(branch);
            for p in watched {
                let p = p.as_str();
                if let Some(rel) = git(&manifest_dir, &["rev-parse", "--git-path", p]) {
                    let path = manifest_dir.join(rel);
                    if path.exists() {
                        println!("cargo:rerun-if-changed={}", path.display());
                    }
                }
            }
            git(&manifest_dir, &["rev-parse", "--short=12", "HEAD"])
                .unwrap_or_else(|| "unknown".to_string())
        }
    };

    let target = std::env::var("TARGET").expect("set by cargo");
    let version = std::env::var("CARGO_PKG_VERSION").expect("set by cargo");
    println!("cargo:rustc-env=DASH_FORGE_GIT_SHA={sha}");
    println!("cargo:rustc-env=DASH_FORGE_TARGET={target}");
    println!("cargo:rustc-env=DASH_FORGE_VERSION={version} ({sha} {target})");
}
