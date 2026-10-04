/**
 * Reading long bodies (`docs/contracts/forge-v2.md` §6.3): a field longer than 5,120 bytes holds
 * its first part and a trailer naming a kind-6 artifact with the full text. A page that shows a
 * body reads the artifact (its copies by `(repoId, packHash)`, the pack reader rule's order, the
 * bytes from Platform chunks or the writer's storage, opened in a private repo) and shows the
 * whole text; when that fails it shows the first part and says why. Parity: forge-core
 * `Collab::read_long_bodies`. The rule is `lib/rules/long-body.ts`; writing is
 * `lib/repo/long-body.ts`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { PACK_KIND } from '../constants'
import { repoKey, type RepoRef } from '../repo/contract'
import { sealedLength } from '../private/pack'
import { readPackCopies, type PackManifest } from '../repo/packs'
import { openLongBodyText, parseLongBody, type LongBodyState } from '../rules/long-body'
import { loadArtifactBytes } from './browse-source'

export type { LongBodyState }

/** A field as a reader shows it: the text, and its long-body state (absent for a plain field). */
export interface BodyRead {
  readonly text: string
  readonly long?: LongBodyState
}

/** The size cap a copy may claim before it is fetched: the text's own length, or sealed (§3). */
function sizeCap(repo: RepoRef, bytes: number): number {
  // a §3 header and a tag per segment at the smallest segment size a reader accepts (1 KiB)
  return repo.visibility === 'private' ? sealedLength(bytes, 10) : bytes
}

/** Full texts read this session, by repo (and private session), artifact hash and length: the newest few. */
const texts = new Map<string, Promise<string>>()
/** How many full texts are kept (each at most 256 KiB). */
const KEPT_TEXTS = 32

async function fetchText(sdk: EvoSDK, repo: RepoRef, sha256: string, bytes: number): Promise<string> {
  const pack = await readPackCopies(sdk, repo, sha256, PACK_KIND.LONG_BODY, true)
  const cap = sizeCap(repo, bytes)
  const fits = (m: PackManifest): boolean => (repo.visibility === 'private' ? m.sizeBytes <= cap : m.sizeBytes === cap)
  const copies = (pack?.copies ?? []).filter(fits)
  const first = copies[0]
  if (pack === null || first === undefined) throw new Error('no copy of it is recorded')
  // Each copy is tried in the reader rule's order, its bytes checked against the hash (or opened
  // with this session's keys); the first that serves them is the text.
  const plain = await loadArtifactBytes(sdk, repo, { ...first, copies })
  const opened = openLongBodyText(bytes, plain)
  if (!opened.ok) throw new Error(opened.error === 'size' ? 'it is not the length its field says' : 'it is not UTF-8 text')
  return opened.text
}

/**
 * The full text `sha256` names, read once per session (a failure is not kept: a reload retries).
 * Keyed by the trailer's `bytes` too, so a field claiming another length is checked on its own.
 */
function cachedText(sdk: EvoSDK, repo: RepoRef, sha256: string, bytes: number): Promise<string> {
  const key = `${repoKey(repo)}:${sha256}:${bytes}`
  let p = texts.get(key)
  if (p === undefined) {
    p = fetchText(sdk, repo, sha256, bytes)
    texts.set(key, p)
    p.catch(() => texts.delete(key))
    // the oldest first out (a Map iterates in insertion order)
    for (const old of texts.keys()) {
      if (texts.size <= KEPT_TEXTS) break
      texts.delete(old)
    }
  }
  return p
}

/** `stored` (a field as read: opened, in a private repo) as a reader shows it. */
export async function readLongBody(sdk: EvoSDK, repo: RepoRef, stored: string): Promise<BodyRead> {
  const parsed = parseLongBody(stored)
  switch (parsed.kind) {
    case 'plain':
      return { text: stored }
    case 'unsupported':
      return { text: parsed.prefix, long: { bytes: null, incomplete: 'the rest is stored in a form this version of the app cannot read', field: stored } }
    case 'continued':
      try {
        return { text: await cachedText(sdk, repo, parsed.sha256, parsed.bytes), long: { bytes: parsed.bytes, incomplete: null, field: stored } }
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        return { text: parsed.prefix, long: { bytes: parsed.bytes, incomplete: `the full text could not be read: ${why}`, field: stored } }
      }
  }
}

/** `item` with its `body` as a reader shows it ({@link readLongBody}) and its `long` state. */
export async function withLongBody<T extends { readonly body: string }>(
  sdk: EvoSDK,
  repo: RepoRef,
  item: T,
): Promise<T & { readonly long?: LongBodyState }> {
  if (parseLongBody(item.body).kind === 'plain') return item
  const read = await readLongBody(sdk, repo, item.body)
  return { ...item, body: read.text, ...(read.long ? { long: read.long } : {}) }
}

/**
 * `items` with each `body` as a reader shows it ({@link readLongBody}) and its `long` state,
 * read side by side. A field without a trailer reads nothing, so a page with no long body pays
 * no request for this.
 */
export async function withLongBodies<T extends { readonly body: string }>(
  sdk: EvoSDK,
  repo: RepoRef,
  items: readonly T[],
): Promise<(T & { readonly long?: LongBodyState })[]> {
  return Promise.all(items.map((item) => withLongBody(sdk, repo, item)))
}
