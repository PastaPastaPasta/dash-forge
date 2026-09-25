import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import tailwindConfig from '@/tailwind.config.js'
import { avatarFill, hslToRgb, whiteContrast } from './avatar'

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
const colors = (
  tailwindConfig as unknown as {
    theme: { extend: { colors: Record<string, string | Record<string, string>> } }
  }
).theme.extend.colors
const anvil = colors['anvil'] as Record<string, string>
const dash = colors['dash'] as Record<string, string>

/** A Tailwind color class suffix (`dash-700`, `verify`, `anvil-500`) to its hex, if known. */
function tokenHex(token: string): string | undefined {
  if (token === 'white') return '#ffffff'
  const m = /^([a-z]+)(?:-(\d+))?$/.exec(token)
  if (m === null) return undefined
  const entry = colors[m[1] as string]
  if (typeof entry === 'string') return m[2] === undefined ? entry : undefined
  return entry?.[m[2] ?? 'DEFAULT']
}

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

describe('identity-pill avatar fills keep the white initial at AA', () => {
  it('holds for every hue', () => {
    for (let hue = 0; hue < 360; hue++) {
      const m = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(avatarFill(hue))
      expect(m).not.toBeNull()
      const rgbFill = hslToRgb(Number(m?.[1]), Number(m?.[2]) / 100, Number(m?.[3]) / 100)
      expect(whiteContrast(rgbFill), `hue ${hue}`).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it('the old fixed fill failed where the report said', () => {
    // hsl(60 45% 45%) — the yellow-green the review measured at 2.58:1.
    expect(whiteContrast(hslToRgb(60, 0.45, 0.45))).toBeLessThan(AA_TEXT)
  })
})

describe('white text on solid fills meets WCAG AA', () => {
  const root = resolve(__dirname, '../..')

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return sources(p)
      return /\.tsx$/.test(e.name) ? [p] : []
    })
  }

  // Every `bg-…` class, including `hover:` / `dark:` / `focus:` variants (a hover fill sits
  // behind the same white text), arbitrary values and `/NN` tints. The token captured is
  // what follows `bg-`; anything this test cannot resolve to a solid colour FAILS, so a new
  // shape of fill cannot slip past it unchecked.
  const SOLID_BG = /(?<![\w-])(?:[a-z-]+:)*bg-([a-z]+(?:-\d+)?(?:\/\d+)?|\[[^\]]+\])(?![-\w])/g

  /**
   * Every solid background that can sit behind `text-white`: backgrounds on the same line as
   * the class, and — for a badge whose background is computed (`${status.bg}`) — every `bg:`
   * value the file assigns.
   */
  function whiteTextBackgrounds(text: string): { token: string; line: number }[] {
    const out: { token: string; line: number }[] = []
    const lineAt = (offset: number): number => text.slice(0, offset).split('\n').length
    const scan = (chunk: string, base: number): void => {
      for (const m of chunk.matchAll(SOLID_BG)) {
        out.push({ token: m[1] as string, line: lineAt(base + (m.index ?? 0)) })
      }
    }
    // Whole class expressions, however many lines they span: a `className="…"` string, a
    // `className={…}` expression (template, `cn(…)` call — braces balanced), or a
    // `cva`-style quoted string. Each that contains `text-white` is scanned as a unit.
    const CLASS_EXPR = /className=(?:"[^"]*"|'[^']*'|\{)/g
    for (const m of text.matchAll(CLASS_EXPR)) {
      const start = m.index ?? 0
      let end = start + m[0].length
      if (m[0].endsWith('{')) {
        let depth = 1
        while (end < text.length && depth > 0) {
          const c = text[end]
          if (c === '{') depth += 1
          else if (c === '}') depth -= 1
          end += 1
        }
      }
      const expr = text.slice(start, end)
      if (expr.includes('text-white')) scan(expr, start)
    }
    // Class strings defined away from the element (a variants table): any quoted string
    // holding both `text-white` and a solid fill.
    for (const m of text.matchAll(/'[^'\n]*'|"[^"\n]*"/g)) {
      if (m[0].includes('text-white') && !text.slice(Math.max(0, (m.index ?? 0) - 10), m.index).includes('className=')) {
        scan(m[0], m.index ?? 0)
      }
    }
    // A badge whose background is computed (`${status.bg}`): every `bg:` value the file
    // assigns can end up behind the white text.
    if (/text-white[\s\S]{0,200}?\$\{[\w.]*\bbg\}/.test(text)) {
      for (const m of text.matchAll(/\bbg:\s*[^\n]*/g)) scan(m[0], m.index ?? 0)
    }
    return [...new Map(out.map((b) => [`${b.line}:${b.token}`, b])).values()]
  }

  it('checks the Merged / Open / Closed / Draft badges and every other white-text fill', () => {
    const failures: string[] = []
    let checked = 0
    for (const file of ['app', 'components'].flatMap((d) => sources(join(root, d)))) {
      for (const { token, line } of whiteTextBackgrounds(readFileSync(file, 'utf8'))) {
        const hex = tokenHex(token)
        if (hex === undefined) {
          // Not a token from this config (a Tailwind default like `green-600`, an arbitrary
          // `[#…]`, a `/NN` tint): this test cannot vouch for it, so it is a failure, not a pass.
          failures.push(`${file.slice(root.length + 1)}:${line} bg-${token} (unknown to the contrast test)`)
          continue
        }
        checked += 1
        const ratio = contrast(rgb('#ffffff'), rgb(hex))
        if (ratio < AA_TEXT) {
          failures.push(`${file.slice(root.length + 1)}:${line} bg-${token} ${ratio.toFixed(2)}:1`)
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(6)
    expect(failures).toEqual([])
  })

  it('catches the regressions it exists for', () => {
    const tokens = (src: string): string[] => whiteTextBackgrounds(src).map((b) => b.token)
    // The Merged badge before the fix: brand blue behind white is 3.54:1.
    const merged = "const s = { bg: 'bg-dash' }\n<span className={`text-white ${s.bg}`}>"
    expect(tokens(merged)).toEqual(['dash'])
    expect(contrast(rgb('#ffffff'), rgb(tokenHex('dash') as string))).toBeLessThan(AA_TEXT)
    expect(contrast(rgb('#ffffff'), rgb(tokenHex('verify') as string))).toBeLessThan(AA_TEXT)
    // The hover fill sits behind the same white text, so it is checked too.
    expect(tokens('<b className="text-white bg-forge-700 hover:bg-forge-600">')).toEqual(['forge-700', 'forge-600'])
    expect(tokens('<b className="text-white bg-[#123456] dark:bg-green-600">')).toEqual(['[#123456]', 'green-600'])
    expect(tokenHex('green-600')).toBeUndefined() // → reported as unknown, not skipped
    // text-white and the fill on different lines of one class expression.
    expect(tokens('<b\n  className={cn(\n    \'rounded text-white\',\n    \'bg-dash\',\n  )}\n>')).toEqual(['dash'])
    expect(tokens('<b className="px-2\n  text-white\n  bg-verify">')).toEqual(['verify'])
    expect(tokens('<b className="text-anvil-700 bg-dash/10">')).toEqual([])
  })
})
