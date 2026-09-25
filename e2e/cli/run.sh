#!/usr/bin/env bash
# run.sh — Dash Forge CLI end-to-end suite driver.
#
# Runs every scenario against LIVE testnet, reusing the DEPLOYER-owned m1 repo
# (config.sh). Prints a PASS/FAIL/SKIP matrix and exits non-zero if ANY scenario
# FAILs. A scenario SKIPs only when a check flaked on every retry; one SKIP is reported
# but tolerated, more than E2E_MAX_SKIPS fails the run.
#
# Usage:
#   bash e2e/cli/run.sh                 # run all scenarios
#   bash e2e/cli/run.sh 01 04 06        # run a subset (by leading number)
#   RUN_ID=my-tag bash e2e/cli/run.sh   # pin the run-id (branch namespace)
#   E2E_TIMEOUT=300 bash e2e/cli/run.sh # per-command timeout (seconds)
#   E2E_SCENARIO_TIMEOUT=900 …          # per-scenario timeout (seconds)
#   E2E_SUITE_BUDGET=2400 …             # whole-suite budget incl. cleanup (seconds)
#   E2E_ATTEMPTS=3 E2E_RETRY_PAUSE=20 … # flake retries per command, base pause
#   E2E_MAX_SKIPS=1 …                   # SKIPs tolerated before the run fails
#   E2E_NO_CLEANUP=1 bash e2e/cli/run.sh# leave test branches on the remote
#
# Exit: 0 = no FAIL and at most E2E_MAX_SKIPS SKIPs; 1 otherwise.

set -uo pipefail
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${HARNESS_DIR}/lib.sh"

# run.sh owns a single shared workroot + run-id + cleanup for the whole suite.
harness_init
export RUN_ID WORKROOT BIN_DIR PATH DG
export HARNESS_SHARED=1

SCENARIOS=(
  "01-round-trip"
  "02-non-ff"
  "03-ref-delete"
  "04-frozen-push"
  "05-no-token-push"
  "06-third-party-verify"
  "07-depth-and-filter"
)

# Optional subset filter (match by leading number or substring).
if [[ $# -gt 0 ]]; then
  filtered=()
  for want in "$@"; do
    for s in "${SCENARIOS[@]}"; do
      [[ "$s" == "$want"* || "$s" == *"$want"* ]] && filtered+=("$s")
    done
  done
  SCENARIOS=("${filtered[@]}")
fi

declare -a NAMES RESULTS
FAILED=0; PASSED=0; SKIPPED=0

printf '\n%s########  Dash Forge CLI e2e — run %s  ########%s\n' "${C_DIM}" "${RUN_ID}" "${C_RST}" >&2
printf '%srepo: %s%s\n' "${C_DIM}" "${E2E_REMOTE}" "${C_RST}" >&2

# Every command inside a scenario is already bounded by E2E_TIMEOUT. On top of that each
# scenario is bounded (a scenario is a dozen commands plus retries), and the whole suite
# has a budget: a scenario never gets more time than the budget has left, and once it is
# spent the remaining scenarios are recorded as not run. So the matrix, the cleanup and
# the exit code always happen, inside the CI step's own timeout, however slow testnet is.
: "${E2E_SCENARIO_TIMEOUT:=900}"
: "${E2E_SUITE_BUDGET:=2400}"
SUITE_START=$SECONDS
CLEANUP_RESERVE=240

for s in "${SCENARIOS[@]}"; do
  NAMES+=("$s")
  left=$((E2E_SUITE_BUDGET - (SECONDS - SUITE_START) - CLEANUP_RESERVE))
  if [[ $left -lt 60 ]]; then
    printf '%sFAIL%s  %s  — not run: the %ss suite budget is spent\n' "${C_RED}" "${C_RST}" "$s" "${E2E_SUITE_BUDGET}" >&2
    RESULTS+=("FAIL"); FAILED=$((FAILED+1))
    continue
  fi
  limit=$(( left < E2E_SCENARIO_TIMEOUT ? left : E2E_SCENARIO_TIMEOUT ))
  script="${HARNESS_DIR}/scenarios/${s}.sh"
  printf '\n%s┌─ scenario %s ─────────────────────────────────%s\n' "${C_DIM}" "$s" "${C_RST}" >&2
  started=$SECONDS
  _tmo_for "$limit" bash "$script"
  rc=$?
  info "scenario ${s}: rc=${rc} in $((SECONDS - started))s"
  case $rc in
    0) RESULTS+=("PASS"); PASSED=$((PASSED+1));;
    2) RESULTS+=("SKIP"); SKIPPED=$((SKIPPED+1));;
    124|137)
      printf '%sFAIL%s  %s  — scenario exceeded %ss and was killed\n' "${C_RED}" "${C_RST}" "$s" "$limit" >&2
      RESULTS+=("FAIL"); FAILED=$((FAILED+1));;
    *) RESULTS+=("FAIL"); FAILED=$((FAILED+1));;
  esac
done

# Suite-level cleanup of every registered remote test ref (best effort).
if [[ "${E2E_NO_CLEANUP:-0}" != "1" ]]; then
  cleanup_refs
else
  info "E2E_NO_CLEANUP=1 — leaving test refs on the remote"
fi

# --- matrix ------------------------------------------------------------------
printf '\n%s========  RESULT MATRIX  ========%s\n' "${C_DIM}" "${C_RST}" >&2
for i in "${!NAMES[@]}"; do
  r="${RESULTS[$i]}"
  case "$r" in
    PASS) col="${C_GRN}";; SKIP) col="${C_YEL}";; *) col="${C_RED}";;
  esac
  printf '  %s%-6s%s %s\n' "$col" "$r" "${C_RST}" "${NAMES[$i]}" >&2
done
printf '%s---------------------------------%s\n' "${C_DIM}" "${C_RST}" >&2
printf '  passed=%d  skipped=%d  failed=%d\n' "$PASSED" "$SKIPPED" "$FAILED" >&2

# Every scenario retries its flakes (E2E_ATTEMPTS each), so a SKIP already means "flaked on
# every attempt". One is tolerated as testnet weather; more than E2E_MAX_SKIPS means the
# suite did not really run, and it fails rather than passing on the scenarios that did.
: "${E2E_MAX_SKIPS:=1}"
if [[ "$SKIPPED" -gt "$E2E_MAX_SKIPS" ]]; then
  printf '%sFAIL%s  %d scenarios SKIPPED (limit %d): too few verdicts for this run to count as a pass\n' \
    "${C_RED}" "${C_RST}" "$SKIPPED" "$E2E_MAX_SKIPS" >&2
  exit 1
fi

[[ "$FAILED" -eq 0 ]] || exit 1
exit 0
