import { describe, expect, it } from 'vitest'

import { duplicateInputError } from './close-issue-button'

describe('duplicateInputError (QW-069)', () => {
  it('takes an issue number, with or without #, other than its own', () => {
    expect(duplicateInputError('12', 7)).toBeNull()
    expect(duplicateInputError(' #12 ', 7)).toBeNull()
    expect(duplicateInputError('7', 7)).toBe('An issue cannot be a duplicate of itself')
    for (const bad of ['', 'abc', '0', '-3', '1.5', '99999999999']) expect(duplicateInputError(bad, 7)).not.toBeNull()
  })
})
