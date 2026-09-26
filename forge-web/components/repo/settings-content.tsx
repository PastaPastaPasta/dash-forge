'use client'

/**
 * SettingsContent — repo administration: the storage backend, the collaborator ACL (which IS
 * the token balances), and the raw Platform identifiers. Grant mints a WRITE/MAINTAIN token;
 * suspend freezes; revoke freezes + destroys — all CRITICAL-key token ops, each with a
 * pre-sign cost + confirm. Consensus is the real gate; the UI shows the controls and surfaces
 * the on-chain result.
 *
 * There is deliberately no "Archive" control: the web app has no config write, and the
 * config `archived` flag is display-only (token holders can still write), so a button here
 * could only pretend.
 */

import { useState } from 'react'
import { Fingerprint, ShieldPlus, Snowflake, UserCog } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import type { Collaborator, V1RepoRef, V2RepoRef } from '@/lib/repo'
import {
  adminCollaborator,
  grantMember,
  readCollaborators,
  readMembershipsCached,
  revokeMember,
} from '@/lib/repo'
import type { Membership, Role as V2Role } from '@/lib/rules/v2'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { NetworkBadge } from '@/components/ui/network-badge'
import { previewCreate, previewCredits, previewDelete, TOKEN_ADMIN_CREDITS } from '@/lib/sdk'
import { decodeIdentifier } from '@/lib/auth'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { Author } from '@/components/author'
import { BackendBadge } from '@/components/ui/backend-badge'
import { Oid } from '@/components/ui/oid'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ErrorState, LoadingBlock } from '@/components/ui/states'

type Role = 'write' | 'maintain'
type Action = { kind: 'grant' | 'suspend' | 'revoke'; member: string; role: Role }

export function SettingsContent({ home }: { home: RepoHome }): JSX.Element {
  if (home.repo.kind === 'v2') return <V2Settings home={home} repo={home.repo} />
  return <V1Settings home={home} repo={home.repo} />
}

