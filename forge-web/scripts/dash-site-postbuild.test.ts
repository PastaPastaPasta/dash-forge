/** The forg3.dash.site build: docs pages become redirects, and the SDK wasm is listed only when it is npm's file. */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { cspProblem } from './csp-hashes.mjs'
import { checkSiteOrigin, docsBase, externalAssets, redirectDocs, siteOrigin } from './dash-site-postbuild.mjs'

const made: string[] = []
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function exportDir(): string {
  const out = mkdtempSync(join(tmpdir(), 'dash-site-'))
  made.push(out)
  for (const page of ['', 'quick-start', 'install']) {
    mkdirSync(join(out, 'docs', page), { recursive: true })
    writeFileSync(join(out, 'docs', page, 'index.html'), '<html>a long rendered guide</html>')
    writeFileSync(join(out, 'docs', page, 'index.txt'), 'rsc payload')
  }
  mkdirSync(join(out, '_next/static/wasm'), { recursive: true })
  return out
}

function wasmPackage(bytes: Buffer, version = '5.0.0-rc.8'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wasm-sdk-'))
  made.push(dir)
  mkdirSync(join(dir, 'dist/raw'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@dashevo/wasm-sdk', version }))
  writeFileSync(join(dir, 'dist/raw/wasm_sdk_bg.wasm'), bytes)
  return dir
}

describe('dash-site postbuild', () => {
  it('requires the dash.site address the build is published at, not forge.dashhq.org', () => {
    expect(siteOrigin('https://forg3.dash.site')).toBe('https://forg3.dash.site')
    expect(siteOrigin('https://forg3.dash.site/')).toBe('https://forg3.dash.site')
    expect(() => siteOrigin(undefined)).toThrow(/NEXT_PUBLIC_SITE_URL/)
    expect(() => siteOrigin('https://forge.dashhq.org')).toThrow(/forge\.dashhq\.org/)
    for (const bad of ['http://forg3.dash.site', 'https://forg3.dash.site/x', 'https://forg3.dash.site?a', 'https://u:p@forg3.dash.site']) {
      expect(() => siteOrigin(bad)).toThrow(/plain https origin/)
    }
  })

  it('checks that the export was built for that address', () => {
    const out = exportDir()
    writeFileSync(join(out, 'index.html'), '<link rel="canonical" href="https://forg3.dash.site/">')
    expect(() => checkSiteOrigin(out, 'https://forg3.dash.site')).not.toThrow()
    writeFileSync(join(out, 'index.html'), '<link rel="canonical" href="https://forge.dashhq.org/">')
    expect(() => checkSiteOrigin(out, 'https://forg3.dash.site')).toThrow(/was NEXT_PUBLIC_SITE_URL set/)
  })

  it('accepts only a plain https docs URL', () => {
    expect(docsBase('https://forge.dashhq.org/docs/')).toBe('https://forge.dashhq.org/docs')
    expect(docsBase('https://u:p@forge.dashhq.org/a"b<c/')).toBe('https://forge.dashhq.org/a%22b%3Cc')
    expect(docsBase('https://forge.dashhq.org/')).toBe('https://forge.dashhq.org')
    expect(() => docsBase('http://forge.dashhq.org/docs')).toThrow()
    expect(() => docsBase('https://forge.dashhq.org/docs?x=1')).toThrow()
    expect(() => docsBase(undefined)).toThrow(/FORGE_DOCS_URL/)
  })

  it('replaces every docs page with a redirect to the same page on the docs host', () => {
    const out = exportDir()
    const pages = redirectDocs(out, 'https://forge.dashhq.org/docs')
    expect(pages).toEqual(['/docs/', '/docs/install/', '/docs/quick-start/'])
    expect(existsSync(join(out, 'docs/quick-start/index.txt'))).toBe(false)
    expect(existsSync(join(out, 'docs/index.txt'))).toBe(false)
    const html = readFileSync(join(out, 'docs/quick-start/index.html'), 'utf8')
    expect(html).toContain('content="0;url=https://forge.dashhq.org/docs/quick-start/"')
    expect(readFileSync(join(out, 'docs/index.html'), 'utf8')).toContain('url=https://forge.dashhq.org/docs/"')
    // The anchor of an in-app link (#who-enforces-what) is kept, under a CSP that allows only this script.
    expect(html).toContain('location.replace("https://forge.dashhq.org/docs/quick-start/"+location.hash)')
    expect(cspProblem(html, 'redirect')).toBeNull()
  })

  it('lists the wasm with its SHA-384 when it is the package file, and refuses a different file', () => {
    const out = exportDir()
    const bytes = Buffer.from('wasm bytes')
    writeFileSync(join(out, '_next/static/wasm/wasm_sdk_bg.0123456789abcdef.wasm'), bytes)
    expect(externalAssets(out, wasmPackage(bytes))).toEqual({
      '/_next/static/wasm/wasm_sdk_bg.0123456789abcdef.wasm': {
        npm: '@dashevo/wasm-sdk',
        version: '5.0.0-rc.8',
        path: 'dist/raw/wasm_sdk_bg.wasm',
        integrity: `sha384-${createHash('sha384').update(bytes).digest('base64')}`,
      },
    })
    expect(() => externalAssets(out, wasmPackage(Buffer.from('rebuilt')))).toThrow(/differs from @dashevo\/wasm-sdk/)
    expect(() => externalAssets(out, wasmPackage(bytes, '^5.0.0'))).toThrow(/unexpected package/)
    writeFileSync(join(out, '_next/static/wasm/wasm_sdk_bg.fedcba9876543210.wasm'), bytes)
    expect(() => externalAssets(out, wasmPackage(bytes))).toThrow(/expected one/)
  })
})
