// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import { ContractReadRefusedError } from '@/lib/sdk/contract-missing'
import { errorMessage } from '@/lib/utils'
import { ErrorState } from './states'

it('an exhausted refusal shows retry advice without the permanent contracts-missing actions', () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const retry = vi.fn()
  const error = new ContractReadRefusedError(new Error('contract not found error: contract not found for a document query'))
  try {
    act(() => root.render(<ErrorState message={errorMessage(error)} cause={error} onRetry={retry} />))
    expect(host.textContent).toContain('A node is behind; try again.')
    expect(host.textContent).not.toMatch(/reset|update|reload|newer build/i)
    expect(host.querySelector('[data-testid="contracts-missing"]')).toBeNull()
    const button = host.querySelector('button')!
    expect(button.textContent).toBe('Try again')
    act(() => button.click())
    expect(retry).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
