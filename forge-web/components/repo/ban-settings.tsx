'use client'

/**
 * Settings → Bans (UPDATE-1 `ban`): who the repo's maintainers banned, and a maintainer's ban and
 * lift. Forge apps collapse a banned identity's issues, pull requests, comments and reviews in this
 * repo (with a way to show them) and refuse its new ones; Platform does not stop it writing. Only
 * the maintainer who wrote a ban can lift it; a ban stops counting once its writer is no longer a
 * maintainer (`lib/rules/bans.ts`).
 */

import { useState } from 'react'
import { Ban as BanIcon } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { timeAgo } from '@/lib/view'
import { readMembershipsCached, repoContractIds, repoKey, resolveOwner } from '@/lib/repo'
import { banIdentity, countingBansOf, DOC_BAN, invalidateBans, liftBan, readBanState } from '@/lib/repo/bans'
import { contractHasType } from '@/lib/repo/contract-shape'
import { shortId } from '@/lib/utils'
import { BAN_REASONS, banReasonLabel, type Ban } from '@/lib/rules/bans'
import type { Role } from '@/lib/rules/v2'
import { previewCreate, previewDelete } from '@/lib/sdk'
import { retryWhileMissing } from '@/lib/view/retry'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Author } from '@/components/author'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { ErrorState, LoadingBlock } from '@/components/ui/states'
import { Section } from '@/components/repo/repo-settings-sections'

/**
 * What the ban dialog adds for a member (Q5): a ban hides and refuses their posts in Forge apps,
 * but their role stays, so a writer can still push. Null for a non-member.
 */
export function banKeepsRole(role: Role | null): string | null {
  if (role === null || role === 'maintainer') return null
  const keeps = role === 'writer' ? "A ban doesn't remove that role: they can still push." : "A ban doesn't remove that role."
  return `They have the ${role} role here. ${keeps} To remove it, use Settings → Members.`
}

