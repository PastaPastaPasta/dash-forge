// @vitest-environment jsdom
/**
 * The note for a base tip that may be this PR's merge but can't be checked (Q5-A01): it says so
 * plainly when none of the PR's files can be checked, and says that the copied command records a
 * branch-rules bypass when it carries `--override-policy`.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { UnverifiedMergeNote } from './unverified-merge-note'

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

const OID = 'c'.repeat(40)

function render(props: { combined: string[]; prPaths: string[] | null; bypass: boolean }): string {
  const command = `dg pr merge o/r 7 --event-only --merge-oid ${OID}${props.bypass ? ' --override-policy' : ''}`
  act(() => root.render(<UnverifiedMergeNote oid={OID} base="main" command={command} {...props} />))
  return host.textContent ?? ''
}

describe('UnverifiedMergeNote', () => {
  it('says none of the PR is checked when main changed every file it changes', () => {
    const text = render({ combined: ['README.md'], prPaths: ['README.md'], bypass: false })
    expect(text).toContain("None of this pull request's files can be checked automatically: main also changed it (README.md) after the pull request branched off.")
    expect(text).not.toContain('except in')
    expect(host.querySelector('[data-testid="unverified-merge-bypass"]')).toBeNull()
  })

  it('names the unchecked files when the rest of the PR is confirmed', () => {
    const text = render({ combined: ['README.md'], prPaths: ['README.md', 'src/a.rs'], bypass: false })
    expect(text).toContain("It makes this pull request's changes, except in 1 file (README.md) that main also changed")
  })

  it('keeps the partial wording when the PR\'s file list is incomplete', () => {
    const text = render({ combined: ['README.md'], prPaths: null, bypass: false })
    expect(text).toContain('except in 1 file (README.md)')
  })

  it('says the command records a bypass when it carries --override-policy', () => {
    render({ combined: ['a', 'b'], prPaths: ['a', 'b'], bypass: true })
    expect(host.textContent).toContain('main also changed each of them (a, b)')
    const note = host.querySelector('[data-testid="unverified-merge-bypass"]')?.textContent ?? ''
    expect(note).toContain('--override-policy')
    expect(note).toContain('records a bypass of the branch rules')
  })
})
