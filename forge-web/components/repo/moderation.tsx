'use client'

/**
 * Maintainer moderation in the page (RC2 MOD): GitHub's "Hide" menu on a comment or review, the
 * collapsed "hidden by a maintainer" row readers see (and can expand: nothing is deleted, and it is
 * public on Platform anyway), and the banner of a hidden issue or PR.
 */

import { useMemo, useRef, useState } from 'react'
import { ChevronDown, Eye, EyeOff } from 'lucide-react'

import { Author } from '@/components/author'
import { useDismiss } from '@/components/repo/target-rail'
import { HIDE_REASONS, type Hidden, type HiddenItems, type HideBlock, type HideReason } from '@/lib/rules/moderation'
import { banHidden, banReasonLabel } from '@/lib/rules/bans'
import { readBans, readStandingBans } from '@/lib/repo/bans'
import { foldModeration, withBans, type ModerationInput } from '@/lib/repo/moderation-fold'
import { timeAgo } from '@/lib/view'
import type { EvoSDK } from '@dashevo/evo-sdk'
import { useAsync } from '@/hooks/use-async'
import { hiddenRowIds, hiddenThreadIds, type HideableRow } from '@/lib/repo/moderation'
import { repoKey, type RepoRef } from '@/lib/repo'
import type { Network } from '@/lib/constants'
import { previewCredits, withAddressee, type CostPreview, type FirstWrite } from '@/lib/sdk'
import { estimateBytesCredits } from '@/lib/sdk/cost'
import { composeCost } from '@/components/repo/private-compose'

/** GitHub's words for each reason. */
export const HIDE_REASON_LABEL: Readonly<Record<HideReason, string>> = {
  spam: 'Spam',
  abuse: 'Abuse',
  'off-topic': 'Off-topic',
  outdated: 'Outdated',
  resolved: 'Resolved',
  duplicate: 'Duplicate',
}

/** Why a maintainer's Hide / Unhide is not offered (null: say nothing, the menu just shows the other action). */
const BLOCKED_NOTE: Readonly<Record<HideBlock, string | null>> = {
  ownersContent: 'The repository owner wrote this: only the owner can hide it.',
  ownerDecided: 'The repository owner already hid or unhid this, and readers follow the owner.',
  withItsReview: 'Hidden with its review: unhide the review to show it.',
  alreadyHidden: null,
  notHidden: null,
}

/** "as spam", or '' for a hide with no reason. */
export function reasonWords(reason: HideReason | null): string {
  return reason === null ? '' : ` as ${HIDE_REASON_LABEL[reason].toLowerCase()}`
}

/** A ban's reason, " (spam)", or '' for none. */
export function banWords(hidden: Hidden): string {
  const r = banReasonLabel(hidden.banReason)
  return r === null ? '' : ` (${r})`
}

/**
 * A maintainer's Hide / Unhide on a comment or review header. Hide opens the reasons; Unhide
 * writes at once (through the page's confirm). `blocked`: why the write would change nothing
 * (`moderationBlocked`: the owner's content or decision, an inline comment hidden with its
 * review), shown instead of the action.
 */
