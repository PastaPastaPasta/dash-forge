'use client'

/**
 * Code owners in the web app (P1-6; the rules are `lib/rules/codeowners`, shared with `dg`):
 *
 * - {@link CodeOwnersProvider} / {@link FileOwnersButton}: the Files tab marks each file with
 *   its owners, as GitHub's shield does ("Owned by @alice (from CODEOWNERS line 3)").
 * - {@link useOwnerRequests} / {@link CodeOwnerReviewers}: "Open a pull request" lists the code
 *   owners it will ask for review, each a kind-13 review request written after the PR (the
 *   author's `authorEvent` when they are not a member who may request reviews).
 *
 * The file is read from the base branch tip (GitHub reads the base's too), through the base
 * repo's browse reader; a repo without one, or storage that will not read, shows nothing.
 */

import Link from 'next/link'
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { Shield, ShieldCheck } from 'lucide-react'

import { useAuth } from '@/contexts/auth-context'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { useDpnsName } from '@/hooks/use-dpns-name'
import { useSdk } from '@/hooks/use-sdk'
import { readMembershipsCached, repoContractIds, type RepoRef } from '@/lib/repo'
import { codeOwnerRequests, decidingRules, ownerKind, ownersOfPaths, RoleOracle, tokenIdentity, type OwnerRequests, type SkipReason } from '@/lib/rules/v2'
import { changedPaths, readCodeOwners, type CodeOwnersFile } from '@/lib/view/codeowners'
import type { FileChange } from '@/lib/view/commit-log'
import { resolveDpnsIds, sameDpnsName } from '@/lib/view/dpns'
import type { ObjectReader } from '@/lib/view/tree-nav'
import { Author } from '@/components/author'
import { cn } from '@/lib/utils'
import { listOf } from '@/lib/rules/roles'

/** The code owners file at `commitOid`, read through `reader` (null: not yet, or none to read). */
export function useCodeOwners(reader: ObjectReader | null, commitOid: string, readerKey: string): AsyncState<CodeOwnersFile | null> {
  return useAsync(() => readCodeOwners(reader!, commitOid), [commitOid, readerKey], { enabled: reader !== null && commitOid !== '' })
}

/** What the Files tab knows about code owners: the file, and which tokens name the viewer. */
interface CodeOwnersView {
  readonly file: CodeOwnersFile
  readonly mine: (token: string) => boolean
}

const CodeOwnersContext = createContext<CodeOwnersView | null>(null)

/** Whether `token` names the viewer: their identity id, or a name DPNS reads as theirs. */
function namesViewer(token: string, identity: string | null, name: string | null | undefined): boolean {
  if (identity === null) return false
  if (tokenIdentity(token) === identity) return true
  return ownerKind(token) === 'name' && typeof name === 'string' && sameDpnsName(token, name)
}

/** Provide a commit's code owners to the {@link FileOwnersButton}s of a diff. */
export function CodeOwnersProvider({
  reader,
  readerKey,
  commitOid,
  children,
}: {
  reader: ObjectReader | null
  readerKey: string
  commitOid: string
  children: ReactNode
}): JSX.Element {
  const { identity } = useAuth()
  const viewerName = useDpnsName(identity ?? '')
  const { data } = useCodeOwners(reader, commitOid, readerKey)
  const value = useMemo<CodeOwnersView | null>(
    () => (data == null ? null : { file: data, mine: (t) => namesViewer(t, identity, viewerName) }),
    [data, identity, viewerName],
  )
  return <CodeOwnersContext.Provider value={value}>{children}</CodeOwnersContext.Provider>
}

/** A file's owners and the rules that decided them, or null without a code owners file or owners. */
export function useFileOwners(path: string): { readonly tokens: readonly string[]; readonly lines: readonly number[]; readonly file: string; readonly mine: boolean } | null {
  const view = useContext(CodeOwnersContext)
  return useMemo(() => {
    if (view === null) return null
    const rules = decidingRules(view.file.owners, path)
    const tokens = [...new Set(rules.flatMap((r) => r.owners))]
    if (tokens.length === 0) return null
    return { tokens, lines: rules.filter((r) => r.owners.length > 0).map((r) => r.line), file: view.file.path, mine: tokens.some(view.mine) }
  }, [view, path])
}

