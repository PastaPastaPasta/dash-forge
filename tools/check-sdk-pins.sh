#!/usr/bin/env bash
# check-sdk-pins.sh: fail when the Dash Platform SDK pin disagrees anywhere (HYGI-18).
#
# The Platform version is written separately in six manifests and four lockfiles: the seven git
# deps of Cargo.toml (plus its PLATFORM_TAG line), tools/contract-validate/Cargo.toml, the npm pins
# of forge-web (evo-sdk, wasm-sdk), forge-contracts/sdk-v2 and tools/mint-identity, and the pnpm
# minimumReleaseAgeExclude entries. A bump must move all of them together (see the bump steps in
# Cargo.toml), because clients at different rs-dpp versions can disagree with each other and with
# the network silently. Every source must be present: a pin that disappears fails as well as one
# that differs. Run from anywhere; CI runs it in ci.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
records=''

# expect <label> <count> <versions, one per line>: the source must yield exactly <count> versions
expect() {
  local label=$1 want=$2 got
  got=$(printf '%s\n' "$3" | grep -c . || true)
  if [[ $got -ne $want ]]; then
    echo "$label: expected $want Platform pin(s), found $got"
    fail=1
  fi
  while IFS= read -r v; do
    [[ -n $v ]] && records+="${v#v}	$label"$'\n'
  done <<<"$3"
}

platform_git='git = "https://github.com/dashpay/platform.git"'
tags() { grep -F "$platform_git" "$1" | sed -E 's/.*tag = "([^"]+)".*/\1/' || true; }
npm_pin() { # <package.json> <package>
  node -e 'const p=require(process.argv[1]); console.log((p.dependencies||{})[process.argv[2]] ?? (p.devDependencies||{})[process.argv[2]] ?? "")' "./$1" "$2"
}
npm_lock() { # <package-lock.json> <package>
  node -e 'console.log(require(process.argv[1]).packages["node_modules/"+process.argv[2]]?.version ?? "")' "./$1" "$2"
}
cargo_lock() { # <Cargo.lock> <package>: the tag of the platform.git source that package resolved to
  awk -v pkg="$2" '$0 == "name = \"" pkg "\"" {hit=1; next} /^name = / {hit=0} hit && /^source = / {print; hit=0}' "$1" |
    sed -nE 's/.*platform\.git\?tag=([^#"]+).*/\1/p'
}
pnpm_lock() { # <package>: the resolved versions of exactly that package in pnpm-lock.yaml's packages
  sed -nE "s/^  '?$(sed 's/[/.]/\\&/g' <<<"$1")@([0-9][^':(]*)'?:\$/\1/p" forge-web/pnpm-lock.yaml | sort -u
}

expect Cargo.toml 7 "$(tags Cargo.toml)"
expect 'Cargo.toml (PLATFORM_TAG)' 1 "$(sed -nE 's/^# PLATFORM_TAG = (.*)$/\1/p' Cargo.toml)"
expect tools/contract-validate/Cargo.toml 1 "$(tags tools/contract-validate/Cargo.toml)"
expect 'Cargo.lock (dash-sdk)' 1 "$(cargo_lock Cargo.lock dash-sdk)"
expect 'Cargo.lock (dpp)' 1 "$(cargo_lock Cargo.lock dpp)"
expect 'tools/contract-validate/Cargo.lock (dpp)' 1 "$(cargo_lock tools/contract-validate/Cargo.lock dpp)"
# and no other platform crate may resolve to a different tag (each distinct tag counts once)
for lock in Cargo.lock tools/contract-validate/Cargo.lock; do
  expect "$lock (every platform.git source)" 1 \
    "$(grep -oE 'platform\.git\?tag=[^#"]+' "$lock" | sed 's/.*tag=//' | sort -u)"
done

for pkg in @dashevo/evo-sdk @dashevo/wasm-sdk; do
  expect "forge-web/package.json ($pkg)" 1 "$(npm_pin forge-web/package.json "$pkg")"
  expect "forge-web/pnpm-lock.yaml ($pkg)" 1 "$(pnpm_lock "$pkg")"
  expect "forge-web/pnpm-workspace.yaml ($pkg)" 1 \
    "$(sed -nE "s/^  - '$(sed 's/[/.]/\\&/g' <<<"$pkg")@([^']+)'\$/\1/p" forge-web/pnpm-workspace.yaml)"
done
for dir in forge-contracts/sdk-v2 tools/mint-identity; do
  expect "$dir/package.json (@dashevo/evo-sdk)" 1 "$(npm_pin "$dir/package.json" @dashevo/evo-sdk)"
  for pkg in @dashevo/evo-sdk @dashevo/wasm-sdk; do
    expect "$dir/package-lock.json ($pkg)" 1 "$(npm_lock "$dir/package-lock.json" "$pkg")"
  done
done

versions=$(printf '%s' "$records" | cut -f1 | sort -u)
if [[ $(printf '%s\n' "$versions" | grep -c .) -gt 1 ]]; then
  echo "Platform SDK pins disagree:"
  printf '%s' "$records" | sort | uniq -c | sed 's/^ */  /'
  fail=1
fi
if [[ $fail -ne 0 ]]; then
  exit 1
fi
echo "Platform SDK pinned at $versions in $(printf '%s' "$records" | grep -c .) places"
