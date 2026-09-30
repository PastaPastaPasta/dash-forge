'use client'

/**
 * The browser merge's storage upload: the merger's storage policy for the repo (Settings →
 * Storage), else Platform chunks. Where the pack goes is decided before the merge starts
 * ({@link StorageRow}: the resolved policy, an upper-bound price, and "Allow storing on
 * Platform, up to ≈X" when Platform may be used). The run passes that answer as a cap: a Platform
 * copy within it is not asked about again. Over the cap (the pack came out larger than the
 * check's estimate), or with no pre-answer, the run's upload step waits for the choice inline
 * ({@link StorageQuestion}, rendered in the step list), never behind a modal.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'

import type { RepoRef } from '@/lib/repo'
import { previewCredits } from '@/lib/sdk'
import { estimateChunkCredits } from '@/lib/sdk/cost'
import { policyForRepo, storeArtifact, type PlatformQuestion } from '@/lib/storage'
import { fragmentBytes, remainingPreAgreement, storageChoice, type PackEstimate, type StorageChoice } from '@/lib/storage/merge-choice'
import type { UploadPack } from '@/lib/merge/runner'
import { formatBytes, plural } from '@/lib/view'
import { useStorageConfig } from '@/hooks/use-storage-config'
import { useSdk } from '@/hooks/use-sdk'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { CostPreview } from '@/components/ui/cost-preview'

export interface MergeUpload {
  /** For the runner; null until the storage settings are read. */
  readonly upload: UploadPack | null
  /** The Storage row's data for an estimated pack (null estimate: no price yet). */
  readonly choiceFor: (estimate: PackEstimate | null) => StorageChoice | null
  /** The question the run is waiting on, or null. */
  readonly question: JSX.Element | null
  /** The step it stops: the pack's upload, or (rarely: its own copy asks) the browse index's. */
  readonly questionStep: 'upload' | 'index'
  /** Call at each attempt with the pre-answer: credits allowed on Platform (null: none given). */
  readonly begin: (preAgreedCredits?: number | null) => void
  /**
   * Storage settings are stored in this browser and sealed in this tab (a resumed session):
   * the upload waits for the in-page unlock. With none stored there is nothing to unlock.
   */
  readonly storageNeedsUnlock: boolean
}

export function useMergeUpload(repo: RepoRef): MergeUpload {
  const { sdk } = useSdk()
  const { signer } = useAuth()
  const storage = useStorageConfig()
  const [pending, setPending] = useState<PlatformQuestion | null>(null)
  const answer = useRef<((ok: boolean) => void) | null>(null)
  // One answer per merge: the pack and its index fragment share it.
  const agreed = useRef<boolean | null>(null)
  const preAgreed = useRef<number | null>(null)
  // The pack's object count, so the question can price the index fragment too.
  const packObjects = useRef(0)
  // Which of the run's uploads is asking: its first is the pack, the next its index fragment.
  const uploads = useRef(0)
  const [asking, setAsking] = useState<'upload' | 'index'>('upload')

  const confirmPlatform = useCallback((q: PlatformQuestion): Promise<boolean> => {
    if (agreed.current !== null) return Promise.resolve(agreed.current)
    return new Promise<boolean>((resolve) => {
      answer.current = (ok) => {
        agreed.current = ok
        answer.current = null
        setPending(null)
        resolve(ok)
      }
      setPending(q)
    })
  }, [])

  // The settings the upload uses: after a reload with none stored in this browser, the empty
  // ones (Platform, asked for) with no unlock; stored ones only once this tab is unlocked.
  const config = storage.usable
  const policy = config === null ? null : policyForRepo(config, repo.repoId)
  const upload = useCallback<UploadPack>(
    async (bytes, info) => {
      const kind = uploads.current++ === 0 ? 'upload' : 'index'
      if (kind === 'upload') packObjects.current = info.objectCount
      setAsking(kind)
      if (!sdk || !signer) throw new Error('sign in to continue')
      if (config === null) throw new Error("your storage settings aren't unlocked yet")
      // The pre-answer covers the pack and its index fragment together (both priced in the
      // Storage row): each Platform copy spends from it, and one past what is left asks. An
      // answer given mid-run covers the rest of the run (`confirmPlatform` remembers it).
      const stored = await storeArtifact(sdk, signer, repo, bytes, { policy, profiles: config.profiles, confirmPlatform, preAgreedCredits: preAgreed.current })
      if (stored.storage === 0) preAgreed.current = remainingPreAgreement(preAgreed.current, estimateChunkCredits(bytes.length))
      return { storage: stored.storage, chunkCount: stored.chunkCount, uris: stored.uris }
    },
    [sdk, signer, config, policy, repo, confirmPlatform],
  )

  const choiceFor = useCallback(
    (estimate: PackEstimate | null): StorageChoice | null => (config === null ? null : storageChoice(policy, config.profiles, estimate)),
    [config, policy],
  )

  const question =
    pending === null ? null : (
      <StorageQuestion question={pending} fragment={asking === 'index'} objects={packObjects.current} onAnswer={(ok) => answer.current?.(ok)} />
    )

  const begin = useCallback((preAgreedCredits: number | null = null) => {
    agreed.current = null
    preAgreed.current = preAgreedCredits
    uploads.current = 0
  }, [])
  return {
    upload: config === null ? null : upload,
    choiceFor,
    question,
    questionStep: asking,
    begin,
    storageNeedsUnlock: storage.sealed,
  }
}

