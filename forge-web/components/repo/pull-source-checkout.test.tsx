// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Store } from '@/lib/view/diff-fixtures'
import { checkMerge } from '@/lib/view/merge-check'
import { PullSourceCheckout } from './pull-source-checkout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Props = ComponentProps<typeof PullSourceCheckout>
const CHECKOUT = 'dg pr checkout base/project 6'
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

/** Separate base/fork readers: a squash/rebase's original head is absent from the base. */
async function fixture(kind: 'contains' | 'squash' | 'rebase' = 'squash'): Promise<Props> {
  const s = new Store()
  const base = s.commit(s.files({ 'base.txt': 'base' }))
  const first = s.commit(s.files({ 'base.txt': 'base', 'a.txt': 'a' }), [base])
  const tree = s.files({ 'base.txt': 'base', 'a.txt': 'a', 'b.txt': 'b' })
  const head = s.commit(tree, [first])
  const fork = s.reader(s.snapshot())
  const replayed = kind === 'rebase' ? s.commit(s.files({ 'base.txt': 'base', 'a.txt': 'a' }), [base]) : base
  const oid = s.commit(tree, kind === 'contains' ? [base, head] : [replayed])
  const baseObjects = s.snapshot()
  if (kind !== 'contains') {
    baseObjects.delete(first)
    baseObjects.delete(head)
  }
  const baseReader = s.reader(baseObjects)
  const content = await checkMerge({ base: baseReader, head: fork }, { headOid: head, mergeOid: oid, tipBefore: base })
  expect(content.verdict).toBe(kind)
  if (kind !== 'contains') await expect(baseReader.readObject(head)).rejects.toThrow()
  return {
    deleted: true, sourceMissing: false, checkout: CHECKOUT, headOid: head,
    merge: { oid, headOid: head, baseBranch: 'main', onBase: true, content },
    source: { ownerId: 'fork-owner', name: 'project', reader: fork, readerKey: 'fork-v1' },
  }
}

async function render(props: Props): Promise<void> {
  await act(async () => root.render(<PullSourceCheckout {...props} />))
}
const commands = (): string[] => [...host.querySelectorAll('div > code')].map((el) => el.textContent ?? '')

describe('PR checkout after source deletion', () => {
  it.each(['squash', 'rebase'] as const)('%s: checks out the merge result and fetches original commits from the surviving fork', async (kind) => {
    const props = await fixture(kind)
    await render(props)
    expect(host.textContent).toContain(`The ${kind} commit is ${props.merge!.oid.slice(0, 7)}, in main's history:`)
    expect(host.textContent).not.toContain(`head is ${props.headOid.slice(0, 7)}, in main's history`)
    expect(host.textContent).toContain("For the PR's original commits, fetch its head from the source repo:")
    expect(commands()).toEqual([
      `git switch --detach ${props.merge!.oid}`,
      `git fetch dash://fork-owner/project ${props.headOid} && git switch --detach ${props.headOid}`,
    ])
  })

  it.each(['squash', 'rebase'] as const)('%s: a missing fork still offers the recorded base result, never the original head', async (kind) => {
    const props = await fixture(kind)
    await render({ ...props, deleted: false, sourceMissing: true, source: null })
    expect(host.textContent).toContain('The source repo is unavailable.')
    expect(commands()).toEqual([`git switch --detach ${props.merge!.oid}`])
    expect(host.textContent).not.toContain('original commits')
  })

  it.each([false, true])('merge commit: keeps the verified original-head checkout (fork missing: %s)', async (missing) => {
    const props = await fixture('contains')
    await render({ ...props, sourceMissing: missing, source: missing ? null : props.source })
    expect(host.textContent).toContain(`The PR's head is ${props.headOid.slice(0, 7)}, in main's history:`)
    expect(commands()).toEqual([`git switch --detach ${props.headOid}`])
  })

  it.each(['contains', 'squash', 'rebase'] as const)('%s: keeps PR checkout while the fork branch exists', async (kind) => {
    const props = await fixture(kind)
    await render({ ...props, deleted: false })
    expect(commands()).toEqual([CHECKOUT])
    expect(host.textContent).not.toContain('history')
  })

  it.each([false, null, undefined])('does not claim base history without a verified base result (%s)', async (onBase) => {
    const props = await fixture('contains')
    await render({ ...props, merge: { ...props.merge!, onBase }, source: null })
    expect(commands()).toEqual([])
    expect(host.textContent).not.toContain('history')
  })

  it.each([null, { verdict: 'unknown', combined: [] }, { verdict: 'missing', combined: [] }] as const)('uses only the recorded base result when merge content is unchecked (%j)', async (content) => {
    const props = await fixture()
    await render({ ...props, merge: { ...props.merge!, content }, source: null })
    expect(host.textContent).toContain('The recorded merge commit is')
    expect(commands()).toEqual([`git switch --detach ${props.merge!.oid}`])
  })

  it('does not offer a source fetch when the original head cannot be read there', async () => {
    const props = await fixture()
    await render({ ...props, source: { ...props.source!, reader: new Store().reader() } })
    expect(commands()).toEqual([`git switch --detach ${props.merge!.oid}`])
  })

  it('fetches original commits explicitly from the same repo after a squash', async () => {
    const props = await fixture()
    await render({ ...props, source: { ...props.source!, ownerId: 'base' } })
    expect(commands()[1]).toBe(`git fetch dash://base/project ${props.headOid} && git switch --detach ${props.headOid}`)
  })

  it('withdraws a source fetch if a newer source reader no longer holds the head', async () => {
    const props = await fixture()
    await render(props)
    expect(commands()).toHaveLength(2)
    await render({ ...props, source: { ...props.source!, reader: new Store().reader(), readerKey: 'fork-v2' } })
    expect(commands()).toEqual([`git switch --detach ${props.merge!.oid}`])
  })

  it('does not invent a merge result when the recorded OID is missing', async () => {
    const props = await fixture()
    await render({ ...props, merge: { ...props.merge!, oid: '' }, source: null })
    expect(commands()).toEqual([])
    expect(host.textContent).not.toContain('history')
  })

  it('uses the verified head at merge time, rather than a later head update', async () => {
    const props = await fixture('contains')
    await render({ ...props, headOid: 'ff'.repeat(20) })
    expect(commands()).toEqual([`git switch --detach ${props.merge!.headOid}`])
  })

  it('keeps a closed, unmerged deleted branch informational', async () => {
    const props = await fixture()
    await render({ ...props, merge: null })
    expect(host.textContent).toContain(`The branch was deleted. The PR's head is ${props.headOid.slice(0, 7)}.`)
    expect(commands()).toEqual([])
  })
})
