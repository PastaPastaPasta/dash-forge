#!/usr/bin/env bash
# Render a `forge-import --summary-json` file for GitHub Actions:
#   - a Markdown table appended to $GITHUB_STEP_SUMMARY (stdout when unset),
#   - ::warning:: / ::error:: annotations on stdout,
#   - `status` and `spent-dash` appended to $GITHUB_OUTPUT (when set).
#
# Usage: summary.sh <summary.json>
# FORGE_MIRROR_NOW_MS overrides the clock (tests). Always exits 0: the import step's own
# exit code decides whether the job fails; this step only reports.
set -Eeuo pipefail
# A rendering bug or an unexpected summary shape must not fail a job whose import worked.
trap 'printf "::warning title=Forge mirror::could not render the run summary (line %s)\n" "$LINENO"; exit 0' ERR

json=${1:?usage: summary.sh <summary.json>}
md=${GITHUB_STEP_SUMMARY:-/dev/stdout}
now_ms=${FORGE_MIRROR_NOW_MS:-$(($(date +%s) * 1000))}

# Workflow-command data escaping: text from GitHub or the chain cannot end the command
# or start a new one.
esc() {
    local s=$1
    s=${s//'%'/%25}
    s=${s//$'\r'/%0D}
    s=${s//$'\n'/%0A}
    printf '%s' "$s"
}
annotate() { printf '::%s title=%s::%s\n' "$1" "$2" "$(esc "$3")"; }
output() {
    if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"; fi
}
# One Markdown table cell: no newlines, no column breaks.
cell() {
    local s=${1//$'\n'/ }
    printf '%s' "${s//|/\\|}"
}

if ! jq -e 'type == "object"' "$json" >/dev/null 2>&1; then
    annotate error "Forge mirror failed" "no run summary was written (forge-import did not start, or failed before writing one); see the log above."
    printf '### Forge mirror failed\n\nNo run summary was written: forge-import did not start, or failed before writing one. See the log above.\n' >>"$md"
    output status error
    output spent-dash 0
    exit 0
fi

# A non-negative integer field (floored), or $2 when absent, not a number, or too large
# for exact shell arithmetic (> 2^53, e.g. a u64::MAX "never" sentinel).
num() {
    jq -r --arg d "$2" "(try ($1) catch null) as \$v
        | if (\$v | type) == \"number\" and \$v >= 0 and \$v < 9007199254740992
          then \$v | floor | tostring else \$d end" "$json"
}
str() { jq -r "(try ($1) catch null) | if type == \"string\" then . else \"\" end" "$json"; }

status=$(str .status)
case "$status" in ok | partial | dry_run | cap_exceeded | error) ;; *) status=error ;; esac
cpd=$(num .creditsPerDash 100000000000)
[ "$cpd" -gt 0 ] || cpd=100000000000
to_dash() {
    awk -v c="$1" -v p="$cpd" 'BEGIN { s = sprintf("%.8f", c / p); sub(/0+$/, "", s); sub(/\.$/, "", s); print s }'
}

spent=$(num .spentCredits 0)
# Outputs first, so they exist even if rendering below goes wrong.
output status "$status"
output spent-dash "$(to_dash "$spent")"

source=$(str .source)
url=$(str .repo.url)
owner=$(str .repo.owner)
name=$(str .repo.name)
created=$(jq -r '(try .repo.created catch null) == true' "$json")
estimate=$(num .estimateCredits 0)
balance=$(num .balanceCredits '')
budget=$(num .key.budgetCredits '')
remaining=$(num .key.remainingCredits '')
expires=$(num .key.expiresAt '')
# Past year 9999 means "never" for display purposes.
[ -z "$expires" ] || [ "$expires" -lt 253402300800000 ] || expires=''
pack_bytes=$(num .counts.packBytes 0)
skipped=$(num .counts.skipped 0)
renew="Renew at forge.dashhq.org/${owner:-<owner>}/${name:-<name>}/settings/mirror."

case "$status" in
    ok) heading="Forge mirror updated" ;;
    partial) heading="Forge mirror updated with skipped items" ;;
    dry_run) heading="Forge mirror dry run (estimate only, nothing was written)" ;;
    cap_exceeded) heading="Forge mirror stopped: cost cap reached" ;;
    *) heading="Forge mirror failed" ;;
