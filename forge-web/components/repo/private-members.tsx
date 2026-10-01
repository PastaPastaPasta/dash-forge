'use client'

/**
 * PrivateMembers — Settings → Members for a private repo (`ux-dx-spec.md` §9,
 * `docs/security/private-repos.md` §5.5, §9):
 *
 * - the list with roles, and "key epoch 3 · rotated 2 d ago by alice" from the current anchor;
 * - Add member: the identity's usable ENCRYPTION key is checked first (none: Add stays disabled
 *   with the spec's message); then the membership document and a wrap of the current epoch, the
 *   cost of both shown before signing;
 * - Remove member: the spec's warning, then delete → rotate (wraps for every remaining member,
 *   self first, then the new anchor), its cost (remaining members + 1) shown before confirming.
 *
 * Only the owner creates or deletes membership documents (consensus enforces it); a rotation
 * needs the current key in this browser.
 */

import { useEffect, useMemo, useState } from 'react'
import { KeyRound } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { plural, timeAgo } from '@/lib/view'
import { ConsentMissingError, repoContractIds } from '@/lib/repo'
import { Invitations } from '@/components/repo/invite-banner'
import { decodeIdentifier } from '@/lib/auth'
import { noEncryptionKeyMessage } from '@/lib/auth/encryption-key'
import type { Role } from '@/lib/rules/v2'
import { memberDocOf } from '@/lib/repo'
import { RoleBadge, RolePicker, RoleSummary } from '@/components/repo/role-picker'
import {
  addMemberCost,
  addPrivateMember,
  hasUsableEncryptionKey,
  planRotation,
  removalEffect,
  type RemovalEffect,
  removalCost,
  removePrivateMember,
  type RotationPlan,
  type RotationStep,
  chainFrom,
  vanishing,
} from '@/lib/repo/private-members'
import type { PrivateSession } from '@/lib/repo/private-session'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { usePrivateWrite } from '@/hooks/use-private-write'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { previewDelete } from '@/lib/sdk'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'

/** The spec's removal warning, verbatim, with the member's name. */
/** What the remove dialog says, for what the removal will do. */
function removalText(effect: RemovalEffect, name: string, role: Role, kept: Role | null): string {
  if (effect === 'none') return `Removes ${name}'s ${role} role. They stay a maintainer, so the repo key does not change.`
  if (effect === 'rotate-keep') {
    return `Removes ${name}'s ${role} role; they stay a ${kept ?? 'member'}. The repo key rotates, because keys they handed out as a maintainer stop counting, and ${name} gets the new key too.`
  }
  return removeWarning(name)
}

