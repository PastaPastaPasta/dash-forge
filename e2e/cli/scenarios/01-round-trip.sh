#!/usr/bin/env bash
# Scenario 1 (⭐): Round-trip. DEPLOYER pushes a tiny repo (3 files + annotated tag)
# to a fresh branch on the reused m1 repo, then clones it back into a second dir and
# proves byte-identity: git fsck clean, rev-parse equal, diff -r worktrees identical,
# tag present with matching oid.
SCENARIO_NAME="01 round-trip (⭐)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

BR="e2e/${RUN_ID}/roundtrip"
TAG="e2e-${RUN_ID}-rt"
SRC="${WORKROOT}/s01-src"
CLONE="${WORKROOT}/s01-clone"
LOG="${WORKROOT}/s01"

step "seed tiny source repo (branch ${BR}, tag ${TAG})"
SRC_TIP="$(seed_tiny_repo "$SRC" "$BR" "$TAG")"
SRC_TAG_OID="$(git -C "$SRC" rev-parse "refs/tags/${TAG}")"
info "source tip=${SRC_TIP}"

step "push branch + tag to ${E2E_REMOTE}  (DEPLOYER)"
if ! git_dash_retry "$ID_DEPLOYER" "$LOG-push" \
      -C "$SRC" push "$E2E_REMOTE" \
      "refs/heads/${BR}:refs/heads/${BR}" "refs/tags/${TAG}:refs/tags/${TAG}"; then
  cat "$LOG-push.err" >&2 || true
  if is_flake "$LOG-push.err"; then
    skip_scenario "push failed on a testnet transport/islock flake (funds ok, retry later)"
  fi
  if grep -qiE 'insufficient|InsufficientCredits|balance' "$LOG-push.err"; then
    skip_scenario "DEPLOYER out of testnet credits for the push"
  fi
  bad "push failed unexpectedly (see $LOG-push.err)"; finish_scenario
fi
register_ref "refs/heads/${BR}"
register_ref "refs/tags/${TAG}"
ok "push accepted"

step "clone back into a fresh dir  (independent of the source repo)"
rm -rf "$CLONE"
if ! git_dash_retry "$ID_DEPLOYER" "$LOG-clone" clone "$E2E_REMOTE" "$CLONE"; then
  cat "$LOG-clone.err" >&2 || true
  is_flake "$LOG-clone.err" && skip_scenario "clone failed on a transport flake"
  bad "clone failed (see $LOG-clone.err)"; finish_scenario
fi
ok "clone completed"

step "checkout pushed branch in the clone"
check "clone checks out ${BR}" git -C "$CLONE" checkout -q "$BR"

step "assertions"
# fsck: the whole received object DAG is hash-consistent.
if git -C "$CLONE" fsck --full --strict >"$LOG-fsck.out" 2>&1; then
  ok "git fsck --full --strict clean"
else
  cat "$LOG-fsck.out" >&2; bad "git fsck reported problems"
fi

CLONE_TIP="$(git -C "$CLONE" rev-parse "refs/heads/${BR}" 2>/dev/null || echo none)"
check "branch tip matches source (${SRC_TIP})" assert_eq "$SRC_TIP" "$CLONE_TIP" "branch tip"

CLONE_TAG_OID="$(git -C "$CLONE" rev-parse "refs/tags/${TAG}" 2>/dev/null || echo none)"
check "annotated tag present and matches" assert_eq "$SRC_TAG_OID" "$CLONE_TAG_OID" "tag oid"
check "tag object is annotated (type tag)" \
  bash -c "[[ \"\$(git -C '$CLONE' cat-file -t '$TAG' 2>/dev/null)\" == tag ]]"

# Worktrees byte-identical (excluding .git).
if diff -r --exclude=.git "$SRC" "$CLONE" >"$LOG-diff.out" 2>&1; then
  ok "diff -r worktrees identical (byte-for-byte)"
else
  cat "$LOG-diff.out" >&2; bad "worktrees differ"
fi

# Object-content identity: every object reachable from the tip is present in the clone.
MISS="$(git -C "$CLONE" rev-list --objects --missing=print "$SRC_TIP" 2>/dev/null | grep -c '^?' || true)"
check "no missing objects reachable from tip" assert_eq "0" "${MISS:-0}" "missing objects"

finish_scenario
