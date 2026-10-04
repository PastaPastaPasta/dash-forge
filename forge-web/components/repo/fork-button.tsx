'use client'

/**
 * Fork — a forge-v2 fork from the browser (`ux-dx-spec.md` §1d, P0 #14), the same documents
 * `dg repo fork` writes: the fork's `repo` (with `forkOf`), its owner's `maintainer` and first
 * `config`, one `packManifest` per parent pack by reference (nothing re-uploaded), and the
 * parent's branches and tags. As on GitHub, "Copy the <default> branch only" is ticked to start
 * with (QW3-010: forking dash copied 604 refs, one signed write each). The dialog prices all of
 * it, says roughly how long the writes take, and lists the steps as they run; an interrupted
 * fork is finished by forking again under the same name.
 */

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, GitFork, Loader2 } from 'lucide-react'

import { checkForkName, descriptionProblem, forkRepoV2, normalizeRepoName, planFork, type ForkNameCheck, type ForkStep, type RepoRef } from '@/lib/repo'
import { withoutMirrorMarker } from '@/lib/view/mirror-source'
import { previewCreate, sumPreviews, type FirstWrite } from '@/lib/sdk'
import { errorMessage } from '@/lib/utils'
import { spendAction } from '@/lib/spend-toast'
import { plural } from '@/lib/view/format'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'

const STEPS: readonly { step: ForkStep; label: string }[] = [
  { step: 'repo', label: 'The fork' },
  { step: 'maintainer', label: 'You, as its first maintainer' },
  { step: 'config', label: 'Initial config' },
  { step: 'manifests', label: "The parent's packs, by reference" },
  { step: 'refs', label: "The parent's branches and tags" },
]

/**
 * About how long one signed write takes, for the dialog's estimate: on bonsia a dips fork (32
 * writes) took about 90 s (QA wave 3). Writes run one after another.
 */
const SECONDS_PER_WRITE = 3

/** "under a minute" / "about 20 minutes" for `writes` signed writes in a row. */
export function forkDuration(writes: number): string {
  const minutes = Math.round((writes * SECONDS_PER_WRITE) / 60)
  return minutes < 1 ? 'under a minute' : `about ${plural(minutes, 'minute')}`
}

type Progress = Partial<Record<ForkStep, { state: 'running' | 'done'; count?: string }>>

/** A fork whose repo landed but that could copy no branches: some parent packs have no copy to point at. */
class IncompleteFork extends Error {
  constructor(readonly packs: number) {
    super('fork incomplete')
  }
}

/** What a fork takes from its parent, as on GitHub: its default branch and (editable) description. */
export interface ForkDefaults {
  readonly defaultBranch: string
  readonly description: string
}

