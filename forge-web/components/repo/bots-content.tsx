'use client'

/**
 * Settings → Bots and runners (mixed-visibility DESIGN §4.9, §10 "Bots and runners";
 * `docs/security/private-repos.md` §22.1): what each bot may do here, as everyone reads it (the
 * public line of its current access notice), and the repo's CI runners. A maintainer gives a bot
 * access, changes it, or takes it away here, as `dg bot allow` and `dg bot revoke` do: each save
 * writes a new notice naming the one it replaces.
 *
 * Push access (phase 4E, `./bot-push.tsx`): where the contract has push grants, each bot's row says
 * where it may push and what needs attention, and a maintainer gives, renews, suspends, resumes or
 * removes it there; a bot with push access and no access settings gets a row too. Elsewhere the page
 * says "Bots can't push to this repo yet." The Access form keeps the push fields as they are (as
 * `dg bot allow` without `--push` does), and abilities and fields a later version wrote are kept on a
 * change, so saving here never takes them away. Remove access also removes the push access the
 * signer gave (`dg bot revoke`).
 */

import { useState } from 'react'
import Link from 'next/link'
import { Bot, ChevronLeft, Plus, Server } from 'lucide-react'

import type { RepoHome } from '@/lib/view'
import {
  MAY_CI_MEMBERS_BRANCHES,
  MAY_POST,
  MAY_POST_MEMBERS_ONLY,
  MAY_PUSH,
  MAY_READ_ON_REQUEST,
  PROCESSOR_MAX,
  emptyNotice,
  hexToBytes,
  noticeToTyped,
  publicLine,
  type AccessNotice,
  type Askers,
  type NoticeEntry,
} from '@/lib/private'
import { decodeIdentifier } from '@/lib/auth/base58'
import { repoContractIds } from '@/lib/repo'
import { readRunnersCached } from '@/lib/repo/checks'
import { botHasEncryptionKey, botIdOf, canChangeBotAccess, membersSession, noticeCredits, readAccessNotices, writeAccessNotice } from '@/lib/repo/bot-access'
import { resolvePerson } from '@/lib/repo/person-input'
import { PUSH_NOT_YET, PUSH_NOT_YET_HINT, deleteOwnGrants, privateRepoWords, pushAccessOf, readGrantableBranches, readPushState, type GrantableBranch, type PushState } from '@/lib/repo/push-grants'
import { previewCredits } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { useDpnsName } from '@/hooks/use-dpns-name'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ErrorState, LoadingBlock } from '@/components/ui/states'
import { PrivateRepoState } from '@/components/repo/private-repo-state'
import { useHandle } from '@/components/repo/bot-handle'
import { BotPushSection, PushDialog, type PushAction } from '@/components/repo/bot-push'
import { shortId } from '@/lib/utils'

/** The empty state (DESIGN §10). */
export const BOTS_EMPTY_TEXT =
  'No bots yet. A bot can report checks, post comments and work on pull requests you ask it to. It only reads members-only content when someone asks it to work on that thread.'

export { handleOf, useHandle } from '@/components/repo/bot-handle'

/** What the page reads. */
interface BotsRead {
  readonly current: readonly NoticeEntry[]
  readonly unreadable: number
  readonly runners: readonly string[]
  /** The viewer may change access: the owner or a current maintainer. */
  readonly maintainer: boolean
  /** The bots' push access: every grant and the members (`supported` false, nothing read, before the registration). */
  readonly push: PushState
  /** The members-only branches this maintainer holds the key of, to name exact grants. */
  readonly branches: readonly GrantableBranch[]
}

export function BotsContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  // A private repo's access notices are its members' (as its settings are).
  const access = home.private?.access ?? 'outsider'
  if (home.repo.visibility === 'private' && (access === 'signed-out' || access === 'outsider')) {
    return <PrivateRepoState repo={home.repo} addr={addr} access={access} />
  }
  return <Bots home={home} addr={addr} />
}

/** One change a maintainer is making: give or change a bot's access, take it away, or change its push access. */
type Change =
  | { readonly kind: 'edit'; readonly bot: string; readonly previous: NoticeEntry | null }
  | { readonly kind: 'remove'; readonly entry: NoticeEntry }
  | { readonly kind: 'push'; readonly action: PushAction }

