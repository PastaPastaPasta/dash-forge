# shellcheck shell=bash
# config.sh — network selection, fixture identities and the shared test repos.
#
# Sourced by lib.sh. Everything here is data: no side effects beyond exports. The one exception
# is a refusal (below), which exits the harness before anything is signed.
#
# Networks (DASH_FORGE_NETWORK):
#   devnet (default)  devnet SAKURA, where the release's four-contract set (contracts/mainnet) is
#                     registered (2026-10-17, on 5.0.0-beta.6; it replaced the three-contract set of
#                     2026-10-13; the forge-v2 contracts once on devnets moutai and bonsia are gone).
#                     DASH_FORGE_DEVNET_NAME picks another devnet.
#   testnet           Dash testnet, a PRODUCTION network (release plan WS-D; QA-05, QA-14). Everything
#                     the suite writes there is permanent. See "testnet" below.
#
# A v2 repo costs ~0.001 DASH, so the suite's repo is created on the first run (by
# `harness_ensure_repo`, resumably) rather than hard-coded.
#
# testnet rules (all enforced here, before any scenario runs):
#   - The suite writes repos, branches and packs that can never be deleted (QA-14: rule suites run
#     on scratch registrations, the live set only through mv-live --live-target). It refuses
#     DASH_FORGE_NETWORK=testnet unless E2E_LIVE_TARGET=1 says the operator means to write to the
#     live registration.
#   - The owner role is OWNER on every network. DEPLOYER is the July-era testnet identity whose keys
#     are public (SECU-03) and the name of the real deployer; E2E_OWNER_ROLE=DEPLOYER is refused.
#   - Identities come from a per-network directory: E2E_IDENTITY_DIR, default
#     ~/.config/dash-forge/test-identities/testnet-scratch/ (fresh, faucet-funded). The July-era pool lives
#     directly in ~/.config/dash-forge/test-identities/: that directory is refused, and so is any identity
#     whose id is one of the nine July ids (JULY_POOL_IDS; kept in step with
#     forge-contracts/scripts/lib/target.mjs, checked by e2e/cli/test-config.sh).
#   - Mints (scenarios 19, 25, 33, 36, ...) are funded from the testnet funding wallet you name in
#     E2E_MINT_FUNDING (required on every network, no default: HYGI-12; a devnet funding key, a file
#     named <devnet>-funding.wif, is refused). A minting scenario FAILS when the file is missing
#     (`require_mint_funding`, lib.sh) instead of skipping silently; on a devnet it still skips.

# --- network -----------------------------------------------------------------
_cfg_fatal() { printf 'e2e config: %s\n' "$*" >&2; exit 1; }

: "${DASH_FORGE_NETWORK:=devnet}"
case "$DASH_FORGE_NETWORK" in
  devnet) : "${DASH_FORGE_DEVNET_NAME:=sakura}" ;;
  testnet) DASH_FORGE_DEVNET_NAME="" ;; # a devnet name beside testnet is meaningless (an empty value falls through in dg)
  *) _cfg_fatal "DASH_FORGE_NETWORK must be devnet or testnet, got '${DASH_FORGE_NETWORK}' (no CLI suite runs on mainnet)" ;;
esac
if [[ "$DASH_FORGE_NETWORK" == devnet && ! "$DASH_FORGE_DEVNET_NAME" =~ ^[a-z0-9-]+$ ]]; then
  _cfg_fatal "DASH_FORGE_DEVNET_NAME must match ^[a-z0-9-]+\$, got '${DASH_FORGE_DEVNET_NAME}'"
fi
export DASH_FORGE_NETWORK DASH_FORGE_DEVNET_NAME

# What a scenario passes to tools/mint-identity/mint.mjs to name this network (an array: scenarios
# expand it as "${E2E_MINT_NET_ARGS[@]}"; arrays are not exported, every scenario sources this file).
# shellcheck disable=SC2034 # read by the scenarios that mint
if [[ "$DASH_FORGE_NETWORK" == devnet ]]; then
  E2E_MINT_NET_ARGS=(--network devnet --devnet-name "$DASH_FORGE_DEVNET_NAME")
