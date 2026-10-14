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
const { requestsOf } = await import('./bot-push')
const { DEFAULT_PUSH_POLICY, setPush } = await import('@/lib/private')

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

describe('push access (phase 4E)', () => {
  const DAY = 86_400_000
  const NOW = Date.UTC(2026, 9, 14)
  const bot = base58Encode(BOT)
  const ME = base58Encode(new Uint8Array(32).fill(1))
  const GONE = base58Encode(new Uint8Array(32).fill(5))
  const gid = (n: number): string => base58Encode(new Uint8Array(32).fill(100 + n))
  const members = [
    { identity: ME, role: 'maintainer' as const, createdAt: 1 },
    { identity: bot, role: 'bot' as const, createdAt: 1000 },
  ]
  const live = { id: gid(1), granter: ME, bot, prefix: 'refs/heads/bot/ci-bot/', until: NOW + 9 * DAY - 1, createdAt: 2000 }
  const gone = { id: gid(2), granter: GONE, bot, prefix: 'refs/heads/docs/', until: NOW + 30 * DAY, createdAt: 2000 }
  const listed = setPush(notice(), [{ grant: new Uint8Array(32).fill(101), target: { prefix: 'refs/heads/bot/ci-bot/' } }], DEFAULT_PUSH_POLICY)
  const state = (grants: (typeof live)[]) => ({ supported: true, grants, members, now: NOW })

  it('says where a bot may push and what needs attention, in the design\'s words', () => {
    render(<BotsView current={[entry(listed)]} runners={[]} now={NOW} push={state([live, gone])} />)
    expect(byTestId('bot-push-line')[0]?.textContent).toBe('Can push to bot/ci-bot/ until 22 Oct 2026.')
    expect(byTestId('bot-push-note').map((n) => n.textContent)).toEqual([
      "@ci-bot's push access to bot/ci-bot/ ends in 9 days.",
      '@ci-bot can no longer push to docs/: @ci-bot is no longer a maintainer.',
    ])
    // anyone else reads it: no changes
    expect(byTestId('bot-push-give')).toHaveLength(0)
  })

  it('gives a maintainer the changes, and Suspend names who gave the access', () => {
    const onPush = vi.fn()
    render(<BotsView current={[entry(listed)]} runners={[]} now={NOW} push={state([live])} me={ME} onPush={onPush} />)
    expect(byTestId('bot-push-give')).toHaveLength(1)
    expect(byTestId('bot-push-resume')).toHaveLength(0)
    expect(byTestId('bot-push-remove-mine')).toHaveLength(1)
    act(() => byTestId('bot-push-suspend')[0]?.click())
    expect(onPush).toHaveBeenCalledWith({ kind: 'suspend', bot, granters: [ME] })
    act(() => byTestId('bot-push-note-renew')[0]?.click())
    expect(onPush).toHaveBeenLastCalledWith({ kind: 'renew', bot })
  })

  it('says a suspension once and offers Resume', () => {
    const onPush = vi.fn()
    render(<BotsView current={[entry(setPush(listed, [], DEFAULT_PUSH_POLICY))]} runners={[]} now={NOW} push={state([live])} me={ME} onPush={onPush} />)
    expect(byTestId('bot-push-line')[0]?.textContent).toBe("@ci-bot's pushes are suspended.")
    expect(byTestId('bot-push-note').map((n) => n.dataset.kind)).toEqual(['renewDue'])
    expect(byTestId('bot-push-suspend')).toHaveLength(0)
    act(() => byTestId('bot-push-resume')[0]?.click())
    expect(onPush).toHaveBeenCalledWith({ kind: 'resume', bot })
  })

  it('lists a bot with push access and no access settings', () => {
    render(<BotsView current={[]} runners={[]} now={NOW} push={state([live])} />)
    expect(byTestId('bots-empty')).toHaveLength(0)
    expect(byTestId('bot-public-line')[0]?.textContent).toBe('@ci-bot has no access settings here.')
    expect(byTestId('bot-push-line')[0]?.textContent).toBe('Can push to bot/ci-bot/ until 22 Oct 2026.')
  })

  it("says bots can't push yet before the registration, with no controls", () => {
    render(<BotsView current={[entry()]} runners={[]} now={NOW} push={{ supported: false, grants: [], members: [], now: NOW }} me={ME} onPush={() => undefined} />)
    expect(byTestId('bots-push-not-yet')[0]?.textContent).toBe("Bots can't push to this repo yet. A bot can push to its own fork and open a pull request.")
    expect(byTestId('bot-push')).toHaveLength(0)
  })

  it('turns the dialog\'s branches into grants, and refuses what it cannot give', () => {
    const got = requestsOf(['bot/ci-bot/', 'gh-pages', 'bot/ci-bot/*'], [{ name: 'refs/heads/fix-auth', current: 'ab'.repeat(32), earlier: [], audienceNow: new Set([bot]) }])
    if ('error' in got) throw new Error(got.error)
    expect(got.requests.map((r) => r.label)).toEqual(['bot/ci-bot/', 'gh-pages', 'fix-auth'])
    expect(requestsOf(['refs/tags/v1'], [])).toEqual({ error: 'refs/tags/v1: bots push to branches only.' })
    expect(requestsOf(['bot/*/x'], [])).toEqual({ error: 'bot/*/x: only a prefix can be given, like bot/ci-bot/ or bot/ci-bot/*.' })
  })

  it('refuses a typed prefix that is or covers a members-only branch, and any prefix it cannot check', () => {
    const shared = [{ name: 'refs/heads/fix-auth', current: 'ab'.repeat(32), earlier: [], audienceNow: new Set([bot]) }]
    expect(requestsOf(['fix'], [], ['refs/heads/fix-auth'])).toEqual({ error: 'fix-auth is a members-only branch: only branches shared with the bot can be given.' })
    expect(requestsOf(['bot/ci-bot/'], [], null)).toEqual({ error: "This repo has members-only branches you can't open, so a branch prefix can't be checked against them." })
    // the branch itself, shared with the bot, is given exactly
    const got = requestsOf(['docs/'], shared, ['refs/heads/fix-auth'])
    if ('error' in got) throw new Error(got.error)
    expect(got.requests.map((r) => r.label)).toEqual(['docs/', 'fix-auth'])
  })

  it('offers no Give or Renew in a private repo, and says why once', () => {
    render(<BotsView current={[entry(listed)]} runners={[]} now={NOW} push={state([live])} me={ME} privateRepo="o/r" onPush={() => undefined} />)
    expect(byTestId('bots-push-private').map((p) => p.textContent)).toEqual(["Bots can't push to o/r, a private repository."])
    expect(byTestId('bot-push-give')).toHaveLength(0)
    expect(byTestId('bot-push-renew')).toHaveLength(0)
    expect(byTestId('bot-push-note-renew')).toHaveLength(0)
    // what it was given can still be suspended or removed
    expect(byTestId('bot-push-suspend')).toHaveLength(1)
    expect(byTestId('bot-push-remove-mine')).toHaveLength(1)
  })

  it('says a grant under a branch key that changed is stale, with Renew, and leaves it out of the line', () => {
    const onPush = vi.fn()
    const branches = [{ name: 'refs/heads/fix-auth', current: 'cd'.repeat(32), earlier: ['ab'.repeat(32)], audienceNow: new Set([bot]) }]
    const stale = { id: gid(3), granter: ME, bot, scope: 'ab'.repeat(32), until: NOW + 30 * DAY, createdAt: 2000 }
    render(<BotsView current={[entry(listed)]} runners={[]} now={NOW} push={state([live, stale] as (typeof live)[])} branches={branches} me={ME} onPush={onPush} />)
    expect(byTestId('bot-push-line')[0]?.textContent).toBe('Can push to bot/ci-bot/ until 22 Oct 2026.')
    const note = byTestId('bot-push-note').find((n) => n.dataset.kind === 'stale')
    expect(note?.textContent).toBe("@ci-bot can no longer push to fix-auth: the branch's key changed.Renew")
    act(() => note?.querySelector('button')?.click())
    expect(onPush).toHaveBeenLastCalledWith({ kind: 'renew', bot })
  })
})
