#!/usr/bin/env bash
# Scenario 39: members-only discussion in a PUBLIC repository from `dg` (mixed-visibility DESIGN
# §4.1, §10, stream 1E; the web's parity is stream 1D's Playwright pair).
#
#   1. OWNER creates a fresh PUBLIC repo, pushes main and feature, turns members-only content on
#      (`dg repo members enable`), adds COLLAB as a writer (key shared) and opens PR #P
#   2. OWNER `dg issue create --members`                -> #N, audience members
#   3. CONTRIB (never a member) `dg issue view N`        -> "#N · members-only issue by … · open",
#      exit 0; --json readable false; no members-only text in anything CONTRIB reads
#   4. COLLAB (member) `dg issue view N --json`          -> the body, audience members
#   5. OWNER `dg pr comment P --members`; COLLAB `dg pr review P --approve --members`
#   6. CONTRIB `dg pr view P`                            -> the approval counted (DESIGN D15) and
#      "1 members-only comment hidden (you're not a member of …)"
#   7. leak probe: no CONTRIB output holds a members-only marker
#
# Each run makes a new repo (`e2e-mo-<run-id>`, about 0.02 DASH).
SCENARIO_NAME="39 members-only discussion: --members writes, outsider rows, verdict counted"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

NAME="e2e-mo-${RUN_ID}"
NAME="${NAME:0:63}"
REPO="${E2E_OWNER_ID}/${NAME}"
REMOTE="dash://${REPO}"
SRC="${WORKROOT}/s39-src"
LOG="${WORKROOT}/s39"
MARK="MEMBERS-ONLY-${RUN_ID}"
json_field() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {"d": d}))' "$1" "$2" 2>/dev/null; }
fail_with() { cat "$1.err" "$1.json" >&2 2>/dev/null; is_flake "$1.err" && skip_scenario "$2 flaked"; bad "$2 failed"; finish_scenario; }
# A write: --yes --json, stdout to <out>.json, stderr to <out>.err.
w() { local id="$1" out="$2"; shift 2; dg_as "$id" -y --json "$@" >"${out}.json" 2>"${out}.err"; }

step "OWNER creates a public repo (members-only content on from creation), pushes main and feature"
_retry "$LOG-create.err" _dg_read "$ID_OWNER" "$LOG-create.json" "$LOG-create.err" \
    --yes --json repo create "$NAME" --storage platform || fail_with "$LOG-create" "repo create"
# A retry after a flaky first attempt finds the repo: its members-only status is then not reported.
case "$(json_field "$LOG-create.json" 'd["membersOnly"] and d["membersOnly"]["status"]')" in
  on|None) ok "members-only content turned on at creation" ;;
  *) bad "members-only content at creation: $(cat "$LOG-create.json")" ;;
esac
seed_tiny_repo "$SRC" main >/dev/null
git -C "$SRC" checkout -q -b feature
printf 'feature %s\n' "$RUN_ID" >"$SRC/feature.txt"
git -C "$SRC" add -A && git -C "$SRC" commit -q -m "feature ${RUN_ID}"
git_dash_retry "$ID_OWNER" "$LOG-push" -C "$SRC" push "$REMOTE" \
    "refs/heads/main:refs/heads/main" "refs/heads/feature:refs/heads/feature" \
  || { cat "$LOG-push.err" >&2; is_flake "$LOG-push.err" && skip_scenario "push flaked"; bad "push failed"; finish_scenario; }
# Already on (or finished here after a retried create): enable says so, or shares what is missing.
w "$ID_OWNER" "$LOG-enable" repo members enable "$REPO" || fail_with "$LOG-enable" "members enable"
if collab_accept "$ID_COLLAB" "$REPO" "$LOG-add" && w "$ID_OWNER" "$LOG-add" collab add "$REPO" "$IDID_COLLAB" --role writer; then
  [[ "$(json_field "$LOG-add.json" 'd["keyShared"]')" == True ]] && ok "COLLAB added as a writer; key shared" || bad "added without the key"
else
  fail_with "$LOG-add" "collab add"
fi
w "$ID_OWNER" "$LOG-pr" pr create "$REPO" --head feature --base main --title "public pr ${RUN_ID}" --body "public" \
  || fail_with "$LOG-pr" "pr create"
PR="$(json_field "$LOG-pr.json" 'd["number"]')"
ok "PR #$PR opened"

step "OWNER opens a members-only issue (dg issue create --members)"
w "$ID_OWNER" "$LOG-issue" issue create "$REPO" --title "secret title $MARK" --body "secret body $MARK" --members \
  || fail_with "$LOG-issue" "issue create --members"
