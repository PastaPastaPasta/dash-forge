#!/usr/bin/env bash
# Scenario 20: a full review round trip with `dg` (docs/design/review-parity-spec.md §2.5, §7
# PR 7). The maintainer (OWNER) reviews a contributor's (CONTRIB) PR from a fork:
#
#   1. OWNER pushes a base branch with a source file; CONTRIB forks, changes it on a branch in
#      the fork and opens a DRAFT PR (`dg pr create --draft`), then `dg pr ready`.
#   2. OWNER starts a PENDING review with three inline comments (a single line, a multi-line
#      range on the old side, a suggestion): `--pending` twice writes nothing; the submit
#      (`--request-changes`) is interrupted after 2 of 4 documents (test hook), then the same
#      command finishes it with nothing written twice (`landed` = 4, reviewId one review).
#   3. `dg pr view --comments --json` groups the threads under their anchors (the range reads
#      3-5 old), lists the suggestion, and the review's `commentsLanded` = `commentCount` = 3.
#   4. CONTRIB `dg pr suggestion apply --all` commits the suggestion to its fork branch (with
#      a `Forge-Suggestion:` trailer) and moves the PR head; CONTRIB also `git push`es one
#      more commit to the branch and the helper's auto-sync follows it (`prSync`).
#   5. OWNER's `dg pr view` shows "new commits since your review" and the three threads as
#      outdated; OWNER resolves them (`dg pr resolve`), requests COLLAB's review and removes
#      it, dismisses nothing, comments once more (`dg pr comment --reply-to`), approves,
#      `dg pr checks` reads a seeded run, `dg pr commits` lists 3 commits, and
#      `dg pr merge --squash` merges: the base tip is one commit whose parent is the old base
#      and whose message carries `Co-authored-by`.
#   6. CONTRIB `dg pr edit`s the title (a replace; a re-run writes nothing).
#   7. Request budget: `dg pr view` of the merged PR stays under E2E_PR_VIEW_BUDGET DAPI
#      requests (counted from the SDK's dispatch trace).
#
# The web cross-check (the same fold in forge-web, via Playwright against a local build) is
# `forge-web/e2e/review-round-trip.spec.ts`, fed by the JSON this scenario leaves in
# ${WORKROOT}/s20-state.json.
#
# Identities: E2E_S20_OWNER / E2E_S20_COLLAB / E2E_S20_CONTRIB override OWNER / COLLAB /
# CONTRIB (the review writes are many; a run may use its own funded identities). A fresh
# repo pair per run (`e2e-review-<run>`, CONTRIB's fork `e2e-review-fork-<run>`).
SCENARIO_NAME="20 review round trip: pending review, suggestions, head sync, squash merge"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

S_OWNER="${E2E_S20_OWNER:-$ID_OWNER}"
S_COLLAB="${E2E_S20_COLLAB:-$ID_COLLAB}"
S_CONTRIB="${E2E_S20_CONTRIB:-$ID_CONTRIB}"
idid() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["identityId"])' "$1"; }
OWNER_ID="$(idid "$S_OWNER")"; COLLAB_ID="$(idid "$S_COLLAB")"; CONTRIB_ID="$(idid "$S_CONTRIB")"

NAME="e2e-review-${RUN_ID}"
FORKNAME="e2e-review-fork-${RUN_ID}"
REPO="${OWNER_ID}/${NAME}"
FORK="${CONTRIB_ID}/${FORKNAME}"
BASE="main"
FEATURE="feature/greet"
LOG="${WORKROOT}/s20"
STATE="${WORKROOT}/s20-state.json"
# Measured 22 on moutai (2026-09-27; 7 of them getDataContract). TODO(P-5): the contract memo
# and delta caches bring this down; tighten the budget when they land.
: "${E2E_PR_VIEW_BUDGET:=30}"

jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }
dgw() { local id="$1" out="$2"; shift 2; dg_as "$id" --yes --json "$@" >"${out}.json" 2>"${out}.err"; }
fail_with() { cat "$1.err" "$1.json" >&2 2>/dev/null; is_flake "$1.err" && skip_scenario "$2 flaked"; bad "$2 failed"; finish_scenario; }
must() { local id="$1" out="$2" what="$3"; shift 3; dgw "$id" "$out" "$@" || fail_with "$out" "$what"; }
view() { dg_read_retry "$1" "$2.json" "$2.err" --json pr view "$REPO" "$N" --comments; }
# Reload the view until a python predicate on it holds (a node a block behind lags writes).
view_until() { # view_until <identity> <out> <label> <python predicate on d>
  local id="$1" out="$2" label="$3" pred="$4" i
  for i in $(seq 1 10); do
    view "$id" "$out" && [[ "$(jq_py "$out.json" "bool($pred)")" == "True" ]] && { ok "$label"; return 0; }
    sleep 4
  done
  bad "$label"; cat "$out.json" >&2 2>/dev/null; return 1
}

