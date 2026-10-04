import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import tailwindConfig from '@/tailwind.config.js'
import { DIFF_PALETTES } from '@/lib/view/prefs'
import { avatarFill, hslToRgb, whiteContrast } from './avatar'
import { STATE_FILL, STATE_TEXT } from './state'

/**
 * WCAG 2 AA contrast for the design tokens, checked without a browser.
 *
 * The nightly axe run (e2e/a11y.spec.ts) is the end-to-end check, but it needs live devnet
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

type Rgb = [number, number, number]

/** The app's sources root (forge-web/). */
const root = resolve(__dirname, '../..')

/**
 * The theme tokens of app/globals.css: every `--name: R G B;` in its `:root` blocks (light) and
 * its `.dark` blocks (dark, falling back to light where a token has no dark value).
 */
function themeTokens(): { readonly light: Readonly<Record<string, Rgb>>; readonly dark: Readonly<Record<string, Rgb>> } {
  const css = readFileSync(join(root, 'app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const block = (selector: RegExp): Record<string, Rgb> => {
    const out: Record<string, Rgb> = {}
    for (const b of css.matchAll(selector)) {
      for (const v of (b[1] as string).matchAll(/--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
        out[v[1] as string] = [Number(v[2]), Number(v[3]), Number(v[4])]
      }
    }
    return out
  }
  const light = block(/(?:^|[\s;{}]):root\s*\{([^}]*)\}/g)
  return { light, dark: { ...light, ...block(/(?:^|[\s;{}])\.dark\s*\{([^}]*)\}/g) } }
}
const TOKENS = themeTokens()

const hexOf = (c: Rgb): string => `#${c.map((n) => n.toString(16).padStart(2, '0')).join('')}`

/**
 * A Tailwind color class suffix (`dash-700`, `verify`, `state-open-fill`) to its hex in each theme:
 * one value for a fixed colour, light then dark for a theme token. Undefined when unknown.
 */
