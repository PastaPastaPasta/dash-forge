#!/usr/bin/env bash
# Scenario 35: CI runners and check runs (platform-parity-spec §2, I-1).
#
#   1. OWNER registers a checkRun-only key on the RUNNER identity and enrols it as a runner of the
#      suite repo (`dg ci runner new --runner <file>`); `runner list` shows it.
#   2. With that key (DASH_FORGE_KEY=dfk1:…) the runner reports `build` queued (a create), then
#      in_progress and completed/success (replaces of the same document); `dg ci status` shows
#      the run, trusted.
#   3. The same key cannot sign anything else: a star is refused as E302 (the key's contract
#      bounds, ContractBoundedKeyOutOfBoundsError), before anything is broadcast.
#   4. OWNER revokes the runner; its next report is refused at consensus (E601, 40120), and the
#      earlier run is no longer counted.
#   5. The runner key is disabled with the runner's master key (clean-up).
#
# RUNNER is E2E_CI_RUNNER (default: CI-RUNNER.identity.json in E2E_IDENTITY_DIR), an identity whose
# file holds its master key. No push: a check run names a commit id, which consensus does not
# check against the repo, so this scenario writes only small documents (~0.002 DASH).
SCENARIO_NAME="35 dg ci runner new / report / status / revoke"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
[[ -n "${HARNESS_SHARED:-}" ]] || harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

RUNNER="${E2E_CI_RUNNER:-${E2E_IDENTITY_DIR}/CI-RUNNER.identity.json}"
[[ -f "$RUNNER" ]] || skip_scenario "no runner identity at $RUNNER (set E2E_CI_RUNNER)"
RUNNER_ID="$(_idid "$RUNNER")"
REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
LOG="${WORKROOT}/s35"
KEYFILE="${WORKROOT}/s35-runner.dfk1"
# A commit id unique to this run.
SHA="$(printf 'e2e ci %s' "$RUN_ID" | git hash-object --stdin)"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }
must() { # must <log-prefix> <what>
  { is_flake "$1.err" && skip_scenario "$2 flaked"; } || true
  cat "$1.err" "$1.json" >&2
  bad "$2 failed"
  finish_scenario
}
as_runner() { # as_runner <log-prefix> <dg args...>
  local out="$1"; shift
  DASH_FORGE_KEY="$(cat "$KEYFILE")" RUST_LOG=error NO_COLOR=1 _tmo "${DG}" --yes --json "$@" >"${out}.json" 2>"${out}.err"
}

step "1. OWNER enrols RUNNER with a checkRun-only key"
rm -f "$KEYFILE"
dg_as "$ID_OWNER" --yes --json ci runner new "$REPO" --runner "$RUNNER" -o "$KEYFILE" --budget 0.01 --expires 1d \
  >"$LOG-new.json" 2>"$LOG-new.err" || must "$LOG-new" "ci runner new"
KEY_ID="$(jq_py "$LOG-new.json" 'd["keyId"]')"
check "the key is bound to checkRun" assert_eq "checkRun" "$(jq_py "$LOG-new.json" 'd["boundTo"]["documentType"]')"
check "enrolled" test "$(jq_py "$LOG-new.json" 'd["enrolled"] is not None')" = "True"
check "key file is 0600" assert_eq "600" "$(stat -f '%Lp' "$KEYFILE" 2>/dev/null || stat -c '%a' "$KEYFILE")"
check "key file is a dfk1 value for RUNNER" assert_file_contains "$KEYFILE" "dfk1:${DASH_FORGE_NETWORK}"
if dg_read_retry "$ID_OWNER" "$LOG-list.json" "$LOG-list.err" --json ci runner list "$REPO"; then
  check "runner list names RUNNER" assert_eq "True" "$(jq_py "$LOG-list.json" "'$RUNNER_ID' in [r['identityId'] for r in d['runners']]")"
else
  bad "ci runner list"
fi

