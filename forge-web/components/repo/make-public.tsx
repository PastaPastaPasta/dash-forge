'use client'

/**
 * "Make public" (DESIGN §4.6, §10): for an author's own members-only post, the button, the
 * confirmation's words, and the quote check over the text being published (§12 item 15), which
 * warns when the post quotes someone else's members-only words this tab has opened; for a
 * maintainer, "Make public…" on other people's posts and "Make thread public…", whose dialog
 * ({@link MakePublicBundleDialog}) lists whose words become public, what is left out and why, the
 * history checkbox and the quote check over every text it publishes.
 */

import { useCallback, useState } from 'react'
import { Globe } from 'lucide-react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { quotedMembersPost, quotedMembersPostExcept, type MembersPostKind } from '@/lib/repo/members-texts'
import {
  bundleCredits,
  planMakePublicBundle,
  writeMakePublicBundle,
  type BundlePlan,
  type BundleRequest,
  type BundledPost,
} from '@/lib/repo/make-public-bundle'
import type { RepoRef } from '@/lib/repo/contract'
import { listOf } from '@/lib/rules/roles'
import { previewCredits } from '@/lib/sdk/cost'
import { plural } from '@/lib/view/format'
import { useSdk } from '@/hooks/use-sdk'
import { warningName } from '@/components/repo/audience'

/** The "Make public" action beside an author's own members-only post. */
export function MakePublicButton({ onClick, disabled, title }: { onClick: () => void; disabled?: boolean; title?: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1 text-[12px] text-anvil-500 hover:text-forge-700 disabled:opacity-50 dark:text-anvil-400 dark:hover:text-forge-400 coarse:min-h-11 coarse:px-1"
      data-testid="make-public"
    >
      <Globe className="h-3 w-3" aria-hidden /> Make public
    </button>
  )
}

/** What the confirmation says about one post: the §10 words, and what else to know. */
export interface MakePublicWords {
  readonly title: string
  readonly description: string
  readonly label: string
}

/**
 * The confirmation for making one's own `kind` post public (DESIGN §10). `quoted`: the quote
 * check's finding, from {@link useQuotedMembersPost}. `losesFile`: an inline comment, whose file
 * name can't be made public on this network.
 */
export function makePublicWords(kind: MembersPostKind, quoted: string | null, losesFile = false): MakePublicWords {
  const description =
    kind === 'review'
      ? "It's added as a public comment on your review. This can't be undone."
      : "Everyone will be able to read it as you save it now. Earlier versions stay members-only. This can't be undone."
  const parts = [description]
  if (losesFile) parts.push("Its file name can't be made public, so the comment will show without it.")
  if (quoted !== null) parts.push(quoted)
  return {
    title: kind === 'review' ? "Make your review's text public?" : `Make your ${kind} public?`,
    description: parts.join(' '),
    label: quoted === null ? 'Make public' : 'Make public anyway',
  }
}

/**
 * The quote check of the make-public dialog (DESIGN §4.6, §12 item 15): the warning for `text`,
 * which `author` is making public as a `kind`, when it quotes someone else's members-only post
 * this tab has opened in repo `repoId` ("Your comment quotes @bob's members-only comment.
 * Everyone will be able to read the quoted text."), or null.
 */
export function useQuotedMembersPost(repoId: string): (text: string, author: string, kind: MembersPostKind) => string | null {
  const { network } = useSdk()
  return useCallback(
    (text, author, kind) => {
      const hit = quotedMembersPost(repoId, text, author)
      if (hit === null) return null
      const yours = kind === 'review' ? "Your review's text" : `Your ${kind}`
      return `${yours} quotes @${warningName(network, hit.author)}'s members-only ${hit.kind}. Everyone will be able to read the quoted text.`
    },
    [repoId, network],
  )
}

