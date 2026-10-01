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

const ROW: Record<HunkLine['kind'], string> = {
  add: 'bg-verify/10 dark:bg-verify/15',
  del: 'bg-danger/10 dark:bg-danger/15',
  context: '',
  note: 'text-anvil-500 dark:text-anvil-400',
}
const SIGN: Record<HunkLine['kind'], string> = { add: '+', del: '-', context: ' ', note: '' }

/** The hunk's lines (no frame of its own): a table, or the raw text when it does not parse. */
export function DiffHunkLines({ hunk, anchor }: { hunk: string; anchor: Anchor | null }): JSX.Element {
  const parsed = parseDiffHunk(hunk, anchor === null ? undefined : { side: anchor.side, span: commentedSpan(anchor.line, anchor.startLine) })
  if (parsed === null) {
    return (
      <pre className="overflow-x-auto whitespace-pre px-3 py-2 font-mono text-[12px] leading-5 text-anvil-800 dark:text-anvil-100" data-testid="diff-hunk-text">
        {hunk}
      </pre>
    )
  }
  return (
    <div className="overflow-x-auto" data-testid="diff-hunk">
      <table className="w-full border-collapse font-mono text-[12px] leading-5">
        <tbody>
          <tr className="bg-anvil-50 text-anvil-500 dark:bg-anvil-900 dark:text-anvil-400">
            <td colSpan={3} className="whitespace-pre px-2">
              {parsed.header}
            </td>
          </tr>
          {parsed.lines.map((l, i) => (
            <tr key={i} className={l.marked ? 'bg-forge-500/15 dark:bg-forge-500/20' : ROW[l.kind]} data-kind={l.kind} data-marked={l.marked || undefined}>
              <td className="w-10 select-none px-2 text-right align-top text-anvil-500">{l.old ?? ''}</td>
              <td className="w-10 select-none px-2 text-right align-top text-anvil-500">{l.new ?? ''}</td>
              <td className="whitespace-pre px-2 text-anvil-800 dark:text-anvil-100">
                {l.kind === 'note' ? l.text : `${SIGN[l.kind]}${l.text}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
