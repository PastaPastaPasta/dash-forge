'use client'

import { useEffect, useRef, useState } from 'react'
import { useAsync } from './use-async'
import { useSdk } from './use-sdk'
import { useStorageConfig } from './use-storage-config'
import { contentKey, repoContractIds, type RepoRef } from '@/lib/repo/contract'
import { onPrivateSessionsClosed } from '@/lib/repo/private-session'
import { pinRepo, readPinPlan, type PinProgress, type PinSummary } from '@/lib/storage/pin'
import { errText } from '@/lib/storage/util'

/** One dialog's pin plan and resumable run; unmounting or locking the vault cancels it. */
export function useRepoPin(repo: RepoRef, { onlyWithProfile = false }: { onlyWithProfile?: boolean } = {}) {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const storage = useStorageConfig()
  const profiles = storage.config?.profiles.filter((p) => p.settings.kind === 'ipfs-kubo') ?? []
  const plan = useAsync(() => readPinPlan(sdk!, repo), [ready, network, contentKey(repo)], { enabled: ready && sdk !== null && (!onlyWithProfile || profiles.length > 0) })
  const [chosen, setChosen] = useState('')
  const profile = profiles.find((p) => p.name === chosen) ?? profiles[0]
  const [rows, setRows] = useState<Record<string, PinProgress>>({})
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<PinSummary | null>(null)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  // A fork can take minutes: its eventual pin must use the tab's current unlocked settings.
  const current = useRef({ sdk, repo, profile, plan: plan.data, storage })
  current.current = { sdk, repo, profile, plan: plan.data, storage }
  useEffect(() => {
    mounted.current = true
    const stop = (): void => controller.current?.abort()
    const off = onPrivateSessionsClosed(stop)
    return () => { mounted.current = false; stop(); off() }
  }, [])
  useEffect(() => {
    if (storage.needsUnlock || !storage.storable) controller.current?.abort()
  }, [storage.needsUnlock, storage.storable])

  const start = async (consent: boolean): Promise<void> => {
    if (!mounted.current || controller.current) return
    const live = current.current
    if (!live.sdk || !live.profile || !live.plan || live.storage.needsUnlock || !live.storage.storable) {
      setError('Unlock your storage profiles and choose a node before pinning.')
      return
    }
    const run = new AbortController()
    controller.current = run
    setRunning(true); setError(null); setRows({}); setSummary(null)
    try {
      const done = await pinRepo(live.sdk, live.repo, live.profile, live.plan, { consent, signal: run.signal, onProgress: (row) => setRows((prev) => ({ ...prev, [row.index]: row })) })
      setSummary(done)
    } catch (e) { setError(errText(e)) } finally { setRunning(false); controller.current = null }
  }
  return { storage, plan, profiles, profile, setChosen, rows: Object.values(rows).sort((a, b) => a.index - b.index), running, error, summary, start, cancel: () => controller.current?.abort() }
}
