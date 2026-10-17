#!/usr/bin/env bash
# test-config.sh — offline checks of config.sh's network rules and lib.sh's require_mint_funding.
#
#   bash e2e/cli/test-config.sh
#
# No network, no keys: identity files are fake {"identityId": ...} stubs under a temporary HOME.
# Covers the testnet rules of release plan WS-D (QA-05, QA-V-05, HYGI-12): OWNER is the owner role
# on every network, DEPLOYER and the July-era pool are refused, the funding wallet is explicit on every
# network (no default, HYGI-12), the per-network identity directory is the default, and a missing
# funding key fails a minting scenario on testnet and skips on a devnet.
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
expect_ok "devnet defaults: sakura, OWNER, devnet-sakura dir, no funding key (HYGI-12), sakura lock" \
  "devnet sakura OWNER $H/.config/dash-forge/test-identities/devnet-sakura [] /tmp/qa-mint-sakura.lock --network devnet --devnet-name sakura" \
  "$H" -- 'echo "$DASH_FORGE_NETWORK $DASH_FORGE_DEVNET_NAME $E2E_OWNER_ROLE $E2E_IDENTITY_DIR [$E2E_MINT_FUNDING] $E2E_MINT_LOCK ${E2E_MINT_NET_ARGS[*]}"'
expect_refused "an unknown network" "must be devnet or testnet" "$H" DASH_FORGE_NETWORK=mainnet -- true
expect_refused "a devnet name that is not [a-z0-9-]" "DASH_FORGE_DEVNET_NAME must match" "$H" 'DASH_FORGE_DEVNET_NAME=../x' -- true

H="$TMP/h-testnet"
fresh_pool "$H/.config/dash-forge/test-identities/testnet-scratch"
expect_ok "testnet defaults: no devnet name, OWNER, testnet-scratch dir, no funding key (HYGI-12), testnet lock" \
  "testnet [] OWNER $H/.config/dash-forge/test-identities/testnet-scratch [] /tmp/qa-mint-testnet.lock --network testnet" \
  "$H" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 -- 'echo "$DASH_FORGE_NETWORK [$DASH_FORGE_DEVNET_NAME] $E2E_OWNER_ROLE $E2E_IDENTITY_DIR [$E2E_MINT_FUNDING] $E2E_MINT_LOCK ${E2E_MINT_NET_ARGS[*]}"'
expect_refused "testnet without E2E_LIVE_TARGET=1 (QA-14: the suite writes permanent documents to the live registration)" "E2E_LIVE_TARGET=1" \
  "$H" DASH_FORGE_NETWORK=testnet -- true
expect_refused "testnet with E2E_LIVE_TARGET=0" "E2E_LIVE_TARGET=1" "$H" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=0 -- true
expect_ok "a devnet needs no E2E_LIVE_TARGET" "devnet" "$TMP/h-devnet" -- 'echo "$DASH_FORGE_NETWORK"'
expect_ok "testnet ignores a devnet name from the environment" "[]" \
  "$H" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 DASH_FORGE_DEVNET_NAME=sakura -- 'echo "[$DASH_FORGE_DEVNET_NAME]"'
expect_ok "testnet: a QA-harness directory or variable never supplies a funding key (explicit and required, HYGI-12)" "[]" \
  "$H" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 DASH_FORGE_QA_DIR=/qa TESTNET_FUNDING=/q/testnet-funding.wif MOUTAI_FUNDING=/q/moutai-funding.wif -- 'echo "[$E2E_MINT_FUNDING]"'
expect_refused "testnet with E2E_OWNER_ROLE=DEPLOYER" "DEPLOYER" "$H" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 E2E_OWNER_ROLE=DEPLOYER -- true
expect_refused "testnet with a devnet funding key" "devnet funding key" "$H" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 E2E_MINT_FUNDING=/x/sakura-funding.wif -- true

# the July pool sits directly in test-identities/
J="$TMP/h-july"
for role in OWNER COLLAB CONTRIB; do stub "$J/.config/dash-forge/test-identities" "$role" "$JULY_FIRST"; done
expect_refused "testnet with the directory of the July pool" "directory of the July-era testnet pool" \
  "$J" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 "E2E_IDENTITY_DIR=$J/.config/dash-forge/test-identities" -- true
ln -s "$J/.config/dash-forge/test-identities" "$TMP/link-to-pool"
expect_refused "testnet with a symlink to the directory of the July pool" "directory of the July-era testnet pool" \
  "$J" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 "E2E_IDENTITY_DIR=$TMP/link-to-pool" -- true
