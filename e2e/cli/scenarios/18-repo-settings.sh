#!/usr/bin/env bash
# Scenario 18: repository settings after creation (QA D-503): protected branches, the default
# branch, description/topics, the branch policy and archive — and what each one enforces.
#
#   1. OWNER creates a fresh repo, pushes `main` and `trunk`, adds COLLAB as a writer
#   2. OWNER `dg repo protect add … main`             -> `protect list` shows refs/heads/main
#   3. COLLAB pushes to main                          -> refused by the helper (E601, nothing paid)
#      …and again with the pre-check off              -> refused AT CONSENSUS (the helper routes
#      it to `protectedRefUpdate`, maintainer-only: 40120); main does not move
#   4. COLLAB opens a PR into main and `dg pr merge`s  -> E601 before any git work
#      OWNER `dg pr merge`s it                        -> merged, main moves
#   5. OWNER `dg repo edit --default-branch trunk --description --topics`
#                                                     -> `ls-remote --symref` HEAD is trunk; a
#      rerun writes nothing
#   6. `dg repo policy set` by COLLAB                  -> E601; by OWNER -> `policy show` has it
#   7. OWNER `dg repo archive`                         -> COLLAB's push refused (E606);
#      `dg repo unarchive` clears it
#
# A new repo per run (`e2e-settings-<run-id>`, about 0.02 DASH with its pushes): a protected
# `main` on the shared `e2e-cli` repo would change what every other scenario tests.
SCENARIO_NAME="18 repo settings: protect, default branch, edit, policy, archive (D-503)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

NAME="e2e-settings-${RUN_ID}"
NAME="${NAME:0:63}"
REPO="${E2E_OWNER_ID}/${NAME}"
REMOTE="dash://${REPO}"
SRC="${WORKROOT}/s18-src"
LOG="${WORKROOT}/s18"

jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }
dg_write() { local id="$1" out="$2"; shift 2; dg_as "$id" --yes --json "$@" >"${out}.json" 2>"${out}.err"; }
fail_with() { cat "$1.err" "$1.json" >&2 2>/dev/null; is_flake "$1.err" && skip_scenario "$2 flaked"; bad "$2 failed"; finish_scenario; }
# A dg refusal: exit 6 and the code in the JSON error.
refused_with() { # refused_with <code> <out> -> 0 when the command was refused with <code>
  grep -q "\"code\": *\"$1\"" "$2.json" 2>/dev/null || grep -q "\[$1\]" "$2.err" 2>/dev/null
}
main_tip() { # the remote's refs/heads/main, read as OWNER
  git_dash_retry "$ID_OWNER" "$LOG-ls" ls-remote "$REMOTE" refs/heads/main >/dev/null 2>&1
  cut -f1 "$LOG-ls.out" | head -1
}

step "OWNER creates ${NAME}, pushes main + trunk, adds COLLAB as a writer"
_retry "$LOG-create.err" _dg_read "$ID_OWNER" "$LOG-create.json" "$LOG-create.err" \
  --yes --json repo create "$NAME" --storage platform --description "Dash Forge e2e: repo settings" \
  || fail_with "$LOG-create" "create"
seed_tiny_repo "$SRC" main >/dev/null
git -C "$SRC" branch trunk
BASE="$(git -C "$SRC" rev-parse HEAD)"
git_dash_retry "$ID_OWNER" "$LOG-push0" -C "$SRC" push "$REMOTE" main trunk || fail_with "$LOG-push0" "owner push"
dg_write "$ID_OWNER" "$LOG-add" collab add "$REPO" "$IDID_COLLAB" --role writer || fail_with "$LOG-add" "collab add"
ok "repo ready (main @ ${BASE:0:12}), COLLAB is a writer"

step "OWNER protects main (dg repo protect add)"
dg_write "$ID_OWNER" "$LOG-protect" repo protect add "$REPO" main || fail_with "$LOG-protect" "protect add"
check "protect add reports refs/heads/main" assert_eq "refs/heads/main" "$(jq_py "$LOG-protect.json" '",".join(d["protectedPatterns"])')"
listed=1
for _ in $(seq 1 8); do
  dg_read_retry "$ID_OWNER" "$LOG-plist.json" "$LOG-plist.err" --json repo protect list "$REPO" \
    && [[ "$(jq_py "$LOG-plist.json" '",".join(d["protectedPatterns"])')" == "refs/heads/main" ]] && { listed=0; break; }
  sleep 3
