#!/usr/bin/env bash
# One-way mirror of this repository's master branch and tags to its Dash Forge copy.
# GitHub is the source of truth. Run from a full clone of GitHub (all of master's history and
# every tag), with dg and git-remote-dash on PATH. .github/workflows/forge-sync.yml runs it on
# every push to master and every tag.
#
#   1. Compare: list the Forge refs. A Forge ref GitHub does not have, a Forge master that is not
#      an ancestor of GitHub's master, or a Forge tag that names another object is a divergence.
#      Then nothing is pushed, the run fails, and `diverged=true` goes to $GITHUB_OUTPUT. GitHub
#      never overwrites Forge: pushes are never forced.
#   2. Push master (fast-forward only) and the tags Forge lacks, packs to $FORGE_STORAGE.
#   3. Replicate: every CID the push pinned on the job's own kubo node ($KUBO_API) is exported
#      as a CAR, then each is piped to $PIN_CMD (a forced-command ssh to our IPFS host), which
#      must answer `confirmed<TAB><cid>`. This runs even when the push failed, because the helper
#      writes refs one by one and some may have landed. Any CAR not confirmed fails the run and
#      stays in $CAR_DIR; on success $CAR_DIR is removed.
#   4. Verify: list the Forge refs again; they must equal GitHub's.
#
# Environment:
#   FORGE_REMOTE   dash://<owner>/<repo>                 (required)
#   FORGE_NETWORK  mainnet | testnet                     (required)
#   DASH_FORGE_KEY the dfk1: signing key                  (required to push)
#   FORGE_STORAGE  storage profile name for packs         (default: ci-kubo)
#   FORGE_COST_CAP DASH a single push may cost            (default: 0.05)
#   KUBO_API       the job's kubo RPC API, for step 3     (default: http://127.0.0.1:5001)
#   PIN_CMD        command reading one CAR on stdin       (empty: step 3 is skipped)
#   CAR_DIR        where step 3 keeps the CARs it exports (default: a temporary directory), so
#                  a failed replication can still be uploaded and imported by hand
#   DRY_RUN=1      compare only
set -euo pipefail

: "${FORGE_REMOTE:?FORGE_REMOTE is required}" "${FORGE_NETWORK:?FORGE_NETWORK is required}"
FORGE_STORAGE=${FORGE_STORAGE:-ci-kubo}
FORGE_COST_CAP=${FORGE_COST_CAP:-0.05}
KUBO_API=${KUBO_API:-http://127.0.0.1:5001}
PIN_CMD=${PIN_CMD:-}
SUMMARY=${GITHUB_STEP_SUMMARY:-/dev/null}
OUTPUT=${GITHUB_OUTPUT:-/dev/null}

say() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }
fail() {
    printf '::error title=Forge sync::%s\n' "$1"
    printf '\n**Failed:** %s\n' "$1" >>"$SUMMARY"
    exit 1
}

# GitHub masks the whole secret, not the WIF inside a dfk1: value, should anything print it.
if [ -n "${GITHUB_ACTIONS:-}" ] && [ -n "${DASH_FORGE_KEY:-}" ]; then
    printf '::add-mask::%s\n' "${DASH_FORGE_KEY##*:}"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git remote get-url forge >/dev/null 2>&1 || git remote add forge "$FORGE_REMOTE"
git config remote.forge.url "$FORGE_REMOTE"
git config remote.forge.dashNetwork "$FORGE_NETWORK"
git config dash.network "$FORGE_NETWORK"

gh_master=$(git rev-parse --verify 'refs/remotes/origin/master^{commit}' 2>/dev/null ||
    git rev-parse --verify 'refs/heads/master^{commit}')
git for-each-ref --format='%(objectname) %(refname)' refs/tags >"$work/github-tags"
gh_tag_count=$(wc -l <"$work/github-tags" | tr -d ' ')

# Forge's refs as `sha ref` lines into $1, without HEAD and peeled `^{}` entries.
forge_refs() {
    git ls-remote forge </dev/null >"$work/ls-remote" || fail "could not list the refs of $FORGE_REMOTE"
    awk '$2 != "HEAD" && $2 !~ /\^\{\}$/' "$work/ls-remote" >"$1"
}
# The object `ref` ($2) names in the `sha ref` file $1, or nothing.
lookup() { awk -v r="$2" '$2 == r { print $1; exit }' "$1"; }

say "### Forge sync: $FORGE_REMOTE ($FORGE_NETWORK)"
say ""
say "GitHub master: \`$gh_master\`, $gh_tag_count tags"

