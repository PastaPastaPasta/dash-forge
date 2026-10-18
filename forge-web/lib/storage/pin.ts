/** Authorized repo blobs, pinned to a user's node without writing anything to Platform. */
import type { EvoSDK } from '@dashevo/evo-sdk'
import { bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { RepoRef } from '../repo/contract'
import { readRepoPackManifests, packsOfKind, type PackManifest } from '../repo/packs'
import { readReleases, type ReleaseAssetView } from '../repo/releases'
import { readPushGrants } from '../repo/push-grants'
import { readRoleOracle } from '../repo/members'
import { mirrorUrisOf } from '../repo/pack-mirrors'
import { loadArtifactBytesProgress, pinArtifactAccess } from '../view/browse-source'
import { downloadVerifiedAsset, loadReleaseManifest } from '../view/release-download'
import { isApprover } from '../rules/v2'
import { cidV1RawLeaves, normalizeCid } from './cid'
import { addVerified, apiAddressSpace, unpin, type IpfsSettings } from './ipfs'
import { profileProblem, type StorageProfile } from './profiles'
import { errText } from './util'

export const WEB_PIN_MAX_BYTES = 512 * 1024 * 1024
export const PIN_IN_FLIGHT_BYTES = 128 * 1024 * 1024
const PIN_TIMEOUT_MS = 120_000

export interface PinTarget {
  readonly cid: string
  readonly candidates: readonly { readonly cid: string; readonly authorized: boolean }[]
  readonly sizeBytes: number
  readonly sha256: string
  readonly what: string
  readonly private: boolean
  readonly pack?: PackManifest
  readonly asset?: ReleaseAssetView
}
export interface PinPlan {
  readonly targets: readonly PinTarget[]
  readonly sizeBytes: number
  readonly notOnIpfs: number
  readonly membersOnlySkipped: number
  readonly unavailableSkipped: number
  readonly invalidCidsSkipped: number
  readonly unverifiableSkipped: number
  readonly requiresConsent: boolean
}

function uriCid(uri: string): string | null {
  if (uri.startsWith('ipfs://')) return uri.slice(7).split(/[/?#]/)[0] ?? ''
  try { return /^\/ipfs\/([^/]+)/.exec(new URL(uri).pathname)?.[1] ?? null } catch { return null }
}

export function cidOfUri(uri: string): string | null {
  const cid = uriCid(uri)
  return cid === null ? null : normalizeCid(cid)
}

const authorizedRole = (m: PackManifest): boolean => isApprover(m.ownerRole) || m.ownerRole === 'bot'

/** Pure inputs with injectable key/mirror reads, so the CLI's shared vectors can exercise it. */
export async function enumeratePinTargets(input: {
  readonly manifests: readonly PackManifest[]
  readonly assets?: readonly (ReleaseAssetView & { readonly private?: boolean })[]
  readonly access: (pack: PackManifest) => Promise<{ readable: boolean; private: boolean; unavailable?: boolean }>
  readonly mirrors?: (pack: PackManifest) => Promise<readonly string[]>
}): Promise<PinPlan> {
  // Choose metadata from authorized copies, even when the reader ranks a triage copy first.
  const authorized = input.manifests.filter(authorizedRole)
  const packs = [...new Set(authorized.map((m) => m.kind))].sort((a, b) => a - b).flatMap((kind) => packsOfKind(authorized, kind))
  const pending: PinTarget[] = []
  let notOnIpfs = 0, membersOnlySkipped = 0, unverifiableSkipped = 0, unavailableSkipped = 0, invalidCidsSkipped = 0
  const candidatesOf = (uris: readonly string[], trusted: boolean): PinTarget['candidates'] => uris.flatMap((uri) => {
    const raw = uriCid(uri)
    if (raw === null) return []
    const cid = normalizeCid(raw)
    if (cid === null) { invalidCidsSkipped++; return [] }
    return [{ cid, authorized: trusted }]
  })
  // Reserve each result's place so parallel header completion never changes candidate priority.
  const results: (PinTarget | undefined)[] = new Array(packs.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, packs.length) }, async () => {
    for (;;) {
      const index = next++
      const ranked = packs[index]
      if (!ranked) return
      if (!Number.isSafeInteger(ranked.sizeBytes) || ranked.sizeBytes < 0 || !/^[0-9a-f]{64}$/i.test(ranked.packHash)) { unverifiableSkipped++; continue }
      const copies = input.manifests.filter((m) => m.packHash.toLowerCase() === ranked.packHash.toLowerCase() && m.kind === ranked.kind)
      const pack = { ...ranked, copies: [...(ranked.copies ?? [ranked]), ...copies.filter((m) => !authorizedRole(m))].map((m) => ({ ...m, sizeBytes: ranked.sizeBytes })) }
      const candidates = copies.filter((m) => m.sizeBytes === ranked.sizeBytes).sort((a, b) => Number(authorizedRole(b)) - Number(authorizedRole(a))).flatMap((m) => candidatesOf(m.uris, authorizedRole(m)))
      try { candidates.push(...candidatesOf(await input.mirrors?.(pack) ?? [], false)) } catch { /* Other recorded copies can still be used. */ }
      if (!candidates.length) { notOnIpfs++; continue }
      let access: Awaited<ReturnType<typeof input.access>>
      try { access = await input.access(pack) } catch { unavailableSkipped++; continue }
      if (access.unavailable) { unavailableSkipped++; continue }
      if (!access.readable) { membersOnlySkipped++; continue }
      results[index] = { cid: candidates[0]!.cid, candidates, sizeBytes: pack.sizeBytes, sha256: pack.packHash.toLowerCase(), what: `pack ${pack.packHash.slice(0, 12)}…`, private: access.private, pack }
    }
  }))
  pending.push(...results.filter((t): t is PinTarget => t !== undefined))
  for (const asset of input.assets ?? []) {
    if (asset.size === null || !Number.isSafeInteger(asset.size) || asset.size < 0 || !/^[0-9a-f]{64}$/.test(asset.sha256)) { unverifiableSkipped++; continue }
    const candidates = candidatesOf(asset.uris, true)
    if (!candidates.length) { notOnIpfs++; continue }
    pending.push({ cid: candidates[0]!.cid, candidates, sizeBytes: asset.size, sha256: asset.sha256, what: `asset ${asset.name}`, private: asset.private === true, asset })
  }
  // A stranger cannot poison another pack by claiming its CID with conflicting metadata.
  const metadata = new Map<string, PinTarget>()
  for (const trusted of [true, false]) for (const target of pending) for (const c of target.candidates) {
    if (c.authorized === trusted && !metadata.has(c.cid)) metadata.set(c.cid, target)
  }
  const targets = pending.flatMap((target) => {
    const seen = new Set<string>()
    const candidates = target.candidates.filter((c) => {
      const preferred = metadata.get(c.cid)!
      if (preferred.sizeBytes !== target.sizeBytes || preferred.sha256 !== target.sha256 || seen.has(c.cid)) return false
      seen.add(c.cid); return true
    })
    if (!candidates.length) { notOnIpfs++; return [] }
    return [{ ...target, cid: candidates[0]!.cid, candidates }]
  })
  return { targets, sizeBytes: targets.reduce((n, t) => n + t.sizeBytes, 0), notOnIpfs, membersOnlySkipped, unverifiableSkipped, unavailableSkipped, invalidCidsSkipped, requiresConsent: targets.some((t) => t.private) }
}

