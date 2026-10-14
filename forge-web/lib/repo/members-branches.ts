/**
 * Members-only branches and tags of a public repo in the web (`docs/security/private-repos.md`
 * §19.3; mixed-visibility DESIGN §4.3, §10 "Branches"): what a member lists beside the public refs,
 * and what everyone else learns, which is only that some exist.
 *
 * A member folds the union of the public updates and the members-only ones their members-key
 * session opens ({@link membersUpdatesOf}); a name that folds to a live tip through a members-only
 * update is a members-only ref, listed with `audience: 'members'` and its real tip. Every verified
 * blind is learned into the session's {@link blindBook} on the way (a new PR from that branch
 * copies its tip's blind and salt). The public folds plaintext updates only (`refs.ts`), so a
 * members-only branch never becomes a public ref; outsiders get {@link membersOnlyRefsExist}, a
 * yes or no, never a number (DESIGN §10: "This repo also has members-only branches.").
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode } from '../auth/base58'
import { openContent } from '../private'
import type { ConfigDoc, IsAncestor, RefUpdate } from '../rules'
import { queryAllDocuments, type PlainDocument } from '../sdk'
import { repoTimelines } from './chrome'
import { configBundleOf, readConfigHistory } from './config'
import { DOC, type RepoRef } from './contract'
import { blindBook, type Introduced } from './members-blinds'
import { membersUpdatesOf, type RefAlert, type RefRows } from './members-refs'
import { bytesField } from './private-content'
import { onPrivateSessionsClosed, type PrivateSession } from './private-session'
import { publicRefKey, toResolvedRef, type ResolvedRef } from './refs'
import { repoSource } from './source'

/** A member's members-only refs of a public repo. */
export interface MembersRefs {
  /** Members-only branches (`refs/heads/*`), each with `audience: 'members'` and its real tip. */
  readonly branches: readonly ResolvedRef[]
  /** Members-only tags (`refs/tags/*`). */
  readonly tags: readonly ResolvedRef[]
  /** Members-only updates this reader could not open (another epoch, a narrower audience, malformed). */
  readonly unreadable: number
  /** Blinds that did not check, and members-only updates naming a live public branch (left out, D29). */
  readonly alerts: readonly RefAlert[]
  /** Each members-only ref's whole update history (real values), by full name: a PR's base tips. */
  readonly updates: ReadonlyMap<string, readonly RefUpdate[]>
}

/** Whether `doc` is a members-only ref update: sealed, under its own `vis: "public"` stamp (§19.3). */
export function isMembersOnlyRefRow(doc: PlainDocument): boolean {
  const enc = bytesField(doc, 'enc')
  return enc !== undefined && enc.length > 0 && doc['vis'] === 'public'
}

/** Whether any of `rows` is a members-only ref update: all an outsider learns about them (no count). */
export function membersOnlyRefsExist(rows: RefRows): boolean {
  return rows.refUpdate.some(isMembersOnlyRefRow) || rows.protectedRefUpdate.some(isMembersOnlyRefRow)
}

/**
 * Both ref-update types' complete rows of a public repo and its config timeline: the repo chrome
 * store's timelines (the home's own read of a moment ago), else each read here.
 */
async function readRefRows(sdk: EvoSDK, repo: RepoRef): Promise<{ readonly rows: RefRows; readonly configHistory: readonly ConfigDoc[] }> {
  const timelines = await repoTimelines(sdk, repo).catch(() => null)
  if (timelines !== null) {
    return {
      rows: { refUpdate: timelines.refUpdate, protectedRefUpdate: timelines.protectedRefUpdate },
      configHistory: configBundleOf(repo, timelines.config).history,
    }
  }
  const read = (type: string): Promise<PlainDocument[]> => queryAllDocuments(sdk, repoSource(repo).repoQuery(type, { orderBy: [['$createdAt', 'asc']] }))
  const [refUpdate, protectedRefUpdate, configHistory] = await Promise.all([read(DOC.refUpdate), read(DOC.protectedRefUpdate), readConfigHistory(sdk, repo)])
  return { rows: { refUpdate, protectedRefUpdate }, configHistory }
}

