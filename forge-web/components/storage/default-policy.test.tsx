// @vitest-environment jsdom
/**
 * "Where browser pushes go" in a DOM (L-10): the saved default shows ticked, Save stays disabled
 * with nothing ticked and says why, and "Saved." follows only a real write, never a null or
 * unchanged policy.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_STORAGE_CONFIG, policyFor, withFirstDefault, withProfile, type StorageConfig, type StorageProfile } from '@/lib/storage'
import { DefaultPolicy } from './storage-wizard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MINIO: StorageProfile = {
  name: 'minio-e2e',
  settings: { kind: 's3', provider: 'minio', endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', bucket: 'forge-byo', pathStyle: true, publicUrl: 'https://pub.example/forge-byo', prefix: '' },
  secrets: { accessKeyId: 'k', secretAccessKey: 's' },
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Render the form over a config that `save` really updates, as the vault-backed hook does. */
async function mount(initial: StorageConfig): Promise<{ saves: StorageConfig[] }> {
  const saves: StorageConfig[] = []
  let config = initial
  const save = vi.fn(async (next: StorageConfig) => {
    saves.push(next)
    config = next
    await act(async () => root.render(<DefaultPolicy config={config} storable save={save} />))
  })
  await act(async () => root.render(<DefaultPolicy config={config} storable save={save} />))
  return { saves }
}

const checkbox = (name: string): HTMLInputElement => {
  const label = [...host.querySelectorAll('label')].find((l) => l.textContent?.includes(name))
  const input = label?.querySelector('input[type="checkbox"]')
  if (!(input instanceof HTMLInputElement)) throw new Error(`no checkbox ${name}`)
  return input
}
const saveButton = (): HTMLButtonElement => {
  const b = [...host.querySelectorAll('button')].find((x) => /save default/i.test(x.textContent ?? ''))
  if (!(b instanceof HTMLButtonElement)) throw new Error('no Save default')
  return b
}
const status = (): string => host.querySelector('[data-testid="default-policy-status"]')?.textContent ?? ''

describe('DefaultPolicy (L-10)', () => {
  it('shows the first profile ticked (it became the default when added), with nothing to save', async () => {
    await mount(withFirstDefault(withProfile(EMPTY_STORAGE_CONFIG, MINIO), MINIO.name))
    expect(checkbox('minio-e2e').checked).toBe(true)
    expect(saveButton().disabled).toBe(true)
    expect(status()).toBe('This is your saved default.')
  })

  it('disables Save with nothing ticked, says why, and never writes a null policy', async () => {
    const { saves } = await mount(withProfile(EMPTY_STORAGE_CONFIG, MINIO))
    expect(checkbox('minio-e2e').checked).toBe(false)
    expect(saveButton().disabled).toBe(true)
    expect(status()).toMatch(/Tick at least one place/)
    expect(saveButton().getAttribute('aria-describedby')).toBe(host.querySelector('[data-testid="default-policy-status"]')?.id)
    await act(async () => saveButton().click())
    expect(saves).toEqual([])
    expect(status()).not.toBe('Saved.')
  })

  it('says "Saved." only after writing a real policy, and clears it on the next edit', async () => {
    const { saves } = await mount(withProfile(EMPTY_STORAGE_CONFIG, MINIO))
    await act(async () => checkbox('minio-e2e').click())
    expect(saveButton().disabled).toBe(false)
    await act(async () => saveButton().click())
    expect(saves.map((c) => c.defaultPolicy)).toEqual([policyFor(['minio-e2e'], 'one')])
    expect(status()).toBe('Saved.')
    // Saved and unchanged: nothing more to save.
    expect(saveButton().disabled).toBe(true)
    // Unticking the only place: back to the explanation, and Save stays disabled.
    await act(async () => checkbox('minio-e2e').click())
    expect(status()).toMatch(/Tick at least one place/)
    expect(saveButton().disabled).toBe(true)
  })
})
