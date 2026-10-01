#!/usr/bin/env bash
# How the Mirror Action gets dg, git-remote-dash and forge-import (`install` input):
#
#   install-forge.sh plan    decide: download the pinned release, or build from source.
#                            Writes method=release|source (and cache-key) to $GITHUB_OUTPUT.
#   install-forge.sh build   build the binaries from the Action's own source into $FORGE_BIN_DIR.
#
# "The Action's own source" is the checkout this script sits in: the commit, branch or tag the
# workflow names in `uses: PastaPastaPasta/dash-forge/action@<ref>` (GitHub downloads the whole
# repository for it). So a source build runs exactly the code the workflow pinned; no second
# ref has to be kept in step with it.
#
# Inputs arrive as INPUT_* environment variables already checked by validate.sh.
set -euo pipefail

REPO=PastaPastaPasta/dash-forge
BINARIES=(dg git-remote-dash forge-import)
# protoc for the source build (tenderdash-proto needs 25 or newer; Ubuntu's 3.21 fails). The
# checksum is of the release asset, the same pin the /mirror wizard's workflow used.
PROTOC_VERSION=28.3
PROTOC_SHA256_LINUX_X86_64=0ad949f04a6a174da83cdcbdb36dee0a4925272a5b6d83f79a6bf9852076d53f

die() {
    printf '::error title=Forge mirror install::%s\n' "$1"
    exit 1
}

src=${FORGE_SOURCE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}

sha256() {
    if command -v sha256sum >/dev/null; then
        sha256sum "$@" | awk '{ print $1 }'
    else
        shasum -a 256 "$@" | awk '{ print $1 }'
    fi
}

# The HTTP status of <url> after redirects, or 000 when it cannot be reached.
http_status() {
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 --silent --location --max-time 20 \
        --head --output /dev/null --write-out '%{http_code}' "$1" 2>/dev/null || true
}

plan() {
    local method
    case "${INPUT_INSTALL:-}" in
        source) method=source ;;
        true)
            local version=${INPUT_VERSION#v}
            local url="https://github.com/$REPO/releases/download/v$version/SHA256SUMS"
            local status
            status=$(http_status "$url")
            if [ "$status" = 404 ]; then
                # Not published (no Dash Forge release is tagged yet): build the same code instead.
                method=source
                printf "::notice title=Forge mirror install::Dash Forge v%s is not published, so this run builds dg, git-remote-dash and forge-import from the Action's own source (the ref in uses:). The first build takes several minutes; later runs reuse the build cache. Set install: 'source' to skip this check.\n" "$version"
            else
                # Published, or GitHub did not answer: install.sh retries and names the problem.
                method=release
            fi
            ;;
        *) die "install must be true, source or false when Dash Forge is installed by the Action (got '${INPUT_INSTALL:-}')." ;;
    esac
    echo "method=$method" >>"$GITHUB_OUTPUT"
    if [ "$method" = source ]; then
        [ -f "$src/Cargo.lock" ] || die "the Action's source at $src has no Cargo.lock, so it cannot be built. Use the Action from the dash-forge repository (uses: $REPO/action@<commit>)."
        # The build cache key: the runner platform, the dependency set and the toolchain (workspace
        # crates rebuild anyway). action.yml restores by its prefix, `dash-forge-build@<os>-<arch>@`.
        local hash
        hash=$(cat "$src/Cargo.lock" "$src/rust-toolchain.toml" 2>/dev/null | sha256 -)
        echo "cache-key=dash-forge-build@${RUNNER_OS:-}-${RUNNER_ARCH:-}@$hash" >>"$GITHUB_OUTPUT"
    fi
}

protoc_major() {
    local v
    v=$("$1" --version 2>/dev/null | awk '{ print $2 }') || return 1
    printf '%s\n' "${v%%.*}"
}

