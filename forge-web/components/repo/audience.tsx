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
 * - the sealed card's "Visible to members", the header chip, and "View as public";
 * - messages to specific people (DESIGN §4.2): the Maintainers, Writers and maintainers and
 *   Specific people… options, a thread's people re-listed, and their placeholders ("Comment to 3
 *   people · @alice · 2h ago"); the people picker and "Visible to alice, bob and you" live in
 *   `letter-picker.tsx`.
 *
 * Every string here follows the glossary: Public, Members, members-only, a "message" to specific
 * people. Never "sealed", "lane" or "letter", nor any internal id.
 */

import { creditsToDash } from '@/lib/sdk/cost'
import { FiatNote } from '@/components/ui/fiat-note'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import Link from 'next/link'
import { CircleDot, Eye, EyeOff, Globe, GitPullRequest, Lock, Users } from 'lucide-react'

import type { RepoHome, MembersOnlyEntry, MembersOnlyTarget } from '@/lib/view'
import type { MembersAccess } from '@/lib/view/repo-view'
import type { Membership } from '@/lib/rules/v2'
import { botsOf } from '@/lib/rules/roles'
import { readMembershipsCached, repoContractIds } from '@/lib/repo'
import { readRunners } from '@/lib/repo/checks'
import { enableMembersContent } from '@/lib/repo/private-members'
import { encryptionKeyState } from '@/lib/auth/encryption-key'
import { BOT_READ_TEXT, NO_KEY_SHARED_TEXT } from '@/lib/repo/members-writes'
import { composerCandidates, previewLetter, type LetterPreview, type LetterThread } from '@/lib/repo/letter-writes'
import type { LetterFacts } from '@/lib/repo/private-content'
import type { LetterGroup, ParentLetter } from '@/lib/rules/letters'
import { openedMembersTexts, subscribeMembersTexts } from '@/lib/repo/members-texts'
import { PRIVATE_REPOS_SETTINGS } from '@/lib/settings-links'
import { previewCredits } from '@/lib/sdk'
import { cachedDpnsName } from '@/lib/view/dpns'
import { shortId } from '@/lib/utils'
import { plural, timeAgo } from '@/lib/view/format'
import {
  AUDIENCE_QUESTION,
  LETTER_GROUPS,
  LETTER_OPTION_TEXT,
  NO_LETTER_ASK,
  SPECIFIC_PEOPLE,
  SPECIFIC_PEOPLE_SENTENCE,
  groupLabel,
  groupSentence,
  letterChipLabel,
  letterRefusalText,
  notPublic,
  placeholderTitle,
  skippedText,
  tooManyText,
  wideningText,
  type LetterAsk,
  type LetterOffer,
  MEMBERS_OPTION_TEXT,
  NOT_A_BOT_TEXT,
  PUBLIC_SENTENCE,
  QUOTE_CONFIRM,
  SET_UP_KEY,
  TURN_ON,
  VIEWING_AS_PUBLIC,
  audienceChoice,
  audienceLabel,
  audienceWarnings,
  enableEstimate,
  isLetter,
  keyHolders,
  lockedCount,
  membersCount,
  membersOnlyNoun,
  peopleCount,
  membersSentence,
  quotesMembersText,
  QuoteIndex,
  type MembersTexts,
  removalReads,
  turnOnText,
  whilePrivateNote,
  writtenWhilePrivateLabel,
  type AudienceChoice,
  type ComposerAudience,
  type MembersCount,
  memberCantRead,
} from '@/lib/view/audience'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { usePrivateWrite } from '@/hooks/use-private-write'
import { takePublicViewFocus, usePublicView } from '@/hooks/use-public-view'
import { useParam } from '@/hooks/use-query-param'
import { Author } from '@/components/author'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { UnlockMore, UNLOCK_LETTERS, UNLOCK_MEMBERS_ONLY } from '@/components/auth/unlock-more'
import type { Network } from '@/lib/constants'
import { Button } from '@/components/ui/button'
import { Dialog, useEscapeLayer } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { PeoplePicker, VisibleToPeople, letterPeople, useKeyless, useNames } from '@/components/repo/letter-picker'

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
  /** Who a message to specific people goes to, as asked (`audience` `specificPeople`). */
  readonly letter: LetterAsk
  readonly setLetter: (a: LetterAsk) => void
  /** Pick specific people with `ask` in one go (a role group, a forward's people). */
  readonly sendTo: (ask: LetterAsk) => void
  /** The plan of a message to specific people as it stands (null until members and keys are read). */
  readonly preview: LetterPreview | null
  /** The thread's messages to specific people this one replies under, and its members-only parents. */
  readonly thread: LetterThread
  /** The repo's members (null until read). */
  readonly members: readonly Membership[] | null
  /** The viewer (base58), or null signed out. */
  readonly viewer: string | null
  /** Why the composer can't post as it stands (a refused message to specific people), or null. */
  readonly blocked: string | null
}

/** What a composer knows of its thread's messages to specific people (DESIGN D26). */
export interface LetterThreadContext {
  /** The opened ones it replies under (the target, the comment replied to, its root), each as listed by its writer. */
  readonly parents: readonly ParentLetter[]
  /** One of them is a message this viewer can't read: only its recipients can reply. */
  readonly unreadable?: boolean
}

/** The {@link LetterThreadContext} of a thread whose items (target, replied comment, root) carry these marks. */
export function letterThreadOf(items: readonly ({ readonly audience?: string; readonly letter?: LetterFacts; readonly membersOnly?: true } | null | undefined)[]): LetterThreadContext {
  const parents: ParentLetter[] = []
  let unreadable = false
  for (const it of items) {
    if (it?.audience !== 'specificPeople') continue
    if (it.letter === undefined || it.membersOnly === true) unreadable = true
    else parents.push({ recipients: it.letter.recipients, group: it.letter.group })
  }
  return { parents, unreadable }
}

const NO_THREAD: LetterThreadContext = { parents: [] }

