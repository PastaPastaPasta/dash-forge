#!/bin/sh
# Generate the license notices that ship with every release archive and container image.
#
#   build-support/licenses/generate.sh OUTDIR
#
# Run from anywhere inside the repository, with cargo and cargo-about
# (install-cargo-about.sh) on PATH and the dependency sources already fetched (`cargo fetch
# --locked`): it runs offline, so the output depends on Cargo.lock, about.toml and about.hbs
# and nothing else. OUTDIR gets:
#
#   LICENSE-MIT, LICENSE-APACHE   the project's own licenses
#   THIRD-PARTY-LICENSES          every Rust crate of the workspace, grouped by license
#   licenses/OPENSSL-LICENSE      the vendored OpenSSL's license (Linux builds link it statically)
#   licenses/MUSL-COPYRIGHT       musl libc's license (the musl build links it statically)
#
# stage.sh copies the right subset into each archive. It fails, rather than shipping a gap,
# when a crate's license is not accepted by about.toml or is unreadable, when a crate ships a
# NOTICE file (Apache-2.0 section 4(d): its text has to be passed on), or when openssl-src
# (the vendored OpenSSL) is missing from the lockfile's sources.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=${1:?usage: generate.sh OUTDIR}
cd "$root"
command -v cargo-about >/dev/null 2>&1 || { echo "generate: cargo-about is not on PATH (build-support/licenses/install-cargo-about.sh)" >&2; exit 1; }

mkdir -p "$out/licenses"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --frozen: Cargo.lock as is, sources from the local cache. --fail: a crate whose license cannot
# be read or clarified is an error, not a warning. --workspace: the binaries and the hosted
# services, which are built from the same lockfile.
about() {
  cargo-about generate --frozen --fail --workspace -c build-support/licenses/about.toml "$@"
}
about --format json -o "$tmp/crates.json"
about -o "$out/THIRD-PARTY-LICENSES" build-support/licenses/about.hbs

# A NOTICE file in a crate we ship must be reproduced; none exists today, so refuse to ship
# without it when one appears (the template cannot include files cargo-about does not read).
notices=$(jq -r '.crates[].package.manifest_path' "$tmp/crates.json" | sort -u | while read -r m; do
  for f in "$(dirname "$m")"/NOTICE*; do [ -f "$f" ] && printf '%s\n' "$f"; done
done || true)
if [ -n "$notices" ]; then
  echo "generate: these crates ship NOTICE files, which Apache-2.0 section 4(d) requires us to pass on;" >&2
  echo "extend about.hbs/generate.sh to include them:" >&2
  printf '%s\n' "$notices" >&2
  exit 1
fi

# The vendored OpenSSL: openssl-src is a build dependency of openssl-sys, so the crate list
# above leaves it out, but its C sources are compiled into the Linux binaries.
ossl=$(cargo metadata --frozen --all-features --format-version 1 \
  | jq -r '.packages[] | select(.name == "openssl-src") | .manifest_path' | head -n 1)
[ -n "$ossl" ] || { echo "generate: openssl-src is not in the dependency graph; Linux builds vendor OpenSSL with it" >&2; exit 1; }
[ -f "$(dirname "$ossl")/openssl/LICENSE.txt" ] || { echo "generate: $(dirname "$ossl")/openssl/LICENSE.txt is missing" >&2; exit 1; }
cp "$(dirname "$ossl")/openssl/LICENSE.txt" "$out/licenses/OPENSSL-LICENSE"

cp LICENSE-MIT LICENSE-APACHE "$out/"
cp build-support/licenses/musl-COPYRIGHT "$out/licenses/MUSL-COPYRIGHT"
echo "generate: wrote $out ($(grep -c '^Used by:' "$out/THIRD-PARTY-LICENSES") license texts, $(jq '.crates | length' "$tmp/crates.json") crates)"
