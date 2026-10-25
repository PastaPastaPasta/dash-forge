'use client'

/**
 * Where a wallet returns after an App Connect v2 approval (`cb` in the request; `/connect/`).
 *
 * It is a nudge and nothing more: it tells the tab that showed the code to check now, and if that
 * tab answers, this one can be closed. If no tab answers (the code was shown in another browser
 * or a tab that was closed), it says what the wallet reported and points back to where the user
 * started. It stores nothing and signs nothing: the request's key exists in the first tab's
 * memory only, so a sign-in cannot continue here.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/states'
import {
  ACK_WAIT_MS,
  CALLBACK_CHANNEL,
  callbackStatusCopy,
  isConnectCallbackAck,
  parseConnectCallback,
  type ConnectCallbackMessage,
} from '@/lib/auth/connect-callback'

type View =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'other-tab' }
  | { readonly kind: 'status'; readonly title: string; readonly body: string }

export function ConnectReturn(): JSX.Element {
  const router = useRouter()
  const [view, setView] = useState<View>({ kind: 'waiting' })

  useEffect(() => {
    const callback = parseConnectCallback(window.location.search)
    // Not one of ours: nothing to do here.
    if (callback === null) {
      router.replace('/')
      return
    }
    // The wallet reported a failure: said at once. The tab that showed the code is told too, so it
    // can stop waiting for an answer that will not come.
    const failure = callbackStatusCopy(callback.status)
    const fallback: View = {
      kind: 'status',
      title: 'Go back to Forge',
      body: 'Return to the Forge tab where you started. It checks your wallet on its own, and signs you in when the approval is there.',
    }
    if (failure) setView({ kind: 'status', ...failure })
    let channel: BroadcastChannel | null = null
    try {
      channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CALLBACK_CHANNEL)
    } catch {
      channel = null
    }
    if (channel === null) {
      if (!failure) setView(fallback)
      return
    }
    const open = channel
    let answered = false
    open.onmessage = (event: MessageEvent) => {
      if (!isConnectCallbackAck(event.data, callback.requestHash)) return
      answered = true
      if (!failure) setView({ kind: 'other-tab' })
    }
    const message: ConnectCallbackMessage = { type: 'forge-app-connect-callback', requestHash: callback.requestHash, status: callback.status }
    open.postMessage(message)
    const timer = setTimeout(() => {
      if (!answered && !failure) setView(fallback)
    }, ACK_WAIT_MS)
    return () => {
      clearTimeout(timer)
      open.close()
    }
  }, [router])

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-sm flex-col items-center justify-center gap-3 text-center" data-testid="connect-return" role="status" aria-live="polite">
      {view.kind === 'waiting' ? <Spinner label="Finishing sign-in" /> : null}
      {view.kind === 'other-tab' ? (
        <>
          <h1 className="text-xl">You&apos;re signing in on your other Forge tab</h1>
          <p className="text-dense text-anvil-600 dark:text-anvil-300">You can close this one.</p>
        </>
      ) : null}
      {view.kind === 'status' ? (
        <>
          <h1 className="text-xl">{view.title}</h1>
          <p className="text-dense text-anvil-600 dark:text-anvil-300">{view.body}</p>
          <Link href="/">
            <Button variant="primary">Open Forge</Button>
          </Link>
        </>
      ) : null}
    </div>
  )
}
