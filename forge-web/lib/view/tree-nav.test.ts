import { describe, expect, it } from 'vitest'

import { isMissingPathError, treeAtPath } from './tree-nav'

describe('isMissingPathError', () => {
  it('is true for a missing directory anywhere in the path and for a missing file', async () => {
    const emptyTrees = { readObject: async () => ({ type: 'tree', bytes: new Uint8Array() }) }
    const err = await treeAtPath(emptyTrees as never, 'root', 'nope/deeper').then(
      () => null,
      (e: Error) => e.message,
    )
    expect(isMissingPathError(err)).toBe(true)
    expect(isMissingPathError('file not found: a/b.txt')).toBe(true)
  })

  it('is false for other read failures and for no error', () => {
    expect(isMissingPathError('object 0a77b19486 not found in any pack')).toBe(false)
    expect(isMissingPathError(null)).toBe(false)
  })
})
