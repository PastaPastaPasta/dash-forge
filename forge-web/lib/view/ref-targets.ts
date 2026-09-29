/**
 * Where an autolinked reference in Markdown goes (FG-2: L-38, L-39, L-40, L-51, L-67).
 *
 * Content copied from another forge (an imported issue, comment, review, a mirror's release
 * notes and commit messages) speaks that forge's language: `@bob` is bob's account there,
 * and `other/repo#12` is that forge's repo. Linking such a mention to the Forge profile of
 * whoever registered the DPNS label `bob` would let anyone impersonate every imported author,
 * so imported mentions go to the source forge instead. Content written here (native) keeps
 * Forge's meaning: `@alice` is a DPNS name and `owner/name#12` a Forge repo.
 *
 * A repo's own references (`#12`, a bare commit id, and `owner/name#12` naming the repo a
 * mirror copies) stay here whatever the content's origin: the mirror holds those items.
 */

import type { RefPiece, RefRepo } from './markdown'

/** A forge and a repository path on it: `github.com` + `dashpay/dash`. */
export interface ForgeRepo {
  readonly host: string
  readonly path: string
}

export interface RefContext {
  /** The repository this repo mirrors (its owner-written description names it), or null. */
  readonly source: ForgeRepo | null
  /**
   * The forge the content was copied from (its host), or null for content written here. Only
   * github.com, gitlab.com and the repo's own source host are believed ({@link importedHost}).
   */
  readonly imported: string | null
}

export type RefTarget =
  /** Issue or PR `n` of this repo (`repo` null) or of another Forge repo. `upstream`: the number is the source forge's (imported content). */
  | { readonly kind: 'number'; readonly repo: RefRepo | null; readonly n: number; readonly upstream: boolean }
  /** A commit of this repo (`repo` null) or of another Forge repo. */
  | { readonly kind: 'commit'; readonly repo: RefRepo | null; readonly oid: string }
  /** A Forge profile (a DPNS name). */
  | { readonly kind: 'profile'; readonly name: string }
  /** A page on another forge. */
  | { readonly kind: 'external'; readonly url: string }

const GITHUB = 'github.com'

/**
 * The forge an imported document's `imported.url` names, when it is one whose URLs the
 * renderer may build: github.com, gitlab.com, or the repo's own (described) source host. Null
 * for native content, or a URL that is not https or names another host (anyone may write an
 * `imported` record, so it never sends links to an arbitrary host).
 */
export function importedHost(importedUrl: string | null | undefined, source: ForgeRepo | null): string | null {
  if (!importedUrl) return null
  let url: URL
  try {
    url = new URL(importedUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
  const host = url.host.toLowerCase()
  return host === GITHUB || host === 'gitlab.com' || host === source?.host ? host : null
}

/** The `imported.url` of an `imported` provenance object, or ''. */
export function importedUrlOf(raw: unknown): string {
  const url = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['url'] : undefined
  return typeof url === 'string' ? url : ''
}

/** `https://<host>/<path>/<kind>/<id>` in the source forge's URL layout (GitHub's `issues/N` redirects to `pull/N`). */
function forgeUrl(host: string, path: string, kind: 'issue' | 'commit', id: string): string {
  const seg = kind === 'issue' ? 'issues' : 'commit'
  return host === GITHUB ? `https://${host}/${path}/${seg}/${id}` : `https://${host}/${path}/-/${seg}/${id}`
}

/** A user's page on `host` (GitHub apps: `/apps/<name>`). */
function userUrl(host: string, login: string, bot: boolean): string {
  return host === GITHUB && bot ? `https://${host}/apps/${login}` : `https://${host}/${login}`
}

/** The upstream page of this repo's item `n` (a mirror's source), or null when it mirrors nothing. */
export function upstreamItemUrl(source: ForgeRepo | null, n: number): string | null {
  return source === null ? null : forgeUrl(source.host, source.path, 'issue', String(n))
}

/** Where `piece` links, or null for text (a `[bot]` mention in native content: a GitHub app, no Forge profile). */
export function refTarget(piece: Exclude<RefPiece, { t: 'text' }>, ctx: RefContext): RefTarget | null {
  const { imported, source } = ctx
  if (piece.t === 'mention') {
    if (imported !== null) return { kind: 'external', url: userUrl(imported, piece.label, piece.bot === true) }
    return piece.bot ? null : { kind: 'profile', name: piece.name }
  }
  // `owner/name` naming the repo this one mirrors is this repo.
  const named = piece.repo === undefined ? '' : `${piece.repo.owner}/${piece.repo.name}`
  const repo = named === '' || named.toLowerCase() === source?.path.toLowerCase() ? null : (piece.repo as RefRepo)
  const [kind, id] = piece.t === 'ref' ? (['issue', String(piece.n)] as const) : (['commit', piece.oid] as const)
  // Another repo named in imported content is that forge's repo.
  if (repo !== null && imported !== null) return { kind: 'external', url: forgeUrl(imported, named, kind, id) }
  return piece.t === 'ref' ? { kind: 'number', repo, n: piece.n, upstream: imported !== null && repo === null } : { kind: 'commit', repo, oid: piece.oid }
}
