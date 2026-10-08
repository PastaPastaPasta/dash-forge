// @vitest-environment jsdom
/**
 * Settings → Environments (DESIGN §4.5, §10): the empty state, masked values with a local show
 * toggle that stores nothing, the audience label and who it was saved to, the old-format banner,
 * a maintainer's list of who an environment misses, "Access is granted, not logged.", the
 * ignored-change warning, a conflict listing every version with the dg fix, counts (never names)
 * for environments the viewer can't read and the note that one hasn't been shared, the unlock
 * prompt, and the removal checklist.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OLD_FORMAT_HISTORY_SENTENCE, OLD_FORMAT_SENTENCE } from '@/lib/env'
import type { EnvPageView, EnvCardView, RemovalView, StaleItem } from '@/lib/env/view'
import type { RepoHome } from '@/lib/view'

const { envState } = vi.hoisted(() => ({
  envState: { value: { state: { data: null, loading: true, error: null, cause: null, settled: false, reload: () => undefined }, locked: false } as unknown },
}))
vi.mock('@/hooks/use-environments', () => ({ useEnvironments: () => envState.value, useRepoPeople: () => null }))
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
    audience: { group: 'maintainers', also: [] },
    audienceLabel: 'Maintainers',
    membersKey: false,
    readers: ['ALICE', 'CAROL'],
    oldFormat: null,
    stale: [],
    entries: [entry('DB_URL', SECRET), entry('STRIPE_KEY', 'QAMARK-stripe')],
    updated: head('8V2UnsMbU1xxxxxxxx', 'ALICE'),
    savedFor: null,
    ignored: null,
    conflict: null,
    unreadable: null,
    ...over,
  }
}
const page = (cards: EnvCardView[], hidden = 0, over: Partial<EnvPageView> = {}): EnvPageView => ({
  cards,
  hidden,
  ignored: 0,
  empty: cards.length === 0 && hidden === 0,
  notShared: false,
  viewerMaintainer: false,
  ...over,
})
const oldDev = (over: Partial<EnvCardView> = {}): EnvCardView =>
  card({ env: 'dev', audience: { group: 'members', also: [] }, audienceLabel: 'All members (old format)', membersKey: true, readers: [], ...over })

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
    const masked = `${'•'.repeat(16)}hidden`
    expect(byTestId('env-value').map((v) => v.textContent)).toEqual([masked, masked])
    const show = host.querySelector<HTMLButtonElement>('button[aria-label="Show DB_URL"]')!
    act(() => show.click())
    expect(byTestId('env-value')[0]?.textContent).toBe(SECRET)
    expect(byTestId('env-value')[1]?.textContent).toBe(masked)
    expect(show.getAttribute('aria-pressed')).toBe('true')
    expect(setItem).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    act(() => show.click())
    expect(host.innerHTML).not.toContain(SECRET)
    expect(show.getAttribute('aria-pressed')).toBe('false')
  })

  it('shows one value at a time: showing another hides the first', () => {
    render(<EnvironmentsView view={page([card({})])} />)
    const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Show ${name}"]`)!
    act(() => button('DB_URL').click())
    act(() => button('STRIPE_KEY').click())
    expect(host.innerHTML).not.toContain(SECRET)
    expect(byTestId('env-value')[1]?.textContent).toBe('QAMARK-stripe')
    expect(button('DB_URL').getAttribute('aria-pressed')).toBe('false')
    expect(button('STRIPE_KEY').getAttribute('aria-pressed')).toBe('true')
  })

  describe('when the page is put away (Back cache, hidden tab)', () => {
    const showDbUrl = (): void => {
      render(<EnvironmentsView view={page([card({})])} />)
      act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Show DB_URL"]')!.click())
      expect(host.innerHTML).toContain(SECRET)
    }
    // No act() around the event: the value must be gone from the DOM by the time the listener
    // returns, before the browser snapshots the page.
    const outsideAct = (fire: () => void): void => {
      const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      env.IS_REACT_ACT_ENVIRONMENT = false
      try {
        fire()
      } finally {
        env.IS_REACT_ACT_ENVIRONMENT = true
      }
    }

    it('hides the shown value synchronously on pagehide', () => {
      showDbUrl()
      outsideAct(() => window.dispatchEvent(new Event('pagehide')))
      expect(host.innerHTML).not.toContain(SECRET)
    })

    it('hides the shown value synchronously when the tab is hidden', () => {
      showDbUrl()
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      outsideAct(() => document.dispatchEvent(new Event('visibilitychange')))
      expect(host.innerHTML).not.toContain(SECRET)
    })
  })

  it('says how many changes were ignored, and is not empty when that is all there is', () => {
    render(<EnvironmentsView view={page([], 0, { ignored: 2, empty: false })} />)
    expect(byTestId('env-ignored-count')[0]?.textContent).toBe("2 changes by people who aren't maintainers now were ignored.")
    expect(byTestId('env-empty')).toHaveLength(0)
  })

  it('names the audience, who it was last saved to, and who updated it when', () => {
    render(<EnvironmentsView view={page([card({})])} />)
    expect(byTestId('env-audience')[0]?.textContent).toBe('Maintainers')
    expect(byTestId('env-readers')[0]?.textContent).toBe('ALICECAROL(when last saved)')
    expect(byTestId('env-updated')[0]?.textContent).toBe('Updated by ALICE at 2026-10-05 08:41 UTC')
    expect(byTestId('env-old-format')).toHaveLength(0)
    expect(byTestId('env-stale')).toHaveLength(0)
    expect(text()).not.toContain('Readers, CI runners')
  })

  it('tells a group plus people, and Specific people, as dg does', () => {
    render(<EnvironmentsView view={page([card({ audienceLabel: 'Writers and maintainers + 1 more' }), card({ env: 'ci', audienceLabel: 'Specific people (3)' })])} />)
    expect(byTestId('env-audience').map((a) => a.textContent)).toEqual(['Writers and maintainers + 1 more', 'Specific people (3)'])
  })

  it('shows the old-format banner on an environment saved under the members key, with the step to take', () => {
    render(<EnvironmentsView view={page([oldDev({ oldFormat: { sentence: OLD_FORMAT_SENTENCE, unmarked: [], command: 'dg env resave --env dev' } })])} />)
    expect(byTestId('env-audience')[0]?.textContent).toBe('All members (old format)')
    expect(byTestId('env-readers')[0]?.textContent).toBe('Every member of this repo')
    expect(byTestId('env-old-format')[0]?.textContent).toBe(`${OLD_FORMAT_SENTENCE}dg env resave --env dev`)
    expect(byTestId('env-old-format')[0]?.querySelector('code')?.textContent).toBe('dg env resave --env dev')
    expect(byTestId('env-old-format-unmarked')).toHaveLength(0)
    expect(text()).not.toContain('Readers, CI runners')
  })

  it('shows the shorter note and the names not marked changed when only earlier versions are old', () => {
    const oldFormat = { sentence: OLD_FORMAT_HISTORY_SENTENCE, unmarked: ['API_TOKEN', 'LOG_LEVEL'], command: 'dg env mark-changed --env dev' }
    render(<EnvironmentsView view={page([card({ env: 'dev', audienceLabel: 'All members', oldFormat })])} />)
    expect(byTestId('env-old-format')[0]?.textContent).toBe(`${OLD_FORMAT_HISTORY_SENTENCE}Not marked yet: API_TOKEN, LOG_LEVEL` + 'dg env mark-changed --env dev')
    expect(byTestId('env-old-format-unmarked')[0]?.textContent).toBe('Not marked yet: API_TOKEN, LOG_LEVEL')
  })

  it("lists who an environment misses for a maintainer, with the step to save it again", () => {
    const stale: StaleItem[] = [
      { who: 'DANA', kind: 'missing', role: 'a writer' },
      { who: 'BOB', kind: 'extra', role: '' },
    ]
    render(<EnvironmentsView view={page([card({ env: 'staging', stale })], 0, { viewerMaintainer: true })} />)
    const lines = byTestId('env-stale-line').map((l) => l.textContent)
    expect(lines).toEqual(["DANA is a writer, but staging hasn't been saved since.", "bob isn't in its audience any more, but can read staging until it's saved again."])
    expect(byTestId('env-stale')[0]?.textContent).toContain('Save it again: dg env resave --env staging')
  })

  it('counts environments this viewer cannot read, never naming them', () => {
    render(<EnvironmentsView view={page([], 2)} />)
    expect(byTestId('env-hidden')[0]?.textContent).toBe('2 environments')
    expect(byTestId('env-card')).toHaveLength(0)
    expect(byTestId('env-not-shared')).toHaveLength(0)
    render(<EnvironmentsView view={page([oldDev()], 1)} />)
    expect(byTestId('env-hidden')[0]?.textContent).toBe("1 more environment you can't read")
  })

  it("tells a viewer who isn't a maintainer that an environment hasn't been shared with them", () => {
    render(<EnvironmentsView view={page([oldDev()], 1, { notShared: true })} />)
    expect(byTestId('env-not-shared')[0]?.textContent).toBe("An environment in this repo hasn't been shared with you. If you should have access, ask a maintainer to save it again.")
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
  it("lists what a removed member could read, to change where it's used", () => {
    const view: RemovalView = { exposures: [{ env: 'dev', names: ['API_TOKEN', 'API_URL'], oldFormat: true }], unreadable: 1 }
    render(<RemovalLines view={view} name="bob" />)
    const lines = [...byTestId('env-removal')[0]!.querySelectorAll('p')].map((p) => p.textContent)
    expect(lines).toEqual([
      "bob could read 2 dev values (and every past value saved in the old format). Change them where they're used: API_TOKEN, API_URL",
      "You can't read 1 environment here, so it isn't listed. bob may have been able to read values there.",
      "Removing someone can't take back what they could already read.",
    ])
  })

  it('asks for no change when they stay a maintainer (only another role goes)', () => {
    const view: RemovalView = { exposures: [{ env: 'dev', names: ['API_TOKEN'], oldFormat: true }], unreadable: 1 }
    render(<RemovalLines view={view} name="bob" staysMaintainer />)
    expect(byTestId('env-removal')).toHaveLength(0)
    expect(text()).not.toContain('Change them')
    expect(byTestId('env-removal-kept')[0]?.textContent).toBe("bob stays a maintainer, so they can still read this repo's environments. Nothing needs changing.")
  })

  it('says nothing when there is nothing to change', () => {
    render(<RemovalLines view={{ exposures: [], unreadable: 0 }} name="bob" staysMaintainer />)
    expect(host.innerHTML).toBe('')
    render(<RemovalLines view={{ exposures: [], unreadable: 0 }} name="bob" />)
    expect(host.innerHTML).toBe('')
  })
})
