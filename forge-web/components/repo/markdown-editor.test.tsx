// @vitest-environment jsdom
/**
 * The Markdown editor: Cmd/Ctrl+Enter submits, the cue under the field names a paid write's cost
 * first, Cmd/Ctrl+B formats, Cmd/Ctrl+Shift+P switches to the preview and back, and Escape
 * cancels an edit (asking first when the text changed).
 */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/markdown-view', () => ({ MarkdownView: ({ source }: { source: string }) => <div data-testid="rendered">{source}</div> }))

import { MarkdownEditor } from './markdown-editor'
import type { CostPreview } from '@/lib/sdk'

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.restoreAllMocks()
})

const cost = { credits: 2_000_000, dash: 0.00002 } as unknown as CostPreview

function Harness(props: { onSubmit?: () => void; onCancel?: () => void; initial?: string; changed?: boolean }): JSX.Element {
  const [value, setValue] = useState(props.initial ?? '')
  return <MarkdownEditor id="f" label="Comment" value={value} onChange={setValue} onSubmit={props.onSubmit} submitLabel="comment" cost={cost} onCancel={props.onCancel} changed={props.changed ?? false} />
}

const field = (): HTMLTextAreaElement => el.querySelector('textarea')!
const key = (target: Element, init: KeyboardEventInit): void => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

describe('MarkdownEditor', () => {
  it('submits on Ctrl+Enter and names the cost in the cue', () => {
    const submit = vi.fn()
    act(() => root.render(<Harness onSubmit={submit} />))
    const cue = el.querySelector('[data-testid=submit-cue]')!
    expect(cue.textContent).toMatch(/Ctrl\+Enter to comment · costs ~0\.00002\d* DASH/)
    expect(field().getAttribute('aria-describedby')).toBe('f-cue')
    key(field(), { key: 'Enter', ctrlKey: true })
    expect(submit).toHaveBeenCalledTimes(1)
    key(field(), { key: 'Enter' })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('shows no cue without a submit action', () => {
    act(() => root.render(<Harness />))
    expect(el.querySelector('[data-testid=submit-cue]')).toBeNull()
  })

  it('bolds the selection on Ctrl+B', () => {
    act(() => root.render(<Harness initial="make this bold" />))
    field().setSelectionRange(10, 14)
    key(field(), { key: 'b', ctrlKey: true })
    expect(field().value).toBe('make this **bold**')
    expect([field().selectionStart, field().selectionEnd]).toEqual([12, 16])
  })

  it('leaves Ctrl+B to the field on a Mac, where ⌘B bolds', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    act(() => root.render(<Harness initial="bold" />))
    field().setSelectionRange(0, 4)
    key(field(), { key: 'b', ctrlKey: true })
    expect(field().value).toBe('bold')
    key(field(), { key: 'b', metaKey: true })
    expect(field().value).toBe('**bold**')
  })

  it('switches to the preview and back on Ctrl+Shift+P', () => {
    act(() => root.render(<Harness initial="**hi**" />))
    key(field(), { key: 'P', ctrlKey: true, shiftKey: true })
    const preview = el.querySelector('[data-testid=markdown-preview]') as HTMLElement
    expect(preview.textContent).toBe('**hi**')
    expect(document.activeElement).toBe(preview)
    key(preview, { key: 'P', ctrlKey: true, shiftKey: true })
    expect(document.activeElement).toBe(field())
  })

  it('cancels on Escape, asking first when the text changed', () => {
    const cancel = vi.fn()
    act(() => root.render(<Harness onCancel={cancel} />))
    key(field(), { key: 'Escape' })
    expect(cancel).toHaveBeenCalledTimes(1)
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false)
    act(() => root.render(<Harness onCancel={cancel} changed />))
    key(field(), { key: 'Escape' })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
