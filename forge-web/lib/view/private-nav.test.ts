import { afterEach, describe, expect, it } from 'vitest'

import { forgetPrivateNav, isExpiredToken, openParam, sealParams, sealRepoUrls } from './private-nav'

const PRIVATE = { owner: 'alice', name: 'secret' }
const PUBLIC = { owner: 'alice', name: 'open' }

describe('private route params', () => {
  afterEach(forgetPrivateNav)

  it('a sealed repo carries tokens for path, ref and oid; other params and repos are untouched', () => {
    sealRepoUrls(PRIVATE)
    const sealed = sealParams(PRIVATE, { path: 'src/secret.rs', ref: 'feature/x', oid: 'ab'.repeat(20), number: '3' })
    expect(sealed['number']).toBe('3')
    for (const k of ['path', 'ref', 'oid']) {
      expect(sealed[k]).toMatch(/^~[0-9a-f]{16}$/)
    }
    expect(JSON.stringify(sealed)).not.toContain('secret')
    expect(openParam('path', sealed['path'] as string)).toBe('src/secret.rs')
    expect(sealParams(PRIVATE, { path: 'src/secret.rs' })['path']).toBe(sealed['path'])
    expect(sealParams(PUBLIC, { path: 'src/main.rs' })).toEqual({ path: 'src/main.rs' })
  })

  it('a token from another tab, or after a lock, opens nothing', () => {
    sealRepoUrls(PRIVATE)
    const token = sealParams(PRIVATE, { path: 'src/secret.rs' })['path'] as string
    forgetPrivateNav()
    expect(openParam('path', token)).toBe(token)
    expect(isExpiredToken('path', token)).toBe(true)
    // A public repo's file really named like a token, or another param, is left alone.
    expect(isExpiredToken('number', '~0123456789abcdef')).toBe(false)
    expect(openParam('path', 'src/main.rs')).toBe('src/main.rs')
    expect(isExpiredToken('path', 'src/main.rs')).toBe(false)
  })
})
