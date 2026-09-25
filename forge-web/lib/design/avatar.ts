/**
 * The identity pill's stub avatar fill: a deterministic hue per identity, darkened until the
 * white initial on it clears WCAG AA (4.5:1).
 *
 * A fixed `hsl(h 45% 45%)` failed for yellow-green hues (2.58:1 at hue 60): at equal HSL
 * lightness, yellows and greens are far brighter than blues. So the lightness starts at 45%
 * and steps down per hue until the contrast holds. `lib/design/contrast.test.ts` checks all
 * 360 hues.
 */

/** Deterministic hue from the identity id so the stub avatar is stable per identity. */
export function avatarHue(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) % 360
  }
  return hash
}

const SATURATION = 0.45
const START_LIGHTNESS = 0.45
const AA_TEXT = 4.5

/** HSL (h in degrees, s/l in 0..1) to 8-bit sRGB. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return [r1 + m, g1 + m, b1 + m].map((v) => Math.round(v * 255)) as [number, number, number]
}

/** WCAG relative luminance of an 8-bit sRGB colour. */
export function luminance([r, g, b]: readonly [number, number, number]): number {
  const lin = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Contrast ratio of white text on `rgb`. */
export function whiteContrast(rgb: readonly [number, number, number]): number {
  return 1.05 / (luminance(rgb) + 0.05)
}

/** The avatar fill for `hue`, as a CSS `hsl()` string, with white text at ≥ 4.5:1. */
export function avatarFill(hue: number): string {
  let l = START_LIGHTNESS
  while (l > 0.05 && whiteContrast(hslToRgb(hue, SATURATION, l)) < AA_TEXT) l -= 0.01
  return `hsl(${hue} ${SATURATION * 100}% ${Math.round(l * 100)}%)`
}
