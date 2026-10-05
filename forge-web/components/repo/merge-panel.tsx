'use client'

/**
 * MergePanel — the browser merge (`ux-dx-spec.md` §5.7), for a PR's maintainers and writers.
 *
 * The button says what it will do, decided in the merge worker before anything is offered:
 * `Merge (fast-forward)`, `Create merge commit and merge` (when the two sides merge cleanly: a
 * file both changed is merged line by line exactly as git merges it, QW3-016), or a disabled
 * `Can't merge in the browser — merge with \`dg pr merge\`` with the paths that conflict (or that
 * only git merges: renames, a moved directory, binary or very large files) and the
 * `dg pr checkout` line. A writer on a
 * protected base branch sees `Protected branch — maintainers only`; a narrow screen, "Use a
 * desktop browser for this step". The click runs the step list (fetch → merge → build and
 * verify the pack → upload → packManifest → browse index → ref update → merge event), and a
 * failure names what already exists and offers to resume.
 *
 * Review parity (M1, M2, M3, M7, F7): a method choice (the plan's merge, Squash and merge, or Rebase
 * and merge — the PR's commits replayed on the base as `git rebase` replays them, checked on its own
 * since a rebase can stop where a merge would not), each
 * commit with an editable message (the merge commit's as `dg pr merge --message` writes it, the
 * squash's as `dg pr merge --squash`), limited to what the branch policy's
 * `mergeMethods` allows; the conflicting paths when the check finds overlaps; and "Delete the
 * branch after merging" when the merger can write to the PR's source repo.
 *
 * Branch rules (QW-001): while the policy's approvals or required checks are unmet, the button
 * stays disabled and says why. A maintainer gets GitHub's explicit bypass: tick "Merge without
 * waiting for the rules to be met (bypass rules)", confirm a dialog naming each rule bypassed,
 * and the merge really runs, then records the bypass on the PR as a policy-bypass event (`bypassValue`; the
 * merge transition has no field for it). The same rule as `dg pr merge --override-policy`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitMerge, Loader2 } from 'lucide-react'

import { readConfigHistory, readTargetLog, refNameHash, resolveRefByHash, type PullView, type RepoRef } from '@/lib/repo'
import { matchesProtected } from '@/lib/rules'
import { prMergeBase } from '@/lib/rules/v2'
import { EXISTING, bytesToBase64, previewCreate, sumPreviews } from '@/lib/sdk'
import { mergeReaders, missingFromClosure } from '@/lib/merge/verify'
import { MEMBERS_MESSAGE_WARNING, mergeMessage, mergeSourceLabel, squashDraft, type MergeCheck, type MergeInput, type SquashAuthors } from '@/lib/merge/engine'
import { checkMergeInWorker, runMergeInWorker } from '@/lib/merge/client'
import { MergeStepError, mergeSteps, retryLabel, runFor, runMergeSteps, type MergeRun, type MergeStepId } from '@/lib/merge/runner'
import { bypassValue, mergeButton, mergeGate, mergeRefProblem } from '@/lib/view/pull-actions'
import { recordPolicyBypass } from '@/lib/repo'
import { publishMergeIndex } from '@/lib/merge/locator'
import { StorageRow, useMergeUpload } from '@/components/repo/merge-upload'
import { StepRow, type StepState } from '@/components/repo/step-list'
import { widenEstimate, type PackEstimate } from '@/lib/storage/merge-choice'
import { UnlockMore } from '@/components/auth/unlock-more'
import { mergeIdentityValid } from '@/lib/view/prefs'
import { CommitIdentityPrompt } from '@/components/repo/branch-commit-panel'
import { branchName, tipOidOf, type DiffSides, type ObjectReader } from '@/lib/view'
import { useSdk } from '@/hooks/use-sdk'
import { useMinWidth, usePrefs } from '@/hooks/use-prefs'
import { useAuth } from '@/contexts/auth-context'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { CopyRow } from '@/components/ui/copy-row'
import { CostPreview } from '@/components/ui/cost-preview'
import { Oid } from '@/components/ui/oid'
import { Textarea } from '@/components/ui/input'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { spendAction } from '@/lib/spend-toast'

/** "Delete the branch after merging": runnable, or shown disabled with why. */
export type DeleteBranchOption = { readonly label: string; readonly run: () => Promise<void> } | { readonly label: string; readonly disabled: string }

/** A fast-forward's pack estimate grown by the merge commit a --no-ff adds (about 1 KiB; the estimate's slack covers a longer title). */
function withMergeCommit(e: PackEstimate | null): PackEstimate | null {
  return e === null ? null : { bytes: e.bytes + 1024, objectCount: e.objectCount + 1 }
}

/** The method picker's name for a merge commit, the plan's or a --no-ff one alike. */
const MERGE_COMMIT_OPTION = 'Create a merge commit'

/** The merge methods: the plan's (fast-forward, or a merge commit), --no-ff, a squash, or a rebase. */
type Method = 'merge' | 'no-ff' | 'squash' | 'rebase'

/**
 * "Close #12 after merging" (review-parity P8, QW-015): the open issues the PR's description
 * closes ("Fixes #12"), each ticked by default as GitHub closes them, and how to close one (a
 * member's close transition, run after the merge lands).
 */
