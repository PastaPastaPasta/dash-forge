// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAppConnectUri, parseAppConnectUri } from '../vendor/platform-auth/app-connect'
import {
  CALLBACK_CHANNEL,
  CALLBACK_STATUS_COPY,
  connectCallbackUrl,
  isConnectCallbackAck,
  isConnectCallbackMessage,
  listenForCallback,
  parseConnectCallback,
} from './connect-callback'
import { newV2LoginRequest } from './app-connect-v2'
import type { ForgeIds } from '../deployments'

const HASH = new Uint8Array(20).fill(0xab)
const HEX = 'ab'.repeat(20)
const SITE = 'https://forge.dashhq.org/'
const FORGE: ForgeIds = {
  core: 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1',
  collab: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS',
  community: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS',
  group: '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC',
}

afterEach(() => vi.restoreAllMocks())

describe('connectCallbackUrl', () => {
  it('points at /connect/ on the canonical site with the request hash', () => {
    expect(connectCallbackUrl(HASH, { siteUrl: SITE, origin: 'https://forge.dashhq.org', ipfs: false })).toBe(`${SITE}connect/?r=${HEX}`)
  })

  it('keeps a base path', () => {
    expect(connectCallbackUrl(HASH, { siteUrl: 'https://example.org/dash-forge/', origin: 'https://example.org', ipfs: false })).toBe(`https://example.org/dash-forge/connect/?r=${HEX}`)
  })

  it('is omitted on an IPFS build', () => {
    expect(connectCallbackUrl(HASH, { siteUrl: SITE, origin: 'https://forge.dashhq.org', ipfs: true })).toBeNull()
  })

  it('is omitted when this page is not on the canonical origin', () => {
    expect(connectCallbackUrl(HASH, { siteUrl: SITE, origin: 'https://bafy.ipfs.dweb.link', ipfs: false })).toBeNull()
    expect(connectCallbackUrl(HASH, { siteUrl: SITE, origin: null, ipfs: false })).toBeNull()
  })

  it('is omitted when the site is not https (the profile requires it)', () => {
    expect(connectCallbackUrl(HASH, { siteUrl: 'http://localhost:3000/', origin: 'http://localhost:3000', ipfs: false })).toBeNull()
  })

  it('rides on the request as cb, and only on the link', () => {
    const req = newV2LoginRequest('devnet', FORGE, {
      connectionId: new Uint8Array(16).fill(1),
      chainNow: 1_700_000_000_000,
      callbackUrl: (h) => connectCallbackUrl(h, { siteUrl: SITE, origin: 'https://forge.dashhq.org', ipfs: false }),
    })
    expect(parseAppConnectUri(req.qrUri).callbackUrl).toBeUndefined()
    const link = parseAppConnectUri(req.linkUri).callbackUrl
    expect(link).toMatch(/^https:\/\/forge\.dashhq\.org\/connect\/\?r=[0-9a-f]{40}$/)
    expect(link?.endsWith(Buffer.from(req.requestHash).toString('hex'))).toBe(true)
    expect(req.linkUri).toBe(buildAppConnectUri(req.request, 'devnet', link))
  })
})

describe('parseConnectCallback', () => {
  it('reads the request hash and status', () => {
    expect(parseConnectCallback(`?r=${HEX}&ac=ok`)).toEqual({ requestHash: HEX, status: 'ok' })
    expect(parseConnectCallback(`?ac=declined&r=${HEX.toUpperCase()}`)).toEqual({ requestHash: HEX, status: 'declined' })
    expect(parseConnectCallback(`?r=${HEX}`)).toEqual({ requestHash: HEX, status: null })
  })

  it('refuses anything that is not a request hash', () => {
    expect(parseConnectCallback('')).toBeNull()
    expect(parseConnectCallback('?r=not-a-hash&ac=ok')).toBeNull()
    expect(parseConnectCallback(`?r=${HEX}00`)).toBeNull()
  })

  it('drops a status of the wrong shape', () => {
    expect(parseConnectCallback(`?r=${HEX}&ac=<script>`)).toEqual({ requestHash: HEX, status: null })
    expect(parseConnectCallback(`?r=${HEX}&ac=averyveryverylongstatus`)).toEqual({ requestHash: HEX, status: null })
  })

  it('has words for every status the profile defines besides ok', () => {
    for (const s of ['declined', 'stale', 'unsupported', 'invalid', 'failed']) expect(CALLBACK_STATUS_COPY[s]?.title).toBeTruthy()
    expect(CALLBACK_STATUS_COPY['ok']).toBeUndefined()
  })
})

