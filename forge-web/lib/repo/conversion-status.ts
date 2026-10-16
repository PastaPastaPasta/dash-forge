/**
 * How far making a private repo public got (DESIGN §4.10 steps 2–5, §10 "Progress", "Stalled, to
 * maintainers"), read without signing, by anyone: the repo document, its config timeline and the
 * first and newest rows of its reflogs. Every fact is plaintext: a private-era ref update is
 * stamped `vis: "private"` in the clear, so no key is needed to tell it from one written since.
 *
 * - A repo is **converted** when it is public now with a config stamped `vis: "private"`
 *   (`converted.ts`). Its **conversion marker** is the first config stamped `vis: "public"`
 *   with a block height (step 4).
 * - It is **unfinished** while that marker is missing, or while it had code before the flip
 *   (private-era ref updates) and no plaintext ref update has been written since (step 5).
 *   Readers then show "being made public" where its code would be ({@link beingMadePublicText}).
 * - It **stalled** when unfinished and its newest step is over {@link STALLED_AFTER_MS} old:
 *   maintainers and the owner see {@link stalledText} with a link to Settings → Danger zone, where
 *   any maintainer can finish it.
 *
 * One read per repo is shared by the page's views for {@link PROGRESS_TTL_MS}
 * ({@link conversionProgressCached}); a repo the page's config read already found never made
 * public costs no read at all.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Conversion } from '../private'
import { queryDocuments, type PlainDocument } from '../sdk'
import { timeAgo } from '../view/format'
import { DOC, asIdentifierString, type RepoRef } from './contract'
import { knownConversion, repoConversion } from './converted'
import { blockHeightOf, isSealedDoc } from './private-content'
import { contractOf, readAllRows, repoSource } from './source'

/** How far making a repo public got. Times are ms; null when not known. */
export interface ConversionProgress {
  /** Public now, with a config stamped `vis: "private"`: it was made public (or is being). */
  readonly converted: boolean
  /** When the repo document was last replaced: the flip replaced it (a later edit moves it too). */
  readonly flippedAt: number | null
  /** When the conversion marker (the first public config with a block height) was written; null before step 4. */
  readonly markerAt: number | null
  /** A plaintext ref update stamped `vis: "public"` exists (step 5 started). */
  readonly hasPublicRefs: boolean
  /** A ref update stamped `vis: "private"` exists: the repo had code before the flip. */
  readonly hasPrivateEraRefs: boolean
  /** Converted, and the marker is missing, or code from before the flip has no public ref update yet. */
  readonly unfinished: boolean
  /** When the newest step landed: the seal-off rotation, the flip, the marker, or a public ref update. */
  readonly lastStepAt: number | null
}

/** The progress of a repo never made public. */
export const NOT_CONVERTED: ConversionProgress = {
  converted: false,
  flippedAt: null,
  markerAt: null,
  hasPublicRefs: false,
  hasPrivateEraRefs: false,
  unfinished: false,
  lastStepAt: null,
}

/** How long an unfinished conversion waits before maintainers are told it stalled. */
export const STALLED_AFTER_MS = 10 * 60_000

/** Where a public reader of an unfinished conversion would see the repo's code (DESIGN §10). */
export const beingMadePublicText = "This repo is being made public. Its code appears here when that's done."

/** The stalled banner's sentence, before its "Finish it" link: "Making this repo public stalled 3d ago." */
export function stalledText(lastStepAt: number, now: number = Date.now()): string {
  return `Making this repo public stalled ${timeAgo(lastStepAt, now)}.`
}

/** The stalled banner's link text, to Settings → Danger zone. */
export const FINISH_IT = 'Finish it'

/** Whether a newest step that landed at `lastStepAt` is over {@link STALLED_AFTER_MS} old at `now`. */
export function stepStalled(lastStepAt: number | null, now: number = Date.now()): lastStepAt is number {
  return lastStepAt !== null && now - lastStepAt > STALLED_AFTER_MS
}

/** Whether `p` is unfinished and its newest step is over {@link STALLED_AFTER_MS} old at `now`. */
export function isStalled(p: ConversionProgress, now: number = Date.now()): p is ConversionProgress & { readonly lastStepAt: number } {
  return p.unfinished && stepStalled(p.lastStepAt, now)
}

/** `v` (a `$createdAt` or `$updatedAt`, ms) when it is a time, else null. */
export function positiveAt(v: unknown): number | null {
  return typeof v === 'number' && v > 0 ? v : null
}

/** When `d` was created (ms), or null. */
export function createdAtOf(d: PlainDocument): number | null {
  return positiveAt(d['$createdAt'])
}

/** The latest of `ats` (ms), ignoring the unknown; null when none is known. */
export function newestAt(...ats: readonly (number | null | undefined)[]): number | null {
  const known = ats.filter((a): a is number => typeof a === 'number' && a > 0)
  return known.length === 0 ? null : Math.max(...known)
}

