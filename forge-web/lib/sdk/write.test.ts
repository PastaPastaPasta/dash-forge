/**
 * WriteEngine unit tests — network-free parity + encoding checks.
 *
 * The token gate table, cost math, base58 identifier encoding, WIF parsing, identity-file
 * extraction, and the createRepo template transforms are all deterministic and verified here
 * against the same `repo-v1.json` the CLI compiles in, so a drift between the browser and Rust
 * write encodings fails CI without needing testnet.
 */

import { describe, expect, it } from 'vitest'

import repoV1 from './repo-v1-template.json'
import {
  COST_ESTIMATE_CREDITS,
  CREDITS_PER_DASH,
  REPO_CREATE_GATES,
  createGateFor,
  creditsToDash,
  previewDocumentCreate,
} from './write'
import {
  applySoloOwnerTokenRules,
  buildRepoV1Contract,
  normalizeDocumentPositions,
  type JsonValue,
} from './contract-create'
import {
  base58CheckDecode,
  base58CheckEncode,
  base58Decode,
  base58Encode,
  decodeIdentifier,
} from '../auth/base58'
import { decodeWif, isLikelyWif, normalizeToWif, parsePrivateKey } from '../auth/wif'
import { parseIdentityFile } from '../auth/identity-file'
import { normalizeRepoName } from '../repo/writes'

// ---------------------------------------------------------------------------
// Token gate table — MUST match repo-v1.json tokenCost.create declarations
// ---------------------------------------------------------------------------

describe('token gate table (repo-v1 parity)', () => {
  it('matches every tokenCost.create in the bundled template', () => {
    const schemas = (repoV1 as { documentSchemas: Record<string, unknown> }).documentSchemas
    for (const [name, schemaRaw] of Object.entries(schemas)) {
      const schema = schemaRaw as { tokenCost?: { create?: { tokenPosition: number; amount: number } } }
      const create = schema.tokenCost?.create
      if (create) {
        expect(REPO_CREATE_GATES[name], `${name} should be gated`).toEqual({
          position: create.tokenPosition,
          amount: create.amount,
        })
      } else {
        expect(REPO_CREATE_GATES[name], `${name} should be ungated`).toBeUndefined()
      }
    }
  })

  it('leaves ungated author-owned types without a gate', () => {
    for (const t of ['issue', 'patch', 'comment', 'event', 'review']) {
      expect(createGateFor(t)).toBeUndefined()
    }
  })

  it('gates refUpdate at WRITE (0) and release/label/config at MAINTAIN (1)', () => {
    expect(createGateFor('refUpdate')).toEqual({ position: 0, amount: 1 })
    expect(createGateFor('release')).toEqual({ position: 1, amount: 1 })
    expect(createGateFor('label')).toEqual({ position: 1, amount: 1 })
    expect(createGateFor('config')).toEqual({ position: 1, amount: 1 })
  })
})

// ---------------------------------------------------------------------------
// Cost preview
// ---------------------------------------------------------------------------

