# shellcheck shell=bash
# config.sh — network selection, fixture identities and the shared test repos.
#
# Sourced by lib.sh. Everything here is data: no side effects beyond exports.
#
# The CLI suite runs against devnet MOUTAI, where forge-v2 (protocol 14) is deployed. A v2
# repo costs ~0.001 DASH, so the suite's repo is created on the first run (by
# `harness_ensure_repo`, resumably) rather than hard-coded. Testnet runs resume once
# testnet runs protocol 14 and forge-v2 is deployed there.

# --- network -----------------------------------------------------------------
: "${DASH_FORGE_NETWORK:=devnet}"
: "${DASH_FORGE_DEVNET_NAME:=moutai}"
export DASH_FORGE_NETWORK DASH_FORGE_DEVNET_NAME

# --- fixture identity files --------------------------------------------------
# Per-network directory (`make devnet-identities` provisions devnet-moutai). The testnet
# pool lives directly under test-identities/.
if [[ "$DASH_FORGE_NETWORK" == devnet ]]; then
  : "${E2E_IDENTITY_DIR:=${HOME}/.config/dash-forge/test-identities/devnet-${DASH_FORGE_DEVNET_NAME}}"
else
  : "${E2E_IDENTITY_DIR:=${HOME}/.config/dash-forge/test-identities}"
fi
export E2E_IDENTITY_DIR
# The owner role: OWNER in the moutai pool, DEPLOYER in the testnet pool.
if [[ "$DASH_FORGE_NETWORK" == devnet ]]; then : "${E2E_OWNER_ROLE:=OWNER}"; else : "${E2E_OWNER_ROLE:=DEPLOYER}"; fi
export E2E_OWNER_ROLE
# OWNER owns the test repo; COLLAB is granted and revoked writer; CONTRIB is never a member.
export ID_OWNER="${E2E_IDENTITY_DIR}/${E2E_OWNER_ROLE}.identity.json"
export ID_COLLAB="${E2E_IDENTITY_DIR}/COLLAB.identity.json"
export ID_CONTRIB="${E2E_IDENTITY_DIR}/CONTRIB.identity.json"
# Scripts written before the move to devnet name the owner DEPLOYER.
export ID_DEPLOYER="$ID_OWNER"

_idid() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["identityId"])' "$1" 2>/dev/null; }
IDID_OWNER="$(_idid "$ID_OWNER")"
IDID_COLLAB="$(_idid "$ID_COLLAB")"
IDID_CONTRIB="$(_idid "$ID_CONTRIB")"
export IDID_OWNER IDID_COLLAB IDID_CONTRIB

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
