'use client'

/**
 * Settings → Profile (P1-7): the signer's forge-community `profile` document — display name, bio,
 * avatar, company, location and up to four links — edited as GitHub's "Public profile" page is.
 * Every field is checked by the shared rule as it is typed (`lib/rules/profile.ts`, the same one
 * `dg profile set` runs), and Save shows the write's cost, then signs through the standard write
 * flow (D-048). A profile is public: it says so above the form, since a member of a private repo
 * might take it for part of that repo.
 */

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Globe, Shuffle } from 'lucide-react'

import { NETWORKS } from '@/lib/constants'
import { deleteProfile, normalizeProfile, profileCost, profileDeleteRefund, readProfile, saveProfile, sameProfile, type Profile } from '@/lib/repo/profile'
import { avatarSpec, MAX_LINKS, PROFILE_LIMITS, profileProblems, type ProfileField, type ProfileFields, type ProfileInput } from '@/lib/rules/profile'
import { identityHref } from '@/lib/view/profile-links'
import { retryWhileMissing } from '@/lib/view/retry'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useDpnsName } from '@/hooks/use-dpns-name'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { CostPreview } from '@/components/ui/cost-preview'
import { Field, Input, Textarea } from '@/components/ui/input'
import { ProfileAvatar } from '@/components/ui/profile-avatar'
import { SigningKeysSection } from '@/components/signing-keys-section'
import { onRadioGroupKeyDown, radioTabIndex } from '@/components/ui/radio-group'
import { ErrorState, LoadingBlock } from '@/components/ui/states'

/** How the avatar is chosen: the default initial, a pattern, or an image link. */
type AvatarChoice = 'default' | 'identicon' | 'url'

interface Draft {
  readonly displayName: string
  readonly bio: string
  readonly company: string
  readonly location: string
  readonly links: readonly string[]
  readonly avatar: AvatarChoice
  /** The identicon seed: '' for the identity id (stored as plain `identicon`). */
  readonly seed: string
  readonly avatarUrl: string
  /**
   * A stored `avatarConfig` no convention reads (another client wrote it): shown, since saving
   * replaces it with the choice above (writers never store such a value).
   */
  readonly unknownAvatar: string | null
}

function draftOf(fields: ProfileFields): Draft {
  const config = fields.avatarConfig ?? ''
  const spec = avatarSpec(config, '')
  const links = [...(fields.links ?? [])]
  while (links.length < MAX_LINKS) links.push('')
  return {
    displayName: fields.displayName ?? '',
    bio: fields.bio ?? '',
    company: fields.company ?? '',
    location: fields.location ?? '',
    links,
    avatar: spec.kind === 'identicon' ? 'identicon' : spec.kind === 'url' ? 'url' : 'default',
    seed: spec.kind === 'identicon' ? spec.seed : '',
    avatarUrl: spec.kind === 'url' ? spec.url : '',
    unknownAvatar: spec.kind === 'invalid' ? config : null,
  }
}

/**
 * A link typed without a scheme reads as https (what a person pasting `alice.dev` means). A
 * scheme is a name and a colon followed by `//` or anything but a digit, so `alice.dev:8443/x`
 * is a host and port, not a scheme.
 */
export function withScheme(link: string): string {
  const t = link.trim()
  return t === '' || /^[a-z][a-z0-9+.-]*:(?:\/\/|[^0-9])/i.test(t) ? t : `https://${t}`
}

function inputOf(d: Draft): ProfileInput {
  const avatarConfig = d.avatar === 'identicon' ? (d.seed === '' ? 'identicon' : `identicon:${d.seed}`) : d.avatar === 'url' ? withScheme(d.avatarUrl) : null
  return {
    displayName: d.displayName,
    bio: d.bio,
    company: d.company,
    location: d.location,
    links: d.links.map(withScheme),
    avatarConfig,
  }
}

/** A fresh identicon seed: 8 random base-36 characters. */
function randomSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return [...bytes].map((b) => (b % 36).toString(36)).join('')
}

const LABEL: Readonly<Record<ProfileField, string>> = {
  displayName: 'Name',
  bio: 'Bio',
  avatarConfig: 'Avatar',
  links: 'Links',
  location: 'Location',
  company: 'Company',
}

/** The public-data notice (P1-7): a profile is never encrypted, whatever repos it shows beside. */
export function ProfilePublicNote({ className }: { className?: string }): JSX.Element {
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-md border border-anvil-200 bg-anvil-50 px-3 py-2 text-[12px] text-anvil-700 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-200',
        className,
      )}
      data-testid="profile-public-note"
    >
      <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Your profile is public. It is a Dash Platform document anyone can read, and it is never encrypted: it shows the same beside your private repositories as
        beside public ones. Leave out anything you would not post publicly.
      </span>
    </p>
  )
}

