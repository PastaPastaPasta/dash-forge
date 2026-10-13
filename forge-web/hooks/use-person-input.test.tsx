// @vitest-environment jsdom
/** The member fields' lookup: an id needs none, a name waits for typing to pause, a failed read can be retried. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '@/lib/auth/base58'

const resolve = vi.fn<(sdk: unknown, names: readonly string[], network: string) => Promise<Map<string, string | null>>>()
// a failed read is a plain throw here: a rejecting vi.fn leaves a rejection vitest reports as unhandled
let failRead = false
vi.mock('@/lib/view/dpns', async (orig) => ({
  ...(await orig<typeof import('@/lib/view/dpns')>()),
  resolveDpnsIds: async (...a: Parameters<typeof resolve>) => {
    if (failRead) throw new Error('network down')
    return resolve(...a)
  },
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))

import { usePersonInput, type PersonInputState } from './use-person-input'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ALICE = base58Encode(new Uint8Array(32).fill(2))

let root: Root
let host: HTMLDivElement
let state: PersonInputState
function Probe({ text }: { text: string }): null {
  state = usePersonInput(text)
  return null
}
const show = (text: string): void => act(() => root.render(<Probe text={text} />))
const advance = (ms: number): Promise<void> => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

beforeEach(() => {
  vi.useFakeTimers()
  resolve.mockReset()
  failRead = false
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('usePersonInput', () => {
  it('takes an id at once, without a lookup', () => {
    show(ALICE)
    expect(state).toMatchObject({ id: ALICE, name: null, error: null, resolving: false })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('waits for typing to pause, then resolves the name', async () => {
    resolve.mockResolvedValue(new Map([['alice.dash', ALICE]]))
    show('ali')
    show('alice')
    expect(state).toMatchObject({ id: null, resolving: true })
    await advance(200)
    expect(resolve).not.toHaveBeenCalled()
    await advance(400)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(state).toMatchObject({ id: ALICE, name: 'alice.dash', error: null, resolving: false })
  })

  it('refuses an unknown name, and gives no id while the text changes', async () => {
    resolve.mockResolvedValue(new Map([['nobody.dash', null]]))
    show('nobody.dash')
    await advance(500)
    expect(state).toMatchObject({ id: null, error: 'No DPNS name nobody.dash was found.', retry: null })
    show('nobody.das')
    expect(state.id).toBeNull()
  })

  it('offers a retry after a failed read, and the retry resolves', async () => {
    failRead = true
    show('alice.dash')
    await advance(500)
    expect(state.error).toBe("Couldn't look that name up. Try again.")
    expect(state.retry).not.toBeNull()
    failRead = false
    resolve.mockResolvedValue(new Map([['alice.dash', ALICE]]))
    await act(async () => {
      state.retry?.()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(state).toMatchObject({ id: ALICE, error: null, retry: null })
  })
})
