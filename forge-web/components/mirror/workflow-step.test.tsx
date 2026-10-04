// @vitest-environment jsdom
/**
 * The /mirror wizard's workflow step (QW4-045): issues and PRs are off by default, as in the
 * Action and as the step's own hint advises; the cost cap says why it is above the Action's
 * 0.05; and the Copy button sits above the YAML, not over it.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GithubRepo, UsableMirrorStorage } from '@/lib/mirror/wizard'

const COMMIT = 'a'.repeat(40)
vi.mock('@/lib/mirror/wizard', async (orig) => ({
  ...(await orig<typeof import('@/lib/mirror/wizard')>()),
  latestCommit: async () => COMMIT,
}))

const { WorkflowStep } = await import('./mirror-steps')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GITHUB: GithubRepo = {
  owner: 'alice',
  name: 'project',
  description: '',
  defaultBranch: 'main',
  sizeKib: 120,
  archived: false,
  fork: false,
  htmlUrl: 'https://github.com/alice/project',
}
const S3: UsableMirrorStorage = { ok: true, kind: 's3', inputs: [['storage-kind', 's3']], secrets: [] }

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

async function render(): Promise<void> {
  await act(async () => {
    root.render(<WorkflowStep identity="IdentityAAA" github={GITHUB} repoName="project" storage={S3} profile={null} secret={null} runnerKey={null} onDone={() => undefined} />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
const yaml = (): string => host.querySelector('[data-testid="mirror-yaml"] pre')?.textContent ?? ''
const collabBox = (): HTMLInputElement =>
  [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((c) => /Mirror issues and pull requests too/.test(c.closest('label')?.textContent ?? ''))!

describe('WorkflowStep defaults (QW4-045)', () => {
  it('syncs code and releases unless issues and PRs are ticked, and says why its cap is above the Action default', async () => {
    await render()
    expect(collabBox().checked).toBe(false)
    expect(yaml()).toContain("sync: 'code,releases'")
    expect(yaml()).not.toContain('pull_request_target')
    expect(yaml()).toContain("cost-cap: '0.1'")
    expect(host.textContent).toMatch(/above the Action's default of 0\.05 DASH because the first run copies everything/)
    await act(async () => collabBox().click())
    expect(yaml()).toContain("sync: 'code,releases,labels,issues,prs'")
    expect(yaml()).toContain('pull_request_target')
  })

  it('puts the Copy button in a bar above the YAML, not over it', async () => {
    await render()
    const block = host.querySelector('[data-testid="mirror-yaml"]')!
    const copy = block.querySelector('button[aria-label="Copy the workflow file"]')!
    const pre = block.querySelector('pre')!
    expect(copy.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(copy.className).not.toMatch(/\babsolute\b/)
    expect(pre.contains(copy)).toBe(false)
  })
})
