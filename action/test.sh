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
# expect <file> <fixed string> / reject <file> <fixed string>
expect() {
    grep -qF -- "$2" "$tmp/$1" || { echo "FAIL [$case] $1 lacks: $2"; fails=$((fails + 1)); }
}
reject() {
    ! grep -qF -- "$2" "$tmp/$1" || { echo "FAIL [$case] $1 has: $2"; fails=$((fails + 1)); }
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
expect ann '::warning title=Forge mirror::release v1.0 asset app.tar.gz has no digest'
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
[ "$(grep -c '^::' "$tmp/ann")" = 4 ] || { echo "FAIL [$case] an annotation was split or injected"; fails=$((fails + 1)); }
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
run_summary .drift.json || { echo "FAIL [$case] exited non-zero"; fails=$((fails + 1)); }
rm -f "$here/testdata/.drift.json"
expect out 'status=ok'
expect out 'spent-dash=0'
reject ann 'expires soon'

# validate.sh: every INPUT_* is set explicitly; one override per case.
validate() {
    env -i PATH="$PATH" GITHUB_ENV="$tmp/env" \
        INPUT_REPO=alice/project INPUT_GITHUB_REPO=alice/project INPUT_NETWORK=mainnet \
        INPUT_DEVNET_NAME='' INPUT_SYNC=code,releases INPUT_STORAGE_KIND=platform \
        INPUT_REPLICAS=1 INPUT_COST_CAP=0.05 INPUT_DRY_RUN=false INPUT_INSTALL=true \
        INPUT_STATE_CACHE=true INPUT_VERSION=0.1.0 INPUT_S3_ENDPOINT='' INPUT_S3_BUCKET='' \
        INPUT_S3_REGION='' INPUT_S3_PUBLIC_URL='' INPUT_S3_PREFIX='' INPUT_PINNING_ENDPOINT='' \
        "$@" bash "$here/validate.sh" >"$tmp/val" 2>&1
}
good() {
    case="validate ok $*"
    validate "$@" || { echo "FAIL [$case] rejected: $(cat "$tmp/val")"; fails=$((fails + 1)); }
}
bad() {
    case="validate bad $*"
    if validate "$@"; then
        echo "FAIL [$case] accepted"
        fails=$((fails + 1))
    fi
}
good
good INPUT_REPO=dash://alice/project
good INPUT_REPO=project INPUT_SYNC=code,issues,prs,releases,labels INPUT_COST_CAP=0.25
good INPUT_GITHUB_REPO=https://github.com/alice/project.js
good INPUT_NETWORK=devnet INPUT_DEVNET_NAME=moutai
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
bad INPUT_DEVNET_NAME='x@y'
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
mirror DASH_FORGE_KEY=' dfk1:devnet:Id1:3:cWIFsecret ' || echo "FAIL [$case] exited $?"
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
    S3_ACCESS_KEY_ID=AK S3_SECRET_ACCESS_KEY=SK INPUT_DRY_RUN=false || echo "FAIL [$case] exited $?"
expect log '::add-mask::cJSONsecret'
expect env "DASH_FORGE_KEY=$tmp/identity.json"
expect identity.json 'cJSONsecret'
[ "$(stat -c %a "$tmp/identity.json" 2>/dev/null || stat -f %Lp "$tmp/identity.json")" = 600 ] ||
    { echo "FAIL [$case] identity file is not 0600"; fails=$((fails + 1)); }
expect dg 'env:S3_SECRET_ACCESS_KEY'
reject dg 'SK'
expect env 'GIT_CONFIG_KEY_0=dash.storage'
expect env 'GIT_CONFIG_VALUE_0=mirror'
expect env 'GIT_CONFIG_KEY_2=dash.platformFallback'
expect env 'GIT_CONFIG_COUNT=3'
reject args '--dry-run'

case="mirror exit codes"
mirror DASH_FORGE_KEY=dfk1:a:b:1:w STUB_RC=4 || { echo "FAIL [$case] partial (4) failed the step"; fails=$((fails + 1)); }
expect log 'the next run retries them'
if mirror DASH_FORGE_KEY=dfk1:a:b:1:w STUB_RC=4 INPUT_FAIL_ON_PARTIAL=true; then
    echo "FAIL [$case] partial with fail-on-partial passed"; fails=$((fails + 1))
fi
for rc in 1 3; do
    if mirror DASH_FORGE_KEY=dfk1:a:b:1:w STUB_RC=$rc; then echo "FAIL [$case] exit $rc passed"; fails=$((fails + 1)); fi
done

case="mirror empty key"
if mirror DASH_FORGE_KEY=''; then echo "FAIL [$case] accepted"; fails=$((fails + 1)); fi
expect log 'DASH_FORGE_KEY is empty'
case="mirror s3 without secrets"
if mirror DASH_FORGE_KEY=dfk1:a:b:1:w INPUT_STORAGE_KIND=s3; then echo "FAIL [$case] accepted"; fails=$((fails + 1)); fi
expect log 'S3_SECRET_ACCESS_KEY'

if [ "$fails" -ne 0 ]; then
    echo "$fails check(s) failed"
    exit 1
fi
echo "action/test.sh: all checks passed"
