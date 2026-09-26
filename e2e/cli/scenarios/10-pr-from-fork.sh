#!/usr/bin/env bash
# Scenario 10: a pull request from a fork, reviewed and really merged.
#
#   1. OWNER pushes a base branch e2e/<run>/base to the test repo.
#   2. CONTRIB `dg repo fork`s the test repo (forkOf; the parent's packs are recorded by
#      reference, nothing re-uploaded) — resumable, so a later run reuses the fork.
#   3. CONTRIB clones its fork (proving the referenced packs read), commits on top of the
#      base, pushes a feature branch to the fork, and `dg pr create`s from it with no
#      --head-repo (the fork is found by forkOf).
#   4. OWNER diverges the base (a clean, unrelated change), so the merge is a real 3-way.
#   5. `dg pr view` shows the source fork; `dg pr diff` / `dg pr checkout` fetch the head
#      from the fork.
#   6. CONTRIB approves its own PR (not a member: does not count); OWNER approves (counts).
#   7. OWNER `dg pr merge`s: fetch both, build a merge commit, push it to the base, post the
#      merge event; the PR reads merged and the base tip is a merge whose parents are the old
#      base and the PR head.
SCENARIO_NAME="10 PR from a fork: review + real client-side merge"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
[[ -n "${HARNESS_SHARED:-}" ]] || harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
: "${E2E_FORK_NAME:=e2e-cli-fork}"
FORK="${IDID_CONTRIB}/${E2E_FORK_NAME}"
FORK_REMOTE="dash://${FORK}"
BASE="e2e/${RUN_ID}/base"
FEATURE="e2e/${RUN_ID}/feature"
SRC="${WORKROOT}/s10-src"
WORK="${WORKROOT}/s10-work"
LOG="${WORKROOT}/s10"

jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }
dg_write() { local id="$1" out="$2"; shift 2; dg_as "$id" --yes --json "$@" >"${out}.json" 2>"${out}.err"; }
fail_with() { cat "$1.err" "$1.json" >&2 2>/dev/null; is_flake "$1.err" && skip_scenario "$2 flaked"; bad "$2 failed"; finish_scenario; }

step "OWNER pushes the base branch ${BASE}"
seed_tiny_repo "$SRC" "$BASE" >/dev/null
git_dash_retry "$ID_OWNER" "$LOG-base" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BASE}:refs/heads/${BASE}" \
  || fail_with "$LOG-base" "base push"
register_ref "refs/heads/${BASE}"
ok "base pushed"

step "CONTRIB forks the test repo (${FORK})"
dg_write "$ID_CONTRIB" "$LOG-fork" repo fork "$REPO" --name "$E2E_FORK_NAME" || fail_with "$LOG-fork" "fork"
info "fork: $(jq_py "$LOG-fork.json" 'd["status"], d["manifestsWritten"], "manifests,", d["platformPacksReferenced"], "by Platform reference,", len(d["refsWritten"]), "refs,", d["cost"]["dash"], "DASH"')"
check "the fork names its parent" assert_eq "$(jq_py "$LOG-fork.json" 'd["parent"]')" "$REPO"
check "no pack was unreferenceable" assert_eq "0" "$(jq_py "$LOG-fork.json" 'len(d["unreferenceablePacks"])')"

step "CONTRIB clones the fork (its packs are the parent's, read by reference)"
if git_dash_retry "$ID_CONTRIB" "$LOG-clone" clone -q --no-checkout "$FORK_REMOTE" "$WORK"; then
  ok "fork cloned"
else
  fail_with "$LOG-clone" "fork clone"
fi
git -C "$WORK" config user.email "contrib@e2e.test"; git -C "$WORK" config user.name "E2E Contrib"; git -C "$WORK" config commit.gpgsign false
# The base branch was pushed after the fork was (possibly) created on an earlier run: take
# it from the parent.
git_dash_retry "$ID_CONTRIB" "$LOG-fbase" -C "$WORK" fetch -q "$E2E_REMOTE" "+refs/heads/${BASE}:refs/remotes/upstream/base" \
  || fail_with "$LOG-fbase" "fetch base from the parent"
git -C "$WORK" checkout -q -b "$FEATURE" refs/remotes/upstream/base
printf 'feature from the fork %s\n' "$RUN_ID" >"$WORK/feature.txt"
git -C "$WORK" add feature.txt && git -C "$WORK" commit -q -m "feat: add feature.txt (${RUN_ID})"
HEAD_OID="$(git -C "$WORK" rev-parse HEAD)"
git_dash_retry "$ID_CONTRIB" "$LOG-fpush" -C "$WORK" push "$FORK_REMOTE" "refs/heads/${FEATURE}:refs/heads/${FEATURE}" \
  || fail_with "$LOG-fpush" "push to the fork"
ok "feature pushed to the fork (${HEAD_OID:0:12})"

step "CONTRIB opens the PR from its fork (branch and fork inferred)"
( cd "$WORK" && dg_write "$ID_CONTRIB" "$LOG-pr" pr create "$REPO" --base "$BASE" --body "from the e2e fork" ) \
  || fail_with "$LOG-pr" "pr create"
