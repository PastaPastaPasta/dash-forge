/**
 * Repo settings rules (D-503): what a config change writes, what it refuses before signing, and
 * which policy is in force. Parity: forge-core `repo.rs` `ConfigChange` / `check_patterns` /
 * `RepoEdit` (the same limits and cases in `repo::tests::settings`).
 */

import { describe, expect, it, vi } from 'vitest'

import type { RepoConfig } from './config'
import type { RepoRef } from './contract'
import { onRepoContentWritten } from './push'
import {
  DEFAULT_CONFIG,
  SealedConfigError,
  applyConfigChange,
  changeHolds,
  branchProblem,
  configData,
  descriptionProblem,
  fullPattern,
  newestPolicy,
  parseTopics,
  patternMatches,
  previewRepoEdit,
  patternsProblem,
  repoEditChanges,
  sameConfig,
  shortBranch,
  staleProblem,
  topicChanges,
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
    expect(sameConfig(NOW, applyConfigChange(NOW, { removePattern: 'refs/heads/main' }))).toBe(false)
  })

  it('write the config shape forge-core writes (no empty pattern list, backend kept)', () => {
    expect(configData(applyConfigChange(NOW, { removePattern: 'refs/heads/main' }))).toEqual({
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

  it('apply to the config read at write time, keeping what changed elsewhere since the page loaded (H1)', async () => {
    // The page loaded NOW; meanwhile another maintainer protected release/* and changed storage.
    const fresh: RepoConfig = { ...NOW, protectedPatterns: ['refs/heads/main', 'refs/heads/release/*'], backendMode: 4 }
    let written: Record<string, unknown> | null = null
    const write = vi.fn(async (_s: unknown, _a: unknown, p: { data: Record<string, unknown> }) => {
      written = p.data
      return { documentId: 'x' }
    })
    await updateConfig({} as never, {} as never, { visibility: 'public', repoId: '11111111111111111111111111111111', forge: { core: 'c' } } as never, NOW, { archived: true }, undefined, async () => fresh, write as never)
    expect(written).toMatchObject({ archived: true, protectedPatterns: ['refs/heads/main', 'refs/heads/release/*'], backend: { mode: 4 } })
  })

  it('a config write, landed or not, tells the repo\'s caches it wrote (the chrome store reads again)', async () => {
    const told: string[] = []
    const off = onRepoContentWritten((r) => told.push(r.repoId))
    const repo = { visibility: 'public', repoId: '11111111111111111111111111111111', forge: { core: 'c' } } as never
    await updateConfig({} as never, {} as never, repo, NOW, { archived: true }, undefined, async () => NOW, (async () => ({ documentId: 'x' })) as never)
    await expect(
      updateConfig({} as never, {} as never, repo, NOW, { archived: true }, undefined, async () => NOW, (async () => {
        throw new Error('unconfirmed')
      }) as never),
    ).rejects.toThrow('unconfirmed')
    off()
    expect(told).toEqual(['11111111111111111111111111111111', '11111111111111111111111111111111'])
  })

  it('refuse when the field being edited changed since the page loaded (H1)', async () => {
    const fresh: RepoConfig = { ...NOW, protectedPatterns: ['refs/heads/main', 'refs/heads/release/*'] }
    const write = vi.fn()
    await expect(
      updateConfig({} as never, {} as never, { visibility: 'public' } as never, NOW, { removePattern: 'refs/heads/main' }, undefined, async () => fresh, write as never),
    ).rejects.toThrow(/changed since you opened this page/)
    expect(write).not.toHaveBeenCalled()
    expect(staleProblem(NOW, { ...NOW, defaultBranch: 'trunk' }, { defaultBranch: 'dev' })).not.toBeNull()
    expect(staleProblem(NOW, { ...NOW, defaultBranch: 'trunk' }, { archived: true })).toBeNull()
  })

  it('confirm a landed change by its edited field only, whatever else changed elsewhere', () => {
    const elsewhere: RepoConfig = { ...NOW, archived: true, backendMode: 4, protectedPatterns: ['refs/heads/main', 'refs/heads/x'] }
    expect(changeHolds(elsewhere, { defaultBranch: 'refs/heads/main' })).toBe(true)
    expect(changeHolds(elsewhere, { addPattern: 'refs/heads/x' })).toBe(true)
    expect(changeHolds(elsewhere, { removePattern: 'refs/heads/main' })).toBe(false)
    expect(changeHolds(elsewhere, { archived: false })).toBe(false)
    expect(sameConfig(elsewhere, applyConfigChange(NOW, { addPattern: 'refs/heads/x' }))).toBe(false)
  })

  it('add and remove one pattern as a delta', () => {
    expect(applyConfigChange(NOW, { addPattern: 'refs/heads/dev' }).protectedPatterns).toEqual(['refs/heads/main', 'refs/heads/dev'])
    expect(applyConfigChange(NOW, { addPattern: 'refs/heads/main' }).protectedPatterns).toEqual(['refs/heads/main'])
    expect(applyConfigChange(NOW, { removePattern: 'refs/heads/main' }).protectedPatterns).toEqual([])
  })

  it('return null without signing when nothing changes', async () => {
    const repo = { visibility: 'public' } as RepoRef
    await expect(updateConfig({} as never, {} as never, repo, NOW, { defaultBranch: 'main' }, undefined, async () => NOW)).resolves.toBeNull()
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

  it('prices the topic documents a topics edit adds and removes (C-1 `topic`)', () => {
    expect(topicChanges(['rust', 'cli'], ['rust', 'git'])).toEqual({ added: ['git'], removed: ['cli'] })
    // Same replace, plus one topic document created: costs more than the replace alone.
    const replace = previewRepoEdit({ topics: ['rust'] }, ['rust']).credits
    expect(previewRepoEdit({ topics: ['rust', 'git'] }, ['rust']).credits).toBeGreaterThan(replace)
    // A removal refunds part of the replace.
    expect(previewRepoEdit({ topics: [] }, ['rust']).credits).toBeLessThan(replace)
    // Priced against the topic documents held, not the list: a pre-C-1 repo holds none, so all
    // three are created; unknown (null) prices that worst case too.
    const three = previewRepoEdit({ topics: ['rust', 'cli', 'git'] }, []).credits
    expect(three).toBeGreaterThan(previewRepoEdit({ topics: ['rust', 'cli', 'git'] }, ['rust', 'cli']).credits)
    expect(previewRepoEdit({ topics: ['rust', 'cli', 'git'] }, null).credits).toBe(three)
    expect(previewRepoEdit({}, ['rust']).credits).toBe(0)
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
