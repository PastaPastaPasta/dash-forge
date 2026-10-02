// @vitest-environment jsdom
/**
 * QW4-029: a mirrored thread's replies repeated the import's provenance quote and file line on
 * every reply ("Mirrored from github.com/dashpay/dips#161 by @hushmirror (review comment, …)",
 * "dip-ct.md line 88"); dips #161 had 62 of them. A trusted mirror's reply shows its body alone, as
 * its root already did: the byline says who and when, the thread says where.
 */

import { act, useContext, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef } from '@/lib/repo'
import type { CommentView } from '@/lib/view'
import { lineKey } from '@/lib/view/inline-threads'
import { InlineCommentsContext } from '@/components/repo/diff-view'
import { InlineCommentsProvider } from './inline-comments'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: null, identity: null }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-first-write', () => ({ useFirstWrite: () => ({}) }))
vi.mock('@/hooks/use-mirror-trust', () => ({ useMirrorTrust: () => new Set(['MIRROR']) }))
vi.mock('@/components/repo/byline', () => ({ Byline: () => <span /> }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HEAD = 'a'.repeat(40)
const FILE = 'dip-ct.md'
const repo = { repoId: 'R', name: 'dips', visibility: 'public' } as unknown as RepoRef
const anchor = { path: FILE, line: 2, startLine: null, side: 1 as const, commitOid: HEAD }
const origin = (author: string) => ({ author, createdAt: 1_700_000_000_000, url: 'https://github.com/dashpay/dips/pull/161#discussion_r1', host: 'github.com' })
const banner = (who: string) => `> Mirrored from github.com/dashpay/dips#161 by @${who} (review comment, 2024-11-26)\n\n\`${FILE}\` line 2\n\n`
const root: CommentView = { id: 'c1', author: 'MIRROR', body: `${banner('UdjinM6')}This applies to one implementation only`, createdAt: 1, replyTo: null, anchor, reviewId: null, imported: true, origin: origin('UdjinM6') } as never
const reply: CommentView = { id: 'c2', author: 'MIRROR', body: `${banner('hushmirror')}ok, I will remove implementation-specific details`, createdAt: 2, replyTo: 'c1', anchor: null, reviewId: null, imported: true, origin: origin('hushmirror') } as never
const stranger: CommentView = { id: 'c3', author: 'STRANGER', body: `${banner('someone')}not a mirror`, createdAt: 3, replyTo: 'c1', anchor: null, reviewId: null, imported: true, origin: origin('someone') } as never

function FakeDiff(): JSX.Element {
  const inline = useContext(InlineCommentsContext)!
  useEffect(() => inline.report(FILE, new Set([lineKey(FILE, 1, 2)])), [inline])
  return <div>{inline.render(FILE, 1, 2)}</div>
}

let host: HTMLDivElement
let r: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  r = createRoot(host)
})
afterEach(() => {
  act(() => r.unmount())
  host.remove()
})

describe('mirrored thread replies (QW4-029)', () => {
  it('shows a trusted mirror\'s root and reply without the provenance quote and file line; anyone else\'s as written', () => {
    act(() =>
      r.render(
        <InlineCommentsProvider repo={repo} pullId="P" headOid={HEAD} comments={[root, reply, stranger]} changedPaths={new Set([FILE])} onPosted={() => undefined}>
          <FakeDiff />
        </InlineCommentsProvider>,
      ),
    )
    const blocks = [...host.querySelectorAll('[data-testid="thread-comment"]')].map((b) => b.textContent ?? '')
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toContain('This applies to one implementation only')
    expect(blocks[1]).toContain('ok, I will remove implementation-specific details')
    for (const b of blocks.slice(0, 2)) {
      expect(b).not.toContain('Mirrored from')
      expect(b).not.toContain(`${FILE} line 2`)
    }
    // Not signed by a mirror: its text is not trusted provenance, so nothing is taken out.
    expect(blocks[2]).toContain('Mirrored from')
  })
})
