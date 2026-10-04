'use client'

/**
 * Settings → Profile → Signing keys (P1-7): the SSH and OpenPGP keys this identity signs commits
 * with, published in its profile's `pubkeys` so its signed commits show Verified
 * (`lib/rules/signature.ts`). Paste a public key to add it; remove one by its fingerprint. Each
 * change is one paid write with its cost confirmed first, like every other profile edit.
 */

import { useEffect, useMemo, useState } from 'react'
import { KeyRound, Trash2 } from 'lucide-react'

import { NETWORKS } from '@/lib/constants'
import { forgetRepoSigners } from '@/lib/repo/signers'
import { keyEntry, MAX_KEYS, pubkeysCost, savePubkeys, withKey } from '@/lib/repo/signing-keys'
import { readProfile, type Profile } from '@/lib/repo/profile'
import { readPubkeyEntry, type PubkeyEntryView } from '@/lib/rules/signature'
import { retryWhileMissing } from '@/lib/view/retry'
import { errorMessage } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'

type Pending = { readonly kind: 'add' | 'remove'; readonly keys: readonly string[]; readonly label: string }

export function SigningKeysSection({ identity, stored, onSaved }: { identity: string; stored: Profile | null; onSaved: () => void }): JSX.Element {
  const { signer } = useAuth()
  const { sdk, network } = useSdk()
  const forge = NETWORKS[network].v2!
  const guard = useWriteGuard()
  const keys = useMemo(() => stored?.pubkeys ?? [], [stored])
  const [views, setViews] = useState<PubkeyEntryView[]>([])
  const [pasted, setPasted] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  useEffect(() => {
    let live = true
    void Promise.all(keys.map(readPubkeyEntry)).then((v) => live && setViews(v))
    return () => {
      live = false
    }
  }, [keys.join('\n')]) // eslint-disable-line react-hooks/exhaustive-deps -- the keys by value

  const propose = async (): Promise<void> => {
    setProblem(null)
    try {
      const entry = await keyEntry(pasted)
      const next = await withKey(keys, entry)
      const view = await readPubkeyEntry(entry)
      const p: Pending = { kind: 'add', keys: next, label: `${view.kind === 'ssh' ? 'SSH' : 'OpenPGP'} key ${view.fingerprint ?? ''}` }
      if (guard.check(pubkeysCost(stored, next), 'community', 'add a signing key')) setPending(p)
    } catch (e) {
      setProblem(errorMessage(e))
    }
  }
  const remove = (i: number): void => {
    const next = keys.filter((_, j) => j !== i)
    const p: Pending = { kind: 'remove', keys: next, label: views[i]?.fingerprint ?? 'this key' }
    // A removal is a paid replace too: the funds check runs on its cost.
    if (guard.check(pubkeysCost(stored, next), 'community', 'remove a signing key')) setPending(p)
  }
  const run = async (intent: string): Promise<void> => {
    if (!sdk || !signer || pending === null) throw new Error('sign in to continue')
    const want = pending.keys
    await savePubkeys(sdk, signer, forge, stored, want, intent)
    forgetRepoSigners()
    await retryWhileMissing(async () => {
      const p = await readProfile(sdk, forge, identity)
      const got = p?.pubkeys ?? []
      return got.length === want.length && got.every((k, i) => k === want[i]) ? true : null
    }, 8)
    setPasted('')
    onSaved()
  }

  return (
    <section aria-labelledby="signing-keys" className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="signing-keys">
      <h2 id="signing-keys" className="flex items-center gap-2 text-dense font-medium text-anvil-800 dark:text-anvil-100">
        <KeyRound className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
        Signing keys
      </h2>
      <p className="mt-1 text-[12px] text-anvil-600 dark:text-anvil-300">
        Commits you sign with these keys show <span className="font-medium">Verified</span> in repos you belong to. Ed25519 SSH keys and Ed25519 or
        ECDSA OpenPGP keys work. RSA keys are too large. These keys are public. From a terminal, use <span className="font-mono">dg profile key add</span>.
      </p>
      {keys.length > 0 ? (
        <ul className="mt-3 divide-y divide-anvil-100 rounded-md border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800" data-testid="signing-key-list">
          {keys.map((k, i) => (
            <li key={k} className="flex items-center gap-3 px-3 py-2 text-[12px]">
              <span className="w-16 shrink-0 font-medium text-anvil-700 dark:text-anvil-200">{views[i]?.kind === 'ssh' ? 'SSH' : views[i]?.kind === 'openpgp' ? 'OpenPGP' : '…'}</span>
              <span className="min-w-0 flex-1 break-all font-mono text-anvil-600 dark:text-anvil-300">
                {views[i]?.fingerprint ?? ''}
                {views[i] !== undefined && !views[i]!.verifiable ? <span className="ml-1 font-sans text-caution-700 dark:text-caution-400">(not verifiable)</span> : null}
              </span>
              <Button size="icon" variant="ghost" aria-label={`Remove key ${views[i]?.fingerprint ?? ''}`} onClick={() => remove(i)}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {keys.length < MAX_KEYS ? (
        <div className="mt-3 space-y-2">
          <label htmlFor="signing-key-paste" className="block text-dense font-medium text-anvil-700 dark:text-anvil-200">
            Add a key
          </label>
          <Textarea
            id="signing-key-paste"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            className="min-h-[72px] font-mono text-[12px]"
            placeholder={'ssh-ed25519 AAAA… you@laptop\nor -----BEGIN PGP PUBLIC KEY BLOCK----- … (gpg --armor --export <key id>)'}
          />
          {problem !== null ? (
            <p className="text-[12px] text-danger-700 dark:text-danger-400" role="alert" data-testid="signing-key-problem">
              {problem}
            </p>
          ) : null}
          <Button size="sm" disabled={pasted.trim() === ''} onClick={() => void propose()} data-testid="signing-key-add">
            Add key
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-anvil-500 dark:text-anvil-400">A profile lists at most {MAX_KEYS} keys: remove one to add another.</p>
      )}
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending?.kind === 'remove' ? 'Remove this signing key?' : 'Publish this signing key?'}
        description={
          pending?.kind === 'remove'
            ? `Removes ${pending.label} from your profile. Commits signed with it then show Unverified.`
            : `Adds ${pending?.label ?? 'the key'} to your public profile.`
        }
        cost={pending === null ? null : pubkeysCost(stored, pending.keys)}
        confirmLabel={pending?.kind === 'remove' ? 'Sign & remove' : 'Sign & publish'}
        toast={{ running: 'Saving your signing keys…', done: 'Signing keys saved' }}
        onConfirm={run}
      />
    </section>
  )
}
