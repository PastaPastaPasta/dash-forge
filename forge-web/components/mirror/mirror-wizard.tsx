'use client'

/**
 * `/mirror` — mirror a GitHub repository into Dash Forge, end to end, from the browser
 * (`ux-dx-spec.md` §1(b), launch criterion 2: nothing to install, no Forge-run service):
 *
 *   1. the GitHub repository, checked public through GitHub's anonymous REST API;
 *   2. the Forge repository (created here, three documents, or an existing one of yours);
 *   3. storage: a bucket of your own (the storage wizard, with its CORS fix) or Platform;
 *   4. a runner key: a limited, group-bound key with its own budget and expiry, shown once as
 *      the `DASH_FORGE_KEY` secret (the master key signs once; nothing is stored here);
 *   5. the workflow file, prefilled, with the secrets to add first;
 *   6. waiting for the first run: Platform is polled until the mirror's refs appear.
 *
 * Resumable: each step's answer is kept in IndexedDB (`lib/mirror/progress.ts`), never a key.
 * A rail keeps what the wizard writes on chain, and its price, in view.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { GitFork, Lock } from 'lucide-react'
import { StepCard, type StepState } from '@/components/mirror/step-card'
import { GithubStep, KeyStep, RepoStep, StorageStep, WaitStep, WorkflowStep, storageChoice } from '@/components/mirror/mirror-steps'
import { SignInButton } from '@/components/sign-in-button'
import { UnlockMore } from '@/components/auth/unlock-more'
import { LoadingBlock } from '@/components/ui/states'
import { CostPreview } from '@/components/ui/cost-preview'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { useStorageConfig } from '@/hooks/use-storage-config'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { previewRepoCreate, readRefs, repoCreationFirsts, resolveAnyRepoWith } from '@/lib/repo'
import { KEY_REGISTER_CREDITS, PUSH_COST_DASH, previewCredits, sumPreviews } from '@/lib/sdk'
import { PLATFORM_PROFILE } from '@/lib/storage'
import { EMPTY_PROGRESS, clearMirrorProgress, loadMirrorProgress, refsFingerprint, resumed, saveMirrorProgress, withAnswer, type MirrorProgress, type RunnerKeyRecord } from '@/lib/mirror/progress'
import { mirrorRepoInput, suggestForgeName, suggestedRunnerBudget } from '@/lib/mirror/wizard'
import { creditsAsDash, formatDate } from '@/lib/view/format'

type StepId = 'github' | 'repo' | 'storage' | 'key' | 'workflow' | 'wait'
const ORDER: readonly StepId[] = ['github', 'repo', 'storage', 'key', 'workflow', 'wait']
const TITLES: Readonly<Record<StepId, string>> = {
  github: 'The GitHub repository',
  repo: 'The Forge repository',
  storage: 'Where the git data goes',
  key: 'A runner key for the Action',
  workflow: 'The workflow file and its secrets',
  wait: 'The first mirror run',
}

/** Which steps are answered. */
function doneSteps(p: MirrorProgress): Readonly<Record<StepId, boolean>> {
  return {
    github: p.github !== null,
    repo: p.repo !== null,
    storage: p.storage !== null,
    key: p.runnerKey?.saved === true,
    workflow: p.workflowAdded,
    wait: p.mirroredAt !== null,
  }
}

/** The one-line summary of each answered step. */
function summariesOf(p: MirrorProgress): Partial<Record<StepId, React.ReactNode>> {
  return {
    github: p.github ? <span className="font-mono">github.com/{p.github.owner}/{p.github.name}</span> : null,
    repo: p.repo ? <span className="font-mono">{p.repo.name}</span> : null,
    storage: storageSummary(p.storage),
    key: keySummary(p.runnerKey),
    workflow: p.workflowAdded ? '.github/workflows/forge-mirror.yml' : null,
  }
}

function storageSummary(storage: string | null): React.ReactNode {
  if (storage === PLATFORM_PROFILE) return 'Dash Platform'
  if (storage) return <span className="font-mono">{storage}</span>
  return null
}

function keySummary(key: RunnerKeyRecord | null): string | null {
  if (key === null) return null
  // A negative key id: the person added a runner key of their own.
  if (key.keyId < 0) return 'Your own runner key'
  return `Key ${key.keyId}: ${creditsAsDash(Number(key.budgetCredits))} DASH until ${formatDate(key.expiresAt)}`
}

