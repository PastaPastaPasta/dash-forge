'use client'

/**
 * Branch administration on the branches page (P1-4), as on GitHub: "New branch" (a name and a
 * source branch) and a delete button per branch, then "Restore" for a branch this tab deleted.
 * Each is one ref update and nothing uploaded (`lib/repo/ref-admin.ts`).
 *
 * Shown to the repo's maintainers and writers (consensus admits a `refUpdate` from them only);
 * a triage member or reader sees one line saying why there is no button. The default branch and
 * protected branches have a disabled delete button whose label says why, as GitHub's does.
 */

import { useCallback, useMemo, useState } from 'react'
import { GitBranchPlus, RotateCcw, Trash2 } from 'lucide-react'

import type { RepoHome } from '@/lib/view'
import { ARCHIVED_REASON, isLive, tipOidOf } from '@/lib/view'
import { compareRefNames, type ResolvedRef } from '@/lib/repo'
import { BRANCH_PREFIX, branchNameProblem, createBranch, deleteBranch, deleteBranchBlock, refWriteBlock, shortRef } from '@/lib/repo/ref-admin'
import { capabilitiesOf } from '@/lib/rules/roles'
import type { Role } from '@/lib/rules/v2'
import { EXISTING, newIntent, previewCreate } from '@/lib/sdk'
import { namedAction, spendAction } from '@/lib/spend-toast'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { privateComposeBlock } from '@/components/repo/private-compose'
import { RoleLimitNote } from '@/components/repo/role-limit-note'
import { Button } from '@/components/ui/button'
import { CostPreview } from '@/components/ui/cost-preview'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'

/** A new ref name (its subtree is built) in a repo that has ref updates. */
const NEW_REF = { repo: false } as const

/** What the page needs to offer branch writes: the viewer's role, and why writes are off here. */
export interface BranchAdmin {
  readonly role: Role | null
  /** Whether the viewer may push here at all (a maintainer or writer). */
  readonly canPush: boolean
  /** Archived, or a private repo this tab cannot write to: why every branch write is off. */
  readonly blocked: string | null
  readonly patterns: readonly string[]
}

/**
 * Branches deleted from the branches page in this tab, by repo, with the tip each had: "Restore"
 * puts one back there. Kept outside the page so a re-read that remounts it (a private repo's
 * home re-checks its keys) keeps the offer.
 */
const deletedHere = new Map<string, ReadonlyMap<string, string>>()

/** {@link deletedHere} for `repoKey`, and a setter. */
export function useDeletedHere(key: string): readonly [ReadonlyMap<string, string>, (update: (m: Map<string, string>) => void) => void] {
  const [map, setMap] = useState<ReadonlyMap<string, string>>(() => deletedHere.get(key) ?? new Map())
  const update = useCallback(
    (change: (m: Map<string, string>) => void) => {
      const next = new Map(deletedHere.get(key) ?? [])
      change(next)
      deletedHere.set(key, next)
      setMap(next)
    },
    [key],
  )
  return [map, update]
}

export function useBranchAdmin(home: RepoHome): BranchAdmin {
  const { role } = useViewerRole(home.repo)
  const blocked = home.config?.archived === true ? ARCHIVED_REASON : privateComposeBlock(home)
  return { role, canPush: capabilitiesOf(role).canPush, blocked, patterns: home.config?.protectedPatterns ?? [] }
}

/** The live branches, the default first, then by name: a new branch's (or tag's) source choices. */
export function sourceBranches(home: Pick<RepoHome, 'branches' | 'defaultBranch'>): ResolvedRef[] {
  const def = `${BRANCH_PREFIX}${home.defaultBranch}`
  return home.branches
    .filter(isLive)
    .sort((a, b) => (a.refName === def ? -1 : b.refName === def ? 1 : compareRefNames(shortRef(a.refName), shortRef(b.refName))))
}

/**
 * "New branch": the button, or for a triage member or reader the line saying they can't. Nothing
 * for anyone else (signed out, not a member), as GitHub shows nothing.
 */
