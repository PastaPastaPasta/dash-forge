import { describe, expect, it } from 'vitest'

import { responderWarnings } from './responder-profile'

const ALICE = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MALLORY = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'

describe('who answered: the confirmation warnings', () => {
  it('says nothing for a named identity this device knows, however new the name', () => {
    expect(responderWarnings({ identityId: ALICE, name: 'alice.dash' }, [ALICE])).toEqual([])
    expect(responderWarnings({ identityId: ALICE, name: 'a1ice.dash' }, [])).toEqual([])
  })

  it('flags an identity other than the one this device holds, first', () => {
    const w = responderWarnings({ identityId: MALLORY, name: null }, [ALICE])
    expect(w[0]).toMatch(/Not the identity this browser already knows/)
    expect(w).toHaveLength(2)
  })

  it('flags no username', () => {
    expect(responderWarnings({ identityId: ALICE, name: null }, [])[0]).toMatch(/no username/)
  })
})
