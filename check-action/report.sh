#!/usr/bin/env bash
# Run `dg ci report` with the arguments resolve.sh wrote (one per line), and publish its result.
# The key comes from DASH_FORGE_KEY (a `dfk1:` runner key from `dg ci runner new`), which dg
# reads itself: it is never put on a command line.
set -uo pipefail

wf_escape() { local s="${1//%/%25}"; s="${s//$'\r'/%0D}"; printf '%s' "${s//$'\n'/%0A}"; }
warn_or_fail() {
  if [[ "${FORGE_FAIL_ON_ERROR:-false}" == true ]]; then
    echo "::error title=Dash Forge check not reported::$(wf_escape "$*")"
    exit 1
  fi
  echo "::warning title=Dash Forge check not reported::$(wf_escape "$*")"
  exit 0
}
# A Markdown table cell: pipes and newlines would break the table.
cell() { local s="${1//|/\\|}"; printf '%s' "${s//$'\n'/ }"; }

[[ -z "${FORGE_INSTALL_FAILED:-}" ]] || warn_or_fail "installing dg failed: $FORGE_INSTALL_FAILED"
[[ -n "${DASH_FORGE_KEY:-}" ]] || warn_or_fail "DASH_FORGE_KEY is not set (add the runner key from \`dg ci runner new\` as a secret)"
[[ -f "${FORGE_ARGS_FILE:-}" ]] || warn_or_fail "internal: no argument file"
dg="${DG_BIN:-dg}"
command -v "$dg" >/dev/null || warn_or_fail "$dg is not on PATH (install: 'true', or build it before this step)"
command -v jq >/dev/null || warn_or_fail "jq is not on PATH (GitHub's hosted runners have it; install it on a self-hosted one)"

args=()
while IFS= read -r line; do args+=("$line"); done <"$FORGE_ARGS_FILE"
rm -f "$FORGE_ARGS_FILE"

out=$(mktemp)
err=$(mktemp)
trap 'rm -f "$out" "$err"' EXIT
"$dg" "${args[@]}" >"$out" 2>"$err"
rc=$?
# dg's stderr carries warnings (a private repository's public log, a spent budget): show them.
[[ -s "$err" ]] && sed 's/^/dg: /' "$err" >&2
if [[ $rc -ne 0 ]]; then
  msg=$(jq -r '.error | "\(.code): \(.message) — \(.cause // "")"' "$out" 2>/dev/null || true)
  [[ -n "$msg" && "$msg" != "null"* ]] || msg=$(tail -3 "$err" | tr '\n' ' ')
  warn_or_fail "$msg"
fi

doc=$(jq -r '.documentId // empty' "$out" 2>/dev/null) || doc=""
url=$(jq -r '.url // empty' "$out" 2>/dev/null) || url=""
action=$(jq -r '.status // empty' "$out" 2>/dev/null) || action=""
[[ -n "$doc" && -n "$action" && -n "$url" ]] || warn_or_fail "dg reported success but its output could not be read: $(head -c 300 "$out" | tr '\n' ' ')"
{
  echo "document-id=$doc"
  echo "url=$url"
  echo "action=$action"
} >>"${GITHUB_OUTPUT:-/dev/null}"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Forge check run $action"
    echo
    echo "| | |"
    echo "|---|---|"
    echo "| Check | $(cell "$(jq -r '.name' "$out")") |"
    echo "| Result | $(cell "$(jq -r '.conclusion // .checkStatus' "$out")") |"
    echo "| Commit | \`$(jq -r '.headOid' "$out")\` |"
    echo "| Cost | $(jq -r '.cost.dash' "$out") DASH |"
    echo "| On Forge | $url |"
  } >>"$GITHUB_STEP_SUMMARY"
fi
echo "Forge check run $action: $url"
