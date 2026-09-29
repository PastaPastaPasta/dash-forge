/**
 * Keep a private repo's decrypted names out of URLs (`docs/security/private-repos.md` §1, §4.3:
 * file paths and ref names are encrypted content; commit ids are visible metadata under §7, and
 * are tokenized too only so every sealed route behaves the same).
 *
 * Routes are query-param (`?path=src/secret.rs&ref=feature/x&oid=…`), and a URL ends up in the
 * browser history, in bookmarks, and in the request a reload sends to whoever hosts the app. For a
 * private repo a member reads, those values are replaced by random per-tab tokens (`~` + 16 hex)
 * that this module resolves in memory. A token means nothing outside the tab that made it: a
 * reload or a copied link opens the repo root instead.
 */

const TOKEN = /^~[0-9a-f]{16}$/

/** The params whose values are decrypted names in a private repo (`base` / `head`: a comparison's refs). */
export const SEALED_PARAMS: ReadonlySet<string> = new Set(['path', 'ref', 'oid', 'base', 'head'])

/** Repos (by address key) whose URLs are sealed in this tab. */
const sealedRepos = new Set<string>()
const byValue = new Map<string, string>()
const byToken = new Map<string, string>()

/** The address key of a repo route (`owner/name`, plus the `?repo=` pin). */
export function addressKey(addr: { readonly owner: string; readonly name: string; readonly repoId?: string }): string {
  return `${addr.owner}/${addr.name}/${addr.repoId ?? ''}`
}

/** Seal this repo's route params in this tab (a member reading a private repo). */
export function sealRepoUrls(addr: { readonly owner: string; readonly name: string; readonly repoId?: string }): void {
  sealedRepos.add(addressKey(addr))
}

/** Whether this repo's route params are sealed in this tab. */
export function isSealedRepo(addr: { readonly owner: string; readonly name: string; readonly repoId?: string }): boolean {
  return sealedRepos.has(addressKey(addr))
}

/** The token standing for `value` in this tab (the same value keeps its token). */
function tokenFor(value: string): string {
  const hit = byValue.get(value)
  if (hit !== undefined) return hit
  const token = `~${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')}`
  byValue.set(value, token)
  byToken.set(token, value)
  return token
}

/** `extra` with its sealed params replaced by tokens, when `addr` is a sealed repo. */
export function sealParams(
  addr: { readonly owner: string; readonly name: string; readonly repoId?: string },
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  if (!isSealedRepo(addr)) return { ...extra }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(extra)) out[k] = SEALED_PARAMS.has(k) && v !== '' ? tokenFor(v) : v
  return out
}

/**
 * The value route param `name` stands for: a token this tab issued resolves to its value;
 * anything else (another param, a public repo's file literally named like a token, a token from
 * another tab) is returned as it is. See {@link isExpiredToken} for the last case.
 */
export function openParam(name: string, raw: string): string {
  if (!SEALED_PARAMS.has(name)) return raw
  return byToken.get(raw) ?? raw
}

/** A sealed param holding a token this tab did not issue (a reload, a copied link, a lock). */
export function isExpiredToken(name: string, raw: string): boolean {
  return SEALED_PARAMS.has(name) && TOKEN.test(raw) && !byToken.has(raw)
}

/** Forget every token and sealed repo (vault lock: nothing decrypted outlives it). */
export function forgetPrivateNav(): void {
  sealedRepos.clear()
  byValue.clear()
  byToken.clear()
}
