#!/usr/bin/env bash
# test-config.sh — offline checks of config.sh's network rules and lib.sh's require_mint_funding.
#
#   bash e2e/cli/test-config.sh
#
# No network, no keys: identity files are fake {"identityId": ...} stubs under a temporary HOME.
# Covers the testnet rules of release plan WS-D (QA-05, QA-V-05, HYGI-12): OWNER is the owner role
# on every network, DEPLOYER and the July-era pool are refused, the testnet funding wallet and the
# per-network identity directory are the defaults, a missing funding key fails a minting scenario on
# testnet and skips on a devnet.
# shellcheck disable=SC2015,SC2016 # `A && pass || fail` where pass never fails; snippets are single-quoted on purpose
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/e2e-config-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
FAILS=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }

JULY_FIRST="$(node -e "import('$REPO/forge-contracts/scripts/lib/target.mjs').then(m=>console.log([...m.JULY_POOL_IDS.keys()][0]))")"

stub() { # stub <dir> <ROLE> <identityId>
  mkdir -p "$1"
  printf '{"identityId": "%s"}\n' "$3" >"$1/$2.identity.json"
}
fresh_pool() { # fresh_pool <dir>: OWNER, COLLAB, CONTRIB with ids that are not July ids
  stub "$1" OWNER FreshOwner1111111111111111111111111111111111
  stub "$1" COLLAB FreshCollab11111111111111111111111111111111
  stub "$1" CONTRIB FreshContrib1111111111111111111111111111111
}

# cfg2 <HOME> [VAR=value ...] -- <snippet>: sources config.sh in a clean environment, then runs the snippet; prints its output, returns config.sh's status
cfg2() {
  local home="$1"; shift
  local envs=()
  while [[ "$1" != "--" ]]; do envs+=("$1"); shift; done
  shift
  local snippet="$1"
  env -i PATH="$PATH" HOME="$home" ${envs[@]+"${envs[@]}"} bash -c 'source "'"$REPO"'/e2e/cli/config.sh" || exit $?; '"$snippet" 2>&1
}

expect_ok() { # expect_ok <label> <expected substring> <HOME> [VAR=..] -- <snippet>
  local label="$1" want="$2"; shift 2
  local out rc
  out="$(cfg2 "$@")"; rc=$?
  if [[ $rc -eq 0 && "$out" == *"$want"* ]]; then pass "$label"; else fail "$label (rc=$rc, wanted '$want', got: $out)"; fi
}
expect_refused() { # expect_refused <label> <expected substring of the refusal> <HOME> [VAR=..] -- <snippet>
  local label="$1" want="$2"; shift 2
  local out rc
  out="$(cfg2 "$@")"; rc=$?
  if [[ $rc -eq 1 && "$out" == *"$want"* ]]; then pass "$label"; else fail "$label (rc=$rc, wanted a refusal containing '$want', got: $out)"; fi
}

echo "config.sh"

H="$TMP/h-devnet"
fresh_pool "$H/.config/dash-forge/test-identities/devnet-sakura"
expect_ok "devnet defaults: sakura, OWNER, devnet-sakura dir, sakura funding key" \
  "devnet sakura OWNER $H/.config/dash-forge/test-identities/devnet-sakura $H/workspace/dash-forge-qa/secrets/sakura-funding.wif --network devnet --devnet-name sakura" \
  "$H" -- 'echo "$DASH_FORGE_NETWORK $DASH_FORGE_DEVNET_NAME $E2E_OWNER_ROLE $E2E_IDENTITY_DIR $E2E_MINT_FUNDING ${E2E_MINT_NET_ARGS[*]}"'
expect_refused "an unknown network" "must be devnet or testnet" "$H" DASH_FORGE_NETWORK=mainnet -- true
expect_refused "a devnet name that is not [a-z0-9-]" "DASH_FORGE_DEVNET_NAME must match" "$H" 'DASH_FORGE_DEVNET_NAME=../x' -- true

H="$TMP/h-testnet"
fresh_pool "$H/.config/dash-forge/test-identities/testnet-scratch"
expect_ok "testnet defaults: no devnet name, OWNER, testnet-scratch dir, testnet funding wallet" \
  "testnet [] OWNER $H/.config/dash-forge/test-identities/testnet-scratch $H/workspace/dash-forge-qa/secrets/testnet-funding.wif --network testnet" \
  "$H" DASH_FORGE_NETWORK=testnet -- 'echo "$DASH_FORGE_NETWORK [$DASH_FORGE_DEVNET_NAME] $E2E_OWNER_ROLE $E2E_IDENTITY_DIR $E2E_MINT_FUNDING ${E2E_MINT_NET_ARGS[*]}"'
expect_ok "testnet ignores a devnet name from the environment" "[]" \
  "$H" DASH_FORGE_NETWORK=testnet DASH_FORGE_DEVNET_NAME=sakura -- 'echo "[$DASH_FORGE_DEVNET_NAME]"'
expect_ok "DASH_FORGE_QA_DIR moves the funding wallet" "/qa/secrets/testnet-funding.wif" \
  "$H" DASH_FORGE_NETWORK=testnet DASH_FORGE_QA_DIR=/qa -- 'echo "$E2E_MINT_FUNDING"'
expect_refused "testnet with E2E_OWNER_ROLE=DEPLOYER" "DEPLOYER" "$H" DASH_FORGE_NETWORK=testnet E2E_OWNER_ROLE=DEPLOYER -- true
expect_refused "testnet with a devnet funding key" "devnet funding key" "$H" DASH_FORGE_NETWORK=testnet E2E_MINT_FUNDING=/x/sakura-funding.wif -- true

