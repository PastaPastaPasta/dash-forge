/**
 * Step 0 of making a private repo public (mixed-visibility DESIGN §4.10, §10): everything the
 * dialog shows, read without signing, with the member's own keys (dg `preflight`, forge-core
 * `Collab::make_public_census`). The private era is read through the repo's **private view** (the
 * repo as it was, `visibility: "private"`, with a fresh session): in a repo made public already
 * (Code only, then Everything later) whatever was written after the flip is left out quietly, as
 * the session's gate admits only documents stamped private and the pack reader skips plaintext
 * packs, which were pushed after the conversion.
 *
 * What it reads, in order (each named to `onProgress`): the keys and the repair check, the refs
 * and the settings, every pack of the private era opened into a {@link WorkStore}, Code only's
 * refs, the secret scans, the discussion (Everything), the environments (E812), and the size and
 * cost of both modes. A repo is refused past the browser's caps (`dg repo make-public o/r` then).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { withLetterReader } from '../auth/encryption-key'
import { PACK_KIND } from '../constants'
import { oldFormatOf, needsAttention, readEnvironments, snapshotOf } from '../env/loader'
import { sdkEnvSources } from '../env/sources'
import { CONVERTED_REPO_MIN_CLIENT_VERSION, V4, V6, openContent, TooLargeError, sniff, type Conversion } from '../private'
import { previewCreate, queryAllDocuments, queryDocumentsWithProof, sumPreviews, type PlainDocument } from '../sdk'
import { scanFile } from '../secrets'
import { SuspectPackError, openPrivateArtifact } from '../view/private-packs'
import { readConfigHistory, type RepoConfig } from './config'
import { DOC, asIdentifierString, toRefUpdate, withoutSessions, type RepoRef } from './contract'
import { contractVisibilityOneWay } from './contract-shape'
import { repoConversion } from './converted'
import {
  COPY,
  MakePublicError,
  byName,
  cutoffOf,
  defaultCodeRefs,
  estimateMakePublic,
  loadMakePublicRecord,
  namedCodeRefs,
  recordedSealOff,
  refsOfRecord,
  withinBoundary,
  type MakePublicCensus,
  type MakePublicCheck,
  type MakePublicMode,
  type MakePublicRef,
  type MakePublicSecret,
} from './make-public'
import { isAncestorIn, packSize, reachable, scanObjects, secretOf, workStoreOf, type EntrySizes, type WorkStore } from './make-public-objects'
import { membersUpdatesOf } from './members-refs'
import { packsOfKind, readManifestsOfKind, readRepoPackManifests } from './packs'
import { admitAll, blockHeightOf, bytesField, readableEvents } from './private-content'
import { drySealOffAnchor } from './members-anchor'
import { planRotation, rotationCost, type PrivateWriteContext } from './private-members'
import { readSessionSealOff, loadPrivateSessionUncached, sessionUnwrapper, type PrivateSession } from './private-session'
import { refTip } from './fork'
import { shortRef } from './ref-admin'
import { publicRefKey, toResolvedRef, type ResolvedRef } from './refs'
import type { RefUpdate } from '../rules'
import { readAllRows, repoSource } from './source'

// ---------------------------------------------------------------------------------------------
// Views and small chain reads (shared with the run and the status)
// ---------------------------------------------------------------------------------------------

/** `repo` as it was while private (forge-core `RepoRef::private_view`), without the caller's sessions. */
export function privateViewOf(repo: RepoRef): RepoRef {
  return { ...withoutSessions(repo), visibility: 'private' }
}

/** `repo` as it is once public (dg `public_view`). */
export function publicViewOf(repo: RepoRef): RepoRef {
  return { ...withoutSessions(repo), visibility: 'public' }
}

/** The `repo` document now (one proved read), or null. */
export async function readRepoDoc(sdk: EvoSDK, repo: RepoRef): Promise<PlainDocument | null> {
  const { documents } = await queryDocumentsWithProof(sdk, { dataContractId: repo.forge.core, documentTypeName: DOC.repo, where: [['$id', '==', repo.repoId]], limit: 1 })
  return documents[0] ?? null
}

