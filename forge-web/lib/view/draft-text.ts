/**
 * A composer's unsent text, kept in this browser so a reload or a closed tab does not lose it
 * (GitHub keeps comment drafts the same way). Cleared when the text is emptied (posted or
 * deleted), after two weeks, and with the identity's key ("Sign out & forget key").
 *
 * Kept per signed-in identity, so another identity in this browser never sees (or posts) it,
 * and only for public text: a private repository's text, and a public repository's members-only
 * text, is encrypted on Platform, and a plaintext copy on disk would outlive the session (no
 * members-only text at rest, DESIGN §4.1).
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const PREFIX = 'forge:draft:v1:'

/** Drafts older than this are dropped (two weeks). */
export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000

/** At most this many drafts are kept; the oldest go first. */
export const MAX_DRAFTS = 100

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * Where `viewer`'s comment draft on `targetId` is kept, or null: not kept (a private repo, a
 * members-only composer, signed out). `audience`: who the composer writes for (a members-only
 * thread's composer is members-only).
 */
export function commentDraftKey(
  repo: { readonly repoId: string; readonly visibility?: string },
  targetId: string,
  viewer: string | null,
  audience: 'public' | 'members' | 'specificPeople' = 'public',
): string | null {
  if (repo.visibility !== 'public' || audience !== 'public' || viewer === null || targetId === '') return null
  return `${viewer}:${repo.repoId}:${targetId}:comment`
}

function parse(raw: string | null): { text: string; at: number } | null {
  if (raw === null) return null
  try {
    const d = JSON.parse(raw) as { text?: unknown; at?: unknown }
    return typeof d.text === 'string' && typeof d.at === 'number' ? { text: d.text, at: d.at } : null
  } catch {
    return null
  }
}

/** The stored draft under `key`, or '' (none, expired, damaged, or no storage). */
export function readDraft(key: string, now = Date.now()): string {
  const s = store()
  if (s === null) return ''
  try {
    const d = parse(s.getItem(PREFIX + key))
    if (d === null || now - d.at > DRAFT_TTL_MS) {
      s.removeItem(PREFIX + key)
      return ''
    }
    return d.text
  } catch {
    return ''
  }
}

/** Every stored draft's storage key and time, oldest first. */
function stored(s: Storage): { key: string; at: number }[] {
  const out: { key: string; at: number }[] = []
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i)
    if (key?.startsWith(PREFIX)) out.push({ key, at: parse(s.getItem(key))?.at ?? 0 })
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * Keep `text` under `key`; an empty (whitespace-only) text removes it. Expired drafts, and the
 * oldest past {@link MAX_DRAFTS}, are dropped on the way. Storage errors are ignored.
 */
export function writeDraft(key: string, text: string, now = Date.now()): void {
  const s = store()
  if (s === null) return
  try {
    if (text.trim() === '') {
      s.removeItem(PREFIX + key)
      return
    }
    s.setItem(PREFIX + key, JSON.stringify({ text, at: now }))
    const all = stored(s)
    const extra = all.length - MAX_DRAFTS
    all.forEach((d, i) => {
      if (i < extra || now - d.at > DRAFT_TTL_MS) s.removeItem(d.key)
    })
  } catch {
    // Full or blocked: the draft lives in memory only.
  }
}

/** Remove every draft `identityId` left in this browser (its key is forgotten). */
export function clearDrafts(identityId: string): void {
  const s = store()
  if (s === null) return
  try {
    for (const d of stored(s)) if (d.key.startsWith(`${PREFIX}${identityId}:`)) s.removeItem(d.key)
  } catch {
    // Nothing more to do.
  }
}

/**
 * `useState` for a composer's text, kept under `key` (`null`: memory only). A new key (another
 * issue or PR, another identity) loads that key's draft. `hold(true, …)` takes the stored copy
 * away and stores nothing until `hold(false, text)` stores `text` again: while a post's outcome is unknown, a reload must not
 * bring back text that may already be on chain, where it would be posted twice.
 *
 * `persist` false (the composer turned members-only): the text stays in memory, and the stored
 * copy is removed at once, so no members-only text is at rest (DESIGN §4.1). Back to true, the
 * text is stored again.
 */
export function useDraftText(key: string | null, persist = true): [string, (text: string) => void, (held: boolean, text: string) => void] {
  const [state, setState] = useState<{ key: string | null; text: string }>(() => ({ key, text: key === null ? '' : readDraft(key) }))
  const held = useRef(false)
  const current = state.key === key ? state.text : key === null ? '' : readDraft(key)
  useEffect(() => {
    if (state.key !== key) {
      held.current = false
      setState({ key, text: key === null ? '' : readDraft(key) })
    }
  }, [key, state.key])
  // The audience changed: drop the stored copy, or store the text again.
  const latest = useRef(current)
  latest.current = current
  useEffect(() => {
    if (key === null || held.current) return
    writeDraft(key, persist ? latest.current : '')
  }, [key, persist])
  const set = useCallback(
    (text: string) => {
      setState({ key, text })
      if (key !== null && !held.current && persist) writeDraft(key, text)
    },
    [key, persist],
  )
  const hold = useCallback(
    (on: boolean, text: string) => {
      held.current = on
      if (key !== null) writeDraft(key, on || !persist ? '' : text)
    },
    [key, persist],
  )
  return [current, set, hold]
}