N="$(jq_py "$LOG-pr.json" 'd["number"]')"
check "source is the fork" assert_eq "$FORK" "$(jq_py "$LOG-pr.json" 'd["sourceRepo"]')"
check "head is the pushed commit" assert_eq "$HEAD_OID" "$(jq_py "$LOG-pr.json" 'd["headOid"]')"
check "title from the head commit" assert_eq "feat: add feature.txt (${RUN_ID})" "$(jq_py "$LOG-pr.json" 'd["title"]')"
ok "PR #${N} opened ($(jq_py "$LOG-pr.json" 'd["cost"]["dash"]') DASH)"

step "OWNER diverges the base (an unrelated change: the merge must be 3-way)"
printf 'base moved on %s\n' "$RUN_ID" >"$SRC/base-only.txt"
git -C "$SRC" add base-only.txt && git -C "$SRC" commit -q -m "base moves on"
BASE2="$(git -C "$SRC" rev-parse HEAD)"
git_dash_retry "$ID_OWNER" "$LOG-base2" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BASE}:refs/heads/${BASE}" \
  || fail_with "$LOG-base2" "base advance"
ok "base at ${BASE2:0:12}"

step "view / diff / checkout fetch the head from the fork"
CO="${WORKROOT}/s10-reviewer"
rm -rf "$CO"; git init -q "$CO"
dg_read_retry "$ID_OWNER" "$LOG-view.json" "$LOG-view.err" --json pr view "$REPO" "$N" || fail_with "$LOG-view" "pr view"
check "view names the fork" assert_eq "$FORK" "$(jq_py "$LOG-view.json" 'd["sourceRepo"]')"
if ( cd "$CO" && dg_as "$ID_OWNER" --json pr diff "$REPO" "$N" >"$LOG-diff.json" 2>"$LOG-diff.err" ); then
  check "diff shows the feature file" assert_file_contains "$LOG-diff.json" "feature.txt"
  check "diff does not show the base's own change" assert_not_file_contains "$LOG-diff.json" "base-only.txt"
else
  cat "$LOG-diff.err" "$LOG-diff.json" >&2; bad "pr diff failed"
fi
if ( cd "$CO" && dg_as "$ID_OWNER" --json pr checkout "$REPO" "$N" >"$LOG-co.json" 2>"$LOG-co.err" ); then
  check "pr/${N} at the head" assert_eq "$HEAD_OID" "$(git -C "$CO" rev-parse "pr/${N}")"
else
  cat "$LOG-co.err" "$LOG-co.json" >&2; bad "pr checkout failed"
fi

step "reviews: the author (not a member) approves, then OWNER approves"
dg_write "$ID_CONTRIB" "$LOG-rev1" pr review "$REPO" "$N" --approve --body "lgtm (author)" || fail_with "$LOG-rev1" "author review"
check "the non-member's review is flagged as not counting" assert_eq "False" "$(jq_py "$LOG-rev1.json" 'd["counts"]')"
dg_write "$ID_OWNER" "$LOG-rev2" pr review "$REPO" "$N" --approve --body "lgtm" || fail_with "$LOG-rev2" "owner review"
approved() {
  dg_read_retry "$ID_OWNER" "$LOG-v2.json" "$LOG-v2.err" --json pr view "$REPO" "$N" \
    && [[ "$(jq_py "$LOG-v2.json" '",".join(d["approvedBy"])')" == "$IDID_OWNER" ]]
}
ap=1; for _ in $(seq 1 10); do approved && { ap=0; break; }; sleep 3; done
check "exactly OWNER's approval counts" test "$ap" -eq 0

step "OWNER merges (merge commit, push to base, merge event)"
if dg_write "$ID_OWNER" "$LOG-merge" pr merge "$REPO" "$N"; then
  cat "$LOG-merge.err" >&2
  check "reads merged" assert_eq "True" "$(jq_py "$LOG-merge.json" 'd["merged"]')"
  MERGE="$(jq_py "$LOG-merge.json" 'd["mergeOid"]')"
  check "the steps ran in order" assert_eq "fetch,merge,push,event" "$(jq_py "$LOG-merge.json" '",".join(s["step"] for s in d["steps"])')"
  step "the base tip is a merge of the old base and the PR head"
  VER="${WORKROOT}/s10-verify"
  git_dash_retry "$ID_OWNER" "$LOG-vclone" clone -q --no-checkout -b "$BASE" "$E2E_REMOTE" "$VER" || fail_with "$LOG-vclone" "verify clone"
  check "base tip is the merge commit" assert_eq "$MERGE" "$(git -C "$VER" rev-parse HEAD)"
  check "parents: old base, PR head" assert_eq "$BASE2 $HEAD_OID" "$(git -C "$VER" rev-list --parents -n1 HEAD | cut -d' ' -f2-)"
  check "fsck clean" git -C "$VER" fsck --no-progress --no-dangling
else
  cat "$LOG-merge.err" "$LOG-merge.json" >&2
  is_flake "$LOG-merge.err" && skip_scenario "merge flaked"
  bad "merge failed"
fi

finish_scenario
