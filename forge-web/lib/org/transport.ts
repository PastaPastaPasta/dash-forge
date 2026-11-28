/**
 * The `forge-org` documents on Platform (docs/design/organizations.md §10): every read is proved
 * and every row is checked before use; writes go through Forge's write helpers with the member's
 * own signed-in identity.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { ForgeContractKind, ForgeIds } from '../deployments'
import { base64ToBytes, hexToBase64, queryAllDocuments, queryDocumentsWithProof, type PlainDocument } from '../sdk/query'
import { createDocumentIdempotent, type WriteAuth } from '../sdk/write'
import { base58Encode, decodeIdentifier } from '../auth/base58'
import { DOC_ORG, DOC_ORG_MEMBER, DOC_ORG_MESSAGE, DOC_ORG_SHARE, FMT_DEFLATE, FMT_JSON, MAX_PARTS, PART_BYTES, SEALED_SHARE_MAX, type MemberRow, type MessagePart, type MessageRow, type RosterFields, type ShareRow } from './platform'
import { hex } from './util'

export interface OrgDocRow {
  readonly id: string
  readonly revision: bigint
  readonly fields: RosterFields
}

/** What organizations read and write on Platform. A fake implements it in tests. */
export interface OrgPort {
  orgDoc(orgId: string): Promise<OrgDocRow | null>
  /**
   * `orgMember` rows naming `orgId` with member key `authPub`, earliest first, read page by page
   * until `enough` says the rows so far hold what the reader needs (bounded).
   */
  membersByKey(orgId: string, authPub: string, enough?: (rows: readonly MemberRow[]) => boolean): Promise<MemberRow[]>
  /** `ownerId`'s own `orgMember` rows. */
  membershipsOf(ownerId: string): Promise<MemberRow[]>
  /** `ownerId`'s `orgMessage` rows for `orgId` created at or after `since`, oldest first; a long log comes over several reads. */
  messagesOf(orgId: string, ownerId: string, since: number): Promise<MessageRow[]>
  /** `ownerId`'s sealed share of ceremony `cid` (hex) for `orgId`. */
  shareOf(orgId: string, ownerId: string, cid: string): Promise<ShareRow | null>
  writeMember(auth: WriteAuth, fields: { org: string; room: string; authPub: Uint8Array; proof: Uint8Array }, intent?: string): Promise<void>
  writeShare(auth: WriteAuth, fields: { org: string; cid: Uint8Array; sealed: Uint8Array }, intent?: string): Promise<void>
  /** One message's parts; `intent` names the action, so a retry finishes the same writes. */
  writeMessage(auth: WriteAuth, orgId: string, parts: readonly MessagePart[], intent?: string): Promise<void>
}

export class OrgUnavailableError extends Error {
  constructor() {
    super("Organizations need Forge's organization contract, which isn't on this network yet.")
    this.name = 'OrgUnavailableError'
  }
}

export function orgContractOf(forge: ForgeIds): string | null {
  return forge.org ?? null
}

/** The key scope a forge-org write needs: a key that covers the whole Forge group. */
export const orgWriteScope = (forge: ForgeIds | null): ForgeContractKind[] => (forge?.meta === undefined ? ['core', 'collab', 'community'] : ['core', 'collab', 'community', 'meta'])

const idText = (v: unknown): string | null => (typeof v === 'string' ? v : v instanceof Uint8Array && v.length === 32 ? base58Encode(v) : null)

function bytesOf(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v
  if (Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) return Uint8Array.from(v as number[])
  if (typeof v !== 'string') return null
  try {
    return base64ToBytes(v)
  } catch {
    return null
  }
}

const intOf = (v: unknown): number | null => {
  const n = typeof v === 'bigint' ? Number(v) : v
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null
}

