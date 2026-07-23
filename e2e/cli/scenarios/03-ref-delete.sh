#!/usr/bin/env bash
# Scenario 3: Ref delete. Push a branch, confirm it is advertised, then push
# `:branch` (zero-oid delete) and confirm it is gone from both ls-remote and a
# fresh clone.
SCENARIO_NAME="03 ref delete"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

BR="e2e/${RUN_ID}/deleteme"
SRC="${WORKROOT}/s03-src"
LOG="${WORKROOT}/s03"

step "seed + push branch ${BR}  (DEPLOYER)"
seed_tiny_repo "$SRC" "$BR" >/dev/null
if ! git_dash_retry "$ID_DEPLOYER" "$LOG-push" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
  cat "$LOG-push.err" >&2 || true
  is_flake "$LOG-push.err" && skip_scenario "push failed on a transport flake"
  grep -qiE 'insufficient|balance' "$LOG-push.err" && skip_scenario "DEPLOYER out of credits"
  bad "push failed"; finish_scenario
fi
register_ref "refs/heads/${BR}"

step "confirm branch is advertised"
git_dash_retry "$ID_DEPLOYER" "$LOG-ls1" ls-remote "$E2E_REMOTE" "refs/heads/${BR}" || true
check "branch present before delete" assert_file_contains "$LOG-ls1.out" "refs/heads/${BR}"

step "delete the ref (push :${BR})"
if ! git_dash_retry "$ID_DEPLOYER" "$LOG-del" -C "$SRC" push "$E2E_REMOTE" ":refs/heads/${BR}"; then
  cat "$LOG-del.err" >&2 || true
  is_flake "$LOG-del.err" && skip_scenario "delete push failed on a transport flake"
  bad "delete push failed"; finish_scenario
fi
ok "delete push accepted"

step "confirm branch is gone (ls-remote)"
git_dash_retry "$ID_DEPLOYER" "$LOG-ls2" ls-remote "$E2E_REMOTE" "refs/heads/${BR}" || true
if [[ -s "$LOG-ls2.out" ]] && grep -q "refs/heads/${BR}" "$LOG-ls2.out"; then
  bad "branch still advertised after delete"
else
  ok "branch no longer advertised"
fi

step "confirm branch is gone in a fresh clone"
CLONE="${WORKROOT}/s03-clone"; rm -rf "$CLONE"
if git_dash_retry "$ID_DEPLOYER" "$LOG-clone" clone "$E2E_REMOTE" "$CLONE"; then
  if git -C "$CLONE" rev-parse --verify -q "refs/remotes/origin/${BR}" >/dev/null 2>&1; then
    bad "deleted branch reappeared in fresh clone"
  else
    ok "deleted branch absent from fresh clone"
  fi
else
  is_flake "$LOG-clone.err" && info "clone flake; ls-remote check already covered the delete"
fi

finish_scenario