/** "Make public…": a maintainer's action on someone else's members-only post (DESIGN §4.6, §10). */
export function MakeOthersPublicButton({ onClick, disabled, thread = false }: { onClick: () => void; disabled?: boolean; thread?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 text-[12px] text-anvil-500 hover:text-forge-700 disabled:opacity-50 dark:text-anvil-400 dark:hover:text-forge-400 coarse:min-h-11 coarse:px-1"
      data-testid={thread ? 'make-thread-public' : 'make-others-public'}
    >
      <Globe className="h-3 w-3" aria-hidden /> {thread ? 'Make thread public…' : 'Make public…'}
    </button>
  )
}

/** Someone else's post, for a reader who is not a maintainer: the §10 words, never a button. */
export const ASK_A_MAINTAINER = "Only maintainers can make other people's posts public. Ask a maintainer"

/** A post's kind in words. */
function noun(type: BundledPost['type'] | BundleRequest['type']): MembersPostKind {
  return type === 'patch' ? 'pull request' : type
}

/** The confirmation of a maintainer's bundle, from its plan (DESIGN §10). */
export interface BundleWords {
  readonly title: string
  readonly description: string
  /** What the bundle leaves out, one sentence each. */
  readonly leftOut: readonly string[]
  readonly label: string
  /** Why nothing can be made public (no post left), or null. */
  readonly nothing: string | null
}

/**
 * The words of a maintainer's make-public dialog for `plan` (DESIGN §10): "Make 6 posts public?";
 * "Words by alice, bob and carol become public. They'll be notified."; a message to specific
 * people adds who it was sent to; then the quote check's findings (`quoted`), and "This can't be
 * undone." `name` gives an identity's short name. What is left out is listed apart.
 */
export function bundleWords(plan: BundlePlan, quoted: readonly string[], name: (id: string) => string): BundleWords {
  const n = plan.posts.length
  const one = n === 1
  const authors = [...new Set(plan.posts.map((p) => p.author))].map(name)
  const parts = [`Words by ${listOf(authors, 'and')} become public. They'll be notified.`]
  for (const p of plan.posts) {
    if (p.recipients === null) continue
    const people = plural(p.recipients, 'person', 'people')
    parts.push(one ? `It was sent only to ${people}; everyone will be able to read it.` : `@${name(p.author)}'s message was sent only to ${people}; everyone will be able to read it.`)
  }
  parts.push(...quoted, "This can't be undone.")
  const leftOut: string[] = []
  const cantRead = plan.leftOut.filter((l) => l.why === 'unreadable' || l.why === 'notSent')
  const single = n === 0 && plan.leftOut.length === 1
  for (const l of plan.leftOut) {
    if (l.why === 'longBody') leftOut.push(`@${name(l.author)}'s ${noun(l.type)} is too long to make public this way.`)
    if (l.why === 'pullRequest') leftOut.push("A pull request's own text can't be made public yet.")
  }
  if (single && cantRead.length === 1) {
    const l = cantRead[0]!
    leftOut.push(l.why === 'notSent' ? `You can't make @${name(l.author)}'s message public: it wasn't sent to you.` : `You can't read @${name(l.author)}'s ${noun(l.type)}, so you can't make it public.`)
  } else if (cantRead.length > 0) {
    leftOut.push(`${plural(cantRead.length, 'post')} you can't read ${cantRead.length === 1 ? 'stays' : 'stay'} as ${cantRead.length === 1 ? 'it is' : 'they are'}.`)
  }
  let nothing: string | null = null
  if (n === 0) nothing = plan.leftOut.every((l) => l.why === 'alreadyPublic') ? 'Everything here is public already.' : 'Nothing here can be made public.'
  return {
    title: `Make ${plural(n, 'post')} public?`,
    description: parts.join(' '),
    leftOut,
    label: quoted.length === 0 ? 'Make public' : 'Make public anyway',
    nothing,
  }
}

/**
 * The quote check of a maintainer's bundle (DESIGN §4.6, §12 item 15): for each text it publishes,
 * the members-only post of this repo it quotes that stays members-only (not in the bundle, not the
 * maintainer's own): "@alice's comment quotes @dan's members-only comment, which stays
 * members-only. Everyone will be able to read the quoted text."
 */
