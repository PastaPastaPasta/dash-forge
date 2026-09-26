'use client'

/**
 * The per-provider form of the storage wizard (`ux-dx-spec.md` §3.1 step 2): the fields the
 * guide names, each with a "where to find this" hint. Secret fields carry a lock and say where
 * they go. Values live in component state only until saved into the vault.
 *
 * Editing a saved profile never puts its stored secrets back into the page: secret fields start
 * empty, and an empty field keeps the stored value. Autocomplete is off everywhere, so a
 * password manager neither offers to generate a value nor saves a bucket secret to a synced
 * store.
 */

import { useId, useState } from 'react'
import { AlertTriangle, ExternalLink, Lock } from 'lucide-react'
import {
  profileProblem,
  providerPreset,
  type ProfilePublic,
  type ProfileSecrets,
  type ProviderId,
  type StorageProfile,
} from '@/lib/storage'
import { Input } from '@/components/ui/input'

const SECRET_NOTE = 'Stored encrypted in this browser only. Never sent to Forge (there is no Forge server) and never written on-chain.'
const KEEP_NOTE = 'Leave empty to keep the stored value.'

type Values = Record<string, string | boolean>
const SECRET_KEYS: readonly (keyof ProfileSecrets)[] = ['accessKeyId', 'secretAccessKey', 'sessionToken', 'apiAuth', 'pinningToken']

/** Providers whose suggested profile name is the provider id itself (the rest get `-main`). */
const BARE_NAMES: readonly ProviderId[] = ['aws', 'minio', 'kubo', 'pinning']

function initialValues(provider: ProviderId, existing: StorageProfile | null): Values {
  const preset = providerPreset(provider)
  const empty: Values =
    preset.kind === 's3'
      ? { endpoint: '', region: 'us-east-1', bucket: '', pathStyle: true, publicUrl: '', prefix: '', accessKeyId: '', secretAccessKey: '', sessionToken: '' }
      : { api: '', gateway: '', publicGateway: '', pinningEndpoint: '', apiAuth: '', pinningToken: '' }
  if (existing) {
    // Public settings only; secrets stay out of the DOM.
    const out: Values = { ...empty, name: existing.name }
    for (const [k, v] of Object.entries(existing.settings)) {
      if (typeof v === 'string' || typeof v === 'boolean') out[k] = v
    }
    return out
  }
  const defaults: Values = {}
  for (const [k, v] of Object.entries(preset.defaults)) if (v !== undefined) defaults[k] = v
  return { name: BARE_NAMES.includes(provider) ? provider : `${provider}-main`, ...empty, ...defaults }
}

const str = (v: string | boolean | undefined): string => (typeof v === 'string' ? v.trim() : '')
/** A URL field, trimmed and without trailing slashes. */
const url = (v: string | boolean | undefined): string => str(v).replace(/\/+$/, '')

/**
 * The profile the form's values describe. A secret field left empty while editing keeps the
 * stored value (`kept`).
 */
export function profileFromValues(provider: ProviderId, v: Values, kept: ProfileSecrets = {}): StorageProfile {
  const preset = providerPreset(provider)
  const secrets: Record<string, string> = {}
  for (const k of SECRET_KEYS) {
    const value = str(v[k]) || kept[k]
    if (value) secrets[k] = value
  }
  let settings: ProfilePublic
  if (preset.kind === 's3') {
    settings = {
      kind: 's3',
      provider: provider as 'r2' | 'b2' | 'aws' | 'minio',
      endpoint: url(v['endpoint']),
      region: str(v['region']) || 'us-east-1',
      bucket: str(v['bucket']),
      pathStyle: v['pathStyle'] !== false,
      publicUrl: url(v['publicUrl']),
      prefix: str(v['prefix']),
    }
    const { accessKeyId, secretAccessKey, sessionToken } = secrets
    return { name: str(v['name']), settings, secrets: { ...(accessKeyId ? { accessKeyId } : {}), ...(secretAccessKey ? { secretAccessKey } : {}), ...(sessionToken ? { sessionToken } : {}) } }
  }
  if (preset.kind === 'platform') return { name: 'platform', settings: { kind: 'platform', provider: 'platform' }, secrets: {} }
  settings = {
    kind: preset.kind === 'ipfs-pinning-service' ? 'ipfs-pinning-service' : 'ipfs-kubo',
    provider: provider as 'kubo' | 'pinning',
    api: url(v['api']),
    gateway: url(v['gateway']),
    publicGateway: url(v['publicGateway']),
    pinningEndpoint: preset.kind === 'ipfs-pinning-service' ? url(v['pinningEndpoint']) : '',
  }
  const { apiAuth, pinningToken } = secrets
  return { name: str(v['name']), settings, secrets: { ...(apiAuth ? { apiAuth } : {}), ...(pinningToken && preset.kind === 'ipfs-pinning-service' ? { pinningToken } : {}) } }
}

/** The draft a form starts from (so an edit can be tested before any field changes). */
export function initialDraft(provider: ProviderId, existing: StorageProfile | null): StorageProfile {
  return profileFromValues(provider, initialValues(provider, existing), existing?.secrets ?? {})
}

interface FieldSpec {
  readonly key: string
  readonly label: string
  readonly secret?: boolean
  readonly optional?: boolean
  readonly placeholder?: string
}

