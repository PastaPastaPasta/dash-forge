/**
 * Live make-public bundles no honest client writes (DESIGN §4.6; stream 2B) on devnet sakura —
 * SKIPPED by default (network, WASM, about 0.005 DASH). It plays a modified client that skips
 * the checks the web and `dg` make before signing, to show every reader ignores what it writes:
 *
 * 1. A writer (Write role) publishes the real per-object key of another member's members-only
 *    comment in a kind-7 bundle (sakura's forge-core lets a role-1 writer record kind 7; C3
 *    refuses it on mainnet). Readers honour only maintainers' bundles: the comment stays a
 *    placeholder, with no alert.
 * 2. A maintainer publishes a key that does not commit to another comment (a lying entry):
 *    readers ignore it and say so (an alert naming the maintainer).
 *
 * The anonymous web gate then reads both comments. `dg issue view` with no identity and the
 * logged-out web read the same repo afterwards (the stream's live QA).
 *
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=sakura \
 *     MP_BUNDLE_OWNER=<repo owner id> MP_BUNDLE_NAME=<repo name> \
 *     MP_BUNDLE_WRITER=<writer identity.json> MP_BUNDLE_MAINTAINER=<maintainer identity.json> \
 *     MP_BUNDLE_WRITER_TARGET=<comment id> MP_BUNDLE_LYING_TARGET=<comment id> \
 *     pnpm exec vitest run lib/repo/made-public.live.test.ts
 *
 * Never gates CI.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parseIdentityFileText } from '../auth'
import { encryptionOps } from '../auth/encryption-key'
import { holdForSession, lockVault, storeEncryptionKey } from '../auth/vault'
import { encodeWif } from '../auth/wif'
import { DEFAULT_NETWORK, NETWORKS, PACK_KIND } from '../constants'
import { ENTRY_COMMENT, encodeDocBundle, hexToBytes, membersObjKey } from '../private'
import { evoSdkService, queryDocumentsWithProof, type PlainDocument, type WriteAuth } from '../sdk'
import { storeArtifact } from '../storage/upload'
import { loadRepoHome } from '../view'
import { DOC, type RepoRef } from './contract'
import { invalidateRepoBundles, withBundles } from './made-public'
import { gateFor, storedPrivateDoc } from './private-content'
import { loadPrivateSession, sdkSessionSource, sessionUnwrapper } from './private-session'
import { writePackManifest } from './push'

const env = (k: string): string => process.env[k] ?? ''
const OWNER = env('MP_BUNDLE_OWNER')
const NAME = env('MP_BUNDLE_NAME')
const WRITER_FILE = env('MP_BUNDLE_WRITER')
const MAINT_FILE = env('MP_BUNDLE_MAINTAINER')
const WRITER_TARGET = env('MP_BUNDLE_WRITER_TARGET')
const LYING_TARGET = env('MP_BUNDLE_LYING_TARGET')
const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet' && [OWNER, NAME, WRITER_FILE, MAINT_FILE, WRITER_TARGET, LYING_TARGET].every((v) => v !== '')

interface KeyRecord {
  readonly id: number
  readonly purpose: string
  readonly privateKeyHex: string
}

function authOf(file: string): WriteAuth {
  const parsed = parseIdentityFileText(readFileSync(file, 'utf8'))
  return { identityId: parsed.identityId, network: 'devnet', getSigningKeyWif: () => parsed.signingKeyWif }
}

async function readComment(repo: RepoRef, id: string): Promise<PlainDocument> {
  const sdk = evoSdkService.getSdk()
  const { documents } = await queryDocumentsWithProof(sdk, { dataContractId: repo.forge.collab, documentTypeName: DOC.comment, where: [['$id', '==', id]], limit: 1 })
  const d = documents[0]
  if (d === undefined) throw new Error(`comment ${id} not found`)
  return d
}

/** Store `bytes` on Platform chunks with a kind-7 manifest, signed by `auth`: no client check on the way. */
async function writeRawBundle(repo: RepoRef, auth: WriteAuth, bytes: Uint8Array): Promise<void> {
  const sdk = evoSdkService.getSdk()
  const stored = await storeArtifact(sdk, auth, repo, bytes, { policy: null, profiles: [], confirmPlatform: async () => true })
  const { packHash, sizeBytes, chunkCount, storage, uris } = stored
  await writePackManifest(sdk, auth, repo, { kind: PACK_KIND.MAKE_PUBLIC, objectCount: 0, packHash, sizeBytes, chunkCount, storage, uris })
}