step "OWNER creates ${REPO} and pushes ${BASE} with src/greet.rs"
_retry "$LOG-create.err" _dg_read "$S_OWNER" "$LOG-create.json" "$LOG-create.err" --yes --json repo create "$NAME" --storage platform \
  || fail_with "$LOG-create" "repo create"
SRC="${WORKROOT}/s20-src"
rm -rf "$SRC"; git init -q -b "$BASE" "$SRC"
git -C "$SRC" config user.email owner@e2e.test; git -C "$SRC" config user.name "E2E Owner"; git -C "$SRC" config commit.gpgsign false
mkdir -p "$SRC/src"
printf 'fn main() {\n    let name = "world";\n    let greeting = "hello";\n    let punct = "!";\n    let sep = ", ";\n    println!("{greeting}{sep}{name}{punct}");\n}\n' >"$SRC/src/greet.rs"
printf '# greet (%s)\n' "$RUN_ID" >"$SRC/README.md"
git -C "$SRC" add -A && git -C "$SRC" commit -q -m "base: greet"
BASE1="$(git -C "$SRC" rev-parse HEAD)"
git_dash_retry "$S_OWNER" "$LOG-push-base" -C "$SRC" push "dash://${REPO}" "refs/heads/${BASE}:refs/heads/${BASE}" || fail_with "$LOG-push-base" "base push"
ok "base at ${BASE1:0:12}"

step "CONTRIB forks, commits on ${FEATURE}, opens a draft PR, marks it ready"
must "$S_CONTRIB" "$LOG-fork" "fork" repo fork "$REPO" --name "$FORKNAME"
WORK="${WORKROOT}/s20-work"
git_dash_retry "$S_CONTRIB" "$LOG-clone" clone -q "dash://${FORK}" "$WORK" || fail_with "$LOG-clone" "fork clone"
git -C "$WORK" config user.email contrib@e2e.test; git -C "$WORK" config user.name "E2E Contrib"; git -C "$WORK" config commit.gpgsign false
git -C "$WORK" checkout -q -b "$FEATURE" "origin/${BASE}"
sed -i.bak 's/"world"/"forge"/' "$WORK/src/greet.rs" && rm "$WORK/src/greet.rs.bak"
printf 'fn helper() {}\n' >>"$WORK/src/greet.rs"
git -C "$WORK" commit -qam "feat: greet the forge"
HEAD1="$(git -C "$WORK" rev-parse HEAD)"
git_dash_retry "$S_CONTRIB" "$LOG-push-f1" -C "$WORK" push "dash://${FORK}" "refs/heads/${FEATURE}:refs/heads/${FEATURE}" || fail_with "$LOG-push-f1" "feature push"
( cd "$WORK" && dgw "$S_CONTRIB" "$LOG-pr" pr create "$REPO" --base "$BASE" --head "$FEATURE" --draft --body "Greets the forge." ) || fail_with "$LOG-pr" "pr create --draft"
N="$(jq_py "$LOG-pr.json" 'd["number"]')"
check "opened as a draft" assert_eq "True" "$(jq_py "$LOG-pr.json" 'd["draft"]')"
view_until "$S_OWNER" "$LOG-v0" "the PR reads as a draft" 'd["draft"] and d["headOid"]=="'"$HEAD1"'"'
must "$S_CONTRIB" "$LOG-ready" "pr ready" pr ready "$REPO" "$N"
check "ready went through the author's authorEvent" assert_eq "author" "$(jq_py "$LOG-ready.json" 'd["via"]')"
view_until "$S_OWNER" "$LOG-v1" "the PR is ready for review" 'not d["draft"]'

step "OWNER builds a pending review (writes nothing), then submits it as request changes"
BAL0="$(dg_as "$S_OWNER" --json auth balance 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["balanceCredits"])' 2>/dev/null || echo 0)"
must "$S_OWNER" "$LOG-pend1" "pending 1" pr review "$REPO" "$N" --pending \
  --file src/greet.rs --line 2 --body "Name the audience in a constant?"
must "$S_OWNER" "$LOG-pend2" "pending 2" pr review "$REPO" "$N" --pending \
  --file src/greet.rs --start-line 3 --line 5 --side old --body "These three lines could be one format string." \
  --file src/greet.rs --line 8 --suggest 'fn helper() -> &'"'"'static str { "forge" }' --body "Return the name?"
