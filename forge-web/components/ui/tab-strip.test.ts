import { describe, expect, it } from 'vitest'

import { MIN_FADE, edgeFades, stripScroll, type TabBox } from './tab-strip'

/** Tabs of these widths, 4 px apart (`gap-1`). */
function row(widths: number[]): TabBox[] {
  let left = 0
  return widths.map((width) => {
    const box = { left, width }
    left += width + 4
    return box
  })
}

const at = (tabs: TabBox[], i: number): TabBox => tabs[i] as TabBox

describe('stripScroll (QW2-072)', () => {
  // A PR's tabs on a 360 px phone: Conversation 283, Commits 93, Checks 0, Files changed 2.
  const pr = row([156, 122, 111, 151])
  const contentRight = 156 + 122 + 111 + 151 + 12

  it('does not scroll a strip that fits', () => {
    expect(stripScroll(row([80, 90, 100]), 2, 328)).toEqual({ left: 0, pad: 0 })
  })

  it('does not scroll for the first tab', () => {
    expect(stripScroll(pr, 0, 328)).toEqual({ left: 0, pad: 0 })
  })

  it('starts the last tab\'s run with a whole tab, padding the end to get there', () => {
    const { left, pad } = stripScroll(pr, 3, 328)
    // Checks is flush left: Commits is cut whole, never left as a bare "93".
    expect(left).toBe(at(pr, 2).left)
    expect(pad).toBe(left - (contentRight - 328))
    expect(at(pr, 3).left + at(pr, 3).width - left).toBeLessThanOrEqual(328)
  })

  it('keeps as many tabs before the active one as fit', () => {
    // Commits active: Conversation and Commits fit in 328 px together.
    expect(stripScroll(pr, 1, 328)).toEqual({ left: 0, pad: 0 })
    // Checks active: Commits and Checks fit, Conversation does not; no pad needed.
    expect(stripScroll(pr, 2, 328)).toEqual({ left: at(pr, 1).left, pad: 0 })
  })

  it('shows the start of a tab wider than the strip', () => {
    const wide = row([100, 400, 100])
    expect(stripScroll(wide, 1, 300).left).toBe(104)
  })

  it('copes with no tabs', () => {
    expect(stripScroll([], 0, 300)).toEqual({ left: 0, pad: 0 })
  })
})

describe('edgeFades (QW3-057)', () => {
  // The repo tabs on a 360 px phone (dips): Code, Issues 5, Pull requests 22, Releases.
  const repo = row([80, 100, 160, 108])

  it('fades nothing on a strip that fits', () => {
    expect(edgeFades(row([80, 90, 100]), 0, 328)).toEqual({ left: 0, right: 0 })
  })

  it('covers all of a tab the edge cuts, not just its count', () => {
    // At 360 px (a 328 px strip) "Pull requests 22" (188..348) is cut at 328: 88 % of it shows.
    const f = edgeFades(repo, 0, 328)
    expect(f.left).toBe(0)
    expect(f.right).toBe(Math.min(164, 328 - at(repo, 2).left))
    expect(f.right).toBeGreaterThan(MIN_FADE)
  })

  it('keeps at least the minimum fade where only whole tabs lie beyond the edge', () => {
    const f = edgeFades(repo, 0, at(repo, 2).left + at(repo, 2).width + 2)
    expect(f.right).toBe(MIN_FADE)
  })

  it('never covers more than half the strip', () => {
    expect(edgeFades(row([60, 300]), 0, 200).right).toBe(100)
  })

  it('fades the leading edge over a tab scrolled partly out of view', () => {
    const f = edgeFades(repo, 100, 328)
    // "Issues 5" (84..184) is cut at 100; "Releases" (352..460) at 428.
    expect(f.left).toBe(at(repo, 1).left + at(repo, 1).width - 100)
    expect(f.right).toBe(428 - at(repo, 3).left)
  })
})
