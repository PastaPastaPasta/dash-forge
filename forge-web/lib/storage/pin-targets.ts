/** Portable pin planning, shared with forge-core storage::pin and pin_targets vectors. */
import type { Role } from '../rules/v2'
import { normalizeCid } from './cid'

export interface PinCandidate { readonly cid: string; readonly swarmAllowed: boolean }
export type PinWhat = { readonly type: 'pack'; readonly kind: number } | { readonly type: 'releaseAsset'; readonly tag: string; readonly name: string }
export interface PinTarget {
  readonly sha256: string
  readonly size: number
  readonly what: PinWhat
  readonly candidates: readonly PinCandidate[]
}
export interface PinPlan {
  readonly targets: readonly PinTarget[]
  readonly notOnIpfs: number
  readonly membersOnlySkipped: number
  readonly strangerCopiesIgnored: number
  readonly unreadableSkipped: number
  readonly invalidCidsSkipped: number
  readonly conflictingCidsSkipped: number
  readonly needsConsent: boolean
}
export interface PinManifest {
  readonly id: string
  readonly owner: string
  readonly sha256: string
  readonly kind: number
  readonly size: number
  readonly uris: readonly string[]
  readonly createdAt?: number
  readonly readable: boolean
  readonly unreadable?: boolean
  readonly sensitive?: boolean
}
export interface PinAsset {
  readonly name: string
  readonly sha256: string
  readonly size: number
  readonly uris: readonly string[]
  readonly sealedSha256?: string
  readonly sealedSizeBytes?: number
}
export interface PinInput {
  readonly owner: string
  readonly roles: Readonly<Record<string, Role | null>>
  readonly manifests: readonly PinManifest[]
  readonly releases?: readonly { readonly owner: string; readonly tag: string; readonly assets: readonly PinAsset[] }[]
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const byAge = (a: PinManifest, b: PinManifest): number => (a.createdAt ?? 0) - (b.createdAt ?? 0) || compare(a.id, b.id)
export const pinAuthorized = (input: PinInput, identity: string): boolean => identity === input.owner || ['maintainer', 'writer', 'bot'].includes(input.roles[identity] ?? '')

/** The same metadata choice for the network preflight and pure enumeration. */
export function pinPackGroups(input: PinInput): { copies: PinManifest[]; writer: PinManifest | undefined }[] {
  const groups = new Map<string, PinManifest[]>()
  for (const m of input.manifests) {
    const hash = m.sha256.toLowerCase()
    const copies = groups.get(hash) ?? []
    copies.push(m); groups.set(hash, copies)
  }
  const preferred = (m: PinManifest): number => m.owner === input.owner || input.roles[m.owner] === 'maintainer' ? 0 : 1
  return [...groups].sort(([a], [b]) => compare(a, b)).map(([, copies]) => ({
    copies: copies.sort(byAge),
    writer: copies.filter((m) => pinAuthorized(input, m.owner)).sort((a, b) => preferred(a) - preferred(b) || byAge(a, b))[0],
  }))
}

/** Only whole-object IPFS addresses, as accepted by the Rust storage reader. */
export function cidOfUri(uri: string): string | null {
  if (uri.startsWith('ipfs://')) return normalizeCid(uri.slice(7))
  try {
    const url = new URL(uri)
    if (url.protocol !== 'https:' || uri.includes('?') || uri.includes('#')) return null
    const match = /^\/ipfs\/([^/]+)$/.exec(url.pathname)
    return match ? normalizeCid(match[1]!) : null
  } catch { return null }
}

function orderCandidates(candidates: readonly PinCandidate[]): PinCandidate[] {
  const seen = new Set<string>()
  return [...candidates].sort((a, b) => Number(b.swarmAllowed) - Number(a.swarmAllowed) || compare(a.cid, b.cid)).filter((c) => {
    if (seen.has(c.cid)) return false
    seen.add(c.cid); return true
  })
}

export function planPinTargets(input: PinInput): PinPlan {
  const targets: PinTarget[] = []
  let notOnIpfs = 0, membersOnlySkipped = 0, strangerCopiesIgnored = 0, unreadableSkipped = 0, invalidCidsSkipped = 0, conflictingCidsSkipped = 0
  let needsConsent = false
  const candidatesOf = (uris: readonly string[], swarmAllowed: boolean): PinCandidate[] => uris.flatMap((uri) => {
    const cid = cidOfUri(uri)
    if (cid === null) {
      if (uri.startsWith('ipfs://') || uri.includes('/ipfs/')) invalidCidsSkipped++
      return []
    }
    return [{ cid, swarmAllowed }]
  })
  const add = (target: PinTarget): void => {
    const candidates = orderCandidates(target.candidates)
    if (!candidates.length) { notOnIpfs++; return }
    const at = targets.findIndex((t) => t.sha256 === target.sha256 && t.size === target.size)
    if (at < 0) targets.push({ ...target, candidates })
    else targets[at] = { ...targets[at]!, candidates: orderCandidates([...targets[at]!.candidates, ...candidates]) }
  }
  for (const { copies, writer } of pinPackGroups(input)) {
    if (!writer) { strangerCopiesIgnored += copies.length; continue }
    const candidates: PinCandidate[] = []
    for (const copy of copies.filter((m) => m.kind === writer.kind)) {
      const found = candidatesOf(copy.uris, pinAuthorized(input, copy.owner))
      if (copy.size !== writer.size) { conflictingCidsSkipped += found.length; continue }
      candidates.push(...found)
    }
    if (!candidates.length) { notOnIpfs++; continue }
    if (writer.unreadable) { unreadableSkipped++; continue }
    if (!writer.readable) { membersOnlySkipped++; continue }
    needsConsent ||= writer.sensitive === true
    add({ sha256: writer.sha256.toLowerCase(), size: writer.size, what: { type: 'pack', kind: writer.kind }, candidates })
  }
  for (const release of input.releases ?? []) {
    if (!pinAuthorized(input, release.owner)) continue
    for (const asset of release.assets) {
      const sealed = asset.sealedSha256 !== undefined && asset.sealedSizeBytes !== undefined
      if (!sealed && (asset.sealedSha256 !== undefined || asset.sealedSizeBytes !== undefined)) continue
      needsConsent ||= sealed
      add({ sha256: (sealed ? asset.sealedSha256! : asset.sha256).toLowerCase(), size: sealed ? asset.sealedSizeBytes! : asset.size, what: { type: 'releaseAsset', tag: release.tag, name: asset.name }, candidates: candidatesOf(asset.uris, true) })
    }
  }
  // Resolve every authorized claim before considering any stranger's claim.
  const claims = new Map<string, PinTarget>()
  for (const target of targets) for (const c of target.candidates) {
    if (c.swarmAllowed && !claims.has(c.cid)) claims.set(c.cid, target)
  }
  const kept = targets.flatMap((target) => {
    const candidates = target.candidates.filter((c) => {
      const claim = claims.get(c.cid)
      if (!claim) { claims.set(c.cid, target); return true }
      if (claim.sha256 === target.sha256 && claim.size === target.size) return true
      conflictingCidsSkipped++; return false
    })
    if (!candidates.length) { notOnIpfs++; return [] }
    return [{ ...target, candidates }]
  })
  return { targets: kept, notOnIpfs, membersOnlySkipped, strangerCopiesIgnored, unreadableSkipped, invalidCidsSkipped, conflictingCidsSkipped, needsConsent }
}

export const pinPlanBytes = (plan: PinPlan): number => plan.targets.reduce((n, t) => n + t.size, 0)
