#!/usr/bin/env bash
# forge-runner local end-to-end: a throwaway git repository stands in for dash:// (the repo's
# `url` override), a recording `dg` stands in for `dg ci report`, and nektos/act runs the
# workflows in Docker for real. No Platform writes. Needs: docker, act, the forge-runner binary.
#
#   bash crates/forge-runner/tests/e2e-local.sh [path/to/forge-runner]
#
# Checks:
#   1. the first poll records the tips and runs nothing;
#   2. a push runs every job of .forge/workflows: queued, in_progress, completed reports, one run id
#      per job, conclusions success / failure from the jobs' exit codes, each job's log on disk;
#   3. job containers have no Docker socket, and no secrets on an untrusted ref;
#   4. a trusted ref gets the secrets file; its value never appears in a report;
#   5. the checkout's own .actrc / .secrets / .env are ignored;
#   6. a job with container.options, and a reusable-workflow call, are refused (one failed check
#      each, with the reason) and never reach act; an invalid workflow file is one failed check;
#      a workflow whose on.push.branches excludes the ref does not run; GITHUB_TOKEN is empty;
#   7. a push without .forge/workflows runs nothing; a second poll re-runs nothing;
#   8. pull requests (a recording `dg pr list`): a member's PR from a trusted branch here runs
#      as `pull_request` with GitHub's context and the secrets; a member's PR from a fork runs
#      without them; a stranger's is skipped, then runs by hand (`run --pr`) without them; a
#      moved head is a `synchronize`; a closed PR and a re-poll run nothing.
#   9. CI re-run requests (a recording `dg ci reruns`): a member's request re-runs one PR check
#      on the head, said in its summary; a duplicate in the same poll, an uncounted request and
#      one for a head that moved run nothing; a push check re-runs as the push of the PR's
#      branch; a re-poll runs nothing again.
#  10. A request for every check covers a named one beside it; one whose PR could not be read
#      runs nothing and is tried again on the next poll.
#  11. `schedule = true`: the cron expressions of the default branch whose time came run its
#      workflow once, as `schedule` on the branch's tip (github.ref the branch), its checks named
#      `(schedule)` and the job seeing the cron; an invalid expression is logged, never run; an
#      expression runs at most every five minutes; a HEAD that is not the default branch runs
#      no schedule.
#  12. Path filters: a PR that changes no file a workflow's `paths` selects gets `skipped` for each
#      of its checks the branch policy requires and nothing for the rest; when the policy can't be
#      read, every one of its checks is reported.
#  13. A push whose `paths` filter leaves out a workflow: a job whose check the branch policy
#      requires runs for real (its unrequired jobs do not, and nothing is reported skipped); with
#      no policy requiring it, nothing runs.
set -uo pipefail
RUNNER="${1:-${CARGO_TARGET_DIR:-target}/debug/forge-runner}"
[[ -x "$RUNNER" ]] || { echo "SKIP: no forge-runner binary at $RUNNER"; exit 2; }
command -v act >/dev/null || { echo "SKIP: act not installed"; exit 2; }
docker info >/dev/null 2>&1 || { echo "SKIP: docker not running"; exit 2; }
IMAGE="${FORGE_RUNNER_E2E_IMAGE:-node:20-bookworm-slim}"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null || { echo "SKIP: cannot pull $IMAGE"; exit 2; }

W=$(mktemp -d "${TMPDIR:-/tmp}/forge-runner-e2e.XXXXXX")
trap 'rm -rf "$W"' EXIT
fails=0
ok()  { echo "  [ok]   $*"; }
bad() { echo "  [FAIL] $*"; fails=$((fails + 1)); }
check() { local d="$1"; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }

# --- the "remote": a plain git repository -------------------------------------------------
R="$W/remote"; mkdir -p "$R"
git -C "$R" init -q -b main
git -C "$R" config user.email e2e@forge.test; git -C "$R" config user.name e2e; git -C "$R" config commit.gpgsign false
echo seed >"$R/README.md"; git -C "$R" add README.md; git -C "$R" commit -qm seed

