#!/usr/bin/env bash
# Copies the packs a mirror.sh push stored on the job's kubo node to our IPFS host. Run it after
# mirror.sh whatever mirror.sh's outcome, cancelled included: when mirror.sh got as far as a push
# it left a `pushed` marker in $STATE_DIR, and the helper may have moved refs even if the push
# failed. Every CID pinned since `pins-before` is exported as a CAR, then each is piped to
# $PIN_CMD, which must answer `confirmed<TAB><cid>`. A confirmed CAR is deleted; any other stays
# in $CAR_DIR and fails the run.
#
# Environment: STATE_DIR, PIN_CMD, KUBO_API (default http://127.0.0.1:5001), CAR_DIR (default
# $STATE_DIR/cars), GITHUB_STEP_SUMMARY.
set -euo pipefail

KUBO_API=${KUBO_API:-http://127.0.0.1:5001}
SUMMARY=${GITHUB_STEP_SUMMARY:-/dev/null}

say() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }
fail() {
    printf '::error title=Forge sync::%s\n' "$1"
    printf '\n**Failed:** %s\n' "$1" >>"$SUMMARY"
    exit 1
}

[ -n "${PIN_CMD:-}" ] || exit 0
: "${STATE_DIR:?STATE_DIR is required}"
[ -e "$STATE_DIR/pushed" ] || { echo "No push was attempted; nothing to replicate."; exit 0; }
CAR_DIR=${CAR_DIR:-$STATE_DIR/cars}
mkdir -p "$CAR_DIR"

curl -fsS -m 60 -X POST "$KUBO_API/api/v0/pin/ls?type=recursive&quiet=true" |
    jq -r '.Keys // {} | keys[]' | sort >"$STATE_DIR/pins-after" ||
    fail "could not list the job's kubo pins after the push"
comm -13 "$STATE_DIR/pins-before" "$STATE_DIR/pins-after" >"$STATE_DIR/new-pins"
total=$(wc -l <"$STATE_DIR/new-pins" | tr -d ' ')

say ""
if [ "$total" = 0 ]; then
    printf '::warning title=Forge sync::the push pinned nothing new on the job kubo (%s); if it stored a pack, that pack is not on the IPFS host\n' \
        "$(tr '\n' ' ' <"$STATE_DIR/pushed")"
    say "The push pinned nothing new on the job's kubo node."
    exit 0
fi

failed=()
while read -r cid; do
    curl -fsS -m 600 -X POST "$KUBO_API/api/v0/dag/export?arg=$cid" -o "$CAR_DIR/$cid.car" || {
        printf '::warning title=Forge sync::could not export %s from the job kubo\n' "$cid"
        rm -f "$CAR_DIR/$cid.car"
        failed+=("$cid")
    }
done <"$STATE_DIR/new-pins"

while read -r cid; do
    [ -e "$CAR_DIR/$cid.car" ] || continue
    if answer=$(env -u DASH_FORGE_KEY bash -c "$PIN_CMD" <"$CAR_DIR/$cid.car" 2>&1) &&
        printf '%s\n' "$answer" | grep -qxF "$(printf 'confirmed\t%s' "$cid")"; then
        say "- replicated \`$cid\`"
        rm -f "$CAR_DIR/$cid.car"
    else
        printf '::warning title=Forge sync::the IPFS host did not confirm %s: %s\n' "$cid" "$answer"
        failed+=("$cid")
    fi
done <"$STATE_DIR/new-pins"

say "Replicated $((total - ${#failed[@]})) of $total new CID(s) to the IPFS host."
[ ${#failed[@]} -eq 0 ] ||
    fail "${#failed[@]} CID(s) reached no durable node: ${failed[*]}. The CARs that could be exported are in the run's artifact; import them on the IPFS host with ipfs dag import --pin-roots"
rmdir "$CAR_DIR" 2>/dev/null || true
