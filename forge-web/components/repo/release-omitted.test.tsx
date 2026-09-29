// @vitest-environment jsdom
/**
 * An imported release in a DOM (showcase beta.6: dashpay/dash lost 621 assets to the 4,096-byte
 * `assets` field, and 747 kept no SHA-256 when the hashing budget ran out):
 *
 * - the importer's footer becomes "N more assets not mirrored" with a link to the source release,
 *   and is not rendered as part of the notes;
 * - an asset with no recorded hash but an https original reads "not verified yet" and links the
 *   original instead of a dead download.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReleaseAssetView } from '@/lib/repo'
import { NOT_VERIFIED_YET, omittedAssets } from '@/lib/repo/releases'
import { AssetRow, OmittedAssetsNote } from './releases-content'

vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SOURCE = 'https://github.com/dashpay/dash/releases/tag/v23.1.8'
/** What forge-import writes (`model::assets_footer`), for 5 of 21 assets left out. */
const NOTES = `Dash Core v23.1.8 is a patch release.\n\n---\n_forge-import: 5 of 21 assets are not mirrored here (a release lists at most 4,096 bytes of them). Download them from the [source release](${SOURCE})._`

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('omitted assets (showcase beta.6)', () => {
  it("splits forge-import's footer off the notes", () => {
    const { body, omitted } = omittedAssets(NOTES)
    expect(body).toBe('Dash Core v23.1.8 is a patch release.')
    expect(omitted).toEqual({ count: 5, total: 21, sourceUrl: SOURCE })
    // No link when the importer knew no source page; ordinary notes are left alone.
    expect(omittedAssets('x\n\n---\n_forge-import: 2 of 3 assets are not mirrored here (a release lists at most 4,096 bytes of them)._').omitted).toEqual({
      count: 2,
      total: 3,
      sourceUrl: null,
    })
    expect(omittedAssets('see _forge-import: 5 of 21 assets are not mirrored here (x)._ above\nmore').omitted).toBeNull()
    expect(omittedAssets('plain notes').body).toBe('plain notes')
  })

  it('says how many assets are not mirrored and links the source release', () => {
    const { omitted } = omittedAssets(NOTES)
    act(() => root.render(<OmittedAssetsNote omitted={omitted!} />))
    const note = host.querySelector<HTMLElement>('[data-testid="release-assets-omitted"]')!
    expect(note.textContent).toContain('5 more assets not mirrored (16 of 21 listed here)')
    const link = note.querySelector('a')!
    expect(link.getAttribute('href')).toBe(SOURCE)
    expect(link.textContent).toBe('All assets at github.com')
  })
})

describe('an imported asset not hashed yet', () => {
  const UNHASHED: ReleaseAssetView = {
    name: 'dashcore-19.0.0-rc.6-x86_64-linux-gnu.tar.gz',
    sha256: '',
    size: 40_000_000,
    uris: ['https://github.com/dashpay/dash/releases/download/v19.0.0-rc.6/dashcore-19.0.0-rc.6-x86_64-linux-gnu.tar.gz'],
  }

  it('reads "not verified yet" and links the original, with no in-tab download', () => {
    act(() => root.render(<AssetRow asset={UNHASHED} />))
    const row = host.querySelector<HTMLElement>('[data-testid="release-asset"]')!
    expect(row.dataset['state']).toBe('unverified')
    expect(row.textContent).toContain('not verified yet')
    expect(row.textContent).toContain(NOT_VERIFIED_YET)
    expect(row.querySelector('button')).toBeNull()
    const link = row.querySelector<HTMLAnchorElement>('a[aria-label^="Download "]')!
    expect(link.getAttribute('href')).toBe(UNHASHED.uris[0])
    // No "check a downloaded file": there is no hash to check it against.
    expect(row.querySelector('[data-testid="direct-download"]')).toBeNull()
  })

  it('with no public https original it stays unverifiable, with nothing to download', () => {
    act(() => root.render(<AssetRow asset={{ ...UNHASHED, uris: ['http://10.0.0.5/a.tar.gz'] }} />))
    const row = host.querySelector<HTMLElement>('[data-testid="release-asset"]')!
    expect(row.dataset['state']).toBe('unverifiable')
    expect(row.querySelector('a')).toBeNull()
  })
})
