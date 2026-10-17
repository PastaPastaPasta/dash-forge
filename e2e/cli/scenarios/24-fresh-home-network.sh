#!/usr/bin/env bash
# Scenario 24: a new user on a clean machine follows the docs and the web page verbatim
# (L-03, L-21, L-24, L-33). Everything runs in an empty HOME / XDG_CONFIG_HOME / global git
# config, with the OS keychain off and NO DASH_FORGE_NETWORK in the environment: the only
# network source is what `dg auth login` records.
#
#   0. L-33: a fresh `dg doctor` exits 0: it either verifies the embedded default deployment
#      or warns that no deployed network was chosen (without failing with E104).
#   1. `dg auth login --network <network> [--devnet-name <devnet>] <file>` records the network (a
#      limited key goes to a passphrase-sealed file).
#   2. L-24: `dg doctor` outside a repository reports git using the same network.
#   3. `dg init --storage platform` publishes a new repository and pushes main.
#   4. L-03: with the repository's own dash.network removed, a plain `git push` of a second
#      commit resolves the network `dg auth login` recorded (it used to go to testnet: E702).
#   5. L-21: `dg repo clone <owner>/<name> <dir>` clones (it used to only print a command),
#      records the network in the clone, and `cd <dir> && git log` shows both commits.
#   6. Anonymous: a second empty home with no dg config clones with the web page's
#      `git clone -c dash.network=… dash://…` line. A bare clone uses a deployed default
#      when it matches the tested network; an undeployed default fails with E702/git guidance.
#
# Writes one new repository per run (`e2e-fresh-<run-id>`, about 0.0013 DASH plus two small
# Platform-stored pushes) under an identity minted for the run (E2E_FRESH_IDENTITY skips the
# mint). Needs the network's funding key (E2E_MINT_FUNDING, config.sh) and tools/mint-identity's
# node modules to mint.
SCENARIO_NAME="24 fresh home: dg auth login → dg init → plain git push → dg repo clone (network from config.toml)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

: "${MINT_DIR:=${E2E_REPO_ROOT}/tools/mint-identity}"
NETWORK="$DASH_FORGE_NETWORK"
DEVNET="$DASH_FORGE_DEVNET_NAME"
NET_LABEL="${NETWORK}${DEVNET:+-${DEVNET}}"
NET_ARGS=("${E2E_MINT_NET_ARGS[@]}")
LOG="${WORKROOT}/s24"
IDS="${WORKROOT}/s24-ids"
mkdir -p "$IDS" && chmod 700 "$IDS"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1" 2>/dev/null; }

step "this run's identity"
if [[ -n "${E2E_FRESH_IDENTITY:-}" ]]; then
  require_not_july "$E2E_FRESH_IDENTITY"
  cp "$E2E_FRESH_IDENTITY" "$IDS/FRESH.identity.json"
else
  require_mint_funding "or set E2E_FRESH_IDENTITY"
  [[ -d "$MINT_DIR/node_modules/@dashevo/evo-sdk" ]] || skip_scenario "tools/mint-identity has no node_modules (npm ci there)"
  lock=() lf="$E2E_MINT_LOCK"
  if command -v lockf >/dev/null; then lock=(lockf -t 1200 "$lf")
  elif command -v flock >/dev/null; then lock=(flock -w 1200 "$lf"); fi
  "${lock[@]}" node "$MINT_DIR/mint.mjs" "${E2E_MINT_NET_ARGS[@]}" --funding fund-from-key \
    --funding-key-file "$E2E_MINT_FUNDING" --out "$IDS" --label FRESH --amount 0.1 >"$LOG-mint.log" 2>&1 \
    || { tail -5 "$LOG-mint.log" >&2; skip_scenario "minting failed (funding or network)"; }
fi
FRESH="$IDS/FRESH.identity.json"
OWNER="$(_idid "$FRESH")"
[[ -n "$OWNER" ]] || { bad "cannot read the identity id from $FRESH"; finish_scenario; }
ok "identity ${OWNER:0:10}…"

