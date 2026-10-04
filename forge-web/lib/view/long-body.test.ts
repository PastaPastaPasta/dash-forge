import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import type { RepoRef } from '../repo/contract'
import type { PackManifest } from '../repo/packs'
import { longBodyStoredText } from '../rules/long-body'

const copies = vi.hoisted(() => ({ value: null as PackManifest | null, reads: 0 }))
const bytes = vi.hoisted(() => ({ value: new Uint8Array(), fail: false, loads: 0 }))

vi.mock('../repo/packs', () => ({
  readPackCopies: async () => {
    copies.reads += 1
    return copies.value
  },
}))
vi.mock('./browse-source', () => ({
  loadArtifactBytes: async () => {
    bytes.loads += 1
    if (bytes.fail) throw new Error('no copy served its bytes')
    return bytes.value
  },
}))

const { readLongBody, withLongBodies } = await import('./long-body')

const sdk = {} as never
let n = 0
/** A repo of its own per test: the session cache is keyed by repo. */
const repo = (): RepoRef => ({ forge: { core: 'c', collab: 'k', community: 'm' } as never, repoId: `R${++n}`, ownerId: 'O', name: 'r', visibility: 'public' })

const FULL = 'Release notes\n\n' + '- a change é\n'.repeat(600)
const HASH = bytesToHex(sha256(new TextEncoder().encode(FULL)))
const FIELD = longBodyStoredText(FULL, 5120, HASH) as string
const manifest = (sizeBytes: number): PackManifest =>
  ({ packHash: HASH, kind: 6, sizeBytes, objectCount: 0, chunkCount: 1, storage: 0, uris: [], tips: [], supersedes: [], createdAt: 1, documentId: 'm', uploader: 'O' }) as PackManifest

describe('readLongBody (forge-v2.md §6.3)', () => {
  beforeEach(() => {
    copies.value = null
    copies.reads = 0
    bytes.value = new TextEncoder().encode(FULL)
    bytes.fail = false
    bytes.loads = 0
  })

  it('reads nothing for a field without a trailer', async () => {
    const r = await readLongBody(sdk, repo(), 'just text')
    expect(r).toEqual({ text: 'just text' })
    expect(copies.reads).toBe(0)
  })

  it('reads the full text a trailer names, once per session', async () => {
    const m = manifest(new TextEncoder().encode(FULL).length)
    copies.value = { ...m, copies: [m] }
    const at = repo()
    const r = await readLongBody(sdk, at, FIELD)
    expect(r.text).toBe(FULL)
    expect(r.long).toEqual({ bytes: new TextEncoder().encode(FULL).length, incomplete: null, field: FIELD })
    await readLongBody(sdk, at, FIELD)
    expect(copies.reads).toBe(1)
  })

  it('shows the first part and why when no copy is recorded, a copy claims another size, or the bytes do not serve', async () => {
    const prefix = FIELD.slice(0, FIELD.lastIndexOf('\n\n'))
    let r = await readLongBody(sdk, repo(), FIELD)
    expect(r.text).toBe(prefix)
    expect(r.long?.incomplete).toMatch(/no copy of it is recorded/)
    // a public copy must claim exactly the text's length: one claiming more is never fetched
    const big = manifest(10 ** 6)
    copies.value = { ...big, copies: [big] }
    r = await readLongBody(sdk, repo(), FIELD)
    expect(r.long?.incomplete).toMatch(/no copy/)
    expect(bytes.loads).toBe(0)
    const m = manifest(new TextEncoder().encode(FULL).length)
    copies.value = { ...m, copies: [m] }
    bytes.fail = true
    r = await readLongBody(sdk, repo(), FIELD)
    expect(r.text).toBe(prefix)
    expect(r.long?.incomplete).toMatch(/no copy served/)
  })

  it('says a trailer this version cannot read is unsupported, and fetches nothing', async () => {
    const r = await readLongBody(sdk, repo(), `Head\n\n<!-- forge:body sha256=${HASH} bytes=9 repo=x -->`)
    expect(r).toEqual({ text: 'Head', long: { bytes: null, incomplete: expect.stringMatching(/cannot read/), field: expect.any(String) } })
    expect(copies.reads).toBe(0)
  })

  it('withLongBodies replaces each long body and leaves the rest as they are', async () => {
    const m = manifest(new TextEncoder().encode(FULL).length)
    copies.value = { ...m, copies: [m] }
    const items = [{ id: 'a', body: 'short' }, { id: 'b', body: FIELD }]
    const out = await withLongBodies(sdk, repo(), items)
    expect(out[0]).toBe(items[0])
    expect(out[1]?.body).toBe(FULL)
    expect(out[1]?.long?.incomplete).toBeNull()
  })
})