check "the draft holds 3 comments" assert_eq "3" "$(jq_py "$LOG-pend2.json" 'len(d["comments"])')"
check "the range reads 3-5 (old)" assert_eq "src/greet.rs:3-5 (old)" "$(jq_py "$LOG-pend2.json" 'd["comments"][1]["location"]')"
BAL1="$(dg_as "$S_OWNER" --json auth balance 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["balanceCredits"])' 2>/dev/null || echo 0)"
check "a pending review spends nothing" assert_eq "$BAL0" "$BAL1"

# Interrupt the submit after 2 of 4 documents (debug builds only), then finish it.
if DASH_FORGE_TEST_FAIL_AFTER_DOCS=2 dgw "$S_OWNER" "$LOG-sub1" pr review "$REPO" "$N" --request-changes --body "A few things before this lands."; then
  bad "the interrupted submit should have failed"
else
  check "interrupted with 2 of 4 documents landed" assert_eq "2" "$(jq_py "$LOG-sub1.json" 'd["landed"]')"
  check "partial status" assert_eq "partial" "$(jq_py "$LOG-sub1.json" 'd["status"]')"
fi
must "$S_OWNER" "$LOG-sub2" "review resume" pr review "$REPO" "$N" --request-changes --body "A few things before this lands."
check "the resume finished all 4 documents" assert_eq "4" "$(jq_py "$LOG-sub2.json" 'd["landed"]')"
check "it was a resume" assert_eq "True" "$(jq_py "$LOG-sub2.json" 'd["resumed"]')"
REVIEW1="$(jq_py "$LOG-sub2.json" 'd["reviewId"]')"
check "the same review id as the interrupted run" assert_eq "$(jq_py "$LOG-sub1.json" 'd["reviewId"]')" "$REVIEW1"
view_until "$S_OWNER" "$LOG-v2" "3 threads, 1 review with 3 of 3 comments, changes requested" \
  'len(d["threads"])==3 and len(d["reviews"])==1 and d["reviews"][0]["commentsLanded"]==3 and d["reviews"][0]["commentCount"]==3 and d["changesRequestedBy"]==["'"$OWNER_ID"'"]'
check "no comment was written twice" assert_eq "3" "$(jq_py "$LOG-v2.json" 'len([c for c in d["comments"] if c["reviewId"]=="'"$REVIEW1"'"])')"
check "the range thread is 3-5 (old)" assert_eq "src/greet.rs:3-5 (old)" "$(jq_py "$LOG-v2.json" '[t["location"] for t in d["threads"] if t["anchor"]["startLine"]==3][0]')"
check "the suggestion is listed" assert_eq "fn helper() -> &'static str { \"forge\" }" "$(jq_py "$LOG-v2.json" '[s for t in d["threads"] for c in t["comments"] for s in c["suggestions"]][0]')"
SUGGEST_ID="$(jq_py "$LOG-v2.json" '[c["id"] for t in d["threads"] for c in t["comments"] if c["suggestions"]][0]')"
if dgw "$S_COLLAB" "$LOG-noresolve" pr resolve "$REPO" "$N" "$SUGGEST_ID"; then
  bad "a stranger's resolve should be refused"
else
  check "a stranger's resolve is refused before signing (E601)" assert_eq "E601" "$(jq_py "$LOG-noresolve.json" 'd["error"]["code"]')"
fi

step "CONTRIB applies the suggestion, then pushes one more commit (the helper follows it)"
must "$S_CONTRIB" "$LOG-apply" "suggestion apply" pr suggestion apply "$REPO" "$N" --all
check "one suggestion applied" assert_eq "$SUGGEST_ID" "$(jq_py "$LOG-apply.json" '",".join(d["applied"])')"
HEAD2="$(jq_py "$LOG-apply.json" 'd["headOid"]')"
view_until "$S_OWNER" "$LOG-v3" "the PR head followed the suggestion commit" 'd["headOid"]=="'"$HEAD2"'"'
git_dash_retry "$S_CONTRIB" "$LOG-pull" -C "$WORK" pull -q --ff-only "dash://${FORK}" "$FEATURE" || fail_with "$LOG-pull" "pull the applied suggestion"
check "the applied commit carries the trailer" assert_contains "$(git -C "$WORK" log -1 --format=%B)" "Forge-Suggestion: ${SUGGEST_ID}"
check "the suggestion is in the file" assert_contains "$(cat "$WORK/src/greet.rs")" 'fn helper() -> &'"'"'static str { "forge" }'
printf '// reviewed\n' >>"$WORK/src/greet.rs"
git -C "$WORK" commit -qam "chore: note the review"
HEAD3="$(git -C "$WORK" rev-parse HEAD)"
GIT_DASH_JSON=1 git_dash_retry "$S_CONTRIB" "$LOG-push-f2" -C "$WORK" push "dash://${FORK}" "refs/heads/${FEATURE}:refs/heads/${FEATURE}" || fail_with "$LOG-push-f2" "second push"
check "git push posted the head update" assert_file_contains "$LOG-push-f2.err" '"event":"prSync"'
view_until "$S_OWNER" "$LOG-v4" "new commits since your review; the review is stale; threads outdated" \
  'd["headOid"]=="'"$HEAD3"'" and d["sinceYourReview"]["reviewedOid"]=="'"$HEAD1"'" and d["sinceYourReview"]["headUpdates"]==2 and all(t["outdated"] for t in d["threads"]) and d["reviews"][0]["stale"] and d["changesRequestedBy"]==[]'
