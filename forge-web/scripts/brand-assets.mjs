#!/usr/bin/env node
/**
 * Render the site's share card and app icons into `public/` with Playwright's Chromium:
 *  - `og.png` (1200x630): the card a link preview shows (og:image, twitter:image);
 *  - `icons/icon-192.png`, `icons/icon-512.png`, `icons/icon-maskable-512.png` (web manifest),
 *    `icons/apple-touch-icon.png` (180x180).
 * The images are committed; run this again only when the brand or the tagline changes.
 *
 * Usage: node scripts/brand-assets.mjs
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

// tailwind.config.js: forge-500, anvil-950, anvil-50, anvil-400.
const EMBER = '#f97316'
const NIGHT = '#0f0d0c'
const PAPER = '#fafaf9'
const MUTED = '#a8a29e'

// lucide `Hammer` (the header's mark), 24x24 viewBox.
const HAMMER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${EMBER}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/></svg>`

const FONT = `font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;`

/** The square mark: the hammer on a dark tile. `pad` is the hammer's inset (maskable icons need more). */
function icon(size, pad) {
  const inner = Math.round(size * (1 - 2 * pad))
  return `<html><body style="margin:0;width:${size}px;height:${size}px;background:${NIGHT};display:flex;align-items:center;justify-content:center">
  <div style="width:${inner}px;height:${inner}px">${HAMMER.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`
}

const OG = `<html><body style="margin:0;width:1200px;height:630px;background:${NIGHT};${FONT};color:${PAPER};display:flex;flex-direction:column;justify-content:center;padding:0 96px;box-sizing:border-box">
  <div style="display:flex;align-items:center;gap:20px">
    <div style="width:72px;height:72px;border-radius:16px;background:rgba(249,115,22,0.15);display:flex;align-items:center;justify-content:center">
      <div style="width:44px;height:44px">${HAMMER.replace('<svg ', '<svg width="100%" height="100%" ')}</div>
    </div>
    <div style="font-size:40px;font-weight:600;letter-spacing:-0.5px">Dash Forge</div>
  </div>
  <div style="margin-top:56px;font-size:68px;font-weight:700;line-height:1.1;letter-spacing:-1.5px">A git forge with<br><span style="color:${EMBER}">no server to trust.</span></div>
  <div style="margin-top:32px;font-size:30px;line-height:1.4;color:${MUTED}">Repositories, issues and pull requests on Dash Platform,<br>checked by your own browser.</div>
</body></html>`

const SHOTS = [
  { file: 'og.png', width: 1200, height: 630, html: OG },
  { file: 'icons/icon-192.png', width: 192, height: 192, html: icon(192, 0.2) },
  { file: 'icons/icon-512.png', width: 512, height: 512, html: icon(512, 0.2) },
  { file: 'icons/icon-maskable-512.png', width: 512, height: 512, html: icon(512, 0.28) },
  { file: 'icons/apple-touch-icon.png', width: 180, height: 180, html: icon(180, 0.2) },
]

const browser = await chromium.launch()
try {
  for (const s of SHOTS) {
    const page = await browser.newPage({ viewport: { width: s.width, height: s.height } })
    await page.setContent(s.html)
    const out = join(PUBLIC, s.file)
    mkdirSync(dirname(out), { recursive: true })
    await page.screenshot({ path: out, omitBackground: false })
    await page.close()
    console.log(out)
  }
} finally {
  await browser.close()
}
