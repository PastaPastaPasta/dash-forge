#!/usr/bin/env bash
# Scenario 13: `dg init` publishes a local repository in one command, and `dg repo create`
# refuses to spend when no storage is configured.
#
#   1. `dg storage add` (flags, env-var secret) makes a MinIO profile in a scratch storage.toml.
#   2. A fresh local repo → `dg init --storage <that profile>` on a NEW repo `e2e-init-<run-id>`:
#      the repo is created, remote origin = dash://<owner>/<name>, repo-local dash.storage is
#      set, the branch is pushed with upstream tracking, and the web URL is printed. A second
#      `dg init` changes nothing (status "exists"); a clone is byte-identical.
#   3. With no storage anywhere (empty storage.toml, empty global git config), `dg repo create`
#      exits 5 with E508 before creating anything: the balance does not move.
#
# The repo is new every run (a v2 repo cannot be deleted; ~0.0015 DASH to create, plus a
# manifest + ref update for the push). Its pack lives on the runner's local MinIO, so only
# this scenario reads it (e2e/README.md). SKIPs when MinIO is down (make infra-up).
SCENARIO_NAME="13 dg init (create + remote + push) / E508 stop-before-spend"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

MINIO="http://127.0.0.1:9000"
curl -fsS -m 3 -o /dev/null "${MINIO}/minio/health/live" || skip_scenario "MinIO not up (make infra-up)"

LOG="${WORKROOT}/s13"
NAME="e2e-init-${RUN_ID}"
NAME="$(printf '%s' "$NAME" | tr 'A-Z' 'a-z')"
PROFILE="s13-minio"
CFG="${WORKROOT}/s13-storage.toml"
GLOBAL="${WORKROOT}/s13-gitconfig"
SRC="${WORKROOT}/s13-src/${NAME}"
CLONE="${WORKROOT}/s13-clone"
: >"$GLOBAL"
rm -f "$CFG"
export FORGE_E2E_MINIO_SECRET="minioadmin"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }
balance() { # balance <out> — the OWNER's balance in credits
  dg_read_retry "$ID_OWNER" "$1.json" "$1.err" --json auth balance && jq_py "$1.json" 'd["balanceCredits"]'
}

step "1. dg storage add (flags, env: secret)"
if DASH_FORGE_STORAGE_CONFIG="$CFG" "$DG" storage add "$PROFILE" --kind s3 --endpoint "$MINIO" \
     --bucket forge-byo --public-url "${MINIO}/forge-byo" --prefix "e2e/${RUN_ID}/s13" \
     --access-key-id minioadmin --secret-access-key env:FORGE_E2E_MINIO_SECRET --allow-private-uri \
     >"$LOG-add.out" 2>&1; then
  ok "profile ${PROFILE} added"
else
  cat "$LOG-add.out" >&2; bad "dg storage add"; finish_scenario
fi

step "2. dg init --storage ${PROFILE} (new repo ${NAME})"
seed_tiny_repo "$SRC" main >/dev/null
TIP="$(git -C "$SRC" rev-parse HEAD)"
_init() { # _init <log> [--json] — dg init in $SRC as OWNER, isolated storage + global config
  local out="$1" rc; shift
  ( cd "$SRC" && DASH_FORGE_STORAGE_CONFIG="$CFG" GIT_CONFIG_GLOBAL="$GLOBAL" \
      dg_as "$ID_OWNER" --yes "$@" init --storage "$PROFILE" ) >"$out.out" 2>"$out.err"
  rc=$?
  # With --json the error is on stdout: copy it where is_flake / _retry look.
  [[ $rc -ne 0 ]] && cat "$out.out" >>"$out.err"
  return $rc
}
if _retry "$LOG-init.err" _init "$LOG-init"; then
  ok "dg init succeeded"
else
  cat "$LOG-init.out" "$LOG-init.err" >&2
  is_flake "$LOG-init.err" && skip_scenario "dg init hit a transport flake"
  bad "dg init failed"; finish_scenario
