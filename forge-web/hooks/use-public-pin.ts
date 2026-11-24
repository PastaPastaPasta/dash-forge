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
  const fresh = useRef(false)
  const status = useAsync(
    () => {
      const opts = { fresh: fresh.current }
      fresh.current = false
      return readPinStatus(sdk!, repo, identity!, opts)
    },
    [ready, network, repo.repoId, identity ?? ''],
    { enabled: ready && sdk !== null && identity !== null && repo.visibility === 'public' },
  )
  const refresh = (): void => {
    fresh.current = true
    status.reload()
  }
  const [chosen, setChosen] = useState('')
  const profile = profiles.find((p) => p.name === chosen) ?? profiles[0] ?? null
  const [rows, setRows] = useState<Record<number, CopyRow>>({})
  const [running, setRunning] = useState<'pin' | 'unpin' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<CopySummary | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const [intent] = useState(newIntent)
  useEffect(() => () => controller.current?.abort(), [])

  const contract = writeContractKind(repo.forge, DOC_PACK_MIRROR)
  const done = (): void => {
    if (identity !== null) forgetMirrorsBy(identity)
    refresh()
  }

  const start = async (cost: CostPreview): Promise<void> => {
    const s = status.data
    if (running || !sdk || !signer || !identity || !profile || s === null || s.missing.length === 0 || !guard.check(cost, contract, 'pin this repo')) return
    const run = new AbortController()
    controller.current = run
    setRunning('pin'); setError(null); setRows({}); setSummary(null); setNotice(null)
    try {
      // The price was shown from an earlier read: sign only when nothing it did not cover is new.
      const now = await readPinStatus(sdk, repo, identity, { fresh: true })
      const priced = new Set(s.missing.map((p) => p.packHash))
      if (now.missing.some((p) => !priced.has(p.packHash)) || (now.mine.length === 0 && s.mine.length > 0)) {
        setNotice('This repository changed since the price was shown. Check the new total and press Pin again.')
        return
      }
      if (now.missing.length === 0 || run.signal.aborted) return
      const result = await spendAction({ running: `Pinning ${repo.name}…`, done: `Recorded your copies of ${repo.name}`, failed: `Pin of ${repo.name} stopped part-way` }, async (tag) => {
        const r = await pinPacks(sdk, tag(signer), repo, profile, now.missing, { signal: run.signal, intent: `pin:${repo.repoId}:${intent}`, onProgress: (row) => setRows((prev) => ({ ...prev, [row.index]: row })) })
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
    setRunning('unpin'); setError(null); setRows({}); setSummary(null); setNotice(null)
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
    storage, status, profiles, profile, setChosen, running, error, summary, notice, refresh,
    rows: Object.values(rows).sort((a, b) => a.index - b.index),
    start, unpin, cancel: () => controller.current?.abort(),
  }
}
