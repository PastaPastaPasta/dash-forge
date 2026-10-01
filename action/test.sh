#!/usr/bin/env bash
# Offline tests for the Mirror Action's scripts: summary.sh against the fixtures in
# testdata/, and validate.sh against good and bad inputs. Run: bash action/test.sh
# Literal $(...) in single quotes below are inputs that must be rejected.
# shellcheck disable=SC2016
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0

# run_summary <fixture>: fills $tmp/{md,out,ann}.
run_summary() {
    : >"$tmp/md"
    : >"$tmp/out"
    GITHUB_STEP_SUMMARY="$tmp/md" GITHUB_OUTPUT="$tmp/out" FORGE_MIRROR_NOW_MS=1788000000000 \
        bash "$here/summary.sh" "$here/testdata/$1" >"$tmp/ann"
}
# fail <message>: report and count a failed check of the current case.
fail() {
    echo "FAIL [$case] $*"
    fails=$((fails + 1))
}
# expect <file> <fixed string> / reject <file> <fixed string>
expect() {
    grep -qF -- "$2" "$tmp/$1" || fail "$1 lacks: $2"
}
reject() {
    ! grep -qF -- "$2" "$tmp/$1" || fail "$1 has: $2"
}

case=ok
run_summary ok.json
expect md '### Forge mirror updated'
expect md '(repository created by this run)'
expect md '| Ref updates | 3 |'
expect md '| Packs | 2 (3.00 MiB) |'
expect md '| Comments | 7 |'
expect md '| Labels | 6 |'
reject md 'Skipped'
expect md '| **Spent** | **0.025 DASH** |'
expect md '| Estimate | 0.026 DASH |'
expect md '| Runner key budget left | 0.45 of 0.5 DASH, expires 2100-01-01 |'
expect md '| Identity balance | 0.4 DASH |'
expect ann '::warning title=Forge mirror::release v2.3.0 asset app.tar.gz has no digest'
reject ann 'nearly used up'
reject ann 'expires soon'
reject ann '::error'
expect out 'status=ok'
expect out 'spent-dash=0.025'

case=dry-run
run_summary dry-run.json
expect md 'dry run (estimate only, nothing was written)'
expect md '| Would write | |'
expect md '| Issues | 40 |'
expect md '| **Estimated cost** | **0.042 DASH** |'
reject md '| **Spent**'
expect md 'no budget (not a limited key)'
reject md 'Identity balance'
expect ann '::warning title=Not a limited key::'
expect out 'status=dry_run'
expect out 'spent-dash=0'

case=cap-exceeded
run_summary cap-exceeded.json
expect md 'stopped: cost cap reached'
expect md '**Error:** estimate 0.09 DASH exceeds --max-spend 0.05 \| nothing written'
expect ann '::warning title=Runner key nearly used up::0.05 of 0.5 DASH left. Renew at forge.dashhq.org/8hJmcHWTowner/project/settings/mirror.'
expect ann '::warning title=Runner key expires soon::The runner key expires in 23 days.'
expect ann '::warning title=Forge mirror::line one ::error::injected'
expect ann '::error title=Forge mirror cap_exceeded::estimate 0.09 DASH exceeds'
[ "$(grep -c '^::' "$tmp/ann")" = 4 ] || fail "an annotation was split or injected"
expect out 'status=cap_exceeded'

case=partial
run_summary partial.json
expect md '### Forge mirror updated with skipped items'
expect md '| Skipped (retried next run) | 2 |'
expect md '| **Spent** | **0.013 DASH** |'
expect ann '::warning title=Forge mirror::issue #7: number already taken in the destination; skipped'
expect ann '::warning title=Forge mirror skipped items::2 item(s) were skipped'
reject ann '::error'
expect out 'status=partial'
expect out 'spent-dash=0.013'

case=error
run_summary error.json
expect md '### Forge mirror failed'
expect ann '::error title=Forge mirror error::GitHub API: 404 Not Found (alice/project)'
expect out 'status=error'

# D-601: a push that failed after some refs landed reports them, not "0 ref updates".
case=error-partial-push
run_summary error-partial-push.json
expect md '### Forge mirror failed'
expect md '| Written before it stopped | |'
expect md '| Ref updates | 2 |'
reject md '| Written | |'
expect ann '::warning title=Forge mirror::the git push (branches and tags) failed after writing 2 ref update(s)'
expect ann '::error title=Forge mirror error::pushing to dash://'
expect out 'status=error'

