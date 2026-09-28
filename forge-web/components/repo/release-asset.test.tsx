// @vitest-environment jsdom
/**
 * A release asset row in a DOM (D-056): an asset this page may read is downloaded and verified
 * in the tab; when that download fails (the host refused the read, the network dropped), the row
 * offers the origin links and the local SHA-256 check instead of leaving a dead end.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReleaseAssetView } from '@/lib/repo'
import { AssetRow } from './releases-content'

const { download } = vi.hoisted(() => ({ download: vi.fn<() => Promise<Uint8Array>>() }))
vi.mock('@/lib/view/release-download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/view/release-download')>()),
  downloadVerifiedAsset: download,
  saveBytes: vi.fn(),
}))
vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** An asset on the owner's own https storage: a host that lets pages read it. */
const ASSET: ReleaseAssetView = {
  name: 'tool-1.0.0-x86_64.tar.gz',
  sha256: 'a'.repeat(64),
  size: 13,
  uris: ['https://downloads.example.org/tool/1.0.0/tool-1.0.0-x86_64.tar.gz'],
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  download.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const row = (): HTMLElement => host.querySelector<HTMLElement>('[data-testid="release-asset"]')!
const downloadButton = (): HTMLButtonElement | null => row().querySelector<HTMLButtonElement>('button[aria-label^="Download "]')
const direct = (): HTMLElement | null => row().querySelector<HTMLElement>('[data-testid="direct-download"]')

describe('a browser-readable release asset (D-056)', () => {
  it('offers a verified in-tab Download and no origin fallback until one fails', () => {
    act(() => root.render(<AssetRow asset={ASSET} />))
    expect(row().dataset['state']).toBe('idle')
    expect(downloadButton()).not.toBeNull()
    expect(direct()).toBeNull()
  })

  it('a failed download falls back to the origin link and the local SHA-256 check', async () => {
    download.mockRejectedValue(new TypeError('Failed to fetch'))
    act(() => root.render(<AssetRow asset={ASSET} />))
    await act(async () => downloadButton()!.click())
    expect(download).toHaveBeenCalledTimes(1)
    expect(row().dataset['state']).toBe('error')
    expect(row().textContent).toContain("Couldn't download in the browser: Failed to fetch")
    const fallback = direct()!
    expect(fallback.textContent).toContain('Download from the origin instead')
    expect(fallback.querySelector('a')!.getAttribute('href')).toBe(ASSET.uris[0])
    expect(fallback.textContent).toContain('Check a downloaded file')
  })
})
