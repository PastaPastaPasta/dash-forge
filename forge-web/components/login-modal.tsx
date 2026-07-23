'use client'

/**
 * Login modal — imports a bridge identity file OR a pasted WIF + identity id into the headless
 * {@link useAuth} session. The signing key is stored in the network keystore and never enters
 * React state (see AuthController). Read-only browsing works logged-out; this only gates writes.
 */

import { useRef, useState } from 'react'
import { KeyRound, Upload } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { DEFAULT_NETWORK } from '@/lib/constants'
import { errorMessage } from '@/lib/utils'

type Tab = 'file' | 'key'

export function LoginModal(): JSX.Element {
  const open = useUiStore((s) => s.loginOpen)
  const close = useUiStore((s) => s.closeLogin)
  const { login, loginWithIdentityFile, isLoading, error } = useAuth()

  const [tab, setTab] = useState<Tab>('file')
  const [identityId, setIdentityId] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const shownError = localError ?? error

  const onFile = async (file: File): Promise<void> => {
    setLocalError(null)
    try {
      const text = await file.text()
      await loginWithIdentityFile(text)
      close()
    } catch (e) {
      setLocalError(errorMessage(e))
    }
  }

  const onKeyLogin = async (): Promise<void> => {
    setLocalError(null)
    try {
      await login(identityId.trim(), privateKey.trim())
      close()
    } catch (e) {
      setLocalError(errorMessage(e))
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Sign in to Dash Forge"
      description={`Your key signs writes on ${DEFAULT_NETWORK}. It stays in your browser — never sent anywhere.`}
    >
      <div className="mb-4 inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
        <TabButton active={tab === 'file'} onClick={() => setTab('file')}>
          <Upload className="h-3.5 w-3.5" aria-hidden /> Identity file
        </TabButton>
        <TabButton active={tab === 'key'} onClick={() => setTab('key')}>
          <KeyRound className="h-3.5 w-3.5" aria-hidden /> Key + ID
        </TabButton>
      </div>

      {tab === 'file' ? (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-anvil-300 px-4 py-8 text-center transition-colors hover:border-forge-400 hover:bg-anvil-50 dark:border-anvil-700 dark:hover:bg-anvil-850"
          >
            <Upload className="h-5 w-5 text-forge-500" aria-hidden />
            <span className="text-dense font-medium">Choose a bridge identity file</span>
            <span className="text-[12px] text-anvil-500 dark:text-anvil-400">
              The .json file exported from the Dash bridge
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json,.txt"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onFile(f)
            }}
          />
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Identity ID" htmlFor="login-id" hint="Your base58 identity id.">
            <Input
              id="login-id"
              value={identityId}
              onChange={(e) => setIdentityId(e.target.value)}
              placeholder="e.g. 5Dtb9k4wKf3Jpq3mR7nTgH2vQxYzA1BcD8eF6gH9jK"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Private key (WIF or hex)" htmlFor="login-key" hint="Held in your browser keystore only.">
            <Input
              id="login-key"
              type="password"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="WIF or 64-char hex"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Button
            variant="primary"
            className="w-full"
            onClick={onKeyLogin}
            loading={isLoading}
            disabled={identityId.trim() === '' || privateKey.trim() === ''}
          >
            Sign in
          </Button>
        </div>
      )}

      {shownError ? (
        <div className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger break-words">
          {shownError}
        </div>
      ) : null}
    </Dialog>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-dense font-medium transition-colors ' +
        (active
          ? 'bg-forge-500/15 text-forge-600 dark:text-forge-400'
          : 'text-anvil-500 hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100')
      }
    >
      {children}
    </button>
  )
}
