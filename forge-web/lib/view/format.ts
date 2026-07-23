/**
 * View-model formatting helpers (presentation glue only — no rules/sdk core logic).
 *
 * Consumed by the forge-web pages to render OIDs, credits/DASH, relative time, byte sizes,
 * and DPNS-less identity fallbacks consistently. Kept pure + framework-free so both server
 * shells and client components can call them.
 */

import { creditsToDash } from '../sdk'

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

/** Rough USD estimate from DASH (indicative secondary display only). */
const USD_PER_DASH = 30

/** Secondary USD estimate string, e.g. `≈ $0.01`. */
export function dashToUsd(dash: number): string {
  const usd = dash * USD_PER_DASH
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

/** Credit balance (as a decimal string) → DASH display string. */
export function balanceToDash(balance: string): string {
  const credits = Number(balance)
  if (!Number.isFinite(credits)) return '0'
  return formatDash(creditsToDash(credits))
}

/** Relative time from a ms epoch, e.g. `3d ago`, `just now`. */
export function timeAgo(ms: number, now = Date.now()): string {
  if (!ms) return ''
  const diff = Math.max(0, now - ms)
  const s = Math.floor(diff / 1000)
  if (s < 45) return 'just now'
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