export function BanSettings({ home, maintainer }: { home: RepoHome; maintainer: boolean }): JSX.Element {
  const repo = home.repo
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()
  const bans = useAsync(() => readBanState(sdk!, repo, network), [ready, repoKey(repo), network], { enabled: ready && sdk !== null })
  // A contract registered before bans has no type for them: the form would only fail.
  const supported = useAsync(() => contractHasType(sdk!, repo.forge.collab, DOC_BAN), [ready, repo.forge.collab], { enabled: ready && sdk !== null })
  const [who, setWho] = useState('')
  const [reason, setReason] = useState<number>(0)
  const [banning, setBanning] = useState<{ readonly id: string; readonly label: string; readonly role: Role | null } | null>(null)
  const [lifting, setLifting] = useState<{ readonly ban: Ban; readonly others: number } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [looking, setLooking] = useState(false)

  // Until the ban documents read back as written (a ban landed, or this signer's was deleted).
  const reloadUntil = async (holds: (raw: readonly Ban[]) => boolean): Promise<void> => {
    if (!sdk) return
    await retryWhileMissing(async () => {
      invalidateBans(repo)
      return holds((await readBanState(sdk, repo, network)).raw) ? true : null
    }, 8)
    bans.reload()
  }
  const mine = (raw: readonly Ban[], who: string): Ban | undefined => raw.find((b) => b.identity === who && b.by === identity)

  const start = async (): Promise<void> => {
    if (!sdk) return
    setProblem(null)
    setLooking(true)
    try {
      const id = await resolveOwner(sdk, who.trim().replace(/^@/, ''))
      if (id === null) return setProblem(`No identity or DPNS name ${who.trim()}.`)
      if (id === repo.ownerId) return setProblem("The repository's owner can't be banned.")
      // Read now, not from the list's state (which holds no members until there is a ban).
      const members = await readMembershipsCached(sdk, repo, network).catch(() => null)
      if (members === null) return setProblem("Couldn't read the repository's members to check who this is. Try again.")
      if (members.some((m) => m.identity === id && m.role === 'maintainer')) return setProblem("A maintainer can't be banned. Remove them as a maintainer first.")
      if (mine(bans.data?.raw ?? [], id) !== undefined) return setProblem('You have already banned this identity.')
      setBanning({ id, label: who.trim(), role: members.find((m) => m.identity === id)?.role ?? null })
    } finally {
      setLooking(false)
    }
  }

  const ban = async (intent: string): Promise<void> => {
    if (!sdk || !signer || banning === null) throw new Error('sign in to continue')
    await banIdentity(sdk, signer, repo, banning.id, reason === 0 ? null : reason, intent)
    const id = banning.id
    setBanning(null)
    setWho('')
    setReason(0)
    await reloadUntil((raw) => mine(raw, id) !== undefined)
  }

  const lift = async (): Promise<void> => {
    if (!sdk || !signer || lifting === null) throw new Error('sign in to continue')
    const id = lifting.ban.identity
    await liftBan(sdk, signer, repo, lifting.ban.id)
    setLifting(null)
    await reloadUntil((raw) => mine(raw, id) === undefined)
  }

  const state = bans.data
  const keepsRole = banning === null ? null : banKeepsRole(banning.role)
  const rows = [...(state?.standing.values() ?? [])].sort((a, b) => b.createdAt - a.createdAt)
  return (
    <Section id="bans" title="Bans" icon={<BanIcon className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />}>
      <div className="space-y-3 rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="bans">
        <p className="text-dense text-anvil-600 dark:text-anvil-300">
          Forge hides what a banned identity wrote in this repository, behind a &ldquo;Show&rdquo; link, and won&apos;t post its new issues, pull requests,
          comments or reviews. Platform still accepts its writes. Only the maintainer who banned someone can lift it.
        </p>
        {bans.error ? (
          <ErrorState message={bans.error} onRetry={bans.reload} />
        ) : state?.membersUnread === true ? (
          <ErrorState message="The repository's members could not be read, so the bans could not be checked." onRetry={bans.reload} />
        ) : state === null ? (
          <LoadingBlock label="Reading bans" />
        ) : rows.length === 0 ? (
          <p className="text-dense text-anvil-500 dark:text-anvil-400" data-testid="bans-empty">
            Nobody is banned.
          </p>
        ) : (
          <ul className="divide-y divide-anvil-100 rounded-md border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800">
            {rows.map((b) => {
              const why = banReasonLabel(b.reason)
              const counting = countingBansOf(state, repo, b.identity)
              const others = counting.filter((x) => x.id !== b.id)
              const own = mine(state.raw, b.identity)
              return (
                <li key={b.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-dense" data-testid="ban-row">
                  <Author identityId={b.identity} />
                  <span className="text-anvil-600 dark:text-anvil-300">
                    banned by <Author identityId={b.by} link={false} className="align-middle" /> · {timeAgo(b.createdAt)}
                    {why !== null ? ` · ${why}` : ''}
                    {others.length > 0 ? (
                      <>
                        {' '}· also banned by{' '}
                        {others.map((o, i) => (
                          <span key={o.id}>
                            {i > 0 ? ', ' : ''}
                            <Author identityId={o.by} link={false} className="align-middle" />
                          </span>
                        ))}
                      </>
                    ) : null}
                  </span>
                  {maintainer && own !== undefined ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto"
                      disabled={guard.disabledReason !== null}
                      aria-label={`Lift your ban of ${shortId(b.identity)}`}
                      onClick={() => setLifting({ ban: own, others: counting.filter((x) => x.id !== own.id).length })}
                    >
                      Lift your ban
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
        {maintainer && supported.error !== null ? (
          <ErrorState message={supported.error} onRetry={supported.reload} />
        ) : maintainer && supported.data === false ? (
          <p className="text-dense text-anvil-500 dark:text-anvil-400" data-testid="bans-unsupported">
            This network&apos;s Forge doesn&apos;t support bans yet.
          </p>
        ) : maintainer && supported.data === true ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (guard.check(previewCreate('ban'), 'collab')) void start()
            }}
          >
            <div className="min-w-[14rem] flex-1">
              <Field label="Identity" htmlFor="ban-who">
                <Input id="ban-who" value={who} onChange={(e) => setWho(e.target.value)} placeholder="@name or identity id" autoComplete="off" />
              </Field>
            </div>
            <label className="flex flex-col gap-1 text-dense">
              <span className="text-anvil-700 dark:text-anvil-200">Reason</span>
              <select
                className="rounded-md border border-anvil-300 bg-white px-2 py-1.5 text-dense dark:border-anvil-700 dark:bg-anvil-950 coarse:h-11"
                value={reason}
                onChange={(e) => setReason(Number(e.target.value))}
              >
                <option value={0}>No reason</option>
                {BAN_REASONS.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" variant="outline" size="sm" disabled={who.trim() === '' || looking || guard.disabledReason !== null}>
              Ban
            </Button>
            {problem !== null ? (
              <p className="w-full text-[12px] text-danger-700 dark:text-danger-400" role="alert">
                {problem}
              </p>
            ) : null}
          </form>
        ) : null}
      </div>
      <ConfirmDialog
        open={banning !== null}
        onClose={() => setBanning(null)}
        title={`Ban ${banning?.label ?? ''}`}
        description="Forge hides what they wrote in this repository and won't post their new issues, pull requests, comments or reviews here. You can lift the ban later."
        cost={previewCreate('ban')}
        confirmLabel="Sign & ban"
        onConfirm={ban}
      >
        {keepsRole !== null ? (
          <p className="text-dense text-anvil-700 dark:text-anvil-200" data-testid="ban-keeps-role">
            {keepsRole}{' '}
            <a href="#collaborators" onClick={() => setBanning(null)} className="underline hover:text-forge-800 dark:hover:text-forge-400">
              Go to Members
            </a>
          </p>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={lifting !== null}
        onClose={() => setLifting(null)}
        title="Lift this ban"
        description={
          lifting !== null && lifting.others > 0
            ? `Your ban is deleted, but ${lifting.others === 1 ? 'another maintainer has' : `${lifting.others} other maintainers have`} also banned them, so what they wrote stays hidden. Part of the ban's storage fee is refunded.`
            : "What they wrote shows again, and they can post here again. Part of the ban's storage fee is refunded."
        }
        cost={previewDelete('ban')}
        confirmLabel="Sign & lift"
        onConfirm={lift}
      />
    </Section>
  )
}
