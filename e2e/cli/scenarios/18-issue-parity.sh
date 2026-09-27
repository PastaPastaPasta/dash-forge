#!/usr/bin/env bash
# Scenario 18: GitHub-parity issue commands (platform-parity-spec §1.2, F-1).
#
#   1. OWNER opens an issue, then edits its title and body     -> `dg issue edit`, reads back
#   2. a re-run of the same edit writes nothing                 -> status "unchanged", 0 credits
#   3. CONTRIB (not the author) tries to edit it                -> E601 before signing
#   4. OWNER defines a label, lists it, applies it and a second -> `dg label create|list`,
#      one, removes the second                                     `dg issue label add|remove`
#   5. OWNER assigns and unassigns itself                        -> `dg issue assign|unassign`;
#      the assign event carries refId = the assignee, so the sparse `event.addressee (refId)`
#      index finds it (read raw from Platform by the Node SDK when available)
#   6. `dg issue list` filters: --label, --assignee me, --author, --search, --state, --page
#   7. OWNER deletes the label                                   -> `dg label delete`
#
# Everything is written by OWNER (a maintainer of the suite repo) except the refused edit.
SCENARIO_NAME="18 issue parity (edit, labels, assignees, list filters and paging)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
[[ -n "${HARNESS_SHARED:-}" ]] || harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
LOG="${WORKROOT}/s18"
TITLE="e2e ${RUN_ID} parity"
LABEL="e2e-${RUN_ID: -8}"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }
dg_write() { # dg_write <identity> <log-prefix> <dg args...>
  local id="$1" out="$2"; shift 2
  dg_as "$id" --yes --json "$@" >"${out}.json" 2>"${out}.err"
}
# Poll a read until the python expression on its JSON is true.
until_read() { # until_read <out> <python-bool-expr> <dg args...>
  local out="$1" expr="$2"; shift 2
  for _ in $(seq 1 10); do
    if dg_read_retry "$ID_OWNER" "$out.json" "$out.err" --json "$@"; then
      [[ "$(jq_py "$out.json" "$expr")" == "True" ]] && return 0
    fi
    sleep 3
  done
  return 1
}

step "OWNER opens an issue and edits it"
dg_write "$ID_OWNER" "$LOG-create" issue create "$REPO" --title "$TITLE" --body "before" \
  || { is_flake "$LOG-create.err" && skip_scenario "issue create flaked"; cat "$LOG-create.json" >&2; bad "create failed"; finish_scenario; }
N="$(jq_py "$LOG-create.json" 'd["number"]')"
ok "opened issue #${N}"
if dg_write "$ID_OWNER" "$LOG-edit" issue edit "$REPO" "$N" --title "$TITLE (edited)" --body "after"; then
  check "edit landed" assert_eq "edited" "$(jq_py "$LOG-edit.json" 'd["status"]')"
  check "title and body read back" until_read "$LOG-view" "d['title'].endswith('(edited)') and d['body'] == 'after'" issue view "$REPO" "$N"
else
  cat "$LOG-edit.json" >&2; bad "edit failed"
fi
if dg_write "$ID_OWNER" "$LOG-edit2" issue edit "$REPO" "$N" --title "$TITLE (edited)"; then
  check "a repeated edit writes nothing" assert_eq "unchanged" "$(jq_py "$LOG-edit2.json" 'd["status"]')"
  check "…and costs nothing" assert_eq "0" "$(jq_py "$LOG-edit2.json" 'd["cost"]["credits"]')"
else
  cat "$LOG-edit2.json" >&2; bad "repeated edit failed"
fi

step "CONTRIB (not the author) cannot edit it"
if dg_write "$ID_CONTRIB" "$LOG-hijack" issue edit "$REPO" "$N" --title "hijacked"; then
  bad "a non-author's edit was accepted"
else
  check "E601 before signing" assert_eq "E601" "$(jq_py "$LOG-hijack.json" 'd["error"]["code"]')"
fi

step "labels: define, list, apply two, remove one"
if dg_write "$ID_OWNER" "$LOG-ldef" label create "$REPO" "$LABEL" --color "#1d76db" --description "e2e scenario 18"; then
  check "label listed with its colour" until_read "$LOG-llist" "any(l['name'] == '$LABEL' and l['color'] == '#1d76db' for l in d['labels'])" label list "$REPO"
else
  cat "$LOG-ldef.json" >&2; bad "label create failed"