case=garbage
run_summary garbage.json
expect ann '::error title=Forge mirror failed::no run summary was written'
expect out 'status=error'

case=missing
run_summary does-not-exist.json
expect out 'status=error'

# Schema drift must not fail the step, and the outputs must still be written.
case=drift
printf '{"status":"ok","repo":"x","counts":null,"warnings":"w","spentCredits":1e30,"key":{"expiresAt":1e30}}' \
    >"$here/testdata/.drift.json"
run_summary .drift.json || fail "exited non-zero"
rm -f "$here/testdata/.drift.json"
expect out 'status=ok'
expect out 'spent-dash=0'
reject ann 'expires soon'

# validate.sh: every INPUT_* is set explicitly; one override per case.
validate() {
    : >"$tmp/vout"
    env -i PATH="$PATH" GITHUB_ENV="$tmp/env" GITHUB_OUTPUT="$tmp/vout" \
        INPUT_REPO=alice/project INPUT_GITHUB_REPO=alice/project INPUT_NETWORK=mainnet \
        INPUT_DEVNET_NAME='' INPUT_SYNC=code,releases INPUT_STORAGE_KIND=platform \
        INPUT_REPLICAS=1 INPUT_COST_CAP=0.05 INPUT_DRY_RUN=false INPUT_INSTALL=true \
        INPUT_STATE_CACHE=true INPUT_VERSION=0.1.0 INPUT_S3_ENDPOINT='' INPUT_S3_BUCKET='' \
        INPUT_S3_REGION='' INPUT_S3_PUBLIC_URL='' INPUT_S3_PREFIX='' INPUT_PINNING_ENDPOINT='' \
        "$@" bash "$here/validate.sh" >"$tmp/val" 2>&1
}
good() {
    case="validate ok $*"
    validate "$@" || fail "rejected: $(cat "$tmp/val")"
}
bad() {
    case="validate bad $*"
    if validate "$@"; then
        fail accepted
    fi
}
good
good INPUT_REPO=dash://alice/project
good INPUT_REPO=project INPUT_SYNC=code,issues,prs,releases,labels INPUT_COST_CAP=0.25
good INPUT_GITHUB_REPO=https://github.com/alice/project.js
good INPUT_NETWORK=devnet INPUT_DEVNET_NAME=moutai
expect vout 'devnet-name=moutai'
# devnet-name has a default, so it is ignored (and not passed on) for the other networks.
good INPUT_NETWORK=testnet INPUT_DEVNET_NAME=bonsia
expect vout 'devnet-name='
reject vout 'bonsia'
good INPUT_INSTALL=source INPUT_VERSION=latest
good INPUT_INSTALL=false INPUT_VERSION=''
good INPUT_STORAGE_KIND=s3 INPUT_S3_ENDPOINT=https://x.r2.cloudflarestorage.com INPUT_S3_BUCKET=forge
good INPUT_STORAGE_KIND=ipfs-pinning INPUT_PINNING_ENDPOINT=https://api.pinata.cloud/psa
bad INPUT_REPO='alice/project; rm -rf /'
bad INPUT_REPO='$(id)'
bad INPUT_REPO=$'alice/project\n--dry-run'
bad INPUT_REPO=-rf
bad INPUT_REPO=''
bad INPUT_GITHUB_REPO='alice/project/extra'
bad INPUT_NETWORK=regtest
bad INPUT_NETWORK=devnet
bad INPUT_SYNC=code,wiki
bad INPUT_SYNC=''
bad INPUT_SYNC=code,
bad INPUT_SYNC=$'code\n--dry-run'
bad INPUT_NETWORK=devnet INPUT_DEVNET_NAME='x@y'
bad INPUT_INSTALL=yes
good INPUT_INSTALL=true INPUT_VERSION=''
good INPUT_BUILD_CACHE=false
bad INPUT_BUILD_CACHE=maybe
bad INPUT_COST_CAP=abc
bad INPUT_COST_CAP=0
bad INPUT_COST_CAP=1e3
bad INPUT_REPLICAS=0
bad INPUT_DRY_RUN=yes
bad INPUT_FAIL_ON_PARTIAL=maybe
bad INPUT_STORAGE_KIND=gcs
bad INPUT_STORAGE_KIND=s3
bad INPUT_STORAGE_KIND=s3 INPUT_S3_ENDPOINT=http://insecure INPUT_S3_BUCKET=b
bad INPUT_STORAGE_KIND=ipfs-pinning
bad INPUT_VERSION=latest
bad INPUT_STORAGE_KIND=s3 INPUT_S3_ENDPOINT=https://x.example INPUT_S3_BUCKET=b INPUT_S3_PREFIX=$'a\nb'
bad INPUT_STORAGE_KIND=s3 INPUT_S3_ENDPOINT='https://x.example/$(id)' INPUT_S3_BUCKET=b
good INPUT_STORAGE_KIND=s3 INPUT_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com INPUT_S3_BUCKET=forge \
    INPUT_S3_VIRTUAL_HOSTED=true