function tokenHexes(token: string): string[] | undefined {
  if (token === 'white') return ['#ffffff']
  const m = /^([a-z]+)(?:-([\w-]+))?$/.exec(token)
  if (m === null) return undefined
  const entry = colors[m[1] as string]
  const value = typeof entry === 'string' ? (m[2] === undefined ? entry : undefined) : entry?.[m[2] ?? 'DEFAULT']
  if (value === undefined) return undefined
  const variable = /^rgb\(var\(--([\w-]+)\)/.exec(value)?.[1]
  if (variable === undefined) return [value]
  const [light, dark] = [TOKENS.light[variable], TOKENS.dark[variable]]
  return light === undefined || dark === undefined ? undefined : [...new Set([hexOf(light), hexOf(dark)])]
}

/** A colour's hex (its light-theme value, for a theme token), if known. */
const tokenHex = (token: string): string | undefined => tokenHexes(token)?.[0]

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

/** The app's React sources (app/ and components/), for the class-string checks below. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.tsx$/.test(e.name) ? [p] : []
  })
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

describe('Verification state words meet WCAG AA', () => {
  // `text-{state}-700 dark:text-{state}`: the -700 shade on light surfaces, the base on dark.
  // `text-{state}-700 dark:text-{state}-400`, on the plain surfaces and on the state's own
  // 5–15 % tint (a note box, the funds pill, the devnet network badge).
  it.each([['verify'], ['caution'], ['danger']])('%s on surfaces and its own tints', (state) => {
    const ramp = colors[state] as Record<string, string>
    const tint = rgb(ramp.DEFAULT!)
    for (const alpha of [0, 0.05, 0.1, 0.15]) {
      for (const bg of Object.values(LIGHT_SURFACES)) {
        expect(contrast(rgb(ramp['700']!), over(tint, rgb(bg!), alpha)), `${state}-700 @${alpha}`).toBeGreaterThanOrEqual(AA_TEXT)
      }
      for (const bg of Object.values(DARK_SURFACES)) {
        expect(contrast(rgb(ramp['400']!), over(tint, rgb(bg!), alpha)), `${state}-400 @${alpha}`).toBeGreaterThanOrEqual(AA_TEXT)
      }
    }
  })

  it('the network badge that failed on every light page now passes', () => {
    // D-046: `text-caution` (#d97706) on `bg-caution/10` over anvil-50 measured 2.75:1.
    const caution = colors['caution'] as Record<string, string>
    const badgeBg = over(rgb(caution.DEFAULT!), rgb(anvil['50']!), 0.1)
    expect(contrast(rgb(caution.DEFAULT!), badgeBg)).toBeLessThan(3)
    expect(contrast(rgb(caution['700']!), badgeBg)).toBeGreaterThanOrEqual(AA_TEXT)
  })
})

describe('neutral and ember text meets WCAG AA', () => {
  const forge = colors['forge'] as Record<string, string>
  it('muted text: anvil-500 on light surfaces (incl. anvil-100 chips), anvil-400 on dark', () => {
    for (const bg of Object.values(LIGHT_SURFACES)) {
      expect(contrast(rgb(anvil['500']!), rgb(bg!))).toBeGreaterThanOrEqual(AA_TEXT)
      // The selected tab of a segmented control: muted text beside an ember tint.
      expect(contrast(rgb(anvil['500']!), over(rgb(forge['500']!), rgb(bg!), 0.15))).toBeGreaterThanOrEqual(AA_TEXT)
    }
    for (const bg of Object.values(DARK_SURFACES)) {
      expect(contrast(rgb(anvil['400']!), rgb(bg!))).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it('anvil-400 is not a light-theme text color (2.41:1 on anvil-50)', () => {
    expect(contrast(rgb(anvil['400']!), rgb(anvil['50']!))).toBeLessThan(AA_TEXT)
  })

  it('ember links: forge-700 on light surfaces, forge-800 on an ember tint, forge-400 on dark', () => {
    for (const bg of Object.values(LIGHT_SURFACES)) {
      expect(contrast(rgb(forge['700']!), rgb(bg!))).toBeGreaterThanOrEqual(AA_TEXT)
      for (const alpha of [0.1, 0.15, 0.2]) {
        expect(contrast(rgb(forge['800']!), over(rgb(forge['500']!), rgb(bg!), alpha))).toBeGreaterThanOrEqual(AA_TEXT)
      }
    }
    for (const bg of Object.values(DARK_SURFACES)) {
      expect(contrast(rgb(forge['400']!), rgb(bg!))).toBeGreaterThanOrEqual(AA_TEXT)
      expect(contrast(rgb(forge['400']!), over(rgb(forge['500']!), rgb(bg!), 0.15))).toBeGreaterThanOrEqual(AA_TEXT)
    }
    // forge-600 as light text was the 3.4–3.6:1 link failure on the release pages.
    expect(contrast(rgb(forge['600']!), rgb('#ffffff'))).toBeLessThan(AA_TEXT)
  })
})

describe('no component uses a light-theme text color that fails AA', () => {
  // Light-theme text classes measured under 4.5:1 on the light surfaces, bare or as a (group-)
  // hover shade: a hover recolors the same text. Graphics are exempt (WCAG 1.4.11 asks 3:1):
  // an aria-hidden icon, a labelled icon, or a decorative icon wrapper.
  const FAILS = /(?<![\w:/-])(?:(?:group-)?hover:)?text-(?:anvil-[34]00|forge-[56]00|caution|verify|danger)(?![\w/-])/
  const EXEMPT = /aria-hidden|aria-label="private"/
  // Icon-only elements whose colour sits on a graphic, not on text (checked by hand).
  const ICON_ONLY = [
    /className="rounded p-0\.5 text-anvil-500 hover:text-danger dark:text-anvil-400"/, // gateway remove (X icon)
    /^\s*className="hover:text-danger"\s*$/, // issue label remove (X icon)
    /rounded-full bg-forge-500\/10 text-forge-500">$/, // the empty-state icon badge
  ]

  it('finds none outside graphics', () => {
    const offenders = ['app', 'components']
      .flatMap((d) => sources(join(root, d)))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((text, i) => ({ where: `${file.slice(root.length + 1)}:${i + 1}`, text }))
          .filter(({ text }) => FAILS.test(text) && !EXEMPT.test(text) && !ICON_ONLY.some((re) => re.test(text))),
      )
      .map(({ where }) => where)
    expect(offenders).toEqual([])
  })

  it('catches the regressions it exists for', () => {
    expect(FAILS.test('<span className="text-caution">low</span>')).toBe(true)
    expect(FAILS.test('<span className="text-anvil-400">3d ago</span>')).toBe(true)
    expect(FAILS.test('<a className="text-forge-600 underline">x</a>')).toBe(true)
    // The file-list hover the first codemod pass missed.
    expect(FAILS.test("'group-hover:text-forge-600 dark:group-hover:text-forge-400'")).toBe(true)
    expect(FAILS.test('<a className="hover:text-forge-600">x</a>')).toBe(true)
    expect(FAILS.test('<span className="text-caution-700 dark:text-caution-400">low</span>')).toBe(false)
    expect(FAILS.test('<span className="text-anvil-500 dark:text-anvil-400">x</span>')).toBe(false)
    expect(FAILS.test('<a className="hover:text-forge-800 dark:hover:text-forge-400">x</a>')).toBe(false)
  })

  it('every forge hover shade on light has a dark counterpart', () => {
    // A light hover shade alone applies in dark mode too: forge-800 on anvil-950 is 2.65:1.
    const offenders = ['app', 'components']
      .flatMap((d) => sources(join(root, d)))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((text, i) => ({ where: `${file.slice(root.length + 1)}:${i + 1}`, text }))
          .filter(({ text }) => /(?<![\w:-])(?:group-)?hover:text-forge-\d00/.test(text) && !/dark:(?:group-)?hover:text-/.test(text)),
      )
      .map(({ where }) => where)
    expect(offenders).toEqual([])
  })
})

describe('danger text meets WCAG AA', () => {
  const danger = colors['danger'] as Record<string, string>
  it.each(Object.entries(LIGHT_SURFACES))('danger-700 on %s (light theme)', (_, bg) => {
    expect(contrast(rgb(danger['700']!), rgb(bg!))).toBeGreaterThanOrEqual(AA_TEXT)
  })
  it.each(Object.entries(DARK_SURFACES))('danger-400 on %s (dark theme)', (_, bg) => {
    expect(contrast(rgb(danger['400']!), rgb(bg!))).toBeGreaterThanOrEqual(AA_TEXT)
  })
  it('the base value is not a text color on the darkest or lightest-gray surface', () => {
    // 4.01:1 on anvil-950: the storage wizard's axe failure (a danger button).
    expect(contrast(rgb(danger.DEFAULT!), rgb(anvil['950']!))).toBeLessThan(AA_TEXT)
    expect(contrast(rgb(danger.DEFAULT!), rgb(anvil['100']!))).toBeLessThan(AA_TEXT)
  })
})

describe('no component renders text in the raw brand blue', () => {

  // Any dash-blue text class other than the AA shades: `text-dash`, and opacity variants
  // like `text-dash/80`, which are lower contrast still.
  const RAW = /\btext-dash(?:\/\d+)?(?![-\w/])/
  // A lucide icon element carrying the class in its own props and marked aria-hidden: a
  // non-text graphic, which WCAG 1.4.11 asks 3:1 of — the brand value meets that on every
  // dark surface.
  const ICON = /<[A-Z]\w*\s+className="[^"]*\btext-dash(?![-\w/])[^"]*"\s+aria-hidden\s*\/>/g

  it('uses raw dash blue only on icons', () => {
    const offenders = ['app', 'components']
      .flatMap((d) => sources(join(root, d)))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((text, i) => ({ where: `${file.slice(root.length + 1)}:${i + 1}`, text }))
          .filter(({ text }) => RAW.test(text.replace(ICON, ''))),
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

describe('diff palettes meet WCAG AA on their row tints, in both themes', () => {
  // A diff row is its palette's tint at `--diff-row-alpha` over the page surface (more in dark);
  // a changed word adds `--diff-word-alpha` of the tint on top. The line text, its syntax
  // colours, the line numbers and the +/− markers sit on them. Both palettes, both themes.
  const css = readFileSync(join(root, 'app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const alphas = (selector: RegExp): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const b of css.matchAll(selector)) for (const v of (b[1] as string).matchAll(/--([\w-]+):\s*(0?\.\d+)\s*;/g)) out[v[1] as string] = Number(v[2])
    return out
  }
  const lightAlpha = alphas(/(?:^|[\s;{}]):root\s*\{([^}]*)\}/g)
  const darkAlpha = { ...lightAlpha, ...alphas(/(?:^|[\s;{}])\.dark\s*\{([^}]*)\}/g) }
  /** The colour-blind palette's overrides: on the table (light) and under `.dark`. */
  const cvd = (selector: RegExp): Record<string, Rgb> => {
    const out: Record<string, Rgb> = {}
    for (const b of css.matchAll(selector)) for (const v of (b[1] as string).matchAll(/--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) out[v[1] as string] = [Number(v[2]), Number(v[3]), Number(v[4])]
    return out
  }
  const cvdLight = cvd(/(?:^|[;{}])\s*\[data-diff-palette='colorblind'\]\s*\{([^}]*)\}/g)
  const cvdDark = { ...cvdLight, ...cvd(/\.dark \[data-diff-palette='colorblind'\]\s*\{([^}]*)\}/g) }
  const css4 = { standard: { light: TOKENS.light, dark: TOKENS.dark }, colorblind: { light: { ...TOKENS.light, ...cvdLight }, dark: { ...TOKENS.dark, ...cvdDark } } }

  const LIGHT_TEXT = { body: anvil['800']!, gutter: anvil['600']! }
  const DARK_TEXT = { body: anvil['200']!, gutter: anvil['400']! }
  // Code (and so its syntax colours) sits on the page: anvil-50/white/anvil-100 and anvil-950/900.
  const CODE_DARK = { 'anvil-950': anvil['950'], 'anvil-900': anvil['900'] }
  const SYNTAX = Object.keys(TOKENS.light).filter((k) => k.startsWith('syn-'))
  const cases = Object.entries(DIFF_PALETTES).flatMap(([name, p]) =>
    (['added', 'deleted'] as const).map((side) => [name as keyof typeof css4, side, p[side]] as const),
  )

  it('reads its alphas and syntax colours from app/globals.css', () => {
    expect(lightAlpha['diff-row-alpha']).toBe(0.1)
    expect(darkAlpha['diff-row-alpha']).toBeGreaterThanOrEqual(0.15)
    expect(darkAlpha['diff-word-alpha']).toBeDefined()
    expect(SYNTAX.length).toBeGreaterThanOrEqual(8)
  })

  it.each(cases)('the CSS of the %s palette, %s rows, is the checked colours', (name, side, p) => {
    const short = side === 'added' ? 'add' : 'del'
    expect(hexOf(css4[name].light[`diff-${short}`]!)).toBe(p.tint)
    expect(hexOf(css4[name].light[`diff-${short}-edge`]!)).toBe(p.markerLight)
    expect(hexOf(css4[name].dark[`diff-${short}-edge`]!)).toBe(p.markerDark)
  })

  it.each(cases)('%s palette, %s rows', (_, __, side) => {
    for (const [surfaces, alpha, text, marker, syn] of [
      [LIGHT_SURFACES, lightAlpha, LIGHT_TEXT, side.markerLight, TOKENS.light],
      [DARK_SURFACES, darkAlpha, DARK_TEXT, side.markerDark, TOKENS.dark],
    ] as const) {
      for (const [name, bg] of Object.entries(surfaces)) {
        const row = over(rgb(side.tint), rgb(bg!), alpha['diff-row-alpha']!)
        const word = over(rgb(side.tint), row, alpha['diff-word-alpha']!)
        expect(contrast(rgb(text.body), row), `body on ${name}`).toBeGreaterThanOrEqual(AA_TEXT)
        expect(contrast(rgb(text.body), word), `body on a changed word on ${name}`).toBeGreaterThanOrEqual(AA_TEXT)
        expect(contrast(rgb(text.gutter), row), `gutter on ${name}`).toBeGreaterThanOrEqual(AA_TEXT)
        expect(contrast(rgb(marker), row), `marker on ${name}`).toBeGreaterThanOrEqual(AA_TEXT)
        // The +N / −N counts sit on the plain surface.
        expect(contrast(rgb(marker), rgb(bg!)), `count on ${name}`).toBeGreaterThanOrEqual(AA_TEXT)
        if (surfaces === DARK_SURFACES && !(name in CODE_DARK)) continue
        for (const k of SYNTAX) {
          expect(contrast(syn[k]!, row), `${k} on a row on ${name}`).toBeGreaterThanOrEqual(AA_TEXT)
          expect(contrast(syn[k]!, word), `${k} on a changed word on ${name}`).toBeGreaterThanOrEqual(AA_TEXT)
        }
      }
    }
  })

  it('syntax colours, on the page and in a selected line, both themes', () => {
    for (const [surfaces, syn, text] of [
      [LIGHT_SURFACES, TOKENS.light, LIGHT_TEXT],
      [CODE_DARK, TOKENS.dark, DARK_TEXT],
    ] as const) {
      for (const [name, bg] of Object.entries(surfaces)) {
        for (const alpha of [0, 0.15, 0.25]) {
          const under = over((syn['line-highlight'] ?? TOKENS.light['line-highlight'])!, rgb(bg!), alpha)
          for (const k of SYNTAX) expect(contrast(syn[k]!, under), `${k} on ${name} @${alpha}`).toBeGreaterThanOrEqual(AA_TEXT)
          expect(contrast(rgb(text.gutter), under), `gutter on ${name} @${alpha}`).toBeGreaterThanOrEqual(AA_TEXT)
        }
      }
    }
  })

  it('keywords are not the accent (an accent-coloured word reads as a link)', () => {
    const forge = colors['forge'] as Record<string, string>
    expect(hexOf(TOKENS.light['syn-keyword']!)).not.toBe(forge['700'])
    expect(hexOf(TOKENS.dark['syn-keyword']!)).not.toBe(forge['400'])
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

  // Every `bg-…` class, including `hover:` / `dark:` / `focus:` variants (a hover fill sits
  // behind the same white text), arbitrary values and `/NN` tints. The token captured is
  // what follows `bg-`; anything this test cannot resolve to a solid colour FAILS, so a new
  // shape of fill cannot slip past it unchecked.
  const SOLID_BG = /(?<![\w-])(?:[a-z-]+:)*bg-([a-z]+(?:-[a-z]+)*(?:-\d+)?(?:\/\d+)?|\[[^\]]+\])(?![-\w])/g

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
        const hexes = tokenHexes(token)
        if (hexes === undefined) {
          // Not a token from this config (a Tailwind default like `green-600`, an arbitrary
          // `[#…]`, a `/NN` tint): this test cannot vouch for it, so it is a failure, not a pass.
          failures.push(`${file.slice(root.length + 1)}:${line} bg-${token} (unknown to the contrast test)`)
          continue
        }
        checked += 1
        for (const hex of hexes) {
          const ratio = contrast(rgb('#ffffff'), rgb(hex))
          if (ratio < AA_TEXT) failures.push(`${file.slice(root.length + 1)}:${line} bg-${token} ${hex} ${ratio.toFixed(2)}:1`)
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
    // A theme token's name has hyphens; both its values sit behind the white text.
    expect(tokens('<b className="text-white bg-state-closed">')).toEqual(['state-closed'])
    expect(tokens('<b className="text-white bg-state-open-fill">')).toEqual(['state-open-fill'])
    expect(Math.min(...(tokenHexes('state-closed') as string[]).map((h) => contrast(rgb('#ffffff'), rgb(h))))).toBeLessThan(AA_TEXT)
  })
})

