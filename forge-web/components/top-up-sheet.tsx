'use client'

/**
 * Top-up sheet (`ux-dx-spec.md` §4): shown when a write does not fit the balance or this
 * browser's key budget, or when Platform refused one for that reason (D-007), and ahead of any
 * write from the low-funds banner, the funds pill or Settings (`proactive`: it then describes
 * the funds as they stand, QW-047). It says which budget blocks and by how much, and offers the
 * fix for that budget:
 * - the identity's balance: a top-up from this browser (a deposit address any Dash wallet or a
 *   test-network faucet can pay, QW-012), or a credit transfer from another identity. On mainnet,
 *   where no normal flow asks for the recovery phrase, it is "buy credits in DashPay, then check
 *   again", with the phrase top-up behind Advanced;
 * - this key's budget: top up the same key (one master-key signature), or renew it;
 * - an expired or disabled key: renew it (a new key; the old one is disabled). A key a wallet
 *   granted through App Connect is renewed in that wallet first, the identity file second. On
 *   mainnet any other key is replaced by signing in again with the wallet; master-key actions
 *   sit behind Advanced.
 */

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore, type TopUpReason } from '@/hooks/use-ui-store'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CopyRow } from '@/components/ui/copy-row'
import { KeyTopUpDialog } from '@/components/key-top-up-dialog'
import { IdentityTopUpFlow } from '@/components/identity-top-up-flow'
import { PhraseAdvanced, phraseIsAdvanced } from '@/components/auth/phrase-advanced'
import { KeyBudgetText, KeyFundsLine } from '@/components/funds-summary'
import { faucetUrls } from '@/lib/faucets'
import { typicalIssueCredits } from '@/lib/sdk'
import { issueCoverageParts, renewsInWallet, type KeyLimits } from '@/lib/view/funds'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { creditsAsDash, formatDate } from '@/lib/view/format'
import { creditsToDash } from '@/lib/sdk/cost'
import { FiatNote } from '@/components/ui/fiat-note'
import { readTopUpJournal } from '@/lib/auth/identity-top-up'
import { errorMessage } from '@/lib/utils'

/** The first place this network gets test DASH (`lib/faucets.ts`: testnet and devnet have one, mainnet none). */
export function faucetUrl(): string | null {
  return faucetUrls()[0] ?? null
}

/**
 * What "an issue" costs in copy: the same figure the sign-in chooser and the New issue form quote
 * (`typicalIssueCredits`, QW-043).
 */
const ISSUE_CREDITS = typicalIssueCredits()

function BlockerDescription({ reason, balance, keyLimits }: { reason: TopUpReason; balance: string | null; keyLimits: KeyLimits | null }): JSX.Element {
  const shortfall = reason.shortfall && reason.shortfall > 0n
    ? <> (short by {creditsAsDash(Number(reason.shortfall))} DASH<FiatNote dash={creditsToDash(Number(reason.shortfall))} />)</>
    : null
  if (reason.proactive && reason.blocker === 'balance') {
    return <>Your identity&apos;s balance is {balance !== null ? <>{creditsAsDash(Number(balance))} DASH<FiatNote dash={creditsToDash(Number(balance))} balance /></> : 'being read'}. Every write is paid from it; reading is free.</>
  }
  if (reason.blocker === 'key-budget') {
    if (reason.proactive) {
      return <>This browser&apos;s key has {keyLimits?.remaining != null && keyLimits.total != null ? <><KeyBudgetText remaining={keyLimits.remaining} total={keyLimits.total} /> of budget</> : 'little budget'} left. Top it up or renew it before your next write.</>
    }
    return <>This browser&apos;s key does not have enough budget left for this write{shortfall}. Reading still works.</>
  }
  if (reason.blocker === 'balance') {
    return <>Your identity&apos;s balance{balance !== null ? <> ({creditsAsDash(Number(balance))} DASH<FiatNote dash={creditsToDash(Number(balance))} balance />)</> : null} does not cover this write{shortfall}. Reading still works; drafts stay here.</>
  }
  switch (reason.blocker) {
    case 'key-expiry':
      if (reason.proactive && keyLimits?.expiresAt != null && keyLimits.expiresAt > Date.now()) return <>This browser&apos;s key expires on {formatDate(keyLimits.expiresAt)}. Renew it to keep writing from this browser.</>
      return <>This browser&apos;s key has expired. Reading still works.</>
    case 'key-disabled':
      return <>This browser&apos;s key was disabled on Platform. Reading still works.</>
    case 'key-missing':
      return <>This browser&apos;s key is not on this identity. Reading still works.</>
    case 'key-level':
      return <>This browser&apos;s key cannot sign Forge writes. Reading still works.</>
  }
}