# --- a dg that records each report as one JSON line --------------------------------------------
mkdir -p "$W/bin"
cat >"$W/bin/dg" <<'EOF'
#!/usr/bin/env bash
# Reads answer from fixture files (and are not recorded); reports are recorded.
case " $* " in
  *" pr list "*" --include-hidden "*) cat "$FAKE_PRS" 2>/dev/null || echo '{"prs":[]}'; exit 0 ;;
  *" pr list "*) echo "fake dg: the runner must list hidden PRs too (--include-hidden)" >&2; exit 2 ;;
  *" pr view "*) [[ -e "$FAKE_VIEW_FAILS" ]] && { echo "fake dg: the node did not answer" >&2; exit 1; }
                python3 -c "import json,sys; print(json.dumps([p for p in json.load(open(sys.argv[1]))['prs'] if p['number']==int(sys.argv[2])][0]))" "$FAKE_PRS" "${@: -1}"; exit 0 ;;
  *" ci reruns "*) cat "$FAKE_RERUNS" 2>/dev/null || echo '{"requests":[]}'; exit 0 ;;
  *" repo view "*) cat "$FAKE_REPO" 2>/dev/null || echo '{"defaultBranch":"main"}'; exit 0 ;;
  *" repo policy show "*) [[ -e "$FAKE_POLICY_FAILS" ]] && { echo "fake dg: the node did not answer" >&2; exit 1; }
                         cat "$FAKE_POLICY" 2>/dev/null || echo '{"policy":null}'; exit 0 ;;
  *" collab list "*) echo '{"members":[{"identityId":"MEMBER","role":"maintainer"}],"roles":true,"ownerId":"OWNER"}'; exit 0 ;;
esac
python3 - "$@" >>"$FAKE_DG_LOG" <<'PY'
import json, sys, os
a = sys.argv[1:]
d = {"args": a}
for i, x in enumerate(a):
    if x.startswith("--") and i + 1 < len(a) and not a[i + 1].startswith("--"):
        d[x[2:]] = a[i + 1]
d["artifact_zips"] = []
for i, x in enumerate(a):
    if x == "--artifact" and i + 1 < len(a):
        import zipfile
        with zipfile.ZipFile(a[i + 1]) as z:
            d["artifact_zips"].append({n: z.read(n).decode(errors="replace") for n in z.namelist()})
if "log" in d:
    d["log_text"] = open(d["log"]).read()
d["env_key"] = os.environ.get("DASH_FORGE_KEY", "")
print(json.dumps(d))
PY
echo '{"status":"created","documentId":"doc"}'
EOF
chmod +x "$W/bin/dg"
export FAKE_DG_LOG="$W/reports.jsonl"; : >"$FAKE_DG_LOG"
export FAKE_PRS="$W/prs.json"
export FAKE_RERUNS="$W/reruns.json"
export FAKE_VIEW_FAILS="$W/view-fails"
export FAKE_REPO="$W/repo.json"
export FAKE_POLICY="$W/policy.json"
export FAKE_POLICY_FAILS="$W/policy-fails"
export DASH_FORGE_KEY="dfk1:devnet:fake:9:fake"
printf 'E2E_SECRET=hunter2-%s\n' "$RANDOM" >"$W/secrets"

# act's artifact server: jobs must reach it (default: the Linux Docker bridge's gateway). On Docker
# Desktop or OrbStack, containers reach the host by name only: FORGE_RUNNER_E2E_ARTIFACT_ADDR=127.0.0.1
# FORGE_RUNNER_E2E_ARTIFACT_URL=http://host.docker.internal:34567/ .
ARTIFACT_CFG=""
ARTIFACT_CFG+="artifact_server_addr = \"${FORGE_RUNNER_E2E_ARTIFACT_ADDR:-172.17.0.1}\""$'\n'
[[ -n "${FORGE_RUNNER_E2E_ARTIFACT_URL:-}" ]] && ARTIFACT_CFG+="artifact_server_url = \"$FORGE_RUNNER_E2E_ARTIFACT_URL\""$'\n'
cat >"$W/runner.toml" <<EOF
state_dir = "$W/state"
interval_secs = 30
log_storage = "e2e-logs"
artifacts = true
$ARTIFACT_CFG
[platforms]
ubuntu-latest = "$IMAGE"
[bin]
dg = "$W/bin/dg"
[[repo]]
repo = "e2e/app"
url = "$R"
refs = ["refs/heads/**"]
trusted_refs = ["refs/heads/main", "refs/heads/release/*"]
secrets_file = "$W/secrets"
fork_url = "$W/{id}"
schedule = true
EOF
poll() { "$RUNNER" -c "$W/runner.toml" watch --once >>"$W/runner.log" 2>&1; }
reports() { python3 -c "import json,sys; [print(json.dumps(json.loads(l))) for l in open('$FAKE_DG_LOG')]"; }
q() { python3 -c "import json,sys; rs=[json.loads(l) for l in open('$FAKE_DG_LOG')]; print($1)"; }

