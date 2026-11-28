import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { Inflate, deflateSync } from 'fflate'

import { verifyEnvelope, type Envelope } from './envelope'
import { canonical, hex, utf8 } from './util'

export const DOC_ORG = 'org'
export const DOC_ORG_MEMBER = 'orgMember'
export const DOC_ORG_MESSAGE = 'orgMessage'
export const DOC_ORG_SHARE = 'orgShare'

export const PART_BYTES = 5120
export const MAX_PARTS = 16
export const FMT_JSON = 0
export const FMT_DEFLATE = 1
export const MEMBER_IDENTITIES_PER_KEY = 4
export const SEALED_SHARE_MAX = 128
const MAX_MESSAGE_BYTES = PART_BYTES * MAX_PARTS
export const MAX_PAYLOAD = 266_240

export const MESSAGE_TYPES: ReadonlySet<string> = new Set(['proposal', 'approve', 'reject', 'broadcast'])

export interface MessagePart {
  readonly digest: Uint8Array
  readonly part: number
  readonly parts: number
  readonly fmt: number
  readonly body: Uint8Array
}

export interface MessageRow extends MessagePart {
  readonly id: string
  readonly ownerId: string
  readonly createdAt: number
}

export function storedPayload(envelope: Envelope): { fmt: number; payload: Uint8Array } {
  const raw = utf8(canonical(envelope))
  const packed = deflateSync(raw, { level: 9 })
  return packed.length < raw.length ? { fmt: FMT_DEFLATE, payload: packed } : { fmt: FMT_JSON, payload: raw }
}

export function encodeMessage(envelope: Envelope): MessagePart[] {
  const { fmt, payload } = storedPayload(envelope)
  if (payload.length > MAX_MESSAGE_BYTES) throw new Error('this request is too large to post on Platform')
  const digest = sha256(payload)
  const parts = Math.max(1, Math.ceil(payload.length / PART_BYTES))
  return Array.from({ length: parts }, (_, part) => ({ digest, part, parts, fmt, body: payload.slice(part * PART_BYTES, (part + 1) * PART_BYTES) }))
}

export interface CarriedEnvelope {
  readonly envelope: Envelope
  readonly createdAt: number
}

function decodePayload(fmt: number, payload: Uint8Array): unknown {
  const bytes = fmt === FMT_DEFLATE ? inflateExact(payload) : payload
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const value = JSON.parse(text) as unknown
  return canonical(value) === text ? value : null
}

/** Input fed to the inflater at a time: deflate expands a byte at most about 1,032 times, so one step stays small. */
const INFLATE_STEP = 256

/** The one deflate stream `payload` holds, stopped as soon as its output passes {@link MAX_PAYLOAD}; throws when cut short. */
function inflateBounded(payload: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = []
  let total = 0
  const inflate = new Inflate((chunk) => {
    total += chunk.length
    if (total > MAX_PAYLOAD) throw new Error('message too large')
    chunks.push(chunk)
  })
  for (let at = 0; at < payload.length; at += INFLATE_STEP) inflate.push(payload.subarray(at, at + INFLATE_STEP), at + INFLATE_STEP >= payload.length)
  return concatBytes(...chunks)
}

/** The payload inflated, refusing anything but exactly one stream ending at its last byte. */
function inflateExact(payload: Uint8Array): Uint8Array {
  const out = inflateBounded(payload)
  if (endsEarly(payload)) throw new Error('bytes after the deflate stream')
  return out
}

