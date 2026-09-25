#!/bin/sh
# Dash Forge installer: puts prebuilt `dg` and `git-remote-dash` on your PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/install.sh | sh
#
# What it does, in order (read it before you pipe it to a shell; that is what it is for):
#   1. Works out your platform (OS, CPU, and on Linux glibc or musl).
#   2. Downloads SHA256SUMS from the GitHub Release (the latest one, or DASH_FORGE_VERSION)
#      and picks this platform's archive from it.
#   3. Downloads the archive and checks its SHA-256 against SHA256SUMS. On a mismatch it
#      stops and installs nothing.
#   4. If the GitHub CLI (`gh`) is installed and logged in, it also checks the archive's
#      build provenance attestation: proof that this repository's release workflow built it
#      from the tagged commit. Set DASH_FORGE_ATTESTATION=require to make this mandatory.
#   5. Copies the binaries into ${DASH_FORGE_INSTALL_DIR:-$HOME/.local/bin}. It never runs
#      sudo. If that directory is not writable, it tells you so and stops.
#
# Environment:
#   DASH_FORGE_VERSION           release to install, e.g. 0.1.0 or v0.1.0 (default: latest)
#   DASH_FORGE_INSTALL_DIR       where binaries go (default: $HOME/.local/bin)
#   DASH_FORGE_BINARIES          which binaries to install (default: "dg git-remote-dash";
#                                the archive also has forge-relay and forge-import)
#   DASH_FORGE_TARGET            override the detected target triple
#   DASH_FORGE_ATTESTATION       auto (default) | require | skip
#   DASH_FORGE_COMPLETIONS       1 = also install shell completions for bash, zsh and fish
#   DASH_FORGE_RELEASE_BASE_URL  releases URL (default: https://github.com/<repo>/releases);
#                                https:// or file:// only. Used for mirrors and tests.
#
# The whole script is one function called on the last line, so a download that is cut off
# part-way runs nothing.

set -eu

REPO="PastaPastaPasta/dash-forge"
DEFAULT_BASE_URL="https://github.com/${REPO}/releases"
DOCS_URL="https://github.com/${REPO}/blob/master/docs/INSTALL.md"

say() {
    printf '%s\n' "$*"
}

warn() {
    printf 'install.sh: warning: %s\n' "$*" >&2
}

die() {
    printf 'install.sh: error: %s\n' "$*" >&2
    exit 1
}

have() {
    command -v "$1" >/dev/null 2>&1
}

# Linux libc: musl if the musl loader exists or ldd says so, glibc otherwise.
is_musl() {
    for loader in /lib/ld-musl-*; do
        [ -e "$loader" ] && return 0
    done
    ldd --version 2>&1 | grep -qi musl
}

detect_target() {
    os=$(uname -s)
    arch=$(uname -m)
    case "$arch" in
        x86_64 | amd64) arch=x86_64 ;;
        aarch64 | arm64) arch=aarch64 ;;
        *) die "no prebuilt binaries for CPU '$arch' (x86_64 and aarch64 only); build from source: $DOCS_URL" ;;
    esac
    case "$os" in
        Linux)
            if is_musl; then
                [ "$arch" = x86_64 ] || die "no prebuilt binaries for $arch musl Linux; build from source: $DOCS_URL"
                printf '%s\n' "x86_64-unknown-linux-musl"
            else
                printf '%s\n' "${arch}-unknown-linux-gnu"
            fi
            ;;
        Darwin)
            # An x86_64 shell under Rosetta 2 on Apple silicon: prefer the native build.
            if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
                arch=aarch64
            fi
            printf '%s\n' "${arch}-apple-darwin"
            ;;
        MINGW* | MSYS* | CYGWIN* | Windows_NT)
            die "on Windows, download the .zip for x86_64-pc-windows-msvc from $DEFAULT_BASE_URL and follow $DOCS_URL"
            ;;
        *) die "no prebuilt binaries for OS '$os'; build from source: $DOCS_URL" ;;
    esac
}

# download <url> <file>: https:// (or file:// for mirrors/tests) only, never plain http,
# and redirects may only go to https.
download() {
    case "$1" in
        https://*) proto='=https' ;;
        file://*) proto='=file' ;;
        *) die "refusing to download from '$1': only https:// and file:// URLs are allowed" ;;
    esac
    if have curl; then
        curl --proto "$proto" --proto-redir '=https' --tlsv1.2 --fail --silent --show-error \
            --location --retry 3 --output "$2" "$1"
    elif have wget && [ "$proto" = '=https' ]; then
        wget --https-only --quiet --output-document="$2" "$1"
    else
        die "need curl (or wget, for https) to download release files"
    fi
}

sha256_of() {
    if have sha256sum; then
        sha256sum "$1" | awk '{ print $1 }'
    elif have shasum; then
        shasum -a 256 "$1" | awk '{ print $1 }'
    elif have openssl; then
        openssl dgst -sha256 -r "$1" | awk '{ print $1 }'
    else
        die "need sha256sum, shasum or openssl to verify the download"
    fi
}

