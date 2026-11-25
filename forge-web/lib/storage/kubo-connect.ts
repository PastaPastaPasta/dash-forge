/** One-time pairing with dg's loopback proxy. Credentials stay in memory until confirmed. */
import { z } from 'zod'
import { servedCid } from '../build-info'
import { profileProblem, validProfileName, type StorageProfile } from './profiles'
import { whyBlocked } from './probe'

export interface KuboCode { readonly port: number; readonly code: string }
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/i

export function parseKuboCode(code: string, port: number): KuboCode | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !CODE.test(code)) return null
  const letters = code.toUpperCase().replace(/-/g, '')
  return { port, code: `${letters.slice(0, 4)}-${letters.slice(4, 8)}-${letters.slice(8)}` }
}

export function parseKuboFragment(hash: string): KuboCode | null {
  const m = /^#kubo=([0-9]{1,5})\.([^\s]+)$/.exec(hash)
  return m ? parseKuboCode(m[2]!, Number(m[1])) : null
}

export function isSafari(agent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /Safari\//.test(agent) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|OPiOS|Android/.test(agent)
}

export function safariNeedsNotice(origin: string): boolean {
  let url: URL
  try { url = new URL(origin) } catch { return false }
  return isSafari() && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
}

export const SAFARI_NOTICE = "Safari can't reach a node on this computer from a secure site. Use dg to push, or Chrome, Firefox or Brave."
export const LOCAL_ACCESS_HINT = 'Your browser may ask to let this site reach apps on this device. Allow it.'

/** Only literal loopback origins; URL normalization must not turn an alias or path into one. */
const loopbackOrigin = z.string().refine((v) => {
  const m = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(v)
  return m !== null && Number(m[1]) > 0 && Number(m[1]) <= 65535
})
const pairResponse = z.object({
  name: z.string().refine(validProfileName),
  api: loopbackOrigin,
  gateway: loopbackOrigin,
  auth: z.string().regex(/^Bearer [A-Za-z0-9_-]{32,128}$/),
  peerId: z.string().max(256),
  version: z.string().max(128),
}).strict()

export interface PairedNode { readonly profile: StorageProfile; readonly peerId: string; readonly version: string }

export function validatePairResponse(value: unknown): PairedNode {
  const parsed = pairResponse.safeParse(value)
  // Do not surface zod's errors: they may quote a credential.
  if (!parsed.success) throw new Error('The node returned invalid connection settings. Run dg ipfs connect again.')
  const p = parsed.data
  const profile: StorageProfile = {
    name: p.name,
    settings: { kind: 'ipfs-kubo', provider: 'kubo', api: p.api, gateway: p.gateway, publicGateway: '', pinningEndpoint: '' },
    secrets: { apiAuth: p.auth },
  }
  if (profileProblem(profile)) throw new Error('The node returned invalid connection settings. Run dg ipfs connect again.')
  return { profile, peerId: p.peerId, version: p.version }
}

export type LoopbackAccess = PermissionState | 'unknown'

/** The browser's local-network permission for this site, where the browser has one. */
export async function loopbackAccess(): Promise<LoopbackAccess> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown'
  for (const name of ['loopback-network', 'local-network-access']) {
    try { return (await navigator.permissions.query({ name } as unknown as PermissionDescriptor)).state } catch { /* not this browser's name */ }
  }
  return 'unknown'
}

const FORGE_ORIGINS = ['https://forge.dashhq.org', 'https://testnet-forge.dashhq.org']
export const PERMISSION_ASK = 'Your browser is asking to let this site reach apps on this device. Choose Allow.'
const PERMISSION_DENIED = "Your browser isn't letting this site reach apps on this device. Allow it in this site's settings (the icon left of the address), then press Connect."
const PERMISSION_DISMISSED = 'This site needs your OK to reach the node on this computer. Press Connect, then choose Allow.'
const NOT_RUNNING = "The IPFS node on this computer isn't running. Run dg ipfs up, then press Connect."

function notAllowedHere(origin: string): string {
  return FORGE_ORIGINS.includes(origin)
    ? "The node on this computer doesn't accept this site yet. Update dg, run dg ipfs up, then press Connect."
    : `The node on this computer doesn't accept this site. Run ${kuboUpCommand(origin, '/') ?? 'dg ipfs up'}, then press Connect.`
}

/**
 * Swap a one-time code for the node's settings. A first visit makes the browser ask before the
 * page may reach this computer, and the request waits on that prompt. A timeout runs only once
 * access is known to be granted, so a late Allow is never mistaken for the node refusing this site.
 */
export async function pairWithNode(input: KuboCode, onAsk?: () => void): Promise<PairedNode> {
  const parsed = parseKuboCode(input.code, input.port)
  if (!parsed) throw new Error('Enter a code like XXXX-XXXX-XXXX and a port from 1 to 65535.')
  const url = `http://127.0.0.1:${parsed.port}/dash-forge/pair`
  const before = await loopbackAccess()
  if (before === 'denied') throw new Error(PERMISSION_DENIED)
  if (before === 'prompt') onAsk?.()
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: parsed.code }),
      credentials: 'omit', redirect: 'error', targetAddressSpace: 'loopback',
      ...(before === 'granted' ? { signal: AbortSignal.timeout(15_000) } : {}),
    } as RequestInit)
  } catch {
    if (isSafari() && safariNeedsNotice(location.origin)) throw new Error(SAFARI_NOTICE)
    const after = await loopbackAccess()
    if (after === 'denied') throw new Error(PERMISSION_DENIED)
    if (after === 'prompt') throw new Error(PERMISSION_DISMISSED)
    throw new Error((await whyBlocked(url)) === 'down' ? NOT_RUNNING : notAllowedHere(location.origin))
  }
  if (response.status === 403) throw new Error("That code isn't right. Check it against what dg printed and try again (five tries).")
  if (response.status === 410) throw new Error('This code expired or was already used. Codes work once, for 10 minutes. Run dg ipfs connect for a new one.')
  if (!response.ok) throw new Error(`The node could not connect (HTTP ${response.status}). Run dg ipfs connect again.`)
  let value: unknown
  try { value = await response.json() } catch { throw new Error('The node returned invalid connection settings. Run dg ipfs connect again.') }
  const node = validatePairResponse(value)
  if (Number(new URL((node.profile.settings as { api: string }).api).port || 80) !== parsed.port) throw new Error('The node returned a different API port. Run dg ipfs connect again.')
  return node
}

export function kuboUpCommand(origin: string, pathname: string): string | null {
  let url: URL
  try { url = new URL(origin) } catch { return null }
  if (servedCid({ protocol: url.protocol, hostname: url.hostname, pathname }) || /^\/(ipfs|ipns)\//.test(pathname) || /\.(ipfs|ipns)\./i.test(url.hostname)) return null
  return FORGE_ORIGINS.includes(origin) ? 'dg ipfs up' : `dg ipfs up --origin '${origin.replace(/'/g, "'\\''")}'`
}
