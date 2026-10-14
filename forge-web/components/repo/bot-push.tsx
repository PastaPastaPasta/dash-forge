'use client'

/**
 * A bot's push access in Settings → Bots and runners (phase 4E; mixed-visibility DESIGN §4.9
 * "Pushing", D42, §10 "Bots and runners"; `docs/security/private-repos.md` §24): the line everyone
 * reads ("Can push to bot/ci-bot/ until 7 Nov 2026."), a note per grant that needs attention
 * (Renew, ended, granter gone, re-added, missing from the access settings), and a maintainer's
 * changes, as `dg bot allow --push | renew | suspend | resume | revoke --push` make them:
 *
 * - **Give push access**: branches starting with a prefix (`bot/<name>/` by default), one branch
 *   (and every branch whose name starts with it), or a members-only branch shared with the bot that
 *   this maintainer holds the key of; until a date at most 90 days ahead; fast-forward only or
 *   force-pushes too; or pull requests instead. The grants are written first, then the notice
 *   listing them.
 * - **Renew** gives each branch or prefix a new end date; **Suspend** (any maintainer) stops every
 *   push at once with a notice without push; **Resume** lists the live grants again; **Remove my
 *   push access** deletes this maintainer's own grants.
 *
 * Shown only where the contract has push grants; elsewhere the page says "Bots can't push to this
 * repo yet." and offers nothing. The web never pushes as a bot.
 */

import { useMemo, useState } from 'react'

import type { RepoHome } from '@/lib/view'
import { hexToBytes, pushLine, type PushPolicy } from '@/lib/private'
import { matchesProtected } from '@/lib/rules'
import { defaultPrefix, prefixOf, shortPrefix, type PatternRefusal } from '@/lib/rules/push-grant'
import { repoContractIds } from '@/lib/repo'
import { noticeCredits } from '@/lib/repo/bot-access'
import {
  branchOfScope,
  coversBranch,
  givePush,
  grantWords,
  pushChangeCost,
  pushNoteWords,
  pushUntil,
  readBotPushAccess,
  readGrantableBranches,
  removeMyPush,
  renewPlan,
  renewPush,
  resumePush,
  shortBranch,
  summarizePush,
  suspendPush,
  suspended,
  type BotPushAccess,
  type GrantRequest,
  type GrantableBranch,
  type PushNote,
} from '@/lib/repo/push-grants'
import { previewCredits } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { useDpnsName } from '@/hooks/use-dpns-name'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useHandle } from '@/components/repo/bot-handle'

const DAY_MS = 86_400_000

/** A maintainer's push change, opened from a bot's row. */
export type PushAction =
  | { readonly kind: 'give'; readonly bot: string; readonly preset?: string }
  | { readonly kind: 'renew'; readonly bot: string }
  | { readonly kind: 'suspend'; readonly bot: string; readonly granters: readonly string[] }
  | { readonly kind: 'resume'; readonly bot: string }
  | { readonly kind: 'removeMine'; readonly bot: string }

/** How an exact grant's branch is named for this reader: its short name when this maintainer holds its key. */
function branchNamer(branches: readonly GrantableBranch[]): (scope: string) => string | null {
  return (scope) => {
    const b = branchOfScope(branches, scope)
    return b === undefined ? null : shortBranch(b.name)
  }
}

/**
 * A bot's push access as its row shows it: the push line (or "@ci-bot's pushes are suspended."), a
 * note per grant that needs attention, and, with `onAction` (a maintainer), the changes.
 */
