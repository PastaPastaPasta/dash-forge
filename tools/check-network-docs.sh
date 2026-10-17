#!/usr/bin/env bash
# Testnet is the primary network: "sakura" (case-insensitive) must not appear in user-facing
# docs or UI strings except where a devnet is the subject. Prints every offending line and
# exits 1 if there is one. Run from anywhere: tools/check-network-docs.sh
#
# Checked (the user-facing surface):
#   - README.md, CONTRIBUTING.md, SECURITY.md, docs/INSTALL.md, docs/FAQ.md, docs/VERSIONING.md,
#     docs/errors.md, docs/networks.md, docs/hosting.md, docs/hosted-curation.md,
#     docs/mainnet-runbook.md, docs/deploying-to-a-network.md, docs/limits.md,
#     docs/security/audiences.md, docs/guides/, docs/hosting/,
#     .github/ISSUE_TEMPLATE/
#   - the READMEs of the crates and services (crates/*/README.md, services/*/README.md)
#   - the Actions, their READMEs and the GitLab template (action/, check-action/, integrations/gitlab/),
#     except their tests
#   - the web app's UI code (forge-web/app, components, hooks and lib/devnet-notice.ts), except
#     tests; a line that is only a code comment is not a UI string and is not checked
#
# Allowed (the whole list; keep it small):
#   - History sections: a markdown section whose heading is exactly "History" (`## History`), up
#     to the next heading of the same or a higher level. Headings are read only in .md files and
#     never inside a fenced code block.
#   - docs/networks.md: its devnet row in the "Where Forge runs today" table (the line that starts
#     with `| **Devnet**`), the one place the optional developer network is introduced.
#   Not checked at all, because a devnet is their subject or they are fixtures: CHANGELOG.md,
#   docs/releases/, docs/archive/, forge-contracts/deployments/, test files and fixtures, the
#   developer docs (docs/BUILDING.md, docs/contracts/, docs/design/, docs/testing/,
#   docs/security/ except audiences.md, e2e/, tools/, forge-web/README.md) and code that
#   implements devnet support.
set -euo pipefail

cd "$(dirname "$0")/.."

docs=$(git ls-files -- \
  README.md CONTRIBUTING.md SECURITY.md \
  docs/INSTALL.md docs/FAQ.md docs/VERSIONING.md docs/errors.md docs/networks.md docs/hosting.md \
  docs/hosted-curation.md docs/mainnet-runbook.md docs/deploying-to-a-network.md docs/limits.md \
  docs/security/audiences.md \
  'docs/guides/*.md' 'docs/hosting/*.md' '.github/ISSUE_TEMPLATE/*' \
  'crates/*/README.md' 'services/*/README.md' \
  action/README.md action/action.yml check-action/README.md check-action/action.yml \
  integrations/gitlab/README.md integrations/gitlab/dash-forge-mirror.yml || true)

code=$(git ls-files -- 'forge-web/app' 'forge-web/components' 'forge-web/hooks' 'forge-web/lib/devnet-notice.ts' |
  grep -E '\.(ts|tsx)$' | grep -Ev '\.(test|live\.test|spec)\.(ts|tsx)$' || true)

fail=0

# Markdown reads headings (outside code fences) to skip History sections; other files are plain
# text, where a `#` line is a comment, not a heading.
for f in $docs; do
  case "$f" in
    docs/networks.md) allow_prefix='| **Devnet**' ;;
    *) allow_prefix='' ;;
  esac
  hits=$(awk -v file="$f" -v md="$([ "${f##*.}" = md ] && echo 1 || echo 0)" -v allow_prefix="$allow_prefix" '
    md == 1 && /^[[:space:]]*(```|~~~)/ { fence = !fence; if (!skip && tolower($0) ~ /sakura/) bad(); next }
    md == 1 && !fence && /^#+[[:space:]]/ {
      match($0, /^#+/)
      level = RLENGTH
      if (skip && level <= skip_level) skip = 0
      if (!skip && $0 ~ /^#+ +History *$/) { skip = 1; skip_level = level; next }
    }
    !skip && tolower($0) ~ /sakura/ && !(allow_prefix != "" && index($0, allow_prefix) == 1) { bad() }
    function bad() { printf "%s:%d: %s\n", file, NR, $0 }
  ' "$f")
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    fail=1
  fi
done

# UI code: a line that is only a comment is exempt.
for f in $code; do
  hits=$(awk -v file="$f" '
    tolower($0) ~ /sakura/ && $0 !~ /^[[:space:]]*(\/\/|\/\*|\*|\{\/\*)/ { printf "%s:%d: %s\n", file, NR, $0 }
  ' "$f")
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo >&2
  echo 'check-network-docs: "sakura" appears above in user-facing docs or UI strings.' >&2
  echo 'Testnet is the primary network: say testnet, or "a devnet" / "<name>" for the optional developer network.' >&2
  echo 'History belongs in a section headed exactly "History"; see the allow-list at the top of tools/check-network-docs.sh.' >&2
  exit 1
fi
echo 'check-network-docs: ok'
