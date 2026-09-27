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

import { useMemo, useState } from 'react'
import { KeyRound } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { timeAgo } from '@/lib/view'
import { decodeIdentifier } from '@/lib/auth'
import { noEncryptionKeyMessage } from '@/lib/auth/encryption-key'
import type { Role } from '@/lib/rules/v2'
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
function removalText(effect: RemovalEffect, name: string, role: Role): string {
  if (effect === 'none') return `Removes ${name}'s ${role} role. They stay a maintainer, so the repo key does not change.`
  if (effect === 'rotate-keep') {
    return `Removes ${name}'s ${role} role; they stay a writer. The repo key rotates, because keys they handed out as a maintainer stop counting, and ${name} gets the new key too.`
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
    case 'reanchored':
      return `Key epoch ${s.epoch} re-anchored under your name.`
  }
}

export function PrivateMembers({ home, session }: { home: RepoHome; session: PrivateSession }): JSX.Element {
  const { sdk, ready } = useSdk([home.repo.forge.core, home.repo.forge.collab])
  const { identity } = useAuth()
  const guard = useWriteGuard()
  const write = usePrivateWrite(home.repo)
  const repo = home.repo
  const isOwner = identity === repo.ownerId
  const current = session.resolution.currentEpoch
  const anchor = current === null ? undefined : session.anchors.get(current)

  const [memberId, setMemberId] = useState('')
  const [role, setRole] = useState<Role>('writer')
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

  const removalPlan = useMemo((): { plan: RotationPlan | null; error: string | null } => {
    if (removing === null || identity === null || write.context === null) return { plan: null, error: null }
    // Removing one role of someone who keeps the other rotates nothing (they stay a member).
    const effect = removalEffect(session.members, removing.member, removing.role)
    if (effect === 'none') return { plan: null, error: null }
    try {
      const exclude = effect === 'rotate-exclude' ? [removing.member] : []
      return { plan: planRotation(session, identity, exclude, repo.forge.core, write.context.ops.keyId), error: null }
    } catch (e) {
      return { plan: null, error: e instanceof Error ? e.message : String(e) }
    }
  }, [removing, identity, session, repo.forge.core, write.context])

  const locked = write.context === null
  const cannotRead = session.resolution.writeEpoch === null

  return (
    <div className="space-y-3" data-testid="private-members">
      <p className="flex items-center gap-1.5 text-dense text-anvil-600 dark:text-anvil-300" data-testid="key-epoch">
        <KeyRound className="h-3.5 w-3.5 text-anvil-400" aria-hidden />
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
            <span className="rounded bg-forge-500/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-forge-600 dark:text-forge-400">
              {m.role}
            </span>
            {m.identity === repo.ownerId ? (
              <span className="text-[12px] text-anvil-400">owner</span>
            ) : isOwner ? (
              <Button
                size="sm"
                variant="danger"
                className="ml-auto"
                disabled={guard.disabledReason !== null || locked || cannotRead}
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
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="Identity ID" htmlFor="member-id">
                <Input id="member-id" value={memberId} onChange={(e) => setMemberId(e.target.value)} placeholder="base58 identity id" className="font-mono" spellCheck={false} />
              </Field>
            </div>
            <div role="radiogroup" aria-label="Role" className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
              {(['writer', 'maintainer'] as Role[]).map((r) => (
                <button
                  key={r}
                  role="radio"
                  aria-checked={role === r}
                  onClick={() => setRole(r)}
                  className={'rounded px-3 py-1.5 text-dense font-medium ' + (role === r ? 'bg-forge-500/15 text-forge-600 dark:text-forge-400' : 'text-anvil-500')}
                >
                  {r}
                </button>
              ))}
            </div>
            <Button
              variant="primary"
              disabled={trimmed === '' || idError !== null || keyCheck.data !== true || guard.disabledReason !== null || locked || cannotRead}
              onClick={() => {
                if (guard.check(addMemberCost(role).credits)) setAdding(true)
              }}
            >
              Add
            </Button>
          </div>
          {idError ? <p className="mt-1 text-[12px] text-danger">{idError}</p> : null}
          {noKey ? (
            <p className="mt-2 text-[12px] text-caution" data-testid="member-no-key">
              {noEncryptionKeyMessage(shortId(trimmed))}
            </p>
          ) : null}
          {keyCheck.error ? <p className="mt-1 text-[12px] text-danger">Couldn&apos;t read that identity: {keyCheck.error}</p> : null}
          {locked ? (
            <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">Unlock with your encryption key (Settings → Keys) to add or remove members.</p>
          ) : null}
        </div>
      ) : (
        <p className="text-[12px] text-anvil-400">Only the owner can add or remove members.</p>
      )}

      <ConfirmDialog
        open={adding}
        onClose={() => setAdding(false)}
        title={`Add ${role}`}
        description={`Creates a ${role} document for ${shortId(trimmed)} and hands them the current key (epoch ${current ?? 0}): two transitions.`}
        cost={addMemberCost(role)}
        confirmLabel="Sign & add"
        onConfirm={async (intent) => {
          if (write.context === null) throw new Error('unlock with your encryption key first')
          try {
            await addPrivateMember(write.context, trimmed, role, intent)
            setMemberId('')
          } finally {
            write.done()
          }
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.role ?? 'member'}`}
        description={removing === null ? '' : removalText(removalEffect(session.members, removing.member, removing.role), shortId(removing.member), removing.role)}
        cost={
          removing === null
            ? null
            : removalPlan.plan === null && removing.role === 'writer'
              ? previewDelete(removing.role)
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
      {removing !== null && removalPlan.error !== null ? <p className="text-[12px] text-danger">{removalPlan.error}</p> : null}
      {removing !== null && removalPlan.plan !== null && write.context !== null && removalPlan.plan.recipients[0]?.keyId !== write.context.ops.keyId ? (
        <p className="text-[12px] text-caution">
          Your identity has a newer encryption key (key {removalPlan.plan.recipients[0]?.keyId}) than the one in this browser, and the new repo
          key goes to it: add that key here (Settings → Keys) to keep reading this repo after the rotation.
        </p>
      ) : null}
      {removing !== null && removalPlan.plan !== null && removalPlan.plan.unreachable.length > 0 ? (
        <p className="text-[12px] text-caution">
          {removalPlan.plan.unreachable.length} remaining {removalPlan.plan.unreachable.length === 1 ? 'member has' : 'members have'} no
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
