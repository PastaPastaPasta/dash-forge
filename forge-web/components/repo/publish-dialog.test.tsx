// @vitest-environment jsdom
/**
 * The publish dialog (mixed-visibility DESIGN §10 "The publish dialog"): the words, the exact
 * list, the scan line, the co-author opt-in (off), the branch-name warning, and the typed word
 * Publish with history needs. Nothing is published until its button is pressed.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PublishDialog, type PublishFacts } from './publish-dialog'

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

const FACTS: PublishFacts = {
  method: 'squash',
  base: 'refs/heads/main',
  source: 'refs/heads/sec/fix',
  commits: 3,
  authors: ['alice', 'bob', 'alice'],
  files: 14,
  scan: { findings: [], scanned: 14, partial: false },
  coAuthors: ['bob <bob@example.org>'],
  messageNamesBranch: false,
}

const $ = (testId: string): HTMLElement | null => document.body.querySelector(`[data-testid="${testId}"]`)
const publishButton = (): HTMLButtonElement => $('publish-confirm') as HTMLButtonElement

function type(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function show(facts: Partial<PublishFacts>, onPublish = vi.fn()): typeof onPublish {
  act(() => root.render(<PublishDialog open facts={{ ...FACTS, ...facts }} onCancel={() => undefined} onPublish={onPublish} />))
  return onPublish
}

describe('PublishDialog', () => {
  it('says what §10 says and lists exactly what becomes public', () => {
    show({})
    const text = document.body.textContent ?? ''
    expect(text).toContain('Publish to everyone?')
    expect(text).toContain("This can't be undone. Anything published stays public forever, even if you delete it later.")
    expect($('publish-list')?.textContent).toContain('3 commits by alice and bob · 14 files')
    expect($('publish-scan')?.textContent).toBe('No secrets found.')
    expect($('publish-method')?.textContent).toBe('Squash into one commit: one new commit on main; the members-only history stays members-only.')
    expect($('publish-branch-name')).toBeNull()
  })

  it('credits co-authors only when asked: their emails become public', () => {
    const onPublish = show({})
    const box = $('publish-coauthors')
    expect(box?.textContent).toContain('Add co-author lines for bob <bob@example.org> (these emails become public)')
    const check = box?.querySelector('input') as HTMLInputElement
    expect(check.checked).toBe(false)
    act(() => publishButton().click())
    expect(onPublish).toHaveBeenLastCalledWith({ coAuthors: false })
    act(() => check.click())
    act(() => publishButton().click())
    expect(onPublish).toHaveBeenLastCalledWith({ coAuthors: true })
  })

  it('warns when the commit message names the members-only branch', () => {
    show({ messageNamesBranch: true })
    expect($('publish-branch-name')?.textContent).toContain('The commit message names the members-only branch sec/fix. Everyone will be able to read the name.')
  })

  it('says when more commits are published than were counted, and when history adds a merge commit', () => {
    show({ method: 'history', commitsPartial: true, mergeCommit: true })
    expect($('publish-list')?.textContent).toContain('at least 3 commits by alice and bob')
    expect($('publish-method')?.textContent).toBe("Publish with history: the commits are published as they are, joined to main by a merge commit. The last one will be visibly linked to this branch's members-only activity.")
  })

  it('asks for the word publish before publishing with history, and offers no co-author lines there', () => {
    const onPublish = show({ method: 'history' })
    expect($('publish-method')?.textContent).toBe("Publish with history: the 3 commits are published as they are. The last one will be visibly linked to this branch's members-only activity.")
    expect($('publish-coauthors')).toBeNull()
    expect(publishButton().disabled).toBe(true)
    type($('publish-word') as HTMLInputElement, 'publis')
    expect(publishButton().disabled).toBe(true)
    type($('publish-word') as HTMLInputElement, 'publish')
    expect(publishButton().disabled).toBe(false)
    act(() => publishButton().click())
    expect(onPublish).toHaveBeenCalledWith({ coAuthors: false })
  })

  it('names a possible secret and publishes only once "Publish anyway" is ticked', () => {
    show({ scan: { findings: [{ path: 'config/prod.yaml', line: 12, rule: 'aws_key_pair', severity: 'refuse' }], scanned: 14, partial: false } })
    expect($('publish-scan')?.textContent).toMatch(/^Possible secret in config\/prod\.yaml line 12 \(.+\)\. Publish anyway\?$/)
    expect(publishButton().disabled).toBe(true)
    act(() => ($('publish-anyway') as HTMLInputElement).click())
    expect(publishButton().disabled).toBe(false)
  })

  it('waits for the scan, and says when it could not run', () => {
    show({ scan: null })
    expect($('publish-scan')?.textContent).toBe('Checking for secrets…')
    expect(publishButton().disabled).toBe(true)
    show({ scan: 'the branch could not be read' })
    expect($('publish-scan')?.textContent).toBe("Couldn't check for secrets: the branch could not be read")
    // an unscanned publish is confirmed like a finding
    expect(publishButton().disabled).toBe(true)
    act(() => ($('publish-anyway') as HTMLInputElement).click())
    expect(publishButton().disabled).toBe(false)
  })
})
