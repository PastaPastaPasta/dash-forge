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

import {
  ascendingEquivalent,
  bytesToBase64,
  IncompleteReadError,
  queryAllDocuments,
  skipScanDistinct,
  tieProbeAllowed,
} from '../sdk'
import { readConfigBundle } from './config'
import { DOC, type RepoRef } from './contract'
import { emptyAuthz, listIssues, readEvents, readIssue, readReviews } from './issues'
import { orderGitPacks } from '../view/browse-source'
import { readPackManifests } from './packs'
import { readComments } from '../view/issues-view'
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

/** Compare on the `(field, $id)` key a Drive index traversal uses. */
function byField(field: string) {
  return (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    const av = a[field]
    const bv = b[field]
    if (typeof av === 'number' && typeof bv === 'number' && av !== bv) return av - bv
    if (typeof av === 'string' && typeof bv === 'string' && av !== bv) return av < bv ? -1 : 1
    return String(a['$id']) < String(b['$id']) ? -1 : String(a['$id']) > String(b['$id']) ? 1 : 0
  }
}

/**
 * A Drive-shaped mock: applies `where` clauses, sorts by the **named** orderBy field (not
 * just its direction), caps every query at {@link PAGE} rows, and honors the `startAfter`
 * `$id` cursor.
 *
 * Applying `where` is load-bearing for this suite, not realism for its own sake. With a mock
 * that ignores filters and a store holding rows for one target, deleting
 * `where: [['targetId','==',targetId]]` from a reader passes every test here while making
 * every issue in a repo fold every other issue's close events — `foldIssueState` never checks
 * `targetId` itself. So the fixtures below deliberately seed rows the filter MUST exclude.
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

        for (const [field, op, value] of q.where ?? []) {
          if (op === '==') rows = rows.filter((d) => d[field] === value)
          else if (op === 'in' && Array.isArray(value)) {
            rows = rows.filter((d) => (value as unknown[]).includes(d[field]))
          } else if (op === '>') rows = rows.filter((d) => String(d[field]) > String(value))
        }

        // Sort by the FIRST orderBy field, so a reader that orders on the wrong key is
        // visible. Ties fall back to `$id`, the same terminal key Drive uses.
        const [orderField, orderDir] = q.orderBy?.[0] ?? ['$createdAt', 'asc']
        rows.sort(byField(orderField))
        if (orderDir === 'desc') rows.reverse()

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
/** A second ref in the same store: every ref read must filter it out. */
const OTHER_REF_HASH_B64 = bytesToBase64(sha256(new TextEncoder().encode('refs/heads/other')))

/** A 32-byte oid, hex, distinct per `seed`. */
function oidHex(seed: number): string {
  return seed.toString(16).padStart(2, '0').repeat(32)
}
function oidB64(seed: number): string {
  return bytesToBase64(new Uint8Array(32).fill(seed))
}

