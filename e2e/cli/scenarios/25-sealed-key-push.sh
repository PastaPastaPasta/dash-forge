#!/usr/bin/env bash
# Scenario 25: a passphrase-sealed key, from a fresh HOME, through `dg init`, a plain
# `git push` and a clone (L-02). The key is sealed because DASH_FORGE_NO_KEYCHAIN=1, as over
# SSH or in a container.
#
#   1. `dg auth login <minted identity>` stores a limited key in a passphrase-sealed file.
#   2. Pre-flight: with a git-remote-dash on PATH that cannot take the key (an older release),
#      `dg init` stops with E303 before anything is paid for. The balance does not move, no
#      repository exists, and no remote was added.
#   3. `dg init` on a terminal asks for the passphrase exactly once, creates the repository
#      and pushes: dg hands the unlocked key to git-remote-dash over an inherited pipe.
#   4. A plain `git push` on a terminal: git-remote-dash asks for the passphrase on /dev/tty
#      (once) and pushes.
#   5. A plain `git push` with no terminal fails with E303 naming the ways out (a terminal, the
#      keychain, `dg init`, DASH_FORGE_PASSPHRASE), and writes nothing.
#   6. A fresh clone is at the pushed tip.
#
# The passphrase is only ever typed at a prompt (expect drives a pty) in steps 3-4; neither
# the transcript nor any output holds it or the key.
#
# Runs as an identity minted for this run (`E2E_S25_IDENTITY` names a pre-minted file instead),
# so no shared fixture pays for it. A new repo per run: `e2e-sealed-push-<run-id>` (~0.0015 DASH
# to create, plus two tiny Platform-stored pushes).
SCENARIO_NAME="25 sealed key: dg init asks once, git push on a tty, no tty fails clearly, pre-flight before spend"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

command -v expect >/dev/null || skip_scenario "expect is not installed"
: "${MOUTAI_FUNDING:=/Users/pasta/workspace/dash-forge-qa/secrets/moutai-funding.wif}"
: "${MINT_DIR:=${E2E_REPO_ROOT}/tools/mint-identity}"

LOG="${WORKROOT}/s25"
BASE="${WORKROOT}/s25-home"
rm -rf "$BASE"; mkdir -p -m 700 "$BASE"
IDS="${BASE}/ids"; mkdir -p -m 700 "$IDS"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }

step "this run's identity"
if [[ -n "${E2E_S25_IDENTITY:-}" ]]; then
  cp "$E2E_S25_IDENTITY" "$IDS/S25.identity.json"
else
  [[ -r "$MOUTAI_FUNDING" ]] || skip_scenario "no moutai funding key ($MOUTAI_FUNDING); or set E2E_S25_IDENTITY"
  [[ -d "$MINT_DIR/node_modules/@dashevo/evo-sdk" ]] || skip_scenario "tools/mint-identity has no node_modules (npm ci there)"
  lock=(); lf="${E2E_MINT_LOCK:-/tmp/qa-mint.lock}"
  if command -v lockf >/dev/null; then lock=(lockf -t 1200 "$lf"); elif command -v flock >/dev/null; then lock=(flock -w 1200 "$lf"); fi
  "${lock[@]}" node "$MINT_DIR/mint.mjs" --network devnet --devnet-name moutai --funding fund-from-key \
    --funding-key-file "$MOUTAI_FUNDING" --out "$IDS" --label S25 --amount 0.3 >"$LOG-mint.log" 2>&1 \
    || { tail -5 "$LOG-mint.log" >&2; skip_scenario "minting failed (funding or network)"; }
fi
MINTED="$IDS/S25.identity.json"
OWNER_ID="$(_idid "$MINTED")"
[[ -n "$OWNER_ID" ]] || { bad "no identity file"; finish_scenario; }
ok "identity ${OWNER_ID:0:10}…"

