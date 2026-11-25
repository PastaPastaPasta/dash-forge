/**
 * The `storage` slot (docs/design/identity-synced-state.md §4, §7) against the web app's
 * {@link StorageConfig}: keys `profile:<name>` ({settings, secrets}), `default` (a policy),
 * `repo:<repoId>` (a policy) and `test:<name>`. A synced value this build cannot read stays in the
 * synced map untouched and is left out of the view.
 */

import { z } from 'zod'

import { policySchema, profilePublicSchema, profileSecretsSchema, validProfileName, type StoragePolicy, type StorageProfile } from '../storage/profiles'
import type { StorageConfig } from '../storage/store'

/** The most profiles the local blob holds (`lib/storage/store.ts`): an older build refuses more. */
export const LOCAL_PROFILE_CAP = 32

const profileValue = z.object({ settings: profilePublicSchema, secrets: profileSecretsSchema })
const testValue = z.object({ at: z.number(), ok: z.boolean() })

/** The slot's entries for a local config. */
export function storageEntries(config: StorageConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of config.profiles) out[`profile:${p.name}`] = { settings: p.settings, secrets: p.secrets }
  if (config.defaultPolicy !== null) out['default'] = config.defaultPolicy
  for (const [repo, policy] of Object.entries(config.repoPolicies)) out[`repo:${repo}`] = policy
  for (const [name, t] of Object.entries(config.lastTests)) out[`test:${name}`] = t
  return out
}

function profileOf(name: string, v: unknown): StorageProfile | null {
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
    const name = collisionName(own.name, deviceId)
    if (!profiles.some((p) => p.name === name)) profiles.push({ ...own, name })
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

/**
 * What a Settings save of the effective config writes locally: `next`, plus the local profiles the
 * view hid (tombstoned elsewhere, or shown under a collision name) that the user did not touch.
 * `shown` is the effective config the user edited.
 */
export function localAfterSave(local: StorageConfig, shown: StorageConfig, next: StorageConfig): StorageConfig {
  const visible = new Set(shown.profiles.map((p) => p.name))
  const nextNames = new Set(next.profiles.map((p) => p.name))
  const hidden = local.profiles.filter((p) => !visible.has(p.name) && !nextNames.has(p.name))
  const repoPolicies = { ...next.repoPolicies }
  for (const [repo, p] of Object.entries(local.repoPolicies)) {
    if (shown.repoPolicies[repo] === undefined && repoPolicies[repo] === undefined) repoPolicies[repo] = p
  }
  const profiles = [...next.profiles, ...hidden].slice(0, LOCAL_PROFILE_CAP).sort((a, b) => a.name.localeCompare(b.name))
  return { ...next, profiles, repoPolicies }
}
