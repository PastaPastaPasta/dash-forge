/**
 * A composer's unsent text, kept in this browser so a reload or a closed tab does not lose it
 * (GitHub keeps comment drafts the same way). Cleared when the text is emptied (posted or
 * deleted), after two weeks, and with the identity's key ("Sign out & forget key").
 *
 * Kept per signed-in identity, so another identity in this browser never sees (or posts) it,
 * and only for public repositories: a private repository's text is encrypted on Platform, and a
 * plaintext copy on disk would outlive the session.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { UnconfirmedWriteError } from '../sdk'

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

/** Where `viewer`'s comment draft on `targetId` is kept, or null: not kept (a private repo, signed out). */
export function commentDraftKey(repo: { readonly repoId: string; readonly visibility?: string }, targetId: string, viewer: string | null): string | null {
  if (repo.visibility !== 'public' || viewer === null || targetId === '') return null
  return `${viewer}:${repo.repoId}:${targetId}:comment`
}

type DraftRepo = { readonly repoId: string; readonly visibility?: string }

/** Where `viewer`'s draft `what` of `targetId` is kept, or null (a private repo, signed out). */
function draftKeyOf(repo: DraftRepo, targetId: string, viewer: string | null, what: string): string | null {
  if (repo.visibility !== 'public' || viewer === null || targetId === '') return null
  return `${viewer}:${repo.repoId}:${targetId}:${what}`
}

/** `viewer`'s unsaved edit of an issue's or PR's title and description. */
export function editDraftKey(repo: DraftRepo, targetId: string, viewer: string | null): string | null {
  return draftKeyOf(repo, targetId, viewer, 'edit')
}

/** `viewer`'s unsaved edit of one of their comments on `targetId` (one at a time, as the page edits them). */
export function commentEditDraftKey(repo: DraftRepo, targetId: string, viewer: string | null): string | null {
  return draftKeyOf(repo, targetId, viewer, 'comment-edit')
}

/** `viewer`'s new issue in `repo` (its title and description). */
export function newIssueDraftKey(repo: DraftRepo, viewer: string | null): string | null {
  return draftKeyOf(repo, 'new', viewer, 'issue')
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
 */
export function useDraftText(key: string | null): [string, (text: string) => void, (held: boolean, text: string) => void] {
  const [state, setState] = useState<{ key: string | null; text: string }>(() => ({ key, text: key === null ? '' : readDraft(key) }))
  const held = useRef(false)
  const current = state.key === key ? state.text : key === null ? '' : readDraft(key)
  useEffect(() => {
    if (state.key !== key) {
      held.current = false
      setState({ key, text: key === null ? '' : readDraft(key) })
    }
  }, [key, state.key])
  const set = useCallback(
    (text: string) => {
      setState({ key, text })
      if (key !== null && !held.current) writeDraft(key, text)
    },
    [key],
  )
  const hold = useCallback(
    (on: boolean, text: string) => {
      held.current = on
      if (key !== null) writeDraft(key, on ? '' : text)
    },
    [key],
  )
  return [current, set, hold]
}

/**
 * {@link useDraftText} for a structured value (its `hold` the same: nothing stored while a write's
 * outcome is unknown) (an edit's title and body, with the revision it
 * started from), kept as JSON under `key`. A stored value `valid` rejects (the document changed
 * since the edit started, the comment is gone) reads as none and is dropped, so an old edit never
 * resurrects over a newer saved version. `null` removes it.
 */
export function useDraftState<T>(key: string | null, valid: (value: T) => boolean): [T | null, (value: T | null) => void, (held: boolean, value: T | null) => void, boolean] {
  const [text, setText, holdText] = useDraftText(key)
  // A stored value dropped as stale in this mount (the page says so).
  const [dropped, setDropped] = useState(false)
  const validRef = useRef(valid)
  validRef.current = valid
  let value: T | null = null
  if (text !== '') {
    try {
      value = JSON.parse(text) as T
    } catch {
      value = null
    }
  }
  const stale = value !== null && !valid(value)
  useEffect(() => {
    if (stale) {
      setText('')
      setDropped(true)
    }
  }, [stale, setText])
  const set = useCallback((v: T | null) => setText(v === null ? '' : JSON.stringify(v)), [setText])
  const hold = useCallback((on: boolean, v: T | null) => holdText(on, v === null ? '' : JSON.stringify(v)), [holdText])
  return [stale ? null : value, set, hold, dropped]
}

/**
 * An edit box's draft ({@link useDraftState}): the edit in progress, stored only while it differs
 * from the saved document (`changed`), so opening Edit and leaving stores nothing. `dropped`: a
 * stored edit was discarded because the document changed since it started.
 */
export function useEditDraft<T>(
  key: string | null,
  valid: (value: T) => boolean,
  changed: (value: T) => boolean,
): {
  readonly value: T | null
  readonly set: (value: T | null) => void
  readonly dropped: boolean
  /**
   * Run the edit's save: the stored copy is held away while it runs (a reload must neither save
   * it twice nor call the user's own landed save "discarded"), cleared once it lands, and kept
   * again only when the save is known not to have been sent.
   */
  readonly saving: <R>(write: () => Promise<R>) => Promise<R>
} {
  const [stored, store, hold, droppedStored] = useDraftState<T>(key, valid)
  const [local, setLocal] = useState<{ readonly key: string | null; readonly value: T | null } | null>(null)
  // The "discarded" note goes once the user edits again.
  const [seen, setSeen] = useState(false)
  const value = local !== null && local.key === key ? local.value : stored
  const keep = (v: T | null): T | null => (v !== null && changed(v) ? v : null)
  const set = (v: T | null): void => {
    setLocal({ key, value: v })
    setSeen(true)
    store(keep(v))
  }
  const saving = async <R,>(write: () => Promise<R>): Promise<R> => {
    const v = value
    hold(true, null)
    try {
      const r = await write()
      hold(false, null)
      return r
    } catch (e) {
      if (!(e instanceof UnconfirmedWriteError)) hold(false, keep(v))
      throw e
    }
  }
  return { value, set, dropped: droppedStored && !seen, saving }
}
