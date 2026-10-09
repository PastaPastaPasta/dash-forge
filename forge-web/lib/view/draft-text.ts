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

/**
 * Where `viewer`'s comment draft on `targetId` is kept, or null: not kept (a private repo, a
 * members-only composer, signed out). `audience`: who the composer writes for (a members-only
 * thread's composer is members-only); required, so no caller can default a members-only one to
 * a stored draft.
 */
export function commentDraftKey(
  repo: { readonly repoId: string; readonly visibility?: string },
  targetId: string,
  viewer: string | null,
  audience: 'public' | 'members' | 'specificPeople',
): string | null {
  if (repo.visibility !== 'public' || audience !== 'public' || viewer === null || targetId === '') return null
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
 * Whether a composer's text may be kept on disk: a fixed answer, or one decided from the text
 * itself (a public draft that quotes members-only text may not, DESIGN §4.1).
 */
export type DraftPersist = boolean | ((text: string) => boolean)

/**
 * `useState` for a composer's text, kept under `key` (`null`: memory only). A new key (another
 * issue or PR, another identity) loads that key's draft. `hold(true, …)` takes the stored copy
 * away and stores nothing until `hold(false, text)` stores `text` again: while a post's outcome is unknown, a reload must not
 * bring back text that may already be on chain, where it would be posted twice.
 *
 * `persist`: whether the text may be stored. False (the composer turned members-only), or a
 * predicate that says no for the new text (it quotes members-only text): the text stays in
 * memory, and any stored copy is removed in the same call that sets it, before any render, so
 * no members-only text is at rest (DESIGN §4.1). Once refused, the draft stays in memory until
 * it is emptied (posted or deleted) or the key changes: the answer can flip back to yes without
 * the text changing (a locked tab forgets the members-only text it compared against), and the
 * quoting text must not land on disk then.
 */
export function useDraftText(key: string | null, persist: DraftPersist = true): [string, (text: string) => void, (held: boolean, text: string) => void] {
  const [state, setState] = useState<{ key: string | null; text: string }>(() => ({ key, text: key === null ? '' : readDraft(key) }))
  const held = useRef(false)
  const current = state.key === key ? state.text : key === null ? '' : readDraft(key)
  useEffect(() => {
    if (state.key !== key) {
      held.current = false
      setState({ key, text: key === null ? '' : readDraft(key) })
    }
  }, [key, state.key])
  // The latest rule, read by the setter when it is called (never a stale render's).
  const rule = useRef(persist)
  rule.current = persist
  // Set once this key's text was refused; cleared only when the text is emptied or the key changes.
  const refused = useRef<{ key: string | null; on: boolean }>({ key, on: false })
  const allowed = useCallback(
    (text: string): boolean => {
      if (refused.current.key !== key) refused.current = { key, on: false }
      if (text.trim() === '') {
        refused.current.on = false
        return true
      }
      const r = rule.current
      if (!(typeof r === 'function' ? r(text) : r)) refused.current.on = true
      return !refused.current.on
    },
    [key],
  )
  // Whether the current text may be stored: it changes with the audience, or with what the page
  // shows (members-only text read after the draft was typed). Then drop the stored copy.
  const keep = allowed(current)
  const latest = useRef(current)
  latest.current = current
  useEffect(() => {
    if (key === null || held.current) return
    writeDraft(key, keep ? latest.current : '')
  }, [key, keep])
  const set = useCallback(
    (text: string) => {
      setState({ key, text })
      if (key !== null && !held.current) writeDraft(key, allowed(text) ? text : '')
    },
    [key, allowed],
  )
  const hold = useCallback(
    (on: boolean, text: string) => {
      held.current = on
      if (key !== null) writeDraft(key, on || !allowed(text) ? '' : text)
    },
    [key, allowed],
  )
  return [current, set, hold]
}

/**
 * Whether a form's text quoted members-only text (`quotesNow`) at any point since it was last
 * `empty`: the answer can flip back to no without the text changing (a locked tab forgets the
 * members-only text it compared against), and a quoting draft must stay in memory then.
 */
export function useQuotedUntilEmptied(quotesNow: boolean, empty: boolean): boolean {
  const [quoted, setQuoted] = useState(false)
  if (quotesNow && !quoted) setQuoted(true)
  else if (empty && quoted) setQuoted(false)
  return quotesNow || (quoted && !empty)
}

/** {@link DraftPersist} for a structured draft: a fixed answer, or one decided from the value. */
export type DraftValuePersist<T> = boolean | ((value: T) => boolean)

/**
 * {@link useDraftText} for a structured value (its `hold` the same: nothing stored while a write's
 * outcome is unknown) (an edit's title and body, with the revision it
 * started from), kept as JSON under `key`. A stored value `valid` rejects (the document changed
 * since the edit started, the comment is gone) reads as none and is dropped, so an old edit never
 * resurrects over a newer saved version. `null` removes it. `persist` as in {@link useDraftText},
 * judged on the value: one it refuses (members-only, or quoting members-only text) stays in memory.
 */
export function useDraftState<T>(
  key: string | null,
  valid: (value: T) => boolean,
  persist: DraftValuePersist<T> = true,
): [T | null, (value: T | null) => void, (held: boolean, value: T | null) => void, T | null] {
  const [text, setText, holdText] = useDraftText(key, typeof persist === 'function' ? (t) => persistJson(t, persist) : persist)
  // The stored value dropped as stale in this mount, if any (the page says so, where it was).
  const [dropped, setDropped] = useState<T | null>(null)
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
  const staleValue = useRef<T | null>(null)
  staleValue.current = stale ? value : null
  useEffect(() => {
    if (stale) {
      setDropped(staleValue.current)
      setText('')
    }
  }, [stale, setText])
  const set = useCallback((v: T | null) => setText(v === null ? '' : JSON.stringify(v)), [setText])
  const hold = useCallback((on: boolean, v: T | null) => holdText(on, v === null ? '' : JSON.stringify(v)), [holdText])
  return [stale ? null : value, set, hold, dropped]
}

/** Whether a stored structured draft's JSON may stay on disk (unreadable JSON: no). */
function persistJson<T>(text: string, persist: (value: T) => boolean): boolean {
  try {
    return persist(JSON.parse(text) as T)
  } catch {
    return false
  }
}

/**
 * An edit box's draft ({@link useDraftState}): the edit in progress, stored only while it differs
 * from the saved document (`changed`), so opening Edit and leaving stores nothing. `dropped`: a
 * stored edit was discarded because the document changed since it started. `persist`: as in
 * {@link useDraftState} (a members-only document's edit, or one quoting members-only text, is
 * never stored).
 */
export function useEditDraft<T>(
  key: string | null,
  valid: (value: T) => boolean,
  changed: (value: T) => boolean,
  persist: DraftValuePersist<T> = true,
): {
  readonly value: T | null
  readonly set: (value: T | null) => void
  readonly dropped: boolean
  /** The edit that was discarded, while {@link dropped} (to say where it was), else null. */
  readonly droppedValue: T | null
  /**
   * Run the edit's save: the stored copy is held away while it runs (a reload must neither save
   * it twice nor call the user's own landed save "discarded"), cleared once it lands, and kept
   * again only when the save is known not to have been sent.
   */
  readonly saving: <R>(write: () => Promise<R>) => Promise<R>
} {
  const [stored, store, hold, droppedStored] = useDraftState<T>(key, valid, persist)
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
      // A write that may have landed: its text is the user's own, so a later revision is no
      // discarded draft. A write known not to have landed keeps its draft, still judged as one.
      if (e instanceof UnconfirmedWriteError) setSeen(true)
      else hold(false, keep(v))
      throw e
    }
  }
  const droppedValue = seen ? null : droppedStored
  return { value, set, dropped: droppedValue !== null, droppedValue, saving }
}

/**
 * Where a page says a stored edit was discarded (Q5-A11). The description box names what was
 * discarded (the description's edit, a comment's, or both), so it never reads as the
 * description's when it was a comment's; `atComment` also marks the comment itself, while it is
 * in the thread (a hidden or folded comment may not show it, so the box always says it too).
 */
export function discardedEdits(description: boolean, comment: { readonly id: string } | null, commentIds: readonly string[]): { readonly atComment: string | null; readonly boxNote: string | null } {
  const atComment = comment !== null && commentIds.includes(comment.id) ? comment.id : null
  const boxNote =
    description && comment !== null
      ? 'Your unsaved edits of the description and of a comment were discarded: they changed on Platform since you started.'
      : description
        ? 'Your unsaved edit of the description was discarded: it changed on Platform since you started.'
        : comment !== null
          ? 'Your unsaved edit of a comment was discarded: the comment changed on Platform since you started.'
          : null
  return { atComment, boxNote }
}

/** The mark at a comment whose stored edit was discarded ({@link discardedEdits}). */
export const DISCARDED_COMMENT_EDIT = 'Your unsaved edit of this comment was discarded.'
