#!/usr/bin/env bash
# run.sh — Dash Forge CLI end-to-end suite driver.
#
# Runs every scenario against LIVE testnet, reusing the DEPLOYER-owned m1 repo
# (config.sh). Prints a PASS/FAIL/SKIP matrix and exits non-zero if ANY scenario
# FAILs. SKIPs (funds / testnet-islock flakiness) are non-fatal but reported.
#
# Usage:
#   bash e2e/cli/run.sh                 # run all scenarios
#   bash e2e/cli/run.sh 01 04 06        # run a subset (by leading number)
#   RUN_ID=my-tag bash e2e/cli/run.sh   # pin the run-id (branch namespace)
#   E2E_TIMEOUT=300 bash e2e/cli/run.sh # per-command timeout (seconds)
#   E2E_NO_CLEANUP=1 bash e2e/cli/run.sh# leave test branches on the remote
#
# Exit: 0 = all non-skipped scenarios passed; 1 = at least one FAILed.

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

for s in "${SCENARIOS[@]}"; do
  script="${HARNESS_DIR}/scenarios/${s}.sh"
  printf '\n%s┌─ scenario %s ─────────────────────────────────%s\n' "${C_DIM}" "$s" "${C_RST}" >&2
  bash "$script"
  rc=$?
  case $rc in
    0) RESULTS+=("PASS"); PASSED=$((PASSED+1));;
    2) RESULTS+=("SKIP"); SKIPPED=$((SKIPPED+1));;
    *) RESULTS+=("FAIL"); FAILED=$((FAILED+1));;
  esac
  NAMES+=("$s")
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

[[ "$FAILED" -eq 0 ]] || exit 1
exit 0