stub "$TMP/elsewhere" OWNER "$JULY_FIRST"; stub "$TMP/elsewhere" COLLAB FreshCollab11111111111111111111111111111111; stub "$TMP/elsewhere" CONTRIB FreshContrib1111111111111111111111111111111
expect_refused "testnet with a July id in a file elsewhere" "July-era testnet identities" \
  "$H" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 "E2E_IDENTITY_DIR=$TMP/elsewhere" -- true
expect_refused "testnet with no identity files" "no identity file" \
  "$TMP/h-empty" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 -- true
expect_ok "a devnet does not check the July list" "devnet" \
  "$H" DASH_FORGE_NETWORK=devnet "E2E_IDENTITY_DIR=$TMP/elsewhere" -- 'echo devnet'

echo "lib.sh require_mint_funding"
# libsh <HOME> <snippet> [VAR=value ...]: runs the snippet after sourcing lib.sh in a clean environment; prints its output, then rc=<status>
libsh() {
  local home="$1" snippet="$2"; shift 2
  env -i PATH="$PATH" HOME="$home" "$@" bash -c 'SCENARIO_NAME=t; source "'"$REPO"'/e2e/cli/lib.sh"; '"$snippet" 2>&1
  echo "rc=$?"
}
out="$(libsh "$TMP/h-testnet" 'require_mint_funding "or set X"; echo reached' DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 "E2E_MINT_FUNDING=$TMP/testnet-funding-absent.wif" "E2E_IDENTITY_DIR=$TMP/h-testnet/.config/dash-forge/test-identities/testnet-scratch")"
[[ "$out" == *"FAIL"* && "$out" == *"no testnet funding key"* && "$out" == *"rc=1" && "$out" != *reached* ]] && pass "testnet: a missing funding key fails the scenario" || fail "testnet missing funding: $out"
H="$TMP/h-devnet2"; fresh_pool "$H/.config/dash-forge/test-identities/devnet-sakura"
out="$(libsh "$H" 'require_mint_funding "or set X"; echo reached' "E2E_MINT_FUNDING=$TMP/no-such-funding.wif")"
[[ "$out" == *"SKIP"* && "$out" == *"no devnet sakura funding key"* && "$out" == *"rc=2" && "$out" != *reached* ]] && pass "devnet: a missing funding key skips (exit 2)" || fail "devnet missing funding: $out"
echo present >"$TMP/funding.wif"
out="$(libsh "$H" 'require_mint_funding; echo reached' "E2E_MINT_FUNDING=$TMP/funding.wif")"
[[ "$out" == *reached* && "$out" == *"rc=0" ]] && pass "a present funding key continues" || fail "present funding: $out"
out="$(libsh "$H" 'na_unless_devnet "x"; echo reached')"
[[ "$out" == *reached* ]] && pass "na_unless_devnet continues on a devnet" || fail "na on devnet: $out"
out="$(libsh "$TMP/h-testnet" 'na_unless_devnet "x"; echo reached' DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1)"
[[ "$out" == *"N/A"* && "$out" == *"rc=3" && "$out" != *reached* ]] && pass "na_unless_devnet exits 3 on testnet" || fail "na on testnet: $out"

echo "lib.sh na_scenario: the N/A marker"
out="$(libsh "$TMP/h-testnet" 'na_scenario "x"; echo reached' DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 "E2E_NA_MARKER=$TMP/na-marker")"
[[ "$out" == *"rc=3" && -e "$TMP/na-marker" ]] && pass "na_scenario exits 3 and leaves the marker" || fail "na_scenario marker: $out"
rm -f "$TMP/na-marker"
out="$(libsh "$TMP/h-testnet" 'exit 3' DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 "E2E_NA_MARKER=$TMP/na-marker")"
[[ "$out" == *"rc=3" && ! -e "$TMP/na-marker" ]] && pass "a bare exit 3 leaves no marker (run.sh FAILs it)" || fail "bare exit 3: $out"

echo "run.sh: the summary line, the skip ceilings, the N/A marker"
# nightly.yml greps the matrix line; run.sh must still print what it matches
fmt="$(sed -nE "s/^printf '(  passed=[^']*)'.*/\1/p" "$REPO/e2e/cli/run.sh")"
re="$(sed -nE "s/.*grep -oE '(passed=[^']*)'.*/\1/p" "$REPO/.github/workflows/nightly.yml" | head -1)"
if [[ -z "$fmt" || -z "$re" ]]; then
  fail "could not find the summary printf in run.sh ('$fmt') or the grep in nightly.yml ('$re')"
