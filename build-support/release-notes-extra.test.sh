#!/bin/sh
# Test release-notes-extra.sh against fixture deployment files: which networks are listed and
# how, and when the hand-written release page is linked.
#
#   build-support/release-notes-extra.test.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
d="$tmp/forge-contracts/deployments"
mkdir -p "$d" "$tmp/docs/releases"

reg() { printf '{"contractId":"%s","status":"registered"}' "$1"; }
# A complete four-contract record.
printf '{"v2":{"forgeCore":%s,"forgeCollab":%s,"forgeCommunity":%s,"forgeMeta":%s,"contractGroupId":"GROUPA"}}' \
  "$(reg c1)" "$(reg c2)" "$(reg c3)" "$(reg c4)" > "$d/devnet-live.json"
# The pre-split shape: no forge-community, no forge-meta.
printf '{"v2":{"forgeCore":%s,"forgeCollab":%s,"contractGroupId":"GROUPB"}}' "$(reg c1)" "$(reg c2)" > "$d/devnet-old.json"
# A deploy in flight, one with no group, and one with no v2 record: none is usable.
printf '{"v2":{"forgeCore":%s,"forgeCollab":{"contractId":"c2","status":"broadcasting"},"contractGroupId":"GROUPC"}}' "$(reg c1)" > "$d/devnet-flight.json"
printf '{"v2":{"forgeCore":%s,"forgeCollab":%s}}' "$(reg c1)" "$(reg c2)" > "$d/devnet-nogroup.json"
printf '{"dapiAddresses":[]}' > "$d/testnet.json"
# A retired network is left out, even with a complete record.
printf '{"retired":true,"v2":{"forgeCore":%s,"forgeCollab":%s,"contractGroupId":"GROUPD"}}' "$(reg c1)" "$(reg c2)" > "$d/devnet-gone.json"

fail() { echo "release-notes-extra.test: $*" >&2; exit 1; }
out=$("$here/release-notes-extra.sh" 0.1.0 owner/repo v0.1.0 "$tmp")

# `dg --version` pads the key to 15 columns, then a space.
row() { printf '%-15s %s\n' "$1" "$2"; }
expected="$(row devnet-flight 'not deployed')
$(row devnet-live 'contract group GROUPA')
$(row devnet-nogroup 'not deployed')
$(row devnet-old 'contract group GROUPB')
$(row testnet 'not deployed')"
block=$(printf '%s\n' "$out" | sed -n '/^```$/,/^```$/p' | sed '1d;$d')
[ "$block" = "$expected" ] || fail "networks block is:
$block
expected:
$expected"
printf '%s\n' "$out" | grep -q GROUPD && fail "a retired network is listed"
printf '%s\n' "$out" | grep -q 'github.com/owner/repo/blob/v0.1.0/docs/networks.md' || fail "no link to docs/networks.md"

# No hand-written page: no link to it.
printf '%s\n' "$out" | grep -q 'docs/releases/' && fail "linked a release page that does not exist"
echo "# v0.1.0" > "$tmp/docs/releases/v0.1.0.md"
out=$("$here/release-notes-extra.sh" 0.1.0 owner/repo v0.1.0 "$tmp")
printf '%s\n' "$out" | grep -q '(https://github.com/owner/repo/blob/v0.1.0/docs/releases/v0.1.0.md)' || fail "no link to docs/releases/v0.1.0.md"
# A pre-release links its own page if it has one, else the page of the release it leads up to.
out=$("$here/release-notes-extra.sh" 0.1.0-rc.1 owner/repo v0.1.0-rc.1 "$tmp")
printf '%s\n' "$out" | grep -q '(https://github.com/owner/repo/blob/v0.1.0-rc.1/docs/releases/v0.1.0.md)' || fail "rc did not fall back to v0.1.0.md"
echo "# v0.1.0-rc.1" > "$tmp/docs/releases/v0.1.0-rc.1.md"
out=$("$here/release-notes-extra.sh" 0.1.0-rc.1 owner/repo v0.1.0-rc.1 "$tmp")
printf '%s\n' "$out" | grep -q 'docs/releases/v0.1.0-rc.1.md)' || fail "rc did not link its own page"
printf '%s\n' "$out" | grep -q 'docs/releases/v0.1.0.md' && fail "rc linked two pages"
rm "$tmp/docs/releases/v0.1.0-rc.1.md"
# A release with no page, and a dry-run version whose base release has none, link nothing.
out=$("$here/release-notes-extra.sh" 0.2.0 owner/repo v0.2.0 "$tmp")
printf '%s\n' "$out" | grep -q 'docs/releases/' && fail "linked a page for 0.2.0, which has none"
out=$("$here/release-notes-extra.sh" 0.2.0-dev.abc owner/repo master "$tmp")
printf '%s\n' "$out" | grep -q 'docs/releases/' && fail "a dev version of 0.2.0 links a page"

# Malformed JSON is an error, not a silently missing network.
echo '{' > "$d/devnet-broken.json"
if "$here/release-notes-extra.sh" 0.1.0 owner/repo v0.1.0 "$tmp" >/dev/null 2>&1; then fail "accepted malformed JSON"; fi

# The real deployment files give a block.
"$here/release-notes-extra.sh" 0.1.0 owner/repo v0.1.0 | grep -q '^```$' || fail "the repository's own deployments gave no block"
echo "release-notes-extra.test: ok"