done
check "protect list shows refs/heads/main" test "$listed" -eq 0
dg_write "$ID_OWNER" "$LOG-protect2" repo protect add "$REPO" refs/heads/main || fail_with "$LOG-protect2" "protect add (rerun)"
check "protecting it again writes nothing" assert_eq "unchanged" "$(jq_py "$LOG-protect2.json" 'd["status"]')"

step "COLLAB pushes to main: the helper refuses it (E601, nothing paid)"
printf 'writer change %s\n' "$RUN_ID" >>"$SRC/alpha.txt"
git -C "$SRC" commit -qam "writer change ${RUN_ID}"
if git_dash "$ID_COLLAB" "$LOG-wpush" -C "$SRC" push "$REMOTE" HEAD:refs/heads/main; then
  bad "a writer's push to protected main was ACCEPTED"
elif grep -q 'E601' "$LOG-wpush.err" && is_local_precheck "$LOG-wpush.err" && grep -q 'protected ref: maintainers only' "$LOG-wpush.err"; then
  ok "refused before building: E601, protected ref: maintainers only"
else
  cat "$LOG-wpush.err" >&2; is_flake "$LOG-wpush.err" && skip_scenario "writer push flaked"
  bad "the writer's push failed without the protected-ref E601"
fi

step "…and with the pre-check off it is refused AT CONSENSUS (protectedRefUpdate is maintainer-only)"
if DASH_FORGE_SKIP_WRITE_PRECHECK=1 git_dash_retry "$ID_COLLAB" "$LOG-wpush2" -C "$SRC" push "$REMOTE" HEAD:refs/heads/main; then
  bad "the writer's protected push landed at consensus"
elif grep -q '40120' "$LOG-wpush2.err" && grep -q 'protectedRefUpdate' "$LOG-wpush2.err" && grep -q 'E601' "$LOG-wpush2.err"; then
  ok "consensus refused the protectedRefUpdate (40120 → E601)"
else
  cat "$LOG-wpush2.err" >&2; is_flake "$LOG-wpush2.err" && skip_scenario "bypassed push flaked"
  bad "no consensus refusal of the writer's protectedRefUpdate"
fi
check "main did not move" assert_eq "$BASE" "$(main_tip)"

step "COLLAB opens a PR into main; COLLAB's merge is refused, OWNER's lands"
FEATURE="e2e/${RUN_ID}/feature"
git_dash_retry "$ID_COLLAB" "$LOG-fpush" -C "$SRC" push "$REMOTE" "HEAD:refs/heads/${FEATURE}" || fail_with "$LOG-fpush" "feature push"
HEAD_OID="$(git -C "$SRC" rev-parse HEAD)"
( cd "$SRC" && dg_write "$ID_COLLAB" "$LOG-pr" pr create "$REPO" --base main --head "$FEATURE" --head-repo "$REPO" --title "settings e2e ${RUN_ID}" ) \
  || fail_with "$LOG-pr" "pr create"
N="$(jq_py "$LOG-pr.json" 'd["number"]')"
if dg_write "$ID_COLLAB" "$LOG-wmerge" pr merge "$REPO" "$N"; then
  bad "a writer merged into protected main"
elif refused_with E601 "$LOG-wmerge" && grep -q 'before fetching' "$LOG-wmerge.json" "$LOG-wmerge.err" 2>/dev/null; then
  ok "writer's merge refused before any git work (E601)"
else
  cat "$LOG-wmerge.err" "$LOG-wmerge.json" >&2; is_flake "$LOG-wmerge.err" && skip_scenario "writer merge flaked"
  bad "writer's merge failed without the protected-base E601"
fi
dg_write "$ID_OWNER" "$LOG-omerge" pr merge "$REPO" "$N" || fail_with "$LOG-omerge" "maintainer merge"
check "the maintainer's merge lands" assert_eq "True" "$(jq_py "$LOG-omerge.json" 'd["merged"]')"
moved=1; for _ in $(seq 1 8); do [[ "$(main_tip)" == "$HEAD_OID" ]] && { moved=0; break; }; sleep 3; done
check "main is the PR head (a protectedRefUpdate by the maintainer)" test "$moved" -eq 0

