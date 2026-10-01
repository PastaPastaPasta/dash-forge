// @vitest-environment jsdom
/** QW3-035: an identity without a username is told how to get one, where its identity shows. */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'

import { NAME_REGISTER_COMMAND, UsernameHint } from './username-hint'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('UsernameHint', () => {
  it('names the dg command and links the guide', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<UsernameHint />))
    expect(host.textContent).toContain('No username yet')
    expect(host.textContent).toContain(NAME_REGISTER_COMMAND)
    expect(NAME_REGISTER_COMMAND).toBe('dg auth name register <label>')
    const link = host.querySelector('a')
    expect(link?.getAttribute('href')).toMatch(/identity-and-keys\.md#what-an-identity-is$/)
    expect(host.querySelector('button[aria-label="Copy the command"]')).not.toBeNull()
    act(() => root.unmount())
  })
})
