'use client'

/**
 * A failed verification, at the top of the page (QW-004). The Verification card sits in the
 * rail, which a phone lays out under the content (thousands of pixels down), and some pages
 * have no rail at all: a check that ran and found the data wrong must not live only there.
 *
 *   - {@link TrustAnchorGate} (the app shell, every page): the quorum keys every proof is
 *     checked against disagree with a second source. Nothing on the page is proven then, so the
 *     page is withheld under the banner until the reader asks to see it, and it is framed as
 *     unverified while shown.
 *   - {@link TrustFailureBanner}: the banner itself, listing each Failed row of the card in the
 *     card's own words. A repo page heads its content with the rows it owns (file contents, where
 *     the bytes came from); what failed there is already kept off the page by its view.
 */

import { Suspense, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ShieldX } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useConnectionTrust } from '@/hooks/use-sdk'
import { useQuorumCheck } from '@/hooks/use-quorum-check'
import { useTrustView } from '@/hooks/use-trust-view'
import { deriveConnectionTrust, TRUST_ROW_TITLE, type TrustFailure } from '@/lib/view'

/** The banner: what failed, in the card's words, and the page's own action (show / hide). */
export function TrustFailureBanner({
  lead,
  failures,
  action,
  testId = 'trust-failure-banner',
}: {
  /** One sentence: what this means for the page. */
  lead: string
  failures: readonly TrustFailure[]
  action?: ReactNode
  testId?: string
}): JSX.Element {
  return (
    <div data-testid={testId} className="mb-4 rounded-lg border-2 border-danger/50 bg-danger/10 px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <ShieldX className="mt-0.5 h-5 w-5 shrink-0 text-danger-700 dark:text-danger-400" aria-hidden />
        <div className="min-w-0 flex-1">
          {/* The alert holds the state, announced once when it appears. */}
          <div role="alert">
            <p className="text-prose font-medium text-anvil-900 dark:text-anvil-50">Verification failed</p>
            <p className="mt-0.5 text-dense text-anvil-700 dark:text-anvil-200">{lead}</p>
          </div>
          <ul className="mt-2 space-y-1.5">
            {failures.map((f) => (
              <li key={f.row} className="text-dense text-anvil-700 dark:text-anvil-200">
                <span className="font-medium text-danger-700 dark:text-danger-400">{f.title}: Failed.</span> {f.detail}
                {f.note ? <span className="mt-0.5 block text-[12px] text-anvil-600 dark:text-anvil-300">{f.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
        {/* Its own row under the text on a phone, so the sentences keep the full width. */}
        {action ? <div className="flex basis-full items-center gap-2 pl-8 sm:basis-auto sm:pl-0">{action}</div> : null}
      </div>
    </div>
  )
}

/**
 * The app shell's gate on the trust anchor: while the quorum-key cross-check reports a
 * mismatch, every page leads with the failure and its content is withheld until the reader
 * chooses to see it, marked unverified. Follows the connection without starting one, and runs
 * the cross-check (once per session per network, `crossCheckQuorumKeysCached`) on any page
 * that is connected, so a page without the Verification card still learns of it.
 */
export function TrustAnchorGate({ children }: { children: ReactNode }): JSX.Element {
  const { network, connection } = useConnectionTrust()
  // Not while Platform is unreachable: a comparison run then only reports that it could not run.
  const quorum = useQuorumCheck(network, connection === 'trusted')
  const chain = deriveConnectionTrust(network, connection, quorum)
  // Per view (a route and its query): a navigation that keeps this shell mounted, another file
  // or repo on the same route, is withheld again until asked (the view watcher resets it).
  const [shown, setShown] = useState(false)
  const hide = useCallback(() => setShown(false), [])
  const failed = chain.state === 'failed'
  // One tree shape whether or not the check failed: the page is never remounted when the
  // result arrives (a write in flight or a half-typed comment survives), and stays mounted
  // while hidden.
  return (
    <>
      {/* useSearchParams needs a Suspense boundary in a static export; it renders nothing. */}
      <Suspense fallback={null}>
        <OnViewChange run={hide} />
      </Suspense>
      {failed ? (
        <TrustFailureBanner
          testId="trust-anchor-failed"
          lead={
            shown
              ? 'Shown on your request, unverified. Nothing on this page is proven: every Platform read was checked against keys a second source disputes.'
              : 'This page is hidden: every Platform read was checked against keys a second source disputes, so nothing on it is proven.'
          }
          failures={[{ row: 'chain', title: TRUST_ROW_TITLE.chain, detail: chain.detail, ...(chain.note ? { note: chain.note } : {}) }]}
          action={
            <Button variant="danger" size="sm" onClick={() => setShown((s) => !s)} aria-expanded={shown} aria-controls="trust-withheld">
              {shown ? 'Hide the page' : 'Show it anyway, unverified'}
            </Button>
          }
        />
      ) : null}
      <div
        id="trust-withheld"
        data-testid={failed ? 'trust-withheld' : undefined}
        hidden={failed && !shown}
        className={failed ? 'rounded-lg border-2 border-dashed border-danger/60 p-2 sm:p-3' : undefined}
      >
        {failed ? (
          <p className="mb-2 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wide text-danger-700 dark:text-danger-400">
            <ShieldX className="h-3.5 w-3.5" aria-hidden /> Unverified
          </p>
        ) : null}
        {children}
      </div>
    </>
  )
}

/**
 * Runs `run` when the view (route and query) changes, in a layout effect: before the browser
 * paints the new view, so a page shown on request never carries over to the next one.
 */
function OnViewChange({ run }: { run: () => void }): null {
  const view = useTrustView()
  const first = useRef(view)
  useLayoutEffect(() => {
    if (view !== first.current) {
      first.current = view
      run()
    }
  }, [view, run])
  return null
}
