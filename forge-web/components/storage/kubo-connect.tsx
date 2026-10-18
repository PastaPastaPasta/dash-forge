'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { takeKuboPair } from '@/lib/prehydration'
import { usePathname, useSearchParams } from '@/hooks/use-route'
import { safariNeedsNotice, kuboUpCommand, pairWithNode, parseKuboCode, parseKuboFragment, SAFARI_NOTICE, type PairedNode } from '@/lib/storage/kubo-connect'
import { policyFor, withProfile, type StoragePolicy } from '@/lib/storage'
import { errText } from '@/lib/storage/util'
import { useAuth } from '@/contexts/auth-context'
import { useStorageConfig, type StorageConfigState } from '@/hooks/use-storage-config'
import { SignInButton } from '@/components/sign-in-button'
import { UnlockMore } from '@/components/auth/unlock-more'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CopyBlock } from './copy-block'
import { StorageTest, profileSnapshot } from './storage-test'

export function KuboConnect({ fragmentOnly = false }: { fragmentOnly?: boolean }): JSX.Element | null {
  return <KuboConnectView storage={useStorageConfig()} fragmentOnly={fragmentOnly} />
}

/** Next changes the search-params object even on hash-only client navigation. */
function PairLinks({ onPair }: { onPair: (fragment: string) => void }): null {
  const pathname = usePathname()
  const params = useSearchParams()
  useEffect(() => {
    const read = (): void => {
      const fragment = takeKuboPair()
      if (fragment !== null) onPair(fragment)
    }
    read()
    window.addEventListener('hashchange', read)
    window.addEventListener('popstate', read)
    return () => {
      window.removeEventListener('hashchange', read)
      window.removeEventListener('popstate', read)
    }
  }, [onPair, pathname, params])
  return null
}

export function KuboConnectView({ storage, fragmentOnly = false, showUnlock = true }: { storage: StorageConfigState; fragmentOnly?: boolean; showUnlock?: boolean }): JSX.Element | null {
  const { identity } = useAuth()
  const [node, setNode] = useState<PairedNode | null>(null)
  const [code, setCode] = useState('')
  const [port, setPort] = useState('5001')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [savedName, setSavedName] = useState('')
  const [useForPushes, setUseForPushes] = useState(false)
  const [previousPolicy, setPreviousPolicy] = useState<StoragePolicy | null>(null)
  const [browser, setBrowser] = useState<{ command: string | null; safari: boolean } | null>(null)

  const connect = useCallback(async (input: { port: number; code: string }): Promise<void> => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try { setNode(await pairWithNode(input)) } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }, [])
  const onPair = useCallback((fragment: string): void => {
    const input = parseKuboFragment(fragment)
    if (input) void connect(input)
    else setError('Invalid connection link. Run dg ipfs connect for a new one.')
  }, [connect])
  useEffect(() => {
    setBrowser({ command: kuboUpCommand(location.origin, location.pathname), safari: safariNeedsNotice(location.origin) })
  }, [])

  // Keep listening even while the fragment-only card is empty; this boundary keeps the
  // route subscription from opting the surrounding settings page out of static rendering.
  const links = <Suspense fallback={null}><PairLinks onPair={onPair} /></Suspense>
  if (fragmentOnly && !node && !busy && !error && !saved) return links
  const canSave = identity !== null && storage.storable && !storage.needsUnlock && storage.config !== null && !storage.loading && !storage.error
  const config = storage.config
  const collision = node && config?.profiles.some((p) => p.name === node.profile.name && (p.settings.kind !== 'ipfs-kubo' || p.settings.api !== (node.profile.settings.kind === 'ipfs-kubo' ? node.profile.settings.api : '')))

  return (
    <>{links}
    <section aria-label="Connect an IPFS node" className="space-y-3 rounded-lg border border-anvil-200 p-4 text-dense dark:border-anvil-750">
      {!fragmentOnly ? <>
        <h3 className="font-medium">Run one command</h3>
        {browser?.command ? <>
          <CopyBlock text={browser.command} label="Copy the node setup command" />
          <p>It installs IPFS (kubo 0.43.1) for your user, starts it at login, and opens this page to connect. Needs dg: <a className="underline" href="https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/INSTALL.md">install dg</a></p>
          <p className="text-[12px]">The node only accepts this site, and only for adding, pinning and unpinning.</p>
        </> : <p>Open Forge from its own address to connect a node.</p>}
        <h3 className="font-medium">Connect with a code</h3>
        <label className="block">Connection code<Input aria-label="Connection code" autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX" onChange={(e) => setCode(e.target.value)} /></label>
        <details><summary className="cursor-pointer">Advanced</summary><label>Port<Input aria-label="Node port" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} /></label></details>
        <Button size="sm" loading={busy} disabled={node !== null || !parseKuboCode(code.trim(), Number(port))} onClick={() => { const input = parseKuboCode(code.trim(), Number(port)); if (input) void connect(input) }}>Connect</Button>
      </> : null}
      {browser?.safari ? <p role="note">{SAFARI_NOTICE}</p> : null}
      {busy ? <p role="status">Connecting to the node…</p> : null}
      {error ? <p role="alert" className="text-danger-700 dark:text-danger-400">{error}</p> : null}
      {node ? <div className="space-y-3">
        <p className="font-medium">Connect the IPFS node on this computer? kubo {node.version}, peer {node.peerId.slice(0, 12)}…</p>
        {!canSave ? <>
          {identity === null ? <><p>Sign in to finish connecting</p><SignInButton /></> : storage.needsUnlock ? showUnlock ? <UnlockMore title="Unlock this tab to connect your node" /> : <p>Unlock your storage settings below to finish connecting.</p> : <p>{storage.error ?? 'Storage credentials need a signed-in session with a stored key.'}</p>}
        </> : collision ? <p role="alert">A different profile already uses this name. Run dg ipfs up --name with another name.</p> : <StorageTest key={`${identity}:${profileSnapshot(node.profile)}`} profile={node.profile} buttonLabel="Test and save" disabled={busy} onDone={async (ok) => {
          if (!ok || !config || !canSave) return
          setBusy(true)
          setError(null)
          try {
            const first = config.profiles.length === 0
            let next = withProfile(config, node.profile)
            if (first) next = { ...next, defaultPolicy: policyFor([node.profile.name], 'one') }
            next = { ...next, lastTests: { ...next.lastTests, [node.profile.name]: { at: Date.now(), ok: true } } }
            await storage.save(next)
            setSaved(true)
            setSavedName(node.profile.name)
            setUseForPushes(first)
            setPreviousPolicy(config.defaultPolicy)
            setNode(null)
          } catch (e) { setError(errText(e)) } finally { setBusy(false) }
        }} />}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setNode(null); setError(null) }}>Cancel</Button>
      </div> : null}
      {saved ? <div className="space-y-2">
        <p role="status">IPFS node saved.</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={useForPushes} disabled={busy || !canSave} onChange={async (e) => {
          const checked = e.target.checked
          const current = storage.config
          if (!current) return
          const policy = current.defaultPolicy
          const added = policy ? { ...policy, targets: policy.targets.includes(savedName) ? policy.targets : [...policy.targets, savedName] } : policyFor([savedName], 'one')
          const next = { ...current, defaultPolicy: checked ? added : previousPolicy }
          setBusy(true)
          setError(null)
          try { await storage.save(next); if (checked) setPreviousPolicy(policy); setUseForPushes(checked) } catch (err) { setError(errText(err)) } finally { setBusy(false) }
        }} />Use it for my pushes</label>
      </div> : null}
    </section>
    </>
  )
}
