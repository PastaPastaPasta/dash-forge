'use client'

/**
 * Who wrote an issue, PR, comment or review, and when (FG-6, L-04). An imported item from a
 * trusted mirror (`trustedOrigin`) shows its ORIGINAL author as plain text with the source
 * host (`@bob on github.com`), never linked to a Forge profile of that name (L-38: any Forge
 * identity may register any name), and its original date, with "mirrored" naming who copied it
 * and when. Everything else shows its signer and the chain time, as before.
 */

import { Author } from '@/components/author'
import { timeAgo } from '@/lib/view'
import type { Origin } from '@/lib/repo/provenance'

/** An exact timestamp for a `title` and `dateTime`: `2026-08-03 14:05 UTC`. */
export function exactTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

/** `<time>` with the relative text and the exact time on hover. */
export function Time({ ms, prefix = '' }: { ms: number; prefix?: string }): JSX.Element | null {
  if (!ms) return null
  return (
    <time dateTime={new Date(ms).toISOString()} title={exactTime(ms)}>
      {prefix}
      {timeAgo(ms)}
    </time>
  )
}

/** The original author of an imported item, as text naming where they are. */
export function OriginAuthor({ origin }: { origin: Origin }): JSX.Element {
  return (
    <span className="font-medium text-anvil-800 dark:text-anvil-100" data-testid="origin-author" title={origin.url || undefined}>
      @{origin.author || 'unknown'}
      {origin.host ? <span className="font-normal text-anvil-500 dark:text-anvil-400"> on {origin.host}</span> : null}
    </span>
  )
}

/**
 * `author` (a Forge identity) or, for a trusted import, the original author; with the chain
 * time or the original time. `verb` sits between them (`opened`, `commented`, …).
 */
export function Byline({
  author,
  createdAt,
  origin,
  verb,
  link = true,
}: {
  author: string
  createdAt: number
  origin: Origin | null
  verb?: string
  link?: boolean
}): JSX.Element {
  if (origin === null) {
    return (
      <>
        <Author identityId={author} link={link} />
        <span className="text-anvil-500 dark:text-anvil-400">
          {verb ? `${verb} ` : ''}
          <Time ms={createdAt} />
        </span>
      </>
    )
  }
  return (
    <>
      <OriginAuthor origin={origin} />
      <span className="text-anvil-500 dark:text-anvil-400">
        {verb ? `${verb} ` : ''}
        {origin.createdAt ? <Time ms={origin.createdAt} /> : null}
      </span>
      <span className="rounded bg-anvil-100 px-1.5 text-[11px] text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300" title={`Mirrored ${exactTime(createdAt)} by this repo's mirror identity`}>
        mirrored
      </span>
    </>
  )
}