bad INPUT_STORAGE_KIND=s3 INPUT_S3_ENDPOINT=https://x.example INPUT_S3_BUCKET=forge INPUT_S3_VIRTUAL_HOSTED=yes
bad INPUT_S3_VIRTUAL_HOSTED=true

# mirror.sh with stub binaries that record their arguments and environment.
mkdir -p "$tmp/bin"
printf '#!/bin/sh\nprintf "%%s\\n" "$@" >"$STUB_OUT/args"\nenv >"$STUB_OUT/env"\nexit "${STUB_RC:-0}"\n' >"$tmp/bin/forge-import"
printf '#!/bin/sh\nprintf "%%s\\n" "$@" >"$STUB_OUT/dg"\n' >"$tmp/bin/dg"
printf '#!/bin/sh\n' >"$tmp/bin/git-remote-dash"
chmod +x "$tmp/bin"/*
mirror() {
    rm -f "$tmp/args" "$tmp/env" "$tmp/dg" "$tmp/identity.json"
    env -i PATH="$PATH" STUB_OUT="$tmp" FORGE_BIN_DIR="$tmp/bin" \
        FORGE_SUMMARY="$tmp/s.json" FORGE_STATE="$tmp/state/state.json" FORGE_WORK_DIR="$tmp/git" \
        FORGE_KEY_FILE="$tmp/identity.json" FORGE_STORAGE_CONFIG="$tmp/storage.toml" \
        INPUT_REPO=project INPUT_GITHUB_REPO=alice/project INPUT_NETWORK=devnet INPUT_DEVNET_NAME=moutai \
        INPUT_SYNC=code INPUT_STORAGE_KIND=platform INPUT_REPLICAS=1 INPUT_COST_CAP=0.25 \
        INPUT_DRY_RUN=true INPUT_S3_ENDPOINT='' INPUT_S3_BUCKET='' INPUT_S3_REGION='' \
        INPUT_S3_PUBLIC_URL='' INPUT_S3_PREFIX='' INPUT_PINNING_ENDPOINT='' GITHUB_TOKEN=ghtok \
        "$@" bash "$here/mirror.sh" >"$tmp/log" 2>&1
}
case="mirror dfk1"
mirror DASH_FORGE_KEY=' dfk1:devnet:Id1:3:cWIFsecret ' || fail "exited $?"
expect log '::add-mask::cWIFsecret'
expect env 'DASH_FORGE_KEY=dfk1:devnet:Id1:3:cWIFsecret'
expect env 'GH_TOKEN=ghtok'
expect env 'GIT_CONFIG_COUNT=0'
expect args '--max-spend'
expect args '0.25'
expect args '--devnet-name'
expect args '--dry-run'
reject args 'dash.storage'

case="mirror json + s3"
mirror DASH_FORGE_KEY='{"identityId":"Id1","identityKeys":[{"privateKeyWif":"cJSONsecret"}]}' \
    INPUT_STORAGE_KIND=s3 INPUT_S3_ENDPOINT=https://x.example INPUT_S3_BUCKET=b \
    S3_ACCESS_KEY_ID=AK S3_SECRET_ACCESS_KEY=SK INPUT_DRY_RUN=false || fail "exited $?"
expect log '::add-mask::cJSONsecret'
expect env "DASH_FORGE_KEY=$tmp/identity.json"
expect identity.json 'cJSONsecret'
[ "$(stat -c %a "$tmp/identity.json" 2>/dev/null || stat -f %Lp "$tmp/identity.json")" = 600 ] ||
    fail "identity file is not 0600"
expect dg 'env:S3_SECRET_ACCESS_KEY'
reject dg 'SK'
expect env 'GIT_CONFIG_KEY_0=dash.storage'
expect env 'GIT_CONFIG_VALUE_0=mirror'
expect env 'GIT_CONFIG_KEY_2=dash.platformFallback'
expect env 'GIT_CONFIG_COUNT=3'
reject args '--dry-run'
reject dg '--virtual-hosted'

case="mirror s3 virtual-hosted"
mirror DASH_FORGE_KEY=dfk1:a:b:1:w INPUT_STORAGE_KIND=s3 INPUT_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com \
    INPUT_S3_BUCKET=b INPUT_S3_VIRTUAL_HOSTED=true S3_ACCESS_KEY_ID=AK S3_SECRET_ACCESS_KEY=SK ||
    fail "exited $?"
expect dg '--virtual-hosted'

case="mirror exit codes"
mirror DASH_FORGE_KEY=dfk1:a:b:1:w STUB_RC=4 || fail "partial (4) failed the step"
expect log 'the next run retries them'
if mirror DASH_FORGE_KEY=dfk1:a:b:1:w STUB_RC=4 INPUT_FAIL_ON_PARTIAL=true; then
    fail "partial with fail-on-partial passed"
fi
for rc in 1 3; do
    if mirror DASH_FORGE_KEY=dfk1:a:b:1:w STUB_RC=$rc; then fail "exit $rc passed"; fi
done

case="mirror empty key"
if mirror DASH_FORGE_KEY=''; then fail "accepted"; fi
expect log 'DASH_FORGE_KEY is empty'
case="mirror s3 without secrets"
if mirror DASH_FORGE_KEY=dfk1:a:b:1:w INPUT_STORAGE_KIND=s3; then fail "accepted"; fi
expect log 'S3_SECRET_ACCESS_KEY'

# action.yml's defaults: a network Forge is deployed on (the hosted site's devnet), and the
# install mode that works without a published release.
case="action.yml defaults"
default_of() {
    awk -v want="  $1:" '$0 == want { found = 1; next } found && /^    default:/ { sub(/^    default: */, ""); gsub(/"/, ""); print; exit }' "$here/action.yml"
}
[ "$(default_of network)" = devnet ] || fail "network defaults to '$(default_of network)'"
devnet_default=$(default_of devnet-name)
[ -f "$here/../forge-contracts/deployments/devnet-$devnet_default.json" ] ||
    fail "no deployment for the default devnet '$devnet_default'"