/** The repo's visibility now, read from its `repo` document (the caller's may be stale). */
export async function readVisibility(sdk: EvoSDK, repo: RepoRef): Promise<'public' | 'private'> {
  const doc = await readRepoDoc(sdk, repo)
  // copy-lint-ignore: a developer error, the repo was read a moment ago
  if (doc === null) throw new Error('the repo could not be read')
  return doc['visibility'] === 'public' ? 'public' : 'private'
}

/**
 * The conversion facts of `repo` read now (forge-core `RepoService::conversion`): null unless public
 * and once private. `anchored` says which epochs have an anchor (a session's resolution), so a
 * private config stating an epoch that never existed can't raise the seal-off epoch, as readers
 * take it; without it every stated epoch counts.
 */
export async function readConversion(sdk: EvoSDK, repo: RepoRef, anchored?: (epoch: number) => boolean): Promise<Conversion | null> {
  const pub = publicViewOf(repo)
  return repoConversion(pub, await readAllRows(sdk, pub, DOC.config), anchored)
}

/**
 * The `packHash`es (hex) of every make-public bundle (kind 7) the owner recorded, from the manifests
 * alone (dg `owner_bundles`). Single posts made public (§4.6) are kind 7 too: the history is the
 * ones among them a run builds itself (`make-public-run.ts`, dg `history_bundles`).
 */
export async function readOwnerBundles(sdk: EvoSDK, repo: RepoRef): Promise<Set<string>> {
  const pub = publicViewOf(repo)
  return new Set((await readManifestsOfKind(sdk, pub, PACK_KIND.MAKE_PUBLIC)).filter((m) => m.uploader === repo.ownerId).map((m) => m.packHash.toLowerCase()))
}

/**
 * The branches and tags members continued after the flip, read through `lane` (a members-key
 * session of the public repo): every name whose updates hold a members-only one this member opens
 * and no live public update (public names win, D29), deleted ones included. Their private-era tips
 * are never published (5A). Members-only updates this member can't open name nothing here.
 */
export async function readMembersContinued(sdk: EvoSDK, repo: RepoRef, lane: PrivateSession): Promise<Set<string>> {
  const pub = publicViewOf(repo)
  const [refUpdate, protectedRefUpdate, configHistory] = await Promise.all([readAllRows(sdk, pub, DOC.refUpdate), readAllRows(sdk, pub, DOC.protectedRefUpdate), readConfigHistory(sdk, pub)])
  const opened = new Set<string>()
  const updates = await membersUpdatesOf({ refUpdate, protectedRefUpdate }, async (stored) => {
    const r = await openContent(stored, lane.ctx)
    if (r.status === 'readable' && stored.id !== undefined) opened.add(base58Encode(stored.id))
    return r
  }, configHistory)
  return new Set([...updates.byName].filter(([, group]) => group.some((u) => opened.has(u.id))).map(([name]) => name))
}

/** A fresh session of the private view for the signer (closed by the caller). */
export function privateSessionFor(c: PrivateWriteContext): Promise<PrivateSession> {
  return loadPrivateSessionUncached(c.sdk, privateViewOf(c.repo), c.network, c.auth.identityId, sessionUnwrapper(c.ops))
}

// ---------------------------------------------------------------------------------------------
// The private era's code
// ---------------------------------------------------------------------------------------------

/** Packs already opened in this run, by `packHash`, with the key epoch each is sealed under (a second check fetches only new ones). */
export type PackCache = Map<string, { readonly plain: Uint8Array; readonly epoch: number } | 'skipped'>

/**
 * Every git pack of the private view this member opens, oldest first, as plaintext (forge-core
 * `open_git_packs`): a pack no copy of which can be fetched is counted in `unfetched`, and so is
 * one sealed under a key this member holds that fails to open (it would be published unchecked); a
 * plaintext pack was pushed after the conversion and is left out; one this member can't open (a
 * narrower branch's, a key not held) is left out too, as is one uploaded by someone without
 * standing (no reader reads it), and with `below` (the seal-off epoch) one sealed under it or
 * later: written during or after the conversion, never published.
 */
