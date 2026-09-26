#!/usr/bin/env bash
# Scenario 12: star and unstar (forge-collab `star`, an `indexOnly` type).
#
# Unstar is the protocol-14 indexOnly delete, which carries the star's values rather than an
# id. CONTRIB stars the test repo (count +1), stars again (nothing written), unstars (count
# back), and unstars again (nothing to remove). Starts from "not starred" whatever an
# interrupted earlier run left.
SCENARIO_NAME="12 star / unstar (indexOnly delete)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
[[ -n "${HARNESS_SHARED:-}" ]] || harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
LOG="${WORKROOT}/s12"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }
star() { # star <star|unstar> <log>
  dg_as "$ID_CONTRIB" --yes --json repo "$1" "$REPO" >"$2.json" 2>"$2.err" \
    || { cat "$2.err" "$2.json" >&2; is_flake "$2.err" && skip_scenario "$1 flaked"; bad "$1 failed"; finish_scenario; }
}

step "start unstarred"
star unstar "$LOG-reset"
BEFORE="$(jq_py "$LOG-reset.json" 'd["stars"]')"
info "stars before: ${BEFORE} ($(jq_py "$LOG-reset.json" 'd["status"]'))"

step "CONTRIB stars"
star star "$LOG-star"
check "starred" assert_eq "starred" "$(jq_py "$LOG-star.json" 'd["status"]')"
check "reads starred" assert_eq "True" "$(jq_py "$LOG-star.json" 'd["starred"]')"
check "count +1" assert_eq "$((BEFORE + 1))" "$(jq_py "$LOG-star.json" 'd["stars"]')"

step "starring again writes nothing"
star star "$LOG-star2"
check "already starred" assert_eq "already_starred" "$(jq_py "$LOG-star2.json" 'd["status"]')"

step "CONTRIB unstars (the values-carrying indexOnly delete)"
star unstar "$LOG-unstar"
check "unstarred" assert_eq "unstarred" "$(jq_py "$LOG-unstar.json" 'd["status"]')"
check "reads not starred" assert_eq "False" "$(jq_py "$LOG-unstar.json" 'd["starred"]')"
check "count back" assert_eq "$BEFORE" "$(jq_py "$LOG-unstar.json" 'd["stars"]')"

step "unstarring again removes nothing"
star unstar "$LOG-unstar2"
check "not starred" assert_eq "not_starred" "$(jq_py "$LOG-unstar2.json" 'd["status"]')"

finish_scenario
