#!/bin/sh
# Tests for install.sh, run against a fake release laid out like GitHub Releases
# (file://<dir>/download/v<version>/<asset>, file://<dir>/latest/download/SHA256SUMS).
# The "binaries" are shell scripts, so this needs no build and runs anywhere install.sh
# does. Usage: sh tests/install/test-install.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
installer="$here/../../install.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pass=0
fail=0
ok() {
    pass=$((pass + 1))
    printf 'ok   %s\n' "$1"
}
not_ok() {
    fail=$((fail + 1))
    printf 'FAIL %s\n' "$1"
    [ -f "$work/out" ] && sed 's/^/     | /' "$work/out"
}

sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{ print $1 }'
    else
        shasum -a 256 "$1" | awk '{ print $1 }'
    fi
}

TARGET=x86_64-unknown-linux-gnu

# make_release <version> [latest]: build a fake archive for $TARGET and its SHA256SUMS.
make_release() {
    version=$1
    name="dash-forge-$version-$TARGET"
    stage="$work/stage/$name"
    rel="$work/releases/download/v$version"
    mkdir -p "$stage/completions" "$rel"
    for bin in dg git-remote-dash forge-relay forge-import; do
        printf '#!/bin/sh\necho "%s %s (0123456789ab %s)"\n' "$bin" "$version" "$TARGET" > "$stage/$bin"
        chmod 755 "$stage/$bin"
    done
    echo '_dg() { :; }' > "$stage/completions/dg.bash"
    echo '#compdef dg' > "$stage/completions/_dg"
    echo 'complete -c dg' > "$stage/completions/dg.fish"
    tar -czf "$rel/$name.tar.gz" -C "$work/stage" "$name"
    # A second target's line, so the installer must pick its own.
    printf '%s  %s\n' "$(sha256 "$rel/$name.tar.gz")" "$name.tar.gz" > "$rel/SHA256SUMS"
    printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" \
        "dash-forge-$version-aarch64-apple-darwin.tar.gz" >> "$rel/SHA256SUMS"
    if [ "${2:-}" = latest ]; then
        mkdir -p "$work/releases/latest/download"
        cp "$rel/SHA256SUMS" "$work/releases/latest/download/SHA256SUMS"
    fi
}

# run_install <prefix> [VAR=value ...]: run install.sh in a clean environment.
run_install() {
    prefix=$1
    shift
    env -i PATH="$PATH" HOME="$work/home" SHELL=/bin/sh \
        DASH_FORGE_RELEASE_BASE_URL="file://$work/releases" \
        DASH_FORGE_TARGET="$TARGET" \
        DASH_FORGE_INSTALL_DIR="$prefix" \
        "$@" sh "$installer" > "$work/out" 2>&1
}

make_release 0.1.0
make_release 0.2.0 latest

# 1. Latest release: installs dg + git-remote-dash only, prints next steps.
if run_install "$work/p1" &&
    [ -x "$work/p1/dg" ] && [ -x "$work/p1/git-remote-dash" ] && [ ! -e "$work/p1/forge-relay" ] &&
    "$work/p1/dg" --version | grep -q '^dg 0.2.0 ' &&
    grep -q 'Checksum verified' "$work/out" &&
    grep -q 'dg doctor' "$work/out" &&
    grep -q 'is not on your PATH' "$work/out"; then
    ok "installs the latest release and prints next steps"
else
    not_ok "installs the latest release and prints next steps"
fi

# 2. Pinned version, with a v prefix.
if run_install "$work/p2" DASH_FORGE_VERSION=v0.1.0 &&
    "$work/p2/dg" --version | grep -q '^dg 0.1.0 '; then
    ok "installs a pinned DASH_FORGE_VERSION"
else
    not_ok "installs a pinned DASH_FORGE_VERSION"
fi

# 3. Tampered archive: refuses, installs nothing.
cp -R "$work/releases" "$work/releases.good"
printf 'x' >> "$work/releases/download/v0.2.0/dash-forge-0.2.0-$TARGET.tar.gz"
if ! run_install "$work/p3" && grep -q 'checksum mismatch' "$work/out" && [ ! -e "$work/p3/dg" ]; then
    ok "refuses a tampered archive and installs nothing"
else
    not_ok "refuses a tampered archive and installs nothing"
fi
rm -rf "$work/releases"
mv "$work/releases.good" "$work/releases"

# 4. No archive for this platform.
if ! run_install "$work/p4" DASH_FORGE_TARGET=riscv64gc-unknown-linux-gnu &&
    grep -q 'no archive for riscv64gc-unknown-linux-gnu' "$work/out"; then
    ok "fails clearly when the release has no archive for the target"
else
    not_ok "fails clearly when the release has no archive for the target"
fi

# 5. Unwritable install dir: no sudo, a clear error.
mkdir -p "$work/ro"
chmod 555 "$work/ro"
if [ -w "$work/ro" ]; then
    ok "unwritable install dir (skipped: running as root)"
elif ! run_install "$work/ro/bin" && grep -q 'never uses sudo' "$work/out"; then
    ok "refuses an unwritable install dir without sudo"
else
    not_ok "refuses an unwritable install dir without sudo"
fi
chmod 755 "$work/ro"

