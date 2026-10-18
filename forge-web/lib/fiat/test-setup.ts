import { afterEach, expect } from 'vitest'
import { FIAT_PROVIDER_HOSTS } from './providers'
import { __setFiatFetchForTests } from './store'

__setFiatFetchForTests(async () => { throw new Error('Fiat network disabled in tests') })

// No test may reach a price provider, including jsdom component subscriptions. Every other request
// passes through: the drills and live tests fetch local infrastructure and Platform for real.
const providerRequests: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  let host = ''
  try {
    host = new URL(url).hostname
  } catch { /* A relative URL is never a provider. */ }
  if (FIAT_PROVIDER_HOSTS.some((h) => h === host)) {
    providerRequests.push(url)
    throw new Error(`Price provider request in a test: ${url}`)
  }
  return realFetch(input, init)
}
afterEach(() => {
  const requests = providerRequests.splice(0)
  expect(requests, 'Fiat provider requests must use __setFiatFetchForTests').toEqual([])
})
