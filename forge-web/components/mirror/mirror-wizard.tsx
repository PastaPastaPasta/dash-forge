'use client'

/** The mirror's Action setup resumes per identity. CLI settings resume from the URL. */

import { useCallback, useEffect, useRef, useState } from 'react'
import { GitFork, Lock } from 'lucide-react'
import { StepCard, type StepState } from '@/components/mirror/step-card'
import { ActionStep, CliStep, GithubStep, KeyStep, ReadyCard, RepoStep, StorageStep, WaitStep, WayStep, WorkflowStep, storageChoice } from '@/components/mirror/mirror-steps'
import { Button } from '@/components/ui/button'
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
import { DOCS } from '@/lib/docs-links'
import { previewRepoCreate, readRefs, repoCreationFirsts, resolveAnyRepoWith } from '@/lib/repo'
import { KEY_REGISTER_CREDITS, PUSH_COST_DASH, previewCredits, sumPreviews } from '@/lib/sdk'
import { PLATFORM_PROFILE } from '@/lib/storage'
import { EMPTY_PROGRESS, clearMirrorProgress, loadMirrorProgress, refsFingerprint, resumed, saveMirrorProgress, withAnswer, type MirrorProgress, type RunnerKeyRecord } from '@/lib/mirror/progress'
import { mirrorRepoInput, suggestForgeName, suggestedRunnerBudget, type MirrorCliSettings } from '@/lib/mirror/wizard'
import { creditsAsDash, formatDate } from '@/lib/view/format'

type StepId = 'way' | 'github' | 'repo' | 'action' | 'storage' | 'key' | 'workflow' | 'wait' | 'cli'
const ACTION_STEPS: readonly StepId[] = ['storage', 'key', 'workflow', 'wait']
const TITLES: Readonly<Record<StepId, string>> = {
  way: 'Do you maintain the repo on GitHub?',
  github: 'The GitHub repository',
  action: 'The GitHub Action',
  cli: 'Run it on your computer',
  repo: 'The Forge repository',
  storage: 'Where the Action stores git data',
  key: 'The runner key',
  workflow: 'The workflow file and its secrets',
  wait: 'The first mirror run',
}

const DEFAULT_CLI = { name: null, collab: false, cap: '0.2' }
const MIRROR_PARAMS = ['way', 'repo', 'name', 'collab', 'cap']

/** Keep Next's router tree intact and tolerate Safari's history write limit. */
function replaceMirrorUrl(url: URL): void {
  const state: unknown = window.history.state
  if (state === null || typeof state !== 'object' || !('__NA' in state)) return
  if (url.href === window.location.href) return
  try {
    window.history.replaceState(state, '', url)
  } catch {
    // The answers still work in memory when the browser refuses an address update.
  }
}

function clearMirrorUrl(): void {
  const url = new URL(window.location.href)
  for (const param of MIRROR_PARAMS) url.searchParams.delete(param)
  replaceMirrorUrl(url)
}

