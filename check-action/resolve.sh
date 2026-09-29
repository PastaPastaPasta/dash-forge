#!/usr/bin/env bash
# Validate the check action's inputs and turn them into `dg ci report` arguments, one per line,
# each in `--flag=value` form (so a value can never be read as a flag), in a file whose path goes
# to $GITHUB_OUTPUT as `args-file`. Nothing here touches the network. Inputs arrive as INPUT_*
# environment variables, never through the shell text.
set -euo pipefail
# Character counts below are characters of UTF-8 text, whatever the runner's locale.
export LC_ALL=C.UTF-8 2>/dev/null || true

# A workflow command's message with %, CR and LF escaped (GitHub's rule), so a value cannot
# start a second command.
wf_escape() { local s="${1//%/%25}"; s="${s//$'\r'/%0D}"; printf '%s' "${s//$'\n'/%0A}"; }
die() { echo "::error title=Dash Forge check::$(wf_escape "$*")"; exit 1; }
# One line, no NUL: every value goes into a line-per-argument file.
one_line() { # one_line <what> <value>
  [[ "$2" != *$'\n'* && "$2" != *$'\r'* ]] || die "$1 must be one line"
}

repo="${INPUT_REPO:-}"
repo="${repo#dash://}"
[[ "$repo" =~ ^[A-Za-z0-9.-]{1,63}/[a-z0-9][a-z0-9._-]{0,62}$ ]] \
  || die "repo must be <owner>/<name> (or dash://<owner>/<name>), got '${INPUT_REPO:-}'"

# The check's name. Default: `<workflow> / <job>`, and for a matrix leg the leg's values in
# parentheses, as GitHub names them, so the legs of one job are separate checks.
matrix_suffix=""
if [[ "${JOB_TOTAL:-1}" =~ ^[0-9]+$ && "${JOB_TOTAL:-1}" -gt 1 && -n "${MATRIX_JSON:-}" ]]; then
  vals=$(printf '%s' "$MATRIX_JSON" | jq -r 'if type == "object" then [.[] | if type == "string" then . else tojson end] | join(", ") else empty end' 2>/dev/null || true)
  [[ -n "$vals" ]] && matrix_suffix=" ($vals)"
fi
name="${INPUT_NAME:-}"
if [[ -z "$name" ]]; then
  name="${GITHUB_WORKFLOW:+$GITHUB_WORKFLOW / }${GITHUB_JOB:-job}${matrix_suffix}"
fi
one_line "name" "$name"
name=$(printf '%s' "$name" | cut -c1-100)
[[ -n "$name" ]] || die "name is empty"

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
  summary="GitHub Actions: ${GITHUB_WORKFLOW} / ${GITHUB_JOB:-job}${matrix_suffix} (run ${GITHUB_RUN_NUMBER:-?}, attempt ${GITHUB_RUN_ATTEMPT:-1})"
fi
summary=$(printf '%s' "$summary" | tr '\n\r' '  ')
# The contract caps it at 1000 characters and 2000 bytes: 500 characters of UTF-8 are at most
# 2000 bytes.
[[ ${#summary} -le 500 ]] || summary="${summary:0:497}..."

network="${INPUT_NETWORK:-mainnet}"
devnet="${INPUT_DEVNET_NAME:-}"
case "$network" in
  mainnet|testnet) ;;
  devnet) [[ "$devnet" =~ ^[a-z0-9-]{1,32}$ ]] || die "network devnet needs devnet-name (lowercase letters, digits and -)";;
  *) die "network must be mainnet, testnet or devnet";;
esac

log="${INPUT_LOG:-}"
log_storage="${INPUT_LOG_STORAGE:-}"
if [[ -n "$log" ]]; then
  one_line "log" "$log"
  [[ -f "$log" ]] || die "log '$log' is not a file"
  [[ -n "$log_storage" ]] || die "log needs log-storage: the storage profile the log is uploaded to"
  [[ "$log_storage" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "log-storage must be a profile name"
fi
case "${INPUT_PUBLIC_LOG:-false}" in true|false) ;; *) die "public-log must be true or false";; esac

# One job's reports share a run id: the run, the attempt, the job, the matrix leg and the name.
# The contract allows 120 bytes; a longer one keeps its head and a hash of the whole.
ext=""
if [[ -n "${GITHUB_RUN_ID:-}" ]]; then
  ext="gh:${GITHUB_RUN_ID}:${GITHUB_RUN_ATTEMPT:-1}:${GITHUB_JOB:-job}:${JOB_INDEX:-0}:${name}"
  if [[ $(printf '%s' "$ext" | wc -c) -gt 120 ]]; then
    h=$(printf '%s' "$ext" | sha256sum 2>/dev/null || printf '%s' "$ext" | shasum -a 256)
    ext="gh:${GITHUB_RUN_ID}:${GITHUB_RUN_ATTEMPT:-1}:${JOB_INDEX:-0}:${h:0:40}"
  fi
fi

for v in "$details" "$summary" "$ext"; do one_line "a value" "$v"; done

out=$(mktemp "${RUNNER_TEMP:-/tmp}/forge-check-args.XXXXXX")
{
  printf '%s\n' --yes --json "--network=$network"
  if [[ "$network" == devnet ]]; then printf '%s\n' "--devnet-name=$devnet"; fi
  printf '%s\n' ci report "$repo" "--sha=$sha" "--name=$name" "--status=$status"
  if [[ -n "$conclusion" ]]; then printf '%s\n' "--conclusion=$conclusion"; fi
  if [[ -n "$details" ]]; then printf '%s\n' "--details-url=$details"; fi
  if [[ -n "$summary" ]]; then printf '%s\n' "--summary=$summary"; fi
  if [[ -n "$ext" ]]; then printf '%s\n' "--external-id=$ext"; fi
  if [[ -n "$log" ]]; then
    printf '%s\n' "--log=$log" "--storage=$log_storage"
    if [[ "${INPUT_PUBLIC_LOG:-false}" == true ]]; then printf '%s\n' --public-log; fi
  fi
} >"$out"
{
  echo "args-file=$out"
  echo "sha=$sha"
  echo "name=$name"
} >>"${GITHUB_OUTPUT:-/dev/null}"
echo "Forge check: $(wf_escape "$name") = ${conclusion:-$status} on ${sha:0:12} in $repo"
