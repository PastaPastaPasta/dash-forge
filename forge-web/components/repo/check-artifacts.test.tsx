// @vitest-environment jsdom
/**
 * A check run's artifacts in the Checks tab: each is offered for download and saved only once its
 * bytes hash to the SHA-256 the run records (the release-asset download); a mismatch is shown,
 * never saved.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CheckRun, ChecksSummary } from '@/lib/repo/checks'
import { AssetHashMismatchError } from '@/lib/view/release-download'
import { ChecksTab } from './pull-tabs'

const { download, save } = vi.hoisted(() => ({
  download: vi.fn<() => Promise<Uint8Array>>(),
  save: vi.fn(),
}))
vi.mock('@/lib/view/release-download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/view/release-download')>()),
  downloadVerifiedAsset: download,
  saveBytes: save,
}))
vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RUN: CheckRun = {
  id: 'run1',
  name: 'ci / build',
  status: 'completed',
  conclusion: 'success',
  detailsUrl: '',
  summary: 'forge-runner: success; 1 artifact(s)',
  reporter: 'runner',
  trusted: true,
  createdAt: 1,
  startedAt: 0,
  completedAt: 0,
  logUrl: '',
  externalId: '',
  logSha256: '',
  artifacts: [{ name: 'dist.zip', sha256: 'a'.repeat(64), size: 248, uris: ['https://bucket.example/ci/packs/x.pack'] }],
  requiredSource: null,
  fromRequiredSource: true,
}
const SUMMARY: ChecksSummary = { passed: 1, failing: 0, pending: 0, total: 1, untrusted: 0, offSource: 0, membersKnown: true }

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  download.mockReset()
  save.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (runs: CheckRun[]) =>
  act(() => root.render(<ChecksTab runs={runs} summary={SUMMARY} headOid={'b'.repeat(40)} error={null} onRetry={() => undefined} />))

describe("a check run's artifacts", () => {
  it('are listed with a download that saves only verified bytes', async () => {
    download.mockResolvedValue(new Uint8Array([1, 2, 3]))
    render([RUN])
    const box = host.querySelector('[data-testid="check-artifacts"]')
    expect(box?.textContent).toContain('1 artifact')
    expect(box?.textContent).toContain('dist.zip')
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Download dist.zip"]')
    expect(button).not.toBeNull()
    await act(async () => button?.click())
    expect(download).toHaveBeenCalledWith(RUN.artifacts[0], expect.any(Function))
    expect(save).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 'dist.zip')
    expect(host.textContent).toContain('Verified: the SHA-256 matched')
  })

  it('are not saved when the storage serves other bytes', async () => {
    download.mockRejectedValue(new AssetHashMismatchError('bucket.example', 'c'.repeat(64), 'a'.repeat(64)))
    render([RUN])
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Download dist.zip"]')?.click())
    expect(save).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="release-asset"]')?.getAttribute('data-state')).toBe('mismatch')
  })

  it('are not shown for a run that has none', () => {
    render([{ ...RUN, artifacts: [] }])
    expect(host.querySelector('[data-testid="check-artifacts"]')).toBeNull()
  })
})
