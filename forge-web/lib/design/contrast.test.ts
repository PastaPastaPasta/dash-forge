import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import tailwindConfig from '@/tailwind.config.js'

/**
 * WCAG 2 AA contrast for the design tokens, checked without a browser.
 *
 * The nightly axe run (e2e/a11y.spec.ts) is the end-to-end check, but it needs live testnet
 * data to render the elements that fail — the landing only showed the DPNS-name identity
 * pill in dash blue once a repo card resolved its owner's name. These tests pin the token
 * pairs so a regression fails in `pnpm test`, offline.
 */

// The config's JSDoc type makes every theme key optional and possibly a function; this
// config is a plain object literal, so read it as one.
const { anvil, dash } = (
  tailwindConfig as unknown as {
    theme: { extend: { colors: Record<'anvil' | 'dash', Record<string, string>> } }
  }
).theme.extend.colors

type Rgb = [number, number, number]

function rgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(fg: Rgb, bg: Rgb): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** `fg` at `alpha` composited over `bg` — how `bg-dash/10` renders. */
function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((c, i) => c * alpha + (bg[i] as number) * (1 - alpha)) as Rgb
}

/** WCAG AA for normal-size text; every dash-blue label here is 11–15px. */
const AA_TEXT = 4.5

const LIGHT_SURFACES = { white: '#ffffff', 'anvil-50': anvil['50'], 'anvil-100': anvil['100'] }
const DARK_SURFACES = {
  'anvil-950': anvil['950'],
  'anvil-900': anvil['900'],
  'anvil-850': anvil['850'],
  'anvil-800': anvil['800'],
}

describe('dash-blue text tokens meet WCAG AA', () => {
  it.each(Object.entries(LIGHT_SURFACES))('dash-600 on %s (light theme)', (_, bg) => {
    const fg = rgb(dash['600']!)
    expect(contrast(fg, rgb(bg!))).toBeGreaterThanOrEqual(AA_TEXT)
    // The network badge sits on a 10% dash tint of its surface.
    expect(contrast(fg, over(rgb(dash.DEFAULT!), rgb(bg!), 0.1))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it.each(Object.entries(DARK_SURFACES))('dash-400 on %s (dark theme)', (_, bg) => {
    const fg = rgb(dash['400']!)
    expect(contrast(fg, rgb(bg!))).toBeGreaterThanOrEqual(AA_TEXT)
    expect(contrast(fg, over(rgb(dash.DEFAULT!), rgb(bg!), 0.1))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('the brand value itself is not a text color (the nightly axe failure)', () => {
    // #008de4 on anvil-800 is 4.28:1: the identity pill's DPNS name that axe flagged.
    expect(contrast(rgb(dash.DEFAULT!), rgb(anvil['800']!))).toBeLessThan(AA_TEXT)
  })
})

describe('no component renders text in the raw brand blue', () => {
  const root = resolve(__dirname, '../..')

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return sources(p)
      return /\.tsx$/.test(e.name) ? [p] : []
    })
  }

  // Any dash-blue text class other than the AA shades: `text-dash`, and opacity variants
  // like `text-dash/80`, which are lower contrast still.
  const RAW = /\btext-dash(?:\/\d+)?(?![-\w/])/
  // A lucide icon element carrying the class in its own props and marked aria-hidden: a
  // non-text graphic, which WCAG 1.4.11 asks 3:1 of — the brand value meets that on every
  // dark surface.
  const ICON = /<[A-Z]\w*\s+className="[^"]*\btext-dash(?![-\w/])[^"]*"\s+aria-hidden\s*\/>/g
  // Class strings that are applied only to an icon wrapper, checked by hand.
  const ICON_ONLY = new Set(['components/repo/pulls-content.tsx:34'])

  it('uses raw dash blue only on icons', () => {
    const offenders = ['app', 'components']
      .flatMap((d) => sources(join(root, d)))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((text, i) => ({ where: `${file.slice(root.length + 1)}:${i + 1}`, text }))
          .filter(({ where, text }) => RAW.test(text.replace(ICON, '')) && !ICON_ONLY.has(where)),
      )
      .map(({ where }) => where)
    expect(offenders).toEqual([])
  })

  it('catches the regressions it exists for', () => {
    const flagged = (line: string): boolean => RAW.test(line.replace(ICON, ''))
    expect(flagged('<span className="text-dash">{name}</span>')).toBe(true)
    expect(flagged('<span className="text-dash/80">{name}</span>')).toBe(true)
    // Visible text next to an unrelated hidden icon on the same line is still text.
    expect(flagged('<span className="text-dash">{n}</span><Wallet aria-hidden />')).toBe(true)
    expect(flagged('<GitMerge className="h-4 w-4 text-dash" aria-hidden />')).toBe(false)
    expect(flagged('<span className="text-dash-600 dark:text-dash-400">{n}</span>')).toBe(false)
    expect(flagged('<span className="bg-dash/10">{n}</span>')).toBe(false)
  })
})
