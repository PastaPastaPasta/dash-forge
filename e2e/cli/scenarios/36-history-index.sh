#!/usr/bin/env bash
# Scenario 36: a push of the default branch publishes its history index (packManifest kind 3:
# every path's last first-parent change and the exact commit count, docs/design/history-index.md),
# a later push publishes a delta over it, and `dg repo reindex` backfills a repository pushed
# without one.
#
#   1. Into a new repo, push `main` (3 commits): one history index manifest, a full one
#      (`tips` = [tip]), and the push says so (`historyIndex` event: 3 commits).
#   2. Push one more commit: a delta over the full index (`tips` = [tip, baseTip]), priced in the
#      push's estimate (its platform line counts 3 manifests).
#   3. Into a second new repo, push with DASH_FORGE_NO_BROWSE_INDEX=1 (no browse artifacts):
#      no history index. `dg repo reindex --git-dir <clone>` publishes a full one (and the
#      locator), measured spend positive and small; a second reindex finds nothing to do.
#
# Needs an identity with ~1 DASH (E2E_S36_IDENTITY, or minted from the moutai funding key under
# `lockf /tmp/qa-mint.lock`). Two small new repos per run. Not in the default set (`run.sh 36`).
SCENARIO_NAME="36 a push publishes the history index; a later push a delta; reindex backfills"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

: "${MOUTAI_FUNDING:=/Users/pasta/workspace/dash-forge-qa/secrets/moutai-funding.wif}"
: "${MINT_DIR:=${E2E_REPO_ROOT}/tools/mint-identity}"
LOG="${WORKROOT}/s36"
IDS="${WORKROOT}/s36-ids"; mkdir -p -m 700 "$IDS"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }

step "this run's identity"
if [[ -n "${E2E_S36_IDENTITY:-}" ]]; then
  cp "$E2E_S36_IDENTITY" "$IDS/S36.identity.json"
else
  [[ -r "$MOUTAI_FUNDING" ]] || skip_scenario "no moutai funding key ($MOUTAI_FUNDING); or set E2E_S36_IDENTITY"
  [[ -d "$MINT_DIR/node_modules/@dashevo/evo-sdk" ]] || skip_scenario "tools/mint-identity has no node_modules (npm ci there)"
  lock=(); lf="${E2E_MINT_LOCK:-/tmp/qa-mint.lock}"
  if command -v lockf >/dev/null; then lock=(lockf -t 1200 "$lf"); elif command -v flock >/dev/null; then lock=(flock -w 1200 "$lf"); fi
  "${lock[@]}" node "$MINT_DIR/mint.mjs" --network devnet --devnet-name "${DASH_FORGE_DEVNET_NAME:-moutai}" \
    --funding fund-from-key --funding-key-file "$MOUTAI_FUNDING" --out "$IDS" --label S36 --amount 1 \
    >"$LOG-mint.log" 2>&1 || { tail -5 "$LOG-mint.log" >&2; skip_scenario "minting failed (funding or network)"; }
fi
ID="$IDS/S36.identity.json"
OWNER_ID="$(_idid "$ID")"
[[ -n "$OWNER_ID" ]] || { bad "no identity file"; finish_scenario; }
ok "identity ${OWNER_ID:0:10}…"

# How many history index manifests (kind 3) the repo has.
history_tips() { # history_tips <repo> <tag>
  dg_read_retry "$ID" "$LOG-$2.json" "$LOG-$2.err" --json storage status "$1" || return 1
  python3 -c '
import json, sys
p = json.load(open(sys.argv[1]))["packs"]
print(sum(1 for x in p if x["kind"] == 3))' "$LOG-$2.json"
}
commit_in() { # commit_in <dir> <file> <text> <msg>
  printf '%s\n' "$3" >"$1/$2"
  git -C "$1" add -A && git -C "$1" commit -q -m "$4"
}
# The push's `<event>` JSON event from its stderr, as "<field>=<value> …" for `fields`.
event_of() { # event_of <stderr log> <event> <field...>
  python3 -c '
import json, sys
log, name, fields = sys.argv[1], sys.argv[2], sys.argv[3:]
for line in open(log):
    try:
        v = json.loads(line)
    except ValueError:
        continue
    if isinstance(v, dict) and v.get("event") == name:
        print(" ".join(f"{f}={json.dumps(v.get(f))}" for f in fields))
        break' "$@"
}
new_repo() { # new_repo <name> <tag>
  dg_read_retry "$ID" "$LOG-$2.json" "$LOG-$2.err" --yes --json repo create "$1" --storage platform
}

step "1. the first push of main publishes a full history index"
NAME="$(printf 'e2e-hist-%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
new_repo "$NAME" 1c || { cat "$LOG-1c.err" >&2; bad "repo create failed"; finish_scenario; }
SRC="$WORKROOT/s36-src"
seed_tiny_repo "$SRC" main >/dev/null
commit_in "$SRC" alpha.txt "second" "second"
commit_in "$SRC" sub/beta.txt "third" "third"
if ! GIT_DASH_JSON=1 git_dash "$ID" "$LOG-1" -C "$SRC" push "dash://$OWNER_ID/$NAME" main:main; then
  cat "$LOG-1.err" >&2; is_flake "$LOG-1.err" && skip_scenario "push flaked"
  bad "the push failed"; finish_scenario
