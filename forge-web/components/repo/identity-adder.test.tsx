// @vitest-environment jsdom
/**
 * "Specific people…" and "Also give access to…" take an identity id or a DPNS name: a name is
 * looked up when Add is pressed, the id it belongs to is shown, and an unknown name is refused
 * (R10). The member field of Settings > Members uses the same lookup once typing pauses.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '@/lib/auth/base58'
import type { PeopleView } from '@/lib/env/view'

const resolve = vi.fn<(sdk: unknown, names: readonly string[], network: string) => Promise<Map<string, string | null>>>()
// a failed read is a plain throw here: a rejecting vi.fn leaves a rejection vitest reports as unhandled
let failRead = false
vi.mock('@/lib/view/dpns', async (orig) => ({
  ...(await orig<typeof import('@/lib/view/dpns')>()),
  resolveDpnsIds: async (...a: Parameters<typeof resolve>) => {
    if (failRead) throw new Error('network down')
    return resolve(...a)
  },
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: () => undefined }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))

import { AudiencePicker, type AudienceChoice } from './environment-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VIEWER = base58Encode(new Uint8Array(32).fill(1))
const ALICE = base58Encode(new Uint8Array(32).fill(2))
const PEOPLE: PeopleView = { owner: VIEWER, members: [{ identity: VIEWER, role: 'maintainer' }] }

let root: Root
let host: HTMLDivElement
let value: AudienceChoice
beforeEach(() => {
  resolve.mockReset()
  failRead = false
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  value = { kind: 'people', also: [], people: [] }
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const q = (sel: string): HTMLElement | null => document.querySelector(sel)
function render(): void {
  act(() =>
    root.render(
      <AudiencePicker
        env="ci"
        value={value}
        onChange={(c) => {
          value = c
          render()
        }}
        people={PEOPLE}
        viewer={VIEWER}
      />,
    ),
  )
}
function type(el: Element | null, text: string): void {
  const input = el as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const addButton = (): HTMLButtonElement => (q('[data-testid="env-people-add"]')?.parentElement?.querySelector('button') ?? null) as HTMLButtonElement
async function press(): Promise<void> {
  await act(async () => {
    addButton().click()
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('Specific people takes a name', () => {
  it('adds the identity a name resolves to and shows which it is', async () => {
    resolve.mockResolvedValue(new Map([['alice.dash', ALICE]]))
    render()
    type(q('[data-testid="env-people-add"]'), '@alice')
    await press()
    expect(value.people).toEqual([ALICE])
    expect(q('[data-testid="env-people-add-resolved"]')?.textContent).toMatch(/^alice\.dash is /)
  })

  it('refuses a name nobody holds and adds nothing', async () => {
    resolve.mockResolvedValue(new Map([['nobody.dash', null]]))
    render()
    type(q('[data-testid="env-people-add"]'), 'nobody.dash')
    await press()
    expect(value.people).toEqual([])
    expect(document.body.textContent).toContain('No DPNS name nobody.dash was found.')
  })

  it('does not call a failed read an unknown name', async () => {
    failRead = true
    render()
    type(q('[data-testid="env-people-add"]'), 'alice.dash')
    await press()
    expect(value.people).toEqual([])
    expect(document.body.textContent).toContain("Couldn't look that name up.")
  })

  it('still takes an identity id, without a lookup', async () => {
    render()
    type(q('[data-testid="env-people-add"]'), ALICE)
    await press()
    expect(value.people).toEqual([ALICE])
    expect(resolve).not.toHaveBeenCalled()
    expect(q('[data-testid="env-people-add-resolved"]')).toBeNull()
  })

  it('refuses text that is neither', async () => {
    render()
    type(q('[data-testid="env-people-add"]'), 'not a name!')
    await press()
    expect(value.people).toEqual([])
    expect(document.body.textContent).toContain('Not an identity id or a name like alice.dash.')
  })
})