/** Which steps are answered. */
function doneSteps(p: MirrorProgress): Readonly<Record<StepId, boolean>> {
  return {
    way: p.way !== null,
    github: p.github !== null && (p.way === 'cli' || p.rightsAcknowledged),
    action: p.actionLater !== null,
    cli: false,
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
    way: p.way === 'action' ? 'Automatic, with a GitHub Action' : 'From the command line',
    action: p.actionLater ? 'Not set up yet' : 'Setting it up',
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
  if (key.keyId < 0) return 'Added by you'
  return `Key ${key.keyId}: ${creditsAsDash(Number(key.budgetCredits))} DASH until ${formatDate(key.expiresAt)}`
}

/** Record a runner key in `identityId`'s saved progress, whatever the page shows now. */
async function saveRunnerKeyFor(identityId: string, runnerKey: RunnerKeyRecord): Promise<void> {
  try {
    const saved = (await loadMirrorProgress(ACTIVE_NETWORK.key, identityId)) ?? { ...EMPTY_PROGRESS, startedAt: Date.now() }
    await saveMirrorProgress(ACTIVE_NETWORK.key, identityId, withAnswer(saved, { runnerKey }))
  } catch {
    /* as update(): the key is on Platform either way; only the resume point is lost */
  }
}

export function MirrorWizard(): JSX.Element {
  const { identity, resuming } = useAuth()
  const { sdk } = useSdk()
  const storage = useStorageConfig()
  const forge = ACTIVE_NETWORK.v2
  const openedAt = useRef(Date.now())
  const [progress, setProgress] = useState<MirrorProgress>(EMPTY_PROGRESS)
  const progressRef = useRef(progress)
  const [loaded, setLoaded] = useState<string | null>(null)
  const [query, setQuery] = useState<URLSearchParams | null>(null)
  const [cli, setCli] = useState<{ name: string | null; collab: boolean; cap: string }>(DEFAULT_CLI)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setQuery(params)
    setCli({ name: params.get('name'), collab: params.get('collab') === '1', cap: params.get('cap') ?? '0.2' })
  }, [])
  const [reopened, setReopened] = useState<StepId | null>(null)
  // The runner key's `dfk1:` value lives only here, in this tab, until it is pasted into GitHub,
  // and only for the identity it was made on.
  const [makingKey, setMakingKey] = useState(true)
  const [made, setMade] = useState<{ identity: string; value: string } | null>(null)
  const secret = made !== null && made.identity === identity ? made.value : null
  // A sign-out or switch drops the value itself, not only from view: switching back must not
  // bring the last identity's key back. The value of a key that finishes after a switch is
  // never kept (see onCreated).
  const identityRef = useRef(identity)
  identityRef.current = identity
  useEffect(() => setMade(null), [identity])

  const show = useCallback((next: MirrorProgress): void => {
    progressRef.current = next
    setProgress(next)
  }, [])

  // Only a signed-out person's picks can carry into their newly signed-in identity.
  const previousIdentity = useRef<string | null>(null)
  useEffect(() => {
    const previous = previousIdentity.current
    previousIdentity.current = identity
    setReopened(null)
    if (previous !== null && previous !== identity) {
      clearMirrorUrl()
      setQuery(new URLSearchParams())
      setCli(DEFAULT_CLI)
    }
    if (identity === null) {
      // Signed out: nothing of the last identity's stays on the page. A GitHub repository
      // checked from here on is the signed-out person's own, and resumes with them.
      setLoaded(null)
      openedAt.current = Date.now()
      show(EMPTY_PROGRESS)
      return
    }
    if (previous !== null) show(EMPTY_PROGRESS)
    setLoaded(null)
    let live = true
    loadMirrorProgress(ACTIVE_NETWORK.key, identity).then(
      (saved) => {
        if (!live) return
        show(resumed(previous === null ? progressRef.current : EMPTY_PROGRESS, saved, openedAt.current))
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

  const settled = identity === null ? !resuming : loaded === identity
  useEffect(() => {
    if (!settled || query === null || progress.way !== null) return
    const way = query.get('way')
    if (way === 'action' || way === 'cli') update({ way })
  }, [settled, query, progress.way, update])

  const cliSettings: MirrorCliSettings = { ...cli, name: cli.name ?? suggestForgeName(progress.github?.name ?? '') }
  useEffect(() => {
    // No way chosen yet: a `?repo=` from a GitHub address stays until one is (sign-out clears it).
    if (!settled || query === null || progress.way === null) return
    // The Action path resumes from this identity's saved progress, never from the address.
    if (progress.way === 'action') {
      clearMirrorUrl()
      return
    }
    const timer = setTimeout(() => {
      const url = new URL(window.location.href)
      url.searchParams.set('way', 'cli')
      const source = progress.github ? `${progress.github.owner}/${progress.github.name}` : query.get('repo')
      if (source) url.searchParams.set('repo', source)
      if (progress.github !== null || cli.name !== null) url.searchParams.set('name', cliSettings.name)
      url.searchParams.set('collab', cliSettings.collab ? '1' : '0')
      url.searchParams.set('cap', cliSettings.cap)
      replaceMirrorUrl(url)
    }, 300)
    return () => clearTimeout(timer)
  }, [settled, query, progress.way, progress.github, cli.name, cliSettings.name, cliSettings.collab, cliSettings.cap])

  const restart = (): void => {
    setMade(null)
    setReopened(null)
    if (identity !== null) void clearMirrorProgress(ACTIVE_NETWORK.key, identity)
    clearMirrorUrl()
    setQuery(new URLSearchParams())
    setCli(DEFAULT_CLI)
    openedAt.current = Date.now()
    show({ ...EMPTY_PROGRESS, startedAt: openedAt.current })
  }

  const firsts = useAsync(() => repoCreationFirsts(sdk!, identity!, forge!.core), [identity ?? '', sdk !== null], { enabled: sdk !== null && identity !== null && forge !== null })

  const done = doneSteps(progress)
  const order: readonly StepId[] = progress.way === null
    ? ['way']
    : progress.way === 'cli'
      ? ['way', 'github', 'cli']
      : ['way', 'github', 'repo', 'action', ...(progress.actionLater === false ? ACTION_STEPS : [])]
  const current = reopened ?? order.find((s) => !done[s]) ?? (progress.actionLater === true ? null : 'wait')
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
    if (s === 'way') return <WayStep initial={progress.way} onDone={(way) => update({ way })} />
    if (s === 'github') return <GithubStep initial={progress.github} way={progress.way ?? 'action'} prefill={query?.get('repo')} settled={settled} onDone={(github) => {
      const source = `${github.owner}/${github.name}`
      if ((progress.github && source !== `${progress.github.owner}/${progress.github.name}`) ||
        (progress.way === 'cli' && query?.has('repo') && source !== query.get('repo'))) setCli((c) => ({ ...c, name: null }))
      update({ github, ...(progress.way === 'action' ? { rightsAcknowledged: true } : {}) })
    }} />
    if (s === 'cli' && progress.github) return (
      <>
        <CliStep github={progress.github} settings={cliSettings} onSettings={setCli} />
        <div className="space-y-2 border-t border-anvil-100 pt-3 dark:border-anvil-850">
          <button type="button" className="text-dense text-forge-700 underline dark:text-forge-400" onClick={() => update({ way: 'action' })}>Maintain it on GitHub? Keep it in sync automatically instead.</button>
          <div><Button variant="ghost" size="sm" onClick={restart}>Start over</Button></div>
        </div>
      </>
    )
    if (!signedIn || progress.github === null) {
      return identity === null ? <SignInGate /> : <p className="text-dense text-anvil-500 dark:text-anvil-400">Opening your progress…</p>
    }
    // A step after GitHub never opens without the acknowledgement (a record saved before it).
    if (!progress.rightsAcknowledged) return null
    const gh = progress.github
    switch (s) {
      case 'action':
        return <ActionStep onDone={(actionLater) => update({ actionLater })} />
      case 'repo':
        return <RepoStep sdk={sdk} forge={forge} identity={identity} github={gh} firsts={firstsOrNone} onDone={(repo, created) => update(created ? { repo, refsBefore: '' } : { repo })} />
      case 'storage':
        return <StorageStep storage={storage} github={gh} initial={progress.storage} onDone={(name) => update({ storage: name })} />
      case 'key':
        return (
          <KeyStep
            identity={identity}
            github={gh}
            record={progress.runnerKey}
            secret={secret}
            onMakingChange={setMakingKey}
            suggestedBudget={suggestedRunnerBudget(choice?.ok ? choice.kind : 's3', gh.sizeKib, PUSH_COST_DASH.perMib)}
            onCreated={(runnerKey, value) => {
              if (identityRef.current === identity) {
                setMade({ identity, value })
                update({ runnerKey })
              } else {
                // Finished after a switch or sign-out: the page is someone else's now, so leave it
                // alone. The key is registered on this identity, so its record (never the value)
                // goes into this identity's saved progress.
                void saveRunnerKeyFor(identity, runnerKey)
              }
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
            onBaseline={(refsBefore) => update({ refsBefore }, true)}
            onMirrored={(at) => update({ mirroredAt: at })}
            onRestart={restart}
          />
        )
    }
  }

  const repoCost =
    progress.way === 'action' && progress.github && !done.repo
      ? previewRepoCreate(mirrorRepoInput(progress.github, suggestForgeName(progress.github.name) || 'x'), firstsOrNone)
      : null
  const keyCost = progress.actionLater !== false || !makingKey || done.key || progress.runnerKey?.keyId === -1 ? null : previewCredits(KEY_REGISTER_CREDITS)
  const left = [repoCost, keyCost].filter((c) => c !== null)

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-raised ring-1 ring-inset ring-anvil-200 dark:ring-anvil-700">
          <GitFork className="h-5 w-5 text-fg-muted" aria-hidden />
        </span>
        <div>
          <h1 className="text-xl">Mirror a GitHub repository</h1>
          <p className="max-w-2xl text-dense text-anvil-500 dark:text-anvil-400">
            A copy on Dash Forge that nobody can take down. How you set it up depends on whether you maintain the repo on GitHub.
          </p>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <ol className="min-w-0 space-y-3" aria-label="Mirror setup steps">
          {order.map((s, i) => (
            <StepCard key={s} n={i + 1} id={s} title={TITLES[s]} state={stateOf(s)} summary={summaries[s]} optional={s === 'key'} onChange={s === 'wait' ? undefined : () => setReopened(s)}>
              {body(s)}
              {ACTION_STEPS.includes(s) && !done[s] ? <div className="border-t border-anvil-100 pt-3 dark:border-anvil-850"><Button variant="ghost" size="sm" onClick={() => update({ actionLater: true })}>Not now</Button></div> : null}
            </StepCard>
          ))}
          {progress.way === 'action' && progress.actionLater === true && signedIn && progress.github && progress.repo && current === null ? (
            <ReadyCard key={progress.repo.repoId} identity={identity} github={progress.github} repo={progress.repo} onSetup={() => update({ actionLater: false })} />
          ) : null}
        </ol>
        <aside aria-label={progress.way === 'cli' ? 'What you need' : 'What this writes to Platform'} className="h-fit space-y-3 rounded-lg border border-anvil-200 bg-white p-3 text-dense dark:border-anvil-800 dark:bg-anvil-900 lg:sticky lg:top-20">
          {progress.way === 'cli' ? (
            <>
              <h2 className="text-dense font-medium text-fg-muted">What you need</h2>
              <ul className="space-y-2">
                <RailItem label="dg and git-remote-dash" note={<>Build them from source with the <a href={DOCS.quickStart} className="underline">install guide</a>.</>} />
                <RailItem label="The GitHub CLI, signed in" note="It reads the source repo." />
                <RailItem label="A funded identity" note="The estimate comes before anything is written." />
              </ul>
            </>
          ) : progress.way === 'action' ? (
            <>
              <h2 className="text-dense font-medium text-anvil-500 dark:text-anvil-400">On Platform</h2>
              <ul className="space-y-2">
                <RailItem label="Forge repository" note={done.repo ? 'done' : 'the repo, its owner and settings'} />
                <RailItem label="Runner key" note={done.key ? 'optional · done' : 'optional · its budget is a cap, not a charge'} />
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
            </>
          ) : <p className="text-dense text-fg-muted">Choose how to make your copy.</p>}
        </aside>
      </div>
    </div>
  )
}

function RailItem({ label, note }: { label: string; note: React.ReactNode }): JSX.Element {
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
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">The mirror is owned by your identity. Setting it up costs a few thousandths of a DASH. Each run is capped.</p>
      <SignInButton label="long" />
    </div>
  )
}
