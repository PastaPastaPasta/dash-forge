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

# --- the CLI suite's repo ----------------------------------------------------
# DEPLOYER is the owner + token granter. Reserved for `run.sh` (e2e/README.md): every
# scenario pushes Platform-stored packs to fresh `e2e/<run-id>/…` refs and deletes them.
# An ad-hoc run that stores packs anywhere else (local MinIO/kubo) must use its own repo —
# set E2E_REPO_NAME — so the nightly's clones never depend on someone's laptop.
export E2E_OWNER_ID="8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB"
: "${E2E_REPO_NAME:=m1-75299}"
export E2E_REPO_NAME
export E2E_REMOTE="dash://${E2E_OWNER_ID}/${E2E_REPO_NAME}"

# --- dedicated bring-your-own-storage repos (e2e/cli/storage-byo.sh) ------------
# DEPLOYER-owned, created once by the script if absent (reserved in e2e/README.md).
# Their packs live on the LOCAL MinIO/kubo fixtures, so no other scenario may use them —
# and storage-byo.sh never touches the shared m1 repo above.
: "${STORAGE_E2E_REPO:=storage-e2e-a}"
: "${STORAGE_E2E_REPO_B:=storage-e2e-b}"
export STORAGE_E2E_REPO STORAGE_E2E_REPO_B

# --- the nightly's read fixture ----------------------------------------------
# The repo the browser (Playwright) specs read: DEPLOYER-owned, written ONLY by
# e2e/cli/seed-read-fixture.sh, which pins `main` to one deterministic commit and publishes
# no browse index (so the in-browser fallback clone is what gets exercised). forge-web's
# e2e/helpers.ts names the same repo.
: "${NIGHTLY_FIXTURE_REPO:=m1-5124}"
export NIGHTLY_FIXTURE_REPO

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
