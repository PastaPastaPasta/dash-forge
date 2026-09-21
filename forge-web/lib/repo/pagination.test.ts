/**
 * Page-boundary reads.
 *
 * Platform serves at most 100 documents per query. Every read that feeds a deterministic
 * fold must therefore page to exhaustion, because a truncated fold does not degrade — it
 * produces a confidently wrong answer (an issue that reads open after it was closed, a
 * branch pinned at its 100th push). The pure fold functions are already covered by the
 * shared conformance vectors; what these tests pin is the *application* read path around
 * them, against an SDK mock that enforces the real 100-row cap and honors `startAfter`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { bytesToBase64, IncompleteReadError, queryAllDocuments } from '../sdk'
import { readConfigBundle } from './config'
import { DOC, type RepoRef } from './contract'
import { emptyAuthz, listIssues, readEvents, readIssue } from './issues'
import { readPackManifests } from './packs'
import { readRefUpdates, resolveRefByHash } from './refs'

const REPO: RepoRef = { contractId: 'contract', ownerId: 'owner' }

/** Platform's per-query document cap — the whole point of these tests. */
const PAGE = 100

interface QueryLike {
  documentTypeName: string
  where?: readonly (readonly [string, string, unknown])[]
  orderBy?: readonly (readonly [string, string])[]
  limit?: number
  startAfter?: string
}

/**
 * A Drive-shaped mock: caps every query at {@link PAGE} rows and honors the `startAfter`
 * `$id` cursor. Rows are stored in ascending order per type; a `desc` orderBy reverses.
 */
function paginatingSdk(
  store: Record<string, Record<string, unknown>[]>,
  seen: QueryLike[] = [],
): EvoSDK {
  return {
    documents: {
      query: (q: QueryLike): Promise<Map<string, unknown>> => {
        seen.push(q)
        let rows = [...(store[q.documentTypeName] ?? [])]
        if (q.orderBy?.some(([, dir]) => dir === 'desc')) rows.reverse()
        if (q.startAfter !== undefined) {
          const idx = rows.findIndex((d) => d['$id'] === q.startAfter)
          rows = idx < 0 ? [] : rows.slice(idx + 1)
        }
        rows = rows.slice(0, Math.min(q.limit ?? PAGE, PAGE))
        return Promise.resolve(new Map(rows.map((d) => [String(d['$id']), d])))
      },
    },
  } as unknown as EvoSDK
}

const REF_NAME = 'refs/heads/main'
const REF_HASH_B64 = bytesToBase64(sha256(new TextEncoder().encode(REF_NAME)))

/** A 32-byte oid, hex, distinct per `seed`. */
function oidHex(seed: number): string {
  return seed.toString(16).padStart(2, '0').repeat(32)
}
function oidB64(seed: number): string {
  return bytesToBase64(new Uint8Array(32).fill(seed))
}

/** Update `i` of a linear chain: oid(i) replacing oid(i-1). */
function refUpdateDoc(i: number): Record<string, unknown> {
  return {
    $id: `u-${String(i).padStart(4, '0')}`,
    $ownerId: 'pusher',
    $createdAt: 1_000 + i,
    refNameHash: REF_HASH_B64,
    refName: REF_NAME,
    prevOid: i === 0 ? null : oidB64(i - 1),
    newOid: oidB64(i),
    force: false,
  }
}

/** `kind` uses the on-chain integer codes: 1 = close, 4 = labelAdd. */
function eventDoc(i: number, kind: number): Record<string, unknown> {
  return {
    $id: `e-${String(i).padStart(4, '0')}`,
    $ownerId: 'author',
    $createdAt: 2_000 + i,
    targetId: 'target-1',
    kind,
    value: kind === 4 ? 'label' : null,
    oid: null,
  }
}

