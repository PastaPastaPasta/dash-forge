/**
 * FG-2: where references in Markdown link (L-38 impersonation, L-39 #N, L-40 cross-repo refs).
 */

import { describe, expect, it } from 'vitest'

import { splitRefs } from './markdown'
import { importedHost, importedUrlOf, refTarget, upstreamItemUrl, type RefContext } from './ref-targets'

const DASH = { host: 'github.com', path: 'dashpay/dash' }
const native: RefContext = { source: null, imported: null }
const mirrorNative: RefContext = { source: DASH, imported: null }
const imported: RefContext = { source: DASH, imported: 'github.com' }

const targets = (s: string, ctx: RefContext) => splitRefs(s).flatMap((p) => (p.t === 'text' ? [] : [refTarget(p, ctx)]))

describe('importedHost: which forge imported content speaks for', () => {
  it('believes github.com, gitlab.com and the repo\'s own described source', () => {
    expect(importedHost('https://github.com/dashpay/dash/issues/7512', null)).toBe('github.com')
    expect(importedHost('https://gitlab.com/g/p/-/issues/2', null)).toBe('gitlab.com')
    expect(importedHost('https://git.example.org/g/p/-/issues/2', { host: 'git.example.org', path: 'g/p' })).toBe('git.example.org')
  })

  it('is null for native content and for a host nothing vouches for', () => {
    for (const url of [null, undefined, '', 'not a url', 'http://github.com/a/b/issues/1', 'https://evil.example/a/b/issues/1', 'https://u:p@github.com/a/b/issues/1', 'javascript:alert(1)']) {
      expect(importedHost(url, DASH), String(url)).toBeNull()
    }
  })

  it('reads imported.url from the provenance object', () => {
    expect(importedUrlOf({ url: 'https://github.com/o/r/issues/1', author: 'bob' })).toBe('https://github.com/o/r/issues/1')
    expect(importedUrlOf(null)).toBe('')
    expect(importedUrlOf({ url: 5 })).toBe('')
  })
})

describe('mentions (L-38)', () => {
  it('native @name is a Forge profile (a DPNS name)', () => {
    expect(targets('@Alice', native)).toEqual([{ kind: 'profile', name: 'alice' }])
  })

  it('imported @login goes to that login on the source forge, case kept, never to a Forge profile', () => {
    expect(targets('@coffseducation and @PastaPastaPasta', imported)).toEqual([
      { kind: 'external', url: 'https://github.com/coffseducation' },
      { kind: 'external', url: 'https://github.com/PastaPastaPasta' },
    ])
  })

  it('a GitHub bot mention keeps [bot] and goes to its app page', () => {
    expect(targets('@coderabbitai[bot]', imported)).toEqual([{ kind: 'external', url: 'https://github.com/apps/coderabbitai' }])
  })

  it('the importer\'s provenance line links its author upstream', () => {
    expect(targets('> Mirrored from github.com/dashpay/dash#6935 by @coffseducation (issue, 2025-11-02)', imported)).toContainEqual({
      kind: 'external',
      url: 'https://github.com/coffseducation',
    })
  })
})

describe('#N and owner/name#N (L-39, L-40, L-51)', () => {
  it('#N goes to the number resolver; imported content marks the number as the source\'s', () => {
    expect(targets('#12', native)).toEqual([{ kind: 'number', repo: null, n: 12, upstream: false }])
    expect(targets('(#5017)', imported)).toEqual([{ kind: 'number', repo: null, n: 5017, upstream: true }])
  })

  it('the mirrored repo\'s own owner/name#N is this repo', () => {
    expect(targets('dashpay/dash#7511', imported)).toEqual([{ kind: 'number', repo: null, n: 7511, upstream: true }])
    expect(targets('DashPay/Dash#7511', mirrorNative)).toEqual([{ kind: 'number', repo: null, n: 7511, upstream: false }])
  })

  it('another repo named in imported content is on the source forge', () => {
    expect(targets('dashpay/platform#4344', imported)).toEqual([{ kind: 'external', url: 'https://github.com/dashpay/platform/issues/4344' }])
  })

  it('another repo named in native content is a Forge repo', () => {
    expect(targets('alice/tools#3', native)).toEqual([{ kind: 'number', repo: { owner: 'alice', name: 'tools' }, n: 3, upstream: false }])
  })

  it('GitLab sources use GitLab\'s URL layout', () => {
    const gl: RefContext = { source: { host: 'gitlab.com', path: 'g/p' }, imported: 'gitlab.com' }
    expect(targets('other/proj#2 other/proj@1898d8f7', gl)).toEqual([
      { kind: 'external', url: 'https://gitlab.com/other/proj/-/issues/2' },
      { kind: 'external', url: 'https://gitlab.com/other/proj/-/commit/1898d8f7' },
    ])
  })
})

describe('commit ids (L-40, L-67)', () => {
  it('a bare id is a commit of this repo, whatever the origin', () => {
    expect(targets('1898d8f7ac7', imported)).toEqual([{ kind: 'commit', repo: null, oid: '1898d8f7ac7' }])
    expect(targets('dashpay/dash@1898d8f7ac7', imported)).toEqual([{ kind: 'commit', repo: null, oid: '1898d8f7ac7' }])
  })

  it('another repo\'s commit in imported content is on the source forge', () => {
    expect(targets('bitcoin/bitcoin@1898d8f7ac7', imported)).toEqual([{ kind: 'external', url: 'https://github.com/bitcoin/bitcoin/commit/1898d8f7ac7' }])
  })
})

describe('the #N resolver (L-39)', () => {
  it('leaves a native [bot] mention as text: a GitHub app has no Forge profile (review finding 9)', () => {
    expect(targets('@dependabot[bot]', native)).toEqual([null])
  })

  it('links to the source\'s item when the mirror did not copy it', () => {
    expect(upstreamItemUrl(DASH, 7580)).toBe('https://github.com/dashpay/dash/issues/7580')
    expect(upstreamItemUrl({ host: 'gitlab.com', path: 'g/p' }, 2)).toBe('https://gitlab.com/g/p/-/issues/2')
    expect(upstreamItemUrl(null, 1)).toBeNull()
  })
})
