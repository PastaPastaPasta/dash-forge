'use client'

/**
 * Messages to specific people, as people see them (DESIGN §4.2, §10, D26):
 *
 * - the people picker under "Specific people…": add someone by DPNS name or identity id; people
 *   who can't receive messages yet (no usable encryption key) are greyed with "can't receive
 *   members-only messages yet"; the writer is always on the list; in a thread its people are
 *   re-listed, someone added reads from this reply on, and leaving someone out is refused;
 * - an opened message's "Visible to alice, bob and you" (a role group's "… (maintainers when
 *   sent)"), "as listed by the sender".
 *
 * Copy follows the glossary: a "message", never a "letter".
 */

import { useState } from 'react'
import { Lock, X } from 'lucide-react'
import type { EvoSDK } from '@dashevo/evo-sdk'

import type { RepoHome } from '@/lib/view'
import type { Network } from '@/lib/constants'
import { decodeIdentifier } from '@/lib/auth/base58'
import { fetchIdentityKeys, usableEncryptionKey } from '@/lib/auth/encryption-key'
import { repoContractIds } from '@/lib/repo'
import type { LetterFacts } from '@/lib/repo/private-content'
import { MAX_LETTER_RECIPIENTS } from '@/lib/rules/letters'
import { AS_LISTED, NO_KEY_PERSON, inGroupNow, letterLabel, type LetterAsk } from '@/lib/view/audience'
import { cachedDpnsName, looksLikeDpnsName, resolveDpnsId, resolveDpnsNames } from '@/lib/view/dpns'
import { shortId, cn } from '@/lib/utils'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useThreadMembers } from '@/components/repo/author-roles'

const MUTED = 'text-anvil-500 dark:text-anvil-400'

/** Whether an identity can receive a message (a usable ENCRYPTION key for forge-core), by network, contract and id. */
const receivers = new Map<string, Promise<boolean | null>>()

/**
 * Whether `id` can receive a message to specific people in a repo of forge-core `coreId`: true
 * with a usable ENCRYPTION key, false without, null when no such identity exists. A failed read
 * is not kept.
 */
export function canReceive(sdk: EvoSDK, network: Network, coreId: string, id: string): Promise<boolean | null> {
  const key = `${network}:${coreId}:${id}`
  let hit = receivers.get(key)
  if (hit === undefined) {
    hit = fetchIdentityKeys(sdk, id).then((keys) => (keys === null ? null : usableEncryptionKey(keys, coreId) !== null))
    receivers.set(key, hit)
    hit.catch(() => receivers.delete(key))
  }
  return hit
}

const EMPTY: ReadonlySet<string> = new Set()

/** The people of `ids` with no usable encryption key (read once each), and whether all were read. */
export function useKeyless(repo: RepoHome['repo'] | null, ids: readonly string[], enabled: boolean): { keyless: ReadonlySet<string>; ready: boolean } {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const sorted = [...new Set(ids)].sort()
  const core = repo?.forge.core ?? ''
  const read = useAsync(
    async () => {
      const out = new Set<string>()
      await Promise.all(
        sorted.map(async (id) => {
          if ((await canReceive(sdk!, network, core, id).catch(() => true)) !== true) out.add(id)
        }),
      )
      return out
    },
    [ready, network, core, sorted.join(',')],
    { enabled: enabled && repo !== null && ready && sdk !== null && sorted.length > 0 },
  )
  return { keyless: read.data ?? EMPTY, ready: sorted.length === 0 || read.data !== null }
}

/** A display name for each of `ids`: its DPNS label (read for the page), else a short id. */
export function useNames(ids: readonly string[]): (id: string) => string {
  const { sdk, ready, network } = useSdk()
  const sorted = [...new Set(ids)].sort()
  const read = useAsync(() => resolveDpnsNames(sdk!, sorted, network), [ready, network, sorted.join(',')], { enabled: ready && sdk !== null && sorted.length > 0 })
  return (id) => {
    const name = read.data?.get(id) ?? cachedDpnsName(network, id)
    return name ? name.replace(/\.dash$/, '') : shortId(id)
  }
}

/** Someone named in the people picker, as resolved: an identity id, one who can't receive messages yet, or why not. */
type Resolved = { readonly id: string } | { readonly greyed: string } | { readonly error: string }

/** `input` (`@alice`, `alice.dash`, or a base58 identity id) as an identity that can receive a message. */
async function resolvePerson(sdk: EvoSDK, network: Network, coreId: string, input: string): Promise<Resolved> {
  const raw = input.trim().replace(/^@/, '')
  if (raw === '') return { error: 'Type a name or an identity id.' }
  let id: string | null = null
  try {
    if (decodeIdentifier(raw).length === 32) id = raw
  } catch {
    id = null
  }
  if (id === null) {
    if (!looksLikeDpnsName(raw) && !looksLikeDpnsName(`${raw}.dash`)) return { error: `No one is called @${raw}.` }
    id = await resolveDpnsId(sdk, raw.includes('.') ? raw : `${raw}.dash`, network)
    if (id === null) return { error: `No one is called @${raw}.` }
  }
  const can = await canReceive(sdk, network, coreId, id)
  if (can === null) return { error: `No identity ${shortId(id)} on this network.` }
  if (!can) return { greyed: id }
  return { id }
}

