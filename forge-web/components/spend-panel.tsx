'use client'

/**
 * Settings → Spend (`ux-dx-spec.md` §4 rule 3): this device's ledger of confirmed writes and
 * Forge's own identity updates (key register, renew, top-up, revoke) — month and all-time
 * totals, per-repo totals (names read from Platform, the repo id when a name does not resolve),
 * estimates that missed by more than 25 %, and the reconciliation line against the identity's
 * balance change since the ledger began.
 *
 * Both lists are stacked rows rather than wide tables, so they read on a 320 px phone.
 */

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { repoHref } from '@/hooks/use-query-param'
import { ACTIVE_NETWORK, DEFAULT_NETWORK } from '@/lib/constants'
import { readRepoById, type RepoDoc } from '@/lib/repo'
import {
  NO_REPO,
  balanceSettled,
  estimateMissed,
  isCredit,
  isIdentityAction,
  readBaseline,
  readLedger,
  reconcile,
  spendKindLabel,
  summarize,
  type SpendRow,
} from '@/lib/spend'
import { measurementPending } from '@/lib/sdk/write'
import { creditsAsDash, plural, timeAgo } from '@/lib/view/format'
import { LoadingBlock } from '@/components/ui/states'
import { cn, shortId } from '@/lib/utils'

/** A DASH amount; `signed` marks a positive one "+" too (a balance that grew, a top-up). */
function Dash({ credits, signed = false }: { credits: number; signed?: boolean }): JSX.Element {
  const amount = creditsAsDash(Math.abs(credits))
  // No sign on an amount too small to show ("−0 DASH").
  const sign = amount === '0' ? '' : credits < 0 ? '−' : signed && credits > 0 ? '+' : ''
  return (
    <span className="whitespace-nowrap font-mono">
      {sign}
      {amount} DASH
    </span>
  )
}

/** A write's preview as it was shown: its range (steady to upper bound), or its one figure. */
function Estimate({ row }: { row: SpendRow }): JSX.Element {
  const min = row.estimateMinCredits
  if (min === undefined || min >= row.estimateCredits || row.estimateCredits < 0) return <Dash credits={row.estimateCredits} />
  // May break after the dash: a phone's row keeps room for what the write was.
  return (
    <span className="font-mono">
      {creditsAsDash(min)}–<wbr />
      <span className="whitespace-nowrap">{creditsAsDash(row.estimateCredits)} DASH</span>
    </span>
  )
}

/** The repos a ledger names, read once each by id (null when one does not resolve). */
function useRepoNames(ids: readonly string[]): ReadonlyMap<string, RepoDoc | null> {
  const { sdk, ready } = useSdk()
  const forge = ACTIVE_NETWORK.v2
  const key = [...ids].sort().join(',')
  const names = useAsync<ReadonlyMap<string, RepoDoc | null>>(
    async () => {
      const list = key === '' ? [] : key.split(',')
      const docs = await Promise.all(list.map((id) => readRepoById(sdk!, forge!, id).catch(() => null)))
      return new Map(list.map((id, i) => [id, docs[i] ?? null]))
    },
    [ready, sdk !== null, key],
    { enabled: ready && sdk !== null && forge !== null && key !== '' },
  )
  return names.data ?? new Map()
}

type Ledger = { rows: SpendRow[]; baseline: { at: number; credits: bigint } | null }

/** How many times the panel reads the balance again for one last row, and the first wait between. */
const SETTLE_READS = 4
const SETTLE_WAIT_MS = 2000

