'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Pin } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { pinPlanBytes } from '@/lib/storage/pin-targets'
import type { RepoRef } from '@/lib/repo/contract'
import { kuboUpCommand } from '@/lib/storage/kubo-connect'
import type { PinProgress, PinSummary } from '@/lib/storage/pin'
import { pinCost, pinLabel, type CopyRow } from '@/lib/storage/pin-copies'
import { DOCS } from '@/lib/docs-links'
import { useRepoPin } from '@/hooks/use-repo-pin'
import { usePublicPin } from '@/hooks/use-public-pin'
import { plural } from '@/lib/view/format'
import { Button, buttonClass } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { CostPreview } from '@/components/ui/cost-preview'
import { UnlockMore } from '@/components/auth/unlock-more'
import { CopyBlock } from '@/components/storage/copy-block'

const pinMib = (size: number): string => (size / 1048576).toFixed(1)

function PinProgressList({ rows, summary }: { rows: readonly PinProgress[]; summary: PinSummary | null }): JSX.Element {
  return <div className="space-y-2 text-dense" aria-live="polite">
    <ol aria-label="Pin progress" className="max-h-64 space-y-1 overflow-auto">
      {rows.map((r) => <li key={r.index}>[{r.index}/{r.total}] {r.what} · {pinMib(r.sizeBytes)} MiB · {r.state}{r.why ? `: ${r.why}` : ''}</li>)}
    </ol>
    {summary ? <p>{summary.pinned + summary.already + summary.failed} blobs: {summary.pinned} pinned, {summary.already} already, {summary.failed} failed · {pinMib(summary.sizeBytes)} MiB on your node · cost 0 DASH</p> : null}
  </div>
}

function CopyProgressList({ rows }: { rows: readonly CopyRow[] }): JSX.Element | null {
  if (rows.length === 0) return null
  return <ol aria-label="Copy progress" aria-live="polite" className="max-h-64 space-y-1 overflow-auto">
    {rows.map((r) => <li key={r.index}>[{r.index}/{r.total}] pack {r.packHash.slice(0, 12)}… · {pinMib(r.sizeBytes)} MiB · {r.state}{r.why ? `: ${r.why}` : ''}</li>)}
  </ol>
}

export function PinButton({ repo, member }: { repo: RepoRef; member: boolean }): JSX.Element | null {
  const { identity } = useAuth()
  if (identity === null) return null
  if (repo.visibility === 'public') return <PublicPinButton repo={repo} />
  return member ? <PrivatePinButton repo={repo} /> : null
}

function PublicPinButton({ repo }: { repo: RepoRef }): JSX.Element {
  const pin = usePublicPin(repo)
  const [open, setOpen] = useState(false)
  return <>
    <Button size="sm" onClick={() => { pin.refresh(); setOpen(true) }} data-testid="pin-button"><Pin className="h-3.5 w-3.5" aria-hidden /> {pinLabel(pin.status.data)}</Button>
    {open ? <PublicPinDialog repo={repo} pin={pin} onClose={() => setOpen(false)} /> : null}
  </>
}

