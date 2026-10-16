// @vitest-environment jsdom
/**
 * The /mirror wizard's GitHub step (LEG-10, FEAT-18): it shows the licence GitHub detected, warns
 * when there is none, notes that LFS is not mirrored, and does not go on until the person ticks
 * that they have the right to copy the repository. Another repository asks again.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GithubRepo } from '@/lib/mirror/wizard'

const answers = vi.hoisted(() => ({ next: null as unknown }))
vi.mock('@/lib/mirror/wizard', async (orig) => ({
  ...(await orig<typeof import('@/lib/mirror/wizard')>()),
  checkGithubRepo: async () => answers.next,
}))

const { GithubStep } = await import('./mirror-steps')
const { LFS_NOTE, RIGHTS_ACKNOWLEDGEMENT } = await import('@/lib/mirror/wizard')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = (over: Partial<GithubRepo> = {}): GithubRepo => ({
  owner: 'alice',
  name: 'project',
  description: 'A tool',
  defaultBranch: 'main',
  sizeKib: 120,
  archived: false,
  fork: false,
  htmlUrl: 'https://github.com/alice/project',
  license: 'MIT',
  ...over,
})

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

const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`)

async function check(found: GithubRepo, onDone: (r: GithubRepo) => void = () => undefined, text = 'alice/project'): Promise<void> {
  answers.next = found
  await act(async () => {
    root.render(<GithubStep initial={null} onDone={onDone} />)
  })
  const input = host.querySelector<HTMLInputElement>('#mirror-github')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}
const mirrorButton = (): HTMLButtonElement => [...host.querySelectorAll('button')].find((b) => /^Mirror /.test(b.textContent ?? ''))!

describe('GithubStep', () => {
  it('shows the detected licence, the LFS note and the acknowledgement, and waits for the tick', async () => {
    const done = vi.fn()
    await check(repo(), done)
    expect(q('mirror-license')?.textContent).toContain('Licence detected by GitHub: MIT')
    expect(q('mirror-license')?.textContent).not.toMatch(/no licence/)
    expect(host.textContent).toContain(LFS_NOTE)
    expect(q('mirror-rights')?.textContent).toBe(RIGHTS_ACKNOWLEDGEMENT)
    expect(mirrorButton().disabled).toBe(true)
    await act(async () => mirrorButton().click())
    expect(done).not.toHaveBeenCalled()

    await act(async () => q('mirror-rights')!.querySelector('input')!.click())
    expect(mirrorButton().disabled).toBe(false)
    await act(async () => mirrorButton().click())
    expect(done).toHaveBeenCalledOnce()
    expect(done.mock.calls[0]![0]).toMatchObject({ owner: 'alice', name: 'project' })
  })

  it('warns when GitHub detects no licence, and still needs the tick', async () => {
    await check(repo({ license: null }))
    expect(q('mirror-license')?.textContent).toContain('GitHub detects no licence for this repository')
    expect(mirrorButton().disabled).toBe(true)
  })

  it('warns about a licence it cannot name', async () => {
    await check(repo({ license: 'Other' }))
    expect(q('mirror-license')?.textContent).toContain('a licence it cannot name')
  })

  it('says the same about a repository saved before the licence was read', async () => {
    const { license: _license, ...old } = repo()
    await check(old)
    expect(q('mirror-license')?.textContent).toContain('checked before its licence was read')
    expect(q('mirror-license')?.textContent).not.toContain('detects no licence')
  })

  it('asks again for the next repository checked', async () => {
    await check(repo())
    await act(async () => q('mirror-rights')!.querySelector('input')!.click())
    expect(mirrorButton().disabled).toBe(false)
    answers.next = repo({ name: 'other', htmlUrl: 'https://github.com/alice/other' })
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(q('mirror-rights')!.querySelector('input')!.checked).toBe(false)
    expect(mirrorButton().disabled).toBe(true)
  })

  it('tells a person who is not the repository’s owner to mirror only what they may copy', async () => {
    await check(repo())
    expect(q('mirror-license')?.textContent).toMatch(/Mirror a repository you own, or one whose licence lets you copy it/)
  })
})
