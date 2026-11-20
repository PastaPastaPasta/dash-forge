// @vitest-environment jsdom
/**
 * The branch/tag switcher's trigger names the current ref, and its open popover ends with links
 * to the full branch and tag lists (routes that exist: `/repo/branches`, `/repo/tags`).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined }) }))
vi.mock('@/hooks/use-route', () => ({ usePathname: () => '/repo/blob/', useSearchParams: () => new URLSearchParams() }))

import { RefSwitcher } from './ref-switcher'
import type { RepoHome, SelectedRef } from '@/lib/view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A = 'a'.repeat(40)
const ref = (refName: string) => ({ refName, refNameHash: '', state: { state: 'resolved', oid: A, author: 'O', createdAt: 1 } })
const MAIN = ref('refs/heads/main')
const home = { defaultBranch: 'main', branches: [MAIN, ref('refs/heads/dev')], tags: [ref('refs/tags/v1.0.0')] } as unknown as RepoHome
const current = { name: 'main', ref: MAIN, isTag: false } as unknown as SelectedRef

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  Element.prototype.scrollIntoView = () => undefined
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const open = async (): Promise<HTMLButtonElement> => {
  await act(async () => {
    root.render(<RefSwitcher home={home} addr={{ owner: 'alice', name: 'proj' } as never} current={current} path="src/a.rs" />)
  })
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]') as HTMLButtonElement
  await act(async () => trigger.click())
  return trigger
}

describe('RefSwitcher', () => {
  it('names the current ref on its trigger', async () => {
    const trigger = await open()
    expect(trigger.getAttribute('aria-label')).toBe('Switch branches or tags, currently main')
    expect(trigger.textContent).toBe('main')
  })

  it('links to every branch and every tag from its footer', async () => {
    await open()
    const links = [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="ref-switcher-footer"] a')]
    expect(links.map((a) => a.textContent)).toEqual(['View all branches', 'View all tags'])
    expect(links[0]?.getAttribute('href')).toBe('/repo/branches/?owner=alice&name=proj')
    expect(links[1]?.getAttribute('href')).toBe('/repo/tags/?owner=alice&name=proj')
  })

  it('closes when a footer link is followed', async () => {
    await open()
    host.addEventListener('click', (e) => e.preventDefault())
    await act(async () => host.querySelector<HTMLAnchorElement>('[data-testid="ref-switcher-footer"] a')?.click())
    expect(host.querySelector('[role="listbox"]')).toBeNull()
  })
})
