'use client'

/**
 * The steps of the `/mirror` wizard (`components/mirror/mirror-wizard.tsx` orders them and keeps
 * their answers). Each step settles one fact and reports it with `onDone`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EvoSDK } from '@dashevo/evo-sdk'
import { AlertTriangle, CheckCircle2, ExternalLink, GitFork, Loader2, Plus } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { CopyRow } from '@/components/ui/copy-row'
import { SecretValue } from '@/components/ui/secret-value'
import { CostPreview } from '@/components/ui/cost-preview'
import { FiatNote } from '@/components/ui/fiat-note'
import { CopyBlock } from '@/components/storage/copy-block'
import { StorageWizardView } from '@/components/storage/storage-wizard'
import { UnlockMore } from '@/components/auth/unlock-more'
import { useMasterKeyInput } from '@/components/auth/master-key-input'
import { Hint, LinkButton, linkButtonClass } from '@/components/mirror/step-card'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import type { StorageConfigState } from '@/hooks/use-storage-config'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { DOCS } from '@/lib/docs-links'
import { dgNetworkFlags } from '@/lib/view/repo-commands'
import { MIRROR_NAMED_PAGES, reposNamed } from '@/lib/view/discovery'
import { matchUpstream } from '@/lib/view/upstream-alias'
import type { ForgeIds } from '@/lib/deployments'
import { parseDashAmount } from '@/lib/auth'
import { createRepo, normalizeRepoName, previewRepoCreate, readRefs, branchesOf, tagsOf, resolveAnyRepoWith, type CreateRepoStep, type RepoCreationFirsts } from '@/lib/repo'
import { CREDITS_PER_DASH, KEY_REGISTER_CREDITS, PUSH_COST_DASH, previewCredits } from '@/lib/sdk'
import { creditsToDash } from '@/lib/sdk/cost'
import { corsFix, PLATFORM_PROFILE, type StorageProfile } from '@/lib/storage'
import { creditsAsDash, formatDate, plural, shortIdentity } from '@/lib/view/format'
import {
  DASH_FORGE_REPO,
  PLATFORM_STORAGE,
  RUNNER_KEY_DEFAULTS,
  checkGithubRepo,
  GithubCheckError,
  mirrorCliCommands,
  type MirrorCliSettings,
  costCapProblem,
  cliCostCapProblem,
  ACTION_COST_CAP,
  defaultCostCap,
  dfk1,
  latestCommit,
  LFS_NOTE,
  licenseNotice,
  mirrorRepoInput,
  mirrorStorageOf,
  newSecretUrl,
  newWorkflowUrl,
  parseGithubRepo,
  RIGHTS_ACKNOWLEDGEMENT,
  suggestForgeName,
  workflowRunsUrl,
  workflowSecrets,
  workflowYaml,
  type GithubRepo,
  type LicenseNotice,
  type MirrorStorage,
  type UsableMirrorStorage,
} from '@/lib/mirror/wizard'
import { refsFingerprint, type MirrorProgress, type MirrorWay, type RunnerKeyRecord } from '@/lib/mirror/progress'
import { cn, errorMessage } from '@/lib/utils'
import { spendAction } from '@/lib/spend-toast'

const DAY_MS = 24 * 60 * 60 * 1000
const BUILD_COMMIT = process.env.FORGE_BUILD_COMMIT ?? ''

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function mib(kib: number): string {
  return kib < 1024 ? `${kib} KiB` : `${(kib / 1024).toFixed(1)} MiB`
}

// ---------------------------------------------------------------------------
// 1. GitHub repository
// ---------------------------------------------------------------------------

export function GithubStep({ initial, way = 'action', prefill = null, settled = true, onDone }: {
  initial: GithubRepo | null
  way?: MirrorWay
  prefill?: string | null
  settled?: boolean
  onDone: (repo: GithubRepo) => void
}): JSX.Element {
  const [text, setText] = useState(initial ? `${initial.owner}/${initial.name}` : prefill ?? '')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Path B only: GitHub would not show it publicly (private, or no such repo).
  const [hidden, setHidden] = useState<'private' | 'not-found' | null>(null)
  const [found, setFound] = useState<GithubRepo | null>(initial)
  const [acknowledged, setAcknowledged] = useState(false)
  const autoChecked = useRef(false)
  const check = useCallback(async (input: string): Promise<void> => {
    setError(null)
    setHidden(null)
    setFound(null)
    setAcknowledged(false)
    setChecking(true)
    try {
      setFound(await checkGithubRepo(parseGithubRepo(input)))
    } catch (e) {
      setError(errorMessage(e))
      setHidden(e instanceof GithubCheckError && (e.kind === 'private' || e.kind === 'not-found') ? e.kind : null)
    } finally {
      setChecking(false)
    }
  }, [])

  // A URL checks only after auth and saved progress settle, and never answers the step.
  useEffect(() => {
    if (!settled || initial !== null || !prefill || autoChecked.current || text !== prefill) return
    autoChecked.current = true
    setText(prefill)
    void check(prefill)
  }, [settled, initial, prefill, check, text])

  return (
    <>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault()
          void check(text)
        }}
      >
        <div className="min-w-0 flex-1">
          <Field label="GitHub repository" htmlFor="mirror-github">
            <Input id="mirror-github" value={text} onChange={(e) => setText(e.target.value)} placeholder="owner/name, or paste its URL" className="font-mono" spellCheck={false} autoCapitalize="off" autoComplete="off" autoFocus />
          </Field>
        </div>
        <Button type="submit" variant={found ? 'outline' : 'primary'} loading={checking} disabled={text.trim() === ''}>
          Check on GitHub
        </Button>
      </form>
      <Hint>Public repositories only. Asked from your browser, anonymously: no GitHub sign-in, and nothing passes through a Forge server (there is none).</Hint>
      {error && !(way === 'cli' && hidden !== null) ? <Hint tone="danger">{error}</Hint> : null}
      {way === 'cli' && hidden === 'not-found' ? <Hint tone="danger">GitHub doesn&apos;t show this repo publicly. Check its owner and name.</Hint> : null}
      {way === 'cli' && hidden !== null ? (
        <Hint>This page can&apos;t check private GitHub repositories. <a href={DOCS.mirrorPrivate} className="underline">The guide shows how to copy one into a private Forge repo.</a></Hint>
      ) : null}
      {found ? (
        <div className="space-y-3 rounded-md border border-verify/30 bg-verify/5 p-3" data-testid="mirror-github-found">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-dense">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-verify-700 dark:text-verify-400" aria-hidden />
            <a href={found.htmlUrl} target="_blank" rel="noopener noreferrer" className="font-mono font-medium text-anvil-900 underline-offset-2 hover:underline dark:text-anvil-50">
              github.com/{found.owner}/{found.name}
            </a>
            <span className="text-anvil-500 dark:text-anvil-400">public · default branch <span className="font-mono">{found.defaultBranch}</span> · {mib(found.sizeKib)}</span>
          </p>
          {found.description ? <p className="text-dense text-anvil-600 dark:text-anvil-300">{found.description}</p> : null}
          {found.archived ? <Hint tone="caution">Archived on GitHub: the mirror gets what is there now, and nothing new will arrive.</Hint> : null}
          {found.sizeKib === 0 ? <Hint tone="caution">GitHub reports it as empty: the first run has nothing to push until something is pushed there.</Hint> : null}
          <LicenseLine repo={found} />
          <Hint>{LFS_NOTE}</Hint>
          <AlreadyMirrored github={found} />
          {way === 'action' ? <label className="flex items-start gap-2 text-dense" data-testid="mirror-rights">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-forge-700" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>{RIGHTS_ACKNOWLEDGEMENT}</span>
          </label> : null}
          <Button variant="primary" disabled={way === 'action' && !acknowledged} onClick={() => onDone(found)}>
            {way === 'cli' ? 'Continue' : `Mirror ${found.owner}/${found.name}`}
          </Button>
        </div>
      ) : null}
    </>
  )
}

/** A mirror claim is information, never a reason to stop someone making their own copy. */
function AlreadyMirrored({ github }: { github: GithubRepo }): JSX.Element | null {
  const { sdk, network } = useSdk()
  const found = useAsync(() => reposNamed(sdk!, github.name.toLowerCase(), { network, pages: MIRROR_NAMED_PAGES }), [sdk !== null, network, github.owner, github.name], { enabled: sdk !== null })
  const match = found.data ? matchUpstream(github.owner, github.name, found.data) : null
  if (!match || match.mirrors.length === 0) return null
  return (
    <Hint>
      {match.partial ? 'At least ' : ''}{plural(match.mirrors.length, 'Forge repo says it mirrors', 'Forge repos say they mirror')} github.com/{github.owner}/{github.name}.{' '}
      <Link href={`/github.com/${github.owner}/${github.name}/`} className="underline">See them</Link>. Anyone can keep their own copy.
    </Hint>
  )
}

