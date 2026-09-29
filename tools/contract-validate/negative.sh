#!/usr/bin/env bash
# Negative checks: each mutation below breaks one protocol-14 rule the forge-v2 design relies on,
# and the validator must refuse every one of them. A validator that accepts a broken contract
# proves nothing about the real ones.
#
#   tools/contract-validate/negative.sh [<contracts dir>]
#
# The contracts are forge-core, forge-collab and, when the directory has it, forge-community
# (the fresh beta.7 registration moves the social and CI types there; without it they are in
# forge-collab, and a `community` mutation applies to forge-collab). All in the refersTo grammar
# of platform v4.2.0-beta.7 (#5197: `findBy` / `where`). The directory defaults to
# forge-contracts/contracts.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
contracts="${1:-$here/../../forge-contracts/contracts}"
names=(forge-core forge-collab)
[ -f "$contracts/forge-community.json" ] && names+=(forge-community)
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/dash-forge-target-contract-validate}"
# Pinned like the rs-dpp tag it builds against (platform v4.2.0-beta.7's rust-toolchain.toml)
cargo +1.98.1 build -q --locked --manifest-path "$here/Cargo.toml"
bin="$CARGO_TARGET_DIR/debug/contract-validate"

for name in "${names[@]}"; do
  [ -f "$contracts/$name.json" ] || { echo "missing $contracts/$name.json"; exit 1; }
done
files() { local dir="$1" name; for name in "${names[@]}"; do printf '%s\n' "$dir/$name.json"; done; }

# The unmutated contracts must pass: otherwise every mutation below is "rejected" for the
# wrong reason.
mkdir -p "$work/baseline"
if ! "$bin" $(files "$contracts") > "$work/baseline/out" 2>&1; then
  echo "the unmutated contracts do not validate:"
  grep FAIL "$work/baseline/out" | head -5
  exit 1
fi

fails=0
# expect_reject <label> <which: core|collab|community> <jq filter>
expect_reject() {
  local label="$1" which="$2" filter="$3" dir="$work/$1" name
  [ "$which" = community ] && [ ! -f "$contracts/forge-community.json" ] && which=collab
  mkdir -p "$dir"
  for name in "${names[@]}"; do cp "$contracts/$name.json" "$dir/"; done
  jq "$filter" "$contracts/forge-$which.json" > "$dir/forge-$which.json"
  if "$bin" $(files "$dir") > "$dir/out" 2>&1; then
    echo "NOT REJECTED: $label"
    fails=$((fails + 1))
  else
    echo "rejected: $label -> $(grep -m1 FAIL "$dir/out" | sed 's/^ *FAIL: //' | cut -c1-160)"
  fi
}

