'use client'

/**
 * InviteBanner — the invitee's side of adding a collaborator (RC1 R-06, `member_consent`).
 *
 * Consensus makes nobody a maintainer or writer without their own `consent` document for the
 * repo, so an invitation is two steps: the owner shares the repo's invite link (`&invite=1`,
 * Settings → Collaborators), the invitee accepts here (their `consent`), then the owner adds them.
 * The banner shows only on an invite link, to a signed-in viewer who is neither the owner nor a
 * member yet. Signed out (or locked), it shows the invitation with Sign in (Unlock) to accept,
 * as GitHub sends an invitee through sign-in to the accept page (QW2-012); the sheet opens over
 * this page, so the link's `&invite=1` is still there once they are in. Nothing on chain names an invitation: a consent is the invitee's standing "yes" to
 * this repo, and lets the owner add them again later.
 */

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { UserPlus } from 'lucide-react'
import { acceptInvite, findConsent, readConsents, readMembershipsCached, repoContractIds, type RepoRef } from '@/lib/repo'
import type { Role } from '@/lib/rules/v2'
import { repoHref } from '@/hooks/use-query-param'
import { CopyRow } from '@/components/ui/copy-row'
import { previewCreate } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { readUntil } from '@/lib/view/retry'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'

/** The query parameter an invite link carries. */
export const INVITE_PARAM = 'invite'

/** How soon the owner's Settings re-reads the pending invitations while the page is visible. */
export const INVITES_POLL_MS = 10_000
/** The longest wait between those re-reads once nothing new has turned up for a while. */
export const INVITES_POLL_MAX_MS = 60_000

type Standing = 'member' | 'accepted' | 'invited'

