'use client'

/**
 * The thread sidebar's "Agents" (mixed-visibility DESIGN §4.9 "Asking a bot", §10 "Ask"): each bot
 * whose current access notice is live and covers this thread, and, for a signed-in viewer, "Ask
 * @ci-bot" opening the Ask dialog. The dialog checks the bot's access against the viewer's role
 * before anything is signed (E813, `checkAsk`), says what the bot will get (the thread's
 * members-only comments as they are now) and who processes it, and takes the task (1–120
 * characters). Everyone sees that someone asked; on a members-only thread only members see what.
 */

import { useMemo, useState } from 'react'
import { Bot } from 'lucide-react'

import type { RepoHome } from '@/lib/view'
import { noticeCovers, noticeLiveAt, type AccessNotice, type NoticeEntry } from '@/lib/private'
import { repoContractIds } from '@/lib/repo'
import {
  AskRefusedError,
  TASK_PROBLEM,
  askCredits,
  askRefused,
  askSummary,
  askerRole,
  botIdOf,
  membersSession,
  planAsk,
  readAccessNoticesCached,
  requestWithinAccess,
  writeAsk,
  type AskAbout,
  type AskInput,
  type AskPlan,
  type AskTarget,
  type Notices,
} from '@/lib/repo/bot-access'
import { checkAsk, isTask, refusalWords, TASK_MAX, type AskRefusal } from '@/lib/rules/agent-request'
import { RoleOracle, type Membership, type Role } from '@/lib/rules/v2'
import type { AgentRequest } from '@/lib/rules/agent-request'
import { previewCredits } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SidebarSection } from '@/components/repo/target-rail'
import { useRepoDisplay } from '@/components/repo/bots-content'
import { useHandle } from '@/components/repo/bot-handle'

/** The bots a thread lists: a current notice that allows something, is live at `now` and covers thread `number`. */
export function agentsOf(notices: Notices | null, number: number, now: number): NoticeEntry[] {
  if (notices === null) return []
  return [...notices.current.values()].filter((e) => e.notice.may.length > 0 && noticeLiveAt(e.notice, now) && noticeCovers(e.notice, number))
}

