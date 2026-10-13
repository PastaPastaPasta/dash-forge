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
 * A public repo turns members-only content on at creation unless its creator unticks "Turn on
 * members-only content now" (DESIGN §11 Q3): a fourth step, the owner's key and the settings-free
 * anchor (`enableMembersContent`), priced like the Turn on sheet. It needs the encryption key in
 * this browser; without one the box is off and says how to set one up. If the step fails the repo
 * stands without it, and the repo page offers to turn it on.
 *
 * On a network without forge-v2 the page shows "not deployed".
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Globe, GitBranch, Hammer, Loader2, Lock } from 'lucide-react'
import Link from 'next/link'
import { AppShell } from '@/components/app-shell'
import { UnlockMore } from '@/components/auth/unlock-more'
import { SignInButton } from '@/components/sign-in-button'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/ui/states'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'
import { ACTIVE_NETWORK, DEFAULT_NETWORK, networkName } from '@/lib/constants'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import {
  checkRepoInput,
  createRepo,
  discardRepoCreation,
  REPO_NAME_RULE,
  suggestRepoName,
  pendingRepoCreations,
  previewRepoCreate,
  createStepCount,
  type CreateRepoInput,
  type CreateRepoStep,
  type PrivateCreate,
  type RepoCreationJournal,
  repoCreationFirsts,
} from '@/lib/repo'
import { createEpochZero, enableMembersContent } from '@/lib/repo/private-members'
import { aboutDash, enableEstimate, SET_UP_KEY } from '@/lib/view/audience'
import { PRIVATE_REPOS_SETTINGS } from '@/lib/settings-links'
import { previewCredits, sumPreviews } from '@/lib/sdk/cost'
import { encryptionOps } from '@/lib/auth/encryption-key'
import { onEncryptionKeyChange } from '@/lib/auth/vault'
import { useAsync } from '@/hooks/use-async'
import { toast } from '@/hooks/use-toasts'
import type { Visibility } from '@/lib/rules/v2'
import { errorMessage } from '@/lib/utils'
import { onRadioGroupKeyDown, radioTabIndex } from '@/components/ui/radio-group'

const STEPS: readonly { step: CreateRepoStep; label: string; privateLabel?: string }[] = [
  { step: 'repo', label: 'The repo' },
  { step: 'maintainer', label: 'You, as its first maintainer' },
  { step: 'config', label: 'Initial config (default branch)', privateLabel: 'Your repo key and the sealed config (default branch)' },
  { step: 'members', label: 'Members-only content (your key)' },
]

/** The members-only checkbox's cost: the Turn on sheet's estimate for one member, the owner. */
const MEMBERS_ONLY_CREDITS = enableEstimate(1)

/**
 * What a private create states before it spends: the facts `dg repo create --private` prints
 * (`crates/dg/src/publish.rs` `PRIVATE_FACTS`; `ux-dx-spec.md` §9 "Create"), verbatim.
 */
const PRIVATE_FACTS: readonly string[] = [
  'private: code, ref names, issues, PRs, comments, reviews and the labels on them are encrypted to members',
  'visible to everyone: that it exists, its name, description and topics, owner, members, how many issues and pull requests it has, sizes and timing, commit ids, and label definitions (not encrypted in this release); releases are sealed',
  'members keep whatever they could already read, even after they are removed',
  'no recovery: if every member loses their encryption key, the contents are gone',
]

/** The CLI's note when a private create has a description (`publish.rs`). */
const PUBLIC_DESCRIPTION_NOTE = 'note: the description and display name are public; leave them empty to keep them private'

/** The confirmation's sentence on protection, with a trailing space; empty when the create opts out. */
function protectionNote(i: CreateRepoInput): string {
  return i.protect === true ? `Only maintainers will be able to push to ${i.defaultBranch ?? 'main'} or move tags. ` : ''
}

type StepState = 'todo' | 'running' | 'done'
/** A creation's steps, all to do; `members` only when it turns members-only content on. */
function initialProgress(i: CreateRepoInput): Partial<Record<CreateRepoStep, StepState>> {
  return { repo: 'todo', maintainer: 'todo', config: 'todo', ...(createStepCount(i) === 4 ? { members: 'todo' as const } : {}) }
}

