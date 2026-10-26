// @vitest-environment jsdom
/**
 * Importing the identity's encryption key in Settings is a key change for the passkeys that hold
 * the old one: this device's are encrypted again right after (`resealPlatformPasskeys`, no prompt),
 * and a failure of that never fails the import.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const CORE = 'CoreContractIdForTestsOnly1111111111111111111'

const m = vi.hoisted(() => ({
  reseal: undefined as unknown as ReturnType<typeof vi.fn>,
  importKey: undefined as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ identity: ID, storage: 'vault', unlockScope: 'full', controller: { resealPlatformPasskeys: m.reseal } }),
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/lib/constants', async (orig) => {
  const real = await orig<typeof import('@/lib/constants')>()
  return { ...real, NETWORKS: { ...real.NETWORKS, devnet: { ...real.NETWORKS.devnet, v2: { ...(real.NETWORKS.devnet.v2 ?? {}), core: CORE } } } }
})
vi.mock('@/lib/auth/vault', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/vault')>()),
  storedEncryptionKeyIds: async () => [],
  onEncryptionKeyChange: () => () => undefined,
}))
vi.mock('@/lib/auth/encryption-key', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/encryption-key')>()),
  importEncryptionKey: (...args: unknown[]) => m.importKey(...args),
}))

const { EncryptionKeyPanel } = await import('./encryption-key-panel')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

async function importFromPhrase(): Promise<void> {
  await act(async () => root.render(<EncryptionKeyPanel />))
  await act(async () => {
    await Promise.resolve()
  })
  const words = host.querySelector<HTMLTextAreaElement>('#enc-phrase')!
  words.value = Array(12).fill('abandon').join(' ')
  const use = [...host.querySelectorAll('button')].find((b) => /Use my encryption key/.test(b.textContent ?? ''))!
  await act(async () => use.click())
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  m.reseal = vi.fn(async () => ({ resealed: 1, needUpdate: 0 }))
  m.importKey = vi.fn(async () => 7)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('importing an encryption key in Settings', () => {
  it('encrypts this device’s passkeys again with it, without asking for a passkey', async () => {
    await importFromPhrase()
    expect(m.importKey).toHaveBeenCalledTimes(1)
    expect(host.textContent).toMatch(/encryption key 7 is stored in this browser/)
    // No id: this device's own passkeys, no prompt.
    expect(m.reseal).toHaveBeenCalledTimes(1)
    expect(m.reseal).toHaveBeenCalledWith()
  })

  it('a re-seal that fails does not fail the import', async () => {
    m.reseal.mockRejectedValueOnce(new Error('Platform is busy'))
    await importFromPhrase()
    expect(host.textContent).toMatch(/encryption key 7 is stored in this browser/)
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('does not re-seal when no key was found to import', async () => {
    m.importKey.mockResolvedValueOnce(null)
    await importFromPhrase()
    expect(m.reseal).not.toHaveBeenCalled()
  })
})
