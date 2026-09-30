'use client'

/**
 * Repo Settings → Storage for browser pushes: which of the viewer's own storage profiles this
 * repo's browser pushes (merges, fork updates, release assets) use, overriding the default
 * from `/settings/storage`. Local to this browser: the credentials are, so the choice is too
 * (the CLI keeps its equivalent in git config, `dash.storage`).
 */

import { useState } from 'react'
import Link from 'next/link'
import { HardDrive } from 'lucide-react'
import { choiceOf, policyFor, policyForRepo, policyProblem, withRepoPolicy, type ReplicationChoice } from '@/lib/storage'
import { errText } from '@/lib/storage/util'
import { useStorageConfig } from '@/hooks/use-storage-config'
import { Button } from '@/components/ui/button'
import { UnlockMore } from '@/components/auth/unlock-more'
import { PUSH_COST_DASH } from '@/lib/sdk/cost'

export function RepoStoragePolicy({
  repoId,
  unlockAbove = false,
}: {
  repoId: string
  /**
   * The page already offers this tab's unlock above (a locked private repo's Collaborators): one
   * unlock opens the encryption key and the storage settings alike, so say so instead of a second
   * prompt.
   */
  unlockAbove?: boolean
}): JSX.Element {
  const { config, storable, save, error, needsUnlock } = useStorageConfig()
  const override = config?.repoPolicies[repoId] ?? null
  const effective = config ? policyForRepo(config, repoId) : null
  const [targets, setTargets] = useState<string[] | null>(null)
  const [choice, setChoice] = useState<ReplicationChoice | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  if (error) return <p className="text-dense text-danger-700 dark:text-danger-400">{error}</p>
  if (needsUnlock && unlockAbove) {
    return (
      <p data-testid="storage-unlock-above" className="text-dense text-anvil-500 dark:text-anvil-400">
        Your storage settings are locked in this tab: the unlock under{' '}
        <a href="#collaborators" className="text-forge-700 underline dark:text-forge-400">
          Collaborators
        </a>{' '}
        opens them too.
      </p>
    )
  }
  if (needsUnlock) return <UnlockMore title="Unlock to use your storage settings" testId="storage-unlock" />
  if (!config) {
    return (
      <p className="text-dense text-anvil-500 dark:text-anvil-400">
        Sign in to choose where your browser pushes to this repo go. Settings stay in this browser.
      </p>
    )
  }
  if (config.profiles.length === 0) {
    return (
      <p className="text-dense text-anvil-600 dark:text-anvil-300">
        No storage set up in this browser: browser pushes here would store packs on Platform at ~{PUSH_COST_DASH.perMib} DASH/MiB, asking first.{' '}
        <Link href="/settings/storage/" className="text-forge-700 underline dark:text-forge-400">Set up storage →</Link>
      </p>
    )
  }
  const shown = targets ?? effective?.targets.slice() ?? []
  const shownChoice = choice ?? (effective ? choiceOf(effective) : 'one')
  const policy = shown.length > 0 ? policyFor(shown, shownChoice) : null
  const problem = policy ? policyProblem(config, policy) : null

  return (
    <div className="space-y-3 text-dense" data-testid="repo-storage-policy">
      <p className="flex items-start gap-2 text-anvil-600 dark:text-anvil-300">
        <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <span>
          Where your browser pushes to this repo store packs.{' '}
          {override ? 'This repo has its own choice.' : effective ? 'Using your default.' : 'No default is set.'} Only you see this: it lives in this browser with your storage keys.
        </span>
      </p>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">Storage for this repo</legend>
        {config.profiles.map((p) => (
          <label key={p.name} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="h-4 w-4 accent-forge-700"
              checked={shown.includes(p.name)}
              onChange={(e) => {
                setMsg(null)
                setTargets(e.target.checked ? [...shown, p.name] : shown.filter((x) => x !== p.name))
              }}
            />
            <span className="font-mono">{p.name}</span>
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2">
        <span className="text-anvil-600 dark:text-anvil-300">Copies</span>
        <select
          className="rounded-md border border-anvil-300 bg-white px-2 py-1 coarse:h-11 coarse:text-base dark:border-anvil-700 dark:bg-anvil-950"
          value={shownChoice}
          onChange={(e) => {
            setMsg(null)
            setChoice(e.target.value as ReplicationChoice)
          }}
        >
          <option value="one">one place is enough</option>
          <option value="all">all chosen places must confirm</option>
          <option value="fallback">Platform as fallback (asks first)</option>
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!storable || problem !== null || policy === null}
          onClick={async () => {
            try {
              await save(withRepoPolicy(config, repoId, policy))
              setMsg('Saved for this repo.')
            } catch (e) {
              setMsg(errText(e))
            }
          }}
        >
          Use for this repo
        </Button>
        {override ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={!storable}
            onClick={async () => {
              try {
                await save(withRepoPolicy(config, repoId, null))
                setTargets(null)
                setChoice(null)
                setMsg('Back to your default.')
              } catch (e) {
                setMsg(e instanceof Error ? e.message : String(e))
              }
            }}
          >
            Use my default
          </Button>
        ) : null}
        <span className="text-[12px] text-anvil-500 dark:text-anvil-400" role="status" aria-live="polite">{msg ?? (problem && shown.length > 0 ? problem : '')}</span>
      </div>
    </div>
  )
}
