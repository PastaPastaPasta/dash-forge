'use client'

/**
 * InviteBanner — the invitee's side of adding a collaborator (RC1 R-06, `member_consent`).
 *
 * Consensus makes nobody a maintainer or writer without their own `consent` document for the
 * repo, so an invitation is two steps: the owner shares the repo's invite link (`&invite=1`,
 * Settings → Collaborators), the invitee accepts here (their `consent`), then the owner adds them.
 * The banner shows only on an invite link, to a signed-in viewer who is neither the owner nor a
 * member yet. Nothing on chain names an invitation: a consent is the invitee's standing "yes" to
 * this repo, and lets the owner add them again later.
 */

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { UserPlus } from 'lucide-react'
import { acceptInvite, findConsent, readMembershipsCached, repoContractIds, type RepoRef } from '@/lib/repo'
import { previewCreate } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'

/** The query parameter an invite link carries. */
export const INVITE_PARAM = 'invite'

type Standing = 'member' | 'accepted' | 'invited'

export function InviteBanner({ repo }: { repo: RepoRef }): JSX.Element | null {
  const params = useSearchParams()
  const invited = params.get(INVITE_PARAM) !== null
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()
  const [confirming, setConfirming] = useState(false)
  const applies = invited && identity !== null && identity !== repo.ownerId
  const standing = useAsync<Standing>(
    async () => {
      const members = await readMembershipsCached(sdk!, repo, network)
      if (members.some((m) => m.identity === identity)) return 'member'
      return (await findConsent(sdk!, repo, identity!)) !== null ? 'accepted' : 'invited'
    },
    [ready, repo.repoId, identity ?? '', network],
    { enabled: applies && ready && sdk !== null },
  )
  if (!applies) return null
  // A read that failed says so (with a retry) rather than hiding the invitation.
  if (standing.error) {
    return (
      <p role="alert" data-testid="invite-error" className="mb-3 text-[12px] text-danger-700 dark:text-danger-400">
        Couldn&apos;t check this invitation: {standing.error}{' '}
        <button type="button" className="underline" onClick={standing.reload}>
          Try again
        </button>
      </p>
    )
  }
  if (standing.data === null || standing.data === 'member') return null
  const cost = previewCreate('consent')
  return (
    <div role="note" data-testid="invite-banner" className="mb-3 flex items-start gap-2 rounded-md border border-forge-500/40 bg-forge-500/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200">
      <UserPlus className="mt-0.5 h-4 w-4 shrink-0 text-forge-700 dark:text-forge-400" aria-hidden />
      <div className="min-w-0 flex-1">
        {standing.data === 'accepted' ? (
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
          await acceptInvite(sdk, signer, repo, intent)
          standing.reload()
        }}
      />
    </div>
  )
}
