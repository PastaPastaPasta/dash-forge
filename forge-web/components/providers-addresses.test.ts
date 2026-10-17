import { afterEach, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env['NEXT_PUBLIC_NETWORK'] = 'devnet'
  process.env['NEXT_PUBLIC_DEVNET_NAME'] = 'sakura'
})
const gate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/sdk/budget', () => ({ installDapiFetchGate: gate }))
vi.mock('@/contexts/auth-context', () => ({ AuthProvider: () => null }))
vi.mock('@/hooks/use-inbox', () => ({ InboxPoller: () => null }))
vi.mock('@/lib/prehydration', () => ({ stopPrehydrationCatcher: vi.fn() }))
vi.mock('@/lib/hash-links', () => ({ installHashLinkHistory: vi.fn() }))
vi.mock('@/hooks/use-route', () => ({ installSamePageLinks: vi.fn() }))

afterEach(() => {
  vi.doUnmock('@/lib/constants')
  vi.resetModules()
  gate.mockClear()
})

it.each(['testnet', 'mainnet', 'devnet'] as const)('installs the %s gate with read endpoints before SDK connection', async (network) => {
  const actual = await import('@/lib/constants')
  vi.doMock('@/lib/constants', () => ({ ...actual, DEFAULT_NETWORK: network }))
  await import('./providers')
  expect(gate).toHaveBeenCalledOnce()
  expect(gate).toHaveBeenCalledWith(network === 'mainnet' ? [] : actual.NETWORKS[network].dapiAddresses)
  if (network === 'mainnet') expect(actual.NETWORKS.mainnet.dapiAddresses).toHaveLength(10)
})
