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
 *
 * On a private repo the release is a sealed revision (`private-repos.md` §16): the files are
 * sealed in this tab before they upload, the dialog shows the 1507-byte budget of the sealed
 * fields, and offers the sealed-only draft, pre-release and unpublish switches. What the form
 * leaves alone (a switch not touched, a blank title or notes) is carried from the tag's newest
 * revision. {@link EditReleaseButton} opens it for one sealed release: an edit, a yank or an
 * unpublish is a new revision that carries every other field.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, FilePlus2, Loader2, Lock, Pencil, Plus, XCircle } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { ARCHIVED_REASON, formatBytes, plural } from '@/lib/view'
import { repoKey, type ReleaseList } from '@/lib/repo'
import { Author } from '@/components/author'
import { Time } from '@/components/repo/byline'
import { privateComposeBlock } from '@/components/repo/private-compose'
import {
  SEALED_RELEASE_BUDGET,
  carriedFields,
  newestRevision,
  sealedReleasePreview,
  type SealedReleaseWarning,
} from '@/lib/repo/sealed-release'
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
  return <ReleaseDialogButton home={home} releases={releases} onPublished={onPublished} />
}

/**
 * A maintainer's "Edit" on one sealed release (§16.3): the dialog for its tag, where an edit, a
 * yank, an unpublish or a draft or pre-release change is a new revision carrying every field it
 * does not change.
 */
export function EditReleaseButton({ home, releases, tag, onPublished }: { home: RepoHome; releases: ReleaseList | null; tag: string; onPublished: () => void }): JSX.Element | null {
  return <ReleaseDialogButton home={home} releases={releases} onPublished={onPublished} tag={tag} />
}

