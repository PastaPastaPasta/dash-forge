#!/usr/bin/env bash
# Offline tests for the check action: resolve.sh's argument building and refusals, and
# report.sh against a fake `dg`. Run: bash check-action/test.sh
# Literal $(...) in single quotes below are inputs that must be rejected.
# shellcheck disable=SC2016
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
fail() { echo "FAIL [$case] $*"; fails=$((fails + 1)); }

SHA=5950173cee3d651ec03af8c7257bf764a843d747
HEAD=1111111111111111111111111111111111111111
# resolve <env assignments...>: runs resolve.sh in a clean GitHub-like environment.
resolve() {
  : >"$tmp/out"
  env -i PATH="$PATH" RUNNER_TEMP="$tmp" GITHUB_OUTPUT="$tmp/out" \
    GITHUB_SERVER_URL=https://github.com GITHUB_REPOSITORY=acme/app GITHUB_RUN_ID=42 GITHUB_RUN_ATTEMPT=2 \
    GITHUB_RUN_NUMBER=7 GITHUB_WORKFLOW=CI GITHUB_JOB=build GITHUB_SHA="$SHA" \
    INPUT_REPO=alice/project INPUT_STATUS=completed INPUT_NETWORK=mainnet "$@" \
    bash "$here/resolve.sh" >"$tmp/stdout" 2>&1
}
args() { cat "$(sed -n 's/^args-file=//p' "$tmp/out")"; }
out_of() { sed -n "s/^$1=//p" "$tmp/out"; }
has() { # has <exact argument line>
  args | grep -qxF -- "$1" || fail "missing argument: $1"
}
lacks_prefix() { # lacks_prefix <prefix>
  ! args | grep -q -- "^$1" || fail "unexpected argument starting $1"
}

case=push-success
resolve INPUT_JOB_STATUS=success || fail "exit $?: $(cat "$tmp/stdout")"
has "--sha=$SHA"
has "--conclusion=success"
has "--details-url=https://github.com/acme/app/actions/runs/42/attempts/2"
has "--name=CI / build"
has "--external-id=gh:42:2:build:0:CI / build"
has "--network=mainnet"
has "--summary=GitHub Actions: CI / build (run 7, attempt 2)"
lacks_prefix "--devnet-name"
[[ "$(out_of sha)" == "$SHA" ]] || fail "sha output"
[[ "$(out_of name)" == "CI / build" ]] || fail "name output"
args | grep -qv -- '^--' || true
# Every argument after the subcommand is --flag=value (or a bare flag), so no value is a flag.
while IFS= read -r a; do
  case "$a" in ci|report|alice/project|--yes|--json|--public-log|--*=*) ;; *) fail "argument not --flag=value: $a";; esac
done < <(args)

case="pull request reports the head, not the merge commit"
resolve INPUT_JOB_STATUS=failure PR_HEAD_SHA=$HEAD || fail "exit $?"
has "--sha=$HEAD"
has "--conclusion=failure"
[[ "$(out_of sha)" == "$HEAD" ]] || fail "sha output is the head"

case="explicit sha wins, dash url, devnet"
resolve INPUT_JOB_STATUS=success PR_HEAD_SHA=$HEAD INPUT_SHA=ABCDEF0123456789ABCDEF0123456789ABCDEF01 INPUT_REPO=dash://alice/project \
  INPUT_NETWORK=devnet INPUT_DEVNET_NAME=bonsia || fail "exit $?"
has "--sha=abcdef0123456789abcdef0123456789abcdef01"
has "alice/project"
has "--devnet-name=bonsia"

case="matrix legs are separate checks"
resolve INPUT_JOB_STATUS=success JOB_TOTAL=2 JOB_INDEX=1 MATRIX_JSON='{"os":"ubuntu","rust":1.8}' || fail "exit $?"
has "--name=CI / build (ubuntu, 1.8)"
has "--external-id=gh:42:2:build:1:CI / build (ubuntu, 1.8)"
resolve INPUT_JOB_STATUS=success JOB_TOTAL=2 JOB_INDEX=0 MATRIX_JSON='{"os":"macos","rust":1.8}' || fail "exit $?"
has "--external-id=gh:42:2:build:0:CI / build (macos, 1.8)"
resolve INPUT_JOB_STATUS=success JOB_TOTAL=2 JOB_INDEX=1 INPUT_NAME=custom MATRIX_JSON='{"os":"ubuntu"}' || fail "exit $?"
has "--name=custom"
has "--external-id=gh:42:2:build:1:custom"

