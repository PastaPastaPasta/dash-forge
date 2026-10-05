'use client'

/**
 * Members-only content in a public repo, as people see it (DESIGN §4.1, §4.8, §10; D14, D25):
 *
 * - the audience chip and its picker beside every composer's submit ("Who can read this?":
 *   Public, Members (12)), the composer's warnings and the quote confirmation (product H8);
 * - the "Turn on members-only content?" sheet, with the measured cost;
 * - what a reader who cannot open something sees: a placeholder row ("Members-only comment ·
 *   @alice · 2h ago"), one line for a locked member ("3 members-only comments · Unlock to
 *   read"), and the "#N · members-only" page;
 * - the sealed card's "Visible to members", the header chip, and "View as public".
 *
 * Every string here follows the glossary: Public, Members, members-only. Never "sealed" or
 * "lane", nor any internal id.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CircleDot, Eye, EyeOff, Globe, GitPullRequest, Lock } from 'lucide-react'

import type { RepoHome, MembersOnlyEntry, MembersOnlyTarget } from '@/lib/view'
import type { MembersAccess } from '@/lib/view/repo-view'
import type { Membership } from '@/lib/rules/v2'
import { readMembershipsCached, repoContractIds } from '@/lib/repo'
import { readRunners } from '@/lib/repo/checks'
import { enableMembersContent } from '@/lib/repo/private-members'
import { encryptionKeyState } from '@/lib/auth/encryption-key'
import { PRIVATE_REPOS_SETTINGS } from '@/lib/settings-links'
import { previewCredits } from '@/lib/sdk'
import { cachedDpnsName } from '@/lib/view/dpns'
import { shortId } from '@/lib/utils'
import { plural, timeAgo } from '@/lib/view/format'
import {
  AUDIENCE_QUESTION,
  MEMBERS_OPTION_TEXT,
  PUBLIC_SENTENCE,
  QUOTE_CONFIRM,
  SET_UP_KEY,
  TURN_ON,
  VIEWING_AS_PUBLIC,
  audienceChoice,
  audienceLabel,
  audienceWarnings,
  enableEstimate,
  keyHolders,
  lockedCount,
  membersCount,
  membersOnlyNoun,
  membersOnlyTitle,
  membersSentence,
  removalReads,
  turnOnText,
  type AudienceChoice,
  type ComposerAudience,
  type MembersCount,
} from '@/lib/view/audience'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { usePrivateWrite } from '@/hooks/use-private-write'
import { usePublicView } from '@/hooks/use-public-view'
import { Author } from '@/components/author'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { UnlockMore, UNLOCK_MEMBERS_ONLY } from '@/components/auth/unlock-more'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const MUTED = 'text-anvil-500 dark:text-anvil-400'

// ---------------------------------------------------------------------------
// The composer's audience
// ---------------------------------------------------------------------------

/** What a composer knows about who can read what it posts. */
export interface ComposerAudienceState {
  /** What the composer offers; null in a private repo (no chip: everything there is members-only). */
  readonly choice: AudienceChoice | null
  /** Who the next post is for. */
  readonly audience: ComposerAudience
  readonly setAudience: (a: ComposerAudience) => void
  /** The repo's members who hold its key (null until the members are read). */
  readonly count: MembersCount | null
  /** Their identities (warnings, the review question). */
  readonly holders: ReadonlySet<string>
  /** The viewer may turn members-only content on (a maintainer). */
  readonly maintainer: boolean
  /** Turn the audience back to the thread's (after a post). */
  readonly reset: () => void
}

/**
 * The audience of a composer on `home`: it starts on the thread's (`parent`), may pick Members
 * when the viewer is a member who can write it, and never Public inside a members-only thread.
 * `members`: the repo's members when the page read them (else they are read here, members only).
 */
