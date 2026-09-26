'use client'

/**
 * "New release" on the releases page (`ux-dx-spec.md` §5.9), maintainers only (consensus
 * refuses anyone else's `release`, and the role is re-read before anything uploads). Assets are
 * uploaded to the publisher's own storage (the repo's browser-push policy from Settings →
 * Storage), each verified and hashed, then one `release` document names them, with its cost
 * shown before signing. Nothing goes to Platform but that one small document.
 *
 * Retries are safe: the write's intent is held by the button (it survives closing the dialog)
 * and bound to the content, so "Retry" after an unconfirmed write finishes the same signed
 * transition, and edited content always signs a new one.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, FilePlus2, Loader2, Plus, XCircle } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { formatBytes } from '@/lib/view'
import type { ReleaseList } from '@/lib/repo'
import {
  ReleaseWriteError,
  assetFilesProblem,
  assetPlanProblem,
  plannedAsset,
  publishRelease,
  releaseTextProblem,
  tagProblem,
} from '@/lib/repo/new-release'
import { externalTargets, policyForRepo } from '@/lib/storage'
import { UnconfirmedWriteError, previewCreate } from '@/lib/sdk'
import { invalidateSessionCache } from '@/lib/view/session-cache'
import { writeErrorMessage } from '@/lib/view/write-errors'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useIntent } from '@/hooks/use-intent'
import { useStorageConfig } from '@/hooks/use-storage-config'
import { useUiStore } from '@/hooks/use-ui-store'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { cn } from '@/lib/utils'

type AssetState = { readonly state: 'waiting' | 'uploading' | 'failed' } | { readonly state: 'done'; readonly copies: number; readonly of: number }

function AssetStateIcon({ state }: { state: AssetState | undefined }): JSX.Element | null {
  switch (state?.state) {
    case 'uploading':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-anvil-500" aria-hidden />
    case 'done':
      return state.copies < state.of ? (
        <AlertTriangle className="h-3.5 w-3.5 text-caution-700 dark:text-caution" aria-hidden />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5 text-verify-700 dark:text-verify" aria-hidden />
      )
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-danger-700 dark:text-danger-400" aria-hidden />
    default:
      return null
  }
}

function stateText(s: AssetState | undefined): string {
  if (s === undefined) return ''
  if (s.state === 'done') return s.copies < s.of ? `stored, verified (${s.copies} of ${s.of} copies)` : `stored, verified (${s.copies} ${s.copies === 1 ? 'copy' : 'copies'})`
  return s.state
}

export function NewReleaseButton({ home, releases, onPublished }: { home: RepoHome; releases: ReleaseList | null; onPublished: () => void }): JSX.Element | null {
  const { role } = useViewerRole(home.repo)
  const [open, setOpen] = useState(false)
  // Held here, not in the dialog: closing it must not lose a write's intent.
  const draft = useIntent()
  if (home.repo.kind !== 'v2' || role !== 'maintainer') return null
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" aria-hidden /> New release
      </Button>
      {open ? (
        <NewReleaseDialog
          home={home}
          releases={releases}
          draft={draft.intent}
          onClose={() => setOpen(false)}
          onPublished={() => {
            draft.renew()
            onPublished()
          }}
        />
      ) : null}
    </>
  )
}

function NewReleaseDialog({
  home,
  releases,
  draft,
  onClose,
  onPublished,
}: {
  home: RepoHome
  releases: ReleaseList | null
  draft: string
  onClose: () => void
  onPublished: () => void
}): JSX.Element {
  const repo = home.repo.kind === 'v2' ? home.repo : null
  const { sdk, network } = useSdk()
  const { signer } = useAuth()
  const openTopUp = useUiStore((s) => s.openTopUp)
  const guard = useWriteGuard()
  const { config } = useStorageConfig()
  const [tag, setTag] = useState('')
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [progress, setProgress] = useState<Record<string, AssetState>>({})
  const [phase, setPhase] = useState<'edit' | 'publishing' | 'unconfirmed' | 'done'>('edit')
  const [touched, setTouched] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)

  const policy = config && repo ? policyForRepo(config, repo.repoId) : null
  const profiles = useMemo(() => config?.profiles ?? [], [config])
  const targets = externalTargets(policy, profiles)
  const trimmedTag = tag.trim()
  const problem =
    tagProblem(trimmedTag) ?? releaseTextProblem({ name: title.trim(), notes: notes.trimEnd() }) ?? assetFilesProblem(files) ?? assetPlanProblem(files, policy, profiles)
  // The release document as it will be written, with placeholder hashes: sizes the cost.
  const cost = useMemo(
    () => previewCreate('release', { tagName: trimmedTag, name: title.trim(), notes: notes.trimEnd(), assets: JSON.stringify(files.map((f) => plannedAsset(f.name, f.size, policy, profiles))) }),
    [trimmedTag, title, notes, files, policy, profiles],
  )
  const existing = releases?.current.find((r) => r.tagName === trimmedTag) ?? null
  const locked = phase !== 'edit'

  const publish = async (): Promise<void> => {
    setTouched(true)
    if (phase === 'publishing' || phase === 'done') return
    if (!sdk || !signer || !repo || problem !== null || !guard.check(cost.credits)) return
    setPhase('publishing')
    setError(null)
    setStatus('Checking you are a maintainer…')
    setProgress(Object.fromEntries(files.map((f) => [f.name, { state: 'waiting' } as AssetState])))
    let stored = 0
    try {
      await publishRelease(
        sdk,
        signer,
        repo,
        { tagName: trimmedTag, name: title.trim(), notes: notes.trimEnd(), files, draft },
        { policy, profiles },
        (e) => {
          if (e.step === 'upload' && e.event.phase === 'start') {
            setProgress((p) => ({ ...p, [e.asset]: { state: 'uploading' } }))
            setStatus(`Uploading ${e.asset}…`)
          }
          if (e.step === 'upload' && e.event.phase === 'failed') setProgress((p) => ({ ...p, [e.asset]: p[e.asset]?.state === 'done' ? p[e.asset] as AssetState : { state: 'failed' } }))
          if (e.step === 'uploaded') {
            stored += 1
            setProgress((p) => ({ ...p, [e.asset]: { state: 'done', copies: e.copies, of: e.copies + e.failures.length } }))
            setStatus(`${e.asset} stored and verified.`)
          }
          if (e.step === 'release') setStatus('Writing the release…')
        },
      )
      invalidateSessionCache(`releases:${network}:`)
      setPhase('done')
      setStatus('Release published.')
      onPublished()
    } catch (e) {
      const inner = e instanceof ReleaseWriteError ? e.cause : e
      const { message, keyLimit } = writeErrorMessage(inner)
      if (keyLimit) openTopUp({ blocker: 'key-budget' })
      const context =
        e instanceof ReleaseWriteError && e.assetsStored > 0
          ? ` The ${e.assetsStored === 1 ? 'asset was' : `${e.assetsStored} assets were`} uploaded and verified (content-addressed): publishing again reuses them.`
          : stored > 0
            ? ` ${stored} ${stored === 1 ? 'asset was' : 'assets were'} stored before this; publishing again reuses them.`
            : ''
      if (inner instanceof UnconfirmedWriteError) {
        // The write may still land: keep the content fixed, so a retry finishes the same one.
        setPhase('unconfirmed')
        setError(`${message}${context} Retry finishes the same write; nothing is signed twice.`)
      } else {
        setPhase('edit')
        setError(`${message}${context}`)
      }
      setStatus('Publishing stopped.')
    }
  }

  const busy = phase === 'publishing'
  const shownProblem = touched || trimmedTag !== '' ? problem : null
  const disabledReason = guard.disabledReason ?? (shownProblem ?? (problem !== null ? 'fill in the tag' : null))

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title="Publish a release"
      description="Maintainers only. Assets go to your own storage, hashed; the release itself is one small Platform document."
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {phase === 'done' ? 'Close' : 'Cancel'}
          </Button>
          {phase !== 'done' ? (
            <Button
              variant="primary"
              onClick={publish}
              loading={busy}
              disabled={problem !== null || guard.disabledReason !== null}
              title={disabledReason ?? undefined}
              aria-describedby="release-problem"
            >
              {phase === 'unconfirmed' ? 'Retry (finish the same write)' : 'Sign & publish'}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Tag" htmlFor="release-tag" hint="The git tag this release is for, e.g. v1.2.0 (push the tag with git; publishing does not create it).">
          <Input id="release-tag" value={tag} onChange={(e) => setTag(e.target.value)} onBlur={() => setTouched(true)} className="font-mono" placeholder="v1.0.0" disabled={locked} autoFocus />
        </Field>
        {existing ? (
          <p role="note" className="flex items-start gap-1.5 text-[12px] text-caution-700 dark:text-caution">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {trimmedTag} already has a release{existing.name ? ` (“${existing.name}”)` : ''}. This one replaces it as the current release; its assets are not carried over, and the old one is listed as previous.
          </p>
        ) : null}
        <Field label="Title (optional)" htmlFor="release-title">
          <Input id="release-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={locked} />
        </Field>
        <Field label="Notes (optional)" htmlFor="release-notes" hint="Markdown supported.">
          <Textarea id="release-notes" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={locked} />
        </Field>
        <div className="space-y-1.5">
          <label htmlFor="release-assets" className="flex items-center gap-1.5 text-dense font-medium text-anvil-700 dark:text-anvil-200">
            <FilePlus2 className="h-3.5 w-3.5" aria-hidden /> Assets (optional)
          </label>
          <input
            id="release-assets"
            type="file"
            multiple
            disabled={locked}
            aria-describedby="release-assets-hint"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="block w-full text-dense text-anvil-700 file:mr-3 file:rounded-md file:border file:border-anvil-300 file:bg-transparent file:px-3 file:py-1.5 file:text-dense dark:text-anvil-200 dark:file:border-anvil-700"
          />
          <p id="release-assets-hint" className="text-[12px] text-anvil-500 dark:text-anvil-400">
            {targets.length > 0 ? (
              <>Uploaded to {targets.join(', ')} and verified before the release is written. Up to 256 MiB per file.</>
            ) : (
              <>
                No storage of your own chosen for this repo (release assets never go to Platform).{' '}
                <Link href="/settings/storage" className="text-forge-700 underline dark:text-forge-400">Set up storage</Link> to attach assets.
              </>
            )}
          </p>
          {files.length > 0 ? (
            <ul className="divide-y divide-anvil-100 rounded-md border border-anvil-200 text-dense dark:divide-anvil-850 dark:border-anvil-800" aria-label="Assets to publish">
              {files.map((f) => {
                const s = progress[f.name]
                return (
                  <li key={f.name} className="flex items-center gap-2 px-3 py-1.5" data-testid={`asset-${f.name}`} data-state={s?.state ?? 'waiting'}>
                    <AssetStateIcon state={s} />
                    <span className="min-w-0 flex-1 truncate font-mono">{f.name}</span>
                    <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{formatBytes(f.size)}</span>
                    {s ? <span className={cn('text-[12px]', s.state === 'failed' ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400')}>{stateText(s)}</span> : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
        <CostPreview cost={cost} />
        <p id="release-problem" className="text-[12px] text-caution-700 dark:text-caution">
          {shownProblem ?? ''}
        </p>
        <p role="status" aria-live="polite" className={cn('text-dense', phase === 'done' ? 'text-verify-700 dark:text-verify' : 'sr-only')}>
          {status}
        </p>
        {error ? (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 break-words dark:text-danger-400">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