/**
 * The audience of a composer on `home`: it starts on the thread's (`parent`), may pick Members
 * when the viewer is a member who can write it, and never Public inside a members-only thread.
 * `members`: the repo's members when the page read them (else they are read here, members only).
 */
export function useComposerAudience(
  /** The repo page; null where the composer has none (its writes then take their parents' audience). */
  home: RepoHome | null,
  {
    parent = 'public',
    members = null,
    maintainer = false,
    start,
    startLetter,
    letters = true,
    thread = NO_THREAD,
    writtenWhilePrivate = false,
  }: {
    parent?: ComposerAudience
    /**
     * The thread was written while the repo (made public since) was private: a members-only one
     * takes public replies too (DESIGN §4.10).
     */
    writtenWhilePrivate?: boolean
    members?: readonly Membership[] | null
    maintainer?: boolean
    /**
     * Where it starts instead of the thread's audience: a saved draft's (the review drawer). A
     * pick holds until this or the thread's audience changes.
     */
    start?: ComposerAudience | undefined
    /** A saved draft's people (the review drawer), with `start` `specificPeople`. */
    startLetter?: LetterAsk
    /** Messages to specific people may be written here (every composer but a new pull request's). */
    letters?: boolean
    /** The thread's messages to specific people (a reply re-lists their people). */
    thread?: LetterThreadContext
  },
): ComposerAudienceState {
  const repo = home?.repo ?? null
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity, unlockScope } = useAuth()
  // The viewer's encryption key here: a message to specific people is sealed with it.
  const key = useAsync(() => encryptionKeyState(network, identity!), [network, identity ?? '', unlockScope ?? ''], { enabled: identity !== null && letters && home !== null })
  const offer: LetterOffer = {
    offered: letters && identity !== null,
    key: identity === null ? null : (key.data ?? null),
    ...(thread.unreadable === true ? { thread: 'unreadable' as const } : thread.parents.length > 0 ? { thread: 'open' as const } : {}),
  }
  // A thread of messages to specific people takes only those (DESIGN §3.3).
  const threadParent: ComposerAudience = thread.parents.length > 0 || thread.unreadable === true ? 'specificPeople' : parent
  const choice = home === null ? null : audienceChoice({ visibility: home.repo.visibility, parent: threadParent, lane: home.lane, maintainer, letters: offer, writtenWhilePrivate })
  // Only a member's chip shows a count, so only a member reads the members for it (and anyone
  // who may send to a role group or to people, for the groups and the plan).
  const wants = repo !== null && members === null && choice !== null && (choice.members !== null || choice.letters !== null)
  const read = useAsync(() => readMembershipsCached(sdk!, repo!, network), [ready, repo?.repoId ?? '', network], { enabled: ready && sdk !== null && wants })
  const list = members ?? read.data
  const count = list === null || list === undefined ? null : membersCount(list)
  const holders = list === null || list === undefined ? EMPTY : keyHolders(list)
  const initial = choice?.initial ?? 'members'
  // Inside a members-only thread nothing starts public, whatever a draft says; inside a thread of
  // messages to specific people nothing starts anywhere else.
  const preferred: ComposerAudience =
    choice?.lettersOnly === true
      ? 'specificPeople'
      : start === 'members' || (start === 'specificPeople' && choice?.letters != null) || (start === 'public' && choice?.publicAllowed !== false)
        ? start
        : initial
  // The writer's pick, made over `preferred`: it holds until the thread or the draft moves the
  // starting point (the thread loaded, or turned out members-only), and is derived during render,
  // so no render shows a stale audience.
  const [picked, setPicked] = useState<{ readonly over: ComposerAudience; readonly to: ComposerAudience } | null>(null)
  // A pick over an earlier starting point is dropped for good (render-phase reset), so it never
  // comes back if the starting point returns.
  if (picked !== null && picked.over !== preferred) setPicked(null)
  const audience = picked !== null && picked.over === preferred ? picked.to : preferred
  const setAudience = useCallback((a: ComposerAudience) => setPicked({ over: preferred, to: a }), [preferred])
  // Who a message to specific people goes to: the draft's, else nobody named yet (in a thread:
  // its people re-listed). A draft read after the composer opened (the review drawer) brings its
  // people with it, as `start` brings its audience (render-phase, so no render shows a stale list).
  const startKey = JSON.stringify(startLetter ?? null)
  const [asked, setAsked] = useState<{ readonly from: string; readonly ask: LetterAsk }>({ from: startKey, ask: startLetter ?? NO_LETTER_ASK })
  if (asked.from !== startKey) setAsked({ from: startKey, ask: startLetter ?? NO_LETTER_ASK })
  const letter = asked.from === startKey ? asked.ask : (startLetter ?? NO_LETTER_ASK)
  const setLetter = useCallback((ask: LetterAsk) => setAsked({ from: startKey, ask }), [startKey])
  const reset = useCallback(() => {
    setPicked(null)
    setAsked({ from: startKey, ask: NO_LETTER_ASK })
  }, [startKey])
  const sendTo = useCallback(
    (ask: LetterAsk) => {
      setAsked({ from: startKey, ask })
      setPicked({ over: preferred, to: 'specificPeople' })
    },
    [preferred, startKey],
  )
  // A private repo's composer writes members-only content; one with no page takes its parents'.
  const settled: ComposerAudience = choice !== null ? audience : repo?.visibility === 'private' ? 'members' : threadParent
  const letterThread: LetterThread = useMemo(
    () => ({ parents: thread.parents, membersOnlyParent: repo?.visibility === 'private' || parent === 'members' }),
    [thread.parents, repo?.visibility, parent],
  )
  const preview = useLetterPreview(home, list ?? null, identity, letter, letterThread, choice?.letters != null)
  const nameOf = useNames(preview?.refusal !== null && preview?.refusal !== undefined && 'people' in preview.refusal ? preview.refusal.people : [])
  let blocked: string | null = null
  if (settled === 'specificPeople' && choice !== null) {
    if (choice.letters !== 'ok') blocked = LETTER_OPTION_TEXT[choice.letters ?? 'no-key']
    else if (preview?.refusal != null) blocked = letterRefusalText(preview.refusal, nameOf, letter.group)
  }
  return {
    choice,
    audience: settled,
    setAudience,
    count,
    holders,
    maintainer,
    reset,
    letter,
    setLetter,
    sendTo,
    preview,
    thread: letterThread,
    members: list ?? null,
    viewer: identity,
    blocked,
  }
}

