import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BASE_SCRIPT, checkStylesheet, postbuild, relativizeHtml, relativizePayload } from './ipfs-postbuild.mjs'

// The shape of an exported page (trimmed from `out/explore/index.html`).
const PAGE =
  '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>' +
  '<link rel="stylesheet" href="/_next/static/css/61de.css" data-precedence="next"/>' +
  '<script src="/_next/static/chunks/main-app-c33c.js" async=""></script></head><body>' +
  '<a class="x" href="/explore/">Explore</a><a href="/">Discover</a>' +
  '<a href="https://github.com/PastaPastaPasta/dash-forge">GitHub</a><a href="//cdn.example/x">cdn</a>' +
  '<script>self.__next_f.push([1,"[\\"$\\",\\"link\\",\\"0\\",{\\"rel\\":\\"stylesheet\\",\\"href\\":\\"/_next/static/css/61de.css\\"}]"])</script>' +
  '</body></html>'

describe('the IPFS variant of a page', () => {
  const out = relativizeHtml(PAGE)

  it('sets a <base> before any asset URL is read', () => {
    expect(out.startsWith(`<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><script>${BASE_SCRIPT}</script><link`)).toBe(true)
  })

  it('makes asset URLs base-relative, in attributes and in the inline RSC payload alike', () => {
    expect(out).toContain('href="_next/static/css/61de.css"')
    expect(out).toContain('src="_next/static/chunks/main-app-c33c.js"')
    expect(out).toContain('\\"href\\":\\"_next/static/css/61de.css\\"')
    expect(out).not.toMatch(/["']\/_next\//)
  })

  it('makes root links base-relative and leaves other links alone', () => {
    expect(out).toContain('<a class="x" href="./explore/">')
    expect(out).toContain('<a href="./">Discover</a>')
    expect(out).toContain('href="https://github.com/PastaPastaPasta/dash-forge"')
    expect(out).toContain('href="//cdn.example/x"')
  })

  it('refuses a page it does not recognise, and a root-relative URL it cannot rewrite', () => {
    expect(() => relativizeHtml('<html><head><title>x</title></head></html>', 'odd.html')).toThrow(/odd\.html/)
    expect(() => relativizeHtml(PAGE.replace('</body>', "<img src='/_next/image.png'></body>"))).toThrow(/root-relative/)
    expect(() => relativizeHtml(PAGE.replace('</head>', '<link rel="icon" href="/favicon.ico"/></head>'))).toThrow(/root-relative/)
  })
})

describe('a stylesheet', () => {
  it('may not load anything root-relative', () => {
    expect(() => checkStylesheet('a{background:url(../media/x.woff2)}')).not.toThrow()
    expect(() => checkStylesheet('a{background:url(//cdn.example/x.png)}')).not.toThrow()
    expect(() => checkStylesheet('@font-face{src:url(/_next/static/media/x.woff2)}', 'x.css')).toThrow(/x\.css/)
  })
})

describe('the base script', () => {
  type Anchor = { attrs: Record<string, string>; getAttribute: (k: string) => string | null; setAttribute: (k: string, v: string) => void }
  const anchor = (href: string): Anchor => {
    const attrs: Record<string, string> = { href }
    return { attrs, getAttribute: (k) => attrs[k] ?? null, setAttribute: (k, v) => void (attrs[k] = v) }
  }

  /** The script run for a page at `pathname`: the <base href> it set, and its listeners. */
  function run(pathname: string, search = ''): { base: string; location: { pathname: string; search: string }; fire: (type: string, a: Anchor) => void } {
    let base = ''
    const listeners: Record<string, (e: unknown) => void> = {}
    const location = { pathname, search }
    const document = {
      createElement: () => ({}),
      head: { appendChild: (e: { href: string }) => void (base = e.href) },
      addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] = fn),
    }
    new Function('location', 'document', BASE_SCRIPT)(location, document)
    return { base, location, fire: (type, a) => listeners[type]?.({ target: { closest: () => a } }) }
  }

  it('sets the gateway path on a path gateway, and the root anywhere else', () => {
    expect(run('/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/repo/tree/').base).toBe(
      '/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/',
    )
    expect(run('/ipns/forge.example/explore/').base).toBe('/ipns/forge.example/')
    expect(run('/explore/').base).toBe('/')
    expect(run('/').base).toBe('/')
  })

  it('points an in-page link at this page before it is followed, not at the base', () => {
    const page = run('/ipfs/bafy/repo/', '?owner=a&name=b')
    const a = anchor('#readme')
    page.fire('pointerdown', a)
    expect(a.attrs['href']).toBe('/ipfs/bafy/repo/?owner=a&name=b#readme')
    // After a client-side navigation, the same link follows the page it is now on.
    page.location.pathname = '/ipfs/bafy/repo/tree/'
    page.location.search = '?owner=a&name=b&path=src'
    page.fire('focusin', a)
    expect(a.attrs['href']).toBe('/ipfs/bafy/repo/tree/?owner=a&name=b&path=src#readme')
    // React giving it a new fragment wins over the kept one.
    a.attrs['href'] = '#L10'
    page.fire('contextmenu', a)
    expect(a.attrs['href']).toBe('/ipfs/bafy/repo/tree/?owner=a&name=b&path=src#L10')
  })

  it('leaves every other link alone', () => {
    const page = run('/explore/')
    for (const href of ['./repo/?owner=a', 'https://github.com/x', '/ipfs/other/']) {
      const a = anchor(href)
      page.fire('pointerdown', a)
      expect(a.attrs).toEqual({ href })
    }
  })
})

describe('an RSC payload', () => {
  it('gets base-relative asset URLs too', () => {
    const txt = '0:["x",[[["",{"children":["explore"]},[["$","link","0",{"rel":"stylesheet","href":"/_next/static/css/61de.css"}]]]]]]'
    expect(relativizePayload(txt)).toContain('"href":"_next/static/css/61de.css"')
  })
})

describe('a whole export', () => {
  it('is rewritten in place, pages and payloads, leaving _next/ alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipfs-postbuild-'))
    try {
      mkdirSync(join(dir, 'explore'))
      mkdirSync(join(dir, '_next/static/chunks'), { recursive: true })
      writeFileSync(join(dir, 'index.html'), PAGE)
      writeFileSync(join(dir, 'explore/index.html'), PAGE)
      writeFileSync(join(dir, 'explore/index.txt'), '"href":"/_next/static/css/61de.css"')
      const chunk = 'x="/_next/static/"'
      writeFileSync(join(dir, '_next/static/chunks/a.js'), chunk)
      expect(postbuild(dir)).toEqual({ pages: 2, payloads: 1 })
      expect(readFileSync(join(dir, 'explore/index.html'), 'utf8')).toContain(BASE_SCRIPT)
      expect(readFileSync(join(dir, 'explore/index.txt'), 'utf8')).toBe('"href":"_next/static/css/61de.css"')
      expect(readFileSync(join(dir, '_next/static/chunks/a.js'), 'utf8')).toBe(chunk)
      // A second run refuses rather than adding a second <base>.
      expect(() => postbuild(dir)).toThrow(/already rewritten/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
