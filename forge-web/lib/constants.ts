/**
 * forge-web constants.
 *
 * PARITY SOURCE OF TRUTH: `forge-contracts/vectors/` and `forge-contracts/deployments/*.json`.
 * Ref-resolution / event-fold / chunking rules exist twice (Rust forge-core + this TS) by
 * necessity — both implement FORGE_RULES / FORGE_RULES_V2 against the shared JSON conformance
 * vectors.
 * Any value here that mirrors forge-core MUST stay byte-for-byte in sync with those vectors;
 * CI runs both suites on every vector change. Per-network contract ids are never written here:
 * they come from `forge-contracts/deployments/*.json` (see `./deployments`), selected by the
 * build-time `NEXT_PUBLIC_NETWORK` / `NEXT_PUBLIC_DEVNET_NAME` / `NEXT_PUBLIC_DAPI_ADDRESSES` /
 * `NEXT_PUBLIC_QUORUM_URL`.
 */

import {
  DEPLOYMENTS,
  forgeV2Ids,
  recordedDapiAddresses,
  type DeploymentFile,
  type ForgeIds,
} from './deployments'
import storageDefaults from '../../forge-contracts/config/storage-defaults.json'

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** The network kinds forge-web can be built for. A devnet is further named (`moutai`). */
export type Network = 'testnet' | 'mainnet' | 'devnet'

/**
 * The Platform **DPNS** system contract. Its id is fixed by rs-dpp (`dpns_contract::ID_BYTES`)
 * and identical on every network — a protocol constant, not a deployment value.
 */
export const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec'

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
  /** DPNS system contract id — supplies human-readable identity names. */
  readonly dpnsContractId: string
  /**
   * The forge-v2 contracts registered here (`deployments/<key>.json` `v2`). Null = Dash Forge
   * is not deployed on this network — see {@link NotDeployedError}.
   */
  readonly v2: ForgeIds | null
}

/** Build-time network selection (`NEXT_PUBLIC_*`, inlined by Next at build). */
export interface NetworkEnv {
  readonly network?: string
  readonly devnetName?: string
  readonly dapiAddresses?: string
  /** Devnet quorum service URL (`NEXT_PUBLIC_QUORUM_URL`; parity with `DASH_FORGE_QUORUM_URL`). */
  readonly quorumBaseUrl?: string
}

