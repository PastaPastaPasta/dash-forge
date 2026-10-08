// @vitest-environment jsdom
/**
 * The bulk bar: members select rows, confirm one batch with its cost, watch each item, and retry
 * only what failed. Outsiders get no controls.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setTargetState = vi.fn()
const setLabelIfNeeded = vi.fn()
let role: string | null = 'maintainer'
vi.mock('@/lib/repo', async (orig) => ({ ...(await orig<typeof import('@/lib/repo')>()), setTargetState: (...a: unknown[]) => setTargetState(...a), setLabelIfNeeded: (...a: unknown[]) => setLabelIfNeeded(...a) }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'sakura' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'me', signer: {} }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role, known: true, failed: false, retry: () => undefined }) }))

import { useState } from 'react'
import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { base58Decode, base58Encode } from '@/lib/auth/base58'
import { writeTransition, type StateTarget } from '@/lib/repo/transitions'
import { resetContractShapes } from '@/lib/repo/contract-shape'
import type { LabelDef } from '@/lib/repo'
import { BulkBar, BulkRowCheckbox, useBulkAllowed, useBulkHold, useBulkSelection } from './bulk-actions'
import type { BulkRow } from '@/lib/view/bulk'
import type { RepoHome } from '@/lib/view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  setTargetState.mockReset()
  setLabelIfNeeded.mockReset()
  role = 'maintainer'
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const home = { repo: { repoId: 'r', visibility: 'public', forge: {} }, config: null } as unknown as RepoHome
const ROWS: BulkRow[] = [1, 2, 3].map((n) => ({ id: `id${n}`, number: n, title: `Issue ${n}`, author: 'a', open: true, merged: false, labels: [] }))

function List({ onWritten = () => undefined, rows = ROWS, kind = 'issue', labels = [], at = home }: { onWritten?: () => void; rows?: BulkRow[]; kind?: 'issue' | 'pull'; labels?: LabelDef[]; at?: RepoHome }): JSX.Element {
  const allowed = useBulkAllowed(at)
  const sel = useBulkSelection(rows)
  return (
    <div>
      {/* The list's own box clips what overflows it, as the issue and PR lists do. */}
      <div style={{ overflow: 'hidden' }} data-testid="list-box">
        {allowed ? <BulkBar kind={kind} home={at} rows={rows} selection={sel} labels={labels} onWritten={onWritten} /> : null}
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.id}>{allowed ? <BulkRowCheckbox kind={kind} number={r.number} checked={sel.selected.has(r.id)} onChange={(on) => sel.toggle(r.id, on)} /> : null}</li>
        ))}
      </ul>
    </div>
  )
}

const q = (sel: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(sel)
  if (!el) throw new Error(`no ${sel}`)
  return el
}
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => el.click())
}
const button = (text: string): HTMLElement => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === text)
  if (!b) throw new Error(`no button ${text}`)
  return b
}

