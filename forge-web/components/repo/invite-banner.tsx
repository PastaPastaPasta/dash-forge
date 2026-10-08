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
import { useSearchParams } from '@/hooks/use-route'
import { UserPlus } from 'lucide-react'
import { CONSENT_LAG_RETRIES, acceptInvite, findConsent, readConsents, readMembershipsCached, repoContractIds, type RepoRef } from '@/lib/repo'
import type { Role } from '@/lib/rules/v2'
import { ROLE_LABEL, ROLE_SUMMARY, grantableRoles } from '@/lib/rules/roles'
import { repoHref } from '@/hooks/use-query-param'
import { CopyRow } from '@/components/ui/copy-row'
import { previewCreate } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { readUntil, retryWhileMissing } from '@/lib/view/retry'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { shortId } from '@/lib/utils'

/** The query parameter an invite link carries: the role the owner means to add them as (`1`: unstated). */
export const INVITE_PARAM = 'invite'

/**
 * The role an invite link names (`&invite=triage`) when the owner could grant it on a repo of
 * `visibility` (every role, on every repo), else null (`&invite=1`, anything else). Only a
 * hint: the owner picks the role when they add the member.
 */
export function invitedRole(param: string | null, visibility: 'public' | 'private'): Role | null {
  const role = grantableRoles(visibility).find((r) => r === param)
  return role ?? null
}

/**
 * " (the invite suggests Triage access)": how the banner names the role a link suggests (empty
 * when it names none). A suggestion only: the owner picks the role when adding the member.
 */
export function suggestedRoleWords(role: Role | null): string {
  return role === null ? '' : ` (the invite suggests ${ROLE_LABEL[role]} access)`
}

/** How soon the owner's Settings re-reads the pending invitations while the page is visible. */
export const INVITES_POLL_MS = 10_000
/** The longest wait between those re-reads once nothing new has turned up for a while. */
export const INVITES_POLL_MAX_MS = 60_000

type Standing = 'member' | 'accepted' | 'invited'

export function InviteBanner({ repo }: { repo: RepoRef }): JSX.Element | null {
  const params = useSearchParams()
  const invited = params.get(INVITE_PARAM) !== null
  // The role the owner picked for the link: what the banner says they will be added as.
  const offered = invitedRole(params.get(INVITE_PARAM), repo.visibility)
  const suggested = suggestedRoleWords(offered)
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity, signer, locked, resuming, vaultsLoaded, vaultsError, lockedIdentity } = useAuth()
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
  // Once it is known whether this browser holds a key (Sign in vs Unlock), and never to the
  // owner's own locked session.
  if (invited && identity === null && !resuming && (vaultsLoaded || vaultsError !== null) && lockedIdentity !== repo.ownerId) {
    return (
      <div role="note" data-testid="invite-banner-signed-out" className="mb-3 flex items-start gap-2 rounded-md border border-forge-500/40 bg-forge-500/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200">
        <UserPlus className="mt-0.5 h-4 w-4 shrink-0 text-forge-700 dark:text-forge-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <p>
            <Author identityId={repo.ownerId} link={false} /> invited you to collaborate on this repo{suggested}. {locked ? 'Unlock' : 'Sign in'} to accept
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
            You accepted the invitation to collaborate on this repo. <Author identityId={repo.ownerId} link={false} /> can now add you as a member;
            they choose the role{suggested}.
          </p>
        ) : (
          <>
            <p>
              <Author identityId={repo.ownerId} link={false} /> invited you to collaborate on this repo{suggested}. Accepting lets them add you as a member
              (they choose the role: maintainer, writer, triage{repo.visibility === 'private' ? ' or reader' : ''}); nobody can be made a member without it.
            </p>
            {offered !== null ? <RoleWhat role={offered} /> : null}
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
  role,
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
  /**
   * The role picked on the page: the invite link suggests it. A pending invitation is added with
   * the role its own row picks (QW4-034): the link's role is not on chain, so it can't be known.
   */
  role: Role
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
  const link = typeof window === 'undefined' ? '' : new URL(repoHref('/repo', { owner: repo.ownerId, name: repo.name }, { [INVITE_PARAM]: role }), window.location.origin).toString()
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
          <p className="mb-1">Invite link: the member opens it and accepts before you add them. It suggests the access picked above ({ROLE_LABEL[role]}); you choose the role when you add them.</p>
          <CopyRow text={link} label="Copy the invite link" />
        </div>
      ) : null}
      {pending.length > 0 ? (
        <div className="mt-3" data-testid="pending-invites">
          <h5 className="mb-1 text-[12px] font-medium text-anvil-600 dark:text-anvil-300">Pending invitations (accepted, not added yet)</h5>
          <ul aria-label="Pending invitations">
            {pending.map((id) => (
              <PendingInvite key={id} id={id} visibility={repo.visibility} disabled={disabled} onPick={onPick} />
            ))}
          </ul>
        </div>
      ) : null}
      {consents.error ? <p className="mt-1 text-[12px] text-danger-700 dark:text-danger-400">Couldn&apos;t read the invitations: {consents.error}</p> : null}
    </>
  )
}

