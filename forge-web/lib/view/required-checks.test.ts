import { describe, expect, it } from 'vitest'

import { policyData } from '../repo/review-writes'
import {
  MAX_REQUIRED_CHECKS,
  checksOk,
  draftOfPolicy,
  policyWithChecks,
  requiredChecksProblems,
  samePolicy,
  sameRequiredChecks,
  sourceOptions,
  newCheckRow,
  sourceRole,
  type RequiredChecksDraft,
} from './required-checks'

const RUNNER = 'BTJPjCLCnRaJQkqakpcdLYFsaHgFf5XSEBNxFCyYBteH'
const MAINT = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const WRITER = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const VALID = new Set([RUNNER, MAINT])

const draft = (rows: [string, string][], pinned: boolean): RequiredChecksDraft => ({ rows: rows.map(([name, source], i) => ({ key: `policy-${i}`, name, source })), pinned })

describe('required checks editor (RC1 R-08)', () => {
  it('starts from the policy: pinned only when every name has its source', () => {
    expect(draftOfPolicy({ requiredChecks: ['build', 'test'], requiredCheckSources: [RUNNER, MAINT] })).toEqual(draft([['build', RUNNER], ['test', MAINT]], true))
    expect(draftOfPolicy({ requiredChecks: ['build'] })).toEqual(draft([['build', '']], false))
    expect(draftOfPolicy({})).toEqual(draft([], false))
  })

  it('keys each row: a policy row by position, an added row uniquely', () => {
    const a = newCheckRow()
    const b = newCheckRow()
    expect(a).toMatchObject({ name: '', source: '' })
    expect(a.key).not.toBe(b.key)
    expect(draftOfPolicy({ requiredChecks: ['x'] }).rows[0]?.key).toBe(draftOfPolicy({ requiredChecks: ['x'] }).rows[0]?.key)
  })

  it('offers runners and maintainers, never writers', () => {
    const options = sourceOptions(
      [
        { identity: MAINT, role: 'maintainer', createdAt: 1 },
        { identity: WRITER, role: 'writer', createdAt: 2 },
        { identity: RUNNER, role: 'maintainer', createdAt: 3 },
      ],
      [RUNNER],
    )
    expect(options).toEqual([
      { id: RUNNER, runner: true, maintainer: true },
      { id: MAINT, runner: false, maintainer: true },
    ])
    expect(options.map(sourceRole)).toEqual(['runner and maintainer', 'maintainer'])
  })

  it('accepts distinct names, unpinned or each with a current source', () => {
    expect(checksOk(requiredChecksProblems(draft([['build', ''], ['test', '']], false), VALID))).toBe(true)
    expect(checksOk(requiredChecksProblems(draft([['build', RUNNER], ['test', MAINT]], true), VALID))).toBe(true)
    expect(checksOk(requiredChecksProblems(draft([], true), VALID))).toBe(true)
  })

  it('refuses empty, over-long and duplicate names (trimmed, as saved)', () => {
    const p = requiredChecksProblems(draft([[' ', ''], ['build', ''], ['build ', ''], ['x'.repeat(101), ''], ['é'.repeat(100) + 'ü', '']], false), VALID)
    expect(p.rows[0]).toMatch(/Name the check/)
    expect(p.rows[1]).toMatch(/named once/)
    expect(p.rows[2]).toMatch(/named once/)
    expect(p.rows[3]).toMatch(/100 characters/)
    expect(p.rows[4]).toMatch(/100 characters/)
    // 100 two-byte characters are 200 bytes: at the byte cap, not over it.
    expect(requiredChecksProblems(draft([['é'.repeat(100), '']], false), VALID).rows[0]).toBeNull()
    // 70 three-byte characters are 210 bytes.
    expect(requiredChecksProblems(draft([['中'.repeat(70), '']], false), VALID).rows[0]).toMatch(/200 bytes/)
  })

  it('holds a pinned list to a source on every row, each still a runner or maintainer', () => {
    const p = requiredChecksProblems(draft([['build', RUNNER], ['test', ''], ['lint', WRITER]], true), VALID)
    expect(p.rows[0]).toBeNull()
    expect(p.rows[1]).toMatch(/Pick the runner or maintainer/)
    expect(p.rows[2]).toMatch(/No longer a runner or maintainer/)
    // While the sources are unknown only the missing pick is flagged; `setPolicy` re-checks the rest.
    expect(requiredChecksProblems(draft([['lint', WRITER]], true), null).rows[0]).toBeNull()
  })

  it('refuses more than ten checks', () => {
    const rows = Array.from({ length: MAX_REQUIRED_CHECKS + 1 }, (_, i): [string, string] => [`c${i}`, ''])
    expect(requiredChecksProblems(draft(rows, false), VALID).form).toMatch(/At most 10/)
    expect(requiredChecksProblems(draft(rows.slice(1), false), VALID).form).toBeNull()
  })

  it('saves all sources or none, which the contract and policyData accept', () => {
    const base = { requiredApprovals: 1, requireChecks: true, requiredChecks: ['old'], requiredCheckSources: [RUNNER] }
    const pinned = policyWithChecks(base, draft([[' build ', RUNNER], ['test', MAINT]], true))
    expect(pinned).toEqual({ requiredApprovals: 1, requireChecks: true, requiredChecks: ['build', 'test'], requiredCheckSources: [RUNNER, MAINT] })
    expect(() => policyData(pinned)).not.toThrow()
    // Unpinning drops every source, even the ones the rows still hold.
    const unpinned = policyWithChecks(base, draft([['build', RUNNER], ['test', '']], false))
    expect(unpinned).toEqual({ requiredApprovals: 1, requireChecks: true, requiredChecks: ['build', 'test'] })
    expect(() => policyData(unpinned)).not.toThrow()
    // No rows: no names and no sources.
    expect(policyWithChecks(base, draft([], true))).toEqual({ requiredApprovals: 1, requireChecks: true })
  })

  it('tells a policy changed in any one field from the same one', () => {
    const p = { requiredApprovals: 1, approverRole: 0, requireChecks: false, mergeMethods: 0, requiredChecks: ['a'] }
    expect(samePolicy(p, { requiredApprovals: 1, requiredChecks: ['a'] })).toBe(true)
    expect(samePolicy(p, { ...p, approverRole: 1 })).toBe(false)
    expect(samePolicy(p, { ...p, requireChecks: true })).toBe(false)
    expect(samePolicy(p, { ...p, mergeMethods: 4 })).toBe(false)
    expect(samePolicy(p, { ...p, requiredChecks: ['b'] })).toBe(false)
  })

  it('tells a changed check list from the same one', () => {
    expect(sameRequiredChecks({ requiredChecks: ['a', 'b'] }, { requiredChecks: ['a', 'b'] })).toBe(true)
    expect(sameRequiredChecks({ requiredChecks: ['a', 'b'] }, { requiredChecks: ['b', 'a'] })).toBe(false)
    expect(sameRequiredChecks({ requiredChecks: ['a'], requiredCheckSources: [RUNNER] }, { requiredChecks: ['a'] })).toBe(false)
    expect(sameRequiredChecks({}, { requiredChecks: [] })).toBe(true)
  })
})
