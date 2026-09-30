// @vitest-environment jsdom
/**
 * QW2-060: in a private repo (where no milestone can be defined yet) the issue sidebar says so,
 * rather than offering "Set milestone" that opens onto "No open milestones".
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }))

import { MilestonePicker } from './target-rail'

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
})

const setButton = (): HTMLButtonElement | undefined => [...el.querySelectorAll('button')].find((b) => /Set milestone/.test(b.textContent ?? ''))

describe('MilestonePicker', () => {
  it('says milestones are unavailable where none can be defined and none exist', () => {
    act(() => root.render(<MilestonePicker current={null} choices={[]} loading={false} canDefine={false} canEdit onChoose={() => undefined} />))
    expect(setButton()).toBeUndefined()
    expect(el.querySelector('[data-testid="milestone-unavailable"]')?.textContent).toMatch(/private repos/)
  })

  it('offers Set milestone where they can be defined, even with none yet', () => {
    act(() => root.render(<MilestonePicker current={null} choices={[]} loading={false} canDefine canEdit onChoose={() => undefined} />))
    expect(setButton()).toBeDefined()
    expect(el.querySelector('[data-testid="milestone-unavailable"]')).toBeNull()
  })

  it('offers it while the milestones are read, and when some exist', () => {
    act(() => root.render(<MilestonePicker current={null} choices={[]} loading canDefine={false} canEdit onChoose={() => undefined} />))
    expect(setButton()).toBeDefined()
    act(() => root.render(<MilestonePicker current={null} choices={[{ title: 'v1', closed: false }]} loading={false} canDefine={false} canEdit onChoose={() => undefined} />))
    expect(setButton()).toBeDefined()
  })
})
