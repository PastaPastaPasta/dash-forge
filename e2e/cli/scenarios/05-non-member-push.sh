#!/usr/bin/env bash
# Scenario 5: a non-member's push is rejected at consensus. CONTRIB has never been a
# writer or maintainer of the test repo; its push must be refused by the network (40120:
# `ownerRefersTo` finds no membership document), not silently accepted.
SCENARIO_NAME="05 non-member push rejected at consensus"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

BR="e2e/${RUN_ID}/contrib"
REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
SRC="${WORKROOT}/s05-src"
LOG="${WORKROOT}/s05"

harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

step "sanity: confirm CONTRIB is not a member"
if dg_read_retry "$ID_OWNER" "$LOG-list.json" "$LOG-list.err" --json collab list "$REPO"; then
  IS="$(python3 - "$IDID_CONTRIB" "$LOG-list.json" <<'PY'
import json,sys
me=sys.argv[1]
d=json.load(open(sys.argv[2]))
print("member" if any(m.get("identityId")==me for m in d.get("members",[])) else "none")
PY
)"
  info "CONTRIB membership: ${IS}"
  [[ "$IS" == "member" ]] && skip_scenario "CONTRIB is unexpectedly a member; not a non-member subject"
else
  info "collab list query failed (transport); proceeding — CONTRIB is a non-member fixture"
fi

step "CONTRIB attempts a push (expect CONSENSUS rejection)"
seed_tiny_repo "$SRC" "$BR" >/dev/null
register_ref "refs/heads/${BR}"
# As in 04: bypass the helper's local membership pre-check so the push reaches consensus,
# and retry on a flake so the scenario reaches a verdict.
if DASH_FORGE_SKIP_WRITE_PRECHECK=1 git_dash_retry "$ID_CONTRIB" "$LOG-push" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
  bad "CONTRIB's push was ACCEPTED without membership — the write path is NOT gated"
  finish_scenario
fi

echo "----- non-member push stderr (captured) -----" >&2
cat "$LOG-push.err" >&2
echo "---------------------------------------------" >&2

if is_flake "$LOG-push.err" && ! is_consensus_reject "$LOG-push.err"; then
  skip_scenario "push flaked on transport on every attempt (${E2E_ATTEMPTS}) — inconclusive"
fi
if is_local_precheck "$LOG-push.err"; then
  bad "push was refused by the helper's local pre-check, not at consensus (DASH_FORGE_SKIP_WRITE_PRECHECK not honored?)"
  finish_scenario
fi
if grep -qiE 'insufficient credits|InsufficientCredits' "$LOG-push.err" && ! is_consensus_reject "$LOG-push.err"; then
  skip_scenario "CONTRIB lacks the credits to even submit the state transition (fund + retry)"
fi
if is_consensus_reject "$LOG-push.err"; then
  ok "non-member push REJECTED AT CONSENSUS (40120)"
  info "consensus error: $(grep -oE '40120[^)]*' "$LOG-push.err" | head -1)"
else
  bad "push failed but without a recognizable 40120 consensus error"
fi

finish_scenario
