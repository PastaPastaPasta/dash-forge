/**
 * Seed for the live browser-merge e2e (`e2e/v2-pulls.spec.ts` c7) — SKIPPED by default.
 *
 *   FORGE_LIVE=1 E2E_C_SEED_OUT=/tmp/…/seed.json NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=moutai \
 *     pnpm exec vitest run lib/merge/merge-seed.live.test.ts
 *
 * As the moutai OWNER, through the same code a browser push runs: a new repo `e2e-c-merge-<t>`
 * whose history diverges — `main` = c1 → c3 (edits a.txt), `feature` = c1 → c2 (edits b.txt),
 * so the PR merges cleanly with a merge commit — stored as one pack on Platform (priced as a
 * browser upload with no storage configured), its index fragment, both refs, and PR #1
 * `feature` → `main`. Writes `{ owner, name, number }` for the Playwright spec. Spend: about
 * 0.006 DASH.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { evoSdkService, type WriteAuth } from '../sdk'
import { parseIdentityFileText } from '../auth'
import { createPatch, createRepo, type RepoRef } from '../repo'
import { writePackManifest, writeRefUpdate } from '../repo/push'
import { storeArtifact } from '../storage'
import { Store } from '../view/diff-fixtures'
import { publishMergeIndex } from './locator'
import { writePack } from './pack-writer'
import type { UploadPack } from './runner'

const OUT = process.env['E2E_C_SEED_OUT'] ?? ''
const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet' && OUT !== ''

describe.skipIf(!LIVE)('seed a divergent repo for the live merge e2e', () => {
  it(
    'creates the repo, its history, refs and a PR',
    async () => {
      const file = join(homedir(), '.config/dash-forge/test-identities/devnet-moutai/OWNER.identity.json')
      const parsed = parseIdentityFileText(readFileSync(file, 'utf8'))
      const auth: WriteAuth = { identityId: parsed.identityId, network: 'devnet', getSigningKeyWif: () => parsed.signingKeyWif }
      await evoSdkService.initialize({ network: 'devnet', contractIds: [], timeoutMs: 20000 })
      const sdk = evoSdkService.getSdk()
      const forge = NETWORKS.devnet.v2
      if (forge === null) throw new Error('moutai has no forge-v2 deployment')

      const name = `e2e-c-merge-${Date.now().toString(36)}`
      const created = await createRepo(sdk, auth, forge, { name, description: 'browser merge e2e (v2-pulls c7)' })
      const repo: RepoRef = { forge, repoId: created.repoId, ownerId: auth.identityId, name, visibility: 'public' }

      const s = new Store()
      const c1 = s.commit(s.files({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n', 'README.md': `# ${name}\n` }), [], 'Initial import')
      const c2 = s.commit(s.files({ 'a.txt': 'alpha\n', 'b.txt': 'beta, from the feature branch\n', 'README.md': `# ${name}\n` }), [c1], 'Change b on feature')
      const c3 = s.commit(s.files({ 'a.txt': 'alpha, on main\n', 'b.txt': 'beta\n', 'README.md': `# ${name}\n` }), [c1], 'Change a on main')
      const pack = writePack([...s.objects.values()])

      const upload: UploadPack = async (bytes) => {
        const stored = await storeArtifact(sdk, auth, repo, bytes, { policy: null, profiles: [], confirmPlatform: async () => true })
        return { storage: stored.storage, chunkCount: stored.chunkCount, uris: stored.uris }
      }
      const stored = await upload(pack.bytes, { packHash: pack.packHash, objectCount: pack.objectCount })
      await writePackManifest(sdk, auth, repo, { packHash: pack.packHash, kind: 0, sizeBytes: pack.bytes.length, objectCount: pack.objectCount, ...stored })
      const index = await publishMergeIndex(sdk, auth, repo, pack.bytes, pack.packHash, upload, `seed:${name}:index`)
      expect(index.kind).toBe('published')

      await writeRefUpdate(sdk, auth, repo, { refName: 'refs/heads/main', newOid: c3 }, { protectedPatterns: [] })
      await writeRefUpdate(sdk, auth, repo, { refName: 'refs/heads/feature', newOid: c2 }, { protectedPatterns: [] })
      const pr = await createPatch(sdk, auth, repo, {
        title: 'Change b on feature',
        body: 'Seeded for the browser merge e2e.',
        baseRefName: 'refs/heads/main',
        sourceRepoId: repo.repoId,
        sourceRefName: 'refs/heads/feature',
        headOid: c2,
      })
      writeFileSync(OUT, JSON.stringify({ owner: auth.identityId, name, number: pr.number, base: c3, head: c2 }))
    },
    600_000,
  )
})
