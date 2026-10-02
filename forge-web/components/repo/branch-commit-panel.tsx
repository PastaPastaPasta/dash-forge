'use client'

/**
 * Commits to a PR's source branch from the browser (review-parity R5 §4.5, M6): the suggestion
 * batch bar ("Apply n suggestions in one commit") and "Update branch", both run as the step list
 * of {@link runBranchCommit}. Only a writer or maintainer of the SOURCE repo can move its branch
 * (usually the PR's author, whose fork it is); everyone else is told so. Public repos only: a
 * private repo's pack must be sealed, which the browser does not do yet.
 *
 * A run shows where it was started (QW-007): a single suggestion's under that comment (through
 * {@link BranchRunContext}), the batch's in the batch bar, "Update branch"'s beside its row. In a
 * tab resumed after a reload, stored storage settings are sealed: the run asks for the in-page
 * unlock there and goes on once they open.
 */

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { GitCommit } from 'lucide-react'

import { capabilitiesOf } from '@/lib/rules/roles'
import { holdingsOfRole, readConfigBundle, readRoleOracle, repoKey, type PullView, type RepoRef } from '@/lib/repo'
import { readBranchTip } from '@/lib/repo/source-branch'
import { matchesProtected } from '@/lib/rules'
import { EXISTING, previewCreate, sumPreviews } from '@/lib/sdk'
import { unapplicable, applySuggestionCommit, planSuggestion, readTextFile, SuggestionRefused, updateBranchCommit, type BranchCommit, type SuggestionComment } from '@/lib/merge/branch-commit'
import { parseSuggestions } from '@/lib/rules/v2'
import { parseCommit } from '@/lib/view/git-objects'
import type { CommentView } from '@/lib/view'
import type { DraftComment } from '@/lib/repo'
import { linesAt } from '@/lib/view/suggest-block'
import type { SuggestionActions } from '@/components/repo/inline-comments'
import { BRANCH_STEPS, BranchStepError, BranchStopped, runKeyedBranchCommit, type BranchRuns, type BranchStepId } from '@/lib/merge/branch-runner'
import { publishMergeIndex } from '@/lib/merge/locator'
import { missingFromClosure } from '@/lib/merge/verify'
import { mergeIdentityValid } from '@/lib/view/prefs'
import { resolveDpnsNames } from '@/lib/view'
import type { ObjectReader } from '@/lib/view'
import { useMergeUpload } from '@/components/repo/merge-upload'
import { StepRow, type StepState } from '@/components/repo/step-list'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { usePrefs } from '@/hooks/use-prefs'
import { useAuth } from '@/contexts/auth-context'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Button } from '@/components/ui/button'
import { CostPreview } from '@/components/ui/cost-preview'
import { UnlockMore } from '@/components/auth/unlock-more'
import { Input } from '@/components/ui/input'
import { spendAction } from '@/lib/spend-toast'


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
      // A triage member or reader cannot push (consensus: `refUpdate` r 1 only).
      return h.maintain || (capabilitiesOf(h.role).canPush && !protectedHere)
    },
    [ready, source === null ? '' : repoKey(source), identity ?? '', network, refName ?? ''],
    { enabled: ready && sdk !== null && source !== null && identity !== null },
  )
  return { can: held.data === true, known: held.settled }
}

/** What a branch commit costs up front (the pack's storage comes on top). */
export function branchCommitCost(isMember: boolean): ReturnType<typeof sumPreviews> {
  // The repo has packs and the PR's branch has updates: neither builds a subtree (QW3-037).
  return sumPreviews([previewCreate('packManifest', {}, EXISTING), previewCreate('refUpdate', {}, EXISTING), previewCreate(isMember ? 'event' : 'authorEvent')])
}

/**
 * Where a run was started, and so where its steps show: "Update branch"'s row, the suggestion
 * batch bar, or one comment's suggestion (`comment:<id>`).
 */
export type BranchRunAt = 'update' | 'batch' | `comment:${string}`

/** One click of an action, on the PR head it was clicked on: Retry, or the unlock, reruns it. */
interface BranchAction {
  readonly key: string
  readonly label: string
  readonly build: () => Promise<BranchCommit>
  readonly at: BranchRunAt
  readonly head: string
}

/**
 * An action waiting for the storage settings: sealed (the unlock asks), or still being read.
 * `go`: it goes on by itself once they open (the unlock here was used, or they were only being
 * read); an unlock made elsewhere on the page waits for "Continue".
 */
