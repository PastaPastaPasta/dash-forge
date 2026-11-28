import { participantKeys, seedFromMnemonic, type MemberKeys } from './derive'
import { effectiveRaw, notePrefWrite } from '../user-sync/overlay'

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
  /** The Forge identity whose `orgMember` binds `authPub`, once known. */
  readonly identityId?: string
  /** Every member key that identity bound to the organization, newest first (after a ceremony re-run there are several). */
  readonly boundKeys?: readonly string[]
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
    const raw = effectiveRaw(storageKey(network), globalThis.localStorage?.getItem(storageKey(network)) ?? null)
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
    notePrefWrite(storageKey(network))
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

/** Remembers `record`, replacing this identity's record for the organization (and an older one for the same member key). */
export function saveOrg(record: OrgRecord): void {
  const replaces = (r: OrgRecord): boolean => r.orgId === record.orgId && (r.identityId === record.identityId || (r.identityId === undefined && r.authPub === record.authPub))
  write(record.network, [...read(record.network).filter((r) => !replaces(r)), record])
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

const ceremonyKey = (network: string, orgId: string): string => `forge:org-ceremony:${network}:${orgId}`

/** The key ceremony's messages, kept when a member connects (§10.4): public values only. */
export function cachedCeremony(network: string, orgId: string): unknown[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(ceremonyKey(network, orgId))
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function cacheCeremony(network: string, orgId: string, messages: readonly unknown[]): void {
  try {
    globalThis.localStorage?.setItem(ceremonyKey(network, orgId), JSON.stringify(messages))
  } catch {
    /* storage full or unavailable: read again from the relay next time */
  }
}

const dismissedKey = (network: string, orgId: string): string => `forge:org-dismissed:${network}:${orgId}`
const dismissListeners = new Set<() => void>()
const dismissed = new Map<string, ReadonlySet<string>>()

/** The requests dismissed on this device; the same set until one more is dismissed. */
export function dismissedRequests(network: string, orgId: string): ReadonlySet<string> {
  const key = dismissedKey(network, orgId)
  const hit = dismissed.get(key)
  if (hit) return hit
  let set: ReadonlySet<string> = new Set()
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(key) ?? '[]') as unknown
    if (Array.isArray(parsed)) set = new Set(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    /* unreadable: nothing dismissed */
  }
  dismissed.set(key, set)
  return set
}

/** Hides a request Forge won't sign on this device (§11.1): nothing is written anywhere. */
export function dismissRequest(network: string, orgId: string, requestId: string): void {
  const key = dismissedKey(network, orgId)
  const next = new Set([...dismissedRequests(network, orgId), requestId])
  dismissed.set(key, next)
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify([...next].slice(-500)))
  } catch {
    /* kept for this tab */
  }
  for (const l of dismissListeners) l()
}

export function subscribeDismissed(listener: () => void): () => void {
  dismissListeners.add(listener)
  return () => dismissListeners.delete(listener)
}
