'use client'

/**
 * SettingsContent — repo administration, GitHub-style: General (default branch, description,
 * topics), Branches (protected patterns, branch policy), Collaborators (the repo's
 * `maintainer` / `writer` documents), Storage, and the Danger zone (archive). Every write has a
 * pre-sign cost + confirm. Consensus is the real gate; the UI shows the controls and surfaces
 * the on-chain result. The config and policy sections live in `repo-settings-sections.tsx`.
 */

import { useState } from 'react'
import { Fingerprint, HardDrive, ShieldPlus, UserCog } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import type { RepoRef } from '@/lib/repo'
import { ConsentMissingError, changeMemberRole, grantDescription, grantMember, invalidateMembers, memberDocOf, readMembershipsCached, repoContractIds, revokeMember } from '@/lib/repo'
import { roleChangeCost } from '@/lib/repo/private-members'
import { ConsentCheck, Invitations, mayAdd, useInviteAccepted } from '@/components/repo/invite-banner'
import type { Membership, Role as MemberRole } from '@/lib/rules/v2'
import { NetworkBadge } from '@/components/ui/network-badge'
import { previewCreate, previewDelete } from '@/lib/sdk'
import { ROLE_LABEL, ROLE_NOUN, grantableRoles, membershipTitle } from '@/lib/rules/roles'
import { namedAction } from '@/lib/spend-toast'
import { RoleBadge, RolePicker, RoleSummary } from '@/components/repo/role-picker'
import { decodeIdentifier } from '@/lib/auth'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { retryWhileMissing } from '@/lib/view/retry'
import { useAuth } from '@/contexts/auth-context'
import { Author } from '@/components/author'
import { BackendBadge } from '@/components/ui/backend-badge'
import { EnforcedBy } from '@/components/ui/enforced-by'
import { Oid } from '@/components/ui/oid'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ErrorState, LoadingBlock } from '@/components/ui/states'
import { RepoStoragePolicy } from '@/components/storage/repo-storage-policy'
import { PrivateMembers } from '@/components/repo/private-members'
import { SettingsReadOnly } from '@/components/repo/settings-read-only'
import { PrivateRepoState } from '@/components/repo/private-repo-state'
import { WebhookSettings } from '@/components/repo/webhook-settings'
import { UnlockMore } from '@/components/auth/unlock-more'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { BranchSettings, DangerZone, GeneralSettings, Section, SettingsNav } from '@/components/repo/repo-settings-sections'

/** A Collaborators write awaiting its confirm; `change` (public repos) deletes `role`'s document, then adds `to`. */
type MemberAction =
  | { readonly kind: 'grant' | 'revoke'; readonly member: string; readonly role: MemberRole }
  | { readonly kind: 'change'; readonly member: string; readonly role: MemberRole; readonly to: MemberRole }

export function SettingsContent({ home, reload }: { home: RepoHome; reload: () => void }): JSX.Element {
  // QW-079: a private repo's settings are its members' (GitHub answers anyone else with a 404).
  // Without the key nothing here is true: its branches are encrypted names, so the page would
  // claim it has none. A signed-out visitor or an outsider sees what every other tab shows them;
  // a member whose tab holds only the signing key (`locked`), or no encryption key yet
  // (`no-key`), still gets the page and the way to open it.
  // No access resolved yet reads as an outsider, as RepoScaffold does.
  const access = home.private?.access ?? 'outsider'
  if (home.repo.visibility === 'private' && (access === 'signed-out' || access === 'outsider')) {
    return <PrivateRepoState repo={home.repo} addr={{ owner: home.repo.ownerId, name: home.repo.name }} access={access} />
  }
  return <RepoSettings home={home} repo={home.repo} reload={reload} />
}

/**
 * The repo's members (its current `maintainer` / `writer` documents — the
 * ACL consensus enforces), and the ids a CLI or SDK user needs. The owner adds a member by
 * creating their document and removes one by deleting it; consensus refuses anyone else.
 */
