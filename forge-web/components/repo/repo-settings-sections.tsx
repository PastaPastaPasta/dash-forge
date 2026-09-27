'use client'

/**
 * The repo settings sections that write `config`, the `repo` document and `policy` (QA
 * D-503): General (default branch, description, topics), Branches (protected patterns with a
 * glob preview, the branch policy) and the Danger zone (archive). Every write goes through the
 * pre-sign cost preview and {@link ConfirmDialog}; a change that already holds signs nothing.
 *
 * What each control can promise:
 * - Protection is consensus-backed: a ref matching a pattern moves only through the
 *   maintainer-gated `protectedRefUpdate`, and a writer's plain `refUpdate` there is inert.
 * - The branch policy and the archived flag are client rules: every Forge client applies them,
 *   a maintainer can override the policy, and consensus enforces neither.
 * - A private repo's config is sealed; the browser cannot seal it yet, so its config controls
 *   say so and point at the CLI (`SealedConfigError`). The policy has no text and is written
 *   as is; the description and topics are public by design (`private-repos.md` §7).
 */

import { useState } from 'react'
import { Archive, GitBranch, Info, Lock, Scale, Settings2, ShieldCheck, Trash2 } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { isLive } from '@/lib/view'
import {
  DEFAULT_CONFIG,
  MAX_PROTECTED_PATTERNS,
  MERGE_METHODS,
  applyConfigChange,
  branchProblem,
  changeHolds,
  descriptionProblem,
  editRepoDoc,
  fullPattern,
  parseTopics,
  patternMatches,
  patternsProblem,
  previewConfig,
  previewRepoEdit,
  readConfig,
  readPolicy,
  readRepoById,
  repoContractIds,
  repoKey,
  setPolicy,
  topicsProblem,
  updateConfig,
  type ConfigChange,
  type RepoDocEdit,
} from '@/lib/repo'
import type { Policy } from '@/lib/rules/v2'
import { previewCreate, type CostPreview as Cost } from '@/lib/sdk'
import { retryWhileMissing } from '@/lib/view/retry'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ErrorState, LoadingBlock } from '@/components/ui/states'

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

const SECTIONS = [
  ['general', 'General'],
  ['branches', 'Branches'],
  ['collaborators', 'Collaborators'],
  ['storage', 'Storage'],
  ['danger', 'Danger zone'],
] as const

/** In-page navigation between the sections. */
export function SettingsNav(): JSX.Element {
  return (
    <nav aria-label="Settings sections" className="flex flex-wrap gap-1 border-b border-anvil-200 pb-2 text-dense dark:border-anvil-800">
      {SECTIONS.map(([id, label]) => (
        <a key={id} href={`#${id}`} className="inline-flex items-center rounded px-2 py-1 text-anvil-600 hover:bg-anvil-100 coarse:min-h-11 coarse:px-3 hover:text-anvil-900 dark:text-anvil-300 dark:hover:bg-anvil-800">
          {label}
        </a>
      ))}
    </nav>
  )
}

export function Section({
  id,
  title,
  icon,
  children,
  tone,
}: {
  id?: string
  title: string
  icon: React.ReactNode
  children: React.ReactNode
  tone?: 'danger'
}): JSX.Element {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="scroll-mt-20">
      <h2 id={id ? `${id}-title` : undefined} className={'mb-3 flex items-center gap-2 text-prose' + (tone === 'danger' ? ' text-danger-700 dark:text-danger-400' : '')}>
        {icon}
        {title}
      </h2>
      <div>{children}</div>
    </section>
  )
}

