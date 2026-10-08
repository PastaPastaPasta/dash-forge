// @vitest-environment jsdom
/**
 * A DPNS name that one failed read hid shows up later (the address bar, Copy link and the header's
 * chip must not stay on the identity id for the rest of the tab), and Copy link reads the name for
 * the identity the owner names, however the route wrote it.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'

const sdk = vi.hoisted(() => ({ marker: 'sdk' }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk, ready: true, network: 'devnet' }) }))
const query = vi.hoisted(() => vi.fn())
vi.mock('@/lib/sdk', () => ({ queryDocuments: query }))
const resolveOwner = vi.hoisted(() => vi.fn())
vi.mock('@/lib/repo', () => ({ resolveOwner }))

import { clearDpnsCache, DPNS_FAILURE_TTL_MS } from '@/lib/view/dpns'
import { useOwnerDpnsName, useSettledDpnsName } from './use-dpns-name'

const domain = { label: 'alice', normalizedParentDomainName: 'dash', records: { identity: ID } }

let root: Root
let el: HTMLDivElement
let seen: { settled: string | null | undefined; owner: string | undefined }
/** One reader per probe: `owner` empty reads the id's name, else the name of the owner as written. */
function Probe({ owner }: { owner: string }): null {
  const settled = useSettledDpnsName(owner === '' ? ID : '')
  const named = useOwnerDpnsName(owner)
  seen = { settled, owner: named }
  return null
}
const mount = (owner: string): Promise<void> => act(async () => root.render(<Probe owner={owner} />))
/** Let pending reads settle (and `ms` of the clock pass). */
const settle = (ms = 0): Promise<void> => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  clearDpnsCache()
  query.mockReset()
  resolveOwner.mockReset()
  el = document.createElement('div')
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
})

describe('useSettledDpnsName after a failed read', () => {
  it('answers none for now, then reads again and shows the name', async () => {
    query.mockRejectedValueOnce(new Error('down')).mockResolvedValue([domain])
    await mount('')
    await settle()
    expect(seen.settled).toBeNull()
    expect(query).toHaveBeenCalledTimes(1)
    // Not for the life of the tab: after the failure's lifetime, the same page reads again.
    await settle(DPNS_FAILURE_TTL_MS + 100)
    expect(query).toHaveBeenCalledTimes(2)
    expect(seen.settled).toBe('alice.dash')
  })

  it('does not read again once the owner is proven nameless', async () => {
    query.mockResolvedValue([])
    await mount('')
    await settle(DPNS_FAILURE_TTL_MS * 3)
    expect(seen.settled).toBeNull()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('gives up after a few tries', async () => {
    query.mockRejectedValue(new Error('down'))
    await mount('')
    // React renders between acts: one failure's lifetime at a time.
    for (let i = 0; i < 20; i++) await settle(DPNS_FAILURE_TTL_MS + 100)
    expect(seen.settled).toBeNull()
    expect(query).toHaveBeenCalledTimes(6)
  })
})

describe('a mounted reader handed another identity', () => {
  it('starts its retries over', async () => {
    const OTHER = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
    query.mockRejectedValue(new Error('down'))
    function Other({ id }: { id: string }): null {
      seen = { settled: useSettledDpnsName(id), owner: undefined }
      return null
    }
    await act(async () => root.render(<Other id={ID} />))
    for (let i = 0; i < 20; i++) await settle(DPNS_FAILURE_TTL_MS + 100)
    expect(query).toHaveBeenCalledTimes(6)
    await act(async () => root.render(<Other id={OTHER} />))
    for (let i = 0; i < 20; i++) await settle(DPNS_FAILURE_TTL_MS + 100)
    expect(query).toHaveBeenCalledTimes(12)
  })
})

describe('useOwnerDpnsName: the name of the identity the owner names', () => {
  beforeEach(() => query.mockResolvedValue([domain]))

  it('reads an identity id as it is', async () => {
    await mount(ID)
    await settle()
    expect(seen.owner).toBe('alice.dash')
    expect(resolveOwner).not.toHaveBeenCalled()
  })

  it('finds it from the name the route was opened with, in any case', async () => {
    resolveOwner.mockResolvedValue(ID)
    await mount('Alice.DASH')
    await settle()
    expect(resolveOwner).toHaveBeenCalledWith(sdk, 'Alice.DASH')
    expect(seen.owner).toBe('alice.dash')
  })

  it('has no name for an owner that does not resolve', async () => {
    resolveOwner.mockResolvedValue(null)
    await mount('nobody')
    await settle()
    expect(seen.owner).toBeUndefined()
  })
})