# A fresh HOME: no keychain, config and git config of its own. dg and git-remote-dash find the
# sealed key only through the config.toml default dg auth login records.
export HOME="$BASE" XDG_CONFIG_HOME="$BASE/xdg" XDG_STATE_HOME="$BASE/state"
export GIT_CONFIG_GLOBAL="$BASE/gitconfig" DASH_FORGE_NO_KEYCHAIN=1
mkdir -p -m 700 "$XDG_CONFIG_HOME/dash-forge"
: >"$XDG_CONFIG_HOME/dash-forge/.migrated-from-home-config"
printf '[user]\n\tname = e2e s25\n\temail = s25@dash-forge.test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n' >"$GIT_CONFIG_GLOBAL"
unset DASH_FORGE_KEY DASH_FORGE_PASSPHRASE
PASS="e2e-${RUN_ID}-sealed-passphrase"
NAME="e2e-sealed-push-${RUN_ID}"
NAME="$(printf '%s' "${NAME:0:63}" | tr 'A-Z' 'a-z')"
SRC="${BASE}/src/${NAME}"
REMOTE="dash://${OWNER_ID}/${NAME}"

balance() { # balance <tag>: the identity's balance in credits (read with the minted file)
  dg_read_retry "$MINTED" "$LOG-bal-$1.json" "$LOG-bal-$1.err" --json auth balance \
    && jq_py "$LOG-bal-$1.json" 'd["balanceCredits"]'
}

# run_tty <transcript> <cmd...>: run on a pseudo-terminal, typing the passphrase at every
# "Passphrase for …:" prompt and "y" at "Proceed?". Exits with the command's status. The
# passphrase reaches expect through its environment, never its argv; it is typed with echo
# off, so the transcript never holds it.
TTY_EXP="${BASE}/tty.exp"
cat >"$TTY_EXP" <<'EXP'
set timeout 400
log_user 0
log_file -a -noappend [lindex $argv 0]
spawn -noecho {*}[lrange $argv 1 end]
expect {
  -re {Passphrase for [^\r\n]*: } { sleep 0.5; send -- "$env(S25_PASS)\r"; exp_continue }
  -re {Proceed\? \[Y/n\] } { send -- "y\r"; exp_continue }
  timeout { exit 124 }
  eof
}
lassign [wait] pid spawnid os_error value
exit $value
EXP
run_tty() {
  local t="$1"; shift
  S25_PASS="$PASS" expect "$TTY_EXP" "$t" "$@"
}
# no_tty <cmd...>: run with no controlling terminal (a new session), stdin from /dev/null.
no_tty() {
  python3 -c 'import os, sys
if os.fork():
    sys.exit(os.waitstatus_to_exitcode(os.wait()[1]))
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])' "$@" </dev/null
}
prompts() { local n; n="$(grep -c 'Passphrase for' "$1" 2>/dev/null)"; echo "${n:-0}"; }
LIMITED_WIF=""
no_secret_in() { # no_secret_in <file>: neither the passphrase nor the stored key's WIF
  [[ -n "$LIMITED_WIF" ]] && ! grep -qF -- "$PASS" "$1" && ! grep -qF -- "$LIMITED_WIF" "$1"
}

step "1. dg auth login (limited key → passphrase-sealed file)"
if DASH_FORGE_PASSPHRASE="$PASS" RUST_LOG=error NO_COLOR=1 _tmo "$DG" --yes --json auth login "$MINTED" \
     --budget 0.05 --expires 1d >"$LOG-login.json" 2>"$LOG-login.err"; then
  check "stored in a sealed file" assert_eq "sealed-file" "$(jq_py "$LOG-login.json" 'd["storage"]')"
else
  cat "$LOG-login.json" "$LOG-login.err" >&2
  is_flake "$LOG-login.err" && skip_scenario "login hit a transport flake"
  bad "dg auth login"; finish_scenario
fi
# The stored key's WIF, only to prove below that no output ever holds it.
DASH_FORGE_PASSPHRASE="$PASS" "$DG" --json auth export --reveal-secrets --format dfk1 \
  -o "$BASE/limited.dfk1" >/dev/null 2>&1 && LIMITED_WIF="$(cut -d: -f5- "$BASE/limited.dfk1")"
check "the stored key could be read back for the leak checks" test -n "$LIMITED_WIF"
seed_tiny_repo "$SRC" main >/dev/null

step "2. pre-flight: an older git-remote-dash on PATH → refused before any spend"
STUB="${BASE}/old-helper"; mkdir -p "$STUB"
printf '#!/bin/sh\necho "dash: error: unknown admin command \\"$1\\"" >&2\nexit 1\n' >"$STUB/git-remote-dash"
chmod +x "$STUB/git-remote-dash"
B0="$(balance pre0)"
( cd "$SRC" && PATH="$STUB:$PATH" DASH_FORGE_PASSPHRASE="$PASS" RUST_LOG=error NO_COLOR=1 \
    _tmo "$DG" --yes --json init --storage platform ) >"$LOG-preflight.json" 2>"$LOG-preflight.err"
