'use client'

/**
 * Long bodies on the page (`docs/contracts/forge-v2.md` §6.3). A body longer than its field is
 * read in full by the page's loader (`lib/view/long-body.ts`): these say when only its first part
 * could be shown, and tell a composer whether a text over the field can be posted (by a maintainer
 * or writer, stored as a repository artifact) and what that adds to its cost.
 */

import { useAsync } from '@/hooks/use-async'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { useSdk } from '@/hooks/use-sdk'
import { repoContractIds, repoKey, type RepoRef } from '@/lib/repo'
import { ANY_HASH, bodyRoom, longBodyCredits, mayStoreLongBodies, type LongBodyKind } from '@/lib/repo/long-body'
import { LONG_BODY_MAX_BYTES, longBodyStoredText, needsLongBodyArtifact, parseLongBody, utf8Bytes, type LongBodyState } from '@/lib/rules/long-body'
import { readLongBody, type BodyRead } from '@/lib/view/long-body'
import { creditsAsDash } from '@/lib/view/format'
import { formatCount } from '@/lib/view/text-limits'

/** The line under a text of which only the first part could be shown; nothing otherwise. */
export function LongBodyNote({ long }: { long?: LongBodyState | null }): JSX.Element | null {
  if (!long?.incomplete) return null
  return (
    <p role="note" data-testid="long-body-partial" className="mt-2 rounded-md border border-caution/30 bg-caution/5 px-3 py-2 text-[12px] text-caution-700 dark:text-caution-400">
      Only the first part of this text is shown{long.bytes !== null ? ` (the whole text is ${formatCount(long.bytes)} bytes)` : ''}: {long.incomplete}.
    </p>
  )
}

/**
 * `stored` (a field as read) as a reader shows it, read when `enabled` and it continues in an
 * artifact: null until then (and for a plain field, which reads nothing), with `loading` while
 * the full text is fetched. For a field a page's loader does not read (a release's notes).
 */
export function useLongText(repo: RepoRef, stored: string, enabled: boolean): { readonly read: BodyRead | null; readonly loading: boolean } {
  const { sdk, ready } = useSdk(repoContractIds(repo))
  const long = parseLongBody(stored).kind !== 'plain'
  const state = useAsync(() => readLongBody(sdk!, repo, stored), [ready, repoKey(repo), stored], { enabled: enabled && long && ready && sdk !== null })
  return { read: state.data ?? null, loading: enabled && long && state.data === null && state.error === null }
}

/** The line under a text whose full text is being read. */
export function LongBodyLoading({ loading }: { loading: boolean }): JSX.Element | null {
  if (!loading) return null
  return (
    <p data-testid="long-body-loading" aria-live="polite" className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
      Reading the rest of this text…
    </p>
  )
}

/** Why a text whose full text could not be read cannot be edited here (an edit would drop the rest), or null. */
export function longEditBlock(long?: LongBodyState | null): string | null {
  return long?.incomplete ? 'Only the first part of this text could be read, so it cannot be edited here' : null
}

/** What a composer's text over its field means for this viewer. */
export interface LongCompose {
  /** The text is longer than the field (or ends in a line that reads as a trailer). */
  readonly long: boolean
  /** Why it cannot be posted, or null. */
  readonly problem: string | null
  /** What storing its full text adds to the write (0 when it fits). */
  readonly credits: number
}

/**
 * Whether the composer's `text` for a `kind` field of `repo` (beside `others`) fits, or can be
 * stored whole by this viewer: a maintainer or a role-1 writer, up to 256 KiB.
 */
export function useLongCompose(repo: RepoRef, kind: LongBodyKind, text: string, others: Readonly<Record<string, unknown>> = {}): LongCompose {
  const viewer = useViewerRole(repo)
  const room = bodyRoom(repo, kind, others)
  if (!needsLongBodyArtifact(text, room)) return { long: false, problem: null, credits: 0 }
  const bytes = utf8Bytes(text)
  const credits = longBodyCredits(repo, bytes)
  if (bytes > LONG_BODY_MAX_BYTES) {
    return { long: true, credits, problem: `This text is ${formatCount(bytes)} bytes: Dash Forge keeps at most ${formatCount(LONG_BODY_MAX_BYTES)} bytes of one text.` }
  }
  if (viewer.failed) return { long: true, credits, problem: "Couldn't read your role in this repo, so a text this long cannot be posted yet: reload to try again." }
  if (!viewer.known) return { long: true, credits, problem: 'Checking whether you can post a text this long…' }
  if (longBodyStoredText(text, room, ANY_HASH) === null) {
    return { long: true, credits, problem: `The rest of this document's text leaves no room for its first part and the line naming the full text: shorten the title or the text.` }
  }
  if (!mayStoreLongBodies(viewer.role)) {
    return {
      long: true,
      credits,
      problem: `This text is ${formatCount(bytes)} bytes and the field holds ${formatCount(room)}. A longer text is stored as a repository artifact, which only the repo's maintainers and writers can record: shorten it, or split it into comments.`,
    }
  }
  return { long: true, credits, problem: null }
}

/** The composer's line for a text over its field: where it goes and what it adds, or why not. */
export function LongComposeNote({ compose, text }: { compose: LongCompose; text: string }): JSX.Element | null {
  if (!compose.long) return null
  if (compose.problem !== null) {
    return (
      <p data-testid="long-body-refused" aria-live="polite" className="mt-1 text-[11px] text-danger-700 dark:text-danger-400">
        {compose.problem}
      </p>
    )
  }
  return (
    <p data-testid="long-body-note" aria-live="polite" className="mt-1 text-[11px] text-anvil-600 dark:text-anvil-300">
      {formatCount(utf8Bytes(text))} bytes: more than the field holds, so the whole text is stored as a repository artifact on Platform (up to {creditsAsDash(compose.credits)} DASH more), and the field keeps its first part.
    </p>
  )
}