/** One owner token, linked to its profile when it names an identity or a DPNS name. */
function OwnerToken({ token }: { token: string }): JSX.Element {
  const kind = ownerKind(token)
  // An identity id reads as its DPNS name (or an abbreviation), as everywhere else.
  const id = kind === 'identity' ? tokenIdentity(token) : null
  if (id !== null) return <Author identityId={id} />
  if (kind !== 'name') return <span className="font-mono">{token}</span>
  return (
    <Link href={`/u?name=${encodeURIComponent(token.slice(1))}`} className="font-mono text-forge-700 underline-offset-2 hover:underline dark:text-forge-400">
      {token}
    </Link>
  )
}

/**
 * The shield in a file's diff header: filled when the viewer owns the file. It toggles a line
 * under the header naming the owners and the rule (a tooltip alone would be unreachable on touch).
 */
export function FileOwnersButton({ path, open, onToggle }: { path: string; open: boolean; onToggle: () => void }): JSX.Element | null {
  const owners = useFileOwners(path)
  if (owners === null) return null
  const label = owners.mine ? `You own this file (${owners.file})` : `Owned by ${listOf(owners.tokens, 'and')} (${owners.file})`
  const Icon = owners.mine ? ShieldCheck : Shield
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      title={label}
      onClick={onToggle}
      data-testid="file-owners"
      className={cn(
        'shrink-0 rounded p-0.5 hover:bg-anvil-200 coarse:p-3 dark:hover:bg-anvil-800',
        owners.mine ? 'text-forge-700 dark:text-forge-400' : 'text-anvil-600 dark:text-anvil-400',
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  )
}

/** The line {@link FileOwnersButton} opens. */
export function FileOwnersLine({ path }: { path: string }): JSX.Element | null {
  const owners = useFileOwners(path)
  if (owners === null) return null
  return (
    <p className="border-t border-anvil-200 bg-anvil-50 px-3 py-1.5 text-[12px] text-anvil-700 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-300" data-testid="file-owners-line">
      {owners.mine ? 'You own this file. ' : null}
      Owned by{' '}
      {owners.tokens.map((t, i) => (
        <span key={t}>
          {i > 0 ? (i === owners.tokens.length - 1 ? ' and ' : ', ') : null}
          <OwnerToken token={t} />
        </span>
      ))}{' '}
      (from <span className="font-mono">{owners.file}</span> {owners.lines.length === 1 ? 'line' : 'lines'} {owners.lines.join(', ')})
    </p>
  )
}

/** Whom a new PR asks for review on its code owners' behalf, and who is left out. */
export interface OwnerReviewers {
  /** Where the owners came from, or null when the base has no code owners file. */
  readonly file: string | null
  readonly requests: OwnerRequests | null
  readonly loading: boolean
  readonly error: string | null
}

/**
 * The code owner review requests of a new PR whose changes are `changes` (null until the
 * comparison is made; `changesFailed` says why it never will be), compared against base tip
 * `baseOid` read through `reader`. Names resolve through DPNS (one batched read), and only
 * current maintainers and role-1 writers are asked (the members read, session-cached).
 */
export function useOwnerRequests({
  repo,
  reader,
  readerKey,
  baseOid,
  changes,
  changesFailed,
  author,
}: {
  repo: RepoRef
  reader: ObjectReader | null
  readerKey: string
  baseOid: string
  changes: readonly FileChange[] | null
  changesFailed: string | null
  author: string | null
}): OwnerReviewers {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  // Read as soon as there is a reader: a base with a code owners file holds the form until the
  // changed files are listed, so a PR never opens before its owners are known.
  const file = useCodeOwners(author === null ? null : reader, baseOid, readerKey)
  const tokens = useMemo(() => (file.data == null || changes === null ? [] : ownersOfPaths(file.data.owners, changedPaths(changes))), [file.data, changes])
  const requests = useAsync(
    async () => {
      const names = tokens.filter((t) => ownerKind(t) === 'name')
      const [resolved, members] = await Promise.all([resolveDpnsIds(sdk!, names, network), readMembershipsCached(sdk!, repo, network)])
      return codeOwnerRequests(tokens, resolved, new RoleOracle(members), author!)
    },
    [tokens.join('\n'), repo.repoId, network, author ?? ''],
    { enabled: ready && sdk !== null && tokens.length > 0 && author !== null },
  )
  const waitingForChanges = file.data != null && changes === null
  return {
    file: file.data?.path ?? null,
    requests: tokens.length === 0 ? (file.settled && !waitingForChanges ? { request: [], skipped: [] } : null) : requests.data,
    // Until whom to ask is known (the form waits for it, so a PR never opens without them).
    loading: file.loading || (waitingForChanges && changesFailed === null) || (tokens.length > 0 && requests.data === null && requests.error === null),
    error: file.error ?? (waitingForChanges && changesFailed !== null ? `the changed files could not be listed: ${changesFailed}` : null) ?? requests.error,
  }
}

const SKIP_WHY: Readonly<Record<SkipReason, string>> = {
  team: 'teams are not supported',
  email: 'e-mail addresses are not identities',
  role: 'roles are not supported',
  invalid: 'not an owner',
  unresolved: 'no DPNS name or identity',
  author: 'the author',
  notApprover: 'not a maintainer or writer',
  duplicate: 'listed twice',
  cap: 'over the 15-reviewer limit',
}

/**
 * The "Reviewers from code owners" box of "Open a pull request": each owner it will ask, with a
 * checkbox to leave one out, and the owners it cannot ask with the reason.
 */
export function CodeOwnerReviewers({
  owners,
  partial,
  skip,
  onToggle,
}: {
  owners: OwnerReviewers
  /** The comparison stopped before listing every changed file: owners past it are missing. */
  partial: boolean
  /** Owners the author unticked. */
  skip: ReadonlySet<string>
  onToggle: (identity: string, on: boolean) => void
}): JSX.Element | null {
  const [showSkipped, setShowSkipped] = useState(false)
  const { file, requests } = owners
  if (owners.error !== null) {
    return (
      <p role="status" className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="code-owners-error">
        The code owners could not be read ({owners.error}), so none will be asked for review. Request reviewers on the pull request once it is open.
      </p>
    )
  }
  if (owners.loading) {
    return (
      <p role="status" className="text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="code-owners-loading">
        Reading the code owners of these changes…
      </p>
    )
  }
  if (file === null || requests === null || (requests.request.length === 0 && requests.skipped.length === 0)) return null
  return (
    <fieldset className="space-y-1.5 rounded-md border border-anvil-200 px-3 py-2 dark:border-anvil-800" data-testid="code-owner-reviewers">
      <legend className="px-1 text-dense font-medium text-anvil-700 dark:text-anvil-200">Reviewers from code owners</legend>
      {requests.request.length === 0 ? (
        <p className="text-[12px] text-anvil-600 dark:text-anvil-400">
          <span className="font-mono">{file}</span> names owners for these changes, but none can be asked for review.
        </p>
      ) : (
        <>
          <p className="text-[12px] text-anvil-600 dark:text-anvil-400">
            <span className="font-mono">{file}</span> owns files this pull request changes. Each review request is a small extra write after the pull request.
          </p>
          {partial ? (
            <p className="text-[12px] text-caution-700 dark:text-caution-400">
              The diff is too large to list every file, so owners of the files past it are not listed. <code>dg pr create</code> reads them all.
            </p>
          ) : null}
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {requests.request.map((id) => (
              <li key={id}>
                <label className="flex items-center gap-1.5 text-dense coarse:min-h-11">
                  <input type="checkbox" className="h-4 w-4 accent-forge-700" checked={!skip.has(id)} onChange={(e) => onToggle(id, e.target.checked)} data-identity={id} />
                  <Author identityId={id} link={false} />
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {requests.skipped.length > 0 ? (
        <div>
          <button
            type="button"
            aria-expanded={showSkipped}
            onClick={() => setShowSkipped((s) => !s)}
            className="text-[12px] font-medium text-forge-700 underline underline-offset-2 coarse:min-h-11 dark:text-forge-400"
          >
            {showSkipped ? 'Hide' : 'Show'} {requests.skipped.length} not asked
          </button>
          {showSkipped ? (
            <ul className="mt-1 space-y-0.5 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="code-owners-skipped">
              {requests.skipped.map((s) => (
                <li key={`${s.token}:${s.reason}`}>
                  <span className="font-mono">{s.token}</span>: {SKIP_WHY[s.reason]}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  )
}
