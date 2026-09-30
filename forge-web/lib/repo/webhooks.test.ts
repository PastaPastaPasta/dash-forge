/**
 * QW-071: webhooks from the browser, as forge-core writes them (`webhooks.rs`): the URL rules,
 * newest-per-hook resolution, the document a write sends, and a removal that must not let
 * another maintainer's revision become current again.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const created: { contractId: string; documentType: string; data: Record<string, unknown> }[] = []
const deleted: string[] = []
let stored: Record<string, unknown>[] = []

vi.mock('../sdk', async (orig) => {
  const real = await orig<typeof import('../sdk')>()
  return {
    ...real,
    queryAllDocuments: async () => stored,
    createDocumentIdempotent: async (_sdk: unknown, _auth: unknown, p: { contractId: string; documentType: string; data: Record<string, unknown> }) => {
      created.push(p)
      return { documentId: 'NEW' }
    },
    deleteDocumentIdempotent: async (_sdk: unknown, _auth: unknown, p: { documentId: string }) => {
      deleted.push(p.documentId)
      return {}
    },
  }
})

import { base58Encode } from '../auth/base58'
import type { RepoRef } from './contract'
import { activeHooks, generateWebhookSecret, newestPerHook, removeWebhook, webhookUrlProblem, writeWebhook, type WebhookView } from './webhooks'

const id = (b: number): string => base58Encode(new Uint8Array(32).fill(b))
const ME = id(1)
const OTHER = id(2)
const RELAY = id(3)
const REPO: RepoRef = { repoId: id(9), name: 'r', ownerId: ME, visibility: 'public', forge: { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY' } } as unknown as RepoRef
const HOOK = 'ab'.repeat(32)
const auth = { identityId: ME } as never
const sealed: string[] = []
const seal = async (_p: Uint8Array, recipient: string) => {
  sealed.push(recipient)
  return { secret: new Uint8Array(96), relayKeyId: 4, senderKeyId: 7 }
}

const view = (doc: string, owner: string, at: number, disabled = false, hook = HOOK): WebhookView => ({
  documentId: doc,
  ownerId: owner,
  createdAt: at,
  hookId: hook,
  url: `https://ci.example.com/${doc}`,
  events: [],
  relayIdentityId: RELAY,
  relayKeyId: 4,
  disabled,
})

/** A stored document as a query returns it (bytes as base64). */
const raw = (doc: string, owner: string, at: number, disabled = false): Record<string, unknown> => ({
  $id: doc,
  $ownerId: owner,
  $createdAt: at,
  hookId: Buffer.from(HOOK, 'hex').toString('base64'),
  url: `https://ci.example.com/${doc}`,
  relayIdentityId: RELAY,
  relayKeyId: 4,
  ...(disabled ? { disabled: true } : {}),
})

beforeEach(() => {
  created.length = 0
  deleted.length = 0
  sealed.length = 0
  stored = []
})

describe('webhookUrlProblem', () => {
  it('admits https to a DNS name, with a port and a path', () => {
    expect(webhookUrlProblem('https://ci.example.com/hook')).toBeNull()
    expect(webhookUrlProblem('https://ci.example.com:8443/a/b')).toBeNull()
  })
  it('refuses what the schema or forge-core refuses', () => {
    expect(webhookUrlProblem('http://ci.example.com/')).toMatch(/https/)
    expect(webhookUrlProblem('https://10.0.0.1/hook')).toMatch(/DNS name/)
    expect(webhookUrlProblem('https://localhost/hook')).toMatch(/DNS name/)
    expect(webhookUrlProblem('https://user:pw@ci.example.com/')).toMatch(/user:password/)
    expect(webhookUrlProblem(`https://ci.example.com/${'a'.repeat(300)}`)).toMatch(/300 bytes/)
  })
  it('refuses a query string unless it is confirmed to hold nothing secret', () => {
    expect(webhookUrlProblem('https://ci.example.com/hook?token=x')).toMatch(/query string/)
    expect(webhookUrlProblem('https://ci.example.com/hook?ref=main', true)).toBeNull()
  })
})