export function TopUpSheet(): JSX.Element | null {
  const reason = useUiStore((s) => s.topUp)
  const close = useUiStore((s) => s.closeTopUp)
  const openLogin = useUiStore((s) => s.openLogin)
  const { identity, storage, keyLimits, balance, funds, origin, unlimitedKey, refreshBalance } = useAuth()
  const [other, setOther] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState<{ ok: true } | { ok: false; error: string } | null>(null)
  const checkAgain = async (): Promise<void> => {
    setChecking(true)
    setChecked(null)
    try {
      await refreshBalance()
      setChecked({ ok: true })
    } catch (e) {
      setChecked({ ok: false, error: errorMessage(e) })
    } finally {
      setChecking(false)
    }
  }
  // A top-up from this browser that was paid but not finished: its step is opened, not buried.
  const [unfinishedTopUp, setUnfinishedTopUp] = useState(false)
  useEffect(() => {
    if (identity === null || !phraseIsAdvanced()) return
    let live = true
    readTopUpJournal(ACTIVE_NETWORK.network, identity).then(
      (j) => live && setUnfinishedTopUp(j !== undefined && j !== null),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [identity])
  const [topUpKey, setTopUpKey] = useState(false)
  if (identity === null) return null
  if (topUpKey) return <KeyTopUpDialog onClose={() => setTopUpKey(false)} />
  if (reason === null) return null
  const coverage = issueCoverageParts(funds?.spendable ?? null, ISSUE_CREDITS)
  const keyProblem = reason.blocker !== 'balance'
  // A stored Forge browser key with a budget can take more budget in place.
  const canTopUpKey = reason.blocker === 'key-budget' && storage === 'vault' && keyLimits?.total != null
  // A key a wallet granted through App Connect is renewed in that wallet; the identity file or
  // recovery phrase still works (the master key can renew any Forge browser key).
  const inWallet = renewsInWallet(origin, ACTIVE_NETWORK.network, unlimitedKey) && storage === 'vault'
  // DashPay or Dash Wallet holds this identity (it granted the key, or may have): buy credits there.
  const walletIdentity = origin === 'app-connect' || origin === 'passkey'
  const renewVia = (view: 'import' | 'wallet-renew' | 'wallet'): void => {
    close()
    openLogin(view)
  }
  let title = 'Top up credits'
  if (canTopUpKey && !inWallet && !phraseIsAdvanced()) title = "Add budget to this browser's key"
  else if (keyProblem) title = "Renew this browser's key"

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      description={<BlockerDescription reason={reason} balance={balance} keyLimits={keyLimits} />}
    >
      <div className="space-y-3 text-dense" data-testid="top-up-sheet" data-blocker={reason.blocker}>
        {reason.proactive ? <KeyFundsLine /> : null}
        {keyProblem ? (
          <>
            {inWallet ? (
              <>
                <Button variant="primary" className="w-full" onClick={() => renewVia('wallet-renew')} data-testid="renew-in-wallet">
                  Renew in your wallet
                </Button>
                {origin === 'app-connect' ? null : (
                  <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="renew-stays-live">
                    Your wallet adds a new key; this one stays live until you revoke it.
                  </p>
                )}
              </>
            ) : phraseIsAdvanced() ? (
              <>
                <Button variant="primary" className="w-full" onClick={() => renewVia('wallet')} data-testid="sign-in-with-wallet">
                  Sign in again with your wallet
                </Button>
                <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="renew-stays-live">
                  Your wallet gives this browser a new key; the current one stays live until you revoke it.
                </p>
              </>
            ) : null}
            <PhraseAdvanced testId="top-up-master-actions">
              <div className="flex flex-wrap gap-2">
                {canTopUpKey ? (
                  <Button
                    variant={inWallet || phraseIsAdvanced() ? 'outline' : 'primary'}
                    onClick={() => {
                      close()
                      setTopUpKey(true)
                    }}
                  >
                    Top up key
                  </Button>
                ) : null}
                <Button variant={canTopUpKey || inWallet || phraseIsAdvanced() ? 'outline' : 'primary'} onClick={() => renewVia('import')}>
                  {inWallet ? 'Renew with identity file' : 'Renew key'}
                </Button>
              </div>
              <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
                {canTopUpKey ? 'Top-up keeps this key and adds budget; renewing' : 'Renewing'} replaces it. Your identity file or recovery phrase signs once and is
                not stored.
              </p>
            </PhraseAdvanced>
          </>
        ) : phraseIsAdvanced() ? (
          <>
            {walletIdentity ? (
              <p data-testid="top-up-in-dashpay">Buy credits in DashPay or Dash Wallet, then check again.</p>
            ) : (
              <>
                <p data-testid="top-up-by-id">Top up this identity from any wallet that supports identity top-ups, with its ID:</p>
                <CopyRow text={identity} label="Copy identity id" />
              </>
            )}
            <Button variant="primary" className="w-full" loading={checking} onClick={() => void checkAgain()} data-testid="top-up-check-again">
              Check again
            </Button>
            {checked !== null ? (
              <p role="status" data-testid="top-up-checked" className={checked.ok ? 'text-[12px] text-anvil-600 dark:text-anvil-300' : 'text-[12px] text-danger-700 dark:text-danger-400'}>
                {checked.ok ? (
                  <>Your balance is {balance !== null ? <>{creditsAsDash(Number(balance))} DASH<FiatNote dash={creditsToDash(Number(balance))} balance /></> : 'being read'}.</>
                ) : (
                  <>Couldn&apos;t read your balance: {checked.error}</>
                )}
              </p>
            ) : null}
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="top-up-coverage">
              {coverage.before}{creditsAsDash(coverage.credits)} DASH<FiatNote dash={creditsToDash(coverage.credits)} />{coverage.after}
            </p>
            <details className="text-dense" data-testid="top-up-other-ways" open={unfinishedTopUp || undefined}>
              <summary className="cursor-pointer text-[12px] text-anvil-500 dark:text-anvil-400 coarse:flex coarse:min-h-11 coarse:items-center">Other ways to add credits</summary>
              <div className="mt-2 space-y-2">
                {walletIdentity ? (
                  <>
                    <p className="text-[12px] text-anvil-600 dark:text-anvil-300">Anyone with credits, or a wallet with identity support, can top up this identity with its ID:</p>
                    <CopyRow text={identity} label="Copy identity id" />
                  </>
                ) : null}
                <PhraseAdvanced label="Top up from this browser with your recovery phrase" testId="top-up-phrase" defaultOpen={unfinishedTopUp}>
                  <IdentityTopUpFlow faucets={faucetUrls()} />
                </PhraseAdvanced>
              </div>
            </details>
          </>
        ) : (
          <>
            {/* From this browser: a deposit address any wallet (or the faucet) can pay (QW-012). */}
            <IdentityTopUpFlow faucets={faucetUrls()} />
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="top-up-coverage">
              {coverage.before}{creditsAsDash(coverage.credits)} DASH<FiatNote dash={creditsToDash(coverage.credits)} />{coverage.after}
            </p>
            <div>
              <button type="button" aria-expanded={other} onClick={() => setOther((o) => !o)} className="hit-area text-[12px] text-anvil-500 underline hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100">
                Other ways to add credits
              </button>
              {other ? (
                <div className="mt-2 space-y-2" data-testid="top-up-other-ways">
                  <p className="text-[12px] text-anvil-600 dark:text-anvil-300">
                    A wallet with identity support (Dash Wallet&apos;s DashPay, the Dash bridge) can top up this identity directly, and anyone
                    with credits can transfer some to it. Either way they need its ID:
                  </p>
                  <CopyRow text={identity} label="Copy identity id" />
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