function Bots({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const repo = home.repo
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity } = useAuth()
  const session = membersSession(repo)
  const state = useAsync<BotsRead>(
    async () => {
      const [notices, runners, maintainer, push] = await Promise.all([readAccessNotices(sdk!, repo), readRunnersCached(sdk!, repo), canChangeBotAccess(sdk!, repo, identity), readPushState(sdk!, repo)])
      // an exact grant's branch is named only for a maintainer holding its key
      const branches = push.grants.some((g) => g.scope !== undefined) ? await readGrantableBranches(sdk!, repo) : []
      return { current: [...notices.current.values()], unreadable: notices.unreadable, runners, maintainer, push, branches }
    },
    [ready, network, repo.repoId, identity ?? '', session?.id ?? ''],
    { enabled: ready && sdk !== null },
  )
  const [change, setChange] = useState<Change | null>(null)
  const data = state.data
  const canEdit = data?.maintainer === true && identity !== null
  const display = useRepoDisplay(home)
  return (
    <div className="max-w-3xl space-y-5" data-testid="bots">
      <Link
        href={repoHref('/repo/settings', addr)}
        className="hit-area inline-flex items-center gap-1 text-dense text-anvil-600 hover:text-anvil-900 dark:text-anvil-300 dark:hover:text-anvil-50"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden /> Settings
      </Link>
      <div>
        <h2 id="bots-title" className="flex items-center gap-2 text-prose">
          <Bot className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden /> Bots and runners
        </h2>
        {data !== null && !canEdit ? (
          <p className="mt-1 text-dense text-anvil-600 dark:text-anvil-300" data-testid="bots-edit-hint">
            Only maintainers can change what a bot may do, here or with dg: <code className="font-mono text-[12px]">dg bot allow</code>
          </p>
        ) : null}
      </div>
      {state.error !== null ? (
        <ErrorState message={state.error} cause={state.cause} onRetry={state.reload} />
      ) : data === null ? (
        <LoadingBlock label="Reading bots and runners" />
      ) : (
        <>
          <BotsView
            current={data.current}
            runners={data.runners}
            unreadable={data.unreadable}
            now={Date.now()}
            push={data.push}
            branches={data.branches}
            me={identity}
            {...(repo.visibility === 'private' ? { privateRepo: display } : {})}
            {...(canEdit
              ? {
                  onEdit: (e: NoticeEntry) => setChange({ kind: 'edit', bot: botIdOf(e.notice), previous: e }),
                  onRemove: (e: NoticeEntry) => setChange({ kind: 'remove', entry: e }),
                  onPush: (action: PushAction) => setChange({ kind: 'push', action }),
                }
              : {})}
          />
          {canEdit ? <AddBot current={data.current} onPick={(bot, previous) => setChange({ kind: 'edit', bot, previous })} /> : null}
        </>
      )}
      {change?.kind === 'edit' ? <AccessDialog home={home} bot={change.bot} previous={change.previous} onClose={() => setChange(null)} onSaved={state.reload} /> : null}
      {change?.kind === 'remove' ? <RemoveDialog home={home} entry={change.entry} onClose={() => setChange(null)} onSaved={state.reload} /> : null}
      {change?.kind === 'push' ? <PushDialog home={home} display={display} action={change.action} onClose={() => setChange(null)} onSaved={state.reload} /> : null}
    </div>
  )
}

const LIST_CLASS = 'divide-y divide-anvil-200 rounded-lg border border-anvil-200 dark:divide-anvil-800 dark:border-anvil-800'

/**
 * Each bot's access as everyone reads it, and the runners (DESIGN §4.9 "How access looks"). With
 * `onEdit` / `onRemove` (a maintainer), each bot row offers Change access and Remove access. With
 * `push` (what the page read of push grants), each row says where the bot may push, a bot with push
 * access and no access settings gets a row, and `onPush` (a maintainer) offers the push changes;
 * before the registration the page says bots can't push here yet. `privateRepo` (the repo as the
 * copy names it, in a private repository) offers no Give or Renew and says why once.
 */