describe('newest per hook', () => {
  it('takes the newest by $createdAt then $id, and a newest disabled one stops the hook', () => {
    const docs = [view('a', ME, 10), view('c', ME, 20), view('b', ME, 20), view('x', ME, 5, false, 'cd'.repeat(32)), view('y', ME, 6, true, 'cd'.repeat(32))]
    expect(newestPerHook(docs).map((h) => h.documentId)).toEqual(['c', 'y'])
    expect(activeHooks(docs).map((h) => h.documentId)).toEqual(['c'])
  })
})

describe('writeWebhook', () => {
  it('sends forge-core’s fields: ids as bytes, events only when chosen, vis public, the sealed secret', async () => {
    await writeWebhook({} as never, auth, REPO, seal, { hookId: HOOK, url: 'https://ci.example.com/h', events: ['push'], relayIdentityId: RELAY, secret: generateWebhookSecret() })
    expect(sealed).toEqual([RELAY])
    const w = created[0]!
    expect(w).toMatchObject({ contractId: 'COMMUNITY', documentType: 'webhook' })
    expect(w.data).toMatchObject({ url: 'https://ci.example.com/h', events: ['push'], vis: 'public', relayKeyId: 4, senderKeyId: 7 })
    expect((w.data['hookId'] as Uint8Array).length).toBe(32)
    expect((w.data['repoId'] as Uint8Array).length).toBe(32)
    expect((w.data['relayIdentityId'] as Uint8Array).length).toBe(32)
    expect(w.data).not.toHaveProperty('disabled')
    await writeWebhook({} as never, auth, REPO, seal, { hookId: HOOK, url: 'https://ci.example.com/h', events: [], relayIdentityId: RELAY, secret: generateWebhookSecret() })
    expect(created[1]!.data).not.toHaveProperty('events')
  })

  it('refuses a private repo', async () => {
    await expect(writeWebhook({} as never, auth, { ...REPO, visibility: 'private' } as RepoRef, seal, { hookId: HOOK, url: 'https://ci.example.com/h', events: [], relayIdentityId: RELAY, secret: 'x'.repeat(64) })).rejects.toThrow(/public repos/)
    expect(created).toHaveLength(0)
  })

  it('makes a 64-character hex secret, as forge-core does', () => {
    expect(generateWebhookSecret()).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('removeWebhook', () => {
  it('deletes the signer’s own documents when nobody else’s would be current', async () => {
    stored = [raw('mine1', ME, 10), raw('mine2', ME, 20)]
    const r = await removeWebhook({} as never, auth, REPO, seal, HOOK)
    expect(r).toEqual({ tombstone: false, deleted: 2 })
    expect(deleted).toEqual(['mine1', 'mine2'])
    expect(created).toHaveLength(0)
  })

  it('removes the signer’s own hook without an encryption key when no tombstone is needed', async () => {
    stored = [raw('mine1', ME, 10)]
    expect(await removeWebhook({} as never, auth, REPO, null, HOOK)).toEqual({ tombstone: false, deleted: 1 })
    expect(deleted).toEqual(['mine1'])
  })

  it('refuses before any write when a tombstone is needed and there is no encryption key', async () => {
    stored = [raw('theirs', OTHER, 10), raw('mine', ME, 20)]
    await expect(removeWebhook({} as never, auth, REPO, null, HOOK)).rejects.toThrow(/encryption key/)
    expect(created).toHaveLength(0)
    expect(deleted).toEqual([])
  })

  it('first writes a disabled revision addressed to the signer when another maintainer’s would be current', async () => {
    stored = [raw('theirs', OTHER, 10), raw('mine', ME, 20)]
    const r = await removeWebhook({} as never, auth, REPO, seal, HOOK)
    expect(r).toEqual({ tombstone: true, deleted: 1 })
    expect(created[0]!.data).toMatchObject({ disabled: true })
    // Sealed to the signer's own key: no relay can read the tombstone's secret.
    expect(sealed).toEqual([ME])
    expect(deleted).toEqual(['mine'])
  })
})
