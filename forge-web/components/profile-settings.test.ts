/** Settings → Profile: a link typed without a scheme reads as https, a host with a port included. */

import { describe, expect, it } from 'vitest'

import { withScheme } from './profile-settings'

describe('withScheme', () => {
  it('adds https:// to a bare host, with or without a port', () => {
    expect(withScheme('alice.dev')).toBe('https://alice.dev')
    expect(withScheme(' alice.dev:8443/blog ')).toBe('https://alice.dev:8443/blog')
    expect(withScheme('localhost:3000')).toBe('https://localhost:3000')
  })

  it('leaves a real scheme for the rule to judge, and a blank as blank', () => {
    expect(withScheme('https://alice.dev')).toBe('https://alice.dev')
    expect(withScheme('http://alice.dev')).toBe('http://alice.dev')
    expect(withScheme('mailto:alice@example.com')).toBe('mailto:alice@example.com')
    expect(withScheme('   ')).toBe('')
  })
})