export function memberRowOf(d: PlainDocument): MemberRow | null {
  const id = d['$id']
  const ownerId = idText(d['$ownerId'])
  const org = idText(d['org'])
  const createdAt = intOf(d['$createdAt'])
  const authPub = bytesOf(d['authPub'])
  const proof = bytesOf(d['proof'])
  const room = d['room']
  if (typeof id !== 'string' || !ownerId || !org || createdAt === null || typeof room !== 'string' || authPub?.length !== 32 || proof?.length !== 64) return null
  return { id, ownerId, createdAt, org, room, authPub, proof }
}

export function shareRowOf(d: PlainDocument): ShareRow | null {
  const id = d['$id']
  const ownerId = idText(d['$ownerId'])
  const org = idText(d['org'])
  const cid = bytesOf(d['cid'])
  const sealed = bytesOf(d['sealed'])
  if (typeof id !== 'string' || !ownerId || !org || cid?.length !== 32 || !sealed || sealed.length < 1 || sealed.length > SEALED_SHARE_MAX) return null
  return { id, ownerId, org, cid, sealed }
}

export function messageRowOf(d: PlainDocument): MessageRow | null {
  const id = d['$id']
  const ownerId = idText(d['$ownerId'])
  const createdAt = intOf(d['$createdAt'])
  const digest = bytesOf(d['digest'])
  const body = bytesOf(d['body'])
  const part = intOf(d['part'])
  const parts = intOf(d['parts'])
  const fmt = intOf(d['fmt'])
  if (typeof id !== 'string' || !ownerId || createdAt === null || digest?.length !== 32 || !body || body.length < 1 || body.length > PART_BYTES) return null
  if (part === null || parts === null || fmt === null || parts < 1 || parts > MAX_PARTS || part < 0 || part >= parts || (fmt !== FMT_JSON && fmt !== FMT_DEFLATE)) return null
  return { id, ownerId, createdAt, digest, body, part, parts, fmt }
}

export function orgDocOf(d: PlainDocument, orgId: string): OrgDocRow | null {
  const id = d['$id']
  const r = d['$revision']
  const cid = bytesOf(d['cid'])
  const groupKey = bytesOf(d['groupKey'])
  const members = bytesOf(d['members'])
  const pubShares = bytesOf(d['pubShares'])
  const keyId = intOf(d['keyId'])
  const threshold = intOf(d['threshold'])
  const relay = d['relay']
  if (typeof id !== 'string' || idText(d['$ownerId']) !== orgId || typeof d['room'] !== 'string' || !cid || !groupKey || !members || !pubShares || keyId === null || threshold === null) return null
  if (relay !== undefined && relay !== null && typeof relay !== 'string') return null
  return {
    id,
    revision: typeof r === 'bigint' ? r : BigInt(typeof r === 'number' ? r : 1),
    fields: { room: d['room'], ...(typeof relay === 'string' ? { relay } : {}), cid, keyId, groupKey, threshold, members, pubShares },
  }
}

const MEMBER_PAGE = 50
const MEMBER_PAGES = 20
const MESSAGE_PAGE = 100
const MESSAGE_PAGES = 20

