// @vitest-environment jsdom
/**
 * Creating an environment in the web (DESIGN §10 "Environments: create and change"): nothing is
 * preselected and Save stays disabled until an audience is chosen; each group shows how many
 * people it is; Specific people always includes the viewer; a group over 64 people is refused
 * with the "Too many" copy; the help lines and "Access is granted, not logged." are shown.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvBook } from '@/lib/env/loader'
import type { PeopleView } from '@/lib/env/view'

vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: () => undefined }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span data-testid="author">{identityId}</span> }))
vi.mock('@/components/confirm-dialog', () => ({ ConfirmDialog: () => <p data-testid="confirm">confirm</p> }))

import { EnvChangeDialog, audienceOf, choiceOf, type EnvChangeContext } from './environment-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const WRITER = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const READER = '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC'
const EMPTY: EnvBook = { maintainers: new Set([OWNER]), manifests: [], opened: new Map(), oldFormat: new Set(), resolution: { ignored: [], environments: [], hidden: [] } }

function ctx(people: PeopleView): EnvChangeContext {
  return { book: EMPTY, people, owner: OWNER, viewer: OWNER, saver: {} as EnvChangeContext['saver'], io: {} as EnvChangeContext['io'] }
}
const PEOPLE: PeopleView = {
  owner: OWNER,
  members: [
    { identity: OWNER, role: 'maintainer' },
    { identity: WRITER, role: 'writer' },
    { identity: READER, role: 'reader' },
  ],
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
  document.body.innerHTML = ''
})

const q = (sel: string): HTMLElement | null => document.querySelector(sel)
const save = (): HTMLButtonElement => q('[data-testid="env-save"]') as HTMLButtonElement
function type(el: Element | null, value: string): void {
  const input = el as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = (el: Element | null): void => act(() => (el as HTMLElement).click())

describe('New environment', () => {
  it('keeps Save disabled until an audience is chosen, with nothing preselected', () => {
    act(() => root.render(<EnvChangeDialog mode={{ kind: 'create' }} ctx={ctx(PEOPLE)} onClose={() => undefined} onSaved={() => undefined} />))
    const radios = [...document.querySelectorAll('[role="radio"]')]
    expect(radios.map((r) => r.textContent)).toEqual(['Maintainers (1)', 'Writers and maintainers (2)', 'All members (3)', 'Specific people…'])
    expect(radios.every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
    type(q('[data-testid="env-new-name"]'), 'production')
    click(q('[data-testid="env-add-row"]'))
    type(q('[data-testid="env-name-input"]'), 'DB_URL')
    type(q('[data-testid="env-value-input"]'), 'QAMARK-db')
    expect(save().disabled).toBe(true)
    expect(q('[data-testid="env-choose-audience"]')?.textContent).toBe('Choose who can read it to save.')
    click(q('[data-audience="maintainers"]'))
    expect(save().disabled).toBe(false)
    expect(document.body.textContent).toContain("People who join this group later get the current values when it's saved again, never earlier ones.")
    expect(document.body.textContent).toContain("People removed keep what they could read; you'll get a list of values to change.")
    expect(document.body.textContent).toContain('Access is granted, not logged.')
    // Save goes to the confirmation (sealed there, before anything is signed)
    click(save())
    expect(q('[data-testid="confirm"]')).not.toBeNull()
  })

  it('needs someone besides you for Specific people', () => {
    act(() => root.render(<EnvChangeDialog mode={{ kind: 'create' }} ctx={ctx(PEOPLE)} onClose={() => undefined} onSaved={() => undefined} />))
    type(q('[data-testid="env-new-name"]'), 'ci')
    click(q('[data-testid="env-add-row"]'))
    type(q('[data-testid="env-name-input"]'), 'TOKEN')
    type(q('[data-testid="env-value-input"]'), 'x')
    click(q('[data-audience="people"]'))
    expect(q('[data-testid="env-specific-people"]')?.textContent).toContain("You're always included.")
    expect(save().disabled).toBe(true)
    click(document.querySelector('[data-testid="env-specific-people"] input[type="checkbox"]'))
    expect(save().disabled).toBe(false)
  })

  it('refuses a group over 64 people with the Too many copy', () => {
    const many: PeopleView = { owner: OWNER, members: Array.from({ length: 80 }, (_, i) => ({ identity: `R${String(i).padStart(3, '0')}`, role: 'reader' as const })) }
    act(() => root.render(<EnvChangeDialog mode={{ kind: 'create' }} ctx={ctx(many)} onClose={() => undefined} onSaved={() => undefined} />))
    type(q('[data-testid="env-new-name"]'), 'dev')
    click(q('[data-testid="env-add-row"]'))
    type(q('[data-testid="env-name-input"]'), 'A')
    type(q('[data-testid="env-value-input"]'), '1')
    click(q('[data-audience="members"]'))
    expect(q('[data-testid="env-too-many"]')?.textContent).toBe('All members is 81 people. An environment can be shared with at most 64. Choose a smaller group or specific people.')
    expect(save().disabled).toBe(true)
  })
})

describe('the picker state', () => {
  it('round-trips an audience and always adds the viewer to Specific people', () => {
    expect(audienceOf({ kind: null, also: [], people: [] }, OWNER)).toBeNull()
    expect(audienceOf({ kind: 'people', also: [], people: [WRITER] }, OWNER)).toEqual({ group: null, also: [WRITER, OWNER] })
    expect(choiceOf({ group: null, also: [OWNER, WRITER] }, OWNER)).toEqual({ kind: 'people', also: [], people: [WRITER] })
    expect(audienceOf(choiceOf({ group: 'writers', also: [READER] }, OWNER), OWNER)).toEqual({ group: 'writers', also: [READER] })
  })
})
