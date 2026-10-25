// @vitest-environment jsdom
/**
 * Wallet sign-in over an unfinished renewal whose key is locked: the renewal's passphrase input is
 * uncontrolled, so the typed passphrase never lands in the DOM's `value` attribute. The wallet's
 * encryption key goes to the sign-in with every attempt, and is wiped once it is done (D27).
 *
 * App Connect v2: shown first where the chain supports it (with the group check and the locked-key
 * check before the code), a link to the older code and back, the poll cut short on focus and on the
 * return page's message, the confirm step, and a renewal in the wallet that granted the key
 * (protection first, the old key's renewal mark ended on every way out but a stored key).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingRenewalChoiceError, PendingRenewalLockedError } from '@/lib/auth/controller'

const { ID, FORGE, answered, v2, auth } = vi.hoisted(() => ({
  ID: '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD',
  FORGE: { core: 'CoreContract111', collab: 'CollabContract111', community: 'CommunityContract111', group: 'Group111' },
  /** The encryption keys of the last answer the fake wallet gave. */
  answered: { keys: [] as Uint8Array[] },
  /** The App Connect v2 side of the fake chain and wallet. */
  v2: {
    available: false,
    /** What the fake wallet answers: resolve it from a test, or reject it. */
    pending: null as { resolve: (g: unknown) => void; reject: (e: Error) => void } | null,
    trigger: null as { fire: () => void } | null,
    awaited: 0,
    calls: [] as string[],
    /** The older (v1) request stays unanswered, so its request step stays on screen. */
    holdV1: false,
    /** The older flow's response-source lookup never returns (it is still being built). */
    holdSources: false,
    /** The renewal request's private key, to see it spent. */
    renewalPriv: null as Uint8Array | null,
  },
  /** The signed-in session and controller the flow reads. */
  auth: {
    identity: null as string | null,
    unlockScope: null as 'full' | 'signing' | null,
    controller: {} as Record<string, unknown>,
  },
}))
const FAKE_VAULT_PASSPHRASE = 'fake-vault-passphrase-000'
const FAKE_RENEWAL_PASSPHRASE = 'fake-renewal-passphrase-789'
const adoptWalletKeys = vi.fn()

vi.mock('@/lib/constants', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/lib/constants')>()
  return { ...m, ACTIVE_NETWORK: { ...m.ACTIVE_NETWORK, v2: FORGE } }
})
vi.mock('@/lib/auth/connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/connect')>()),
  connectPlatform: async () => ({}),
  withPlatformRead: <T,>(p: Promise<T>) => p,
}))
vi.mock('@/lib/auth/app-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/app-connect')>()),
  responseSources: async () => (v2.holdSources ? new Promise<never>(() => undefined) : [{}]),
  newLoginRequest: () => {
    v2.calls.push('v1-request')
    return { uri: 'dash-key:fake', expiresAt: Date.now() + 60_000 }
  },
  awaitWalletAnswer: async () => {
    if (v2.holdV1) return new Promise<never>(() => undefined)
    answered.keys = [new Uint8Array(32).fill(0x42)]
    return { kind: 'keys', identityId: ID, keys: [{ scope: {}, limits: {} }], encryptionKeys: answered.keys }
  },
}))
vi.mock('@/lib/auth/app-connect-v2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/app-connect-v2')>()),
  appConnectV2Available: async () => v2.available,
  readChainClock: async () => ({ timeMs: 1_800_000_000_000, protocolVersion: 14 }),
  newV2LoginRequest: () => {
    v2.calls.push('request')
    return fakeV2Request(null)
  },
  awaitV2Grant: (_sdk: unknown, _req: unknown, p: { trigger: { fire: () => void }; signal: AbortSignal }) => {
    v2.awaited++
    v2.trigger = p.trigger
    return new Promise((resolve, reject) => {
      v2.pending = { resolve, reject }
      // The real poll ends with an AbortError when the sheet closes or restarts.
      p.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
    })
  },
}))
vi.mock('@/lib/auth/key-registration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/key-registration')>()),
  isUnlimited: () => false,
}))
vi.mock('@/lib/auth/responder-profile', () => ({
  responderProfile: async () => ({ identityId: ID, name: null, namedAt: null, warnings: [] }),
}))
vi.mock('@/components/ui/qr', () => ({ Qr: ({ value }: { value: string }) => <figcaption data-testid="qr-value">{value}</figcaption> }))
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    adoptWalletKeys,
    addWalletGrant: vi.fn(),
    identity: auth.identity,
    isLoading: false,
    vaults: [],
    unlockScope: auth.unlockScope,
    controller: auth.controller,
  }),
}))