export async function readPinPlan(sdk: EvoSDK, repo: RepoRef): Promise<PinPlan> {
  if (repo.visibility === 'private' && (!repo.session || repo.session.closed)) throw new Error('Only members with this repository’s key can pin its files.')
  const [manifests, releases, oracle, grants] = await Promise.all([readRepoPackManifests(sdk, repo), readReleases(sdk, repo), readRoleOracle(sdk, repo), readPushGrants(sdk, repo)])
  if (repo.visibility === 'private' && !oracle.currentRole(repo.session!.reader)) throw new Error('Only members can pin a private repository.')
  const assets: (ReleaseAssetView & { private?: boolean })[] = []
  for (const release of [...releases.current, ...releases.previous]) {
    if (!isApprover(oracle.currentRole(release.publisher))) continue
    if (!release.sealed) assets.push(...release.assets)
    else if (repo.session && release.sealed.fields.assetManifest) {
      const list = await loadReleaseManifest(sdk, repo, release.sealed.fields, repo.session.ctx.keys)
      for (const a of list.assets) {
        // Pin the encrypted object, verified against its sealed hash, never the plaintext file.
        if (a.sealedSha256 !== undefined && a.sealedSizeBytes !== undefined) assets.push({ name: a.name, sha256: a.sealedSha256, size: a.sealedSizeBytes, uris: a.uris, private: true })
        else assets.push({ name: a.name, sha256: '', size: null, uris: a.uris, private: true })
      }
    }
  }
  const bots = new Set(grants.filter((g) => g.until > Date.now() && (g.granter === repo.ownerId || oracle.currentRole(g.granter) === 'maintainer')).map((g) => g.bot))
  const authorizedManifests = manifests.map((m) => m.uploader === repo.ownerId ? { ...m, ownerRole: 'maintainer' as const } : bots.has(m.uploader) ? { ...m, ownerRole: 'bot' as const } : m)
  return enumeratePinTargets({ manifests: authorizedManifests, assets, access: (p) => pinArtifactAccess(sdk, repo, p), mirrors: (p) => mirrorUrisOf(sdk, repo, p) })
}

