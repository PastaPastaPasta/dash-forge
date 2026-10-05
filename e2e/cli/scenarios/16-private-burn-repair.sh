#!/usr/bin/env bash
# Scenario 16: a burn interrupted by a crash is finished by another maintainer
# (docs/security/private-repos.md §5.3, §5.5 "Burn", §5.6).
#
#   1. OWNER `dg repo create --private`; adds COLLAB as a maintainer and CONTRIB as a writer
#   2. OWNER starts a rotation that dies after its self-wrap for epoch 1
#      (`DASH_FORGE_TEST_FAULT=after-self-wrap`): epoch 1 has a key and no anchor
#   3. OWNER removes CONTRIB: the rotation must not reuse that earlier run's key (a removal never
#      trusts a read that may lag its wrap to CONTRIB), so it wraps epoch 1 to the remaining
#      members, anchors it burned, and dies right there (`after-burn-anchor`)
#   4. COLLAB (the other maintainer) sees the burned current epoch named in `dg repo keys status`,
#      and `dg repo keys repair` rotates past it to epoch 2 (chained with a skip key to epoch 0)
#   5. OWNER pushes under epoch 2; CONTRIB (who holds only epoch 0's key) is refused, while
#      OWNER and COLLAB clone both commits (epoch 2 chains past burned 1 to 0 with its skip key);
#      `dg repo keys status` ends with no alerts and nothing to repair
#
# The fault points are honoured only by debug builds of dg; the scenario skips with release
# binaries. Each run makes a new repo (`e2e-burn-<run-id>`).
SCENARIO_NAME="16 private repository: a crashed burn finished by another maintainer"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

NAME="e2e-burn-${RUN_ID}"
NAME="${NAME:0:63}"
REPO="${E2E_OWNER_ID}/${NAME}"
REMOTE="dash://${REPO}"
SRC="${WORKROOT}/s16-src"
LOG="${WORKROOT}/s16"
json_field() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {"d": d}))' "$1" "$2" 2>/dev/null; }

if [[ "$BIN_DIR" == */release ]]; then
  skip_scenario "needs debug binaries (test fault points)"
fi

step "OWNER creates a private repo, pushes, adds COLLAB (maintainer) and CONTRIB (writer)"
if ! _retry "$LOG-create.err" _dg_read "$ID_OWNER" "$LOG-create.json" "$LOG-create.err" \
    --yes --json repo create "$NAME" --no-protect --private --storage platform; then
  cat "$LOG-create.err" >&2
  is_flake "$LOG-create.err" && skip_scenario "create failed on a transport flake"
  bad "private create failed"; finish_scenario
fi
seed_tiny_repo "$SRC" main >/dev/null
TIP="$(git -C "$SRC" rev-parse HEAD)"
if ! git_dash_retry "$ID_OWNER" "$LOG-push" -C "$SRC" push "$REMOTE" "refs/heads/main:refs/heads/main"; then
  cat "$LOG-push.err" >&2
  is_flake "$LOG-push.err" && skip_scenario "push failed on a transport flake"
  bad "push failed"; finish_scenario
fi
if collab_accept "$ID_COLLAB" "$REPO" "$LOG-addc" && collab_accept "$ID_CONTRIB" "$REPO" "$LOG-addw" \
   && dg_as "$ID_OWNER" -y --json collab add "$REPO" "$IDID_COLLAB" --role maintainer >"$LOG-addc.json" 2>"$LOG-addc.err" \
   && dg_as "$ID_OWNER" -y --json collab add "$REPO" "$IDID_CONTRIB" --role writer >"$LOG-addw.json" 2>"$LOG-addw.err"; then
  ok "created, pushed main @ ${TIP:0:12}, added COLLAB and CONTRIB"
else
  cat "$LOG-addc.err" "$LOG-addw.err" >&2; bad "adding members failed"; finish_scenario
fi

step "OWNER's rotation dies after its self-wrap for epoch 1"
if DASH_FORGE_TEST_FAULT=after-self-wrap dg_as "$ID_OWNER" -y --json repo keys rotate "$REPO" >"$LOG-rot.json" 2>"$LOG-rot.err"; then
  skip_scenario "the rotation ignored the fault point (a release build of dg)"
elif grep -q "test fault injected at after-self-wrap" "$LOG-rot.err" "$LOG-rot.json"; then
  ok "rotation stopped after the self-wrap (epoch 1 has a key, no anchor)"
else
  cat "$LOG-rot.err" "$LOG-rot.json" >&2
  is_flake "$LOG-rot.err" && skip_scenario "rotation failed on a flake"
  bad "rotation failed before the fault point"; finish_scenario
fi

step "OWNER removes CONTRIB: epoch 1 is burned, and the rotation dies right after"
DASH_FORGE_TEST_FAULT=after-burn-anchor dg_as "$ID_OWNER" -y --json collab remove "$REPO" "$IDID_CONTRIB" >"$LOG-rm.json" 2>"$LOG-rm.err" || true
if grep -q "test fault injected at after-burn-anchor" "$LOG-rm.err" "$LOG-rm.json"; then
  ok "CONTRIB removed; epoch 1 anchored burned, then the rotation stopped"
