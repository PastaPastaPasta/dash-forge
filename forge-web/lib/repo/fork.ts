/**
 * Forking a forge-v2 repository from the browser — the port of forge-core `fork.rs`, writing
 * the same documents in the same order:
 *
 *  1. a `repo` with `forkOf` = the parent, the owner's `maintainer`, the first `config`
 *     ({@link createRepo});
 *  2. one kind-0 `packManifest` per parent git pack **by reference**: `storage = 1`,
 *     `chunkCount = 0`, `uris` = the parent's Platform copies as
 *     `platform://<core>/<parentRepoId>/<uploader>/<packHashHex>` (in reader order: current
 *     maintainers' copies first), then every URI the parent's copies record, trimmed to 8
 *     URIs of ≤ 300 bytes with `s3://` dropped first; pack facts from the representative copy;
 *  3. a `refUpdate` for every parent ref the fork does not have. A ref the fork already has is
 *     the fork owner's from then on and is never moved. No refs at all when some pack has no
 *     copy a fork could name (they could point at objects the fork cannot serve).
 *
 * Each by-reference manifest is external-only (`storage` 1, no chunks: RC1 `storageShape`) and
 * keeps the parent's `sizeBytes`, which the parent's own manifest already held to 0–1 TiB.
 *
 * Browse locators are not copied: their `packRef`s index the parent's pack list, and nothing
 * needs paying for twice. A reader of the fork reuses the parent's published index, remapped
 * into the fork's pack list by `packHash`, and its history indexes (`loadBrowseContext`,
 * QW-023); the fork's own pushes index just the packs they store.
 *
 * Resumable without a journal: each step checks what the fork already has, and a same-named
 * repo of the signer's that is not a fork of this parent is refused, so the parent's packs and
 * refs are never written into an unrelated repository.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { PACK_KIND } from '../constants'
import type { ForgeIds } from '../deployments'
import { orderPackCopies, type Role } from '../rules/v2'
import { queryAllDocuments, queryDocumentsWithProof, type WriteAuth } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { readRepoPackManifests, type PackManifest } from './packs'
import { MANIFEST_MAX_URIS, MANIFEST_URI_MAX_LEN } from '../constants'
import { manifestUrisProblem, writePackManifest, writeRefUpdate, type PackManifestInput } from './push'
import { readRefs, type ResolvedRef } from './refs'
import { toRepoDoc, repoRefOf, type RepoDoc } from './resolveRepo'
import { createRepo, normalizeRepoName } from './writes'

/** One copy of a parent pack, as the plan needs it (a `PackManifest` fits). */
export type ForkCopy = Pick<
  PackManifest,
  'packHash' | 'kind' | 'sizeBytes' | 'objectCount' | 'storage' | 'uris' | 'supersedes' | 'createdAt' | 'documentId' | 'uploader'
> & { readonly ownerRole?: Role | null }

/** The Platform chunk locator of `uploader`'s copy of `packHash` in `repo`. */
export function platformLocator(forge: ForgeIds, repoId: string, uploader: string, packHash: string): string {
  return `platform://${forge.core}/${repoId}/${uploader}/${packHash.toLowerCase()}`
}

/**
 * The parent's git packs (kind 0) a fork records, each with all of its copies in reader order
 * (current maintainers, then writers, then anyone; each by `($createdAt, $id)`), skipping packs
 * the fork already records. Ordered by each pack's first upload, so the fork's pack list lines
 * up with the parent's. Parity: forge-core `fork::plan_manifests`.
 */
export function planManifests<C extends ForkCopy>(parent: readonly C[], forkHas: ReadonlySet<string>): C[][] {
  const byHash = new Map<string, C[]>()
  for (const m of parent) {
    const hash = m.packHash.toLowerCase()
    if (m.kind !== PACK_KIND.GIT_PACK || forkHas.has(hash)) continue
    const group = byHash.get(hash)
    if (group === undefined) byHash.set(hash, [m])
    else group.push(m)
  }
  const ordered = [...byHash.values()].map((copies) => {
    const ranked = orderPackCopies(
      copies.map((c) => ({ id: c.documentId, packHash: c.packHash, ownerRole: c.ownerRole ?? null, createdAt: c.createdAt })),
    )
    return ranked.map((r) => copies.find((c) => c.documentId === r.id) as C)
  })
  const first = (g: readonly C[]): { createdAt: number; id: string } =>
    g.reduce(
      (min, m) => (m.createdAt < min.createdAt || (m.createdAt === min.createdAt && m.documentId < min.id) ? { createdAt: m.createdAt, id: m.documentId } : min),
      { createdAt: Number.POSITIVE_INFINITY, id: '' },
    )
  return ordered.sort((a, b) => {
    const fa = first(a)
    const fb = first(b)
    return fa.createdAt - fb.createdAt || (fa.id < fb.id ? -1 : fa.id > fb.id ? 1 : 0)
  })
}