/**
 * The people a message goes to, editable (DESIGN §10 "Specific people…"): the writer first and
 * fixed, then everyone named. `people`: the list without the writer; `onChange` gets the new one.
 * In a thread the list starts as its people re-listed; leaving one of them out is refused by the
 * plan, which the composer says under the editor.
 */
export function PeoplePicker({
  home,
  viewer,
  people,
  onChange,
}: {
  home: RepoHome
  viewer: string
  people: readonly string[]
  onChange: (people: string[]) => void
}): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [greyed, setGreyed] = useState<string[]>([])
  const nameOf = useNames([viewer, ...people, ...greyed])
  const full = 1 + people.length >= MAX_LETTER_RECIPIENTS
  const add = async (): Promise<void> => {
    if (!ready || sdk === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await resolvePerson(sdk, network, home.repo.forge.core, text)
      if ('id' in r) {
        if (r.id !== viewer && !people.includes(r.id)) onChange([...people, r.id])
        setText('')
      } else if ('greyed' in r) {
        const g = r.greyed
        setGreyed((was) => (was.includes(g) ? was : [...was, g]))
        setText('')
      } else setError(r.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-2 space-y-2" data-testid="people-picker">
      <ul className="flex flex-wrap gap-1" aria-label="People it goes to">
        <li className="inline-flex items-center gap-1 rounded-full bg-anvil-100 px-2 py-0.5 text-[12px] dark:bg-anvil-800" data-testid="people-picker-you">
          {nameOf(viewer)} (you)
        </li>
        {people.map((p) => (
          <li key={p} className="inline-flex items-center gap-1 rounded-full bg-anvil-100 px-2 py-0.5 text-[12px] dark:bg-anvil-800" data-testid="people-picker-person" data-id={p}>
            {nameOf(p)}
            <button type="button" className="hit-area rounded-full hover:text-danger-700" aria-label={`Remove ${nameOf(p)}`} onClick={() => onChange(people.filter((x) => x !== p))}>
              <X className="h-3 w-3" aria-hidden />
            </button>
          </li>
        ))}
        {greyed.map((g) => (
          <li key={g} className={cn('inline-flex items-center gap-1 rounded-full border border-dashed border-anvil-300 px-2 py-0.5 text-[12px] dark:border-anvil-700', MUTED)} data-testid="people-picker-no-key" data-id={g}>
            {nameOf(g)} · {NO_KEY_PERSON}
          </li>
        ))}
      </ul>
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={full ? `At most ${MAX_LETTER_RECIPIENTS} people` : '@name or identity id'}
          aria-label="Add someone"
          disabled={full}
          spellCheck={false}
          className="h-8 text-[12px]"
          data-testid="people-picker-input"
        />
        <Button type="submit" size="sm" variant="outline" disabled={full || busy || text.trim() === ''} data-testid="people-picker-add">
          Add
        </Button>
      </form>
      {error !== null ? (
        <p className="text-[12px] text-danger-700 dark:text-danger-400" role="alert" data-testid="people-picker-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The tinted label of an opened message to specific people: "Visible to alice, bob and you", a
 * role group's "Visible to alice, bob, carol (maintainers when sent)", as listed by its sender.
 * Whether its writer is in the group now comes from the page's members (`AuthorRolesProvider`).
 */
export function VisibleToPeople({ letter, what }: { letter: LetterFacts; what?: 'review' }): JSX.Element {
  const { identity } = useAuth()
  const nameOf = useNames(letter.recipients)
  const thread = useThreadMembers()
  const writer = letter.recipients[0] ?? ''
  const writerInGroup = letter.group !== null && thread !== null && inGroupNow(letter.group, writer, thread.owner, thread.members)
  const label = letterLabel({ letter, viewer: identity, nameOf, writerInGroup })
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-anvil-100 px-2 py-0.5 text-[11px] font-medium text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200"
      data-testid="visible-to-people"
      data-group={letter.group ?? ''}
      title={AS_LISTED}
    >
      <Lock className="h-3 w-3" aria-hidden /> {what === 'review' ? 'Review text visible to' : 'Visible to'} {label}
    </span>
  )
}

/** The people a letter-thread reply's picker starts from: everyone the plan re-lists, or the picker's own list. */
export function letterPeople(ask: LetterAsk, relisted: readonly string[]): readonly string[] {
  return ask.exact ?? (ask.group === null && ask.people.length === 0 ? relisted : ask.people)
}

/**
 * "Forward to…" on an opened message to specific people (DESIGN D26): a reply in the same thread
 * starting with the quoted text, its people re-listed so more can be added (never fewer).
 */
export function ForwardButton({ onForward }: { onForward: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onForward}
      className="hit-area text-[12px] font-medium text-forge-700 hover:underline dark:text-forge-400"
      data-testid="forward"
    >
      Forward to…
    </button>
  )
}