/**
 * The plan of a message to specific people as the composer stands (`previewLetter`): who it
 * would go to, who is left out for want of a key, a refusal, the role groups' sizes. Null until
 * the members and the candidates' keys are read.
 */
function useLetterPreview(
  home: RepoHome | null,
  members: readonly Membership[] | null,
  viewer: string | null,
  ask: LetterAsk,
  thread: LetterThread,
  enabled: boolean,
): LetterPreview | null {
  const candidates = useMemo(() => {
    if (home === null || members === null || viewer === null || !enabled) return []
    // Every role group's people too: the picker sizes both groups.
    const all = composerCandidates(viewer, home.repo.ownerId, members, ask, thread.parents)
    for (const g of LETTER_GROUPS) for (const p of composerCandidates(viewer, home.repo.ownerId, members, { group: g, people: [], exact: null }, [])) all.add(p)
    return [...all]
  }, [home, members, viewer, ask, thread.parents, enabled])
  const { keyless, ready } = useKeyless(home?.repo ?? null, candidates, home !== null && enabled)
  return useMemo(() => {
    if (home === null || members === null || viewer === null || !enabled || !ready) return null
    return previewLetter({ owner: home.repo.ownerId, viewer, members, keyless, ask, thread })
  }, [home, members, viewer, enabled, ready, keyless, ask, thread])
}

const EMPTY: ReadonlySet<string> = new Set()

/**
 * The audience chip beside a composer's submit: `Public` or `Members (12)`; a button that opens
 * the picker when there is a choice to make, plain text otherwise.
 */
export function AudienceChip({ home, state, testId = 'audience-chip' }: { home: RepoHome; state: ComposerAudienceState; testId?: string }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [turnOn, setTurnOn] = useState(false)
  // Which side of the chip the picker opens on (from `sm` up; a phone gets a bottom sheet).
  const [align, setAlign] = useState<'left' | 'right'>('right')
  const panelId = useId()
  const wrap = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const { choice, audience } = state
  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) chipRef.current?.focus()
  }, [])
  // Escape closes the picker (focus returns to the chip), never a dialog it sits in.
  useEscapeLayer(open, () => close(true), wrap)
  // A click outside closes it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) close(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, close])
  // Open toward the side with room: right-aligned to the chip unless that runs off the left edge.
  useLayoutEffect(() => {
    if (!open || wrap.current === null) return
    const right = wrap.current.getBoundingClientRect().right
    setAlign(right - PICKER_WIDTH >= PICKER_MARGIN ? 'right' : 'left')
  }, [open])
 const chipNames = useNames(state.preview?.recipients ?? letterPeople(state.letter, []))
  if (choice === null) return null
  const label =
    audience === 'specificPeople'
      ? letterChipLabel(state.letter, {
          recipients: state.preview?.recipients ?? null,
          groupCount: state.letter.group === null ? null : (state.preview?.groups[state.letter.group].count ?? null),
          viewer: state.viewer,
          nameOf: chipNames,
        })
      : audienceLabel(audience, state.count?.total ?? null)
  const Icon = audience === 'public' ? Globe : audience === 'specificPeople' ? Users : Lock
  // A choice to make: more than one option, or people to pick.
  const pickable = choice.letters !== null || (choice.members !== null && (choice.publicAllowed || choice.members !== 'ok'))
  const chip = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[12px] font-medium coarse:min-h-11'
  const tone = notPublic(audience) ? 'border-anvil-400 bg-anvil-100 text-anvil-800 dark:border-anvil-600 dark:bg-anvil-800 dark:text-anvil-100' : 'border-anvil-300 text-anvil-700 dark:border-anvil-700 dark:text-anvil-200'
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
        ref={chipRef}
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
        <div
          id={panelId}
          data-testid={`${testId}-panel`}
          data-align={align}
          className={cn(
            // A phone: a sheet along the bottom of the screen, always in view. From `sm` up: a
            // popover above the chip, on the side with room.
            'fixed inset-x-2 bottom-2 z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-anvil-200 bg-white p-3 text-left shadow-xl dark:border-anvil-750 dark:bg-anvil-950',
            'sm:absolute sm:inset-x-auto sm:bottom-full sm:z-30 sm:mb-2 sm:max-h-none sm:w-[22rem] sm:overflow-visible',
            align === 'right' ? 'sm:right-0' : 'sm:left-0',
          )}
        >
          <AudiencePicker
            home={home}
            state={state}
            onPick={(a) => {
              state.setAudience(a)
              close(true)
            }}
            onDone={() => close(true)}
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

/** The picker's width from `sm` up (22rem), and the least room it keeps from the screen's edge. */
const PICKER_WIDTH = 352
const PICKER_MARGIN = 8

/** Which option of the picker is chosen: Public, Members, a role group, or people one by one. */
type PickerValue = 'public' | 'members' | LetterGroup | 'people'

/** The picker option `state` stands on. */
function pickedValue(state: ComposerAudienceState): PickerValue {
  if (state.audience !== 'specificPeople') return state.audience
  const l = state.letter
  return l.exact === null && l.group !== null && l.people.length === 0 ? l.group : 'people'
}

/**
 * "Who can read this?" (DESIGN §10): Public, Members, Maintainers, Writers and maintainers and
 * Specific people…, each with what it means; the options the context forbids are hidden.
 */
