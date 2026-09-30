#!/usr/bin/env bash
# Scenario 20: CLI config, storage and clone UX (QA defects D-405, D-402, D-403).
#
#   1. D-405: a config.toml with a syntax error is refused, never silently replaced by the
#      defaults. `dg auth status` exits 2 with E204 naming the file, line and column;
#      `dg doctor` reports it as a failing `config.toml` row with the fix; a `git push` that
#      needs the recorded default identity fails with the same E204, not E301.
#   2. D-402: `dg storage remove` deletes the storage-secret keychain entry
#      (`keychain:dash-forge/<profile>`) once no remaining profile names it, keeps it while
#      one does, and reports a missing entry without failing. With no OS keychain (CI) only
#      the "not found" path runs.
#   3. D-403: a reader clones a repo whose one pack is on RustFS; the pack is then deleted
#      from RustFS, and the same clone fails with E503 and the reseed / ipfs_gateways fix,
#      within seconds, instead of git's "remote did not send all necessary objects".
#
# Step 3 creates a NEW repo every run (`e2e-ux-<run-id>`, ~0.002 DASH plus one tiny push)
# whose pack lives on the runner's local RustFS and is deleted, so nothing else may read it
# (e2e/README.md). It writes as E2E_UX_IDENTITY (default: the OWNER fixture). Steps 1-2
# write nothing. Step 3 is not run when RustFS is down (make infra-up).
SCENARIO_NAME="20 config.toml errors (E204), storage remove keychain cleanup, dead-copy clone (E503)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

: "${E2E_UX_IDENTITY:=$ID_OWNER}"
UX_OWNER="$(_idid "$E2E_UX_IDENTITY")"
[[ -n "$UX_OWNER" ]] || { bad "cannot read the identity id from ${E2E_UX_IDENTITY}"; finish_scenario; }
LOG="${WORKROOT}/s20"
NAME="$(printf 'e2e-ux-%s' "$RUN_ID" | tr 'A-Z' 'a-z')"
REMOTE="dash://${UX_OWNER}/${NAME}"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }

# An isolated config home: HOME too, or dg copies the real ~/.config/dash-forge into it.
ISO="${WORKROOT}/s20-home"
rm -rf "$ISO"; mkdir -p "$ISO/xdg/dash-forge" "$ISO/home"
: >"$ISO/gitconfig"
iso() { # iso <cmd...> — run in the isolated home, with no signing key (a function works too)
  ( export HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/xdg" GIT_CONFIG_GLOBAL="$ISO/gitconfig" \
      NO_COLOR=1 RUST_LOG=error
    # config.toml is the only network source here, so a fallback to testnet shows.
    unset DASH_FORGE_KEY DASH_FORGE_NETWORK DASH_FORGE_DEVNET_NAME; "$@" )
}
CONFIG="$ISO/xdg/dash-forge/config.toml"

step "1. D-405: a config.toml syntax error is E204, everywhere"
printf 'network = "devnet"\ndevnet_name = "%s"\ndefault_identity = \n' "$DASH_FORGE_DEVNET_NAME" >"$CONFIG"
iso _tmo "$DG" auth status >"$LOG-status.out" 2>"$LOG-status.err"
check "dg auth status exits 2" assert_eq "2" "$?"
check "E204" assert_file_contains "$LOG-status.err" "[E204]"
check "names the file, line and column" assert_file_contains "$LOG-status.err" "config.toml: line 3, column 20:"
check "fix names the line" assert_file_contains "$LOG-status.err" "fix line 3 of"
check "prints no network (no fallback to testnet)" assert_not_file_contains "$LOG-status.out" "Network:"

iso _tmo "$DG" --json doctor >"$LOG-doctor.json" 2>"$LOG-doctor.err"
check "dg doctor exits 1 (checks failed), not a crash" assert_eq "1" "$?"
DOCTOR_ROW='[c for s in d["sections"] for c in s["checks"] if c["name"] == "config.toml"]'
check "doctor has a failing config.toml row" \
  assert_eq "False" "$(jq_py "$LOG-doctor.json" "${DOCTOR_ROW}[0][\"ok\"]" 2>/dev/null)"
check "the row's fix names the line" \
  assert_contains "$(jq_py "$LOG-doctor.json" "${DOCTOR_ROW}[0][\"fix\"]" 2>/dev/null)" "fix line 3 of"

# The helper reads the same file for the default signing identity when a push needs one.
# The suite's repo exists; no key exists in this home, so nothing can be signed or written.
PUSH_SRC="${WORKROOT}/s20-push"
seed_tiny_repo "$PUSH_SRC" main >/dev/null
( cd "$PUSH_SRC" && iso _tmo git -c "dash.network=${DASH_FORGE_NETWORK}" \
    -c "dash.devnetName=${DASH_FORGE_DEVNET_NAME:-}" \
    push "$E2E_REMOTE" "main:refs/heads/e2e/${RUN_ID}/s20-never" ) \
  >"$LOG-push405.out" 2>"$LOG-push405.err"
