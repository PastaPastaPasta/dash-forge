#!/usr/bin/env bash
# Scenario 4 (⭐ headline): Frozen-push rejected AT CONSENSUS.
#
# Proves the token-ACL end-to-end through git:
#   1. COLLAB (holds an unfrozen WRITE token) pushes a tiny update  -> SUCCEEDS
#   2. DEPLOYER `dg collab suspend` freezes COLLAB's WRITE token
#   3. COLLAB pushes a *fast-forward* update (client-side FF guard passes, so the
#      write reaches consensus)                                     -> REJECTED at
#      consensus with a token-frozen error (NOT a client-side refusal).
#
# The CLI has no `unsuspend`, so freezing COLLAB is one-way here: on a re-run the
# harness detects COLLAB already frozen and verifies the rejection path only.
SCENARIO_NAME="04 frozen-push rejected at consensus (⭐)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

BR="e2e/${RUN_ID}/collab"
REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
SRC="${WORKROOT}/s04-src"
LOG="${WORKROOT}/s04"

# Echo "<present:yes|no> <frozen:yes|no>" for COLLAB's WRITE token from a live query.
collab_write_status() {
  dg_as "$ID_DEPLOYER" --json collab list "$REPO" >"$LOG-list.json" 2>"$LOG-list.err" || return 1
  python3 - "$IDID_COLLAB" "$LOG-list.json" <<'PY'
import json,sys
me=sys.argv[1]
try: d=json.load(open(sys.argv[2]))
except Exception: print("no no"); sys.exit(0)
for c in d.get("collaborators",[]):
    if c.get("identityId")==me:
        print(("yes" if c.get("write") else "no"),("yes" if c.get("writeFrozen") else "no")); sys.exit(0)
print("no no")
PY
}

wait_until_frozen() {
  local i st
  for i in $(seq 1 12); do
    st="$(collab_write_status || echo '')"
    [[ "$st" == "yes yes" ]] && return 0
    sleep 3
  done
  return 1
}

step "query COLLAB's current WRITE-token status"
STATUS="$(collab_write_status)" || skip_scenario "could not query collaborators (transport flake)"
info "COLLAB write status (present frozen): ${STATUS}"

PRESENT="${STATUS% *}"; FROZEN="${STATUS#* }"

if [[ "$PRESENT" == "no" ]]; then
  step "COLLAB holds no WRITE token — granting one (DEPLOYER)"
  if ! dg_as "$ID_DEPLOYER" -y collab add "$REPO" "$IDID_COLLAB" --role write >"$LOG-grant.out" 2>"$LOG-grant.err"; then
    cat "$LOG-grant.err" >&2 || true
    is_flake "$LOG-grant.err" && skip_scenario "grant failed on a transport flake"
    bad "could not grant WRITE to COLLAB"; finish_scenario
  fi
  sleep 4
  STATUS="$(collab_write_status)"; PRESENT="${STATUS% *}"; FROZEN="${STATUS#* }"
  info "COLLAB write status after grant: ${STATUS}"
fi

seed_tiny_repo "$SRC" "$BR" >/dev/null

if [[ "$FROZEN" == "no" ]]; then
  # ---- Full narrative: push OK -> freeze -> push rejected -------------------
  step "COLLAB pushes a tiny update (expect SUCCESS)"
  if ! git_dash_retry "$ID_COLLAB" "$LOG-ok" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
    cat "$LOG-ok.err" >&2 || true
    is_flake "$LOG-ok.err" && skip_scenario "COLLAB's first push failed on a transport flake"
    grep -qiE 'insufficient|balance' "$LOG-ok.err" && skip_scenario "COLLAB out of testnet credits"
    bad "COLLAB's push with a valid WRITE token was rejected (should succeed)"; finish_scenario
  fi
  register_ref "refs/heads/${BR}"
  ok "COLLAB push accepted with an unfrozen WRITE token"

  step "DEPLOYER freezes COLLAB's WRITE token (dg collab suspend)"
  if ! dg_as "$ID_DEPLOYER" -y collab suspend "$REPO" "$IDID_COLLAB" --role write >"$LOG-susp.out" 2>"$LOG-susp.err"; then
    cat "$LOG-susp.err" >&2 || true
    # The freeze ST may have landed while the CLI's immediate post-broadcast verify
    # read stale (read-after-write lag) → "broadcast but ... not frozen". Treat that
    # as soft and let the authoritative poll below decide. A real transport flake or
    # any other failure is fatal.
    if is_flake "$LOG-susp.err"; then
      skip_scenario "suspend failed on a transport flake"
    elif grep -qiE 'broadcast but|not frozen|still frozen' "$LOG-susp.err"; then
      info "suspend broadcast landed but post-verify lagged; polling for frozen status"
    else
      bad "suspend failed"; finish_scenario
    fi
  fi
  step "wait for the freeze to be observable on-chain"
  if wait_until_frozen; then ok "COLLAB's WRITE token now reads frozen"
  else skip_scenario "freeze not observable within the poll window (eventual-consistency lag)"; fi

  # Advance the local branch so the next push is a clean fast-forward: this forces
  # the rejection to happen at CONSENSUS, not at the client-side non-FF guard.
  printf 'post-freeze change %s\n' "${RUN_ID}" >"$SRC/alpha.txt"
  git -C "$SRC" add -A && git -C "$SRC" commit -q -m "post-freeze ff ${RUN_ID}"
else
  # ---- Re-run path: COLLAB already frozen -> verify rejection only ----------
  step "COLLAB is already frozen (prior run) — verifying rejection path only"
  info "no CLI unsuspend exists; the first-push/freeze steps are skipped on re-runs"
  register_ref "refs/heads/${BR}"
fi

step "COLLAB pushes again (expect CONSENSUS rejection: token frozen)"
if git_dash "$ID_COLLAB" "$LOG-frozen" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
  bad "frozen COLLAB's push was ACCEPTED — token freeze did NOT gate at consensus"
  finish_scenario
fi

echo "----- frozen-push stderr (captured) -----" >&2
cat "$LOG-frozen.err" >&2
echo "-----------------------------------------" >&2

if is_flake "$LOG-frozen.err" && ! is_consensus_frozen "$LOG-frozen.err"; then
  skip_scenario "frozen push failed but on a transport flake — inconclusive; retry"
fi
if grep -qiE 'non-fast-forward|fetch first' "$LOG-frozen.err"; then
  bad "push was refused CLIENT-SIDE (non-fast-forward), not at consensus"
  finish_scenario
fi
if is_consensus_frozen "$LOG-frozen.err"; then
  ok "frozen COLLAB push REJECTED AT CONSENSUS with a token-frozen error"
  # Surface the exact consensus error line for the report.
  FROZEN_LINE="$(grep -ioE 'account is frozen for token [A-Za-z0-9]+[^,]*|token frozen: this identity[^"]*' "$LOG-frozen.err" | head -1)"
  info "consensus error: ${FROZEN_LINE}"
else
  bad "push failed but without a recognizable token-frozen consensus error"
fi

log ""
log "${C_YEL}note:${C_RST} COLLAB's WRITE token remains FROZEN after this scenario — the dg CLI"
log "      exposes no 'unsuspend'. Re-runs auto-detect this and verify rejection only."

finish_scenario
