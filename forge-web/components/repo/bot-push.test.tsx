// @vitest-environment jsdom
/**
 * The push dialogs (`./bot-push`; forge-core `dg bot allow --push` and `dg bot renew`): what they
 * check before signing. A prefix that is or covers a members-only branch is refused (and any prefix
 * when the repo has members-only branches this maintainer can't open), a private repo is refused
 * with nothing read, and giving a suspended bot push access says it lets the bot push again.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '@/lib/auth/base58'
import { DEFAULT_PUSH_POLICY, setPush, type AccessNotice } from '@/lib/private'
import type { BotPushAccess } from '@/lib/repo/push-grants'
import type { RepoHome } from '@/lib/view'

const BOT = base58Encode(new Uint8Array(32).fill(7))
const ME = base58Encode(new Uint8Array(32).fill(1))
const OTHER = base58Encode(new Uint8Array(32).fill(2))
const NAMES: Record<string, string> = { [BOT]: 'ci-bot.dash', [ME]: 'me.dash', [OTHER]: 'm.dash' }

const m = vi.hoisted(() => ({
  readMembersOnlyNames: vi.fn(),
  readGrantableBranches: vi.fn(),
  readBotPushAccess: vi.fn(),
}))

vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'testnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: ME, signer: null }) }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: (id: string) => NAMES[id] }))
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: ({ open, title, cost, blocked, children }: { open: boolean; title: string; cost: unknown; blocked?: React.ReactNode; children?: React.ReactNode }) =>
    open ? (
      <div data-testid="confirm" data-cost={cost === 'pending' ? 'pending' : 'shown'}>
        <h2>{title}</h2>
        {children}
        {blocked}
      </div>
    ) : null,
}))
vi.mock('@/lib/repo', async (orig) => ({ ...(await orig<typeof import('@/lib/repo')>()), repoContractIds: () => [] }))
vi.mock('@/lib/repo/members-branches', () => ({ readMembersOnlyNames: m.readMembersOnlyNames }))
vi.mock('@/lib/repo/push-grants', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo/push-grants')>()),
  readGrantableBranches: m.readGrantableBranches,
  readBotPushAccess: m.readBotPushAccess,
}))

const { PushDialog } = await import('./bot-push')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  m.readMembersOnlyNames.mockResolvedValue([])
  m.readGrantableBranches.mockResolvedValue([])
  m.readBotPushAccess.mockResolvedValue(access())
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const NOW = Date.now()
const DAY = 86_400_000
const grant = { id: base58Encode(new Uint8Array(32).fill(101)), granter: ME, bot: BOT, prefix: 'refs/heads/bot/ci-bot/', until: NOW + 30 * DAY, createdAt: 2000 }
const notice: AccessNotice = { bot: new Uint8Array(32).fill(7), may: ['post'], askers: 'writers', threads: 'all', processor: null, until: null, revokes: [], note: '', extra: {} }
const listed = setPush(notice, [{ grant: new Uint8Array(32).fill(101), target: { prefix: grant.prefix } }], DEFAULT_PUSH_POLICY)

function access(over: Partial<BotPushAccess> = {}): BotPushAccess {
  return {
    bot: BOT,
    supported: true,
    grants: [grant],
    botRowAt: 1000,
    maintainers: new Set([ME, OTHER]),
    notice: { id: 'N', writer: ME, createdAt: 3000, packHash: 'ab'.repeat(32), notice: listed },
    now: NOW,
    ...over,
  }
}

const home = (visibility: 'public' | 'private'): RepoHome =>
  ({ repo: { repoId: base58Encode(new Uint8Array(32).fill(9)), ownerId: ME, visibility, forge: {} }, defaultBranch: 'main', config: { protectedPatterns: ['refs/heads/main'] } }) as unknown as RepoHome

async function open(kind: 'give' | 'renew', visibility: 'public' | 'private' = 'public'): Promise<void> {
  await act(async () => {
    root.render(<PushDialog home={home(visibility)} display="o/r" action={{ kind, bot: BOT }} onClose={() => undefined} onSaved={() => undefined} />)
  })
}

const byTestId = (id: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)]
const problem = (): string | null => byTestId('push-problem')[0]?.textContent ?? null

describe('give push access', () => {
  it('gives the default prefix when no members-only branch is under it', async () => {
    await open('give')
    expect(problem()).toBeNull()
    expect(byTestId('confirm')[0]?.dataset.cost).toBe('shown')
    expect(byTestId('push-resumes')).toHaveLength(0)
  })

  it('refuses a prefix that covers a members-only branch', async () => {
    m.readMembersOnlyNames.mockResolvedValue(['refs/heads/bot/ci-bot/fix-auth'])
    await open('give')
    expect(problem()).toBe('bot/ci-bot/fix-auth is a members-only branch: only branches shared with the bot can be given.')
  })

  it("refuses any prefix when the repo has members-only branches this maintainer can't open", async () => {
    m.readMembersOnlyNames.mockResolvedValue(null)
    await open('give')
    expect(problem()).toBe("This repo has members-only branches you can't open, so a branch prefix can't be checked against them.")
  })

  it('says giving a suspended bot push access lets it push again, and who suspended it', async () => {
    m.readBotPushAccess.mockResolvedValue(access({ notice: { id: 'N', writer: OTHER, createdAt: 3000, packHash: 'ab'.repeat(32), notice: setPush(listed, [], DEFAULT_PUSH_POLICY) } }))
    await open('give')
    expect(byTestId('push-resumes')[0]?.textContent).toBe('This also lets @ci-bot push again: @m suspended its pushes.')
  })

  it('refuses a private repo, reading nothing', async () => {
    await open('give', 'private')
    expect(problem()).toBe("Bots can't push to o/r, a private repository.")
    expect(m.readBotPushAccess).not.toHaveBeenCalled()
    expect(m.readMembersOnlyNames).not.toHaveBeenCalled()
  })
})

describe('renew', () => {
  it('checks the prefixes it gives again', async () => {
    m.readMembersOnlyNames.mockResolvedValue(['refs/heads/bot/ci-bot/wip'])
    await open('renew')
    expect(problem()).toBe('bot/ci-bot/wip is a members-only branch: only branches shared with the bot can be given.')
  })

  it('refuses a private repo', async () => {
    await open('renew', 'private')
    expect(problem()).toBe("Bots can't push to o/r, a private repository.")
    expect(m.readBotPushAccess).not.toHaveBeenCalled()
  })
})
