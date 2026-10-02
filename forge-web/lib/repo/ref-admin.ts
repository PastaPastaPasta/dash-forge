/**
 * Branch and tag administration from the browser (P1-4): GitHub's "New branch" and delete on the
 * branches page, and "Create new tag on publish" in the release form. Each is one ref update and
 * no pack: the new ref names a commit the repo already stores (a branch's or tag's tip), and a
 * delete is the null oid (`forge-v2.md` §6, as `git push <remote> :<branch>` writes it).
 *
 * Who may (`forge-v2.md` §2.1 and §6): a `refUpdate` is admitted from a maintainer or a role-1
 * writer (`r` 1), never triage or a reader; a ref matching the repo's current protected patterns
 * goes to the maintainer-only `protectedRefUpdate` ({@link writeRefUpdate} routes it). The
 * pre-checks here refuse before signing what consensus would refuse, and two things GitHub
 * refuses that consensus would admit: deleting the default branch, and deleting a protected
 * branch (unprotect it first; a client rule, as on GitHub).
 *
 * A tag made here is a lightweight tag (a ref to the commit, as GitHub's release form makes one):
 * an annotated tag is a git object, pushed with git.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { isPlainBranchRef, isRc1RefName, isRc1TagName, matchesProtected, type RefState } from '../rules'
import { capabilitiesOf, roleLimit, whoCan } from '../rules/roles'
import type { Role } from '../rules/v2'
import { bytesToBase64, type WriteAuth } from '../sdk'
import { readConfigBundle } from './config'
import type { RepoRef } from './contract'
import { refTip } from './fork'
import { refNameHash, writeRefUpdate } from './push'
import { resolveRefByHash } from './refs'

export const BRANCH_PREFIX = 'refs/heads/'
export const TAG_PREFIX = 'refs/tags/'

/** The first protected pattern `refName` matches, or null. */
export function protectedBy(refName: string, patterns: readonly string[]): string | null {
  return patterns.find((p) => matchesProtected(refName, [p])) ?? null
}

/**
 * Why `name` cannot name a new branch, or null: a short name (`feature/x`) whose
 * `refs/heads/<name>` both consensus (`$defs.refName`, no `.lock`) and `git check-ref-format`
 * accept, with no `+` (a refspec) and no leading `-` (an option to git).
 */
export function branchNameProblem(name: string): string | null {
  if (name === '') return 'a branch name is needed'
  if (name.startsWith('refs/')) return 'give the short name (feature/x), without refs/heads/'
  if (name.startsWith('-')) return 'a branch name cannot start with -'
  if (name === 'HEAD') return 'HEAD is not a branch name'
  const refName = `${BRANCH_PREFIX}${name}`
  if (new TextEncoder().encode(refName).length > 255) return 'that branch name is too long'
  return isRc1RefName(refName) && isPlainBranchRef(refName) ? null : 'that is not a valid git branch name'
}

/** Why `tag` cannot name a new tag (a release's `tagName` grammar and git's), or null. */
export function newTagNameProblem(tag: string): string | null {
  const refName = `${TAG_PREFIX}${tag}`
  if (!isRc1TagName(tag) || tag.startsWith('-') || !isRc1RefName(refName)) return 'that is not a valid git tag name'
  return null
}

/**
 * Why a member of `role` cannot write the ref `refName` here, or null. `what` is the action
 * ("create branches", "delete it"): triage and readers cannot push (`r` 1 only), a non-member
 * cannot write at all, and a ref matching a protected pattern is a maintainer's.
 */
export function refWriteBlock(role: Role | null, refName: string, patterns: readonly string[], what: string): string | null {
  if (role === null) return `Only ${whoCan('canPush')} can ${what}.`
  const limit = roleLimit(role, 'canPush', what)
  if (limit !== null) return limit
  if (!capabilitiesOf(role).canPush) return `Only ${whoCan('canPush')} can ${what}.`
  const pattern = protectedBy(refName, patterns)
  if (pattern !== null && role !== 'maintainer') return `${shortRef(refName)} matches the protected pattern ${pattern}: only maintainers can ${what}.`
  return null
}

/** `refs/heads/x` → `x`, `refs/tags/v1` → `v1`. */
export function shortRef(refName: string): string {
  if (refName.startsWith(BRANCH_PREFIX)) return refName.slice(BRANCH_PREFIX.length)
  if (refName.startsWith(TAG_PREFIX)) return refName.slice(TAG_PREFIX.length)
  return refName
}

/**
 * Why the branch `refName` cannot be deleted from the branches page, or null (GitHub's rules,
 * then the role's): not the default branch (change the default first), not a protected branch
 * (unprotect it first, so a maintainer's misclick cannot remove it), not a diverged one (no
 * single tip to delete from: git settles it), and only by a maintainer or writer.
 */
export function deleteBranchBlock(i: {
  readonly refName: string
  readonly defaultBranch: string
  readonly patterns: readonly string[]
  readonly role: Role | null
  readonly state: RefState['state']
}): string | null {
  const name = shortRef(i.refName)
  if (i.refName === `${BRANCH_PREFIX}${i.defaultBranch}`) return `${name} is the default branch: choose another default in Settings before deleting it.`
  const pattern = protectedBy(i.refName, i.patterns)
  if (pattern !== null) return `${name} is protected (${pattern}): protected branches can't be deleted. A maintainer can remove the protection in Settings first.`
  if (i.state === 'diverged') return `${name} has diverged heads: delete it with git (git push <remote> :${name}).`
  return refWriteBlock(i.role, i.refName, [], 'delete branches')
}

