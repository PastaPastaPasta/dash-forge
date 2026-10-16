/**
 * public/.well-known/security.txt (RFC 9116): the static export serves it at forge.dashhq.org, and
 * the build manifest lists it like any other file of the build (`dg verify-app` checks it).
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { buildManifest } from './build-manifest.mjs'

const PUBLIC_FILE = join(dirname(fileURLToPath(import.meta.url)), '../public/.well-known/security.txt')

const fields = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf(': ')
      return [l.slice(0, i), l.slice(i + 2)] as const
    })

const get = (text: string, name: string) => fields(text).filter(([k]) => k === name).map(([, v]) => v)

describe('security.txt', () => {
  const text = readFileSync(PUBLIC_FILE, 'utf8')

  it('has the fields RFC 9116 requires, and the project contacts', () => {
    expect(get(text, 'Contact')).toEqual([
      'mailto:security@dashhq.org',
      'https://github.com/PastaPastaPasta/dash-forge/security/advisories/new',
    ])
    const expires = get(text, 'Expires')
    expect(expires).toHaveLength(1)
    expect(expires[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    expect(Number.isNaN(Date.parse(expires[0] ?? ''))).toBe(false)
    expect(get(text, 'Canonical')).toEqual(['https://forge.dashhq.org/.well-known/security.txt'])
    expect(get(text, 'Policy')).toEqual(['https://github.com/PastaPastaPasta/dash-forge/blob/master/SECURITY.md'])
    expect(get(text, 'Preferred-Languages')).toEqual(['en'])
  })

  it('is plain ASCII with Unix line ends', () => {
    expect(text).toMatch(/^[\x20-\x7e\n]+$/)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('lands in the build manifest even though it sits in a dot directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'security-txt-'))
    mkdirSync(join(dir, '.well-known'), { recursive: true })
    writeFileSync(join(dir, '.well-known/security.txt'), text)
    const m = buildManifest(dir, {})
    expect(Object.keys(m.files)).toEqual(['.well-known/security.txt'])
  })
})