export function bundleQuotes(repoId: string, plan: BundlePlan, signer: string, name: (id: string) => string): string[] {
  const ids = new Set(plan.posts.map((p) => p.id))
  const authors = new Set([signer])
  const out: string[] = []
  for (const p of plan.posts) {
    const hit = quotedMembersPostExcept(repoId, p.text, { ids, authors })
    if (hit === null) continue
    out.push(`@${name(p.author)}'s ${noun(p.type)} quotes @${name(hit.author)}'s members-only ${hit.kind}, which stays members-only. Everyone will be able to read the quoted text.`)
  }
  return out
}

/**
 * A maintainer's make-public dialog over `requests` (one post, or a whole thread): the plan is read
 * when it opens (each post checked with the maintainer's keys, none kept), then the confirmation
 * with "Also publish earlier edits" when an issue in it has earlier members-only versions, and the
 * write. Closed (`requests` null) it renders nothing.
 */
export function MakePublicBundleDialog({
  repo,
  requests,
  maintainer,
  onClose,
  onDone,
}: {
  repo: RepoRef
  requests: readonly BundleRequest[] | null
  /**
   * The viewer is a maintainer or the owner, as the page read it: anyone else is told to ask one,
   * and nothing is read. The write reads the role again.
   */
  maintainer: boolean
  onClose: () => void
  /** The bundle landed: re-read what it made public. */
  onDone: () => void
}): JSX.Element {
  const { sdk, network } = useSdk()
  const { signer } = useAuth()
  const [history, setHistory] = useState(false)
  const key = requests === null ? '' : requests.map((r) => `${r.type}:${r.id}`).join(',')
  const planned = useAsync<BundlePlan>(
    async () => planMakePublicBundle(sdk!, signer!, repo, requests ?? []),
    [key, repo.repoId, signer?.identityId],
    { enabled: requests !== null && maintainer && sdk !== null && signer !== null },
  )
  const name = (id: string): string => warningName(network, id)
  const plan = planned.data
  const words = plan === null ? null : bundleWords(plan, bundleQuotes(repo.repoId, plan, signer?.identityId ?? '', name), name)
  const entries = plan === null ? 0 : plan.entries + (history ? plan.earlier : 0)
  const close = (): void => {
    setHistory(false)
    onClose()
  }
  let blocked: string | null = null
  if (signer === null) blocked = 'Sign in to make posts public.'
  else if (!maintainer) blocked = `${ASK_A_MAINTAINER}.`
  else if (planned.error !== null) blocked = planned.error
  else if (words?.nothing != null) blocked = words.nothing
  return (
    <ConfirmDialog
      open={requests !== null}
      onClose={close}
      title={words?.title ?? 'Make public?'}
      description={maintainer ? (words?.description ?? 'Reading the posts…') : ''}
      cost={plan === null || entries === 0 ? 'pending' : previewCredits(bundleCredits(entries))}
      confirmLabel={words?.label ?? 'Make public'}
      {...(blocked !== null ? { blocked } : {})}
      onConfirm={async (intent) => {
        if (sdk === null || signer === null || requests === null) throw new Error('sign in to continue')
        await writeMakePublicBundle(sdk, signer, repo, requests, { history, intent })
        setHistory(false)
        onDone()
      }}
      successNote="Made public"
    >
      {plan !== null && plan.earlier > 0 ? (
        <label className="flex items-center gap-2 text-dense" data-testid="publish-earlier-edits">
          <input type="checkbox" className="h-4 w-4 accent-forge-700" checked={history} onChange={(e) => setHistory(e.target.checked)} />
          Also publish earlier edits ({plan.earlier})
        </label>
      ) : null}
      {words !== null && words.leftOut.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="make-public-left-out">
          {words.leftOut.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
    </ConfirmDialog>
  )
}