describe('bulk actions', () => {
  it('shows no checkboxes to a reader or an outsider', async () => {
    role = 'reader'
    await act(async () => root.render(<List />))
    expect(host.querySelector('[data-testid="bulk-select-row"]')).toBeNull()
    expect(host.querySelector('[data-testid="bulk-bar"]')).toBeNull()
    role = null
    await act(async () => root.render(<List />))
    expect(host.querySelector('[data-testid="bulk-select-row"]')).toBeNull()
  })

  it('closes the selected issues in one batch, reports a failure, and retries only it', async () => {
    const onWritten = vi.fn()
    await act(async () => root.render(<List onWritten={onWritten} />))
    const boxes = host.querySelectorAll<HTMLInputElement>('[data-testid="bulk-select-row"]')
    expect(boxes[0]?.getAttribute('aria-label')).toBe('Select issue #1')
    await click(q('[data-testid="bulk-select-all"]'))
    expect(host.textContent).toContain('3 selected')

    await click(q('[data-testid="bulk-close"]'))
    await click(button('Close as not planned'))
    expect(document.body.textContent).toContain('Close 3 issues as not planned')

    let calls = 0
    setTargetState.mockImplementation(async (_s: unknown, _a: unknown, _r: unknown, input: { target: { number: number }; intent: string }) => {
      calls += 1
      if (input.target.number === 2 && calls === 2) throw new Error('Platform refused it')
      return { documentId: 'd' }
    })
    await click(q('[data-testid="bulk-confirm"]'))
    expect(q('[data-testid="bulk-summary"]').textContent).toBe("2 of 3 done. 1 didn't go through.")
    expect(document.body.textContent).toContain('Platform refused it')
    expect(setTargetState.mock.calls[0]?.[3]).toMatchObject({ action: 'close', closed: { reason: 'not_planned', duplicateOf: null } })

    await click(q('[data-testid="bulk-retry"]'))
    expect(setTargetState).toHaveBeenCalledTimes(4)
    // The retry signs the same item under the same intent: an attempt that landed is not repeated.
    expect(setTargetState.mock.calls[3]?.[3].intent).toBe(setTargetState.mock.calls[1]?.[3].intent)
    expect(q('[data-testid="bulk-summary"]').textContent).toBe('Closed: 3 issues.')
    await click(q('[data-testid="bulk-done"]'))
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('keeps the dialog and the whole batch while each write re-reads the list', async () => {
    // A page: each close re-reads the list (its data is null while the read runs), and the
    // closed issues come back closed.
    let reread: (() => void) | null = null
    function Page(): JSX.Element {
      const hold = useBulkHold<BulkRow[]>()
      const [fresh, setFresh] = useState<BulkRow[] | null>(ROWS)
      const [closed, setClosed] = useState<string[]>([])
      reread = () => {
        setFresh(null)
        setTimeout(() => setFresh(ROWS.map((r) => ({ ...r, open: !closed.includes(r.id) }))), 0)
      }
      const data = hold.keep(fresh)
      const rows = data ?? []
      const sel = useBulkSelection(rows)
      setTargetState.mockImplementation(async (_s: unknown, _a: unknown, _r: unknown, input: { target: { id: string } }) => {
        setClosed((c) => [...c, input.target.id])
        reread?.()
        return { documentId: 'd' }
      })
      return (
        <div>
          <BulkBar kind="issue" home={home} rows={rows} selection={sel} labels={[]} onWritten={() => undefined} onBusy={hold.setBusy} />
          <span data-testid="rows">{rows.length}</span>
        </div>
      )
    }
    await act(async () => root.render(<Page />))
    await click(q('[data-testid="bulk-select-all"]'))
    await click(q('[data-testid="bulk-close"]'))
    await click(button('Close as completed'))
    await click(q('[data-testid="bulk-confirm"]'))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
    expect(setTargetState).toHaveBeenCalledTimes(3)
    expect(q('[data-testid="bulk-summary"]').textContent).toBe('Closed: 3 issues.')
    expect(q('[data-testid="rows"]').textContent).toBe('3')
  })

  describe('against the real transition writer', () => {
    // Each target's state code on Platform now (the sum the writer reads before it writes).
    const id = (name: string): string => base58Encode(sha256(new TextEncoder().encode(name)))
    const NOW: Record<string, number> = {}
    const hex = (b58: string): string => [...base58Decode(b58)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const realHome = { repo: { repoId: id('repo'), visibility: 'public', forge: { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' } }, config: null } as unknown as RepoHome
    const realRows = (kind: 'issue' | 'pull'): BulkRow[] => [1, 2, 3].map((n) => ({ id: id(`${kind}${n}`), number: n, title: `Item ${n}`, author: 'a', open: true, merged: false, labels: [] }))
    const sdk = {
      documents: {
        sum: async (q: { where: [string, string, string[]][] }) => new Map(q.where[0]![2].filter((t) => (NOW[t] ?? 0) !== 0).map((t) => [hex(t), BigInt(NOW[t] ?? 0)])),
      },
      contracts: { fetch: async () => ({ schemas: { transition: { properties: { kind: {}, reason: {}, dupNumber: {} } } } }) },
    } as unknown as EvoSDK
    let written: Record<string, unknown>[] = []
    let beforeWrite: (data: Record<string, unknown>) => void = () => undefined
    beforeEach(() => {
      resetContractShapes()
      for (const k of Object.keys(NOW)) delete NOW[k]
      written = []
      beforeWrite = () => undefined
      setTargetState.mockImplementation((_s: unknown, auth: never, repo: never, input: { target: StateTarget }) =>
        writeTransition(sdk, auth, repo, async (_type, data) => {
          beforeWrite(data)
          written.push(data)
          return { documentId: 'D', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: 0 } as never
        }, input as never),
      )
    })
    const start = async (kind: 'issue' | 'pull', menuPick: string | null): Promise<void> => {
      await act(async () => root.render(<List rows={realRows(kind)} kind={kind} at={realHome} />))
      await click(q('[data-testid="bulk-select-all"]'))
      await click(q('[data-testid="bulk-close"]'))
      if (menuPick !== null) await click(button(menuPick))
      await click(q('[data-testid="bulk-confirm"]'))
    }

    it('does not count an issue someone else closed meanwhile as closed by this batch', async () => {
      NOW[id('issue2')] = 1 // closed (completed) since the list was read
      await start('issue', 'Close as not planned')
      // Only the two still open were written, each with the reason asked; the third is not signed.
      expect(written.map((w) => w['reason'])).toEqual([2, 2])
      const row = document.querySelector('[data-status="unchanged"]')
      expect(row?.textContent).toContain('Item 2')
      expect(row?.textContent).toContain('Already closed.')
      expect(q('[data-testid="bulk-summary"]').textContent).toBe('Closed: 2 issues. 1 was already that way.')
      expect(document.querySelectorAll('[data-status="done"]')).toHaveLength(2)
    })

    it('says "Already open." for a reopen someone else made first, and nothing was changed when all were', async () => {
      const closed = realRows('issue').map((r) => ({ ...r, open: false }))
      for (const r of closed) NOW[r.id] = 0
      await act(async () => root.render(<List rows={closed} kind="issue" at={realHome} />))
      await click(q('[data-testid="bulk-select-all"]'))
      await click(q('[data-testid="bulk-reopen"]'))
      await click(q('[data-testid="bulk-confirm"]'))
      expect(written).toHaveLength(0)
      expect(q('[data-testid="bulk-summary"]').textContent).toBe('Nothing was changed. 3 were already that way.')
      expect([...document.querySelectorAll('[data-status="unchanged"]')].every((li) => li.textContent?.includes('Already open.'))).toBe(true)
    })

    it('says a pull request merged meanwhile is already merged, not closed', async () => {
      NOW[id('pull2')] = 2 // merged since the list was read
      await start('pull', null)
      expect(written).toHaveLength(2)
      const row = document.querySelector('[data-status="unchanged"]')
      expect(row?.textContent).toContain('Item 2')
      expect(row?.textContent).toContain('Already merged.')
      expect(row?.textContent).not.toContain('Already closed.')
      expect(q('[data-testid="bulk-summary"]').textContent).toBe('Closed: 2 pull requests. 1 was already that way.')
    })

    it('keeps a retry of its own write that landed reading done, not already closed', async () => {
      const { UnconfirmedWriteError } = await import('@/lib/sdk')
      // The first item's write is sent and not yet shown, then lands on Platform.
      let sent = false
      beforeWrite = (data) => {
        if (!sent) {
          sent = true
          NOW[base58Encode(data['targetId'] as Uint8Array)] = 1
          throw new UnconfirmedWriteError('d1')
        }
      }
      await start('issue', 'Close as completed')
      expect(q('[data-testid="bulk-summary"]').textContent).toBe('2 of 3 done. 1 still arriving.')
      expect(q('[data-testid="bulk-retry"]').textContent).toBe('Retry 1')
      await click(q('[data-testid="bulk-retry"]'))
      // It is closed now, and it was this batch's write that closed it: done, nothing signed again.
      expect(q('[data-testid="bulk-summary"]').textContent).toBe('Closed: 3 issues.')
      expect(document.querySelectorAll('[data-status="unchanged"]')).toHaveLength(0)
      expect(written).toHaveLength(2)
    })

    it('still reads a write that landed as done after a retry that failed first, not as already closed', async () => {
      const { UnconfirmedWriteError } = await import('@/lib/sdk')
      // Item 1 is sent and not yet shown; item 2 fails. The retry of both fails too, then item 1's
      // first write lands and the next retry finds it closed: this batch closed it.
      let attempt = 0
      let first = ''
      beforeWrite = (data) => {
        if (attempt === 0) {
          attempt = 1
          first = base58Encode(data['targetId'] as Uint8Array)
          throw new UnconfirmedWriteError('d1')
        }
        if (attempt === 1) {
          attempt = 2
          throw new Error('Platform refused it')
        }
      }
      await start('issue', 'Close as completed')
      expect(q('[data-testid="bulk-summary"]').textContent).toBe("1 of 3 done. 1 didn't go through. 1 still arriving.")
      beforeWrite = () => {
        throw new Error('Platform refused it')
      }
      await click(q('[data-testid="bulk-retry"]'))
      expect(q('[data-testid="bulk-summary"]').textContent).toBe("1 of 3 done. 2 didn't go through.")
      beforeWrite = () => undefined
      NOW[first] = 1
      await click(q('[data-testid="bulk-retry"]'))
      expect(document.querySelector('[data-status="unchanged"]')).toBeNull()
      expect(q('[data-testid="bulk-summary"]').textContent).toBe('Closed: 3 issues.')
    })

    it('counts what "Stop after this one" left as not tried, and offers to continue it', async () => {
      beforeWrite = () => {
        // The viewer stops the batch while its first write is under way.
        if (written.length === 0) q('[data-testid="bulk-stop"]').click()
      }
      await start('issue', 'Close as completed')
      const summary = q('[data-testid="bulk-summary"]')
      expect(summary.textContent).toBe('1 of 3 done. 2 not tried.')
      expect(summary.className).not.toContain('danger')
      expect(summary.textContent).not.toContain("didn't go through")
      expect(document.querySelectorAll('[data-status="stopped"]')).toHaveLength(2)
      expect(q('[data-testid="bulk-retry"]').textContent).toBe('Continue 2')
      await click(q('[data-testid="bulk-retry"]'))
      expect(q('[data-testid="bulk-summary"]').textContent).toBe('Closed: 3 issues.')
      expect(written).toHaveLength(3)
    })
  })

  describe('labels', () => {
    const bug: LabelDef = { name: 'bug', color: '#d73a4a', description: '', retired: false } as LabelDef
    const open = async (): Promise<void> => {
      await act(async () => root.render(<List labels={[bug]} />))
      await click(q('[data-testid="bulk-select-all"]'))
      await click(q('[data-testid="bulk-label"]'))
      await click(button('bug'))
      await click(q('[data-testid="bulk-confirm"]'))
    }

    it('says "Already has the label." for an item that got it meanwhile, and does not call it done', async () => {
      // #2 was labelled by someone else since the list was read: the fresh read finds nothing to write.
      setLabelIfNeeded.mockImplementation(async (_s: unknown, _a: unknown, _r: unknown, input: { target: { number: number } }) => (input.target.number === 2 ? null : { documentId: 'e' }))
      await open()
      expect(setLabelIfNeeded).toHaveBeenCalledTimes(3)
      expect(setLabelIfNeeded.mock.calls[0]?.[3]).toMatchObject({ label: 'bug', add: true })
      expect(document.querySelector('[data-status="unchanged"]')?.textContent).toContain('Already has the label.')
      expect(q('[data-testid="bulk-summary"]').textContent).toBe('Label added: 2 issues. 1 was already that way.')
    })

    it('says the item does not have the label when a removal finds it already gone', async () => {
      const labelled = ROWS.map((r) => ({ ...r, labels: ['bug'] }))
      setLabelIfNeeded.mockResolvedValue(null)
      await act(async () => root.render(<List rows={labelled} labels={[bug]} />))
      await click(q('[data-testid="bulk-select-all"]'))
      await click(q('[data-testid="bulk-label"]'))
      await click(button('bug (on all selected; removes it)'))
      expect(document.body.textContent).toContain('Remove bug from 3 issues')
      await click(q('[data-testid="bulk-confirm"]'))
      expect(document.querySelector('[data-status="unchanged"]')?.textContent).toContain("Doesn't have the label.")
      expect(q('[data-testid="bulk-summary"]').textContent).toBe('Nothing was changed. 3 were already that way.')
    })
  })

  it('draws the Close and Label menus on the page, not inside the list box that clips', async () => {
    await act(async () => root.render(<List labels={[{ name: 'bug', color: '#d73a4a', description: '', retired: false } as LabelDef]} />))
    await click(q('[data-testid="bulk-select-all"]'))
    await click(q('[data-testid="bulk-close"]'))
    const menu = q('[data-testid="bulk-close-menu"]')
    expect(q('[data-testid="list-box"]').contains(menu)).toBe(false)
    expect(menu.style.left).not.toBe('')
    // The list's box is never the menu's parent, whatever its overflow.
    expect(menu.parentElement).toBe(document.body)
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[data-testid="bulk-close-menu"]')).toBeNull()
    // Tab leaves the page-level panel for the button, so the bar's own order carries on.
    await click(q('[data-testid="bulk-close"]'))
    const again = q('[data-testid="bulk-close-menu"]')
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(async () => {
      again.dispatchEvent(tab)
    })
    expect(tab.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-testid="bulk-close-menu"]')).toBeNull()
    expect(document.activeElement).toBe(q('[data-testid="bulk-close"]'))
  })

  it('counts a write still arriving apart from one that failed', async () => {
    const { UnconfirmedWriteError } = await import('@/lib/sdk')
    setTargetState.mockImplementation(async (_s: unknown, _a: unknown, _r: unknown, input: { target: { number: number } }) => {
      if (input.target.number === 1) throw new UnconfirmedWriteError('d1')
      if (input.target.number === 2) throw new Error('Platform refused it')
      return { documentId: 'd' }
    })
    await act(async () => root.render(<List />))
    await click(q('[data-testid="bulk-select-all"]'))
    await click(q('[data-testid="bulk-close"]'))
    await click(button('Close as completed'))
    await click(q('[data-testid="bulk-confirm"]'))
    expect(q('[data-testid="bulk-summary"]').textContent).toBe("1 of 3 done. 1 didn't go through. 1 still arriving.")
  })
})
