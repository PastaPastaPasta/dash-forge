#!/usr/bin/env bash
# Each production network's contracts only ever change by additive updates of what it registered
# (CONT-03): for every forge-contracts/contracts/registered/<network>/ directory (the byte copies of
# what <network> registered, written by freeze-registered.mjs at the registration commit), validate
# the committed set the network's record names (deployments/<network>.json `v2.contractsSet`) as an
# update of that registration, contract by contract (`contract-validate --expect-update`).
#
#   forge-contracts/scripts/validate-registered.sh <contract-validate binary>
#
# With no registered/<network>/ directory yet (before the registration commit) it says so and succeeds.
# The three roots can be overridden for a test: REGISTERED_DIR, CONTRACTS_DIR, DEPLOYMENTS_DIR.
set -euo pipefail

validator="${1:?usage: validate-registered.sh <contract-validate binary>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
contracts="${CONTRACTS_DIR:-$here/../contracts}"
registered="${REGISTERED_DIR:-$contracts/registered}"
deployments="${DEPLOYMENTS_DIR:-$here/../deployments}"

shopt -s nullglob
networks=()
for d in "$registered"/*/; do networks+=("$(basename "$d")"); done
if [ "${#networks[@]}" -eq 0 ]; then
  echo "no network registration frozen yet"
  exit 0
fi

command -v jq >/dev/null || { echo "::error::jq is required to read the deployment records" >&2; exit 1; }

for n in "${networks[@]}"; do
  record="$deployments/$n.json"
  if [ ! -f "$record" ]; then
    echo "::error::registered/$n/ is frozen but there is no deployments/$n.json to say which set $n registered" >&2
    exit 1
  fi
  set_name="$(jq -er '.v2.contractsSet' "$record")" || {
    echo "::error::deployments/$n.json records no v2.contractsSet: registered/$n/ cannot be matched to a committed set" >&2
    exit 1
  }
  case "$set_name" in
    mainnet) set_dir="$contracts/mainnet" ;;
    devnet) set_dir="$contracts" ;;
    *) echo "::error::deployments/$n.json records contractsSet '$set_name', which is not a committed set (mainnet or devnet)" >&2; exit 1 ;;
  esac
  args=()
  for name in forge-core forge-collab forge-community forge-meta; do
    if [ -f "$set_dir/$name.json" ]; then
      frozen="$registered/$n/$name.v1.json"
      if [ ! -f "$frozen" ]; then
        echo "::error::registered/$n/$name.v1.json is missing: $n registered the $set_name set, which has $name" >&2
        exit 1
      fi
      args+=("$set_dir/$name.json" --expect-update "$frozen")
    elif [ -f "$registered/$n/$name.v1.json" ]; then
      echo "::error::registered/$n/$name.v1.json is frozen but the $set_name set has no $name" >&2
      exit 1
    fi
  done
  echo "== $n: the $set_name set as an update of registered/$n/"
  "$validator" "${args[@]}"
done
