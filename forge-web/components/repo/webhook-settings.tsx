'use client'

/**
 * Settings → Webhooks (QW-071; GitHub's Settings → Webhooks): the repo's hooks, and, for a
 * maintainer, adding and removing them from the browser, as `dg webhook add | list | remove`
 * does (`lib/repo/webhooks.ts`). A hook asks a relay identity (forge-relay) to POST GitHub-shaped
 * events to a URL; its secret is encrypted from the writer's encryption key to the relay's, so
 * adding one needs the encryption key in this browser (Settings → Private repos). Public repos only.
 */

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Webhook as WebhookIcon } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { plural, timeAgo } from '@/lib/view'
import { DOC, repoContractIds } from '@/lib/repo'
import { previewDelete } from '@/lib/sdk'
import {
  WEBHOOK_EVENTS,
  activeHooks,
  generateWebhookSecret,
  randomHookId,
  readWebhookDocs,
  removalNeedsTombstone,
  removeWebhook,
  webhookCost,
  webhookUrlProblem,
  writeWebhook,
  type WebhookView,
} from '@/lib/repo/webhooks'
import { webhookSealer } from '@/lib/auth/encryption-key'
import { decodeIdentifier } from '@/lib/auth'
import { retryWhileMissing } from '@/lib/view/retry'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Author } from '@/components/author'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { UnlockMore } from '@/components/auth/unlock-more'
import { Button } from '@/components/ui/button'
import { SecretValue } from '@/components/ui/secret-value'
import { Field, Input } from '@/components/ui/input'
import { ErrorState, LoadingBlock } from '@/components/ui/states'
import { Section } from '@/components/repo/repo-settings-sections'
import { shortId } from '@/lib/utils'

function identityProblem(id: string): string | null {
  if (id === '') return 'Enter the relay identity that delivers.'
  try {
    return decodeIdentifier(id).length === 32 ? null : 'Not an identity id (base58, 32 bytes).'
  } catch {
    return 'Not an identity id (base58, 32 bytes).'
  }
}

