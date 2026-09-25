#!/usr/bin/env bash
# Scenario 8: forge-v1 read compatibility on TESTNET. v1 repositories (one contract each)
# are read only now, but must stay cloneable:
#   * `git clone dash://<owner>/<name>` of the testnet M1 repo resolves through the v1
#     registry (testnet has no forge-v2 deployment) and clones cleanly (fsck);
#   * `git clone dash://<contractId>` resolves the same repo by its contract id;
#   * a push to it is refused locally as read only, before anything is signed.
# Read-only: no Platform writes. Needs a testnet identity (any; only reads are signed-free).
SCENARIO_NAME="08 v1 read-compat (testnet clone)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

LOG="${WORKROOT}/s08"
[[ -f "$V1_TESTNET_IDENTITY" ]] || skip_scenario "no testnet identity at ${V1_TESTNET_IDENTITY}"
V1_REMOTE="dash://${V1_TESTNET_OWNER}/${V1_TESTNET_REPO}"
# Every command below targets testnet, whatever the suite's network is.
testnet() { DASH_FORGE_NETWORK=testnet DASH_FORGE_DEVNET_NAME= DASH_FORGE_DAPI_ADDRESSES= "$@"; }

step "clone the v1 repo by name on testnet"
C1="${WORKROOT}/s08-named"
if ! testnet git_dash_retry "$V1_TESTNET_IDENTITY" "$LOG-named" clone "$V1_REMOTE" "$C1"; then
  cat "$LOG-named.err" >&2 || true
  is_flake "$LOG-named.err" && skip_scenario "testnet clone flaked on every attempt"
  bad "v1 clone by name failed"; finish_scenario
fi
ok "cloned ${V1_REMOTE}"
if git -C "$C1" fsck --full >"$LOG-fsck.out" 2>&1; then ok "fsck clean"; else cat "$LOG-fsck.out" >&2; bad "fsck failed"; fi
NREFS="$(git -C "$C1" for-each-ref refs/remotes | wc -l | tr -d ' ')"
check "the clone has branches (${NREFS})" bash -c "[[ ${NREFS:-0} -ge 1 ]]"

step "resolve the same repo by its contract id"
if testnet git_dash_retry "$V1_TESTNET_IDENTITY" "$LOG-id" ls-remote "dash://${V1_TESTNET_CONTRACT}"; then
  HEAD_BY_ID="$(awk '$2=="HEAD"{print $1}' "$LOG-id.out")"
  HEAD_BY_NAME="$(git -C "$C1" rev-parse HEAD)"
  check "dash://<contractId> advertises the same HEAD" assert_eq "$HEAD_BY_NAME" "$HEAD_BY_ID" "HEAD"
else
  cat "$LOG-id.err" >&2 || true
  is_flake "$LOG-id.err" && skip_scenario "contract-id ls-remote flaked"
  bad "dash://<contractId> did not resolve"
fi

step "a push to the v1 repo is refused as read only (nothing signed)"
git -C "$C1" -c user.email=e2e@x -c user.name=e2e -c commit.gpgsign=false commit -q --allow-empty -m "v1 push probe ${RUN_ID}"
if testnet git_dash "$V1_TESTNET_IDENTITY" "$LOG-push" -C "$C1" push "$V1_REMOTE" "HEAD:refs/heads/e2e/${RUN_ID}/v1probe"; then
  bad "a push to a v1 repo was ACCEPTED"
elif grep -qiE 'v1 repository, which is read only|\[E605\]' "$LOG-push.err" "$LOG-push.out" 2>/dev/null; then
  ok "push refused: v1 repo is read only"
else
  cat "$LOG-push.err" >&2
  bad "push failed without the read-only message"
fi

finish_scenario
