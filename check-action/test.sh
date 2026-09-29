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
    INPUT_REPO=alice/project INPUT_NAME=build INPUT_STATUS=completed INPUT_NETWORK=mainnet "$@" \
    bash "$here/resolve.sh" >"$tmp/stdout" 2>&1
}
args() { cat "$(sed -n 's/^args-file=//p' "$tmp/out")"; }
has_arg() { # has_arg <flag> <value>: the flag is followed by exactly that value
  if ! args | grep -A1 -x -- "$1" | grep -qxF -- "$2"; then fail "missing $1 $2"; fi
}

case=push-success
resolve INPUT_JOB_STATUS=success || fail "exit $?: $(cat "$tmp/stdout")"
has_arg --sha "$SHA"
has_arg --conclusion success
has_arg --details-url "https://github.com/acme/app/actions/runs/42/attempts/2"
has_arg --external-id "gh:42:2:build:build"
has_arg --network mainnet
has_arg --summary "GitHub Actions: CI / build (run 7, attempt 2)"
args | grep -qx -- "--devnet-name" && fail "no devnet-name on mainnet"

case=pull-request-reports-the-head-not-the-merge-commit
resolve INPUT_JOB_STATUS=failure PR_HEAD_SHA=$HEAD || fail "exit $?"
has_arg --sha "$HEAD"
has_arg --conclusion failure

case=explicit-sha-wins-and-dash-url
resolve INPUT_JOB_STATUS=success PR_HEAD_SHA=$HEAD INPUT_SHA=ABCDEF0123456789ABCDEF0123456789ABCDEF01 INPUT_REPO=dash://alice/project \
  INPUT_NETWORK=devnet INPUT_DEVNET_NAME=moutai || fail "exit $?"
has_arg --sha abcdef0123456789abcdef0123456789abcdef01
has_arg report alice/project
has_arg --devnet-name moutai

case=queued-has-no-conclusion
resolve INPUT_STATUS=queued || fail "exit $?"
args | grep -qx -- --conclusion && fail "a queued run carries no conclusion"
has_arg --status queued

case=explicit-conclusion
resolve INPUT_CONCLUSION=neutral || fail "exit $?"
has_arg --conclusion neutral

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
refuse "missing log file" INPUT_JOB_STATUS=success INPUT_LOG=/nonexistent/log
echo x >"$tmp/job.log"
refuse "log without log-storage" INPUT_JOB_STATUS=success INPUT_LOG="$tmp/job.log"
refuse "bad log-storage" INPUT_JOB_STATUS=success INPUT_LOG="$tmp/job.log" 'INPUT_LOG_STORAGE=a b'
refuse "bad public-log" INPUT_JOB_STATUS=success INPUT_PUBLIC_LOG=yes

case=log-with-storage
resolve INPUT_JOB_STATUS=success INPUT_LOG="$tmp/job.log" INPUT_LOG_STORAGE=r2-logs INPUT_PUBLIC_LOG=true || fail "exit $?"
has_arg --log "$tmp/job.log"
has_arg --storage r2-logs
args | grep -qx -- --public-log || fail "public-log passed on"

case="long summary is cut"
long=$(printf '%1500s' '' | tr ' ' 'x')
resolve INPUT_JOB_STATUS=success INPUT_SUMMARY="$long" || fail "exit $?"
s=$(args | grep -A1 -x -- --summary | tail -1)
[[ ${#s} -le 900 ]] || fail "summary is ${#s} characters"

# report.sh against a fake dg that records its argv.
mkdir -p "$tmp/bin"
cat >"$tmp/bin/dg" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$FAKE_ARGV"
if [[ -n "${FAKE_FAIL:-}" ]]; then
  echo '{"error":{"code":"E601","message":"not a runner","cause":"40120"}}'; exit 6
fi
echo '{"status":"created","documentId":"Doc1","name":"build","checkStatus":"completed","conclusion":"success","headOid":"5950173cee3d651ec03af8c7257bf764a843d747","url":"https://forge.dashhq.org/repo/commit/?owner=a&name=p&oid=5950173c","cost":{"dash":0.00055}}'
EOF
chmod +x "$tmp/bin/dg"
report() { # report <env...>
  : >"$tmp/out"; : >"$tmp/md"
  env -i PATH="$tmp/bin:$PATH" GITHUB_OUTPUT="$tmp/out" GITHUB_STEP_SUMMARY="$tmp/md" FAKE_ARGV="$tmp/argv" "$@" \
    bash "$here/report.sh" >"$tmp/stdout" 2>&1
}

case=report-ok
resolve INPUT_JOB_STATUS=success
report FORGE_ARGS_FILE="$(sed -n 's/^args-file=//p' "$tmp/out")" DASH_FORGE_KEY=dfk1:x || fail "exit $?"
grep -qx 'document-id=Doc1' "$tmp/out" || fail "document-id output"
grep -q '^url=https://forge.dashhq.org/repo/commit/' "$tmp/out" || fail "url output"
grep -qF '| Result | success |' "$tmp/md" || fail "step summary"
grep -qx -- "$SHA" "$tmp/argv" || fail "dg got the sha"
grep -q 'dfk1' "$tmp/argv" && fail "the key must never be on dg's command line"

case=report-failure-warns-by-default
resolve INPUT_JOB_STATUS=success
report FORGE_ARGS_FILE="$(sed -n 's/^args-file=//p' "$tmp/out")" DASH_FORGE_KEY=dfk1:x FAKE_FAIL=1 || fail "a failed report must not fail the job by default"
grep -q '::warning title=Dash Forge check not reported::E601' "$tmp/stdout" || fail "warning annotation: $(cat "$tmp/stdout")"

case=report-failure-fails-when-asked
resolve INPUT_JOB_STATUS=success
if report FORGE_ARGS_FILE="$(sed -n 's/^args-file=//p' "$tmp/out")" DASH_FORGE_KEY=dfk1:x FAKE_FAIL=1 FORGE_FAIL_ON_ERROR=true; then fail "fail-on-error: true must fail"; fi

case=report-without-key
resolve INPUT_JOB_STATUS=success
report FORGE_ARGS_FILE="$(sed -n 's/^args-file=//p' "$tmp/out")" || fail "a missing key warns, not fails"
grep -q 'DASH_FORGE_KEY is not set' "$tmp/stdout" || fail "says the key is missing"

if [[ $fails -gt 0 ]]; then echo "$fails failure(s)"; exit 1; fi
echo "check-action: all tests passed"
