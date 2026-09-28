'use client'

/**
 * The browser merge's storage upload: the merger's storage policy for the repo (Settings →
 * Storage), else Platform chunks once they agree to the price. The question is asked once per
 * merge, before anything is written to Platform, and says why Platform is being used (a
 * policy target, the fallback, or nothing configured) with the real estimate.
 */

import { useCallback, useRef, useState } from 'react'

import type { RepoRef } from '@/lib/repo'
import { previewCredits } from '@/lib/sdk'
import { estimateChunkCredits } from '@/lib/sdk/cost'
import { FANOUT_LEN, LOCATOR_ROW_LEN } from '@/lib/browse'
import { policyForRepo, storeArtifact, type PlatformQuestion } from '@/lib/storage'
import type { UploadPack } from '@/lib/merge/runner'
import { formatBytes, plural } from '@/lib/view'
import { useStorageConfig } from '@/hooks/use-storage-config'
import { useSdk } from '@/hooks/use-sdk'
import { useAuth } from '@/contexts/auth-context'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CostPreview } from '@/components/ui/cost-preview'

/**
 * `upload` for the runner (null until storage settings are read), the price dialog, and
 * `begin` (call at each merge attempt, so a declined question is asked again on retry).
 */
export function useMergeUpload(repo: RepoRef): { upload: UploadPack | null; dialog: JSX.Element | null; storageLabel: string; begin: () => void; storageNeedsUnlock: boolean } {
  const { sdk } = useSdk()
  const { signer } = useAuth()
  const storage = useStorageConfig()
  const [question, setQuestion] = useState<PlatformQuestion | null>(null)
  const answer = useRef<((ok: boolean) => void) | null>(null)
  // One answer per merge: the pack and its index fragment share it.
  const agreed = useRef<boolean | null>(null)

  // The pack's object count, so the question can price the index fragment too.
  const packObjects = useRef(0)
  const confirmPlatform = useCallback((q: PlatformQuestion): Promise<boolean> => {
    if (agreed.current !== null) return Promise.resolve(agreed.current)
    return new Promise<boolean>((resolve) => {
      answer.current = (ok) => {
        agreed.current = ok
        answer.current = null
        setQuestion(null)
        resolve(ok)
      }
      setQuestion(q)
    })
  }, [])

  const config = storage.config
  const policy = config === null ? null : policyForRepo(config, repo.repoId)
  const upload = useCallback<UploadPack>(
    async (bytes, info) => {
      if (agreed.current === null) packObjects.current = info.objectCount
      if (!sdk || !signer) throw new Error('sign in to continue')
      if (config === null) throw new Error("your storage settings aren't unlocked yet")
      const stored = await storeArtifact(sdk, signer, repo, bytes, { policy, profiles: config.profiles, confirmPlatform })
      return { storage: stored.storage, chunkCount: stored.chunkCount, uris: stored.uris }
    },
    [sdk, signer, config, policy, repo, confirmPlatform],
  )

  // The merge also stores its index fragment (fanout + 36 bytes per object) under the same answer.
  const fragmentBytes = FANOUT_LEN + LOCATOR_ROW_LEN * packObjects.current
  const dialog =
    question === null ? null : (
      <Dialog
        open
        onClose={() => answer.current?.(false)}
        title={`Store the merge pack (${formatBytes(question.bytes)}) on Platform?`}
        description={`${question.reason} Platform storage is permanent and paid once.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => answer.current?.(false)}>
              Don&apos;t store
            </Button>
            <Button variant="primary" onClick={() => answer.current?.(true)}>
              Sign &amp; store on Platform
            </Button>
          </>
        }
      >
        <CostPreview cost={previewCredits(question.estimateCredits + estimateChunkCredits(fragmentBytes))} />
        <ul className="mt-2 space-y-0.5 text-[12px] text-anvil-600 dark:text-anvil-400">
          <li>
            The merge pack: {formatBytes(question.bytes)}, {plural(packObjects.current, 'object')}
          </li>
          <li>Its browse index: about {formatBytes(fragmentBytes)}</li>
        </ul>
        <p className="mt-2 text-[12px] text-anvil-600 dark:text-anvil-400">
          Configure a bucket in Settings → Storage to store packs for a fraction of this.
        </p>
      </Dialog>
    )

  const storageLabel = config === null ? '' : policy === null || policy.targets.length === 0 ? 'Platform (asks first)' : policy.targets.join(', ')
  const begin = useCallback(() => {
    agreed.current = null
  }, [])
  return { upload: config === null ? null : upload, dialog, storageLabel, begin, storageNeedsUnlock: storage.needsUnlock }
}
