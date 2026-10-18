'use client'

/**
 * Settings → Danger zone → "Make this repo public" (mixed-visibility DESIGN §10, §4.10; the engine
 * is `lib/repo/make-public*.ts`, the copy `lib/view/make-repo-public.ts`):
 *
 * - **The row**, for a private repo: the owner's "Make public…" (disabled, with the reason, on a
 *   network whose Forge can't make a private repository public), or for a maintainer "Only the
 *   owner (@carol) can make this repo public." Nobody else sees it. For a repo made public with
 *   Code only, its owner's "Make everything public…": the same dialog with Everything fixed.
 * - **The dialog**: the check (seconds to minutes; its phases shown, Cancel aborts it), the two
 *   modes with nothing chosen, Code only's branches and tags, what Everything makes public, the
 *   scan with a "Publish anyway" box per finding that needs one, what blocks a mode, what stays
 *   private, the cost, and the typed words. Make public turns it into the step list.
 * - **Interrupted**: a run that stopped (flipped and unfinished, or this browser's record of one
 *   that stopped before the flip) shows a panel here, at `#danger`, with Finish (any maintainer
 *   after the flip; the history step stays the owner's) and the `dg … --resume` alternative. A run
 *   recorded here whose own key change another rotation followed can't be finished: the panel says
 *   so and offers the owner Start again (a new run, the typed words asked) and `dg … --start-over`.
 *
 * Closing the dialog mid-run aborts between steps; what landed stays, and the panel offers Finish
 * once the step under way settles (`make-public-inflight.ts`: never two runs side by side).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, Check, CirclePause, Globe, Loader2, Minus, X } from 'lucide-react'

import type { RepoHome } from '@/lib/view'
import { aboutDash } from '@/lib/view/audience'
import { repoContractIds } from '@/lib/repo'
import { contractVisibilityOneWay } from '@/lib/repo/contract-shape'
import { forgetConversionProgress, stalledText, stepStalled } from '@/lib/repo/conversion-status'
import {
  COPY,
  MAKE_PUBLIC_STEPS,
  MAKE_PUBLIC_WORDS,
  MakePublicError,
  START_OVER_WORDS,
  gateMakePublic,
  secretsOf,
  uniqueSecrets,
  type MakePublicCheck,
  type MakePublicMode,
  type MakePublicRef,
  type MakePublicSecret,
  type MakePublicStatus,
  type MakePublicStep,
  type StepState,
} from '@/lib/repo/make-public'
import { makePublicCheck, publicViewOf, type PackCache } from '@/lib/repo/make-public-check'
import { beginMakePublicRun, makePublicInFlight, subscribeMakePublicRuns } from '@/lib/repo/make-public-inflight'
import { runMakePublic, type MakePublicOutcome } from '@/lib/repo/make-public-run'
import { readMakePublicStatus } from '@/lib/repo/make-public-status'
import { invalidatePrivateSession } from '@/lib/repo/private-session'
import { shortRef } from '@/lib/repo/ref-admin'
import {
  CODE_ONLY_STAYS,
  EVERYTHING_LATER_FIRST_LINE,
  EVERYTHING_LATER_TEXT,
  EVERYTHING_LATER_TITLE,
  EVERYTHING_RELEASES,
  EVERYTHING_TEXT,
  KEEPS_WORKING,
  MAKE_PUBLIC_FIRST_LINE,
  MODE_LABEL,
  NO_REFS_CHOSEN,
  OTHERS_SHOWN,
  STEP_LABEL,
  STILL_WORKING,
  costLine,
  defaultGroupLabel,
  doneButHistoryLine,
  doneLine,
  everythingLaterTitle,
  everythingThatIs,
  interruptedLine,
  noSecretsLine,
  notPublishedLine,
  oldClientsLine,
  oldFormatFix,
  oldFormatLine,
  othersLabel,
  ownerHistoryLine,
  ownerOnlyLine,
  progressLine,
  refChoices,
  resumeCommand,
  runErrorText,
  startOverCommand,
  secretLine,
  staysPrivateLine,
  unreadLine,
  wordsLine,
  type MakePublicRow,
} from '@/lib/view/make-repo-public'
import { madePublic } from '@/components/repo/conversion-status'
import { useMergeUpload } from '@/components/repo/merge-upload'
import { EncryptionKeyLockedError } from '@/lib/auth/vault'
import { PublicationEncryptionUnlock } from '@/components/repo/publication-encryption-unlock'
import { UnlockMore } from '@/components/auth/unlock-more'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { useSettledDpnsName } from '@/hooks/use-dpns-name'
import { usePrivateWrite } from '@/hooks/use-private-write'
import { BetaBadge } from '@/components/ui/beta-badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollRegion } from '@/components/ui/scroll-region'
import type { Network } from '@/lib/constants'
import { isAbort } from '@/lib/sdk/facade'
import { cn, shortId } from '@/lib/utils'

// ---------------------------------------------------------------------------------------------
// The Danger zone part
// ---------------------------------------------------------------------------------------------

/** What the dialog starts with. */
type Start =
  /**
   * The owner makes a private repo public: the check, then the choice (`startOver`: in place of this
   * browser's recorded run, which can't be finished).
   */
  | { readonly kind: 'new'; readonly startOver?: { readonly at: number | null; readonly mode: MakePublicMode } }
  /** Finish a run this browser has no record of: the check, then a choice limited to `allowed`. */
  | { readonly kind: 'choose'; readonly allowed: Readonly<Record<MakePublicMode, boolean>> }
  /** Finish the run this browser recorded: straight to the steps. */
  | { readonly kind: 'resume'; readonly mode: MakePublicMode; readonly steps: Readonly<Record<MakePublicStep, StepState>> }
  /** The owner publishes the rest of a repo made public with Code only: the check, Everything fixed. */
  | { readonly kind: 'everything' }

/** Whether a run on the repo is in flight in this tab (its dialog may be closed: the step under way still signs). */
function useRunInFlight(network: Network, repoId: string): boolean {
  return useSyncExternalStore(subscribeMakePublicRuns, () => makePublicInFlight(network, repoId), () => false)
}

/** Whether `s` says a run stopped part way: flipped and unfinished, or recorded here before the flip. */
function interruptedStatus(s: MakePublicStatus | null): s is MakePublicStatus {
  return s !== null && (s.phase === 'made' || (s.phase === 'private' && (s.record !== null || s.sealOffMarker !== undefined)))
}

