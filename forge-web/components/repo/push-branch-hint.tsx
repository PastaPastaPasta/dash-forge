'use client'

/**
 * "Need to push a branch first?" on New pull request (QW-022): where THIS viewer can push a
 * branch the picker above will then offer, as GitHub's compare page leads a reader without push
 * access to a fork. A maintainer or writer pushes to this repo; anyone else pushes to one of their
 * forks of it (the `forkOf` index), or forks it first. A remote the viewer is known not to be able
 * to push to, or one that does not exist, is never suggested.
 */

import { GitBranch } from 'lucide-react'

import type { RepoRef } from '@/lib/repo'
import { shellWord } from '@/lib/view/repo-commands'
import { useViewerRole, type ViewerRole } from '@/hooks/use-repo-chrome'
import { useAuth } from '@/contexts/auth-context'
import { CopyRow } from '@/components/ui/copy-row'
import { ForkButton } from '@/components/repo/fork-button'

/** `git push dash://owner/name HEAD:my-fix`: push the checked-out commit as a new branch of `owner/name`. */
export function pushCommand(owner: string, name: string): string {
  return `git push ${shellWord(`dash://${owner}/${name}`)} HEAD:my-fix`
}

/** Where the viewer can push, from what is known about them so far. */
export type PushHint =
  /** Not known yet (the role or the viewer's forks are still being read). */
  | { readonly kind: 'loading' }
  /** A maintainer or writer: push to this repo. */
  | { readonly kind: 'member'; readonly command: string }
  /** With forks of this repo (and no known push access to it): push to one of them. */
  | { readonly kind: 'fork'; readonly forks: readonly { readonly name: string; readonly command: string }[] }
  /** No push access and no fork yet: fork it first. */
  | { readonly kind: 'fork-first' }
  /** No push access to a private repo, which cannot be forked. */
  | { readonly kind: 'members-only' }
  /**
   * Signed out, or a read failed: both routes, neither assumed. `command` is this repo's, for its
   * writers, and null when the viewer is known not to be one.
   */
  | { readonly kind: 'either'; readonly command: string | null; readonly canFork: boolean }

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
  if (identity === null) return { kind: 'either', command, canFork }
  if (role.known && role.role !== null) return { kind: 'member', command }
  // A fork of the viewer's is a remote they can push to whatever the role read says.
  if (Array.isArray(forks) && forks.length > 0) {
    return { kind: 'fork', forks: forks.map((f) => ({ name: f.name, command: pushCommand(f.ownerId, f.name) })) }
  }
  if (role.failed) return { kind: 'either', command, canFork }
  if (!role.known) return { kind: 'loading' }
  if (!canFork) return { kind: 'members-only' }
  if (forks === null) return { kind: 'loading' }
  // Known not to be a writer, but whether they have a fork could not be read.
  if (forks === 'failed') return { kind: 'either', command: null, canFork }
  return { kind: 'fork-first' }
}

/** What the hint says, after "Need to push a branch first?". */
function messageOf(hint: Exclude<PushHint, { kind: 'loading' }>, name: string): string {
  switch (hint.kind) {
    case 'member':
      return `Push it to ${name}, then pick it under Compare.`
    case 'fork':
      return `You can't push to ${name}. Push it to your fork, then pick it under Your forks.`
    case 'fork-first':
      return `You can't push to ${name}. Fork it and push your branch to the fork, then come back and pick it under Your forks.`
    case 'members-only':
      return `Only maintainers and writers can push to ${name}, and a private repository can't be forked.`
    case 'either':
      if (!hint.canFork) return `Maintainers and writers push to ${name}.`
      return hint.command === null
        ? `You can't push to ${name}. Push your branch to your fork of it, or fork it first.`
        : `Maintainers and writers push to ${name}; everyone else forks it and pushes to the fork.`
  }
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
  const commands =
    hint.kind === 'member' ? [hint.command] : hint.kind === 'fork' ? hint.forks.map((f) => f.command) : hint.kind === 'either' && hint.command !== null ? [hint.command] : []
  const fork = hint.kind === 'fork-first' || (hint.kind === 'either' && hint.canFork)
  return (
    <div className="text-dense text-anvil-600 dark:text-anvil-300" data-testid="push-hint" data-kind={hint.kind}>
      <p className="mb-1.5">
        <GitBranch className="mr-1 inline h-3.5 w-3.5" aria-hidden />
        Need to push a branch first? {messageOf(hint, repo.name)}
      </p>
      {commands.map((c) => (
        <CopyRow key={c} text={c} label={`Copy ${c}`} />
      ))}
      {fork ? (
        <div>
          <ForkButton parent={repo} />
        </div>
      ) : null}
    </div>
  )
}
