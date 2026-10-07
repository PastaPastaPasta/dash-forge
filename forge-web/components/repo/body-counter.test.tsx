// @vitest-environment jsdom
/** A members-only composer counts against its v0x03 room, not the public field's 5,120 bytes (#400 live QA). */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'

import type { RepoRef } from '@/lib/repo'
import { BodyCounter } from './private-compose'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { repoId: 'R', visibility: 'public' } as unknown as RepoRef

function counter(members?: 'comment'): string {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<BodyCounter repo={repo} text="hello" field="comment" members={members} />))
  const text = host.textContent ?? ''
  act(() => root.unmount())
  return text
}

describe('the comment counter', () => {
  it('counts a public comment against 5,120 bytes and a members-only one against 5,053', () => {
    expect(counter()).toBe('5 / 5,120 bytes')
    expect(counter('comment')).toBe('5 / 5,053 bytes')
  })
})