else
  # shellcheck disable=SC2059 # the format string comes from run.sh
  line="$(printf "$fmt" 5 1 0 2 3)"
  [[ "$(grep -oE "$re" <<<"$line")" == "passed=5  skipped=1  failed=0" ]] && pass "the summary line matches nightly.yml's grep: $line" || fail "nightly.yml's grep '$re' does not match run.sh's line '$line'"
fi
grep -q ': "${E2E_MAX_SKIPS:=1}"' "$REPO/e2e/cli/run.sh" && pass "flake skips: E2E_MAX_SKIPS defaults to 1" || fail "E2E_MAX_SKIPS does not default to 1"
grep -q ': "${E2E_MAX_INFRA_DROPS:=3}"' "$REPO/e2e/cli/run.sh" && pass "infra drops: E2E_MAX_INFRA_DROPS defaults to 3" || fail "E2E_MAX_INFRA_DROPS does not default to 3"
grep -q 'DROPPED=$((DROPPED+1))' "$REPO/e2e/cli/run.sh" && ! grep -qE 'NO_INFRA.*SKIPPED|SKIPPED.*not run: the local S3' "$REPO/e2e/cli/run.sh" && pass "a scenario dropped for missing infra is counted as a drop, not a skip" || fail "run.sh counts an infra drop as a skip"
grep -q 'E2E_NA_MARKER' "$REPO/e2e/cli/run.sh" && pass "run.sh checks the N/A marker" || fail "run.sh ignores the N/A marker"
for n in 31 32 34; do
  grep -q 'require_not_july "$ID"' "$REPO"/e2e/cli/scenarios/$n-*.sh && pass "scenario $n runs E2E_IMPORT_IDENTITY through require_not_july" || fail "scenario $n does not check its import identity"
done

echo "lib.sh require_not_july, and the funding key"
stub "$TMP/jul" RUNNER "$JULY_FIRST"; stub "$TMP/fresh" RUNNER FreshRunner111111111111111111111111111111111
out="$(libsh "$TMP/h-testnet" "require_not_july '$TMP/jul/RUNNER.identity.json'; echo reached" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1)"
[[ "$out" == *"July-era testnet identity"* && "$out" == *"rc=1" && "$out" != *reached* ]] && pass "testnet: a July identity from an override is refused" || fail "require_not_july july: $out"
out="$(libsh "$TMP/h-testnet" "require_not_july '$TMP/fresh/RUNNER.identity.json'; echo reached" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1)"
[[ "$out" == *reached* && "$out" == *"rc=0" ]] && pass "testnet: a fresh identity from an override passes" || fail "require_not_july fresh: $out"
out="$(libsh "$H" "require_not_july '$TMP/jul/RUNNER.identity.json'; echo reached")"
[[ "$out" == *reached* ]] && pass "devnet: require_not_july is a no-op" || fail "require_not_july devnet: $out"
expect_refused "testnet with some other devnet's funding key" "looks like a devnet funding key" "$TMP/h-testnet" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 E2E_MINT_FUNDING=/x/newnet-funding.wif -- true
expect_ok "testnet: an explicit E2E_MINT_FUNDING is honoured" "/q/testnet-funding.wif" "$TMP/h-testnet" DASH_FORGE_NETWORK=testnet E2E_LIVE_TARGET=1 E2E_MINT_FUNDING=/q/testnet-funding.wif -- 'echo "$E2E_MINT_FUNDING"'

echo "the July list agrees with forge-contracts/scripts/lib/target.mjs"
want="$(node -e "import('$REPO/forge-contracts/scripts/lib/target.mjs').then(m=>console.log([...m.JULY_POOL_IDS.keys()].sort().join(' ')))")"
have="$(env -i PATH="$PATH" HOME="$TMP/h-devnet" bash -c 'source "'"$REPO"'/e2e/cli/config.sh"; for i in $JULY_POOL_IDS; do echo "$i"; done' | sort | tr '\n' ' ' | sed 's/ $//')"
[[ "$want" == "$have" ]] && pass "same nine ids" || fail "JULY_POOL_IDS differ: config.sh '$have' vs target.mjs '$want'"

if [[ $FAILS -ne 0 ]]; then printf '\n%d check(s) failed\n' "$FAILS" >&2; exit 1; fi
printf '\nall checks passed\n'
