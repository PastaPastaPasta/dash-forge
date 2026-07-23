'use client'

/**
 * SettingsContent — repo administration: the storage backend, the collaborator ACL (which IS
 * the token balances), and the danger zone. Grant mints a WRITE/MAINTAIN token; suspend freezes;
 * revoke freezes + destroys — all CRITICAL-key token ops, each with a pre-sign cost + confirm.
 * Consensus is the real gate; the UI shows the controls and surfaces the on-chain result.
 */

import { useState } from 'react'
import { AlertTriangle, ShieldPlus, Snowflake, Trash2, UserCog } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import type { Collaborator } from '@/lib/repo'
import { readCollaborators, grantCollaborator, revokeCollaborator, suspendCollaborator } from '@/lib/repo'
import { previewCredits, COST_ESTIMATE_CREDITS } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { Author } from '@/components/author'
import { BackendBadge } from '@/components/ui/backend-badge'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ErrorState, LoadingBlock } from '@/components/ui/states'

type Role = 'write' | 'maintain'
type Action = { kind: 'grant' | 'suspend' | 'revoke'; member: string; role: Role }

export function SettingsContent({ home }: { home: RepoHome }): JSX.Element {
  const { sdk, ready } = useSdk([home.repo.contractId])
  const { identity, signer } = useAuth()
  const isOwner = identity === home.repo.ownerId

  const collabs = useAsync<Collaborator[]>(
    () => readCollaborators(sdk!, home.repo),
    [ready, home.repo.contractId],
    { enabled: ready && sdk !== null },
  )

  const [grantId, setGrantId] = useState('')
  const [grantRole, setGrantRole] = useState<Role>('write')
  const [action, setAction] = useState<Action | null>(null)

  const runAction = async (): Promise<void> => {
    if (!sdk || !signer || !action) return
    const maintain = action.role === 'maintain'
    if (action.kind === 'grant') await grantCollaborator(sdk, signer, home.repo, action.member, maintain)
    else if (action.kind === 'suspend') await suspendCollaborator(sdk, signer, home.repo, action.member, maintain)
    else await revokeCollaborator(sdk, signer, home.repo, action.member, maintain)
    collabs.reload()
  }

  const cost = previewCredits(COST_ESTIMATE_CREDITS.tokenAdmin)

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      {/* Backend */}
      <Section title="Storage backend" icon={<UserCog className="h-4 w-4 text-anvil-400" aria-hidden />}>
        <div className="flex items-center gap-3">
          <BackendBadge backend={home.backend} />
          {home.backend.uris.length > 0 ? (
            <ul className="min-w-0 flex-1 space-y-0.5">
              {home.backend.uris.map((u) => (
                <li key={u} className="truncate font-mono text-[12px] text-anvil-500 dark:text-anvil-400">{u}</li>
              ))}
            </ul>
          ) : (
            <span className="text-dense text-anvil-500 dark:text-anvil-400">Readers follow manifest URIs; no explicit backend URIs set.</span>
          )}
        </div>
        <p className="mt-2 text-[12px] text-anvil-400">Changing the backend mode is an owner-signed config write (helper / CLI).</p>
      </Section>

      {/* Collaborators */}
      <Section title="Collaborators" icon={<ShieldPlus className="h-4 w-4 text-anvil-400" aria-hidden />}>
        {collabs.loading ? (
          <LoadingBlock label="Reading token balances" />
        ) : collabs.error ? (
          <ErrorState message={collabs.error} onRetry={collabs.reload} />
        ) : (
          <>
            <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
              {(collabs.data ?? []).length === 0 ? (
                <div className="px-4 py-6 text-center text-dense text-anvil-500 dark:text-anvil-400">
                  Only the owner holds tokens so far.
                </div>
              ) : (
                (collabs.data ?? []).map((c) => (
                  <div key={c.identity} className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850">
                    <Author identityId={c.identity} link={false} />
                    <div className="flex items-center gap-1.5">
                      {c.maintain ? <RoleTag role="MAINTAIN" /> : null}
                      {c.write ? <RoleTag role="WRITE" /> : null}
                      {c.frozen ? (
                        <span className="inline-flex items-center gap-1 rounded bg-caution/10 px-1.5 py-0.5 text-[11px] text-caution">
                          <Snowflake className="h-3 w-3" aria-hidden /> frozen
                        </span>
                      ) : null}
                    </div>
                    {isOwner && c.identity !== home.repo.ownerId ? (
                      <div className="ml-auto flex items-center gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => setAction({ kind: 'suspend', member: c.identity, role: c.maintain ? 'maintain' : 'write' })}>
                          Suspend
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => setAction({ kind: 'revoke', member: c.identity, role: c.maintain ? 'maintain' : 'write' })}>
                          Revoke
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            {isOwner ? (
              <div className="mt-4 rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
                <h4 className="mb-2 text-dense font-medium">Grant access</h4>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <Field label="Identity ID" htmlFor="grant-id">
                      <Input id="grant-id" value={grantId} onChange={(e) => setGrantId(e.target.value)} placeholder="base58 identity id" className="font-mono" spellCheck={false} />
                    </Field>
                  </div>
                  <div className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
                    {(['write', 'maintain'] as Role[]).map((r) => (
                      <button
                        key={r}
                        onClick={() => setGrantRole(r)}
                        className={
                          'rounded px-3 py-1.5 text-dense font-medium uppercase ' +
                          (grantRole === r ? 'bg-forge-500/15 text-forge-600 dark:text-forge-400' : 'text-anvil-500')
                        }
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  <Button
                    variant="primary"
                    disabled={grantId.trim() === ''}
                    onClick={() => setAction({ kind: 'grant', member: grantId.trim(), role: grantRole })}
                  >
                    Grant
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-[12px] text-anvil-400">Only the repo owner can mint or freeze collaborator tokens.</p>
            )}
          </>
        )}
      </Section>

      {/* Danger zone */}
      <Section title="Danger zone" icon={<AlertTriangle className="h-4 w-4 text-danger" aria-hidden />} danger>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-dense font-medium">Archive repository</div>
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
              Read-only banner + disabled write UIs. The contract is permanent and cannot be deleted — only its pack bytes are refundable.
            </p>
          </div>
          <Button variant="danger" disabled={!isOwner} title={isOwner ? undefined : 'Owner only'}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Archive
          </Button>
        </div>
      </Section>

      <ConfirmDialog
        open={action !== null}
        onClose={() => setAction(null)}
        title={
          action?.kind === 'grant'
            ? `Grant ${action.role.toUpperCase()}`
            : action?.kind === 'suspend'
              ? 'Suspend collaborator'
              : 'Revoke collaborator'
        }
        description={
          action?.kind === 'grant'
            ? 'Mints one role token to this identity (CRITICAL key).'
            : action?.kind === 'suspend'
              ? 'Freezes the role token — the collaborator cannot spend it until unfrozen. Their existing docs stay valid.'
              : 'Freezes then destroys the role token. Irreversible for this grant.'
        }
        cost={cost}
        confirmLabel={action?.kind === 'grant' ? 'Sign & grant' : action?.kind === 'suspend' ? 'Sign & suspend' : 'Sign & revoke'}
        onConfirm={runAction}
      />
    </div>
  )
}

function Section({
  title,
  icon,
  danger,
  children,
}: {
  title: string
  icon: React.ReactNode
  danger?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <section>
      <h2 className={`mb-3 flex items-center gap-2 text-prose ${danger ? 'text-danger' : ''}`}>
        {icon}
        {title}
      </h2>
      <div className={danger ? 'rounded-lg border border-danger/30 bg-danger/5 p-4' : ''}>{children}</div>
    </section>
  )
}

function RoleTag({ role }: { role: 'WRITE' | 'MAINTAIN' }): JSX.Element {
  return (
    <span className="rounded bg-forge-500/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-forge-600 dark:text-forge-400">
      {role}
    </span>
  )
}
