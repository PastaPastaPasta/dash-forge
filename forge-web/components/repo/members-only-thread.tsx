'use client'

/**
 * The page of an issue or PR this reader cannot open, with what it can read of the conversation
 * under it (DESIGN §4.10 L3, D14): the thread's public replies in the timeline's own style, its
 * members-only ones as placeholders, and, on a thread written while the repo (made public since)
 * was private, a composer for a public reply. Read by the thread's one composite read
 * (`loadIssueOrMembersOnly`, `loadPullOrMembersOnly`): nothing here reads more, but for the
 * repo's bans once there is a reply to fold them over and, for a signed-in writer, what any
 * comment form reads (membership, the cost preview's first writes).
 */

import { useMemo, useState } from 'react'

import { MembersOnlyTargetPage, useMembersTexts, useQuoteGate } from '@/components/repo/audience'
import { HiddenBanner, useThreadModeration } from '@/components/repo/moderation'
import { HiddenNote } from '@/components/repo/hidden-note'
import { LockedBanner, lockViewerOf } from '@/components/repo/locked-banner'
import { BodyCounter, PrivateComposeNote, composeCost } from '@/components/repo/private-compose'
import { useLongCompose } from '@/components/repo/long-body'
import { MarkdownEditor } from '@/components/repo/issue-bits'
import { Timeline } from '@/components/repo/timeline'
import { useRepoLinks } from '@/components/repo/target-href'
import { Button } from '@/components/ui/button'
import { CostPreview } from '@/components/ui/cost-preview'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useFirstWrite } from '@/hooks/use-first-write'
import { useIntent } from '@/hooks/use-intent'
import type { RepoAddress } from '@/hooks/use-query-param'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { ARCHIVED_REASON, type MembersOnlyTarget, type RepoHome } from '@/lib/view'
import { notPublic, publicReplyOffered, quotesMembersText, whilePrivateNote } from '@/lib/view/audience'
import { commentDraftKey, useDraftText } from '@/lib/view/draft-text'
import { BODY_MAX, utf8Length } from '@/lib/view/issue-query'
import { commentFirsts, createComment, LOCKED_REASON, lockedOut, readViewerPermissions, repoContractIds, repoKey } from '@/lib/repo'
import { totalHidden } from '@/lib/repo/private-content'
import type { Holdings } from '@/lib/rules'
import { SupersededWriteError, UnconfirmedWriteError } from '@/lib/sdk'

export function MembersOnlyThread({
  home,
  addr,
  target,
  onPosted,
}: {
  home: RepoHome
  addr?: RepoAddress | undefined
  target: MembersOnlyTarget
  /** A reply was posted (or sent, not yet shown): the page re-reads until comment `id` shows. */
  onPosted: (id: string) => void
}): JSX.Element {
  const kind = target.placeholder.type === 'patch' ? 'pull' : 'issue'
  return (
    <MembersOnlyTargetPage home={home} target={target}>
      <TargetReplies home={home} addr={addr} target={target} />
      {publicReplyOffered(home.repo.visibility, target, { lane: home.lane, laneLoading: home.laneLoading }) ? <PublicReplyComposer home={home} target={target} kind={kind} onPosted={onPosted} /> : null}
    </MembersOnlyTargetPage>
  )
}

/**
 * The thread's replies this reader can read, and its members-only ones as placeholders, as the
 * thread page shows them: hidden by a maintainer or a ban, collapsed with Show; a thread a
 * maintainer hid, collapsed whole until "Show it anyway".
 */
function TargetReplies({ home, addr, target }: { home: RepoHome; addr?: RepoAddress | undefined; target: MembersOnlyTarget }): JSX.Element | null {
  const { sdk, ready } = useSdk(repoContractIds(home.repo))
  const items = target.timeline ?? []
  const membersOnly = target.membersOnly ?? []
  // The repo's bans fold over readable replies only: none, no read.
  const moderation = useThreadModeration(items.length > 0 ? sdk : null, ready, home.repo, target.moderationInput, target.moderation)
  const [revealed, setRevealed] = useState(false)
  const links = useRepoLinks(addr ?? { owner: '', name: '' }, home.description)
  const hidden = target.hidden
  const threadHidden = moderation?.thread ?? null
  if (items.length === 0 && membersOnly.length === 0) return hidden === undefined ? null : <HiddenNote hidden={totalHidden(hidden)} what="comment" home={home} by={hidden} />
  return (
    <div className="space-y-4" data-testid="members-only-replies">
      {threadHidden !== null ? <HiddenBanner hidden={threadHidden} noun={target.placeholder.type === 'patch' ? 'pull request' : 'issue'} revealed={revealed} onReveal={() => setRevealed(true)} /> : null}
      {threadHidden !== null && !revealed ? null : (
        <Timeline items={items} membersOnly={membersOnly} {...(home.lane ? { lane: home.lane } : {})} {...(addr ? { links } : {})} {...(moderation ? { moderation } : {})} />
      )}
      {hidden !== undefined ? <HiddenNote hidden={totalHidden(hidden)} what="comment" home={home} by={hidden} shown={membersOnly.length} /> : null}
    </div>
  )
}

/**
 * A public reply to a thread written while the repo (made public since) was private, for a reader
 * who cannot open it (DESIGN §4.10, L3): "Public" only, said under the composer
 * ({@link whilePrivateNote}); written as any public comment is (`createComment`, which admits a
 * public child of such a thread). A locked thread takes it from members alone, as everywhere.
 */