/** Thrown by reads/writes on a network where forge-v2 is not deployed ({@link NetworkConfig.v2} null). */
export class NotDeployedError extends Error {
  constructor(readonly networkKey: string) {
    super(
      `forge-v2 is not deployed on ${networkKey}; see docs/contracts/forge-v2.md §8 ` +
        `(a network is deployed once forge-contracts/deployments/${networkKey}.json records it)`,
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
 * testnet default. A network without a deployment resolves with `v2: null` — never another
 * network's. Throws on a malformed env (unknown network, devnet without a name) so the BUILD fails.
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
    const envAddresses = isActive ? nonEmpty(env.dapiAddresses) : null
    const envQuorum = isActive ? nonEmpty(env.quorumBaseUrl) : null
    return {
      network,
      devnetName: name,
      key,
      dapiAddresses:
        envAddresses !== null
          ? parseDapiAddresses(envAddresses)
          : parseDapiAddresses(recordedDapiAddresses(file).join(',')),
      quorumBaseUrl: envQuorum ?? nonEmpty(file?.quorumBaseUrl),
      dpnsContractId: DPNS_CONTRACT_ID,
      v2: forgeV2Ids(file),
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
    quorumBaseUrl: process.env.NEXT_PUBLIC_QUORUM_URL,
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
 * configured `quorumBaseUrl` (`NEXT_PUBLIC_QUORUM_URL`, else the deployment file), else
 * `quorums.<name>.networks.dash.org` — what `service.ts` hands the SDK (parity with forge-core
 * `Network::quorum_base_url`). The trust panel discloses this, so it must name the endpoint
 * the SDK actually uses. `''` for a devnet config with no name (one this build does not target).
 */
export function quorumEndpoint(config: NetworkConfig): string {
  switch (config.network) {
    case 'testnet':
    case 'mainnet':
      return `https://quorums.${config.network}.networks.dash.org`
    case 'devnet':
      if (config.quorumBaseUrl !== null) return config.quorumBaseUrl
      return config.devnetName !== null ? `https://quorums.${config.devnetName}.networks.dash.org` : ''
  }
}

/** {@link quorumEndpoint} for each network as this build resolved it. */
export const QUORUM_KEY_ENDPOINT: Readonly<Record<Network, string>> = {
  testnet: quorumEndpoint(NETWORKS.testnet),
  mainnet: quorumEndpoint(NETWORKS.mainnet),
  devnet: quorumEndpoint(NETWORKS.devnet),
}

/**
 * Public IPFS gateways an `ipfs://<cid>` pack URI is fetched through, in order, after
 * whatever `http(s)` mirrors the manifest itself records — the list every client shares
 * (`forge-contracts/config/storage-defaults.json`, which forge-core embeds). Byte sources
 * only: every external pack is sha256-checked against its proof-read manifest, so a gateway
 * that lies or is down costs a retry, never integrity.
 */
export const IPFS_GATEWAYS: readonly string[] = storageDefaults.ipfsGateways

/** The config of the network this build targets. */
export const ACTIVE_NETWORK: NetworkConfig = NETWORKS[DEFAULT_NETWORK]

/** The forge-v2 contracts of `network`, or a {@link NotDeployedError}. */
export function requireForge(network: Network): ForgeIds {
  const config = NETWORKS[network]
  if (config.v2 === null) throw new NotDeployedError(config.key)
  return config.v2
}

// ---------------------------------------------------------------------------
// Chunk / browse constants — MIRROR forge-core (parity via forge-contracts/vectors).
// See docs/contracts/forge-v2.md and forge-contracts/contracts/forge-core.json for the
// normative `chunk` / `packManifest` field definitions.
// ---------------------------------------------------------------------------

/** Max bytes per byteArray field on `chunk` (d0..d2). */
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
  /**
   * The history index: each path's last change and the commit count of a tip. RC1 `kindShape`
   * requires its `tips` to be 20, 32, 40 or 64 bytes (one or two SHA-1 / SHA-256 oids).
   */
  HISTORY_INDEX: 3,
  /**
   * A release's asset manifest (D-4, `release-asset-manifest.md`; RC1 R-11 renumbered it from 3
   * so history readers never load asset JSON as an index). No web writer yet — the browser records
   * assets inline in `release.assets` — and no reader: every reader selects its own kind.
   */
  RELEASE_ASSETS: 4,
} as const
export type PackKind = (typeof PACK_KIND)[keyof typeof PACK_KIND]

/** `packManifest.storage` — where the bytes physically live. */
export const STORAGE = {
  PLATFORM: 0,
  EXTERNAL: 1,
} as const
export type Storage = (typeof STORAGE)[keyof typeof STORAGE]

/**
 * `packManifest.sizeBytes` bounds (RC1 `sizeNonNeg`: a plain integer, 0 to 1 TiB). A Platform
 * copy (`storage` 0) must also fit its chunks (`storageShape`: at most `chunkCount` ×
 * {@link CHUNK_PAYLOAD_MAX}), and an external-only one (`storage` 1) records no chunks.
 */
export const MANIFEST_SIZE_MAX = 2 ** 40

/** `packManifest` array bounds (normative). */
export const MANIFEST_MAX_URIS = 8
export const MANIFEST_URI_MAX_LEN = 300
export const MANIFEST_MAX_TIPS = 16
export const MANIFEST_MAX_SUPERSEDES = 32

/**
 * flatIndex publication policy (S0.5 tunes constants):
 * republish after N default-branch pushes or the staleness window, whichever comes first.
 * Readers overlay the ≤ FLATINDEX_OVERLAY_MAX commits since the indexed tip.
 */
export const FLATINDEX_BATCH_PUSHES = 20
export const FLATINDEX_STALENESS_MS = 24 * 60 * 60 * 1000 // 24h
export const FLATINDEX_OVERLAY_MAX = 20

/** Git gitlink (submodule) tree entry mode — rendered as a link, not a blob. */
export const GITLINK_MODE = 0o160000
