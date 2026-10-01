'use client'

/**
 * A mirrored review comment's source diff hunk (QW2-010), as GitHub shows a review comment under
 * its hunk: each line numbered on both sides, added and removed lines tinted, the commented
 * range marked. The hunk is the source's text: rendered as text only, and as plain monospace
 * text when it does not parse (`lib/view/diff-hunk.ts`). Callers show it only for a comment
 * whose provenance is trusted (`trustedOrigin`).
 */

import type { Anchor } from '@/lib/rules/v2'
import { commentedSpan, parseDiffHunk, type HunkLine } from '@/lib/view/diff-hunk'
import { ScrollRegion } from '@/components/ui/scroll-region'
import { GUTTER_TEXT } from '@/components/repo/diff-view'
import { cn } from '@/lib/utils'

const ROW: Record<HunkLine['kind'], string> = {
  add: 'bg-verify/10 dark:bg-verify/15',
  del: 'bg-danger/10 dark:bg-danger/15',
  context: '',
  note: GUTTER_TEXT,
}
const SIGN: Record<HunkLine['kind'], string> = { add: '+', del: '-', context: ' ', note: '' }

/**
 * The hunk's lines (no frame of its own): a table, or the raw text when it does not parse. A long
 * line scrolls, reachable by Tab (QW3-020), with the diff gutter's AA colours.
 */
export function DiffHunkLines({ hunk, anchor }: { hunk: string; anchor: Anchor | null }): JSX.Element {
  const parsed = parseDiffHunk(hunk, anchor === null ? undefined : { side: anchor.side, span: commentedSpan(anchor.line, anchor.startLine) })
  if (parsed === null) {
    return (
      <ScrollRegion as="pre" label="Source diff hunk" className="overflow-x-auto whitespace-pre px-3 py-2 font-mono text-[12px] leading-5 text-anvil-800 focus-visible:ring-inset focus-visible:ring-offset-0 dark:text-anvil-100" data-testid="diff-hunk-text">
        {hunk}
      </ScrollRegion>
    )
  }
  return (
    <ScrollRegion label="Source diff hunk" className="overflow-x-auto focus-visible:ring-inset focus-visible:ring-offset-0" data-testid="diff-hunk">
      <table className="w-full border-collapse font-mono text-[12px] leading-5">
        <tbody>
          <tr className={cn('bg-anvil-50 dark:bg-anvil-900', GUTTER_TEXT)}>
            <td colSpan={3} className="whitespace-pre px-2">
              {parsed.header}
            </td>
          </tr>
          {parsed.lines.map((l, i) => (
            <tr key={i} className={l.marked ? 'bg-forge-500/15 dark:bg-forge-500/20' : ROW[l.kind]} data-kind={l.kind} data-marked={l.marked || undefined}>
              <td className={cn('w-10 select-none px-2 text-right align-top', GUTTER_TEXT)}>{l.old ?? ''}</td>
              <td className={cn('w-10 select-none px-2 text-right align-top', GUTTER_TEXT)}>{l.new ?? ''}</td>
              <td className="whitespace-pre px-2 text-anvil-800 dark:text-anvil-100">
                {l.kind === 'note' ? l.text : `${SIGN[l.kind]}${l.text}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  )
}
