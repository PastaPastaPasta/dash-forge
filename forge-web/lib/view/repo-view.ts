/**
 * Repo home view-model (view glue) — composes the reads a repo page needs into one shape.
 *
 * The cold home view is size-independent: resolve the repo (its forge-core `repo` document),
 * read its current config + default branch, resolve refs, and read the
 * O(1) star count. The root tree / README ride the browse plane (locator) and are loaded
 * separately so the header can paint immediately.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { hexToBase64 } from '../sdk'
import {
  branchesOf,
  configBundleOf,
  publicRefKey,
  readConfigBundle,
  readRefs,
  readRepoChrome,
  readStarCount,
  refsFromRows,
  resolveAnyRepo,
  resolveOwner,
  repoKey,
  tagsOf,
  type ChromeTimelines,
  type RepoAddressParams,
  type RepoChrome,
  type RepoConfig,
  type RepoRef,
  type RepoTimelines,
  type ResolvedRef,
  type RepoDoc,
} from '../repo'
import { normalizeRepoName } from '../rules/v2'
import { seedFromDomains } from './dpns'
import { noteRepoGateways } from './storage-status'
import type { PrivateSession } from '../repo/private-session'

/** Backend descriptor for the repo header badge / clone box. */
export interface BackendInfo {
  readonly mode: number
  /** Where the pack bytes live, by the config's backend mode; the badge shows it and draws its icons from it. */
  readonly kind: 'platform' | 'ipfs' | 's3' | 'https' | 'mixed'
  readonly uris: readonly string[]
}

/** `backendMode` 0..4, in order; any other mode reads as Platform. */
const BACKEND_KINDS = ['platform', 'ipfs', 's3', 'https', 'mixed'] as const

/** Describe a repo backend from its config for the badge + clone box. */
export function backendInfo(config: RepoConfig | null): BackendInfo {
  const mode = config?.backendMode ?? 0
  return { mode, kind: BACKEND_KINDS[mode] ?? 'platform', uris: config?.backendUris ?? [] }
}

/** Everything the repo header + rail render (excludes browse-plane tree/README). */
export interface RepoHome {
  readonly repo: RepoRef
  /** The `repo` document (description, display name, topics, fork). */
  readonly v2: RepoDoc
  /** The repo description (the `repo` document's). */
  readonly description: string
  readonly config: RepoConfig | null
  readonly defaultBranch: string
  readonly branches: readonly ResolvedRef[]
  readonly tags: readonly ResolvedRef[]
  /** `null` when the count read failed — rendered as unknown, never as a false 0. */
  readonly starCount: number | null
  readonly backend: BackendInfo
  /** A private repo: how this viewer reads it (set by the repo scaffold). */
  readonly private?: PrivateAccess
  /**
   * A public repo with members-only content, read by a signed-in member: how they read it (set by
   * the repo scaffold; absent for everyone else). With `member`, `repo.lane` holds the session.
   */
  readonly lane?: MembersAccess
  /**
   * A signed-in viewer's members access is still being read (a public repo): what the page says
   * to a reader who can't open members-only content waits, so a member never sees an outsider's
   * text first.
   */
  readonly laneLoading?: true
  /**
   * `branches` holds only the default branch and `tags` nothing: a home read for a page that
   * shows no other ref (an issue or PR list, {@link RepoHomeRefs}). A page that lists refs reads
   * its own home.
   */
  readonly refsPartial?: true
}

/**
 * Which refs a home resolves: `all` (every branch and tag), or `default` (the default branch
 * alone, when the repo's ref updates are past one page: the issue and PR lists, which show no
 * other ref, then skip reading the whole history, 8 requests on the dash mirror).
 */
export type RepoHomeRefs = 'all' | 'default'

/**
 * How the viewer reads a private repo: `signed-out` and `outsider` see only what is public
 * (`ux-dx-spec.md` §6.3), `no-key` is a member whose browser holds no encryption key yet,
 * `locked` a member whose tab resumed a signing-only session (unlock to read), and
 * `member` reads through its decryption session (`repo.session`).
 */
