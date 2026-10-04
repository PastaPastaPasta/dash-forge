'use client'

/**
 * Your IPFS gateways — a short list of public gateway URLs this browser tries first for every
 * `ipfs://` read (before the shared defaults). Stored in localStorage: nothing secret, and a
 * gateway only ever supplies bytes that must still match their hash.
 */

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { normalizeGateway, setUserGateways, userGateways } from '@/lib/view'

export function GatewaysField(): JSX.Element {
  const [list, setList] = useState<string[]>(() => userGateways())
  const [draft, setDraft] = useState('')
  const [bad, setBad] = useState(false)

  const save = (next: string[]): void => {
    setUserGateways(next)
    setList(userGateways())
  }
  const add = (e: React.FormEvent): void => {
    e.preventDefault()
    const url = normalizeGateway(draft)
    if (url === null) {
      setBad(true)
      return
    }
    setBad(false)
    setDraft('')
    save([...list, url])
  }

  return (
    <div className="space-y-2">
      {list.length > 0 ? (
        <ul className="space-y-1">
          {list.map((g) => (
            <li key={g} className="flex items-center gap-2 rounded border border-anvil-200 px-2 py-1 font-mono text-[12px] dark:border-anvil-750">
              <span className="min-w-0 flex-1 truncate">{g}</span>
              <button
                type="button"
                onClick={() => save(list.filter((x) => x !== g))}
                aria-label={`Remove gateway ${g}`}
                className="rounded p-0.5 text-anvil-500 hover:text-danger dark:text-anvil-400"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={add} className="flex gap-2">
        <label htmlFor="gateway-url" className="sr-only">
          IPFS gateway URL
        </label>
        <Input
          id="gateway-url"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://my-gateway.example"
          aria-invalid={bad}
          aria-describedby="gateway-hint"
          className="font-mono"
          spellCheck={false}
        />
        <Button type="submit" size="md" disabled={draft.trim() === ''}>
          <Plus className="h-4 w-4" aria-hidden /> Add
        </Button>
      </form>
      <p id="gateway-hint" className={bad ? 'text-[12px] text-danger-700 dark:text-danger-400' : 'text-[12px] text-anvil-500 dark:text-anvil-400'}>
        {bad
          ? 'That is not an https URL.'
          : 'Tried first for ipfs:// storage, before the public defaults. Saved in this browser only. Files are still verified.'}
      </p>
    </div>
  )
}
