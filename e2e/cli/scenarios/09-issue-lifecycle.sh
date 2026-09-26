#!/usr/bin/env bash
# Scenario 9: the issue lifecycle on forge-v2, and who may change an issue's state.
#
#   1. CONTRIB (never a member) opens an issue           -> numbered by the §6 rule
#   2. CONTRIB closes it (the author: `authorEvent`)       -> reads closed
#   3. CONTRIB reopens it (`authorEvent`)                  -> reads open
#   4. COLLAB (not the author, not a member) tries to close it:
#        a. dg refuses before signing                      -> E601, nothing paid
#        b. with the pre-check off, consensus refuses the `event` -> 40120 on $ownerId
#   5. OWNER (maintainer) labels it and comments           -> label reads back
#   6. OWNER closes it as a member (`event`)               -> reads closed
#
# COLLAB is left a non-member here (scenario 04 always ends with it revoked).
SCENARIO_NAME="09 issue lifecycle (authorEvent, member event, stranger refused at consensus)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
[[ -n "${HARNESS_SHARED:-}" ]] || harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
LOG="${WORKROOT}/s09"
TITLE="e2e ${RUN_ID} issue"

jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }

# A dg write as <identity>, once (writes are not blindly retried: see dg_read_retry).
dg_write() { # dg_write <identity> <log-prefix> <dg args...>
  local id="$1" out="$2"; shift 2
  dg_as "$id" --yes --json "$@" >"${out}.json" 2>"${out}.err"
}

# The issue's `open` state as <identity> reads it, polled until it equals <want>.
wait_open() { # wait_open <number> <want true|false>
  local i
  for i in $(seq 1 10); do
    if dg_read_retry "$ID_OWNER" "$LOG-view.json" "$LOG-view.err" --json issue view "$REPO" "$1"; then
      [[ "$(jq_py "$LOG-view.json" 'str(d["state"]["open"]).lower()')" == "$2" ]] && return 0
    fi
    sleep 3
  done
  return 1
}

step "CONTRIB opens an issue"
if ! dg_write "$ID_CONTRIB" "$LOG-create" issue create "$REPO" --title "$TITLE" --body "opened by the e2e suite"; then
  cat "$LOG-create.err" "$LOG-create.json" >&2
  is_flake "$LOG-create.err" && skip_scenario "issue create flaked"
  bad "issue create failed"; finish_scenario
fi
N="$(jq_py "$LOG-create.json" 'd["number"]')"
ok "opened issue #${N} ($(jq_py "$LOG-create.json" 'd["cost"]["dash"]') DASH)"

step "CONTRIB closes it as the author (authorEvent)"
if dg_write "$ID_CONTRIB" "$LOG-close" issue close "$REPO" "$N"; then
  check "routed through authorEvent" assert_eq "author" "$(jq_py "$LOG-close.json" 'd["via"]')"
  check "reads closed" wait_open "$N" false
else
  cat "$LOG-close.err" "$LOG-close.json" >&2; bad "author close failed"
fi

step "CONTRIB reopens it (authorEvent)"
if dg_write "$ID_CONTRIB" "$LOG-reopen" issue reopen "$REPO" "$N"; then
  check "reads open" wait_open "$N" true
else
  cat "$LOG-reopen.json" >&2; bad "author reopen failed"
fi

step "COLLAB (not author, not member) tries to close: refused before signing"
if dg_write "$ID_COLLAB" "$LOG-stranger" issue close "$REPO" "$N"; then
  bad "a stranger's close was accepted"
else
  check "E601 before signing" assert_eq "E601" "$(jq_py "$LOG-stranger.json" 'd["error"]["code"]')"
  check "says nothing was paid" assert_file_contains "$LOG-stranger.json" "nothing was written"
fi

step "…and with the pre-check off, consensus refuses the member event (40120)"
if DASH_FORGE_SKIP_WRITE_PRECHECK=1 dg_write "$ID_COLLAB" "$LOG-stranger2" issue close "$REPO" "$N"; then
  bad "a stranger's member event was ACCEPTED at consensus"
else
  cat "$LOG-stranger2.json" >>"$LOG-stranger2.err"
  if is_consensus_reject "$LOG-stranger2.err"; then
    ok "stranger's event REJECTED AT CONSENSUS (40120)"
  elif is_flake "$LOG-stranger2.err"; then
    skip_scenario "the consensus probe flaked"
  else
    cat "$LOG-stranger2.err" >&2; bad "refused, but not with a 40120 membership error"
  fi
fi
check "still open" wait_open "$N" true

step "OWNER (maintainer) labels and comments"
if dg_write "$ID_OWNER" "$LOG-label" issue label "$REPO" "$N" --add e2e; then
  labeled() {
    dg_read_retry "$ID_OWNER" "$LOG-lv.json" "$LOG-lv.err" --json issue view "$REPO" "$N" \
      && [[ "$(jq_py "$LOG-lv.json" '",".join(d["state"]["labels"])')" == *e2e* ]]
  }
  lab=1; for _ in $(seq 1 10); do labeled && { lab=0; break; }; sleep 3; done
  check "label reads back" test "$lab" -eq 0
else
  cat "$LOG-label.json" >&2; bad "member label failed"
fi
if dg_write "$ID_OWNER" "$LOG-comment" issue comment "$REPO" "$N" --body "triaged by the e2e suite"; then
  ok "comment posted"
else
  cat "$LOG-comment.json" >&2; bad "comment failed"
fi

step "OWNER closes it as a member (event)"
if dg_write "$ID_OWNER" "$LOG-mclose" issue close "$REPO" "$N"; then
  check "routed through a member event" assert_eq "member" "$(jq_py "$LOG-mclose.json" 'd["via"]')"
  check "reads closed" wait_open "$N" false
else
  cat "$LOG-mclose.json" >&2; bad "member close failed"
fi

finish_scenario
