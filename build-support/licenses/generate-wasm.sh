#!/bin/sh
# Generate the notice for the Rust crates inside the web app's WebAssembly module.
#
#   build-support/licenses/generate-wasm.sh [OUTFILE]
#
# The web app ships @dashevo/wasm-sdk, which is the `wasm-sdk` crate of dashpay/platform
# compiled to WebAssembly with every crate it depends on. This runs cargo-about over that crate
# in the Platform checkout cargo already fetched for the Rust workspace (the same git tag as
# Cargo.toml's PLATFORM_TAG, which moves in lockstep with forge-web's @dashevo/wasm-sdk pin),
# for the wasm32-unknown-unknown target. The result is committed as
# forge-web/scripts/third-party/wasm-sdk-licenses.txt and served by the web app; a test fails
# when the committed file was made for another Platform tag than forge-web depends on.
#
# Run it after bumping the Platform tag:
#   cargo fetch --locked --target wasm32-unknown-unknown --manifest-path <platform checkout>/packages/wasm-sdk/Cargo.toml
#   build-support/licenses/generate-wasm.sh
# (the checkout is under ~/.cargo/git/checkouts/platform-*/; `cargo metadata` names it). Offline
# after that, like generate.sh.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=${1:-$root/forge-web/scripts/third-party/wasm-sdk-licenses.txt}
cd "$root"
command -v cargo-about >/dev/null 2>&1 || { echo "generate-wasm: cargo-about is not on PATH (build-support/licenses/install-cargo-about.sh)" >&2; exit 1; }

sdk=$(cargo metadata --frozen --format-version 1 \
  | jq --raw-output '.packages[] | select(.name == "dash-sdk") | .manifest_path + " " + .source' | head -n 1)
manifest=${sdk%% *}
source=${sdk#* }
tag=$(printf '%s\n' "$source" | sed -n 's/.*[?&]tag=\([^#&]*\).*/\1/p')
[ -n "$tag" ] || { echo "generate-wasm: dash-sdk is not pinned by tag ($source)" >&2; exit 1; }
platform=$(cd "$(dirname "$manifest")/../.." && pwd)
[ -f "$platform/packages/wasm-sdk/Cargo.toml" ] || { echo "generate-wasm: no packages/wasm-sdk in $platform" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(cd "$platform" && cargo-about generate --frozen --fail -m packages/wasm-sdk/Cargo.toml \
  --target wasm32-unknown-unknown -c "$root/build-support/licenses/about.toml" \
  -o "$tmp/body.txt" "$root/build-support/licenses/about-wasm.hbs")

{
  echo "Rust crates in the Dash Platform SDK WebAssembly module"
  echo "========================================================"
  echo
  echo "wasm_sdk_bg.wasm (npm package @dashevo/wasm-sdk) is the wasm-sdk crate of"
  echo "github.com/dashpay/platform, tag ${tag}, compiled to WebAssembly together with the Rust"
  echo "crates below, grouped by license, each with the license text as the crate ships it."
  echo "Platform tag: ${tag}"
  echo
  echo "Overview of licenses:"
  # Some crates ship CRLF license files; the notice is LF throughout.
  tr -d '\r' < "$tmp/body.txt"
} > "$out"
echo "generate-wasm: wrote $out (platform ${tag})"