function fieldsFor(provider: ProviderId): FieldSpec[] {
  const kind = providerPreset(provider).kind
  if (kind === 's3') {
    return [
      { key: 'name', label: 'Profile name' },
      { key: 'endpoint', label: 'S3 endpoint' },
      { key: 'region', label: 'Region' },
      { key: 'bucket', label: 'Bucket' },
      { key: 'publicUrl', label: 'Public URL', placeholder: 'https://pub-….r2.dev' },
      { key: 'prefix', label: 'Key prefix', optional: true, placeholder: 'forge/' },
      { key: 'accessKeyId', label: 'Access key id', secret: true },
      { key: 'secretAccessKey', label: 'Secret access key', secret: true },
      { key: 'sessionToken', label: 'Session token (temporary credentials)', secret: true, optional: true },
    ]
  }
  if (kind === 'platform') return []
  const f: FieldSpec[] = [
    { key: 'name', label: 'Profile name' },
    { key: 'api', label: 'kubo RPC API' },
    { key: 'gateway', label: 'Gateway (verification re-read)', optional: true },
    { key: 'publicGateway', label: 'Public gateway (recorded for browsers)', optional: true },
    { key: 'apiAuth', label: 'API Authorization header', secret: true, optional: true, placeholder: 'Bearer …' },
  ]
  if (kind === 'ipfs-pinning-service') {
    f.push({ key: 'pinningEndpoint', label: 'Pinning Service API URL' }, { key: 'pinningToken', label: 'Pinning access token', secret: true })
  }
  return f
}

export function ProfileForm({
  provider,
  existing,
  onChange,
}: {
  provider: ProviderId
  existing: StorageProfile | null
  /** The profile the form currently describes, with why it is not usable yet (or null). */
  onChange: (profile: StorageProfile, problem: string | null) => void
}): JSX.Element {
  const preset = providerPreset(provider)
  const [values, setValues] = useState<Values>(() => initialValues(provider, existing))
  const idBase = useId()
  const kept = existing?.secrets ?? {}
  const set = (k: string, v: string | boolean): void => {
    const next = { ...values, [k]: v }
    setValues(next)
    const p = profileFromValues(provider, next, kept)
    onChange(p, profileProblem(p))
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-lpignore="true">
      {preset.kind === 'ipfs-kubo' || preset.kind === 'ipfs-pinning-service' ? (
        <div role="note" className="flex items-start gap-2 rounded-md border border-caution/40 bg-caution/5 p-3 text-[12px] text-anvil-700 dark:text-anvil-200 sm:col-span-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-caution" aria-hidden />
          <span>
            kubo’s RPC API is the node’s <span className="font-medium">admin</span> interface. Letting this web app call it means trusting this site with your node, unless kubo limits the token it uses. Create a token restricted to add, pin-check, unpin and id (kubo <span className="font-mono">API.Authorizations</span> with <span className="font-mono">AllowedPaths</span>; the test prints the commands if the node refuses this origin) and paste it as the API Authorization header.
          </span>
        </div>
      ) : null}
      {fieldsFor(provider).map((f) => {
        const hint = preset.hints[f.key]
        const id = `${idBase}-${f.key}`
        const keepable = f.secret === true && existing !== null && kept[f.key as keyof ProfileSecrets] !== undefined
        return (
          <div key={f.key} className={f.key === 'endpoint' || f.key === 'publicUrl' || f.key === 'api' || f.key === 'pinningEndpoint' ? 'sm:col-span-2' : ''}>
            <label htmlFor={id} className="mb-1 flex items-center gap-1.5 text-dense font-medium text-anvil-700 dark:text-anvil-200">
              {f.secret ? <Lock className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden /> : null}
              {f.label}
              {f.optional ? <span className="font-normal text-anvil-500 dark:text-anvil-400">(optional)</span> : null}
            </label>
            <Input
              id={id}
              name={`forge-storage-${f.key}`}
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              spellCheck={false}
              className="font-mono"
              placeholder={keepable ? '•••••••• (stored)' : f.placeholder}
              value={typeof values[f.key] === 'string' ? (values[f.key] as string) : ''}
              onChange={(e) => set(f.key, e.target.value)}
              aria-describedby={hint || f.secret ? `${id}-hint` : undefined}
            />
            {hint || f.secret ? (
              <p id={`${id}-hint`} className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                {f.secret ? SECRET_NOTE : null}
                {keepable ? ` ${KEEP_NOTE}` : null}
                {f.secret && hint ? ' ' : null}
                {hint ? (
                  <>
                    {hint.text}
                    {hint.href ? (
                      <>
                        {' '}
                        <a href={hint.href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 text-forge-700 underline dark:text-forge-400">
                          where to find this <ExternalLink className="h-3 w-3" aria-hidden />
                        </a>
                      </>
                    ) : null}
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        )
      })}
      {preset.kind === 's3' ? (
        <label className="flex items-center gap-2 text-dense text-anvil-700 dark:text-anvil-200 sm:col-span-2">
          <input type="checkbox" checked={values['pathStyle'] !== false} onChange={(e) => set('pathStyle', e.target.checked)} className="h-4 w-4 accent-forge-700" />
          Path-style addressing (endpoint/bucket/key). R2, B2 and MinIO want it; AWS works either way.
        </label>
      ) : null}
    </div>
  )
}