describe('cost preview', () => {
  it('converts credits to DASH at 1e11', () => {
    expect(CREDITS_PER_DASH).toBe(100_000_000_000)
    expect(creditsToDash(CREDITS_PER_DASH)).toBe(1)
    expect(creditsToDash(COST_ESTIMATE_CREDITS.repoCreate)).toBeCloseTo(1.18, 5)
  })

  it('folds the token spend into a gated create preview', () => {
    const gated = previewDocumentCreate('release')
    expect(gated.tokenAmount).toBe(1)
    expect(gated.tokenPosition).toBe(1)
    expect(gated.dash).toBeGreaterThan(0)

    const ungated = previewDocumentCreate('issue')
    expect(ungated.tokenAmount).toBe(0)
    expect(ungated.tokenPosition).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// base58 / identifier encoding (interop with the SDK's identifier fields)
// ---------------------------------------------------------------------------

describe('base58', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 3, 255, 128, 64])
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes)
  })

  it('preserves leading zero bytes as leading 1s', () => {
    const bytes = new Uint8Array([0, 0, 5])
    const enc = base58Encode(bytes)
    expect(enc.startsWith('11')).toBe(true)
    expect(base58Decode(enc)).toEqual(bytes)
  })

  it('round-trips base58check', () => {
    const payload = new Uint8Array([0xef, 1, 2, 3, 4])
    expect(base58CheckDecode(base58CheckEncode(payload))).toEqual(payload)
  })

  it('rejects a corrupted base58check checksum', () => {
    const s = base58CheckEncode(new Uint8Array([1, 2, 3, 4]))
    const bad = s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A')
    expect(() => base58CheckDecode(bad)).toThrow()
  })

  it('decodes a 32-byte identifier and rejects wrong lengths', () => {
    const id = base58Encode(new Uint8Array(32).fill(7))
    expect(decodeIdentifier(id)).toHaveLength(32)
    expect(() => decodeIdentifier(base58Encode(new Uint8Array(20)))).toThrow()
  })
})

// ---------------------------------------------------------------------------
// WIF (the DEPLOYER identity's real testnet key)
// ---------------------------------------------------------------------------

const DEPLOYER_HIGH_WIF = 'cUfRdreVMr1oWoeNW5jCDU4fSjaiZnUX1ZqteaQkZ4Jf9wPSwSxw'
const DEPLOYER_HIGH_HEX = 'd34abcbaad8998865a852434f9b4270d7eaed560c9aad4411b6ac3ed37bfd540'

