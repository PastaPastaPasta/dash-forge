/**
 * Writing long bodies (`docs/contracts/forge-v2.md` §6.3): a body, comment or release notes
 * longer than its field is stored as a kind-6 artifact (sealed in a private repo) on Platform,
 * and the field keeps its first part and the trailer naming it. Storing an artifact is a
 * `packManifest` write, which consensus admits from a maintainer or a role-1 writer only: anyone
 * else is refused before anything is stored. Parity: forge-core `Collab::store_long_body`. The
 * rule is `lib/rules/long-body.ts`; reading is `lib/view/long-body.ts`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { PACK_KIND } from '../constants'
import { sealedLength } from '../private/pack'
import { LONG_BODY_MAX_BYTES, longBodyStoredText, needsLongBodyArtifact, utf8Bytes } from '../rules/long-body'
import type { WriteAuth } from '../sdk'
import { estimateChunkCredits } from '../sdk/cost'
import { BODY_LIMIT } from '../view/text-limits'
import { storeArtifact } from '../storage/upload'
import { writePackManifest } from './push'
import type { RepoRef } from './contract'
import { SEALED_TEXT_LIMIT, sealArtifact, sealedTextUse, type SealedKind } from './private-writes'
import { readRoleOracle } from './members'
import { capabilitiesOf } from '../rules/roles'
import type { Role } from '../rules/v2'

/** A `body` or `notes` field's own cap (5,120 characters and bytes). */
export const FIELD_MAX = BODY_LIMIT.bytes

/** Any artifact hash: a trailer is as long whatever its hash, which is all an estimate needs. */
export const ANY_HASH = '0'.repeat(64)

/** The fields a long body may be written to. */
export type LongBodyKind = SealedKind | 'release'

/**
 * How many UTF-8 bytes of text the field holds in `repo`, beside `others` (the document's other
 * text: a title, branch names, a path): 5,120 in a public repo and for release notes; in a private
 * one, what the sealed text limit leaves (`SEALED_TEXT_LIMIT`, which counts every record's
 * framing, so it is at most a few bytes under what the sealer takes).
 */
export function bodyRoom(repo: RepoRef, kind: LongBodyKind, others: Readonly<Record<string, unknown>> = {}): number {
  if (repo.visibility !== 'private' || kind === 'release') return FIELD_MAX
  const rest = Object.fromEntries(Object.entries(others).filter(([k]) => k !== 'body'))
  return Math.min(FIELD_MAX, Math.max(0, SEALED_TEXT_LIMIT[kind] - sealedTextUse(kind, rest).used))
}

/**
 * What storing a long body's artifact costs beyond its document, as the CLI quotes it (forge-core
 * `cost::push_fees::long_body`): the manifest priced as the repo's first of its kind (112M + 40M),
 * and the text's bytes (sealed, in a private repo) as Platform chunks. An upper bound.
 */
export const LONG_BODY_MANIFEST_CREDITS = 152_000_000

/** {@link LONG_BODY_MANIFEST_CREDITS} and the chunks of `bytes` of text in `repo`. */
export function longBodyCredits(repo: RepoRef, bytes: number): number {
  const stored = repo.visibility === 'private' ? sealedLength(bytes, 14) : bytes
  return LONG_BODY_MANIFEST_CREDITS + estimateChunkCredits(stored)
}

/** Whether `full` written into a `kind` field of `repo` beside `others` needs a long body's artifact. */
export function isLongBody(repo: RepoRef, kind: LongBodyKind, full: string, others: Readonly<Record<string, unknown>> = {}): boolean {
  return needsLongBodyArtifact(full, bodyRoom(repo, kind, others))
}

/** Whether a member of `role` may store long bodies: a maintainer or a role-1 writer (`canPush`). */
export function mayStoreLongBodies(role: Role | null | undefined): boolean {
  return capabilitiesOf(role).canPush
}

/**
 * The field `full` would be written as, for a cost estimate before anything is stored: itself, or
 * its first part and a trailer (of the same length whatever the artifact's hash).
 */