RC=$?
B1="$(balance pre1)"
check "refused (non-zero exit)" test "$RC" -ne 0
check "…as E303" assert_eq "E303" "$(jq_py "$LOG-preflight.json" 'd["error"]["code"]' 2>/dev/null)"
check "…before anything was paid for" assert_contains "$(jq_py "$LOG-preflight.json" 'd["error"]["note"]' 2>/dev/null)" "before anything was paid for"
check "balance unchanged (${B0} → ${B1})" assert_eq "$B0" "$B1"
check "no remote was added" assert_eq "" "$(git -C "$SRC" remote)"
if dg_read_retry "$MINTED" "$LOG-view0.json" "$LOG-view0.err" --json repo view "${OWNER_ID}/${NAME}"; then
  bad "the repository exists after a refused pre-flight"
else
  ok "no repository was created"
fi

step "3. dg init on a terminal: one passphrase prompt, created and pushed"
TIP1="$(git -C "$SRC" rev-parse HEAD)"
( cd "$SRC" && RUST_LOG=error NO_COLOR=1 run_tty "$LOG-init.tty" "$DG" init --storage platform )
RC=$?
check "dg init exit 0" assert_eq "0" "$RC"
check "the passphrase was asked once" assert_eq "1" "$(prompts "$LOG-init.tty")"
check "created" assert_file_contains "$LOG-init.tty" "created"
check "pushed main" assert_file_contains "$LOG-init.tty" "main → ${TIP1:0:7}"
check "no passphrase or key in the transcript" no_secret_in "$LOG-init.tty"
[[ $RC -eq 0 ]] || { cat "$LOG-init.tty" >&2; finish_scenario; }

step "4. plain git push on a terminal: git-remote-dash asks once"
printf 'tty push %s\n' "$RUN_ID" >"$SRC/tty.txt"
git -C "$SRC" add tty.txt && git -C "$SRC" commit -q -m "tty push ${RUN_ID}"
TIP2="$(git -C "$SRC" rev-parse HEAD)"
( cd "$SRC" && RUST_LOG=error NO_COLOR=1 run_tty "$LOG-push.tty" git push )
RC=$?
check "git push exit 0" assert_eq "0" "$RC"
check "the helper asked for the passphrase once" assert_eq "1" "$(prompts "$LOG-push.tty")"
check "no passphrase or key in the transcript" no_secret_in "$LOG-push.tty"
[[ $RC -eq 0 ]] || cat "$LOG-push.tty" >&2

step "5. plain git push with no terminal: E303 naming the ways out, nothing written"
printf 'no tty %s\n' "$RUN_ID" >"$SRC/notty.txt"
git -C "$SRC" add notty.txt && git -C "$SRC" commit -q -m "no tty ${RUN_ID}"
( cd "$SRC" && RUST_LOG=error NO_COLOR=1 no_tty git push ) >"$LOG-notty.out" 2>"$LOG-notty.err"
RC=$?
check "refused (non-zero exit)" test "$RC" -ne 0
check "…as E303" assert_file_contains "$LOG-notty.err" "[E303]"
check "…says there is no terminal" assert_file_contains "$LOG-notty.err" "no terminal to ask for it on"
for way in "in a terminal" "keychain" "dg init" "DASH_FORGE_PASSPHRASE"; do
  check "…names: ${way}" assert_file_contains "$LOG-notty.err" "$way"
done
check "no prompt was shown" assert_eq "0" "$(prompts "$LOG-notty.err")"
if git_dash_retry "$MINTED" "$LOG-ls" ls-remote "$REMOTE" refs/heads/main; then
  check "main is still at the terminal push's tip" assert_file_contains "$LOG-ls.out" "$TIP2"
else
  bad "ls-remote after the refused push"
fi

step "6. a fresh clone is at the pushed tip"
CLONE="${BASE}/clone"
if git_dash_retry "$MINTED" "$LOG-clone" clone -q "$REMOTE" "$CLONE"; then
  check "clone HEAD = the pushed tip" assert_eq "$TIP2" "$(git -C "$CLONE" rev-parse HEAD)"
  check "the tty push's file is there" test -f "$CLONE/tty.txt"
else
  cat "$LOG-clone.err" >&2; bad "clone"
fi

finish_scenario
