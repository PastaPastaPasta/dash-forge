'use client'

/**
 * Commits to a PR's source branch from the browser (review-parity R5 §4.5, M6): the suggestion
 * batch bar ("Apply n suggestions in one commit") and "Update branch", both run as the step list
 * of {@link runBranchCommit}. Only a writer or maintainer of the SOURCE repo can move its branch
 * (usually the PR's author, whose fork it is); everyone else is told so. Public repos only: a
 * private repo's pack must be sealed, which the browser does not do yet.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, GitCommit, Loader2, Minus, X } from 'lucide-react'

import { holdingsOfRole, readConfigBundle, readRoleOracle, repoKey, type PullView, type RepoRef } from '@/lib/repo'
import { readBranchTip } from '@/lib/repo/source-branch'
import { matchesProtected } from '@/lib/rules'
import { previewCreate, sumPreviews } from '@/lib/sdk'
import { unapplicable, applySuggestionCommit, planSuggestion, readTextFile, SuggestionRefused, updateBranchCommit, type BranchCommit, type SuggestionComment } from '@/lib/merge/branch-commit'
import { parseSuggestions } from '@/lib/rules/v2'
import { parseCommit } from '@/lib/view/git-objects'
import type { CommentView } from '@/lib/view'
import type { SuggestionActions } from '@/components/repo/inline-comments'
import { BRANCH_STEPS, BranchStepError, BranchStopped, runKeyedBranchCommit, type BranchRuns, type BranchStepId } from '@/lib/merge/branch-runner'
import { publishMergeIndex } from '@/lib/merge/locator'
import { missingFromClosure } from '@/lib/merge/verify'
import { mergeIdentityValid } from '@/lib/view/prefs'
import { resolveDpnsNames } from '@/lib/view'
import type { ObjectReader } from '@/lib/view'
import { useMergeUpload } from '@/components/repo/merge-upload'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { usePrefs } from '@/hooks/use-prefs'
import { useAuth } from '@/contexts/auth-context'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Button } from '@/components/ui/button'
import { CostPreview } from '@/components/ui/cost-preview'
import { cn } from '@/lib/utils'

type StepState = 'todo' | 'running' | 'done' | 'skipped' | 'failed'

/**
 * Whether the viewer can move the PR's branch in `source`: a maintainer, or a writer when the
 * branch is not protected there (consensus: only a maintainer's `protectedRefUpdate` moves one).
 */
export function useSourceWrite(source: RepoRef | null, refName: string | null): { can: boolean; known: boolean } {
  const { sdk, ready, network } = useSdk()
  const { identity } = useAuth()
  const held = useAsync(
    async () => {
      const [oracle, bundle] = await Promise.all([readRoleOracle(sdk!, source!, network), readConfigBundle(sdk!, source!)])
      const h = holdingsOfRole(oracle.currentRole(identity!))
      const protectedHere = refName !== null && matchesProtected(refName, bundle.config?.protectedPatterns ?? [])
      return h.maintain || (h.write && !protectedHere)
    },
    [ready, source === null ? '' : repoKey(source), identity ?? '', network, refName ?? ''],
    { enabled: ready && sdk !== null && source !== null && identity !== null },
  )
  return { can: held.data === true, known: held.settled }
}

/** What a branch commit costs up front (the pack's storage comes on top). */
export function branchCommitCost(isMember: boolean): ReturnType<typeof sumPreviews> {
  return sumPreviews([previewCreate('packManifest'), previewCreate('refUpdate'), previewCreate(isMember ? 'event' : 'authorEvent')])
}

