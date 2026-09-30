'use client'

/**
 * An inline review comment's place in Conversation (QW2-049): its Outdated and Applied markers,
 * and the lines of code it was left on (`lib/view/anchor-snippet.ts`), as GitHub shows a review
 * comment under its diff hunk.
 */

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2 } from 'lucide-react'

import { readTextFile } from '@/lib/merge/branch-commit'
import type { Anchor } from '@/lib/rules/v2'
import type { ObjectReader } from '@/lib/view'
import { parseCommit } from '@/lib/view/git-objects'
import { snippetKey, snippetLines, type SnippetSource } from '@/lib/view/anchor-snippet'
import { anchorLabel } from '@/lib/view/inline-threads'
import { Oid } from '@/components/ui/oid'

const NO_TEXTS: ReadonlyMap<string, string | null> = new Map()

/**
 * The text of each file `sources` names (null: not a readable text file there), each read once
 * through `reader`; what was read stays shown while more is read.
 */
export function useSnippetTexts(reader: ObjectReader | null, sources: readonly SnippetSource[]): ReadonlyMap<string, string | null> {
  const [texts, setTexts] = useState<ReadonlyMap<string, string | null>>(NO_TEXTS)
  const known = useRef(texts)
  known.current = texts
  const readerRef = useRef(reader)
  readerRef.current = reader
  const key = [...new Set(sources.map(snippetKey))].sort().join('\n')
  const hasReader = reader !== null
  useEffect(() => {
    const r = readerRef.current
    const missing = key === '' ? [] : key.split('\n').filter((k) => !known.current.has(k))
    if (r === null || missing.length === 0) return
    let live = true
    void (async () => {
      const got: [string, string | null][] = []
      for (const k of missing) {
        const at = k.indexOf(':')
        const commit = k.slice(0, at)
        const path = k.slice(at + 1)
        const text = await (async () => readTextFile(r, parseCommit((await r.readObject(commit)).bytes).tree, path))().catch(() => null)
        got.push([k, text])
      }
      if (live) setTexts((t) => new Map([...t, ...got]))
    })()
    return () => {
      live = false
    }
  }, [key, hasReader])
  return texts
}

/** The Outdated / Applied markers of an inline comment. */
export function AnchorMarkers({ outdated, applied }: { outdated: boolean; applied: string | null }): JSX.Element | null {
  if (!outdated && applied === null) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {applied !== null ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-verify/10 px-2 py-0.5 text-[11px] text-verify-700 dark:text-verify-400" data-testid="conversation-applied">
          <CheckCircle2 className="h-3 w-3" aria-hidden /> Applied in <Oid value={applied} chars={7} copyable={false} />
        </span>
      ) : null}
      {outdated ? (
        <span className="rounded-full bg-anvil-100 px-2 py-0.5 text-[11px] text-anvil-700 dark:bg-anvil-800 dark:text-anvil-300" data-testid="conversation-outdated">
          Outdated
        </span>
      ) : null}
    </span>
  )
}

/**
 * An inline comment's heading in Conversation: where it points, its markers, and the lines it
 * was left on (none while they are read, or when the file cannot be read at that commit).
 */
export function AnchorContext({
  anchor,
  text,
  outdated,
  applied,
}: {
  anchor: Anchor
  /** The file at the anchor's side (`useSnippetTexts`); undefined while unread. */
  text: string | null | undefined
  outdated: boolean
  applied: string | null
}): JSX.Element {
  const lines = snippetLines(text, anchor)
  return (
    <div className="mb-2 overflow-hidden rounded-md border border-anvil-200 dark:border-anvil-800" data-testid="conversation-anchor">
      <div className="flex flex-wrap items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-3 py-1.5 dark:border-anvil-800 dark:bg-anvil-900">
        <span className="min-w-0 break-all font-mono text-[12px] text-anvil-700 dark:text-anvil-300">{anchorLabel(anchor)}</span>
        <AnchorMarkers outdated={outdated} applied={applied} />
      </div>
      {lines !== null ? (
        <div className="overflow-x-auto" data-testid="conversation-snippet">
          <table className="w-full border-collapse font-mono text-[12px] leading-5">
            <tbody>
              {lines.map((l) => (
                <tr key={l.n} className={l.commented ? 'bg-forge-500/10 dark:bg-forge-500/15' : ''}>
                  <td className="w-10 select-none px-2 text-right align-top text-anvil-500 dark:text-anvil-500">{l.n}</td>
                  <td className="whitespace-pre px-2 text-anvil-800 dark:text-anvil-100">{l.text === '' ? ' ' : l.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
