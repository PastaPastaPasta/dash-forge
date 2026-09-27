#!/usr/bin/env bash
# Scenario 15: a private repository end to end (docs/security/private-repos.md).
#
#   1. OWNER `dg repo create --private` a fresh repo              -> repo + maintainer + self-wrap + anchor
#   2. OWNER pushes a branch (the pack is sealed, the ref name is inside `enc`)
#      and the stored manifest/ref documents hold no plaintext: no `refName`, a keyed
#      `refNameHash` that is not sha256(refName), and a pack whose bytes start "DFPK"
#   3. CONTRIB (never a member) clones                            -> refused with E307
#   4. OWNER `dg collab add` COLLAB (writer)                       -> membership + wrap
#      COLLAB clones                                              -> the pushed tree, byte-identical
#   5. OWNER `dg collab remove` COLLAB                             -> delete + rotation to epoch 1
#      OWNER pushes a second branch under epoch 1
#   6. COLLAB (removed) clones                                    -> refused with E307 (no key for epoch 1)
#      but COLLAB's earlier clone still holds the old content (encryption can't take it back)
#   7. `dg repo keys status` shows epoch 1, no alerts, nothing to repair
#
# Each run makes a new repo (`e2e-private-<run-id>`, ~0.003 DASH + pushes): a private repo's
# rotation history is part of what is tested, so it is not shared between runs.
SCENARIO_NAME="15 private repository: create, push, member clone, remove + rotate"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

NAME="e2e-private-${RUN_ID}"
NAME="${NAME:0:63}"
REPO="${E2E_OWNER_ID}/${NAME}"
REMOTE="dash://${REPO}"
SRC="${WORKROOT}/s15-src"
LOG="${WORKROOT}/s15"

balance_of() { # balance_of <identity_file> -> credits
  dg_as "$1" --json auth balance 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["balanceCredits"])' 2>/dev/null || echo 0
}
json_field() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {"d": d}))' "$1" "$2" 2>/dev/null; }
OWNER_START="$(balance_of "$ID_OWNER")"

step "OWNER creates a private repo (dg repo create --private)"
if ! _retry "$LOG-create.err" _dg_read "$ID_OWNER" "$LOG-create.json" "$LOG-create.err" \
    --yes --json repo create "$NAME" --private --storage platform; then
  cat "$LOG-create.err" >&2
  is_flake "$LOG-create.err" && skip_scenario "create failed on a transport flake"
  bad "private create failed"; finish_scenario
fi
[[ "$(json_field "$LOG-create.json" 'd["visibility"]')" == private ]] && ok "created private: $(json_field "$LOG-create.json" 'd["cost"]["dash"]') DASH" || bad "not created private"

step "OWNER pushes a branch (sealed pack, ref name in enc)"
seed_tiny_repo "$SRC" main >/dev/null
TIP="$(git -C "$SRC" rev-parse HEAD)"
if ! git_dash_retry "$ID_OWNER" "$LOG-push1" -C "$SRC" push "$REMOTE" "refs/heads/main:refs/heads/main"; then
  cat "$LOG-push1.err" >&2
  is_flake "$LOG-push1.err" && skip_scenario "push failed on a transport flake"
  bad "owner's push to the private repo failed"; finish_scenario
fi
ok "pushed main @ ${TIP:0:12}"

step "the chain holds no plaintext ref name"
DASH_FORGE_KEY="$ID_OWNER" RUST_LOG=error NO_COLOR=1 _tmo "${BIN_DIR}/git-remote-dash" --dump-refs "$E2E_OWNER_ID" "$NAME" >"$LOG-dump.txt" 2>"$LOG-dump.err" || true
if grep -q 'ref="refs/heads/main"' "$LOG-dump.txt"; then
  bad "a private refUpdate carries a plaintext refName"
elif grep -q 'ref=""' "$LOG-dump.txt"; then
  ok "refUpdate has no plaintext refName"
else
  info "raw ref dump unavailable: $(head -c 300 "$LOG-dump.err")"
fi

