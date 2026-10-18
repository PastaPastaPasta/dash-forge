'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Pin } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import type { RepoRef } from '@/lib/repo/contract'
import type { PinProgress, PinSummary } from '@/lib/storage/pin'
import { useRepoPin } from '@/hooks/use-repo-pin'
import { plural } from '@/lib/view/format'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { UnlockMore } from '@/components/auth/unlock-more'
import { CopyBlock } from '@/components/storage/copy-block'

export const pinMib = (size: number): string => (size / 1048576).toFixed(1)

export function PinProgressList({ rows, summary }: { rows: readonly PinProgress[]; summary: PinSummary | null }): JSX.Element {
  return <div className="space-y-2 text-dense" aria-live="polite">
    <ol aria-label="Pin progress" className="max-h-64 space-y-1 overflow-auto">
      {rows.map((r) => <li key={r.cid}>[{r.index}/{r.total}] {r.what} · {pinMib(r.sizeBytes)} MiB · {r.state}{r.why ? `: ${r.why}` : ''}</li>)}
    </ol>
    {summary ? <p>{summary.pinned + summary.already + summary.failed} blobs: {summary.pinned} pinned, {summary.already} already, {summary.failed} failed · {pinMib(summary.sizeBytes)} MiB on your node · cost 0 DASH</p> : null}
  </div>
}

export function PinButton({ repo, member }: { repo: RepoRef; member: boolean }): JSX.Element | null {
  const { identity } = useAuth()
  const [open, setOpen] = useState(false)
  if (identity === null || (repo.visibility === 'private' && !member)) return null
  return <>
    <Button size="sm" onClick={() => setOpen(true)}><Pin className="h-3.5 w-3.5" aria-hidden /> Pin</Button>
    {open ? <PinDialog repo={repo} onClose={() => setOpen(false)} /> : null}
  </>
}

function PinDialog({ repo, onClose }: { repo: RepoRef; onClose: () => void }): JSX.Element {
  const pin = useRepoPin(repo)
  const [consent, setConsent] = useState(false)
  const p = pin.plan.data
  const privateFiles = repo.visibility === 'private' || p?.requiresConsent === true
  const canPin = !!p && !!pin.profile && !pin.storage.needsUnlock && (!privateFiles || consent)
  return <Dialog open onClose={() => { pin.cancel(); onClose() }} title="Keep a copy of this repo's files on your IPFS node" footer={<>
    {pin.running ? <Button onClick={pin.cancel}>Cancel pinning</Button> : <Button variant="primary" disabled={!canPin || p?.targets.length === 0} onClick={() => void pin.start(consent)}>Pin</Button>}
    <Button variant="ghost" onClick={() => { pin.cancel(); onClose() }}>Close</Button>
  </>}>
    <div className="space-y-3 text-dense">
      {p ? <>
        <p>{plural(p.targets.length, 'file')} · {pinMib(p.sizeBytes)} MiB · cost 0 DASH (uses your disk)</p>
        {p.notOnIpfs ? <p>{plural(p.notOnIpfs, 'file')} {p.notOnIpfs === 1 ? 'is' : 'are'} not on IPFS.</p> : null}
        {p.unverifiableSkipped ? <p>{plural(p.unverifiableSkipped, 'release file')} skipped: no recorded size or SHA-256.</p> : null}
        {p.membersOnlySkipped ? <p>{plural(p.membersOnlySkipped, 'members-only file')} skipped (key not held).</p> : null}
      </> : <p>{pin.plan.error ?? 'Reading the repository’s files…'}</p>}
      {privateFiles ? <label className="flex items-start gap-2"><input type="checkbox" checked={consent} disabled={pin.running} onChange={(e) => setConsent(e.target.checked)} />My IP address will be listed on IPFS as holding this private repo&apos;s encrypted files.</label> : <p>Your node will tell the IPFS network it holds these files.</p>}
      {pin.storage.needsUnlock ? <UnlockMore title="Unlock this tab to use your IPFS node" /> : pin.storage.error ? <p role="alert">{pin.storage.error}</p> : pin.storage.loading ? <p>Opening your storage profiles…</p> : pin.profiles.length === 0 ? <>
        <CopyBlock text="dg ipfs up" label="Copy the node setup command" />
        <Link className="underline" href="/settings/storage/">Connect a node in Settings → Storage</Link>
      </> : <label className="block">IPFS node<select aria-label="IPFS node" className="ml-2 rounded border bg-transparent p-1" value={pin.profile?.name ?? ''} disabled={pin.running} onChange={(e) => pin.setChosen(e.target.value)}>{pin.profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}</select></label>}
      {pin.error ? <p role="alert" className="text-danger-700 dark:text-danger-400">{pin.error}</p> : null}
      <PinProgressList rows={pin.rows} summary={pin.summary} />
      <p>Keep it up to date:</p>
      <CopyBlock text={`dg ipfs pin ${repo.ownerId}/${repo.name} --follow`} label="Copy the follow command" />
    </div>
  </Dialog>
}