echo "== 1. first poll records, runs nothing"
poll
check "no reports on the first poll" test "$(wc -l <"$FAKE_DG_LOG" | tr -d ' ')" = 0

echo "== 2. a push to an untrusted branch runs its jobs, without secrets or socket"
git -C "$R" switch -q -c feature
mkdir -p "$R/.forge/workflows"
cat >"$R/.forge/workflows/ci.yml" <<'EOF'
name: ci
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "building $GITHUB_REF at $GITHUB_SHA"; test ! -e /var/run/docker.sock && echo NO-DOCKER-SOCKET
      - run: echo "secret=[${{ secrets.E2E_SECRET }}]"; env | grep -c DASH_FORGE_ || echo NO-FORGE-KEY; echo "token=[${{ secrets.GITHUB_TOKEN }}]"
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo testing; exit 3
  escape:
    runs-on: ubuntu-latest
    container:
      image: IMAGE_PLACEHOLDER
      options: --privileged -v /var/run/docker.sock:/var/run/docker.sock
    steps:
      - run: echo ESCAPED
  nested:
    uses: ./.forge/workflows/other.yml
EOF
sed -i.bak "s|IMAGE_PLACEHOLDER|$IMAGE|" "$R/.forge/workflows/ci.yml" && rm -f "$R/.forge/workflows/ci.yml.bak"
cat >"$R/.forge/workflows/main-only.yml" <<'EOF'
name: main-only
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploying
EOF
printf 'jobs: [\n' >"$R/.forge/workflows/broken.yml"
# Things an attacker's checkout could plant; act must not read them.
printf -- '--privileged\n' >"$R/.actrc"
printf 'E2E_SECRET=planted\n' >"$R/.secrets"
git -C "$R" add -A; git -C "$R" commit -qm "ci"
SHA=$(git -C "$R" rev-parse HEAD)
poll
check "8 reports (2 jobs × 3, 2 refusals); the broken file is 1 more" test "$(q 'len(rs)')" = 9
check "build: success" test "$(q "[r['conclusion'] for r in rs if r.get('status')=='completed' and r['name']=='ci / build']")" = "['success']"
check "test: failure (exit 3)" test "$(q "[r['conclusion'] for r in rs if r.get('status')=='completed' and r['name']=='ci / test']")" = "['failure']"
check "every report names the pushed commit" test "$(q "sorted({r['sha'] for r in rs})")" = "['$SHA']"
check "one run id per check across its reports" test "$(q "len({r['external-id'] for r in rs})")" = 5
check "container.options job refused, with the reason" test "$(q "[(r['status'], r['conclusion'], 'container.options' in r['summary']) for r in rs if r['name']=='ci / escape']")" = "[('completed', 'failure', True)]"
check "reusable-workflow call refused" test "$(q "[('uses:' in r['summary']) for r in rs if r['name']=='ci / nested']")" = "[True]"
check "the refused job never ran" bash -c "! grep -q ESCAPED '$FAKE_DG_LOG'"
check "an invalid workflow file is one failed check" test "$(q "[r['conclusion'] for r in rs if 'broken.yml' in r['name']]")" = "['failure']"
check "a main-only workflow does not run on a feature branch" test "$(q "len([r for r in rs if r['name'].startswith('main-only')])")" = 0
check "GITHUB_TOKEN is empty on an untrusted ref" test "$(q "'token=[]' in [r for r in rs if r['status']=='completed' and r['name']=='ci / build'][0]['log_text']")" = True
check "status order queued → in_progress → completed" test "$(q "[r['status'] for r in rs if r['name']=='ci / build']")" = "['queued', 'in_progress', 'completed']"
check "each run job's completed report uploads its log; refusals carry none" test "$(q "sorted((r['name'], r.get('storage')) for r in rs if r['status']=='completed')")" = "[('.forge/workflows/broken.yml (invalid workflow)', None), ('ci / build', 'e2e-logs'), ('ci / escape', None), ('ci / nested', None), ('ci / test', 'e2e-logs')]"
check "the job sees the pushed ref and commit" test "$(q "'building refs/heads/feature at $SHA' in [r for r in rs if r['status']=='completed' and r['name']=='ci / build'][0]['log_text']")" = True
check "no Docker socket in the job container" test "$(q "'NO-DOCKER-SOCKET' in [r for r in rs if r['status']=='completed' and r['name']=='ci / build'][0]['log_text']")" = True
check "no secrets on an untrusted ref (and none from the planted .secrets)" test "$(q "'secret=[]' in [r for r in rs if r['status']=='completed' and r['name']=='ci / build'][0]['log_text']")" = True
check "the runner's Forge key never reaches a job" test "$(q "'NO-FORGE-KEY' in [r for r in rs if r['status']=='completed' and r['name']=='ci / build'][0]['log_text']")" = True
check "dg is called with the runner key from the environment" test "$(q "{r['env_key'] for r in rs}")" = "{'dfk1:devnet:fake:9:fake'}"