export function InviteBanner({ repo }: { repo: RepoRef }): JSX.Element | null {
  const params = useSearchParams()
  const invited = params.get(INVITE_PARAM) !== null
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity, signer, locked, resuming } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const guard = useWriteGuard()
  const [confirming, setConfirming] = useState(false)
  // The identity whose accept this tab confirmed (the write's proof, or the consent it found). A
  // node that has not indexed that consent yet answers "none"; that must not turn the banner back
  // into "Accept invitation" (D-10). Keyed by identity so a switched account starts over.
  const [acceptedBy, setAcceptedBy] = useState<string | null>(null)
  const accepted = acceptedBy !== null && acceptedBy === identity
  const applies = invited && identity !== null && identity !== repo.ownerId
  const standing = useAsync<Standing>(
    async (signal) => {
      const read = async (): Promise<Standing> => {
        const members = await readMembershipsCached(sdk!, repo, network)
        if (members.some((m) => m.identity === identity)) return 'member'
        return (await findConsent(sdk!, repo, identity!)) !== null ? 'accepted' : 'invited'
      }
      if (!accepted) return read()
      // After this tab's accept, re-read until a node shows it (bounded; stops on unmount).
      return (await readUntil(read, [(s) => s !== 'invited'], { attempts: 8, signal })) ?? 'accepted'
    },
    [ready, repo.repoId, identity ?? '', network],
    { enabled: applies && ready && sdk !== null },
  )
  if (invited && identity === null && !resuming) {
    return (
      <div role="note" data-testid="invite-banner-signed-out" className="mb-3 flex items-start gap-2 rounded-md border border-forge-500/40 bg-forge-500/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200">
        <UserPlus className="mt-0.5 h-4 w-4 shrink-0 text-forge-700 dark:text-forge-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <p>
            <Author identityId={repo.ownerId} link={false} /> invited you to collaborate on this repo. {locked ? 'Unlock' : 'Sign in'} to accept
            the invitation.
          </p>
          <Button
            size="sm"
            variant="primary"
            className="mt-2"
            data-testid="invite-sign-in"
            onClick={() => openLogin(undefined, undefined, { action: 'accept this invitation', credits: previewCreate('consent').credits })}
          >
            {locked ? 'Unlock to accept' : 'Sign in to accept'}
          </Button>
        </div>
      </div>
    )
  }
  if (!applies) return null
  // Once accepted here, only a read that finds them a member changes what the banner says.
  const shown: Standing | null = accepted && standing.data !== 'member' ? 'accepted' : standing.data
  // A read that failed says so (with a retry) rather than hiding the invitation.
  if (standing.error && !accepted) {
    return (
      <p role="alert" data-testid="invite-error" className="mb-3 text-[12px] text-danger-700 dark:text-danger-400">
        Couldn&apos;t check this invitation: {standing.error}{' '}
        <button type="button" className="underline" onClick={standing.reload}>
          Try again
        </button>
      </p>
    )
  }
  if (shown === null || shown === 'member') return null
  const cost = previewCreate('consent')
  return (
    <div role="note" data-testid="invite-banner" className="mb-3 flex items-start gap-2 rounded-md border border-forge-500/40 bg-forge-500/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200">
      <UserPlus className="mt-0.5 h-4 w-4 shrink-0 text-forge-700 dark:text-forge-400" aria-hidden />
      <div className="min-w-0 flex-1">
        {shown === 'accepted' ? (
          <p data-testid="invite-accepted">
            You accepted the invitation to collaborate on this repo. <Author identityId={repo.ownerId} link={false} /> can now add you as a maintainer or writer.
          </p>
        ) : (
          <>
            <p>
              <Author identityId={repo.ownerId} link={false} /> invited you to collaborate on this repo. Accepting lets them add you as a maintainer or
              writer; nobody can be made a member without it.
            </p>
            <Button
              size="sm"
              variant="primary"
              className="mt-2"
              data-testid="invite-accept"
              disabled={signer === null || guard.disabledReason !== null}
              onClick={() => {
                if (guard.check(cost, 'core', 'accept this invitation')) setConfirming(true)
              }}
            >
              Accept invitation
            </Button>
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Accept the invitation"
        description="Records your consent to join this repo. The owner then adds you; your consent stays until you delete it, so they can add you again later."
        cost={cost}
        confirmLabel="Sign & accept"
        onConfirm={async (intent) => {
          if (!sdk || !signer) throw new Error('sign in to continue')
          const result = await acceptInvite(sdk, signer, repo, intent)
          if (result.confirmed) setAcceptedBy(signer.identityId)
          standing.reload()
        }}
      />
    </div>
  )
}

/**
 * The owner's side of an invitation (Settings → Collaborators, public and private repos alike):
 * the repo's invite link, the identity an add was just refused for (they have not accepted), and
 * the pending invitations, i.e. the consents of identities that are not members yet, each with
 * an add action (`onPick`: the add flow of the page, which a private repo runs with its key).
 */
export function Invitations({
  repo,
  members,
  awaiting,
  disabled,
  onPick,
}: {
  repo: RepoRef
  /**
   * The current members' identity ids (their consents are not pending), or null until they are
   * read: until then no consent is listed as pending (a member's would be).
   */
  members: readonly string[] | null
  /** The identity an add was refused for because they had not accepted, or null. */
  awaiting: string | null
  disabled: boolean
  onPick: (identity: string, role: Role) => void
}): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  // Every consent this page has read, per network and repo: a re-read that reaches a node without
  // a fresh accept keeps it listed, and a re-read that fails keeps the list rather than blanking
  // it. Merged after each read lands, so reads that overlap never drop one another's. (A consent
  // withdrawn meanwhile stays listed until a reload; adding them then says they have not
  // accepted, and nothing is signed.)
  const seen = useRef(new Map<string, readonly string[]>())
  const key = `${network}:${repo.repoId}`
  const consents = useAsync<readonly string[]>(
    async () => {
      let ids: string[]
      try {
        ids = await readConsents(sdk!, repo)
      } catch (e) {
        const known = seen.current.get(key)
        if (known !== undefined) return known
        throw e
      }
      const known = seen.current.get(key) ?? []
      const merged = [...known, ...ids.filter((id) => !known.includes(id))]
      seen.current.set(key, merged)
      return merged
    },
    [ready, repo.repoId, network],
    { enabled: ready && sdk !== null, initial: () => seen.current.get(key) },
  )
  // The invitee accepts in their own browser, and the node a read reaches may not have indexed it
  // yet: re-read while this page is open and visible, so a fresh accept shows without a reload.
  // Every INVITES_POLL_MS, doubling up to INVITES_POLL_MAX_MS while nothing new turns up; a new
  // consent, or the page becoming visible again (which reads at once), starts over.
  const { reload } = consents
  const polling = ready && sdk !== null
  const known = consents.data?.length ?? 0
  useEffect(() => {
    if (!polling) return
    let delay = INVITES_POLL_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      timer = setTimeout(() => {
        if (document.visibilityState === 'visible') reload()
        delay = Math.min(delay * 2, INVITES_POLL_MAX_MS)
        schedule()
      }, delay)
    }
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return
      clearTimeout(timer)
      delay = INVITES_POLL_MS
      reload()
      schedule()
    }
    schedule()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [polling, reload, known])
  const pending = members === null ? [] : (consents.data ?? []).filter((id) => id !== repo.ownerId && !members.includes(id))
  const link = typeof window === 'undefined' ? '' : new URL(repoHref('/repo', { owner: repo.ownerId, name: repo.name }, { [INVITE_PARAM]: '1' }), window.location.origin).toString()
  return (
    <>
      {awaiting !== null ? (
        <p role="status" data-testid="invite-pending" className="mt-2 text-[12px] text-anvil-700 dark:text-anvil-200">
          <Author identityId={awaiting} link={false} /> hasn&apos;t accepted yet, so nothing was signed. Send them the invite link below; once they
          accept, they show under Pending invitations and you can add them.
        </p>
      ) : null}
      {link !== '' ? (
        <div className="mt-3 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="invite-link">
          <p className="mb-1">Invite link: the member opens it and accepts before you add them.</p>
          <CopyRow text={link} label="Copy the invite link" />
        </div>
      ) : null}
      {pending.length > 0 ? (
        <div className="mt-3" data-testid="pending-invites">
          <h5 className="mb-1 text-[12px] font-medium text-anvil-600 dark:text-anvil-300">Pending invitations (accepted, not added yet)</h5>
          {pending.map((id) => (
            <div key={id} className="flex items-center gap-2 py-1">
              <Author identityId={id} link={false} />
              {(['writer', 'maintainer'] as Role[]).map((r) => (
                <Button key={r} size="sm" variant="outline" className={r === 'writer' ? 'ml-auto' : ''} disabled={disabled} onClick={() => onPick(id, r)}>
                  Add as {r}
                </Button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {consents.error ? <p className="mt-1 text-[12px] text-danger-700 dark:text-danger-400">Couldn&apos;t read the invitations: {consents.error}</p> : null}
    </>
  )
}
