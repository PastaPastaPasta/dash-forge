// @vitest-environment jsdom
/**
 * FEAT-04: after a wallet sign-in the sheet walks through the Forge contracts the wallet has not
 * approved yet, one request at a time ("Step 2 of 3: approve Forge collaboration"), skippable, and
 * closes when there is nothing left to ask. A wallet that covered everything closes it at once.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '@/hooks/use-ui-store'

const FORGE = { core: 'CoreContract111', collab: 'CollabContract111', community: 'CommunityContract111', meta: 'MetaContract111', group: 'Group111' }

const auth = {
  grants: null as { core: boolean; collab: boolean; community: boolean; meta: boolean } | null,
}

vi.mock('@/lib/constants', async (orig) => {
  const m = await orig<typeof import('@/lib/constants')>()
  return { ...m, ACTIVE_NETWORK: { ...m.ACTIVE_NETWORK, v2: FORGE } }
})
vi.mock('@/lib/auth/connect', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/connect')>()),
  connectPlatform: () => Promise.reject(new Error('offline in tests')),
}))
vi.mock('@/lib/auth/create-identity', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/create-identity')>()),
  readCreationJournal: async () => undefined,
}))
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    vaults: [],
    lastIdentity: null,
    vaultsLoaded: true,
    vaultsError: null,
    reloadVaults: () => undefined,
    limitedKeys: true,
    isLoading: false,
    step: null,
    identity: null,
    keyId: null,
    unlockScope: null,
    storage: null,
    grants: auth.grants,
    controller: { supportsLimitedKeys: () => false, checkGroup: async () => ({ notice: null }), checkFileNetwork: () => undefined },
  }),
}))
/** A wallet flow that records what it was asked for and finishes on a click. */
vi.mock('@/components/auth/wallet-connect-flow', () => ({
  WalletConnectFlow: ({ mode = 'login', contractId, onDone }: { mode?: string; contractId?: string; onDone: () => void }) => (
    <div data-testid="fake-wallet" data-mode={mode} data-contract={contractId ?? ''}>
      <button type="button" onClick={onDone}>
        wallet done
      </button>
    </div>
  ),
}))

const { LoginModal } = await import('./login-modal')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const q = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel)
const byText = (text: string): HTMLElement | null => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === text) ?? null
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
async function click(el: HTMLElement | null): Promise<void> {
  expect(el).not.toBeNull()
  await act(async () => el!.click())
  await flush()
}
/** The wallet sign-in finished with `grants` approved: the sheet reads them and decides. */
async function signedInWith(grants: { collab: boolean; community: boolean; meta: boolean }): Promise<void> {
  act(() => useUiStore.getState().openLogin('wallet'))
  await flush()
  expect(q('[data-testid="fake-wallet"]')!.dataset.mode).toBe('login')
  auth.grants = { core: true, ...grants }
  await click(byText('wallet done'))
  // The new session's grants reach the sheet on the next render.
  act(() => root.render(<LoginModal />))
  await flush()
}
const title = (): string => q('[role="dialog"] h2, [role="dialog"] [id$="-title"]')?.textContent ?? document.body.textContent ?? ''

beforeEach(() => {
  auth.grants = null
  Element.prototype.scrollIntoView = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<LoginModal />))
})
afterEach(() => {
  act(() => useUiStore.getState().closeLogin())
  act(() => root.unmount())
  host.remove()
})

describe('guided wallet grants after sign-in', () => {
  it('asks for every missing contract in order, then closes', async () => {
    await signedInWith({ collab: false, community: false, meta: false })
    expect(document.body.textContent).toContain('Step 2 of 4: approve Forge collaboration')
    expect(q('[data-testid="fake-wallet"]')).toMatchObject({ dataset: expect.objectContaining({ mode: 'grant', contract: FORGE.collab }) })

    auth.grants = { core: true, collab: true, community: false, meta: false }
    await click(byText('wallet done'))
    act(() => root.render(<LoginModal />))
    await flush()
    expect(document.body.textContent).toContain('Step 3 of 4: approve Forge community')
    expect(q('[data-testid="fake-wallet"]')!.dataset.contract).toBe(FORGE.community)

    auth.grants = { core: true, collab: true, community: true, meta: false }
    await click(byText('wallet done'))
    act(() => root.render(<LoginModal />))
    await flush()
    expect(document.body.textContent).toContain('Step 4 of 4: approve Forge labels and profiles')
    expect(q('[data-testid="fake-wallet"]')!.dataset.contract).toBe(FORGE.meta)

    auth.grants = { core: true, collab: true, community: true, meta: true }
    await click(byText('wallet done'))
    act(() => root.render(<LoginModal />))
    await flush()
    expect(useUiStore.getState().loginOpen).toBe(false)
  })

  it('moves on when a step is skipped, and the rest can be skipped at once', async () => {
    await signedInWith({ collab: false, community: false, meta: false })
    await click(byText('Skip this step'))
    expect(document.body.textContent).toContain('Step 3 of 4: approve Forge community')
    // The skipped one is not asked again; "Skip the rest" ends the sequence.
    await click(byText('Skip the rest'))
    expect(useUiStore.getState().loginOpen).toBe(false)
  })

  it('offers no "Skip the rest" on the last step', async () => {
    await signedInWith({ collab: true, community: true, meta: false })
    expect(document.body.textContent).toContain('Step 2 of 2: approve Forge labels and profiles')
    expect(byText('Skip the rest')).toBeNull()
    await click(byText('Skip this step'))
    expect(useUiStore.getState().loginOpen).toBe(false)
  })

  it('closes at once when the wallet approved every contract', async () => {
    await signedInWith({ collab: true, community: true, meta: true })
    expect(useUiStore.getState().loginOpen).toBe(false)
    expect(q('[data-testid="guided-skip"]')).toBeNull()
  })

  it('leaves a grant a refused write asks for alone: no steps, no skip buttons', async () => {
    auth.grants = { core: true, collab: false, community: true, meta: true }
    act(() => useUiStore.getState().openLogin('grant', 'collab'))
    await flush()
    expect(q('[data-testid="fake-wallet"]')!.dataset.contract).toBe(FORGE.collab)
    expect(q('[data-testid="guided-skip"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Step ')
    expect(title()).toContain('Approve issues and pull requests')
  })
})