echo "== 3. a push to the trusted branch gets the secrets"
: >"$FAKE_DG_LOG"
git -C "$R" switch -q main; git -C "$R" merge -q --ff-only feature
poll
SECRET=$(cut -d= -f2 "$W/secrets")
check "main ran build, test and main-only (and refused 2, broken 1)" test "$(q "sorted(r['name'] for r in rs if r['status']=='completed' and r.get('log'))")" = "['ci / build', 'ci / test', 'main-only / deploy']"
check "the secret reached the job (masked by act in the log)" test "$(q "'secret=[***]' in [r for r in rs if r['status']=='completed' and r['name']=='ci / build'][0]['log_text']")" = True
check "the secret value appears in no report" bash -c "! grep -q -- '$SECRET' '$FAKE_DG_LOG'"
check "the summary says it ran with secrets" test "$(q "all('with secrets' in r['summary'] for r in rs if r['status']=='completed' and r.get('log'))")" = True

echo "== 4. no workflows → nothing; a re-poll runs nothing again"
: >"$FAKE_DG_LOG"
git -C "$R" switch -q -c docs; git -C "$R" rm -rq .forge; git -C "$R" commit -qm "no ci"
poll; poll
check "no reports for a commit without .forge/workflows, nor on a re-poll" test "$(wc -l <"$FAKE_DG_LOG" | tr -d ' ')" = 0

