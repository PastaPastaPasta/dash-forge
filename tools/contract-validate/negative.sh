#!/usr/bin/env bash
# Negative checks: each mutation below breaks one protocol-14 rule the forge-v2 design relies on,
# and the validator must refuse every one of them. A validator that accepts a broken contract
# proves nothing about the real ones.
#
#   tools/contract-validate/negative.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
contracts="$here/../../forge-contracts/contracts"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/dash-forge-target-contract-validate}"
cargo build -q --manifest-path "$here/Cargo.toml"
bin="$CARGO_TARGET_DIR/debug/contract-validate"

fails=0
# expect_reject <label> <which: core|collab> <jq filter>
expect_reject() {
  local label="$1" which="$2" filter="$3" dir="$work/$1"
  mkdir -p "$dir"
  cp "$contracts/forge-core.json" "$contracts/forge-collab.json" "$dir/"
  jq "$filter" "$contracts/forge-$which.json" > "$dir/forge-$which.json"
  if "$bin" "$dir/forge-core.json" "$dir/forge-collab.json" > "$dir/out" 2>&1; then
    echo "NOT REJECTED: $label"
    fails=$((fails + 1))
  else
    echo "rejected: $label -> $(grep -m1 FAIL "$dir/out" | sed 's/^ *FAIL: //' | cut -c1-160)"
  fi
}

expect_reject repo-deletable core '.documentSchemas.repo.canBeDeleted = true'
expect_reject membership-mutable core '.documentSchemas.maintainer.documentsMutable = true'
expect_reject lookup-non-unique-index core '.documentSchemas.refUpdate.ownerRefersTo.anyOf[0].lookup.index = "byMember"'
expect_reject lookup-optional-key core '.documentSchemas.chunk.required -= ["repoId"]'
expect_reject permanent-on-deletable core '.documentSchemas.repoKey.ownerRefersTo.type = "permanentDocument"'
expect_reject five-operands core '.documentSchemas.label.ownerRefersTo.anyOf += [{"type":"identity"},{"type":"permanentDocument","documentType":"repo","lookup":{"index":"ownerName","keys":{"$ownerId":".","name":"name"}}},{"allOf":[{"type":"identity"},{"type":"deletableDocument","documentType":"writer","lookup":{"index":"byRepoMember","keys":{"repoId":"repoId","memberId":"."}}}]}]'
expect_reject immutable-system-prop core '.documentSchemas.repo.immutable += ["$createdAt"]'
expect_reject encrypted-too-short core '.documentSchemas.repoKey.properties.wrapped.maxItems = 16'
expect_reject cross-lookup-wrong-index collab '.documentSchemas.event.ownerRefersTo.anyOf[0].lookup.index = "byMember"'
expect_reject cross-permanent-on-deletable collab '.documentSchemas.webhook.ownerRefersTo.type = "permanentDocument"'
expect_reject cross-missing-type collab '.documentSchemas.star.properties.repoId.refersTo.documentType = "nope"'
expect_reject cross-deletable-on-permanent collab '.documentSchemas.issue.properties.repoId.refersTo.type = "deletableDocument"'
expect_reject issue-deletable-under-event-lookup collab '.documentSchemas.issue.canBeDeleted = true | del(.documentSchemas.issue.documentsKeepHistory)'
expect_reject agreement-kind-mismatch collab '.documentSchemas.event.properties.targetId.refersTo.anyOf[0].propertyAgreement.targetNumber = "title"'

if [ "$fails" -ne 0 ]; then
  echo "$fails mutation(s) were NOT rejected"
  exit 1
fi
echo "all mutations rejected"
