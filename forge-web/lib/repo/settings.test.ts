/**
 * Repo settings rules (D-503): what a config change writes, what it refuses before signing, and
 * which policy is in force. Parity: forge-core `repo.rs` `ConfigChange` / `check_patterns` /
 * `RepoEdit` (the same limits and cases in `repo::tests::settings`).
 */

import { describe, expect, it, vi } from 'vitest'

import type { RepoConfig } from './config'
import type { RepoRef } from './contract'
import {
  DEFAULT_CONFIG,
  SealedConfigError,
  applyConfigChange,
  branchProblem,
  configData,
  descriptionProblem,
  fullPattern,
  newestPolicy,
  parseTopics,
  patternMatches,
  patternsProblem,
  repoEditChanges,
  sameConfig,
  shortBranch,
  topicsProblem,
  updateConfig,
} from './settings'

const NOW: RepoConfig = {
  defaultBranch: 'main',
  protectedPatterns: ['refs/heads/main'],
  archived: false,
  backendUris: ['https://b.example/'],
  backendMode: 2,
}

describe('config changes', () => {
  it('carry every unset field over', () => {
    const next = applyConfigChange(NOW, { defaultBranch: 'refs/heads/trunk' })
    expect(next.defaultBranch).toBe('trunk')
    expect(next.protectedPatterns).toEqual(NOW.protectedPatterns)
    expect([next.backendMode, next.backendUris]).toEqual([2, NOW.backendUris])
    expect(applyConfigChange(NOW, { archived: true })).toMatchObject({ archived: true, defaultBranch: 'main' })
  })

  it('that change nothing are recognised (nothing is signed)', () => {
    expect(sameConfig(NOW, applyConfigChange(NOW, {}))).toBe(true)
    expect(sameConfig(NOW, applyConfigChange(NOW, { defaultBranch: 'main' }))).toBe(true)
    expect(sameConfig(NOW, applyConfigChange(NOW, { protectedPatterns: [] }))).toBe(false)
  })

  it('write the config shape forge-core writes (no empty pattern list, backend kept)', () => {
    expect(configData(applyConfigChange(NOW, { protectedPatterns: [] }))).toEqual({
      defaultBranch: 'main',
      backend: { mode: 2, uris: ['https://b.example/'] },
      archived: false,
    })
    expect(configData(NOW)['protectedPatterns']).toEqual(['refs/heads/main'])
    expect(configData(DEFAULT_CONFIG)).toEqual({ defaultBranch: 'main', backend: { mode: 0 }, archived: false })
  })

  it('refuse a private repo before signing: its config is sealed', async () => {
    const repo = { visibility: 'private' } as RepoRef
    const sdk = { documents: { create: vi.fn() } }
    await expect(updateConfig(sdk as never, {} as never, repo, NOW, { archived: true })).rejects.toBeInstanceOf(SealedConfigError)
    expect(sdk.documents.create).not.toHaveBeenCalled()
  })

  it('return null without signing when nothing changes', async () => {
    const repo = { visibility: 'public' } as RepoRef
    await expect(updateConfig({} as never, {} as never, repo, NOW, { defaultBranch: 'main' })).resolves.toBeNull()
  })
})

describe('branch names and patterns', () => {
  it('normalise branches and patterns to what consensus routing matches', () => {
    expect(shortBranch('refs/heads/main')).toBe('main')
    expect(shortBranch('release/1.x')).toBe('release/1.x')
    expect(fullPattern('main')).toBe('refs/heads/main')
    expect(fullPattern(' release/* ')).toBe('refs/heads/release/*')
    expect(fullPattern('refs/tags/v*')).toBe('refs/tags/v*')
  })

  it('refuse what the schema refuses', () => {
    expect(branchProblem('main')).toBeNull()
    expect(branchProblem('refs/heads/release/1.x')).toBeNull()
    expect(branchProblem('')).not.toBeNull()
    expect(branchProblem('a b')).not.toBeNull()
    expect(branchProblem('x'.repeat(250))).not.toBeNull()
    expect(patternsProblem(['refs/heads/main', 'refs/heads/release/*'])).toBeNull()
    expect(patternsProblem([])).toBeNull()
    expect(patternsProblem(['refs/heads/a', 'refs/heads/a'])).toMatch(/already/)
    expect(patternsProblem([''])).not.toBeNull()
    expect(patternsProblem(['refs/heads/a b'])).not.toBeNull()
    expect(patternsProblem(['x'.repeat(101)])).not.toBeNull()
    expect(patternsProblem(['x'.repeat(100)])).toBeNull()
    expect(patternsProblem(['1', '2', '3', '4', '5', '6', '7', '8', '9'])).toMatch(/at most 8/)
  })

  it('preview the branches a pattern protects with the FORGE_RULES wildmatch', () => {
    const branches = ['main', 'release/1.x', 'release/2.x/rc', 'feature']
    expect(patternMatches('refs/heads/main', branches)).toEqual(['main'])
    // `*` stays within one segment; `**` crosses them.
    expect(patternMatches('refs/heads/release/*', branches)).toEqual(['release/1.x'])
    expect(patternMatches('refs/heads/release/**', branches)).toEqual(['release/1.x', 'release/2.x/rc'])
    expect(patternMatches('refs/heads/*', branches)).toEqual(['main', 'feature'])
  })
})

describe('repo document edits', () => {
  it('check topics and the description against the schema', () => {
    expect(topicsProblem(['rust', 'dash-platform', 'v2'])).toBeNull()
    expect(topicsProblem(['Rust'])).not.toBeNull()
    expect(topicsProblem(['-x'])).not.toBeNull()
    expect(topicsProblem(['a_b'])).not.toBeNull()
    expect(topicsProblem(['a', 'a'])).toMatch(/twice/)
    expect(topicsProblem(['a'.repeat(31)])).not.toBeNull()
    expect(topicsProblem(Array.from({ length: 11 }, (_, i) => `t${i}`))).toMatch(/at most 10/)
    expect(parseTopics('a, b,c')).toEqual(['a', 'b', 'c'])
    expect(parseTopics(' , ')).toEqual([])
    expect(descriptionProblem('x'.repeat(500))).toBeNull()
    expect(descriptionProblem('x'.repeat(501))).not.toBeNull()
    expect(descriptionProblem('é'.repeat(500))).toBeNull()
    expect(descriptionProblem('€'.repeat(400))).not.toBeNull()
  })

  it('clear a field by removing the property', () => {
    expect(repoEditChanges({ description: '', topics: [] })).toEqual({ description: undefined, topics: undefined })
    expect(repoEditChanges({ description: 'hi' })).toEqual({ description: 'hi' })
    expect(repoEditChanges({})).toEqual({})
  })
})

describe('the policy in force', () => {
  it('is the newest by ($createdAt, $id)', () => {
    const p = (requiredApprovals: number) => ({ requiredApprovals })
    expect(newestPolicy([])).toBeNull()
    expect(
      newestPolicy([
        { createdAt: 2, id: 'a', policy: p(2) },
        { createdAt: 1, id: 'z', policy: p(1) },
      ]),
    ).toEqual(p(2))
    // A tie on $createdAt goes to the greater id.
    expect(
      newestPolicy([
        { createdAt: 5, id: 'b', policy: p(1) },
        { createdAt: 5, id: 'c', policy: p(3) },
      ]),
    ).toEqual(p(3))
  })
})
