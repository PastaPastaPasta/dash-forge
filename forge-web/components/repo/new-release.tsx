'use client'

/**
 * "New release" on the releases page (`ux-dx-spec.md` §5.9), maintainers only (consensus
 * refuses anyone else's `release`). Assets are uploaded to the publisher's own storage (the
 * repo's browser-push policy from Settings → Storage), each verified and hashed, then one
 * `release` document names them, with its cost shown before signing. Nothing goes to
 * Platform but that one small document.
 */

import { useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, FilePlus2, Loader2, Plus, XCircle } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { formatBytes } from '@/lib/view'
import { assetNamesProblem, publishRelease, releaseTextProblem, tagProblem, type AssetFile } from '@/lib/repo/new-release'
import { policyForRepo } from '@/lib/storage'
import { previewCreate } from '@/lib/sdk'
import { invalidateSessionCache } from '@/lib/view/session-cache'
import { writeErrorMessage } from '@/lib/view/write-errors'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useIntent } from '@/hooks/use-intent'
import { useStorageConfig } from '@/hooks/use-storage-config'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { cn } from '@/lib/utils'

/** Asset files read into memory at once; larger releases go through the CLI. */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024

type AssetState = 'waiting' | 'uploading' | 'done' | 'failed'

function AssetStateIcon({ state }: { state: AssetState | undefined }): JSX.Element | null {
  switch (state) {
    case 'uploading':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-anvil-500" aria-hidden />
    case 'done':
      return <CheckCircle2 className="h-3.5 w-3.5 text-verify-700 dark:text-verify" aria-hidden />
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-danger-700 dark:text-danger-400" aria-hidden />
    default:
      return null
  }
}

export function NewReleaseButton({ home, onPublished }: { home: RepoHome; onPublished: () => void }): JSX.Element | null {
  const { role } = useViewerRole(home.repo)
  const [open, setOpen] = useState(false)
  if (home.repo.kind !== 'v2' || role !== 'maintainer') return null
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" aria-hidden /> New release
      </Button>
      {open ? <NewReleaseDialog home={home} onClose={() => setOpen(false)} onPublished={onPublished} /> : null}
    </>
  )
}

