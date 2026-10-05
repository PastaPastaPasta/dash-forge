/**
 * The reader's own quorum service: where this browser fetches the quorum keys every proof is
 * checked against, in place of the network's default (Dash's `quorums.<net>.networks.dash.org`).
 * For when that service is down or blocked: anyone can run one (Dash's is open source).
 *
 * Saved per network in localStorage and read once per page load, when the SDK connects
 * (`lib/sdk/service.ts`), so a change takes a reload. Parity with the CLI's `--quorum-url`,
 * `DASH_FORGE_QUORUM_URL` and `dash.quorumUrl`.
 *
 * There is no DAPI-only fallback: evo-sdk's trusted mode takes quorum keys from a quorum
 * service and nowhere else (`EvoSDK.connect` → `WasmTrustedContext.prefetch*WithUrl`), and its
 * untrusted mode does not check proofs at all.
 */

const KEY_PREFIX = 'forge.quorumUrl.'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * A pasted quorum service URL as the SDK takes it (`https://host[:port][/path]`, no trailing
 * slash), or null when it is not one. https only: the SDK refuses plain http on testnet and
 * mainnet, and the app's CSP blocks it everywhere.
 */
export function normalizeQuorumUrl(input: string): string | null {
  const raw = input.trim()
  if (raw === '') return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
    if (url.search !== '' || url.hash !== '') return null
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/** The quorum service this browser uses on `networkKey` (`testnet`, `devnet-sakura`, …), if set. */
export function userQuorumUrl(networkKey: string): string | null {
  const raw = storage()?.getItem(KEY_PREFIX + networkKey)
  return raw ? normalizeQuorumUrl(raw) : null
}

/** Save (or, with null, clear) this browser's quorum service for `networkKey`. */
export function setUserQuorumUrl(networkKey: string, url: string | null): void {
  const clean = url === null ? null : normalizeQuorumUrl(url)
  try {
    if (clean === null) storage()?.removeItem(KEY_PREFIX + networkKey)
    else storage()?.setItem(KEY_PREFIX + networkKey, clean)
  } catch {
    // Storage full or blocked: nothing is kept, which the caller reads back.
  }
}
