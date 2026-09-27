/**
 * Cross-repo "mine" reads (`ux-dx-spec.md` §5.10, §5.11): what one identity authored, starred
 * or belongs to, across every forge-v2 repo. Only what an index proves is read:
 *
 * - issues / PRs I opened: `issue.author` / `patch.author` = `($ownerId, repoId, number)`, so
 *   `$ownerId ==` alone walks every repo (index prefix), ordered `(repoId, number)`;
 * - threads I commented on: `comment.author` = `($ownerId, $createdAt)`, newest first;
 * - stars: `star.byOwner` (`indexOnly`, no `$createdAt`: index order, no star time);
 * - repo rows for all of these: `repo` by `$id in` (one query per 100 ids).
 *
 * Not indexable and so never claimed complete: releases across repos (`release` indexes lead
 * with `repoId`), assignments (an `event` with kind assign and a value, indexed by repo and
 * target, not by assignee) and mentions (free text). {@link scanAssignedAndMentions} computes
 * those over a bounded set of repos the caller already watches.
 *
 * Documents are parsed with zod here, at the trust boundary; nothing downstream casts.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { z } from 'zod'

import type { ForgeIds } from '../deployments'
import { DOC, asIdentifierString } from '../repo/contract'
import { queryDocumentsWithProof, type DocumentQuery, type PlainDocument } from '../sdk'
import type { DiscoveredRepo } from './discovery'
import { mapPooled } from './pool'
import { compareStrings } from '../rules'

/** A base58 identifier field (identifiers come back base58 or base64; both normalize). */
export const ident = z.unknown().transform(asIdentifierString).pipe(z.string().min(1))
/** A content integer (number from `toJSON`, bigint from `toObject`). */
export const int = z.union([z.number(), z.bigint()]).transform(Number)
const text = z.string().optional().catch(undefined)

/** The fields of a forge document every reader here needs. */
export const baseDoc = z.object({ $id: z.string().min(1), $ownerId: z.string().min(1), $createdAt: z.number() })

/** An `issue` or `patch` row. */
export const targetDoc = baseDoc.extend({ repoId: ident, number: int, title: text, body: text, enc: z.unknown().optional() })
export type TargetDoc = z.infer<typeof targetDoc>

/** A `repo` row. */
const repoDoc = baseDoc.extend({ name: z.string().min(1), visibility: z.string().optional() })

/** Parse every document that fits `schema`; drop (never cast) the rest. */
export function parseDocs<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, docs: readonly PlainDocument[]): T[] {
  const out: T[] = []
  for (const d of docs) {
    const r = schema.safeParse(d)
    if (r.success) out.push(r.data)
  }
  return out
}

async function read(sdk: EvoSDK, q: DocumentQuery): Promise<PlainDocument[]> {
  return (await queryDocumentsWithProof(sdk, q)).documents
}

/** A repo as the cross-repo lists link to it. */
export interface RepoLite {
  readonly id: string
  readonly ownerId: string
  readonly name: string
  readonly private: boolean
}

/** A discovery row as the cross-repo lists link to it. */
export function repoLite(r: DiscoveredRepo): RepoLite {
  return { id: r.key, ownerId: r.ownerId, name: r.slug, private: r.visibility === 'private' }
}

/** The `$id in` batch size: Platform caps an `in` list and a page at 100. */
const IN_MAX = 100

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** `repo` rows by id (missing ids are simply absent from the map). */
export async function readReposByIds(sdk: EvoSDK, forge: ForgeIds, ids: readonly string[]): Promise<Map<string, RepoLite>> {
  const unique = [...new Set(ids.filter((id) => id !== ''))]
  const out = new Map<string, RepoLite>()
  for (const batch of chunks(unique, IN_MAX)) {
    const docs = await read(sdk, {
      dataContractId: forge.core,
      documentTypeName: DOC.repo,
      where: [['$id', 'in', batch]],
      limit: batch.length,
    })
    for (const d of parseDocs(repoDoc, docs)) {
      out.set(d.$id, { id: d.$id, ownerId: d.$ownerId, name: d.name, private: d.visibility === 'private' })
    }
  }
  return out
}

/** An issue or PR, with its repo when that resolved. */
export interface TargetRow {
  readonly id: string
  readonly kind: 'issue' | 'pull'
  readonly repoId: string
  readonly number: number
  readonly title: string
  readonly author: string
  readonly createdAt: number
  readonly repo: RepoLite | null
}