/** {@link membersRefsOf} of `repo` (a public repo) read now, through `lane`. */
export async function readMembersRefs(sdk: EvoSDK, repo: RepoRef, lane: PrivateSession): Promise<MembersRefs> {
  const { rows, configHistory } = await readRefRows(sdk, repo)
  return membersRefsOf(rows, lane, configHistory)
}

/**
 * The members-only refs of `rows`, read through `lane` (a member's members-key session): every
 * name whose union fold resolves through a members-only update, with its real tip. Names live in
 * public keep their public updates (D29) and are not listed here.
 */
export async function membersRefsOf(
  rows: RefRows,
  lane: PrivateSession,
  configHistory: readonly ConfigDoc[],
  isAncestor?: IsAncestor,
): Promise<MembersRefs> {
  const book = blindBook(lane.ctx)
  const members = new Set<string>()
  // Each opened update's verified blind and salt of its new tip, by document id.
  const pushed = new Map<string, Introduced>()
  const updates = await membersUpdatesOf(
    rows,
    async (stored) => {
      const opened = await openContent(stored, lane.ctx)
      if (opened.status === 'readable' && stored.newOid !== undefined) {
        const id = stored.id === undefined ? null : base58Encode(stored.id)
        if ((await book.learn(stored.newOid, opened.fields.newOid, opened.fields.oidSalt)) && id !== null) {
          pushed.set(id, { blind: new Uint8Array(stored.newOid), salt: new Uint8Array(opened.fields.oidSalt as Uint8Array) })
        }
        if (stored.prevOid !== undefined) await book.learn(stored.prevOid, opened.fields.prevOid, opened.fields.oidSalt)
        if (id !== null) members.add(id)
      }
      return opened
    },
    configHistory,
    isAncestor,
  )
  const branches: ResolvedRef[] = []
  const tags: ResolvedRef[] = []
  const histories = new Map<string, readonly RefUpdate[]>()
  const names = knownNames(lane.repoId)
  for (const [name, group] of updates.byName) {
    // only a name whose fold holds a members-only update (public names win, D29: theirs were dropped)
    if (!group.some((u) => members.has(u.id))) continue
    const ref = toResolvedRef(group, configHistory, publicRefKey(name), isAncestor ?? (() => false))
    if (ref === null || ref.state.state === 'unborn') continue
    names.add(name)
    histories.set(name, group)
    // rule C: a PR from this branch copies the blind of the newest members-only update that set its tip
    const tip = ref.state.state === 'resolved' ? ref.state.oid : null
    const setter = tip === null ? undefined : [...group].reverse().find((u) => u.newOid === tip && pushed.has(u.id))
    if (tip !== null && setter !== undefined) book.introduce(name, tip, pushed.get(setter.id) as Introduced)
    const listed: ResolvedRef = { ...ref, audience: 'members' }
    if (name.startsWith('refs/heads/')) branches.push(listed)
    else if (name.startsWith('refs/tags/')) tags.push(listed)
  }
  return { branches, tags, unreadable: updates.unreadable, alerts: updates.alerts, updates: histories }
}

/** The members-only ref names this tab's members-key sessions listed, by repo id (base58). */
const listedNames = new Map<string, Set<string>>()
// Decrypted names go with the sessions that read them (the vault locked, the key changed).
onPrivateSessionsClosed(() => listedNames.clear())

function knownNames(repoId: Uint8Array): Set<string> {
  const key = base58Encode(repoId)
  let names = listedNames.get(key)
  if (names === undefined) {
    names = new Set()
    listedNames.set(key, names)
  }
  return names
}

/**
 * Whether `refName` is a members-only branch or tag of the repo `repoId` (base58) that a member
 * listed in this tab. The web writes no members-only ref, and a public update of such a name
 * would make a public branch that wins over it (D29): `writeRefUpdate` refuses both.
 */
export function isListedMembersRef(repoId: string, refName: string): boolean {
  return listedNames.get(repoId)?.has(refName) === true
}
