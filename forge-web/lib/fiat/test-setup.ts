import { afterEach, expect } from 'vitest'
import { FIAT_PROVIDER_HOSTS } from './providers'
import { __setFiatFetchForTests } from './store'

__setFiatFetchForTests(async () => { throw new Error('Fiat network disabled in tests') })

// No test may escape its mocks to a real network, including jsdom component subscriptions.
const providerRequests: string[] = []
globalThis.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input)
  try {
    if (FIAT_PROVIDER_HOSTS.some((host) => new URL(url).hostname === host)) providerRequests.push(url)
  } catch { /* Relative fixture URLs are also blocked. */ }
  throw new Error(`Unmocked network request in test: ${url}`)
}
afterEach(() => {
  const requests = providerRequests.splice(0)
  expect(requests, 'Fiat provider requests must use __setFiatFetchForTests').toEqual([])
})