/**
 * The fork's manifest for one parent pack from its `copies` (reader order): the first copy's
 * pack facts, no chunks of the fork's own, and every URI a reader of the parent could use.
 * Null when nothing a fork could name is left. Parity: forge-core `fork::fork_manifest`.
 */
export function forkManifest(forge: ForgeIds, parentRepoId: string, copies: readonly ForkCopy[]): PackManifestInput | null {
  const first = copies[0]
  if (first === undefined) return null
  let uris: string[] = []
  const push = (u: string): void => {
    if (!uris.includes(u)) uris.push(u)
  }
  for (const m of copies) if (m.storage === 0) push(platformLocator(forge, parentRepoId, m.uploader, m.packHash))
  for (const m of copies) for (const u of m.uris) push(u)
  // Private `s3://` locators go first when the list is too long: they only serve readers
  // holding that bucket's profile.
  if (manifestUrisProblem(uris) !== null) uris = uris.filter((u) => !u.startsWith('s3://'))
  const enc = new TextEncoder()
  uris = uris.filter((u) => enc.encode(u).length <= MANIFEST_URI_MAX_LEN).slice(0, MANIFEST_MAX_URIS)
  if (uris.length === 0) return null
  return {
    packHash: first.packHash.toLowerCase(),
    kind: first.kind,
    sizeBytes: first.sizeBytes,
    objectCount: first.objectCount,
    chunkCount: 0,
    storage: 1,
    uris,
    supersedes: first.supersedes,
  }
}

/** A ref and the tip it resolves to (a diverged ref at its provisional tip), or null. */
export function refTip(ref: Pick<ResolvedRef, 'state'>): string | null {
  const s = ref.state
  if (s.state === 'resolved') return s.oid
  if (s.state === 'diverged') return s.heads[0]?.oid ?? null
  return null
}

/**
 * The refs a fork still needs: every parent ref with a tip that the fork does not have at all.
 * Parity: forge-core `fork::plan_refs`.
 */
export function planRefs(
  parent: readonly Pick<ResolvedRef, 'refName' | 'state'>[],
  fork: readonly Pick<ResolvedRef, 'refName' | 'state'>[],
): { refName: string; oid: string }[] {
  const has = new Set(fork.filter((r) => refTip(r) !== null).map((r) => r.refName))
  const out: { refName: string; oid: string }[] = []
  for (const r of parent) {
    if (has.has(r.refName)) continue
    const oid = refTip(r)
    if (oid !== null) out.push({ refName: r.refName, oid })
  }
  return out
}

/** The signer's repo named `name`, or null. */
async function ownRepoNamed(sdk: EvoSDK, forge: ForgeIds, owner: string, name: string): Promise<RepoDoc | null> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: forge.core,
    documentTypeName: DOC.repo,
    where: [
      ['$ownerId', '==', owner],
      ['name', '==', name],
    ],
    limit: 1,
  })
  const doc = documents[0]
  return doc === undefined ? null : toRepoDoc(doc)
}

/** Forks of `parentId` (the `forkOf` index), optionally only `owner`'s. */
export async function findForks(sdk: EvoSDK, forge: ForgeIds, parentId: string, owner?: string): Promise<RepoRef[]> {
  const docs = await queryAllDocuments(sdk, {
    dataContractId: forge.core,
    documentTypeName: DOC.repo,
    where: [['forkOf', '==', parentId]],
    orderBy: [['forkOf', 'asc']],
  })
  return docs
    .map(toRepoDoc)
    .filter((d) => owner === undefined || d.ownerId === owner)
    .map((d) => repoRefOf(forge, d))
}

/** What a fork name would do: a new repo, resume an interrupted fork, or clash. */
export type ForkNameCheck = { readonly kind: 'free' } | { readonly kind: 'resume'; readonly repoId: string } | { readonly kind: 'taken' }

export async function checkForkName(sdk: EvoSDK, parent: RepoRef, owner: string, name: string): Promise<ForkNameCheck> {
  const doc = await ownRepoNamed(sdk, parent.forge, owner, normalizeRepoName(name))
  if (doc === null) return { kind: 'free' }
  return doc.forkOf === parent.repoId ? { kind: 'resume', repoId: doc.repoId } : { kind: 'taken' }
}

/** The steps of a fork, in order. */
export type ForkStep = 'repo' | 'maintainer' | 'config' | 'manifests' | 'refs'

