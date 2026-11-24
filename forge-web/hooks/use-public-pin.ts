'use client'

import { useEffect, useRef, useState } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { repoContractIds, type RepoRef } from '@/lib/repo/contract'
import { DOC_PACK_MIRROR, deleteMirror, forgetMirrorsBy } from '@/lib/repo/pack-mirrors'
import { writeContractKind } from '@/lib/layout'
import { newIntent, type CostPreview } from '@/lib/sdk'
import { spendAction } from '@/lib/spend-toast'
import { redactSecrets } from '@/lib/redact'
import { copyableProfiles, pinPacks, readPinStatus, type CopyRow, type CopySummary } from '@/lib/storage/pin-copies'
import { useAsync } from './use-async'
import { useSdk } from './use-sdk'
import { useStorageConfig } from './use-storage-config'
import { useWriteGuard } from './use-write-guard'

/** A public repo's pin: the signer's records against its packs, and the copy and unpin runs. */
export function usePublicPin(repo: RepoRef) {
  const { identity, signer } = useAuth()
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const guard = useWriteGuard()
  const storage = useStorageConfig()
  const profiles = copyableProfiles(storage.config?.profiles ?? [])
  const status = useAsync(() => readPinStatus(sdk!, repo, identity!), [ready, network, repo.repoId, identity ?? ''], {
    enabled: ready && sdk !== null && identity !== null && repo.visibility === 'public',
  })
  const [chosen, setChosen] = useState('')
  const profile = profiles.find((p) => p.name === chosen) ?? profiles[0] ?? null
  const [rows, setRows] = useState<Record<number, CopyRow>>({})
  const [running, setRunning] = useState<'pin' | 'unpin' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<CopySummary | null>(null)
  const controller = useRef<AbortController | null>(null)
  const [intent] = useState(newIntent)
  useEffect(() => () => controller.current?.abort(), [])

  const contract = writeContractKind(repo.forge, DOC_PACK_MIRROR)
  const done = (): void => {
    if (identity !== null) forgetMirrorsBy(identity)
    status.reload()
  }

  const start = async (cost: CostPreview): Promise<void> => {
    const s = status.data
    if (running || !sdk || !signer || !profile || s === null || s.missing.length === 0 || !guard.check(cost, contract, 'pin this repo')) return
    const run = new AbortController()
    controller.current = run
    setRunning('pin'); setError(null); setRows({}); setSummary(null)
    try {
      const result = await spendAction({ running: `Pinning ${repo.name}…`, done: `Recorded your copies of ${repo.name}`, failed: `Pin of ${repo.name} stopped part-way` }, async (tag) => {
        const r = await pinPacks(sdk, tag(signer), repo, profile, s.missing, { signal: run.signal, intent: `pin:${repo.repoId}:${intent}`, onProgress: (row) => setRows((prev) => ({ ...prev, [row.index]: row })) })
        if (r.recorded === 0 && r.failed > 0) throw new Error('No file could be copied: see the details.')
        return r
      })
      setSummary(result)
    } catch (e) {
      setError(redactSecrets(guard.failed(e)))
    } finally {
      controller.current = null
      setRunning(null)
      done()
    }
  }

  const unpin = async (): Promise<void> => {
    const s = status.data
    if (running || !sdk || !signer || s === null || s.mine.length === 0 || !guard.check(0, contract, 'unpin this repo')) return
    setRunning('unpin'); setError(null); setRows({}); setSummary(null)
    try {
      await spendAction({ running: `Unpinning ${repo.name}…`, done: `Unpinned ${repo.name}`, failed: `Unpin of ${repo.name} stopped part-way` }, async (tag) => {
        for (const m of s.mine) await deleteMirror(sdk, tag(signer), repo, m.id)
      })
    } catch (e) {
      setError(redactSecrets(guard.failed(e)))
    } finally {
      setRunning(null)
      done()
    }
  }

  return {
    storage, status, profiles, profile, setChosen, running, error, summary,
    rows: Object.values(rows).sort((a, b) => a.index - b.index),
    start, unpin, cancel: () => controller.current?.abort(),
  }
}