/** A row's title; a private repo's ciphertext says so rather than showing nothing. */
export function titleOf(d: TargetDoc): string {
  if (d.title) return d.title
  return d.enc != null ? 'Encrypted (not readable here)' : '(untitled)'
}

/** A page that may have been cut short: `more` says a full page came back. */
export interface Page<T> {
  readonly rows: T[]
  readonly more: boolean
}

/** How many of my issues (or PRs) are read at most; past it the list says it is partial. */
export const MY_TARGETS_MAX = 500

/**
 * Issues (`kind: 'issue'`) or PRs I opened, in every repo, newest first. The `author` index
 * (`$ownerId` prefix) is ordered by `(repoId, number)`, not by time, so "newest first" needs
 * all of them: it is paged (`startAfter`) up to `max`. `more` is true when that cap was hit,
 * so the caller says the list is partial instead of implying completeness.
 */
export async function listMyTargets(
  sdk: EvoSDK,
  forge: ForgeIds,
  me: string,
  kind: 'issue' | 'pull',
  max = MY_TARGETS_MAX,
): Promise<Page<TargetRow>> {
  const raw: PlainDocument[] = []
  let startAfter: string | undefined
  let more = false
  while (raw.length < max) {
    const page = await read(sdk, {
      dataContractId: forge.collab,
      documentTypeName: kind === 'issue' ? DOC.issue : DOC.patch,
      where: [['$ownerId', '==', me]],
      orderBy: [
        ['repoId', 'asc'],
        ['number', 'asc'],
      ],
      limit: IN_MAX,
      ...(startAfter === undefined ? {} : { startAfter }),
    })
    raw.push(...page)
    const last = page[page.length - 1]?.['$id']
    if (page.length < IN_MAX || typeof last !== 'string') break
    startAfter = last
    more = raw.length >= max
  }
  const docs = parseDocs(targetDoc, raw)
  const repos = await readReposByIds(sdk, forge, docs.map((d) => d.repoId))
  const rows = docs
    .map((d) => ({
      id: d.$id,
      kind,
      repoId: d.repoId,
      number: d.number,
      title: titleOf(d),
      author: d.$ownerId,
      createdAt: d.$createdAt,
      repo: repos.get(d.repoId) ?? null,
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
  return { rows, more }
}

const commentDoc = baseDoc.extend({ repoId: ident, targetId: ident })

/** A thread I commented on: the target, its repo, and my first comment there (in the page). */
export interface CommentedTarget {
  readonly targetId: string
  readonly repoId: string
  readonly firstAt: number
}

/** The threads of my newest comments (`comment.author`, `$createdAt` descending). */
export async function listMyCommentTargets(sdk: EvoSDK, forge: ForgeIds, me: string, limit = IN_MAX): Promise<CommentedTarget[]> {
  const docs = parseDocs(
    commentDoc,
    await read(sdk, {
      dataContractId: forge.collab,
      documentTypeName: DOC.comment,
      where: [['$ownerId', '==', me]],
      orderBy: [['$createdAt', 'desc']],
      limit,
    }),
  )
  const byTarget = new Map<string, CommentedTarget>()
  for (const d of docs) {
    const prev = byTarget.get(d.targetId)
    if (prev === undefined || d.$createdAt < prev.firstAt) {
      byTarget.set(d.targetId, { targetId: d.targetId, repoId: d.repoId, firstAt: d.$createdAt })
    }
  }
  return [...byTarget.values()]
}

/** `issue` / `patch` rows by id, each tagged with the type it was found in. */
export async function readTargetsByIds(sdk: EvoSDK, forge: ForgeIds, ids: readonly string[]): Promise<Map<string, TargetRow>> {
  const out = new Map<string, TargetRow>()
  const unique = [...new Set(ids)]
  for (const kind of ['issue', 'pull'] as const) {
    for (const batch of chunks(unique.filter((id) => !out.has(id)), IN_MAX)) {
      const docs = parseDocs(
        targetDoc,
        await read(sdk, {
          dataContractId: forge.collab,
          documentTypeName: kind === 'issue' ? DOC.issue : DOC.patch,
          where: [['$id', 'in', batch]],
          limit: batch.length,
        }),
      )
      for (const d of docs) {
        out.set(d.$id, {
          id: d.$id,
          kind,
          repoId: d.repoId,
          number: d.number,
          title: titleOf(d),
          author: d.$ownerId,
          createdAt: d.$createdAt,
          repo: null,
        })
      }
    }
  }
  return out
}

const starDoc = z.object({ repoId: ident })

/** The repos I starred (`star.byOwner`; index order, and a star records no time). */
export async function listStarredRepoIds(sdk: EvoSDK, forge: ForgeIds, me: string, limit = IN_MAX): Promise<Page<string>> {
  const docs = await read(sdk, {
    dataContractId: forge.collab,
    documentTypeName: DOC.star,
    where: [['$ownerId', '==', me]],
    limit,
  })
  return { rows: parseDocs(starDoc, docs).map((d) => d.repoId), more: docs.length >= limit }
}

/** A release, for the Explore "Recently released" row. */
export interface ReleaseRow {
  readonly repo: RepoLite
  readonly tagName: string
  readonly name: string
  readonly createdAt: number
}

const releaseDoc = baseDoc.extend({ tagName: z.string().min(1), name: text })

/** A scan over several repos: what it found, and how many repos could not be read. */
export interface Scan<T> {
  readonly rows: T[]
  /** Repos whose read failed: the rows cover the others only. */
  readonly failed: number
  readonly total: number
}

/**
 * Read `fn` for every repo, `concurrency` at a time, counting failures instead of turning them
 * into empty answers. Every repo failing (with at least one repo) is an error.
 */
async function perRepo<T>(repos: readonly RepoLite[], concurrency: number, fn: (repo: RepoLite) => Promise<T>): Promise<{ ok: T[]; failed: number }> {
  let lastError: unknown = null
  const results = await mapPooled(repos, concurrency, (repo) =>
    fn(repo).then(
      (v) => ({ v }),
      (e: unknown) => {
        lastError = e
        return null
      },
    ),
  )
  const ok = results.filter((r): r is { v: Awaited<T> } => r !== null).map((r) => r.v)
  const failed = results.length - ok.length
  if (repos.length > 0 && ok.length === 0) throw lastError instanceof Error ? lastError : new Error('no repo could be read')
  return { ok, failed }
}

/**
 * The newest release of each of `repos` (`release.created` = `(repoId, $createdAt)`, one query
 * per repo, 4 at a time), newest first. There is no cross-repo release index, so this only
 * sees the repos passed in; the caller says so, and says how many could not be read.
 */
export async function latestReleases(sdk: EvoSDK, forge: ForgeIds, repos: readonly RepoLite[]): Promise<Scan<ReleaseRow>> {
  const { ok, failed } = await perRepo(repos, 4, async (repo) => {
    const docs = await read(sdk, {
      dataContractId: forge.core,
      documentTypeName: DOC.release,
      where: [['repoId', '==', repo.id]],
      orderBy: [['$createdAt', 'desc']],
      limit: 1,
    })
    const d = parseDocs(releaseDoc, docs)[0]
    return d ? { repo, tagName: d.tagName, name: d.name ?? '', createdAt: d.$createdAt } : null
  })
  const rows = ok.filter((r): r is ReleaseRow => r !== null).sort((a, b) => b.createdAt - a.createdAt)
  return { rows, failed, total: repos.length }
}

/** Whether `body` mentions `@name` (DPNS label, case-insensitive) or the identity id. */
export function mentions(body: string | undefined, me: string, name: string | null): boolean {
  if (!body) return false
  if (body.includes(me)) return true
  if (name === null || name === '') return false
  const label = name.split('.')[0] ?? ''
  if (label === '') return false
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w@])@${escaped}(?![\\w-])`, 'i').test(body)
}

/** An `event` / `authorEvent` row (`value` only on label / assign kinds). */
export const eventDoc = baseDoc.extend({ targetId: ident, kind: int, value: z.string().optional().catch(undefined) })

/** Assign (6) and unassign (7): `event.kind` codes (data-contracts §2.3). */
const ASSIGN = 6
const UNASSIGN = 7

/**
 * Fold assign / unassign events (oldest first) into the targets `me` is assigned to now.
 * Pure; the events must be the complete window being judged.
 */
export function assignedTargets(events: readonly { $id: string; targetId: string; kind: number; value?: string; $createdAt: number }[], me: string): Set<string> {
  const assigned = new Set<string>()
  // The fold order is ($createdAt, $id), by code point (forge-v2.md §3), as the issue fold.
  const ordered = [...events].sort((a, b) => a.$createdAt - b.$createdAt || compareStrings(a.$id, b.$id))
  for (const e of ordered) {
    if (e.value !== me) continue
    if (e.kind === ASSIGN) assigned.add(e.targetId)
    else if (e.kind === UNASSIGN) assigned.delete(e.targetId)
  }
  return assigned
}

/** What {@link scanAssignedAndMentions} found, and over how much it looked. */
export interface AssignedScan {
  readonly assigned: TargetRow[]
  readonly mentioned: TargetRow[]
  readonly reposScanned: number
  /** Repos whose activity could not be read. */
  readonly failed: number
}

/**
 * Issues and PRs assigned to me or mentioning me, **within the newest activity of `repos`**
 * only: per repo, the newest 100 member `event`s and the newest 30 issues and 30 PRs. Mentions
 * are looked for in issue and PR descriptions only, not in comments. Neither question has an
 * index, so this is a bounded scan the caller must present as one.
 */
export async function scanAssignedAndMentions(
  sdk: EvoSDK,
  forge: ForgeIds,
  me: string,
  name: string | null,
  repos: readonly RepoLite[],
): Promise<AssignedScan> {
  const { ok: scanned, failed } = await perRepo(repos, 3, async (repo) => {
    const feed = (type: string, limit: number): Promise<PlainDocument[]> =>
      read(sdk, {
        dataContractId: forge.collab,
        documentTypeName: type,
        where: [['repoId', '==', repo.id]],
        orderBy: [['$createdAt', 'desc']],
        limit,
      })
    const [events, issues, patches] = await Promise.all([feed(DOC.event, 100), feed(DOC.issue, 30), feed(DOC.patch, 30)])
    const mentioned = (docs: PlainDocument[], kind: 'issue' | 'pull'): TargetRow[] =>
      parseDocs(targetDoc, docs)
        .filter((d) => d.$ownerId !== me && mentions(d.body, me, name))
        .map((d) => ({ id: d.$id, kind, repoId: repo.id, number: d.number, title: titleOf(d), author: d.$ownerId, createdAt: d.$createdAt, repo }))
    return {
      assignedIds: [...assignedTargets(parseDocs(eventDoc, events), me)],
      mentioned: [...mentioned(issues, 'issue'), ...mentioned(patches, 'pull')],
      repo,
    }
  })
  const repoOf = new Map(scanned.map((r) => [r.repo.id, r.repo]))
  // Assignments in ANY repo, from the sparse `event.addressee (refId)` index: an assign names
  // the assignee in `refId` since F-1 (platform-parity-spec §1.2). Only member events can be
  // assign kinds, and only those carrying `refId` are indexed, so this is a small read.
  const addressed = await read(sdk, {
    dataContractId: forge.collab,
    documentTypeName: DOC.event,
    where: [['refId', '==', me]],
    orderBy: [['refId', 'asc']],
    limit: 100,
  }).catch(() => [] as PlainDocument[])
  const indexed = parseDocs(eventDoc, addressed).filter((e) => e.kind === ASSIGN || e.kind === UNASSIGN)
  const fromIndex = assignedTargets(indexed, me)
  // The per-repo scan also sees older assigns written without `refId`. A target the index
  // folds as unassigned was unassigned by a newer, indexed event: drop it from the scan's set.
  const unassigned = new Set(indexed.map((e) => e.targetId).filter((t) => !fromIndex.has(t)))
  const scannedIds = scanned.flatMap((r) => r.assignedIds).filter((t) => !unassigned.has(t))
  const assignedRows = await readTargetsByIds(sdk, forge, [...new Set([...scannedIds, ...fromIndex])])
  const newestFirst = (a: TargetRow, b: TargetRow): number => b.createdAt - a.createdAt
  return {
    assigned: [...assignedRows.values()].map((t) => ({ ...t, repo: repoOf.get(t.repoId) ?? null })).sort(newestFirst),
    mentioned: scanned.flatMap((r) => r.mentioned).sort(newestFirst),
    reposScanned: repos.length,
    failed,
  }
}