valid_version() {
    printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'
}

# The file names listed in a SHA256SUMS file (a leading `*` marks binary mode).
sums_names() {
    awk '{ n = $2; sub(/^\*/, "", n); print n }' "$1"
}

# The digest SHA256SUMS records for one file name.
sums_digest() {
    awk -v f="$2" '{ n = $2; sub(/^\*/, "", n) } n == f { print $1 }' "$1"
}

verify_attestation() {
    archive=$1
    version=$2
    mode=${DASH_FORGE_ATTESTATION:-auto}
    case "$mode" in
        skip)
            say "Skipping the provenance attestation check (DASH_FORGE_ATTESTATION=skip)."
            return 0
            ;;
        auto | require) ;;
        *) die "DASH_FORGE_ATTESTATION must be auto, require or skip (got '$mode')" ;;
    esac
    if [ "$mode" = auto ] && [ "$BASE_URL" != "$DEFAULT_BASE_URL" ]; then
        say "Skipping the provenance attestation check: files come from $BASE_URL, not GitHub Releases."
        return 0
    fi
    if ! have gh || ! gh auth status >/dev/null 2>&1; then
        [ "$mode" = require ] && die "DASH_FORGE_ATTESTATION=require needs the GitHub CLI (gh), installed and logged in"
        say "Checksum verified. To also check build provenance, install the GitHub CLI and run:"
        say "  gh attestation verify $(basename "$archive") --repo $REPO"
        return 0
    fi
    say "Checking build provenance with gh attestation verify..."
    # The attestation must come from this repository's release workflow, building the tag.
    if ! gh attestation verify "$archive" --repo "$REPO" \
        --signer-workflow "$REPO/.github/workflows/release.yml" \
        --source-ref "refs/tags/v$version" >/dev/null; then
        die "the build provenance attestation for $(basename "$archive") did not verify; refusing to install. \
If this is a network problem, retry, or set DASH_FORGE_ATTESTATION=skip to rely on the checksum alone."
    fi
    say "Build provenance verified: built by $REPO's release workflow from tag v$version."
}

install_completions() {
    src=$1
    data=${XDG_DATA_HOME:-$HOME/.local/share}
    config=${XDG_CONFIG_HOME:-$HOME/.config}
    mkdir -p "$data/bash-completion/completions" "$data/zsh/site-functions" "$config/fish/completions"
    cp "$src/dg.bash" "$data/bash-completion/completions/dg"
    cp "$src/_dg" "$data/zsh/site-functions/_dg"
    cp "$src/dg.fish" "$config/fish/completions/dg.fish"
    say "Installed completions for bash, zsh and fish."
    say "  zsh only: add this to ~/.zshrc before compinit:  fpath=(\"$data/zsh/site-functions\" \$fpath)"
}

path_advice() {
    case ":${PATH:-}:" in
        *":$INSTALL_DIR:"*) return 0 ;;
    esac
    case "${SHELL:-}" in
        */zsh) rc="$HOME/.zshrc" ;;
        */bash) rc="$HOME/.bashrc" ;;
        */fish) rc="" ;;
        *) rc="$HOME/.profile" ;;
    esac
    say ""
    say "$INSTALL_DIR is not on your PATH. Add it:"
    if [ -z "$rc" ]; then
        say "  fish_add_path \"$INSTALL_DIR\""
    else
        say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> $rc"
        say "then open a new terminal."
    fi
}