expect_reject repo-deletable core '.documentSchemas.repo.canBeDeleted = true'
expect_reject membership-mutable core '.documentSchemas.maintainer.documentsMutable = true'
# findBy must name exactly the properties of a unique index (maintainer.byMember is not unique)
expect_reject findby-non-unique-index core '.documentSchemas.refUpdate.ownerRefersTo.anyOf[0].findBy = {"memberId": "."}'
expect_reject lookup-optional-key core '.documentSchemas.chunk.required -= ["repoId"]'
expect_reject permanent-on-deletable core '.documentSchemas.repoKey.ownerRefersTo.type = "permanentDocument"'
expect_reject five-operands core '.documentSchemas.label.ownerRefersTo.anyOf += [{"type":"identity"},{"type":"permanentDocument","documentType":"repo","findBy":{"$ownerId":".","name":"name"}},{"allOf":[{"type":"identity"},{"type":"deletableDocument","documentType":"writer","findBy":{"repoId":"repoId","memberId":"."}}]}]'
expect_reject immutable-system-prop core '.documentSchemas.repo.immutable += ["$createdAt"]'
expect_reject encrypted-too-short core '.documentSchemas.repoKey.properties.wrapped.maxItems = 16'
expect_reject cross-findby-non-unique-index collab '.documentSchemas.event.ownerRefersTo.anyOf[0].findBy = {"memberId": "."}'
expect_reject cross-permanent-on-deletable community '.documentSchemas.webhook.ownerRefersTo.type = "permanentDocument"'
expect_reject cross-missing-type community '.documentSchemas.star.properties.repoId.refersTo.documentType = "nope"'
expect_reject cross-deletable-on-permanent collab '.documentSchemas.issue.properties.repoId.refersTo.type = "deletableDocument"'
expect_reject issue-deletable-under-author-lookup collab '.documentSchemas.issue.canBeDeleted = true | del(.documentSchemas.issue.documentsKeepHistory)'
# the author operand finds by the unique author index ($ownerId, repoId, number); dropping
# $ownerId would find by `number` (repoId, number), which does not bind the writer
expect_reject author-findby-wrong-index collab '.documentSchemas.authorEvent.ownerRefersTo.anyOf[0].findBy |= del(."$ownerId")'
expect_reject author-lookup-optional-key collab '.documentSchemas.authorEvent.required -= ["targetNumber"]'
expect_reject author-lookup-optional-repo collab '.documentSchemas.authorEvent.required -= ["repoId"]'
# `where` keyed by the found document's $id needs an identifier on the referring side
expect_reject author-where-non-id collab '.documentSchemas.authorEvent.ownerRefersTo.anyOf[1].where = {"$id": "targetNumber"}'
# `where` pairs the found issue's `title` (a string) with our `kind` (an integer)
expect_reject where-kind-mismatch collab '.documentSchemas.event.properties.targetId.refersTo.anyOf[0].where.title = "kind"'
expect_reject key-id-not-integer core '.documentSchemas.repoKey.properties.recipientKeyId = {"type":"string","maxLength":10,"position":3}'
expect_reject key-ref-on-identity-with-own-key community '.documentSchemas.webhook.properties.senderKeyId.refersTo.identityProperty = "relayIdentityId"'
expect_reject membership-non-deletable core '.documentSchemas.maintainer.canBeDeleted = false'
# the protocol-14-beta spellings are refused on every parse (platform#5197)
expect_reject old-lookup-keyword core '.documentSchemas.refUpdate.ownerRefersTo.anyOf[0] |= (del(.findBy) + {"lookup": {"index": "byRepoMember", "keys": {"repoId": "repoId", "memberId": "."}}})'
expect_reject old-property-agreement-keyword collab '.documentSchemas.comment.properties.reviewId.refersTo |= (del(.where) + {"propertyAgreement": {"repoId": "repoId"}})'
# review parity (docs/design/review-parity-spec.md §3)
expect_reject review-link-permanent-on-deletable collab '.documentSchemas.comment.properties.reviewId.refersTo.type = "permanentDocument"'
expect_reject review-link-where-missing-prop collab '.documentSchemas.comment.properties.reviewId.refersTo.where.patchId = "nope"'
expect_reject policy-gate-permanent-on-deletable community '.documentSchemas.policy.ownerRefersTo.type = "permanentDocument"'
expect_reject immutable-unknown-prop collab '.documentSchemas.patch.immutable += ["nope"]'
expect_reject immutable-on-immutable-type community '.documentSchemas.policy.immutable = ["repoId"]'
# C-1 (platform-parity-spec §4, §6)
# a timeRange index needs $createdAt required, which is why star is not fused with trending
expect_reject timerange-without-createdat community '.documentSchemas.starBeat.required = ["repoId"]'
# every indexOnly type keeps a $createdAt-free proof index
expect_reject beat-without-proof-index community '.documentSchemas.starBeat.indices |= map(select(.name != "byOwner"))'
# the window's ttl is capped at one week (protocol 14)
expect_reject beat-ttl-over-a-week community '.documentSchemas.starBeat.indices[1].timeRange.ttl = 691200'
# ranked needs the range axis
expect_reject ranked-without-range community 'del(.documentSchemas.star.indices[0].rangeCountable)'
# a runner is granted by the repo owner only, exactly like maintainer / writer
expect_reject runner-gate-permanent-on-deletable community '.documentSchemas.checkRun.ownerRefersTo.anyOf[0].type = "permanentDocument"'
# a rule may only read properties the type has
expect_reject rule-reads-unknown-property community '.documentSchemas.checkRun.propertyConstraints.conclusionIfDone.anyOf[1].present = "nope"'
# a string constant must be one of the property's enum values
expect_reject rule-const-outside-enum community '.documentSchemas.checkRun.propertyConstraints.conclusionIfDone.anyOf[0].notEqual[1].const = "done"'
# indexed strings are at most 63 characters
expect_reject topic-name-too-long-for-an-index core '.documentSchemas.topic.properties.name.maxLength = 64'

# A later forge-core change ships as an in-place update of the registered schema
# (registered/forge-core.v1.json, which the fresh registration at each wipe replaces; a directory
# without one checks against forge-core.json itself): a change the update rules refuse (here an
# index flag or a rule of a registered type) must fail --expect-update against it.
registered="$contracts/registered/forge-core.v1.json"
[ -f "$registered" ] || registered="$contracts/forge-core.json"
expect_update_refused() {
  local label="$1" filter="$2" dir="$work/$1"
  mkdir -p "$dir"
  jq "$filter" "$contracts/forge-core.json" > "$dir/forge-core.json"
  # Refused by the update rules themselves, not by a sample or a parse error
  if "$bin" "$dir/forge-core.json" --expect-update "$registered" > "$dir/out" 2>&1 \
    || ! grep -q 'REFUSED by validate_update' "$dir/out"; then
    echo "NOT REJECTED: $label"
    fails=$((fails + 1))
  else
    echo "rejected: $label -> $(grep -m1 -A1 'REFUSED' "$dir/out" | tail -1 | sed 's/^ *//' | cut -c1-160)"
  fi
}
expect_update_refused update-changes-a-registered-index '.documentSchemas.repo.indices[1].rangeCountable = true'
expect_update_refused update-changes-a-rule '.documentSchemas.label.propertyConstraints.noPlain.anyOf[1].allOf[1].absent = "retired"'

if [ "$fails" -ne 0 ]; then
  echo "$fails mutation(s) were NOT rejected"
  exit 1
fi
echo "all mutations rejected"
