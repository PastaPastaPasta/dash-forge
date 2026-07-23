import { describe, expect, it } from 'vitest'
import { abbreviate, cn, errorMessage } from '@/lib/utils'

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

  it('keeps text-white when combined with the custom text-dense/text-prose font sizes', () => {
    // Regression: without teaching tailwind-merge that text-dense/text-prose are FONT SIZES,
    // it drops the color `text-white` as a conflicting `text-*` — the primary-button a11y bug.
    expect(cn('text-white', 'text-dense')).toBe('text-white text-dense')
    expect(cn('text-white text-prose')).toBe('text-white text-prose')
    // Two font sizes still collapse to the last (they are the same group).
    expect(cn('text-dense', 'text-prose')).toBe('text-prose')
  })
})

describe('errorMessage', () => {
  it('reads a real Error message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it('returns a string as-is', () => {
    expect(errorMessage('nope')).toBe('nope')
  })

  it('extracts .message from a wasm-bindgen-style error object (not an Error instance)', () => {
    const wasmErr = { __wbg_ptr: 12345, message: 'Invalid data contract ID' }
    expect(errorMessage(wasmErr)).toBe('Invalid data contract ID')
  })

  it('never returns "[object Object]" — falls back for an opaque object', () => {
    expect(errorMessage({ __wbg_ptr: 1 })).toBe('read failed (SDK error)')
    expect(errorMessage({})).toBe('read failed (SDK error)')
  })

  it('survives a getter that throws (freed wasm pointer)', () => {
    const hostile = {
      get message(): string {
        throw new Error('use after free')
      },
    }
    expect(errorMessage(hostile, 'fallback')).toBe('fallback')
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