# A clean machine: its own HOME, XDG dirs and global git config; no keychain; no network,
# key or DAPI settings in the environment. `fresh <home> <cmd…>` runs a command there.
new_home() { # new_home <dir>
  rm -rf "$1"; mkdir -p "$1/home" "$1/xdg" "$1/state"
  printf '[user]\n\tname = Dash Forge E2E\n\temail = e2e@dash-forge.test\n[init]\n\tdefaultBranch = main\n' >"$1/gitconfig"
}
fresh() { # fresh <home dir> <cmd…>
  local h="$1"; shift
  ( export HOME="$h/home" XDG_CONFIG_HOME="$h/xdg" XDG_STATE_HOME="$h/state" \
      GIT_CONFIG_GLOBAL="$h/gitconfig" GIT_CONFIG_NOSYSTEM=1 NO_COLOR=1 RUST_LOG=error
    # Nothing of the caller's Forge setup leaks in (network, key, storage config, …).
    # shellcheck disable=SC2046
    unset $(compgen -v DASH_FORGE_)
    export DASH_FORGE_NO_KEYCHAIN=1 DASH_FORGE_PASSPHRASE="e2e-${RUN_ID}-s24"
    "$@" )
}
# `run <out> <err> <home> [dir] -- <cmd…>`: one attempt in <home> (and <dir>), its output
# to <out>/<err> (so _retry sees each attempt's error on its own).
run() {
  local out="$1" err="$2" home="$3" dir="." rc; shift 3
  if [[ "$1" != -- ]]; then dir="$1"; shift; fi
  shift
  ( cd "$dir" && fresh "$home" "$@" ) >"$out" 2>"$err"; rc=$?
  [[ $rc -ne 0 ]] && cat "$out" >>"$err" 2>/dev/null
  return $rc
}
H="${WORKROOT}/s24-home"
new_home "$H"
NAME="$(printf 'e2e-fresh-%s' "$RUN_ID" | tr 'A-Z' 'a-z')"
NAME="${NAME:0:63}"
REMOTE="dash://${OWNER}/${NAME}"

step "0. L-33: a fresh dg doctor exits 0"
run "$LOG-doctor0.json" "$LOG-doctor0.err" "$H" "$H/home" -- _tmo "$DG" --json doctor
check "exits 0" assert_eq "0" "$?"
DEFAULT_NET="$(jq_py "$LOG-doctor0.json" 'd["network"]')"
DEFAULT_DEPLOYED="$(jq_py "$LOG-doctor0.json" 'bool(d.get("forgeV2"))')"
ROW='[c for s in d["sections"] for c in s["checks"] if s["name"] == "network"][0]'
if [[ "$DEFAULT_DEPLOYED" == False ]]; then
  check "network row: no network chosen yet" \
    assert_contains "$(jq_py "$LOG-doctor0.json" "${ROW}[\"detail\"]")" "no network chosen yet"
  check "its fix records a deployed network" \
    assert_contains "$(jq_py "$LOG-doctor0.json" "${ROW}[\"fix\"]")" "dg auth new"
else
  check "the embedded default deployment is healthy" assert_eq "True" "$(jq_py "$LOG-doctor0.json" 'd["ok"]')"
  info "default ${DEFAULT_NET} is deployed: the undeployed-default warning does not apply"
fi

step "1. dg auth login records the network"
# A write (it registers a key): run once, never retried.
if run "$LOG-login.json" "$LOG-login.err" "$H" -- _tmo "$DG" --yes --json \
     "${NET_ARGS[@]}" auth login "$FRESH" --budget 0.05 --expires 1d; then
  ok "signed in"
else
  cat "$LOG-login.json" "$LOG-login.err" >&2
  is_flake "$LOG-login.err" && skip_scenario "login hit a transport flake"
  bad "dg auth login"; finish_scenario
fi
check "config.toml records the network" assert_file_contains "$H/xdg/dash-forge/config.toml" "network = \"${NETWORK}\""
if [[ "$NETWORK" == devnet ]]; then
  check "and the devnet name" assert_file_contains "$H/xdg/dash-forge/config.toml" "devnet_name = \"${DEVNET}\""
fi

step "2. L-24: dg doctor outside a repository agrees with git"
run "$LOG-doctor1.json" "$LOG-doctor1.err" "$H" "$H/home" -- _tmo "$DG" --json doctor
NETROW='[c for s in d["sections"] for c in s["checks"] if c["name"] == "dash.network"][0]'
check "dash.network: git uses ${NET_LABEL}, same as dg" \
  assert_contains "$(jq_py "$LOG-doctor1.json" "${NETROW}[\"detail\"]")" "git uses ${NET_LABEL}, same as dg"

step "3. dg init publishes and pushes"
SRC="${WORKROOT}/s24-src"
rm -rf "$SRC"; mkdir -p "$SRC"
fresh "$H" git init -q "$SRC"
printf '# %s\n' "$NAME" >"$SRC/README.md"
fresh "$H" git -C "$SRC" add README.md
fresh "$H" git -C "$SRC" commit -q -m "first commit ${RUN_ID}"
C1="$(git -C "$SRC" rev-parse HEAD)"
if run "$LOG-init.json" "$LOG-init.err" "$H" "$SRC" -- _tmo "$DG" --yes --json init --name "$NAME" --storage platform; then
  ok "published ${REMOTE}"
