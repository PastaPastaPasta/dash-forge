#!/usr/bin/env bash
# Scenario 23: DAPI request budgets (platform-parity-spec.md P-5; D-500, D-902).
#
# Every DAPI request the CLI makes is logged by rs-dapi-client at trace level ("calling
# <method> with …"); this counts them.
#   1. `dg pr list` on the read-only forge-v2-demo fixture: <= 10 requests cold (empty cache)
#      and <= 6 warm. It was ~9 per PR (D-500).
#   2. `git fetch` with nothing new: <= 4 requests and no pack downloaded.
#   3. After a push adds one pack, `git fetch` downloads exactly that pack (not every pack).
SCENARIO_NAME="23 request budgets: pr list, no-op fetch, incremental fetch"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
[[ -n "${HARNESS_SHARED:-}" ]] || harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

LOG="${WORKROOT}/s23"
# The read-only browser fixture (OWNER owns it; seeded by `make e2e-fixture`).
DEMO="${E2E_DEMO_REPO:-${IDID_OWNER}/forge-v2-demo}"
# A cache of our own, so "cold" is cold whatever the runner has cached.
export DASH_FORGE_CACHE_DIR="${WORKROOT}/s23-cache"
rm -rf "$DASH_FORGE_CACHE_DIR"

requests() { grep -c 'calling [a-z_]* with' "$1" 2>/dev/null || echo 0; }
traced_dg() { # traced_dg <log> <dg args...>
  local l="$1"; shift
  RUST_LOG=rs_dapi_client=trace NO_COLOR=1 _tmo "$DG" --identity "$ID_CONTRIB" "$@" >"$l.out" 2>"$l.err"
}
traced_git() { # traced_git <log> <git args...>
  local l="$1"; shift
  DASH_FORGE_KEY="$ID_OWNER" RUST_LOG=rs_dapi_client=trace,git_remote_dash=info NO_COLOR=1 _tmo git "$@" >"$l.out" 2>"$l.err"
}
within() { # within <label> <count> <max>
  if [[ "$2" -le "$3" ]]; then ok "$1: $2 requests (budget $3)"; else bad "$1: $2 requests, budget $3"; fi
}

step "dg pr list on ${DEMO}: cold, then warm"
traced_dg "$LOG-prl-cold" pr list "$DEMO" --state all || { is_flake "$LOG-prl-cold.err" && skip_scenario "pr list flaked"; bad "pr list failed"; finish_scenario; }
within "pr list cold" "$(requests "$LOG-prl-cold.err")" 10
traced_dg "$LOG-prl-warm" pr list "$DEMO" --state all || { is_flake "$LOG-prl-warm.err" && skip_scenario "pr list flaked"; bad "pr list failed"; finish_scenario; }
within "pr list warm" "$(requests "$LOG-prl-warm.err")" 6
check "warm and cold list the same PRs" diff -q "$LOG-prl-cold.out" "$LOG-prl-warm.out"
# Networks without composite queries (protocol 13) read one by one: the same answer.
DASH_FORGE_NO_COMPOSITE=1 traced_dg "$LOG-prl-plain" pr list "$DEMO" --state all \
  || { is_flake "$LOG-prl-plain.err" && skip_scenario "pr list flaked"; bad "pr list without composite queries failed"; finish_scenario; }
check "without composite queries the list is the same" diff -q "$LOG-prl-cold.out" "$LOG-prl-plain.out"

step "git fetch with nothing new"
BR="e2e/${RUN_ID}/budget"
SRC="${WORKROOT}/s23-src"
CL="${WORKROOT}/s23-clone"
seed_tiny_repo "$SRC" "$BR" >/dev/null
git_dash_retry "$ID_OWNER" "$LOG-push1" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}" \
  || { is_flake "$LOG-push1.err" && skip_scenario "push flaked"; bad "push failed"; finish_scenario; }
register_ref "refs/heads/${BR}"
git_dash_retry "$ID_OWNER" "$LOG-clone" clone -q --no-checkout -b "$BR" "$E2E_REMOTE" "$CL" \
  || { is_flake "$LOG-clone.err" && skip_scenario "clone flaked"; bad "clone failed"; finish_scenario; }
traced_git "$LOG-noop" -C "$CL" fetch origin || { is_flake "$LOG-noop.err" && skip_scenario "fetch flaked"; bad "no-op fetch failed"; finish_scenario; }
within "no-op fetch" "$(requests "$LOG-noop.err")" 4
check "the no-op fetch downloads no pack" bash -c "! grep -q 'indexed pack into local odb' '$LOG-noop.err'"

step "git fetch after one new push downloads only the new pack"
printf 'more %s\n' "$RUN_ID" >"$SRC/alpha.txt"
git -C "$SRC" commit -qam "budget ${RUN_ID}"
git_dash_retry "$ID_OWNER" "$LOG-push2" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}" \
  || { is_flake "$LOG-push2.err" && skip_scenario "push flaked"; bad "second push failed"; finish_scenario; }
traced_git "$LOG-incr" -C "$CL" fetch origin || { is_flake "$LOG-incr.err" && skip_scenario "fetch flaked"; bad "fetch failed"; finish_scenario; }
check "one pack downloaded" assert_eq "1" "$(grep -c 'indexed pack into local odb' "$LOG-incr.err")" "packs indexed"
check "fetched tip matches the push" assert_eq "$(git -C "$SRC" rev-parse HEAD)" "$(git -C "$CL" rev-parse "origin/${BR}")" "tip"

finish_scenario
