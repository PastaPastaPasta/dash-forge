// @vitest-environment jsdom
/**
 * QW-022: New pull request's "Need to push a branch first?" names a remote the viewer can push
 * to. It used to build `dash://<viewer>/<this repo's name>`, a repository that usually does not
 * exist: a member now gets this repo's own address, anyone else their fork's (by its real name)
 * or a Fork button, and a signed-out reader both routes.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef } from '@/lib/repo'

const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const ME = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'

let identity: string | null = ME
let role: { role: 'maintainer' | 'writer' | null; known: boolean; failed: boolean } = { role: null, known: true, failed: false }

vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ ...role, retry: () => undefined }) }))
vi.mock('@/components/repo/fork-button', () => ({ ForkButton: () => <button type="button">Fork</button> }))

import { PushBranchHint, pushCommand, pushHintOf } from './push-branch-hint'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { forge: {}, repoId: 'R', ownerId: OWNER, name: 'qa-collab-settings', visibility: 'public' } as unknown as RepoRef
const fork = { forge: {}, repoId: 'F', ownerId: ME, name: 'qa-collab-fork', visibility: 'public' } as unknown as RepoRef
const known = (r: 'maintainer' | 'writer' | null) => ({ role: r, known: true, failed: false })

describe('pushHintOf', () => {
  it("gives a maintainer or writer this repo's own address, never one under their own id", () => {
    for (const r of ['maintainer', 'writer'] as const) {
      const hint = pushHintOf({ repo, identity: ME, role: known(r), forks: [] })
      expect(hint).toEqual({ kind: 'member', command: `git push dash://${OWNER}/qa-collab-settings HEAD:my-fix` })
    }
  })

  it("points a non-member at their fork by the fork's own name", () => {
    const hint = pushHintOf({ repo, identity: ME, role: known(null), forks: [fork] })
    expect(hint).toEqual({ kind: 'fork', forks: [{ name: 'qa-collab-fork', command: `git push dash://${ME}/qa-collab-fork HEAD:my-fix` }] })
  })

  it('asks a non-member without a fork to fork first', () => {
    expect(pushHintOf({ repo, identity: ME, role: known(null), forks: [] })).toEqual({ kind: 'fork-first' })
  })

  it('waits for the role and the forks rather than guessing', () => {
    expect(pushHintOf({ repo, identity: ME, role: { role: null, known: false, failed: false }, forks: [] }).kind).toBe('loading')
    expect(pushHintOf({ repo, identity: ME, role: known(null), forks: null }).kind).toBe('loading')
  })

  it('names both routes when signed out or the role read failed', () => {
    const either = { kind: 'either', command: pushCommand(OWNER, 'qa-collab-settings'), canFork: true }
    expect(pushHintOf({ repo, identity: null, role: known(null), forks: null })).toEqual(either)
    expect(pushHintOf({ repo, identity: ME, role: { role: null, known: false, failed: true }, forks: [] })).toEqual(either)
  })

  it("still points at the viewer's fork when the role read failed", () => {
    expect(pushHintOf({ repo, identity: ME, role: { role: null, known: false, failed: true }, forks: [fork] }).kind).toBe('fork')
  })

  it("never offers this repo's command to a known non-member whose forks could not be read", () => {
    expect(pushHintOf({ repo, identity: ME, role: known(null), forks: 'failed' })).toEqual({ kind: 'either', command: null, canFork: true })
  })

  it('never offers a fork of a private repo', () => {
    const priv = { ...repo, visibility: 'private' } as RepoRef
    expect(pushHintOf({ repo: priv, identity: ME, role: known(null), forks: null })).toEqual({ kind: 'members-only' })
    expect(pushHintOf({ repo: priv, identity: null, role: known(null), forks: null })).toMatchObject({ kind: 'either', canFork: false })
    expect(pushHintOf({ repo: priv, identity: ME, role: known('writer'), forks: null }).kind).toBe('member')
  })

  it('quotes a name a shell would treat specially', () => {
    expect(pushCommand(OWNER, "a b'c")).toBe(`git push 'dash://${OWNER}/a b'\\''c' HEAD:my-fix`)
  })
})

describe('PushBranchHint', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    identity = ME
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const render = (forks: readonly RepoRef[] | null | 'failed'): void => {
    act(() => root.render(<PushBranchHint repo={repo} forks={forks} />))
  }

  it('shows a Fork button, and no push command, to a non-member without a fork', () => {
    role = known(null)
    render([])
    expect(host.querySelector('[data-testid="push-hint"]')?.getAttribute('data-kind')).toBe('fork-first')
    expect(host.textContent).toContain('Fork it and push your branch to the fork')
    expect(host.querySelector('code')).toBeNull()
    expect(host.querySelector('button')?.textContent).toBe('Fork')
  })

  it("shows the fork's push command to its owner", () => {
    role = known(null)
    render([fork])
    expect(host.querySelector('code')?.textContent).toBe(`git push dash://${ME}/qa-collab-fork HEAD:my-fix`)
    expect(host.textContent).not.toContain(`${ME}/qa-collab-settings`)
  })

  it('renders nothing until it knows', () => {
    role = { role: null, known: false, failed: false }
    render(null)
    expect(host.querySelector('[data-testid="push-hint"]')).toBeNull()
  })
})