export type PinState = 'pinning' | 'pinned' | 'already' | 'failed'
export interface PinProgress {
  readonly event: 'blob'
  readonly index: number
  readonly total: number
  readonly cid: string
  readonly what: string
  readonly sizeBytes: number
  readonly state: PinState
  readonly why?: string
}
export interface PinSummary { readonly pinned: number; readonly already: number; readonly failed: number; readonly sizeBytes: number }

async function nodePost(profile: StorageProfile, path: string, signal?: AbortSignal): Promise<Response> {
  const s = profile.settings as IpfsSettings
  return fetch(`${s.api.replace(/\/+$/, '')}/api/v0/${path}`, {
    method: 'POST', headers: profile.secrets.apiAuth ? { authorization: profile.secrets.apiAuth } : {},
    credentials: 'omit', redirect: 'error', ...apiAddressSpace(s.api), signal,
  } as RequestInit)
}

async function alreadyPinned(profile: StorageProfile, cid: string, signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController()
  const cancel = (): void => controller.abort()
  signal?.addEventListener('abort', cancel)
  const timer = setTimeout(cancel, 15_000)
  try {
    if (signal?.aborted) throw new Error('Cancelled')
    const r = await nodePost(profile, `pin/ls?arg=${cid}&type=recursive`, controller.signal)
    const text = await r.text()
    if (!r.ok) {
      if (r.status === 500 && /not pinned/.test(text)) return false
      throw new Error(`Pin check failed (HTTP ${r.status}). Check your node and token.`)
    }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new Error('The node returned an invalid pin check.') }
    return parsed !== null && typeof parsed === 'object' && 'Keys' in parsed && typeof parsed.Keys === 'object' && parsed.Keys !== null && Object.keys(parsed.Keys).some((key) => normalizeCid(key) === cid)
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}

async function swarmPin(profile: StorageProfile, target: PinTarget, signal?: AbortSignal): Promise<void> {
  const controller = new AbortController()
  let timedOut = false
  let started = false
  const cancel = (): void => controller.abort()
  signal?.addEventListener('abort', cancel)
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, PIN_TIMEOUT_MS)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    if (signal?.aborted) throw new Error('Cancelled')
    started = true
    const r = await nodePost(profile, `pin/add?arg=${target.cid}&progress=true`, controller.signal)
    if (r.status === 403) throw new Error('Run dg ipfs up to refresh the node’s token (pin/add was refused).')
    if (!r.ok || !r.body) throw new Error(`Pin failed (HTTP ${r.status}).`)
    reader = r.body.getReader()
    let pending = ''
    let pinned = false
    const decoder = new TextDecoder()
    const line = (s: string): void => {
      if (!s.trim()) return
      let value: unknown
      try { value = JSON.parse(s) } catch { throw new Error('Invalid pin progress from the node.') }
      if (value === null || typeof value !== 'object') throw new Error('Invalid pin progress from the node.')
      const progress = value as { Progress?: unknown; Bytes?: unknown; Pins?: unknown; Message?: unknown }
      const fetched = typeof progress.Bytes === 'number' ? progress.Bytes : typeof progress.Progress === 'number' ? progress.Progress * 1048576 : 0
      if (!Number.isSafeInteger(fetched) || fetched < 0 || fetched > target.sizeBytes * 1.1 + 1048576) throw new Error('The node fetched more blocks than the recorded file size allows; pinning stopped.')
      if (typeof progress.Message === 'string') throw new Error('The node could not pin this file.')
      if (Array.isArray(progress.Pins) && progress.Pins.some((cid) => typeof cid === 'string' && normalizeCid(cid) === target.cid)) pinned = true
    }
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      // Kubo emits short NDJSON progress rows; cap a malicious or broken response.
      if (pending.length > 65536) throw new Error('Invalid pin progress from the node.')
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) { line(pending.slice(0, end)); pending = pending.slice(end + 1) }
    }
    line(pending + decoder.decode())
    if (!pinned) throw new Error('The node did not confirm the pin.')
  } catch (e) {
    controller.abort()
    await reader?.cancel().catch(() => undefined)
    if (started) {
      try { await unpin(profile.settings as IpfsSettings, profile.secrets, target.cid) }
      catch { throw new Error('Pinning stopped, but the partial pin could not be removed. Check your node before retrying.') }
    }
    if (timedOut) throw new Error('Pin timed out after two minutes. Try again to resume.')
    throw e
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reader?.releaseLock() }
}

