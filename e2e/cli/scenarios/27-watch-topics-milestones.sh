#!/usr/bin/env bash
# Scenario 27: the C-1 collaboration features (platform-parity-spec §1.2, §1.6, §6; F-3, F-7).
#
#   1. CONTRIB watches the suite repo (count +1), watches again (nothing written), unwatches
#      (the indexOnly delete by values; count back)                 -> `dg repo watch|unwatch`
#   2. OWNER tags the repo with a topic; the list reads it back; a re-tag adds nothing;
#      removing it drops it (repo.topics, and its topic document)   -> `dg repo topic`
#   3. OWNER defines a milestone, opens an issue, puts it in the milestone, lists the
#      milestones (1 open); closes the issue (0 open, 1 closed); closes the milestone
#                                                                    -> `dg milestone`, `dg issue milestone`
#   4. OWNER pins and locks the issue; `dg issue view --json` shows it pinned and locked, and
#      `dg issue list` lists it first; CONTRIB's comment on the locked issue is refused; unlocks
#      and unpins it
#                                                                    -> `dg issue pin|lock|list|comment`
#   5. CONTRIB (not a member) cannot pin, lock or set a milestone    -> E601 before signing
#   6. OWNER cannot put the issue in a milestone the repo does not define -> E102 before signing
#
# Written by OWNER (a maintainer of the suite repo) and CONTRIB (a stranger to it).
SCENARIO_NAME="27 watch, topics, milestones, pin and lock (C-1)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
[[ -n "${HARNESS_SHARED:-}" ]] || harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
LOG="${WORKROOT}/s27"
TOPIC="e2e-${RUN_ID: -8}"
MILESTONE="e2e ${RUN_ID: -8}"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }
dg_write() { # dg_write <identity> <log-prefix> <dg args...>
  local id="$1" out="$2"; shift 2
  dg_as "$id" --yes --json "$@" >"${out}.json" 2>"${out}.err"
}
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
must() { # must <log-prefix> <what>: stop on a failed write (skip on a devnet flake)
  { is_flake "$1.err" && skip_scenario "$2 flaked"; } || true
  cat "$1.err" "$1.json" >&2
  bad "$2 failed"
  finish_scenario
}

step "CONTRIB watches, watches again, unwatches"
dg_write "$ID_CONTRIB" "$LOG-unwatch0" repo unwatch "$REPO" || must "$LOG-unwatch0" "reset unwatch"
dg_write "$ID_CONTRIB" "$LOG-watch" repo watch "$REPO" || must "$LOG-watch" "watch"
check "watching" assert_eq "watching" "$(jq_py "$LOG-watch.json" 'd["status"]')"
dg_write "$ID_CONTRIB" "$LOG-watch2" repo watch "$REPO" || must "$LOG-watch2" "watch again"
check "watching again writes nothing" assert_eq "already_watching" "$(jq_py "$LOG-watch2.json" 'd["status"]')"
dg_write "$ID_CONTRIB" "$LOG-unwatch" repo unwatch "$REPO" || must "$LOG-unwatch" "unwatch"
check "unwatched (indexOnly delete by values)" assert_eq "unwatched" "$(jq_py "$LOG-unwatch.json" 'd["status"]')"

step "OWNER tags the repo with a topic, re-tags, removes it"
dg_write "$ID_OWNER" "$LOG-topic" repo topic "$REPO" --add "$TOPIC" || must "$LOG-topic" "add topic"
check "topic added" assert_eq "['$TOPIC']" "$(jq_py "$LOG-topic.json" 'd["added"]')"
check "the list reads it" until_read "$LOG-topics" "'$TOPIC' in d['topics']" repo topic "$REPO"
dg_write "$ID_OWNER" "$LOG-topic2" repo topic "$REPO" --add "$TOPIC" || must "$LOG-topic2" "re-add topic"
check "re-tagging adds nothing" assert_eq "[]" "$(jq_py "$LOG-topic2.json" 'd["added"]')"
dg_write "$ID_OWNER" "$LOG-untopic" repo topic "$REPO" --remove "$TOPIC" || must "$LOG-untopic" "remove topic"
check "topic removed" assert_eq "['$TOPIC']" "$(jq_py "$LOG-untopic.json" 'd["removed"]')"

