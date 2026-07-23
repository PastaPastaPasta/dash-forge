/**
 * Bridge-format identity-file parsing.
 *
 * The Dash Forge tooling (and the bridge) emit an identity JSON of the shape:
 *
 * ```json
 * { "network": "testnet", "identityId": "…",
 *   "identityKeys": [ { "id": 1, "purpose": "AUTHENTICATION",
 *                       "securityLevel": "HIGH", "keyType": "ECDSA_SECP256K1",
 *                       "privateKeyWif": "…" }, … ] }
 * ```
 *
 * Login imports one of these (or a manually pasted WIF + identity id). We extract the identity
 * id, the file's declared network, and the single AUTHENTICATION signing key to store —
 * preferring the highest-privilege usable key (CRITICAL, which can sign both HIGH-gated
 * document ops and CRITICAL-gated token-admin ops) and falling back to HIGH.
 */

import { isLikelyWif } from './wif'
import type { Network } from '../constants'

/** The material extracted from an identity file, ready to hand to the keystore. */
export interface ParsedIdentityFile {
  readonly identityId: string
  /** The network the file declares, if any (used to reject a testnet key on mainnet). */
  readonly network: Network | null
  /** The chosen AUTHENTICATION signing key, WIF-encoded. */
  readonly signingKeyWif: string
  /** The chosen key's security level, for display / diagnostics. */
  readonly securityLevel: 'CRITICAL' | 'HIGH'
}

interface RawKey {
  purpose?: unknown
  securityLevel?: unknown
  keyType?: unknown
  privateKeyWif?: unknown
  privateKey?: unknown
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function normalizeNetwork(v: unknown): Network | null {
  if (v === 'mainnet') return 'mainnet'
  if (v === 'testnet') return 'testnet'
  return null
}

/** Rank an AUTHENTICATION key: CRITICAL (0, best) < HIGH (1) < everything else (unusable). */
function levelRank(level: string): number {
  const u = level.toUpperCase()
  if (u === 'CRITICAL') return 0
  if (u === 'HIGH') return 1
  return 99
}

/**
 * Key types whose private key is a plain secp256k1 scalar (WIF-encodable) and whose state
 * transitions the SDK signs with ordinary ECDSA — the write path (`findSigningKey`) matches the
 * WIF against the on-chain key via `validatePrivateKey`, which handles both. BLS12_381 /
 * EDDSA_25519_HASH160 keys use different curves and cannot be signed with a WIF here.
 */
const WIF_SIGNABLE_KEY_TYPES = new Set(['ECDSA_SECP256K1', 'ECDSA_HASH160'])

/**
 * Parse a bridge-format identity JSON. Throws a descriptive error if it lacks an identity id
 * or any usable AUTHENTICATION signing key.
 */
export function parseIdentityFile(json: unknown): ParsedIdentityFile {
  if (json === null || typeof json !== 'object') {
    throw new Error('identity file must be a JSON object')
  }
  const obj = json as Record<string, unknown>
  const identityId = asString(obj['identityId']) ?? asString(obj['id'])
  if (identityId === null) {
    throw new Error('identity file is missing "identityId"')
  }
  const network = normalizeNetwork(obj['network'])

  const rawKeys = obj['identityKeys'] ?? obj['keys']
  if (!Array.isArray(rawKeys)) {
    throw new Error('identity file is missing an "identityKeys" array')
  }

  let best: { wif: string; level: 'CRITICAL' | 'HIGH'; rank: number } | null = null
  for (const raw of rawKeys as RawKey[]) {
    if (asString(raw.purpose)?.toUpperCase() !== 'AUTHENTICATION') continue
    const keyType = asString(raw.keyType)
    if (keyType !== null && !WIF_SIGNABLE_KEY_TYPES.has(keyType.toUpperCase())) continue
    const level = asString(raw.securityLevel)
    if (level === null) continue
    const rank = levelRank(level)
    if (rank > 1) continue
    const wif = asString(raw.privateKeyWif) ?? asString(raw.privateKey)
    if (wif === null || !isLikelyWif(wif)) continue
    if (best === null || rank < best.rank) {
      best = { wif, level: rank === 0 ? 'CRITICAL' : 'HIGH', rank }
    }
  }

  if (best === null) {
    throw new Error(
      'identity file has no usable AUTHENTICATION key (need a CRITICAL or HIGH ECDSA key with a private key WIF)',
    )
  }

  return { identityId, network, signingKeyWif: best.wif, securityLevel: best.level }
}

/** Parse identity-file text (JSON string) with a friendly error on malformed JSON. */
export function parseIdentityFileText(text: string): ParsedIdentityFile {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    throw new Error(`identity file is not valid JSON: ${(e as Error).message}`)
  }
  return parseIdentityFile(json)
}