check "git push fails" test $? -ne 0
if is_flake "$LOG-push405.err"; then
  info "the helper's connection flaked before reading config.toml; not judging its error"
else
  check "helper: E204, not E301" assert_file_contains "$LOG-push405.err" "[E204]"
  check "helper: names the line" assert_file_contains "$LOG-push405.err" "config.toml: line 3, column 20:"
fi
rm -f "$CONFIG"

step "2. D-402: dg storage remove cleans up the keychain entry it created"
KC_CFG="${WORKROOT}/s20-kc-storage.toml"
rm -f "$KC_CFG"
P1="s20-kc-$(printf '%s' "$RUN_ID" | tr -c 'A-Za-z0-9' '-')"
P2="${P1}-copy"
REF="keychain:dash-forge/${P1}"
kc_add() { # kc_add <profile> — an S3 profile whose secret is the keychain entry of P1
  DASH_FORGE_STORAGE_CONFIG="$KC_CFG" RUST_LOG=error "$DG" storage add "$1" --kind s3 \
    --endpoint https://s3.example.invalid --bucket b --access-key-id AK --secret-access-key "$REF" \
    >/dev/null 2>&1
}
kc_remove() { # kc_remove <profile> <out.json>
  DASH_FORGE_STORAGE_CONFIG="$KC_CFG" RUST_LOG=error "$DG" --json storage remove "$1" >"$2" 2>"$2.err"
}
KEYCHAIN=0
if [[ "$(uname)" == Darwin ]] && security default-keychain >/dev/null 2>&1 \
   && security add-generic-password -U -s dash-forge -a "$P1" -w "e2e-throwaway-${RUN_ID}" >/dev/null 2>&1; then
  KEYCHAIN=1
  # Never leave the throwaway entry in a developer's login keychain, however this ends.
  trap 'security delete-generic-password -s dash-forge -a "$P1" >/dev/null 2>&1' EXIT
fi
# P1 names its own entry (what a pasted secret becomes); P2 points at the same entry.
if kc_add "$P1" && kc_add "$P2"; then
  kc_remove "$P2" "$LOG-rm1.json"
  check "removing ${P2} exits 0" assert_eq "0" "$?"
  check "it leaves ${P1}'s entry alone (not its own)" \
    assert_eq "$REF" "$(jq_py "$LOG-rm1.json" 'd["keychain"]["notOwned"][0]')"
  kc_add "$P2"
  kc_remove "$P1" "$LOG-rm2.json"
  check "removing ${P1} exits 0" assert_eq "0" "$?"
  check "its entry is kept while ${P2} still names it" \
    assert_eq "$P2" "$(jq_py "$LOG-rm2.json" 'd["keychain"]["keptSharedWith"][0]["profile"]')"
  kc_remove "$P2" "$LOG-rm2b.json"
  kc_add "$P1"
  kc_remove "$P1" "$LOG-rm3.json"
  check "removing ${P1} alone exits 0" assert_eq "0" "$?"
  if [[ $KEYCHAIN -eq 1 ]]; then
    check "and deletes its entry" assert_eq "$REF" "$(jq_py "$LOG-rm3.json" 'd["keychain"]["deleted"][0]')"
    check "the entry is gone from the keychain" bash -c "! security find-generic-password -s dash-forge -a '$P1' >/dev/null 2>&1"
    # Already gone: reported, not an error.
    kc_add "$P1" && kc_remove "$P1" "$LOG-rm4.json"
    check "a missing entry exits 0" assert_eq "0" "$?"
    check "and is reported as not found" \
      assert_eq "$REF" "$(jq_py "$LOG-rm4.json" 'd["keychain"]["notFound"][0]')"
  else
    info "no OS keychain here: checking only that the entry is reported, not deleted or failed"
    check "reported as not found or failed, never as deleted" \
      assert_eq "0" "$(jq_py "$LOG-rm3.json" 'len(d["keychain"]["deleted"])')"
  fi
else
  bad "dg storage add (keychain reference) failed"
fi


step "3. D-403: a clone whose only copy is gone fails fast with E503"
S3="http://127.0.0.1:9000"
if ! curl -fsS -m 3 -o /dev/null "${S3}/health/ready" 2>/dev/null; then
  # Steps 1-2 were judged above; with any of their checks failed this still FAILs.
  [[ "$SCENARIO_FAILS" -eq 0 ]] || finish_scenario
  skip_scenario "steps 1-2 passed; step 3 needs the local S3 store (RustFS): make infra-up"
