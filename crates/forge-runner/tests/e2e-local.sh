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
#   6. a push without .forge/workflows runs nothing; a second poll re-runs nothing.
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
python3 - "$@" >>"$FAKE_DG_LOG" <<'PY'
import json, sys, os
a = sys.argv[1:]
d = {"args": a}
for i, x in enumerate(a):
    if x.startswith("--") and i + 1 < len(a) and not a[i + 1].startswith("--"):
        d[x[2:]] = a[i + 1]
if "log" in d:
    d["log_text"] = open(d["log"]).read()
d["env_key"] = os.environ.get("DASH_FORGE_KEY", "")
print(json.dumps(d))
PY
echo '{"status":"created","documentId":"doc"}'
EOF
chmod +x "$W/bin/dg"
export FAKE_DG_LOG="$W/reports.jsonl"; : >"$FAKE_DG_LOG"
export DASH_FORGE_KEY="dfk1:devnet:fake:9:fake"
printf 'E2E_SECRET=hunter2-%s\n' "$RANDOM" >"$W/secrets"

cat >"$W/runner.toml" <<EOF
state_dir = "$W/state"
interval_secs = 30
log_storage = "e2e-logs"
[platforms]
ubuntu-latest = "$IMAGE"
[bin]
dg = "$W/bin/dg"
[[repo]]
repo = "e2e/app"
url = "$R"
refs = ["refs/heads/**"]
trusted_refs = ["refs/heads/main"]
secrets_file = "$W/secrets"
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
      - run: echo "secret=[${{ secrets.E2E_SECRET }}]"; env | grep -c DASH_FORGE_ || echo NO-FORGE-KEY
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo testing; exit 3
EOF
# Things an attacker's checkout could plant; act must not read them.
printf -- '--privileged\n' >"$R/.actrc"
printf 'E2E_SECRET=planted\n' >"$R/.secrets"
git -C "$R" add -A; git -C "$R" commit -qm "ci"
SHA=$(git -C "$R" rev-parse HEAD)
poll
check "6 reports (2 jobs × queued, in_progress, completed)" test "$(q 'len(rs)')" = 6
check "build: success" test "$(q "[r['conclusion'] for r in rs if r.get('status')=='completed' and r['name']=='ci / build']")" = "['success']"
check "test: failure (exit 3)" test "$(q "[r['conclusion'] for r in rs if r.get('status')=='completed' and r['name']=='ci / test']")" = "['failure']"
check "every report names the pushed commit" test "$(q "sorted({r['sha'] for r in rs})")" = "['$SHA']"
check "one run id per job across its three reports" test "$(q "len({r['external-id'] for r in rs})")" = 2
check "status order queued → in_progress → completed" test "$(q "[r['status'] for r in rs if r['name']=='ci / build']")" = "['queued', 'in_progress', 'completed']"
check "the completed report uploads the job's log to the storage profile" test "$(q "[r.get('storage') for r in rs if r['status']=='completed']")" = "['e2e-logs', 'e2e-logs']"
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
check "main ran both jobs" test "$(q "len([r for r in rs if r['status']=='completed'])")" = 2
check "the secret reached the job (masked by act in the log)" test "$(q "'secret=[***]' in [r for r in rs if r['status']=='completed' and r['name']=='ci / build'][0]['log_text']")" = True
check "the secret value appears in no report" bash -c "! grep -q -- '$SECRET' '$FAKE_DG_LOG'"
check "the summary says it ran with secrets" test "$(q "all('with secrets' in r['summary'] for r in rs if r['status']=='completed')")" = True

echo "== 4. no workflows → nothing; a re-poll runs nothing again"
: >"$FAKE_DG_LOG"
git -C "$R" switch -q -c docs; git -C "$R" rm -rq .forge; git -C "$R" commit -qm "no ci"
poll; poll
check "no reports for a commit without .forge/workflows, nor on a re-poll" test "$(wc -l <"$FAKE_DG_LOG" | tr -d ' ')" = 0

if [[ $fails -gt 0 ]]; then echo "FAIL ($fails)"; sed -n '1,200p' "$W/runner.log"; exit 1; fi
echo "PASS forge-runner local e2e"