/** A v2 request as the (mocked) builder returns it; `hint`: the identity a renewal names. */
function fakeV2Request(hint: string | null): { appEphemeralPriv: Uint8Array } & Record<string, unknown> {
  return {
    request: { authBindings: [{ totalBudget: 5_000_000_000n, expiresAt: 1_807_776_000_000 }] },
    qrUri: 'dash-key:v2qr?v=2',
    linkUri: 'dash-key:v2link?v=2&cb=x',
    requestHash: new Uint8Array(20).fill(0xab),
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    chainTimeAtCreation: 1_800_000_000_000,
    identityHint: hint,
    appEphemeralPriv: new Uint8Array(32).fill(7),
  }
}

const { WalletConnectFlow } = await import('./wallet-connect-flow')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function type(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
function byText(text: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!
}
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => Promise.resolve())
}

const checkGroup = vi.fn()
const walletSignInBlocker = vi.fn()
const walletRenewalRequest = vi.fn()
const endWalletRenewal = vi.fn()

beforeEach(() => {
  adoptWalletKeys.mockReset()
  v2.available = false
  v2.pending = null
  v2.trigger = null
  v2.awaited = 0
  v2.calls = []
  v2.holdV1 = false
  v2.holdSources = false
  v2.renewalPriv = null
  auth.identity = null
  auth.unlockScope = null
  checkGroup.mockReset().mockImplementation(async () => {
    v2.calls.push('group')
    return { unknown: [], unchecked: [], notice: null }
  })
  walletSignInBlocker.mockReset().mockImplementation(async () => {
    v2.calls.push('blocker')
    return null
  })
  walletRenewalRequest.mockReset().mockImplementation(async () => {
    v2.calls.push('renewal-request')
    const req = { ...fakeV2Request(ID), replacesKeyId: 7 }
    v2.renewalPriv = req.appEphemeralPriv
    return req
  })
  endWalletRenewal.mockReset()
  auth.controller = { checkGroup, walletSignInBlocker, walletRenewalRequest, endWalletRenewal }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('WalletConnectFlow: a locked unfinished renewal', () => {
  it('keeps the renewal passphrase out of the DOM and passes it on', async () => {
    adoptWalletKeys
      .mockRejectedValueOnce(new PendingRenewalChoiceError(7))
      .mockRejectedValueOnce(new PendingRenewalLockedError(7, ['passphrase'], false))
      .mockResolvedValueOnce(undefined)
    const onDone = vi.fn()
    act(() => root.render(<WalletConnectFlow onDone={onDone} />))
    await flush()
    expect(host.querySelector('[data-testid="wallet-confirm"]')).not.toBeNull()
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    act(() => type(host.querySelector<HTMLInputElement>('#vault-passphrase')!, FAKE_VAULT_PASSPHRASE))
    act(() => type(host.querySelector<HTMLInputElement>('#vault-passphrase-2')!, FAKE_VAULT_PASSPHRASE))
    await act(async () => byText('Finish signing in').click())
    await act(async () => byText('Continue with the wallet').click())

    const input = host.querySelector<HTMLInputElement>('#renewal-passphrase')!
    expect(byText('Keep its key and continue').disabled).toBe(true)
    act(() => type(input, FAKE_RENEWAL_PASSPHRASE))
    expect(input.getAttribute('value') ?? '').not.toContain(FAKE_RENEWAL_PASSPHRASE)
    expect(document.body.innerHTML).not.toContain(FAKE_RENEWAL_PASSPHRASE)
    expect(byText('Keep its key and continue').disabled).toBe(false)
    await act(async () => byText('Keep its key and continue').click())
    expect(adoptWalletKeys).toHaveBeenLastCalledWith(ID, expect.anything(), expect.anything(), {
      discardPendingRenewal: true,
      renewalUnlock: { passphrase: FAKE_RENEWAL_PASSPHRASE },
      encryptionKeys: answered.keys,
      justRegistered: false,
    })
    expect(onDone).toHaveBeenCalled()
    // Passed intact on each of the three attempts, and wiped once signed in.
    expect(adoptWalletKeys).toHaveBeenCalledTimes(3)
    expect(answered.keys[0]!.every((b) => b === 0)).toBe(true)
  })

  it("wipes the wallet's encryption key when the sheet closes before signing in", async () => {
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} />))
    await flush()
    expect(host.querySelector('[data-testid="wallet-confirm"]')).not.toBeNull()
    expect(answered.keys[0]!.every((b) => b === 0x42)).toBe(true)
    act(() => root.render(<></>))
    expect(answered.keys[0]!.every((b) => b === 0)).toBe(true)
  })
})