export function WebhookSettings({ home, maintainer }: { home: RepoHome; maintainer: boolean }): JSX.Element {
  const repo = home.repo
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity, signer, unlockScope } = useAuth()
  const guard = useWriteGuard()
  const isPublic = repo.visibility === 'public'
  const docs = useAsync(() => readWebhookDocs(sdk!, repo), [ready, repo.repoId], { enabled: ready && sdk !== null && isPublic })
  const hooks = useMemo(() => activeHooks(docs.data ?? []), [docs.data])
  const sealer = useAsync(() => webhookSealer(sdk!, network, identity!, repo.forge.community), [ready, network, identity ?? '', repo.forge.community, unlockScope ?? ''], {
    enabled: ready && sdk !== null && identity !== null && maintainer && isPublic,
  })

  const [url, setUrl] = useState('')
  const [relay, setRelay] = useState('')
  const [allEvents, setAllEvents] = useState(true)
  const [events, setEvents] = useState<readonly string[]>(['push'])
  const [allowQuery, setAllowQuery] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<WebhookView | null>(null)
  // The secret of the hook just added: shown once, as `dg webhook add` prints it.
  const [shown, setShown] = useState<{ url: string; secret: string } | null>(null)
  // The add's content, fixed when its confirm first opens, and kept until the hook is written: a
  // write left unconfirmed may still land, so adding the same hook again reuses its id and
  // secret (a newer revision of that hook, whose secret is the one shown), never a second hook.
  const [pending, setPending] = useState<{ hookId: string; url: string; events: readonly string[]; relay: string; secret: string } | null>(null)
  // A tab that resumed with the signing key only cannot seal: it unlocks first (below).
  const canSeal = sealer.data?.kind === 'ready' && unlockScope !== 'signing'

  const chosen = allEvents ? [] : events
  const urlProblem = url.trim() === '' ? null : webhookUrlProblem(url.trim(), allowQuery)
  const relayProblem = relay.trim() === '' ? null : identityProblem(relay.trim())
  const eventsProblem = !allEvents && events.length === 0 ? 'Pick at least one event, or all of them.' : null
  const cost = webhookCost(repo, { url: url.trim(), events: chosen })
  const canAdd = url.trim() !== '' && relay.trim() !== '' && urlProblem === null && relayProblem === null && eventsProblem === null

  const reloadUntil = async (holds: (rows: readonly WebhookView[]) => boolean): Promise<void> => {
    if (!sdk) return
    await retryWhileMissing(async () => (holds(activeHooks(await readWebhookDocs(sdk, repo))) ? true : null), 8)
    docs.reload()
  }

  const add = async (intent: string): Promise<void> => {
    if (!sdk || !signer || pending === null || sealer.data?.kind !== 'ready') throw new Error('sign in to continue')
    await writeWebhook(sdk, signer, repo, sealer.data.seal, { hookId: pending.hookId, url: pending.url, events: pending.events, relayIdentityId: pending.relay, secret: pending.secret }, intent)
    setShown({ url: pending.url, secret: pending.secret })
    setPending(null)
    setUrl('')
    setRelay('')
    await reloadUntil((rows) => rows.some((h) => h.hookId === pending.hookId))
  }
  const remove = async (): Promise<void> => {
    if (!sdk || !signer || removing === null) throw new Error('unlock to continue')
    const hookId = removing.hookId
    // The encryption key is needed only when a disabled revision must be written first.
    await removeWebhook(sdk, signer, repo, canSeal && sealer.data?.kind === 'ready' ? sealer.data.seal : null, hookId)
    await reloadUntil((rows) => !rows.some((h) => h.hookId === hookId))
  }

  // Removing deletes the signer's revisions (refunds), after a disabled revision when another
  // maintainer's would otherwise be current: then it costs about what an add does.
  const removeCost = (h: WebhookView) =>
    identity !== null && removalNeedsTombstone(docs.data ?? [], h.hookId, identity) ? webhookCost(repo, h) : previewDelete(DOC.webhook)

  const toggle = (e: string, on: boolean): void => setEvents((xs) => (on ? [...xs.filter((x) => x !== e), e] : xs.filter((x) => x !== e)))

  return (
    <Section id="webhooks" title="Webhooks" icon={<WebhookIcon className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />}>
      <div className="space-y-3 rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="webhooks">
        <p className="text-dense text-anvil-600 dark:text-anvil-300">
          A relay watches this repo and sends GitHub-style events to your URL, signed with a secret only the relay can read. The URL and events
          are public on Platform.
        </p>
        {!isPublic ? (
          <p className="text-dense text-anvil-600 dark:text-anvil-300" data-testid="webhooks-private">
            Webhooks are for public repos: a relay is not a member of a private repo and could not read what it would deliver.
          </p>
        ) : docs.error ? (
          <ErrorState message={docs.error} onRetry={docs.reload} />
        ) : docs.data === null ? (
          <LoadingBlock label="Reading webhooks" />
        ) : (
          <ul aria-label="Webhooks" className="divide-y divide-anvil-100 overflow-hidden rounded-md border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800">
            {hooks.length === 0 ? (
              <li className="px-3 py-2 text-dense text-anvil-500 dark:text-anvil-400">No webhooks.</li>
            ) : (
              hooks.map((h) => (
                <li key={h.hookId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid="webhook-row">
                  <div className="min-w-0 flex-1">
                    <p className="break-all font-mono text-dense text-anvil-800 dark:text-anvil-100">{h.url}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">
                      <span>{h.events.length === 0 ? 'all events' : h.events.join(', ')}</span>
                      <span>· relay</span>
                      <Author identityId={h.relayIdentityId} link={false} />
                      <span>· added by</span>
                      <Author identityId={h.ownerId} link={false} />
                      <span>{timeAgo(h.createdAt)}</span>
                    </p>
                  </div>
                  {maintainer && (canSeal || (identity !== null && !removalNeedsTombstone(docs.data ?? [], h.hookId, identity))) ? (
                    <Button
                      size="sm"
                      variant="danger"
                      aria-label={`Remove the webhook to ${h.url}`}
                      disabled={guard.disabledReason !== null}
                      onClick={() => {
                        if (guard.check(removeCost(h))) setRemoving(h)
                      }}
                    >
                      Remove
                    </Button>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        )}

        {shown !== null ? (
          <div role="status" className="rounded-md border border-verify/40 bg-verify/5 px-3 py-2 text-dense" data-testid="webhook-secret">
            <p className="mb-1 text-anvil-700 dark:text-anvil-200">
              Webhook to <span className="break-all font-mono">{shown.url}</span> added. Its secret, shown once: configure it at the receiver to verify
              the <span className="font-mono">X-Hub-Signature-256</span> header.
            </p>
            <SecretValue label="the webhook secret" value={shown.secret} />
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => setShown(null)}>
              Done
            </Button>
          </div>
        ) : null}

        {isPublic && maintainer ? (
          sealer.data?.kind === 'no-key' ? (
            <p className="text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="webhooks-no-key">
              Adding a webhook here (or removing one another maintainer also wrote) needs your encryption key in this browser (the secret is
              encrypted from it):{' '}
              <Link href="/settings/#enc-key-title" className="hit-area text-forge-700 underline dark:text-forge-400">
                Settings → Private repos
              </Link>
              . Or use <span className="font-mono">dg webhook add</span> with an identity file that holds it.
            </p>
          ) : sealer.data?.kind === 'unusable' ? (
            <p className="text-[12px] text-caution-700 dark:text-caution-400">
              The encryption key in this browser is no longer an enabled key of your identity. Add or replace it in{' '}
              <Link href="/settings/#enc-key-title" className="hit-area text-forge-700 underline dark:text-forge-400">
                Settings → Private repos
              </Link>
              .
            </p>
          ) : sealer.data?.kind === 'wrong-contract' ? (
            <p className="text-[12px] text-caution-700 dark:text-caution-400">
              The encryption key in this browser is bound to another contract, so it cannot seal a webhook secret. Use{' '}
              <span className="font-mono">dg webhook add</span> with an unbound encryption key.
            </p>
          ) : unlockScope === 'signing' ? (
            <UnlockMore title="Unlock this tab to add or remove webhooks" testId="webhooks-unlock" then={sealer.reload} />
          ) : sealer.error ? (
            <ErrorState message={sealer.error} onRetry={sealer.reload} />
          ) : sealer.data?.kind === 'ready' ? (
            <div className="space-y-3 border-t border-anvil-100 pt-3 dark:border-anvil-850">
              <h3 className="text-dense font-medium">Add a webhook</h3>
              <Field label="Payload URL" htmlFor="webhook-url" hint="https:// to a DNS name. Public on Platform: no tokens in it.">
                <Input id="webhook-url" className="font-mono" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://ci.example.com/forge-hook" />
              </Field>
              {urlProblem ? <p className="text-[12px] text-danger-700 dark:text-danger-400">{urlProblem}</p> : null}
              {url.includes('?') ? (
                <label className="flex items-center gap-2 text-dense coarse:min-h-11">
                  <input type="checkbox" className="h-4 w-4 accent-forge-700" checked={allowQuery} onChange={(e) => setAllowQuery(e.target.checked)} />
                  The query string holds nothing secret
                </label>
              ) : null}
              <Field label="Relay identity" htmlFor="webhook-relay" hint="The forge-relay identity that delivers; the secret is encrypted to its encryption key.">
                <Input id="webhook-relay" className="font-mono" spellCheck={false} value={relay} onChange={(e) => setRelay(e.target.value)} placeholder="base58 identity id" />
              </Field>
              {relayProblem ? <p className="text-[12px] text-danger-700 dark:text-danger-400">{relayProblem}</p> : null}
              <fieldset className="space-y-1">
                <legend className="text-dense font-medium text-anvil-700 dark:text-anvil-200">Events</legend>
                <label className="flex items-center gap-2 text-dense coarse:min-h-11">
                  <input type="radio" name="webhook-events" className="accent-forge-700" checked={allEvents} onChange={() => setAllEvents(true)} />
                  Send me everything
                </label>
                <label className="flex items-center gap-2 text-dense coarse:min-h-11">
                  <input type="radio" name="webhook-events" className="accent-forge-700" checked={!allEvents} onChange={() => setAllEvents(false)} />
                  Let me select individual events
                </label>
                {!allEvents ? (
                  <div className="flex flex-wrap gap-x-4 pl-6">
                    {WEBHOOK_EVENTS.map((e) => (
                      <label key={e} className="flex items-center gap-1.5 font-mono text-[12px] coarse:min-h-11">
                        <input type="checkbox" className="h-4 w-4 accent-forge-700" checked={events.includes(e)} onChange={(ev) => toggle(e, ev.target.checked)} />
                        {e}
                      </label>
                    ))}
                  </div>
                ) : null}
                {eventsProblem ? <p className="text-[12px] text-danger-700 dark:text-danger-400">{eventsProblem}</p> : null}
              </fieldset>
              <Button
                variant="primary"
                disabled={!canAdd || guard.disabledReason !== null}
                onClick={() => {
                  if (!guard.check(cost)) return
                  const same = pending !== null && pending.url === url.trim() && pending.relay === relay.trim() && pending.events.join(',') === chosen.join(',')
                  if (!same) setPending({ hookId: randomHookId(), url: url.trim(), events: chosen, relay: relay.trim(), secret: generateWebhookSecret() })
                  setAdding(true)
                }}
              >
                Add webhook
              </Button>
            </div>
          ) : (
            <LoadingBlock label="Checking your encryption key" />
          )
        ) : isPublic && identity !== null ? (
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Only maintainers can add or remove webhooks.</p>
        ) : null}
        {hooks.length > 0 ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{plural(hooks.length, 'webhook')}</p> : null}
      </div>
      <ConfirmDialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a webhook"
        description={`Sends ${pending === null || pending.events.length === 0 ? 'every event' : pending.events.join(', ')} to ${pending?.url ?? ''} through relay ${shortId(pending?.relay ?? '')}. The URL and events are public. The secret is encrypted to the relay.`}
        cost={cost}
        confirmLabel="Sign & add"
        onConfirm={add}
      />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove this webhook"
        description={`Deletes the webhook to ${removing?.url ?? ''}. If another maintainer's revision of it would still be in force, a disabled revision is written first so no relay delivers it again.`}
        cost={removing === null ? null : removeCost(removing)}
        confirmLabel="Sign & remove"
        onConfirm={remove}
      />
    </Section>
  )
}