echo "== 5. pull requests: a member's from a trusted branch here, a member's fork, a stranger's fork"
: >"$FAKE_DG_LOG"
prwf() {
  mkdir -p .forge/workflows
  cat >.forge/workflows/pr.yml <<'EOF'
name: pr
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: echo "action=${{ github.event.action }} number=${{ github.event.number }} head=$GITHUB_HEAD_REF base=$GITHUB_BASE_REF ref=$GITHUB_REF fork=${{ github.event.pull_request.head.repo.fork }}"
      - run: echo "secret=[${{ secrets.E2E_SECRET }}] token=[${{ secrets.GITHUB_TOKEN }}]"
EOF
}
# PR #1: a member's, from release/1 in the repository itself (a trusted ref).
git -C "$R" switch -q -c release/1 docs
(cd "$R" && prwf && git add -A && git commit -qm "pr ci")
H1=$(git -C "$R" rev-parse HEAD)
# PRs #2 and #3: the same workflow from a fork's branch.
git clone -q "$R" "$W/fork"
git -C "$W/fork" switch -q -c evil release/1
echo evil >"$W/fork/evil.txt"; git -C "$W/fork" add evil.txt; git -C "$W/fork" commit -qm evil
git -C "$W/fork" tag v9.9.9   # a fork's tag must never reach the repository's cache
HF=$(git -C "$W/fork" rev-parse HEAD)
prs() { python3 - "$@" >"$FAKE_PRS" <<'PY'
import json, sys
rows = []
for spec in sys.argv[1:]:
    n, author, src, ref, head, state = spec.split(",")
    rows.append({"number": int(n), "title": f"pr {n}", "author": author, "state": state,
                 "baseRef": "refs/heads/main", "baseTip": None, "headOid": head,
                 "repoId": "app", "sourceRepoId": src, "sourceRefName": ref, "draft": False})
print(json.dumps({"count": len(rows), "prs": rows}))
PY
}
prs "1,MEMBER,app,refs/heads/release/1,$H1,open" "2,STRANGER,fork,refs/heads/evil,$HF,open" "3,MEMBER,fork,refs/heads/evil,$HF,open"
poll
check "the pushed release/1 ran nothing on push (its workflow is pull_request only)" test "$(q "len([r for r in rs if 'pull_request' not in r['name']])")" = 0
check "two PR runs (the members'); the stranger's PR is skipped" test "$(q "len([r for r in rs if r['status']=='completed'])")" = 2
check "checks are named '(pull_request)'" test "$(q "sorted({r['name'] for r in rs})")" = "['pr / check (pull_request)']"
check "…and posted on the heads" test "$(q "sorted(set(r['sha'] for r in rs)) == sorted(['$H1', '$HF'])")" = True
check "the job sees GitHub's pull_request context" test "$(q "'action=opened number=1 head=release/1 base=main ref=refs/pull/1/merge fork=false' in [r['log_text'] for r in rs if r['status']=='completed' and r['sha']=='$H1'][0]")" = True
check "a member's PR from a trusted branch here gets the secrets" test "$(q "'secret=[***]' in [r['log_text'] for r in rs if r['status']=='completed' and r['sha']=='$H1'][0]")" = True
check "a member's PR from a fork gets no secrets and an empty token" test "$(q "'secret=[] token=[]' in [r['log_text'] for r in rs if r['status']=='completed' and r['sha']=='$HF'][0]")" = True
check "the fork's run knows it is a fork" test "$(q "'fork=true' in [r['log_text'] for r in rs if r['status']=='completed' and r['sha']=='$HF'][0]")" = True
CACHE="$W/state/work/e2e__app/cache.git"
check "a fork's tags never reach the repository's cache" bash -c "! git --git-dir '$CACHE' tag -l | grep -q v9.9.9"
check "nor do its objects (a fork runs from a cache of its own)" bash -c "! git --git-dir '$CACHE' cat-file -e '$HF' 2>/dev/null"
check "PR runs are keyed apart from each other" test "$(q "len({r['external-id'] for r in rs})")" = 2
check "the stranger's PR is logged as skipped" grep -q "PR #2 by STRANGER not run: not a member" "$W/runner.log"
check "a re-poll runs nothing again" bash -c ": >'$FAKE_DG_LOG'; '$RUNNER' -c '$W/runner.toml' watch --once >>'$W/runner.log' 2>&1; test ! -s '$FAKE_DG_LOG'"

echo "== 6. a pull request's head moves (synchronize); a stranger's runs by hand, without secrets"
: >"$FAKE_DG_LOG"
echo more >>"$R/README.md"; git -C "$R" commit -qam more
H1B=$(git -C "$R" rev-parse HEAD)
prs "1,MEMBER,app,refs/heads/release/1,$H1B,open" "2,STRANGER,fork,refs/heads/evil,$HF,open" "3,MEMBER,fork,refs/heads/evil,$HF,closed"
poll
check "synchronize runs the new head, with before and after" test "$(q "[('action=synchronize' in r['log_text']) for r in rs if r['status']=='completed' and r['sha']=='$H1B']")" = "[True]"
check "nothing else ran (a closed PR does not)" test "$(q "len([r for r in rs if r['status']=='completed'])")" = 1
: >"$FAKE_DG_LOG"
"$RUNNER" -c "$W/runner.toml" run e2e/app --pr 2 >>"$W/runner.log" 2>&1
check "run --pr runs the stranger's head" test "$(q "[r['sha'] for r in rs if r['status']=='completed']")" = "['$HF']"
check "…with no secrets" test "$(q "'secret=[] token=[]' in [r['log_text'] for r in rs if r['status']=='completed'][0]")" = True
check "the secret value appears in no PR report" bash -c "! grep -q -- '$SECRET' '$FAKE_DG_LOG'"