else
  cat "$LOG-rm.err" "$LOG-rm.json" >&2
  is_flake "$LOG-rm.err" && skip_scenario "removal failed on a flake"
  bad "the removal did not reach the burned anchor"; finish_scenario
fi

step "COLLAB sees the burned epoch and repairs it"
if dg_read_retry "$ID_COLLAB" "$LOG-st1.json" "$LOG-st1.err" --json repo keys status "$REPO"; then
  [[ "$(json_field "$LOG-st1.json" 'd["currentEpoch"]')" == 1 ]] && ok "current epoch 1" || bad "status epoch: $(json_field "$LOG-st1.json" 'd["currentEpoch"]')"
  [[ "$(json_field "$LOG-st1.json" 'd["burnedBy"]')" == "$IDID_OWNER" ]] && ok "burned by OWNER, as COLLAB sees it" || bad "burnedBy: $(json_field "$LOG-st1.json" 'd["burnedBy"]')"
  [[ "$(json_field "$LOG-st1.json" 'd["repair"]["rotate"]')" == True ]] && ok "repair says rotate" || bad "repair does not say rotate"
else
  cat "$LOG-st1.err" >&2; bad "COLLAB's keys status failed"
fi
if dg_as "$ID_COLLAB" -y --json repo keys repair "$REPO" >"$LOG-rep.json" 2>"$LOG-rep.err"; then
  EPOCH="$(json_field "$LOG-rep.json" 'd["rotated"]["epoch"]')"
  WON="$(json_field "$LOG-rep.json" 'd["rotated"]["won"]')"
  [[ "$EPOCH" == 2 && "$WON" == True ]] && ok "COLLAB rotated past the burn to epoch 2" || bad "repair: epoch=$EPOCH won=$WON"
else
  cat "$LOG-rep.err" "$LOG-rep.json" >&2
  is_flake "$LOG-rep.err" && skip_scenario "repair failed on a flake"
  bad "COLLAB's repair failed"; finish_scenario
fi

step "OWNER pushes under epoch 2"
printf 'after repair %s\n' "$RUN_ID" >"$SRC/secret-after.txt"
git -C "$SRC" add -A && git -C "$SRC" commit -q -m "post-repair ${RUN_ID}"
TIP2="$(git -C "$SRC" rev-parse HEAD)"
if git_dash_retry "$ID_OWNER" "$LOG-push2" -C "$SRC" push "$REMOTE" "refs/heads/main:refs/heads/main"; then
  ok "pushed main @ ${TIP2:0:12} under epoch 2"
else
  cat "$LOG-push2.err" >&2
  is_flake "$LOG-push2.err" && skip_scenario "post-repair push failed on a flake"
  bad "post-repair push failed"; finish_scenario
fi

step "CONTRIB (holding only epoch 0's key) is refused; OWNER and COLLAB read every epoch"
if git_dash "$ID_CONTRIB" "$LOG-cw" clone "$REMOTE" "${WORKROOT}/s16-contrib"; then
  bad "the removed writer cloned after the repair"
elif grep -qE 'E307|E310' "$LOG-cw.err"; then
  ok "removed writer refused ($(grep -oE 'E3(07|10)' "$LOG-cw.err" | head -1))"
else
  cat "$LOG-cw.err" >&2
  is_flake "$LOG-cw.err" && skip_scenario "removed-writer clone failed on a flake"
  bad "removed-writer clone failed without E307/E310"
fi
for who in OWNER COLLAB; do
  idf="ID_${who}"
  dest="${WORKROOT}/s16-clone-${who}"
  if _retry "$LOG-c-$who.err" git_dash "${!idf}" "$LOG-c-$who" clone "$REMOTE" "$dest" \
      && [[ "$(git -C "$dest" rev-parse HEAD)" == "$TIP2" ]] \
      && git -C "$dest" cat-file -e "${TIP}^{commit}"; then
    ok "$who clones main @ ${TIP2:0:12} with epoch 0's commit (chain skips the burned epoch)"
  else
    cat "$LOG-c-$who.err" >&2; bad "$who clone after the repair"
  fi
done
if dg_read_retry "$ID_OWNER" "$LOG-st2.json" "$LOG-st2.err" --json repo keys status "$REPO"; then
  [[ "$(json_field "$LOG-st2.json" 'd["currentEpoch"]')" == 2 ]] && ok "current epoch 2" || bad "status epoch after repair"
  [[ "$(json_field "$LOG-st2.json" 'len(d["alerts"])')" == 0 ]] && ok "no alerts" || bad "alerts: $(json_field "$LOG-st2.json" 'd["alerts"]')"
  [[ "$(json_field "$LOG-st2.json" 'd["repair"]["rotate"] or len(d["repair"]["missingWraps"])>0')" == False ]] && ok "nothing to repair" || bad "repair pending"
else
  cat "$LOG-st2.err" >&2; bad "keys status failed"
fi

finish_scenario
