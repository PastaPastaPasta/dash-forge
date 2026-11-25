import { participantKeys, seedFromMnemonic, type MemberKeys } from './derive'

export interface OrgMember {
  readonly index: number
  readonly name: string
  readonly authPub: string
}

export interface OrgRecord {
  readonly network: string
  readonly orgId: string
  readonly room: string
  readonly relay: string
  readonly authPub: string
  readonly label: string
  readonly threshold: number
  readonly members: readonly OrgMember[]
}

const storageKey = (network: string): string => `forge:orgs:${network}`
const listeners = new Set<() => void>()
const cache = new Map<string, readonly OrgRecord[]>()
const EMPTY: readonly OrgRecord[] = []

function validRecord(r: unknown): r is OrgRecord {
  const o = r as OrgRecord
  return (
    o !== null &&
    typeof o === 'object' &&
    typeof o.orgId === 'string' &&
    typeof o.room === 'string' &&
    typeof o.relay === 'string' &&
    /^https:\/\//.test(o.relay) &&
    typeof o.authPub === 'string' &&
    typeof o.label === 'string' &&
    Number.isInteger(o.threshold) &&
    Array.isArray(o.members)
  )
}

function read(network: string): readonly OrgRecord[] {
  const hit = cache.get(network)
  if (hit) return hit
  let list: readonly OrgRecord[] = EMPTY
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(network))
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    if (Array.isArray(parsed)) list = parsed.filter(validRecord).filter((r) => r.network === network)
  } catch {
    list = EMPTY
  }
  cache.set(network, list)
  return list
}

function write(network: string, list: readonly OrgRecord[]): void {
  cache.set(network, list)
  try {
    globalThis.localStorage?.setItem(storageKey(network), JSON.stringify(list))
  } catch {
    /* storage unavailable: kept for this tab */
  }
  for (const l of listeners) l()
}

export function connectedOrgs(network: string): readonly OrgRecord[] {
  return read(network)
}

export function connectedOrg(network: string, orgId: string): OrgRecord | null {
  return read(network).find((r) => r.orgId === orgId) ?? null
}

export function saveOrg(record: OrgRecord): void {
  const list = read(record.network).filter((r) => r.orgId !== record.orgId)
  write(record.network, [...list, record])
}

export function forgetOrg(network: string, orgId: string): void {
  write(
    network,
    read(network).filter((r) => r.orgId !== orgId),
  )
}

export function subscribeOrgs(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent): void => {
    if (e.key?.startsWith('forge:orgs:')) {
      cache.clear()
      listener()
    }
  }
  globalThis.addEventListener?.('storage', onStorage)
  return () => {
    listeners.delete(listener)
    globalThis.removeEventListener?.('storage', onStorage)
  }
}

export interface Unlocked {
  readonly seed: Uint8Array
  readonly keys: MemberKeys
}

const unlocked = new Map<string, Unlocked>()
const unlockListeners = new Set<() => void>()
let unlockVersion = 0

export class NotAMemberError extends Error {
  constructor() {
    super("This seed phrase doesn't belong to a member of this organization. Check the words and the passphrase.")
    this.name = 'NotAMemberError'
  }
}

export function unlockPhrase(phrase: string, passphrase: string, members: readonly string[]): Unlocked {
  const seed = seedFromMnemonic(phrase, passphrase)
  const u = { seed, keys: participantKeys(seed) }
  if (!members.includes(u.keys.authPub)) {
    seed.fill(0)
    throw new NotAMemberError()
  }
  unlocked.set(u.keys.authPub, u)
  unlockVersion++
  for (const l of unlockListeners) l()
  return u
}

export function unlockedFor(authPub: string): Unlocked | null {
  return unlocked.get(authPub) ?? null
}

export function lockAll(): void {
  for (const u of unlocked.values()) {
    u.seed.fill(0)
    u.keys.authSecret.fill(0)
    u.keys.transportSecret.fill(0)
  }
  unlocked.clear()
  unlockVersion++
  for (const l of unlockListeners) l()
}

export function subscribeUnlock(listener: () => void): () => void {
  unlockListeners.add(listener)
  return () => unlockListeners.delete(listener)
}

export const unlockGeneration = (): number => unlockVersion
