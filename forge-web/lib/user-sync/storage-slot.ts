/**
 * The `storage` slot (docs/design/identity-synced-state.md §4, §7) against the web app's
 * {@link StorageConfig}: keys `profile:<name>` ({settings, secrets}), `default` (a policy),
 * `repo:<repoId>` (a policy) and `test:<name>`. A synced value this build cannot read stays in the
 * synced map untouched and is left out of the view.
 */

import { z } from 'zod'

import { policySchema, profilePublicSchema, profileSecretsSchema, validProfileName, type StoragePolicy, type StorageProfile } from '../storage/profiles'
import type { StorageConfig } from '../storage/store'
import { canonicalJson } from './crypto'

/** The most profiles the local blob holds (`lib/storage/store.ts`): an older build refuses more. */
export const LOCAL_PROFILE_CAP = 32

const profileValue = z.object({ settings: profilePublicSchema, secrets: profileSecretsSchema })
const testValue = z.object({ at: z.number(), ok: z.boolean() })

/** A local profile value written with the parts of its synced namesake this build does not model. */
export function carryProfileExtras(key: string, synced: unknown, local: unknown): unknown {
  if (!key.startsWith('profile:') || synced === null || typeof synced !== 'object' || Array.isArray(synced)) return local
  if (local === null || typeof local !== 'object' || Array.isArray(local)) return local
  const extras = Object.fromEntries(Object.entries(synced).filter(([k]) => k !== 'settings' && k !== 'secrets'))
  return Object.keys(extras).length === 0 ? local : { ...extras, ...local }
}

/** The slot's entries for a local config. */
export function storageEntries(config: StorageConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of config.profiles) out[`profile:${p.name}`] = { settings: p.settings, secrets: p.secrets }
  if (config.defaultPolicy !== null) out['default'] = config.defaultPolicy
  for (const [repo, policy] of Object.entries(config.repoPolicies)) out[`repo:${repo}`] = policy
  for (const [name, t] of Object.entries(config.lastTests)) out[`test:${name}`] = t
  return out
}

export function profileOf(name: string, v: unknown): StorageProfile | null {
  if (!validProfileName(name)) return null
  const parsed = profileValue.safeParse(v)
  return parsed.success ? ({ name, settings: parsed.data.settings, secrets: parsed.data.secrets } as StorageProfile) : null
}

function policyOf(v: unknown): StoragePolicy | null {
  const parsed = policySchema.safeParse(v)
  return parsed.success ? parsed.data : null
}

/** `name` kept beside a synced profile of the same name: `<name>-<device short id>`. */
export function collisionName(name: string, deviceId: string): string {
  const suffix = `-${deviceId}`
  return `${name.slice(0, 64 - suffix.length)}${suffix}`
}

/** The names a local profile may be shown under beside a synced namesake, in order: the first free one is used. */
function collisionNames(name: string, deviceId: string): string[] {
  return [collisionName(name, deviceId), ...Array.from({ length: 8 }, (_, i) => collisionName(name, `${deviceId}-${i + 2}`))]
}

/**
 * The effective config: the merged values, plus each local profile whose synced namesake differs,
 * kept as {@link collisionName} (nothing local is dropped from sight).
 */
export function storageView(view: Readonly<Record<string, unknown>>, collisions: readonly string[], local: StorageConfig, deviceId: string): StorageConfig {
  const profiles: StorageProfile[] = []
  let defaultPolicy: StoragePolicy | null = null
  const repoPolicies: Record<string, StoragePolicy> = {}
  const lastTests: Record<string, { at: number; ok: boolean }> = {}
  for (const [key, v] of Object.entries(view)) {
    if (key.startsWith('profile:')) {
      const p = profileOf(key.slice('profile:'.length), v)
      if (p) profiles.push(p)
    } else if (key === 'default') defaultPolicy = policyOf(v)
    else if (key.startsWith('repo:')) {
      const p = policyOf(v)
      if (p) repoPolicies[key.slice('repo:'.length)] = p
    } else if (key.startsWith('test:')) {
      const t = testValue.safeParse(v)
      if (t.success) lastTests[key.slice('test:'.length)] = t.data
    }
  }
  for (const key of collisions) {
    if (!key.startsWith('profile:')) continue
    const own = local.profiles.find((p) => `profile:${p.name}` === key)
    if (!own) continue
    // A name neither synced nor local: a synced profile of the plain collision name never hides this one.
    const name = collisionNames(own.name, deviceId).find((n) => !profiles.some((p) => p.name === n) && !local.profiles.some((p) => p.name === n))
    if (name !== undefined) profiles.push({ ...own, name })
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name))
  return { version: 1, profiles, defaultPolicy, repoPolicies, lastTests }
}

/**
 * `local` with the merged values of keys it lacks added (write-through), never more than
 * {@link LOCAL_PROFILE_CAP} profiles; null when nothing is added. Nothing local changes or goes.
 */
export function withAdditions(local: StorageConfig, add: Readonly<Record<string, unknown>>): StorageConfig | null {
  const profiles = [...local.profiles]
  let defaultPolicy = local.defaultPolicy
  const repoPolicies = { ...local.repoPolicies }
  const lastTests = { ...local.lastTests }
  let added = false
  for (const [key, v] of Object.entries(add).sort(([a], [b]) => a.localeCompare(b))) {
    if (key.startsWith('profile:')) {
      const p = profileOf(key.slice('profile:'.length), v)
      if (!p || profiles.length >= LOCAL_PROFILE_CAP || profiles.some((x) => x.name === p.name)) continue
      profiles.push(p)
      added = true
    } else if (key === 'default') {
      const p = policyOf(v)
      if (!p || defaultPolicy !== null) continue
      defaultPolicy = p
      added = true
    } else if (key.startsWith('repo:')) {
      const repo = key.slice('repo:'.length)
      const p = policyOf(v)
      if (!p || repo.length > 64 || repoPolicies[repo] !== undefined) continue
      repoPolicies[repo] = p
      added = true
    } else if (key.startsWith('test:')) {
      const name = key.slice('test:'.length)
      const t = testValue.safeParse(v)
      if (!t.success || name.length > 64 || lastTests[name] !== undefined) continue
      lastTests[name] = t.data
      added = true
    }
  }
  if (!added) return null
  profiles.sort((a, b) => a.name.localeCompare(b.name))
  return { version: 1, profiles, defaultPolicy, repoPolicies, lastTests }
}

