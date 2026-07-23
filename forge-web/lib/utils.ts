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