function ReleaseDialogButton({ home, releases, onPublished, tag }: { home: RepoHome; releases: ReleaseList | null; onPublished: () => void; tag?: string }): JSX.Element | null {
  const { role, known } = useViewerRole(home.repo)
  const [open, setOpen] = useState(false)
  // Held here, not in the dialog: closing it must not lose a write's intent.
  const draft = useIntent()
  // A settled marker (no visible output): tests can tell "no button" from "not decided yet".
  if (role !== 'maintainer') return known && tag === undefined ? <span hidden data-testid="new-release-role" data-role={role ?? 'none'} /> : null
  const archived = home.config?.archived === true
  // A private repo's release is sealed under the current key: only a member holding it writes one.
  const blocked = archived ? ARCHIVED_REASON : privateComposeBlock(home)
  return (
    <>
      {tag === undefined ? (
        <Button variant="primary" size="sm" onClick={() => setOpen(true)} disabled={blocked !== null} title={blocked ?? undefined} data-testid="new-release">
          <Plus className="h-3.5 w-3.5" aria-hidden /> New release
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={blocked !== null}
          title={blocked ?? `Edit, yank or unpublish ${tag}`}
          aria-label={`Edit release ${tag}`}
          data-testid="edit-release"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
        </Button>
      )}
      {open ? (
        <NewReleaseDialog
          home={home}
          releases={releases}
          draft={draft.intent}
          {...(tag !== undefined ? { fixedTag: tag } : {})}
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

/** A sealed-only switch: `null` until touched, when the tag's newest revision's value is carried. */
type Carried = boolean | null

function NewReleaseDialog({
  home,
  releases,
  draft,
  fixedTag,
  onClose,
  onPublished,
}: {
  home: RepoHome
  releases: ReleaseList | null
  draft: string
  /** The tag of the release being edited (the field is then fixed). */
  fixedTag?: string
  onClose: () => void
  onPublished: () => void
}): JSX.Element {
  const repo = home.repo
  const sealedRepo = repo.visibility === 'private'
  const addr = useRepoAddress()
  const { sdk, network } = useSdk()
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const { config, needsUnlock: storageNeedsUnlock } = useStorageConfig()
  const [tag, setTag] = useState(fixedTag ?? '')
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  // A public release states its yank (unticked un-yanks it); a sealed revision carries it until touched.
  const [yankedChoice, setYanked] = useState<Carried>(sealedRepo ? null : false)
  const [draftChoice, setDraftFlag] = useState<Carried>(null)
  const [prereleaseChoice, setPrerelease] = useState<Carried>(null)
  const [unpublish, setUnpublish] = useState(false)
  const [warnings, setWarnings] = useState<readonly SealedReleaseWarning[]>([])
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
  // blank is kept, so a yank or a notes edit never drops the files (D-504). A sealed tag's newest
  // revision may be an unpublish: publishing again restores it.
  const existing = (releases && (sealedRepo ? newestRevision(releases, trimmedTag) : releases.current.find((r) => r.tagName === trimmedTag))) ?? null
  const sealedExisting = existing?.sealed?.fields
  const liveTag = existing !== null && sealedExisting?.unpublished !== true
  // Only a live tag can be unpublished: the switch left on for another tag says nothing.
  const unpublishing = unpublish && liveTag
  // An unpublish sends no files: the ones picked before do not count for it.
  const newFiles = unpublishing ? [] : files
  const kept = useMemo(() => carriedAssets(existing, files), [existing, files])
  const finalName = title.trim() || existing?.name || ''
  const finalNotes = notes.trimEnd() || existing?.notes || ''
  const yanked = yankedChoice ?? existing?.yanked ?? false
  const draftFlag = draftChoice ?? sealedExisting?.draft === true
  const prerelease = prereleaseChoice ?? sealedExisting?.prerelease === true
  // The sealed revision as the writer will build it: its budget (§16.2), whether it stores a new
  // asset list, and what that costs.
  const sealedPlan = useMemo(() => {
    if (!sealedRepo) return null
    const base = carriedFields(
      {
        tagName: trimmedTag,
        name: title.trim(),
        yanked: yankedChoice ?? undefined,
        draft: draftChoice ?? undefined,
        prerelease: prereleaseChoice ?? undefined,
        unpublished: unpublishing,
      },
      sealedExisting,
    )
    return sealedReleasePreview(base, notes.trimEnd(), newFiles.length)
  }, [sealedRepo, trimmedTag, title, notes, yankedChoice, draftChoice, prereleaseChoice, unpublishing, sealedExisting, newFiles.length])
  const problem =
    tagProblem(trimmedTag) ??
    releaseTextProblem(sealedRepo ? { name: title.trim(), notes: notes.trimEnd() } : { name: finalName, notes: finalNotes }) ??
    assetFilesProblem(newFiles) ??
    // A sealed revision whose notes continue stores an asset list even with no file.
    ((newFiles.length > 0 || sealedPlan?.storesList === true) && gap !== null ? gap.message : null) ??
    (sealedRepo ? null : assetPlanProblem(files, policy, profiles, kept))
  // The release document as it will be written, with placeholder hashes: sizes the cost.
  const publicCost = useMemo(
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
  const cost = sealedPlan?.cost ?? publicCost
  const locked = phase !== 'edit'

  const publish = async (): Promise<void> => {
    setTouched(true)
    if (phase === 'publishing' || phase === 'done') return
    if (!sdk || !signer || !repo || problem !== null || !guard.check(cost)) return
    setPhase('publishing')
    setError(null)
    setWarnings([])
    setStatus('Checking you are a maintainer…')
    if (pendingAssets === null) setProgress(Object.fromEntries(files.map((f) => [f.name, { state: 'waiting' } as AssetState])))
    let stored = 0
    let current: string | null = null
    try {
      const published = await publishRelease(
        sdk,
        signer,
        repo,
        {
          tagName: trimmedTag,
          name: title.trim(),
          notes: notes.trimEnd(),
          files: newFiles,
          draft,
          // An untouched switch (null) is absent: carried.
          yanked: yankedChoice ?? undefined,
          sealed: sealedRepo ? { draft: draftChoice ?? undefined, prerelease: prereleaseChoice ?? undefined, unpublished: unpublishing } : undefined,
          stored: pendingAssets ?? undefined,
        },
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
          if (e.step === 'resealing') {
            // Everything is sealed again under the new key: the files upload again.
            stored = 0
            setProgress(Object.fromEntries(newFiles.map((f) => [f.name, { state: 'waiting' } as AssetState])))
            setStatus('This repo’s key changed during the upload: sealing and uploading again…')
          }
          if (e.step === 'release') setStatus(sealedRepo ? 'Sealing and writing the release…' : 'Writing the release…')
        },
      )
      invalidateSessionCache(`releases:${network}:${repoKey(repo)}`)
      setPendingAssets(null)
      setPhase('done')
      setWarnings(published.warnings ?? [])
      setStatus(unpublishing ? 'Release unpublished.' : 'Release published.')
      onPublished()
    } catch (e) {
      // The file whose upload threw (a single target failing is not the file failing).
      const failedFile = current
      if (!(e instanceof ReleaseWriteError) && failedFile !== null) setProgress((p) => (p[failedFile]?.state === 'done' ? p : { ...p, [failedFile]: { state: 'failed' } }))
      const inner = e instanceof ReleaseWriteError ? e.cause : e
      const message = guard.failed(inner)
      // A sealed file gets a fresh file key every time it is sealed: publishing again uploads it again.
      const again = sealedRepo ? 'publishing again seals and uploads them again' : 'publishing again reuses them'
      const context =
        e instanceof ReleaseWriteError && e.assetsStored > 0
          ? ` The ${e.assetsStored === 1 ? 'asset was' : `${e.assetsStored} assets were`} uploaded and verified${sealedRepo ? '' : ' (content-addressed)'}: ${
              sealedRepo && inner instanceof UnconfirmedWriteError ? 'retrying reuses them' : again
            }.`
          : stored > 0
            ? ` ${plural(stored, 'asset')} ${stored === 1 ? 'was' : 'were'} stored before this; ${again}.`
            : ''
      if (inner instanceof UnconfirmedWriteError && e instanceof ReleaseWriteError) {
        // The write may still land: keep the content AND its stored assets fixed, so a retry
        // uploads nothing and finishes the same signed write.
        setPendingAssets(e.resolved)
        setPhase('unconfirmed')
        setError(`${message}${context} Retry finishes the same write; nothing is signed twice.`)
      } else {
        // A sealed revision that failed outright is built afresh from the form next time (a
        // retry of it, once refused, can only be refused again: the key moved, say).
        if (sealedRepo) setPendingAssets(null)
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
      title={fixedTag !== undefined ? `Edit release ${fixedTag}` : 'Publish a release'}
      description={
        sealedRepo
          ? 'Maintainers only. Encrypted to this repo’s members: files are sealed in this tab, then go to your own storage; the release itself is one small Platform document.'
          : 'Maintainers only. Assets go to your own storage, hashed; the release itself is one small Platform document.'
      }
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
              {phase === 'unconfirmed' ? 'Retry (finish the same write)' : unpublishing ? 'Sign & unpublish' : 'Sign & publish'}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Tag" htmlFor="release-tag" hint="The git tag this release is for, e.g. v1.2.0 (push the tag with git; publishing does not create it).">
          <Input
            id="release-tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            onBlur={() => setTouched(true)}
            className="font-mono"
            placeholder="v1.0.0"
            disabled={locked || fixedTag !== undefined}
            autoFocus={fixedTag === undefined}
          />
        </Field>
        {existing && sealedRepo ? (
          <p role="note" className="flex items-start gap-1.5 text-[12px] text-caution-700 dark:text-caution-400" data-testid="release-sealed-carry">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {trimmedTag} {liveTag ? 'already has a release' : 'was unpublished'}
              {existing.name ? ` (“${existing.name}”)` : ''}. This is a new revision: it keeps the current assets (a new file of the same name replaces one) and the
              title, notes and switches you leave alone. {liveTag ? 'The old one is listed as previous.' : 'Publishing it again restores the release.'}
            </span>
          </p>
        ) : existing ? (
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
        {sealedPlan ? <SealedBudget used={sealedPlan.used} limit={sealedPlan.limit} notesContinue={sealedPlan.notesContinue} /> : null}
        <label className="flex items-start gap-2 text-dense text-anvil-700 dark:text-anvil-200">
          <input type="checkbox" checked={yanked} onChange={(e) => setYanked(e.target.checked)} disabled={locked} className="mt-0.5" data-testid="release-yanked" />
          <span>
            Yanked: withdraw it (shown with a warning; its assets stay listed and downloadable).
          </span>
        </label>
        {sealedRepo ? (
          <fieldset className="space-y-2" aria-label="Encrypted release switches">
            <label className="flex items-start gap-2 text-dense text-anvil-700 dark:text-anvil-200">
              <input type="checkbox" checked={draftFlag} onChange={(e) => setDraftFlag(e.target.checked)} disabled={locked} className="mt-0.5" data-testid="release-draft-switch" />
              <span>Draft: marked as a draft, never the latest release and not counted. Every member still sees it: a label, not access control.</span>
            </label>
            <label className="flex items-start gap-2 text-dense text-anvil-700 dark:text-anvil-200">
              <input type="checkbox" checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} disabled={locked} className="mt-0.5" data-testid="release-prerelease-switch" />
              <span>Pre-release: never the latest release (a tag like v2.0.0-rc.1 is one anyway).</span>
            </label>
            {liveTag ? (
              <label className="flex items-start gap-2 text-dense text-anvil-700 dark:text-anvil-200">
                <input type="checkbox" checked={unpublish} onChange={(e) => setUnpublish(e.target.checked)} disabled={locked} className="mt-0.5" data-testid="release-unpublish" />
                <span>Unpublish: take the release down. Every field is kept (the yank too), so publishing the tag again restores it.</span>
              </label>
            ) : null}
          </fieldset>
        ) : null}
        {unpublishing ? null : (
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
            ) : targets.length > 0 && sealedRepo ? (
              <>Encrypted in this tab, then uploaded to {targets.join(', ')} under the encrypted copy&apos;s hash and verified before the release is written. Up to 256 MiB per file.</>
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
        {warnings.map((w) => (
          <WrittenWarning key={w.message} warning={w} />
        ))}
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

/**
 * The composer line §16.2 asks for on a private repo, as the issue composer's `SealedLimit`: how
 * much of the sealed budget the revision's tag, name, notes preview, flags and provenance use.
 */
function SealedBudget({ used, limit, notesContinue }: { used: number; limit: number; notesContinue: boolean }): JSX.Element {
  return (
    <div className={cn('text-[11px]', used > limit ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400')} data-testid="sealed-release-budget">
      <p className="flex items-start gap-1">
        <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        <span>
          Encrypted to this repo&apos;s members: {SEALED_RELEASE_BUDGET}. This one uses {used} / {limit} bytes.
        </span>
      </p>
      {notesContinue ? <p className="mt-0.5 pl-4">The notes are longer: their start is kept here and the full notes continue in the encrypted asset list.</p> : null}
    </div>
  )
}

/**
 * What the sealed writer said once the revision was written (§16.3, §16.5): with the other
 * maintainer's revision when this one is not the tag's newest.
 */
function WrittenWarning({ warning }: { warning: SealedReleaseWarning }): JSX.Element {
  const newer = warning.newer
  return (
    <div role="alert" className="rounded-md border border-caution/30 bg-caution/5 px-3 py-2 text-dense text-caution-700 break-words dark:text-caution-400" data-testid="release-written-warning">
      <p className="flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{warning.message}</span>
      </p>
      {newer ? (
        <p className="mt-1 flex flex-wrap items-center gap-1 pl-5 text-[12px]">
          The newest: {newer.name || newer.tagName} by <Author identityId={newer.publisher} /> · <Time ms={newer.createdAt} />
        </p>
      ) : null}
    </div>
  )
}