export function ProfileSettings(): JSX.Element {
  const { identity, signer } = useAuth()
  const { sdk, ready, network } = useSdk()
  const forge = NETWORKS[network].v2
  const name = useDpnsName(identity ?? '')
  const stored = useAsync<Profile | null>(() => readProfile(sdk!, forge!, identity!), [ready, identity ?? '', network], {
    enabled: ready && sdk !== null && forge !== null && identity !== null,
  })
  if (identity === null || forge === null) return <></>
  if (stored.error) return <ErrorState message={stored.error} onRetry={stored.reload} />
  // Until the read settles (the SDK still connecting, too), the form would claim there is no profile.
  if (!stored.settled) return <LoadingBlock label="Reading your profile" />
  return (
    <ProfileForm
      // A fresh form when the stored fields change (a save): what was saved is what it starts from.
      // Not on a signing-key write, which leaves the fields alone: unsaved edits survive it.
      key={`${stored.data?.id ?? 'none'}:${JSON.stringify(stored.data?.fields ?? {})}`}
      identity={identity}
      name={name ?? null}
      stored={stored.data}
      onSaved={stored.reload}
      ready={sdk !== null && signer !== null}
    />
  )
}

function ProfileForm({
  identity,
  name,
  stored,
  onSaved,
  ready,
}: {
  identity: string
  name: string | null
  stored: Profile | null
  onSaved: () => void
  ready: boolean
}): JSX.Element {
  const { signer } = useAuth()
  const { sdk, network } = useSdk()
  const forge = NETWORKS[network].v2!
  const guard = useWriteGuard()
  const [draft, setDraft] = useState<Draft>(() => draftOf(stored?.fields ?? {}))
  const [confirm, setConfirm] = useState<'save' | 'delete' | null>(null)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]): void => setDraft((d) => ({ ...d, [k]: v }))

  const input = useMemo(() => inputOf(draft), [draft])
  const problems = useMemo(() => profileProblems(input), [input])
  const valid = Object.keys(problems).length === 0
  const next = useMemo(() => (valid ? normalizeProfile(input) : null), [valid, input])
  const changed = next !== null && (stored === null ? Object.keys(next).length > 0 : !sameProfile(stored.fields, next))
  const cost = next === null ? null : profileCost(stored, next)
  const refund = profileDeleteRefund()

  const settle = async (want: (p: Profile | null) => boolean): Promise<void> => {
    // A node a block behind may still answer with the old profile: read until it shows the write.
    await retryWhileMissing(async () => ((await readProfile(sdk!, forge, identity).then(want)) ? true : null), 8)
    onSaved()
  }
  const save = async (intent: string): Promise<void> => {
    if (!sdk || !signer || next === null) throw new Error('sign in to continue')
    await saveProfile(sdk, signer, forge, stored, next, intent)
    await settle((p) => p !== null && sameProfile(p.fields, next))
  }
  const remove = async (): Promise<void> => {
    if (!sdk || !signer || stored === null) throw new Error('sign in to continue')
    await deleteProfile(sdk, signer, forge, stored)
    await settle((p) => p === null)
  }

  const err = (f: ProfileField): JSX.Element | null =>
    problems[f] ? (
      <p className="text-[12px] text-danger-700 dark:text-danger-400" role="alert" data-testid={`profile-error-${f}`}>
        {f === 'avatarConfig' && draft.avatar === 'url' ? 'The avatar image link must be an https:// link of at most 200 characters, with no spaces' : `${LABEL[f]} ${problems[f]}`}
      </p>
    ) : null
  const chars = (v: string, max: number): JSX.Element => (
    <span className={cn('font-mono text-[11px]', [...v.trim()].length > max ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400')}>
      {[...v.trim()].length} / {max}
    </span>
  )
  const avatarConfig = input.avatarConfig ?? undefined
  const choices: readonly { id: AvatarChoice; label: string }[] = [
    { id: 'default', label: 'Initial' },
    { id: 'identicon', label: 'Pattern' },
    { id: 'url', label: 'Image link' },
  ]

  return (
    <div className="space-y-5" data-testid="profile-settings">
      <ProfilePublicNote />
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_12rem]">
        <form
          className="min-w-0 space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (changed && cost !== null && guard.check(cost, 'community', 'save your profile')) setConfirm('save')
          }}
        >
          <Field label="Name" htmlFor="profile-name" hint="Shown above your username. Your DPNS username stays your address.">
            <Input id="profile-name" value={draft.displayName} onChange={(e) => set('displayName', e.target.value)} autoComplete="name" placeholder={name ?? ''} />
            {err('displayName')}
          </Field>
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <label htmlFor="profile-bio" className="block text-dense font-medium text-anvil-700 dark:text-anvil-200">
                Bio
              </label>
              {chars(draft.bio, PROFILE_LIMITS.bio.chars)}
            </div>
            <Textarea id="profile-bio" value={draft.bio} onChange={(e) => set('bio', e.target.value)} placeholder="Tell people a little about yourself" />
            {err('bio')}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company" htmlFor="profile-company">
              <Input id="profile-company" value={draft.company} onChange={(e) => set('company', e.target.value)} autoComplete="organization" />
              {err('company')}
            </Field>
            <Field label="Location" htmlFor="profile-location">
              <Input id="profile-location" value={draft.location} onChange={(e) => set('location', e.target.value)} />
              {err('location')}
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-dense font-medium text-anvil-700 dark:text-anvil-200">Links</legend>
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Up to {MAX_LINKS}, https only. A link typed without https:// gets it.</p>
            {draft.links.map((l, i) => (
              <Input
                key={i}
                aria-label={`Link ${i + 1}`}
                value={l}
                inputMode="url"
                placeholder="https://"
                onChange={(e) => set('links', draft.links.map((x, j) => (j === i ? e.target.value : x)))}
              />
            ))}
            {err('links')}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-dense font-medium text-anvil-700 dark:text-anvil-200">Avatar</legend>
            <div role="radiogroup" aria-label="Avatar" className="flex flex-wrap gap-2" onKeyDown={onRadioGroupKeyDown}>
              {choices.map((c, i) => {
                const checked = draft.avatar === c.id
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={radioTabIndex(checked, i, true)}
                    onClick={() => set('avatar', c.id)}
                    className={cn(
                      'hit-area rounded-md border px-3 py-1.5 text-dense coarse:min-h-11',
                      checked
                        ? 'border-forge-600 bg-forge-500/10 font-medium text-anvil-900 dark:text-anvil-50'
                        : 'border-anvil-300 text-anvil-700 hover:bg-anvil-100 dark:border-anvil-700 dark:text-anvil-200 dark:hover:bg-anvil-800',
                    )}
                  >
                    {c.label}
                  </button>
                )
              })}
            </div>
            {draft.avatar === 'identicon' ? (
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-anvil-600 dark:text-anvil-300">
                <span>Drawn in each browser from {draft.seed === '' ? 'your identity id' : <span className="font-mono">{draft.seed}</span>}; nothing is fetched.</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => set('seed', randomSeed())}>
                  <Shuffle className="h-3.5 w-3.5" aria-hidden /> Shuffle
                </Button>
              </div>
            ) : null}
            {draft.avatar === 'url' ? (
              <div className="space-y-1.5">
                <Input aria-label="Avatar image link" value={draft.avatarUrl} inputMode="url" placeholder="https://example.com/me.png" onChange={(e) => set('avatarUrl', e.target.value)} />
                <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
                  Forge stores the link, not the image. Visitors see your initial until they choose to load images from its host, which then learns their IP address.
                </p>
              </div>
            ) : null}
            {draft.unknownAvatar !== null ? (
              <p className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="profile-unknown-avatar">
                Your stored avatar setting <span className="font-mono [overflow-wrap:anywhere]">{draft.unknownAvatar}</span> is not one Forge reads, so your initial
                shows instead. Saving replaces it with the choice above.
              </p>
            ) : null}
            {err('avatarConfig')}
          </fieldset>

          <div className="flex flex-wrap items-center gap-2 border-t border-anvil-100 pt-4 dark:border-anvil-850">
            <Button type="submit" variant="primary" disabled={!ready || !changed || guard.disabledReason !== null} data-testid="profile-save">
              {stored === null ? 'Create profile' : 'Save profile'}
            </Button>
            {changed && cost !== null ? <CostPreview cost={cost} /> : null}
            {!changed && valid ? <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{stored === null ? 'Fill in a field to create your profile.' : 'No changes.'}</span> : null}
            <Link href={identityHref(identity)} className="hit-area ml-auto text-dense text-forge-700 underline dark:text-forge-400">
              View your profile
            </Link>
          </div>
        </form>
        <div className="order-first flex flex-col items-center gap-2 md:order-none">
          <ProfileAvatar identityId={identity} config={avatarConfig} size={160} />
          <span className="text-[12px] text-anvil-500 dark:text-anvil-400">Preview</span>
        </div>
      </div>

      <SigningKeysSection identity={identity} stored={stored} onSaved={onSaved} />

      {stored !== null ? (
        <section aria-labelledby="profile-delete-title" className="rounded-lg border border-danger/30 p-4">
          <h2 id="profile-delete-title" className="text-dense font-medium text-anvil-800 dark:text-anvil-100">
            Delete profile
          </h2>
          <p className="mt-1 text-[12px] text-anvil-600 dark:text-anvil-300">
            Removes the profile document (name, bio, avatar, links and signing keys) and refunds part of its storage fee. Your identity, username and repos stay.
          </p>
          <Button className="mt-3" size="sm" variant="danger" disabled={!ready} onClick={() => guard.check(0, 'community', 'delete your profile') && setConfirm('delete')}>
            Delete profile
          </Button>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirm === 'save'}
        onClose={() => setConfirm(null)}
        title={stored === null ? 'Create your profile?' : 'Save your profile?'}
        description="Your profile is a public document on Platform, signed by this browser's key. Anyone can read it."
        cost={cost}
        confirmLabel="Sign & save"
        toast={{ running: 'Saving your profile…', done: 'Profile saved' }}
        onConfirm={save}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title="Delete your profile?"
        description="Removes your profile document from Platform and returns part of its storage fee."
        cost={refund}
        refund
        confirmLabel="Sign & delete"
        toast={{ running: 'Deleting your profile…', done: 'Profile deleted' }}
        onConfirm={remove}
      />
    </div>
  )
}