fi
check "the push published a full history index of 3 commits" assert_eq "commits=3 delta=false" \
  "$(event_of "$LOG-1.err" historyIndex commits delta)"
check "…and priced it: the platform line counts 3 manifests" assert_eq "manifests=3" \
  "$(event_of "$LOG-1.err" platform manifests)"
check "one history index manifest" assert_eq "1" "$(history_tips "$OWNER_ID/$NAME" 1s)"

step "2. the next push publishes a delta"
commit_in "$SRC" README.md "fourth" "fourth"
if ! GIT_DASH_JSON=1 git_dash "$ID" "$LOG-2" -C "$SRC" push "dash://$OWNER_ID/$NAME" main:main; then
  cat "$LOG-2.err" >&2; is_flake "$LOG-2.err" && skip_scenario "push flaked"
  bad "the second push failed"; finish_scenario
fi
check "a delta of 4 commits" assert_eq "commits=4 delta=true" "$(event_of "$LOG-2.err" historyIndex commits delta)"
check "two history index manifests" assert_eq "2" "$(history_tips "$OWNER_ID/$NAME" 2s)"
reindex_json() { dg_as "$ID" --yes --json repo reindex "$1" --git-dir "$2" >"$3.json" 2>"$3.err"; }
reindex_json "$OWNER_ID/$NAME" "$SRC" "$LOG-2r" || { cat "$LOG-2r.err" >&2; bad "reindex failed"; }
check "reindex: the history index already covers the tip" assert_eq "covered" \
  "$(jq_py "$LOG-2r.json" 'd["history"]["status"]')"

step "2b. a fast-forward to commits already stored publishes the index too (review N5)"
# A side branch pushed first stores the commits; main then moves to them with no new objects.
git -C "$SRC" checkout -q -b ff-side
commit_in "$SRC" alpha.txt "fifth" "fifth"
if ! GIT_DASH_JSON=1 git_dash "$ID" "$LOG-2f" -C "$SRC" push "dash://$OWNER_ID/$NAME" ff-side:ff-side; then
  cat "$LOG-2f.err" >&2; is_flake "$LOG-2f.err" && skip_scenario "push flaked"
  bad "the side-branch push failed"; finish_scenario
fi
check "a side branch publishes no history index" assert_eq "" "$(event_of "$LOG-2f.err" historyIndex commits)"
git -C "$SRC" checkout -q main && git -C "$SRC" merge -q --ff-only ff-side
if ! GIT_DASH_JSON=1 git_dash "$ID" "$LOG-2g" -C "$SRC" push "dash://$OWNER_ID/$NAME" main:main; then
  cat "$LOG-2g.err" >&2; is_flake "$LOG-2g.err" && skip_scenario "push flaked"
  bad "the fast-forward push failed"; finish_scenario
fi
check "the fast-forward stored no pack" assert_eq "" "$(event_of "$LOG-2g.err" stored packHash)"
check "…and published the history index (5 commits)" assert_eq "commits=5" "$(event_of "$LOG-2g.err" historyIndex commits)"

step "3. dg repo reindex backfills a repository pushed without one"
BARE="$(printf 'e2e-hist-bare-%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
new_repo "$BARE" 3c || { cat "$LOG-3c.err" >&2; bad "repo create failed"; finish_scenario; }
if ! DASH_FORGE_NO_BROWSE_INDEX=1 GIT_DASH_JSON=1 git_dash "$ID" "$LOG-3" -C "$SRC" push "dash://$OWNER_ID/$BARE" main:main; then
  cat "$LOG-3.err" >&2; is_flake "$LOG-3.err" && skip_scenario "push flaked"
  bad "the unindexed push failed"; finish_scenario
fi
check "no history index yet" assert_eq "0" "$(history_tips "$OWNER_ID/$BARE" 3s)"
reindex_json "$OWNER_ID/$BARE" "$SRC" "$LOG-3r" || { cat "$LOG-3r.err" "$LOG-3r.json" >&2; bad "reindex failed"; finish_scenario; }
check "reindex published the history index" assert_eq "published" "$(jq_py "$LOG-3r.json" 'd["history"]["status"]')"
check "…a full one of 5 commits" assert_eq "5 False" \
  "$(jq_py "$LOG-3r.json" 'str(d["history"]["commits"]) + " " + str(d["history"]["delta"])')"
spent="$(jq_py "$LOG-3r.json" '"" if d["cost"] is None else d["cost"]["credits"]')"
check "the spend was measured" test -n "$spent"
check "the spend is small (${spent} credits: a locator, a history index, their manifests)" test "${spent:-0}" -lt 2000000000
check "one history index manifest" assert_eq "1" "$(history_tips "$OWNER_ID/$BARE" 3t)"
reindex_json "$OWNER_ID/$BARE" "$SRC" "$LOG-3b" || { cat "$LOG-3b.err" >&2; bad "second reindex failed"; }
check "a second reindex finds nothing to do" assert_eq "indexed covered" \
  "$(jq_py "$LOG-3b.json" 'd["status"] + " " + d["history"]["status"]')"

finish_scenario