export function ForkButton({ parent, defaults }: { parent: RepoRef; defaults: ForkDefaults }): JSX.Element {
  const { identity } = useAuth()
  const guard = useWriteGuard()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          // Signed out, the sheet names the fork (L-62); its price is in the fork dialog, which
          // reads the parent's packs and refs first.
          if (guard.check(0, 'core', 'fork this repo')) setOpen(true)
        }}
        disabled={guard.disabledReason !== null}
        title={guard.disabledReason ?? 'Fork this repository'}
      >
        <GitFork className="h-3.5 w-3.5" aria-hidden /> Fork
      </Button>
      {open && identity !== null ? <ForkDialog parent={parent} defaults={defaults} owner={identity} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function ForkDialog({ parent, defaults, owner, onClose }: { parent: RepoRef; defaults: ForkDefaults; owner: string; onClose: () => void }): JSX.Element {
  const { sdk, ready } = useSdk()
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const router = useRouter()
  const [name, setName] = useState(parent.name)
  // The parent's description, less a mirror's "(mirror of …)" marker: a fork is no mirror (QW3-011).
  const [description, setDescription] = useState(() => withoutMirrorMarker(defaults.description))
  // GitHub's default: the default branch alone. Unticked, every branch and tag is copied.
  const [defaultOnly, setDefaultOnly] = useState(true)
  const defaultRef = `refs/heads/${defaults.defaultBranch}`
  const descriptionError = descriptionProblem(description)
  const [check, setCheck] = useState<ForkNameCheck | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const plan = useAsync(() => planFork(sdk!, parent), [ready, parent.repoId], { enabled: ready && sdk !== null })

  let nameError: string | null = null
  let normalized = ''
  try {
    normalized = normalizeRepoName(name)
    if (owner === parent.ownerId && normalized === parent.name) nameError = 'This repository is yours; pick another name for the fork.'
  } catch (e) {
    nameError = errorMessage(e)
  }

  // A name the owner already uses for something else: suggest `<name>-fork` once.
  const [suggested, setSuggested] = useState(false)
  useEffect(() => {
    if (!sdk || nameError !== null) return
    let live = true
    const t = setTimeout(() => {
      checkForkName(sdk, parent, owner, normalized).then(
        (c) => {
          if (!live) return
          if (c.kind === 'taken' && !suggested && normalized === parent.name) {
            setSuggested(true)
            setName(`${parent.name}-fork`)
            return
          }
          setCheck(c)
        },
        () => live && setCheck(null),
      )
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [sdk, parent, owner, normalized, nameError, suggested])

  // The refs this fork copies: the default branch alone, or every branch and tag.
  const refs = useMemo(() => (plan.data?.refs ?? []).filter((r) => !defaultOnly || r.refName === defaultRef), [plan.data, defaultOnly, defaultRef])
  const cost = useMemo(() => {
    const p = plan.data
    const manifests = p?.manifests ?? []
    // After the fork's repo document, the owner has written to forge-core, and the new repo has
    // no config, pack or ref yet: its first of each builds the repo's subtrees, and each ref name
    // is new to it (QW3-037: the plan priced every write as a steady one).
    const after: FirstWrite = { contract: false }
    return sumPreviews([
      previewCreate('repo', { name: normalized || parent.name, description: description.trim(), defaultBranch: defaults.defaultBranch, visibility: 'public' }),
      previewCreate('maintainer', {}, after),
      previewCreate('config', { defaultBranch: defaults.defaultBranch }, { ...after, repo: true }),
      ...manifests.map((m, i) => previewCreate('packManifest', { uris: m.uris }, { ...after, repo: i === 0 })),
      ...refs.map((r, i) => previewCreate('refUpdate', { refName: r.refName }, { ...after, repo: i === 0, target: true })),
    ])
  }, [plan.data, refs, normalized, parent.name, description, defaults.defaultBranch])

  const run = async (): Promise<void> => {
    if (!sdk || !signer || pending || nameError !== null || descriptionError !== null || check?.kind === 'taken') return
    if (!guard.check(cost)) return
    setPending(true)
    setError(null)
    setProgress({})
    try {
      // Every document of the fork shows in one toast, with their total (QW3-039). A fork that
      // could copy no branches did not finish: its toast says so.
      const result = await spendAction(
        { running: `Forking ${parent.name}…`, done: `Forked ${parent.name} as ${normalized}`, failed: `Fork of ${parent.name} stopped part-way` },
        async (tag) => {
          const r = await forkRepoV2(
            sdk,
            tag(signer),
            parent,
            { name: normalized, description: description.trim(), defaultBranch: defaults.defaultBranch, defaultBranchOnly: defaultOnly },
            (p) =>
              setProgress((prev) => ({
                ...(prev ?? {}),
                [p.step]: { state: p.state === 'start' ? 'running' : 'done', ...(p.total ? { count: `${p.done ?? 0} of ${p.total}` } : {}) },
              })),
          )
          if (r.unreferenceable.length > 0) throw new IncompleteFork(r.unreferenceable.length)
          return r
        },
      )
      router.push(`/repo/?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(result.name)}&created=1`)
    } catch (e) {
      setError(
        e instanceof IncompleteFork
          ? `Forked, but ${e.packs} of the parent's packs have no copy a fork can point at, so no branches were copied. Push your branches to the fork.`
          : guard.failed(e),
      )
      setPending(false)
    }
  }

  const p = plan.data
  return (
    <Dialog
      open
      onClose={pending ? () => undefined : onClose}
      title={`Fork ${parent.name}`}
      description="A new repository of yours that points at this one's packs. Nothing is re-uploaded."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run} loading={pending} disabled={nameError !== null || descriptionError !== null || check === null || check.kind === 'taken' || plan.data === null || guard.disabledReason !== null}>
            {check?.kind === 'resume' ? 'Finish the fork' : 'Sign & fork'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Fork name" htmlFor="fork-name" hint="Lowercase; letters, digits, and . _ - (max 63). Permanent.">
          <Input id="fork-name" value={name} onChange={(e) => {
            setName(e.target.value)
            setCheck(null)
          }} className="font-mono" spellCheck={false} disabled={pending} />
        </Field>
        {nameError ? <p className="-mt-1 text-[12px] text-danger-700 dark:text-danger-400">{nameError}</p> : null}
        {suggested && normalized === `${parent.name}-fork` ? (
          <p className="-mt-1 text-[12px] text-anvil-600 dark:text-anvil-400">You already have a repository named {parent.name}, so this suggests {normalized}.</p>
        ) : null}
        {check?.kind === 'taken' ? <p className="-mt-1 text-[12px] text-danger-700 dark:text-danger-400">You already have a repository named {normalized} that is not a fork of this one.</p> : null}
        {check?.kind === 'resume' ? <p className="-mt-1 text-[12px] text-caution-700 dark:text-caution-400">An earlier fork under this name did not finish; this completes it without paying twice.</p> : null}
        {/* A resumed fork keeps the repo and config its first run wrote: nothing here would apply. */}
        {check?.kind === 'resume' ? null : (
          <>
            <Field label="Description (optional)" htmlFor="fork-description" hint="The parent's, to start with. You can change it later in Settings.">
              <Textarea id="fork-description" value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[56px]" disabled={pending} maxLength={500} />
            </Field>
            {descriptionError ? <p className="-mt-1 text-[12px] text-danger-700 dark:text-danger-400">{descriptionError}</p> : null}
            <p className="text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="fork-default-branch">
              Default branch: <span className="font-mono">{defaults.defaultBranch}</span>, as in {parent.name}.
            </p>
          </>
        )}

        {plan.error ? (
          <p className="text-dense text-danger-700 dark:text-danger-400">Couldn&apos;t read what to fork: {plan.error}</p>
        ) : p === null ? (
          <p className="text-dense text-anvil-600 dark:text-anvil-400">
            <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" aria-hidden /> Reading the parent&apos;s packs and branches…
          </p>
        ) : (
          <>
            {p.unreferenceable.length === 0 ? (
              <label className="flex items-start gap-2 text-dense coarse:min-h-11">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-forge-700"
                  checked={defaultOnly}
                  onChange={(e) => setDefaultOnly(e.target.checked)}
                  disabled={pending}
                  data-testid="fork-default-only"
                />
                <span>
                  Copy the <span className="font-mono">{defaults.defaultBranch}</span> branch only
                  <span className="block text-[12px] text-anvil-600 dark:text-anvil-400">
                    {parent.name} has {plural(branchCount(p.refs), 'branch', 'branches')} and {plural(p.refs.length - branchCount(p.refs), 'tag')}; each one copied
                    is a signed write.{defaultOnly ? ' Untick to copy them all.' : ''}
                  </span>
                </span>
              </label>
            ) : null}
            <p className="text-dense text-anvil-700 dark:text-anvil-200" data-testid="fork-plan">
              Repository, maintainer and config, {plural(p.manifests.length, 'pack manifest')} by reference, and {copiedRefs(refs)} copied:{' '}
              {plural(3 + p.manifests.length + refs.length, 'signed write')}, {forkDuration(3 + p.manifests.length + refs.length)}.
            </p>
            {defaultOnly && refs.length === 0 && p.refs.length > 0 && p.unreferenceable.length === 0 ? (
              <p className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="fork-no-default">
                {parent.name} has no <span className="font-mono">{defaults.defaultBranch}</span> branch yet: untick to copy its other branches.
              </p>
            ) : null}
            {p.unreferenceable.length > 0 ? (
              <p className="text-[12px] text-caution-700 dark:text-caution-400">
                {plural(p.unreferenceable.length, 'pack')} {p.unreferenceable.length === 1 ? 'has' : 'have'} no copy a fork can point at, so branches will not be copied.
              </p>
            ) : null}
            <CostPreview cost={cost} />
          </>
        )}

        {progress ? (
          <ol aria-label="Fork steps" className="space-y-1 rounded-md border border-anvil-200 p-3 dark:border-anvil-800">
            {STEPS.map(({ step, label }) => {
              const s = progress[step]
              return (
                <li key={step} className="flex items-center gap-2 text-dense" data-state={s?.state ?? 'todo'}>
                  {s?.state === 'done' ? (
                    <Check className="h-4 w-4 text-verify-700 dark:text-verify-400" aria-hidden />
                  ) : s?.state === 'running' ? (
                    <Loader2 className="h-4 w-4 animate-spin text-anvil-500 dark:text-anvil-400" aria-hidden />
                  ) : (
                    <span className="h-4 w-4 rounded-full border border-anvil-300 dark:border-anvil-700" aria-hidden />
                  )}
                  {label}
                  {s?.count ? <span className="text-[12px] text-anvil-600 dark:text-anvil-400">{s.count}</span> : null}
                </li>
              )
            })}
          </ol>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400 break-words">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}

/** How many of `refs` are branches. */
function branchCount(refs: readonly { refName: string }[]): number {
  return refs.filter((r) => r.refName.startsWith('refs/heads/')).length
}

/** "the main branch", "3 branches and 1 tag", "no branches": what a fork copies. */
function copiedRefs(refs: readonly { refName: string }[]): string {
  const branches = branchCount(refs)
  const tags = refs.length - branches
  if (refs.length === 0) return 'no branches'
  const parts = [branches > 0 ? plural(branches, 'branch', 'branches') : null, tags > 0 ? plural(tags, 'tag') : null].filter((x) => x !== null)
  return parts.join(' and ')
}