/** What the verified v2 grant is: the identity and its group-bound key (budget 0.05 DASH). */
const V2_GRANT = {
  identityId: ID,
  key: { keyId: 9, wif: 'wif', scope: { unbounded: false }, limits: { remaining: 5_000_000_000n, total: 5_000_000_000n, expiresAt: 1_807_776_000_000 } },
}
const q = (testId: string): HTMLElement | null => host.querySelector(`[data-testid="${testId}"]`)

describe('WalletConnectFlow: App Connect v2 sign-in', () => {
  it('shows the v2 request first, after the group and locked-key checks, with one-approval terms', async () => {
    v2.available = true
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} />))
    await flush()
    expect(v2.calls).toEqual(['group', 'blocker', 'request'])
    expect(q('qr-value')!.textContent).toBe('dash-key:v2qr?v=2')
    expect(q('approval-terms')!.textContent).toMatch(/One approval covers all of Forge, spending up to 0\.05\d* DASH/)
    expect(q('approval-terms')!.textContent).toMatch(/until /)
    expect(q('wallet-support')!.textContent).toMatch(/App Connect v2/)
    expect(q('older-code')!.textContent).toBe('Using a Dash Wallet build without App Connect v2? Show the older code')
    expect(v2.awaited).toBe(1)
  })

  it('goes straight to the older code where v2 is not available', async () => {
    v2.holdV1 = true
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} />))
    await flush()
    expect(q('qr-value')!.textContent).toBe('dash-key:fake')
    expect(q('older-code')).toBeNull()
    expect(q('newer-code')).toBeNull()
    expect(v2.calls).toEqual(['v1-request'])
  })

  it('falls back to the older code when the group check refuses', async () => {
    v2.available = true
    v2.holdV1 = true
    checkGroup.mockRejectedValueOnce(new Error('refusing to bind a key to this group'))
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} />))
    await flush()
    expect(q('qr-value')!.textContent).toBe('dash-key:fake')
    expect(v2.awaited).toBe(0)
  })

  it('switches to the older code and back', async () => {
    v2.available = true
    v2.holdV1 = true
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} />))
    await flush()
    await act(async () => q('older-code')!.click())
    await flush()
    expect(q('qr-value')!.textContent).toBe('dash-key:fake')
    expect(q('wallet-support')!.textContent).not.toMatch(/App Connect v2/)
    expect(q('older-code')).toBeNull()
    await act(async () => q('newer-code')!.click())
    await flush()
    expect(q('qr-value')!.textContent).toBe('dash-key:v2qr?v=2')
  })

  it('asks to unlock first when a locked vault holds a wallet key', async () => {
    v2.available = true
    walletSignInBlocker.mockResolvedValueOnce('Unlock the key stored for 9r27eD…9dUD first.')
    const onUnlock = vi.fn()
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} onUnlock={onUnlock} />))
    await flush()
    expect(q('wallet-blocked')!.textContent).toContain('Unlock the key stored')
    expect(q('qr-value')).toBeNull()
    expect(v2.calls).not.toContain('request')
    await act(async () => byText('Unlock').click())
    expect(onUnlock).toHaveBeenCalled()
  })

  it('confirms who answered, shows the granted limits and the group notice, then stores it as App Connect\'s', async () => {
    v2.available = true
    checkGroup.mockResolvedValueOnce({ unknown: ['x'], unchecked: [], notice: 'The group also holds 1 contract this build does not know.' })
    const onDone = vi.fn()
    adoptWalletKeys.mockResolvedValue(undefined)
    act(() => root.render(<WalletConnectFlow onDone={onDone} />))
    await flush()
    await act(async () => v2.pending!.resolve(V2_GRANT))
    await flush()
    expect(q('wallet-confirm')).not.toBeNull()
    expect(q('granted-identity')!.textContent).toBe(ID)
    expect(q('unlimited-key-warning')).toBeNull()
    expect(q('approval-terms')!.textContent).toMatch(/spending capped at 0\.05\d* DASH/)
    expect(q('group-notice')!.textContent).toContain('does not know')
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    act(() => type(host.querySelector<HTMLInputElement>('#vault-passphrase')!, FAKE_VAULT_PASSPHRASE))
    act(() => type(host.querySelector<HTMLInputElement>('#vault-passphrase-2')!, FAKE_VAULT_PASSPHRASE))
    await act(async () => byText('Finish signing in').click())
    expect(adoptWalletKeys).toHaveBeenCalledWith(ID, [V2_GRANT.key], expect.objectContaining({ passphrase: FAKE_VAULT_PASSPHRASE }), {
      discardPendingRenewal: false,
      origin: 'app-connect',
    })
    expect(onDone).toHaveBeenCalled()
  })

  it('polls at once when the tab regains focus or becomes visible', async () => {
    v2.available = true
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} />))
    await flush()
    const fire = vi.spyOn(v2.trigger!, 'fire')
    act(() => void window.dispatchEvent(new Event('focus')))
    expect(fire).toHaveBeenCalledTimes(1)
    act(() => void document.dispatchEvent(new Event('visibilitychange')))
    expect(fire).toHaveBeenCalledTimes(2)
  })

  it("polls at once when the return page reports this request, and ignores another's", async () => {
    v2.available = true
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} />))
    await flush()
    const fire = vi.spyOn(v2.trigger!, 'fire')
    const page = new BroadcastChannel('forge-app-connect')
    const acks: unknown[] = []
    page.onmessage = (e: MessageEvent) => acks.push(e.data)
    page.postMessage({ type: 'forge-app-connect-callback', requestHash: 'cd'.repeat(20), status: 'ok' })
    page.postMessage({ type: 'forge-app-connect-callback', requestHash: 'ab'.repeat(20), status: 'ok' })
    await new Promise((r) => setTimeout(r, 40))
    expect(fire).toHaveBeenCalledTimes(1)
    expect(acks).toEqual([{ type: 'forge-app-connect-ack', requestHash: 'ab'.repeat(20) }])
    page.close()
  })

  it('names a refusal and offers another try', async () => {
    v2.available = true
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} />))
    await flush()
    await act(async () => v2.pending!.reject(new Error('Two identities answered.')))
    await flush()
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Two identities answered.')
    expect(byText('Try again')).toBeDefined()
  })
})

