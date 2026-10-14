/**
 * An access notice's push fields (phase 4E, `private-repos.md` §24.2): a list round trips sorted,
 * suspending removes it, a malformed list allows no push, and the public push line. forge-core
 * `access_notice::tests::a_push_list_round_trips_and_suspending_removes_it`.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PUSH_POLICY,
  MAY_PUSH,
  PUSH_FIELD,
  PUSH_POLICY_FIELD,
  allowsPush,
  decodeNotice,
  encodeNotice,
  noticeMay,
  pushEntries,
  pushLine,
  pushPolicy,
  setPush,
  type AccessNotice,
} from './access-notice'

const notice: AccessNotice = {
  bot: new Uint8Array(32).fill(4),
  may: ['post'],
  askers: 'writers',
  threads: 'all',
  processor: null,
  until: null,
  revokes: [],
  note: '',
  extra: { later: 1 },
}

describe('push fields', () => {
  it('round trip sorted by grant, and suspending removes them', () => {
    const n = setPush(
      notice,
      [
        { grant: new Uint8Array(32).fill(9), target: { members: new Uint8Array(32).fill(3) } },
        { grant: new Uint8Array(32).fill(2), target: { prefix: 'refs/heads/bot/ci-bot/' } },
        { grant: new Uint8Array(32).fill(2), target: { prefix: 'refs/heads/other/' } },
      ],
      DEFAULT_PUSH_POLICY,
    )
    expect(n.may).toEqual(['post', 'push'])
    expect(allowsPush(n)).toBe(true)
    const back = decodeNotice(encodeNotice(n))
    expect(back).not.toBeNull()
    const entries = pushEntries(back as AccessNotice)
    // each grant once: the first of two with the same id is kept
    expect(entries?.map((e) => e.grant[0])).toEqual([2, 9])
    expect(entries?.[0]?.target).toEqual({ prefix: 'refs/heads/bot/ci-bot/' })
    expect(entries?.[1]?.target).toEqual({ members: new Uint8Array(32).fill(3) })
    expect(pushPolicy(back as AccessNotice)).toEqual(DEFAULT_PUSH_POLICY)
    expect(new TextDecoder().decode(encodeNotice(n))).toContain('"pushPolicy":{"deleteOwnOnly":true,"fastForwardOnly":true,"openPrNotPush":false}')
    // what a later version wrote stays
    expect(back?.extra.later).toBe(1)

    const kept = { ...DEFAULT_PUSH_POLICY, openPrNotPush: true }
    const suspended = setPush(n, [], kept)
    expect(noticeMay(suspended, MAY_PUSH)).toBe(false)
    expect(PUSH_FIELD in suspended.extra && PUSH_POLICY_FIELD in suspended.extra).toBe(false)
    expect(PUSH_POLICY_FIELD in suspended.extra).toBe(true)
    // a suspension keeps the rules, so a resume reads them back
    expect(pushPolicy(suspended)).toEqual(kept)
    expect(suspended.extra.later).toBe(1)
    expect(allowsPush(suspended)).toBe(false)
  })

  it('a malformed list allows no push, and a malformed policy is the default', () => {
    const bad: AccessNotice = { ...notice, may: ['post', 'push'], extra: { push: 'x', pushPolicy: { fastForwardOnly: false } } }
    expect(pushEntries(bad)).toBeNull()
    expect(allowsPush(bad)).toBe(false)
    expect(pushPolicy(bad)).toEqual(DEFAULT_PUSH_POLICY)
    // a prefix not as `prefixOf` gives it
    const glob: AccessNotice = { ...bad, extra: { push: [{ grant: '01'.repeat(32), match: 'prefix', ref: 'bot/x/' }] } }
    expect(pushEntries(glob)).toBeNull()
    // an empty list with `push` still allows it (no grant listed)
    expect(allowsPush({ ...bad, extra: { push: [] } })).toBe(true)
  })

  it('keeps the stated policy', () => {
    const n = setPush(notice, [{ grant: new Uint8Array(32).fill(1), target: { prefix: 'refs/heads/gh-pages' } }], { fastForwardOnly: false, deleteOwnOnly: false, openPrNotPush: true })
    expect(pushPolicy(n)).toEqual({ fastForwardOnly: false, deleteOwnOnly: false, openPrNotPush: true })
  })
})

describe('the push line', () => {
  it('names prefixes with their end and counts members-only branches', () => {
    expect(pushLine([['refs/heads/bot/ci-bot/', 1_794_009_600_000]], 1)).toBe('Can push to bot/ci-bot/ until 7 Nov 2026 and 1 members-only branch.')
    expect(pushLine([], 2)).toBe('Can push to 2 members-only branches.')
    expect(pushLine([], 0)).toBeNull()
  })
})