function PublicReplyComposer({ home, target, kind, onPosted }: { home: RepoHome; target: MembersOnlyTarget; kind: 'issue' | 'pull'; onPosted: (id: string) => void }): JSX.Element | null {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const { identity, signer, locked } = useAuth()
  const guard = useWriteGuard()
  const draft = useIntent()
  const targetId = target.placeholder.id
  const holdings = useAsync<Holdings | null>(() => readViewerPermissions(sdk!, home.repo, identity!, network), [ready, repoKey(home.repo), identity ?? '', network], {
    enabled: ready && sdk !== null && identity !== null,
  })
  // Members-only text this tab opened in the repo: a public reply that repeats it asks first (H8).
  // ...and the members-only replies this page itself shows (a member who opened them, a thread page's `membersTextsOf`).
  const pageTexts = useMemo(() => (target.timeline ?? []).flatMap((x) => (x.kind === 'comment' && notPublic(x.comment.audience) ? [x.comment.body] : [])), [target.timeline])
  const membersTexts = useMembersTexts(home.repo.repoId, pageTexts)
  const quoteGate = useQuoteGate()
  const [comment, setComment, holdDraft] = useDraftText(commentDraftKey(home.repo, targetId, identity, 'public'), (text) => !quotesMembersText(text, membersTexts))
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstsReady = comment !== '' && ready && sdk !== null && identity !== null
  const first = useFirstWrite(() => commentFirsts(sdk!, home.repo, targetId, identity!, target.comments > 0), [targetId, identity ?? '', target.comments > 0], firstsReady)
  const long = useLongCompose(home.repo, 'comment', comment.trim())
  const tooLong = long.long ? long.problem !== null : utf8Length(comment) > BODY_MAX
  // Signed out: no composer (a signed-in reader, or a locked session, is offered one).
  if (identity === null && !locked) return null

  const archived = home.config?.archived === true
  const isMember = holdings.data?.member === true
  const post = { isMember, locked: target.locked === true }
  const lockApplies = post.locked && !archived
  const lockedOutNow = lockApplies && lockedOut(post)
  const block = archived ? ARCHIVED_REASON : lockedOutNow ? LOCKED_REASON : null
  const cost = composeCost(home.repo, 'comment', { body: comment.trim() }, first, 'public')

  const postComment = async (confirmed = false): Promise<void> => {
    // A locked session's "Unlock to comment" opens the unlock before there is any text to post.
    if (!identity && locked) {
      guard.check(cost, 'collab', 'comment')
      return
    }
    if (posting || block !== null || comment.trim() === '' || tooLong || !guard.check(cost, 'collab', 'comment')) return
    if (!sdk || !signer) return
    if (!confirmed && quotesMembersText(comment, membersTexts)) {
      quoteGate.check(comment, membersTexts, () => void postComment(true))
      return
    }
    setPosting(true)
    setError(null)
    // Until the outcome is known, a reload must not bring the text back to be posted again.
    holdDraft(true, comment)
    try {
      const posted = await createComment(sdk, signer, home.repo, { targetId, body: comment.trim(), intent: draft.intent, post, audience: 'public' })
      setComment('')
      holdDraft(false, '')
      draft.renew()
      onPosted(posted.documentId)
    } catch (e) {
      if (e instanceof SupersededWriteError) {
        // The earlier version was posted: show it, and never post this draft a second time.
        setComment('')
        holdDraft(false, '')
        draft.renew()
        onPosted(e.documentId)
      } else if (e instanceof UnconfirmedWriteError) {
        // Sent, not yet visible: keep reading until it shows (the draft stays, as the error says).
        onPosted(e.documentId)
      } else {
        holdDraft(false, comment)
      }
      setError(guard.failed(e))
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="members-only-reply-composer">
      {/* Locked: a non-member's composer is replaced by the banner (consensus would refuse the post). */}
      <LockedBanner locked={lockApplies} viewer={lockViewerOf(identity, holdings)} target={kind}>
        <h3 className="mb-2 text-dense font-medium">Add a comment</h3>
        {block !== null ? <PrivateComposeNote reason={block} /> : null}
        <MarkdownEditor id="comment-body" label="Comment" value={comment} onChange={setComment} placeholder="Leave a comment (markdown supported)…" onSubmit={block === null ? () => void postComment() : undefined} />
        <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="while-private-note">
          {whilePrivateNote(false)}
        </p>
      </LockedBanner>
      {lockedOutNow ? null : (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <CostPreview cost={cost} />
            <Button
              variant="primary"
              onClick={() => void postComment()}
              loading={posting}
              disabled={block !== null || (!identity && locked ? false : comment.trim() === '' || tooLong || guard.disabledReason !== null)}
              title={guard.disabledReason ?? undefined}
              data-testid="members-only-reply-post"
            >
              {identity ? 'Comment' : 'Unlock to comment'}
            </Button>
          </div>
          <BodyCounter repo={home.repo} text={comment} field="comment" long={long} />
        </>
      )}
      {error ? (
        <div role="alert" className="mt-2 break-words rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400">
          {error}
        </div>
      ) : null}
      {quoteGate.dialog}
    </div>
  )
}
