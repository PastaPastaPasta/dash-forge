#!/bin/sh
# Install the pinned cargo-about (the third-party license notice generator) into DIR.
#
#   install-cargo-about.sh DIR
#
# A prebuilt binary from the project's GitHub release, checked against a SHA-256 pinned here, so
# a swapped upstream asset cannot change what the notices say; building it from source would
# add minutes and a second dependency tree to every release run. Linux x86_64 and aarch64
# (static musl binaries, which also run on glibc) and macOS arm64 are supported. To bump it,
# change VERSION and the digests together (the release's asset digests are on its GitHub page).
set -eu

VERSION='0.9.2'
SHA256_X86_64_LINUX='9099a59e820c38a68b9d65f300662a567d56562f9a10f6aa4c7e86c17c2566af'
SHA256_AARCH64_LINUX='af5169282fb6f84e13471493f405437e43ac517744c9ae12fbe2cdf0a6f0e5a8'
SHA256_AARCH64_DARWIN='ae72f0df0c399a1e96336f696fa55b1b28679fd725632eba8cf8e4568467cc3e'

dest=${1:?usage: install-cargo-about.sh DIR}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) triple=x86_64-unknown-linux-musl sum=$SHA256_X86_64_LINUX ;;
  Linux-aarch64 | Linux-arm64) triple=aarch64-unknown-linux-musl sum=$SHA256_AARCH64_LINUX ;;
  Darwin-arm64) triple=aarch64-apple-darwin sum=$SHA256_AARCH64_DARWIN ;;
  *) echo "install-cargo-about: no pinned cargo-about for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

name="cargo-about-${VERSION}-${triple}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl --proto '=https' --tlsv1.2 -fsSLo "$tmp/cargo-about.tar.gz" \
  "https://github.com/EmbarkStudios/cargo-about/releases/download/${VERSION}/${name}.tar.gz"
# Hash stdin, as the protoc check in release.yml does.
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum < "$tmp/cargo-about.tar.gz" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 < "$tmp/cargo-about.tar.gz" | cut -d' ' -f1)
fi
[ "$actual" = "$sum" ] || { echo "install-cargo-about: ${name}.tar.gz sha256 is $actual, not the pinned $sum" >&2; exit 1; }
tar -xzf "$tmp/cargo-about.tar.gz" -C "$tmp"
mkdir -p "$dest"
cp "$tmp/${name}/cargo-about" "$dest/cargo-about"
chmod 0755 "$dest/cargo-about"
"$dest/cargo-about" --version
