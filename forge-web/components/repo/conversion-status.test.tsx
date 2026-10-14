// @vitest-environment jsdom
/**
 * A repo being made public, as its pages say it (DESIGN §4.10, §10): the stalled banner for
 * maintainers, the "being made public" placeholder for everyone, and the label of content written
 * while it was private.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AudienceMark } from './audience'
import { BeingMadePublicNote, ConversionStalledNote, finishHref } from './conversion-status'
import { RowLink } from './list-controls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MIN = 60_000

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

const render = (el: JSX.Element): void => act(() => root.render(el))
const q = (testId: string): Element | null => host.querySelector(`[data-testid=${testId}]`)

describe('making a repo public, on its pages', () => {
  it('the stalled banner says when, and links to Settings → Danger zone', () => {
    const href = finishHref({ owner: 'carol', name: 'ledger' })
    expect(href).toMatch(/^\/repo\/settings\/\?owner=carol&name=ledger#danger$/)
    render(<ConversionStalledNote lastStepAt={MIN} now={MIN + 3 * 24 * 60 * MIN} href={href} />)
    expect(q('conversion-stalled')?.textContent).toBe('Making this repo public stalled 3d ago. Finish it')
    // (the test renderer's Link drops the static export's trailing slash)
    expect(q('conversion-finish')?.getAttribute('href')).toMatch(/^\/repo\/settings\/?\?owner=carol&name=ledger#danger$/)
  })

  it('the Code tab says the code is on its way', () => {
    render(<BeingMadePublicNote />)
    expect(q('being-made-public')?.textContent).toBe("This repo is being made public. Its code appears here when that's done.")
  })
})

describe('content written while the repo was private', () => {
  it('in a header or card: Public for everyone when everything was made public, else members-only', () => {
    render(<AudienceMark audience={undefined} writtenWhilePrivate />)
    expect(q('written-while-private')?.textContent?.trim()).toBe('Public · written while private')
    expect(q('written-while-private')?.getAttribute('data-audience')).toBe('public')
    render(<AudienceMark audience="members" writtenWhilePrivate />)
    expect(q('written-while-private')?.textContent?.trim()).toBe('Members-only · written while private')
    expect(q('visible-to-members')).toBeNull()
    // written since: the plain marks
    render(<AudienceMark audience="members" writtenWhilePrivate={undefined} />)
    expect(q('written-while-private')).toBeNull()
    expect(q('visible-to-members')).not.toBeNull()
    render(<AudienceMark audience={undefined} />)
    expect(host.textContent).toBe('')
  })

  it('in a list row', () => {
    render(<RowLink href="/x" title="An old bug" writtenWhilePrivate />)
    expect(q('written-while-private')?.textContent?.trim()).toBe('Public · written while private')
    render(<RowLink href="/x" title="An old bug" audience="members" writtenWhilePrivate />)
    expect(q('written-while-private')?.textContent?.trim()).toBe('Members-only · written while private')
    expect(q('members-only-mark')).toBeNull()
    // a row this reader can't open stays "#N · members-only" as before
    render(<RowLink href="/x" title="" audience="members" membersOnly writtenWhilePrivate />)
    expect(q('written-while-private')).toBeNull()
    expect(q('members-only-title')).not.toBeNull()
  })
})
