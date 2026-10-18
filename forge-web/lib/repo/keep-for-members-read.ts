/** Read-only count for the post-public settings notice; the web never writes kept refs. */
import type { EvoSDK } from '@dashevo/evo-sdk'

import { decodeIdentifier } from '../auth/base58'
import { sealOffBoundary } from '../private'
import { parseCommit, parseTag } from '../view/git-objects'
import { readDefaultBranch } from './config'
import { DOC, asIdentifierString, num, stringArray, type RepoRef } from './contract'
import { refTip } from './fork'
import { planKeep } from './keep-for-members'
import { cutoffOf } from './make-public'
import { openPrivateEraPacks, privateEraRefs, privateViewOf, readConversion } from './make-public-check'
import { workStoreOf } from './make-public-objects'
import { readMembersRefs } from './members-branches'
import { admitAll, privateGate } from './private-content'
import { readSessionSealOff } from './private-session'
import { readRefs, type ResolvedRef } from './refs'
import { readAllRows } from './source'

/** Null when locked or packs are unavailable; failed object reads reject, without an inferred count. */
export async function readPendingKeep(sdk: EvoSDK, repo: RepoRef, recorded: number | null = null): Promise<number | null> {
  const lane = repo.lane
  if (repo.visibility !== 'public' || lane === undefined || lane.closed) return null
  const conversion = await readConversion(sdk, repo, (e) => lane.resolution.anchors.has(e))
  if (conversion === null) return null
  const boundary = cutoffOf(conversion.sealOffEpoch, sealOffBoundary(recorded, await readSessionSealOff(lane, decodeIdentifier(repo.ownerId))))
  if (boundary === undefined) return null
  const view = privateViewOf(repo)
  const rows = new Map(await Promise.all(
    [DOC.refUpdate, DOC.protectedRefUpdate].map(async (t) => [t, await readAllRows(sdk, view, t)] as const),
  ))
  const gate = privateGate(view, lane.ctx)
  const config = await admitAll(gate, DOC.config, await readAllRows(sdk, view, DOC.config))
  // Use the held, anchor-checked keys with the private-era gate and config timeline. This is a
  // read-only projection, with the original session's lifetime; it never owns or closes keys.
  const session = {
    ...lane,
    gate,
    configHistory: config.docs.map((d) => ({
      id: asIdentifierString(d['$id']), createdAt: num(d, '$createdAt'), protectedPatterns: stringArray(d, 'protectedPatterns') ?? [],
    })),
  }
  const tips = (refs: readonly ResolvedRef[]): Map<string, string> => new Map(refs.flatMap((r) => {
    const t = refTip(r)
    return t === null ? [] : [[r.refName, t] as const]
  }))
  const [all, below, publicRefs, memberRefs] = await Promise.all([
    privateEraRefs(session, rows, undefined).then(tips), privateEraRefs(session, rows, boundary).then(tips),
    readRefs(sdk, repo).then(tips), readMembersRefs(sdk, repo, lane),
  ])
  if ([...all].every(([n, t]) => below.get(n) === t)) return 0
  const members = tips(memberRefs.branches.filter((r) => r.narrower === undefined))
  const defaultRef = `refs/heads/${await readDefaultBranch(sdk, repo)}`
  const reserved = new Set(memberRefs.branches.map((r) => r.refName))
  // Exact tips need no object reads. A finished conversion normally takes this path, even if
  // an old pack is unavailable or the repository is above the browser's indexing limit.
  const exact = await planKeep(all, below, publicRefs, members, defaultRef, (a, b) => a === b, reserved)
  if (exact.every((p) => p.keep.status !== 'push')) return 0
  const { packs, unfetched } = await openPrivateEraPacks(sdk, session, view)
  if (unfetched > 0) return null
  const store = await workStoreOf(packs, `${repo.ownerId}/${repo.name}`)
  const { loadBrowseContext } = await import('../view/browse-source')
  const browse = await loadBrowseContext(sdk, repo)
  const isAncestor = async (ancestor: string, tip: string): Promise<boolean> => {
    const seen = new Set<string>()
    const pending = [tip]
    while (pending.length > 0) {
      const oid = pending.pop() as string
      if (oid === ancestor) return true
      if (seen.has(oid)) continue
      seen.add(oid)
      const obj = store.oids.has(oid) ? await store.read(oid) : browse.kind === 'ready' ? await browse.context.reader.readObject(oid) : null
      if (obj === null) throw new Error('Code could not be read')
      if (obj.type === 'commit') pending.push(...parseCommit(obj.bytes).parents)
      if (obj.type === 'tag') {
        const target = parseTag(obj.bytes)?.object
        if (target !== undefined) pending.push(target)
      }
    }
    return false
  }
  const plan = await planKeep(all, below, publicRefs, members, defaultRef, isAncestor, reserved)
  if (lane.closed) return null
  return plan.filter((p) => p.keep.status === 'push').length
}