# the July pool sits directly in test-identities/
J="$TMP/h-july"
for role in OWNER COLLAB CONTRIB; do stub "$J/.config/dash-forge/test-identities" "$role" "$JULY_FIRST"; done
expect_refused "testnet with the directory of the July pool" "directory of the July-era testnet pool" \
  "$J" DASH_FORGE_NETWORK=testnet "E2E_IDENTITY_DIR=$J/.config/dash-forge/test-identities" -- true
mkdir -p "$J/.config/dash-forge/test-identities/via-link"
ln -s "$J/.config/dash-forge/test-identities" "$TMP/link-to-pool"
expect_refused "testnet with a symlink to the directory of the July pool" "directory of the July-era testnet pool" \
  "$J" DASH_FORGE_NETWORK=testnet "E2E_IDENTITY_DIR=$TMP/link-to-pool" -- true
stub "$TMP/elsewhere" OWNER "$JULY_FIRST"; stub "$TMP/elsewhere" COLLAB FreshCollab11111111111111111111111111111111; stub "$TMP/elsewhere" CONTRIB FreshContrib1111111111111111111111111111111
expect_refused "testnet with a July id in a file elsewhere" "July-era testnet identities" \
  "$H" DASH_FORGE_NETWORK=testnet "E2E_IDENTITY_DIR=$TMP/elsewhere" -- true
expect_refused "testnet with no identity files" "no identity file" \
  "$TMP/h-empty" DASH_FORGE_NETWORK=testnet -- true
expect_ok "a devnet does not check the July list" "devnet" \
  "$H" DASH_FORGE_NETWORK=devnet "E2E_IDENTITY_DIR=$TMP/elsewhere" -- 'echo devnet'

echo "lib.sh require_mint_funding"
rmf() { # rmf <network> -> prints "rc=<n>"
  env -i PATH="$PATH" HOME="$TMP/h-testnet" DASH_FORGE_NETWORK="$1" E2E_MINT_FUNDING="$TMP/no-such-funding.wif" "E2E_IDENTITY_DIR=$TMP/h-testnet/.config/dash-forge/test-identities/testnet-scratch" \
    bash -c 'SCENARIO_NAME=t; source "'"$REPO"'/e2e/cli/lib.sh"; require_mint_funding "or set X"; echo reached' 2>&1
  echo "rc=$?"
}
out="$(rmf testnet)"
[[ "$out" == *"FAIL"* && "$out" == *"no testnet funding key"* && "$out" == *"rc=1" && "$out" != *reached* ]] && pass "testnet: a missing funding key fails the scenario" || fail "testnet missing funding: $out"
H="$TMP/h-devnet2"; fresh_pool "$H/.config/dash-forge/test-identities/devnet-sakura"
out="$(env -i PATH="$PATH" HOME="$H" E2E_MINT_FUNDING="$TMP/no-such-funding.wif" bash -c 'SCENARIO_NAME=t; source "'"$REPO"'/e2e/cli/lib.sh"; require_mint_funding "or set X"; echo reached' 2>&1; echo "rc=$?")"
[[ "$out" == *"SKIP"* && "$out" == *"no devnet sakura funding key"* && "$out" == *"rc=2" && "$out" != *reached* ]] && pass "devnet: a missing funding key skips (exit 2)" || fail "devnet missing funding: $out"
echo present >"$TMP/funding.wif"
out="$(env -i PATH="$PATH" HOME="$H" E2E_MINT_FUNDING="$TMP/funding.wif" bash -c 'SCENARIO_NAME=t; source "'"$REPO"'/e2e/cli/lib.sh"; require_mint_funding; echo reached' 2>&1; echo "rc=$?")"
[[ "$out" == *reached* && "$out" == *"rc=0" ]] && pass "a present funding key continues" || fail "present funding: $out"
out="$(env -i PATH="$PATH" HOME="$H" bash -c 'SCENARIO_NAME=t; source "'"$REPO"'/e2e/cli/lib.sh"; na_unless_devnet "x"; echo reached' 2>&1; echo "rc=$?")"
[[ "$out" == *reached* ]] && pass "na_unless_devnet continues on a devnet" || fail "na on devnet: $out"
out="$(env -i PATH="$PATH" HOME="$TMP/h-testnet" DASH_FORGE_NETWORK=testnet bash -c 'SCENARIO_NAME=t; source "'"$REPO"'/e2e/cli/lib.sh"; na_unless_devnet "x"; echo reached' 2>&1; echo "rc=$?")"
[[ "$out" == *"N/A"* && "$out" == *"rc=3" && "$out" != *reached* ]] && pass "na_unless_devnet exits 3 on testnet" || fail "na on testnet: $out"

echo "the July list agrees with forge-contracts/scripts/lib/target.mjs"
want="$(node -e "import('$REPO/forge-contracts/scripts/lib/target.mjs').then(m=>console.log([...m.JULY_POOL_IDS.keys()].sort().join(' ')))")"
have="$(env -i PATH="$PATH" HOME="$TMP/h-devnet" bash -c 'source "'"$REPO"'/e2e/cli/config.sh"; for i in $JULY_POOL_IDS; do echo "$i"; done' | sort | tr '\n' ' ' | sed 's/ $//')"
[[ "$want" == "$have" ]] && pass "same nine ids" || fail "JULY_POOL_IDS differ: config.sh '$have' vs target.mjs '$want'"

if [[ $FAILS -ne 0 ]]; then printf '\n%d check(s) failed\n' "$FAILS" >&2; exit 1; fi
printf '\nall checks passed\n'
