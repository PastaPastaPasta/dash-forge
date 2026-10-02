/** Profile addresses (D-222) and link labels. */

import { describe, expect, it } from 'vitest'

import { identityHref, linkLabel } from './profile-links'

describe('identityHref', () => {
  it('addresses a profile and its follow lists by identity id', () => {
    expect(identityHref('abc')).toBe('/u/?id=abc')
    expect(identityHref('abc', 'followers')).toBe('/u/followers/?id=abc')
    expect(identityHref('abc', 'following')).toBe('/u/following/?id=abc')
  })
})

describe('linkLabel', () => {
  it('drops the scheme and a lone trailing slash', () => {
    expect(linkLabel('https://alice.dev/')).toBe('alice.dev')
    expect(linkLabel('https://alice.dev/blog/')).toBe('alice.dev/blog/')
    expect(linkLabel('https://mastodon.social/@alice')).toBe('mastodon.social/@alice')
  })
})
