#!/usr/bin/env bash
# How the Mirror Action (and check-action) gets its Dash Forge binaries (`install` input):
#
#   install-forge.sh plan    decide: download release `version`, or build from source.
#                            Writes method=release|source (and cache-key) to $GITHUB_OUTPUT.
#   install-forge.sh build   build $FORGE_BINARIES from the Action's own source into $FORGE_BIN_DIR.
#
# "The Action's own source" is the checkout this script sits in: the commit, branch or tag the
# workflow names in `uses: PastaPastaPasta/dash-forge/<action>@<ref>` (GitHub downloads the
# whole repository for it). So a source build compiles the code the workflow pinned; no second
# ref has to be kept in step with it. Its compiled dependencies may come from the build cache,
# which is trusted like any other cache of the repository (`build-cache: 'false'` skips it).
#
# Inputs arrive as INPUT_* environment variables already checked by validate.sh.
set -euo pipefail

REPO=PastaPastaPasta/dash-forge
read -r -a BINARIES <<<"${FORGE_BINARIES:-dg git-remote-dash forge-import}"
# protoc for the source build (tenderdash-proto needs 25 or newer; Ubuntu's 3.21 fails). The
# checksums are of protobuf's v28.3 release assets.
PROTOC_VERSION=28.3
PROTOC_SHA256_LINUX_X86_64=0ad949f04a6a174da83cdcbdb36dee0a4925272a5b6d83f79a6bf9852076d53f
PROTOC_SHA256_LINUX_AARCH_64=1de522032a8b194002fe35cab86d747848238b5e4de4f99648372079f5b46f9a
# The version of build()'s settings, part of the build cache key: bump it with them.
BUILD_SETTINGS=v2

# The annotation a failure makes: `error`, or `warning` for a caller that reports the failure
# itself and must not fail the job by default (check-action without fail-on-error).
die() {
    local level=error
    [ "${FORGE_INSTALL_SEVERITY:-}" != warning ] || level=warning
    printf '::%s title=Dash Forge install::%s\n' "$level" "$1"
    exit 1
}

# Settings the build makes its own. The calling job's Rust environment (check-action runs inside
# arbitrary CI jobs) must not change what is compiled, or where.
BUILD_ENV_UNSET=(RUSTFLAGS CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS RUSTDOCFLAGS RUSTC_WRAPPER
    RUSTC_WORKSPACE_WRAPPER CARGO_BUILD_TARGET CARGO_BUILD_TARGET_DIR RUSTUP_TOOLCHAIN CARGO_TARGET_DIR
    CARGO_INCREMENTAL CARGO_BUILD_INCREMENTAL)

src=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

sha256() {
    if command -v sha256sum >/dev/null; then
        sha256sum "$@" | awk '{ print $1 }'
    else
        shasum -a 256 "$@" | awk '{ print $1 }'
    fi
}

plan() {
    local method
    case "${INPUT_INSTALL:-}" in
        source) method=source ;;
        true)
            if [ -n "${INPUT_VERSION:-}" ]; then
                method=release
            else
                # No release pinned: build the pinned code instead. A release is never picked
                # up behind the workflow's back; the commit that cuts one sets `version`.
                method=source
                printf "::notice title=Dash Forge install::No Dash Forge release is pinned (version is empty), so this run builds %s from the Action's own source (the ref in uses:). The first build takes several minutes; later runs reuse the build cache.\n" "${BINARIES[*]}"
            fi
            ;;
        *) die "install must be true, source or false when Dash Forge is installed by the Action (got '${INPUT_INSTALL:-}')." ;;
    esac
    echo "method=$method" >>"$GITHUB_OUTPUT"
    if [ "$method" = source ]; then
        [ -f "$src/Cargo.lock" ] || die "the Action's source at $src has no Cargo.lock, so it cannot be built. Use the Action from the dash-forge repository (uses: $REPO/<action>@<commit>)."
        # The build cache key: the runner platform, the build settings (BUILD_SETTINGS, bumped when
        # build() changes them) and binaries, the dependency set and the toolchain (workspace crates
        # rebuild anyway). action.yml restores by its prefix, `dash-forge-build@<os>-<arch>@`.
        local hash
        hash=$({
            printf '%s %s\n' "$BUILD_SETTINGS" "${BINARIES[*]}"
            cat "$src/Cargo.lock"
            cat "$src/rust-toolchain.toml" 2>/dev/null || true
        } | sha256 -)
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
    local os arch asset want
    os=$(uname -s)
    arch=$(uname -m)
    case "$os $arch" in
        'Linux x86_64') asset=linux-x86_64 want=$PROTOC_SHA256_LINUX_X86_64 ;;
        'Linux aarch64' | 'Linux arm64') asset=linux-aarch_64 want=$PROTOC_SHA256_LINUX_AARCH_64 ;;
        *) die "building Dash Forge from source needs protoc $PROTOC_VERSION (25 or newer) on PATH, and this $os $arch runner has none the Action can install. Install it in an earlier step (for example brew install protobuf), or use an ubuntu runner." ;;
    esac
    local dir="$FORGE_TOOLS_DIR/protoc"
    mkdir -p "$dir"
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location \
        --retry 3 --output "$dir/protoc.zip" \
        "https://github.com/protocolbuffers/protobuf/releases/download/v$PROTOC_VERSION/protoc-$PROTOC_VERSION-$asset.zip" ||
        die "could not download protoc $PROTOC_VERSION"
    local got
    got=$(sha256 "$dir/protoc.zip")
    [ "$got" = "$want" ] ||
        die "protoc $PROTOC_VERSION checksum mismatch (got $got); refusing to build with it."
    unzip -q -o "$dir/protoc.zip" -d "$dir" bin/protoc 'include/*' || die "could not unpack protoc $PROTOC_VERSION"
    chmod +x "$dir/bin/protoc"
    PATH="$dir/bin:$PATH"
    export PROTOC="$dir/bin/protoc"
}