else
  E2E_MINT_NET_ARGS=(--network testnet)
fi

# The July-era testnet pool (DEPLOYER, TREASURY, OWNER, MAINTAINER, COLLAB, CONTRIB, FROZEN,
# CI-RUNNER, RELAY): public keys, pre-forge-v2. Never an identity of this suite on testnet.
JULY_POOL_IDS="8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB 8igVywVvFTf8aNoaLfS9KsURfAfdHGb3gEeo3vGupZPV B72TJDCsaExkoET6enz6HZGvGcHiSRYupjgve9KARoGx BESA6ZwQD2qBdA5owz6YRm95GkL46xobC4k1s8XjehtM CmGHMP2VqWZng8gtF7Nr9pPXKzmFoKpJQs4mYrCHkyVw 6acfxhgD2c8siYVmJrHgzTE3HF5DcyU3599T4r1vPTr1 BSGeWyh3tQYT1p5Z7SaGpVhU4xsKzSEpQgAPZKTBmvv8 7Tg7PXre8eQL1scWnwvXNa4jq35sbpPpXJ2NM8JxuVe3 3r5GmtjsC2terox8RgXcJh8nPsgW4vT9gT36sA9hZx15"
export JULY_POOL_IDS

# --- minting run-only identities (scenarios 19, 24, 25, 26, 33, 36) -------------
# The funding key tools/mint-identity spends from (a WIF file you provide, on every network: there is
# no default, HYGI-12, and the file must never be committed; `*.wif` is gitignored), and the lock that
# serialises mints across every agent sharing that key's UTXOs. A scenario that mints an identity
# names E2E_MINT_FUNDING in its message when it is unset or unreadable: it skips on a devnet and FAILS
# on testnet (`require_mint_funding`, lib.sh).
: "${E2E_MINT_FUNDING:=}"
if [[ "$DASH_FORGE_NETWORK" == testnet ]]; then
  : "${E2E_MINT_LOCK:=/tmp/qa-mint-testnet.lock}"
  # a devnet funding key (<devnet>-funding.wif) never funds testnet mints
  case "$(basename "${E2E_MINT_FUNDING:-none}")" in
    testnet-funding*) ;;
    *-funding.wif|*-funding) _cfg_fatal "E2E_MINT_FUNDING=${E2E_MINT_FUNDING} looks like a devnet funding key; testnet mints are funded from a testnet wallet (a file named testnet-funding.wif, or another name)" ;;
  esac
else
  : "${E2E_MINT_LOCK:=/tmp/qa-mint-${DASH_FORGE_DEVNET_NAME}.lock}"
fi
export E2E_MINT_FUNDING E2E_MINT_LOCK

# --- fixture identity files --------------------------------------------------
# Per-network directory: `make devnet-identities` provisions devnet-<name> (e.g. devnet-sakura);
# testnet's is testnet-scratch, minted fresh from the QA funding wallet. The July-era pool sits directly
# in test-identities/ and is never used.
_idroot="${HOME}/.config/dash-forge/test-identities"
if [[ "$DASH_FORGE_NETWORK" == devnet ]]; then
  : "${E2E_IDENTITY_DIR:=${_idroot}/devnet-${DASH_FORGE_DEVNET_NAME}}"
else
  : "${E2E_IDENTITY_DIR:=${_idroot}/testnet-scratch}"
fi
export E2E_IDENTITY_DIR
# The owner role is OWNER on every network (the July-era DEPLOYER is not a test role).
: "${E2E_OWNER_ROLE:=OWNER}"
export E2E_OWNER_ROLE
# OWNER owns the test repo; COLLAB is granted and revoked writer; CONTRIB is never a member.
export ID_OWNER="${E2E_IDENTITY_DIR}/${E2E_OWNER_ROLE}.identity.json"
export ID_COLLAB="${E2E_IDENTITY_DIR}/COLLAB.identity.json"
export ID_CONTRIB="${E2E_IDENTITY_DIR}/CONTRIB.identity.json"
# Older scenario scripts say ID_DEPLOYER for the owner's file: the same file as ID_OWNER, not a DEPLOYER role.
export ID_DEPLOYER="$ID_OWNER"

