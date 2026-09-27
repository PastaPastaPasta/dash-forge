#!/usr/bin/env bash
# Scenario 16: a ref forced back to an earlier tip, and a PR's base must exist.
#
#   1. D-600: push A, fast-forward to B, force back to A, fast-forward to B again. After each
#      push `ls-remote` and a fresh clone show the pushed tip, never "deleted"/unborn (the
#      old fold let the stale A → B update's prevOid override the clock).
#   2. D-501: `dg pr create --base <a branch that does not exist>` is refused before anything
#      is written (E102), and so is a base that has been deleted.
#   3. D-501: a PR opened against an existing base whose branch is then deleted: `dg pr merge`
#      refuses to push (it would re-create the branch) and writes nothing.
SCENARIO_NAME="16 ref forced back to an earlier tip; a PR's base must exist"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
[[ -n "${HARNESS_SHARED:-}" ]] || harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
BR="e2e/${RUN_ID}/aba"
BASE="e2e/${RUN_ID}/pr-base"
FEAT="e2e/${RUN_ID}/pr-feature"
SRC="${WORKROOT}/s16-src"
LOG="${WORKROOT}/s16"

jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }
dg_write() { local id="$1" out="$2"; shift 2; dg_as "$id" --yes --json "$@" >"${out}.json" 2>"${out}.err"; }
fail_with() { cat "$1.err" "$1.json" >&2 2>/dev/null; is_flake "$1.err" && skip_scenario "$2 flaked"; bad "$2 failed"; finish_scenario; }
push() { # push <log> <refspec>
  git_dash_retry "$ID_OWNER" "$1" -C "$SRC" push "$E2E_REMOTE" "$2" || fail_with "$1" "push $2"
}
remote_tip() { # remote_tip <log> <ref>: the advertised tip, or "missing"
  git_dash_retry "$ID_OWNER" "$1" ls-remote "$E2E_REMOTE" "$2" || fail_with "$1" "ls-remote"
  local t; t="$(awk 'NR==1{print $1}' "$1.out")"; echo "${t:-missing}"
}
# The code of a refused dg --json write, or "none" when it was not refused.
refusal() { # refusal <log>
  python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print("none"); sys.exit()
print(d.get("error",{}).get("code","none"))' "$1.json"
}

step "D-600: A → B → force A → B on ${BR}"
A="$(seed_tiny_repo "$SRC" "$BR")"
push "$LOG-a" "refs/heads/${BR}:refs/heads/${BR}"
register_ref "refs/heads/${BR}"
printf 'second %s\n' "$RUN_ID" >"$SRC/alpha.txt"
git -C "$SRC" commit -qam "B ${RUN_ID}"
B="$(git -C "$SRC" rev-parse HEAD)"
push "$LOG-b" "refs/heads/${BR}:refs/heads/${BR}"
check "after A → B the ref is at B" assert_eq "$B" "$(remote_tip "$LOG-ls1" "refs/heads/${BR}")"

push "$LOG-back" "+${A}:refs/heads/${BR}"
check "force back to A reads A (not deleted)" assert_eq "$A" "$(remote_tip "$LOG-ls2" "refs/heads/${BR}")"
CL="${WORKROOT}/s16-clone"
git_dash_retry "$ID_OWNER" "$LOG-clone" clone -q --no-checkout -b "$BR" "$E2E_REMOTE" "$CL" || fail_with "$LOG-clone" "clone after force back"
check "a fresh clone checks out A" assert_eq "$A" "$(git -C "$CL" rev-parse HEAD)"

push "$LOG-fwd" "${B}:refs/heads/${BR}"
check "fast-forward to B again reads B" assert_eq "$B" "$(remote_tip "$LOG-ls3" "refs/heads/${BR}")"

step "D-501: pr create refuses a base that does not exist"
git -C "$SRC" checkout -q -b "$FEAT"
printf 'feature %s\n' "$RUN_ID" >"$SRC/feature.txt"
git -C "$SRC" add feature.txt
git -C "$SRC" commit -qm "feature ${RUN_ID}"
push "$LOG-feat" "refs/heads/${FEAT}:refs/heads/${FEAT}"
register_ref "refs/heads/${FEAT}"
( cd "$SRC" && dg_write "$ID_OWNER" "$LOG-nobase" pr create "$REPO" --head "$FEAT" --base "e2e/${RUN_ID}/does-not-exist" --title "bad base ${RUN_ID}" )
check "refused with E102 before writing" assert_eq "E102" "$(refusal "$LOG-nobase")"
check "the refusal names the missing base" assert_file_contains "$LOG-nobase.json" "is not a branch of"

step "D-501: pr merge refuses to re-create a deleted base"
git -C "$SRC" branch -q -f "$BASE" "$B"
push "$LOG-base" "refs/heads/${BASE}:refs/heads/${BASE}"
register_ref "refs/heads/${BASE}"
( cd "$SRC" && dg_write "$ID_OWNER" "$LOG-pr" pr create "$REPO" --head "$FEAT" --base "$BASE" --title "e2e base check ${RUN_ID}" ) \
  || fail_with "$LOG-pr" "pr create against an existing base"
N="$(jq_py "$LOG-pr.json" 'd["number"]')"
ok "PR #${N} opened against ${BASE}"
push "$LOG-del" ":refs/heads/${BASE}"
check "the base is gone" assert_eq "missing" "$(remote_tip "$LOG-ls4" "refs/heads/${BASE}")"
dg_write "$ID_OWNER" "$LOG-merge" pr merge "$REPO" "$N"
check "merge refused with E102" assert_eq "E102" "$(refusal "$LOG-merge")"
check "the refusal says the base was deleted" assert_file_contains "$LOG-merge.json" "has been deleted"
check "the base was not re-created" assert_eq "missing" "$(remote_tip "$LOG-ls5" "refs/heads/${BASE}")"
( cd "$SRC" && dg_write "$ID_OWNER" "$LOG-deleted" pr create "$REPO" --head "$FEAT" --base "$BASE" --title "deleted base ${RUN_ID}" )
check "pr create refuses the deleted base too" assert_eq "E102" "$(refusal "$LOG-deleted")"

finish_scenario
