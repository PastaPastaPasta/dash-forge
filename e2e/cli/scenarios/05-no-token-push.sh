#!/usr/bin/env bash
# Scenario 5: No-token push rejected at consensus. CONTRIB holds no WRITE token;
# its push must be refused by the network (an unauthorized/insufficient-token
# consensus error), not silently accepted.
SCENARIO_NAME="05 no-token push rejected at consensus"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

BR="e2e/${RUN_ID}/contrib"
REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
SRC="${WORKROOT}/s05-src"
LOG="${WORKROOT}/s05"

step "sanity: confirm CONTRIB holds no WRITE token"
if dg_as "$ID_DEPLOYER" --json collab list "$REPO" >"$LOG-list.json" 2>"$LOG-list.err"; then
  HASW="$(python3 - "$IDID_CONTRIB" "$LOG-list.json" <<'PY'
import json,sys
me=sys.argv[1]
try: d=json.load(open(sys.argv[2]))
except Exception: print("unknown"); sys.exit(0)
for c in d.get("collaborators",[]):
    if c.get("identityId")==me and c.get("write"):
        print("has"); sys.exit(0)
print("none")
PY
)"
  info "CONTRIB write token: ${HASW}"
  [[ "$HASW" == "has" ]] && skip_scenario "CONTRIB unexpectedly holds a WRITE token; not a no-token subject"
else
  info "collab list query failed (transport); proceeding — CONTRIB is a no-token fixture"
fi

step "CONTRIB attempts a push (expect CONSENSUS rejection)"
seed_tiny_repo "$SRC" "$BR" >/dev/null
register_ref "refs/heads/${BR}"
if git_dash "$ID_CONTRIB" "$LOG-push" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
  bad "CONTRIB's push was ACCEPTED without a WRITE token — the write path is NOT gated"
  finish_scenario
fi

echo "----- no-token push stderr (captured) -----" >&2
cat "$LOG-push.err" >&2
echo "-------------------------------------------" >&2

if is_flake "$LOG-push.err" && ! is_consensus_reject "$LOG-push.err"; then
  skip_scenario "push failed on a transport flake — inconclusive; retry"
fi
if grep -qiE 'insufficient credits|InsufficientCredits' "$LOG-push.err" && ! is_consensus_reject "$LOG-push.err"; then
  skip_scenario "CONTRIB lacks the credits to even submit the state transition (fund + retry)"
fi
if is_consensus_reject "$LOG-push.err"; then
  ok "no-token push REJECTED AT CONSENSUS (unauthorized / insufficient WRITE token)"
  REJ_LINE="$(grep -ioE 'not authorized[^\"]*|unauthorized[^\"]*|insufficient token[^\"]*|requires a WRITE[^\"]*|token[^\"]*' "$LOG-push.err" | head -1)"
  info "consensus error: ${REJ_LINE}"
else
  bad "push failed but without a recognizable unauthorized/token consensus error"
fi

finish_scenario
