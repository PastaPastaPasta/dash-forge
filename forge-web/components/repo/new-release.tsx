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
import { ARCHIVED_REASON, formatBytes, plural } from '@/lib/view'
import type { ReleaseList } from '@/lib/repo'
import {
  NO_STORAGE_GAP,
  ReleaseWriteError,
  type ReleaseStorageGap,
  type ResolvedRelease,
  assetFilesProblem,
  assetPlanProblem,
  carriedAssets,
  plannedAsset,
  publishRelease,
  releaseStorageGap,
  releaseTextProblem,
  tagProblem,
} from '@/lib/repo/new-release'
import { PRIVATE_RELEASE_REFUSED } from '@/lib/repo'
import { externalTargets, policyForRepo } from '@/lib/storage'
import { UnconfirmedWriteError, previewCreate } from '@/lib/sdk'
import { invalidateSessionCache } from '@/lib/view/session-cache'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useIntent } from '@/hooks/use-intent'
import { useStorageConfig } from '@/hooks/use-storage-config'
import { repoHref, useRepoAddress } from '@/hooks/use-query-param'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Button } from '@/components/ui/button'
import { UnlockMore } from '@/components/auth/unlock-more'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { cn } from '@/lib/utils'

type AssetState = { readonly state: 'waiting' | 'uploading' | 'failed' } | { readonly state: 'done'; readonly copies: number; readonly of: number }

function AssetStateIcon({ state }: { state: AssetState | undefined }): JSX.Element | null {
  switch (state?.state) {
    case 'uploading':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-anvil-500 dark:text-anvil-400" aria-hidden />
    case 'done':
      return state.copies < state.of ? (
        <AlertTriangle className="h-3.5 w-3.5 text-caution-700 dark:text-caution-400" aria-hidden />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden />
      )
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-danger-700 dark:text-danger-400" aria-hidden />
    default:
      return null
  }
}

/** The link that fixes a {@link ReleaseStorageGap}, in words. */
function gapLinkLabel(gap: ReleaseStorageGap): string {
  if (gap.reason === 'no-profiles') return 'Set up storage'
  return gap.fix === 'repo' ? "Open this repo's storage settings" : 'Choose your default storage'
}

function stateText(s: AssetState | undefined): string {
  if (s === undefined) return ''
  if (s.state === 'done') return s.copies < s.of ? `stored, verified (${s.copies} of ${s.of} copies)` : `stored, verified (${plural(s.copies, 'copy', 'copies')})`
  return s.state
}

