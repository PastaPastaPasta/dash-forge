#!/usr/bin/env bash
# Scenario 14: sign in with a limited key, work with it, and retire it.
#
#   1. `dg auth login <COLLAB file>` registers a limited key (AUTHENTICATION/HIGH, bound to the
#      dash-forge contract group, 0.01 DASH budget, 1 day) and stores only that key. The OS
#      keychain is switched off (DASH_FORGE_NO_KEYCHAIN), so it goes to a passphrase-sealed
#      file (0600) under a scratch XDG_CONFIG_HOME.
#   2. `dg auth status` / `auth keys list` read it back: limited, budget, this computer's key.
#   3. The limited key signs a real write: `dg repo star` on the suite repo, then unstar.
#   4. `dg auth export --reveal-secrets --format dfk1` writes the key for CI (0600), and that
#      value works as DASH_FORGE_KEY for a read.
#   5. `dg auth keys disable <id> --master <file>` disables it on chain; the next write with it
#      is refused (E305) and nothing is charged.
#
# Every run registers (and disables) one key on COLLAB: a small identity update (~0.0002 DASH).
SCENARIO_NAME="14 dg auth login (limited key) / sealed-file store / export dfk1 / disable"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
harness_ensure_repo "$E2E_REPO_NAME" || { bad "suite repo unavailable"; finish_scenario; }

LOG="${WORKROOT}/s14"
XDG="${WORKROOT}/s14-xdg"
mkdir -p "$XDG"
export XDG_CONFIG_HOME="$XDG/config" XDG_STATE_HOME="$XDG/state"
# HOME stays the real one, so without this marker dg's one-time copy of the pre-XDG
# ~/.config/dash-forge would pull the real config and keys into this scratch directory.
mkdir -p -m 700 "$XDG_CONFIG_HOME/dash-forge"
: >"$XDG_CONFIG_HOME/dash-forge/.migrated-from-home-config"
export DASH_FORGE_NO_KEYCHAIN=1
export DASH_FORGE_PASSPHRASE="e2e-${RUN_ID}-passphrase"
REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }
# dg with the stored default only: no --identity, no DASH_FORGE_KEY.
dg_default() { ( unset DASH_FORGE_KEY; RUST_LOG="${RUST_LOG:-error}" NO_COLOR=1 _tmo "${DG}" "$@" ); }
_default_read() { # _default_read <out> <err> <dg args...>
  local out="$1" err="$2" rc; shift 2
  dg_default "$@" >"$out" 2>"$err"; rc=$?
  [[ $rc -ne 0 ]] && cat "$out" >>"$err" 2>/dev/null
  return $rc
}
default_read_retry() { _retry "$2" _default_read "$@"; } # default_read_retry <out> <err> <args...>

step "1. dg auth login (limited key → sealed file)"
if dg_default --yes --json auth login "$ID_COLLAB" --budget 0.01 --expires 1d \
     >"$LOG-login.json" 2>"$LOG-login.err"; then
  ok "logged in"
else
  cat "$LOG-login.json" "$LOG-login.err" >&2
  is_flake "$LOG-login.err" && skip_scenario "login hit a transport flake"
  bad "dg auth login"; finish_scenario
fi
KEY_ID="$(jq_py "$LOG-login.json" 'd["keyId"]')"
KEYFILE="$(jq_py "$LOG-login.json" 'd["source"]')"
check "stored in a sealed file" assert_eq "sealed-file" "$(jq_py "$LOG-login.json" 'd["storage"]')"
check "budget 0.01 DASH" assert_eq "1000000000" "$(jq_py "$LOG-login.json" 'd["budgetCredits"]')"
check "key file is 0600" assert_eq "600" "$(stat -f '%Lp' "$KEYFILE" 2>/dev/null || stat -c '%a' "$KEYFILE")"
check "key file holds no WIF in the clear" assert_not_file_contains "$KEYFILE" "privateKeyWif"
check "config default is the key file" assert_file_contains "$XDG/config/dash-forge/config.toml" "$KEYFILE"

