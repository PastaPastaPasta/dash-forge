'use client'

/**
 * The per-provider form of the storage wizard (`ux-dx-spec.md` §3.1 step 2): the fields the
 * guide names, each with a "where to find this" hint. Secret fields carry a lock and say where
 * they go. Values live in component state only until saved into the vault.
 */

import { useId, useState } from 'react'
import { ExternalLink, Lock } from 'lucide-react'
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

type Values = Record<string, string | boolean>

/** Providers whose suggested profile name is the provider id itself (the rest get `-main`). */
const BARE_NAMES: readonly ProviderId[] = ['aws', 'minio', 'kubo', 'pinning']

function initialValues(provider: ProviderId, existing: StorageProfile | null): Values {
  const preset = providerPreset(provider)
  if (existing) {
    const out: Values = { name: existing.name }
    for (const [k, v] of [...Object.entries(existing.settings), ...Object.entries(existing.secrets)]) {
      if (typeof v === 'string' || typeof v === 'boolean') out[k] = v
    }
    return out
  }
  const base: Values = { name: BARE_NAMES.includes(provider) ? provider : `${provider}-main` }
  const empty: Values =
    preset.kind === 's3'
      ? { endpoint: '', region: 'us-east-1', bucket: '', pathStyle: true, publicUrl: '', prefix: '', accessKeyId: '', secretAccessKey: '', sessionToken: '' }
      : { api: '', gateway: '', publicGateway: '', pinningEndpoint: '', apiAuth: '', pinningToken: '' }
  const defaults: Values = {}
  for (const [k, v] of Object.entries(preset.defaults)) if (v !== undefined) defaults[k] = v
  return { ...base, ...empty, ...defaults }
}

const str = (v: string | boolean | undefined): string => (typeof v === 'string' ? v.trim() : '')
/** A URL field, trimmed and without trailing slashes. */
const url = (v: string | boolean | undefined): string => str(v).replace(/\/+$/, '')

/** The profile the form's values describe. */
export function profileFromValues(provider: ProviderId, v: Values): StorageProfile {
  const preset = providerPreset(provider)
  const secret = (k: keyof ProfileSecrets): Partial<ProfileSecrets> => (str(v[k]) ? { [k]: str(v[k]) } : {})
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
    return { name: str(v['name']), settings, secrets: { ...secret('accessKeyId'), ...secret('secretAccessKey'), ...secret('sessionToken') } }
  }
  if (preset.kind === 'platform') return { name: str(v['name']) || 'platform', settings: { kind: 'platform', provider: 'platform' }, secrets: {} }
  settings = {
    kind: preset.kind === 'ipfs-pinning-service' ? 'ipfs-pinning-service' : 'ipfs-kubo',
    provider: provider as 'kubo' | 'pinning',
    api: url(v['api']),
    gateway: url(v['gateway']),
    publicGateway: url(v['publicGateway']),
    pinningEndpoint: url(v['pinningEndpoint']),
  }
  return { name: str(v['name']), settings, secrets: { ...secret('apiAuth'), ...secret('pinningToken') } }
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
    { key: 'apiAuth', label: 'API Authorization header', secret: true, optional: true, placeholder: 'Basic …' },
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
  const set = (k: string, v: string | boolean): void => {
    const next = { ...values, [k]: v }
    setValues(next)
    const p = profileFromValues(provider, next)
    onChange(p, profileProblem(p))
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {fieldsFor(provider).map((f) => {
        const hint = preset.hints[f.key]
        const id = `${idBase}-${f.key}`
        return (
          <div key={f.key} className={f.key === 'endpoint' || f.key === 'publicUrl' || f.key === 'api' || f.key === 'pinningEndpoint' ? 'sm:col-span-2' : ''}>
            <label htmlFor={id} className="mb-1 flex items-center gap-1.5 text-dense font-medium text-anvil-700 dark:text-anvil-200">
              {f.secret ? <Lock className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden /> : null}
              {f.label}
              {f.optional ? <span className="font-normal text-anvil-500 dark:text-anvil-400">(optional)</span> : null}
            </label>
            <Input
              id={id}
              type={f.secret ? 'password' : 'text'}
              autoComplete={f.secret ? 'new-password' : 'off'}
              spellCheck={false}
              className="font-mono"
              placeholder={f.placeholder}
              value={typeof values[f.key] === 'string' ? (values[f.key] as string) : ''}
              onChange={(e) => set(f.key, e.target.value)}
              aria-describedby={hint || f.secret ? `${id}-hint` : undefined}
            />
            {hint || f.secret ? (
              <p id={`${id}-hint`} className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                {f.secret ? SECRET_NOTE : null}
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
