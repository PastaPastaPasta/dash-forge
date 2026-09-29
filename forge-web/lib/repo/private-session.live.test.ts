/**
 * Live private-repo READ smoke on devnet moutai — SKIPPED by default (network, WASM). Spends
 * nothing: it reads a private repo `lib/private/private.live.test.ts` created (a
 * `private-smoke-*` repo of OWNER) through the web read path the pages use.
 *
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=moutai \
 *     pnpm exec vitest run lib/repo/private-session.live.test.ts
 *
 * OWNER's encryption key goes into a tab-only vault session (memory), then the session loader
 * unwraps OWNER's self-wrap through the SDK's `encryptedFor`, resolves the epochs, opens the
 * config, the refs and the issue. A second pass as COLLAB (not a member) reads nothing.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { encryptionOps } from '../auth/encryption-key'
import { holdForSession, lockVault, storeEncryptionKey } from '../auth/vault'
import { encodeWif } from '../auth/wif'
import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { hexToBytes } from '../private'
import { evoSdkService, queryDocuments } from '../sdk'
import { loadPrivateHome, loadRepoHome } from '../view'
import { listIssues } from './issues'
import { loadPrivateSession, sdkSessionSource, sessionUnwrapper } from './private-session'

const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet'
const ID_DIR = join(homedir(), '.config/dash-forge/test-identities/devnet-moutai')

interface KeyRecord {
  readonly id: number
  readonly purpose: string
  readonly privateKeyHex: string
}
const identity = (name: string): { identityId: string; identityKeys: KeyRecord[] } => JSON.parse(readFileSync(join(ID_DIR, `${name}.identity.json`), 'utf8'))

describe.skipIf(!LIVE)('live private-repo reads (moutai)', () => {
  it(
    'a member decrypts config, refs and issues; an outsider reads nothing',
    async () => {
      const ids = NETWORKS.devnet.v2
      if (ids === null) throw new Error('no forge-v2 deployment')
      await evoSdkService.initialize({ network: 'devnet', contractIds: [ids.core, ids.collab], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()
      const owner = identity('OWNER')
      const repos = await queryDocuments(sdk, {
        dataContractId: ids.core,
        documentTypeName: 'repo',
        where: [
          ['$ownerId', '==', owner.identityId],
          ['name', 'startsWith', 'private-smoke'],
        ],
        orderBy: [
          ['$ownerId', 'asc'],
          ['name', 'asc'],
        ],
        limit: 20,
      })
      const name = repos.map((d) => d['name'] as string).pop()
      if (name === undefined) throw new Error('no private-smoke repo; run lib/private/private.live.test.ts once')
      const home = await loadRepoHome(sdk, { network: 'devnet', owner: owner.identityId, name })
      if (home === null) throw new Error(`${name} did not resolve`)
      expect(home.repo.visibility).toBe('private')

      // OWNER: the encryption key in a tab-only vault session.
      const enc = owner.identityKeys.find((k) => k.purpose === 'ENCRYPTION') as KeyRecord
      holdForSession('devnet', { identityId: owner.identityId, keyId: -1, wif: encodeWif(new Uint8Array(32).fill(1), 'devnet') })
      await storeEncryptionKey('devnet', owner.identityId, enc.id, hexToBytes(enc.privateKeyHex))
      const ops = await encryptionOps(sdk, 'devnet', owner.identityId, ids.collab)
      if (ops === null) throw new Error('no encryption ops')
      const session = await loadPrivateSession({
        repo: home.repo,
        network: 'devnet',
        reader: owner.identityId,
        source: sdkSessionSource(sdk, home.repo),
        unwrapper: sessionUnwrapper(ops),
      })
      expect(session.resolution.currentEpoch).toBe(0)
      expect(session.resolution.writeEpoch).toBe(0)
      expect(session.resolution.alerts).toEqual([])
      expect(session.config?.defaultBranch).toBe('main')
      const decrypted = await loadPrivateHome(sdk, home, session)
      expect(decrypted.branches.map((b) => b.refName).sort()).toEqual(['refs/heads/dev', 'refs/heads/main'])
      const issues = await listIssues(sdk, decrypted.repo, 20)
      expect(issues.map((i) => i.title)).toContain('secret title')
      lockVault()

      // COLLAB is not a member: its session holds no key, and every document stays sealed.
      const collab = identity('COLLAB')
      const outsider = await loadPrivateSession({
        repo: home.repo,
        network: 'devnet',
        reader: collab.identityId,
        source: sdkSessionSource(sdk, home.repo),
        unwrapper: null,
      })
      expect(outsider.resolution.keys.size).toBe(0)
      const sealed = await listIssues(sdk, { ...home.repo, session: outsider }, 20)
      expect(sealed).toHaveLength(0)
      expect(JSON.stringify(sealed)).not.toContain('secret')
    },
    300000,
  )
})
