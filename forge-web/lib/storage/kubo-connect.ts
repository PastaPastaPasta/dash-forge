/** One-time pairing with dg's loopback proxy. Credentials stay in memory until confirmed. */
import { z } from 'zod'
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

export async function pairWithNode(input: KuboCode): Promise<PairedNode> {
  const parsed = parseKuboCode(input.code, input.port)
  if (!parsed) throw new Error('Enter a code like XXXX-XXXX-XXXX and a port from 1 to 65535.')
  const url = `http://127.0.0.1:${parsed.port}/dash-forge/pair`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: parsed.code }),
      credentials: 'omit', redirect: 'error', targetAddressSpace: 'loopback', signal: AbortSignal.timeout(15_000),
    } as RequestInit)
  } catch {
    if (isSafari()) throw new Error(SAFARI_NOTICE)
    const why = await whyBlocked(url)
    throw new Error(why === 'down'
      ? `The node is not running, or your browser blocked it. Run dg ipfs up. ${LOCAL_ACCESS_HINT}`
      : `The node blocked this site. Run dg ipfs up --origin ${location.origin}. ${LOCAL_ACCESS_HINT}`)
  }
  if (response.status === 403) throw new Error('Wrong code. Check it and try again (five tries maximum).')
  if (response.status === 410) throw new Error('This code expired or was already used. Run dg ipfs connect for a new one.')
  if (!response.ok) throw new Error(`The node could not connect (HTTP ${response.status}). Run dg ipfs connect again.`)
  let value: unknown
  try { value = await response.json() } catch { throw new Error('The node returned invalid connection settings. Run dg ipfs connect again.') }
  return validatePairResponse(value)
}

export function kuboUpCommand(origin: string, pathname: string): string | null {
  if (/^\/(ipfs|ipns)\//.test(pathname)) return null
  return origin === 'https://forge.dashhq.org' ? 'dg ipfs up' : `dg ipfs up --origin '${origin.replace(/'/g, "'\\''")}'`
}