fi
REMOTE="dash://${E2E_OWNER_ID}/${NAME}"
# A retry after a flaky push finds the repo made by the first attempt ("✓ exists").
check "prints the created line with the web URL" \
  grep -qE "✓ (created|exists) +https://forge\.dashhq\.org/repo\?owner=${E2E_OWNER_ID}&name=${NAME}" "$LOG-init.out"
check "prints the remote line" assert_file_contains "$LOG-init.out" "✓ remote 'origin' → ${REMOTE}"
check "helper progress reached the terminal" assert_file_contains "$LOG-init.err" "(1 verified)"
check "remote origin = ${REMOTE}" assert_eq "$REMOTE" "$(git -C "$SRC" remote get-url origin)"
check "repo-local dash.storage = ${PROFILE}" assert_eq "$PROFILE" "$(git -C "$SRC" config --local dash.storage)"
check "main tracks origin/main" assert_eq "origin/main" "$(git -C "$SRC" rev-parse --abbrev-ref 'main@{u}')"

step "a second dg init changes nothing"
if _retry "$LOG-init2.err" _init "$LOG-init2" --json; then
  check "status exists" assert_eq "exists" "$(jq_py "$LOG-init2.out" 'd["status"]')"
  check "create cost 0" assert_eq "0" "$(jq_py "$LOG-init2.out" 'd["cost"]["credits"]')"
  check "--json names the pushed commit" assert_eq "$TIP" "$(jq_py "$LOG-init2.out" 'd["push"]["oid"]')"
  check "--json carries the web URL" assert_contains "$(jq_py "$LOG-init2.out" 'd["webUrl"]')" "name=${NAME}"
else
  cat "$LOG-init2.out" "$LOG-init2.err" >&2; bad "second dg init failed"
fi

step "clone it back"
if DASH_FORGE_STORAGE_CONFIG="$CFG" git_dash_retry "$ID_OWNER" "$LOG-clone" clone "$REMOTE" "$CLONE"; then
  check "tip matches" assert_eq "$TIP" "$(git -C "$CLONE" rev-parse HEAD)"
  check "worktrees byte-identical" diff -r --exclude=.git "$SRC" "$CLONE"
else
  cat "$LOG-clone.err" >&2
  is_flake "$LOG-clone.err" && skip_scenario "clone hit a transport flake"
  bad "clone failed"
fi

step "3. no storage configured → E508 before any spend"
# A repository with no dash.storage of its own (SRC has one now), an empty storage.toml and
# an empty global git config: nothing to default to.
EMPTY="${WORKROOT}/s13-empty.toml"
BARE_SRC="${WORKROOT}/s13-nostorage"
: >"$EMPTY"
: >"${WORKROOT}/s13-gitconfig-empty"
seed_tiny_repo "$BARE_SRC" main >/dev/null
B0="$(balance "$LOG-bal0")" || skip_scenario "balance read flaked"
( cd "$BARE_SRC" && DASH_FORGE_STORAGE_CONFIG="$EMPTY" GIT_CONFIG_GLOBAL="${WORKROOT}/s13-gitconfig-empty" \
    dg_as "$ID_OWNER" --yes --json repo create "${NAME}-nostorage" ) \
  >"$LOG-e508.json" 2>"$LOG-e508.err"
RC=$?
check "exit code 5" assert_eq "5" "$RC"
check "code E508" assert_eq "E508" "$(jq_py "$LOG-e508.json" 'd["error"]["code"]' 2>/dev/null)"
check "cause prices Platform storage" assert_file_contains "$LOG-e508.json" "Packs would go to Platform at ~0.28 DASH/MiB"
B1="$(balance "$LOG-bal1")" || skip_scenario "balance read flaked"
check "balance unchanged" assert_eq "$B0" "$B1"

finish_scenario
