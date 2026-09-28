'use client'

/**
 * `/settings/storage` — the storage wizard (`ux-dx-spec.md` §3.1): provider tiles, the
 * per-provider form, the live browser test, then save; the saved profiles; where browser
 * pushes go by default (replication radio); and the cost card, always visible.
 *
 * Everything saved is sealed in the vault with this browser's key (`lib/storage/store.ts`).
 */

import { useId, useState } from 'react'
import { Cloud, Database, HardDrive, Link2, Pencil, Server, Trash2, Waypoints } from 'lucide-react'
import {
  PROVIDERS,
  choiceOf,
  defaultPolicyDraft,
  providerPreset,
  PLATFORM_PROFILE,
  profileProblem,
  withFirstDefault,
  withProfile,
  withRenamedProfile,
  withoutProfile,
  type ProviderId,
  type ReplicationChoice,
  type StorageConfig,
  type StorageProfile,
} from '@/lib/storage'
import { errText } from '@/lib/storage/util'
import { useStorageConfig } from '@/hooks/use-storage-config'
import { Button } from '@/components/ui/button'
import { UnlockMore } from '@/components/auth/unlock-more'
import { ErrorState, LoadingBlock } from '@/components/ui/states'
import { ProfileForm, initialDraft } from '@/components/storage/profile-form'
import { StorageTest, profileSnapshot } from '@/components/storage/storage-test'
import { CostCard } from '@/components/storage/cost-card'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/view/format'
import { PUSH_COST_DASH } from '@/lib/sdk/cost'

const TILE_ICON: Readonly<Record<ProviderId, typeof Cloud>> = {
  r2: Cloud,
  b2: Database,
  aws: Server,
  minio: HardDrive,
  kubo: Waypoints,
  pinning: Link2,
  platform: Database,
}

export function StorageWizard(): JSX.Element {
  const { config, loading, error, storable, save, reload, discard, needsUnlock } = useStorageConfig()
  const [provider, setProvider] = useState<ProviderId | null>(null)
  const [editing, setEditing] = useState<StorageProfile | null>(null)

  if (needsUnlock) return <UnlockMore title="Unlock to open your storage settings" testId="storage-unlock" />
  if (loading && !config) return <LoadingBlock label="Opening your storage settings" />
  if (error) return <UnreadableSettings message={error} onRetry={reload} onDiscard={discard} />
  if (!config) return <LoadingBlock />

  const start = (p: ProviderId, existing: StorageProfile | null = null): void => {
    setEditing(existing)
    setProvider(p)
  }

  return (
    <div className="space-y-6">
      {!storable ? (
        <p className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution-700 dark:text-caution-400">
          This tab signs with a pasted key, which has no vault. Storage settings are kept encrypted with a stored key: sign in by importing your identity to save them.
        </p>
      ) : null}

      <section aria-labelledby="providers-title" className="space-y-3">
        <h2 id="providers-title" className="text-dense font-medium text-anvil-500 dark:text-anvil-400">
          Add storage
        </h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" role="group" aria-label="Storage providers">
          {PROVIDERS.map((p) => {
            const Icon = TILE_ICON[p.id]
            const active = provider === p.id
            return (
              <button
                key={p.id}
                type="button"
                data-testid={`tile-${p.id}`}
                aria-pressed={active}
                onClick={() => start(p.id)}
                className={cn(
                  'flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors',
                  active
                    ? 'border-forge-500 bg-forge-500/5'
                    : 'border-anvil-200 bg-white hover:border-anvil-300 dark:border-anvil-750 dark:bg-anvil-900 dark:hover:border-anvil-600',
                  p.id === 'platform' && 'sm:col-span-2 lg:col-span-1',
                )}
              >
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', p.id === 'platform' ? 'text-dash-600 dark:text-dash-400' : 'text-forge-700 dark:text-forge-400')} aria-hidden />
                <span>
                  <span className="block text-dense font-medium text-anvil-900 dark:text-anvil-50">{p.title}</span>
                  <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">{p.blurb}</span>
                </span>
              </button>
            )
          })}
        </div>
      </section>

      {provider ? (
        <AddProfile
          key={`${provider}:${editing?.name ?? ''}`}
          provider={provider}
          existing={editing}
          config={config}
          storable={storable}
          save={save}
          onDone={() => {
            setProvider(null)
            setEditing(null)
          }}
        />
      ) : null}

      <Profiles config={config} storable={storable} save={save} onEdit={(p) => start(p.settings.provider, p)} />

      <DefaultPolicy config={config} storable={storable} save={save} />

      <CostCard />
    </div>
  )
}