step "OWNER changes the default branch, description and topics (dg repo edit)"
dg_write "$ID_OWNER" "$LOG-edit" repo edit "$REPO" --default-branch trunk --description "settings e2e ${RUN_ID}" --topics "e2e,settings" \
  || fail_with "$LOG-edit" "repo edit"
check "edit reports trunk" assert_eq "trunk" "$(jq_py "$LOG-edit.json" 'd["defaultBranch"]')"
check "edit replaced the repo document" assert_eq "True" "$(jq_py "$LOG-edit.json" 'd["repoEdited"]')"
head_ok=1
for _ in $(seq 1 8); do
  git_dash_retry "$ID_OWNER" "$LOG-sym" ls-remote --symref "$REMOTE" HEAD >/dev/null 2>&1
  grep -q '^ref: refs/heads/trunk[[:space:]]HEAD' "$LOG-sym.out" && { head_ok=0; break; }
  sleep 3
done
check "a clone's HEAD is now trunk (ls-remote --symref)" test "$head_ok" -eq 0
dg_write "$ID_OWNER" "$LOG-edit2" repo edit "$REPO" --default-branch refs/heads/trunk --description "settings e2e ${RUN_ID}" --topics "e2e, settings" \
  || fail_with "$LOG-edit2" "repo edit (rerun)"
check "the same edit again writes nothing" assert_eq "unchanged" "$(jq_py "$LOG-edit2.json" 'd["status"]')"
dg_write "$ID_COLLAB" "$LOG-wedit" repo edit "$REPO" --description "not mine"
check "a writer cannot edit the repo document (E601)" refused_with E601 "$LOG-wedit"

step "the branch policy: a writer is refused, the maintainer sets it"
dg_write "$ID_COLLAB" "$LOG-wpol" repo policy set "$REPO" --required-approvals 1
check "writer's policy set refused (E601)" refused_with E601 "$LOG-wpol"
dg_write "$ID_OWNER" "$LOG-pol" repo policy set "$REPO" --required-approvals 2 --maintainers-only true --merge-methods ff,squash \
  || fail_with "$LOG-pol" "policy set"
shown=1
for _ in $(seq 1 8); do
  dg_read_retry "$ID_OWNER" "$LOG-pshow.json" "$LOG-pshow.err" --json repo policy show "$REPO" \
    && [[ "$(jq_py "$LOG-pshow.json" 'd["policy"]["requiredApprovals"], d["policy"]["maintainersOnly"], ",".join(d["policy"]["mergeMethods"])')" == "2 True ff,squash" ]] \
    && { shown=0; break; }
  sleep 3
done
check "policy show: 2 approvals, maintainers only, ff+squash" test "$shown" -eq 0
check "policy show says it is a client rule" grep -q 'nothing at consensus requires approvals' "$LOG-pshow.json"

step "archive: the helper refuses a member's push (E606); unarchive clears it"
dg_write "$ID_OWNER" "$LOG-arch" repo archive "$REPO" || fail_with "$LOG-arch" "archive"
check "archived" assert_eq "archived" "$(jq_py "$LOG-arch.json" 'd["status"]')"
refused=1
for _ in $(seq 1 6); do
  if ! git_dash "$ID_COLLAB" "$LOG-apush" -C "$SRC" push "$REMOTE" "HEAD:refs/heads/${FEATURE}-2" && grep -q 'E606' "$LOG-apush.err"; then
    refused=0; break
  fi
  sleep 3
done
check "COLLAB's push to the archived repo is refused with E606" test "$refused" -eq 0
check "the refusal names the override" grep -q 'allow-archived' "$LOG-apush.err"
dg_write "$ID_OWNER" "$LOG-unarch" repo unarchive "$REPO" || fail_with "$LOG-unarch" "unarchive"
check "unarchived" assert_eq "unarchived" "$(jq_py "$LOG-unarch.json" 'd["status"]')"

step "OWNER unprotects main (dg repo protect remove)"
dg_write "$ID_OWNER" "$LOG-unprot" repo protect remove "$REPO" main || fail_with "$LOG-unprot" "protect remove"
check "no protected patterns left" assert_eq "" "$(jq_py "$LOG-unprot.json" '",".join(d["protectedPatterns"])')"

finish_scenario