export function NewReleaseButton({ home, releases, onPublished }: { home: RepoHome; releases: ReleaseList | null; onPublished: () => void }): JSX.Element | null {
  const { role, known } = useViewerRole(home.repo)
  const [open, setOpen] = useState(false)
  // Held here, not in the dialog: closing it must not lose a write's intent.
  const draft = useIntent()
  // A settled marker (no visible output): tests can tell "no button" from "not decided yet".
  if (role !== 'maintainer') return known ? <span hidden data-testid="new-release-role" data-role={role ?? 'none'} /> : null
  const archived = home.config?.archived === true
  // This client does not seal releases, and a private repo's plaintext release is refused (RC1).
  const blocked = archived ? ARCHIVED_REASON : home.repo.visibility === 'private' ? PRIVATE_RELEASE_REFUSED : null
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)} disabled={blocked !== null} title={blocked ?? undefined} data-testid="new-release">
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
  const repo = home.repo
  const addr = useRepoAddress()
  const { sdk, network } = useSdk()
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const { config, needsUnlock: storageNeedsUnlock } = useStorageConfig()
  const [tag, setTag] = useState('')
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [yanked, setYanked] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [progress, setProgress] = useState<Record<string, AssetState>>({})
  const [phase, setPhase] = useState<'edit' | 'publishing' | 'unconfirmed' | 'done'>('edit')
  const [touched, setTouched] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  // After an unconfirmed release write: the release it named. Retry writes exactly it.
  const [pendingAssets, setPendingAssets] = useState<ResolvedRelease | null>(null)

  const policy = config && repo ? policyForRepo(config, repo.repoId) : null
  const profiles = useMemo(() => config?.profiles ?? [], [config])
  const targets = externalTargets(policy, profiles)
  // Why assets have nowhere to go, and the page that fixes it (L-10).
  const gap = config && repo ? releaseStorageGap(config, repo.repoId) : null
  const shownGap = gap ?? NO_STORAGE_GAP
  const fixHref = shownGap.fix === 'repo' ? `${repoHref('/repo/settings', addr)}#storage` : shownGap.reason === 'no-profiles' ? '/settings/storage/' : '/settings/storage/#policy-title'
  const trimmedTag = tag.trim()
  // A new revision of an existing tag supersedes it (newest per tag wins): what the form leaves
  // blank is kept, so a yank or a notes edit never drops the files (D-504).
  const existing = releases?.current.find((r) => r.tagName === trimmedTag) ?? null
  const kept = useMemo(() => carriedAssets(existing, files), [existing, files])
  const finalName = title.trim() || existing?.name || ''
  const finalNotes = notes.trimEnd() || existing?.notes || ''
  const problem =
    tagProblem(trimmedTag) ??
    releaseTextProblem({ name: finalName, notes: finalNotes }) ??
    assetFilesProblem(files) ??
    (files.length > 0 && gap !== null ? gap.message : null) ??
    assetPlanProblem(files, policy, profiles, kept)
  // The release document as it will be written, with placeholder hashes: sizes the cost.
  const cost = useMemo(
    () =>
      previewCreate('release', {
        tagName: trimmedTag,
        name: finalName,
        notes: finalNotes,
        yanked,
        assets: JSON.stringify([...kept, ...files.map((f) => plannedAsset(f.name, f.size, policy, profiles))]),
      }),
    [trimmedTag, finalName, finalNotes, yanked, kept, files, policy, profiles],
  )
  const locked = phase !== 'edit'

  const publish = async (): Promise<void> => {
    setTouched(true)
    if (phase === 'publishing' || phase === 'done') return
    if (!sdk || !signer || !repo || problem !== null || !guard.check(cost)) return
    setPhase('publishing')
    setError(null)
    setStatus('Checking you are a maintainer…')
    if (pendingAssets === null) setProgress(Object.fromEntries(files.map((f) => [f.name, { state: 'waiting' } as AssetState])))
    let stored = 0
    let current: string | null = null
    try {
      await publishRelease(
        sdk,
        signer,
        repo,
        { tagName: trimmedTag, name: title.trim(), notes: notes.trimEnd(), files, draft, yanked, ...(pendingAssets ? { stored: pendingAssets } : {}) },
        { policy, profiles },
        (e) => {
          if (e.step === 'upload' && e.event.phase === 'start') {
            current = e.asset
            setProgress((p) => ({ ...p, [e.asset]: { state: 'uploading' } }))
            setStatus(`Uploading ${e.asset}…`)
          }
          if (e.step === 'uploaded') {
            stored += 1
            setProgress((p) => ({ ...p, [e.asset]: { state: 'done', copies: e.copies, of: e.copies + e.failures.length } }))
            setStatus(`${e.asset} stored and verified.`)
          }
          if (e.step === 'release') setStatus('Writing the release…')
        },
      )
      invalidateSessionCache(`releases:${network}:${repo.repoId}`)
      setPendingAssets(null)
      setPhase('done')
      setStatus('Release published.')
      onPublished()
    } catch (e) {
      // The file whose upload threw (a single target failing is not the file failing).
      const failedFile = current
      if (!(e instanceof ReleaseWriteError) && failedFile !== null) setProgress((p) => (p[failedFile]?.state === 'done' ? p : { ...p, [failedFile]: { state: 'failed' } }))
      const inner = e instanceof ReleaseWriteError ? e.cause : e
      const message = guard.failed(inner)
      const context =
        e instanceof ReleaseWriteError && e.assetsStored > 0
          ? ` The ${e.assetsStored === 1 ? 'asset was' : `${e.assetsStored} assets were`} uploaded and verified (content-addressed): publishing again reuses them.`
          : stored > 0
            ? ` ${plural(stored, 'asset')} ${stored === 1 ? 'was' : 'were'} stored before this; publishing again reuses them.`
            : ''
      if (inner instanceof UnconfirmedWriteError && e instanceof ReleaseWriteError) {
        // The write may still land: keep the content AND its stored assets fixed, so a retry
        // uploads nothing and finishes the same signed write.
        setPendingAssets(e.resolved)
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
  const close = (): void => {
    if (busy) return
    if (phase === 'unconfirmed' && !window.confirm('The release write may still land. Close anyway? Reopening with other content signs a new release; retry here to finish this one.')) return
    onClose()
  }
  const shownProblem = touched || trimmedTag !== '' ? problem : null
  const disabledReason = guard.disabledReason ?? (shownProblem ?? (problem !== null ? 'fill in the tag' : null))

  return (
    <Dialog
      open
      onClose={close}
      title="Publish a release"
      description="Maintainers only. Assets go to your own storage, hashed; the release itself is one small Platform document."
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
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
          <p role="note" className="flex items-start gap-1.5 text-[12px] text-caution-700 dark:text-caution-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {trimmedTag} already has a release{existing.name ? ` (“${existing.name}”)` : ''}. This one replaces it as the current release and keeps its{' '}
            {plural(kept.length, 'asset')}
            {existing.assets.length > kept.length ? ` (a new file of the same name replaces ${existing.assets.length - kept.length})` : ''}, and its title and notes where you leave them blank. The old one is listed as previous.
            {existing.yanked && !yanked ? ' It is yanked now: publishing without "Yanked" ticked un-yanks it.' : ''}
          </p>
        ) : null}
        <Field label="Title (optional)" htmlFor="release-title">
          <Input id="release-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={existing?.name || undefined} disabled={locked} />
        </Field>
        <Field label="Notes (optional)" htmlFor="release-notes" hint="Markdown supported.">
          <Textarea id="release-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={existing?.notesBody || undefined} disabled={locked} />
        </Field>
        <label className="flex items-start gap-2 text-dense text-anvil-700 dark:text-anvil-200">
          <input type="checkbox" checked={yanked} onChange={(e) => setYanked(e.target.checked)} disabled={locked} className="mt-0.5" data-testid="release-yanked" />
          <span>
            Yanked: withdraw it (shown with a warning; its assets stay listed and downloadable).
          </span>
        </label>
        {repo.visibility === 'private' ? null : (
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
          {storageNeedsUnlock ? <UnlockMore title="Unlock to attach assets with your storage settings" testId="release-storage-unlock" /> : null}
          <p id="release-assets-hint" className="text-[12px] text-anvil-500 dark:text-anvil-400">
            {storageNeedsUnlock ? (
              <>Your storage settings open after you unlock this tab.</>
            ) : targets.length > 0 ? (
              <>Uploaded to {targets.join(', ')} and verified before the release is written. Up to 256 MiB per file.</>
            ) : (
              <span data-testid="release-storage-gap" data-reason={shownGap.reason}>
                {shownGap.message}{' '}
                <Link href={fixHref} className="text-forge-700 underline dark:text-forge-400">
                  {gapLinkLabel(shownGap)}
                </Link>
              </span>
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
        )}
        <CostPreview cost={cost} />
        <p id="release-problem" className="text-[12px] text-caution-700 dark:text-caution-400">
          {shownProblem ?? ''}
        </p>
        <p role="status" aria-live="polite" className={cn('text-dense', phase === 'done' ? 'text-verify-700 dark:text-verify-400' : 'sr-only')}>
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