/** A ref as the chain holds it now, with the protected patterns in force. */
export interface RefNow {
  /** null: never written. */
  readonly state: RefState | null
  readonly patterns: readonly string[]
}

/**
 * The ref's state as the chain holds it now (null: never written), and the repo's protected
 * patterns now: read fresh before every write here, as the page's list and config may be minutes
 * old (a private repo's refs too, past its session's copy). One config read serves both.
 */
export async function readRefNow(sdk: EvoSDK, repo: RepoRef, refName: string): Promise<RefNow> {
  const bundle = await readConfigBundle(sdk, repo)
  const ref = await resolveRefByHash(sdk, repo, bytesToBase64(refNameHash(refName)), bundle.history, undefined, { fresh: true })
  return { state: ref?.state ?? null, patterns: bundle.config?.protectedPatterns ?? [] }
}

const tipOf = (s: RefState | null): string | null => (s === null ? null : refTip({ state: s }))

/**
 * The write options for a ref update routed by `patterns` just read: a public repo's are passed
 * on (no second config read); a private repo's writer routes by its own sealed config.
 */
function routed(repo: RepoRef, patterns: readonly string[], intent: string | undefined): { intent?: string; protectedPatterns?: readonly string[] } {
  return { ...(intent !== undefined ? { intent } : {}), ...(repo.visibility === 'private' ? {} : { protectedPatterns: patterns }) }
}

/**
 * Create `refs/heads/<name>` at `target` (a commit the repo stores), as a signer of `role`, refused
 * (before signing) when the role cannot write it under the patterns in force now, or when the
 * branch exists now. `restoring`: a branch this page deleted from that tip: a node a block behind
 * may still show it there, which is no refusal (writing the same tip again is harmless).
 */
export async function createBranch(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { readonly name: string; readonly target: string; readonly role: Role | null; readonly intent?: string; readonly restoring?: boolean },
): Promise<void> {
  const problem = branchNameProblem(input.name)
  if (problem !== null) throw new Error(problem)
  const refName = `${BRANCH_PREFIX}${input.name}`
  const now = await readRefNow(sdk, repo, refName)
  const block = refWriteBlock(input.role, refName, now.patterns, 'create this branch')
  if (block !== null) throw new Error(block)
  const tip = tipOf(now.state)
  const sameTip = input.restoring === true && tip !== null && tip.toLowerCase() === input.target.toLowerCase()
  if (tip !== null && !sameTip) throw new Error(`a branch named ${input.name} already exists (at ${tip.slice(0, 7)})`)
  await writeRefUpdate(sdk, auth, repo, { refName, newOid: input.target }, routed(repo, now.patterns, input.intent))
}

/**
 * Delete the branch `refName` from the tip the page showed: a ref update to the null oid naming
 * that tip. Refused when the branch moved since (its new commits would be dropped unseen) or is
 * already gone.
 */
export async function deleteBranch(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { readonly refName: string; readonly tip: string; readonly defaultBranch: string; readonly role: Role | null; readonly intent?: string },
): Promise<void> {
  const { state, patterns } = await readRefNow(sdk, repo, input.refName)
  const name = shortRef(input.refName)
  if (state === null || state.state === 'unborn') throw new Error(`${name} is already deleted`)
  // The rules again, against the patterns in force now (a protection added since the page loaded).
  const block = deleteBranchBlock({ refName: input.refName, defaultBranch: input.defaultBranch, patterns, role: input.role, state: state.state })
  if (block !== null) throw new Error(block)
  if (state.state !== 'resolved') throw new Error(`${name} has diverged heads: delete it with git`)
  if (state.oid.toLowerCase() !== input.tip.toLowerCase()) throw new Error(`${name} moved to ${state.oid.slice(0, 7)} since this page read it; reload and check before deleting it`)
  await writeRefUpdate(sdk, auth, repo, { refName: input.refName, newOid: '0'.repeat(input.tip.length), prevOid: input.tip }, routed(repo, patterns, input.intent))
}

/**
 * Make sure the tag `tag` exists at `target`: nothing is written when it already points there (a
 * retry, or a tag pushed meanwhile at the same commit), and creating it is refused when it points
 * anywhere else. Returns whether a ref update was written.
 */
export async function ensureTag(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { readonly tag: string; readonly target: string; readonly intent?: string },
): Promise<boolean> {
  const problem = newTagNameProblem(input.tag)
  if (problem !== null) throw new Error(problem)
  const refName = `${TAG_PREFIX}${input.tag}`
  const { state, patterns } = await readRefNow(sdk, repo, refName)
  const now = tipOf(state)
  if (now !== null) {
    if (now.toLowerCase() === input.target.toLowerCase()) return false
    throw new Error(`the tag ${input.tag} already exists at ${now.slice(0, 7)}: pick it as an existing tag, or choose another name`)
  }
  await writeRefUpdate(sdk, auth, repo, { refName, newOid: input.target }, routed(repo, patterns, input.intent))
  return true
}
