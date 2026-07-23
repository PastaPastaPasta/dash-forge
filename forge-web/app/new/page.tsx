'use client'

/**
 * `/new` — create a repository. Instantiates the per-repo token contract (~1.18 DASH,
 * CRITICAL key) + initial config + registry listing. The 1.18 DASH cost is previewed and
 * confirmed before signing; on success we jump to the new repo home.
 */

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { GitBranch, Hammer, Lock } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/ui/states'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { useSdk } from '@/hooks/use-sdk'
import { createRepo, normalizeRepoName } from '@/lib/repo'
import { previewCredits, COST_ESTIMATE_CREDITS } from '@/lib/sdk'

const BACKENDS = [
  { mode: 0, label: '⛓ platform', hint: 'Pack bytes stored on Dash Platform' },
  { mode: 1, label: '🌐 ipfs', hint: 'Bytes on IPFS, hashes on Platform' },
  { mode: 2, label: '🌐 s3', hint: 'Bytes on S3-compatible storage' },
  { mode: 3, label: '🌐 https', hint: 'Bytes at an HTTPS origin' },
]

export default function NewRepoPage(): JSX.Element {
  const router = useRouter()
  const { sdk } = useSdk()
  const { identity, signer } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [backendMode, setBackendMode] = useState(0)
  const [confirm, setConfirm] = useState(false)

  const nameError = useMemo(() => {
    if (name.trim() === '') return null
    try {
      normalizeRepoName(name.trim())
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'invalid name'
    }
  }, [name])

  const cost = previewCredits(COST_ESTIMATE_CREDITS.repoCreate)

  const create = async (): Promise<void> => {
    if (!sdk || !signer) throw new Error('sign in first')
    const result = await createRepo(sdk, signer, name.trim(), {
      defaultBranch,
      backendMode,
      description: description.trim(),
    })
    void result
    router.push(`/repo?owner=${encodeURIComponent(identity ?? '')}&name=${encodeURIComponent(normalizeRepoName(name.trim()))}`)
  }

  if (!identity) {
    return (
      <AppShell>
        <EmptyState
          icon={Lock}
          title="Sign in to forge a repo"
          body="Creating a repo instantiates its on-chain token contract — that needs your identity's key."
          action={<Button variant="primary" onClick={openLogin}>Sign in</Button>}
        />
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-forge-500/15">
            <Hammer className="h-5 w-5 text-forge-500" aria-hidden />
          </span>
          <div>
            <h1 className="text-xl">Forge a new repo</h1>
            <p className="text-dense text-anvil-500 dark:text-anvil-400">A fresh contract, owned by your identity.</p>
          </div>
        </div>

        <div className="space-y-4">
          <Field label="Repository name" htmlFor="repo-name" hint="Lowercase; letters, digits, and . _ - (max 63).">
            <Input
              id="repo-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="forge-core"
              className="font-mono"
              spellCheck={false}
              autoFocus
            />
          </Field>
          {nameError ? <p className="-mt-2 text-[12px] text-danger">{nameError}</p> : null}

          <Field label="Description" htmlFor="repo-desc" hint="Shown in discovery. Optional.">
            <Textarea id="repo-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this repo for?" className="min-h-[72px]" />
          </Field>

          <Field label="Default branch" htmlFor="repo-branch">
            <div className="relative">
              <GitBranch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-anvil-400" aria-hidden />
              <Input id="repo-branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} className="pl-8 font-mono" />
            </div>
          </Field>

          <Field label="Storage backend" hint="Where pack bytes live. You can change this later in settings.">
            <div className="grid grid-cols-2 gap-2">
              {BACKENDS.map((b) => (
                <button
                  key={b.mode}
                  type="button"
                  onClick={() => setBackendMode(b.mode)}
                  className={
                    'rounded-md border px-3 py-2 text-left text-dense transition-colors ' +
                    (backendMode === b.mode
                      ? 'border-forge-500 bg-forge-500/5'
                      : 'border-anvil-200 hover:bg-anvil-50 dark:border-anvil-750 dark:hover:bg-anvil-850')
                  }
                >
                  <div className="font-medium">{b.label}</div>
                  <div className="mt-0.5 text-[11px] text-anvil-500 dark:text-anvil-400">{b.hint}</div>
                </button>
              ))}
            </div>
          </Field>

          <CostPreview cost={cost} />

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={name.trim() === '' || nameError !== null}
            onClick={() => setConfirm(true)}
          >
            Create repository
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Create this repository?"
        description="This instantiates a new on-chain token contract with your identity's CRITICAL key. It cannot be deleted (the contract is permanent), only archived."
        cost={cost}
        confirmLabel="Sign & create"
        successNote="Contract created — opening your repo"
        onConfirm={create}
      />
    </AppShell>
  )
}