/** A save past {@link LOCAL_PROFILE_CAP} with the profiles the view hides counted. */
export class LocalProfileCapError extends Error {
  constructor(hidden: number) {
    super(`This browser keeps at most ${LOCAL_PROFILE_CAP} storage profiles, ${hidden} of them hidden here because another device deleted or replaced them. Remove a profile first.`)
    this.name = 'LocalProfileCapError'
  }
}

/**
 * What a Settings save of the effective config writes locally: `next`, plus the local profiles the
 * view hid (deleted elsewhere, or replaced by a synced namesake) that the user did not touch. A
 * local profile shown under its collision name and left as it was stays local under its own name
 * (it is never uploaded as a copy). `shown` is the effective config the user edited.
 */
export function localAfterSave(local: StorageConfig, shown: StorageConfig, next: StorageConfig, deviceId: string): StorageConfig {
  const byName = (c: StorageConfig, name: string): StorageProfile | undefined => c.profiles.find((p) => p.name === name)
  const keepLocal = new Set<string>()
  const dropCopies = new Set<string>()
  // Names the saved policies use: a profile they name stays under that name in the blob.
  const named = new Set([...(next.defaultPolicy?.targets ?? []), ...Object.values(next.repoPolicies).flatMap((p) => p.targets)])
  for (const own of local.profiles) {
    const copy = collisionNames(own.name, deviceId).find((n) => {
      const shownCopy = byName(shown, n)
      return byName(local, n) === undefined && shownCopy !== undefined && sameProfile(shownCopy, { ...own, name: n })
    })
    if (copy === undefined) continue
    const shownCopy = byName(shown, copy)!
    const nextCopy = byName(next, copy)
    const synced = byName(shown, own.name)
    const nextSynced = byName(next, own.name)
    if (nextCopy === undefined || !sameProfile(nextCopy, shownCopy)) continue
    // The synced namesake edited here: the local one stays, under the name it was shown with.
    if (!(synced === undefined || nextSynced === undefined || sameProfile(nextSynced, synced))) continue
    // The synced namesake untouched (or removed) here: the local one keeps its name and settings.
    keepLocal.add(own.name)
    if (!named.has(copy)) dropCopies.add(copy)
  }
  const visible = new Set(shown.profiles.map((p) => p.name))
  const nextNames = new Set(next.profiles.map((p) => p.name))
  const hidden = local.profiles.filter((p) => !visible.has(p.name) && !nextNames.has(p.name))
  // A policy or test result the page did not change keeps its local value: the synced one shown is
  // not written over it (the local blob is what an older build here reads).
  const edited = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) !== canonicalJson(b ?? null)
  const fieldwise = <T>(l: Readonly<Record<string, T>>, s: Readonly<Record<string, T>>, n: Readonly<Record<string, T>>): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const k of new Set([...Object.keys(l), ...Object.keys(s), ...Object.keys(n)])) {
      const v = edited(s[k], n[k]) ? n[k] : l[k]
      if (v !== undefined) out[k] = v
    }
    return out
  }
  const repoPolicies = fieldwise(local.repoPolicies, shown.repoPolicies, next.repoPolicies)
  const lastTests = fieldwise(local.lastTests, shown.lastTests, next.lastTests)
  const defaultPolicy = edited(shown.defaultPolicy, next.defaultPolicy) ? next.defaultPolicy : local.defaultPolicy
  const profiles = [
    ...next.profiles.filter((p) => !dropCopies.has(p.name) && !keepLocal.has(p.name)),
    ...local.profiles.filter((p) => keepLocal.has(p.name)),
    ...hidden,
  ].sort((a, b) => a.name.localeCompare(b.name))
  if (profiles.length > LOCAL_PROFILE_CAP) throw new LocalProfileCapError(hidden.length)
  return { ...next, profiles, defaultPolicy, repoPolicies, lastTests }
}

function sameProfile(a: StorageProfile, b: StorageProfile): boolean {
  return a.name === b.name && canonicalJson(storageEntries({ ...EMPTY, profiles: [a] })) === canonicalJson(storageEntries({ ...EMPTY, profiles: [b] }))
}

const EMPTY: StorageConfig = { version: 1, profiles: [], defaultPolicy: null, repoPolicies: {}, lastTests: {} }

/** The keys a Settings save set to another value than the page showed (`shown` to `after`). */
export function storageEdits(shown: StorageConfig, after: StorageConfig): string[] {
  const before = storageEntries(shown)
  return Object.entries(storageEntries(after))
    .filter(([k, v]) => !Object.hasOwn(before, k) || canonicalJson(before[k]) !== canonicalJson(v))
    .map(([k]) => k)
}

/** The keys a Settings save removed (`before` to `after`): the only deletions sync turns into tombstones. */
export function storageDeletions(before: StorageConfig, after: StorageConfig): string[] {
  const kept = storageEntries(after)
  return Object.keys(storageEntries(before)).filter((k) => !Object.hasOwn(kept, k))
}