/** Progress: a step starting or done, with `n of total` for the counted steps. */
export interface ForkProgress {
  readonly step: ForkStep
  readonly state: 'start' | 'done'
  readonly done?: number
  readonly total?: number
}

/** What a finished fork did. */
export interface ForkResult {
  readonly repoId: string
  readonly name: string
  readonly manifestsWritten: number
  /** Parent packs with no copy a fork could reference; no refs were copied when any. */
  readonly unreferenceable: readonly string[]
  readonly refsWritten: readonly string[]
}

/** What a fork of `parent` will write (for the cost preview): packs to record and refs to copy. */
export async function planFork(
  sdk: EvoSDK,
  parent: RepoRef,
): Promise<{ manifests: PackManifestInput[]; unreferenceable: string[]; refs: { refName: string; oid: string }[] }> {
  const [manifests, refs] = await Promise.all([readRepoPackManifests(sdk, parent), readRefs(sdk, parent)])
  const inputs: PackManifestInput[] = []
  const unreferenceable: string[] = []
  for (const copies of planManifests(manifests, new Set())) {
    const input = forkManifest(parent.forge, parent.repoId, copies)
    if (input === null) unreferenceable.push((copies[0] as PackManifest).packHash)
    else inputs.push(input)
  }
  return { manifests: inputs, unreferenceable, refs: unreferenceable.length > 0 ? [] : planRefs(refs, []) }
}

/**
 * Fork `parent` as `name` under the signer. Resumable: rerun with the same name to finish an
 * interrupted fork; nothing is paid for twice.
 */
export async function forkRepoV2(
  sdk: EvoSDK,
  auth: WriteAuth,
  parent: RepoRef,
  input: { readonly name: string; readonly description?: string },
  onProgress?: (p: ForkProgress) => void,
): Promise<ForkResult> {
  // A fork is public: forking a private repo would publish its decrypted names and code.
  if (parent.visibility !== 'public') throw new Error('a private repository cannot be forked')
  const name = normalizeRepoName(input.name)
  const owner = auth.identityId
  if (owner === parent.ownerId && name === parent.name) throw new Error('this repository is yours already; pick another name for the fork')
  const clash = await checkForkName(sdk, parent, owner, name)
  if (clash.kind === 'taken') {
    throw new Error(`you already have a repository named ${name} and it is not a fork of ${parent.name}; pick another name`)
  }

  const created = await createRepo(
    sdk,
    auth,
    parent.forge,
    { name, description: input.description ?? `fork of ${parent.ownerId}/${parent.name}`, forkOf: parent.repoId },
    (step, state) => onProgress?.({ step, state }),
  )
  const fork: RepoRef = { forge: parent.forge, repoId: created.repoId, ownerId: owner, name, visibility: 'public' }

  onProgress?.({ step: 'manifests', state: 'start' })
  const [parentManifests, forkManifests] = await Promise.all([readRepoPackManifests(sdk, parent), readRepoPackManifests(sdk, fork)])
  const forkHas = new Set(forkManifests.filter((m) => m.uploader === owner).map((m) => m.packHash.toLowerCase()))
  const plan = planManifests(parentManifests, forkHas)
  const unreferenceable: string[] = []
  let written = 0
  for (const copies of plan) {
    const manifest = forkManifest(parent.forge, parent.repoId, copies)
    if (manifest === null) {
      unreferenceable.push((copies[0] as PackManifest).packHash)
      continue
    }
    await writePackManifest(sdk, auth, fork, manifest, `fork:${fork.repoId}:manifest:${manifest.packHash}`)
    written += 1
    onProgress?.({ step: 'manifests', state: 'start', done: written, total: plan.length })
  }
  onProgress?.({ step: 'manifests', state: 'done', done: written, total: plan.length })

  onProgress?.({ step: 'refs', state: 'start' })
  const refsWritten: string[] = []
  if (unreferenceable.length === 0) {
    const [parentRefs, forkRefs] = await Promise.all([readRefs(sdk, parent), readRefs(sdk, fork)])
    const todo = planRefs(parentRefs, forkRefs)
    for (const { refName, oid } of todo) {
      await writeRefUpdate(sdk, auth, fork, { refName, newOid: oid }, { intent: `fork:${fork.repoId}:ref:${refName}:${oid}` })
      refsWritten.push(refName)
      onProgress?.({ step: 'refs', state: 'start', done: refsWritten.length, total: todo.length })
    }
  }
  onProgress?.({ step: 'refs', state: 'done', done: refsWritten.length, total: refsWritten.length })
  return { repoId: fork.repoId, name, manifestsWritten: written, unreferenceable, refsWritten }
}
