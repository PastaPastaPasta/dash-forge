/** The forg3.dash.site build: docs pages become redirects, and the SDK wasm is listed only when it is npm's file. */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { docsBase, externalAssets, redirectDocs } from './dash-site-postbuild.mjs'

function exportDir(): string {
  const out = mkdtempSync(join(tmpdir(), 'dash-site-'))
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
  mkdirSync(join(dir, 'dist/raw'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@dashevo/wasm-sdk', version }))
  writeFileSync(join(dir, 'dist/raw/wasm_sdk_bg.wasm'), bytes)
  return dir
}

describe('dash-site postbuild', () => {
  it('accepts only a plain https docs URL', () => {
    expect(docsBase('https://forge.dashhq.org/docs/')).toBe('https://forge.dashhq.org/docs')
    expect(() => docsBase('http://forge.dashhq.org/docs')).toThrow()
    expect(() => docsBase('https://forge.dashhq.org/docs?x=1')).toThrow()
    expect(() => docsBase(undefined)).toThrow(/FORGE_DOCS_URL/)
  })

  it('replaces every docs page with a redirect to the same page on the docs host', () => {
    const out = exportDir()
    const pages = redirectDocs(out, 'https://forge.dashhq.org/docs')
    expect(pages).toEqual(['/docs/', '/docs/install/', '/docs/quick-start/'])
    expect(existsSync(join(out, 'docs/quick-start/index.txt'))).toBe(false)
    const html = readFileSync(join(out, 'docs/quick-start/index.html'), 'utf8')
    expect(html).toContain('content="0;url=https://forge.dashhq.org/docs/quick-start/"')
    expect(readFileSync(join(out, 'docs/index.html'), 'utf8')).toContain('url=https://forge.dashhq.org/docs/"')
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
  })
})
