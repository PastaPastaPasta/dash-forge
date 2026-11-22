// @vitest-environment jsdom
/**
 * The repo home with no tip to show: a default branch never pushed while other refs were is not an
 * empty repo, and the storage warning on an empty one is for whoever can configure storage.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResolvedRef } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'

let identity: string | null = null
let role: string | null = null
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity, signer: null }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role, known: true, failed: false, retry: () => undefined }) }))
vi.mock('@/components/repo/conversion-status', () => ({ BeingMadePublicState: ({ empty }: { empty: JSX.Element }) => empty }))

const { RepoHomeContent } = await import('./repo-home-content')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OWNER = 'AyvEsSQfK5qBotCsi2gZpePa7DcniqWzZ281TaNsJGv7'
const OID = 'a'.repeat(40)
const ref = (refName: string, oid: string | null = OID): ResolvedRef =>
  ({ refName, refNameHash: '', state: oid === null ? { state: 'unborn' } : { state: 'resolved', oid } }) as unknown as ResolvedRef
const home = (branches: ResolvedRef[], tags: ResolvedRef[] = []): RepoHome =>
  ({
    repo: { repoId: 'r', ownerId: OWNER, name: 'e2e-cli', visibility: 'public', forge: {} },
    v2: {},
    description: '',
    config: null,
    defaultBranch: 'main',
    branches,
    tags,
    starCount: 0,
    backend: { mode: 0, kind: 'platform', uris: [] },
  }) as unknown as RepoHome
const addr = { owner: OWNER, name: 'e2e-cli' }

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  identity = null
  role = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const render = (h: RepoHome): void => act(() => root.render(<RepoHomeContent home={h} addr={addr} />))
const q = (testId: string): Element | null => host.querySelector(`[data-testid="${testId}"]`)

describe('a repo home with no default-branch tip', () => {
  it('lists the branches and tags it has instead of calling it empty', () => {
    render(home([ref('refs/heads/e2e/1/base'), ref('refs/heads/e2e/1/feature')], [ref('refs/tags/v1')]))
    expect(host.textContent).not.toContain('is empty')
    expect(q('default-branch-unborn')?.textContent).toContain('The default branch main has no commits yet')
    expect(q('default-branch-unborn')?.textContent).toContain('This repo has 2 branches and 1 tag.')
    const links = [...host.querySelectorAll('ul[aria-label="Branches"] a')]
    expect(links.map((a) => a.textContent)).toEqual(['e2e/1/base', 'e2e/1/feature'])
    expect(links[0]?.getAttribute('href')).toContain('ref=e2e%2F1%2Fbase')
  })

  it('still calls a repo with only deleted refs empty', () => {
    render(home([ref('refs/heads/old', null)]))
    expect(q('default-branch-unborn')).toBeNull()
    expect(host.querySelector('section[aria-label="Empty repository"]')).not.toBeNull()
  })
})

describe('the empty repo’s storage warning', () => {
  it('is hidden from a signed-out visitor and from a member who cannot push', () => {
    render(home([]))
    expect(host.textContent).not.toContain('No storage configured')
    identity = 'someone-else'
    role = 'triage'
    render(home([]))
    expect(host.textContent).not.toContain('No storage configured')
  })

  it('shows to the owner and to whoever pushes here', () => {
    identity = OWNER
    render(home([]))
    expect(host.textContent).toContain('No storage configured')
    identity = 'another-maintainer'
    role = 'maintainer'
    render(home([]))
    expect(host.textContent).toContain('No storage configured')
    role = 'writer'
    render(home([]))
    expect(host.textContent).toContain('No storage configured')
  })
})

describe('the empty repo’s first-push steps', () => {
  it('numbers install, sign in and push, with a first commit for a repo started from scratch', () => {
    identity = OWNER
    render(home([]))
    const steps = [...host.querySelectorAll('section[aria-label="Empty repository"] ol > li h3')].map((h) => h.textContent)
    expect(steps).toEqual(['Install the Dash git tools', 'Sign in on this computer', 'Push your code'])
    const lines = [...host.querySelectorAll('section[aria-label="Empty repository"] code')].map((c) => c.textContent)
    expect(lines[0]).toMatch(/^dg auth login --mnemonic /)
    expect(lines.at(-1)).toMatch(/> README\.md && git add README\.md && git commit -m 'First commit' && git push -u origin HEAD:main$/)
    expect(host.textContent).toContain('Three steps to your first push.')
  })

  it('tells a visitor nothing is pushed yet instead of addressing them as the pusher', () => {
    render(home([]))
    expect(host.textContent).toContain('Nothing has been pushed yet.')
    expect(host.textContent).not.toContain('Three steps to your first push.')
  })
})