function NewReleaseDialog({ home, onClose, onPublished }: { home: RepoHome; onClose: () => void; onPublished: () => void }): JSX.Element {
  const repo = home.repo.kind === 'v2' ? home.repo : null
  const { sdk, network } = useSdk()
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const draft = useIntent()
  const { config } = useStorageConfig()
  const [tag, setTag] = useState('')
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [progress, setProgress] = useState<Record<string, AssetState>>({})
  const [phase, setPhase] = useState<'edit' | 'publishing' | 'done'>('edit')
  const [error, setError] = useState<string | null>(null)

  const policy = config && repo ? policyForRepo(config, repo.repoId) : null
  const total = files.reduce((s, f) => s + f.size, 0)
  const problem =
    tagProblem(tag.trim()) ??
    releaseTextProblem({ name: title, notes }) ??
    assetNamesProblem(files.map((f) => f.name)) ??
    (total > MAX_TOTAL_BYTES ? `assets over ${formatBytes(MAX_TOTAL_BYTES)} in total: publish large releases with dg release create` : null) ??
    (files.length > 0 && (policy === null || policy.targets.length === 0) ? 'choose where assets go first (Settings → Storage)' : null)
  // The assets JSON holds, per file, its name, a 64-char hash, a size and up to 4 URLs: size the
  // estimate on a typical entry (~220 bytes plus the name).
  const assetsEstimate = files.map((f) => `${f.name}${'·'.repeat(110)}`).join('')
  const cost = previewCreate('release', { tagName: tag, name: title, notes, assets: assetsEstimate })

  const mark = (asset: string, state: AssetState): void => setProgress((p) => ({ ...p, [asset]: state }))

  const publish = async (): Promise<void> => {
    if (!sdk || !signer || !repo || problem !== null || !guard.check(cost.credits)) return
    setPhase('publishing')
    setError(null)
    setProgress(Object.fromEntries(files.map((f): [string, AssetState] => [f.name, 'waiting'])))
    try {
      const assetFiles: AssetFile[] = []
      for (const f of files) assetFiles.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })
      await publishRelease(
        sdk,
        signer,
        repo,
        { tagName: tag.trim(), name: title.trim(), notes: notes.trim(), files: assetFiles, intent: draft.intent },
        { policy, profiles: config?.profiles ?? [] },
        (e) => {
          if (e.step === 'uploaded') mark(e.asset, 'done')
          else if (e.step === 'upload' && e.event.phase === 'start') mark(e.asset, 'uploading')
          else if (e.step === 'upload' && e.event.phase === 'failed') mark(e.asset, 'failed')
        },
      )
      invalidateSessionCache(`releases:${network}:`)
      draft.renew()
      setPhase('done')
      onPublished()
      setTimeout(onClose, 900)
    } catch (e) {
      setPhase('edit')
      setError(writeErrorMessage(e).message)
    }
  }

  const busy = phase === 'publishing'
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
            Cancel
          </Button>
          <Button variant="primary" onClick={publish} loading={busy} disabled={problem !== null || phase === 'done' || guard.disabledReason !== null} aria-describedby="release-status">
            {phase === 'done' ? 'Published' : 'Sign & publish'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Tag" htmlFor="release-tag" hint="An existing or new git tag, e.g. v1.2.0. A newer release for the same tag replaces the older one.">
          <Input id="release-tag" value={tag} onChange={(e) => setTag(e.target.value)} className="font-mono" placeholder="v1.0.0" disabled={busy} autoFocus />
        </Field>
        <Field label="Title (optional)" htmlFor="release-title">
          <Input id="release-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        </Field>
        <Field label="Notes (optional)" htmlFor="release-notes" hint="Markdown supported.">
          <Textarea id="release-notes" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} />
        </Field>
        <div className="space-y-1.5">
          <label htmlFor="release-assets" className="flex items-center gap-1.5 text-dense font-medium text-anvil-700 dark:text-anvil-200">
            <FilePlus2 className="h-3.5 w-3.5" aria-hidden /> Assets (optional)
          </label>
          <input
            id="release-assets"
            type="file"
            multiple
            disabled={busy}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="block w-full text-dense text-anvil-700 file:mr-3 file:rounded-md file:border file:border-anvil-300 file:bg-transparent file:px-3 file:py-1.5 file:text-dense dark:text-anvil-200 dark:file:border-anvil-700"
          />
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            {policy && policy.targets.length > 0 ? (
              <>Uploaded to {policy.targets.join(', ')} and verified before the release is written.</>
            ) : (
              <>
                No storage chosen for this repo yet. <Link href="/settings/storage" className="text-forge-700 underline dark:text-forge-400">Set up storage</Link> to attach assets.
              </>
            )}
          </p>
          {files.length > 0 ? (
            <ul className="divide-y divide-anvil-100 rounded-md border border-anvil-200 text-dense dark:divide-anvil-850 dark:border-anvil-800">
              {files.map((f) => {
                const s = progress[f.name]
                return (
                  <li key={f.name} className="flex items-center gap-2 px-3 py-1.5" data-testid={`asset-${f.name}`} data-state={s ?? 'waiting'}>
                    <AssetStateIcon state={s} />
                    <span className="min-w-0 flex-1 truncate font-mono">{f.name}</span>
                    <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{formatBytes(f.size)}</span>
                    {s ? <span className={cn('text-[12px]', s === 'failed' ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400')}>{s === 'done' ? 'stored, verified' : s}</span> : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
        <CostPreview cost={cost} />
        <p id="release-status" role="status" aria-live="polite" className="text-[12px] text-caution-700 dark:text-caution">
          {tag !== '' || files.length > 0 ? problem ?? '' : ''}
        </p>
        {phase === 'done' ? <p className="text-dense text-verify-700 dark:text-verify">Release published.</p> : null}
        {error ? (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 break-words dark:text-danger-400">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
