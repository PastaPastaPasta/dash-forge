'use client'

/**
 * Settings → Devices & keys (TS-07): every key of the identity as the chain has it, labelled
 * locally, with Disable for a lost device's key (the master key signs once). Also whether this
 * browser's storage is kept (TS-17).
 */

import { useCallback, useEffect, useState } from 'react'
import { Copy, HardDrive, KeyRound, LifeBuoy, Pencil, ShieldOff } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { ErrorBox } from '@/components/auth/protection-fields'
import { useMasterKeyInput } from '@/components/auth/master-key-input'
import { StepFailed } from '@/components/auth/step-status'
import { Spinner } from '@/components/ui/states'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { DOCS } from '@/lib/docs-links'
import { useCopy } from '@/hooks/use-copy'
import { ROLE_TEXT, disableRefusal, readKeyLabels, requestPersistence, storagePersistence, writeKeyLabel, type KeyRow, type StoragePersistence } from '@/lib/auth/devices'
import { keyKind } from '@/lib/auth/key-watch'
import { IdentityUpdateNotSentError, WrongMasterKeyError } from '@/lib/auth/limited-key'
import { KEY_DISABLE_CREDITS, previewCredits } from '@/lib/sdk'
import { readLedger } from '@/lib/spend'
import { creditsAsDash, formatDate } from '@/lib/view/format'
import { cn, errorMessage } from '@/lib/utils'

export function DevicesKeys(): JSX.Element {
  const { identity, controller, newKeys } = useAuth()
  const [rows, setRows] = useState<KeyRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [labels, setLabels] = useState<Record<number, string>>({})
  const [disabling, setDisabling] = useState<KeyRow | null>(null)
  const load = useCallback(() => {
    setError(null)
    controller.identityKeys().then(setRows, (e: unknown) => setError(errorMessage(e)))
  }, [controller])
  useEffect(() => {
    if (identity === null) return
    setLabels(readKeyLabels(ACTIVE_NETWORK.network, identity))
    load()
  }, [identity, load])
  const isNew = (id: number): boolean => newKeys.some((k) => k.keyId === id)

  if (identity === null) return <></>
  return (
    <div className="space-y-5" data-testid="devices-keys">
      {error !== null ? <StepFailed error={`Couldn't read your keys: ${error}`} onRetry={load} /> : null}
      {rows === null && error === null ? <Spinner label="Reading your keys" /> : null}
      {rows !== null ? (
        <ul className="divide-y divide-anvil-200 rounded-lg border border-anvil-200 dark:divide-anvil-800 dark:border-anvil-800" data-testid="key-rows">
          {rows.map((r) => (
            <KeyRowItem
              key={r.keyId}
              row={r}
              label={labels[r.keyId] ?? ''}
              fresh={isNew(r.keyId)}
              onLabel={(text) => setLabels(writeKeyLabel(ACTIVE_NETWORK.network, identity, r.keyId, text))}
              onDisable={() => setDisabling(r)}
            />
          ))}
        </ul>
      ) : null}
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        Labels stay in this browser. Platform doesn&apos;t record when a key was last used: a budget that went down was used, and this browser&apos;s last
        write is below.
      </p>
      <LostDevice />
      <ThisBrowser identity={identity} />
      {disabling !== null ? (
        <DisableKeyDialog
          row={disabling}
          label={labels[disabling.keyId] ?? ''}
          onClose={() => setDisabling(null)}
          onDone={() => {
            setDisabling(null)
            load()
          }}
        />
      ) : null}
    </div>
  )
}

