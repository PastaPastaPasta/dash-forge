#!/bin/sh
# The two blocks release.yml appends to the generated release notes:
#
#   * "Networks": which networks the binaries have Forge contracts for, from the deployment
#     files at the tagged commit. It is what `dg --version` prints (crates/dg/src/main.rs
#     `long_version`, over forge_core::network::deployment): retired networks are left out, and
#     a network shows its contract group only when its forge-v2 record is complete (the group
#     recorded and every contract registered, V2Record::ids), else "not deployed".
#   * a link to the hand-written docs/releases/v<version>.md, when that file exists. A
#     pre-release (1.2.0-rc.1) falls back to the page of the release it leads up to
#     (docs/releases/v1.2.0.md) when it has none of its own.
#
#   build-support/release-notes-extra.sh VERSION REPO REF [ROOT]
#
# REPO is owner/name and REF the tag (or branch) the links point at; ROOT is the checkout
# (default: this repository). Needs jq.
set -eu
# Glob order is the order dg lists networks in (file names, sorted bytewise).
export LC_ALL=C

version=${1:?usage: release-notes-extra.sh VERSION REPO REF [ROOT]}
repo=${2:?usage: release-notes-extra.sh VERSION REPO REF [ROOT]}
ref=${3:?usage: release-notes-extra.sh VERSION REPO REF [ROOT]}
root=${4:-$(cd "$(dirname "$0")/.." && pwd)}

deployments="$root/forge-contracts/deployments"
[ -d "$deployments" ] || { echo "release-notes-extra: no $deployments" >&2; exit 1; }

# One line per network, in file-name order (the order `dg --version` uses: the embedded files
# are sorted by name).
rows=""
for file in "$deployments"/*.json; do
  key=$(basename "$file" .json)
  state=$(jq --raw-output '
    def registered(r): r != null and r.status == "registered" and ((r.contractId // "") != "");
    if .retired == true then "retired"
    else
      (.v2 // null) as $v
      | if $v != null
           and (($v.contractGroupId // "") != "")
           and registered($v.forgeCore)
           and registered($v.forgeCollab)
           and ($v.forgeCommunity == null or registered($v.forgeCommunity))
           and ($v.forgeMeta == null or registered($v.forgeMeta))
        then "contract group \($v.contractGroupId)"
        else "not deployed"
        end
    end' "$file") || { echo "release-notes-extra: $file is not valid JSON" >&2; exit 1; }
  [ "$state" = retired ] && continue
  rows="${rows}$(printf '%-15s %s' "$key" "$state")
"
done

cat <<NOTES
## Networks

The binaries in this release have the Forge contracts below built in, one contract group per
network (\`dg --version\` prints the same list). A network marked "not deployed" has no Forge
contracts registered yet, so this release cannot use it. More on each network:
[docs/networks.md](https://github.com/${repo}/blob/${ref}/docs/networks.md).

\`\`\`
${rows%?}
\`\`\`
NOTES

page=""
if [ -f "$root/docs/releases/v${version}.md" ]; then
  page="v${version}.md"
elif [ "${version#*-}" != "$version" ] && [ -f "$root/docs/releases/v${version%%-*}.md" ]; then
  page="v${version%%-*}.md"
fi
if [ -n "$page" ]; then
  cat <<NOTES

## Release notes

What is in this release, its known limitations and how to upgrade:
[docs/releases/${page}](https://github.com/${repo}/blob/${ref}/docs/releases/${page}).
NOTES
fi
