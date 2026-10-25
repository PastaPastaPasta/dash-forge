/**
 * The wallet's return trip after an App Connect v2 approval (`APP_CONNECT_PROFILE.md`, "Callback").
 *
 * The phone deep link carries `cb=<site>/connect/?r=<request hash>`; the wallet opens it with
 * `ac=<status>` appended once it is done. The `/connect` page (a static page, no state of its
 * own) tells the tab that showed the code over a same-origin BroadcastChannel, and that tab polls
 * at once. If no tab answers within {@link ACK_WAIT_MS}, the page says what the wallet reported
 * and sends the user back to the tab where they started: the ephemeral key lives in that tab's
 * memory only, so nothing can continue on this page.
 *
 * Nothing here is trusted: the callback is a nudge. The poll and the on-chain checks decide.
 */

import { bytesToHex } from '@noble/hashes/utils.js'

import { SITE_URL } from '../site'

/** The channel the return page and the waiting tab talk on (same origin only). */
export const CALLBACK_CHANNEL = 'forge-app-connect'

/** How long the return page waits for the tab that showed the code to answer. */
export const ACK_WAIT_MS = 1500

/** The return page to the waiting tab: the wallet came back for this request. */
export interface ConnectCallbackMessage {
  readonly type: 'forge-app-connect-callback'
  readonly requestHash: string
  readonly status: string | null
}

/** The waiting tab to the return page: it polls now, nothing more to do here. */
export interface ConnectCallbackAck {
  readonly type: 'forge-app-connect-ack'
  readonly requestHash: string
}

/** `hash160(appEphPub)` as 40 lowercase hex digits. */
const REQUEST_HASH = /^[0-9a-f]{40}$/

export function isConnectCallbackMessage(value: unknown): value is ConnectCallbackMessage {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  return m['type'] === 'forge-app-connect-callback' && typeof m['requestHash'] === 'string' && REQUEST_HASH.test(m['requestHash']) && (m['status'] === null || typeof m['status'] === 'string')
}

export function isConnectCallbackAck(value: unknown, requestHash: string): value is ConnectCallbackAck {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  return m['type'] === 'forge-app-connect-ack' && m['requestHash'] === requestHash
}

export interface ConnectCallback {
  readonly requestHash: string
  /** The wallet's `ac` status, when it sent one in the shape the profile allows. */
  readonly status: string | null
}

/** The callback in a page's query string, or null when it is not a well-formed one. */
export function parseConnectCallback(search: string): ConnectCallback | null {
  const params = new URLSearchParams(search)
  const requestHash = (params.get('r') ?? '').toLowerCase()
  if (!REQUEST_HASH.test(requestHash)) return null
  const ac = params.get('ac')
  return { requestHash, status: ac !== null && /^[a-z]{1,16}$/.test(ac) ? ac : null }
}

/**
 * What the return page tells the user for each status the profile defines. `ok` and an unknown
 * status say the same thing: the approval is being checked in the other tab.
 */
export const CALLBACK_STATUS_COPY: Readonly<Record<string, { readonly title: string; readonly body: string }>> = {
  declined: { title: 'Sign-in declined', body: 'You declined it in your wallet. Nothing was changed.' },
  stale: { title: 'That code expired', body: 'Go back to Forge and start again for a fresh code.' },
  unsupported: { title: "Your wallet can't answer this yet", body: 'Update your Dash wallet, then try again, or use the older code.' },
  invalid: { title: "Your wallet couldn't use this request", body: 'Go back to Forge and start again for a fresh code.' },
  failed: { title: "Your wallet couldn't finish", body: 'It approved, but adding the key failed. Go back to Forge and start again.' },
}

/**
 * The deep link's `cb` for a request, or null when none can work: not an https site, an IPFS
 * build, or a page served from another origin than {@link SITE_URL} (BroadcastChannel reaches
 * same-origin tabs only, so a callback to the canonical site could never find this one).
 */
export function connectCallbackUrl(
  requestHash: Uint8Array,
  where: { readonly siteUrl?: string; readonly origin?: string | null; readonly ipfs?: boolean } = {},
): string | null {
  const ipfs = where.ipfs ?? process.env.FORGE_IPFS_BUILD === '1'
  if (ipfs) return null
  let origin = where.origin
  if (origin === undefined) origin = typeof location === 'undefined' ? null : location.origin
  let site: URL
  try {
    site = new URL(where.siteUrl ?? SITE_URL)
  } catch {
    return null
  }
  if (site.protocol !== 'https:' || origin !== site.origin) return null
  const url = new URL('connect/', site.href.endsWith('/') ? site.href : `${site.href}/`)
  url.searchParams.set('r', bytesToHex(requestHash))
  return url.href
}

/**
 * In the tab that shows the code: call `onNudge` (with the wallet's `ac` status, when it sent
 * one) when the wallet's return page reports this request, after telling that page to stand
 * down. Returns the stop function. A browser without BroadcastChannel (or one that refuses it, as
 * an opaque origin does) just gets no nudge: the poll and the focus event still run.
 */
export function listenForCallback(requestHash: Uint8Array, onNudge: (status: string | null) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined
  let channel: BroadcastChannel
  try {
    channel = new BroadcastChannel(CALLBACK_CHANNEL)
  } catch {
    return () => undefined
  }
  const hash = bytesToHex(requestHash)
  channel.onmessage = (event: MessageEvent) => {
    if (!isConnectCallbackMessage(event.data) || event.data.requestHash !== hash) return
    const ack: ConnectCallbackAck = { type: 'forge-app-connect-ack', requestHash: hash }
    channel.postMessage(ack)
    onNudge(event.data.status)
  }
  return () => channel.close()
}