step "OWNER defines a milestone and puts an issue in it"
dg_write "$ID_OWNER" "$LOG-ms" milestone create "$REPO" "$MILESTONE" --description "scenario 27" --due 2026-12-01 || must "$LOG-ms" "milestone create"
dg_write "$ID_OWNER" "$LOG-issue" issue create "$REPO" --title "e2e ${RUN_ID} milestone" --body "in a milestone" || must "$LOG-issue" "issue create"
N="$(jq_py "$LOG-issue.json" 'd["number"]')"
dg_write "$ID_OWNER" "$LOG-setms" issue milestone "$REPO" "$N" "$MILESTONE" || must "$LOG-setms" "issue milestone"
check "milestone lists 1 open" until_read "$LOG-list1" "any(m['title'] == '$MILESTONE' and m['open'] >= 1 and m['dueOn'] == 1796083200000 for m in d['milestones'])" milestone list "$REPO"
dg_write "$ID_OWNER" "$LOG-close" issue close "$REPO" "$N" || must "$LOG-close" "issue close"
check "closing the issue moves it to closed" until_read "$LOG-list2" "any(m['title'] == '$MILESTONE' and m['closedItems'] >= 1 for m in d['milestones'])" milestone list "$REPO"
dg_write "$ID_OWNER" "$LOG-msclose" milestone close "$REPO" "$MILESTONE" || must "$LOG-msclose" "milestone close"
check "the milestone reads closed" until_read "$LOG-list3" "any(m['title'] == '$MILESTONE' and m['closed'] for m in d['milestones'])" milestone list "$REPO"

step "OWNER pins and locks the issue, then unlocks it"
dg_write "$ID_OWNER" "$LOG-pin" issue pin "$REPO" "$N" || must "$LOG-pin" "pin"
dg_write "$ID_OWNER" "$LOG-lock" issue lock "$REPO" "$N" || must "$LOG-lock" "lock"
check "view shows it pinned and locked" until_read "$LOG-view" "d.get('pinned') is True and d.get('locked') is True and d.get('milestone') == '$MILESTONE'" issue view "$REPO" "$N"
# Earlier runs may leave pinned issues in the suite repo: every pinned row comes first, this one among them.
check "the list shows pinned issues first" until_read "$LOG-listpin" "$N in [i['number'] for i in d['issues'] if i['pinned']] and [i['pinned'] for i in d['issues']] == sorted([i['pinned'] for i in d['issues']], reverse=True)" issue list "$REPO" --state all
if dg_as "$ID_CONTRIB" --yes --json issue comment "$REPO" "$N" --body "after the lock" >"$LOG-lockedc.json" 2>"$LOG-lockedc.err"; then
  bad "CONTRIB could comment on a locked issue"
else
  check "a locked issue refuses CONTRIB's comment" assert_contains "$(cat "$LOG-lockedc.json" "$LOG-lockedc.err")" "locked to members"
fi
dg_write "$ID_OWNER" "$LOG-unlock" issue lock "$REPO" "$N" --off || must "$LOG-unlock" "unlock"
check "view shows it unlocked" until_read "$LOG-view2" "d.get('locked') is False" issue view "$REPO" "$N"
dg_write "$ID_OWNER" "$LOG-unpin" issue pin "$REPO" "$N" --off || must "$LOG-unpin" "unpin"

step "CONTRIB (not a member) is refused before signing"
for cmd in "issue pin $REPO $N" "issue lock $REPO $N" "issue milestone $REPO $N x"; do
  # shellcheck disable=SC2086
  if dg_as "$ID_CONTRIB" --yes --json $cmd >"$LOG-refuse.json" 2>"$LOG-refuse.err"; then
    bad "CONTRIB could run: $cmd"
  else
    check "refused: $cmd" assert_contains "$(cat "$LOG-refuse.json" "$LOG-refuse.err")" "E601"
  fi
done

step "OWNER cannot use a milestone the repo does not define"
if dg_as "$ID_OWNER" --yes --json issue milestone "$REPO" "$N" "no such milestone" >"$LOG-nomilestone.json" 2>"$LOG-nomilestone.err"; then
  bad "an undefined milestone was accepted"
else
  check "refused: an undefined milestone" assert_contains "$(cat "$LOG-nomilestone.json" "$LOG-nomilestone.err")" "E102"
fi

finish_scenario
