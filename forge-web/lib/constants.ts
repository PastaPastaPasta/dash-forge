/**
 * forge-web constants.
 *
 * PARITY SOURCE OF TRUTH: `forge-contracts/vectors/` and `forge-contracts/deployments/*.json`.
 * Ref-resolution / event-fold / chunking rules exist twice (Rust forge-core + this TS) by
 * necessity — both implement `FORGE_RULES_V1` against the shared JSON conformance vectors.
 * Any value here that mirrors forge-core MUST stay byte-for-byte in sync with those vectors;
 * CI runs both suites on every vector change. Do not hand-edit derived values — they are meant
 * to be generated from `forge-contracts/deployments/*.json` once the deploy pipeline lands.
 */

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export type Network = 'testnet' | 'mainnet'

export const DEFAULT_NETWORK: Network = 'testnet'

/**
 * Registry contract is deployed once per network under the DCG/DAO identity;
 * the canonical id lives in `forge-contracts/deployments/<network>.json`.
 * These are placeholders — FILLED BY DEPLOYMENT (do not commit real ids by hand here).
 */
export interface NetworkConfig {
  readonly network: Network
  /** Global registry contract id (discovery + social graph). Deploy-time value. */
  readonly registryContractId: string | null
  /** DPNS system contract id — supplies human-readable identity names. Deploy-time value. */
  readonly dpnsContractId: string | null
}

export const NETWORKS: Readonly<Record<Network, NetworkConfig>> = {
  testnet: {
    network: 'testnet',
    // Source: forge-contracts/deployments/testnet.json (registry.contractId).
    registryContractId: 'DXocbV5xJb9hYwSAUGsyTTskdem7nVmngeJbH5TRzLnh',
    // DPNS system contract (testnet).
    dpnsContractId: 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec',
  },
  mainnet: {
    network: 'mainnet',
    registryContractId: null, // FILLED BY DEPLOYMENT: forge-contracts/deployments/mainnet.json
    dpnsContractId: null, // FILLED BY DEPLOYMENT
  },
}

/** The deployed registry contract owner (DCG/DAO identity) — for listing-authenticity checks. */
export const TESTNET_REGISTRY_OWNER = '8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB'

/**
 * The system **TokenHistory** contract (testnet) holding the `mint` / `freeze` / `unfreeze` /
 * `destroyFrozenFunds` audit documents with consensus `$createdAt` (parity with forge-core
 * `tokens.rs::TOKEN_HISTORY_CONTRACT_ID`, S0.7). Its records reconstruct as-of-time WRITE /
 * MAINTAIN holdings for the issue/PR event fold. Mainnet id is FILLED BY DEPLOYMENT.
 */
export const TOKEN_HISTORY_CONTRACT_ID: Readonly<Record<Network, string | null>> = {
  testnet: '43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF',
  mainnet: null,
}

// ---------------------------------------------------------------------------
// Chunk / browse constants — MIRROR forge-core (parity via forge-contracts/vectors).
// See docs/contracts/data-contracts.md for the normative `chunk` / `manifestPart` /
// `packManifest` field definitions.
// ---------------------------------------------------------------------------

/** Max bytes per byteArray field on `chunk` (d0..d2) and per `manifestPart` entry column. */
export const FIELD_MAX = 4900

/** `chunk` carries three byteArray fields d0..d2. */
export const CHUNK_FIELDS = 3

/** Effective payload per `chunk` document (3 × 4900 B). */
export const CHUNK_PAYLOAD_MAX = FIELD_MAX * CHUNK_FIELDS

/** `packManifest.kind` — browse-plane artifacts share the pack storage/transport machinery. */
export const PACK_KIND = {
  GIT_PACK: 0,
  OBJECT_LOCATOR: 1,
  FLAT_INDEX: 2,
} as const
export type PackKind = (typeof PACK_KIND)[keyof typeof PACK_KIND]

/** `packManifest.storage` — where the bytes physically live. */
export const STORAGE = {
  PLATFORM: 0,
  EXTERNAL: 1,
} as const
export type Storage = (typeof STORAGE)[keyof typeof STORAGE]

/** `packManifest` array bounds (normative). */
export const MANIFEST_MAX_URIS = 8
export const MANIFEST_URI_MAX_LEN = 300
export const MANIFEST_MAX_TIPS = 16
export const MANIFEST_MAX_SUPERSEDES = 32

/**
 * flatIndex publication policy (config-tunable in FORGE_RULES_V1; S0.5 tunes constants):
 * republish after N default-branch pushes or the staleness window, whichever comes first.
 * Readers overlay the ≤ FLATINDEX_OVERLAY_MAX commits since the indexed tip.
 */
export const FLATINDEX_BATCH_PUSHES = 20
export const FLATINDEX_STALENESS_MS = 24 * 60 * 60 * 1000 // 24h
export const FLATINDEX_OVERLAY_MAX = 20

/** Git gitlink (submodule) tree entry mode — rendered as a link, not a blob. */
export const GITLINK_MODE = 0o160000
