#!/usr/bin/env bash
# Scenario 32: a failed import push reports what it wrote, and a retry does not pay for it
# again (D-601).
#
#   1. `forge-import sindresorhus/is-wsl --sync code` (a branch and 7 tags) into a new repo,
#      the helper failing after its pack is recorded and before any ref (fault 0). The run
#      ends `error` and its summary counts the stored pack (before: 0 packs, 0 refs).
#   2. A retry failing after one ref update (fault 1): its dry run finds the pack already
#      recorded by this identity, so it is priced (and capped) for the refs only, stores no
#      pack, and the summary counts the one ref that landed (before: "0 ref updates").
#   3. A retry with no fault finishes the other refs; nothing already written is written again.
#      (Its pack may repeat objects of the first one that only the refs still missing reach:
#      the helper's thin-pack bases are the remote's tips, and those refs had not landed.)
#   4. A last run writes nothing and spends nothing.
#
# Needs git-remote-dash built with `--features test-hooks` (SKIPs otherwise; `make
# storage-e2e` builds one) and GitHub access. A new repo per run (~0.01 DASH).
SCENARIO_NAME="32 a failed import push reports what landed; the retry pays once (D-601)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

IMPORT="${BIN_DIR}/forge-import"
[[ -x "$IMPORT" ]] || skip_scenario "forge-import is not built (cargo build -p forge-import)"
grep -q DASH_FORGE_FAIL_AFTER_REFS "${BIN_DIR}/git-remote-dash" 2>/dev/null \
  || skip_scenario "git-remote-dash is not a test-hooks build (cargo build -p git-remote-dash --features test-hooks)"
if ! command -v gh >/dev/null || { [[ -z "${GH_TOKEN:-}" ]] && ! gh auth token >/dev/null 2>&1; }; then
  skip_scenario "no GitHub access (log in with gh or set GH_TOKEN)"
fi

ID="${E2E_IMPORT_IDENTITY:-$ID_OWNER}"
NAME="$(printf 'e2e-imp-fail-%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
SRC=sindresorhus/is-wsl
WORK="${WORKROOT}/s32-work"
LOG="${WORKROOT}/s32"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }

CAP=0.2
import_run() { # import_run <log> [VAR=value…]  (the spend cap is $CAP)
  local log="$1"; shift
  (
    # shellcheck disable=SC2163 # the arguments are VAR=value assignments
    [[ $# -eq 0 ]] || export "$@"
    export DASH_FORGE_KEY="$ID" RUST_LOG=error NO_COLOR=1
    _tmo_for 900 "$IMPORT" "$SRC" --repo "$NAME" --sync code --work-dir "$WORK" \
      --max-spend "$CAP" --yes ${IMPORT_DRY:+--dry-run} --summary-json "$log.json" >"$log.out" 2>"$log.err"
  )
}
must_fail() { # must_fail <log> <fault>
  if import_run "$1" "DASH_FORGE_FAIL_AFTER_REFS=$2"; then
    bad "the run with fault $2 succeeded"; finish_scenario
  fi
  grep -q 'simulated failure' "$1.json" "$1.err" || { cat "$1.err" >&2; is_flake "$1.err" && skip_scenario "forge-import flaked"; bad "fault $2: failed for another reason"; finish_scenario; }
}
must_pass() { # must_pass <log>
  import_run "$1" && return 0
  cat "$1.err" >&2; is_flake "$1.err" && skip_scenario "forge-import flaked"
  bad "$(basename "$1") failed"; finish_scenario
}
counts() { jq_py "$1.json" '" ".join(str(d["counts"][k]) for k in ("refs", "packs"))'; }
spent() { jq_py "$1.json" 'd["spentCredits"]'; }

refs_gh=$(( $(gh api "repos/$SRC/git/matching-refs/heads" --jq 'length') + $(gh api "repos/$SRC/git/matching-refs/tags" --jq 'length') ))
[[ "$refs_gh" -ge 2 ]] || skip_scenario "the source needs at least two refs"

step "1. the push fails after its pack is recorded, before any ref"
must_fail "$LOG-1" 0
check "status error" assert_eq "error" "$(jq_py "$LOG-1.json" 'd["status"]')"
check "the stored pack is counted (0 refs, 1 pack)" assert_eq "0 1" "$(counts "$LOG-1")"
check "and warned about" assert_file_contains "$LOG-1.json" "failed after writing 0 ref update(s) and 1 pack(s)"

step "2. the retry is priced for the refs only, stores no pack, and one ref lands"
# Capped between the refs' price and the pack's: a dry run says what the retry costs (the refs
# only), and the cap is 1.2 times that. Only a retry that neither the importer nor the helper's
# own cost guard charges for the pack already stored gets through.
first_git=$(( $(jq_py "$LOG-1.json" 'd["estimateCredits"]') - 200000000 ))
must_pass_dry() { import_run "$1" && return 0; cat "$1.err" >&2; is_flake "$1.err" && skip_scenario "flaked"; bad "dry run failed"; finish_scenario; }
IMPORT_DRY=1 must_pass_dry "$LOG-2dry"
refs_only="$(jq_py "$LOG-2dry.json" 'd["estimateCredits"]')"
check "the dry run prices the retry below the pack (${refs_only} < ${first_git})" test "$refs_only" -lt "$first_git"
CAP="$(python3 -c "print(f'{$refs_only * 1.2 / 1e11:.8f}')")"
must_fail "$LOG-2" 1
CAP=0.2
check "the landed ref is counted, no pack (1 ref, 0 packs)" assert_eq "1 0" "$(counts "$LOG-2")"
# The first run's estimate less the repo creation (0.002 DASH) is the pack plus the refs; the
# retry's is the refs only (measured 2026-09-27: 0.00695 of 0.0180 DASH).
check "the capped retry got past both guards (1 ref landed under the cap)" assert_eq "cap ok" "cap $(jq_py "$LOG-2.json" '"ok" if d["status"] == "error" else d["status"]')"

step "3. a clean retry writes only the refs that had not landed"
must_pass "$LOG-3"
check "status ok" assert_eq "ok" "$(jq_py "$LOG-3.json" 'd["status"]')"
check "the other $((refs_gh - 1)) refs" assert_eq "$((refs_gh - 1))" "$(jq_py "$LOG-3.json" 'd["counts"]["refs"]')"

step "4. a last run writes and spends nothing"
must_pass "$LOG-4"
check "nothing written" assert_eq "0 0" "$(counts "$LOG-4")"
check "nothing spent" assert_eq "0" "$(spent "$LOG-4")"

finish_scenario
