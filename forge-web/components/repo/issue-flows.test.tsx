// @vitest-environment jsdom
/**
 * QA wave 2, issue flows: the label and assignee pickers batch their ticks behind one confirm and
 * close on Escape or an outside click (QW2-046); timeline state icons are circles, a padlock only
 * for a lock (QW2-045); the timeline names the PR a close came from and the PRs that mention the
 * issue (QW2-048); the dismiss form follows the review, not the reviewer (QW2-047); fenced code
 * with a language is highlighted (QW2-058).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TimelineItem } from '@/lib/view'
import type { ReviewerCardRow } from '@/lib/view/review-fold'
import { ISSUE_CLOSE, ISSUE_LOCK, ISSUE_REOPEN, ISSUE_UNLOCK, PR_CLOSE, PR_REOPEN } from '@/lib/rules/transition'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: () => undefined }))

const { AssigneePicker, LabelPicker, setChange, labelsConfirm, stateToggleLabel } = await import('./target-rail')
const { Timeline, transitionIcon } = await import('./timeline')
const { ReviewersCard } = await import('./reviewers-card')
const { MarkdownView } = await import('@/components/markdown-view')

const A = 'AaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaa'
const B = 'BbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbb'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (el: JSX.Element): void => act(() => root.render(el))
const byText = (text: string | RegExp): HTMLElement | undefined =>
  [...host.querySelectorAll<HTMLElement>('button, a')].find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')))
const click = (el: Element | undefined): void => {
  if (el === undefined) throw new Error('no such element')
  act(() => (el as HTMLElement).click())
}
const key = (k: string): void => act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))

describe('setChange', () => {
  it('is what the ticks add and remove, or null for none', () => {
    expect(setChange(['bug'], new Map([['bug', true]]))).toBeNull()
    expect(setChange(['bug', 'docs'], new Map([['triage', true], ['bug', false]]))).toEqual({ add: ['triage'], remove: ['bug'] })
    // A value that shows up (a re-read) without a tick is no change.
    expect(setChange(['bug', 'new'], new Map([['triage', true]]))).toEqual({ add: ['triage'], remove: [] })
  })

  it('confirms several labels as one signing', () => {
    expect(labelsConfirm({ add: ['a', 'b'], remove: ['c'] })).toMatchObject({ title: 'Change 3 labels', label: 'Sign 3 changes' })
    expect(labelsConfirm({ add: ['a'], remove: [] })).toMatchObject({ title: 'Add label "a"', label: 'Sign & label' })
  })
})

describe('label picker (QW2-046)', () => {
  const defs = ['bug', 'docs', 'triage'].map((name, i) => ({ name, color: '#d73a4a', description: '', retired: false, createdAt: i, id: name }))
  const picker = (onApply: (c: unknown) => void): JSX.Element => (
    <LabelPicker applied={['bug']} defs={defs} byName={new Map(defs.map((d) => [d.name, d]))} canEdit onApply={onApply} onDefine={() => undefined} />
  )
  const option = (name: string): HTMLElement | undefined => [...host.querySelectorAll<HTMLElement>('[data-testid="label-option"]')].find((b) => b.textContent?.includes(name))

  it('collects the ticks and applies them together when Escape closes it', () => {
    const onApply = vi.fn()
    render(picker(onApply))
    click(byText('Edit labels'))
    click(option('docs'))
    click(option('triage'))
    click(option('bug'))
    expect(onApply).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="picker-footer"]')?.textContent).toContain('3 changes')
    key('Escape')
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith({ add: ['docs', 'triage'], remove: ['bug'] })
    expect(option('docs')).toBeUndefined()
  })

  it('applies on a click outside it, and closes without a write when nothing changed', () => {
    const onApply = vi.fn()
    render(picker(onApply))
    click(byText('Edit labels'))
    act(() => void document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(onApply).not.toHaveBeenCalled()
    expect(option('docs')).toBeUndefined()
    click(byText('Edit labels'))
    click(option('docs'))
    act(() => void document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(onApply).toHaveBeenCalledWith({ add: ['docs'], remove: [] })
  })

  it('never removes a label that a re-read brought in while the picker was open', () => {
    const onApply = vi.fn()
    render(picker(onApply))
    click(byText('Edit labels'))
    click(option('triage'))
    render(<LabelPicker applied={['bug', 'docs']} defs={defs} byName={new Map(defs.map((d) => [d.name, d]))} canEdit onApply={onApply} onDefine={() => undefined} />)
    expect(option('docs')?.getAttribute('aria-pressed')).toBe('true')
    key('Escape')
    expect(onApply).toHaveBeenCalledWith({ add: ['triage'], remove: [] })
  })

  it('Cancel drops the draft', () => {
    const onApply = vi.fn()
    render(picker(onApply))
    click(byText('Edit labels'))
    click(option('docs'))
    click(byText('Cancel'))
    expect(onApply).not.toHaveBeenCalled()
    expect(option('docs')).toBeUndefined()
  })
})

describe('assignee picker (QW2-046)', () => {
  it('assigns and unassigns together behind Apply', () => {
    const onApply = vi.fn()
    render(<AssigneePicker assignees={[A]} members={[A, B]} canEdit onApply={onApply} />)
    click(byText('Edit assignees'))
    for (const b of host.querySelectorAll<HTMLElement>('[data-testid="assignee-option"]')) click(b)
    click(byText('Apply'))
    expect(onApply).toHaveBeenCalledWith({ add: [B], remove: [A] })
  })
})

describe('timeline (QW2-045, QW2-048)', () => {
  const at = 1_700_000_000_000
  const transition = (id: string, kind: number, when: number): TimelineItem => ({
    kind: 'transition',
    at: when,
    transition: { id, targetId: 't', kind, actor: A, asAuthor: 0, createdAt: when } as never,
  })

  it('draws state changes with circles and pull-request glyphs, and a padlock only for a lock', () => {
    const icon = (kind: number): string | null => {
      render(transitionIcon(kind))
      return host.querySelector('svg')?.getAttribute('data-icon') ?? null
    }
    expect(icon(ISSUE_CLOSE)).toBe('closed')
    expect(icon(ISSUE_REOPEN)).toBe('reopened')
    expect(icon(PR_CLOSE)).toBe('closed')
    expect(icon(PR_REOPEN)).toBe('reopened')
    expect(icon(ISSUE_LOCK)).toBe('locked')
    expect(icon(ISSUE_UNLOCK)).toBe('unlocked')
    render(transitionIcon(ISSUE_CLOSE))
    expect(host.querySelector('svg')?.getAttribute('class')).not.toMatch(/lock/)
  })

  it('names the PR a close came from, and places mentions in time order', () => {
    const items = [transition('t1', ISSUE_REOPEN, at), transition('t2', ISSUE_CLOSE, at + 20_000)]
    render(
      <Timeline
        items={items}
        closedIn={(t) => (t.id === 't2' ? { number: 3, title: 'Fix it', href: '/pull/3' } : null)}
        crossRefs={[{ id: 'p4', actor: B, at: at + 10_000, number: 4, title: 'Related', href: '/pull/4', state: 'merged' }]}
      />,
    )
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="timeline-event"]')]
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual([`transition-${ISSUE_REOPEN}`, 'cross-reference', `transition-${ISSUE_CLOSE}`])
    expect(rows[1]?.textContent).toContain('mentioned this issue in #4 Related')
    expect(rows[2]?.textContent).toContain('closed this as completed in #3 Fix it')
    expect(rows[2]?.querySelector('a')?.getAttribute('href')).toBe('/pull/3')
  })
})

describe('Close with comment (QW2-008)', () => {
  it('says so while the composer holds text', () => {
    expect(stateToggleLabel(true, false, 'issue')).toBe('Close issue')
    expect(stateToggleLabel(true, true, 'issue')).toBe('Close with comment')
    expect(stateToggleLabel(false, true, 'pull request')).toBe('Reopen with comment')
    expect(stateToggleLabel(false, false, 'pull request')).toBe('Reopen pull request')
  })
})

describe('dismiss review (QW2-047)', () => {
  const row = (dismissId: string, state: ReviewerCardRow['state']): ReviewerCardRow => ({
    identity: B,
    state,
    requested: false,
    requestedAt: null,
    reRequested: false,
    reviewId: dismissId,
    dismissId,
    reviewedOid: 'a'.repeat(40),
    dismissReason: null,
  })
  const card = (r: ReviewerCardRow): JSX.Element => (
    <ReviewersCard rows={[r]} members={[]} author={A} headOid={'a'.repeat(40)} membersKnown canRequest={false} canDismiss onRequest={() => undefined} onDismiss={() => undefined} />
  )

  it('closes once the review it was aimed at is dismissed, not following the verdict that resurfaces', () => {
    render(card(row('r2', 'approved')))
    click(byText('Dismiss review'))
    expect(host.querySelector('input[aria-label="Reason for dismissing"]')).not.toBeNull()
    // Dismissed: the reviewer's older request for changes counts again, as another review.
    render(card(row('r1', 'changesRequested')))
    expect(host.querySelector('input[aria-label="Reason for dismissing"]')).toBeNull()
    expect(byText('Dismiss review')).toBeDefined()
  })
})

describe('fenced code (QW2-058)', () => {
  it('highlights a block whose fence names a language, and leaves one without it plain', async () => {
    render(<MarkdownView source={'```python\ndef f():\n    return 1\n```\n\n```\nplain\n```'} />)
    await vi.waitFor(() => expect(host.querySelector('code[data-highlighted="true"]')).not.toBeNull())
    const code = host.querySelector('code[data-highlighted="true"]') as HTMLElement
    expect(code.querySelector('.hljs-keyword')?.textContent).toBe('def')
    expect(code.textContent).toBe('def f():\n    return 1')
    expect(host.querySelectorAll('code[data-highlighted="true"]').length).toBe(1)
  })
})
