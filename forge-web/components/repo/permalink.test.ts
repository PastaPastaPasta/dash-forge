/**
 * Permalinks (F-5): the link a browse view copies pins the commit, travels as a GitHub-style short
 * URL the 404 shim expands back to the same view (with its `#L` range), and never puts a private
 * repo's decrypted path into an address.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: () => undefined }) }))

import { RESERVED_SEGMENTS, shortUrlShimScript } from '@/lib/short-url'
import { sealRepoUrls } from '@/lib/view/private-nav'
import { permalinkPath, pinnedHref } from './permalink'

const OID = '0123456789abcdef0123456789abcdef01234567'
const ALICE = { owner: 'alice', name: 'project' }

/** A route's pathname, params (order- and encoding-independent) and fragment. */
function route(href: string | null): { path: string; params: Record<string, string>; hash: string } | null {
  if (href === null) return null
  const u = new URL(href, 'https://x.invalid')
  return { path: u.pathname, params: Object.fromEntries(u.searchParams), hash: u.hash }
}

/** Run the 404 shim over `pathname` + `hash`, as a static host serving 404.html would. */
function viaShim(pathname: string, hash = ''): string | null {
  const replaced: string[] = []
  const location = { pathname, search: '', hash, replace: (to: string) => replaced.push(to) }
  new Function('location', 'document', shortUrlShimScript(''))(location, { documentElement: { setAttribute: () => undefined } })
  return replaced[0] ?? null
}

describe('permalinkPath', () => {
  it('is the short blob URL at the commit, and the shim expands it to the pinned route', () => {
    const short = permalinkPath(ALICE, 'blob', OID, 'src/a b.rs')
    expect(short).toBe(`/alice/project/blob/${OID}/src/a%20b.rs`)
    // The `#L` range survives the rewrite, so the expanded page selects and scrolls to it.
    expect(route(viaShim(short, '#L10-L20'))).toEqual(route(`${pinnedHref(ALICE, 'blob', OID, 'src/a b.rs')}#L10-L20`))
  })

  it('pins a directory, and the repo root, the same way', () => {
    expect(permalinkPath(ALICE, 'tree', OID, 'crates/core')).toBe(`/alice/project/tree/${OID}/crates/core`)
    expect(route(viaShim(permalinkPath(ALICE, 'tree', OID, '')))).toEqual(route(pinnedHref(ALICE, 'tree', OID, '')))
  })

  it('keeps the canonical route for an address the short form cannot carry', () => {
    // A `?repo=` pin, a DPNS owner with a dot, and an owner that is one of the app's own routes.
    for (const addr of [{ ...ALICE, repoId: 'R' }, { owner: 'alice.dash', name: 'project' }, { owner: RESERVED_SEGMENTS[0] as string, name: 'x' }]) {
      const link = permalinkPath(addr, 'blob', OID, 'a.rs')
      expect(link).toBe(pinnedHref(addr, 'blob', OID, 'a.rs'))
      expect(link).toContain(`ref=${OID}`)
    }
  })

  it('never puts a private repo’s file name in the link', () => {
    const secret = { owner: 'bob', name: 'vault' }
    sealRepoUrls(secret)
    const link = permalinkPath(secret, 'blob', OID, 'plans/secret.md')
    expect(link).not.toContain('secret.md')
    const parsed = route(link)
    expect(parsed?.path).toBe('/repo/blob/')
    expect(parsed?.params['path']).toMatch(/^~[0-9a-f]{16}$/)
    expect(parsed?.params['ref']).toMatch(/^~[0-9a-f]{16}$/)
  })
})
