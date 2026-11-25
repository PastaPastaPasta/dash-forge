import { sha512 } from '@noble/hashes/sha2.js'

import { G1, bytesToScalar, evalCommitments, evalPoly, g1, g1Hex, mod, scalarFromHex, R as ORDER } from './bls'
import { dkgCoefficients, type MemberKeys } from './derive'
import { PROTOCOL, boxContext, decryptBox } from './envelope'
import { ROOM_PATTERN, assert, digest, isHex, lengthPrefixed } from './util'

const PURPOSES = ['AUTHENTICATION', 'ENCRYPTION', 'DECRYPTION', 'TRANSFER', 'VOTING', 'OWNER']
const SECURITY_LEVELS = ['MASTER', 'CRITICAL', 'HIGH', 'MEDIUM']
const MAX_REVEAL_BYTES = 240 * 1024
const estimatedRevealSize = (n: number, t: number, slots: number): number => 400 + slots * (300 + t * 100 + (n - 1) * 180)
export const SLOT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const DEVNET = /^devnet-(?!(?:mainnet|testnet|local|regtest|devnet)$)([a-z0-9][a-z0-9-]{0,27})$/

export const isDtiNetwork = (id: unknown): boolean => id === 'mainnet' || id === 'testnet' || id === 'local' || DEVNET.test(String(id))

export interface Participant {
  readonly index: number
  readonly name: string
  readonly authPub: string
  readonly transportPub: string
}

export interface KeySlot {
  readonly slot: string
  readonly keyId: number
  readonly purpose: string
  readonly securityLevel: string
}

export interface CeremonyConfig {
  readonly protocol: string
  readonly room: string
  readonly network: string
  readonly label: string
  readonly threshold: number
  readonly organizer: string
  readonly participants: readonly Participant[]
  readonly keys: readonly KeySlot[]
  readonly createdAt: string
}

export interface SlotReveal {
  readonly commitments: readonly string[]
  readonly pok: { readonly R: string; readonly z: string }
  readonly boxes: Readonly<Record<string, string>>
}

export interface Reveal {
  readonly cid: string
  readonly index: number
  readonly slots: Readonly<Record<string, SlotReveal>>
}

export function validateConfig(config: unknown): CeremonyConfig {
  const c = config as CeremonyConfig
  assert(c && typeof c === 'object', 'config must be an object')
  assert(c.protocol === PROTOCOL, `unsupported protocol ${String(c.protocol)}`)
  assert(typeof c.room === 'string' && ROOM_PATTERN.test(c.room), 'config must name its room')
  assert(isDtiNetwork(c.network), 'network must be mainnet, testnet, devnet-<name> or local')
  assert(typeof c.label === 'string' && c.label.length > 0 && c.label.length <= 120, 'label must be 1-120 characters')
  assert(Array.isArray(c.participants) && Array.isArray(c.keys), 'participants and keys must be lists')
  const n = c.participants.length
  assert(n >= 2 && n <= 64, 'between 2 and 64 participants')
  assert(Number.isInteger(c.threshold) && c.threshold >= 2 && c.threshold <= n, `threshold must be between 2 and ${n}`)
  const auth = new Set<string>()
  const transport = new Set<string>()
  c.participants.forEach((p, i) => {
    assert(p.index === i + 1, 'participant indices must be 1..n in order')
    assert(isHex(p.authPub, 32) && isHex(p.transportPub, 32), `participant ${p.index} has malformed keys`)
    assert(typeof p.name === 'string' && p.name.length <= 64, `participant ${p.index} has a bad name`)
    auth.add(p.authPub)
    transport.add(p.transportPub)
  })
  assert(auth.size === n && transport.size === n, 'participant keys must be unique')
  assert(
    c.participants.some((p) => p.authPub === c.organizer),
    'organizer must be a participant',
  )
  assert(c.keys.length >= 1, 'at least one key slot')
  const slots = new Set<string>()
  const ids = new Set<number>()
  for (const k of c.keys) {
    assert(SLOT_PATTERN.test(k.slot), `bad slot name ${k.slot}`)
    assert(Number.isInteger(k.keyId) && k.keyId >= 0 && k.keyId < 1000, `bad keyId for ${k.slot}`)
    assert(PURPOSES.includes(k.purpose) && SECURITY_LEVELS.includes(k.securityLevel), `bad purpose/level for ${k.slot}`)
    slots.add(k.slot)
    ids.add(k.keyId)
  }
  assert(slots.size === c.keys.length && ids.size === c.keys.length, 'slot names and keyIds must be unique')
  assert(estimatedRevealSize(n, c.threshold, c.keys.length) <= MAX_REVEAL_BYTES, 'too many members or key slots')
  return c
}

export const ceremonyId = (config: CeremonyConfig): string => digest({ ceremony: config })

export function participantIndex(config: CeremonyConfig, authPub: string): number | null {
  return config.participants.find((p) => p.authPub === authPub)?.index ?? null
}

const pokContext = (cid: string, slot: string, index: number): Uint8Array => lengthPrefixed(`${PROTOCOL}/pok`, cid, slot, index)

function pokVerify(commitmentHex: string, proof: { R: string; z: string }, cid: string, slot: string, index: number): boolean {
  try {
    const A = G1.fromHex(commitmentHex)
    const Rp = G1.fromHex(proof.R)
    const c = mod(bytesToScalar(sha512(lengthPrefixed(pokContext(cid, slot, index), Rp.toBytes(true), A.toBytes(true)))))
    return g1(scalarFromHex(proof.z)).equals(Rp.add(A.multiply(c)))
  } catch {
    return false
  }
}