# 6. Plain http is refused.
if ! env -i PATH="$PATH" HOME="$work/home" DASH_FORGE_RELEASE_BASE_URL="http://example.invalid/releases" \
    DASH_FORGE_TARGET="$TARGET" DASH_FORGE_INSTALL_DIR="$work/p6" sh "$installer" > "$work/out" 2>&1 &&
    grep -q 'only https:// and file://' "$work/out"; then
    ok "refuses a plain-http release URL"
else
    not_ok "refuses a plain-http release URL"
fi

# 7. Extra binaries and completions on request; PATH advice suppressed when on PATH.
if env -i PATH="$work/p7:$PATH" HOME="$work/home" SHELL=/bin/sh \
    DASH_FORGE_RELEASE_BASE_URL="file://$work/releases" DASH_FORGE_TARGET="$TARGET" \
    DASH_FORGE_INSTALL_DIR="$work/p7" DASH_FORGE_BINARIES="dg forge-relay" \
    DASH_FORGE_COMPLETIONS=1 XDG_DATA_HOME="$work/xdg-data" XDG_CONFIG_HOME="$work/xdg-config" \
    sh "$installer" > "$work/out" 2>&1 &&
    [ -x "$work/p7/forge-relay" ] && [ ! -e "$work/p7/git-remote-dash" ] &&
    [ -s "$work/xdg-data/zsh/site-functions/_dg" ] &&
    [ -s "$work/xdg-data/bash-completion/completions/dg" ] &&
    [ -s "$work/xdg-config/fish/completions/dg.fish" ] &&
    ! grep -q 'is not on your PATH' "$work/out"; then
    ok "installs chosen binaries and completions"
else
    not_ok "installs chosen binaries and completions"
fi

# 8. An invalid version string never reaches a URL.
if ! run_install "$work/p8" DASH_FORGE_VERSION='1.0;rm -rf /' && grep -q 'is not a version' "$work/out"; then
    ok "rejects a malformed DASH_FORGE_VERSION"
else
    not_ok "rejects a malformed DASH_FORGE_VERSION"
fi

# 9. require-mode attestation without gh fails closed (gh hidden via a PATH with no gh).
nogh="$work/nogh"
mkdir -p "$nogh"
for tool in sh awk tar gzip grep sed mkdir mktemp cp mv chmod rm curl wc tr cat basename uname dirname env sha256sum shasum sysctl ldd head; do
    p=$(command -v "$tool" 2>/dev/null || true)
    [ -n "$p" ] && ln -sf "$p" "$nogh/$tool"
done
if ! env -i PATH="$nogh" HOME="$work/home" DASH_FORGE_RELEASE_BASE_URL="file://$work/releases" \
    DASH_FORGE_TARGET="$TARGET" DASH_FORGE_INSTALL_DIR="$work/p9" DASH_FORGE_ATTESTATION=require \
    sh "$installer" > "$work/out" 2>&1 &&
    grep -q 'needs a recent GitHub CLI' "$work/out" && [ ! -e "$work/p9/dg" ]; then
    ok "DASH_FORGE_ATTESTATION=require fails closed without gh"
else
    not_ok "DASH_FORGE_ATTESTATION=require fails closed without gh"
fi

# 10. A new dg that does not start never replaces a working one.
make_release 0.3.0
broken="$work/stage/dash-forge-0.3.0-$TARGET"
printf '#!/bin/sh\nexit 127\n' > "$broken/dg"
tar -czf "$work/releases/download/v0.3.0/dash-forge-0.3.0-$TARGET.tar.gz" -C "$work/stage" "dash-forge-0.3.0-$TARGET"
printf '%s  %s\n' "$(sha256 "$work/releases/download/v0.3.0/dash-forge-0.3.0-$TARGET.tar.gz")" \
    "dash-forge-0.3.0-$TARGET.tar.gz" > "$work/releases/download/v0.3.0/SHA256SUMS"
if ! run_install "$work/p1" DASH_FORGE_VERSION=0.3.0 &&
    grep -q 'left alone' "$work/out" &&
    "$work/p1/dg" --version | grep -q '^dg 0.2.0 ' &&
    "$work/p1/git-remote-dash" --version | grep -q ' 0.2.0 '; then
    ok "keeps a working install when the new dg does not run"
else
    not_ok "keeps a working install when the new dg does not run"
fi

# 11. Installing only the helper never reports (or runs) a stale dg already in the dir.
if run_install "$work/p1" DASH_FORGE_VERSION=0.1.0 DASH_FORGE_BINARIES=git-remote-dash &&
    "$work/p1/git-remote-dash" --version | grep -q ' 0.1.0 ' &&
    ! grep -q '^dg 0.2.0' "$work/out" &&
    [ -z "$(find "$work/p1" -name '.*' -type f)" ]; then
    ok "installs only the requested binary and leaves no staged files"
else
    not_ok "installs only the requested binary and leaves no staged files"
fi

# 12. An install dir with spaces and glob characters, next to decoy files its pieces name.
spaced="$work/My Tools [x]/bin"
mkdir -p "$work/My Tools [x]"
: > "$work/My"
: > "$work/x"
if run_install "$spaced" && [ -x "$spaced/dg" ] && [ -e "$work/My" ] && [ -e "$work/x" ] &&
    [ -z "$(find "$spaced" -name '.*' -type f)" ]; then
    ok "handles an install dir with spaces and glob characters"
else
    not_ok "handles an install dir with spaces and glob characters"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
