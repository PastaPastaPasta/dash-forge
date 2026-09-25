//! Embed every `forge-contracts/deployments/<network>.json` into forge-core.
//!
//! The deployment files are the single source of truth for per-network contract ids
//! (style guide: "constants generated from `forge-contracts/deployments/*.json`"). Globbing
//! the directory here — rather than naming each file in an `include_str!` — means a new
//! network (`mainnet.json` after the runbook deploy, `devnet-<name>.json` for a devnet) is
//! picked up by committing the file alone, with no code change to forget.
//!
//! Emits `$OUT_DIR/deployments.rs`: a sorted `(key, json)` table where `key` is the file
//! stem (`testnet`, `mainnet`, `devnet-moutai`), consumed by [`crate::network`].

use std::fmt::Write as _;
use std::path::PathBuf;

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let dir = manifest_dir.join("../../forge-contracts/deployments");
    // A directory path makes cargo rescan its contents, so adding a file reruns this too.
    println!("cargo:rerun-if-changed={}", dir.display());

    let mut entries: Vec<(String, String)> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("reading {}: {e}", dir.display()))
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension()? != "json" {
                return None;
            }
            let key = path.file_stem()?.to_str()?.to_string();
            let abs = path.canonicalize().ok()?.to_str()?.to_string();
            Some((key, abs))
        })
        .collect();
    entries.sort();

    let mut out = String::from(
        "/// `(network key, deployment JSON)` for every file in forge-contracts/deployments/.\n\
         pub(crate) const EMBEDDED_DEPLOYMENTS: &[(&str, &str)] = &[\n",
    );
    for (key, path) in &entries {
        writeln!(out, "    ({key:?}, include_str!({path:?})),").expect("writing to a String");
    }
    out.push_str("];\n");

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    std::fs::write(out_dir.join("deployments.rs"), out).expect("writing deployments.rs");
}
