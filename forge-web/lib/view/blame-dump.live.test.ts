/**
 * Live helper (never gates CI): write each version of a file blame compared, from a showcase repo
 * (the showcase mirrors are on moutai and not yet re-created on bonsia), to FORGE_DUMP_DIR as
 * `<n>-<commit>.txt` (newest first), for comparing the line alignment with git's offline.
 *
 *   FORGE_LIVE=1 FORGE_DUMP_OWNER=… FORGE_DUMP_NAME=dash FORGE_DUMP_PATH=src/qt/dashstrings.cpp \
 *   FORGE_DUMP_DIR=/tmp/x NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=bonsia \
 *     pnpm exec vitest run lib/view/blame-dump.live.test.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { evoSdkService } from '../sdk'
import { loadBrowseContext, loadRepoHome, selectedTip, selectRef } from './index'
import { decodeTextBlob } from './git-objects'
import { pathEntryAt, pathVersions, entryOid } from './path-history'
import { readBlob } from './tree-nav'
import { historyWalker } from './commit-log'

const env = process.env
const LIVE = env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet' && env['FORGE_DUMP_DIR'] !== undefined

describe.skipIf(!LIVE)('dump a file’s versions (live)', () => {
  it(
    'writes each version blame compares',
    async () => {
      const forge = NETWORKS.devnet.v2!
      await evoSdkService.initialize({ network: 'devnet', contractIds: [forge.core, forge.collab], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()!
      const home = await loadRepoHome(sdk, { network: 'devnet', owner: env['FORGE_DUMP_OWNER']!, name: env['FORGE_DUMP_NAME']! })
      expect(home).not.toBeNull()
      const state = await loadBrowseContext(sdk, home!.repo)
      expect(state.kind).toBe('ready')
      const reader = (state as { context: { reader: import('../browse').BrowseReader } }).context.reader
      const tip = selectedTip(selectRef(home!.branches, home!.tags, home!.defaultBranch, ''))!
      const path = env['FORGE_DUMP_PATH']!
      const out = env['FORGE_DUMP_DIR']!
      mkdirSync(out, { recursive: true })
      const max = Number(env['FORGE_DUMP_MAX'] ?? '12')
      const walker = historyWalker(reader)
      const page = await pathVersions(reader, tip, path, { limit: max, cap: 20_000, walker })
      let n = 0
      for (const e of page.entries) {
        const entry = await pathEntryAt(reader, walker, e.oid, path)
        if (entry === null) continue
        const text = decodeTextBlob(await readBlob(reader, entryOid(entry)))
        writeFileSync(join(out, `${String(n++).padStart(3, '0')}-${e.oid}.txt`), text ?? '')
      }
      expect(n).toBeGreaterThan(0)
    },
    900_000,
  )
})
