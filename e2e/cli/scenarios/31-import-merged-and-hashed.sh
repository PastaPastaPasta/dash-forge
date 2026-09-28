#!/usr/bin/env bash
# Scenario 31: an import records merged PRs as merged and hashes release assets.
#
#   1. D-602: `forge-import PastaPastaPasta/dash-fork-checker --sync code,prs` into a new repo
#      `e2e-imp-<run>`. Its 3 merged PRs read as MERGED in `dg pr list` (before: closed): each
#      merge event names a base tip the mirror pushed that contains the merge commit, so the
#      readers' membership rule counts it. No PR gets a close after its merge.
#   2. D-517: `forge-import kelseyhightower/nocode --sync releases` into the same repo: its
#      asset has no GitHub digest, so the importer hashes it; `dg release list` shows a
#      64-hex sha256 and `dg release download` verifies it against the GitHub bytes.
#   3. Both re-runs write nothing and cost nothing (idempotent), with the merged state intact.
#
# Reads GitHub (gh must be logged in, or GH_TOKEN set). A new repo per run (~0.02 DASH). The
# identity is OWNER unless E2E_IMPORT_IDENTITY names another identity file. Not in the
# nightly: run by hand, `bash e2e/cli/run.sh 31`.
SCENARIO_NAME="31 import: merged PRs read merged (D-602), assets hashed (D-517)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

IMPORT="${BIN_DIR}/forge-import"
[[ -x "$IMPORT" ]] || skip_scenario "forge-import is not built (cargo build -p forge-import)"
if ! command -v gh >/dev/null || { [[ -z "${GH_TOKEN:-}" ]] && ! gh auth token >/dev/null 2>&1; }; then
  skip_scenario "no GitHub access (log in with gh or set GH_TOKEN)"
fi

ID="${E2E_IMPORT_IDENTITY:-$ID_OWNER}"
OWNER_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["identityId"])' "$ID")"
NAME="$(printf 'e2e-imp-%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
REPO="${OWNER_ID}/${NAME}"
LOG="${WORKROOT}/s31"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }

import_run() { # import_run <log> <source> <sync>
  DASH_FORGE_KEY="$ID" RUST_LOG=error NO_COLOR=1 _tmo_for 900 "$IMPORT" "$2" --repo "$NAME" --sync "$3" \
    --work-dir "${WORKROOT}/s31-work-$(basename "$2")" --max-spend 0.2 --yes --summary-json "$1.json" \
    >"$1.out" 2>"$1.err"
}
imported() { # imported <log> <source> <sync> — runs it, SKIPs on a flake, FAILs otherwise
  import_run "$@" && return 0
  cat "$1.err" >&2
  is_flake "$1.err" && skip_scenario "forge-import flaked"
  bad "forge-import $2 --sync $3 failed"; finish_scenario
}

step "1. D-602: a repo with merged PRs"
imported "$LOG-prs" PastaPastaPasta/dash-fork-checker code,prs
check "status ok" assert_eq "ok" "$(jq_py "$LOG-prs.json" 'd["status"]')"
merged_gh="$(gh api 'repos/PastaPastaPasta/dash-fork-checker/pulls?state=closed&per_page=100' --jq '[.[]|select(.merged_at!=null)]|length')"
listed() {
  dg_read_retry "$ID_CONTRIB" "$LOG-prs-list.json" "$LOG-prs-list.err" --json pr list "$REPO" --state all \
    && [[ "$(jq_py "$LOG-prs-list.json" 'sum(1 for p in d["prs"] if p.get("state") == "merged")')" == "$merged_gh" ]]
}
li=1; for _ in $(seq 1 10); do listed 2>/dev/null && { li=0; break; }; sleep 3; done
check "every PR merged on GitHub reads merged (${merged_gh})" test "$li" -eq 0

step "2. D-517: a release whose asset GitHub gives no digest"
imported "$LOG-rel" kelseyhightower/nocode releases
rel_listed() {
  dg_read_retry "$ID_CONTRIB" "$LOG-rel-list.json" "$LOG-rel-list.err" --json release list "$REPO" \
    && python3 - "$LOG-rel-list.json" <<'PY'
import json, re, sys
d = json.load(open(sys.argv[1]))
a = d["releases"][0]["assets"][0]
assert re.fullmatch(r"[0-9a-f]{64}", a["sha256"]), a
PY
}
li=1; for _ in $(seq 1 10); do rel_listed 2>/dev/null && { li=0; break; }; sleep 3; done
check "the asset records a sha256" test "$li" -eq 0
OUT="${WORKROOT}/s31-asset"
if dg_as "$ID_CONTRIB" --json release download "$REPO" 1.0.0 --output "$OUT" >"$LOG-dl.json" 2>"$LOG-dl.err"; then
  gh api 'repos/kelseyhightower/nocode/releases' --jq '.[0].assets[0].browser_download_url' >"$LOG-url.txt"
  curl -fsSL -o "${OUT}.gh" "$(cat "$LOG-url.txt")"
  check "downloaded, verified and identical to GitHub's" cmp -s "$OUT" "${OUT}.gh"
else
  cat "$LOG-dl.err" "$LOG-dl.json" >&2; bad "download of the hashed asset failed"
fi

step "3. re-runs write nothing"
imported "$LOG-prs2" PastaPastaPasta/dash-fork-checker code,prs
imported "$LOG-rel2" kelseyhightower/nocode releases
for l in "$LOG-prs2" "$LOG-rel2"; do
  check "$(basename "$l"): nothing written" assert_eq "0 0 0 0" \
    "$(jq_py "$l.json" '" ".join(str(d["counts"][k]) for k in ("refs","events","releases","prs"))')"
done

finish_scenario