/** When the conversion marker was written (ms): the first public config with `conversion`'s block height; null before step 4. */
export function markerAtOf(configs: readonly PlainDocument[], conversion: Conversion): number | null {
  if (conversion.markerHeight === null) return null
  const marker = configs.find((c) => c['vis'] !== 'private' && blockHeightOf(c) === conversion.markerHeight)
  return marker === undefined ? null : createdAtOf(marker)
}

/** A ref update written since the flip in plain text (a members-only one is sealed). */
const publicRef = (d: PlainDocument): boolean => d['vis'] === 'public' && !isSealedDoc(d)

/** What {@link progressOf} reads. */
export interface ProgressRows {
  /** Every config of the repo. */
  readonly configs: readonly PlainDocument[]
  /** The repo document, when it was read. */
  readonly repoDoc: PlainDocument | null
  /**
   * The repo's ref updates (both types) as read: at least the oldest of each type and a page of
   * the newest. Private-era updates all come before any written since the flip.
   */
  readonly refs: readonly PlainDocument[]
}

/** {@link ConversionProgress} of public `repo` from what was read (pure). */
export function progressOf(repo: RepoRef, rows: ProgressRows): ConversionProgress {
  const conversion = repo.visibility === 'public' ? repoConversion(repo, rows.configs) : null
  if (conversion === null) return NOT_CONVERTED
  const markerAt = markerAtOf(rows.configs, conversion)
  const flippedAt = positiveAt(rows.repoDoc?.['$updatedAt'])
  const publicRefs = rows.refs.filter(publicRef)
  const hasPublicRefs = publicRefs.length > 0
  const hasPrivateEraRefs = rows.refs.some((d) => d['vis'] === 'private')
  const sealOff = newestAt(...rows.configs.filter((c) => c['vis'] === 'private').map(createdAtOf))
  const lastStepAt = newestAt(sealOff, flippedAt, markerAt, ...publicRefs.map(createdAtOf))
  return {
    converted: true,
    flippedAt,
    markerAt,
    hasPublicRefs,
    hasPrivateEraRefs,
    unfinished: conversion.markerHeight === null || (hasPrivateEraRefs && !hasPublicRefs),
    lastStepAt,
  }
}

/** Rows of the newest ref updates read for {@link conversionProgress} (members-only pushes since may come first). */
export const NEWEST_REFS = 20

/** One reflog end of `repo`'s `type` ref updates: the oldest row, or a page of the newest. */
function reflogEnd(sdk: EvoSDK, repo: RepoRef, type: string, end: 'oldest' | 'newest'): Promise<PlainDocument[]> {
  // The `reflog` index (`repoId`, `$createdAt`). A range makes Drive walk it newest first.
  const shape =
    end === 'oldest'
      ? { orderBy: [['$createdAt', 'asc'] as const], limit: 1 }
      : { where: [['$createdAt', '>', 0] as const], orderBy: [['$createdAt', 'desc'] as const], limit: NEWEST_REFS }
  return queryDocuments(sdk, repoSource(repo).repoQuery(type, shape))
}

/**
 * {@link ConversionProgress} of `repo`, read now (module docs). A private repo, and a public one
 * the page's config read found never made public, cost no read.
 */
export async function conversionProgress(sdk: EvoSDK, repo: RepoRef): Promise<ConversionProgress> {
  if (repo.visibility !== 'public' || knownConversion(repo.repoId) === null) return NOT_CONVERTED
  const configs = await readAllRows(sdk, repo, DOC.config)
  if (repoConversion(repo, configs) === null) return NOT_CONVERTED
  const [repoDoc, ...refPages] = await Promise.all([
    queryDocuments(sdk, { dataContractId: contractOf(repo.forge, DOC.repo), documentTypeName: DOC.repo, where: [['$id', '==', repo.repoId]], limit: 1 }).then(
      (docs) => docs.find((d) => asIdentifierString(d['$id']) === repo.repoId) ?? null,
    ),
    ...[DOC.refUpdate, DOC.protectedRefUpdate].flatMap((type) => [reflogEnd(sdk, repo, type, 'oldest'), reflogEnd(sdk, repo, type, 'newest')]),
  ])
  return progressOf(repo, { configs, repoDoc: repoDoc as PlainDocument | null, refs: (refPages as PlainDocument[][]).flat() })
}

/** How long one read of a repo's progress serves the page's views. */
export const PROGRESS_TTL_MS = 60_000

const cache = new Map<string, { readonly at: number; readonly promise: Promise<ConversionProgress> }>()

/** {@link conversionProgress}, shared by the page's views for {@link PROGRESS_TTL_MS}; a failed read is not kept. */
export function conversionProgressCached(sdk: EvoSDK, repo: RepoRef): Promise<ConversionProgress> {
  const key = `${repo.forge.core}:${repo.repoId}`
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.at < PROGRESS_TTL_MS) return hit.promise
  const promise = conversionProgress(sdk, repo)
  cache.set(key, { at: Date.now(), promise })
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key)
  })
  return promise
}

/** Forget what was read of `repo`'s progress (a step of it was just written: read it again). */
export function forgetConversionProgress(repo: Pick<RepoRef, 'repoId'>): void {
  for (const k of [...cache.keys()]) if (k.endsWith(`:${repo.repoId}`)) cache.delete(k)
}