export function useComposerAudience(
  /** The repo page; null where the composer has none (its writes then take their parents' audience). */
  home: RepoHome | null,
  { parent = 'public', members = null, maintainer = false }: { parent?: ComposerAudience; members?: readonly Membership[] | null; maintainer?: boolean },
): ComposerAudienceState {
  const repo = home?.repo ?? null
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const choice = home === null ? null : audienceChoice({ visibility: home.repo.visibility, parent, lane: home.lane, maintainer })
  // Only a member's chip shows a count, so only a member reads the members for it.
  const wants = repo !== null && members === null && choice !== null && choice.members !== null
  const read = useAsync(() => readMembershipsCached(sdk!, repo!, network), [ready, repo?.repoId ?? '', network], { enabled: ready && sdk !== null && wants })
  const list = members ?? read.data
  const visibility = repo?.visibility ?? 'public'
  const count = list === null || list === undefined ? null : membersCount(list, visibility)
  const holders = list === null || list === undefined ? EMPTY : keyHolders(list, visibility)
  const initial = choice?.initial ?? 'members'
  const [audience, setAudience] = useState<ComposerAudience>(initial)
  // The thread loaded, or turned out members-only: follow its audience.
  useEffect(() => setAudience(initial), [initial])
  // A private repo's composer writes members-only content; one with no page takes its parents'.
  const settled: ComposerAudience = choice !== null ? audience : repo?.visibility === 'private' ? 'members' : parent
  return { choice, audience: settled, setAudience, count, holders, maintainer, reset: () => setAudience(initial) }
}

const EMPTY: ReadonlySet<string> = new Set()

/**
 * The audience chip beside a composer's submit: `Public` or `Members (12)`; a button that opens
 * the picker when there is a choice to make, plain text otherwise.
 */