step "2. dg auth status / keys list"
if default_read_retry "$LOG-status.json" "$LOG-status.err" --json auth status; then
  check "status: limited" assert_eq "True" "$(jq_py "$LOG-status.json" 'd["limited"]')"
  check "status: key id" assert_eq "$KEY_ID" "$(jq_py "$LOG-status.json" 'd["keyId"]')"
  check "status: master key not stored" assert_eq "False" "$(jq_py "$LOG-status.json" 'd["masterKeyStored"]')"
else
  cat "$LOG-status.err" >&2; bad "dg auth status"
fi
if default_read_retry "$LOG-keys.json" "$LOG-keys.err" --json auth keys list; then
  check "keys list marks this computer's key" assert_eq "True" \
    "$(jq_py "$LOG-keys.json" "[k for k in d['keys'] if k['id']==${KEY_ID}][0]['thisComputer']")"
  check "the key is bound to the dash-forge group" assert_eq "True" \
    "$(jq_py "$LOG-keys.json" "[k for k in d['keys'] if k['id']==${KEY_ID}][0]['forgeGroup']")"
else
  cat "$LOG-keys.err" >&2; bad "dg auth keys list"
fi

step "3. the limited key signs a write (star / unstar)"
if dg_default --yes --json repo star "$REPO" >"$LOG-star.json" 2>"$LOG-star.err"; then
  check "starred" assert_contains "$(jq_py "$LOG-star.json" 'd["status"]')" "starred"
  dg_default --yes --json repo unstar "$REPO" >"$LOG-unstar.json" 2>"$LOG-unstar.err" \
    || { cat "$LOG-unstar.err" >&2; bad "unstar"; }
else
  cat "$LOG-star.json" "$LOG-star.err" >&2
  is_flake "$LOG-star.err" && skip_scenario "star hit a transport flake"
  bad "a write signed by the limited key"
fi

step "4. export the key for CI (dfk1) and use it"
DFK="$XDG/ci.dfk1"
if dg_default --json auth export --reveal-secrets --format dfk1 -o "$DFK" \
     >"$LOG-export.json" 2>"$LOG-export.err"; then
  check "export file is 0600" assert_eq "600" "$(stat -f '%Lp' "$DFK" 2>/dev/null || stat -c '%a' "$DFK")"
  check "export is a dfk1 value" assert_file_contains "$DFK" "dfk1:${DASH_FORGE_NETWORK}"
  if DASH_FORGE_KEY="$(cat "$DFK")" RUST_LOG=error NO_COLOR=1 _tmo "${DG}" --json auth balance \
       >"$LOG-dfk1.json" 2>"$LOG-dfk1.err"; then
    check "DASH_FORGE_KEY=dfk1:… works" assert_eq "$IDID_COLLAB" "$(jq_py "$LOG-dfk1.json" 'd["identityId"]')"
  else
    cat "$LOG-dfk1.err" >&2; bad "reading with DASH_FORGE_KEY=dfk1:…"
  fi
else
  cat "$LOG-export.json" "$LOG-export.err" >&2; bad "dg auth export --format dfk1"
fi

step "5. disable the key; the next write is refused"
if dg_default --yes --json auth keys disable "$KEY_ID" --master "$ID_COLLAB" \
     >"$LOG-disable.json" 2>"$LOG-disable.err"; then
  check "disabled" assert_eq "disabled" "$(jq_py "$LOG-disable.json" 'd["status"]')"
  dg_default --yes --json repo star "$REPO" >"$LOG-star2.json" 2>"$LOG-star2.err"
  RC=$?
  check "a write with the disabled key fails" test "$RC" -ne 0
  check "…as E305 (key expired or disabled)" assert_eq "E305" "$(jq_py "$LOG-star2.json" 'd["error"]["code"]' 2>/dev/null)"
else
  cat "$LOG-disable.json" "$LOG-disable.err" >&2
  is_flake "$LOG-disable.err" && skip_scenario "disable hit a transport flake"
  bad "dg auth keys disable"
fi

finish_scenario