export function HideMenu({
  hidden,
  onHide,
  onUnhide,
  disabled,
  what = 'comment',
  blocked = null,
  byBan = false,
}: {
  hidden: boolean
  onHide: (reason: HideReason | null) => void
  onUnhide: () => void
  disabled: boolean
  what?: 'comment' | 'review'
  blocked?: HideBlock | null
  /** Only its writer's ban collapses it: a hide then keeps it hidden after the ban is lifted. */
  byBan?: boolean
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useDismiss(open, ref, () => setOpen(false))
  const button = 'inline-flex items-center gap-1 text-[12px] text-anvil-500 hover:text-forge-700 disabled:opacity-50 dark:text-anvil-400 dark:hover:text-forge-400 coarse:min-h-11 coarse:px-1'
  if (blocked !== null) {
    const note = BLOCKED_NOTE[blocked]
    return note === null ? null : (
      <span className="text-[12px] text-anvil-500 dark:text-anvil-400" title={note} data-testid="hide-blocked" data-why={blocked}>
        <EyeOff className="inline h-3 w-3" aria-hidden /> {blocked === 'withItsReview' ? 'Hidden with its review' : "Owner's call"}
      </span>
    )
  }
  if (hidden) {
    return (
      <button type="button" className={button} onClick={onUnhide} disabled={disabled} aria-label={`Unhide ${what}`} data-testid="unhide-item">
        <Eye className="h-3 w-3" aria-hidden /> Unhide
      </button>
    )
  }
  return (
    <span className="relative inline-flex" ref={ref}>
      <button type="button" className={button} onClick={() => setOpen((o) => !o)} disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-label={`Hide ${what}`} data-testid="hide-item">
        <EyeOff className="h-3 w-3" aria-hidden /> Hide <ChevronDown className="h-3 w-3" aria-hidden />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-anvil-200 bg-white p-1 text-dense shadow-lg dark:border-anvil-750 dark:bg-anvil-950">
          <p className="px-2 py-1 text-[12px] text-anvil-500 dark:text-anvil-400">Hide this {what} from readers{byBan ? ', even after the ban is lifted' : ''}. Nothing is deleted: anyone can still expand it.</p>
          {HIDE_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              role="menuitem"
              data-reason={r}
              className="block w-full rounded px-2 py-1.5 text-left hover:bg-anvil-50 coarse:min-h-11 dark:hover:bg-anvil-900"
              onClick={() => {
                setOpen(false)
                onHide(r)
              }}
            >
              {HIDE_REASON_LABEL[r]}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            data-reason="none"
            className="block w-full rounded px-2 py-1.5 text-left text-anvil-600 hover:bg-anvil-50 coarse:min-h-11 dark:text-anvil-300 dark:hover:bg-anvil-900"
            onClick={() => {
              setOpen(false)
              onHide(null)
            }}
          >
            Hide without a reason
          </button>
        </div>
      ) : null}
    </span>
  )
}

/**
 * The collapsed row of a hidden comment or review: who hid it and why, and Show. `note`: what
 * follows (a review's greyed verdict, "still counts unless dismissed").
 */
export function HiddenRow({
  hidden,
  what,
  author,
  onShow,
  note,
  actions,
}: {
  hidden: Hidden
  what: string
  author: string
  onShow: () => void
  note?: React.ReactNode
  actions?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed border-anvil-300 px-4 py-2 text-dense text-anvil-600 dark:border-anvil-700 dark:text-anvil-300" data-testid="hidden-item" data-via={hidden.via}>
      <EyeOff className="h-3.5 w-3.5 shrink-0 text-anvil-500" aria-hidden />
      {hidden.via === 'ban' ? (
        <span>
          Hidden: <Author identityId={author} link={false} className="align-middle" /> was banned by a maintainer,{' '}
          <Author identityId={hidden.by} link={false} className="align-middle" />
          {banWords(hidden)}
        </span>
      ) : (
        <span>
          {hidden.via === 'review' ? `A ${what} in a hidden review` : `A ${what}`} by <Author identityId={author} link={false} className="align-middle" /> was hidden by{' '}
          <Author identityId={hidden.by} link={false} className="align-middle" />
          {reasonWords(hidden.reason)}
          <span className="whitespace-nowrap"> · {timeAgo(hidden.at)}</span>
        </span>
      )}
      {note}
      <span className="ml-auto flex items-center gap-3">
        {actions}
        <button type="button" onClick={onShow} className="hit-area font-medium text-forge-700 hover:underline dark:text-forge-400" data-testid="show-hidden">
          Show
        </button>
      </span>
    </div>
  )
}