describe.skipIf(!LIVE)('make-public bundles no honest client writes (sakura)', () => {
  it(
    'a writer’s bundle is ignored; a maintainer’s lying entry is ignored with an alert',
    async () => {
      const forge = NETWORKS.devnet.v2
      if (forge === null) throw new Error('no forge-v2 deployment')
      await evoSdkService.initialize({ network: 'devnet', contractIds: [forge.core, forge.collab], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()
      const home = await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: NAME })
      if (home === null) throw new Error(`${OWNER}/${NAME} did not resolve`)
      const repo = home.repo
      const [writer, maint] = [authOf(WRITER_FILE), authOf(MAINT_FILE)]

      // 1. The writer derives the comment's real key with its own members key, and publishes it.
      const raw = JSON.parse(readFileSync(WRITER_FILE, 'utf8')) as { identityKeys: KeyRecord[] }
      const enc = raw.identityKeys.find((k) => k.purpose === 'ENCRYPTION') as KeyRecord
      holdForSession('devnet', { identityId: writer.identityId, keyId: -1, wif: encodeWif(new Uint8Array(32).fill(1), 'devnet') })
      await storeEncryptionKey('devnet', writer.identityId, enc.id, hexToBytes(enc.privateKeyHex))
      const ops = await encryptionOps(sdk, 'devnet', writer.identityId, forge.collab)
      if (ops === null) throw new Error('no encryption ops')
      const session = await loadPrivateSession({ repo, network: 'devnet', reader: writer.identityId, source: sdkSessionSource(sdk, repo), unwrapper: sessionUnwrapper(ops) })
      const target = await readComment(repo, WRITER_TARGET)
      const stored = storedPrivateDoc('comment', target, 'public')
      if (stored === null || stored.id === undefined) throw new Error('the writer target is not a members-only comment')
      const keys = session.resolution.keys.get(stored.epoch)
      if (keys === undefined) throw new Error('the writer holds no members key for its epoch')
      const key = await membersObjKey(keys, stored, stored.enc)
      if (key === null) throw new Error('the writer could not derive the comment key')
      const revision = Number(target['$revision'] ?? 1)
      const writerBytes = encodeDocBundle([{ kind: ENTRY_COMMENT, target: stored.id, revision, key }])
      key.fill(0)
      session.close()
      lockVault()
      await writeRawBundle(repo, writer, writerBytes)

      // 2. The maintainer names another comment with a key that is not its own.
      const lying = await readComment(repo, LYING_TARGET)
      const lyingStored = storedPrivateDoc('comment', lying, 'public')
      if (lyingStored === null || lyingStored.id === undefined) throw new Error('the lying target is not a members-only comment')
      const wrong = crypto.getRandomValues(new Uint8Array(32))
      await writeRawBundle(repo, maint, encodeDocBundle([{ kind: ENTRY_COMMENT, target: lyingStored.id, revision: Number(lying['$revision'] ?? 1), key: wrong }]))

      // 3. The anonymous reader (no session): neither opens; only the lie is said.
      invalidateRepoBundles(repo)
      const gate = withBundles(sdk, repo, gateFor(repo))
      const w = await gate.admit('comment', await readComment(repo, WRITER_TARGET))
      expect(w.ok).toBe(false)
      expect(w.alerts).toBeUndefined()
      const l = await gate.admit('comment', await readComment(repo, LYING_TARGET))
      expect(l.ok).toBe(false)
      expect(l.alerts?.map((a) => a.by)).toEqual([maint.identityId])
    },
    600_000,
  )
})
