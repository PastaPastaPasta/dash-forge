#!/usr/bin/env bash
# Negative checks: each mutation below breaks one protocol-14 rule the forge-v2 design relies on,
# and the validator must refuse every one of them. A validator that accepts a broken contract
# proves nothing about the real ones.
#
#   tools/contract-validate/negative.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
contracts="$here/../../forge-contracts/contracts"
vectors="$here/../../forge-contracts/vectors/rc1"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/dash-forge-target-contract-validate}"
# Pinned like the rs-dpp tag it builds against (platform v5.0.0-beta.1's rust-toolchain.toml)
cargo +1.98.1 build -q --locked --manifest-path "$here/Cargo.toml"
bin="$CARGO_TARGET_DIR/debug/contract-validate"

fails=0
# expect_reject <label> <which: core|collab|community> <jq filter> [<reason regex>]
# With a reason, the validator's output must also match it: a mutation refused for another
# reason proves nothing about the one it names.
expect_reject() {
  local label="$1" which="$2" filter="$3" want="${4:-}" dir="$work/$1"
  mkdir -p "$dir"
  cp "$contracts/forge-core.json" "$contracts/forge-collab.json" "$contracts/forge-community.json" "$dir/"
  jq "$filter" "$contracts/forge-$which.json" > "$dir/forge-$which.json"
  if "$bin" --vectors "$vectors" "$dir/forge-core.json" "$dir/forge-collab.json" "$dir/forge-community.json" > "$dir/out" 2>&1; then
    echo "NOT REJECTED: $label"
    fails=$((fails + 1))
  elif [ -n "$want" ] && ! grep -qE "$want" "$dir/out"; then
    echo "REJECTED FOR ANOTHER REASON: $label (want /$want/): $(grep -m1 FAIL "$dir/out" | sed 's/^ *FAIL: //' | cut -c1-160)"
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
expect_reject permanent-on-deletable core '.documentSchemas.topic.properties.repoId.refersTo.documentType = "maintainer"'
expect_reject cross-permanent-on-deletable-wrap collab '.documentSchemas.repoKey.ownerRefersTo.type = "permanentDocument"'
expect_reject five-operands core '.documentSchemas.label.ownerRefersTo.anyOf += [{"type":"identity"},{"type":"permanentDocument","documentType":"repo","findBy":{"$ownerId":".","name":"name"}},{"allOf":[{"type":"identity"},{"type":"deletableDocument","documentType":"writer","findBy":{"repoId":"repoId","memberId":"."}}]}]'
expect_reject immutable-system-prop core '.documentSchemas.repo.immutable += ["$createdAt"]'
expect_reject encrypted-too-short collab '.documentSchemas.repoKey.properties.wrapped.maxItems = 16'
expect_reject cross-findby-non-unique-index community '.documentSchemas.event.ownerRefersTo.anyOf[0].findBy = {"memberId": "."}'
expect_reject cross-permanent-on-deletable community '.documentSchemas.webhook.ownerRefersTo.type = "permanentDocument"'
expect_reject cross-missing-type community '.documentSchemas.star.properties.repoId.refersTo.documentType = "nope"'
expect_reject cross-deletable-on-permanent collab '.documentSchemas.issue.properties.repoId.refersTo.type = "deletableDocument"'
expect_reject issue-deletable-under-author-lookup collab '.documentSchemas.issue.canBeDeleted = true | del(.documentSchemas.issue.documentsKeepHistory)'
# the author operand must bind the writer: findBy has to read "." (the writer) exactly once
expect_reject author-findby-without-writer community '.documentSchemas.authorEvent.ownerRefersTo.anyOf[0].findBy |= del(."$ownerId")'
expect_reject author-lookup-optional-key community '.documentSchemas.authorEvent.required -= ["targetNumber"]'
expect_reject author-lookup-optional-repo community '.documentSchemas.authorEvent.required -= ["repoId"]'
# `where` keyed by the found document's $id needs an identifier on the referring side
expect_reject author-where-non-id community '.documentSchemas.authorEvent.ownerRefersTo.anyOf[1].where = {"$id": "targetNumber"}'
# `where` pairs the found issue's `title` (a string) with our `kind` (an integer)
expect_reject where-kind-mismatch community '.documentSchemas.event.properties.targetId.refersTo.anyOf[0].where.title = "kind"'
expect_reject key-id-not-integer collab '.documentSchemas.repoKey.properties.recipientKeyId = {"type":"string","maxLength":10,"position":3}'
expect_reject key-ref-on-identity-with-own-key community '.documentSchemas.webhook.properties.senderKeyId.refersTo.identityProperty = "relayIdentityId"'
expect_reject membership-non-deletable core '.documentSchemas.maintainer.canBeDeleted = false'
# review parity (docs/design/review-parity-spec.md §3)
expect_reject review-link-permanent-on-deletable collab '.documentSchemas.comment.properties.reviewId.refersTo.type = "permanentDocument"'
expect_reject review-link-where-missing-prop collab '.documentSchemas.comment.properties.reviewId.refersTo.where.patchId = "nope"'
expect_reject policy-gate-permanent-on-deletable community '.documentSchemas.policy.ownerRefersTo.type = "permanentDocument"'
expect_reject immutable-unknown-prop collab '.documentSchemas.patch.immutable += ["nope"]'
expect_reject immutable-on-immutable-type community '.documentSchemas.policy.immutable = ["repoId"]'
# C-1 (platform-parity-spec §4, §6), and RC2 C1 (the fused star) when the build has it
if jq -e '.documentSchemas.starBeat' "$contracts/forge-community.json" > /dev/null; then
  # a timeRange index needs $createdAt required
  expect_reject timerange-without-createdat community '.documentSchemas.starBeat.required = ["repoId"]'
  # every indexOnly type keeps a $createdAt-free proof index
  expect_reject beat-without-proof-index community '.documentSchemas.starBeat.indices |= map(select(.name != "byOwner"))'
  # the window's ttl is capped at one week (protocol 14)
  expect_reject beat-ttl-over-a-week community '.documentSchemas.starBeat.indices[1].timeRange.ttl = 691200'
else
  week='(.documentSchemas.star.indices[] | select(.name == "byWeek"))'
  # the star's window needs $createdAt required (C1 adds it), its ttl is capped at one week, and
  # outlivesDelete needs a ttl so the entries an unstar leaves expire (book contract-keywords/index-only.md:227)
  expect_reject star-window-without-createdat community '.documentSchemas.star.required = ["repoId"]' 'does not require'
  expect_reject star-window-ttl-over-a-week community "$week.timeRange.ttl = 691200" 'exceeds the maximum'
  expect_reject star-outlives-delete-without-ttl community "del($week.timeRange.ttl)" 'outlivesDelete. without a .timeRange. carrying a .ttl.'
  expect_reject star-outlives-delete-with-a-sum community "$week.summable = \"repoId\""
  # the index vectors are load-bearing: a star window that is cleared by an unstar disagrees
  expect_reject star-window-cleared-by-unstar community "del($week.outlivesDelete)" 'index vectors disagree'
fi
if jq -e '.documentSchemas.review.indices | any(.name == "toAuthor")' "$contracts/forge-collab.json" > /dev/null; then
  # RC2 S2: a derived index property needs a fixed same-contract reference to a fixed field, and
  # no uniqueness (book contract-keywords/derived-index-properties.md:80-92)
  to_author='(.documentSchemas.review.indices[] | select(.name == "toAuthor"))'
  expect_reject derived-index-unique collab "$to_author.unique = true" 'a derived value is read from the referenced document'
  expect_reject derived-index-mutable-field collab "$to_author.properties[0] = {\"patchId.title\": \"asc\"}" 'can change once written'
  expect_reject derived-index-movable-reference collab '.documentSchemas.review.documentsMutable = true' 'a replace could point "patchId" at another document'
  expect_reject s2-index-dropped collab '.documentSchemas.review.indices |= map(select(.name != "toAuthor"))' 'index vectors disagree'
fi
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
# Each rule is load-bearing: without it, a vector that breaks only that rule is accepted. One
# mutation per (type, rule) that some refused vector names as its reason; a type left with no
# rule loses the empty propertyConstraints too, so the schema itself stays valid.
rules=()
while IFS= read -r line; do rules+=("$line"); done < <(for c in core collab community; do
  jq -r --arg c "$c" --slurpfile k "$contracts/forge-$c.json" \
    '.[] | select(.expect == "refused") | select(.why as $w | ($k[0].documentSchemas[.type].propertyConstraints // {}) | has($w)) | "\($c) \(.type) \(.why)"' \
    "$vectors/forge-$c.json"
done | sort -u)
[ "${#rules[@]}" -gt 0 ] || { echo "no rule is named by a refused vector: the vectors did not load"; exit 1; }
for line in "${rules[@]}"; do
  read -r which type rule <<<"$line"
  expect_reject "without-$type-$rule" "$which" \
    "del(.documentSchemas.$type.propertyConstraints.$rule) | if .documentSchemas.$type.propertyConstraints == {} then del(.documentSchemas.$type.propertyConstraints) else . end" \
    "expected refused by $rule, got accepted"
done
expect_reject dense-without-countable-index collab '.documentSchemas.issue.indices |= map(if .name == "perRepo" then del(.countable) else . end)'
expect_reject sum-without-summable-index collab '.documentSchemas.transition.indices |= map(if .name == "perTarget" then del(.summable) else . end)'
expect_reject summed-property-optional collab '.documentSchemas.transition.required -= ["delta"]'
expect_reject skip-property-required collab '.documentSchemas.issue.required += ["upstreamNumber"]'
expect_reject transition-member-findby-non-unique collab '.documentSchemas.transition.ownerRefersTo.anyOf[0].findBy = {"memberId": "."}'
# RC2 M1 (design/v5/PLAN.md §3.1): v5 refuses `immutableAllowSetting` on every parse, and checks
# each conditional `immutable` entry (book contract-keywords/mutability.md:117-131)
expect_reject immutable-allow-setting-refused community '.documentSchemas.checkRun.immutableAllowSetting = ["summary"]' 'immutableAllowSetting. is replaced'
expect_reject immutable-condition-unknown-prop community '.documentSchemas.checkRun.immutable += [{"property":"nope","when":{"present":"$old.nope"}}]' 'not a property of the document type'
expect_reject immutable-listed-twice community '.documentSchemas.checkRun.immutable += [{"property":"repoId","when":{"present":"$old.repoId"}}]' 'under .immutable. twice'
expect_reject old-read-outside-immutable community '.documentSchemas.checkRun.propertyConstraints.oldRead = {"present":"$old.summary"}' '\$old\.summary'
# The replace vectors are load-bearing: a set-once field frozen outright, or left free, and (S1) a
# completed run's log left free, each make a replace vector disagree
expect_reject m1-set-once-frozen-outright community '.documentSchemas.checkRun.immutable |= map(if type == "object" and .property == "startedAt" then "startedAt" else . end)' 'replace.json vectors disagree'
expect_reject m1-set-once-left-free community '.documentSchemas.checkRun.immutable |= map(select(type == "string" or .property != "externalId"))' 'replace.json vectors disagree'
if jq -e '.documentSchemas.checkRun.immutable | any(type == "object" and .property == "logUrl")' "$contracts/forge-community.json" > /dev/null; then
  expect_reject s1-log-left-free community '.documentSchemas.checkRun.immutable |= map(select(type == "string" or .property != "logUrl"))' 'replace.json vectors disagree'
fi
# RC1 (WIPE-DECISIONS D-10, D-11): the vis stamps and the new references are registration-checked
expect_reject vis-where-missing-on-member community '.documentSchemas.webhook.ownerRefersTo.where = {"visibility": "vis"}'
expect_reject vis-where-kind-mismatch collab '.documentSchemas.issue.properties.repoId.refersTo.where = {"visibility": "number"}'
expect_reject reply-where-missing-prop collab '.documentSchemas.comment.properties.replyTo.refersTo.where.replyTo = "nope"'
if jq -e '.documentSchemas.starBeat' "$contracts/forge-community.json" > /dev/null; then
  expect_reject beat-where-owner-non-id community '.documentSchemas.starBeat.properties.repoId.refersTo.where = {"$ownerId": "vis"}' '40126'
fi
expect_reject consent-findby-non-unique core '.documentSchemas.consent.indices[0].unique = false'
expect_reject asmember-findby-non-unique collab '.schemaDefs.member.refersTo.anyOf[0].findBy = {"memberId": "."}'
expect_reject check-source-cross-permanent community '.documentSchemas.policy.properties.requiredCheckSources.items.refersTo.anyOf[1].type = "permanentDocument"'
expect_reject events-collab-type-missing community '.documentSchemas.event.properties.targetId.refersTo.anyOf[0].documentType = "nope"'
expect_reject chunk-sum-without-index core '.documentSchemas.chunk.indices |= map(select(.name != "perPack"))'
expect_reject release-sum-without-index core '.documentSchemas.release.indices |= map(select(.name != "perTag"))'
expect_reject topic-count-without-index core '.documentSchemas.topic.indices |= map(select(.name != "perRepo"))'
expect_reject one-def-twice-in-a-type core '.documentSchemas.chunk.properties.packHash."$ref" = "#/$defs/id"'
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
  if "$bin" --vectors "$vectors" "$dir/forge-core.json" --expect-update "$contracts/registered/forge-core.v1.json" > "$dir/out" 2>&1 \
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