function PublicPinDialog({ repo, pin, onClose }: { repo: RepoRef; pin: ReturnType<typeof usePublicPin>; onClose: () => void }): JSX.Element {
  const s = pin.status.data
  const missing = s?.missing.length ?? 0
  const tooLarge = s?.tooLarge.length ?? 0
  const hasPin = (s?.mine.length ?? 0) > 0
  const cost = s && pin.profile && missing > 0 ? pinCost(missing, pin.profile, !hasPin) : null
  const busy = pin.running !== null
  const close = (): void => { if (pin.running !== 'unpin') { pin.cancel(); onClose() } }
  const noStorage = !pin.storage.needsUnlock && !pin.storage.loading && pin.profiles.length === 0
  const pinned = hasPin && missing === 0 && tooLarge === 0
  const nothingToCopy = s !== null && missing === 0 && (s.packs.length === 0 || tooLarge > 0)
  const current = pin.rows.findLast((r) => r.state === 'copying')
  const follow = `dg repo pin ${repo.ownerId}/${repo.name} --follow`

  let primary: JSX.Element | null = null
  if (pin.running === 'pin') primary = <Button onClick={pin.cancel}>Cancel</Button>
  else if (noStorage) primary = <Link href="/settings/storage/" className={buttonClass({ variant: 'primary', size: 'md' })}>Set up storage</Link>
  else if (cost) primary = <Button variant="primary" loading={busy} onClick={() => void pin.start(cost)}>{pinLabel(s)}</Button>
  else if (pinned || nothingToCopy) primary = <Button variant="primary" onClick={close}>Done</Button>

  return <Dialog open onClose={close} title={`Pin ${repo.name}`} description="Keep a copy of this repository's files on your own storage, so it stays available." footer={<>
    {hasPin && !busy ? <Button variant="ghost" onClick={() => void pin.unpin()} data-testid="pin-unpin">Unpin</Button> : null}
    {(pinned || nothingToCopy) && !busy ? null : <Button variant="ghost" onClick={close} disabled={pin.running === 'unpin'}>Close</Button>}
    {primary}
  </>}>
    <div className="space-y-3 text-dense">
      {pin.storage.needsUnlock ? <UnlockMore title="Unlock this tab to use your storage" />
        : pin.storage.error ? <p role="alert">{pin.storage.error}</p>
        : noStorage ? <p>Pinning needs storage of your own that others can read: an S3 or R2 bucket with a public URL, or an IPFS node. <Link className="underline" href={DOCS.selfHostBackend} target="_blank" rel="noreferrer noopener">Self-host guide</Link></p>
        : s === null ? <p>{pin.status.error ?? 'Reading this repository’s files…'}</p>
        : s.packs.length === 0 ? <p>This repository has no files to pin yet.</p>
        : missing === 0 && tooLarge > 0 ? <>
          <p data-testid="pin-state">{hasPin ? `${plural(s.mine.length, 'file')} ${s.mine.length === 1 ? 'has' : 'have'} a copy on your storage. ` : ''}{plural(tooLarge, 'file')} over 512 MiB {tooLarge === 1 ? 'is' : 'are'} too large for the browser; pin {tooLarge === 1 ? 'it' : 'them'} with:</p>
          <CopyBlock text={follow} label="Copy the pin command" />
        </>
        : pinned ? <p data-testid="pin-state">Pinned: every file has a copy on your storage.</p>
        : <>
          <p data-testid="pin-plan">{plural(missing, 'file')} · {pinMib(s.missing.reduce((n, p) => n + p.sizeBytes, 0))} MiB → {pin.profile?.name}</p>
          {pin.profiles.length > 1 ? <label className="block">Storage<select aria-label="Storage" className="ml-2 rounded border bg-transparent p-1" value={pin.profile?.name ?? ''} disabled={busy} onChange={(e) => pin.setChosen(e.target.value)}>{pin.profiles.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</select></label> : null}
          {cost ? <CostPreview cost={cost} /> : null}
        </>}
      {pin.running === 'pin' ? <p role="status">{current ? `Copying ${current.index} of ${current.total}…` : 'Starting…'}</p> : null}
      {pin.running === 'unpin' ? <p role="status">Removing your records…</p> : null}
      {pin.notice ? <p role="status" data-testid="pin-notice">{pin.notice}</p> : null}
      {pin.error ? <p role="alert" className="text-danger-700 dark:text-danger-400">{pin.error}</p> : null}
      {pin.summary ? <p role="status">{plural(pin.summary.recorded, 'file')} pinned{pin.summary.failed ? `; ${pin.summary.failed} could not be copied (see details)` : ''}.</p> : null}
      <details className="rounded-md border border-anvil-200 px-3 py-2 dark:border-anvil-800">
        <summary className="cursor-pointer">Details</summary>
        <div className="mt-2 space-y-2">
          <CopyProgressList rows={pin.rows} />
          {missing > 0 && tooLarge > 0 ? <p>{plural(tooLarge, 'file')} over 512 MiB {tooLarge === 1 ? 'needs' : 'need'} the command below.</p> : null}
          <p>Each file is recorded on Dash Platform so readers can find your copy. Unpin removes the records; the files stay on your storage.</p>
          {pin.profile && pin.profile.settings.kind !== 's3' ? <p>Your node will tell the IPFS network it holds these files.</p> : null}
          <p>Keep it in sync automatically:</p>
          <CopyBlock text={follow} label="Copy the follow command" />
        </div>
      </details>
    </div>
  </Dialog>
}

function PrivatePinButton({ repo }: { repo: RepoRef }): JSX.Element {
  const [open, setOpen] = useState(false)
  return <>
    <Button size="sm" onClick={() => setOpen(true)}><Pin className="h-3.5 w-3.5" aria-hidden /> Pin</Button>
    {open ? <PrivatePinDialog repo={repo} onClose={() => setOpen(false)} /> : null}
  </>
}

function PrivatePinDialog({ repo, onClose }: { repo: RepoRef; onClose: () => void }): JSX.Element {
  const pin = useRepoPin(repo)
  const [consent, setConsent] = useState(false)
  const [setup, setSetup] = useState<string | null>(null)
  useEffect(() => setSetup(kuboUpCommand(location.origin, location.pathname)), [])
  const p = pin.plan.data
  const canPin = !!p && !!pin.profile && !pin.storage.needsUnlock && consent
  return <Dialog open onClose={() => { pin.cancel(); onClose() }} title="Keep a copy of this repo's files on your IPFS node" footer={<>
    {pin.running ? <Button onClick={pin.cancel}>Cancel pinning</Button> : <Button variant="primary" disabled={!canPin || p?.targets.length === 0} onClick={() => void pin.start(consent)}>Pin</Button>}
    <Button variant="ghost" onClick={() => { pin.cancel(); onClose() }}>Close</Button>
  </>}>
    <div className="space-y-3 text-dense">
      {p ? <>
        <p>{plural(p.targets.length, 'file')} · {pinMib(pinPlanBytes(p))} MiB · cost 0 DASH (uses your disk)</p>
        {p.unreadableSkipped ? <p>{plural(p.unreadableSkipped, 'file')} skipped: no reachable copy to check.</p> : null}
        {p.invalidCidsSkipped ? <p>{plural(p.invalidCidsSkipped, 'IPFS address', 'IPFS addresses')} skipped: invalid CID.</p> : null}
        {p.conflictingCidsSkipped ? <p>{plural(p.conflictingCidsSkipped, 'IPFS address', 'IPFS addresses')} skipped: conflicting file metadata.</p> : null}
        {p.strangerCopiesIgnored ? <p>{plural(p.strangerCopiesIgnored, 'copy', 'copies')} ignored: no authorized pack.</p> : null}
        {p.notOnIpfs ? <p>{plural(p.notOnIpfs, 'file')} {p.notOnIpfs === 1 ? 'is' : 'are'} not on IPFS.</p> : null}
        {p.unverifiableSkipped ? <p>{plural(p.unverifiableSkipped, 'release file')} skipped: no recorded size or SHA-256.</p> : null}
        {p.membersOnlySkipped ? <p>{plural(p.membersOnlySkipped, 'members-only file')} skipped (key not held).</p> : null}
      </> : <p>{pin.plan.error ?? 'Reading the repository’s files…'}</p>}
      <label className="flex items-start gap-2"><input type="checkbox" checked={consent} disabled={pin.running} onChange={(e) => setConsent(e.target.checked)} />My IP address will be listed on IPFS as holding this private repo&apos;s encrypted files.</label>
      {pin.storage.needsUnlock ? <UnlockMore title="Unlock this tab to use your IPFS node" /> : pin.storage.error ? <p role="alert">{pin.storage.error}</p> : pin.storage.loading ? <p>Opening your storage profiles…</p> : pin.profiles.length === 0 ? <>
        {setup ? <CopyBlock text={setup} label="Copy the node setup command" /> : <p>Open Forge from its own address to connect a node.</p>}
        <Link className="underline" href="/settings/storage/">Connect a node in Settings → Storage</Link>
      </> : <label className="block">IPFS node<select aria-label="IPFS node" className="ml-2 rounded border bg-transparent p-1" value={pin.profile?.name ?? ''} disabled={pin.running} onChange={(e) => pin.setChosen(e.target.value)}>{pin.profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}</select></label>}
      {pin.error ? <p role="alert" className="text-danger-700 dark:text-danger-400">{pin.error}</p> : null}
      <PinProgressList rows={pin.rows} summary={pin.summary} />
      <p>Keep it up to date:</p>
      <CopyBlock text={`dg ipfs pin ${repo.ownerId}/${repo.name} --follow`} label="Copy the follow command" />
    </div>
  </Dialog>
}
