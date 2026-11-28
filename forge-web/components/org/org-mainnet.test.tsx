// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

vi.mock('@/lib/constants', async (orig) => {
  const real = await orig<typeof import('@/lib/constants')>()
  return { ...real, DEFAULT_NETWORK: 'mainnet', ACTIVE_NETWORK: real.NETWORKS.mainnet }
})
const auth = vi.hoisted(() => ({ identity: null as string | null }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: auth.identity, signer: null }) }))
const sdkCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('@/lib/sdk', async (orig) => {
  const real = await orig<typeof import('@/lib/sdk')>()
  return {
    ...real,
    ensureSdk: async (...args: Parameters<typeof real.ensureSdk>) => {
      sdkCalls.count++
      return real.ensureSdk(...args)
    },
  }
})

const { ORGS_ON, useOrgPoller, useOrgsStore } = await import('@/hooks/use-orgs')
const { OrgClient, NOT_ON_MAINNET } = await import('@/app/org/client')
const { NeedsSignature } = await import('./needs-signature')
const { OwnerChip, OrgConnectNote } = await import('./owner-chip')
const { NETWORKS } = await import('@/lib/constants')

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

it('on mainnet, signed in: no forge-org contract, no organization reads or writes, and repo pages show no organization chrome', async () => {
  expect(NETWORKS.mainnet.v2?.org).toBeUndefined()
  auth.identity = 'Member1111111111111111111111111111111111111'
  sdkCalls.count = 0
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() =>
    root.render(
      <>
        <Poller />
        <NeedsSignature />
        <OwnerChip ownerId="Org1111111111111111111111111111111111111111" />
        <OrgConnectNote ownerId="Org1111111111111111111111111111111111111111" />
      </>,
    ),
  )
  await act(async () => Promise.resolve())
  expect(host.textContent).toBe('')
  expect(sdkCalls.count).toBe(0)
  expect(fetchSpy.mock.calls.map(([url]) => String(url)).filter((u) => !u.endsWith('.wasm'))).toEqual([])
  expect(useOrgsStore.getState().views).toEqual({})
  act(() => root.unmount())
  vi.unstubAllGlobals()
  auth.identity = null
})
