'use client'

/**
 * `/new` — create a forge-v2 repository: three documents in forge-core (the `repo`, the
 * owner's `maintainer`, the first `config`), about 0.0013 DASH. The cost is previewed before
 * signing; the steps run one by one and are journaled in IndexedDB, so a closed tab offers
 * "Finish creating <name>" on the next visit instead of leaving a half-made repo. On success
 * the repo's empty state shows the push commands (`ux-dx-spec.md` §5.5).
 *
 * Visibility is chosen here only (immutable, `ux-dx-spec.md` §9 "Create"). A private repo needs
 * the owner's encryption key in this browser; its confirmation states the four facts `dg repo
 * create --private` prints, and its third step is the owner's epoch-0 key plus the sealed
 * anchor config (`private-repos.md` §5.3): four documents.
 *
 * On a network without forge-v2 the page shows "not deployed".
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Globe, GitBranch, Hammer, Loader2, Lock } from 'lucide-react'
import Link from 'next/link'
import { AppShell } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/ui/states'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'
import { ACTIVE_NETWORK, DEFAULT_NETWORK } from '@/lib/constants'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import {
  checkRepoInput,
  createRepo,
  discardRepoCreation,
  normalizeRepoName,
  pendingRepoCreations,
  type CreateRepoInput,
  type CreateRepoStep,
  type RepoCreationJournal,
} from '@/lib/repo'
import { createEpochZero } from '@/lib/repo/private-members'
import { encryptionOps } from '@/lib/auth/encryption-key'
import { useAsync } from '@/hooks/use-async'
import type { Visibility } from '@/lib/rules/v2'
import { previewCreate, sumPreviews } from '@/lib/sdk'
import { errorMessage } from '@/lib/utils'

const STEPS: readonly { step: CreateRepoStep; label: string; privateLabel?: string }[] = [
  { step: 'repo', label: 'Repository document' },
  { step: 'maintainer', label: 'You, as its first maintainer' },
  { step: 'config', label: 'Initial config (default branch)', privateLabel: 'Your repo key and the sealed config (default branch)' },
]

/**
 * What a private create states before it spends: the facts `dg repo create --private` prints
 * (`crates/dg/src/publish.rs` `PRIVATE_FACTS`; `ux-dx-spec.md` §9 "Create"), verbatim.
 */
const PRIVATE_FACTS: readonly string[] = [
  'private: code, ref names, issues, PRs, comments and reviews are encrypted to members',
  'visible to everyone: that it exists, its name, owner, members, sizes and timing, commit ids, and release notes, labels and event values (not encrypted in this release)',
  'members keep whatever they could already read, even after they are removed',
  'no recovery: if every member loses their encryption key, the contents are gone',
]