export interface CloseIssuesOption {
  readonly issues: readonly { readonly number: number; readonly title: string }[]
  readonly close: (number: number) => Promise<void>
  /** Linked issues past the most a merge offers (`LINKED_ISSUES_MAX`): said, not silently dropped. */
  readonly omitted?: number
}

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
  allowedMethods = 0,
  squashAuthors = null,
  deleteBranch = null,
  closeIssues = null,
  onRunning,
  active = true,
  unmetRules = [],
  canBypass = false,
  branchAhead = null,
  checkSourceBranch,
  onBranchDeleted,
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
  /** The policy's `mergeMethods` bitmask (1 ff, 2 merge commit, 4 squash, 8 rebase; 0 any). */
  allowedMethods?: number
  /**
   * `Name <email>` of the PR's commit authors, oldest first (the squash's Co-authored-by), or
   * null while unknown; `complete` false when the commit list was capped (some may be missing).
   */
  squashAuthors?: SquashAuthors
  /** Delete the PR's source branch after merging (the merger can write there), or null. */
  deleteBranch?: DeleteBranchOption | null
  /** Close the open issues the PR's description links, after merging, or null. */
  closeIssues?: CloseIssuesOption | null
  /** Told when a merge starts and ends here (the page keeps the panel mounted meanwhile). */
  onRunning?: (running: boolean) => void
  /** False while the page keeps the panel mounted but hidden: no merge check runs meanwhile. */
  active?: boolean
  /** The branch rules the PR does not meet (`unmetRules`); empty: met, or no policy. */
  unmetRules?: readonly string[]
  /** The merger is a maintainer and may bypass {@link unmetRules} (explicit, confirmed, recorded). */
  canBypass?: boolean
  /**
   * The PR's source branch is past its head (the head-sync banner's "ahead"): the merge waits for
   * "Update PR head" (QW3-013), or it would merge the older head and leave the newer commits out.
   */
  branchAhead?: { readonly branch: string; readonly tip: string } | null
  /**
   * Re-read the source branch just before merging: why not to merge (it moved past the head since
   * the page read it), or null. A failed read does not stop the merge.
   */
  checkSourceBranch?: () => Promise<string | null>
  /** Told once "Delete the branch after merging" deleted it (the page shows it deleted at once). */
  onBranchDeleted?: () => void
}): JSX.Element | null {
  const { sdk } = useSdk()
  const { signer, locked: sessionLocked } = useAuth()
  // A locked member sees the merge box as it stands; the button unlocks first (QW2-033).
  const unlockFirst = signer === null && sessionLocked
  const guard = useWriteGuard()
  const [prefs] = usePrefs()
  const wide = useMinWidth(1024)
  const { upload, question: storageQuestion, questionStep, choiceFor, begin, storageNeedsUnlock } = useMergeUpload(repo)
  // The check sizes the pack (an upper bound): the Storage row prices it before the merge starts.
  // With the method it was sized for (a squash packs none of the head's history): an estimate for
  // another method is no price for this one, and is sized again. A rebase's sizing check is also
  // its verdict (it may stop where a merge does not): `check`, and why it cannot rebase.
  const [sized, setSized] = useState<{
    readonly estimate: PackEstimate | null
    readonly method: Method
    readonly check?: MergeCheck
    readonly conflictPaths?: readonly string[]
    readonly reason?: string | null
  } | null>(null)
  // "Allow storing on Platform": until the merger touches it, its default follows the policy.
  const [allowTouched, setAllowTouched] = useState<boolean | null>(null)
  const baseRefName = pull.mergeBaseRefName
  const baseProtected = matchesProtected(baseRefName, protectedPatterns)
  const refProblem = mergeRefProblem(baseRefName, baseTipOid, pull.headOid)
  // Merge reads prefer the head's repo and fall back to the base repo's own reader; they never
  // run until that base reader exists, so nothing about the base is taken from the fork.
  const readers = useMemo(() => mergeReaders(baseOnly, sides?.head ?? null), [sides, baseOnly])
  const reader = readers?.merge ?? null
  const sameRepo = pull.sourceId === '' || pull.sourceId === repo.repoId

  const policyAllows = (bit: number): boolean => allowedMethods === 0 || (allowedMethods & bit) !== 0
  const [check, setCheck] = useState<MergeCheck | { error: string } | null>(null)
  // QW-069: where a fast-forward is possible, "Create a merge commit" (--no-ff) is offered too, as
  // GitHub's default is; a policy allowing merge commits only then still merges.
  const ffPossible = check === 'fast-forward'
  const [picked, setMethod] = useState<Method | null>(null)
  // Until the merger picks, the method follows the policy (which may load after the panel).
  const preferred: Method = ffPossible
    ? policyAllows(1)
      ? 'merge'
      : policyAllows(2)
        ? 'no-ff'
        : policyAllows(4)
          ? 'squash'
          : 'rebase'
    : policyAllows(1) || policyAllows(2)
      ? 'merge'
      : policyAllows(4)
        ? 'squash'
        : 'rebase'
  // --no-ff where no fast-forward is possible is the plain merge commit.
  const method: Method = picked === 'no-ff' && !ffPossible ? 'merge' : picked ?? preferred
  const committer = `${prefs.mergeName.trim()} <${prefs.mergeEmail.trim()}>`
  const [squashText, setSquashText] = useState<string | null>(null)
  const squash = squashDraft(pull, squashAuthors, committer, squashText)
  const squashMsg = squash.message
  // The squash commit's author, as strings (the merge input below is memoized on them).
  const squashByName = squash.author?.name ?? null
  const squashByEmail = squash.author?.email ?? null
  // The merge commit's message (review-parity M2): the default until the merger edits it.
  const sourceLabel = mergeSourceLabel(pull.sourceRefName, pull.headOid)
  const [mergeText, setMergeText] = useState<string | null>(null)
  // A members-only PR's title is for members: the public merge commit names only its number.
  const publicTitle = pull.audience === 'members' ? '' : pull.title
  const mergeMsg = mergeText ?? mergeMessage(pull.number, sourceLabel, publicTitle).replace(/\n$/, '')
  // A merge commit is written (the plan's, or --no-ff; a fast-forward writes none): its message
  // box shows, and its edited message is passed.
  const writesMergeCommit = method === 'no-ff' || (method === 'merge' && check === 'merge')
  const [alsoDelete, setAlsoDelete] = useState(true)
  // Linked issues the merger unticked (every other one offered is closed after the merge).
  const [keepOpen, setKeepOpen] = useState<ReadonlySet<number>>(() => new Set())
  const closing = useMemo(() => (closeIssues?.issues ?? []).filter((i) => !keepOpen.has(i.number)).map((i) => i.number), [closeIssues, keepOpen])
  const [closed, setClosed] = useState<readonly { number: number; error: string | null }[] | null>(null)
  const input = useMemo<MergeInput>(
    () => ({
      baseTip: baseTipOid,
      headOid: pull.headOid,
      prNumber: pull.number,
      sourceLabel,
      title: publicTitle,
      // Only an edited message: the default is the engine's own (the same bytes).
      ...(mergeText !== null && writesMergeCommit ? { message: mergeText } : {}),
      author: { name: prefs.mergeName.trim(), email: prefs.mergeEmail.trim() },
      headInBase: sameRepo,
      // The PR's author authors the squash; the merger commits it (QW4-008).
      ...(method === 'squash' ? { squash: { message: squashMsg, ...(squashByName !== null && squashByEmail !== null ? { author: { name: squashByName, email: squashByEmail } } : {}) } } : {}),
      ...(method === 'no-ff' ? { noFastForward: true as const } : {}),
      ...(method === 'rebase' ? { rebase: true as const } : {}),
    }),
    [baseTipOid, pull.headOid, pull.number, sourceLabel, publicTitle, mergeText, writesMergeCommit, prefs.mergeName, prefs.mergeEmail, sameRepo, method, squashMsg, squashByName, squashByEmail],
  )
  // Widened for the real commit's identity (author and committer) and the squash message as it
  // is now: the check used a placeholder identity and the message of the moment.
  const packEstimate = sized !== null && sized.method === method ? sized.estimate : null
  const authorIdent = input.squash?.author ?? input.author
  const storage = choiceFor(widenEstimate(packEstimate, `${input.author.name}${input.author.email}${authorIdent.name}${authorIdent.email}${input.squash?.message ?? input.message ?? ''}`))
  const allowPlatform = allowTouched ?? storage?.allowByDefault ?? false
  // The pre-answer the run starts with: credits allowed on Platform (null: none, it asks).
  const preAgreedCredits = allowPlatform ? (storage?.platformCredits ?? null) : null

  // The worker's verdict (declared above, with the method it defaults). Each check owns its
  // worker and aborts it when superseded or unmounted, so a stale check never keeps reading objects.
  const [conflictPaths, setConflictPaths] = useState<readonly string[]>([])
  const [mergedHere, setMergedHere] = useState(false)
  // Nothing to check once the PR is merged (this panel's own merge included: the base then holds
  // it, and a check against the new tip would only report the merge against itself).
  const checkable = active && canMerge && !pull.state.merged && !mergedHere && repo.visibility === 'public' && refProblem === null && reader !== null && wide
  // The check reads the latest input without re-running when only the merger's name changes.
  const inputRef = useRef(input)
  inputRef.current = input
  useEffect(() => {
    if (!checkable || reader === null) return
    const abort = new AbortController()
    setCheck(null)
    setSized(null)
    // The check needs a name for the trial merge commit; the real one is written on click. The
    // verdict (fast-forward or merge commit) is the history's, whatever the method; a rebase is
    // checked (and sized) on its own just after.
    const { noFastForward: _noFf, rebase: _rebase, ...verdictInput } = inputRef.current
    const sizing: Method = inputRef.current.squash !== undefined ? 'squash' : inputRef.current.noFastForward === true ? 'no-ff' : 'merge'
    checkMergeInWorker(reader, { ...verdictInput, author: { name: 'check', email: 'check@forge' } }, abort.signal).then(
      (c) => {
        if (abort.signal.aborted) return
        setCheck(c.check)
        setConflictPaths(c.conflictPaths)
        // Checked without --no-ff: its pack is the fast-forward's plus the one merge commit.
        setSized({ estimate: sizing === 'no-ff' ? withMergeCommit(c.packEstimate) : c.packEstimate, method: sizing })
      },
      (e: unknown) => {
        if (!abort.signal.aborted) setCheck({ error: e instanceof Error ? e.message : String(e) })
      },
    )
    return () => abort.abort()
  }, [checkable, reader, sidesKey, baseTipOid, pull.headOid])
  // A method switch re-sizes the pack only: the verdict and the controls stay (the menu keeps
  // focus); the Storage row shows no price until the size for this method is in.
  const sizedMethod = sized?.method ?? null
  useEffect(() => {
    if (!checkable || reader === null || sizedMethod === null || sizedMethod === method) return
    const abort = new AbortController()
    checkMergeInWorker(reader, { ...inputRef.current, author: { name: 'check', email: 'check@forge' } }, abort.signal).then(
      (c) => {
        if (!abort.signal.aborted) setSized({ estimate: c.packEstimate, method, check: c.check, conflictPaths: c.conflictPaths, reason: c.reason })
      },
      (e: unknown) => {
        // A rebase's check is its verdict: one that fails says so rather than waiting forever.
        if (!abort.signal.aborted && method === 'rebase') setSized({ estimate: null, method, check: 'malformed', conflictPaths: [], reason: e instanceof Error ? e.message : String(e) })
      },
    )
    return () => abort.abort()
  }, [checkable, reader, method, sizedMethod])
  const button = mergeButton({
    canMerge,
    isPublic: repo.visibility === 'public',
    refProblem,
    baseLoaded: baseOnly !== null,
    isMaintainer,
    baseProtected,
    narrow: !wide,
    headOnBase: pull.headOnBase,
    check,
    checkout,
  })

  const [steps, setSteps] = useState<Partial<Record<MergeStepId, StepState>>>({})
  const [details, setDetails] = useState<Partial<Record<MergeStepId, string>>>({})
  // Kept across retries of the same base tip and head only (`runFor` drops a stale one).
  const [savedRun, setRun] = useState<MergeRun | null>(null)
  const run = runFor(savedRun, input, baseRefName)
  const [failure, setFailure] = useState<{ step: MergeStepId; message: string } | null>(null)
  const [stopped, setStopped] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const starting = useRef(false)
  useEffect(() => {
    onRunning?.(busy)
    // Unmounted mid-run: the page must not keep the box pinned for a run that is gone.
    return () => {
      if (busy) onRunning?.(false)
    }
  }, [busy, onRunning])
  const [newTip, setNewTip] = useState<string | null>(null)
  // "Bypass rules": ticked by a maintainer, confirmed in a dialog; the rules the merge started
  // with are kept for its retries (the record names what was bypassed at the merge).
  const [bypassTicked, setBypassTicked] = useState(false)
  const [confirmingBypass, setConfirmingBypass] = useState(false)
  const [bypassed, setBypassed] = useState<readonly string[] | null>(null)
  const gate = mergeGate({ unmet: unmetRules, canBypass, bypassTicked, storageLocked: storageNeedsUnlock, branchAhead: branchAhead === null ? null : { ...branchAhead, head: pull.headOid } })
  // The branch deletion's outcome, with the label it was run for: the page stops offering the
  // option once the PR reads merged, which is exactly when this is shown.
  const [deleted, setDeleted] = useState<{ label: string; error: string | null } | null>(null)

  // Upload estimate unknown until the pack exists; the documents are known (and the branch
  // deletion's ref update when it is ticked).
  const deletable = deleteBranch !== null && 'run' in deleteBranch ? deleteBranch : null
  const deleting = deletable !== null && alsoDelete
  const cost = sumPreviews([
    // The repo has packs and the base branch has updates: neither builds a subtree (QW3-037).
    previewCreate('packManifest', {}, EXISTING),
    // A base only lately protected may hold no protectedRefUpdate yet: its subtrees stay unknown.
    baseProtected ? previewCreate('protectedRefUpdate') : previewCreate('refUpdate', {}, EXISTING),
    previewCreate('event'),
    ...(deleting ? [previewCreate('refUpdate', {}, EXISTING)] : []),
    ...closing.map(() => previewCreate('transition')),
    ...(gate.bypassing || bypassed !== null ? [previewCreate('event', { value: bypassValue(bypassed ?? unmetRules) })] : []),
  ])
  // The rebase's own verdict, once its check is in (null meanwhile).
  const rebaseCheck = method === 'rebase' && sized?.method === 'rebase' ? (sized.check ?? null) : null
  // Why a rebase cannot run here: still checking, or where and why it stops (null: it can).
  const rebaseProblem =
    method !== 'rebase'
      ? null
      : rebaseCheck === null
        ? 'Checking the rebase…'
        : rebaseCheck === 'fast-forward' || rebaseCheck === 'merge'
          ? null
          : sized?.conflictPaths?.length
            ? // A commit conflicts: git's rebase stops at the same commit, so dg is no way out.
              `Can't rebase: ${sized.reason ?? 'a commit does not apply cleanly'} (${sized.conflictPaths.slice(0, 5).join(', ')}${sized.conflictPaths.length > 5 ? ', …' : ''}). git's rebase stops there too: pick another method, or rebase the PR's branch yourself (\`dg pr checkout\`).`
            : `Can't rebase in the browser: ${sized?.reason ?? rebaseCheck}. Rebase with \`dg pr merge --rebase\`, or pick another method.`
  // Only a written commit is authored; a fast-forward (a rebase's included) writes none.
  const identityOk = (button.kind !== 'merge-commit' && method === 'merge') || (method === 'rebase' && rebaseCheck === 'fast-forward') || mergeIdentityValid(prefs)
  // The plan's own method bit (ff 1, merge commit 2), squash (4) or rebase (8): what the policy is checked against.
  const planBit = method === 'rebase' ? 8 : method === 'no-ff' ? 2 : button.kind === 'fast-forward' ? 1 : button.kind === 'merge-commit' ? 2 : 0
  const mergeMsgProblem = writesMergeCommit && mergeMsg.trim() === '' ? 'Write a commit message to merge.' : null
  const methodAllowed = method === 'squash' ? policyAllows(4) && squash.problem === null : (planBit === 0 || policyAllows(planBit)) && mergeMsgProblem === null && rebaseProblem === null
  // Once this panel's merge has landed there is nothing left to merge: no method, button or cost.
  const mergeable = !mergedHere && (button.kind === 'fast-forward' || button.kind === 'merge-commit')

  const start = useCallback(async (bypass: readonly string[] | null) => {
    if (reader === null || baseOnly === null || busy || refProblem !== null) return
    // Stored storage settings are sealed in this tab (a resumed session): the button is disabled
    // and the prompt above asks.
    if (storageNeedsUnlock) return
    // Signed out or a locked session: the guard opens sign-in / unlock (never a silent no-op).
    if (!guard.check(cost, 'core', 'merge this pull request') || !sdk || !signer) return
    // One run at a time, from the first click on (the re-read below takes a moment).
    if (starting.current) return
    starting.current = true
    setBusy(true)
    setFailure(null)
    setStopped(null)
    // The branch moved past the head since the page read it (QW3-013): merging now would leave
    // the newer commits out. Only a fresh run checks; a retry resumes the merge it started.
    if (checkSourceBranch !== undefined && run.done.length === 0) {
      const moved = await checkSourceBranch().catch(() => null)
      if (moved !== null) {
        setStopped(moved)
        setBusy(false)
        starting.current = false
        return
      }
    }
    // The run starts: its bypass (if any) is what its retries record.
    setBypassed(bypass)
    begin(preAgreedCredits)
    const digest = (text: string): string => bytesToHex(sha256(new TextEncoder().encode(text))).slice(0, 16)
    const intent = `merge:${repo.repoId}:${pull.number}:${pull.headOid}:${baseTipOid}${input.squash ? `:squash:${digest(input.squash.message)}` : input.rebase ? ':rebase' : input.noFastForward ? ':no-ff' : ''}${input.message !== undefined ? `:msg:${digest(input.message)}` : ''}`
    try {
      // The merge's writes are one action: one toast with their total (QW3-039). The merge panel is
      // not modal, so its own signer marks them; a branch delete or issue close after it is its own.
      await spendAction({ running: `Merging #${pull.number}…`, done: `Merged #${pull.number}`, failed: `Merge of #${pull.number} stopped part-way` }, async (tag) => {
        const auth = tag(signer)
        const done = await runMergeSteps(
          {
            sdk,
            auth,
            repo,
            pull: { id: pull.id, number: pull.number, author: pull.author, baseRefName },
            input,
            merge: (i, onPhase) => runMergeInWorker(reader, i, (p) => onPhase(p.phase)),
            upload,
            publishIndex: upload === null ? null : async (pack, packHash) => {
              const r = await publishMergeIndex(sdk, auth, repo, pack, packHash, upload, `${intent}:index`)
              return r.kind === 'published' ? `fragment at packRef ${r.packRef}` : `skipped: ${r.reason}`
            },
            verifyPack: (pack, tip) => missingFromClosure(pack, tip, input.baseTip, (readers ?? { base: baseOnly }).base),
            readBaseTip: async () => {
              // The same rule the page's tip came from (resolveRef, then the provisional tip).
              const ref = await resolveRefByHash(sdk, repo, bytesToBase64(refNameHash(baseRefName)), await readConfigHistory(sdk, repo))
              return tipOidOf(ref ?? undefined) ?? ''
            },
            // The PR's base now: its newest retarget (any reader's rule, with no merge yet).
            readBaseRef: async () => prMergeBase(pull.baseRefName, pull.createdAt, (await readTargetLog(sdk, repo, pull.id)).events, null).refName,
            intent,
            ...(bypass !== null && bypass.length > 0
              ? {
                  recordBypass: async (tip: string, eventIntent: string) =>
                    (await recordPolicyBypass(sdk, auth, repo, { target: { id: pull.id, number: pull.number }, rules: bypass, mergeOid: tip, intent: eventIntent })).documentId,
                }
              : {}),
          },
          run,
          (e) => {
            setSteps((s) => ({ ...s, [e.step]: e.state }))
            if (e.detail) setDetails((d) => ({ ...d, [e.step]: e.detail }))
          },
        )
        setRun(done)
        setMergedHere(true)
        setNewTip(done.result?.newTip ?? null)
        onMerged()
        if (deletable !== null && alsoDelete) {
          try {
            await deletable.run()
            setDeleted({ label: deletable.label, error: null })
            onBranchDeleted?.()
          } catch (e) {
            setDeleted({ label: deletable.label, error: e instanceof Error ? e.message : String(e) })
          }
        }
        if (closeIssues !== null && closing.length > 0) {
          // One at a time (each is a transition from this identity): a failure is reported and the rest still close.
          const outcome: { number: number; error: string | null }[] = []
          for (const n of closing) {
            try {
              await closeIssues.close(n)
              outcome.push({ number: n, error: null })
            } catch (e) {
              outcome.push({ number: n, error: e instanceof Error ? e.message : String(e) })
            }
          }
          setClosed(outcome)
        }
      })
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
      starting.current = false
    }
  }, [sdk, signer, reader, readers, baseOnly, refProblem, busy, guard, cost, repo, pull.id, pull.number, pull.headOid, pull.baseRefName, pull.createdAt, pull.author, baseRefName, input, run, baseTipOid, onMerged, upload, begin, storageNeedsUnlock, preAgreedCredits, deletable, alsoDelete, closeIssues, closing, checkSourceBranch, onBranchDeleted])
  const onMergeClick = (): void => {
    // Locked: the click opens Unlock (the guard); merging is the next click, once unlocked.
    if (unlockFirst) {
      guard.check(cost, 'core', 'merge this pull request')
      return
    }
    // A retry resumes the merge it started with (and its bypass, already confirmed).
    if (failure !== null) void start(bypassed)
    else if (gate.bypassing) setConfirmingBypass(true)
    else void start(null)
  }

  // A run in this panel keeps it on screen to the end (the PR reads Merged meanwhile).
  const started = Object.keys(steps).length > 0
  if (button.kind === 'hidden' && !started && newTip === null) return null

  return (
    <section aria-label="Merge" data-testid="merge-panel" className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
      <div className="flex flex-wrap items-center gap-3">
        <GitMerge className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <span className="text-dense text-anvil-700 dark:text-anvil-200">
          Into <span className="font-mono">{branchName(baseRefName)}</span>
          {baseTipOid ? (
            <>
              {' '}
              at <Oid value={baseTipOid} chars={7} copyable={false} />
            </>
          ) : null}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2" data-testid="merge-button-state" data-state={mergedHere ? 'merged' : button.kind}>
          {mergedHere || button.kind === 'hidden' ? (
            // After this panel's own merge (the PR now reads Merged): its steps stay below.
            <span className="text-dense font-medium text-verify-700 dark:text-verify-400" data-testid="merge-done">
              Merged
            </span>
          ) : button.kind === 'checking' ? (
            <Button disabled>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Checking the merge…
            </Button>
          ) : mergeable ? (
            <>
              <label className="sr-only" htmlFor="merge-method">
                Merge method
              </label>
              <select
                id="merge-method"
                value={method}
                onChange={(e) => setMethod(e.target.value as Method)}
                disabled={busy || newTip !== null}
                className="h-9 rounded-md border border-anvil-300 bg-white px-2 text-dense text-anvil-900 coarse:h-11 dark:border-anvil-700 dark:bg-anvil-950 dark:text-anvil-100"
              >
                {/* One name per method, whether or not a fast-forward is possible (QW2-051); the
                    button says the action ("Create merge commit and merge"). */}
                <option value="merge" disabled={!policyAllows(button.kind === 'fast-forward' ? 1 : 2)}>
                  {button.kind === 'fast-forward' ? button.label : MERGE_COMMIT_OPTION}
                </option>
                {ffPossible ? (
                  <option value="no-ff" disabled={!policyAllows(2)}>
                    {MERGE_COMMIT_OPTION}
                  </option>
                ) : null}
                <option value="squash" disabled={!policyAllows(4)}>
                  Squash and merge
                </option>
                <option value="rebase" disabled={!policyAllows(8)}>
                  Rebase and merge
                </option>
              </select>
              <Button
                variant={gate.bypassing && failure === null ? 'danger' : 'primary'}
                onClick={onMergeClick}
                loading={busy}
                disabled={!unlockFirst && ((!gate.enabled && failure === null) || !identityOk || !methodAllowed || busy || newTip !== null || guard.disabledReason !== null)}
                aria-describedby={gate.reason !== null ? 'merge-gate-reason' : undefined}
                data-testid="merge-submit"
              >
                {unlockFirst ? 'Unlock to merge' : failure ? retryLabel(failure.step) : gate.bypassing ? (method === 'squash' ? 'Bypass rules and squash' : method === 'rebase' ? 'Bypass rules and rebase' : 'Bypass rules and merge') : method === 'squash' ? 'Squash and merge' : method === 'rebase' ? 'Rebase and merge' : method === 'no-ff' ? 'Create merge commit and merge' : button.label}
              </Button>
            </>
          ) : button.kind === 'unavailable' ? (
            <span className="text-dense text-anvil-600 dark:text-anvil-400">{button.reason}</span>
          ) : (
            <Button disabled>{button.label}</Button>
          )}
        </div>
      </div>

      {mergeable && newTip === null && unmetRules.length > 0 ? (
        <div className="mt-3 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense" data-testid="merge-rules-unmet">
          <p className="font-medium text-anvil-900 dark:text-anvil-50">Merging is blocked: the branch rules are not met</p>
          <ul className="mt-1 list-disc pl-5 text-[12px] text-anvil-700 dark:text-anvil-200">
            {unmetRules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {canBypass ? (
            <label className="mt-2 flex items-start gap-2 text-dense text-anvil-800 dark:text-anvil-100">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-danger-700"
                checked={bypassTicked}
                onChange={(e) => setBypassTicked(e.target.checked)}
                disabled={busy}
                data-testid="merge-bypass"
              />
              <span>
                Merge without waiting for the rules to be met (bypass rules)
                <span className="block text-[12px] text-anvil-600 dark:text-anvil-400">Maintainers only. The bypass is recorded on this PR as an event naming the rules, which nobody can delete.</span>
              </span>
            </label>
          ) : null}
        </div>
      ) : null}
      {mergeable && newTip === null && gate.reason !== null && failure === null ? (
        <p id="merge-gate-reason" className="mt-2 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="merge-gate-reason">
          {gate.reason}
        </p>
      ) : null}
      {button.kind === 'conflicts' && !mergedHere ? (
        <div className="mt-3">
          <p className="mb-1.5 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="browser-merge-limit">
            {conflictPaths.length > 0
              ? "These files conflict, or need a merge only git can do (a rename, a binary file, a .gitattributes rule). Check out the PR, merge it locally and push:"
              : 'The two histories have more than one merge base, which only git can merge. Check out the PR, merge it locally and push:'}
          </p>
          {conflictPaths.length > 0 ? (
            <ul className="mb-2 list-disc pl-5 font-mono text-[12px] text-anvil-700 dark:text-anvil-200" aria-label="Conflicting paths" data-testid="conflict-paths">
              {conflictPaths.slice(0, 20).map((p) => (
                <li key={p}>{p}</li>
              ))}
              {conflictPaths.length > 20 ? <li>… and {conflictPaths.length - 20} more</li> : null}
            </ul>
          ) : null}
          <CopyRow text={button.checkout} label="Copy the checkout command" />
        </div>
      ) : null}
      {mergeable && method === 'squash' && policyAllows(4) && squash.problem !== null ? (
        <p className="mt-2 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="squash-problem">
          {squash.problem}
        </p>
      ) : mergeable && mergeMsgProblem !== null ? (
        <p className="mt-2 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="merge-message-problem">
          {mergeMsgProblem}
        </p>
      ) : mergeable && rebaseProblem !== null && policyAllows(8) ? (
        <p className="mt-2 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="rebase-problem">
          {rebaseProblem}
        </p>
      ) : mergeable && !methodAllowed ? (
        <p className="mt-2 text-[12px] text-caution-700 dark:text-caution-400">The branch policy does not allow this merge method; pick another.</p>
      ) : null}
      {mergeable && writesMergeCommit && newTip === null ? (
        <div className="mt-3">
          <label htmlFor="merge-message" className="mb-1 block text-[12px] font-medium text-anvil-700 dark:text-anvil-200">
            Commit message
          </label>
          <Textarea id="merge-message" value={mergeMsg} onChange={(e) => setMergeText(e.target.value)} className="min-h-[72px] font-mono text-[12px]" disabled={busy} data-testid="merge-message" />
          {pull.audience === 'members' ? (
            <p className="mt-1 text-[12px] text-caution-700 dark:text-caution-400" data-testid="merge-members-warning">
              {MEMBERS_MESSAGE_WARNING}
            </p>
          ) : null}
        </div>
      ) : null}
      {mergeable && method === 'squash' && newTip === null ? (
        <div className="mt-3">
          <label htmlFor="squash-message" className="mb-1 block text-[12px] font-medium text-anvil-700 dark:text-anvil-200">
            Commit message
          </label>
          <Textarea id="squash-message" value={squashMsg} onChange={(e) => setSquashText(e.target.value)} className="min-h-[96px] font-mono text-[12px]" disabled={!squash.ready} />
          {squash.author !== null ? (
            <p className="mt-1 break-words text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="squash-author">
              Authored by <span className="font-mono">{`${squash.author.name} <${squash.author.email}>`}</span> (the PR&apos;s first commit); you commit it.
            </p>
          ) : null}
          {squash.warning !== null ? (
            <p className="mt-1 text-[12px] text-caution-700 dark:text-caution-400" data-testid="squash-warning">
              {squash.warning}
            </p>
          ) : null}
        </div>
      ) : null}
      {mergeable && deleteBranch !== null && newTip === null ? (
        'run' in deleteBranch ? (
          <label className="mt-2 flex items-center gap-2 text-dense">
            <input type="checkbox" className="h-4 w-4 accent-forge-700" checked={alsoDelete} onChange={(e) => setAlsoDelete(e.target.checked)} />
            Delete {deleteBranch.label} after merging
          </label>
        ) : (
          <div className="mt-2" data-testid="delete-branch-unavailable">
            <label className="flex items-center gap-2 text-dense text-anvil-500 dark:text-anvil-400">
              <input type="checkbox" className="h-4 w-4" checked={false} disabled aria-describedby="delete-branch-why" />
              Delete {deleteBranch.label} after merging
            </label>
            <p id="delete-branch-why" className="ml-6 text-[12px] text-anvil-500 dark:text-anvil-400">
              {deleteBranch.disabled}
            </p>
          </div>
        )
      ) : null}
      {mergeable && closeIssues !== null && closeIssues.issues.length > 0 && newTip === null ? (
        <fieldset className="mt-2" data-testid="close-linked-issues">
          <legend className="sr-only">Linked issues to close</legend>
          {closeIssues.issues.map((i) => (
            <label key={i.number} className="flex items-center gap-2 text-dense coarse:min-h-11">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 accent-forge-700"
                checked={!keepOpen.has(i.number)}
                onChange={(e) =>
                  setKeepOpen((k) => {
                    const next = new Set(k)
                    if (e.target.checked) next.delete(i.number)
                    else next.add(i.number)
                    return next
                  })
                }
              />
              <span className="min-w-0 truncate">
                Close <span className="font-mono">#{i.number}</span> <span className="text-anvil-500 dark:text-anvil-400">{i.title}</span> after merging
              </span>
            </label>
          ))}
          {closeIssues.omitted ? (
            <p className="ml-6 text-[12px] text-anvil-500 dark:text-anvil-400">
              {closeIssues.omitted} more linked {closeIssues.omitted === 1 ? 'issue is' : 'issues are'} not offered here; close {closeIssues.omitted === 1 ? 'it' : 'them'} from {closeIssues.omitted === 1 ? 'its page' : 'their pages'}.
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {mergeable && !identityOk ? (
        // Set right here, as the suggestion batch and "Update branch" do (QW4-027): a trip to
        // Settings would leave the page and the merge box's choices.
        <div className="mt-2" data-testid="merge-identity">
          {method === 'squash' ? (
            <CommitIdentityPrompt what="squash and merge" lead="A browser squash is committed with your name and email" />
          ) : method === 'rebase' ? (
            <CommitIdentityPrompt what="rebase and merge" lead="A browser rebase commits each of the PR's commits again with your name and email" />
          ) : (
            <CommitIdentityPrompt what="merge" lead="A browser merge commit is authored with your name and email" />
          )}
        </div>
      ) : null}
      {mergeable && storageNeedsUnlock ? (
        <div className="mt-3">
          <UnlockMore title="Unlock to merge with your storage settings" testId="merge-storage-unlock" />
        </div>
      ) : null}
      {mergeable ? (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-anvil-600 dark:text-anvil-400">
            <CostPreview cost={cost} />
            <span>plus the pack&apos;s storage (below)</span>
          </div>
          <StorageRow choice={storage} allowed={allowPlatform} onAllow={setAllowTouched} disabled={busy} />
        </div>
      ) : null}

      {started ? (
        <ol aria-label="Merge steps" className="mt-3 space-y-1 rounded-md border border-anvil-200 p-3 dark:border-anvil-800">
          {mergeSteps(bypassed !== null).map(({ id, label }) => (
            <StepRow key={id} id={id} label={label} state={steps[id] ?? 'todo'} detail={details[id]} question={id === questionStep ? storageQuestion : null} />
          ))}
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
          Merged. The base branch is now at <Oid value={newTip} chars={9} />, and the PR will show as merged in a few seconds.
        </p>
      ) : null}
      <Dialog
        open={confirmingBypass}
        onClose={() => setConfirmingBypass(false)}
        title={`Bypass the branch rules and merge PR #${pull.number}?`}
        description={`This merges the code into ${branchName(baseRefName)} although these rules are not met:`}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmingBypass(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              data-testid="merge-bypass-confirm"
              onClick={() => {
                setConfirmingBypass(false)
                void start([...unmetRules])
              }}
            >
              Bypass rules and merge
            </Button>
          </>
        }
      >
        <ul className="list-disc pl-5 text-dense text-anvil-800 dark:text-anvil-100" data-testid="merge-bypass-rules">
          {unmetRules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] text-anvil-600 dark:text-anvil-400">
          Your override will be shown on this PR, and it can&apos;t be deleted.
        </p>
      </Dialog>
      {closed !== null ? (
        <ul className="mt-1 space-y-0.5 text-dense" data-testid="linked-issues-closed">
          {closed.map((c) => (
            <li key={c.number} className={c.error === null ? 'text-anvil-700 dark:text-anvil-200' : 'text-danger-700 dark:text-danger-400'}>
              {c.error === null ? `Closed #${c.number}.` : `The merge stands; closing #${c.number} failed: ${c.error}`}
            </li>
          ))}
        </ul>
      ) : null}
      {deleted !== null && deleted.error === null ? (
        <p className="mt-1 text-dense text-anvil-700 dark:text-anvil-200" data-testid="branch-deleted">
          Deleted {deleted.label}.
        </p>
      ) : deleted !== null ? (
        <p role="alert" className="mt-1 text-dense text-caution-700 dark:text-caution-400">
          The merge stands; deleting {deleted.label} failed: {deleted.error}
        </p>
      ) : null}
    </section>
  )
}
