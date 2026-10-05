// @vitest-environment jsdom
/**
 * Role badges: a conversation page shows each author's role in the repository beside their
 * byline, from the membership documents; a stranger, a mirrored item's source author and every
 * page without roles show none.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))

import { AuthorRolesProvider } from './author-roles'
import { Byline } from './byline'
import type { Origin } from '@/lib/repo/provenance'
import type { Membership } from '@/lib/rules/v2'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OWNER = 'owner-identity'
const MEMBERS: Membership[] = [
  { identity: 'maint', role: 'maintainer', createdAt: 1 },
  { identity: 'tri', role: 'triage', createdAt: 1 },
]
const ORIGIN: Origin = { author: 'bob', host: 'github.com', url: 'https://github.com/o/r/issues/1', createdAt: 1 }

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function badgeFor(author: string, origin: Origin | null = null, provided = true): HTMLElement | null {
  const byline = <Byline author={author} createdAt={Date.now()} origin={origin} verb="commented" />
  act(() => root.render(provided ? <AuthorRolesProvider owner={OWNER} members={MEMBERS}>{byline}</AuthorRolesProvider> : byline))
  return host.querySelector('[data-testid="role-badge"]')
}

describe('role badges', () => {
  it('names the owner and each member’s role, for sight and for screen readers', () => {
    const owner = badgeFor(OWNER)
    expect(owner?.getAttribute('title')).toBe('Owner of this repository')
    expect(owner?.querySelector('[aria-hidden]')?.textContent).toBe('Owner')
    expect(owner?.querySelector('.sr-only')?.textContent).toBe('Owner of this repository')
    expect(badgeFor('maint')?.textContent).toContain('Maintainer')
    expect(badgeFor('tri')?.getAttribute('title')).toBe('Triage member of this repository')
  })

  it('shows none for a stranger, a mirrored item or a page without roles', () => {
    expect(badgeFor('stranger')).toBeNull()
    expect(badgeFor('maint', ORIGIN)).toBeNull()
    expect(badgeFor('maint', null, false)).toBeNull()
  })
})
