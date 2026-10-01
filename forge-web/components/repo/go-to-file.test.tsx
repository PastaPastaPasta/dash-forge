// @vitest-environment jsdom
/**
 * Go to file (QW-028): results from the history index at once, then the walk's exact list; fuzzy
 * ranking; the arrow keys and Enter open a result; `t` focuses the box.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const push = vi.fn()
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: () => undefined }) }))

/** The walk resolves when the test says; the index answers at once (null: the repo has none). */
const INDEX = ['src/validation.cpp', 'src/net_processing.cpp', 'src/deleted_since.cpp']
let index: string[] | null = INDEX
/** The index is a full one of the tip itself (no walk then). */
let exact = false
let walks = 0
let finishWalk: (files: string[], truncated?: boolean) => void = () => undefined
vi.mock('@/lib/view/repo-facts', () => ({
  indexedFilePaths: async () => index,
  indexListsTip: () => exact,
  repoFilesWalk: () => {
    walks += 1
    return new Promise((resolve) => {
      finishWalk = (files, truncated = false) => resolve({ files: files.map((path) => ({ path, oid: '', mode: 0o100644, size: 0 })), truncated })
    })
  },
}))

import { GoToFile } from './go-to-file'

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  push.mockClear()
  index = INDEX
  exact = false
  walks = 0
  // jsdom has no layout, so no scrollIntoView.
  Element.prototype.scrollIntoView = () => undefined
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const input = (): HTMLInputElement => el.querySelector('[data-testid="go-to-file"]') as HTMLInputElement
const results = (): string[] => [...el.querySelectorAll('[data-testid="go-to-file-result"]')].map((a) => a.textContent ?? '')

async function type(text: string): Promise<void> {
  await act(async () => {
    const box = input()
    box.focus()
    // React listens for the native setter's input event.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function key(k: string, target: EventTarget = input()): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
}

/** The walk (once it has started: after the index's answer) finishes with `files`. */
async function walkDone(files: string[], truncated = false): Promise<void> {
  await vi.waitFor(() => expect(walks).toBe(1))
  await act(async () => finishWalk(files, truncated))
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <GoToFile reader={{} as never} repoKey="r" tipOid={'a'.repeat(40)} rootTree={async () => 'tree'} addr={{ owner: 'o', name: 'n' }} refParam="" />,
    )
  })
}

describe('GoToFile', () => {
  it('answers from the history index before the walk, then from the walk', async () => {
    await render()
    await type('deleted')
    await vi.waitFor(() => expect(results()).toEqual(['src/deleted_since.cpp']))
    // The walk's list is exact: a file the index still named is gone.
    await walkDone(['src/validation.cpp', 'src/net_processing.cpp'])
    await vi.waitFor(() => expect(el.textContent).toContain('No matching file.'))
  })

  it('takes a full index of the tip as the list, with no walk (QW3-001)', async () => {
    exact = true
    await render()
    await type('src')
    await vi.waitFor(() => expect(results()).toHaveLength(3))
    await act(async () => new Promise((r) => setTimeout(r, 20)))
    expect(walks).toBe(0)
  })

  it('a walk cut off at its file cap does not replace a complete index', async () => {
    await render()
    await type('src')
    await vi.waitFor(() => expect(results()).toHaveLength(3))
    // Past the walk's cap: the index names more of the tip than the partial walk.
    await walkDone(['src/validation.cpp'], true)
    expect(results()).toHaveLength(3)
    expect(el.textContent).not.toContain('Searched the first')
  })

  it('with no index, a cut-off walk is the list, and says so', async () => {
    index = null
    await render()
    await type('src')
    await walkDone(['src/validation.cpp', 'src/init.cpp'], true)
    await vi.waitFor(() => expect(results()).toHaveLength(2))
    expect(el.textContent).toContain('Searched the first 2 files')
  })

  it('a new list of results resets the highlight, so Enter still opens one', async () => {
    await render()
    await type('src')
    await vi.waitFor(() => expect(results()).toHaveLength(3))
    await key('ArrowDown')
    await key('ArrowDown')
    // The walk's exact list replaces the index's under the same query: one result now.
    await walkDone(['src/validation.cpp'])
    await vi.waitFor(() => expect(results()).toEqual(['src/validation.cpp']))
    await key('Enter')
    expect(push).toHaveBeenCalledWith(expect.stringContaining(`path=${encodeURIComponent('src/validation.cpp')}`))
  })

  it('ranks fuzzily, moves with the arrow keys and opens the choice with Enter', async () => {
    await render()
    await type('netproc')
    await vi.waitFor(() => expect(results()).toEqual(['src/net_processing.cpp']))
    await type('src')
    await vi.waitFor(() => expect(results()).toHaveLength(3))
    const first = results()[0]
    await key('ArrowDown')
    expect(el.querySelector('[role=option][aria-selected=true]')?.textContent).toBe(results()[1])
    await key('ArrowUp')
    await key('Enter')
    expect(push).toHaveBeenCalledWith(expect.stringContaining(`path=${encodeURIComponent(first as string)}`))
  })

  it('focuses on t, and Escape clears it', async () => {
    await render()
    // jsdom lays nothing out: give the box a client rect so it counts as visible.
    input().getClientRects = () => [{}] as unknown as DOMRectList
    await key('t', document.body)
    expect(document.activeElement).toBe(input())
    await type('val')
    await key('Escape')
    expect(input().value).toBe('')
    expect(document.activeElement).not.toBe(input())
  })
})