describe('ref history across a page boundary', () => {
  it('reads every update of a ref pushed more than one page of times', async () => {
    const sdk = paginatingSdk({
      [DOC.refUpdate]: Array.from({ length: PAGE + 1 }, (_, i) => refUpdateDoc(i)),
      [DOC.protectedRefUpdate]: [],
    })

    const updates = await readRefUpdates(sdk, REPO, REF_HASH_B64)

    expect(updates).toHaveLength(PAGE + 1)
    expect(updates[updates.length - 1]?.newOid).toBe(oidHex(PAGE))
  })

  it('resolves the tip to the newest push, not the last one on page 1', async () => {
    const sdk = paginatingSdk({
      [DOC.refUpdate]: Array.from({ length: PAGE + 1 }, (_, i) => refUpdateDoc(i)),
      [DOC.protectedRefUpdate]: [],
    })

    const resolved = await resolveRefByHash(sdk, REPO, REF_HASH_B64, [])

    expect(resolved?.refName).toBe(REF_NAME)
    // Push 100 (0-indexed) is the 101st and current tip; oidHex(99) is where a
    // single-page read would strand the branch forever.
    expect(resolved?.state).toMatchObject({ state: 'resolved', oid: oidHex(PAGE) })
  })

  it('pages the protected-ref history too', async () => {
    const sdk = paginatingSdk({
      [DOC.refUpdate]: [],
      [DOC.protectedRefUpdate]: Array.from({ length: PAGE + 1 }, (_, i) => refUpdateDoc(i)),
    })

    const updates = await readRefUpdates(sdk, REPO, REF_HASH_B64)

    expect(updates).toHaveLength(PAGE + 1)
    expect(updates.every((u) => u.protected)).toBe(true)
  })
})

describe('event log across a page boundary', () => {
  it('reads every event of a target', async () => {
    const sdk = paginatingSdk({
      [DOC.event]: Array.from({ length: PAGE + 1 }, (_, i) => eventDoc(i, 4)),
    })

    expect(await readEvents(sdk, REPO, 'target-1')).toHaveLength(PAGE + 1)
  })

  it('folds a close that lands past the first page', async () => {
    // The shape of the burying attack: `event` carries no token cost, so anyone can pad a
    // target with inert events. The real close must still be seen.
    const events = Array.from({ length: PAGE }, (_, i) => eventDoc(i, 4))
    events.push(eventDoc(PAGE, 1))
    const sdk = paginatingSdk({ [DOC.event]: events })

    const issue = await readIssue(
      sdk,
      REPO,
      { $id: 'target-1', $ownerId: 'author', $createdAt: 1, number: 1, title: 't', body: 'b' },
      emptyAuthz(),
    )

    expect(issue.state.open).toBe(false)
  })
})

describe('config timeline across a page boundary', () => {
  it('keeps the oldest configs and still reports the newest as current', async () => {
    const configs = Array.from({ length: PAGE + 1 }, (_, i) => ({
      $id: `c-${String(i).padStart(4, '0')}`,
      $ownerId: 'owner',
      $createdAt: 3_000 + i,
      defaultBranch: i === PAGE ? 'trunk' : 'main',
      protectedPatterns: '["refs/heads/main"]',
      archived: false,
    }))
    const sdk = paginatingSdk({ [DOC.config]: configs })

    const bundle = await readConfigBundle(sdk, REPO)

    // The oldest config must survive: `configAsOf` treats "no config in force" as
    // unprotected, so dropping early history silently disables protected-branch rules.
    expect(bundle.history).toHaveLength(PAGE + 1)
    expect(bundle.history[0]?.id).toBe('c-0000')
    expect(bundle.config?.defaultBranch).toBe('trunk')
  })
})

