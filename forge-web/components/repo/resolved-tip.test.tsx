// @vitest-environment jsdom
/**
 * ResolvedTip's states: a tag of a blob reaches a file view (`accepts="any"`) but not a history
 * view; storage that stopped answering shows its card, not a bare error; a bad id with no retry
 * worth trying offers none, and "Commit not found" offers one.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/components/repo/storage-unreachable', () => ({ StorageUnreachableCard: () => <div data-testid="storage-card" /> }))

let answer: () => Promise<unknown> = async () => ({ oid: 'b'.repeat(40), type: 'blob' })
vi.mock('@/lib/view/tip', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/view/tip')>()
  return { ...real, peekTip: () => undefined, resolveTip: () => answer() }
})

import { CommitIdError } from '@/lib/view'
import { PackUnavailableError } from '@/lib/view/browse-source'
import { ResolvedTip, type TipAccepts } from './resolved-tip'

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

async function render(accepts: TipAccepts): Promise<void> {
  await act(async () => {
    root.render(
      <ResolvedTip
        reader={{} as never}
        retry={() => undefined}
        repo={{ repoId: 'r' } as never}
        tip={'a'.repeat(40)}
        pinned={false}
        name="key-file"
        addr={{ owner: 'o', name: 'n' }}
        refParam="tags/key-file"
        accepts={accepts}
        label="Reading"
      >
        {(tip) => <div data-testid="body">{tip.type}</div>}
      </ResolvedTip>,
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('ResolvedTip', () => {
  it('hands a tag of a blob to a file view', async () => {
    answer = async () => ({ oid: 'b'.repeat(40), type: 'blob' })
    await render('any')
    expect(el.querySelector('[data-testid="body"]')?.textContent).toBe('blob')
  })

  it('says a tag of a blob has no history, with a way to the file', async () => {
    answer = async () => ({ oid: 'b'.repeat(40), type: 'blob' })
    await render('commit')
    expect(el.querySelector('[data-testid="body"]')).toBeNull()
    expect(el.textContent).toContain('key-file is a tag of a single file')
    expect(el.querySelector('a')?.getAttribute('href')).toContain('/repo/blob/')
  })

  it('shows the storage card when a pack cannot be fetched', async () => {
    answer = async () => {
      throw new PackUnavailableError('ab'.repeat(32), ['s3.example.com'], false, 'timeout')
    }
    await render('commit')
    expect(el.querySelector('[data-testid="storage-card"]')).not.toBeNull()
  })

  it('offers Try again for a commit not found, and none for an ambiguous id', async () => {
    answer = async () => {
      throw new CommitIdError('not-found', 'ffff00')
    }
    await render('commit')
    expect(el.textContent).toContain('Commit not found')
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Try again')).toBe(true)

    answer = async () => {
      throw new CommitIdError('ambiguous', 'abcd', ['a'.repeat(40), 'b'.repeat(40)])
    }
    await act(async () => root.unmount())
    root = createRoot(el)
    await render('commit')
    expect(el.textContent).toContain('Ambiguous commit id')
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Try again')).toBe(false)
  })
})