export function BotsView({
  current,
  runners,
  unreadable = 0,
  now,
  push,
  branches = [],
  me = null,
  privateRepo,
  onEdit,
  onRemove,
  onPush,
}: {
  current: readonly NoticeEntry[]
  runners: readonly string[]
  unreadable?: number
  now: number
  push?: PushState
  branches?: readonly GrantableBranch[]
  me?: string | null
  privateRepo?: string
  onEdit?: (e: NoticeEntry) => void
  onRemove?: (e: NoticeEntry) => void
  onPush?: (a: PushAction) => void
}): JSX.Element {
  const pushes = push?.supported === true ? push : null
  // bots with push access and no access settings (`dg bot list` lists them too)
  const bare = pushes === null ? [] : [...new Set(pushes.grants.map((g) => g.bot))].filter((b) => !current.some((e) => botIdOf(e.notice) === b))
  const pushOf = (bot: string, entry: NoticeEntry | null): JSX.Element | null =>
    pushes === null ? null : <BotPushSection access={pushAccessOf(pushes, bot, entry)} branches={branches} me={me} closed={privateRepo !== undefined} {...(onPush ? { onAction: onPush } : {})} />
  if (current.length === 0 && runners.length === 0 && bare.length === 0) {
    return (
      <p className="text-dense text-anvil-600 dark:text-anvil-300" data-testid="bots-empty">
        {BOTS_EMPTY_TEXT}
      </p>
    )
  }
  return (
    <div className="space-y-4">
      {current.length > 0 ? (
        <ul className={LIST_CLASS} data-testid="bot-list">
          {current.map((e) => (
            <BotRow key={e.id} entry={e} now={now} push={pushOf(botIdOf(e.notice), e)} {...(onEdit ? { onEdit } : {})} {...(onRemove ? { onRemove } : {})} />
          ))}
        </ul>
      ) : null}
      {bare.length > 0 ? (
        <ul className={LIST_CLASS} data-testid="bot-push-only-list">
          {bare.map((b) => (
            <BareBotRow key={b} bot={b} push={pushOf(b, null)} />
          ))}
        </ul>
      ) : null}
      {push !== undefined && !push.supported && current.length > 0 ? (
        <p className="text-dense text-anvil-600 dark:text-anvil-300" data-testid="bots-push-not-yet">
          {PUSH_NOT_YET} {PUSH_NOT_YET_HINT}
        </p>
      ) : null}
      {pushes !== null && privateRepo !== undefined && onPush !== undefined && (current.length > 0 || bare.length > 0) ? (
        <p className="text-dense text-anvil-600 dark:text-anvil-300" data-testid="bots-push-private">
          {privateRepoWords(privateRepo)}
        </p>
      ) : null}
      {runners.length > 0 ? (
        <ul className={LIST_CLASS} data-testid="runner-list">
          {runners.map((r) => (
            <li key={r} className="flex flex-wrap items-center gap-2 px-4 py-3 text-dense" data-testid="runner-row">
              <Server className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
              <Author identityId={r} />
              <span className="text-anvil-600 dark:text-anvil-300">CI runner</span>
            </li>
          ))}
        </ul>
      ) : null}
      {unreadable > 0 ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="bots-unreadable">
          {unreadable === 1 ? "1 access record couldn't be read." : `${unreadable} access records couldn't be read.`}
        </p>
      ) : null}
    </div>
  )
}