/** Two jobs, at most 128 MiB of whole-file reads. Larger files use the bounded swarm path. */
export async function pinRepo(sdk: EvoSDK, repo: RepoRef, profile: StorageProfile, plan: PinPlan, opts: {
  readonly signal?: AbortSignal
  readonly consent?: boolean
  readonly onProgress?: (event: PinProgress) => void
  readonly fetchBytes?: (target: PinTarget, signal?: AbortSignal) => Promise<Uint8Array>
} = {}): Promise<PinSummary> {
  if (profile.settings.kind !== 'ipfs-kubo' || profileProblem(profile)) throw new Error('Choose a valid kubo profile.')
  if (repo.visibility === 'private' && (!repo.session || repo.session.closed)) throw new Error('Only members can pin a private repository.')
  if ((repo.visibility === 'private' || plan.requiresConsent) && !opts.consent) throw new Error('Confirm the IPFS privacy checkbox before pinning.')
  const summary = { pinned: 0, already: 0, failed: 0, sizeBytes: 0 }
  const pending = plan.targets.map((target, index) => ({ target, index }))
  const weightOf = (t: PinTarget): number => Number.isSafeInteger(t.sizeBytes) && t.sizeBytes > 0 && t.sizeBytes <= PIN_IN_FLIGHT_BYTES ? t.sizeBytes : 0
  const active = new Set<Promise<void>>()
  let inFlight = 0
  const run = async (target: PinTarget, index: number): Promise<void> => {
    let selectedCid = target.cid
    const report = (state: PinState, why?: string): void => opts.onProgress?.({ event: 'blob', index: index + 1, total: plan.targets.length, cid: selectedCid, what: target.what, sizeBytes: target.sizeBytes, state, ...(why ? { why } : {}) })
    report('pinning')
    try {
      if (!normalizeCid(target.cid) || !Number.isSafeInteger(target.sizeBytes) || target.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(target.sha256)) throw new Error('Invalid file metadata.')
      if (target.sizeBytes > WEB_PIN_MAX_BYTES) throw new Error(`File exceeds 512 MiB; use dg ipfs pin ${repo.ownerId}/${repo.name}`)
      if (opts.signal?.aborted) throw new Error('Cancelled')
      const trusted = target.candidates.filter((c) => c.authorized)
      for (const c of trusted) {
        if (await alreadyPinned(profile, c.cid, opts.signal)) { selectedCid = c.cid; summary.already++; summary.sizeBytes += target.sizeBytes; report('already'); return }
      }
      if (target.sizeBytes <= PIN_IN_FLIGHT_BYTES) {
        const bytes = await (opts.fetchBytes ? opts.fetchBytes(target, opts.signal) : target.pack
          ? loadArtifactBytesProgress(sdk, repo, target.pack, undefined, opts.signal, true)
          : downloadVerifiedAsset(target.asset!, undefined, { signal: opts.signal, fetch: (url, init) => fetch(url, { ...init, credentials: 'omit', redirect: 'error' }) }))
        if (bytes.length !== target.sizeBytes || bytesToHex(sha256(bytes)) !== target.sha256) throw new Error('The downloaded bytes do not match the recorded size and SHA-256.')
        if (opts.signal?.aborted) throw new Error('Cancelled')
        const derived = cidV1RawLeaves(bytes)
        if (target.candidates.some((c) => c.cid === derived)) {
          selectedCid = derived
          if (!trusted.some((c) => c.cid === derived) && await alreadyPinned(profile, derived, opts.signal)) { summary.already++; summary.sizeBytes += target.sizeBytes; report('already'); return }
          await addVerified(profile.settings as IpfsSettings, profile.secrets, bytes, opts.signal)
          summary.pinned++; summary.sizeBytes += target.sizeBytes; report('pinned'); return
        }
      }
      if (!trusted.length) throw new Error('No authorized IPFS CID matches the verified bytes; use dg ipfs pin for large files.')
      let failure: unknown
      let pinned = false
      for (const c of trusted) {
        if (opts.signal?.aborted) throw new Error('Cancelled')
        try { await swarmPin(profile, { ...target, cid: c.cid }, opts.signal); selectedCid = c.cid; pinned = true; break } catch (e) { failure = e }
      }
      if (!pinned) throw failure
      summary.pinned++; summary.sizeBytes += target.sizeBytes; report('pinned')
    } catch (e) { summary.failed++; report('failed', opts.signal?.aborted ? 'Cancelled; press Pin to resume.' : errText(e)) }
  }
  while (pending.length || active.size) {
    if (opts.signal?.aborted) break
    while (active.size < 2) {
      const at = pending.findIndex(({ target }) => inFlight + weightOf(target) <= PIN_IN_FLIGHT_BYTES)
      if (at < 0) break
      const { target, index } = pending.splice(at, 1)[0]!
      const weight = weightOf(target)
      inFlight += weight
      const job = run(target, index).finally(() => { inFlight -= weight; active.delete(job) })
      active.add(job)
    }
    if (active.size) await Promise.race(active)
  }
  await Promise.all(active)
  return summary
}