export async function openPrivateEraPacks(
  sdk: EvoSDK,
  session: PrivateSession,
  repo: RepoRef,
  cache: PackCache = new Map(),
  below?: number,
): Promise<{ packs: Uint8Array[]; unfetched: number }> {
  // Loaded on demand, as `converted.ts` does: the browse plane reads through the session module.
  const { loadStoredArtifactBytes } = await import('../view/browse-source')
  const view = { ...privateViewOf(repo), session }
  const listed = packsOfKind(await readRepoPackManifests(sdk, view), PACK_KIND.GIT_PACK)
  const packs: Uint8Array[] = []
  let unfetched = 0
  const take = (opened: { readonly plain: Uint8Array; readonly epoch: number }): void => {
    if (below === undefined || opened.epoch < below) packs.push(opened.plain)
  }
  for (const p of listed) {
    const hash = p.packHash.toLowerCase()
    const known = cache.get(hash)
    if (known === 'skipped') continue
    if (known !== undefined) {
      take(known)
      continue
    }
    let sealed: Uint8Array
    try {
      sealed = await loadStoredArtifactBytes(sdk, view, p)
    } catch {
      unfetched++
      continue
    }
    const head = sniff(sealed)
    if (head.kind !== 'sealed') {
      // plaintext: pushed after the conversion; another version: not this member's to open
      cache.set(hash, 'skipped')
      continue
    }
    try {
      const opened = { plain: await openPrivateArtifact(session, p, sealed, p.copies ?? [p]), epoch: head.epoch }
      cache.set(hash, opened)
      take(opened)
    } catch (e) {
      if (e instanceof SuspectPackError || !session.resolution.keys.has(head.epoch)) {
        cache.set(hash, 'skipped')
      } else if (below === undefined || head.epoch < below) {
        // a key this member holds and a pack that would be published: never skipped quietly (not
        // cached either, so a later check tries again)
        unfetched++
      }
    }
  }
  return { packs, unfetched }
}

// ---------------------------------------------------------------------------------------------
// The census (forge-core `Collab::make_public_census`)
// ---------------------------------------------------------------------------------------------

/** Event kind 24: a maintainer hid a comment, review or thread. */
const EVENT_HIDE = 24
/** Event kind 27: someone asked a bot to work on a thread. */
const EVENT_AGENT_REQUEST = 27

/** One text Everything would publish, for the secret scan. */
export interface CensusText {
  readonly place: string
  readonly text: string
}

