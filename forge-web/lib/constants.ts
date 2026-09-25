/**
 * forge-web constants.
 *
 * PARITY SOURCE OF TRUTH: `forge-contracts/vectors/` and `forge-contracts/deployments/*.json`.
 * Ref-resolution / event-fold / chunking rules exist twice (Rust forge-core + this TS) by
 * necessity — both implement `FORGE_RULES_V1` against the shared JSON conformance vectors.
 * Any value here that mirrors forge-core MUST stay byte-for-byte in sync with those vectors;
 * CI runs both suites on every vector change. Per-network contract ids are never written here:
 * they come from `forge-contracts/deployments/*.json` (see `./deployments`), selected by the
 * build-time `NEXT_PUBLIC_NETWORK` / `NEXT_PUBLIC_DEVNET_NAME` / `NEXT_PUBLIC_DAPI_ADDRESSES` /
 * `NEXT_PUBLIC_REGISTRY_CONTRACT_ID`.
 */

import { DEPLOYMENTS, type DeploymentFile } from './deployments'

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** The network kinds forge-web can be built for. A devnet is further named (`moutai`). */
export type Network = 'testnet' | 'mainnet' | 'devnet'

/**
 * Platform **system** contracts. Their ids are fixed by rs-dpp (`dpns_contract::ID_BYTES`,
 * `token_history_contract::ID_BYTES`) and identical on every network — protocol constants,
 * not deployment values.
 */
export const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec'
/**
 * The system **TokenHistory** contract holding the `mint` / `freeze` / `unfreeze` /
 * `destroyFrozenFunds` audit documents with consensus `$createdAt` (parity with forge-core
 * `tokens.rs::TOKEN_HISTORY_CONTRACT_ID`, S0.7). Its records reconstruct as-of-time WRITE /
 * MAINTAIN holdings for the issue/PR event fold.
 */
export const TOKEN_HISTORY_CONTRACT_ID = '43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF'

/** The DAPI port assumed when a configured address omits one (Platform HTTPS gateway). */
export const DEFAULT_DAPI_PORT = 1443

/** One network's resolved configuration. */
export interface NetworkConfig {
  readonly network: Network
  /** The devnet name (`moutai`), or null for testnet/mainnet. */
  readonly devnetName: string | null
  /** Deployment key / display label: `testnet`, `mainnet`, or `devnet-<name>`. */
  readonly key: string
  /** Devnet DAPI endpoints (`https://host:port`); empty = discovered by the SDK. */
  readonly dapiAddresses: readonly string[]
  /** Devnet quorum service URL; null = `https://quorums.<name>.networks.dash.org`. */
  readonly quorumBaseUrl: string | null
  /**
   * Global registry contract id (discovery + social graph), from
   * `forge-contracts/deployments/<key>.json` or `NEXT_PUBLIC_REGISTRY_CONTRACT_ID`. Null =
   * no Dash Forge registry on this network — see {@link NotDeployedError}.
   */
  readonly registryContractId: string | null
  /** Where {@link registryContractId} came from (shown in the UI and the error). */
  readonly registrySource: string | null
  /** DPNS system contract id — supplies human-readable identity names. */
  readonly dpnsContractId: string
}

/** Build-time network selection (`NEXT_PUBLIC_*`, inlined by Next at build). */
export interface NetworkEnv {
  readonly network?: string
  readonly devnetName?: string
  readonly dapiAddresses?: string
  readonly registryContractId?: string
}

/** Thrown by registry-backed reads/writes on a network with no Dash Forge registry. */
export class NotDeployedError extends Error {
  constructor(readonly networkKey: string) {
    super(
      `no Dash Forge registry is deployed on ${networkKey} yet; see docs/mainnet-runbook.md ` +
        `(or build with NEXT_PUBLIC_REGISTRY_CONTRACT_ID set to a registry deployed there)`,
    )
    this.name = 'NotDeployedError'
  }
}

function nonEmpty(v: string | undefined | null): string | null {
  const t = v?.trim()
  return t ? t : null
}

/**
 * Parse a comma-separated DAPI list: `host`, `host:port` or `https://host:port`. A missing
 * scheme becomes `https://`, a missing port {@link DEFAULT_DAPI_PORT} (parity with
 * forge-core `network::parse_dapi_addresses`).
 */
export function parseDapiAddresses(list: string): string[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((raw) => {
      const idx = raw.indexOf('://')
      const scheme = idx >= 0 ? raw.slice(0, idx) : 'https'
      const authority = (idx >= 0 ? raw.slice(idx + 3) : raw).replace(/\/+$/, '')
      if (authority === '' || authority.includes('/') || /\s/.test(authority)) {
        throw new Error(`invalid DAPI address "${raw}": expected host, host:port or https://host:port`)
      }
      return authority.includes(':')
        ? `${scheme}://${authority}`
        : `${scheme}://${authority}:${DEFAULT_DAPI_PORT}`
    })
}

