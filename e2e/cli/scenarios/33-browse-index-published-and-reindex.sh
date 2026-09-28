#!/usr/bin/env bash
# Scenario 33: a push always ends with a browse index, or says it did not and how to fix it
# (D-920: the dashpay/dash showcase import stored 258 MiB, 18,452 chunks, and published no
# objectLocator, because the push's first manifest read came from a node that did not list the
# manifest yet; the web showed "Not indexed for browsing yet" and nothing said why).
#
#   1. `forge-import` a mid-size repository (`E2E_S33_SOURCE`, default sharkdp/hyperfine) into a
#      new repo: the summary carries no browse-index warning, and the repo has exactly one
#      live objectLocator covering its one git pack (`dg repo reindex` finds nothing to do).
#   2. Into a second new repo, a `git push` whose manifest reads all miss the pushed pack
#      (`DASH_FORGE_TEST_MANIFEST_LAG`, a test-hooks helper): the push succeeds, and says
#      `warning: … browse index was not published … dg repo reindex <repo>` on its output and
#      as an `indexSkipped` event. The repo has a git pack and no objectLocator.
#   3. `dg repo reindex` on it prices one index fragment (no pack upload), publishes it, and a
#      second run finds nothing to do. The spend is the index only: far below the pack's price.
#
# Needs a test-hooks git-remote-dash (SKIPs otherwise; `cargo build -p git-remote-dash
# --features test-hooks`), GitHub access, and an identity minted for the run (the moutai funding
# key under `lockf /tmp/qa-mint.lock`, or `E2E_S33_IDENTITY`). Two new repos per run
# (`e2e-idx-<run-id>`, `e2e-idx-lag-<run-id>`). Not in the default set (`run.sh 33`).
SCENARIO_NAME="33 a push publishes its browse index, or says so; dg repo reindex repairs it (D-920)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

IMPORT="${BIN_DIR}/forge-import"
[[ -x "$IMPORT" ]] || skip_scenario "forge-import is not built (cargo build -p forge-import)"
grep -q DASH_FORGE_TEST_MANIFEST_LAG "${BIN_DIR}/git-remote-dash" 2>/dev/null \
  || skip_scenario "git-remote-dash is not a test-hooks build (cargo build -p git-remote-dash --features test-hooks)"
if ! command -v gh >/dev/null || { [[ -z "${GH_TOKEN:-}" ]] && ! gh auth token >/dev/null 2>&1; }; then
  skip_scenario "no GitHub access (log in with gh or set GH_TOKEN)"
fi
: "${MOUTAI_FUNDING:=/Users/pasta/workspace/dash-forge-qa/secrets/moutai-funding.wif}"
: "${MINT_DIR:=${E2E_REPO_ROOT}/tools/mint-identity}"
: "${E2E_S33_SOURCE:=sharkdp/hyperfine}"

LOG="${WORKROOT}/s33"
IDS="${WORKROOT}/s33-ids"; mkdir -p -m 700 "$IDS"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }

step "this run's identity"
if [[ -n "${E2E_S33_IDENTITY:-}" ]]; then
  cp "$E2E_S33_IDENTITY" "$IDS/S33.identity.json"
else
  [[ -r "$MOUTAI_FUNDING" ]] || skip_scenario "no moutai funding key ($MOUTAI_FUNDING); or set E2E_S33_IDENTITY"
  [[ -d "$MINT_DIR/node_modules/@dashevo/evo-sdk" ]] || skip_scenario "tools/mint-identity has no node_modules (npm ci there)"
  lock=(); lf="${E2E_MINT_LOCK:-/tmp/qa-mint.lock}"
  if command -v lockf >/dev/null; then lock=(lockf -t 1200 "$lf"); elif command -v flock >/dev/null; then lock=(flock -w 1200 "$lf"); fi
  "${lock[@]}" node "$MINT_DIR/mint.mjs" --network devnet --devnet-name "${DASH_FORGE_DEVNET_NAME:-moutai}" \
    --funding fund-from-key --funding-key-file "$MOUTAI_FUNDING" --out "$IDS" --label S33 --amount 3 \
    >"$LOG-mint.log" 2>&1 || { tail -5 "$LOG-mint.log" >&2; skip_scenario "minting failed (funding or network)"; }
fi
ID="$IDS/S33.identity.json"
OWNER_ID="$(_idid "$ID")"
[[ -n "$OWNER_ID" ]] || { bad "no identity file"; finish_scenario; }
ok "identity ${OWNER_ID:0:10}…"

