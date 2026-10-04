'use client'

/**
 * Settings → Notifications → "Email and push": the optional service a build names in
 * `NEXT_PUBLIC_NOTIFY_URL` (`services/forge-notify`, `docs/hosting/forge-notify.md`). Hidden when the
 * build names none. Every change is a request signed with this browser's key; the service keeps
 * the address encrypted and off chain, and Forge works the same without it.
 */

import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { BASE_PATH } from '@/lib/short-url'
import { errorMessage } from '@/lib/utils'
import {
  NOTIFY_URL,
  call,
  fetchInfo,
  pushPayload,
  pushSupported,
  vapidKeyBytes,
  type NotifyAccount,
  type NotifyAction,
  type NotifyInfo,
  type NotifyPrefs,
} from '@/lib/notify/client'

const TOPICS: readonly { key: keyof NotifyPrefs; label: string }[] = [
  { key: 'participating', label: 'Issues and pull requests I opened or commented on' },
  { key: 'reviewRequested', label: 'Someone asks me for a review' },
  { key: 'assigned', label: 'Someone assigns me' },
  { key: 'mentioned', label: 'Someone @mentions me' },
  { key: 'watching', label: 'Repos I watch' },
  { key: 'ownRepos', label: 'Repos I own or belong to (as if watched)' },
  { key: 'releases', label: 'Releases of those repos' },
  { key: 'privateActivity', label: 'Private repos: “new activity”, with no titles or text' },
]

const SW_PATH = `${BASE_PATH}/notify-sw.js`

/** This browser's push subscription for the service worker, if it has one. */
async function currentPush(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration(SW_PATH)
  return (await reg?.pushManager.getSubscription()) ?? null
}