/** Run a branch commit, showing its steps; `build` makes the commit when clicked. */
export function useBranchCommit({
  repo,
  source,
  pull,
  isMember,
  verifyReader,
  onDone,
}: {
  repo: RepoRef
  source: RepoRef | null
  pull: PullView
  isMember: boolean
  /** The source repo's OWN reader: the pack plus it must hold the new commit's closure. */
  verifyReader: ObjectReader | null
  onDone: (commit: string) => void
}): {
  /**
   * Run `build`'s commit. `key` names the action and its inputs (which suggestions, which base
   * tip, on which head): a retry of the same key resumes the commit that was built, never a
   * rebuilt one (its timestamp would differ), and a different key never resumes it.
   */
  run: (key: string, label: string, build: () => Promise<BranchCommit>) => Promise<void>
  busy: boolean
  view: JSX.Element | null
  uploadDialog: JSX.Element | null
} {
  const { sdk } = useSdk()
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const uploadRepo = source ?? repo
  const { upload, dialog, begin } = useMergeUpload(uploadRepo)
  const [label, setLabel] = useState<string | null>(null)
  const [steps, setSteps] = useState<Partial<Record<BranchStepId | 'build', StepState>>>({})
  const [details, setDetails] = useState<Partial<Record<BranchStepId | 'build', string>>>({})
  // Unfinished runs by action key: kept on a step failure (another action run meanwhile does not
  // drop one), dropped once that action finishes or stops.
  const saved = useRef<BranchRuns>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const run = useCallback(
    async (key: string, what: string, build: () => Promise<BranchCommit>): Promise<void> => {
      if (!sdk || !signer || source === null || pull.sourceRefName === null || busy) return
      if (verifyReader === null) {
        setLabel(what)
        setError("The source repo's objects are still loading; try again in a moment.")
        return
      }
      if (!guard.check(branchCommitCost(isMember), 'core')) return
      setBusy(true)
      setError(null)
      setDone(null)
      setLabel(what)
      begin()
      const refName = pull.sourceRefName
      if (!saved.current.has(key)) {
        setSteps({ build: 'running' })
        setDetails({})
      }
      try {
        const commit = await runKeyedBranchCommit(
          saved.current,
          key,
          build,
          (built) => {
            const intent = `branch:${source.repoId}:${pull.number}:${built.commit}`
            return {
              sdk,
              auth: signer,
              repo,
              source,
              pull: { id: pull.id, number: pull.number, author: pull.author, headOid: pull.headOid, sourceRefName: refName },
              isMember,
              built,
              upload,
              publishIndex:
                upload === null
                  ? null
                  : async (pack, packHash) => {
                      const r = await publishMergeIndex(sdk, signer, source, pack, packHash, upload, `${intent}:index`)
                      return r.kind === 'published' ? `fragment at packRef ${r.packRef}` : `skipped: ${r.reason}`
                    },
              readBranchTip: () => readBranchTip(sdk, source, refName),
              verifyPack: (pack, tip, have) => missingFromClosure(pack, tip, have, verifyReader),
              intent,
            }
          },
          (built) => {
            setSteps({ build: 'done' })
            setDetails({ build: `${built.commit.slice(0, 9)}${built.files.length ? ` · ${built.files.join(', ')}` : ''}` })
          },
          (e) => {
            setSteps((s) => ({ ...s, [e.step]: e.state }))
            if (e.detail) setDetails((d) => ({ ...d, [e.step]: e.detail }))
          },
        )
        setDone(commit.commit)
        onDone(commit.commit)
      } catch (e) {
        if (e instanceof BranchStepError) {
          // What landed so far is kept with the very commit it belongs to: Retry resumes it.
          // A refusal the renew / top-up sheet can fix (the key's budget, the balance) opens it.
          guard.failed(e.failure)
          setSteps((s) => ({ ...s, [e.step]: 'failed' }))
          setError(e.message)
        } else if (e instanceof BranchStopped || e instanceof SuggestionRefused) {
          setSteps((s) => (s.build === 'running' ? { ...s, build: 'failed' } : s))
          setError(e.message)
        } else {
          setSteps((s) => (s.build === 'running' ? { ...s, build: 'failed' } : s))
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        setBusy(false)
      }
    },
    [sdk, signer, source, pull, busy, guard, isMember, begin, repo, upload, onDone, verifyReader],
  )

  const view =
    label === null ? null : (
      <div className="space-y-2" data-testid="branch-commit">
        <ol aria-label={`${label}: steps`} className="space-y-1 rounded-md border border-anvil-200 p-3 dark:border-anvil-800">
          {[{ id: 'build' as const, label: 'Build the commit' }, ...BRANCH_STEPS].map(({ id, label: l }) => {
            const s = steps[id] ?? 'todo'
            return (
              <li key={id} className={cn('flex items-center gap-2 text-dense', s === 'todo' && 'text-anvil-500 dark:text-anvil-400')} data-step={id} data-state={s}>
                <StepIcon state={s} />
                {l}
                {details[id] ? <span className="text-[12px] text-anvil-600 dark:text-anvil-400">({details[id]})</span> : null}
              </li>
            )
          })}
        </ol>
        {error ? (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400">
            {error}
          </p>
        ) : null}
        {done ? (
          <p className="text-dense text-anvil-700 dark:text-anvil-200" role="status">
            <GitCommit className="mr-1 inline h-4 w-4" aria-hidden />
            Committed {done.slice(0, 9)}; the PR follows it.
          </p>
        ) : null}
      </div>
    )
  return { run, busy, view, uploadDialog: dialog }
}

function StepIcon({ state }: { state: StepState }): JSX.Element {
  switch (state) {
    case 'done':
      return <Check className="h-4 w-4 text-verify-700 dark:text-verify-400" aria-hidden />
    case 'running':
      return <Loader2 className="h-4 w-4 animate-spin text-anvil-500 dark:text-anvil-400" aria-hidden />
    case 'skipped':
      return <Minus className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
    case 'failed':
      return <X className="h-4 w-4 text-danger-700 dark:text-danger-400" aria-hidden />
    default:
      return <span className="h-4 w-4 rounded-full border border-anvil-300 dark:border-anvil-700" aria-hidden />
  }
}

/** The merge identity a browser commit is authored with, or null when not set (Settings). */
export function useCommitIdentity(): { name: string; email: string } | null {
  const [prefs] = usePrefs()
  return mergeIdentityValid(prefs) ? { name: prefs.mergeName.trim(), email: prefs.mergeEmail.trim() } : null
}

export function IdentityNote(): JSX.Element {
  return (
    <p className="text-[12px] text-caution-700 dark:text-caution-400">
      A browser commit is authored with your name and email. Set them in{' '}
      <Link href="/settings" className="underline">
        Settings
      </Link>{' '}
      first.
    </p>
  )
}

/** Build the commit applying `comments`' suggestions on the PR head, reviewer names from DPNS. */
export async function buildSuggestionCommit(
  sdk: Parameters<typeof resolveDpnsNames>[0],
  network: Parameters<typeof resolveDpnsNames>[2],
  reader: ObjectReader,
  head: string,
  comments: readonly SuggestionComment[],
  who: { name: string; email: string },
): Promise<BranchCommit> {
  const plans = comments.map((c) => planSuggestion(c, head))
  const reviewers = [...new Set(plans.map((p) => p.reviewer))]
  const names = await resolveDpnsNames(sdk, reviewers, network).catch(() => new Map<string, string | null>())
  const named = new Map<string, string>()
  for (const [id, n] of names) if (n) named.set(id, n)
  return applySuggestionCommit(reader, head, plans, who, named)
}

/** Build the "Update branch" merge commit, or throw why it cannot be made in the browser. */
export async function buildUpdateBranch(reader: ObjectReader, pull: PullView, baseTip: string, who: { name: string; email: string }): Promise<BranchCommit> {
  const out = await updateBranchCommit(reader, pull.headOid, baseTip, pull.baseRefName, pull.sourceRefName ?? '', who)
  switch (out.plan.kind) {
    case 'merge':
      return out.commit as BranchCommit
    case 'up-to-date':
      throw new BranchStopped('The PR branch already contains the base branch; nothing to update.')
    case 'conflict':
      throw new BranchStopped(`Both sides changed the same files${out.plan.paths.length ? ` (${out.plan.paths.slice(0, 5).join(', ')})` : ''}: merge the base with the CLI (\`dg pr checkout\`, merge, push, \`dg pr sync\`).`)
    case 'fast-forward':
      throw new BranchStopped('The PR branch has nothing the base lacks; nothing to update.')
    case 'unrelated':
      throw new BranchStopped('The PR branch and the base share no history.')
  }
}

/** A comment as the suggestion planner reads it. */
function asSuggestion(c: CommentView): SuggestionComment {
  return {
    id: c.id,
    author: c.author,
    body: c.body,
    anchor: c.anchor === null ? {} : { path: c.anchor.path, line: c.anchor.line, startLine: c.anchor.startLine, side: c.anchor.side, commitOid: c.anchor.commitOid },
  }
}

/** The cost line under a branch commit button. */
export function BranchCommitCost({ isMember, storage }: { isMember: boolean; storage: string }): JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-2 text-[12px] text-anvil-600 dark:text-anvil-400">
      <CostPreview cost={branchCommitCost(isMember)} />
      plus the pack&apos;s storage{storage ? ` on ${storage}` : ''}
    </span>
  )
}