export function fieldEstimate(repo: RepoRef, kind: LongBodyKind, full: string, others: Readonly<Record<string, unknown>> = {}): string {
  const room = bodyRoom(repo, kind, others)
  if (!needsLongBodyArtifact(full, room)) return full
  return longBodyStoredText(full, room, ANY_HASH) ?? full
}

/** "the text is too long: …holds at most N bytes (this one has M)", the field's own limit. */
function tooLongFor(repo: RepoRef, kind: LongBodyKind, full: string, others: Readonly<Record<string, unknown>>): string {
  if (repo.visibility === 'private' && kind !== 'release') {
    // a private document's text is sealed together: its combined limit
    const used = sealedTextUse(kind, { ...others, body: full }).used
    return `the text is too long for a private repo: an encrypted ${kind} holds at most ${SEALED_TEXT_LIMIT[kind]} bytes of text (this one has ${used})`
  }
  return `the text is too long: the field holds at most ${FIELD_MAX} bytes (this one has ${utf8Bytes(full)})`
}

/** A text over {@link LONG_BODY_MAX_BYTES} (or one the signer may not store): nothing was written. */
export class LongBodyRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LongBodyRefusedError'
  }
}

/**
 * The text to write into a `kind` field of `repo` for `full`: `full` itself when it fits; else,
 * after storing the full text as a kind-6 artifact on Platform (sealed in a private repo), its
 * first part and the trailer naming it. A retry stores nothing twice: a public text is
 * content-addressed, a private one's sealed bytes are kept in this browser until recorded
 * (`sealArtifact`), and chunks and a manifest already on chain are reused.
 */
export async function longBodyField(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  kind: LongBodyKind,
  full: string,
  others: Readonly<Record<string, unknown>> = {},
  intent?: string,
): Promise<string> {
  const room = bodyRoom(repo, kind, others)
  if (!needsLongBodyArtifact(full, room)) return full
  const bytes = utf8Bytes(full)
  if (bytes > LONG_BODY_MAX_BYTES) {
    throw new LongBodyRefusedError(`the text is ${bytes} bytes, and Dash Forge stores at most ${LONG_BODY_MAX_BYTES} bytes of one text`)
  }
  // Refused before anything is stored when the signer may not record artifacts (consensus admits
  // a `packManifest` from a maintainer or a role-1 writer only).
  if (!mayStoreLongBodies((await readRoleOracle(sdk, repo, auth.network)).currentRole(auth.identityId))) {
    throw new LongBodyRefusedError(`${tooLongFor(repo, kind, full, others)}. A longer text is stored as a repository artifact, which only the repo's maintainers and writers may record: shorten it, or split it into comments`)
  }
  // The field must hold the trailer (its length does not depend on the hash): checked before
  // anything is paid for.
  if (longBodyStoredText(full, room, ANY_HASH) === null) {
    throw new LongBodyRefusedError(`the rest of this ${kind}'s text leaves ${room} bytes, too few for the line naming the full text: shorten the title or the text`)
  }
  // A private repo's text is sealed under the write key. Its sealed bytes stay kept in this
  // browser (`sealArtifact`, pruned after a week) rather than being forgotten once recorded, as a
  // pack's are: a retry of a document write that failed after this then names the same artifact
  // instead of sealing, storing and paying for another.
  const sealed = await sealArtifact(sdk, auth, repo, new TextEncoder().encode(full))
  // Platform: every reader can fetch it; the composer quoted its cost with the write's.
  const stored = await storeArtifact(sdk, auth, repo, sealed, { policy: null, profiles: [], confirmPlatform: async () => true })
  const { packHash, sizeBytes, chunkCount, storage, uris } = stored
  await writePackManifest(
    sdk,
    auth,
    repo,
    { kind: PACK_KIND.LONG_BODY, objectCount: 0, packHash, sizeBytes, chunkCount, storage, uris },
    intent ? `${intent}:long-body:${packHash}` : undefined,
  )
  const field = longBodyStoredText(full, room, packHash)
  if (field === null) throw new LongBodyRefusedError(`a field of ${room} bytes cannot hold the line naming the full text`)
  return field
}
