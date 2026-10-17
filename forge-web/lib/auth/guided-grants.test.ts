import { describe, expect, it } from 'vitest'

import { guidedStep, guidedStepTitle, passGuidedStep, startGuidedGrants } from './guided-grants'
import { missingGrants, nextGrant } from './key-registration'

const none = { collab: false, community: false, meta: false }

describe('missingGrants / nextGrant', () => {
  it('asks forge-collab, then forge-community, then forge-meta', () => {
    expect(missingGrants(none)).toEqual(['collab', 'community', 'meta'])
    expect(missingGrants({ collab: true, community: false, meta: false })).toEqual(['community', 'meta'])
    expect(nextGrant({ collab: true, community: true, meta: false })).toBe('meta')
  })

  it('has nothing to ask on a three-contract set (meta is covered) or an unbounded key', () => {
    expect(missingGrants({ collab: false, community: false, meta: true })).toEqual(['collab', 'community'])
    expect(missingGrants({ collab: true, community: true, meta: true })).toEqual([])
    expect(nextGrant({ collab: true, community: true })).toBeNull()
  })

  it('has nothing to ask while the grants are unknown', () => {
    expect(missingGrants(null)).toEqual([])
    expect(missingGrants(undefined)).toEqual([])
    expect(nextGrant(null)).toBeNull()
  })
})

describe('guided grants at first sign-in', () => {
  it('does not start when the wallet covered everything', () => {
    expect(startGuidedGrants({ collab: true, community: true, meta: true })).toBeNull()
    expect(startGuidedGrants(null)).toBeNull()
  })

  it('walks through every missing contract in order, counting the sign-in as step 1', () => {
    let state = startGuidedGrants(none)!
    expect(guidedStep(state, none)).toEqual({ kind: 'collab', step: 2, of: 4 })
    // The wallet granted forge-collab: the live grants move on.
    const afterCollab = { collab: true, community: false, meta: false }
    state = passGuidedStep(state, 'collab')
    expect(guidedStep(state, afterCollab)).toEqual({ kind: 'community', step: 3, of: 4 })
    const afterCommunity = { collab: true, community: true, meta: false }
    state = passGuidedStep(state, 'community')
    expect(guidedStep(state, afterCommunity)).toEqual({ kind: 'meta', step: 4, of: 4 })
    state = passGuidedStep(state, 'meta')
    expect(guidedStep(state, { collab: true, community: true, meta: true })).toBeNull()
  })

  it('labels a three-contract set "Step 2 of 3"', () => {
    const grants = { collab: false, community: false, meta: true }
    const state = startGuidedGrants(grants)!
    const step = guidedStep(state, grants)!
    expect(guidedStepTitle(step, 'Forge collaboration')).toBe('Step 2 of 3: approve Forge collaboration')
  })

  it('moves past a skipped step and keeps its number for the next one', () => {
    let state = startGuidedGrants(none)!
    state = passGuidedStep(state, 'collab')
    // forge-collab was skipped, not granted: the next step is still forge-community.
    expect(guidedStep(state, none)).toEqual({ kind: 'community', step: 3, of: 4 })
  })

  it('ends when every step was skipped, leaving the grants to the on-demand sheet', () => {
    let state = startGuidedGrants(none)!
    for (const k of ['collab', 'community', 'meta'] as const) state = passGuidedStep(state, k)
    expect(guidedStep(state, none)).toBeNull()
    expect(nextGrant(none)).toBe('collab')
  })

  it('does not ask for a grant that arrived by other means', () => {
    const state = startGuidedGrants(none)!
    // forge-collab and forge-community appeared (a grant from another tab) without a step passing.
    expect(guidedStep(state, { collab: true, community: true, meta: false })).toEqual({ kind: 'meta', step: 4, of: 4 })
  })

  it('passing a step twice changes nothing', () => {
    const once = passGuidedStep(startGuidedGrants(none)!, 'collab')
    expect(passGuidedStep(once, 'collab')).toBe(once)
  })
})
