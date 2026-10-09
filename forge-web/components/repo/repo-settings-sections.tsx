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

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Archive, Globe, GitBranch, Info, Lock, Plus, Scale, Settings2, ShieldCheck, Trash2 } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { isLive, plural } from '@/lib/view'
import {
  CONFIG_LAG_MS,
  DEFAULT_CONFIG,
  MAX_PATTERN_CHARS,
  MAX_PROTECTED_PATTERNS,
  MERGE_METHODS,
  applyConfigChange,
  branchProblem,
  changeHolds,
  descriptionProblem,
  editRepoDoc,
  fullPattern,
  parseTopics,
  matchList,
  patternMatches,
  patternsProblem,
  previewConfig,
  previewRepoEdit,
  readTopicDocNames,
  suggestionConfig,
  readConfig,
  readMembershipsCached,
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
import { MAX_TOPICS } from '@/lib/repo/settings'
import { missingDefaultProtection } from '@/lib/rules'
import { mirrorSourceOfRepo } from '@/lib/view/mirror-source'
import { readRunnersCached } from '@/lib/repo/checks'
import {
  CHECK_NAME_MAX_CHARS,
  MAX_REQUIRED_CHECKS,
  checksOk,
  draftOfPolicy,
  policyWithChecks,
  requiredChecksProblems,
  samePolicy,
  sourceOptions,
  sourceRole,
  newCheckRow,
  type CheckRow,
  type ChecksProblems,
  type RequiredChecksDraft,
  type SourceOption,
} from '@/lib/view/required-checks'
import type { Policy } from '@/lib/rules/v2'
import { previewCreate, type CostPreview as Cost, type FirstWrite } from '@/lib/sdk'
import { retryWhileMissing } from '@/lib/view/retry'
import { useSdk } from '@/hooks/use-sdk'
import { repoHref, useRepoAddress } from '@/hooks/use-query-param'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { useDpnsName } from '@/hooks/use-dpns-name'
import { useAuth } from '@/contexts/auth-context'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Button } from '@/components/ui/button'
import { disabledField, Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { EnforcedBy } from '@/components/ui/enforced-by'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ErrorState, LoadingBlock } from '@/components/ui/states'
import { shortId } from '@/lib/utils'

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

/** The sections on this page, and Environments, which has its own page (it reads more). */
const SECTIONS = [
  ['general', 'General'],
  ['branches', 'Branches'],
  ['collaborators', 'Members'],
  ['storage', 'Storage'],
  ['environments', 'Environments'],
  ['webhooks', 'Webhooks'],
  ['bans', 'Bans'],
  ['danger', 'Danger zone'],
] as const

const NAV_ITEM =
  'inline-flex items-center rounded px-2 py-1 text-anvil-600 hover:bg-anvil-100 coarse:min-h-11 coarse:px-3 hover:text-anvil-900 dark:text-anvil-300 dark:hover:bg-anvil-800'

