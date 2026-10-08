/**
 * A private repo as one reader sees it (`docs/security/private-repos.md` §5, §8): memberships,
 * every `config` and `repoKey`, the reader's own wraps unwrapped, `resolveEpochs`, and the
 * decrypted config timeline. Everything a private read needs hangs off a {@link PrivateSession}:
 * the content gate (`openContent` over the reader's keys), the pack header cache, the keys.
 *
 * Lifetime: one session per (network, repo, reader) is cached for the view session
 * (`SESSION_TTL_MS`); writers call {@link loadPrivateSessionUncached} before every write (§5.3: anchors are re-read before every
 * write). Every session closes when the vault locks or the encryption key changes: its gate
 * then admits nothing, its header cache is cleared, and listeners purge the decrypted browse
 * state built on it. No key and no decrypted string is persisted anywhere.
 */

import type { EvoSDK, IdentityPublicKey } from '@dashevo/evo-sdk'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import type { EncKeyLike, EncryptionOps } from '../auth/encryption-key'
import { fetchIdentityKeys, isUsableEncryptionKey, walletRegistered } from '../auth/encryption-key'
import { onEncryptionKeyChange } from '../auth/vault'
import type { Network } from '../constants'
import {
  IdSet,
  PackHeaderCache,
  bytesEqual,
  bytesToHex,
  isU32,
  randomBytes,
  openContextOf,
  resolveEpochs,
  type ConfigRow,
  type EpochKeys,
  type EpochResolution,
  type OpenContext,
  type WrapRow,
  WrapError,
} from '../private'
import { compareKey, type ConfigDoc, type RefUpdate } from '../rules'
import type { Membership, Role } from '../rules/v2'
import { queryAllDocuments, type PlainDocument } from '../sdk'
import { DOC, asIdentifierString, num, str, stringArray, type RepoRef } from './contract'
import type { RepoConfig } from './config'
import { readMemberships } from './members'
import { holdsMembersKey } from '../rules/roles'
import {
  admitAll,
  blockHeightOf,
  bytesField,
  defaultGate,
  idField,
  sessionGate,
  type ContentGate,
} from './private-content'
import { clearMembersTexts, noteOpenedDoc } from './members-texts'
import { repoSource } from './source'

/** How long a session serves page views before it is read again. */
const SESSION_TTL_MS = 5 * 60_000

/** A `repoKey` document, parsed, with the raw document (the SDK needs it to decrypt). */
export interface WrapDoc {
  readonly row: WrapRow
  readonly senderKeyId: number
  readonly createdAt: number
  readonly raw: PlainDocument
}

/** What the session shows about an epoch's anchor (§9: "rotated 2 d ago by alice"). */
export interface AnchorInfo {
  readonly epoch: number
  /** base58 identity. */
  readonly owner: string
  readonly createdAt: number
  readonly height: number
}