dg_as "$S_OWNER" pr view "$REPO" "$N" >"$LOG-v4.txt" 2>/dev/null
check "the human view says so" assert_file_contains "$LOG-v4.txt" "new commits since your review"

step "OWNER resolves the threads, requests and unrequests COLLAB, replies, approves"
for T in $(jq_py "$LOG-v4.json" '" ".join(t["id"] for t in d["threads"])'); do
  must "$S_OWNER" "$LOG-res-$T" "resolve $T" pr resolve "$REPO" "$N" "$T"
done
must "$S_OWNER" "$LOG-res-again" "resolve again" pr resolve "$REPO" "$N" "$T"
check "resolving a resolved thread writes nothing" assert_eq "False" "$(jq_py "$LOG-res-again.json" 'd["written"]')"
must "$S_OWNER" "$LOG-rr" "request-review" pr request-review "$REPO" "$N" "$COLLAB_ID"
view_until "$S_OWNER" "$LOG-v5" "COLLAB is awaited, all threads resolved" \
  'all(t["resolved"] for t in d["threads"]) and [r["state"] for r in d["reviewers"] if r["identity"]=="'"$COLLAB_ID"'"]==["awaiting"]'
must "$S_OWNER" "$LOG-urr" "unrequest-review" pr unrequest-review "$REPO" "$N" "$COLLAB_ID"
FIRST_THREAD="$(jq_py "$LOG-v4.json" 'd["threads"][0]["id"]')"
must "$S_OWNER" "$LOG-reply" "reply" pr comment "$REPO" "$N" --reply-to "$FIRST_THREAD" --body "Fixed, thanks."
must "$S_OWNER" "$LOG-approve" "approve" pr review "$REPO" "$N" --approve --body "LGTM"
REVIEW2="$(jq_py "$LOG-approve.json" 'd["reviewId"]')"
view_until "$S_OWNER" "$LOG-v6" "approved on the new head, COLLAB no longer requested, the marker gone" \
  'd["approvedBy"]==["'"$OWNER_ID"'"] and d["requestedReviewers"]==[] and d["sinceYourReview"] is None'

step "checks and commits"
CHECK_URL="https://ci.example.invalid/${RUN_ID}"
SEED="${E2E_SEED_CHECK_RUN:-${BIN_DIR}/seed_check_run}"
[[ -x "$SEED" ]] || SEED="${CARGO_TARGET_DIR:-${E2E_REPO_ROOT}/target}/debug/examples/seed_check_run"
[[ -x "$SEED" ]] || ( cd "$E2E_REPO_ROOT" && cargo build -q -p forge-core --example seed_check_run >/dev/null 2>&1 )
"$SEED" \
  "$S_OWNER" "$(jq_py "$LOG-create.json" 'd["repoId"]')" "$HEAD3" build completed success "$CHECK_URL" >"$LOG-seed.out" 2>"$LOG-seed.err" \
  || { cat "$LOG-seed.err" >&2; bad "seed a check run"; }
for i in $(seq 1 8); do
  dg_read_retry "$S_OWNER" "$LOG-checks.json" "$LOG-checks.err" --json pr checks "$REPO" "$N" && [[ "$(jq_py "$LOG-checks.json" 'd["passed"]')" == "1" ]] && break
  sleep 4
