import { describe, expect, it } from 'vitest'
import { abbreviate, cn } from '@/lib/utils'

describe('cn', () => {
  it('joins truthy class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('drops falsy values', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b')
  })

  it('lets later Tailwind utilities win over conflicting earlier ones', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
    expect(cn('text-anvil-500', 'text-forge-500')).toBe('text-forge-500')
  })

  it('supports conditional object syntax', () => {
    expect(cn('base', { active: true, disabled: false })).toBe('base active')
  })
})

describe('abbreviate', () => {
  it('truncates to 7 chars by default', () => {
    expect(abbreviate('e3f9a1b2c3d4e5f6')).toBe('e3f9a1b')
  })

  it('returns short values unchanged', () => {
    expect(abbreviate('abc')).toBe('abc')
  })
})
