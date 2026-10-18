// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliStep, KeyStep, ReadyCard, StorageStep, WorkflowStep } from './mirror-steps'
import { FIAT_RATES_KEY, FIAT_SETTINGS_KEY, setFiatSettings } from '@/lib/fiat/store'
import { PLATFORM_STORAGE, type GithubRepo, type MirrorCliSettings } from '@/lib/mirror/wizard'
import { EMPTY_STORAGE_CONFIG } from '@/lib/storage'
import type { StorageConfigState } from '@/hooks/use-storage-config'

vi.mock('@/lib/constants', async (original) => {
  const m = await original<typeof import('@/lib/constants')>()
  return { ...m, ACTIVE_NETWORK: { ...m.ACTIVE_NETWORK, network: 'devnet', devnetName: 'sakura' } }
})
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ balance: null, isLoading: false }) }))
vi.mock('@/lib/mirror/wizard', async (original) => ({
  ...await original<typeof import('@/lib/mirror/wizard')>(),
  latestCommit: async () => 'a'.repeat(40),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const github: GithubRepo = { owner: 'octo', name: 'repo', sizeKib: 1024, description: '', defaultBranch: 'main', archived: false, fork: false, htmlUrl: '' }
const runnerKey = { keyId: 3, budgetCredits: '50000000000', expiresAt: 1_900_000_000_000, saved: true }
const storage: StorageConfigState = {
  config: EMPTY_STORAGE_CONFIG, usable: EMPTY_STORAGE_CONFIG, needsUnlock: false, storable: true,
  loading: false, error: null, sealed: false, storedSince: async () => false,
  save: async () => {}, reload: () => {}, discard: async () => {},
}
let host: HTMLDivElement
let root: Root
const render = async (element: JSX.Element): Promise<void> => { await act(async () => root.render(element)) }
const field = (id: string): HTMLElement => host.querySelector<HTMLInputElement>(`#${id}`)!.parentElement!
const fill = async (id: string, value: string): Promise<void> => {
  const input = host.querySelector<HTMLInputElement>(`#${id}`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  localStorage.setItem(FIAT_RATES_KEY, JSON.stringify({ v: 1, source: 'ctx', fetchedAt: Date.now(), rates: { USD: 40, EUR: 36 } }))
  localStorage.setItem(FIAT_SETTINGS_KEY, JSON.stringify({ v: 1, enabled: true, currency: 'USD' }))
  window.dispatchEvent(new StorageEvent('storage', { key: FIAT_SETTINGS_KEY }))
  window.dispatchEvent(new StorageEvent('storage', { key: FIAT_RATES_KEY }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('mirror fiat costs and budgets', () => {
  it('prices each storage estimate beside its DASH phrase', async () => {
    await render(<StorageStep storage={storage} github={github} initial={null} onDone={() => {}} />)
    expect(host.textContent).toContain('0.0055 DASH a push (≈ $0.22 on mainnet)')
    expect(host.textContent).toContain('0.39 DASH per MiB (≈ $15.60 on mainnet)')
    expect(host.textContent).toContain("0.39 DASH for this repository's first push (≈ $15.60 on mainnet)")
  })

  it('prices the displayed first-push minimum and omits the estimate for unknown size', async () => {
    await render(<StorageStep storage={storage} github={{ ...github, sizeKib: 1 }} initial={null} onDone={() => {}} />)
    expect(host.textContent).toContain("0.01 DASH for this repository's first push (≈ $0.40 on mainnet)")
    await render(<StorageStep storage={storage} github={{ ...github, sizeKib: 0 }} initial={null} onDone={() => {}} />)
    expect(host.textContent).not.toContain('first push')
    expect(host.querySelectorAll('[data-testid="fiat-note"]')).toHaveLength(2)
  })

  it('updates the runner budget bound as typed and hides it for invalid input', async () => {
    await render(<KeyStep identity="identity" github={github} record={null} secret={null} suggestedBudget="0.5" onCreated={() => {}} onDone={() => {}} />)
    expect(field('runner-budget').querySelector('label')?.textContent).toBe('Budget (DASH)')
    expect(field('runner-budget').textContent).toContain('≤ $20.00 on mainnet')
    await fill('runner-budget', '0.25')
    expect(field('runner-budget').textContent).toContain('≤ $10.00 on mainnet')
    await fill('runner-budget', '')
    expect(field('runner-budget').querySelector('[data-testid="fiat-note"]')).toBeNull()
  })

  it('prices the registered runner key budget as a bound', async () => {
    await render(<KeyStep identity="identity" github={github} record={runnerKey} secret="fake-runner-secret" suggestedBudget="0.5" onCreated={() => {}} onDone={() => {}} />)
    expect(host.textContent).toContain('Key 3 is on your identity: 0.5 DASH budget (≤ $20.00 on mainnet), until')
    expect(host.querySelector('button [data-testid="fiat-note"]')).toBeNull()
  })

  it('prices the run cap, Action default and whole-budget warning without changing YAML', async () => {
    await render(<WorkflowStep identity="identity" github={github} repoName="repo" storage={PLATFORM_STORAGE} profile={null} secret={null} runnerKey={runnerKey} onDone={() => {}} />)
    expect(field('mirror-cost-cap').querySelector('label')?.textContent).toBe('Cost cap per run (DASH)')
    expect(field('mirror-cost-cap').textContent).toContain("default of 0.05 DASH (≤ $2.00 on mainnet)")
    await fill('mirror-cost-cap', '0.75')
    expect(field('mirror-cost-cap').textContent).toContain('≤ $30.00 on mainnet')
    expect(host.textContent).toContain("whole budget (0.5 DASH (≤ $20.00 on mainnet))")
    expect(host.querySelector('[data-testid="mirror-yaml"] pre')?.textContent).toContain("cost-cap: '0.75'")
    expect(host.querySelector('[data-testid="mirror-yaml"] [data-testid="fiat-note"]')).toBeNull()
    await fill('mirror-cost-cap', 'no')
    expect(field('mirror-cost-cap').querySelectorAll('[data-testid="fiat-note"]')).toHaveLength(1)
  })

  it('updates the CLI spending bound, preserves commands, and follows currency and off settings', async () => {
    function Cli(): JSX.Element {
      const [settings, setSettings] = useState<MirrorCliSettings>({ name: 'repo', collab: false, cap: '0.2' })
      return <CliStep github={github} settings={settings} onSettings={setSettings} />
    }
    await render(<Cli />)
    expect(field('mirror-cli-cap').querySelector('label')?.textContent).toBe('Spending cap (DASH)')
    expect(field('mirror-cli-cap').textContent).toContain('≤ $8.00 on mainnet')
    await fill('mirror-cli-cap', '0.4')
    expect(field('mirror-cli-cap').textContent).toContain('≤ $16.00 on mainnet')
    const commands = (): string[] => [...host.querySelectorAll('code')].map((c) => c.textContent ?? '')
    const before = commands()
    expect(before).toContain('dg auth login <identity file> --budget 0.4 --network devnet --devnet-name sakura')
    await act(async () => setFiatSettings({ currency: 'EUR' }))
    expect(field('mirror-cli-cap').textContent).toContain('≤ €14.40 on mainnet')
    await act(async () => setFiatSettings({ enabled: false }))
    expect(host.querySelectorAll('[data-testid="fiat-note"]')).toHaveLength(0)
    expect(commands()).toEqual(before)
    await fill('mirror-cli-cap', '')
    await act(async () => setFiatSettings({ enabled: true }))
    expect(field('mirror-cli-cap').querySelector('[data-testid="fiat-note"]')).toBeNull()
  })

  it('covers the ready card through its shared CLI spending cap', async () => {
    await render(<ul><ReadyCard identity="identity" github={github} repo={{ name: 'repo' }} onSetup={() => {}} /></ul>)
    expect(host.textContent).toContain('Your Forge repo is ready')
    expect(field('mirror-cli-cap').textContent).toContain('≤ $8.00 on mainnet')
    await fill('mirror-cli-cap', '0.5')
    expect(field('mirror-cli-cap').textContent).toContain('≤ $20.00 on mainnet')
    expect(host.textContent).toContain('--repo identity/repo')
  })
})