done
check "dg pr checks reads the seeded run" assert_eq "build:success:True" "$(jq_py "$LOG-checks.json" '":".join([d["checks"][0]["name"], d["checks"][0]["conclusion"], str(d["checks"][0]["trusted"])])')"
dg_read_retry "$S_OWNER" "$LOG-commits.json" "$LOG-commits.err" --json pr commits "$REPO" "$N" || fail_with "$LOG-commits" "pr commits"
check "three commits on the PR" assert_eq "3" "$(jq_py "$LOG-commits.json" 'd["total"]')"
check "newest first" assert_eq "$HEAD3" "$(jq_py "$LOG-commits.json" 'd["commits"][0]["oid"]')"

step "CONTRIB edits the title (a replace; a re-run writes nothing)"
must "$S_CONTRIB" "$LOG-edit" "pr edit" pr edit "$REPO" "$N" --title "Greet the forge (${RUN_ID})"
check "edited" assert_eq "True" "$(jq_py "$LOG-edit.json" 'd["written"]')"
sleep 3
must "$S_CONTRIB" "$LOG-edit2" "pr edit again" pr edit "$REPO" "$N" --title "Greet the forge (${RUN_ID})"
check "the same edit writes nothing" assert_eq "False" "$(jq_py "$LOG-edit2.json" 'd["written"]')"

step "OWNER squash-merges"
must "$S_OWNER" "$LOG-merge" "squash merge" pr merge "$REPO" "$N" --squash
check "merged" assert_eq "True" "$(jq_py "$LOG-merge.json" 'd["merged"]')"
check "squash" assert_eq "squash" "$(jq_py "$LOG-merge.json" 'd["method"]')"
SQUASH="$(jq_py "$LOG-merge.json" 'd["mergeOid"]')"
VER="${WORKROOT}/s20-verify"
git_dash_retry "$S_OWNER" "$LOG-vclone" clone -q -b "$BASE" "dash://${REPO}" "$VER" || fail_with "$LOG-vclone" "verify clone"
check "the base tip is the squash commit" assert_eq "$SQUASH" "$(git -C "$VER" rev-parse HEAD)"
check "one parent: the old base" assert_eq "$BASE1" "$(git -C "$VER" rev-list --parents -n1 HEAD | cut -d' ' -f2-)"
check "the squash tree is the PR head's" assert_eq "$(git -C "$WORK" rev-parse "${HEAD3}^{tree}")" "$(git -C "$VER" rev-parse 'HEAD^{tree}')"
check "Co-authored-by the contributor" assert_contains "$(git -C "$VER" log -1 --format=%B)" "Co-authored-by: E2E Contrib <contrib@e2e.test>"

step "request budget: dg pr view (TODO(P-5): tighten once the contract memo lands)"
DASH_FORGE_KEY="$S_OWNER" RUST_LOG="dapi_client::dispatch=trace" NO_COLOR=1 _tmo "$DG" --json pr view "$REPO" "$N" --comments >"$LOG-budget.json" 2>"$LOG-budget.err"
REQS="$(grep -c 'dispatching request to DAPI endpoint' "$LOG-budget.err" || true)"
info "dg pr view: ${REQS} DAPI requests (budget ${E2E_PR_VIEW_BUDGET})"
check "dg pr view ≤ ${E2E_PR_VIEW_BUDGET} requests" test "$REQS" -gt 0 -a "$REQS" -le "$E2E_PR_VIEW_BUDGET"

# The fold the web must agree with, for forge-web/e2e/review-round-trip.spec.ts.
python3 - "$LOG-budget.json" "$STATE" "$OWNER_ID" "$NAME" "$N" "$REQS" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
json.dump({
    "owner": sys.argv[3], "name": sys.argv[4], "number": int(sys.argv[5]), "viewRequests": int(sys.argv[6]),
    "title": d["title"], "state": d["state"], "draft": d["draft"], "headOid": d["headOid"],
    "approvedBy": d["approvedBy"], "changesRequestedBy": d["changesRequestedBy"],
    "reviews": [{"id": r["id"], "verdict": r["verdict"], "commitOid": r["commitOid"], "stale": r["stale"]} for r in d["reviews"]],
    "threads": [{"id": t["id"], "path": t["anchor"]["path"], "line": t["anchor"]["line"], "startLine": t["anchor"]["startLine"],
                 "side": t["anchor"]["side"], "outdated": t["outdated"], "resolved": t["resolved"], "comments": len(t["comments"])} for t in d["threads"]],
    "headUpdates": len(d["review"]["headUpdates"]),
}, open(sys.argv[2], "w"), indent=2)
PY
info "fold for the web cross-check: ${STATE}"
cp "$STATE" "${E2E_S20_STATE_OUT:-/dev/null}" 2>/dev/null || true

finish_scenario
