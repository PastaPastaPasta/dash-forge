// @vitest-environment jsdom
/**
 * The merge's storage answer in a DOM: the cap allowed before the run covers the pack and its
 * index fragment together (each Platform copy spends from it), and when the run has to ask, the
 * question is announced and focused where the run is shown.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef } from '@/lib/repo'
import { estimateChunkCredits } from '@/lib/sdk/cost'
import { withinPreAgreement } from '@/lib/storage/merge-choice'
import type { StoreOptions } from '@/lib/storage'
import { StorageRow, useMergeUpload, type MergeUpload } from './merge-upload'

vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'me' }, identity: 'me' }) }))
vi.mock('@/hooks/use-storage-config', () => ({ useStorageConfig: () => ({ config: { profiles: [], policies: [] }, usable: { profiles: [], policies: [] }, needsUnlock: false, sealed: false }) }))
// Platform storage as the real `storeArtifact` gates it: ask unless the copy fits the cap.
const asked: number[] = []
vi.mock('@/lib/storage', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/storage')>()
  return {
    ...real,
    policyForRepo: () => null,
    storeArtifact: async (_sdk: unknown, _auth: unknown, _repo: unknown, bytes: Uint8Array, opts: StoreOptions) => {
      const estimateCredits = estimateChunkCredits(bytes.length)
      if (!withinPreAgreement(opts.preAgreedCredits ?? null, estimateCredits)) {
        asked.push(bytes.length)
        if (!(await opts.confirmPlatform({ bytes: bytes.length, estimateCredits, reason: 'No storage is configured.' }))) throw new real.PlatformDeclinedError()
      }
      return { packHash: 'h', sizeBytes: bytes.length, storage: 0, chunkCount: 1, uris: ['platform://x'], confirmed: ['platform'], failures: [] }
    },
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { repoId: 'R', name: 'repo', visibility: 'public' } as unknown as RepoRef
let host: HTMLDivElement
let root: Root
let hook: MergeUpload
function Harness(): JSX.Element {
  hook = useMergeUpload(repo)
  return <div>{hook.question}</div>
}
beforeEach(() => {
  asked.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Harness />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const pack = new Uint8Array(40_000)
const fragment = new Uint8Array(20_000)

describe('the storage answer given before the merge', () => {
  it('covers the pack and its fragment together: a fragment past what the pack left asks', async () => {
    // Allowed exactly the pack's price and nothing more: the pack goes, the fragment must ask.
    act(() => hook.begin(estimateChunkCredits(pack.length)))
    await act(async () => {
      await hook.upload!(pack, { packHash: 'p', objectCount: 3 })
    })
    expect(asked).toEqual([])
    let stored: Promise<unknown> = Promise.resolve()
    await act(async () => {
      stored = hook.upload!(fragment, { packHash: 'f', objectCount: 3 })
    })
    expect(asked).toEqual([fragment.length])
    // The run is waiting: the question is announced (a live region) and focused.
    const q = host.querySelector('[data-testid="storage-question"]')
    expect(q).not.toBeNull()
    const alert = q!.querySelector('[role="alert"]')
    expect(alert?.textContent).toMatch(/Waiting for your choice/)
    // It is the index asking, on its own step, at its own price.
    expect(hook.questionStep).toBe('index')
    expect(alert?.textContent).toMatch(/store the browse index/)
    expect(document.activeElement).toBe(alert)
    await act(async () => {
      ;(Array.from(q!.querySelectorAll('button')).find((b) => /sign & store/i.test(b.textContent ?? '')) as HTMLButtonElement).click()
      await stored
    })
    expect(host.querySelector('[data-testid="storage-question"]')).toBeNull()
  })

  it('does not take focus from a field being typed in', async () => {
    const field = document.createElement('textarea')
    document.body.appendChild(field)
    field.focus()
    act(() => hook.begin(null))
    await act(async () => {
      void hook.upload!(pack, { packHash: 'p', objectCount: 3 }).catch(() => undefined)
    })
    expect(host.querySelector('[data-testid="storage-question"] [role="alert"]')).not.toBeNull()
    expect(document.activeElement).toBe(field)
    field.remove()
  })

  it('a cap covering both stores both without a question', async () => {
    act(() => hook.begin(estimateChunkCredits(pack.length) + estimateChunkCredits(fragment.length)))
    await act(async () => {
      await hook.upload!(pack, { packHash: 'p', objectCount: 3 })
      await hook.upload!(fragment, { packHash: 'f', objectCount: 3 })
    })
    expect(asked).toEqual([])
  })

  it('a new attempt starts from its own cap again', async () => {
    act(() => hook.begin(estimateChunkCredits(pack.length)))
    await act(async () => {
      await hook.upload!(pack, { packHash: 'p', objectCount: 3 })
    })
    act(() => hook.begin(estimateChunkCredits(pack.length)))
    await act(async () => {
      await hook.upload!(pack, { packHash: 'p', objectCount: 3 })
    })
    expect(asked).toEqual([])
  })
})

describe('the Storage row', () => {
  it('is locked while a run is going (its cap was fixed when it started)', () => {
    const choice = { label: 'Dash Platform (no storage configured)', platform: { kind: 'only', reason: 'r' }, platformCredits: 1_000_000, allowByDefault: true } as const
    act(() => root.render(<StorageRow choice={choice} allowed onAllow={() => undefined} disabled />))
    const box = host.querySelector('[data-testid="allow-platform"]') as HTMLInputElement
    expect(box.disabled).toBe(true)
    // The price is described, not part of the checkbox's name.
    expect(box.closest('label')?.querySelector('[data-testid="cost-preview"]')).toBeNull()
    expect(document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/DASH/)
  })
})
