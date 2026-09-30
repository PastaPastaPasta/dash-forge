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
import { acceptInvite, findConsent, readConsents, readMembershipsCached, repoContractIds, type RepoRef } from '@/lib/repo'
import type { Role } from '@/lib/rules/v2'
import { repoHref } from '@/hooks/use-query-param'
import { CopyRow } from '@/components/ui/copy-row'
import { previewCreate } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { retryUntil } from '@/lib/view/retry'
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
  // The identity whose accept this tab confirmed (the write's proof, or the consent it found). A
  // node that has not indexed that consent yet answers "none"; that must not turn the banner back
  // into "Accept invitation" (D-10). Keyed by identity so a switched account starts over.
  const [acceptedBy, setAcceptedBy] = useState<string | null>(null)
  const accepted = acceptedBy !== null && acceptedBy === identity
  const applies = invited && identity !== null && identity !== repo.ownerId
  const standing = useAsync<Standing>(
    async () => {
      const read = async (): Promise<Standing> => {
        const members = await readMembershipsCached(sdk!, repo, network)
        if (members.some((m) => m.identity === identity)) return 'member'
        return (await findConsent(sdk!, repo, identity!)) !== null ? 'accepted' : 'invited'
      }
      // After this tab's accept, re-read until a node shows it, as Settings does after a grant.
      return accepted ? retryUntil(read, (s) => s !== 'invited', 8) : read()
    },
    [ready, repo.repoId, identity ?? '', network],
    { enabled: applies && ready && sdk !== null },
  )
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
  /** The current members' identity ids (their consents are not pending). */
  members: readonly string[]
  /** The identity an add was refused for because they had not accepted, or null. */
  awaiting: string | null
  disabled: boolean
  onPick: (identity: string, role: Role) => void
}): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const consents = useAsync<string[]>(() => readConsents(sdk!, repo), [ready, repo.repoId, network, members.length], { enabled: ready && sdk !== null })
  const pending = (consents.data ?? []).filter((id) => id !== repo.ownerId && !members.includes(id))
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
