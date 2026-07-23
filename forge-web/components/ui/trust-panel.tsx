'use client'

/**
 * Trust panel — THE signature element. An "assay readout" that expands from the verification
 * chip to show the whole trust chain of a repo view, top to bottom, the way a foundry stamps
 * a certificate of assay on struck metal:
 *
 *   Platform proof  →  signed refs  →  content hashes  →  backend source
 *
 * It states the honest trust posture (S0.3): the web app is trust-MINIMIZED, not fully
 * trustless — quorum public keys come from a known endpoint, and everything downstream is
 * proof-verified against them. Each link shows its state (verified / degraded / failed) in the
 * semantic palette; the OIDs/hashes render as monospace serials.
 */

import { useState } from 'react'
import { ChevronRight, ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { VerifyState, Source } from './verification-chip'
import { Oid } from './oid'

export interface TrustChain {
  readonly refs: VerifyState
  readonly packs: VerifyState
  readonly source: Source
  /** Optional concrete artifacts, shown as serials when present. */
  readonly tipOid?: string
  readonly packHash?: string
  /** The repo/registry contract id the proof was verified against. */
  readonly contractId?: string
}

const STATE_META: Readonly<
  Record<VerifyState, { label: string; klass: string; Icon: typeof ShieldCheck }>
> = {
  verified: { label: 'verified', klass: 'text-verify', Icon: ShieldCheck },
  degraded: { label: 'degraded', klass: 'text-caution', Icon: ShieldAlert },
  failed: { label: 'failed', klass: 'text-danger', Icon: ShieldX },
}

function Link({
  step,
  title,
  detail,
  state,
  serial,
}: {
  step: string
  title: string
  detail: string
  state: VerifyState
  serial?: string
}): JSX.Element {
  const meta = STATE_META[state]
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
        <p className="mt-0.5 text-[12px] leading-snug text-anvil-500 dark:text-anvil-400">{detail}</p>
        {serial ? (
          <div className="mt-1.5">
            <Oid value={serial} chars={12} />
          </div>
        ) : null}
      </div>
    </li>
  )
}

export function TrustPanel({ chain }: { chain: TrustChain }): JSX.Element {
  const [open, setOpen] = useState(false)
  const worst: VerifyState =
    chain.refs === 'failed' || chain.packs === 'failed'
      ? 'failed'
      : chain.refs === 'degraded' || chain.packs === 'degraded'
        ? 'degraded'
        : 'verified'
  const meta = STATE_META[worst]

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
        <span className="hidden text-[12px] text-anvil-500 dark:text-anvil-400 sm:inline">
          refs proof · packs sha256 · src {chain.source}
        </span>
        <ChevronRight
          className={cn(
            'ml-auto h-4 w-4 text-anvil-400 transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="animate-fade-in border-t border-anvil-200 px-4 py-4 dark:border-anvil-750">
          <ol className="mb-3">
            <Link
              step="01"
              title="Platform quorum proof"
              detail="Reads are Merkle-proof verified against the testnet quorum. Trust-minimized: the quorum public keys come from a known endpoint (testnetTrusted) — the fully-trustless path is the Rust CLI."
              state="verified"
              serial={chain.contractId}
            />
            <Link
              step="02"
              title="Signed refs"
              detail="The current tip resolves from the append-only, non-deletable refUpdate log — every push is a consensus-signed document, folded by FORGE_RULES_V1."
              state={chain.refs}
              serial={chain.tipOid}
            />
            <Link
              step="03"
              title="Content hashes"
              detail="Pack + browse-artifact bytes are checked against the manifest sha256 before any object is reconstructed. A hash mismatch fails the read."
              state={chain.packs}
              serial={chain.packHash}
            />
            <Link
              step="04"
              title="Backend source"
              detail={`Bytes served from ${chain.source}. Availability, not authenticity — a degraded source cannot forge content that survives step 03.`}
              state={chain.packs === 'failed' ? 'failed' : chain.packs}
            />
          </ol>
          <p className="rounded border border-anvil-200 bg-white px-2.5 py-2 text-[12px] leading-snug text-anvil-500 dark:border-anvil-750 dark:bg-anvil-900 dark:text-anvil-400">
            Trust-minimized, not fully trustless — quorum keys come from a known endpoint;
            everything else is proof-verified.
          </p>
        </div>
      ) : null}
    </div>
  )
}
