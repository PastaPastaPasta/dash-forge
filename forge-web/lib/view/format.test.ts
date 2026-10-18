import { describe, expect, it } from 'vitest'

import { branchName, forkSourcePrefix, plural, timeAgo } from './format'

describe('plural (L-36)', () => {
  it('is singular for exactly one and plural otherwise', () => {
    expect(plural(1, 'commit')).toBe('1 commit')
    expect(plural(2, 'commit')).toBe('2 commits')
    expect(plural(0, 'follower')).toBe('0 followers')
    expect(plural(1, 'follower')).toBe('1 follower')
  })

  it('takes an irregular plural', () => {
    expect(plural(1, 'copy', 'copies')).toBe('1 copy')
    expect(plural(3, 'copy', 'copies')).toBe('3 copies')
    expect(plural(2, 'pull request')).toBe('2 pull requests')
  })

  it('groups large counts and shows a given string as plural', () => {
    expect(plural(1234, 'commit')).toBe('1,234 commits')
    expect(plural('100+', 'commit')).toBe('100+ commits')
  })
})

describe('timeAgo (L-37)', () => {
  const now = 1_800_000_000_000
  const ago = (ms: number): string => timeAgo(now - ms, now)

  it('reads "just now" for anything under a minute, never "0m ago"', () => {
    expect(ago(0)).toBe('just now')
    expect(ago(30_000)).toBe('just now')
    expect(ago(45_000)).toBe('just now')
    expect(ago(59_999)).toBe('just now')
  })

  it('reads "just now" for a time slightly in the future (clock skew)', () => {
    expect(timeAgo(now + 5_000, now)).toBe('just now')
  })

  it('switches to minutes at exactly one minute', () => {
    expect(ago(60_000)).toBe('1m ago')
    expect(ago(59 * 60_000 + 59_999)).toBe('59m ago')
  })

  it('keeps the hour, day, month and year boundaries', () => {
    expect(ago(60 * 60_000)).toBe('1h ago')
    expect(ago(24 * 3_600_000 - 1)).toBe('23h ago')
    expect(ago(24 * 3_600_000)).toBe('1d ago')
    expect(ago(30 * 86_400_000)).toBe('1mo ago')
    expect(ago(360 * 86_400_000)).toBe('1y ago')
  })

  it('is empty for no time', () => {
    expect(timeAgo(0, now)).toBe('')
  })
})

describe('branchName (L-37, D-104)', () => {
  it('drops refs/heads/ and keeps anything else as given', () => {
    expect(branchName('refs/heads/main')).toBe('main')
    expect(branchName('refs/heads/feature/greeting')).toBe('feature/greeting')
    expect(branchName('refs/tags/v1')).toBe('refs/tags/v1')
    expect(branchName('')).toBe('')
  })
})

describe('forkSourcePrefix (QW4-030)', () => {
  const base = { ownerId: 'BASEOWNER', name: 'qa4-proj' }
  it("names a fork's owner, as GitHub's user:branch, and its name only when it differs", () => {
    expect(forkSourcePrefix({ ownerId: '2f4fqq3xyz', ownerLabel: '2f4fqq3', name: 'qa4-proj' }, base)).toBe('2f4fqq3:')
    expect(forkSourcePrefix({ ownerId: '2f4fqq3xyz', ownerLabel: 'alice.dash', name: 'my-copy' }, base)).toBe('alice.dash/my-copy:')
  })
  it("names only the repo for the owner's own fork, and nothing for a same-repo PR", () => {
    expect(forkSourcePrefix({ ownerId: 'BASEOWNER', ownerLabel: 'owner', name: 'other' }, base)).toBe('other:')
    expect(forkSourcePrefix(null, base)).toBe('')
  })
})