case="queued has no conclusion"
resolve INPUT_STATUS=queued || fail "exit $?"
lacks_prefix "--conclusion"
has "--status=queued"

case="explicit conclusion"
resolve INPUT_CONCLUSION=neutral || fail "exit $?"
has "--conclusion=neutral"

case="a flag-looking summary stays a value"
resolve INPUT_JOB_STATUS=success INPUT_SUMMARY=--public-log || fail "exit $?"
has "--summary=--public-log"
args | grep -qx -- --public-log && fail "the summary became a flag"

case="long summary is cut, byte-safe"
long=$(printf '%1500s' '' | tr ' ' 'é')
resolve INPUT_JOB_STATUS=success INPUT_SUMMARY="$long" || fail "exit $?"
s=$(args | sed -n 's/^--summary=//p')
[[ $(printf '%s' "$s" | wc -c) -le 2000 ]] || fail "summary is $(printf '%s' "$s" | wc -c) bytes"

case="a long run id is hashed to 120 bytes"
resolve INPUT_JOB_STATUS=success GITHUB_JOB=a-rather-long-job-id INPUT_NAME="$(printf '%100s' '' | tr ' ' 'n')" || fail "exit $?"
e=$(args | sed -n 's/^--external-id=//p')
[[ $(printf '%s' "$e" | wc -c) -le 120 && "$e" == gh:42:2:0:* ]] || fail "external id: $e"

refuse() { # refuse <what> <env...>
  case="refuse: $1"; shift
  if resolve "$@"; then fail "accepted"; fi
  grep -q '::error' "$tmp/stdout" || fail "no ::error annotation"
}
refuse "completed without a conclusion" INPUT_JOB_STATUS=
refuse "unknown job status" INPUT_JOB_STATUS=skipped-ish
refuse "bad conclusion" INPUT_CONCLUSION=passed
refuse "conclusion on queued" INPUT_STATUS=queued INPUT_CONCLUSION=success
refuse "bad status" INPUT_STATUS=done INPUT_JOB_STATUS=success
refuse "bad sha" INPUT_JOB_STATUS=success INPUT_SHA=xyz
refuse "bad repo" INPUT_JOB_STATUS=success 'INPUT_REPO=alice/$(id)'
refuse "http details url" INPUT_JOB_STATUS=success INPUT_DETAILS_URL=http://x/y
refuse "devnet without a name" INPUT_JOB_STATUS=success INPUT_NETWORK=devnet
refuse "devnet name with odd characters" INPUT_JOB_STATUS=success INPUT_NETWORK=devnet 'INPUT_DEVNET_NAME=a b'
refuse "a newline in the name" INPUT_JOB_STATUS=success INPUT_NAME=$'a\n--public-log'
grep -q 'name must be one line' "$tmp/stdout" || fail "refused for the newline"
refuse "missing log file" INPUT_JOB_STATUS=success INPUT_LOG=/nonexistent/log
echo x >"$tmp/job.log"
refuse "log without log-storage" INPUT_JOB_STATUS=success INPUT_LOG="$tmp/job.log"
refuse "bad log-storage" INPUT_JOB_STATUS=success INPUT_LOG="$tmp/job.log" 'INPUT_LOG_STORAGE=a b'
refuse "bad public-log" INPUT_JOB_STATUS=success INPUT_PUBLIC_LOG=yes
case="an error message cannot start a workflow command"
resolve INPUT_JOB_STATUS=success INPUT_SHA=$'x\n::add-mask::oops' || true
grep -q '^::add-mask::' "$tmp/stdout" && fail "a newline in a value started a workflow command"

case="log with storage"
resolve INPUT_JOB_STATUS=success INPUT_LOG="$tmp/job.log" INPUT_LOG_STORAGE=r2-logs INPUT_PUBLIC_LOG=true || fail "exit $?"
has "--log=$tmp/job.log"
has "--storage=r2-logs"
has "--public-log"

# report.sh against a fake dg that records its argv.
mkdir -p "$tmp/bin"
cat >"$tmp/bin/dg" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$FAKE_ARGV"
echo "a dg warning" >&2
if [[ -n "${FAKE_FAIL:-}" ]]; then
  echo '{"error":{"code":"E601","message":"not a runner","cause":"40120"}}'; exit 6