/** The run's upload step, waiting for the merger's choice: where, why, and the price. */
function StorageQuestion({
  question,
  fragment,
  objects,
  onAnswer,
}: {
  question: PlatformQuestion
  /** The index fragment asking on its own (the pack is stored): its price alone. */
  fragment: boolean
  objects: number
  onAnswer: (ok: boolean) => void
}): JSX.Element {
  const indexBytes = fragmentBytes(objects)
  // The run has stopped for the merger: say so (a live region) and bring it into view, focusing
  // the question itself rather than a button, so a stray Enter never pays. Focus moves only when
  // nothing else has it (never out of a field being typed in).
  const heading = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    const active = document.activeElement
    if (active !== null && active !== document.body && !(active instanceof HTMLButtonElement)) return
    heading.current?.scrollIntoView?.({ block: 'nearest' })
    heading.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div className="mt-2 space-y-2 rounded-md border border-caution/50 bg-caution/5 px-3 py-2 text-dense" role="group" aria-label="Waiting for your choice" aria-live="polite" data-testid="storage-question">
      <p ref={heading} tabIndex={-1} role="alert" className="font-medium outline-none">
        Waiting for your choice: store the {fragment ? 'browse index' : 'pack'} ({formatBytes(question.bytes)}) on Dash Platform?
      </p>
      <p className="text-[12px] text-anvil-600 dark:text-anvil-400">{question.reason} Platform storage is permanent and paid once.</p>
      <div className="flex flex-wrap items-center gap-2">
        <CostPreview cost={previewCredits(question.estimateCredits + (fragment ? 0 : estimateChunkCredits(indexBytes)))} />
        <span className="text-[12px] text-anvil-600 dark:text-anvil-400">
          {fragment ? `the index of the ${plural(objects, 'object')} just stored` : `${plural(objects, 'object')}, and a browse index of about ${formatBytes(indexBytes)}`}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => onAnswer(false)}>
          Don&apos;t store
        </Button>
        <Button size="sm" variant="primary" onClick={() => onAnswer(true)}>
          Sign &amp; store on Platform
        </Button>
      </div>
    </div>
  )
}

/**
 * The Storage row, before the merge starts: where the pack goes, and, when Platform may be used,
 * "Allow storing on Platform, up to ≈X" (checked by default only when the policy lists Platform).
 */
export function StorageRow({
  choice,
  allowed,
  onAllow,
  disabled = false,
}: {
  choice: StorageChoice | null
  allowed: boolean
  onAllow: (allowed: boolean) => void
  /** While a run is going: its cap was fixed when it started. */
  disabled?: boolean
}): JSX.Element | null {
  const priceId = useId()
  if (choice === null) return null
  const uses = choice.platform.kind !== 'never'
  return (
    <div className="mt-2 space-y-1 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="storage-row">
      <p>
        Storage: <span className="font-medium text-anvil-800 dark:text-anvil-100">{choice.label}</span>
        {uses && choice.platform.kind !== 'only' ? <> · {choice.platform.reason}</> : null}
      </p>
      {uses ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-dense text-anvil-700 dark:text-anvil-200">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4 accent-forge-700"
                checked={allowed}
                disabled={disabled}
                onChange={(e) => onAllow(e.target.checked)}
                aria-describedby={priceId}
                data-testid="allow-platform"
              />
              Allow storing on Platform, up to
            </label>
            <span id={priceId}>
              {choice.platformCredits !== null ? <CostPreview cost={previewCredits(choice.platformCredits)} /> : <>the pack&apos;s price (sized when the merge is checked)</>}
            </span>
          </div>
          <p>Unchecked, the merge asks when it gets there, with the price.</p>
        </>
      ) : null}
    </div>
  )
}