export interface PrivateSession {
  /** Random per session: the browse caches key decrypted state by it. */
  readonly id: string
  readonly network: Network
  readonly repoId: Uint8Array
  /** The reader, base58. */
  readonly reader: string
  readonly resolution: EpochResolution
  readonly ctx: OpenContext
  readonly gate: ContentGate
  readonly headerCache: PackHeaderCache
  readonly members: readonly Membership[]
  /** Every parsed `repoKey` of the repo. */
  readonly wraps: readonly WrapDoc[]
  /** The newest readable config, as {@link RepoConfig} (`defaultBranch` a short name). */
  readonly config: RepoConfig | null
  /**
   * The plaintext fields of the newest readable config, which a rotation anchor repeats as-is
   * (`backend`, `archived`), or null when none opens.
   */
  readonly configPlain: { readonly backend: unknown; readonly archived: boolean } | null
  /** The readable configs, for protected-ref routing. */
  readonly configHistory: readonly ConfigDoc[]
  readonly anchors: ReadonlyMap<number, AnchorInfo>
  /** Every `config` of the repo (anchor what-ifs: who would anchor an epoch without someone). */
  readonly configRows: readonly ConfigRow[]
  /** `repoKey` and `config` documents under an epoch no anchor recognises. */
  readonly unanchoredDocs: number
  /** Public keys of the members, by base58 identity (null: the identity could not be read). */
  readonly memberKeys: ReadonlyMap<string, readonly EncKeyLike[] | null>
  /** Pack manifests (`$id`) found uploaded under an old key (§8.2), shown to maintainers. */
  readonly suspectManifests: Set<string>
  /**
   * The reader holds encryption keys, but none of the keys its wraps here went to: the newest
   * wrap's key id, and whether a wallet approval registered that key (DESIGN D27: each first
   * approval for another contract registers one). Absent when a held key opens a wrap here.
   */
  readonly missingKey?: { readonly keyId: number; readonly otherApproval: boolean } | null
  /** Whether the session is closed (vault locked, key changed). */
  readonly closed: boolean
  /** End this session now (its keys and caches are dropped; its gate admits nothing). */
  close(): void
  /** When it was loaded (ms). */
  readonly loadedAt: number
  /** The repo's ref history, decrypted (see `refs.ts`), read once per session. */
  refUpdates(read: () => Promise<Map<string, RefUpdate[]>>): Promise<Map<string, RefUpdate[]>>
}

/** Reads the session needs; the SDK adapter is {@link sdkSessionSource}. */
export interface SessionSource {
  memberships(): Promise<Membership[]>
  configs(): Promise<PlainDocument[]>
  repoKeys(): Promise<PlainDocument[]>
  /** An identity's public keys, or null when it could not be read. */
  identityKeys(identityId: string): Promise<readonly EncKeyLike[] | null>
}

/** The reader's side: decrypt one of its wraps (the vault's {@link EncryptionOps} in production). */
export interface SessionUnwrapper {
  /** The id of the encryption key the reader holds (its newest, when it holds several). */
  readonly keyId: number
  /** Every key id the reader holds (default: {@link keyId} alone); a wrap to any of them is opened. */
  readonly keyIds?: readonly number[]
  unwrap(p: { document: PlainDocument; counterpartyKey: EncKeyLike; repoId: Uint8Array; epoch: number }): Promise<EpochKeys>
}

/** Whether `identity` (base58) is a current maintainer in `session`. */
export function isMaintainer(session: PrivateSession, identity: string | null): boolean {
  return identity !== null && session.members.some((m) => m.identity === identity && m.role === 'maintainer')
}

/** The reader side of the vault's {@link EncryptionOps}. */
export function sessionUnwrapper(ops: EncryptionOps): SessionUnwrapper {
  return {
    keyId: ops.keyId,
    keyIds: ops.keyIds,
    unwrap: (p) =>
      ops.unwrap({ document: p.document, counterpartyKey: p.counterpartyKey as unknown as IdentityPublicKey, repoId: p.repoId, epoch: p.epoch }),
  }
}

/** Parse a `repoKey` document; null when a field the reader rule needs is missing. */
export function parseWrapDoc(doc: PlainDocument): Omit<WrapDoc, 'row'> & { row: Omit<WrapRow, 'keyEnabled' | 'keys'> } | null {
  const id = idField(doc, '$id')
  const owner = idField(doc, '$ownerId')
  const memberId = idField(doc, 'memberId')
  const epoch = num(doc, 'epoch')
  if (id === undefined || owner === undefined || memberId === undefined || doc['epoch'] == null || !isU32(epoch)) return null
  return {
    row: { id, owner, memberId, epoch, recipientKeyId: num(doc, 'recipientKeyId') },
    senderKeyId: num(doc, 'senderKeyId'),
    createdAt: num(doc, '$createdAt'),
    raw: doc,
  }
}

/**
 * A `config` document as a {@link ConfigRow}; null for one with no `epoch`, block height or `enc`
 * (never an anchor: it states no key, §5.3; forge-core `config_row`).
 */