export function SpendPanel(): JSX.Element {
  const { identity, balance, balanceReadAt, refreshBalance } = useAuth()
  // Re-read with every balance read (a write's row lands just before its refresh), showing the
  // last ledger meanwhile rather than blanking the panel.
  const last = useRef<{ identity: string; data: Ledger } | null>(null)
  const ledger = useAsync<Ledger>(
    async (signal) => {
      const data = { rows: await readLedger(DEFAULT_NETWORK, identity!), baseline: await readBaseline(DEFAULT_NETWORK, identity!) }
      if (!signal.aborted) last.current = { identity: identity!, data }
      return data
    },
    [identity ?? '', balance ?? '', balanceReadAt ?? ''],
    { enabled: identity !== null, initial: () => (last.current !== null && last.current.identity === identity ? last.current.data : undefined) },
  )
  const rows = ledger.data?.rows ?? []
  const s = summarize(rows)
  const repoIds = s.byRepo.map((r) => r.repo).filter((r) => r !== NO_REPO)
  const repos = useRepoNames(repoIds)
  // The gap line waits for a balance with every recorded write in it (not the kept session's
  // right after a reload, nor one a node behind the last write answers): `balanceSettled`. While
  // the ledger is re-read for a new balance, the rows shown may predate it: the line shown
  // before stays until the read lands.
  const settled =
    !ledger.loading &&
    balanceSettled({ credits: balance === null ? null : BigInt(balance), readAt: balanceReadAt, measuring: identity !== null && measurementPending(identity) }, rows)
  // Only rows since the baseline explain the balance change (earlier ones predate it): what they
  // spent, less what this browser's top-ups added.
  const baseline = ledger.data?.baseline ?? null
  const since = baseline === null ? null : summarize(rows.filter((r) => r.at >= baseline.at))
  const sinceBaseline = since === null ? 0 : since.allTime - since.credited
  const fresh = settled ? reconcile(sinceBaseline, baseline?.credits ?? null, balance === null ? null : BigInt(balance)) : null
  const rereading = ledger.loading
  // The line last shown, kept from committed renders only (a render React discards must not set it).
  const shownRec = useRef<ReturnType<typeof reconcile>>(null)
  const rec = settled ? fresh : rereading ? shownRec.current : null
  useEffect(() => {
    shownRec.current = rec
  })
  // Until then the balance is read again, a few times at most per last row (a lagging node
  // catches up within a block or two); a read that fails leaves the line waiting.
  const lastRowAt = rows.length === 0 ? null : rows[rows.length - 1]!.at
  const asked = useRef<{ at: number; n: number }>({ at: -1, n: 0 })
  useEffect(() => {
    if (identity === null || settled || rereading || lastRowAt === null) return
    if (asked.current.at !== lastRowAt) asked.current = { at: lastRowAt, n: 0 }
    if (asked.current.n >= SETTLE_READS) return
    const n = asked.current.n++
    const timer = setTimeout(() => void refreshBalance().catch(() => undefined), n === 0 ? 0 : SETTLE_WAIT_MS * 2 ** (n - 1))
    return () => clearTimeout(timer)
  }, [identity, settled, rereading, lastRowAt, balance, balanceReadAt, refreshBalance])

  if (ledger.loading && !ledger.settled) return <LoadingBlock label="Reading the spend ledger" />
  if (ledger.error) {
    return (
      <p className="text-dense text-anvil-500 dark:text-anvil-400" role="status">
        The spend ledger on this device could not be read: {ledger.error}
      </p>
    )
  }
  if (rows.length === 0) {
    return (
      <p className="text-dense text-anvil-500 dark:text-anvil-400">
        No writes from this browser yet. Every write you sign here is recorded on this device only.
      </p>
    )
  }
  const identityOnly = rows.every((r) => r.repo === null && isIdentityAction(r.kind))
  const latest = rows.slice(-50).reverse()

  const repoLabel = (id: string, link = true): JSX.Element => {
    if (id === NO_REPO) {
      return <span className="text-anvil-600 dark:text-anvil-300">{identityOnly ? 'Keys and identity' : 'Keys, identity and other'}</span>
    }
    const doc = repos.get(id)
    if (doc && !link) return <span className="font-mono">{doc.name}</span>
    if (doc) {
      return (
        <Link
          href={repoHref('/repo', { owner: doc.ownerId, name: doc.name, repoId: doc.repoId })}
          className="inline-block max-w-full truncate align-bottom font-mono text-anvil-900 underline decoration-anvil-300 coarse:-my-3 coarse:py-3 underline-offset-2 hover:text-forge-800 dark:text-anvil-50 dark:decoration-anvil-600 dark:hover:text-forge-400"
        >
          {doc.name}
        </Link>
      )
    }
    return (
      <span className="font-mono text-anvil-600 dark:text-anvil-300" title={id}>
        {shortId(id)}
      </span>
    )
  }

  return (
    <div className="space-y-4 text-dense" data-testid="spend-panel">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[12px] text-anvil-500 dark:text-anvil-400">This month</div>
          <Dash credits={s.thisMonth} />
        </div>
        <div>
          <div className="text-[12px] text-anvil-500 dark:text-anvil-400">All time ({plural(s.writes, 'write')})</div>
          <Dash credits={s.allTime} />
        </div>
      </div>
      {rec ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="spend-reconcile" data-unexplained={rec.unexplained}>
          Since the ledger began: <Dash credits={since?.allTime ?? 0} /> spent
          {since !== null && since.credited > 0 ? (
            <>
              , <Dash credits={since.credited} signed /> topped up here
            </>
          ) : null}{' '}
          · balance <Dash credits={rec.balanceChange} signed /> ·{' '}
          {creditsAsDash(Math.abs(rec.unexplained)) === '0' ? (
            'all of it in the ledger'
          ) : (
            <>
              <Dash credits={rec.unexplained} signed /> not in the ledger ({rec.unexplained > 0 ? 'top-ups made elsewhere' : 'other apps or keys'})
            </>
          )}
        </p>
      ) : !settled && baseline !== null ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="spend-reconcile-pending">
          Ledger <Dash credits={s.allTime} /> · reading the balance to reconcile…
        </p>
      ) : null}
      {s.missed > 0 ? (
        <p className="flex items-center gap-1 text-[12px] text-caution-700 dark:text-caution-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden /> {plural(s.missed, 'estimate')} missed by more than 25 %.
        </p>
      ) : null}

      <section aria-labelledby="spend-by-repo">
        <h3 id="spend-by-repo" className="mb-1 text-[12px] font-medium text-anvil-500 dark:text-anvil-400">
          By repo, all time
        </h3>
        <ul className="divide-y divide-anvil-100 dark:divide-anvil-850" data-testid="spend-by-repo">
          {s.byRepo.map((r) => (
            <li key={r.repo} className="flex flex-wrap items-center justify-between gap-x-3 py-1.5 coarse:min-h-11" data-repo={r.repo}>
              <span className="min-w-0 max-w-full">{repoLabel(r.repo)}</span>
              <span className="flex items-baseline gap-2 text-[12px]">
                <span className="text-anvil-500 dark:text-anvil-400">
                  {plural(r.writes, 'write')}
                </span>
                <Dash credits={r.credits} />
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="spend-rows">
        <h3 id="spend-rows" className="mb-1 text-[12px] font-medium text-anvil-500 dark:text-anvil-400">
          Latest {latest.length}, newest first
        </h3>
        {/* A list, not a four-column table: each row wraps to two lines on a phone. */}
        <ul className="divide-y divide-anvil-100 text-[12px] dark:divide-anvil-850" data-testid="spend-rows">
          {latest.map((r) => {
            const missed = estimateMissed(r)
            if (isCredit(r)) {
              return (
                <li key={`${r.at}:${r.documentId}`} className="grid grid-cols-[1fr_auto] gap-x-3 py-1.5" data-kind={r.kind}>
                  <span className="min-w-0">
                    <span className="block truncate text-anvil-800 dark:text-anvil-100">{spendKindLabel(r.kind)}</span>
                    <span className="text-anvil-500 dark:text-anvil-400">{timeAgo(r.at)}</span>
                  </span>
                  <span className="text-right text-verify-700 dark:text-verify-400">
                    {r.actualCredits === null ? '—' : <Dash credits={-r.actualCredits} signed />}
                    <span className="block text-anvil-500 dark:text-anvil-400">credited</span>
                  </span>
                </li>
              )
            }
            return (
              <li key={`${r.at}:${r.documentId}`} className="grid grid-cols-[1fr_auto] gap-x-3 py-1.5" data-kind={r.kind}>
                <span className="min-w-0">
                  <span className="block truncate text-anvil-800 dark:text-anvil-100">{spendKindLabel(r.kind)}</span>
                  <span className="text-anvil-500 dark:text-anvil-400">
                    {timeAgo(r.at)}
                    {r.repo !== null ? <> · {repoLabel(r.repo, false)}</> : null}
                  </span>
                </span>
                <span className="text-right">
                  <span className={cn('block', missed && 'text-caution-700 dark:text-caution-400')}>
                    {r.actualCredits === null ? <span title="Not measured in time">—</span> : <Dash credits={r.actualCredits} />}
                  </span>
                  {r.estimateCredits !== 0 ? (
                    <span className="text-anvil-500 dark:text-anvil-400">
                      est. <Estimate row={r} />
                    </span>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