/** `url`'s host (`https://GitHub.com/o/r` → `github.com`), or the url itself (forge-core `host_of`). */
export function hostOf(url: string): string {
  const at = url.indexOf('://')
  const rest = at >= 0 ? url.slice(at + 3) : url
  return (rest.split(/[/?#]/)[0] ?? rest).toLowerCase()
}

function writtenPrivate(d: PlainDocument): boolean {
  return d['vis'] === 'private'
}

/** Whether `d` was sealed under an epoch below `below` (the seal-off epoch; none: any). */
function sealedBelow(d: PlainDocument, below: number | undefined): boolean {
  const e = d['epoch']
  return below === undefined || typeof e !== 'number' || e < below
}

function revisionOfDoc(d: PlainDocument): number {
  const r = d['$revision']
  return typeof r === 'number' ? r : typeof r === 'bigint' ? Number(r) : 1
}

/** A census being counted. */
interface Tally {
  issues: number
  prs: number
  comments: number
  reviews: number
  revisions: number
  hidden: number
  botRequests: number
  releases: number
  letters: number
  unread: number
  readonly authors: Set<string>
  readonly imported: Map<string, { readonly host: string; readonly author: string }>
  readonly texts: CensusText[]
}

type CensusKind = 'issue' | 'patch' | 'comment' | 'review'

const NOUN: Readonly<Record<CensusKind, string>> = { issue: 'issue', patch: 'pull request', comment: 'comment', review: 'review' }

/** Count the `kind` documents of `docs` written while private, opening them (forge-core `count`). */
async function countKind(session: PrivateSession, kind: CensusKind, docs: readonly PlainDocument[], out: Tally, below: number | undefined): Promise<void> {
  const mine = docs.filter((d) => writtenPrivate(d) && sealedBelow(d, below))
  const isLetter = (d: PlainDocument): boolean => bytesField(d, 'enc')?.[0] === V4
  out.letters += mine.filter(isLetter).length
  const { docs: read, hidden } = await admitAll(session.gate, kind, mine.filter((d) => !isLetter(d)))
  // a malformed one is no post (forge-core leaves those out before opening)
  out.unread += hidden.total - hidden.value.notEncrypted
  for (const d of read) {
    out.authors.add(asIdentifierString(d['$ownerId']))
    out.revisions += Math.max(0, revisionOfDoc(d) - 1)
    const imp = d['imported']
    if (imp !== null && typeof imp === 'object') {
      const o = imp as Record<string, unknown>
      const host = hostOf(typeof o['url'] === 'string' ? o['url'] : '')
      const author = typeof o['author'] === 'string' ? o['author'] : ''
      out.imported.set(`${host}\0${author}`, { host, author })
    }
    if (kind === 'issue') out.issues++
    else if (kind === 'patch') out.prs++
    else if (kind === 'comment') out.comments++
    else out.reviews++
    const place = kind === 'issue' || kind === 'patch' ? (typeof d['number'] === 'number' ? `#${d['number']}` : '') : asIdentifierString(d['$id'])
    for (const field of ['title', 'body', 'path']) {
      const text = d[field]
      if (typeof text === 'string' && text !== '') out.texts.push({ place: `${NOUN[kind]} ${place} ${field}`, text })
    }
  }
}

/**
 * The discussion `repo`'s private view holds from before it was made public (forge-core
 * `make_public_census`), opened with `session`. `before`: the conversion marker's block height of
 * a repo made public already (events carry no visibility stamp, so they are placed by it).
 * `below`: the seal-off epoch, when known: what was sealed under it or later is never published.
 */
export async function readCensus(
  sdk: EvoSDK,
  repo: RepoRef,
  session: PrivateSession,
  before: number | null,
  below?: number,
): Promise<{ census: MakePublicCensus; texts: CensusText[] }> {
  const view = { ...privateViewOf(repo), session }
  const src = repoSource(view)
  const [issues, patches] = await Promise.all([readAllRows(sdk, view, DOC.issue), readAllRows(sdk, view, DOC.patch)])
  // comments by thread and reviews by pull request: the only indexes those two have
  const byTarget = (type: string, field: string, id: string): Promise<PlainDocument[]> =>
    queryAllDocuments(sdk, src.targetQuery(type, { where: [[field, '==', id]], orderBy: [[field, 'asc'], ['$createdAt', 'asc']] }))
  const comments: PlainDocument[] = []
  const reviews: PlainDocument[] = []
  for (const d of issues) comments.push(...(await byTarget(DOC.comment, 'targetId', asIdentifierString(d['$id']))))
  for (const d of patches) {
    comments.push(...(await byTarget(DOC.comment, 'targetId', asIdentifierString(d['$id']))))
    reviews.push(...(await byTarget(DOC.review, 'patchId', asIdentifierString(d['$id']))))
  }
  const out: Tally = {
    issues: 0,
    prs: 0,
    comments: 0,
    reviews: 0,
    revisions: 0,
    hidden: 0,
    botRequests: 0,
    releases: 0,
    letters: 0,
    unread: 0,
    authors: new Set(),
    imported: new Map(),
    texts: [],
  }
  await countKind(session, 'issue', issues, out, below)
  await countKind(session, 'patch', patches, out, below)
  await countKind(session, 'comment', comments, out, below)
  await countKind(session, 'review', reviews, out, below)
  const events = (await readAllRows(sdk, view, DOC.event)).filter((d) => sealedBelow(d, below)).filter((d) => {
    if (before === null) return true
    const at = blockHeightOf(d)
    return at !== undefined && at <= before
  })
  for (const d of events) {
    if (d['kind'] === EVENT_HIDE) out.hidden++
    else if (d['kind'] === EVENT_AGENT_REQUEST) out.botRequests++
  }
  const opened = await readableEvents(view, events.filter((d) => (bytesField(d, 'enc')?.length ?? 0) > 0))
  out.unread += opened.hiddenValues
  for (const d of opened.docs) {
    const value = d['value']
    if (typeof value === 'string' && value !== '') {
      out.authors.add(asIdentifierString(d['$ownerId']))
      out.texts.push({ place: `event ${asIdentifierString(d['$id'])}`, text: value })
    }
  }
  out.releases = (await readAllRows(sdk, view, DOC.release)).filter(writtenPrivate).length
  const { authors, imported, texts, ...counts } = out
  const key = (i: { host: string; author: string }): string => `${i.host}\0${i.author}`
  return {
    census: { ...counts, authors: [...authors].sort(), imported: [...imported.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)) },
    texts,
  }
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

/** What the run needs from a check beyond what the dialog shows. */
export interface Inspection {
  readonly check: MakePublicCheck
  /** The check's refusals, with their codes (`check.blockers` is their copy). */
  readonly blockers: readonly MakePublicError[]
  /** The private era's code. */
  readonly store: WorkStore
  /** The settings carried into the first public config (null: none readable). */
  readonly config: RepoConfig | null
  /** The private view's current key epoch, as this check read it. */
  readonly currentEpoch: number | null
}

/** What a check is asked. */
export interface InspectOptions {
  readonly mode?: MakePublicMode
  /** Code only's refs as named (short or full names). */
  readonly refs?: readonly string[]
  /** The owner's earlier choice of refs (this browser's record), when a run continues it. */
  readonly chosen?: readonly MakePublicRef[]
  /** The repo's conversion facts, when it is public now (null: still private). */
  readonly conversion: Conversion | null
  readonly signal?: AbortSignal
  readonly onProgress?: (what: string) => void
  readonly packCache?: PackCache
  /** How the copy names the repo (`dg repo make-public <label>` when it is too large). */
  readonly label?: string
  /**
   * The seal-off epoch, once the run's rotation made it (default: a repo made public's): what was
   * sealed under it or later (written during or after the conversion) is left out of the refs, the
   * code and the discussion, since it is never published.
   */
  readonly below?: number
}

const REF_TYPES = [
  [DOC.refUpdate, false],
  [DOC.protectedRefUpdate, true],
] as const

/** Every ref-update row of the private view, by type, as stored. */
async function refRows(sdk: EvoSDK, view: RepoRef): Promise<Map<string, PlainDocument[]>> {
  return new Map(await Promise.all(REF_TYPES.map(async ([t]) => [t, await readAllRows(sdk, view, t)] as const)))
}

/**
 * The private era's refs (`refs.ts` `readPrivateRefUpdates` then `readRefs`, over rows already
 * read): every update the session's gate opens, sealed below `below` when given, grouped by its
 * decrypted name and folded over the private config timeline.
 */
export async function privateEraRefs(session: PrivateSession, rows: ReadonlyMap<string, readonly PlainDocument[]>, below: number | undefined): Promise<ResolvedRef[]> {
  const byKey = new Map<string, RefUpdate[]>()
  for (const [type, isProtected] of REF_TYPES) {
    const unique = new Map((rows.get(type) ?? []).filter((d) => sealedBelow(d, below)).map((d) => [String(d['$id']), d]))
    const { docs } = await admitAll(session.gate, type, [...unique.values()])
    for (const doc of docs) {
      const name = doc['refName']
      if (typeof name !== 'string') continue
      const key = publicRefKey(name)
      byKey.set(key, [...(byKey.get(key) ?? []), { ...toRefUpdate(doc, isProtected), refNameHash: key }])
    }
  }
  return [...byKey]
    .map(([key, updates]) => toResolvedRef(updates, session.configHistory, key, () => false))
    .filter((r): r is ResolvedRef => r !== null)
}

/** The seal-off rotation's estimate (dg `rotation_cost`): its wraps and anchor, and each bot's key. */
function rotationCredits(c: PrivateWriteContext, session: PrivateSession): number {
  try {
    return rotationCost(planRotation(session, c.auth.identityId, [], c.repo.forge.core, c.ops.keyIds)).credits
  } catch {
    const holders = new Set(session.members.filter((m) => m.role !== 'bot').map((m) => m.identity)).size
    return sumPreviews([...Array.from({ length: holders }, () => previewCreate(DOC.repoKey)), previewCreate(DOC.config)]).credits
  }
}

/**
 * The check over `session` (the private view's, fresh), as dg's `preflight`. Throws only for what
 * makes the check itself impossible (a repo too large, an unknown ref named); everything that stops
 * the run is in `blockers` or decided by the gate (code a mode's tips reach that can't be read
 * included: `missingObjects`).
 */
export async function inspect(c: PrivateWriteContext, session: PrivateSession, opts: InspectOptions): Promise<Inspection> {
  const { sdk } = c
  const progress = opts.onProgress ?? (() => undefined)
  const step = (what: string): void => {
    opts.signal?.throwIfAborted()
    progress(what)
  }
  const label = opts.label ?? `${c.repo.ownerId}/${c.repo.name}`
  const view = { ...privateViewOf(c.repo), session }
  const res = session.resolution
  const blockers: MakePublicError[] = []
  const notes: string[] = []
  const { conversion, mode } = opts
  step('Checking the keys')
  // the network: the live contracts keep a repository's visibility as created
  if (conversion === null && !(await contractVisibilityOneWay(sdk, c.repo.forge.core))) blockers.push(new MakePublicError(COPY.frozen, 'E103'))
  if (res.currentEpoch === null || !res.keys.has(res.currentEpoch)) blockers.push(new MakePublicError(COPY.notKeyHolder, 'E307'))
  if (res.repair !== null && (res.repair.rotate || res.repair.missingWraps.length > 0)) blockers.push(new MakePublicError(COPY.repairFirst, 'E310'))
  const sealOff = cutoffOf(opts.below, conversion?.sealOffEpoch)
  const published = sealOff ?? (res.currentEpoch === null ? 0 : res.currentEpoch + 1)
  for (let e = 0; e < published; e++) {
    if (res.anchors.has(e) && !res.keys.has(e)) {
      notes.push(COPY.unreadableHistory)
      break
    }
  }
  // the private era's refs and settings
  step('Reading the branches and tags')
  const rows = await refRows(sdk, view)
  const allRefs: MakePublicRef[] = []
  let deleted = 0
  for (const r of await privateEraRefs(session, rows, sealOff)) {
    const tip = refTip(r)
    if (tip !== null) allRefs.push({ name: r.refName, oid: tip })
    else if (r.state.state === 'unborn') deleted++
  }
  const flat = [...rows.values()].flat().filter((d) => d['vis'] === 'private' && sealedBelow(d, sealOff))
  const forced = flat.filter((d) => d['force'] === true).length
  // a narrower branch's updates (enc v0x06) carry a name hash per key generation: counted by it
  const narrowerBranches = new Set(flat.filter((d) => bytesField(d, 'enc')?.[0] === V6).map((d) => (bytesField(d, 'refNameHash') ?? new Uint8Array()).join(','))).size
  const config = session.config
  const defaultBranch = shortRef(config?.defaultBranch ?? 'main')
  if (conversion === null && opts.below === undefined) {
    const active = await readSessionSealOff(session, decodeIdentifier(c.repo.ownerId))
    try {
      await drySealOffAnchor(decodeIdentifier(c.repo.repoId), decodeIdentifier(c.repo.ownerId), {
        defaultBranch: config?.defaultBranch ?? 'main', protectedPatterns: config?.protectedPatterns ?? [],
        backend: session.configPlain?.backend ?? { mode: 0 }, archived: session.configPlain?.archived ?? false,
      }, { mode: mode ?? 'codeOnly', conversionId: new Uint8Array(16), boundaryEpoch: (res.currentEpoch ?? 0) + 1, startedAtMs: 0n,
        ...(active.kind === 'active' ? { replacesEpoch: active.highestEpoch } : {}) })
    } catch (e) {
      if (e instanceof TooLargeError) blockers.push(new MakePublicError(COPY.markerSize, 'E310'))
      else throw e
    }
  }
  // the work store: every private-era pack this member opens
  step('Reading the code written while private')
  const { packs, unfetched } = await openPrivateEraPacks(sdk, session, c.repo, opts.packCache, sealOff)
  const store = await workStoreOf(packs, label)
  const sorted = byName(allRefs)
  // Code only: the refs the owner chose, the refs named, or the default branch and its tags
  let codeRefs: MakePublicRef[]
  if (opts.chosen !== undefined) {
    // a recorded choice holds only what the refs were before the boundary
    const within = await withinBoundary(opts.chosen, sorted, (a, b) => isAncestorIn(store, a, b))
    codeRefs = within.kept
    for (const name of within.dropped) notes.push(COPY.changedSince(shortRef(name)))
  }
  else if (opts.refs !== undefined && opts.refs.length > 0) codeRefs = namedCodeRefs(sorted, opts.refs)
  else codeRefs = await defaultCodeRefs(sorted, `refs/heads/${defaultBranch}`, (tag, tip) => isAncestorIn(store, tag, tip))
  if (mode === 'codeOnly' && conversion === null && codeRefs.length === 0) blockers.push(new MakePublicError(COPY.noCode, 'E201'))
  // secrets in the code the mode publishes, and (Everything) in every object and every post
  step('Checking for secrets')
  const codeTips = codeRefs.map((r) => r.oid)
  const allTips = sorted.map((r) => r.oid)
  const codeSecrets = await scanObjects(store, codeTips, false, label)
  let census: MakePublicCensus | null = null
  let former: string[] = []
  const everythingSecrets: MakePublicSecret[] = []
  if (mode !== 'codeOnly' || conversion === null) {
    step('Counting what Everything makes public')
    const read = await readCensus(sdk, c.repo, session, conversion?.markerHeight ?? null, sealOff)
    census = read.census
    const members = new Set([...session.members.map((m) => m.identity), c.repo.ownerId])
    former = census.authors.filter((a) => !members.has(a))
    everythingSecrets.push(...(await scanObjects(store, allTips, true, label)))
    for (const t of read.texts) for (const f of scanFile(t.place, new TextEncoder().encode(t.text))) everythingSecrets.push(secretOf(f))
  }
  // environments: E812 over every one still holding old-format values, or whose latest version
  // this member can't open (which values are marked changed is unknown then)
  step('Checking the environments')
  const book = await readEnvironments(sdkEnvSources(sdk, view), {
    repoId: decodeIdentifier(c.repo.repoId),
    members: { keys: res.keys, resolution: res },
    withReader: (use) => withLetterReader(c.network, c.auth.identityId, use),
    hasReader: true,
  })
  const environments = book.resolution.environments.length + book.resolution.hidden.length
  const oldFormat: string[] = []
  for (const e of book.resolution.environments) {
    const old = oldFormatOf(book, e.env)
    if (old === null) continue
    const head = e.heads[e.heads.length - 1]
    const headOpens = head !== undefined && snapshotOf(book, head) !== null
    if (needsAttention(old) || !headOpens) oldFormat.push(e.env)
  }
  const named = new Set(book.resolution.environments.flatMap((e) => e.snapshots))
  const oldFormatUnreadable = [...book.oldFormat].some((id) => !named.has(id))
  // the fresh pack of each mode, and the cost
  step('Working out the cost')
  // what a mode's tips reach and this member can't read stops that mode (the gate), never the check
  const sizes: EntrySizes = new Map()
  const walk = async (tips: readonly string[]): Promise<{ size: { bytes: number; objects: number }; missing: number }> => {
    const missing = new Set<string>()
    const reached = await reachable(store, tips, { label, skipMissing: true, onMissing: (o) => missing.add(o) })
    return { size: await packSize(store, reached.keys(), sizes), missing: missing.size }
  }
  const code = await walk(codeTips)
  const all = await walk(allTips)
  const [codeSize, allSize] = [code.size, all.size]
  const base = { private: conversion === null, marked: conversion?.markerHeight != null, rotationCredits: rotationCredits(c, session), readableEpochs: res.keys.size }
  const check: MakePublicCheck = {
    ...(sealOff !== undefined ? { publicationCutoff: sealOff } : {}),
    blockers: blockers.map((b) => b.message),
    notes,
    allRefs: sorted,
    codeRefs,
    deleted,
    forced,
    census,
    former,
    codeSecrets,
    everythingSecrets,
    environments,
    oldFormat,
    oldFormatUnreadable,
    unfetched,
    missingObjects: { codeOnly: code.missing, everything: all.missing },
    size: { codeOnly: codeSize, everything: allSize },
    estimate: {
      codeOnly: estimateMakePublic({ ...base, mode: 'codeOnly', size: codeSize, refs: codeRefs.length }),
      everything: estimateMakePublic({ ...base, mode: 'everything', size: allSize, refs: sorted.length }),
    },
    narrowerBranches,
    minClientVersion: CONVERTED_REPO_MIN_CLIENT_VERSION,
    defaultBranch,
  }
  return { check, blockers, store, config, currentEpoch: res.currentEpoch }
}

/**
 * The check of making `c.repo` public (step 0), read without signing: the keys, what becomes
 * public in each mode (`mode` narrows the census to what that mode reads, as dg's does), the secret
 * scans, the environments, what stays private and the cost. `refs`: Code only's branches and tags
 * by name (default: the default branch and the tags on it, or this browser's record of a run under
 * way in that mode). Takes from seconds to minutes: it downloads and opens every pack written while
 * private. `signal` stops it between phases. `label`: how the copy names the repo (`o/r`).
 * `packCache`: the same map across checks of one dialog (a changed choice of refs re-checks).
 */
export async function makePublicCheck(
  c: PrivateWriteContext,
  opts: {
    mode?: MakePublicMode
    refs?: readonly string[]
    signal?: AbortSignal
    onProgress?: (what: string) => void
    label?: string
    /** Packs a check before this one opened: passed again, a re-check fetches only new ones. */
    packCache?: PackCache
  } = {},
): Promise<MakePublicCheck> {
  const visibility = await readVisibility(c.sdk, c.repo)
  const record = await loadMakePublicRecord(c.network, c.auth.identityId, c.repo.repoId)
  const chosen = record !== null && opts.mode !== undefined && record.mode === opts.mode && (opts.refs ?? []).length === 0 ? refsOfRecord(record) : undefined
  const session = await privateSessionFor(c)
  try {
    const r = session.resolution
    const conversion = visibility === 'public' ? await readConversion(c.sdk, c.repo, (e) => r.anchors.has(e)) : null
    if (visibility === 'public' && conversion === null) throw new MakePublicError(COPY.publicAlready, 'E201')
    // the run's cutoff (`make-public-run.ts`): the lower of the stated and recorded seal-off epochs
    // once public; while private, the recorded one while it is still the current epoch (one that
    // landed unrecorded found again)
    const active = await readSessionSealOff(session, decodeIdentifier(c.repo.ownerId))
    if (active.kind === 'unknown') throw new MakePublicError(COPY.markerUnreadable, 'E310')
    const recorded = recordedSealOff(record?.sealOff ?? null, record?.sealOffFrom, r.currentEpoch, r.burned, active)
    const below = conversion !== null ? cutoffOf(conversion.sealOffEpoch, recorded) : recorded !== null && recorded === session.resolution.currentEpoch ? recorded : undefined
    const { check } = await inspect(c, session, {
      conversion,
      ...(below !== undefined ? { below } : {}),
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      ...(opts.refs !== undefined ? { refs: opts.refs } : {}),
      ...(chosen !== undefined ? { chosen } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(opts.packCache !== undefined ? { packCache: opts.packCache } : {}),
    })
    return check
  } finally {
    session.close()
  }
}