interface Waiting {
  readonly action: BranchAction
  readonly go: boolean
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
   * rebuilt one (its timestamp would differ), and a different key never resumes it. `at` is
   * where the run shows.
   */
  run: (key: string, label: string, build: () => Promise<BranchCommit>, at?: BranchRunAt) => Promise<void>
  busy: boolean
  /** Where the last run was started (its `view` belongs there), or null before any. */
  at: BranchRunAt | null
  view: JSX.Element | null
} {
  const { sdk } = useSdk()
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const uploadRepo = source ?? repo
  const { upload, question, questionStep, begin, storageNeedsUnlock, storageError } = useMergeUpload(uploadRepo)
  const [label, setLabel] = useState<string | null>(null)
  const [at, setAt] = useState<BranchRunAt | null>(null)
  const [steps, setSteps] = useState<Partial<Record<BranchStepId | 'build', StepState>>>({})
  const [details, setDetails] = useState<Partial<Record<BranchStepId | 'build', string>>>({})
  // Unfinished runs by action key: kept on a step failure (another action run meanwhile does not
  // drop one), dropped once that action finishes or stops.
  const saved = useRef<BranchRuns>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [waiting, setWaiting] = useState<Waiting | null>(null)
  // The action a step failure stopped: Retry reruns it (its key resumes what landed).
  const [retry, setRetry] = useState<BranchAction | null>(null)
  // The action whose steps are shown: another one starts from an empty list.
  const shown = useRef<string | null>(null)

  const start = useCallback(
    async (action: BranchAction): Promise<void> => {
      if (!sdk || !signer || source === null || pull.sourceRefName === null || busy) return
      const { key, label: what, build, at: where } = action
      setLabel(what)
      setAt(where)
      setRetry(null)
      setError(null)
      setDone(null)
      if (shown.current !== key) {
        setSteps({})
        setDetails({})
        shown.current = key
      }
      setWaiting(null)
      if (action.head.toLowerCase() !== pull.headOid.toLowerCase()) {
        // Retry or the unlock came after the PR head moved: this commit was built on the old head.
        setError(`The PR head moved to ${pull.headOid.slice(0, 9)} since this was started; nothing more was written for it. Start it again on the new head.`)
        return
      }
      if (storageNeedsUnlock) {
        // Storage settings are stored, sealed in this tab (a resumed session): ask for the unlock
        // right here, and go on with this very action once they open.
        setWaiting({ action, go: false })
        return
      }
      if (upload === null) {
        if (storageError !== null) setError(`Your storage settings could not be opened (${storageError}). Fix or discard them in Settings → Storage, then try again.`)
        // Still being read (this page just loaded): goes on once they are.
        else setWaiting({ action, go: true })
        return
      }
      if (verifyReader === null) {
        setError("The source repo's objects are still loading; try again in a moment.")
        return
      }
      if (!guard.check(branchCommitCost(isMember), 'core')) return
      setBusy(true)
      begin()
      const refName = pull.sourceRefName
      try {
        // The commit's pack, ref and event are one action: one toast with their total (QW3-039).
        const commit = await spendAction({ running: `Committing to ${refName}…`, done: `Committed to ${refName}`, failed: `Commit to ${refName} stopped part-way` }, (tag) =>
          runKeyedBranchCommit(
            saved.current,
            key,
            async () => {
              // Runs only when the runner builds (not on a resume).
              setSteps({ build: 'running' })
              setDetails({})
              return build()
            },
            (built) => {
              const intent = `branch:${source.repoId}:${pull.number}:${built.commit}`
              return {
                sdk,
                auth: tag(signer),
                repo,
                source,
                pull: { id: pull.id, number: pull.number, author: pull.author, headOid: pull.headOid, sourceRefName: refName },
                isMember,
                built,
                upload,
                publishIndex: async (pack, packHash) => {
                  const r = await publishMergeIndex(sdk, tag(signer), source, pack, packHash, upload, `${intent}:index`)
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
          ),
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
          setRetry(action)
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
    [sdk, signer, source, pull, busy, guard, isMember, begin, repo, upload, onDone, verifyReader, storageNeedsUnlock, storageError],
  )
  const run = useCallback(
    (key: string, what: string, build: () => Promise<BranchCommit>, where: BranchRunAt = 'update') => start({ key, label: what, build, at: where, head: pull.headOid }),
    [start, pull.headOid],
  )

  // The settings opened (by the unlock here, or once read): the action that waited goes on.
  useEffect(() => {
    if (waiting === null || !waiting.go || storageNeedsUnlock || upload === null) return
    void start(waiting.action)
  }, [waiting, storageNeedsUnlock, upload, start])

  const view = useMemo(() => {
    if (label === null) return null
    const dismiss = (): void => {
      setWaiting(null)
      setLabel(null)
      setAt(null)
      setError(null)
      setDone(null)
      setRetry(null)
    }
    return (
      <div className="space-y-2" data-testid="branch-commit">
        {waiting !== null ? (
          storageNeedsUnlock ? (
            <UnlockMore
              title={`Unlock this tab to use your storage settings. ${label} goes on once they open.`}
              testId="branch-storage-unlock"
              then={() => setWaiting((w) => (w === null ? w : { ...w, go: true }))}
            />
          ) : storageError !== null ? (
            <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400">
              Your storage settings could not be opened ({storageError}). Fix or discard them in{' '}
              <Link href="/settings/storage/" className="underline">
                Settings → Storage
              </Link>
              , then try again.
            </p>
          ) : waiting.go ? (
            <p className="text-dense text-anvil-600 dark:text-anvil-300" role="status">
              Opening your storage settings…
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-dense text-anvil-700 dark:text-anvil-200">
              <span>Your storage settings are open.</span>
              <Button size="sm" variant="primary" onClick={() => void start(waiting.action)}>
                Continue: {label}
              </Button>
            </div>
          )
        ) : (
          <ol aria-label={`${label}: steps`} className="space-y-1 rounded-md border border-anvil-200 p-3 dark:border-anvil-800">
            {[{ id: 'build' as const, label: 'Build the commit' }, ...BRANCH_STEPS].map(({ id, label: l }) => (
              <StepRow key={id} id={id} label={l} state={steps[id] ?? 'todo'} detail={details[id]} question={id === questionStep ? question : null} />
            ))}
          </ol>
        )}
        {error ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400">
            <span className="min-w-0 flex-1">{error}</span>
            {retry !== null && !busy ? (
              <Button size="sm" variant="outline" onClick={() => void start(retry)}>
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}
        {done ? (
          <p className="text-dense text-anvil-700 dark:text-anvil-200" role="status">
            <GitCommit className="mr-1 inline h-4 w-4" aria-hidden />
            Committed {done.slice(0, 9)}; the PR follows it.
          </p>
        ) : null}
        {!busy ? (
          <Button size="sm" variant="ghost" onClick={dismiss}>
            {waiting !== null ? 'Cancel' : 'Dismiss'}
          </Button>
        ) : null}
      </div>
    )
  }, [label, waiting, storageNeedsUnlock, storageError, steps, details, questionStep, question, error, retry, busy, done, start])
  return { run, busy, at, view }
}

/** The run and where it was started: a comment's slot reads it here (the diff does not re-render for it). */
export const BranchRunContext = createContext<{ readonly at: BranchRunAt | null; readonly view: JSX.Element | null }>({ at: null, view: null })

/** The branch-commit run, when it was started at `at`. */
export function BranchRunSlot({ at }: { at: BranchRunAt }): JSX.Element | null {
  const run = useContext(BranchRunContext)
  return run.at === at && run.view !== null ? <div className="mt-2 w-full">{run.view}</div> : null
}

/** The merge identity a browser commit is authored with, or null when not set (Settings). */
export function useCommitIdentity(): { name: string; email: string } | null {
  const [prefs] = usePrefs()
  return mergeIdentityValid(prefs) ? { name: prefs.mergeName.trim(), email: prefs.mergeEmail.trim() } : null
}

/**
 * Where a browser commit needs the viewer's name and email and none are set (QW-065): says so, and
 * opens a form right here (kept in this browser, the same setting as Settings → Diffs and merges),
 * so a batch collected on the page is not lost to a trip to Settings.
 */
export function CommitIdentityPrompt({ what, lead = 'A browser commit is authored with your name and email' }: { what: string; lead?: string }): JSX.Element {
  const [prefs, update] = usePrefs()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(prefs.mergeName)
  const [email, setEmail] = useState(prefs.mergeEmail)
  const id = useId()
  const valid = mergeIdentityValid({ mergeName: name, mergeEmail: email })
  if (!open) {
    return (
      <span className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="commit-identity-prompt">
        {lead}: set them to {what}.{' '}
        <button
          type="button"
          className="font-medium underline"
          onClick={() => {
            setName(prefs.mergeName)
            setEmail(prefs.mergeEmail)
            setOpen(true)
          }}
        >
          Set name and email
        </button>
      </span>
    )
  }
  return (
    <form
      className="w-full space-y-2 rounded-md border border-anvil-200 p-3 dark:border-anvil-750"
      data-testid="commit-identity-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        update({ mergeName: name.trim(), mergeEmail: email.trim() })
        setOpen(false)
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={`${id}-name`} className="grid gap-1 text-[12px] text-anvil-600 dark:text-anvil-300">
          Commit name
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Alice Example" className="h-8 w-48" autoFocus />
        </label>
        <label htmlFor={`${id}-email`} className="grid gap-1 text-[12px] text-anvil-600 dark:text-anvil-300">
          Commit email
          <Input id={`${id}-email`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="alice@example.com" className="h-8 w-56" />
        </label>
        <Button type="submit" size="sm" variant="primary" disabled={!valid}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <p className="text-[11px] text-anvil-500 dark:text-anvil-400">
        Kept in this browser, like git&apos;s user.name and user.email (also in{' '}
        <Link href="/settings/" className="underline">
          Settings
        </Link>{' '}
        → Diffs and merges).
      </p>
    </form>
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
      // The browser never merges a file's contents: no conflict verdict, git may merge it cleanly (QW3-016).
      throw new BranchStopped(`Both sides changed ${out.plan.paths.length ? `the same files (${out.plan.paths.slice(0, 5).join(', ')})` : 'history with more than one merge base'}, which the browser can't merge; git may still merge it cleanly. Update it with the CLI (\`dg pr checkout\`, merge, push, \`dg pr sync\`).`)
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
    // a long comment whose rest could not be read is never applied (forge-v2.md §6.3)
    ...(c.long ? { long: c.long } : {}),
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

const NO_TEXTS: ReadonlyMap<string, string | null> = new Map()

/**
 * The head's text of each of `paths` (null: not a regular text file), read once per path and
 * head: a path added later is read alone, and what was read stays shown meanwhile.
 */
function useHeadTexts(reader: ObjectReader | null, head: string, paths: readonly string[]): ReadonlyMap<string, string | null> {
  const [state, setState] = useState<{ head: string; texts: ReadonlyMap<string, string | null> }>({ head, texts: NO_TEXTS })
  const texts = state.head === head ? state.texts : NO_TEXTS
  const known = useRef(texts)
  known.current = texts
  const readerRef = useRef(reader)
  readerRef.current = reader
  const key = paths.join('\n')
  const hasReader = reader !== null
  useEffect(() => {
    const r = readerRef.current
    const missing = key === '' ? [] : key.split('\n').filter((p) => !known.current.has(p))
    if (r === null || missing.length === 0) return
    let live = true
    void (async () => {
      const root = parseCommit((await r.readObject(head)).bytes).tree
      const got: [string, string | null][] = []
      for (const p of missing) got.push([p, await readTextFile(r, root, p).catch(() => null)])
      if (live) setState((s) => ({ head, texts: new Map([...(s.head === head ? s.texts : NO_TEXTS), ...got]) }))
    })().catch(() => undefined)
    return () => {
      live = false
    }
  }, [head, key, hasReader])
  return texts
}

/**
 * Everything the PR page needs for suggestions and "Update branch": the head's text of every file
 * a suggestion names (the diff's removed lines, for posted and pending comments and the one being
 * written), the batch, applied markers (from the PR's commits), and the runner. `commitsOf` is the
 * PR's commit list (for `Forge-Suggestion:`).
 */
export function useSuggestions({
  repo,
  source,
  pull,
  comments,
  drafts = [],
  headReader,
  headOnly,
  applied,
  isMember,
  isAuthor,
  signedIn,
  branchAhead = false,
  onCommitted,
}: {
  repo: RepoRef
  source: RepoRef | null
  pull: PullView
  comments: readonly CommentView[]
  /** The viewer's pending review comments (their suggestions show as diffs too). */
  drafts?: readonly DraftComment[]
  headReader: ObjectReader | null
  /** The source repo's own reader (proves a branch commit's pack complete). */
  headOnly: ObjectReader | null
  applied: ReadonlyMap<string, string>
  isMember: boolean
  isAuthor: boolean
  signedIn: boolean
  /**
   * The source branch is past the PR head (an interrupted commit moved the branch, not the
   * head): a commit on the head would be refused at its ref update, so none starts (QW2-007).
   */
  branchAhead?: boolean
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
  /** Write access to the source branch alone (deleting it after a merge needs only this). */
  branchWrite: { can: boolean; known: boolean }
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
  // Files a composer asked for (its "Insert a suggestion" and Preview need the lines).
  const [wanted, setWanted] = useState<ReadonlySet<string>>(new Set())
  const want = useCallback((path: string) => setWanted((w) => (w.has(path) ? w : new Set(w).add(path))), [])
  // The head's text of every file a suggestion names (for the removed lines of each diff).
  const paths = useMemo(
    () =>
      [
        ...new Set([
          ...suggestive.flatMap((c) => (c.anchor ? [c.anchor.path] : [])),
          ...drafts.filter((d) => parseSuggestions(d.body).length > 0).map((d) => d.anchor.path),
          ...wanted,
        ]),
      ].sort(),
    [suggestive, drafts, wanted],
  )
  const texts = useHeadTexts(headReader, pull.headOid, paths)
  const privateRepo = repo.visibility === 'private' || target?.visibility === 'private'
  // Why this viewer can never apply here (the commit identity is not such a reason: it is set
  // right beside the Apply button).
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
          : branchAhead
            ? "The branch has moved past this PR's head: update the PR head (above) first."
            : null
  const canApply = signedIn && !privateRepo && pull.state.open && write.can && !branchAhead
  // Apply needs the name and email, the head's objects, and no other commit running.
  const ready = who !== null && headReader !== null && headOnly !== null && !runner.busy
  // Apply reads the latest reader, identity and suggestions through a ref: the actions object
  // below stays the same between renders unless what it shows changes (the diff's lines are
  // re-rendered only then).
  const applyRef = useRef<(ids: readonly string[], at: BranchRunAt) => void>(() => undefined)
  applyRef.current = (ids, at) => {
    if (headReader === null || who === null || sdk === null) return
    const chosen = suggestive.filter((c) => ids.includes(c.id)).map(asSuggestion)
    const key = `suggest:${pull.headOid}:${chosen.map((c) => c.id).sort().join(',')}`
    void runner.run(key, `Apply ${chosen.length} suggestion${chosen.length === 1 ? '' : 's'}`, () => buildSuggestionCommit(sdk, network, headReader, pull.headOid, chosen, who), at)
  }
  const actions = useMemo<SuggestionActions>(
    () => ({
      canApply,
      why,
      needsIdentity: who === null,
      ready,
      original: (a) => linesAt(texts.get(a.path), a, pull.headOid),
      want,
      unapplicable: (c) => unapplicable(asSuggestion(c), pull.headOid),
      applied,
      batch,
      onToggleBatch: (c) =>
        setBatch((b) => {
          const next = new Set(b)
          if (next.has(c.id)) next.delete(c.id)
          else next.add(c.id)
          return next
        }),
      onApply: (c) => applyRef.current([c.id], `comment:${c.id}`),
    }),
    [canApply, why, who, ready, pull.headOid, texts, want, applied, batch],
  )
  // The bar stays while its run is shown (a batch that just landed is empty: its result stays).
  const barRun = runner.at === 'batch' ? runner.view : null
  const bar =
    batch.size === 0 && barRun === null ? null : (
      <div
        className="sticky bottom-3 z-20 max-h-[70vh] space-y-2 overflow-y-auto rounded-lg border border-forge-500/50 bg-white px-4 py-2 shadow-lg dark:bg-anvil-950"
        data-testid="suggestion-batch"
      >
        {barRun}
        {batch.size > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-dense font-medium">
              {batch.size} suggestion{batch.size === 1 ? '' : 's'} in the batch
            </span>
            <BranchCommitCost isMember={isMember} storage="" />
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => setBatch(new Set())} disabled={runner.busy}>
              Clear
            </Button>
            <Button size="sm" variant="primary" onClick={() => applyRef.current([...batch], 'batch')} loading={runner.busy} disabled={!canApply || !ready}>
              Apply {batch.size} suggestion{batch.size === 1 ? '' : 's'} in one commit
            </Button>
            {canApply && who === null ? <CommitIdentityPrompt what="apply the batch" /> : null}
          </div>
        ) : null}
      </div>
    )
  return { actions, bar, runner, write, branchWrite, who }
}