[ "$(default_of install)" = true ] || fail "install defaults to '$(default_of install)'"
[ -z "$(default_of version)" ] || fail "version defaults to '$(default_of version)' (a release must be pinned on purpose)"
[ "$(default_of build-cache)" = true ] || fail "build-cache defaults to '$(default_of build-cache)'"
# The defaults pass validation as they are.
good INPUT_NETWORK="$(default_of network)" INPUT_DEVNET_NAME="$devnet_default" INPUT_VERSION="$(default_of version)"
expect vout "devnet-name=$devnet_default"

# install-forge.sh with stub curl, cargo, protoc and uname, on a PATH without the real ones.
ib="$tmp/ibin"
mkdir -p "$ib"
# curl: records its arguments and writes junk to the --output file.
cat >"$ib/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$STUB_OUT/curl"
out=''
while [ $# -gt 0 ]; do
    [ "$1" != --output ] || out=$2
    shift
done
printf 'not a zip' >"$out"
EOF
# cargo: `metadata` lists the workspace; `build` records its arguments and environment and
# makes the binaries asked for.
cat >"$ib/cargo" <<'EOF'
#!/bin/sh
if [ "$1" = metadata ]; then
    echo '{"packages":[{"name":"dg"},{"name":"forge-core"},{"name":"git-remote-dash"}]}'
    exit 0
fi
printf '%s\n' "$*" >"$STUB_OUT/cargo"
pwd >"$STUB_OUT/cargo-pwd"
env >"$STUB_OUT/cargo-env"
mkdir -p "$CARGO_TARGET_DIR/debug"
while [ $# -gt 0 ]; do
    [ "$1" != -p ] || printf '#!/bin/sh\n' >"$CARGO_TARGET_DIR/debug/$2"
    shift
done
EOF
printf '#!/bin/sh\necho "libprotoc ${STUB_PROTOC:-28.3}"\n' >"$ib/protoc"
printf '#!/bin/sh\ncase "$1" in -s) echo "${STUB_OS:-Linux}" ;; -m) echo "${STUB_ARCH:-x86_64}" ;; esac\n' >"$ib/uname"
ln -s "$(command -v jq)" "$ib/jq"
chmod +x "$ib"/*
# install_forge plan|build [VAR=value...]: run install-forge.sh with stub tools.
install_forge() {
    local sub=$1
    shift
    : >"$tmp/iout"
    rm -rf "$tmp/curl" "$tmp/cargo" "$tmp/cargo-pwd" "$tmp/cargo-env" "$tmp/forge-bin" "$tmp/tools"
    env -i PATH="$ib:/usr/bin:/bin" STUB_OUT="$tmp" GITHUB_OUTPUT="$tmp/iout" \
        INPUT_INSTALL=true INPUT_VERSION='' FORGE_BIN_DIR="$tmp/forge-bin" \
        FORGE_TARGET_DIR="$tmp/target" FORGE_TOOLS_DIR="$tmp/tools" GITHUB_RUN_ID=1 GITHUB_JOB=j \
        "$@" "$BASH" "$here/install-forge.sh" "$sub" >"$tmp/ilog" 2>&1
}

case="install plan: no release pinned builds from source"
install_forge plan RUNNER_OS=Linux RUNNER_ARCH=X64 || fail "exited $?"
expect iout 'method=source'
expect iout 'cache-key=dash-forge-build@Linux-X64@'
expect ilog '::notice title=Dash Forge install::No Dash Forge release is pinned'
case="install plan: a pinned release is downloaded, never probed for"
install_forge plan INPUT_VERSION=0.2.0 || fail "exited $?"
expect iout 'method=release'
reject iout 'cache-key'
[ ! -e "$tmp/curl" ] || fail "probed for a release"
case="install plan: source, whatever the version"
install_forge plan INPUT_INSTALL=source INPUT_VERSION=0.2.0 || fail "exited $?"
expect iout 'method=source'
case="install plan: no rust-toolchain.toml still makes a key"
mkdir -p "$tmp/src/action"
cp "$here/install-forge.sh" "$tmp/src/action/"
printf 'lock\n' >"$tmp/src/Cargo.lock"
: >"$tmp/iout"
env -i PATH="$ib:/usr/bin:/bin" GITHUB_OUTPUT="$tmp/iout" INPUT_INSTALL=source \
    "$BASH" "$tmp/src/action/install-forge.sh" plan >"$tmp/ilog" 2>&1 || fail "exited $?"
expect iout 'cache-key=dash-forge-build@-@'

case="install build"
install_forge build || fail "exited: $(cat "$tmp/ilog")"
expect cargo 'build --locked --config profile.dev.package."*".opt-level=2 -p dg -p git-remote-dash -p forge-import'
expect cargo-env 'CARGO_PROFILE_DEV_DEBUG=0'
expect cargo-env 'CARGO_INCREMENTAL=0'
reject cargo-env 'DASH_FORGE_BUILD_SHA'
[ "$(cat "$tmp/cargo-pwd")" = "$(cd "$here/.." && pwd)" ] ||
    fail "cargo did not run from the Action's source root"
for b in dg git-remote-dash forge-import; do
    [ -x "$tmp/forge-bin/$b" ] || fail "$b not installed"
done
[ ! -e "$tmp/curl" ] || fail "downloaded protoc though a new one is on PATH"
case="install build: check-action's dg only"
install_forge build FORGE_BINARIES=dg || fail "exited $?"
expect cargo '-p dg'
reject cargo 'forge-import'
[ ! -e "$tmp/forge-bin/forge-import" ] || fail "installed forge-import"

fingerprints() {
    rm -rf "$tmp/target/debug/.fingerprint"
    mkdir -p "$tmp/target/debug/.fingerprint/forge-core-0123abcd" "$tmp/target/debug/.fingerprint/dg-77" \
        "$tmp/target/debug/.fingerprint/serde-0123abcd" "$tmp/target/debug/.fingerprint/dgx-1"
}
case="install build: a restored cache's workspace crates are forgotten"
fingerprints
install_forge build GITHUB_RUN_ID=2 || fail "exited $?"
for d in forge-core-0123abcd dg-77; do
    [ ! -e "$tmp/target/debug/.fingerprint/$d" ] || fail "kept $d"
done
for d in serde-0123abcd dgx-1; do
    [ -e "$tmp/target/debug/.fingerprint/$d" ] || fail "removed dependency $d"
done
case="install build: a second use in the same job keeps them"
fingerprints
install_forge build GITHUB_RUN_ID=2 || fail "exited $?"
[ -e "$tmp/target/debug/.fingerprint/forge-core-0123abcd" ] || fail "rebuilt this job's own workspace crates"

case="install build at a pinned commit"
install_forge build DASH_FORGE_ACTION_REF=0123456789abcdef0123456789abcdef01234567 || fail "exited $?"
expect cargo-env 'DASH_FORGE_BUILD_SHA=0123456789abcdef0123456789abcdef01234567'
case="install build at a branch"
install_forge build DASH_FORGE_ACTION_REF=master || fail "exited $?"
reject cargo-env 'DASH_FORGE_BUILD_SHA'
case="install build ignores the calling job's Rust settings"
install_forge build RUSTFLAGS=-Ctarget-cpu=native CARGO_ENCODED_RUSTFLAGS=x CARGO_BUILD_RUSTFLAGS=x RUSTDOCFLAGS=x \
    RUSTC_WRAPPER=sccache RUSTC_WORKSPACE_WRAPPER=x CARGO_BUILD_TARGET=wasm32-unknown-unknown \
    CARGO_BUILD_TARGET_DIR=/elsewhere CARGO_TARGET_DIR=/elsewhere RUSTUP_TOOLCHAIN=nightly CARGO_INCREMENTAL=1 \
    CARGO_PROFILE_DEV_OPT_LEVEL=3 CARGO_PROFILE_DEV_DEBUG=2 CARGO_PROFILE_RELEASE_LTO=true || fail "exited $?"
for v in RUSTFLAGS CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS RUSTDOCFLAGS RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER \
    CARGO_BUILD_TARGET CARGO_BUILD_TARGET_DIR RUSTUP_TOOLCHAIN CARGO_PROFILE_DEV_OPT_LEVEL CARGO_PROFILE_RELEASE_LTO; do
    ! grep -q "^$v=" "$tmp/cargo-env" || fail "$v reached cargo"
done
expect cargo-env "CARGO_TARGET_DIR=$tmp/target"
expect cargo-env 'CARGO_PROFILE_DEV_DEBUG=0'
expect cargo-env 'CARGO_INCREMENTAL=0'
case="install plan: the cache key covers the binaries built"
install_forge plan
key_all=$(sed -n 's/^cache-key=//p' "$tmp/iout")
install_forge plan FORGE_BINARIES=dg
key_dg=$(sed -n 's/^cache-key=//p' "$tmp/iout")
[ -n "$key_all" ] && [ "$key_all" != "$key_dg" ] || fail "the same key for different binaries"
case="install build without cargo"
mv "$ib/cargo" "$ib/cargo.off"
if install_forge build; then fail "succeeded"; fi
expect ilog '::error title=Dash Forge install::building Dash Forge from source needs Rust (cargo)'
# A caller that reports the failure itself asks for a warning.
if install_forge build FORGE_INSTALL_SEVERITY=warning; then fail "succeeded"; fi
expect ilog '::warning title=Dash Forge install::building Dash Forge from source needs Rust (cargo)'
mv "$ib/cargo.off" "$ib/cargo"
case="install build: old protoc on macOS"
if install_forge build STUB_PROTOC=3.21.12 STUB_OS=Darwin STUB_ARCH=arm64; then fail "succeeded"; fi
expect ilog 'needs protoc 28.3 (25 or newer) on PATH'
[ ! -e "$tmp/cargo" ] || fail "built anyway"
case="install build: protoc download with a bad checksum"
if install_forge build STUB_PROTOC=3.21.12; then fail "succeeded"; fi
expect curl 'protoc-28.3-linux-x86_64.zip'
expect ilog 'protoc 28.3 checksum mismatch'
[ ! -e "$tmp/cargo" ] || fail "built anyway"
case="install build: protoc for arm64 Linux"
if install_forge build STUB_PROTOC=3.21.12 STUB_ARCH=aarch64; then fail "succeeded"; fi
expect curl 'protoc-28.3-linux-aarch_64.zip'
expect ilog 'protoc 28.3 checksum mismatch'

if [ "$fails" -ne 0 ]; then
    echo "$fails check(s) failed"
    exit 1
fi
echo "action/test.sh: all checks passed"
