/**
 * Repo cards on the landing page and Explore (QA wave bonsia, QW-045): a fork's default
 * description names its parent by identity id, which read as a raw 44-character string. The card
 * shortens ids the way the owner chip does, and keeps the full text in the title.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/author', () => ({ Author: () => null }))
vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }))

import type { DiscoveredRepo } from '@/lib/view'
import { RepoCard, shortenIds } from './repo-card'
import { SHOWCASE, showcaseFor } from '@/lib/view/showcase'

describe('shortenIds', () => {
  it("shortens a fork's parent id and leaves the rest alone", () => {
    const text = 'fork of Gv6vLDkDqF4w6Kc4QvY9pZbN3sZ5aJmXxT1r2yH8uW6/forge-v2-demo'
    expect(shortenIds(text)).toBe('fork of Gv6vLD…yH8uW6/forge-v2-demo')
    expect(shortenIds('A small demo project')).toBe('A small demo project')
  })
})

describe('the showcase (QW-045)', () => {
  it('features sakura\'s demo repo, and nothing on a network without an entry', () => {
    expect(showcaseFor('devnet-sakura').map((e) => e.name)).toEqual(['forge-v2-demo'])
    expect(showcaseFor('testnet')).toEqual([])
    expect(Object.keys(SHOWCASE)).toEqual(['devnet-sakura'])
  })
})

// QW2-065: a card with one star read "1 stars".
describe('RepoCard star count', () => {
  const card = (stars: number): string => {
    const repo = { key: 'k', ownerId: 'o', name: 'n', slug: 'n', description: '', createdAt: 0, visibility: 'public', stars, issues: null, pushedAt: null } as unknown as DiscoveredRepo
    return renderToStaticMarkup(<RepoCard repo={repo} />).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  }
  it('says "1 star" and "2 stars"', () => {
    expect(card(1)).toContain('1 star ')
    expect(card(1)).not.toContain('1 stars')
    expect(card(2)).toContain('2 stars')
  })
})