# The repo's pack manifests, by kind: "<git packs> <live locators>".
kinds() { # kinds <repo>
  dg_read_retry "$ID" "$LOG-kinds.json" "$LOG-kinds.err" --json storage status "$1" || return 1
  python3 -c 'import json,sys; p=json.load(open(sys.argv[1]))["packs"]; print(sum(1 for x in p if x["kind"]==0), sum(1 for x in p if x["kind"]==1))' "$LOG-kinds.json"
}
reindex() { # reindex <log> <repo>: dg repo reindex --yes --json, stdout -> <log>.json
  dg_as "$ID" --yes --json repo reindex "$2" >"$1.json" 2>"$1.err"
}

step "1. an import publishes its browse index"
NAME="$(printf 'e2e-idx-%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
if ! ( export DASH_FORGE_KEY="$ID" RUST_LOG=error NO_COLOR=1
       _tmo_for 1800 "$IMPORT" "$E2E_S33_SOURCE" --repo "$NAME" --sync code --work-dir "$WORKROOT/s33-work" \
         --max-spend 2.5 --yes --summary-json "$LOG-1.json" >"$LOG-1.out" 2>"$LOG-1.err" ); then
  cat "$LOG-1.err" >&2; is_flake "$LOG-1.err" && skip_scenario "forge-import flaked"
  bad "the import failed"; finish_scenario
fi
check "status ok" assert_eq "ok" "$(jq_py "$LOG-1.json" 'd["status"]')"
check "no browse-index warning" assert_eq "0" \
  "$(jq_py "$LOG-1.json" 'sum("browse index" in w for w in d["warnings"])')"
check "one git pack and one live index" assert_eq "1 1" "$(kinds "$OWNER_ID/$NAME")"
reindex "$LOG-1r" "$OWNER_ID/$NAME" || { cat "$LOG-1r.err" >&2; bad "reindex failed"; }
check "reindex finds nothing to do" assert_eq "indexed" "$(jq_py "$LOG-1r.json" 'd["status"]')"

step "2. a push whose manifest reads lag says it left the index behind"
LAG="$(printf 'e2e-idx-lag-%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
dg_read_retry "$ID" "$LOG-2c.json" "$LOG-2c.err" --yes --json repo create "$LAG" --storage platform \
  || { cat "$LOG-2c.err" >&2; bad "repo create failed"; finish_scenario; }
SRC="$WORKROOT/s33-src"
seed_tiny_repo "$SRC" main >/dev/null
if ! DASH_FORGE_TEST_MANIFEST_LAG=1 GIT_DASH_JSON=1 git_dash "$ID" "$LOG-2" \
    -C "$SRC" push "dash://$OWNER_ID/$LAG" main:main; then
  cat "$LOG-2.err" >&2; is_flake "$LOG-2.err" && skip_scenario "push flaked"
  bad "the push failed"; finish_scenario
fi
check "the push reports the skipped index as an event" assert_file_contains "$LOG-2.err" '"event":"indexSkipped"'
check "…with the fix" assert_file_contains "$LOG-2.err" "dg repo reindex $OWNER_ID/$LAG"
check "one git pack, no index" assert_eq "1 0" "$(kinds "$OWNER_ID/$LAG")"

step "3. dg repo reindex publishes the missing index only"
reindex "$LOG-3" "$OWNER_ID/$LAG" || { cat "$LOG-3.err" "$LOG-3.json" >&2; bad "reindex failed"; finish_scenario; }
check "status reindexed" assert_eq "reindexed" "$(jq_py "$LOG-3.json" 'd["status"]')"
check "one pack indexed, none skipped" assert_eq "1 0" \
  "$(jq_py "$LOG-3.json" 'str(d["indexedPacks"]) + " " + str(len(d["skipped"]))')"
check "one git pack and one live index" assert_eq "1 1" "$(kinds "$OWNER_ID/$LAG")"
# The spend must be MEASURED (a number, not null) and positive: an index was paid for. One tiny
# pack's index is a fanout, a few rows and a manifest, well under 0.01 DASH.
spent="$(jq_py "$LOG-3.json" '"" if d["cost"] is None else d["cost"]["credits"]')"
check "the spend was measured" test -n "$spent"
check "the spend is positive (${spent} credits)" test "${spent:-0}" -gt 0
check "the spend is the index only (${spent} credits)" test "${spent:-0}" -lt 1000000000
reindex "$LOG-3b" "$OWNER_ID/$LAG" || { cat "$LOG-3b.err" >&2; bad "second reindex failed"; }
check "a second reindex finds nothing to do" assert_eq "indexed" "$(jq_py "$LOG-3b.json" 'd["status"]')"

finish_scenario
