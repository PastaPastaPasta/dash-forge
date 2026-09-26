'use client'

/**
 * `/settings/storage` — the storage wizard (`ux-dx-spec.md` §3.1): provider tiles, the
 * per-provider form, the live browser test, then save; the saved profiles; where browser
 * pushes go by default (replication radio); and the cost card, always visible.
 *
 * Everything saved is sealed in the vault with this browser's key (`lib/storage/store.ts`).
 */

import { useState } from 'react'
import { Cloud, Database, HardDrive, Link2, Pencil, Server, Trash2, Waypoints } from 'lucide-react'
import {
  PROVIDERS,
  choiceOf,
  policyFor,
  policyProblem,
  providerPreset,
  withProfile,
  withoutProfile,
  type ProviderId,
  type ReplicationChoice,
  type StorageConfig,
  type StorageProfile,
} from '@/lib/storage'
import { errText } from '@/lib/storage/util'
import { useStorageConfig } from '@/hooks/use-storage-config'
import { Button } from '@/components/ui/button'
import { ErrorState, LoadingBlock } from '@/components/ui/states'
import { ProfileForm } from '@/components/storage/profile-form'
import { StorageTest } from '@/components/storage/storage-test'
import { CostCard } from '@/components/storage/cost-card'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/view/format'

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
  const { config, loading, error, storable, save, reload } = useStorageConfig()
  const [provider, setProvider] = useState<ProviderId | null>(null)
  const [editing, setEditing] = useState<StorageProfile | null>(null)

  if (loading && !config) return <LoadingBlock label="Opening your storage settings" />
  if (error) return <ErrorState title="Could not open your storage settings" message={error} onRetry={reload} />
  if (!config) return <LoadingBlock />

  const start = (p: ProviderId, existing: StorageProfile | null = null): void => {
    setEditing(existing)
    setProvider(p)
  }

  return (
    <div className="space-y-6">
      {!storable ? (
        <p className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution">
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
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', p.id === 'platform' ? 'text-dash-600 dark:text-dash-400' : 'text-forge-600 dark:text-forge-400')} aria-hidden />
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
  const [draft, setDraft] = useState<{ profile: StorageProfile; problem: string | null } | null>(null)
  const [tested, setTested] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  if (provider === 'platform') {
    const has = config.profiles.some((p) => p.settings.kind === 'platform')
    return (
      <section className="space-y-3 rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-750 dark:bg-anvil-900" aria-label="Dash Platform storage">
        <h3 className="text-prose">Dash Platform</h3>
        <p className="text-dense text-anvil-600 dark:text-anvil-300">
          Packs stored as Platform documents: permanent, readable by anyone, nothing to run. Priced at about 0.28 DASH per MiB, charged when you push, and never refunded (Platform storage cannot be deleted, so nobody can break a repo others depend on). Every Platform write asks first, with its price.
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
                await save(withProfile(config, { name: 'platform', settings: { kind: 'platform', provider: 'platform' }, secrets: {} }))
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

  return (
    <section className="space-y-4 rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-750 dark:bg-anvil-900" aria-label={`${preset.title} settings`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-prose">{existing ? `Edit ${existing.name}` : preset.title}</h3>
        <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{preset.blurb}</span>
      </div>
      <ProfileForm
        provider={provider}
        existing={existing}
        onChange={(profile, p) => {
          setDraft({ profile, problem: p })
          setTested(null)
        }}
      />
      {blocking && draft ? <p className="text-[12px] text-caution">{blocking}</p> : null}
      {draft && !blocking ? <StorageTest profile={draft.profile} onDone={setTested} /> : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-anvil-100 pt-3 dark:border-anvil-850">
        <Button
          variant="primary"
          size="sm"
          disabled={blocking !== null || tested === null || !storable}
          loading={saving}
          onClick={async () => {
            if (!draft) return
            setSaving(true)
            setSaveError(null)
            try {
              let next = existing && existing.name !== draft.profile.name ? withoutProfile(config, existing.name) : config
              next = withProfile(next, draft.profile)
              next = { ...next, lastTests: { ...next.lastTests, [draft.profile.name]: { at: Date.now(), ok: tested === true } } }
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
        <span className="text-[12px] text-anvil-500 dark:text-anvil-400">
          {tested === null ? 'Run the test first.' : tested ? 'All checks passed.' : 'Some checks failed: you can still save, but browser pushes need them all.'}
        </span>
      </div>
      {saveError ? <p role="alert" className="text-dense text-danger-700 dark:text-danger-400">{saveError}</p> : null}
    </section>
  )
}

function Profiles({ config, storable, save, onEdit }: { config: StorageConfig; storable: boolean; save: (c: StorageConfig) => Promise<void>; onEdit: (p: StorageProfile) => void }): JSX.Element {
  return (
    <section aria-labelledby="profiles-title" className="space-y-2">
      <h2 id="profiles-title" className="text-dense font-medium text-anvil-500 dark:text-anvil-400">
        Your storage
      </h2>
      {config.profiles.length === 0 ? (
        <p className="rounded-lg border border-dashed border-anvil-300 px-4 py-5 text-center text-dense text-anvil-500 dark:border-anvil-700 dark:text-anvil-400">
          No storage yet. Browser pushes (merges, forks) would store packs on Platform at ~0.28 DASH/MiB, asking first.
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
                  <span className={cn('text-[12px]', test.ok ? 'text-verify' : 'text-caution')}>
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
                      if (window.confirm(`Remove ${p.name} from this browser? Packs already stored there stay; repos that point at it will ask for another place on their next browser push.`)) void save(withoutProfile(config, p.name))
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

function DefaultPolicy({ config, storable, save }: { config: StorageConfig; storable: boolean; save: (c: StorageConfig) => Promise<void> }): JSX.Element | null {
  const current = config.defaultPolicy
  const [targets, setTargets] = useState<string[]>(() => current?.targets.slice() ?? [])
  const [choice, setChoice] = useState<ReplicationChoice>(() => (current ? choiceOf(current) : 'one'))
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (config.profiles.length === 0) return null
  const policy = targets.length > 0 ? policyFor(targets, choice) : null
  const problem = policy ? policyProblem(config, policy) : null

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
              checked={targets.includes(p.name)}
              onChange={(e) => {
                setSaved(false)
                setTargets((t) => (e.target.checked ? [...t, p.name] : t.filter((x) => x !== p.name)))
              }}
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
              onChange={() => {
                setSaved(false)
                setChoice(c.id)
              }}
            />
            {c.label}
          </label>
        ))}
      </fieldset>
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={!storable || problem !== null}
          onClick={async () => {
            setErr(null)
            try {
              await save({ ...config, defaultPolicy: policy })
              setSaved(true)
            } catch (e) {
              setErr(errText(e))
            }
          }}
        >
          Save default
        </Button>
        {problem && targets.length > 0 ? <span className="text-[12px] text-caution">{problem}</span> : null}
        {saved ? <span className="text-[12px] text-verify">Saved.</span> : null}
        {err ? <span role="alert" className="text-[12px] text-danger-700 dark:text-danger-400">{err}</span> : null}
      </div>
    </section>
  )
}
