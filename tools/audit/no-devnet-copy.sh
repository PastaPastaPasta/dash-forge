#!/usr/bin/env bash
# no-devnet-copy.sh: launch criterion L10 (docs/roadmap.md §7), "no user-facing 'sakura' outside
# history and developer pages". Fails when a file a user reads names devnet sakura, the devnet
# Forge ran on before testnet (down since 2026-10-24).
#
#   tools/audit/no-devnet-copy.sh             # check the tracked files
#   tools/audit/no-devnet-copy.sh --self-test # check the checker
#
# What a user reads: the README and SECURITY.md, install.sh, everything under docs/, the Mirror
# Action, the check action, the GitLab template, the service and crate READMEs, `dg --help` (its
# snapshot), and the web app's source (string literals and JSX; comment lines are skipped).
# ALLOW below lists what stays: history, developer pages, tests and the deployment-record wiring.
# A new docs page is checked unless it is added there, with its reason.
set -euo pipefail

WORD='sakura'

# The files a user reads (git pathspecs).
SCOPE=(
  README.md SECURITY.md install.sh
  'docs/**'
  'action/**' 'check-action/**' 'integrations/**'
  'crates/*/README.md' 'services/**'
  crates/dg/tests/snapshots/dg-help.txt
  'forge-web/app/**' 'forge-web/components/**' 'forge-web/lib/**' 'forge-web/hooks/**'
  'forge-web/contexts/**' 'forge-web/public/**'
)

# What may name it (extended regex on the path).
ALLOW=(
  # history
  '^docs/archive/'
  '^docs/roadmap\.md$'
  '^docs/networks\.md$'                 # the networks record, with its history table
  '^docs/releases/v0\.1\.0\.md$'        # the release that targeted sakura
  # developer pages
  '^docs/BUILDING\.md$'
  '^docs/contracts/'
  '^docs/deploying-to-a-network\.md$'
  '^docs/design/'
  '^docs/dev/'
  '^docs/research/'
  '^docs/security/private-repos\.md$'   # the normative design, which names each contract set
  '^docs/security/passkey-vault\.md$'   # its deployment status names each network's pending forge-meta update
  '^docs/testing/'
  '^docs/upstream/'
  # tests and their data
  '\.(test|spec)\.[cm]?[jt]sx?$'
  '(^|/)test\.sh$'
  '(^|/)(testdata|fixtures?|__tests__)/'
  '\.rs$'                               # crate sources: their user strings are in the help snapshot
  # the deployment records' wiring: every recorded network, retired or not, is imported
  '^forge-web/lib/deployments\.ts$'
  '^forge-web/lib/sdk/contract-seed\.ts$'
)

allowed() {
  local path="$1" re
  for re in "${ALLOW[@]}"; do
    [[ "$path" =~ $re ]] && return 0
  done
  return 1
}

# Print `path:line: text` for every hit in one file. Web sources skip comment lines.
hits() {
  local path="$1"
  case "$path" in
    *.ts | *.tsx | *.js | *.jsx | *.mjs)
      grep -n -i -w -- "$WORD" "$path" | grep -v -E '^[0-9]+:[[:space:]]*(//|\*|/\*|\{/\*)' | sed "s|^|$path:|" || true
      ;;
    *)
      grep -n -i -w -- "$WORD" "$path" | sed "s|^|$path:|" || true
      ;;
  esac
}

check() {
  local found=0 path out
  while IFS= read -r path; do
    allowed "$path" && continue
    [[ -f "$path" ]] || continue
    out=$(hits "$path")
    if [[ -n "$out" ]]; then
      printf '%s\n' "$out"
      found=1
    fi
  done < <(git ls-files -- "${SCOPE[@]}")
  if [[ $found -ne 0 ]]; then
    echo "::error::user-facing copy names devnet sakura (L10). Forge runs on testnet: rewrite it, or, for a history or developer page, add the path to ALLOW in $0 with its reason." >&2
    return 1
  fi
  echo "no-devnet-copy: no user-facing '$WORD'"
}

self_test() {
  local tmp
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  printf 'const a = 1\n// devnet sakura in a comment\n * sakura in a doc comment\n' >"$tmp/ok.ts"
  printf "const label = 'devnet sakura'\n" >"$tmp/bad.ts"
  printf 'Fund it from the Sakura faucet.\n' >"$tmp/bad.md"
  printf 'sakuramochi is not the word\n' >"$tmp/ok.md"
  [[ -z "$(hits "$tmp/ok.ts")" ]] || { echo "self-test: a comment line counted" >&2; return 1; }
  [[ -n "$(hits "$tmp/bad.ts")" ]] || { echo "self-test: a string literal was missed" >&2; return 1; }
  [[ -n "$(hits "$tmp/bad.md")" ]] || { echo "self-test: a capitalised word was missed" >&2; return 1; }
  [[ -z "$(hits "$tmp/ok.md")" ]] || { echo "self-test: a longer word counted" >&2; return 1; }
  allowed docs/archive/devnet-move.md || { echo "self-test: the archive is not allowed" >&2; return 1; }
  allowed forge-web/lib/devnet-notice.test.ts || { echo "self-test: a test is not allowed" >&2; return 1; }
  ! allowed docs/guides/quick-start.md || { echo "self-test: a guide is allowed" >&2; return 1; }
  ! allowed forge-web/lib/devnet-notice.ts || { echo "self-test: web source is allowed" >&2; return 1; }
  echo "no-devnet-copy self-test: ok"
}

cd "$(git rev-parse --show-toplevel)"
case "${1:-}" in
  --self-test) self_test ;;
  '') check ;;
  *) echo "usage: $0 [--self-test]" >&2; exit 2 ;;
esac
