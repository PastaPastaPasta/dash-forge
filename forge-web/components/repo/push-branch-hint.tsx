'use client'

/**
 * "Need to push a branch first?" on New pull request (QW-022): where THIS viewer can push a
 * branch the picker above will then offer, as GitHub's compare page leads a reader without push
 * access to a fork. A maintainer or writer pushes to this repo; anyone else pushes to one of their
 * forks of it (the `forkOf` index), or forks it first. A remote the viewer cannot push to, or one
 * that does not exist, is never suggested.
 */

import { GitBranch } from 'lucide-react'

import type { RepoRef } from '@/lib/repo'
import { repoCommands, shellWord } from '@/lib/view/repo-commands'
import { useViewerRole, type ViewerRole } from '@/hooks/use-repo-chrome'
import { useAuth } from '@/contexts/auth-context'
import { CopyRow } from '@/components/ui/copy-row'
import { ForkButton } from '@/components/repo/fork-button'

/** The branch name the commands suggest. */
const BRANCH = 'my-fix'

/** `git push dash://owner/name HEAD:my-fix`: push the checked-out commit as a new branch of `owner/name`. */
export function pushCommand(owner: string, name: string): string {
  return `git push ${shellWord(repoCommands(owner, name).remote)} HEAD:${BRANCH}`
}

/** Where the viewer can push, from what is known about them so far. */
export type PushHint =
  /** Not known yet (the role or the viewer's forks are still being read). */
  | { readonly kind: 'loading' }
  /** A maintainer or writer: push to this repo. */
  | { readonly kind: 'member'; readonly command: string }
  /** No push access, with forks of this repo: push to one of them. */
  | { readonly kind: 'fork'; readonly forks: readonly { readonly name: string; readonly command: string }[] }
  /** No push access and no fork yet: fork it first. */
  | { readonly kind: 'fork-first' }
  /** No push access to a private repo, which cannot be forked. */
  | { readonly kind: 'members-only' }
  /** Signed out, or a read failed: both routes (this repo's command is for its writers), neither assumed. */
  | { readonly kind: 'either'; readonly command: string; readonly canFork: boolean }

export function pushHintOf({
  repo,
  identity,
  role,
  forks,
}: {
  readonly repo: RepoRef
  readonly identity: string | null
  readonly role: { readonly role: ViewerRole; readonly known: boolean; readonly failed: boolean }
  /** The viewer's forks of `repo`: null while they are read, `failed` when they could not be. */
  readonly forks: readonly RepoRef[] | null | 'failed'
}): PushHint {
  const canFork = repo.visibility === 'public'
  const command = pushCommand(repo.ownerId, repo.name)
  if (identity === null || role.failed) return { kind: 'either', command, canFork }
  if (!role.known) return { kind: 'loading' }
  if (role.role !== null) return { kind: 'member', command }
  if (!canFork) return { kind: 'members-only' }
  if (forks === null) return { kind: 'loading' }
  if (forks === 'failed') return { kind: 'either', command, canFork }
  if (forks.length === 0) return { kind: 'fork-first' }
  return { kind: 'fork', forks: forks.map((f) => ({ name: f.name, command: pushCommand(f.ownerId, f.name) })) }
}

export function PushBranchHint({
  repo,
  forks,
}: {
  readonly repo: RepoRef
  /** The viewer's forks of `repo`: null while read, `failed` when they could not be. */
  readonly forks: readonly RepoRef[] | null | 'failed'
}): JSX.Element | null {
  const { identity } = useAuth()
  const role = useViewerRole(repo)
  const hint = pushHintOf({ repo, identity, role, forks })
  if (hint.kind === 'loading') return null
  return (
    <div className="text-dense text-anvil-600 dark:text-anvil-300" data-testid="push-hint" data-kind={hint.kind}>
      <p className="mb-1.5">
        <GitBranch className="mr-1 inline h-3.5 w-3.5" aria-hidden />
        Need to push a branch first?{' '}
        {hint.kind === 'member'
          ? `Push it to ${repo.name}, then pick it under Compare.`
          : hint.kind === 'fork'
            ? `You can't push to ${repo.name}. Push it to your fork, then pick it under Your forks.`
            : hint.kind === 'fork-first'
              ? `You can't push to ${repo.name}. Fork it, push your branch to the fork, then pick it here under Your forks.`
              : hint.kind === 'members-only'
                ? `Only maintainers and writers can push to ${repo.name}, and a private repository can't be forked.`
                : hint.canFork
                  ? `Maintainers and writers push to ${repo.name}; everyone else forks it and pushes to the fork.`
                  : `Maintainers and writers push to ${repo.name}.`}
      </p>
      {hint.kind === 'member' || hint.kind === 'either' ? <CopyRow text={hint.command} /> : null}
      {hint.kind === 'fork' ? hint.forks.map((f) => <CopyRow key={f.name} text={f.command} label={`Copy the push command for ${f.name}`} />) : null}
      {hint.kind === 'fork-first' || (hint.kind === 'either' && hint.canFork) ? (
        <div>
          <ForkButton parent={repo} />
        </div>
      ) : null}
    </div>
  )
}
