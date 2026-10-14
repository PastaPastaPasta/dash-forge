'use client'

/**
 * What a reader sees of posts a maintainer made public (DESIGN §4.6, §10; `lib/repo/made-public.ts`):
 * "Made public by @m" on the post, the note on a post its author sealed again afterwards, an
 * issue's earlier versions made public, and the one line that says a maintainer's entry did not
 * match the post it named.
 */

import { Globe } from 'lucide-react'

import { Author } from '@/components/author'
import { MarkdownView } from '@/components/markdown-view'
import type { BundleAlert, PublicationMarks, PublishedVersion } from '@/lib/repo/private-content'
import { plural, timeAgo } from '@/lib/view/format'

const MUTED = 'text-[12px] text-anvil-500 dark:text-anvil-400'

/** "Made public by @m": a small muted line in a post's header. */
export function MadePublicBy({ marks }: { marks: PublicationMarks }): JSX.Element | null {
  if (marks.madePublicBy === undefined) return null
  return (
    <span className={MUTED} data-testid="made-public-by">
      Made public by <Author identityId={marks.madePublicBy} link={false} className="align-middle" />
    </span>
  )
}

/**
 * The note on a post its author sealed again after a maintainer made it public: an issue shows the
 * version made public to everyone; a comment or review keeps its new text for members.
 */
export function EditedAfterPublicNote({ marks, kind }: { marks: PublicationMarks; kind: 'issue' | 'pull request' | 'comment' | 'review' }): JSX.Element | null {
  const by = marks.editedAfterPublicBy
  if (by === undefined) return null
  return (
    <p className={`${MUTED} px-4 py-1`} data-testid="edited-after-public">
      {kind === 'issue' ? (
        <>
          Edited after it was made public. Everyone sees the version <Author identityId={by} link={false} className="align-middle" /> made public.
        </>
      ) : (
        <>
          Edited after <Author identityId={by} link={false} className="align-middle" /> made it public; the new text is members-only.
        </>
      )}
    </p>
  )
}

/** "Earlier versions made public (2)": an issue's earlier versions a maintainer published, each with when. */
export function EarlierVersions({ versions }: { versions: readonly PublishedVersion[] | undefined }): JSX.Element | null {
  if (versions === undefined || versions.length === 0) return null
  return (
    <details className="mt-3 rounded-md border border-anvil-200 dark:border-anvil-800" data-testid="earlier-versions">
      <summary className={`cursor-pointer px-3 py-2 ${MUTED}`}>Earlier versions made public ({versions.length})</summary>
      <ol className="space-y-3 border-t border-anvil-200 px-3 py-2 dark:border-anvil-800">
        {versions.map((v) => (
          <li key={v.revision} className="space-y-1" data-testid="earlier-version">
            <p className={MUTED}>
              Version {v.revision}, saved {v.at > 0 ? timeAgo(v.at) : 'earlier'} · made public by <Author identityId={v.by} link={false} className="align-middle" />
            </p>
            <p className="font-medium">{v.title || '(untitled)'}</p>
            {v.body !== '' ? <MarkdownView source={v.body} /> : null}
          </li>
        ))}
      </ol>
    </details>
  )
}

/**
 * The maintainers' entries that did not match the post they named (each ignored), said once per
 * page near the hidden-items note: "@m's make-public entry for a post by @alice doesn't match it,
 * so it was ignored."
 */
export function BundleAlertsNote({ alerts }: { alerts: readonly BundleAlert[] | undefined }): JSX.Element | null {
  if (alerts === undefined || alerts.length === 0) return null
  // One line per maintainer and author: several entries of one bundle say the same thing.
  const lines = new Map<string, { by: string; author: string; n: number }>()
  for (const a of alerts) {
    const k = `${a.by}:${a.author}`
    const had = lines.get(k)
    lines.set(k, { by: a.by, author: a.author, n: (had?.n ?? 0) + 1 })
  }
  return (
    <div className={`mt-2 space-y-0.5 ${MUTED}`} data-testid="bundle-alerts" role="note">
      {[...lines.values()].map((l) => (
        <p key={`${l.by}:${l.author}`}>
          <Author identityId={l.by} link={false} className="align-middle" />
          {l.n === 1 ? "'s make-public entry for a post by " : `'s make-public entries for ${plural(l.n, 'post')} by `}
          <Author identityId={l.author} link={false} className="align-middle" />
          {l.n === 1 ? " doesn't match it, so it was ignored." : " don't match them, so they were ignored."}
        </p>
      ))}
    </div>
  )
}

/**
 * Under an author's edit of a post a maintainer made public: the edit is written as Public
 * (DESIGN §4.6, "after a bundle"), so the public and members never see different text.
 */
export function PublicEditHint({ marks }: { marks: PublicationMarks }): JSX.Element | null {
  if (!editIsPublic(marks)) return null
  const by = marks.madePublicBy as string
  return (
    <p className={`flex flex-wrap items-center gap-1 ${MUTED}`} data-testid="public-edit-hint">
      <Globe className="h-3 w-3" aria-hidden /> <span className="font-medium">Public</span> ·
      <Author identityId={by} link={false} className="align-middle" /> made this public, so your edit is public too.
    </p>
  )
}

/**
 * Under an author's edit of a pull request a maintainer made public: a PR's edit stays members-only
 * (its branch names cannot be made public by an edit), and everyone else then reads that it was
 * edited after it was made public.
 */
export function MembersEditHint({ marks }: { marks: PublicationMarks }): JSX.Element | null {
  if (marks.madePublicBy === undefined) return null
  return (
    <p className={MUTED} data-testid="members-edit-hint">
      <Author identityId={marks.madePublicBy} link={false} className="align-middle" /> made this public. Your edit will be members-only; everyone else will see that it was edited after it was made public.
    </p>
  )
}

/**
 * Whether an author's edit of a post with `marks` is written as Public: a maintainer made its
 * current revision public (`lib/repo/made-public.ts` `bundleCovers`, which the write reads). One
 * sealed again since stays members-only.
 */
export function editIsPublic(marks: PublicationMarks): boolean {
  return marks.madePublicBy !== undefined && marks.editedAfterPublicBy === undefined
}