/** Same rule forge-core and the SDK's quorum-URL builder apply. */
function validateDevnetName(name: string): void {
  const reserved = ['mainnet', 'testnet', 'devnet', 'local', 'regtest']
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name) || reserved.includes(name.toLowerCase())) {
    throw new Error(`invalid NEXT_PUBLIC_DEVNET_NAME "${name}": use letters, digits and inner hyphens (e.g. moutai)`)
  }
}

/**
 * Resolve the active network and every network's config from the build env and the
 * embedded deployment files. Precedence per field: env > `deployments/<key>.json` >
 * testnet default. The registry override applies to the active network only. A network
 * without a deployment resolves with `registryContractId: null` — never another network's.
 * Throws on a malformed env (unknown network, devnet without a name) so the BUILD fails.
 */
export function resolveNetworks(
  env: NetworkEnv,
  deployments: Readonly<Record<string, DeploymentFile>>,
): { readonly active: Network; readonly networks: Readonly<Record<Network, NetworkConfig>> } {
  const devnetName = nonEmpty(env.devnetName)
  const kind = (nonEmpty(env.network) ?? (devnetName ? 'devnet' : 'testnet')).toLowerCase()
  if (kind !== 'testnet' && kind !== 'mainnet' && kind !== 'devnet') {
    throw new Error(`unknown NEXT_PUBLIC_NETWORK "${env.network}": expected testnet, mainnet or devnet`)
  }
  const active: Network = kind
  if (active === 'devnet') {
    if (devnetName === null) {
      throw new Error('NEXT_PUBLIC_NETWORK=devnet needs NEXT_PUBLIC_DEVNET_NAME (e.g. moutai)')
    }
    validateDevnetName(devnetName)
  }

  const build = (network: Network, name: string | null): NetworkConfig => {
    const key = network === 'devnet' ? `devnet-${name ?? ''}` : network
    const file = name !== null || network !== 'devnet' ? deployments[key] : undefined
    const isActive = network === active
    const override = isActive ? nonEmpty(env.registryContractId) : null
    const deployed = nonEmpty(file?.registry?.contractId)
    const envAddresses = isActive ? nonEmpty(env.dapiAddresses) : null
    return {
      network,
      devnetName: name,
      key,
      dapiAddresses:
        envAddresses !== null
          ? parseDapiAddresses(envAddresses)
          : parseDapiAddresses((file?.dapiAddresses ?? []).join(',')),
      quorumBaseUrl: nonEmpty(file?.quorumBaseUrl),
      registryContractId: override ?? deployed,
      registrySource:
        override !== null
          ? 'NEXT_PUBLIC_REGISTRY_CONTRACT_ID'
          : deployed !== null
            ? `forge-contracts/deployments/${key}.json`
            : null,
      dpnsContractId: DPNS_CONTRACT_ID,
    }
  }

  return {
    active,
    networks: {
      testnet: build('testnet', null),
      mainnet: build('mainnet', null),
      devnet: build('devnet', active === 'devnet' ? devnetName : null),
    },
  }
}

// `process.env.NEXT_PUBLIC_*` must be written out literally — Next inlines each at build time.
const RESOLVED = resolveNetworks(
  {
    network: process.env.NEXT_PUBLIC_NETWORK,
    devnetName: process.env.NEXT_PUBLIC_DEVNET_NAME,
    dapiAddresses: process.env.NEXT_PUBLIC_DAPI_ADDRESSES,
    registryContractId: process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID,
  },
  DEPLOYMENTS,
)

/** The network this build targets (`NEXT_PUBLIC_NETWORK`, default testnet). */
export const DEFAULT_NETWORK: Network = RESOLVED.active

/** Per-network config (the active network's carries any build-time overrides). */
export const NETWORKS: Readonly<Record<Network, NetworkConfig>> = RESOLVED.networks

/**
 * Where a trusted evo-sdk connection fetches the quorum public keys every proof is checked
 * against — the web app's trust anchor (S0.3, roadmap D-C). Testnet and mainnet mirror the
 * defaults compiled into evo-sdk's `testnetTrusted()` / `mainnetTrusted()`; a devnet uses its
 * deployment's `quorumBaseUrl`, else `quorums.<name>.networks.dash.org` — what `service.ts`
 * hands the SDK (parity with forge-core `Network::quorum_base_url`). The trust panel discloses
 * these, so they must name the endpoint the SDK actually uses. Empty for a devnet this build
 * does not target.
 */
export const QUORUM_KEY_ENDPOINT: Readonly<Record<Network, string>> = {
  testnet: 'https://quorums.testnet.networks.dash.org',
  mainnet: 'https://quorums.mainnet.networks.dash.org',
  devnet:
    NETWORKS.devnet.quorumBaseUrl ??
    (NETWORKS.devnet.devnetName !== null
      ? `https://quorums.${NETWORKS.devnet.devnetName}.networks.dash.org`
      : ''),
}

/** The registry id for `network`, or a {@link NotDeployedError}. */
export function requireRegistryContractId(network: Network): string {
  const config = NETWORKS[network]
  if (config.registryContractId === null) throw new NotDeployedError(config.key)
  return config.registryContractId
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
