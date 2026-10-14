/**
 * Live seed of a members-only branch on devnet sakura (mixed-visibility phase 3, stream 3C's QA)
 * — SKIPPED by default (network, WASM, about 0.01 DASH). Until the push helper writes them (stream
 * 3A), this plays its part through the library: one thin members-only git pack of a local
 * branch's new objects (kind 64, sealed under the members key, `have` = the public tip) and the
 * branch's members-only ref update (`refName` absent, keyed hash, blinded oids). The web then
 * lists, browses, opens PRs from and publishes the branch; nothing here is a web code path.
 *
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=sakura \
 *     P3C_OWNER=<repo owner id> P3C_NAME=<repo name> P3C_WRITER=<member identity.json> \
 *     P3C_WORK=<local clone holding the branch> P3C_BRANCH=sec/fix [P3C_BASE=main] [P3C_PREV=<its tip now>] \
 *     pnpm exec vitest run lib/repo/members-branch.live.test.ts
 *
 * Never gates CI.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parseIdentityFileText } from '../auth'
import { decodeIdentifier } from '../auth/base58'
import { encryptionOps } from '../auth/encryption-key'
import { holdForSession, storeEncryptionKey } from '../auth/vault'
import { encodeWif } from '../auth/wif'
import { DEFAULT_NETWORK, NETWORKS, PACK_KIND } from '../constants'
import { hexToBytes, sealMembersRef, sealPack, sealedRefProps } from '../private'
import { createDocumentIdempotent, evoSdkService, type WriteAuth } from '../sdk'
import { storeArtifact } from '../storage/upload'
import { loadRepoHome } from '../view'
import { membersWriter } from './members-writes'
import { writePackManifest } from './push'
import { readMembersRefs } from './members-branches'
import { loadPrivateSession, sdkSessionSource, sessionUnwrapper } from './private-session'

const env = (k: string): string => process.env[k] ?? ''
const OWNER = env('P3C_OWNER')
const NAME = env('P3C_NAME')
const WRITER_FILE = env('P3C_WRITER')
const WORK = env('P3C_WORK')
const BRANCH = env('P3C_BRANCH')
const BASE = env('P3C_BASE') || 'main'
const PREV = env('P3C_PREV')
const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet' && [OWNER, NAME, WRITER_FILE, WORK, BRANCH].every((v) => v !== '')

interface KeyRecord {
  readonly id: number
  readonly purpose: string
  readonly privateKeyHex: string
}

/** What the seed did, on stdout (no keys). */
const say = (line: string): void => void process.stdout.write(`${line}\n`)

const git = (...args: string[]): string => execFileSync('git', ['-C', WORK, ...args], { encoding: 'utf8' }).trim()

describe.skipIf(!LIVE)('a members-only branch pushed through the library (sakura)', () => {
  it(
    'stores a thin members-only pack and the sealed ref update; the member folds the branch on its real tip',
    async () => {
      const forge = NETWORKS.devnet.v2
      if (forge === null) throw new Error('no forge-v2 deployment')
      await evoSdkService.initialize({ network: 'devnet', contractIds: [forge.core, forge.collab], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()
      const home = await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: NAME })
      if (home === null) throw new Error(`${OWNER}/${NAME} did not resolve`)
      const repo = home.repo
      const parsed = parseIdentityFileText(readFileSync(WRITER_FILE, 'utf8'))
      const auth: WriteAuth = { identityId: parsed.identityId, network: 'devnet', getSigningKeyWif: () => parsed.signingKeyWif }
      const raw = JSON.parse(readFileSync(WRITER_FILE, 'utf8')) as { identityKeys: KeyRecord[] }
      const encKey = raw.identityKeys.find((k) => k.purpose === 'ENCRYPTION') as KeyRecord
      holdForSession('devnet', { identityId: auth.identityId, keyId: -1, wif: encodeWif(new Uint8Array(32).fill(1), 'devnet') })
      await storeEncryptionKey('devnet', auth.identityId, encKey.id, hexToBytes(encKey.privateKeyHex))

      // The branch's new objects, thin against the public tip (`have` = P, DESIGN §4.3).
      const name = `refs/heads/${BRANCH}`
      const tip = git('rev-parse', `refs/heads/${BRANCH}`)
      const base = git('rev-parse', `refs/heads/${BASE}`)
      const have = PREV !== '' ? [base, PREV] : [base]
      const pack = new Uint8Array(execFileSync('git', ['-C', WORK, 'pack-objects', '--stdout', '--thin', '--revs', '-q'], { input: `${tip}\n${have.map((h) => `^${h}`).join('\n')}\n` }))
      const objectCount = new DataView(pack.buffer, pack.byteOffset + 8, 4).getUint32(0, false)
      say(`branch ${name} at ${tip}: thin pack of ${objectCount} objects (${pack.length} B) against ${have.join(', ')}`)

      // Sealed under the members key's write epoch (DFPK 0x01), stored, recorded as kind 64.
      const { keys } = await membersWriter(sdk, auth, repo)
      const sealed = await sealPack(keys, pack)
      const stored = await storeArtifact(sdk, auth, repo, sealed, { policy: null, profiles: [], confirmPlatform: async () => true })
      const manifest = await writePackManifest(sdk, auth, repo, {
        kind: PACK_KIND.MEMBERS_GIT_PACK,
        objectCount,
        packHash: stored.packHash,
        sizeBytes: stored.sizeBytes,
        chunkCount: stored.chunkCount,
        storage: stored.storage,
        uris: stored.uris,
      })
      say(`members-only pack ${stored.packHash} recorded as kind 64: manifest ${manifest.documentId}`)

      // The branch's members-only ref update: name sealed, oids blinded under a fresh salt.
      const ref = await sealMembersRef(keys, decodeIdentifier(auth.identityId), {
        type: 'refUpdate',
        name,
        newOid: hexToBytes(tip),
        ...(PREV !== '' ? { prevOid: hexToBytes(PREV) } : {}),
        force: false,
      })
      const written = await createDocumentIdempotent(sdk, auth, {
        contractId: repo.forge.core,
        documentType: 'refUpdate',
        data: { repoId: decodeIdentifier(repo.repoId), ...sealedRefProps(ref), r: 1 },
      })
      say(`members-only refUpdate ${written.documentId}: refName absent, newOid ${Buffer.from(ref.newOid).toString('hex')} (the blind)`)

      // The member's fold: the branch on its real tip.
      const ops = await encryptionOps(sdk, 'devnet', auth.identityId, forge.collab)
      if (ops === null) throw new Error('no encryption ops')
      const lane = await loadPrivateSession({ repo, network: 'devnet', reader: auth.identityId, source: sdkSessionSource(sdk, repo), unwrapper: sessionUnwrapper(ops) })
      let found: string | null = null
      for (let i = 0; i < 10 && found === null; i++) {
        const refs = await readMembersRefs(sdk, repo, lane)
        const b = refs.branches.find((r) => r.refName === name)
        found = b?.state.state === 'resolved' ? b.state.oid : null
        if (found === null) await new Promise((r) => setTimeout(r, 3000))
      }
      lane.close()
      expect(found).toBe(tip)
    },
    600_000,
  )
})