build() {
    : "${FORGE_BIN_DIR:?}" "${FORGE_TARGET_DIR:?}" "${FORGE_TOOLS_DIR:?}"
    command -v cargo >/dev/null ||
        die "building Dash Forge from source needs Rust (cargo). GitHub's ubuntu runners have it; elsewhere, add a Rust toolchain step before this one, or build the binaries yourself and set install: 'false'."
    command -v jq >/dev/null || die "building Dash Forge from source needs jq (GitHub's runners have it)."
    ensure_protoc
    # The dev profile without debug info or incremental data: it compiles in a few minutes where
    # a release build takes several times longer, and keeps the cached target directory small.
    # Dependencies (SHA-1, zlib, the Platform SDK) are optimized, once per Cargo.lock thanks to
    # the cache, so packing a big repository is not slow.
    local v
    unset "${BUILD_ENV_UNSET[@]}"
    for v in $(compgen -e); do
        case "$v" in CARGO_PROFILE_*) unset "$v" ;; esac
    done
    export CARGO_TARGET_DIR="$FORGE_TARGET_DIR" CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0
    # `dg --version` names the commit: a commit id in `uses:` (a tarball has no .git to ask).
    if [[ ${DASH_FORGE_ACTION_REF:-} =~ ^[0-9a-f]{40}$ ]]; then
        export DASH_FORGE_BUILD_SHA="$DASH_FORGE_ACTION_REF"
    fi
    # A restored build cache holds the workspace crates of whichever commit saved it. Cargo
    # judges them fresh by file times, and a source tarball's files carry its commit's time, so
    # an older commit's build can look newer than these sources. Forget the workspace crates'
    # fingerprints so they are rebuilt from this source; dependencies stay cached. A target
    # this job already built from this source (a second use of the Action) is trusted as it is.
    local stamp="$CARGO_TARGET_DIR/.dash-forge-built" this
    this="$src ${GITHUB_RUN_ID:-}-${GITHUB_RUN_ATTEMPT:-}-${GITHUB_JOB:-}"
    if [ "$(cat "$stamp" 2>/dev/null || true)" != "$this" ]; then
        local members f name
        members=$(cd "$src" && cargo metadata --no-deps --format-version 1 --locked | jq -r '.packages[].name') ||
            die "could not list the Dash Forge workspace crates (cargo metadata failed)."
        for f in "$CARGO_TARGET_DIR"/debug/.fingerprint/*; do
            [ -e "$f" ] || continue
            name=${f##*/}
            ! grep -qxF -- "${name%-*}" <<<"$members" || rm -rf "$f"
        done
    fi
    local pkgs=()
    for b in "${BINARIES[@]}"; do pkgs+=(-p "$b"); done
    echo "::group::cargo build --locked ${pkgs[*]} ($src)"
    # From the source root, so rustup picks up (and installs) the toolchain rust-toolchain.toml pins.
    (cd "$src" && cargo build --locked --config 'profile.dev.package."*".opt-level=2' "${pkgs[@]}") || {
        echo "::endgroup::"
        die "building Dash Forge from source failed (the log above has cargo's error)."
    }
    echo "::endgroup::"
    printf '%s\n' "$this" >"$stamp"
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
