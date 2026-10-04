'use client'

/**
 * SignatureBadge — GitHub's Verified / Unverified label on a signed commit (P1-7), from its
 * verdict (`lib/rules/signature.ts`). The label opens a panel saying who signed with which key,
 * or why the signature could not be verified. An unsigned commit shows nothing, as on GitHub.
 *
 * Verified means the signature checks against a key that exactly one of this repository's owner
 * and members lists on their (public) profile. Forge checks it in this browser; no server is
 * asked.
 */

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { Author } from '@/components/author'
import { useDismiss } from '@/components/repo/target-rail'
import type { SignatureState } from '@/hooks/use-commit-signatures'
import type { SignatureVerdict } from '@/lib/rules/signature'
import { cn } from '@/lib/utils'

/** Why a signature is unverified, in a sentence. */
const REASON: Readonly<Record<NonNullable<SignatureVerdict['reason']>, string>> = {
  unknown_key: "The key isn't on the profile of this repository's owner or any of its members.",
  ambiguous_key: 'More than one identity lists this key on its profile, so it names nobody.',
  bad_signature: 'The signature does not match this {subject}: the {subject} was changed after it was signed, or the signature is not git’s.',
  unsupported: 'Forge checks Ed25519 and ECDSA (P-256/384/521) OpenPGP keys and Ed25519 SSH keys, with SHA-256 or stronger. This signature uses something else.',
  malformed: "The signature could not be read.",
}

function keyLine(v: SignatureVerdict): string | null {
  if (v.key === null) return null
  if (v.format === 'ssh') return `SSH key fingerprint: ${v.key}`
  return v.key.length > 16 ? `GPG key fingerprint: ${v.key}` : `GPG key ID: ${v.key}`
}

/** The panel's width (px), and its margin from the viewport's edges. */
const PANEL_W = 320
const EDGE = 8
/** The room (px) the panel needs below its label before it opens above it instead. */
const PANEL_ROOM = 240

export function SignatureBadge({
  state,
  className,
  subject = 'commit',
}: {
  state: SignatureState | undefined
  className?: string
  /** What was signed: a commit, or an annotated tag. */
  subject?: 'commit' | 'tag'
}): JSX.Element | null {
  // Where the open panel sits: fixed under the label, kept inside the viewport, so a list's
  // `overflow: hidden` (the commit log's rounded box) never clips it.
  const [at, setAt] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null)
  const open = at !== null
  const panelId = useId()
  const root = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  const toggle = (): void => {
    if (open || button.current === null) return setAt(null)
    const r = button.current.getBoundingClientRect()
    const width = Math.min(PANEL_W, window.innerWidth - 2 * EDGE)
    const left = Math.max(EDGE, Math.min(r.right - width, window.innerWidth - width - EDGE))
    // Below the label, or above it when the viewport has no room for the panel below.
    setAt(window.innerHeight - r.bottom < PANEL_ROOM && r.top > PANEL_ROOM ? { bottom: window.innerHeight - r.top + 4, left, width } : { top: r.bottom + 4, left, width })
  }

  // Escape or a click outside closes it, as the rail's pickers close.
  useDismiss(open, root, () => {
    setAt(null)
    button.current?.focus()
  })
  useEffect(() => {
    if (!open) return
    // A fixed panel would drift from its label: scrolling or resizing closes it.
    const close = (): void => setAt(null)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  if (state === undefined) return null
  if (state === 'checking') {
    return (
      <span className={cn('rounded-full border border-anvil-200 px-2 text-[11px] text-anvil-500 dark:border-anvil-750 dark:text-anvil-400', className)} data-testid="signature-checking">
        Signed…
      </span>
    )
  }
  const verified = state !== 'error' && state.status === 'verified'
  const bad = state !== 'error' && state.reason === 'bad_signature'
  const label = verified ? 'Verified' : 'Unverified'
  return (
    <span ref={root} className={cn('relative inline-flex', className)} data-testid="signature-badge" data-status={state === 'error' ? 'error' : state.status} data-reason={state === 'error' ? undefined : state.reason ?? undefined}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        className={cn(
          'hit-area rounded-full border px-2 text-[11px] font-medium leading-5',
          verified
            ? 'border-verify/60 text-verify-700 dark:text-verify-400'
            : bad
              ? 'border-danger/60 text-danger-700 dark:text-danger-400'
              : 'border-anvil-300 text-anvil-600 dark:border-anvil-700 dark:text-anvil-300',
        )}
      >
        {label}
        <span className="sr-only"> signature: details</span>
      </button>
      {at !== null ? (
        <span
          id={panelId}
          role="dialog"
          aria-label={`${label} signature`}
          style={{ position: 'fixed', top: at.top, bottom: at.bottom, left: at.left, width: at.width }}
          className="z-50 block whitespace-normal rounded-md border border-anvil-200 bg-white p-3 text-left text-[12px] font-normal text-anvil-700 shadow-lg dark:border-anvil-750 dark:bg-anvil-900 dark:text-anvil-200"
          data-testid="signature-panel"
        >
          {state === 'error' ? (
            <span className="block">Couldn&apos;t read the signing keys of this repository&apos;s members from Platform, so this signature was not checked.</span>
          ) : (
            <>
              <span className="block font-medium text-anvil-900 dark:text-anvil-50">
                {verified ? `This ${subject} was signed with a key its signer lists on their profile.` : REASON[state.reason ?? 'malformed'].replaceAll('{subject}', subject)}
              </span>
              {verified && state.signer !== null ? (
                <span className="mt-2 flex items-center gap-1">
                  Signed by <Author identityId={state.signer} />
                </span>
              ) : null}
              {keyLine(state) ? <span className="mt-2 block break-all font-mono text-[11px] text-anvil-600 dark:text-anvil-300">{keyLine(state)}</span> : null}
              <span className="mt-2 block text-anvil-500 dark:text-anvil-400">
                Checked in your browser against the keys this repository&apos;s owner and members publish on their profiles.{' '}
                <Link href="/settings/profile/#signing-keys" className="underline hover:text-forge-700 dark:hover:text-forge-400">
                  Add your signing key
                </Link>
              </span>
            </>
          )}
        </span>
      ) : null}
    </span>
  )
}
