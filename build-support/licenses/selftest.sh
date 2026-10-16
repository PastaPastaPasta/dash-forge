#!/bin/sh
# Test stage.sh and verify-archive.sh against fake notices, for every release target: the right
# files land in each archive, and a missing or misplaced one is caught. No cargo needed.
#
#   build-support/licenses/selftest.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

notices="$tmp/notices"
mkdir -p "$notices/licenses"
for f in LICENSE-MIT LICENSE-APACHE THIRD-PARTY-LICENSES licenses/OPENSSL-LICENSE licenses/MUSL-COPYRIGHT; do
  echo "text of $f" > "$notices/$f"
done

fail() { echo "selftest: $*" >&2; exit 1; }
expect_ok() { "$@" >/dev/null 2>&1 || fail "should pass: $*"; }
expect_fail() { if "$@" >/dev/null 2>&1; then fail "should fail: $*"; fi; }

# make_archive TARGET DIR: an archive of the staged files plus a fake binary, in the format the
# release uses for that target (zip for Windows, tar.gz otherwise).
make_archive() {
  target=$1 dir=$2
  name="dash-forge-1.2.3-dev.abc-${target}"
  rm -rf "$dir/stage" && mkdir -p "$dir/stage/$name"
  echo bin > "$dir/stage/$name/dg"
  "$here/stage.sh" "$target" "$notices" "$dir/stage/$name"
  case "$target" in
    *-windows-*) (cd "$dir/stage" && zip -qr "$dir/$name.zip" "$name"); echo "$dir/$name.zip" ;;
    *) (cd "$dir/stage" && tar -czf "$dir/$name.tar.gz" "$name"); echo "$dir/$name.tar.gz" ;;
  esac
}

for target in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-unknown-linux-musl \
              x86_64-apple-darwin aarch64-apple-darwin x86_64-pc-windows-msvc; do
  d="$tmp/$target" && mkdir -p "$d"
  archive=$(make_archive "$target" "$d")
  expect_ok "$here/verify-archive.sh" "$archive" "$target"

  # What each target gets beyond the common files.
  has() { (tar -tzf "$archive" 2>/dev/null || unzip -Z1 "$archive") | grep -Fq "/$1"; }
  case "$target" in
    *-linux-*) has licenses/OPENSSL-LICENSE || fail "$target: no OpenSSL license" ;;
    *) has licenses/OPENSSL-LICENSE && fail "$target: has an OpenSSL license it does not link" ;;
  esac
  case "$target" in
    *-linux-musl) has licenses/MUSL-COPYRIGHT || fail "$target: no musl COPYRIGHT" ;;
    *) has licenses/MUSL-COPYRIGHT && fail "$target: has a musl COPYRIGHT it does not link" ;;
  esac

  # An archive for another target is rejected.
  expect_fail "$here/verify-archive.sh" "$archive" x86_64-unknown-freebsd

  # Dropping any one required file is caught.
  name=$(basename "$archive"); name=${name%.tar.gz}; name=${name%.zip}
  . "$here/files.sh"
  for f in $(license_files "$target"); do
    rm -rf "$d/broken" && mkdir -p "$d/broken"
    (cd "$d/broken" && case "$archive" in
       *.zip) unzip -q "$archive" ;;
       *) tar -xzf "$archive" ;;
     esac
     rm "$name/$f"
     case "$archive" in
       *.zip) rm -f "$d/broken.zip"; zip -qr "$d/broken.zip" "$name"; mv "$d/broken.zip" "$d/broken/$name.zip" ;;
       *) tar -czf "$d/broken/$name.tar.gz" "$name" ;;
     esac)
    broken=$(ls "$d/broken"/*.tar.gz "$d/broken"/*.zip 2>/dev/null | head -n 1)
    expect_fail "$here/verify-archive.sh" "$broken" "$target"
  done
done

# stage.sh refuses an empty or missing notice.
: > "$notices/THIRD-PARTY-LICENSES"
expect_fail "$here/stage.sh" x86_64-apple-darwin "$notices" "$tmp/empty-stage"
rm "$notices/THIRD-PARTY-LICENSES"
expect_fail "$here/stage.sh" x86_64-apple-darwin "$notices" "$tmp/missing-stage"

echo "selftest: ok"