/** A raw deflate stream's last byte always holds some of its bits: one that still inflates without it had bytes after its end. */
function endsEarly(payload: Uint8Array): boolean {
  if (payload.length < 2) return false
  try {
    inflateBounded(payload.subarray(0, -1))
    return true
  } catch {
    return false
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * The envelopes one owner's `orgMessage` documents carry: a message counts when every part from
 * that owner is present, they agree on `parts` and `fmt`, and the joined bodies hash to `digest`.
 * Each envelope must be canonical JSON, verify, be one of the four request types, name `room`,
 * and, given `from`, be sent by the member key the owner is bound to.
 */
export function reassemble(rows: readonly MessageRow[], room: string, from?: string): CarriedEnvelope[] {
  const groups = new Map<string, MessageRow[]>()
  for (const r of rows) {
    const key = `${r.ownerId}|${hex(r.digest)}`
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }
  const out: CarriedEnvelope[] = []
  for (const list of groups.values()) {
    const head = list[0] as MessageRow
    const byPart = new Map<number, MessageRow>()
    for (const r of [...list].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) if (!byPart.has(r.part)) byPart.set(r.part, r)
    if (head.parts < 1 || head.parts > MAX_PARTS || byPart.size !== head.parts) continue
    const ordered = Array.from({ length: head.parts }, (_, i) => byPart.get(i))
    if (ordered.some((r) => r === undefined || r.parts !== head.parts || r.fmt !== head.fmt)) continue
    const payload = concatBytes(...ordered.map((r) => (r as MessageRow).body))
    if (!sameBytes(sha256(payload), head.digest)) continue
    let value: unknown
    try {
      value = decodePayload(head.fmt, payload)
    } catch {
      continue
    }
    if (!verifyEnvelope(value) || value.room !== room || !MESSAGE_TYPES.has(value.type) || (from !== undefined && value.from !== from)) continue
    out.push({ envelope: value, createdAt: Math.max(...ordered.map((r) => (r as MessageRow).createdAt)) })
  }
  return out
}

/**
 * Every member log merged: one copy per envelope, ordered by when Platform first carried it (then
 * envelope id), with that time as the `at` the requests are ordered and shown by.
 */
export function mergeLogs(logs: readonly (readonly CarriedEnvelope[])[], idOf: (e: Envelope) => string): { envelopes: Envelope[]; carriedAt: Map<string, string> } {
  const first = new Map<string, CarriedEnvelope & { id: string }>()
  for (const log of logs) {
    for (const c of log) {
      const id = idOf(c.envelope)
      const seen = first.get(id)
      if (!seen || c.createdAt < seen.createdAt) first.set(id, { ...c, id })
    }
  }
  const ordered = [...first.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { envelopes: ordered.map((c) => c.envelope), carriedAt: new Map(ordered.map((c) => [c.id, new Date(c.createdAt).toISOString()])) }
}

export function memberProofMessage(network: string, orgId: string, ownerId: string): Uint8Array {
  return utf8(`dash-forge/org-member/1\n${network}\n${orgId}\n${ownerId}`)
}

export function signMemberProof(authSecret: Uint8Array, network: string, orgId: string, ownerId: string): Uint8Array {
  return ed25519.sign(memberProofMessage(network, orgId, ownerId), authSecret)
}

export function verifyMemberProof(authPub: Uint8Array, proof: Uint8Array, network: string, orgId: string, ownerId: string): boolean {
  try {
    return proof.length === 64 && authPub.length === 32 && ed25519.verify(proof, memberProofMessage(network, orgId, ownerId), authPub)
  } catch {
    return false
  }
}

function shareKey(seed: Uint8Array, network: string, orgId: string, cid: string): Uint8Array {
  return hkdf(sha256, seed, utf8('dash-forge/org-share/1'), utf8(`${network}\n${orgId}\n${cid}`), 32)
}

export function sealShare(seed: Uint8Array, network: string, orgId: string, cid: string, share: bigint, nonce = crypto.getRandomValues(new Uint8Array(24))): Uint8Array {
  const plain = scalarBytes(share)
  const sealed = concatBytes(nonce, xchacha20poly1305(shareKey(seed, network, orgId, cid), nonce).encrypt(plain))
  plain.fill(0)
  return sealed
}

export function openShare(seed: Uint8Array, network: string, orgId: string, cid: string, sealed: Uint8Array): bigint | null {
  if (sealed.length < 24 + 16 + 1 || sealed.length > SEALED_SHARE_MAX) return null
  try {
    const plain = xchacha20poly1305(shareKey(seed, network, orgId, cid), sealed.slice(0, 24)).decrypt(sealed.slice(24))
    const v = plain.length === 32 ? BigInt(`0x${hex(plain)}`) : null
    plain.fill(0)
    return v
  } catch {
    return null
  }
}

function scalarBytes(s: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = s
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

export interface MemberRow {
  readonly id: string
  readonly ownerId: string
  readonly createdAt: number
  readonly org: string
  readonly room: string
  readonly authPub: Uint8Array
  readonly proof: Uint8Array
}

export interface ShareRow {
  readonly id: string
  readonly ownerId: string
  readonly org: string
  readonly cid: Uint8Array
  readonly sealed: Uint8Array
}

const proofChecks = new Map<string, boolean>()

/**
 * Up to {@link MEMBER_IDENTITIES_PER_KEY} identities per member key, earliest first, counting only
 * rows whose proof verifies for a roster member.
 */
export function memberIdentities(rows: readonly MemberRow[], network: string, orgId: string, members: readonly string[]): MemberRow[] {
  const keys = new Set(members)
  const per = new Map<string, MemberRow[]>()
  for (const r of [...rows].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    const key = hex(r.authPub)
    const list = per.get(key) ?? []
    if (r.org !== orgId || !keys.has(key) || list.length >= MEMBER_IDENTITIES_PER_KEY || list.some((x) => x.ownerId === r.ownerId)) continue
    const k = `${network}|${r.id}|${hex(r.proof)}`
    const ok = proofChecks.get(k) ?? verifyMemberProof(r.authPub, r.proof, network, orgId, r.ownerId)
    proofChecks.set(k, ok)
    if (!ok) continue
    list.push(r)
    per.set(key, list)
  }
  return [...per.values()].flat()
}

export interface RosterFields {
  readonly room: string
  readonly relay?: string
  readonly cid: Uint8Array
  readonly keyId: number
  readonly groupKey: Uint8Array
  readonly threshold: number
  readonly members: Uint8Array
  readonly pubShares: Uint8Array
}