function RepoSettings({ home, repo, reload }: { home: RepoHome; repo: RepoRef; reload: () => void }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()
  const isOwner = identity === repo.ownerId
  const viewer = useViewerRole(repo)
  const viewerRole = viewer.role
  // The encryption key is in this browser, but this tab resumed with the signing key only: the
  // page's one unlock sits under Collaborators (Storage points to it).
  const locked = home.private?.access === 'locked'
  const members = useAsync<Membership[]>(
    () => readMembershipsCached(sdk!, repo, network),
    [ready, repo.repoId, network],
    { enabled: ready && sdk !== null },
  )
  const memberRows = members.data ?? []
  // The identity the owner tried to add before they accepted: the invite is pending on them.
  const [awaiting, setAwaiting] = useState<string | null>(null)
  const [memberId, setMemberId] = useState('')
  const [role, setRole] = useState<MemberRole>('writer')
  const [action, setAction] = useState<MemberAction | null>(null)
  // The member row whose role picker is open (`role:identity`).
  const [changing, setChanging] = useState<string | null>(null)
  const idError = (() => {
    if (memberId.trim() === '') return null
    try {
      decodeIdentifier(memberId.trim())
      return null
    } catch {
      return 'Not an identity id (base58, 32 bytes).'
    }
  })()
  // Whether the typed identity accepted, read before Add prices anything (QW4-036).
  const typed = memberId.trim() !== '' && idError === null ? memberId.trim() : null
  const consent = useInviteAccepted(repo, isOwner && repo.visibility !== 'private' ? typed : null)
  const runAction = async (intent: string): Promise<void> => {
    if (!sdk || !signer || !action) throw new Error('sign in to continue')
    if (action.kind === 'change') {
      try {
        await changeMemberRole(sdk, signer, repo, action.member, action.role, action.to, intent)
      } catch (e) {
        if (!(e instanceof ConsentMissingError)) throw e
        // Nothing was signed: their consent is gone, so the change waits on them accepting again.
        setAwaiting(action.member)
        setAction(null)
        return
      }
      setChanging(null)
    } else if (action.kind === 'grant') {
      try {
        await grantMember(sdk, signer, repo, action.member, action.role, intent)
      } catch (e) {
        if (!(e instanceof ConsentMissingError)) throw e
        // Nothing was signed: show the invitation as pending on them instead of an error.
        setAwaiting(action.member)
        setAction(null)
        consent.recheck()
        return
      }
      setAwaiting(null)
      setMemberId('')
    } else {
      await revokeMember(sdk, signer, repo, action.member, action.role)
    }
    // The write landed, but the node the next read hits may be a block behind: re-read until
    // the change shows (then it is what the cache holds), else keep the last answer.
    const done = action
    const shows = (rows: Membership[]): boolean =>
      done.kind === 'change'
        ? rows.some((m) => m.identity === done.member && m.role === done.to)
        : rows.some((m) => m.identity === done.member && m.role === done.role) === (done.kind === 'grant')
    await retryWhileMissing(async () => {
      invalidateMembers(repo, network)
      return shows(await readMembershipsCached(sdk, repo, network)) ? true : null
    }, 8)
    members.reload()
  }
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <SettingsNav />

      {/* Settings are a maintainer's (QW3-055): anyone else reads them, plainly read-only. */}
      {viewer.known ? <SettingsReadOnly ownerId={repo.ownerId} role={viewerRole} /> : null}

      <GeneralSettings home={home} maintainer={viewerRole === 'maintainer'} owner={isOwner} onSaved={reload} />

      <BranchSettings home={home} maintainer={viewerRole === 'maintainer'} onSaved={reload} />

      <Section id="collaborators" title="Members" icon={<ShieldPlus className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />}>
        {home.private?.access === 'member' ? (
          <PrivateMembers home={home} session={home.private.session} />
        ) : (
        <>
        {members.loading ? (
          <LoadingBlock label="Reading members" />
        ) : members.error ? (
          <ErrorState message={members.error} onRetry={members.reload} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
            {memberRows.length === 0 ? (
              <div className="px-4 py-6 text-center text-dense text-anvil-500 dark:text-anvil-400">
                No members. Nobody can push to this repo.
              </div>
            ) : (
              memberRows.map((m) => {
                const rowKey = `${m.role}:${m.identity}`
                return (
                  <div key={rowKey} className="border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850" data-testid="member-row">
                    <div className="flex flex-wrap items-center gap-3">
                      <Author identityId={m.identity} link={false} />
                      <RoleBadge role={m.role} />
                      {m.identity === repo.ownerId ? (
                        <span className="text-[12px] text-anvil-500 dark:text-anvil-400">owner</span>
                      ) : isOwner && repo.visibility !== 'private' ? (
                        <div className="ml-auto flex gap-2">
                          <Button size="sm" variant="outline" disabled={guard.disabledReason !== null} aria-expanded={changing === rowKey} onClick={() => setChanging((c) => (c === rowKey ? null : rowKey))}>
                            Change role
                          </Button>
                          <Button size="sm" variant="danger" disabled={guard.disabledReason !== null} onClick={() => setAction({ kind: 'revoke', member: m.identity, role: m.role })}>
                            Remove
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    {changing === rowKey ? (
                      <div className="mt-2">
                        <RolePicker
                          action
                          value={m.role}
                          visibility={repo.visibility}
                          // Not the current role, nor a role whose document type they already hold in
                          // another row (a maintainer who is also a writer): the add would refuse it.
                          exclude={grantableRoles(repo.visibility).filter(
                            (r) => r === m.role || memberRows.some((o) => o.identity === m.identity && o.role !== m.role && memberDocOf(o.role) === memberDocOf(r)),
                          )}
                          disabled={guard.disabledReason !== null}
                          onChange={(to) => {
                            if (guard.check(roleChangeCost(m.role, to))) setAction({ kind: 'change', member: m.identity, role: m.role, to })
                          }}
                        />
                        <p className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                          They don&apos;t need to accept again.
                        </p>
                      </div>
                    ) : null}
                  </div>
                )
              })
            )}
          </div>
        )}
        {locked ? (
          <div id="members-unlock" className="mt-4 scroll-mt-20">
            <UnlockMore title={isOwner ? 'Unlock this tab to add or remove members' : "Unlock this tab to see the repo's key epoch"} testId="members-unlock" />
          </div>
        ) : isOwner && repo.visibility === 'private' ? (
          <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
            Adding or removing a member of a private repo hands out or rotates its key: add your encryption key to this browser
            (Settings → Private repos) to manage members.
          </p>
        ) : isOwner ? (
          <div className="mt-4 rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
            <h4 className="mb-2 text-dense font-medium">Add a member</h4>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Field label="Identity ID" htmlFor="member-id">
                  <Input id="member-id" value={memberId} onChange={(e) => setMemberId(e.target.value)} placeholder="base58 identity id" className="font-mono" spellCheck={false} />
                </Field>
              </div>
              <RolePicker value={role} onChange={setRole} visibility={repo.visibility} />
              <Button
                variant="primary"
                disabled={typed === null || !mayAdd(consent) || guard.disabledReason !== null}
                onClick={() => {
                  if (typed !== null && guard.check(previewCreate(memberDocOf(role)))) setAction({ kind: 'grant', member: typed, role })
                }}
              >
                Add
              </Button>
            </div>
            <RoleSummary role={role} />
            {idError ? <p className="mt-1 text-[12px] text-danger-700 dark:text-danger-400">{idError}</p> : null}
            {awaiting !== typed ? <ConsentCheck identity={typed} check={consent} /> : null}
            <Invitations
              repo={repo}
              members={members.data === null ? null : memberRows.map((m) => m.identity)}
              awaiting={awaiting}
              disabled={guard.disabledReason !== null}
              role={role}
              onPick={(id, r) => {
                if (guard.check(previewCreate(memberDocOf(r)))) setAction({ kind: 'grant', member: id, role: r })
              }}
            />
            <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
              People join only after accepting your invitation. Only maintainers&apos; and writers&apos; approvals count toward merging.
            </p>
          </div>
        ) : null}
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-anvil-500 dark:text-anvil-400">
          <span>
            Members act according to their role. Removing someone takes effect immediately.
            {!isOwner ? ' Only the owner can add or remove members.' : ''}
          </span>
          <EnforcedBy by="platform" />
        </p>
        <ConfirmDialog
          open={action !== null}
          onClose={() => setAction(null)}
          title={
            action?.kind === 'grant'
              ? `Add ${ROLE_NOUN[action.role]}`
              : action?.kind === 'change'
                ? `Change role to ${ROLE_LABEL[action.to]}`
                : action?.kind === 'revoke'
                  ? `Remove ${ROLE_NOUN[action.role]}`
                  : 'Remove member'
          }
          // The toast says the role granted, not the document type (QW4-033: triage was "Writer added").
          toast={action === null ? undefined : namedAction(membershipTitle(action.kind, action.kind === 'change' ? action.to : action.role))}
          description={
            action?.kind === 'grant'
              ? `Adds ${action.member.slice(0, 8)}… as ${grantDescription(action.role)}.`
              : action?.kind === 'change'
                ? `Makes ${action.member.slice(0, 8)}… ${ROLE_NOUN[action.to]} instead of ${ROLE_NOUN[action.role]}. They don't need to accept again.`
                : 'Removes them from this repo. Their past pushes and comments stay. Anything new they try is refused.'
          }
          cost={
            action === null
              ? previewCreate('writer')
              : action.kind === 'revoke'
                ? previewDelete(memberDocOf(action.role))
                : action.kind === 'change'
                  ? roleChangeCost(action.role, action.to)
                  : previewCreate(memberDocOf(action.role))
          }
          confirmLabel={action?.kind === 'grant' ? 'Sign & add' : action?.kind === 'change' ? 'Sign & change' : 'Sign & remove'}
          onConfirm={runAction}
        />
        </>
        )}
      </Section>

      <Section id="storage" title="Storage" icon={<UserCog className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />}>
        <StorageBackend backend={home.backend} emptyText="Readers follow each pack manifest's own storage." />
        {/* Where this browser stores packs it pushes here: a member's only (an outsider never pushes to this repo). */}
        {!(viewer.known && viewerRole === null) ? (
          <>
            <h3 className="mb-2 mt-5 flex items-center gap-2 text-dense font-medium">
              <HardDrive className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden /> Your browser pushes
            </h3>
            <RepoStoragePolicy repoId={repo.repoId} unlockAbove={locked} />
          </>
        ) : null}
      </Section>

      <WebhookSettings home={home} maintainer={viewerRole === 'maintainer'} />

      <DangerZone home={home} maintainer={viewerRole === 'maintainer'} onSaved={reload} />

      <Section title="Platform details" icon={<Fingerprint className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />}>
        <dl className="divide-y divide-anvil-100 overflow-hidden rounded-lg border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800">
          <DetailRow label="Repo id">
            <Oid value={repo.repoId} chars={12} label="repo id" />
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
          <DetailRow label="forge-community">
            <Oid value={repo.forge.community} chars={12} label="forge-community contract id" />
          </DetailRow>
          <DetailRow label="Network">
            <NetworkBadge always />
          </DetailRow>
        </dl>
        <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">Ids for developers and the CLI. Click one to copy it.</p>
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

function DetailRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5">
      <dt className="shrink-0 text-dense text-anvil-500 dark:text-anvil-400">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}
