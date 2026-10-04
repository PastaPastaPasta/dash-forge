#!/usr/bin/env bash
# Scenario 37: forge-runner end to end on the live devnet (P1-8).
#
#   1. OWNER enrols RUNNER with a checkRun-only key (as 35 does).
#   2. forge-runner's first poll records the repository and runs nothing.
#   3. OWNER pushes a branch holding a workflow; the next poll runs it with act and reports
#      `e2e-runner / build` on the commit, completed/success, by the runner and trusted
#      (`dg ci status`).
#   4. OWNER opens a PR from that branch and asks for the check again (`dg ci rerun`, an event
#      of kind 26); `dg ci reruns` lists the request, counted; the next poll runs the workflow
#      again as the branch's push: a newer completed run whose summary names who asked. A poll
#      after that runs nothing.
#   5. Clean-up: the PR is closed, the runner revoked and its key disabled.
#
# Needs act, a running Docker daemon and forge-runner beside dg (`cargo build -p forge-runner`);
# SKIPs without them. Not in the default set (`run.sh 37`): it pulls a job image and runs a
# container. RUNNER is E2E_CI_RUNNER (default CI-RUNNER.identity.json), an identity whose file
# holds its master key. E2E_RUNNER_IMAGE picks the job image (default node:20-bookworm-slim).
# Writes about 0.01 DASH: two small pushes, a PR, a re-run request and six check-run reports.
SCENARIO_NAME="37 forge-runner: a push runs, a re-run request runs again"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
[[ -n "${HARNESS_SHARED:-}" ]] || harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

RUNNER="${E2E_CI_RUNNER:-${E2E_IDENTITY_DIR}/CI-RUNNER.identity.json}"
[[ -f "$RUNNER" ]] || skip_scenario "no runner identity at $RUNNER (set E2E_CI_RUNNER)"
RUNNER_BIN="${BIN_DIR}/forge-runner"
[[ -x "$RUNNER_BIN" ]] || skip_scenario "no forge-runner at $RUNNER_BIN (cargo build -p forge-runner)"
command -v act >/dev/null || skip_scenario "act is not installed"
docker info >/dev/null 2>&1 || skip_scenario "docker is not running"
IMAGE="${E2E_RUNNER_IMAGE:-node:20-bookworm-slim}"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null || skip_scenario "cannot pull $IMAGE"

RUNNER_ID="$(_idid "$RUNNER")"
REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
LOG="${WORKROOT}/s37"
KEYFILE="${WORKROOT}/s37-runner.dfk1"
BASE="e2e/${RUN_ID}/runner-base"
BR="e2e/${RUN_ID}/runner"
CHECK="e2e-runner / build"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }
must() { # must <log-prefix> <what>
  { is_flake "$1.err" && skip_scenario "$2 flaked"; } || true
  cat "$1.err" "$1.json" >&2 2>/dev/null
  bad "$2 failed"
  finish_scenario
}

CFG="${WORKROOT}/s37-runner.toml"
cat >"$CFG" <<EOF
network = "${DASH_FORGE_NETWORK}"
$([[ "$DASH_FORGE_NETWORK" == devnet ]] && echo "devnet_name = \"${DASH_FORGE_DEVNET_NAME}\"")
state_dir = "${WORKROOT}/s37-state"
[platforms]
ubuntu-latest = "${IMAGE}"
[bin]
dg = "${DG}"
[[repo]]
repo = "${REPO}"
refs = ["refs/heads/${BR}"]
pull_requests = "off"
EOF
poll() { # poll <log-name>: one `watch --once`, signing reports with the runner key
  DASH_FORGE_KEY="$(cat "$KEYFILE")" RUST_LOG=error NO_COLOR=1 \
    _tmo_for 900 "$RUNNER_BIN" -c "$CFG" watch --once >"${LOG}-$1.log" 2>&1
}
# The newest run of $CHECK on <sha>, as `(status, conclusion, trusted, reporter, id)`, retried
# while the node catches up; `want` is the repr of the tuple's first four.
check_run() { # check_run <sha> <want> <log>
  local got=""
  for _ in 1 2 3 4 5 6; do
    if dg_read_retry "$ID_OWNER" "$3.json" "$3.err" --json ci status "$REPO" "$1"; then
      got="$(jq_py "$3.json" "[(c['status'],c['conclusion'],c['trusted'],c['reporter']) for c in d['checks'] if c['name']=='$CHECK']")"
      [[ "$got" == "$2" ]] && return 0
    fi
    sleep 5
  done
  info "got ${got:-nothing}"
  return 1
}

step "1. OWNER enrols RUNNER with a checkRun-only key"
rm -f "$KEYFILE"
dg_as "$ID_OWNER" --yes --json ci runner new "$REPO" --runner "$RUNNER" -o "$KEYFILE" --budget 0.02 --expires 1d \
  >"$LOG-new.json" 2>"$LOG-new.err" || must "$LOG-new" "ci runner new"
KEY_ID="$(jq_py "$LOG-new.json" 'd["keyId"]')"
check "enrolled" test "$(jq_py "$LOG-new.json" 'd["enrolled"] is not None')" = "True"

step "2. the first poll records the repository and runs nothing"
poll prime || { cat "$LOG-prime.log" >&2; bad "the first poll failed"; finish_scenario; }
check "nothing ran" bash -c "! grep -q ' = queued' '$LOG-prime.log'"