function Note({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">{children}</p>
}

function ReadOnlyNote({ who }: { who: string }): JSX.Element {
  return <Note>Only {who} can change this.</Note>
}

/** A private repo's config cannot be written from here: say so, and name the CLI command. */
function SealedNote({ command }: { command: string }): JSX.Element {
  return (
    <div role="note" className="mt-3 flex gap-2 rounded-md border border-anvil-200 bg-anvil-50 px-3 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900">
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-anvil-400" aria-hidden />
      <span>
        This repo is private, so its config is encrypted, and this browser can&apos;t encrypt it yet. Use the CLI, which does:{' '}
        <code className="font-mono text-[12px]">{command}</code>
        {/* TODO(private-web): write sealed configs once the web holds epoch keys (PR #51's private session). */}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// A config write, shared by General, Branches and the Danger zone
// ---------------------------------------------------------------------------------------------

interface PendingConfig {
  readonly title: string
  readonly description: string
  readonly change: ConfigChange
  readonly confirmLabel: string
}

/**
 * The state and dialog of one config write: `ask(pending)` opens the confirm with the cost of
 * the resulting config; on confirm it appends the config, waits until a read shows it (the next
 * node may be a block behind), then asks the page to re-read the repo home.
 */
function useConfigWrite(home: RepoHome, onSaved: () => void) {
  const { sdk } = useSdk(repoContractIds(home.repo))
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const [pending, setPending] = useState<PendingConfig | null>(null)
  const current = home.config ?? DEFAULT_CONFIG
  const cost = (change: ConfigChange): Cost => previewConfig(applyConfigChange(current, change))
  const ask = (p: PendingConfig): void => {
    if (guard.check(cost(p.change))) setPending(p)
  }
  const run = async (intent: string): Promise<void> => {
    if (!sdk || !signer || pending === null) throw new Error('sign in to continue')
    const change = pending.change
    await updateConfig(sdk, signer, home.repo, home.config, change, intent)
    // The write was applied to a fresh read, so confirm by the edited field alone.
    await retryWhileMissing(async () => {
      const read = await readConfig(sdk, home.repo)
      return read !== null && changeHolds(read, change) ? true : null
    }, 8)
    onSaved()
  }
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onClose={() => setPending(null)}
      title={pending?.title ?? ''}
      description={pending?.description}
      cost={pending ? cost(pending.change) : null}
      confirmLabel={pending?.confirmLabel ?? 'Sign & save'}
      onConfirm={run}
    />
  )
  return { ask, cost, dialog, disabledReason: guard.disabledReason, current, sealed: home.repo.visibility === 'private' }
}

// ---------------------------------------------------------------------------------------------
// General: default branch, description, topics
// ---------------------------------------------------------------------------------------------

export function GeneralSettings({
  home,
  maintainer,
  owner,
  onSaved,
}: {
  home: RepoHome
  maintainer: boolean
  owner: boolean
  onSaved: () => void
}): JSX.Element {
  const cfg = useConfigWrite(home, onSaved)
  const live = home.branches.filter(isLive).map((b) => b.refName.slice('refs/heads/'.length))
  const options = live.includes(home.defaultBranch) ? live : [home.defaultBranch, ...live]
  const [branch, setBranch] = useState(home.defaultBranch)
  const shownBranch = options.includes(branch) ? branch : home.defaultBranch
  const branchErr = branchProblem(shownBranch)
  const branchChanged = shownBranch !== home.defaultBranch

  return (
    <Section id="general" title="General" icon={<Settings2 className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />}>
      <div className="space-y-5 rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
        <div>
          <Field label="Default branch" htmlFor="default-branch" hint="What a clone checks out and what the repo page opens on.">
            <div className="flex flex-wrap items-center gap-2">
              <select
                id="default-branch"
                className="rounded-md border border-anvil-300 bg-white px-2 py-1.5 font-mono text-dense coarse:h-11 coarse:text-base dark:border-anvil-700 dark:bg-anvil-950"
                value={shownBranch}
                disabled={!maintainer || cfg.sealed}
                onChange={(e) => setBranch(e.target.value)}
              >
                {options.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              {maintainer && !cfg.sealed ? (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!branchChanged || branchErr !== null || cfg.disabledReason !== null}
                    onClick={() =>
                      cfg.ask({
                        title: `Make ${shownBranch} the default branch`,
                        description: `Appends a config naming ${shownBranch} the default branch; protected patterns and storage carry over. Clones check it out and the repo page opens on it.`,
                        change: { defaultBranch: shownBranch },
                        confirmLabel: 'Sign & update',
                      })
                    }
                  >
                    Update
                  </Button>
                  {branchChanged ? <CostPreview cost={cfg.cost({ defaultBranch: shownBranch })} /> : null}
                </>
              ) : null}
            </div>
          </Field>
          {live.length === 0 ? <Note>Push a branch first: the default branch is picked from the branches this repo has.</Note> : null}
          {cfg.sealed ? <SealedNote command={`dg repo edit ${home.repo.ownerId}/${home.repo.name} --default-branch <branch>`} /> : !maintainer ? <ReadOnlyNote who="maintainers" /> : null}
        </div>
        <RepoDocForm home={home} owner={owner} onSaved={onSaved} />
      </div>
      {cfg.dialog}
    </Section>
  )
}

/** Description and topics: the `repo` document, which only its owner can edit. */
function RepoDocForm({ home, owner, onSaved }: { home: RepoHome; owner: boolean; onSaved: () => void }): JSX.Element {
  const { sdk } = useSdk(repoContractIds(home.repo))
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const [description, setDescription] = useState(home.v2.description)
  const [topicsText, setTopicsText] = useState(home.v2.topics.join(', '))
  const [pending, setPending] = useState<RepoDocEdit | null>(null)
  const topics = parseTopics(topicsText)
  const edit: RepoDocEdit = {
    ...(description !== home.v2.description ? { description } : {}),
    ...(topics.join(',') !== home.v2.topics.join(',') ? { topics } : {}),
  }
  const changed = Object.keys(edit).length > 0
  const problem = descriptionProblem(description) ?? topicsProblem(topics)
  const cost = previewRepoEdit(edit)
  const run = async (): Promise<void> => {
    if (!sdk || !signer || pending === null) throw new Error('sign in to continue')
    await editRepoDoc(sdk, signer, home.repo, pending)
    await retryWhileMissing(async () => {
      const doc = await readRepoById(sdk, home.repo.forge, home.repo.repoId)
      const ok =
        doc !== null &&
        (pending.description === undefined || doc.description === pending.description) &&
        (pending.topics === undefined || doc.topics.join(',') === pending.topics.join(','))
      return ok ? true : null
    }, 8)
    onSaved()
  }
  return (
    <div className="space-y-3 border-t border-anvil-100 pt-4 dark:border-anvil-850">
      <Field label="Description" htmlFor="repo-description">
        <Textarea
          id="repo-description"
          className="min-h-[64px]"
          value={description}
          disabled={!owner}
          maxLength={500}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label="Topics" htmlFor="repo-topics" hint="Comma-separated, up to 10: lowercase letters, digits and dashes.">
        <Input id="repo-topics" value={topicsText} disabled={!owner} onChange={(e) => setTopicsText(e.target.value)} placeholder="rust, dash-platform" />
      </Field>
      {problem ? <p className="text-[12px] text-danger-700 dark:text-danger-400">{problem}</p> : null}
      {home.repo.visibility === 'private' ? (
        <Note>The description and topics are public even for a private repo: they live on its repo document, which is not encrypted.</Note>
      ) : null}
      {owner ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!changed || problem !== null || guard.disabledReason !== null}
            onClick={() => {
              if (guard.check(cost)) setPending(edit)
            }}
          >
            Save
          </Button>
          {changed ? <CostPreview cost={cost} /> : null}
        </div>
      ) : (
        <ReadOnlyNote who="the owner" />
      )}
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title="Edit the repo details"
        description="Replaces the description and topics on the repo document. Its name, visibility and fork origin cannot change."
        cost={pending ? previewRepoEdit(pending) : null}
        confirmLabel="Sign & save"
        onConfirm={run}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Branches: protected patterns and the branch policy
// ---------------------------------------------------------------------------------------------

export function BranchSettings({ home, maintainer, onSaved }: { home: RepoHome; maintainer: boolean; onSaved: () => void }): JSX.Element {
  const cfg = useConfigWrite(home, onSaved)
  const branches = home.branches.filter(isLive).map((b) => b.refName.slice('refs/heads/'.length))
  const patterns = cfg.current.protectedPatterns
  const [entry, setEntry] = useState('')
  const candidate = entry.trim() === '' ? '' : fullPattern(entry)
  const nextPatterns = candidate === '' ? patterns : [...patterns, candidate]
  const problem = candidate === '' ? null : patternsProblem(nextPatterns)
  const preview = candidate === '' ? [] : patternMatches(candidate, branches)
  const canEdit = maintainer && !cfg.sealed

  return (
    <Section id="branches" title="Branches" icon={<GitBranch className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />}>
      <div className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
        <h3 className="flex items-center gap-2 text-dense font-medium">
          <ShieldCheck className="h-4 w-4 text-forge-500" aria-hidden /> Protected branches
        </h3>
        <p className="mt-1 text-dense text-anvil-600 dark:text-anvil-300">
          Only maintainers can update a protected branch. Platform enforces it: such a ref moves only through a
          maintainer-only document, and a writer&apos;s plain update of it is ignored by every reader.
        </p>
        <ul aria-label="Protected patterns" className="mt-3 divide-y divide-anvil-100 overflow-hidden rounded-md border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800">
          {patterns.length === 0 ? (
            <li className="px-3 py-2 text-dense text-anvil-500 dark:text-anvil-400">No protected branches: every writer can update every branch.</li>
          ) : (
            patterns.map((p) => {
              const hits = patternMatches(p, branches)
              return (
                <li key={p} className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="protected-pattern">
                  <span className="font-mono text-dense">{p}</span>
                  <span className="text-[12px] text-anvil-500 dark:text-anvil-400">
                    {hits.length === 0 ? 'matches no branch yet' : `matches ${hits.join(', ')}`}
                  </span>
                  {canEdit ? (
                    <Button
                      size="sm"
                      variant="danger"
                      className="ml-auto"
                      aria-label={`Unprotect ${p}`}
                      disabled={cfg.disabledReason !== null}
                      onClick={() =>
                        cfg.ask({
                          title: `Unprotect ${p}`,
                          description: `Appends a config without ${p}. Writers can then update the branches it matched. Updates made while it was protected stay judged by the config in force at the time.`,
                          change: { removePattern: p },
                          confirmLabel: 'Sign & unprotect',
                        })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
                    </Button>
                  ) : null}
                </li>
              )
            })
          )}
        </ul>
        {canEdit ? (
          <div className="mt-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Field label="Branch or pattern" htmlFor="protect-pattern">
                  <Input
                    id="protect-pattern"
                    className="font-mono"
                    spellCheck={false}
                    value={entry}
                    onChange={(e) => setEntry(e.target.value)}
                    placeholder="main  or  release/*"
                  />
                </Field>
              </div>
              <Button
                variant="primary"
                disabled={candidate === '' || problem !== null || patterns.length >= MAX_PROTECTED_PATTERNS || cfg.disabledReason !== null}
                onClick={() =>
                  cfg.ask({
                    title: `Protect ${candidate}`,
                    description: `Appends a config adding ${candidate}. From then on only maintainers can update ${preview.length > 0 ? preview.join(', ') : 'the branches it matches'}; a writer's push there is refused.`,
                    change: { addPattern: candidate },
                    confirmLabel: 'Sign & protect',
                  })
                }
              >
                Protect
              </Button>
            </div>
            {problem ? <p className="mt-1 text-[12px] text-danger-700 dark:text-danger-400">{problem}</p> : null}
            {candidate !== '' && problem === null ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p className="text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="pattern-preview">
                  <span className="font-mono">{candidate}</span>{' '}
                  {preview.length === 0 ? 'matches no current branch' : `protects ${preview.join(', ')}`}
                </p>
                <CostPreview cost={cfg.cost({ addPattern: candidate })} />
              </div>
            ) : null}
            <p className="mt-2 flex gap-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                A bare name means <span className="font-mono">refs/heads/&lt;name&gt;</span>. <span className="font-mono">*</span> matches within one
                path segment (<span className="font-mono">release/*</span> matches <span className="font-mono">release/1.x</span>, not{' '}
                <span className="font-mono">release/1.x/rc</span>); <span className="font-mono">**</span> crosses segments;{' '}
                <span className="font-mono">?</span> and <span className="font-mono">[a-z]</span> work as in git. Up to {MAX_PROTECTED_PATTERNS} patterns.
              </span>
            </p>
          </div>
        ) : cfg.sealed ? (
          <SealedNote command={`dg repo protect add ${home.repo.ownerId}/${home.repo.name} <pattern>`} />
        ) : (
          <ReadOnlyNote who="maintainers" />
        )}
      </div>
      <PolicyEditor home={home} maintainer={maintainer} />
      {cfg.dialog}
    </Section>
  )
}

/** The branch policy (review-parity spec §3.6, §4.8): a client rule with maintainer override. */
function PolicyEditor({ home, maintainer }: { home: RepoHome; maintainer: boolean }): JSX.Element {
  const { sdk, ready } = useSdk(repoContractIds(home.repo))
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const current = useAsync<Policy | null>(() => readPolicy(sdk!, home.repo), [ready, repoKey(home.repo)], { enabled: ready && sdk !== null })
  const [draft, setDraft] = useState<Policy | null>(null)
  const [confirming, setConfirming] = useState(false)
  const base: Policy = current.data ?? { requiredApprovals: 0, approverRole: 0, requireChecks: false, mergeMethods: 0 }
  const shown = draft ?? base
  const set = (p: Partial<Policy>): void => setDraft({ ...shown, ...p })
  const changed =
    current.data === null
      ? draft !== null
      : draft !== null &&
        (draft.requiredApprovals !== base.requiredApprovals ||
          (draft.approverRole ?? 0) !== (base.approverRole ?? 0) ||
          (draft.requireChecks ?? false) !== (base.requireChecks ?? false) ||
          (draft.mergeMethods ?? 0) !== (base.mergeMethods ?? 0))
  const cost = previewCreate('policy')
  const methods = shown.mergeMethods ?? 0
  const run = async (intent: string): Promise<void> => {
    if (!sdk || !signer || draft === null) throw new Error('sign in to continue')
    const wanted = draft
    await setPolicy(sdk, signer, home.repo, wanted, intent)
    await retryWhileMissing(async () => {
      const read = await readPolicy(sdk, home.repo)
      return read !== null && read.requiredApprovals === wanted.requiredApprovals && (read.mergeMethods ?? 0) === (wanted.mergeMethods ?? 0) ? true : null
    }, 8)
    setDraft(null)
    current.reload()
  }

  return (
    <div className="mt-4 rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="policy-editor">
      <h3 className="flex items-center gap-2 text-dense font-medium">
        <Scale className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden /> Branch policy
      </h3>
      <p role="note" className="mt-1 rounded-md bg-caution/5 px-2 py-1.5 text-dense text-caution-700 dark:text-caution-400">
        A client rule, not consensus: Forge clients disable a writer&apos;s merge until it is met, and a maintainer can override it.
        Nothing on Platform requires approvals.
      </p>
      {current.loading && !current.settled ? (
        <LoadingBlock label="Reading the branch policy" />
      ) : current.error ? (
        <ErrorState message={current.error} onRetry={current.reload} />
      ) : (
        <fieldset disabled={!maintainer} className="mt-3 space-y-3">
          <legend className="sr-only">Branch policy</legend>
          <label className="flex items-center gap-2 text-dense">
            <span className="w-44 text-anvil-700 dark:text-anvil-200">Required approvals</span>
            <Input
              type="number"
              min={0}
              max={10}
              className="w-20"
              aria-label="Required approvals"
              value={shown.requiredApprovals}
              onChange={(e) => set({ requiredApprovals: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })}
            />
          </label>
          <label className="flex items-center gap-2 text-dense coarse:min-h-11">
            <input type="checkbox" className="h-4 w-4 accent-forge-700" checked={(shown.approverRole ?? 0) === 1} onChange={(e) => set({ approverRole: e.target.checked ? 1 : 0 })} />
            Only maintainers&apos; approvals count
          </label>
          <div className="text-dense">
            <span className="text-anvil-700 dark:text-anvil-200">Allowed merge methods</span>
            <div className="mt-1 flex flex-wrap gap-3">
              {MERGE_METHODS.map((m) => (
                <label key={m.key} className="flex items-center gap-1.5 coarse:min-h-11 coarse:min-w-11">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-forge-700"
                    checked={methods === 0 || (methods & m.bit) !== 0}
                    onChange={(e) => {
                      const all = MERGE_METHODS.reduce((s, x) => s | x.bit, 0)
                      const now = methods === 0 ? all : methods
                      const next = e.target.checked ? now | m.bit : now & ~m.bit
                      set({ mergeMethods: next === all ? 0 : next })
                    }}
                  />
                  {m.label}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-dense coarse:min-h-11">
            <input type="checkbox" className="h-4 w-4 accent-forge-700" checked={shown.requireChecks === true} onChange={(e) => set({ requireChecks: e.target.checked })} />
            Require passing checks
          </label>
          <Note>
            Required checks by name need the next forge-collab revision (<span className="font-mono">policy.requiredChecks</span>, platform-parity spec
            §6.2); until then this is one switch, and the web does not read check runs yet.
          </Note>
          {maintainer ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={!changed || guard.disabledReason !== null}
                onClick={() => {
                  if (guard.check(cost, 'collab')) setConfirming(true)
                }}
              >
                Save policy
              </Button>
              {changed ? <CostPreview cost={cost} /> : null}
            </div>
          ) : (
            <ReadOnlyNote who="maintainers" />
          )}
        </fieldset>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Save the branch policy"
        description={`Writes a policy: ${shown.requiredApprovals} required approval${shown.requiredApprovals === 1 ? '' : 's'}${(shown.approverRole ?? 0) === 1 ? ' (maintainers)' : ''}. The newest policy wins. A client rule: a maintainer can override it.`}
        cost={cost}
        confirmLabel="Sign & save"
        onConfirm={run}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Danger zone: archive
// ---------------------------------------------------------------------------------------------

export function DangerZone({ home, maintainer, onSaved }: { home: RepoHome; maintainer: boolean; onSaved: () => void }): JSX.Element {
  const cfg = useConfigWrite(home, onSaved)
  const archived = cfg.current.archived
  return (
    <Section id="danger" title="Danger zone" tone="danger" icon={<Archive className="h-4 w-4" aria-hidden />}>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-dense font-medium">{archived ? 'Unarchive this repository' : 'Archive this repository'}</p>
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            {archived
              ? 'Forge clients allow pushes, issues and pull requests again.'
              : 'Marks it read-only: Forge clients disable issues, pull requests and releases, and the push helper refuses pushes (E606). A client rule: Platform still accepts a member’s writes. Repos cannot be deleted.'}
          </p>
        </div>
        {maintainer && !cfg.sealed ? (
          <Button
            variant="danger"
            disabled={cfg.disabledReason !== null}
            onClick={() =>
              cfg.ask({
                title: archived ? 'Unarchive this repository' : 'Archive this repository',
                description: archived
                  ? 'Appends a config with archived = false. Everything else carries over.'
                  : 'Appends a config with archived = true. Everything else carries over; unarchive any time.',
                change: { archived: !archived },
                confirmLabel: archived ? 'Sign & unarchive' : 'Sign & archive',
              })
            }
          >
            {archived ? 'Unarchive' : 'Archive'}
          </Button>
        ) : null}
      </div>
      {cfg.sealed ? (
        <SealedNote command={`dg repo ${archived ? 'unarchive' : 'archive'} ${home.repo.ownerId}/${home.repo.name}`} />
      ) : !maintainer ? (
        <ReadOnlyNote who="maintainers" />
      ) : null}
      {cfg.dialog}
    </Section>
  )
}