/** A decoy update on a DIFFERENT ref, which every ref read must filter out. */
function otherRefUpdateDoc(i: number): Record<string, unknown> {
  return {
    ...refUpdateDoc(i),
    $id: `x-${String(i).padStart(4, '0')}`,
    refNameHash: OTHER_REF_HASH_B64,
    refName: 'refs/heads/other',
  }
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

/** A decoy event on a DIFFERENT target, which every event read must filter out. */
function otherTargetEventDoc(i: number, kind: number): Record<string, unknown> {
  return { ...eventDoc(i, kind), $id: `z-${String(i).padStart(4, '0')}`, targetId: 'target-2' }
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
    const seen: QueryLike[] = []
    const sdk = paginatingSdk(
      {
        // Interleaved decoys on another ref: a reader that drops its `refNameHash` filter
        // would fold another branch's history into this one.
        [DOC.refUpdate]: [
          ...Array.from({ length: PAGE + 1 }, (_, i) => refUpdateDoc(i)),
          ...Array.from({ length: 5 }, (_, i) => otherRefUpdateDoc(i)),
        ],
        [DOC.protectedRefUpdate]: [],
      },
      seen,
    )

    const updates = await readRefUpdates(sdk, REPO, REF_HASH_B64)

    expect(updates).toHaveLength(PAGE + 1)
    expect(updates.every((u) => u.refName === REF_NAME)).toBe(true)
    expect(updates[updates.length - 1]?.newOid).toBe(oidHex(PAGE))

    // The query SHAPE, not just the row count: the filter must be carried on every page,
    // and page 2 must resume from the last `$id` of page 1 rather than re-reading page 1.
    // Between them sits the boundary-tie read (`$createdAt ==` the last row's), which the
    // tie-safe pager issues after every full page of a `(prefix, $createdAt)` read.
    const refQueries = seen.filter((q) => q.documentTypeName === DOC.refUpdate)
    expect(refQueries).toHaveLength(3)
    expect(refQueries[0]?.where).toEqual([['refNameHash', '==', REF_HASH_B64]])
    expect(refQueries[0]?.startAfter).toBeUndefined()
    expect(refQueries[1]?.where).toEqual([
      ['refNameHash', '==', REF_HASH_B64],
      ['$createdAt', '==', expect.any(Number)],
    ])
    expect(refQueries[2]?.where).toEqual([['refNameHash', '==', REF_HASH_B64]])
    expect(refQueries[2]?.startAfter).toBe(`u-${String(PAGE - 1).padStart(4, '0')}`)
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
  it('reads every event of a target, and only that target', async () => {
    const seen: QueryLike[] = []
    const sdk = paginatingSdk(
      {
        [DOC.event]: [
          ...Array.from({ length: PAGE + 1 }, (_, i) => eventDoc(i, 4)),
          // `foldIssueState` never checks `targetId` itself, so a reader that drops its
          // filter would silently fold another issue's close events into this one.
          ...Array.from({ length: 5 }, (_, i) => otherTargetEventDoc(i, 1)),
        ],
      },
      seen,
    )

    const events = await readEvents(sdk, REPO, 'target-1')

    expect(events).toHaveLength(PAGE + 1)
    expect(events.every((e) => e.targetId === 'target-1')).toBe(true)
    expect(seen.every((q) => q.where?.some(([f, op, v]) => f === 'targetId' && op === '==' && v === 'target-1'))).toBe(true)
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

describe('reviews across a page boundary', () => {
  it('reads every review on a patch, including a verdict past the first page', async () => {
    // `review` is un-gated like `event`, so a verdict can be buried the same way — and the
    // buried one is the one that matters.
    const reviews = Array.from({ length: PAGE + 1 }, (_, i) => ({
      $id: `r-${String(i).padStart(4, '0')}`,
      $ownerId: i === PAGE ? 'maintainer' : 'noise',
      $createdAt: 5_000 + i,
      patchId: 'patch-1',
      verdict: i === PAGE ? 2 : 3,
      commitOid: bytesToBase64(new Uint8Array(20).fill(7)),
      body: i === PAGE ? 'please rename this' : '',
    }))
    const sdk = paginatingSdk({ [DOC.review]: reviews })

    const read = await readReviews(sdk, REPO, 'patch-1')

    expect(read).toHaveLength(PAGE + 1)
    const last = read[read.length - 1]
    expect(last?.verdict).toBe('requestChanges')
    expect(last?.reviewer).toBe('maintainer')
    expect(last?.commitOid).toBe('07'.repeat(20))
  })

  it('keeps an unrecognized verdict code rather than dropping the review', async () => {
    // A document written by a newer client must still appear in the history.
    const sdk = paginatingSdk({
      [DOC.review]: [
        { $id: 'r-1', $ownerId: 'someone', $createdAt: 1, patchId: 'patch-1', verdict: 99 },
      ],
    })

    const read = await readReviews(sdk, REPO, 'patch-1')

    expect(read).toHaveLength(1)
    expect(read[0]?.verdict).toBe('unknown')
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
    const seen: QueryLike[] = []
    const sdk = paginatingSdk({ [DOC.packManifest]: manifests }, seen)

    const read = await readPackManifests(sdk, REPO)

    // Newest-first contract, and — the point — the OLDEST manifest is still present:
    // it is the base pack every incremental pack deltas against, and `packRef` 0.
    expect(read).toHaveLength(PAGE + 1)
    expect(read[0]?.documentId).toBe(`m-${String(PAGE).padStart(4, '0')}`)
    expect(read[read.length - 1]?.documentId).toBe('m-0000')
    // No descending page after a cursor: the proof a protocol-13 node returns for one fails
    // evo-sdk 4.2's verifier, so the newest-first read is paged ascending and reversed.
    expect(seen.length).toBeGreaterThan(1)
    expect(
      seen.filter((q) => q.startAfter !== undefined && q.orderBy?.some(([, d]) => d === 'desc')),
    ).toEqual([])
  })
})

describe('same-block ties at a page boundary (protocol 13)', () => {
  /**
   * PROTOCOL-13 cursor semantics: `startAfter` excludes every row whose `$createdAt` is <=
   * the cursor's, so rows sharing the cursor's timestamp but sorting after it are skipped —
   * the real Drive behaviour. An `==` on `$createdAt` is served normally.
   */
  function protocol13Sdk(rows: Record<string, unknown>[]): EvoSDK {
    return {
      documents: {
        query: (q: QueryLike): Promise<Map<string, unknown>> => {
          let out = [...rows]
          for (const [field, op, value] of q.where ?? []) {
            if (op === '==') out = out.filter((d) => d[field] === value)
          }
          if (q.startAfter !== undefined) {
            const t = rows.find((d) => d['$id'] === q.startAfter)?.['$createdAt'] as number
            out = out.filter((d) => (d['$createdAt'] as number) > t)
          }
          out = out.slice(0, Math.min(q.limit ?? PAGE, PAGE))
          return Promise.resolve(new Map(out.map((d) => [String(d['$id']), d])))
        },
      },
    } as unknown as EvoSDK
  }

  /** 99 rows at distinct times, then `tied` rows in one block, then one more row. */
  function straddlingTie(tied: number): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = Array.from({ length: 99 }, (_, i) => ({
      $id: `r-${String(i).padStart(4, '0')}`,
      $createdAt: i,
    }))
    for (let i = 99; i < 99 + tied; i++) {
      rows.push({ $id: `r-${String(i).padStart(4, '0')}`, $createdAt: 1_000 })
    }
    rows.push({ $id: `r-${String(99 + tied).padStart(4, '0')}`, $createdAt: 2_000 })
    return rows
  }

  const q = { dataContractId: 'c', documentTypeName: 'repoListing', orderBy: [['$createdAt', 'asc']] as const }

  it('recovers the rows the cursor alone would skip, once each and in order', async () => {
    const rows = straddlingTie(3)
    // The mock reproduces the gap: without the tie read, the two tied rows after row 100
    // are lost (paging a range-filtered read skips the probe).
    const lossy = await queryAllDocuments(protocol13Sdk(rows), {
      ...q,
      where: [['$createdAt', '>', -1]] as never,
    })
    expect(lossy).toHaveLength(rows.length - 2)

    const read = await queryAllDocuments(protocol13Sdk(rows), q)
    expect(read.map((d) => d['$id'])).toEqual(rows.map((d) => d['$id']))
  })

  it('refuses a boundary tie of a full page rather than guessing', async () => {
    await expect(queryAllDocuments(protocol13Sdk(straddlingTie(PAGE)), q)).rejects.toThrow(
      IncompleteReadError,
    )
  })

  it('probes only where $createdAt ends the index', () => {
    const base = { dataContractId: 'c', documentTypeName: 'x' }
    expect(tieProbeAllowed({ ...base, orderBy: [['$createdAt', 'asc']] })).toBe(true)
    expect(
      tieProbeAllowed({
        ...base,
        where: [['$ownerId', '==', 'me']],
        orderBy: [
          ['$ownerId', 'asc'],
          ['$createdAt', 'asc'],
        ],
      }),
    ).toBe(true)
    expect(tieProbeAllowed({ ...base, orderBy: [['seq', 'asc']] })).toBe(false)
    expect(tieProbeAllowed({ ...base, orderBy: [['$createdAt', 'desc']] })).toBe(false)
    expect(
      tieProbeAllowed({ ...base, where: [['kind', '>', 1]], orderBy: [['$createdAt', 'asc']] }),
    ).toBe(false)
  })
})

describe('ascendingEquivalent', () => {
  const base = { dataContractId: 'c', documentTypeName: DOC.packManifest }
  it('flips a descending order, leaves an ascending one alone', () => {
    expect(ascendingEquivalent({ ...base, orderBy: [['$createdAt', 'desc']] })).toEqual([
      ['$createdAt', 'asc'],
    ])
    expect(ascendingEquivalent({ ...base, orderBy: [['$createdAt', 'asc']] })).toBeNull()
    expect(ascendingEquivalent(base)).toBeNull()
  })
  it('flips a mixed order only when its ascending fields are pinned by ==', () => {
    const orderBy = [
      ['$ownerId', 'asc'],
      ['$createdAt', 'desc'],
    ] as const
    expect(ascendingEquivalent({ ...base, orderBy, where: [['$ownerId', '==', 'me']] })).toEqual([
      ['$ownerId', 'asc'],
      ['$createdAt', 'asc'],
    ])
    expect(ascendingEquivalent({ ...base, orderBy })).toBeNull()
    expect(ascendingEquivalent({ ...base, orderBy, where: [['$ownerId', '>', 'me']] })).toBeNull()
  })
})

describe('packRef alignment is what completeness protects', () => {
  it('resolves packRef 0 to the OLDEST pack when the manifest list spans pages', async () => {
    // The count assertion above proves the read is complete; this proves the CONSEQUENCE.
    // A locator addresses pack bytes by position in oldest-first order, so a truncated
    // manifest read shifts every index and packRef 0 silently becomes the second-oldest
    // pack — a valid offset in the wrong pack, which nothing downstream can detect.
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
    const ordered = orderGitPacks(read.filter((m) => m.kind === 0))

    // Under a truncated read the oldest manifests fall out and packRef 0 becomes m-0001.
    expect(ordered).toHaveLength(PAGE + 1)
    expect(ordered[0]?.documentId).toBe('m-0000')
    expect(ordered[ordered.length - 1]?.documentId).toBe(`m-${String(PAGE).padStart(4, '0')}`)
  })
})

describe('comment threads across a page boundary', () => {
  it('reads every comment on a target, and only that target', async () => {
    const comments = [
      ...Array.from({ length: PAGE + 1 }, (_, i) => ({
        $id: `c-${String(i).padStart(4, '0')}`,
        $ownerId: 'author',
        $createdAt: 6_000 + i,
        targetId: 'target-1',
        body: `comment ${i}`,
      })),
      { $id: 'zz-1', $ownerId: 'author', $createdAt: 6_500, targetId: 'target-2', body: 'other' },
    ]
    const sdk = paginatingSdk({ [DOC.comment]: comments })

    const read = await readComments(sdk, REPO, 'target-1')

    expect(read).toHaveLength(PAGE + 1)
    expect(read[read.length - 1]?.body).toBe(`comment ${PAGE}`)
    expect(read.some((c) => c.body === 'other')).toBe(false)
  })
})

describe('skip-scan enumeration', () => {
  /** Rows across `n` distinct keys, one row each. */
  function keyed(n: number): Record<string, unknown>[] {
    return Array.from({ length: n }, (_, i) => ({
      $id: `k-${i}`,
      $createdAt: i,
      refNameHash: `key-${String(i).padStart(3, '0')}`,
    }))
  }

  it('enumerates every distinct key when the space fits the cap exactly', async () => {
    // The boundary case: a key space of exactly `maxKeys` IS complete, and must not be
    // mistaken for one that overflowed.
    const sdk = paginatingSdk({ [DOC.refUpdate]: keyed(3) })

    const keys = await skipScanDistinct(sdk, {
      dataContractId: 'c',
      documentTypeName: DOC.refUpdate,
      keyField: 'refNameHash',
      maxKeys: 3,
    })

    expect(keys).toEqual(['key-000', 'key-001', 'key-002'])
  })

  it('throws rather than returning a short key list when the cap is exceeded', async () => {
    const sdk = paginatingSdk({ [DOC.refUpdate]: keyed(4) })

    await expect(
      skipScanDistinct(sdk, {
        dataContractId: 'c',
        documentTypeName: DOC.refUpdate,
        keyField: 'refNameHash',
        maxKeys: 3,
      }),
    ).rejects.toThrow(IncompleteReadError)
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