export function BotPushSection({
  access,
  branches = [],
  me,
  onAction,
}: {
  access: BotPushAccess
  branches?: readonly GrantableBranch[]
  me: string | null
  onAction?: (a: PushAction) => void
}): JSX.Element | null {
  const handle = useHandle(access.bot)
  const s = summarizePush(access, branchNamer(branches))
  const line = s.suspended ? `${handle}'s pushes are suspended.` : pushLine(s.prefixes, s.membersBranches)
  const isSuspended = suspended(access)
  const mine = me !== null && access.grants.some((g) => g.granter === me && g.until > access.now)
  // push access is for a Bot member: someone without that row is offered none
  const canGive = access.botRowAt !== null
  if (line === null && s.notes.length === 0 && (onAction === undefined || (!canGive && !mine))) return null
  return (
    <div className="space-y-1" data-testid="bot-push">
      {line !== null ? (
        <p className="text-anvil-700 dark:text-anvil-200" data-testid="bot-push-line">
          {line}
        </p>
      ) : null}
      {s.notes.map((n) => (
        <PushNoteLine key={`${n.kind}:${n.grant.id}`} note={n} bot={handle} {...(onAction ? { onAction } : {})} />
      ))}
      {onAction ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {canGive ? (
            <Button size="sm" onClick={() => onAction({ kind: 'give', bot: access.bot })} data-testid="bot-push-give">
              Give push access
            </Button>
          ) : null}
          {s.renewable && s.notes.every((n) => n.kind !== 'renewDue' && n.kind !== 'expired') && s.live.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => onAction({ kind: 'renew', bot: access.bot })} data-testid="bot-push-renew">
              Renew
            </Button>
          ) : null}
          {!isSuspended && s.live.length > 0 ? (
            <Button size="sm" variant="danger" onClick={() => onAction({ kind: 'suspend', bot: access.bot, granters: s.granters })} data-testid="bot-push-suspend">
              Suspend pushes
            </Button>
          ) : null}
          {isSuspended && s.live.length > 0 ? (
            <Button size="sm" onClick={() => onAction({ kind: 'resume', bot: access.bot })} data-testid="bot-push-resume">
              Resume pushes
            </Button>
          ) : null}
          {mine ? (
            <Button size="sm" variant="danger" onClick={() => onAction({ kind: 'removeMine', bot: access.bot })} data-testid="bot-push-remove-mine">
              Remove my push access
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** One note (DESIGN §10's words) and, for a maintainer, what fixes it: Renew, or Give access again. */
function PushNoteLine({ note, bot, onAction }: { note: PushNote; bot: string; onAction?: (a: PushAction) => void }): JSX.Element {
  const granter = useHandle(note.grant.granter)
  const preset = note.grant.prefix !== undefined ? shortPrefix(note.grant.prefix) : undefined
  const fix =
    onAction === undefined ? null : note.kind === 'renewDue' || note.kind === 'expired' ? (
      <button type="button" className="hit-area font-medium text-forge-700 hover:underline dark:text-forge-400" onClick={() => onAction({ kind: 'renew', bot: note.grant.bot })} data-testid="bot-push-note-renew">
        Renew
      </button>
    ) : note.kind === 'granterGone' ? (
      <button
        type="button"
        className="hit-area font-medium text-forge-700 hover:underline dark:text-forge-400"
        onClick={() => onAction({ kind: 'give', bot: note.grant.bot, ...(preset !== undefined ? { preset } : {}) })}
        data-testid="bot-push-note-give"
      >
        Give access again
      </button>
    ) : null
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-caution-700 dark:text-caution-400" data-testid="bot-push-note" data-kind={note.kind}>
      <span>{pushNoteWords(note, bot, granter)}</span>
      {fix}
    </p>
  )
}

/** A branch pattern's refusal, as the dialog says it (forge-core `dg bot allow --push`'s words). */
export function refusalWords(pattern: string, why: PatternRefusal): string {
  const words: Record<PatternRefusal, string> = {
    empty: 'name a branch or a branch prefix.',
    notABranch: 'bots push to branches only.',
    notAPrefix: 'only a prefix can be given, like bot/ci-bot/ or bot/ci-bot/*.',
    malformed: "that isn't a branch name.",
  }
  return `${pattern.trim() === '' ? 'An empty name' : pattern.trim()}: ${words[why]}`
}

/**
 * The grants a dialog asks for (forge-core `dg bot allow --push`'s `requests`): each pattern as the
 * prefix it grants, then each chosen members-only branch shared with the bot under its key's current
 * generation; each once.
 */
export function requestsOf(patterns: readonly string[], shared: readonly GrantableBranch[]): { readonly requests: GrantRequest[] } | { readonly error: string } {
  const out: GrantRequest[] = []
  for (const p of patterns) {
    const got = prefixOf(p)
    if ('refused' in got) return { error: refusalWords(p, got.refused) }
    if (!out.some((r) => 'prefix' in r.scope && r.scope.prefix === got.prefix)) out.push({ scope: { prefix: got.prefix }, label: shortPrefix(got.prefix) })
  }
  for (const b of shared) out.push({ scope: { exact: hexToBytes(b.current) }, label: shortBranch(b.name) })
  return { requests: out }
}

/** `YYYY-MM-DD` (UTC) of `ms`. */
function dayIn(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The last millisecond of day `YYYY-MM-DD` (UTC), or null. */
function endOfDay(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (m === null) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(ms) ? null : ms + DAY_MS - 1
}

/** When push access ending on `day` ends, or why not. */
function endOf(day: string, now: number): number | { readonly error: string } {
  const ms = endOfDay(day)
  return ms === null ? { error: 'Give a date like 2026-11-30.' } : pushUntil(now, ms)
}

/** Who can stop it, as the dialogs say it (DESIGN §4.9 "Revocation"). */
const WHO_STOPS = 'Only you, who gave this access, or the owner can remove it. Any maintainer can suspend it.'

/** The dialog of `action`, for the bot it names. `display` is the repo as the copy names it (`o/r`). */
export function PushDialog({ home, display, action, onClose, onSaved }: { home: RepoHome; display: string; action: PushAction; onClose: () => void; onSaved: () => void }): JSX.Element {
  switch (action.kind) {
    case 'give':
      return <GiveDialog home={home} display={display} bot={action.bot} preset={action.preset ?? null} onClose={onClose} onSaved={onSaved} />
    case 'renew':
      return <RenewDialog home={home} display={display} bot={action.bot} onClose={onClose} onSaved={onSaved} />
    case 'suspend':
    case 'resume':
    case 'removeMine':
      return <NoticeChangeDialog home={home} display={display} action={action} onClose={onClose} onSaved={onSaved} />
  }
}

/** Give push access (DESIGN §10 "Access": "push to branches … Push access ends [date] (at most 90 days)"). */
function GiveDialog({ home, display, bot, preset, onClose, onSaved }: { home: RepoHome; display: string; bot: string; preset: string | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const repo = home.repo
  const { sdk, ready } = useSdk(repoContractIds(repo))
  const { signer } = useAuth()
  const handle = useHandle(bot)
  const named = useDpnsName(bot) !== undefined
  const now = useMemo(() => Date.now(), [])
  // the default prefix waits for the bot's name: `bot/ci-bot/`, else its id
  const [patterns, setPatterns] = useState<readonly string[] | null>(preset === null ? null : [preset])
  const shown = patterns ?? [shortPrefix(defaultPrefix(named ? handle : bot))]
  const [text, setText] = useState('')
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [day, setDay] = useState(() => dayIn(now + 30 * DAY_MS))
  const [force, setForce] = useState(false)
  const [openPr, setOpenPr] = useState(false)
  const branches = useAsync(() => readGrantableBranches(sdk!, repo), [ready, repo.repoId], { enabled: ready && sdk !== null && repo.visibility === 'public' })
  const shareable = (branches.data ?? []).filter((b) => b.audienceNow.has(bot))
  const built = requestsOf(
    shown,
    shareable.filter((b) => chosen.has(b.name)),
  )
  const end = endOf(day, now)
  const problem = 'error' in built ? built.error : typeof end !== 'number' ? end.error : built.requests.length === 0 ? 'Choose a branch or a branch prefix.' : null
  const requests = 'error' in built ? [] : built.requests
  const unprotected = !matchesProtected(`refs/heads/${home.defaultBranch}`, home.config?.protectedPatterns ?? []) && requests.some((r) => coversBranch(r, home.defaultBranch))
  const policy: PushPolicy = { fastForwardOnly: !force, deleteOwnOnly: !force, openPrNotPush: openPr }
  const add = (): void => {
    const t = text.trim()
    if (t === '') return
    setPatterns([...shown, t])
    setText('')
  }
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Let ${handle} push?`}
      description={WHO_STOPS}
      cost={pushChangeCost(requests.length, repo.visibility === 'private')}
      confirmLabel="Give push access"
      {...(problem !== null ? { blocked: <p className="text-dense text-danger-700 dark:text-danger-400" data-testid="push-problem">{problem}</p> } : {})}
      onConfirm={async (intent) => {
        if (problem !== null || typeof end !== 'number') throw new Error(problem ?? 'Give a date like 2026-11-30.')
        if (sdk === null || signer === null) throw new Error('Sign in to change what a bot may do.')
        await givePush(sdk, signer, repo, { bot, name: handle, display }, { requests, until: end, policy }, intent)
        onSaved()
      }}
      successNote="Push access given"
    >
      <fieldset className="space-y-2 text-dense" data-testid="push-form">
        <legend className="mb-1 font-medium text-anvil-800 dark:text-anvil-100">Push to branches</legend>
        <ul className="flex flex-wrap gap-1.5">
          {shown.map((p, i) => (
            <li key={`${p}:${i}`} className="inline-flex items-center gap-1 rounded-full bg-anvil-100 px-2 py-0.5 font-mono text-[12px] dark:bg-anvil-800" data-testid="push-pattern">
              {p}
              <button type="button" className="hit-area text-anvil-500 hover:text-anvil-900 dark:hover:text-anvil-50" aria-label={`Remove ${p}`} onClick={() => setPatterns(shown.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <label htmlFor="push-add" className="sr-only">
            Add a branch
          </label>
          <Input
            id="push-add"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder="gh-pages, or a prefix like bot/ci-bot/"
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[13px]"
            data-testid="push-add-input"
          />
          <Button type="button" onClick={add} disabled={text.trim() === ''} data-testid="push-add">
            Add a branch
          </Button>
        </div>
        {shareable.length > 0 ? (
          <div className="space-y-1">
            <p className="text-anvil-600 dark:text-anvil-300">Members-only branches shared with {handle}:</p>
            {shareable.map((b) => (
              <label key={b.name} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={chosen.has(b.name)}
                  onChange={(e) =>
                    setChosen((c) => {
                      const next = new Set(c)
                      if (e.target.checked) next.add(b.name)
                      else next.delete(b.name)
                      return next
                    })
                  }
                  data-testid="push-members-branch"
                />
                <span className="font-mono text-[13px]">{shortBranch(b.name)}</span>
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>
      <Field label="Push access ends" htmlFor="push-until" hint="At most 90 days.">
        <Input id="push-until" type="date" value={day} onChange={(e) => setDay(e.target.value)} data-testid="push-until" />
      </Field>
      <fieldset className="space-y-1 text-dense">
        <legend className="mb-1 font-medium text-anvil-800 dark:text-anvil-100">How it pushes</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="push-force" checked={!force} onChange={() => setForce(false)} />
          Fast-forward only
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="push-force" checked={force} onChange={() => setForce(true)} data-testid="push-allow-force" />
          Allow force-pushes and deleting its branches
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={openPr} onChange={(e) => setOpenPr(e.target.checked)} data-testid="push-open-pr" />
          Open pull requests instead of pushing to existing branches
        </label>
      </fieldset>
      {typeof end === 'number' && requests.length > 0 ? (
        <div className="space-y-1 rounded-md bg-anvil-50 px-3 py-2 text-dense text-anvil-700 dark:bg-anvil-900 dark:text-anvil-200" data-testid="push-preview">
          {requests.map((r, i) => (
            <p key={`${i}:${r.label}`}>{grantWords(handle, r, end)}</p>
          ))}
        </div>
      ) : null}
      {unprotected ? (
        <p className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="push-default-unprotected">
          The default branch {home.defaultBranch} isn&apos;t protected, so {handle} could push to it.
        </p>
      ) : null}
    </ConfirmDialog>
  )
}

/** Renew (DESIGN §10: "@ci-bot's push access to bot/ci-bot/ ends in 9 days. Renew"): a new end date for every branch it may push to. */
function RenewDialog({ home, display, bot, onClose, onSaved }: { home: RepoHome; display: string; bot: string; onClose: () => void; onSaved: () => void }): JSX.Element {
  const repo = home.repo
  const { sdk, ready } = useSdk(repoContractIds(repo))
  const { signer, identity } = useAuth()
  const handle = useHandle(bot)
  const now = useMemo(() => Date.now(), [])
  const [day, setDay] = useState(() => dayIn(now + 30 * DAY_MS))
  const read = useAsync(
    async () => {
      const access = await readBotPushAccess(sdk!, repo, bot)
      const branches = access.grants.some((g) => g.scope !== undefined) ? await readGrantableBranches(sdk!, repo) : []
      return { access, plan: renewPlan(access, branches) }
    },
    [ready, repo.repoId, bot],
    { enabled: ready && sdk !== null },
  )
  const end = endOf(day, now)
  const plan = read.data?.plan ?? []
  const deletes = plan.reduce((n, t) => n + t.old.filter((g) => g.granter === identity).length, 0)
  const problem =
    read.error !== null ? read.error : read.data === null ? null : plan.length === 0 ? `${handle} has no push access here to renew. Give it push access instead.` : typeof end !== 'number' ? end.error : null
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Renew ${handle}'s push access?`}
      description="Each branch it may push to gets a new end date. The older access you gave it is removed."
      cost={read.data === null ? 'pending' : pushChangeCost(plan.length, repo.visibility === 'private', deletes)}
      confirmLabel="Renew"
      {...(problem !== null ? { blocked: <p className="text-dense text-danger-700 dark:text-danger-400" data-testid="push-problem">{problem}</p> } : {})}
      onConfirm={async (intent) => {
        if (typeof end !== 'number') throw new Error(end.error)
        if (sdk === null || signer === null) throw new Error('Sign in to change what a bot may do.')
        await renewPush(sdk, signer, repo, { bot, name: handle, display }, end, intent)
        onSaved()
      }}
      successNote="Renewed"
    >
      <Field label="Push access ends" htmlFor="push-renew-until" hint="At most 90 days.">
        <Input id="push-renew-until" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
      </Field>
      {typeof end === 'number' && plan.length > 0 ? (
        <div className="space-y-1 rounded-md bg-anvil-50 px-3 py-2 text-dense text-anvil-700 dark:bg-anvil-900 dark:text-anvil-200" data-testid="push-preview">
          {plan.map((t, i) => (
            <p key={`${i}:${t.request.label}`}>{grantWords(handle, t.request, end)}</p>
          ))}
        </div>
      ) : null}
      {read.data !== null && suspended(read.data.access) ? (
        <p className="text-[12px] text-caution-700 dark:text-caution-400">Its pushes stay suspended: renewing gives it time, not its pushes back. Resume them when you want it to push again.</p>
      ) : null}
    </ConfirmDialog>
  )
}

/** The handles of `ids` as the copy lists them: `@a`, `@a and @b`, `@a, @b and @c`. */
function Handles({ ids }: { ids: readonly string[] }): JSX.Element {
  return (
    <>
      {ids.map((id, i) => (
        <span key={id}>
          {i === 0 ? '' : i === ids.length - 1 ? ' and ' : ', '}
          <HandleText id={id} />
        </span>
      ))}
    </>
  )
}

function HandleText({ id }: { id: string }): JSX.Element {
  return <>{useHandle(id)}</>
}

/** Suspend (any maintainer), Resume, and Remove my push access: one notice each (and, removing, this maintainer's grants). */
function NoticeChangeDialog({
  home,
  display,
  action,
  onClose,
  onSaved,
}: {
  home: RepoHome
  display: string
  action: Extract<PushAction, { kind: 'suspend' | 'resume' | 'removeMine' }>
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const repo = home.repo
  const { sdk } = useSdk(repoContractIds(repo))
  const { signer } = useAuth()
  const handle = useHandle(action.bot)
  const about = { bot: action.bot, name: handle, display }
  const noticeCost = previewCredits(noticeCredits(repo.visibility === 'private'))
  const run = async (write: (s: NonNullable<typeof sdk>, a: NonNullable<typeof signer>) => Promise<void>): Promise<void> => {
    if (sdk === null || signer === null) throw new Error('Sign in to change what a bot may do.')
    await write(sdk, signer)
    onSaved()
  }
  if (action.kind === 'suspend') {
    return (
      <ConfirmDialog
        open
        onClose={onClose}
        title={`Suspend ${handle}'s pushes?`}
        description="It stops pushing at once."
        cost={noticeCost}
        confirmLabel="Suspend"
        onConfirm={() => run((s, a) => suspendPush(s, a, repo, about))}
        successNote="Suspended"
      >
        <p className="text-dense text-anvil-700 dark:text-anvil-200" data-testid="push-suspend-who">
          Only <Handles ids={action.granters} />, who gave this access, or the owner can remove it.
        </p>
      </ConfirmDialog>
    )
  }
  if (action.kind === 'resume') {
    return (
      <ConfirmDialog
        open
        onClose={onClose}
        title={`Let ${handle} push again?`}
        description="It can push again under the push access it still has."
        cost={noticeCost}
        confirmLabel="Resume"
        onConfirm={() => run((s, a) => resumePush(s, a, repo, about))}
        successNote="Resumed"
      />
    )
  }
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Remove ${handle}'s push access?`}
      description={`${handle} can no longer push under the access you gave it. What it pushed stays.`}
      cost={pushChangeCost(0, repo.visibility === 'private', 1)}
      confirmLabel="Remove"
      onConfirm={() => run((s, a) => removeMyPush(s, a, repo, about))}
      successNote="Push access removed"
    />
  )
}
