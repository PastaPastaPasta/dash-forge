// @vitest-environment jsdom
/**
 * Settings → Bots and runners (DESIGN §10 "Bots and runners"): the empty state, each bot's public
 * line as everyone reads it, runners as "CI runner", a maintainer's Change and Remove access, and
 * the notice a saved Access form writes (what a later version gave is kept; it replaces the old).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '@/lib/auth/base58'
import type { AccessNotice, NoticeEntry } from '@/lib/private'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: (id: string) => (id.startsWith('Bot') ? undefined : 'ci-bot.dash') }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span data-testid="author">{identityId}</span> }))
vi.mock('@/components/repo/private-repo-state', () => ({ PrivateRepoState: () => <p>private</p> }))

const { BOTS_EMPTY_TEXT, BotsView, draftOf, handleOf, noticeOfDraft, removeWords, untilOfDay } = await import('./bots-content')

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

const render = (el: JSX.Element): void => act(() => root.render(el))
const byTestId = (id: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)]

const BOT = new Uint8Array(32).fill(7)
// the last millisecond of 30 Nov, as the form writes it
const UNTIL = Date.UTC(2026, 10, 30) + 86_400_000 - 1
const notice = (over: Partial<AccessNotice> = {}): AccessNotice => ({
  bot: BOT,
  may: ['post', 'readOnRequest'],
  askers: 'writers',
  threads: 'all',
  processor: 'Example AI',
  until: UNTIL,
  revokes: [],
  note: '',
  extra: {},
  ...over,
})
const entry = (n: AccessNotice = notice()): NoticeEntry => ({ id: 'M1', writer: 'MAINTAINER', createdAt: 1, packHash: 'ab'.repeat(32), notice: n })

describe('BotsView', () => {
  it('says what bots are when there are none', () => {
    render(<BotsView current={[]} runners={[]} now={0} />)
    expect(byTestId('bots-empty')[0]?.textContent).toBe(BOTS_EMPTY_TEXT)
    expect(BOTS_EMPTY_TEXT).toBe(
      'No bots yet. A bot can report checks, post comments and work on pull requests you ask it to. It only reads members-only content when someone asks it to work on that thread.',
    )
  })

  it("shows each bot's public line as everyone reads it", () => {
    render(<BotsView current={[entry()]} runners={[]} now={0} />)
    expect(byTestId('bot-public-line')[0]?.textContent).toBe(
      "@ci-bot can post here and read pull requests and issues it's asked about. Asked by writers and maintainers. Processed by Example AI. Until 30 Nov 2026.",
    )
    // anyone else reads it: no change controls
    expect(byTestId('bot-edit')).toHaveLength(0)
    expect(byTestId('bot-remove')).toHaveLength(0)
  })

  it('lists the runners as CI runners', () => {
    render(<BotsView current={[]} runners={['RUNNER1']} now={0} />)
    expect(byTestId('runner-row')[0]?.textContent).toContain('RUNNER1')
    expect(byTestId('runner-row')[0]?.textContent).toContain('CI runner')
    expect(byTestId('bots-empty')).toHaveLength(0)
  })

  it('gives a maintainer Change access and Remove access', () => {
    const edit = vi.fn()
    const remove = vi.fn()
    render(<BotsView current={[entry()]} runners={[]} now={0} onEdit={edit} onRemove={remove} />)
    act(() => byTestId('bot-remove')[0]?.click())
    expect(remove).toHaveBeenCalledTimes(1)
    act(() => byTestId('bot-edit')[0]?.click())
    expect(edit).toHaveBeenCalledTimes(1)
  })

  it('offers no Remove access for a bot that has none left', () => {
    render(<BotsView current={[entry(notice({ may: [] }))]} runners={[]} now={0} onEdit={() => undefined} onRemove={() => undefined} />)
    expect(byTestId('bot-public-line')[0]?.textContent).toBe('@ci-bot has no access here.')
    expect(byTestId('bot-remove')).toHaveLength(0)
    expect(byTestId('bot-edit')[0]?.textContent).toBe('Give access again')
  })
})

describe('the Access form', () => {
  const bot = base58Encode(BOT)

  it('starts from the current access, or from posting only', () => {
    expect(draftOf(null)).toEqual({ may: new Set(['post']), askers: 'writers', processor: '', until: '' })
    const d = draftOf(notice())
    expect([...d.may]).toEqual(['post', 'readOnRequest'])
    expect(d.until).toBe('2026-11-30')
    expect(untilOfDay(d.until)).toBe(UNTIL)
    // a notice `dg` wrote ends at the next midnight: the form shows the same day
    expect(draftOf(notice({ until: UNTIL + 1 })).until).toBe('2026-11-30')
  })

  it('saves a notice that replaces the old one and keeps what a later version gave', () => {
    const previous = entry(notice({ may: ['post', 'push'], extra: { push: [] } }))
    const got = noticeOfDraft(bot, { may: new Set(['post', 'readOnRequest']), askers: 'maintainers', processor: ' Example AI ', until: '' }, previous, 0)
    if ('error' in got) throw new Error(got.error)
    expect(got.may).toEqual(['post', 'push', 'readOnRequest'])
    expect(got.askers).toBe('maintainers')
    expect(got.processor).toBe('Example AI')
    expect(got.until).toBeNull()
    expect(got.extra).toEqual({ push: [] })
    expect(got.revokes.map((h) => [...h].every((b) => b === 0xab))).toEqual([true])
  })

  it('refuses a form that gives nothing, or ends in the past', () => {
    expect(noticeOfDraft(bot, { may: new Set(), askers: 'writers', processor: '', until: '' }, null, 0)).toHaveProperty('error')
    expect(noticeOfDraft(bot, { may: new Set(['post']), askers: 'writers', processor: '', until: '2020-01-01' }, null, Date.UTC(2026, 0, 1))).toEqual({ error: 'That date has passed.' })
  })

  it('names the bot by its handle, and asks before taking access away', () => {
    expect(handleOf('X', 'ci-bot.dash')).toBe('@ci-bot')
    expect(handleOf('BotBotBotBotBotBot', null)).toBe('BotBotB…otBot')
    expect(removeWords('@ci-bot')).toBe("Stop @ci-bot's access? It gets nothing new from now on. What it was already given stays with it.")
  })
})
