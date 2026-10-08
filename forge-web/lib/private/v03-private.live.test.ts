/**
 * Live: a v0x03 comment in a PRIVATE repository on devnet sakura (mixed-visibility DESIGN D38,
 * the reader half shipped in phase R6) — SKIPPED by default (network, a few cents of spend).
 * No Forge client writes v0x03 in a private repository before the mainnet registration, so this
 * writes one, for a member's reader to open (`dg issue view N --comments`, the web).
 *
 * Run with an existing private repository and issue whose owner is the identity:
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=sakura \
 *   FORGE_LIVE_IDENTITY=<identity file> FORGE_LIVE_REPO=<repo id> FORGE_LIVE_ISSUE=<issue doc id> \
 *     pnpm exec vitest run lib/private/v03-private.live.test.ts
 *
 * It unwraps the owner's newest `repoKey`, seals the comment as a members-only (v0x03) envelope
 * under that epoch (the AD does not bind `vis`), writes it stamped `vis: "private"` with
 * `asMember`, reads it back and opens it as a private document. Prints the comment id. Never
 * gates CI.
 */

import { readFileSync } from 'node:fs'

import type { DocumentWhereClause } from '@dashevo/evo-sdk'

import { describe, expect, it } from 'vitest'

import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { evoSdkService } from '../sdk'
import { hexToBytes } from './bytes'
import { openContent, sealMembersDoc, V3, type PrivateDoc } from './doc'
import { resolveEpochs, openContextOf } from './epoch'
import { privateId } from './ids'
import { unwrapKey } from './wrap'

const LIVE =
  process.env['FORGE_LIVE'] === '1' &&
  DEFAULT_NETWORK === 'devnet' &&
  process.env['FORGE_LIVE_IDENTITY'] !== undefined &&
  process.env['FORGE_LIVE_REPO'] !== undefined &&
  process.env['FORGE_LIVE_ISSUE'] !== undefined

interface KeyRecord {
  readonly id: number
  readonly purpose: string
  readonly securityLevel: string
  readonly privateKeyWif: string
  readonly privateKeyHex: string
  readonly publicKeyHex: string
}

type Evo = typeof import('@dashevo/evo-sdk')

const bytesOf = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return v
  if (typeof v === 'string') return Uint8Array.from(atob(v), (c) => c.charCodeAt(0))
  throw new TypeError('not bytes')
}

describe.skipIf(!LIVE)('live v0x03 comment in a private repository (sakura)', () => {
  it(
    'writes a members-only envelope stamped private and opens it as a member',
    async () => {
      const ids = NETWORKS.devnet.v2
      if (ids === null) throw new Error('no forge-v2 deployment for the devnet')
      const evo: Evo = await import('@dashevo/evo-sdk')
      await evoSdkService.initialize({ network: 'devnet', contractIds: [ids.core, ids.collab], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()
      const version = sdk.version()

      const rec = JSON.parse(readFileSync(process.env['FORGE_LIVE_IDENTITY'] as string, 'utf8')) as {
        identityId: string
        identityKeys: KeyRecord[]
      }
      const key = (purpose: string, level: string): KeyRecord => {
        const k = rec.identityKeys.find((x) => x.purpose === purpose && x.securityLevel === level)
        if (k === undefined) throw new Error(`no ${level} ${purpose} key`)
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
      const repo = evo.Identifier.fromBase58(process.env['FORGE_LIVE_REPO'] as string)
      const R = repo.toBytes()
      const issueId = process.env['FORGE_LIVE_ISSUE'] as string
      const T = evo.Identifier.fromBase58(issueId).toBytes()

      // the owner's newest wrap and the anchors
      const query = async (contractId: string, type: string, where: DocumentWhereClause[]) =>
        [...(await sdk.documents.query({ dataContractId: contractId, documentTypeName: type, where, limit: 100 })).values()].filter(
          (d) => d !== undefined,
        )
      const wraps = await query(ids.collab, 'repoKey', [
        ['repoId', '==', repo.toBase58()],
        ['memberId', '==', rec.identityId],
      ])
      const wrap = wraps.sort((a, b) => Number(b.properties['epoch']) - Number(a.properties['epoch']))[0]
      if (wrap === undefined) throw new Error('the identity holds no wrap of this repository')
      const epoch = Number(wrap.properties['epoch'])
      const collabContract = await sdk.contracts.fetch(ids.collab)
      if (collabContract === undefined) throw new Error('forge-collab not found')
      const keys = await unwrapKey(sdk.encryptedFor, {
        dataContract: collabContract,
        document: wrap,
        readerPrivateKey: encPriv,
        counterpartyKey: encKey,
        repoId: R,
        epoch,
      })

      // seal v0x03 (vis is not in the AD), store it stamped private
      const body = `members-only (v0x03) in a private repository, ${new Date().toISOString()}`
      const sealedAs: PrivateDoc = { type: 'comment', vis: 'public', ownerId: ownerBytes, epoch, targetId: T }
      const encBytes = await sealMembersDoc(keys, sealedAs, { body })
      expect(encBytes[0]).toBe(V3)
      const base = new evo.Document({ properties: {}, documentTypeName: 'comment', dataContractId: ids.collab, ownerId: owner })
      const document = evo.Document.fromObject(
        { ...base.toObject(), repoId: R, targetId: T, epoch, enc: encBytes, vis: 'private', asMember: ownerBytes },
        version,
      )
      const created = await sdk.documents.create({ document, identityKey, signer })
      const commentId = created.id.toBase58()
      // eslint-disable-next-line no-console -- the run log names the comment for the readers that check it
      console.log(`v0x03 comment ${commentId} on ${issueId} (epoch ${epoch})`)

      // read back and open as a private document
      const [stored] = await query(ids.collab, 'comment', [['$id', '==', commentId]])
      if (stored === undefined) throw new Error('the comment is not readable yet')
      expect(stored.properties['vis']).toBe('private')
      const configs = await query(ids.core, 'config', [['repoId', '==', repo.toBase58()]])
      const resolution = await resolveEpochs({
        repoId: R,
        reader: ownerBytes,
        memberships: [{ identity: ownerBytes, role: 'maintainer' }],
        configs: configs.map((c) => ({
          id: privateId(c.id.toBase58()),
          owner: ownerBytes,
          epoch: Number(c.properties['epoch']),
          createdAtBlockHeight: Number(c.createdAtBlockHeight),
          enc: bytesOf(c.properties['enc']),
        })),
        wraps: [{ id: privateId(wrap.id.toBase58()), owner: ownerBytes, memberId: ownerBytes, epoch, recipientKeyId: enc.id, keyEnabled: true, keys }],
      })
      const opened = await openContent(
        {
          type: 'comment',
          vis: 'private',
          ownerId: ownerBytes,
          epoch,
          targetId: T,
          createdAtBlockHeight: Number(stored.createdAtBlockHeight),
          enc: bytesOf(stored.properties['enc']),
        },
        openContextOf(resolution),
      )
      expect(opened).toEqual({ status: 'readable', fields: { body } })
    },
    300000,
  )
})
