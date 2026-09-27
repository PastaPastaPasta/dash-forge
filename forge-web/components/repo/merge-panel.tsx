'use client'

/**
 * MergePanel — the browser merge (`ux-dx-spec.md` §5.7), for a PR's maintainers and writers.
 *
 * The button says what it will do, decided in the merge worker before anything is offered:
 * `Merge (fast-forward)`, `Create merge commit and merge` (only when the two sides changed
 * disjoint paths; file contents are never merged in the browser), or a disabled
 * `Conflicts or overlapping changes — merge with \`dg pr merge\`` with the `dg pr checkout`
 * line. A writer on a
 * protected base branch sees `Protected branch — maintainers only`; a narrow screen, "Use a
 * desktop browser for this step". The click runs the step list (fetch → merge → build and
 * verify the pack → upload → packManifest → browse index → ref update → merge event), and a
 * failure names what already exists and offers to resume.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, GitMerge, Loader2, Minus, X } from 'lucide-react'

import { readConfigHistory, refNameHash, resolveRefByHash, type PullView, type RepoRef } from '@/lib/repo'
import { isLegalRefName, matchesProtected } from '@/lib/rules'
import { bytesToBase64, previewCreate, sumPreviews } from '@/lib/sdk'
import { mergeReaders, missingFromClosure } from '@/lib/merge/verify'
import type { MergeCheck, MergeInput } from '@/lib/merge/engine'
import { checkMergeInWorker, runMergeInWorker } from '@/lib/merge/client'
import { MERGE_STEPS, MergeStepError, retryLabel, runFor, runMergeSteps, type MergeRun, type MergeStepId } from '@/lib/merge/runner'
import { mergeButton, mergeRefProblem } from '@/lib/view/pull-actions'
import { publishMergeIndex } from '@/lib/merge/locator'
import { useMergeUpload } from '@/components/repo/merge-upload'
import { mergeIdentityValid } from '@/lib/view/prefs'
import { tipOidOf, type DiffSides, type ObjectReader } from '@/lib/view'
import { useSdk } from '@/hooks/use-sdk'
import { useMinWidth, usePrefs } from '@/hooks/use-prefs'
import { useAuth } from '@/contexts/auth-context'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Button } from '@/components/ui/button'
import { CopyRow } from '@/components/ui/copy-row'
import { CostPreview } from '@/components/ui/cost-preview'
import { Oid } from '@/components/ui/oid'
import { cn } from '@/lib/utils'

type StepState = 'todo' | 'running' | 'done' | 'skipped' | 'failed'

export function MergePanel({
  repo,
  pull,
  sides,
  baseOnly,
  sidesKey,
  baseTipOid,
  protectedPatterns,
  canMerge,
  isMaintainer,
  checkout,
  onMerged,
}: {
  repo: RepoRef
  pull: PullView
  sides: DiffSides | null
  /** The base repo's own reader (never the fork's); null until it loads. */
  baseOnly: ObjectReader | null
  sidesKey: string
  baseTipOid: string
  protectedPatterns: readonly string[]
  canMerge: boolean
  isMaintainer: boolean
  checkout: string
  onMerged: () => void
}): JSX.Element | null {
  const { sdk } = useSdk()
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const [prefs] = usePrefs()
  const wide = useMinWidth(1024)
  const { upload, dialog: uploadDialog, storageLabel, begin } = useMergeUpload(repo)
  const baseRefName = pull.state.baseRef ?? pull.baseRefName
  const baseProtected = matchesProtected(baseRefName, protectedPatterns)
  const refProblem = mergeRefProblem(baseRefName, baseTipOid, pull.headOid)
  // Merge reads prefer the head's repo and fall back to the base repo's own reader; they never
  // run until that base reader exists, so nothing about the base is taken from the fork.
  const readers = useMemo(() => mergeReaders(baseOnly, sides?.head ?? null), [sides, baseOnly])
  const reader = readers?.merge ?? null
  const sameRepo = pull.sourceId === '' || pull.sourceId === repo.repoId

  const input = useMemo<MergeInput>(
    () => ({
      baseTip: baseTipOid,
      headOid: pull.headOid,
      prNumber: pull.number,
      // The PR author wrote `sourceRefName`: only a legal ref name goes into the message.
      sourceLabel: pull.sourceRefName !== null && isLegalRefName(pull.sourceRefName) ? pull.sourceRefName : pull.headOid,
      title: pull.title,
      author: { name: prefs.mergeName.trim(), email: prefs.mergeEmail.trim() },
      headInBase: sameRepo,
    }),
    [baseTipOid, pull.headOid, pull.number, pull.sourceRefName, pull.title, prefs.mergeName, prefs.mergeEmail, sameRepo],
  )

  // The worker's verdict. Each check owns its worker and aborts it when superseded or
  // unmounted, so a stale check never keeps reading objects.
  const [check, setCheck] = useState<MergeCheck | { error: string } | null>(null)
  const checkable = canMerge && repo.visibility === 'public' && refProblem === null && reader !== null && wide
  // The check reads the latest input without re-running when only the merger's name changes.
  const inputRef = useRef(input)
  inputRef.current = input
  useEffect(() => {
    if (!checkable || reader === null) return
    const abort = new AbortController()
    setCheck(null)
    // The check needs a name for the trial merge commit; the real one is written on click.
    checkMergeInWorker(reader, { ...inputRef.current, author: { name: 'check', email: 'check@forge' } }, abort.signal).then(
      (c) => {
        if (!abort.signal.aborted) setCheck(c)
      },
      (e: unknown) => {
        if (!abort.signal.aborted) setCheck({ error: e instanceof Error ? e.message : String(e) })
      },
    )
    return () => abort.abort()
  }, [checkable, reader, sidesKey, baseTipOid, pull.headOid])
  const button = mergeButton({
    canMerge,
    isPublic: repo.visibility === 'public',
    refProblem,
    baseLoaded: baseOnly !== null,
    isMaintainer,
    baseProtected,
    narrow: !wide,
    check,
    checkout,
  })

  const [steps, setSteps] = useState<Partial<Record<MergeStepId, StepState>>>({})
  const [details, setDetails] = useState<Partial<Record<MergeStepId, string>>>({})
  // Kept across retries of the same base tip and head only (`runFor` drops a stale one).
  const [savedRun, setRun] = useState<MergeRun | null>(null)
  const run = runFor(savedRun, input)
  const [failure, setFailure] = useState<{ step: MergeStepId; message: string } | null>(null)
  const [stopped, setStopped] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newTip, setNewTip] = useState<string | null>(null)

  // Upload estimate unknown until the pack exists; the documents are known.
  const cost = sumPreviews([previewCreate('packManifest'), previewCreate(baseProtected ? 'protectedRefUpdate' : 'refUpdate'), previewCreate('event')])
  // Only a merge commit is authored; a fast-forward writes no commit.
  const identityOk = button.kind !== 'merge-commit' || mergeIdentityValid(prefs)

  const start = useCallback(async () => {
    if (!sdk || !signer || reader === null || baseOnly === null || busy || refProblem !== null) return
    if (!guard.check(cost.credits)) return
    setBusy(true)
    setFailure(null)
    setStopped(null)
    begin()
    const intent = `merge:${repo.repoId}:${pull.number}:${pull.headOid}:${baseTipOid}`
    try {
      const done = await runMergeSteps(
        {
          sdk,
          auth: signer,
          repo,
          pull: { id: pull.id, number: pull.number, baseRefName },
          input,
          merge: (i, onPhase) => runMergeInWorker(reader, i, (p) => onPhase(p.phase)),
          upload,
          publishIndex: upload === null ? null : async (pack, packHash) => {
            const r = await publishMergeIndex(sdk, signer, repo, pack, packHash, upload, `${intent}:index`)
            return r.kind === 'published' ? `fragment at packRef ${r.packRef}` : `skipped: ${r.reason}`
          },
          verifyPack: (pack, tip) => missingFromClosure(pack, tip, input.baseTip, (readers ?? { base: baseOnly }).base),
          readBaseTip: async () => {
            // The same rule the page's tip came from (resolveRef, then the provisional tip).
            const ref = await resolveRefByHash(sdk, repo, bytesToBase64(refNameHash(baseRefName)), await readConfigHistory(sdk, repo))
            return tipOidOf(ref ?? undefined) ?? ''
          },
          intent,
        },
        run,
        (e) => {
          setSteps((s) => ({ ...s, [e.step]: e.state }))
          if (e.detail) setDetails((d) => ({ ...d, [e.step]: e.detail }))
        },
      )
      setRun(done)
      setNewTip(done.result?.newTip ?? null)
      onMerged()
    } catch (e) {
      if (e instanceof MergeStepError) {
        setRun(e.run)
        setSteps((s) => ({ ...s, [e.step]: 'failed' }))
        setFailure({ step: e.step, message: e.message })
      } else {
        setStopped(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setBusy(false)
    }
  }, [sdk, signer, reader, readers, baseOnly, refProblem, busy, guard, cost.credits, repo, pull.id, pull.number, pull.headOid, baseRefName, input, run, baseTipOid, onMerged, upload, begin])

  if (button.kind === 'hidden') return null
  const started = Object.keys(steps).length > 0

  return (
    <section aria-label="Merge" data-testid="merge-panel" className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
      <div className="flex flex-wrap items-center gap-3">
        <GitMerge className="h-4 w-4 text-anvil-400" aria-hidden />
        <span className="text-dense text-anvil-700 dark:text-anvil-200">
          Into <span className="font-mono">{baseRefName.replace(/^refs\/heads\//, '')}</span>
          {baseTipOid ? (
            <>
              {' '}
              at <Oid value={baseTipOid} chars={7} copyable={false} />
            </>
          ) : null}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2" data-testid="merge-button-state" data-state={button.kind}>
          {button.kind === 'checking' ? (
            <Button disabled>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Checking the merge…
            </Button>
          ) : button.kind === 'fast-forward' || button.kind === 'merge-commit' ? (
            <Button variant="primary" onClick={start} loading={busy} disabled={!identityOk || busy || newTip !== null || guard.disabledReason !== null}>
              {failure ? retryLabel(failure.step) : button.label}
            </Button>
          ) : button.kind === 'unavailable' ? (
            <span className="text-dense text-anvil-600 dark:text-anvil-400">{button.reason}</span>
          ) : (
            <Button disabled>{button.label}</Button>
          )}
        </div>
      </div>

      {button.kind === 'conflicts' ? (
        <div className="mt-3">
          <p className="mb-1.5 text-[12px] text-anvil-600 dark:text-anvil-400">Both sides changed the same files or folders. Check the PR out, merge it with the CLI, and push:</p>
          <CopyRow text={button.checkout} />
        </div>
      ) : null}
      {(button.kind === 'fast-forward' || button.kind === 'merge-commit') && !identityOk ? (
        <p className="mt-2 text-[12px] text-caution-700 dark:text-caution">
          A browser merge commit is authored with your name and email. Set them in{' '}
          <Link href="/settings" className="underline">
            Settings
          </Link>{' '}
          first.
        </p>
      ) : null}
      {button.kind === 'fast-forward' || button.kind === 'merge-commit' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-anvil-600 dark:text-anvil-400">
          <CostPreview cost={cost} />
          <span>
            plus the pack&apos;s storage{storageLabel ? ` on ${storageLabel}` : ''}
          </span>
        </div>
      ) : null}

      {started ? (
        <ol aria-label="Merge steps" className="mt-3 space-y-1 rounded-md border border-anvil-200 p-3 dark:border-anvil-800">
          {MERGE_STEPS.map(({ id, label }) => {
            const s = steps[id] ?? 'todo'
            return (
              <li key={id} className={cn('flex items-center gap-2 text-dense', s === 'todo' && 'text-anvil-500 dark:text-anvil-400')} data-step={id} data-state={s}>
                <StepIcon state={s} />
                {label}
                {details[id] ? <span className="text-[12px] text-anvil-600 dark:text-anvil-400">({details[id]})</span> : null}
              </li>
            )
          })}
        </ol>
      ) : null}
      {failure ? (
        <p role="alert" className="mt-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400">
          {failure.message}
        </p>
      ) : null}
      {stopped ? (
        <p role="alert" className="mt-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200">
          Merge stopped: {stopped}
        </p>
      ) : null}
      {newTip ? (
        <p className="mt-2 text-dense text-anvil-700 dark:text-anvil-200">
          Base branch moved to <Oid value={newTip} chars={9} />. The PR shows as merged once the fold sees the merge event.
        </p>
      ) : null}
      {uploadDialog}
    </section>
  )
}

function StepIcon({ state }: { state: StepState }): JSX.Element {
  switch (state) {
    case 'done':
      return <Check className="h-4 w-4 text-verify" aria-hidden />
    case 'running':
      return <Loader2 className="h-4 w-4 animate-spin text-anvil-400" aria-hidden />
    case 'skipped':
      return <Minus className="h-4 w-4 text-anvil-400" aria-hidden />
    case 'failed':
      return <X className="h-4 w-4 text-danger" aria-hidden />
    default:
      return <span className="h-4 w-4 rounded-full border border-anvil-300 dark:border-anvil-700" aria-hidden />
  }
}