N="$(json_field "$LOG-issue.json" 'd["number"]')"
[[ "$(json_field "$LOG-issue.json" 'd["audience"]')" == members ]] && ok "issue #$N is members-only" || bad "audience: $(cat "$LOG-issue.json")"

step "CONTRIB (not a member) reads #$N: its row, exit 0, nothing of its text"
if dg_read_retry "$ID_CONTRIB" "$LOG-out-view.txt" "$LOG-out-view.err" issue view "$REPO" "$N"; then
  grep -q "#$N · members-only issue by .* · open" "$LOG-out-view.txt" && ok "the members-only row" || { cat "$LOG-out-view.txt" >&2; bad "row wording"; }
else
  cat "$LOG-out-view.err" >&2; bad "outsider issue view failed (exit non-zero)"
fi
if dg_read_retry "$ID_CONTRIB" "$LOG-out-view.json" "$LOG-out-view2.err" --json issue view "$REPO" "$N"; then
  [[ "$(json_field "$LOG-out-view.json" 'd["readable"] is False and d["audience"] == "members"')" == True ]] \
    && ok "--json: readable false, audience members" || bad "outsider json: $(cat "$LOG-out-view.json")"
else
  cat "$LOG-out-view2.err" >&2; bad "outsider issue view --json failed"
fi
dg_read_retry "$ID_CONTRIB" "$LOG-out-list.json" "$LOG-out-list.err" --json issue list "$REPO" --state all \
  && [[ "$(json_field "$LOG-out-list.json" 'd["membersOnly"] >= 1')" == True ]] && ok "issue list labels the members-only row" || bad "issue list: $(cat "$LOG-out-list.json" 2>/dev/null)"

step "COLLAB (member) reads #$N"
if dg_read_retry "$ID_COLLAB" "$LOG-mem-view.json" "$LOG-mem-view.err" --json issue view "$REPO" "$N"; then
  grep -qF "secret body $MARK" "$LOG-mem-view.json" && [[ "$(json_field "$LOG-mem-view.json" 'd["audience"]')" == members ]] \
    && ok "the member reads the body" || bad "member view: $(cat "$LOG-mem-view.json")"
else
  cat "$LOG-mem-view.err" >&2; bad "member issue view failed"
fi

step "OWNER comments members-only on the public PR; COLLAB approves members-only"
w "$ID_OWNER" "$LOG-com" pr comment "$REPO" "$PR" --body "comment $MARK" --members || fail_with "$LOG-com" "pr comment --members"
[[ "$(json_field "$LOG-com.json" 'd["audience"]')" == members ]] && ok "members-only comment" || bad "comment audience"
w "$ID_COLLAB" "$LOG-rev" pr review "$REPO" "$PR" --approve --members --body "review $MARK" || fail_with "$LOG-rev" "pr review --members"
[[ "$(json_field "$LOG-rev.json" 'd["audience"]')" == members ]] && ok "members-only approval" || bad "review audience"

step "CONTRIB reads PR #$PR: the approval counts, the comment is a hidden members-only one"
for i in $(seq 1 10); do
  dg_read_retry "$ID_CONTRIB" "$LOG-out-pr.json" "$LOG-out-pr.err" --json pr view "$REPO" "$PR" --comments \
    && [[ "$(json_field "$LOG-out-pr.json" 'd["membersOnlyHidden"] >= 1 and len(d["approvedBy"]) >= 1')" == True ]] && break
  sleep 4
done
[[ "$(json_field "$LOG-out-pr.json" "\"$IDID_COLLAB\" in d[\"approvedBy\"]")" == True ]] && ok "the members-only approval counts for an outsider" || bad "approvals: $(json_field "$LOG-out-pr.json" 'd["approvedBy"]')"
[[ "$(json_field "$LOG-out-pr.json" 'all(not r["readable"] for r in d["reviews"] if r["audience"] == "members")')" == True ]] && ok "the review text is not readable to the outsider" || bad "review readable to outsider"
dg_read_retry "$ID_CONTRIB" "$LOG-out-pr.txt" "$LOG-out-pr2.err" pr view "$REPO" "$PR" \
  && grep -q "members-only comment.* hidden.*(you're not a member of" "$LOG-out-pr.txt" && ok "\"members-only comment hidden\" note" || { cat "$LOG-out-pr.txt" >&2; bad "pr view note"; }

step "leak probe: nothing CONTRIB read holds members-only text"
if grep -l -- "$MARK" "$LOG"-out-* 2>/dev/null; then
  bad "members-only text in an outsider's output"
else
  ok "no members-only marker in any outsider output"
fi

finish_scenario