describe('non-text fills meet WCAG 1.4.11 (3:1)', () => {
  const forge = colors['forge'] as Record<string, string>
  const GRAPHIC = 3

  /** The SDK download bar: its fill against its track and against the page around it. */
  function progressBar(): { light: string; dark: string; lightTrack: string; darkTrack: string } {
    const src = readFileSync(join(root, 'components/ui/platform-status.tsx'), 'utf8')
    const bar = /role="progressbar"[\s\S]*?className="([^"]*)"[\s\S]*?<div className="([^"]*)"/.exec(src)
    if (bar === null) throw new Error('progress bar markup not found')
    const [track, fill] = [bar[1] as string, bar[2] as string]
    // A class with no `dark:` fill uses its light fill in dark mode too.
    const pick = (cls: string, dark: boolean): string => {
      const m = (dark ? /dark:bg-([a-z]+-\d+)/.exec(cls) : null) ?? /(?<![:\w-])bg-([a-z]+-\d+)/.exec(cls)
      const hex = m === null ? undefined : tokenHex(m[1] as string)
      if (hex === undefined) throw new Error(`no fill in "${cls}"`)
      return hex
    }
    return { light: pick(fill, false), dark: pick(fill, true), lightTrack: pick(track, false), darkTrack: pick(track, true) }
  }

  it('the SDK download bar fill, in both themes', () => {
    const bar = progressBar()
    for (const bg of [bar.lightTrack, ...Object.values(LIGHT_SURFACES)]) {
      expect(contrast(rgb(bar.light), rgb(bg!)), `light fill on ${bg}`).toBeGreaterThanOrEqual(GRAPHIC)
    }
    for (const bg of [bar.darkTrack, ...Object.values(DARK_SURFACES)]) {
      expect(contrast(rgb(bar.dark), rgb(bg!)), `dark fill on ${bg}`).toBeGreaterThanOrEqual(GRAPHIC)
    }
  })

  it('catches the fill it exists for', () => {
    // forge-500 on the anvil-200 track: the light-mode bar before the fix, 2.23:1.
    expect(contrast(rgb(forge['500']!), rgb(anvil['200']!))).toBeLessThan(GRAPHIC)
  })
})