# A protoc of 25 or newer on PATH, downloading the pinned release when there is none.
ensure_protoc() {
    local have
    if command -v protoc >/dev/null && have=$(protoc_major protoc) && [ "${have:-0}" -ge 25 ] 2>/dev/null; then
        return 0
    fi
    local os arch
    os=$(uname -s)
    arch=$(uname -m)
    if [ "$os" != Linux ] || [ "$arch" != x86_64 ]; then
        die "building Dash Forge from source needs protoc $PROTOC_VERSION (25 or newer) on PATH, and this $os $arch runner has none the Action can install. Install it in an earlier step (for example brew install protobuf), or use an ubuntu-latest runner."
    fi
    local dir="$FORGE_TOOLS_DIR/protoc"
    mkdir -p "$dir"
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location \
        --retry 3 --output "$dir/protoc.zip" \
        "https://github.com/protocolbuffers/protobuf/releases/download/v$PROTOC_VERSION/protoc-$PROTOC_VERSION-linux-x86_64.zip" ||
        die "could not download protoc $PROTOC_VERSION"
    local got
    got=$(sha256 "$dir/protoc.zip")
    [ "$got" = "$PROTOC_SHA256_LINUX_X86_64" ] ||
        die "protoc $PROTOC_VERSION checksum mismatch (got $got); refusing to build with it."
    unzip -q -o "$dir/protoc.zip" -d "$dir" bin/protoc 'include/*' || die "could not unpack protoc $PROTOC_VERSION"
    chmod +x "$dir/bin/protoc"
    PATH="$dir/bin:$PATH"
    export PROTOC="$dir/bin/protoc"
}

build() {
    : "${FORGE_BIN_DIR:?}" "${FORGE_TARGET_DIR:?}" "${FORGE_TOOLS_DIR:?}"
    command -v cargo >/dev/null ||
        die "building Dash Forge from source needs Rust (cargo). GitHub's ubuntu-latest runners have it; elsewhere, add a Rust toolchain step before this one, or build the binaries yourself and set install: 'false'."
    ensure_protoc
    # The dev profile without debug info: it compiles in a few minutes where a release build
    # takes several times longer, and keeps the cached target directory small. (The mirror is
    # bound by the network, not the CPU.)
    export CARGO_TARGET_DIR="$FORGE_TARGET_DIR" CARGO_PROFILE_DEV_DEBUG=0
    # `dg --version` names the commit: a commit id in `uses:` (a tarball has no .git to ask).
    if [[ ${DASH_FORGE_ACTION_REF:-} =~ ^[0-9a-f]{40}$ ]]; then
        export DASH_FORGE_BUILD_SHA="$DASH_FORGE_ACTION_REF"
    fi
    # The restored build cache holds the workspace crates of whichever commit saved it. Cargo
    # judges them fresh by file times, and a source tarball's files carry its commit's time, so
    # an older commit's build can look newer than these sources. Forget the workspace crates'
    # fingerprints so they are always rebuilt from this source; dependencies stay cached.
    local f name
    for f in "$CARGO_TARGET_DIR"/debug/.fingerprint/*; do
        [ -e "$f" ] || continue
        name=${f##*/}
        [ ! -d "$src/crates/${name%-*}" ] || rm -rf "$f"
    done
    local pkgs=()
    for b in "${BINARIES[@]}"; do pkgs+=(-p "$b"); done
    echo "::group::cargo build --locked ${pkgs[*]} ($src)"
    # From the source root, so rustup picks up (and installs) the toolchain rust-toolchain.toml pins.
    (cd "$src" && cargo build --locked "${pkgs[@]}") || {
        echo "::endgroup::"
        die "building Dash Forge from source failed (the log above has cargo's error)."
    }
    echo "::endgroup::"
    mkdir -p "$FORGE_BIN_DIR"
    for b in "${BINARIES[@]}"; do
        [ -f "$CARGO_TARGET_DIR/debug/$b" ] || die "the build did not produce $b"
        cp "$CARGO_TARGET_DIR/debug/$b" "$FORGE_BIN_DIR/$b"
        chmod 755 "$FORGE_BIN_DIR/$b"
    done
    echo "Built ${BINARIES[*]} from $src into $FORGE_BIN_DIR."
}

case "${1:-}" in
    plan) plan ;;
    build) build ;;
    *) die "usage: install-forge.sh plan|build" ;;
esac