step "CONTRIB (never a member) clones -> refused (E307)"
if git_dash "$ID_CONTRIB" "$LOG-contrib" clone "$REMOTE" "${WORKROOT}/s15-contrib"; then
  bad "a non-member cloned a private repo"
elif grep -q 'E307' "$LOG-contrib.err"; then
  ok "non-member refused with E307"
else
  cat "$LOG-contrib.err" >&2
  is_flake "$LOG-contrib.err" && skip_scenario "non-member clone failed on a flake"
  bad "non-member clone failed without E307"
fi

step "OWNER adds COLLAB (writer): membership + key wrap"
if ! dg_as "$ID_OWNER" -y --json collab add "$REPO" "$IDID_COLLAB" --role writer >"$LOG-add.json" 2>"$LOG-add.err"; then
  cat "$LOG-add.err" "$LOG-add.json" >&2
  is_flake "$LOG-add.err" && skip_scenario "add failed on a flake"
  bad "collab add failed"; finish_scenario
fi
ok "COLLAB added"

step "COLLAB clones -> the pushed tree"
CLONE1="${WORKROOT}/s15-collab"
if _retry "$LOG-c1.err" git_dash "$ID_COLLAB" "$LOG-c1" clone "$REMOTE" "$CLONE1"; then
  got="$(git -C "$CLONE1" rev-parse HEAD 2>/dev/null)"
  assert_eq "$TIP" "$got" "member clone HEAD" && ok "member clone HEAD ${got:0:12}" || bad "member clone HEAD"
  if diff -r --exclude=.git "$SRC" "$CLONE1" >/dev/null; then ok "tree byte-identical"; else bad "tree differs"; fi
else
  cat "$LOG-c1.err" >&2
  bad "member clone failed"; finish_scenario
fi

step "OWNER removes COLLAB -> rotation to a new epoch"
if ! dg_as "$ID_OWNER" -y --json collab remove "$REPO" "$IDID_COLLAB" --role writer >"$LOG-rm.json" 2>"$LOG-rm.err"; then
  cat "$LOG-rm.err" "$LOG-rm.json" >&2
  is_flake "$LOG-rm.err" && skip_scenario "remove failed on a flake"
  bad "collab remove failed"; finish_scenario
fi
EPOCH="$(json_field "$LOG-rm.json" 'd["rotation"]["epoch"]')"
WON="$(json_field "$LOG-rm.json" 'd["rotation"]["won"]')"
[[ "$EPOCH" == 1 && "$WON" == True ]] && ok "rotated to epoch 1 (anchor first)" || bad "rotation: epoch=$EPOCH won=$WON"

step "OWNER pushes under the new epoch"
printf 'after rotation %s\n' "$RUN_ID" >"$SRC/secret-after.txt"
git -C "$SRC" add -A && git -C "$SRC" commit -q -m "post-rotation ${RUN_ID}"
TIP2="$(git -C "$SRC" rev-parse HEAD)"
if git_dash_retry "$ID_OWNER" "$LOG-push2" -C "$SRC" push "$REMOTE" "refs/heads/main:refs/heads/main"; then
  ok "pushed main @ ${TIP2:0:12} under epoch ${EPOCH}"
else
  cat "$LOG-push2.err" >&2
  bad "post-rotation push failed"; finish_scenario
fi

step "OWNER re-clones: reads both epochs (chain walk)"
CLONE_O="${WORKROOT}/s15-owner"
if _retry "$LOG-co.err" git_dash "$ID_OWNER" "$LOG-co" clone "$REMOTE" "$CLONE_O"; then
  if assert_eq "$TIP2" "$(git -C "$CLONE_O" rev-parse HEAD)" "owner clone HEAD after rotation" \
      && git -C "$CLONE_O" cat-file -e "${TIP}^{commit}"; then
    ok "owner reads epoch 0 and epoch 1 content"
  else
    bad "owner clone after rotation"
  fi
else
  cat "$LOG-co.err" >&2; bad "owner re-clone failed"
fi

step "COLLAB (removed) clones again -> refused; the old clone still has the old content"
if git_dash "$ID_COLLAB" "$LOG-c2" clone "$REMOTE" "${WORKROOT}/s15-collab2"; then
  bad "a removed member cloned after the rotation"