function KeyRowItem({
  row,
  label,
  fresh,
  onLabel,
  onDisable,
}: {
  row: KeyRow
  label: string
  fresh: boolean
  onLabel: (text: string) => void
  onDisable: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)
  const refusal = disableRefusal(row)
  const disabled = row.disabledAt !== null
  const expired = row.expiresAt !== null && row.expiresAt <= Date.now()
  return (
    <li className={cn('space-y-1 px-3 py-3 text-dense', disabled && 'opacity-70')} data-testid="key-row" data-key-id={row.keyId}>
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <span className="font-mono font-medium">#{row.keyId}</span>
        {editing ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault()
              onLabel(draft)
              setEditing(false)
            }}
          >
            <Input aria-label={`Label for key #${row.keyId}`} value={draft} maxLength={40} onChange={(e) => setDraft(e.target.value)} className="h-7 w-44" autoFocus />
            <Button type="submit" size="sm" variant="outline">
              Save
            </Button>
          </form>
        ) : (
          <>
            {label ? <span className="font-medium">{label}</span> : null}
            <button
              type="button"
              onClick={() => {
                setDraft(label)
                setEditing(true)
              }}
              className="hit-area inline-flex items-center gap-1 text-[12px] text-anvil-600 underline dark:text-anvil-300"
            >
              <Pencil className="h-3 w-3" aria-hidden /> {label ? 'Rename' : 'Name it'}
            </button>
          </>
        )}
        {row.thisBrowser ? <Chip tone="accent">This browser</Chip> : null}
        {fresh ? <Chip tone="danger">New</Chip> : null}
        {disabled ? <Chip tone="muted">Disabled {formatDate(row.disabledAt as number)}</Chip> : expired ? <Chip tone="muted">Expired</Chip> : null}
      </div>
      <p className="text-anvil-600 dark:text-anvil-300">
        {ROLE_TEXT[row.role]} <span className="text-anvil-500 dark:text-anvil-400">({keyKind(row)})</span>
      </p>
      {row.budgetTotal !== null || row.expiresAt !== null ? (
        <p className="text-[12px] text-anvil-600 dark:text-anvil-300">
          {row.budgetTotal !== null
            ? `${row.budgetLeft !== null ? creditsAsDash(Number(row.budgetLeft)) : '?'} of ${creditsAsDash(Number(row.budgetTotal))} DASH left`
            : 'No budget'}
          {' · '}
          {row.expiresAt !== null ? `${expired ? 'expired' : 'expires'} ${formatDate(row.expiresAt)}` : 'never expires'}
        </p>
      ) : null}
      {!disabled ? (
        refusal === null ? (
          <Button size="sm" variant="outline" onClick={onDisable} data-testid="key-disable">
            <ShieldOff className="h-3.5 w-3.5" aria-hidden /> Disable
          </Button>
        ) : (
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{refusal}</p>
        )
      ) : null}
    </li>
  )
}

function Chip({ tone, children }: { tone: 'accent' | 'danger' | 'muted'; children: React.ReactNode }): JSX.Element {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] font-medium',
        tone === 'accent' && 'bg-forge-500/15 text-forge-800 dark:text-forge-300',
        tone === 'danger' && 'bg-danger/15 text-danger-700 dark:text-danger-400',
        tone === 'muted' && 'bg-anvil-100 text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200',
      )}
    >
      {children}
    </span>
  )
}

