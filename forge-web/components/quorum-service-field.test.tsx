// @vitest-environment jsdom
/** Settings → Quorum service: a typed URL is checked before it is saved, and saving reloads. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ACTIVE_NETWORK } from '@/lib/constants'
import { userQuorumUrl } from '@/lib/quorum-url'

const probe = vi.fn<(url: string) => Promise<void>>()
class QuorumProbeError extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}
vi.mock('@/lib/view', () => ({ probeQuorumService: (url: string) => probe(url), QuorumProbeError }))

const { QuorumServiceField } = await import('./quorum-service-field')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const reload = vi.fn()
beforeEach(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<QuorumServiceField reload={reload} />))
  await act(async () => {})
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  localStorage.clear()
  probe.mockReset()
  reload.mockReset()
})

async function submit(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('#quorum-service-url')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('QuorumServiceField', () => {
  it('shows the network default until one is chosen', () => {
    expect(host.querySelector('[data-testid="quorum-service-current"]')!.textContent).toMatch(/^https:\/\/quorums\./)
    expect(host.textContent).toContain('Default')
  })

  it('saves a service that answers, then reloads', async () => {
    probe.mockResolvedValue()
    await submit('https://quorums.example.org/')
    expect(probe).toHaveBeenCalledWith('https://quorums.example.org')
    expect(userQuorumUrl(ACTIVE_NETWORK.key)).toBe('https://quorums.example.org')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('keeps the current service when the new one does not answer', async () => {
    probe.mockRejectedValue(new Error('HTTP 404'))
    await submit('https://typo.example.org')
    expect(userQuorumUrl(ACTIVE_NETWORK.key)).toBeNull()
    expect(reload).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("didn't answer")
  })

  it('names another network\'s service as such', async () => {
    probe.mockRejectedValue(new QuorumProbeError('other-network'))
    await submit('https://quorums.testnet.networks.dash.org')
    expect(userQuorumUrl(ACTIVE_NETWORK.key)).toBeNull()
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('another network')
  })

  it('says so when the browser will not keep the setting', async () => {
    probe.mockResolvedValue()
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    await submit('https://quorums.example.org')
    spy.mockRestore()
    expect(reload).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('blocks saved settings')
  })

  it('refuses a plain-http URL without asking it', async () => {
    await submit('http://quorums.example.org')
    expect(probe).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('https')
  })
})
