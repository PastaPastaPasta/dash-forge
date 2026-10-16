// @vitest-environment jsdom
/**
 * "Not shown on this site" (docs/hosted-curation.md): says the repo or identity's repos still
 * exist on Platform, gives the clone line, and links the page that explains the list.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DOCS } from '@/lib/docs-links'
import { cloneByIdCommand } from '@/lib/view/repo-commands'
import { HiddenNotice } from './hidden-notice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const REPO_ID = 'Hynz8VtPiEBXn7VcMLCLCPgNo4uVK2KKveGn5P4CvinW'

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

describe('HiddenNotice', () => {
  it('for a repo: the title, the dash:// clone line by repo id, that it still exists, and the explanation', () => {
    act(() => root.render(<HiddenNotice what="repo" repoId={REPO_ID} />))
    const text = host.textContent ?? ''
    expect(host.querySelector('h1')?.textContent).toBe('Not shown on this site')
    expect(text).toContain(`dash://${REPO_ID}`)
    // The copy button's text is the id-addressed clone line with this build's network.
    expect(cloneByIdCommand(REPO_ID)).toMatch(new RegExp(`^git clone -c dash\\.network=\\w+.* dash://${REPO_ID}$`))
    expect(text).toMatch(/still exists on Dash Platform, and other clients can read it/)
    const link = host.querySelector('a')!
    expect(link.getAttribute('href')).toBe(DOCS.hostedCuration)
    expect(DOCS.hostedCuration).toMatch(/\/docs\/hosted-curation\.md$/)
  })

  it('for an identity: no clone line, the same truth, and a heading level the page can place', () => {
    act(() => root.render(<HiddenNotice what="identity" heading="h3" />))
    expect(host.querySelector('h3')?.textContent).toBe('Not shown on this site')
    expect(host.querySelector('h1')).toBeNull()
    expect(host.textContent).not.toContain('dash://')
    expect(host.textContent).toMatch(/repositories still exist on Dash Platform/)
  })
})
