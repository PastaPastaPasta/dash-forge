/**
 * A fork proposes to its parent (QW3-012): the parent's New pull request form with the fork's
 * branch as the head, the default branch when the fork has it. And the fork dialog's estimate
 * of how long its signed writes take (QW3-010).
 */

import { describe, expect, it } from 'vitest'

import type { ResolvedRef } from '@/lib/repo'
import { contributeHref, forkHeadBranch } from './fork-contribute'
import { forkDuration } from './fork-button'

const branch = (name: string): ResolvedRef => ({ refName: `refs/heads/${name}` }) as ResolvedRef

describe('contributeHref', () => {
  it("opens the parent's form with the fork's branch as the head", () => {
    expect(contributeHref({ ownerId: 'UP', name: 'dips' }, { repoId: 'FORK' }, 'master')).toBe('/repo/pulls/new/?owner=UP&name=dips&head=FORK%3Amaster')
  })
})

describe('forkHeadBranch', () => {
  it('is the default branch when the fork has it, else its first branch', () => {
    expect(forkHeadBranch({ defaultBranch: 'master', branches: [branch('feature'), branch('master')] })).toBe('master')
    expect(forkHeadBranch({ defaultBranch: 'main', branches: [branch('develop')] })).toBe('develop')
    expect(forkHeadBranch({ defaultBranch: 'main', branches: [] })).toBe('main')
  })
})

describe('forkDuration', () => {
  it('says roughly how long the signed writes take, one after another', () => {
    expect(forkDuration(8)).toBe('under a minute')
    expect(forkDuration(32)).toBe('about 2 minutes')
    // Every branch and tag of dash: 604 refs, 2 manifests, the repo's three documents.
    expect(forkDuration(609)).toBe('about 30 minutes')
  })
})