/** The CLI's note when a private create has a description (`publish.rs`). */
const PUBLIC_DESCRIPTION_NOTE = 'note: the description and display name are public; leave them empty to keep them private'

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
  const [visibility, setVisibility] = useState<Visibility>('public')
  const isPrivate = visibility === 'private'
  // A private create wraps its key from the encryption key in this browser's vault.
  const ops = useAsync(
    () => encryptionOps(sdk!, DEFAULT_NETWORK, identity!, forge!.core),
    [sdk !== null, identity ?? '', forge?.core ?? '', isPrivate],
    { enabled: isPrivate && sdk !== null && identity !== null && forge !== null },
  )
  const noKey = isPrivate && ops.data === null && !ops.loading
  const [confirm, setConfirm] = useState<CreateRepoInput | null>(null)
  const [progress, setProgress] = useState<Record<CreateRepoStep, StepState> | null>(null)
  const [pending, setPending] = useState<RepoCreationJournal[]>([])

  const reloadPending = useCallback(() => {
    if (!identity) return
    pendingRepoCreations(DEFAULT_NETWORK, identity).then(setPending, () => setPending([]))
  }, [identity])
  useEffect(reloadPending, [reloadPending])

  const nameError = useMemo(() => {
    if (name.trim() === '') return null
    try {
      checkRepoInput({ name: normalizeRepoName(name), description })
      return null
    } catch (e) {
      return errorMessage(e, 'invalid name')
    }
  }, [name, description])
  // An unfinished creation of this name resumes with the values it started with.
  const resuming = useMemo(() => {
    if (nameError !== null || name.trim() === '') return null
    const n = normalizeRepoName(name)
    return pending.find((j) => j.input.name === n) ?? null
  }, [name, nameError, pending])
  const differs =
    resuming !== null &&
    ((resuming.input.description ?? '') !== description.trim() || (resuming.input.defaultBranch ?? 'main') !== (defaultBranch.trim() || 'main'))

  const input = (): CreateRepoInput => ({
    name: normalizeRepoName(name),
    ...(description.trim() ? { description: description.trim() } : {}),
    ...(defaultBranch.trim() && defaultBranch.trim() !== 'main' ? { defaultBranch: defaultBranch.trim() } : {}),
    ...(isPrivate ? { visibility: 'private' as const } : {}),
  })
  const costOf = (i: CreateRepoInput) =>
    i.visibility === 'private'
      ? sumPreviews([
          previewCreate('repo', { name: i.name, visibility: 'private', ...(i.description ? { description: i.description } : {}) }),
          previewCreate('maintainer'),
          previewCreate('repoKey'),
          previewCreate('config', { enc: new Uint8Array(80), epoch: 0, backend: { mode: 0 } }),
        ])
      : sumPreviews([
          previewCreate('repo', { ...i, visibility: 'public' }),
          previewCreate('maintainer'),
          previewCreate('config', { defaultBranch: i.defaultBranch ?? 'main' }),
        ])
  const cost = costOf(name.trim() && nameError === null ? input() : { name: 'x' })

  const create = async (i: CreateRepoInput): Promise<void> => {
    if (!sdk || !signer || !forge) throw new Error('sign in first')
    setProgress(INITIAL_PROGRESS)
    let result
    try {
      const privateCreate =
        i.visibility === 'private'
          ? await (async () => {
              const o = await encryptionOps(sdk, DEFAULT_NETWORK, signer.identityId, forge.core)
              if (o === null) throw new Error('cannot create a private repository: add your encryption key to this browser first (Settings → Keys)')
              return { ops: o, epochZero: createEpochZero }
            })()
          : undefined
      result = await createRepo(
        sdk,
        signer,
        forge,
        i,
        (step, state) => setProgress((p) => ({ ...(p ?? INITIAL_PROGRESS), [step]: state === 'start' ? 'running' : 'done' })),
        privateCreate,
      )
    } catch (e) {
      setProgress(null)
      throw e
    } finally {
      reloadPending()
    }
    router.push(`/repo?owner=${encodeURIComponent(identity ?? '')}&name=${encodeURIComponent(result.name)}&created=1`)
  }

  if (!isForgeDeployed()) {
    return (
      <AppShell>
        <NotDeployedState />
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
          action={<Button variant="primary" onClick={() => openLogin()}>Sign in</Button>}
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
          {nameError ? <p className="-mt-2 text-[12px] text-danger-700 dark:text-danger-400">{nameError}</p> : null}

          <Field label="Description" htmlFor="repo-desc" hint="Shown in discovery. Optional; editable later.">
            <Textarea id="repo-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this repo for?" className="min-h-[72px]" maxLength={500} />
          </Field>

          <fieldset>
            <legend className="mb-1 text-dense font-medium">Visibility</legend>
            <div role="radiogroup" aria-label="Visibility" className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['public', Globe, 'Public', 'Anyone can read it.'],
                  ['private', Lock, 'Private', 'Encrypted to its members. Set now; it cannot change later.'],
                ] as const
              ).map(([v, Icon, label, hint]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={visibility === v}
                  data-testid={`visibility-${v}`}
                  onClick={() => setVisibility(v)}
                  className={
                    'flex items-start gap-2 rounded-md border p-3 text-left text-dense ' +
                    (visibility === v ? 'border-forge-500 bg-forge-500/10' : 'border-anvil-200 dark:border-anvil-750')
                  }
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500" aria-hidden />
                  <span>
                    <span className="font-medium">{label}</span>
                    <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">{hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
          {isPrivate ? (
            <div className="rounded-md border border-anvil-200 p-3 text-[12px] text-anvil-600 dark:border-anvil-750 dark:text-anvil-300" data-testid="private-facts">
              <ul className="list-disc space-y-0.5 pl-4">
                {PRIVATE_FACTS.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {description.trim() ? <p className="mt-2 text-caution">{PUBLIC_DESCRIPTION_NOTE}</p> : null}
              {noKey ? (
                <p className="mt-2 text-caution" data-testid="private-no-key">
                  cannot create a private repository: your identity has no encryption key in this browser. Add it in{' '}
                  <Link href="/settings" className="text-forge-700 underline dark:text-forge-400">
                    Settings → Keys → Enable private repos
                  </Link>
                  .
                </p>
              ) : null}
            </div>
          ) : null}

          <Field label="Default branch" htmlFor="repo-branch">
            <div className="relative">
              <GitBranch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-anvil-500 dark:text-anvil-400" aria-hidden />
              <Input id="repo-branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} className="pl-8 font-mono" />
            </div>
          </Field>

          {differs ? (
            <p className="text-[12px] text-caution-700 dark:text-caution-400">
              An unfinished creation of this name started with a different description or branch; finishing it keeps those
              values. Change them after it exists.
            </p>
          ) : null}
          <CostPreview cost={cost} />
          <p className="-mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
            One-time. Code goes to storage you choose when you push; Platform keeps manifests and refs.
          </p>

          {progress ? (
            <ol aria-label="Creation steps" className="space-y-1 rounded-md border border-anvil-200 p-3 dark:border-anvil-800">
              {STEPS.map(({ step, label }) => (
                <li key={step} className="flex items-center gap-2 text-dense">
                  {progress[step] === 'done' ? (
                    <Check className="h-4 w-4 text-verify-700 dark:text-verify-400" aria-hidden />
                  ) : progress[step] === 'running' ? (
                    <Loader2 className="h-4 w-4 animate-spin text-anvil-500 dark:text-anvil-400" aria-hidden />
                  ) : (
                    <span className="h-4 w-4 rounded-full border border-anvil-300 dark:border-anvil-700" aria-hidden />
                  )}
                  {isPrivate ? (STEPS.find((x) => x.step === step)?.privateLabel ?? label) : label}
                </li>
              ))}
            </ol>
          ) : null}

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={name.trim() === '' || nameError !== null || guard.disabledReason !== null || (isPrivate && ops.data == null)}
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
        description={
          confirm?.visibility === 'private'
            ? `Writes the repo document, makes you its first maintainer, and records your repo key and its sealed config. ${PRIVATE_FACTS.join('. ')}. Repos cannot be deleted (archive instead); the name and visibility are permanent.`
            : 'Writes the repo document, makes you its first maintainer, and records its config. Repos cannot be deleted (archive instead), and the name is permanent.'
        }
        cost={confirm ? costOf(confirm) : cost}
        confirmLabel="Sign & create"
        successNote="Created — opening your repo"
        onConfirm={() => (confirm ? create(confirm) : Promise.resolve())}
      />
    </AppShell>
  )
}
