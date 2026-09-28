import { beforeEach, describe, expect, it } from 'vitest'

import { signInRequestOutcome, useUiStore } from './use-ui-store'

describe('a Sign in asked for before the session is known', () => {
  beforeEach(() => useUiStore.setState({ signInPending: false, loginOpen: false }))

  it('waits for the session check, then opens the sheet only if nobody is signed in', () => {
    expect(signInRequestOutcome({ pending: false, settled: true, signedIn: false })).toBe('none')
    expect(signInRequestOutcome({ pending: true, settled: false, signedIn: false })).toBe('wait')
    expect(signInRequestOutcome({ pending: true, settled: true, signedIn: false })).toBe('open')
    expect(signInRequestOutcome({ pending: true, settled: true, signedIn: true })).toBe('drop')
  })

  it('a request survives a second mount effect (StrictMode) that finds no new tap', () => {
    // The first mount effect takes the tap; a second one (StrictMode's re-run) takes nothing.
    const onMount = (tapped: boolean): void => {
      if (tapped) useUiStore.getState().requestSignIn()
    }
    onMount(true)
    onMount(false)
    expect(useUiStore.getState().signInPending).toBe(true)
    useUiStore.getState().clearSignInRequest()
    expect(useUiStore.getState().signInPending).toBe(false)
  })
})
