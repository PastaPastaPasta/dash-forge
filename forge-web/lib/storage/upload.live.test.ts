/**
 * Live browser-upload path — SKIPPED by default (devnet writes + a local MinIO).
 *
 *   docker compose -f infra/docker-compose.yml up -d minio minio-init
 *   FORGE_LIVE=1 FORGE_LIVE_PUBLIC_URL=https://…/forge-byo NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=moutai \
 *     pnpm exec vitest run lib/storage/upload.live.test.ts
 *
 * As the moutai MAINTAINER (a maintainer of its own `forge-v2-empty`, the fixture no push has
 * touched): store a small artifact in the `forge-byo` bucket with SigV4 (the same code the
 * browser runs, on Node's WebCrypto + fetch), verified by re-read; write its `packManifest`
 * (kind 2, a flatIndex slot nothing reads for browsing); then read the manifest back from
 * Platform and fetch + hash the bytes through the web reader (`loadArtifactBytesProgress`),
 * as any browser would. A rerun is idempotent (content-addressed key, the signer's own
 * manifest slot). Spend: one manifest document.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { isPublicHttpsUrl } from '../net'
import { evoSdkService, type WriteAuth } from '../sdk'
import { parseIdentityFileText } from '../auth'
import { readV2PackCopies } from '../repo'
import { loadArtifactBytesProgress } from '../view/browse-source'
import { retryWhileMissing } from '../view/retry'
import type { V2RepoRef } from '../repo/contract'
import { storeAndRecordPack, policyFor, type StorageProfile } from './index'
import { sha256Hex } from './sigv4'

/**
 * The bucket's PUBLIC https address: a manifest records only addresses anyone can read, so a
 * bare local MinIO does not qualify. Expose it for the run, e.g.
 * `cloudflared tunnel --url http://127.0.0.1:9000` → FORGE_LIVE_PUBLIC_URL=https://<name>.trycloudflare.com/forge-byo
 */
const PUBLIC_URL = (process.env['FORGE_LIVE_PUBLIC_URL'] ?? '').replace(/\/+$/, '')
const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet' && isPublicHttpsUrl(PUBLIC_URL)
const MAINTAINER_FILE = join(homedir(), '.config/dash-forge/test-identities/devnet-moutai/MAINTAINER.identity.json')
const EMPTY_REPO = 'F9puk5NBQyySFbgj9yUfubdXAVv1YV7Zk2KDvfyHzxLU'

const MINIO: StorageProfile = {
  name: 'minio',
  settings: {
    kind: 's3',
    provider: 'minio',
    endpoint: 'http://127.0.0.1:9000',
    region: 'us-east-1',
    bucket: 'forge-byo',
    pathStyle: true,
    publicUrl: PUBLIC_URL,
    prefix: 'web-live',
  },
  secrets: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
}

describe.skipIf(!LIVE)('live browser upload to MinIO + manifest on moutai', () => {
  it(
    'stores, verifies, records, and reads back through the web reader',
    async () => {
      const parsed = parseIdentityFileText(readFileSync(MAINTAINER_FILE, 'utf8'))
      const auth: WriteAuth = { identityId: parsed.identityId, network: 'devnet', getSigningKeyWif: () => parsed.signingKeyWif }
      const v2 = NETWORKS.devnet.v2
      if (!v2) throw new Error('no forge-v2 deployment on this devnet')
      await evoSdkService.initialize({ network: 'devnet', contractIds: [v2.core, v2.collab], timeoutMs: 20000 })
      const sdk = evoSdkService.getSdk()
      const repo: V2RepoRef = { forge: v2, repoId: EMPTY_REPO, ownerId: parsed.identityId, name: 'forge-v2-empty', visibility: 'public' }

      // One artifact per public URL: the signer's manifest slot for a pack is permanent, so a
      // rerun with the same bytes and URL finds its own manifest and writes nothing.
      const bytes = new TextEncoder().encode(`forge-web live upload artifact ${EMPTY_REPO} ${PUBLIC_URL}\n`)
      const hash = await sha256Hex(bytes)
      const events: string[] = []
      const { stored, manifest } = await storeAndRecordPack(
        sdk,
        auth,
        repo,
        bytes,
        { kind: 2, objectCount: 0 },
        {
          policy: policyFor(['minio'], 'one'),
          profiles: [MINIO],
          confirmPlatform: async () => false,
          onStep: (e) => events.push(`${e.target}:${e.phase}`),
          intent: `live-upload:${hash}`,
        },
      )
      // eslint-disable-next-line no-console
      console.log('stored', { uris: stored.uris, manifest: manifest.documentId, cost: manifest.cost.dash, events })
      expect(stored.storage).toBe(1)
      expect(stored.uris[0]).toBe(`${PUBLIC_URL}/web-live/packs/${hash}.pack`)
      expect(stored.uris[1]).toBe(`s3://forge-byo/web-live/packs/${hash}.pack`)
      expect(events).toEqual(['minio:start', 'minio:done'])

      // The node answering the read may be a block behind the one that confirmed the write.
      const copy = await retryWhileMissing(() => readV2PackCopies(sdk, repo, hash, 2), 8)
      expect(copy, 'the manifest should read back from Platform').not.toBeNull()
      expect(copy?.uris).toEqual(stored.uris)
      const got = await loadArtifactBytesProgress(sdk, repo, copy!)
      expect(await sha256Hex(got)).toBe(hash)
    },
    180_000,
  )
})