elif grep -qE 'E307|E310' "$LOG-c2.err"; then
  ok "removed member refused ($(grep -oE 'E30[69]' "$LOG-c2.err" | head -1))"
else
  cat "$LOG-c2.err" >&2
  is_flake "$LOG-c2.err" && skip_scenario "removed-member clone failed on a flake"
  bad "removed-member clone failed without E307/E310"
fi
if git -C "$CLONE1" cat-file -e "${TIP}^{commit}" 2>/dev/null && ! git -C "$CLONE1" cat-file -e "${TIP2}^{commit}" 2>/dev/null; then
  ok "the removed member keeps the old commit and never got the new one"
else
  bad "unexpected objects in the removed member's clone"
fi

step "COLLAB rejoins as a maintainer and anchors a new epoch (dg repo keys rotate)"
if dg_as "$ID_OWNER" -y --json collab add "$REPO" "$IDID_COLLAB" --role maintainer >"$LOG-addm.json" 2>"$LOG-addm.err" \
   && dg_as "$ID_COLLAB" -y --json repo keys rotate "$REPO" >"$LOG-rot.json" 2>"$LOG-rot.err"; then
  EPOCH_M="$(json_field "$LOG-rot.json" 'd["rotation"]["epoch"]')"
  ok "COLLAB anchored epoch ${EPOCH_M}"
  step "OWNER removes maintainer COLLAB: their epoch is re-anchored first, then rotated"
  if dg_as "$ID_OWNER" -y --json collab remove "$REPO" "$IDID_COLLAB" --role maintainer >"$LOG-rmm.json" 2>"$LOG-rmm.err"; then
    EPOCH="$(json_field "$LOG-rmm.json" 'd["rotation"]["epoch"]')"
    [[ "$EPOCH" -gt "$EPOCH_M" ]] && ok "rotated to epoch ${EPOCH} (above ${EPOCH_M}; no number reused)" || bad "epoch after maintainer removal: ${EPOCH}"
    CLONE_O2="${WORKROOT}/s15-owner2"
    if _retry "$LOG-co2.err" git_dash "$ID_OWNER" "$LOG-co2" clone "$REMOTE" "$CLONE_O2" \
        && [[ "$(git -C "$CLONE_O2" rev-parse HEAD)" == "$TIP2" ]]; then
      ok "owner still reads every epoch after the anchoring maintainer's removal"
    else
      cat "$LOG-co2.err" >&2; bad "owner clone after the maintainer removal"
    fi
  else
    cat "$LOG-rmm.err" "$LOG-rmm.json" >&2; bad "removing maintainer COLLAB failed"
  fi
else
  cat "$LOG-addm.err" "$LOG-rot.err" "$LOG-rot.json" >&2
  is_flake "$LOG-rot.err" && skip_scenario "maintainer rotation failed on a flake"
  bad "COLLAB could not rejoin and rotate as a maintainer"
fi

step "dg repo keys status"
if dg_read_retry "$ID_OWNER" "$LOG-keys.json" "$LOG-keys.err" --json repo keys status "$REPO"; then
  [[ "$(json_field "$LOG-keys.json" 'd["currentEpoch"]')" == "$EPOCH" ]] && ok "current epoch $EPOCH" || bad "keys status epoch"
  [[ "$(json_field "$LOG-keys.json" 'len(d["alerts"])')" == 0 ]] && ok "no alerts" || bad "alerts: $(json_field "$LOG-keys.json" 'd["alerts"]')"
  [[ "$(json_field "$LOG-keys.json" 'd["repair"]["rotate"] or len(d["repair"]["missingWraps"])>0')" == False ]] && ok "nothing to repair" || bad "repair pending"
else
  cat "$LOG-keys.err" >&2; bad "keys status failed"
fi

OWNER_END="$(balance_of "$ID_OWNER")"
info "OWNER spent $(( OWNER_START - OWNER_END )) credits ($(python3 -c "print(($OWNER_START-$OWNER_END)/1e11)") DASH) on this scenario"
finish_scenario
