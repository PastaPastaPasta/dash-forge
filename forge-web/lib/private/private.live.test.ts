/**
 * Live private-repository write + read smoke on devnet sakura — SKIPPED by default (network,
 * WASM, a few cents of spend).
 *
 * Run with:
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=sakura \
 *     pnpm exec vitest run lib/private/private.live.test.ts
 *
 * Creates a fresh private repo with the devnet's test identities in
 * `~/.config/dash-forge/test-identities/devnet-<name>/` and one document of every type
 * `docs/security/private-repos.md` §13 changed (each now requires `$createdAtBlockHeight`, set
 * by the network): the owner's self-`repoKey` wrap (evo-sdk `encryptedFor`), the epoch-0 anchor
 * `config` (enc v0x02), a `refUpdate` and a `protectedRefUpdate` (HMAC ref-name hash, refName
 * in `enc`), a sealed `packManifest`, an `issue`, a `patch`, a `comment` with a path in `enc`,
 * and a `review`. Then it reads them back with proofs, checks the network set
 * `$createdAtBlockHeight`, unwraps the key, resolves the epochs and opens every document.
 * Never gates CI.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { evoSdkService } from '../sdk'
import { hexToBytes } from './bytes'
import { openContent, sealDoc, type PrivateDoc } from './doc'
import { resolveEpochs, openContextOf } from './epoch'
import { privateId } from './ids'
import { EpochKeys, generateEpochKey, refNameHash } from './keys'
import { packHash, sealPack } from './pack'
import { sealWrap, unwrapKey } from './wrap'

const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet'
const ID_DIR = join(homedir(), '.config/dash-forge/test-identities', NETWORKS[DEFAULT_NETWORK].key)

interface KeyRecord {
  readonly id: number
  readonly purpose: string
  readonly securityLevel: string
  readonly keyType: string
  readonly privateKeyWif: string
  readonly privateKeyHex: string
  readonly publicKeyHex: string
}
interface IdentityRecord {
  readonly identityId: string
  readonly identityKeys: readonly KeyRecord[]
}

type Evo = typeof import('@dashevo/evo-sdk')

describe.skipIf(!LIVE)('live private repository (sakura)', () => {
  it(
    'writes every §13 type with $createdAtBlockHeight required, and reads it back',
    async () => {
      const ids = NETWORKS.devnet.v2
      if (ids === null) throw new Error('no forge-v2 deployment for the devnet')
      const evo: Evo = await import('@dashevo/evo-sdk')
      await evoSdkService.initialize({ network: 'devnet', contractIds: [ids.core, ids.collab], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()
      const version = sdk.version()

      const rec: IdentityRecord = JSON.parse(readFileSync(join(ID_DIR, 'OWNER.identity.json'), 'utf8'))
      const key = (purpose: string, level: string): KeyRecord => {
        const k = rec.identityKeys.find((x) => x.purpose === purpose && x.securityLevel === level)
        if (k === undefined) throw new Error(`OWNER has no ${level} ${purpose} key`)
        return k
      }
      const auth = key('AUTHENTICATION', 'HIGH')
      const enc = key('ENCRYPTION', 'MEDIUM')
      const identityKey = new evo.IdentityPublicKey({
        keyId: auth.id,
        purpose: 'authentication',
        securityLevel: 'high',
        keyType: 'ecdsa_secp256k1',
        data: hexToBytes(auth.publicKeyHex),
      })
      const signer = new evo.IdentitySigner()
      signer.addKey(evo.PrivateKey.fromWIF(auth.privateKeyWif))
      const encKey = new evo.IdentityPublicKey({
        keyId: enc.id,
        purpose: 'encryption',
        securityLevel: 'medium',
        keyType: 'ecdsa_secp256k1',
        data: hexToBytes(enc.publicKeyHex),
      })
      const encPriv = evo.PrivateKey.fromHex(enc.privateKeyHex, 'testnet')
      const owner = evo.Identifier.fromBase58(rec.identityId)
      const ownerBytes = owner.toBytes()

      const create = async (contractId: string, type: string, data: Record<string, unknown>) => {
        const base = new evo.Document({ properties: {}, documentTypeName: type, dataContractId: contractId, ownerId: owner })
        const document = evo.Document.fromObject({ ...base.toObject(), ...data }, version)
        const created = await sdk.documents.create({ document, identityKey, signer })
        return created.id.toBase58()
      }
      const fetch = async (contractId: string, type: string, id: string) => {
        const res = await sdk.documents.query({
          dataContractId: contractId,
          documentTypeName: type,
          where: [['$id', '==', id]],
          limit: 1,
        })
        const doc = [...res.values()][0]
        if (doc === undefined) throw new Error(`${type} ${id} not found`)
        const height = doc.createdAtBlockHeight
        expect(height, `${type}.$createdAtBlockHeight is set by the network`).toBeDefined()
        return { doc, height: Number(height) }
      }

      // repo + maintainer (plaintext, as for any repo)
      const name = `private-smoke-${Date.now().toString(36)}`
      const repoId = await create(ids.core, 'repo', { name, visibility: 'private' })
      const R = evo.Identifier.fromBase58(repoId).toBytes()
      await create(ids.core, 'maintainer', { repoId: R, memberId: ownerBytes })

      // epoch 0: a fresh key, the self-wrap, then the anchor
      const raw = generateEpochKey()
      const keys = await EpochKeys.import(R, 0, raw)
      const coreContract = await sdk.contracts.fetch(ids.core)
      if (coreContract === undefined) throw new Error('forge-core not found')
      const wrapProps = await sealWrap(sdk.encryptedFor, keys, raw, {
        dataContract: coreContract,
        senderKey: encKey,
        senderPrivateKey: encPriv,
        recipientKey: encKey,
      })
      raw.fill(0)
      const wrapId = await create(ids.core, 'repoKey', { repoId: R, memberId: ownerBytes, epoch: 0, ...wrapProps })
      const configDoc: PrivateDoc = { type: 'config', ownerId: ownerBytes, epoch: 0 }
      const configEnc = await sealDoc(keys, configDoc, { defaultBranch: 'refs/heads/main', protectedPatterns: ['refs/heads/main'] })
      const configId = await create(ids.core, 'config', { repoId: R, enc: configEnc, epoch: 0 })

      // refs, a sealed pack
      const oid = hexToBytes('aa'.repeat(20))
      const mainHash = await refNameHash(keys, 'refs/heads/main')
      const refDoc: PrivateDoc = { type: 'protectedRefUpdate', ownerId: ownerBytes, epoch: 0, refNameHash: mainHash, newOid: oid, force: false }
      const protectedId = await create(ids.core, 'protectedRefUpdate', {
        repoId: R, refNameHash: mainHash, newOid: oid, enc: await sealDoc(keys, refDoc, { refName: 'refs/heads/main' }), epoch: 0,
      })
      const devHash = await refNameHash(keys, 'refs/heads/dev')
      const devDoc: PrivateDoc = { type: 'refUpdate', ownerId: ownerBytes, epoch: 0, refNameHash: devHash, newOid: oid, force: false }
      const refId = await create(ids.core, 'refUpdate', {
        repoId: R, refNameHash: devHash, newOid: oid, enc: await sealDoc(keys, devDoc, { refName: 'refs/heads/dev' }), epoch: 0,
      })
      const sealed = await sealPack(keys, new TextEncoder().encode('PACK not really a pack'))
      const manifestId = await create(ids.core, 'packManifest', {
        repoId: R, packHash: hexToBytes(await packHash(sealed)), kind: 0, sizeBytes: sealed.length, objectCount: 0,
        chunkCount: 0, storage: 1, uris: ['https://example.invalid/pack'], offsetIndexParts: 0,
      })

      // collab content
      const issueDoc: PrivateDoc = { type: 'issue', ownerId: ownerBytes, epoch: 0, number: 1 }
      const issueId = await create(ids.collab, 'issue', {
        repoId: R, number: 1, enc: await sealDoc(keys, issueDoc, { title: 'secret title', body: 'secret body' }), epoch: 0,
      })
      const featHash = await refNameHash(keys, 'refs/heads/feature')
      const patchDoc: PrivateDoc = { type: 'patch', ownerId: ownerBytes, epoch: 0, number: 1, baseRefNameHash: mainHash, sourceRefNameHash: featHash }
      const patchId = await create(ids.collab, 'patch', {
        repoId: R, number: 1, baseRefNameHash: mainHash, sourceRepoId: R, sourceRefNameHash: featHash, headOid: oid, epoch: 0,
        enc: await sealDoc(keys, patchDoc, { title: 'secret PR', baseRefName: 'refs/heads/main', sourceRefName: 'refs/heads/feature' }),
      })
      const P = evo.Identifier.fromBase58(patchId).toBytes()
      const commentDoc: PrivateDoc = { type: 'comment', ownerId: ownerBytes, epoch: 0, targetId: P }
      const commentId = await create(ids.collab, 'comment', {
        repoId: R, targetId: P, commitOid: oid, line: 3, side: 1, epoch: 0,
        enc: await sealDoc(keys, commentDoc, { body: 'nit', path: 'src/secret.rs' }),
      })
      const reviewDoc: PrivateDoc = { type: 'review', ownerId: ownerBytes, epoch: 0, patchId: P }
      const reviewId = await create(ids.collab, 'review', {
        repoId: R, patchId: P, verdict: 1, commitOid: oid, epoch: 0, enc: await sealDoc(keys, reviewDoc, { body: 'ok' }),
      })

      // read back: every type carries the network-set height
      const wrap = await fetch(ids.core, 'repoKey', wrapId)
      const config = await fetch(ids.core, 'config', configId)
      for (const [type, id] of [['protectedRefUpdate', protectedId], ['refUpdate', refId], ['packManifest', manifestId]] as const) {
        await fetch(ids.core, type, id)
      }
      const reads = {
        issue: await fetch(ids.collab, 'issue', issueId),
        patch: await fetch(ids.collab, 'patch', patchId),
        comment: await fetch(ids.collab, 'comment', commentId),
        review: await fetch(ids.collab, 'review', reviewId),
      }

      // unwrap, resolve, open
      const unwrapped = await unwrapKey(sdk.encryptedFor, {
        dataContract: coreContract,
        document: wrap.doc,
        readerPrivateKey: encPriv,
        counterpartyKey: encKey,
        repoId: R,
        epoch: 0,
      })
      const bytesOf = (v: unknown): Uint8Array => {
        if (v instanceof Uint8Array) return v
        if (typeof v === 'string') return Uint8Array.from(atob(v), (c) => c.charCodeAt(0))
        throw new TypeError('not bytes')
      }
      const configEncRead = bytesOf(config.doc.properties['enc'])
      const resolution = await resolveEpochs({
        repoId: R,
        reader: ownerBytes,
        memberships: [{ identity: ownerBytes, role: 'maintainer' }],
        configs: [{ id: privateId(configId), owner: ownerBytes, epoch: 0, createdAtBlockHeight: config.height, enc: configEncRead }],
        wraps: [{ id: privateId(wrapId), owner: ownerBytes, memberId: ownerBytes, epoch: 0, recipientKeyId: enc.id, keyEnabled: true, keys: unwrapped }],
      })
      expect(resolution.currentEpoch).toBe(0)
      expect(resolution.writeEpoch).toBe(0)
      expect(resolution.alerts).toEqual([])
      const ctx = openContextOf(resolution)
      const open = async (doc: PrivateDoc, read: { doc: { properties: Record<string, unknown> }; height: number }, id?: string) =>
        openContent({ ...doc, id: id === undefined ? undefined : privateId(id), createdAtBlockHeight: read.height, enc: bytesOf(read.doc.properties['enc']) }, ctx)
      expect(await open(configDoc, config, configId)).toEqual({
        status: 'readable',
        fields: { defaultBranch: 'refs/heads/main', protectedPatterns: ['refs/heads/main'] },
      })
      expect(await open(issueDoc, reads.issue)).toEqual({ status: 'readable', fields: { title: 'secret title', body: 'secret body' } })
      expect((await open(patchDoc, reads.patch)).status).toBe('readable')
      expect(await open(commentDoc, reads.comment)).toEqual({ status: 'readable', fields: { body: 'nit', path: 'src/secret.rs' } })
      expect(await open(reviewDoc, reads.review)).toEqual({ status: 'readable', fields: { body: 'ok' } })
      expect(reads.issue.height).toBeGreaterThanOrEqual(config.height)
    },
    300000,
  )
})