export type PrivateAccess =
  | { readonly access: 'signed-out' | 'outsider' | 'no-key' | 'locked' }
  | { readonly access: 'member'; readonly session: PrivateSession }

/**
 * How a signed-in member reads a public repo's members-only content: `none`, it has none (nobody
 * turned it on); `no-key`, their browser holds no encryption key; `locked`, the tab resumed
 * signing-only; `no-key-shared`, no maintainer has shared the key with them yet (E311, a member
 * added by an older client: a maintainer's Repair shares it); `member`, they read it through
 * their members-key session (`repo.lane`); `former`, a member removed since who still holds key
 * shares of earlier epochs: they read what was written under those (DESIGN §12 item 6, as `dg`),
 * through the same session, and write nothing members-only. Never changes the public config,
 * branches or packs.
 */
export type MembersAccess =
  | { readonly access: 'none' | 'no-key' | 'locked' | 'no-key-shared' }
  | { readonly access: 'member' | 'former'; readonly session: PrivateSession }

/**
 * A member's view of a public repo's members-only content: the plain {@link RepoHome} with the
 * members-key session on `repo.lane` (only the content gate reads it). Its config, default
 * branch, branches, tags and backend are the public ones, untouched (DESIGN §4.1 acceptance).
 */
export function withMembersSession(home: RepoHome, session: PrivateSession, access: 'member' | 'former' = 'member'): RepoHome {
  return { ...home, repo: { ...home.repo, lane: session }, lane: { access, session } }
}

/**
 * A member's view of a private repo: the plain {@link RepoHome} re-read through `session` (the
 * decrypted config timeline, refs grouped by their decrypted names). Lives in memory only.
 */
export async function loadPrivateHome(sdk: EvoSDK, home: RepoHome, session: PrivateSession): Promise<RepoHome> {
  const repo: RepoRef = { ...home.repo, session }
  const refs = await readRefs(sdk, repo, undefined, Promise.resolve(session.configHistory))
  const config = session.config ?? home.config
  return {
    ...home,
    repo,
    config,
    defaultBranch: session.config?.defaultBranch ?? 'main',
    branches: branchesOf(refs),
    tags: tagsOf(refs),
    backend: backendInfo(config),
    private: { access: 'member', session },
  }
}

/**
 * Resolve + compose a repo home view-model from its route address (`owner`, `name`, and an
 * optional `?repo=` pin). Returns null if nothing resolves. `onResolved` is told the repo as
 * soon as its document is read, before the refs: a code page starts its browse index then, so
 * the two run side by side instead of one after the other (L-15).
 */
export async function loadRepoHome(
  sdk: EvoSDK,
  params: RepoAddressParams & { readonly network: Network },
  onResolved?: (repo: RepoRef) => void,
  { refs = 'all' }: { readonly refs?: RepoHomeRefs } = {},
): Promise<RepoHome | null> {
  // A repo addressed by `(owner, name)`: one composite resolves it and reads its chrome.
  const forge = NETWORKS[params.network].v2
  const name = params.repoId ? null : normalizeRepoName(params.name)
  if (forge !== null && name !== null) {
    const ownerId = await resolveOwner(sdk, params.owner)
    if (ownerId === null) return null
    const chrome = await readRepoChrome(sdk, forge, ownerId, name, params.network)
    if (chrome === null) return null
    seedFromDomains(params.network, [ownerId], chrome.ownerDomains)
    if (chrome.read !== null) {
      onResolved?.(chrome.repo)
      const listed = refs === 'default' && !chrome.read.whole ? await listHome(chrome, chrome.read) : null
      return listed ?? homeFromTimelines(chrome, await chrome.read.all())
    }
    return composeHome(sdk, chrome.repo, chrome.doc, onResolved, chrome.starCount)
  }
  const resolved = await resolveAnyRepo(sdk, params)
  if (resolved === null) return null
  return composeHome(sdk, resolved.repo, resolved.doc, onResolved)
}