/**
 * Everything the PR page needs for suggestions and "Update branch": the head's text of every file
 * a suggestion names (the diff's removed lines), the batch, applied markers (from the PR's
 * commits), and the runner. `commitsOf` is the PR's commit list (for `Forge-Suggestion:`).
 */
export function useSuggestions({
  repo,
  source,
  pull,
  comments,
  headReader,
  headOnly,
  applied,
  isMember,
  isAuthor,
  signedIn,
  onCommitted,
}: {
  repo: RepoRef
  source: RepoRef | null
  pull: PullView
  comments: readonly CommentView[]
  headReader: ObjectReader | null
  /** The source repo's own reader (proves a branch commit's pack complete). */
  headOnly: ObjectReader | null
  applied: ReadonlyMap<string, string>
  isMember: boolean
  isAuthor: boolean
  signedIn: boolean
  onCommitted: (commit: string) => void
}): {
  actions: SuggestionActions
  bar: JSX.Element | null
  runner: ReturnType<typeof useBranchCommit>
  /**
   * The viewer can move the PR's branch AND its head: write access to the source branch, and
   * the PR's author or a base-repo member (the head update's route; dg's `head_route`).
   */
  write: { can: boolean; known: boolean }
  who: { name: string; email: string } | null
} {
  const { sdk, network } = useSdk()
  const [batch, setBatch] = useState<ReadonlySet<string>>(new Set())
  const who = useCommitIdentity()
  const branchWrite = useSourceWrite(pull.state.open ? source ?? (pull.sourceId === repo.repoId ? repo : null) : null, pull.sourceRefName)
  const headRoute = isAuthor || isMember
  const write = { can: branchWrite.can && headRoute, known: branchWrite.known }
  const target = source ?? (pull.sourceId === repo.repoId ? repo : null)
  const runner = useBranchCommit({ repo, source: target, pull, isMember, verifyReader: headOnly, onDone: (c) => {
    setBatch(new Set())
    onCommitted(c)
  } })
  const suggestive = useMemo(() => comments.filter((c) => c.anchor !== null && parseSuggestions(c.body).length > 0), [comments])
  // The head's text of every file a suggestion names (for the removed lines of each diff).
  const paths = useMemo(() => [...new Set(suggestive.flatMap((c) => (c.anchor ? [c.anchor.path] : [])))].sort(), [suggestive])
  const texts = useAsync(
    async () => {
      const root = parseCommit((await headReader!.readObject(pull.headOid)).bytes).tree
      const out = new Map<string, string | null>()
      for (const p of paths) out.set(p, await readTextFile(headReader!, root, p).catch(() => null))
      return out
    },
    [pull.headOid, paths.join('\n'), headReader === null],
    { enabled: headReader !== null && paths.length > 0 },
  )
  const texts_ = texts.data
  const privateRepo = repo.visibility === 'private' || target?.visibility === 'private'
  const why = !signedIn
    ? 'Sign in to apply suggestions.'
    : privateRepo
      ? 'In a private repo, apply suggestions with `dg pr suggestion apply`.'
      : !pull.state.open
        ? null
        : write.known && !write.can
          ? branchWrite.can
            ? 'Only the PR author or a maintainer or writer of this repo can move the PR head. Copy the suggestion instead.'
            : `Only the PR author (or writers of ${target?.name ?? 'the source repo'}) can apply this. Copy the suggestion instead.`
          : who === null
            ? 'Set your commit name and email in Settings to apply suggestions.'
            : null
  const canApply = signedIn && !privateRepo && pull.state.open && write.can && who !== null && headReader !== null && headOnly !== null && !runner.busy
  // Apply reads the latest reader, identity and suggestions through a ref: the actions object
  // below stays the same between renders unless what it shows changes (the diff's lines are
  // re-rendered only then).
  const applyRef = useRef<(ids: readonly string[]) => void>(() => undefined)
  applyRef.current = (ids) => {
    if (headReader === null || who === null || sdk === null) return
    const chosen = suggestive.filter((c) => ids.includes(c.id)).map(asSuggestion)
    const key = `suggest:${pull.headOid}:${chosen.map((c) => c.id).sort().join(',')}`
    void runner.run(key, `Apply ${chosen.length} suggestion${chosen.length === 1 ? '' : 's'}`, () => buildSuggestionCommit(sdk, network, headReader, pull.headOid, chosen, who))
  }
  const headOid = pull.headOid
  const actions = useMemo<SuggestionActions>(
    () => ({
      canApply,
      why,
      original: (c) => {
        const a = c.anchor
        if (a === null || a.line === null || a.side !== 1 || a.commitOid.toLowerCase() !== headOid.toLowerCase()) return null
        const text = texts_?.get(a.path)
        if (typeof text !== 'string') return null
        const lines = text.replace(/\r\n/g, '\n').split('\n')
        const start = a.startLine ?? a.line
        return start >= 1 && a.line <= lines.length ? lines.slice(start - 1, a.line) : null
      },
      unapplicable: (c) => unapplicable(asSuggestion(c), headOid),
      applied,
      batch,
      onToggleBatch: (c) =>
        setBatch((b) => {
          const next = new Set(b)
          if (next.has(c.id)) next.delete(c.id)
          else next.add(c.id)
          return next
        }),
      onApply: (c) => applyRef.current([c.id]),
    }),
    [canApply, why, headOid, texts_, applied, batch],
  )
  const apply = (ids: readonly string[]): void => applyRef.current(ids)
  const bar =
    batch.size === 0 ? null : (
      <div className="sticky bottom-3 z-20 flex flex-wrap items-center gap-3 rounded-lg border border-forge-500/50 bg-white px-4 py-2 shadow-lg dark:bg-anvil-950" data-testid="suggestion-batch">
        <span className="text-dense font-medium">
          {batch.size} suggestion{batch.size === 1 ? '' : 's'} in the batch
        </span>
        <BranchCommitCost isMember={isMember} storage="" />
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setBatch(new Set())}>
          Clear
        </Button>
        <Button size="sm" variant="primary" onClick={() => apply([...batch])} loading={runner.busy} disabled={!canApply}>
          Apply {batch.size} suggestion{batch.size === 1 ? '' : 's'} in one commit
        </Button>
      </div>
    )
  return { actions, bar, runner, write, who }
}
