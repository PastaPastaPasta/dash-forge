import { describe, expect, it } from 'vitest'

import { buildNetworkKey, checkGatewayNetwork } from './check-gateway-network.mjs'

const GW = 'https://git-forge.example'
const answering = (body: unknown) => async (url: RequestInfo | URL) => {
  expect(String(url)).toBe(`${GW}/readyz`)
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('buildNetworkKey', () => {
  it('resolves like lib/constants.ts', () => {
    expect(buildNetworkKey({})).toBe('testnet')
    expect(buildNetworkKey({ NEXT_PUBLIC_NETWORK: 'mainnet' })).toBe('mainnet')
    expect(buildNetworkKey({ NEXT_PUBLIC_NETWORK: 'Mainnet ' })).toBe('mainnet')
    expect(buildNetworkKey({ NEXT_PUBLIC_DEVNET_NAME: 'sakura' })).toBe('devnet-sakura')
    expect(buildNetworkKey({ NEXT_PUBLIC_NETWORK: 'devnet', NEXT_PUBLIC_DEVNET_NAME: 'sakura' })).toBe('devnet-sakura')
  })
})

describe('checkGatewayNetwork', () => {
  it('fails a mainnet build that still points at a testnet gateway', async () => {
    const r = await checkGatewayNetwork({ NEXT_PUBLIC_NETWORK: 'mainnet', NEXT_PUBLIC_GATEWAY_URL: `${GW}/` }, answering({ status: 'ok', network: 'testnet' }))
    expect(r.level).toBe('error')
    expect(r.message).toContain('serves testnet, but this build is for mainnet')
  })

  it('passes a gateway on the build network', async () => {
    expect((await checkGatewayNetwork({ NEXT_PUBLIC_GATEWAY_URL: GW }, answering({ network: 'testnet' }))).level).toBe('ok')
    expect(
      (await checkGatewayNetwork({ NEXT_PUBLIC_DEVNET_NAME: 'sakura', NEXT_PUBLIC_GATEWAY_URL: GW }, answering({ network: 'devnet-sakura' }))).level,
    ).toBe('ok')
  })

  it('reads a degraded gateway (503) the same way', async () => {
    const degraded = async () => new Response(JSON.stringify({ status: 'degraded', network: 'testnet' }), { status: 503 })
    expect((await checkGatewayNetwork({ NEXT_PUBLIC_NETWORK: 'mainnet', NEXT_PUBLIC_GATEWAY_URL: GW }, degraded)).level).toBe('error')
  })

  it('skips a build with no gateway', async () => {
    const never = async () => {
      throw new Error('no request expected')
    }
    expect((await checkGatewayNetwork({ NEXT_PUBLIC_NETWORK: 'mainnet' }, never)).level).toBe('ok')
    expect((await checkGatewayNetwork({ NEXT_PUBLIC_GATEWAY_URL: ' ' }, never)).level).toBe('ok')
  })

  it('only warns when the gateway cannot be read or does not say', async () => {
    const down = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect((await checkGatewayNetwork({ NEXT_PUBLIC_GATEWAY_URL: GW }, down)).level).toBe('warning')
    expect((await checkGatewayNetwork({ NEXT_PUBLIC_GATEWAY_URL: GW }, async () => new Response('ok\n'))).level).toBe('warning')
    expect((await checkGatewayNetwork({ NEXT_PUBLIC_GATEWAY_URL: GW }, answering({ status: 'ok' }))).level).toBe('warning')
  })
})