export function AudienceChip({ home, state, testId = 'audience-chip' }: { home: RepoHome; state: ComposerAudienceState; testId?: string }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [turnOn, setTurnOn] = useState(false)
  const panelId = useId()
  const wrap = useRef<HTMLDivElement>(null)
  const { choice, audience } = state
  // Close on a click outside or Escape (focus returns to the chip).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setOpen(false)
      wrap.current?.querySelector<HTMLButtonElement>('button')?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  if (choice === null) return null
  const label = audienceLabel(audience, state.count?.total ?? null)
  const Icon = audience === 'public' ? Globe : Lock
  const pickable = choice.members !== null && (choice.publicAllowed || choice.members !== 'ok')
  const chip = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] font-medium coarse:min-h-11'
  const tone = audience === 'members' ? 'border-anvil-400 bg-anvil-100 text-anvil-800 dark:border-anvil-600 dark:bg-anvil-800 dark:text-anvil-100' : 'border-anvil-300 text-anvil-700 dark:border-anvil-700 dark:text-anvil-200'
  if (!pickable) {
    return (
      <span className={cn(chip, tone)} data-testid={testId} data-audience={audience} title={audience === 'public' ? PUBLIC_SENTENCE : undefined}>
        <Icon className="h-3 w-3" aria-hidden /> {label}
      </span>
    )
  }
  return (
    <div ref={wrap} className="relative inline-block">
      <button
        type="button"
        className={cn(chip, tone, 'hover:border-forge-500')}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${AUDIENCE_QUESTION} ${label}`}
        data-testid={testId}
        data-audience={audience}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon className="h-3 w-3" aria-hidden /> {label}
      </button>
      {open ? (
        <div id={panelId} className="absolute bottom-full right-0 z-30 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-anvil-200 bg-white p-3 text-left shadow-xl dark:border-anvil-750 dark:bg-anvil-950">
          <AudiencePicker
            home={home}
            state={state}
            onPick={(a) => {
              state.setAudience(a)
              setOpen(false)
            }}
            onTurnOn={() => {
              setOpen(false)
              setTurnOn(true)
            }}
          />
        </div>
      ) : null}
      {turnOn ? <TurnOnMembersSheet home={home} open={turnOn} onClose={() => setTurnOn(false)} /> : null}
    </div>
  )
}

/** "Who can read this?": Public and Members, each with what it means (DESIGN §10). */
export function AudiencePicker({
  home,
  state,
  onPick,
  onTurnOn,
}: {
  home: RepoHome
  state: ComposerAudienceState
  onPick: (a: ComposerAudience) => void
  onTurnOn: () => void
}): JSX.Element | null {
  const { sdk, ready } = useSdk(repoContractIds(home.repo))
  const name = useId()
  const choice = state.choice
  // The CI bots among the members, for the Members sentence (read when the picker opens).
  const runners = useAsync(() => readRunners(sdk!, home.repo), [ready, home.repo.repoId], { enabled: ready && sdk !== null && choice?.members !== null })
  if (choice === null) return null
  const members = choice.members
  const count = state.count === null ? null : runners.data === null ? state.count : { ...state.count, bots: membersCountBots(state, runners.data) }
  return (
    <fieldset data-testid="audience-picker">
      <legend className="mb-2 text-dense font-semibold">{AUDIENCE_QUESTION}</legend>
      <div className="space-y-2">
        {choice.publicAllowed ? (
          <Option name={name} value="public" checked={state.audience === 'public'} onPick={onPick} icon={<Globe className="h-3.5 w-3.5" aria-hidden />} label="Public">
            {PUBLIC_SENTENCE}
          </Option>
        ) : null}
        {members !== null ? (
          <Option
            name={name}
            value="members"
            checked={state.audience === 'members'}
            disabled={members !== 'ok'}
            onPick={onPick}
            icon={<Lock className="h-3.5 w-3.5" aria-hidden />}
            label={audienceLabel('members', count?.total ?? null)}
          >
            {count !== null ? membersSentence(count) : 'Current and future members of this repo.'}
            {members !== 'ok' ? <MembersBlocked option={members} onTurnOn={onTurnOn} /> : null}
          </Option>
        ) : null}
      </div>
    </fieldset>
  )
}

/** How many of the repo's runners are members (they read members-only content, D23). */
function membersCountBots(state: ComposerAudienceState, runners: readonly string[]): number {
  return runners.filter((r) => state.holders.has(r)).length
}

function Option({
  name,
  value,
  checked,
  disabled = false,
  onPick,
  icon,
  label,
  children,
}: {
  name: string
  value: ComposerAudience
  checked: boolean
  disabled?: boolean
  onPick: (a: ComposerAudience) => void
  icon: ReactNode
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <label className={cn('flex items-start gap-2 rounded-md p-1.5 text-dense', disabled ? 'cursor-default' : 'cursor-pointer hover:bg-anvil-50 dark:hover:bg-anvil-900')} data-testid={`audience-option-${value}`}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={() => onPick(value)} className="mt-1 accent-forge-700" />
      <span className="min-w-0">
        <span className={cn('flex items-center gap-1 font-medium', disabled && MUTED)}>
          {icon} {label}
        </span>
        <span className={cn('block text-[12px]', MUTED)}>{children}</span>
      </span>
    </label>
  )
}

/** Why Members can't be picked yet, and what to do about it. */
function MembersBlocked({ option, onTurnOn }: { option: Exclude<NonNullable<AudienceChoice['members']>, 'ok'>; onTurnOn: () => void }): JSX.Element {
  return (
    <span className="mt-1 block text-anvil-700 dark:text-anvil-200" data-testid="audience-members-blocked" data-why={option}>
      {MEMBERS_OPTION_TEXT[option]}{' '}
      {option === 'turn-on' ? (
        <button type="button" onClick={onTurnOn} className="hit-area font-medium text-forge-700 underline dark:text-forge-400" data-testid="audience-turn-on">
          {TURN_ON}
        </button>
      ) : option === 'no-key' ? (
        <Link href={PRIVATE_REPOS_SETTINGS} className="hit-area font-medium text-forge-700 underline dark:text-forge-400">
          {SET_UP_KEY}
        </Link>
      ) : null}
      {option === 'locked' ? (
        <span className="mt-2 block">
          <UnlockMore title={UNLOCK_MEMBERS_ONLY} testId="audience-unlock" forgot={false} />
        </span>
      ) : null}
    </span>
  )
}

/** A DPNS name as a mention matches it: its label, lower case. */
function mentionName(name: string): string {
  return name.toLowerCase().replace(/\.dash$/, '')
}

/** The name a warning gives `id`: its DPNS label when this tab knows it, else its short id. */
export function warningName(network: Parameters<typeof cachedDpnsName>[0], id: string): string {
  const name = cachedDpnsName(network, id)
  return name ? mentionName(name) : shortId(id)
}

/**
 * Who can't read what the composer holds (product H8): with Members chosen, the thread's author
 * and every @mention that is not a member's name, as {@link AudienceWarnings} lists them.
 */
export function useAudienceWarnings(state: ComposerAudienceState, text: string, thread: { readonly author: string; readonly kind: 'issue' | 'pull' } | null): string[] {
  const { network } = useSdk()
  if (state.choice === null || state.audience !== 'members' || state.count === null) return []
  const holderNames = new Set<string>()
  for (const id of state.holders) {
    const name = cachedDpnsName(network, id)
    if (name) holderNames.add(mentionName(name))
  }
  return audienceWarnings({
    audience: state.audience,
    text,
    holders: state.holders,
    holderNames,
    thread: thread === null ? null : { ...thread, authorName: warningName(network, thread.author) },
  })
}

/** The composer's warnings (who can't read what is being written), as a list under the editor. */
export function AudienceWarnings({ warnings }: { warnings: readonly string[] }): JSX.Element | null {
  if (warnings.length === 0) return null
  return (
    <ul className="mt-2 space-y-0.5 text-[12px] text-caution-700 dark:text-caution-400" data-testid="audience-warnings" aria-live="polite">
      {warnings.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
  )
}

/**
 * The blocking confirmation before a public post that repeats members-only text (DESIGN §3.3,
 * product H8): nothing is posted until the writer says so.
 */
export function QuoteConfirmDialog({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="Post members-only text publicly?"
      description={QUOTE_CONFIRM}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} autoFocus data-testid="quote-cancel">
            Keep editing
          </Button>
          <Button variant="danger" onClick={onConfirm} data-testid="quote-confirm">
            Post publicly
          </Button>
        </>
      }
    >
      <p className={cn('text-dense', MUTED)}>Anything posted publicly stays readable, even if you delete it later.</p>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Turning members-only content on
// ---------------------------------------------------------------------------

/**
 * "Turn on members-only content?" (DESIGN §10, a maintainer): what it means, the measured cost
 * for the repo's members, the older-builds note; Turn on or Not now. It shares the new key with
 * every member who can receive it (`enableMembersContent`).
 */
export function TurnOnMembersSheet({ home, open, onClose }: { home: RepoHome; open: boolean; onClose: () => void }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const { identity, unlockScope } = useAuth()
  const write = usePrivateWrite(home.repo)
  const members = useAsync(() => readMembershipsCached(sdk!, home.repo, network), [ready, home.repo.repoId, network], { enabled: ready && sdk !== null && open })
  const key = useAsync(() => encryptionKeyState(network, identity!), [network, identity ?? '', unlockScope ?? ''], { enabled: identity !== null && open })
  const holders = members.data === null ? 1 : keyHolders(members.data, home.repo.visibility).size
  const [lead, ...rest] = turnOnText(holders)
  const blocked =
    write.context !== null ? null : key.data === 'locked' ? (
      <UnlockMore title={UNLOCK_MEMBERS_ONLY} testId="turn-on-unlock" forgot={false} />
    ) : key.data === 'none' ? (
      <p className="text-dense" data-testid="turn-on-no-key">
        Members-only content needs your encryption key in this browser.{' '}
        <Link href={PRIVATE_REPOS_SETTINGS} className="hit-area font-medium text-forge-700 underline dark:text-forge-400">
          {SET_UP_KEY}
        </Link>
      </p>
    ) : (
      <p className={cn('text-dense', MUTED)}>Reading your keys…</p>
    )
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Turn on members-only content?"
      description={lead}
      cost={previewCredits(enableEstimate(holders))}
      confirmLabel="Turn on"
      cancelLabel="Not now"
      blocked={blocked}
      toast={{ running: 'Turning on members-only content…', done: 'Members-only content is on' }}
      onConfirm={async (intent) => {
        if (write.context === null) throw new Error('Unlock this tab, or set up your encryption key, then try again.')
        await enableMembersContent(write.context, intent)
        write.done()
      }}
    >
      {rest.map((p) => (
        <p key={p} className="text-dense text-anvil-700 dark:text-anvil-200">
          {p}
        </p>
      ))}
    </ConfirmDialog>
  )
}

// ---------------------------------------------------------------------------
// What a reader who cannot open members-only content sees
// ---------------------------------------------------------------------------

/** A members access that may unlock or set up a key to read (a member who can't read yet). */
function memberCantRead(lane: MembersAccess | undefined): 'locked' | 'no-key' | 'no-key-shared' | null {
  const a = lane?.access
  return a === 'locked' || a === 'no-key' || a === 'no-key-shared' ? a : null
}

/** "Members-only comment · @alice · 2h ago" (DESIGN D14, §10); a review says its public verdict. */
export function MembersOnlyRow({ entry }: { entry: MembersOnlyEntry }): JSX.Element {
  const { item, verdict } = entry
  const did = verdict === 'approve' ? 'approved' : verdict === 'requestChanges' ? 'requested changes' : null
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed border-anvil-300 px-4 py-2 text-dense text-anvil-600 dark:border-anvil-700 dark:text-anvil-300" data-testid="members-only-placeholder" data-type={item.type}>
      <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {membersOnlyTitle(item.type)} · <Author identityId={item.author} link={false} className="align-middle" />
        {did !== null ? ` ${did}` : ''} · <span className={MUTED}>{timeAgo(item.createdAt)}</span>
      </span>
    </div>
  )
}

/**
 * A locked member's one line over every placeholder of a thread: "3 members-only comments ·
 * Unlock to read" (DESIGN §4.8); a member with no key in this browser, or none shared yet, is
 * told that instead.
 */
export function MembersOnlySummary({ entries, lane }: { entries: readonly MembersOnlyEntry[]; lane: MembersAccess | undefined }): JSX.Element | null {
  const [unlocking, setUnlocking] = useState(false)
  const why = memberCantRead(lane)
  if (why === null || entries.length === 0) return null
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-anvil-300 px-4 py-2 text-dense text-anvil-600 dark:border-anvil-700 dark:text-anvil-300" data-testid="members-only-locked">
      <p className="flex flex-wrap items-center gap-x-2">
        <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{lockedCount(entries.map((e) => e.item))}</span>
        {why === 'locked' ? (
          <>
            <span aria-hidden> · </span>
            <button type="button" className="hit-area font-medium text-forge-700 hover:underline dark:text-forge-400" aria-expanded={unlocking} onClick={() => setUnlocking((u) => !u)} data-testid="members-only-unlock">
              Unlock to read
            </button>
          </>
        ) : why === 'no-key' ? (
          <>
            <span aria-hidden> · </span>
            <Link href={PRIVATE_REPOS_SETTINGS} className="hit-area font-medium text-forge-700 hover:underline dark:text-forge-400">
              {SET_UP_KEY}
            </Link>
          </>
        ) : null}
      </p>
      {unlocking ? <UnlockMore title={UNLOCK_MEMBERS_ONLY} testId="members-only-unlock-panel" forgot={false} /> : null}
    </div>
  )
}

/** Whether `lane`'s viewer sees one locked line instead of each placeholder. */
export function summarizesMembersOnly(lane: MembersAccess | undefined): boolean {
  return memberCantRead(lane) !== null
}

/** The tinted label of a members-only card this reader opened: "Visible to members". */
export function VisibleToMembers({ what }: { what?: 'review' }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-anvil-100 px-2 py-0.5 text-[11px] font-medium text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200" data-testid="visible-to-members">
      <Lock className="h-3 w-3" aria-hidden /> {what === 'review' ? 'Review text visible to members' : 'Visible to members'}
    </span>
  )
}

/** A members-only card's tint (its border and header), for a card this reader opened. */
export const MEMBERS_CARD = 'border-anvil-400 dark:border-anvil-600'
export const MEMBERS_CARD_HEADER = 'bg-anvil-100 dark:bg-anvil-850'

/**
 * The page of an issue or PR this reader cannot open (DESIGN D14, D19): "#3 · members-only",
 * who opened it, when, its state and how many comments it has; never "not found".
 */
export function MembersOnlyTargetPage({ home, target }: { home: RepoHome; target: MembersOnlyTarget }): JSX.Element {
  const kind = target.placeholder.type === 'patch' ? 'pull' : 'issue'
  const Icon = kind === 'pull' ? GitPullRequest : CircleDot
  const state = target.merged ? 'merged' : target.open ? 'open' : 'closed'
  const why = memberCantRead(home.lane)
  return (
    <div className="space-y-4" data-testid="members-only-target" data-kind={kind}>
      <h1 className="text-2xl">
        <span className="font-mono">#{target.number}</span> <span className="text-anvil-500 dark:text-anvil-400">· members-only</span>
      </h1>
      <p className="flex items-start gap-2 text-dense text-anvil-600 dark:text-anvil-300">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          {membersOnlyTitle(target.placeholder.type)} · opened by <Author identityId={target.placeholder.author} link={false} className="align-middle" />{' '}
          <span className={MUTED}>{timeAgo(target.placeholder.createdAt)}</span> · <span data-testid="members-only-state">{state}</span>
          {target.comments > 0 ? ` · ${plural(target.comments, 'comment')}` : ''}
        </span>
      </p>
      <div className="rounded-lg border border-dashed border-anvil-300 px-4 py-3 text-dense dark:border-anvil-700">
        {why === 'locked' ? (
          <UnlockMore title={UNLOCK_MEMBERS_ONLY} testId="members-only-target-unlock" forgot={false} />
        ) : why === 'no-key' ? (
          <p>
            Only members of this repo can read this {membersOnlyNoun(target.placeholder.type)}.{' '}
            <Link href={PRIVATE_REPOS_SETTINGS} className="hit-area font-medium text-forge-700 underline dark:text-forge-400">
              {SET_UP_KEY}
            </Link>{' '}
            to read it here.
          </p>
        ) : home.lane?.access === 'member' ? (
          <p>You can&apos;t read this one. It was written with a key you don&apos;t hold.</p>
        ) : why === 'no-key-shared' ? null : (
          <p>Only members of this repo can read this {membersOnlyNoun(target.placeholder.type)}. Everyone can see that it exists, who opened it and when.</p>
        )}
      </div>
    </div>
  )
}

/**
 * Settings → Members-only content (a member of a public repo): whether it is on, and for a
 * maintainer the way to turn it on ({@link TurnOnMembersSheet}).
 */
export function MembersContentSetting({ home, maintainer }: { home: RepoHome; maintainer: boolean }): JSX.Element | null {
  const [turnOn, setTurnOn] = useState(false)
  const access = home.lane?.access
  if (home.repo.visibility !== 'public' || access === undefined) return null
  const on = access !== 'none'
  return (
    <div className="rounded-lg border border-anvil-200 px-4 py-3 text-dense dark:border-anvil-800" data-testid="members-content-setting" data-on={on ? 'true' : 'false'}>
      <p className="flex flex-wrap items-center gap-2">
        <Lock className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <span className="font-medium">Members-only content</span>
        <span className="rounded-full bg-anvil-100 px-2 py-0.5 text-[11px] font-medium text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200">{on ? 'On' : 'Off'}</span>
      </p>
      <p className={cn('mt-1 text-[12px]', MUTED)}>
        {on
          ? 'Members can post comments, reviews and issues only members can read. Everyone can still see that something was posted, by whom and when.'
          : maintainer
            ? 'Members can only post what everyone can read.'
            : MEMBERS_OPTION_TEXT['ask-maintainer']}
      </p>
      {!on && maintainer ? (
        <Button className="mt-2" size="sm" variant="outline" onClick={() => setTurnOn(true)} data-testid="settings-turn-on">
          {TURN_ON}
        </Button>
      ) : null}
      {turnOn ? <TurnOnMembersSheet home={home} open={turnOn} onClose={() => setTurnOn(false)} /> : null}
    </div>
  )
}

/**
 * What a member being removed could read, in plain words (stream 1F): they keep it, and nothing
 * posted after the removal. `extras`: other features' lines (environments add theirs).
 */
export function RemovalReads({ lane, extras = [] }: { lane: boolean; extras?: readonly string[] }): JSX.Element | null {
  const reads = removalReads(lane, extras)
  if (reads.length === 0) return null
  return (
    <div className="space-y-1 text-dense text-anvil-700 dark:text-anvil-200" data-testid="removal-reads">
      <p>They could read:</p>
      <ul className="list-disc pl-5">
        {reads.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className={cn('text-[12px]', MUTED)}>They keep what they could already read. They can&apos;t read anything members-only posted after this.</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The repo header's chip, and "View as public"
// ---------------------------------------------------------------------------

/** The header's members-only chip, for a member of a repo where it is on. */
export function MembersChip({ home }: { home: RepoHome }): JSX.Element | null {
  const access = home.lane?.access
  if (home.repo.visibility !== 'public' || access === undefined || access === 'none') return null
  const title =
    access === 'member'
      ? 'This repo has members-only content. You can read it.'
      : access === 'locked'
        ? 'This repo has members-only content. Unlock this tab to read it.'
        : access === 'no-key'
          ? 'This repo has members-only content. Set up your encryption key to read it.'
          : "This repo has members-only content. No key has been shared with you yet."
  return (
    <span data-testid="members-chip" data-access={access} title={title} className="inline-flex items-center gap-1 rounded bg-anvil-100 px-1.5 py-0.5 text-[11px] text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300">
      <Lock className="h-3 w-3" aria-hidden />
      Members-only content
    </span>
  )
}

/** "View as public", for a member of a public repo with members-only content on. */
export function ViewAsPublicButton({ home }: { home: RepoHome }): JSX.Element | null {
  const [, setPublicView] = usePublicView(home.repo.repoId)
  const access = home.lane?.access
  if (home.repo.visibility !== 'public' || access === undefined || access === 'none') return null
  return (
    <div className="mb-3 flex justify-end">
      <Button variant="ghost" size="sm" onClick={() => setPublicView(true)} data-testid="view-as-public">
        <Eye className="h-3.5 w-3.5" aria-hidden /> View as public
      </Button>
    </div>
  )
}

/** The banner over a page shown as the public sees it, with the way back. */
export function PublicViewBanner({ onExit }: { onExit: () => void }): JSX.Element {
  return (
    <div role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-anvil-300 bg-anvil-50 px-3 py-2 text-dense text-anvil-800 dark:border-anvil-700 dark:bg-anvil-850 dark:text-anvil-100" data-testid="public-view-banner">
      <EyeOff className="h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
      <span className="min-w-0 flex-1">{VIEWING_AS_PUBLIC}</span>
      <Button variant="outline" size="sm" onClick={onExit} data-testid="exit-public-view">
        Back to your view
      </Button>
    </div>
  )
}