export function platformOrgPort(sdk: EvoSDK, contractId: string): OrgPort {
  const query = (documentTypeName: string, where: [string, '==' | '>=', unknown][], orderBy: [string, 'asc'][], limit: number) =>
    queryDocumentsWithProof(sdk, { dataContractId: contractId, documentTypeName, where, orderBy, limit }).then((r) => r.documents)
  return {
    async orgDoc(orgId) {
      const [doc] = await query(DOC_ORG, [['$ownerId', '==', orgId]], [['$ownerId', 'asc']], 1)
      return doc ? orgDocOf(doc, orgId) : null
    },
    async membersByKey(orgId, authPub, enough = () => false) {
      const rows: MemberRow[] = []
      let startAfter: string | undefined
      for (let page = 0; page < MEMBER_PAGES; page++) {
        const { documents } = await queryDocumentsWithProof(sdk, {
          dataContractId: contractId,
          documentTypeName: DOC_ORG_MEMBER,
          where: [
            ['org', '==', orgId],
            ['authPub', '==', hexToBase64(authPub)],
          ],
          orderBy: [['$createdAt', 'asc']],
          limit: MEMBER_PAGE,
          ...(startAfter ? { startAfter } : {}),
        })
        rows.push(...documents.flatMap((d) => memberRowOf(d) ?? []).filter((r) => r.org === orgId && hex(r.authPub) === authPub))
        const last = documents.at(-1)?.['$id']
        if (documents.length < MEMBER_PAGE || typeof last !== 'string' || enough(rows)) break
        startAfter = last
      }
      return rows
    },
    async membershipsOf(ownerId) {
      const docs = await queryAllDocuments(sdk, { dataContractId: contractId, documentTypeName: DOC_ORG_MEMBER, where: [['$ownerId', '==', ownerId]], orderBy: [['$ownerId', 'asc'], ['org', 'asc']] }, { maxPages: 4 })
      return docs.flatMap((d) => memberRowOf(d) ?? []).filter((r) => r.ownerId === ownerId)
    },
    async messagesOf(orgId, ownerId, since) {
      const rows: MessageRow[] = []
      let startAfter: string | undefined
      for (let page = 0; page < MESSAGE_PAGES; page++) {
        const { documents } = await queryDocumentsWithProof(sdk, {
          dataContractId: contractId,
          documentTypeName: DOC_ORG_MESSAGE,
          where: [
            ['org', '==', orgId],
            ['$ownerId', '==', ownerId],
            ['$createdAt', '>=', since],
          ],
          orderBy: [['$createdAt', 'asc']],
          limit: MESSAGE_PAGE,
          ...(startAfter ? { startAfter } : {}),
        })
        rows.push(...documents.flatMap((d) => (idText(d['org']) === orgId ? (messageRowOf(d) ?? []) : [])).filter((r) => r.ownerId === ownerId))
        const last = documents.at(-1)?.['$id']
        if (documents.length < MESSAGE_PAGE || typeof last !== 'string') break
        startAfter = last
      }
      return rows
    },
    async shareOf(orgId, ownerId, cid) {
      const [doc] = await query(
        DOC_ORG_SHARE,
        [
          ['org', '==', orgId],
          ['$ownerId', '==', ownerId],
          ['cid', '==', hexToBase64(cid)],
        ],
        [['cid', 'asc']],
        1,
      )
      const row = doc ? shareRowOf(doc) : null
      return row !== null && row.org === orgId && row.ownerId === ownerId && hex(row.cid) === cid ? row : null
    },
    async writeShare(auth, f, intent) {
      await createDocumentIdempotent(sdk, auth, { contractId, documentType: DOC_ORG_SHARE, data: { ...f, org: decodeIdentifier(f.org) }, contentKey: `share:${f.org}:${hex(f.cid)}`, ...(intent ? { intent: `${intent}:share` } : {}) })
    },
    async writeMember(auth, f, intent) {
      await createDocumentIdempotent(sdk, auth, { contractId, documentType: DOC_ORG_MEMBER, data: { ...f, org: decodeIdentifier(f.org) }, contentKey: `member:${f.org}:${hex(f.authPub)}`, ...(intent ? { intent: `${intent}:member` } : {}) })
    },
    async writeMessage(auth, orgId, parts, intent) {
      for (const p of parts) {
        const key = `${hex(p.digest)}:${p.part}`
        await createDocumentIdempotent(sdk, auth, {
          contractId,
          documentType: DOC_ORG_MESSAGE,
          data: { org: decodeIdentifier(orgId), digest: p.digest, part: p.part, parts: p.parts, fmt: p.fmt, body: p.body },
          contentKey: key,
          ...(intent ? { intent: `${intent}:${key}` } : {}),
        })
      }
    },
  }
}