/** A public repo's home from its chrome read and complete timelines (no further request). */
function homeFromTimelines(chrome: RepoChrome, timelines: RepoTimelines): RepoHome {
  const { config, history } = configBundleOf(chrome.repo, timelines.config)
  return homeOf(chrome, config, refsFromRows(chrome.repo, timelines.refUpdate, timelines.protectedRefUpdate, history))
}

/**
 * A public repo's home for a page that shows no ref but the default branch ({@link RepoHomeRefs}
 * `default`), without reading on the timelines it does not need (the pack list): the config, and
 * every ref when the composite held them whole, else the default branch alone, from that one ref's
 * history (one equality read per ref-update type whose page came back full), not every ref's. Null
 * when the default branch does not resolve (an empty repo, a fork whose default was never pushed):
 * the full home decides what to show then.
 */
async function listHome(chrome: RepoChrome, read: ChromeTimelines): Promise<RepoHome | null> {
  const { config, history } = configBundleOf(chrome.repo, await read.config())
  if (read.refsWhole) {
    const rows = await read.refs()
    return homeOf(chrome, config, refsFromRows(chrome.repo, rows.refUpdate, rows.protectedRefUpdate, history))
  }
  const refName = `refs/heads/${config?.defaultBranch ?? chrome.doc.defaultBranch ?? 'main'}`
  const rows = await read.ref(hexToBase64(publicRefKey(refName)))
  const branch = refsFromRows(chrome.repo, rows.refUpdate, rows.protectedRefUpdate, history).find((r) => r.refName === refName)
  if (branch === undefined || branch.state.state === 'unborn') return null
  return { ...homeOf(chrome, config, [branch]), refsPartial: true }
}

function homeOf(chrome: RepoChrome, config: RepoConfig | null, refs: readonly ResolvedRef[]): RepoHome {
  const { repo, doc: v2 } = chrome
  noteRepoGateways(repoKey(repo), 'config', config?.backendUris ?? [])
  return {
    repo,
    v2,
    description: v2.description,
    config,
    defaultBranch: config?.defaultBranch ?? v2.defaultBranch ?? 'main',
    branches: branchesOf(refs),
    tags: tagsOf(refs),
    starCount: chrome.starCount,
    backend: backendInfo(config),
  }
}

/** The home of a resolved repo, read with plain queries (a private repo, or one pinned by `?repo=`). */
async function composeHome(
  sdk: EvoSDK,
  repo: RepoRef,
  v2: RepoDoc,
  onResolved?: (repo: RepoRef) => void,
  knownStars?: number,
): Promise<RepoHome> {
  onResolved?.(repo)

  // One config query serves both the current config and the history readRefs folds with. The
  // public gateway the owner advertises (`config.backend.uris`, `https://<gw>/ipfs/`) reaches the
  // node holding this repo's IPFS content: noted the moment the config lands, so a browse index
  // prefetched alongside (`onResolved`) tries it first too.
  const bundlePromise = readConfigBundle(sdk, repo).then((bundle) => {
    noteRepoGateways(repoKey(repo), 'config', bundle.config?.backendUris ?? [])
    return bundle
  })
  const [{ config }, refs, starCount] = await Promise.all([
    bundlePromise,
    readRefs(sdk, repo, undefined, bundlePromise.then((b) => b.history)),
    knownStars ?? readStarCount(sdk, repo.forge, repo.repoId).catch(() => null),
  ])
  return {
    repo,
    v2,
    description: v2.description,
    config,
    defaultBranch: config?.defaultBranch ?? v2.defaultBranch ?? 'main',
    branches: branchesOf(refs),
    tags: tagsOf(refs),
    starCount,
    backend: backendInfo(config),
  }
}
