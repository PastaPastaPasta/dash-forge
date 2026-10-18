// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { dgNetworkFlags } from '@/lib/view/repo-commands'
import type { GithubRepo, MirrorCliSettings } from '@/lib/mirror/wizard'

vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ balance: null, isLoading: false }) }))
vi.mock('@/components/auth/master-key-input', () => ({ useMasterKeyInput: () => ({ ready: false, element: <div data-testid="master-input" />, error: null }) }))

const { CliStep, KeyStep, ReadyCard } = await import('./mirror-steps')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GITHUB: GithubRepo = { owner: 'alice', name: 'Project', description: '', defaultBranch: 'main', sizeKib: 1, archived: false, fork: false, htmlUrl: '' }
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
function Form({ initial }: { initial: MirrorCliSettings }): JSX.Element {
  const [settings, setSettings] = useState(initial)
  return <CliStep github={GITHUB} settings={settings} onSettings={setSettings} />
}
async function fill(id: string, value: string): Promise<void> {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(`#${id}`)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const commands = (): string => [...host.querySelectorAll('code')].map((c) => c.textContent).join('\n')

describe('CliStep', () => {
  it('updates commands live and copies the current command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await act(async () => root.render(<Form initial={{ name: 'project', collab: false, cap: '0.2' }} />))
    expect(commands()).toContain("--repo project --sync code,releases --max-spend 0.2")
    expect(commands()).toContain(dgNetworkFlags(ACTIVE_NETWORK))
    expect(host.querySelector('input[type="checkbox"]')?.getAttribute('checked')).toBeNull()
    await fill('mirror-cli-name', 'my-copy')
    await fill('mirror-cli-cap', '0.5')
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(commands()).toContain('--repo my-copy --sync all --max-spend 0.5 --state my-copy.sync.json')
    expect(commands()).toContain('dg auth login <identity file> --budget 0.5')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy the import command"]')!.click())
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('--repo my-copy --sync all --max-spend 0.5'))
    expect(host.querySelector('a[href^="/github.com/alice/Project"]')).not.toBeNull()
    expect(host.textContent).toContain('replaces its branches and tags')
  })

  it('withholds commands for an invalid name or cap', async () => {
    await act(async () => root.render(<Form initial={{ name: '', collab: false, cap: '0.2' }} />))
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect(host.querySelector('code')).toBeNull()
    await fill('mirror-cli-name', '.github')
    expect(host.querySelector('code')).toBeNull()
    await fill('mirror-cli-name', 'valid')
    expect(host.querySelector('code')).not.toBeNull()
    for (const cap of ['0', '5000']) {
      await fill('mirror-cli-cap', cap)
      expect(host.querySelector('code')).toBeNull()
    }
    expect(host.textContent).toContain('The cap must be 1000 DASH or less.')
    await fill('mirror-cli-cap', '1000')
    expect(host.querySelector('code')).not.toBeNull()
  })
})

describe('ReadyCard', () => {
  it('opens the existing repo, keeps the import destination qualified, and offers Action setup', async () => {
    const setup = vi.fn()
    await act(async () => root.render(<ReadyCard identity="Owner111" github={GITHUB} repo={{ name: 'existing' }} onSetup={setup} />))
    expect(commands()).toContain('--repo Owner111/existing')
    expect(host.textContent).toContain('dg import writes into existing and replaces its branches and tags to match GitHub.')
    expect(host.querySelectorAll('h4')).toHaveLength(3)
    expect(host.querySelectorAll('h3')).toHaveLength(1)
    expect(host.querySelector<HTMLInputElement>('#mirror-cli-name')!.readOnly).toBe(true)
    expect(host.querySelector('a')!.getAttribute('href')).toContain('owner=Owner111&name=existing')
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Set up the Action')!.click())
    expect(setup).toHaveBeenCalledOnce()
  })
})

describe('KeyStep', () => {
  it('offers exclusive forms and a network-specific dg command for the repo owner', async () => {
    const done = vi.fn()
    await act(async () => root.render(<KeyStep identity="Owner111" github={GITHUB} record={null} suggestedBudget="0.5" secret={null} onCreated={() => undefined} onDone={done} />))
    expect(host.querySelector('[data-testid="master-input"]')).not.toBeNull()
    expect(host.textContent).toContain('Signed in with a wallet?')
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click())
    expect(host.querySelector('[data-testid="master-input"]')).toBeNull()
    expect(commands()).toContain(`-o runner.dfk1 ${dgNetworkFlags(ACTIVE_NETWORK)}`)
    expect(host.textContent).toContain('A key of another identity needs its own access to this repo.')
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'I added DASH_FORGE_KEY')!.click())
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ keyId: -1, saved: true }))
  })
})