echo "== 7. artifacts: upload-artifact v4 and v3, attributed to the job that uploaded them"
: >"$FAKE_DG_LOG"
git -C "$R" switch -q -c art docs
mkdir -p "$R/.forge/workflows"
cat >"$R/.forge/workflows/art.yml" <<'EOF'
name: art
on: push
jobs:
  up4:
    runs-on: ubuntu-latest
    steps:
      - run: mkdir -p out/sub && echo four >out/a.txt && echo deep >out/sub/b.txt
      - uses: actions/upload-artifact@v4
        with: { name: dist4, path: out }
  up3:
    runs-on: ubuntu-latest
    steps:
      - run: mkdir -p out && echo three >out/c.txt
      - uses: actions/upload-artifact@v3
        with: { name: dist3, path: out }
  none:
    runs-on: ubuntu-latest
    steps:
      - run: echo uploads nothing
EOF
git -C "$R" add -A; git -C "$R" commit -qm art
poll
art() { q "[r.get('artifact_zips') for r in rs if r['status']=='completed' and r['name']=='art / $1']"; }
check "v4: the job's zip is recorded as it was uploaded" test "$(art up4)" = "[[{'a.txt': 'four\\n', 'sub/b.txt': 'deep\\n'}]]"
check "v3: the job's files are zipped" test "$(art up3)" = "[[{'c.txt': 'three\\n'}]]"
check "a job that uploads nothing carries none" test "$(art none)" = "[[]]"
check "the summary counts them" test "$(q "[('1 artifact' in r['summary']) for r in rs if r['status']=='completed' and r['name']=='art / up4']")" = "[True]"

echo "== 9. CI re-run requests"
: >"$FAKE_DG_LOG"
FEAT=$(git -C "$R" rev-parse feature)
prs "1,MEMBER,app,refs/heads/release/1,$H1B,open" "2,STRANGER,fork,refs/heads/evil,$HF,open" "4,MEMBER,app,refs/heads/feature,$FEAT,open"
poll   # PR #4 opens: feature has push workflows only, so nothing runs
: >"$FAKE_DG_LOG"
NOW=$(python3 -c 'import time; print(int(time.time() * 1000))')
python3 - "$NOW" "$H1" "$H1B" "$FEAT" >"$FAKE_RERUNS" <<'PY'
import json, sys
now, h1, h1b, feat = int(sys.argv[1]), *sys.argv[2:]
def req(i, n, sha, check, who, counts, dt):
    return {"id": f"E{i}", "targetId": f"T{n}", "number": n, "sha": sha, "check": check,
            "requester": who, "createdAt": now + dt, "counts": counts}
print(json.dumps({"requests": [
    req(1, 1, h1b, "pr / check (pull_request)", "MEMBER", True, 1),
    req(2, 1, h1b, "pr / check (pull_request)", "MEMBER", True, 2),
    req(3, 1, h1b, None, "TRIAGE", False, 3),
    req(4, 1, h1, None, "MEMBER", True, 4),
    req(5, 4, feat, "ci / test", "MEMBER", True, 5),
]}))
PY
poll
check "the PR check re-ran once on the head" test "$(q "[r['sha'] for r in rs if r['status']=='completed' and r['name']=='pr / check (pull_request)']")" = "['$H1B']"
check "…saying who asked" test "$(q "['re-run requested by MEMBER' in r['summary'] for r in rs if r['status']=='completed' and r['name']=='pr / check (pull_request)']")" = "[True]"
check "a duplicate in the same poll is coalesced" grep -q "the same as an earlier request in this poll" "$W/runner.log"
check "an uncounted request runs nothing" grep -q "by TRIAGE not run: the requester is not" "$W/runner.log"
check "a request for a head that moved runs nothing" grep -q "not run: its head moved" "$W/runner.log"
check "a push check re-runs its workflow as the branch's push" test "$(q "sorted(r['name'] for r in rs if r['status']=='completed' and r['sha']=='$FEAT')")" = "['ci / build', 'ci / escape', 'ci / nested', 'ci / test']"
check "…and nothing else ran" test "$(q "len([r for r in rs if r['status']=='completed'])")" = 5
check "a re-poll runs no request again" bash -c ": >'$FAKE_DG_LOG'; '$RUNNER' -c '$W/runner.toml' watch --once >>'$W/runner.log' 2>&1; test ! -s '$FAKE_DG_LOG'"

