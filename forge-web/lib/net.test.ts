/**
 * Parity with forge-core `storage/publish.rs`: both run every case of
 * `forge-contracts/fixtures/public-urls.json`, so the web's rules for what a manifest may
 * record and the CLI's cannot drift.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { isPrivateHost, isPublicHttpsUrl, isTemporaryHost } from './net'

interface UrlCase {
  readonly url: string
  readonly public: boolean
  readonly private: boolean | null
  readonly problem: string | null
}

const FIXTURE = resolve(process.cwd(), '..', 'forge-contracts', 'fixtures', 'public-urls.json')
const CASES = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { urls: UrlCase[] }).urls

describe('public URL vectors (shared with forge-core)', () => {
  it('has the cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40)
  })

  it.each(CASES)('$url', (c) => {
    expect(isPublicHttpsUrl(c.url)).toBe(c.public)
    if (c.private !== null) expect(isPrivateHost(new URL(c.url).hostname)).toBe(c.private)
    if (c.public) expect(isTemporaryHost(new URL(c.url).hostname)).toBe(c.problem === 'temporary-tunnel')
  })
})