else
  cat "$LOG-init.json" "$LOG-init.err" >&2
  is_flake "$LOG-init.err" && skip_scenario "dg init hit a transport flake"
  bad "dg init"; finish_scenario
fi

step "4. L-03: a plain git push takes the network dg auth recorded"
fresh "$H" git -C "$SRC" config --unset dash.network
fresh "$H" git -C "$SRC" config --unset dash.devnetName || true
check "the repository names no network now" test -z "$(fresh "$H" git -C "$SRC" config --get dash.network)"
printf 'second %s\n' "$RUN_ID" >>"$SRC/README.md"
fresh "$H" git -C "$SRC" add -- README.md
fresh "$H" git -C "$SRC" commit -q -m "second commit ${RUN_ID}"
C2="$(git -C "$SRC" rev-parse HEAD)"
if _retry "$LOG-push.err" run "$LOG-push.out" "$LOG-push.err" "$H" "$SRC" -- _tmo git -c dash.confirm=never push origin main; then
  ok "pushed ${C2:0:12}"
else
  cat "$LOG-push.err" >&2
  check "not E702 (testnet)" assert_not_file_contains "$LOG-push.err" "[E702]"
  bad "plain git push"; finish_scenario
fi

step "5. L-21: dg repo clone clones, and the clone keeps the network"
WORK="${WORKROOT}/s24-work"
rm -rf "$WORK"; mkdir -p "$WORK"
clone_once() { rm -rf "${WORK:?}/${NAME:?}"; run "$LOG-clone.json" "$LOG-clone.err" "$H" "$WORK" -- _tmo "$DG" --json repo clone "${OWNER}/${NAME}"; }
if _retry "$LOG-clone.err" clone_once; then
  ok "cloned"
else
  cat "$LOG-clone.json" "$LOG-clone.err" >&2; bad "dg repo clone"; finish_scenario
fi
check "into ./${NAME}" test -d "$WORK/${NAME}/.git"
check "git log shows both commits" assert_eq "${C2} ${C1}" \
  "$(cd "$WORK/${NAME}" && fresh "$H" git log --format=%H | tr '\n' ' ' | sed 's/ $//')"
check "the clone records dash.network=${NETWORK}" assert_eq "$NETWORK" "$(fresh "$H" git -C "$WORK/${NAME}" config --get dash.network)"
check "and dash.devnetName=${DEVNET}" assert_eq "$DEVNET" "$(fresh "$H" git -C "$WORK/${NAME}" config --get dash.devnetName || true)"

step "6. anonymous: the web page's git clone line works with no dg config at all"
A="${WORKROOT}/s24-anon"
new_home "$A"
ANON="${WORKROOT}/s24-anon-work"
rm -rf "$ANON"; mkdir -p "$ANON"
anon_once() { rm -rf "${ANON:?}/${NAME:?}"; run "$LOG-anon.out" "$LOG-anon.err" "$A" "$ANON" -- _tmo git clone -c "dash.network=${NETWORK}" -c "dash.devnetName=${DEVNET}" "$REMOTE"; }
if _retry "$LOG-anon.err" anon_once; then
  check "anonymous clone has the tip" assert_eq "$C2" "$(git -C "$ANON/${NAME}" rev-parse HEAD)"
  check "and keeps the network" assert_eq "$NETWORK" "$(git -C "$ANON/${NAME}" config --get dash.network)"
else
  cat "$LOG-anon.err" >&2; bad "anonymous git clone -c …"
fi
if [[ "$DEFAULT_DEPLOYED" != False && "$DEFAULT_NET" != "$NET_LABEL" ]]; then
  info "default ${DEFAULT_NET} differs from ${NET_LABEL}: explicit clone above selects the tested network"
else
  run "$LOG-bare.out" "$LOG-bare.err" "$A" "$ANON" -- _tmo git clone "$REMOTE" bare-clone
  bare_rc=$?
  if [[ "$DEFAULT_DEPLOYED" == False ]]; then
    check "a bare clone with no deployed default fails" test "$bare_rc" -ne 0
    check "with E702" assert_file_contains "$LOG-bare.err" "[E702]"
    check "whose fix is git config, not dg flags" assert_file_contains "$LOG-bare.err" "git config --global dash.network"
    check "and never --devnet-name" assert_not_file_contains "$LOG-bare.err" "--devnet-name"
  else
    check "bare clone uses the deployed default network" assert_eq "0" "$bare_rc"
    check "and has the tip" assert_eq "$C2" "$(git -C "$ANON/bare-clone" rev-parse HEAD)"
  fi
fi

finish_scenario
