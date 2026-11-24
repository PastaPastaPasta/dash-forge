'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { isValidMnemonic, mnemonicProblem } from '@/lib/auth/hd'
import { NotAMemberError, unlockPhrase, type OrgRecord, type Unlocked } from '@/lib/org/store'

export function UnlockDialog({
  open,
  record,
  onClose,
  onUnlocked,
}: {
  open: boolean
  record: OrgRecord
  onClose: () => void
  onUnlocked: (u: Unlocked) => void
}): JSX.Element {
  const [phrase, setPhrase] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const close = (): void => {
    setPhrase('')
    setPassphrase('')
    setProblem(null)
    onClose()
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      if (!(await isValidMnemonic(phrase))) {
        setProblem(mnemonicProblem(phrase))
        return
      }
      const u = unlockPhrase(phrase, passphrase, [record.authPub])
      setPhrase('')
      setPassphrase('')
      onUnlocked(u)
    } catch (e) {
      setProblem(e instanceof NotAMemberError ? `This seed phrase isn't the one you use in ${record.label}. Check the words and the passphrase.` : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Unlock to sign"
      description={`Enter the seed phrase you use in multisig.dashhq.org for ${record.label}. It stays in this tab's memory until you close the tab or sign out.`}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={phrase.trim() === ''} onClick={() => void submit()} data-testid="org-unlock-submit">
            Unlock
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Field label="Multisig seed phrase" htmlFor="org-phrase">
          <Textarea
            id="org-phrase"
            autoFocus
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="min-h-[72px] font-mono"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            data-testid="org-phrase"
          />
        </Field>
        <details className="text-dense">
          <summary className="cursor-pointer text-anvil-600 dark:text-anvil-300">Passphrase</summary>
          <div className="mt-2">
            <Input type="password" aria-label="Passphrase" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </div>
        </details>
        {problem ? (
          <p role="alert" className="text-dense text-danger-700 dark:text-danger-400" data-testid="org-unlock-problem">
            {problem}
          </p>
        ) : null}
      </form>
    </Dialog>
  )
}
