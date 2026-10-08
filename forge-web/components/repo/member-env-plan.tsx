'use client'

/**
 * The environment half of a member change in the web (DESIGN §4.5 "Groups change", D34; parity
 * with `dg collab add|remove`): every add, removal, promotion and demotion shows which
 * environments it saves again, for whom, and what that costs, before signing; then saves them
 * around the change ({@link runMemberChange}); then lists what was saved and, for a removal, the
 * values to change where they're used, each with "Mark changed" (which opens the editor on them).
 *
 * A repo with environments that this tab can't open (no encryption key here, or locked) is
 * refused before anything is signed: the change would leave them saved for the wrong people.
 */

import { useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

import type { RepoHome } from '@/lib/view'
import type { CostPreview } from '@/lib/sdk'
import { previewCredits } from '@/lib/sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { useDpnsName } from '@/hooks/use-dpns-name'
import { useEnvWriter, useEnvironments, useRepoPeople } from '@/hooks/use-environments'
import { planMemberChange, runMemberChange, type MemberChange, type MemberChangeOutcome, type MemberEnvPlan } from '@/lib/env/member-change'
import { notUpdatedLine, outcomeLine, pinLine, planHeadline } from '@/lib/env/plan-view'
import { exposureLine, unreadableLine } from '@/lib/env/view'
import type { Exposure } from '@/lib/env'
import { EnvChangeDialog, type EnvChangeMode } from '@/components/repo/environment-editor'
import { Button } from '@/components/ui/button'
import { shortId } from '@/lib/utils'

/** How the page names an identity in a sentence. */
function useName(id: string): string {
  return useDpnsName(id) ?? shortId(id)
}

/** Names for every id a plan mentions, resolved one hook per id. */
function NameOf({ id, children }: { id: string; children: (name: string) => ReactNode }): JSX.Element {
  return <>{children(useName(id))}</>
}

/** Every identity a set of lines may name. */
function idsOf(plan: MemberEnvPlan | null, outcome: MemberEnvOutcome | null): string[] {
  const ids = new Set<string>()
  if (plan !== null) {
    ids.add(plan.change.member)
    for (const p of [...plan.first, ...plan.removal, ...plan.regroup]) for (const id of [...p.added, ...p.gone]) ids.add(id)
    for (const n of plan.notUpdated) {
      if (n.kind === 'unreadable') ids.add(n.author)
      if (n.kind === 'hidden') for (const a of n.authors) ids.add(a)
    }
  }
  if (outcome !== null) {
    for (const s of outcome.saves) if (s.kind === 'saved') for (const id of s.skipped) ids.add(id)
    for (const g of outcome.gone) ids.add(g.who)
  }
  return [...ids]
}

/** Resolve every id in `ids` to its name, then render `use` with the lookup. */
function WithNames({ ids, use }: { ids: readonly string[]; use: (name: (id: string) => string) => ReactNode }): JSX.Element {
  const names = new Map<string, string>()
  const render = (i: number): ReactNode => {
    if (i === ids.length) return use((id) => names.get(id) ?? shortId(id))
    const id = ids[i] as string
    return (
      <NameOf id={id}>
        {(n) => {
          names.set(id, n)
          return render(i + 1)
        }}
      </NameOf>
    )
  }
  return <>{render(0)}</>
}

/** What a member change did beside the change: the saves, and a removal's checklist. */
export interface MemberEnvOutcome extends MemberChangeOutcome {
  readonly member: string
  readonly exposures: readonly Exposure[]
  readonly unreadable: number
}

export interface MemberEnvFlow {
  readonly plan: MemberEnvPlan | null
  /** Why the change can't run from this tab, shown in its dialog (Confirm stays disabled). */
  readonly blocked: ReactNode | null
  /** `base` plus the saves, or `'pending'` while the plan is read. */
  readonly cost: (base: CostPreview) => CostPreview | 'pending'
  /** "Save and add" when environments are saved, else `fallback`. */
  readonly confirmLabel: (fallback: string, verb: 'add' | 'change' | 'remove') => string
  /** Run `doChange` with the planned saves around it. */
  readonly run: (doChange: () => Promise<void>) => Promise<void>
  readonly outcome: MemberEnvOutcome | null
  readonly dismiss: () => void
}

/**
 * The environment plan of `change` (null: no change open) in `home`; `heldMembersKey`: a removed
 * member held the members key (the checklist then counts old-format values).
 */
export function useMemberEnvFlow(home: RepoHome, change: MemberChange | null, heldMembersKey: boolean): MemberEnvFlow {
  const { identity } = useAuth()
  const [outcome, setOutcome] = useState<MemberEnvOutcome | null>(null)
  const envs = useEnvironments(home, change !== null || outcome !== null)
  const writer = useEnvWriter(home)
  const book = envs.state.data?.book ?? null
  const hasEnvironments = book !== null && book.manifests.length > 0
  const canOpen = envs.state.data?.encryption === 'open' && !envs.locked && writer !== null
  const changeKey = change === null ? '' : JSON.stringify(change)
  const planned = useAsync<MemberEnvPlan>(
    () => planMemberChange(writer!.io, change!, identity!, home.repo.ownerId, heldMembersKey),
    [changeKey, heldMembersKey, writer === null, identity ?? ''],
    { enabled: change !== null && writer !== null && identity !== null && hasEnvironments && canOpen },
  )
  const plan = change === null || !hasEnvironments ? null : planned.data
  let blocked: ReactNode | null = null
  if (change !== null) {
    if (envs.state.error !== null) {
      blocked = <BlockedNote text={`Couldn't read this repo's environments, so the change can't be planned: ${envs.state.error}`} />
    } else if (book === null) {
      blocked = null
    } else if (hasEnvironments && !canOpen) {
      blocked = (
        <BlockedNote text="This repo has environments, and they're saved again for the people they cover when members change. Unlock your encryption key in this tab to make this change." />
      )
    } else if (planned.error !== null) {
      blocked = <BlockedNote text={`Couldn't plan the environments to save again: ${planned.error}`} />
    }
  }
  const waiting = change !== null && blocked === null && (book === null || (hasEnvironments && plan === null))
  return {
    plan,
    blocked,
    cost: (base) => {
      if (waiting) return 'pending'
      if (plan === null || plan.credits === 0) return base
      // the change and every save: Platform needs the whole amount available
      return previewCredits(base.credits + plan.credits)
    },
    confirmLabel: (fallback, verb) => (plan !== null && plan.first.length + plan.removal.length + plan.regroup.length > 0 ? `Save and ${verb}` : fallback),
    run: async (doChange) => {
      if (change === null || !hasEnvironments || plan === null || writer === null) {
        await doChange()
        return
      }
      const done = await runMemberChange(writer.io, writer.saver, plan, home.repo.ownerId, doChange)
      setOutcome({ ...done, member: change.member, exposures: plan.exposures, unreadable: plan.unreadable })
      envs.state.reload()
    },
    outcome,
    dismiss: () => setOutcome(null),
  }
}

function BlockedNote({ text }: { text: string }): JSX.Element {
  return (
    <p role="alert" className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution-700 dark:text-caution-400" data-testid="member-env-blocked">
      {text}
    </p>
  )
}

/** The plan, inside the change's confirmation (DESIGN §10 "Role-change plan"). */
export function MemberEnvPlanView({ flow }: { flow: MemberEnvFlow }): JSX.Element | null {
  const plan = flow.plan
  if (plan === null) return null
  const pins = [...plan.first, ...plan.removal, ...plan.regroup]
  if (pins.length === 0 && plan.notUpdated.length === 0 && plan.exposures.length === 0 && plan.unreadable === 0) return null
  return (
    <WithNames
      ids={idsOf(plan, null)}
      use={(name) => {
        const headline = planHeadline(plan, name)
        const who = name(plan.change.member)
        return (
          <div className="space-y-2 text-dense text-anvil-700 dark:text-anvil-200" data-testid="member-env-plan">
            {headline !== null ? <p data-testid="member-env-headline">{headline}</p> : null}
            {pins.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="member-env-pins">
                {pins.map((p, i) => (
                  <li key={`${p.env}:${i}`}>{pinLine(p, name)}</li>
                ))}
              </ul>
            ) : null}
            {plan.notUpdated.length > 0 ? (
              <ul className="space-y-1 text-[12px] text-caution-700 dark:text-caution-400" data-testid="member-env-not-updated">
                {plan.notUpdated.map((n, i) => (
                  <li key={i}>{notUpdatedLine(n, name)}</li>
                ))}
              </ul>
            ) : null}
            {plan.exposures.length > 0 || plan.unreadable > 0 ? (
              <div className="space-y-1 rounded-md border border-caution/40 bg-caution/5 px-3 py-2" data-testid="env-removal">
                {plan.exposures.map((e) => (
                  <p key={e.env} className="break-words">
                    {exposureLine(who, e)}
                  </p>
                ))}
                {plan.unreadable > 0 ? <p>{unreadableLine(who, plan.unreadable)}</p> : null}
                <p className="text-[12px] text-anvil-600 dark:text-anvil-300">Removing someone can&apos;t take back what they could already read. After the removal, mark each value changed once it is.</p>
              </div>
            ) : null}
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Values are not shown. Access is granted, not logged.</p>
          </div>
        )
      }}
    />
  )
}

