/**
 * Offline replay (never gates CI): Blame and a path's History on a real repository, with and
 * without the push-time history index (v2), over the pack, object locator and index that
 * forge-core's `export_a_replay_fixture` wrote from a local clone:
 *
 *   HISTORY_REPLAY_REPO=~/dash HISTORY_REPLAY_TIP=3ba0805c HISTORY_REPLAY_OUT=/tmp/replay \
 *     cargo test -p forge-core --lib export_a_replay_fixture -- --ignored
 *   FORGE_REPLAY_DIR=/tmp/replay pnpm exec vitest run lib/view/history-replay.test.ts
 *
 * The pack is read as the browser reads a Platform-stored pack (`fetchPlatformRange`): 14,700-byte
 * chunk documents, one query per batch of at most 100 missing chunks, a 32 MiB chunk cache. Each
 * query waits `FORGE_REPLAY_LATENCY_MS` (default 280 ms, the dash baseline's 121 s over 427
 * requests). Every object is hash-checked by the real `BrowseReader`, and Blame's answer with the
 * index must equal its answer without. `FORGE_REPLAY_BLAME` / `FORGE_REPLAY_HISTORY` name the
 * paths (default: dash's `src/clientversion.h` and `src/validation.cpp`).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { BrowseReader, ObjectLocator, type PackSource } from '../browse'
import type { PackManifest } from '../repo'
import { blameFile } from './blame'
import { attachHistory, historySource } from './history-source'
import { pathVersions } from './path-history'

const env = process.env
const DIR = env['FORGE_REPLAY_DIR']
const LATENCY = Number(env['FORGE_REPLAY_LATENCY_MS'] ?? '280')
const BLAME_PATH = env['FORGE_REPLAY_BLAME'] ?? 'src/clientversion.h'
const HISTORY_PATH = env['FORGE_REPLAY_HISTORY'] ?? 'src/validation.cpp'
/** forge-core `DOC_PAYLOAD_MAX`, the web's `CHUNK_PAYLOAD_MAX`. */
const CHUNK = 14_700
/** Rows one chunk query returns (`CHUNK_QUERY_MAX`). */
const QUERY_MAX = 100
/** The browser's chunk cache (`CHUNK_CACHE_BUDGET_BYTES`). */
const CACHE_CHUNKS = Math.floor((32 * 1024 * 1024) / CHUNK)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Queries and bytes one scenario made. */
class Meter {
  queries = 0
  chunks = 0
  /** A query of `n` chunks. */
  async query(n: number): Promise<void> {
    this.queries++
    this.chunks += n
    if (LATENCY > 0) await sleep(LATENCY)
  }
}

/** The pack as a Platform-stored artifact: chunk queries, batched and cached as the browser does. */
function platformSource(pack: Uint8Array, meter: Meter): PackSource {
  // Chunks held or in flight, least recently used first: a read waits on a chunk another read
  // is already fetching, as `fetchPlatformRange`'s cache of promises does.
  const cache = new Map<number, Promise<void>>()
  return {
    async fetchRange(_ref, start, end) {
      const held: Promise<void>[] = []
      const missing: number[] = []
      for (let s = Math.floor(start / CHUNK); s <= Math.floor((end - 1) / CHUNK); s++) {
        const hit = cache.get(s)
        if (hit !== undefined) {
          cache.delete(s)
          cache.set(s, hit)
          held.push(hit)
        } else missing.push(s)
      }
      for (let i = 0; i < missing.length; i += QUERY_MAX) {
        const batch = missing.slice(i, i + QUERY_MAX)
        const q = meter.query(batch.length)
        for (const s of batch) cache.set(s, q)
        held.push(q)
      }
      for (const k of cache.keys()) {
        if (cache.size <= CACHE_CHUNKS) break
        cache.delete(k)
      }
      await Promise.all(held)
      return pack.subarray(start, end)
    },
    sizeOf: () => pack.length,
  }
}

interface Replay {
  readonly reader: BrowseReader
  readonly meter: Meter
  readonly tip: string
}