function browserLabel(): string {
  const ua = navigator.userAgent
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} on ${os}` : browser
}

export function NotifyPanel(): JSX.Element | null {
  if (!NOTIFY_URL) return null
  return <NotifyService base={NOTIFY_URL} />
}

/** The section for the service at `base` (exported for its tests). */
export function NotifyService({ base }: { base: string }): JSX.Element {
  const { identity, controller } = useAuth()
  const [info, setInfo] = useState<NotifyInfo | null>(null)
  const [down, setDown] = useState<string | null>(null)
  const [account, setAccount] = useState<NotifyAccount | null>(null)
  const [draft, setDraft] = useState<NotifyPrefs | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pushHere, setPushHere] = useState<PushSubscription | null>(null)

  useEffect(() => {
    let live = true
    fetchInfo(base)
      .then((i) => live && setInfo(i))
      .catch((e: unknown) => live && setDown(errorMessage(e)))
    void currentPush().then((s) => live && setPushHere(s))
    return () => {
      live = false
    }
  }, [base])

  const run = useCallback(
    async <T,>(label: string, action: NotifyAction, payload: unknown = {}): Promise<T | null> => {
      if (!info) return null
      setBusy(label)
      setError(null)
      setNote(null)
      try {
        return await call<T>(base, info, controller.serviceKey(), action, payload)
      } catch (e) {
        setError(errorMessage(e))
        return null
      } finally {
        setBusy(null)
      }
    },
    [base, controller, info],
  )

  const load = useCallback(async () => {
    const a = await run<NotifyAccount>('load', 'account.get')
    if (a) {
      setAccount(a)
      setDraft(a.prefs)
    }
  }, [run])

  if (down) {
    return (
      <p className="text-dense text-anvil-600 dark:text-anvil-300" data-testid="notify-down">
        The notification service at <span className="font-mono">{new URL(base).host}</span> is not answering ({down}). Nothing else depends on it: the
        inbox above keeps working.
      </p>
    )
  }
  if (!info) return <p className="text-dense text-anvil-500 dark:text-anvil-400">Asking the notification service what it offers…</p>

  const channels = [info.channels.email ? 'email' : null, info.channels.push ? 'browser push' : null].filter(Boolean).join(' and ')
  const privacy = (
    <div className="space-y-1.5 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="notify-privacy">
      <p>
        Optional. <strong className="font-medium text-anvil-700 dark:text-anvil-200">{info.operator}</strong> runs this service and sends {channels || 'nothing yet'}. Forge works the same
        without it, and every notice links back here, where the chain is read again.
      </p>
      <p>
        It keeps your identity id, your address and push subscriptions (encrypted), your choices below and which repos it follows for you. None of it
        goes on chain. It reads only public data: for a private repo it can say “new activity”, never a title. Sign-in is a request signed by this
        browser&apos;s key, so there is no account or password.
        {info.privacyUrl ? (
          <>
            {' '}
            <a href={info.privacyUrl} target="_blank" rel="noreferrer" className="underline">
              Privacy notice
            </a>
            .
          </>
        ) : null}
      </p>
    </div>
  )

  if (!identity) {
    return (
      <div className="space-y-2">
        {privacy}
        <p className="text-dense text-anvil-600 dark:text-anvil-300">Sign in to set up email or push.</p>
      </div>
    )
  }
  if (!account || !draft) {
    return (
      <div className="space-y-3">
        {privacy}
        <Button size="sm" loading={busy === 'load'} onClick={() => void load()} data-testid="notify-load">
          Show my notification settings
        </Button>
        {error ? <p className="text-dense text-danger-700 dark:text-danger-400">{error}</p> : null}
      </div>
    )
  }

  const savePrefs = async (): Promise<void> => {
    const a = await run<NotifyAccount>('prefs', 'prefs.set', { prefs: draft })
    if (a) {
      setAccount(a)
      setDraft(a.prefs)
      setNote('Saved.')
    }
  }

  const sendConfirmation = async (): Promise<void> => {
    const to = email.trim()
    if (await run('email', 'email.set', { email: to })) {
      setEmail('')
      await load()
      setNote(`A confirmation link is on its way to ${to}. Nothing is sent there until you open it.`)
    }
  }

  const removeEmail = async (): Promise<void> => {
    if (await run('email', 'email.remove')) await load()
  }

  const enablePush = async (): Promise<void> => {
    if (!info.vapidPublicKey) return
    setError(null)
    try {
      if ((await Notification.requestPermission()) !== 'granted') {
        setError('This browser did not allow notifications. Allow them for this site in its settings, then try again.')
        return
      }
      const reg = await navigator.serviceWorker.register(SW_PATH, { scope: `${BASE_PATH}/` })
      await navigator.serviceWorker.ready
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyBytes(info.vapidPublicKey) }))
      if (await run('push', 'push.add', pushPayload(sub, browserLabel()))) {
        setPushHere(sub)
        await load()
      }
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const disablePush = async (): Promise<void> => {
    const sub = pushHere
    if (!sub) return
    if (await run('push', 'push.remove', { endpoint: sub.endpoint })) {
      await sub.unsubscribe().catch(() => undefined)
      setPushHere(null)
      await load()
    }
  }

  const exportData = async (): Promise<void> => {
    const data = await run<unknown>('export', 'data.export')
    if (!data) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `forge-notify-${identity.slice(0, 8)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const deleteAll = async (): Promise<void> => {
    if (!window.confirm(`Delete everything ${info.operator} keeps for this identity (address, push subscriptions, choices)? Notifications stop.`)) return
    if (await run('delete', 'data.delete')) {
      await pushHere?.unsubscribe().catch(() => undefined)
      setPushHere(null)
      await load()
      setNote('Deleted. The service keeps nothing for this identity now.')
    }
  }

  const mail = account.email
  return (
    <div className="space-y-4" data-testid="notify-panel">
      {privacy}

      {info.channels.email ? (
        <div className="space-y-2">
          <h3 className="text-dense font-medium">Email</h3>
          {mail?.address ? (
            <p className="text-dense" data-testid="notify-email">
              <span className="font-mono">{mail.address}</span> ·{' '}
              {mail.verified ? (mail.paused ? 'paused (unsubscribed from a mail)' : 'confirmed') : 'waiting for you to open the confirmation link'}
              <Button size="sm" variant="ghost" className="ml-2" loading={busy === 'email'} onClick={() => void removeEmail()}>
                Remove
              </Button>
            </p>
          ) : null}
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void sendConfirmation()
            }}
          >
            <label className="sr-only" htmlFor="notify-email-input">
              Email address
            </label>
            <input
              id="notify-email-input"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={mail?.address ? 'A different address' : 'you@example.org'}
              className="h-9 min-w-0 flex-1 rounded-md border border-anvil-300 bg-transparent px-2.5 text-dense dark:border-anvil-700"
            />
            <Button size="sm" type="submit" loading={busy === 'email'} disabled={!email.trim()}>
              Send confirmation
            </Button>
          </form>
        </div>
      ) : null}

      {info.channels.push && info.vapidPublicKey ? (
        <div className="space-y-2">
          <h3 className="text-dense font-medium">Push in this browser</h3>
          {!pushSupported() ? (
            <p className="text-dense text-anvil-600 dark:text-anvil-300">This browser cannot take push notifications.</p>
          ) : pushHere ? (
            <Button size="sm" loading={busy === 'push'} onClick={() => void disablePush()} data-testid="notify-push-off">
              Turn off push here
            </Button>
          ) : (
            <Button size="sm" loading={busy === 'push'} onClick={() => void enablePush()} data-testid="notify-push-on">
              Turn on push here
            </Button>
          )}
          {account.push && account.push.length > 0 ? (
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
              Browsers with push: {account.push.map((p) => p.label ?? 'unnamed').join(', ')}.
            </p>
          ) : null}
        </div>
      ) : null}

      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-dense font-medium">Tell me about</legend>
        {TOPICS.map((t) => (
          <label key={t.key} className="flex items-center gap-2 text-dense coarse:min-h-11">
            <input
              type="checkbox"
              className="h-4 w-4 accent-forge-700"
              checked={draft[t.key] === true}
              onChange={(e) => setDraft({ ...draft, [t.key]: e.target.checked })}
            />
            {t.label}
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-dense font-medium">How</legend>
        <label className="flex items-center gap-2 text-dense coarse:min-h-11">
          <input type="checkbox" className="h-4 w-4 accent-forge-700" checked={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.checked })} />
          By email
        </label>
        <label className="flex items-center gap-2 text-dense coarse:min-h-11">
          <input type="checkbox" className="h-4 w-4 accent-forge-700" checked={draft.push} onChange={(e) => setDraft({ ...draft, push: e.target.checked })} />
          By push
        </label>
        <label className="flex items-center gap-2 text-dense coarse:min-h-11">
          <span>Email</span>
          <select
            value={draft.delivery}
            onChange={(e) => setDraft({ ...draft, delivery: e.target.value === 'daily' ? 'daily' : 'instant' })}
            className="h-8 rounded-md border border-anvil-300 bg-transparent px-2 text-dense dark:border-anvil-700"
          >
            <option value="instant">as it happens</option>
            <option value="daily">as one daily digest ({String(info.digestHourUtc).padStart(2, '0')}:00 UTC; no push)</option>
          </select>
        </label>
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" loading={busy === 'prefs'} onClick={() => void savePrefs()} data-testid="notify-save">
          Save
        </Button>
        <Button size="sm" loading={busy === 'test'} onClick={() => void run<{ email: boolean; push: number }>('test', 'test.send').then((r) => r && setNote(`Test sent: ${r.email ? 'one mail' : 'no mail'}, ${r.push} push.`))}>
          Send a test
        </Button>
        <Button size="sm" variant="ghost" loading={busy === 'export'} onClick={() => void exportData()}>
          Download my data
        </Button>
        <Button size="sm" variant="danger" loading={busy === 'delete'} onClick={() => void deleteAll()}>
          Delete my data
        </Button>
      </div>

      {account.following ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
          Following {account.following.repos} repos for you{account.following.private ? `, ${account.following.private} of them private (activity only)` : ''}. Your own actions never
          notify you.
        </p>
      ) : null}
      {note ? <p className="text-dense text-anvil-700 dark:text-anvil-200" role="status">{note}</p> : null}
      {error ? <p className="text-dense text-danger-700 dark:text-danger-400" role="alert">{error}</p> : null}
    </div>
  )
}
