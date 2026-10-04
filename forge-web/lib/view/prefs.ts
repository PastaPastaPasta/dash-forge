/**
 * Display preferences kept in this browser (localStorage; none of them is secret): how diffs
 * render, and the name and email a browser merge commit is authored with.
 */

/** Diff colors. `colorblind` is blue (added) and orange (deleted), for red/green colorblindness. */
export type DiffPalette = 'standard' | 'colorblind'

export interface Prefs {
  /** `split` shows side by side on wide screens (≥ 1024 px); narrow screens are always unified. */
  readonly diffLayout: 'split' | 'unified'
  readonly ignoreWhitespace: boolean
  readonly palette: DiffPalette
  /** Who a browser merge commit is authored and committed by. */
  readonly mergeName: string
  readonly mergeEmail: string
}

export const DEFAULT_PREFS: Prefs = {
  diffLayout: 'split',
  ignoreWhitespace: false,
  palette: 'standard',
  mergeName: '',
  mergeEmail: '',
}

export const PREFS_KEY = 'forge.prefs.v1'

/** Parse stored preferences, keeping only well-typed fields. */
export function parsePrefs(raw: string | null): Prefs {
  if (raw === null) return DEFAULT_PREFS
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return DEFAULT_PREFS
  }
  if (typeof o !== 'object' || o === null) return DEFAULT_PREFS
  const r = o as Record<string, unknown>
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  return {
    diffLayout: r['diffLayout'] === 'unified' ? 'unified' : 'split',
    ignoreWhitespace: r['ignoreWhitespace'] === true,
    palette: r['palette'] === 'colorblind' ? 'colorblind' : 'standard',
    mergeName: text(r['mergeName'], 200),
    mergeEmail: text(r['mergeEmail'], 200),
  }
}

/** Whether a merge identity is usable: a name, and an email git would accept. */
export function mergeIdentityValid(p: Pick<Prefs, 'mergeName' | 'mergeEmail'>): boolean {
  return p.mergeName.trim() !== '' && !/[<>\n]/.test(p.mergeName) && /^[^\s<>@]+@[^\s<>@]+$/.test(p.mergeEmail.trim())
}

/**
 * The classes and colors of a diff palette. Rows are tinted by the `diff-add` / `diff-del` classes
 * (app/globals.css: `tint` at `--diff-row-alpha`, with a 2px edge in the marker colour, and the
 * changed words at `--diff-word-alpha` more); the table's `data-diff-palette` picks the palette.
 * The text on them is the normal body text and syntax colours, and the `+`/`−` markers carry the
 * colour (both themes checked against WCAG AA in `lib/design/contrast.test.ts`, which also checks
 * that the CSS and these hexes agree). The markers are always shown, so colour is never the only
 * signal.
 */
export interface PaletteSide {
  readonly marker: string
  /** The tint's base color and the marker colors, for the contrast test. */
  readonly tint: string
  readonly markerLight: string
  readonly markerDark: string
}

export const DIFF_PALETTES: Readonly<Record<DiffPalette, { readonly added: PaletteSide; readonly deleted: PaletteSide }>> = {
  standard: {
    added: { marker: 'text-green-800 dark:text-green-400', tint: '#16a34a', markerLight: '#166534', markerDark: '#4ade80' },
    deleted: { marker: 'text-red-700 dark:text-red-400', tint: '#dc2626', markerLight: '#b91c1c', markerDark: '#f87171' },
  },
  colorblind: {
    added: { marker: 'text-blue-700 dark:text-blue-400', tint: '#2563eb', markerLight: '#1d4ed8', markerDark: '#60a5fa' },
    deleted: { marker: 'text-orange-800 dark:text-orange-400', tint: '#f97316', markerLight: '#9a3412', markerDark: '#fb923c' },
  },
}
