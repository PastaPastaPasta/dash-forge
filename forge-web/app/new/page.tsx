'use client'

/**
 * `/new` — create a forge-v2 repository: three documents in forge-core (the `repo`, the
 * owner's `maintainer`, the first `config`), about 0.0013 DASH. The cost is previewed before
 * signing; the steps run one by one and are journaled in IndexedDB, so a closed tab offers
 * "Finish creating <name>" on the next visit instead of leaving a half-made repo. On success
 * the repo's empty state shows the push commands (`ux-dx-spec.md` §5.5).
 *
 * On a network without forge-v2 (testnet today) repos are not created from the browser: a v1
 * repo was its own ~1.18 DASH contract, and that path is gone.
 */

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, GitBranch, Hammer, Loader2, Lock, Terminal } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/ui/states'
import { NotDeployedState, isV2Deployed } from '@/components/ui/network-badge'
import { ACTIVE_NETWORK, DEFAULT_NETWORK } from '@/lib/constants'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import {
  createRepoV2,
  discardRepoCreation,
  normalizeRepoName,
  pendingRepoCreations,
  type CreateRepoInput,
  type CreateRepoStep,
  type RepoCreationJournal,
} from '@/lib/repo'
import { previewCreate, sumPreviews } from '@/lib/sdk'
import { errorMessage } from '@/lib/utils'

const STEPS: readonly { step: CreateRepoStep; label: string }[] = [
  { step: 'repo', label: 'Repository document' },
  { step: 'maintainer', label: 'You, as its first maintainer' },
  { step: 'config', label: 'Initial config (default branch)' },
]

type StepState = 'todo' | 'running' | 'done'
const INITIAL_PROGRESS: Record<CreateRepoStep, StepState> = { repo: 'todo', maintainer: 'todo', config: 'todo' }