describe('WalletConnectFlow: App Connect v2, the edges', () => {
  it('takes the old request off screen at once when the code is switched', async () => {
    v2.available = true
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} />))
    await flush()
    expect(q('qr-value')!.textContent).toBe('dash-key:v2qr?v=2')
    // The older flow is still being built (its sources are not back): the spent v2 code must not stay up.
    v2.holdSources = true
    await act(async () => q('older-code')!.click())
    await flush()
    expect(q('qr-value')).toBeNull()
    expect(q('older-code')).toBeNull()
    expect(host.textContent).toContain('Finding the wallet login contract')
  })

  it('shows a failed group read with Try again, not a silent switch to the older code', async () => {
    v2.available = true
    checkGroup.mockRejectedValueOnce(new Error('Reading the contract group timed out'))
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} />))
    await flush()
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('timed out')
    expect(byText('Try again')).toBeDefined()
    expect(v2.calls).not.toContain('v1-request')
    expect(v2.awaited).toBe(0)
  })

  it('takes a failed v2 request off screen and keeps the older code reachable', async () => {
    v2.available = true
    v2.holdV1 = true
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} />))
    await flush()
    expect(q('qr-value')).not.toBeNull()
    await act(async () => v2.pending!.reject(new Error('The key your wallet sent has no spending limit or no expiry.')))
    await flush()
    // The spent code is gone; the error stands with Try again and a way to the older code.
    expect(q('qr-value')).toBeNull()
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('no spending limit')
    await act(async () => q('older-code-error')!.click())
    await flush()
    expect(v2.calls).toContain('v1-request')
  })

  it('offers the older code when the group read keeps failing, and does not read the group again for it', async () => {
    v2.available = true
    v2.holdV1 = true
    checkGroup.mockRejectedValue(new Error('Reading the contract group timed out'))
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} />))
    await flush()
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('timed out')
    checkGroup.mockClear()
    await act(async () => q('older-code-error')!.click())
    await flush()
    expect(v2.calls).toContain('v1-request')
    expect(checkGroup).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('says what the wallet reported when it returns with a decline', async () => {
    v2.available = true
    act(() => root.render(<WalletConnectFlow onDone={vi.fn()} />))
    await flush()
    const page = new BroadcastChannel('forge-app-connect')
    page.postMessage({ type: 'forge-app-connect-callback', requestHash: 'ab'.repeat(20), status: 'declined' })
    await act(async () => new Promise((r) => setTimeout(r, 40)))
    expect(q('wallet-reported')!.textContent).toContain('Sign-in declined')
    page.close()
  })
})

