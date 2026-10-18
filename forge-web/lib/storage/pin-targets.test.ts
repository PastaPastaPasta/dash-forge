import { describe, expect, it } from 'vitest'
import { cidV1RawLeaves, normalizeCid } from './cid'
import { cidOfUri, pinPlanBytes, planPinTargets, type PinInput, type PinManifest } from './pin-targets'

const a = cidV1RawLeaves(new Uint8Array([1]))
const b = cidV1RawLeaves(new Uint8Array([2]))
const hash = 'ab'.repeat(32)
const roles = { writer: 'writer', maint: 'maintainer', bot: 'bot' } as const
const row = (patch: Partial<PinManifest> = {}): PinManifest => ({ id: '1', owner: 'writer', sha256: hash, kind: 0, size: 10, uris: [`ipfs://${a}`], createdAt: 1, readable: true, ...patch })
const input = (manifests: PinManifest[], releases: PinInput['releases'] = []): PinInput => ({ owner: 'owner', roles, manifests, releases })

describe('portable pin planning beyond the shared corpus', () => {
  it('orders targets by hash, choosing the oldest owner or maintainer metadata ahead of writers', () => {
    const p = planPinTargets(input([
      row({ id: 'writer', size: 1 }),
      row({ id: 'owner', owner: 'owner', createdAt: 5, size: 20 }),
      row({ id: 'maint', owner: 'maint', createdAt: 4, size: 30 }),
      row({ id: 'first-hash', sha256: 'aa'.repeat(32), kind: 64, uris: [`ipfs://${b}`] }),
    ]))
    expect(p.targets.map((t) => [t.sha256, t.size, t.what])).toEqual([
      ['aa'.repeat(32), 10, { type: 'pack', kind: 64 }],
      [hash, 30, { type: 'pack', kind: 0 }],
    ])
    expect(p.conflictingCidsSkipped).toBe(2)
  })
  it('lets an earlier bot supply metadata ahead of a writer, as the reference does', () => {
    const p = planPinTargets(input([row({ createdAt: 3, size: 20 }), row({ id: 'bot', owner: 'bot', createdAt: 2 })]))
    expect(p.targets[0]?.size).toBe(10)
    expect(p.conflictingCidsSkipped).toBe(1)
  })
  it('merges a bot release with pack bytes and promotes its CID authority', () => {
    const p = planPinTargets(input([row({ uris: ['https://store/pack'] }), row({ id: 'copy', owner: '', uris: [`ipfs://${b}`] })], [
      { owner: 'bot', tag: 'v1', assets: [{ name: 'asset', sha256: hash, size: 10, uris: [`ipfs://${b}`] }] },
    ]))
    expect(p.targets).toHaveLength(1)
    expect(p.targets[0]).toMatchObject({ what: { type: 'pack', kind: 0 }, candidates: [{ cid: b, swarmAllowed: true }] })
    expect(pinPlanBytes(p)).toBe(10)
  })
  it('counts size conflicts per occurrence and cross-target conflicts after candidate deduplication', () => {
    const p = planPinTargets(input([
      row(),
      row({ id: 'bad-size', owner: 'stranger', size: 99, uris: [`ipfs://${a}`, `ipfs://${a}`] }),
      row({ id: 'other', sha256: 'ff'.repeat(32), uris: ['https://store/pack'] }),
      row({ id: 'bad-hash', owner: 'stranger', sha256: 'ff'.repeat(32), uris: [`ipfs://${a}`, `ipfs://${a}`] }),
    ]))
    expect(p.conflictingCidsSkipped).toBe(3)
    expect(p.notOnIpfs).toBe(1)
  })
  it('keeps consent when a sensitive pack later loses all candidates to an authorized conflict', () => {
    const p = planPinTargets(input([
      row({ sha256: 'aa'.repeat(32), uris: ['https://store/pack'], sensitive: true }),
      row({ id: 'copy', owner: '', sha256: 'aa'.repeat(32) }),
      row(),
    ]))
    expect(p.targets).toHaveLength(1); expect(p.needsConsent).toBe(true)
  })
  it('rejects the malformed CID in strangers_only_add_copies, which declares a 32-byte digest but holds 33 bytes', () => {
    expect(normalizeCid('bafkreiewhdth2uzaidulepiurt7ahxzxm4xkldv6avp4xzt3jzeolmfklaot')).toBeNull()
  })
  it.each([`ipfs://${a}/file`, `ipfs://${a}?x=1`, `https://gw/ipfs/${a}/file`, `https://gw/ipfs/${a}?x=1`, `https://gw/ipfs/${a}?`, `https://gw/ipfs/${a}#`, `http://gw/ipfs/${a}`])('refuses non-object or unsafe gateway addresses: %s', (uri) => {
    expect(cidOfUri(uri)).toBeNull()
  })
})