export function AudiencePicker({
  home,
  state,
  onPick,
  onDone,
  onTurnOn,
}: {
  home: RepoHome
  state: ComposerAudienceState
  onPick: (a: ComposerAudience) => void
  /** The picker is done (a role group picked). */
  onDone?: () => void
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
  const picked = pickedValue(state)
  const letters = choice.letters
  const preview = state.preview
  const pickValue = (v: string): void => {
    const value = v as PickerValue
    if (value === 'public' || value === 'members') {
      onPick(value)
      return
    }
    if (value === 'people') {
      // In a thread: its people re-listed, as they are now; elsewhere nobody named yet.
      state.sendTo(NO_LETTER_ASK)
      return
    }
    state.sendTo({ group: value, people: [], exact: null })
    onDone?.()
  }
  const peopleOpen = state.audience === 'specificPeople' && picked === 'people' && letters === 'ok' && state.viewer !== null
  return (
    <fieldset data-testid="audience-picker">
      <legend className="mb-2 text-dense font-semibold">{AUDIENCE_QUESTION}</legend>
      <div className="space-y-2">
        {choice.publicAllowed && !choice.lettersOnly ? (
          <Option name={name} value="public" checked={picked === 'public'} onPick={pickValue} icon={<Globe className="h-3.5 w-3.5" aria-hidden />} label="Public">
            {PUBLIC_SENTENCE}
          </Option>
        ) : null}
        {members !== null && !choice.lettersOnly ? (
          <Option
            name={name}
            value="members"
            checked={picked === 'members'}
            disabled={members !== 'ok'}
            onPick={pickValue}
            icon={<Lock className="h-3.5 w-3.5" aria-hidden />}
            label={audienceLabel('members', count?.total ?? null)}
          >
            {count !== null ? membersSentence(count) : 'Current and future members of this repo.'}
            {members !== 'ok' ? <MembersBlocked option={members} onTurnOn={onTurnOn} /> : null}
          </Option>
        ) : null}
        {letters !== null && !choice.lettersOnly
          ? LETTER_GROUPS.map((g) => {
              const sized = preview?.groups[g] ?? null
              return (
                <Option
                  key={g}
                  name={name}
                  value={g}
                  checked={picked === g}
                  disabled={letters !== 'ok' || sized === null || sized.tooMany}
                  onPick={pickValue}
                  icon={<Users className="h-3.5 w-3.5" aria-hidden />}
                  label={groupLabel(g, sized?.count ?? null)}
                >
                  {sized === null ? 'Reading who is in it…' : sized.tooMany ? <span data-testid="audience-too-many">{tooManyText(g, sized.count)}</span> : groupSentence(g, sized.count)}
                </Option>
              )
            })
          : null}
        {letters !== null ? (
          <Option
            name={name}
            value="people"
            checked={picked === 'people'}
            disabled={letters !== 'ok'}
            onPick={pickValue}
            icon={<Users className="h-3.5 w-3.5" aria-hidden />}
            label={SPECIFIC_PEOPLE}
          >
            {SPECIFIC_PEOPLE_SENTENCE}
            {letters !== 'ok' ? <LettersBlocked option={letters} /> : null}
          </Option>
        ) : null}
        {peopleOpen ? (
          <PeoplePicker
            home={home}
            viewer={state.viewer as string}
            people={letterPeople(state.letter, preview?.relisted ?? []).filter((p) => p !== state.viewer)}
            onChange={(people) => state.setLetter(state.thread.parents.length > 0 ? { group: null, people: [], exact: people } : { group: null, people, exact: null })}
          />
        ) : null}
      </div>
    </fieldset>
  )
}

/** Why the specific-people options can't be picked yet, and what to do about it. */
function LettersBlocked({ option }: { option: Exclude<NonNullable<AudienceChoice['letters']>, 'ok'> }): JSX.Element {
  return (
    <span className="mt-1 block text-anvil-700 dark:text-anvil-200" data-testid="audience-letters-blocked" data-why={option}>
      {LETTER_OPTION_TEXT[option]}{' '}
      {option === 'no-key' ? (
        <Link href={PRIVATE_REPOS_SETTINGS} className="hit-area font-medium text-forge-700 underline dark:text-forge-400">
          {SET_UP_KEY}
        </Link>
      ) : null}
      {option === 'locked' ? (
        <span className="mt-2 block">
          <UnlockMore title={UNLOCK_LETTERS} testId="audience-letters-unlock" forgot={false} />
        </span>
      ) : null}
    </span>
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
  value: string
  checked: boolean
  disabled?: boolean
  onPick: (value: string) => void
  icon: ReactNode
  label: string
  children: ReactNode
}): JSX.Element {
  // The radio is named by its label alone ("Members (12)"); what it means, and why it can't be
  // picked, describe it. Links and buttons in the description sit outside the <label>.
  const id = useId()
  return (
    <div className={cn('flex items-start gap-2 rounded-md p-1.5 text-dense', !disabled && 'hover:bg-anvil-50 dark:hover:bg-anvil-900')} data-testid={`audience-option-${value}`}>
      <input
        id={`${id}-radio`}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onPick(value)}
        aria-describedby={`${id}-about`}
        className="mt-1 accent-forge-700"
      />
      <span className="min-w-0">
        <label htmlFor={`${id}-radio`} className={cn('flex items-center gap-1 font-medium', disabled ? cn('cursor-default', MUTED) : 'cursor-pointer')}>
          {icon} {label}
        </label>
        <span id={`${id}-about`} className={cn('block text-[12px]', MUTED)}>
          {children}
        </span>
      </span>
    </div>
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
 * and every @mention that is not a member's name; with specific people, everyone of those not
 * among its recipients, then who is left out for want of a key, who reads from this reply on, and
 * why it can't be sent, as {@link AudienceWarnings} lists them.
 */
export function useAudienceWarnings(state: ComposerAudienceState, text: string, thread: { readonly author: string; readonly kind: 'issue' | 'pull' } | null): string[] {
  const { network } = useSdk()
  const preview = state.preview
  const extra = [...(preview?.skipped ?? []), ...(preview?.widened ?? [])]
  const nameOf = useNames(extra)
  if (state.choice === null) return []
  if (state.audience === 'specificPeople') {
    const out: string[] = []
    if (state.blocked !== null) out.push(state.blocked)
    if (preview?.recipients != null) {
      const holders = new Set(preview.recipients)
      const holderNames = new Set<string>()
      for (const id of holders) {
        const name = cachedDpnsName(network, id)
        if (name) holderNames.add(mentionName(name))
      }
      out.push(...audienceWarnings({ audience: 'specificPeople', text, holders, holderNames, thread: thread === null ? null : { ...thread, authorName: warningName(network, thread.author) } }))
      const skipped = skippedText(preview.skipped, nameOf)
      if (skipped !== null) out.push(skipped)
      for (const p of preview.widened) out.push(wideningText(nameOf(p)))
    }
    return out
  }
  // A public reply to a members-only thread written while the repo was private (DESIGN §4.10).
  if (state.audience === 'public' && state.choice.whilePrivate !== undefined) return [whilePrivateNote(state.choice.whilePrivate.member)]
  if (state.audience !== 'members' || state.count === null) return []
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

const NO_TEXTS: readonly string[] = []

/**
 * The members-only text a public composer of repo `repoId` checks what it posts against (product
 * H8), prepared once: `pageTexts`, what its page shows, and everything members-only this tab has
 * opened in the repo (`members-texts.ts`: other threads, comments past the first page). It
 * follows the tab's opened text as it grows, and empties when the tab locks or signs out.
 */
export function useMembersTexts(repoId: string, pageTexts: readonly string[] = NO_TEXTS): QuoteIndex {
  const opened = useSyncExternalStore(
    subscribeMembersTexts,
    () => openedMembersTexts(repoId),
    () => NO_TEXTS,
  )
  return useMemo(() => new QuoteIndex(opened.length === 0 ? pageTexts : [...pageTexts, ...opened]), [pageTexts, opened])
}

/** What a write makes public for the quote check: one text, several (a review and its comments), or nothing (null). */
export type PublicText = string | null | readonly (string | null)[]

/** Whether any of `text` repeats `membersTexts` (`opts` as for `quotesMembersText`). */
export function publicTextQuotes(text: PublicText, membersTexts: MembersTexts, opts: { readonly before?: string; readonly extra?: readonly string[] } = {}): boolean {
  const all = text === null ? [] : typeof text === 'string' ? [text] : text
  return all.some((t) => t !== null && t.trim() !== '' && quotesMembersText(t, membersTexts, opts))
}

/** What {@link useQuoteGate} returns: the check to run before a public post, and its dialog to render. */
export interface QuoteGate {
  /**
   * Run `go` now, unless `publicText` (what is about to become public; null when nothing is)
   * repeats members-only text (`membersTexts`, from {@link useMembersTexts}): then ask first, and
   * run `go` only when the writer confirms. `opts.before`: an edit's text before it (only what it
   * adds is checked); `opts.extra`: more members-only text, such as the writer's own unposted text.
   */
  readonly check: (publicText: PublicText, membersTexts: MembersTexts, go: () => void, opts?: { readonly before?: string; readonly extra?: readonly string[] }) => void
  /** The confirmation; render it once beside the composer. */
  readonly dialog: JSX.Element
}

/**
 * The quote confirmation (DESIGN §3.3, §10; product H8) for every way a composer makes text
 * public: a comment, a review, a diff comment or reply, a pending comment, an edit, a new issue
 * or PR.
 */
export function useQuoteGate(): QuoteGate {
  const [ask, setAsk] = useState<{ readonly go: () => void } | null>(null)
  const check = useCallback<QuoteGate['check']>((publicText, membersTexts, go, opts = {}) => {
    if (publicTextQuotes(publicText, membersTexts, opts)) setAsk({ go })
    else go()
  }, [])
  const dialog = (
    <QuoteConfirmDialog
      open={ask !== null}
      onCancel={() => setAsk(null)}
      onConfirm={() => {
        const go = ask?.go
        setAsk(null)
        go?.()
      }}
    />
  )
  return { check, dialog }
}

/**
 * "Close with comment" (QW2-008) through the quote gate: a public comment that repeats
 * members-only text asks first; confirmed, the close goes ahead with the comment (`confirm`);
 * cancelled, nothing happens (never a close that silently leaves the comment out).
 */
export function closeWithComment<P extends { readonly comment?: string }>(gate: QuoteGate, audience: ComposerAudience, membersTexts: MembersTexts, pending: P, confirm: (p: P) => void): void {
  gate.check(audience === 'public' ? pending.comment ?? null : null, membersTexts, () => confirm(pending))
}

// ---------------------------------------------------------------------------
// Turning members-only content on
// ---------------------------------------------------------------------------

/**
 * What a key-aware members change (add, remove, change a role in a repo with members-only content)
 * waits on in this tab: the inline unlock while the encryption key is locked here (a reload keeps
 * only the signing key), else null. `active`: its dialog is open and the change shares the key.
 */
export function useMembersKeyBlock(active: boolean, network: Network): JSX.Element | null {
  const { identity, unlockScope } = useAuth()
  const key = useAsync(() => encryptionKeyState(network, identity!), [network, identity ?? '', unlockScope ?? ''], { enabled: identity !== null && active })
  if (!active || key.data !== 'locked') return null
  return <UnlockMore title={UNLOCK_MEMBERS_ONLY} testId="members-key-unlock" forgot={false} />
}

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
  // Who gets a key: every member who holds the members key, and the maintainer turning it on
  // (listed or not). Unknown until the members are read: no cost is shown, and Turn on waits.
  const holders = members.data === null ? null : new Set([...keyHolders(members.data), ...(identity !== null ? [identity] : [])]).size
  // Bots get a key for their own members-only posts (§23), not the members key.
  const bots = members.data === null ? 0 : botsOf(members.data).length
  const [lead, costLine, older] = turnOnText(holders ?? 1, bots)
  const retry = (what: string, onRetry: () => void, testId: string): JSX.Element => (
    <p className="text-dense text-danger-700 dark:text-danger-400" role="alert" data-testid={testId}>
      {what}{' '}
      <button type="button" onClick={onRetry} className="hit-area font-medium text-forge-700 underline dark:text-forge-400">
        Retry
      </button>
    </p>
  )
  const blocked =
    identity === null ? (
      <p className="text-dense">Sign in as a maintainer of this repo to turn it on.</p>
    ) : members.error !== null ? (
      retry(`Couldn't read this repo's members: ${members.error}`, members.reload, 'turn-on-members-error')
    ) : holders === null ? (
      <p className={cn('text-dense', MUTED)} data-testid="turn-on-reading-members">
        Reading the members…
      </p>
    ) : key.error !== null ? (
      retry(`Couldn't read your encryption key: ${key.error}`, key.reload, 'turn-on-key-error')
    ) : key.data === null ? (
      <p className={cn('text-dense', MUTED)} data-testid="turn-on-reading-keys">
        Reading your keys…
      </p>
    ) : key.data === 'locked' ? (
      // Checked before the write context: a tab reloaded since sign-in has one, but Turn on still
      // needs the encryption key unlocked here.
      <UnlockMore title={UNLOCK_MEMBERS_ONLY} testId="turn-on-unlock" forgot={false} />
    ) : key.data === 'none' ? (
      <p className="text-dense" data-testid="turn-on-no-key">
        Members-only content needs your encryption key in this browser.{' '}
        <Link href={PRIVATE_REPOS_SETTINGS} className="hit-area font-medium text-forge-700 underline dark:text-forge-400">
          {SET_UP_KEY}
        </Link>
      </p>
    ) : write.context !== null ? null : write.error ? (
      retry(`Couldn't open your encryption key: ${write.error}`, () => write.retry?.(), 'turn-on-key-error')
    ) : write.loading !== false ? (
      <p className={cn('text-dense', MUTED)} data-testid="turn-on-reading-keys">
        Reading your keys…
      </p>
    ) : (
      // Read, and still nothing to write with (the key went away meanwhile): say so, never wait.
      retry("Your encryption key isn't available in this tab.", () => {
        key.reload()
        write.retry?.()
      }, 'turn-on-key-error')
    )
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Turn on members-only content?"
      description={lead}
      cost={holders === null ? 'pending' : previewCredits(enableEstimate(holders, bots))}
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
      {(holders === null ? [older] : [costLine, older]).map((p) => (
        <p key={p} className="text-dense text-anvil-700 dark:text-anvil-200" data-testid={p === costLine ? 'turn-on-cost' : undefined}>
          {p}{p === costLine ? <FiatNote dash={creditsToDash(enableEstimate(holders ?? 1, bots))} /> : null}
        </p>
      ))}
    </ConfirmDialog>
  )
}

// ---------------------------------------------------------------------------
// What a reader who cannot open members-only content sees
// ---------------------------------------------------------------------------

/**
 * "Members-only comment · @alice · 2h ago" (DESIGN D14, §10); a message to specific people says
 * how many it went to, "Comment to 3 people · @alice · 2h ago" (and "Unlock to read" while this
 * tab can't try it); a review says its public verdict.
 */
export function MembersOnlyRow({ entry }: { entry: MembersOnlyEntry }): JSX.Element {
  const { item, verdict } = entry
  const [unlocking, setUnlocking] = useState(false)
  const did = verdict === 'approve' ? 'approved' : verdict === 'requestChanges' ? 'requested changes' : null
  const letter = isLetter(item)
  return (
    <div
      className="space-y-2 rounded-lg border border-dashed border-anvil-300 px-4 py-2 text-dense text-anvil-600 dark:border-anvil-700 dark:text-anvil-300"
      data-testid="members-only-placeholder"
      data-type={item.type}
      data-audience={letter ? 'specificPeople' : 'members'}
      {...(item.recipientCount !== undefined ? { 'data-recipients': item.recipientCount } : {})}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {letter ? <Users className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        <span>
          {placeholderTitle(item)} · <Author identityId={item.author} link={false} className="align-middle" />
          {did !== null ? ` ${did}` : ''} · <span className={MUTED}>{timeAgo(item.createdAt)}</span>
        </span>
        {item.locked === true ? (
          <>
            <span aria-hidden> · </span>
            <button type="button" className="hit-area font-medium text-forge-700 hover:underline dark:text-forge-400" aria-expanded={unlocking} onClick={() => setUnlocking((u) => !u)} data-testid="letter-unlock">
              Unlock to read
            </button>
          </>
        ) : null}
      </p>
      {unlocking ? <UnlockMore title={UNLOCK_LETTERS} testId="letter-unlock-panel" forgot={false} /> : null}
      {item.why === 'notABot' ? (
        <p className={MUTED} data-testid="not-a-bot">
          {NOT_A_BOT_TEXT}
        </p>
      ) : null}
      {item.editedAfterBy !== undefined ? (
        <p className={MUTED} data-testid="edited-after-public">
          Edited after <Author identityId={item.editedAfterBy} link={false} className="align-middle" /> made it public; the new text is members-only.
        </p>
      ) : null}
    </div>
  )
}

/**
 * A locked member's one line over every placeholder of a thread: "3 members-only comments ·
 * Unlock to read" (DESIGN §4.8); a member with no key in this browser, or none shared yet, is
 * told that instead.
 */
export function MembersOnlySummary({ entries, lane }: { entries: readonly MembersOnlyEntry[]; lane: MembersAccess | undefined }): JSX.Element | null {
  if (entries.length === 0) return null
  return <MembersLockedLine what={lockedCount(entries.map((e) => e.item))} lane={lane} />
}

/**
 * The line a member whose tab can't read members-only content yet sees over `what` this page
 * holds of it: "`what` · Unlock to read", or how to set up their key. Null for anyone else.
 */
export function MembersLockedLine({ what, lane, testId = 'members-only-locked' }: { what: string; lane: MembersAccess | undefined; testId?: string }): JSX.Element | null {
  const [unlocking, setUnlocking] = useState(false)
  const { identity } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const why = memberCantRead(lane)
  if (why === null) return null
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-anvil-300 px-4 py-2 text-dense text-anvil-600 dark:border-anvil-700 dark:text-anvil-300" data-testid={testId}>
      <p className="flex flex-wrap items-center gap-x-2">
        <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{what}</span>
        {why === 'locked' ? (
          <>
            <span aria-hidden> · </span>
            <button type="button" className="hit-area font-medium text-forge-700 hover:underline dark:text-forge-400" aria-expanded={identity === null ? undefined : unlocking} onClick={() => (identity === null ? openLogin() : setUnlocking((u) => !u))} data-testid="members-only-unlock">
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
      {why === 'no-key-shared' ? <p data-testid="members-only-no-key-shared">{NO_KEY_SHARED_TEXT}</p> : null}
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

/**
 * The label of a card this reader opened that isn't public: "Visible to members", or for a
 * message to specific people "Visible to alice, bob and you" (`letter-picker.tsx`).
 */
export function AudienceMark({
  audience,
  letter,
  what,
  writtenWhilePrivate,
}: {
  audience: 'members' | 'specificPeople' | undefined
  letter?: LetterFacts | undefined
  what?: 'review'
  /** Written while the repo (made public since) was private: "Public · written while private". */
  writtenWhilePrivate?: boolean | undefined
}): JSX.Element | null {
  if (writtenWhilePrivate === true && audience !== 'specificPeople') return <WrittenWhilePrivate members={audience === 'members'} />
  if (audience === 'members') return <VisibleToMembers {...(what ? { what } : {})} />
  if (audience === 'specificPeople' && letter !== undefined) return <VisibleToPeople letter={letter} {...(what ? { what } : {})} />
  return null
}

/**
 * The label of a post written while the repo (made public since) was private (DESIGN §4.10, §10):
 * "Public · written while private" when the owner made everything written then public, else
 * "Members-only · written while private" (a member reading it).
 */
export function WrittenWhilePrivate({ members }: { members: boolean }): JSX.Element {
  const Icon = members ? Lock : Globe
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-anvil-100 px-2 py-0.5 text-[11px] font-medium text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200"
      data-testid="written-while-private"
      data-audience={members ? 'members' : 'public'}
    >
      <Icon className="h-3 w-3" aria-hidden /> {writtenWhilePrivateLabel(members)}
    </span>
  )
}

/** A members-only card's tint (its border and header), for a card this reader opened. */
export const MEMBERS_CARD = 'border-anvil-400 dark:border-anvil-600'
export const MEMBERS_CARD_HEADER = 'bg-anvil-100 dark:bg-anvil-850'

/**
 * The page of an issue or PR this reader cannot open (DESIGN D14, D19): "#3 · members-only",
 * who opened it, when, its state and how many comments it has; never "not found". `children`:
 * what follows under it (its replies and a reply composer, `members-only-thread.tsx`).
 */
export function MembersOnlyTargetPage({ home, target, children }: { home: RepoHome; target: MembersOnlyTarget; children?: ReactNode }): JSX.Element {
  const kind = target.placeholder.type === 'patch' ? 'pull' : 'issue'
  const Icon = kind === 'pull' ? GitPullRequest : CircleDot
  const state = target.merged ? 'merged' : target.open ? 'open' : 'closed'
  const why = memberCantRead(home.lane)
  const letter = isLetter(target.placeholder)
  const noun = membersOnlyNoun(target.placeholder.type)
  const people = target.placeholder.recipientCount
  // A read cut at its page size says "100+", never a count it didn't finish.
  const comments = target.comments === 0 ? '' : target.moreComments === true ? ` · ${target.comments}+ comments` : ` · ${plural(target.comments, 'comment')}`
  return (
    <div className="space-y-4" data-testid="members-only-target" data-kind={kind}>
      <h1 className="text-2xl">
        <span className="font-mono">#{target.number}</span>{' '}
        <span className="text-anvil-500 dark:text-anvil-400">· {letter ? (people !== undefined ? `to ${peopleCount(people)}` : 'encrypted') : 'members-only'}</span>
      </h1>
      <p className="flex items-start gap-2 text-dense text-anvil-600 dark:text-anvil-300">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          {placeholderTitle(target.placeholder)} · opened by <Author identityId={target.placeholder.author} link={false} className="align-middle" />{' '}
          <span className={MUTED}>{timeAgo(target.placeholder.createdAt)}</span> · <span data-testid="members-only-state">{state}</span>
          <span data-testid="members-only-comments">{comments}</span>
        </span>
      </p>
      {target.placeholder.editedAfterBy !== undefined ? (
        <p className={MUTED} data-testid="edited-after-public">
          Edited after <Author identityId={target.placeholder.editedAfterBy} link={false} className="align-middle" /> made it public; the new text is members-only.
        </p>
      ) : null}
      <div className="rounded-lg border border-dashed border-anvil-300 px-4 py-3 text-dense dark:border-anvil-700" data-testid="members-only-why">
        {letter && target.placeholder.locked === true ? (
          <UnlockMore title={UNLOCK_LETTERS} testId="letter-target-unlock" forgot={false} />
        ) : letter ? (
          <p>
            {people !== undefined ? `This ${noun} was sent to ${peopleCount(people)}.` : `This ${noun} is encrypted for specific people.`} Everyone can see that it exists, who opened it
            and when.
          </p>
        ) : home.laneLoading === true ? (
          // A member's key session is still being read: no outsider's text meanwhile.
          <p className={MUTED} role="status" data-testid="members-only-reading">
            Reading members-only content…
          </p>
        ) : target.placeholder.why === 'notABot' ? (
          <p data-testid="not-a-bot">{NOT_A_BOT_TEXT}</p>
        ) : why === 'locked' ? (
          <UnlockMore title={UNLOCK_MEMBERS_ONLY} testId="members-only-target-unlock" forgot={false} />
        ) : why === 'no-key' ? (
          <p>
            Only members of this repo can read this {noun}.{' '}
            <Link href={PRIVATE_REPOS_SETTINGS} className="hit-area font-medium text-forge-700 underline dark:text-forge-400">
              {SET_UP_KEY}
            </Link>{' '}
            to read it here.
          </p>
        ) : why === 'no-key-shared' ? (
          <p data-testid="members-only-no-key-shared">{NO_KEY_SHARED_TEXT}</p>
        ) : home.lane?.access === 'bot' ? (
          <p data-testid="members-only-bot">{BOT_READ_TEXT}</p>
        ) : home.lane?.access === 'former' ? (
          <p>You can&apos;t read this one. It was written after you stopped being a member of this repo.</p>
        ) : home.lane?.access === 'member' ? (
          <p>You can&apos;t read this one. It was written with a key you don&apos;t hold.</p>
        ) : (
          <p>Only members of this repo can read this {noun}. Everyone can see that it exists, who opened it and when.</p>
        )}
      </div>
      {children}
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
 * After a create whose "Turn on members-only content now" did not finish (`/new` adds
 * `membersOnly=failed`): the repo stands without it, so say so and offer the sheet, while it is
 * still off. Only its owner sees it.
 */
export function MembersOnlyCreateNotice({ home }: { home: RepoHome }): JSX.Element | null {
  const [turnOn, setTurnOn] = useState(false)
  const { identity } = useAuth()
  const failed = useParam('membersOnly') === 'failed'
  // Only for the owner who just created it: a shared link shows nobody else this.
  if (!failed || identity !== home.repo.ownerId || home.repo.visibility !== 'public' || home.lane?.access !== 'none') return null
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense" role="status" data-testid="members-only-create-notice">
      <Lock className="h-3.5 w-3.5 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
      <span className="flex-1">Your repo is created. Members-only content isn&apos;t set up yet.</span>
      <Button size="sm" variant="outline" onClick={() => setTurnOn(true)} data-testid="create-notice-turn-on">
        Finish setting up
      </Button>
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

/** The header's members-only chip, for a member of a repo where it is on: what it means, on a click or a tap. */
export function MembersChip({ home }: { home: RepoHome }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const id = useId()
  const access = home.lane?.access
  if (home.repo.visibility !== 'public' || access === undefined || access === 'none') return null
  const about =
    access === 'member'
      ? 'This repo has members-only content. You can read it.'
      : access === 'former'
        ? 'This repo has members-only content. You can read what was written while you were a member.'
      : access === 'locked'
        ? 'This repo has members-only content. Unlock this tab to read it.'
        : access === 'no-key'
          ? 'This repo has members-only content. Set up your encryption key to read it.'
          : access === 'bot'
            ? `This repo has members-only content. ${BOT_READ_TEXT}`
            : `This repo has members-only content. ${NO_KEY_SHARED_TEXT}`
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        data-testid="members-chip"
        data-access={access}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={`${id}-about`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded bg-anvil-100 px-1.5 py-0.5 text-[11px] text-anvil-600 hover:text-anvil-900 coarse:min-h-11 dark:bg-anvil-800 dark:text-anvil-300 dark:hover:text-anvil-50"
      >
        <Lock className="h-3 w-3" aria-hidden />
        Members-only content
      </button>
      <span id={`${id}-about`} className="sr-only">
        {about}
      </span>
      {open ? (
        <span
          id={id}
          role="note"
          data-testid="members-chip-about"
          className="absolute left-0 top-full z-30 mt-1 w-[min(18rem,calc(100vw-2rem))] rounded-md border border-anvil-200 bg-white px-3 py-2 text-[12px] text-anvil-700 shadow-lg dark:border-anvil-750 dark:bg-anvil-950 dark:text-anvil-200"
        >
          {about}
        </span>
      ) : null}
    </span>
  )
}

/** "View as public", for a member of a public repo with members-only content on. */
export function ViewAsPublicButton({ home }: { home: RepoHome }): JSX.Element | null {
  const [, setPublicView] = usePublicView(home.repo.repoId)
  const ref = useRef<HTMLButtonElement>(null)
  const access = home.lane?.access
  const shown = home.repo.visibility === 'public' && access !== undefined && access !== 'none'
  // Back from the public view (the page remounted): focus returns here, where it left.
  useEffect(() => {
    if (shown && takePublicViewFocus(home.repo.repoId, 'enter')) ref.current?.focus()
  }, [shown, home.repo.repoId])
  if (!shown) return null
  return (
    <div className="mb-3 flex justify-end">
      <Button ref={ref} variant="ghost" size="sm" onClick={() => setPublicView(true)} data-testid="view-as-public">
        <Eye className="h-3.5 w-3.5" aria-hidden /> View as public
      </Button>
    </div>
  )
}

/** The banner over a page shown as the public sees it, with the way back. */
export function PublicViewBanner({ repoId, onExit }: { repoId: string; onExit: () => void }): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  // Just switched on (the page remounted under it): focus lands on the way back.
  useEffect(() => {
    if (takePublicViewFocus(repoId, 'exit')) ref.current?.focus()
  }, [repoId])
  return (
    <div role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-anvil-300 bg-anvil-50 px-3 py-2 text-dense text-anvil-800 dark:border-anvil-700 dark:bg-anvil-850 dark:text-anvil-100" data-testid="public-view-banner">
      <EyeOff className="h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
      <span className="min-w-0 flex-1">{VIEWING_AS_PUBLIC}</span>
      <Button ref={ref} variant="outline" size="sm" onClick={onExit} data-testid="exit-public-view">
        Back to your view
      </Button>
    </div>
  )
}
