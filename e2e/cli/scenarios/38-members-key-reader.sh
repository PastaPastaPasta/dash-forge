#!/usr/bin/env bash
# Scenario 38: members-only content in a PUBLIC repository: adding and removing a reader
# (docs/security/private-repos.md §17, DESIGN mixed-visibility stream 1F).
#
#   1. OWNER `dg repo create` a fresh PUBLIC repo and pushes main (its settings stay plaintext)
#   2. OWNER `dg repo members enable`                     -> epoch 0: settings-free anchor
#      `dg repo protect list` / the default branch read as before (the anchor is not a setting)
#   3. COLLAB accepts; OWNER `dg collab add --role reader` -> membership + key wrap
#      `dg repo keys status` lists no member without a wrap
#   4. OWNER `dg collab remove` the reader               -> delete + rotation to epoch 1
#      `dg repo keys status`: current epoch 1, nothing to repair, no alerts
#   5. CONTRIB (never a member) `dg repo keys status`    -> nothing readable (no error leak)
#
# Each run makes a new repo (`e2e-mkey-<run-id>`, about 0.01 DASH): its key history is what is
# tested, so it is not shared between runs.
SCENARIO_NAME="38 members key in a public repo: enable, add a reader, remove + rotate"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

NAME="e2e-mkey-${RUN_ID}"
NAME="${NAME:0:63}"
REPO="${E2E_OWNER_ID}/${NAME}"
REMOTE="dash://${REPO}"
SRC="${WORKROOT}/s38-src"
LOG="${WORKROOT}/s38"
json_field() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {"d": d}))' "$1" "$2" 2>/dev/null; }

step "OWNER creates a public repo and pushes main"
if ! _retry "$LOG-create.err" _dg_read "$ID_OWNER" "$LOG-create.json" "$LOG-create.err" \
    --yes --json repo create "$NAME" --storage platform; then
  cat "$LOG-create.err" >&2
  is_flake "$LOG-create.err" && skip_scenario "create failed on a transport flake"
  bad "public create failed"; finish_scenario
fi
[[ "$(json_field "$LOG-create.json" 'd["visibility"]')" == public ]] && ok "created public" || bad "not created public"
seed_tiny_repo "$SRC" main >/dev/null
if ! git_dash_retry "$ID_OWNER" "$LOG-push" -C "$SRC" push "$REMOTE" "refs/heads/main:refs/heads/main"; then
  cat "$LOG-push.err" >&2
  is_flake "$LOG-push.err" && skip_scenario "push failed on a transport flake"
  bad "owner's push failed"; finish_scenario
fi
ok "pushed main"

step "OWNER turns members-only content on (dg repo members enable)"
if ! dg_as "$ID_OWNER" -y --json repo members enable "$REPO" >"$LOG-enable.json" 2>"$LOG-enable.err"; then
  cat "$LOG-enable.err" "$LOG-enable.json" >&2
  is_flake "$LOG-enable.err" && skip_scenario "enable failed on a flake"
  bad "members enable failed"; finish_scenario
fi
[[ "$(json_field "$LOG-enable.json" 'd["status"]')" == enabled ]] && ok "members-only content on" || bad "enable status: $(cat "$LOG-enable.json")"
if dg_read_retry "$ID_OWNER" "$LOG-view.json" "$LOG-view.err" --json repo view "$REPO" \
    && [[ "$(json_field "$LOG-view.json" 'd["defaultBranch"]')" == main ]]; then
  ok "the default branch still reads from the plaintext config"
else
  cat "$LOG-view.err" "$LOG-view.json" >&2; bad "the settings changed after enable"
fi

step "COLLAB accepts; OWNER adds COLLAB as a reader (membership + key wrap)"
if ! collab_accept "$ID_COLLAB" "$REPO" "$LOG-add" \
   || ! dg_as "$ID_OWNER" -y --json collab add "$REPO" "$IDID_COLLAB" --role reader >"$LOG-add.json" 2>"$LOG-add.err"; then
  cat "$LOG-add.err" "$LOG-add.json" >&2
  is_flake "$LOG-add.err" && skip_scenario "add failed on a flake"
  bad "collab add --role reader failed"; finish_scenario
fi
[[ "$(json_field "$LOG-add.json" 'd["keyShared"]')" == True ]] && ok "reader added; key shared" || bad "reader added without the key: $(cat "$LOG-add.json")"
if dg_read_retry "$ID_OWNER" "$LOG-keys1.json" "$LOG-keys1.err" --json repo keys status "$REPO"; then
  [[ "$(json_field "$LOG-keys1.json" 'd["currentEpoch"]')" == 0 ]] && ok "current epoch 0" || bad "epoch after enable"
  [[ "$(json_field "$LOG-keys1.json" '(d["repair"] or {}).get("missingWraps", [])')" == "[]" ]] && ok "every member holds a wrap" || bad "missing wraps: $(json_field "$LOG-keys1.json" 'd["repair"]')"
else
  cat "$LOG-keys1.err" >&2; bad "keys status failed"
fi

step "OWNER removes the reader -> rotation to epoch 1"
if ! dg_as "$ID_OWNER" -y --json collab remove "$REPO" "$IDID_COLLAB" --role reader >"$LOG-rm.json" 2>"$LOG-rm.err"; then
  cat "$LOG-rm.err" "$LOG-rm.json" >&2
  is_flake "$LOG-rm.err" && skip_scenario "remove failed on a flake"
  bad "collab remove failed"; finish_scenario
fi
EPOCH="$(json_field "$LOG-rm.json" 'd["rotation"]["epoch"]')"
WON="$(json_field "$LOG-rm.json" 'd["rotation"]["won"]')"
[[ "$EPOCH" == 1 && "$WON" == True ]] && ok "rotated to epoch 1 (the reader holds no key for it)" || bad "rotation: epoch=$EPOCH won=$WON"
if dg_read_retry "$ID_OWNER" "$LOG-keys2.json" "$LOG-keys2.err" --json repo keys status "$REPO"; then
  [[ "$(json_field "$LOG-keys2.json" 'd["currentEpoch"]')" == 1 ]] && ok "current epoch 1" || bad "keys status epoch"
  [[ "$(json_field "$LOG-keys2.json" 'len(d["alerts"])')" == 0 ]] && ok "no alerts" || bad "alerts: $(json_field "$LOG-keys2.json" 'd["alerts"]')"
  [[ "$(json_field "$LOG-keys2.json" 'd["repair"] is None or not (d["repair"]["rotate"] or d["repair"]["missingWraps"])')" == True ]] && ok "nothing to repair" || bad "repair pending"
else
  cat "$LOG-keys2.err" >&2; bad "keys status failed"
fi

step "CONTRIB (never a member) reads the members status: nothing readable, no error"
if dg_read_retry "$ID_CONTRIB" "$LOG-st.json" "$LOG-st.err" --json repo members status "$REPO"; then
  [[ "$(json_field "$LOG-st.json" 'd["on"] and not d["youCanRead"]')" == True ]] && ok "on, and not readable to a non-member" || bad "members status: $(cat "$LOG-st.json")"
else
  cat "$LOG-st.err" >&2; bad "members status failed for a non-member"
fi

finish_scenario