/**
 * The licence GitHub detected, and what to check before copying (LEG-10). The wizard never signs
 * in to GitHub, so it cannot tell whether the repository is the person's own: it always asks.
 */
function LicenseLine({ repo }: { repo: GithubRepo }): JSX.Element {
  return (
    <div className="space-y-1" data-testid="mirror-license">
      <LicenseStatus notice={licenseNotice(repo)} />
      <Hint>Mirror a repository you own, or one whose licence lets you copy it. The copy, and every issue and comment in it, is public on Dash Platform and cannot be deleted from it.</Hint>
    </div>
  )
}

function LicenseStatus({ notice }: { notice: LicenseNotice }): JSX.Element {
  if (notice.unread) return <Hint tone="caution">This repository was checked before its licence was read. Check on GitHub again to see it.</Hint>
  if (notice.label !== null && !notice.warn) {
    return (
      <p className="text-dense text-anvil-600 dark:text-anvil-300">
        Licence detected by GitHub: <span className="font-mono">{notice.label}</span>
      </p>
    )
  }
  return (
    <Hint tone="caution">
      {notice.label === null
        ? 'GitHub detects no licence for this repository. Without one you may have no right to copy it.'
        : 'GitHub detects a licence it cannot name for this repository. Read it before you copy.'}
    </Hint>
  )
}

// ---------------------------------------------------------------------------
// 2. The Forge repository
// ---------------------------------------------------------------------------

const CREATE_STEPS: readonly [CreateRepoStep, string][] = [
  ['repo', 'The repo'],
  ['maintainer', 'You, as its first maintainer'],
  ['config', 'Config (default branch)'],
]

function CreateStepIcon({ state }: { state: 'running' | 'done' | undefined }): JSX.Element {
  if (state === 'done') return <CheckCircle2 className="h-4 w-4 text-verify-700 dark:text-verify-400" aria-hidden />
  if (state === 'running') return <Loader2 className="h-4 w-4 animate-spin text-anvil-500" aria-hidden />
  return <span className="h-4 w-4 rounded-full border border-anvil-300 dark:border-anvil-700" aria-hidden />
}