/** The fixture's files, read once. */
let files: { pack: Uint8Array; locator: Uint8Array; history: Uint8Array; tip: string } | undefined
function fixture(): NonNullable<typeof files> {
  const dir = DIR as string
  files ??= {
    pack: readFileSync(join(dir, 'pack.pack')),
    locator: readFileSync(join(dir, 'locator.bin')),
    history: readFileSync(join(dir, 'history.gz')),
    tip: readFileSync(join(dir, 'tip.txt'), 'utf8').trim(),
  }
  return files
}

/** A fresh browser session over the fixture: an empty chunk cache and memos, and optionally the index. */
function session(withIndex: boolean): Replay {
  const { pack, locator, history: bytes, tip } = fixture()
  const meter = new Meter()
  const reader = new BrowseReader(ObjectLocator.parse(locator), platformSource(pack, meter))
  if (withIndex) {
    const manifest = {
      packHash: bytesToHex(sha256(bytes)),
      kind: 3,
      sizeBytes: bytes.length,
      objectCount: 0,
      chunkCount: Math.ceil(bytes.length / CHUNK),
      storage: 0,
      uris: [],
      tips: [tip],
      supersedes: [],
      createdAt: 1,
      documentId: 'history',
      uploader: 'owner',
      ownerRole: 'maintainer',
    } as unknown as PackManifest
    // The whole artifact in 100-chunk windows (`loadPlatformWhole`).
    const fetch = async (): Promise<Uint8Array> => {
      const chunks = Math.ceil(bytes.length / CHUNK)
      await Promise.all(Array.from({ length: Math.ceil(chunks / QUERY_MAX) }, (_, i) => meter.query(Math.min(QUERY_MAX, chunks - i * QUERY_MAX))))
      return bytes
    }
    attachHistory(reader.memoScope, historySource([manifest], fetch))
  }
  return { reader, meter, tip }
}

const report = (label: string, r: Replay, ms: number, extra: Record<string, unknown>): void => {
  // The numbers are the point of this run: printed for docs/guides/costs.md and the PR.
  // eslint-disable-next-line no-console
  console.log(`REPLAY ${JSON.stringify({ label, queries: r.meter.queries, chunks: r.meter.chunks, ms: Math.round(ms), latencyMs: LATENCY, ...extra })}`)
}

describe.skipIf(DIR === undefined)('history index replay (offline, a real repository)', () => {
  it(
    `blames ${BLAME_PATH} with and without the index, to the same answer`,
    async () => {
      const before = session(false)
      let t = performance.now()
      const plain = await blameFile(before.reader, before.tip, BLAME_PATH)
      report('blame-walk', before, performance.now() - t, { versions: plain.versions, partial: plain.partial, commits: plain.commits.size })

      const after = session(true)
      t = performance.now()
      const indexed = await blameFile(after.reader, after.tip, BLAME_PATH)
      report('blame-index', after, performance.now() - t, { versions: indexed.versions, partial: indexed.partial, commits: indexed.commits.size })

      expect(indexed.hunks).toEqual(plain.hunks)
      expect(indexed.partial).toBe(plain.partial)
      expect(after.meter.queries).toBeLessThan(before.meter.queries)
    },
    3_600_000,
  )

  it(
    `lists the first History page of ${HISTORY_PATH} with and without the index, to the same answer`,
    async () => {
      const before = session(false)
      let t = performance.now()
      const plain = await pathVersions(before.reader, before.tip, HISTORY_PATH)
      report('history-walk', before, performance.now() - t, { entries: plain.entries.length, examined: plain.examined })

      const after = session(true)
      t = performance.now()
      const indexed = await pathVersions(after.reader, after.tip, HISTORY_PATH)
      report('history-index', after, performance.now() - t, { entries: indexed.entries.length, indexed: indexed.indexed })

      expect(indexed.entries.map((e) => e.oid)).toEqual(plain.entries.map((e) => e.oid))
      expect(indexed.entries.map((e) => [e.subject, e.author.name, e.author.when])).toEqual(plain.entries.map((e) => [e.subject, e.author.name, e.author.when]))
      expect(indexed.indexed).toBe(indexed.entries.length)
    },
    3_600_000,
  )
})
