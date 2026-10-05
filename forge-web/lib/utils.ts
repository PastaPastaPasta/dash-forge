import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge, taught about the project's CUSTOM font-size utilities (`text-dense`,
 * `text-prose` — see tailwind.config `fontSize`). Without this, tailwind-merge classifies
 * `text-dense`/`text-prose` as `text-*` COLOR utilities and treats them as conflicting with
 * `text-white`; since the size class is emitted after the color in the CVA output, it would
 * silently DROP `text-white` — which made every primary button render body-inherited
 * anvil-200 text (4.12:1 on the ember bg) instead of white (a WCAG-AA contrast failure the
 * Playwright axe run caught). Registering them under `font-size` keeps color + size orthogonal.
 */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['dense', 'prose'] }] } },
})

/**
 * Merge conditional class names and dedupe conflicting Tailwind utilities.
 * The shadcn/yappr convention used by every `components/ui/` primitive.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Abbreviate an OID / hash / base58 identity id to a fixed prefix length.
 * Style guide: OIDs always mono, 7-char abbreviated, click-to-copy full.
 */
export function abbreviate(value: string, chars = 7): string {
  if (value.length <= chars) return value
  return value.slice(0, chars)
}

/**
 * An identity or document id as people read it: the first 7 and the last 5 characters,
 * `G6D3ejK…7nB2q`, as the Dash wallets show an identity on their approval screens.
 *
 * Never the prefix alone: an identity id is a hash of the asset lock that funded it, so an
 * attacker can try funding transactions offline until the first 7 characters match someone
 * else's (58⁷ tries) and broadcast only that one. Matching both ends as well costs 58¹² tries.
 * Short values come back unchanged.
 */
export function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 7)}…${id.slice(-5)}` : id
}

/**
 * Extract a human-legible message from any thrown value — including the **wasm-bindgen error
 * objects** the evo-sdk rejects with, which are NOT `Error` instances (they carry a
 * `__wbg_ptr` and a `r7`-style ctor). A naive `String(e)` on those yields `"[object Object]"`,
 * so we probe `.message` and `.toString()` (each guarded — a getter can throw on a freed wasm
 * pointer) before falling back. Never returns `"[object Object]"` or an empty string.
 */
export function errorMessage(e: unknown, fallback = 'read failed (SDK error)'): string {
  if (typeof e === 'string') return e || fallback
  if (e instanceof Error) return e.message || fallback
  if (e && typeof e === 'object') {
    try {
      const m = (e as { message?: unknown }).message
      if (typeof m === 'string' && m.length > 0) return m
    } catch {
      /* a wasm-bindgen getter can throw once the pointer is freed — ignore and try toString */
    }
    try {
      const s = (e as { toString?: () => unknown }).toString?.()
      if (typeof s === 'string' && s.length > 0 && s !== '[object Object]') return s
    } catch {
      /* ignore */
    }
  }
  return fallback
}

/**
 * What an input check (`checkLabelInput`, `checkMilestoneInput`, …) throws, as a sentence for a
 * form, or null when the input passes: a form shows the reason its write would be refused.
 */
export function inputProblem(check: () => void): string | null {
  try {
    check()
    return null
  } catch (e) {
    const m = errorMessage(e, 'this is not accepted')
    return `${m.charAt(0).toUpperCase()}${m.slice(1)}.`
  }
}

/** A base58 identity id (32 bytes: 42-44 characters). */
const IDENTITY_ID = /^[1-9A-HJ-NP-Za-km-z]{42,44}$/

/** Whether `s` is shaped like a base58 identity id. */
export function isIdentityId(s: string): boolean {
  return IDENTITY_ID.test(s)
}
