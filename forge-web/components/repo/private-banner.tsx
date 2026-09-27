'use client'

/**
 * PrivateBanner — what a private repo's reader must know before its contents
 * (`docs/security/private-repos.md` §9; `ux-dx-spec.md` §9):
 *
 * - a member whose browser holds no encryption key: how to enable private repos;
 * - key alerts, never silent: "alice gave you a key that isn't this repo's key (epoch 3)"
 *   (KeyMismatch), "the key chain is broken at epoch 2 (anchor by carol)" (ChainBroken), and a
 *   member who cannot read the current epoch;
 * - for maintainers: documents under an unrecognised epoch, packs uploaded under an old key,
 *   and the repair check (§5.6) with a Repair button that shows its cost before spending.
 */

import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, KeyRound, ShieldAlert, Wrench } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { base58Encode } from '@/lib/auth/base58'
import { bytesToHex, type EpochAlert } from '@/lib/private'
import { planRepair, repairCost, runRepair, type RepairPlan } from '@/lib/repo/private-members'
import { isMaintainer, type PrivateSession } from '@/lib/repo/private-session'
import { useAuth } from '@/contexts/auth-context'
import { usePrivateWrite } from '@/hooks/use-private-write'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'

function Note({ tone, icon, children, testId }: { tone: 'caution' | 'danger' | 'info'; icon: React.ReactNode; children: React.ReactNode; testId?: string }): JSX.Element {
  const klass =
    tone === 'danger'
      ? 'border-danger/40 bg-danger/5'
      : tone === 'caution'
        ? 'border-caution/40 bg-caution/5'
        : 'border-anvil-200 bg-anvil-50 dark:border-anvil-750 dark:bg-anvil-850'
  return (
    <div role={tone === 'info' ? 'note' : 'alert'} data-testid={testId} className={`mb-3 flex items-start gap-2 rounded-md border px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200 ${klass}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

const who = (id: Uint8Array): JSX.Element => <Author identityId={base58Encode(id)} link={false} />

/** One key alert, in the words of `private-repos.md` §9. */
function AlertLine({ alert }: { alert: EpochAlert }): JSX.Element | null {
  switch (alert.kind) {
    case 'keyMismatch':
      return (
        <p>
          {who(alert.author)} gave you a key that isn&apos;t this repo&apos;s key (epoch {alert.epoch}).
        </p>
      )
    case 'chainBroken':
      return (
        <p>
          the key chain is broken at epoch {alert.epoch} (anchor by {who(alert.author)}).
        </p>
      )
    case 'rotationRequired':
      return null
  }
}

export function PrivateBanner({ home }: { home: RepoHome }): JSX.Element | null {
  const access = home.private
  if (access === undefined) return null
  if (access.access === 'no-key') {
    return (
      <Note tone="caution" icon={<KeyRound className="h-4 w-4 text-caution" aria-hidden />} testId="private-no-key">
        <p className="font-medium">You&apos;re a member, but this browser has no encryption key to read this repo.</p>
        <p className="mt-1">
          Add your identity&apos;s encryption key in{' '}
          <Link href="/settings" className="text-forge-700 underline dark:text-forge-400">
            Settings → Keys → Enable private repos
          </Link>
          . If your identity has none yet, that page registers one (one master-key signature), or run{' '}
          <code className="font-mono">dg auth keys add --encryption</code>.
        </p>
      </Note>
    )
  }
  if (access.access !== 'member') return null
  return <MemberAlerts home={home} session={access.session} />
}

function MemberAlerts({ home, session }: { home: RepoHome; session: PrivateSession }): JSX.Element | null {
  const { identity } = useAuth()
  const r = session.resolution
  const maintainer = isMaintainer(session, identity)
  const alerts = r.alerts.filter((a) => a.kind !== 'rotationRequired')
  const cannotReadCurrent = r.currentEpoch !== null && r.writeEpoch === null
  const repair = identity === null ? null : planRepair(session, identity, home.repo.forge.core)
  const parts: JSX.Element[] = []
  if (alerts.length > 0) {
    parts.push(
      <Note key="alerts" tone="danger" icon={<ShieldAlert className="h-4 w-4 text-danger" aria-hidden />} testId="private-alerts">
        {alerts.map((a) => (
          <AlertLine key={`${a.kind}:${a.epoch}:${'author' in a ? bytesToHex(a.author) : ''}`} alert={a} />
        ))}
      </Note>,
    )
  }
  if (cannotReadCurrent) {
    parts.push(
      <Note key="current" tone="caution" icon={<KeyRound className="h-4 w-4 text-caution" aria-hidden />} testId="private-no-current">
        You don&apos;t have the current key (epoch {r.currentEpoch}) yet, so new content is hidden. A maintainer&apos;s next visit
        repairs it.
      </Note>,
    )
  }
  if (maintainer && session.unanchoredDocs > 0) {
    parts.push(
      <Note key="unanchored" tone="info" icon={<AlertTriangle className="h-4 w-4 text-anvil-500" aria-hidden />}>
        {session.unanchoredDocs} documents under an unrecognised epoch.
      </Note>,
    )
  }
  if (maintainer && session.suspectManifests.size > 0) {
    parts.push(
      <Note key="suspect" tone="info" icon={<AlertTriangle className="h-4 w-4 text-anvil-500" aria-hidden />}>
        {session.suspectManifests.size} {session.suspectManifests.size === 1 ? 'pack was' : 'packs were'} uploaded under an old key.
      </Note>,
    )
  }
  if (repair !== null && identity !== null) parts.push(<RepairNote key="repair" home={home} session={session} self={identity} plan={repair} />)
  return parts.length === 0 ? null : <>{parts}</>
}

function RepairNote({ home, session, self, plan }: { home: RepoHome; session: PrivateSession; self: string; plan: RepairPlan }): JSX.Element {
  const write = usePrivateWrite(home.repo)
  const [open, setOpen] = useState(false)
  let cost = null
  try {
    cost = repairCost(session, plan, self, home.repo.forge.core)
  } catch {
    cost = null
  }
  const canAct = plan.rotate.length > 0 || plan.wrap.length > 0
  return (
    <Note tone="caution" icon={<Wrench className="h-4 w-4 text-caution" aria-hidden />} testId="private-repair">
      {plan.rotate.map((id) => (
        <p key={id}>
          rotating the repo key: <Author identityId={id} link={false} /> still had the current key.
        </p>
      ))}
      {plan.wrap.length > 0 ? (
        <p>
          {plan.wrap.length} {plan.wrap.length === 1 ? 'member has' : 'members have'} no copy of the current key yet.
        </p>
      ) : null}
      {plan.waiting.map((id) => (
        <p key={id}>
          <Author identityId={id} link={false} /> has no encryption key yet, so they can&apos;t be given the repo key.
        </p>
      ))}
      {canAct ? (
        <div className="mt-2">
          <Button size="sm" variant="primary" disabled={write.context === null || cost === null} onClick={() => setOpen(true)}>
            Repair
          </Button>
          {write.context === null ? (
            <span className="ml-2 text-[12px] text-anvil-500 dark:text-anvil-400">Unlock with your encryption key to repair.</span>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Repair the repo key"
        description={
          plan.rotate.length > 0
            ? 'Rotates the key: a new key for every remaining member (yours first), then the new key epoch.'
            : 'Hands the current key to the members who have none.'
        }
        cost={cost}
        confirmLabel="Sign & repair"
        onConfirm={async (intent) => {
          if (write.context === null) throw new Error('unlock with your encryption key first')
          await runRepair(write.context, intent)
          write.done()
        }}
      />
    </Note>
  )
}