fi
echo '{"status":"created","documentId":"Doc1","name":"a | b","checkStatus":"completed","conclusion":"success","headOid":"5950173cee3d651ec03af8c7257bf764a843d747","url":"https://forge.dashhq.org/repo/commit/?owner=a&name=p&oid=5950173c","cost":{"dash":0.00055}}'
EOF
chmod +x "$tmp/bin/dg"
report() { # report <env...>
  : >"$tmp/out"; : >"$tmp/md"
  env -i PATH="$tmp/bin:$PATH" GITHUB_OUTPUT="$tmp/out" GITHUB_STEP_SUMMARY="$tmp/md" FAKE_ARGV="$tmp/argv" "$@" \
    bash "$here/report.sh" >"$tmp/stdout" 2>&1
}
args_file() { sed -n 's/^args-file=//p' "$tmp/out"; }

case="report ok"
resolve INPUT_JOB_STATUS=success
report FORGE_ARGS_FILE="$(args_file)" DASH_FORGE_KEY=dfk1:x || fail "exit $?"
grep -qx 'document-id=Doc1' "$tmp/out" || fail "document-id output"
grep -q '^url=https://forge.dashhq.org/repo/commit/' "$tmp/out" || fail "url output"
grep -qF '| Result | success |' "$tmp/md" || fail "step summary"
grep -qF '| Check | a \| b |' "$tmp/md" || fail "a pipe in the name is escaped in the table"
grep -qxF -- "--sha=$SHA" "$tmp/argv" || fail "dg got the sha"
grep -q 'dfk1' "$tmp/argv" && fail "the key must never be on dg's command line"
grep -q 'dg: a dg warning' "$tmp/stdout" || fail "dg's stderr is shown even on success"

case="DG_BIN picks the binary"
resolve INPUT_JOB_STATUS=success
mkdir -p "$tmp/other" "$tmp/tools"; cp "$tmp/bin/dg" "$tmp/other/dg-installed"
ln -sf "$(command -v jq)" "$tmp/tools/jq"
af=$(args_file); : >"$tmp/out"; : >"$tmp/md"
# No dg on PATH at all: only DG_BIN can run.
env -i PATH="$tmp/tools:/usr/bin:/bin" GITHUB_OUTPUT="$tmp/out" GITHUB_STEP_SUMMARY="$tmp/md" FAKE_ARGV="$tmp/argv" \
  FORGE_ARGS_FILE="$af" DASH_FORGE_KEY=dfk1:x DG_BIN="$tmp/other/dg-installed" \
  bash "$here/report.sh" >"$tmp/stdout" 2>&1 || fail "exit $?"
grep -qx 'document-id=Doc1' "$tmp/out" || fail "ran the DG_BIN binary: $(cat "$tmp/stdout")"

case="report failure warns by default"
resolve INPUT_JOB_STATUS=success
report FORGE_ARGS_FILE="$(args_file)" DASH_FORGE_KEY=dfk1:x FAKE_FAIL=1 || fail "a failed report must not fail the job by default"
grep -q '::warning title=Dash Forge check not reported::E601' "$tmp/stdout" || fail "warning annotation: $(cat "$tmp/stdout")"

case="report failure fails when asked"
resolve INPUT_JOB_STATUS=success
if report FORGE_ARGS_FILE="$(args_file)" DASH_FORGE_KEY=dfk1:x FAKE_FAIL=1 FORGE_FAIL_ON_ERROR=true; then fail "fail-on-error: true must fail"; fi

case="a failed install warns, or fails when asked"
resolve INPUT_JOB_STATUS=success
report FORGE_ARGS_FILE="$(args_file)" DASH_FORGE_KEY=dfk1:x FORGE_INSTALL_FAILED="dg 0.1.0 could not be installed" || fail "must warn, not fail"
grep -q '::warning title=Dash Forge check not reported::installing dg failed' "$tmp/stdout" || fail "install warning"
resolve INPUT_JOB_STATUS=success
if report FORGE_ARGS_FILE="$(args_file)" DASH_FORGE_KEY=dfk1:x FORGE_INSTALL_FAILED=x FORGE_FAIL_ON_ERROR=true; then fail "install failure with fail-on-error must fail"; fi

case="report without key"
resolve INPUT_JOB_STATUS=success
report FORGE_ARGS_FILE="$(args_file)" || fail "a missing key warns, not fails"
grep -q 'DASH_FORGE_KEY is not set' "$tmp/stdout" || fail "says the key is missing"

if [[ $fails -gt 0 ]]; then echo "$fails failure(s)"; exit 1; fi
echo "check-action: all tests passed"
