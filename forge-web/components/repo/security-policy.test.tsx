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
const tipFor = vi.hoisted(() => ({ tip: 'tip-1' as string | null, unavailable: false }))
vi.mock('@/components/repo/issue-templates', () => ({
  useDefaultBranchReader: (_home: unknown, enabled: boolean) => ({
    tip: tipFor.tip,
    reader: enabled && tipFor.tip !== null && !tipFor.unavailable ? reader : null,
    unavailable: enabled && tipFor.unavailable,
  }),
}))
// The page reads inside the browse boundary; the test hands it a reader.
vi.mock('@/components/repo/browse-boundary', () => ({ BrowseBoundary: ({ children }: { children: (r: unknown, retry: () => void) => React.ReactNode }) => <>{children(reader, () => undefined)}</> }))
const find = vi.hoisted(() => vi.fn())
const read = vi.hoisted(() => vi.fn())
vi.mock('@/lib/view/security-policy', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/view/security-policy')>()), findSecurityPolicy: find, readSecurityPolicy: read }))

const { SecurityHint, SecurityPolicyContent, SecurityPolicyLink } = await import('./security-policy')

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
  read.mockReset()
  tipFor.tip = 'tip-1'
  tipFor.unavailable = false
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = async (el: JSX.Element): Promise<void> => {
  await act(async () => root.render(el))
}
/** The header link waits a moment before it reads (so the page's own reads go first). */
const renderHeader = async (el: JSX.Element): Promise<void> => {
  vi.useFakeTimers()
  try {
    await act(async () => root.render(el))
    await act(async () => void vi.advanceTimersByTime(2000))
  } finally {
    vi.useRealTimers()
  }
  await act(async () => undefined)
}
const text = (): string => host.textContent ?? ''

describe('Security policy link', () => {
  it('shows when the default branch has a policy, and goes to the page', async () => {
    find.mockResolvedValue({ path: '.github/SECURITY.md', oid: 'x' })
    await renderHeader(<SecurityPolicyLink home={home('public', 'with')} addr={addr} load />)
    const link = host.querySelector<HTMLAnchorElement>('[data-testid="security-policy-link"]')
    expect(link?.textContent).toBe('Security policy')
    expect(link?.getAttribute('href')).toContain('/repo/security')
    expect(link?.getAttribute('href')).toContain('owner=alice')
  })

  it('is absent when there is no policy, and never reads a private repo', async () => {
    find.mockResolvedValue(null)
    await renderHeader(<SecurityPolicyLink home={home('public', 'without')} addr={addr} load />)
    expect(host.querySelector('[data-testid="security-policy-link"]')).toBeNull()
    find.mockClear()
    await renderHeader(<SecurityPolicyLink home={home('private', 'sealed')} addr={addr} load />)
    expect(host.querySelector('[data-testid="security-policy-link"]')).toBeNull()
    expect(find).not.toHaveBeenCalled()
  })

  it('is absent for a repo with no commits yet, and when the lookup fails', async () => {
    tipFor.tip = null
    await renderHeader(<SecurityPolicyLink home={home('public', 'empty')} addr={addr} load />)
    expect(find).not.toHaveBeenCalled()
    tipFor.tip = 'tip-2'
    find.mockRejectedValue(new Error('storage down'))
    await renderHeader(<SecurityPolicyLink home={home('public', 'broken')} addr={addr} load />)
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

describe('Security policy hint when the code cannot be read', () => {
  it('settles on the maintainer sentence, never stuck half-written', async () => {
    tipFor.unavailable = true
    await render(<SecurityHint home={home('public', 'hint-unreadable')} addr={addr} enabled />)
    expect(text()).toBe('Issues are public and permanent. Reporting a vulnerability? Contact a maintainer privately.')
    expect(find).not.toHaveBeenCalled()
  })
})

describe('Security policy page', () => {
  const content = (h: RepoHome): JSX.Element => <SecurityPolicyContent home={h} addr={addr} />
  const withBranch = (h: RepoHome): RepoHome =>
    ({ ...h, defaultBranch: 'main', tags: [], branches: [{ refName: 'refs/heads/main', state: { state: 'resolved', oid: 'a'.repeat(40) } }] }) as unknown as RepoHome

  it('says where the text is from and renders it without raw HTML or scripts', async () => {
    find.mockResolvedValue({ path: '.github/SECURITY.md', oid: 'o' })
    read.mockResolvedValue({
      kind: 'text',
      text: '# Reporting\n\nEmail **security@example.com**.\n\n<script>window.__pwned = true</script>\n\n<img src=x onerror="window.__pwned = true">\n\n[click](javascript:window.__pwned=true)\n',
    })
    await render(content(withBranch(home('public', 'page-with'))))
    await act(async () => undefined)
    expect(host.querySelector('[data-testid="security-policy-source"]')?.textContent).toBe('From .github/SECURITY.md on main')
    const article = host.querySelector('[data-testid="security-policy"]')!
    expect(article.textContent).toContain('security@example.com')
    expect(article.querySelector('script')).toBeNull()
    expect(article.querySelector('img[onerror]')).toBeNull()
    expect(article.innerHTML).not.toMatch(/javascript:/i)
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it('says so when the repo has no policy, and for a private repo', async () => {
    find.mockResolvedValue(null)
    await render(content(withBranch(home('public', 'page-without'))))
    await act(async () => undefined)
    expect(text()).toContain('This repo has no security policy.')
    expect(host.querySelector('[data-testid="security-policy"]')).toBeNull()
    await render(content(withBranch(home('private', 'page-private'))))
    expect(text()).toContain('Security policies are shown for public repos.')
    expect(find).toHaveBeenCalledTimes(1)
  })

  it('links the file when it is too large to show', async () => {
    find.mockResolvedValue({ path: 'SECURITY.md', oid: 'big' })
    read.mockResolvedValue({ kind: 'tooLarge' })
    await render(content(withBranch(home('public', 'page-big'))))
    await act(async () => undefined)
    expect(host.querySelector('[data-testid="security-policy-unshown"]')?.textContent).toContain('too large')
    expect(host.querySelector('[data-testid="security-policy-unshown"] a')?.getAttribute('href')).toContain('/repo/blob')
  })
})

describe('Security policy link where the page does not read the code', () => {
  it('reads nothing, and shows what an earlier lookup found', async () => {
    find.mockResolvedValue({ path: 'SECURITY.md', oid: 'x' })
    const h = home('public', 'quiet')
    await render(<SecurityPolicyLink home={h} addr={addr} load={false} />)
    expect(find).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="security-policy-link"]')).toBeNull()
    // The Code tab (or the issue form) looks it up ...
    await renderHeader(<SecurityPolicyLink home={h} addr={addr} load />)
    expect(host.querySelector('[data-testid="security-policy-link"]')).not.toBeNull()
    // ... and the next page, which reads nothing, shows it.
    await render(<SecurityPolicyLink home={h} addr={addr} load={false} />)
    expect(host.querySelector('[data-testid="security-policy-link"]')).not.toBeNull()
  })
})