function BotRow({
  entry,
  now,
  push = null,
  onEdit,
  onRemove,
}: {
  entry: NoticeEntry
  now: number
  push?: JSX.Element | null
  onEdit?: (e: NoticeEntry) => void
  onRemove?: (e: NoticeEntry) => void
}): JSX.Element {
  const id = botIdOf(entry.notice)
  const handle = useHandle(id)
  const allows = entry.notice.may.length > 0
  // access that only lets it push: its push line says it ("has no access here" would contradict it)
  const onlyPush = push !== null && allows && entry.notice.may.every((m) => m === MAY_PUSH)
  return (
    <li className="space-y-1.5 px-4 py-3 text-dense" data-testid="bot-row">
      <div className="flex flex-wrap items-center gap-2">
        <Author identityId={id} />
        <span className="rounded-full bg-anvil-100 px-2 py-0.5 text-[12px] text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200">Bot</span>
      </div>
      {onlyPush ? null : (
        <p className="text-anvil-700 dark:text-anvil-200" data-testid="bot-public-line">
          {publicLine(entry.notice, handle, now)}
        </p>
      )}
      {push}
      {entry.notice.note !== '' ? <p className="whitespace-pre-wrap break-words text-anvil-600 dark:text-anvil-300">{entry.notice.note}</p> : null}
      <p className="flex flex-wrap items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400">
        Set by <Author identityId={entry.writer} link={false} />
      </p>
      {onEdit || onRemove ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {onEdit ? (
            <Button size="sm" onClick={() => onEdit(entry)} data-testid="bot-edit">
              {allows ? 'Change access' : 'Give access again'}
            </Button>
          ) : null}
          {onRemove && allows ? (
            <Button size="sm" variant="danger" onClick={() => onRemove(entry)} data-testid="bot-remove">
              Remove access
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/** A bot with push access and no access settings: its push line and notes. */
function BareBotRow({ bot, push }: { bot: string; push: JSX.Element | null }): JSX.Element {
  const handle = useHandle(bot)
  return (
    <li className="space-y-1.5 px-4 py-3 text-dense" data-testid="bot-row">
      <div className="flex flex-wrap items-center gap-2">
        <Author identityId={bot} />
        <span className="rounded-full bg-anvil-100 px-2 py-0.5 text-[12px] text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200">Bot</span>
      </div>
      <p className="text-anvil-700 dark:text-anvil-200" data-testid="bot-public-line">
        {handle} has no access settings here.
      </p>
      {push}
    </li>
  )
}

/** A maintainer names a bot (a DPNS name or an identity id) to give it access. */
function AddBot({ current, onPick }: { current: readonly NoticeEntry[]; onPick: (bot: string, previous: NoticeEntry | null) => void }): JSX.Element {
  const { sdk, network } = useSdk()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pick = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const got = await resolvePerson(sdk, network, text)
      if ('error' in got) {
        setError(got.error)
        return
      }
      onPick(got.id, current.find((e) => botIdOf(e.notice) === got.id) ?? null)
      setText('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void pick()
      }}
    >
      <Field label="Give a bot access" htmlFor="bot-add" hint="Its name, like ci-bot.dash, or its identity id.">
        <div className="flex gap-2">
          <Input id="bot-add" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} data-testid="bot-add-input" />
          <Button type="submit" disabled={busy || text.trim() === ''} loading={busy} data-testid="bot-add">
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add
          </Button>
        </div>
      </Field>
      {error !== null ? (
        <p role="alert" className="text-dense text-danger-700 dark:text-danger-400">
          {error}
        </p>
      ) : null}
    </form>
  )
}

/** `YYYY-MM-DD` of `ms` (UTC), for a date input ('' past what a JS date holds). */
function dayOf(ms: number | null): string {
  if (ms === null) return ''
  // the notice ends at the end of the day named (`dg` writes the next midnight): show that day
  const d = new Date(ms - 1)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/**
 * The last millisecond of day `YYYY-MM-DD` (UTC), so the access lasts through the day named and the
 * public line names that day; null for a bad date. (`dg bot allow --until` writes the next midnight,
 * which allows the same.)
 */
export function untilOfDay(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (m === null) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(ms) ? null : ms + 86_400_000 - 1
}

const ABILITIES: readonly (readonly [string, string])[] = [
  [MAY_POST, 'post comments and reviews'],
  [MAY_POST_MEMBERS_ONLY, "post members-only replies on threads it's asked about"],
  [MAY_READ_ON_REQUEST, "read pull requests and issues it's asked about"],
  [MAY_CI_MEMBERS_BRANCHES, 'run checks on members-only branches'],
]
const KNOWN = new Set(ABILITIES.map(([k]) => k))

/** The form's state. */
export interface AccessDraft {
  readonly may: ReadonlySet<string>
  readonly askers: Askers
  readonly processor: string
  /** `YYYY-MM-DD`, or '' for no end. */
  readonly until: string
}

/** The form's starting state: the bot's current access, else posting only, asked by writers. */
export function draftOf(previous: AccessNotice | null): AccessDraft {
  if (previous === null || previous.may.length === 0) return { may: new Set([MAY_POST]), askers: 'writers', processor: previous?.processor ?? '', until: '' }
  return { may: new Set(previous.may.filter((m) => KNOWN.has(m))), askers: previous.askers, processor: previous.processor ?? '', until: dayOf(previous.until) }
}

/**
 * The notice a draft saves for `bot`, or why not (forge-core `dg bot allow`): it allows
 * something, ends in the future, and fits; what a later version wrote (abilities and fields) is
 * carried over from `previous`, and it replaces `previous` (`revokes`).
 */
export function noticeOfDraft(bot: string, d: AccessDraft, previous: NoticeEntry | null, now: number): AccessNotice | { readonly error: string } {
  const carried = previous?.notice.may.filter((m) => !KNOWN.has(m)) ?? []
  const may = [...new Set([...carried, ...d.may])].sort()
  if (may.length === 0) return { error: 'That gives the bot nothing to do. To take its access away, use Remove access.' }
  const until = d.until.trim() === '' ? null : untilOfDay(d.until)
  if (d.until.trim() !== '' && until === null) return { error: 'Give a date like 2026-11-30.' }
  if (until !== null && until <= now) return { error: 'That date has passed.' }
  const processor = d.processor.trim()
  const notice: AccessNotice = {
    bot: decodeIdentifier(bot),
    may,
    askers: d.askers,
    threads: previous?.notice.threads ?? 'all',
    processor: processor === '' ? null : processor,
    until,
    revokes: previous === null ? [] : [hexToBytes(previous.packHash)],
    note: previous?.notice.note ?? '',
    extra: previous?.notice.extra ?? {},
  }
  if (noticeToTyped(notice) === null) return { error: `The service name is at most ${PROCESSOR_MAX} characters, with no control characters.` }
  return notice
}

/** The repo as the copy names it (`o/r`): its owner's DPNS name, else short id, and its name. */
export function useRepoDisplay(home: RepoHome): string {
  const owner = useDpnsName(home.repo.ownerId)
  return `${owner ?? shortId(home.repo.ownerId)}/${home.repo.name}`
}

/** The Access form (DESIGN §10), minus push: Save writes a new notice replacing the bot's current one. */
function AccessDialog({ home, bot, previous, onClose, onSaved }: { home: RepoHome; bot: string; previous: NoticeEntry | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const repo = home.repo
  const { sdk, ready } = useSdk(repoContractIds(repo))
  const { signer } = useAuth()
  const handle = useHandle(bot)
  const display = useRepoDisplay(home)
  const [draft, setDraft] = useState<AccessDraft>(() => draftOf(previous?.notice ?? null))
  const now = Date.now()
  const built = noticeOfDraft(bot, draft, previous, now)
  const reads = draft.may.has(MAY_READ_ON_REQUEST)
  const privateRepo = repo.visibility === 'private'
  // A private repo's notice goes to the bot too, so it needs the bot's key whatever it allows.
  const keyed = useAsync(() => botHasEncryptionKey(sdk!, repo, bot), [ready, repo.repoId, bot], { enabled: ready && sdk !== null && (reads || privateRepo) })
  const toggle = (m: string, on: boolean): void =>
    setDraft((d) => {
      const may = new Set(d.may)
      if (on) may.add(m)
      else may.delete(m)
      return { ...d, may }
    })
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={previous === null || previous.notice.may.length === 0 ? `Give ${handle} access?` : `Change ${handle}'s access?`}
      description="Everyone can see what a bot may do here."
      cost={previewCredits(noticeCredits(privateRepo))}
      confirmLabel="Save"
      {...('error' in built ? { blocked: <p className="text-dense text-danger-700 dark:text-danger-400" data-testid="access-problem">{built.error}</p> } : {})}
      onConfirm={async () => {
        if ('error' in built) throw new Error(built.error)
        if (sdk === null || signer === null) throw new Error('Sign in to change what a bot may do.')
        await writeAccessNotice(sdk, signer, repo, built, { name: handle, display })
        onSaved()
      }}
      successNote="Saved"
    >
      <fieldset className="space-y-2 text-dense" data-testid="access-form">
        <legend className="mb-1 font-medium text-anvil-800 dark:text-anvil-100">{handle} may</legend>
        {ABILITIES.map(([m, label]) => (
          <label key={m} className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={draft.may.has(m)} onChange={(e) => toggle(m, e.target.checked)} data-testid={`may-${m}`} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      {keyed.data === false && privateRepo ? (
        <p className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="access-no-key">
          {handle} has no encryption key yet, so its access in a private repo can&apos;t be saved until its operator adds one.
        </p>
      ) : keyed.data === false && reads ? (
        <p className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="access-no-key">
          {handle} has no encryption key yet, so it can&apos;t read what it&apos;s asked about until its operator adds one.
        </p>
      ) : null}
      <fieldset className="space-y-1 text-dense">
        <legend className="mb-1 font-medium text-anvil-800 dark:text-anvil-100">Who can ask it</legend>
        {(
          [
            ['writers', 'Writers and maintainers'],
            ['maintainers', 'Maintainers'],
          ] as const
        ).map(([v, label]) => (
          <label key={v} className="mr-4 inline-flex items-center gap-2">
            <input type="radio" name="bot-askers" checked={draft.askers === v} onChange={() => setDraft((d) => ({ ...d, askers: v }))} />
            {label}
          </label>
        ))}
      </fieldset>
      <Field label="Processed by" htmlFor="bot-processor" hint={`Members-only content you share with ${handle} is sent to this service.`}>
        <Input id="bot-processor" value={draft.processor} maxLength={PROCESSOR_MAX} onChange={(e) => setDraft((d) => ({ ...d, processor: e.target.value }))} placeholder="The AI service it uses, if any" />
      </Field>
      <Field label="Access ends" htmlFor="bot-until" hint="Leave empty for no end date.">
        <Input id="bot-until" type="date" value={draft.until} onChange={(e) => setDraft((d) => ({ ...d, until: e.target.value }))} />
      </Field>
      {'error' in built ? null : (
        <p className="rounded-md bg-anvil-50 px-3 py-2 text-dense text-anvil-700 dark:bg-anvil-900 dark:text-anvil-200" data-testid="access-preview">
          Everyone will read: {publicLine(built, handle, now)}
        </p>
      )}
    </ConfirmDialog>
  )
}

/** Remove access (DESIGN §10, adapted to a bot): a newer notice allowing nothing. */
function RemoveDialog({ home, entry, onClose, onSaved }: { home: RepoHome; entry: NoticeEntry; onClose: () => void; onSaved: () => void }): JSX.Element {
  const repo = home.repo
  const { sdk } = useSdk(repoContractIds(repo))
  const { signer } = useAuth()
  const bot = botIdOf(entry.notice)
  const handle = useHandle(bot)
  const display = useRepoDisplay(home)
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="Remove access"
      description={removeWords(handle)}
      cost={previewCredits(noticeCredits(repo.visibility === 'private'))}
      confirmLabel="Remove access"
      onConfirm={async () => {
        if (sdk === null || signer === null) throw new Error('Sign in to change what a bot may do.')
        await writeAccessNotice(sdk, signer, repo, { ...emptyNotice(entry.notice.bot), revokes: [hexToBytes(entry.packHash)] }, { name: handle, display })
        // the push access this maintainer gave goes too (only its writer can delete it; the notice
        // above already stops every push)
        try {
          await deleteOwnGrants(sdk, signer, repo, bot)
        } catch {
          onSaved()
          throw new Error(`${handle}'s access was removed, but the push access you gave it couldn't be removed yet. Try again from its row.`)
        }
        onSaved()
      }}
      successNote="Access removed"
    />
  )
}

/** The Remove access question (DESIGN §10, adapted to a bot). */
export function removeWords(handle: string): string {
  return `Stop ${handle}'s access? It gets nothing new from now on. What it was already given stays with it.`
}