/**
 * What the change did to environments, under the members list: each save, what couldn't be
 * saved, and a removal's checklist, each environment with "Mark changed" (the editor, opened on
 * the values listed: a value leaves the list once it holds a new one).
 */
export function MemberEnvOutcomeView({ home, flow }: { home: RepoHome; flow: MemberEnvFlow }): JSX.Element | null {
  const { identity } = useAuth()
  const envs = useEnvironments(home, flow.outcome !== null)
  const writer = useEnvWriter(home)
  const people = useRepoPeople(home, flow.outcome !== null)
  const [editing, setEditing] = useState<EnvChangeMode | null>(null)
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set())
  const outcome = flow.outcome
  if (outcome === null) return null
  const book = envs.state.data?.book ?? null
  const ctx = book !== null && writer !== null && identity !== null ? { book, people, owner: home.repo.ownerId, viewer: identity, saver: writer.saver, io: writer.io } : null
  return (
    <WithNames
      ids={[outcome.member, ...idsOf(null, outcome)]}
      use={(name) => (
        <div className="mt-3 space-y-2 rounded-lg border border-anvil-200 p-3 text-dense dark:border-anvil-800" data-testid="member-env-outcome">
          {outcome.saves.length > 0 ? (
            <ul className="space-y-1 text-[12px] text-anvil-700 dark:text-anvil-200" data-testid="member-env-saves">
              {outcome.saves.map((s, i) => (
                <li key={i}>{outcomeLine(s, name)}</li>
              ))}
            </ul>
          ) : null}
          {outcome.notUpdated.length > 0 ? (
            <ul className="space-y-1 text-[12px] text-caution-700 dark:text-caution-400">
              {outcome.notUpdated.map((n, i) => (
                <li key={i}>{notUpdatedLine(n, name)}</li>
              ))}
            </ul>
          ) : null}
          {outcome.exposures.length > 0 || outcome.gone.length > 0 || outcome.unreadable > 0 ? (
            <div className="space-y-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2" data-testid="env-removal-checklist">
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden /> Values to change where they&apos;re used
              </p>
              {[...outcome.exposures.map((e) => ({ who: outcome.member, exposure: e })), ...outcome.gone].map(({ who, exposure }) => (
                <div key={`${who}:${exposure.env}`} className="flex flex-wrap items-center gap-2" data-testid="env-checklist-item">
                  <span className="min-w-0 flex-1 break-words">{exposureLine(name(who), exposure)}</span>
                  {changed.has(exposure.env) ? (
                    <span className="text-[12px] text-verify-700 dark:text-verify-400">Saved with new values</span>
                  ) : ctx !== null ? (
                    <Button size="sm" variant="outline" onClick={() => setEditing({ kind: 'values', env: exposure.env, focus: exposure.names })} data-testid="env-checklist-mark">
                      Mark changed
                    </Button>
                  ) : null}
                </div>
              ))}
              {outcome.unreadable > 0 ? <p>{unreadableLine(name(outcome.member), outcome.unreadable)}</p> : null}
            </div>
          ) : null}
          <Button size="sm" variant="ghost" onClick={flow.dismiss}>
            Dismiss
          </Button>
          {ctx !== null ? (
            <EnvChangeDialog
              mode={editing}
              ctx={ctx}
              onClose={() => setEditing(null)}
              onSaved={() => {
                if (editing !== null && editing.kind === 'values') setChanged((s) => new Set([...s, editing.env]))
                envs.state.reload()
              }}
            />
          ) : null}
        </div>
      )}
    />
  )
}