fi
if dg_write "$ID_OWNER" "$LOG-ladd" issue label "$REPO" "$N" add "$LABEL" e2e-extra; then
  check "two label events" assert_eq "2" "$(jq_py "$LOG-ladd.json" 'len(d["eventIds"])')"
  dg_write "$ID_OWNER" "$LOG-lrm" issue label "$REPO" "$N" remove e2e-extra || { cat "$LOG-lrm.json" >&2; bad "label remove failed"; }
  check "labels fold to just $LABEL" until_read "$LOG-lv" "d['state']['labels'] == ['$LABEL']" issue view "$REPO" "$N"
else
  cat "$LOG-ladd.json" >&2; bad "label add failed"
fi

step "assignees: assign me, check the addressee index, list --assignee me, unassign"
if dg_write "$ID_OWNER" "$LOG-assign" issue assign "$REPO" "$N" me; then
  EV="$(jq_py "$LOG-assign.json" 'd["eventIds"][0]')"
  check "assignee reads back" until_read "$LOG-av" "d['state']['assignees'] == ['$E2E_OWNER_ID']" issue view "$REPO" "$N"
  check "list --assignee me finds it" until_read "$LOG-al" "$N in [i['number'] for i in d['issues']]" issue list "$REPO" --assignee me --limit 100
  # The event's refId, read raw: the sparse addressee index holds only events with a refId.
  CHAIN="${E2E_REPO_ROOT}/../dash-forge-qa/bin/chain-doc.mjs"
  if [[ -f "$CHAIN" ]]; then
    if node "$CHAIN" collab event "[[\"refId\",\"==\",\"$E2E_OWNER_ID\"]]" --limit 100 >"$LOG-addr.json" 2>"$LOG-addr.err"; then
      check "the addressee index finds the assign event" assert_file_contains "$LOG-addr.json" "$EV"
    else
      info "addressee read skipped: $(tail -1 "$LOG-addr.err")"
    fi
  fi
  if dg_write "$ID_OWNER" "$LOG-unassign" issue unassign "$REPO" "$N" "$E2E_OWNER_ID"; then
    check "unassigned" until_read "$LOG-uv" "d['state']['assignees'] == []" issue view "$REPO" "$N"
  else
    cat "$LOG-unassign.json" >&2; bad "unassign failed"
  fi
else
  cat "$LOG-assign.json" >&2; bad "assign failed"
fi

step "dg issue list filters and paging"
check "--label" until_read "$LOG-f1" "[i['number'] for i in d['issues']] == [$N]" issue list "$REPO" --label "$LABEL" --state all
check "--search (title words)" until_read "$LOG-f2" "$N in [i['number'] for i in d['issues']]" issue list "$REPO" --search "${RUN_ID} edited" --state all
check "--search #n" until_read "$LOG-f3" "[i['number'] for i in d['issues']] == [$N]" issue list "$REPO" --search "#$N" --state all
check "--author" until_read "$LOG-f4" "$N in [i['number'] for i in d['issues']] and all(i['author'] == '$E2E_OWNER_ID' for i in d['issues'])" issue list "$REPO" --author "$E2E_OWNER_ID" --state all --limit 100
check "--state closed excludes it" until_read "$LOG-f5" "$N not in [i['number'] for i in d['issues']]" issue list "$REPO" --state closed --limit 100
if dg_read_retry "$ID_OWNER" "$LOG-p1.json" "$LOG-p1.err" --json issue list "$REPO" --state all --limit 1 --page 1 \
  && dg_read_retry "$ID_OWNER" "$LOG-p2.json" "$LOG-p2.err" --json issue list "$REPO" --state all --limit 1 --page 2; then
  check "pages are disjoint and counted" python3 -c "
import json,sys
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
assert a['total'] >= 2 and a['pages'] == a['total'] and a['truncated'], a
assert a['issues'][0]['number'] != b['issues'][0]['number'], (a, b)
assert a['issues'][0]['number'] > b['issues'][0]['number']
" "$LOG-p1.json" "$LOG-p2.json"
else
  bad "paged list failed"
fi

step "OWNER deletes the label"
if dg_write "$ID_OWNER" "$LOG-ldel" label delete "$REPO" "$LABEL"; then
  check "definition deleted" assert_eq "1" "$(jq_py "$LOG-ldel.json" 'd["deletedDocuments"]')"
  check "label no longer listed" until_read "$LOG-ll2" "'$LABEL' not in [l['name'] for l in d['labels']]" label list "$REPO"
else
  cat "$LOG-ldel.json" >&2; bad "label delete failed"
fi

finish_scenario
