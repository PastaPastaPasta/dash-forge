'use client'

/**
 * Trust panel — THE signature element. An "assay readout" that expands from the verification
 * chip to show the whole trust chain of a repo view, top to bottom, the way a foundry stamps
 * a certificate of assay on struck metal:
 *
 *   Platform proof  →  refs  →  content hashes  →  byte source
 *
 * Every state shown comes from {@link deriveTrust} over checks that actually ran this session
 * (roadmap invariant 4) — never from what the app intends to check. It also states the honest
 * trust posture (S0.3, roadmap D-C): the web app is trust-MINIMIZED, not trustless — the
 * quorum public keys every proof is checked against come from one known HTTPS endpoint.
 */

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TrustLink, TrustReport } from '@/lib/view'
import { TRUST_META } from './verification-chip'
import { Oid } from './oid'

function Step({
  step,
  title,
  link,
  serial,
}: {
  step: string
  title: string
  link: TrustLink
  serial?: string
}): JSX.Element {
  const meta = TRUST_META[link.state]
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {/* rail */}
      <div className="flex flex-col items-center">
        <span className={cn('flex h-6 w-6 items-center justify-center rounded-full bg-anvil-100 dark:bg-anvil-800', meta.klass)}>
          <meta.Icon className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="mt-1 w-px flex-1 bg-anvil-200 last:hidden dark:bg-anvil-750" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-wide text-anvil-400 dark:text-anvil-500">
            {step}
          </span>
          <span className="text-dense font-medium text-anvil-800 dark:text-anvil-100">{title}</span>
          <span className={cn('text-[11px] font-mono', meta.klass)}>{meta.label}</span>
        </div>
        <p className="mt-0.5 text-[12px] leading-snug text-anvil-500 dark:text-anvil-400">{link.detail}</p>
        {serial ? (
          <div className="mt-1.5">
            <Oid value={serial} chars={12} />
          </div>
        ) : null}
      </div>
    </li>
  )
}

export function TrustPanel({
  report,
  contractId,
  tipOid,
}: {
  report: TrustReport
  /** The repo contract the proofs were read from. */
  contractId?: string
  /** The commit the attested ref points at. */
  tipOid?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const meta = TRUST_META[report.overall]

  return (
    <div className="rounded-lg border border-anvil-200 bg-anvil-50 dark:border-anvil-750 dark:bg-anvil-850">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-anvil-100 dark:hover:bg-anvil-800"
      >
        <meta.Icon className={cn('h-4 w-4 shrink-0', meta.klass)} aria-hidden />
        <span className="text-dense font-medium text-anvil-800 dark:text-anvil-100">Assay</span>
        <span className={cn('font-mono text-[11px]', meta.klass)}>{meta.label}</span>
        <span className="hidden truncate text-[12px] text-anvil-500 dark:text-anvil-400 sm:inline">
          refs {report.refs.summary} · content {report.content.summary}
        </span>
        <ChevronRight
          className={cn(
            'ml-auto h-4 w-4 shrink-0 text-anvil-400 transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="animate-fade-in border-t border-anvil-200 px-4 py-4 dark:border-anvil-750">
          <ol className="mb-3">
            <Step step="01" title="Platform proofs" link={report.proofs} serial={contractId} />
            <Step step="02" title="Refs" link={report.refs} serial={tipOid} />
            <Step step="03" title="Content hashes" link={report.content} />
            <Step step="04" title="Byte source" link={report.source} />
          </ol>
          <p className="rounded border border-anvil-200 bg-white px-2.5 py-2 text-[12px] leading-snug text-anvil-500 dark:border-anvil-750 dark:bg-anvil-900 dark:text-anvil-400">
            Trust-minimized, not trustless: proofs are only as good as the {report.networkLabel} quorum
            keys they are checked against, and this app fetches those from{' '}
            <span className="font-mono">{report.quorumHost}</span>. Whoever controls
            that endpoint could vouch for false data.
          </p>
        </div>
      ) : null}
    </div>
  )
}