describe('messages', () => {
  it('recognises only well-formed messages', () => {
    expect(isConnectCallbackMessage({ type: 'forge-app-connect-callback', requestHash: HEX, status: 'ok' })).toBe(true)
    expect(isConnectCallbackMessage({ type: 'forge-app-connect-callback', requestHash: HEX, status: null })).toBe(true)
    expect(isConnectCallbackMessage({ type: 'forge-app-connect-callback', requestHash: HEX, status: 7 })).toBe(false)
    expect(isConnectCallbackMessage({ type: 'forge-app-connect-callback', requestHash: 'zz', status: 'ok' })).toBe(false)
    expect(isConnectCallbackMessage({ type: 'app-connect-callback', requestHash: HEX })).toBe(false)
    expect(isConnectCallbackMessage(null)).toBe(false)
    expect(isConnectCallbackAck({ type: 'forge-app-connect-ack', requestHash: HEX }, HEX)).toBe(true)
    expect(isConnectCallbackAck({ type: 'forge-app-connect-ack', requestHash: HEX }, 'cd'.repeat(20))).toBe(false)
  })
})

describe('listenForCallback', () => {
  it('gives no nudge, and does not throw, where the browser refuses a channel', () => {
    const original = globalThis.BroadcastChannel
    globalThis.BroadcastChannel = class {
      constructor() {
        throw new DOMException('opaque origin', 'SecurityError')
      }
    } as unknown as typeof BroadcastChannel
    try {
      expect(() => listenForCallback(HASH, vi.fn())()).not.toThrow()
    } finally {
      globalThis.BroadcastChannel = original
    }
  })

  /** A channel pair on the real (jsdom/node) BroadcastChannel: the "return page" side. */
  function page(): { channel: BroadcastChannel; got: unknown[] } {
    const channel = new BroadcastChannel(CALLBACK_CHANNEL)
    const got: unknown[] = []
    channel.onmessage = (e: MessageEvent) => got.push(e.data)
    return { channel, got }
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

  it('acks and nudges for its own request', async () => {
    const nudge = vi.fn()
    const stop = listenForCallback(HASH, nudge)
    const { channel, got } = page()
    channel.postMessage({ type: 'forge-app-connect-callback', requestHash: HEX, status: 'ok' })
    await tick()
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenCalledWith('ok')
    expect(got).toContainEqual({ type: 'forge-app-connect-ack', requestHash: HEX })
    stop()
    channel.close()
  })

  it('ignores another request and malformed messages', async () => {
    const nudge = vi.fn()
    const stop = listenForCallback(HASH, nudge)
    const { channel, got } = page()
    channel.postMessage({ type: 'forge-app-connect-callback', requestHash: 'cd'.repeat(20), status: 'ok' })
    channel.postMessage({ nope: true })
    await tick()
    expect(nudge).not.toHaveBeenCalled()
    expect(got).toEqual([])
    stop()
    channel.close()
  })

  it('stops listening once stopped', async () => {
    const nudge = vi.fn()
    listenForCallback(HASH, nudge)()
    const { channel } = page()
    channel.postMessage({ type: 'forge-app-connect-callback', requestHash: HEX, status: null })
    await tick()
    expect(nudge).not.toHaveBeenCalled()
    channel.close()
  })
})