describe('theme tokens', () => {
  const GRAPHIC = 3
  const LIGHT = Object.values(LIGHT_SURFACES).map((h) => rgb(h!))
  const DARK = Object.values(DARK_SURFACES).map((h) => rgb(h!))

  it('are read from app/globals.css, in both themes', () => {
    expect(TOKENS.light['focus']).toBeDefined()
    expect(TOKENS.dark['focus']).not.toEqual(TOKENS.light['focus'])
    expect(tokenHexes('state-open')).toHaveLength(2)
    // A token with no dark value is the light one in both themes.
    expect(tokenHexes('state-open-fill')).toHaveLength(1)
    expect(tokenHexes('state-nope')).toBeUndefined()
  })

  it('the focus ring is 3:1 or more against its offset and every surface (WCAG 1.4.11)', () => {
    const [light, dark] = [TOKENS.light['focus']!, TOKENS.dark['focus']!]
    // The ring sits 2px outside the element, on the page colour (its ring offset), beside cards.
    for (const bg of LIGHT) expect(contrast(light, bg), `light ring on ${hexOf(bg)}`).toBeGreaterThanOrEqual(GRAPHIC)
    for (const bg of DARK) expect(contrast(dark, bg), `dark ring on ${hexOf(bg)}`).toBeGreaterThanOrEqual(GRAPHIC)
    // forge-400, the light ring before the fix, was 2.17:1 on anvil-50.
    expect(contrast(rgb((colors['forge'] as Record<string, string>)['400']!), rgb(anvil['50']!))).toBeLessThan(GRAPHIC)
  })

  it('the global focus rule uses the token', () => {
    const css = readFileSync(join(root, 'app/globals.css'), 'utf8')
    expect(/:focus-visible\s*\{[^}]*ring-focus\b/.exec(css)).not.toBeNull()
  })

  it.each(Object.entries(STATE_TEXT))('%s state text on every surface, both themes', (_, klass) => {
    const variable = /^text-(state-[a-z]+)$/.exec(klass)?.[1] as string
    const [light, dark] = [TOKENS.light[variable]!, TOKENS.dark[variable]!]
    for (const bg of LIGHT) expect(contrast(light, bg), `${variable} on ${hexOf(bg)}`).toBeGreaterThanOrEqual(AA_TEXT)
    for (const bg of DARK) expect(contrast(dark, bg), `${variable} on ${hexOf(bg)}`).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it.each(Object.entries(STATE_FILL))('%s state badge: white text on its fill, both themes', (_, klass) => {
    const hexes = tokenHexes(/^bg-(.+)$/.exec(klass)?.[1] as string)
    expect(hexes).toBeDefined()
    for (const hex of hexes!) expect(contrast(rgb('#ffffff'), rgb(hex)), hex).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('state colours are not the trust colours', () => {
    const trust = ['verify', 'verify-700', 'verify-400', 'danger', 'danger-700', 'danger-400', 'dash', 'dash-600', 'dash-700', 'forge-700'].map((t) => tokenHex(t))
    for (const klass of [...Object.values(STATE_TEXT), ...Object.values(STATE_FILL)]) {
      for (const hex of tokenHexes(klass.replace(/^(?:text|bg)-/, '')) ?? []) expect(trust, klass).not.toContain(hex)
    }
  })
})
