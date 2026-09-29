#!/usr/bin/env bash
# Scenario 34: a phased import records merged PRs as merged (the showcase's beta.6 defect).
#
#   0. `--sync issues,prs` FIRST, into a new repo `e2e-phase-<run>` with the --work-dir step 1
#      will use: nothing is on chain yet, so every merged PR is recorded closed and counted as
#      unproved, the --state file keeps their numbers, and the work dir is left untouched (the
#      proof repository is temporary and outside it).
#   1. `--sync code` into that same --work-dir (it must still be able to clone there).
#   2. `--sync issues,prs` again with the same --state: GitHub reports nothing new since step 0,
#      but the unproved PRs are revisited and each merged PR now reads MERGED in `dg pr list`.
#   3. `--sync issues,prs` as a separate run with a fresh, EMPTY work dir and no state (a CI job
#      on a new runner): nothing pushed, nothing written, 0 unproved (before the fix every merged
#      PR was recorded closed: "no mirrored tip of its base contains the merge commit").
#
# Reads GitHub (gh logged in, or GH_TOKEN). A new repo per run (~0.02 DASH; the code is ~3 KB).
# The identity is OWNER unless E2E_IMPORT_IDENTITY names another identity file. Not in the
# nightly: run by hand, `bash e2e/cli/run.sh 34`.
SCENARIO_NAME="34 phased import: merged PRs read merged without code in the run"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

IMPORT="${BIN_DIR}/forge-import"
[[ -x "$IMPORT" ]] || skip_scenario "forge-import is not built (cargo build -p forge-import)"
if ! command -v gh >/dev/null || { [[ -z "${GH_TOKEN:-}" ]] && ! gh auth token >/dev/null 2>&1; }; then
  skip_scenario "no GitHub access (log in with gh or set GH_TOKEN)"
fi

SRC=PastaPastaPasta/dash-fork-checker
ID="${E2E_IMPORT_IDENTITY:-$ID_OWNER}"
OWNER_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["identityId"])' "$ID")"
NAME="$(printf 'e2e-phase-%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
REPO="${OWNER_ID}/${NAME}"
LOG="${WORKROOT}/s34"
MIRROR="${WORKROOT}/s34-mirror"
STATE="${WORKROOT}/s34-state.json"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }

import_run() { # import_run <log> <sync> <work-dir> [extra args]
  local log=$1 sync=$2 work=$3; shift 3
  DASH_FORGE_KEY="$ID" RUST_LOG=error NO_COLOR=1 _tmo_for 900 "$IMPORT" "$SRC" --repo "$NAME" --sync "$sync" \
    --work-dir "$work" --max-spend 0.2 --yes --summary-json "$log.json" "$@" >"$log.out" 2>"$log.err"
}
imported() { # imported <log> <sync> <work-dir> — runs it, SKIPs on a flake, FAILs otherwise
  import_run "$@" && return 0
  cat "$1.err" >&2
  is_flake "$1.err" && skip_scenario "forge-import flaked"
  bad "forge-import $SRC --sync $2 failed"; finish_scenario
}
merged_gh="$(gh api "repos/${SRC}/pulls?state=closed&per_page=100" --jq '[.[]|select(.merged_at!=null)]|length')"
merged_listed() {
  dg_read_retry "$ID_CONTRIB" "$LOG-list.json" "$LOG-list.err" --json pr list "$REPO" --state all \
    && [[ "$(jq_py "$LOG-list.json" 'sum(1 for p in d["prs"] if p.get("state") == "merged")')" == "$merged_gh" ]]
}

step "0. issues and PRs before any code"
imported "$LOG-early" issues,prs "$MIRROR" --state "$STATE"
check "status ok" assert_eq "ok" "$(jq_py "$LOG-early.json" 'd["status"]')"
check "every merged PR counted unproved (${merged_gh})" assert_eq "$merged_gh" "$(jq_py "$LOG-early.json" 'd["counts"].get("unprovedMerges")')"
check "the state keeps them to revisit" assert_eq "$merged_gh" "$(jq_py "$STATE" 'len(d.get("revisit", []))')"
check "the work dir is untouched" test ! -e "$MIRROR"

step "1. the code, into the same work dir"
imported "$LOG-code" code "$MIRROR"
check "status ok" assert_eq "ok" "$(jq_py "$LOG-code.json" 'd["status"]')"
check "branches and tags pushed" test "$(jq_py "$LOG-code.json" 'd["counts"]["refs"]')" -gt 0

step "2. the next issues/PRs run revisits the unproved merges"
imported "$LOG-prs" issues,prs "$MIRROR" --state "$STATE"
check "status ok" assert_eq "ok" "$(jq_py "$LOG-prs.json" 'd["status"]')"
check "nothing pushed" assert_eq "0 0" "$(jq_py "$LOG-prs.json" '" ".join(str(d["counts"][k]) for k in ("refs","packs"))')"
check "one merge event per merged PR" assert_eq "$merged_gh" "$(jq_py "$LOG-prs.json" 'd["counts"]["events"]')"
check "no merge left unproved" assert_eq "0" "$(jq_py "$LOG-prs.json" 'd["counts"].get("unprovedMerges", "missing")')"
check "nothing left to revisit" assert_eq "0" "$(jq_py "$STATE" 'len(d.get("revisit", []))')"
li=1; for _ in $(seq 1 10); do merged_listed 2>/dev/null && { li=0; break; }; sleep 3; done
check "every PR merged on GitHub reads merged (${merged_gh})" test "$li" -eq 0

step "3. a fresh issues/PRs run with no mirror and no state"
FRESH="${WORKROOT}/s34-fresh"
imported "$LOG-fresh" issues,prs "$FRESH"
check "nothing written" assert_eq "0 0 0 0" \
  "$(jq_py "$LOG-fresh.json" '" ".join(str(d["counts"][k]) for k in ("refs","events","prs","unprovedMerges"))')"
check "no 'recorded as closed' warning" test "$(grep -c 'recorded as closed' "$LOG-fresh.json")" -eq 0
check "the work dir is untouched" test ! -e "$FRESH"

finish_scenario
