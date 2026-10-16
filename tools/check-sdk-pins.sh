#!/usr/bin/env bash
# check-sdk-pins.sh: fail when the Dash Platform SDK pin disagrees anywhere (HYGI-18).
#
# The Platform version is written separately in six manifests and four lockfiles: the seven git
# deps of Cargo.toml (plus its PLATFORM_TAG line), tools/contract-validate/Cargo.toml, the npm pins
# of forge-web (evo-sdk, wasm-sdk), forge-contracts/sdk-v2 and tools/mint-identity, and the pnpm
# minimumReleaseAgeExclude entries. A bump must move all of them together (see the bump steps in
# Cargo.toml), because clients at different rs-dpp versions can disagree with each other and with
# the network silently. Run from anywhere; CI runs it in ci.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
declare -a seen=()

# record <file> <version>: one pin, normalised without a leading "v"
record() {
  seen+=("${2#v}	$1")
}

# Cargo.toml: every platform.git dependency's tag, and the PLATFORM_TAG comment the bump note names
while IFS= read -r tag; do record Cargo.toml "$tag"; done < <(
  grep -E '^[a-z0-9-]+ = \{ git = "https://github.com/dashpay/platform.git"' Cargo.toml |
    sed -E 's/.*tag = "([^"]+)".*/\1/')
n=$(grep -cE '^[a-z0-9-]+ = \{ git = "https://github.com/dashpay/platform.git"' Cargo.toml || true)
if [[ $n -ne 7 ]]; then
  echo "Cargo.toml: expected 7 platform.git dependencies, found $n (update this check if that is intended)"
  fail=1
fi
record 'Cargo.toml (PLATFORM_TAG)' "$(sed -nE 's/^# PLATFORM_TAG = (.*)$/\1/p' Cargo.toml)"

while IFS= read -r tag; do record tools/contract-validate/Cargo.toml "$tag"; done < <(
  grep -E 'git = "https://github.com/dashpay/platform.git"' tools/contract-validate/Cargo.toml |
    sed -E 's/.*tag = "([^"]+)".*/\1/')

# npm pins
for spec in \
  'forge-web/package.json @dashevo/evo-sdk' \
  'forge-web/package.json @dashevo/wasm-sdk' \
  'forge-contracts/sdk-v2/package.json @dashevo/evo-sdk' \
  'tools/mint-identity/package.json @dashevo/evo-sdk'; do
  read -r f pkg <<<"$spec"
  v=$(node -e 'const p=require(process.argv[1]); console.log((p.dependencies||{})[process.argv[2]] ?? (p.devDependencies||{})[process.argv[2]] ?? "")' "./$f" "$pkg")
  if [[ -z $v ]]; then
    echo "$f: no $pkg dependency"
    fail=1
  else
    record "$f ($pkg)" "$v"
  fi
done

# pnpm's release-age exemption names the same versions
while IFS= read -r v; do record forge-web/pnpm-workspace.yaml "$v"; done < <(
  sed -nE "s/^  - '@dashevo\/(evo|wasm)-sdk@([^']+)'$/\2/p" forge-web/pnpm-workspace.yaml)

# Lockfiles: what actually resolved
lock_platform() { # <Cargo.lock> -> the tag of every platform.git source
  grep -oE 'git\+https://github.com/dashpay/platform.git\?tag=[^#"]+' "$1" | sed 's/.*tag=//' | sort -u
}
while IFS= read -r v; do record Cargo.lock "$v"; done < <(lock_platform Cargo.lock)
while IFS= read -r v; do record tools/contract-validate/Cargo.lock "$v"; done < <(
  lock_platform tools/contract-validate/Cargo.lock)
while IFS= read -r v; do record forge-web/pnpm-lock.yaml "$v"; done < <(
  sed -nE "s/^  '@dashevo\/(evo|wasm)-sdk@([^']+)':$/\2/p" forge-web/pnpm-lock.yaml | sort -u)
for f in forge-contracts/sdk-v2/package-lock.json tools/mint-identity/package-lock.json; do
  record "$f" "$(node -e 'console.log(require(process.argv[1]).packages["node_modules/@dashevo/evo-sdk"]?.version ?? "")' "./$f")"
done

versions=$(printf '%s\n' "${seen[@]}" | cut -f1 | sort -u)
if [[ $(printf '%s\n' "$versions" | grep -c .) -ne 1 ]]; then
  echo "Platform SDK pins disagree:"
  printf '%s\n' "${seen[@]}" | sort | uniq -c | sed 's/^ */  /'
  fail=1
fi
if [[ $fail -ne 0 ]]; then
  exit 1
fi
echo "Platform SDK pinned at $versions in ${#seen[@]} places"