function removeWarning(name: string): string {
  return `Removing ${name} rotates the repo key. New pushes, issues and comments will be unreadable to ${name}. Everything ${name} could already read stays readable to ${name} — encryption can't take back what was shared.`
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

function stepText(s: RotationStep): string {
  switch (s.kind) {
    case 'deleted':
      return 'Membership deleted.'
    case 'waiting':
      return `Waiting for ${s.what}…`
    case 'wrapped':
      return `Key for epoch ${s.epoch} handed to ${shortId(s.identity)}.`
    case 'anchored':
      return `Key epoch ${s.epoch} is in effect.`
    case 'burned':
      return `Key epoch ${s.epoch} had already reached a removed member: closed as chain-only.`
    case 'lost':
      return `Another maintainer set key epoch ${s.epoch} first; their key is in effect.`
    case 'reanchored':
      return `Key epoch ${s.epoch} re-anchored under your name.`
  }
}

export function PrivateMembers({ home, session }: { home: RepoHome; session: PrivateSession }): JSX.Element {
  const { sdk, ready } = useSdk(repoContractIds(home.repo))
  const { identity } = useAuth()
  const guard = useWriteGuard()
  const write = usePrivateWrite(home.repo)
  const repo = home.repo
  const isOwner = identity === repo.ownerId
  const current = session.resolution.currentEpoch
  const anchor = current === null ? undefined : session.anchors.get(current)

  const [memberId, setMemberId] = useState('')
  const [role, setRole] = useState<Role>('writer')
  // The identity an add was refused for because they had not accepted the invitation (RC1 R-06).
  const [awaiting, setAwaiting] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<{ member: string; role: Role } | null>(null)
  const [steps, setSteps] = useState<string[]>([])

  const trimmed = memberId.trim()
  const idError = useMemo(() => {
    if (trimmed === '') return null
    try {
      return decodeIdentifier(trimmed).length === 32 ? null : 'Not an identity id (base58, 32 bytes).'
    } catch {
      return 'Not an identity id (base58, 32 bytes).'
    }
  }, [trimmed])
  const keyCheck = useAsync(
    () => hasUsableEncryptionKey(sdk!, repo.forge.core, trimmed),
    [ready, trimmed],
    { enabled: ready && sdk !== null && trimmed !== '' && idError === null },
  )
  const noKey = keyCheck.data === false
  // "Add as …" on an accepted invitation (QW-075): as on a public repo, it opens the confirm, once
  // the form has checked the identity's encryption key (the add hands them the repo key). If they
  // have none, the form says so and nothing opens.
  const [pickedAdd, setPickedAdd] = useState<string | null>(null)
  useEffect(() => {
    if (pickedAdd === null) return
    // The field no longer holds the picked id (edited, or another pick): the pick is dropped.
    if (pickedAdd !== trimmed) {
      setPickedAdd(null)
      return
    }
    if (!keyCheck.settled) return
    setPickedAdd(null)
    if (keyCheck.data === true && guard.check(addMemberCost(role))) setAdding(true)
  }, [pickedAdd, trimmed, keyCheck.settled, keyCheck.data, guard, role])

  const removalPlan = useMemo((): { plan: RotationPlan | null; error: string | null } => {
    if (removing === null || identity === null || write.context === null) return { plan: null, error: null }
    // Removing one role of someone who keeps the other rotates nothing (they stay a member).
    const effect = removalEffect(session.members, removing.member, removing.role)
    if (effect === 'none') return { plan: null, error: null }
    try {
      const exclude = effect === 'rotate-exclude' ? [removing.member] : []
      const from = chainFrom(session, removing.member, removing.role)
      return { plan: planRotation(session, identity, exclude, repo.forge.core, write.context.ops.keyId, from), error: null }
    } catch (e) {
      return { plan: null, error: e instanceof Error ? e.message : String(e) }
    }
  }, [removing, identity, session, repo.forge.core, write.context])

  const locked = write.context === null
  const cannotRead = session.resolution.writeEpoch === null

  return (
    <div className="space-y-3" data-testid="private-members">
      <p className="flex items-center gap-1.5 text-dense text-anvil-600 dark:text-anvil-300" data-testid="key-epoch">
        <KeyRound className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
        {current === null ? (
          'No key epoch yet.'
        ) : (
          <>
            key epoch {current}
            {anchor !== undefined && anchor.createdAt > 0 ? (
              <>
                {' '}
                · {current === 0 ? 'created' : 'rotated'} {timeAgo(anchor.createdAt)} by <Author identityId={anchor.owner} link={false} />
              </>
            ) : null}
          </>
        )}
      </p>

      <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        {session.members.map((m) => (
          <div key={`${m.role}:${m.identity}`} className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850">
            <Author identityId={m.identity} link={false} />
            <RoleBadge role={m.role} />
            {m.identity === repo.ownerId ? (
              <span className="text-[12px] text-anvil-500 dark:text-anvil-400">owner</span>
            ) : isOwner ? (
              <Button
                size="sm"
                variant="danger"
                className="ml-auto"
                disabled={guard.disabledReason !== null || locked || !canChainFrom(session, m.identity, m.role)}
                onClick={() => {
                  setSteps([])
                  setRemoving({ member: m.identity, role: m.role })
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
        ))}
      </div>

      {isOwner ? (
        <div className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h4 className="mb-2 text-dense font-medium">Add a member</h4>
          <p className="mb-2 text-[12px] text-anvil-500 dark:text-anvil-400">
            To change a member&apos;s role here, remove them and add them again with the new role: a removal rotates the key.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="Identity ID" htmlFor="member-id">
                <Input id="member-id" value={memberId} onChange={(e) => setMemberId(e.target.value)} placeholder="base58 identity id" className="font-mono" spellCheck={false} />
              </Field>
            </div>
            <RolePicker value={role} onChange={setRole} visibility="private" />
            <Button
              variant="primary"
              disabled={trimmed === '' || idError !== null || keyCheck.data !== true || guard.disabledReason !== null || locked || cannotRead}
              onClick={() => {
                if (guard.check(addMemberCost(role))) setAdding(true)
              }}
            >
              Add
            </Button>
          </div>
          <RoleSummary role={role} />
          {idError ? <p className="mt-1 text-[12px] text-danger-700 dark:text-danger-400">{idError}</p> : null}
          {noKey ? (
            <p className="mt-2 text-[12px] text-caution-700 dark:text-caution-400" data-testid="member-no-key">
              {noEncryptionKeyMessage(shortId(trimmed))}
            </p>
          ) : null}
          {keyCheck.error ? <p className="mt-1 text-[12px] text-danger-700 dark:text-danger-400">Couldn&apos;t read that identity: {keyCheck.error}</p> : null}
          {locked ? (
            <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">Unlock with your encryption key (Settings → Private repos) to add or remove members.</p>
          ) : null}
          <Invitations
            repo={repo}
            members={session.members.map((m) => m.identity)}
            awaiting={awaiting}
            disabled={locked}
            role={role}
            onPick={(id, r) => {
              // The add runs through the form: it checks their encryption key and hands them the key.
              setMemberId(id)
              setRole(r)
              setPickedAdd(id.trim())
            }}
          />
        </div>
      ) : (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Only the owner can add or remove members.</p>
      )}

      <ConfirmDialog
        open={adding}
        onClose={() => setAdding(false)}
        title={`Add ${role}`}
        description={`Creates a ${memberDocOf(role)} document${memberDocOf(role) === 'writer' ? ` with the ${role} role` : ''} for ${shortId(trimmed)} and hands them the current key (epoch ${current ?? 0}): two transitions.${role === 'reader' ? ' A reader reads the repo and its history but changes nothing as a member.' : ''}`}
        cost={addMemberCost(role)}
        confirmLabel="Sign & add"
        onConfirm={async (intent) => {
          if (write.context === null) throw new Error('unlock with your encryption key first')
          try {
            await addPrivateMember(write.context, trimmed, role, intent)
            setMemberId('')
            setAwaiting(null)
          } catch (e) {
            if (!(e instanceof ConsentMissingError)) throw e
            // Nothing was signed: the invitation is pending on them.
            setAwaiting(trimmed)
            setAdding(false)
          } finally {
            write.done()
          }
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.role ?? 'member'}`}
        description={
          removing === null
            ? ''
            : removalText(
                removalEffect(session.members, removing.member, removing.role),
                shortId(removing.member),
                removing.role,
                session.members.find((m) => m.identity === removing.member && m.role !== removing.role)?.role ?? null,
              )
        }
        cost={
          removing === null
            ? null
            : removalPlan.plan === null && memberDocOf(removing.role) === 'writer'
              ? previewDelete(memberDocOf(removing.role))
              : removalCost(session, identity ?? '', removing.member, removing.role, removalPlan.plan)
        }
        confirmLabel="Sign & remove"
        onConfirm={async (intent) => {
          if (write.context === null || removing === null) throw new Error('unlock with your encryption key first')
          if (removalPlan.error !== null) throw new Error(removalPlan.error)
          try {
            await removePrivateMember(write.context, removing.member, removing.role, intent, (s) => setSteps((prev) => [...prev, stepText(s)]))
          } finally {
            write.done()
          }
        }}
      />
      {removing?.role === 'maintainer' ? <VanishingNote session={session} leaving={removing.member} /> : null}
      {removing !== null && removalPlan.error !== null ? <p className="text-[12px] text-danger-700 dark:text-danger-400">{removalPlan.error}</p> : null}
      {removing !== null && removalPlan.plan !== null && removalPlan.plan.unreachable.length > 0 ? (
        <p className="text-[12px] text-caution-700 dark:text-caution-400">
          {plural(removalPlan.plan.unreachable.length, 'remaining member')} {removalPlan.plan.unreachable.length === 1 ? 'has' : 'have'} no
          encryption key and won&apos;t get the new key.
        </p>
      ) : null}
      {steps.length > 0 ? (
        <ol className="space-y-0.5 text-[12px] text-anvil-500 dark:text-anvil-400" aria-live="polite">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

/** The key epochs a maintainer's removal drops (§5.3), and the members who stay and lose them. */
function VanishingNote({ session, leaving }: { session: PrivateSession; leaving: string }): JSX.Element | null {
  const { epochs, losing } = vanishing(session, leaving)
  if (epochs.length === 0) return null
  return (
    <p className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="removal-vanishing">
      Key epoch {epochs.join(', ')} was set by {shortId(leaving)} and no other maintainer holds it: it goes with their role, and anything
      written under it becomes unreadable
      {losing.length > 0 ? (
        <>
          , also to{' '}
          {losing.map((id, i) => (
            <span key={id}>
              {i > 0 ? ', ' : ''}
              <Author identityId={id} link={false} />
            </span>
          ))}
        </>
      ) : null}
      .
    </p>
  )
}

/** Whether this browser can read the epoch the rotation after removing `role` from `member` chains from. */
function canChainFrom(session: PrivateSession, member: string, role: Role): boolean {
  const from = chainFrom(session, member, role)
  return from !== null && session.resolution.keys.has(from)
}