export default function NewRepoPage(): JSX.Element {
  const router = useRouter()
  const { sdk, ready } = useSdk()
  const { identity, signer, unlockScope } = useAuth()
  const guard = useWriteGuard()
  const forge = ACTIVE_NETWORK.v2
  // A returning owner's repo costs less than the first (D-011): read which it is.
  const creation = useAsync(
    () => repoCreationFirsts(sdk!, identity!, forge!.core),
    [ready, identity ?? '', forge?.core ?? ''],
    { enabled: ready && sdk !== null && identity !== null && forge !== null },
  )
  const firsts = creation.data ?? { first: {}, rest: {} }

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [visibility, setVisibility] = useState<Visibility>('public')
  // D6: a new repo protects its default branch and tags unless its creator opts out.
  const [protect, setProtect] = useState(true)
  // DESIGN §11 Q3: a new public repo turns members-only content on unless its creator opts out.
  const [membersOnly, setMembersOnly] = useState(true)
  const branchShown = defaultBranch.trim() || 'main'
  // `/new/?visibility=private` (the Private repositories page's button) starts on Private, after
  // hydration so the static page and the first client render agree.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('visibility') === 'private') setVisibility('private')
  }, [])
  const isPrivate = visibility === 'private'
  // A private create wraps its key from the encryption key in this browser's vault, and so does
  // a public one that turns members-only content on: read it for both.
  const ops = useAsync(
    () => encryptionOps(sdk!, DEFAULT_NETWORK, identity!, forge!.collab),
    [ready, identity ?? '', forge?.core ?? '', unlockScope ?? ''],
    { enabled: sdk !== null && identity !== null && forge !== null },
  )
  // Re-read when a key is added (Settings in another tab, or this one) or the tab regains focus.
  const reloadOps = ops.reload
  useEffect(() => {
    const off = onEncryptionKeyChange(reloadOps)
    window.addEventListener('focus', reloadOps)
    return () => {
      off()
      window.removeEventListener('focus', reloadOps)
    }
  }, [reloadOps])
  // Only a settled answer of "no key" says so; a failed read says what failed.
  const keyMissing = ops.settled && ops.error === null && ops.data === null
  const noKey = isPrivate && keyMissing
  // Members-only content at creation: ticked, and possible here (no key in this browser turns the
  // box off and says how to set one up).
  const withMembers = !isPrivate && membersOnly && !keyMissing
  const usesKey = isPrivate || withMembers
  // A reloaded tab holds the signing key only: the encryption key needs an unlock here first.
  const needsUnlock = usesKey && unlockScope === 'signing'
  // A public create waits only for an unlock: a key read that is slow or fails never holds it up
  // (turning members-only content on then fails on its own, and the repo page offers it again).
  const privateBlocked = !usesKey
    ? null
    : needsUnlock
      ? isPrivate
        ? 'Unlock this tab to use your encryption key.'
        : 'Unlock this tab to use your encryption key, or untick members-only content.'
      : !isPrivate
        ? null
        : ops.error !== null
          ? `Couldn't read your encryption key: ${ops.error}`
          : noKey
            ? 'Add your encryption key to this browser first (Settings → Members-only and private content).'
            : ops.data == null
              ? 'Checking your encryption key…'
              : null
  const [confirm, setConfirm] = useState<CreateRepoInput | null>(null)
  const [progress, setProgress] = useState<Partial<Record<CreateRepoStep, StepState>> | null>(null)
  const [pending, setPending] = useState<RepoCreationJournal[]>([])

  const reloadPending = useCallback(() => {
    if (!identity) return
    pendingRepoCreations(DEFAULT_NETWORK, identity).then(setPending, () => setPending([]))
  }, [identity])
  useEffect(reloadPending, [reloadPending])

  // What the typed name becomes, as GitHub converts it (QW3-036): `QA3 Bad Name!` → `qa3-bad-name`.
  const repoName = useMemo(() => (name.trim() === '' ? null : suggestRepoName(name)), [name])
  const converted = repoName !== null && repoName !== name.trim().toLowerCase()
  const nameError = useMemo(() => {
    if (name.trim() === '') return null
    if (repoName === null) return REPO_NAME_RULE
    try {
      checkRepoInput({ name: repoName, description })
      return null
    } catch (e) {
      return errorMessage(e, 'invalid name')
    }
  }, [name, repoName, description])
  // The branch and protection rules, checked as the user types, before anything is signed.
  const branchError = useMemo(() => {
    const branch = defaultBranch.trim()
    if (branch === '' || branch === 'main') return null
    try {
      checkRepoInput({ name: 'x', defaultBranch: branch, ...(protect ? { protect: true } : {}) })
      return null
    } catch (e) {
      return errorMessage(e, 'invalid branch name')
    }
  }, [defaultBranch, protect])
  // An unfinished creation of this name resumes with the values it started with.
  const resuming = useMemo(() => {
    if (nameError !== null || repoName === null) return null
    return pending.find((j) => j.input.name === repoName) ?? null
  }, [repoName, nameError, pending])
  const differs =
    resuming !== null &&
    ((resuming.input.description ?? '') !== description.trim() ||
      (resuming.input.defaultBranch ?? 'main') !== (defaultBranch.trim() || 'main') ||
      (resuming.input.protect === true) !== protect ||
      (!isPrivate && (resuming.input.membersOnly === true) !== withMembers))

  const input = (): CreateRepoInput => ({
    name: repoName ?? '',
    ...(description.trim() ? { description: description.trim() } : {}),
    ...(defaultBranch.trim() && defaultBranch.trim() !== 'main' ? { defaultBranch: defaultBranch.trim() } : {}),
    ...(isPrivate ? { visibility: 'private' as const } : {}),
    ...(protect ? { protect: true } : {}),
    ...(withMembers ? { membersOnly: true } : {}),
  })
  const costOf = (i: CreateRepoInput) =>
    createStepCount(i) === 4 ? sumPreviews([previewRepoCreate(i, firsts), previewCredits(MEMBERS_ONLY_CREDITS)]) : previewRepoCreate(i, firsts)
  const cost = costOf(name.trim() && nameError === null && branchError === null ? input() : { name: 'x', ...(withMembers ? { membersOnly: true } : {}) })

  const create = async (i: CreateRepoInput): Promise<void> => {
    if (!signer || !forge) throw new Error('sign in first')
    if (!sdk) throw new Error('still connecting to Dash Platform: try again in a moment')
    setProgress(initialProgress(i))
    let result
    try {
      // Without an encryption key createRepo refuses a private create before writing anything.
      // Turning members-only content on without one ends with the repo and a note instead.
      let privateCreate: PrivateCreate | undefined
      if (i.visibility === 'private' || i.membersOnly === true) {
        const o = await encryptionOps(sdk, DEFAULT_NETWORK, signer.identityId, forge.collab)
        if (o !== null) privateCreate = { ops: o, epochZero: createEpochZero, membersOnly: enableMembersContent }
      }
      result = await createRepo(
        sdk,
        signer,
        forge,
        i,
        (step, state) => setProgress((p) => ({ ...(p ?? initialProgress(i)), [step]: state === 'start' ? 'running' : 'done' })),
        privateCreate,
      )
    } catch (e) {
      setProgress(null)
      throw e
    } finally {
      reloadPending()
    }
    // Members-only content that did not turn on: say why here, and the repo page offers it again.
    const failed = result.membersOnly?.on === false ? result.membersOnly.error : null
    if (failed !== null) toast({ title: "Members-only content isn't set up yet", detail: failed, tone: 'warn' })
    const membersFailed = failed !== null ? '&membersOnly=failed' : ''
    router.push(`/repo/?owner=${encodeURIComponent(identity ?? '')}&name=${encodeURIComponent(result.name)}&created=1${membersFailed}`)
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
          heading="h1"
          icon={Lock}
          title="Sign in to create a repo"
          body="Creating a repo costs a small fee, shown before you confirm."
          action={<SignInButton />}
        />
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-surface-raised ring-1 ring-inset ring-anvil-200 dark:ring-anvil-700">
            <Hammer className="h-5 w-5 text-fg-muted" aria-hidden />
          </span>
          <div>
            <h1 className="text-xl">Forge a new repo</h1>
            <p className="text-dense text-anvil-500 dark:text-anvil-400">
              On {networkName()}, owned by your identity.
            </p>
          </div>
        </div>

        {pending.map((j) => (
          <div key={j.input.name} className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense">
            <span className="flex-1">
              Creating <span className="font-mono">{j.input.name}</span> did not finish ({j.done.length} of {createStepCount(j.input)} steps).
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
          {nameError ? (
            <p className="-mt-2 text-[12px] text-danger-700 dark:text-danger-400">{nameError}</p>
          ) : converted ? (
            <p className="-mt-2 text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="repo-name-converted">
              Your new repository will be created as <span className="font-mono font-medium text-anvil-900 dark:text-anvil-50">{repoName}</span>.
            </p>
          ) : null}

          <Field label="Description" htmlFor="repo-desc" hint="Shown in discovery. Optional; editable later.">
            <Textarea id="repo-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this repo for?" className="min-h-[72px]" maxLength={500} />
          </Field>

          <fieldset>
            <legend className="mb-1 text-dense font-medium">Visibility</legend>
            <div role="radiogroup" aria-label="Visibility" onKeyDown={onRadioGroupKeyDown} className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['public', Globe, 'Public', 'Anyone can read it.'],
                  ['private', Lock, 'Private', 'Encrypted to its members. Set now; it cannot change later.'],
                ] as const
              ).map(([v, Icon, label, hint], i) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={visibility === v}
                  tabIndex={radioTabIndex(visibility === v, i, true)}
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
          {!isPrivate ? (
            <div className="flex items-start gap-2.5 rounded-md border border-anvil-200 p-3 dark:border-anvil-750" data-testid="members-only-create">
              <input
                id="repo-members-only"
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-forge-700"
                checked={withMembers}
                disabled={keyMissing}
                onChange={(e) => setMembersOnly(e.target.checked)}
                aria-describedby="repo-members-only-hint"
                data-testid="repo-members-only"
              />
              <div className="min-w-0">
                <label htmlFor="repo-members-only" className="text-dense font-medium">
                  Turn on members-only content now <span className="font-normal text-anvil-500 dark:text-anvil-400">(about {aboutDash(MEMBERS_ONLY_CREDITS)})</span>
                </label>
                <p id="repo-members-only-hint" className="text-[12px] text-anvil-500 dark:text-anvil-400">
                  {keyMissing ? (
                    <>
                      Members-only content needs your encryption key in this browser.{' '}
                      <Link href={PRIVATE_REPOS_SETTINGS} className="hit-area font-medium text-forge-700 underline dark:text-forge-400">
                        {SET_UP_KEY}
                      </Link>
                      , or turn it on later in Settings.
                    </>
                  ) : withMembers ? (
                    'Members can post comments, reviews and issues only members can read. Everyone can still see that something was posted, by whom and when.'
                  ) : (
                    'Members can only post what everyone can read. A maintainer can turn it on later in Settings.'
                  )}
                </p>
                {withMembers && needsUnlock ? (
                  <div className="mt-2">
                    <UnlockMore title="Unlock to turn on members-only content" testId="new-members-unlock" />
                  </div>
                ) : withMembers && ops.error !== null ? (
                  <p className="mt-1 text-[12px] text-danger-700 dark:text-danger-400" data-testid="members-key-error">
                    Couldn&apos;t read your encryption key: {ops.error}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
          {isPrivate ? (
            <div className="rounded-md border border-anvil-200 p-3 text-[12px] text-anvil-600 dark:border-anvil-750 dark:text-anvil-300" data-testid="private-facts">
              <ul className="list-disc space-y-0.5 pl-4">
                {PRIVATE_FACTS.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {description.trim() ? <p className="mt-2 text-caution-700 dark:text-caution-400">{PUBLIC_DESCRIPTION_NOTE}</p> : null}
              {needsUnlock ? (
                <div className="mt-2">
                  <UnlockMore title="Unlock to create a private repo" testId="new-private-unlock" />
                </div>
              ) : ops.error !== null ? (
                <p className="mt-2 text-danger-700 dark:text-danger-400" data-testid="private-key-error">
                  Couldn&apos;t read your encryption key: {ops.error}
                </p>
              ) : null}
              {noKey ? (
                <p className="mt-2 text-caution-700 dark:text-caution-400" data-testid="private-no-key">
                  cannot create a private repository: your identity has no encryption key in this browser. Add it in{' '}
                  <Link href="/settings/" className="text-forge-700 underline dark:text-forge-400">
                    Settings → Members-only and private content
                  </Link>
                  .
                </p>
              ) : null}
            </div>
          ) : null}

          <Field label="Default branch" htmlFor="repo-branch">
            <div className="relative">
              <GitBranch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-anvil-500 dark:text-anvil-400" aria-hidden />
              <Input
                id="repo-branch"
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
                className="pl-8 font-mono"
                aria-invalid={branchError !== null}
                aria-describedby={branchError !== null ? 'repo-branch-error' : undefined}
              />
            </div>
            {branchError !== null ? (
              <p id="repo-branch-error" className="mt-1 text-[12px] text-danger-700 dark:text-danger-400">
                {branchError}
              </p>
            ) : null}
          </Field>

          <div className="flex items-start gap-2.5 rounded-md border border-anvil-200 p-3 dark:border-anvil-750">
            <input
              id="repo-protect"
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-forge-700"
              checked={protect}
              onChange={(e) => setProtect(e.target.checked)}
              aria-describedby="repo-protect-hint"
              data-testid="repo-protect"
            />
            <div className="min-w-0">
              <label htmlFor="repo-protect" className="text-dense font-medium">
                Protect <span className="break-all font-mono">{branchShown}</span> and tags
              </label>
              <p id="repo-protect-hint" className="text-[12px] text-anvil-500 dark:text-anvil-400">
                {protect
                  ? 'Only maintainers can push to it or create and move tags. Writers open pull requests. Change this later in Settings.'
                  : 'Any writer can push to it and move tags, including the ones releases point to.'}
              </p>
            </div>
          </div>

          {differs ? (
            <p className="text-[12px] text-caution-700 dark:text-caution-400">
              An unfinished creation of this name started with different settings; finishing it keeps those. Change them after
              it exists.
            </p>
          ) : null}
          <CostPreview cost={cost} />
          <p className="-mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
            One-time. Code goes to storage you choose when you push; Platform keeps manifests and refs.
          </p>

          {progress ? (
            <ol aria-label="Creation steps" className="space-y-1 rounded-md border border-anvil-200 p-3 dark:border-anvil-800">
              {STEPS.filter(({ step }) => progress[step] !== undefined).map(({ step, label, privateLabel }) => (
                <li key={step} className="flex items-center gap-2 text-dense">
                  {progress[step] === 'done' ? (
                    <Check className="h-4 w-4 text-verify-700 dark:text-verify-400" aria-hidden />
                  ) : progress[step] === 'running' ? (
                    <Loader2 className="h-4 w-4 animate-spin text-anvil-500 dark:text-anvil-400" aria-hidden />
                  ) : (
                    <span className="h-4 w-4 rounded-full border border-anvil-300 dark:border-anvil-700" aria-hidden />
                  )}
                  {isPrivate ? (privateLabel ?? label) : label}
                </li>
              ))}
            </ol>
          ) : null}

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={name.trim() === '' || nameError !== null || branchError !== null || guard.disabledReason !== null || privateBlocked !== null}
            title={guard.disabledReason ?? privateBlocked ?? undefined}
            onClick={() => {
              if (guard.check(cost, 'core', 'create a repository')) setConfirm(input())
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
            ? `You'll be its maintainer. ${protectionNote(confirm)}${PRIVATE_FACTS.map((f) => f.charAt(0).toUpperCase() + f.slice(1)).join('. ')}. The name and visibility are permanent, and repos can be archived but not deleted.`
            : `You'll be its maintainer. ${confirm ? protectionNote(confirm) : ''}${confirm?.membersOnly === true ? 'Members-only content will be on: members can post things only members can read. ' : ''}The name is permanent, and repos can be archived but not deleted.`
        }
        cost={confirm ? costOf(confirm) : cost}
        confirmLabel="Sign & create"
        successNote="Created — opening your repo"
        toast={{ running: 'Creating the repository…', done: 'Repository created', failed: 'Repository creation stopped part-way' }}
        onConfirm={() => (confirm ? create(confirm) : Promise.resolve())}
      />
    </AppShell>
  )
}
