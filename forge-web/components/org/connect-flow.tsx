'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { useAuth } from '@/contexts/auth-context'
import { refreshOrgs } from '@/hooks/use-orgs'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { DEFAULT_NETWORK, NETWORKS } from '@/lib/constants'
import { orgWritesCost } from '@/lib/org/cost'
import { orgWriteScope } from '@/lib/org/transport'
import { multisigAppUrl, orgNetworkName } from '@/lib/org/gate'
import { connect, verifyInvite, type ConnectCandidate } from '@/lib/org/service'
import { ensureSdk } from '@/lib/sdk'
import { errorMessage } from '@/lib/utils'
import { EMPTY_PHRASE, PhraseField, unlockFrom, type PhraseState } from './phrase-field'

export function NewOrganizationSteps(): JSX.Element {
  return (
    <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="org-new-steps">
      <h2 className="text-prose">New organization</h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-dense text-anvil-700 dark:text-anvil-200">
        <li>Start a group in multisig and invite the other members.</li>
        <li>Make the keys together (the key ceremony), choosing how many must sign.</li>
        <li>Fund and create the organization&apos;s identity there.</li>
      </ol>
      <p className="mt-3">
        <a href={multisigAppUrl()} target="_blank" rel="noopener noreferrer" className="text-dense text-forge-700 underline dark:text-forge-400">
          Open multisig.dashhq.org
        </a>
      </p>
      <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">Then come back and connect it above with its invite link.</p>
    </section>
  )
}

export function ConnectFlow({ initial = '' }: { initial?: string }): JSX.Element {
  const router = useRouter()
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<ConnectCandidate | null>(null)
  const [phrase, setPhrase] = useState<PhraseState>(EMPTY_PHRASE)
  const [confirming, setConfirming] = useState(false)
  const network = orgNetworkName()
  const forge = NETWORKS[DEFAULT_NETWORK].v2

  const check = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    setCandidate(null)
    try {
      const sdk = await ensureSdk(DEFAULT_NETWORK)
      setCandidate(await verifyInvite(sdk, text, network))
    } catch (e) {
      setProblem(errorMessage(e, "Couldn't read the group; try again."))
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!candidate || forge === null || signer === null) throw new Error('sign in to Forge first')
    const u = await unlockFrom(phrase, candidate.members.map((m) => m.authPub), candidate.label)
    setPhrase(EMPTY_PHRASE)
    const sdk = await ensureSdk(DEFAULT_NETWORK)
    const record = await connect(sdk, candidate, network, u, signer, { forge })
    refreshOrgs()
    router.push(`/org/?id=${encodeURIComponent(record.orgId)}`)
  }

  return (
    <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="org-connect">
      <h2 className="text-prose">Connect organization</h2>
      {candidate === null ? (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void check()
          }}
        >
          <Field label="Group invite link or group id" htmlFor="org-invite">
            <Input id="org-invite" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" data-testid="org-invite" />
          </Field>
          {problem ? (
            <p role="alert" className="text-dense text-danger-700 dark:text-danger-400" data-testid="org-connect-problem">
              {problem}
            </p>
          ) : null}
          <Button variant="primary" type="submit" loading={busy} disabled={text.trim() === ''} data-testid="org-connect-check">
            Continue
          </Button>
        </form>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-dense">
            <span className="font-medium">{candidate.label}</span> · Organization · {candidate.threshold} of {candidate.members.length}. Its key ceremony checks out and its identity uses the group&apos;s keys.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => {
                if (guard.check(memberCost, orgWriteScope(forge), 'connect this organization')) setConfirming(true)
              }}
              data-testid="org-connect-save"
            >
              Connect
            </Button>
            <Button variant="ghost" onClick={() => setCandidate(null)}>
              Back
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirming && candidate !== null}
        onClose={() => {
          setConfirming(false)
          setPhrase(EMPTY_PHRASE)
        }}
        title={`Connect ${candidate?.label ?? 'the organization'}?`}
        description="Your seed phrase shows which member you are. Forge records on Platform that this Forge identity is that member, so you can sign from any device."
        cost={memberCost}
        confirmLabel="Connect"
        successNote="Connected"
        onConfirm={save}
      >
        <PhraseField value={phrase} onChange={setPhrase} autoFocus />
      </ConfirmDialog>
    </section>
  )
}

const memberCost = orgWritesCost({ member: true })
