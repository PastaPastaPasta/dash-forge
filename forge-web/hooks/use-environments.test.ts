/**
 * Settings → Environments' unlock prompt: shown to a member who could open more once unlocked,
 * never to a public repo's outsider, whose keys open no environment.
 */
import { describe, expect, it } from 'vitest'

import type { RepoHome } from '@/lib/view'
import { asksToUnlock } from './use-environments'

const home = (visibility: 'public' | 'private', extra: Partial<RepoHome> = {}): RepoHome =>
  ({ repo: { repoId: 'R', name: 'shop', ownerId: 'O', visibility }, ...extra }) as unknown as RepoHome

describe('asksToUnlock', () => {
  it("does not ask a public repo's outsider, whatever their browser's key", () => {
    expect(asksToUnlock(home('public'), 'locked')).toBe(false)
    expect(asksToUnlock(home('public'), null)).toBe(false)
  })

  it('asks a public repo member whose tab or encryption key is locked', () => {
    expect(asksToUnlock(home('public', { lane: { access: 'locked' } }), 'none')).toBe(true)
    expect(asksToUnlock(home('public', { lane: { access: 'none' } }), 'locked')).toBe(true)
    expect(asksToUnlock(home('public', { lane: { access: 'none' } }), 'open')).toBe(false)
  })

  it("asks a private repo's member whose tab is locked", () => {
    expect(asksToUnlock(home('private', { private: { access: 'locked' } }), null)).toBe(true)
    expect(asksToUnlock(home('private', { private: { access: 'no-key' } }), 'none')).toBe(false)
    expect(asksToUnlock(home('private', { private: { access: 'outsider' } }), 'locked')).toBe(false)
  })
})
