/**
 * The share rule against the cases dg's `ShareRule::of` is tested with
 * (`forge-contracts/fixtures/user-sync/share-rule.json`): both clients pick the same share from the
 * same synced storage slot.
 */

import { describe, expect, it } from 'vitest'

import fixture from '../../../forge-contracts/fixtures/user-sync/share-rule.json'
import { shareMeaning, shareRule } from './maintainers'

type Entry = { readonly at: number; readonly v: unknown }

/** The fixture's entries as the live view sync hands the rule: `@name` is a fixture profile, tombstones are absent. */
function liveView(entries: Readonly<Record<string, Entry>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [rawKey, e] of Object.entries(entries)) {
    if (e.v === null) continue
    const key = rawKey.replace('@repo', fixture.repo)
    out[key] = typeof e.v === 'string' && e.v.startsWith('@') ? (fixture.profiles as Record<string, unknown>)[e.v.slice(1)] : e.v
  }
  return out
}

describe('the share rule both clients follow', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const rule = shareRule(liveView(c.entries as Record<string, Entry>), fixture.repo)
      if (typeof c.expect === 'string') {
        expect(rule.kind).toBe(c.expect)
        return
      }
      expect(rule.kind).toBe('content')
      if (rule.kind !== 'content') return
      expect(Object.keys(rule.plain.profiles).sort()).toEqual([...c.expect.profiles].sort())
      expect(rule.plain.policy?.targets).toEqual(c.expect.targets)
      // Shared as synced (the web's provider label too).
      for (const name of c.expect.profiles) expect(rule.plain.profiles[name]).toEqual((fixture.profiles as Record<string, unknown>)[name])
    })
  }

  it('no slot read: keep', () => {
    expect(shareRule(null, fixture.repo).kind).toBe('keep')
  })

  it('compares by meaning: dg extras, empty secrets and key order do not count, a rotated secret does', () => {
    const view = liveView({ 'profile:web-r2': { at: 1, v: '@web-r2' }, default: { at: 1, v: { targets: ['web-r2'], replicas: 1, platformFallback: false } } })
    const rule = shareRule(view, fixture.repo)
    if (rule.kind !== 'content') throw new Error('expected a share')
    const base = fixture.profiles['web-r2']
    const b = { ...rule.plain, profiles: { 'web-r2': { ...base, dg: { allowPrivateUri: false }, secrets: { accessKeyId: 'AK', secretAccessKey: 'SK' } } }, policy: { platformFallback: false, replicas: 1, targets: ['web-r2'] } }
    expect(shareMeaning(b)).toBe(shareMeaning(rule.plain))
    const rotated = { ...b, profiles: { 'web-r2': { ...b.profiles['web-r2'], secrets: { accessKeyId: 'AK', secretAccessKey: 'rotated' } } } }
    expect(shareMeaning(rotated)).not.toBe(shareMeaning(rule.plain))
  })
})
