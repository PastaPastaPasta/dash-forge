// @vitest-environment jsdom
/**
 * QW4-009: the Labels and Milestones pages told a triage member they "can't create or edit"
 * labels, beside the label they had just created. The note now names the capability its control
 * needs and shows only to a role without it.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Role } from '@/lib/rules/v2'
import type { Capabilities } from '@/lib/rules/roles'
import { RoleLimitNote } from './role-limit-note'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function note(role: Role | null, cap: keyof Capabilities, what: string): string | null {
  act(() => root.render(<RoleLimitNote role={role} cap={cap} what={what} />))
  return host.querySelector('[data-testid="role-limit"]')?.textContent ?? null
}

describe('RoleLimitNote', () => {
  it('says nothing to triage about labels or milestones, which triage defines', () => {
    expect(note('triage', 'canLabel', 'create or edit labels')).toBeNull()
    expect(note('triage', 'canMilestone', 'create or edit milestones')).toBeNull()
  })

  it('tells a reader, who cannot', () => {
    expect(note('reader', 'canLabel', 'create or edit labels')).toBe("Your role here is reader: a reader can't create or edit labels.")
  })

  it('tells triage what it really lacks', () => {
    expect(note('triage', 'canMerge', 'merge pull requests')).toBe("Your role here is triage: a triage member can't merge pull requests.")
  })

  it('says nothing to a writer, a maintainer or a non-member', () => {
    for (const role of ['writer', 'maintainer', null] as const) expect(note(role, 'canMerge', 'merge pull requests')).toBeNull()
  })
})
