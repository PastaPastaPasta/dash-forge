// @vitest-environment jsdom
/**
 * A request to a bot in a thread's timeline (DESIGN §10 "Thread line"): "@alice asked @ci-bot to
 * work on this", placed by time, with the task below it only when this reader can read it (a
 * members-only task stays hidden from outsiders, who see the line only).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentRequest } from '@/lib/rules/agent-request'
import type { TimelineItem } from '@/lib/view'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: () => undefined }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span data-testid="author">{identityId.startsWith('Aaaa') ? '@alice' : '@ci-bot'}</span> }))

const ALICE = 'AaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaa'
const BOT = 'BbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbb'

const { AgentRequestRow, Timeline } = await import('./timeline')

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

const request = (task: string | null, createdAt = 2): AgentRequest => ({ id: `e${createdAt}`, targetId: 'T', number: 42, bot: BOT, task, asker: ALICE, createdAt })

describe('a request to a bot in the timeline', () => {
  it('reads "@alice asked @ci-bot to work on this", with the task for a reader who can read it', () => {
    act(() => root.render(<AgentRequestRow request={request('fix the failing test')} />))
    const row = host.querySelector('[data-kind="agent-request"]')
    expect(row?.querySelector('p')?.textContent).toMatch(/^@alice asked @ci-bot to work on this · /)
    expect(host.querySelector('[data-testid="agent-request-task"]')?.textContent).toBe('fix the failing test')
  })

  it("flags a request that was outside the bot's access when it was written", () => {
    act(() => root.render(<AgentRequestRow request={request('fix it')} outside />))
    expect(host.querySelector('[data-testid="agent-request-outside"]')?.textContent).toMatch(/· outside .+'s access$/)
    act(() => root.render(<AgentRequestRow request={request('fix it')} />))
    expect(host.querySelector('[data-testid="agent-request-outside"]')).toBeNull()
  })

  it('shows the line only when the task is members-only and this reader cannot read it', () => {
    act(() => root.render(<AgentRequestRow request={request(null)} />))
    expect(host.textContent).toMatch(/^@alice asked @ci-bot to work on this · /)
    expect(host.querySelector('[data-testid="agent-request-task"]')).toBeNull()
  })

  it('is placed by time among the thread items', () => {
    const at = (n: number): TimelineItem => ({
      kind: 'comment',
      at: n,
      comment: { id: `c${n}`, author: ALICE, body: `comment ${n}`, createdAt: n, replyTo: null, anchor: null, reviewId: null, imported: false } as never,
    })
    act(() => root.render(<Timeline items={[at(1), at(3)]} agentRequests={[request('do it', 2)]} />))
    const rows = [...host.querySelectorAll('[data-kind="agent-request"], [data-testid="timeline-comment"]')]
    const kinds = rows.map((r) => (r.getAttribute('data-kind') === 'agent-request' ? 'ask' : r.textContent?.includes('comment 1') ? 'c1' : r.textContent?.includes('comment 3') ? 'c3' : '?'))
    expect(kinds).toEqual(['c1', 'ask', 'c3'])
  })
})
