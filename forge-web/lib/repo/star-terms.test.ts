/**
 * The Star button's price and label for each star shape. The signed-out viewer on a fused-star
 * network used to be told to "turn off in Settings" a Trending opt-out that network does not
 * have, because the shape was only read once signed in.
 */

import { describe, expect, it } from 'vitest'

import { starTerms } from './star-shape'

describe('starTerms', () => {
  it('fused: every star counts and there is nothing to turn off', () => {
    const t = starTerms('fused', true, true)
    expect(t.trendingNote).toBe(' · counts toward Trending')
    expect(t.beats).toBe(false)
    // Priced as an upper bound until the fused shape is re-measured.
    expect(t.priceBeat).toBe(true)
  })

  it('fused, signed out (no beat allowed for an empty viewer): same label', () => {
    expect(starTerms('fused', true, false).trendingNote).toBe(' · counts toward Trending')
  })

  it('beat with Trending on: writes and prices a beat, and names the switch', () => {
    expect(starTerms('beat', true, true)).toEqual({
      beats: true,
      priceBeat: true,
      trendingNote: ' · counts toward Trending (turn off in Settings)',
    })
  })

  it('beat with Trending off, or on a repo that takes no beat: the star alone', () => {
    expect(starTerms('beat', false, true)).toEqual({ beats: false, priceBeat: false, trendingNote: '' })
    expect(starTerms('beat', true, false)).toEqual({ beats: false, priceBeat: false, trendingNote: '' })
  })

  it('unknown shape: the larger price, and no promise either way', () => {
    expect(starTerms(null, true, true)).toEqual({ beats: false, priceBeat: true, trendingNote: '' })
  })
})
