#!/usr/bin/env bash
# Validate the check action's inputs and turn them into `dg ci report` arguments, one per line
# (NUL-free), in a file whose path goes to $GITHUB_OUTPUT as `args-file`. Nothing here touches
# the network. Inputs arrive as INPUT_* environment variables, never through the shell text.
set -euo pipefail

die() { echo "::error title=Dash Forge check::$*"; exit 1; }

repo="${INPUT_REPO:-}"
repo="${repo#dash://}"
[[ "$repo" =~ ^[A-Za-z0-9.-]{1,63}/[a-z0-9][a-z0-9._-]{0,62}$ ]] \
  || die "repo must be <owner>/<name> (or dash://<owner>/<name>), got '${INPUT_REPO:-}'"

name="${INPUT_NAME:-}"
[[ -n "$name" && ${#name} -le 100 ]] || die "name must be 1-100 characters"
[[ "$name" != *$'\n'* ]] || die "name must be one line"

status="${INPUT_STATUS:-completed}"
case "$status" in queued|in_progress|completed) ;; *) die "status must be queued, in_progress or completed, got '$status'";; esac

conclusion="${INPUT_CONCLUSION:-}"
if [[ "$status" == completed && -z "$conclusion" ]]; then
  # GitHub's job.status is success, failure or cancelled; the same words are Forge conclusions.
  case "${INPUT_JOB_STATUS:-}" in
    success|failure|cancelled) conclusion="$INPUT_JOB_STATUS" ;;
    "") die "status completed needs a conclusion: pass conclusion, or job-status: \${{ job.status }}" ;;
    *) die "job-status must be success, failure or cancelled, got '${INPUT_JOB_STATUS}'" ;;
  esac
fi
if [[ -n "$conclusion" ]]; then
  [[ "$status" == completed ]] || die "conclusion is only for status completed"
  case "$conclusion" in
    success|failure|neutral|cancelled|skipped|timed_out|action_required|stale) ;;
    *) die "conclusion '$conclusion' is not one of success, failure, neutral, cancelled, skipped, timed_out, action_required, stale";;
  esac
fi

# The mirrored commit: Forge mirrors are byte-identical, so GitHub's commit id is Forge's.
# A pull_request run's github.sha is a merge commit GitHub made, which is not in any mirror;
# the PR head is.
sha="${INPUT_SHA:-}"
[[ -n "$sha" ]] || sha="${PR_HEAD_SHA:-}"
[[ -n "$sha" ]] || sha="${GITHUB_SHA:-}"
sha=$(printf '%s' "$sha" | tr 'A-F' 'a-f')
[[ "$sha" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || die "sha must be a 40 or 64 hex digit commit id, got '$sha'"

server="${GITHUB_SERVER_URL:-https://github.com}"
details="${INPUT_DETAILS_URL:-}"
if [[ -z "$details" && -n "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_RUN_ID:-}" ]]; then
  details="$server/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
  [[ -n "${GITHUB_RUN_ATTEMPT:-}" ]] && details="$details/attempts/$GITHUB_RUN_ATTEMPT"
fi
if [[ -n "$details" ]]; then
  [[ "$details" == https://* && ${#details} -le 300 && "$details" != *[[:space:]]* ]] \
    || die "details-url must be an https URL of at most 300 characters"
fi

summary="${INPUT_SUMMARY:-}"
if [[ -z "$summary" && -n "${GITHUB_WORKFLOW:-}" ]]; then
  summary="GitHub Actions: ${GITHUB_WORKFLOW} / ${GITHUB_JOB:-job} (run ${GITHUB_RUN_NUMBER:-?}, attempt ${GITHUB_RUN_ATTEMPT:-1})"
fi
summary=$(printf '%s' "$summary" | tr '\n\r' '  ')
# The contract caps it at 1000 characters and 2000 bytes; bash counts characters in a UTF-8
# locale, so keep well inside both.
[[ ${#summary} -le 900 ]] || summary="${summary:0:897}..."

network="${INPUT_NETWORK:-mainnet}"
case "$network" in mainnet|testnet) ;; devnet) [[ -n "${INPUT_DEVNET_NAME:-}" ]] || die "network devnet needs devnet-name";; *) die "network must be mainnet, testnet or devnet";; esac

log="${INPUT_LOG:-}"
log_storage="${INPUT_LOG_STORAGE:-}"
if [[ -n "$log" ]]; then
  [[ -f "$log" ]] || die "log '$log' is not a file"
  [[ -n "$log_storage" ]] || die "log needs log-storage: the storage profile the log is uploaded to"
  [[ "$log_storage" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "log-storage must be a profile name"
fi
case "${INPUT_PUBLIC_LOG:-false}" in true|false) ;; *) die "public-log must be true or false";; esac

out=$(mktemp "${RUNNER_TEMP:-/tmp}/forge-check-args.XXXXXX")
{
  printf '%s\n' --yes --json
  printf '%s\n' --network "$network"
  [[ "$network" == devnet ]] && printf '%s\n' --devnet-name "$INPUT_DEVNET_NAME"
  printf '%s\n' ci report "$repo" --sha "$sha" --name "$name" --status "$status"
  [[ -n "$conclusion" ]] && printf '%s\n' --conclusion "$conclusion"
  [[ -n "$details" ]] && printf '%s\n' --details-url "$details"
  [[ -n "$summary" ]] && printf '%s\n' --summary "$summary"
  # The GitHub run and job identify the run: a re-report of the same job updates it in place.
  if [[ -n "${GITHUB_RUN_ID:-}" ]]; then
    ext="gh:${GITHUB_RUN_ID}:${GITHUB_RUN_ATTEMPT:-1}:${GITHUB_JOB:-job}:${name}"
    printf '%s\n' --external-id "${ext:0:120}"
  fi
  if [[ -n "$log" ]]; then
    printf '%s\n' --log "$log" --storage "$log_storage"
    [[ "${INPUT_PUBLIC_LOG:-false}" == true ]] && printf '%s\n' --public-log
  fi
  true
} >"$out"
echo "args-file=$out" >>"${GITHUB_OUTPUT:-/dev/null}"
echo "Forge check: $name = ${conclusion:-$status} on ${sha:0:12} in $repo"