export function RepoStep({
  sdk,
  forge,
  identity,
  github,
  firsts,
  onDone,
}: {
  sdk: EvoSDK | null
  forge: ForgeIds
  identity: string
  github: GithubRepo
  /** Which of the creation's documents are this identity's first (priced higher). */
  firsts: RepoCreationFirsts
  /** `created`: the wizard made it just now (so it has no refs yet). */
  onDone: (repo: { repoId: string; name: string }, created: boolean) => void
}): JSX.Element {
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const [name, setName] = useState(() => suggestForgeName(github.name))
  const debounced = useDebounced(name.trim(), 400)
  let normalized: string | null = null
  let nameError: string | null = null
  try {
    normalized = debounced === '' ? null : normalizeRepoName(debounced)
  } catch (e) {
    nameError = errorMessage(e)
  }
  const existing = useAsync(() => resolveAnyRepoWith(sdk!, forge, { owner: identity, name: normalized! }), [identity, normalized ?? '', sdk !== null], {
    enabled: sdk !== null && normalized !== null,
  })
  const input = mirrorRepoInput(github, normalized ?? 'x')
  const description = input.description
  const cost = previewRepoCreate(input, firsts)
  const [progress, setProgress] = useState<Partial<Record<CreateRepoStep, 'running' | 'done'>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const settled = normalized !== null && debounced === name.trim() && existing.settled && existing.error === null

  const create = async (): Promise<void> => {
    if (!signer || !sdk || normalized === null) return
    if (!guard.check(cost, 'core', 'create the mirror repository')) return
    setError(null)
    setProgress({})
    try {
      const r = await spendAction({ running: 'Creating the repository…', done: 'Repository created', failed: 'Repository creation stopped part-way' }, (tag) =>
        createRepo(sdk, tag(signer), forge, input, (step, state) => setProgress((p) => ({ ...p, [step]: state === 'start' ? 'running' : 'done' }))),
      )
      onDone({ repoId: r.repoId, name: r.name }, true)
    } catch (e) {
      setProgress(null)
      setError(guard.failed(e))
    }
  }

  return (
    <>
      <Field label="Forge repository name" htmlFor="mirror-forge-name" hint="Yours, on Dash Platform. Lowercase letters, digits and . _ - (max 63). Permanent.">
        <Input id="mirror-forge-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" spellCheck={false} autoCapitalize="off" autoComplete="off" />
      </Field>
      {nameError ? <Hint tone="danger">{nameError}</Hint> : null}
      {existing.error ? <Hint tone="danger">Could not check the name: {existing.error}</Hint> : null}
      {settled && existing.data ? (
        <div className="space-y-2 rounded-md border border-anvil-200 p-3 dark:border-anvil-750" data-testid="mirror-repo-existing">
          <p className="text-dense">
            You already have <span className="font-mono font-medium">{existing.data.doc.name}</span>
            {existing.data.doc.createdAt ? `, created ${formatDate(existing.data.doc.createdAt)}` : ''}. The mirror writes into it: nothing to create, no cost.
          </p>
          {existing.data.doc.visibility === 'private' ? <Hint tone="caution">It is private: what the Action mirrors is encrypted to its members.</Hint> : null}
          <Button variant="primary" onClick={() => onDone({ repoId: existing.data!.doc.repoId, name: existing.data!.doc.name }, false)}>
            Mirror into {existing.data.doc.name}
          </Button>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-dense">
            <dt className="text-anvil-500 dark:text-anvil-400">Description</dt>
            <dd className="min-w-0 break-words">{description}</dd>
            <dt className="text-anvil-500 dark:text-anvil-400">Default branch</dt>
            <dd className="font-mono">{github.defaultBranch}</dd>
          </dl>
          <CostPreview cost={cost} />
          <Hint>Paid once: the repo, you as its maintainer, and its settings. The description names the GitHub source.</Hint>
          {progress ? (
            <ol aria-label="Creation steps" className="space-y-1 text-dense">
              {CREATE_STEPS.map(([step, label]) => (
                <li key={step} className="flex items-center gap-2">
                  <CreateStepIcon state={progress[step]} />
                  {label}
                </li>
              ))}
            </ol>
          ) : null}
          {error ? <Hint tone="danger">{error}</Hint> : null}
          <Button variant="primary" onClick={() => void create()} loading={progress !== null} disabled={!settled || guard.disabledReason !== null} title={guard.disabledReason ?? undefined}>
            Sign &amp; create {normalized ?? 'the repository'}
          </Button>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// 3. Storage
// ---------------------------------------------------------------------------

/** The storage choice's name → what the Action gets, given the saved profiles. */
export function storageChoice(name: string | null, profiles: readonly StorageProfile[]): MirrorStorage | null {
  if (name === null) return null
  if (name === PLATFORM_PROFILE) return PLATFORM_STORAGE
  const p = profiles.find((x) => x.name === name)
  return p ? mirrorStorageOf(p) : { ok: false, reason: `The storage profile ${name} is no longer in this browser. Pick storage again.` }
}

function optionClass(selected: boolean): string {
  return cn('flex items-start gap-2.5 rounded-md border p-3 text-dense', selected ? 'border-forge-500 bg-forge-500/5' : 'border-anvil-200 dark:border-anvil-750')
}

function storageButtonLabel(picked: string | null): string {
  if (picked === PLATFORM_PROFILE) return 'Use Dash Platform'
  if (picked) return `Use ${picked}`
  return 'Pick where the mirror stores git data'
}

export function StorageStep({ storage, github, initial, onDone }: { storage: StorageConfigState; github: GithubRepo; initial: string | null; onDone: (name: string) => void }): JSX.Element {
  const { config, needsUnlock, storable } = storage
  const [adding, setAdding] = useState(false)
  const profiles = (config?.profiles ?? []).filter((p) => p.settings.kind !== 'platform')
  const [picked, setPicked] = useState<string | null>(initial)
  // A profile saved in the embedded wizard is picked for the mirror at once (not one that merely
  // finished loading).
  const names = profiles.map((p) => p.name)
  const [seen, setSeen] = useState(names)
  if (names.join('\n') !== seen.join('\n')) {
    setSeen(names)
    // Profiles are kept sorted by name: the new one is the name not seen before.
    const added = names.find((n) => !seen.includes(n))
    if (adding && added !== undefined) {
      setPicked(added)
      setAdding(false)
    }
  }
  const choice = storageChoice(picked, config?.profiles ?? [])
  const profile = profiles.find((p) => p.name === picked) ?? null
  const origin = typeof window === 'undefined' ? 'https://forge.dashhq.org' : window.location.origin
  const cors = profile?.settings.kind === 's3' ? { bucket: profile.settings.bucket, ...corsFix(profile.settings.provider, profile.settings.bucket, origin) } : null
  const platformDash = (github.sizeKib / 1024) * PUSH_COST_DASH.perMib
  const firstPushDash = platformDash < 0.01 ? '0.01' : platformDash.toFixed(2)

  if (needsUnlock) return <UnlockMore title="Unlock this tab to use your storage settings" testId="mirror-storage-unlock" />

  return (
    <>
      <p className="text-dense text-anvil-600 dark:text-anvil-300">
        Where the mirror&apos;s git data goes. <strong className="font-medium">Recommended: a Cloudflare R2 or S3 bucket of your own.</strong> Platform then keeps only each push&apos;s manifest and refs (about {PUSH_COST_DASH.byo.max} DASH a push<FiatNote dash={PUSH_COST_DASH.byo.max} />), and readers check every byte against the recorded hash.
      </p>
      <fieldset className="space-y-2">
        <legend className="sr-only">Storage for the mirror</legend>
        {profiles.map((p) => {
          const m = mirrorStorageOf(p)
          const test = config?.lastTests[p.name]
          return (
            <label
              key={p.name}
              className={cn(optionClass(picked === p.name), !m.ok && 'opacity-70')}
            >
              <input type="radio" name="mirror-storage" className="mt-0.5 h-4 w-4 accent-forge-700" checked={picked === p.name} disabled={!m.ok} onChange={() => setPicked(p.name)} />
              <span className="min-w-0">
                <span className="font-mono font-medium">{p.name}</span>{' '}
                <span className="text-anvil-500 dark:text-anvil-400">
                  {p.settings.kind === 's3' ? `${p.settings.bucket} · ${new URL(p.settings.endpoint).host}` : p.settings.kind}
                  {test ? ` · ${test.ok ? 'passed its checks' : 'failed some checks'} ${formatDate(test.at)}` : ''}
                </span>
                {!m.ok ? <span className="mt-1 block text-[12px] text-caution-700 dark:text-caution-400">{m.reason}</span> : null}
              </span>
            </label>
          )
        })}
        <label className={optionClass(picked === PLATFORM_PROFILE)}>
          <input type="radio" name="mirror-storage" className="mt-0.5 h-4 w-4 accent-forge-700" checked={picked === PLATFORM_PROFILE} onChange={() => setPicked(PLATFORM_PROFILE)} data-testid="mirror-storage-platform" />
          <span>
            <span className="font-medium">Dash Platform</span>{' '}
            <span className="text-anvil-500 dark:text-anvil-400">
              nothing to set up · permanent · about {PUSH_COST_DASH.perMib} DASH per MiB<FiatNote dash={PUSH_COST_DASH.perMib} />
              {github.sizeKib > 0 ? <>, so about {firstPushDash} DASH for this repository&apos;s first push<FiatNote dash={Number(firstPushDash)} /></> : null}
            </span>
          </span>
        </label>
      </fieldset>

      {adding ? (
        <div className="rounded-lg border border-anvil-200 p-3 dark:border-anvil-800" data-testid="mirror-storage-wizard">
          <StorageWizardView storage={storage} embedded />
          <Button variant="ghost" size="sm" className="mt-3" onClick={() => setAdding(false)}>
            Close
          </Button>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setAdding(true)} disabled={!storable}>
          <Plus className="h-4 w-4" aria-hidden /> Add a bucket (R2, S3, B2, Garage…)
        </Button>
      )}
      {!storable ? <Hint tone="caution">This tab signs with a pasted key, which cannot keep storage settings: sign in with your identity to add a bucket, or use Platform.</Hint> : null}

      {cors ? (
        <details className="rounded-md border border-anvil-200 p-3 text-dense dark:border-anvil-750" data-testid="mirror-cors">
          <summary className="cursor-pointer font-medium">CORS for {cors.bucket}: needed for the web to read it</summary>
          <p className="my-2 text-[12px] text-anvil-500 dark:text-anvil-400">{cors.where}</p>
          <CopyBlock text={cors.text} label="Copy the CORS policy" />
          <Hint>The Action itself needs no CORS. Readers of the mirror in a browser do. The storage test checks it.</Hint>
        </details>
      ) : null}

      <Button variant="primary" disabled={choice === null || !choice.ok} onClick={() => picked && onDone(picked)}>
        {storageButtonLabel(picked)}
      </Button>
    </>
  )
}

// ---------------------------------------------------------------------------
// 4. The runner key
// ---------------------------------------------------------------------------

export function KeyStep({
  identity,
  github,
  record,
  secret,
  suggestedBudget,
  onMakingChange,
  onCreated,
  onDone,
}: {
  identity: string
  github: GithubRepo
  record: RunnerKeyRecord | null
  /** The budget to start from (more than the default when the mirror stores packs on Platform). */
  suggestedBudget: string
  onMakingChange?: (making: boolean) => void
  /** The new key's `dfk1:` value, while this tab holds it (it is never stored). */
  secret: string | null
  onCreated: (record: RunnerKeyRecord, secret: string) => void
  onDone: (record: RunnerKeyRecord) => void
}): JSX.Element {
  // The master key signs this update and the identity's balance pays for it: this browser's own
  // key (its budget, expiry and grants) plays no part, so the write guard does not apply.
  const { createRunnerKey, isLoading, balance } = useAuth()
  const master = useMasterKeyInput(identity, { id: 'runner', fileLabel: 'Identity file for the runner key' })
  const [budget, setBudget] = useState(suggestedBudget)
  const [days, setDays] = useState(String(RUNNER_KEY_DEFAULTS.days))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [keyWay, setKeyWay] = useState<'make' | 'own'>('make')
  useEffect(() => onMakingChange?.(keyWay === 'make'), [keyWay, onMakingChange])

  let credits: bigint | null = null
  let budgetError: string | null = null
  try {
    credits = parseDashAmount(budget)
  } catch (e) {
    budgetError = errorMessage(e)
  }
  const dayCount = Number(days)
  const daysError = Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 365 ? null : 'from 1 to 365 days'
  const fee = previewCredits(KEY_REGISTER_CREDITS)
  const tooPoor = balance !== null && BigInt(balance) < BigInt(KEY_REGISTER_CREDITS)
  const until = Date.now() + (daysError ? RUNNER_KEY_DEFAULTS.days : dayCount) * DAY_MS

  const create = async (): Promise<void> => {
    if (credits === null || daysError !== null || !master.ready || tooPoor) return
    setError(null)
    try {
      const request = { budgetCredits: credits, expiresAt: Date.now() + dayCount * DAY_MS }
      const key = await createRunnerKey(master.take(), request)
      onCreated(
        { keyId: key.keyId, budgetCredits: String(key.limits.total ?? request.budgetCredits), expiresAt: key.limits.expiresAt ?? request.expiresAt, saved: false },
        dfk1(ACTIVE_NETWORK.key, identity, key.keyId, key.wif),
      )
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  if (record && secret) {
    return (
      <>
        <p className="flex items-center gap-2 text-dense text-verify-700 dark:text-verify-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> <span>Key {record.keyId} is on your identity: {creditsAsDash(Number(record.budgetCredits))} DASH budget<FiatNote dash={creditsToDash(Number(record.budgetCredits))} kind="bound" />, until {formatDate(record.expiresAt)}.</span>
        </p>
        <div className="space-y-1">
          <p className="text-dense font-medium">
            Secret name: <span className="font-mono">DASH_FORGE_KEY</span>
          </p>
          <SecretValue label="the DASH_FORGE_KEY value" value={secret} />
          <Hint tone="caution">Shown once: it is not stored in this browser. Copy it into GitHub now. If it is lost, make another.</Hint>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton href={newSecretUrl(github)} testId="mirror-secret-link">
            <ExternalLink className="h-4 w-4" aria-hidden /> Add to GitHub secrets
          </LinkButton>
        </div>
        <label className="flex items-center gap-2 text-dense">
          <input type="checkbox" className="h-4 w-4 accent-forge-700" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I saved it as the <span className="font-mono">DASH_FORGE_KEY</span> repository secret
        </label>
        <Button variant="primary" disabled={!saved} onClick={() => onDone({ ...record, saved: true })}>
          Continue
        </Button>
      </>
    )
  }

  return (
    <>
      <p className="text-dense text-anvil-600 dark:text-anvil-300">
        The Action signs with its own key. If it leaks, it can spend at most its budget, only on Forge, and only until it expires. Dash Platform enforces those limits.
      </p>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="sr-only">Runner key</legend>
        <label className="flex items-center gap-2 text-dense">
          <input type="radio" name="mirror-key-way" checked={keyWay === 'make'} onChange={() => setKeyWay('make')} className="accent-forge-700" /> Make one here
        </label>
        <label className="flex items-center gap-2 text-dense">
          <input type="radio" name="mirror-key-way" checked={keyWay === 'own'} onChange={() => setKeyWay('own')} className="accent-forge-700" /> Add DASH_FORGE_KEY yourself
        </label>
      </fieldset>
      {keyWay === 'own' ? (
        <div className="space-y-2">
          <Hint>Sign dg in as {shortIdentity(identity)} first. A key of another identity needs its own access to this repo.</Hint>
          <CopyRow text={`dg auth export --new-key --budget ${RUNNER_KEY_DEFAULTS.budgetDash} --expires ${RUNNER_KEY_DEFAULTS.days}d --format dfk1 --reveal-secrets -o runner.dfk1 ${dgNetworkFlags(ACTIVE_NETWORK)}`} label="Copy the dg auth export command" />
          <Hint>The file&apos;s one line is the secret. Paste it as DASH_FORGE_KEY, then delete the file.</Hint>
          <Button variant="outline" onClick={() => onDone({ keyId: -1, budgetCredits: '0', expiresAt: 0, saved: true })}>I added DASH_FORGE_KEY</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Hint>Signed in with a wallet? Add DASH_FORGE_KEY yourself with dg.</Hint>
          {record && record.keyId >= 0 ? (
            <Hint tone="caution">
              Key {record.keyId} was made earlier and shown once. If it is not saved in GitHub, make another here (key {record.keyId} then signs nothing: nobody holds it).
            </Hint>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Field label="Budget (DASH)" htmlFor="runner-budget" hint={<>The most the key can ever spend{credits !== null ? <FiatNote dash={creditsToDash(Number(credits))} kind="bound" /> : null}.</>}>
                <Input id="runner-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} className="font-mono" autoComplete="off" aria-invalid={budgetError !== null} />
              </Field>
              {budgetError ? <Hint tone="danger">{budgetError}</Hint> : null}
            </div>
            <div>
              <Field label="Expires after (days)" htmlFor="runner-days" hint={`Until ${formatDate(until)}.`}>
                <Input id="runner-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} className="font-mono" autoComplete="off" aria-invalid={daysError !== null} />
              </Field>
              {daysError ? <Hint tone="danger">Pick {daysError}.</Hint> : null}
            </div>
          </div>
          {master.element}
          <CostPreview cost={fee} />
          <Hint>The fee registers the key. Its budget is a cap, not a charge. Your master key signs this one update and is not stored.</Hint>
          {tooPoor ? <Hint tone="caution">Your identity&apos;s balance is below the fee. Top it up first.</Hint> : null}
          {master.error ? <Hint tone="danger">{master.error}</Hint> : null}
          {error ? <Hint tone="danger">{error}</Hint> : null}
          <Button variant="primary" loading={isLoading} disabled={!master.ready || credits === null || daysError !== null || tooPoor} onClick={() => void create()}>
            Sign once &amp; create the runner key
          </Button>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// 5. The workflow file and its secrets
// ---------------------------------------------------------------------------

export function WorkflowStep({
  identity,
  github,
  repoName,
  storage,
  profile,
  secret,
  runnerKey,
  onDone,
}: {
  identity: string
  github: GithubRepo
  repoName: string
  storage: UsableMirrorStorage
  profile: StorageProfile | null
  secret: string | null
  runnerKey: RunnerKeyRecord | null
  onDone: () => void
}): JSX.Element {
  // Off by default, as in the Action (`sync: code,releases`) and as its own hint advises
  // (QW4-045): anyone who can open an issue or PR could make a run spend.
  const [collab, setCollab] = useState(false)
  const [costCap, setCostCap] = useState(() => defaultCostCap(storage.kind, github.sizeKib, PUSH_COST_DASH.perMib))
  // Typed by the person, else the build's commit, else the latest on master.
  const [typed, setCommit] = useState<string | null>(null)
  const master = useAsync(() => latestCommit(DASH_FORGE_REPO, 'master'), [], { enabled: BUILD_COMMIT === '' })
  const commit = typed ?? (BUILD_COMMIT || master.data || '')
  const [committed, setCommitted] = useState(false)

  const yaml = useMemo(() => {
    try {
      return {
        text: workflowYaml({
          github,
          forgeRepo: `dash://${identity}/${repoName}`,
          network: ACTIVE_NETWORK.network,
          devnetName: ACTIVE_NETWORK.devnetName,
          storage,
          collab,
          costCap,
          commit: commit.trim(),
        }),
        error: null,
      }
    } catch (e) {
      return { text: null, error: errorMessage(e) }
    }
  }, [github, identity, repoName, storage, collab, costCap, commit])
  const capError = costCapProblem(costCap)
  const overBudget = capError === null && runnerKey !== null && runnerKey.keyId >= 0 && Number(costCap) * CREDITS_PER_DASH > Number(runnerKey.budgetCredits)
  const secrets = workflowSecrets(storage)
  const valueOf = (name: string): string | null => {
    switch (name) {
      case 'DASH_FORGE_KEY':
        return secret
      case 'S3_ACCESS_KEY_ID':
        return profile?.secrets.accessKeyId ?? null
      case 'S3_SECRET_ACCESS_KEY':
        return profile?.secrets.secretAccessKey ?? null
      default:
        return null
    }
  }

  return (
    <>
      <section aria-labelledby="mirror-secrets-title" className="space-y-2">
        <h3 id="mirror-secrets-title" className="text-dense font-medium">
          a. Add {secrets.length === 1 ? 'the secret' : `the ${secrets.length} secrets`} first
        </h3>
        <p className="text-dense text-anvil-600 dark:text-anvil-300">
          On GitHub: <span className="font-medium">{github.owner}/{github.name} → Settings → Secrets and variables → Actions → New repository secret</span>. Add each one with exactly this name. Committing the workflow starts the first run, so the secrets must be there before it.
        </p>
        <ol className="space-y-3" data-testid="mirror-secrets">
          {secrets.map((s, i) => {
            const v = valueOf(s.name)
            return (
              <li key={s.name} className="space-y-1 text-dense">
                <p>
                  {i + 1}. Name <span className="font-mono font-medium">{s.name}</span>, value: {s.what}.
                </p>
                <CopyRow text={s.name} label={`Copy the name ${s.name}`} />
                {v !== null ? <SecretValue label={`the ${s.name} value`} value={v} /> : null}
              </li>
            )
          })}
        </ol>
        <LinkButton href={newSecretUrl(github)} testId="mirror-new-secret">
          <ExternalLink className="h-4 w-4" aria-hidden /> Open New repository secret
        </LinkButton>
        {storage.kind === 's3' ? <Hint>The Action writes with these keys. A token limited to this bucket (Object Read &amp; Write) is enough.</Hint> : null}
      </section>

      <section aria-labelledby="mirror-workflow-title" className="space-y-3">
        <h3 id="mirror-workflow-title" className="text-dense font-medium">
          b. Then add the workflow
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Field
              label="Cost cap per run (DASH)"
              htmlFor="mirror-cost-cap"
              // Why it is above the Action's own default (QW4-045).
              hint={<>A run that would spend more stops first{capError === null ? <FiatNote dash={Number(costCap)} kind="bound" /> : null}. This is above the Action&apos;s default of {ACTION_COST_CAP} DASH<FiatNote dash={Number(ACTION_COST_CAP)} kind="bound" /> because the first run copies everything. Lower it once the mirror is up.</>}
            >
              <Input id="mirror-cost-cap" inputMode="decimal" value={costCap} onChange={(e) => setCostCap(e.target.value)} className="font-mono" autoComplete="off" aria-invalid={capError !== null} />
            </Field>
            {capError ? <Hint tone="danger">{capError}</Hint> : null}
            {overBudget && runnerKey ? (
              <Hint tone="caution">
                More than the runner key&apos;s whole budget of {creditsAsDash(Number(runnerKey.budgetCredits))} DASH<FiatNote dash={creditsToDash(Number(runnerKey.budgetCredits))} kind="bound" />: a run that needs it stops when the key runs out. Make a key with a larger budget in the runner key step.
              </Hint>
            ) : null}
          </div>
          <div>
            <Field label="Dash Forge commit" htmlFor="mirror-commit" hint={BUILD_COMMIT ? 'The commit this site was built from.' : 'The latest on master. Pin one you have reviewed.'}>
              <Input id="mirror-commit" value={commit} onChange={(e) => setCommit(e.target.value)} className="font-mono text-[12px]" spellCheck={false} autoComplete="off" />
            </Field>
            {master.error && commit === '' ? <Hint tone="danger">Could not read the latest commit from GitHub: {master.error}. Paste one.</Hint> : null}
          </div>
        </div>
        <label className="flex items-start gap-2 text-dense">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-forge-700" checked={collab} onChange={(e) => setCollab(e.target.checked)} />
          <span>
            Mirror issues and pull requests too
            <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">Anyone who opens one makes a run spend, up to the cap. Leave this off for a busy repo. Code and releases still sync.</span>
          </span>
        </label>
        {yaml.error ? <Hint tone="danger">{yaml.error}</Hint> : null}
        {yaml.text ? (
          <>
            <div className="flex flex-wrap gap-2">
              <LinkButton href={newWorkflowUrl(github, github.defaultBranch, yaml.text)} primary testId="mirror-create-workflow">
                <GitFork className="h-4 w-4" aria-hidden /> Create this file on GitHub
              </LinkButton>
            </div>
            <Hint>
              Opens GitHub&apos;s new-file page with <span className="font-mono">.github/workflows/forge-mirror.yml</span> filled in. Commit it to <span className="font-mono">{github.defaultBranch}</span>. Or copy it:
            </Hint>
            <div data-testid="mirror-yaml">
              <CopyBlock text={yaml.text} label="Copy the workflow file" />
            </div>
            <Hint>
              The first run builds the tools from this site&apos;s commit, which takes a few minutes. Later runs reuse the cache. Once a release is published, you can use its tag (<span className="font-mono">action@v&lt;version&gt;</span>) for prebuilt binaries and remove the <span className="font-mono">install</span> line.
            </Hint>
          </>
        ) : null}
        <label className="flex items-center gap-2 text-dense">
          <input type="checkbox" className="h-4 w-4 accent-forge-700" checked={committed} onChange={(e) => setCommitted(e.target.checked)} />
          I added the secrets and committed the workflow
        </label>
        <Button variant="primary" disabled={!committed || yaml.text === null} onClick={onDone}>
          Watch for the first run
        </Button>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// 6. Waiting for the first mirror run
// ---------------------------------------------------------------------------

const POLL_MS = 10_000

function minutes(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}

export function WaitStep({
  sdk,
  forge,
  identity,
  github,
  repo,
  progress,
  onBaseline,
  onMirrored,
  onRestart,
}: {
  sdk: EvoSDK | null
  forge: ForgeIds
  identity: string
  github: GithubRepo
  repo: { repoId: string; name: string }
  progress: MirrorProgress
  /** No baseline was read before the workflow could run: the first check here is it. */
  onBaseline: (refsBefore: string) => void
  onMirrored: (at: number) => void
  onRestart: () => void
}): JSX.Element {
  const [now, setNow] = useState(Date.now())
  const [refs, setRefs] = useState<{ branches: number; tags: number } | null>(null)
  // The repository already had refs, and none has changed yet.
  const [unchanged, setUnchanged] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const mirroredAt = progress.mirroredAt
  const before = progress.refsBefore

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!sdk) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const resolved = await resolveAnyRepoWith(sdk, forge, { owner: identity, name: repo.name, repoId: repo.repoId })
        if (!resolved) throw new Error(`${repo.name} was not found on Platform`)
        const all = await readRefs(sdk, resolved.repo)
        if (stop) return
        setError(null)
        const now = refsFingerprint(all)
        if (before === null) {
          // Take what is there now as the starting point, and wait for a change from it.
          onBaseline(now)
          return
        }
        if (now !== '' && now !== before) {
          setRefs({ branches: branchesOf(all).length, tags: tagsOf(all).length })
          if (mirroredAt === null) onMirrored(Date.now())
          return
        }
        setUnchanged(all.length)
      } catch (e) {
        if (!stop) setError(errorMessage(e))
      }
      if (!stop) timer = setTimeout(() => void poll(), POLL_MS)
    }
    void poll()
    return () => {
      stop = true
      if (timer) clearTimeout(timer)
    }
    // Poll once per repo; `onMirrored` and `mirroredAt` only record the first sighting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdk, forge, identity, repo.name, repo.repoId, before])

  const href = `/repo/?owner=${encodeURIComponent(identity)}&name=${encodeURIComponent(repo.name)}`
  if (refs) {
    return (
      <div className="space-y-3" data-testid="mirror-live">
        <p className="flex items-center gap-2 text-prose text-verify-700 dark:text-verify-400">
          <CheckCircle2 className="h-5 w-5" aria-hidden /> Your mirror is live
        </p>
        <p className="text-dense text-anvil-600 dark:text-anvil-300">
          {plural(refs.branches, 'branch', 'branches')} and {plural(refs.tags, 'tag')} of github.com/{github.owner}/{github.name} are on Dash Platform, signed by your identity.
          {mirroredAt !== null && progress.startedAt > 0 ? ` Set up in ${minutes(mirroredAt - progress.startedAt)}, from opening this page to the first mirrored push.` : ''}
        </p>
        <p className="text-dense text-anvil-600 dark:text-anvil-300">Push anything to GitHub: the mirror follows on every push, issue and release, and reconciles daily.</p>
        <div className="flex flex-wrap gap-2">
          <Link href={href} className={linkButtonClass(true)}>
            Open {repo.name}
          </Link>
          <Button variant="outline" onClick={onRestart}>
            Mirror another repository
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-3" data-testid="mirror-waiting">
      <p className="flex items-center gap-2 text-dense">
        <Loader2 className="h-4 w-4 animate-spin text-forge-600" aria-hidden /> Waiting for the first mirror run to push to <span className="font-mono">{repo.name}</span>…
      </p>
      <Hint>
        Checking Platform every {POLL_MS / 1000} s{progress.startedAt > 0 ? `, ${minutes(now - progress.startedAt)} since you opened this page` : ''}. The first run compiles Dash Forge&apos;s tools before it mirrors.
      </Hint>
      {sdk === null ? <Hint>Connecting to Dash Platform…</Hint> : null}
      {unchanged > 0 ? (
        <Hint>
          {repo.name} already had {plural(unchanged, 'ref')}, and none has changed yet. If it already matches GitHub, the run has nothing new to push: check it on GitHub.
        </Hint>
      ) : null}
      {error ? <Hint tone="caution">Last check failed: {error}. Trying again.</Hint> : null}
      <div className="flex flex-wrap gap-2">
        <LinkButton href={workflowRunsUrl(github)} testId="mirror-runs-link">
          <ExternalLink className="h-4 w-4" aria-hidden /> Watch the run on GitHub
        </LinkButton>
      </div>
      <details className="text-dense">
        <summary className="cursor-pointer text-anvil-600 dark:text-anvil-300">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden /> The run failed?
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[12px] text-anvil-600 dark:text-anvil-300">
          <li>
            <span className="font-mono">DASH_FORGE_KEY is empty</span>: the secret is missing or misnamed. Add it, then re-run the job.
          </li>
          <li>
            <span className="font-mono">cap_exceeded</span>: the first run needs more than the cost cap. Raise <span className="font-mono">cost-cap</span> in the workflow and run it again from the Actions tab.
          </li>
          <li>A storage error: check the bucket&apos;s keys and endpoint with the storage test in Settings → Storage.</li>
        </ul>
      </details>
    </div>
  )
}

/** The first answer determines which steps follow. */
export function WayStep({ initial, onDone }: { initial: MirrorWay | null; onDone: (way: MirrorWay) => void }): JSX.Element {
  const [way, setWay] = useState<MirrorWay | null>(initial)
  return (
    <>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">Do you maintain the repo on GitHub?</legend>
        {([
          ['action', 'Yes, keep it in sync automatically', 'Needs write access on GitHub', 'A GitHub Action in the repo mirrors every push. Setting it up adds a workflow file and secrets to the GitHub repo.', 'You sign in here. The Action is optional. You can create the Forge repo now and add it later.'],
          ['cli', 'No, copy it from the command line', 'Anyone', 'dg import copies the repo from your computer, once. Run it again whenever you want the copy brought up to date.', 'This page signs nothing. dg signs and pays from your identity.'],
        ] as const).map(([value, title, badge, body, foot]) => (
          <label key={value} className={cn('flex cursor-pointer flex-col gap-3 rounded-md border p-3', way === value ? 'border-forge-500 bg-forge-500/5' : 'border-anvil-200 dark:border-anvil-750')}>
            <span className="flex items-start gap-2 text-dense font-medium">
              <input type="radio" name="mirror-way" aria-labelledby={`mirror-way-${value}-title`} aria-describedby={`mirror-way-${value}-badge mirror-way-${value}-body mirror-way-${value}-foot`} value={value} checked={way === value} onChange={() => setWay(value)} className="mt-1 accent-forge-700" />
              <span id={`mirror-way-${value}-title`}>{title}</span>
            </span>
            <span id={`mirror-way-${value}-badge`} className="w-fit rounded bg-surface-raised px-2 py-1 text-[12px] text-fg-muted">{badge}</span>
            <span id={`mirror-way-${value}-body`} className="text-dense">{body}</span>
            <span id={`mirror-way-${value}-foot`} className="mt-auto text-[12px] text-fg-muted">{foot}</span>
          </label>
        ))}
      </fieldset>
      <Button variant="primary" disabled={way === null} onClick={() => way !== null && onDone(way)}>Continue</Button>
    </>
  )
}

export function ActionStep({ onDone }: { onDone: (later: boolean) => void }): JSX.Element {
  return (
    <>
      <p className="text-dense">Set up the Action now?</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => onDone(false)}>Set it up now</Button>
        <Button variant="outline" onClick={() => onDone(true)}>Later</Button>
      </div>
      <Hint>Create the Action whenever you like. This page picks up where you stopped.</Hint>
    </>
  )
}

/** Shared by the public CLI path and the ready card's existing, owner-qualified repo. */
export function CliStep({ github, settings, onSettings, ownerId }: {
  github: GithubRepo
  settings: MirrorCliSettings
  onSettings: (settings: MirrorCliSettings) => void
  ownerId?: string
}): JSX.Element {
  let nameError: string | null = null
  try {
    normalizeRepoName(settings.name)
  } catch (e) {
    nameError = errorMessage(e)
  }
  const capError = cliCostCapProblem(settings.cap)
  const Heading = ownerId ? 'h4' : 'h3'
  const commands = nameError === null && capError === null ? mirrorCliCommands({ github, ...settings, ownerId }) : null
  const alias = `/github.com/${github.owner}/${github.name}/`
  return (
    <div className="space-y-4" data-testid="mirror-cli">
      <fieldset className="space-y-3">
        <legend className="mb-2 text-dense font-medium">Settings</legend>
        <Field label="Forge repo name" htmlFor="mirror-cli-name">
          <Input id="mirror-cli-name" value={settings.name} readOnly={ownerId !== undefined} onChange={(e) => onSettings({ ...settings, name: e.target.value })} className="font-mono" autoCapitalize="off" autoComplete="off" spellCheck={false} aria-invalid={nameError !== null} />
        </Field>
        {nameError ? <Hint tone="danger">{nameError}</Hint> : null}
        <label className="flex items-start gap-2 text-dense">
          <input type="checkbox" checked={settings.collab} onChange={(e) => onSettings({ ...settings, collab: e.target.checked })} className="mt-1 accent-forge-700" />
          <span>Issues and pull requests too<span className="block text-[12px] text-fg-muted">Takes longer and costs more on a busy repo. Every issue, comment and review becomes a permanent public copy.</span></span>
        </label>
        <Field label="Spending cap (DASH)" htmlFor="mirror-cli-cap" hint={<>dg shows the estimate and asks before it writes. It stops before spending more than this{capError === null ? <FiatNote dash={Number(settings.cap)} kind="bound" /> : null}.</>}>
          <Input id="mirror-cli-cap" value={settings.cap} onChange={(e) => onSettings({ ...settings, cap: e.target.value })} inputMode="decimal" className="font-mono" autoComplete="off" aria-invalid={capError !== null} />
        </Field>
        {capError ? <Hint tone="danger">{capError}</Hint> : null}
      </fieldset>
      {commands ? (
        <>
          <section className="space-y-2" aria-label="Install and sign in">
            <Heading className="text-dense font-medium">a. Once: install and sign in</Heading>
            <p className="text-dense">You need dg and git-remote-dash (<a href={DOCS.quickStart} className="underline">install</a>), and the GitHub CLI, signed in.</p>
            {ownerId ? <Hint>Sign dg in as {shortIdentity(ownerId)} to fill this repo.</Hint> : null}
            <CopyRow text={commands.login} label="Copy the dg sign-in command" />
            <Hint>New to Dash? <code>{commands.newIdentity}</code> makes an identity.</Hint>
            <CopyRow text={commands.githubLogin} label="Copy the GitHub sign-in command" />
          </section>
          <section className="space-y-2" aria-label="Copy the repo">
            <Heading className="text-dense font-medium">b. Copy it</Heading>
            <CopyRow text={commands.copy} label="Copy the import command" />
            <Hint>Your git data goes to Dash Platform unless you <a href={DOCS.storage} className="underline">set your own storage for dg first</a>.</Hint>
            <CopyRow text={commands.storage} label="Copy the storage command" />
            <Hint>{ownerId ? <>dg import writes into {settings.name} and replaces its branches and tags to match GitHub.</> : <>If you already have a repo with this name, dg import writes into it and replaces its branches and tags.</>}</Hint>
          </section>
          <section className="space-y-2" aria-label="Bring it up to date">
            <Heading className="text-dense font-medium">c. Bring it up to date</Heading>
            <p className="text-dense">Run the same command again. It copies only what changed, and costs nothing when nothing changed. To run it on a schedule, see <a href={DOCS.mirrorKeepInSync} className="underline">Keep it in sync</a>.</p>
          </section>
          <p className="text-dense">dg prints the repo&apos;s address when it&apos;s done. Copies with the GitHub name also appear at <Link href={alias} className="break-all text-forge-700 underline dark:text-forge-400">{alias}</Link>.</p>
        </>
      ) : null}
    </div>
  )
}

export function ReadyCard({ identity, github, repo, onSetup }: {
  identity: string
  github: GithubRepo
  repo: { name: string }
  onSetup: () => void
}): JSX.Element {
  const [settings, setSettings] = useState<MirrorCliSettings>({ name: repo.name, collab: false, cap: '0.2' })
  return (
    <li className="space-y-4 rounded-lg border border-verify/30 bg-white p-4 dark:bg-anvil-900" data-testid="mirror-ready">
      <h2 className="text-prose">Your Forge repo is ready</h2>
      <div className="flex flex-wrap gap-2">
        <Link href={`/repo/?owner=${encodeURIComponent(identity)}&name=${encodeURIComponent(repo.name)}`} className={linkButtonClass(true)}>Open {repo.name}</Link>
        <Button variant="outline" onClick={onSetup}>Set up the Action</Button>
      </div>
      <h3 className="text-dense font-medium">Fill it now from the command line</h3>
      <CliStep github={github} settings={settings} onSettings={setSettings} ownerId={identity} />
    </li>
  )
}