export function parseConfigRow(doc: PlainDocument): ConfigRow | null {
  const id = idField(doc, '$id')
  const owner = idField(doc, '$ownerId')
  const height = blockHeightOf(doc)
  const enc = bytesField(doc, 'enc')
  if (id === undefined || owner === undefined || height === undefined || doc['epoch'] == null || enc === undefined || enc.length === 0) return null
  const createdAt = doc['$createdAt']
  return {
    id,
    owner,
    epoch: num(doc, 'epoch'),
    createdAtBlockHeight: height,
    enc,
    ...(typeof createdAt === 'number' ? { createdAt } : {}),
  }
}


/** The short branch name a config's `defaultBranch` holds (a leading `refs/heads/` is tolerated). */
export function shortBranch(name: string): string {
  return name.replace(/^refs\/heads\//, '')
}

/** The plaintext `backend` of a config document. */
function backendOf(doc: PlainDocument): { mode: number; uris: string[] } {
  const b = doc['backend']
  if (b === null || typeof b !== 'object') return { mode: 0, uris: [] }
  const o = b as Record<string, unknown>
  return {
    mode: typeof o['mode'] === 'number' ? o['mode'] : 0,
    uris: Array.isArray(o['uris']) ? o['uris'].filter((x): x is string => typeof x === 'string') : [],
  }
}

/** A readable (opened) config as the {@link RepoConfig} views read. */
function toPrivateRepoConfig(doc: PlainDocument): RepoConfig {
  const backend = backendOf(doc)
  const branch = typeof doc['defaultBranch'] === 'string' ? shortBranch(doc['defaultBranch']) : ''
  return {
    defaultBranch: branch === '' ? 'main' : branch,
    protectedPatterns: stringArray(doc, 'protectedPatterns') ?? [],
    archived: doc['archived'] === true,
    backendUris: backend.uris,
    backendMode: backend.mode,
  }
}

const liveSessions = new Set<{ close(): void }>()
const endListeners = new Set<(sessionId: string) => void>()

/**
 * Be told when any one session ends (lock, key change, TTL retirement, a write flow closing
 * its own): caches keyed `repoId#sessionId` drop that session's decrypted state.
 */
export function onPrivateSessionEnded(listener: (sessionId: string) => void): () => void {
  endListeners.add(listener)
  return () => {
    endListeners.delete(listener)
  }
}
/**
 * Bumped by every {@link closePrivateSessions}. A load that started before a close must not
 * outlive it: it checks the generation it started under before handing anything out.
 */
let closeGeneration = 0

/** The current close generation (callers holding decrypted state compare it before caching). */
export function privateSessionGeneration(): number {
  return closeGeneration
}
const closeListeners = new Set<() => void>()

/** Be told when every session closed (vault locked, encryption key changed). */
export function onPrivateSessionsClosed(listener: () => void): () => void {
  closeListeners.add(listener)
  return () => {
    closeListeners.delete(listener)
  }
}

/** Close every session (their gates admit nothing from now on) and drop the session cache. */
export function closePrivateSessions(): void {
  closeGeneration += 1
  for (const s of liveSessions) s.close()
  liveSessions.clear()
  sessionCache.clear()
  // The members-only text this tab opened goes with the sessions that opened it.
  clearMembersTexts()
  for (const l of closeListeners) l()
}

// The vault locking or the encryption key changing ends every session.
onEncryptionKeyChange(closePrivateSessions)

function randomId(): string {
  return bytesToHex(randomBytes(12))
}

/**
 * Load a session from `source` for `reader` (§5.3–§5.6): memberships, configs and wraps; the
 * reader's wraps from current maintainers unwrapped (counterparty: the sender's `senderKeyId`
 * key, the reader's own for a self-wrap); `resolveEpochs`; then every config opened through the
 * gate for the timeline. `unwrapper` null: a member whose browser holds no encryption key (every
 * epoch unreadable, alerts and repair still computed).
 */
export async function loadPrivateSession(input: {
  readonly repo: RepoRef
  readonly network: Network
  readonly reader: string
  readonly source: SessionSource
  readonly unwrapper: SessionUnwrapper | null
  /**
   * Memberships this writer has just deleted (`role` absent: every role of the identity), dropped
   * even if a lagging node still lists them: a rotation must never count a removed maintainer's
   * pre-posted anchor or wrap as current (§5.4 C1).
   */
  readonly drop?: readonly { readonly identity: string; readonly role?: Role }[]
}): Promise<PrivateSession> {
  const { repo, network, reader, source, unwrapper } = input
  const generation = closeGeneration
  const repoId = decodeIdentifier(repo.repoId)
  const readerId = decodeIdentifier(reader)
  const [read, configDocs, wrapDocs] = await Promise.all([source.memberships(), source.configs(), source.repoKeys()])
  const drop = input.drop ?? []
  const members = read.filter((m) => !drop.some((d) => d.identity === m.identity && (d.role === undefined || d.role === m.role)))
  const maintainers = new IdSet(members.filter((m) => m.role === 'maintainer').map((m) => decodeIdentifier(m.identity)))
  // Who the key is for: the roles that hold the members key (`holdsMembersKey`: every human role,
  // DESIGN §3.5; runners are never members).
  const keyHolders = members.filter((m) => holdsMembersKey(m.role))

  const memberIds = [...new Set(members.map((m) => m.identity))]
  const memberKeys = new Map<string, readonly EncKeyLike[] | null>(
    await Promise.all(memberIds.map(async (id) => [id, await source.identityKeys(id).catch(() => null)] as const)),
  )
  const keyOf = (identity: string, keyId: number): EncKeyLike | undefined => memberKeys.get(identity)?.find((k) => k.keyId === keyId)

  const parsed = wrapDocs.map(parseWrapDoc).filter((w): w is NonNullable<typeof w> => w !== null)
  const held = unwrapper === null ? [] : (unwrapper.keyIds ?? [unwrapper.keyId])
  /** The reader's own wraps from current maintainers (§5.4 checks 1–2). */
  const ownWrap = (w: (typeof parsed)[number]): boolean => bytesEqual(w.row.memberId, readerId) && maintainers.has(w.row.owner)
  const wraps: WrapDoc[] = await Promise.all(
    parsed.map(async (w) => {
      const memberB58 = base58Encode(w.row.memberId)
      const recipient = keyOf(memberB58, w.row.recipientKeyId)
      const keyEnabled = recipient !== undefined && isUsableEncryptionKey(recipient, repo.forge.core)
      let keys: EpochKeys | undefined
      // Only the reader's own wraps from current maintainers are opened (§5.4 checks 1–2); the
      // anchor check (5) is resolveEpochs'.
      if (unwrapper !== null && ownWrap(w) && held.includes(w.row.recipientKeyId)) {
        const sender = keyOf(base58Encode(w.row.owner), w.senderKeyId)
        if (sender !== undefined) {
          // Only a wrap that does not open is skipped (§5.4 check 4); a locked vault or an SDK
          // failure is an error, never a member "with no key".
          keys = await unwrapper.unwrap({ document: w.raw, counterpartyKey: sender, repoId, epoch: w.row.epoch }).catch((e: unknown) => {
            if (e instanceof WrapError) return undefined
            throw e
          })
        }
      }
      return { ...w, row: { ...w.row, keyEnabled, ...(keys !== undefined ? { keys } : {}) } }
    }),
  )

  // Wraps to this reader, none to a key its browser holds: say which key they need.
  const own = parsed.filter(ownWrap)
  let missingKey: PrivateSession['missingKey'] = null
  if (unwrapper !== null && own.length > 0 && !own.some((w) => held.includes(w.row.recipientKeyId))) {
    const newest = own.reduce((a, b) => (b.row.epoch > a.row.epoch ? b : a)).row.recipientKeyId
    missingKey = { keyId: newest, otherApproval: walletRegistered(memberKeys.get(reader) ?? [], newest) }
  }

  const configRows = configDocs.map(parseConfigRow).filter((c): c is ConfigRow => c !== null)
  const resolution = await resolveEpochs({
    repoId,
    reader: readerId,
    memberships: keyHolders.map((m) => ({ identity: decodeIdentifier(m.identity), role: m.role })),
    configs: configRows,
    wraps: wraps.map((w) => w.row),
  })
  const ctx = openContextOf(resolution)
  const gate = sessionGate(repo, ctx)

  // The config timeline: every config that opens (§4.2 commitment first), as plaintext. Configs
  // under epochs this reader holds no key for are not in it, so protected-ref routing cannot see
  // them; the ref updates of those epochs are unreadable to this reader anyway. A public repo's
  // members key carries no settings (DESIGN D1): its session has no config timeline at all, and
  // the public config stays the only settings.
  const { docs: opened } = repo.visibility === 'private' ? await admitAll(gate, 'config', configDocs) : { docs: [] as PlainDocument[] }
  const configHistory: ConfigDoc[] = opened.map((d) => ({
    id: str(d, '$id'),
    createdAt: num(d, '$createdAt'),
    protectedPatterns: stringArray(d, 'protectedPatterns') ?? [],
  }))
  const newest = opened.reduce<PlainDocument | undefined>(
    (best, d) =>
      best === undefined || compareKey({ id: str(d, '$id'), createdAt: num(d, '$createdAt') }, { id: str(best, '$id'), createdAt: num(best, '$createdAt') }) > 0 ? d : best,
    undefined,
  )

  const createdAtById = new Map(configDocs.map((d) => [asIdentifierString(d['$id']), num(d, '$createdAt')]))
  const anchors = new Map<number, AnchorInfo>()
  for (const [e, a] of resolution.anchors) {
    anchors.set(e, { epoch: e, owner: base58Encode(a.owner), createdAt: createdAtById.get(base58Encode(a.id)) ?? 0, height: a.height })
  }
  const unanchored = new Set(resolution.unanchored)
  const unanchoredDocs = [...configRows, ...wraps.map((w) => w.row)].filter((r) => unanchored.has(r.epoch)).length

  const closedGate: ContentGate =
    repo.visibility === 'private' ? { visibility: 'private', admit: async () => ({ ok: false, reason: 'wrongKey' }) } : defaultGate(repo)
  const headerCache = new PackHeaderCache()
  let refs: Promise<Map<string, RefUpdate[]>> | null = null
  let closed = false
  const session: PrivateSession = {
    id: randomId(),
    network,
    repoId,
    reader,
    resolution,
    ctx,
    gate: {
      visibility: repo.visibility,
      // A closed session admits nothing it would have opened: a sealed document is hidden, as for
      // a reader without keys (a public repo's plaintext still reads through the public rule).
      // A members-only document of a public repo it opens is remembered for this tab's public
      // composers (`members-texts.ts`), unless the session closed while it opened.
      admit: async (type, doc) => {
        if (closed) return closedGate.admit(type, doc)
        const r = await gate.admit(type, doc)
        if (r.ok && !closed) noteOpenedDoc(repo, r.doc)
        return r
      },
    },
    headerCache,
    members,
    wraps,
    config: newest === undefined ? null : toPrivateRepoConfig(newest),
    configPlain: newest === undefined ? null : { backend: newest['backend'] ?? { mode: 0 }, archived: newest['archived'] === true },
    configHistory,
    anchors,
    unanchoredDocs,
    missingKey,
    memberKeys,
    suspectManifests: new Set(),
    configRows,
    loadedAt: Date.now(),
    close: () => undefined,
    get closed() {
      return closed
    },
    refUpdates(read) {
      if (closed) return Promise.reject(new Error('this private-repo session has ended; reload'))
      if (refs === null) {
        const p = read()
        refs = p
        p.catch(() => {
          if (refs === p) refs = null
        })
      }
      return refs
    },
  }
  const handle = {
    close() {
      if (closed) return
      closed = true
      refs = null
      headerCache.clear()
      liveSessions.delete(handle)
      for (const l of endListeners) l(session.id)
    },
  }
  // The vault locked (or the key changed) while this loaded: it must not survive the close.
  if (generation !== closeGeneration) {
    handle.close()
    throw new Error('the vault locked while this private repo was opening; unlock to read it')
  }
  liveSessions.add(handle)
  session.close = () => handle.close()
  return session
}

// ---------------------------------------------------------------------------
// The SDK side
// ---------------------------------------------------------------------------

/** The session's reads over the SDK (complete, proof-verified). */
export function sdkSessionSource(sdk: EvoSDK, repo: RepoRef): SessionSource {
  const src = repoSource(repo)
  return {
    memberships: () => readMemberships(sdk, repo),
    configs: () => queryAllDocuments(sdk, src.repoQuery(DOC.config, { orderBy: [['$createdAt', 'asc']] })),
    repoKeys: () =>
      queryAllDocuments(
        sdk,
        src.repoQuery(DOC.repoKey, {
          orderBy: [
            ['repoId', 'asc'],
            ['memberId', 'asc'],
            ['epoch', 'asc'],
            ['$ownerId', 'asc'],
          ],
        }),
      ),
    identityKeys: (id) => fetchIdentityKeys(sdk, id),
  }
}

const sessionCache = new Map<string, { at: number; promise: Promise<PrivateSession>; session?: PrivateSession }>()

function cacheKey(network: Network, repo: RepoRef, reader: string): string {
  return `${network}:${repo.forge.core}:${repo.repoId}:${reader}`
}

/**
 * The reader's session for `repo`, from the view-session cache when fresh. `unwrapper` is the
 * vault's encryption ops (null: no key in this browser).
 */
export function loadPrivateSessionCached(
  sdk: EvoSDK,
  repo: RepoRef,
  network: Network,
  reader: string,
  unwrapper: SessionUnwrapper | null,
): Promise<PrivateSession> {
  const key = cacheKey(network, repo, reader)
  const hit = sessionCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < SESSION_TTL_MS && hit.session?.closed !== true) return hit.promise
  const promise = loadPrivateSession({ repo, network, reader, source: sdkSessionSource(sdk, repo), unwrapper })
  const entry: { at: number; promise: Promise<PrivateSession>; session?: PrivateSession } = { at: Date.now(), promise }
  sessionCache.set(key, entry)
  promise.then((s) => {
    entry.session = s
  }, () => undefined)
  // The session it replaces may still back the page for a moment: end it a little later.
  if (hit !== undefined) retire(hit.promise, promise)
  promise.catch(() => {
    if (sessionCache.get(key)?.promise === promise) sessionCache.delete(key)
  })
  return promise
}

