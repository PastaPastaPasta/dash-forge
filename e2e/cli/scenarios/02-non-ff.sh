#!/usr/bin/env bash
# Scenario 2: Non-fast-forward refused. Push a base tip, rewrite it (amend → a tip
# that is NOT a descendant of the remote), push without `+` → rejected; push with
# `+`/--force → accepted and the remote advances to the rewritten tip.
SCENARIO_NAME="02 non-fast-forward refused"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

BR="e2e/${RUN_ID}/nonff"
SRC="${WORKROOT}/s02-src"
LOG="${WORKROOT}/s02"

step "seed + push base tip (branch ${BR})  (DEPLOYER)"
A="$(seed_tiny_repo "$SRC" "$BR")"
if ! git_dash_retry "$ID_DEPLOYER" "$LOG-base" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
  cat "$LOG-base.err" >&2 || true
  is_flake "$LOG-base.err" && skip_scenario "base push failed on a transport flake"
  grep -qiE 'insufficient|balance' "$LOG-base.err" && skip_scenario "DEPLOYER out of credits"
  bad "base push failed"; finish_scenario
fi
register_ref "refs/heads/${BR}"
ok "base tip pushed (${A})"

step "rewrite history (amend → non-descendant tip)"
printf 'rewritten %s\n' "${RUN_ID}" >"$SRC/alpha.txt"
git -C "$SRC" add -A
git -C "$SRC" commit -q --amend --no-edit
B="$(git -C "$SRC" rev-parse HEAD)"
check "amended tip differs from base" bash -c "[[ '$A' != '$B' ]]"
check "amended tip is NOT a descendant of base" \
  bash -c "! git -C '$SRC' merge-base --is-ancestor '$A' '$B'"

step "push WITHOUT + (expect rejection)"
if git_dash "$ID_DEPLOYER" "$LOG-noff" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
  bad "non-fast-forward push was ACCEPTED (should be rejected)"
else
  if is_flake "$LOG-noff.err"; then
    skip_scenario "could not evaluate reject — transport flake on the reject push"
  fi
  if grep -qiE 'non-fast-forward|rejected|fetch first|not a fast.?forward|behind' "$LOG-noff.err"; then
    ok "non-fast-forward rejected (client-side FF guard)"
  else
    cat "$LOG-noff.err" >&2
    bad "push failed but without a recognizable non-fast-forward reason"
  fi
fi

step "push WITH + (force, expect acceptance)"
if git_dash_retry "$ID_DEPLOYER" "$LOG-force" -C "$SRC" push "$E2E_REMOTE" "+refs/heads/${BR}:refs/heads/${BR}"; then
  ok "force push accepted"
else
  cat "$LOG-force.err" >&2 || true
  is_flake "$LOG-force.err" && skip_scenario "force push failed on a transport flake"
  bad "force push was rejected (should be accepted)"; finish_scenario
fi

step "verify remote advanced to the rewritten tip"
git_dash_retry "$ID_DEPLOYER" "$LOG-ls" ls-remote "$E2E_REMOTE" "refs/heads/${BR}" || true
REMOTE_TIP="$(awk 'NR==1{print $1}' "$LOG-ls.out" 2>/dev/null || echo none)"
check "remote tip == rewritten tip (${B})" assert_eq "$B" "$REMOTE_TIP" "remote tip after force"

finish_scenario
