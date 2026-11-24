// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TrustReport } from '@/lib/view'

vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))

import { RepoVerificationChip } from './repo-verification'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REPORT: TrustReport = {
  overall: 'verified',
  summary: 'Verified · refs by proof · 4 objects checked this session · from ipfs.filebase.io',
  network: 'mainnet',
  networkLabel: 'mainnet',
  quorumEndpoint: 'https://quorums.mainnet.networks.dash.org',
  quorumHost: 'quorums.mainnet.networks.dash.org',
  chain: { state: 'verified', detail: 'Refs, issues and members were proven against Dash mainnet.' },
  tip: {
    state: 'verified',
    name: 'main',
    detail: '`main` = `abc1234`, checked against Platform proofs.',
    heads: [{ id: '1', oid: 'a'.repeat(40), author: 'alice', createdAt: 1_700_000_000_000 }],
  },
  content: { state: 'verified', detail: '4 of 4 objects read this session matched their git hash.' },
  source: { state: 'verified', detail: 'Objects came from ipfs.filebase.io.' },
  privacy: null,
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('RepoVerificationChip', () => {
  it('renders a compact collapsed chip with summary tooltip and expands on click', () => {
    act(() => root.render(<RepoVerificationChip report={REPORT} />))
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="verification-chip"]')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toBe('Verified')
    expect(chip?.getAttribute('aria-expanded')).toBe('false')
    expect(chip?.getAttribute('title')).toBe(REPORT.summary)
    expect(host.querySelector('[data-testid="verification-summary"]')).toBeNull()

    act(() => chip?.click())
    expect(chip?.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[data-testid="verification-summary"]')?.textContent).toBe(REPORT.summary)
    expect(host.textContent).toContain('Chain data')
    expect(host.textContent).toContain('Branch tip')
  })
})