export function MirrorWizard(): JSX.Element {
  const { identity } = useAuth()
  const { sdk } = useSdk()
  const storage = useStorageConfig()
  const forge = ACTIVE_NETWORK.v2
  const openedAt = useRef(Date.now())
  const [progress, setProgress] = useState<MirrorProgress>(EMPTY_PROGRESS)
  const progressRef = useRef(progress)
  const [loaded, setLoaded] = useState<string | null>(null)
  const [reopened, setReopened] = useState<StepId | null>(null)
  // The runner key's `dfk1:` value lives only here, in this tab, until it is pasted into GitHub,
  // and only for the identity it was made on (a sign-out or switch drops it from view).
  const [made, setMade] = useState<{ identity: string; value: string } | null>(null)
  const secret = made !== null && made.identity === identity ? made.value : null

  const show = useCallback((next: MirrorProgress): void => {
    progressRef.current = next
    setProgress(next)
  }, [])

  // Pick up where this identity stopped; a GitHub repo checked before signing in is kept.
  useEffect(() => {
    if (identity === null) return
    let live = true
    loadMirrorProgress(ACTIVE_NETWORK.key, identity).then(
      (saved) => {
        if (!live) return
        show(resumed(progressRef.current, saved, openedAt.current))
        setLoaded(identity)
      },
      () => live && setLoaded(identity),
    )
    return () => {
      live = false
    }
  }, [identity, show])

  /** Record an answer (and save it); `keepOpen`: the step a person reopened stays open. */
  const update = useCallback(
    (patch: Partial<MirrorProgress>, keepOpen = false): void => {
      if (!keepOpen) setReopened(null)
      const p = progressRef.current
      const next = { ...withAnswer(p, patch), startedAt: p.startedAt || openedAt.current }
      show(next)
      if (identity !== null) void saveMirrorProgress(ACTIVE_NETWORK.key, identity, next).catch(() => undefined)
    },
    [identity, show],
  )

  const firsts = useAsync(() => repoCreationFirsts(sdk!, identity!, forge!.core), [identity ?? '', sdk !== null], { enabled: sdk !== null && identity !== null && forge !== null })

  const done = doneSteps(progress)
  const current = reopened ?? ORDER.find((s) => !done[s]) ?? 'wait'
  const signedIn = identity !== null && loaded === identity

  // The repository's refs before the workflow can run: the wait step watches for a change.
  const baselineFor = current === 'workflow' && signedIn && progress.refsBefore === null ? progress.repo : null
  useEffect(() => {
    if (baselineFor === null || sdk === null || forge === null || identity === null) return
    let live = true
    void (async () => {
      const resolved = await resolveAnyRepoWith(sdk, forge, { owner: identity, name: baselineFor.name, repoId: baselineFor.repoId })
      const fp = resolved ? refsFingerprint(await readRefs(sdk, resolved.repo)) : null
      if (live && fp !== null && progressRef.current.repo?.repoId === baselineFor.repoId) update({ refsBefore: fp }, true)
    })().catch(() => undefined)
    return () => {
      live = false
    }
  }, [baselineFor, sdk, forge, identity, update])

  if (!isForgeDeployed() || forge === null) return <NotDeployedState />

  const stateOf = (s: StepId): StepState => {
    if (s === current) return 'active'
    return done[s] ? 'done' : 'todo'
  }
  const choice = storageChoice(progress.storage, storage.config?.profiles ?? [])
  const profile = storage.config?.profiles.find((p) => p.name === progress.storage) ?? null

  const summaries = summariesOf(progress)
  const firstsOrNone = firsts.data ?? { first: {}, rest: {} }

  const body = (s: StepId): React.ReactNode => {
    if (s === 'github') return <GithubStep initial={progress.github} onDone={(github) => update({ github })} />
    if (!signedIn || progress.github === null) {
      return identity === null ? <SignInGate /> : <p className="text-dense text-anvil-500 dark:text-anvil-400">Opening your progress…</p>
    }
    const gh = progress.github
    switch (s) {
      case 'repo':
        return <RepoStep sdk={sdk} forge={forge} identity={identity} github={gh} firsts={firstsOrNone} onDone={(repo) => update({ repo })} />
      case 'storage':
        return <StorageStep storage={storage} github={gh} initial={progress.storage} onDone={(name) => update({ storage: name })} />
      case 'key':
        return (
          <KeyStep
            identity={identity}
            github={gh}
            record={progress.runnerKey}
            secret={secret}
            suggestedBudget={suggestedRunnerBudget(choice?.ok ? choice.kind : 's3', gh.sizeKib, PUSH_COST_DASH.perMib)}
            onCreated={(runnerKey, value) => {
              setMade({ identity, value })
              update({ runnerKey })
            }}
            onDone={(runnerKey) => update({ runnerKey })}
          />
        )
      case 'workflow':
        if (progress.repo === null || choice === null) return null
        // A bucket's settings (and the keys to paste) are sealed in the vault: open it first.
        if (progress.storage !== PLATFORM_PROFILE) {
          if (storage.needsUnlock) return <UnlockMore title="Unlock this tab to use your storage settings" testId="mirror-workflow-unlock" />
          if (storage.config === null) return <LoadingBlock label="Opening your storage settings" />
        }
        if (!choice.ok) return <p className="text-dense text-caution-700 dark:text-caution-400">{choice.reason}</p>
        return <WorkflowStep identity={identity} github={gh} repoName={progress.repo.name} storage={choice} profile={profile} secret={secret} runnerKey={progress.runnerKey} onDone={() => update({ workflowAdded: true })} />
      case 'wait':
        if (progress.repo === null) return null
        return (
          <WaitStep
            sdk={sdk}
            forge={forge}
            identity={identity}
            github={gh}
            repo={progress.repo}
            progress={progress}
            onMirrored={(at) => update({ mirroredAt: at })}
            onRestart={() => {
              setMade(null)
              setReopened(null)
              void clearMirrorProgress(ACTIVE_NETWORK.key, identity)
              openedAt.current = Date.now()
              show({ ...EMPTY_PROGRESS, startedAt: openedAt.current })
            }}
          />
        )
    }
  }

  const repoCost =
    progress.github && !done.repo
      ? previewRepoCreate(mirrorRepoInput(progress.github, suggestForgeName(progress.github.name) || 'x'), firstsOrNone)
      : null
  const keyCost = done.key ? null : previewCredits(KEY_REGISTER_CREDITS)
  const left = [repoCost, keyCost].filter((c) => c !== null)

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-forge-500/15">
          <GitFork className="h-5 w-5 text-forge-500" aria-hidden />
        </span>
        <div>
          <h1 className="text-xl">Mirror a GitHub repository</h1>
          <p className="max-w-2xl text-dense text-anvil-500 dark:text-anvil-400">
            A copy nobody can take down: refs signed on Dash Platform ({ACTIVE_NETWORK.key}), git data in storage you control, kept in sync by a GitHub Action. About ten minutes, nothing to install.
          </p>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <ol className="min-w-0 space-y-3" aria-label="Mirror setup steps">
          {ORDER.map((s, i) => (
            <StepCard key={s} n={i + 1} id={s} title={TITLES[s]} state={stateOf(s)} summary={summaries[s]} onChange={s === 'wait' ? undefined : () => setReopened(s)}>
              {body(s)}
            </StepCard>
          ))}
        </ol>
        <aside aria-label="What this writes on chain" className="h-fit space-y-3 rounded-lg border border-anvil-200 bg-white p-3 text-dense dark:border-anvil-800 dark:bg-anvil-900 lg:sticky lg:top-20">
          <h2 className="text-dense font-medium text-anvil-500 dark:text-anvil-400">On chain</h2>
          <ul className="space-y-2">
            <RailItem label="Forge repository" note={done.repo ? 'done' : 'three documents'} />
            <RailItem label="Runner key" note={done.key ? 'done' : 'an identity update; its budget is a cap, not a charge'} />
            <RailItem label="Each mirror run" note="paid through the runner key, never more than the run's cost cap" />
          </ul>
          {left.length > 0 ? (
            <div className="space-y-1">
              <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Still to sign here</p>
              <CostPreview cost={sumPreviews(left)} />
            </div>
          ) : null}
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            Nothing passes through a Forge server: GitHub is asked from your browser, keys are made in it, and the Action runs on GitHub&apos;s runners.
          </p>
        </aside>
      </div>
    </div>
  )
}

function RailItem({ label, note }: { label: string; note: string }): JSX.Element {
  return (
    <li>
      <span className="block font-medium text-anvil-800 dark:text-anvil-100">{label}</span>
      <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">{note}</span>
    </li>
  )
}

function SignInGate(): JSX.Element {
  return (
    <div className="space-y-2" data-testid="mirror-signin">
      <p className="flex items-center gap-2 text-dense">
        <Lock className="h-4 w-4 text-anvil-500" aria-hidden /> Sign in, or create an identity in this browser, to continue.
      </p>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">The mirror is owned by your identity. Setting it up costs a few thousandths of a DASH; each run is capped.</p>
      <SignInButton label="long" />
    </div>
  )
}
