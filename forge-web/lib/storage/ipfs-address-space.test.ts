import { afterEach, expect, it, vi } from 'vitest'
import { apiAddressSpace, kuboVersion, pinningReachable, type IpfsSettings } from './ipfs'
import { pinRepo, type PinPlan } from './pin'
import { cidV1RawLeaves } from './cid'
import type { RepoRef } from '../repo/contract'
import type { EvoSDK } from '@dashevo/evo-sdk'
import type { StorageProfile } from './profiles'

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['http://127.0.0.1:5001', 'loopback'],
  ['http://localhost:5001', 'loopback'],
  ['https://[::1]:5001', 'loopback'],
  ['https://192.168.1.10:5001', 'local'],
  ['https://10.0.0.1:5001', 'local'],
  ['https://172.16.0.1:5001', 'local'],
  ['https://172.31.255.1:5001', 'local'],
  ['https://169.254.1.1:5001', 'local'],
  ['https://[fe80::1]:5001', 'local'],
  ['https://[fd12::1]:5001', 'local'],
  ['https://nas.example:5001', undefined],
  ['https://kubo.example', undefined],
  ['https://8.8.8.8', undefined],
  ['https://172.32.0.1', undefined],
])('preserves the network scope of RPC and pin requests to %s', async (api, expected) => {
  const hint = expected ? { targetAddressSpace: expected } : {}
  expect(apiAddressSpace(api)).toEqual(hint)
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ Version: '0.43.1' }))
  vi.stubGlobal('fetch', fetch)
  const settings: IpfsSettings = { kind: 'ipfs-kubo', provider: 'kubo', api, gateway: 'https://gw.example', publicGateway: '', pinningEndpoint: '' }
  await kuboVersion(settings, {})
  const cid = cidV1RawLeaves(new Uint8Array([1]))
  const plan: PinPlan = { targets: [{ candidates: [{ cid, swarmAllowed: true }], size: 1, sha256: 'ab'.repeat(32), what: { type: 'pack', kind: 0 } }], notOnIpfs: 0, membersOnlySkipped: 0, unverifiableSkipped: 0, unreadableSkipped: 0, strangerCopiesIgnored: 0, conflictingCidsSkipped: 0, invalidCidsSkipped: 0, needsConsent: false }
  const profile: StorageProfile = { name: 'node', settings, secrets: {} }
  fetch.mockImplementation(async () => Response.json({ Keys: { [cid]: { Type: 'recursive' } } }) as never)
  expect((await pinRepo({} as EvoSDK, { visibility: 'public' } as RepoRef, profile, plan)).already).toBe(1)
  for (const call of fetch.mock.calls as unknown as [string, RequestInit & { targetAddressSpace?: string }][]) {
    expect(call[1].targetAddressSpace).toBe(expected)
    expect(Object.prototype.hasOwnProperty.call(call[1], 'targetAddressSpace')).toBe(expected !== undefined)
  }
})

it('leaves pinning-service requests without an address-space hint', async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ results: [] }))
  vi.stubGlobal('fetch', fetch)
  await pinningReachable({ kind: 'ipfs-pinning-service', provider: 'pinning', api: '', gateway: '', publicGateway: '', pinningEndpoint: 'https://pins.example' }, { pinningToken: 'token' })
  expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('targetAddressSpace')
})
