// @vitest-environment jsdom
/**
 * D37: the repo header links "Security policy" only when the default branch has one, and the
 * new-issue form always carries the reminder: with the link when there is a policy, else
 * "Contact a maintainer privately." Private repos read nothing.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))

const reader = { name: 'reader' }
const tipFor = vi.hoisted(() => ({ tip: 'tip-1' as string | null }))
vi.mock('@/components/repo/issue-templates', () => ({
  useDefaultBranchReader: (_home: unknown, enabled: boolean) => ({ tip: tipFor.tip, reader: enabled && tipFor.tip !== null ? reader : null }),
}))
const find = vi.hoisted(() => vi.fn())
vi.mock('@/lib/view/security-policy', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/view/security-policy')>()), findSecurityPolicy: find }))

const { SecurityHint, SecurityPolicyLink } = await import('./security-policy')

const addr = { owner: 'alice', name: 'project' }
const home = (visibility: 'public' | 'private' = 'public', repoId = 'repo-1'): RepoHome => ({ repo: { repoId, visibility, ownerId: 'o', name: 'project' } }) as unknown as RepoHome

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  find.mockReset()
  tipFor.tip = 'tip-1'
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = async (el: JSX.Element): Promise<void> => {
  await act(async () => root.render(el))
}
const text = (): string => host.textContent ?? ''

describe('Security policy link', () => {
  it('shows when the default branch has a policy, and goes to the page', async () => {
    find.mockResolvedValue({ path: '.github/SECURITY.md', oid: 'x' })
    await render(<SecurityPolicyLink home={home('public', 'with')} addr={addr} />)
    const link = host.querySelector<HTMLAnchorElement>('[data-testid="security-policy-link"]')
    expect(link?.textContent).toBe('Security policy')
    expect(link?.getAttribute('href')).toContain('/repo/security')
    expect(link?.getAttribute('href')).toContain('owner=alice')
  })

  it('is absent when there is no policy, and never reads a private repo', async () => {
    find.mockResolvedValue(null)
    await render(<SecurityPolicyLink home={home('public', 'without')} addr={addr} />)
    expect(host.querySelector('[data-testid="security-policy-link"]')).toBeNull()
    find.mockClear()
    await render(<SecurityPolicyLink home={home('private', 'sealed')} addr={addr} />)
    expect(host.querySelector('[data-testid="security-policy-link"]')).toBeNull()
    expect(find).not.toHaveBeenCalled()
  })

  it('is absent for a repo with no commits yet, and when the lookup fails', async () => {
    tipFor.tip = null
    await render(<SecurityPolicyLink home={home('public', 'empty')} addr={addr} />)
    expect(find).not.toHaveBeenCalled()
    tipFor.tip = 'tip-2'
    find.mockRejectedValue(new Error('storage down'))
    await render(<SecurityPolicyLink home={home('public', 'broken')} addr={addr} />)
    expect(host.querySelector('[data-testid="security-policy-link"]')).toBeNull()
  })
})

describe('New-issue security hint', () => {
  it('links the policy when there is one', async () => {
    find.mockResolvedValue({ path: 'SECURITY.md', oid: 'x' })
    await render(<SecurityHint home={home('public', 'hint-with')} addr={addr} enabled />)
    expect(text()).toBe('Issues are public and permanent. Reporting a vulnerability? Read the security policy.')
    expect(host.querySelector('[data-testid="security-hint-link"]')?.getAttribute('href')).toContain('/repo/security')
  })

  it('says to contact a maintainer when there is none', async () => {
    find.mockResolvedValue(null)
    await render(<SecurityHint home={home('public', 'hint-without')} addr={addr} enabled />)
    expect(text()).toBe('Issues are public and permanent. Reporting a vulnerability? Contact a maintainer privately.')
    expect(host.querySelector('[data-testid="security-hint-link"]')).toBeNull()
  })

  it('always shows, for a private repo too, without reading it', async () => {
    await render(<SecurityHint home={home('private', 'hint-private')} addr={addr} enabled />)
    expect(text()).toBe('Issues are public and permanent. Reporting a vulnerability? Contact a maintainer privately.')
    expect(find).not.toHaveBeenCalled()
  })
})
