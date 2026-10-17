/**
 * The diff composers' unsent text, kept above the diff (#560). Switching Split/Unified, or the
 * window crossing the phone breakpoint, rebuilds the diff's rows and with them every composer
 * under them; their text, tab, open state and in-flight post live here instead, keyed by the
 * composer (the PR and the selected lines, or the PR and a thread's root). Memory only, never on
 * disk, so nothing members-only is at rest (DESIGN §4.1).
 *
 * A plain external store (`subscribe` / `version`, for `useSyncExternalStore`): a composer that
 * was rebuilt while its post was in flight still hears how that post ended.
 */

export type DraftTab = 'write' | 'preview'

export interface UnsentDraft {
  readonly body: string
  readonly tab: DraftTab
}

export class UnsentDrafts {
  private readonly drafts = new Map<string, UnsentDraft>()
  private readonly opened = new Set<string>()
  private readonly sending = new Set<string>()
  private readonly errors = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private stamp = 0

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Changes on every mutation. */
  readonly version = (): number => this.stamp

  private changed(): void {
    this.stamp += 1
    for (const l of [...this.listeners]) l()
  }

  read(key: string): UnsentDraft | undefined {
    return this.drafts.get(key)
  }

  /** Merge `patch` into `key`'s draft; a draft with no text is dropped. */
  write(key: string, patch: { body?: string; tab?: DraftTab }): void {
    const prev = this.drafts.get(key)
    const next = { body: patch.body ?? prev?.body ?? '', tab: patch.tab ?? prev?.tab ?? 'write' }
    if (prev !== undefined && prev.body === next.body && prev.tab === next.tab) return
    if (next.body === '') {
      if (prev === undefined) return
      this.drafts.delete(key)
    } else this.drafts.set(key, next)
    this.changed()
  }

  /** Forget `key`'s draft (posted, added to the review, or cancelled). */
  clear(key: string): void {
    if (this.drafts.delete(key) || this.errors.delete(key)) this.changed()
  }

  /** Whether the reply under `key` is open (it may have no text yet). */
  isOpen(key: string): boolean {
    return this.opened.has(key)
  }

  /** Open or close a reply; closing drops its draft. */
  setOpen(key: string, on: boolean): void {
    if (on) {
      if (this.opened.has(key)) return
      this.opened.add(key)
    } else {
      const had = this.opened.delete(key)
      const drafted = this.drafts.delete(key)
      const erred = this.errors.delete(key)
      if (!had && !drafted && !erred) return
    }
    this.changed()
  }

  /** Whether a post from the composer under `key` has not ended yet. */
  isSending(key: string): boolean {
    return this.sending.has(key)
  }

  setSending(key: string, on: boolean): void {
    if (on === this.sending.has(key)) return
    if (on) this.sending.add(key)
    else this.sending.delete(key)
    this.changed()
  }

  error(key: string): string | undefined {
    return this.errors.get(key)
  }

  setError(key: string, message: string | null): void {
    if (message === null) {
      if (this.errors.delete(key)) this.changed()
    } else if (this.errors.get(key) !== message) {
      this.errors.set(key, message)
      this.changed()
    }
  }

  /** A selection grew (shift-click): its draft follows it to the new key. */
  move(from: string, to: string): void {
    const d = this.drafts.get(from)
    if (d === undefined || from === to) return
    this.drafts.delete(from)
    this.drafts.set(to, d)
    this.changed()
  }

  /** Drop every draft under `prefix` but the one at `keep` (the line composer: one selection at a time). */
  retain(prefix: string, keep: string | null): void {
    let any = false
    for (const k of [...this.drafts.keys()]) {
      if (k.startsWith(prefix) && k !== keep) {
        this.drafts.delete(k)
        any = true
      }
    }
    if (any) this.changed()
  }
}
