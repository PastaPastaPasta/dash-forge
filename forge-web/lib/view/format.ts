/**
 * View-model formatting helpers (presentation glue only — no rules/sdk core logic).
 *
 * Consumed by the forge-web pages to render OIDs, credits/DASH, relative time, byte sizes,
 * and DPNS-less identity fallbacks consistently. Kept pure + framework-free so both server
 * shells and client components can call them.
 */

// `../sdk/cost` has no imports: the merge worker loads this module and must not pull the SDK in.
import { creditsToDash } from '../sdk/cost'
import type { Network } from '../constants'

/** Abbreviate an OID / hash to a struck-metal serial (default 7 chars, git convention). */
export function shortOid(oid: string, chars = 7): string {
  if (oid.length <= chars) return oid
  return oid.slice(0, chars)
}

/** Format a DASH amount with sensible precision (small fees show more decimals). */
export function formatDash(dash: number): string {
  if (dash === 0) return '0'
  if (dash >= 1) return dash.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  // Small fees: show up to 6 significant decimals, trimmed.
  return dash.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

/** Format a credit amount as DASH (display). */
export function creditsAsDash(credits: number): string {
  return formatDash(creditsToDash(credits))
}

/** Rough USD estimate from DASH (indicative secondary display only; mainnet only). */
const USD_PER_DASH = 30

/**
 * Secondary USD estimate string, e.g. `$0.01`, or null off mainnet: devnet and testnet DASH
 * is free test money, and a dollar figure beside it misleads (QW-046).
 */
export function dashToUsd(dash: number, network: Network): string | null {
  if (network !== 'mainnet') return null
  const usd = dash * USD_PER_DASH
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

/** What sits beside a balance: its USD estimate on mainnet, else that test DASH has no value. */
export function dashValueNote(dash: number, network: Network): string {
  const usd = dashToUsd(dash, network)
  return usd === null ? 'test DASH, no cash value' : `≈ ${usd}`
}

/**
 * What undoing a relation gives back, beside its button: `unstar +0.00012` (QW2-034: a bare
 * "+0.00012 DASH" beside "Starred" read like earnings; its meaning was only in a tooltip).
 * `refundCredits` is the preview's (negative) credits.
 */
export function refundLabel(undo: string, refundCredits: number): string {
  return `${undo} +${creditsAsDash(Math.abs(refundCredits))}`
}

/**
 * A write's price on its button: `~0.0006` once the estimate's inputs were read, `≤0.001` while
 * it is still the upper bound (every first-write surcharge counted), so a figure that drops once
 * the page reads more reads as the bound it was, not a different price (QW-043).
 */
export function priceLabel(credits: number, upperBound: boolean): string {
  return `${upperBound ? '≤' : '~'}${creditsAsDash(credits)}`
}

/** Credit balance (as a decimal string) → DASH display string. */
export function balanceToDash(balance: string): string {
  const credits = Number(balance)
  if (!Number.isFinite(credits)) return '0'
  return formatDash(creditsToDash(credits))
}

/**
 * A count and its noun, singular only for exactly one: `plural(1, 'commit')` → `1 commit`,
 * `plural(2, 'commit')` → `2 commits`, `plural(3, 'copy', 'copies')` → `3 copies`. `many`
 * is the irregular plural (default: the noun plus `s`). A number is grouped for reading
 * (`1,234 commits`); pass a string (`'100+'`) to show a count as given, which reads plural.
 */
export function plural(n: number | string, one: string, many = `${one}s`): string {
  if (typeof n === 'string') return `${n} ${many}`
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/**
 * Relative time from a ms epoch, e.g. `3d ago`, `just now`. Anything under a minute (and a
 * time slightly in the future, from clock skew) reads `just now`: never `0m ago`.
 */
export function timeAgo(ms: number, now = Date.now()): string {
  if (!ms) return ''
  const diff = Math.max(0, now - ms)
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

/** A branch's short name for display: `refs/heads/main` → `main` (any other ref as given). */
export function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

/** Absolute date, e.g. `Jul 22, 2026`. */
export function formatDate(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** Human byte size, e.g. `1.2 KB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

/** A URL's host for display; an `ipfs://` or `platform://` locator by its scheme alone. */
export function urlHost(url: string): string {
  if (/^(ipfs|platform):/i.test(url)) return url.slice(0, url.indexOf(':')).toLowerCase()
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/**
 * How a fork PR's head branch is named before its branch (QW4-030), as GitHub's `user:branch`:
 * the fork's owner (`ownerLabel`, a DPNS name or short id), and its name too when it differs from
 * the base repo's (`owner/name:`); only the name when the owner forked their own repo. Empty for a
 * same-repo PR (`fork` null).
 */
export function forkSourcePrefix(fork: { readonly ownerId: string; readonly ownerLabel: string; readonly name: string } | null, base: { readonly ownerId: string; readonly name: string }): string {
  if (fork === null) return ''
  if (fork.ownerId === base.ownerId) return `${fork.name}:`
  return fork.name === base.name ? `${fork.ownerLabel}:` : `${fork.ownerLabel}/${fork.name}:`
}

/** A short, readable identity fallback when no DPNS name is known. */
export function shortIdentity(id: string, chars = 6): string {
  if (id.length <= chars * 2 + 1) return id
  return `${id.slice(0, chars)}…${id.slice(-chars)}`
}

/** git file mode → a short symbolic type (`dir`, `exe`, `file`, `link`, `submodule`). */
export function modeKind(mode: number): 'dir' | 'exe' | 'file' | 'link' | 'submodule' {
  if (mode === 0o40000) return 'dir'
  if (mode === 0o160000) return 'submodule'
  if (mode === 0o120000) return 'link'
  if ((mode & 0o111) !== 0) return 'exe'
  return 'file'
}
