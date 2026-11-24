// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useOrgsStore } from '@/hooks/use-orgs'
import { cardState } from '@/lib/org/requests'
import type { OrgView, RequestView } from '@/lib/org/service'
import { forgetOrg, saveOrg, type OrgRecord } from '@/lib/org/store'

vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: null }) }))

const { RequestCard } = await import('./request-card')
const { NeedsSignature } = await import('./needs-signature')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ME = 'a'.repeat(64)
const record: OrgRecord = {
  network: 'testnet',
  orgId: 'Org1111111111111111111111111111111111111111',
  room: 't_000102030405060708090a0b0c0d0e0f',
  relay: 'https://multisig.dashhq.org',
  authPub: ME,
  label: 'Acme',
  threshold: 2,
  members: [
    { index: 1, name: 'p1', authPub: ME },
    { index: 2, name: 'p2', authPub: 'b'.repeat(64) },
    { index: 3, name: 'p3', authPub: 'c'.repeat(64) },
  ],
}

function request(status: RequestView['status'], viewerSigned: boolean, collected = 1): RequestView {
  return {
    request: { id: '0123456789abcdef', title: 'x', forge: true, proposals: [], from: 'b'.repeat(64), at: new Date().toISOString(), malformed: false },
    status,
    card: cardState(status, collected, 2, viewerSigned, 'the nonce was already used'),
    proposals: [{ id: 'p', decoded: null, problems: [], sentence: 'Give alice.dash Write access to Acme/widgets', done: false }],
    collected,
    needed: 2,
    proposer: 'p2',
    signers: viewerSigned ? ['p2', 'p1'] : ['p2'],
    decliners: [],
    viewerSigned,
    viewerDeclined: false,
  }
}

const view = (requests: RequestView[]): OrgView => ({ record, identity: {} as OrgView['identity'], state: {} as OrgView['state'], requests })

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
  useOrgsStore.setState({ views: {} })
  forgetOrg('testnet', record.orgId)
})

const render = (el: JSX.Element): HTMLDivElement => {
  act(() => root.render(el))
  return host
}
const buttons = (): string[] => [...host.querySelectorAll('button')].map((b) => b.textContent ?? '')

describe('request card', () => {
  it('collecting, not signed: one primary Sign button with the count, Decline as text, details collapsed', () => {
    const v = view([request('collecting', false)])
    render(<RequestCard view={v} request={v.requests[0]!} />)
    expect(host.textContent).toContain('Give alice.dash Write access to Acme/widgets')
    expect(host.textContent).toContain('Asked by p2')
    expect(buttons()).toContain('Sign (1 of 2 collected)')
    expect(host.querySelector('[data-testid="org-decline"]')?.textContent).toBe('Decline')
    const details = host.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.textContent).toContain('Signed by: p2')
  })

  it('signed: says who it waits for and offers the link', () => {
    const v = view([request('collecting', true)])
    render(<RequestCard view={v} request={v.requests[0]!} />)
    expect(host.querySelector('[data-testid="org-signed"]')?.textContent).toBe('You signed · waiting for 1 more')
    expect(buttons().some((b) => b.includes('Copy link'))).toBe(true)
    expect(host.querySelector('[data-testid="org-sign"]')).toBeNull()
  })

  it('done, ready, expired and invalid', () => {
    const v = view([request('done', true, 2)])
    render(<RequestCard view={v} request={v.requests[0]!} />)
    expect(host.querySelector('[data-testid="org-done"]')?.textContent).toContain('Done')
    expect(host.querySelector('[data-testid="org-sign"]')).toBeNull()

    const r = view([request('ready', true, 2)])
    render(<RequestCard view={r} request={r.requests[0]!} />)
    expect(buttons()).toContain('Finish')

    const e = view([request('expired', false)])
    render(<RequestCard view={e} request={e.requests[0]!} />)
    expect(host.textContent).toContain('Expired')

    const i = view([request('invalid', false)])
    render(<RequestCard view={i} request={i.requests[0]!} />)
    expect(host.textContent).toContain("Forge won't sign this: the nonce was already used.")
    expect(host.querySelector('[data-testid="org-sign"]')).toBeNull()
  })
})

describe('needs your signature', () => {
  it('is absent with no connected organization, and lists what waits for the viewer', () => {
    render(<NeedsSignature />)
    expect(host.querySelector('[data-testid="needs-signature"]')).toBeNull()

    act(() => saveOrg(record))
    act(() => useOrgsStore.setState({ views: { [record.orgId]: view([request('collecting', false), request('collecting', true), request('done', true, 2)]) } }))
    render(<NeedsSignature />)
    expect(host.querySelectorAll('[data-testid="org-request"]')).toHaveLength(1)
  })
})