export function MakeRepoPublic({ home, maintainer, onSaved }: { home: RepoHome; maintainer: boolean; onSaved: () => void }): JSX.Element | null {
  const repo = home.repo
  const { identity } = useAuth()
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const isOwner = identity !== null && identity === repo.ownerId
  const isPrivate = repo.visibility === 'private'
  const converted = madePublic(home)
  const relevant = (isPrivate || converted) && (maintainer || isOwner)
  const status = useAsync(
    () => readMakePublicStatus(sdk!, repo, network, identity),
    [ready, repo.repoId, repo.visibility, network, identity ?? '', repo.session?.id ?? repo.lane?.id ?? ''],
    { enabled: relevant && ready && sdk !== null },
  )
  const oneWay = useAsync(() => contractVisibilityOneWay(sdk!, repo.forge.core), [ready, repo.forge.core], {
    enabled: relevant && isPrivate && isOwner && ready && sdk !== null,
  })
  // undefined while the owner's name is read: the dialog waits for it, as the words are typed against it
  const ownerName = useSettledDpnsName(repo.ownerId)
  const labelReady = ownerName !== undefined
  const liveLabel = `${ownerName ?? repo.ownerId}/${repo.name}`
  const [dialog, setDialog] = useState<{ readonly start: Start; readonly label: string } | null>(null)
  const dialogOpen = useRef(false)
  // Kept as it was when the dialog opened.
  const open = (start: Start): void => {
    dialogOpen.current = true
    setDialog({ start, label: liveLabel })
  }
  // A settled run can observe newer keys even when it refused before writing. Refresh the page's
  // member session once the dialog closes, or once a run finishes after its dialog closed.
  const refreshPending = useRef(false)
  const refreshIfNeeded = (): void => {
    if (!refreshPending.current) return
    refreshPending.current = false
    onSaved()
  }
  const st = status.data
  const interrupted = interruptedStatus(st)
  const inFlight = useRunInFlight(network, repo.repoId)

  const panel = (() => {
    if (!relevant) return null
    if (interrupted) {
      return <InterruptedPanel status={st} label={liveLabel} labelReady={labelReady} isOwner={isOwner} inFlight={inFlight} onFinish={open} />
    }
    if (!isPrivate) {
      // made public with Code only and finished: its owner may publish the rest
      // (`st` is narrowed away by the interrupted check above)
      const now = status.data
      const codeOnlyDone = converted && now !== null && now.converted && now.phase === 'public' && now.mode !== 'everything'
      if (!isOwner || !codeOnlyDone) return null
      return (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 p-4" data-testid="make-public-everything-row">
          <div className="min-w-0 flex-1">
            <p className="text-dense font-medium">
              {EVERYTHING_LATER_TITLE} <BetaBadge feature="makeRepoPublic" />
            </p>
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{EVERYTHING_LATER_TEXT}</p>
          </div>
          <Button variant="danger" disabled={inFlight || !labelReady} onClick={() => open({ kind: 'everything' })} data-testid="make-public-everything-open">
            Make everything public…
          </Button>
        </div>
      )
    }
    let rowText = "Choose what everyone can see: the code only, or everything. It can't be undone."
    if (!isOwner) rowText = ownerOnlyLine(ownerName ? `@${ownerName}` : shortId(repo.ownerId))
    else if (oneWay.data === false) rowText = COPY.frozen
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 p-4" data-testid="make-public-row">
        <div className="min-w-0 flex-1">
          <p className="text-dense font-medium">
            Make this repo public <BetaBadge feature="makeRepoPublic" />
          </p>
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{rowText}</p>
        </div>
        {isOwner ? (
          <Button
            variant="danger"
            disabled={oneWay.data === false || !oneWay.settled || !status.settled || !labelReady || inFlight}
            onClick={() => open({ kind: 'new' })}
            data-testid="make-public-open"
          >
            Make public…
          </Button>
        ) : null}
      </div>
    )
  })()

  return (
    <>
      {panel}
      {dialog !== null ? (
        <MakePublicDialog
          home={home}
          label={dialog.label}
          start={dialog.start}
          isOwner={isOwner}
          busy={inFlight}
          onClose={() => {
            dialogOpen.current = false
            setDialog(null)
            status.reload()
            refreshIfNeeded()
          }}
          onLanded={() => {
            refreshPending.current = true
            forgetConversionProgress(repo)
          }}
          onSettled={() => {
            invalidatePrivateSession(repo)
            if (dialogOpen.current) refreshPending.current = true
            status.reload()
            if (!dialogOpen.current) refreshIfNeeded()
          }}
        />
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Interrupted
// ---------------------------------------------------------------------------------------------

function InterruptedPanel({
  status,
  label,
  labelReady,
  isOwner,
  inFlight,
  onFinish,
}: {
  status: MakePublicStatus
  label: string
  /** The owner's name is read (Finish may ask for words typed against it). */
  labelReady: boolean
  isOwner: boolean
  /** A step of the last run is still signing: Finish waits for it. */
  inFlight: boolean
  onFinish: (start: Start) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // The stalled banner's "Finish it" links to #danger: bring this panel into view once it's read.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash === '#danger') ref.current?.scrollIntoView?.({ block: 'start' })
  }, [])
  const flipped = status.phase === 'made'
  const steps = status.steps
  const historyByOwner = !isOwner && steps.history === 'owner'
  const onlyOwnerLeft = historyByOwner && (['config', 'code', 'notify'] as const).every((s) => steps[s] === 'done')
  // A run whose own key change another rotation followed can't be finished, only started again
  // (decided from the keys as the run reads them).
  const record = status.record
  const passed = !flipped && status.sealOffPassed
  const boundaryMode = record?.mode ?? status.sealOffMarker?.marker?.mode ?? 'everything'
  const boundaryAt = record?.sealOffAt ?? null
  // Before the flip only the owner continues; after it any maintainer, the history aside.
  const canFinish = (isOwner || flipped) && !onlyOwnerLeft && !passed
  const finish = (): void => {
    const record = status.record
    if (record !== null) {
      onFinish({ kind: 'resume', mode: record.mode, steps })
      return
    }
    // No record here: choose again. Everything is the owner's choice, unless its history is out already.
    const historyStarted = status.mode === 'everything'
    onFinish({ kind: 'choose', allowed: { codeOnly: !historyStarted, everything: isOwner || historyStarted } })
  }
  return (
    <div ref={ref} className="scroll-mt-20 space-y-3 rounded-lg border border-caution/50 bg-caution/5 p-4" data-testid="make-public-interrupted" data-phase={status.phase}>
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-dense font-medium [overflow-wrap:anywhere]">{interruptedLine(label)}</p>
          {!flipped && status.sealOffMarker !== undefined ? (
            <p className="text-[12px] text-anvil-600 dark:text-anvil-300">This repo is being made public. What you write from now on stays members-only unless the owner starts the conversion over.{status.sealOffMarker?.kind === 'active' && status.sealOffMarker.marker?.replacesEpoch !== undefined ? ' A new conversion replaced the earlier publication boundary. Earlier writing may now be published.' : null}</p>
          ) : null}
          {passed ? null : <p className="text-[12px] text-anvil-600 dark:text-anvil-300">{progressLine(label, status.doneCount)}</p>}
          {inFlight ? (
            <p className="flex items-center gap-1.5 text-[12px] text-anvil-600 dark:text-anvil-300" aria-live="polite" data-testid="make-public-still-working">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
              {STILL_WORKING}
            </p>
          ) : null}
          {!inFlight && stepStalled(status.lastStepAt) ? (
            <p className="text-[12px] text-caution-800 dark:text-caution-300" data-testid="make-public-stalled">
              {stalledText(status.lastStepAt)}
            </p>
          ) : null}
        </div>
      </div>
      <StepRows rows={{ confirm: 'done', ...steps }} />
      {historyByOwner ? (
        <p className="text-[12px] text-anvil-600 dark:text-anvil-300 [overflow-wrap:anywhere]" data-testid="make-public-owner-history">
          {ownerHistoryLine(label)}
        </p>
      ) : null}
      {passed ? (
        <p className="text-[12px] text-caution-800 dark:text-caution-300" data-testid="make-public-seal-off-passed">
          {COPY.sealOffPassed(boundaryMode)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {passed && isOwner ? (
          <>
            <Button variant="danger" disabled={!labelReady || inFlight} onClick={() => onFinish({ kind: 'new', startOver: { at: boundaryAt, mode: boundaryMode } })} data-testid="make-public-start-over">
              Start again…
            </Button>
            <span className="min-w-0 text-[12px] text-anvil-500 dark:text-anvil-400 [overflow-wrap:anywhere]">
              or: <code className="font-mono">{startOverCommand(label, boundaryMode)}</code>
            </span>
          </>
        ) : null}
        {canFinish ? (
          <Button variant="danger" disabled={!labelReady || inFlight} onClick={finish} data-testid="make-public-finish">
            Finish
          </Button>
        ) : null}
        {canFinish ? (
          <span className="min-w-0 text-[12px] text-anvil-500 dark:text-anvil-400 [overflow-wrap:anywhere]">
            or: <code className="font-mono">{resumeCommand(label)}</code>
          </span>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// The step list
// ---------------------------------------------------------------------------------------------

type RowState = StepState | 'failed'

const ROWS: readonly MakePublicRow[] = ['confirm', ...MAKE_PUBLIC_STEPS]

function StepRows({
  rows,
  details = {},
  question = null,
}: {
  rows: Readonly<Record<MakePublicRow, RowState>>
  details?: Partial<Record<MakePublicRow, string>>
  /** A storage question the code step waits on, rendered under it. */
  question?: JSX.Element | null
}): JSX.Element {
  return (
    <ol className="space-y-1.5" aria-label="Steps">
      {ROWS.map((row) => {
        const state = rows[row]
        const detail = details[row]
        return (
          <li key={row} className={cn('text-dense', (state === 'todo' || state === 'skipped') && 'text-anvil-500 dark:text-anvil-400')} data-testid="make-public-step" data-step={row} data-state={state}>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <RowIcon state={state} />
              <span>{STEP_LABEL[row]}</span>
              {state === 'owner' ? <span className="text-[12px] font-medium text-caution-700 dark:text-caution-400">Waiting for the owner</span> : null}
              {state === 'skipped' ? <span className="text-[12px]">Not with Code only</span> : null}
              {detail !== undefined && detail !== '' ? <span className="min-w-0 text-[12px] text-anvil-600 dark:text-anvil-400 [overflow-wrap:anywhere]">({detail})</span> : null}
            </span>
            {row === 'code' && question !== null ? question : null}
          </li>
        )
      })}
    </ol>
  )
}

/** What a screen reader hears before a row's name (the icon says it to the eye). */
const STATE_WORD: Readonly<Record<RowState, string>> = { done: 'Done:', running: 'Running:', owner: 'Waiting:', skipped: 'Skipped:', failed: 'Stopped:', todo: 'To do:' }

function RowIcon({ state }: { state: RowState }): JSX.Element {
  const icon = (() => {
    switch (state) {
      case 'done':
        return <Check className="h-4 w-4 shrink-0 text-verify-700 dark:text-verify-400" aria-hidden />
      case 'running':
        return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-anvil-500 dark:text-anvil-400" aria-hidden />
      case 'owner':
        return <CirclePause className="h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
      case 'skipped':
        return <Minus className="h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
      case 'failed':
        return <X className="h-4 w-4 shrink-0 text-danger-700 dark:text-danger-400" aria-hidden />
      default:
        return <span className="h-4 w-4 shrink-0 rounded-full border border-anvil-300 dark:border-anvil-700" aria-hidden />
    }
  })()
  return (
    <>
      {icon}
      <span className="sr-only">{STATE_WORD[state]}</span>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------------------------

interface RunState {
  readonly mode: MakePublicMode
  readonly rows: Readonly<Record<MakePublicRow, RowState>>
  readonly details: Partial<Record<MakePublicRow, string>>
  /** The phase of the check the run makes again, while it does. */
  readonly checking: string | null
  readonly error: unknown
  readonly outcome: MakePublicOutcome | null
}

function initialRows(mode: MakePublicMode, from?: Readonly<Record<MakePublicStep, StepState>>): Record<MakePublicRow, RowState> {
  const rows = { confirm: from === undefined ? 'running' : 'done' } as Record<MakePublicRow, RowState>
  for (const s of MAKE_PUBLIC_STEPS) rows[s] = from?.[s] ?? 'todo'
  if (mode === 'codeOnly') rows.history = 'skipped'
  else if (rows.history === 'skipped') rows.history = 'todo'
  return rows
}

const sameSet = (a: ReadonlySet<string>, b: readonly string[]): boolean => a.size === b.length && b.every((x) => a.has(x))

/** How a check that stops is said. */
const CHECK_STOPPED = "The check didn't finish"

function MakePublicDialog({
  home,
  label,
  start,
  isOwner,
  busy,
  onClose,
  onLanded,
  onSettled,
}: {
  home: RepoHome
  label: string
  start: Start
  isOwner: boolean
  /** A run on this repo is in flight in this tab (an earlier dialog's): nothing starts until it settles. */
  busy: boolean
  onClose: () => void
  /** A step was written (told even after the dialog closed): what the page read of the repo is stale. */
  onLanded: () => void
  /** A run ended, however it ended: read where it stands again. */
  onSettled: () => void
}): JSX.Element {
  const write = usePrivateWrite(home.repo)
  const contextRef = useRef(write.context)
  contextRef.current = write.context
  const hasContext = write.context !== null
  // The code is stored where the repo's storage settings say, as the public repo stores it.
  const pub = useMemo(() => publicViewOf(home.repo), [home.repo])
  const mergeUpload = useMergeUpload(pub)
  const uploadRef = useRef(mergeUpload)
  uploadRef.current = mergeUpload

  const [check, setCheck] = useState<MakePublicCheck | null>(null)
  const [defaults, setDefaults] = useState<readonly MakePublicRef[] | null>(null)
  const [checking, setChecking] = useState<string | null>(null)
  const [checkError, setCheckError] = useState<unknown>(null)
  const [mode, setMode] = useState<MakePublicMode | null>(start.kind === 'resume' ? start.mode : start.kind === 'everything' ? 'everything' : null)
  // A maintainer finishing a run this browser has no record of chooses the owner's refs: none ticked.
  const blankRefs = start.kind === 'choose' && !isOwner
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [allowed, setAllowed] = useState<ReadonlySet<string>>(new Set())
  const [extraSecrets, setExtraSecrets] = useState<readonly MakePublicSecret[]>([])
  const [words, setWords] = useState('')
  const [review, setReview] = useState(false)
  const [formError, setFormError] = useState<unknown>(null)
  const [run, setRun] = useState<RunState | null>(null)
  const packCache = useRef<PackCache>(new Map())
  const checkCtl = useRef<AbortController | null>(null)
  const runCtl = useRef<AbortController | null>(null)
  const startedCheck = useRef(false)
  const startedResume = useRef(false)
  const groupName = useId()
  const wordsId = useId()

  // Closing (or leaving the page) stops a check at once and a run between steps.
  useEffect(
    () => () => {
      checkCtl.current?.abort()
      runCtl.current?.abort()
    },
    [],
  )

  const runCheck = useCallback(
    async (refs?: readonly string[]): Promise<void> => {
      const c = contextRef.current
      if (c === null) return
      checkCtl.current?.abort()
      const ctl = new AbortController()
      checkCtl.current = ctl
      setCheckError(null)
      setChecking(refs === undefined ? 'Starting the check' : 'Checking again')
      try {
        const next = await makePublicCheck(c, {
          ...(refs !== undefined ? { refs } : {}),
          signal: ctl.signal,
          onProgress: (what) => {
            if (!ctl.signal.aborted) setChecking(what)
          },
          label,
          packCache: packCache.current,
        })
        if (ctl.signal.aborted) return
        setCheck(next)
        if (refs === undefined) {
          setDefaults(next.codeRefs)
          setSelected(new Set(blankRefs ? [] : next.codeRefs.map((r) => r.name)))
        }
      } catch (e) {
        if (ctl.signal.aborted) return
        setCheckError(e)
      } finally {
        if (checkCtl.current === ctl) {
          checkCtl.current = null
          setChecking(null)
        }
      }
    },
    [blankRefs, label],
  )

  // The check starts once this tab can open the repo's content.
  useEffect(() => {
    if (start.kind === 'resume' || !hasContext || startedCheck.current) return
    startedCheck.current = true
    void runCheck()
  }, [start.kind, hasContext, runCheck])

  // Code only's choice changed: check that choice (the packs already fetched are kept).
  const selectionKey = [...selected].sort().join('\n')
  const stale = mode === 'codeOnly' && check !== null && selected.size > 0 && !sameSet(selected, check.codeRefs.map((r) => r.name))
  useEffect(() => {
    if (!stale || run !== null) return
    const t = setTimeout(() => void runCheck([...selected]), 600)
    return () => clearTimeout(t)
    // `selected` is read through its key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale, selectionKey, runCheck])

  const go = useCallback(
    async (m: MakePublicMode): Promise<void> => {
      const c = contextRef.current
      if (c === null) return
      const upload = uploadRef.current
      if (upload.upload === null) {
        const error = new MakePublicError(upload.storageError ?? 'Reading your storage settings.')
        setFormError(error)
        setRun((prev) => (prev === null ? prev : { ...prev, error }))
        return
      }
      // never two runs side by side: one still signing (a closed dialog's) settles first
      const end = beginMakePublicRun(c.network, home.repo.repoId)
      if (end === null) {
        setFormError(new MakePublicError(STILL_WORKING))
        return
      }
      runCtl.current?.abort()
      const ctl = new AbortController()
      runCtl.current = ctl
      let landed = false
      setFormError(null)
      setRun((prev) => ({
        mode: m,
        // a retry keeps what landed; a step that stopped is to do again
        rows:
          prev !== null && prev.mode === m
            ? { ...(Object.fromEntries(ROWS.map((k) => [k, prev.rows[k] === 'failed' ? 'todo' : prev.rows[k]])) as Record<MakePublicRow, RowState>), confirm: prev.rows.confirm === 'done' ? 'done' : 'running' }
            : initialRows(m, start.kind === 'resume' ? start.steps : undefined),
        details: prev?.details ?? {},
        checking: null,
        error: null,
        outcome: null,
      }))
      upload.begin(null)
      const resume = start.kind === 'resume'
      try {
        const outcome = await runMakePublic(
          c,
          {
            mode: m,
            ...(m === 'codeOnly' && !resume ? { refs: [...selected] } : {}),
            allowSecrets: [...allowed],
            confirmation: resume ? '' : words,
            repoLabel: label,
            ...(upload.upload !== null ? { upload: upload.upload } : {}),
            ...(resume ? { resume: true } : {}),
            ...(start.kind === 'new' && start.startOver !== undefined ? { startOver: true } : {}),
            onCheck: (what) => {
              if (!ctl.signal.aborted) setRun((r) => (r === null ? r : { ...r, checking: what }))
            },
          },
          (p) => {
            if (p.state === 'done') {
              landed = true
              onLanded()
            }
            if (ctl.signal.aborted) return
            setRun((r) =>
              r === null
                ? r
                : {
                    ...r,
                    checking: null,
                    rows: { ...r.rows, confirm: 'done', [p.step]: p.state },
                    details: p.step === 'code' && p.detail !== undefined ? { ...r.details, code: p.detail.split(', ').map(shortRef).join(', ') } : r.details,
                  },
            )
          },
          ctl.signal,
        )
        onLanded()
        if (ctl.signal.aborted) return
        setRun((r) => (r === null ? r : { ...r, checking: null, outcome }))
      } catch (e) {
        if (ctl.signal.aborted || isAbort(e)) return
        const secrets = e instanceof MakePublicError ? (e.secrets ?? []) : []
        if (secrets.length > 0) setExtraSecrets((prev) => uniqueSecrets([...prev, ...secrets]))
        if (!landed && !resume) {
          // nothing was written: back to the choice, with why
          setRun(null)
          setFormError(e)
        } else {
          setRun((r) => {
            if (r === null) return r
            const rows = { ...r.rows }
            for (const k of ROWS) if (rows[k] === 'running') rows[k] = 'failed'
            return { ...r, rows, checking: null, error: e }
          })
        }
      } finally {
        if (runCtl.current === ctl) runCtl.current = null
        end()
        onSettled()
      }
    },
    [allowed, home.repo.repoId, label, onLanded, onSettled, selected, start, words],
  )

  // Finish the recorded run as soon as this tab can.
  const uploadReady = mergeUpload.upload !== null
  useEffect(() => {
    if (start.kind !== 'resume' || !hasContext || !uploadReady || busy || startedResume.current) return
    startedResume.current = true
    void go(start.mode)
  }, [start, hasContext, uploadReady, busy, go])

  // --- what the form decides ---
  const modeAllowed = (m: MakePublicMode): boolean => (start.kind === 'everything' ? m === 'everything' : start.kind !== 'choose' || start.allowed[m])
  /** What blocks mode `m` besides possible secrets (those take a "Publish anyway"). */
  const blockerOf = (m: MakePublicMode): MakePublicError | null => (check === null ? null : gateMakePublic(check, m, secretsOf(check, m).map((s) => s.fingerprint)))
  const findings = check !== null && mode !== null ? uniqueSecrets([...secretsOf(check, mode), ...extraSecrets]) : extraSecrets
  const unacked = findings.filter((s) => s.refuses && !allowed.has(s.fingerprint.toLowerCase()))
  const startOver = start.kind === 'new' ? start.startOver : undefined
  const typedWords = startOver !== undefined ? START_OVER_WORDS(label) : MAKE_PUBLIC_WORDS(label)
  /** Why Make public is disabled, or null when it isn't. */
  const why = ((): string | null => {
    if (!hasContext) return 'Unlock this tab to continue.'
    if (busy) return STILL_WORKING
    if (check === null) return checkError !== null ? runErrorText(checkError, CHECK_STOPPED) : 'The check is still running.'
    if (check.blockers.length > 0) return check.blockers[0]!
    if (mode === null) return COPY.noMode
    if (!modeAllowed(mode)) return COPY.notOwner
    if (stale && checkError !== null) return runErrorText(checkError, CHECK_STOPPED)
    if (checking !== null || stale) return 'The check is still running.'
    if (mode === 'codeOnly' && selected.size === 0) return NO_REFS_CHOSEN
    if (mode === 'codeOnly' && check.codeRefs.length === 0) return COPY.noCode
    const blocker = blockerOf(mode)
    if (blocker !== null) return blocker.message
    if (unacked.length > 0) return COPY.secret(unacked[0]!.place)
    if (mergeUpload.storageNeedsUnlock) return 'Unlock this tab to use your storage settings.'
    if (!uploadReady) return mergeUpload.storageError ?? 'Reading your storage settings.'
    if (words !== typedWords) return COPY.words(typedWords)
    return null
  })()
  /** Run the check again: over Code only's choice when it isn't the default one. */
  const recheck = (): void => {
    const def = defaults ?? []
    void runCheck(selected.size === 0 || sameSet(selected, def.map((r) => r.name)) ? undefined : [...selected])
  }

  const toggle = (names: readonly string[], on: boolean): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const n of names) {
        if (on) next.add(n)
        else next.delete(n)
      }
      return next
    })
  const allow = (fingerprint: string, on: boolean): void =>
    setAllowed((prev) => {
      const next = new Set(prev)
      if (on) next.add(fingerprint.toLowerCase())
      else next.delete(fingerprint.toLowerCase())
      return next
    })

  const title = start.kind === 'new' ? `Make ${label} public?` : start.kind === 'everything' ? everythingLaterTitle(label) : `Finish making ${label} public`
  const locked = !hasContext
  // Where the code goes: the storage settings, once read (sealed: the tab's unlock first).
  const storageNote = mergeUpload.storageNeedsUnlock ? (
    <UnlockMore title="Unlock this tab to use your storage settings" testId="make-public-storage-unlock" forgot={false} />
  ) : mergeUpload.storageError !== null ? (
    <p role="alert" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 [overflow-wrap:anywhere]" data-testid="make-public-storage-error">
      Couldn&apos;t read your storage settings: {mergeUpload.storageError}
    </p>
  ) : null
  // The run starts from the Make public button, which goes away: focus moves to the step list.
  const progressRef = useRef<HTMLDivElement>(null)
  const running = run !== null
  useEffect(() => {
    if (running) progressRef.current?.focus({ preventScroll: true })
  }, [running])
  const whyId = useId()
  // The reason Make public waits, said beside it (the words have their own label above).
  const shownWhy = check !== null && why !== null && why !== COPY.words(typedWords) ? why : null

  // --- the body ---
  let body: JSX.Element
  let footer: JSX.Element
  if (run !== null) {
    const done = ROWS.filter((k) => run.rows[k] === 'done').length
    const o = run.outcome
    const notPublished = o === null ? null : notPublishedLine(o.notPublished)
    body = (
      <div ref={progressRef} tabIndex={-1} className="space-y-3 outline-none" data-testid="make-public-progress" data-mode={run.mode}>
        {o === null ? (
          <p aria-live="polite" className="[overflow-wrap:anywhere]">
            {progressLine(label, done)}
          </p>
        ) : null}
        <StepRows
          rows={run.rows}
          details={{ ...run.details, ...(run.checking !== null ? { confirm: run.checking } : {}) }}
          question={uploadRef.current.question}
        />
        {run.error !== null ? (
          <div role="alert" className="space-y-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2" data-testid="make-public-run-error">
            <p>{runErrorText(run.error)}</p>
            {!locked && !mergeUpload.storageNeedsUnlock ? <PublicationEncryptionUnlock error={run.error} /> : null}
            <SecretAcks findings={findings} allowed={allowed} onAllow={allow} />
            <Button size="sm" variant="outline" disabled={unacked.length > 0 || locked || !uploadReady} onClick={() => void go(run.mode)} data-testid="make-public-retry">
              Try again
            </Button>
          </div>
        ) : null}
        {o !== null ? (
          <div role="status" className="space-y-1 rounded-md border border-verify/40 bg-verify/5 px-3 py-2" data-testid="make-public-done">
            <p className="flex items-start gap-2 font-medium [overflow-wrap:anywhere]">
              <Globe className="mt-0.5 h-4 w-4 shrink-0 text-verify-700 dark:text-verify-400" aria-hidden />
              {o.finished ? doneLine(label, run.mode) : doneButHistoryLine(label)}
            </p>
            {o.boundaryKept === true ? (
              <p className="text-[12px] [overflow-wrap:anywhere]" data-testid="make-public-boundary-kept">
                {COPY.boundaryKept}
              </p>
            ) : null}
            {notPublished !== null ? (
              <p className="text-[12px] [overflow-wrap:anywhere]" data-testid="make-public-not-published">
                {notPublished}
              </p>
            ) : null}
            {o.spentCredits !== undefined && o.spentCredits > 0 ? <p className="text-[12px] text-anvil-600 dark:text-anvil-300">Spent about {aboutDash(o.spentCredits)}.</p> : null}
          </div>
        ) : null}
        {locked ? <UnlockMore title="Unlock this tab to continue" testId="make-public-unlock" forgot={false} /> : null}
        {run.error !== null ? storageNote : null}
      </div>
    )
    footer = (
      <Button variant={o !== null ? 'primary' : 'ghost'} onClick={onClose} data-testid="make-public-close">
        {o !== null ? 'Done' : 'Close'}
      </Button>
    )
  } else if (start.kind === 'resume') {
    // waiting for this tab's key before the run starts
    const resumeRows = initialRows(start.mode, start.steps)
    body = (
      <div className="space-y-3" data-testid="make-public-progress">
        <p className="[overflow-wrap:anywhere]">{progressLine(label, ROWS.filter((k) => resumeRows[k] === 'done').length)}</p>
        {locked ? (
          write.loading === true ? (
            <p>Reading your encryption key…</p>
          ) : (
            <UnlockMore title="Unlock this tab to continue" testId="make-public-unlock" forgot={false} />
          )
        ) : (
          (storageNote ?? <p>Reading your storage settings…</p>)
        )}
        <StepRows rows={resumeRows} />
      </div>
    )
    footer = (
      <Button variant="ghost" onClick={onClose} data-testid="make-public-close">
        Close
      </Button>
    )
  } else {
    body = (
      <div className="space-y-4" data-testid="make-public-dialog" data-checked={check !== null ? 'yes' : 'no'}>
        <p className="font-medium text-anvil-800 dark:text-anvil-100">{start.kind === 'everything' ? EVERYTHING_LATER_FIRST_LINE : MAKE_PUBLIC_FIRST_LINE}</p>
        {locked ? (
          write.loading === true ? (
            <p>Reading your encryption key…</p>
          ) : (
            <UnlockMore title="Unlock this tab to make this repo public" testId="make-public-unlock" forgot={false} />
          )
        ) : null}
        {checking !== null && check === null ? (
          <p className="flex items-center gap-2 text-anvil-600 dark:text-anvil-300" aria-live="polite" data-testid="make-public-check-progress">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
            {checking}…
          </p>
        ) : null}
        {checkError !== null ? (
          <div role="alert" className="space-y-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 [overflow-wrap:anywhere]" data-testid="make-public-check-error">
            <p>{runErrorText(checkError, CHECK_STOPPED)}</p>
            <Button size="sm" variant="outline" onClick={recheck} disabled={checking !== null} data-testid="make-public-recheck">
              Run the check again
            </Button>
          </div>
        ) : null}
        {check !== null ? (
          <CheckForm
            check={check}
            defaults={defaults ?? check.codeRefs}
            groupName={groupName}
            mode={mode}
            onMode={setMode}
            modeAllowed={modeAllowed}
            everythingOnly={start.kind === 'everything'}
            refsHint={blankRefs ? COPY.sayRefs : null}
            selected={selected}
            onToggle={toggle}
            review={review}
            onReview={() => setReview((r) => !r)}
            blockerOf={blockerOf}
            onRecheck={recheck}
            checking={checking}
            rechecking={(stale && checkError === null) || (checking !== null && mode === 'codeOnly')}
            findings={findings}
            allowed={allowed}
            onAllow={allow}
          />
        ) : null}
        {formError !== null ? (
          <div role="alert" className="space-y-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 [overflow-wrap:anywhere]" data-testid="make-public-run-error">
            <p>{runErrorText(formError)}</p>
          </div>
        ) : null}
        {!locked && !mergeUpload.storageNeedsUnlock ? (
          <PublicationEncryptionUnlock
            error={[checkError, formError].find((error) => error instanceof EncryptionKeyLockedError)}
            then={() => {
              setFormError(null)
              recheck()
            }}
          />
        ) : null}
        {check !== null || checkError !== null ? storageNote : null}
        {check !== null ? (
          <div className="space-y-1.5">
            {startOver !== undefined ? (
              <p className="text-caution-800 dark:text-caution-300 [overflow-wrap:anywhere]" data-testid="make-public-start-over-line">
                {COPY.startOver(startOver.at, mode ?? startOver.mode)}
              </p>
            ) : null}
            <label htmlFor={wordsId} className="block font-medium text-anvil-800 dark:text-anvil-100 [overflow-wrap:anywhere]">
              {COPY.words(typedWords)}
            </label>
            <Input id={wordsId} value={words} onChange={(e) => setWords(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} data-testid="make-public-words" />
          </div>
        ) : null}
      </div>
    )
    footer = (
      <>
        {shownWhy !== null ? (
          <p id={whyId} className="min-w-0 flex-1 text-[12px] text-anvil-500 dark:text-anvil-400 [overflow-wrap:anywhere]" data-testid="make-public-why">
            {shownWhy}
          </p>
        ) : null}
        <Button variant="ghost" onClick={onClose} data-testid="make-public-cancel">
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={why !== null}
          aria-describedby={shownWhy !== null ? whyId : undefined}
          onClick={() => mode !== null && void go(mode)}
          data-testid="make-public-confirm"
        >
          Make public
        </Button>
      </>
    )
  }

  return (
    <Dialog open onClose={onClose} title={title} footer={footer} className="max-w-2xl [&_h2]:[overflow-wrap:anywhere]">
      <ScrollRegion label="Making this repo public" className="-mx-5 max-h-[60vh] overflow-y-auto px-5 text-dense text-anvil-700 dark:text-anvil-200 sm:max-h-[65vh]">
        {body}
      </ScrollRegion>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------
// The choice
// ---------------------------------------------------------------------------------------------

function CheckForm({
  check,
  defaults,
  groupName,
  mode,
  onMode,
  modeAllowed,
  everythingOnly,
  refsHint,
  selected,
  onToggle,
  review,
  onReview,
  blockerOf,
  onRecheck,
  checking,
  rechecking,
  findings,
  allowed,
  onAllow,
}: {
  check: MakePublicCheck
  defaults: readonly MakePublicRef[]
  groupName: string
  mode: MakePublicMode | null
  onMode: (m: MakePublicMode) => void
  modeAllowed: (m: MakePublicMode) => boolean
  /** Everything after Code only: Code only is not offered. */
  everythingOnly: boolean
  /** Said above Code only's boxes (a maintainer choosing the owner's refs). */
  refsHint: string | null
  selected: ReadonlySet<string>
  onToggle: (names: readonly string[], on: boolean) => void
  review: boolean
  onReview: () => void
  blockerOf: (m: MakePublicMode) => MakePublicError | null
  onRecheck: () => void
  checking: string | null
  /** Code only's choice is being checked. */
  rechecking: boolean
  findings: readonly MakePublicSecret[]
  allowed: ReadonlySet<string>
  onAllow: (fingerprint: string, on: boolean) => void
}): JSX.Element {
  const choices = refChoices(check.allRefs, defaults, check.defaultBranch)
  const defaultGroup = choices.branch === null ? [] : [choices.branch, ...choices.tags].map((r) => r.name)
  const others = choices.others
  const folded = others.length > OTHERS_SHOWN
  const otherNames = others.map((r) => r.name)
  // the boxes choose Code only's refs: live once Code only is the choice
  const refsOff = mode !== 'codeOnly' || !modeAllowed('codeOnly')
  const otherBoxes = others.map((r) => (
    <li key={r.name}>
      <RefBox label={shortRef(r.name)} names={[r.name]} selected={selected} onToggle={onToggle} disabled={refsOff} testId="make-public-ref" refName={r.name} />
    </li>
  ))
  const codeBlocker = blockerOf('codeOnly')
  const everythingBlocker = blockerOf('everything')
  const thatIs = everythingThatIs(check)
  const unread = unreadLine(check)
  const wordsBy = wordsLine(check)
  const recheck = (
    <Button size="sm" variant="outline" onClick={onRecheck} disabled={checking !== null} data-testid="make-public-recheck">
      Run the check again
    </Button>
  )
  return (
    <>
      {check.blockers.map((b) => (
        <p key={b} role="alert" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 [overflow-wrap:anywhere]" data-testid="make-public-blocker">
          {b}
        </p>
      ))}
      {check.notes.map((n) => (
        <p key={n} className="text-[12px] text-anvil-600 dark:text-anvil-300 [overflow-wrap:anywhere]">
          {n}
        </p>
      ))}
      <fieldset className="space-y-2">
        <legend className="mb-2 font-medium text-anvil-800 dark:text-anvil-100">{everythingOnly ? 'What becomes public' : 'What becomes public (choose one)'}</legend>

        {everythingOnly ? null : (
          <ModeOption groupName={groupName} mode="codeOnly" chosen={mode} onMode={onMode} disabled={!modeAllowed('codeOnly')}>
            {refsHint !== null ? (
              <p className="text-caution-800 dark:text-caution-300" data-testid="make-public-refs-hint">
                {refsHint}
              </p>
            ) : null}
            {defaultGroup.length === 0 && others.length === 0 ? (
              <p>{COPY.noCode}</p>
            ) : (
              <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Branches and tags">
                {choices.branch !== null ? (
                  <li>
                    <RefBox
                      label={defaultGroupLabel(choices.branch, choices.tags.length)}
                      names={defaultGroup}
                      selected={selected}
                      onToggle={onToggle}
                      disabled={refsOff}
                      testId="make-public-ref-default"
                      refName={choices.branch.name}
                    />
                  </li>
                ) : null}
                {folded ? (
                  <li className="flex flex-wrap items-center gap-2">
                    <RefBox label={othersLabel(others)} names={otherNames} selected={selected} onToggle={onToggle} disabled={refsOff} testId="make-public-ref-others" />
                    <Button size="sm" variant="ghost" onClick={onReview} aria-expanded={review} data-testid="make-public-refs-review">
                      Review
                    </Button>
                  </li>
                ) : (
                  otherBoxes
                )}
              </ul>
            )}
            {folded && review ? (
              <ul className="ml-1 max-h-48 space-y-1 overflow-y-auto border-l border-anvil-200 pl-3 dark:border-anvil-800" aria-label={othersLabel(others)}>
                {otherBoxes}
              </ul>
            ) : null}
            {selected.size === 0 && refsHint === null ? <p className="text-caution-800 dark:text-caution-300">{NO_REFS_CHOSEN}</p> : null}
            {rechecking ? (
              <p className="flex items-center gap-2 text-anvil-600 dark:text-anvil-300" aria-live="polite" data-testid="make-public-rechecking">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                Checking again…
              </p>
            ) : null}
            <p className="text-anvil-600 dark:text-anvil-300">{CODE_ONLY_STAYS}</p>
            {codeBlocker !== null ? <Blocker error={codeBlocker} action={recheck} /> : null}
          </ModeOption>
        )}

        <ModeOption groupName={groupName} mode="everything" chosen={mode} onMode={onMode} disabled={!modeAllowed('everything')}>
          <p className="text-anvil-600 dark:text-anvil-300">
            {EVERYTHING_TEXT} {EVERYTHING_RELEASES}
          </p>
          <p data-testid="make-public-everything-counts">{thatIs}</p>
          {unread !== null ? <p className="text-anvil-600 dark:text-anvil-300">{unread}</p> : null}
          {wordsBy !== null ? <p data-testid="make-public-words-by">{wordsBy}</p> : null}
          {!modeAllowed('everything') ? <p className="text-anvil-600 dark:text-anvil-300">Only the owner can choose Everything.</p> : null}
          {everythingBlocker !== null ? <Blocker error={everythingBlocker} check={check} action={everythingBlocker.code === 'E503' ? recheck : null} /> : null}
        </ModeOption>
      </fieldset>

      {mode !== null ? (
        <div className="space-y-1.5" data-testid="make-public-scan" data-mode={mode}>
          {findings.length === 0 ? <p>{noSecretsLine(mode)}</p> : <SecretAcks findings={findings} allowed={allowed} onAllow={onAllow} />}
        </div>
      ) : null}

      <div className="space-y-1">
        <p data-testid="make-public-stays-private">{staysPrivateLine(check)}</p>
        <p>{KEEPS_WORKING}</p>
        <p>{oldClientsLine(check.minClientVersion)}</p>
        {mode !== null ? <p data-testid="make-public-cost">{costLine(check.estimate[mode])}</p> : null}
      </div>
    </>
  )
}

function ModeOption({
  groupName,
  mode,
  chosen,
  onMode,
  disabled,
  children,
}: {
  groupName: string
  mode: MakePublicMode
  chosen: MakePublicMode | null
  onMode: (m: MakePublicMode) => void
  disabled: boolean
  children: React.ReactNode
}): JSX.Element {
  const id = useId()
  const checked = chosen === mode
  return (
    <div className={cn('rounded-md border px-3 py-2.5', checked ? 'border-danger/60 bg-danger/5' : 'border-anvil-200 dark:border-anvil-800')}>
      <label htmlFor={id} className={cn('flex items-center gap-2 font-medium text-anvil-800 dark:text-anvil-100', disabled && 'opacity-60')}>
        <input
          id={id}
          type="radio"
          name={groupName}
          value={mode}
          checked={checked}
          disabled={disabled}
          onChange={() => onMode(mode)}
          className="h-4 w-4 accent-forge-700"
          data-testid={`make-public-mode-${mode}`}
        />
        {MODE_LABEL[mode]}
      </label>
      <div className="ml-6 mt-1.5 space-y-1.5">{children}</div>
    </div>
  )
}

/** A box over one ref or a group of them (checked when all are; mixed when some are). */
function RefBox({
  label,
  names,
  selected,
  onToggle,
  testId,
  refName,
  disabled,
}: {
  label: string
  names: readonly string[]
  selected: ReadonlySet<string>
  onToggle: (names: readonly string[], on: boolean) => void
  testId: string
  refName?: string
  disabled: boolean
}): JSX.Element {
  const on = names.filter((n) => selected.has(n)).length
  const all = names.length > 0 && on === names.length
  const some = on > 0 && !all
  return (
    <label className={cn('inline-flex min-w-0 items-center gap-2 [overflow-wrap:anywhere]', disabled && 'opacity-60')}>
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0 accent-forge-700"
        checked={all}
        ref={(el) => {
          if (el !== null) el.indeterminate = some
        }}
        disabled={disabled}
        onChange={(e) => onToggle(names, e.target.checked)}
        data-testid={testId}
        data-ref={refName}
      />
      <span className="font-mono text-[12px]">{label}</span>
    </label>
  )
}

/** What blocks a mode, inline under it: E812 with its fix, code that couldn't be fetched or read. */
function Blocker({ error, check, action = null }: { error: MakePublicError; check?: MakePublicCheck; action?: JSX.Element | null }): JSX.Element {
  const envs = error.code === 'E812' && check !== undefined ? check.oldFormat : []
  return (
    <div role="alert" className="space-y-1.5 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 [overflow-wrap:anywhere]" data-testid="make-public-blocker" data-code={error.code}>
      {envs.length > 0
        ? envs.map((env) => {
            const fix = oldFormatFix(env)
            return (
              <div key={env} className="space-y-0.5">
                <p>{oldFormatLine(env)}</p>
                <p className="text-[12px]">
                  Fix: <code className="font-mono">{fix.resave}</code>, change every listed value where it&apos;s used, then <code className="font-mono">{fix.markChanged}</code>
                </p>
              </div>
            )
          })
        : null}
      {envs.length === 0 || check?.oldFormatUnreadable === true ? <p>{envs.length === 0 ? error.message : COPY.oldFormatUnreadable}</p> : null}
      {action}
    </div>
  )
}

/** The scan's findings; each that needs it has a "Publish anyway" box (its fingerprint is allowed). */
function SecretAcks({
  findings,
  allowed,
  onAllow,
}: {
  findings: readonly MakePublicSecret[]
  allowed: ReadonlySet<string>
  onAllow: (fingerprint: string, on: boolean) => void
}): JSX.Element | null {
  if (findings.length === 0) return null
  return (
    <ul className="space-y-1.5">
      {findings.map((s) => (
        <SecretAck key={`${s.place}\0${s.fingerprint}`} finding={s} allowed={allowed.has(s.fingerprint.toLowerCase())} onAllow={onAllow} />
      ))}
    </ul>
  )
}

function SecretAck({ finding, allowed, onAllow }: { finding: MakePublicSecret; allowed: boolean; onAllow: (fingerprint: string, on: boolean) => void }): JSX.Element {
  const placeId = useId()
  return (
    <li className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-caution-800 dark:text-caution-300" data-testid="make-public-secret">
      <p id={placeId} className="flex items-start gap-1.5 [overflow-wrap:anywhere]">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {secretLine(finding.place)}
      </p>
      {finding.refuses ? (
        <label className="mt-1 flex items-center gap-2 text-anvil-800 dark:text-anvil-100">
          <input
            type="checkbox"
            className="h-4 w-4 accent-forge-700"
            checked={allowed}
            onChange={(e) => onAllow(finding.fingerprint, e.target.checked)}
            aria-describedby={placeId}
            data-testid="make-public-secret-allow"
            data-fingerprint={finding.fingerprint}
          />
          Publish anyway
        </label>
      ) : null}
    </li>
  )
}
