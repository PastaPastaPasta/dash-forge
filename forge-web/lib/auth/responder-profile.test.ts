import { describe, expect, it } from 'vitest'

import { NEW_IDENTITY_MS, responderWarnings } from './responder-profile'

const ALICE = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MALLORY = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const now = 1_000_000_000_000

describe('who answered: the confirmation warnings', () => {
  it('says nothing for the identity this device knows, with an old username', () => {
    expect(responderWarnings({ identityId: ALICE, name: 'alice.dash', namedAt: now - 30 * NEW_IDENTITY_MS }, [ALICE], now)).toEqual([])
  })

  it('flags an identity other than the one this device holds, loudly and first', () => {
    const w = responderWarnings({ identityId: MALLORY, name: null, namedAt: null }, [ALICE], now)
    expect(w[0]).toMatch(/NOT the identity this device already holds/)
    expect(w).toHaveLength(2)
  })

  it('flags no username, and a username registered in the last day', () => {
    expect(responderWarnings({ identityId: ALICE, name: null, namedAt: null }, [], now)[0]).toMatch(/no DPNS username/)
    expect(responderWarnings({ identityId: ALICE, name: 'a1ice.dash', namedAt: now - 60_000 }, [], now)[0]).toMatch(/less than a day ago/)
  })
})
