'use client'

/**
 * The live test rows of the storage wizard (`ux-dx-spec.md` §3.1 step 3). Each row settles to
 * ok / FAIL / skipped with a plain reason; a CORS failure expands into the copy-paste fix for
 * the provider, prefilled with the bucket and this app's origin, with a Re-test button.
 */

import { useEffect, useRef, useState } from 'react'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, MinusCircle, RotateCw, XCircle } from 'lucide-react'
import {
  IPFS_ROWS,
  S3_ROWS,
  corsFix,
  probeProfile,
  type ProbeRow,
  type RowId,
  type RowState,
  type StorageProfile,
} from '@/lib/storage'
import { errText } from '@/lib/storage/util'
import { Button } from '@/components/ui/button'
import { CopyBlock } from '@/components/storage/copy-block'
import { cn } from '@/lib/utils'

const META: Readonly<Record<RowState, { word: string; klass: string; Icon: typeof CheckCircle2 }>> = {
  pending: { word: 'waiting', klass: 'text-anvil-500 dark:text-anvil-400', Icon: CircleDashed },
  running: { word: 'testing', klass: 'text-anvil-500 dark:text-anvil-400', Icon: Loader2 },
  ok: { word: 'ok', klass: 'text-verify-700 dark:text-verify-400', Icon: CheckCircle2 },
  fail: { word: 'FAIL', klass: 'text-danger-700 dark:text-danger-400', Icon: XCircle },
  skipped: { word: 'skipped', klass: 'text-anvil-500 dark:text-anvil-400', Icon: MinusCircle },
}

function rowsFor(p: StorageProfile): ProbeRow[] {
  const spec = p.settings.kind === 's3' ? S3_ROWS : IPFS_ROWS
  return spec.map((r) => ({ ...r, state: 'pending', detail: '' }))
}

/** A stable fingerprint of what a test ran against (settings and secrets). */
export function profileSnapshot(p: StorageProfile): string {
  // A digest, not the values: it becomes a React key and sits in state, where dev tools show it.
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([p.name, p.settings, p.secrets]))))
}

/**
 * Run and show the live test for `profile`. `onDone(ok, snapshot)` reports whether every row
 * passed, with the {@link profileSnapshot} the run tested, so the caller credits the result only
 * to those exact values. The parent keys this component by the snapshot, so an edit remounts it
 * (no stale green rows); a run still in flight when that happens reports into the unmounted
 * copy and is dropped.
 */
export function StorageTest({ profile, onDone }: { profile: StorageProfile; onDone: (ok: boolean, snapshot: string) => void }): JSX.Element {
  const [rows, setRows] = useState<ProbeRow[] | null>(null)
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const origin = typeof window === 'undefined' ? 'https://forge.dashhq.org' : window.location.origin

  const run = async (): Promise<void> => {
    if (running) return
    const snapshot = profileSnapshot(profile)
    setRunning(true)
    setSummary('Testing…')
    setRows(rowsFor(profile))
    const report = (id: RowId, state: RowState, detail: string, cors?: boolean): void => {
      if (!mounted.current) return
      setRows((prev) => (prev ?? []).map((r) => (r.id === id ? { ...r, state, detail, ...(cors ? { cors } : {}) } : r)))
    }
    let ok = false
    try {
      ok = await probeProfile(profile, report)
    } catch (e) {
      if (mounted.current) setRows((prev) => (prev ?? []).map((r) => (r.state === 'running' || r.state === 'pending' ? { ...r, state: 'fail', detail: errText(e) } : r)))
    }
    if (!mounted.current) return
    setRunning(false)
    setSummary(ok ? 'Test finished: every check passed.' : 'Test finished: some checks failed.')
    onDone(ok, snapshot)
  }

  const corsFailed = rows?.some((r) => r.state === 'fail' && r.cors) ?? false
  const fix = corsFix(profile.settings.provider, profile.settings.kind === 's3' ? profile.settings.bucket : '', origin)

  return (
    <div className="space-y-3" data-testid="storage-test">
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={run} loading={running}>
          {rows === null ? 'Test' : <><RotateCw className="h-3.5 w-3.5" aria-hidden /> Re-test</>}
        </Button>
        <span className="text-[12px] text-anvil-500 dark:text-anvil-400">
          Runs from this page, so it checks what the browser will do: a few bytes are written and removed again.
        </span>
      </div>
      {rows ? (
        <ol className="divide-y divide-anvil-100 overflow-hidden rounded-md border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800" aria-label="Storage test results">
          {rows.map((r) => {
            const m = META[r.state]
            return (
              <li key={r.id} data-testid={`probe-${r.id}`} data-state={r.state} className="flex items-start gap-2 px-3 py-2 text-dense">
                <m.Icon className={cn('mt-0.5 h-4 w-4 shrink-0', m.klass, r.state === 'running' && 'animate-spin')} aria-hidden />
                <span className="w-[15rem] shrink-0 font-mono text-[12px] text-anvil-700 dark:text-anvil-200">{r.label}</span>
                <span className={cn('w-14 shrink-0 font-mono text-[12px] font-semibold', m.klass)}>{m.word}</span>
                <span className="min-w-0 break-words text-[12px] text-anvil-600 dark:text-anvil-300">{r.detail}</span>
              </li>
            )
          })}
        </ol>
      ) : null}
      <p role="status" aria-live="polite" className="sr-only">
        {summary}
      </p>
      {corsFailed && fix.text ? (
        <div className="space-y-2 rounded-md border border-caution/40 bg-caution/5 p-3" data-testid="cors-fix">
          <p className="flex items-start gap-2 text-dense text-anvil-800 dark:text-anvil-100">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
            <span>
              <span className="font-medium">Fix CORS.</span> {fix.where}
            </span>
          </p>
          <CopyBlock text={fix.text} label="Copy the CORS configuration" />
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            Reads are allowed from any origin (the objects are public); writes only from {origin}. Then press Re-test.
          </p>
        </div>
      ) : null}
    </div>
  )
}