echo "== 10. Every check covers a named one; a failed read is tried again"
: >"$FAKE_DG_LOG"
NOW=$(python3 -c 'import time; print(int(time.time() * 1000))')
python3 - "$NOW" "$H1B" >"$FAKE_RERUNS" <<'PY'
import json, sys
now, h1b = int(sys.argv[1]), sys.argv[2]
def req(i, check, dt):
    return {"id": f"F{i}", "targetId": "T1", "number": 1, "sha": h1b, "check": check,
            "requester": "MEMBER", "createdAt": now + dt, "counts": True}
print(json.dumps({"requests": [req(1, "pr / check (pull_request)", 1), req(2, None, 2)]}))
PY
touch "$FAKE_VIEW_FAILS"
poll
check "a request whose PR could not be read runs nothing" test ! -s "$FAKE_DG_LOG"
check "…and is tried again" grep -q "re-run of every check on .* (attempt 1 of" "$W/runner.log"
rm -f "$FAKE_VIEW_FAILS"
poll
check "the next poll runs the PR check once" test "$(q "len([r for r in rs if r['status']=='completed' and r['name']=='pr / check (pull_request)'])")" = 1
check "…the named request covered by the one for every check" grep -q "covered by a request for every check in this poll" "$W/runner.log"
check "a re-poll runs neither again" bash -c ": >'$FAKE_DG_LOG'; '$RUNNER' -c '$W/runner.toml' watch --once >>'$W/runner.log' 2>&1; test ! -s '$FAKE_DG_LOG'"

echo "== 11. schedule"
: >"$FAKE_DG_LOG"
# An orphan branch with a schedule-only workflow, made the default branch (HEAD of the remote).
git -C "$R" switch -q --orphan sched
git -C "$R" rm -rqf . 2>/dev/null
mkdir -p "$R/.forge/workflows"
cat >"$R/.forge/workflows/nightly.yml" <<'EOF'
name: nightly
on:
  schedule:
    - cron: '* * * * *'
    - cron: '*/1  * * * *'
    - cron: '0 0 1 1 *'
    - cron: '61 * * * *'
jobs:
  sweep:
    runs-on: ubuntu-latest
    steps:
      - run: node -e 'console.log("cron=[" + require(process.env.GITHUB_EVENT_PATH).schedule + "] event=" + process.env.GITHUB_EVENT_NAME + " ref=" + process.env.GITHUB_REF)'
