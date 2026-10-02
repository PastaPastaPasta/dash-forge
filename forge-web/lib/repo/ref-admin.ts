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
import { readConfigHistory } from './config'
import type { RepoRef } from './contract'
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

/**
 * The ref's state as the chain holds it now (null: never written). Read fresh before every write
 * here: the page's list may be minutes old. A private repo reads through its member session.
 */
export async function readRefNow(sdk: EvoSDK, repo: RepoRef, refName: string): Promise<RefState | null> {
  const ref = await resolveRefByHash(sdk, repo, bytesToBase64(refNameHash(refName)), await readConfigHistory(sdk, repo))
  return ref?.state ?? null
}

const tipOf = (s: RefState | null): string | null => (s?.state === 'resolved' ? s.oid : s?.state === 'diverged' ? (s.heads[0]?.oid ?? null) : null)

/** Create `refs/heads/<name>` at `target` (a commit the repo stores). Refused when it exists now. */
export async function createBranch(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { readonly name: string; readonly target: string; readonly intent?: string },
): Promise<void> {
  const problem = branchNameProblem(input.name)
  if (problem !== null) throw new Error(problem)
  const refName = `${BRANCH_PREFIX}${input.name}`
  const now = tipOf(await readRefNow(sdk, repo, refName))
  if (now !== null) throw new Error(`a branch named ${input.name} already exists (at ${now.slice(0, 7)})`)
  await writeRefUpdate(sdk, auth, repo, { refName, newOid: input.target }, input.intent !== undefined ? { intent: input.intent } : {})
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
  input: { readonly refName: string; readonly tip: string; readonly intent?: string },
): Promise<void> {
  const now = await readRefNow(sdk, repo, input.refName)
  const name = shortRef(input.refName)
  if (now === null || now.state === 'unborn') throw new Error(`${name} is already deleted`)
  if (now.state === 'diverged') throw new Error(`${name} has diverged heads: delete it with git`)
  if (now.oid.toLowerCase() !== input.tip.toLowerCase()) throw new Error(`${name} moved to ${now.oid.slice(0, 7)} since this page read it; reload and check before deleting it`)
  await writeRefUpdate(
    sdk,
    auth,
    repo,
    { refName: input.refName, newOid: '0'.repeat(input.tip.length), prevOid: input.tip },
    input.intent !== undefined ? { intent: input.intent } : {},
  )
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
  const now = tipOf(await readRefNow(sdk, repo, refName))
  if (now !== null) {
    if (now.toLowerCase() === input.target.toLowerCase()) return false
    throw new Error(`the tag ${input.tag} already exists at ${now.slice(0, 7)}: pick it as an existing tag, or choose another name`)
  }
  await writeRefUpdate(sdk, auth, repo, { refName, newOid: input.target }, input.intent !== undefined ? { intent: input.intent } : {})
  return true
}