describe('WalletConnectFlow: renew in the wallet that granted the key', () => {
  const fillProtection = (): void => {
    act(() => type(host.querySelector<HTMLInputElement>('#vault-passphrase')!, FAKE_VAULT_PASSPHRASE))
    act(() => type(host.querySelector<HTMLInputElement>('#vault-passphrase-2')!, FAKE_VAULT_PASSPHRASE))
  }

  it('chooses the protection before any request exists', async () => {
    auth.identity = ID
    act(() => root.render(<WalletConnectFlow mode="renew" onDone={vi.fn()} />))
    await flush()
    expect(q('wallet-renew-prepare')).not.toBeNull()
    expect(q('qr-value')).toBeNull()
    expect(walletRenewalRequest).not.toHaveBeenCalled()
    expect(byText('Continue to your wallet').disabled).toBe(true)
    fillProtection()
    expect(byText('Continue to your wallet').disabled).toBe(false)
    expect(walletRenewalRequest).not.toHaveBeenCalled()
  })

  it('shows the code, stores the new key as App Connect\'s and keeps the renewal mark until then', async () => {
    auth.identity = ID
    adoptWalletKeys.mockResolvedValue(undefined)
    const onDone = vi.fn()
    act(() => root.render(<WalletConnectFlow mode="renew" onDone={onDone} />))
    await flush()
    fillProtection()
    await act(async () => byText('Continue to your wallet').click())
    await flush()
    expect(walletRenewalRequest).toHaveBeenCalledTimes(1)
    expect(q('qr-value')!.textContent).toBe('dash-key:v2qr?v=2')
    expect(q('approval-terms')!.textContent).toMatch(/Approve the renewal in the wallet/)
    expect(q('older-code')).toBeNull()
    expect(endWalletRenewal).not.toHaveBeenCalled()
    await act(async () => v2.pending!.resolve(V2_GRANT))
    await flush()
    expect(adoptWalletKeys).toHaveBeenCalledWith(ID, [V2_GRANT.key], expect.objectContaining({ passphrase: FAKE_VAULT_PASSPHRASE }), {
      discardPendingRenewal: false,
      origin: 'app-connect',
    })
    expect(onDone).toHaveBeenCalled()
    // Stored: the controller already cleared the mark.
    expect(endWalletRenewal).not.toHaveBeenCalled()
  })

  it('ends the renewal when the sheet closes before the wallet answers', async () => {
    auth.identity = ID
    act(() => root.render(<WalletConnectFlow mode="renew" onDone={vi.fn()} />))
    await flush()
    fillProtection()
    await act(async () => byText('Continue to your wallet').click())
    await flush()
    await act(async () => {
      root.render(<></>)
    })
    // The poll ends with an abort; the renewal's mark goes with it.
    await act(async () => v2.pending!.reject(new DOMException('cancelled', 'AbortError')))
    await flush()
    expect(endWalletRenewal).toHaveBeenCalledWith(expect.objectContaining({ identityHint: ID, replacesKeyId: 7 }))
    expect(adoptWalletKeys).not.toHaveBeenCalled()
  })

  it('ends the renewal when the wallet refuses, and names why', async () => {
    auth.identity = ID
    act(() => root.render(<WalletConnectFlow mode="renew" onDone={vi.fn()} />))
    await flush()
    fillProtection()
    await act(async () => byText('Continue to your wallet').click())
    await flush()
    await act(async () => v2.pending!.reject(new Error("The key your wallet sent has no spending limit or no expiry. Forge didn't use it.")))
    await flush()
    expect(endWalletRenewal).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('no spending limit')
  })

  it('keeps a granted key that failed to store on screen, with the reason', async () => {
    auth.identity = ID
    adoptWalletKeys.mockRejectedValue(new Error('Another tab changed the key stored meanwhile.'))
    act(() => root.render(<WalletConnectFlow mode="renew" onDone={vi.fn()} />))
    await flush()
    fillProtection()
    await act(async () => byText('Continue to your wallet').click())
    await flush()
    await act(async () => v2.pending!.resolve(V2_GRANT))
    await flush()
    expect(q('wallet-renew-store')).not.toBeNull()
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Another tab changed')
    expect(byText('Store the new key')).toBeDefined()
    // Not given up until the sheet closes.
    expect(endWalletRenewal).not.toHaveBeenCalled()
  })

  it('closing the sheet before the wallet request exists spends it and ends the renewal', async () => {
    auth.identity = ID
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    walletRenewalRequest.mockImplementation(async () => {
      await gate
      const req = { ...fakeV2Request(ID), replacesKeyId: 7 }
      v2.renewalPriv = req.appEphemeralPriv
      return req
    })
    act(() => root.render(<WalletConnectFlow mode="renew" onDone={vi.fn()} />))
    await flush()
    fillProtection()
    await act(async () => byText('Continue to your wallet').click())
    await flush()
    await act(async () => {
      root.render(<></>)
    })
    await act(async () => release())
    await flush()
    expect(v2.awaited).toBe(0)
    expect(endWalletRenewal).toHaveBeenCalledWith(expect.objectContaining({ identityHint: ID, replacesKeyId: 7 }))
    expect(v2.renewalPriv!.every((b) => b === 0)).toBe(true)
  })

  it('a granted key that cannot be stored yet is held for a decision, then stored', async () => {
    auth.identity = ID
    adoptWalletKeys.mockRejectedValueOnce(new PendingRenewalChoiceError(7)).mockResolvedValueOnce(undefined)
    const onDone = vi.fn()
    act(() => root.render(<WalletConnectFlow mode="renew" onDone={onDone} />))
    await flush()
    fillProtection()
    await act(async () => byText('Continue to your wallet').click())
    await flush()
    await act(async () => v2.pending!.resolve(V2_GRANT))
    await flush()
    // The wallet has disabled the old key: the new one is kept on screen, not dropped.
    expect(q('wallet-renew-store')).not.toBeNull()
    expect(q('pending-renewal-choice')).not.toBeNull()
    expect(onDone).not.toHaveBeenCalled()
    expect(endWalletRenewal).not.toHaveBeenCalled()
    await act(async () => byText('Continue with the wallet').click())
    await flush()
    expect(adoptWalletKeys).toHaveBeenLastCalledWith(ID, [V2_GRANT.key], expect.anything(), { discardPendingRenewal: true, origin: 'app-connect' })
    expect(onDone).toHaveBeenCalled()
    expect(endWalletRenewal).not.toHaveBeenCalled()
  })

  it('closing the sheet with the new key unstored ends the renewal', async () => {
    auth.identity = ID
    adoptWalletKeys.mockRejectedValue(new Error('The vault is locked.'))
    act(() => root.render(<WalletConnectFlow mode="renew" onDone={vi.fn()} />))
    await flush()
    fillProtection()
    await act(async () => byText('Continue to your wallet').click())
    await flush()
    await act(async () => v2.pending!.resolve(V2_GRANT))
    await flush()
    expect(q('wallet-renew-store')).not.toBeNull()
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('vault is locked')
    // Not a way out that unmounts the flow (it would drop the key): only a retry.
    expect(byText('Unlock')).toBeUndefined()
    expect(endWalletRenewal).not.toHaveBeenCalled()
    act(() => root.unmount())
    expect(endWalletRenewal).toHaveBeenCalledTimes(1)
    root = createRoot(host)
  })

  it('closing the sheet while the new key is being stored leaves the mark to that attempt', async () => {
    auth.identity = ID
    let fail: (e: Error) => void = () => undefined
    adoptWalletKeys.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject
        }),
    )
    act(() => root.render(<WalletConnectFlow mode="renew" onDone={vi.fn()} />))
    await flush()
    fillProtection()
    await act(async () => byText('Continue to your wallet').click())
    await flush()
    await act(async () => v2.pending!.resolve(V2_GRANT))
    await flush()
    act(() => root.unmount())
    // Mid-store: another tab must keep treating the old key as replaced.
    expect(endWalletRenewal).not.toHaveBeenCalled()
    await act(async () => fail(new Error('Another tab changed the key stored meanwhile.')))
    expect(endWalletRenewal).toHaveBeenCalledTimes(1)
    root = createRoot(host)
  })

  it('asks a signing-only tab to unlock first', async () => {
    auth.identity = ID
    auth.unlockScope = 'signing'
    act(() => root.render(<WalletConnectFlow mode="renew" onDone={vi.fn()} />))
    await flush()
    expect(q('renew-unlock')).not.toBeNull()
    expect(walletRenewalRequest).not.toHaveBeenCalled()
  })
})
