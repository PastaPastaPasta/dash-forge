// @vitest-environment jsdom
/** The publication-date panel on a members-only issue or PR (DESIGN §4.7 "Embargo"). */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'alice', signer: { identityId: 'alice' } }) }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>@{identityId}</span> }))
const writes: unknown[] = []
vi.mock('@/lib/repo/review-writes', () => ({ setEmbargo: async (_sdk: unknown, _auth: unknown, _repo: unknown, input: unknown) => void writes.push(input) }))
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: ({ open, title, blocked, children, onConfirm }: { open: boolean; title: string; blocked?: React.ReactNode; children?: React.ReactNode; onConfirm: (i: string) => Promise<void> }) =>
    open ? (
      <div data-testid="confirm" data-blocked={blocked ? String(blocked) : ''}>
        <h2>{title}</h2>
        {children}
        <button type="button" data-testid="confirm-go" onClick={() => void onConfirm('intent').catch(() => undefined)}>
          go
        </button>
      </div>
    ) : null,
}))

import { EmbargoPanel, draftValue, embargoShows, untilText, utcInputSeconds, whenText } from './embargo-panel'
import type { Embargo } from '@/lib/rules/embargo'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R', ownerId: 'alice', name: 'demo', visibility: 'public' } as const
const AT = 1_792_504_800 // 2026-10-20 14:00 UTC
const FAR = 4_102_444_800 // 2100-01-01: always in the future
const embargo = (state: Embargo['state'], at = FAR): Embargo => ({
  targetId: 'T',
  number: 12,
  plan: { at, branch: 'sec/cve-77', onto: 'main', tag: 'v1.2.3' },
  setBy: 'alice',
  setAt: 1,
  id: 'E',
  state,
})

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  writes.length = 0
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

function show(props: Partial<React.ComponentProps<typeof EmbargoPanel>>): void {
  act(() =>
    root.render(
      <EmbargoPanel
        repo={repo}
        target={{ id: 'T', number: 12 }}
        embargo={null}
        isIssue
        membersOnly
        facts={{}}
        canSet
        open
        defaultBranch="main"
        onDone={() => undefined}
        {...props}
      />,
    ),
  )
}

const text = (id: string): string => el.querySelector(`[data-testid="${id}"]`)?.textContent ?? ''

