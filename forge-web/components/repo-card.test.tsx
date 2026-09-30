/**
 * Repo cards on the landing page and Explore (QA wave bonsia, QW-045): a fork's default
 * description names its parent by identity id, which read as a raw 44-character string. The card
 * shortens ids the way the owner chip does, and keeps the full text in the title.
 */

import { describe, expect, it } from 'vitest'

import { shortenIds } from './repo-card'
import { SHOWCASE, showcaseFor } from '@/lib/view/showcase'

describe('shortenIds', () => {
  it("shortens a fork's parent id and leaves the rest alone", () => {
    const text = 'fork of Gv6vLDkDqF4w6Kc4QvY9pZbN3sZ5aJmXxT1r2yH8uW6/forge-v2-demo'
    expect(shortenIds(text)).toBe('fork of Gv6vLD…yH8uW6/forge-v2-demo')
    expect(shortenIds('A small demo project')).toBe('A small demo project')
  })
})

describe('the showcase (QW-045)', () => {
  it('features the bonsia demo repos, and nothing on a network without an entry', () => {
    expect(showcaseFor('devnet-bonsia').map((e) => e.name)).toEqual(['dips', 'dash', 'forge-v2-demo'])
    expect(showcaseFor('testnet')).toEqual([])
    expect(Object.keys(SHOWCASE)).toEqual(['devnet-bonsia'])
  })
})
