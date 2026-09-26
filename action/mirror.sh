#!/usr/bin/env bash
# The Mirror Action's main step: materialize the signing key, configure storage, run
# forge-import. Inputs arrive as INPUT_* environment variables already checked by
# validate.sh; paths as FORGE_* variables set by action.yml. Never `set -x` here.
set -euo pipefail

die() {
    printf '::error title=Forge mirror::%s\n' "$1"
    exit 1
}

[ -z "${FORGE_BIN_DIR:-}" ] || PATH="$FORGE_BIN_DIR:$PATH"
for bin in forge-import git-remote-dash; do
    command -v "$bin" >/dev/null || die "$bin is not on PATH. Leave 'install' at true, or build it and add it to PATH before this step."
done

# Start from a clean slate so a failure below cannot leave last run's summary behind.
rm -f "$FORGE_SUMMARY"
mkdir -p "$(dirname "$FORGE_STATE")"

# --- The signing key -------------------------------------------------------------
# DASH_FORGE_KEY is either an inline `dfk1:<network>:<identityId>:<keyId>:<wif>` value
# (passed through) or a bridge identity JSON document (written 0600 to a file, and
# DASH_FORGE_KEY then names that file).
key=${DASH_FORGE_KEY:-}
key=${key#"${key%%[![:space:]]*}"}
key=${key%"${key##*[![:space:]]}"}
[ -n "$key" ] || die "DASH_FORGE_KEY is empty. Add the runner key as a repository secret named DASH_FORGE_KEY and pass it with 'env: DASH_FORGE_KEY: \${{ secrets.DASH_FORGE_KEY }}'."
case "$key" in
    dfk1:*)
        IFS=: read -r _ _ _ _ wif <<<"$key"
        [ -n "${wif:-}" ] || die "DASH_FORGE_KEY looks like a dfk1: key but is incomplete (expected dfk1:<network>:<identityId>:<keyId>:<wif>)."
        echo "::add-mask::$wif"
        export DASH_FORGE_KEY="$key"
        ;;
    '{'*)
        jq -e 'type == "object"' >/dev/null 2>&1 <<<"$key" ||
            die "DASH_FORGE_KEY starts with '{' but is not valid JSON. Paste the whole identity file into the secret."
        # Mask every secret-looking string in the file, wherever it is nested.
        while IFS= read -r s; do
            [ -z "$s" ] || echo "::add-mask::$s"
        done < <(jq -r '.. | objects | to_entries[]
            | select(.key | test("wif|privatekey|mnemonic|seed|secret"; "i"))
            | .value | strings' <<<"$key")
        (umask 077 && printf '%s' "$key" >"$FORGE_KEY_FILE")
        export DASH_FORGE_KEY="$FORGE_KEY_FILE"
        ;;
    *) die "DASH_FORGE_KEY must be a dfk1:... runner key or an identity JSON file's contents." ;;
esac
unset key wif

# --- Git configuration for this step only -------------------------------------------
# GIT_CONFIG_COUNT/KEY_n/VALUE_n is git's "command" scope: it reaches git-remote-dash
# through every git forge-import runs, outranks any config on the runner, and does not
# leak into the caller's later steps (unlike `git config --global`).
n=${GIT_CONFIG_COUNT:-0}
gitcfg() {
    export "GIT_CONFIG_KEY_$n=$1" "GIT_CONFIG_VALUE_$n=$2"
    n=$((n + 1))
}
# No cost settings here: forge-import enforces --max-spend on every write itself, and
# runs its pushes with `-c dash.confirm=never` after pricing them.

export DASH_FORGE_STORAGE_CONFIG="$FORGE_STORAGE_CONFIG"
rm -f "$DASH_FORGE_STORAGE_CONFIG"
case "$INPUT_STORAGE_KIND" in
    s3)
        [ -n "${S3_ACCESS_KEY_ID:-}" ] && [ -n "${S3_SECRET_ACCESS_KEY:-}" ] ||
            die "storage-kind s3 needs the S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY secrets in 'env:'."
        args=(--kind s3 --endpoint "$INPUT_S3_ENDPOINT" --bucket "$INPUT_S3_BUCKET"
            --access-key-id env:S3_ACCESS_KEY_ID --secret-access-key env:S3_SECRET_ACCESS_KEY)
        [ -z "$INPUT_S3_REGION" ] || args+=(--region "$INPUT_S3_REGION")
        [ -z "$INPUT_S3_PUBLIC_URL" ] || args+=(--public-url "$INPUT_S3_PUBLIC_URL")
        [ -z "$INPUT_S3_PREFIX" ] || args+=(--prefix "$INPUT_S3_PREFIX")
        ;;
    ipfs-pinning)
        [ -n "${PINNING_TOKEN:-}" ] || die "storage-kind ipfs-pinning needs the PINNING_TOKEN secret in 'env:'."
        args=(--kind ipfs-pinning-service --api "${INPUT_IPFS_API:-http://127.0.0.1:5001}"
            --pinning-endpoint "$INPUT_PINNING_ENDPOINT" --pinning-token env:PINNING_TOKEN)
        ;;
    *) args=() ;;
esac
if [ "${#args[@]}" -ne 0 ]; then
    command -v dg >/dev/null || die "dg is not on PATH (needed to add the storage profile)."
    # Secrets are stored as env: references; the values never touch the disk.
    dg storage add mirror "${args[@]}" >/dev/null
    gitcfg dash.storage mirror
    gitcfg dash.replicas "$INPUT_REPLICAS"
    gitcfg dash.platformFallback false
fi
export GIT_CONFIG_COUNT=$n

# --- GitHub auth and network -------------------------------------------------------
export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-${FORGE_FALLBACK_TOKEN:-}}}"
unset FORGE_FALLBACK_TOKEN
net=(--network "$INPUT_NETWORK")
export DASH_FORGE_NETWORK="$INPUT_NETWORK"
if [ "$INPUT_NETWORK" = devnet ]; then
    net+=(--devnet-name "$INPUT_DEVNET_NAME")
    export DASH_FORGE_DEVNET_NAME="$INPUT_DEVNET_NAME"
fi

cmd=(forge-import "$INPUT_GITHUB_REPO" --repo "$INPUT_REPO" --sync "$INPUT_SYNC"
    --state "$FORGE_STATE" --work-dir "$FORGE_WORK_DIR" --max-spend "$INPUT_COST_CAP"
    --yes --summary-json "$FORGE_SUMMARY" "${net[@]}")
[ "$INPUT_DRY_RUN" = false ] || cmd+=(--dry-run)
exec "${cmd[@]}"
