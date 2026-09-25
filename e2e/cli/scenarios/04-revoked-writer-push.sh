#!/usr/bin/env bash
# Scenario 4 (⭐ headline): a revoked writer's push is rejected AT CONSENSUS.
#
# Proves forge-v2 membership end-to-end through git:
#   1. OWNER `dg collab add` makes COLLAB a writer          (a `writer` document)
#   2. COLLAB pushes a tiny branch                          -> SUCCEEDS
#   3. OWNER `dg collab remove` revokes COLLAB              (the document is deleted)
#   4. COLLAB pushes a *fast-forward* (the client-side FF guard passes and the helper's
#      membership pre-check is bypassed, so the write reaches consensus)
#                                                           -> REJECTED at consensus: 40120
#      (`ownerRefersTo` finds no writer/maintainer document for COLLAB)
#
# Re-runnable: step 1 is idempotent (an existing writer document is reused) and step 3
# always leaves COLLAB revoked.
SCENARIO_NAME="04 revoked-writer push rejected at consensus (⭐)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

BR="e2e/${RUN_ID}/collab"
REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
SRC="${WORKROOT}/s04-src"
LOG="${WORKROOT}/s04"

harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

# Echo COLLAB's role in the repo ("writer", "maintainer" or "none") from a live query.
collab_role() {
  dg_read_retry "$ID_OWNER" "$LOG-list.json" "$LOG-list.err" --json collab list "$REPO" || return 1
  python3 - "$IDID_COLLAB" "$LOG-list.json" <<'PY'
import json,sys
me=sys.argv[1]
d=json.load(open(sys.argv[2]))
roles=[m["role"] for m in d.get("members",[]) if m.get("identityId")==me]
print(roles[0] if roles else "none")
PY
}

wait_for_role() { # wait_for_role <expected>
  local i
  for i in $(seq 1 12); do
    [[ "$(collab_role || echo '')" == "$1" ]] && return 0
    sleep 3
  done
  return 1
}

step "OWNER adds COLLAB as a writer (dg collab add)"
if ! dg_as "$ID_OWNER" -y collab add "$REPO" "$IDID_COLLAB" --role writer >"$LOG-add.out" 2>"$LOG-add.err"; then
  cat "$LOG-add.err" >&2 || true
  is_flake "$LOG-add.err" && skip_scenario "grant failed on a transport flake"
  bad "could not add COLLAB as a writer"; finish_scenario
fi
if wait_for_role writer; then ok "COLLAB is a writer"; else bad "COLLAB's writer document is not visible"; finish_scenario; fi

step "COLLAB pushes a tiny branch (expect SUCCESS)"
seed_tiny_repo "$SRC" "$BR" >/dev/null
if ! git_dash_retry "$ID_COLLAB" "$LOG-ok" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
  cat "$LOG-ok.err" >&2 || true
  is_flake "$LOG-ok.err" && skip_scenario "COLLAB's first push failed on a transport flake"
  grep -qiE 'insufficient|balance' "$LOG-ok.err" && skip_scenario "COLLAB out of credits"
  bad "a writer's push was rejected (should succeed)"; finish_scenario
fi
register_ref "refs/heads/${BR}"
ok "COLLAB push accepted as a writer"

step "OWNER removes COLLAB (dg collab remove — deletes the writer document)"
if ! dg_as "$ID_OWNER" -y collab remove "$REPO" "$IDID_COLLAB" --role writer >"$LOG-rm.out" 2>"$LOG-rm.err"; then
  cat "$LOG-rm.err" >&2 || true
  is_flake "$LOG-rm.err" && skip_scenario "revoke failed on a transport flake"
  bad "revoke failed"; finish_scenario
fi
if wait_for_role none; then ok "COLLAB is no longer a member"; else skip_scenario "revocation not observable within the poll window"; fi

# Advance the local branch so the next push is a clean fast-forward: the rejection must
# come from CONSENSUS, not from the client-side non-FF guard.
printf 'post-revoke change %s\n' "${RUN_ID}" >"$SRC/alpha.txt"
git -C "$SRC" add -A && git -C "$SRC" commit -q -m "post-revoke ff ${RUN_ID}"

step "COLLAB pushes again (expect CONSENSUS rejection: 40120)"
# The helper refuses a non-member's push locally before anything is broadcast. This scenario
# exists to prove the network itself enforces the revocation, so it turns that pre-check off.
if DASH_FORGE_SKIP_WRITE_PRECHECK=1 git_dash_retry "$ID_COLLAB" "$LOG-revoked" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
  bad "the revoked writer's push was ACCEPTED — revocation did NOT gate at consensus"
  finish_scenario
fi

echo "----- revoked-push stderr (captured) -----" >&2
cat "$LOG-revoked.err" >&2
echo "------------------------------------------" >&2

if is_flake "$LOG-revoked.err" && ! is_consensus_reject "$LOG-revoked.err"; then
  skip_scenario "revoked push flaked on transport on every attempt (${E2E_ATTEMPTS}) — inconclusive"
fi
if is_local_precheck "$LOG-revoked.err"; then
  bad "push was refused by the helper's local pre-check, not at consensus (DASH_FORGE_SKIP_WRITE_PRECHECK not honored?)"
  finish_scenario
fi
if grep -qiE 'non-fast-forward|fetch first' "$LOG-revoked.err"; then
  bad "push was refused CLIENT-SIDE (non-fast-forward), not at consensus"
  finish_scenario
fi
if is_consensus_reject "$LOG-revoked.err"; then
  ok "revoked writer's push REJECTED AT CONSENSUS (40120)"
  info "consensus error: $(grep -oE '40120[^)]*' "$LOG-revoked.err" | head -1)"
else
  bad "push failed but without a recognizable 40120 consensus error"
fi

step "the helper's own pre-check names the fix (no pre-check bypass)"
if git_dash "$ID_COLLAB" "$LOG-pre" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
  bad "the revoked writer's push was accepted with the pre-check on"
elif is_local_precheck "$LOG-pre.err" || is_local_precheck "$LOG-pre.out"; then
  ok "pre-check refuses the push and points at \`dg collab add\`"
else
  cat "$LOG-pre.err" >&2
  bad "pre-check did not explain the refusal"
fi

finish_scenario