main() {
    BASE_URL=${DASH_FORGE_RELEASE_BASE_URL:-$DEFAULT_BASE_URL}
    BASE_URL=${BASE_URL%/}
    INSTALL_DIR=${DASH_FORGE_INSTALL_DIR:-${HOME:?HOME is not set; set DASH_FORGE_INSTALL_DIR}/.local/bin}
    binaries=${DASH_FORGE_BINARIES:-dg git-remote-dash}

    have tar || die "need tar to unpack the release archive"
    have awk || die "need awk"

    if [ -n "${DASH_FORGE_TARGET:-}" ]; then
        target=$DASH_FORGE_TARGET
    else
        target=$(detect_target)
    fi
    case "$target" in
        *windows*) die "install.sh installs .tar.gz releases only; on Windows follow $DOCS_URL" ;;
    esac

    pinned=""
    if [ -n "${DASH_FORGE_VERSION:-}" ]; then
        pinned=${DASH_FORGE_VERSION#v}
        valid_version "$pinned" || die "DASH_FORGE_VERSION '$DASH_FORGE_VERSION' is not a version like 0.1.0"
        sums_url="$BASE_URL/download/v$pinned/SHA256SUMS"
    else
        sums_url="$BASE_URL/latest/download/SHA256SUMS"
    fi

    tmp=$(mktemp -d 2>/dev/null || mktemp -d -t dash-forge-install)
    # shellcheck disable=SC2064 # expand $tmp now: it is fixed for the rest of the run
    trap "rm -rf '$tmp'" EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    say "Dash Forge installer ($target)"
    say "Fetching $sums_url"
    download "$sums_url" "$tmp/SHA256SUMS" ||
        die "could not download SHA256SUMS from $sums_url (is there a published release${pinned:+ v$pinned}?)"

    # Exactly one archive for this target, which also tells us the version.
    assets=$(sums_names "$tmp/SHA256SUMS" | grep -E "^dash-forge-[0-9A-Za-z.+-]+-${target}\\.tar\\.gz\$" || true)
    [ -n "$assets" ] || die "this release has no archive for $target (see $BASE_URL)"
    [ "$(printf '%s\n' "$assets" | wc -l | tr -d ' ')" = 1 ] || die "SHA256SUMS lists more than one archive for $target; refusing to guess"
    asset=$assets
    version=${asset#dash-forge-}
    version=${version%"-$target.tar.gz"}
    valid_version "$version" || die "unexpected archive name '$asset' in SHA256SUMS"
    if [ -n "$pinned" ] && [ "$version" != "$pinned" ]; then
        die "SHA256SUMS for v$pinned lists $asset, which is a different version"
    fi

    expected=$(sums_digest "$tmp/SHA256SUMS" "$asset")
    printf '%s\n' "$expected" | grep -Eq '^[0-9a-fA-F]{64}$' || die "SHA256SUMS has no valid digest for $asset"

    asset_url="$BASE_URL/download/v$version/$asset"
    say "Downloading $asset_url"
    download "$asset_url" "$tmp/$asset" || die "could not download $asset_url"

    actual=$(sha256_of "$tmp/$asset")
    expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
    if [ "$actual" != "$expected" ]; then
        die "checksum mismatch for $asset: SHA256SUMS says $expected, the download is ${actual:-<unreadable>}. \
Refusing to install. The file may be corrupt or tampered with; nothing was installed."
    fi
    say "Checksum verified (sha256 $actual)."

    verify_attestation "$tmp/$asset" "$version"

    mkdir "$tmp/x"
    tar -xzf "$tmp/$asset" -C "$tmp/x"
    dir="$tmp/x/dash-forge-$version-$target"
    [ -d "$dir" ] || die "$asset does not contain dash-forge-$version-$target/"

    if ! mkdir -p "$INSTALL_DIR" 2>/dev/null || [ ! -w "$INSTALL_DIR" ]; then
        die "cannot write to $INSTALL_DIR. Pick a directory you own with DASH_FORGE_INSTALL_DIR=... \
(this script never uses sudo; if you want a system-wide install, run it with sudo yourself)"
    fi

    for bin in $binaries; do
        case "$bin" in
            dg | git-remote-dash | forge-relay | forge-import) ;;
            *) die "unknown binary '$bin' in DASH_FORGE_BINARIES" ;;
        esac
        [ -f "$dir/$bin" ] || die "$asset does not contain $bin"
        # Copy then rename: replacing a running binary in place can crash it.
        cp "$dir/$bin" "$INSTALL_DIR/.$bin.tmp.$$"
        chmod 755 "$INSTALL_DIR/.$bin.tmp.$$"
        mv -f "$INSTALL_DIR/.$bin.tmp.$$" "$INSTALL_DIR/$bin"
        say "Installed $INSTALL_DIR/$bin"
    done

    if [ "${DASH_FORGE_COMPLETIONS:-0}" = 1 ]; then
        install_completions "$dir/completions"
    fi

    if [ -x "$INSTALL_DIR/dg" ]; then
        if dg_version=$("$INSTALL_DIR/dg" --version 2>/dev/null); then
            say ""
            say "$dg_version"
        else
            warn "$INSTALL_DIR/dg does not run on this system."
            case "$target" in
                *-linux-gnu) warn "an older glibc is the usual cause; try DASH_FORGE_TARGET=x86_64-unknown-linux-musl (static)" ;;
            esac
        fi
        found=$(command -v dg 2>/dev/null || true)
        if [ -n "$found" ] && [ "$found" != "$INSTALL_DIR/dg" ]; then
            warn "another dg comes first on your PATH: $found"
        fi
    fi

    path_advice

    say ""
    say "Next steps:"
    say "  dg doctor                     check git, git-remote-dash, network and identity"
    if [ -x "$INSTALL_DIR/dg" ] && "$INSTALL_DIR/dg" auth --help 2>/dev/null | grep -Eq '^ +new( |$)'; then
        say "  dg auth new                   create or import the identity dg signs with"
    else
        say "  dg auth login --identity F    import the identity dg signs with"
    fi
    say "  dg completions <shell>        shell completions (or rerun with DASH_FORGE_COMPLETIONS=1)"
    if [ "$target" != "${target%-apple-darwin}" ]; then
        say ""
        say "macOS: these binaries are not signed by Apple. install.sh downloads with curl, which"
        say "does not quarantine them, so Gatekeeper will not block them. See $DOCS_URL."
    fi
}

main "$@"