/** The note above a revealed hidden item: who hid it, and Hide again (collapse). */
export function RevealedNote({ hidden, onCollapse }: { hidden: Hidden; onCollapse: () => void }): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="revealed-hidden">
      <EyeOff className="h-3 w-3" aria-hidden />
      <span>
        {hidden.via === 'ban' ? 'Hidden: banned by a maintainer, ' : 'Hidden by '}
        <Author identityId={hidden.by} link={false} className="align-middle" />
        {hidden.via === 'ban' ? banWords(hidden) : reasonWords(hidden.reason)}
      </span>
      <button type="button" onClick={onCollapse} className="hit-area font-medium text-forge-700 hover:underline dark:text-forge-400">
        Collapse
      </button>
    </div>
  )
}

/** A hidden issue's or PR's banner, with its reveal. */
export function HiddenBanner({ hidden, noun, revealed, onReveal }: { hidden: Hidden; noun: 'issue' | 'pull request'; revealed: boolean; onReveal: () => void }): JSX.Element {
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-caution/40 bg-caution/5 px-4 py-3 text-dense text-anvil-700 dark:text-anvil-200" data-testid="hidden-thread">
      <EyeOff className="h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
      {hidden.via === 'ban' ? (
        <span>
          This {noun} is hidden: its author was banned by a maintainer, <Author identityId={hidden.by} link={false} className="align-middle" />
          {banWords(hidden)}. It stays on Platform and keeps its number; lists leave it out.
        </span>
      ) : (
        <span>
          This {noun} was hidden by a maintainer, <Author identityId={hidden.by} link={false} className="align-middle" />
          {reasonWords(hidden.reason)} · {timeAgo(hidden.at)}. It stays on Platform and keeps its number; lists leave it out.
        </span>
      )}
      {!revealed ? (
        <button type="button" onClick={onReveal} className="hit-area ml-auto font-medium text-forge-700 hover:underline dark:text-forge-400" data-testid="reveal-thread">
          Show it anyway
        </button>
      ) : null}
    </div>
  )
}

/**
 * A maintainer's "Hide issue…" / "Hide pull request…" in the sidebar: a reason, and the offer to
 * also close and lock it (separate writes: one transition per batch). Unhide when hidden.
 */
export function HideThreadControl({
  hidden,
  noun,
  offerClose,
  offerLock,
  onHide,
  onUnhide,
  blocked = null,
  byBan = false,
}: {
  hidden: boolean
  /** Only its author's ban collapses it: a hide then keeps it hidden after the ban is lifted. */
  byBan?: boolean
  /** Why the write would change nothing (`moderationBlocked`), shown instead of the action. */
  blocked?: HideBlock | null
  noun: 'issue' | 'pull request'
  /** It is open: offer to close it too. */
  offerClose: boolean
  /** It is unlocked: offer to lock it too. */
  offerLock: boolean
  onHide: (reason: HideReason | null, closeAndLock: boolean) => void
  onUnhide: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<HideReason | ''>('spam')
  const [also, setAlso] = useState(true)
  if (blocked !== null && BLOCKED_NOTE[blocked] !== null) {
    return (
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="hide-thread-blocked">
        {BLOCKED_NOTE[blocked]}
      </p>
    )
  }
  if (hidden) {
    return (
      <button type="button" onClick={onUnhide} className="inline-flex items-center gap-1 rounded-md border border-anvil-300 px-2 py-1 text-[12px] hover:bg-anvil-50 dark:border-anvil-700 dark:hover:bg-anvil-900" data-testid="unhide-thread">
        <Eye className="h-3 w-3" aria-hidden /> Unhide {noun}
      </button>
    )
  }
  const offer = offerClose || offerLock
  const alsoWords = offerClose && offerLock ? 'Also close and lock it' : offerClose ? 'Also close it' : 'Also lock it'
  return open ? (
    <form
      className="mt-1 space-y-2 rounded-md border border-anvil-200 p-2 dark:border-anvil-750"
      onSubmit={(e) => {
        e.preventDefault()
        setOpen(false)
        onHide(reason === '' ? null : reason, offer && also)
      }}
      data-testid="hide-thread-form"
    >
      <label className="block text-[12px] text-anvil-600 dark:text-anvil-400" htmlFor="hide-thread-reason">
        Hide this {noun} from lists and readers{byBan ? ', even after the ban is lifted' : ''} (nothing is deleted)
      </label>
      <select id="hide-thread-reason" value={reason} onChange={(e) => setReason(e.target.value as HideReason | '')} className="w-full rounded-md border border-anvil-300 bg-white px-2 py-1 text-dense dark:border-anvil-700 dark:bg-anvil-950">
        {HIDE_REASONS.map((r) => (
          <option key={r} value={r}>
            {HIDE_REASON_LABEL[r]}
          </option>
        ))}
        <option value="">No reason</option>
      </select>
      {offer ? (
        <label className="flex items-center gap-2 text-[12px]">
          <input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} data-testid="hide-close-lock" /> {alsoWords}
        </label>
      ) : null}
      <div className="flex gap-2">
        <button type="submit" className="rounded-md bg-forge-700 px-2 py-1 text-[12px] font-medium text-white hover:bg-forge-800">
          Hide {noun}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-[12px] text-anvil-600 hover:underline dark:text-anvil-300">
          Cancel
        </button>
      </div>
    </form>
  ) : (
    <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 rounded-md border border-anvil-300 px-2 py-1 text-[12px] hover:bg-anvil-50 dark:border-anvil-700 dark:hover:bg-anvil-900" data-testid="hide-thread">
      <EyeOff className="h-3 w-3" aria-hidden /> Hide {noun}…
    </button>
  )
}