EOF
echo '{"defaultBranch":"sched"}' >"$FAKE_REPO"
git -C "$R" add -A; git -C "$R" commit -qm nightly
SCHED=$(git -C "$R" rev-parse HEAD)
poll   # the push runs nothing (no push workflow); the tip's expressions are read
check "a schedule-only workflow runs nothing on its push" test "$(q "len([r for r in rs if r['sha']=='$SCHED' and not r['name'].endswith(' (schedule)')])")" = 0
check "an invalid expression is logged, not run" grep -q 'nightly.yml: schedule "61 \* \* \* \*" not run' "$W/runner.log"
# Three minutes pass (the cursor goes back): '* * * * *' fired three times, and runs once.
python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['schedule_since']-=180000; json.dump(d,open(p,'w'))" "$W/state/repos/e2e__app.json"
: >"$FAKE_DG_LOG"
poll
check "the cron whose time came ran once, on the default branch's tip" test "$(q "[(r['name'], r['sha'], r['conclusion']) for r in rs if r['status']=='completed']")" = "[('nightly / sweep (schedule)', '$SCHED', 'success')]"
check "…as schedule on the branch, seeing the cron" test "$(q "'cron=[* * * * *] event=schedule ref=refs/heads/sched' in [r for r in rs if r['status']=='completed'][0]['log_text']")" = True
sched_back() { python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['schedule_since']-=180000; json.dump(d,open(p,'w'))" "$W/state/repos/e2e__app.json"; }
sched_back; : >"$FAKE_DG_LOG"; poll
check "an expression runs at most every five minutes" test ! -s "$FAKE_DG_LOG"
# HEAD names a branch that is not the default one (the helper's fallback when it is missing).
echo '{"defaultBranch":"gone"}' >"$FAKE_REPO"
python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['schedule_ran']={}; d['schedule_tip']=None; json.dump(d,open(p,'w'))" "$W/state/repos/e2e__app.json"
sched_back; : >"$FAKE_DG_LOG"; poll
check "a HEAD that is not the default branch runs no schedule" test ! -s "$FAKE_DG_LOG"
check "…and says so" grep -q "the default branch gone is missing; no schedule runs" "$W/runner.log"

echo "== 12. path filters: a required check the PR's paths filter out is reported skipped"
: >"$FAKE_DG_LOG"
git -C "$R" switch -q -c filt main
git -C "$R" rm -rq --ignore-unmatch .forge
mkdir -p "$R/.forge/workflows" "$R/docs"
cat >"$R/.forge/workflows/paths.yml" <<'EOF'
name: paths
on:
  pull_request:
    paths: ['src/**']
jobs:
  req:
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
  other:
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
EOF
echo hi >"$R/docs/x.md"
git -C "$R" add -A; git -C "$R" commit -qm "docs only"
HFILT=$(git -C "$R" rev-parse HEAD)
prs "4,MEMBER,app,refs/heads/filt,$HFILT,open"
echo '{"repo":"e2e/app","policy":{"requiredChecks":["paths / req (pull_request)"]}}' >"$FAKE_POLICY"
"$RUNNER" -c "$W/runner.toml" run e2e/app --pr 4 >>"$W/runner.log" 2>&1
check "the required check is reported skipped on the head, and nothing else" test "$(q "[(r['name'], r['sha'], r['status'], r['conclusion']) for r in rs]")" = "[('paths / req (pull_request)', '$HFILT', 'completed', 'skipped')]"
check "…saying why" test "$(q "'PR #4 changes no file' in rs[0]['summary']")" = True
: >"$FAKE_DG_LOG"; touch "$FAKE_POLICY_FAILS"
"$RUNNER" -c "$W/runner.toml" run e2e/app --pr 4 >>"$W/runner.log" 2>&1
rm -f "$FAKE_POLICY_FAILS"
check "an unreadable policy reports every filtered check" test "$(q "sorted(r['name'] for r in rs)")" = "['paths / other (pull_request)', 'paths / req (pull_request)']"

echo "== 13. a push whose paths filter leaves out a required check runs that job for real"
echo '{"repo":"e2e/app","policy":{"requiredChecks":["pp / req"]}}' >"$FAKE_POLICY"
git -C "$R" switch -q -c pfilt main
git -C "$R" rm -rq --ignore-unmatch .forge
mkdir -p "$R/.forge/workflows" "$R/docs"
cat >"$R/.forge/workflows/pp.yml" <<'EOF'
name: pp
on:
  push:
    paths: ['src/**']
jobs:
  req:
    runs-on: ubuntu-latest
    steps:
      - run: echo required-ran
  other:
    runs-on: ubuntu-latest
    steps:
      - run: echo other-ran
EOF
echo start >"$R/docs/p.md"
git -C "$R" add -A; git -C "$R" commit -qm "pfilt: start"
poll
# A docs-only push: the filter leaves the workflow out.
echo more >>"$R/docs/p.md"; git -C "$R" add -A; git -C "$R" commit -qm "pfilt: docs"
HP=$(git -C "$R" rev-parse pfilt)
: >"$FAKE_DG_LOG"; poll
check "the required check runs for real on the push" test "$(q "[(r['name'], r['conclusion']) for r in rs if r['sha']=='$HP' and r['status']=='completed']")" = "[('pp / req', 'success')]"
check "…the unrequired one does not, and nothing is skipped" test "$(q "sorted(set(r['name'] for r in rs if r['sha']=='$HP'))")" = "['pp / req']"
check "…and the log says why" grep -q "pp.yml runs although its \`paths\` filter leaves this push out: the branch policy requires \"req\"" "$W/runner.log"
# No policy requires it: the filtered workflow costs nothing.
echo '{"repo":"e2e/app","policy":null}' >"$FAKE_POLICY"
echo again >>"$R/docs/p.md"; git -C "$R" add -A; git -C "$R" commit -qm "pfilt: docs again"
HP2=$(git -C "$R" rev-parse pfilt)
: >"$FAKE_DG_LOG"; poll
check "without a policy requiring it, a filtered push workflow runs nothing" test "$(q "[r['name'] for r in rs if r['sha']=='$HP2']")" = "[]"

check "no act container, volume or network left behind" bash -c "! docker ps -a --format '{{.Names}}' | grep -q '^act-e2e'"

if [[ $fails -gt 0 ]]; then echo "FAIL ($fails)"; sed -n '1,200p' "$W/runner.log"; exit 1; fi
echo "PASS forge-runner local e2e"