step "3. a pushed workflow runs, and its check is reported by the runner"
SRC="${WORKROOT}/s37-src"
seed_tiny_repo "$SRC" runner-base >/dev/null
mkdir -p "$SRC/.forge/workflows"
cat >"$SRC/.forge/workflows/ci.yml" <<'EOF'
name: e2e-runner
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "forge-runner e2e on $GITHUB_REF at $GITHUB_SHA"
EOF
git -C "$SRC" checkout -q -b runner
git -C "$SRC" add -A && git -C "$SRC" commit -qm "e2e runner workflow ${RUN_ID}"
SHA="$(git -C "$SRC" rev-parse HEAD)"
register_ref "refs/heads/${BASE}"
register_ref "refs/heads/${BR}"
git_dash_retry "$ID_OWNER" "$LOG-push" -C "$SRC" push "$E2E_REMOTE" \
  "refs/heads/runner-base:refs/heads/${BASE}" "refs/heads/runner:refs/heads/${BR}" \
  || { cat "$LOG-push.err" >&2; is_flake "$LOG-push.err" && skip_scenario "push flaked"; bad "push"; finish_scenario; }
ran=0
for _ in 1 2 3 4; do
  poll push || { cat "$LOG-push.log" >&2; break; }
  grep -q "${CHECK} = success" "$LOG-push.log" && { ran=1; break; }
  sleep 15 # the runner's node may not list the new ref yet
done
check "the poll ran the workflow: ${CHECK} = success" test "$ran" = 1
check "${CHECK}: completed/success on the commit, by the runner, trusted" \
  check_run "$SHA" "[('completed', 'success', True, '${RUNNER_ID}')]" "$LOG-st1"
FIRST_ID="$(jq_py "$LOG-st1.json" "[c['documentId'] for c in d['checks'] if c['name']=='$CHECK'][0]" 2>/dev/null)"

step "4. a re-run request (event kind 26) runs the check again"
dg_as "$ID_OWNER" --yes --json pr create "$REPO" --head "$BR" --base "$BASE" --title "e2e runner ${RUN_ID}" \
  >"$LOG-pr.json" 2>"$LOG-pr.err" || must "$LOG-pr" "pr create"
PR="$(jq_py "$LOG-pr.json" 'd["number"]')"
info "PR #${PR}"
dg_as "$ID_OWNER" --yes --json ci rerun "$REPO" "$PR" --check "$CHECK" \
  >"$LOG-rerun.json" 2>"$LOG-rerun.err" || must "$LOG-rerun" "ci rerun"
check "requested on the head" assert_eq "requested $SHA" "$(jq_py "$LOG-rerun.json" 'd["status"]+" "+d["sha"]')"
listed=0
for _ in 1 2 3 4 5 6; do
  if dg_read_retry "$ID_OWNER" "$LOG-reruns.json" "$LOG-reruns.err" --json ci reruns "$REPO" --since 0; then
    [[ "$(jq_py "$LOG-reruns.json" "[(r['sha'], r['check'], r['counts']) for r in d['requests'] if r['number']==$PR]")" == "[('$SHA', '$CHECK', True)]" ]] && { listed=1; break; }
  fi
  sleep 5
done
check "dg ci reruns lists it, counted" test "$listed" = 1
reran=0
for _ in 1 2 3 4; do
  poll rerun || { cat "$LOG-rerun.log" >&2; break; }
  grep -q "${CHECK} = success" "$LOG-rerun.log" && { reran=1; break; }
  sleep 15
done
check "the next poll re-ran it" test "$reran" = 1
check "…as the request asked, naming who asked" grep -q "re-run of ${CHECK} on ${SHA:0:12} by ${E2E_OWNER_ID}" "$LOG-rerun.log"
check "a newer completed run of the check, by the runner" \
  check_run "$SHA" "[('completed', 'success', True, '${RUNNER_ID}')]" "$LOG-st2"
check "…not the first one" test "$(jq_py "$LOG-st2.json" "[c['documentId'] for c in d['checks'] if c['name']=='$CHECK'][0]")" != "$FIRST_ID"
check "…its summary names who asked" assert_contains \
  "$(jq_py "$LOG-st2.json" "[c['summary'] for c in d['checks'] if c['name']=='$CHECK'][0]")" "re-run requested by ${E2E_OWNER_ID}"
poll again || true
check "a poll after it runs nothing" bash -c "! grep -q ' = queued' '$LOG-again.log'"

step "5. clean-up: close the PR, revoke the runner, disable its key"
dg_as "$ID_OWNER" --yes --json pr close "$REPO" "$PR" >"$LOG-close.json" 2>"$LOG-close.err" \
  || info "pr close failed; PR #${PR} stays open"
dg_as "$ID_OWNER" --yes --json ci runner revoke "$REPO" "$RUNNER_ID" >"$LOG-rev.json" 2>"$LOG-rev.err" \
  || info "runner revoke failed"
DASH_FORGE_KEY="$RUNNER" RUST_LOG=error NO_COLOR=1 _tmo "${DG}" --yes --json auth keys disable "$KEY_ID" --master "$RUNNER" \
  >"$LOG-dis.json" 2>"$LOG-dis.err" || info "disabling the runner key failed; it expires in a day"

finish_scenario