describe('WIF parsing', () => {
  it('recognizes and decodes a testnet WIF', () => {
    expect(isLikelyWif(DEPLOYER_HIGH_WIF)).toBe(true)
    const decoded = decodeWif(DEPLOYER_HIGH_WIF)
    expect(decoded.compressed).toBe(true)
    expect(decoded.prefix).toBe(0xef)
    expect(Array.from(decoded.privateKey)).toEqual(
      Array.from(Buffer.from(DEPLOYER_HIGH_HEX, 'hex')),
    )
  })

  it('detects the network from the WIF prefix', () => {
    expect(parsePrivateKey(DEPLOYER_HIGH_WIF).network).toBe('testnet')
  })

  it('normalizes hex to the matching WIF', () => {
    expect(normalizeToWif(DEPLOYER_HIGH_HEX, 'testnet')).toBe(DEPLOYER_HIGH_WIF)
    expect(normalizeToWif(DEPLOYER_HIGH_WIF, 'testnet')).toBe(DEPLOYER_HIGH_WIF)
  })

  it('rejects garbage', () => {
    expect(() => parsePrivateKey('not-a-key')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Identity-file extraction (bridge shape → the highest-privilege auth key)
// ---------------------------------------------------------------------------

describe('identity-file parsing', () => {
  const file = {
    network: 'testnet',
    identityId: '8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB',
    identityKeys: [
      { id: 0, purpose: 'AUTHENTICATION', securityLevel: 'MASTER', keyType: 'ECDSA_SECP256K1', privateKeyWif: 'cR9HHQJuTYuziTEeUoQUA99Wqpd9MKxxBkZ84Mcj7Vho7gD9aP9j' },
      { id: 1, purpose: 'AUTHENTICATION', securityLevel: 'HIGH', keyType: 'ECDSA_SECP256K1', privateKeyWif: DEPLOYER_HIGH_WIF },
      { id: 2, purpose: 'AUTHENTICATION', securityLevel: 'CRITICAL', keyType: 'ECDSA_SECP256K1', privateKeyWif: 'cVviZkrc8ExqmH7bdihKmr2mceberJZ4Ab9szNGE8myfUdkoGjgT' },
      { id: 4, purpose: 'ENCRYPTION', securityLevel: 'MEDIUM', keyType: 'ECDSA_SECP256K1', privateKeyWif: 'cPwWp6P9XrBaaP65qPwGsErRmYZ1bxL7H8CFJT5GY1NbvArG7T7T' },
    ],
  }

  it('picks the CRITICAL auth key (highest privilege that covers doc + token ops)', () => {
    const parsed = parseIdentityFile(file)
    expect(parsed.identityId).toBe('8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB')
    expect(parsed.network).toBe('testnet')
    expect(parsed.securityLevel).toBe('CRITICAL')
    expect(parsed.signingKeyWif).toBe('cVviZkrc8ExqmH7bdihKmr2mceberJZ4Ab9szNGE8myfUdkoGjgT')
  })

  it('falls back to HIGH when no CRITICAL key is present', () => {
    const highOnly = {
      ...file,
      identityKeys: file.identityKeys.filter((k) => k.securityLevel !== 'CRITICAL'),
    }
    expect(parseIdentityFile(highOnly).securityLevel).toBe('HIGH')
  })

  it('throws when no usable auth key exists', () => {
    expect(() => parseIdentityFile({ identityId: 'x', identityKeys: [] })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// createRepo template transforms (parity with forge-core repo.rs)
// ---------------------------------------------------------------------------

function collectPositions(schema: JsonValue): number[][] {
  const out: number[][] = []
  const walk = (node: JsonValue): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return
    const props = node['properties']
    if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
      const positions: number[] = []
      for (const key of Object.keys(props)) {
        const prop = props[key]
        if (prop !== null && typeof prop === 'object' && !Array.isArray(prop) && typeof prop['position'] === 'number') {
          positions.push(prop['position'])
        }
        if (prop !== undefined) walk(prop)
      }
      out.push(positions.slice().sort((a, b) => a - b))
    }
  }
  walk(schema)
  return out
}

function findMainGroup(node: JsonValue): boolean {
  if (node === 'MainGroup') return true
  if (Array.isArray(node)) return node.some(findMainGroup)
  if (node !== null && typeof node === 'object') {
    return Object.values(node).some((v) => findMainGroup(v))
  }
  return false
}

describe('createRepo template transforms', () => {
  it('drops the group, re-points MainGroup rules to the owner', () => {
    const template = structuredClone(repoV1) as unknown as { [k: string]: JsonValue }
    // The committed template targets an org repo (has groups + MainGroup rules).
    expect(template['groups']).toBeDefined()
    applySoloOwnerTokenRules(template)
    expect(template['groups']).toBeUndefined()
    expect(findMainGroup(template['tokens'] as JsonValue)).toBe(false)
  })

  it('renumbers every object level to contiguous 0..N positions', () => {
    const template = structuredClone(repoV1) as unknown as { [k: string]: JsonValue }
    normalizeDocumentPositions(template)
    const schemas = template['documentSchemas'] as { [k: string]: JsonValue }
    for (const name of Object.keys(schemas)) {
      const schema = schemas[name]
      if (schema === undefined) continue
      for (const positions of collectPositions(schema)) {
        const expected = positions.map((_, i) => i)
        expect(positions, `${name} positions must be contiguous`).toEqual(expected)
      }
    }
  })

  it('buildRepoV1Contract applies both fixes without mutating the import', () => {
    const built = buildRepoV1Contract()
    expect(built['groups']).toBeUndefined()
    // The shared import must be untouched (structuredClone isolation).
    expect((repoV1 as { groups?: unknown }).groups).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// misc encoding helpers
// ---------------------------------------------------------------------------

describe('repo name normalization', () => {
  it('lowercases and accepts valid names', () => {
    expect(normalizeRepoName('MyRepo')).toBe('myrepo')
    expect(normalizeRepoName('a.b_c-1')).toBe('a.b_c-1')
  })
  it('rejects invalid names', () => {
    expect(() => normalizeRepoName('')).toThrow()
    expect(() => normalizeRepoName('-lead')).toThrow()
    expect(() => normalizeRepoName('has space')).toThrow()
  })
})
