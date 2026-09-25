#!/usr/bin/env bash
# Validate the Mirror Action's inputs (passed as INPUT_* environment variables, never
# interpolated into a script). Exits non-zero with ::error:: lines naming each bad input.
# Every accepted value is safe to pass as a single quoted argument, and none can start
# an option (no leading '-').
set -euo pipefail

errors=0
fail() {
    printf '::error title=Invalid input %s::%s\n' "$1" "$2"
    errors=$((errors + 1))
}
# match <input-name> <value> <ERE> <message>
match() {
    [[ $2 =~ $3 ]] || fail "$1" "$4"
}
bool() {
    case "$2" in true | false) ;; *) fail "$1" "must be 'true' or 'false'" ;; esac
}
# An https:// origin with an optional plain path. http:// only for loopback when $3 = loopback.
url() {
    local re='^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
    if [ "${3:-}" = loopback ]; then
        re='^(https://[A-Za-z0-9.-]+|http://(127\.0\.0\.1|localhost))(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
    fi
    match "$1" "$2" "$re" "must be an https:// URL (letters, digits and . _ ~ / - only), got an invalid value"
}

name='[A-Za-z0-9][A-Za-z0-9._-]{0,99}'
match repo "${INPUT_REPO:-}" "^(dash://)?(${name}/)?${name}\$" \
    "must be dash://<owner>/<name>, <owner>/<name>, or a bare repository name"
match github-repo "${INPUT_GITHUB_REPO:-}" \
    '^((https://)?github\.com/)?[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$' \
    "must be owner/repo, github.com/owner/repo or https://github.com/owner/repo"

case "${INPUT_NETWORK:-}" in
    mainnet | testnet) ;;
    devnet)
        match devnet-name "${INPUT_DEVNET_NAME:-}" '^[a-z0-9][a-z0-9-]{0,62}$' \
            "is required for network 'devnet' (lowercase letters, digits, '-')"
        ;;
    *) fail network "must be mainnet, testnet or devnet" ;;
esac

if [ -z "${INPUT_SYNC:-}" ]; then
    fail sync "must list at least one of code,issues,prs,releases,labels"
else
    IFS=, read -ra items <<<"$INPUT_SYNC"
    for item in "${items[@]}"; do
        case "$item" in
            code | issues | prs | releases | labels) ;;
            *) fail sync "unknown item '${item//[^A-Za-z0-9_-]/?}' (allowed: code,issues,prs,releases,labels; no spaces)" ;;
        esac
    done
fi

match cost-cap "${INPUT_COST_CAP:-}" '^[0-9]{1,6}(\.[0-9]{1,8})?$' "must be a DASH amount like 0.05"
if [[ ${INPUT_COST_CAP:-} =~ ^[0-9.]+$ ]] && ! awk -v c="$INPUT_COST_CAP" 'BEGIN { exit !(c > 0) }'; then
    fail cost-cap "must be greater than 0"
fi
match replicas "${INPUT_REPLICAS:-}" '^[1-9]$' "must be a whole number from 1 to 9"
bool dry-run "${INPUT_DRY_RUN:-}"
bool install "${INPUT_INSTALL:-}"
bool state-cache "${INPUT_STATE_CACHE:-}"
if [ "${INPUT_INSTALL:-}" = true ]; then
    match version "${INPUT_VERSION:-}" '^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' \
        "must be a release version like 0.1.0"
fi

case "${INPUT_STORAGE_KIND:-}" in
    platform) ;;
    s3)
        url s3-endpoint "${INPUT_S3_ENDPOINT:-}"
        match s3-bucket "${INPUT_S3_BUCKET:-}" '^[a-z0-9][a-z0-9.-]{1,62}$' "is required for storage-kind s3 (a bucket name)"
        [ -z "${INPUT_S3_REGION:-}" ] || match s3-region "$INPUT_S3_REGION" '^[A-Za-z0-9][A-Za-z0-9-]{0,31}$' "must be a region name like auto or us-east-1"
        [ -z "${INPUT_S3_PUBLIC_URL:-}" ] || url s3-public-url "$INPUT_S3_PUBLIC_URL"
        [ -z "${INPUT_S3_PREFIX:-}" ] || match s3-prefix "$INPUT_S3_PREFIX" '^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$' "may contain letters, digits and . _ / - only"
        ;;
    ipfs-pinning)
        url pinning-endpoint "${INPUT_PINNING_ENDPOINT:-}"
        url ipfs-api "${INPUT_IPFS_API:-http://127.0.0.1:5001}" loopback
        ;;
    *) fail storage-kind "must be platform, s3 or ipfs-pinning" ;;
esac

if [ "$errors" -ne 0 ]; then
    echo "The Forge mirror action stopped before doing anything: $errors invalid input(s)." >&2
    exit 1
fi
