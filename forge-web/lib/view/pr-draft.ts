/**
 * The new-PR form's draft, kept for this tab so a sign-in in between does not lose it. A private
 * repo's draft holds its decrypted branch names, title and body: it lives in this page's memory
 * only (never sessionStorage, which outlives a locked vault or an identity switch in the tab),
 * and is dropped when private sessions end (lock, sign-out, identity or key change). So does a
 * public repo's draft that quotes members-only text (`memoryOnly`, DESIGN §4.1).
 */

import { onPrivateSessionsClosed } from '../repo/private-session'

export interface PrDraft {
  readonly title: string
  readonly body: string
  readonly head: string
  readonly base: string
}

type RepoLike = { readonly repoId: string; readonly visibility: string }

const privateDrafts = new Map<string, PrDraft>()
onPrivateSessionsClosed(() => privateDrafts.clear())

function draftKey(repoId: string): string {
  return `forge.pr-draft.${repoId}`
}

/**
 * Keep `d` as the draft of `repo`: in this page's memory for a private repo, or when
 * `opts.memoryOnly` (its text quotes members-only text), its stored copy then removed; else in
 * sessionStorage.
 */
export function savePrDraft(repo: RepoLike, d: PrDraft, opts: { readonly memoryOnly?: boolean } = {}): void {
  if (repo.visibility === 'private' || opts.memoryOnly === true) {
    privateDrafts.set(draftKey(repo.repoId), d)
    if (repo.visibility !== 'private') removeStored(repo.repoId)
    return
  }
  privateDrafts.delete(draftKey(repo.repoId))
  try {
    window.sessionStorage.setItem(draftKey(repo.repoId), JSON.stringify(d))
  } catch {
    /* no sessionStorage (private mode, SSR) */
  }
}

function removeStored(repoId: string): void {
  try {
    window.sessionStorage.removeItem(draftKey(repoId))
  } catch {
    /* no sessionStorage */
  }
}

/** Forget the draft of `repo`. */
export function dropPrDraft(repo: RepoLike): void {
  privateDrafts.delete(draftKey(repo.repoId))
  removeStored(repo.repoId)
}

/** The draft of `repo`, if any (a memory-only one first). */
export function loadPrDraft(repo: RepoLike): PrDraft | null {
  const memory = privateDrafts.get(draftKey(repo.repoId))
  if (repo.visibility === 'private' || memory !== undefined) return memory ?? null
  try {
    const raw = window.sessionStorage.getItem(draftKey(repo.repoId))
    if (raw === null) return null
    const d = JSON.parse(raw) as Partial<PrDraft>
    return { title: String(d.title ?? ''), body: String(d.body ?? ''), head: String(d.head ?? ''), base: String(d.base ?? '') }
  } catch {
    return null
  }
}
