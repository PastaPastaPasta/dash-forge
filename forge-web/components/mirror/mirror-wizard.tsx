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
import { ACTIVE_NETWORK, DEFAULT_NETWORK } from '@/lib/constants'
import { previewRepoCreate, repoCreationFirsts } from '@/lib/repo'
import { KEY_REGISTER_CREDITS, previewCredits, sumPreviews } from '@/lib/sdk'
import { PLATFORM_PROFILE } from '@/lib/storage'
import { EMPTY_PROGRESS, clearMirrorProgress, loadMirrorProgress, saveMirrorProgress, type MirrorProgress } from '@/lib/mirror/progress'
import { mirrorDescription, type GithubRepo } from '@/lib/mirror/wizard'
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

export function MirrorWizard(): JSX.Element {
  const { identity } = useAuth()
  const { sdk } = useSdk()
  const storage = useStorageConfig()
  const forge = ACTIVE_NETWORK.v2
  const openedAt = useRef(Date.now())
  const [progress, setProgress] = useState<MirrorProgress>(EMPTY_PROGRESS)
  const [loaded, setLoaded] = useState<string | null>(null)
  const [reopened, setReopened] = useState<StepId | null>(null)
  // The runner key's `dfk1:` value lives only here, in this tab, until it is pasted into GitHub.
  const [secret, setSecret] = useState<string | null>(null)

  // Pick up where this identity stopped; a GitHub repo checked before signing in is kept.
  useEffect(() => {
    if (identity === null) return
    let live = true
    loadMirrorProgress(DEFAULT_NETWORK, identity).then(
      (saved) => {
        if (!live) return
        setProgress((now) => (saved === null ? { ...now, startedAt: now.startedAt || openedAt.current } : now.github !== null && saved.github === null ? { ...saved, github: now.github } : saved))
        setLoaded(identity)
      },
      () => live && setLoaded(identity),
    )
    return () => {
      live = false
    }
  }, [identity])

  const update = useCallback(
    (patch: Partial<MirrorProgress>): void => {
      setReopened(null)
      setProgress((p) => {
        const next = { ...p, ...patch, startedAt: p.startedAt || openedAt.current }
        if (identity !== null) void saveMirrorProgress(DEFAULT_NETWORK, identity, next).catch(() => undefined)
        return next
      })
    },
    [identity],
  )

  const firsts = useAsync(() => repoCreationFirsts(sdk!, identity!, forge!.core), [identity ?? '', sdk !== null], { enabled: sdk !== null && identity !== null && forge !== null })

  if (!isForgeDeployed() || forge === null) return <NotDeployedState />

  const done = doneSteps(progress)
  const current = reopened ?? ORDER.find((s) => !done[s]) ?? 'wait'
  const stateOf = (s: StepId): StepState => (s === current ? 'active' : done[s] ? 'done' : 'todo')
  const signedIn = identity !== null && loaded === identity
  const choice = storageChoice(progress.storage, storage.config?.profiles ?? [])
  const profile = storage.config?.profiles.find((p) => p.name === progress.storage) ?? null

  const summaries: Partial<Record<StepId, React.ReactNode>> = {
    github: progress.github ? <span className="font-mono">github.com/{progress.github.owner}/{progress.github.name}</span> : null,
    repo: progress.repo ? <span className="font-mono">{progress.repo.name}</span> : null,
    storage: progress.storage === PLATFORM_PROFILE ? 'Dash Platform' : progress.storage ? <span className="font-mono">{progress.storage}</span> : null,
    key:
      progress.runnerKey && progress.runnerKey.keyId >= 0
        ? `Key ${progress.runnerKey.keyId}: ${creditsAsDash(Number(progress.runnerKey.budgetCredits))} DASH until ${formatDate(progress.runnerKey.expiresAt)}`
        : progress.runnerKey
          ? 'Your own runner key'
          : null,
    workflow: progress.workflowAdded ? '.github/workflows/forge-mirror.yml' : null,
  }

  const setGithub = (github: GithubRepo): void => {
    const same = progress.github?.owner === github.owner && progress.github.name === github.name
    // Another source: its Forge repository and workflow are chosen again.
    update(same ? { github } : { github, repo: null, workflowAdded: false, mirroredAt: null })
  }

  const body = (s: StepId): React.ReactNode => {
    if (s === 'github') return <GithubStep initial={progress.github} onDone={setGithub} />
    if (!signedIn || progress.github === null) {
      return identity === null ? <SignInGate /> : <p className="text-dense text-anvil-500 dark:text-anvil-400">Opening your progress…</p>
    }
    const gh = progress.github
    switch (s) {
      case 'repo':
        return <RepoStep sdk={sdk} forge={forge} identity={identity} github={gh} onDone={(repo) => update({ repo })} />
      case 'storage':
        return <StorageStep storage={storage} github={gh} initial={progress.storage} onDone={(name) => update({ storage: name })} />
      case 'key':
        return (
          <KeyStep
            identity={identity}
            github={gh}
            record={progress.runnerKey}
            secret={secret}
            onCreated={(runnerKey, value) => {
              setSecret(value)
              update({ runnerKey })
            }}
            onDone={(runnerKey) => update({ runnerKey })}
          />
        )
      case 'workflow':
        if (progress.repo === null || choice === null) return null
        // A bucket's settings (and the keys to paste) are sealed in the vault: open it first.
        if (progress.storage !== PLATFORM_PROFILE && storage.needsUnlock) return <UnlockMore title="Unlock this tab to use your storage settings" testId="mirror-workflow-unlock" />
        if (progress.storage !== PLATFORM_PROFILE && storage.config === null) return <LoadingBlock label="Opening your storage settings" />
        if (!choice.ok) return <p className="text-dense text-caution-700 dark:text-caution-400">{choice.reason}</p>
        return <WorkflowStep identity={identity} github={gh} repoName={progress.repo.name} storage={choice} profile={profile} secret={secret} onDone={() => update({ workflowAdded: true })} />
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
              setSecret(null)
              void clearMirrorProgress(DEFAULT_NETWORK, identity)
              openedAt.current = Date.now()
              setProgress({ ...EMPTY_PROGRESS, startedAt: openedAt.current })
            }}
          />
        )
    }
  }

  const repoCost =
    progress.github && !done.repo
      ? previewRepoCreate({ name: progress.github.name.toLowerCase(), description: mirrorDescription(progress.github), defaultBranch: progress.github.defaultBranch }, firsts.data ?? { first: {}, rest: {} })
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
