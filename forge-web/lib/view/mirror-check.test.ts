import { afterEach, describe, expect, it, vi } from 'vitest'
import { backlinkFile } from '../rules/mirror-backlink'
import { backlinkUrl, checkedClaim, checkMirrorClaim, clearMirrorChecks, githubRepoOf, newBacklinkUrl } from './mirror-check'
import { mirrorSourceOfDescription, type MirrorSource } from './mirror-source'

const REPO = 'BCrANpjYupbP3hJEfF9tNvz546Dhif8sFZWwwpeBpTyq'
const OID = 'a31fcf2'.padEnd(40, '0')
const SOURCE = mirrorSourceOfDescription('Mirror of github.com/dashpay/dips', 'issue') as MirrorSource

/** A GitHub that serves `file` (or 404 when null) and `branchOid` for any branch. */
function github(file: string | null, branchOid: string | null, status = 200): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      return file === null ? new Response('404: Not Found', { status: 404 }) : new Response(file, { status })
    }
    if (url.startsWith('https://api.github.com/')) {
      return branchOid === null ? new Response('{}', { status: 404 }) : new Response(branchOid, { status })
    }
    throw new Error(`unexpected ${url}`)
  }) as unknown as typeof fetch
}

afterEach(() => clearMirrorChecks())

describe('the source of a GitHub claim', () => {
  it('names owner and repo on github.com only', () => {
    expect(githubRepoOf(SOURCE)).toEqual({ owner: 'dashpay', name: 'dips' })
    expect(githubRepoOf(mirrorSourceOfDescription('Mirror of gitlab.com/g/p', 'issue') as MirrorSource)).toBeNull()
  })

  it('reads the file from the default branch and offers a prefilled new-file page', () => {
    expect(backlinkUrl({ owner: 'dashpay', name: 'dips' })).toBe('https://raw.githubusercontent.com/dashpay/dips/HEAD/.dash-forge.json')
    const url = new URL(newBacklinkUrl({ owner: 'dashpay', name: 'dips' }, 'master', backlinkFile([REPO])))
    expect(url.pathname).toBe('/dashpay/dips/new/master')
    expect(url.searchParams.get('filename')).toBe('.dash-forge.json')
    expect(url.searchParams.get('value')).toBe(backlinkFile([REPO]))
  })
})

describe('checking a mirror claim', () => {
  it('is confirmed when the source lists the repo and the branch matches', async () => {
    const c = await checkMirrorClaim(SOURCE, REPO, { branch: 'master', oid: OID }, github(backlinkFile([REPO]), OID))
    expect(c?.backlink).toEqual({ kind: 'listed' })
    expect(c?.head).toEqual({ kind: 'match', oid: OID })
  })

  it('is not confirmed when the source lists another repo, has no file, or a broken one', async () => {
    expect((await checkMirrorClaim(SOURCE, REPO, null, github(backlinkFile(['other']), null)))?.backlink).toEqual({ kind: 'not-listed' })
    clearMirrorChecks()
    expect((await checkMirrorClaim(SOURCE, REPO, null, github(null, null)))?.backlink).toEqual({ kind: 'none' })
    clearMirrorChecks()
    expect((await checkMirrorClaim(SOURCE, REPO, null, github('not json', null)))?.backlink).toEqual({ kind: 'none' })
  })

  it('says the branch differs, or that the source has none', async () => {
    const other = 'b'.repeat(40)
    expect((await checkMirrorClaim(SOURCE, REPO, { branch: 'master', oid: OID }, github(null, other)))?.head).toEqual({ kind: 'differs', upstream: other })
    clearMirrorChecks()
    expect((await checkMirrorClaim(SOURCE, REPO, { branch: 'master', oid: OID }, github(null, null)))?.head).toEqual({ kind: 'no-branch' })
  })

  it('never reads a failure as a match', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const c = await checkMirrorClaim(SOURCE, REPO, { branch: 'master', oid: OID }, down)
    expect(c?.backlink.kind).toBe('failed')
    expect(c?.head?.kind).toBe('failed')
    const limited = vi.fn(async () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })) as unknown as typeof fetch
    const r = await checkMirrorClaim(SOURCE, REPO, { branch: 'master', oid: OID }, limited)
    expect(r?.backlink.kind).toBe('failed')
    expect(r?.head).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/60 checks an hour/) })
  })

  it('keeps an answer for the session, and forgets a failed one', async () => {
    const f = github(backlinkFile([REPO]), OID)
    await checkMirrorClaim(SOURCE, REPO, null, f)
    expect(checkedClaim(SOURCE, REPO, null)).not.toBeNull()
    await checkMirrorClaim(SOURCE, REPO, null, f)
    expect(f).toHaveBeenCalledTimes(1)
    const down = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch
    await checkMirrorClaim(SOURCE, 'another', null, down)
    await Promise.resolve()
    expect(checkedClaim(SOURCE, 'another', null)).toBeNull()
  })

  it('does not check a source on another host', () => {
    expect(checkMirrorClaim(mirrorSourceOfDescription('Mirror of gitlab.com/g/p', 'issue') as MirrorSource, REPO, null, github(null, null))).toBeNull()
  })
})