/**
 * The stored settings could not be opened (sealed under an earlier key, or unreadable). Offer a
 * retry and, since nothing else can open them, a way to discard them and start again.
 */
function UnreadableSettings({ message, onRetry, onDiscard }: { message: string; onRetry: () => void; onDiscard: () => Promise<void> }): JSX.Element {
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="space-y-3">
      <ErrorState title="Could not open your storage settings" message={message} onRetry={onRetry} />
      <div className="flex flex-wrap items-center justify-center gap-2 text-dense">
        <span className="text-anvil-600 dark:text-anvil-300">If they were sealed with an earlier key, they cannot be opened any more.</span>
        <Button
          variant="danger"
          size="sm"
          onClick={async () => {
            if (!window.confirm('Delete the storage settings this browser cannot open? Your storage profiles are lost here and must be added again. Nothing stored in your buckets is touched.')) return
            try {
              await onDiscard()
            } catch (e) {
              setErr(errText(e))
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Discard unreadable storage settings
        </Button>
      </div>
      {err ? <p role="alert" className="text-center text-dense text-danger-700 dark:text-danger-400">{err}</p> : null}
    </div>
  )
}

function AddProfile({
  provider,
  existing,
  config,
  storable,
  save,
  onDone,
}: {
  provider: ProviderId
  existing: StorageProfile | null
  config: StorageConfig
  storable: boolean
  save: (c: StorageConfig) => Promise<void>
  onDone: () => void
}): JSX.Element {
  const preset = providerPreset(provider)
  // An edit starts from the saved profile, so it can be tested before any field changes.
  const [draft, setDraft] = useState<{ profile: StorageProfile; problem: string | null } | null>(() => {
    if (existing === null || provider === 'platform') return null
    const profile = initialDraft(provider, existing)
    return { profile, problem: profileProblem(profile) }
  })
  // A test result counts only for the exact values it ran against.
  const [tested, setTested] = useState<{ ok: boolean; snapshot: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const statusId = useId()

  if (provider === 'platform') {
    const has = config.profiles.some((p) => p.settings.kind === 'platform')
    return (
      <section className="space-y-3 rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-750 dark:bg-anvil-900" aria-label="Dash Platform storage">
        <h3 className="text-prose">Dash Platform</h3>
        <p className="text-dense text-anvil-600 dark:text-anvil-300">
          Packs stored as Platform documents: permanent, readable by anyone, nothing to run. Priced at about {PUSH_COST_DASH.perMib} DASH per MiB, charged when you push, and never refunded (Platform storage cannot be deleted, so nobody can break a repo others depend on). Every Platform write asks first, with its price.
        </p>
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={has || !storable}
            loading={saving}
            onClick={async () => {
              setSaving(true)
              try {
                await save(withFirstDefault(withProfile(config, { name: PLATFORM_PROFILE, settings: { kind: 'platform', provider: 'platform' }, secrets: {} }), PLATFORM_PROFILE))
                onDone()
              } catch (e) {
                setSaveError(errText(e))
              } finally {
                setSaving(false)
              }
            }}
          >
            {has ? 'Already added' : 'Add Dash Platform'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
        </div>
        {saveError ? <p role="alert" className="text-dense text-danger-700 dark:text-danger-400">{saveError}</p> : null}
      </section>
    )
  }

  const nameTaken = draft !== null && existing?.name !== draft.profile.name && config.profiles.some((p) => p.name === draft.profile.name)
  const problem = draft?.problem ?? (draft ? null : 'fill in the fields')
  const blocking = problem ?? (nameTaken ? 'a profile with that name exists' : null)
  const snapshot = draft ? profileSnapshot(draft.profile) : ''
  const result = tested !== null && tested.snapshot === snapshot ? tested.ok : null
  const status =
    blocking ?? (!storable ? 'Sign in with a stored key to save.' : result === null ? 'Run the test first.' : result ? 'All checks passed.' : 'Some checks failed: you can still save, but browser pushes need them all.')

  return (
    <section className="space-y-4 rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-750 dark:bg-anvil-900" aria-label={`${preset.title} settings`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-prose">{existing ? `Edit ${existing.name}` : preset.title}</h3>
        <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{preset.blurb}</span>
      </div>
      <ProfileForm
        provider={provider}
        existing={existing}
        onChange={(profile, p) => setDraft({ profile, problem: p })}
      />
      {draft && !blocking ? (
        <StorageTest key={snapshot} profile={draft.profile} onDone={(ok, snap) => setTested({ ok, snapshot: snap })} />
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-anvil-100 pt-3 dark:border-anvil-850">
        <Button
          variant="primary"
          size="sm"
          disabled={blocking !== null || result === null || !storable}
          aria-describedby={statusId}
          loading={saving}
          onClick={async () => {
            if (!draft || result === null) return
            setSaving(true)
            setSaveError(null)
            try {
              // A first profile becomes the default: saved but unticked, it left release assets and
              // browser pushes with nowhere to go (L-10).
              let next = existing ? withRenamedProfile(config, existing.name, draft.profile) : withFirstDefault(withProfile(config, draft.profile), draft.profile.name)
              next = { ...next, lastTests: { ...next.lastTests, [draft.profile.name]: { at: Date.now(), ok: result } } }
              await save(next)
              onDone()
            } catch (e) {
              setSaveError(errText(e))
            } finally {
              setSaving(false)
            }
          }}
        >
          Save profile
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
        <span id={statusId} role="status" aria-live="polite" className={cn('text-[12px]', blocking && draft ? 'text-caution-700 dark:text-caution-400' : 'text-anvil-500 dark:text-anvil-400')}>
          {status}
        </span>
      </div>
      {saveError ? <p role="alert" className="text-dense text-danger-700 dark:text-danger-400">{saveError}</p> : null}
    </section>
  )
}

function Profiles({ config, storable, save, onEdit }: { config: StorageConfig; storable: boolean; save: (c: StorageConfig) => Promise<void>; onEdit: (p: StorageProfile) => void }): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const remove = async (name: string): Promise<void> => {
    setError(null)
    try {
      await save(withoutProfile(config, name))
    } catch (e) {
      setError(`Could not remove ${name}: ${errText(e)}`)
    }
  }
  return (
    <section aria-labelledby="profiles-title" className="space-y-2">
      {error ? (
        <p role="alert" className="text-dense text-danger-700 dark:text-danger-400">
          {error}
        </p>
      ) : null}
      <h2 id="profiles-title" className="text-dense font-medium text-anvil-500 dark:text-anvil-400">
        Your storage
      </h2>
      {config.profiles.length === 0 ? (
        <p className="rounded-lg border border-dashed border-anvil-300 px-4 py-5 text-center text-dense text-anvil-500 dark:border-anvil-700 dark:text-anvil-400">
          No storage yet. Browser pushes (merges, forks) would store packs on Platform at ~{PUSH_COST_DASH.perMib} DASH/MiB, asking first.
        </p>
      ) : (
        <ul className="divide-y divide-anvil-100 overflow-hidden rounded-lg border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800" data-testid="profile-list">
          {config.profiles.map((p) => {
            const test = config.lastTests[p.name]
            const where = p.settings.kind === 's3' ? `${p.settings.bucket} · ${new URL(p.settings.endpoint).host}` : p.settings.kind === 'platform' ? 'on-chain chunks' : new URL(p.settings.api).host
            return (
              <li key={p.name} className="flex flex-wrap items-center gap-2 px-3 py-2 text-dense">
                <span className="font-mono font-medium text-anvil-900 dark:text-anvil-50">{p.name}</span>
                <span className="text-anvil-500 dark:text-anvil-400">{where}</span>
                {test ? (
                  <span className={cn('text-[12px]', test.ok ? 'text-verify-700 dark:text-verify-400' : 'text-caution-700 dark:text-caution-400')}>
                    {test.ok ? 'passed' : 'failed some checks'} · {formatDate(test.at)}
                  </span>
                ) : p.settings.kind === 'platform' ? null : (
                  <span className="text-[12px] text-anvil-500 dark:text-anvil-400">not tested</span>
                )}
                <span className="ml-auto flex gap-1">
                  {p.settings.kind !== 'platform' ? (
                    <Button variant="ghost" size="sm" onClick={() => onEdit(p)} aria-label={`Edit ${p.name}`}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                    </Button>
                  ) : null}
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={!storable}
                    aria-label={`Remove ${p.name}`}
                    onClick={() => {
                      if (window.confirm(`Remove ${p.name} from this browser? Packs already stored there stay; repos that point at it will ask for another place on their next browser push.`)) void remove(p.name)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
                  </Button>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const CHOICES: readonly { id: ReplicationChoice; label: string }[] = [
  { id: 'one', label: 'One place: the first that confirms is enough' },
  { id: 'all', label: 'Every chosen place: a push fails unless all confirm' },
  { id: 'fallback', label: 'Platform as fallback if my storage fails (costed, asks first)' },
]

export function DefaultPolicy({ config, storable, save }: { config: StorageConfig; storable: boolean; save: (c: StorageConfig) => Promise<void> }): JSX.Element | null {
  const current = config.defaultPolicy
  // Unedited, the form shows the SAVED default, so a profile that just became the default (the
  // first one added) shows ticked. Once edited, the edits hold until saved.
  const [edits, setEdits] = useState<{ picked: readonly string[]; choice: ReplicationChoice } | null>(null)
  const picked = edits?.picked ?? current?.targets ?? []
  const choice = edits?.choice ?? (current ? choiceOf(current) : 'one')
  // What Save did last; any edit clears it. "Saved." only ever follows a real write.
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const statusId = useId()
  if (config.profiles.length === 0) return null
  const draft = defaultPolicyDraft(config, picked, choice)
  const edit = (next: { picked?: readonly string[]; choice?: ReplicationChoice }): void => {
    setSaved(false)
    setEdits({ picked: next.picked ?? picked, choice: next.choice ?? choice })
  }
  const [status, tone] = saved
    ? ['Saved.', 'text-verify-700 dark:text-verify-400']
    : draft.state === 'empty' || draft.state === 'invalid'
      ? [draft.reason, 'text-caution-700 dark:text-caution-400']
      : [draft.state === 'unchanged' ? 'This is your saved default.' : '', 'text-anvil-500 dark:text-anvil-400']

  return (
    <section aria-labelledby="policy-title" className="space-y-3 rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-750 dark:bg-anvil-900">
      <h2 id="policy-title" className="text-dense font-medium text-anvil-500 dark:text-anvil-400">
        Where browser pushes go
      </h2>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        The default for every repo you push to from this browser (merges, fork updates, release assets). A repo can override it under its Settings → Storage. The CLI keeps its own policy in git config.
      </p>
      <fieldset className="space-y-1.5">
        <legend className="sr-only">Storage to push to</legend>
        {config.profiles.map((p) => (
          <label key={p.name} className="flex items-center gap-2 text-dense">
            <input
              type="checkbox"
              className="h-4 w-4 accent-forge-700"
              checked={draft.targets.includes(p.name)}
              onChange={(e) => edit({ picked: e.target.checked ? [...draft.targets, p.name] : draft.targets.filter((x) => x !== p.name) })}
            />
            <span className="font-mono">{p.name}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-dense font-medium text-anvil-700 dark:text-anvil-200">Replication</legend>
        {CHOICES.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-dense">
            <input
              type="radio"
              name="replication"
              className="h-4 w-4 accent-forge-700"
              checked={choice === c.id}
              onChange={() => edit({ choice: c.id })}
            />
            {c.label}
          </label>
        ))}
      </fieldset>
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          // Only a real, changed policy saves: never a null one (L-10), never a no-op.
          disabled={!storable || draft.state !== 'changed'}
          aria-describedby={statusId}
          onClick={async () => {
            if (draft.state !== 'changed') return
            setErr(null)
            try {
              await save({ ...config, defaultPolicy: draft.policy })
              setEdits(null)
              setSaved(true)
            } catch (e) {
              setErr(errText(e))
            }
          }}
        >
          Save default
        </Button>
        <span
          id={statusId}
          role="status"
          aria-live="polite"
          data-testid="default-policy-status"
          className={cn('text-[12px]', tone)}
        >
          {status}
        </span>
        {err ? <span role="alert" className="text-[12px] text-danger-700 dark:text-danger-400">{err}</span> : null}
      </div>
    </section>
  )
}
