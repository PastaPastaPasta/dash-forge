// @vitest-environment jsdom
/**
 * Repo Settings → Storage after a reload (the tab kept only the signing key): its own unlock,
 * unless the page already offers one above (a locked private repo's Collaborators), so a private
 * repo's Settings shows a single unlock.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storage = { needsUnlock: true }
vi.mock('@/hooks/use-storage-config', () => ({
  useStorageConfig: () => ({ config: null, loading: false, error: null, storable: true, needsUnlock: storage.needsUnlock, save: async () => undefined, reload: () => undefined, discard: async () => undefined }),
}))
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ identity: 'me', vaults: [{ identityId: 'me', methods: ['passphrase'] }], controller: { unlockMore: async () => undefined }, isLoading: false }),
}))

import { RepoStoragePolicy } from './repo-storage-policy'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  storage.needsUnlock = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = async (unlockAbove?: boolean): Promise<void> => {
  await act(async () => {
    root.render(<RepoStoragePolicy repoId="R" {...(unlockAbove === undefined ? {} : { unlockAbove })} />)
  })
}
const q = (id: string): Element | null => host.querySelector(`[data-testid="${id}"]`)

describe('the repo Storage section of a tab that needs an unlock', () => {
  it('offers its own unlock by default', async () => {
    await render()
    expect(q('storage-unlock')).not.toBeNull()
    expect(q('storage-unlock-above')).toBeNull()
  })

  it('points to the unlock above instead of a second prompt', async () => {
    await render(true)
    expect(q('storage-unlock')).toBeNull()
    expect(q('storage-unlock-above')?.textContent).toMatch(/the unlock under Members opens them as well/)
    expect(q('storage-unlock-above')?.querySelector('a')?.getAttribute('href')).toBe('#members-unlock')
  })

  it('points above too when this browser has no storage settings yet (a signing-only tab still needs the unlock, #216)', async () => {
    // needsUnlock with nothing stored: config stays null until the unlock, as with stored settings.
    storage.needsUnlock = true
    await render(true)
    expect(q('storage-unlock')).toBeNull()
    expect(q('storage-unlock-above')).not.toBeNull()
    expect(host.textContent).not.toMatch(/No storage set up/)
  })

  it('says nothing about unlocking once the settings are open', async () => {
    storage.needsUnlock = false
    await render(true)
    expect(q('storage-unlock')).toBeNull()
    expect(q('storage-unlock-above')).toBeNull()
  })
})