describe('EmbargoPanel', () => {
  it('shows the date, the checklist and who set it to members', () => {
    show({ embargo: embargo({ state: 'scheduled' }), facts: { issuePublic: true } })
    expect(text('embargo-state')).toContain('Publishes on')
    expect(text('embargo-state')).toContain('2100')
    const items = [...el.querySelectorAll('[data-testid="embargo-checklist"] li')].map((li) => li.textContent)
    expect(items).toEqual([
      'Done: Make #12 public',
      'To do: Publish sec/cve-77 onto main, squashed into one commit',
      'To do: Tag v1.2.3',
      'To do: Release v1.2.3',
    ].map((t) => `${t.startsWith('Done') ? '✓' : '○'}${t}`))
    expect(el.textContent).toContain('Only members can see this date.')
    expect(el.textContent).toContain('dg embargo run --wait')
    expect(text('embargo-set')).toBe('Change date')
    expect(text('embargo-withdraw')).toBe('Withdraw')
  })

  it('says when a date is due, published or withdrawn', () => {
    show({ embargo: embargo({ state: 'scheduled' }, 1_700_000_000) })
    expect(text('embargo-state')).toContain('Due since')
    show({ embargo: embargo({ state: 'done', commit: 'ab'.repeat(20), by: 'bot', at: 2 }) })
    expect(text('embargo-state')).toContain('Published as abababa')
    expect([...el.querySelectorAll('[data-testid="embargo-checklist"] li')].every((li) => li.textContent?.startsWith('✓'))).toBe(true)
    expect(el.querySelector('[data-testid="embargo-set"]')).toBeNull()
    show({ embargo: embargo({ state: 'cancelled', by: 'bob', at: 2 }) })
    expect(text('embargo-state')).toContain('@bob withdrew the one for')
    expect(text('embargo-set')).toBe('Set a date…')
  })

  it('shows nothing to someone who can neither read a date nor set one', () => {
    show({ canSet: false })
    expect(el.querySelector('[data-testid="embargo-panel"]')).toBeNull()
    show({ membersOnly: false })
    expect(el.querySelector('[data-testid="embargo-panel"]')).toBeNull()
    show({ open: false })
    expect(el.querySelector('[data-testid="embargo-panel"]'), 'no new date on a closed thread').toBeNull()
    show({ embargo: undefined })
    expect(el.querySelector('[data-testid="embargo-panel"]'), 'members unknown').toBeNull()
  })

  it('keeps a waiting date withdrawable once the thread is public, and offers no new one', () => {
    show({ embargo: embargo({ state: 'scheduled' }), membersOnly: false })
    expect(el.querySelector('[data-testid="embargo-set"]')).toBeNull()
    expect(text('embargo-withdraw')).toBe('Withdraw')
  })

  it('sets a date from the form, in UTC', async () => {
    show({})
    act(() => (el.querySelector('[data-testid="embargo-set"]') as HTMLButtonElement).click())
    expect(text('confirm')).toContain('Set a publication date?')
    expect((el.querySelector('[data-testid="embargo-onto"]') as HTMLInputElement).value).toBe('main')
    await act(async () => (el.querySelector('[data-testid="confirm-go"]') as HTMLButtonElement).click())
    expect(writes, 'an incomplete form writes nothing').toEqual([])
  })

  it('withdraws a waiting date', async () => {
    show({ embargo: embargo({ state: 'scheduled' }) })
    act(() => (el.querySelector('[data-testid="embargo-withdraw"]') as HTMLButtonElement).click())
    expect(text('confirm')).toContain('Withdraw the publication date?')
    await act(async () => (el.querySelector('[data-testid="confirm-go"]') as HTMLButtonElement).click())
    expect(writes).toEqual([{ target: { id: 'T', number: 12 }, value: { type: 'cancel' }, intent: 'intent' }])
  })
})

describe('the form', () => {
  it('reads its time as UTC and checks the plan before signing', () => {
    expect(utcInputSeconds('2026-10-20T14:00')).toBe(AT)
    expect(utcInputSeconds('')).toBeNull()
    expect(utcInputSeconds('2026-02-30T14:00'), 'an impossible date').toBeNull()
    const d = { at: '2026-10-20T14:00', branch: 'sec/x', onto: 'main', tag: '', message: '' }
    expect(draftValue(d, null, AT - 60)).toEqual({ value: { type: 'schedule', at: AT, branch: 'sec/x', onto: 'main' } })
    expect(draftValue(d, 7, AT - 60)).toEqual({ value: { type: 'schedule', at: AT, pr: 7 } })
    expect(draftValue(d, null, AT)).toEqual({ problem: 'Choose a time in the future.' })
    expect(draftValue({ ...d, branch: '' }, null, 0)).toHaveProperty('problem')
    expect(draftValue({ ...d, tag: 'v 1' }, null, 0)).toEqual({ problem: '"v 1" is not a tag name.' })
    expect(draftValue({ ...d, message: 'x'.repeat(90) }, null, 0)).toHaveProperty('problem')
  })

  it('knows when a re-read shows the write', () => {
    const e = embargo({ state: 'scheduled' })
    expect(embargoShows(e, { type: 'schedule', at: FAR, pr: 1 })).toBe(true)
    expect(embargoShows(e, { type: 'schedule', at: AT, pr: 1 })).toBe(false)
    expect(embargoShows(e, { type: 'cancel' })).toBe(false)
    expect(embargoShows(embargo({ state: 'cancelled', by: 'b', at: 1 }), { type: 'cancel' })).toBe(true)
    expect(embargoShows(null, { type: 'cancel' })).toBe(false)
  })

  it('prints times in UTC', () => {
    expect(whenText(AT)).toBe('Tue, 20 Oct 2026, 14:00 UTC')
    expect(untilText(AT, AT - 3 * 86_400)).toBe('in 3 days')
    expect(untilText(AT, AT + 7200)).toBe('2 hours ago')
  })
})
