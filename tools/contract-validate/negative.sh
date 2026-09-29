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
# Pinned like the rs-dpp tag it builds against (platform v4.2.0-beta.7's rust-toolchain.toml)
cargo +1.98.1 build -q --locked --manifest-path "$here/Cargo.toml"
bin="$CARGO_TARGET_DIR/debug/contract-validate"

fails=0
# expect_reject <label> <which: core|collab|community> <jq filter>
expect_reject() {
  local label="$1" which="$2" filter="$3" dir="$work/$1"
  mkdir -p "$dir"
  cp "$contracts/forge-core.json" "$contracts/forge-collab.json" "$contracts/forge-community.json" "$dir/"
  jq "$filter" "$contracts/forge-$which.json" > "$dir/forge-$which.json"
  if "$bin" "$dir/forge-core.json" "$dir/forge-collab.json" "$dir/forge-community.json" > "$dir/out" 2>&1; then
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
# the author operand must bind the writer: findBy has to read "." (the writer) exactly once
expect_reject author-findby-without-writer collab '.documentSchemas.authorEvent.ownerRefersTo.anyOf[0].findBy |= del(."$ownerId")'
expect_reject author-lookup-optional-key collab '.documentSchemas.authorEvent.required -= ["targetNumber"]'
expect_reject author-lookup-optional-repo collab '.documentSchemas.authorEvent.required -= ["repoId"]'
# `where` keyed by the found document's $id needs an identifier on the referring side
expect_reject author-where-non-id collab '.documentSchemas.authorEvent.ownerRefersTo.anyOf[1].where = {"$id": "targetNumber"}'
# `where` pairs the found issue's `title` (a string) with our `kind` (an integer)
expect_reject where-kind-mismatch collab '.documentSchemas.event.properties.targetId.refersTo.anyOf[0].where.title = "kind"'
expect_reject key-id-not-integer core '.documentSchemas.repoKey.properties.recipientKeyId = {"type":"string","maxLength":10,"position":3}'
expect_reject key-ref-on-identity-with-own-key community '.documentSchemas.webhook.properties.senderKeyId.refersTo.identityProperty = "relayIdentityId"'
expect_reject membership-non-deletable core '.documentSchemas.maintainer.canBeDeleted = false'
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
# The fresh registration (beta.7; docs/contracts/forge-v2.md §3.1, §6.2): the rules that read totals need their
# answering index, a summed property is a required integer, and a skip property is optional
expect_reject dense-without-countable-patch-index collab '.documentSchemas.patch.indices |= map(if .name == "perRepo" then del(.countable) else . end)'
# Each rule is load-bearing: without it, the sample document that breaks only that rule is
# accepted (the validator's bad samples satisfy every other rule of their type)
expect_reject without-conclusionIfDone community 'del(.documentSchemas.checkRun.propertyConstraints.conclusionIfDone)'
expect_reject without-doneIfConclusion community 'del(.documentSchemas.checkRun.propertyConstraints.doneIfConclusion)'
expect_reject without-startedIfRunning community 'del(.documentSchemas.checkRun.propertyConstraints.startedIfRunning)'
expect_reject without-runningIfStarted community 'del(.documentSchemas.checkRun.propertyConstraints.runningIfStarted)'
expect_reject without-completedAtIfDone community 'del(.documentSchemas.checkRun.propertyConstraints.completedAtIfDone)'
expect_reject without-doneIfCompletedAt community 'del(.documentSchemas.checkRun.propertyConstraints.doneIfCompletedAt)'
expect_reject without-b1-closeDelta collab 'del(.documentSchemas.transition.propertyConstraints.b1_closeDelta)'
expect_reject without-b2-reopenDelta collab 'del(.documentSchemas.transition.propertyConstraints.b2_reopenDelta)'
expect_reject without-b3-otherDelta collab 'del(.documentSchemas.transition.propertyConstraints.b3_otherDelta)'
expect_reject without-e-mergeOid collab 'del(.documentSchemas.transition.propertyConstraints.e_mergeOid)'
expect_reject without-f-authorNoMerge collab 'del(.documentSchemas.transition.propertyConstraints.f_authorNoMerge)'
expect_reject without-a-kindOfTarget collab 'del(.documentSchemas.transition.propertyConstraints.a_kindOfTarget)'
expect_reject dense-without-countable-index collab '.documentSchemas.issue.indices |= map(if .name == "perRepo" then del(.countable) else . end)'
expect_reject sum-without-summable-index collab '.documentSchemas.transition.indices |= map(if .name == "perTarget" then del(.summable) else . end)'
expect_reject summed-property-optional collab '.documentSchemas.transition.required -= ["delta"]'
expect_reject skip-property-required collab '.documentSchemas.issue.required += ["upstreamNumber"]'
expect_reject transition-member-findby-non-unique collab '.documentSchemas.transition.ownerRefersTo.anyOf[0].findBy = {"memberId": "."}'
expect_reject allow-setting-a-mutable-property community '.documentSchemas.checkRun.immutableAllowSetting += ["summary"]'
# indexed strings are at most 63 characters
expect_reject topic-name-too-long-for-an-index core '.documentSchemas.topic.properties.name.maxLength = 64'

# A later forge-core change ships as an in-place update of the registered schema
# (registered/forge-core.v1.json, registered fresh at the beta.7 wipe): a change the
# update rules refuse (here an index flag or a rule of a registered type) must fail
# --expect-update against it.
expect_update_refused() {
  local label="$1" filter="$2" dir="$work/$1"
  mkdir -p "$dir"
  jq "$filter" "$contracts/forge-core.json" > "$dir/forge-core.json"
  # Refused by the update rules themselves, not by a sample or a parse error
  if "$bin" "$dir/forge-core.json" --expect-update "$contracts/registered/forge-core.v1.json" > "$dir/out" 2>&1 \
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
