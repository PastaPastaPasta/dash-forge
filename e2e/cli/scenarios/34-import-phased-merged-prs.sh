#!/usr/bin/env bash
# Scenario 34: a phased import records merged PRs as merged (the showcase's beta.6 defect).
#
#   1. `--sync code` into a new repo `e2e-phase-<run>`, with its own --work-dir mirror.
#   2. `--sync issues,prs` as a SEPARATE run with --state and an EMPTY --work-dir (a CI job on a
#      new runner): no `code`, so nothing is pushed. Before the fix it recorded every merged PR
#      as closed ("no mirrored tip of its base contains the merge commit"). Now it fetches the
#      base branches' commits (a temporary repository, never in the work dir) and each PR merged
#      on GitHub reads MERGED in `dg pr list`; 0 unproved, nothing left to revisit.
#   3. `--sync code` into that same work dir: the collab run left it empty, so the clone works.
#   4. The issues/PRs pass again with the same state writes nothing.
#   5. Issues/PRs BEFORE any code, into a second repo `e2e-phase2-<run>`: the base is no branch
#      on chain when the PRs are mirrored, so their merges can never count (forge-v2 §6, D-501).
#      Each is recorded closed, counted unproved, warned about with that reason, and NOT kept to
#      revisit (it could never be proved).
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

FRESH="${WORKROOT}/s34-fresh"

step "1. the code"
imported "$LOG-code" code "$MIRROR"
check "status ok" assert_eq "ok" "$(jq_py "$LOG-code.json" 'd["status"]')"
check "branches and tags pushed" test "$(jq_py "$LOG-code.json" 'd["counts"]["refs"]')" -gt 0

step "2. issues and PRs in a separate run, with an empty work dir"
imported "$LOG-prs" issues,prs "$FRESH" --state "$STATE"
check "status ok" assert_eq "ok" "$(jq_py "$LOG-prs.json" 'd["status"]')"
check "nothing pushed" assert_eq "0 0" "$(jq_py "$LOG-prs.json" '" ".join(str(d["counts"][k]) for k in ("refs","packs"))')"
check "no merge left unproved" assert_eq "0" "$(jq_py "$LOG-prs.json" 'd["counts"].get("unprovedMerges", "missing")')"
check "no 'recorded as closed' warning" test "$(grep -c 'recorded as closed' "$LOG-prs.json")" -eq 0
check "nothing left to revisit" assert_eq "0" "$(jq_py "$STATE" 'len(d.get("revisit", []))')"
check "the work dir is left empty" test ! -e "$FRESH"
li=1; for _ in $(seq 1 10); do merged_listed 2>/dev/null && { li=0; break; }; sleep 3; done
check "every PR merged on GitHub reads merged (${merged_gh})" test "$li" -eq 0

step "3. the code into that same work dir"
imported "$LOG-code2" code "$FRESH"
check "status ok (the clone into the work dir worked)" assert_eq "ok" "$(jq_py "$LOG-code2.json" 'd["status"]')"
check "nothing new to push" assert_eq "0" "$(jq_py "$LOG-code2.json" 'd["counts"]["packs"]')"

step "4. the same issues/PRs pass writes nothing more"
imported "$LOG-prs2" issues,prs "$FRESH" --state "$STATE"
check "nothing written" assert_eq "0 0 0 0" \
  "$(jq_py "$LOG-prs2.json" '" ".join(str(d["counts"][k]) for k in ("refs","events","prs","unprovedMerges"))')"

step "5. issues and PRs before any code (a second repo)"
NAME2="$(printf 'e2e-phase2-%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
STATE2="${WORKROOT}/s34-state2.json"
DASH_FORGE_KEY="$ID" RUST_LOG=error NO_COLOR=1 _tmo_for 900 "$IMPORT" "$SRC" --repo "$NAME2" --sync issues,prs \
  --work-dir "${WORKROOT}/s34-early" --state "$STATE2" --max-spend 0.2 --yes --summary-json "$LOG-early.json" \
  >"$LOG-early.out" 2>"$LOG-early.err" || { cat "$LOG-early.err" >&2; is_flake "$LOG-early.err" && skip_scenario "forge-import flaked"; bad "the early issues/PRs run failed"; finish_scenario; }
check "every merged PR counted unproved (${merged_gh})" assert_eq "$merged_gh" "$(jq_py "$LOG-early.json" 'd["counts"].get("unprovedMerges")')"
check "the warning names the rule (D-501)" test "$(grep -c 'D-501' "$LOG-early.json")" -ge 1
check "not kept to revisit (never provable)" assert_eq "0" "$(jq_py "$STATE2" 'len(d.get("revisit", []))')"

finish_scenario
