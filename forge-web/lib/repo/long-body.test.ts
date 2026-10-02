import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef } from './contract'
import { parseLongBody } from '../rules/long-body'

const role = vi.hoisted(() => ({ value: null as string | null }))
const stored = vi.hoisted(() => ({ calls: [] as { bytes: Uint8Array; meta: unknown; opts: { policy: unknown; intent?: string } }[] }))

vi.mock('./members', () => ({
  readRoleOracle: async () => ({ currentRole: () => role.value }),
}))
vi.mock('../storage', () => ({
  storeAndRecordPack: async (_sdk: unknown, _auth: unknown, _repo: unknown, bytes: Uint8Array, meta: unknown, opts: { policy: unknown; intent?: string }) => {
    stored.calls.push({ bytes, meta, opts })
    return { stored: { packHash: 'ab'.repeat(32), sizeBytes: bytes.length }, manifest: { documentId: 'm' } }
  },
}))

const { bodyRoom, fieldEstimate, isLongBody, longBodyCredits, longBodyField, LONG_BODY_MANIFEST_CREDITS } = await import('./long-body')

const sdk = {} as never
const auth = { identityId: 'A', network: 'devnet' } as never
const pub: RepoRef = { forge: {} as never, repoId: 'R', ownerId: 'O', name: 'r', visibility: 'public' }
const priv: RepoRef = { ...pub, visibility: 'private' }

describe('long bodies, written (forge-v2.md §6.3)', () => {
  beforeEach(() => {
    role.value = null
    stored.calls = []
  })

  it('a field holds 5,120 bytes in public, what the sealed limit leaves beside the other text in private', () => {
    expect(bodyRoom(pub, 'issue', { title: 'A title' })).toBe(5120)
    expect(bodyRoom(priv, 'issue', { title: 'A title' })).toBe(5085 - 7)
    expect(bodyRoom(priv, 'patch', { title: 'T', baseRefName: 'refs/heads/main', sourceRefName: 'refs/heads/x' })).toBe(5079 - 1 - 15 - 12)
    // release notes: 5,120 either way (a sealed release continues them in its asset list)
    expect(bodyRoom(priv, 'release')).toBe(5120)
    expect(isLongBody(pub, 'comment', 'x'.repeat(5120))).toBe(false)
    expect(isLongBody(pub, 'comment', 'x'.repeat(5121))).toBe(true)
  })

  it('prices the field as written and the artifact on Platform (sealed: a little larger)', () => {
    const est = fieldEstimate(pub, 'issue', 'word '.repeat(3000))
    expect(new TextEncoder().encode(est).length).toBeLessThanOrEqual(5120)
    expect(parseLongBody(est).kind).toBe('continued')
    expect(longBodyCredits(pub, 20_000)).toBeGreaterThan(LONG_BODY_MANIFEST_CREDITS)
    expect(longBodyCredits(priv, 20_000)).toBeGreaterThan(longBodyCredits(pub, 20_000))
  })

  it('a text that fits is written as it is, with nothing read or stored', async () => {
    expect(await longBodyField(sdk, auth, pub, 'comment', 'short')).toBe('short')
    expect(stored.calls).toHaveLength(0)
  })

  it('refuses a non-member, a triage member or a reader before anything is stored, with the field limit', async () => {
    for (const r of [null, 'triage', 'reader']) {
      role.value = r
      await expect(longBodyField(sdk, auth, pub, 'comment', 'x'.repeat(6000))).rejects.toThrow(/at most 5120 bytes .*maintainers and writers/)
    }
    expect(stored.calls).toHaveLength(0)
  })

  it('stores a maintainer’s or writer’s full text on Platform as kind 6, and writes the prefix and trailer', async () => {
    for (const r of ['maintainer', 'writer']) {
      role.value = r
      const full = 'A long report line. '.repeat(400)
      const field = await longBodyField(sdk, auth, pub, 'issue', full, { title: 't' }, 'draft-1')
      const parsed = parseLongBody(field)
      expect(parsed).toMatchObject({ kind: 'continued', sha256: 'ab'.repeat(32), bytes: full.length })
      expect(new TextEncoder().encode(field).length).toBeLessThanOrEqual(5120)
      const call = stored.calls.at(-1)
      expect(new TextDecoder().decode(call?.bytes)).toBe(full)
      expect(call?.meta).toEqual({ kind: 6, objectCount: 0 })
      expect(call?.opts.policy).toBeNull()
      expect(call?.opts.intent).toBe('draft-1:long-body')
    }
  })

  it('refuses a text over 256 KiB, whoever writes it', async () => {
    role.value = 'maintainer'
    await expect(longBodyField(sdk, auth, pub, 'comment', 'x'.repeat(262_145))).rejects.toThrow(/at most 262144 bytes/)
    expect(stored.calls).toHaveLength(0)
  })
})