/** In-page navigation between the sections, and the link to Settings → Environments. */
export function SettingsNav(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <nav aria-label="Settings sections" className="flex flex-wrap gap-1 border-b border-anvil-200 pb-2 text-dense dark:border-anvil-800">
      {SECTIONS.map(([id, label]) =>
        id === 'environments' ? (
          <Link key={id} href={repoHref('/repo/settings/environments', addr)} className={NAV_ITEM}>
            {label}
          </Link>
        ) : (
          <a key={id} href={`#${id}`} className={NAV_ITEM}>
            {label}
          </a>
        ),
      )}
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

/** Only for a rule narrower than the page's read-only banner (that banner already names maintainers). */
function OwnerOnlyNote(): JSX.Element {
  return <Note>Only the owner can change this.</Note>
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
  /** Once the write holds on chain (e.g. clear the field it came from). */
  readonly onDone?: () => void
}

/**
 * The state and dialog of one config write: `ask(pending)` opens the confirm with the cost of
 * the resulting config; on confirm it appends the config, waits until a read shows it (the next
 * node may be a block behind), then asks the page to re-read the repo home.
 */
function useConfigWrite(home: RepoHome, onSaved: () => void) {
  const { sdk } = useSdk(repoContractIds(home.repo))
  const { signer, identity } = useAuth()
  const guard = useWriteGuard()
  const [pending, setPending] = useState<PendingConfig | null>(null)
  const current = home.config ?? DEFAULT_CONFIG
  // A repo with a config holds the config subtree already, and its owner has written to forge-core
  // (its repo document): a later config costs about three quarters of the first (QW3-037).
  const first: FirstWrite = {
    ...(home.config !== null ? { repo: false } : {}),
    ...(identity !== null && identity === home.repo.ownerId ? { contract: false } : {}),
  }
  const cost = (change: ConfigChange): Cost => previewConfig(applyConfigChange(current, change), first)
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
    pending.onDone?.()
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
        <VisibilityRow visibility={home.repo.visibility} />
        <div className="border-t border-anvil-100 pt-4 dark:border-anvil-850">
          <Field label="Default branch" htmlFor="default-branch" hint="What a clone checks out and what the repo page opens on.">
            <div className="flex flex-wrap items-center gap-2">
              <select
                id="default-branch"
                className={`rounded-md border border-anvil-300 bg-white px-2 py-1.5 font-mono text-dense coarse:h-11 coarse:text-base dark:border-anvil-700 dark:bg-anvil-950 ${disabledField}`}
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
          {cfg.sealed ? <SealedNote command={`dg repo edit ${home.repo.ownerId}/${home.repo.name} --default-branch <branch>`} /> : null}
        </div>
        <RepoDocForm home={home} owner={owner} onSaved={onSaved} />
      </div>
      {cfg.dialog}
    </Section>
  )
}

/**
 * The repo's visibility, read-only (QW2-063): GitHub lists it in Settings, and here it is set once,
 * when the repo is created (the `repo` document's `visibility` is immutable).
 */
export function VisibilityRow({ visibility }: { visibility: 'public' | 'private' }): JSX.Element {
  const isPrivate = visibility === 'private'
  const Icon = isPrivate ? Lock : Globe
  return (
    <div data-testid="settings-visibility" data-visibility={visibility}>
      <p className="text-dense font-medium text-anvil-800 dark:text-anvil-100">Visibility</p>
      <p className="mt-1 flex items-center gap-1.5 text-dense text-anvil-800 dark:text-anvil-100">
        <Icon className="h-3.5 w-3.5 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <span className="font-medium">{isPrivate ? 'Private' : 'Public'}</span>
        <span className="text-anvil-500 dark:text-anvil-400">· set when the repo was created, and permanent</span>
      </p>
      <p className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400">
        {isPrivate
          ? 'Code, ref names, issues, pull requests, comments and reviews are encrypted to members. That the repo exists, its name, owner, description, members and how many issues and pull requests it has are public.'
          : 'Anyone can read its code, issues and pull requests. To keep code private, create a private repo and push it there.'}
      </p>
    </div>
  )
}

