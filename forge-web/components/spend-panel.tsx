'use client'

/**
 * Settings → Spend (`ux-dx-spec.md` §4 rule 3): this device's ledger of confirmed writes —
 * month and all-time totals, per-repo totals, estimates that missed by more than 25 %, and the
 * reconciliation line against the identity's balance change since the ledger began.
 */

import { AlertTriangle } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { DEFAULT_NETWORK } from '@/lib/constants'
import { estimateMissed, readBaseline, readLedger, reconcile, summarize, type SpendRow } from '@/lib/spend'
import { creditsAsDash, timeAgo } from '@/lib/view/format'
import { LoadingBlock } from '@/components/ui/states'

function Dash({ credits }: { credits: number }): JSX.Element {
  return (
    <span className="font-mono">
      {credits < 0 ? '−' : ''}
      {creditsAsDash(Math.abs(credits))} DASH
    </span>
  )
}

export function SpendPanel(): JSX.Element {
  const { identity, balance } = useAuth()
  const ledger = useAsync<{ rows: SpendRow[]; baseline: { at: number; credits: bigint } | null }>(
    async () => ({
      rows: await readLedger(DEFAULT_NETWORK, identity!),
      baseline: await readBaseline(DEFAULT_NETWORK, identity!),
    }),
    [identity ?? '', balance ?? ''],
    { enabled: identity !== null },
  )
  if (ledger.loading && !ledger.settled) return <LoadingBlock label="Reading the spend ledger" />
  const rows = ledger.data?.rows ?? []
  if (rows.length === 0) {
    return (
      <p className="text-dense text-anvil-500 dark:text-anvil-400">
        No writes from this browser yet. Every write you sign here is recorded on this device only.
      </p>
    )
  }
  const s = summarize(rows)
  const rec = reconcile(s.allTime, ledger.data?.baseline?.credits ?? null, balance === null ? null : BigInt(balance))
  return (
    <div className="space-y-3 text-dense" data-testid="spend-panel">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[12px] text-anvil-500 dark:text-anvil-400">This month</div>
          <Dash credits={s.thisMonth} />
        </div>
        <div>
          <div className="text-[12px] text-anvil-500 dark:text-anvil-400">All time ({rows.length} writes)</div>
          <Dash credits={s.allTime} />
        </div>
      </div>
      {rec ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="spend-reconcile">
          Ledger <Dash credits={s.allTime} /> · balance change <Dash credits={rec.balanceChange} /> ·{' '}
          <Dash credits={rec.unexplained} /> unexplained ({rec.unexplained >= 0 ? 'other apps or keys' : 'top-ups'})
        </p>
      ) : null}
      {s.missed > 0 ? (
        <p className="flex items-center gap-1 text-[12px] text-caution">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {s.missed} estimate{s.missed === 1 ? '' : 's'} missed by more than 25 %.
        </p>
      ) : null}
      <table className="w-full text-left text-[12px]">
        <caption className="sr-only">Writes from this browser, newest first</caption>
        <thead className="text-anvil-500 dark:text-anvil-400">
          <tr>
            <th className="py-1 font-normal">When</th>
            <th className="py-1 font-normal">What</th>
            <th className="py-1 text-right font-normal">Estimate</th>
            <th className="py-1 text-right font-normal">Actual</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().slice(0, 50).map((r) => (
            <tr key={`${r.at}:${r.documentId}`} className="border-t border-anvil-100 dark:border-anvil-850">
              <td className="py-1">{timeAgo(r.at)}</td>
              <td className="py-1 font-mono">{r.kind}</td>
              <td className="py-1 text-right"><Dash credits={r.estimateCredits} /></td>
              <td className={`py-1 text-right ${estimateMissed(r) ? 'text-caution' : ''}`}>
                {r.actualCredits === null ? '—' : <Dash credits={r.actualCredits} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
