/**
 * The mainnet fields a write carries where the registered contract declares them (mixed-visibility
 * DESIGN §4.11, §8.3; phase M-B part 2; the rules are `lib/rules/aud.ts`): `aud` and `mRole` on an
 * issue, PR, comment or review, on its create and restated on every replace; and the shape a pack
 * manifest's `r` or a type's `vis` takes. Feature detection, as `repoKey.mr` is read
 * (`private-members.ts`): sakura's three-contract set declares none of them, so nothing changes
 * there and no extra read is made. Parity: forge-core `Collab::content_fields` /
 * `restate_content_fields`, `RepoService::write_pack_manifest`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { contentFields, type AudShape } from '../rules/aud'
import type { Role } from '../rules/v2'
import type { PlainDocument, WriteAuth } from '../sdk'
import { DOC, asIdentifierString, type RepoRef } from './contract'
import { contractHasProperty, contractPropertyMinimum } from './contract-shape'
import { readRoleOracle } from './members'
import { bytesField } from './private-content'
import { contractOf } from './source'

/** `aud` (L1): 1 members-only, 2 a message to specific people; absent on public content. */
export const AUD = 'aud'
/** `mRole` (L2): the `writer` row role `asMember` proves. */
export const MEMBER_ROLE = 'mRole'
/** `tAud` on an `event` or `authorEvent` (M3, M4): its target's `aud`. */
export const EVENT_TARGET_AUD = 'tAud'

/** The types that carry `aud` and `mRole`. */
const CONTENT_TYPES: ReadonlySet<string> = new Set([DOC.issue, DOC.patch, DOC.comment, DOC.review])

/** Whether `documentType` of `repo`'s contract declares `property`. */
export function declares(sdk: EvoSDK, repo: RepoRef, documentType: string, property: string): Promise<boolean> {
  return contractHasProperty(sdk, contractOf(repo.forge, documentType), documentType, property)
}

/** What `documentType`'s contract declares of `aud` and `mRole` (both false for any other type). */
export async function contentShape(sdk: EvoSDK, repo: RepoRef, documentType: string): Promise<AudShape> {
  if (!CONTENT_TYPES.has(documentType)) return {}
  const [aud, mRole] = await Promise.all([declares(sdk, repo, documentType, AUD), declares(sdk, repo, documentType, MEMBER_ROLE)])
  return { aud, mRole }
}

/** The version byte of a stored or written `enc` (raw bytes or base64), or null without one. */
function encVersion(v: unknown): number | null {
  const enc = bytesField({ enc: v }, 'enc')
  return enc !== undefined && enc.length > 0 ? (enc[0] as number) : null
}

/** Whether a document's `asMember` is set (an identifier, as bytes or base58). */
function carriesProof(v: unknown): boolean {
  return v instanceof Uint8Array ? v.length > 0 : asIdentifierString(v) !== ''
}

/**
 * The `aud` and `mRole` of a `documentType` document of `repo` as it will be stored (`doc`), signed
 * by `auth`: `aud` from its `enc`, `mRole` the signer's current role whenever it carries
 * `asMember` (the repo's membership, as `wrapRoleCode` reads it). Null where the contract declares
 * neither. Throws before signing for an `enc` no content document carries.
 */
async function fieldsOf(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, documentType: string, shape: AudShape, doc: Readonly<Record<string, unknown>>): Promise<{ aud: number | null; mRole: number | null }> {
  const asMember = carriesProof(doc['asMember'])
  const role: Role | null = asMember && shape.mRole === true ? (await readRoleOracle(sdk, repo, auth.network)).currentRole(auth.identityId) : null
  const got = contentFields(shape, encVersion(doc['enc']), asMember, role)
  if ('error' in got) throw new Error(`this ${documentType} was encrypted in a form no post takes; nothing was written`)
  return got
}

/**
 * `data`, a create of `documentType` in `repo` as it is signed (sealed, with its proof), with
 * `aud` and `mRole` set where the contract declares them and left out where they are absent.
 * Unchanged on a contract that declares neither (sakura).
 */
export async function withContentFields(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, documentType: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const shape = await contentShape(sdk, repo, documentType)
  if (shape.aud !== true && shape.mRole !== true) return data
  const f = await fieldsOf(sdk, auth, repo, documentType, shape, data)
  const out: Record<string, unknown> = { ...data }
  delete out[AUD]
  delete out[MEMBER_ROLE]
  if (f.aud !== null) out[AUD] = f.aud
  if (f.mRole !== null) out[MEMBER_ROLE] = f.mRole
  return out
}

/**
 * `changes`, a replace of `repo`'s `documentType` document, with `aud` and `mRole` restated where
 * the contract declares them (set, or `undefined` to remove): from the stored document with
 * `changes` applied, so an edit that drops `enc` drops `aud`, and a member restates the role it
 * holds now. `stored` is read only when `changes` leaves `enc` or `asMember` as stored. Unchanged
 * on a contract that declares neither (sakura), with nothing read.
 */
export async function restateContentFields(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  documentType: string,
  changes: Readonly<Record<string, unknown>>,
  stored: () => Promise<PlainDocument | null>,
): Promise<Record<string, unknown>> {
  const shape = await contentShape(sdk, repo, documentType)
  if (shape.aud !== true && shape.mRole !== true) return { ...changes }
  const before = 'enc' in changes && 'asMember' in changes ? {} : await stored()
  if (before === null) throw new Error(`this ${documentType} was not found; nothing was written`)
  const after: Record<string, unknown> = { ...before }
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) delete after[k]
    else after[k] = v
  }
  const f = await fieldsOf(sdk, auth, repo, documentType, shape, after)
  return {
    ...changes,
    ...(shape.aud === true ? { [AUD]: f.aud ?? undefined } : {}),
    ...(shape.mRole === true ? { [MEMBER_ROLE]: f.mRole ?? undefined } : {}),
  }
}

/** Whether `packManifest.r` admits 0 on `repo`'s forge-core (mainnet C3: the maintainer-only kinds claim it). */
export async function manifestMaintKinds(sdk: EvoSDK, repo: RepoRef): Promise<boolean> {
  return (await contractPropertyMinimum(sdk, contractOf(repo.forge, DOC.packManifest), DOC.packManifest, 'r')) === 0
}

/**
 * `data` without `vis` where `documentType`'s contract no longer declares it (mainnet R-11: a
 * `webhook` or `topic` proves a public repo by its reference alone, and one carrying `vis` is
 * refused). Unchanged where it does (sakura).
 */
export async function withoutUndeclaredVis(sdk: EvoSDK, contractId: string, documentType: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!('vis' in data) || (await contractHasProperty(sdk, contractId, documentType, 'vis'))) return data
  const { vis: _vis, ...rest } = data
  return rest
}
