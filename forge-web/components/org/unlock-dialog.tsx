'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import type { OrgRecord, Unlocked } from '@/lib/org/store'
import { errorMessage } from '@/lib/utils'
import { EMPTY_PHRASE, PhraseField, unlockFrom, type PhraseState } from './phrase-field'

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
  const [value, setValue] = useState<PhraseState>(EMPTY_PHRASE)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const close = (): void => {
    setValue(EMPTY_PHRASE)
    setProblem(null)
    onClose()
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const u = await unlockFrom(value, [record.authPub], record.label)
      setValue(EMPTY_PHRASE)
      onUnlocked(u)
    } catch (e) {
      setProblem(errorMessage(e))
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
          <Button variant="primary" loading={busy} disabled={value.phrase.trim() === ''} onClick={() => void submit()} data-testid="org-unlock-submit">
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
        <PhraseField value={value} onChange={setValue} autoFocus />
        {problem ? (
          <p role="alert" className="text-dense text-danger-700 dark:text-danger-400" data-testid="org-unlock-problem">
            {problem}
          </p>
        ) : null}
      </form>
    </Dialog>
  )
}
