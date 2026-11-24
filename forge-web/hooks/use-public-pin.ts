'use client'

import { useEffect, useRef, useState } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { repoContractIds, type RepoRef } from '@/lib/repo/contract'
import { deleteMirror } from '@/lib/repo/pack-mirrors'
import { newIntent } from '@/lib/sdk'
import { spendAction } from '@/lib/spend-toast'
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

  const start = async (): Promise<void> => {
    const s = status.data
    if (running || !sdk || !signer || !profile || s === null || s.missing.length === 0) return
    const run = new AbortController()
    controller.current = run
    setRunning('pin'); setError(null); setRows({}); setSummary(null)
    try {
      const done = await spendAction({ running: `Pinning ${repo.name}…`, done: `Pinned ${repo.name}`, failed: `Pin of ${repo.name} stopped part-way` }, (tag) =>
        pinPacks(sdk, tag(signer), repo, profile, s.missing, { signal: run.signal, intent: `pin:${repo.repoId}:${intent}`, onProgress: (row) => setRows((prev) => ({ ...prev, [row.index]: row })) }))
      setSummary(done)
    } catch (e) {
      setError(guard.failed(e))
    } finally {
      controller.current = null
      setRunning(null)
      status.reload()
    }
  }

  const unpin = async (): Promise<void> => {
    const s = status.data
    if (running || !sdk || !signer || s === null || s.mine.length === 0) return
    setRunning('unpin'); setError(null); setRows({}); setSummary(null)
    try {
      await spendAction({ running: `Unpinning ${repo.name}…`, done: `Unpinned ${repo.name}`, failed: `Unpin of ${repo.name} stopped part-way` }, async (tag) => {
        for (const m of s.mine) await deleteMirror(sdk, tag(signer), repo, m.id)
      })
    } catch (e) {
      setError(guard.failed(e))
    } finally {
      setRunning(null)
      status.reload()
    }
  }

  return {
    storage, status, profiles, profile, setChosen, running, error, summary,
    rows: Object.values(rows).sort((a, b) => a.index - b.index),
    start, unpin, cancel: () => controller.current?.abort(),
  }
}
