/**
 * Live: the repo chrome composite on bonsia, read-only — SKIPPED by default (needs network + WASM).
 *
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=bonsia \
 *     pnpm exec vitest run lib/repo/chrome.live.test.ts
 *
 * Against the read fixture `forge-v2-demo`: the first read is one composite and answers what the
 * plain reads answer; a second read, a delta (`$createdAt >=` bound lookups), is accepted by the
 * node (no plain-query fallback) and returns the same timelines. Never gates CI.
 */

import { describe, expect, it } from 'vitest'

import { seedRepo } from '../../e2e/seed-summary'
import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { evoSdkService, queryAllDocuments } from '../sdk'
import { chromeFallbacks, readRepoChrome, resetRepoTimelines } from './chrome'
import { readRefs, refsFromRows } from './refs'
import { configBundleOf } from './config'

const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet'
const OWNER = process.env['E2E_V2_OWNER'] ?? seedRepo('demo')?.owner ?? ''
const NAME = process.env['E2E_V2_NAME'] ?? 'forge-v2-demo'

describe.skipIf(!LIVE)('live repo chrome composite (bonsia fixture)', () => {
  it(
    'first read and delta read are both served as composites and agree with the plain reads',
    async () => {
      const forge = NETWORKS.devnet.v2!
      await evoSdkService.initialize({ network: 'devnet', contractIds: [forge.core, forge.collab], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()!
      resetRepoTimelines()

      const first = await readRepoChrome(sdk, forge, OWNER, NAME, 'devnet')
      expect(first).not.toBeNull()
      const t1 = await first!.read!.all()
      const plainRefs = await readRefs(sdk, first!.repo)
      const fromRows = refsFromRows(first!.repo, t1.refUpdate, t1.protectedRefUpdate, configBundleOf(first!.repo, t1.config).history)
      const tips = (refs: readonly { refName: string; state: unknown }[]) => Object.fromEntries(refs.map((r) => [r.refName, JSON.stringify(r.state)]))
      expect(tips(fromRows)).toEqual(tips(plainRefs))
      const manifests = await queryAllDocuments(sdk, { dataContractId: forge.core, documentTypeName: 'packManifest', where: [['repoId', '==', first!.repo.repoId]], orderBy: [['$createdAt', 'asc']] })
      expect(t1.packManifest.map((d) => d['$id'])).toEqual(manifests.map((d) => d['$id']))

      // The delta read: every timeline bound `$createdAt >=` the newest held.
      const second = await readRepoChrome(sdk, forge, OWNER, NAME, 'devnet')
      const t2 = await second!.read!.all()
      expect(chromeFallbacks()).toBe(0)
      for (const type of ['config', 'refUpdate', 'protectedRefUpdate', 'packManifest'] as const) {
        expect(t2[type].map((d) => d['$id'])).toEqual(t1[type].map((d) => d['$id']))
      }
    },
    120_000,
  )
})