/**
 * The confirm dialog of a hide or unhide (RC2 MOD), shared with the PR page: what readers will see,
 * and that nothing is deleted.
 */
export function hideConfirm(
  p: { readonly what: string; readonly reason: HideReason | null; readonly hide: boolean; readonly closeAndLock?: boolean },
  thread: string,
): { title: string; description: string; label: string } {
  const what = p.what === 'issue' || p.what === 'pull request' ? thread : `this ${p.what}`
  if (!p.hide) {
    return { title: `Unhide ${what}`, description: 'Appends an unhide event: readers see it in full again. The hide stays in the timeline as the record of what happened.', label: 'Sign & unhide' }
  }
  const why = p.reason === null ? '' : ` as ${HIDE_REASON_LABEL[p.reason].toLowerCase()}`
  const shown = p.what === 'issue' || p.what === 'pull request' ? 'Lists leave it out, and its page opens behind a banner' : 'Readers see a collapsed "hidden by a maintainer" row they can expand'
  const also = p.closeAndLock ? ' Then it is closed and locked: separate writes, each confirmed by this one signature.' : ''
  const review = p.what === 'review' ? ' A hidden review\'s verdict still counts: dismiss it to stop it counting.' : ''
  return {
    title: `Hide ${what}${why}`,
    description: `Appends a hide event, signed by you as a maintainer. ${shown}. Nothing is deleted: it stays on Platform, and anyone can still read it.${review}${also}`,
    label: 'Sign & hide',
  }
}

const NO_IDS: ReadonlyMap<string, Hidden> = new Map()

/**
 * A thread's collapses (`hides`, read with it from `input`) with the repo's maintainer bans applied
 * (UPDATE-1). The thread read never reads the bans, so nothing on the page waits on them: until
 * they land, or when their read fails (`readBans` answers none), the page shows the hides alone.
 */
export function useThreadModeration(
  sdk: EvoSDK | null,
  ready: boolean,
  repo: RepoRef,
  input: ModerationInput | undefined,
  hides: HiddenItems | undefined,
): HiddenItems | undefined {
  const bans = useAsync(() => readBans(sdk!, repo), [ready, repoKey(repo)], { enabled: ready && sdk !== null })
  const raw = bans.data
  return useMemo(() => (input === undefined || raw == null || raw.length === 0 ? hides : foldModeration(withBans(input, raw))), [input, hides, raw])
}

/**
 * The list page's rows whose thread a maintainer hid (RC2 MOD), with who hid each and why, read
 * once per distinct set of rows with hides: none read for a page without any.
 */