export function NewBranchButton({ home, admin, onCreated }: { home: RepoHome; admin: BranchAdmin; onCreated: () => void }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const guard = useWriteGuard()
  if (admin.role === 'triage' || admin.role === 'reader') return <RoleLimitNote role={admin.role} cap="canPush" what="create or delete branches" />
  if (!admin.canPush) return null
  const sources = sourceBranches(home)
  const off = admin.blocked ?? (sources.length === 0 ? 'Push a first branch with git: a new branch starts from an existing one.' : null)
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        disabled={off !== null}
        title={off ?? undefined}
        onClick={() => {
          if (guard.check(previewCreate('refUpdate', {}, NEW_REF), 'core', 'create a branch')) setOpen(true)
        }}
        data-testid="new-branch"
      >
        <GitBranchPlus className="h-3.5 w-3.5" aria-hidden /> New branch
      </Button>
      {open ? <NewBranchDialog home={home} admin={admin} sources={sources} onClose={() => setOpen(false)} onCreated={onCreated} /> : null}
    </>
  )
}

function NewBranchDialog({
  home,
  admin,
  sources,
  onClose,
  onCreated,
}: {
  home: RepoHome
  admin: BranchAdmin
  sources: readonly ResolvedRef[]
  onClose: () => void
  onCreated: () => void
}): JSX.Element {
  const { sdk } = useSdk()
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const [name, setName] = useState('')
  const [from, setFrom] = useState(sources[0]?.refName ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One intent per opening: a retry after an unconfirmed write finishes it, never signs twice.
  const [intent] = useState(newIntent)
  const trimmed = name.trim()
  const source = sources.find((s) => s.refName === from) ?? null
  const target = tipOidOf(source ?? undefined)
  const refName = `${BRANCH_PREFIX}${trimmed}`
  const exists = home.branches.some((b) => b.refName === refName && isLive(b))
  const problem =
    trimmed === ''
      ? null
      : (branchNameProblem(trimmed) ?? (exists ? `a branch named ${trimmed} already exists` : null) ?? refWriteBlock(admin.role, refName, admin.patterns, 'create this branch'))
  const cost = useMemo(() => previewCreate('refUpdate', {}, NEW_REF), [])
  const disabled = pending || trimmed === '' || problem !== null || target === null || guard.disabledReason !== null

  const create = async (): Promise<void> => {
    if (disabled || !sdk || !signer || target === null || !guard.check(cost, 'core', 'create a branch')) return
    setPending(true)
    setError(null)
    try {
      // The toast names the action: a ref update's own title is "Branch updated".
      await spendAction({ running: `Creating ${trimmed}…`, ...namedAction(`Branch ${trimmed} created`) }, (tag) =>
        createBranch(sdk, tag(signer), home.repo, { name: trimmed, target, role: admin.role, intent: `branch-create:${home.repo.repoId}:${intent}:${trimmed}:${target}` }),
      )
      onCreated()
      onClose()
    } catch (e) {
      setError(guard.failed(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open
      onClose={() => (pending ? undefined : onClose())}
      title="Create a branch"
      description="A new branch at the tip of an existing one. Nothing is uploaded: it names a commit this repo already stores."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={create} loading={pending} disabled={disabled} title={guard.disabledReason ?? problem ?? undefined} data-testid="new-branch-create">
            Create branch
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <Field label="New branch name" htmlFor="new-branch-name">
          <Input
            id="new-branch-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="font-mono"
            placeholder="feature/my-change"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem !== null}
            aria-describedby="new-branch-problem"
            disabled={pending}
          />
        </Field>
        <Field label="Source" htmlFor="new-branch-source" hint={target !== null ? `Starts at ${target.slice(0, 7)}.` : undefined}>
          <select
            id="new-branch-source"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            disabled={pending}
            className="w-full rounded-md border border-anvil-300 bg-white px-2 py-1.5 font-mono text-dense dark:border-anvil-700 dark:bg-anvil-950 coarse:h-11"
          >
            {sources.map((s) => (
              <option key={s.refName} value={s.refName}>
                {shortRef(s.refName)}
              </option>
            ))}
          </select>
        </Field>
        <CostPreview cost={cost} />
        <p id="new-branch-problem" role="status" className="text-[12px] text-caution-700 dark:text-caution-400">
          {problem ?? ''}
        </p>
        {error ? (
          <div role="alert" className="break-words rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400">
            {error}
          </div>
        ) : null}
      </form>
    </Dialog>
  )
}

/**
 * The delete button of one live branch, for a maintainer or writer: disabled, with the reason as
 * its label, for the default branch, a protected or a diverged one. Confirmed with the cost, then
 * `onDeleted(tip)` (the page offers "Restore" from that tip).
 */
export function DeleteBranchButton({
  home,
  admin,
  branch,
  onDeleted,
}: {
  home: RepoHome
  admin: BranchAdmin
  branch: ResolvedRef
  onDeleted: (tip: string) => void
}): JSX.Element | null {
  const { sdk } = useSdk()
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const [open, setOpen] = useState(false)
  const cost = useMemo(() => previewCreate('refUpdate', {}, EXISTING), [])
  if (!admin.canPush) return null
  const name = shortRef(branch.refName)
  const tip = tipOidOf(branch)
  const block =
    admin.blocked ?? deleteBranchBlock({ refName: branch.refName, defaultBranch: home.defaultBranch, patterns: admin.patterns, role: admin.role, state: branch.state.state })
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="text-anvil-500 hover:text-danger-700 dark:text-anvil-400 dark:hover:text-danger-400"
        // A disabled button keeps its reason readable: as the title, and as its accessible name.
        disabled={block !== null || tip === null}
        title={block ?? `Delete ${name}`}
        aria-label={block ?? `Delete branch ${name}`}
        onClick={() => {
          if (guard.check(cost, 'core', 'delete a branch')) setOpen(true)
        }}
        data-testid="delete-branch"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </Button>
      {tip !== null ? (
        <ConfirmDialog
          open={open}
          onClose={() => setOpen(false)}
          title={`Delete branch ${name}?`}
          description={`${name} points at ${tip.slice(0, 7)}. Its commits stay stored: you can restore it from this page until you leave it, or push it again with git.`}
          cost={cost}
          confirmLabel="Delete branch"
          toast={{ running: `Deleting ${name}…`, ...namedAction(`Branch ${name} deleted`) }}
          onConfirm={async (intent) => {
            if (!sdk || !signer) throw new Error('sign in to continue')
            await deleteBranch(sdk, signer, home.repo, { refName: branch.refName, tip, defaultBranch: home.defaultBranch, role: admin.role, intent: `branch-delete:${home.repo.repoId}:${intent}:${branch.refName}:${tip}` })
            onDeleted(tip)
          }}
        />
      ) : null}
    </>
  )
}

/** "Restore" for a branch this tab deleted: the branch again at the tip it had. */
export function RestoreBranchButton({ home, admin, refName, tip, onRestored }: { home: RepoHome; admin: BranchAdmin; refName: string; tip: string; onRestored: () => void }): JSX.Element | null {
  const { sdk } = useSdk()
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [intent] = useState(newIntent)
  if (!admin.canPush) return null
  const name = shortRef(refName)
  const block = admin.blocked ?? refWriteBlock(admin.role, refName, admin.patterns, 'restore it')
  const restore = async (): Promise<void> => {
    if (pending || !sdk || !signer || !guard.check(previewCreate('refUpdate', {}, EXISTING), 'core', 'restore a branch')) return
    setPending(true)
    setError(null)
    try {
      await spendAction({ running: `Restoring ${name}…`, ...namedAction(`Branch ${name} restored`) }, (tag) =>
        createBranch(sdk, tag(signer), home.repo, { name, target: tip, role: admin.role, restoring: true, intent: `branch-restore:${home.repo.repoId}:${intent}:${refName}:${tip}` }),
      )
      onRestored()
    } catch (e) {
      setError(guard.failed(e))
    } finally {
      setPending(false)
    }
  }
  return (
    <span className="flex shrink-0 items-center gap-2">
      {error ? (
        <span role="alert" className="max-w-[12rem] truncate text-[12px] text-danger-700 dark:text-danger-400" title={error}>
          {error}
        </span>
      ) : null}
      <Button variant="outline" size="sm" onClick={restore} loading={pending} disabled={block !== null} title={block ?? `Restore ${name} at ${tip.slice(0, 7)}`} data-testid="restore-branch">
        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Restore
      </Button>
    </span>
  )
}
