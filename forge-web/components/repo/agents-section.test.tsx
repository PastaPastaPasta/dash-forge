// @vitest-environment jsdom
/**
 * The Ask dialog (DESIGN §10 "Ask", §4.9): the bot's access is checked against the viewer's role
 * before anything is signed, and a refusal shows the E813 copy with Ask disabled and nothing
 * written; an allowed request says what the bot will get and who processes it, and writes only
 * once a task is given.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AccessNotice } from '@/lib/private'
import type { AskPlan } from '@/lib/repo/bot-access'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: () => undefined }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span data-testid="author">{identityId}</span> }))
// The dialog's frame: its question, what it holds, why it can't run yet, and Confirm (disabled while blocked).
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: ({
    title,
    children,
    blocked,
    confirmLabel,
    cost,
    onConfirm,
  }: {
    title: string
    children?: React.ReactNode
    blocked?: React.ReactNode
    confirmLabel: string
    cost: unknown
    onConfirm: (intent: string) => Promise<void>
  }) => (
    <div>
      <h1 data-testid="dialog-title">{title}</h1>
      {children}
      {blocked ?? null}
      <button type="button" data-testid="confirm" disabled={(blocked !== undefined && blocked !== null) || cost === 'pending'} onClick={() => void onConfirm('intent-1')}>
        {confirmLabel}
      </button>
    </div>
  ),
}))

const { AskDialog, agentsOf } = await import('./agents-section')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
})

const byTestId = (id: string): HTMLElement | null => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const notice = (over: Partial<AccessNotice> = {}): AccessNotice => ({
  bot: new Uint8Array(32).fill(7),
  may: ['post', 'readOnRequest'],
  askers: 'writers',
  threads: 'all',
  processor: 'Example AI',
  until: null,
  revokes: [],
  note: '',
  extra: {},
  ...over,
})
const target = { kind: 'pr' as const, id: 'PR42', number: 42 }
const plan: AskPlan = { target, bot: 'BOT', membersOnly: true, processor: 'Example AI', reads: true, foreign: false, letter: true, shared: { thread: 1, comments: 37 }, shortened: 0, leftOut: [] }

function dialog(over: { notice?: AccessNotice; role?: 'maintainer' | 'writer' | 'triage' | 'reader' | null; membersOnly?: boolean; planned?: () => Promise<AskPlan>; ask?: () => Promise<void> } = {}) {
  const planFn = vi.fn(over.planned ?? (async () => plan))
  const askFn = vi.fn(over.ask ?? (async () => undefined))
  act(() =>
    root.render(
      <AskDialog
        bot="BOT"
        name="@ci-bot"
        display="o/r"
        target={target}
        notice={over.notice ?? notice()}
        role={over.role === undefined ? 'writer' : over.role}
        membersOnly={over.membersOnly ?? true}
        codeNote={false}
        now={1000}
        plan={planFn}
        ask={askFn}
        onClose={() => undefined}
      />,
    ),
  )
  return { planFn, askFn }
}

function typeTask(text: string): void {
  const el = byTestId('ask-task') as HTMLTextAreaElement
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    set?.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the Ask dialog', () => {
  it('shows E813 for a Triage member and signs nothing', async () => {
    const { planFn, askFn } = dialog({ role: 'triage' })
    await flush()
    const refused = byTestId('ask-refused')
    expect(refused?.textContent).toContain("@ci-bot can't be asked by people with Triage access in o/r.")
    expect(refused?.textContent).toContain("Ask a maintainer to change @ci-bot's access, or ask someone with Write access.")
    expect((byTestId('confirm') as HTMLButtonElement).disabled).toBe(true)
    act(() => byTestId('confirm')?.click())
    expect(planFn).not.toHaveBeenCalled()
    expect(askFn).not.toHaveBeenCalled()
  })

  it('refuses a members-only thread when the bot may not read on request', async () => {
    const { askFn } = dialog({ notice: notice({ may: ['post'] }) })
    await flush()
    expect(byTestId('ask-refused')?.textContent).toContain("@ci-bot can't read members-only threads in o/r.")
    expect(askFn).not.toHaveBeenCalled()
  })

  it('shows a refusal the fresh read finds too, before anything is signed', async () => {
    const { AskRefusedError } = await import('@/lib/repo/bot-access')
    const { askFn } = dialog({
      planned: async () => {
        throw new AskRefusedError({ why: 'noAccess' }, { message: '@ci-bot has no access in o/r', fix: 'ask a maintainer to give @ci-bot access (Settings → Bots and runners)' })
      },
    })
    await flush()
    expect(byTestId('ask-refused')?.textContent).toContain('@ci-bot has no access in o/r.')
    expect(askFn).not.toHaveBeenCalled()
  })

  it('says what the bot will get, and asks once a task is given', async () => {
    const { askFn } = dialog()
    await flush()
    expect(byTestId('dialog-title')?.textContent).toBe('Ask @ci-bot to work on #42?')
    expect(byTestId('ask-summary')?.textContent).toBe(
      "It will get this pull request's members-only comments as they are now (37 comments).Example AI processes them.It can't see anything added later unless you ask again.Everyone can see that you asked; only members can see what you asked.",
    )
    expect((byTestId('confirm') as HTMLButtonElement).disabled).toBe(true)
    typeTask('fix the failing test')
    expect((byTestId('confirm') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => {
      byTestId('confirm')?.click()
    })
    expect(askFn).toHaveBeenCalledWith(expect.objectContaining({ bot: 'BOT', task: 'fix the failing test', target }), 'intent-1')
  })

  it('drops the members-only clause when there is nothing members-only to hand on', async () => {
    dialog({ membersOnly: false, planned: async () => ({ ...plan, membersOnly: false, letter: false, shared: { thread: 0, comments: 0 } }) })
    await flush()
    expect(byTestId('ask-summary')?.textContent).toBe('It will work on this pull request as everyone can read it.Example AI processes it.Everyone can see that you asked and what you asked.')
  })
})

describe('the Ask dialog on a fork or an outsider’s pull request', () => {
  it('says the bot gets only what everyone can read', async () => {
    dialog({ membersOnly: false, planned: async () => ({ ...plan, membersOnly: false, foreign: true, letter: false, shared: { thread: 0, comments: 0 } }) })
    await flush()
    expect(byTestId('ask-summary')?.textContent).toBe(
      '#42 comes from a fork or from someone outside the members: @ci-bot gets only what everyone can read.Example AI processes it.Everyone can see that you asked and what you asked.',
    )
  })

  it('shows the refusal of a members-only one, before anything is signed', async () => {
    const { BotAccessError } = await import('@/lib/repo/bot-access')
    const { askFn } = dialog({
      planned: async () => {
        throw new BotAccessError("#42 comes from a fork or from someone outside the members: its members-only content can't be shared with @ci-bot. Nothing was signed.")
      },
    })
    await flush()
    expect(byTestId('ask-plan-error')?.textContent).toContain('#42 comes from a fork or from someone outside the members')
    expect((byTestId('confirm') as HTMLButtonElement).disabled).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('tells how many long posts go shortened', async () => {
    dialog({ planned: async () => ({ ...plan, shortened: 2 }) })
    await flush()
    expect(byTestId('ask-summary')?.textContent).toContain('2 long posts are sent shortened.')
  })
})

describe('agentsOf', () => {
  const entry = (n: AccessNotice) => ({ id: 'M', writer: 'W', createdAt: 1, packHash: '00'.repeat(32), notice: n })
  const notices = (n: AccessNotice) => ({ all: [], current: new Map([['BOT', entry(n)]]), unreadable: 0 })

  it('lists a bot whose access is live and covers the thread', () => {
    expect(agentsOf(notices(notice()), 42, 0)).toHaveLength(1)
    expect(agentsOf(notices(notice({ threads: [7] })), 42, 0)).toHaveLength(0)
    expect(agentsOf(notices(notice({ until: 10 })), 42, 10)).toHaveLength(0)
    expect(agentsOf(notices(notice({ may: [] })), 42, 0)).toHaveLength(0)
    expect(agentsOf(null, 42, 0)).toHaveLength(0)
  })
})
