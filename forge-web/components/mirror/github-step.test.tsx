// @vitest-environment jsdom
/**
 * The /mirror wizard's GitHub step (LEG-10, FEAT-18): it shows the licence GitHub detected, warns
 * when there is none, notes that LFS is not mirrored, and does not go on until the person ticks
 * that they have the right to copy the repository. Another repository asks again.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: answers.sdk, network: 'devnet' }) }))
vi.mock('@/lib/view/discovery', () => ({ MIRROR_NAMED_PAGES: 5, reposNamed: async () => answers.named }))

import type { GithubRepo } from '@/lib/mirror/wizard'

const answers = vi.hoisted(() => ({ next: null as unknown, checks: 0, sdk: null as unknown, named: { repos: [] as unknown[], more: false } }))
vi.mock('@/lib/mirror/wizard', async (orig) => ({
  ...(await orig<typeof import('@/lib/mirror/wizard')>()),
  checkGithubRepo: async () => {
    answers.checks++
    if (answers.next instanceof Error) throw answers.next
    return answers.next
  },
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
  answers.checks = 0
  answers.sdk = null
  answers.named = { repos: [], more: false }
  window.history.replaceState(null, '', '/mirror/')
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

describe('GithubStep: the command line and URL prefill', () => {
  it('needs Continue but no rights checkbox on the CLI path', async () => {
    const done = vi.fn()
    await act(async () => root.render(<GithubStep initial={repo()} way="cli" onDone={done} />))
    expect(q('mirror-rights')).toBeNull()
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Continue')!
    expect(button.disabled).toBe(false)
    expect(done).not.toHaveBeenCalled()
    await act(async () => button.click())
    expect(done).toHaveBeenCalledWith(repo())
  })

  it('checks a URL prefill once, after progress settles, without answering', async () => {
    answers.next = repo()
    const done = vi.fn()
    await act(async () => root.render(<GithubStep initial={null} way="cli" prefill="alice/project" settled={false} onDone={done} />))
    expect(q('mirror-github-found')).toBeNull()
    expect(answers.checks).toBe(0)
    await act(async () => root.render(<GithubStep initial={null} way="cli" prefill="alice/project" settled onDone={done} />))
    expect(q('mirror-github-found')).not.toBeNull()
    expect(done).not.toHaveBeenCalled()
    expect(host.querySelector<HTMLInputElement>('#mirror-github')!.value).toBe('alice/project')
    await act(async () => root.render(<GithubStep initial={null} way="cli" prefill="alice/project" settled onDone={done} />))
    expect(answers.checks).toBe(1)
  })
})

describe('GithubStep: informational hints', () => {
  it('links private sources to the private import guide', async () => {
    const { GithubCheckError } = await import('@/lib/mirror/wizard')
    answers.next = new GithubCheckError('not-found', 'not found, or it is private')
    await act(async () => root.render(<GithubStep initial={null} way="cli" prefill="alice/private" onDone={() => undefined} />))
    expect(host.textContent).toContain("Private on GitHub? This page can't check it.")
    expect(host.querySelector('a[href$="#into-a-private-repository"]')).not.toBeNull()
  })

  it.each([false, true])('shows mirror claims without blocking, partial=%s', async (more) => {
    answers.sdk = {}
    answers.named = { more, repos: [{ key: 'r1', ownerId: 'owner', slug: 'project', visibility: 'public', description: 'Mirror of github.com/alice/project' }] }
    await check(repo())
    expect(host.textContent).toContain(`${more ? 'At least ' : ''}1 Forge repos say they mirror github.com/alice/project`)
    expect(host.textContent).toContain('Anyone can keep their own copy.')
    expect(host.querySelector('a[href^="/github.com/alice/project"]')).not.toBeNull()
  })
})