export function useHiddenThreads(sdk: EvoSDK | null, ready: boolean, repo: RepoRef, network: Network, rows: readonly HideableRow[] | undefined): ReadonlyMap<string, Hidden> {
  const withHides = (rows ?? []).filter((r) => (r.threadHides?.length ?? 0) > 0)
  const key = withHides.map((r) => `${r.id}:${r.threadHides?.length ?? 0}`).join(',')
  const read = useAsync(() => hiddenThreadIds(sdk!, repo, network, withHides), [ready, repoKey(repo), key], { enabled: ready && sdk !== null && key !== '' })
  // The repo's bans (UPDATE-1): one read per repo, shared with its other pages for a while.
  const bans = useAsync(() => readStandingBans(sdk!, repo, network), [ready, repoKey(repo), network], { enabled: ready && sdk !== null && rows !== undefined })
  // Until the read lands: every hide counts (the registration's default), so no hidden row flashes in.
  const hides = key === '' ? NO_IDS : (read.data ?? hiddenRowIds(withHides, repo.ownerId, [], true))
  const banned = bans.data
  if (banned === null || banned.size === 0) return hides
  const out = new Map(hides)
  for (const r of rows ?? []) {
    const b = banned.get(r.author)
    if (b !== undefined && !out.has(r.id)) out.set(r.id, banHidden(b))
  }
  return out
}

/**
 * A revealed hidden row's mark in a list (QW4-038): "Hidden by X as spam", as the issue's page and
 * `dg issue list --include-hidden` say it. Null for a row nobody hid.
 */
export function HiddenRowMark({ hidden }: { hidden: Hidden | undefined }): JSX.Element | null {
  if (hidden === undefined) return null
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-anvil-300 px-2 py-0.5 text-[11px] text-anvil-600 dark:border-anvil-700 dark:text-anvil-300" data-testid="row-hidden">
      <EyeOff className="h-3 w-3 shrink-0" aria-hidden />
      <span>
        {hidden.via === 'ban' ? 'Author banned by ' : 'Hidden by '}
        <Author identityId={hidden.by} link={false} className="align-middle" />
        {hidden.via === 'ban' ? banWords(hidden) : reasonWords(hidden.reason)}
      </span>
    </span>
  )
}

/** "2 hidden by maintainers · Show": the list's toggle for hidden issues or PRs. */
export function HiddenThreadsToggle({ count, shown, onToggle, noun }: { count: number; shown: boolean; onToggle: () => void; noun: string }): JSX.Element | null {
  if (count === 0) return null
  return (
    <div className="flex items-center gap-2 border-b border-anvil-100 px-4 py-2 text-[12px] text-anvil-500 dark:border-anvil-850 dark:text-anvil-400" data-testid="hidden-threads-toggle">
      <EyeOff className="h-3.5 w-3.5" aria-hidden />
      <span>
        {count} {noun}
        {count === 1 ? '' : 's'} on this page hidden by maintainers
      </span>
      <button type="button" onClick={onToggle} className="hit-area font-medium text-forge-700 hover:underline dark:text-forge-400">
        {shown ? 'Hide them' : 'Show'}
      </button>
    </div>
  )
}

/**
 * A hide's or unhide's cost: the event (its reason sealed in a private repo) plus the identifiers a
 * plain event does not carry, the item's `refId` and, assumed present (an upper bound: the page
 * learns whether the contract has it only when it writes), the 32-byte `asMaintainer` proof.
 */
export function hideCost(repo: RepoRef, input: { readonly item: string | null; readonly reason: HideReason | null; readonly hide: boolean }, first: FirstWrite = {}): CostPreview {
  const event = composeCost(repo, 'event', input.hide && input.reason ? { value: input.reason } : {}, first)
  const hide = previewCredits(event.credits + estimateBytesCredits('event', 32) - estimateBytesCredits('event', 0))
  // The item's `refId` also writes its `addressee` index entry (QW4-039).
  return input.item === null ? hide : withAddressee(hide)
}