forge_refs "$work/forge"
forge_master=$(lookup "$work/forge" refs/heads/master)
problems=()
while read -r sha ref; do
    case "$ref" in
    refs/heads/master)
        if [ "$sha" != "$gh_master" ] &&
            ! { git cat-file -e "$sha^{commit}" 2>/dev/null && git merge-base --is-ancestor "$sha" "$gh_master"; }; then
            problems+=("master on Forge is \`$sha\`, which is not in GitHub's master history (Forge-only commits or a rewrite on GitHub)")
        fi
        ;;
    refs/tags/*)
        theirs=$(lookup "$work/github-tags" "$ref")
        if [ -z "$theirs" ]; then
            problems+=("tag \`${ref#refs/tags/}\` exists only on Forge (\`$sha\`)")
        elif [ "$theirs" != "$sha" ]; then
            problems+=("tag \`${ref#refs/tags/}\` is \`$sha\` on Forge but \`$theirs\` on GitHub")
        fi
        ;;
    *) problems+=("\`$ref\` exists only on Forge (\`$sha\`)") ;;
    esac
done <"$work/forge"

say "Forge master: \`${forge_master:-none}\`, $(awk '$2 ~ /^refs\/tags\//' "$work/forge" | wc -l | tr -d ' ') tags"

if [ ${#problems[@]} -gt 0 ]; then
    echo "diverged=true" >>"$OUTPUT"
    say ""
    say "**Forge has changes GitHub does not.** Nothing was pushed; GitHub never overwrites Forge."
    for p in "${problems[@]}"; do say "- $p"; done
    fail "Forge diverged from GitHub (${#problems[@]} ref(s)); see the job summary"
fi
echo "diverged=false" >>"$OUTPUT"

refspecs=()
[ "$forge_master" = "$gh_master" ] || refspecs+=("$gh_master:refs/heads/master")
while read -r _ ref; do
    [ -n "$(lookup "$work/forge" "$ref")" ] || refspecs+=("$ref:$ref")
done <"$work/github-tags"

if [ ${#refspecs[@]} -eq 0 ]; then
    say ""
    say "Forge already matches GitHub; nothing to push."
    echo "pushed=false" >>"$OUTPUT"
    exit 0
fi

say ""
say "To push: ${refspecs[*]}"
if [ "${DRY_RUN:-}" = 1 ]; then
    echo "pushed=false" >>"$OUTPUT"
    exit 0
fi
: "${DASH_FORGE_KEY:?DASH_FORGE_KEY is required to push}"

kubo_pins() {
    curl -fsS -m 60 -X POST "$KUBO_API/api/v0/pin/ls?type=recursive&quiet=true" | jq -r '.Keys // {} | keys[]' | sort
}
[ -z "$PIN_CMD" ] || kubo_pins >"$work/pins-before" || fail "could not list the job's kubo pins"

# Never forced (no leading +): git and the helper refuse anything but a fast-forward of master
# and a tag that is new, should Forge have moved since the comparison above.
push_rc=0
git -c dash.storage="$FORGE_STORAGE" -c dash.confirm=refuse -c dash.costWarnThreshold="$FORGE_COST_CAP" \
    push forge "${refspecs[@]}" </dev/null || push_rc=$?
echo "pushed=true" >>"$OUTPUT"

if [ -n "$PIN_CMD" ]; then
    kubo_pins >"$work/pins-after" || fail "could not list the job's kubo pins after the push"
    car_dir=${CAR_DIR:-$work/cars}
    mkdir -p "$car_dir"
    comm -13 "$work/pins-before" "$work/pins-after" >"$work/new-pins"
    while read -r cid; do
        curl -fsS -m 600 -X POST "$KUBO_API/api/v0/dag/export?arg=$cid" -o "$car_dir/$cid.car" ||
            fail "could not export $cid from the job's kubo (the CARs exported so far are in $car_dir)"
    done <"$work/new-pins"
    unconfirmed=()
    while read -r cid; do
        if answer=$(env -u DASH_FORGE_KEY bash -c "$PIN_CMD" <"$car_dir/$cid.car" 2>&1) &&
            printf '%s\n' "$answer" | grep -qxF "$(printf 'confirmed\t%s' "$cid")"; then
            say "- replicated \`$cid\`"
            rm -f "$car_dir/$cid.car"
        else
            printf '::warning title=Forge sync::the IPFS host did not confirm %s: %s\n' "$cid" "$answer"
            unconfirmed+=("$cid")
        fi
    done <"$work/new-pins"
    say "Replicated $(($(wc -l <"$work/new-pins") - ${#unconfirmed[@]})) of $(wc -l <"$work/new-pins" | tr -d ' ') new CID(s) to the IPFS host."
    [ ${#unconfirmed[@]} -eq 0 ] ||
        fail "${#unconfirmed[@]} CID(s) reached no durable node: ${unconfirmed[*]}. Their CARs are in $car_dir; import them on the IPFS host with ipfs dag import --pin-roots"
    rmdir "$car_dir" 2>/dev/null || true
fi
[ "$push_rc" = 0 ] || fail "git push to Forge failed (exit $push_rc; the log above has the helper's error)"

forge_refs "$work/after"
after_master=$(lookup "$work/after" refs/heads/master)
[ "$after_master" = "$gh_master" ] ||
    fail "after the push Forge master is ${after_master:-missing}, not $gh_master"
while read -r sha ref; do
    got=$(lookup "$work/after" "$ref")
    [ "$got" = "$sha" ] || fail "after the push Forge ${ref#refs/} is ${got:-missing}, not $sha"
done <"$work/github-tags"
say ""
say "Forge now matches GitHub: master \`$gh_master\`, $gh_tag_count tags."