/** Description and topics: the `repo` document, which only its owner can edit. */
function RepoDocForm({ home, owner, onSaved }: { home: RepoHome; owner: boolean; onSaved: () => void }): JSX.Element {
  const { sdk, ready } = useSdk(repoContractIds(home.repo))
  // The topic documents the save reconciles, for its price (the owner only: only they can save).
  const held = useAsync(() => readTopicDocNames(sdk!, home.repo), [ready, repoKey(home.repo)], { enabled: owner && ready && sdk !== null })
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
  const cost = previewRepoEdit(edit, held.data, home.repo.visibility)
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
      <Field
        label="Topics"
        htmlFor="repo-topics"
        hint={`Comma-separated, up to ${MAX_TOPICS}: lowercase letters and digits, words joined by single dashes (web-dev).`}
      >
        <Input id="repo-topics" value={topicsText} disabled={!owner} onChange={(e) => setTopicsText(e.target.value)} placeholder="rust, dash-platform" />
      </Field>
      {problem ? <p className="text-[12px] text-danger-700 dark:text-danger-400">{problem}</p> : null}
      {home.repo.visibility === 'private' ? (
        <Note>
          The description and topics are public, even for a private repo. Private repos aren&apos;t listed on Explore&apos;s topic pages.
        </Note>
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
        <OwnerOnlyNote />
      )}
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title="Edit the repo details"
        description={
          home.repo.visibility === 'private'
            ? "Replaces the description and topics. The repo's name and visibility can't change."
            : "Replaces the description and topics. Each topic added or removed costs a little extra so Explore can count it. The repo's name and visibility can't change."
        }
        cost={pending ? previewRepoEdit(pending, held.data, home.repo.visibility) : null}
        confirmLabel="Sign & save"
        toast={{ running: 'Saving the repo details…', done: 'Repository details saved' }}
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
  const refNames = [...home.branches, ...home.tags].filter(isLive).map((r) => r.refName)
  const patterns = cfg.current.protectedPatterns
  const [entry, setEntry] = useState('')
  const candidate = entry.trim() === '' ? '' : fullPattern(entry)
  const nextPatterns = candidate === '' ? patterns : [...patterns, candidate]
  const problem = candidate === '' ? null : patternsProblem(nextPatterns)
  const preview = candidate === '' ? [] : patternMatches(candidate, refNames)
  const canEdit = maintainer && !cfg.sealed

  return (
    <Section id="branches" title="Branches" icon={<GitBranch className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />}>
      <div className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
        <h3 className="flex items-center gap-2 text-dense font-medium">
          <ShieldCheck className="h-4 w-4 text-fg-muted" aria-hidden /> Protected branches and tags
        </h3>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-dense text-anvil-600 dark:text-anvil-300">
          <span>Only maintainers can update a protected branch or tag.</span>
          <EnforcedBy by="platform" />
        </p>
        {maintainer ? <DefaultProtectionSuggestion home={home} cfg={cfg} /> : null}
        <ul aria-label="Protected patterns" className="mt-3 divide-y divide-anvil-100 overflow-hidden rounded-md border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800">
          {patterns.length === 0 ? (
            <li className="px-3 py-2 text-dense text-anvil-500 dark:text-anvil-400">Nothing is protected: every writer can update every branch and tag.</li>
          ) : (
            patterns.map((p) => {
              const hits = patternMatches(p, refNames)
              return (
                <li key={p} className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="protected-pattern">
                  <span className="font-mono text-dense">{p}</span>
                  <span className="text-[12px] text-anvil-500 dark:text-anvil-400">
                    {hits.length === 0 ? `matches no ${p.startsWith('refs/tags/') ? 'tag' : 'branch'} yet` : `matches ${matchList(hits)}`}
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
                    description: `Appends a config adding ${candidate}. From then on only maintainers can update ${preview.length > 0 ? matchList(preview) : 'the refs it matches'}; a writer's push there is refused.`,
                    change: { addPatterns: [candidate] },
                    confirmLabel: 'Sign & protect',
                    // QW-072: a protected pattern leaves the field, not "already protected" under it.
                    onDone: () => setEntry(''),
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
                  {preview.length === 0 ? 'matches nothing yet' : `protects ${matchList(preview)}`}
                </p>
                <CostPreview cost={cfg.cost({ addPatterns: [candidate] })} />
              </div>
            ) : null}
            <p className="mt-2 flex gap-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                A bare name means <span className="font-mono">refs/heads/&lt;name&gt;</span>. <span className="font-mono">*</span> matches within one
                path segment (<span className="font-mono">release/*</span> matches <span className="font-mono">release/1.x</span>, not{' '}
                <span className="font-mono">release/1.x/rc</span>); <span className="font-mono">**</span> crosses segments;{' '}
                <span className="font-mono">?</span> and <span className="font-mono">[a-z]</span> work as in git. <span className="font-mono">refs/tags/**</span> covers every
                tag. Up to {MAX_PROTECTED_PATTERNS} patterns.
              </span>
            </p>
          </div>
        ) : cfg.sealed ? (
          <SealedNote command={`dg repo protect add ${home.repo.ownerId}/${home.repo.name} <pattern>`} />
        ) : null}
      </div>
      <PolicyEditor home={home} maintainer={maintainer} />
      {cfg.dialog}
    </Section>
  )
}

/** Where a maintainer's "not now" on the protection suggestion is kept, per repo and browser. */
const PROTECTION_DISMISSED = (repoId: string): string => `forge:protection-suggestion-dismissed:${repoId}`

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null
  } catch {
    return false
  }
}

/**
 * The one-click offer to complete the new-repository default (the default branch and every tag)
 * on a repo created before it, or one whose maintainers dropped it. Not offered on a fork or a
 * mirror (they follow their source, so they start unprotected), while the repo's patterns are
 * unknown (`suggestionConfig`), or once a maintainer dismissed it in this browser.
 */
function DefaultProtectionSuggestion({ home, cfg }: { home: RepoHome; cfg: ReturnType<typeof useConfigWrite> }): JSX.Element | null {
  const key = PROTECTION_DISMISSED(home.repo.repoId)
  const [dismissed, setDismissed] = useState(() => typeof window !== 'undefined' && readDismissed(key))
  const [now, setNow] = useState(() => Date.now())
  // A page opened while a missing config may still be on its way looks again once it can't be.
  const waitUntil = home.config === null ? home.v2.createdAt + CONFIG_LAG_MS + 1 : null
  useEffect(() => {
    if (waitUntil === null || waitUntil <= now) return
    const t = window.setTimeout(() => setNow(Date.now()), waitUntil - now)
    return () => window.clearTimeout(t)
  }, [waitUntil, now])
  const known = suggestionConfig({
    config: home.config,
    sealed: home.repo.visibility === 'private',
    unlocked: home.private?.access === 'member',
    repoDefaultBranch: home.defaultBranch,
    repoCreatedAt: home.v2.createdAt,
    now,
  })
  const missing = known === null ? [] : missingDefaultProtection(known.defaultBranch, known.protectedPatterns)
  if (missing.length === 0 || dismissed || home.v2.forkOf !== null || mirrorSourceOfRepo(home.v2, 'issue') !== null) return null
  const branch = missing.find((p) => p.startsWith('refs/heads/'))?.slice('refs/heads/'.length) ?? null
  const exposure =
    branch !== null && missing.length > 1
      ? `Any writer can push to ${branch} and create or move tags that no pattern protects yet.`
      : branch !== null
        ? `Any writer can push to ${branch}.`
        : 'Any writer can create or move tags that no pattern protects yet.'
  // What the button adds: a branch whose pattern would pass the limit is left out, its tags not.
  const tooLong = missing.some((p) => [...p].length > MAX_PATTERN_CHARS)
  const offer = missing.filter((p) => [...p].length <= MAX_PATTERN_CHARS)
  const offerBranch = offer.some((p) => p.startsWith('refs/heads/')) ? branch : null
  const offerTags = offer.some((p) => p.startsWith('refs/tags/'))
  const what = offerBranch !== null && offerTags ? `${offerBranch} and tags` : (offerBranch ?? 'tags')
  const full = offer.length === 0 ? null : patternsProblem([...(known?.protectedPatterns ?? []), ...offer])
  const note = [tooLong ? `${branch} is too long to protect by name.` : null, full !== null ? `${full} Remove one to make room.` : null]
    .filter((x) => x !== null)
    .join(' ')
  // With no config yet, the first one keeps the branch readers already take as the default.
  const change = { addPatterns: offer, ...(home.config === null && known !== null ? { defaultBranch: known.defaultBranch } : {}) }
  const dismiss = (): void => {
    try {
      window.localStorage.setItem(key, '1')
    } catch {
      // Storage blocked: the dismissal lasts until the page reloads.
    }
    setDismissed(true)
  }
  return (
    <div
      role="status"
      data-testid="protection-suggestion"
      className="mt-3 flex flex-col gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 sm:flex-row sm:items-center"
    >
      <p className="flex-1 text-dense text-anvil-700 dark:text-anvil-200">
        {exposure} New repositories protect the default branch and every tag.
        {note !== '' ? ` ${note}` : null}
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        {cfg.sealed ? (
          <p className="text-[12px] text-anvil-600 dark:text-anvil-300">
            Run <span className="break-all font-mono">dg repo protect defaults {home.repo.ownerId}/{home.repo.name}</span>
          </p>
        ) : offer.length > 0 && full === null ? (
          <Button
            size="sm"
            variant="primary"
            disabled={cfg.disabledReason !== null}
            onClick={() =>
              cfg.ask({
                title: `Protect ${what}`,
                description: `Appends a config adding ${offer.join(' and ')}. From then on only maintainers can ${
                  offerBranch !== null && offerTags ? `push to ${offerBranch} or create and move tags` : offerBranch !== null ? `push to ${offerBranch}` : 'create and move tags'
                }; a writer's push there is refused.`,
                change,
                confirmLabel: 'Sign & protect',
              })
            }
          >
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Protect {what}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={dismiss}>
          Not now
        </Button>
      </div>
    </div>
  )
}

/** The branch policy (review-parity spec §3.6, §4.8): a client rule with maintainer override. */
function PolicyEditor({ home, maintainer }: { home: RepoHome; maintainer: boolean }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const current = useAsync<Policy | null>(() => readPolicy(sdk!, home.repo), [ready, repoKey(home.repo)], { enabled: ready && sdk !== null })
  const [draft, setDraft] = useState<Policy | null>(null)
  const [checksDraft, setChecksDraft] = useState<RequiredChecksDraft | null>(null)
  const [confirming, setConfirming] = useState(false)
  const base: Policy = current.data ?? { requiredApprovals: 0, approverRole: 0, requireChecks: false, mergeMethods: 0 }
  const shown = draft ?? base
  const shownChecks = checksDraft ?? draftOfPolicy(base)
  // What a save writes: the other fields as edited, and the required checks as edited.
  const wanted = policyWithChecks(shown, shownChecks)
  const set = (p: Partial<Policy>): void => setDraft({ ...shown, ...p })
  // The pickable sources (the repo's runners and maintainers), through the cached reads the PR
  // and commit pages share; read only once a maintainer pins checks.
  const pinning = maintainer && shownChecks.pinned
  const sources = useAsync(
    async () => {
      const [members, runners] = await Promise.all([readMembershipsCached(sdk!, home.repo, network), readRunnersCached(sdk!, home.repo)])
      return sourceOptions(members, runners)
    },
    [ready, repoKey(home.repo), network],
    { enabled: ready && sdk !== null && pinning },
  )
  const valid = sources.data === null ? null : new Set(sources.data.map((o) => o.id))
  const problems = requiredChecksProblems(shownChecks, valid)
  // Against the defaults when the repo has no policy yet: an edit back to them writes nothing.
  const changed = (draft !== null || checksDraft !== null) && !samePolicy(wanted, base)
  const cost = previewCreate('policy')
  const methods = shown.mergeMethods ?? 0
  const checkCount = wanted.requiredChecks?.length ?? 0
  const checksClause = checkCount > 0 ? `, ${plural(checkCount, 'required check')}${(wanted.requiredCheckSources?.length ?? 0) > 0 ? ', each from its pinned source' : ''}` : ''
  const run = async (intent: string): Promise<void> => {
    if (!sdk || !signer || !changed) throw new Error('sign in to continue')
    await setPolicy(sdk, signer, home.repo, wanted, intent)
    // Until the new policy reads back in full (a change to one field alone must show too).
    await retryWhileMissing(async () => {
      const read = await readPolicy(sdk, home.repo)
      return read !== null && samePolicy(read, wanted) ? true : null
    }, 8)
    setDraft(null)
    setChecksDraft(null)
    current.reload()
  }

  return (
    <div className="mt-4 rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="policy-editor">
      <h3 className="flex items-center gap-2 text-dense font-medium">
        <Scale className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden /> Branch policy
      </h3>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-dense text-anvil-600 dark:text-anvil-300" data-testid="policy-note">
        <span>Forge blocks merging until these are met. Maintainers can override, and the override is shown on the PR.</span>
        <EnforcedBy by="apps" />
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
                  {/* The policy can allow it (other clients may), but neither this app nor dg rebase-merges yet (QW-069). */}
                  {m.key === 'rebase' ? <span className="text-[11px] text-anvil-500 dark:text-anvil-400">(not available yet)</span> : null}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-dense coarse:min-h-11">
            <input type="checkbox" className="h-4 w-4 accent-forge-700" checked={shown.requireChecks === true} onChange={(e) => set({ requireChecks: e.target.checked })} />
            Require passing checks (every check reported on the head)
          </label>
          <label className="flex items-start gap-2 text-dense coarse:min-h-11">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-forge-700"
              checked={shown.requireCodeOwners === true}
              onChange={(e) => set({ requireCodeOwners: e.target.checked })}
            />
            <span>
              Require approval from code owners
              <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">
                Each changed file that CODEOWNERS on the base branch assigns needs an approval from one of its owners.
              </span>
            </span>
          </label>
          <RequiredChecksEditor draft={shownChecks} onChange={setChecksDraft} problems={problems} sources={pinning ? sources : null} maintainer={maintainer} />
          {maintainer ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={!changed || !checksOk(problems) || guard.disabledReason !== null}
                onClick={() => {
                  if (guard.check(cost, 'community')) setConfirming(true)
                }}
              >
                Save policy
              </Button>
              {changed ? <CostPreview cost={cost} /> : null}
            </div>
          ) : null}
        </fieldset>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Save the branch policy"
        description={`New policy: ${plural(wanted.requiredApprovals, 'required approval')}${(wanted.approverRole ?? 0) === 1 ? ' (maintainers)' : ''}${checksClause}${wanted.requireCodeOwners === true ? ', code owner approval' : ''}. It replaces the current one. Maintainers can override it when merging.`}
        cost={cost}
        confirmLabel="Sign & save"
        onConfirm={run}
      />
    </div>
  )
}

/**
 * "Require status checks", the GitHub way: the checks that must pass by name, each optionally
 * pinned to the runner or maintainer that must report it. The contract takes a source for every
 * check or for none (`sourcesMatchNames`), so pinning is one switch for the whole list and, with
 * it on, every row picks its source. Validation is `requiredChecksProblems`.
 */
function RequiredChecksEditor({
  draft,
  onChange,
  problems,
  sources,
  maintainer,
}: {
  draft: RequiredChecksDraft
  onChange: (d: RequiredChecksDraft) => void
  problems: ChecksProblems
  /** The pickable sources while pinning (null: not pinning, or not a maintainer). */
  sources: Pick<AsyncState<SourceOption[]>, 'data' | 'error' | 'reload'> | null
  maintainer: boolean
}): JSX.Element {
  const rows = draft.rows
  const setRow = (i: number, row: Partial<CheckRow>): void => onChange({ ...draft, rows: rows.map((r, j) => (j === i ? { ...r, ...row } : r)) })
  const full = rows.length >= MAX_REQUIRED_CHECKS
  return (
    <div className="text-dense" data-testid="required-checks">
      <p className="text-anvil-700 dark:text-anvil-200" id="required-checks-label">
        Required checks by name
      </p>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        Each must be reported on the PR head and pass. Once any are listed, only these are required, ticked above or not. Up to {MAX_REQUIRED_CHECKS}.
      </p>
      <label className="mt-2 flex items-start gap-2 coarse:min-h-11">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-forge-700" checked={draft.pinned} onChange={(e) => onChange({ ...draft, pinned: e.target.checked })} data-testid="pin-sources" />
        <span>
          Pin each check to the runner or maintainer that must report it
          <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">All or none: every check names its source, or any trusted reporter counts for all of them.</span>
        </span>
      </label>
      {rows.length > 0 ? (
        <ul className="mt-2 space-y-2" aria-labelledby="required-checks-label">
          {rows.map((row, i) => {
            const problem = problems.rows[i] ?? null
            const errorId = problem !== null ? `required-check-${row.key}-error` : undefined
            return (
              <li key={row.key} className="rounded-md border border-anvil-200 p-2 dark:border-anvil-800" data-testid="required-check-row">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    aria-label={`Required check ${i + 1} name`}
                    placeholder="Check name, e.g. build"
                    value={row.name}
                    maxLength={CHECK_NAME_MAX_CHARS}
                    onChange={(e) => setRow(i, { name: e.target.value })}
                    aria-invalid={errorId !== undefined}
                    aria-describedby={errorId}
                    className="min-w-0 flex-1 font-mono"
                  />
                  {draft.pinned ? (
                    <SourcePicker
                      value={row.source}
                      options={sources?.data ?? null}
                      failed={sources?.error != null}
                      label={`Required check ${i + 1} source`}
                      onPick={(source) => setRow(i, { source })}
                      errorId={errorId}
                    />
                  ) : null}
                  {maintainer ? (
                    <Button variant="outline" size="sm" onClick={() => onChange({ ...draft, rows: rows.filter((_, j) => j !== i) })} aria-label={`Remove required check ${row.name.trim() || i + 1}`}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      <span className="sm:hidden">Remove</span>
                    </Button>
                  ) : null}
                </div>
                {problem !== null ? (
                  <p id={errorId} className="mt-1 text-[12px] text-danger-700 dark:text-danger-400">
                    {problem}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">No checks are required by name.</p>
      )}
      {sources?.error ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-caution-700 dark:text-caution-400">
          Couldn&apos;t read the runners and maintainers to pick from: {sources.error}
          <Button variant="outline" size="sm" onClick={sources.reload}>
            Retry
          </Button>
        </p>
      ) : null}
      {problems.form !== null ? <p className="mt-1 text-[12px] text-danger-700 dark:text-danger-400">{problems.form}</p> : null}
      {maintainer ? (
        <Button variant="outline" size="sm" className="mt-2" disabled={full} onClick={() => onChange({ ...draft, rows: [...rows, newCheckRow()] })} data-testid="add-required-check">
          <Plus className="h-3.5 w-3.5" aria-hidden /> {full ? `${MAX_REQUIRED_CHECKS} checks is the most a policy holds` : 'Add a required check'}
        </Button>
      ) : null}
    </div>
  )
}

/** The source of one pinned check: the repo's runners and maintainers (a stale pick stays listed, flagged). */
function SourcePicker({
  value,
  options,
  failed,
  label,
  onPick,
  errorId,
}: {
  value: string
  /** Null while they are read, or after the read failed (`failed`). */
  options: SourceOption[] | null
  failed: boolean
  label: string
  onPick: (id: string) => void
  /** The row's error message, when it has one. */
  errorId: string | undefined
}): JSX.Element {
  const stale = value !== '' && options !== null && !options.some((o) => o.id === value)
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onPick(e.target.value)}
      aria-invalid={errorId !== undefined}
      aria-describedby={errorId}
      className={`h-9 min-w-0 rounded-md border border-anvil-300 bg-white px-2 text-dense text-anvil-900 coarse:h-11 coarse:text-base sm:w-64 dark:border-anvil-700 dark:bg-anvil-950 dark:text-anvil-100 ${disabledField}`}
      data-testid="required-check-source"
    >
      <option value="" disabled>
        {failed ? "Couldn't read the sources" : options === null ? 'Reading runners and maintainers…' : options.length === 0 ? 'No runners or maintainers' : 'Pick a source…'}
      </option>
      {value !== '' && (options === null || stale) ? <SourceChoice id={value} role={stale ? 'no longer a runner or maintainer' : null} /> : null}
      {(options ?? []).map((o) => (
        <SourceChoice key={o.id} id={o.id} role={sourceRole(o)} />
      ))}
    </select>
  )
}

/** One source option, named by DPNS once resolved (an option holds text only). */
function SourceChoice({ id, role }: { id: string; role: string | null }): JSX.Element {
  const name = useDpnsName(id)
  const who = name ?? shortId(id)
  return <option value={id}>{role === null ? who : `${who} · ${role}`}</option>
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
              ? 'Allow pushes, issues, pull requests and releases again.'
              : "Make the repo read-only. Forge apps stop new issues, pull requests, releases and pushes. Repos can't be deleted."}
          </p>
          <EnforcedBy by="apps" className="mt-1" />
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
      ) : null}
      {cfg.dialog}
    </Section>
  )
}
