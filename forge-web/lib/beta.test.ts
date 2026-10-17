/**
 * MIXE-09: one list says which features are beta; the Beta badge reads it and the guide's "Known
 * limitations" lists every entry, so the two cannot drift.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { BETA_FEATURES, BETA_TOOLTIP, betaFeatureNames, isBeta } from './beta'

const GUIDE = readFileSync(join(__dirname, '../../docs/guides/collaborating.md'), 'utf8')

/** The "Known limitations" section of the guide, up to the next heading of its level. */
function knownLimitations(): string {
  const start = GUIDE.indexOf('\n## Known limitations')
  expect(start).toBeGreaterThan(-1)
  const rest = GUIDE.slice(start + 1)
  const next = rest.indexOf('\n## ', 4)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('the beta registry', () => {
  it('lists exactly the features the release plan labels beta', () => {
    expect(Object.keys(BETA_FEATURES).sort()).toEqual(
      ['accessNotices', 'agents', 'botPushGrants', 'bots', 'branchSharing', 'embargo', 'makeRepoPublic', 'narrowerBranches'].sort(),
    )
    expect(betaFeatureNames()).toHaveLength(Object.keys(BETA_FEATURES).length)
  })

  it('knows a beta feature from anything else', () => {
    expect(isBeta('embargo')).toBe(true)
    expect(isBeta('letters')).toBe(false)
    expect(isBeta('toString')).toBe(false)
  })

  it('has the tooltip the plan words', () => {
    expect(BETA_TOOLTIP).toBe('Beta: works, but expect rough edges; see Known limitations')
  })

  it("is listed in the guide's Known limitations, by the same names", () => {
    const section = knownLimitations()
    for (const name of betaFeatureNames()) expect(section, name).toContain(name)
  })
})