/**
 * One pending invitation: who accepted, a role picker of its own and Add (QW4-034). An accept
 * records consent only, never the role the invite link suggested, so no role is preselected: a
 * click can't grant a broader role than the owner meant.
 */
function PendingInvite({
  id,
  visibility,
  disabled,
  onPick,
}: {
  id: string
  visibility: 'public' | 'private'
  disabled: boolean
  onPick: (identity: string, role: Role) => void
}): JSX.Element {
  const [role, setRole] = useState<Role | null>(null)
  const selectId = `pending-role-${id}`
  return (
    <li className="flex flex-wrap items-center gap-2 py-1" data-testid="pending-invite" data-identity={id}>
      <Author identityId={id} link={false} />
      <div className="ml-auto flex items-center gap-2">
        <label htmlFor={selectId} className="sr-only">
          Role for {shortId(id)}
        </label>
        <select
          id={selectId}
          data-testid="pending-role"
          className="rounded-md border border-anvil-300 bg-white px-2 py-1 text-dense coarse:h-11 coarse:text-base dark:border-anvil-700 dark:bg-anvil-950"
          value={role ?? ''}
          disabled={disabled}
          onChange={(e) => setRole(grantableRoles(visibility).find((r) => r === e.target.value) ?? null)}
        >
          <option value="" disabled>
            Choose a role
          </option>
          {grantableRoles(visibility).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" disabled={disabled || role === null} onClick={() => role !== null && onPick(id, role)}>
          {role === null ? 'Add' : `Add with ${ROLE_LABEL[role]} access`}
        </Button>
      </div>
    </li>
  )
}

/**
 * Whether `identity` has accepted an invitation to `repo` (their `consent`), read as soon as the
 * owner has typed a whole identity id (QW4-036: Add used to price and confirm the write before it
 * found out, then signed nothing). A "none" is re-read as the add itself does
 * (`CONSENT_LAG_RETRIES`: a node behind a fresh accept), and while a read runs, a re-read
 * included, nothing is known (null). True for the owner, who needs no consent.
 */
export function useInviteAccepted(repo: RepoRef, identity: string | null): { readonly accepted: boolean | null; readonly checking: boolean; readonly error: string | null; readonly recheck: () => void } {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const own = identity === repo.ownerId
  const state = useAsync<boolean>(
    async (signal) => (await retryWhileMissing(() => findConsent(sdk!, repo, identity!), CONSENT_LAG_RETRIES, undefined, signal)) !== null,
    [ready, repo.repoId, identity ?? '', network],
    { enabled: ready && sdk !== null && identity !== null && !own },
  )
  if (identity === null) return { accepted: null, checking: false, error: null, recheck: state.reload }
  if (own) return { accepted: true, checking: false, error: null, recheck: state.reload }
  const checking = !state.settled || state.loading
  return { accepted: !checking && state.error === null ? state.data : null, checking, error: checking ? null : state.error, recheck: state.reload }
}

/**
 * Whether Add may open its confirm for a typed identity: not while the acceptance is being read,
 * nor once it is known to be missing. A read that failed leaves it to the add, which checks the
 * acceptance itself before signing.
 */
export function mayAdd(check: { readonly accepted: boolean | null; readonly error: string | null }): boolean {
  return check.accepted === true || (check.accepted === null && check.error !== null)
}

/** What the add form knows of the typed identity's acceptance: checking, not accepted (with Check again), or a failed read. */
export function ConsentCheck({ identity, check }: { identity: string | null; check: ReturnType<typeof useInviteAccepted> }): JSX.Element | null {
  if (identity === null) return null
  if (check.error !== null) {
    return (
      <p role="alert" className="mt-1 text-[12px] text-danger-700 dark:text-danger-400" data-testid="consent-check-error">
        Couldn&apos;t check whether they accepted: {check.error}{' '}
        <button type="button" className="underline" onClick={check.recheck}>
          Try again
        </button>
      </p>
    )
  }
  if (check.accepted === null) {
    return (
      <p role="status" className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="consent-checking">
        Checking whether they accepted your invitation…
      </p>
    )
  }
  if (check.accepted) return null
  return (
    <p role="status" className="mt-1 text-[12px] text-caution-700 dark:text-caution-400" data-testid="consent-missing">
      <Author identityId={identity} link={false} /> hasn&apos;t accepted your invitation yet, so they can&apos;t be added. Send them the invite link
      below; once they accept, they show under Pending invitations.{' '}
      <button type="button" className="underline" disabled={check.checking} onClick={check.recheck}>
        Check again
      </button>
    </p>
  )
}

/** What the suggested role may do, under the invitation. */
function RoleWhat({ role }: { role: Role }): JSX.Element {
  return (
    <p className="mt-1 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="invite-role">
      Suggested role, {ROLE_LABEL[role]}: {ROLE_SUMMARY[role]}
    </p>
  )
}
