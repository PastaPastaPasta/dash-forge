'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { refreshOrgs } from '@/hooks/use-orgs'
import { DEFAULT_NETWORK } from '@/lib/constants'
import { multisigAppUrl, orgNetworkName } from '@/lib/org/gate'
import { connect, verifyInvite, type ConnectCandidate } from '@/lib/org/service'
import { ensureSdk } from '@/lib/sdk'
import { errorMessage } from '@/lib/utils'

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
      <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">Then come back and connect it below with its invite link.</p>
    </section>
  )
}

export function ConnectFlow({ initial = '' }: { initial?: string }): JSX.Element {
  const router = useRouter()
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<ConnectCandidate | null>(null)
  const [me, setMe] = useState<string>('')
  const network = orgNetworkName()

  const check = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    setCandidate(null)
    try {
      const sdk = await ensureSdk(DEFAULT_NETWORK)
      const c = await verifyInvite(sdk, text, network)
      setCandidate(c)
      setMe(c.members.length === 1 ? (c.members[0]?.authPub ?? '') : '')
    } catch (e) {
      setProblem(errorMessage(e, "Couldn't read the group; try again."))
    } finally {
      setBusy(false)
    }
  }

  const save = (): void => {
    if (!candidate || !me) return
    const record = connect(candidate, network, me)
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
          <fieldset className="space-y-2">
            <legend className="text-dense font-medium">Which member are you?</legend>
            {candidate.members.map((m) => (
              <label key={m.authPub} className="flex items-center gap-2 text-dense">
                <input type="radio" name="org-me" value={m.authPub} checked={me === m.authPub} onChange={() => setMe(m.authPub)} />
                <span>{m.name || `Member ${m.index}`}</span>
                <span className="font-mono text-[11px] text-anvil-500 dark:text-anvil-400">{m.fingerprint}</span>
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={!me} onClick={save} data-testid="org-connect-save">
              Connect
            </Button>
            <Button variant="ghost" onClick={() => setCandidate(null)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
