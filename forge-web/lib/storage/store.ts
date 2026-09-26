/**
 * The browser's storage configuration: named profiles, the default browser-push policy, and
 * per-repo overrides. All of it lives in ONE blob sealed in the vault (`lib/auth/vault.ts`
 * `writeStorageBlob`): the profiles' secrets must never touch localStorage or plaintext
 * IndexedDB, and keeping the non-secret parts next to them means there is exactly one place
 * to read, one to forget, and nothing to reconcile. Reading needs an unlocked session, which
 * every push needs anyway.
 *
 * What is stored is parsed with zod on the way out: a tampered or foreign blob fails to
 * decrypt (AES-GCM with the network and identity as additional data) and, if it did not,
 * would still not reach the uploader unvalidated.
 */

import { z } from 'zod'

import type { Network } from '../constants'
import { readStorageBlob, writeStorageBlob } from '../auth/vault'
import {
  policySchema,
  profilePublicSchema,
  profileSecretsSchema,
  type StoragePolicy,
  type StorageProfile,
} from './profiles'

/** Everything this browser knows about the user's storage. */
export interface StorageConfig {
  readonly version: 1
  readonly profiles: readonly StorageProfile[]
  /** The policy browser pushes use when a repo has no override. */
  readonly defaultPolicy: StoragePolicy | null
  /** repoId → the policy for browser pushes to that repo. */
  readonly repoPolicies: Readonly<Record<string, StoragePolicy>>
  /** Profile name → the last browser test: when, and whether every row passed. */
  readonly lastTests: Readonly<Record<string, { readonly at: number; readonly ok: boolean }>>
}

export const EMPTY_STORAGE_CONFIG: StorageConfig = {
  version: 1,
  profiles: [],
  defaultPolicy: null,
  repoPolicies: {},
  lastTests: {},
}

const configSchema = z.object({
  version: z.literal(1),
  profiles: z
    .array(z.object({ name: z.string().max(64), settings: profilePublicSchema, secrets: profileSecretsSchema }))
    .max(32),
  defaultPolicy: policySchema.nullable(),
  repoPolicies: z.record(z.string().max(64), policySchema),
  lastTests: z.record(z.string().max(64), z.object({ at: z.number(), ok: z.boolean() })),
})

/** The stored configuration (empty when none is stored). Needs the vault unlocked. */
export async function loadStorageConfig(network: Network, identityId: string): Promise<StorageConfig> {
  const raw = await readStorageBlob(network, identityId)
  if (raw === null) return EMPTY_STORAGE_CONFIG
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) throw new Error('the stored storage settings are not in a shape this app understands')
  return parsed.data as StorageConfig
}

/** Seal `config` in the vault. Needs the vault unlocked. */
export async function saveStorageConfig(network: Network, identityId: string, config: StorageConfig): Promise<void> {
  const parsed = configSchema.parse(config)
  await writeStorageBlob(network, identityId, parsed)
}

/** `config` with `profile` added or replaced (by name). */
export function withProfile(config: StorageConfig, profile: StorageProfile): StorageConfig {
  const profiles = [...config.profiles.filter((p) => p.name !== profile.name), profile].sort((a, b) => a.name.localeCompare(b.name))
  return { ...config, profiles }
}

/**
 * `config` without the profile `name`: it also leaves every policy (a policy naming a profile
 * that no longer exists would fail every push). A policy left with no targets is removed.
 */
export function withoutProfile(config: StorageConfig, name: string): StorageConfig {
  const prune = (p: StoragePolicy | null): StoragePolicy | null => {
    if (p === null) return null
    const targets = p.targets.filter((t) => t !== name)
    if (targets.length === 0) return null
    return { ...p, targets, replicas: Math.min(p.replicas, targets.length) }
  }
  const repoPolicies: Record<string, StoragePolicy> = {}
  for (const [repo, p] of Object.entries(config.repoPolicies)) {
    const next = prune(p)
    if (next) repoPolicies[repo] = next
  }
  const lastTests = { ...config.lastTests }
  delete lastTests[name]
  return {
    ...config,
    profiles: config.profiles.filter((p) => p.name !== name),
    defaultPolicy: prune(config.defaultPolicy),
    repoPolicies,
    lastTests,
  }
}

/** The policy browser pushes to `repoId` use: its override, else the default, else none. */
export function policyForRepo(config: StorageConfig, repoId: string): StoragePolicy | null {
  return config.repoPolicies[repoId] ?? config.defaultPolicy
}

/** `config` with `repoId`'s override set (or cleared with null). */
export function withRepoPolicy(config: StorageConfig, repoId: string, policy: StoragePolicy | null): StorageConfig {
  const repoPolicies = { ...config.repoPolicies }
  if (policy === null) delete repoPolicies[repoId]
  else repoPolicies[repoId] = policy
  return { ...config, repoPolicies }
}

/** Why a policy cannot be used with `config`'s profiles, or null. */
export function policyProblem(config: StorageConfig, policy: StoragePolicy): string | null {
  if (policy.targets.length === 0) return 'choose at least one place to store packs'
  const missing = policy.targets.filter((t) => !config.profiles.some((p) => p.name === t))
  if (missing.length > 0) return `no storage profile named ${missing.join(', ')}`
  if (policy.replicas > policy.targets.length) return `${policy.replicas} copies are required but only ${policy.targets.length} places are chosen`
  return null
}