esac

{
    printf '### %s\n\n' "$heading"
    # shellcheck disable=SC2016 # literal backticks: Markdown code spans
    printf '`%s` → `%s`%s\n\n' "$(cell "${source:-?}")" "$(cell "${url:-?}")" "$([ "$created" = true ] && echo ' (repository created by this run)')"
    if [ "$status" = dry_run ]; then
        printf '| Would write | |\n|---|---:|\n'
    else
        printf '| Written | |\n|---|---:|\n'
    fi
    printf '| Ref updates | %s |\n' "$(num .counts.refs 0)"
    printf '| Packs | %s (%s MiB) |\n' "$(num .counts.packs 0)" "$(awk -v b="$pack_bytes" 'BEGIN { printf "%.2f", b / 1048576 }')"
    for pair in issues:Issues prs:PRs comments:Comments reviews:Reviews events:Events releases:Releases labels:Labels; do
        printf '| %s | %s |\n' "${pair#*:}" "$(num ".counts.${pair%%:*}" 0)"
    done
    [ "$skipped" -eq 0 ] || printf '| Skipped (retried next run) | %s |\n' "$skipped"
    if [ "$status" = dry_run ]; then
        printf '| **Estimated cost** | **%s DASH** |\n' "$(to_dash "$estimate")"
    else
        printf '| **Spent** | **%s DASH** |\n' "$(to_dash "$spent")"
        printf '| Estimate | %s DASH |\n' "$(to_dash "$estimate")"
    fi
    if [ -n "$budget" ] && [ -n "$remaining" ]; then
        key_left="$(to_dash "$remaining") of $(to_dash "$budget") DASH"
    else
        key_left="no budget (not a limited key)"
    fi
    if [ -n "$expires" ]; then
        key_left="$key_left, expires $(jq -rn --argjson ms "$expires" '$ms / 1000 | floor | strftime("%Y-%m-%d")')"
    fi
    printf '| Runner key budget left | %s |\n' "$key_left"
    [ -z "$balance" ] || printf '| Identity balance | %s DASH |\n' "$(to_dash "$balance")"
} >>"$md"

# Annotations.
if [ -z "$budget" ]; then
    annotate warning "Not a limited key" "DASH_FORGE_KEY has no spending budget, so a leak could spend the identity's whole balance. Use a limited runner key (budget 0.5 DASH, expiry 365 days) instead."
elif [ -n "$remaining" ] && [ "$((remaining * 5))" -lt "$budget" ]; then
    annotate warning "Runner key nearly used up" "$(to_dash "$remaining") of $(to_dash "$budget") DASH left. $renew"
fi
if [ -n "$expires" ]; then
    days=$(((expires - now_ms) / 86400000))
    if [ "$expires" -le "$now_ms" ]; then
        annotate warning "Runner key expired" "The runner key has expired. $renew"
    elif [ "$days" -lt 30 ]; then
        annotate warning "Runner key expires soon" "The runner key expires in $days days. $renew"
    fi
fi
while IFS= read -r w; do
    [ -z "$w" ] || annotate warning "Forge mirror" "$w"
done < <(jq -r 'try (.warnings // [])[] | strings | gsub("[\r\n]+"; " ")' "$json")
if [ "$status" = partial ]; then
    annotate warning "Forge mirror skipped items" "$skipped item(s) were skipped (see the warnings above). The sync state did not advance, so the next run retries them."
fi
if [ "$status" = error ] || [ "$status" = cap_exceeded ]; then
    err=$(str .error)
    annotate error "Forge mirror $status" "${err:-forge-import reported $status without a message}"
    [ -z "$err" ] || printf '\n**Error:** %s\n' "$(cell "$err")" >>"$md"
fi