describe('list surfaces tolerate one unreadable row', () => {
  /** An SDK whose event pages never end, so the reader hits its page cap and throws. */
  function endlessEventsSdk(issues: Record<string, unknown>[]): EvoSDK {
    return {
      documents: {
        query: (q: QueryLike): Promise<Map<string, unknown>> => {
          if (q.documentTypeName === DOC.issue) {
            return Promise.resolve(new Map(issues.map((d) => [String(d['$id']), d])))
          }
          if (q.documentTypeName === DOC.event) {
            // Always a full page whose cursor advances: the end is never proven.
            const base = q.startAfter === undefined ? 0 : Number(String(q.startAfter).slice(2)) + 1
            const rows = Array.from({ length: PAGE }, (_, i) => ({
              $id: `e-${base + i}`,
              $ownerId: 'spammer',
              $createdAt: base + i,
              targetId: 'target-1',
              kind: 4,
            }))
            return Promise.resolve(new Map(rows.map((d) => [String(d['$id']), d])))
          }
          return Promise.resolve(new Map())
        },
      },
    } as unknown as EvoSDK
  }

  it('keeps the row and marks its state unverified instead of failing the page', async () => {
    // `issue` and `event` are un-gated, so one target can be padded without limit. That
    // must not take down the whole issue list — and dropping the row silently would be the
    // same class of bug as truncating it.
    const sdk = endlessEventsSdk([
      { $id: 'target-1', $ownerId: 'author', $createdAt: 1, number: 1, title: 'buried' },
    ])

    const issues = await listIssues(sdk, REPO, emptyAuthz(), 10)

    expect(issues).toHaveLength(1)
    expect(issues[0]?.title).toBe('buried')
    expect(issues[0]?.stateComplete).toBe(false)
  })

  it('still throws on a detail read, where a wrong state is worse than an error', async () => {
    const sdk = endlessEventsSdk([])

    await expect(
      readIssue(
        sdk,
        REPO,
        { $id: 'target-1', $ownerId: 'author', $createdAt: 1, number: 1, title: 't', body: '' },
        emptyAuthz(),
      ),
    ).rejects.toThrow(IncompleteReadError)
  })
})

describe('pack manifests across a page boundary', () => {
  it('returns every manifest, so packRef indices stay aligned', async () => {
    const manifests = Array.from({ length: PAGE + 1 }, (_, i) => ({
      $id: `m-${String(i).padStart(4, '0')}`,
      $createdAt: 4_000 + i,
      packHash: bytesToBase64(new Uint8Array(32).fill(i % 256)),
      kind: 0,
      sizeBytes: 1,
      objectCount: 1,
      chunkCount: 1,
      storage: 0,
    }))
    const sdk = paginatingSdk({ [DOC.packManifest]: manifests })

    const read = await readPackManifests(sdk, REPO)

    // Newest-first contract, and — the point — the OLDEST manifest is still present:
    // it is the base pack every incremental pack deltas against, and `packRef` 0.
    expect(read).toHaveLength(PAGE + 1)
    expect(read[0]?.documentId).toBe(`m-${String(PAGE).padStart(4, '0')}`)
    expect(read[read.length - 1]?.documentId).toBe('m-0000')
  })
})

describe('queryAllDocuments refuses to guess', () => {
  it('throws rather than returning a short answer when the cursor cannot advance', async () => {
    // A full page whose last row has no `$id`: the loop has no way to ask for the next page.
    const rows = Array.from({ length: PAGE }, (_, i) => ({
      ...(i === PAGE - 1 ? {} : { $id: `x-${i}` }),
      $createdAt: i,
    }))
    const sdk = paginatingSdk({ [DOC.event]: rows })

    await expect(
      queryAllDocuments(sdk, { dataContractId: 'c', documentTypeName: DOC.event }),
    ).rejects.toThrow(IncompleteReadError)
  })

  it('throws when the page-count safety cap is reached', async () => {
    // Every page is full and the cursor always advances — the end is never proven.
    const sdk = {
      documents: {
        query: (q: QueryLike): Promise<Map<string, unknown>> => {
          const base = q.startAfter === undefined ? 0 : Number(String(q.startAfter).slice(2)) + 1
          const rows = Array.from({ length: PAGE }, (_, i) => ({
            $id: `y-${base + i}`,
            $createdAt: base + i,
          }))
          return Promise.resolve(new Map(rows.map((d) => [String(d['$id']), d])))
        },
      },
    } as unknown as EvoSDK

    await expect(
      queryAllDocuments(sdk, { dataContractId: 'c', documentTypeName: DOC.event }, { maxPages: 3 }),
    ).rejects.toThrow(/safety cap/)
  })
})