function V1Settings({ home, repo }: { home: RepoHome; repo: V1RepoRef }): JSX.Element {
  const { sdk, ready } = useSdk([repo.contractId])
  const { identity, signer } = useAuth()
  const isOwner = identity === repo.ownerId

  const collabs = useAsync<Collaborator[]>(
    () => readCollaborators(sdk!, repo),
    [ready, repo.contractId],
    { enabled: ready && sdk !== null },
  )

  const [grantId, setGrantId] = useState('')
  const [grantChoice, setGrantChoice] = useState<Role>('write')
  const [action, setAction] = useState<Action | null>(null)

  const runAction = async (): Promise<void> => {
    if (!sdk || !signer || !action) throw new Error('sign in to continue')
    await adminCollaborator(sdk, signer, repo, action.kind, action.member, action.role === 'maintain')
    collabs.reload()
  }

  const cost = previewCredits(TOKEN_ADMIN_CREDITS)
  const registryContractId = ACTIVE_NETWORK.registryContractId

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      {/* Backend */}
      <Section title="Storage backend" icon={<UserCog className="h-4 w-4 text-anvil-400" aria-hidden />}>
        <StorageBackend backend={home.backend} emptyText="Readers follow manifest URIs; no explicit backend URIs set." />
        <p className="mt-2 text-[12px] text-anvil-400">
          Change it with <span className="font-mono">dg repo backend set</span> (an owner-signed config write). It records a preference: git push currently stores packs on Platform whatever it says, and <span className="font-mono">dg repack</span> / <span className="font-mono">dg reseed</span> move them.
        </p>
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
                        onClick={() => setGrantChoice(r)}
                        className={
                          'rounded px-3 py-1.5 text-dense font-medium uppercase ' +
                          (grantChoice === r ? 'bg-forge-500/15 text-forge-600 dark:text-forge-400' : 'text-anvil-500')
                        }
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  <Button
                    variant="primary"
                    disabled={grantId.trim() === ''}
                    onClick={() => setAction({ kind: 'grant', member: grantId.trim(), role: grantChoice })}
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

      {/* Platform details */}
      <Section title="Platform details" icon={<Fingerprint className="h-4 w-4 text-anvil-400" aria-hidden />}>
        <dl className="divide-y divide-anvil-100 overflow-hidden rounded-lg border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800">
          <DetailRow label="Repo contract">
            <Oid value={repo.contractId} chars={12} label="repo contract id" />
          </DetailRow>
          <DetailRow label="Owner identity">
            <Oid value={home.repo.ownerId} chars={12} label="owner identity id" />
          </DetailRow>
          <DetailRow label="Registry listing">
            {home.listingId !== null ? <Oid value={home.listingId} chars={12} label="registry listing id" /> : <NotSet />}
          </DetailRow>
          <DetailRow label="Registry contract">
            {registryContractId !== null ? <Oid value={registryContractId} chars={12} label="registry contract id" /> : <NotSet />}
          </DetailRow>
          <DetailRow label="Network">
            <NetworkBadge always />
          </DetailRow>
        </dl>
        <p className="mt-2 text-[12px] text-anvil-400">
          Raw Platform identifiers for CLI / SDK use (query the repo contract directly, or the listing on the registry). Click an id to copy the full value.
        </p>
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

/**
 * forge-v2 settings: the repo's members (its current `maintainer` / `writer` documents — the
 * ACL consensus enforces), and the ids a CLI or SDK user needs. The owner adds a member by
 * creating their document and removes one by deleting it; consensus refuses anyone else.
 */
function V2Settings({ home, repo }: { home: RepoHome; repo: V2RepoRef }): JSX.Element {
  const { sdk, ready, network } = useSdk([repo.forge.core, repo.forge.collab])
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()
  const isOwner = identity === repo.ownerId
  const members = useAsync<Membership[]>(
    () => readMembershipsCached(sdk!, repo, network),
    [ready, repo.repoId, network],
    { enabled: ready && sdk !== null },
  )
  const memberRows = members.data ?? []
  const [memberId, setMemberId] = useState('')
  const [role, setRole] = useState<V2Role>('writer')
  const [action, setAction] = useState<{ kind: 'grant' | 'revoke'; member: string; role: V2Role } | null>(null)
  const idError = (() => {
    if (memberId.trim() === '') return null
    try {
      decodeIdentifier(memberId.trim())
      return null
    } catch {
      return 'Not an identity id (base58, 32 bytes).'
    }
  })()
  const runAction = async (intent: string): Promise<void> => {
    if (!sdk || !signer || !action) throw new Error('sign in to continue')
    if (action.kind === 'grant') {
      await grantMember(sdk, signer, repo, action.member, action.role, intent)
      setMemberId('')
    } else {
      await revokeMember(sdk, signer, repo, action.member, action.role)
    }
    members.reload()
  }
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <Section title="Storage backend" icon={<UserCog className="h-4 w-4 text-anvil-400" aria-hidden />}>
        <StorageBackend backend={home.backend} emptyText="Readers follow each pack manifest's own storage." />
      </Section>

      <Section title="Members" icon={<ShieldPlus className="h-4 w-4 text-anvil-400" aria-hidden />}>
        {members.loading ? (
          <LoadingBlock label="Reading members" />
        ) : members.error ? (
          <ErrorState message={members.error} onRetry={members.reload} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
            {memberRows.length === 0 ? (
              <div className="px-4 py-6 text-center text-dense text-anvil-500 dark:text-anvil-400">
                No maintainers or writers. Nobody can push to this repo.
              </div>
            ) : (
              memberRows.map((m) => (
                <div
                  key={`${m.role}:${m.identity}`}
                  className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850"
                >
                  <Author identityId={m.identity} link={false} />
                  <RoleTag role={m.role === 'maintainer' ? 'MAINTAINER' : 'WRITER'} />
                  {m.identity === repo.ownerId ? (
                    <span className="text-[12px] text-anvil-400">owner</span>
                  ) : isOwner ? (
                    <Button
                      size="sm"
                      variant="danger"
                      className="ml-auto"
                      disabled={guard.disabledReason !== null}
                      onClick={() => setAction({ kind: 'revoke', member: m.identity, role: m.role })}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        )}
        {isOwner ? (
          <div className="mt-4 rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
            <h4 className="mb-2 text-dense font-medium">Add a member</h4>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Field label="Identity ID" htmlFor="member-id">
                  <Input id="member-id" value={memberId} onChange={(e) => setMemberId(e.target.value)} placeholder="base58 identity id" className="font-mono" spellCheck={false} />
                </Field>
              </div>
              <div role="radiogroup" aria-label="Role" className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
                {(['writer', 'maintainer'] as V2Role[]).map((r) => (
                  <button
                    key={r}
                    role="radio"
                    aria-checked={role === r}
                    onClick={() => setRole(r)}
                    className={
                      'rounded px-3 py-1.5 text-dense font-medium ' +
                      (role === r ? 'bg-forge-500/15 text-forge-600 dark:text-forge-400' : 'text-anvil-500')
                    }
                  >
                    {r}
                  </button>
                ))}
              </div>
              <Button
                variant="primary"
                disabled={memberId.trim() === '' || idError !== null || guard.disabledReason !== null}
                onClick={() => {
                  if (guard.check(previewCreate(role).credits)) setAction({ kind: 'grant', member: memberId.trim(), role })
                }}
              >
                Add
              </Button>
            </div>
            {idError ? <p className="mt-1 text-[12px] text-danger">{idError}</p> : null}
            <p className="mt-2 text-[12px] text-anvil-400">
              Writers can push, open refs and act on issues and PRs; maintainers can also update
              protected branches, config and releases.
            </p>
          </div>
        ) : null}
        <p className="mt-2 text-[12px] text-anvil-400">
          Members are the repo&apos;s maintainer and writer documents. Consensus checks them on
          every push, ref update and state event; removing one revokes it.
          {!isOwner ? ' Only the owner can add or remove members.' : ''}
        </p>
        <ConfirmDialog
          open={action !== null}
          onClose={() => setAction(null)}
          title={action?.kind === 'grant' ? `Add ${action.role}` : `Remove ${action?.role ?? 'member'}`}
          description={
            action?.kind === 'grant'
              ? `Creates a ${action.role} document for ${action.member.slice(0, 8)}… on this repo.`
              : 'Deletes their membership document. Their past pushes and events stay valid; new ones are refused.'
          }
          cost={action?.kind === 'revoke' ? previewDelete(action.role) : previewCreate(action?.role ?? 'writer')}
          confirmLabel={action?.kind === 'grant' ? 'Sign & add' : 'Sign & remove'}
          onConfirm={runAction}
        />
      </Section>

      <Section title="Platform details" icon={<Fingerprint className="h-4 w-4 text-anvil-400" aria-hidden />}>
        <dl className="divide-y divide-anvil-100 overflow-hidden rounded-lg border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800">
          <DetailRow label="Repo id">
            <Oid value={repo.repoId} chars={12} label="repo document id" />
          </DetailRow>
          <DetailRow label="Owner identity">
            <Oid value={repo.ownerId} chars={12} label="owner identity id" />
          </DetailRow>
          <DetailRow label="forge-core">
            <Oid value={repo.forge.core} chars={12} label="forge-core contract id" />
          </DetailRow>
          <DetailRow label="forge-collab">
            <Oid value={repo.forge.collab} chars={12} label="forge-collab contract id" />
          </DetailRow>
          <DetailRow label="Network">
            <NetworkBadge always />
          </DetailRow>
        </dl>
        <p className="mt-2 text-[12px] text-anvil-400">
          A forge-v2 repo is a <span className="font-mono">repo</span> document in the shared
          forge-core contract; everything else about it is keyed by the repo id. Click an id to
          copy it.
        </p>
      </Section>
    </div>
  )
}

/** The configured backend badge and its URIs (or `emptyText` when it names none). */
function StorageBackend({ backend, emptyText }: { backend: RepoHome['backend']; emptyText: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <BackendBadge backend={backend} />
      {backend.uris.length > 0 ? (
        <ul className="min-w-0 flex-1 space-y-0.5">
          {backend.uris.map((u) => (
            <li key={u} className="truncate font-mono text-[12px] text-anvil-500 dark:text-anvil-400">{u}</li>
          ))}
        </ul>
      ) : (
        <span className="text-dense text-anvil-500 dark:text-anvil-400">{emptyText}</span>
      )}
    </div>
  )
}

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-prose">
        {icon}
        {title}
      </h2>
      <div>{children}</div>
    </section>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5">
      <dt className="shrink-0 text-dense text-anvil-500 dark:text-anvil-400">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function NotSet(): JSX.Element {
  return <span className="text-dense text-anvil-400">—</span>
}

function RoleTag({ role }: { role: string }): JSX.Element {
  return (
    <span className="rounded bg-forge-500/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-forge-600 dark:text-forge-400">
      {role}
    </span>
  )
}