step "2. the runner reports build: queued, in_progress, completed"
as_runner "$LOG-q" ci report "$REPO" --sha "$SHA" --name build --status queued --details-url "https://example.com/e2e/${RUN_ID}" || must "$LOG-q" "report queued"
DOC="$(jq_py "$LOG-q.json" 'd["documentId"]')"
check "queued: created" assert_eq "created" "$(jq_py "$LOG-q.json" 'd["status"]')"
check "the report links the commit page" assert_contains "$(jq_py "$LOG-q.json" 'd["url"]')" "/repo/commit/?"
as_runner "$LOG-p" ci report "$REPO" --sha "$SHA" --name build --status in_progress || must "$LOG-p" "report in_progress"
check "in_progress: the same run, updated" assert_eq "updated $DOC" "$(jq_py "$LOG-p.json" 'd["status"]+" "+d["documentId"]')"
as_runner "$LOG-p2" ci report "$REPO" --sha "$SHA" --name build --status in_progress || must "$LOG-p2" "report in_progress again"
check "a repeated in_progress changes nothing (the start is kept)" assert_eq "unchanged" "$(jq_py "$LOG-p2.json" 'd["status"]')"
as_runner "$LOG-c" ci report "$REPO" --sha "$SHA" --name build --status completed --conclusion success --summary "e2e ${RUN_ID}" || must "$LOG-c" "report completed"
check "completed: the same run, updated" assert_eq "updated $DOC" "$(jq_py "$LOG-c.json" 'd["status"]+" "+d["documentId"]')"
as_runner "$LOG-bad" ci report "$REPO" --sha "$SHA" --name build --status completed
check "a completed run without a conclusion is refused before signing" assert_eq "E201" "$(jq_py "$LOG-bad.json" 'd["error"]["code"]' 2>/dev/null)"
ok_status=0
for _ in 1 2 3 4 5; do
  if dg_read_retry "$ID_OWNER" "$LOG-st.json" "$LOG-st.err" --json ci status "$REPO" "$SHA" \
     && [[ "$(jq_py "$LOG-st.json" "[(c['status'],c['conclusion'],c['trusted'],c['reporter']) for c in d['checks'] if c['name']=='build']")" == "[('completed', 'success', True, '$RUNNER_ID')]" ]]; then
    ok_status=1; break
  fi
  sleep 3
done
check "ci status: build completed/success by the runner, trusted" test "$ok_status" = 1

step "3. the runner key cannot sign anything but a check run"
as_runner "$LOG-star" repo star "$REPO"
check "a star with the runner key fails" test $? -ne 0
check "…as E302 (outside the key's contract bounds)" assert_eq "E302" "$(jq_py "$LOG-star.json" 'd["error"]["code"]' 2>/dev/null)"

step "4. OWNER revokes the runner; its next report is refused at consensus"
dg_as "$ID_OWNER" --yes --json ci runner revoke "$REPO" "$RUNNER_ID" >"$LOG-rev.json" 2>"$LOG-rev.err" || must "$LOG-rev" "ci runner revoke"
check "revoked" assert_eq "revoked" "$(jq_py "$LOG-rev.json" 'd["status"]')"
refused=0
for _ in 1 2 3; do
  as_runner "$LOG-after" ci report "$REPO" --sha "$SHA" --name lint --status queued
  [[ "$(jq_py "$LOG-after.json" 'd["error"]["code"]' 2>/dev/null)" == "E601" ]] && { refused=1; break; }
  is_flake "$LOG-after.err" || break
  sleep 5
done
check "a revoked runner's report is refused (E601, 40120)" test "$refused" = 1
if dg_read_retry "$ID_OWNER" "$LOG-st2.json" "$LOG-st2.err" --json ci status "$REPO" "$SHA"; then
  check "the revoked runner's run is no longer counted" assert_eq "[False]" "$(jq_py "$LOG-st2.json" "[c['trusted'] for c in d['checks'] if c['name']=='build']")"
fi

step "5. the runner key is disabled like any Forge key (no --force)"
if DASH_FORGE_KEY="$RUNNER" RUST_LOG=error NO_COLOR=1 _tmo "${DG}" --yes --json auth keys disable "$KEY_ID" --master "$RUNNER" \
     >"$LOG-dis.json" 2>"$LOG-dis.err"; then
  check "runner key disabled" assert_eq "disabled" "$(jq_py "$LOG-dis.json" 'd["status"]')"
else
  cat "$LOG-dis.json" "$LOG-dis.err" >&2
  is_flake "$LOG-dis.err" && info "disable flaked; the key expires in a day" || bad "dg auth keys disable (runner key)"
fi

finish_scenario
