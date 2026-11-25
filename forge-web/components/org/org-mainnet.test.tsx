// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

vi.mock('@/lib/constants', async (orig) => {
  const real = await orig<typeof import('@/lib/constants')>()
  return { ...real, DEFAULT_NETWORK: 'mainnet', ACTIVE_NETWORK: real.NETWORKS.mainnet }
})
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: null }) }))

const { ORGS_ON, useOrgPoller, useOrgsStore } = await import('@/hooks/use-orgs')
const { OrgClient, NOT_ON_MAINNET } = await import('@/app/org/client')
const { NeedsSignature } = await import('./needs-signature')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Poller(): null {
  useOrgPoller()
  return null
}

it('on mainnet: no organization page, no inbox section, no polling', async () => {
  expect(ORGS_ON).toBe(false)
  localStorage.setItem('forge:orgs:mainnet', JSON.stringify([{ network: 'mainnet', orgId: 'Org1', room: 'm_000102030405060708090a0b0c0d0e0f', relay: 'https://multisig.dashhq.org', authPub: 'a'.repeat(64), label: 'Acme', threshold: 2, members: [] }]))
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() =>
    root.render(
      <>
        <Poller />
        <OrgClient />
        <NeedsSignature />
      </>,
    ),
  )
  await act(async () => Promise.resolve())
  expect(host.textContent).toBe(NOT_ON_MAINNET)
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(useOrgsStore.getState().polling).toBe(false)
  act(() => root.unmount())
  vi.unstubAllGlobals()
})
