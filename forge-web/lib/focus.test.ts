import { afterEach, describe, expect, it, vi } from 'vitest'

import { trapTab } from './focus'

/**
 * A minimal stand-in for the DOM `trapTab` touches (vitest runs in Node): a panel whose
 * tabbables are fake elements, and `document.activeElement` following `.focus()`.
 */
class FakeEl {
  tabIndex = 0
  constructor(
    readonly name: string,
    readonly focusable = true,
  ) {}
  closest(): null {
    return null
  }
  getClientRects(): { length: number } {
    return { length: 1 }
  }
  focus(): void {
    if (this.focusable) doc.activeElement = this
  }
}

const doc: { activeElement: unknown } = { activeElement: null }

function panel(items: FakeEl[]): FakeEl & { querySelectorAll: () => FakeEl[] } {
  return Object.assign(new FakeEl('panel'), { querySelectorAll: () => items })
}

function tab(root: unknown, shiftKey = false, defaultPrevented = false): { handled: boolean; prevented: boolean } {
  let prevented = false
  const handled = trapTab(root as HTMLElement, {
    key: 'Tab',
    shiftKey,
    defaultPrevented,
    preventDefault: () => {
      prevented = true
    },
  })
  return { handled, prevented }
}

vi.stubGlobal('document', doc)
vi.stubGlobal('HTMLElement', FakeEl)
afterEach(() => {
  doc.activeElement = null
})

describe('trapTab', () => {
  it('moves Tab to the next tabbable itself, not only at the edges (WebKit tabs only to fields)', () => {
    const a = new FakeEl('a')
    const b = new FakeEl('b')
    const c = new FakeEl('c')
    const root = panel([a, b, c])
    a.focus()
    expect(tab(root)).toEqual({ handled: true, prevented: true })
    expect(doc.activeElement).toBe(b)
    tab(root)
    tab(root)
    expect(doc.activeElement).toBe(a)
    tab(root, true)
    expect(doc.activeElement).toBe(c)
  })

  it('starts at the first (Tab) or last (Shift+Tab) from the panel itself', () => {
    const a = new FakeEl('a')
    const b = new FakeEl('b')
    const root = panel([a, b])
    root.focus()
    tab(root)
    expect(doc.activeElement).toBe(a)
    root.focus()
    tab(root, true)
    expect(doc.activeElement).toBe(b)
  })

  it('skips a candidate that will not take focus instead of trapping on it', () => {
    const a = new FakeEl('a')
    const hidden = new FakeEl('hidden', false)
    const c = new FakeEl('c')
    const root = panel([a, hidden, c])
    a.focus()
    tab(root)
    expect(doc.activeElement).toBe(c)
  })

  it('leaves a Tab a widget inside already handled', () => {
    const a = new FakeEl('a')
    const root = panel([a, new FakeEl('b')])
    a.focus()
    expect(tab(root, false, true)).toEqual({ handled: false, prevented: false })
    expect(doc.activeElement).toBe(a)
  })

  it('keeps focus on the panel when nothing inside can take it', () => {
    const root = panel([])
    tab(root)
    expect(doc.activeElement).toBe(root)
  })
})