/** How long a replaced session keeps working before it is closed (pages switch over meanwhile). */
const RETIRE_MS = 60_000

function retire(old: Promise<PrivateSession>, next: Promise<PrivateSession>): void {
  const end = (): void => {
    setTimeout(() => {
      old.then((s) => s.close(), () => undefined)
    }, RETIRE_MS)
  }
  next.then(end, end)
}

/**
 * A fresh, uncached session for a write (§5.3: anchors are re-read before every write). It never
 * replaces the session a page reads through; the caller closes it when done.
 */
export function loadPrivateSessionUncached(
  sdk: EvoSDK,
  repo: RepoRef,
  network: Network,
  reader: string,
  unwrapper: SessionUnwrapper | null,
  drop?: readonly { readonly identity: string; readonly role?: Role }[],
): Promise<PrivateSession> {
  return loadPrivateSession({ repo, network, reader, source: sdkSessionSource(sdk, repo), unwrapper, ...(drop ? { drop } : {}) })
}

/** Drop the cached session of a repo (after a membership or key change). */
export function invalidatePrivateSession(repo: RepoRef): void {
  for (const [key, entry] of [...sessionCache]) {
    if (!key.includes(`:${repo.repoId}:`)) continue
    sessionCache.delete(key)
    // Still backing a page for a moment; its keys go after that.
    setTimeout(() => {
      entry.promise.then((s) => s.close(), () => undefined)
    }, RETIRE_MS)
  }
}