export default function NewRepoPage(): JSX.Element {
  const router = useRouter()
  const { sdk } = useSdk()
  const { identity, signer } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const guard = useWriteGuard()
  const forge = ACTIVE_NETWORK.v2

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [confirm, setConfirm] = useState<CreateRepoInput | null>(null)
  const [progress, setProgress] = useState<Record<CreateRepoStep, StepState> | null>(null)
  const [pending, setPending] = useState<RepoCreationJournal[]>([])

  useEffect(() => {
    if (!identity) return
    pendingRepoCreations(DEFAULT_NETWORK, identity).then(setPending, () => setPending([]))
  }, [identity])

  const nameError = useMemo(() => {
    if (name.trim() === '') return null
    try {
      normalizeRepoName(name)
      return null
    } catch (e) {
      return errorMessage(e, 'invalid name')
    }
  }, [name])

  const input = (): CreateRepoInput => ({
    name: normalizeRepoName(name),
    ...(description.trim() ? { description: description.trim() } : {}),
    ...(defaultBranch.trim() && defaultBranch.trim() !== 'main' ? { defaultBranch: defaultBranch.trim() } : {}),
  })
  const costOf = (i: CreateRepoInput) =>
    sumPreviews([
      previewCreate('repo', { ...i, visibility: 'public' }),
      previewCreate('maintainer'),
      previewCreate('config', { defaultBranch: i.defaultBranch ?? 'main' }),
    ])
  const cost = costOf(name.trim() && nameError === null ? input() : { name: 'x' })

  const create = async (i: CreateRepoInput): Promise<void> => {
    if (!sdk || !signer || !forge) throw new Error('sign in first')
    setProgress(INITIAL_PROGRESS)
    const result = await createRepoV2(sdk, signer, forge, i, (step, state) =>
      setProgress((p) => ({ ...(p ?? INITIAL_PROGRESS), [step]: state === 'start' ? 'running' : 'done' })),
    )
    router.push(`/repo?owner=${encodeURIComponent(identity ?? '')}&name=${encodeURIComponent(result.name)}&created=1`)
  }

  if (!isV2Deployed()) {
    return (
      <AppShell>
        {ACTIVE_NETWORK.registryContractId !== null ? (
          <EmptyState
            icon={Terminal}
            title={`New repos are forge-v2, which ${ACTIVE_NETWORK.key} does not run yet`}
            body="Existing v1 repos here stay readable and writable (issues, comments, stars). A v1 repo was its own ~1.18 DASH contract; creating one from the browser is no longer offered."
          />
        ) : (
          <NotDeployedState />
        )}
      </AppShell>
    )
  }

  if (!identity) {
    return (
      <AppShell>
        <EmptyState
          icon={Lock}
          title="Sign in to forge a repo"
          body="Creating a repo writes three small documents signed by your identity."
          action={<Button variant="primary" onClick={openLogin}>Sign in</Button>}
        />
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-forge-500/15">
            <Hammer className="h-5 w-5 text-forge-500" aria-hidden />
          </span>
          <div>
            <h1 className="text-xl">Forge a new repo</h1>
            <p className="text-dense text-anvil-500 dark:text-anvil-400">Three documents on {ACTIVE_NETWORK.key}, owned by your identity.</p>
          </div>
        </div>

        {pending.map((j) => (
          <div key={j.input.name} className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense">
            <span className="flex-1">
              Creating <span className="font-mono">{j.input.name}</span> did not finish ({j.done.length} of 3 steps).
            </span>
            <Button size="sm" variant="primary" onClick={() => setConfirm(j.input)}>
              Finish creating {j.input.name}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void discardRepoCreation(DEFAULT_NETWORK, identity, j.input.name)
                setPending((p) => p.filter((x) => x !== j))
              }}
            >
              Dismiss
            </Button>
          </div>
        ))}

        <div className="space-y-4">
          <Field label="Repository name" htmlFor="repo-name" hint="Lowercase; letters, digits, and . _ - (max 63). The name is permanent.">
            <Input id="repo-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="forge-core" className="font-mono" spellCheck={false} autoFocus />
          </Field>
          {nameError ? <p className="-mt-2 text-[12px] text-danger">{nameError}</p> : null}

          <Field label="Description" htmlFor="repo-desc" hint="Shown in discovery. Optional; editable later.">
            <Textarea id="repo-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this repo for?" className="min-h-[72px]" maxLength={500} />
          </Field>

          <Field label="Default branch" htmlFor="repo-branch">
            <div className="relative">
              <GitBranch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-anvil-400" aria-hidden />
              <Input id="repo-branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} className="pl-8 font-mono" />
            </div>
          </Field>

          <CostPreview cost={cost} />
          <p className="-mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
            One-time. Code goes to storage you choose when you push; Platform keeps manifests and refs.
          </p>

          {progress ? (
            <ol aria-label="Creation steps" className="space-y-1 rounded-md border border-anvil-200 p-3 dark:border-anvil-800">
              {STEPS.map(({ step, label }) => (
                <li key={step} className="flex items-center gap-2 text-dense">
                  {progress[step] === 'done' ? (
                    <Check className="h-4 w-4 text-verify" aria-hidden />
                  ) : progress[step] === 'running' ? (
                    <Loader2 className="h-4 w-4 animate-spin text-anvil-400" aria-hidden />
                  ) : (
                    <span className="h-4 w-4 rounded-full border border-anvil-300 dark:border-anvil-700" aria-hidden />
                  )}
                  {label}
                </li>
              ))}
            </ol>
          ) : null}

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={name.trim() === '' || nameError !== null || guard.disabledReason !== null}
            title={guard.disabledReason ?? undefined}
            onClick={() => {
              if (guard.check(cost.credits)) setConfirm(input())
            }}
          >
            Create repository
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm ? `Create ${confirm.name}?` : 'Create repository?'}
        description="Writes the repo document, makes you its first maintainer, and records its config. Repos cannot be deleted (archive instead), and the name is permanent."
        cost={confirm ? costOf(confirm) : cost}
        confirmLabel="Sign & create"
        successNote="Created — opening your repo"
        onConfirm={() => (confirm ? create(confirm) : Promise.resolve())}
      />
    </AppShell>
  )
}