_idid() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["identityId"])' "$1" 2>/dev/null; }
IDID_OWNER="$(_idid "$ID_OWNER")"
IDID_COLLAB="$(_idid "$ID_COLLAB")"
IDID_CONTRIB="$(_idid "$ID_CONTRIB")"
export IDID_OWNER IDID_COLLAB IDID_CONTRIB

# --- testnet refusals (QA-05, QA-V-05, HYGI-12) --------------------------------
if [[ "$DASH_FORGE_NETWORK" == testnet ]]; then
  [[ "${E2E_LIVE_TARGET:-}" == 1 ]] || _cfg_fatal "DASH_FORGE_NETWORK=testnet writes repos, branches and packs to the live testnet registration, which can never be deleted (QA-14: rule suites run on scratch registrations only). Set E2E_LIVE_TARGET=1 to run against it knowingly"
  [[ "$E2E_OWNER_ROLE" != DEPLOYER ]] || _cfg_fatal "E2E_OWNER_ROLE=DEPLOYER on testnet: DEPLOYER is the July-era identity with public keys (SECU-03) and the real deployer's role name; the owner role is OWNER"
  _real_idroot="$(cd "$_idroot" 2>/dev/null && pwd -P || echo "$_idroot")"
  _real_dir="$(cd "$E2E_IDENTITY_DIR" 2>/dev/null && pwd -P || echo "$E2E_IDENTITY_DIR")"
  [[ "$_real_dir" != "$_real_idroot" ]] || _cfg_fatal "E2E_IDENTITY_DIR=${E2E_IDENTITY_DIR} is the directory of the July-era testnet pool (public keys, QA-05); use ${_idroot}/testnet-scratch or another directory of fresh identities"
  for _f in "$ID_OWNER" "$ID_COLLAB" "$ID_CONTRIB"; do
    [[ -r "$_f" ]] || _cfg_fatal "no identity file ${_f}: mint fresh testnet identities into ${E2E_IDENTITY_DIR} (OWNER, COLLAB, CONTRIB) from ${E2E_MINT_FUNDING}; never the July pool"
  done
  for _pair in "OWNER:$IDID_OWNER" "COLLAB:$IDID_COLLAB" "CONTRIB:$IDID_CONTRIB"; do
    case " $JULY_POOL_IDS " in
      *" ${_pair#*:} "*) _cfg_fatal "the ${_pair%%:*} identity ${_pair#*:} is one of the July-era testnet identities (public keys, QA-05, QA-V-05); mint a fresh one" ;;
    esac
  done
  unset _real_idroot _real_dir _f _pair
fi
unset _idroot

# --- the CLI suite's repo ----------------------------------------------------
# A forge-v2 repo owned by OWNER, reserved for `run.sh` (e2e/README.md): every scenario
# pushes Platform-stored packs to fresh `e2e/<run-id>/…` refs and deletes them. An ad-hoc
# run that stores packs anywhere else (local RustFS/kubo) must use its own repo — set
# E2E_REPO_NAME — so the nightly's clones never depend on someone's laptop.
: "${E2E_REPO_NAME:=e2e-cli}"
export E2E_REPO_NAME
export E2E_OWNER_ID="$IDID_OWNER"
export E2E_REMOTE="dash://${E2E_OWNER_ID}/${E2E_REPO_NAME}"

# --- dedicated bring-your-own-storage repos (e2e/cli/storage-byo.sh) ------------
# OWNER-owned, created by the script if absent (reserved in e2e/README.md). Their packs
# live on the LOCAL RustFS/kubo fixtures, so no other scenario may use them.
: "${STORAGE_E2E_REPO:=storage-e2e-a}"
: "${STORAGE_E2E_REPO_B:=storage-e2e-b}"
export STORAGE_E2E_REPO STORAGE_E2E_REPO_B
