// @vitest-environment jsdom
/**
 * Settings → Environments (DESIGN §4.5, §10): the empty state, masked values with a local show
 * toggle that stores nothing, the Members sentence, "Access is granted, not logged.", the
 * ignored-change warning, a conflict listing every version with the dg fix, counts (never names)
 * for environments the viewer can't read, the unlock prompt, and the removal checklist.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvPageView, EnvCardView, RemovalView } from '@/lib/env/view'
import type { RepoHome } from '@/lib/view'

const { envState } = vi.hoisted(() => ({
  envState: { value: { state: { data: null, loading: true, error: null, cause: null, settled: false, reload: () => undefined }, locked: false } as unknown },
}))
vi.mock('@/hooks/use-environments', () => ({ useEnvironments: () => envState.value }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: (id: string) => (id === 'BOB' ? 'bob' : undefined) }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span data-testid="author">{identityId}</span> }))
vi.mock('@/components/auth/unlock-more', () => ({
  UNLOCK_MEMBERS_ONLY: 'Unlock to read members-only content',
  UnlockMore: ({ title }: { title: string }) => <button type="button">{title}</button>,
}))
vi.mock('@/components/repo/private-repo-state', () => ({ PrivateRepoState: () => <p>private</p> }))

import { EMPTY_TEXT, EnvironmentsContent, EnvironmentsView, RemovalLines } from './environments-content'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SECRET = 'QAMARK-prod-db-password'
const head = (id: string, author: string) => ({ id, author, createdAt: Date.UTC(2026, 9, 5, 8, 41) })
const entry = (name: string, value: string) => ({ name, type: 'secret' as const, note: '', value })

function card(over: Partial<EnvCardView>): EnvCardView {
  return {
    env: 'production',
    kind: 'current',
    audience: 'maintainers',
    readers: ['ALICE', 'CAROL'],
    entries: [entry('DB_URL', SECRET), entry('STRIPE_KEY', 'QAMARK-stripe')],
    updated: head('8V2UnsMbU1xxxxxxxx', 'ALICE'),
    savedFor: null,
    ignored: null,
    conflict: null,
    unreadable: null,
    ...over,
  }
}
const page = (cards: EnvCardView[], hidden = 0): EnvPageView => ({ cards, hidden, ignored: 0, empty: cards.length === 0 && hidden === 0 })

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const render = (el: JSX.Element): void => act(() => root.render(el))
const text = (): string => host.textContent ?? ''
const byTestId = (id: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)]

describe('EnvironmentsView', () => {
  it('says what environments are when there are none', () => {
    render(<EnvironmentsView view={page([])} />)
    expect(byTestId('env-empty')[0]?.textContent).toBe(EMPTY_TEXT.replaceAll('`', ''))
    expect(host.querySelector('code')?.textContent).toBe('dg env run')
  })

  it('masks every value until asked, and stores nothing when one is shown', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const log = vi.spyOn(console, 'log')
    render(<EnvironmentsView view={page([card({})])} />)
    expect(host.innerHTML).not.toContain(SECRET)
    expect(byTestId('env-value').map((v) => v.textContent)).toEqual(['•'.repeat(16), '•'.repeat(16)])
    const show = host.querySelector<HTMLButtonElement>('button[aria-label="Show DB_URL"]')!
    act(() => show.click())
    expect(byTestId('env-value')[0]?.textContent).toBe(SECRET)
    expect(byTestId('env-value')[1]?.textContent).toBe('•'.repeat(16))
    expect(host.querySelector('button[aria-label="Hide DB_URL"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(setItem).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Hide DB_URL"]')!.click())
    expect(host.innerHTML).not.toContain(SECRET)
  })

  it('names who can read a Maintainers environment, and who updated it when', () => {
    render(<EnvironmentsView view={page([card({})])} />)
    expect(byTestId('env-readers')[0]?.textContent).toBe('ALICECAROL(maintainers when saved)')
    expect(byTestId('env-updated')[0]?.textContent).toBe('Updated by ALICE at 2026-10-05 08:41 UTC')
    expect(text()).not.toContain('Readers, CI runners')
  })

  it('carries the Members sentence on a Members environment', () => {
    render(<EnvironmentsView view={page([card({ env: 'dev', audience: 'members', readers: [] })])} />)
    expect(byTestId('env-readers')[0]?.textContent).toBe('Every member of this repo')
    expect(byTestId('env-members-sentence')[0]?.textContent).toBe(
      'Readers, CI runners made members, and future members can read every value stored here, including past values.',
    )
  })

  it('counts environments this viewer cannot read, never naming them', () => {
    render(<EnvironmentsView view={page([], 2)} />)
    expect(byTestId('env-hidden')[0]?.textContent).toBe('2 environments')
    expect(byTestId('env-card')).toHaveLength(0)
    render(<EnvironmentsView view={page([card({ env: 'dev', audience: 'members', readers: [] })], 1)} />)
    expect(byTestId('env-hidden')[0]?.textContent).toBe("1 more environment you can't read")
  })

  it('warns once about a newer change by someone who is not a maintainer now', () => {
    render(<EnvironmentsView view={page([card({ ignored: { head: head('3kQx7pWm2vxxxxxx', 'BOB'), more: 0 } })])} />)
    expect(byTestId('env-ignored')[0]?.textContent).toBe(
      "production has a newer change by bob at 2026-10-05 08:41 UTC (3kQx7pWm2v), who isn't a maintainer now; it was ignored. Ask a maintainer to check production's values.",
    )
  })

  it('lists every version of a conflict and how to keep one with dg', () => {
    const versions = [
      { head: head('8V2UnsMbU1aaaaaa', 'ALICE'), entries: [entry('DB_URL', 'QAMARK-x')] },
      { head: head('ByFFj1bXroaaaaaa', 'CAROL'), entries: null },
    ]
    render(
      <EnvironmentsView
        view={page([card({ kind: 'conflict', entries: [], updated: null, conflict: { headline: '2 people changed production at the same time', split: false, versions } })])}
      />,
    )
    const c = byTestId('env-conflict')[0]!
    expect(c.textContent).toContain("2 people changed production at the same time, so its values can't be used until a maintainer keeps one.")
    expect(byTestId('env-version').map((v) => v.querySelector('code')?.textContent)).toEqual(['8V2UnsMbU1', 'ByFFj1bXro'])
    expect(byTestId('env-version')[1]?.textContent).toContain("You can't read this version here.")
    expect(c.textContent).toContain('Compare them with dg env history --env production, then a maintainer keeps one: dg env edit --env production --keep <id>')
    expect(host.innerHTML).not.toContain('QAMARK-x')
  })

  it('fails closed on a latest change it cannot read', () => {
    const h = head('ZZZZZZZZZZzzzz', 'CAROL')
    render(<EnvironmentsView view={page([card({ kind: 'unreadable', entries: [], updated: h, unreadable: { reason: 'it was not sent to you', unfetched: false, head: h } })])} />)
    expect(byTestId('env-unreadable')[0]?.textContent).toContain("The latest change to production can't be read here: it was not sent to you.")
    expect(byTestId('env-entries')).toHaveLength(0)
  })
})

describe('EnvironmentsContent', () => {
  const home = { repo: { repoId: 'R', name: 'shop', ownerId: 'O', visibility: 'public' } } as unknown as RepoHome
  const addr = { owner: 'O', name: 'shop' }

  it('offers the unlock when the key is locked, with the dg edit hint and the access sentence', () => {
    envState.value = { state: { data: null, loading: true, error: null, cause: null, settled: false, reload: () => undefined }, locked: true }
    render(<EnvironmentsContent home={home} addr={addr} />)
    expect(host.querySelector('button')?.textContent).toBe('Unlock to read members-only content')
    expect(text()).toContain('Edit with dg: dg env set NAME --env production')
    expect(byTestId('env-access-sentence')[0]?.textContent).toBe('Access is granted, not logged.')
  })
})

describe('RemovalLines', () => {
  it('lists what a removed member could read, to rotate at its source', () => {
    const view: RemovalView = { exposures: [{ env: 'dev', audience: 'members', names: ['API_TOKEN', 'API_URL'] }], unreadable: 1 }
    render(<RemovalLines view={view} name="bob" />)
    const lines = [...byTestId('env-removal')[0]!.querySelectorAll('p')].map((p) => p.textContent)
    expect(lines).toEqual([
      'bob could read 2 dev values (and every past value of it). Rotate them at their source: API_TOKEN, API_URL',
      "You can't read 1 environment here, so it isn't listed. bob may have been able to read values there.",
      "Removing someone can't take back what they could already read.",
    ])
  })

  it('says nothing when there is nothing to rotate', () => {
    render(<RemovalLines view={{ exposures: [], unreadable: 0 }} name="bob" />)
    expect(host.innerHTML).toBe('')
  })
})