export const revealDigest = (reveal: unknown): string => digest({ reveal })

const sameKeys = (o: unknown, keys: readonly string[]): boolean =>
  o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join('\u0000') === [...keys].sort().join('\u0000')

export function checkRevealShape(config: CeremonyConfig, cid: string, reveal: unknown, index: number): string[] {
  try {
    return revealShapeProblems(config, cid, reveal as Reveal, index)
  } catch (e) {
    return [`malformed reveal: ${e instanceof Error ? e.message : String(e)}`]
  }
}

function revealShapeProblems(config: CeremonyConfig, cid: string, reveal: Reveal, index: number): string[] {
  const problems: string[] = []
  if (!sameKeys(reveal, ['cid', 'index', 'slots']) || !sameKeys(reveal.slots, config.keys.map((k) => k.slot))) return ['reveal has missing or unexpected fields']
  if (reveal.cid !== cid || reveal.index !== index) problems.push('reveal is for another ceremony or index')
  for (const { slot } of config.keys) {
    const s = reveal.slots[slot] as SlotReveal
    if (!sameKeys(s, ['commitments', 'pok', 'boxes']) || !sameKeys(s.pok, ['R', 'z']) || !isHex(s.pok.z, 32) || !isHex(s.pok.R, 48)) {
      problems.push(`${slot}: malformed`)
      continue
    }
    if (!Array.isArray(s.commitments) || !s.commitments.every((c) => isHex(c, 48)) || !Object.values(s.boxes ?? {}).every((b) => isHex(b))) {
      problems.push(`${slot}: malformed`)
      continue
    }
    if (s.commitments.length !== config.threshold) problems.push(`${slot}: expected ${config.threshold} commitments`)
    else if (!pokVerify(s.commitments[0] as string, s.pok, cid, slot, index)) problems.push(`${slot}: bad proof of knowledge`)
    else if (G1.fromHex(s.commitments[config.threshold - 1] as string).equals(G1.ZERO)) problems.push(`${slot}: degenerate polynomial`)
    const expected = config.participants
      .filter((p) => p.index !== index)
      .map((p) => String(p.index))
      .sort()
    if (Object.keys(s.boxes ?? {}).sort().join() !== expected.join()) problems.push(`${slot}: boxes do not cover every other participant`)
  }
  return problems
}

export interface SlotKeys {
  readonly groupPublicKey: string
  readonly publicShares: Readonly<Record<number, string>>
}

export function groupKeys(config: CeremonyConfig, reveals: Readonly<Record<number, Reveal>>): Record<string, SlotKeys> {
  const out: Record<string, SlotKeys> = {}
  for (const { slot } of config.keys) {
    const commitmentSets = config.participants.map((p) => (reveals[p.index] as Reveal).slots[slot]!.commitments)
    const groupPublicKey = commitmentSets.reduce((acc, c) => acc.add(G1.fromHex(c[0] as string)), G1.ZERO)
    const publicShares: Record<number, string> = {}
    for (const p of config.participants) {
      publicShares[p.index] = g1Hex(commitmentSets.reduce((acc, c) => acc.add(evalCommitments(c, p.index)), G1.ZERO))
    }
    assert(!groupPublicKey.equals(G1.ZERO), `${slot}: group public key is the identity point`)
    const top = commitmentSets.reduce((acc, c) => acc.add(G1.fromHex(c[config.threshold - 1] as string)), G1.ZERO)
    assert(!top.equals(G1.ZERO), `${slot}: joint polynomial has degree below threshold-1`)
    out[slot] = { groupPublicKey: g1Hex(groupPublicKey), publicShares }
  }
  return out
}

export function transcriptDigest(cid: string, config: CeremonyConfig, revealDigests: Readonly<Record<number, string>>): string {
  return digest({ transcript: cid, reveals: config.participants.map((p) => revealDigests[p.index]) })
}

function parseShare(text: string): bigint | null {
  if (!/^[0-9a-f]{64}$/.test(text)) return null
  const v = BigInt(`0x${text}`)
  return v < ORDER ? v : null
}

export function receiveShares(
  seed: Uint8Array,
  keys: MemberKeys,
  config: CeremonyConfig,
  cid: string,
  reveals: Readonly<Record<number, Reveal>>,
): { shares: Record<string, bigint>; problems: string[] } {
  const me = participantIndex(config, keys.authPub)
  assert(me, 'you are not a participant in this ceremony')
  const shares: Record<string, bigint> = {}
  const problems: string[] = []
  for (const { slot } of config.keys) {
    let share = evalPoly(dkgCoefficients(seed, cid, slot, config.threshold), me)
    for (const p of config.participants) {
      if (p.index === me) continue
      const reveal = reveals[p.index]
      if (!reveal) {
        problems.push(`${slot}: no reveal from ${p.index}`)
        continue
      }
      const s = reveal.slots[slot] as SlotReveal
      const ctx = boxContext({ cid, slot, from: p.index, to: me, fromTransport: p.transportPub, toTransport: keys.transportPub })
      let value: bigint | null
      try {
        value = parseShare(decryptBox(keys.transportSecret, p.transportPub, ctx, s.boxes[String(me)] as string))
      } catch {
        problems.push(`${slot}: share box from ${p.index} does not decrypt`)
        continue
      }
      if (value === null || !g1(value).equals(evalCommitments(s.commitments, me))) {
        problems.push(`${slot}: share from ${p.index} does not match its commitments`)
        continue
      }
      share = mod(share + value)
    }
    shares[slot] = share
  }
  return { shares, problems }
}

export const publicShareOf = (share: bigint): string => g1Hex(g1(share))
