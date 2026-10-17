#!/usr/bin/env bash
# Scenario 36: a push of the default branch publishes its history index (packManifest kind 3:
# every path's last first-parent change and the exact commit count, docs/design/history-index.md),
# a later push chooses a cost-effective full index or delta, and `dg repo reindex` backfills a repository pushed
# without one.
#
#   1. Into a new repo, push `main` (3 commits): one history index manifest, a full one
#      (`tips` = [tip]), and the push says so (`historyIndex` event: 3 commits).
#   2. Push one more commit: this tiny base is cheaper as another full index. Paired
#      column/version artifacts put four manifests in the first push estimate.
#   3. Into a second new repo, push with DASH_FORGE_NO_BROWSE_INDEX=1 (no browse artifacts):
#      no history index. `dg repo reindex --git-dir <clone>` publishes a full one (and the
#      locator), measured spend positive and small; a second reindex finds nothing to do.
#   4. Add 128 distinct paths to the first repo so a one-file change is cheaper as a delta;
#      the following push must report delta=true (the tiny-base control above stays full).
#
# Needs an identity with ~1 DASH (E2E_S36_IDENTITY, or minted from the devnet's funding key
# E2E_MINT_FUNDING under `lockf $E2E_MINT_LOCK`, config.sh). Two small new repos per run.
# Not in the default set (`run.sh 36`).
SCENARIO_NAME="36 a push publishes the history index; a later push a cost-aware index; reindex backfills"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

: "${MINT_DIR:=${E2E_REPO_ROOT}/tools/mint-identity}"
LOG="${WORKROOT}/s36"
IDS="${WORKROOT}/s36-ids"; mkdir -p -m 700 "$IDS"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }

step "this run's identity"
if [[ -n "${E2E_S36_IDENTITY:-}" ]]; then
  require_not_july "$E2E_S36_IDENTITY"
  cp "$E2E_S36_IDENTITY" "$IDS/S36.identity.json"
else
  require_mint_funding "or set E2E_S36_IDENTITY"
  [[ -d "$MINT_DIR/node_modules/@dashevo/evo-sdk" ]] || skip_scenario "tools/mint-identity has no node_modules (npm ci there)"
  lock=(); lf="$E2E_MINT_LOCK"
  if command -v lockf >/dev/null; then lock=(lockf -t 1200 "$lf"); elif command -v flock >/dev/null; then lock=(flock -w 1200 "$lf"); fi
  "${lock[@]}" node "$MINT_DIR/mint.mjs" "${E2E_MINT_NET_ARGS[@]}" \
    --funding fund-from-key --funding-key-file "$E2E_MINT_FUNDING" --out "$IDS" --label S36 --amount 1 \
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
print(sum(1 for x in p if x["kindCode"] == 3))' "$LOG-$2.json"
}
commit_in() { # commit_in <dir> <file> <text> <msg>
  printf '%s\n' "$3" >"$1/$2"
  git -C "$1" add -- "$2" && git -C "$1" commit -q -m "$4"
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
  dg_read_retry "$ID" "$LOG-$2.json" "$LOG-$2.err" --yes --json repo create "$1" --storage platform --no-protect
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
check "…and priced it: the platform line counts 4 manifests" assert_eq "manifests=4" \
  "$(event_of "$LOG-1.err" platform manifests)"
check "one history index manifest" assert_eq "1" "$(history_tips "$OWNER_ID/$NAME" 1s)"

step "2. the next push chooses a full index for this tiny base"
commit_in "$SRC" README.md "fourth" "fourth"
if ! GIT_DASH_JSON=1 git_dash "$ID" "$LOG-2" -C "$SRC" push "dash://$OWNER_ID/$NAME" main:main; then
  cat "$LOG-2.err" >&2; is_flake "$LOG-2.err" && skip_scenario "push flaked"
  bad "the second push failed"; finish_scenario
fi
check "a full index of 4 commits (cheaper than a delta here)" assert_eq "commits=4 delta=false" "$(event_of "$LOG-2.err" historyIndex commits delta)"
check "two history index manifests" assert_eq "2" "$(history_tips "$OWNER_ID/$NAME" 2s)"
reindex_json() { dg_as "$ID" --yes --json repo reindex "$1" --git-dir "$2" >"$3.json" 2>"$3.err"; }
reindex_json "$OWNER_ID/$NAME" "$SRC" "$LOG-2r" || { cat "$LOG-2r.err" >&2; bad "reindex failed"; }
check "reindex: the history index already covers the tip" assert_eq "covered" \
  "$(jq_py "$LOG-2r.json" 'd["history"]')"

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
  "$(jq_py "$LOG-3b.json" 'd["status"] + " " + d["history"]')"

step "4. a one-file change over a larger base pays as a delta"
# Distinct paths keep the compressed full index large enough for the delta to pay.
# Reuse the first repo, after the tiny-base/backfill checks, so this adds no repository.
python3 - "$SRC" <<'PY'
import hashlib, pathlib, sys
root = pathlib.Path(sys.argv[1]) / "history-base"
root.mkdir()
for i in range(128):
    name = hashlib.sha256(str(i).encode()).hexdigest() + ".txt"
    (root / name).write_text(f"history fixture {i}\n")
PY
git -C "$SRC" add -- history-base && git -C "$SRC" commit -q -m "larger history base"
if ! GIT_DASH_JSON=1 git_dash "$ID" "$LOG-4" -C "$SRC" push "dash://$OWNER_ID/$NAME" main:main; then
  cat "$LOG-4.err" >&2; is_flake "$LOG-4.err" && skip_scenario "push flaked"
  bad "the larger-base push failed"; finish_scenario
fi
check "the larger base publishes a full index of 6 commits" assert_eq "commits=6 delta=false" \
  "$(event_of "$LOG-4.err" historyIndex commits delta)"
# The next push prices its delta against the stored index: wait (reads only) for the full one.
seen=1; for _ in $(seq 1 10); do [[ "$(history_tips "$OWNER_ID/$NAME" 4s)" == 4 ]] && { seen=0; break; }; sleep 3; done
check "the full index of 6 commits reads back" test "$seen" -eq 0
commit_in "$SRC" README.md "one changed file" "one-file change over the larger base"
if ! GIT_DASH_JSON=1 git_dash "$ID" "$LOG-5" -C "$SRC" push "dash://$OWNER_ID/$NAME" main:main; then
  cat "$LOG-5.err" >&2; is_flake "$LOG-5.err" && skip_scenario "push flaked"
  bad "the delta push failed"; finish_scenario
fi
check "the one-file change publishes a delta of 7 commits" assert_eq "commits=7 delta=true" \
  "$(event_of "$LOG-5.err" historyIndex commits delta)"

finish_scenario
