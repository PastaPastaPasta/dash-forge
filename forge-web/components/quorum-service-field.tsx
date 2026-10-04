'use client'

/**
 * Settings → Quorum service: where this browser fetches the quorum keys every proof is checked
 * against (`lib/quorum-url.ts`). The connection reads it once, so saving reloads the page. A
 * typed URL is asked for its quorum list first, so a typo can't stop every read.
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ACTIVE_NETWORK, defaultQuorumEndpoint } from '@/lib/constants'
import { normalizeQuorumUrl, setUserQuorumUrl, userQuorumUrl } from '@/lib/quorum-url'
import { probeQuorumService } from '@/lib/view'

type Status = { kind: 'idle' } | { kind: 'checking' } | { kind: 'error'; message: string }

export function QuorumServiceField({ reload = () => window.location.reload() }: { reload?: () => void }): JSX.Element {
  const networkKey = ACTIVE_NETWORK.key
  const fallback = defaultQuorumEndpoint(ACTIVE_NETWORK)
  const [chosen] = useState(() => userQuorumUrl(networkKey))
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const url = normalizeQuorumUrl(draft)
    if (url === null) {
      setStatus({ kind: 'error', message: 'Enter an https URL, such as https://quorums.example.org.' })
      return
    }
    setStatus({ kind: 'checking' })
    try {
      await probeQuorumService(url)
    } catch {
      setStatus({ kind: 'error', message: `${url} didn't answer with a list of quorum keys. Nothing was changed.` })
      return
    }
    setUserQuorumUrl(networkKey, url)
    reload()
  }
  const useDefault = (): void => {
    setUserQuorumUrl(networkKey, null)
    reload()
  }

  const error = status.kind === 'error'
  return (
    <div className="space-y-3">
      <p className="text-dense text-anvil-600 dark:text-anvil-300">
        Every read is checked against quorum keys from this service. If the default is down or blocked where you are, use
        one you or someone you trust runs.
      </p>
      <div className="flex items-center justify-between gap-3 rounded border border-anvil-200 px-2 py-1.5 dark:border-anvil-750">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" data-testid="quorum-service-current">
          {chosen ?? fallback}
        </span>
        {chosen !== null ? (
          <button type="button" onClick={useDefault} className="hit-area shrink-0 text-dense text-forge-700 underline dark:text-forge-400">
            Use the default
          </button>
        ) : (
          <span className="shrink-0 text-[12px] text-anvil-500 dark:text-anvil-400">Default</span>
        )}
      </div>
      <form onSubmit={(e) => void save(e)} className="flex gap-2">
        <label htmlFor="quorum-service-url" className="sr-only">
          Quorum service URL
        </label>
        <Input
          id="quorum-service-url"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setStatus({ kind: 'idle' })
          }}
          placeholder="https://quorums.example.org"
          aria-invalid={error}
          aria-describedby="quorum-service-hint"
          className="font-mono"
          spellCheck={false}
        />
        <Button type="submit" size="md" disabled={draft.trim() === '' || status.kind === 'checking'}>
          {status.kind === 'checking' ? 'Checking…' : 'Use'}
        </Button>
      </form>
      <p
        id="quorum-service-hint"
        role={error ? 'alert' : undefined}
        className={error ? 'text-[12px] text-danger-700 dark:text-danger-400' : 'text-[12px] text-anvil-500 dark:text-anvil-400'}
      >
        {error
          ? status.message
          : 'Saved in this browser only, and the page reloads to use it. Repository pages still compare its keys with a Platform node’s.'}
      </p>
    </div>
  )
}
