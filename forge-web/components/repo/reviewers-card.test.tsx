// @vitest-environment jsdom
/** The Reviewers card's "Request a review" picker (QW3-049). */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReviewerCardRow } from '@/lib/view/review-fold'

vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))

import { ReviewersCard } from './reviewers-card'

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

const members = [
  { identity: 'maint', role: 'maintainer' as const },
  { identity: 'writer', role: 'writer' as const },
]

async function render(rows: readonly ReviewerCardRow[], onRequest: (who: string, remove: boolean) => void): Promise<void> {
  await act(async () =>
    root.render(
      <ReviewersCard rows={rows} members={members as never} author="author" headOid={'a'.repeat(40)} membersKnown canRequest canDismiss={false} onRequest={onRequest} onDismiss={() => undefined} />,
    ),
  )
}
const open = async (): Promise<void> => {
  const toggle = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Request a review'))!
  await act(async () => toggle.click())
}

describe('Request a review (QW3-049)', () => {
  it('closes the picker once a reviewer is chosen', async () => {
    const onRequest = vi.fn()
    await render([], onRequest)
    await open()
    const option = host.querySelector('[data-testid="reviewer-option"][data-identity="maint"]') as HTMLButtonElement
    await act(async () => option.click())
    expect(onRequest).toHaveBeenCalledWith('maint', false)
    expect(host.querySelector('[data-testid="reviewer-option"]')).toBeNull()
  })

  it('marks a reviewer already requested as Requested (a click removes the request, never requests twice)', async () => {
    const onRequest = vi.fn()
    await render([{ identity: 'maint', requested: true, state: 'awaiting' } as unknown as ReviewerCardRow], onRequest)
    await open()
    const option = host.querySelector('[data-testid="reviewer-option"][data-identity="maint"]') as HTMLButtonElement
    expect(option.getAttribute('aria-pressed')).toBe('true')
    expect(option.textContent).toContain('Requested')
    await act(async () => option.click())
    expect(onRequest).toHaveBeenCalledWith('maint', true)
  })
})