export function AgentsSection({
  home,
  target,
  membersOnly,
  membersSource = false,
  specificPeople = false,
  onAsked,
}: {
  home: RepoHome
  target: AskTarget
  /** The thread is members-only (or the repo private): the task is members-only, and the bot must be let read on request. */
  membersOnly: boolean
  /** A pull request from a members-only branch: its code isn't included from the web. */
  membersSource?: boolean
  /** A message to specific people: no bot is asked about one, so the panel is not shown. */
  specificPeople?: boolean
  /** The request was written: the page reads the thread again. */
  onAsked: (event: string) => void
}): JSX.Element | null {
  const repo = home.repo
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity, signer } = useAuth()
  const session = membersSession(repo)
  const notices = useAsync(() => readAccessNoticesCached(sdk!, repo), [ready, network, repo.repoId, session?.id ?? ''], { enabled: ready && sdk !== null })
  const role = useAsync<Role | null>(() => askerRole(sdk!, repo, identity!, network), [ready, network, repo.repoId, identity ?? ''], {
    enabled: ready && sdk !== null && identity !== null,
  })
  const display = useRepoDisplay(home)
  const [asking, setAsking] = useState<NoticeEntry | null>(null)
  const now = Date.now()
  const bots = agentsOf(notices.data, target.number, now)
  if (bots.length === 0 || specificPeople) return null
  // Ask is offered only once the viewer's role is known and the bot's access allows them (the
  // dialog checks again on fresh reads before anything is signed).
  const viewerRole = identity !== null && signer !== null && role.settled && role.error === null ? role.data : undefined
  const canAsk = (n: AccessNotice): boolean => viewerRole !== undefined && checkAsk(n, viewerRole, target.number, membersOnly, now) === null
  return (
    <SidebarSection title="Agents" icon={Bot}>
      <ul className="space-y-2" data-testid="agents">
        {bots.map((e) => (
          <AgentRow key={e.id} entry={e} canAsk={canAsk(e.notice)} onAsk={() => setAsking(e)} />
        ))}
      </ul>
      {asking !== null && sdk !== null && signer !== null ? (
        <AskDialogFor
          entry={asking}
          target={target}
          display={display}
          role={role.error !== null ? 'unknown' : role.settled ? role.data : undefined}
          membersOnly={membersOnly}
          codeNote={membersSource}
          plan={(input) => planAsk(sdk, signer, repo, input)}
          ask={async (input, intent) => {
            const asked = await writeAsk(sdk, signer, repo, input, intent)
            onAsked(asked.event)
          }}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </SidebarSection>
  )
}

function AgentRow({ entry, canAsk, onAsk }: { entry: NoticeEntry; canAsk: boolean; onAsk: () => void }): JSX.Element {
  const bot = botIdOf(entry.notice)
  const handle = useHandle(bot)
  return (
    <li className="flex flex-wrap items-center justify-between gap-2" data-testid="agent-row">
      <Author identityId={bot} link={false} />
      {canAsk ? (
        <Button size="sm" onClick={onAsk} data-testid="agent-ask">
          Ask {handle}
        </Button>
      ) : null}
    </li>
  )
}

/** {@link AskDialog} for one bot, named by its handle. */
function AskDialogFor({ entry, ...rest }: Omit<AskDialogProps, 'name' | 'bot' | 'notice' | 'now'> & { entry: NoticeEntry }): JSX.Element {
  const bot = botIdOf(entry.notice)
  const name = useHandle(bot)
  return <AskDialog {...rest} bot={bot} name={name} notice={entry.notice} now={Date.now()} />
}

export interface AskDialogProps {
  /** The bot (base58) and how the copy names it (`@ci-bot`). */
  readonly bot: string
  readonly name: string
  /** The repo as the copy names it (`o/r`). */
  readonly display: string
  readonly target: AskTarget
  /** The bot's current notice, as the sidebar read it. */
  readonly notice: AccessNotice
  /**
   * The viewer's role (the owner as a maintainer; null: not a member; undefined: still reading;
   * `'unknown'`: the read failed, so only the fresh check of {@link planAsk} decides).
   */
  readonly role: Role | null | 'unknown' | undefined
  readonly membersOnly: boolean
  readonly codeNote: boolean
  readonly now: number
  /** What asking will hand on, read now (it may refuse with E813 too). */
  readonly plan: (about: AskAbout) => Promise<AskPlan>
  /** Write the request (and its letter) with this action's intent. */
  readonly ask: (input: AskInput, intent: string) => Promise<void>
  readonly onClose: () => void
}

/** "Ask a maintainer…" as a sentence. */
const sentence = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`

/** The E813 refusal, shown before anything is signed. */
export function AskRefusalNote({ refusal, name, display }: { refusal: AskRefusal; name: string; display: string }): JSX.Element {
  const { message, fix } = refusalWords(refusal, name, display)
  return (
    <div role="alert" className="space-y-1 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400" data-testid="ask-refused">
      <p>{sentence(message)}</p>
      <p>{sentence(fix)}</p>
      <p className="text-[12px]">Nothing was signed or sent to the bot.</p>
    </div>
  )
}

/**
 * The Ask dialog (DESIGN §10 "Ask"). The bot's access is checked against the viewer's role first:
 * a refusal shows the E813 copy and nothing can be signed. Otherwise it reads what the bot will
 * get ({@link planAsk}, which checks again on fresh reads) and takes the task.
 */
export function AskDialog({ bot, name, display, target, notice, role, membersOnly, codeNote, now, plan, ask, onClose }: AskDialogProps): JSX.Element {
  const [task, setTask] = useState('')
  const about: AskAbout = { target, bot, name, display }
  const local = role === undefined || role === 'unknown' ? null : checkAsk(notice, role, target.number, membersOnly, now)
  const planned = useAsync(() => plan(about), [bot, target.id, display], { enabled: role !== undefined && local === null })
  const refusal = local ?? (planned.cause instanceof AskRefusedError ? planned.cause.refusal : null)
  const taskOk = isTask(task)
  const blocked =
    refusal !== null ? (
      <AskRefusalNote refusal={refusal} name={name} display={display} />
    ) : planned.error !== null ? (
      <p role="alert" className="text-dense text-danger-700 dark:text-danger-400" data-testid="ask-plan-error">
        {planned.error}
      </p>
    ) : !taskOk ? (
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="ask-task-hint">
        Say what you&apos;d like it to do, in up to {TASK_MAX.chars} characters.
      </p>
    ) : undefined
  const lines = planned.data === null ? [] : askSummary(planned.data, name, codeNote).slice(1)
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Ask ${name} to work on #${target.number}?`}
      cost={refusal === null && planned.data !== null ? previewCredits(askCredits(planned.data, task)) : 'pending'}
      confirmLabel="Ask"
      {...(blocked !== undefined ? { blocked } : {})}
      onConfirm={async (intent) => {
        // Confirm is disabled until both hold; never signed past either.
        if (refusal !== null) throw askRefused(refusal, name, display)
        if (!taskOk) throw new Error(TASK_PROBLEM)
        await ask({ ...about, task }, intent)
      }}
      successNote="Asked"
    >
      {refusal === null ? (
        <div className="space-y-3 text-dense" data-testid="ask-dialog">
          {lines.length > 0 ? (
            <div className="space-y-1 text-anvil-700 dark:text-anvil-200" data-testid="ask-summary">
              {lines.map((l) => (
                <p key={l}>{l}</p>
              ))}
            </div>
          ) : (
            <p className="text-anvil-500 dark:text-anvil-400">Reading what {name} will get…</p>
          )}
          <label className="block space-y-1.5">
            <span className="block font-medium text-anvil-700 dark:text-anvil-200">What should it do?</span>
            <Textarea value={task} onChange={(e) => setTask(e.target.value)} maxLength={TASK_MAX.chars * 2} className="min-h-[64px]" placeholder="Fix the failing test" data-testid="ask-task" />
          </label>
          <p className="text-right font-mono text-[11px] text-anvil-500 dark:text-anvil-400">
            {[...task].length} / {TASK_MAX.chars}
          </p>
        </div>
      ) : null}
    </ConfirmDialog>
  )
}

/**
 * The requests of a thread that were outside their bot's access when written (DESIGN §4.9: the
 * notice that counted then and the asker's role then; `requestWithinAccess`), by event id: the
 * timeline flags them. Empty until the repo's notices are read (none flagged on a failed read).
 */
export function useRequestsOutsideAccess(home: RepoHome, requests: readonly AgentRequest[], members: readonly Membership[], membersOnly: boolean): ReadonlySet<string> {
  const repo = home.repo
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const session = membersSession(repo)
  const notices = useAsync(() => readAccessNoticesCached(sdk!, repo), [ready, network, repo.repoId, session?.id ?? ''], {
    enabled: ready && sdk !== null && requests.length > 0,
  })
  return useMemo(() => {
    const read = notices.data
    if (read === null || requests.length === 0) return new Set<string>()
    const oracle = new RoleOracle(members)
    return new Set(requests.filter((r) => !requestWithinAccess(r, read, oracle, repo.ownerId, membersOnly)).map((r) => r.id))
  }, [notices.data, requests, members, repo.ownerId, membersOnly])
}
