import { describe, expect, it } from 'vitest'
import vectors from '../../../forge-contracts/vectors/keep_for_members/plans.json'
import { planKeep } from './keep-for-members'

describe('keep-for-members shared plans', () => {
  for (const v of vectors) it(v.name, async () => {
    expect(await planKeep(new Map(Object.entries(v.allEra)), new Map(Object.entries(v.below)), new Map(Object.entries(v.public)), new Map(Object.entries(v.members)), v.defaultRef,
      (a, b) => a === b || v.ancestors.some(([x, y]) => a === x && b === y), new Set(v.reserved))).toEqual(v.expected)
  })
})
