/**
 * A composer's unsent text, kept in this browser so a reload or a closed tab does not lose it
 * (GitHub keeps comment drafts the same way). Cleared when the text is emptied (posted or
 * deleted). A private repository's drafts are never written to storage: its text is encrypted
 * on Platform, and a plaintext copy on disk would outlive the session.
 */

import { useCallback, useEffect, useState } from 'react'

const PREFIX = 'forge:draft:v1:'

/** Drafts older than this are dropped when read (two weeks). */
export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** The stored draft under `key`, or '' (none, expired, or no storage). */
export function readDraft(key: string, now = Date.now()): string {
  const s = store()
  if (s === null) return ''
  try {
    const raw = s.getItem(PREFIX + key)
    if (raw === null) return ''
    const d = JSON.parse(raw) as { text?: unknown; at?: unknown }
    if (typeof d.text !== 'string' || typeof d.at !== 'number' || now - d.at > DRAFT_TTL_MS) {
      s.removeItem(PREFIX + key)
      return ''
    }
    return d.text
  } catch {
    return ''
  }
}

/** Keep `text` under `key`; an empty (whitespace-only) text removes it. Storage errors are ignored. */
export function writeDraft(key: string, text: string, now = Date.now()): void {
  const s = store()
  if (s === null) return
  try {
    if (text.trim() === '') s.removeItem(PREFIX + key)
    else s.setItem(PREFIX + key, JSON.stringify({ text, at: now }))
  } catch {
    // Full or blocked: the draft lives in memory only.
  }
}

/**
 * `useState` for a composer's text, persisted under `key` (`null`: memory only, as for a private
 * repository). A new key (another issue or PR) loads that key's draft.
 */
export function useDraftText(key: string | null): [string, (text: string) => void] {
  const [state, setState] = useState<{ key: string | null; text: string }>(() => ({ key, text: key === null ? '' : readDraft(key) }))
  useEffect(() => {
    if (state.key !== key) setState({ key, text: key === null ? '' : readDraft(key) })
  }, [key, state.key])
  const set = useCallback(
    (text: string) => {
      setState({ key, text })
      if (key !== null) writeDraft(key, text)
    },
    [key],
  )
  return [state.key === key ? state.text : key === null ? '' : readDraft(key), set]
}
