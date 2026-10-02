/**
 * An identity's public profile: forge-community `profile` (`forge-v2.md` §2), one per identity
 * (unique `$ownerId`), mutable and deletable. What a profile may hold, and how an edit is
 * normalized, is the shared rule in `lib/rules/profile.ts` (Rust: `forge_core::rules::profile`).
 *
 * A profile is public by design: it is never sealed, whatever repositories it is shown beside.
 * Parity: `forge_core::profile` (`dg profile show/set/delete`).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { ForgeIds } from '../deployments'
import {
  createDocumentIdempotent,
  deleteDocumentIdempotent,
  previewCreate,
  previewDelete,
  previewReplace,
  queryDocuments,
  replaceDocumentIdempotent,
  type CostPreview,
  type PlainDocument,
  type WriteAuth,
} from '../sdk'
import { sameValue } from '../sdk/write'
import { checkProfile, PROFILE_FIELDS, profileProblems, type ProfileField, type ProfileFields, type ProfileInput } from '../rules/profile'
import { DOC, str, stringArray } from './contract'
import { revisionOf } from './issues'

/** A stored profile. */
export interface Profile {
  /** The document id. */
  readonly id: string
  /** The identity it describes (its `$ownerId`). */
  readonly owner: string
  /** `$revision` (an edit names it, so one made elsewhere since is refused, not overwritten). */
  readonly revision: number
  /** The edited fields, as stored. */
  readonly fields: ProfileFields
  /** Signing keys (`gpg:…` / `ssh-…`), for signed-commit badges. */
  readonly pubkeys: readonly string[]
}

/** A `profile` document, flattened. */
export function profileFromDoc(doc: PlainDocument): Profile {
  const fields: ProfileFields = {}
  for (const f of PROFILE_FIELDS) {
    if (f === 'links') {
      const links = stringArray(doc, 'links') ?? []
      if (links.length > 0) fields.links = links
    } else {
      const v = str(doc, f)
      if (v !== '') fields[f] = v
    }
  }
  return {
    id: str(doc, '$id'),
    owner: str(doc, '$ownerId'),
    revision: revisionOf(doc),
    fields,
    pubkeys: stringArray(doc, 'pubkeys') ?? [],
  }
}

/** The profile of `identityId`, or null when it has none (proof-checked either way). */
export async function readProfile(sdk: EvoSDK, forge: ForgeIds, identityId: string): Promise<Profile | null> {
  const docs = await queryDocuments(sdk, {
    dataContractId: forge.community,
    documentTypeName: DOC.profile,
    where: [['$ownerId', '==', identityId]],
    limit: 1,
  })
  return docs[0] === undefined ? null : profileFromDoc(docs[0])
}

/** The document data of `fields` (what a create stores; links as a typed string array). */
function profileData(fields: ProfileFields): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const f of PROFILE_FIELDS) {
    const v = fields[f]
    if (v !== undefined) data[f] = Array.isArray(v) ? [...v] : v
  }
  return data
}

/** The replace changes from `stored` to `next`: every edited field, an unset one removed. */
export function profileChanges(stored: ProfileFields, next: ProfileFields): Record<string, unknown> {
  const changes: Record<string, unknown> = {}
  for (const f of PROFILE_FIELDS) {
    const b = next[f]
    if (!sameValue(stored[f], b)) changes[f] = Array.isArray(b) ? [...b] : b
  }
  return changes
}

/** Whether two profiles hold the same edited fields. */
export function sameProfile(a: ProfileFields, b: ProfileFields): boolean {
  return Object.keys(profileChanges(a, b)).length === 0
}

/** Refused before anything is signed: the fields that break the shared rule, each with why. */
export class ProfileInputError extends Error {
  constructor(readonly problems: Partial<Record<ProfileField, string>>) {
    super(
      Object.entries(problems)
        .map(([f, why]) => `${f} ${why}`)
        .join('; '),
    )
    this.name = 'ProfileInputError'
  }
}

/** `input` normalized by the shared rule, or {@link ProfileInputError}. */
export function normalizeProfile(input: ProfileInput): ProfileFields {
  const check = checkProfile(input)
  if (!check.valid || check.normalized === null) throw new ProfileInputError(profileProblems(input))
  return check.normalized
}

/**
 * What saving `next` costs: a create when the identity has no profile, else a replace of the
 * changed fields (null when nothing changed). `first`: whether this may be the identity's first
 * forge-community write (its identity-contract nonce is then stored too).
 */
export function profileCost(stored: Profile | null, next: ProfileFields, first?: boolean): CostPreview | null {
  if (stored === null) return previewCreate(DOC.profile, profileData(next), first === undefined ? {} : { contract: first })
  const changes = profileChanges(stored.fields, next)
  return Object.keys(changes).length === 0 ? null : previewReplace(DOC.profile, changes)
}

/** What deleting a profile refunds at least. */
export function profileDeleteRefund(): CostPreview {
  return previewDelete(DOC.profile)
}

/**
 * Save the signer's profile as `next` (already normalized, {@link normalizeProfile}): create it
 * when `stored` is null, else replace the edited fields (`pubkeys` is kept) against the revision
 * read. Signs nothing when the stored profile already holds `next`.
 */
export async function saveProfile(
  sdk: EvoSDK,
  auth: WriteAuth,
  forge: ForgeIds,
  stored: Profile | null,
  next: ProfileFields,
  intent?: string,
): Promise<void> {
  if (stored === null) {
    await createDocumentIdempotent(sdk, auth, {
      contractId: forge.community,
      documentType: DOC.profile,
      data: profileData(next),
      ...(intent ? { intent } : {}),
    })
    return
  }
  const changes = profileChanges(stored.fields, next)
  if (Object.keys(changes).length === 0) return
  await replaceDocumentIdempotent(sdk, auth, {
    contractId: forge.community,
    documentType: DOC.profile,
    documentId: stored.id,
    changes,
    expectedRevision: BigInt(stored.revision),
  })
}

/** Delete the signer's profile (refunds part of its storage fee). */
export async function deleteProfile(sdk: EvoSDK, auth: WriteAuth, forge: ForgeIds, stored: Profile): Promise<void> {
  await deleteDocumentIdempotent(sdk, auth, { contractId: forge.community, documentType: DOC.profile, documentId: stored.id })
}