function DisableKeyDialog({ row, label, onClose, onDone }: { row: KeyRow; label: string; onClose: () => void; onDone: () => void }): JSX.Element {
  const { identity, controller, isLoading } = useAuth()
  const master = useMasterKeyInput(identity, { id: 'disable-key', fileLabel: 'Identity file to disable the key with' })
  const [submitError, setError] = useState<string | null>(null)
  const error = master.error ?? submitError
  const name = label ? `key #${row.keyId} (${label})` : `key #${row.keyId}`
  const submit = async (): Promise<void> => {
    if (!master.ready || isLoading) return
    setError(null)
    try {
      await controller.disableIdentityKey(master.take({ keep: true }), row.keyId)
      master.clear()
      onDone()
    } catch (e) {
      if (!(e instanceof WrongMasterKeyError || e instanceof IdentityUpdateNotSentError)) master.clear()
      setError(errorMessage(e))
    }
  }
  return (
    <Dialog open onClose={onClose} title={`Disable ${name}`} description="It can never sign again, wherever it was copied.">
      <form
        className="space-y-4 text-dense"
        data-testid="disable-key-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <p className="text-anvil-600 dark:text-anvil-300">
          Your master key signs one identity update that disables this key on Platform. The device that held it can no longer write as you. The
          master key is used once and is not stored.
        </p>
        {master.element}
        <ErrorBox error={error} />
        <CostPreview cost={previewCredits(KEY_DISABLE_CREDITS)} />
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" className="flex-1" loading={isLoading} disabled={!master.ready || isLoading}>
            <ShieldOff className="h-3.5 w-3.5" aria-hidden /> Sign once &amp; disable
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** The rekey command (private-repos.md §5.2), run where the recovery words are. */
const ENCRYPTION_ROTATE_COMMAND = 'dg auth keys rotate --encryption'

/** What to do when a device is lost: its signing key, then the encryption key it held. */
function LostDevice(): JSX.Element {
  const [copied, copy] = useCopy(ENCRYPTION_ROTATE_COMMAND)
  return (
    <section aria-labelledby="lost-device-title" className="space-y-2 rounded-lg border border-anvil-200 p-4 text-dense dark:border-anvil-800" data-testid="lost-device">
      <h2 id="lost-device-title" className="flex items-center gap-2 font-medium text-anvil-500 dark:text-anvil-400">
        <LifeBuoy className="h-4 w-4" aria-hidden /> Lost a device?
      </h2>
      <ol className="list-decimal space-y-1.5 pl-5 text-anvil-700 dark:text-anvil-200">
        <li>Disable its key above. It can no longer write as you.</li>
        <li>
          If it could open your private repos, it also held your encryption key. Replace that key in a terminal, with your recovery phrase:{' '}
          <span className="inline-flex items-center gap-1 rounded bg-anvil-100 px-1.5 py-0.5 font-mono text-anvil-800 dark:bg-anvil-800 dark:text-anvil-100">
            {ENCRYPTION_ROTATE_COMMAND}
            <button
              type="button"
              onClick={() => void copy()}
              className="hit-area text-anvil-500 hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100"
              aria-label="Copy the command"
            >
              <Copy className="h-3 w-3" aria-hidden />
            </button>
          </span>
          {copied ? ' Copied.' : null}
          <p className="mt-1 text-[12px] text-anvil-600 dark:text-anvil-300">
            It adds a new key, moves the private repos you maintain to it and names the ones a maintainer must move, then disables the old key. The
            browser can&apos;t do this yet.
          </p>
        </li>
        <li>On your other devices, sign in again or add the new encryption key from your recovery phrase (Settings → Members-only and private content).</li>
      </ol>
      <a
        href={`${DOCS.identity}#replacing-it-after-a-lost-device`}
        target="_blank"
        rel="noreferrer noopener"
        className="hit-area text-[12px] text-forge-700 underline dark:text-forge-400"
      >
        What replacing the encryption key does →
      </a>
    </section>
  )
}

/** This browser: whether its storage is kept (TS-17), and when it last wrote. */
function ThisBrowser({ identity }: { identity: string }): JSX.Element {
  const [persistence, setPersistence] = useState<StoragePersistence | null>(null)
  const [lastWrite, setLastWrite] = useState<number | null>(null)
  useEffect(() => {
    void storagePersistence().then(setPersistence)
    readLedger(ACTIVE_NETWORK.network, identity).then(
      (rows) => setLastWrite(rows.reduce<number | null>((m, r) => (m === null || r.at > m ? r.at : m), null)),
      () => undefined,
    )
  }, [identity])
  return (
    <section aria-labelledby="this-browser-title" className="space-y-2 rounded-lg border border-anvil-200 p-4 text-dense dark:border-anvil-800" data-testid="this-browser">
      <h2 id="this-browser-title" className="flex items-center gap-2 font-medium text-anvil-500 dark:text-anvil-400">
        <HardDrive className="h-4 w-4" aria-hidden /> This browser
      </h2>
      <p>Last write from this browser: {lastWrite === null ? 'none recorded' : formatDate(lastWrite)}</p>
      <p data-testid="storage-persistence" data-state={persistence ?? 'checking'}>
        Storage:{' '}
        {persistence === 'persistent'
          ? 'kept. The browser will not clear your key on its own.'
          : persistence === 'may-clear'
            ? 'may be cleared. The browser can delete your stored key under storage pressure, and Safari does after 7 days without a visit.'
            : persistence === 'unknown'
              ? "this browser doesn't say whether it keeps it."
              : 'checking…'}
      </p>
      {persistence === 'may-clear' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void requestPersistence().then(setPersistence)} data-testid="storage-persist">
            Ask the browser to keep it
          </Button>
          <span className="text-[12px] text-anvil-500 dark:text-anvil-400">If it is cleared, sign in again with dg, your identity file or your recovery phrase.</span>
        </div>
      ) : null}
    </section>
  )
}