fi
PUSH_CFG="${WORKROOT}/s20-pusher.toml"
READ_CFG="${WORKROOT}/s20-reader.toml"
PREFIX="e2e/${RUN_ID}/s20"
export FORGE_E2E_S3_SECRET="minioadmin"
cat >"$PUSH_CFG" <<EOF
[profiles.s20-rustfs]
kind = "s3"
endpoint = "${S3}"
bucket = "forge-byo"
path_style = true
public_url = "${S3}/forge-byo"
prefix = "${PREFIX}"
access_key_id = "minioadmin"
secret_access_key = "env:FORGE_E2E_S3_SECRET"
# A loopback S3 URL: a local fixture, never readable by anyone else.
allow_private_uri = true
EOF
# The reader has no S3 profile. The recorded loopback URL is followed only from an origin
# the reader configured, so the RustFS origin is listed as a read gateway, and 127.0.0.1:9
# (discard: nothing listens, connections are refused at once) as a second one.
cat >"$READ_CFG" <<EOF
[read]
ipfs_gateways = ["${S3}", "http://127.0.0.1:9"]
EOF
SRC="${WORKROOT}/s20-src/${NAME}"
seed_tiny_repo "$SRC" main >/dev/null
TIP="$(git -C "$SRC" rev-parse HEAD)"
_init() {
  ( cd "$SRC" && DASH_FORGE_STORAGE_CONFIG="$PUSH_CFG" GIT_CONFIG_GLOBAL="$ISO/gitconfig" \
      dg_as "$E2E_UX_IDENTITY" --yes init --storage s20-rustfs --allow-private-uri ) \
    >"$LOG-init.out" 2>"$LOG-init.err"
}
if ! _retry "$LOG-init.err" _init; then
  cat "$LOG-init.out" "$LOG-init.err" >&2
  is_flake "$LOG-init.err" && skip_scenario "dg init hit a transport flake"
  bad "dg init failed"; finish_scenario
fi
ok "created ${REMOTE} and pushed ${TIP:0:12} to RustFS"

CLONE="${WORKROOT}/s20-clone"
reader_clone() { # reader_clone <log> — anonymous clone with the reader's storage.toml
  rm -rf "$CLONE"
  ( export DASH_FORGE_STORAGE_CONFIG="$READ_CFG" NO_COLOR=1 RUST_LOG=warn; unset DASH_FORGE_KEY
    _tmo git clone "$REMOTE" "$CLONE" ) >"$1.out" 2>"$1.err"
}
# Control first: while the copy exists, the same reader clones it.
if _retry "$LOG-clone-ok.err" reader_clone "$LOG-clone-ok"; then
  check "the reader clones while the copy exists" assert_eq "$TIP" "$(git -C "$CLONE" rev-parse HEAD)"
else
  cat "$LOG-clone-ok.err" >&2
  is_flake "$LOG-clone-ok.err" && skip_scenario "control clone hit a transport flake"
  bad "the control clone failed"; finish_scenario
fi

# Destroy every copy: each object this run stored under its prefix, by signed S3 DELETE.
s3() { curl -fsS --aws-sigv4 "aws:amz:us-east-1:s3" --user "minioadmin:${FORGE_E2E_S3_SECRET}" "$@"; }
KEYS="$(s3 "${S3}/forge-byo?list-type=2&prefix=${PREFIX}/" | grep -oE '<Key>[^<]+</Key>' \
  | sed -E 's#</?Key>##g')"
[[ -n "$KEYS" ]] || { bad "no objects under ${PREFIX}/ to delete"; finish_scenario; }
while read -r key; do
  info "deleting ${key}"
  s3 -X DELETE "${S3}/forge-byo/${key}" || bad "could not delete ${key}"
done <<<"$KEYS"
check "the copies are gone from RustFS" \
  bash -c "[[ -z \"\$(curl -fsS --aws-sigv4 'aws:amz:us-east-1:s3' --user 'minioadmin:${FORGE_E2E_S3_SECRET}' '${S3}/forge-byo?list-type=2&prefix=${PREFIX}/' | grep -o '<Key>')\" ]]"

started=$SECONDS
reader_clone "$LOG-clone-dead"
rc=$?; took=$((SECONDS - started))
if [[ $rc -ne 0 ]] && ! grep -q "E503" "$LOG-clone-dead.err" && is_flake "$LOG-clone-dead.err"; then
  skip_scenario "the dead-copy clone hit a transport flake before reading packs"
fi
check "clone fails" test "$rc" -ne 0
check "with E503" assert_file_contains "$LOG-clone-dead.err" "[E503]"
check "headline: clone incomplete" assert_file_contains "$LOG-clone-dead.err" "clone incomplete: 1 pack unreadable"
check "cause names the dead copies" assert_file_contains "$LOG-clone-dead.err" "no external copy verified"
check "fix: reseed" assert_file_contains "$LOG-clone-dead.err" "dg reseed ${UX_OWNER}/${NAME} --from-local"
check "fix: ipfs_gateways" assert_file_contains "$LOG-clone-dead.err" "[read] ipfs_gateways"
check "not git's bare 'did not send all necessary objects'" \
  assert_not_file_contains "$LOG-clone-dead.err" "did not send all necessary objects"
check "fails fast (${took}s < 60s)" test "$took" -lt 60

finish_scenario
