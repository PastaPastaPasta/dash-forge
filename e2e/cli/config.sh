# shellcheck shell=bash
# config.sh — fixture identities, the reused m1 test repo, and network selection.
#
# Sourced by lib.sh. Everything here is data: no side effects beyond exports.
#
# We deliberately REUSE the already-deployed, DEPLOYER-owned m1 repo contract
# (5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX) rather than minting a fresh
# ~1.18-DASH repo — the fixture pool is low on testnet funds and InstantSend is
# flaky. Every push the harness makes is a few KB.

# --- network -----------------------------------------------------------------
: "${DASH_FORGE_NETWORK:=testnet}"
export DASH_FORGE_NETWORK

# --- the reused test repo ----------------------------------------------------
# DEPLOYER is the owner + token granter for this repo.
export E2E_OWNER_ID="8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB"
export E2E_REPO_NAME="m1-75299"
export E2E_REPO_CONTRACT="5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX"
export E2E_REMOTE="dash://${E2E_OWNER_ID}/${E2E_REPO_NAME}"

# --- fixture identity files --------------------------------------------------
: "${E2E_IDENTITY_DIR:=${HOME}/.config/dash-forge/test-identities}"
export E2E_IDENTITY_DIR
export ID_DEPLOYER="${E2E_IDENTITY_DIR}/DEPLOYER.identity.json"
export ID_COLLAB="${E2E_IDENTITY_DIR}/COLLAB.identity.json"
export ID_CONTRIB="${E2E_IDENTITY_DIR}/CONTRIB.identity.json"
export ID_FROZEN="${E2E_IDENTITY_DIR}/FROZEN.identity.json"

# --- fixture identity ids (base58) -------------------------------------------
# DEPLOYER owns; COLLAB starts with an (unfrozen) WRITE token; CONTRIB has none.
export IDID_DEPLOYER="8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB"
export IDID_COLLAB="CmGHMP2VqWZng8gtF7Nr9pPXKzmFoKpJQs4mYrCHkyVw"
export IDID_CONTRIB="6acfxhgD2c8siYVmJrHgzTE3HF5DcyU3599T4r1vPTr1"
export IDID_FROZEN="BSGeWyh3tQYT1p5Z7SaGpVhU4xsKzSEpQgAPZKTBmvv8"
