#!/usr/bin/env bash
# Scenario 7 (S0.9): Shallow fails loudly; partial clone works.
#   * `git clone --depth 1`         -> MUST fail with a clear shallow-unsupported
#     error (never a silent full clone).
#   * `git clone --filter=blob:none` -> MUST succeed and write a `.promisor` marker
#     (lazy blob fetch enabled).
# Read-only: no pushes, no budget.
SCENARIO_NAME="07 shallow fails loudly / partial clone works"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

LOG="${WORKROOT}/s07"

step "git clone --depth 1  (expect a LOUD failure, not a silent full clone)"
D1="${WORKROOT}/s07-depth"; rm -rf "$D1"
if git_dash "$ID_DEPLOYER" "$LOG-depth" clone --depth 1 "$E2E_REMOTE" "$D1"; then
  bad "shallow clone SUCCEEDED — it must fail loudly (silent full clone is the Design-Freeze bug)"
else
  echo "----- --depth stderr (captured) -----" >&2
  cat "$LOG-depth.err" >&2
  echo "-------------------------------------" >&2
  if is_flake "$LOG-depth.err" && ! grep -qiE 'shallow|depth' "$LOG-depth.err"; then
    skip_scenario "depth clone failed on a transport flake (couldn't observe the shallow error)"
  fi
  if grep -qiE 'shallow clone .*not supported|--filter=blob:none for a lightweight|shallow' "$LOG-depth.err"; then
    ok "shallow clone rejected loudly with the expected message"
  else
    bad "clone failed but not with the expected shallow-unsupported error"
  fi
fi
# A silent full clone would have produced a populated worktree; assert it did not.
check "no full worktree was silently produced for --depth" \
  bash -c "[[ ! -d '$D1' ]] || [[ -z \"\$(ls -A '$D1' 2>/dev/null | grep -v '^\\.git$')\" ]]"

step "git clone --filter=blob:none  (expect success + .promisor)"
PC="${WORKROOT}/s07-partial"; rm -rf "$PC"
if git_dash_retry "$ID_DEPLOYER" "$LOG-filter" clone --filter=blob:none "$E2E_REMOTE" "$PC"; then
  ok "partial clone completed"
else
  echo "----- --filter stderr (captured) -----" >&2
  cat "$LOG-filter.err" >&2
  echo "--------------------------------------" >&2
  is_flake "$LOG-filter.err" && skip_scenario "partial clone failed on a transport flake"
  bad "partial clone failed (should succeed)"; finish_scenario
fi

# .promisor marker present (git records the promisor pack for lazy blob fetch).
if ls "$PC"/.git/objects/pack/*.promisor >/dev/null 2>&1; then
  ok ".promisor marker written (lazy blob fetch enabled)"
else
  bad "no .promisor marker found in the partial clone"
fi
check "remote.origin.promisor = true" \
  bash -c "[[ \"\$(git -C '$PC' config remote.origin.promisor 2>/dev/null)\" == true ]]"
check "history present (at least one commit reachable)" \
  bash -c "[[ \"\$(git -C '$PC' rev-list --count HEAD 2>/dev/null || echo 0)\" -ge 1 ]]"
check "partial clone fsck clean" \
  bash -c "git -C '$PC' fsck --connectivity-only >/dev/null 2>&1"

finish_scenario
